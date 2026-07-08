"use strict";
// Delegate module — functions receive `this` via .call(adapter, ...)
/* eslint-disable jsdoc/check-tag-names, jsdoc/reject-any-type */

const { API_PFX, LAST_UPDATED, MIN_REBUILD_START_YEAR, REBUILD_MODE } = require("./constants.js");

/**
 * Performs the rebuild of the all-time history for a given system (Anlage).
 *
 * @param {string} anlagenId - The ID of the system (Anlage) for which to perform the rebuild
 * @returns {Promise<void>} Resolves when the current rebuild batch is done
 * @this {any}
 */
async function doRebuild(anlagenId) {
	if (this.rebuildRunning) {
		this.log.debug(`Rebuild already running — skipping overlapping execution.`);
		return;
	}

	await this.initializeForcedRebuildIfNeeded();
	this.rebuildRunning = true;

	try {
		const pendingSteps = await this.getPendingRebuildSteps(anlagenId);

		if (pendingSteps.length === 0) {
			if (await this.isRebuildFinishedForSystem(anlagenId)) {
				this.log.debug(`✅ Rebuild bereits vollständig für Anlage ${anlagenId}.`);
			} else {
				this.log.debug(`✅ Aktuell keine Rebuild-Schritte fällig für Anlage ${anlagenId}.`);
			}
			return;
		}

		const stepsToRun = pendingSteps.slice(0, this.rebuildStepsPerCycle);

		this.log.info(
			`🔄 Rebuild-Fortsetzung für Anlage ${anlagenId}: ${stepsToRun.length} Schritt(e) werden jetzt versucht.`,
		);

		for (const step of stepsToRun) {
			await this.runSingleRebuildStep(anlagenId, step);
		}

		const totalSteps = this.getTotalRebuildStepsPerSystem();
		const remainingSteps = (await this.getPendingRebuildSteps(anlagenId)).length;
		const doneSteps = totalSteps - remainingSteps;
		const percent = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

		this.log.info(`Rebuild progress für Anlage ${anlagenId}: ${doneSteps}/${totalSteps} (${percent}%)`);

		if (await this.isRebuildFinishedForSystem(anlagenId)) {
			this.log.info(`✅ Rebuild completed for system: ${anlagenId}.`);
			await this.updateAllTimeHistory(anlagenId);
		} else {
			this.logRebuildPendingFailuresIfChanged();
		}

		if (await this.isRebuildFinishedGlobally()) {
			this.log.info(
				"✅ Rebuild completed for all systems. Resetting rebuild mode to 'off'. (⚠️ Adapter restarts!)",
			);

			this.rebuildInitializedForRun = false;
			this.rebuildForceFullRunActive = false;

			await this.extendForeignObject(`system.adapter.${this.namespace}`, {
				native: {
					api_alltimeRebuildMode: REBUILD_MODE.OFF,
				},
			});
		}
	} finally {
		this.rebuildRunning = false;
	}
}

/**
 * Reads the AllTimeValueStore for a given state id.
 * allowing the adapter to maintain an accurate record of all-time measurements and provide valuable insights into the long-term performance of the system.
 *
 * @param {string} valueStore ValueStore
 * @returns {Promise<Record<string, number> | object>} AllTimeValueStore as object
 * @this {any}
 */
