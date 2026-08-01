"use strict";

/**
 * Regression tests for local section discovery.
 *
 * Two defects sit in localDiscoverSections:
 *
 * 1. `unavailable` is computed after the loop that deletes undiscovered sections, so it is
 *    always empty and the diagnostic it feeds always says "nothing missing".
 * 2. The section list it edits is `allKnownObjects` — a Set exported from constants.js and
 *    shared by the whole process. Deleting from it is not undoable, is visible to any other
 *    adapter instance in the same compact-mode process, and makes a second discovery run
 *    (the retry-startup path in main.js) start from an already-narrowed list.
 *
 * The consequence the tests below pin down: a discovery response that lists fewer sections
 * than the device really serves used to remove the rest from polling outright. Since
 * localInitPollSettings derives both the low- and high-priority forms from that same set, a
 * response missing ENERGY would have silently stopped live polling altogether.
 */

const assert = require("node:assert/strict");

const localClient = require("../lib/local-client");
const { allKnownObjects } = require("../lib/constants");

/** Snapshot of the shipped baseline, taken before any test can disturb it. */
const BASELINE = [...allKnownObjects];

/**
 * Build an adapter double whose lala.cgi returns a scripted discovery response.
 *
 * @param {object|Error|string} response - Parsed body to return, or an error to throw
 * @returns {object} Fake adapter
 */
function makeAdapter(response) {
	const adapter = {
		unloaded: false,
		connectVia: "https://",
		highPrioObjects: new Map(),
		lowPrioForm: "",
		highPrioForm: "",
		config: { senecip: "192.0.2.1", pollingTimeout: 5000, local_reqnresp_log: false, disclaimer: false },
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		logError() {},
		async doState() {},
		async setObjectNotExistsAsync() {},
		async localClient() {
			if (response instanceof Error) {
				throw response;
			}
			return { status: 200, data: response, request: {} };
		},
	};
	return adapter;
}

/**
 * A discovery body advertising the given section names.
 *
 * @param {string[]} names - Section names, without the st_ prefix
 * @returns {object} lala.cgi response body
 */
function sectionsBody(names) {
	return { DEBUG: { SECTIONS: names.map((n) => `st_${n}`) }, PLAIN: { SECTIONS: [] } };
}

/**
 * Section names the low-priority poll form asks for.
 *
 * @param {object} adapter - Fake adapter after localInitPollSettings
 * @returns {string[]} Section names
 */
function lowPrioSections(adapter) {
	return Object.keys(JSON.parse(adapter.lowPrioForm));
}

describe("local section discovery", () => {
	afterEach(() => {
		// Restore the shipped baseline, so one test cannot leak a narrowed list into the next.
		// That this is necessary at all is the second defect under test.
		allKnownObjects.clear();
		for (const s of BASELINE) {
			allKnownObjects.add(s);
		}
	});

	it("never edits the shared baseline", async () => {
		const adapter = makeAdapter(sectionsBody(["ENERGY"]));

		await localClient.localDiscoverSections(adapter);

		assert.deepEqual(
			[...allKnownObjects],
			BASELINE,
			"constants.allKnownObjects is process-wide state and must survive discovery untouched",
		);
	});

	it("a complete response leaves every section pollable and reports nothing missing", async () => {
		const adapter = makeAdapter(sectionsBody(BASELINE));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		const polled = lowPrioSections(adapter);
		for (const section of BASELINE) {
			assert.ok(polled.includes(section), `${section} must stay pollable`);
		}
	});

	it("a partial response does not remove the sections it omitted", async () => {
		// The case that motivated this: the device answers with ENERGY alone.
		const adapter = makeAdapter(sectionsBody(["ENERGY"]));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		const polled = lowPrioSections(adapter);
		assert.ok(polled.includes("ENERGY"));
		assert.ok(polled.includes("BMS"), "BMS must not disappear because one response omitted it");
		assert.ok(polled.length > 1, `only ${polled.length} section(s) left pollable`);
	});

	it("a partial response still reports what the device did not advertise", async () => {
		const adapter = makeAdapter(sectionsBody(["ENERGY"]));
		const written = [];
		adapter.doState = async (id, val) => written.push([id, val]);

		await localClient.localDiscoverSections(adapter);

		const unavailable = written.find(([id]) => id === "info.unavailableSections");
		assert.ok(unavailable, "the unavailable list must be reported");
		assert.notEqual(unavailable[1], "none", "a response listing one section leaves plenty unavailable");
		assert.ok(String(unavailable[1]).includes("BMS"));
	});

	it("an empty response changes nothing", async () => {
		const adapter = makeAdapter({ DEBUG: { SECTIONS: [] }, PLAIN: { SECTIONS: [] } });

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.deepEqual(lowPrioSections(adapter).sort(), [...BASELINE].sort());
	});

	it("a malformed response neither throws nor narrows polling", async () => {
		const adapter = makeAdapter({ DEBUG: "not-an-object", PLAIN: 42 });

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.deepEqual(lowPrioSections(adapter).sort(), [...BASELINE].sort());
	});

	it("a failed request neither throws nor narrows polling", async () => {
		const adapter = makeAdapter(new Error("device unreachable"));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.deepEqual(lowPrioSections(adapter).sort(), [...BASELINE].sort());
	});

	it("a newly advertised section becomes pollable", async () => {
		const adapter = makeAdapter(sectionsBody([...BASELINE, "NEW_SECTION"]));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.ok(lowPrioSections(adapter).includes("NEW_SECTION"), "discovery must still extend the list");
	});

	it("a deprecated section is not resurrected by discovery", async () => {
		const adapter = makeAdapter(sectionsBody(["ENERGY", "STATISTIC"]));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.equal(lowPrioSections(adapter).includes("STATISTIC"), false);
	});

	it("running discovery twice builds the same forms as running it once", async () => {
		const body = sectionsBody(["ENERGY", "BMS", "NEW_SECTION"]);

		const first = makeAdapter(body);
		await localClient.localDiscoverSections(first);
		await localClient.localInitPollSettings(first);

		const second = makeAdapter(body);
		await localClient.localDiscoverSections(second);
		await localClient.localDiscoverSections(second);
		await localClient.localInitPollSettings(second);

		assert.equal(second.lowPrioForm, first.lowPrioForm, "retry startup must build the same low-priority form");
		assert.equal(second.highPrioForm, first.highPrioForm, "and the same high-priority form");
	});

	it("live polling survives a response that omits ENERGY", async () => {
		const adapter = makeAdapter(sectionsBody(["BMS"]));

		await localClient.localDiscoverSections(adapter);
		await localClient.localInitPollSettings(adapter);

		assert.ok(
			adapter.highPrioForm.includes("ENERGY"),
			"the high-priority form carries the live values; losing it stops the dashboard",
		);
	});
});
