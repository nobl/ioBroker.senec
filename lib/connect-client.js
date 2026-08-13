"use strict";
// Endpoint (SENEC.Connect):
//   https://apim-eds-gwc-prod.azure-api.net/senec-connect/v1/systems/device-data/general

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names
/** @typedef {import('./types').ConnectSystem} ConnectSystem */ // eslint-disable-line jsdoc/check-tag-names
/** @typedef {import('./types').ConnectNameplate} ConnectNameplate */ // eslint-disable-line jsdoc/check-tag-names

const axios = require("axios");
const { CONNECT_HOST } = require("./constants.js");

/**
 * Section carrying `system_id` / `serial_number`.
 *
 * The state tree is keyed on the system id, so this section is requested even when the user
 * left it out of `connect_include` — without it there is no way to tell the systems of a
 * multi-system account apart, and the API charges per request, not per section.
 */
const IDENTITY_SECTION = "bessNameplate";

/**
 * Build the `include` list actually sent to the API.
 *
 * @param {string} configured - Value of the connect_include config field
 * @returns {string} Comma-separated section list, always containing the identity section
 */
function buildInclude(configured) {
	const wanted = new Set(
		String(configured || "battery,meter")
			.split(",")
			.map((section) => section.trim())
			.filter(Boolean),
	);
	wanted.add(IDENTITY_SECTION);
	return [...wanted].join(",");
}

/**
 * Turn a system identifier into a path segment ioBroker accepts.
 *
 * @param {unknown} raw - Identifier as delivered by the API
 * @returns {string | null} Sanitized segment, or null when nothing usable remains
 */
function sanitizeKey(raw) {
	// Only a string or a number is an identifier. Anything else is a malformed response, and
	// String() would happily turn {} into "object_Object" and hand it on as a valid-looking key
	// that authorises deleting the states of every other system.
	if (typeof raw !== "string" && typeof raw !== "number") {
		return null;
	}
	if (typeof raw === "number" && !Number.isFinite(raw)) {
		return null;
	}
	const key = String(raw)
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^[_-]+|[_-]+$/g, "");
	return key.length > 0 ? key : null;
}

/**
 * Short, stable discriminator for an identifier.
 *
 * Only used to disambiguate two identifiers that sanitize to the same segment. It has to be
 * derived from the raw identifier rather than from the array position: a position-derived
 * suffix swaps between the two systems whenever the response order changes, which is the
 * exact failure this module exists to prevent.
 *
 * @param {string} raw - Identifier as delivered by the API
 * @returns {string} Six lowercase hex characters
 */
function identityDiscriminator(raw) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		hash ^= raw.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * Path segment for one identifier, unique for as long as the identifier is.
 *
 * Sanitizing is lossy — `A.1` and `A*1` both become `A_1` — so two different systems can end
 * up wanting the same segment. Resolving that by handing the plain segment to whichever
 * system happens to come first in the response would put ownership back in the hands of the
 * array order, which is the failure this module exists to prevent. Instead, an identifier
 * that did not survive sanitizing intact carries a discriminator derived from its raw form,
 * so its segment is the same whatever order the response arrives in.
 *
 * @param {string | number | null | undefined} raw - Identifier as delivered by the API
 * @returns {string | null} Stable segment, or null when nothing usable remains
 */
function identitySegment(raw) {
	const sanitized = sanitizeKey(raw);
	if (sanitized === null) {
		return null;
	}
	return sanitized === String(raw).trim() ? sanitized : `${sanitized}-${identityDiscriminator(String(raw))}`;
}

/**
 * Every identifier a system reports, in order of preference.
 *
 * @param {ConnectSystem | null | undefined} system - One entry of the response array
 * @returns {string[]} Stable segments, best first, empty when the entry carries none
 */
function systemIdentities(system) {
	const plate = system?.[IDENTITY_SECTION];
	const candidates = [identitySegment(plate?.system_id), identitySegment(plate?.serial_number)];
	const identities = [];
	for (const candidate of candidates) {
		if (candidate !== null && !identities.includes(candidate)) {
			identities.push(candidate);
		}
	}
	return identities;
}

