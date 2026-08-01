"use strict";

/**
 * Regression tests for API partial-failure accounting.
 *
 * apiPollSingleSystem reported per-tier success but never set its own `failed` flag, so the
 * aggregate counted zero failed systems no matter what went wrong. partialFailure — the
 * warning that tells a user one of their plants is not being read — could therefore never
 * fire.
 *
 * Semantics pinned here: a system counts as failed when ANY scheduled tier did not fully
 * succeed. The alternative reading (only when every scheduled tier failed) would make the
 * single-plant case, which is the common one, unreportable: a plant whose dashboard fails
 * while details succeed is exactly the situation the warning exists for.
 */

const assert = require("node:assert/strict");

const apiClient = require("../lib/api-client");
const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");

/**
 * A per-system poll result, as apiPollSingleSystem produces it.
 *
 * @param {object} over - Fields to override
 * @returns {object} Single-system result
 */
function singleResult(over = {}) {
	return {
		failed: false,
		dashboardScheduled: false,
		detailsScheduled: false,
		heavyScheduled: false,
		dashboardSucceeded: false,
		detailsSucceeded: false,
		heavySucceeded: false,
		rebuildExecuted: false,
		...over,
	};
}

/**
 * A fresh aggregate, as apiRunPollCycle builds it.
 *
 * @returns {object} Aggregate result
 */
function totalResult() {
	return {
		anyWorkScheduled: false,
		anyWorkSucceeded: false,
		failedSystems: 0,
		dashboardScheduled: false,
		detailsScheduled: false,
		heavyScheduled: false,
		dashboardSucceeded: 0,
		detailsSucceeded: 0,
		heavySucceeded: 0,
	};
}

/**
 * Build an adapter double that polls over a scripted HTTP layer.
 *
 * @param {(url: string) => boolean} succeedsFor - Whether a URL should succeed
 * @returns {object} Fake adapter
 */
function makeAdapter(succeedsFor) {
	const adapter = {
		unloaded: false,
		baseTime: 60000,
		currentToken: "token",
		tokenExpiresAt: Date.now() + 3600000,
		apiWallboxCount: 0,
		apiKnownSystems: new Set(["plant-1"]),
		rebuildRunning: false,
		config: { api_showPolling: false, api_rebuild_mode: "off" },
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		logError() {},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
		async evalPoll() {},
		async updateLastPoll() {},
		async doState() {},
		async getStateAsync() {
			return null;
		},
		async setStateAsync() {},
	};

	adapter.apiClient = {
		async get(url) {
			if (!succeedsFor(url)) {
				const err = new Error(`Request failed for ${url}`);
				// @ts-expect-error test double mimicking an axios error
				err.response = { status: 500, data: {} };
				throw err;
			}
			return { status: 200, data: {}, headers: {} };
		},
		async post() {
			return { status: 200, data: {}, headers: {} };
		},
		async patch() {
			return { status: 200, data: {}, headers: {} };
		},
	};

	adapter.apiQueue = new AdaptiveRequestQueue({
		concurrency: 2,
		minConcurrency: 1,
		maxConcurrency: 2,
		minTimeBetweenStartsMs: 0,
		cooldownMs: 10,
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
	});

	return adapter;
}

/** Context with only the dashboard tier scheduled. */
const DASHBOARD_ONLY = {
	shouldRunDashboard: true,
	shouldRunDetails: false,
	shouldRunHeavy: false,
	today: new Date(2026, 0, 15),
	yesterday: new Date(2026, 0, 14),
	currentMonth: new Date(Date.UTC(2026, 0, 1)),
	lastMonth: new Date(Date.UTC(2025, 11, 1)),
	utcYear: 2026,
};

