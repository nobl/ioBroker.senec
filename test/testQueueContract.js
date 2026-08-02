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
	 * A fixed instant to measure cooldowns against. Whole seconds, because HTTP-date has
	 * one-second resolution and the round trip through toUTCString() must be exact.
	 */
	const NOW = Date.parse("2026-01-01T00:00:00Z");

	/**
	 * Cooldown length the queue adopted for a given Retry-After value.
	 *
	 * The clock is frozen for the call. Reading Date.now() before it and letting the queue read
	 * it again inside measured the cooldown plus however long the two reads were apart, so any
	 * upper bound here was really "the cap, unless this machine was busy". A loaded CI runner
	 * needs only one millisecond to push a capped hour to 3600001 and fail the assertion.
	 *
	 * @param {any} retryAfter - Header value
	 * @returns {number} Milliseconds the queue decided to wait
	 */
	function cooldownFor(retryAfter) {
		const queue = makeQueue();
		const realNow = Date.now;
		Date.now = () => NOW;
		try {
			queue.noteOverloadResponse(429, retryAfter);
		} finally {
			Date.now = realNow;
		}
		return queue.cooldownUntil - NOW;
	}

	it("honours delay-seconds", () => {
		assert.equal(cooldownFor("30"), 30000);
	});

	it("honours a future HTTP-date", () => {
		const future = new Date(NOW + 45000).toUTCString();

		assert.equal(cooldownFor(future), 45000);
	});

	it("falls back to the generic cooldown for an expired HTTP-date", () => {
		const past = new Date(NOW - 60000).toUTCString();
		const waited = cooldownFor(past);

		assert.equal(waited, 5000, "a date in the past must fall back, not wait a negative time");
		assert.ok(waited > 0, "and must never schedule a cooldown in the past");
	});

	it("falls back for malformed values", () => {
		for (const bad of ["soon", "", null, undefined, "NaN", {}]) {
			assert.equal(cooldownFor(bad), 5000, `value ${JSON.stringify(bad)} should fall back`);
		}
	});

	it("caps an absurdly distant Retry-After rather than stalling for hours", () => {
		const waited = cooldownFor(String(60 * 60 * 24 * 7));

		assert.equal(waited, 3600000, "a week-long Retry-After must be capped at an hour");
		assert.ok(waited >= 5000, "but it must still be a real backoff");
	});

	it("honours a short delay-seconds value verbatim", () => {
		assert.equal(cooldownFor("1"), 1000, "a wait shorter than the generic cooldown is not raised to it");
	});
});
