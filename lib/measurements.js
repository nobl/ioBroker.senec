"use strict";

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const { API_PFX, LAST_UPDATED, API_HOST_MEASUREMENTS } = require("./constants.js");

// Lazy-loaded cross-module references (avoid circular require at load time)
let apiClient;
let rebuild;

function getApiClient() {
	if (!apiClient) {
		apiClient = require("./api-client.js");
	}
	return apiClient;
}

function getRebuild() {
	if (!rebuild) {
		rebuild = require("./rebuild.js");
	}
	return rebuild;
}

/**
 * Build measurement URL and state prefix, supporting both regular and wallbox measurements.
 *
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
 * Poll measurements by year.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId - Anlagen ID to read measurements for
 * @param {number} year - Year to read measurements for
 * @param {boolean} months - Read monthly measurements
 * @param {{ uuid: string, index: number }} [wallbox] - Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request
 */
async function doMeasurementsYear(adapter, anlagenId, year, months, wallbox) {
	adapter.log.debug(`[Measurements] 🔄 Reading measurements for year: ${year}${months ? ".monthly" : ""}`);

	// resolution=YEAR anchors nothing: the cloud aggregates exactly the requested from..to range
	// and dates its single bucket at `from`. resolution=MONTH returns whole calendar months. One
	// local-calendar window therefore serves both. A UTC window for the upcoming local year would
	// additionally start after `now` between local and UTC New Year, which clampEndDateToNow turns
	// into an inverted from > to.
	const resolution = months ? "MONTH" : "YEAR";
	const startDate = new Date(year, 0, 1, 0, 0, 0, 0);
	const rawEndDate = new Date(new Date(year + 1, 0, 1).getTime() - 1);
	const endDate = clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	const { url, pfx } = buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Yearly", wallbox);
	const lastUpdate = await adapter.getStateAsync(`${pfx}${year}.${months ? "monthly." : ""}${LAST_UPDATED}`);
	const now = new Date();
	let lastDate = null;

	if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
		lastDate = new Date(String(lastUpdate.val));
	}

	if (year !== new Date().getFullYear()) {
		if (
			!adapter.rebuildRunning &&
			lastDate != null &&
			!isNaN(lastDate.getTime()) &&
			lastDate.getFullYear() === now.getFullYear()
		) {
			adapter.log.silly(
				`[Measurements] Measurements for ${year}${months ? ".monthly" : ""} already updated this year. Skipping.`,
			);
			return { status: "skipped_existing" };
		}
	} else {
		// Current year (yearly + monthly): always re-fetch.
		// Frequency is gated by the Heavy tier interval.
	}

	const label = `${year}${months ? ".monthly" : ""}`;
	adapter.log.debug(
		`[Measurements] Measurement window YEAR (${label}): from=${startDate.toISOString()} to=${endDate.toISOString()}`,
	);
	adapter.log.debug(`[Measurements] 🔄 Polling measurements for ${url}`);

	return _fetchAndSumMeasurements(adapter, url, anlagenId, pfx, `year${months ? ".monthly" : ""}`, label, year);
}

/**
 * Poll measurements by month.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId - Anlagen ID to read measurements for
 * @param {Date} date - Date to read measurements for
 * @param {string} period - Period to sum for
 * @param {{ uuid: string, index: number }} [wallbox] - Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request
 */
