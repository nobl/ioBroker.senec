"use strict";

/**
 * Tests for the dashboard's local OpenAPI energy source.
 *
 * The grid direction is the part worth pinning. `meter.gridPower` has only ever been
 * observed while importing, so the dashboard decides the direction from the power balance
 * rather than from the field's sign, and these cases cover both conventions the field could
 * turn out to follow as well as the noise band between them.
 *
 * `www/` is browser code with no module system, so each file is evaluated in a vm context
 * holding the globals it declares.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DICTIONARY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "www", "i18n", "en.json"), "utf8"));

/**
 * The dashboard's own translation contract: a known key is translated, an unknown key comes
 * back unchanged. Several render paths branch on that, so a stub that always answers would
 * exercise the wrong half — and asserting on the English text proves the keys are wired.
 *
 * @param {string} key - Translation key
 * @param {{[key: string]: string|number}} [params] - Placeholder values
 * @returns {string} The English text, or the key when there is none
 */
function translate(key, params) {
	let text = Object.hasOwn(DICTIONARY, key) ? DICTIONARY[key] : key;
	for (const name of Object.keys(params || {})) {
		text = text.split(`{${name}}`).join(String(params[name]));
	}
	return text;
}

/**
 * Load a www module into a fresh context.
 *
 * `i18n.js` is always loaded first, because it is loaded first in the page and defines the shared
 * `escHtml` the view modules use. Loading the real one rather than stubbing it means the escaping
 * tests exercise the code that actually ships. Its `t` is then replaced by the stub above, which
 * reads the dictionary from disk instead of fetching it.
 *
 * @param {string|Array<string>} file - File name(s) under www/, loaded in page order
 * @param {object} [extraGlobals] - Globals the file expects to find
 * @returns {object} The context, carrying whatever the file declared
 */
function loadWww(file, extraGlobals = {}) {
	const context = vm.createContext({
		app: { states: {}, config: {}, connectors: {} },
		// energy.js resets the chart on every source change, so the stub needs the whole
		// surface it reaches for. A bare {} let a missing member go unnoticed until it was
		// a function call rather than a property write.
		liveChart: {
			buffer: [],
			_lastTs: 0,
			_loadGeneration: 0,
			_historyLoaded: false,
			_historyLoading: false,
			_historyStatus: {},
			_historyRequestedTs: Infinity,
			_newestHistoryTs: 0,
			_clearLoadTimer() {},
			record() {},
			initHistory() {},
		},
		navigator: { language: "en" },
		...extraGlobals,
	});
	for (const name of ["i18n.js", ...(Array.isArray(file) ? file : [file])]) {
		const source = fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8");
		vm.runInContext(source, context, { filename: name });
	}
	context.t = translate;
	return context;
}

/**
 * Bring a value across the vm boundary.
 *
 * Objects built inside the context have their own Object and Array prototypes, so
 * assert.deepEqual rejects them as not reference-equal however identical their contents.
 *
 * @param {unknown} value - Value produced inside the vm context
 * @returns {any} The same value, built from this realm's prototypes
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * Connector status in the shape index.html keeps it.
 *
 * @param {Array<string>} active - Names of the connectors reporting a connection
 * @returns {object} Connector status objects
 */
const connectors = (active) => ({
	local: { active: active.includes("local") },
	openapi: { active: active.includes("openapi") },
	api: { active: active.includes("api") },
	web: { active: active.includes("web") },
});

