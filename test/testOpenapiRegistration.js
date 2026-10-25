"use strict";

/**
 * Registering this instance with the appliance, and the things that must happen in a particular
 * order while doing it.
 *
 * Registering is the one thing this connector does that reaches outside the appliance: it puts an
 * entry into the user's SENEC portal that only they can approve or remove, and the appliance
 * cannot be asked which entries exist — so a second entry is indistinguishable from the first,
 * for ever. That is what makes each of the rules below a correctness question rather than a
 * nicety:
 *
 * - the token is never presented to a peer whose identity has already been contradicted, and the
 *   identity is established from the certificate *before* anything carries the token, because the
 *   mismatch flag lives only in memory and a fresh process has nothing to refuse with — which is
 *   also why that probe is forced rather than skipped on an identity already held: a device id
 *   restored from FACTORY.DEVICE_ID says which appliance this is meant to be, not which one is
 *   answering now;
 * - two callers arriving together register once, whichever paths they came in on. Four entry
 *   points reach this and the approval wait inside holds for over a minute, so a press landing on
 *   a running timer poll spent three portal grants out of a three-round budget while the poll and
 *   the registration sequence had a flag each;
 * - an appliance that is switched off is a condition, not an event: one error line, then quiet,
 *   and the user is sent to audit their portal only when the request could really have arrived;
 * - a token minted while the adapter is stopping is still written down, because one that is not
 *   can never be told apart from the next one;
 * - and every wait is abandoned on teardown rather than answered into an adapter that is gone.
 *
 * Driven through the module's exported entry points with the appliance's HTTPS client replaced by
 * a scripted double, so no socket is ever opened — `test/mocha.setup.js` would refuse one anyway.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const openapi = require("../lib/openapi-client.js");

/** What the token read answers when one is stored. The adapter's decrypt is the identity here. */
const STORED_TOKEN = "appliance-token";
/** This appliance, as both its certificate and FACTORY.DEVICE_ID spell it. */
const THIS_APPLIANCE = "209719282544";

/**
 * Build an adapter whose timers, states, logs and registration bookkeeping are all recorded.
 *
 * `openapiClient` is pre-set by the callers, so the module's axios instance is never created.
 *
 * @param {object} [over] - Overrides merged over the defaults; `config` is merged, not replaced
 * @returns {object} Adapter double
 */
function makeAdapter(over = {}) {
	const adapter = {
		namespace: "senec.0",
		unloaded: false,
		loggedConditions: new Set(),
		openapiConnected: false,
		openapiIdentityMismatch: false,
		openapiExpectedDeviceId: null,
		// Pre-pinned, so nothing goes looking for a stored fingerprint.
		openapiFingerprint: "pinned",
		openapiApproveAttempts: 0,
		openapiTransportFailures: 0,
		openapiPollTimer: null,
		openapiBusy: false,
		// One flag for polls and registration sequences together. Two separate ones let an Admin
		// press overlap a timer poll inside the approval wait, which spent two portal grants out
		// of a three-round budget.
		openapiCycleRunning: false,

		/** Timers still pending: armed, not yet cleared. */
		timers: [],
		/** Every delay ever armed, in order. */
		armed: [],
		states: [],
		polled: [],
		logs: [],
		/** How often the registration sequence was entered — see `localHostConfigured` below. */
		initEntries: 0,
	};

	adapter.log = {
		info: (msg) => adapter.logs.push(["info", msg]),
		warn: (msg) => adapter.logs.push(["warn", msg]),
		error: (msg) => adapter.logs.push(["error", msg]),
		debug: (msg) => adapter.logs.push(["debug", msg]),
		silly: () => {},
	};
	adapter.logError = (e, prefix = "") => adapter.logs.push(["error", `${prefix}: ${e?.message ?? e}`]);
	adapter.setTimeout = (fn, ms) => {
		const handle = { fn, ms };
		adapter.timers.push(handle);
		adapter.armed.push(ms);
		return handle;
	};
	adapter.clearTimeout = (handle) => {
		adapter.timers = adapter.timers.filter((t) => t !== handle);
	};
	adapter.updateConnectionStatus = async () => {};
	adapter.doState = async (id, value) => {
		adapter.states.push([id, value]);
	};
	adapter.evalPoll = async (obj, pfx) => {
		adapter.polled.push([pfx, obj]);
	};
	adapter.getStateAsync = async () => null;
	adapter.decrypt = (value) => value;
	adapter.encrypt = (value) => value;
	// openapiInitOnce is the only thing on these paths that asks, and it asks exactly once per
	// sequence — which makes this a precise probe for "the sequence was entered".
	adapter.localHostConfigured = () => {
		adapter.initEntries++;
		return true;
	};

	Object.assign(adapter, over);
	adapter.config = {
		openapi_use: true,
		senecip: "192.0.2.1",
		openapi_interval: 60,
		openapi_device_name: "ioBroker",
		...(over.config || {}),
	};
	return adapter;
}