/**
 * Resolve the path segment for one system of the response array.
 *
 * The API returns the systems of an account as a plain array with no documented ordering,
 * so the array position cannot be used: history, charts and scripts would silently change
 * which appliance they refer to whenever the order changes. Key on the identity instead and
 * only fall back to the position when the response carries none.
 *
 * A system reports more than one identifier and the response does not always carry all of
 * them. Keying strictly on the preferred one would move a system to a new path the first time
 * `system_id` is missing — and, because the key still looks perfectly valid, cleanup would
 * then delete the established path and its recorded history. So an identifier already
 * associated with a known segment always wins over the preference order.
 *
 * @param {ConnectSystem | null | undefined} system - One entry of the response array
 * @param {number} index - Position in the response array
 * @param {Set<string>} used - Segments already handed out for this poll
 * @param {Map<string, string>} aliases - Known identifier -> segment, from earlier polls
 * @returns {{ key: string, identities: string[], fallback: boolean, collided: boolean }} Outcome
 */
function systemKey(system, index, used, aliases) {
	const identities = systemIdentities(system);
	const known = identities.map((identity) => aliases.get(identity)).find((segment) => segment !== undefined);

	// The position fallback deliberately reuses the bare index — the identifier of the former
	// layout. An account that never reports a nameplate then keeps writing exactly where it
	// always did, instead of gaining a second, parallel tree beside the one it already has.
	let key = known || identities[0] || String(index);
	// Two entries claiming the same segment means the account really does report one identifier
	// twice. Nothing can make that stable, so keep them apart by position and say so.
	const collided = used.has(key);
	if (collided) {
		let suffix = 2;
		while (used.has(`${key}-${suffix}`)) {
			suffix++;
		}
		key = `${key}-${suffix}`;
	}
	used.add(key);
	return { key, identities, fallback: identities.length === 0, collided };
}

/**
 * Seed the identifier aliases from the channels already in the object store.
 *
 * Runs once per session, before the first key is derived. Without it a restart would forget
 * which identifiers belong to which segment, and the first response that omits `system_id`
 * would move a system to a new path and retire the old one.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function loadIdentityAliases(adapter) {
	const base = `${adapter.namespace}._connect.Systems.`;
	try {
		const allObjects = await adapter.getAdapterObjectsAsync();
		for (const id in allObjects) {
			if (!id.startsWith(base) || id.slice(base.length).includes(".")) {
				continue; // channels only, not the states below them
			}
			const key = id.slice(base.length);
			const obj = allObjects[id];
			for (const identity of obj?.native?.identities || []) {
				adapter.connectIdentityAliases.set(identity, key);
			}
			if (obj?.common?.name) {
				adapter.connectSystemNames.set(key, String(obj.common.name));
			}
		}
	} catch (err) {
		// Not fatal: without aliases the preference order is used, which is what the previous
		// release did. Say so, because it makes a re-key on a partial response possible.
		adapter.log.warn(`[Connect] ⚠️ Could not read known system identifiers: ${err.message}`);
	}
}

/**
 * Create the channel of a system, keep its name in sync with the reported model, and record
 * every identifier it answers to so a later response missing one of them still resolves here.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} key - Path segment of the system
 * @param {ConnectNameplate | null | undefined} plate - bessNameplate section, when present
 * @param {string[]} identities - Sanitized identifiers this system reported
 * @returns {Promise<void>}
 */