describe("dashboard — local OpenAPI energy source", () => {
	let energyFlow;
	let app;

	beforeEach(() => {
		const ctx = loadWww("energy.js");
		energyFlow = ctx.energyFlow;
		app = ctx.app;
		energyFlow.source = "auto";
	});

	/** Minimal power states per source, enough for resolveSource to accept it. */
	const POWER = {
		local: { "ENERGY.GUI_INVERTER_POWER": 0, "ENERGY.GUI_HOUSE_POW": 500 },
		openapi: { "_openapi.meter.production": 0, "_openapi.meter.houseConsumption": 500 },
		api: {
			"_api.Anlagen.1.Dashboard.currently.powerGenerationInW": 0,
			"_api.Anlagen.1.Dashboard.currently.powerConsumptionInW": 500,
		},
		web: { "_meinsenec.Status.powergenerated.now": 0, "_meinsenec.Status.consumption.now": 0.5 },
	};

	/**
	 * State set carrying power readings for each named source.
	 *
	 * @param {Array<string>} sources - Source names that should look like they are reporting
	 * @returns {object} ioBroker state values
	 */
	function powerFor(sources) {
		return sources.reduce((acc, name) => Object.assign(acc, POWER[name]), {});
	}

	describe("resolveSource", () => {
		it("prefers the local connector, which polls six times as often", () => {
			assert.equal(
				energyFlow.resolveSource(powerFor(["local", "openapi"]), connectors(["local", "openapi"])),
				"local",
			);
		});

		it("prefers the OpenAPI over either cloud connector", () => {
			assert.equal(
				energyFlow.resolveSource(powerFor(["openapi", "api", "web"]), connectors(["openapi", "api", "web"])),
				"openapi",
			);
		});

		it("is the only source on an installation with lala.cgi switched off", () => {
			assert.equal(energyFlow.resolveSource(powerFor(["openapi"]), connectors(["openapi"])), "openapi");
		});

		it("does not break on a connector set that predates the OpenAPI", () => {
			const legacy = { local: { active: false }, api: { active: true }, web: { active: false } };
			assert.equal(energyFlow.resolveSource(powerFor(["api"]), legacy), "api");
		});

		it("skips a connected source that has published no power reading", () => {
			// TEST-002: the OpenAPI counts a nameplate-only cycle as a success, so being
			// connected is not enough to describe an energy flow. Selecting it anyway drew a
			// diagram of zeros over a working cloud connector.
			const states = Object.assign({ "_openapi.bessNameplate.designCapacity": 5000 }, POWER.api);
			assert.equal(energyFlow.resolveSource(states, connectors(["openapi", "api"])), "api");
		});

		it("falls through to nothing when no connected source has power data", () => {
			assert.equal(energyFlow.resolveSource({}, connectors(["openapi", "api", "web"])), null);
		});
	});

	describe("resolveOpenapiGrid", () => {
		it("trusts a negative reading as a signed export", () => {
			assert.equal(energyFlow.resolveOpenapiGrid(-1200, 400, 0, 1600), -1200);
		});

		it("reads the recorded import sample as an import", () => {
			// /v1/meter and /v1/battery as measured on a V3: importing 91 W while the battery
			// discharges 850 W. The balance lands at 86 W, five watts under the meter.
			assert.equal(energyFlow.resolveOpenapiGrid(91, 1181, -850.8078, 244), 91);
		});

		it("reads a positive value as an export when the balance says so", () => {
			// Magnitude convention: 3500 W of PV covering a 300 W house and 1000 W of charging
			// leaves 2200 W going out, reported without a sign.
			assert.equal(energyFlow.resolveOpenapiGrid(2200, 300, 1000, 3500), -2200);
		});

		it("keeps the meter's magnitude rather than the balance's", () => {
			// Balance says 2000 W out, the meter says 2150 W. The meter is the measurement.
			assert.equal(energyFlow.resolveOpenapiGrid(2150, 500, 0, 2500), -2150);
		});

		it("claims no direction for a small flow the balance cannot place", () => {
			// IMP-001. The band is symmetric about zero: a balance of -30 and a balance of +30
			// must give the same answer, because neither establishes a direction. A one-sided
			// band reported a genuine sub-50 W export as an import of the same size.
			assert.equal(energyFlow.resolveOpenapiGrid(30, 130, 0, 100), 0, "balance +30");
			assert.equal(energyFlow.resolveOpenapiGrid(30, 100, 0, 130), 0, "balance -30");
			assert.equal(energyFlow.resolveOpenapiGrid(30, 100, 0, 100), 0, "balance 0");
			// Outside the band the direction is established again, in both directions.
			assert.equal(energyFlow.resolveOpenapiGrid(200, 300, 0, 100), 200);
			assert.equal(energyFlow.resolveOpenapiGrid(200, 100, 0, 300), -200);
		});

		it("keeps a large measurement the balance cannot place, rather than zeroing it", () => {
			// The wallbox-exclusion case named in the JSDoc: if the local meter's house figure
			// omits a charging wallbox, the balance goes flat while real power flows. Discarding
			// a 2 kW reading there would be worse than mislabelling its direction.
			assert.equal(energyFlow.resolveOpenapiGrid(2000, 100, 0, 100), 2000);
		});

		it("takes the export magnitude from powerSurplus when gridPower is import-only", () => {
			// RISK-002: under the convention the docs consider most likely, gridPower reads 0
			// while feeding in and powerSurplus carries the figure. Without this a sunny
			// afternoon showed 3.2 kW of PV and a grid flow of zero.
			assert.equal(energyFlow.resolveOpenapiGrid(0, 300, 0, 3500, 3200), -3200);
		});

		it("prefers the meter's own magnitude over powerSurplus when it has one", () => {
			assert.equal(energyFlow.resolveOpenapiGrid(2200, 300, 1000, 3500, 9999), -2200);
		});

		it("reports zero rather than a signed zero when nothing flows", () => {
			assert.ok(Object.is(energyFlow.resolveOpenapiGrid(0, 0, -1000, 0), 0));
		});
	});

	describe("updateFromOpenapi", () => {
		const states = {
			"_openapi.meter.production": 3500,
			"_openapi.meter.houseConsumption": 300,
			"_openapi.meter.gridPower": 2200,
			"_openapi.battery.power": 1000,
			"_openapi.battery.stateOfCharge": 47,
		};

		it("maps the five sections the default include list covers", () => {
			energyFlow.update(states, connectors(["openapi"]));
			assert.equal(energyFlow.activeSource, "openapi");
			assert.equal(energyFlow.data.pv, 3500);
			assert.equal(energyFlow.data.house, 300);
			assert.equal(energyFlow.data.battery, 1000);
			assert.equal(energyFlow.data.grid, -2200);
			assert.equal(energyFlow.data.soc, 47);
		});

		it("leaves the wallbox out of the flow math", () => {
			// The diagram branches the wallbox off the house node, and nothing establishes
			// that the local meter's house figure contains the charging load.
			energyFlow.update({ ...states, "_openapi.evse.1.chargingPower": 7400 }, connectors(["openapi"]));
			assert.equal(energyFlow.data.wallbox, 0);
		});

		it("never takes the battery capacity from the nameplate", () => {
			// designCapacity is one module. Reading it as the pack made every time-to-full and
			// time-to-empty short by the module count, and the module count is not available
			// from this connector at all.
			energyFlow.update({ ...states, "_openapi.bessNameplate.designCapacity": 5000 }, connectors(["openapi"]));
			assert.equal(energyFlow.data.batteryCapacity, null);
		});

		it("reports the time of the last complete poll, not of any poll", () => {
			// DEF-003: lastPoll is stamped as soon as one section answered, so a cycle whose
			// meter route failed would report the current time beside the previous cycle's
			// meter values. Showing nothing is the honest answer for that case.
			//
			// The stamp is taken from the clock rather than written down, because the formatter
			// renders a bare time only for the local day: a fixed date passes on one day and in
			// one timezone, and reads as an ordinary regression failure every other day.
			const today = new Date().toISOString();
			energyFlow.update(states, connectors(["openapi"]));
			const partial = { ...states, "_openapi.info.lastPoll": today };
			assert.equal(energyFlow.getLastUpdateTime(partial), null);
			const complete = { ...partial, "_openapi.info.lastCompletePoll": today };
			assert.match(energyFlow.getLastUpdateTime(complete), /^\d{2}:\d{2}:\d{2}$/);
		});

		it("dates a complete poll that did not happen today, so it cannot read as current", () => {
			// The counterpart to the case above, and the reason it cannot simply assert a bare
			// time for every input: a stamp from days ago must not render as a time of day.
			const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
			energyFlow.update(states, connectors(["openapi"]));
			const complete = {
				...states,
				"_openapi.info.lastPoll": old,
				"_openapi.info.lastCompletePoll": old,
			};
			const shown = energyFlow.getLastUpdateTime(complete);
			assert.doesNotMatch(shown, /^\d{2}:\d{2}:\d{2}$/);
			assert.match(shown, /\d/);
		});

		it("refuses to describe a flow when the App API has a plant but no dashboard data", () => {
			// DEF-010: a plant id can be discovered from a SystemDetails poll while the dashboard
			// section has published nothing. The prefix guard passed on the id alone, so absent
			// states were read as zeros — and that held even for an explicitly selected source,
			// which bypasses resolveSource's own check.
			energyFlow.source = "api";
			energyFlow.update({ "_api.Anlagen.1.SystemDetails.batteryPack.maxCapacityInKwh": 10 }, connectors(["api"]));
			assert.equal(energyFlow.apiPrefix(), "_api.Anlagen.1.Dashboard.");
			assert.equal(energyFlow.hasData, false);
		});

		it("refuses to describe a flow when no power section was published", () => {
			// TEST-002 / DEF-002: a nameplate-only cycle still reports the connector connected.
			// Reading the absent power states as zero published a diagram of zeros as a current
			// measurement, which is worse than showing nothing.
			energyFlow.update(
				{ "_openapi.bessNameplate.designCapacity": 5000, "_openapi.info.lastPoll": "x" },
				connectors(["openapi"]),
			);
			assert.equal(energyFlow.hasData, false);
		});

		it("does not invert the grid direction when the battery section is absent", () => {
			// TEST-002 / DEF-002: a 500 W import with PV 3000 and 3000 W of charging. With the
			// battery term missing the balance read -2500 and rendered the import as an export.
			energyFlow.update(
				{
					"_openapi.meter.production": 3000,
					"_openapi.meter.houseConsumption": 500,
					"_openapi.meter.gridPower": 500,
				},
				connectors(["openapi"]),
			);
			assert.equal(energyFlow.hasData, true);
			assert.equal(energyFlow.data.grid, 500);
		});

		it("takes a configured capacity and never the per-module nameplate figure", () => {
			// designCapacity describes one module, so it is not a pack capacity and nothing
			// falls back to it; a value the user typed is the only local source.
			energyFlow.update({ ...states, "_openapi.bessNameplate.designCapacity": 5000 }, connectors(["openapi"]));
			assert.equal(energyFlow.data.batteryCapacity, null);
			app.config.battery_capacity = 10;
			try {
				energyFlow.update(
					{ ...states, "_openapi.bessNameplate.designCapacity": 5000 },
					connectors(["openapi"]),
				);
				assert.equal(energyFlow.data.batteryCapacity, 10);
			} finally {
				delete app.config.battery_capacity;
			}
		});
	});

	describe("the partial-cycle notice", () => {
		const states = {
			"_openapi.meter.production": 3500,
			"_openapi.meter.houseConsumption": 300,
			"_openapi.meter.gridPower": 2200,
			"_openapi.battery.power": 1000,
			"_openapi.battery.stateOfCharge": 47,
		};

		/**
		 * Render the energy flow for one pair of poll markers.
		 *
		 * @param {string|undefined} polled - `_openapi.info.lastPoll`
		 * @param {string|undefined} complete - `_openapi.info.lastCompletePoll`
		 * @returns {string} The rendered card
		 */
		function renderWith(polled, complete) {
			const withMarkers = { ...states };
			if (polled !== undefined) {
				withMarkers["_openapi.info.lastPoll"] = polled;
			}
			if (complete !== undefined) {
				withMarkers["_openapi.info.lastCompletePoll"] = complete;
			}
			energyFlow.update(withMarkers, connectors(["openapi"]));
			app.states = withMarkers;
			return energyFlow.render();
		}

		it("warns when the latest cycle did not serve every section", () => {
			// The case that matters, and the one an `else if` on the update time could not
			// reach: a cycle fails after healthy ones, so lastCompletePoll is present but
			// stale — the diagram shows an old time, and without this nothing says so.
			const html = renderWith("2026-10-26T12:01:00.000Z", "2026-10-26T12:00:00.000Z");
			assert.match(html, /Incomplete poll/, "a stale complete-marker is still a partial cycle");
		});

		it("warns when no cycle has ever completed", () => {
			assert.match(renderWith("2026-10-26T12:01:00.000Z", undefined), /Incomplete poll/);
		});

		it("says nothing on a healthy cycle", () => {
			const stamp = "2026-10-26T12:01:00.000Z";
			const html = renderWith(stamp, stamp);
			assert.doesNotMatch(html, /Incomplete poll/, "every healthy cycle would carry the warning");
			assert.match(html, /Last update/, "and the time is shown instead");
		});
	});

	describe("sourceOwnsState", () => {
		it("accepts only the cycle-end marker for the OpenAPI", () => {
			// The sections arrive as a dozen separate writes, so no single one of them
			// represents a whole reading. `lastPoll` is written last of everything the cycle
			// writes — after the completeness marker — which is what makes it the one signal
			// that the cycle has settled.
			assert.equal(energyFlow.sourceOwnsState("openapi", "_openapi.info.lastPoll"), true);
			assert.equal(energyFlow.sourceOwnsState("openapi", "_openapi.info.lastCompletePoll"), false);
			assert.equal(energyFlow.sourceOwnsState("openapi", "_openapi.meter.gridPower"), false);
			assert.equal(energyFlow.sourceOwnsState("openapi", "_openapi.battery.power"), false);
			assert.equal(energyFlow.sourceOwnsState("openapi", "_openapi.info.reachable"), false);
		});

		it("treats a cycle as complete only when both markers agree", () => {
			// A cycle in which one section failed leaves lastCompletePoll at the previous
			// stamp, so the two differ and the sample is a mix of two cycles.
			assert.equal(energyFlow.openapiCycleComplete({}), false);
			assert.equal(energyFlow.openapiCycleComplete({ "_openapi.info.lastPoll": "12:00:30" }), false);
			assert.equal(
				energyFlow.openapiCycleComplete({
					"_openapi.info.lastPoll": "12:00:30",
					"_openapi.info.lastCompletePoll": "11:59:30",
				}),
				false,
			);
			assert.equal(
				energyFlow.openapiCycleComplete({
					"_openapi.info.lastPoll": "12:00:30",
					"_openapi.info.lastCompletePoll": "12:00:30",
				}),
				true,
			);
		});

		it("does not let one source claim another's states", () => {
			// The prefix half of this is connectorOfState's single answer now, not a second
			// list kept in step by hand — so these are the cases that would drift if it were.
			assert.equal(energyFlow.sourceOwnsState("openapi", "ENERGY.GUI_HOUSE_POW"), false);
			assert.equal(energyFlow.sourceOwnsState("local", "_openapi.info.lastPoll"), false);
			assert.equal(energyFlow.sourceOwnsState("api", "_meinsenec.Status.consumption.now"), false);
			assert.equal(energyFlow.sourceOwnsState("web", "_api.Anlagen.1.Dashboard.currently.gridDrawInW"), false);
			assert.equal(energyFlow.sourceOwnsState("local", "_meinsenec.Status.consumption.now"), false);
			// The cases the connector test is actually load-bearing for: the narrowing alone
			// would accept these, because a segment named `currently.` or `.Status.` is not
			// unique to the connector that coined it. SENEC.Connect is the one that bit the
			// badge code, which had no branch for it at all.
			assert.equal(energyFlow.sourceOwnsState("api", "_connect.Systems.X.currently.gridPower"), false);
			assert.equal(energyFlow.sourceOwnsState("web", "_connect.Systems.X.Status.consumption"), false);
			assert.equal(energyFlow.sourceOwnsState("local", "ENERGY.GUI_HOUSE_POW"), true);
			// A connector writes far more than its power readings; only the readings may sample.
			assert.equal(energyFlow.sourceOwnsState("local", "BMS.SYSTEM_SOH"), false);
			assert.equal(energyFlow.sourceOwnsState("api", "_api.Anlagen.1.SystemDetails.batteryPack.x"), false);
			assert.equal(energyFlow.sourceOwnsState("web", "_meinsenec.Status.consumption.now"), true);
			assert.equal(energyFlow.sourceOwnsState("api", "_api.Anlagen.1.Dashboard.currently.gridDrawInW"), true);
		});
	});
});