/** @returns {Function} A getStateAsync that answers with a stored token. */
function tokenStored() {
	return async (id) => (id === "_openapi.token" ? { val: STORED_TOKEN } : null);
}

/**
 * Wire the adapter's token state to a store that answers with whatever was written to it.
 *
 * Needed wherever a registration is expected to succeed: the sequence ends in a poll, and the
 * poll's no-token branch re-enters the sequence, so a fake whose read does not reflect its own
 * write hands the two paths back and forth without end. One stored token is what stops that,
 * in the test as in the adapter.
 *
 * @param {object} adapter - Adapter double
 * @param {string | null} [initial] - What is stored to begin with
 * @returns {object} The same adapter
 */
function withTokenStore(adapter, initial = null) {
	let stored = initial;
	adapter.getStateAsync = async (id) => (id === "_openapi.token" && stored ? { val: stored } : null);
	adapter.doState = async (id, value) => {
		adapter.states.push([id, value]);
		if (id === "_openapi.token") {
			stored = value || null;
		}
	};
	return adapter;
}

/**
 * @param {object} body - Payload the route is to answer with
 * @returns {object} A 200, with the body as the text the appliance really sends
 */
const answers = (body) => ({ status: 200, data: JSON.stringify(body) });

/**
 * @param {number} status - Status code off the token ladder
 * @returns {object} A refusal, worded the way the appliance words them
 */
const refuses = (status) => ({ status, data: "not authorized" });

/**
 * A 200 whose socket presents a certificate naming an appliance.
 *
 * The certificate is only reachable off the socket of a response, which is why every identity
 * check in this connector happens after a request rather than before one.
 *
 * @param {string} cn - Common name of the certificate subject
 * @param {object} [body] - Payload to answer with
 * @returns {object} The response, with the certificate reachable off its socket
 */
const presenting = (cn, body = { stateOfCharge: 47 }) => ({
	status: 200,
	data: JSON.stringify(body),
	request: { socket: { getPeerCertificate: () => ({ raw: Buffer.from(cn), subject: { CN: cn } }) } },
});

/**
 * An appliance client that records what was asked of it, headers included.
 *
 * The headers are the point: "which request carried the token" is not observable any other way,
 * and the ordering rules below are entirely about that.
 *
 * @param {(method: string, path: string, call: number) => object} answer - What to answer, per call
 * @returns {{get: Function, post: Function, requests: Array<object>}} The client double
 */
function appliance(answer) {
	const requests = [];
	/**
	 * @param {string} method - HTTP method
	 * @param {string} path - Route asked for
	 * @param {object} [options] - Axios per-request options, which is where the headers are
	 * @param {string} [body] - Request body, for the registration POST
	 * @returns {Promise<object>} The scripted answer
	 */
	const record = async (method, path, options, body) => {
		requests.push({ method, path, headers: options?.headers || {}, body });
		const response = answer(method, path, requests.length);
		if (response instanceof Error) {
			throw response;
		}
		return response;
	};
	return {
		requests,
		get: (path, options) => record("GET", path, options),
		post: (path, body, options) => record("POST", path, options, body),
	};
}

/**
 * @param {string} code - The axios error code to fail with
 * @param {string} [message] - Message to carry
 * @returns {Error} A transport failure as axios reports them
 */
const fails = (code, message = `connect ${code} 192.0.2.1:4424`) => Object.assign(new Error(message), { code });

/**
 * Run `body` with every wait collapsed, and with the waits holding the process open.
 *
 * @param {() => Promise<unknown>} body - Work to run
 * @returns {Promise<void>}
 */