async function ensureSystemChannel(adapter, key, plate, identities) {
	for (const identity of identities) {
		adapter.connectIdentityAliases.set(identity, key);
	}
	const name = plate?.model ? `${plate.model} (${key})` : `System ${key}`;
	const cached = adapter.connectSystemNames.get(key);
	if (cached === name && identities.every((identity) => adapter.connectIdentityAliases.get(identity) === key)) {
		return;
	}
	const id = `_connect.Systems.${key}`;
	const obj = await adapter.getObjectAsync(id);
	if (!obj) {
		await adapter.setObjectNotExistsAsync(id, {
			type: "channel",
			common: { name },
			native: { identities },
		});
	} else {
		const stored = obj.native?.identities || [];
		const missing = identities.filter((identity) => !stored.includes(identity));
		if (obj.common?.name !== name || missing.length > 0) {
			await adapter.extendObject(id, {
				common: { name },
				native: { identities: [...stored, ...missing] },
			});
		}
	}
	adapter.connectSystemNames.set(key, name);
}

/**
 * Delete the states of systems the API no longer reports.
 *
 * Also performs the one-time move off the former position-keyed layout: the legacy
 * `Systems.0` / `Systems.1` channels are simply systems that are no longer reported.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {Set<string>} activeKeys - Path segments written by the current poll
 * @returns {Promise<boolean>} Whether the store now matches the reported systems
 */
async function pruneConnectSystems(adapter, activeKeys) {
	const base = `${adapter.namespace}._connect.Systems.`;

	// The caches exist to keep the poll off the object store, so both have to forget anything
	// that is no longer reported — otherwise a system that comes back is never recreated. This
	// runs before the deletions and regardless of whether there is anything to delete, because
	// a cache entry can outlive its object.
	for (const key of [...adapter.connectSystemNames.keys()]) {
		if (!activeKeys.has(key)) {
			adapter.connectSystemNames.delete(key);
		}
	}
	for (const [identity, key] of [...adapter.connectIdentityAliases.entries()]) {
		if (!activeKeys.has(key)) {
			adapter.connectIdentityAliases.delete(identity);
		}
	}

	let allObjects;
	try {
		allObjects = await adapter.getAdapterObjectsAsync();
	} catch (err) {
		adapter.log.warn(`[Connect] ⚠️ Cleanup of unreported systems failed: ${err.message}`);
		return false;
	}

	const toDelete = [];
	for (const id in allObjects) {
		if (!id.startsWith(base)) {
			continue;
		}
		if (!activeKeys.has(id.slice(base.length).split(".")[0])) {
			toDelete.push(id);
		}
	}
	if (toDelete.length === 0) {
		return true;
	}

	// Deepest first, so a channel goes only after the states below it.
	toDelete.sort((a, b) => b.split(".").length - a.split(".").length);
	const retired = new Set();
	let failed = 0;
	for (const id of toDelete) {
		if (adapter.unloaded) {
			// Shutdown during a long delete run. Stop rather than keep writing to a closing
			// store; the next start reconciles from scratch.
			return false;
		}
		const shortId = id.slice(adapter.namespace.length + 1);
		try {
			await adapter.delObjectAsync(shortId);
			adapter.knownObjects.delete(shortId);
			retired.add(shortId.slice("_connect.Systems.".length).split(".")[0]);
		} catch (err) {
			// One stubborn object must not abandon the rest of the cleanup.
			failed++;
			adapter.log.debug(`[Connect] Could not remove ${shortId}: ${err.message}`);
		}
	}
	adapter.log.info(
		`[Connect] Retired ${retired.size} system(s) no longer reported (${[...retired].join(", ")}), ` +
			`${toDelete.length - failed} object(s) removed`,
	);
	if (failed > 0) {
		adapter.log.warn(`[Connect] ⚠️ ${failed} object(s) could not be removed — retrying on the next poll`);
	}
	return failed === 0;
}

/**
 * Decide whether the poll just finished may delete states, and do so if it may.
 *
 * Pruning is destructive — it takes the recorded history of a system with it — so it runs
 * only when the set of systems is known to be trustworthy and to have actually changed:
 *
 * - a poll that had to fall back to position-derived keys is not evidence that a system
 *   disappeared, only that this one response carried no identity. Pruning on it would wipe
 *   every real system on a single hiccup;
 * - an unchanged key set has nothing to clean up, and enumerating every adapter object on
 *   each poll would put a full object-store scan on the polling interval.
 *
 * The first successful poll of a session reconciles unless one of the gates above applies:
 * that is what retires the channels of the former position-keyed layout.
 *
 * The key set is recorded only once cleanup has actually succeeded. Recording it up front
 * would make a transient object-store failure permanent for the session — the next identical
 * poll would compute "unchanged" and never retry.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {Set<string>} keys - Path segments written by the current poll
 * @param {boolean} anyFallback - Whether any system had to be keyed by its array position
 * @returns {Promise<void>}
 */
