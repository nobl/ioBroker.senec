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
 * the js-controller host's local calendar day, and the context has to name that same day.
 * (The cloud aligns its buckets to the plant's local midnight; see doSumMeasurements for why
 * the host's zone is only an approximation of it.)
 *
 * The month and year fields follow the same rule; see the final test.
 */

const assert = require("node:assert/strict");

const apiClient = require("../lib/api-client");
const measurements = require("../lib/measurements");

/**
 * Run a function with a fixed wall clock and timezone.
 *
 * An async callback is only *started* by the call below, so restoring in a synchronous `finally`
 * would drop the fake clock at the callback's first `await` and run the rest of its body on the
 * real one. The restore is therefore handed to the returned promise. The synchronous path stays
 * synchronous, so `assert.throws` and non-async callers keep working.
 *
 * @param {string} iso - The instant "now" should report
 * @param {string} tz - IANA timezone name
 * @param {() => any} fn - Function to run
 * @returns {any} Whatever fn returns; a promise if fn returned one
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

	/** Puts both mutated globals back. */
	function restore() {
		global.Date = RealDate;
		if (previousTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTz;
		}
	}

	process.env.TZ = tz;
	global.Date = FakeDate;

	let result;
	try {
		result = fn();
	} catch (error) {
		restore();
		throw error;
	}

	if (result && typeof result.then === "function") {
		return result.then(
			/** @param {any} value - Resolution value of fn's promise */
			(value) => {
				restore();
				return value;
			},
			/** @param {any} error - Rejection reason of fn's promise */
			(error) => {
				restore();
				throw error;
			},
		);
	}

	restore();
	return result;
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
		return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join(
			"-",
		);
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

	it("restores the clock and the timezone after an async body rejects", async () => {
		const realDate = Date;
		const previousTz = process.env.TZ;

		await assert.rejects(
			withClock("2026-07-31T22:30:00Z", "Europe/Berlin", async () => {
				await Promise.resolve();
				throw new Error("boom");
			}),
		);

		assert.equal(global.Date, realDate, "global.Date was left replaced");
		assert.equal(process.env.TZ, previousTz, "process.env.TZ was left changed");
	});

	it("keeps the fake clock in place across an await inside the body", async () => {
		// Restoring synchronously put the real clock back at the first await, so everything an
		// async case did after that point silently ran in the machine's own timezone.
		await withClock("2026-07-31T22:30:00Z", "Europe/Berlin", async () => {
			await Promise.resolve();
			assert.equal(new Date().toISOString(), "2026-07-31T22:30:00.000Z", "now is still frozen");
			assert.equal(process.env.TZ, "Europe/Berlin", "the timezone is still the fake one");
			assert.equal(new Date().getDate(), 1, "and local getters still read 1 August");
		});
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

	it("month and year are local, matching their own consumers", () => {
		// doMeasurementsMonth reads the date back with local getters and doMeasurementsYear
		// builds its range from a local year number, so the context must name the host's own
		// calendar month/year, not UTC's. At this instant Europe/Berlin (CEST, UTC+2) is
		// already into 1 September locally.
		const ctx = contextAt("2026-08-31T22:30:00Z", "Europe/Berlin");
		assert.equal(ctx.currentMonth.toISOString(), "2026-08-31T22:00:00.000Z", "local 1 September, 00:00 CEST");
		assert.equal(ctx.lastMonth.toISOString(), "2026-07-31T22:00:00.000Z", "local 1 August, 00:00 CEST");
		assert.equal(ctx.localYear, 2026);
	});

	describe("the window doMeasurementsYear derives from a year", () => {
		/**
		 * Capture the request window doMeasurementsYear actually sends to the API for a given
		 * year and resolution, by running the real function against a stubbed apiGet rather than
		 * a copy of its arithmetic.
		 *
		 * @param {number} year - Calendar year
		 * @param {boolean} months - true for the MONTH-resolution breakdown request, false for YEAR
		 * @returns {Promise<{ start: Date, end: Date }>} The measurement window actually requested
		 */
		async function windowFor(year, months) {
			const apiClientModule = require("../lib/api-client");
			const originalApiGet = apiClientModule.apiGet;
			let captured;

			apiClientModule.apiGet = async (_adapter, url) => {
				const match = /from=([^&]+)&to=([^&]+)/.exec(url);
				captured = {
					start: new Date(decodeURIComponent(match[1])),
					end: new Date(decodeURIComponent(match[2])),
				};
				return { data: { timeSeries: [], measurements: [] } };
			};

			try {
				const adapter = {
					log: { debug() {}, silly() {} },
					config: {},
					rebuildRunning: false,
					getStateAsync: async () => null,
				};
				await measurements.doMeasurementsYear(adapter, "anlage-1", year, months);
			} finally {
				apiClientModule.apiGet = originalApiGet;
			}

			return captured;
		}

		it("resolution=YEAR (the year total) builds a local year window, not a UTC one", async () => {
			// resolution=YEAR aggregates exactly the requested range and dates its single bucket
			// at `from`; it anchors nothing to the UTC year. A UTC window would therefore ask for
			// a span offset from the calendar year the data is filed under.
			await withClock("2026-06-15T10:00:00Z", "Europe/Berlin", async () => {
				const { start, end } = await windowFor(2025, false);

				// Europe/Berlin is UTC+1 in January, so local midnight 1 Jan 2025 is 2024-12-31T23:00Z.
				assert.equal(start.toISOString(), "2024-12-31T23:00:00.000Z", "local midnight start of the year");
				assert.equal(end.toISOString(), "2025-12-31T22:59:59.999Z", "local end of the year");
			});
		});

		it("resolution=MONTH (the monthly breakdown) builds the very same window", async () => {
			await withClock("2026-06-15T10:00:00Z", "Europe/Berlin", async () => {
				const total = await windowFor(2025, false);
				const monthly = await windowFor(2025, true);

				assert.equal(monthly.start.toISOString(), total.start.toISOString(), "same start");
				assert.equal(monthly.end.toISOString(), total.end.toISOString(), "same end");
			});
		});

		for (const tz of ["Europe/Berlin", "Pacific/Auckland", "America/New_York"]) {
			it(`never inverts the window at the local New Year in ${tz}`, async () => {
				// 2026-12-31T23:30Z is already 2027 locally in Berlin and Auckland, so the poll
				// context names year 2027 while `now` is still in 2026. The UTC window for 2027
				// started at 2027-01-01T00:00Z, which clampEndDateToNow pulled back to `now` —
				// producing from > to. The local window starts at or before local midnight, which
				// is at or before `now` by construction.
				await withClock("2026-12-31T23:30:00Z", tz, async () => {
					const ctx = apiClient.apiBuildPollContext({
						lastApiDashboardPoll: 0,
						lastApiDetailsPoll: 0,
						lastApiHeavyPoll: 0,
						dashboardInterval: 360000,
						detailsInterval: 3600000,
						heavyInterval: 86400000,
					});

					for (const months of [false, true]) {
						const { start, end } = await windowFor(ctx.localYear, months);
						assert.ok(
							start.getTime() <= end.getTime(),
							`${tz} ${months ? "MONTH" : "YEAR"}: from=${start.toISOString()} must not exceed to=${end.toISOString()}`,
						);
					}
				});
			});
		}
	});

	describe("doMeasurementsMonth names the month it asked for", () => {
		/**
		 * Run doMeasurementsMonth against a stubbed apiGet and collect every doState write.
		 *
		 * @param {Date} monthStart - Local midnight of the first of the requested month
		 * @param {string} period - "current_month", "previous_month" or one of the .daily variants
		 * @param {Array<string>} bucketDates - ISO dates the stubbed response reports
		 * @param {string | null} [storedLastUpdated] - Value the stored `lastUpdated` reports
		 * @returns {Promise<{written: Map<string, unknown>, status: string}>}
		 * Every doState call plus the result status
		 */
		async function run(monthStart, period, bucketDates, storedLastUpdated = null) {
			const apiClientModule = require("../lib/api-client");
			const originalApiGet = apiClientModule.apiGet;
			const written = new Map();

			apiClientModule.apiGet = async () => ({
				data: {
					measurements: ["POWER_CONSUMPTION"],
					timeSeries: bucketDates.map((date) => ({ date, measurements: { values: [1] } })),
				},
			});

			let status;
			try {
				const adapter = {
					log: { debug() {}, silly() {} },
					config: {},
					rebuildRunning: false,
					getStateAsync: async () => (storedLastUpdated ? { val: storedLastUpdated } : null),
					async evalPoll() {},
					async doState(id, value) {
						written.set(id, value);
					},
				};
				({ status } = await measurements.doMeasurementsMonth(adapter, "anlage-1", monthStart, period));
			} finally {
				apiClientModule.apiGet = originalApiGet;
			}

			return { written, status };
		}

		it("tags current_month with the requested month, not the payload's first bucket", async () => {
			await withClock("2026-02-10T09:00:00Z", "Europe/Berlin", async () => {
				// The MONTH bucket for local February starts at 2026-01-31T23:00Z — January by UTC
				// and by a naive read of the payload.
				const { written } = await run(new Date(2026, 1, 1), "current_month", ["2026-01-31T23:00:00.000Z"]);

				assert.equal(written.get("_api.Anlagen.anlage-1.Measurements.Monthly.current_month.period"), "2026-02");
			});
		});

		it("tags previous_month with the requested month", async () => {
			await withClock("2026-01-10T09:00:00Z", "Europe/Berlin", async () => {
				const { written } = await run(new Date(2025, 11, 1), "previous_month", ["2025-11-30T23:00:00.000Z"]);

				assert.equal(
					written.get("_api.Anlagen.anlage-1.Measurements.Monthly.previous_month.period"),
					"2025-12",
				);
			});
		});

		it("tags previous_month even when the poll is skipped as already up to date", async () => {
			// previous_month is skipped for the rest of any month it was already read in. A
			// success-only write would leave an existing installation without the tag until the
			// next rollover.
			await withClock("2026-01-10T09:00:00Z", "Europe/Berlin", async () => {
				const { written, status } = await run(
					new Date(2025, 11, 1),
					"previous_month",
					[],
					"2026-01-05T04:00:00.000Z",
				);

				assert.equal(status, "skipped_existing", "the fixture must exercise the skip path");
				assert.equal(
					written.get("_api.Anlagen.anlage-1.Measurements.Monthly.previous_month.period"),
					"2025-12",
				);
			});
		});

		it("writes no tag when the month returned no data", async () => {
			await withClock("2026-02-10T09:00:00Z", "Europe/Berlin", async () => {
				const { written } = await run(new Date(2026, 1, 1), "current_month", []);

				assert.equal(
					written.has("_api.Anlagen.anlage-1.Measurements.Monthly.current_month.period"),
					false,
					"an empty response must not relabel whatever is still stored",
				);
			});
		});

		it("does not tag the daily breakdown subtree", async () => {
			await withClock("2026-02-10T09:00:00Z", "Europe/Berlin", async () => {
				const { written } = await run(new Date(2026, 1, 1), "current_month.daily", [
					"2026-01-31T23:00:00.000Z",
				]);

				assert.deepEqual([...written.keys()], [], "the tag belongs on the month node only");
			});
		});
	});

	describe("doSumMeasurements buckets by local calendar, not UTC", () => {
		/**
		 * Run doSumMeasurements against a scripted timeSeries and capture what it hands to evalPoll.
		 *
		 * @param {Array<{date: string, values: number[]}>} entries - Fixture timeSeries entries
		 * @returns {Promise<{sums: object, prefix: string}>} What evalPoll was called with
		 */
		async function sumMonthly(entries) {
			let captured = { sums: {}, prefix: "" };
			const adapter = {
				log: { debug() {}, silly() {} },
				async evalPoll(sums, prefix) {
					captured = { sums, prefix };
				},
			};
			const data = {
				measurements: ["POWER_CONSUMPTION"],
				timeSeries: entries.map((e) => ({ date: e.date, measurements: { values: [e.value] } })),
			};

			await measurements.doSumMeasurements(adapter, data, "anlage-1", "pfx.", "year.monthly", 2026);
			return captured;
		}

		it("a local month boundary lands in its own slot and year, not the UTC-shifted one", () => {
			// 2025-12-31T23:00:00.000Z is 1 January 2026, 00:00 local in Europe/Berlin (CET).
			// The old getUTCMonth() code buckets this into slot 12.
			return withClock("2026-06-01T00:00:00Z", "Europe/Berlin", async () => {
				const { sums, prefix } = await sumMonthly([{ date: "2025-12-31T23:00:00.000Z", value: 10 }]);

				assert.equal(prefix, "pfx.2026.monthly.", "stored under the requested year");
				assert.equal(sums.POWER_CONSUMPTION[1], 10, "January lands in slot 1");
				assert.equal(sums.POWER_CONSUMPTION[12], 0, "nothing lands in December");
			});
		});

		it("January does not absorb February", () => {
			// Local 1 January and local 1 February boundaries, both CET in Europe/Berlin.
			return withClock("2026-06-01T00:00:00Z", "Europe/Berlin", async () => {
				const { sums } = await sumMonthly([
					{ date: "2025-12-31T23:00:00.000Z", value: 100 },
					{ date: "2026-01-31T23:00:00.000Z", value: 200 },
				]);

				assert.equal(sums.POWER_CONSUMPTION[1], 100, "January keeps only its own value");
				assert.equal(sums.POWER_CONSUMPTION[2], 200, "February is not merged into January");
			});
		});
	});

	describe("doSumMeasurements files a year under the requested year, not the payload's", () => {
		/**
		 * Run doSumMeasurements for a YEAR-resolution total against a scripted timeSeries and
		 * capture both what it hands to evalPoll and what it wrote to the AllTime value store.
		 *
		 * @param {Array<{date: string, value: number}>} entries - Fixture timeSeries entries
		 * @param {number} [requestedYear] - Year the caller asked for
		 * @returns {Promise<{sums: object, prefix: string, valueStore: string}>}
		 * What evalPoll was called with, plus the serialised AllTime value store
		 */
		async function sumYear(entries, requestedYear) {
			let captured = { sums: {}, prefix: "", valueStore: "" };
			const adapter = {
				log: { debug() {}, silly() {} },
				async evalPoll(sums, prefix) {
					captured.sums = sums;
					captured.prefix = prefix;
				},
				async getStateAsync() {
					return null;
				},
				async doState(id, value) {
					if (String(id).endsWith("AllTime.valueStore")) {
						captured.valueStore = String(value);
					}
				},
			};
			const data = {
				measurements: ["POWER_CONSUMPTION"],
				timeSeries: entries.map((e) => ({ date: e.date, measurements: { values: [e.value] } })),
			};

			await measurements.doSumMeasurements(adapter, data, "anlage-1", "pfx.", "year", requestedYear);
			return captured;
		}

		it("a bucket dated in the neighbouring year is still stored under the requested year", async () => {
			// resolution=YEAR dates its single bucket at the request's `from`. For year 2026 in
			// Europe/Berlin that `from` is local midnight 1 January 2026 = 2025-12-31T23:00Z, so
			// reading the year back out of the payload filed the whole year under 2025.
			await withClock("2026-06-15T10:00:00Z", "Europe/Berlin", async () => {
				const { prefix, valueStore } = await sumYear([{ date: "2025-12-31T23:00:00.000Z", value: 1234 }], 2026);

				assert.equal(prefix, "pfx.2026.", "stored under the requested year, not the payload's");
				assert.deepEqual(
					JSON.parse(valueStore),
					{ POWER_CONSUMPTION: { 2026: 1234 } },
					"AllTime is keyed by the requested year too",
				);
			});
		});

		it("the same holds from a timezone behind UTC", async () => {
			// America/New_York is UTC-5 in January, so the window for 2025 starts at
			// 2025-01-01T05:00Z — within 2025 either way. The guard here is the reverse case:
			// a payload still dated 2024 must not drag the node back a year.
			await withClock("2026-06-15T10:00:00Z", "America/New_York", async () => {
				const { prefix } = await sumYear([{ date: "2024-12-31T19:00:00.000Z", value: 7 }], 2025);
				assert.equal(prefix, "pfx.2025.");
			});
		});

		it("refuses to guess the year when the caller did not pass one", async () => {
			await assert.rejects(
				sumYear([{ date: "2025-12-31T23:00:00.000Z", value: 1 }], undefined),
				/requested year/,
				"a missing requested year must fail loudly, not fall back to the payload",
			);
		});
	});
});
