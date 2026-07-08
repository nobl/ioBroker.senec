"use strict";
/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const { URL, URLSearchParams } = require("node:url");
const { CookieJar } = require("tough-cookie");
const {
	API_PFX,
	TOKEN_STATE,
	API_HOST_SYSTEMS,
	API_HOST_MEASUREMENTS,
	API_HOST_ABILITIES,
	API_HOST_WALLBOX,
	CONFIG,
} = require("./constants.js");
const {
	generateCodeVerifier,
	generateCodeChallenge,
	base64UrlEncode,
	extractFormAction,
	hasUsername,
	hasPassword,
	hasUsernameAndPassword,
	hasOtp,
	generateTOTP,
	computeBackoffDelay,
} = require("./auth-helpers.js");

// Lazy-loaded cross-module references (avoid circular require at load time)
let measurements;
let rebuild;

function getMeasurements() {
	if (!measurements) {
		measurements = require("./measurements.js");
	}
	return measurements;
}

function getRebuild() {
	if (!rebuild) {
		rebuild = require("./rebuild.js");
	}
	return rebuild;
}

// --- Exported API functions ---------------------------------------------------

/**
 * Starts the token manager for the SENEC App API.
 * The method first checks for an existing refresh token in the state. If a refresh token is found, it attempts to refresh the access token using that refresh token. If the refresh attempt fails (e.g., due to an invalid or expired refresh token), it falls back to performing a full login to obtain new tokens.
 *
 * The method ensures that the adapter can authenticate with the SENEC App API and is ready for subsequent API calls. It also handles the initial setup of the token management process, including scheduling future token refreshes.
 * Important: This method should be called during adapter startup to ensure that the adapter has a valid token before making any API calls. If this method returns false, it indicates that the adapter was unable to authenticate with the SENEC App API, and API polling should not be started.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<boolean>} A promise resolving to true if a valid token is obtained, false otherwise.
 */
async function apiStartTokenManager(adapter) {
	try {
		const tokenState = await adapter.getStateAsync(`${TOKEN_STATE}`);
		adapter.refreshToken = tokenState?.val ? adapter.decrypt(String(tokenState.val)) : null;
		// No refresh token at all → full login
		if (!adapter.refreshToken) {
			adapter.log.info("[API] 🔐 No refresh token present. Performing full login...");
			const token = await apiLogin(adapter);
			return !!token;
		}
		adapter.log.info("[API] 🔐 Using existing refresh token.");

		// We have a refresh token → try refresh
		adapter.log.info("[API] 🔐 Trying initial token refresh...");
		await apiRefreshToken(adapter);
		return !!adapter.currentToken;
	} catch (error) {
		adapter.log.warn(`[API] ⚠️ Initial refresh failed. Falling back to full login... ${error.message}`);
		const token = await apiLogin(adapter);
		return !!token;
	}
}

/**
 * Performs the Senec API login flow.
 * This method is responsible for authenticating with the SENEC App API using the Resource Owner Password Credentials flow with PKCE.
 * It handles the entire login process, including form parsing, handling multi-step authentication (username/password), and token exchange.
 * Upon successful login, it stores the access token and refresh token securely and schedules the next token refresh.
 * Important: This method should only be called when there is no valid refresh token available or when a full re-authentication is required (e.g., after multiple failed refresh attempts).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<string|null>} The access token if login is successful, or null if login fails.
 */