async function doMeasurementsMonth(adapter, anlagenId, date, period, wallbox) {
	adapter.log.debug(`[Measurements] 🔄 Reading measurements for ${period}.`);

	const startDate = date;
	const rawEndDate = new Date(new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() - 1);
	const endDate = clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	let resolution = "MONTH";
	if (period === "current_month.daily" || period === "previous_month.daily") {
		resolution = "DAY";
	}

	const { url, pfx } = buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Monthly", wallbox);

	/**
	 * Names the month the stored values belong to, in the same "YYYY-MM" form the mein-senec.de
	 * connector writes, so a consumer can tell which month a `previous_month` subtree holds
	 * without recomputing it from `lastUpdated`. Derived from the requested month, never from the
	 * payload. Called on the skip path too: `previous_month` is skipped for the rest of any month
	 * it was already read in, so a success-only write would leave the tag missing until the next
	 * rollover.
	 *
	 * @returns {Promise<void>}
	 */
	async function writePeriodTag() {
		if (period !== "current_month" && period !== "previous_month") {
			return;
		}
		const periodTag = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
		await adapter.doState(`${pfx}${period}.period`, periodTag, "Polled period", "", false);
	}

	if (period === "previous_month" || period === "previous_month.daily") {
		const lastUpdate = await adapter.getStateAsync(`${pfx}${period}.${LAST_UPDATED}`);

		if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
			const lastDate = new Date(String(lastUpdate.val));

			if (
				!adapter.rebuildRunning &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getFullYear() === new Date().getFullYear() &&
				lastDate.getMonth() === new Date().getMonth()
			) {
				adapter.log.silly(`[Measurements] Measurements for ${period} already updated this month. Skipping.`);
				await writePeriodTag();
				return { status: "skipped_existing" };
			}
		}
	}

	adapter.log.debug(
		`[Measurements] Measurement window MONTH (${period}): from=${startDate.toISOString()} to=${endDate.toISOString()}`,
	);
	adapter.log.debug(`[Measurements] 🔄 Polling measurements for ${url}`);

	const result = await _fetchAndSumMeasurements(adapter, url, anlagenId, pfx, period, period);

	// Only after values were actually stored: an empty response leaves the previous month's data
	// in place, and relabelling it would describe it wrongly.
	if (result.status === "success") {
		await writePeriodTag();
	}

	return result;
}

/**
 * Poll measurements by day.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId - Anlagen ID to read measurements for
 * @param {Date} date - Date to read measurements for
 * @param {string} period - Period to sum for
 * @param {{ uuid: string, index: number }} [wallbox] - Wallbox info, or undefined for regular measurements
 * @returns {Promise<{status: "success" | "no_data" | "skipped_existing"}>} Result of the measurement request
 */
async function doMeasurementsDay(adapter, anlagenId, date, period, wallbox) {
	adapter.log.debug(`[Measurements] 🔄 Reading measurements for ${period}`);

	const startDate = date;
	const rawEndDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
	const endDate = clampEndDateToNow(rawEndDate);
	const start = encodeURIComponent(startDate.toISOString());
	const end = encodeURIComponent(endDate.toISOString());

	let resolution = "DAY";
	if (period === "today.hourly" || period === "yesterday.hourly") {
		resolution = "HOUR";
	}

	const { url, pfx } = buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, "Daily", wallbox);

	if (period === "yesterday" || period === "yesterday.hourly") {
		const lastUpdate = await adapter.getStateAsync(`${pfx}${period}.${LAST_UPDATED}`);

		if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
			const lastDate = new Date(String(lastUpdate.val));

			if (
				!adapter.rebuildRunning &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getFullYear() === new Date().getFullYear() &&
				lastDate.getMonth() === new Date().getMonth() &&
				lastDate.getDate() === new Date().getDate()
			) {
				adapter.log.silly(`[Measurements] Measurements for ${period} already updated today. Skipping.`);
				return { status: "skipped_existing" };
			}
		}
	}

	adapter.log.debug(
		`[Measurements] Measurement window DAY (${period}): from=${startDate.toISOString()} to=${endDate.toISOString()}`,
	);
	adapter.log.debug(`[Measurements] 🔄 Polling measurements for ${url}`);

	return _fetchAndSumMeasurements(adapter, url, anlagenId, pfx, period, period);
}

/** Fallback timeout for measurement aggregations when the setting is missing */
const MEASUREMENT_TIMEOUT_MS = 60000;

/**
 * Fetch measurements from API, validate, and sum.
 * Shared tail for doMeasurementsYear/Month/Day.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - API URL to fetch
 * @param {string | number} anlagenId - System ID
 * @param {string} pfx - State prefix
 * @param {string} period - Period label for doSumMeasurements
 * @param {string} logLabel - Human-readable label for log messages
 * @param {number} [requestedYear] - Calendar year that was requested; required for the "year" periods
 * @returns {Promise<{status: "success" | "no_data"}>} Result of the measurement fetch
 */
