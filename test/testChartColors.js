"use strict";

/**
 * Tests for the shared chart palette.
 *
 * The charts used to each hold their own literal colors, which is how battery charge level
 * came to be teal in one and purple in the other. These load the real modules together and
 * assert what the palette is for: one color per type, reachable from every chart that draws
 * it, with the comparison series following its type rather than carrying a color of its own.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * Load the palette together with both charts that read it.
 *
 * @returns {object} The vm context, plus `writes` recording every state write attempted
 */
function loadPalette() {
	// Every `setState` the palette attempts, so the tests can read what was persisted.
	const writes = [];
	// Repaints are coalesced onto an animation frame, so the tests have to drive the clock.
	const frames = [];
	const context = vm.createContext({
		app: {
			states: {},
			config: {},
			connectors: {},
			namespace: "senec.0",
			// A connected page: `save()` refuses to claim a write it cannot deliver.
			socketLive: true,
			conn: {
				emit: (event, id, state) => {
					if (event === "setState") {
						writes.push({ id, state });
					}
				},
			},
		},
		document: { getElementById: () => null, querySelector: () => null },
		window: { location: { search: "" } },
		navigator: { language: "en" },
		requestAnimationFrame: (cb) => frames.push(cb),
		console,
	});
	// Page order, and i18n.js first: it defines the shared `escHtml` the editor markup uses.
	for (const name of ["i18n.js", "colors.js", "livechart.js", "charts.js"]) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8"), context, {
			filename: name,
		});
	}
	context.t = (key) => key;
	context.writes = writes;
	context.runFrames = () => {
		const queued = frames.splice(0, frames.length);
		queued.forEach((cb) => cb());
	};
	return context;
}