describe("dashboard — local OpenAPI system cards", () => {
	let systemInfo;

	beforeEach(() => {
		// The wallbox cards read `_openapi.evse.*`, and a state only counts as live when its
		// section is one the connector polls, so the include list has to name evse here — as an
		// instance showing wallbox slots necessarily does.
		systemInfo = loadWww("system.js", {
			energyFlow: { apiAnlagenId: null },
			app: { states: {}, connectors: {}, config: { openapi_include: ["battery", "meter", "bess", "evse"] } },
		}).systemInfo;
	});

	it("credits an OpenAPI state to the OpenAPI, not to lala.cgi", () => {
		const states = { "_openapi.bessNameplate.model": "SENEC.Home V3 hybrid LFP" };
		assert.equal(systemInfo.sourceTag(states, ["FACTORY.SYS_TYPE_Text", "_openapi.bessNameplate.model"]), "O");
	});

	it("still credits an unprefixed state to lala.cgi", () => {
		assert.equal(systemInfo.sourceTag({ "BMS.SYSTEM_SOH": 98 }, ["BMS.SYSTEM_SOH"]), "L");
	});

	it("gives the O badge a label of its own", () => {
		assert.match(systemInfo.srcBadge("O"), /title="Local OpenAPI"/);
	});

	describe("openapiWallboxSlots", () => {
		it("drops the empty slots the appliance always reports", () => {
			const states = {};
			for (const id of [1, 2, 3, 4]) {
				states[`_openapi.evse.${id}.evConnected`] = false;
				states[`_openapi.evse.${id}.evCharging`] = false;
				states[`_openapi.evse.${id}.chargingPower`] = 0;
			}
			assert.deepEqual(plain(systemInfo.openapiWallboxSlots(states)), []);
		});

		it("keeps a slot with a car on it", () => {
			const states = {
				"_openapi.evse.1.evConnected": true,
				"_openapi.evse.1.evCharging": true,
				"_openapi.evse.1.chargingPower": 7400,
				"_openapi.evse.2.evConnected": false,
				"_openapi.evse.2.evCharging": false,
				"_openapi.evse.2.chargingPower": 0,
			};
			const slots = systemInfo.openapiWallboxSlots(states);
			assert.equal(slots.length, 1);
			assert.deepEqual(plain(slots[0]), {
				id: "1",
				connected: true,
				charging: true,
				power: 7400,
				limitation: null,
			});
		});

		it("keeps a slot drawing power with no connection flag reported", () => {
			const slots = systemInfo.openapiWallboxSlots({ "_openapi.evse.3.chargingPower": 2300 });
			assert.equal(slots.length, 1);
			assert.equal(slots[0].id, "3");
			assert.equal(slots[0].connected, null);
		});
	});

	describe("formatAge", () => {
		it("keeps the date once the age passes the relative wording", () => {
			// A bare time of day read as current at a glance — the wrong impression for a poll
			// that last succeeded days ago, which is exactly when it matters most.
			const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
			const text = systemInfo.formatAge(old.toISOString());
			// The day of the month is the part that distinguishes it from a time of day.
			assert.match(String(text), new RegExp(String(old.getDate())), `no date in ${text}`);
			assert.doesNotMatch(String(text), /ago/);
		});

		it("still words a recent age relatively", () => {
			assert.match(String(systemInfo.formatAge(new Date(Date.now() - 30000).toISOString())), /s ago/);
			assert.match(String(systemInfo.formatAge(new Date(Date.now() - 600000).toISOString())), /min ago/);
			assert.match(String(systemInfo.formatAge(new Date(Date.now() - 7200000).toISOString())), /h ago/);
		});

		it("returns null for something that is not a date", () => {
			assert.equal(systemInfo.formatAge("not a date"), null);
			assert.equal(systemInfo.formatAge(undefined), null);
		});
	});

	describe("renderOpenapiStatus", () => {
		it("renders nothing when the connector has never run", () => {
			assert.equal(systemInfo.renderOpenapiStatus({}), "");
		});

		it("explains a pending registration rather than only naming it", () => {
			const html = systemInfo.renderOpenapiStatus({ "_openapi.info.approvalState": "pending" });
			assert.match(html, new RegExp(translate("openapi_approval_pending")));
			assert.match(html, /approve it in the mein-senec.de portal/);
		});

		it("does not explain a registration that is through", () => {
			const html = systemInfo.renderOpenapiStatus({ "_openapi.info.approvalState": "approved" });
			assert.match(html, new RegExp(translate("openapi_approval_approved")));
			assert.doesNotMatch(html, /approve it in the mein-senec.de portal/);
		});

		it("shows an unknown approval verdict verbatim rather than a bare key", () => {
			const html = systemInfo.renderOpenapiStatus({ "_openapi.info.approvalState": "surprising" });
			assert.match(html, /surprising/);
		});

		it("has a translated label for every verdict the connector can write", () => {
			// TEST-003 / DEF-004: the dictionaries covered four of the five. The fifth,
			// "unregistered", is the state a fresh instance starts in and the one the Forget
			// button returns to — so the state most users meet first printed as a bare English
			// token in every locale. Enumerated from the connector, so a sixth verdict fails here.
			const source = fs.readFileSync(path.join(__dirname, "..", "lib", "openapi-client.js"), "utf8");
			const verdicts = [...new Set([...source.matchAll(/\bstate:\s*"([a-z]+)"/g)].map((m) => m[1]))];
			assert.ok(verdicts.includes("unregistered"), "the enumeration itself must still work");
			assert.ok(verdicts.length >= 5, `expected the five-rung ladder, found ${verdicts.join(", ")}`);
			for (const verdict of verdicts) {
				const key = `openapi_approval_${verdict}`;
				assert.notEqual(translate(key), key, `${key} is missing from en.json`);
			}
		});

		it("explains an unregistered instance instead of only naming it", () => {
			const html = systemInfo.renderOpenapiStatus({ "_openapi.info.approvalState": "unregistered" });
			assert.match(html, new RegExp(translate("openapi_approval_unregistered")));
			assert.match(html, /Register it on the Local OpenAPI tab/);
		});

		it("says whether the appliance is reachable, separately from the approval", () => {
			// IMP-004: an outage leaves approvalState at "approved" — the registration really is
			// approved; it is the appliance that cannot be reached.
			const html = systemInfo.renderOpenapiStatus({
				"_openapi.info.approvalState": "approved",
				"_openapi.info.lastPoll": new Date(Date.now() - 3600_000).toISOString(),
				"info.openapiConnected": false,
			});
			assert.match(html, new RegExp(translate("openapi_reachable")));
			assert.match(html, new RegExp(translate("no")));
		});

		it("reports the poll time as an age rather than a bare clock time", () => {
			// IMP-008: toLocaleTimeString formatted in the browser's locale, which need not be
			// the language the dashboard is running in.
			assert.equal(systemInfo.formatAge(new Date(Date.now() - 30_000).toISOString()), "30 s ago");
			assert.equal(systemInfo.formatAge(new Date(Date.now() - 600_000).toISOString()), "10 min ago");
			assert.equal(systemInfo.formatAge(new Date(Date.now() - 7_200_000).toISOString()), "2 h ago");
			assert.equal(systemInfo.formatAge("not a date"), null);
		});

		it("flags a cycle that never completed", () => {
			const html = systemInfo.renderOpenapiStatus({
				"_openapi.info.approvalState": "approved",
				"_openapi.info.lastPoll": new Date().toISOString(),
			});
			assert.match(html, new RegExp(translate("openapi_last_complete_poll")));
			assert.match(html, new RegExp(translate("openapi_never")));
		});
	});

	describe("escaping appliance-supplied strings", () => {
		// DEF-008: renderMetric interpolates into markup assigned through innerHTML, and the
		// nameplate strings are whatever the appliance returned. The connector's normaliser only
		// drops null leaves; it does not sanitise text.
		const PAYLOAD = '<img src=x onerror="alert(1)">';

		it("escapes a model and serial number in the system card", () => {
			const html = systemInfo.renderSystemDetails({
				"_openapi.bessNameplate.model": PAYLOAD,
				"_openapi.bessNameplate.serialNumber": PAYLOAD,
			});
			assert.ok(!html.includes("<img"), "markup from the appliance reached the DOM");
			assert.match(html, /&lt;img/);
		});

		it("escapes a manufacturer in the OpenAPI card", () => {
			const html = systemInfo.renderOpenapiStatus({
				"_openapi.info.approvalState": "approved",
				"_openapi.bessNameplate.manufacturer": PAYLOAD,
			});
			assert.ok(!html.includes("<img"));
			assert.match(html, /&lt;img/);
		});

		it("still renders the source badge, which is markup by design", () => {
			const html = systemInfo.renderMetric("Label", "value", "#000", "O");
			assert.match(html, /<span class="src-badge"/);
		});
	});

	describe("wallbox slot ordering and memoisation", () => {
		it("orders slots numerically, not as strings", () => {
			// IMP-006: a plain sort put 10 between 1 and 2.
			const states = {};
			for (const id of [1, 2, 10]) {
				states[`_openapi.evse.${id}.chargingPower`] = 1000 + id;
			}
			assert.deepEqual(
				plain(systemInfo.openapiWallboxSlots(states)).map((slot) => slot.id),
				["1", "2", "10"],
			);
		});

		it("rediscovers the slots only after evseDirty, and re-reads their values every time", () => {
			// IMP-007: the key scan is memoised, so a slot appearing or disappearing has to
			// invalidate it — but a slot's *values* must never be cached, or the card would
			// freeze at whatever it first rendered.
			const states = { "_openapi.evse.1.chargingPower": 1000 };
			assert.equal(plain(systemInfo.openapiWallboxSlots(states)).length, 1);

			states["_openapi.evse.2.chargingPower"] = 2000;
			assert.equal(plain(systemInfo.openapiWallboxSlots(states)).length, 1, "stale until invalidated");
			systemInfo.evseDirty();
			assert.equal(plain(systemInfo.openapiWallboxSlots(states)).length, 2);

			// A value change needs no invalidation.
			states["_openapi.evse.1.chargingPower"] = 7400;
			assert.equal(plain(systemInfo.openapiWallboxSlots(states))[0].power, 7400);

			// A slot whose states are deleted drops out once invalidated.
			delete states["_openapi.evse.2.chargingPower"];
			systemInfo.evseDirty();
			assert.deepEqual(
				plain(systemInfo.openapiWallboxSlots(states)).map((slot) => slot.id),
				["1"],
			);
		});
	});
});

