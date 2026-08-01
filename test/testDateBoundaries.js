"use strict";

/**
 * Regression tests for the day boundaries the API poll context builds.
 *
 * apiBuildPollContext read the UTC calendar fields and handed them to the *local* Date
 * constructor. For any offset ahead of UTC that names the wrong day for part of the night:
 * in Europe/Berlin at 00:30 local, UTC is still on the previous date, so "today" was built
 * as yesterday and "yesterday" as the day before that.
 *
 * Which calendar is correct is settled by the consumer, not by preference:
 * doMeasurementsDay derives its end-of-day from date.getFullYear/getMonth/getDate — local
 * getters — and sends the pair as an absolute ISO range. The window it produces is therefore
 * the plant's local calendar day, and the context has to name that same day.
 *
 * The month and year fields are deliberately left on UTC; see the final test.
 */

const assert = require("node:assert/strict");

const apiClient = require("../lib/api-client");
const measurements = require("../lib/measurements");

/**
 * Run a function with a fixed wall clock and timezone.
 *
 * @param {string} iso - The instant "now" should report
 * @param {string} tz - IANA timezone name
 * @param {() => any} fn - Function to run
 * @returns {any} Whatever fn returns
 */
function withClock(iso, tz, fn) {
	const previousTz = process.env.TZ;
	const RealDate = Date;
	const fixed = new RealDate(iso).getTime();

	class FakeDate extends RealDate {
		/** @param {any[]} args - Date constructor arguments */
		constructor(...args) {
			if (args.length === 0) {
				super(fixed);
			} else {
				// @ts-expect-error forwarding the real Date overloads
				super(...args);
			}
		}
		/** @returns {number} The frozen instant */
		static now() {
			return fixed;
		}
	}

	try {
		process.env.TZ = tz;
		global.Date = /** @type {any} */ (FakeDate);
		return fn();
	} finally {
		global.Date = RealDate;
		if (previousTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTz;
		}
	}
}

/**
 * Build a poll context under a fixed clock.
 *
 * @param {string} iso - The instant "now" should report
 * @param {string} tz - IANA timezone name
 * @returns {object} The context
 */
function contextAt(iso, tz) {
	return withClock(iso, tz, () =>
		apiClient.apiBuildPollContext({
			lastApiDashboardPoll: 0,
			lastApiDetailsPoll: 0,
			lastApiHeavyPoll: 0,
			dashboardInterval: 360000,
			detailsInterval: 3600000,
			heavyInterval: 86400000,
		}),
	);
}

/**
 * Local calendar day of a Date, as "YYYY-MM-DD".
 *
 * @param {Date} d - Date to format
 * @param {string} tz - Timezone the assertion is made in
 * @returns {string} Local day tag
 */
function localDay(d, tz) {
	const previousTz = process.env.TZ;
	process.env.TZ = tz;
	try {
		return [
			d.getFullYear(),
			String(d.getMonth() + 1).padStart(2, "0"),
			String(d.getDate()).padStart(2, "0"),
		].join("-");
	} finally {
		if (previousTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTz;
		}
	}
}

