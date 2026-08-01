"use strict";

/**
 * Regression tests for external energy sources.
 *
 * Three defects, all rooted in the same shape: _externalSourceMap is keyed by foreign state
 * id with exactly one entry per key, so a state used by more than one consumer keeps only
 * the consumer that registered last. Configurations that quietly half-worked:
 *
 * - the same meter feeding two sources (only the second updates);
 * - a state used both directly and inside a formula (whichever registered last wins);
 * - a battery's SOC state also referenced by a formula.
 *
 * Separately, external power states are created at 0 and only ever updated from a
 * stateChange, so a source whose foreign state is steady after startup reads 0 until it
 * happens to change — on a quiet consumer that can be hours.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const mainExport = proxyquire("../main", {
	"@iobroker/adapter-core": {
		Adapter: class FakeAdapter {
			constructor() {}
			on() {}
		},
		getAbsoluteDefaultDataDir: () => "/tmp",
	},
	axios: { create: () => ({}) },
	"axios-cookiejar-support": {},
	"tough-cookie": { CookieJar: class {} },
});

/**
 * Build an adapter instance with the foreign-state layer faked out.
 *
 * @param {Record<string, number|null>} foreignValues - Current values of foreign states
 * @returns {object} Adapter instance with recorders
 */
function makeAdapter(foreignValues = {}) {
	const adapter = mainExport({});

	adapter.namespace = "senec.0";
	adapter.config = {};
	adapter.written = [];
	adapter.subscribedForeign = [];
	adapter.log = { info() {}, debug() {}, warn() {}, error() {}, silly() {} };

	adapter.doState = async (id, val) => {
		adapter.written.push([id, val]);
	};
	adapter.setObjectNotExistsAsync = async () => {};
	adapter.subscribeForeignStatesAsync = async (id) => {
		adapter.subscribedForeign.push(id);
	};
	adapter.getForeignStateAsync = async (id) =>
		id in foreignValues ? { val: foreignValues[id], ack: true } : null;

	return adapter;
}

/**
 * Latest value written to an external power state.
 *
 * @param {object} adapter - Adapter instance
 * @param {string} id - State id below the namespace
 * @returns {any} Last written value, or undefined
 */
function lastWrite(adapter, id) {
	const hits = adapter.written.filter(([writtenId]) => writtenId === id);
	return hits.length ? hits[hits.length - 1][1] : undefined;
}

/**
 * Deliver a foreign state change to the adapter.
 *
 * @param {object} adapter - Adapter instance
 * @param {string} id - Foreign state id
 * @param {number} val - New value
 * @returns {Promise<void>} Resolves once handled
 */
function change(adapter, id, val) {
	return adapter.onStateChange(id, { val, ack: true });
}

