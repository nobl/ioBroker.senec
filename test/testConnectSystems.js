"use strict";

/**
 * SENEC.Connect stores one entry per system of the account, and the API returns them as a
 * plain array with no documented ordering. Keying the state tree on the array position means
 * history, charts and scripts bind to a slot rather than to an appliance: whenever the order
 * changes, the readings of two systems swap over inside the same history series and nothing
 * about the values themselves says so.
 *
 * These tests pin the identity-keyed layout and, more importantly, the two gates that keep
 * its cleanup from eating states it should not:
 *
 * - a response that carries no bessNameplate degrades every key to a position, which must
 *   never be read as "the identified systems disappeared";
 * - an unchanged set of systems must not enumerate the whole object store on every poll.
 */

const assert = require("node:assert/strict");
const { connectPoll, buildInclude, sanitizeKey, systemKey } = require("../lib/connect-client.js");

/** Response of the two-system account from marq24/ha-senec-v3#233, serials shortened. */
const TWO_SYSTEMS = [
	{
		battery: { state: 0, state_of_charge: 1, power: 0.0 },
		bessNameplate: {
			manufacturer: "SENEC GmbH",
			model: "SENEC.Home 4 hybrid / 11.8",
			serial_number: "v4-111",
			system_id: "S4H1-111",
			design_capacity: 2940,
		},
		meter: { grid_power: 439.45312, consumption: 439.45312, production: 0.0 },
		evse: [{ id: "wb-1", ev_connected: true, ev_charging: true, charging_power: 6900.0 }],
	},
	{
		battery: { state: 0, state_of_charge: 5, power: 1142.5781, voltage: 234.0, current: 4.6 },
		bessNameplate: {
			manufacturer: "SENEC GmbH",
			model: "SENEC.Home P4 hybrid / 11.8",
			serial_number: "v4-222",
			system_id: "P4H1-222",
			design_capacity: 7100,
		},
		meter: { grid_power: 14.6484375, consumption: 410.15625, production: 1523.4375 },
		evse: [{ id: "wb-2", ev_connected: false, ev_charging: false, charging_power: 0.0 }],
	},
];

/**
 * Build an adapter with the object store and the HTTP layer faked out.
 *
 * @param {object} [options] - Test setup
 * @param {Record<string, object>} [options.objects] - Objects the store starts out with
 * @returns {object} Adapter instance with recorders
 */
function makeAdapter({ objects = {} } = {}) {
	const adapter = {
		namespace: "senec.0",
		unloaded: false,
		config: { connect_subscription_key: "key", connect_interval: 300 },
		connectSystemNames: new Map(),
		connectKnownKeys: null,
		connectIdentityAliases: new Map(),
		connectLoggedConditions: new Set(),
		knownObjects: new Map(),
		connectConnected: false,

		objects: { ...objects },
		polled: [],
		states: [],
		deleted: [],
		urls: [],
		warnings: [],
		objectScans: 0,

		log: {
			info() {},
			debug() {},
			silly() {},
			error() {},
			warn(msg) {
				adapter.warnings.push(msg);
			},
		},
		logError() {},
		setTimeout() {},
		updateConnectionStatus: async () => {},

		evalPoll: async (obj, pfx) => {
			adapter.polled.push([pfx, obj]);
		},
		doState: async (id, value) => {
			adapter.states.push([id, value]);
		},
		getObjectAsync: async (id) => adapter.objects[id] || null,
		setObjectNotExistsAsync: async (id, obj) => {
			adapter.objects[id] = adapter.objects[id] || obj;
		},
		extendObject: async (id, obj) => {
			adapter.objects[id] = { ...adapter.objects[id], ...obj };
		},
		getAdapterObjectsAsync: async () => {
			adapter.objectScans++;
			const out = {};
			for (const id in adapter.objects) {
				out[`${adapter.namespace}.${id}`] = adapter.objects[id];
			}
			return out;
		},
		delObjectAsync: async (id) => {
			adapter.deleted.push(id);
			delete adapter.objects[id];
		},
	};
	return adapter;
}

/**
 * Answer the next polls with the given payloads, in order.
 *
 * @param {object} adapter - Adapter from makeAdapter
 * @param {Array<unknown>} responses - One response body per poll
 */
