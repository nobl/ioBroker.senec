"use strict";

const { API_PFX, LAST_UPDATED, API_HOST_MEASUREMENTS } = require("./constants.js");

/**
 * @param {string | number} anlagenId - Anlagen/system ID
 * @param {string} resolution - Resolution string (YEAR, MONTH, DAY, HOUR)
 * @param {string} start - URL-encoded start date ISO string
 * @param {string} end - URL-encoded end date ISO string
 * @param {string} tier - Tier name for prefix (Daily, Monthly, Yearly)
 * @param {{ uuid: string, index: number }} [wallbox] - Wallbox info, or undefined for regular measurements
 * @returns {{ url: string, pfx: string }} The measurement URL and state prefix
 */
function buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, tier, wallbox) {
	let url;
	let pfx;
	if (wallbox) {
		url =
			`${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/wallboxes/measurements` +
			`?wallboxIds=${encodeURIComponent(wallbox.uuid)}&resolution=${resolution}&from=${start}&to=${end}`;
		pfx = `${API_PFX}Anlagen.${anlagenId}.WallboxMeasurements.${wallbox.index}.${tier}.`;
	} else {
		url = `${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=${resolution}&from=${start}&to=${end}`;
		pfx = `${API_PFX}Anlagen.${anlagenId}.Measurements.${tier}.`;
	}
	return { url, pfx };
}

/**
 * Poll measurements by year
 *
 * @param {string | number} anlagenId Anlagen ID to read measurements for
 * @param {number} year Year to read measurements for
 * @param {boolean} months Read monthly measurements
 * @param {{ uuid: string, index: number }} [wallbox] Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request indicating success, absence of data, or that the data was already up to date.
 */
async function doMeasurementsYear(anlagenId, year, months, wallbox) {
	this.log.debug(`🔄 Reading measurements for year: ${year}${months ? ".monthly" : ""}`);

	const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
	const rawEndDate = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1);
	const endDate = this.clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	let resolution = "YEAR";
	if (months) {
		resolution = "MONTH";
	}

	const { url, pfx } = this.buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Yearly", wallbox);
	const lastUpdate = await this.getStateAsync(`${pfx}${year}.${months ? "monthly." : ""}${LAST_UPDATED}`);
	const now = new Date();
	let lastDate = null;

	if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
		lastDate = new Date(String(lastUpdate.val));
	}

	if (year !== new Date().getUTCFullYear()) {
		if (
			!this.rebuildRunning &&
			lastDate != null &&
			!isNaN(lastDate.getTime()) &&
			lastDate.getUTCFullYear() === now.getUTCFullYear()
		) {
			this.log.silly(`Measurements for ${year}${months ? ".monthly" : ""} already updated this year. Skipping.`);
			return { status: "skipped_existing" };
		}
	} else {
		if (
			!this.rebuildRunning &&
			lastDate != null &&
			!isNaN(lastDate.getTime()) &&
			lastDate.getUTCFullYear() === now.getUTCFullYear() &&
			lastDate.getUTCMonth() === now.getUTCMonth() &&
			lastDate.getUTCDate() === now.getUTCDate()
		) {
			this.log.silly(`Measurements for ${year}${months ? ".monthly" : ""} already updated today. Skipping.`);
			return { status: "skipped_existing" };
		}
	}

	const label = `${year}${months ? ".monthly" : ""}`;
	this.log.debug(`Measurement window YEAR (${label}): from=${startDate.toISOString()} to=${endDate.toISOString()}`);
	this.log.debug(`🔄 Polling measurements for ${url}`);

	return this._fetchAndSumMeasurements(url, anlagenId, pfx, `year${months ? ".monthly" : ""}`, label);
}

/**
 * Poll measurements by month
 *
 * @param {string | number} anlagenId Anlagen ID to read measurements for
 * @param {Date} date Date to read measurements for
 * @param {string} period period to sum for
 * @param {{ uuid: string, index: number }} [wallbox] Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request indicating success, absence of data, or that the data was already up to date.
 */
