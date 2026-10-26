"use strict";
// Endpoint (local SENEC OpenAPI):
//   https://{appliance ip}:4424/v1/...
//
// A second local interface on the appliance, independent of lala.cgi on 443. What it serves,
// what it refuses, and why this connector is read-only are written up in
// docs/LOCAL_OPENAPI_4424.md. Read that before extending this module — in particular before
// adding anything that writes.

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const axios = require("axios");
const https = require("node:https");
const crypto = require("node:crypto");
const { OPENAPI_PFX, OPENAPI_TOKEN_STATE, WEB_HOST } = require("./constants.js");
const { computeBackoffDelay } = require("./auth-helpers.js");
// Only for the portal side of registration — approving and withdrawing this instance's own
// entry. The data path never leaves the LAN.
const webClient = require("./web-client.js");

/** The listener's port. Fixed in the appliance, so it is not a setting. */
const OPENAPI_PORT = 4424;

/** Registration is POST-only and needs no token. Everything else needs one. */
const REGISTER_PATH = "/v1/register";

/**
 * The readable routes, and the state section each one fills.
 *
 * `/v1/bess` is deliberately absent from the default include list rather than from this map:
 * it answers `null` for activePower and reactivePower, and its voltage reads against a
 * different measurement point than the battery's own, so it is opt-in rather than noise in
 * every object tree.
 */
const READ_ROUTES = [
	{ path: "/v1/battery", section: "battery" },
	{ path: "/v1/meter", section: "meter" },
	{ path: "/v1/bess", section: "bess" },
	{ path: "/v1/bess/nameplate", section: "bessNameplate" },
	{ path: "/v1/evse", section: "evse" },
];

/**
 * Sections polled when the user has not chosen otherwise.
 *
 * `bess` is left out because several of its values come back empty, and `evse` because the
 * appliance reports four wallbox slots whether or not anything is attached to them — so
 * including it by default gives every owner four empty channels and one extra request per
 * cycle. Must stay in step with the defaults in io-package.json and admin/jsonConfig.json.
 */
const DEFAULT_INCLUDE = "battery,meter";

/** The section carrying the appliance's own identity, used to verify the certificate. */
const IDENTITY_SECTION = "bessNameplate";

/** Bounds for openapi_timeout, mirroring the min/max the admin field enforces. */
const OPENAPI_TIMEOUT_MIN_MS = 2000;
const OPENAPI_TIMEOUT_MAX_MS = 60000;
const OPENAPI_TIMEOUT_DEFAULT_MS = 10000;

/** Bounds for openapi_interval, mirroring the min/max the admin field enforces. */
const OPENAPI_INTERVAL_MIN_S = 10;
const OPENAPI_INTERVAL_MAX_S = 86400;
const OPENAPI_INTERVAL_DEFAULT_S = 60;

/**
 * How long to wait for the appliance to pick up an approval the portal has accepted.
 *
 * The grant travels through the cloud rather than being applied locally. No grant latency has
 * ever been measured: the half-minute recorded in docs/LOCAL_OPENAPI_4424.md is a *revocation*
 * measurement and the grant figure is inferred from it. These two are therefore that inference
 * with real headroom, because giving up early is not free — it logs a warning that reads like a
 * failure and spends one of the bounded approval rounds on an approval that was working.
 */
const APPROVAL_CONFIRM_ATTEMPTS = 14;
const APPROVAL_CONFIRM_WAIT_MS = 5000;

/** How many poll cycles may each attempt an automatic approval before leaving it to the user. */
const APPROVAL_MAX_ROUNDS = 3;

/** How soon to read again once an approval has just been confirmed. */
const APPROVED_REPOLL_MS = 1000;

/** How long to wait before confirming a 401, so a propagation lag is not read as a revocation. */
const REJECTION_CONFIRM_WAIT_MS = 3000;

/** Bounds for the transport-failure backoff, so a long outage settles at a sane retry rate. */
const OPENAPI_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * Floor for a backed-off retry.
 *
 * `computeBackoffDelay` applies full jitter, so without a floor a "backed off" delay can come
 * back at nearly zero — half the time below the configured interval on the first failure. The
 * local connector's retry uses the same floor for the same reason.
 */
const OPENAPI_BACKOFF_MIN_MS = 10 * 1000;

/** Upper bound on the plant walk, so a portal-supplied count cannot drive an unbounded loop. */
const MAX_PLANTS_WALKED = 20;

/** Largest response this connector will buffer, matching the bound the cloud clients use. */
const OPENAPI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * What the appliance answers, and what each answer means.
 *
 * Measured against a V3; see docs/LOCAL_OPENAPI_4424.md. The important and slightly awkward
 * part is that `401` covers three different situations that cannot be told apart from
 * outside: no token, a token the appliance never issued, and a token the account holder has
 * revoked in the portal. All three are reported the same way — "this token is not accepted,
 * register again" — because guessing between them would either hide a revocation or mint a
 * fresh portal entry every poll.
 */
const STATUS_OK = 200;
const STATUS_UNKNOWN_TOKEN = 401;
const STATUS_ACTIVATION_PENDING = 511;

/**
 * Resolve the request timeout.
 *
 * An instance created before this setting existed has no value at all, so the default has to
 * survive undefined, null and empty string. Anything outside the range the admin field allows
 * is pulled back into it: a zero would disable the timeout and hang the poll cycle.
 *
 * @param {unknown} value - Configured value, if any
 * @returns {number} Timeout in milliseconds
 */
function resolveOpenapiTimeout(value) {
	const requested = Number(value);
	if (!isFinite(requested) || requested <= 0) {
		return OPENAPI_TIMEOUT_DEFAULT_MS;
	}
	return Math.min(Math.max(requested, OPENAPI_TIMEOUT_MIN_MS), OPENAPI_TIMEOUT_MAX_MS);
}

/**
 * Resolve the poll interval.
 *
 * Clamped the same way as the timeout, and for the same reason: a value that never passed
 * through the Admin field — written by a script, a restored backup or a hand edit — would
 * otherwise be used verbatim. Above 2^31-1 ms a timer silently fires immediately, which would
 * poll the appliance in a tight loop.
 *
 * @param {unknown} value - Configured value, if any
 * @returns {number} Interval in milliseconds
 */
function resolveOpenapiInterval(value) {
	const requested = Number(value);
	if (!isFinite(requested) || requested <= 0) {
		return OPENAPI_INTERVAL_DEFAULT_S * 1000;
	}
	return Math.min(Math.max(requested, OPENAPI_INTERVAL_MIN_S), OPENAPI_INTERVAL_MAX_S) * 1000;
}

/**
 * Run one registration-changing operation, or refuse because another is already running.
 *
 * Every path that can create a portal entry goes through here: the startup registration, the
 * Register button and the discard-and-start-over the Forget button performs. Each entry is
 * indistinguishable from another of the same name once it exists, so two of them overlapping is
 * not a performance question but a permanent mess. The flag is taken synchronously, before the
 * first await, because a check in one tick and a set in the next is no guard at all.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {() => Promise<unknown>} work - The operation to run while holding the lock
 * @returns {Promise<{ok: boolean, value?: unknown}>} `ok: false` when another operation holds it
 */
async function withOpenapiRegistration(adapter, work) {
	if (adapter.openapiBusy) {
		return { ok: false };
	}
	adapter.openapiBusy = true;
	try {
		return { ok: true, value: await work() };
	} finally {
		adapter.openapiBusy = false;
	}
}

/**
 * Build the list of sections actually polled.
 *
 * Accepts both an array, which is what the multi-select in Admin stores, and a comma-separated
 * string, which is what an instance configured by hand or by an older version may hold. An
 * unknown name is dropped rather than honoured: unlike SENEC.Connect, where the section list
 * is one query parameter the server interprets, every section here is a route of its own, so a
 * name that matches nothing would otherwise silently poll one section fewer than asked for.
 *
 * @param {string | string[] | null | undefined} configured - Value of openapi_include
 * @returns {string[]} Section names, in the order the routes are declared
 */
function buildOpenapiInclude(configured) {
	const raw = Array.isArray(configured) ? configured : [String(configured || DEFAULT_INCLUDE)];
	// Split on commas whichever shape it arrived in. An array whose single element is the whole
	// comma-joined list is a real stored value, not a hypothetical: the multi-select seeds itself
	// from the field's default, so a default written as a string became ["a,b,c"] — which matches
	// no section at all and would quietly poll nothing but the nameplate.
	const wanted = new Set(
		raw
			.flatMap((section) => String(section).split(","))
			.map((section) => section.trim())
			.filter(Boolean),
	);
	// The identity section is always polled: it is the fallback for naming the appliance when its
	// certificate's common name cannot be parsed, and without an identity the plant cannot be
	// matched and the registration cannot be approved. One extra request per cycle against a
	// local device is a fair price — which also means deselecting everything in Admin leaves
	// exactly this one section, rather than nothing at all.
	wanted.add(IDENTITY_SECTION);
	// Declaration order rather than the user's order, so the log reads the same every cycle.
	return READ_ROUTES.filter((route) => wanted.has(route.section)).map((route) => route.section);
}

/**
 * The appliance identity a certificate subject should carry.
 *
 * `FACTORY.DEVICE_ID` arrives from lala.cgi as `st_2097…`, while the certificate names the
 * same appliance `S2097…`. Normalising both ends to the bare digits avoids encoding that
 * difference in two places.
 *
 * @param {unknown} raw - A device id or certificate common name
 * @returns {string | null} The bare identifier, or null when nothing usable remains
 */
function identityDigits(raw) {
	if (typeof raw !== "string" && typeof raw !== "number") {
		return null;
	}
	// Both prefixes case-insensitively: the lala.cgi spelling is "st_2097…" and the certificate
	// spells the same appliance "S2097…". Matching one case-insensitively and the other not
	// meant a lowercase "s2097…" resolved to nothing at all.
	const digits = String(raw).trim().replace(/^st_/i, "").replace(/^s/i, "");
	return /^\d{4,}$/.test(digits) ? digits : null;
}

/**
 * Which plant of the account holds this appliance.
 *
 * An account can hold more than one, and the plant number is not merely cosmetic: it selects
 * which appliance the portal's approve and revoke calls act on. Getting it wrong would act on
 * somebody else's appliance, so `exact` carries whether the number is established or guessed,
 * and the callers that write refuse to act on a guess.
 *
 * The mein-senec.de connector already walks every plant and records the control-unit number of
 * each, which is the same identifier the appliance reports as `FACTORY.DEVICE_ID` and as the
 * serial on its certificate — so when that connector has run, the plant holding *this*
 * appliance can be identified rather than assumed. That matters precisely for the second and
 * later plants, where the master's number would point at the wrong appliance.
 *
 * In order: an explicitly configured plant, then the plant whose control unit is this
 * appliance, then the master when it is the only plant, then the first plant as an admitted
 * guess.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {{plant: number, exact: boolean}} The plant number, and whether it is certain
 */
