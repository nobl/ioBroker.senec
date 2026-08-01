"use strict";

/**
 * Regression tests for AdaptiveRequestQueue's result classification and cooldown parsing.
 *
 * Two defects:
 *
 * 1. _process() resolves the caller's promise before consulting isSuccess(). A predicate that
 *    throws therefore escapes after the caller has already been handed a result: the queue's
 *    own accounting is skipped and the error surfaces nowhere useful.
 * 2. _applyCooldown() parses Retry-After with parseInt(), which understands delay-seconds
 *    only. RFC 9110 allows an HTTP-date, and for that parseInt() yields NaN, so the server's
 *    requested wait is discarded in favour of the generic cooldown.
 */

const assert = require("node:assert/strict");

const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");

/**
 * A queue with deterministic timers and a short generic cooldown.
 *
 * @param {object} [options] - Constructor overrides
 * @returns {AdaptiveRequestQueue} Queue
 */
function makeQueue(options = {}) {
	return new AdaptiveRequestQueue({
		concurrency: 1,
		minConcurrency: 1,
		maxConcurrency: 2,
		minTimeBetweenStartsMs: 0,
		cooldownMs: 5000,
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
		...options,
	});
}

describe("AdaptiveRequestQueue result classification", () => {
	it("hands the raw response back while counting it as a failed request", async () => {
		const queue = makeQueue();

		const res = await queue.add(async () => ({ status: 503, data: "unavailable" }), {
			isSuccess: (r) => r.status < 500,
		});

		assert.equal(res.status, 503, "a rawStatus caller still needs the response");
		const stats = queue.getStats();
		assert.equal(stats.succeeded, 0, "but it must not be counted as a success");
		assert.equal(stats.failed, 1);
	});

	it("counts a genuine success normally", async () => {
		const queue = makeQueue();

		await queue.add(async () => ({ status: 200 }), { isSuccess: (r) => r.status < 500 });

		const stats = queue.getStats();
		assert.equal(stats.succeeded, 1);
		assert.equal(stats.failed, 0);
	});

	it("does not hide an exception thrown by the predicate", async () => {
		const queue = makeQueue();
		let unhandled = null;
		const onUnhandled = (err) => {
			unhandled = err;
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			await queue.add(async () => ({ status: 200 }), {
				isSuccess: () => {
					throw new Error("predicate blew up");
				},
			});
			// Give any stray rejection a turn to surface.
			await new Promise((resolve) => setTimeout(resolve, 10));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		assert.equal(unhandled, null, "a broken predicate must not escape as an unhandled rejection");
		const stats = queue.getStats();
		assert.equal(
			stats.succeeded + stats.failed,
			1,
			"the request must be accounted for exactly once whatever the predicate did",
		);
	});

	it("treats a request whose classification failed as successful, not as lost", async () => {
		// The work itself completed; only our judgement of it broke. Counting it as a failure
		// would drive the concurrency down for a bug that has nothing to do with the server.
		const queue = makeQueue();

		const res = await queue.add(async () => ({ status: 200, data: "ok" }), {
			isSuccess: () => {
				throw new Error("predicate blew up");
			},
		});

		assert.equal(res.status, 200);
		assert.equal(queue.getStats().succeeded, 1);
	});

	it("a task with no predicate is unaffected", async () => {
		const queue = makeQueue();

		await queue.add(async () => ({ status: 429 }));

		assert.equal(queue.getStats().succeeded, 1, "without a predicate every resolved task is a success");
	});
});

describe("AdaptiveRequestQueue Retry-After handling", () => {
	/**
	 * Cooldown length the queue adopted for a given Retry-After value.
	 *
	 * @param {any} retryAfter - Header value
	 * @returns {number} Milliseconds from now
	 */
	function cooldownFor(retryAfter) {
		const queue = makeQueue();
		const before = Date.now();
		queue.noteOverloadResponse(429, retryAfter);
		return queue.cooldownUntil - before;
	}

	it("honours delay-seconds", () => {
		const waited = cooldownFor("30");
		assert.ok(waited > 29000 && waited <= 31000, `expected about 30s, got ${waited}ms`);
	});

	it("honours a future HTTP-date", () => {
		const future = new Date(Date.now() + 45000).toUTCString();
		const waited = cooldownFor(future);
		assert.ok(waited > 40000 && waited <= 47000, `expected about 45s, got ${waited}ms`);
	});

	it("falls back to the generic cooldown for an expired HTTP-date", () => {
		const past = new Date(Date.now() - 60000).toUTCString();
		const waited = cooldownFor(past);
		assert.ok(waited > 0, "a date in the past must not produce a cooldown in the past");
		assert.ok(waited <= 5000, `expected the generic 5s cooldown, got ${waited}ms`);
	});

	it("falls back for malformed values", () => {
		for (const bad of ["soon", "", null, undefined, "NaN", {}]) {
			const waited = cooldownFor(bad);
			assert.ok(waited > 0 && waited <= 5000, `value ${JSON.stringify(bad)} produced ${waited}ms`);
		}
	});

	it("caps an absurdly distant Retry-After rather than stalling for hours", () => {
		const waited = cooldownFor(String(60 * 60 * 24 * 7));
		assert.ok(waited <= 3600000, `a week-long Retry-After was adopted verbatim (${waited}ms)`);
		assert.ok(waited >= 5000, "but it must still be a real backoff");
	});

	it("honours a short delay-seconds value verbatim", () => {
		const waited = cooldownFor("1");
		assert.ok(waited >= 1000, `expected at least the requested second, got ${waited}ms`);
	});
});