async function withCollapsedWaits(body) {
	const real = global.setTimeout;
	// @ts-expect-error — a test-local stand-in, restored immediately afterwards
	global.setTimeout = (fn, ms, ...rest) => {
		const handle = real(fn, ms > 5 ? 0 : ms, ...rest);
		// The module unrefs its own waits so one cannot hold the process open. Swallowing that
		// here is what keeps node alive while a test awaits one — otherwise the wait is the only
		// thing left on the event loop and the process is free to exit before the assertions run.
		return { unref: () => handle, ref: () => handle };
	};
	try {
		await body();
	} finally {
		global.setTimeout = real;
	}
}

/**
 * Run `body` with teardown arriving during every wait.
 *
 * The confirmation waits run on the global timer rather than the adapter's — deliberately, so a
 * wait cannot be left unsettled by teardown, which also means a test cannot fake one through the
 * adapter. Setting `unloaded` as the wait expires is exactly the race the checks after those
 * waits exist for, and collapsing the delay keeps the suite in milliseconds.
 *
 * @param {object} adapter - Adapter double to stop
 * @param {() => Promise<void>} body - Work to run
 * @returns {Promise<void>}
 */
async function withUnloadDuringEveryWait(adapter, body) {
	const real = global.setTimeout;
	// @ts-expect-error — a test-local stand-in, restored immediately afterwards
	global.setTimeout = (fn, ms, ...rest) =>
		real(
			(...args) => {
				adapter.unloaded = true;
				fn(...args);
			},
			ms > 5 ? 0 : ms,
			...rest,
		);
	try {
		await body();
	} finally {
		global.setTimeout = real;
	}
}

/**
 * @param {object} adapter - Adapter double
 * @param {string} id - State path
 * @returns {unknown} The last value written to that state, or undefined
 */
function lastWrite(adapter, id) {
	const hits = adapter.states.filter(([written]) => written === id);
	return hits.length ? hits[hits.length - 1][1] : undefined;
}

/**
 * @param {object} adapter - Adapter double
 * @param {string} level - Log level to count
 * @returns {Array<[string, string]>} The lines logged at that level
 */
const linesAt = (adapter, level) => adapter.logs.filter(([written]) => written === level);