describe("external energy sources", () => {
	it("one foreign state feeding two sources updates both", async () => {
		const adapter = makeAdapter({ "meter.0.power": 1200 });
		await adapter.initExternalSources([
			{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Roof" },
			{ stateId: "meter.0.power", sourceType: "consumer", unit: "W", label: "House" },
		]);

		await change(adapter, "meter.0.power", 1500);

		assert.equal(lastWrite(adapter, "_external.pv.0.power"), 1500, "the first source must update too");
		assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 1500);
	});

	it("a state used directly and inside a formula drives both", async () => {
		const adapter = makeAdapter({ "meter.0.power": 1000, "meter.0.factor": 2 });
		await adapter.initExternalSources([
			{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Direct" },
			{ stateId: "{meter.0.power} * {meter.0.factor}", sourceType: "consumer", unit: "W", label: "Derived" },
		]);

		await change(adapter, "meter.0.power", 1000);

		assert.equal(lastWrite(adapter, "_external.pv.0.power"), 1000, "the direct source must update");
		assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 2000, "and the formula must re-evaluate");
	});

	it("a formula registered before a direct use of the same state still runs", async () => {
		// Same as above with the configuration order reversed — order must not decide.
		const adapter = makeAdapter({ "meter.0.power": 1000, "meter.0.factor": 3 });
		await adapter.initExternalSources([
			{ stateId: "{meter.0.power} * {meter.0.factor}", sourceType: "consumer", unit: "W", label: "Derived" },
			{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Direct" },
		]);

		await change(adapter, "meter.0.power", 1000);

		assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 3000);
		assert.equal(lastWrite(adapter, "_external.pv.0.power"), 1000);
	});

	it("a battery SOC state that a formula also references drives both", async () => {
		const adapter = makeAdapter({ "bat.0.soc": 80, "bat.0.power": 500 });
		await adapter.initExternalSources([
			{
				stateId: "bat.0.power",
				socStateId: "bat.0.soc",
				sourceType: "battery",
				unit: "W",
				label: "Battery",
				capacity: 10,
			},
			{ stateId: "{bat.0.soc} * 10", sourceType: "consumer", unit: "W", label: "Derived from SOC" },
		]);

		await change(adapter, "bat.0.soc", 80);

		assert.equal(lastWrite(adapter, "_external.battery.0.soc"), 80, "the SOC must still be recorded");
		assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 800, "and the formula must re-evaluate");
	});

	it("current values are read once after subscribing, not left at zero", async () => {
		const adapter = makeAdapter({ "meter.0.power": 2200, "bat.0.soc": 65, "bat.0.power": -300 });

		await adapter.initExternalSources([
			{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Roof" },
			{ stateId: "bat.0.power", socStateId: "bat.0.soc", sourceType: "battery", unit: "W", label: "Battery" },
		]);

		assert.equal(lastWrite(adapter, "_external.pv.0.power"), 2200, "a steady source must not read 0 until it moves");
		assert.equal(lastWrite(adapter, "_external.battery.0.power"), -300, "battery sign is preserved");
		assert.equal(lastWrite(adapter, "_external.battery.0.soc"), 65);
	});

	it("a formula's current value is read once after subscribing", async () => {
		const adapter = makeAdapter({ "meter.0.voltage": 230, "meter.0.current": 4 });

		await adapter.initExternalSources([
			{ stateId: "{meter.0.voltage} * {meter.0.current}", sourceType: "consumer", unit: "W", label: "Calc" },
		]);

		assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 920);
	});

	describe("startup evaluation is done once per consumer", () => {
		// loadExternalCurrentValues deduplicates with a Set of consumer objects, but a formula
		// is registered once per reference — each registration a distinct wrapper — so the Set
		// never matches and an N-reference formula is evaluated N times at startup, reading
		// all N of its references on each pass.

		it("a two-reference formula is evaluated once, not twice", async () => {
			const adapter = makeAdapter({ "meter.0.voltage": 230, "meter.0.current": 4 });
			const reads = [];
			const inner = adapter.getForeignStateAsync;
			adapter.getForeignStateAsync = async (id) => {
				reads.push(id);
				return inner(id);
			};

			await adapter.initExternalSources([
				{ stateId: "{meter.0.voltage} * {meter.0.current}", sourceType: "consumer", unit: "W", label: "Calc" },
			]);

			const powerWrites = adapter.written.filter(([id]) => id === "_external.consumer.0.power");
			assert.equal(
				powerWrites.length,
				2,
				`the initialising zero plus one evaluated value, got ${powerWrites.length} writes`,
			);
			assert.equal(powerWrites[powerWrites.length - 1][1], 920);
			assert.equal(reads.length, 2, `expected one read per reference, got ${reads.length}`);
		});

		it("a four-reference formula does not read sixteen times", async () => {
			const adapter = makeAdapter({ "a.0.w": 1, "a.0.x": 2, "a.0.y": 3, "a.0.z": 4 });
			let reads = 0;
			const inner = adapter.getForeignStateAsync;
			adapter.getForeignStateAsync = async (id) => {
				reads++;
				return inner(id);
			};

			await adapter.initExternalSources([
				{ stateId: "{a.0.w} + {a.0.x} + {a.0.y} + {a.0.z}", sourceType: "pv", unit: "W", label: "Sum" },
			]);

			assert.equal(reads, 4, `startup read the foreign states ${reads} times for four references`);
			assert.equal(lastWrite(adapter, "_external.pv.0.power"), 10);
		});

		it("simple and SOC consumers still get their current value", async () => {
			const adapter = makeAdapter({ "meter.0.power": 2200, "bat.0.soc": 65, "bat.0.power": -300 });

			await adapter.initExternalSources([
				{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Roof" },
				{ stateId: "bat.0.power", socStateId: "bat.0.soc", sourceType: "battery", unit: "W", label: "Bat" },
			]);

			assert.equal(lastWrite(adapter, "_external.pv.0.power"), 2200);
			assert.equal(lastWrite(adapter, "_external.battery.0.power"), -300);
			assert.equal(lastWrite(adapter, "_external.battery.0.soc"), 65);
		});

		it("every configured source is evaluated exactly once at startup", async () => {
			const adapter = makeAdapter({ "m.0.a": 10, "m.0.b": 20, "m.0.c": 30 });

			await adapter.initExternalSources([
				{ stateId: "m.0.a", sourceType: "pv", unit: "W", label: "One" },
				{ stateId: "{m.0.b} + {m.0.c}", sourceType: "consumer", unit: "W", label: "Two" },
				{ stateId: "{m.0.a} * 2", sourceType: "pv", unit: "W", label: "Three" },
			]);

			for (const [id, expected] of [
				["_external.pv.0.power", 10],
				["_external.consumer.0.power", 50],
				["_external.pv.1.power", 20],
			]) {
				const writes = adapter.written.filter(([writtenId]) => writtenId === id);
				assert.equal(writes.length, 2, `${id} written ${writes.length} times, expected zero-init plus one`);
				assert.equal(writes[1][1], expected);
			}
		});

		it("runtime re-evaluation still happens for every reference", async () => {
			const adapter = makeAdapter({ "meter.0.voltage": 230, "meter.0.current": 4 });
			await adapter.initExternalSources([
				{ stateId: "{meter.0.voltage} * {meter.0.current}", sourceType: "consumer", unit: "W", label: "Calc" },
			]);

			await change(adapter, "meter.0.current", 4);
			assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 920, "the second reference must also drive it");

			await change(adapter, "meter.0.voltage", 230);
			assert.equal(lastWrite(adapter, "_external.consumer.0.power"), 920, "and so must the first");
		});
	});

	describe("non-finite values on the other paths", () => {
		it("an SOC state reporting Infinity is not written through", async () => {
			const adapter = makeAdapter({ "bat.0.soc": Infinity, "bat.0.power": 100 });
			await adapter.initExternalSources([
				{ stateId: "bat.0.power", socStateId: "bat.0.soc", sourceType: "battery", unit: "W", label: "Bat" },
			]);

			const soc = lastWrite(adapter, "_external.battery.0.soc");
			assert.ok(Number.isFinite(soc), `wrote ${soc} to an SOC state`);
		});

		it("a simple source reporting Infinity is not written through", async () => {
			const adapter = makeAdapter({ "meter.0.power": Infinity });
			await adapter.initExternalSources([
				{ stateId: "meter.0.power", sourceType: "pv", unit: "W", label: "Roof" },
			]);

			const value = lastWrite(adapter, "_external.pv.0.power");
			assert.ok(Number.isFinite(value), `wrote ${value} to a power state`);
		});

		it("a huge kW value does not overflow to Infinity during conversion", async () => {
			// Finite before the ×1000, non-finite after it.
			const adapter = makeAdapter({ "meter.0.power": Number.MAX_VALUE });
			await adapter.initExternalSources([
				{ stateId: "meter.0.power", sourceType: "pv", unit: "kW", label: "Roof" },
			]);

			const value = lastWrite(adapter, "_external.pv.0.power");
			assert.ok(Number.isFinite(value), `kW conversion produced ${value}`);
		});
	});

	describe("non-finite formula results", () => {
		it("a division by zero is not written as Infinity", async () => {
			const adapter = makeAdapter({ "meter.0.power": 1000, "meter.0.divisor": 0 });
			await adapter.initExternalSources([
				{ stateId: "{meter.0.power} / {meter.0.divisor}", sourceType: "pv", unit: "W", label: "Bad" },
			]);

			await change(adapter, "meter.0.power", 1000);

			const value = lastWrite(adapter, "_external.pv.0.power");
			assert.ok(Number.isFinite(value), `wrote ${value} to a power state`);
		});

		it("a nonsensical expression falls back to zero", async () => {
			const adapter = makeAdapter({ "meter.0.power": 1000 });
			await adapter.initExternalSources([
				{ stateId: "{meter.0.power} * {meter.0.missing}", sourceType: "pv", unit: "W", label: "Missing ref" },
			]);

			await change(adapter, "meter.0.power", 1000);

			const value = lastWrite(adapter, "_external.pv.0.power");
			assert.ok(Number.isFinite(value));
			assert.equal(value, 0);
		});
	});
});
