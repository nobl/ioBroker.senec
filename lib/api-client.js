"use strict";
// Delegate module — functions receive `this` via .call(adapter, ...)
/* eslint-disable jsdoc/check-tag-names, jsdoc/reject-any-type */

const crypto = require("node:crypto");
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

// --- Authentication helpers ---------------------------------------------------

/**
 * Generate a PKCE code verifier (random base64url string).
 *
 * @returns {string} code verifier
 */
function generateCodeVerifier() {
	return base64UrlEncode(
		globalThis.crypto?.getRandomValues
			? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
			: crypto.randomBytes(32),
	);
}

/**
 * Generate a PKCE code challenge from a verifier.
 *
 * @param {string} verifier - code verifier
 * @returns {string} code challenge
 */
function generateCodeChallenge(verifier) {
	return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

/**
 * Encode a buffer as base64url.
 *
 * @param {Buffer} buffer - input buffer
 * @returns {string} base64url string
 */
function base64UrlEncode(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Extract form action URL from HTML.
 *
 * @param {string} html - HTML content
 * @returns {string|null} action URL or null
 */
function extractFormAction(html) {
	const match = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
	return match && match[1] ? match[1].replace(/&amp;/g, "&") : null;
}

/**
 * Check if HTML contains a username input field.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasUsername(html) {
	return html.match(/<input\b(?![^>]*\bvalue\s*=)[^>]*\b(?:name|id)\s*=\s*["']?(?:username|user|email)["']?[^>]*>/i);
}

/**
 * Check if HTML contains a password input field.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasPassword(html) {
	return html.match(
		/<input\b(?=[^>]*\btype\s*=\s*["']?password["']?)(?=[^>]*\b(?:name|id)\s*=\s*["']?password["']?)[^>]*>/i,
	);
}

/**
 * Check if HTML contains both username and password fields.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasUsernameAndPassword(html) {
	return hasUsername(html) && hasPassword(html);
}

/**
 * Check if HTML contains an OTP input field.
 *
 * @param {string} html - HTML content
 * @returns {boolean} true if OTP field present
 */
function hasOtp(html) {
	return /<input\b[^>]*\b(?:name|id)\s*=\s*["']?otp["']?[^>]*>/i.test(html);
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * Uses Node built-in crypto — no external dependency needed.
 *
 * @param {string} base32Secret - The base32-encoded TOTP secret
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(base32Secret) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const clean = base32Secret.replace(/[\s=-]+/g, "").toUpperCase();

	// base32 decode
	let bits = "";
	for (const ch of clean) {
		const idx = alphabet.indexOf(ch);
		if (idx === -1) {
			throw new Error(`Invalid base32 character: ${ch}`);
		}
		bits += idx.toString(2).padStart(5, "0");
	}
	const bytes = bits.match(/.{8}/g);
	if (!bytes) {
		throw new Error("TOTP secret too short");
	}
	const key = Buffer.from(bytes.map((b) => parseInt(b, 2)));

	// TOTP counter (30-second window)
	const counter = Math.floor(Date.now() / 30000);
	const counterBuf = Buffer.alloc(8);
	counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
	counterBuf.writeUInt32BE(counter >>> 0, 4);

	// HMAC-SHA1
	const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();

	// Dynamic truncation
	const offset = hmac[hmac.length - 1] & 0x0f;
	const code =
		(((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) %
		1000000;

	return code.toString().padStart(6, "0");
}

/**
 * Compute a backoff delay with exponential backoff and full jitter.
 *
 * @param {number} baseInterval - Base interval in milliseconds.
 * @param {number} attempt - Attempt count (0-based).
 * @param {number} [maxMultiplier] - Maximum multiplier used to cap the exponent.
 */
function computeBackoffDelay(baseInterval, attempt, maxMultiplier = 8) {
	const cappedAttempt = Math.min(attempt, Math.log2(maxMultiplier));
	const expDelay = baseInterval * Math.pow(2, cappedAttempt);

	// Full jitter
	return Math.floor(Math.random() * expDelay);
}

// --- Exported API functions ---------------------------------------------------

/**
 * Starts the token manager for the SENEC App API.
 * The method first checks for an existing refresh token in the state. If a refresh token is found, it attempts to refresh the access token using that refresh token. If the refresh attempt fails (e.g., due to an invalid or expired refresh token), it falls back to performing a full login to obtain new tokens.
 *
 * The method ensures that the adapter can authenticate with the SENEC App API and is ready for subsequent API calls. It also handles the initial setup of the token management process, including scheduling future token refreshes.
 * Important: This method should be called during adapter startup to ensure that the adapter has a valid token before making any API calls. If this method returns false, it indicates that the adapter was unable to authenticate with the SENEC App API, and API polling should not be started.
 *
 * @returns {Promise<boolean>} A promise resolving to true if a valid token is obtained, false otherwise.
 * @this {any}
 */
async function apiStartTokenManager() {
	try {
		const tokenState = await this.getStateAsync(`${TOKEN_STATE}`);
		this.refreshToken = tokenState?.val ? this.decrypt(String(tokenState.val)) : null;
		// No refresh token at all → full login
		if (!this.refreshToken) {
			this.log.info("🔐 No refresh token present. Performing full login...");
			const token = await this.apiLogin();
			return !!token;
		}
		this.log.info("🔐 Using existing refresh token.");

		// We have a refresh token → try refresh
		this.log.info("🔐 Trying initial token refresh...");
		await this.apiRefreshToken();
		return !!this.currentToken;
	} catch (error) {
		this.log.warn(`⚠️ Initial refresh failed. Falling back to full login... ${error.message}`);
		const token = await this.apiLogin();
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
 * @returns {Promise<string|null>} The access token if login is successful, or null if login fails.
 * @this {any}
 */
async function apiLogin() {
	this.log.info("🔄 Start Senec API Login Flow...");

	if (!this.authClient) {
		throw new Error("Auth client not initialized");
	}

	this.jar = new CookieJar();

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
		const pageRes = await this.authClient.get(`${CONFIG.authUrl}?${authParams}`, { jar: this.jar });
		let actionUrl = extractFormAction(pageRes.data);
		if (!actionUrl) {
			throw new Error("Login-Form URL not found.");
		}

		const postForm = (url, data) =>
			this.authClient.post(url, data, {
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				maxRedirects: 0,
				validateStatus: (s) => s >= 200 && s < 400,
				jar: this.jar,
			});

		let loginRes;

		// Ensure username field exists
		if (!hasUsername(pageRes.data)) {
			throw new Error("Expected: Login-Form with username. Got something else.");
		}

		// Step 1 (username only or full form)
		let formData = new URLSearchParams({
			username: this.config.api_mail,
		});
		if (hasUsernameAndPassword(pageRes.data)) {
			formData.append("password", this.config.api_pwd);
		}
		loginRes = await postForm(actionUrl, formData);

		// Step 2 (password step if required)
		if (!hasUsernameAndPassword(pageRes.data)) {
			if (!hasPassword(loginRes.data)) {
				throw new Error("Expected: Login-Form with password. Got something else.");
			}

			actionUrl = extractFormAction(loginRes.data);
			formData = new URLSearchParams({
				username: this.config.api_mail,
				password: this.config.api_pwd,
			});
			loginRes = await postForm(actionUrl, formData);
		}

		// Step 3 (TOTP/2FA if required)
		if (!loginRes.headers.location && loginRes.status === 200 && loginRes.data && hasOtp(loginRes.data)) {
			if (!this.config.api_totp_secret) {
				throw new Error(
					"2FA/TOTP is required by your SENEC account but no TOTP secret is configured. " +
						"Please enter your TOTP secret in the adapter settings.",
				);
			}
			this.log.info("🔐 2FA/TOTP required. Submitting TOTP code...");
			const otpAction = extractFormAction(loginRes.data);
			if (!otpAction) {
				throw new Error("TOTP form found but could not extract form action URL.");
			}
			const otpCode = generateTOTP(this.config.api_totp_secret);
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

		const tokenRes = await this.authClient.post(
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

		this.currentToken = tokenRes.data.access_token;
		this.refreshToken = tokenRes.data.refresh_token;
		await this.doState(
			//`${this.namespace}${TOKEN_STATE}`,
			`${TOKEN_STATE}`,
			this.encrypt(this.refreshToken),
			"Encrypted Refresh Token (never log or expose!)",
			"",
			false,
			false,
		);
		this.authBlocked = false;
		this.tokenFailureCount = 0;
		const expiresIn = tokenRes.data.expires_in || 600; // fallback 10 min
		this.tokenExpiresAt = Date.now() + expiresIn * 1000;

		this.log.info("✅ API Login successful.");
		this.scheduleTokenRefresh();
		return this.currentToken;
	} catch (e) {
		this.logError(e, "❌ Login Error");
		return null;
	}
}

/**
 * Schedules the refresh of the API token based on its expiration time.
 * Includes a safety margin to refresh the token before it actually expires and implements an exponential backoff strategy in case of refresh failures to prevent excessive load on the SENEC / Keycloak servers.
 * Important: This method should be called after obtaining a new token (either via login or refresh) to ensure continuous authentication.
 *
 * @returns {void}
 * @this {any}
 */
function scheduleTokenRefresh() {
	if (!this.tokenExpiresAt || this.unloaded) {
		return;
	}

	const now = Date.now();
	let remaining = this.tokenExpiresAt - now;
	if (remaining <= 0) {
		// no negatives - if token already expired for some reason, schedule refresh in 10s
		remaining = 10000;
	}
	// security-delay: Refresh min. 90–150s before expiry to prevent edge cases of token expiry during API calls and to reduce load on senec / keycloak in case of time sync issues or longer response times of senec / keycloak
	const safetyMargin = Math.max(90000, remaining * 0.2); // 1.5 min oder 20%
	let delay = remaining - safetyMargin;

	if (this.tokenFailureCount > 0) {
		// if we had failures, we refresh more conservatively with a min. of 1 min to prevent excessive load on senec / keycloak in case of issues and to increase chances of successful refresh in case of temporary issues
		delay = Math.max(delay, 60000); // min. 1 min
	}
	delay = Math.max(delay, 10000); // never less than 10s - important to prevent too aggressive refreshes in case of clock sync issues or senec / keycloak response delays

	this.clearTimeout(this.timerTokenRefresh);

	if (!this.unloaded) {
		this.log.debug(
			`🔐 Next token refresh in ${(delay / 1000).toFixed(0)}s ` +
				`(remaining ${Math.round(remaining / 1000 / 60)} min, failures=${this.tokenFailureCount})`,
		);
		this.timerTokenRefresh = this.setTimeout(() => {
			this.apiRefreshToken().catch((err) => {
				this.log.debug(`⚠ Token refresh failed: ${err.message}`);
			});
		}, delay);
	}
}

/**
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiRefreshToken() {
	if (this.unloaded) {
		return;
	}

	if (!this.authClient) {
		throw new Error("Auth client not initialized");
	}

	if (this.refreshPromise) {
		this.log.debug("🔐 Refresh already in progress, waiting for it to complete...");
		return this.refreshPromise;
	}

	// cancel scheduled refresh while manual refresh runs
	this.clearTimeout(this.timerTokenRefresh);
	this.timerTokenRefresh = null;

	if (!this.refreshToken) {
		this.log.debug("🔐 No refresh token available — skipping refresh.");
		return this.apiLogin();
	}

	this.refreshPromise = (async () => {
		try {
			this.log.debug("🔐 Refreshing API token...");

			const response = await this.authClient.post(
				CONFIG.tokenUrl,
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: CONFIG.clientId,
					refresh_token: this.refreshToken,
				}),
				{ headers: { "Content-Type": "application/x-www-form-urlencoded" } },
			);

			const data = response.data;

			this.currentToken = data.access_token;
			this.refreshToken = data.refresh_token || this.refreshToken;

			await this.doState(
				`${TOKEN_STATE}`,
				this.encrypt(this.refreshToken),
				"Encrypted Refresh Token (never log or expose!)",
				"",
				false,
				false,
			);

			this.tokenFailureCount = 0;
			this.authBlocked = false;
			const expiresIn = data.expires_in || 600;
			this.tokenExpiresAt = Date.now() + expiresIn * 1000;

			if (this.config.api_showPolling) {
				this.log.info(`✅ Token refreshed. Expires in ${expiresIn}s`);
			} else {
				this.log.debug(`✅ Token refreshed. Expires in ${expiresIn}s`);
			}

			this.scheduleTokenRefresh();
		} catch (err) {
			this.authBlocked = true;
			const status = err.response?.status;
			const errorCode = err.response?.data?.error;

			this.log.warn(`⚠️ Token refresh failed: ${err.message} (HTTP ${status || "unknown"})`);

			if (errorCode === "invalid_grant" || status === 400) {
				this.log.warn("⚠️ Refresh token invalid → full login required.");
				await this.apiLogin();
				return;
			}

			this.tokenFailureCount++;
			const attempt = this.tokenFailureCount;
			let retryDelay = computeBackoffDelay(
				this.tokenBackoff.baseDelayMs,
				attempt - 1,
				this.tokenBackoff.maxMultiplier,
			);
			retryDelay = Math.max(retryDelay, 10000);
			retryDelay = Math.min(retryDelay, this.tokenBackoff.maxDelayMs);

			if (!this.unloaded) {
				this.log.warn(
					`🔁 Token refresh retry #${attempt} scheduled in ${(retryDelay / 1000).toFixed(0)}s ` +
						`(failures = ${this.tokenFailureCount})`,
				);
				this.timerTokenRefresh = this.setTimeout(() => {
					this.apiRefreshToken().catch(() => {});
				}, retryDelay);
			}

			throw err;
		} finally {
			this.refreshPromise = null;
		}
	})();

	return this.refreshPromise;
}

/**
 * Polls the SENEC API for updates.
 * Runs one API poll cycle, applies global error/backoff handling and schedules the next execution.
 *
 * @returns {Promise<void>}
 * @throws {Error} Will throw an error if the API call fails or if all scheduled tasks fail during the poll cycle.
 * @this {any}
 */
async function apiPoll() {
	if (this.unloaded) {
		return;
	}

	this.clearTimeout(this.timerAPI);
	this.timerAPI = null;

	if (!this.config.api_use || !this.apiConnected || this.unloaded) {
		this.log.info("Usage of SENEC App API not configured or not connected.");
		return;
	}

	if (this.apiPollRunning) {
		this.log.warn("API poll still running — skipping overlapping execution.");
		return;
	}

	this.apiPollRunning = true;

	const baseInterval = this.dashboardInterval;
	let nextDelay = baseInterval;

	try {
		if (this.authBlocked) {
			this.log.debug("⏸ Poll skipped - authentication currently recovering.");
			nextDelay = baseInterval;
			return;
		}

		const cycleResult = await this.apiRunPollCycle();

		if (cycleResult.totalFailure) {
			throw new Error(cycleResult.message || "All scheduled API tasks failed during polling.");
		}

		if (cycleResult.partialFailure) {
			this.log.warn(
				`⚠ Partial API failure: ${cycleResult.failedSystems} system(s) failed, ` +
					`at least one scheduled task succeeded.`,
			);
		}

		this.apiFailureCount = 0;
		await this.setState("info.connection", true, true);

		nextDelay = baseInterval;
	} catch (err) {
		this.apiFailureCount = (this.apiFailureCount || 0) + 1;
		this.logError(err, `🚨 API Poll failed - ⚠️ Failure count: ${this.apiFailureCount}`);
		await this.setState("info.connection", false, true);

		nextDelay = computeBackoffDelay(baseInterval, this.apiFailureCount);
		nextDelay = Math.min(nextDelay, baseInterval * 8);

		this.log.warn(`⏱ Backoff delay: Retry ${this.apiFailureCount} in ${(nextDelay / 1000).toFixed(0)}s`);
	} finally {
		this.apiPollRunning = false;

		if (this.config.api_debug_states) {
			try {
				await this.apiUpdateQueueStats();
			} catch (statsError) {
				this.log.debug(`Failed to update queue stats: ${statsError.message}`);
			}
		}

		if (this.config.api_debug_log) {
			try {
				this.logApiQueueRecommendationIfChanged();
				this.logApiQueueStatsIfChanged();
			} catch (logError) {
				this.log.debug(`Failed to log queue stats: ${logError.message}`);
			}
		}

		this.apiScheduleNextPoll(nextDelay);
	}
}

/**
 * Schedules the next API poll.
 * The method calculates the delay for the next poll based on the success or failure of the current poll cycle, implementing a backoff strategy in case of failures to prevent overwhelming the SENEC API. It also ensures that no new poll is scheduled if the adapter is unloaded, and it clears any existing timers to avoid overlapping polls. The method logs the scheduled time for the next poll for debugging purposes.
 *
 * @param {number} delay - The delay in milliseconds before the next poll.
 * @this {any}
 */
function apiScheduleNextPoll(delay) {
	if (this.unloaded) {
		return;
	}

	this.clearTimeout(this.timerAPI);
	this.timerAPI = null;

	this.timerAPI = this.setTimeout(() => {
		this.apiPoll().catch((e) => this.logError(e, "❌ Scheduled API poll failed"));
	}, delay);
	this.log.debug(`⏱ Next API poll scheduled in ${(delay / 1000).toFixed(0)}s`);
}

/**
 * Builds the context for an API poll cycle, determining which tasks should run based on the last poll timestamps and configured intervals.
 * The method calculates whether the dashboard, details, and heavy tasks should run by comparing the current time with the last poll timestamps for each task type and the respective configured intervals. It also prepares relevant date information (today, yesterday, current month, last month) in UTC to be used for API calls that require date parameters. The resulting context object contains flags indicating which tasks to run and the prepared date information for use in the API polling methods.
 * The method ensures that the API polling logic can make informed decisions about which data to fetch during each poll cycle, optimizing the polling process based on the configured intervals and the timing of previous polls.
 *
 * @returns {object} Context object containing flags for which tasks to run and relevant date information for the API calls.
 * @this {any}
 */
function apiBuildPollContext() {
	const shouldRunDashboard = this.apiShouldRunInterval(this.lastApiDashboardPoll, this.dashboardInterval);
	const shouldRunDetails = this.apiShouldRunInterval(this.lastApiDetailsPoll, this.detailsInterval);
	const shouldRunHeavy = this.apiShouldRunInterval(this.lastApiHeavyPoll, this.heavyInterval);

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
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiEnsureSystemsLoaded() {
	if (this.apiKnownSystems.size > 0) {
		return;
	}

	this.log.debug("🔄 Reading available systems from API ...");
	// Old: /v1/systems → New: /systems/api/v1 (API_HOST_SYSTEMS already includes /systems/api)
	const sysRes = await this.apiGet(`${API_HOST_SYSTEMS}/v1`);

	if (!sysRes?.data?.length) {
		throw new Error("No systems returned from API.");
	}

	for (const sys of sysRes.data) {
		this.log.debug(`System found: ${JSON.stringify(sys)}`);
		this.apiKnownSystems.add(sys.id);
		await this.evalPoll(sys, `${API_PFX}Anlagen.${sys.id}.`);
		await this.apiPollAbilities(sys.id);
		await this.apiPollWallboxSearch(sys.id);
		await this.apiCreateWallboxControls();
	}
}

/**
 * Executes one full API cycle across all known systems.
 * Handles dashboard/details/heavy polling and optionally one rebuild batch.
 *
 * @returns {Promise<{totalFailure: boolean, partialFailure: boolean, failedSystems: number, message: string}>} Result of the poll cycle, including failure status and messages.
 * @throws {Error} Will throw an error if all scheduled tasks fail during the poll cycle.
 * @this {any}
 */
async function apiRunPollCycle() {
	let rebuildExecuted = false;
	if (this.config.api_showPolling) {
		this.log.info("🔄 Polling SENEC App API...");
	} else {
		this.log.debug("🔄 Polling SENEC App API...");
	}

	if (!this.currentToken) {
		await this.apiRefreshToken();
	}

	await this.apiEnsureSystemsLoaded();

	const ctx = this.apiBuildPollContext();

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

	for (const anlagenId of this.apiKnownSystems) {
		const systemResult = await this.apiPollSingleSystem(anlagenId, ctx, rebuildExecuted);
		this.apiMergeSystemPollResult(result, systemResult);

		if (systemResult.rebuildExecuted) {
			rebuildExecuted = true;
		}
	}

	this.apiFinalizePollTimestamps(result);

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
 * @param {string} anlagenId - The ID of the system to poll.
 * @param {object} ctx - The context object containing flags for which tasks to run and relevant date information for the API calls.
 * @param {boolean} rebuildAlreadyExecuted - was rebuild already executed
 * @returns {Promise<{failed: boolean;dashboardScheduled: boolean;detailsScheduled: boolean;heavyScheduled: boolean;dashboardSucceeded: boolean;detailsSucceeded: boolean;heavySucceeded: boolean;rebuildExecuted: boolean;}>} Result of the API poll for the system, including success and failure status for each task type.
 * @this {any}
 */
async function apiPollSingleSystem(anlagenId, ctx, rebuildAlreadyExecuted) {
	const logType = this.config.api_showPolling ? "info" : "debug";
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

	this.log.debug(`🔄 Polling system ${anlagenId}...`);

	if (ctx.shouldRunDashboard) {
		this.log[logType](`🔄 Polling system ${anlagenId} - Dashboard`);
		result.dashboardScheduled = true;
		const dashboardPolls = [
			this.apiPollDashboard(anlagenId),
			this.apiPollSystemStatus(anlagenId),
			// apiPollOnlineState disabled — endpoint returns 404, not yet active on SENEC side
		];
		if (this.apiWallboxCount > 0) {
			dashboardPolls.push(this.apiPollWallboxSearch(anlagenId));
		}
		const results = await Promise.allSettled(dashboardPolls);
		result.dashboardSucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (ctx.shouldRunDetails) {
		this.log[logType](`🔄 Polling system ${anlagenId} - Details (day values)`);
		result.detailsScheduled = true;
		const detailsPolls = [this.apiPollDetails(anlagenId, ctx), this.apiPollSystemDetails(anlagenId)];
		const results = await Promise.allSettled(detailsPolls);
		result.detailsSucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (ctx.shouldRunHeavy) {
		this.log[logType](`🔄 Polling system ${anlagenId} - Heavy (month / year values)`);
		result.heavyScheduled = true;
		const results = await Promise.allSettled([
			this.apiPollHeavy(anlagenId, ctx),
			this.apiPollDataAvailability(anlagenId),
			// apiPollForecastChargingSettings disabled — endpoint returns 400, not yet active on SENEC side
		]);
		result.heavySucceeded = results.every((r) => r.status === "fulfilled");
	}

	if (this.isRebuildEnabled() && !this.rebuildRunning && !rebuildAlreadyExecuted) {
		try {
			await this.doRebuild(anlagenId);
			result.rebuildExecuted = true;
		} catch (rebuildError) {
			this.logError(rebuildError, `❌ Rebuild for system ${anlagenId} failed.`);
		}
	}

	return result;
}

/**
 * Polls the API for the dashboard data of a single system.
 * The method makes an API call to retrieve the dashboard data for the specified system ID, logs the keys of the returned data for debugging purposes, and then evaluates the poll to update the relevant states based on the retrieved data. The method includes error handling to catch any exceptions that occur during the API call, ensuring that a failure in retrieving the dashboard data does not prevent the execution of other tasks for the same system. By providing detailed logging of the retrieved data, this method allows for better monitoring and debugging of the interactions with the SENEC App API for the dashboard data.
 * The method assumes that the necessary authentication token is available and that the API systems are loaded before it is called, as it relies on this information to perform the API call effectively. It also updates the poll timestamps for the dashboard task based on the success of the API call, which is essential for the scheduling logic of subsequent poll cycles.
 *
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollDashboard(anlagenId) {
	try {
		const dashRes = await this.apiGet(`${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/dashboard`);
		this.log.silly(`DashRes keys: ${Object.keys(dashRes.data).join(", ")}`);
		await this.evalPoll(dashRes.data, `${API_PFX}Anlagen.${anlagenId}.Dashboard.`);
		await this.updateLastPoll(`${API_PFX}info.lastPoll.Dashboard`, "Last successful Dashboard poll");
	} catch (error) {
		this.logError(error, `❌ Dashboard poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Generic API poll: GET → evalPoll → update lastPoll → log.
 * For simple endpoints that follow the standard pattern.
 *
 * @param {string} anlagenId - System ID
 * @param {string} url - Full API URL
 * @param {string} evalPrefix - Prefix for evalPoll (e.g. "_api.Anlagen.{id}.OnlineState.")
 * @param {string} pollName - Name for lastPoll state and log messages
 * @returns {Promise<void>}
 * @this {any}
 */
async function _apiPollEndpoint(anlagenId, url, evalPrefix, pollName) {
	try {
		const res = await this.apiGet(url);
		if (!res?.data) {
			return;
		}
		await this.evalPoll(res.data, evalPrefix);
		await this.updateLastPoll(`${API_PFX}info.lastPoll.${pollName}`, `Last successful ${pollName} poll`);
		this.log.debug(`${pollName} polled for ${anlagenId}`);
	} catch (error) {
		this.logError(error, `❌ ${pollName} poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Polls the API for online state (online/offline, since when).
 * Called on the dashboard tier.
 *
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollOnlineState(anlagenId) {
	await this._apiPollEndpoint(
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
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollSystemStatus(anlagenId) {
	await this._apiPollEndpoint(
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
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollSystemDetails(anlagenId) {
	await this._apiPollEndpoint(
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
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollAbilities(anlagenId) {
	try {
		const res = await this.apiGet(`${API_HOST_ABILITIES}/v1/packages/${anlagenId}`);
		if (!res?.data) {
			return;
		}
		const pfx = `${API_PFX}Anlagen.${anlagenId}.Abilities.`;

		if (Array.isArray(res.data.packageTypes)) {
			await this.doState(
				`${pfx}packageTypes`,
				JSON.stringify(res.data.packageTypes),
				"Installed feature packages",
				"",
				false,
			);

			// Also create individual boolean states for each known package type
			const knownTypes = ["MOBILITY", "PEAK_SHAVING", "SG_READY", "HEATING_ROD", "SOCKETS"];
			for (const pkg of knownTypes) {
				await this.doState(`${pfx}${pkg}`, res.data.packageTypes.includes(pkg), `Feature: ${pkg}`, "", false);
			}
		}

		if (res.data.warrantyPackage != null) {
			await this.doState(`${pfx}warrantyPackage`, res.data.warrantyPackage, "Warranty package", "", false);
		}

		this.log.debug(`Abilities polled for ${anlagenId}`);
	} catch (error) {
		this.logError(error, `❌ Abilities poll failed for ${anlagenId}`);
	}
}

/**
 * Polls the API for forecast charging settings.
 * Called on the heavy tier (daily).
 *
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollForecastChargingSettings(anlagenId) {
	await this._apiPollEndpoint(
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
 * @param {string} anlagenId - The ID of the system to search wallboxes for.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollWallboxSearch(anlagenId) {
	try {
		const res = await this.apiPost(`${API_HOST_WALLBOX}/v1/systems/wallboxes/search`, {
			systemIds: [anlagenId],
		});
		if (!res?.data) {
			return;
		}
		if (!Array.isArray(res.data)) {
			this.log.debug(`Wallbox search returned non-array response for ${anlagenId}`);
			return;
		}
		if (res.data.length === 0) {
			this.log.debug(`No wallboxes found for ${anlagenId}`);
			return;
		}
		this.apiWallboxCount = res.data.length;
		this.apiWallboxUuids = res.data.map((wb) => wb.id).filter(Boolean);
		this.apiWallboxObjects = res.data;
		this.apiWallboxSystemId = anlagenId;
		this.log.info(`Found ${this.apiWallboxCount} wallbox(es) via API for ${anlagenId}`);
		for (let i = 0; i < res.data.length; i++) {
			await this.evalPoll(res.data[i], `${API_PFX}Anlagen.${anlagenId}.Wallboxes.${i}.`);
		}
		await this.updateLastPoll(`${API_PFX}info.lastPoll.WallboxSearch`, "Last successful WallboxSearch poll");
		await this.apiSyncWallboxControls();
	} catch (error) {
		this.logError(error, `❌ Wallbox search failed for ${anlagenId}`);
		// Don't re-throw — wallbox search failure at startup shouldn't block anything
	}
}

/**
 * Create control datapoints for API wallbox control.
 * Called once after wallbox search discovers wallboxes.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiCreateWallboxControls() {
	if (!this.config.control_api_active || this.config.control_wallbox_connector !== "api") {
		return;
	}
	if (this.apiWallboxCount === 0) {
		return;
	}

	for (let i = 0; i < this.apiWallboxCount; i++) {
		const pfx = `control.Wallbox.${i}`;
		await this.setObjectNotExistsAsync(pfx, {
			type: "channel",
			common: { name: `API Wallbox ${i} Control` },
			native: {},
		});

		// Combined mode: LOCKED / FAST / SOLAR / COMFORT
		await this.setObjectNotExistsAsync(`${pfx}.Mode`, {
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
		await this.setObjectNotExistsAsync(`${pfx}.MinChargingCurrentInA`, {
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
		await this.setObjectNotExistsAsync(`${pfx}.AllowIntercharge`, {
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
		await this.setObjectNotExistsAsync(`${pfx}.PreventInterruptions`, {
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
	for (let i = 0; i < this.apiWallboxCount; i++) {
		await this.setObjectNotExistsAsync(`control.Wallbox.${i}.Apply`, {
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

	await this.subscribeStatesAsync("control.Wallbox.*");
	this.log.info(`Created API wallbox control datapoints for ${this.apiWallboxCount} wallbox(es)`);
}

/**
 * Sync API wallbox control datapoints with values from the cached wallbox objects.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiSyncWallboxControls() {
	if (!this.config.control_api_active || this.config.control_wallbox_connector !== "api") {
		return;
	}

	for (let i = 0; i < this.apiWallboxObjects.length; i++) {
		const wb = this.apiWallboxObjects[i];
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
		await this.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });

		// Sync settings based on current mode
		const solarSettings = wb.chargingMode?.solarOptimizeSettings;
		const fastSettings = wb.chargingMode?.fastChargingSettings;
		const comfortSettings = wb.chargingMode?.comfortChargeSettings;

		// MinChargingCurrentInA — from solar or comfort settings
		if (solarSettings?.minChargingCurrentInA !== undefined) {
			await this.setStateChangedAsync(`${pfx}.MinChargingCurrentInA`, {
				val: solarSettings.minChargingCurrentInA,
				ack: true,
			});
		} else if (comfortSettings?.configuredChargingCurrent !== undefined) {
			await this.setStateChangedAsync(`${pfx}.MinChargingCurrentInA`, {
				val: comfortSettings.configuredChargingCurrent,
				ack: true,
			});
		}

		// AllowIntercharge — from fast or comfort settings
		if (fastSettings?.allowIntercharge !== undefined) {
			await this.setStateChangedAsync(`${pfx}.AllowIntercharge`, {
				val: !!fastSettings.allowIntercharge,
				ack: true,
			});
		} else if (comfortSettings?.allowIntercharge !== undefined) {
			await this.setStateChangedAsync(`${pfx}.AllowIntercharge`, {
				val: !!comfortSettings.allowIntercharge,
				ack: true,
			});
		}

		// PreventInterruptions — from solar or comfort settings
		if (solarSettings?.preventInterruptions !== undefined) {
			await this.setStateChangedAsync(`${pfx}.PreventInterruptions`, {
				val: !!solarSettings.preventInterruptions,
				ack: true,
			});
		} else if (comfortSettings?.preventInterruptions !== undefined) {
			await this.setStateChangedAsync(`${pfx}.PreventInterruptions`, {
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
 * @param {number} wbIdx - Wallbox index (0-based)
 * @param {string} field - The control field name
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiHandleWallboxControl(wbIdx, field, value) {
	if (wbIdx >= this.apiWallboxCount || !this.apiWallboxSystemId) {
		this.log.warn(`API Wallbox ${wbIdx} does not exist`);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		this.log.debug(`API Wallbox ${wbIdx}: pending ${field} = ${value}`);
		return;
	}

	// Apply: read all pending values and send to API
	if (!value) {
		return; // Only act on true
	}

	const uuid = this.apiWallboxUuids[wbIdx];
	if (!uuid) {
		this.log.warn(`No UUID for API wallbox ${wbIdx}`);
		return;
	}

	const pfx = `control.Wallbox.${wbIdx}`;
	const systemId = this.apiWallboxSystemId;
	const baseUrl = `${API_HOST_WALLBOX}/v1/systems/${systemId}/wallboxes/${encodeURIComponent(uuid)}`;

	try {
		// Read pending values from states
		const pendingMode = (await this.getStateAsync(`${pfx}.Mode`))?.val;
		const pendingMinCurrent = (await this.getStateAsync(`${pfx}.MinChargingCurrentInA`))?.val;
		const pendingAllowIntercharge = (await this.getStateAsync(`${pfx}.AllowIntercharge`))?.val;
		const pendingPreventInterruptions = (await this.getStateAsync(`${pfx}.PreventInterruptions`))?.val;

		const wb = this.apiWallboxObjects[wbIdx];
		const targetMode = pendingMode ? String(pendingMode).toUpperCase() : null;

		// 1. Handle mode/lock change
		if (targetMode) {
			const currentlyLocked = !!wb?.prohibitUsage;
			const currentMode = wb?.chargingMode?.type?.toUpperCase();

			if (targetMode === "LOCKED" && !currentlyLocked) {
				this.log.info(`Locking API wallbox ${wbIdx}...`);
				const res = await this.apiPatch(`${baseUrl}/locked/true`);
				if (res?.data) {
					this.apiWallboxObjects[wbIdx] = res.data;
				}
			} else if (targetMode !== "LOCKED") {
				if (currentlyLocked) {
					this.log.info(`Unlocking API wallbox ${wbIdx} before mode change...`);
					const unlockRes = await this.apiPatch(`${baseUrl}/locked/false`);
					if (!unlockRes?.data) {
						this.log.warn(`Unlock failed for API wallbox ${wbIdx}`);
						await this.setState(`${pfx}.Apply`, { val: false, ack: true });
						return;
					}
					this.apiWallboxObjects[wbIdx] = unlockRes.data;
				}
				if (targetMode !== currentMode) {
					this.log.info(`Setting API wallbox ${wbIdx} mode to ${targetMode}...`);
					const res = await this.apiPatch(`${baseUrl}/charging-mode/${targetMode}`);
					if (res?.data) {
						this.apiWallboxObjects[wbIdx] = res.data;
					}
				}
			}
		}

		// 2. Handle settings for the active mode (use latest wb object after mode change)
		const activeWb = this.apiWallboxObjects[wbIdx];
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
			this.log.info(`Applying API wallbox ${wbIdx} solar settings...`);
			const res = await this.apiPatch(`${baseUrl}/settings/solar-charge`, postData);
			if (res?.data) {
				this.apiWallboxObjects[wbIdx] = res.data;
			}
		} else if (activeMode === "FAST") {
			if (pendingAllowIntercharge != null) {
				this.log.info(`Applying API wallbox ${wbIdx} fast settings...`);
				const res = await this.apiPatch(`${baseUrl}/settings/fast-charge`, {
					allowIntercharge: !!pendingAllowIntercharge,
				});
				if (res?.data) {
					this.apiWallboxObjects[wbIdx] = res.data;
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
			this.log.info(`Applying API wallbox ${wbIdx} comfort settings...`);
			const res = await this.apiPatch(`${baseUrl}/comfort-charge-expert-settings`, postData);
			if (res?.data) {
				this.apiWallboxObjects[wbIdx] = res.data;
			}
		}

		// Sync control states with actual device values and reset Apply
		await this.apiSyncWallboxControls();
		await this.setState(`${pfx}.Apply`, { val: false, ack: true });
		this.log.info(`API wallbox ${wbIdx} changes applied successfully`);
	} catch (error) {
		this.logError(error, `Failed to apply API wallbox ${wbIdx} changes`);
		await this.setState(`${pfx}.Apply`, { val: false, ack: true });
	}
}

/**
 * Polls the API for data availability timespan.
 * Called once after systems are loaded. Returns the date range for which
 * measurement data is available — useful for history rebuild.
 *
 * @param {string} anlagenId - The ID of the system to poll.
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollDataAvailability(anlagenId) {
	try {
		const res = await this.apiGet(
			`${API_HOST_MEASUREMENTS}/v1/systems/${anlagenId}/data-availability/timespan?timezone=UTC`,
		);
		if (!res?.data) {
			return;
		}
		await this.evalPoll(res.data, `${API_PFX}Anlagen.${anlagenId}.DataAvailability.`);
		// Add human-readable date companions for ms timestamp fields
		const pfx = `${API_PFX}Anlagen.${anlagenId}.DataAvailability.`;
		if (res.data.periodStartDateInMilliseconds != null) {
			await this.doState(
				`${pfx}periodStartDate`,
				new Date(res.data.periodStartDateInMilliseconds).toISOString(),
				"Data available from",
				"",
				false,
			);
		}
		if (res.data.periodEndDateInMilliseconds != null) {
			await this.doState(
				`${pfx}periodEndDate`,
				new Date(res.data.periodEndDateInMilliseconds).toISOString(),
				"Data available until",
				"",
				false,
			);
		}
		await this.updateLastPoll(`${API_PFX}info.lastPoll.DataAvailability`, "Last successful DataAvailability poll");
		this.log.debug(`Data availability polled for ${anlagenId}`);
	} catch (error) {
		this.logError(error, `❌ Data availability poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Run an array of measurement tasks, summarize results, and update lastPoll.
 *
 * @param {string} anlagenId - System ID
 * @param {Array<{fn: () => Promise<{status: string}>, label: string}>} tasks - Measurement tasks
 * @param {string} pollName - Name for log messages and lastPoll state
 * @param {(() => Promise<void>)} [beforeLastPoll] - Optional async work to run after tasks but before lastPoll
 * @returns {Promise<void>}
 * @this {any}
 */
async function _runMeasurementTasks(anlagenId, tasks, pollName, beforeLastPoll) {
	try {
		const results = await Promise.all(
			tasks.map(async (task) => {
				const res = await task.fn();
				return { label: task.label, ...res };
			}),
		);

		if (this.config.api_debug_log) {
			for (const r of results) {
				this.log.debug(`${pollName} ${anlagenId} / ${r.label}: ${r.status}`);
			}
		}

		const summary = this.summarizeMeasurementResults(results);
		const classification = this.classifyMeasurementSummary(summary);

		this.log.debug(
			`${pollName} summary ${anlagenId}: ${this.formatMeasurementSummary(summary)} | ${this.formatMeasurementClassification(classification)}`,
		);

		if (beforeLastPoll) {
			await beforeLastPoll();
		}
		await this.updateLastPoll(`${API_PFX}info.lastPoll.${pollName}`, `Last successful ${pollName} poll`);
	} catch (error) {
		this.logError(error, `❌ ${pollName} poll failed for ${anlagenId}`);
		throw error;
	}
}

/**
 * Polls the API for the details data of a single system.
 *
 * @param {string} anlagenId anlagen id
 * @param {object} ctx context
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollDetails(anlagenId, ctx) {
	const tasks = [
		{ fn: () => this.doMeasurementsDay(anlagenId, ctx.today, "today"), label: "today" },
		{ fn: () => this.doMeasurementsDay(anlagenId, ctx.today, "today.hourly"), label: "today.hourly" },
		{ fn: () => this.doMeasurementsDay(anlagenId, ctx.yesterday, "yesterday"), label: "yesterday" },
		{
			fn: () => this.doMeasurementsDay(anlagenId, ctx.yesterday, "yesterday.hourly"),
			label: "yesterday.hourly",
		},
	];

	// Add wallbox measurement tasks
	for (let i = 0; i < this.apiWallboxUuids.length; i++) {
		const wb = { uuid: this.apiWallboxUuids[i], index: i };
		tasks.push({
			fn: () => this.doMeasurementsDay(anlagenId, ctx.today, "today", wb),
			label: `wb${i}.today`,
		});
		tasks.push({
			fn: () => this.doMeasurementsDay(anlagenId, ctx.today, "today.hourly", wb),
			label: `wb${i}.today.hourly`,
		});
		tasks.push({
			fn: () => this.doMeasurementsDay(anlagenId, ctx.yesterday, "yesterday", wb),
			label: `wb${i}.yesterday`,
		});
		tasks.push({
			fn: () => this.doMeasurementsDay(anlagenId, ctx.yesterday, "yesterday.hourly", wb),
			label: `wb${i}.yesterday.hourly`,
		});
	}

	await this._runMeasurementTasks(anlagenId, tasks, "Details");
}

/**
 * Polls the API for the heavy data of a single system.
 *
 * @param {string} anlagenId Anlagen id to poll
 * @param {object} ctx context
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiPollHeavy(anlagenId, ctx) {
	const tasks = [
		{
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.currentMonth, "current_month"),
			label: "current_month",
		},
		{
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.currentMonth, "current_month.daily"),
			label: "current_month.daily",
		},
		{
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.lastMonth, "previous_month"),
			label: "previous_month",
		},
		{
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.lastMonth, "previous_month.daily"),
			label: "previous_month.daily",
		},

		{ fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear, false), label: "year" },
		{ fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear, true), label: "year.monthly" },
		{ fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear - 1, false), label: "prev_year" },
		{ fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear - 1, true), label: "prev_year.monthly" },
	];

	// Add wallbox measurement tasks
	for (let i = 0; i < this.apiWallboxUuids.length; i++) {
		const wb = { uuid: this.apiWallboxUuids[i], index: i };
		tasks.push({
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.currentMonth, "current_month", wb),
			label: `wb${i}.current_month`,
		});
		tasks.push({
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.currentMonth, "current_month.daily", wb),
			label: `wb${i}.current_month.daily`,
		});
		tasks.push({
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.lastMonth, "previous_month", wb),
			label: `wb${i}.previous_month`,
		});
		tasks.push({
			fn: () => this.doMeasurementsMonth(anlagenId, ctx.lastMonth, "previous_month.daily", wb),
			label: `wb${i}.previous_month.daily`,
		});
		tasks.push({
			fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear, false, wb),
			label: `wb${i}.year`,
		});
		tasks.push({
			fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear, true, wb),
			label: `wb${i}.year.monthly`,
		});
		tasks.push({
			fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear - 1, false, wb),
			label: `wb${i}.prev_year`,
		});
		tasks.push({
			fn: () => this.doMeasurementsYear(anlagenId, ctx.utcYear - 1, true, wb),
			label: `wb${i}.prev_year.monthly`,
		});
	}

	await this._runMeasurementTasks(anlagenId, tasks, "Heavy", () => this.updateAllTimeHistory(anlagenId));
}

/**
 * Merges the results of a system poll into the overall poll result.
 * The method takes the results of a single system poll and updates the overall poll result object by incrementing the counts for scheduled and succeeded tasks, as well as the count of failed systems. It checks the flags for each task type (dashboard, details, heavy) in the single system result and updates the corresponding fields in the total result accordingly. This method is essential for aggregating the results of individual system polls into a comprehensive summary of the entire poll cycle, allowing for better monitoring and analysis of the polling process across all systems.
 * The method assumes that the total result object is initialized with the necessary fields to track the counts of scheduled and succeeded tasks, as well as the count of failed systems. By systematically merging the results of each system poll, the method ensures that the overall poll result accurately reflects the performance and outcomes of the API polling process for all systems.
 *
 * @param {object} total - The overall poll result object that aggregates the results of all system polls.
 * @param {object} single - The result object for a single system poll, containing flags for scheduled and succeeded tasks, as well as a failure flag.
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
 * @param {object} result - The result object of the poll cycle, containing counts of scheduled and succeeded tasks for each task type, as well as the total number of known systems.
 * @returns {void}
 * @this {any}
 */
function apiFinalizePollTimestamps(result) {
	const systemsCount = this.apiKnownSystems.size;

	if (result.dashboardScheduled && result.dashboardSucceeded === systemsCount) {
		this.apiMarkPollTimestamp("dashboard");
	}

	if (result.detailsScheduled && result.detailsSucceeded === systemsCount) {
		this.apiMarkPollTimestamp("details");
	}

	if (result.heavyScheduled && result.heavySucceeded === systemsCount) {
		this.apiMarkPollTimestamp("heavy");
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
 * @param {"get" | "post" | "patch"} method - HTTP method
 * @param {string} url - URL to call
 * @param {object} [data] - Request body (post/patch only)
 * @param {object} [config] - Axios config overrides
 * @returns {Promise<object>} The axios response
 * @this {any}
 */
async function _apiRequest(method, url, data, config = {}) {
	if (this.unloaded) {
		return;
	}

	if (!this.apiClient) {
		throw new Error("API client not initialized");
	}
	if (!this.apiQueue) {
		throw new Error("API queue not initialized");
	}

	const client = this.apiClient;
	const label = method.toUpperCase();

	return this.apiQueue.add(async () => {
		// Proactive expiry check — refresh before the call to avoid edge cases
		if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt - this.baseTime) {
			this.log.debug("🔐 Token close to expiry. Refreshing before request...");
			await this.apiRefreshToken();
		}

		if (!this.currentToken) {
			this.log.debug("🔐 No current token. Refreshing before request...");
			await this.apiRefreshToken();
		}

		const maxAttempts = 3;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				// Build headers: always include auth, add Content-Type per method
				const headers = {
					Authorization: `Bearer ${this.currentToken}`,
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
					this.log.debug("🔐 401 received. Refreshing token...");
					await this.apiRefreshToken();
					continue;
				}

				if (status === 429) {
					this.log.warn("🚦 API returned 429 (rate limited). Backoff handled by AdaptiveRequestQueue.");
				}

				if (isTimeout) {
					this.log.warn("⏱ API request timed out - likely server overload or implicit rate limiting.");
				}

				this.log.debug(
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
 * @param {string} url - URL to call
 * @param {object} [config] - Axios config overrides
 * @returns {Promise<object>} The axios response
 * @this {any}
 */
async function apiGet(url, config = {}) {
	return this._apiRequest("get", url, undefined, config);
}

/**
 * API POST with token management and retry logic.
 *
 * @param {string} url - The URL to post to
 * @param {object} data - The JSON body to send
 * @param {object} [config] - Optional axios config overrides
 * @returns {Promise<object>} The axios response
 * @this {any}
 */
async function apiPost(url, data, config = {}) {
	return this._apiRequest("post", url, data, config);
}

/**
 * API PATCH with token management and retry logic.
 *
 * @param {string} url - The URL to patch
 * @param {object} [data] - Optional JSON body to send
 * @param {object} [config] - Optional axios config overrides
 * @returns {Promise<object>} The axios response
 * @this {any}
 */
async function apiPatch(url, data, config = {}) {
	return this._apiRequest("patch", url, data, config);
}

/**
 * Update diagnostic states for AdaptiveRequestQueue.
 * This makes the currently observed / practical concurrency visible in ioBroker.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function apiUpdateQueueStats() {
	if (!this.apiQueue || typeof this.apiQueue.getStats !== "function") {
		return;
	}

	const stats = this.apiQueue.getStats();
	const pfx = `${API_PFX}diagnostics.queue.`;

	await this.doState(`${pfx}currentConcurrency`, stats.concurrency, "Current queue concurrency", "", false);
	await this.doState(
		`${pfx}recommendedConcurrency`,
		stats.recommendedConcurrency,
		"Recommended practical concurrency",
		"",
		false,
	);
	await this.doState(
		`${pfx}lastStableConcurrency`,
		stats.lastStableConcurrency,
		"Last stable concurrency before backoff",
		"",
		false,
	);

	await this.doState(`${pfx}running`, stats.running, "Currently running requests", "", false);
	await this.doState(`${pfx}queued`, stats.queued, "Queued requests", "", false);
	await this.doState(`${pfx}successStreak`, stats.successStreak, "Current success streak", "", false);

	await this.doState(`${pfx}cooldownActive`, stats.cooldownActive, "Cooldown currently active", "", false);
	await this.doState(
		`${pfx}cooldownRemainingMs`,
		stats.cooldownRemainingMs,
		"Remaining cooldown in milliseconds",
		"ms",
		false,
	);

	await this.doState(`${pfx}started`, stats.started, "Started API requests", "", false);
	await this.doState(`${pfx}succeeded`, stats.succeeded, "Successful API requests", "", false);
	await this.doState(`${pfx}failed`, stats.failed, "Failed API requests", "", false);
	await this.doState(`${pfx}rateLimited`, stats.rateLimited, "HTTP 429 responses", "", false);
	await this.doState(`${pfx}timeouts`, stats.timeouts, "Timed out API requests", "", false);
	await this.doState(`${pfx}otherErrors`, stats.otherErrors, "Other API errors", "", false);

	await this.doState(
		`${pfx}avgDurationMs`,
		stats.avgDurationMs,
		"Average duration of successful API requests",
		"ms",
		false,
	);
	await this.doState(
		`${pfx}lastDurationMs`,
		stats.lastDurationMs,
		"Duration of the last successful API request",
		"ms",
		false,
	);

	await this.doState(`${pfx}errorRate`, stats.errorRate, "Overall API error rate", "", false);
	await this.doState(`${pfx}timeoutRate`, stats.timeoutRate, "Timeout rate", "", false);
	await this.doState(`${pfx}rateLimitRate`, stats.rateLimitRate, "HTTP 429 rate", "", false);

	await this.doState(`${pfx}cooldownCount`, stats.cooldownCount, "Number of cooldown activations", "", false);
	await this.doState(
		`${pfx}concurrencyReducedCount`,
		stats.concurrencyReducedCount,
		"Number of concurrency reductions",
		"",
		false,
	);
	await this.doState(
		`${pfx}concurrencyIncreasedCount`,
		stats.concurrencyIncreasedCount,
		"Number of concurrency increases",
		"",
		false,
	);

	await this.doState(
		`${pfx}maxObservedQueueLength`,
		stats.maxObservedQueueLength,
		"Maximum observed queue length",
		"",
		false,
	);
	await this.doState(
		`${pfx}maxObservedRunning`,
		stats.maxObservedRunning,
		"Maximum observed parallel running requests",
		"",
		false,
	);

	// timestamps as ISO strings for better readability in objects / history
	await this.doState(
		`${pfx}lastErrorAt`,
		stats.lastErrorAt ? new Date(stats.lastErrorAt).toISOString() : "",
		"Timestamp of last API error",
		"",
		false,
	);
	await this.doState(
		`${pfx}lastSuccessAt`,
		stats.lastSuccessAt ? new Date(stats.lastSuccessAt).toISOString() : "",
		"Timestamp of last successful API request",
		"",
		false,
	);
	await this.doState(
		`${pfx}last429At`,
		stats.last429At ? new Date(stats.last429At).toISOString() : "",
		"Timestamp of last HTTP 429 response",
		"",
		false,
	);
	await this.doState(
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
 * @returns {void}
 * @this {any}
 */
function logApiQueueRecommendationIfChanged() {
	if (!this.apiQueue || typeof this.apiQueue.getStats !== "function") {
		return;
	}

	if (!this.config.api_debug_log) {
		return;
	}

	const stats = this.apiQueue.getStats();

	if (this.lastLoggedRecommendedConcurrency !== stats.recommendedConcurrency) {
		this.lastLoggedRecommendedConcurrency = stats.recommendedConcurrency;

		this.log.info(
			`AdaptiveRequestQueue recommends concurrency=${stats.recommendedConcurrency} ` +
				`(current=${stats.concurrency}, stable=${stats.lastStableConcurrency}, ` +
				`timeouts=${stats.timeouts}, 429=${stats.rateLimited})`,
		);
	}
}

/**
 * Log current queue statistics only if key values changed since the last log.
 * Info logging is only emitted when api_debug_log is enabled.
 *
 * @returns {void}
 * @this {any}
 */
function logApiQueueStatsIfChanged() {
	if (!this.apiQueue || typeof this.apiQueue.getStats !== "function") {
		return;
	}

	if (!this.config.api_debug_log) {
		return;
	}

	const stats = this.apiQueue.getStats();

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

	if (this.lastLoggedQueueSnapshot !== snapshot) {
		this.lastLoggedQueueSnapshot = snapshot;

		this.log.info(
			`API queue stats: current=${stats.concurrency}, recommended=${stats.recommendedConcurrency}, ` +
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
 * @param {"dashboard" | "details" | "heavy"} type - The type of poll to mark the timestamp for (e.g., "dashboard", "details", "heavy").
 * @returns {void}
 * @this {any}
 */
function apiMarkPollTimestamp(type) {
	const now = Date.now();

	switch (type) {
		case "dashboard":
			this.lastApiDashboardPoll = now;
			break;
		case "details":
			this.lastApiDetailsPoll = now;
			break;
		case "heavy":
			this.lastApiHeavyPoll = now;
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