describe("API poll context day boundaries", () => {
	const cases = [
		// [description, instant, timezone, expected local "today"]
		["Europe/Berlin, just before local midnight (CEST)", "2026-07-31T21:30:00Z", "Europe/Berlin", "2026-07-31"],
		["Europe/Berlin, just after local midnight (CEST)", "2026-07-31T22:30:00Z", "Europe/Berlin", "2026-08-01"],
		["Europe/Berlin, just before local midnight (CET)", "2026-01-14T22:30:00Z", "Europe/Berlin", "2026-01-14"],
		["Europe/Berlin, just after local midnight (CET)", "2026-01-14T23:30:00Z", "Europe/Berlin", "2026-01-15"],
		["Europe/Berlin, month rollover", "2026-08-31T22:30:00Z", "Europe/Berlin", "2026-09-01"],
		["Europe/Berlin, year rollover", "2025-12-31T23:30:00Z", "Europe/Berlin", "2026-01-01"],
		["Pacific/Auckland, ahead of UTC", "2026-07-31T21:00:00Z", "Pacific/Auckland", "2026-08-01"],
		["America/New_York, behind UTC", "2026-08-01T01:00:00Z", "America/New_York", "2026-07-31"],
		["UTC itself", "2026-08-01T00:30:00Z", "UTC", "2026-08-01"],
	];

	for (const [name, iso, tz, expected] of cases) {
		it(`${name} → today is ${expected}`, () => {
			const ctx = contextAt(iso, tz);
			assert.equal(localDay(ctx.today, tz), expected);
		});
	}

	it("restores the clock and the timezone even when the body throws", () => {
		// The harness mutates two globals. Mocha runs serially here, so a leak would not race
		// — it would silently corrupt every later test in the run instead.
		const realDate = Date;
		const previousTz = process.env.TZ;

		assert.throws(() =>
			withClock("2026-07-31T22:30:00Z", "Europe/Berlin", () => {
				throw new Error("boom");
			}),
		);

		assert.equal(global.Date, realDate, "global.Date was left replaced");
		assert.equal(process.env.TZ, previousTz, "process.env.TZ was left changed");
	});

	it("today starts at local midnight, not at some other hour", () => {
		const ctx = contextAt("2026-07-31T22:30:00Z", "Europe/Berlin");
		withClock("2026-07-31T22:30:00Z", "Europe/Berlin", () => {
			assert.equal(ctx.today.getHours(), 0);
			assert.equal(ctx.today.getMinutes(), 0);
			assert.equal(ctx.today.getSeconds(), 0);
			assert.equal(ctx.today.getMilliseconds(), 0);
		});
	});

	it("yesterday is the calendar day before today, across a DST spring forward", () => {
		// Europe/Berlin loses an hour in the night of 2026-03-29, so "24 hours earlier" and
		// "the previous calendar day" are not the same instant.
		const ctx = contextAt("2026-03-29T22:30:00Z", "Europe/Berlin");
		assert.equal(localDay(ctx.today, "Europe/Berlin"), "2026-03-30");
		assert.equal(localDay(ctx.yesterday, "Europe/Berlin"), "2026-03-29");
	});

	it("yesterday is the calendar day before today, across a DST fall back", () => {
		const ctx = contextAt("2026-10-25T23:30:00Z", "Europe/Berlin");
		assert.equal(localDay(ctx.today, "Europe/Berlin"), "2026-10-26");
		assert.equal(localDay(ctx.yesterday, "Europe/Berlin"), "2026-10-25");
	});

	it("yesterday is the calendar day before today across a month boundary", () => {
		const ctx = contextAt("2026-08-01T10:00:00Z", "Europe/Berlin");
		assert.equal(localDay(ctx.today, "Europe/Berlin"), "2026-08-01");
		assert.equal(localDay(ctx.yesterday, "Europe/Berlin"), "2026-07-31");
	});

	describe("the window doMeasurementsDay derives from these dates", () => {
		/**
		 * Reproduce doMeasurementsDay's own window arithmetic for a context date.
		 *
		 * @param {Date} date - ctx.today or ctx.yesterday
		 * @returns {{ start: Date, end: Date }} The measurement window
		 */
		function windowFor(date) {
			const rawEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
			return { start: date, end: measurements.clampEndDateToNow(rawEnd) };
		}

		it("today's window starts at local midnight and is clamped to now", () => {
			// 00:30 local on 1 August — the window that used to be built for 31 July.
			withClock("2026-07-31T22:30:00Z", "Europe/Berlin", () => {
				const ctx = apiClient.apiBuildPollContext({
					lastApiDashboardPoll: 0,
					lastApiDetailsPoll: 0,
					lastApiHeavyPoll: 0,
					dashboardInterval: 360000,
					detailsInterval: 3600000,
					heavyInterval: 86400000,
				});
				const { start, end } = windowFor(ctx.today);

				assert.equal(start.getDate(), 1, "the window starts on the local day");
				assert.equal(start.getHours(), 0);
				assert.ok(end.getTime() <= Date.now(), "a partial day must not ask for the future");
				assert.ok(end.getTime() > start.getTime(), "and must still be a usable range");
				assert.equal(end.getDate(), start.getDate(), "start and end describe one calendar day");
			});
		});

		it("yesterday's window covers the whole previous local day", () => {
			withClock("2026-07-31T22:30:00Z", "Europe/Berlin", () => {
				const ctx = apiClient.apiBuildPollContext({
					lastApiDashboardPoll: 0,
					lastApiDetailsPoll: 0,
					lastApiHeavyPoll: 0,
					dashboardInterval: 360000,
					detailsInterval: 3600000,
					heavyInterval: 86400000,
				});
				const { start, end } = windowFor(ctx.yesterday);

				assert.equal(start.getDate(), 31, "yesterday is 31 July, not 30 July");
				assert.equal(start.getHours(), 0);
				assert.equal(end.getDate(), 31, "and its window ends on the same day");
				assert.equal(end.getHours(), 23, "a finished day is not clamped");
			});
		});
	});

	it("month and year stay on UTC, matching their own consumers", () => {
		// doMeasurementsMonth reads date.getUTCFullYear()/getUTCMonth() and doMeasurementsYear
		// builds its range with Date.UTC. Moving these to local without changing those
		// functions would silently shift the window by the UTC offset, so the split is
		// deliberate and pinned here rather than quietly "made consistent".
		const ctx = contextAt("2026-08-31T22:30:00Z", "Europe/Berlin");
		assert.equal(ctx.currentMonth.toISOString(), "2026-08-01T00:00:00.000Z");
		assert.equal(ctx.lastMonth.toISOString(), "2026-07-01T00:00:00.000Z");
		assert.equal(ctx.utcYear, 2026);
	});
});