describe("API poll accounting", () => {
	it("a system whose scheduled tier fails is marked failed", async () => {
		const adapter = makeAdapter(() => false);

		const result = await apiClient.apiPollSingleSystem(adapter, "plant-1", DASHBOARD_ONLY, false);

		assert.equal(result.dashboardScheduled, true);
		assert.equal(result.dashboardSucceeded, false);
		assert.equal(result.failed, true, "a system with a failed scheduled tier must report failed");
	});

	it("a system whose scheduled tier succeeds is not marked failed", async () => {
		const adapter = makeAdapter(() => true);

		const result = await apiClient.apiPollSingleSystem(adapter, "plant-1", DASHBOARD_ONLY, false);

		assert.equal(result.dashboardSucceeded, true);
		assert.equal(result.failed, false);
	});

	it("a system with nothing scheduled is not a failure", async () => {
		const adapter = makeAdapter(() => false);
		const ctx = { ...DASHBOARD_ONLY, shouldRunDashboard: false };

		const result = await apiClient.apiPollSingleSystem(adapter, "plant-1", ctx, false);

		assert.equal(result.failed, false, "an idle cycle is not a failed one");
		assert.equal(result.dashboardScheduled, false);
	});

	describe("aggregation", () => {
		it("all tiers succeeding leaves no failure and no partial failure", () => {
			const total = totalResult();
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({
					failed: false,
					dashboardScheduled: true,
					detailsScheduled: true,
					dashboardSucceeded: true,
					detailsSucceeded: true,
				}),
			);

			assert.equal(total.failedSystems, 0);
			assert.equal(total.anyWorkSucceeded, true);
			assert.equal(total.failedSystems > 0 && total.anyWorkSucceeded, false, "no partial failure");
		});

		it("one tier failing while another succeeds is a partial failure", () => {
			const total = totalResult();
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({
					failed: true,
					dashboardScheduled: true,
					detailsScheduled: true,
					dashboardSucceeded: false,
					detailsSucceeded: true,
				}),
			);

			assert.equal(total.failedSystems, 1);
			assert.equal(total.anyWorkSucceeded, true);
			assert.equal(total.failedSystems > 0 && total.anyWorkSucceeded, true, "partial failure must be reported");
		});

		it("every tier failing is a total failure, not a partial one", () => {
			const total = totalResult();
			total.anyWorkScheduled = true;
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: true, dashboardScheduled: true, detailsScheduled: true }),
			);

			assert.equal(total.failedSystems, 1);
			assert.equal(total.anyWorkSucceeded, false);
			assert.equal(total.anyWorkScheduled && !total.anyWorkSucceeded, true, "total failure preserved");
			assert.equal(total.failedSystems > 0 && total.anyWorkSucceeded, false, "not a partial failure");
		});

		it("multiple systems with mixed results count only the failing ones", () => {
			const total = totalResult();
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: false, dashboardScheduled: true, dashboardSucceeded: true }),
			);
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: true, dashboardScheduled: true, dashboardSucceeded: false }),
			);
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: false, dashboardScheduled: true, dashboardSucceeded: true }),
			);

			assert.equal(total.failedSystems, 1, "one of three plants failed");
			assert.equal(total.dashboardSucceeded, 2, "and two succeeded");
		});

		it("timestamps still advance only when every system succeeded", () => {
			const total = totalResult();
			total.dashboardScheduled = true;
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: false, dashboardScheduled: true, dashboardSucceeded: true }),
			);
			apiClient.apiMergeSystemPollResult(
				total,
				singleResult({ failed: true, dashboardScheduled: true, dashboardSucceeded: false }),
			);

			const adapter = {
				apiKnownSystems: new Set(["a", "b"]),
				lastApiDashboardPoll: 0,
				lastApiDetailsPoll: 0,
				lastApiHeavyPoll: 0,
				log: { info() {}, debug() {}, warn() {} },
			};
			apiClient.apiFinalizePollTimestamps(adapter, total);

			assert.equal(adapter.lastApiDashboardPoll, 0, "a tier that did not complete everywhere must run again");
		});
	});
});