async function _fetchAndSumMeasurements(adapter, url, anlagenId, pfx, period, logLabel, requestedYear) {
	// The shared client is tuned for the small dashboard calls, but a measurement query is
	// an aggregation the server computes on the fly — a YEAR resolution spanning months
	// regularly needs longer than that. These run on the background tiers, where waiting
	// costs nothing and a spurious timeout costs a whole poll cycle.
	const timeout = Number(adapter.config.api_measurement_timeout) || MEASUREMENT_TIMEOUT_MS;
	const measurements = await getApiClient().apiGet(adapter, url, { timeout });

	const ts = measurements?.data?.timeSeries || measurements?.data?.timeseries;
	if (!measurements?.data || !Array.isArray(ts)) {
		throw new Error(`Malformed measurement response for ${url}`);
	}

	if (ts.length === 0) {
		adapter.log.debug(`[Measurements] No measurements found for ${logLabel}.`);
		return { status: "no_data" };
	}

	await doSumMeasurements(adapter, measurements.data, anlagenId, pfx, period, requestedYear);
	return { status: "success" };
}

/**
 * Sums the measurements based on the provided period and updates the relevant states.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} data - Measurement data
 * @param {string | number} anlagenId - Anlagen ID
 * @param {string} pfx - Prefix for state
 * @param {string} period - Period to sum for
 * @param {number} [requestedYear] - Calendar year that was requested; required for the "year" periods
 * @returns {Promise<void>}
 */
async function doSumMeasurements(adapter, data, anlagenId, pfx, period, requestedYear) {
	adapter.log.debug(`[Measurements] Measurements sample: ${JSON.stringify(data).slice(0, 500)}`);
	// Wallbox measurements use lowercase "timeseries"/"measurements", regular uses camelCase
	const timeSeries = data.timeSeries || data.timeseries;
	const measurementKeys = data.measurements;
	const sums = Object.fromEntries(measurementKeys.map((key) => [key, 0]));

	// A bucket date can legitimately fall in the neighbouring calendar year, so reading the year
	// back out of the payload filed a whole year under the wrong node. The requested year decides
	// where data is stored.
	if ((period === "year" || period === "year.monthly") && !Number.isFinite(requestedYear)) {
		throw new Error(`[Measurements] doSumMeasurements needs the requested year for period "${period}"`);
	}

	// Authoritative note on bucket alignment, for this file and for apiBuildPollContext:
	// the cloud dates each bucket at its start instant and aligns day/month buckets to the
	// *plant's* local midnight — measured, e.g. a January MONTH bucket is exactly 31×86400 s from
	// local midnight, not a UTC month clipped to the request. Local getters are therefore right
	// here and UTC getters are wrong. The adapter has no plant timezone: it uses the js-controller
	// host's, which matches only while the host is configured to the plant's zone. A host in
	// another zone buckets wrongly and nothing here detects it. (The appliance publishes
	// RTC.UTC_OFFSET over the local connector, so a plant-side offset is obtainable; it is
	// deliberately not used today.)
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
				sums[key][new Date(entry.date).getMonth() + 1] += value;
			} else {
				sums[key] += value;
			}
		});
	});
	sums[LAST_UPDATED] = new Date().toISOString();

	adapter.log.silly(`[Measurements] Sums: ${JSON.stringify(sums)}`);
	let groupBy;
	switch (period) {
		case "year":
			groupBy = requestedYear;
			await getRebuild().insertIntoAllTimeValueStore(adapter, sums, anlagenId, requestedYear);
			break;
		case "year.monthly":
			groupBy = `${requestedYear}.monthly`;
			break;
		default:
			groupBy = period;
	}
	await adapter.evalPoll(sums, `${pfx + groupBy}.`);
}

/**
 * Builds a compact summary of measurement result statuses.
 *
 * @param {Array<{label: string; status: string}>} results - Array of measurement results
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
 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - Measurement result summary
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
 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - Measurement result summary
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
 * @param {"productive" | "up_to_date" | "empty" | "mixed" | "unknown"} classification - Classification result
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
 * @param {Date} endDate - Calculated period end
 * @returns {Date} endDate or current time, whichever is earlier
 */
function clampEndDateToNow(endDate) {
	const now = new Date();
	return endDate.getTime() > now.getTime() ? now : endDate;
}

