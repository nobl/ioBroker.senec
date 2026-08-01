"use strict";

/**
 * Regression tests for main.js retryConnectorInit().
 *
 * A connector that could not be reached at startup is retried later. For the local connector
 * that retry runs section discovery and then starts polling — but the poll forms were built
 * during startup, while the device was still unreachable. Anything discovery finds on the
 * retry therefore has to reach the forms before the first poll goes out, or the newly
 * discovered section is not requested until the adapter is restarted.
 *
 * These tests assert the call order of the real method rather than a reconstruction of it,
 * because the ordering is the whole finding.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const localClient = require("../lib/local-client");
const apiClient = require("../lib/api-client");
const webClient = require("../lib/web-client");

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
 * Replace the named module functions for the duration of a call, recording the order in
 * which they run.
 *
 * @param {object} module - Module whose exports are substituted
 * @param {Record<string, Function>} stubs - Replacements keyed by export name
 * @param {() => Promise<any>} body - Work to run
 * @returns {Promise<any>} Result of body
 */
async function withStubs(module, stubs, body) {
	const originals = {};
	for (const [name, fn] of Object.entries(stubs)) {
		originals[name] = module[name];
		module[name] = fn;
	}
	try {
		return await body();
	} finally {
		for (const [name, fn] of Object.entries(originals)) {
			module[name] = fn;
		}
	}
}

/**
 * Build an adapter instance suitable for driving retryConnectorInit.
 *
 * @returns {object} Adapter instance
 */
function makeAdapter() {
	const adapter = mainExport({});
	adapter.namespace = "senec.0";
	adapter.unloaded = false;
	adapter.baseTime = 60000;
	adapter.lalaConnected = false;
	adapter.apiConnected = false;
	adapter.webConnected = false;
	adapter.config = { interval: 10, api_interval: 6, web_interval_status: 6, lala_use: true, senecip: "192.0.2.1" };
	adapter.logs = [];
	adapter.log = {
		info(msg) {
			adapter.logs.push(["info", msg]);
		},
		debug() {},
		warn(msg) {
			adapter.logs.push(["warn", msg]);
		},
		error(msg) {
			adapter.logs.push(["error", msg]);
		},
		silly() {},
	};
	adapter.logError = () => {};
	adapter.updateConnectionStatus = async () => {};
	adapter.scheduled = [];
	adapter.setTimeout = (fn, ms) => {
		adapter.scheduled.push(ms);
		return { fn, ms };
	};
	adapter.clearTimeout = () => {};
	return adapter;
}

describe("retryConnectorInit", () => {
	describe("local", () => {
		it("rebuilds the poll forms after discovery and before the first poll", async () => {
			const adapter = makeAdapter();
			const order = [];

			await withStubs(
				localClient,
				{
					localCheckConnection: async (a) => {
						order.push("connect");
						a.lalaConnected = true;
					},
					localDiscoverSections: async () => order.push("discover"),
					localInitPollSettings: async () => order.push("rebuild"),
					localPoll: async (a, highPrio) => {
						order.push(`poll:${highPrio ? "high" : "low"}`);
					},
				},
				() => adapter.retryConnectorInit("local"),
			);

			assert.ok(order.includes("rebuild"), `poll forms were never rebuilt — order was ${order.join(" → ")}`);
			assert.ok(
				order.indexOf("discover") < order.indexOf("rebuild"),
				"the rebuild has to see what discovery found",
			);
			assert.ok(
				order.indexOf("rebuild") < order.indexOf("poll:high"),
				"polling must not start against forms built before discovery ran",
			);
			assert.ok(order.indexOf("rebuild") < order.indexOf("poll:low"));
		});

		it("does none of that when the retry did not connect", async () => {
			const adapter = makeAdapter();
			const order = [];

			await withStubs(
				localClient,
				{
					localCheckConnection: async () => {
						order.push("connect");
					},
					localDiscoverSections: async () => order.push("discover"),
					localInitPollSettings: async () => order.push("rebuild"),
					localPoll: async () => order.push("poll"),
				},
				() => adapter.retryConnectorInit("local"),
			);

			assert.deepEqual(order, ["connect"], "a failed retry must not discover, rebuild or poll");
			assert.equal(adapter.scheduled.length, 1, "it schedules another attempt instead");
		});
	});

	describe("api", () => {
		it("starts polling once the token manager reports a connection", async () => {
			const adapter = makeAdapter();
			const order = [];

			await withStubs(
				apiClient,
				{
					apiStartTokenManager: async () => {
						order.push("token");
						return true;
					},
					apiPoll: async () => order.push("poll"),
				},
				() => adapter.retryConnectorInit("api"),
			);

			assert.deepEqual(order, ["token", "poll"]);
			assert.deepEqual(adapter.scheduled, [], "a connected retry arms no further attempt");
		});

		it("schedules exactly one further attempt when the token manager reports failure", async () => {
			const adapter = makeAdapter();

			await withStubs(
				apiClient,
				{
					apiStartTokenManager: async () => false,
					apiPoll: async () => {
						throw new Error("polling must not start without a token");
					},
				},
				() => adapter.retryConnectorInit("api"),
			);

			assert.equal(adapter.scheduled.length, 1);
			assert.ok(adapter.scheduled[0] >= 10000, "retries stay off the SENEC servers' backs");
		});
	});

	describe("web", () => {
		it("leaves polling to webInit and arms no retry once connected", async () => {
			const adapter = makeAdapter();

			await withStubs(
				webClient,
				{
					webInit: async (a) => {
						a.webConnected = true;
					},
				},
				() => adapter.retryConnectorInit("web"),
			);

			assert.deepEqual(adapter.scheduled, []);
		});
	});

	it("does nothing at all once the adapter is unloading", async () => {
		const adapter = makeAdapter();
		adapter.unloaded = true;
		let touched = false;

		await withStubs(
			localClient,
			{
				localCheckConnection: async () => {
					touched = true;
				},
			},
			() => adapter.retryConnectorInit("local"),
		);

		assert.equal(touched, false);
		assert.deepEqual(adapter.scheduled, [], "a shutting-down adapter must not leave timers behind");
	});
});