async function reconcileSystems(adapter, keys, anyFallback) {
	if (adapter.unloaded) {
		return;
	}
	const previous = adapter.connectKnownKeys;
	const changed = !previous || previous.size !== keys.size || [...keys].some((key) => !previous.has(key));

	if (keys.size === 0) {
		// A legitimate answer for an account with no systems, so it must not delete anything —
		// but it is also what a broken upstream looks like. Log on entry only.
		logOnce(adapter, "empty", "[Connect] ⚠️ Response contained no systems — keeping existing states");
		return;
	}
	if (anyFallback) {
		logOnce(
			adapter,
			"fallback",
			"[Connect] ⚠️ A system was reported without a bessNameplate identity and is stored by its position " +
				"in the response. Its states may move if the response order changes, and unreported systems " +
				"are not cleaned up while this lasts.",
		);
		adapter.connectKnownKeys = keys;
		return;
	}
	logOnce(adapter, "empty", null);
	logOnce(adapter, "fallback", null);
	if (!changed) {
		return;
	}
	if (await pruneConnectSystems(adapter, keys)) {
		adapter.connectKnownKeys = keys;
	}
}

/**
 * Log a message the first time a condition holds, and stay quiet until it clears.
 *
 * These conditions persist for as long as the account or the service stays in that shape —
 * at the default interval an unconditional warn is roughly 288 identical lines a day, which
 * buries everything else in the log.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} condition - Identifier of the condition
 * @param {string | null} message - Message to log, or null to mark the condition cleared
 * @returns {void}
 */
function logOnce(adapter, condition, message) {
	if (message === null) {
		adapter.connectLoggedConditions.delete(condition);
		return;
	}
	if (adapter.connectLoggedConditions.has(condition)) {
		return;
	}
	adapter.connectLoggedConditions.add(condition);
	adapter.log.warn(message);
}

/**
 * Extract the server-provided reason from a failed SENEC.Connect request.
 *
 * The API documents application/problem+json (RFC 7807) bodies for 4xx/5xx, and Azure API
 * Management adds its own { statusCode, message } shape — notably when the monthly request
 * quota is exhausted. Axios reduces all of these to "Request failed with status code NNN",
 * so without this the actual reason is lost.
 *
 * @param {{ response?: { data?: string | Record<string, unknown> | null } }} error - axios error
 * @returns {string} Server-provided detail, or "" when the response carried none
 */
function connectErrorDetail(error) {
	const data = error?.response?.data;
	if (!data) {
		return "";
	}
	if (typeof data === "string") {
		return data.trim().slice(0, 300);
	}
	if (typeof data === "object") {
		// problem+json uses detail/title; Azure APIM uses message
		const detail = data.detail || data.title || data.message;
		return String(detail || JSON.stringify(data)).slice(0, 300);
	}
	return "";
}