function respondWith(adapter, responses) {
	let call = 0;
	adapter.connectClient = {
		get: async (url) => {
			adapter.urls.push(url);
			return { data: responses[Math.min(call++, responses.length - 1)] };
		},
	};
}

/**
 * Prefixes handed to evalPoll by the most recent poll.
 *
 * @param {object} adapter - Adapter from makeAdapter
 * @returns {string[]} Prefixes, in call order
 */
function prefixes(adapter) {
	return adapter.polled.map(([pfx]) => pfx);
}

describe("SENEC.Connect: multiple systems", () => {
	describe("buildInclude", () => {
		it("always requests the identity section", () => {
			assert.equal(buildInclude("battery,meter"), "battery,meter,bessNameplate");
		});

		it("keeps a configured list untouched when it already asks for it", () => {
			assert.equal(buildInclude("battery,meter,evse,bessNameplate"), "battery,meter,evse,bessNameplate");
		});

		it("tolerates padding and empty entries", () => {
			assert.equal(buildInclude(" battery , , meter "), "battery,meter,bessNameplate");
		});

		it("falls back to the same default the admin field offers", () => {
			// These had diverged: clearing the field in Admin silently dropped evse instead of
			// restoring the documented default.
			assert.equal(buildInclude(""), "battery,meter,evse,bessNameplate");
			assert.equal(buildInclude(undefined), "battery,meter,evse,bessNameplate");
		});
	});

	describe("sanitizeKey", () => {
		it("keeps identifiers that are already path-safe", () => {
			assert.equal(sanitizeKey("P4H1-222"), "P4H1-222");
		});

		it("replaces characters that would split or break the path", () => {
			assert.equal(sanitizeKey("S4H1.222"), "S4H1_222");
			assert.equal(sanitizeKey("a b*c"), "a_b_c");
		});

		it("reports nothing usable rather than an empty segment", () => {
			assert.equal(sanitizeKey(""), null);
			assert.equal(sanitizeKey("   "), null);
			assert.equal(sanitizeKey("***"), null);
			assert.equal(sanitizeKey(null), null);
			assert.equal(sanitizeKey(undefined), null);
		});
	});

	describe("systemKey", () => {
		const noAliases = () => new Map();

		it("prefers the system id", () => {
			const result = systemKey(TWO_SYSTEMS[1], 0, new Set(), noAliases());
			assert.equal(result.key, "P4H1-222");
			assert.equal(result.fallback, false);
			assert.deepEqual(result.identities, ["P4H1-222", "v4-222"]);
		});

		it("falls back to the serial number when no system id is reported", () => {
			const result = systemKey({ bessNameplate: { serial_number: "v4-222" } }, 3, new Set(), noAliases());
			assert.equal(result.key, "v4-222");
			assert.equal(result.fallback, false);
		});

		it("keeps a system on its established path when a response drops the preferred id", () => {
			// The identity that is still present is already associated with the segment, so it
			// wins over the preference order. Without this, one incomplete response re-keys the
			// system and the cleanup then deletes its recorded history.
			const aliases = new Map([
				["P4H1-222", "P4H1-222"],
				["v4-222", "P4H1-222"],
			]);
			const degraded = { bessNameplate: { serial_number: "v4-222" } };
			assert.equal(systemKey(degraded, 0, new Set(), aliases).key, "P4H1-222");
		});

		it("keeps a system on its established path when a response adds an id it never sent before", () => {
			const aliases = new Map([["v4-222", "v4-222"]]);
			const upgraded = { bessNameplate: { system_id: "P4H1-222", serial_number: "v4-222" } };
			assert.equal(systemKey(upgraded, 0, new Set(), aliases).key, "v4-222");
		});

		it("uses the bare index when the entry carries no identity, matching the former layout", () => {
			// Deliberately the old identifier: an account that never reports a nameplate keeps
			// writing exactly where it always did instead of growing a second parallel tree.
			assert.deepEqual(systemKey({ battery: {} }, 2, new Set(), noAliases()), {
				key: "2",
				identities: [],
				fallback: true,
				collided: false,
			});
			assert.equal(systemKey(null, 0, new Set(), noAliases()).key, "0");
		});

		it("gives ids that sanitize alike stable paths regardless of the response order", () => {
			// "A.1" and "A*1" both sanitize to "A_1". Resolving that by giving the plain segment
			// to whichever arrived first would hand ownership back to the array order — the very
			// thing this module exists to prevent — so each carries a discriminator from its raw
			// form and neither depends on position.
			const forward = new Set();
			const a1 = systemKey({ bessNameplate: { system_id: "A.1" } }, 0, forward, noAliases());
			const b1 = systemKey({ bessNameplate: { system_id: "A*1" } }, 1, forward, noAliases());

			const reversed = new Set();
			const b2 = systemKey({ bessNameplate: { system_id: "A*1" } }, 0, reversed, noAliases());
			const a2 = systemKey({ bessNameplate: { system_id: "A.1" } }, 1, reversed, noAliases());

			assert.notEqual(a1.key, b1.key, "the two systems get separate paths");
			assert.equal(a1.key, a2.key, "A.1 keeps its path when the response order reverses");
			assert.equal(b1.key, b2.key, "A*1 keeps its path when the response order reverses");
			assert.equal(a1.collided, false, "a lossy id is not a collision — it is disambiguated up front");
		});

		it("leaves a path-safe identifier untouched", () => {
			// The discriminator must not appear on ordinary ids, or every real path gains noise.
			assert.equal(systemKey(TWO_SYSTEMS[0], 0, new Set(), noAliases()).key, "S4H1-111");
		});

		it("reports a genuine duplicate identifier rather than merging the systems", () => {
			const used = new Set();
			const first = systemKey({ bessNameplate: { system_id: "DUP" } }, 0, used, noAliases());
			const second = systemKey({ bessNameplate: { system_id: "DUP" } }, 1, used, noAliases());
			assert.equal(first.key, "DUP");
			assert.equal(second.key, "DUP-2");
			assert.equal(second.collided, true, "the duplicate is surfaced so it can be logged");
		});
	});

	describe("polling", () => {
		it("stores every reported system under its own identity", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.deepEqual(prefixes(adapter), ["_connect.Systems.S4H1-111.", "_connect.Systems.P4H1-222."]);
			assert.ok(
				adapter.states.some(([id, val]) => id === "_connect.info.systemCount" && val === 2),
				"the number of systems is published",
			);
		});

		it("names the channel of a system after its model", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.equal(
				adapter.objects["_connect.Systems.P4H1-222"].common.name,
				"SENEC.Home P4 hybrid / 11.8 (P4H1-222)",
			);
		});

		it("requests the identity section even when the user left it out", async () => {
			const adapter = makeAdapter();
			adapter.config.connect_include = "battery,meter";
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.match(adapter.urls[0], /include=battery%2Cmeter%2CbessNameplate/);
		});

		it("keeps a system on its own path when the response order changes", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS, [TWO_SYSTEMS[1], TWO_SYSTEMS[0]]]);

			await connectPoll(adapter);
			adapter.polled = [];
			await connectPoll(adapter);

			// Reversed response, so the prefixes arrive reversed — but the P4 keeps its own path,
			// which is the whole point: no history series changes owner.
			assert.deepEqual(prefixes(adapter), ["_connect.Systems.P4H1-222.", "_connect.Systems.S4H1-111."]);
			assert.deepEqual(adapter.deleted, [], "a reorder is not a change of the system set");
		});
	});

	describe("cleanup", () => {
		it("retires the channels of the former position-keyed layout", async () => {
			const adapter = makeAdapter({
				objects: {
					"_connect.Systems.0": { type: "channel" },
					"_connect.Systems.0.battery.power": { type: "state" },
					"_connect.Systems.1": { type: "channel" },
					"_connect.Systems.1.battery.power": { type: "state" },
				},
			});
			adapter.knownObjects.set("_connect.Systems.0.battery.power", { type: "state" });
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted.sort(), [
				"_connect.Systems.0",
				"_connect.Systems.0.battery.power",
				"_connect.Systems.1",
				"_connect.Systems.1.battery.power",
			]);
			assert.equal(
				adapter.knownObjects.has("_connect.Systems.0.battery.power"),
				false,
				"a deleted object must leave the object cache too, or it is never recreated",
			);
		});

		it("deletes the states below a channel before the channel itself", async () => {
			const adapter = makeAdapter({
				objects: {
					"_connect.Systems.0": { type: "channel" },
					"_connect.Systems.0.battery.power": { type: "state" },
				},
			});
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.ok(
				adapter.deleted.indexOf("_connect.Systems.0.battery.power") <
					adapter.deleted.indexOf("_connect.Systems.0"),
				"a channel must not be removed while its states are still there",
			);
		});

		it("removes a system that left the account", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS, [TWO_SYSTEMS[1]]]);

			await connectPoll(adapter);
			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted, ["_connect.Systems.S4H1-111"]);
			assert.ok(adapter.objects["_connect.Systems.P4H1-222"], "the remaining system is untouched");
		});

		it("recreates the channel of a system that comes back", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS, [TWO_SYSTEMS[1]], TWO_SYSTEMS]);

			await connectPoll(adapter); // both systems
			await connectPoll(adapter); // one drops out and is cleaned up
			await connectPoll(adapter); // and returns

			assert.equal(
				adapter.objects["_connect.Systems.S4H1-111"]?.common?.name,
				"SENEC.Home 4 hybrid / 11.8 (S4H1-111)",
				"the channel-name cache must not outlive the channel it describes",
			);
		});

		it("keeps every system when one response carries no identity", async () => {
			const adapter = makeAdapter();
			const withoutIdentity = [{ battery: { state_of_charge: 1 } }, { battery: { state_of_charge: 5 } }];
			respondWith(adapter, [TWO_SYSTEMS, withoutIdentity]);

			await connectPoll(adapter);
			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted, [], "one response without nameplates is not a removal");
			assert.ok(
				adapter.warnings.some((msg) => msg.includes("bessNameplate")),
				"the degraded keying is reported",
			);
		});

		it("keeps every system when a response reports none at all", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS, []]);

			await connectPoll(adapter);
			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted, []);
		});

		it("does not enumerate the object store while the systems stay the same", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS]);
			// The first poll of a session scans twice: once to learn which identifiers the
			// existing channels answer to, once to reconcile. After that, an unchanged set of
			// systems must not put a full object-store scan on the polling interval.

			await connectPoll(adapter);
			const afterFirst = adapter.objectScans;
			await connectPoll(adapter);
			await connectPoll(adapter);

			assert.equal(afterFirst, 2, "the first poll of a session learns the identifiers, then reconciles");
			assert.equal(adapter.objectScans, 2, "later polls with an unchanged set do not scan at all");
		});

		it("survives an object store that refuses to answer", async () => {
			const adapter = makeAdapter();
			adapter.getAdapterObjectsAsync = async () => {
				throw new Error("db down");
			};
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.equal(adapter.connectConnected, true, "a failed cleanup does not fail the poll");
			assert.ok(adapter.warnings.some((msg) => msg.includes("db down")));
		});

		it("retries the cleanup on the next poll after the object store failed", async () => {
			// Recording the key set before the cleanup succeeded would make one transient
			// failure permanent for the session: the next identical poll computes "unchanged"
			// and never tries again, so the migration silently never happens.
			const adapter = makeAdapter({
				objects: {
					"_connect.Systems.0": { type: "channel" },
					"_connect.Systems.0.battery.power": { type: "state" },
				},
			});
			const realScan = adapter.getAdapterObjectsAsync;
			let failures = 2; // the alias load and the first reconcile
			adapter.getAdapterObjectsAsync = async () => {
				if (failures-- > 0) {
					throw new Error("db down");
				}
				return realScan();
			};
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);
			assert.deepEqual(adapter.deleted, [], "nothing is deleted while the store is unavailable");

			await connectPoll(adapter);
			assert.deepEqual(
				adapter.deleted.sort(),
				["_connect.Systems.0", "_connect.Systems.0.battery.power"],
				"the legacy tree is retired once the store answers again",
			);
		});

		it("keeps cleaning up when one object cannot be deleted", async () => {
			const adapter = makeAdapter({
				objects: {
					"_connect.Systems.0": { type: "channel" },
					"_connect.Systems.0.battery.power": { type: "state" },
					"_connect.Systems.1": { type: "channel" },
				},
			});
			adapter.delObjectAsync = async (id) => {
				if (id === "_connect.Systems.0.battery.power") {
					throw new Error("locked");
				}
				adapter.deleted.push(id);
				delete adapter.objects[id];
			};
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.deepEqual(
				adapter.deleted.sort(),
				["_connect.Systems.0", "_connect.Systems.1"],
				"one stubborn object does not abandon the rest of the cleanup",
			);
		});

		it("writes and deletes nothing when the adapter unloads while the request is in flight", async () => {
			// onUnload returns without awaiting in-flight work and the Connect client carries no
			// abort signal, so the response can arrive during teardown. Creating channels then is
			// untidy; deleting the legacy tree then is destructive.
			const adapter = makeAdapter({
				objects: { "_connect.Systems.0": { type: "channel" } },
			});
			adapter.connectClient = {
				get: async () => {
					adapter.unloaded = true; // the instance is stopped while we wait
					return { data: TWO_SYSTEMS };
				},
			};

			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted, [], "no object is deleted during shutdown");
			assert.deepEqual(adapter.polled, [], "no state is written during shutdown");
			assert.ok(adapter.objects["_connect.Systems.0"], "the legacy tree survives to the next start");
		});

		it("skips a malformed entry instead of losing the rest of the response", async () => {
			// evalPoll does Object.entries(entry), which throws on null and yields one state per
			// character on a string. Either way the systems after it would be lost.
			const adapter = makeAdapter();
			respondWith(adapter, [[TWO_SYSTEMS[0], null, TWO_SYSTEMS[1]]]);

			await connectPoll(adapter);

			assert.deepEqual(prefixes(adapter), ["_connect.Systems.S4H1-111.", "_connect.Systems.P4H1-222."]);
			assert.equal(adapter.connectConnected, true, "one bad entry is not a connection failure");
			assert.ok(adapter.warnings.some((msg) => msg.includes("malformed entry at position 1")));
		});

		it("keeps polling when a channel cannot be written", async () => {
			// An objects-DB hiccup is not a cloud outage and must not be reported as one.
			const adapter = makeAdapter();
			adapter.setObjectNotExistsAsync = async () => {
				throw new Error("store busy");
			};
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			assert.equal(adapter.polled.length, 2, "both systems still have their states written");
			assert.equal(adapter.connectConnected, true, "the connector is not reported as disconnected");
		});

		it("reports a persistent degraded condition once rather than on every poll", async () => {
			const adapter = makeAdapter();
			const noIdentity = [{ battery: { state_of_charge: 1 } }];
			respondWith(adapter, [noIdentity]);

			await connectPoll(adapter);
			await connectPoll(adapter);
			await connectPoll(adapter);

			const warned = adapter.warnings.filter((msg) => msg.includes("bessNameplate"));
			assert.equal(warned.length, 1, "a condition that lasts for days must not log on every poll");
		});

		it("keeps an identity-less account on the paths it already used", async () => {
			// The position fallback is the bare index on purpose: an account that never reports a
			// nameplate keeps writing where it always did, rather than growing a second tree
			// beside the legacy one that can then never be cleaned up.
			const adapter = makeAdapter({
				objects: { "_connect.Systems.0": { type: "channel" } },
			});
			respondWith(adapter, [[{ battery: { state_of_charge: 1 } }]]);

			await connectPoll(adapter);

			assert.deepEqual(prefixes(adapter), ["_connect.Systems.0."]);
			assert.deepEqual(adapter.deleted, [], "and nothing is retired while the identity is missing");
		});
	});

	describe("wallboxes", () => {
		it("stores each wallbox under its own id rather than its position", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [TWO_SYSTEMS]);

			await connectPoll(adapter);

			const [, first] = adapter.polled[0];
			assert.deepEqual(Object.keys(first.evse), ["wb-1"], "the array became an object keyed by wallbox id");
			assert.equal(first.evse["wb-1"].charging_power, 6900);
		});

		it("keeps a wallbox on its own path when the response order changes", async () => {
			const twoBoxes = (order) => [
				{
					...TWO_SYSTEMS[1],
					evse: order.map((id) => ({ id, ev_connected: id === "wb-a", charging_power: 0 })),
				},
			];
			const adapter = makeAdapter();
			respondWith(adapter, [twoBoxes(["wb-a", "wb-b"]), twoBoxes(["wb-b", "wb-a"])]);

			await connectPoll(adapter);
			adapter.polled = [];
			await connectPoll(adapter);

			const [, system] = adapter.polled[0];
			assert.deepEqual(Object.keys(system.evse).sort(), ["wb-a", "wb-b"]);
			assert.equal(system.evse["wb-a"].ev_connected, true, "wb-a keeps its own states after the reorder");
			assert.deepEqual(adapter.deleted, [], "a reorder is not a removal");
		});

		it("retires a wallbox that leaves the array", async () => {
			// Without this its states stay behind at their last values, indistinguishable from a
			// wallbox that is simply idle.
			const withBoxes = (ids) => [{ ...TWO_SYSTEMS[1], evse: ids.map((id) => ({ id, charging_power: 0 })) }];
			const adapter = makeAdapter({
				objects: {
					"_connect.Systems.P4H1-222.evse.wb-b.charging_power": { type: "state" },
				},
			});
			respondWith(adapter, [withBoxes(["wb-a", "wb-b"]), withBoxes(["wb-a"])]);

			await connectPoll(adapter);
			await connectPoll(adapter);

			assert.deepEqual(adapter.deleted, ["_connect.Systems.P4H1-222.evse.wb-b.charging_power"]);
		});

		it("falls back to the position for a wallbox that reports no id", async () => {
			const adapter = makeAdapter();
			respondWith(adapter, [[{ ...TWO_SYSTEMS[1], evse: [{ charging_power: 0 }] }]]);

			await connectPoll(adapter);

			const [, system] = adapter.polled[0];
			assert.deepEqual(Object.keys(system.evse), ["0"]);
		});
	});

	describe("connection state", () => {
		it("reports the connector as down when a 200 carries something other than the systems array", async () => {
			// A captive portal or an APIM fault object served with HTTP 200 would otherwise leave
			// the connector reporting "connected" forever while nothing is ingested.
			const adapter = makeAdapter();
			adapter.connectConnected = true;
			respondWith(adapter, [{ statusCode: 403, message: "quota exceeded" }]);

			await connectPoll(adapter);

			assert.equal(adapter.connectConnected, false);
		});
	});

	describe("identity changes", () => {
		it("does not re-key a system when a response omits its system id", async () => {
			// The single most destructive failure the review found: the key silently becomes the
			// serial, the fallback gate does not fire because the key still looks valid, and the
			// established tree is deleted along with its recorded history.
			const degraded = [{ ...TWO_SYSTEMS[1], bessNameplate: { serial_number: "v4-222", model: "P4" } }];
			const adapter = makeAdapter();
			respondWith(adapter, [[TWO_SYSTEMS[1]], degraded]);

			await connectPoll(adapter);
			adapter.polled = [];
			await connectPoll(adapter);

			assert.deepEqual(prefixes(adapter), ["_connect.Systems.P4H1-222."], "the system keeps its path");
			assert.deepEqual(adapter.deleted, [], "and its states are not deleted");
		});

		it("recovers the identifiers of known systems after a restart", async () => {
			const first = makeAdapter();
			respondWith(first, [[TWO_SYSTEMS[1]]]);
			await connectPoll(first);

			// A new session: the caches are empty, only the object store remembers.
			const restarted = makeAdapter({ objects: first.objects });
			const degraded = [{ ...TWO_SYSTEMS[1], bessNameplate: { serial_number: "v4-222", model: "P4" } }];
			respondWith(restarted, [degraded]);

			await connectPoll(restarted);

			assert.deepEqual(prefixes(restarted), ["_connect.Systems.P4H1-222."]);
			assert.deepEqual(restarted.deleted, []);
		});
	});
});