describe("dashboard — chart series colors", () => {
	describe("one color per type", () => {
		it("gives a type the same color in the live chart and the measurement history", () => {
			const ctx = loadPalette();
			assert.equal(ctx.liveChart.color("pv"), ctx.charts.color("powergenerated"));
			assert.equal(ctx.liveChart.color("house"), ctx.charts.color("consumption"));
		});

		it("gives the signed live lines their own palette entries rather than the directional ones", () => {
			const ctx = loadPalette();
			// The live chart's grid line crosses zero, so it cannot carry a direction. Separate
			// entries, so each is pickable on its own — not necessarily separate colors, since
			// the two sets never appear in one chart.
			assert.notEqual(ctx.liveChart._colorKeys.grid, ctx.charts.typeConfig.gridimport.colorKey);
			assert.notEqual(ctx.liveChart._colorKeys.grid, ctx.charts.typeConfig.gridexport.colorKey);
			assert.notEqual(ctx.liveChart._colorKeys.battery, ctx.charts.typeConfig.accuexport.colorKey);
			// Independently settable is the property that matters, so pin that too.
			ctx.chartColors.set("gridLine", "#010203");
			assert.equal(ctx.liveChart.color("grid"), "#010203");
			assert.equal(ctx.charts.color("gridexport"), ctx.chartColors.DEFAULTS.gridExport);
		});

		it("draws no two series of one chart in the same default color", () => {
			const ctx = loadPalette();
			for (const rows of [ctx.liveChart._colorRows(), ctx.charts._colorRows()]) {
				const used = rows.map((key) => ctx.chartColors.get(key));
				assert.equal(new Set(used).size, used.length, `duplicate color among ${used.join(", ")}`);
			}
		});

		it("reaches every series the charts draw, so none keeps a color nobody can change", () => {
			const ctx = loadPalette();
			const offered = new Set([...ctx.liveChart._colorRows(), ...ctx.charts._colorRows()]);
			for (const key of Object.keys(ctx.chartColors.DEFAULTS)) {
				assert.ok(offered.has(key), `${key} is in the palette but no editor offers it`);
			}
		});

		it("names a shared entry the same way in both editors", () => {
			const ctx = loadPalette();
			// Battery charge level appears in both. One pickable color with two names in two
			// editors is what the shared palette exists to stop.
			assert.ok(ctx.liveChart._colorRows().includes("batterySoc"));
			assert.ok(ctx.charts._colorRows().includes("batterySoc"));
			assert.ok(ctx.chartColors.LABEL_KEYS.batterySoc);
			for (const key of Object.keys(ctx.chartColors.DEFAULTS)) {
				assert.ok(ctx.chartColors.LABEL_KEYS[key], `${key} has no editor label`);
			}
		});
	});

	describe("picking a color", () => {
		it("shows up in both charts and is written to the adapter", () => {
			const ctx = loadPalette();
			assert.equal(ctx.chartColors.set("pv", "#123456"), true);
			assert.equal(ctx.liveChart.color("pv"), "#123456");
			assert.equal(ctx.charts.color("powergenerated"), "#123456");
			assert.equal(ctx.writes.length, 1);
			assert.equal(ctx.writes[0].id, "senec.0._dashboard.colors");
			assert.equal(ctx.writes[0].state.ack, false);
			assert.deepEqual(JSON.parse(ctx.writes[0].state.val), { pv: "#123456" });
		});

		it("stores only the deviations, so an untouched series follows a changed default", () => {
			const ctx = loadPalette();
			ctx.chartColors.set("pv", "#123456");
			ctx.chartColors.set("house", ctx.chartColors.DEFAULTS.house);
			assert.deepEqual(JSON.parse(ctx.writes[ctx.writes.length - 1].state.val), { pv: "#123456" });
		});

		it("refuses a value that is not a color, and a series that does not exist", () => {
			const ctx = loadPalette();
			assert.equal(ctx.chartColors.set("pv", "red"), false);
			assert.equal(ctx.chartColors.set("pv", "#12345"), false);
			assert.equal(ctx.chartColors.set("nosuchseries", "#123456"), false);
			assert.equal(ctx.writes.length, 0);
			assert.equal(ctx.liveChart.color("pv"), ctx.chartColors.DEFAULTS.pv);
		});

		it("puts every series of a chart back with one reset", () => {
			const ctx = loadPalette();
			ctx.chartColors.set("pv", "#123456");
			ctx.chartColors.set("gridImport", "#654321");
			const keys = ctx.charts._colorRows();
			assert.equal(ctx.chartColors.reset(keys), true);
			assert.equal(ctx.charts.color("powergenerated"), ctx.chartColors.DEFAULTS.pv);
			assert.equal(ctx.charts.color("gridimport"), ctx.chartColors.DEFAULTS.gridImport);
			assert.deepEqual(JSON.parse(ctx.writes[ctx.writes.length - 1].state.val), {});
		});
	});

	describe("adopting the palette from the adapter", () => {
		it("takes the colors another browser picked", () => {
			const ctx = loadPalette();
			assert.equal(ctx.chartColors.applyFromState(JSON.stringify({ house: "#abcdef" })), true);
			assert.equal(ctx.liveChart.color("house"), "#abcdef");
		});

		it("drops a malformed entry without losing the rest of the palette", () => {
			const ctx = loadPalette();
			const raw = JSON.stringify({ pv: "#123456", house: "not-a-color", nosuchseries: "#000000" });
			assert.equal(ctx.chartColors.applyFromState(raw), true);
			assert.equal(ctx.liveChart.color("pv"), "#123456");
			assert.equal(ctx.liveChart.color("house"), ctx.chartColors.DEFAULTS.house);
			assert.equal(ctx.chartColors.overrides.nosuchseries, undefined);
		});

		it("survives a value that is not JSON at all", () => {
			const ctx = loadPalette();
			ctx.chartColors.set("pv", "#123456");
			assert.equal(ctx.chartColors.applyFromState("{broken"), true);
			assert.equal(ctx.liveChart.color("pv"), ctx.chartColors.DEFAULTS.pv);
		});

		it("reports no change when the adapter acks back what was just written", () => {
			const ctx = loadPalette();
			ctx.chartColors.set("pv", "#123456");
			// Without this the ack re-renders every chart on every color pick.
			assert.equal(ctx.chartColors.applyFromState(ctx.writes[0].state.val), false);
		});

		it("keeps an earlier pick when a second is made before the first is published", () => {
			// Both picks happen inside one socket round trip, so the palette the adapter has
			// published still predates the first. Writing against it alone drops that pick.
			const ctx = loadPalette();
			ctx.chartColors.set("pv", "#111111");
			ctx.chartColors.set("house", "#222222");
			assert.deepEqual(JSON.parse(ctx.writes[ctx.writes.length - 1].state.val), {
				pv: "#111111",
				house: "#222222",
			});
		});

		it("refuses to claim a pick it cannot deliver while the socket is down", () => {
			// The socket object survives an outage, so it is not a liveness test on its own.
			// Reporting the pick as applied is what made a lost colour impossible to diagnose.
			const ctx = loadPalette();
			ctx.app.socketLive = false;
			ctx.chartColors.set("pv", "#123456");
			assert.equal(ctx.writes.length, 0);
			assert.equal(ctx.chartColors.saveFailed, true);

			ctx.app.socketLive = true;
			ctx.chartColors.set("house", "#abcdef");
			assert.equal(ctx.writes.length, 1);
			assert.equal(ctx.chartColors.saveFailed, false, "an old failure must not stick");
		});

		it("does not resurrect a pick whose write never went out", () => {
			// Observed against a live adapter: pick while the socket is down, reconnect, then
			// reset. The reconnect re-reads the stored palette, so the failed pick is no longer
			// in `overrides` — but if it is still pending it rides along on the next write and
			// comes back, defeating the reset the user just asked for.
			const ctx = loadPalette();
			ctx.app.socketLive = false;
			ctx.chartColors.set("wallbox", "#76ff03");
			assert.equal(ctx.writes.length, 0, "nothing was written while the socket was down");

			// Reconnect: the page adopts what the adapter actually holds.
			ctx.app.socketLive = true;
			ctx.chartColors.applyFromState(JSON.stringify({ pv: "#00e5ff" }));
			assert.equal(ctx.chartColors.get("wallbox"), ctx.chartColors.DEFAULTS.wallbox);

			ctx.chartColors.reset(Object.keys(ctx.chartColors.DEFAULTS));
			assert.deepEqual(JSON.parse(ctx.writes[ctx.writes.length - 1].state.val), {});
			assert.equal(ctx.chartColors.get("wallbox"), ctx.chartColors.DEFAULTS.wallbox);
		});
	});

	describe("comparison series", () => {
		it("offers nothing to pick, because it is drawn in its own type's color", () => {
			const ctx = loadPalette();
			const keys = ctx.charts._colorRows();
			assert.equal(
				keys.some((key) => /comp/i.test(key)),
				false,
			);
		});

		it("draws the battery level comparison in the color picked for the battery level", () => {
			const ctx = loadPalette();
			ctx.chartColors.set("batterySoc", "#0b0b0b");
			const data = [10, 40, 80, 90];
			const primary = ctx.charts.renderBatteryLine(data, data.length, 10, 10, 100, 20, 200, 10, false);
			const comparison = ctx.charts.renderBatteryLine(data, data.length, 10, 10, 100, 20, 200, 10, true);
			assert.match(primary, /stroke="#0b0b0b"/);
			assert.match(comparison, /stroke="#0b0b0b"/);
			assert.doesNotMatch(comparison, /#7e57c2/);
			// Told apart by opacity and dashing, not by hue.
			assert.match(comparison, /stroke-dasharray/);
		});

		it("colors the data table's battery level rows from the palette too", () => {
			// The table legend kept a literal while the chart, the toggle and the axis were
			// converted, so one card showed two colors for one series.
			const ctx = loadPalette();
			ctx.chartColors.set("batterySoc", "#0b0b0b");
			ctx.charts.showTable = true;
			ctx.charts.showBatteryLevel = true;
			const labels = ["0:00", "1:00", "2:00"];
			const series = { powergenerated: [1, 2, 3] };
			const batteryLevel = [10, 40, 80];
			const result = {
				current: { labels, series, batteryLevel },
				comparison: { labels, series, batteryLevel },
				compLabel: "Yesterday",
			};
			const html = ctx.charts.renderDataTable(result);
			assert.match(html, /#0b0b0b/);
			assert.doesNotMatch(html, /#7e57c2/);
		});
	});

	describe("the open editor and the periodic render", () => {
		it("holds the periodic redraw off while the editor is open", () => {
			// Replacing the markup under a native color dialog detaches the input it was opened
			// from. Both charts carry the flag the render path tests.
			const ctx = loadPalette();
			for (const owner of [ctx.liveChart, ctx.charts]) {
				assert.equal(owner._colorsOpen, false);
				owner.toggleColors();
				assert.equal(owner._colorsOpen, true);
				owner.toggleColors();
				assert.equal(owner._colorsOpen, false);
			}
		});

		it("redraws a card from its own controls, so the hold cannot freeze them", () => {
			// The hold is in app._doRender. Every control inside the two cards has to redraw
			// through its own module's refresh() instead, or opening the editor would leave the
			// card's other buttons dead — including the one that closes the editor.
			const ctx = loadPalette();
			let liveRefreshes = 0;
			let chartRefreshes = 0;
			ctx.liveChart.refresh = () => {
				liveRefreshes++;
			};
			ctx.charts.refresh = () => {
				chartRefreshes++;
			};

			ctx.liveChart._colorsOpen = true;
			ctx.liveChart.toggleLine("pv");
			ctx.liveChart.togglePause();
			assert.ok(liveRefreshes >= 2, "live chart controls must redraw their own card");

			ctx.charts._colorsOpen = true;
			ctx.charts.toggleStacked();
			ctx.charts.toggleTable();
			ctx.charts.toggleCompare();
			assert.ok(chartRefreshes >= 3, "measurement chart controls must redraw their own card");
		});

		it("does not rebuild the live chart while a drag or pinch is in progress", () => {
			// A palette change arriving from another page is not a reason to rebuild the canvas
			// under a moving finger; the periodic render has always refused to.
			const ctx = loadPalette();
			let liveRefreshes = 0;
			let chartRefreshes = 0;
			ctx.liveChart.refresh = () => {
				liveRefreshes++;
			};
			ctx.charts.refresh = () => {
				chartRefreshes++;
			};
			ctx.liveChart._dragging = true;

			ctx.chartColors.refreshCharts();
			ctx.runFrames();

			assert.equal(liveRefreshes, 0);
			assert.equal(chartRefreshes, 1);
		});

		it("coalesces several palette repaints into one frame", () => {
			const ctx = loadPalette();
			let chartRefreshes = 0;
			ctx.liveChart.refresh = () => {};
			ctx.charts.refresh = () => {
				chartRefreshes++;
			};

			ctx.chartColors.refreshCharts();
			ctx.chartColors.refreshCharts();
			ctx.chartColors.refreshCharts();
			ctx.runFrames();

			assert.equal(chartRefreshes, 1);
		});

		it("still repaints the other chart when one of them throws", () => {
			const ctx = loadPalette();
			let chartRefreshes = 0;
			ctx.liveChart.refresh = () => {
				throw new Error("boom");
			};
			ctx.charts.refresh = () => {
				chartRefreshes++;
			};

			ctx.chartColors.refreshCharts();
			ctx.runFrames();

			assert.equal(chartRefreshes, 1);
		});
	});
});