/**
 * Polls the SENEC.Connect API for device data.
 * Uses subscription key authentication (Ocp-Apim-Subscription-Key header).
 * All requested data sections are fetched in a single request via the include parameter.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function connectPoll(adapter) {
	if (adapter.unloaded) {
		return;
	}

	const interval = (adapter.config.connect_interval || 300) * 1000;
	const include = buildInclude(adapter.config.connect_include);
	const subscriptionKey = adapter.config.connect_subscription_key;

	if (!subscriptionKey) {
		adapter.log.warn("[Connect] ⚠️ No subscription key configured. Skipping poll.");
		return;
	}

	try {
		const connectLog = adapter.config.connect_showPolling ? "info" : "debug";
		adapter.log[connectLog]("[Connect] 🔄 Polling SENEC.Connect API...");

		const url = `${CONNECT_HOST}/v1/systems/device-data/general?include=${encodeURIComponent(include)}`;
		if (!adapter.connectClient) {
			adapter.connectClient = axios.create({
				timeout: adapter.config.pollingTimeout || 5000,
				headers: {
					"Ocp-Apim-Subscription-Key": subscriptionKey,
				},
			});
		}
		const response = await adapter.connectClient.get(url);

		if (adapter.config.connect_reqnresp_log) {
			adapter.log.debug(`[Connect] SENEC.Connect response: ${JSON.stringify(response?.data).slice(0, 1000)}`);
		}
		if (response?.data && Array.isArray(response.data)) {
			// The request was in flight while the adapter was told to stop. Everything below
			// writes to — and deletes from — the object store, so stop here rather than during
			// teardown; the next start reconciles from scratch.
			if (adapter.unloaded) {
				return;
			}
			if (adapter.connectKnownKeys === null) {
				await loadIdentityAliases(adapter);
			}
			const keys = new Set();
			let anyFallback = false;
			for (let i = 0; i < response.data.length; i++) {
				const system = response.data[i];
				if (system === null || typeof system !== "object") {
					// evalPoll would throw on a non-object and abandon the remaining systems.
					adapter.log.warn(`[Connect] ⚠️ Ignoring malformed entry at position ${i} of the response`);
					continue;
				}
				const { key, identities, fallback, collided } = systemKey(
					system,
					i,
					keys,
					adapter.connectIdentityAliases,
				);
				anyFallback = anyFallback || fallback;
				if (collided) {
					adapter.log.warn(
						`[Connect] ⚠️ Two systems share the identifier "${identities[0]}" once made path-safe; ` +
							`storing this one as "${key}"`,
					);
				}
				try {
					await ensureSystemChannel(adapter, key, system[IDENTITY_SECTION], identities);
				} catch (err) {
					// An object-store hiccup is not a connection failure. Keep the poll going:
					// the states below still write, and the channel is retried next time.
					adapter.log.warn(`[Connect] ⚠️ Could not update the channel of system ${key}: ${err.message}`);
					adapter.connectSystemNames.delete(key);
				}
				await adapter.evalPoll(system, `_connect.Systems.${key}.`);
			}
			await adapter.doState(
				"_connect.info.lastPoll",
				new Date().toISOString(),
				"Last successful SENEC.Connect poll",
				"",
				false,
			);
			await adapter.doState(
				"_connect.info.systemCount",
				keys.size,
				"Systems reported by SENEC.Connect",
				"",
				false,
			);
			await reconcileSystems(adapter, keys, anyFallback);
			adapter.log[connectLog](`[Connect] Polled ${keys.size} system(s)`);
			if (!adapter.connectConnected) {
				adapter.connectConnected = true;
				await adapter.updateConnectionStatus();
			}
		} else {
			adapter.log.warn(
				`[Connect] ⚠️ Unexpected response format: ${JSON.stringify(response?.data).slice(0, 200)}`,
			);
		}
	} catch (error) {
		adapter.logError(error, "[Connect] ❌ poll failed");
		const detail = connectErrorDetail(error);
		if (detail) {
			adapter.log.warn(`[Connect] ⚠️ Server response: ${detail}`);
		}
		if (adapter.connectConnected) {
			adapter.connectConnected = false;
			await adapter.updateConnectionStatus();
		}
	}

	if (!adapter.unloaded) {
		adapter.setTimeout(() => {
			connectPoll(adapter).catch((e) => adapter.logError(e, "[Connect] ❌ scheduled poll failed"));
		}, interval);
		adapter.log[adapter.config.connect_showPolling ? "info" : "debug"](
			`[Connect] ⏱ Next SENEC.Connect poll scheduled in ${(interval / 1000).toFixed(0)}s`,
		);
	}
}

module.exports = {
	connectPoll,
	buildInclude,
	sanitizeKey,
	systemKey,
};
