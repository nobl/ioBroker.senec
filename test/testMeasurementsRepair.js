"use strict";

/**
 * Regression test for the one-shot repair of damaged yearly/monthly measurement buckets.
 *
 * Two independent bugs wrote bad data under `Yearly.*`:
 *   - doSumMeasurements used to bucket the `.monthly.` breakdown with UTC getters while the
 *     cloud's bucket-start timestamps denote local month boundaries, shifting every stored
 *     month by the local UTC offset.
 *   - doMeasurementsYear briefly built its resolution=YEAR request window from local dates;
 *     the endpoint anchors that resolution to the UTC year start, so every year's total
 *     collapsed onto the current year's total.
 *
 * Fixing both does not repair data already written under the wrong month/year, and
 * doMeasurementsYear skips a past year whose lastUpdated already falls in the current calendar
 * year — so already-wrong years would not re-poll until next January. repairMeasurementsOnce
 * clears the stored year and monthly markers exactly once per Anlage, forcing one re-poll,
 * without touching the `AllTime.*` state values themselves (they are derived from the per-year
 * data these markers gate, and recompute once the year re-polls).
 */

const assert = require("node:assert/strict");

const measurements = require("../lib/measurements");

/**
 * Builds a fake adapter backed by an in-memory state store, sufficient to drive
 * repairMeasurementsOnce: getStateAsync/getStatesAsync/delStateAsync/delObjectAsync/doState.
 *
 * @param {Record<string, unknown>} initialStates - Seed state id -> value map
 * @returns {object} Fake adapter
 */
function makeAdapter(initialStates) {
	const store = new Map(Object.entries(initialStates));

	/**
	 * Converts an ioBroker-style "*" glob pattern into a RegExp.
	 *
	 * @param {string} pattern - Glob pattern
	 * @returns {RegExp} Matching regular expression
	 */
	function globToRegExp(pattern) {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		return new RegExp(`^${escaped}$`);
	}

	return {
		log: { info() {}, debug() {}, silly() {} },
		rebuildRunning: false,
		rebuildCompletedSteps: new Set(),
		apiWallboxUuids: [],
		store,
		async getStateAsync(id) {
			return store.has(id) ? { val: store.get(id) } : null;
		},
		async getStatesAsync(pattern) {
			const re = globToRegExp(pattern);
			const result = {};
			for (const id of store.keys()) {
				if (re.test(id)) {
					result[id] = { val: store.get(id) };
				}
			}
			return result;
		},
		async delStateAsync(id) {
			store.delete(id);
		},
		async delObjectAsync() {
			// Objects are not modeled separately in this fake; deleting the state is enough
			// for the test to observe that the marker is gone.
		},
		async doState(id, value) {
			store.set(id, value);
		},
	};
}

const PFX = "_api.Anlagen.123.Measurements.";

describe("repairMeasurementsOnce", () => {
	it("clears year and monthly markers, leaves AllTime values alone, and sets the marker", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${PFX}Yearly.2026.monthly._rebuildDone`]: true,
			[`${PFX}Yearly.2025.monthly.last updated`]: "2025-06-01T00:00:00.000Z",
			// Year-total markers are now cleared too — this is the new behaviour under test.
			[`${PFX}Yearly.2026.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${PFX}Yearly.2026._rebuildDone`]: true,
			[`${PFX}Yearly.2025.last updated`]: "2025-07-01T00:00:00.000Z",
			// AllTime values are damaged by the same bug but must be left untouched here —
			// they self-correct once the year re-polls, not via this repair.
			[`${PFX}AllTime.valueStore`]: '{"POWER_CONSUMPTION":{"2025":12227.89,"2026":12227.99}}',
			[`${PFX}AllTime.POWER_CONSUMPTION`]: 24455.88,
		});
		adapter.apiWallboxUuids = ["wb-uuid-0"];
		adapter.store.set("_api.Anlagen.123.WallboxMeasurements.0.Yearly.2026.monthly.last updated", "x");
		adapter.store.set("_api.Anlagen.123.WallboxMeasurements.0.Yearly.2026.last updated", "x");
		adapter.rebuildCompletedSteps = new Set([
			"123:2025:monthly",
			"123:2025:monthly.wb0",
			"123:2025:year",
			"123:2025:year.wb0",
			"999:2025:monthly", // different Anlage — must survive
			"999:2025:year", // different Anlage — must survive
		]);

		await measurements.repairMeasurementsOnce(adapter, "123");

		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly._rebuildDone`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2025.monthly.last updated`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026.last updated`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026._rebuildDone`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2025.last updated`), false);
		assert.equal(
			adapter.store.has("_api.Anlagen.123.WallboxMeasurements.0.Yearly.2026.monthly.last updated"),
			false,
		);
		assert.equal(adapter.store.has("_api.Anlagen.123.WallboxMeasurements.0.Yearly.2026.last updated"), false);

		assert.equal(
			adapter.store.get(`${PFX}AllTime.valueStore`),
			'{"POWER_CONSUMPTION":{"2025":12227.89,"2026":12227.99}}',
			"AllTime.valueStore is left for the re-poll to overwrite, not cleared here",
		);
		assert.equal(
			adapter.store.get(`${PFX}AllTime.POWER_CONSUMPTION`),
			24455.88,
			"AllTime.* state values are left alone; they recompute once the year re-polls",
		);

		assert.equal(adapter.rebuildCompletedSteps.has("123:2025:monthly"), false);
		assert.equal(adapter.rebuildCompletedSteps.has("123:2025:monthly.wb0"), false);
		assert.equal(adapter.rebuildCompletedSteps.has("123:2025:year"), false, "the yearly step is cleared too");
		assert.equal(adapter.rebuildCompletedSteps.has("123:2025:year.wb0"), false);
		assert.equal(adapter.rebuildCompletedSteps.has("999:2025:monthly"), true, "other Anlagen are unaffected");
		assert.equal(adapter.rebuildCompletedSteps.has("999:2025:year"), true, "other Anlagen are unaffected");

		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
		assert.equal(adapter.rebuildRunning, false, "the rebuild lock is released again");
	});

	it("does nothing on a second run", async () => {
		const adapter = makeAdapter({
			[`${PFX}_measurementsRepaired`]: true,
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${PFX}Yearly.2026.last updated`]: "2026-02-01T00:00:00.000Z",
		});

		await measurements.repairMeasurementsOnce(adapter, "123");

		assert.equal(
			adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`),
			true,
			"an already-repaired installation is left alone",
		);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026.last updated`), true);
	});
});