function openapiResolvePlant(adapter) {
	// An explicit choice wins over anything derived. An account can hold plants the user has no
	// interest in — a replaced appliance usually stays in the list — and deciding for them which
	// one this is would be presumptuous. This is also the only route available to someone who
	// uses no cloud connector at all, since nothing can be enumerated without one.
	const chosen = String(adapter.config.openapi_plant ?? "").trim();
	if (chosen !== "") {
		const asNumber = Number(chosen);
		if (Number.isInteger(asNumber) && asNumber >= 0) {
			return { plant: asNumber, exact: true };
		}
		// Once per value: this runs from the approval URL, which is built on every pending poll,
		// so an unparseable entry would otherwise warn once a minute for as long as it is saved.
		const complaint = `openapi-plant:${chosen}`;
		if (!adapter.loggedConditions?.has(complaint)) {
			adapter.loggedConditions?.add(complaint);
			adapter.log.warn(
				`[OpenAPI] ⚠️ Configured plant "${chosen}" is not a plant number. Falling back to finding it.`,
			);
		}
	}

	const mine = identityDigits(adapter.openapiExpectedDeviceId);
	const master = adapter.webMasterPlantNumber;
	const secondaries = adapter.webSecondaryPlants;
	const plantCount = 1 + (secondaries?.size || 0);

	if (mine) {
		if (identityDigits(adapter.webMasterPlantSerial) === mine && master !== null && master !== undefined) {
			return { plant: master, exact: true };
		}
		for (const [serial, plant] of secondaries?.entries() ?? []) {
			// The map is keyed on the sanitised control-unit number, and identityDigits strips
			// whatever prefix either side spells it with.
			if (identityDigits(serial) === mine) {
				return { plant: plant.anlageNummer, exact: true };
			}
		}
	}

	// A master whose control unit is positively a different appliance is not "certain" just
	// because it is the only plant found: the comparison above already failed on it, and
	// callers that write to the portal short-circuit their own verification on this flag.
	const masterDisagrees =
		mine !== null &&
		identityDigits(adapter.webMasterPlantSerial) !== null &&
		identityDigits(adapter.webMasterPlantSerial) !== mine;
	if (master !== null && master !== undefined) {
		// With a single plant the master is this appliance by definition. With several and no
		// match, saying so would be a guess dressed up as a fact.
		return { plant: master, exact: plantCount === 1 && !masterDisagrees };
	}
	return { plant: 0, exact: false };
}

/**
 * The URL of the approval page for this appliance.
 *
 * The page is not linked from the portal's navigation, so a user who is not handed the URL
 * cannot reach it at all — which makes getting the plant number right part of the feature
 * rather than a nicety. The address is also a fragment, so following it while logged out
 * loses the destination; the Admin text says so.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {{url: string, exact: boolean}} The URL, and whether the plant number is certain
 */
function openapiApprovalUrl(adapter) {
	const { plant, exact } = openapiResolvePlant(adapter);
	return { url: `https://mein-senec.de/endkunde/#/${plant}/senec-open-api`, exact };
}

/**
 * HTTPS agent for the appliance's OpenAPI listener.
 *
 * This listener presents a different chain than lala.cgi does: issued by `openapi` rather
 * than `SenecGui-Root`, so the CA the local connector may have fetched from the portal
 * (`_local.tls.cachedCaPem`) cannot validate it and negotiateLocalTls' result is of no use
 * here. No CA for it is published, so the chain cannot be validated at all.
 *
 * What makes that less bad than it sounds: unlike `senecGuiSelf`, this certificate names the
 * individual appliance in its subject, so it can be pinned to a specific device rather than
 * merely to "something that answered". The checks in openapiVerifyPeer() do that.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {import('node:https').Agent} Agent for this connector's requests
 */
function openapiAgent(adapter) {
	if (!adapter.openapiHttpsAgent) {
		adapter.openapiHttpsAgent = new https.Agent({
			keepAlive: true,
			maxSockets: 4,
			maxFreeSockets: 2,
			timeout: 60000,
			// CodeQL: intentional — no CA for this chain is published, so the identity checks in
			// openapiVerifyPeer() stand in for chain validation. See docs/LOCAL_OPENAPI_4424.md.
			rejectUnauthorized: false,
		});
	}
	return adapter.openapiHttpsAgent;
}

/**
 * Check the certificate the listener presented, and remember it.
 *
 * Three checks, cheapest first. None of them replaces a validated chain; together they
 * establish that the answer came from the appliance we were talking to last time, and — when
 * the local connector has told us the device id — that it is the appliance the user
 * configured rather than another one on the same network.
 *
 * A changed fingerprint is reported and then accepted, matching what the local connector does
 * on 443: a certificate does get replaced, and refusing to talk to the appliance until
 * someone intervenes would be a worse failure than saying so clearly.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {import('node:tls').PeerCertificate | undefined} cert - Certificate as presented
 * @returns {Promise<void>}
 */
async function openapiVerifyPeer(adapter, cert) {
	if (!cert || !cert.raw) {
		return;
	}
	const fingerprint = crypto.createHash("sha256").update(cert.raw).digest("hex");
	const subjectId = identityDigits(cert.subject?.CN);

	// The appliance the user pointed the local connector at. Only available when that connector
	// runs; a mismatch then is worth refusing, because it means 4424 and 443 are two devices.
	const knownId = identityDigits(adapter.openapiExpectedDeviceId);
	if (knownId && subjectId && knownId !== subjectId) {
		adapter.log.error(
			"[OpenAPI] ❌ The certificate on port 4424 names a different appliance than the local " +
				"connector is polling. Refusing to mix two devices in one instance.",
		);
		adapter.openapiIdentityMismatch = true;
		return;
	}
	// Cleared only by a certificate that actually names an appliance and names the right one.
	// Clearing it for a certificate whose common name says nothing would let an unreadable
	// identity rehabilitate a peer that was positively refused — unreachable today, because
	// every caller returns early while the flag stands, but the flag is the whole compensating
	// control for not validating the chain and it should not depend on that staying true.
	if (subjectId) {
		adapter.openapiIdentityMismatch = false;
	}

	// The certificate names the appliance, and it is presented during the TLS handshake — before
	// any token is looked at. That makes it the only way to learn which appliance this is on an
	// instance that polls nothing from lala.cgi and holds no approved token yet, which is
	// precisely the state auto-approval has to work from. Adopted only when nothing better is
	// known, so an identity that came from FACTORY.DEVICE_ID still gets to contradict it above.
	if (!adapter.openapiExpectedDeviceId && subjectId) {
		adapter.openapiExpectedDeviceId = subjectId;
		adapter.log.debug(`[OpenAPI] Appliance identified from its certificate as S${subjectId}.`);
	}

	if (!adapter.openapiFingerprint) {
		adapter.openapiFingerprint = fingerprint;
		await adapter.doState(
			`${OPENAPI_PFX}tls.fingerprint`,
			fingerprint,
			"SHA-256 fingerprint of the OpenAPI certificate",
			"",
			false,
		);
		adapter.log.debug(`[OpenAPI] Pinned certificate ${fingerprint.substring(0, 16)}…`);
	} else if (adapter.openapiFingerprint !== fingerprint) {
		adapter.log.warn(
			"[OpenAPI] ⚠️ The certificate on port 4424 changed. " +
				`Old: ${adapter.openapiFingerprint.substring(0, 16)}… → New: ${fingerprint.substring(0, 16)}…`,
		);
		adapter.openapiFingerprint = fingerprint;
		await adapter.doState(
			`${OPENAPI_PFX}tls.fingerprint`,
			fingerprint,
			"SHA-256 fingerprint of the OpenAPI certificate",
			"",
			false,
		);
	}
}

/**
 * The axios instance for this connector, created once.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {import('axios').AxiosInstance} Client bound to the configured appliance
 */
function openapiClient(adapter) {
	if (!adapter.openapiClient) {
		// The same appliance the local connector polls on 443 — one device, two listeners — so
		// this reads the one configured address rather than asking for it twice. The certificate
		// check additionally refuses to proceed if the two listeners turn out to be two devices.
		const host = adapter.config.senecip;
		adapter.openapiClient = axios.create({
			baseURL: `https://${host}:${OPENAPI_PORT}`,
			timeout: resolveOpenapiTimeout(adapter.config.openapi_timeout),
			httpsAgent: openapiAgent(adapter),
			// Without this, unload cannot cancel a request that is already in flight, and the
			// response lands in the middle of teardown.
			signal: adapter.abortController?.signal,
			// Every state of the token ladder is a status, not an exception. Throwing on 401 and
			// 511 would turn "waiting for the user to approve" into an error with a stack trace.
			validateStatus: () => true,
			// The appliance answers text/plain for errors and for the registration token, so the
			// default JSON-only expectation would mangle both.
			responseType: "text",
			// The peer is not authenticated at request time — it is identified from the
			// certificate once a response exists — so an unbounded body is an unbounded buffer
			// filled by something not yet established to be the appliance. Same bound, and the
			// same reasoning, as the cloud clients.
			maxContentLength: OPENAPI_MAX_RESPONSE_BYTES,
			maxBodyLength: OPENAPI_MAX_RESPONSE_BYTES,
			transitional: { silentJSONParsing: false, forcedJSONParsing: false },
		});
		adapter.applyDefaultHeaders(adapter.openapiClient, adapter.buildUserAgent());
		// The shared helper asks for JSON, which is wrong for this listener: it answers
		// text/plain for errors and for the registration token, and the recorded probes were
		// made with curl sending no Accept at all. Asking for what we actually accept costs
		// nothing and removes the chance of a 406 on the one route that mints the credential.
		delete adapter.openapiClient.defaults.headers.common.Accept;
	}
	return adapter.openapiClient;
}

/**
 * Register this adapter with the appliance and return the token it issues.
 *
 * The token is inert until the account holder approves it in the portal. There is no endpoint
 * that lists registrations, pending or otherwise — every plausible name answers 404 — so the
 * adapter has no way to discover that a registration is already waiting. The only observable
 * is the ladder on a token it already holds.
 *
 * That is why this is never called automatically while a token is stored: each call mints
 * another pending entry in the user's portal, and a poll loop that re-registered on refusal
 * would fill that list with entries nobody can tell apart.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} deviceName - The name the user will see in the portal's approval list
 * @returns {Promise<{ok: boolean, token?: string, error?: string, key?: string, delivered?: boolean, code?: string}>} Outcome. `error`
 * is the English sentence for the log; `key` names a translation in admin/i18n and is present only
 * where the failure is prose rather than something the appliance said in its own words.
 */