async function doMeasurementsMonth(anlagenId, date, period, wallbox) {
	this.log.debug(`🔄 Reading measurements for ${period}.`);

	const startDate = date;
	const rawEndDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
	const endDate = this.clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	let resolution = "MONTH";
	if (period === "current_month.daily" || period === "previous_month.daily") {
		resolution = "DAY";
	}

	const { url, pfx } = this.buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Monthly", wallbox);

	if (period === "previous_month" || period === "previous_month.daily") {
		const lastUpdate = await this.getStateAsync(`${pfx}${period}.${LAST_UPDATED}`);

		if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
			const lastDate = new Date(String(lastUpdate.val));

			if (
				!this.rebuildRunning &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getUTCFullYear() === new Date().getUTCFullYear() &&
				lastDate.getUTCMonth() === new Date().getUTCMonth()
			) {
				this.log.silly(`Measurements for ${period} already updated this month. Skipping.`);
				return { status: "skipped_existing" };
			}
		}
	}

	this.log.debug(`Measurement window MONTH (${period}): from=${startDate.toISOString()} to=${endDate.toISOString()}`);
	this.log.debug(`🔄 Polling measurements for ${url}`);

	return this._fetchAndSumMeasurements(url, anlagenId, pfx, period, period);
}

/**
 * Poll measurements by day
 *
 * @param {string | number} anlagenId Anlagen ID to read measurements for
 * @param {Date} date Date to read measurements for
 * @param {string} period period to sum for
 * @param {{ uuid: string, index: number }} [wallbox] Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request indicating success, absence of data, or that the data was already up to date.
 */
async function doMeasurementsDay(anlagenId, date, period, wallbox) {
	this.log.debug(`🔄 Reading measurements for ${period}`);

	const startDate = date;
	const rawEndDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
	const endDate = this.clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	let resolution = "DAY";
	if (period === "today.hourly" || period === "yesterday.hourly") {
		resolution = "HOUR";
	}

	const { url, pfx } = this.buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Daily", wallbox);

	if (period === "yesterday" || period === "yesterday.hourly") {
		const lastUpdate = await this.getStateAsync(`${pfx}${period}.${LAST_UPDATED}`);

		if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
			const lastDate = new Date(String(lastUpdate.val));

			if (
				!this.rebuildRunning &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getFullYear() === new Date().getFullYear() &&
				lastDate.getMonth() === new Date().getMonth() &&
				lastDate.getDate() === new Date().getDate()
			) {
				this.log.silly(`Measurements for ${period} already updated today. Skipping.`);
				return { status: "skipped_existing" };
			}
		}
	}

	this.log.debug(`Measurement window DAY (${period}): from=${startDate.toISOString()} to=${endDate.toISOString()}`);
	this.log.debug(`🔄 Polling measurements for ${url}`);

	return this._fetchAndSumMeasurements(url, anlagenId, pfx, period, period);
}

/**
 * Fetch measurements from API, validate, and sum.
 * Shared tail for doMeasurementsYear/Month/Day.
 *
 * @param {string} url - API URL to fetch
 * @param {string | number} anlagenId - System ID
 * @param {string} pfx - State prefix
 * @param {string} period - Period label for doSumMeasurements
 * @param {string} logLabel - Human-readable label for log messages
 * @returns {Promise<{status: "success" | "no_data"}>} Result of the measurement fetch
 */
async function _fetchAndSumMeasurements(url, anlagenId, pfx, period, logLabel) {
	const measurements = await this.apiGet(url);

	const ts = measurements?.data?.timeSeries || measurements?.data?.timeseries;
	if (!measurements?.data || !Array.isArray(ts)) {
		throw new Error(`Malformed measurement response for ${url}`);
	}

	if (ts.length === 0) {
		this.log.debug(`No measurements found for ${logLabel}.`);
		return { status: "no_data" };
	}

	await this.doSumMeasurements(measurements.data, anlagenId, pfx, period);
	return { status: "success" };
}

/**
 * Sums the measurements based on the provided period and updates the relevant states.
 * The method iterates through the measurement data and sums the values based on the specified period (e.g., hourly, daily, monthly).
 * It updates the sums for each measurement key and then evaluates the poll to update the relevant states with the calculated sums.
 *
 * @param {object} data measurement data
 * @param {string | number} anlagenId Anlagen ID
 * @param {string} pfx prefix for state
 * @param {string} period period to sum for
 */
