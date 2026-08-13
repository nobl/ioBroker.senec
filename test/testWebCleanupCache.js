"use strict";

/**
 * `doState` keeps a cache of every object it has already seen (`knownObjects`) and skips
 * `setObjectNotExistsAsync` for anything in it. Deleting an object therefore has to evict it
 * from that cache, or the next write recreates the *state* while its *object* stays gone —
 * leaving a value with no name, unit or role.
 *
 * Two of the three cleanup routines were safe only by accident: `cleanupExternalStates` and
 * `webStartupCleanup` run from `onReady`, when the cache is still empty. `webCleanupStates`
 * is the one called at runtime, from the measurement day-rollover path, which deletes the
 * previous day's detail states and rewrites the same ids in the same poll.
 */

const assert = require("node:assert/strict");
const { webCleanupStates } = require("../lib/web-client.js");

/**
 * Adapter with the object store and the object cache faked out.
 *
 * @param {string[]} ids - Relative ids that already exist and have been written via doState
 * @returns {object} Adapter instance with recorders
 */
function makeAdapter(ids) {
	const adapter = {
		namespace: "senec.0",
		knownObjects: new Map(ids.map((id) => [id, { type: "state", common: {} }])),
		objects: Object.fromEntries(ids.map((id) => [`senec.0.${id}`, { type: "state", common: {} }])),
		deleted: [],
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		getAdapterObjectsAsync: async () => ({ ...adapter.objects }),
		delObjectAsync: async (id) => {
			adapter.deleted.push(id);
			delete adapter.objects[id];
		},
	};
	return adapter;
}

describe("mein-senec.de: cleanup and the object cache", () => {
	it("evicts deleted objects from the object cache", async () => {
		const adapter = makeAdapter([
			"_meinsenec.measurements.today.pv.detail.08:00",
			"_meinsenec.measurements.today.pv.detail.08:15",
			"_meinsenec.measurements.today.pv.daily",
		]);

		const count = await webCleanupStates(adapter, "_meinsenec.measurements.today.pv.detail.", "today pv detail");

		assert.equal(count, 2);
		assert.equal(
			adapter.knownObjects.has("_meinsenec.measurements.today.pv.detail.08:00"),
			false,
			"a deleted object must not stay in the cache, or doState never recreates it",
		);
		assert.equal(
			adapter.knownObjects.has("_meinsenec.measurements.today.pv.detail.08:15"),
			false,
			"a deleted object must not stay in the cache, or doState never recreates it",
		);
		assert.equal(
			adapter.knownObjects.has("_meinsenec.measurements.today.pv.daily"),
			true,
			"an object outside the prefix is left alone",
		);
	});

	it("leaves the cache alone for objects it could not delete", async () => {
		const adapter = makeAdapter(["_meinsenec.diagnostics.queue.total"]);
		adapter.delObjectAsync = async () => {
			throw new Error("locked");
		};

		const count = await webCleanupStates(adapter, "_meinsenec.diagnostics.queue.", "web queue diagnostics");

		assert.equal(count, 0);
		assert.equal(
			adapter.knownObjects.has("_meinsenec.diagnostics.queue.total"),
			true,
			"the object still exists, so the cache entry is still correct",
		);
	});
});