/**
 * Deletes the `lastUpdated` and `_rebuildDone` markers of every `.monthly.` breakdown under one
 * `Yearly.*` subtree, so each year's monthly breakdown re-polls once. The year-total markers next
 * to them are left in place: the year totals were never written wrongly, and `_rebuildDone` is
 * written only by `persistRebuildDone` with nothing to regenerate it, so deleting one destroys an
 * unrecoverable record. `AllTime` is not touched either — it is derived from the per-year data
 * these markers gate.
 *
 * Deletion failures are collected rather than thrown, so one unreachable id cannot leave the rest
 * of the subtree stale; the caller decides what a non-empty `failures` list means.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} yearlyPfx - State prefix ending in "Yearly.", e.g. "_api.Anlagen.123.Measurements.Yearly."
 * @returns {Promise<{deleted: number, failures: Array<{id: string, error: string}>}>}
 * Number of markers removed and the ids that could not be removed.
 */
async function clearYearMarkers(adapter, yearlyPfx) {
	const patterns = [`${yearlyPfx}*.monthly.${LAST_UPDATED}`, `${yearlyPfx}*.monthly._rebuildDone`];

	let deleted = 0;
	/** @type {Array<{id: string, error: string}>} */ // eslint-disable-line jsdoc/check-tag-names
	const failures = [];

	for (const pattern of patterns) {
		const states = await adapter.getStatesAsync(pattern);
		for (const id of Object.keys(states || {})) {
			if (adapter.unloaded) {
				return { deleted, failures };
			}
			try {
				await adapter.delStateAsync(id);
				await adapter.delObjectAsync(id);
				deleted++;
			} catch (error) {
				// js-controller resolves delState/delObject silently for an id that does not
				// exist, so reaching here means the deletion genuinely failed and the marker may
				// still be there. Only an explicit not-found is safe to treat as done.
				if (isNotFoundError(error)) {
					deleted++;
				} else {
					failures.push({ id, error: error?.message || String(error) });
				}
			}
		}
	}

	return { deleted, failures };
}

/**
 * Whether an error reports that the object or state does not exist.
 *
 * @param {unknown} error - Error thrown by a delete call
 * @returns {boolean} True when the id was already absent
 */
function isNotFoundError(error) {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /not exist|not found/i.test(message);
}

// Per-adapter repair bookkeeping. `runs` holds one promise per Anlagen id: a fulfilled entry is
// kept so the repeated call from every poll cycle costs nothing, and an entry is dropped again
// when the run rejected or could not complete, so a later cycle retries it. `warnedNoWallboxIds`
// keeps the "wallbox ids still unknown" warning to once per Anlage, because that condition can
// persist for every cycle of the adapter's life.
/** @type {WeakMap<object, {runs: Map<string, Promise<boolean>>, warnedNoWallboxIds: Set<string>}>} */ // eslint-disable-line jsdoc/check-tag-names
const repairState = new WeakMap();

/**
 * Returns the repair bookkeeping for one adapter instance, creating it on first use.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {{runs: Map<string, Promise<boolean>>, warnedNoWallboxIds: Set<string>}} Bookkeeping record
 */
function getRepairState(adapter) {
	let state = repairState.get(adapter);
	if (!state) {
		state = { runs: new Map(), warnedNoWallboxIds: new Set() };
		repairState.set(adapter, state);
	}
	return state;
}

/**
 * One-shot repair for `Yearly.*.monthly.*` data: `doSumMeasurements` used to bucket the monthly
 * breakdown with UTC getters although the cloud's bucket-start timestamps denote local month
 * boundaries, shifting every stored month by the local UTC offset. Fixing the getters does not
 * repair data already written, and `doMeasurementsYear` defers a past year whose `lastUpdated`
 * already falls in the current calendar year — so the wrong months would survive until next
 * January. This clears the monthly markers once per Anlage (including wallboxes) and then records
 * completion. The current and previous year re-poll on the next Heavy-tier cycle; older years
 * re-poll once a rebuild run executes (`api_alltimeRebuildMode` other than "off").
 *
 * Repeated calls share one run per adapter and Anlage; an incomplete run is not marked done and is
 * attempted again on a later poll cycle.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId - Anlagen ID to repair
 * @returns {Promise<boolean>} True once the repair is recorded as complete
 */