async function doSumMeasurements(data, anlagenId, pfx, period) {
	this.log.debug(`Measurements sample: ${JSON.stringify(data).slice(0, 500)}`);
	// Wallbox measurements use lowercase "timeseries"/"measurements", regular uses camelCase
	const timeSeries = data.timeSeries || data.timeseries;
	const measurementKeys = data.measurements;
	const sums = Object.fromEntries(measurementKeys.map((key) => [key, 0]));
	const year = new Date(timeSeries[0].date).getUTCFullYear();

	// Durch timeSeries iterieren und Werte addieren
	timeSeries.forEach((entry) => {
		entry.measurements.values.forEach((value, index) => {
			const key = measurementKeys[index];
			if (period === "today.hourly" || period === "yesterday.hourly") {
				if (sums[key] === undefined || !sums[key]) {
					sums[key] = Array(24).fill(0);
				}
				sums[key][new Date(entry.date).getHours()] += value;
			} else if (period === "current_month.daily" || period === "previous_month.daily") {
				if (sums[key] === undefined || !sums[key]) {
					sums[key] = Array(32).fill(0);
				}
				sums[key][new Date(entry.date).getDate()] += value;
			} else if (period === "year.monthly") {
				if (sums[key] === undefined || !sums[key]) {
					sums[key] = Array(13).fill(0);
				}
				sums[key][new Date(entry.date).getUTCMonth() + 1] += value;
			} else {
				sums[key] += value;
			}
		});
	});
	sums[LAST_UPDATED] = new Date().toISOString();

	this.log.silly(`Sums: ${JSON.stringify(sums)}`);
	let groupBy;
	switch (period) {
		case "year":
			groupBy = year;
			await this.insertIntoAllTimeValueStore(sums, anlagenId, year);
			break;
		case "year.monthly":
			groupBy = `${year}.monthly`;
			break;
		default:
			groupBy = period;
	}
	await this.evalPoll(sums, `${pfx + groupBy}.`);
}

/**
 * Builds a compact summary of measurement result statuses.
 *
 * @param {Array<{label: string; status: string}>} results - kind of status
 * @returns {{success: number; no_data: number; skipped_existing: number; total: number}}
 * Aggregated count of result statuses.
 */
function summarizeMeasurementResults(results) {
	const summary = {
		success: 0,
		no_data: 0,
		skipped_existing: 0,
		total: results.length,
	};

	for (const result of results) {
		if (result && result.status && summary[result.status] !== undefined) {
			summary[result.status]++;
		}
	}

	return summary;
}

/**
 * Formats a measurement result summary for log output.
 *
 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - type of measurement result
 * @returns {string} Human-readable summary string.
 */
function formatMeasurementSummary(summary) {
	return (
		`success=${summary.success}, ` +
		`no_data=${summary.no_data}, ` +
		`skipped_existing=${summary.skipped_existing}, ` +
		`total=${summary.total}`
	);
}

/**
 * Classifies aggregated measurement results into a higher-level health state.
 *
 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - type of measurement result
 * @returns {"productive" | "up_to_date" | "empty" | "mixed" | "unknown"}
 * High-level interpretation of the measurement results.
 */
function classifyMeasurementSummary(summary) {
	if (!summary || summary.total <= 0) {
		return "unknown";
	}

	if (summary.success === summary.total) {
		return "productive";
	}

	if (summary.skipped_existing === summary.total) {
		return "up_to_date";
	}

	if (summary.no_data === summary.total) {
		return "empty";
	}

	if (summary.success > 0 || summary.no_data > 0 || summary.skipped_existing > 0) {
		return "mixed";
	}

	return "unknown";
}

/**
 * Returns a human-readable explanation for a classified measurement summary.
 *
 * @param {"productive" | "up_to_date" | "empty" | "mixed" | "unknown"} classification - measurements were classified as
 * @returns {string} Description for log output.
 */
function formatMeasurementClassification(classification) {
	switch (classification) {
		case "productive":
			return "new data fetched successfully";
		case "up_to_date":
			return "all requested data already up to date";
		case "empty":
			return "API returned no data for all requests";
		case "mixed":
			return "mixed result set";
		default:
			return "result unclear";
	}
}

/**
 * Clamp an end date so it never lies in the future.
 *
 * @param {Date} endDate calculated period end
 * @returns {Date} endDate or current time, whichever is earlier
 */
function clampEndDateToNow(endDate) {
	const now = new Date();
	return endDate.getTime() > now.getTime() ? now : endDate;
}

module.exports = {
	buildMeasurementUrlAndPrefix,
	doMeasurementsYear,
	doMeasurementsMonth,
	doMeasurementsDay,
	_fetchAndSumMeasurements,
	doSumMeasurements,
	summarizeMeasurementResults,
	formatMeasurementSummary,
	classifyMeasurementSummary,
	formatMeasurementClassification,
	clampEndDateToNow,
};
