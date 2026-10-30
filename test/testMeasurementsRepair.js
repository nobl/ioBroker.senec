"use strict";

/**
 * Regression test for the one-shot repair of damaged monthly measurement buckets.
 *
 * doSumMeasurements used to bucket the `Yearly.*.monthly.` breakdown with UTC getters while the
 * cloud's bucket-start timestamps denote local month boundaries, shifting every stored month by
 * the local UTC offset. Fixing the getters does not repair data already written, and
 * doMeasurementsYear skips a past year whose lastUpdated already falls in the current calendar
 * year — so already-wrong years would not re-poll until next January. repairMeasurementsOnce
 * clears the stored monthly markers exactly once per Anlage, forcing one re-poll.
 *
 * What it must NOT clear: the year-total markers next to them (the year totals were never
 * written wrongly) and any `_rebuildDone` outside the monthly breakdown — nothing regenerates a
 * rebuild-completion record, so deleting one destroys it. `AllTime.*` is likewise left alone; it
 * is derived from the per-year data these markers gate.
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
		log: { info() {}, debug() {}, warn() {}, silly() {} },
		unloaded: false,
		rebuildRunning: false,
		rebuildCompletedSteps: new Set(),
		apiWallboxUuids: [],
		apiWallboxCount: 0,
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
const WB_PFX = "_api.Anlagen.123.WallboxMeasurements.0.";

describe("repairMeasurementsOnce", () => {
	it("clears only the monthly markers and sets the completion marker", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${PFX}Yearly.2026.monthly._rebuildDone`]: true,
			[`${PFX}Yearly.2025.monthly.last updated`]: "2025-06-01T00:00:00.000Z",
			// Year-total markers: the year totals were never damaged, and _rebuildDone has no
			// other writer, so both must survive.
			[`${PFX}Yearly.2026.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${PFX}Yearly.2026._rebuildDone`]: true,
			[`${PFX}Yearly.2025.last updated`]: "2025-07-01T00:00:00.000Z",
			[`${PFX}Yearly.2025._rebuildDone`]: true,
			// AllTime values are damaged by the same bug but must be left untouched here —
			// they self-correct once the year re-polls, not via this repair.
			[`${PFX}AllTime.valueStore`]: '{"POWER_CONSUMPTION":{"2025":12227.89,"2026":12227.99}}',
			[`${PFX}AllTime.POWER_CONSUMPTION`]: 24455.88,
		});
		adapter.apiWallboxUuids = ["wb-uuid-0"];
		adapter.apiWallboxCount = 1;
		adapter.store.set(`${WB_PFX}Yearly.2026.monthly.last updated`, "x");
		adapter.store.set(`${WB_PFX}Yearly.2026.monthly._rebuildDone`, true);
		adapter.store.set(`${WB_PFX}Yearly.2026.last updated`, "x");
		adapter.store.set(`${WB_PFX}Yearly.2026._rebuildDone`, true);
		adapter.rebuildCompletedSteps = new Set([
			"123:2025:monthly",
			"123:2025:monthly.wb0",
			"123:2025:year",
			"123:2025:year.wb0",
			"999:2025:monthly", // different Anlage — must survive
			"999:2025:year", // different Anlage — must survive
		]);

		const completed = await measurements.repairMeasurementsOnce(adapter, "123");

		assert.equal(completed, true);

		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly._rebuildDone`), false);
		assert.equal(adapter.store.has(`${PFX}Yearly.2025.monthly.last updated`), false);
		assert.equal(adapter.store.has(`${WB_PFX}Yearly.2026.monthly.last updated`), false);
		assert.equal(adapter.store.has(`${WB_PFX}Yearly.2026.monthly._rebuildDone`), false);

		assert.equal(
			adapter.store.get(`${PFX}Yearly.2026.last updated`),
			"2026-02-01T00:00:00.000Z",
			"the year total was never damaged, so its marker must be preserved",
		);
		assert.equal(adapter.store.get(`${PFX}Yearly.2025.last updated`), "2025-07-01T00:00:00.000Z");
		assert.equal(
			adapter.store.get(`${PFX}Yearly.2026._rebuildDone`),
			true,
			"nothing regenerates a year-total rebuild marker, so clearing it is unrecoverable",
		);
		assert.equal(adapter.store.get(`${PFX}Yearly.2025._rebuildDone`), true);
		assert.equal(adapter.store.get(`${WB_PFX}Yearly.2026.last updated`), "x");
		assert.equal(adapter.store.get(`${WB_PFX}Yearly.2026._rebuildDone`), true);

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
		assert.equal(
			adapter.rebuildCompletedSteps.has("123:2025:year"),
			true,
			"the year step stays done; its persisted marker is not cleared either",
		);
		assert.equal(adapter.rebuildCompletedSteps.has("123:2025:year.wb0"), true);
		assert.equal(adapter.rebuildCompletedSteps.has("999:2025:monthly"), true, "other Anlagen are unaffected");
		assert.equal(adapter.rebuildCompletedSteps.has("999:2025:year"), true, "other Anlagen are unaffected");

		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
		assert.equal(adapter.rebuildRunning, false, "the repair does not borrow the rebuild lock");
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

	it("still records completion when no marker matched", async () => {
		const adapter = makeAdapter({});

		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), true);
		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
	});

	it("withholds the marker and rejects when a deletion fails", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		adapter.delStateAsync = async () => {
			throw new Error("states db not connected");
		};

		await assert.rejects(measurements.repairMeasurementsOnce(adapter, "123"), /Anlage 123/);

		assert.equal(
			adapter.store.has(`${PFX}_measurementsRepaired`),
			false,
			"a repair that could not delete everything must not claim completion",
		);
	});

	it("treats an explicit not-found as deleted and still completes", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		adapter.delStateAsync = async () => {
			throw new Error("State does not exist");
		};

		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), true);
		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
	});

	it("retries after a rejected run instead of caching the failure", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		const realDelState = adapter.delStateAsync;
		adapter.delStateAsync = async () => {
			throw new Error("states db not connected");
		};

		await assert.rejects(measurements.repairMeasurementsOnce(adapter, "123"));

		adapter.delStateAsync = realDelState;
		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), true);
		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`), false);
		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
	});

	it("shares one run between concurrent callers for the same Anlage", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		let deletions = 0;
		adapter.delStateAsync = async (id) => {
			deletions++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			adapter.store.delete(id);
		};

		await Promise.all([
			measurements.repairMeasurementsOnce(adapter, "123"),
			measurements.repairMeasurementsOnce(adapter, "123"),
		]);

		assert.equal(deletions, 1, "the second caller must join the running repair, not start a new one");
	});

	it("withholds the marker when a system with wallboxes has no wallbox ids yet", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
			[`${WB_PFX}Yearly.2026.monthly.last updated`]: "x",
		});
		adapter.apiWallboxCount = 1;
		adapter.apiWallboxUuids = [];

		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), false);

		assert.equal(
			adapter.store.has(`${WB_PFX}Yearly.2026.monthly.last updated`),
			true,
			"the wallbox subtree was never reached",
		);
		assert.equal(
			adapter.store.has(`${PFX}_measurementsRepaired`),
			false,
			"completion must wait until the wallbox ids are known",
		);

		adapter.apiWallboxUuids = ["wb-uuid-0"];
		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), true);
		assert.equal(adapter.store.has(`${WB_PFX}Yearly.2026.monthly.last updated`), false);
		assert.equal(adapter.store.get(`${PFX}_measurementsRepaired`), true);
	});

	it("warns about missing wallbox ids once, not on every retry", async () => {
		// The condition can persist for the adapter's whole life, and the repair is re-attempted
		// on every poll cycle.
		const adapter = makeAdapter({});
		adapter.apiWallboxCount = 1;
		adapter.apiWallboxUuids = [];
		let warnings = 0;
		adapter.log.warn = () => {
			warnings++;
		};

		await measurements.repairMeasurementsOnce(adapter, "123");
		await measurements.repairMeasurementsOnce(adapter, "123");
		await measurements.repairMeasurementsOnce(adapter, "123");

		assert.equal(warnings, 1);
	});

	it("writes nothing once the adapter is unloading", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		adapter.unloaded = true;

		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), false);

		assert.equal(adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`), true);
		assert.equal(adapter.store.has(`${PFX}_measurementsRepaired`), false);
	});

	it("stops deleting and withholds the marker when unload lands mid-run", async () => {
		const adapter = makeAdapter({
			[`${PFX}Yearly.2025.monthly.last updated`]: "2025-06-01T00:00:00.000Z",
			[`${PFX}Yearly.2026.monthly.last updated`]: "2026-02-01T00:00:00.000Z",
		});
		adapter.delStateAsync = async (id) => {
			adapter.store.delete(id);
			adapter.unloaded = true;
		};

		assert.equal(await measurements.repairMeasurementsOnce(adapter, "123"), false);

		assert.equal(
			adapter.store.has(`${PFX}Yearly.2026.monthly.last updated`),
			true,
			"the second marker is left for the next start",
		);
		assert.equal(adapter.store.has(`${PFX}_measurementsRepaired`), false);
	});
});
