"use strict";

/**
 * `webWriteMeasurement`'s daily aggregation used to write only the days present in the
 * response. "current_month"/"previous_month" are fixed state paths recycled across calendar
 * months of different lengths, so a day that existed in a longer earlier month (e.g. day 31)
 * kept its old value forever once the label rotated onto a shorter month that never reaches
 * that day. The fix writes all 31 day slots on every poll, zeroing whatever the response does
 * not cover.
 */

const assert = require("node:assert/strict");
const { webWriteMeasurement } = require("../lib/web-client.js");

/**
 * Adapter with just enough of `doState` to record what was written.
 *
 * @returns {object} Adapter instance with a `written` map of id -> value
 */
function makeAdapter() {
	const written = {};
	return {
		written,
		doState: async (id, value) => {
			written[id] = value;
		},
	};
}

describe("webWriteMeasurement: daily aggregation does not leave trailing days stale", () => {
	it("zeroes a day absent from a shorter month's response", async () => {
		const adapter = makeAdapter();
		// A 31-day month (e.g. October) already wrote a real value for day 31.
		await webWriteMeasurement(
			adapter,
			"_meinsenec.Measurements.Monthly.current_month.",
			"POWER_CONSUMPTION",
			{ fullkwh: 100, val: [[new Date(2026, 9, 31).getTime(), 63.98]] },
			{ daily: true },
		);
		assert.equal(
			adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.31"],
			63.98,
		);

		// The label rotates onto November (30 days); its response never contains a day 31.
		await webWriteMeasurement(
			adapter,
			"_meinsenec.Measurements.Monthly.current_month.",
			"POWER_CONSUMPTION",
			{
				fullkwh: 50,
				val: [
					[new Date(2026, 10, 24).getTime(), 84.95],
					[new Date(2026, 10, 29).getTime(), 28.57],
				],
			},
			{ daily: true },
		);

		assert.equal(
			adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.30"],
			0,
			"day 30 does not exist in November and must be zeroed, not left unwritten",
		);
		assert.equal(
			adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.31"],
			0,
			"October's day-31 value must not survive the rotation into a 30-day month",
		);
		assert.equal(
			adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.24"],
			84.95,
		);
		assert.equal(
			adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.29"],
			28.57,
		);
	});

	it("writes all 31 day slots even on the first poll of a month", async () => {
		const adapter = makeAdapter();
		await webWriteMeasurement(
			adapter,
			"_meinsenec.Measurements.Monthly.current_month.",
			"POWER_CONSUMPTION",
			{ fullkwh: 10, val: [[new Date(2026, 1, 5).getTime(), 10]] }, // February
			{ daily: true },
		);
		for (let day = 1; day <= 31; day++) {
			const id = `_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.${day}`;
			assert.ok(
				Object.prototype.hasOwnProperty.call(adapter.written, id),
				`day ${day} must be written even when the month does not have that many days`,
			);
		}
		assert.equal(adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.5"], 10);
		assert.equal(adapter.written["_meinsenec.Measurements.Monthly.current_month.POWER_CONSUMPTION.daily.30"], 0);
	});
});
