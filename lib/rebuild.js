"use strict";
/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const { API_PFX, LAST_UPDATED, MIN_REBUILD_START_YEAR, REBUILD_MODE } = require("./constants.js");

// Lazy-loaded cross-module reference (avoid circular require at load time)
let measurements;

function getMeasurements() {
	if (!measurements) {
		measurements = require("./measurements.js");
	}
	return measurements;
}

/**
 * Performs the rebuild of the all-time history for a given system (Anlage).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system (Anlage) for which to perform the rebuild
 * @returns {Promise<void>} Resolves when the current rebuild batch is done
 */
async function doRebuild(adapter, anlagenId) {
	if (adapter.rebuildRunning) {
		adapter.log.debug(`[Rebuild] Rebuild already running — skipping overlapping execution.`);
		return;
	}

	await initializeForcedRebuildIfNeeded(adapter);
	adapter.rebuildRunning = true;

	try {
		const pendingSteps = await getPendingRebuildSteps(adapter, anlagenId);

		if (pendingSteps.length === 0) {
			if (await isRebuildFinishedForSystem(adapter, anlagenId)) {
				adapter.log.debug(`[Rebuild] ✅ Rebuild bereits vollständig für Anlage ${anlagenId}.`);
			} else {
				adapter.log.debug(`[Rebuild] ✅ Aktuell keine Rebuild-Schritte fällig für Anlage ${anlagenId}.`);
			}
			return;
		}

		const stepsToRun = pendingSteps.slice(0, adapter.rebuildStepsPerCycle);

		adapter.log.info(
			`[Rebuild] Fortsetzung für Anlage ${anlagenId}: ${stepsToRun.length} Schritt(e) werden jetzt versucht.`,
		);

		for (const step of stepsToRun) {
			await runSingleRebuildStep(adapter, anlagenId, step);
		}

		const totalSteps = getTotalRebuildStepsPerSystem(adapter);
		const remainingSteps = (await getPendingRebuildSteps(adapter, anlagenId)).length;
		const doneSteps = totalSteps - remainingSteps;
		const percent = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

		adapter.log.info(
			`[Rebuild] Rebuild progress für Anlage ${anlagenId}: ${doneSteps}/${totalSteps} (${percent}%)`,
		);

		if (await isRebuildFinishedForSystem(adapter, anlagenId)) {
			adapter.log.info(`[Rebuild] ✅ Rebuild completed for system: ${anlagenId}.`);
			await updateAllTimeHistory(adapter, anlagenId);
		} else {
			logRebuildPendingFailuresIfChanged(adapter);
		}

		if (await isRebuildFinishedGlobally(adapter)) {
			adapter.log.info(
				"[Rebuild] Completed for all systems. Resetting rebuild mode to 'off'. (Adapter restarts!)",
			);

			adapter.rebuildInitializedForRun = false;
			adapter.rebuildForceFullRunActive = false;

			await adapter.extendForeignObject(`system.adapter.${adapter.namespace}`, {
				native: {
					api_alltimeRebuildMode: REBUILD_MODE.OFF,
				},
			});
		}
	} finally {
		adapter.rebuildRunning = false;
	}
}

/**
 * Reads the AllTimeValueStore for a given state id.
 * allowing the adapter to maintain an accurate record of all-time measurements and provide valuable insights into the long-term performance of the system.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} valueStore ValueStore
 * @returns {Promise<Record<string, number> | object>} AllTimeValueStore as object
 */
async function readAllTimeValueStore(adapter, valueStore) {
	const statsObj = await adapter.getStateAsync(valueStore);
	const stats =
		statsObj && statsObj.val
			? typeof statsObj.val === "string"
				? JSON.parse(statsObj.val)
				: typeof statsObj.val === "object" && statsObj.val !== null
					? statsObj.val
					: {}
			: {};
	return stats;
}

/**
 * Insert values into AllTimeValueStore
 * The method reads the existing values from the AllTimeValueStore for the specified system ID and year, updates the values based on the provided sums, and then writes the updated values back to the AllTimeValueStore.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {{ [s: string]: number; }} sums sums to insert
 * @param {string | number} anlagenId Anlagen ID
 * @param {number} year Year to insert for
 * @returns {Promise<void>}
 */
