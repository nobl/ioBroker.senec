"use strict";

/**
 * Regression tests for the adapter's half of the chart-colour palette.
 *
 * The browser-side tests in `testChartColors.js` cover the palette module; nothing covered
 * `main.js`. The contracts that matter here are the ones a dashboard page depends on but
 * cannot see: that the state exists with the shape the dashboard writes, that the adapter
 * subscribes to it, that an unacknowledged write is acknowledged exactly once — never twice,
 * which would be a feedback loop — and that it is never mistaken for an appliance command.
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
 * Build an adapter instance with the object and state layers recorded rather than stored.
 *
 * @returns {object} Adapter instance with `created`, `subscribed` and `written` recorders
 */
function makeAdapter() {
	const adapter = mainExport({});

	adapter.namespace = "senec.0";
	adapter.config = {};
	adapter.unloaded = false;
	adapter.created = [];
	adapter.subscribed = [];
	adapter.written = [];
	adapter.warnings = [];
	adapter.log = {
		info() {},
		debug() {},
		warn(msg) {
			adapter.warnings.push(msg);
		},
		error() {},
		silly() {},
	};

	adapter.setObjectNotExistsAsync = async (id, obj) => {
		adapter.created.push([id, obj]);
	};
	adapter.subscribeStatesAsync = async (id) => {
		adapter.subscribed.push(id);
	};
	adapter.setState = async (id, val, ack) => {
		adapter.written.push([id, val, ack]);
	};

	return adapter;
}

/** The id the dashboard writes, fully qualified as `onStateChange` receives it */
const COLORS_ID = "senec.0._dashboard.colors";

describe("dashboard chart colours — adapter side", () => {
	describe("state creation", () => {
		it("creates the channel and the state the dashboard writes", async () => {
			const adapter = makeAdapter();
			await adapter.initDashboardStates();

			const ids = adapter.created.map(([id]) => id);
			assert.deepEqual(ids, ["_dashboard", "_dashboard.colors"]);

			const [, colors] = adapter.created[1];
			assert.equal(colors.type, "state");
			// The dashboard writes a JSON string and reads it back with JSON.parse; a different
			// declared type would make every write a type mismatch against its own object.
			assert.equal(colors.common.type, "string");
			assert.equal(colors.common.role, "json");
			assert.equal(colors.common.read, true);
			// Writable on purpose: the dashboard is the only writer, over the web adapter socket.
			assert.equal(colors.common.write, true);
			assert.equal(colors.common.def, "{}");
		});

		it("subscribes, because nothing else would deliver a browser's write", async () => {
			const adapter = makeAdapter();
			await adapter.initDashboardStates();
			assert.deepEqual(adapter.subscribed, ["_dashboard.colors"]);
		});

		it("does not subscribe when the instance is already tearing down", async () => {
			const adapter = makeAdapter();
			adapter.unloaded = true;
			await adapter.initDashboardStates();
			assert.deepEqual(adapter.subscribed, []);
		});
	});

	describe("acknowledging a browser's write", () => {
		it("acknowledges an unacknowledged write exactly once", async () => {
			const adapter = makeAdapter();
			await adapter.onStateChange(COLORS_ID, { val: '{"pv":"#123456"}', ack: false });
			assert.deepEqual(adapter.written, [["_dashboard.colors", '{"pv":"#123456"}', true]]);
		});

		it("ignores its own acknowledgement, so the echo cannot loop", async () => {
			const adapter = makeAdapter();
			await adapter.onStateChange(COLORS_ID, { val: '{"pv":"#123456"}', ack: true });
			assert.deepEqual(adapter.written, []);
		});

		it("refuses a value that is not a string, which the state's own type forbids", async () => {
			const adapter = makeAdapter();
			await adapter.onStateChange(COLORS_ID, { val: 42, ack: false });
			assert.deepEqual(adapter.written, []);
			assert.equal(adapter.warnings.length, 1);
		});

		it("refuses a value far larger than a palette can be", async () => {
			const adapter = makeAdapter();
			await adapter.onStateChange(COLORS_ID, { val: "x".repeat(5000), ack: false });
			assert.deepEqual(adapter.written, []);
			assert.equal(adapter.warnings.length, 1);
		});

		it("stores a palette it cannot parse, because the dashboard filters on read", async () => {
			// Deliberately not validated as JSON here: the dashboard drops entries it does not
			// recognise, and rejecting here would make the adapter the authority on a format
			// only the dashboard defines.
			const adapter = makeAdapter();
			await adapter.onStateChange(COLORS_ID, { val: "{broken", ack: false });
			assert.deepEqual(adapter.written, [["_dashboard.colors", "{broken", true]]);
		});

		it("does not act on a write delivered during shutdown", async () => {
			const adapter = makeAdapter();
			adapter.unloaded = true;
			await adapter.onStateChange(COLORS_ID, { val: "{}", ack: false });
			assert.deepEqual(adapter.written, []);
		});
	});

	describe("separation from appliance control", () => {
		it("never reaches the control dispatch, whatever the control configuration says", async () => {
			const adapter = makeAdapter();
			// control_active gates the local control branch, so this is the configuration in
			// which a fall-through would do the most damage: the id would be sliced as a
			// control id and dispatched as an appliance command.
			adapter.config = { control_active: true };
			adapter.lalaConnected = true;

			await adapter.onStateChange(COLORS_ID, { val: '{"pv":"#123456"}', ack: false });

			// Returning after exactly this one write is what proves the branch returned rather
			// than fell through — the control path writes nothing here and would have warned.
			assert.deepEqual(adapter.written, [["_dashboard.colors", '{"pv":"#123456"}', true]]);
			assert.deepEqual(adapter.warnings, []);
		});
	});
});
