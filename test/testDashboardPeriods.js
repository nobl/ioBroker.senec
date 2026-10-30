"use strict";

/**
 * Tests for the energy card's period browsing and its totals readers.
 *
 * Three calendars meet in this code: the portal connector rotates `current_month` by UTC, the
 * App API connector by the adapter host's local calendar, and the card renders in the browser's.
 * Any two can disagree for hours, so every case here pins the browser clock explicitly rather
 * than letting the suite's own date decide what it is testing.
 */

const assert = require("node:assert/strict");
const { loadWww, plain } = require("./wwwHarness");

const API_ID = "A1";
const API_PFX = `_api.Anlagen.${API_ID}.Measurements.`;
const WEB_PFX = "_meinsenec.Measurements.";

/**
 * Pin the card's pass clock.
 *
 * `resolveNow` is the single seam every calendar question goes through, so replacing it is
 * enough to freeze `update`, `render` and every handler at one instant.
 *
 * @param {any} energyFlow - The energy card under test
 * @param {string} iso - Local-time instant, e.g. "2026-10-29T12:00:00"
 */
function freezeClock(energyFlow, iso) {
	const fixed = new Date(iso);
	energyFlow.resolveNow = function () {
		this._now = fixed;
		this._periodScanFor = null;
		return fixed;
	};
	energyFlow._now = fixed;
}

/** Totals with every term present, consumption 10 kWh and a derivable 50 % self-sufficiency. */
const BALANCED_TOTALS = {
	todayConsumption: 10,
	todayPv: 6,
	todayGridExport: 2,
	todayBatteryCharge: 3,
	todayBatteryDischarge: 4,
};