async function insertIntoAllTimeValueStore(adapter, sums, anlagenId, year) {
	const valueStore = `${API_PFX}Anlagen.${anlagenId}.Measurements.AllTime.valueStore`;
	const stats = await readAllTimeValueStore(adapter, valueStore);

	for (const [key, value] of Object.entries(sums)) {
		if (key === LAST_UPDATED) {
			continue;
		}
		if (!stats[key]) {
			stats[key] = {};
		}
		stats[key][year] = value;
	}

	await adapter.doState(valueStore, JSON.stringify(stats), "", "", false);
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {number} The rebuild start year from config, or current year if config is invalid
 */
function getRebuildStartYear(adapter) {
	const currentYear = new Date().getUTCFullYear();
	const year = Number(adapter.config.api_alltimeRebuildStartYear);

	if (Number.isInteger(year) && year >= MIN_REBUILD_START_YEAR && year <= currentYear) {
		return year;
	}

	return currentYear;
}

/**
 * Updated AllTimeHistory based on what we have in our AllTimeValueStore
 * The method reads the existing values from the AllTimeValueStore for the specified system ID and calculates the historical data for all time periods based on the stored values.
 * It handles special cases for certain keys, such as "AUTARKY_IN_PERCENT" and "BATTERY_LEVEL_IN_PERCENT", which require specific calculations based on other related keys.
 * The method then updates the relevant states with the calculated historical data, ensuring that the adapter maintains an accurate and up-to-date record of the all-time history for the system.
 * By structuring the calculations in this way, the method optimizes the retrieval and processing of historical data while also providing comprehensive coverage of the relevant metrics for the system's performance over time.
 * The method assumes that the AllTimeValueStore is properly maintained and contains the necessary data for the calculations, as it relies on this information to compute the historical values accurately.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string | number} anlagenId Anlagen ID
 * @returns {Promise<void>}
 */
async function updateAllTimeHistory(adapter, anlagenId) {
	const pfx = `${API_PFX}Anlagen.${anlagenId}.Measurements.AllTime.`;
	const valueStore = `${pfx}valueStore`;
	const input = await readAllTimeValueStore(adapter, valueStore);

	// Spezialfälle definieren + benötigte Keys
	const specialHandlers = {
		AUTARKY_IN_PERCENT: {
			keys: ["POWER_GENERATION", "GRID_EXPORT", "BATTERY_IMPORT", "BATTERY_EXPORT", "POWER_CONSUMPTION"],
			fn: (_values, sums) =>
				sums.POWER_CONSUMPTION
					? ((sums.POWER_GENERATION - sums.GRID_EXPORT - sums.BATTERY_IMPORT + sums.BATTERY_EXPORT) /
							sums.POWER_CONSUMPTION) *
						100
					: 0,
		},
		BATTERY_LEVEL_IN_PERCENT: {
			keys: [],
			fn: (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0),
		},
	};

	// Summen der benötigten Keys nur einmal berechnen
	const sumKeys = Object.fromEntries(
		specialHandlers.AUTARKY_IN_PERCENT.keys.map((k) => [
			k,
			Object.values(input[k] || {}).reduce((a, b) => a + b, 0),
		]),
	);

	// Ergebnis berechnen
	const result = Object.fromEntries(
		Object.entries(input).map(([key, years]) => {
			const values = Object.values(years || {});
			let value;
			if (specialHandlers[key]) {
				value = specialHandlers[key].fn(values, sumKeys);
			} else {
				value = values.reduce((a, b) => a + b, 0);
			}
			// Auf 2 Nachkommastellen runden
			value = Math.round(value * 100) / 100;
			return [key, value];
		}),
	);
	adapter.log.debug(`[Rebuild] Calculated AllTimeHistory: ${JSON.stringify(result)}`);
	await adapter.evalPoll(result, pfx);
}

/**
 * Returns a unique key string for a given rebuild step.
 *
 * Two rebuild steps exist per year:
 * - yearly rebuild is needed for complete all-time aggregation
 * - monthly rebuild is needed because normal polling only fetches monthly breakdowns for the current and previous year
 * - older historic monthly data would otherwise never be populated
 *
 * @param {string} anlagenId - System id
 * @param {number} year - Year of the rebuild step
 * @param {boolean} monthly - true for monthly aggregation step, false for yearly
 * @returns {string} The unique key for the rebuild step.
 */
function getRebuildStepKey(anlagenId, year, monthly) {
	return `${anlagenId}:${year}:${monthly ? "monthly" : "year"}`;
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System id
 * @returns {Array<{anlagenId: string, year: number, monthly: boolean, wallbox: {uuid: string, index: number} | undefined}>} All rebuild steps for the system
 */
function getAllRebuildStepsForSystem(adapter, anlagenId) {
	const steps = [];
	const currentYear = new Date().getUTCFullYear();
	const startYear = getRebuildStartYear(adapter);
	for (let year = currentYear; year >= startYear; year--) {
		steps.push({ anlagenId, year, monthly: false, wallbox: undefined });
		steps.push({ anlagenId, year, monthly: true, wallbox: undefined });
		// Add wallbox measurement rebuild steps
		for (let i = 0; i < adapter.apiWallboxUuids.length; i++) {
			const wb = { uuid: adapter.apiWallboxUuids[i], index: i };
			steps.push({ anlagenId, year, monthly: false, wallbox: wb });
			steps.push({ anlagenId, year, monthly: true, wallbox: wb });
		}
	}
	return steps;
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {number} Total number of rebuild steps per system
 */
function getTotalRebuildStepsPerSystem(adapter) {
	const currentYear = new Date().getUTCFullYear();
	const startYear = getRebuildStartYear(adapter);
	const yearCount = currentYear - startYear + 1;
	const wallboxMultiplier = 1 + adapter.apiWallboxUuids.length;
	return yearCount * 2 * wallboxMultiplier;
}

/**
 * @param {Error & { response?: { status: number }; code?: string }} error - if an error occurs
 * @returns {boolean} True if the error is a recoverable API error
 */
function isApiRelevantRebuildError(error) {
	const status = error?.response?.status;
	const code = error?.code;
	const msg = error?.message || "";

	return (
		status === 401 ||
		status === 429 ||
		(status !== undefined && status >= 500 && status < 600) ||
		code === "ECONNABORTED" ||
		code === "ETIMEDOUT" ||
		/timeout/i.test(msg)
	);
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System id
 * @returns {Promise<Array<{anlagenId: string, year: number, monthly: boolean, wallbox: {uuid: string, index: number} | undefined}>>} Pending rebuild steps
 */
async function getPendingRebuildSteps(adapter, anlagenId) {
	const allSteps = getAllRebuildStepsForSystem(adapter, anlagenId);
	const pending = [];
	const now = Date.now();

	for (const step of allSteps) {
		const stepKey = getRebuildStepKey(anlagenId, step.year, step.monthly);

		if (adapter.rebuildCompletedSteps.has(stepKey)) {
			continue;
		}

		const done = await isRebuildStepDone(adapter, anlagenId, step.year, step.monthly);
		if (done) {
			adapter.rebuildCompletedSteps.add(stepKey);
			adapter.rebuildFailures.delete(stepKey);
			continue;
		}

		const failureInfo = adapter.rebuildFailures.get(stepKey);
		if (failureInfo && failureInfo.nextTryAt > now) {
			continue;
		}

		pending.push(step);
	}

	return pending;
}

/**
 * Checks if one rebuild step is already done.
 *
 * Order:
 * 1. in-memory cache
 * 2. persisted rebuild done marker
 * 3. fallback: existing LAST_UPDATED state
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System id
 * @param {number} year - year
 * @param {boolean} monthly - monthly or yearly
 * @returns {Promise<boolean>} True if the step is already complete
 */
async function isRebuildStepDone(adapter, anlagenId, year, monthly) {
	const stepKey = getRebuildStepKey(anlagenId, year, monthly);

	if (adapter.rebuildCompletedSteps.has(stepKey)) {
		return true;
	}

	const rebuildDoneState = await adapter.getStateAsync(getRebuildDoneStateId(anlagenId, year, monthly));
	if (rebuildDoneState && rebuildDoneState.val === true) {
		adapter.rebuildCompletedSteps.add(stepKey);
		return true;
	}

	if (adapter.rebuildForceFullRunActive) {
		return false;
	}

	return false;
}

/**
 * Checks if the rebuild process is finished for a specific system.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to check.
 * @returns {Promise<boolean>} True if the rebuild is finished for the specified system, false otherwise.
 */
async function isRebuildFinishedForSystem(adapter, anlagenId) {
	const pending = await getPendingRebuildSteps(adapter, anlagenId);
	return pending.length === 0;
}

/**
 * Checks if the rebuild process is finished for all systems.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<boolean>} True if the rebuild is finished for all systems, false otherwise.
 */
async function isRebuildFinishedGlobally(adapter) {
	for (const anlagenId of adapter.apiKnownSystems) {
		if (!(await isRebuildFinishedForSystem(adapter, anlagenId))) {
			return false;
		}
	}
	return true;
}

/**
 * Logs the pending rebuild failures in a user-friendly format.
 * This method retrieves the list of pending failures and logs them in an informative way, indicating which systems and steps are still pending and when the next retry attempts will occur.
 * If there are no pending failures, the method simply returns without logging anything.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {void}
 */
function logRebuildPendingFailuresIfChanged(adapter) {
	const now = Date.now();
	const entries = [];

	for (const [stepKey, info] of adapter.rebuildFailures.entries()) {
		const remainingMs = Math.max(0, info.nextTryAt - now);
		const remainingMin = Math.ceil(remainingMs / 60000);

		entries.push(`${stepKey} (next try in ${remainingMin} min, last error: ${info.lastError})`);
	}

	entries.sort();
	const summary = entries.join(" | ");

	if (summary && summary !== adapter.lastLoggedRebuildPendingSummary) {
		adapter.lastLoggedRebuildPendingSummary = summary;
		adapter.log.info(`[Rebuild] ℹ️ Noch offene Rebuild-Schritte: ${summary}`);
	}

	if (!summary) {
		adapter.lastLoggedRebuildPendingSummary = "";
	}
}

/**
 * Executes one rebuild step.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system for which to run the rebuild step
 * @param {{ anlagenId?: string; year: number; monthly: boolean; wallbox?: { uuid: string; index: number } }} step - rebuild step
 * @returns {Promise<boolean>} True if step finished successfully, otherwise false
 */
async function runSingleRebuildStep(adapter, anlagenId, step) {
	const wbLabel = step.wallbox ? `.wb${step.wallbox.index}` : "";
	const stepLabel = `${step.year}${step.monthly ? ".monthly" : ""}${wbLabel}`;
	const stepKey = getRebuildStepKey(anlagenId, step.year, step.monthly) + wbLabel;

	for (let attempt = 1; attempt <= adapter.rebuildStepMaxRetries; attempt++) {
		try {
			adapter.log.info(
				`[Rebuild] Schritt für Anlage ${anlagenId}: ${stepLabel} (Versuch ${attempt}/${adapter.rebuildStepMaxRetries})`,
			);

			const result = await getMeasurements().doMeasurementsYear(
				adapter,
				anlagenId,
				step.year,
				step.monthly,
				step.wallbox,
			);

			if (result?.status === "success" || result?.status === "skipped_existing") {
				adapter.rebuildCompletedSteps.add(stepKey);
				adapter.rebuildFailures.delete(stepKey);
				await persistRebuildDone(adapter, anlagenId, step.year, step.monthly);

				adapter.log.info(`[Rebuild] ✅ Rebuild step successful: System ${anlagenId} / ${stepLabel}`);
				return true;
			}

			if (result?.status === "no_data") {
				adapter.rebuildCompletedSteps.add(stepKey);
				adapter.rebuildFailures.delete(stepKey);
				await persistRebuildDone(adapter, anlagenId, step.year, step.monthly);

				adapter.log.info(
					`[Rebuild] ✅ Rebuild step completed with no data: System ${anlagenId} / ${stepLabel}`,
				);
				return true;
			}

			throw new Error(`Unexpected rebuild result for ${stepLabel}`);
		} catch (error) {
			const isLastAttempt = attempt >= adapter.rebuildStepMaxRetries;
			const isApiRelevant = isApiRelevantRebuildError(error);

			adapter.log.warn(
				`[Rebuild] ⚠️ Step failed: System ${anlagenId} / ${stepLabel} ` +
					`(Versuch ${attempt}/${adapter.rebuildStepMaxRetries}): ${error.message}`,
			);

			if (!isApiRelevant) {
				adapter.log.error(
					`[Rebuild] ❌ Step aborted (no recoverable API error): System ${anlagenId} / ${stepLabel}: ${error.message}`,
				);
				throw error;
			}

			if (isLastAttempt) {
				const delayMs = Math.min(
					adapter.rebuildRetryBaseDelayMs * Math.pow(2, attempt - 1),
					24 * 60 * 60 * 1000,
				);

				adapter.rebuildFailures.set(stepKey, {
					attempts: attempt,
					nextTryAt: Date.now() + delayMs,
					lastError: error.message,
				});

				adapter.log.info(
					`[Rebuild] Trying step again later: System ${anlagenId} / ${stepLabel} ` +
						`(next try in ${Math.round(delayMs / 60000)} min)`,
				);

				return false;
			}

			await adapter.delay(Math.min(30000, attempt * 5000));
		}
	}

	return false;
}

/**
 * Returns the state id used to persist rebuild completion for one rebuild step.
 *
 * @param {string} anlagenId - System id
 * @param {number} year - year
 * @param {boolean} monthly - monthly or yearly
 * @returns {string} Fully qualified state id for the rebuild done marker
 */
function getRebuildDoneStateId(anlagenId, year, monthly) {
	return `${API_PFX}Anlagen.${anlagenId}.Measurements.Yearly.${year}.${monthly ? "monthly." : ""}_rebuildDone`;
}

/**
 * Persists a rebuild completion marker for one step.
 *
 * This allows the adapter to remember across restarts that a year/month step
 * was already checked successfully, including "no_data" situations.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System id
 * @param {number} year - year
 * @param {boolean} monthly - monthly or yearly
 * @returns {Promise<void>} Resolves when marker was written
 */
async function persistRebuildDone(adapter, anlagenId, year, monthly) {
	const stateId = getRebuildDoneStateId(anlagenId, year, monthly);
	await adapter.doState(stateId, true, "Rebuild step completed", "", false, true);
}

/**
 * Initializes a forced rebuild run.
 *
 * If rebuild mode is "force_full", previously persisted rebuild completion
 * markers are cleared once so that the next rebuild run really starts from scratch.
 *
 * Important:
 * - rebuild mode "resume" remains active afterwards
 * - rebuild mode "force_full" is reset immediately to "resume"
 *   to avoid restarting the forced full rebuild again after adapter restarts
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>} Resolves when initialization is complete
 */
async function initializeForcedRebuildIfNeeded(adapter) {
	if (!isRebuildEnabled(adapter) || !isForceFullRebuildRequested(adapter) || adapter.rebuildInitializedForRun) {
		return;
	}

	adapter.log.info(
		"[Rebuild] Initializing forced full rebuild: clearing previous rebuild markers so that all rebuild steps are checked again.",
	);

	adapter.rebuildCompletedSteps.clear();
	adapter.rebuildFailures.clear();
	adapter.lastLoggedRebuildPendingSummary = "";
	adapter.rebuildForceFullRunActive = true;

	for (const anlagenId of adapter.apiKnownSystems) {
		for (const step of getAllRebuildStepsForSystem(adapter, anlagenId)) {
			const stateId = getRebuildDoneStateId(anlagenId, step.year, step.monthly);

			try {
				await adapter.delStateAsync(stateId);
			} catch {
				// ignore
			}

			try {
				await adapter.delObjectAsync(stateId);
			} catch {
				// ignore
			}
		}
	}

	adapter.rebuildInitializedForRun = true;

	adapter.log.info(
		"[Rebuild] Forced full rebuild initialization finished. Rebuild mode is being reset from 'force_full' to 'resume' now, which will restart the adapter once. This is expected. The rebuild itself will continue afterwards in resume mode.",
	);

	await adapter.extendForeignObject(`system.adapter.${adapter.namespace}`, {
		native: {
			api_alltimeRebuildMode: REBUILD_MODE.RESUME,
		},
	});
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {string} normalized rebuild mode
 */
function getRebuildMode(adapter) {
	const mode = String(adapter.config.api_alltimeRebuildMode || REBUILD_MODE.OFF).toLowerCase();

	if (mode !== REBUILD_MODE.OFF && mode !== REBUILD_MODE.RESUME && mode !== REBUILD_MODE.FORCE_FULL) {
		return REBUILD_MODE.OFF;
	}

	return mode;
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {boolean} true if any rebuild mode is active
 */
function isRebuildEnabled(adapter) {
	return getRebuildMode(adapter) !== REBUILD_MODE.OFF;
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {boolean} true if current rebuild mode requests a forced full rebuild
 */
function isForceFullRebuildRequested(adapter) {
	return getRebuildMode(adapter) === REBUILD_MODE.FORCE_FULL;
}

module.exports = {
	doRebuild,
	readAllTimeValueStore,
	insertIntoAllTimeValueStore,
	getRebuildStartYear,
	updateAllTimeHistory,
	getRebuildStepKey,
	getAllRebuildStepsForSystem,
	getTotalRebuildStepsPerSystem,
	isApiRelevantRebuildError,
	getPendingRebuildSteps,
	isRebuildStepDone,
	isRebuildFinishedForSystem,
	isRebuildFinishedGlobally,
	logRebuildPendingFailuresIfChanged,
	runSingleRebuildStep,
	getRebuildDoneStateId,
	persistRebuildDone,
	initializeForcedRebuildIfNeeded,
	getRebuildMode,
	isRebuildEnabled,
	isForceFullRebuildRequested,
};
