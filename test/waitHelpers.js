"use strict";

/**
 * Shared wait helpers for the suites that drive in-cycle waits.
 *
 * Not named `test*.js`, so mocha's file pattern does not collect it as a suite.
 */

const assert = require("node:assert/strict");

/**
 * Run `body` with every global timer collapsed, and fail if one was used as a real wait.
 *
 * In-cycle waits go through `adapter.delay`, which the suites' doubles settle at once, so a
 * cycle should never reach a global timer at all. Collapsing any stray one keeps the run quick;
 * the assertion is what reports it, with the call site of the first offender.
 *
 * What this detects: a bare `global.setTimeout(fn, ms > 5)` raised while `body` runs — by any
 * code, including a library's, so an unrelated offender is reported with its origin rather than
 * blamed on the adapter. What it does not detect: `node:timers/promises`, `setInterval`, a
 * `setTimeout(fn, 0)` spin, and a reference to `setTimeout` captured at module load, because the
 * modules under test are required before this patch is installed.
 *
 * The assertion runs in the `finally`: a body that throws because it leaked a timer would
 * otherwise report only the downstream symptom.
 *
 * @param {() => Promise<unknown>} body - Work to run
 * @returns {Promise<void>}
 */
async function withNoRealWait(body) {
	const real = global.setTimeout;
	const leaked = [];
	// @ts-expect-error — a test-local stand-in, restored in the finally below
	global.setTimeout = (fn, ms, ...rest) => {
		if (ms > 5) {
			const origin = new Error().stack?.split("\n")[2]?.trim() ?? "unknown call site";
			leaked.push(`${ms}ms from ${origin}`);
		}
		return real(fn, 0, ...rest);
	};
	try {
		await body();
	} finally {
		global.setTimeout = real;
		assert.deepEqual(leaked, [], "cycles wait through adapter.delay, never a global timer");
	}
}

/**
 * An `adapter.delay` double that settles at once and records what it was asked to wait.
 *
 * Recording the argument is what lets a suite pin the wait constants; without it a swapped
 * `APPROVAL_CONFIRM_WAIT_MS`/`REJECTION_CONFIRM_WAIT_MS` changes nothing a test can see.
 *
 * Any double that drives a confirmation or approval path needs this, or `adapter.delay` is
 * undefined and the resulting `TypeError` is swallowed by the poll's catch and re-surfaces as an
 * unrelated assertion about `approvalState` — a failure that says nothing about its own cause.
 *
 * @param {{waited: number[]}} adapter - Adapter double to record against
 * @returns {(ms: number) => Promise<void>} The double
 */
function recordingDelay(adapter) {
	return async (ms) => {
		adapter.waited.push(ms);
	};
}

module.exports = { withNoRealWait, recordingDelay };