function repairMeasurementsOnce(adapter, anlagenId) {
	const { runs } = getRepairState(adapter);
	const key = String(anlagenId);
	const existing = runs.get(key);
	if (existing) {
		return existing;
	}

	const run = _repairMeasurements(adapter, anlagenId).then(
		(completed) => {
			if (!completed) {
				runs.delete(key);
			}
			return completed;
		},
		(error) => {
			runs.delete(key);
			throw error;
		},
	);
	runs.set(key, run);
	return run;
}

/**
 * Body of {@link repairMeasurementsOnce}; serialised per adapter and Anlage by its caller.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId - Anlagen ID to repair
 * @returns {Promise<boolean>} True when the completion marker was written
 * @throws {Error} When a marker could not be deleted; the completion marker is withheld
 */
async function _repairMeasurements(adapter, anlagenId) {
	const markerId = `${API_PFX}Anlagen.${anlagenId}.Measurements._measurementsRepaired`;
	const marker = await adapter.getStateAsync(markerId);
	if (marker && marker.val === true) {
		adapter.log.debug(`[Measurements] Monthly bucket repair for Anlage ${anlagenId} already done — skipping.`);
		return true;
	}

	if (adapter.unloaded) {
		adapter.log.debug(`[Measurements] Monthly bucket repair for Anlage ${anlagenId} skipped — adapter unloading.`);
		return false;
	}

	adapter.log.info(
		`[Measurements] 🔧 One-time repair of the monthly measurement breakdown for Anlage ${anlagenId} (UTC → local calendar fix).`,
	);

	// Snapshot before the loop: a wallbox search running concurrently replaces this array, and a
	// shorter list would silently leave the tail of the wallbox subtrees unrepaired.
	const wallboxCount = adapter.apiWallboxUuids.length;

	const prefixes = [`${API_PFX}Anlagen.${anlagenId}.Measurements.Yearly.`];
	for (let i = 0; i < wallboxCount; i++) {
		prefixes.push(`${API_PFX}Anlagen.${anlagenId}.WallboxMeasurements.${i}.Yearly.`);
	}

	let deleted = 0;
	/** @type {Array<{id: string, error: string}>} */ // eslint-disable-line jsdoc/check-tag-names
	const failures = [];
	for (const prefix of prefixes) {
		const result = await clearYearMarkers(adapter, prefix);
		deleted += result.deleted;
		failures.push(...result.failures);
	}

	if (failures.length > 0) {
		throw new Error(
			`Anlage ${anlagenId}: ${failures.length} monthly marker(s) could not be deleted, ` +
				`completion marker withheld — first failure ${failures[0].id}: ${failures[0].error}`,
		);
	}

	const stepKeyPattern = /^(.*):\d+:monthly(\.wb\d+)?$/;
	for (const key of adapter.rebuildCompletedSteps) {
		if (stepKeyPattern.test(key) && key.startsWith(`${anlagenId}:`)) {
			adapter.rebuildCompletedSteps.delete(key);
		}
	}

	if (adapter.apiWallboxCount > 0 && wallboxCount === 0) {
		const { warnedNoWallboxIds } = getRepairState(adapter);
		const message =
			`[Measurements] ⚠️ Monthly bucket repair for Anlage ${anlagenId} left incomplete: ` +
			`${adapter.apiWallboxCount} wallbox(es) known but no wallbox ids available yet. Retrying on a later cycle.`;
		if (warnedNoWallboxIds.has(String(anlagenId))) {
			adapter.log.debug(message);
		} else {
			warnedNoWallboxIds.add(String(anlagenId));
			adapter.log.warn(message);
		}
		return false;
	}

	if (adapter.unloaded) {
		adapter.log.debug(
			`[Measurements] Monthly bucket repair for Anlage ${anlagenId} not marked done — adapter unloading.`,
		);
		return false;
	}

	await adapter.doState(markerId, true, "Monthly measurement buckets repaired (UTC → local fix)", "", false);

	if (deleted === 0) {
		adapter.log.info(
			`[Measurements] ✅ Monthly bucket repair for Anlage ${anlagenId}: no markers matched, nothing to repair.`,
		);
	} else {
		adapter.log.info(
			`[Measurements] ✅ Monthly bucket repair for Anlage ${anlagenId}: ${deleted} marker(s) cleared.`,
		);
	}

	return true;
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
	clearYearMarkers,
	repairMeasurementsOnce,
};
