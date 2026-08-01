"use strict";

/**
 * Regression tests for the mein-senec.de queue diagnostics.
 *
 * Two defects:
 *
 * 1. webUpdateQueueStats reads stats.pending, stats.active, stats.total and
 *    stats.successRate. AdaptiveRequestQueue.getStats() publishes none of those — it has
 *    queued, running, started, succeeded and failed. Four of the six diagnostic states were
 *    therefore written as undefined.
 * 2. The diagnostics are invoked at the end of webPollMeasurements, so they only run when
 *    web_measurements is on. web_debug_states and web_debug_log are independent settings and
 *    have to work regardless.
 */

const assert = require("node:assert/strict");

const webClient = require("../lib/web-client");
const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");

const PFX = "_meinsenec.diagnostics.queue.";

/**
 * An adapter with a real queue that has done a little work, so the counters are non-trivial.
 *
 * @param {object} [config] - Adapter config overrides
 * @returns {Promise<object>} Fake adapter
 */
async function makeAdapter(config = {}) {
	const adapter = {
		unloaded: false,
		webMasterPlantNumber: 1,
		webConnected: true,
		webAuthenticated: true,
		webStatusIntervalMs: 60000,
		webMediumIntervalMs: 6 * 3600 * 1000,
		webAbilities: {},
		written: [],
		infoLogs: [],
		config: { web_showPolling: false, web_reqnresp_log: false, web_measurements: false, ...config },
		log: {
			info(msg) {
				adapter.infoLogs.push(msg);
			},
			debug() {},
			warn() {},
			error() {},
			silly() {},
		},
		logError() {},
		setTimeout() {
			return null;
		},
		clearTimeout() {},
		async evalPoll() {},
		async updateLastPoll() {},
		async doState(id, val) {
			adapter.written.push([id, val]);
		},
		async setState() {},
		async setStateAsync() {},
		async getStateAsync() {
			return null;
		},
		async setObjectNotExistsAsync() {},
		async updateConnectionStatus() {},
	};

	adapter.webQueue = new AdaptiveRequestQueue({
		concurrency: 1,
		minConcurrency: 1,
		maxConcurrency: 2,
		minTimeBetweenStartsMs: 0,
		cooldownMs: 20,
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
	});

	// Give the queue a real history: two successes and one failure.
	await adapter.webQueue.add(async () => ({ status: 200 }));
	await adapter.webQueue.add(async () => ({ status: 200 }));
	await adapter.webQueue
		.add(async () => {
			throw new Error("boom");
		})
		.catch(() => {});

	adapter.authClient = {
		async get() {
			return { status: 200, data: {}, headers: {} };
		},
		async post() {
			return { status: 200, data: {}, headers: {} };
		},
	};

	return adapter;
}

/**
 * Diagnostic values written under the queue prefix.
 *
 * @param {object} adapter - Fake adapter
 * @returns {Array<[string, any]>} id/value pairs
 */
function diagnostics(adapter) {
	return adapter.written.filter(([id]) => id.startsWith(PFX));
}

describe("mein-senec.de queue diagnostics", () => {
	it("writes a defined, finite number to every diagnostic state", async () => {
		const adapter = await makeAdapter();

		await webClient.webUpdateQueueStats(adapter);

		const written = diagnostics(adapter);
		assert.ok(written.length > 0, "diagnostics must write something");
		for (const [id, value] of written) {
			assert.notEqual(value, undefined, `${id} was written as undefined`);
			assert.equal(typeof value, "number", `${id} is not a number (got ${typeof value})`);
			assert.ok(Number.isFinite(value), `${id} is not finite`);
		}
	});

	it("reports counts that match the queue's actual work", async () => {
		const adapter = await makeAdapter();

		await webClient.webUpdateQueueStats(adapter);

		const byId = Object.fromEntries(diagnostics(adapter));
		const stats = adapter.webQueue.getStats();

		assert.equal(
			byId[`${PFX}totalRequests`],
			stats.succeeded + stats.failed,
			"total must count finished requests, not started ones",
		);
		assert.equal(byId[`${PFX}activeRequests`], stats.running, "active must be what is in flight");
		assert.equal(byId[`${PFX}pendingRequests`], stats.queued, "pending must be what is waiting");
		assert.equal(byId[`${PFX}currentConcurrency`], stats.concurrency);
		assert.equal(byId[`${PFX}recommendedConcurrency`], stats.recommendedConcurrency);
	});

	it("counts completed requests, not requests merely started", async () => {
		// started is incremented when a task begins; succeeded/failed only when it ends. The
		// web connector starts secondary-plant polls without awaiting them, so there is
		// routinely work in flight — reporting started as "processed" overstates the total and
		// drags the success rate down by counting unfinished work as not-yet-successful.
		const adapter = await makeAdapter(); // two succeeded, one failed
		let release;
		const inFlight = new Promise((resolve) => {
			release = resolve;
		});
		const pending = adapter.webQueue.add(() => inFlight);
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(adapter.webQueue.getStats().running, 1, "precondition: one request still in flight");

		await webClient.webUpdateQueueStats(adapter);
		const byId = Object.fromEntries(diagnostics(adapter));

		assert.equal(byId[`${PFX}totalRequests`], 3, "the in-flight request has not been processed yet");
		assert.ok(
			Math.abs(byId[`${PFX}successRate`] - 66.67) < 0.5,
			`success rate ${byId[`${PFX}successRate`]} counted unfinished work`,
		);

		release({ status: 200 });
		await pending;
	});

	it("reports a success rate consistent with two successes out of three", async () => {
		const adapter = await makeAdapter();

		await webClient.webUpdateQueueStats(adapter);

		const byId = Object.fromEntries(diagnostics(adapter));
		const rate = byId[`${PFX}successRate`];
		assert.ok(rate >= 0 && rate <= 100, `success rate ${rate} is outside 0..100`);
		assert.ok(Math.abs(rate - 66.67) < 0.5, `expected about 66.67%, got ${rate}`);
	});

	it("reports 100% before anything has run, rather than dividing by zero", async () => {
		const adapter = await makeAdapter();
		adapter.webQueue = new AdaptiveRequestQueue({
			concurrency: 1,
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (id) => clearTimeout(id),
		});

		await webClient.webUpdateQueueStats(adapter);

		const byId = Object.fromEntries(diagnostics(adapter));
		assert.equal(Number.isFinite(byId[`${PFX}successRate`]), true, "an idle queue must not report NaN");
	});

	describe("independence from web_measurements", () => {
		it("writes diagnostic states during a poll with measurements switched off", async () => {
			const adapter = await makeAdapter({ web_debug_states: true, web_measurements: false });

			await webClient.webPoll(adapter);

			assert.ok(
				diagnostics(adapter).length > 0,
				"web_debug_states is its own setting and must not depend on web_measurements",
			);
		});

		it("logs queue diagnostics during a poll with measurements switched off", async () => {
			const adapter = await makeAdapter({ web_debug_log: true, web_measurements: false });

			await webClient.webPoll(adapter);

			assert.ok(
				adapter.infoLogs.some((m) => /concurrency/i.test(m)),
				"web_debug_log is its own setting and must not depend on web_measurements",
			);
		});

		it("writes nothing when both debug settings are off", async () => {
			const adapter = await makeAdapter({ web_debug_states: false, web_debug_log: false });

			await webClient.webPoll(adapter);

			assert.deepEqual(diagnostics(adapter), []);
		});
	});
});