describe("dashboard — values from connectors that are switched off", () => {
	// Nothing deletes a connector's states when it is disabled, so every card went on rendering
	// whatever it last wrote. On the development appliance that meant an energy flow and a whole
	// battery tab built from lala.cgi values two months old, presented as current readings.
	let systemInfo;
	let energyFlow;

	/**
	 * @param {object} config - Instance configuration to expose as app.config
	 * @returns {object} The loaded context
	 */
	function withConfig(config) {
		// Both modules in one context, as the page loads them: system.js reads the real
		// energyFlow for prefixes and formatting, and both share one `app.config`.
		const ctx = loadWww(["energy.js", "system.js"]);
		ctx.app.config = config;
		return ctx;
	}

	beforeEach(() => {
		const ctx = withConfig({ lala_use: false, openapi_use: true, api_use: false, web_use: false });
		systemInfo = ctx.systemInfo;
		energyFlow = ctx.energyFlow;
	});

	it("maps each state id to the connector that writes it", () => {
		const ctx = withConfig({});
		assert.equal(ctx.connectorOfState("ENERGY.GUI_HOUSE_POW"), "local");
		assert.equal(ctx.connectorOfState("BMS.SYSTEM_SOH"), "local");
		assert.equal(ctx.connectorOfState("_openapi.meter.gridPower"), "openapi");
		assert.equal(ctx.connectorOfState("_api.Anlagen.1.Dashboard.currently.gridDrawInW"), "api");
		assert.equal(ctx.connectorOfState("_meinsenec.Status.consumption.now"), "web");
		assert.equal(ctx.connectorOfState("_connect.Systems.X.battery.power"), "connect");
		// Not a connector's: an external source mirrors another adapter, and info.* is
		// adapter-level. Both must stay visible whatever the connectors are doing.
		assert.equal(ctx.connectorOfState("_external.pv.0.power"), null);
		assert.equal(ctx.connectorOfState("info.openapiConnected"), null);
	});

	it("resolves the OpenAPI include list exactly as the connector does", () => {
		// The browser cannot call buildOpenapiInclude, so it mirrors it — and the mirror had
		// drifted three ways at once: an absent key resolved to nothing live rather than the
		// default, the single-element ["battery,meter"] shape the multi-select actually stores
		// matched no section, and an unknown name was honoured instead of dropped. Both run in
		// Node, so the two can simply be compared.
		const openapi = require("../lib/openapi-client.js");
		for (const configured of [
			undefined,
			null,
			"",
			[],
			false,
			0,
			NaN,
			"battery,meter",
			["battery,meter"],
			["battery", "meter"],
			["evse"],
			["battery", "nonsense"],
			["bess", "evse", "meter"],
			[" battery ", "meter"],
		]) {
			// `openapi_use` is along for the ride so the config is never *empty* — an empty one
			// means "not loaded yet", which openapiSections deliberately answers differently
			// (see the loading-window test below).
			const ctx = withConfig({ openapi_use: true, openapi_include: configured });
			// An absent key is not an empty choice: delete it so the two see the same thing.
			if (configured === undefined) {
				delete ctx.app.config.openapi_include;
			}
			assert.deepEqual(
				plain(ctx.openapiSections()),
				openapi.buildOpenapiInclude(configured),
				`disagreed on ${JSON.stringify(configured)}`,
			);
		}
	});

	it("shows every OpenAPI section while the configuration is still loading", () => {
		// connectorEnabled answers "enabled" in this window so the first render is not blank.
		// openapiSections has to agree: defaulting to the *stored* default instead hid the
		// bess and wallbox cards on every page load of an install that selects them.
		const ctx = withConfig({});
		assert.deepEqual(plain(ctx.openapiSections()), ["battery", "meter", "bess", "bessNameplate", "evse"]);
		assert.equal(ctx.stateIsLive("_openapi.bess.voltage"), true);
		assert.equal(ctx.stateIsLive("_openapi.evse.1.chargingPower"), true);
	});

	it("shows everything while the configuration is still loading", () => {
		// The config arrives over the socket after the first render. Defaulting to "hide" would
		// blank the page for that moment.
		const ctx = withConfig({});
		assert.equal(ctx.stateIsLive("ENERGY.GUI_HOUSE_POW"), true);
		assert.equal(ctx.stateIsLive("_api.Anlagen.1.Dashboard.currently.gridDrawInW"), true);
	});

	it("counts an enabled connector as available even when it is not connected", () => {
		// The user's rule: a connector with connection trouble keeps its place on the page, or
		// the cards it feeds would vanish and reappear as the connection flaps.
		const ctx = withConfig({ lala_use: true });
		ctx.app.states = { "info.localConnected": false };
		assert.equal(ctx.stateIsLive("ENERGY.GUI_HOUSE_POW"), true);
	});

	it("skips a disabled connector's value but keeps a later source that is enabled", () => {
		// The row names several sources in preference order. Only the row whose every source is
		// switched off may disappear.
		const states = {
			"FACTORY.SYS_TYPE_Text": "stale local name",
			"_openapi.bessNameplate.model": "SENEC.Home V3 hybrid LFP",
		};
		assert.equal(
			systemInfo.getFirst(states, ["FACTORY.SYS_TYPE_Text", "_openapi.bessNameplate.model"]),
			"SENEC.Home V3 hybrid LFP",
		);
		assert.equal(systemInfo.sourceTag(states, ["FACTORY.SYS_TYPE_Text", "_openapi.bessNameplate.model"]), "O");
	});

	it("hands the system tab an empty TLS card when lala.cgi is off", () => {
		// The TLS card used to render unconditionally, defaulting the mode to "none" — so the
		// system tab's container was never empty and the tab could not be hidden, whatever the
		// connectors were doing. The upload it offers only affects lala.cgi.
		const states = { "_local.tls.mode": "tofu", "_local.tls.fingerprint": "ab".repeat(16) };
		assert.equal(systemInfo.renderTlsStatus(states), "", "lala.cgi is off in this fixture");

		const withLocal = withConfig({ lala_use: true });
		assert.match(withLocal.systemInfo.renderTlsStatus(states), /TOFU/, "and renders while it is on");
	});

	it("drops the OpenAPI card when its connector is switched off", () => {
		const states = {
			"_openapi.info.approvalState": "approved",
			"_openapi.info.lastPoll": "2026-08-01T08:00:00.000Z",
			"_openapi.tls.fingerprint": "cd".repeat(16),
		};
		assert.match(systemInfo.renderOpenapiStatus(states), /openapi_title|Local OpenAPI/);

		const off = withConfig({ openapi_use: false });
		assert.equal(off.systemInfo.renderOpenapiStatus(states), "", "a months-old approval is not a status");
	});

	it("keeps the control tree visible when lala.cgi is off", () => {
		// A command is dispatched to whichever connector can carry it, so `control.` belongs to
		// no single one. Attributing it to lala.cgi hid the whole Control tab.
		assert.equal(energyFlow.activeSource, null, "no source resolved in this fixture");
		const ctx = withConfig({ lala_use: false, web_use: true });
		assert.equal(ctx.connectorOfState("control.emergencyPower.enabled"), null);
		assert.equal(ctx.stateIsLive("control.emergencyPower.enabled"), true);
	});

	it("returns nothing when every source for a row is switched off", () => {
		const states = { "BMS.SYSTEM_SOH": 100, "BMS.MODULE_COUNT": 2 };
		assert.equal(systemInfo.getFirst(states, ["BMS.SYSTEM_SOH"]), null);
		assert.equal(systemInfo.renderBatteryHealth(states), "", "the whole card has to go");
	});

	it("builds a battery card from the OpenAPI when lala.cgi is off", () => {
		// The values were being polled and shown nowhere, while the card above displayed a
		// two-month-old voltage and current from a connector that is switched off.
		const html = systemInfo.renderBatteryLive({
			"_openapi.battery.stateOfCharge": 36,
			"_openapi.battery.power": -2367.86,
			"_openapi.battery.voltage": 51.7,
			"_openapi.battery.current": -45.8,
			"BMS.SYSTEM_SOH": 100,
		});
		assert.match(html, /51\.7 V/);
		assert.match(html, /-45\.8 A/);
		assert.match(html, /36%/);
	});

	it("does not take today's totals from a disabled cloud connector", () => {
		// updateTotalsToday tests for the API states directly, so a leftover _api tree took that
		// branch and showed yesterday's cloud figures beside a live local reading.
		energyFlow.period = "today";
		energyFlow.update(
			{
				"_openapi.meter.production": 261,
				"_openapi.meter.houseConsumption": 2925,
				"_openapi.battery.power": -2367,
				"_api.Anlagen.1.Dashboard.today.powerGenerationInWh": 2300,
				"_api.Anlagen.1.Dashboard.today.powerConsumptionInWh": 18900,
			},
			connectors(["openapi"]),
		);
		assert.equal(energyFlow.activeSource, "openapi");
		assert.equal(energyFlow.apiPrefix(), null, "a disabled API must not yield a plant prefix");
		assert.equal(energyFlow.data.todayPv, null);
		assert.equal(energyFlow.data.todayConsumption, null);
	});
});