async function apiLogin(adapter) {
	adapter.log.info("[API] 🔄 Start Senec API Login Flow...");

	if (!adapter.authClient) {
		throw new Error("Auth client not initialized");
	}
	const authClient = adapter.authClient;

	adapter.jar = new CookieJar();

	try {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = generateCodeChallenge(codeVerifier);

		const authParams = new URLSearchParams({
			response_type: "code",
			client_id: CONFIG.clientId,
			redirect_uri: CONFIG.redirectUri,
			scope: CONFIG.scope,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		const pageRes = await authClient.get(`${CONFIG.authUrl}?${authParams}`, { jar: adapter.jar });
		let actionUrl = extractFormAction(pageRes.data);
		if (!actionUrl) {
			throw new Error("Login-Form URL not found.");
		}

		const postForm = (url, data) =>
			authClient.post(url, data, {
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				maxRedirects: 0,
				validateStatus: (s) => s >= 200 && s < 400,
				jar: adapter.jar,
			});

		let loginRes;

		// Ensure username field exists
		if (!hasUsername(pageRes.data)) {
			throw new Error("Expected: Login-Form with username. Got something else.");
		}

		// Step 1 (username only or full form)
		let formData = new URLSearchParams({
			username: adapter.config.api_mail,
		});
		if (hasUsernameAndPassword(pageRes.data)) {
			formData.append("password", adapter.config.api_pwd);
		}
		loginRes = await postForm(actionUrl, formData);

		// Step 2 (password step if required)
		if (!hasUsernameAndPassword(pageRes.data)) {
			if (!hasPassword(loginRes.data)) {
				throw new Error("Expected: Login-Form with password. Got something else.");
			}

			actionUrl = extractFormAction(loginRes.data);
			formData = new URLSearchParams({
				username: adapter.config.api_mail,
				password: adapter.config.api_pwd,
			});
			loginRes = await postForm(actionUrl, formData);
		}

		// Step 3 (TOTP/2FA if required)
		if (!loginRes.headers.location && loginRes.status === 200 && loginRes.data && hasOtp(loginRes.data)) {
			if (!adapter.config.api_totp_secret) {
				throw new Error(
					"2FA/TOTP is required by your SENEC account but no TOTP secret is configured. " +
						"Please enter your TOTP secret in the adapter settings.",
				);
			}
			adapter.log.info("[API] 🔐 2FA/TOTP required. Submitting TOTP code...");
			const otpAction = extractFormAction(loginRes.data);
			if (!otpAction) {
				throw new Error("TOTP form found but could not extract form action URL.");
			}
			const otpCode = generateTOTP(adapter.config.api_totp_secret);
			loginRes = await postForm(otpAction, new URLSearchParams({ otp: otpCode }));
		}

		const redirectLocation = loginRes.headers.location;
		if (!redirectLocation) {
			throw new Error(
				loginRes.status === 200 ? "Login failed: no redirect." : `Login unexpected State: ${loginRes.status}`,
			);
		}

		const authCode = new URL(redirectLocation.replace("senec-app-auth://", "https://")).searchParams.get("code");
		if (!authCode) {
			throw new Error("Authorization code not found in redirect.");
		}

		const tokenRes = await authClient.post(
			CONFIG.tokenUrl,
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CONFIG.clientId,
				code: authCode,
				code_verifier: codeVerifier,
				redirect_uri: CONFIG.redirectUri,
			}),
			{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
		);

		adapter.currentToken = tokenRes.data.access_token;
		const newRefreshToken = tokenRes.data.refresh_token;
		adapter.refreshToken = newRefreshToken;
		await adapter.doState(
			//`${adapter.namespace}${TOKEN_STATE}`,
			`${TOKEN_STATE}`,
			adapter.encrypt(newRefreshToken),
			"Encrypted Refresh Token (never log or expose!)",
			"",
			false,
			false,
		);
		adapter.authBlocked = false;
		adapter.tokenFailureCount = 0;
		const expiresIn = tokenRes.data.expires_in || 600; // fallback 10 min
		adapter.tokenExpiresAt = Date.now() + expiresIn * 1000;

		adapter.log.info("[API] ✅ Login successful.");
		scheduleTokenRefresh(adapter);
		return adapter.currentToken;
	} catch (e) {
		adapter.logError(e, "[API] ❌ Login Error");
		return null;
	}
}

/**
 * Schedules the refresh of the API token based on its expiration time.
 * Includes a safety margin to refresh the token before it actually expires and implements an exponential backoff strategy in case of refresh failures to prevent excessive load on the SENEC / Keycloak servers.
 * Important: This method should be called after obtaining a new token (either via login or refresh) to ensure continuous authentication.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {void}
 */
function scheduleTokenRefresh(adapter) {
	if (!adapter.tokenExpiresAt || adapter.unloaded) {
		return;
	}

	const now = Date.now();
	let remaining = adapter.tokenExpiresAt - now;
	if (remaining <= 0) {
		// no negatives - if token already expired for some reason, schedule refresh in 10s
		remaining = 10000;
	}
	// security-delay: Refresh min. 90–150s before expiry to prevent edge cases of token expiry during API calls and to reduce load on senec / keycloak in case of time sync issues or longer response times of senec / keycloak
	const safetyMargin = Math.max(90000, remaining * 0.2); // 1.5 min oder 20%
	let delay = remaining - safetyMargin;

	if (adapter.tokenFailureCount > 0) {
		// if we had failures, we refresh more conservatively with a min. of 1 min to prevent excessive load on senec / keycloak in case of issues and to increase chances of successful refresh in case of temporary issues
		delay = Math.max(delay, 60000); // min. 1 min
	}
	delay = Math.max(delay, 10000); // never less than 10s - important to prevent too aggressive refreshes in case of clock sync issues or senec / keycloak response delays

	adapter.clearTimeout(adapter.timerTokenRefresh);

	if (!adapter.unloaded) {
		adapter.log.debug(
			`🔐 Next token refresh in ${(delay / 1000).toFixed(0)}s ` +
				`(remaining ${Math.round(remaining / 1000 / 60)} min, failures=${adapter.tokenFailureCount})`,
		);
		adapter.timerTokenRefresh =
			adapter.setTimeout(() => {
				apiRefreshToken(adapter).catch((err) => {
					adapter.log.debug(`⚠ Token refresh failed: ${err.message}`);
				});
			}, delay) ?? null;
	}
}

/**
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function apiRefreshToken(adapter) {
	if (adapter.unloaded) {
		return;
	}

	if (!adapter.authClient) {
		throw new Error("Auth client not initialized");
	}
	const authClient = adapter.authClient;

	if (adapter.refreshPromise) {
		adapter.log.debug("🔐 Refresh already in progress, waiting for it to complete...");
		await adapter.refreshPromise;
		return;
	}

	// cancel scheduled refresh while manual refresh runs
	adapter.clearTimeout(adapter.timerTokenRefresh);
	adapter.timerTokenRefresh = null;

	if (!adapter.refreshToken) {
		adapter.log.debug("🔐 No refresh token available — skipping refresh.");
		await apiLogin(adapter);
		return;
	}

	const refreshToken = adapter.refreshToken;

	adapter.refreshPromise = (async () => {
		try {
			adapter.log.debug("🔐 Refreshing API token...");

			const response = await authClient.post(
				CONFIG.tokenUrl,
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: CONFIG.clientId,
					refresh_token: refreshToken,
				}),
				{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
			);

			const data = response.data;

			adapter.currentToken = data.access_token;
			const updatedRefreshToken = data.refresh_token || refreshToken;
			adapter.refreshToken = updatedRefreshToken;

			await adapter.doState(
				`${TOKEN_STATE}`,
				adapter.encrypt(updatedRefreshToken),
				"Encrypted Refresh Token (never log or expose!)",
				"",
				false,
				false,
			);

			adapter.tokenFailureCount = 0;
			adapter.authBlocked = false;
			const expiresIn = data.expires_in || 600;
			adapter.tokenExpiresAt = Date.now() + expiresIn * 1000;

			if (adapter.config.api_showPolling) {
				adapter.log.info(`[API] ✅ Token refreshed. Expires in ${expiresIn}s`);
			} else {
				adapter.log.debug(`✅ Token refreshed. Expires in ${expiresIn}s`);
			}

			scheduleTokenRefresh(adapter);
		} catch (err) {
			adapter.authBlocked = true;
			const status = err.response?.status;
			const errorCode = err.response?.data?.error;

			adapter.log.warn(`[API] ⚠️ Token refresh failed: ${err.message} (HTTP ${status || "unknown"})`);

			if (errorCode === "invalid_grant" || status === 400) {
				adapter.log.warn("[API] ⚠️ Refresh token invalid → full login required.");
				await apiLogin(adapter);
				return;
			}

			adapter.tokenFailureCount++;
			const attempt = adapter.tokenFailureCount;
			let retryDelay = computeBackoffDelay(
				adapter.tokenBackoff.baseDelayMs,
				attempt - 1,
				adapter.tokenBackoff.maxMultiplier,
			);
			retryDelay = Math.max(retryDelay, 10000);
			retryDelay = Math.min(retryDelay, adapter.tokenBackoff.maxDelayMs);

			if (!adapter.unloaded) {
				adapter.log.warn(
					`[API] Token refresh retry #${attempt} scheduled in ${(retryDelay / 1000).toFixed(0)}s ` +
						`(failures = ${adapter.tokenFailureCount})`,
				);
				adapter.timerTokenRefresh =
					adapter.setTimeout(() => {
						apiRefreshToken(adapter).catch(() => {});
					}, retryDelay) ?? null;
			}

			throw err;
		} finally {
			adapter.refreshPromise = null;
		}
	})();

	await adapter.refreshPromise;
}

/**
 * Polls the SENEC API for updates.
 * Runs one API poll cycle, applies global error/backoff handling and schedules the next execution.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 * @throws {Error} Will throw an error if the API call fails or if all scheduled tasks fail during the poll cycle.
 */
async function apiPoll(adapter) {
	if (adapter.unloaded) {
		return;
	}

	adapter.clearTimeout(adapter.timerAPI);
	adapter.timerAPI = null;

	if (!adapter.config.api_use || !adapter.apiConnected || adapter.unloaded) {
		adapter.log.info("[API] Usage of SENEC App API not configured or not connected.");
		return;
	}

	if (adapter.apiPollRunning) {
		adapter.log.warn("[API] Poll still running — skipping overlapping execution.");
		return;
	}

	adapter.apiPollRunning = true;

	const baseInterval = adapter.dashboardInterval;
	let nextDelay = baseInterval;

	try {
		if (adapter.authBlocked) {
			adapter.log.debug("⏸ Poll skipped - authentication currently recovering.");
			nextDelay = baseInterval;
			return;
		}

		const cycleResult = await apiRunPollCycle(adapter);

		if (cycleResult.totalFailure) {
			throw new Error(cycleResult.message || "All scheduled API tasks failed during polling.");
		}

		if (cycleResult.partialFailure) {
			adapter.log.warn(
				`[API] Partial failure: ${cycleResult.failedSystems} system(s) failed, ` +
					`at least one scheduled task succeeded.`,
			);
		}

		adapter.apiFailureCount = 0;
		await adapter.setState("info.connection", true, true);

		nextDelay = baseInterval;
	} catch (err) {
		adapter.apiFailureCount = (adapter.apiFailureCount || 0) + 1;
		adapter.logError(err, `[API] 🚨 API Poll failed - ⚠️ Failure count: ${adapter.apiFailureCount}`);
		await adapter.setState("info.connection", false, true);

		nextDelay = computeBackoffDelay(baseInterval, adapter.apiFailureCount);
		nextDelay = Math.min(nextDelay, baseInterval * 8);

		adapter.log.warn(
			`[API] ⏱ Backoff delay: Retry ${adapter.apiFailureCount} in ${(nextDelay / 1000).toFixed(0)}s`,
		);
	} finally {
		adapter.apiPollRunning = false;

		if (adapter.config.api_debug_states) {
			try {
				await apiUpdateQueueStats(adapter);
			} catch (statsError) {
				adapter.log.debug(`Failed to update queue stats: ${statsError.message}`);
			}
		}

		if (adapter.config.api_debug_log) {
			try {
				logApiQueueRecommendationIfChanged(adapter);
				logApiQueueStatsIfChanged(adapter);
			} catch (logError) {
				adapter.log.debug(`Failed to log queue stats: ${logError.message}`);
			}
		}

		apiScheduleNextPoll(adapter, nextDelay);
	}
}

/**
 * Schedules the next API poll.
 * The method calculates the delay for the next poll based on the success or failure of the current poll cycle, implementing a backoff strategy in case of failures to prevent overwhelming the SENEC API. It also ensures that no new poll is scheduled if the adapter is unloaded, and it clears any existing timers to avoid overlapping polls. The method logs the scheduled time for the next poll for debugging purposes.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} delay - The delay in milliseconds before the next poll.
 * @returns {void}
 */
function apiScheduleNextPoll(adapter, delay) {
	if (adapter.unloaded) {
		return;
	}

	adapter.clearTimeout(adapter.timerAPI);
	adapter.timerAPI = null;

	adapter.timerAPI =
		adapter.setTimeout(() => {
			apiPoll(adapter).catch((e) => adapter.logError(e, "[API] ❌ Scheduled API poll failed"));
		}, delay) ?? null;
	adapter.log.debug(`⏱ Next API poll scheduled in ${(delay / 1000).toFixed(0)}s`);
}

/**
 * Builds the context for an API poll cycle, determining which tasks should run based on the last poll timestamps and configured intervals.
 * The method calculates whether the dashboard, details, and heavy tasks should run by comparing the current time with the last poll timestamps for each task type and the respective configured intervals. It also prepares relevant date information (today, yesterday, current month, last month) in UTC to be used for API calls that require date parameters. The resulting context object contains flags indicating which tasks to run and the prepared date information for use in the API polling methods.
 * The method ensures that the API polling logic can make informed decisions about which data to fetch during each poll cycle, optimizing the polling process based on the configured intervals and the timing of previous polls.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {object} Context object containing flags for which tasks to run and relevant date information for the API calls.
 */
function apiBuildPollContext(adapter) {
	const shouldRunDashboard = apiShouldRunInterval(adapter.lastApiDashboardPoll, adapter.dashboardInterval);
	const shouldRunDetails = apiShouldRunInterval(adapter.lastApiDetailsPoll, adapter.detailsInterval);
	const shouldRunHeavy = apiShouldRunInterval(adapter.lastApiHeavyPoll, adapter.heavyInterval);

	const now = new Date();
	const utcYear = now.getUTCFullYear();
	const utcMonth = now.getUTCMonth();
	const utcDate = now.getUTCDate();

	return {
		shouldRunDashboard,
		shouldRunDetails,
		shouldRunHeavy,
		today: new Date(utcYear, utcMonth, utcDate, 0, 0, 0, 0),
		yesterday: new Date(utcYear, utcMonth, utcDate - 1, 0, 0, 0, 0),
		currentMonth: new Date(Date.UTC(utcYear, utcMonth, 1)),
		lastMonth: new Date(Date.UTC(utcYear, utcMonth - 1, 1)),
		utcYear,
	};
}

/**
 * Ensures that the API systems are loaded.
 * The method checks if the known systems from the API are already loaded, and if not, it makes an API call to fetch the available systems. It then iterates through the returned systems, logs their information for debugging purposes, adds their IDs to the set of known systems, and evaluates the poll for each system to prepare for subsequent API calls. This method is crucial for ensuring that the adapter has the necessary information about the available systems before attempting to poll data from the API.
 * The method also includes error handling to throw an error if no systems are returned from the API, which is essential for the proper functioning of the adapter, as it relies on having at least one system to poll data from. By loading the systems at this stage, the adapter can optimize its polling process and ensure that it is targeting the correct systems for data retrieval.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function apiEnsureSystemsLoaded(adapter) {
	if (adapter.apiKnownSystems.size > 0) {
		return;
	}

	adapter.log.debug("🔄 Reading available systems from API ...");
	// Old: /v1/systems → New: /systems/api/v1 (API_HOST_SYSTEMS already includes /systems/api)
	const sysRes = await apiGet(adapter, `${API_HOST_SYSTEMS}/v1`);

	if (!sysRes?.data?.length) {
		throw new Error("No systems returned from API.");
	}

	for (const sys of sysRes.data) {
		adapter.log.debug(`System found: ${JSON.stringify(sys)}`);
		adapter.apiKnownSystems.add(sys.id);
		await adapter.evalPoll(sys, `${API_PFX}Anlagen.${sys.id}.`);
		await apiPollAbilities(adapter, sys.id);
		await apiPollWallboxSearch(adapter, sys.id);
		await apiCreateWallboxControls(adapter);
	}
}

/**
 * Executes one full API cycle across all known systems.
 * Handles dashboard/details/heavy polling and optionally one rebuild batch.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<{totalFailure: boolean, partialFailure: boolean, failedSystems: number, message: string}>} Result of the poll cycle, including failure status and messages.
 * @throws {Error} Will throw an error if all scheduled tasks fail during the poll cycle.
 */
async function apiRunPollCycle(adapter) {
	let rebuildExecuted = false;
	if (adapter.config.api_showPolling) {
		adapter.log.info("[API] 🔄 Polling SENEC App API...");
	} else {
		adapter.log.debug("🔄 Polling SENEC App API...");
	}

	if (!adapter.currentToken) {
		await apiRefreshToken(adapter);
	}

	await apiEnsureSystemsLoaded(adapter);

	const ctx = apiBuildPollContext(adapter);

	const result = {
		anyWorkScheduled: false,
		anyWorkSucceeded: false,
		failedSystems: 0,

		dashboardScheduled: ctx.shouldRunDashboard,
		detailsScheduled: ctx.shouldRunDetails,
		heavyScheduled: ctx.shouldRunHeavy,

		dashboardSucceeded: 0,
		detailsSucceeded: 0,
		heavySucceeded: 0,
	};

	for (const anlagenId of adapter.apiKnownSystems) {
		const systemResult = await apiPollSingleSystem(adapter, anlagenId, ctx, rebuildExecuted);
		apiMergeSystemPollResult(result, systemResult);

		if (systemResult.rebuildExecuted) {
			rebuildExecuted = true;
		}
	}

	apiFinalizePollTimestamps(adapter, result);

	return {
		totalFailure: result.anyWorkScheduled && !result.anyWorkSucceeded,
		partialFailure: result.failedSystems > 0 && result.anyWorkSucceeded,
		failedSystems: result.failedSystems,
		message: "All scheduled API tasks failed during polling.",
	};
}

/**
 * Polls the API for a single system based on the provided context.
 * The method performs the necessary API calls for the dashboard, details, and heavy tasks based on the flags set in the context. It keeps track of the success and failure of each task type for the system and returns an object summarizing the results. The method includes error handling to catch any exceptions that occur during the API calls for the system, ensuring that a failure in one task does not prevent the execution of other tasks for the same system. By providing detailed results for each system, this method allows for better monitoring and debugging of individual system interactions with the SENEC App API.
 * The method assumes that the necessary authentication token is available and that the API systems are loaded before it is called, as it relies on this information to perform the API calls effectively. It also updates the poll timestamps for each task type based on the success of the API calls, which is essential for the scheduling logic of subsequent poll cycles.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @param {object} ctx - The context object containing flags for which tasks to run and relevant date information for the API calls.
 * @param {boolean} rebuildAlreadyExecuted - was rebuild already executed
 * @returns {Promise<{failed: boolean;dashboardScheduled: boolean;detailsScheduled: boolean;heavyScheduled: boolean;dashboardSucceeded: boolean;detailsSucceeded: boolean;heavySucceeded: boolean;rebuildExecuted: boolean;}>} Result of the API poll for the system, including success and failure status for each task type.
 */
async function apiPollSingleSystem(adapter, anlagenId, ctx, rebuildAlreadyExecuted) {
	const logType = adapter.config.api_showPolling ? "info" : "debug";
	const result = {
		failed: false,
		dashboardScheduled: false,
		detailsScheduled: false,
		heavyScheduled: false,
		dashboardSucceeded: false,
		detailsSucceeded: false,
		heavySucceeded: false,
		rebuildExecuted: false,
	};

	adapter.log.debug(`🔄 Polling system ${anlagenId}...`);

	if (ctx.shouldRunDashboard) {
		adapter.log[logType](`🔄 Polling system ${anlagenId} - Dashboard`);
		result.dashboardScheduled = true;
		const dashboardPolls = [
			apiPollDashboard(adapter, anlagenId),
			apiPollSystemStatus(adapter, anlagenId),
			// apiPollOnlineState disabled — endpoint returns 404, not yet active on SENEC side
		];
		if (adapter.apiWallboxCount > 0) {
			dashboardPolls.push(apiPollWallboxSearch(adapter, anlagenId));
		}
		const results = await Promise.allSettled(dashboardPolls);
		result.dashboardSucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (ctx.shouldRunDetails) {
		adapter.log[logType](`🔄 Polling system ${anlagenId} - Details (day values)`);
		result.detailsScheduled = true;
		const detailsPolls = [apiPollDetails(adapter, anlagenId, ctx), apiPollSystemDetails(adapter, anlagenId)];
		const results = await Promise.allSettled(detailsPolls);
		result.detailsSucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (ctx.shouldRunHeavy) {
		adapter.log[logType](`🔄 Polling system ${anlagenId} - Heavy (month / year values)`);
		result.heavyScheduled = true;
		const results = await Promise.allSettled([
			apiPollHeavy(adapter, anlagenId, ctx),
			apiPollDataAvailability(adapter, anlagenId),
			// apiPollForecastChargingSettings disabled — endpoint returns 400, not yet active on SENEC side
		]);
		result.heavySucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (getRebuild().isRebuildEnabled(adapter) && !adapter.rebuildRunning && !rebuildAlreadyExecuted) {
		try {
			await getRebuild().doRebuild(adapter, anlagenId);
			result.rebuildExecuted = true;
		} catch (rebuildError) {
			adapter.logError(rebuildError, `[API] ❌ Rebuild for system ${anlagenId} failed.`);
		}
	}

	return result;
}

/**
 * Polls the API for the dashboard data of a single system.
 * The method makes an API call to retrieve the dashboard data for the specified system ID, logs the keys of the returned data for debugging purposes, and then evaluates the poll to update the relevant states based on the retrieved data. The method includes error handling to catch any exceptions that occur during the API call, ensuring that a failure in retrieving the dashboard data does not prevent the execution of other tasks for the same system. By providing detailed logging of the retrieved data, this method allows for better monitoring and debugging of the interactions with the SENEC App API for the dashboard data.
 * The method assumes that the necessary authentication token is available and that the API systems are loaded before it is called, as it relies on this information to perform the API call effectively. It also updates the poll timestamps for the dashboard task based on the success of the API call, which is essential for the scheduling logic of subsequent poll cycles.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollDashboard(adapter, anlagenId) {
	try {
		const dashRes = await apiGet(adapter, `${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/dashboard`);
		adapter.log.silly(`DashRes keys: ${Object.keys(dashRes.data).join(", ")}`);
		await adapter.evalPoll(dashRes.data, `${API_PFX}Anlagen.${anlagenId}.Dashboard.`);
		await adapter.updateLastPoll(`${API_PFX}info.lastPoll.Dashboard`, "Last successful Dashboard poll");
	} catch (error) {
		adapter.logError(error, `[API] ❌ Dashboard poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Generic API poll: GET → evalPoll → update lastPoll → log.
 * For simple endpoints that follow the standard pattern.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System ID
 * @param {string} url - Full API URL
 * @param {string} evalPrefix - Prefix for evalPoll (e.g. "_api.Anlagen.{id}.OnlineState.")
 * @param {string} pollName - Name for lastPoll state and log messages
 * @returns {Promise<void>}
 */
async function _apiPollEndpoint(adapter, anlagenId, url, evalPrefix, pollName) {
	try {
		const res = await apiGet(adapter, url);
		if (!res?.data) {
			return;
		}
		await adapter.evalPoll(res.data, evalPrefix);
		await adapter.updateLastPoll(`${API_PFX}info.lastPoll.${pollName}`, `Last successful ${pollName} poll`);
		adapter.log.debug(`${pollName} polled for ${anlagenId}`);
	} catch (error) {
		adapter.logError(error, `[API] ❌ ${pollName} poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Polls the API for online state (online/offline, since when).
 * Called on the dashboard tier.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollOnlineState(adapter, anlagenId) {
	await _apiPollEndpoint(
		adapter,
		anlagenId,
		`${API_HOST_SYSTEMS}/v1/${anlagenId}/online-state`,
		`${API_PFX}Anlagen.${anlagenId}.OnlineState.`,
		"OnlineState",
	);
}

/**
 * Polls the API for system status (operating mode, firmware, last contact).
 * Called on the dashboard tier.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollSystemStatus(adapter, anlagenId) {
	await _apiPollEndpoint(
		adapter,
		anlagenId,
		`${API_HOST_SYSTEMS}/v1/status/${anlagenId}`,
		`${API_PFX}Anlagen.${anlagenId}.SystemStatus.`,
		"SystemStatus",
	);
}

/**
 * Polls the API for system details (hardware info, battery state, inverter temps).
 * Called on the details tier (hourly).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollSystemDetails(adapter, anlagenId) {
	await _apiPollEndpoint(
		adapter,
		anlagenId,
		`${API_HOST_SYSTEMS}/v1/${anlagenId}/details`,
		`${API_PFX}Anlagen.${anlagenId}.SystemDetails.`,
		"SystemDetails",
	);
}

/**
 * Polls the API for installed abilities/feature packages.
 * Called once after systems are loaded.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollAbilities(adapter, anlagenId) {
	try {
		const res = await apiGet(adapter, `${API_HOST_ABILITIES}/v1/packages/${anlagenId}`);
		if (!res?.data) {
			return;
		}
		const pfx = `${API_PFX}Anlagen.${anlagenId}.Abilities.`;

		if (Array.isArray(res.data.packageTypes)) {
			await adapter.doState(
				`${pfx}packageTypes`,
				JSON.stringify(res.data.packageTypes),
				"Installed feature packages",
				"",
				false,
			);

			// Also create individual boolean states for each known package type
			const knownTypes = ["MOBILITY", "PEAK_SHAVING", "SG_READY", "HEATING_ROD", "SOCKETS"];
			for (const pkg of knownTypes) {
				await adapter.doState(
					`${pfx}${pkg}`,
					res.data.packageTypes.includes(pkg),
					`Feature: ${pkg}`,
					"",
					false,
				);
			}
		}

		if (res.data.warrantyPackage != null) {
			await adapter.doState(`${pfx}warrantyPackage`, res.data.warrantyPackage, "Warranty package", "", false);
		}

		adapter.log.debug(`Abilities polled for ${anlagenId}`);
	} catch (error) {
		adapter.logError(error, `[API] ❌ Abilities poll failed for ${anlagenId}`);
	}
}

/**
 * Polls the API for forecast charging settings.
 * Called on the heavy tier (daily).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollForecastChargingSettings(adapter, anlagenId) {
	await _apiPollEndpoint(
		adapter,
		anlagenId,
		`${API_HOST_SYSTEMS}/v1/settings/forecast-charging-settings/${anlagenId}`,
		`${API_PFX}Anlagen.${anlagenId}.ForecastChargingSettings.`,
		"ForecastChargingSettings",
	);
}

/**
 * Searches for wallboxes via the App API.
 * Called once at startup. Stores wallbox data under _api.Anlagen.{id}.Wallboxes.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to search wallboxes for.
 * @returns {Promise<void>}
 */
async function apiPollWallboxSearch(adapter, anlagenId) {
	try {
		const res = await apiPost(adapter, `${API_HOST_WALLBOX}/v1/systems/wallboxes/search`, {
			systemIds: [anlagenId],
		});
		if (!res?.data) {
			return;
		}
		if (!Array.isArray(res.data)) {
			adapter.log.debug(`Wallbox search returned non-array response for ${anlagenId}`);
			return;
		}
		if (res.data.length === 0) {
			adapter.log.debug(`No wallboxes found for ${anlagenId}`);
			return;
		}
		adapter.apiWallboxCount = res.data.length;
		adapter.apiWallboxUuids = res.data.map((wb) => wb.id).filter(Boolean);
		adapter.apiWallboxObjects = res.data;
		adapter.apiWallboxSystemId = anlagenId;
		adapter.log.info(`[API] Found ${adapter.apiWallboxCount} wallbox(es) via API for ${anlagenId}`);
		for (let i = 0; i < res.data.length; i++) {
			await adapter.evalPoll(res.data[i], `${API_PFX}Anlagen.${anlagenId}.Wallboxes.${i}.`);
		}
		await adapter.updateLastPoll(`${API_PFX}info.lastPoll.WallboxSearch`, "Last successful WallboxSearch poll");
		await apiSyncWallboxControls(adapter);
	} catch (error) {
		adapter.logError(error, `[API] ❌ Wallbox search failed for ${anlagenId}`);
		// Don't re-throw — wallbox search failure at startup shouldn't block anything
	}
}

/**
 * Create control datapoints for API wallbox control.
 * Called once after wallbox search discovers wallboxes.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function apiCreateWallboxControls(adapter) {
	if (!adapter.config.control_api_active || adapter.config.control_wallbox_connector !== "api") {
		return;
	}
	if (adapter.apiWallboxCount === 0) {
		return;
	}

	for (let i = 0; i < adapter.apiWallboxCount; i++) {
		const pfx = `control.Wallbox.${i}`;
		await adapter.setObjectNotExistsAsync(pfx, {
			type: "channel",
			common: { name: `API Wallbox ${i} Control` },
			native: {},
		});

		// Combined mode: LOCKED / FAST / SOLAR / COMFORT
		await adapter.setObjectNotExistsAsync(`${pfx}.Mode`, {
			type: "state",
			common: {
				name: "Wallbox mode",
				type: "string",
				role: "text",
				read: true,
				write: true,
				states: { LOCKED: "Locked", FAST: "Fast", SOLAR: "Solar", COMFORT: "Comfort" },
			},
			native: {},
		});

		// Min charging current (A) — applicable in SOLAR and COMFORT mode
		await adapter.setObjectNotExistsAsync(`${pfx}.MinChargingCurrentInA`, {
			type: "state",
			common: {
				name: "Min charging current",
				type: "number",
				role: "level",
				unit: "A",
				read: true,
				write: true,
				min: 6,
				max: 32,
			},
			native: {},
		});

		// AllowIntercharge — applicable in FAST and COMFORT mode
		await adapter.setObjectNotExistsAsync(`${pfx}.AllowIntercharge`, {
			type: "state",
			common: {
				name: "Allow intercharge (battery discharge for wallbox)",
				type: "boolean",
				role: "switch",
				read: true,
				write: true,
			},
			native: {},
		});

		// PreventInterruptions — applicable in SOLAR and COMFORT mode
		await adapter.setObjectNotExistsAsync(`${pfx}.PreventInterruptions`, {
			type: "state",
			common: {
				name: "Prevent charging interruptions",
				type: "boolean",
				role: "switch",
				read: true,
				write: true,
			},
			native: {},
		});
	}

	// Apply button — user sets to true to send all pending changes
	for (let i = 0; i < adapter.apiWallboxCount; i++) {
		await adapter.setObjectNotExistsAsync(`control.Wallbox.${i}.Apply`, {
			type: "state",
			common: {
				name: "Apply pending changes",
				type: "boolean",
				role: "button",
				read: true,
				write: true,
				def: false,
			},
			native: {},
		});
	}

	await adapter.subscribeStatesAsync("control.Wallbox.*");
	adapter.log.info(`[API] Created wallbox control datapoints for ${adapter.apiWallboxCount} wallbox(es)`);
}

/**
 * Sync API wallbox control datapoints with values from the cached wallbox objects.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function apiSyncWallboxControls(adapter) {
	if (!adapter.config.control_api_active || adapter.config.control_wallbox_connector !== "api") {
		return;
	}

	for (let i = 0; i < adapter.apiWallboxObjects.length; i++) {
		const wb = adapter.apiWallboxObjects[i];
		if (!wb) {
			continue;
		}
		const pfx = `control.Wallbox.${i}`;

		// Determine combined mode
		let mode = "LOCKED";
		if (!wb.prohibitUsage) {
			const chargingType = wb.chargingMode?.type?.toUpperCase();
			if (chargingType === "SOLAR" || chargingType === "FAST" || chargingType === "COMFORT") {
				mode = chargingType;
			}
		}
		await adapter.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });

		// Sync settings based on current mode
		const solarSettings = wb.chargingMode?.solarOptimizeSettings;
		const fastSettings = wb.chargingMode?.fastChargingSettings;
		const comfortSettings = wb.chargingMode?.comfortChargeSettings;

		// MinChargingCurrentInA — from solar or comfort settings
		if (solarSettings?.minChargingCurrentInA !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.MinChargingCurrentInA`, {
				val: solarSettings.minChargingCurrentInA,
				ack: true,
			});
		} else if (comfortSettings?.configuredChargingCurrent !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.MinChargingCurrentInA`, {
				val: comfortSettings.configuredChargingCurrent,
				ack: true,
			});
		}

		// AllowIntercharge — from fast or comfort settings
		if (fastSettings?.allowIntercharge !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.AllowIntercharge`, {
				val: !!fastSettings.allowIntercharge,
				ack: true,
			});
		} else if (comfortSettings?.allowIntercharge !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.AllowIntercharge`, {
				val: !!comfortSettings.allowIntercharge,
				ack: true,
			});
		}

		// PreventInterruptions — from solar or comfort settings
		if (solarSettings?.preventInterruptions !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.PreventInterruptions`, {
				val: !!solarSettings.preventInterruptions,
				ack: true,
			});
		} else if (comfortSettings?.preventInterruptions !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.PreventInterruptions`, {
				val: !!comfortSettings.preventInterruptions,
				ack: true,
			});
		}
	}
}

/**
 * Handle an API wallbox control state change.
 * For settings (Mode, MinChargingCurrentInA, etc.) the value is just stored without ack.
 * For Apply, all pending values are read and sent to the API.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} wbIdx - Wallbox index (0-based)
 * @param {string} field - The control field name
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 */
async function apiHandleWallboxControl(adapter, wbIdx, field, value) {
	if (wbIdx >= adapter.apiWallboxCount || !adapter.apiWallboxSystemId) {
		adapter.log.warn(`[API] Wallbox ${wbIdx} does not exist`);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		adapter.log.debug(`API Wallbox ${wbIdx}: pending ${field} = ${value}`);
		return;
	}

	// Apply: read all pending values and send to API
	if (!value) {
		return; // Only act on true
	}

	const uuid = adapter.apiWallboxUuids[wbIdx];
	if (!uuid) {
		adapter.log.warn(`[API] No UUID for wallbox ${wbIdx}`);
		return;
	}

	const pfx = `control.Wallbox.${wbIdx}`;
	const systemId = adapter.apiWallboxSystemId;
	const baseUrl = `${API_HOST_WALLBOX}/v1/systems/${systemId}/wallboxes/${encodeURIComponent(uuid)}`;

	try {
		// Read pending values from states
		const pendingMode = (await adapter.getStateAsync(`${pfx}.Mode`))?.val;
		const pendingMinCurrent = (await adapter.getStateAsync(`${pfx}.MinChargingCurrentInA`))?.val;
		const pendingAllowIntercharge = (await adapter.getStateAsync(`${pfx}.AllowIntercharge`))?.val;
		const pendingPreventInterruptions = (await adapter.getStateAsync(`${pfx}.PreventInterruptions`))?.val;

		const wb = adapter.apiWallboxObjects[wbIdx];
		const targetMode = pendingMode ? String(pendingMode).toUpperCase() : null;

		// 1. Handle mode/lock change
		if (targetMode) {
			const currentlyLocked = !!wb?.prohibitUsage;
			const currentMode = wb?.chargingMode?.type?.toUpperCase();

			if (targetMode === "LOCKED" && !currentlyLocked) {
				adapter.log.info(`[API] Locking wallbox ${wbIdx}...`);
				const res = await apiPatch(adapter, `${baseUrl}/locked/true`);
				if (res?.data) {
					adapter.apiWallboxObjects[wbIdx] = res.data;
				}
			} else if (targetMode !== "LOCKED") {
				if (currentlyLocked) {
					adapter.log.info(`[API] Unlocking wallbox ${wbIdx} before mode change...`);
					const unlockRes = await apiPatch(adapter, `${baseUrl}/locked/false`);
					if (!unlockRes?.data) {
						adapter.log.warn(`[API] Unlock failed for wallbox ${wbIdx}`);
						await adapter.setState(`${pfx}.Apply`, { val: false, ack: true });
						return;
					}
					adapter.apiWallboxObjects[wbIdx] = unlockRes.data;
				}
				if (targetMode !== currentMode) {
					adapter.log.info(`[API] Setting wallbox ${wbIdx} mode to ${targetMode}...`);
					const res = await apiPatch(adapter, `${baseUrl}/charging-mode/${targetMode}`);
					if (res?.data) {
						adapter.apiWallboxObjects[wbIdx] = res.data;
					}
				}
			}
		}

		// 2. Handle settings for the active mode (use latest wb object after mode change)
		const activeWb = adapter.apiWallboxObjects[wbIdx];
		const activeMode = activeWb?.chargingMode?.type?.toUpperCase();

		if (activeMode === "SOLAR") {
			const settings = activeWb.chargingMode.solarOptimizeSettings || {};
			const postData = {
				minChargingCurrentInA:
					pendingMinCurrent != null
						? parseFloat(String(pendingMinCurrent))
						: (settings.minChargingCurrentInA ?? 6),
				preventInterruptions:
					pendingPreventInterruptions != null
						? !!pendingPreventInterruptions
						: (settings.preventInterruptions ?? false),
				compatibilityMode: settings.compatibilityMode ?? false,
				useDynamicTariffs: settings.useDynamicTariffs ?? false,
				priceLimitInCtPerKwh: settings.priceLimitInCtPerKwh ?? -99,
			};
			adapter.log.info(`[API] Applying wallbox ${wbIdx} solar settings...`);
			const res = await apiPatch(adapter, `${baseUrl}/settings/solar-charge`, postData);
			if (res?.data) {
				adapter.apiWallboxObjects[wbIdx] = res.data;
			}
		} else if (activeMode === "FAST") {
			if (pendingAllowIntercharge != null) {
				adapter.log.info(`[API] Applying wallbox ${wbIdx} fast settings...`);
				const res = await apiPatch(adapter, `${baseUrl}/settings/fast-charge`, {
					allowIntercharge: !!pendingAllowIntercharge,
				});
				if (res?.data) {
					adapter.apiWallboxObjects[wbIdx] = res.data;
				}
			}
		} else if (activeMode === "COMFORT") {
			const settings = activeWb.chargingMode.comfortChargeSettings || {};
			const postData = {
				minChargingCurrentInA:
					pendingMinCurrent != null
						? parseFloat(String(pendingMinCurrent))
						: (settings.configuredChargingCurrent ?? 6),
				allowIntercharge:
					pendingAllowIntercharge != null ? !!pendingAllowIntercharge : (settings.allowIntercharge ?? false),
				preventInterruptions:
					pendingPreventInterruptions != null
						? !!pendingPreventInterruptions
						: (settings.preventInterruptions ?? false),
				useDynamicTariffs: settings.useDynamicTariffs ?? false,
				priceLimitInCtPerKwh: settings.priceLimitInCtPerKwh ?? -99,
			};
			adapter.log.info(`[API] Applying wallbox ${wbIdx} comfort settings...`);
			const res = await apiPatch(adapter, `${baseUrl}/comfort-charge-expert-settings`, postData);
			if (res?.data) {
				adapter.apiWallboxObjects[wbIdx] = res.data;
			}
		}

		// Sync control states with actual device values and reset Apply
		await apiSyncWallboxControls(adapter);
		await adapter.setState(`${pfx}.Apply`, { val: false, ack: true });
		adapter.log.info(`[API] Wallbox ${wbIdx} changes applied successfully`);
	} catch (error) {
		adapter.logError(error, `[API] ❌ Failed to apply API wallbox ${wbIdx} changes`);
		await adapter.setState(`${pfx}.Apply`, { val: false, ack: true });
	}
}

/**
 * Polls the API for data availability timespan.
 * Called once after systems are loaded. Returns the date range for which
 * measurement data is available — useful for history rebuild.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 */
async function apiPollDataAvailability(adapter, anlagenId) {
	try {
		const res = await apiGet(
			adapter,
			`${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/data-availability/timespan?timezone=UTC`,
		);
		if (!res?.data) {
			return;
		}
		await adapter.evalPoll(res.data, `${API_PFX}Anlagen.${anlagenId}.DataAvailability.`);
		// Add human-readable date companions for ms timestamp fields
		const pfx = `${API_PFX}Anlagen.${anlagenId}.DataAvailability.`;
		if (res.data.periodStartDateInMilliseconds != null) {
			await adapter.doState(
				`${pfx}periodStartDate`,
				new Date(res.data.periodStartDateInMilliseconds).toISOString(),
				"Data available from",
				"",
				false,
			);
		}
		if (res.data.periodEndDateInMilliseconds != null) {
			await adapter.doState(
				`${pfx}periodEndDate`,
				new Date(res.data.periodEndDateInMilliseconds).toISOString(),
				"Data available until",
				"",
				false,
			);
		}
		await adapter.updateLastPoll(
			`${API_PFX}info.lastPoll.DataAvailability`,
			"Last successful DataAvailability poll",
		);
		adapter.log.debug(`Data availability polled for ${anlagenId}`);
	} catch (error) {
		adapter.logError(error, `[API] ❌ Data availability poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Run an array of measurement tasks, summarize results, and update lastPoll.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId - System ID
 * @param {Array<{fn: () => Promise<{status: string}>, label: string}>} tasks - Measurement tasks
 * @param {string} pollName - Name for log messages and lastPoll state
 * @param {(() => Promise<void>)} [beforeLastPoll] - Optional async work to run after tasks but before lastPoll
 * @returns {Promise<void>}
 */
async function _runMeasurementTasks(adapter, anlagenId, tasks, pollName, beforeLastPoll) {
	try {
		const results = await Promise.all(
			tasks.map(async (task) => {
				const res = await task.fn();
				return { label: task.label, ...res };
			}),
		);

		if (adapter.config.api_debug_log) {
			for (const r of results) {
				adapter.log.debug(`${pollName} ${anlagenId} / ${r.label}: ${r.status}`);
			}
		}

		const m = getMeasurements();
		const summary = m.summarizeMeasurementResults(results);
		const classification = m.classifyMeasurementSummary(summary);

		adapter.log.debug(
			`${pollName} summary ${anlagenId}: ${m.formatMeasurementSummary(summary)} | ${m.formatMeasurementClassification(classification)}`,
		);

		if (beforeLastPoll) {
			await beforeLastPoll();
		}
		await adapter.updateLastPoll(`${API_PFX}info.lastPoll.${pollName}`, `Last successful ${pollName} poll`);
	} catch (error) {
		adapter.logError(error, `[API] ❌ ${pollName} poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Polls the API for the details data of a single system.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId anlagen id
 * @param {object} ctx context
 * @returns {Promise<void>}
 */
async function apiPollDetails(adapter, anlagenId, ctx) {
	const m = getMeasurements();
	const tasks = [
		{ fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.today, "today"), label: "today" },
		{ fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.today, "today.hourly"), label: "today.hourly" },
		{ fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.yesterday, "yesterday"), label: "yesterday" },
		{
			fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.yesterday, "yesterday.hourly"),
			label: "yesterday.hourly",
		},
	];

	// Add wallbox measurement tasks
	for (let i = 0; i < adapter.apiWallboxUuids.length; i++) {
		const wb = { uuid: adapter.apiWallboxUuids[i], index: i };
		tasks.push({
			fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.today, "today", wb),
			label: `wb${i}.today`,
		});
		tasks.push({
			fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.today, "today.hourly", wb),
			label: `wb${i}.today.hourly`,
		});
		tasks.push({
			fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.yesterday, "yesterday", wb),
			label: `wb${i}.yesterday`,
		});
		tasks.push({
			fn: () => m.doMeasurementsDay(adapter, anlagenId, ctx.yesterday, "yesterday.hourly", wb),
			label: `wb${i}.yesterday.hourly`,
		});
	}

	await _runMeasurementTasks(adapter, anlagenId, tasks, "Details");
}

/**
 * Polls the API for the heavy data of a single system.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} anlagenId Anlagen id to poll
 * @param {object} ctx context
 * @returns {Promise<void>}
 */
async function apiPollHeavy(adapter, anlagenId, ctx) {
	const m = getMeasurements();
	const r = getRebuild();
	const tasks = [
		{
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.currentMonth, "current_month"),
			label: "current_month",
		},
		{
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.currentMonth, "current_month.daily"),
			label: "current_month.daily",
		},
		{
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.lastMonth, "previous_month"),
			label: "previous_month",
		},
		{
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.lastMonth, "previous_month.daily"),
			label: "previous_month.daily",
		},

		{ fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear, false), label: "year" },
		{ fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear, true), label: "year.monthly" },
		{ fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear - 1, false), label: "prev_year" },
		{ fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear - 1, true), label: "prev_year.monthly" },
	];

	// Add wallbox measurement tasks
	for (let i = 0; i < adapter.apiWallboxUuids.length; i++) {
		const wb = { uuid: adapter.apiWallboxUuids[i], index: i };
		tasks.push({
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.currentMonth, "current_month", wb),
			label: `wb${i}.current_month`,
		});
		tasks.push({
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.currentMonth, "current_month.daily", wb),
			label: `wb${i}.current_month.daily`,
		});
		tasks.push({
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.lastMonth, "previous_month", wb),
			label: `wb${i}.previous_month`,
		});
		tasks.push({
			fn: () => m.doMeasurementsMonth(adapter, anlagenId, ctx.lastMonth, "previous_month.daily", wb),
			label: `wb${i}.previous_month.daily`,
		});
		tasks.push({
			fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear, false, wb),
			label: `wb${i}.year`,
		});
		tasks.push({
			fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear, true, wb),
			label: `wb${i}.year.monthly`,
		});
		tasks.push({
			fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear - 1, false, wb),
			label: `wb${i}.prev_year`,
		});
		tasks.push({
			fn: () => m.doMeasurementsYear(adapter, anlagenId, ctx.utcYear - 1, true, wb),
			label: `wb${i}.prev_year.monthly`,
		});
	}

	await _runMeasurementTasks(adapter, anlagenId, tasks, "Heavy", () => r.updateAllTimeHistory(adapter, anlagenId));
}

/**
 * Merges the results of a system poll into the overall poll result.
 * The method takes the results of a single system poll and updates the overall poll result object by incrementing the counts for scheduled and succeeded tasks, as well as the count of failed systems. It checks the flags for each task type (dashboard, details, heavy) in the single system result and updates the corresponding fields in the total result accordingly. This method is essential for aggregating the results of individual system polls into a comprehensive summary of the entire poll cycle, allowing for better monitoring and analysis of the polling process across all systems.
 * The method assumes that the total result object is initialized with the necessary fields to track the counts of scheduled and succeeded tasks, as well as the count of failed systems. By systematically merging the results of each system poll, the method ensures that the overall poll result accurately reflects the performance and outcomes of the API polling process for all systems.
 *
 * @param {object} total - The overall poll result object that aggregates the results of all system polls.
 * @param {object} single - The result object for a single system poll, containing flags for scheduled and succeeded tasks, as well as a failure flag.
 * @returns {void}
 */
function apiMergeSystemPollResult(total, single) {
	if (single.dashboardScheduled || single.detailsScheduled || single.heavyScheduled) {
		total.anyWorkScheduled = true;
	}

	if (single.dashboardSucceeded || single.detailsSucceeded || single.heavySucceeded) {
		total.anyWorkSucceeded = true;
	}

	if (single.failed) {
		total.failedSystems++;
	}

	if (single.dashboardSucceeded) {
		total.dashboardSucceeded++;
	}
	if (single.detailsSucceeded) {
		total.detailsSucceeded++;
	}
	if (single.heavySucceeded) {
		total.heavySucceeded++;
	}
}

/**
 * Finalizes the poll timestamps based on the results of the poll cycle.
 * The method checks the results of the poll cycle for each task type (dashboard, details, heavy) and updates the last poll timestamps accordingly if all scheduled tasks of that type succeeded for all known systems. It compares the count of succeeded tasks with the total number of known systems to determine if the poll timestamp should be updated. This method is crucial for maintaining accurate scheduling of subsequent poll cycles, as it ensures that the adapter has the correct information about when each task type was last successfully polled, allowing for optimized scheduling based on the configured intervals.
 * The method assumes that the total result object contains accurate counts of scheduled and succeeded tasks for each task type, as well as the total number of known systems. By systematically finalizing the poll timestamps based on the results, the method helps to ensure that the adapter operates efficiently and effectively in its interactions with the SENEC App API.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} result - The result object of the poll cycle, containing counts of scheduled and succeeded tasks for each task type, as well as the total number of known systems.
 * @returns {void}
 */
function apiFinalizePollTimestamps(adapter, result) {
	const systemsCount = adapter.apiKnownSystems.size;

	if (result.dashboardScheduled && result.dashboardSucceeded === systemsCount) {
		apiMarkPollTimestamp(adapter, "dashboard");
	}

	if (result.detailsScheduled && result.detailsSucceeded === systemsCount) {
		apiMarkPollTimestamp(adapter, "details");
	}

	if (result.heavyScheduled && result.heavySucceeded === systemsCount) {
		apiMarkPollTimestamp(adapter, "heavy");
	}
}

/**
 * API Get with automatic token refresh on 401 and retry mechanism using AdaptiveRequestQueue
 * to avoid multiple parallel token refreshes and to limit parallel API calls in general.
 *
 * Important:
 * - Rate limiting (429) and timeout-based overload handling are primarily managed inside
 *   AdaptiveRequestQueue. This function only logs and propagates signals.
 * - Token refresh (401) is handled here.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {"get" | "post" | "patch"} method - HTTP method
 * @param {string} url - URL to call
 * @param {object} [data] - Request body (post/patch only)
 * @param {object} [config] - Axios config overrides
 * @returns {Promise<object>} The axios response
 */
async function _apiRequest(adapter, method, url, data, config = {}) {
	if (adapter.unloaded) {
		return;
	}

	if (!adapter.apiClient) {
		throw new Error("API client not initialized");
	}
	if (!adapter.apiQueue) {
		throw new Error("API queue not initialized");
	}

	const client = adapter.apiClient;
	const label = method.toUpperCase();

	return adapter.apiQueue.add(async () => {
		// Proactive expiry check — refresh before the call to avoid edge cases
		if (adapter.tokenExpiresAt && Date.now() >= adapter.tokenExpiresAt - adapter.baseTime) {
			adapter.log.debug("🔐 Token close to expiry. Refreshing before request...");
			await apiRefreshToken(adapter);
		}

		if (!adapter.currentToken) {
			adapter.log.debug("🔐 No current token. Refreshing before request...");
			await apiRefreshToken(adapter);
		}

		const maxAttempts = 3;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				// Build headers: always include auth, add Content-Type per method
				const headers = {
					Authorization: `Bearer ${adapter.currentToken}`,
					...(config.headers || {}),
				};
				if (method === "post") {
					headers["Content-Type"] = "application/json";
				} else if (method === "patch" && data !== undefined && data !== null) {
					headers["Content-Type"] = "application/json";
				}

				const reqConfig = { ...config, headers };

				// GET has no data argument in axios
				if (method === "get") {
					return await client.get(url, reqConfig);
				}
				return await client[method](url, method === "patch" ? data || undefined : data, reqConfig);
			} catch (e) {
				const status = e.response?.status;

				const isTimeout =
					e.code === "ECONNABORTED" ||
					e.code === "ETIMEDOUT" ||
					e.name === "AbortError" ||
					e.name === "CanceledError" ||
					/timeout/i.test(e.message || "");

				if (status === 401 && attempt < maxAttempts - 1) {
					adapter.log.debug("🔐 401 received. Refreshing token...");
					await apiRefreshToken(adapter);
					continue;
				}

				if (status === 429) {
					adapter.log.warn("[API] 🚦 429 (rate limited). Backoff handled by AdaptiveRequestQueue.");
				}

				if (isTimeout) {
					adapter.log.warn("[API] ⏱ Request timed out — likely server overload or implicit rate limiting.");
				}

				adapter.log.debug(
					`API ${label} request failed (attempt ${attempt + 1}/${maxAttempts}) ` +
						`for ${url} - status=${status || "none"} - code=${e.code || "n/a"}`,
				);

				throw e;
			}
		}
	});
}

/**
 * API GET with token management and retry logic.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - URL to call
 * @param {object} [config] - Axios config overrides
 * @returns {Promise<object>} The axios response
 */
async function apiGet(adapter, url, config = {}) {
	return _apiRequest(adapter, "get", url, undefined, config);
}

/**
 * API POST with token management and retry logic.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - The URL to post to
 * @param {object} data - The JSON body to send
 * @param {object} [config] - Optional axios config overrides
 * @returns {Promise<object>} The axios response
 */
async function apiPost(adapter, url, data, config = {}) {
	return _apiRequest(adapter, "post", url, data, config);
}

/**
 * API PATCH with token management and retry logic.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - The URL to patch
 * @param {object} [data] - Optional JSON body to send
 * @param {object} [config] - Optional axios config overrides
 * @returns {Promise<object>} The axios response
 */
async function apiPatch(adapter, url, data, config = {}) {
	return _apiRequest(adapter, "patch", url, data, config);
}

/**
 * Update diagnostic states for AdaptiveRequestQueue.
 * This makes the currently observed / practical concurrency visible in ioBroker.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function apiUpdateQueueStats(adapter) {
	if (!adapter.apiQueue || typeof adapter.apiQueue.getStats !== "function") {
		return;
	}

	const stats = adapter.apiQueue.getStats();
	const pfx = `${API_PFX}diagnostics.queue.`;

	await adapter.doState(`${pfx}currentConcurrency`, stats.concurrency, "Current queue concurrency", "", false);
	await adapter.doState(
		`${pfx}recommendedConcurrency`,
		stats.recommendedConcurrency,
		"Recommended practical concurrency",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}lastStableConcurrency`,
		stats.lastStableConcurrency,
		"Last stable concurrency before backoff",
		"",
		false,
	);

	await adapter.doState(`${pfx}running`, stats.running, "Currently running requests", "", false);
	await adapter.doState(`${pfx}queued`, stats.queued, "Queued requests", "", false);
	await adapter.doState(`${pfx}successStreak`, stats.successStreak, "Current success streak", "", false);

	await adapter.doState(`${pfx}cooldownActive`, stats.cooldownActive, "Cooldown currently active", "", false);
	await adapter.doState(
		`${pfx}cooldownRemainingMs`,
		stats.cooldownRemainingMs,
		"Remaining cooldown in milliseconds",
		"ms",
		false,
	);

	await adapter.doState(`${pfx}started`, stats.started, "Started API requests", "", false);
	await adapter.doState(`${pfx}succeeded`, stats.succeeded, "Successful API requests", "", false);
	await adapter.doState(`${pfx}failed`, stats.failed, "Failed API requests", "", false);
	await adapter.doState(`${pfx}rateLimited`, stats.rateLimited, "HTTP 429 responses", "", false);
	await adapter.doState(`${pfx}timeouts`, stats.timeouts, "Timed out API requests", "", false);
	await adapter.doState(`${pfx}otherErrors`, stats.otherErrors, "Other API errors", "", false);

	await adapter.doState(
		`${pfx}avgDurationMs`,
		stats.avgDurationMs,
		"Average duration of successful API requests",
		"ms",
		false,
	);
	await adapter.doState(
		`${pfx}lastDurationMs`,
		stats.lastDurationMs,
		"Duration of the last successful API request",
		"ms",
		false,
	);

	await adapter.doState(`${pfx}errorRate`, stats.errorRate, "Overall API error rate", "", false);
	await adapter.doState(`${pfx}timeoutRate`, stats.timeoutRate, "Timeout rate", "", false);
	await adapter.doState(`${pfx}rateLimitRate`, stats.rateLimitRate, "HTTP 429 rate", "", false);

	await adapter.doState(`${pfx}cooldownCount`, stats.cooldownCount, "Number of cooldown activations", "", false);
	await adapter.doState(
		`${pfx}concurrencyReducedCount`,
		stats.concurrencyReducedCount,
		"Number of concurrency reductions",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}concurrencyIncreasedCount`,
		stats.concurrencyIncreasedCount,
		"Number of concurrency increases",
		"",
		false,
	);

	await adapter.doState(
		`${pfx}maxObservedQueueLength`,
		stats.maxObservedQueueLength,
		"Maximum observed queue length",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}maxObservedRunning`,
		stats.maxObservedRunning,
		"Maximum observed parallel running requests",
		"",
		false,
	);

	// timestamps as ISO strings for better readability in objects / history
	await adapter.doState(
		`${pfx}lastErrorAt`,
		stats.lastErrorAt ? new Date(stats.lastErrorAt).toISOString() : "",
		"Timestamp of last API error",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}lastSuccessAt`,
		stats.lastSuccessAt ? new Date(stats.lastSuccessAt).toISOString() : "",
		"Timestamp of last successful API request",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}last429At`,
		stats.last429At ? new Date(stats.last429At).toISOString() : "",
		"Timestamp of last HTTP 429 response",
		"",
		false,
	);
	await adapter.doState(
		`${pfx}lastTimeoutAt`,
		stats.lastTimeoutAt ? new Date(stats.lastTimeoutAt).toISOString() : "",
		"Timestamp of last timeout",
		"",
		false,
	);
}

/**
 * Log recommended concurrency only when it changes.
 * Info logging is only emitted when api_debug_log is enabled.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {void}
 */
function logApiQueueRecommendationIfChanged(adapter) {
	if (!adapter.apiQueue || typeof adapter.apiQueue.getStats !== "function") {
		return;
	}

	if (!adapter.config.api_debug_log) {
		return;
	}

	const stats = adapter.apiQueue.getStats();

	if (adapter.lastLoggedRecommendedConcurrency !== stats.recommendedConcurrency) {
		adapter.lastLoggedRecommendedConcurrency = stats.recommendedConcurrency;

		adapter.log.info(
			`[API] AdaptiveRequestQueue recommends concurrency=${stats.recommendedConcurrency} ` +
				`(current=${stats.concurrency}, stable=${stats.lastStableConcurrency}, ` +
				`timeouts=${stats.timeouts}, 429=${stats.rateLimited})`,
		);
	}
}

/**
 * Log current queue statistics only if key values changed since the last log.
 * Info logging is only emitted when api_debug_log is enabled.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {void}
 */
function logApiQueueStatsIfChanged(adapter) {
	if (!adapter.apiQueue || typeof adapter.apiQueue.getStats !== "function") {
		return;
	}

	if (!adapter.config.api_debug_log) {
		return;
	}

	const stats = adapter.apiQueue.getStats();

	const snapshot = JSON.stringify({
		concurrency: stats.concurrency,
		recommendedConcurrency: stats.recommendedConcurrency,
		lastStableConcurrency: stats.lastStableConcurrency,
		running: stats.running,
		queued: stats.queued,
		timeouts: stats.timeouts,
		rateLimited: stats.rateLimited,
		cooldownActive: stats.cooldownActive,
		cooldownRemainingMs: stats.cooldownRemainingMs,
		avgDurationMs: stats.avgDurationMs,
	});

	if (adapter.lastLoggedQueueSnapshot !== snapshot) {
		adapter.lastLoggedQueueSnapshot = snapshot;

		adapter.log.info(
			`[API] Queue stats: current=${stats.concurrency}, recommended=${stats.recommendedConcurrency}, ` +
				`stable=${stats.lastStableConcurrency}, running=${stats.running}, queued=${stats.queued}, ` +
				`success=${stats.succeeded}, failed=${stats.failed}, timeouts=${stats.timeouts}, 429=${stats.rateLimited}, ` +
				`avg=${stats.avgDurationMs}ms, cooldown=${
					stats.cooldownActive ? `${stats.cooldownRemainingMs}ms` : "off"
				}`,
		);
	}
}

/**
 * @param {number} lastRunTs timestamp of last run
 * @param {number} intervalMs interval in milliseconds
 * @returns {boolean} true if the interval has passed since lastRunTs, false otherwise
 */
function apiShouldRunInterval(lastRunTs, intervalMs) {
	if (!lastRunTs) {
		return true;
	}
	return Date.now() - lastRunTs >= intervalMs;
}

/**
 * Marks the current timestamp for the given poll type. This is used to track when the last successful poll of each type occurred, which can be helpful for debugging and ensuring that polling intervals are respected.
 * The type parameter indicates which poll type is being marked, allowing for separate tracking of dashboard, details, and heavy polls.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {"dashboard" | "details" | "heavy"} type - The type of poll to mark the timestamp for (e.g., "dashboard", "details", "heavy").
 * @returns {void}
 */
function apiMarkPollTimestamp(adapter, type) {
	const now = Date.now();

	switch (type) {
		case "dashboard":
			adapter.lastApiDashboardPoll = now;
			break;
		case "details":
			adapter.lastApiDetailsPoll = now;
			break;
		case "heavy":
			adapter.lastApiHeavyPoll = now;
			break;
	}
}

module.exports = {
	apiStartTokenManager,
	apiLogin,
	scheduleTokenRefresh,
	apiRefreshToken,
	apiPoll,
	apiScheduleNextPoll,
	apiBuildPollContext,
	apiEnsureSystemsLoaded,
	apiRunPollCycle,
	apiPollSingleSystem,
	apiPollDashboard,
	_apiPollEndpoint,
	apiPollOnlineState,
	apiPollSystemStatus,
	apiPollSystemDetails,
	apiPollAbilities,
	apiPollForecastChargingSettings,
	apiPollWallboxSearch,
	apiCreateWallboxControls,
	apiSyncWallboxControls,
	apiHandleWallboxControl,
	apiPollDataAvailability,
	_runMeasurementTasks,
	apiPollDetails,
	apiPollHeavy,
	apiMergeSystemPollResult,
	apiFinalizePollTimestamps,
	_apiRequest,
	apiGet,
	apiPost,
	apiPatch,
	apiUpdateQueueStats,
	logApiQueueRecommendationIfChanged,
	logApiQueueStatsIfChanged,
	apiShouldRunInterval,
	apiMarkPollTimestamp,
	// Auth helpers exported for use by webLogin delegate and unit tests
	extractFormAction,
	hasOtp,
	hasUsername,
	hasPassword,
	hasUsernameAndPassword,
	generateTOTP,
	computeBackoffDelay,
	generateCodeVerifier,
	generateCodeChallenge,
	base64UrlEncode,
};