async function openapiRegister(adapter, deviceName) {
	const name = String(deviceName || "").trim();
	if (!name) {
		return {
			ok: false,
			error: "A device name is required — it is what you approve in the portal.",
			key: "openapiReplyNameRequired",
		};
	}
	try {
		const response = await openapiClient(adapter).post(
			REGISTER_PATH,
			JSON.stringify({ deviceName: name, manufacturerName: "ioBroker.Senec" }),
			{ headers: { "Content-Type": "application/json; charset=utf-8" } },
		);
		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				error: `The appliance refused the registration (HTTP ${response.status}): ${String(response.data).slice(0, 200)}`,
			};
		}
		const token = String(response.data || "").trim();
		if (!token) {
			return {
				ok: false,
				error: "The appliance accepted the registration but returned no token.",
				key: "openapiReplyNoToken",
			};
		}
		adapter.log.info(
			`[OpenAPI] ✅ Registered as "${name}". It is now waiting for approval in the portal — ` +
				"nothing is read until you approve it.",
		);
		return { ok: true, token };
	} catch (error) {
		// `delivered` distinguishes "the appliance never saw this" from "it may have seen it and
		// we lost the answer". A connection that was refused or never resolved cannot have minted
		// a portal entry; a timeout or an abort mid-flight can. Only the second case warrants
		// telling the user to go and audit their portal.
		const refused = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"];
		return {
			ok: false,
			delivered: !refused.includes(error.code),
			code: error.code || error.name || "failure",
			error: `Could not reach the appliance on port 4424: ${error.message}`,
		};
	}
}

/**
 * Ask the appliance what it makes of the stored token.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<{state: string, status: number | null, message: string}>} Where we stand
 */
async function openapiCheckToken(adapter) {
	// This request carries the token, so it owes the same identity check the poll makes — and
	// it must honour a mismatch another path already found. Without this, the standing check at
	// startup and the Admin button both presented an approved credential to whatever answered
	// on the configured address, including after the certificate had been refused once.
	if (adapter.openapiIdentityMismatch) {
		return {
			state: "error",
			status: null,
			message:
				"The certificate on port 4424 names a different appliance than this instance is " +
				"configured for. Not sending the token until that is resolved.",
		};
	}
	const token = await openapiReadToken(adapter);
	if (!token) {
		return { state: "unregistered", status: null, message: "No token yet — register first." };
	}
	try {
		const response = await openapiClient(adapter).get("/v1/battery", {
			headers: { "X-Auth-Token": token },
		});
		// The certificate is only reachable off the socket of a response, so this is the first
		// chance to check it here too. A mismatch makes the answer meaningless whatever it says.
		if (response.request?.socket) {
			await openapiVerifyPeer(adapter, response.request.socket.getPeerCertificate?.());
			if (adapter.openapiIdentityMismatch) {
				return {
					state: "error",
					status: null,
					message: "The appliance on port 4424 is not the one this instance is configured for.",
				};
			}
		}
		if (response.status === STATUS_OK) {
			return { state: "approved", status: response.status, message: "Approved — the appliance is answering." };
		}
		if (response.status === STATUS_ACTIVATION_PENDING) {
			return {
				state: "pending",
				status: response.status,
				message: "Registered, still waiting for approval in the portal.",
			};
		}
		if (response.status === STATUS_UNKNOWN_TOKEN) {
			// Indistinguishable from a token that never existed, so the message has to cover both.
			return {
				state: "rejected",
				status: response.status,
				message:
					"The appliance does not accept this token. It was either revoked in the portal or " +
					"belongs to another appliance — forget it, then register again.",
			};
		}
		return {
			state: "error",
			status: response.status,
			message: `Unexpected answer HTTP ${response.status}: ${String(response.data).slice(0, 200)}`,
		};
	} catch (error) {
		return { state: "error", status: null, message: `Could not reach the appliance: ${error.message}` };
	}
}

/**
 * Rename the fields whose name is shared with SENEC.Connect but whose meaning is not.
 *
 * state_attr and the translation tables are keyed on the object path, not on which connector
 * produced it, so a field spelled the same in both trees gets the same description, unit and
 * `_Text` table. For most of the shared fields that is exactly right — power, voltage, current
 * and PV production mean the same thing in both and should read the same.
 *
 * For two of them it is wrong, so this connector gives them names of their own:
 *
 * - `state`. SENEC.Connect documents its battery state as 0 = OK, 1 = error. Locally a
 *   perfectly healthy V3 reports 1 while discharging normally, so the local field cannot be
 *   that flag and must not pick up its table.
 * - `consumption`. The SENEC.Connect schema says its house figure excludes the wallbox load.
 *   Nothing establishes that the local meter aggregates the same way, and it additionally
 *   reports surplus fields the cloud does not, so the two are not provably the same figure.
 *
 * @param {string} section - Section name the payload belongs to
 * @param {object} payload - Payload as the appliance returned it
 * @returns {object} Payload with the ambiguous fields renamed
 */
function normalizeOpenapiSection(section, payload) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}
	const renames = Object.hasOwn(SECTION_RENAMES, section) ? SECTION_RENAMES[section] : {};
	const out = {};
	for (const [key, value] of Object.entries(payload)) {
		// A null is the appliance saying "not available", and it must not become a reading.
		// ValueTyping coerces any value carrying a unit through Number(), and Number(null) is 0
		// with isNaN(null) false — so `activePower: null` would publish a confident 0 W,
		// indistinguishable from a measured zero. Leaving the field out means no state is
		// written and the last known value is not overwritten with a fabricated one.
		if (value === null || value === undefined) {
			continue;
		}
		// Recursive, because the nameplate nests: `ratedPower` is an object whose leaves carry
		// units of their own, and dropping only the top level left those publishing zeros.
		out[Object.hasOwn(renames, key) ? renames[key] : key] = dropUnavailable(value);
	}
	return out;
}

/**
 * Strip "not available" leaves from a nested value.
 *
 * Shared by the section normaliser and the wallbox keying, so every path into the object tree
 * drops a null rather than letting it become a zero with a unit attached.
 *
 * @param {unknown} value - Any parsed payload value
 * @returns {unknown} The value with null and undefined leaves removed
 */