describe("dashboard — period browsing and totals acceptance", () => {
	let ctx;
	let energyFlow;
	let app;

	beforeEach(() => {
		ctx = loadWww("energy.js");
		energyFlow = ctx.energyFlow;
		app = ctx.app;
		// Every connector is enabled by an empty config, which is what the page shows before the
		// instance object arrives. Tests that need one switched off assign a new config object —
		// connectorEnabled memoises against the object's identity, so mutating this one in place
		// would keep the previous answer.
		app.config = {};
		freezeClock(energyFlow, "2026-10-29T12:00:00");
	});

	/**
	 * Fill one portal day slot with all six metrics.
	 *
	 * @param {string} key - "current_month" or "previous_month"
	 * @param {number} day - Day of month
	 * @param {number} consumption - Consumption in kWh; every other metric is derived from it
	 */
	function webDay(key, day, consumption) {
		const pfx = `${WEB_PFX}Monthly.${key}.`;
		app.states[`${pfx}consumption.daily.${day}`] = consumption;
		app.states[`${pfx}powergenerated.daily.${day}`] = consumption * 1.5;
		app.states[`${pfx}gridimport.daily.${day}`] = consumption * 0.2;
		app.states[`${pfx}gridexport.daily.${day}`] = consumption * 0.5;
		app.states[`${pfx}accuexport.daily.${day}`] = consumption * 0.3;
		app.states[`${pfx}accuimport.daily.${day}`] = consumption * 0.2;
	}

	/**
	 * Fill one App API day slot with all six metrics.
	 *
	 * @param {string} key - "current_month" or "previous_month"
	 * @param {number} day - Day of month
	 * @param {number} consumption - Consumption in kWh; every other metric is derived from it
	 */
	function apiDay(key, day, consumption) {
		const pfx = `${API_PFX}Monthly.${key}.daily.`;
		app.states[`${pfx}POWER_CONSUMPTION.${day}`] = consumption;
		app.states[`${pfx}POWER_GENERATION.${day}`] = consumption * 1.5;
		app.states[`${pfx}GRID_IMPORT.${day}`] = consumption * 0.2;
		app.states[`${pfx}GRID_EXPORT.${day}`] = consumption * 0.5;
		app.states[`${pfx}BATTERY_IMPORT.${day}`] = consumption * 0.3;
		app.states[`${pfx}BATTERY_EXPORT.${day}`] = consumption * 0.2;
	}

	/** Make the App API branch reachable without a Dashboard subtree to discover an id from. */
	function enableApi() {
		energyFlow.apiAnlagenId = API_ID;
	}

	describe("availableDays", () => {
		it("offers the running day even with nothing stored", () => {
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [{ year: 2026, month: 10, day: 29 }]);
		});

		it("offers a stored day from either connector, oldest first", () => {
			enableApi();
			webDay("current_month", 3, 12);
			apiDay("current_month", 7, 9);
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [
				{ year: 2026, month: 10, day: 3 },
				{ year: 2026, month: 10, day: 7 },
				{ year: 2026, month: 10, day: 29 },
			]);
		});

		it("reaches back into the previous month's subtree", () => {
			webDay("previous_month", 30, 11);
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [
				{ year: 2026, month: 9, day: 30 },
				{ year: 2026, month: 10, day: 29 },
			]);
		});

		it("never offers a day later than the running one, however it got into the tree", () => {
			// A shrinking month inherits the trailing days of a longer one, so day 31 can hold a
			// stale value in a 30-day month and a future day can hold one in the running month.
			webDay("current_month", 31, 8);
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [{ year: 2026, month: 10, day: 29 }]);
		});

		it("does not offer a zero-filled slot", () => {
			// The portal writer fills all 31 slots on rotation, so presence alone says nothing.
			webDay("current_month", 4, 0);
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [{ year: 2026, month: 10, day: 29 }]);
		});

		it("drops a subtree whose own period tag names a different month", () => {
			webDay("current_month", 3, 12);
			app.states[`${WEB_PFX}Monthly.current_month.period`] = "2026-11";
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [{ year: 2026, month: 10, day: 29 }]);
		});

		it("keeps the connector whose tag agrees when the two have rotated at different times", () => {
			enableApi();
			webDay("current_month", 3, 12);
			app.states[`${WEB_PFX}Monthly.current_month.period`] = "2026-11";
			apiDay("current_month", 5, 9);
			app.states[`${API_PFX}Monthly.current_month.period`] = "2026-10";
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [
				{ year: 2026, month: 10, day: 5 },
				{ year: 2026, month: 10, day: 29 },
			]);
		});

		it("accepts a subtree that carries no tag at all", () => {
			// Installs that polled before the tag existed still have values worth showing.
			webDay("current_month", 3, 12);
			assert.equal(app.states[`${WEB_PFX}Monthly.current_month.period`], undefined);
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [
				{ year: 2026, month: 10, day: 3 },
				{ year: 2026, month: 10, day: 29 },
			]);
		});

		it("ignores a disabled connector's leftover days", () => {
			webDay("current_month", 3, 12);
			app.config = { web_use: false };
			assert.deepEqual(plain(energyFlow.availableDays(app.states)), [{ year: 2026, month: 10, day: 29 }]);
		});
	});

	describe("availablePeriods", () => {
		it("offers the running month even with nothing stored", () => {
			assert.deepEqual(plain(energyFlow.availablePeriods(app.states, "month")), [
				{ year: 2026, month: 10, day: null },
			]);
		});

		it("offers stored months and refuses future ones", () => {
			app.states[`${WEB_PFX}Yearly.2026.monthly.consumption.8`] = 300;
			app.states[`${WEB_PFX}Yearly.2026.monthly.consumption.11`] = 310;
			assert.deepEqual(plain(energyFlow.availablePeriods(app.states, "month")), [
				{ year: 2026, month: 8, day: null },
				{ year: 2026, month: 10, day: null },
			]);
		});

		it("offers stored years from the all-time series and refuses future ones", () => {
			app.states[`${WEB_PFX}AllTime.consumption.2019`] = 4000;
			app.states[`${WEB_PFX}Yearly.2025.consumption`] = 4200;
			app.states[`${WEB_PFX}AllTime.consumption.2027`] = 1;
			assert.deepEqual(plain(energyFlow.availablePeriods(app.states, "year")), [
				{ year: 2019, month: null, day: null },
				{ year: 2025, month: null, day: null },
				{ year: 2026, month: null, day: null },
			]);
		});

		it("does not offer a month whose stored total is zero", () => {
			app.states[`${WEB_PFX}Yearly.2026.monthly.consumption.8`] = 0;
			assert.deepEqual(plain(energyFlow.availablePeriods(app.states, "month")), [
				{ year: 2026, month: 10, day: null },
			]);
		});

		it("answers the day list for the day tab", () => {
			webDay("current_month", 3, 12);
			assert.deepEqual(
				plain(energyFlow.availablePeriods(app.states, "today")),
				plain(energyFlow.availableDays(app.states)),
			);
		});

		it("serves one scan per pass and rescans once the pass is re-anchored", () => {
			let scans = 0;
			const real = energyFlow.scanAvailablePeriods;
			energyFlow.scanAvailablePeriods = function (...args) {
				scans++;
				return real.apply(this, args);
			};
			energyFlow.availablePeriods(app.states, "month");
			energyFlow.availablePeriods(app.states, "month");
			assert.equal(scans, 1);
			energyFlow.resolveNow();
			energyFlow.availablePeriods(app.states, "month");
			assert.equal(scans, 2);
		});
	});

	describe("indexOfPeriod", () => {
		const list = [
			{ year: 2026, month: 10, day: 14 },
			{ year: 2026, month: 10, day: 15 },
			{ year: 2026, month: 10, day: 29 },
		];

		it("locates a listed period", () => {
			assert.equal(energyFlow.indexOfPeriod(list, { year: 2026, month: 10, day: 15 }), 1);
		});

		it("answers -1 for a period that has left the list", () => {
			// Anchoring on the newest entry instead moved the arrows onto a different period
			// from the one the heading named.
			assert.equal(energyFlow.indexOfPeriod(list, { year: 2026, month: 10, day: 20 }), -1);
		});
	});

	describe("a selected period vanishing from the tree", () => {
		beforeEach(() => {
			webDay("current_month", 15, 20);
			energyFlow.period = "today";
			energyFlow.periodYear = 2026;
			energyFlow.periodMonth = 10;
			energyFlow.periodDay = 15;
		});

		it("holds the selection while the day is still stored", () => {
			energyFlow.ensureSelectedPeriodReachable(app.states);
			assert.equal(energyFlow.periodDay, 15);
		});

		it("falls back to the running day once the day is zero-filled away", () => {
			// What a month rotation does to every day of the outgoing month in one write.
			app.states[`${WEB_PFX}Monthly.current_month.consumption.daily.15`] = 0;
			energyFlow.ensureSelectedPeriodReachable(app.states);
			assert.equal(energyFlow.periodDay, null);
			assert.equal(energyFlow.periodMonth, null);
			assert.equal(energyFlow.periodYear, null);
		});

		it("leaves the running period alone", () => {
			energyFlow.resetToRunningPeriod();
			energyFlow.ensureSelectedPeriodReachable(app.states);
			assert.equal(energyFlow.periodDay, null);
		});
	});

	describe("onPeriodStep", () => {
		it("steps back a day across a month boundary", () => {
			freezeClock(energyFlow, "2026-11-02T09:00:00");
			webDay("previous_month", 31, 14);
			app.states[`${WEB_PFX}Monthly.previous_month.period`] = "2026-10";
			energyFlow.period = "today";
			energyFlow.onPeriodStep(-1);
			assert.deepEqual(
				{ year: energyFlow.periodYear, month: energyFlow.periodMonth, day: energyFlow.periodDay },
				{ year: 2026, month: 10, day: 31 },
			);
		});

		it("steps back a month across a year boundary", () => {
			freezeClock(energyFlow, "2026-01-10T09:00:00");
			app.states[`${WEB_PFX}Yearly.2025.monthly.consumption.12`] = 500;
			energyFlow.period = "month";
			energyFlow.onPeriodStep(-1);
			assert.deepEqual({ year: energyFlow.periodYear, month: energyFlow.periodMonth }, { year: 2025, month: 12 });
		});

		it("returns to the running period rather than pinning a date to it", () => {
			webDay("current_month", 3, 12);
			energyFlow.period = "today";
			energyFlow.periodYear = 2026;
			energyFlow.periodMonth = 10;
			energyFlow.periodDay = 3;
			energyFlow.onPeriodStep(1);
			assert.equal(energyFlow.periodDay, null, "the running day is held as null, so it follows the clock");
			assert.ok(energyFlow.isRunningPeriod());
		});

		it("does nothing at the oldest stored period", () => {
			webDay("current_month", 3, 12);
			energyFlow.period = "today";
			energyFlow.periodYear = 2026;
			energyFlow.periodMonth = 10;
			energyFlow.periodDay = 3;
			energyFlow.onPeriodStep(-1);
			assert.equal(energyFlow.periodDay, 3);
		});

		it("lands on the running period when the selected one is gone", () => {
			energyFlow.period = "today";
			energyFlow.periodYear = 2026;
			energyFlow.periodMonth = 10;
			energyFlow.periodDay = 15;
			energyFlow.onPeriodStep(-1);
			assert.equal(energyFlow.periodDay, null);
		});
	});

	describe("totals acceptance", () => {
		it("reads a portal day that carries both terms", () => {
			webDay("current_month", 3, 12);
			const totals = energyFlow.readDailyTotals(app.states, `${WEB_PFX}Monthly.current_month.`, "web", 3);
			assert.equal(plain(totals).todayConsumption, 12);
			assert.equal(plain(totals).todayPv, 18);
		});

		it("refuses a day whose consumption landed without its generation", () => {
			// Each measurement type is fetched independently and settles on its own, so a single
			// failed type leaves its states unwritten while the others land.
			app.states[`${WEB_PFX}Monthly.current_month.consumption.daily.3`] = 12;
			assert.equal(energyFlow.readDailyTotals(app.states, `${WEB_PFX}Monthly.current_month.`, "web", 3), null);
		});

		it("refuses a zero-filled day even though every state is present", () => {
			webDay("current_month", 3, 0);
			assert.equal(energyFlow.readDailyTotals(app.states, `${WEB_PFX}Monthly.current_month.`, "web", 3), null);
		});

		it("refuses a period whose consumption landed without its generation", () => {
			app.states[`${WEB_PFX}Monthly.current_month.consumption`] = 400;
			assert.equal(energyFlow.readTotals(app.states, `${WEB_PFX}Monthly.current_month.`, "web", ""), null);
		});

		it("refuses a period whose stored consumption is zero", () => {
			app.states[`${WEB_PFX}Monthly.current_month.consumption`] = 0;
			app.states[`${WEB_PFX}Monthly.current_month.powergenerated`] = 0;
			assert.equal(energyFlow.readTotals(app.states, `${WEB_PFX}Monthly.current_month.`, "web", ""), null);
		});

		it("lets the API supply a day the portal has zero-filled", () => {
			// Both connectors enabled, the portal rotated first: its probe used to succeed on the
			// zero it wrote and shut the API branch out of every day it had rotated past.
			enableApi();
			webDay("current_month", 28, 0);
			apiDay("current_month", 28, 12.5);
			energyFlow.updateTotalsDay(app.states, 2026, 10, 28);
			assert.equal(energyFlow.data.todayConsumption, 12.5);
			assert.equal(energyFlow.data.todayPv, 18.75);
		});
	});

	describe("a subtree holding the wrong month", () => {
		it("refuses to label October's values as November's", () => {
			// The portal answers period=month from its own UTC calendar, so its current_month
			// rotates hours before or after the browser's does.
			freezeClock(energyFlow, "2026-11-01T00:30:00");
			webDay("current_month", 1, 11);
			app.states[`${WEB_PFX}Monthly.current_month.period`] = "2026-10";
			energyFlow.updateTotalsDay(app.states, 2026, 11, 1);
			assert.equal(energyFlow.data.todayConsumption, null);
		});

		it("reads it once the tag agrees", () => {
			freezeClock(energyFlow, "2026-11-01T00:30:00");
			webDay("current_month", 1, 11);
			app.states[`${WEB_PFX}Monthly.current_month.period`] = "2026-11";
			energyFlow.updateTotalsDay(app.states, 2026, 11, 1);
			assert.equal(energyFlow.data.todayConsumption, 11);
		});

		it("refuses a running-month total whose tag names the next month", () => {
			app.states[`${WEB_PFX}Monthly.current_month.consumption`] = 400;
			app.states[`${WEB_PFX}Monthly.current_month.powergenerated`] = 500;
			app.states[`${WEB_PFX}Monthly.current_month.period`] = "2026-11";
			energyFlow.period = "month";
			energyFlow.updateTotalsMonth(app.states);
			assert.equal(energyFlow.data.todayConsumption, null);
		});
	});

	describe("calcAutarkyFromTotals", () => {
		it("derives the share of consumption the grid did not supply", () => {
			assert.equal(energyFlow.calcAutarkyFromTotals(BALANCED_TOTALS), 50);
		});

		it("refuses a period with no consumption", () => {
			assert.equal(energyFlow.calcAutarkyFromTotals({ ...BALANCED_TOTALS, todayConsumption: 0 }), null);
			assert.equal(energyFlow.calcAutarkyFromTotals({ ...BALANCED_TOTALS, todayConsumption: null }), null);
		});

		for (const term of ["todayPv", "todayGridExport", "todayBatteryCharge", "todayBatteryDischarge"]) {
			it(`refuses rather than reading a missing ${term} as zero`, () => {
				assert.equal(energyFlow.calcAutarkyFromTotals({ ...BALANCED_TOTALS, [term]: null }), null);
			});
		}

		it("refuses a grid-charge day instead of reporting 0 %", () => {
			// Force charge and peak shaving both push grid energy into the battery, which makes
			// the derivation's numerator negative. Clamping turned that into a confident 0 %.
			const gridCharge = { ...BALANCED_TOTALS, todayPv: 1, todayBatteryCharge: 9, todayBatteryDischarge: 0 };
			assert.equal(energyFlow.calcAutarkyFromTotals(gridCharge), null);
		});

		it("refuses the matching discharge day instead of reporting 100 %", () => {
			const discharge = { ...BALANCED_TOTALS, todayPv: 2, todayGridExport: 0, todayBatteryCharge: 0 };
			assert.equal(energyFlow.calcAutarkyFromTotals({ ...discharge, todayBatteryDischarge: 9 }), null);
		});

		it("reports a genuinely fully self-supplied period", () => {
			const full = {
				todayConsumption: 10,
				todayPv: 12,
				todayGridExport: 2,
				todayBatteryCharge: 0,
				todayBatteryDischarge: 0,
			};
			assert.equal(energyFlow.calcAutarkyFromTotals(full), 100);
		});
	});

	describe("the self-sufficiency row", () => {
		it("is left out when the figure cannot be derived", () => {
			// Half a subtree used to render "Self-sufficiency 0 %" beside a dash for generation.
			energyFlow.applyTotals({ ...BALANCED_TOTALS, todayPv: null }, null);
			assert.equal(energyFlow.data.autarky, null);
			const html = energyFlow.renderDayTotals(energyFlow.data);
			assert.ok(!html.includes("Self-sufficiency"), html);
		});

		it("is shown when the cloud reports the figure itself", () => {
			energyFlow.applyTotals({ ...BALANCED_TOTALS, todayPv: null }, 73);
			assert.equal(energyFlow.data.autarky, 73);
			assert.ok(energyFlow.renderDayTotals(energyFlow.data).includes("73%"));
		});
	});

	describe("renderAutarkyPill", () => {
		/**
		 * @param {object} d - Overrides for the card's data
		 * @returns {string} The pill's markup
		 */
		const pill = (d) => energyFlow.renderAutarkyPill({ ...energyFlow.data, ...d });

		it("renders a plain badge for a local-only install with only the live figure", () => {
			app.config = { api_use: false, web_use: false };
			const html = pill({ autarkyCurrent: 62 });
			assert.ok(html.includes("62%"), html);
			assert.ok(!html.includes("<button"), "one period is not a cycle");
		});

		it("renders nothing when no period reports a figure", () => {
			app.config = { api_use: false, web_use: false };
			assert.equal(pill({ autarkyCurrent: null }), "");
		});

		it("cycles through the portal's periods", () => {
			app.config = { api_use: false };
			app.states["_meinsenec.Autarky.day"] = 71;
			app.states["_meinsenec.Autarky.week"] = 68;
			app.states["_meinsenec.Autarky.month"] = 65;
			const html = pill({ autarkyCurrent: null });
			assert.ok(html.includes("<button"), html);
			assert.ok(html.includes("71%"), html);
			energyFlow.onAutarkyPillClick();
			assert.equal(energyFlow.autarkyPeriod, "week");
		});

		it("cycles through the API's periods", () => {
			app.config = { web_use: false };
			enableApi();
			app.states[`${API_PFX}Daily.today.AUTARKY_IN_PERCENT`] = 55;
			app.states[`${API_PFX}Monthly.current_month.AUTARKY_IN_PERCENT`] = 60;
			const html = pill({ autarkyCurrent: null });
			assert.ok(html.includes("<button"), html);
			assert.ok(html.includes("55%"), html);
			energyFlow.onAutarkyPillClick();
			assert.equal(energyFlow.autarkyPeriod, "month");
		});

		it("prefers the portal's figure when both connectors report one", () => {
			enableApi();
			app.states["_meinsenec.Autarky.month"] = 65;
			app.states[`${API_PFX}Monthly.current_month.AUTARKY_IN_PERCENT`] = 60;
			energyFlow.autarkyPeriod = "month";
			assert.ok(pill({ autarkyCurrent: null }).includes("65%"));
		});

		it("drops a disabled connector's leftover figure", () => {
			app.states["_meinsenec.Autarky.day"] = 71;
			app.config = { web_use: false };
			assert.equal(pill({ autarkyCurrent: null }), "");
		});

		it("drops the whole API tree when that connector is switched off", () => {
			// `enableApi` sets the id directly, which is the one thing the readers need; this
			// pins the discovery step it bypasses, so the guard that refuses to hand a disabled
			// connector's leftover tree a live-looking prefix cannot be removed unnoticed.
			app.states["_api.Anlagen.A1.Dashboard.today.powerGenerationInWh"] = 1000;
			app.states[`${API_PFX}Daily.today.AUTARKY_IN_PERCENT`] = 55;
			energyFlow.discoverApiId(app.states);
			assert.equal(energyFlow.apiAnlagenId, "A1");

			app.config = { api_use: false, web_use: false };
			energyFlow.discoverApiId(app.states);
			assert.equal(energyFlow.apiAnlagenId, null);
			assert.equal(pill({ autarkyCurrent: null }), "");
		});
	});

	describe("one word per tab across both cards", () => {
		it("labels the day tab the same way wherever it is drawn", () => {
			const chartsCtx = loadWww(["energy.js", "charts.js"]);
			assert.equal(chartsCtx.periodTabLabel("today"), "Day");
			assert.equal(chartsCtx.periodTabLabel("month"), "Month");
			assert.equal(chartsCtx.periodTabLabel("year"), "Year");
		});
	});

	describe("the pass clock", () => {
		it("answers every calendar question of one pass from one reading", () => {
			// A fresh context, because the suite's own fixture replaces resolveNow.
			const unfrozen = loadWww("energy.js").energyFlow;
			unfrozen.resolveNow();
			const first = unfrozen.now();
			assert.equal(unfrozen.now(), first, "a pass must not re-read the clock");
			unfrozen.resolveNow();
			assert.notEqual(unfrozen.now(), first, "a new pass must re-read it");
		});

		it("anchors itself when a caller asks before a pass has started", () => {
			const unfrozen = loadWww("energy.js").energyFlow;
			assert.equal(unfrozen._now, null);
			assert.equal(unfrozen.now(), unfrozen._now);
		});
	});
});
