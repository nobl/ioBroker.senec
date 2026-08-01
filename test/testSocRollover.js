"use strict";

/**
 * Regression tests for the sampled-SOC day rollover across DST transitions.
 *
 * webRollOverSoc decided whether the finished day was really the day before the new one by
 * asking whether their midnights are 86400000 ms apart. In Europe/Berlin that is false twice
 * a year: the night of the spring forward is 23 hours and the night of the fall back is 25.
 * On those two days the previous day's hourly means were treated as stale and discarded
 * instead of being moved into the "yesterday" slot — and, because the same flag guards the
 * monthly filing, that day's mean never reached the month series either.
 *
 * A real gap must still be detected: after the adapter has been down over several midnights
 * the stored hours describe a day that is not yesterday, and keeping them would mislabel
 * them in a slot the dashboard presents as "yesterday" without checking its date.
 */

const assert = require("node:assert/strict");

const webClient = require("../lib/web-client");

const YESTERDAY_PFX = "_meinsenec.Measurements.Daily.yesterday.";
const CUR_MONTH_PFX = "_meinsenec.Measurements.Monthly.current_month.";

/**
 * Run an async function with a fixed wall clock and timezone.
 *
 * @param {string} iso - The instant "now" should report
 * @param {string} tz - IANA timezone name
 * @param {() => Promise<any>} fn - Function to run
 * @returns {Promise<any>} Whatever fn resolves to
 */