describe("local OpenAPI: registering with the appliance", () => {
	describe("openapiCheckToken", () => {
		// The standing check at startup and the Admin button both reach here, and both used to
		// present an approved credential to whatever answered on the configured address — including
		// after the certificate had already been refused once. The flag lives only in memory, so
		// honouring one another path found is the whole of this guard.
		it("sends nothing at all while an identity mismatch stands", async () => {
			const adapter = makeAdapter({
				openapiIdentityMismatch: true,
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => answers({ stateOfCharge: 47 })),
			});

			const ladder = await openapi.openapiCheckToken(adapter);

			assert.equal(ladder.state, "error");
			assert.equal(ladder.status, null);
			assert.match(ladder.message, /different appliance/);
			assert.deepEqual(
				adapter.openapiClient.requests,
				[],
				"no request is made, let alone one carrying the token",
			);
		});

		// Without a mismatch standing it has to find one for itself, off the socket of its own
		// response — the certificate is not reachable any earlier, so a check that happens before
		// the request is no check at all.
		it("checks the certificate of its own response, and refuses what it finds there", async () => {
			const adapter = makeAdapter({
				openapiExpectedDeviceId: THIS_APPLIANCE,
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => presenting("S999999999999")),
			});

			const ladder = await openapi.openapiCheckToken(adapter);

			assert.equal(
				adapter.openapiClient.requests[0].headers["X-Auth-Token"],
				STORED_TOKEN,
				"the request that found the mismatch is the one that carried the token",
			);
			assert.equal(adapter.openapiIdentityMismatch, true, "so the next caller refuses before sending it again");
			assert.equal(ladder.state, "error", "a 200 from the wrong appliance is not an approval");
			assert.match(ladder.message, /not the one this instance is configured for/);
		});

		// The other direction, so the refusal cannot be satisfied by refusing everything: the right
		// appliance answering 200 is an approval, and its certificate gets pinned on the way.
		it("takes a 200 from the configured appliance as approved", async () => {
			const adapter = makeAdapter({
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiFingerprint: null,
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => presenting(`S${THIS_APPLIANCE}`)),
			});

			const ladder = await openapi.openapiCheckToken(adapter);

			assert.equal(ladder.state, "approved");
			assert.equal(adapter.openapiIdentityMismatch, false);
			assert.ok(adapter.openapiFingerprint, "and the certificate it answered with is pinned");
		});
	});

	describe("openapiInit", () => {
		// The mismatch flag lives only in memory, so a fresh process had nothing to refuse with and
		// sent an approved credential to whatever answered on the configured address. The handshake
		// presents the certificate on an unauthenticated request, so learning which appliance this
		// is costs one 401 — and it has to be spent before anything carries the token.
		it("establishes which appliance this is before anything carries the token", async () => {
			const adapter = makeAdapter({
				config: { openapi_auto_approve: true },
				getStateAsync: tokenStored(),
				openapiExpectedDeviceId: null,
				openapiClient: appliance(() => presenting(`S${THIS_APPLIANCE}`)),
			});

			await openapi.openapiInit(adapter);

			const requests = adapter.openapiClient.requests;
			const carried = requests.findIndex((req) => "X-Auth-Token" in req.headers);
			assert.ok(requests.length >= 2, `the sequence has to get as far as using the token — ${requests.length}`);
			assert.ok(
				!("X-Auth-Token" in requests[0].headers),
				"the first request is the unauthenticated identity probe, and it carries no credential",
			);
			assert.ok(
				carried > 0,
				`nothing may carry the token before the peer is established — was request ${carried}`,
			);
			assert.equal(adapter.openapiExpectedDeviceId, THIS_APPLIANCE, "and the probe is what established it");
		});

		// Four entry points reach this — onReady and three Admin commands — and the approval wait
		// inside it can hold for over a minute. Two presses used to produce two portal grants out
		// of a three-round budget, so the second caller is dropped rather than queued: running the
		// sequence again afterwards would spend the round it was dropped to save.
		it("runs the sequence once when two callers arrive together", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => answers({ stateOfCharge: 47 })),
			});

			await Promise.all([openapi.openapiInit(adapter), openapi.openapiInit(adapter)]);

			assert.equal(adapter.initEntries, 1, "the second caller is dropped — and dropped, not queued");
			assert.ok(
				adapter.logs.some(([level, msg]) => level === "debug" && /already running/.test(msg)),
				"and says so, at a level that does not shout",
			);
			assert.equal(adapter.openapiCycleRunning, false, "the flag is released whatever happened");

			// Still dropped, not deferred: a queued second run would spend a round of the portal
			// budget here, one tick after the first one finished.
			await openapi.openapiInit(adapter);
			assert.equal(adapter.initEntries, 2, "a later caller runs it again, so the flag is not sticky");
		});

		// The probe exists because the mismatch flag lives only in memory. An identity restored
		// from FACTORY.DEVICE_ID answers "which appliance is this meant to be", which is a
		// different question from "which appliance is answering now" — and short-circuiting on
		// the first still sent the first token-bearing request of a fresh process to an
		// unverified peer, measured against a certificate naming another appliance.
		it("probes the certificate even when the identity is already known", async () => {
			const adapter = makeAdapter({
				// Off, so the only thing that could put an unauthenticated request first is the
				// probe itself: both the standing check and the poll carry the token.
				config: { openapi_auto_approve: false },
				getStateAsync: tokenStored(),
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiClient: appliance(() => presenting(`S${THIS_APPLIANCE}`)),
			});

			await openapi.openapiInit(adapter);

			const requests = adapter.openapiClient.requests;
			assert.ok(requests.length >= 1, "something has to be asked");
			assert.ok(
				!("X-Auth-Token" in requests[0].headers),
				"a held identity is not a verified peer, so the probe is still spent before the token travels",
			);
			assert.equal(requests[0].path, "/v1/battery", "and it is the handshake that carries the certificate");
		});
	});

	describe("one cycle at a time, whichever path is in it", () => {
		// Measured: with a flag each, a "Check approval" press landing while a timer poll sat in
		// the approval wait — which holds for over a minute — produced three portal grants out of
		// a three-round budget. A grant is the one thing that is not cheap to undo: the portal
		// lists entries that nothing afterwards can tell apart.
		it("enters the approval once when a poll and a registration start together", async () => {
			const grants = [];
			const portal = proxyquire("../lib/openapi-client.js", {
				"./web-client.js": {
					webAcquireSession: async () => ({ ok: true, borrowed: false }),
					webReleaseSession: () => {},
					webGet: async () => ({ data: [{ tokenValue: STORED_TOKEN, tokenState: "PENDING" }] }),
					webPost: async (_adapter, url) => {
						grants.push(url);
						return { status: 200, data: "" };
					},
				},
			});
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x", openapi_auto_approve: true },
				getStateAsync: tokenStored(),
				// Matched on this appliance's own control-unit number, so the plant is established
				// without walking the portal.
				openapiExpectedDeviceId: THIS_APPLIANCE,
				webMasterPlantNumber: 0,
				webMasterPlantSerial: `st_${THIS_APPLIANCE}`,
				webSecondaryPlants: new Map(),
				// 511 throughout: the appliance never picks the grant up, so whichever cycle got in
				// first sits in the confirmation wait for the whole of the other one's chance.
				openapiClient: appliance(() => refuses(511)),
			});

			await withCollapsedWaits(() => Promise.all([portal.openapiPoll(adapter), portal.openapiInit(adapter)]));

			assert.deepEqual(
				grants.map((url) => /tokens\/(\w+)/.exec(url)?.[1]),
				["grant"],
				"one grant, not one per path: the second would be an entry nobody can tell from the first",
			);
			assert.equal(adapter.openapiApproveAttempts, 1, "and one round of the three is spent, not two");
			assert.equal(
				adapter.logs.filter(([level, msg]) => level === "debug" && /already running/.test(msg)).length,
				1,
				"the path that arrived second is dropped, and says so at a level that does not shout",
			);
			assert.equal(adapter.openapiCycleRunning, false, "and the flag is released afterwards");
		});
	});

	describe("an appliance the certificate has already contradicted", () => {
		/**
		 * openapi-client with every portal call fatal.
		 *
		 * The point of the guards below is that nothing reaches the user's account, so the
		 * strongest statement available is that the portal transport is never entered at all.
		 *
		 * @returns {object} The module, with its portal calls refusing to be called
		 */
		function withUntouchablePortal() {
			return proxyquire("../lib/openapi-client.js", {
				"./web-client.js": {
					webAcquireSession: async () => {
						throw new Error("no session may be sought for an appliance already refused");
					},
					webReleaseSession: () => {},
					webGet: async () => {
						throw new Error("the portal must not be read for an appliance already refused");
					},
					webPost: async () => {
						throw new Error("the portal must not be written to for an appliance already refused");
					},
				},
			});
		}

		// Registering and approving both write to the user's account. Doing either for an
		// appliance this instance has already refused to read from is worse than doing nothing,
		// so the whole sequence stops rather than only the poll at the end of it.
		it("registers nothing, approves nothing and asks the appliance nothing", async () => {
			const adapter = makeAdapter({
				config: {
					api_mail: "a@b.c",
					api_pwd: "x",
					openapi_register_automatically: true,
					openapi_auto_approve: true,
				},
				openapiIdentityMismatch: true,
				getStateAsync: async () => null,
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiClient: appliance(() => answers({})),
			});

			await withUntouchablePortal().openapiInit(adapter);

			assert.deepEqual(
				adapter.openapiClient.requests,
				[],
				"not even the identity probe: the answer is already known, and it is the wrong appliance",
			);
			assert.ok(
				adapter.logs.some(([level, msg]) => level === "warn" && /different appliance/.test(msg)),
				"and it says which configuration error it is refusing on",
			);
			assert.deepEqual(adapter.states, [], "no token is written, and no approval verdict either");
			assert.deepEqual(adapter.armed, [], "nor is a configuration error retried on a timer");
		});

		// The second guard, on the path the Admin buttons and the poll's approval both reach.
		// The plant this resolves is written to the user's account, so the refusal has to come
		// before the session is even sought rather than after the portal has been read.
		it("will not seek a session or a plant for it", async () => {
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x" },
				openapiIdentityMismatch: true,
				// Everything else is in place, so the only thing refusing is the mismatch.
				openapiExpectedDeviceId: THIS_APPLIANCE,
				webMasterPlantNumber: 0,
				webMasterPlantSerial: `st_${THIS_APPLIANCE}`,
				webSecondaryPlants: new Map(),
				openapiClient: appliance(() => answers({})),
			});

			const ready = await withUntouchablePortal().openapiPortalReady(adapter);

			assert.equal(ready.ok, false, "a plant resolved against a contradicted identity is not a plant");
			assert.equal(
				ready.retryable,
				false,
				"and the address or the appliance has to be corrected, so asking again changes nothing",
			);
			assert.equal(ready.borrowed, false, "nothing was borrowed, so the caller has nothing to release");
			assert.match(ready.reason, /different appliance/);
			assert.deepEqual(adapter.openapiClient.requests, []);
		});
	});

	describe("openapiPortalReady", () => {
		// The counterpart to the forced probe above: this caller only needs to know which
		// appliance the instance is for, and it is called once per pending cycle. Probing here
		// too would spend a request on a question already answered.
		it("takes the identity it already holds rather than spending a request on it", async () => {
			const portal = proxyquire("../lib/openapi-client.js", {
				"./web-client.js": {
					webAcquireSession: async () => ({ ok: true, borrowed: true }),
					webReleaseSession: () => {},
					webGet: async (_adapter, url) =>
						/getEndkunde/.test(url)
							? { data: { anzahlAnlagen: 1 } }
							: { data: { steuereinheitnummer: `st_${THIS_APPLIANCE}`, produktName: "V3" } },
					webPost: async () => ({ status: 200, data: "" }),
				},
			});
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x" },
				openapiExpectedDeviceId: THIS_APPLIANCE,
				// Nothing configured and no connector state, so the plant is reached by the walk —
				// which is the branch that asks for the identity.
				webMasterPlantNumber: null,
				webMasterPlantSerial: null,
				webSecondaryPlants: new Map(),
				openapiClient: appliance(() => presenting(`S${THIS_APPLIANCE}`)),
			});

			const ready = await portal.openapiPortalReady(adapter);

			assert.equal(ready.ok, true);
			assert.equal(ready.plant, 0, "the plant whose control unit is this appliance");
			assert.equal(ready.verified, true, "and matched against the appliance rather than merely configured");
			assert.deepEqual(
				adapter.openapiClient.requests,
				[],
				"the identity was already held, so no request is spent re-establishing it",
			);
		});
	});

	describe("a registration that keeps failing", () => {
		/**
		 * Drive `n` registration cycles against an appliance that fails the POST.
		 *
		 * @param {string} code - The axios error code the POST fails with
		 * @param {number} cycles - How many cycles to run
		 * @returns {Promise<object>} The adapter, with everything it recorded
		 */
		async function registerAgainst(code, cycles) {
			const adapter = makeAdapter({
				config: { openapi_register_automatically: true },
				// Nothing stored, so each cycle re-enters the registration.
				getStateAsync: async () => null,
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiClient: appliance(() => fails(code)),
			});
			for (let cycle = 0; cycle < cycles; cycle++) {
				await openapi.openapiInit(adapter);
			}
			return adapter;
		}

		// An appliance that is simply switched off produced one error line per cycle — 1440 a day
		// at the default interval, which buries every other connector's diagnostics. Said once,
		// then kept at a level that does not shout.
		it("says so once and keeps counting, rather than once per cycle", async () => {
			const adapter = await registerAgainst("ECONNREFUSED", 3);

			assert.equal(linesAt(adapter, "error").length, 1, "the second and third failures are debug lines");
			assert.deepEqual(
				linesAt(adapter, "warn"),
				[],
				"and a refused connection cannot have minted a portal entry, so there is nothing to warn about",
			);
			assert.equal(
				adapter.logs.filter(([level, msg]) => level === "debug" && /Registration failed again/.test(msg))
					.length,
				2,
				"but they are still recorded",
			);
			assert.equal(
				adapter.openapiTransportFailures,
				3,
				"every failure counts: the backoff is shared with the poll path, which reads this",
			);
			assert.equal(adapter.loggedConditions.has("openapi-register:ECONNREFUSED"), true);
		});

		// The warning sends the user to audit a page in their SENEC account. A connection that was
		// refused or never resolved cannot have minted an entry there, so saying otherwise sends
		// them looking for something that cannot exist — while a timeout or an abort mid-flight
		// really can have been half-delivered, and then the entry is one they must find by hand.
		it("sends the user to the portal only where the request could have arrived", async () => {
			for (const [code, auditable] of [
				["ECONNREFUSED", false],
				["ENOTFOUND", false],
				["EHOSTUNREACH", false],
				["ENETUNREACH", false],
				["EAI_AGAIN", false],
				["ECONNABORTED", true],
				["ETIMEDOUT", true],
			]) {
				const adapter = await registerAgainst(code, 1);
				const warnings = adapter.logs.filter(
					([level, msg]) => level === "warn" && /waiting in the portal/.test(msg),
				);

				assert.equal(linesAt(adapter, "error").length, 1, `${code} is reported once either way`);
				assert.equal(
					warnings.length,
					auditable ? 1 : 0,
					auditable
						? `${code} may have been half-delivered, so the portal has to be audited`
						: `${code} cannot have minted an entry, so there is nothing to audit`,
				);
			}
		});

		// The dedup is per condition, so a failure of a different kind is still reported — and a
		// repeat of the same kind still is not.
		it("reports a failure of a different kind rather than deduplicating it against the first", async () => {
			const adapter = makeAdapter({
				config: { openapi_register_automatically: true },
				getStateAsync: async () => null,
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiClient: appliance(() => fails(adapter.nextCode)),
			});
			adapter.nextCode = "ECONNREFUSED";
			await openapi.openapiInit(adapter);
			await openapi.openapiInit(adapter);
			adapter.nextCode = "ETIMEDOUT";
			await openapi.openapiInit(adapter);

			assert.equal(linesAt(adapter, "error").length, 2, "two kinds of failure, two error lines");
			assert.equal(adapter.openapiTransportFailures, 3);
		});

		// The dedup must not outlive the outage it was deduplicating. Host and appliance tend to
		// boot together, so "unreachable, then registered" is the ordinary startup — and the next
		// outage, months later, has to be reported rather than silently filed against this one.
		it("forgets the failures once a registration succeeds", async () => {
			const adapter = withTokenStore(
				makeAdapter({
					config: { openapi_register_automatically: true, openapi_auto_approve: false },
					openapiExpectedDeviceId: THIS_APPLIANCE,
				}),
			);

			// Cycle one: the appliance is not up yet.
			adapter.openapiClient = appliance(() => fails("ECONNREFUSED"));
			await openapi.openapiInit(adapter);
			assert.equal(adapter.loggedConditions.has("openapi-register:ECONNREFUSED"), true);

			// Cycle two: it answers, and issues the token.
			adapter.openapiClient = appliance((method) =>
				method === "POST" ? { status: 200, data: "minted-token" } : refuses(511),
			);
			await openapi.openapiInit(adapter);

			assert.equal(lastWrite(adapter, "_openapi.token"), "minted-token");
			assert.deepEqual(
				[...adapter.loggedConditions].filter((seen) => seen.startsWith("openapi-register:")),
				[],
				"the next outage is reported rather than deduplicated against the one that is over",
			);
			assert.equal(adapter.openapiTransportFailures, 0, "and the retry is back to its normal length");
		});
	});

	describe("storing and discarding the token", () => {
		// A fresh registration gets a fresh approval budget: the counter is per-process, so a
		// previous registration's exhausted attempts silently applied to this one and the new
		// entry was never approved. The retry bookkeeping goes with it, so the next failure is
		// reported rather than deduplicated against the run that has just ended.
		it("gives a stored token a fresh approval budget and a clean retry record", async () => {
			const adapter = makeAdapter({
				openapiApproveAttempts: 3,
				openapiTransportFailures: 7,
				// One set for the whole instance: every connector records its once-only
				// conditions in it, each under its own key prefix, and a sweep that is not
				// scoped to a prefix makes another connector report a condition twice.
				loggedConditions: new Set([
					"openapi-register:ECONNREFUSED",
					"openapi-register:refused",
					"openapi-approval:pending",
					"openapi-transport:ECONNREFUSED",
					"connect-empty",
				]),
			});

			await openapi.openapiStoreToken(adapter, "fresh-token");

			assert.equal(adapter.openapiApproveAttempts, 0, "the old registration's spent rounds are not this one's");
			assert.equal(adapter.openapiTransportFailures, 0, "and the retry starts at its normal length");
			assert.deepEqual(
				[...adapter.loggedConditions].filter((seen) => seen.startsWith("openapi-register:")),
				[],
				"the next registration failure is reported, not deduplicated against the run that has ended",
			);
			assert.equal(
				adapter.loggedConditions.has("openapi-approval:pending"),
				true,
				"and nothing else is swept up with them",
			);
			assert.equal(adapter.loggedConditions.has("openapi-transport:ECONNREFUSED"), true);
			assert.equal(
				adapter.loggedConditions.has("connect-empty"),
				true,
				"least of all another connector's, which would have it warn a second time about a condition it is already in",
			);
			assert.equal(lastWrite(adapter, "_openapi.token"), "fresh-token");
		});

		// Discarding is the start of a fresh registration too, and nothing else runs on this path
		// when automatic registration is off — so the budget has to come back here as well.
		it("gives the approval budget back when the token is discarded", async () => {
			const adapter = makeAdapter({ openapiApproveAttempts: 3 });

			assert.equal(await openapi.openapiForgetToken(adapter), "none");

			assert.equal(adapter.openapiApproveAttempts, 0, "the registration that follows gets its own rounds");
			assert.equal(lastWrite(adapter, "_openapi.token"), "");
			assert.equal(
				lastWrite(adapter, "_openapi.info.approvalState"),
				"unregistered",
				"the approval state described a token that no longer exists",
			);
		});
	});

	describe("teardown while a registration is under way", () => {
		// A token the appliance really minted and we did not write down is the worst outcome
		// available: the entry is in the user's portal, this instance cannot name it, and the next
		// registration produces a second entry nothing can tell from the first.
		it("still writes down a token minted while the adapter was stopping", async () => {
			const adapter = withTokenStore(
				makeAdapter({
					config: { openapi_register_automatically: true },
					openapiExpectedDeviceId: THIS_APPLIANCE,
				}),
			);
			adapter.openapiClient = appliance((method) => {
				if (method === "POST") {
					// onUnload lands while the appliance is minting the token.
					adapter.unloaded = true;
					return { status: 200, data: "minted-token" };
				}
				return answers({});
			});

			await openapi.openapiInit(adapter);

			assert.equal(
				lastWrite(adapter, "_openapi.token"),
				"minted-token",
				"an unrecorded registration can never be told apart from the next one",
			);
			assert.deepEqual(adapter.armed, [], "and nothing is armed to fire after the instance is gone");
		});

		// A 401 is asked about once more before it is believed, three seconds later. Teardown
		// arriving in that gap must abandon the question: the answer would be written into an
		// adapter that has already closed its connections.
		it("abandons the confirming look when teardown arrives during the wait", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiExpectedDeviceId: THIS_APPLIANCE,
				openapiClient: appliance(() => refuses(401)),
			});

			await withUnloadDuringEveryWait(adapter, () => openapi.openapiPoll(adapter));

			assert.equal(adapter.openapiClient.requests.length, 1, "the second look is not taken");
			assert.deepEqual(adapter.states, [], "and no verdict is written into an adapter that has stopped");
			assert.deepEqual(adapter.armed, []);
		});

		// The approval confirmation is a loop of fourteen waits — over a minute. Without the check
		// at the top of it, teardown was answered by carrying on asking the appliance for another
		// minute, with every answer landing in an adapter that was already gone.
		it("stops confirming an approval when teardown arrives during one of its waits", async () => {
			const portal = proxyquire("../lib/openapi-client.js", {
				"./web-client.js": {
					webAcquireSession: async () => ({ ok: true, borrowed: false }),
					webReleaseSession: () => {},
					webGet: async () => ({ data: [{ tokenValue: STORED_TOKEN, tokenState: "PENDING" }] }),
					webPost: async () => ({ status: 200, data: "" }),
				},
			});
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x", openapi_auto_approve: true },
				getStateAsync: tokenStored(),
				// Matched on this appliance's own control-unit number, so the plant is established
				// without walking the portal.
				openapiExpectedDeviceId: THIS_APPLIANCE,
				webMasterPlantNumber: 0,
				webMasterPlantSerial: `st_${THIS_APPLIANCE}`,
				webSecondaryPlants: new Map(),
				// Still waiting for the appliance to pick the grant up, which is what the loop waits
				// out — and what makes the fourteen attempts reachable.
				openapiClient: appliance(() => refuses(511)),
			});

			await withUnloadDuringEveryWait(adapter, () => portal.openapiInit(adapter));

			assert.equal(
				adapter.openapiClient.requests.length,
				3,
				"the identity probe, the standing check, then exactly one confirming look — not fourteen " +
					"into a stopped adapter",
			);
			assert.ok(
				!("X-Auth-Token" in adapter.openapiClient.requests[0].headers),
				"and the first of those is the unauthenticated probe, whatever identity was already held",
			);
			assert.equal(adapter.openapiApproveAttempts, 1, "the round it did spend still counts");
			assert.deepEqual(adapter.armed, [], "and nothing is armed to fire after the instance is gone");
		});
	});
});