function dropUnavailable(value) {
	if (Array.isArray(value)) {
		return value.map(dropUnavailable);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const out = {};
	for (const [key, inner] of Object.entries(value)) {
		if (inner === null || inner === undefined) {
			continue;
		}
		out[key] = dropUnavailable(inner);
	}
	return out;
}

/**
 * Fields renamed on their way into the object tree, by section.
 *
 * A table rather than a conditional, because this is the mapping decision the state metadata
 * and the translation tables are both written against — see the note above `state_attr`'s
 * `battery.operatingState`.
 */
const SECTION_RENAMES = {
	battery: { state: "operatingState" },
	meter: { consumption: "houseConsumption" },
};

/**
 * Turn the wallbox array into something keyed by wallbox id.
 *
 * The appliance reports four slots whether or not anything is attached to them, so the length
 * of the array says nothing about how many wallboxes exist — a tree keyed on the array index
 * would present four wallboxes to every user. Keying on the id each slot reports at least
 * makes the states say which slot they describe, and the four empty ones are then visibly
 * four empty slots rather than four phantom devices.
 *
 * @param {unknown} payload - The `/v1/evse` body
 * @returns {object} Sections keyed by wallbox id
 */
function keyOpenapiWallboxes(payload) {
	const devices = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object" && "devices" in payload
			? payload.devices
			: null;
	if (!Array.isArray(devices)) {
		return {};
	}
	const keyed = {};
	for (const [index, device] of devices.entries()) {
		if (device === null || typeof device !== "object") {
			continue;
		}
		// The id is the appliance's own slot number. Sanitising it is lossy — "WB/01" and
		// "WB.01" both become "WB_01" — so a key already taken gets a suffix rather than
		// silently serving one slot's states from another slot's payload. The positional
		// fallback goes through the same check, because a position can collide with a real id.
		const raw = device.id ?? index;
		let key =
			String(raw)
				.trim()
				.replace(/[^A-Za-z0-9_-]/g, "_") || String(index);
		if (Object.hasOwn(keyed, key)) {
			let suffix = 2;
			while (Object.hasOwn(keyed, `${key}-${suffix}`)) {
				suffix++;
			}
			key = `${key}-${suffix}`;
		}
		// Through the same null filter as every other section: the wallbox slots bypassed the
		// normaliser entirely, so an unattached slot reporting `chargingPower: null` published
		// 0 VA and `evConnected: null` published false.
		keyed[key] = dropUnavailable(device);
	}
	return keyed;
}

/**
 * Delete the wallbox channels the appliance has stopped reporting.
 *
 * A shrunk collection is a real removal: a slot that disappears from `/v1/evse` has no values any
 * more, and leaving its states behind presents the last reading as current — a car still connected,
 * still drawing its last power.
 *
 * `keep` is either the slot keys of a response that parsed, or empty when the section is no longer
 * requested at all and nothing would ever correct those states again. Both callers establish that
 * the appliance was reached, so an absent slot never means "the request failed".
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {Array<string>} keep - Slot keys the appliance reported this cycle
 * @returns {Promise<void>}
 */
async function pruneOpenapiWallboxes(adapter, keep) {
	const prefix = `${adapter.namespace}.${OPENAPI_PFX}evse.`;
	const wanted = new Set(keep.map((key) => `${prefix}${key}`));
	let objects;
	try {
		objects = await adapter.getAdapterObjectsAsync();
	} catch (error) {
		adapter.log.debug(`[OpenAPI] Could not list wallbox objects: ${error.message}`);
		return;
	}
	let removed = 0;
	for (const id of Object.keys(objects)) {
		if (!id.startsWith(prefix)) {
			continue;
		}
		// The slot channel is the first segment after the prefix; both it and the states beneath
		// it go, and a slot that is still reported keeps everything under it.
		const slot = id.slice(prefix.length).split(".")[0];
		if (wanted.has(`${prefix}${slot}`)) {
			continue;
		}
		try {
			await adapter.delObjectAsync(id);
			// doState caches every object it has seen and skips creating one it believes already
			// exists. A slot that disappears and later comes back would otherwise be written
			// without its object — no name, no unit, no role. Same reason webCleanupStates does this.
			adapter.knownObjects.delete(id.slice(adapter.namespace.length + 1));
			removed++;
		} catch {
			// A concurrent delete or a missing object is not a failure worth reporting.
		}
	}
	if (removed > 0) {
		adapter.log.info(`[OpenAPI] Removed ${removed} object(s) for wallbox slots no longer reported`);
	}
}

/**
 * Read the stored token.
 *
 * Kept in an encrypted state rather than in the instance configuration, exactly as the App
 * API keeps its refresh token: the appliance issues this token to the adapter, so it is a
 * runtime secret rather than something the user configures, and keeping it out of the
 * configuration means storing one does not restart the instance.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<string | null>} The token, or null when there is none
 */
async function openapiReadToken(adapter) {
	return (await openapiReadTokenResult(adapter)).token;
}

/**
 * The stored token, with "could not be read" kept distinct from "there is none".
 *
 * Collapsing the two is what makes an unreadable state dangerous: a failed read that answers
 * `null` reads as an unregistered instance, and an unregistered instance registers — minting a
 * second portal entry while the first is still live and holding the token we failed to read.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<{ok: boolean, token: string | null}>} `ok: false` when the read itself failed
 */
async function openapiReadTokenResult(adapter) {
	try {
		const stored = await adapter.getStateAsync(OPENAPI_TOKEN_STATE);
		return { ok: true, token: stored?.val ? adapter.decrypt(String(stored.val)) : null };
	} catch (error) {
		adapter.log.warn(`[OpenAPI] ⚠️ Stored token could not be read: ${error.message}`);
		return { ok: false, token: null };
	}
}

/**
 * Store the token the appliance issued.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} token - Token as issued by the appliance
 * @returns {Promise<void>}
 */
async function openapiStoreToken(adapter, token) {
	// A fresh registration gets a fresh approval budget; the counter is otherwise per-process
	// and a previous registration's exhausted attempts would silently apply to this one. The
	// retry bookkeeping goes with it, so the next failure is reported rather than deduplicated
	// against the run that has just ended.
	adapter.openapiApproveAttempts = 0;
	adapter.openapiTransportFailures = 0;
	for (const seen of [...(adapter.loggedConditions ?? [])]) {
		if (seen.startsWith("openapi-register:")) {
			adapter.loggedConditions?.delete(seen);
		}
	}
	await adapter.doState(
		OPENAPI_TOKEN_STATE,
		adapter.encrypt(token),
		"Encrypted local OpenAPI token (never log or expose!)",
		"",
		false,
		false,
	);
	adapter.log.info("[OpenAPI] Token stored.");
}

/**
 * Forget the stored token so a fresh registration can be made.
 *
 * Clearing our side does **not** withdraw the registration: the entry stays in the portal's
 * list, and only the account holder can remove it there. Saying so is the whole point of
 * having this as its own action — a user who registers twice without revoking the first entry
 * ends up with two identically named entries and no way to tell which one is live.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<"revoked" | "absent" | "unknown" | "none">} What became of the portal entry,
 * or "none" when there was no token to begin with
 */
async function openapiForgetToken(adapter) {
	// Withdraw it in the portal first, while the token is still known. Afterwards there is
	// nothing left to identify the entry by, and an abandoned entry is precisely what makes a
	// later registration ambiguous.
	const token = await openapiReadToken(adapter);
	const withdrawn = token ? await openapiPortalRevoke(adapter, token) : "none";

	await adapter.doState(
		OPENAPI_TOKEN_STATE,
		"",
		"Encrypted local OpenAPI token (never log or expose!)",
		"",
		false,
		false,
	);
	// The approval state described a token that no longer exists. Saying so here matters because
	// nothing else runs on this path when automatic registration is off.
	adapter.openapiApproveAttempts = 0;
	await openapiReportApproval(adapter, {
		state: "unregistered",
		message: "No token stored — register this instance on the Local OpenAPI tab.",
	});
	if (withdrawn === "revoked") {
		adapter.log.info("[OpenAPI] Token forgotten and its registration withdrawn in the portal.");
	} else if (withdrawn === "absent") {
		adapter.log.info("[OpenAPI] Token forgotten. The portal held no registration for it any more.");
	} else if (withdrawn === "none") {
		adapter.log.info("[OpenAPI] No token was stored; nothing to forget.");
	} else {
		adapter.log.info(
			"[OpenAPI] Token forgotten. The entry in the portal may still be there — remove it on " +
				"the OpenAPI page before registering again, or you will not be able to tell the two apart.",
		);
	}
	return withdrawn;
}

/**
 * Report where the registration stands, in the log and in a state.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {{state: string, message: string}} ladder - Result of openapiCheckToken()
 * @returns {Promise<void>}
 */
async function openapiReportApproval(adapter, ladder) {
	await adapter.doState(
		`${OPENAPI_PFX}info.approvalState`,
		ladder.state,
		"Where the registration of this instance stands",
		"",
		false,
	);

	// The state is the machine-readable channel and carries the current verdict, but not when it
	// was established: doState goes through setStateChangedAsync, so the timestamp is of the last
	// change, and no _openapi state records a last-checked time. The log is quieter still:
	// waiting for approval is a condition that changes once and can last days, and a warning
	// carrying a URL once a minute buries everything else in the log. Logged on entry into the
	// condition and on every change out of it, the way the other connectors handle theirs.
	const condition = `openapi-approval:${ladder.state}`;
	const announced = adapter.loggedConditions?.has(condition);
	if (!announced) {
		for (const seen of [...(adapter.loggedConditions ?? [])]) {
			if (seen.startsWith("openapi-approval:")) {
				adapter.loggedConditions?.delete(seen);
			}
		}
		adapter.loggedConditions?.add(condition);
	}
	const level = announced ? "debug" : "warn";

	if (ladder.state === "pending") {
		const link = openapiApprovalUrl(adapter);
		adapter.log[level](
			`[OpenAPI] ⏳ ${ladder.message} Approve "${adapter.config.openapi_device_name || "ioBroker"}" here: ` +
				`${link.url}${link.exact ? "" : " (if that page is empty, raise the number in the URL)"}`,
		);
	} else if (ladder.state === "rejected" || ladder.state === "error") {
		adapter.log[level](`[OpenAPI] ⚠️ ${ladder.message}`);
	}
}

/**
 * Learn which appliance this is from the certificate it presents, without a token.
 *
 * One unauthenticated request is enough: the handshake completes and the certificate is on the
 * socket before the `401` comes back. This exists so that an instance with no local connector
 * and no approved token still knows which appliance it is talking to — which is what deciding
 * the plant, and therefore approving automatically, depends on.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {boolean} [force] - Probe even when an identity is already known, to verify the peer
 * @returns {Promise<string | null>} The appliance identity, or null when it could not be read
 */
async function openapiIdentifyFromCertificate(adapter, force = false) {
	// A cached identity answers the question "which appliance is this meant to be", but it says
	// nothing about which appliance is answering *now*. `force` is for the caller that needs the
	// second question settled before it sends a credential: without it, an identity restored
	// from FACTORY.DEVICE_ID short-circuited the probe and the first token-bearing request of
	// the process still went to an unverified peer.
	if (adapter.openapiExpectedDeviceId && !force) {
		return adapter.openapiExpectedDeviceId;
	}
	try {
		const response = await openapiClient(adapter).get("/v1/battery");
		if (response.request?.socket) {
			await openapiVerifyPeer(adapter, response.request.socket.getPeerCertificate?.());
		}
	} catch (error) {
		adapter.log.debug(`[OpenAPI] Could not read the appliance's certificate: ${error.message}`);
	}
	return adapter.openapiExpectedDeviceId || null;
}

/**
 * Which plants the account holds, keyed by the identity of each one's control unit.
 *
 * The mein-senec.de connector walks this during its own startup, but the walk does not depend
 * on the connector running — it is two context calls against an authenticated session. Doing
 * it here is what lets the portal be driven on an instance that has credentials but polls
 * nothing from the cloud.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<Map<string, {plant: number, name: string}>>} Control-unit identity → plant
 */
async function openapiPortalPlantWalk(adapter) {
	const found = new Map();
	const customer = await webClient.webGet(adapter, `${WEB_HOST}/endkunde/api/context/getEndkunde`);
	// The count comes from the portal, so it bounds a request loop with a number this adapter
	// does not control. Capped, because a login page coerced through Number() or a malformed
	// answer would otherwise queue requests for hours at the queue's minimum spacing.
	// `|| 1` rather than `|| 0`, to agree with webInit: a body that omits the count still has a
	// plant 0 worth asking about, and answering "the account holds 0 plants" blocked automatic
	// approval outright. A login page coerced through Number() lands on 1 and is then rejected
	// by the shape check inside the loop, which is where it belongs.
	const reported = Number(customer?.data?.anzahlAnlagen) || 1;
	const count = Math.min(Math.max(reported, 0), MAX_PLANTS_WALKED);
	if (reported > count) {
		adapter.log.warn(`[OpenAPI] ⚠️ The portal reported ${reported} plants; walking the first ${count}.`);
	}
	for (let plant = 0; plant < count; plant++) {
		if (adapter.unloaded) {
			break;
		}
		const system = await webClient.webGet(
			adapter,
			`${WEB_HOST}/endkunde/api/context/getAnlageBasedNavigationViewModel?anlageNummer=${plant}`,
		);
		// Stop where the mein-senec.de connector's own walk stops: once a plant answers nothing
		// usable, the remaining numbers are not plants either, and asking anyway is pure traffic.
		if (!system?.data || typeof system.data !== "object") {
			break;
		}
		const serial = identityDigits(system.data.steuereinheitnummer);
		if (serial) {
			found.set(serial, { plant, name: String(system.data.produktName || "") });
		}
	}
	return found;
}

/**
 * The plants of the account, for the Admin field to offer.
 *
 * The mein-senec.de connector enumerates these during its own startup, but this connector is
 * routinely the only one enabled — and then nothing has enumerated anything, which left the
 * field with nothing to suggest in exactly the configuration it is most needed. Walking the
 * portal here needs only the account credentials, the same as approving does.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<Array<{value: string, label: string}>>} Entries for the Admin field
 */
async function openapiListPlants(adapter) {
	const fromConnector = [];
	if (adapter.webMasterPlantNumber !== null && adapter.webMasterPlantNumber !== undefined) {
		fromConnector.push({
			value: String(adapter.webMasterPlantNumber),
			label: `${adapter.webMasterPlantSerial || "master"} (${adapter.webMasterPlantNumber})`,
		});
		for (const [serial, plant] of adapter.webSecondaryPlants?.entries() ?? []) {
			fromConnector.push({
				value: String(plant.anlageNummer),
				label: `${plant.produktName || serial} (${plant.anlageNummer})`,
			});
		}
	}
	if (fromConnector.length) {
		return fromConnector;
	}

	// Admin asks for these whenever the settings page is open, including for a field it is
	// hiding, so nobody has necessarily asked for anything — and signing in to the cloud is not
	// something to do on a page load. It is worth one sign-in only when the answer cannot be
	// had otherwise and would actually be used:
	//
	// - the connector is off        → opening its settings must authenticate against nothing
	// - no credentials              → nothing to sign in with
	// - a plant is already chosen   → there is nothing left to suggest
	//
	// With the mein-senec.de connector on, the branch above already answered from what it
	// enumerated, so reaching here at all means nothing knows the plants yet.
	if (
		!adapter.config.openapi_use ||
		!adapter.config.api_mail ||
		!adapter.config.api_pwd ||
		String(adapter.config.openapi_plant ?? "").trim() !== ""
	) {
		return [];
	}

	// Borrowed through web-client, which owns the session: it counts borrowers, collapses
	// concurrent sign-ins onto one promise, and only drops the session when the last borrower
	// lets go. Assigning the jar here raced both the connector and this module's own errands.
	const session = await webClient.webAcquireSession(adapter, "listing the plants of your account");
	if (!session.ok) {
		adapter.log.debug(`[OpenAPI] Not listing plants: ${session.reason}.`);
		return [];
	}
	try {
		const walked = await openapiPortalPlantWalk(adapter);
		return [...walked.entries()].map(([serial, entry]) => ({
			value: String(entry.plant),
			label: `${entry.name || `S${serial}`} (${entry.plant})`,
		}));
	} catch (error) {
		adapter.log.debug(`[OpenAPI] Could not list the account's plants: ${error.message}`);
		return [];
	} finally {
		if (session.borrowed) {
			webClient.webReleaseSession(adapter);
		}
	}
}

/**
 * Whether the portal can be driven on this instance right now, and for which plant.
 *
 * What this actually needs is the SENEC account credentials — the same `api_mail` / `api_pwd`
 * every cloud connector uses. The mein-senec.de connector does **not** have to be enabled or
 * polling: if there is no session already, one is established just for this, and the plant is
 * discovered with two context calls rather than taken from the connector's startup state.
 *
 * The plant must be established rather than guessed. Approving and revoking both name one, so
 * acting on an uncertain number would act on another appliance of the same account.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<{ok: true, plant: number, ours: boolean, verified: boolean} | {ok: false, ours?: boolean, borrowed?: boolean, retryable?: boolean, reason: string}>}
 * Whether to proceed, whether the session is this connector's to drop, whether the plant was
 * established against this appliance rather than merely configured, and why not
 */
async function openapiPortalReady(adapter) {
	if (!adapter.config.api_mail || !adapter.config.api_pwd) {
		return {
			ok: false,
			reason: "no SENEC account credentials are configured (SENEC Account tab)",
		};
	}

	// A configured plant saves the walk below, not the sign-in: approving and withdrawing are
	// themselves portal calls, so the session is needed either way.
	const configured = openapiResolvePlant(adapter);

	// Two devices in one instance is a configuration error, and the plant this resolves is
	// written to the user's account — so refuse before touching the portal rather than acting
	// on an identity the certificate has already contradicted.
	if (adapter.openapiIdentityMismatch) {
		return {
			ok: false,
			borrowed: false,
			// Needs the address or the appliance corrected; asking again changes nothing.
			retryable: false,
			reason: "the certificate on port 4424 names a different appliance than this instance is configured for",
		};
	}

	// Borrowed through web-client, which owns the session. It waits for the mein-senec.de
	// connector when that one is enabled, counts borrowers otherwise, and collapses concurrent
	// sign-ins — none of which this module could guarantee while assigning the jar itself.
	const session = await webClient.webAcquireSession(adapter, "completing the registration");
	if (!session.ok) {
		return {
			ok: false,
			borrowed: false,
			retryable: session.retryable === true,
			reason: session.reason || "the portal session could not be established",
		};
	}
	const ours = session.borrowed;

	// Whatever the connector already established, if it ran and the match was certain.
	// `verified` is narrower than `exact`: a plant typed by hand is authoritative for building
	// the approval link, but it has not been checked against this appliance, and the withdraw
	// path must not read "not listed there" as "gone" on a plant nobody verified.
	if (configured.exact) {
		const typed = String(adapter.config.openapi_plant ?? "").trim() !== "";
		return { ok: true, plant: configured.plant, ours, verified: !typed };
	}

	// Everything from here can fail, and a failure after a sign-in must still tell the caller
	// whose session it is — a refusal that drops `ours` leaves an authenticated session behind
	// on an instance that wanted none, which is exactly what this connector promises not to do.
	try {
		const mine = identityDigits(await openapiIdentifyFromCertificate(adapter));
		const plants = await openapiPortalPlantWalk(adapter);

		if (mine !== null) {
			const entry = plants.get(mine);
			if (entry !== undefined) {
				return { ok: true, plant: entry.plant, ours, verified: true };
			}
		}

		// With a single plant on the account there is nothing to confuse it with, so the number
		// is certain even when the appliance could not be identified. This is the ordinary case,
		// and it keeps a one-appliance household working without any of the matching above.
		if (plants.size === 1) {
			return { ok: true, plant: [...plants.values()][0].plant, ours, verified: true };
		}

		return {
			ok: false,
			ours,
			// Needs the plant set by hand; the walk will say the same thing next time.
			retryable: false,
			reason:
				mine === null
					? `the appliance could not be identified, and the account holds ${plants.size} plant(s) ` +
						"— set the plant by hand on the Local Connection tab"
					: `none of the ${plants.size} plant(s) on the account has this appliance as its ` +
						"control unit — set the plant by hand on the Local Connection tab",
		};
	} catch (error) {
		// A portal that would not answer the walk may well answer later.
		return { ok: false, ours, retryable: true, reason: `the account's plants could not be read: ${error.message}` };
	}
}

/**
 * The registrations the portal lists for a plant.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} plant - Plant number
 * @returns {Promise<Array<{tokenValue: string, tokenState: string, deviceName: string}>|null>} Entries, or null
 */
async function openapiPortalTokens(adapter, plant) {
	const res = await webClient.webGet(adapter, `${WEB_HOST}/endkunde/api/senec-open-api/tokens?anlageNummer=${plant}`);
	if (Array.isArray(res?.data)) {
		return res.data;
	}
	// The portal answers its login page with HTTP 200 when the session is not valid, which is
	// otherwise indistinguishable from an API error. Name that condition rather than logging the
	// page: a login page carries the account address and single-use codes, and this module has no
	// business putting either in a log — the same reason web-client redacts them.
	const body = String(res?.data ?? "");
	const looksLikeLogin = looksLikePortalLoginPage(body);
	adapter.log.debug(
		`[OpenAPI] Registration list for plant ${plant} was ${typeof res?.data}, not an array${
			looksLikeLogin
				? " — the portal answered its login page, so the session was not valid for this request."
				: ` (${body.length} characters).`
		}`,
	);
	return null;
}

/**
 * Whether a portal response is really its login page.
 *
 * The portal answers HTTP 200 with the login form when the session is not valid, which is
 * otherwise indistinguishable from a successful call. The shared transport recognises one
 * spelling of this and re-authenticates; the registration endpoints see a different one, so
 * both of them check here rather than each inventing a predicate.
 *
 * @param {unknown} data - Response body
 * @returns {boolean} True when the body is a login page rather than an answer
 */
function looksLikePortalLoginPage(data) {
	return /<!DOCTYPE html|<html/i.test(String(data ?? ""));
}

/**
 * Act on one registration in the portal.
 *
 * The token travels in the query string rather than a body, which is how the portal's own page
 * does it. `revoke` was observed; `grant` follows the identical shape.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {"grant" | "revoke"} action - What to do
 * @param {number} plant - Plant number
 * @param {string} token - The token to act on
 * @returns {Promise<{ok: boolean, status: number, body: string}>} Outcome
 */
async function openapiPortalAct(adapter, action, plant, token) {
	const res = await webClient.webPost(
		adapter,
		`${WEB_HOST}/endkunde/api/senec-open-api/tokens/${action}` +
			`?anlageNummer=${plant}&token=${encodeURIComponent(token)}`,
		undefined,
		{ rawStatus: true },
	);
	const status = Number(res?.status) || 0;
	// A 200 is not enough on its own: `rawStatus` hands the portal's login page straight back,
	// and taking that as success would report a withdrawal that never happened — the one
	// outcome the caller cannot verify afterwards.
	if (looksLikePortalLoginPage(res?.data)) {
		return { ok: false, status, body: "the portal answered its login page — the session was not valid" };
	}
	return { ok: status >= 200 && status < 300, status, body: String(res?.data ?? "").slice(0, 200) };
}

/**
 * Approve this instance's own registration, using the account holder's portal session.
 *
 * This is what makes the connector work without anyone visiting the portal. It is bounded
 * deliberately:
 *
 * - **Only our own entry.** The portal's listing carries `tokenValue`, so the entry is matched
 *   on the token the adapter is holding — never on the device name, which several instances
 *   could share and which is the one thing that cannot be told apart.
 * - **Pending or already granted.** Any other state is left alone. An already-granted entry
 *   still waits for the appliance, since the portal and the appliance are not in step.
 * - **Verified against the appliance, not the portal.** A granted entry means nothing until
 *   the appliance accepts the token, so the ladder is re-read and only `200` counts as done.
 * - **Best effort.** Every failure path falls back to the manual route, with the exact
 *   approval link in the log, rather than leaving the connector stuck.
 *
 * It is not a privilege escalation: an instance that holds the mein-senec.de credentials can
 * already call this endpoint, so doing it here adds no reach. What it removes is the hunt for
 * an unlinked portal page.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} token - The token just issued to this instance
 * @returns {Promise<boolean>} True when the appliance now accepts the token
 */
async function openapiAutoApprove(adapter, token) {
	// Inside the guarded region, so a throw cannot escape past this function's own cleanup.
	let ready;
	try {
		ready = await openapiPortalReady(adapter);
	} catch (error) {
		adapter.log.info(`[OpenAPI] Not approving automatically: ${error.message}.`);
		return false;
	}
	if (!ready.ok) {
		adapter.log.info(`[OpenAPI] Not approving automatically: ${ready.reason}.`);
		if (ready.ours) {
			webClient.webReleaseSession(adapter);
		}
		// A refusal that cannot improve on its own counts against the budget, so the connector
		// stops asking: missing credentials, credentials the portal refused, a plant nobody can
		// identify. Only a genuinely transient refusal — the mein-senec.de connector still
		// starting up — is free, because that one does resolve by waiting. Counting every refusal
		// stopped a recoverable case too early; counting none of them meant a refused credential
		// was re-sent once per interval for the life of the process.
		if (ready.retryable !== true) {
			adapter.openapiApproveAttempts = (adapter.openapiApproveAttempts || 0) + 1;
		}
		return false;
	}
	// Past the gate, so this attempt reaches the portal and is one of the bounded rounds.
	adapter.openapiApproveAttempts = (adapter.openapiApproveAttempts || 0) + 1;

	try {
		const entries = await openapiPortalTokens(adapter, ready.plant);
		if (!entries) {
			adapter.log.warn("[OpenAPI] ⚠️ The portal did not return a registration list.");
			return false;
		}
		const mine = entries.find((entry) => entry?.tokenValue === token);
		if (!mine) {
			adapter.log.warn(
				`[OpenAPI] ⚠️ The portal does not list this instance's registration on plant ${ready.plant}.`,
			);
			return false;
		}
		if (mine.tokenState !== "PENDING" && mine.tokenState !== "GRANTED") {
			adapter.log.info(`[OpenAPI] Registration is "${mine.tokenState}" rather than pending; leaving it alone.`);
			return false;
		}

		if (mine.tokenState === "PENDING") {
			const acted = await openapiPortalAct(adapter, "grant", ready.plant, token);
			if (!acted.ok) {
				adapter.log.warn(`[OpenAPI] ⚠️ The portal refused the approval (HTTP ${acted.status}): ${acted.body}`);
				return false;
			}
		} else {
			adapter.log.info("[OpenAPI] Registration is already approved in the portal; waiting for the appliance.");
		}

		// The portal accepting the grant is not the same as the appliance honouring it, and the
		// two are not instantaneous with one another — the grant travels through the cloud, the
		// same way a withdrawal does, and a withdrawal took about half a minute when measured
		// (the grant direction has never been timed). An entry that
		// was already granted therefore waits here too: returning "done" on the portal's word
		// alone reported success while the appliance was still answering 511, which sent the poll
		// loop straight back into another approval attempt. Ask the appliance, briefly.
		for (let attempt = 0; attempt < APPROVAL_CONFIRM_ATTEMPTS; attempt++) {
			if (adapter.unloaded) {
				return false;
			}
			const ladder = await openapiCheckToken(adapter);
			if (ladder.state === "approved") {
				adapter.log.info("[OpenAPI] ✅ Registration approved automatically; the appliance is answering.");
				return true;
			}
			if (ladder.state === "rejected") {
				// Approving our own entry cannot cause this. Something else changed underneath.
				adapter.log.warn(`[OpenAPI] ⚠️ ${ladder.message}`);
				return false;
			}
			await adapter.delay(APPROVAL_CONFIRM_WAIT_MS);
		}
		adapter.log.warn(
			"[OpenAPI] ⚠️ The portal accepted the approval but the appliance has not picked it up yet. " +
				"It usually follows within a minute — polling will report when it does.",
		);
		return false;
	} catch (error) {
		adapter.logError(error, "[OpenAPI] ❌ Automatic approval failed");
		return false;
	} finally {
		if (ready.ours) {
			webClient.webReleaseSession(adapter);
		}
	}
}

/**
 * Withdraw this instance's registration in the portal.
 *
 * Without this, discarding the token locally leaves the entry behind, and a stale entry is
 * exactly what makes a later registration ambiguous — same device name, nothing to tell them
 * apart by. Matched on `tokenValue` for the same reason as the approval.
 *
 * The three outcomes are told apart rather than collapsed into true/false, because what the
 * user has left to do differs: nothing, or go and remove the entry by hand. Saying "there may
 * still be an entry" after having looked and found none sends someone to the portal for nothing.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} token - The token to withdraw
 * @returns {Promise<"revoked" | "absent" | "unknown">} What happened to the portal entry
 */
async function openapiPortalRevoke(adapter, token) {
	// Inside the guarded region, so a throw cannot escape past this function's own cleanup.
	let ready;
	try {
		ready = await openapiPortalReady(adapter);
	} catch (error) {
		adapter.log.info(`[OpenAPI] Not withdrawing the registration in the portal: ${error.message}.`);
		return "unknown";
	}
	if (!ready.ok) {
		adapter.log.info(`[OpenAPI] Not withdrawing the registration in the portal: ${ready.reason}.`);
		if (ready.ours) {
			webClient.webReleaseSession(adapter);
		}
		return "unknown";
	}
	try {
		const entries = await openapiPortalTokens(adapter, ready.plant);
		if (!entries) {
			adapter.log.warn("[OpenAPI] ⚠️ The portal did not return a registration list.");
			return "unknown";
		}
		const mine = entries.find((entry) => entry?.tokenValue === token);
		if (!mine) {
			// "Not on this plant" only means "gone" when the plant is the right one. On an
			// unverified plant it means we looked in the wrong place — and reporting that as
			// absent told the user there was nothing to tidy up and let the caller register
			// again on top of a live entry, which is the one outcome this flow exists to avoid.
			if (!ready.verified) {
				adapter.log.warn(
					`[OpenAPI] ⚠️ The registration is not listed on plant ${ready.plant}, and that plant could ` +
						"not be confirmed to hold this appliance. Treating the portal entry as possibly still there.",
				);
				return "unknown";
			}
			adapter.log.info("[OpenAPI] The portal no longer lists this registration; nothing to withdraw.");
			return "absent";
		}
		const acted = await openapiPortalAct(adapter, "revoke", ready.plant, token);
		if (!acted.ok) {
			adapter.log.warn(`[OpenAPI] ⚠️ The portal refused the withdrawal (HTTP ${acted.status}): ${acted.body}`);
			return "unknown";
		}
		// The appliance keeps accepting a withdrawn token for a short while — the withdrawal
		// travels through the cloud rather than being enforced locally. Not worth waiting for,
		// and emphatically not worth retrying the revoke over.
		adapter.log.info(
			"[OpenAPI] ✅ Registration withdrawn in the portal. The appliance stops accepting the " +
				"token within about a minute.",
		);
		return "revoked";
	} catch (error) {
		adapter.logError(error, "[OpenAPI] ❌ Could not withdraw the registration in the portal");
		return "unknown";
	} finally {
		if (ready.ours) {
			webClient.webReleaseSession(adapter);
		}
	}
}

/**
 * Polls the appliance's local OpenAPI for the configured sections.
 *
 * Read-only by design. The two routes that would allow a charge or discharge setpoint answer
 * 403 to a portal-approved token, before and after approval alike, so there is nothing here
 * to write with — see docs/LOCAL_OPENAPI_4424.md.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function openapiPoll(adapter) {
	if (adapter.unloaded) {
		return;
	}
	// One cycle at a time, polls and registration sequences counted together. Two separate
	// flags were not enough: both paths lead into openapiAutoApprove, so a button press landing
	// while a timer poll sat in the approval wait produced two portal grants out of a
	// three-round budget. A caller arriving mid-cycle is dropped, not queued — the next
	// scheduled cycle reports the same thing a moment later.
	if (adapter.openapiCycleRunning) {
		adapter.log.debug("[OpenAPI] A cycle is already running; skipping this one.");
		return;
	}
	adapter.openapiCycleRunning = true;
	try {
		await openapiPollOnce(adapter);
	} finally {
		adapter.openapiCycleRunning = false;
	}
}

/**
 * One poll cycle. Guarded by openapiPoll; never call this directly.
 *
 * `mayRegister` is what bounds the hand-over between this function and openapiInitOnce. The two
 * call each other — a poll with no token hands over to the registration sequence, and that
 * sequence ends by reading the appliance — so one direction has to be switched off once taken.
 * Without that, a token that stores but reads back falsy sends the pair round the loop
 * indefinitely, and **each turn mints another portal entry**: the one outcome this module exists
 * to prevent, because two entries of the same name can never be told apart.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {boolean} [mayRegister] - False when entered from the registration sequence
 * @returns {Promise<void>}
 */
async function openapiPollOnce(adapter, mayRegister = true) {
	if (adapter.unloaded) {
		return;
	}
	// A connector the user switched off must stay switched off, whoever called this. Polling is
	// re-entered from the Admin buttons, and a panel the UI hides is not an authorization check.
	if (!adapter.config.openapi_use) {
		return;
	}

	const interval = resolveOpenapiInterval(adapter.config.openapi_interval);
	const openapiLog = adapter.config.openapi_showPolling ? "info" : "debug";
	const stored = await openapiReadTokenResult(adapter);
	const token = stored.token;

	// Two devices in one instance is a configuration error, not a transient fault, and polling
	// on would attribute one appliance's readings to the other. Stop until it is corrected.
	if (adapter.openapiIdentityMismatch) {
		await setOpenapiConnected(adapter, false);
		return;
	}

	// An unreadable token state is not an unregistered instance. Come back for it rather than
	// reporting "not registered", which is what would invite a duplicate registration.
	if (!stored.ok) {
		await setOpenapiConnected(adapter, false);
		scheduleOpenapiPoll(adapter, interval, openapiLog);
		return;
	}

	if (!token) {
		await openapiReportApproval(adapter, {
			state: "unregistered",
			message: "No token stored — register this instance on the Local OpenAPI tab.",
		});
		await setOpenapiConnected(adapter, false);
		// Either way this comes back: with automatic registration on by handing over to the
		// registration sequence, which closes with a read that arms the next poll; otherwise by
		// scheduling here, so a token the user registers by hand is noticed without a restart.
		if (mayRegister && adapter.config.openapi_register_automatically) {
			// Awaited, and the body rather than the guarded entry point: this cycle holds the
			// cycle flag, so openapiInit would refuse. It is asked to finish with a read, because
			// nothing else on this path arms a poll and a successful registration would otherwise
			// leave the connector holding a token it never reads with. The pair cannot loop: that
			// read is passed `mayRegister` false, which is the bound that terminates it.
			await openapiInitOnce(adapter, true);
		} else {
			scheduleOpenapiPoll(adapter, openapiRetryDelay(adapter, interval), openapiLog);
		}
		return;
	}

	const sections = buildOpenapiInclude(adapter.config.openapi_include);
	/** Sections that answered this cycle, for the completeness marker below. */
	const servedSections = new Set();
	let served = 0;
	let refusal = null;
	// Set when a 401 turned out not to hold, so the tail can tell "nothing served because the
	// token is refused" apart from "nothing served because we spent the cycle confirming it".
	let cleared = false;

	try {
		adapter.log[openapiLog]("[OpenAPI] 🔄 Polling the local OpenAPI...");
		for (const route of READ_ROUTES) {
			if (adapter.unloaded) {
				return;
			}
			if (!sections.includes(route.section)) {
				continue;
			}
			const response = await openapiClient(adapter).get(route.path, {
				headers: { "X-Auth-Token": token },
			});

			// The certificate is only reachable off the socket of a response, so this is the
			// first chance to check it. Same approach the local connector takes on 443.
			if (response.request?.socket) {
				await openapiVerifyPeer(adapter, response.request.socket.getPeerCertificate?.());
				if (adapter.openapiIdentityMismatch) {
					// Deliberately terminal — but the indicator has to say so. Returning without
					// clearing it left the connector reported as connected while it had stopped.
					await setOpenapiConnected(adapter, false);
					return;
				}
			}

			if (response.status === STATUS_ACTIVATION_PENDING) {
				refusal = {
					state: "pending",
					message: "Registered, still waiting for approval in the portal.",
				};
				break;
			}
			if (response.status === STATUS_UNKNOWN_TOKEN) {
				refusal = {
					state: "rejected",
					message:
						"The appliance no longer accepts the stored token. It was either revoked in the " +
						"portal or belongs to another appliance — forget it and register again.",
				};
				break;
			}
			if (response.status !== STATUS_OK) {
				adapter.log.warn(
					`[OpenAPI] ⚠️ ${route.path} answered HTTP ${response.status}: ${String(response.data).slice(0, 200)}`,
				);
				continue;
			}

			let body;
			try {
				body = JSON.parse(String(response.data));
			} catch {
				adapter.log.warn(`[OpenAPI] ⚠️ ${route.path} did not answer JSON — skipping this section.`);
				continue;
			}
			if (adapter.config.openapi_reqnresp_log) {
				adapter.log.debug(`[OpenAPI] ${route.path}: ${JSON.stringify(body).slice(0, 1000)}`);
			}
			if (adapter.unloaded) {
				return;
			}

			if (route.section === IDENTITY_SECTION) {
				// The fallback identity source. The certificate's common name normally names the
				// appliance and is adopted on the first response of the cycle, so this only comes
				// into play when that name cannot be parsed — and then it is what lets the plant
				// be matched, and therefore the registration approved, at all.
				const serial = identityDigits(body?.serialNumber);
				if (serial && !adapter.openapiExpectedDeviceId) {
					adapter.openapiExpectedDeviceId = serial;
				}
			}

			// The section goes into the object, not into the prefix. state_attr and the translation
			// tables are keyed on the object path evalPoll builds, so handing it a bare payload
			// under a "_openapi.battery." prefix produced keys like "stateOfCharge" with the
			// section lost — and every definition went unmatched. Wrapping it makes the key
			// "battery.stateOfCharge", which is what the definitions are written against, while
			// the resulting state path is identical either way.
			const section =
				route.section === "evse" ? keyOpenapiWallboxes(body) : normalizeOpenapiSection(route.section, body);
			await adapter.evalPoll({ [route.section]: section }, OPENAPI_PFX);
			// Only after a response that parsed: a slot the appliance no longer reports is gone,
			// and keeping it leaves a disconnected wallbox on display as though it were still
			// charging. Never on a failed route, where "absent" means "not answered".
			if (route.section === "evse") {
				await pruneOpenapiWallboxes(adapter, Object.keys(section));
				adapter.openapiEvseCleared = false;
			}
			servedSections.add(route.section);
			served++;
		}

		// A 401 is indistinguishable from a revocation, but it is not always one: the appliance's
		// view of a token follows the portal's through the cloud, measured at about half a minute,
		// and a restarting appliance can answer 401 before its token store is loaded. Treating the
		// first one as permanent stops the connector until someone presses a button, so ask once
		// more before accepting it.
		if (refusal?.state === "rejected" && !adapter.unloaded) {
			await adapter.delay(REJECTION_CONFIRM_WAIT_MS);
			if (adapter.unloaded) {
				return;
			}
			const second = await openapiCheckToken(adapter);
			if (second.state !== "rejected") {
				adapter.log.info(
					"[OpenAPI] The refusal did not hold on a second look — carrying on rather than stopping.",
				);
				cleared = second.state === "approved";
				refusal = cleared ? null : { state: second.state, message: second.message };
			}
		}

		// Sections that answered are fresh data whatever a later route said, so they stamp the
		// poll and hold the connection up. Reporting "disconnected" because section four was
		// refused, after sections one to three had already been written, marked fresh readings
		// unavailable and left lastPoll behind.
		if (served > 0) {
			await adapter.doState(
				`${OPENAPI_PFX}info.lastPoll`,
				new Date().toISOString(),
				"Last successful local OpenAPI poll",
				"",
				false,
			);
			adapter.log[openapiLog](`[OpenAPI] Polled ${served} section(s)`);
			await setOpenapiConnected(adapter, true);
		}

		// Leaving `evse` out of the include list means nothing will refresh those slots again, so
		// they are removed rather than left frozen at their last values. Gated on a cycle that
		// reached the appliance, so a transport outage never deletes states it merely could not
		// read — and on a flag, because the sweep walks every object this instance owns and the
		// default include list would otherwise pay for that once per cycle with nothing to find.
		if (served > 0 && !sections.includes("evse") && !adapter.openapiEvseCleared) {
			await pruneOpenapiWallboxes(adapter, []);
			adapter.openapiEvseCleared = true;
		}

		// A second marker, stamped only when every requested measurement section answered.
		// `lastPoll` above is deliberately "at least one", which is right for the connection state
		// but wrong for any consumer that reads several sections as one reading: a cycle where
		// /v1/battery answered and /v1/meter did not leaves the meter states at the previous
		// cycle's values, and a consumer keying on `lastPoll` would combine them as though they
		// were simultaneous.
		//
		// The identity section is excluded because the connector adds it itself rather than the
		// user asking for it, and it carries identity rather than measurement — so a nameplate
		// route failing on some firmware must not withhold the marker from a consumer that only
		// ever reads the measurements.
		const measured = sections.filter((section) => section !== IDENTITY_SECTION);
		if (measured.length > 0 && measured.every((section) => servedSections.has(section))) {
			await adapter.doState(
				`${OPENAPI_PFX}info.lastCompletePoll`,
				new Date().toISOString(),
				"Last local OpenAPI poll in which every requested section answered",
				"",
				false,
			);
		}

		if (refusal) {
			await openapiReportApproval(adapter, refusal);
			if (served === 0) {
				await setOpenapiConnected(adapter, false);
			}
			// Approving at startup can fail for reasons that pass — the mein-senec.de session may
			// not have been established yet — so this retries rather than sitting at "pending"
			// until someone restarts the instance. Bounded by openapiApproveAttempts, which
			// counts the refusals that will not improve by being asked again and leaves the
			// transient one free; see openapiAutoApprove.
			if (
				refusal.state === "pending" &&
				adapter.config.openapi_auto_approve !== false &&
				(adapter.openapiApproveAttempts || 0) < APPROVAL_MAX_ROUNDS
			) {
				// Counted inside openapiAutoApprove, once the portal has actually been reached.
				// Counting here spent a round on refusals that never left the adapter — no
				// session yet, no credentials — so a cloud hiccup at startup burned the whole
				// budget in three intervals and nothing tried again for the life of the process.
				if (await openapiAutoApprove(adapter, token)) {
					// Approved just now: read straight away rather than waiting out the interval.
					scheduleOpenapiPoll(adapter, APPROVED_REPOLL_MS, openapiLog, true);
					return;
				}
			}
		} else if (served > 0) {
			await openapiReportApproval(adapter, {
				state: "approved",
				message: "Approved — the appliance is answering.",
			});
			// The appliance is answering, so whatever went wrong earlier is over: let a later
			// pending state have its approval attempts back, drop the backoff, and let the next
			// outage be reported rather than silently deduplicated against this one.
			adapter.openapiApproveAttempts = 0;
			adapter.openapiTransportFailures = 0;
			for (const seen of [...(adapter.loggedConditions ?? [])]) {
				if (seen.startsWith("openapi-transport:") || seen.startsWith("openapi-register:")) {
					adapter.loggedConditions?.delete(seen);
				}
			}
		} else if (cleared) {
			// The 401 did not hold and nothing was served this cycle, so the token is good but
			// there is no fresh data yet. Say approved rather than leaving the state showing the
			// previous cycle's verdict for a whole interval, and read again shortly.
			await openapiReportApproval(adapter, {
				state: "approved",
				message: "Approved — the appliance is answering.",
			});
			await setOpenapiConnected(adapter, false);
			scheduleOpenapiPoll(adapter, APPROVED_REPOLL_MS, openapiLog, true);
			return;
		} else {
			await setOpenapiConnected(adapter, false);
		}
	} catch (error) {
		// Teardown cancels the in-flight request through the shared abort controller. That is a
		// shutdown, not a fault, and reporting it as one puts an error in every normal stop.
		if (adapter.unloaded || error.code === "ERR_CANCELED" || error.name === "CanceledError") {
			adapter.log.debug("[OpenAPI] Poll aborted (adapter shutdown).");
			return;
		}
		// Once per condition, not once per interval. An appliance that is switched off is a
		// condition, not an event, and logging it every cycle buries every other connector's
		// diagnostics. Same shape as connect-client's logOnce.
		const condition = `openapi-transport:${error.code || error.name || "failure"}`;
		if (adapter.loggedConditions?.has(condition)) {
			adapter.log.debug(`[OpenAPI] poll failed again: ${error.message}`);
		} else {
			adapter.loggedConditions?.add(condition);
			adapter.logError(error, "[OpenAPI] ❌ poll failed");
		}
		adapter.openapiTransportFailures = (adapter.openapiTransportFailures || 0) + 1;
		await setOpenapiConnected(adapter, false);
	}

	// A refused token is not retried on a timer: nothing changes until the user acts, and the
	// warning is already in the log. Pending is retried, because approval happens in the portal
	// and the adapter has no way to be told about it.
	if (refusal?.state !== "rejected") {
		// Consecutive transport failures stretch the interval, so a device that is away for a
		// day is asked a handful of times rather than 1440. Reset on any cycle that got through.
		scheduleOpenapiPoll(adapter, openapiRetryDelay(adapter, interval), openapiLog);
	}
}

/**
 * How long to wait before the next attempt, given how many have failed in a row.
 *
 * Shared by the poll tail and the registration path, so a device that is away stretches both
 * together rather than one of them asking at the configured interval for ever. Jittered, floored
 * and capped: the floor matters because full jitter can otherwise return almost zero.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} interval - The configured poll interval in milliseconds
 * @returns {number} Delay in milliseconds
 */
function openapiRetryDelay(adapter, interval) {
	const failures = adapter.openapiTransportFailures || 0;
	if (!failures) {
		return interval;
	}
	return Math.min(
		Math.max(OPENAPI_BACKOFF_MIN_MS, computeBackoffDelay(interval, failures, 30)),
		OPENAPI_BACKOFF_MAX_MS,
	);
}

/**
 * Report the connector's connection state, once, and only on a change.
 *
 * Every exit from the poll owes the indicator an answer. Routing them all through one helper is
 * what keeps that true — an exit that returns without calling this leaves the indicator lying.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {boolean} connected - Where the connector now stands
 * @returns {Promise<void>}
 */
async function setOpenapiConnected(adapter, connected) {
	if (!!adapter.openapiConnected === connected) {
		return;
	}
	adapter.openapiConnected = connected;
	await adapter.updateConnectionStatus();
}

/**
 * Arm the one poll timer, replacing any that is already pending.
 *
 * Polling is re-entered from the Admin buttons as well — approving restarts a chain a refusal
 * stopped, forgetting a token starts a fresh registration — so every scheduling point goes
 * through here. Without it, a press landing while a chain is alive leaves two chains running
 * against the same appliance for as long as the instance lives.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} delayMs - How long until the next poll
 * @param {"info" | "debug"} openapiLog - Level the connector logs its progress at
 * @param {boolean} [quiet] - Skip the "next poll" line, for the immediate re-read after approval
 * @returns {void}
 */
function scheduleOpenapiPoll(adapter, delayMs, openapiLog, quiet = false) {
	if (adapter.unloaded) {
		return;
	}
	if (adapter.openapiPollTimer) {
		adapter.clearTimeout(adapter.openapiPollTimer);
		adapter.openapiPollTimer = null;
	}
	adapter.openapiPollTimer = adapter.setTimeout(() => {
		adapter.openapiPollTimer = null;
		openapiPoll(adapter).catch((e) => adapter.logError(e, "[OpenAPI] ❌ scheduled poll failed"));
	}, delayMs);
	if (!quiet) {
		adapter.log[openapiLog](`[OpenAPI] ⏱ Next local OpenAPI poll scheduled in ${(delayMs / 1000).toFixed(0)}s`);
	}
}

/**
 * Start the connector: register if asked to and not yet registered, then poll.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function openapiInit(adapter) {
	// The same flag the poll takes, not a second one: four entry points reach this — onReady and
	// three Admin commands — and the approval wait inside can hold for over a minute, so sharing
	// one flag is what keeps a press from overlapping a timer poll inside openapiAutoApprove.
	if (adapter.openapiCycleRunning) {
		adapter.log.debug("[OpenAPI] A cycle is already running; skipping this registration sequence.");
		return;
	}
	adapter.openapiCycleRunning = true;
	try {
		await openapiInitOnce(adapter);
	} finally {
		adapter.openapiCycleRunning = false;
	}
}

/**
 * One register-approve-poll sequence. Guarded by openapiInit; never call this directly.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {boolean} [thenPoll] - False when entered from a poll, which finishes the cycle itself
 * @returns {Promise<void>}
 */
async function openapiInitOnce(adapter, thenPoll = true) {
	if (adapter.unloaded) {
		return;
	}
	// Not a bare truthiness check: the address ships empty, but instances created before the
	// placeholder was dropped still hold "0.0.0.0", which is the absence of a setting rather
	// than a host. localHostConfigured() treats both as unconfigured.
	if (!adapter.localHostConfigured()) {
		adapter.log.warn(
			"[OpenAPI] No appliance address configured. The local OpenAPI uses the same address as " +
				"the local connector — set it at the top of the Local Connection tab.",
		);
		return;
	}
	// Announced here rather than at the call site, so an instance that cannot run the connector
	// does not first say it is using it and then decline. Once per process: this function is
	// re-entered on every cycle while a registration keeps failing.
	if (!adapter.loggedConditions?.has("openapi-configured")) {
		adapter.loggedConditions?.add("openapi-configured");
		adapter.log.info("[OpenAPI] Usage of the appliance's local OpenAPI configured.");
	}
	// Prefer the identity the local connector already established, so a mismatch between the two
	// interfaces is caught on the very first response. Only while that connector is actually
	// enabled: the state persists, so on an instance that polls only 4424 it can be the device id
	// of an appliance this instance stopped talking to months ago — and the refusal it produces
	// then blames "the local connector is polling" when nothing is.
	if (!adapter.openapiExpectedDeviceId && adapter.config.lala_use) {
		try {
			const factoryId = await adapter.getStateAsync(`${adapter.namespace}.FACTORY.DEVICE_ID`);
			const digits = identityDigits(factoryId?.val);
			if (digits) {
				adapter.openapiExpectedDeviceId = digits;
			}
		} catch {
			// The local connector may never have run. The certificate fills this in instead.
		}
	}

	// Restore the pinned fingerprint, the way the local connector restores its own on 443. Without
	// this the pin only lasted the life of the process, so trust-on-first-use was really
	// trust-on-first-use-per-restart and a certificate swapped while the adapter was down was
	// adopted in silence — which is not what the check above claims to do.
	if (!adapter.openapiFingerprint) {
		try {
			const pinned = await adapter.getStateAsync(`${OPENAPI_PFX}tls.fingerprint`);
			if (pinned?.val) {
				adapter.openapiFingerprint = String(pinned.val);
			}
		} catch {
			// Nothing pinned yet, or the state is unreadable: the next response pins it afresh.
		}
	}

	// A contradicted certificate stops the whole sequence, not just the poll: registering and
	// approving write to the user's account, and doing that for an appliance this instance has
	// already refused to read is worse than doing nothing.
	if (adapter.openapiIdentityMismatch) {
		adapter.log.warn(
			"[OpenAPI] ⚠️ Not registering or approving: the certificate on port 4424 names a " +
				"different appliance than this instance is configured for.",
		);
		return;
	}

	const name = adapter.config.openapi_device_name || "ioBroker";
	const interval = resolveOpenapiInterval(adapter.config.openapi_interval);
	const openapiLog = adapter.config.openapi_showPolling ? "info" : "debug";

	// Learn which appliance this is before anything carries the token. The handshake presents
	// the certificate on an unauthenticated request, so this costs one 401 and closes the gap
	// the standing check below used to open on every restart: the mismatch flag lives only in
	// memory, so a fresh process had nothing to refuse with and sent an approved credential to
	// whatever answered on the configured address.
	// Forced: this is the one call whose purpose is to see the certificate, not to learn an
	// identity we may already hold.
	await openapiIdentifyFromCertificate(adapter, true);
	if (adapter.openapiIdentityMismatch) {
		adapter.log.warn(
			"[OpenAPI] ⚠️ Not continuing: the certificate on port 4424 names a different appliance " +
				"than this instance is configured for.",
		);
		return;
	}

	const stored = await openapiReadTokenResult(adapter);
	if (!stored.ok) {
		// Not registering on a failed read: that would mint a second portal entry while the
		// first is still live, holding the token the read just failed to produce.
		adapter.log.error(
			"[OpenAPI] ❌ The stored token could not be read, so no registration is attempted — " +
				"a second one would be indistinguishable from the first. Trying again on the next cycle.",
		);
		scheduleOpenapiPoll(adapter, openapiRetryDelay(adapter, interval), openapiLog);
		return;
	}
	let token = stored.token;

	// Registering is the one thing that reaches outside the appliance: it puts an entry into
	// the user's portal that only they can approve or remove, and the appliance cannot be asked
	// which entries exist, so a second registration is indistinguishable from the first. It
	// therefore happens only when nothing is stored, only when the user asked for it, and only
	// one at a time across every path that can reach it.
	if (!token && adapter.config.openapi_register_automatically) {
		const outcome = await withOpenapiRegistration(adapter, async () => {
			// Re-read while holding the lock: the Admin button or a forget-and-start-over may
			// have registered between this function's own read and the lock being taken.
			const fresh = await openapiReadTokenResult(adapter);
			if (!fresh.ok) {
				return null;
			}
			if (fresh.token) {
				adapter.log.debug("[OpenAPI] A token appeared while waiting to register; using it.");
				return fresh.token;
			}
			// Info on the first attempt and after any success; debug while an attempt keeps
			// failing, because this function is re-entered every cycle until it succeeds.
			const retrying = [...(adapter.loggedConditions ?? [])].some((c) => c.startsWith("openapi-register:"));
			adapter.log[retrying ? "debug" : "info"](`[OpenAPI] No token stored. Registering as "${name}"...`);
			const result = await openapiRegister(adapter, name);
			if (!result.ok || !result.token) {
				// Once per condition, like the poll path. This runs every cycle while the
				// appliance is unreachable, so an unconditional error line here is the same
				// 1440-a-day flood the poll path was fixed for.
				const condition = `openapi-register:${result.code || "refused"}`;
				if (adapter.loggedConditions?.has(condition)) {
					adapter.log.debug(`[OpenAPI] Registration failed again: ${result.error}`);
				} else {
					adapter.loggedConditions?.add(condition);
					adapter.log.error(`[OpenAPI] ❌ Registration failed: ${result.error}`);
					// Only where the request could have been half-delivered. A refused connection
					// cannot have minted an entry, and saying otherwise sends the user to audit a
					// portal page for something that cannot be there.
					if (result.delivered) {
						adapter.log.warn(
							`[OpenAPI] ⚠️ If the appliance did accept that request, an entry named "${name}" may ` +
								"be waiting in the portal that this instance does not hold. Check the OpenAPI " +
								"page before registering again, and remove any entry you do not recognise.",
						);
					}
				}
				// Shares the poll's backoff counter, so a long outage stretches both paths
				// together instead of one of them retrying flat out.
				adapter.openapiTransportFailures = (adapter.openapiTransportFailures || 0) + 1;
				return null;
			}
			await openapiStoreToken(adapter, result.token);
			return result.token;
		});
		if (!outcome.ok) {
			adapter.log.info("[OpenAPI] A registration is already under way; leaving that one to finish.");
			return;
		}
		token = typeof outcome.value === "string" ? outcome.value : null;
		if (!token) {
			// Most often the appliance is simply not up yet — host and appliance tend to boot
			// together. Coming back beats sitting dead until someone restarts the instance, and
			// it comes back on the shared backoff rather than at the flat interval.
			scheduleOpenapiPoll(adapter, openapiRetryDelay(adapter, interval), openapiLog);
			return;
		}
	}

	// Approval is attempted for any stored token the appliance is still waiting on, not only for
	// one just registered. A first attempt can fail for reasons that have nothing to do with the
	// registration — no session yet, the portal unreachable — and without this the connector
	// would sit at "pending" forever, because re-registering is exactly what must not happen.
	// The local ladder is checked first so an already-approved token costs no portal traffic.
	if (token && adapter.config.openapi_auto_approve !== false) {
		const standing = await openapiCheckToken(adapter);
		if (standing.state === "pending") {
			const approved = await openapiAutoApprove(adapter, token);
			if (!approved) {
				const link = openapiApprovalUrl(adapter);
				adapter.log.warn(
					`[OpenAPI] 👉 Approve "${name}" in the portal — log in to mein-senec.de first, then open: ` +
						`${link.url}${link.exact ? "" : " (if that page lists nothing, raise the number in the URL)"}`,
				);
			}
		}
	}

	if (thenPoll) {
		// Straight to the body: this function already holds the cycle flag, so going through
		// openapiPoll would have it refuse its own continuation. `false` stops that read from
		// handing back here if the token it just stored does not read back.
		await openapiPollOnce(adapter, false);
	}
}

module.exports = {
	// Used by main.js
	openapiInit,
	openapiPoll,
	openapiForgetToken,
	openapiReportApproval,
	openapiApprovalUrl,
	openapiListPlants,
	openapiCheckToken,
	openapiRegister,
	openapiReadToken,
	openapiReadTokenResult,
	openapiStoreToken,
	withOpenapiRegistration,
	// Not reached from main.js; exported for coverage and for diagnostics
	openapiPortalReady,
	openapiResolvePlant,
	openapiVerifyPeer,
	buildOpenapiInclude,
	normalizeOpenapiSection,
	keyOpenapiWallboxes,
	pruneOpenapiWallboxes,
	identityDigits,
	resolveOpenapiTimeout,
	resolveOpenapiInterval,
	looksLikePortalLoginPage,
	READ_ROUTES,
	DEFAULT_INCLUDE,
	OPENAPI_PORT,
};
