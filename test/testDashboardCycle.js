"use strict";

/**
 * Tests that drive the dashboard's real state-update chain.
 *
 * Every other dashboard test exercises one module in isolation, or a hand-written stand-in for
 * `onStateUpdate`. Neither can see a defect that lives in the *composition* — and one did: the
 * mid-cycle hold in `onStateUpdate` was undone by `_doRender`, which recomputes on the next
 * animation frame, so the energy flow still rendered a fresh battery reading against the
 * previous cycle's meter and inverted the grid arrow.
 *
 * So this file loads `i18n.js`, `energy.js`, `livechart.js` and `app.js` into one context, in
 * page order, and runs `app.onStateUpdate` with a flushable `requestAnimationFrame`.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DICTIONARY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "www", "i18n", "en.json"), "utf8"));

/**
 * Load the real dashboard chain.
 *
 * @param {object} [config] - Instance configuration to expose as `app.config`
 * @returns {object} The vm context, plus `flushFrames()`
 */
function loadChain(config = { openapi_use: true, lala_use: false, api_use: false, web_use: false }) {
	const noop = () => undefined;
	const frames = [];
	/** @returns {object} A DOM element stub that records what was written into it */
	const el = () => ({
		style: {},
		hidden: false,
		innerHTML: "",
		childElementCount: 0,
		classList: { add: noop, remove: noop, contains: () => false },
		setAttribute: noop,
		addEventListener: noop,
		dataset: {},
		focus: noop,
		getContext: () => null,
	});
	const dashboard = el();
	const context = vm.createContext({
		document: {
			// The energy flow is the surface under test, so it gets a stable element whose
			// innerHTML the assertions read; everything else gets a throwaway.
			getElementById: (id) => (id === "dashboard" ? dashboard : el()),
			querySelector: () => null,
			querySelectorAll: () => [],
			createElement: el,
			head: { appendChild: noop },
			addEventListener: noop,
			documentElement: { classList: { add: noop, remove: noop, contains: () => false }, lang: "en" },
			baseURI: "http://localhost/senec/",
		},
		window: {
			location: { search: "" },
			addEventListener: noop,
			matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
		},
		localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
		navigator: { language: "en" },
		requestAnimationFrame: (cb) => frames.push(cb),
		io: { connect: () => ({ on: noop, emit: noop }) },
		eventTimeline: { render: () => "", fetchEvents: noop },
		charts: { render: () => "", paintChart: noop, bindZoom: noop },
		controls: { render: () => "", isLocked: () => false, bind: noop },
		statsViewer: { render: () => "", paintChart: noop },
		logViewer: { onConfigLoaded: noop },
		console,
	});
	for (const name of ["i18n.js", "energy.js", "livechart.js", "system.js", "app.js"]) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8"), context, {
			filename: name,
		});
	}
	// The real dictionary, read from disk rather than fetched.
	context.i18n.ready = true;
	context.i18n.dictionaries = { en: DICTIONARY };
	context.i18n.lang = "en";
	context.app.config = config;
	context.app.activeTab = "overview";
	context.flushFrames = () => {
		const queued = frames.splice(0, frames.length);
		queued.forEach((cb) => cb());
	};
	context.dashboardEl = dashboard;
	return context;
}

/** A completed OpenAPI cycle: night, battery idle, importing 300 W. */
const CYCLE_ONE = [
	["_openapi.battery.power", 0],
	["_openapi.battery.stateOfCharge", 80],
	["_openapi.meter.production", 0],
	["_openapi.meter.houseConsumption", 300],
	["_openapi.meter.gridPower", 300],
	["_openapi.info.lastCompletePoll", "2026-10-26T08:00:00.000Z"],
	["_openapi.info.lastPoll", "2026-10-26T08:00:00.000Z"],
];

/**
 * The next cycle, in the order the connector writes it: /v1/battery before /v1/meter, then
 * the completeness marker, then `lastPoll` last of all.
 */
const CYCLE_TWO = [
	["_openapi.battery.power", -3000],
	["_openapi.battery.stateOfCharge", 78],
	["_openapi.meter.production", 0],
	["_openapi.meter.houseConsumption", 3300],
	["_openapi.meter.gridPower", 300],
	["_openapi.info.lastCompletePoll", "2026-10-26T08:01:00.000Z"],
	["_openapi.info.lastPoll", "2026-10-26T08:01:00.000Z"],
];

describe("dashboard — the real state-update chain", () => {
	let ctx;

	beforeEach(() => {
		ctx = loadChain();
		ctx.app.connectors.openapi.active = true;
		ctx.energyFlow.source = "openapi";
	});

	/**
	 * Deliver one state the way the socket does, then let the deferred render run.
	 *
	 * @param {string} id - State id without the namespace
	 * @param {string|number} value - The value that arrived
	 */
	function deliver(id, value) {
		ctx.app.states[id] = value;
		ctx.app.onStateUpdate(id, value);
		ctx.flushFrames();
	}

	it("never renders a grid direction derived from a half-written cycle", () => {
		for (const [id, value] of CYCLE_ONE) {
			deliver(id, value);
		}
		assert.equal(ctx.energyFlow.data.grid, 300, "cycle one is importing 300 W");

		// Cycle two: a 3 kW load comes on and the battery covers it. The battery section is
		// written first, so for a moment a -3000 W battery sits beside cycle one's 300 W house
		// — a balance that reads as a 300 W *export*. The plant never exported anything.
		const seen = [];
		for (const [id, value] of CYCLE_TWO) {
			deliver(id, value);
			seen.push(ctx.energyFlow.data.grid);
		}

		assert.ok(
			seen.every((g) => g >= 0),
			`the diagram showed an export mid-cycle: ${JSON.stringify(seen)}`,
		);
		assert.equal(ctx.energyFlow.data.grid, 300, "and cycle two is still importing 300 W");
	});

	it("records exactly one chart point per cycle", () => {
		for (const [id, value] of CYCLE_ONE) {
			deliver(id, value);
		}
		assert.equal(ctx.liveChart.buffer.length, 1, "one point for cycle one");

		// record() drops anything within 2 s of the last point, which a test runs well inside.
		ctx.liveChart._lastTs = 0;
		for (const [id, value] of CYCLE_TWO) {
			deliver(id, value);
		}
		assert.equal(ctx.liveChart.buffer.length, 2, "one point for cycle two");

		const [, second] = ctx.liveChart.buffer;
		assert.deepEqual(
			{ pv: second.pv, battery: second.battery, grid: second.grid, house: second.house },
			{ pv: 0, battery: -3000, grid: 300, house: 3300 },
			"the recorded point is cycle two throughout, not a mix",
		);
	});

	it("does not show the incomplete-poll warning on a healthy cycle", () => {
		const warned = [];
		for (const [id, value] of [...CYCLE_ONE, ...CYCLE_TWO]) {
			deliver(id, value);
			warned.push(/Incomplete poll/.test(ctx.dashboardEl.innerHTML));
		}
		assert.ok(!warned.some(Boolean), "the warning appeared during a cycle in which every section answered");
	});

	it("shows the incomplete-poll warning when a section did not answer", () => {
		for (const [id, value] of CYCLE_ONE) {
			deliver(id, value);
		}
		// A cycle whose meter route failed: the sections that did answer are written, and
		// `lastPoll` is stamped, but no completeness marker follows.
		deliver("_openapi.battery.power", -500);
		deliver("_openapi.info.lastPoll", "2026-10-26T08:02:00.000Z");

		assert.match(ctx.dashboardEl.innerHTML, /Incomplete poll/);
	});
});