async function readAllTimeValueStore(valueStore) {
	const statsObj = await this.getStateAsync(valueStore);
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
 * @param {{ [s: string]: number; }} sums sums to insert
 * @param {string | number} anlagenId Anlagen ID
 * @param {number} year Year to insert for
 * @this {any}
 */
async function insertIntoAllTimeValueStore(sums, anlagenId, year) {
	const valueStore = `${API_PFX}Anlagen.${anlagenId}.Measurements.AllTime.valueStore`;
	const stats = await this.readAllTimeValueStore(valueStore);

	for (const [key, value] of Object.entries(sums)) {
		if (key === LAST_UPDATED) {
			continue;
		}
		if (!stats[key]) {
			stats[key] = {};
		}
		stats[key][year] = value;
	}

	await this.doState(valueStore, JSON.stringify(stats), "", "", false);
}

/**
 * @returns {number} The rebuild start year from config, or current year if config is invalid
 * @this {any}
 */
function getRebuildStartYear() {
	const currentYear = new Date().getUTCFullYear();
	const year = Number(this.config.api_alltimeRebuildStartYear);

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
 * @param {string | number} anlagenId Anlagen ID
 * @this {any}
 */
async function updateAllTimeHistory(anlagenId) {
	const pfx = `${API_PFX}Anlagen.${anlagenId}.Measurements.AllTime.`;
	const valueStore = `${pfx}valueStore`;
	const input = await this.readAllTimeValueStore(valueStore);

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
	this.log.debug(`Calculated AllTimeHistory: ${JSON.stringify(result)}`);
	await this.evalPoll(result, pfx);
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
 * @param {string} anlagenId - System id
 * @this {any}
 */
function getAllRebuildStepsForSystem(anlagenId) {
	const steps = [];
	const currentYear = new Date().getUTCFullYear();
	const startYear = this.getRebuildStartYear();
	for (let year = currentYear; year >= startYear; year--) {
		steps.push({ anlagenId, year, monthly: false, wallbox: undefined });
		steps.push({ anlagenId, year, monthly: true, wallbox: undefined });
		// Add wallbox measurement rebuild steps
		for (let i = 0; i < this.apiWallboxUuids.length; i++) {
			const wb = { uuid: this.apiWallboxUuids[i], index: i };
			steps.push({ anlagenId, year, monthly: false, wallbox: wb });
			steps.push({ anlagenId, year, monthly: true, wallbox: wb });
		}
	}
	return steps;
}

/**
 * @returns {number} Total number of rebuild steps per system
 * @this {any}
 */
function getTotalRebuildStepsPerSystem() {
	const currentYear = new Date().getUTCFullYear();
	const startYear = this.getRebuildStartYear();
	const yearCount = currentYear - startYear + 1;
	const wallboxMultiplier = 1 + this.apiWallboxUuids.length;
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
 * @param {string} anlagenId - System id
 * @returns {Promise<Array<{anlagenId: string, year: number, monthly: boolean, wallbox: {uuid: string, index: number} | undefined}>>} Pending rebuild steps
 * @this {any}
 */
async function getPendingRebuildSteps(anlagenId) {
	const allSteps = this.getAllRebuildStepsForSystem(anlagenId);
	const pending = [];
	const now = Date.now();

	for (const step of allSteps) {
		const stepKey = this.getRebuildStepKey(anlagenId, step.year, step.monthly);

		if (this.rebuildCompletedSteps.has(stepKey)) {
			continue;
		}

		const done = await this.isRebuildStepDone(anlagenId, step.year, step.monthly);
		if (done) {
			this.rebuildCompletedSteps.add(stepKey);
			this.rebuildFailures.delete(stepKey);
			continue;
		}

		const failureInfo = this.rebuildFailures.get(stepKey);
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
 * @param {string} anlagenId - System id
 * @param {number} year - year
 * @param {boolean} monthly - monthly or yearly
 * @returns {Promise<boolean>} True if the step is already complete
 * @this {any}
 */
async function isRebuildStepDone(anlagenId, year, monthly) {
	const stepKey = this.getRebuildStepKey(anlagenId, year, monthly);

	if (this.rebuildCompletedSteps.has(stepKey)) {
		return true;
	}

	const rebuildDoneState = await this.getStateAsync(this.getRebuildDoneStateId(anlagenId, year, monthly));
	if (rebuildDoneState && rebuildDoneState.val === true) {
		this.rebuildCompletedSteps.add(stepKey);
		return true;
	}

	if (this.rebuildForceFullRunActive) {
		return false;
	}

	return false;
}

/**
 * Checks if the rebuild process is finished for a specific system.
 *
 * @param {string} anlagenId - The ID of the system to check.
 * @returns {Promise<boolean>} True if the rebuild is finished for the specified system, false otherwise.
 * @this {any}
 */
async function isRebuildFinishedForSystem(anlagenId) {
	const pending = await this.getPendingRebuildSteps(anlagenId);
	return pending.length === 0;
}

/**
 * Checks if the rebuild process is finished for all systems.
 *
 * @returns {Promise<boolean>} True if the rebuild is finished for all systems, false otherwise.
 * @this {any}
 */
async function isRebuildFinishedGlobally() {
	for (const anlagenId of this.apiKnownSystems) {
		if (!(await this.isRebuildFinishedForSystem(anlagenId))) {
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
 * @this {any}
 */
function logRebuildPendingFailuresIfChanged() {
	const now = Date.now();
	const entries = [];

	for (const [stepKey, info] of this.rebuildFailures.entries()) {
		const remainingMs = Math.max(0, info.nextTryAt - now);
		const remainingMin = Math.ceil(remainingMs / 60000);

		entries.push(`${stepKey} (next try in ${remainingMin} min, last error: ${info.lastError})`);
	}

	entries.sort();
	const summary = entries.join(" | ");

	if (summary && summary !== this.lastLoggedRebuildPendingSummary) {
		this.lastLoggedRebuildPendingSummary = summary;
		this.log.info(`ℹ️ Noch offene Rebuild-Schritte: ${summary}`);
	}

	if (!summary) {
		this.lastLoggedRebuildPendingSummary = "";
	}
}

/**
 * Executes one rebuild step.
 *
 * @param {string} anlagenId - The ID of the system for which to run the rebuild step
 * @param {{ anlagenId?: string; year: number; monthly: boolean; wallbox?: { uuid: string; index: number } }} step - rebuild step
 * @returns {Promise<boolean>} True if step finished successfully, otherwise false
 * @this {any}
 */
async function runSingleRebuildStep(anlagenId, step) {
	const wbLabel = step.wallbox ? `.wb${step.wallbox.index}` : "";
	const stepLabel = `${step.year}${step.monthly ? ".monthly" : ""}${wbLabel}`;
	const stepKey = this.getRebuildStepKey(anlagenId, step.year, step.monthly) + wbLabel;

	for (let attempt = 1; attempt <= this.rebuildStepMaxRetries; attempt++) {
		try {
			this.log.info(
				`🔄 Rebuild Schritt für Anlage ${anlagenId}: ${stepLabel} (Versuch ${attempt}/${this.rebuildStepMaxRetries})`,
			);

			const result = await this.doMeasurementsYear(anlagenId, step.year, step.monthly, step.wallbox);

			if (result?.status === "success" || result?.status === "skipped_existing") {
				this.rebuildCompletedSteps.add(stepKey);
				this.rebuildFailures.delete(stepKey);
				await this.persistRebuildDone(anlagenId, step.year, step.monthly);

				this.log.info(`✅ Rebuild step successful: System ${anlagenId} / ${stepLabel}`);
				return true;
			}

			if (result?.status === "no_data") {
				this.rebuildCompletedSteps.add(stepKey);
				this.rebuildFailures.delete(stepKey);
				await this.persistRebuildDone(anlagenId, step.year, step.monthly);

				this.log.info(`✅ Rebuild step completed with no data: System ${anlagenId} / ${stepLabel}`);
				return true;
			}

			throw new Error(`Unexpected rebuild result for ${stepLabel}`);
		} catch (error) {
			const isLastAttempt = attempt >= this.rebuildStepMaxRetries;
			const isApiRelevant = this.isApiRelevantRebuildError(error);

			this.log.warn(
				`⚠️ Rebuild step failed: System ${anlagenId} / ${stepLabel} ` +
					`(Versuch ${attempt}/${this.rebuildStepMaxRetries}): ${error.message}`,
			);

			if (!isApiRelevant) {
				this.log.error(
					`❌ Rebuild step aborted eventually (no recoverable API error): System ${anlagenId} / ${stepLabel}: ${error.message}`,
				);
				throw error;
			}

			if (isLastAttempt) {
				const delayMs = Math.min(this.rebuildRetryBaseDelayMs * Math.pow(2, attempt - 1), 24 * 60 * 60 * 1000);

				this.rebuildFailures.set(stepKey, {
					attempts: attempt,
					nextTryAt: Date.now() + delayMs,
					lastError: error.message,
				});

				this.log.info(
					`ℹ️ Trying rebuild step again later: System ${anlagenId} / ${stepLabel} ` +
						`(next try in ${Math.round(delayMs / 60000)} min)`,
				);

				return false;
			}

			await this.delay(Math.min(30000, attempt * 5000));
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
 * @param {string} anlagenId - System id
 * @param {number} year - year
 * @param {boolean} monthly - monthly or yearly
 * @returns {Promise<void>} Resolves when marker was written
 * @this {any}
 */
async function persistRebuildDone(anlagenId, year, monthly) {
	const stateId = this.getRebuildDoneStateId(anlagenId, year, monthly);
	await this.doState(stateId, true, "Rebuild step completed", "", false, true);
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
 * @returns {Promise<void>} Resolves when initialization is complete
 * @this {any}
 */
async function initializeForcedRebuildIfNeeded() {
	if (!this.isRebuildEnabled() || !this.isForceFullRebuildRequested() || this.rebuildInitializedForRun) {
		return;
	}

	this.log.info(
		"🔄 Initializing forced full rebuild: clearing previous rebuild markers so that all rebuild steps are checked again.",
	);

	this.rebuildCompletedSteps.clear();
	this.rebuildFailures.clear();
	this.lastLoggedRebuildPendingSummary = "";
	this.rebuildForceFullRunActive = true;

	for (const anlagenId of this.apiKnownSystems) {
		for (const step of this.getAllRebuildStepsForSystem(anlagenId)) {
			const stateId = this.getRebuildDoneStateId(anlagenId, step.year, step.monthly);

			try {
				await this.delStateAsync(stateId);
			} catch {
				// ignore
			}

			try {
				await this.delObjectAsync(stateId);
			} catch {
				// ignore
			}
		}
	}

	this.rebuildInitializedForRun = true;

	this.log.info(
		"⚠️ Forced full rebuild initialization finished. Rebuild mode is being reset from 'force_full' to 'resume' now, which will restart the adapter once. This is expected. The rebuild itself will continue afterwards in resume mode.",
	);

	await this.extendForeignObject(`system.adapter.${this.namespace}`, {
		native: {
			api_alltimeRebuildMode: REBUILD_MODE.RESUME,
		},
	});
}

/**
 * @returns {string} normalized rebuild mode
 * @this {any}
 */
function getRebuildMode() {
	const mode = String(this.config.api_alltimeRebuildMode || REBUILD_MODE.OFF).toLowerCase();

	if (mode !== REBUILD_MODE.OFF && mode !== REBUILD_MODE.RESUME && mode !== REBUILD_MODE.FORCE_FULL) {
		return REBUILD_MODE.OFF;
	}

	return mode;
}

/**
 * @returns {boolean} true if any rebuild mode is active
 * @this {any}
 */
function isRebuildEnabled() {
	return this.getRebuildMode() !== REBUILD_MODE.OFF;
}

/**
 * @returns {boolean} true if current rebuild mode requests a forced full rebuild
 * @this {any}
 */
function isForceFullRebuildRequested() {
	return this.getRebuildMode() === REBUILD_MODE.FORCE_FULL;
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
