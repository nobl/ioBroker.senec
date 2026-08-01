"use strict";

/**
 * Regression tests for control-state subscription coverage.
 *
 * The concern these guard against: control datapoints being created for a connector while
 * nothing subscribes to them, so a user writing to the state gets silence. That is a silent
 * failure — the state exists, accepts a write, and nothing happens.
 *
 * The invariant asserted here is coverage, not a particular call site: for every control
 * object a configuration creates, some subscription pattern must match it. Where that
 * subscription comes from (the connector itself, or main.js's blanket `control.*`) is an
 * implementation detail these tests deliberately do not pin down.
 */

const assert = require("node:assert/strict");

const localClient = require("../lib/local-client");
const apiClient = require("../lib/api-client");
const webClient = require("../lib/web-client");

/** main.js subscribes this set when control_active is on — see onReady. */
const LOCAL_CONTROL_PATTERNS = ["control.*", "ENERGY.STAT_STATE", "SYS_UPDATE.USER_REBOOT_DEVICE"];

/**
 * Minimal adapter double that records object creation and subscriptions.
 *
 * @param {object} config - Adapter config (this.config)
 * @param {object} [extra] - Extra instance properties (counts, discovered abilities, ...)
 * @returns {object} Fake adapter
 */
function makeAdapter(config, extra = {}) {
	const adapter = {
		config,
		created: [],
		subscribed: [],
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		async setObjectNotExistsAsync(id) {
			adapter.created.push(id);
		},
		async subscribeStatesAsync(pattern) {
			adapter.subscribed.push(pattern);
		},
		async setStateAsync() {},
		async setState() {},
		async doState() {},
		async createSocketControlsForIndex(i) {
			adapter.created.push(`control.Sockets.${i}.Power`);
			adapter.created.push(`control.Sockets.${i}.Apply`);
		},
		...extra,
	};
	return adapter;
}

/**
 * Whether an ioBroker subscription pattern matches a state id.
 * Only the trailing `*` form is used by this adapter.
 *
 * @param {string} pattern - Subscription pattern
 * @param {string} id - State id relative to the instance namespace
 * @returns {boolean} True when the pattern covers the id
 */
function patternMatches(pattern, id) {
	if (!pattern.includes("*")) {
		return pattern === id;
	}
	return id.startsWith(pattern.slice(0, pattern.indexOf("*")));
}

/**
 * Every created control state must be covered by at least one subscription.
 *
 * @param {object} adapter - Fake adapter after control creation ran
 * @param {string[]} extraPatterns - Patterns subscribed elsewhere (main.js)
 * @returns {string[]} Created control states with no matching subscription
 */
function uncovered(adapter, extraPatterns = []) {
	const patterns = [...adapter.subscribed, ...extraPatterns];
	return adapter.created
		.filter((id) => id.startsWith("control.") && id.split(".").length > 2)
		.filter((id) => !patterns.some((p) => patternMatches(p, id)));
}

/**
 * Run every connector's control-creation entry point for one configuration.
 *
 * @param {object} config - Adapter config
 * @param {object} [extra] - Extra instance properties
 * @returns {Promise<object>} The fake adapter after creation
 */
async function createAllControls(config, extra = {}) {
	const adapter = makeAdapter(config, {
		socketCount: 2,
		wallboxCount: 1,
		apiWallboxCount: 1,
		webAbilities: { peakShaving: true, sgReady: true },
		webSocketData: [],
		...extra,
	});

	await localClient.localCreateSocketControls(adapter);
	await localClient.localCreateWallboxControls(adapter);
	await apiClient.apiCreateWallboxControls(adapter);
	if (config.control_web_active) {
		await webClient.webCreateControls(adapter);
		if (config.control_sockets_connector === "web") {
			await webClient.webCreateSocketControls(adapter, 2);
		}
	}
	return adapter;
}

describe("control subscription coverage", () => {
	it("local-only: control.* from main.js covers the local controls", async () => {
		const adapter = await createAllControls({
			control_active: true,
			control_api_active: false,
			control_web_active: false,
			control_sockets_connector: "local",
			control_wallbox_connector: "local",
		});

		assert.ok(
			adapter.created.some((id) => id.startsWith("control.Sockets.")),
			"local sockets should be created",
		);
		assert.ok(
			adapter.created.some((id) => id.startsWith("control.Wallbox.")),
			"local wallbox controls should be created",
		);
		assert.deepEqual(uncovered(adapter, LOCAL_CONTROL_PATTERNS), []);
	});

	it("web-only: web controls are subscribed without control_active", async () => {
		const adapter = await createAllControls({
			control_active: false,
			control_api_active: false,
			control_web_active: true,
			control_sockets_connector: "web",
			control_wallbox_connector: "local",
		});

		assert.ok(
			adapter.created.some((id) => id.startsWith("control.EmergencyPower.")),
			"web controls should be created",
		);
		// main.js contributes nothing here — control_active is off
		assert.deepEqual(
			uncovered(adapter),
			[],
			"web controls must be covered by the web connector's own subscriptions",
		);
		assert.ok(adapter.subscribed.includes("control.EmergencyPower.*"), "web connector subscribes its own controls");
	});

	it("web-only: no local or API controls leak in", async () => {
		const adapter = await createAllControls({
			control_active: false,
			control_api_active: false,
			control_web_active: true,
			control_sockets_connector: "web",
			control_wallbox_connector: "api",
		});

		assert.equal(
			adapter.created.some((id) => id.startsWith("control.Wallbox.")),
			false,
			"wallbox controls must not be created when no wallbox connector is enabled",
		);
	});

	it("API-only: wallbox controls are subscribed without control_active", async () => {
		const adapter = await createAllControls({
			control_active: false,
			control_api_active: true,
			control_web_active: false,
			control_sockets_connector: "local",
			control_wallbox_connector: "api",
		});

		assert.ok(
			adapter.created.some((id) => id.startsWith("control.Wallbox.")),
			"API wallbox controls should be created",
		);
		assert.deepEqual(uncovered(adapter), [], "API wallbox controls must be covered without control_active");
		assert.ok(adapter.subscribed.includes("control.Wallbox.*"));
	});

	it("all controls disabled: nothing is created and nothing is subscribed", async () => {
		const adapter = await createAllControls({
			control_active: false,
			control_api_active: false,
			control_web_active: false,
			control_sockets_connector: "local",
			control_wallbox_connector: "local",
		});

		assert.deepEqual(adapter.created, [], "no control datapoints for a user who configured none");
		assert.deepEqual(adapter.subscribed, []);
	});

	it("local wallbox controls are never created without control_active", async () => {
		// They are the one family with no subscription of their own — they depend entirely on
		// main.js's control.* subscription, which only exists when control_active is set.
		const adapter = await createAllControls({
			control_active: false,
			control_api_active: false,
			control_web_active: false,
			control_sockets_connector: "local",
			control_wallbox_connector: "local",
		});

		assert.equal(
			adapter.created.some((id) => id.startsWith("control.Wallbox.")),
			false,
		);
	});
});