async function withClock(iso, tz, fn) {
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
		global.Date = FakeDate;
		return await fn();
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
 * Drive one rollover: a day's worth of sampled hours is in memory, and the clock has moved
 * on to a later day.
 *
 * @param {string} endedDayTag - The day the stored hours describe
 * @param {string} nowIso - The instant the next sample arrives
 * @param {string} tz - IANA timezone name
 * @returns {Promise<object>} The fake adapter, with its recorded writes
 */
async function rollOver(endedDayTag, nowIso, tz) {
	const adapter = {
		evalPollCalls: [],
		clearedStates: [],
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		config: {},
		async evalPoll(values, pfx, keyPrefix) {
			adapter.evalPollCalls.push({ pfx, keyPrefix, values });
		},
		async setStateAsync(id, val) {
			if (val === null) {
				adapter.clearedStates.push(id);
			}
		},
		async getStateAsync() {
			return null;
		},
		async setObjectNotExistsAsync() {},
		async doState() {},
		// A full day of sampled hourly means, already in memory
		_webSocHours: Array.from({ length: 24 }, (_, h) => 40 + h),
		_webSocDay: endedDayTag,
		_webSocDayMean: 51.5,
		_webSocBucket: null,
	};

	await withClock(nowIso, tz, () => webClient.webRecordSoc(adapter, { acculevel: { now: 55, today: 60 } }));
	return adapter;
}

/**
 * Did the finished day's hours reach the "yesterday" slot?
 *
 * @param {object} adapter - Fake adapter after a rollover
 * @returns {boolean} True when the day was carried over
 */
function carriedToYesterday(adapter) {
	return adapter.evalPollCalls.some((c) => c.pfx === YESTERDAY_PFX && c.keyPrefix === "acculevel.hourly");
}

/**
 * Did the finished day's mean reach the month series?
 *
 * @param {object} adapter - Fake adapter after a rollover
 * @returns {boolean} True when the day was filed
 */
function filedToMonth(adapter) {
	return adapter.evalPollCalls.some((c) => c.pfx === CUR_MONTH_PFX && c.keyPrefix === "acculevel.daily");
}

describe("sampled SOC day rollover", () => {
	it("rolls over across the spring-forward night (23-hour day)", async () => {
		// Europe/Berlin clocks go 02:00 → 03:00 on 2026-03-29
		const adapter = await rollOver("2026-03-29", "2026-03-29T22:05:00Z", "Europe/Berlin");

		assert.ok(carriedToYesterday(adapter), "29 March is the day before 30 March, DST or not");
		assert.ok(filedToMonth(adapter), "and its mean still belongs to the month");
	});

	it("rolls over across the fall-back night (25-hour day)", async () => {
		// Europe/Berlin clocks go 03:00 → 02:00 on 2026-10-25
		const adapter = await rollOver("2026-10-25", "2026-10-25T23:05:00Z", "Europe/Berlin");

		assert.ok(carriedToYesterday(adapter), "25 October is the day before 26 October");
		assert.ok(filedToMonth(adapter));
	});

	it("rolls over on an ordinary day", async () => {
		const adapter = await rollOver("2026-05-01", "2026-05-01T22:05:00Z", "Europe/Berlin");

		assert.ok(carriedToYesterday(adapter));
		assert.ok(filedToMonth(adapter));
	});

	it("rolls over across a month boundary", async () => {
		const adapter = await rollOver("2026-07-31", "2026-07-31T22:05:00Z", "Europe/Berlin");

		assert.ok(carriedToYesterday(adapter), "31 July is the day before 1 August");
		assert.ok(filedToMonth(adapter));
	});

	it("discards a real multi-day gap instead of labelling it yesterday", async () => {
		// The adapter was down from 2 to 4 May; the stored hours describe 1 May.
		const adapter = await rollOver("2026-05-01", "2026-05-04T10:00:00Z", "Europe/Berlin");

		assert.equal(carriedToYesterday(adapter), false, "1 May is not yesterday on 4 May");
		assert.equal(filedToMonth(adapter), false, "a partial stale day must not be filed");
		assert.ok(
			adapter.clearedStates.includes(`${YESTERDAY_PFX}acculevel`),
			"the stale yesterday mean must be cleared",
		);
	});

	it("discards a one-day gap too", async () => {
		const adapter = await rollOver("2026-05-01", "2026-05-03T10:00:00Z", "Europe/Berlin");

		assert.equal(carriedToYesterday(adapter), false, "1 May is not yesterday on 3 May");
	});

	describe("month inference from a stored daily mean", () => {
		/**
		 * Ask which month the current_month series describes, given one stored daily value.
		 *
		 * @param {number} dayIndex - Index the value is stored under
		 * @param {string} writtenAtLocal - Local time the value was written
		 * @param {string} tz - IANA timezone name
		 * @returns {Promise<string|null>} Month tag
		 */
		async function monthTagFor(dayIndex, writtenAtLocal, tz) {
			const previousTz = process.env.TZ;
			process.env.TZ = tz;
			const ts = new Date(writtenAtLocal).getTime();
			try {
				return await webClient.webSocCurrentMonthTag({
					async getStateAsync(id) {
						return id.endsWith(`.${dayIndex}`) ? { val: 55, ts } : null;
					},
				});
			} finally {
				if (previousTz === undefined) {
					delete process.env.TZ;
				} else {
					process.env.TZ = previousTz;
				}
			}
		}

		it("identifies the month on an ordinary day", async () => {
			assert.equal(await monthTagFor(1, "2026-05-02T00:00:05", "Europe/Berlin"), "2026-05");
		});

		it("identifies the month for a value frozen on the spring-forward night", async () => {
			// The day being described, 29 March 2026, is only 23 hours long in Europe/Berlin.
			assert.equal(await monthTagFor(29, "2026-03-30T00:00:05", "Europe/Berlin"), "2026-03");
		});

		it("identifies the month for a value frozen on the fall-back night", async () => {
			// 25 October 2026 is 25 hours long in Europe/Berlin.
			assert.equal(await monthTagFor(25, "2026-10-26T00:00:05", "Europe/Berlin"), "2026-10");
		});

		it("identifies the month across a month boundary", async () => {
			assert.equal(await monthTagFor(31, "2026-08-01T00:00:05", "Europe/Berlin"), "2026-07");
		});

		it("still rejects a value filed under the wrong day index", async () => {
			// A late write cannot be trusted to name the month; the day-of-month guard stays.
			assert.equal(await monthTagFor(7, "2026-05-02T00:00:05", "Europe/Berlin"), null);
		});
	});
});