describe("dashboard — local OpenAPI live chart", () => {
	let liveChart;
	let energyFlow;
	let app;

	beforeEach(() => {
		const energyCtx = loadWww("energy.js");
		energyFlow = energyCtx.energyFlow;
		app = energyCtx.app;
		liveChart = loadWww("livechart.js", {
			energyFlow,
			// _mergeHistory repaints when it finishes, so the stub has to answer the lookups the
			// render path makes rather than being an empty object.
			document: { getElementById: () => null, querySelectorAll: () => [] },
			window: {},
			requestAnimationFrame: () => {},
		}).liveChart;
	});

	it("names the states the chart lines are fed from", () => {
		const fields = liveChart._historyFields("openapi");
		const lines = [...new Set(plain(fields.map((f) => f.line)))].sort();
		assert.deepEqual(lines, ["battery", "grid", "house", "pv", "soc"]);
		for (const field of fields) {
			assert.ok(field.key.startsWith("_openapi."), `${field.key} is not an OpenAPI state`);
		}
		// powerSurplus feeds the grid line rather than one of its own — it supplies the export
		// magnitude when gridPower turns out to be import-only.
		const names = plain(fields.map((f) => f.name));
		assert.ok(names.includes("surplus"));
	});

	it("offers no wallbox line, matching what the flow math uses", () => {
		assert.ok(!liveChart._historyFields("openapi").some((f) => f.line === "wallbox"));
	});

	describe("recording a poll that arrives one state at a time", () => {
		// The states a cycle writes, in the order the connector serves its sections. The last
		// entry is the cycle marker the connector writes once the sections are in.
		const CYCLE_ONE = [
			["_openapi.battery.power", -2000],
			["_openapi.battery.stateOfCharge", 80],
			["_openapi.meter.gridPower", 0],
			["_openapi.meter.houseConsumption", 2000],
			["_openapi.meter.production", 0],
			["_openapi.info.lastCompletePoll", "2026-10-26T08:00:00.000Z"],
			["_openapi.info.lastPoll", "2026-10-26T08:00:00.000Z"],
		];
		const CYCLE_TWO = [
			["_openapi.battery.power", 1000],
			["_openapi.battery.stateOfCharge", 81],
			["_openapi.meter.gridPower", 2200],
			["_openapi.meter.houseConsumption", 300],
			["_openapi.meter.production", 3500],
			["_openapi.info.lastCompletePoll", "2026-10-26T08:01:00.000Z"],
			["_openapi.info.lastPoll", "2026-10-26T08:01:00.000Z"],
		];

		/**
		 * Replay index.html's onStateUpdate decision for one state id.
		 *
		 * @param {object} states - The dashboard's state cache, mutated in place
		 * @param {object} conns - Connector status to resolve the active source against
		 * @param {string} id - State id, without the namespace
		 * @param {string|number} value - The value that arrived
		 */
		function deliver(states, conns, id, value) {
			states[id] = value;
			energyFlow.noteOpenapiWrite(id);
			app.states = states;
			if (!energyFlow.openapiMidCycle(states)) {
				energyFlow.update(states, conns);
			}
			if (energyFlow.activeSource && energyFlow.sourceOwnsState(energyFlow.activeSource, id)) {
				if (energyFlow.activeSource !== "openapi" || energyFlow.openapiCycleComplete(states)) {
					liveChart.record();
				}
			}
		}

		it("records one whole point per cycle rather than a half-stale one", () => {
			const states = {};
			const conns = connectors(["openapi"]);
			for (const [id, value] of CYCLE_ONE) {
				deliver(states, conns, id, value);
			}
			// record() drops anything within 2s of the last point, so the second cycle would be
			// dropped outright were it triggered by the first state of the cycle.
			liveChart._lastTs = 0;
			for (const [id, value] of CYCLE_TWO) {
				deliver(states, conns, id, value);
			}

			assert.equal(liveChart.buffer.length, 2, "one point per cycle");
			const [first, second] = plain(liveChart.buffer);

			// Cycle one: discharging 2000 W into a 2000 W house, nothing from the grid.
			assert.deepEqual(
				{ pv: first.pv, battery: first.battery, grid: first.grid, house: first.house, soc: first.soc },
				{ pv: 0, battery: -2000, grid: 0, house: 2000, soc: 80 },
			);
			// Cycle two: 3500 W of PV, 1000 W into the battery, 2200 W out to the grid. A point
			// built from the first state of this cycle would still carry cycle one's house and
			// production, which would also read the export as an import.
			assert.deepEqual(
				{ pv: second.pv, battery: second.battery, grid: second.grid, house: second.house, soc: second.soc },
				{ pv: 3500, battery: 1000, grid: -2200, house: 300, soc: 81 },
			);
		});

		it("ignores another connector's writes while the OpenAPI is the active source", () => {
			// TEST-005 / DEF-006: with lala.cgi or a cloud connector also enabled, their writes
			// drove record() while the OpenAPI supplied the data. One landing between the battery
			// and the meter writes of a cycle captured a 2200 W export as 0 W.
			const states = {};
			const conns = connectors(["openapi"]);
			for (const [id, value] of CYCLE_ONE) {
				deliver(states, conns, id, value);
			}
			assert.equal(liveChart.buffer.length, 1);
			liveChart._lastTs = 0;

			// Mid-cycle: the battery section has landed, the meter section has not.
			deliver(states, conns, "_openapi.battery.power", 1000);
			deliver(states, conns, "_openapi.battery.stateOfCharge", 81);
			// Now a foreign write, of the kind that used to trigger a sample.
			deliver(states, conns, "ENERGY.GUI_HOUSE_POW", 2000);
			deliver(states, conns, "_meinsenec.Status.consumption.now", 2);
			deliver(states, conns, "_api.Anlagen.1.Dashboard.currently.gridDrawInW", 800);
			assert.equal(liveChart.buffer.length, 1, "no point from a foreign connector's write");

			// The rest of the cycle, then its marker.
			for (const [id, value] of CYCLE_TWO.slice(2)) {
				deliver(states, conns, id, value);
			}
			assert.equal(liveChart.buffer.length, 2);
			const latest = plain(liveChart.buffer)[1];
			assert.equal(latest.grid, -2200, "the export must not be recorded as zero");
			assert.equal(latest.house, 300);
		});
	});

	it("labels every line it declares", () => {
		for (const field of liveChart._historyFields("openapi")) {
			assert.ok(liveChart._lineLabels[field.line], `${field.line} has no label`);
		}
	});

	describe("backfilling history whose sections carry separate timestamps", () => {
		// TEST-001 / DEF-001: each state is written by its own setStateChangedAsync, and battery
		// and meter come from two different HTTP requests, so history stores each with its own
		// millisecond. These offsets are what a real cycle looks like.
		const T = 1761000000000;
		const OFFSET = { battery: 0, soc: 3, grid: 140, house: 147, pv: 152, surplus: 158 };

		/**
		 * Build one history timeline per field, five cycles a minute apart.
		 *
		 * @param {object} values - Value per field name
		 * @returns {object} getHistory-shaped results per field
		 */
		function timelines(values) {
			const out = {};
			for (const name of Object.keys(values)) {
				out[name] = Array.from({ length: 5 }, (_, i) => ({
					ts: T + i * 60000 + OFFSET[name],
					val: values[name],
				}));
			}
			return out;
		}

		it("resolves a grid value for every point despite the offsets", () => {
			liveChart.buffer = [];
			liveChart._mergeHistory(timelines({ battery: 1000, soc: 80, grid: 2200, house: 300, pv: 3500 }), "openapi");
			const withGrid = plain(liveChart.buffer).filter((pt) => pt.grid != null);
			assert.ok(withGrid.length > 0, "every historical grid value was discarded");
			// 3500 W of PV covering a 300 W house and 1000 W of charging is an export.
			assert.ok(
				withGrid.every((pt) => pt.grid === -2200),
				`unexpected grid values: ${JSON.stringify(withGrid.map((pt) => pt.grid))}`,
			);
		});

		it("trusts a negative historical reading without needing the other terms", () => {
			liveChart.buffer = [];
			liveChart._mergeHistory(timelines({ grid: -1800 }), "openapi");
			const points = plain(liveChart.buffer).filter((pt) => pt.grid != null);
			assert.equal(points.length, 5);
			assert.ok(points.every((pt) => pt.grid === -1800));
		});

		it("pairs each grid sample with its own cycle's terms, not the previous cycle's", () => {
			// The meter section is written after the battery section, so it sorts later; a term
			// carried only forward paired each grid sample with the previous cycle's house and
			// PV, which inverts the sign of the first point after every direction reversal.
			const T0 = 1761000000000;
			const cycles = [
				{ grid: 900, house: 1000, pv: 100, battery: 0 }, // importing
				{ grid: 900, house: 1000, pv: 100, battery: 0 },
				{ grid: 2200, house: 300, pv: 3500, battery: 1000 }, // exporting from here
				{ grid: 2200, house: 300, pv: 3500, battery: 1000 },
			];
			const pending = { grid: [], house: [], pv: [], battery: [] };
			cycles.forEach((cycle, i) => {
				const base = T0 + i * 60000;
				pending.battery.push({ ts: base + 0, val: cycle.battery });
				pending.grid.push({ ts: base + 140, val: cycle.grid });
				pending.house.push({ ts: base + 147, val: cycle.house });
				pending.pv.push({ ts: base + 152, val: cycle.pv });
			});

			liveChart.buffer = [];
			liveChart._mergeHistory(pending, "openapi");
			const grids = plain(liveChart.buffer)
				.filter((pt) => pt.grid != null)
				.map((pt) => pt.grid);
			assert.deepEqual(grids, [900, 900, -2200, -2200], `got ${JSON.stringify(grids)}`);
		});

		it("carries a term that stopped being logged across the whole range", () => {
			// setStateChangedAsync records nothing when a value does not change, so a battery
			// idling at 0 W is written once and then never again. The direction still has to
			// resolve from it hours later, or the whole export reads as an import.
			const T0 = 1761000000000;
			const pending = { grid: [], house: [], pv: [], battery: [{ ts: T0, val: 0 }] };
			for (let i = 0; i < 40; i++) {
				const base = T0 + i * 60000;
				pending.grid.push({ ts: base + 140, val: 3200 });
				pending.house.push({ ts: base + 147, val: 300 });
				pending.pv.push({ ts: base + 152, val: 3500 });
			}

			liveChart.buffer = [];
			liveChart._mergeHistory(pending, "openapi");
			const grids = plain(liveChart.buffer)
				.filter((pt) => pt.grid != null)
				.map((pt) => pt.grid);
			assert.equal(grids.length, 40);
			// 3500 W of PV, 300 W of house, nothing charging: an export, at every point.
			assert.ok(
				grids.every((g) => g === -3200),
				`a carried-forward battery term was dropped: ${JSON.stringify(grids.slice(0, 5))}`,
			);

			// The same when the one sample lands at the far end of the range, so every grid
			// point precedes it and there is nothing to carry forward from.
			pending.battery = [{ ts: T0 + 39 * 60000, val: 0 }];
			liveChart.buffer = [];
			liveChart._mergeHistory(pending, "openapi");
			const backwards = plain(liveChart.buffer)
				.filter((pt) => pt.grid != null)
				.map((pt) => pt.grid);
			assert.equal(backwards.length, 40);
			assert.ok(
				backwards.every((g) => g === -3200),
				`a term only sampled later was dropped: ${JSON.stringify(backwards.slice(0, 5))}`,
			);
		});

		it("does not read a recorded null as a measured zero", () => {
			// `markDatapointUnavailable` deliberately writes a string into a state the appliance
			// stopped reporting, and history records it. Coercing that to 0 made it a balance
			// term — and the balance decides the grid sign, so a real export rendered as an
			// import of the same magnitude.
			const T = 1761000000000;
			const base = {
				grid: [{ ts: T + 140, val: 3200 }],
				house: [{ ts: T + 147, val: 300 }],
				battery: [{ ts: T + 100, val: 0 }],
			};
			liveChart.buffer = [];
			liveChart._mergeHistory({ ...base, pv: [{ ts: T + 152, val: 3500 }] }, "openapi");
			const good = plain(liveChart.buffer).filter((pt) => pt.grid != null);
			assert.ok(
				good.every((pt) => pt.grid === -3200),
				`3500 W of PV over a 300 W house is an export: ${JSON.stringify(good.map((p) => p.grid))}`,
			);

			for (const unusable of [null, "not provided by appliance"]) {
				liveChart.buffer = [];
				liveChart._mergeHistory({ ...base, pv: [{ ts: T + 152, val: unusable }] }, "openapi");
				const pts = plain(liveChart.buffer).filter((pt) => pt.grid != null);
				assert.ok(
					pts.every((pt) => pt.pv === null || pt.pv === undefined),
					`${JSON.stringify(unusable)} was published as a PV reading`,
				);
			}
		});

		it("emits one point per cycle, not one per state write", () => {
			// Each _openapi state is its own setStateChangedAsync at its own millisecond, and
			// mergeTimelines keys on an exact timestamp — so a cycle arrives as a row per
			// state, each carrying one field. A point per row inflated the buffer with
			// near-empty objects, and a surplus-only row (surplus is not a plotted line)
			// produced a point with no data at all.
			const T = 1761000000000;
			liveChart.buffer = [];
			liveChart._mergeHistory(
				{
					battery: [{ ts: T + 0, val: -100 }],
					soc: [{ ts: T + 3, val: 60 }],
					grid: [{ ts: T + 140, val: 50 }],
					house: [{ ts: T + 147, val: 1100 }],
					pv: [{ ts: T + 152, val: 1000 }],
					surplus: [{ ts: T + 158, val: 0 }],
				},
				"openapi",
			);

			const pts = plain(liveChart.buffer);
			assert.equal(pts.length, 1, `one cycle became ${pts.length} points`);
			assert.deepEqual(
				{ pv: pts[0].pv, battery: pts[0].battery, house: pts[0].house, soc: pts[0].soc },
				{ pv: 1000, battery: -100, house: 1100, soc: 60 },
				"and it carries the whole reading, not one field of it",
			);
		});

		it("keeps the measured magnitude when a balance term was never recorded", () => {
			liveChart.buffer = [];
			liveChart._mergeHistory(timelines({ grid: 700, house: 900 }), "openapi");
			const points = plain(liveChart.buffer).filter((pt) => pt.grid != null);
			assert.equal(points.length, 5);
			assert.ok(points.every((pt) => pt.grid === 700));
		});
	});
});
