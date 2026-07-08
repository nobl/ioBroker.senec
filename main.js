"use strict";

const { URLSearchParams } = require("node:url");
const axios = require("axios");
const tough = require("tough-cookie");
const CookieJar = tough.CookieJar;
let wrapper;
const https = require("node:https");

const utils = require("@iobroker/adapter-core");
const state_attr = require(`${__dirname}/lib/state_attr.js`);
const state_trans = require(`${__dirname}/lib/state_trans.js`);
const {
	MIN_REBUILD_START_YEAR,
	REBUILD_MODE,
	batteryOn,
	batteryOff,
	rebootAppliance,
	HexToFloat32,
	reviverNumParse,
} = require(`${__dirname}/lib/constants.js`);

const AdaptiveRequestQueue = require(`${__dirname}/lib/AdaptiveRequestQueue.js`);
const measurements = require(`${__dirname}/lib/measurements.js`);
const rebuild = require(`${__dirname}/lib/rebuild.js`);
const webClient = require(`${__dirname}/lib/web-client.js`);
const localClient = require(`${__dirname}/lib/local-client.js`);
const apiClient = require(`${__dirname}/lib/api-client.js`);
const connectClient = require(`${__dirname}/lib/connect-client.js`);

// process.on("unhandledRejection", (reason, _promise) => {
// 	console.error("Unhandled Promise Rejection:", reason);
// });

// process.on("uncaughtException", (error) => {
// 	console.error("Uncaught Exception:", error);
// });

class Senec extends utils.Adapter {
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options] some options
	 */
	constructor(options) {
		// @ts-expect-error Allow spreading user-supplied options into Adapter constructor despite type mismatch
		super({
			...options,
			name: "senec",
		});

		this.apiConnected = false;
		this.lalaConnected = false;
		this.webConnected = false;
		this.connectVia = "https://";
		this.unloaded = false;

		this.rebuildRunning = false; // true only while one rebuild batch is actively executing
		this.rebuildStepsPerCycle = 1; // bewusst klein halten wegen API-Last
		this.rebuildStepMaxRetries = 3;
		this.rebuildRetryBaseDelayMs = 13 * 60 * 1000; // 13 min
		this.rebuildFailures = new Map(); // key => { attempts, nextTryAt, lastError }
		this.rebuildCompletedSteps = new Set();
		this.lastLoggedRebuildPendingSummary = "";
		this.rebuildInitializedForRun = false;
		this.rebuildForceFullRunActive = false;

		this.lastApiDashboardPoll = 0;
		this.lastApiDetailsPoll = 0;
		this.lastApiHeavyPoll = 0;
		this.dashboardInterval = 0;
		this.detailsInterval = 0;
		this.heavyInterval = 0;

		this.apiKnownSystems = new Set();
		this.highPrioObjects = new Map();
		this.lowPrioForm = "";
		this.highPrioForm = "";
		this.knownObjects = new Map();

		this.apiQueue = null;
		this.apiAgent = null;
		this.apiClient = null;
		this.authClient = null;
		this.jar = new CookieJar();

		this.localAgent = null;
		this.localClient = null;

		this.currentToken = null;
		this.refreshToken = null;
		this.tokenExpiresAt = 0;

		this.timerTokenRefresh = null;
		this.tokenFailureCount = 0;
		this.refreshPromise = null;
		this.authBlocked = false;

		this.tokenBackoff = {
			baseDelayMs: 10000, // 10s start
			maxDelayMs: 30 * 60 * 1000, // 30 min max delay – important for longer outages of senec / keycloak (maybe even increase to 1 hour)
			maxMultiplier: 64, // 2^6 = 64 → if attempt ≥ 6 capping ~10 min → 640 s (~10 min) delay is more than enough for senec outages and prevents excessive load on senec / keycloak in case of issues
		};

		this.timerAPI = null;
		this.apiPollRunning = false;
		this.apiFailureCount = 0;
		this.baseTime = 60000;

		this.socketCount = undefined; // set after first local poll reads SOCKETS.NUMBER_OF_SOCKETS
		this.socketControlsCreated = false;
		this.wallboxCount = undefined; // set after first local poll reads WALLBOX data
		this.wallboxControlsCreated = false;
		this.apiWallboxCount = 0; // set after wallbox search via App API
		this.apiWallboxUuids = []; // UUIDs from wallbox search, needed for measurements and control
		this.apiWallboxObjects = []; // full wallbox objects from search, needed for read-modify-write on settings
		this.apiWallboxSystemId = null; // system ID owning the wallboxes

		// mein-senec.de web session
		this.webJar = null; // cookie jar for mein-senec.de
		this.webAuthenticated = false;
		this.webMasterPlantNumber = null; // anlageNummer for the matched system
		this.webAbilities = {}; // feature visibility flags from getSystem
		this.webStatusIntervalMs = 360000; // default 6 min, overwritten by checkConfig
		this.webMediumIntervalMs = 21600000; // default 6h
		this.webSlowIntervalMs = 86400000; // default 24h

		this.abortController = new AbortController(); // used to cancel ongoing API calls on unload

		this.lastLoggedRecommendedConcurrency = null;
		this.lastLoggedQueueSnapshot = null;

		this.guiLang = "1"; // fallback english

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// load axios-cookiejar-support dynamically (ESM compatible)
		if (!wrapper) {
			const mod = await import("axios-cookiejar-support");
			wrapper = mod.wrapper;
		}

		// Reset the connection indicator during startup
		await this.setState("info.connection", false, true);

		try {
			this.checkConfig();

			const apiConcurrencyStart = Math.max(1, Number(this.config.api_concurrency_start) || 1);
			const apiConcurrencyMax = Math.max(apiConcurrencyStart, Number(this.config.api_concurrency_max) || 1);
			this.dashboardInterval = (this.config.api_interval || 6) * this.baseTime;
			this.detailsInterval = (this.config.api_interval_details || 60) * this.baseTime;
			this.heavyInterval = (this.config.api_interval_heavy || 1440) * this.baseTime;

			// create agents first
			this.localAgent = new https.Agent({
				requestCert: true,
				// rejectUnauthorized needs to be false due to the local machine's certificate cannot be checked properly
				rejectUnauthorized: false,
				keepAlive: true,
				maxSockets: 10,
				maxFreeSockets: 5,
				timeout: 60000,
			});

			this.apiAgent = new https.Agent({
				keepAlive: true,
				maxSockets: apiConcurrencyMax,
				maxFreeSockets: Math.min(apiConcurrencyMax, 5),
				timeout: 60000,
			});

			this.apiQueue = new AdaptiveRequestQueue({
				concurrency: apiConcurrencyStart,
				minConcurrency: 1,
				maxConcurrency: apiConcurrencyMax,
				minTimeBetweenStartsMs: 400,
				successThreshold: 8,
				cooldownMs: 8000,
				setTimeout: (fn, ms) => this.setTimeout(fn, ms),
				clearTimeout: (id) => this.clearTimeout(id),
			});

			// Then create axios clients with the respective agents
			this.localClient = axios.create({
				httpsAgent: this.localAgent,
				timeout: 10000,
				signal: this.abortController?.signal,
			});

			this.apiClient = axios.create({
				timeout: 10000,
				signal: this.abortController?.signal,
				httpsAgent: this.apiAgent,
			});

			this.authClient = wrapper(
				axios.create({
					withCredentials: true,
					timeout: 10000,
					signal: this.abortController?.signal,
				}),
			);

			// Build and apply a consistent User-Agent for all outbound requests
			const userAgent = this.buildUserAgent();
			this.applyDefaultHeaders(this.apiClient, userAgent);
			this.applyDefaultHeaders(this.localClient, userAgent);
			this.applyDefaultHeaders(this.authClient, userAgent);
			this.log.debug(`Using User-Agent: ${userAgent}`);

			// --------------------------------------------------
			// DEBUG: Axios interceptors for logging request and response details when api_debug_log is enabled. This helps to understand the traffic pattern and debug issues with the SENEC App API.
			// --------------------------------------------------
			if (this.config.api_reqnresp_log) {
				// REQUEST INTERCEPTOR
				this.apiClient.interceptors.request.use((config) => {
					try {
						const method = (config.method || "GET").toUpperCase();
						const url = config.url;

						const headers = config.headers || {};
						const userAgent = headers["User-Agent"] || headers["user-agent"];
						const contentType = headers["Content-Type"] || headers["content-type"];

						let dataType = "none";
						if (config.data instanceof URLSearchParams) {
							dataType = "URLSearchParams";
						} else if (typeof config.data === "object") {
							dataType = "object";
						} else if (typeof config.data === "string") {
							dataType = "string";
						}

						this.log.debug(
							`[API REQUEST] ${method} ${url} | UA=${userAgent || "n/a"} | CT=${contentType || "n/a"} | data=${dataType}`,
						);
					} catch (err) {
						this.log.debug(`Request logging failed: ${err.message}`);
					}
					return config;
				});

				// RESPONSE INTERCEPTOR
				this.apiClient.interceptors.response.use(
					(response) => {
						try {
							const method = (response.config?.method || "GET").toUpperCase();
							const url = response.config?.url;
							const status = response.status;

							this.log.debug(`[API RESPONSE] ${status} ${method} ${url}`);
						} catch (err) {
							this.log.debug(`Response logging failed: ${err.message}`);
						}
						return response;
					},
					(error) => {
						try {
							const method = (error.config?.method || "GET").toUpperCase();
							const url = error.config?.url;
							const status = error.response?.status || "no-status";

							this.log.debug(`[API ERROR] ${status} ${method} ${url}`);
						} catch (err) {
							this.log.debug(`Error logging failed: ${err.message}`);
						}
						return Promise.reject(error);
					},
				);
			}

			/**
			 * IMPORTANT DESIGN DECISION:
			 *
			 * We intentionally DO NOT implement any retry logic (e.g. for HTTP 429) inside axios interceptors.
			 *
			 * Reason:
			 * - All request pacing and backoff is handled centrally by AdaptiveRequestQueue
			 * - Additional retries here would bypass queue timing (minTimeBetweenStartsMs)
			 * - This would lead to hidden extra requests and less predictable behavior
			 *
			 * Instead:
			 * - apiGet() handles authentication (401 → token refresh)
			 * - AdaptiveRequestQueue handles overload (429, timeouts, cooldown, concurrency)
			 * - apiPoll() handles global polling backoff
			 *
			 * Result:
			 * - Fully deterministic request flow
			 * - Cleaner diagnostics (queue stats reflect real traffic)
			 * - Better stability under load
			 */
			// const { setTimeout } = require("timers/promises");
			// this.apiClient.interceptors.response.use(
			// 	// upon 429 Too Many Requests axios will auto-retry without breaking the poll-loop and without throwing an error to trigger the retry logic in apiPoll,
			// 	// which includes increasing the delay between polls in case of repeated 429 responses.
			// 	(response) => response,
			// 	async (error) => {
			// 		if (error.response && error.response.status === 429 && !unloaded) {
			// 			this.log.debug("Experiencing 429. Retrying within axios logic once.");
			// 			if (!error.config._retry429) {
			// 				error.config._retry429 = true;
			// 				await setTimeout(2000); // wait 2s before retrying - this is a simple fixed delay to give the server some time to recover, since we don't have information about how long the client should wait until retrying (like Retry-After header)
			// 				return this.apiClient.request(error.config);
			// 			}
			// 		}
			// 		throw error;
			// 	},
			// );

			if (this.config.lala_use) {
				this.log.info("Usage of lala.cgi (local) configured.");
				await this.localCheckConnection();
				if (this.lalaConnected) {
					await this.localDiscoverSections();
				}
				await this.localInitPollSettings();
				if (this.lalaConnected) {
					this.localPoll(true, 0).catch((e) => this.logError(e, "❌ Initial local highPrio poll failed"));
					this.localPoll(false, 0).catch((e) => this.logError(e, "❌ Initial local lowPrio poll failed"));
				}
			} else {
				this.log.warn("Usage of lala.cgi (local) not configured. Only polling SENEC App API if configured.");
			}

			if (this.config.api_use) {
				this.log.info("Usage of SENEC App API configured.");
				this.apiConnected = await this.apiStartTokenManager();
				if (this.apiConnected) {
					this.apiPoll().catch((e) => this.logError(e, "❌ Initial API poll failed"));
				} else {
					this.log.warn(
						"Usage of SENEC App API configured but initial connection failed. Check credentials and connection to SENEC App API. API Polling turned of automatically until restart.",
					);
				}
			} else {
				this.log.warn(
					"Usage of SENEC App API not configured. Only polling appliance via local network if configured.",
				);
			}

			if (this.config.connect_use) {
				this.log.info("Usage of SENEC.Connect API configured.");
				this.connectPoll().catch((e) => this.logError(e, "❌ Initial SENEC.Connect poll failed"));
				this.connectEnabled = true;
			}

			if (this.config.web_use) {
				this.log.info("Usage of mein-senec.de configured.");
				try {
					await this.webInit();
				} catch (e) {
					this.logError(e, "❌ mein-senec.de init failed");
				}
			}

			if (this.lalaConnected || this.apiConnected || this.connectEnabled || this.webConnected) {
				await this.setState("info.connection", true, true);
				await this.refreshGuiLangCache();
			} else {
				this.log.error(
					"Neither local connection, API connection, nor SENEC.Connect configured. Please check config!",
				);
			}

			if (this.config.control_active) {
				this.log.info("Active appliance control (local) activated!");
				await this.subscribeStatesAsync("control.*"); // subscribe on all state changes in control.
				await this.subscribeStatesAsync("ENERGY.STAT_STATE");
				await this.subscribeStatesAsync("SYS_UPDATE.USER_REBOOT_DEVICE");
			}
		} catch (error) {
			this.logError(error, "❌ Adapter startup failed");
			await this.setState("info.connection", false, true);
		}
	}

	/**
	 * @param {string} id The id of the state that changed
	 * @param {ioBroker.State | null | undefined} state The state object that changed
	 */
	async onStateChange(id, state) {
		if (!state) {
			return;
		}

		// --- User control commands (ack = false) ---
		if (!state.ack) {
			this.log.debug(`State changed: ${id} ( ${JSON.stringify(state)} )`);

			const controlId = id.slice(`${this.namespace}.control.`.length);

			// Web controls (mein-senec.de) — independent gate
			if (
				controlId.startsWith("EmergencyPower.") ||
				controlId.startsWith("PeakShaving.") ||
				controlId.startsWith("SGReady.")
			) {
				if (
					!this.config.web_use ||
					!this.config.control_web_active ||
					!this.webConnected ||
					this.webMasterPlantNumber === null
				) {
					this.log.warn(
						`Web control command for ${controlId} ignored (mein-senec.de control not enabled or not connected)`,
					);
					return;
				}
				await this.webHandleControl(controlId, state);
				return;
			}

			// Socket controls — multi-connector, check before local gate
			const socketMatch = controlId.match(/^Sockets\.(\d+)\.(.+)$/);
			if (socketMatch) {
				if (this.config.control_sockets_connector === "local") {
					if (!this.config.control_active || !this.lalaConnected) {
						this.log.warn("Local socket control ignored (not connected via lala.cgi)");
						return;
					}
					const socketVal = state.val ?? false;
					await this.localHandleSocketControl(id, parseInt(socketMatch[1], 10), socketMatch[2], socketVal);
					return;
				}
				if (this.config.control_sockets_connector === "web") {
					if (!this.webConnected || this.webMasterPlantNumber === null) {
						this.log.warn("Web socket control ignored (mein-senec.de not connected)");
						return;
					}
					await this.webHandleSocketControl(parseInt(socketMatch[1], 10), socketMatch[2], state);
					return;
				}
				this.log.warn("Socket control command ignored (no connector active)");
				return;
			}

			// Wallbox controls — multi-connector, check before local gate
			const wallboxMatch = controlId.match(/^Wallbox\.(\d+)\.(.+)$/);
			if (wallboxMatch) {
				if (this.config.control_wallbox_connector === "local") {
					if (!this.config.control_active || !this.lalaConnected) {
						this.log.warn("Local wallbox control ignored (not connected via lala.cgi)");
						return;
					}
					const wbVal = state.val ?? false;
					await this.localHandleWallboxControl(id, parseInt(wallboxMatch[1], 10), wallboxMatch[2], wbVal);
					return;
				}
				if (this.config.control_wallbox_connector === "api") {
					if (!this.config.control_api_active) {
						this.log.warn("API wallbox control ignored (API control not enabled)");
						return;
					}
					const apiWbVal = state.val ?? false;
					await this.apiHandleWallboxControl(parseInt(wallboxMatch[1], 10), wallboxMatch[2], apiWbVal);
					return;
				}
				this.log.warn("Wallbox control command ignored (no connector active)");
				return;
			}

			// Local-only controls — require control_active + lala.cgi
			if (!this.config.control_active) {
				return;
			}
			if (!this.lalaConnected) {
				this.log.warn(`Control command for ${controlId} ignored (not connected via lala.cgi)`);
				return;
			}

			// ForceLoadBattery
			if (controlId === "ForceLoadBattery") {
				const payload = state.val ? batteryOn : batteryOff;
				this.log.info(`${state.val ? "Enable" : "Disable"} force battery charging ...`);
				await this.localSendControl(id, payload, `setting force battery charging to ${state.val}`);
				return;
			}

			// RebootAppliance
			if (controlId === "RebootAppliance") {
				if (!this.config.control_reboot) {
					this.log.warn("Reboot command ignored (control_reboot not enabled in config)");
					return;
				}
				if (state.val) {
					this.log.info("Rebooting appliance ...");
					await this.localSendControl(id, rebootAppliance, "rebooting appliance");
				}
				return;
			}

			return;
		}

		// --- Device state sync (ack = true) ---
		if (id === `${this.namespace}.ENERGY.STAT_STATE`) {
			this.log.debug(`State changed: ${id} ( ${JSON.stringify(state)} )`);
			const forceLoad = await this.getStateAsync(`${this.namespace}.control.ForceLoadBattery`);
			if (state.val == 8 || state.val == 9) {
				if (state.val == 9) {
					this.log.info("Battery forced loading completed (battery full).");
				}
				if (forceLoad != null && !forceLoad.val) {
					this.log.info(
						"Battery forced loading activated (from outside or just lag). Syncing control-state.",
					);
					await this.setStateChangedAsync(`${this.namespace}.control.ForceLoadBattery`, {
						val: true,
						ack: true,
					});
				}
			} else {
				if (forceLoad != null && forceLoad.val) {
					this.log.info(
						"Battery forced loading deactivated (from outside or just lag). Syncing control-state.",
					);
					await this.setStateChangedAsync(`${this.namespace}.control.ForceLoadBattery`, {
						val: false,
						ack: true,
					});
				}
			}
		} else if (id === `${this.namespace}.SYS_UPDATE.USER_REBOOT_DEVICE`) {
			this.log.debug(`State changed: ${id} ( ${JSON.stringify(state)} )`);
			if (state.val) {
				this.log.info("Rebooting appliance in progress ...");
			} else {
				this.log.info("Reboot completed. Syncing control-state.");
				await this.setStateChangedAsync(`${this.namespace}.control.RebootAppliance`, {
					val: false,
					ack: true,
				});
			}
		}
	}

	/**
	 * Send a control command to the local SENEC device via lala.cgi.
	 * The response contains the current device state which evalPoll processes.
	 * We also ack the control state itself so the user gets immediate feedback.
	 *
	 * @param {string} stateId - The control state id to ack on success
	 * @param {string} payload - The JSON payload to send
	 * @param {string} description - Human-readable description for error logging
	 */
	async localSendControl(stateId, payload, description) {
		return localClient.localSendControl.call(this, stateId, payload, description);
	}

	/**
	 * Handle a socket control state change.
	 * For settings, the value is just stored without ack.
	 * For Apply, all pending values are read and sent to the device.
	 *
	 * @param {string} stateId - The full state id
	 * @param {number} socketIdx - Socket index (0-based)
	 * @param {string} field - The control field name (e.g. "ForceOn", "LowerLimit", "Apply")
	 * @param {boolean | number | string} value - The value to set
	 */
	async localHandleSocketControl(stateId, socketIdx, field, value) {
		return localClient.localHandleSocketControl.call(this, stateId, socketIdx, field, value);
	}

	/**
	 * Create control datapoints for switchable sockets.
	 * Called once after the first local poll reveals NUMBER_OF_SOCKETS.
	 */
	async localCreateSocketControls() {
		return localClient.localCreateSocketControls.call(this);
	}

	/**
	 * Remove leftover socket control datapoints when sockets are unavailable or disabled.
	 */
	/**
	 * Remove all control channels matching a pattern (e.g. "Sockets" or "Wallbox").
	 *
	 * @param {string} pattern - Substring to match in channel IDs (e.g. ".control.Sockets.")
	 * @param {string} label - Human-readable label for log messages
	 */
	async cleanupControlChannels(pattern, label) {
		return localClient.cleanupControlChannels.call(this, pattern, label);
	}

	async localCleanupSocketControls() {
		return localClient.localCleanupSocketControls.call(this);
	}

	/**
	 * Discover device capabilities and sync all control datapoints.
	 * Called after each low-priority local poll.
	 *
	 * @param {object} obj - The full parsed poll response
	 */
	async localDiscoverAndSyncControls(obj) {
		return localClient.localDiscoverAndSyncControls.call(this, obj);
	}

	/**
	 * Sync socket control datapoints with values read from the device.
	 *
	 * @param {object} socketsData - The SOCKETS section from the poll response
	 */
	async localSyncSocketControls(socketsData) {
		return localClient.localSyncSocketControls.call(this, socketsData);
	}

	/**
	 * Handle a local wallbox control state change.
	 * For settings, the value is just stored without ack.
	 * For Apply, all pending values are read and sent to the device.
	 *
	 * @param {string} stateId - The full state id
	 * @param {number} wbIdx - Wallbox index (0-based)
	 * @param {string} field - The control field name
	 * @param {boolean | number | string} value - The value to set
	 */
	async localHandleWallboxControl(stateId, wbIdx, field, value) {
		return localClient.localHandleWallboxControl.call(this, stateId, wbIdx, field, value);
	}

	/**
	 * Create control datapoints for wallboxes.
	 * Called once after the first local poll reveals wallbox data.
	 */
	async localCreateWallboxControls() {
		return localClient.localCreateWallboxControls.call(this);
	}

	/**
	 * Sync wallbox control datapoints with values read from the device.
	 *
	 * @param {object} wallboxData - The WALLBOX section from the poll response
	 */
	async localSyncWallboxControls(wallboxData) {
		return localClient.localSyncWallboxControls.call(this, wallboxData);
	}

	/**
	 * Remove leftover wallbox control datapoints when no wallboxes are available.
	 */
	async localCleanupWallboxControls() {
		return localClient.localCleanupWallboxControls.call(this);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback The shutdown callback
	 */
	onUnload(callback) {
		try {
			this.unloaded = true;

			if (this.abortController) {
				// abort any ongoing API calls to prevent them from running after unload and to prevent memory leaks
				this.abortController.abort();
			}

			// destroy axios agents to close all open sockets and prevent them from running after unload and to prevent memory leaks
			if (this.apiAgent) {
				this.apiAgent.destroy();
			}
			if (this.localAgent) {
				this.localAgent.destroy();
			}

			this.knownObjects.clear(); // empty objects cache
			this.log.info("cleaned everything up...");
			this.setState("info.connection", false, true);
			callback();
		} catch (e) {
			this.logError(e);
			callback();
		}
	}

	/**
	 * Build the User-Agent string for outbound HTTP requests.
	 *
	 * Supported modes:
	 * - integration
	 * - browser
	 * - custom
	 *
	 * @returns {string} User-Agent string
	 */
	buildUserAgent() {
		const adapterVersion = this.version || "unknown";
		const mode = this.config.api_userAgentMode || "integration";

		switch (mode) {
			case "browser":
				return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

			case "custom":
				if (this.config.api_customUserAgent && String(this.config.api_customUserAgent).trim()) {
					return String(this.config.api_customUserAgent).trim();
				}
				return `ioBroker.senec/${adapterVersion} (+https://github.com/nobl/ioBroker.senec)`;

			case "integration":
			default:
				return `ioBroker.senec/${adapterVersion} (+https://github.com/nobl/ioBroker.senec)`;
		}
	}

	/**
	 * Apply default HTTP headers to an axios client.
	 *
	 * @param {import("axios").AxiosInstance} client axios instance
	 * @param {string} userAgent user agent string to apply
	 */
	applyDefaultHeaders(client, userAgent) {
		if (!client || !client.defaults || !client.defaults.headers) {
			return;
		}

		client.defaults.headers.common["User-Agent"] = userAgent;
		client.defaults.headers.common["Accept"] = "application/json";
		client.defaults.headers.post["Content-Type"] = "application/json";
		client.defaults.headers.put["Content-Type"] = "application/json";
		client.defaults.headers.patch["Content-Type"] = "application/json";
	}

	async localInitPollSettings() {
		return localClient.localInitPollSettings.call(this);
	}

	addUserDps(value, objectsSet, dpToAdd) {
		return localClient.addUserDps.call(this, value, objectsSet, dpToAdd);
	}

	/**
	 * checks config paramaters
	 * Fallback to default values in case they are out of scope
	 */
	checkConfig() {
		this.log.debug(`(checkConf) Configured polling interval high priority: ${this.config.interval}s`);
		if (this.config.interval < 1 || this.config.interval > 3600) {
			this.log.warn(
				`(checkConf) Config interval high priority ${
					this.config.interval
				} not [1..3600] seconds. Using default: 10`,
			);
			this.config.interval = 10;
		}
		this.log.debug(`(checkConf) Configured polling interval low priority: ${this.config.intervalLow}m`);
		if (this.config.intervalLow < 5 || this.config.intervalLow > 3600) {
			this.log.warn(
				`(checkConf) Config interval low priority ${
					this.config.intervalLow
				} not [5..3600] minutes. Using default: 60`,
			);
			this.config.intervalLow = 60;
		}
		this.log.debug(`(checkConf) Configured polling timeout: ${this.config.pollingTimeout}`);
		if (this.config.pollingTimeout < 1000 || this.config.pollingTimeout > 10000) {
			this.log.warn(
				`(checkConf) Config timeout ${this.config.pollingTimeout} not [1000..10000] ms. Using default: 5000`,
			);
			this.config.pollingTimeout = 5000;
		}
		this.log.debug(`(checkConf) Configured num of retries: ${this.config.retries}`);
		if (this.config.retries < 0 || this.config.retries > 999) {
			this.log.warn(
				`(checkConf) Config num of retries ${this.config.retries} not [0..999] seconds. Using default: 10`,
			);
			this.config.retries = 10;
		}
		this.log.debug(`(checkConf) Configured retry multiplier: ${this.config.retrymultiplier}`);
		if (this.config.retrymultiplier < 1 || this.config.retrymultiplier > 10) {
			this.log.warn(
				`(checkConf) Config retry multiplier ${
					this.config.retrymultiplier
				} not [1..10] seconds. Using default: 2`,
			);
			this.config.retrymultiplier = 2;
		}

		this.log.debug(`(checkConf) Configured api polling interval dashboard: ${this.config.api_interval}`);
		if (this.config.api_interval < 3 || this.config.api_interval > 1440) {
			this.log.warn(
				`(checkConf) Config api polling interval ${
					this.config.api_interval
				} not [3..1440] seconds. Using default: 6`,
			);
			this.config.api_interval = 6;
		}

		this.log.debug(`(checkConf) Configured api polling interval details: ${this.config.api_interval_details}`);
		if (
			this.config.api_interval_details <= this.config.api_interval ||
			this.config.api_interval_details < 10 ||
			this.config.api_interval_details > 1440
		) {
			this.log.warn(
				`(checkConf) Config api polling interval details ${
					this.config.api_interval_details
				} not [10..1440] seconds or <= polling interval dashboard. Using default: 60`,
			);
			this.config.api_interval_details = 60;
		}

		this.log.debug(`(checkConf) Configured api polling interval heavy: ${this.config.api_interval_heavy}`);
		if (
			this.config.api_interval_heavy <= this.config.api_interval_details ||
			this.config.api_interval_heavy < 720 ||
			this.config.api_interval_heavy > 2880
		) {
			this.log.warn(
				`(checkConf) Config api polling interval heavy ${
					this.config.api_interval_heavy
				} not [720..2880] seconds or <= polling interval details. Using default: 1440`,
			);
			this.config.api_interval_heavy = 1440;
		}

		this.log.debug(`(checkConf) Configured api concurrency start: ${this.config.api_concurrency_start}`);
		if (this.config.api_concurrency_start < 1 || this.config.api_concurrency_start > 4) {
			this.log.warn(
				`(checkConf) Config api concurrency start ${this.config.api_concurrency_start} not [1..4]. Using default: 1`,
			);
			this.config.api_concurrency_start = 1;
		}

		this.log.debug(`(checkConf) Configured api concurrency max: ${this.config.api_concurrency_max}`);
		if (this.config.api_concurrency_max < 1 || this.config.api_concurrency_max > 6) {
			this.log.warn(
				`(checkConf) Config api concurrency max ${this.config.api_concurrency_max} not [1..6]. Using default: 1`,
			);
			this.config.api_concurrency_max = 1;
		}

		if (this.config.api_concurrency_max < this.config.api_concurrency_start) {
			this.log.warn(
				`(checkConf) Config api concurrency max ${this.config.api_concurrency_max} lower than start ${this.config.api_concurrency_start}. Using start value.`,
			);
			this.config.api_concurrency_max = this.config.api_concurrency_start;
		}

		this.log.debug(`(checkConf) Configured user agent mode: ${this.config.api_userAgentMode}`);
		if (!["integration", "browser", "custom"].includes(this.config.api_userAgentMode)) {
			this.log.warn(
				`(checkConf) Config userAgentMode ${this.config.api_userAgentMode} invalid. Using default: integration`,
			);
			this.config.api_userAgentMode = "integration";
		}

		if (typeof this.config.api_customUserAgent !== "string") {
			this.log.warn("(checkConf) Config customUserAgent invalid. Using default: empty string");
			this.config.api_customUserAgent = "";
		}

		this.log.debug(`(checkConf) Configured alltime rebuild mode: ${this.config.api_alltimeRebuildMode}`);
		const configuredRebuildMode = this.config.api_alltimeRebuildMode;
		const normalizedRebuildMode = normalizeRebuildMode(configuredRebuildMode);
		if (String(configuredRebuildMode || "").toLowerCase() !== normalizedRebuildMode) {
			this.log.warn(
				`(checkConf) Config api_alltimeRebuildMode ${configuredRebuildMode} invalid. Using default: off`,
			);
		}
		this.config.api_alltimeRebuildMode = normalizedRebuildMode;

		this.log.debug(`(checkConf) Configured alltime rebuild start year: ${this.config.api_alltimeRebuildStartYear}`);
		const currentYear = new Date().getUTCFullYear();
		const configuredStartYear = Number(this.config.api_alltimeRebuildStartYear);
		if (
			!Number.isInteger(configuredStartYear) ||
			configuredStartYear < MIN_REBUILD_START_YEAR ||
			configuredStartYear > currentYear
		) {
			this.log.warn(
				`(checkConf) Config api_alltimeRebuildStartYear ${this.config.api_alltimeRebuildStartYear} ` +
					`not [${MIN_REBUILD_START_YEAR}..${currentYear}]. Using default: ${currentYear}`,
			);
			this.config.api_alltimeRebuildStartYear = currentYear;
		} else {
			this.config.api_alltimeRebuildStartYear = configuredStartYear;
		}

		// mein-senec.de intervals (minutes)
		if (this.config.web_interval_status < 3 || this.config.web_interval_status > 60) {
			this.log.warn(
				`(checkConf) Config web_interval_status ${this.config.web_interval_status} not [3..60]. Using default: 6`,
			);
			this.config.web_interval_status = 6;
		}
		if (this.config.web_interval_medium < 60 || this.config.web_interval_medium > 1440) {
			this.log.warn(
				`(checkConf) Config web_interval_medium ${this.config.web_interval_medium} not [60..1440]. Using default: 360`,
			);
			this.config.web_interval_medium = 360;
		}
		if (this.config.web_interval_slow < 360 || this.config.web_interval_slow > 2880) {
			this.log.warn(
				`(checkConf) Config web_interval_slow ${this.config.web_interval_slow} not [360..2880]. Using default: 1440`,
			);
			this.config.web_interval_slow = 1440;
		}

		// Pre-compute mein-senec.de intervals in ms
		this.webStatusIntervalMs = this.config.web_interval_status * 60000;
		this.webMediumIntervalMs = this.config.web_interval_medium * 60000;
		this.webSlowIntervalMs = this.config.web_interval_slow * 60000;
	}

	/**
	 * checks connection to senec service
	 */
	async localCheckConnection() {
		return localClient.localCheckConnection.call(this);
	}

	/**
	 * Discover available sections from the device via lala.cgi.
	 * Posts {"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}} and merges any
	 * newly discovered section names into allKnownObjects.
	 * Results are stored in the info.discoveredSections datapoint.
	 */
	async localDiscoverSections() {
		return localClient.localDiscoverSections.call(this);
	}

	/**
	 * Starts the token manager and attempts to obtain a valid API token.
	 * The method first checks for an existing refresh token in the state. If a refresh token is found, it attempts to refresh the access token using that refresh token. If the refresh attempt fails (e.g., due to an invalid or expired refresh token), it falls back to performing a full login to obtain new tokens.
	 *
	 * The method ensures that the adapter can authenticate with the SENEC App API and is ready for subsequent API calls. It also handles the initial setup of the token management process, including scheduling future token refreshes.
	 * Important: This method should be called during adapter startup to ensure that the adapter has a valid token before making any API calls. If this method returns false, it indicates that the adapter was unable to authenticate with the SENEC App API, and API polling should not be started.
	 *
	 * @returns {Promise<boolean>} A promise resolving to true if a valid token is obtained, false otherwise.
	 */
	async apiStartTokenManager() {
		return apiClient.apiStartTokenManager.call(this);
	}

	/**
	 * Performs the Senec API login flow.
	 * This method is responsible for authenticating with the SENEC App API using the Resource Owner Password Credentials flow with PKCE.
	 * It handles the entire login process, including form parsing, handling multi-step authentication (username/password), and token exchange.
	 * Upon successful login, it stores the access token and refresh token securely and schedules the next token refresh.
	 * Important: This method should only be called when there is no valid refresh token available or when a full re-authentication is required (e.g., after multiple failed refresh attempts).
	 *
	 * @returns {Promise<string|null>} The access token if login is successful, or null if login fails.
	 */
	async apiLogin() {
		return apiClient.apiLogin.call(this);
	}

	/**
	 * Schedules the refresh of the API token based on its expiration time.
	 * Includes a safety margin to refresh the token before it actually expires and implements an exponential backoff strategy in case of refresh failures to prevent excessive load on the SENEC / Keycloak servers.
	 * Important: This method should be called after obtaining a new token (either via login or refresh) to ensure continuous authentication.
	 *
	 * @returns {void}
	 */
	scheduleTokenRefresh() {
		return apiClient.scheduleTokenRefresh.call(this);
	}

	async apiRefreshToken() {
		return apiClient.apiRefreshToken.call(this);
	}

	/**
	 * Polls the SENEC API for updates.
	 * Runs one API poll cycle, applies global error/backoff handling and schedules the next execution.
	 *
	 * @returns {Promise<void>}
	 * @throws {Error} Will throw an error if the API call fails or if all scheduled tasks fail during the poll cycle.
	 */
	async apiPoll() {
		return apiClient.apiPoll.call(this);
	}

	/**
	 * Schedules the next API poll.
	 * The method calculates the delay for the next poll based on the success or failure of the current poll cycle, implementing a backoff strategy in case of failures to prevent overwhelming the SENEC API. It also ensures that no new poll is scheduled if the adapter is unloaded, and it clears any existing timers to avoid overlapping polls. The method logs the scheduled time for the next poll for debugging purposes.
	 *
	 * @param {number} delay - The delay in milliseconds before the next poll.
	 */
	apiScheduleNextPoll(delay) {
		return apiClient.apiScheduleNextPoll.call(this, delay);
	}

	/**
	 * Builds the context for an API poll cycle, determining which tasks should run based on the last poll timestamps and configured intervals.
	 * The method calculates whether the dashboard, details, and heavy tasks should run by comparing the current time with the last poll timestamps for each task type and the respective configured intervals. It also prepares relevant date information (today, yesterday, current month, last month) in UTC to be used for API calls that require date parameters. The resulting context object contains flags indicating which tasks to run and the prepared date information for use in the API polling methods.
	 * The method ensures that the API polling logic can make informed decisions about which data to fetch during each poll cycle, optimizing the polling process based on the configured intervals and the timing of previous polls.
	 *
	 * @returns {object} Context object containing flags for which tasks to run and relevant date information for the API calls.
	 */
	apiBuildPollContext() {
		return apiClient.apiBuildPollContext.call(this);
	}

	/**
	 * Ensures that the API systems are loaded.
	 * The method checks if the known systems from the API are already loaded, and if not, it makes an API call to fetch the available systems. It then iterates through the returned systems, logs their information for debugging purposes, adds their IDs to the set of known systems, and evaluates the poll for each system to prepare for subsequent API calls. This method is crucial for ensuring that the adapter has the necessary information about the available systems before attempting to poll data from the API.
	 * The method also includes error handling to throw an error if no systems are returned from the API, which is essential for the proper functioning of the adapter, as it relies on having at least one system to poll data from. By loading the systems at this stage, the adapter can optimize its polling process and ensure that it is targeting the correct systems for data retrieval.
	 *
	 * @returns {Promise<void>}
	 */
	async apiEnsureSystemsLoaded() {
		return apiClient.apiEnsureSystemsLoaded.call(this);
	}

	/**
	 * Executes one full API cycle across all known systems.
	 * Handles dashboard/details/heavy polling and optionally one rebuild batch.
	 *
	 * @returns {Promise<{totalFailure: boolean, partialFailure: boolean, failedSystems: number, message: string}>} Result of the poll cycle, including failure status and messages.
	 * @throws {Error} Will throw an error if all scheduled tasks fail during the poll cycle.
	 */
	async apiRunPollCycle() {
		return apiClient.apiRunPollCycle.call(this);
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
	 */
	async apiPollSingleSystem(anlagenId, ctx, rebuildAlreadyExecuted) {
		return apiClient.apiPollSingleSystem.call(this, anlagenId, ctx, rebuildAlreadyExecuted);
	}

	/**
	 * Polls the API for the dashboard data of a single system.
	 * The method makes an API call to retrieve the dashboard data for the specified system ID, logs the keys of the returned data for debugging purposes, and then evaluates the poll to update the relevant states based on the retrieved data. The method includes error handling to catch any exceptions that occur during the API call, ensuring that a failure in retrieving the dashboard data does not prevent the execution of other tasks for the same system. By providing detailed logging of the retrieved data, this method allows for better monitoring and debugging of the interactions with the SENEC App API for the dashboard data.
	 * The method assumes that the necessary authentication token is available and that the API systems are loaded before it is called, as it relies on this information to perform the API call effectively. It also updates the poll timestamps for the dashboard task based on the success of the API call, which is essential for the scheduling logic of subsequent poll cycles.
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollDashboard(anlagenId) {
		return apiClient.apiPollDashboard.call(this, anlagenId);
	}

	/**
	 * Generic API poll: GET → evalPoll → update lastPoll → log.
	 * For simple endpoints that follow the standard pattern.
	 *
	 * @param {string} anlagenId - System ID
	 * @param {string} url - Full API URL
	 * @param {string} evalPrefix - Prefix for evalPoll (e.g. "_api.Anlagen.{id}.OnlineState.")
	 * @param {string} pollName - Name for lastPoll state and log messages
	 */
	async _apiPollEndpoint(anlagenId, url, evalPrefix, pollName) {
		return apiClient._apiPollEndpoint.call(this, anlagenId, url, evalPrefix, pollName);
	}

	/**
	 * Polls the API for online state (online/offline, since when).
	 * Called on the dashboard tier.
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollOnlineState(anlagenId) {
		return apiClient.apiPollOnlineState.call(this, anlagenId);
	}

	/**
	 * Polls the API for system status (operating mode, firmware, last contact).
	 * Called on the dashboard tier.
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollSystemStatus(anlagenId) {
		return apiClient.apiPollSystemStatus.call(this, anlagenId);
	}

	/**
	 * Polls the API for system details (hardware info, battery state, inverter temps).
	 * Called on the details tier (hourly).
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollSystemDetails(anlagenId) {
		return apiClient.apiPollSystemDetails.call(this, anlagenId);
	}

	/**
	 * Polls the API for installed abilities/feature packages.
	 * Called once after systems are loaded.
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollAbilities(anlagenId) {
		return apiClient.apiPollAbilities.call(this, anlagenId);
	}

	/**
	 * Polls the API for forecast charging settings.
	 * Called on the heavy tier (daily).
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollForecastChargingSettings(anlagenId) {
		return apiClient.apiPollForecastChargingSettings.call(this, anlagenId);
	}

	/**
	 * Searches for wallboxes via the App API.
	 * Called once at startup. Stores wallbox data under _api.Anlagen.{id}.Wallboxes.
	 *
	 * @param {string} anlagenId - The ID of the system to search wallboxes for.
	 */
	async apiPollWallboxSearch(anlagenId) {
		return apiClient.apiPollWallboxSearch.call(this, anlagenId);
	}

	/**
	 * Create control datapoints for API wallbox control.
	 * Called once after wallbox search discovers wallboxes.
	 */
	async apiCreateWallboxControls() {
		return apiClient.apiCreateWallboxControls.call(this);
	}

	/**
	 * Sync API wallbox control datapoints with values from the cached wallbox objects.
	 */
	async apiSyncWallboxControls() {
		return apiClient.apiSyncWallboxControls.call(this);
	}

	/**
	 * Handle an API wallbox control state change.
	 * For settings (Mode, MinChargingCurrentInA, etc.) the value is just stored without ack.
	 * For Apply, all pending values are read and sent to the API.
	 *
	 * @param {number} wbIdx - Wallbox index (0-based)
	 * @param {string} field - The control field name
	 * @param {boolean | number | string} value - The value to set
	 */
	async apiHandleWallboxControl(wbIdx, field, value) {
		return apiClient.apiHandleWallboxControl.call(this, wbIdx, field, value);
	}

	/**
	 * Polls the API for data availability timespan.
	 * Called once after systems are loaded. Returns the date range for which
	 * measurement data is available — useful for history rebuild.
	 *
	 * @param {string} anlagenId - The ID of the system to poll.
	 */
	async apiPollDataAvailability(anlagenId) {
		return apiClient.apiPollDataAvailability.call(this, anlagenId);
	}

	/**
	 * Run an array of measurement tasks, summarize results, and update lastPoll.
	 *
	 * @param {string} anlagenId - System ID
	 * @param {Array<{fn: () => Promise<{status: string}>, label: string}>} tasks - Measurement tasks
	 * @param {string} pollName - Name for log messages and lastPoll state
	 * @param {(() => Promise<void>)} [beforeLastPoll] - Optional async work to run after tasks but before lastPoll
	 */
	async _runMeasurementTasks(anlagenId, tasks, pollName, beforeLastPoll) {
		return apiClient._runMeasurementTasks.call(this, anlagenId, tasks, pollName, beforeLastPoll);
	}

	/**
	 * Polls the API for the details data of a single system.
	 *
	 * @param {string} anlagenId anlagen id
	 * @param {object} ctx context
	 * @returns {Promise<void>}
	 */
	async apiPollDetails(anlagenId, ctx) {
		return apiClient.apiPollDetails.call(this, anlagenId, ctx);
	}

	/**
	 * Polls the API for the heavy data of a single system.
	 *
	 * @param {string} anlagenId Anlagen id to poll
	 * @param {object} ctx context
	 * @returns {Promise<void>}
	 */
	async apiPollHeavy(anlagenId, ctx) {
		return apiClient.apiPollHeavy.call(this, anlagenId, ctx);
	}

	/**
	 * Merges the results of a system poll into the overall poll result.
	 * The method takes the results of a single system poll and updates the overall poll result object by incrementing the counts for scheduled and succeeded tasks, as well as the count of failed systems. It checks the flags for each task type (dashboard, details, heavy) in the single system result and updates the corresponding fields in the total result accordingly. This method is essential for aggregating the results of individual system polls into a comprehensive summary of the entire poll cycle, allowing for better monitoring and analysis of the polling process across all systems.
	 * The method assumes that the total result object is initialized with the necessary fields to track the counts of scheduled and succeeded tasks, as well as the count of failed systems. By systematically merging the results of each system poll, the method ensures that the overall poll result accurately reflects the performance and outcomes of the API polling process for all systems.
	 *
	 * @param {object} total - The overall poll result object that aggregates the results of all system polls.
	 * @param {object} single - The result object for a single system poll, containing flags for scheduled and succeeded tasks, as well as a failure flag.
	 */
	apiMergeSystemPollResult(total, single) {
		return apiClient.apiMergeSystemPollResult(total, single);
	}

	/**
	 * Finalizes the poll timestamps based on the results of the poll cycle.
	 * The method checks the results of the poll cycle for each task type (dashboard, details, heavy) and updates the last poll timestamps accordingly if all scheduled tasks of that type succeeded for all known systems. It compares the count of succeeded tasks with the total number of known systems to determine if the poll timestamp should be updated. This method is crucial for maintaining accurate scheduling of subsequent poll cycles, as it ensures that the adapter has the correct information about when each task type was last successfully polled, allowing for optimized scheduling based on the configured intervals.
	 * The method assumes that the total result object contains accurate counts of scheduled and succeeded tasks for each task type, as well as the total number of known systems. By systematically finalizing the poll timestamps based on the results, the method helps to ensure that the adapter operates efficiently and effectively in its interactions with the SENEC App API.
	 *
	 * @param {object} result - The result object of the poll cycle, containing counts of scheduled and succeeded tasks for each task type, as well as the total number of known systems.
	 */
	apiFinalizePollTimestamps(result) {
		return apiClient.apiFinalizePollTimestamps.call(this, result);
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
	 */
	async _apiRequest(method, url, data, config = {}) {
		return apiClient._apiRequest.call(this, method, url, data, config);
	}

	/**
	 * API GET with token management and retry logic.
	 *
	 * @param {string} url - URL to call
	 * @param {object} [config] - Axios config overrides
	 * @returns {Promise<object>} The axios response
	 */
	async apiGet(url, config = {}) {
		return apiClient.apiGet.call(this, url, config);
	}

	/**
	 * API POST with token management and retry logic.
	 *
	 * @param {string} url - The URL to post to
	 * @param {object} data - The JSON body to send
	 * @param {object} [config] - Optional axios config overrides
	 * @returns {Promise<object>} The axios response
	 */
	async apiPost(url, data, config = {}) {
		return apiClient.apiPost.call(this, url, data, config);
	}

	/**
	 * API PATCH with token management and retry logic.
	 *
	 * @param {string} url - The URL to patch
	 * @param {object} [data] - Optional JSON body to send
	 * @param {object} [config] - Optional axios config overrides
	 * @returns {Promise<object>} The axios response
	 */
	async apiPatch(url, data, config = {}) {
		return apiClient.apiPatch.call(this, url, data, config);
	}

	/**
	 * Performs the rebuild of the all-time history for a given system (Anlage).
	 *
	 * @param {string} anlagenId - The ID of the system (Anlage) for which to perform the rebuild
	 * @returns {Promise<void>} Resolves when the current rebuild batch is done
	 */
	async doRebuild(anlagenId) {
		return rebuild.doRebuild.call(this, anlagenId);
	}

	/**
	 * Build measurement URL and state prefix, supporting both regular and wallbox measurements.
	 *
	 * @param {string | number} anlagenId - System ID
	 * @param {string} resolution - Resolution (HOUR, DAY, MONTH, YEAR)
	 * @param {string} start - URL-encoded start date ISO string
	 * @param {string} end - URL-encoded end date ISO string
	 * @param {string} tier - Tier name for prefix (Daily, Monthly, Yearly)
	 * @param {{ uuid: string, index: number }} [wallbox] - Wallbox info, or undefined for regular measurements
	 * @returns {{ url: string, pfx: string }} The measurement URL and state prefix
	 */
	buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, tier, wallbox) {
		return measurements.buildMeasurementUrlAndPrefix(anlagenId, resolution, start, end, tier, wallbox);
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
	async doMeasurementsYear(anlagenId, year, months, wallbox) {
		return measurements.doMeasurementsYear.call(this, anlagenId, year, months, wallbox);
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
	async doMeasurementsMonth(anlagenId, date, period, wallbox) {
		return measurements.doMeasurementsMonth.call(this, anlagenId, date, period, wallbox);
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
	async doMeasurementsDay(anlagenId, date, period, wallbox) {
		return measurements.doMeasurementsDay.call(this, anlagenId, date, period, wallbox);
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
	async _fetchAndSumMeasurements(url, anlagenId, pfx, period, logLabel) {
		return measurements._fetchAndSumMeasurements.call(this, url, anlagenId, pfx, period, logLabel);
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
	async doSumMeasurements(data, anlagenId, pfx, period) {
		return measurements.doSumMeasurements.call(this, data, anlagenId, pfx, period);
	}

	/**
	 * Builds a compact summary of measurement result statuses.
	 *
	 * @param {Array<{label: string; status: string}>} results - kind of status
	 * @returns {{success: number; no_data: number; skipped_existing: number; total: number}}
	 * Aggregated count of result statuses.
	 */
	summarizeMeasurementResults(results) {
		return measurements.summarizeMeasurementResults(results);
	}

	/**
	 * Formats a measurement result summary for log output.
	 *
	 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - type of measurement result
	 * @returns {string} Human-readable summary string.
	 */
	formatMeasurementSummary(summary) {
		return measurements.formatMeasurementSummary(summary);
	}

	/**
	 * Classifies aggregated measurement results into a higher-level health state.
	 *
	 * @param {{success: number; no_data: number; skipped_existing: number; total: number}} summary - type of measurement result
	 * @returns {"productive" | "up_to_date" | "empty" | "mixed" | "unknown"}
	 * High-level interpretation of the measurement results.
	 */
	classifyMeasurementSummary(summary) {
		return measurements.classifyMeasurementSummary(summary);
	}

	/**
	 * Returns a human-readable explanation for a classified measurement summary.
	 *
	 * @param {"productive" | "up_to_date" | "empty" | "mixed" | "unknown"} classification - measurements were classified as
	 * @returns {string} Description for log output.
	 */
	formatMeasurementClassification(classification) {
		return measurements.formatMeasurementClassification(classification);
	}

	/**
	 * Perform GET or POST request
	 *
	 * @param {string} pUrl URL to call
	 * @param {string} pForm Form to send
	 * @param {number} pollingTimeout Timeout for call
	 * @param {boolean} isPost true for POST, false for GET
	 * @returns {Promise<string>} Promise with result
	 */
	async localDoGet(pUrl, pForm, pollingTimeout, isPost) {
		return localClient.localDoGet.call(this, pUrl, pForm, pollingTimeout, isPost);
	}

	// ── mein-senec.de Debug Probe ──────────────────────────────────────────

	/**
	 * Initialize mein-senec.de: authenticate, discover system, detect features, start polling.
	 */
	async webInit() {
		return webClient.webInit.call(this);
	}

	/**
	 * Shared mein-senec.de HTTP request with session-expiry re-auth.
	 *
	 * @param {"get" | "post"} method - HTTP method
	 * @param {string} url - URL to request
	 * @param {object} [data] - Optional JSON body (POST only)
	 * @returns {Promise<object>} axios response
	 */
	async _webRequest(method, url, data) {
		return webClient._webRequest.call(this, method, url, data);
	}

	/**
	 * GET request to mein-senec.de with auto re-auth on session expiry.
	 *
	 * @param {string} url - URL to request
	 * @returns {Promise<object>} axios response
	 */
	async webGet(url) {
		return webClient.webGet.call(this, url);
	}

	/**
	 * POST request to mein-senec.de with auto re-auth on session expiry.
	 *
	 * @param {string} url - URL to request
	 * @param {object} [data] - Optional JSON body
	 * @returns {Promise<object>} axios response
	 */
	async webPost(url, data) {
		return webClient.webPost.call(this, url, data);
	}

	/**
	 * Poll mein-senec.de for status, spare capacity, peak shaving, SG-Ready.
	 * Self-scheduling poll loop.
	 */
	async webPoll() {
		return webClient.webPoll.call(this);
	}

	/**
	 * Create control datapoints for mein-senec.de features based on discovered abilities.
	 * Called once after webInit() discovers the system and its abilities.
	 */
	async webCreateControls() {
		return webClient.webCreateControls.call(this);
	}

	/**
	 * Create web socket control datapoints after first socket poll.
	 * Called when sockets are discovered and connector is set to "web".
	 *
	 * @param {number} count - Number of sockets
	 */
	async webCreateSocketControls(count) {
		return webClient.webCreateSocketControls.call(this, count);
	}

	/**
	 * Create unified socket control datapoints for a single socket index.
	 * Shared by both local and web socket control creation.
	 *
	 * @param {number} idx - Socket index
	 */
	async createSocketControlsForIndex(idx) {
		const ch = `control.Sockets.${idx}`;
		await this.setObjectNotExistsAsync(ch, {
			type: "channel",
			common: { name: `Socket ${idx}` },
			native: {},
		});
		await this.setObjectNotExistsAsync(`${ch}.Name`, {
			type: "state",
			common: {
				name: "Socket name",
				type: "string",
				role: "text",
				read: true,
				write: true,
				def: "",
			},
			native: {},
		});
		await this.setObjectNotExistsAsync(`${ch}.Mode`, {
			type: "state",
			common: {
				name: "Mode",
				type: "string",
				role: "text",
				read: true,
				write: true,
				def: "OFF",
				states: { OFF: "Off", PERMANENT_ON: "On", AUTOMATIC: "Auto" },
			},
			native: {},
		});
		const numStates = [
			{ id: "EinschaltschwelleInWatt", name: "Switch-on threshold", unit: "W" },
			{ id: "AbschaltschwelleInWatt", name: "Switch-off threshold", unit: "W" },
			{ id: "DauerLeistungsueberschussInMin", name: "Power surplus duration", unit: "min" },
			{ id: "DauerSteckdoseAnInMin", name: "Socket on duration", unit: "min" },
			{ id: "EinschaltHour", name: "Switch-on hour", unit: "" },
			{ id: "EinschaltMinute", name: "Switch-on minute", unit: "" },
		];
		for (const s of numStates) {
			await this.setObjectNotExistsAsync(`${ch}.${s.id}`, {
				type: "state",
				common: {
					name: s.name,
					type: "number",
					role: "level",
					unit: s.unit,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
		}
		await this.setObjectNotExistsAsync(`${ch}.Apply`, {
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

	/**
	 * Handle a mein-senec.de control command.
	 *
	 * @param {string} subId - The control ID (e.g. "EmergencyPower.ReserveInPercent")
	 * @param {object} state - The ioBroker state object
	 */
	async webHandleControl(subId, state) {
		return webClient.webHandleControl.call(this, subId, state);
	}

	/**
	 * Apply pending peak shaving changes to mein-senec.de.
	 */
	async webHandlePeakShavingApply() {
		return webClient.webHandlePeakShavingApply.call(this);
	}

	/**
	 * Sync peak shaving control datapoints with values read from the portal.
	 *
	 * @param {object} data - Peak shaving settings from the API
	 */
	async webSyncPeakShavingControls(data) {
		return webClient.webSyncPeakShavingControls.call(this, data);
	}

	/**
	 * Apply pending SG-Ready changes to mein-senec.de.
	 */
	async webHandleSGReadyApply() {
		return webClient.webHandleSGReadyApply.call(this);
	}

	/**
	 * Sync SG-Ready control datapoints with values read from the portal.
	 *
	 * @param {object} data - SG-Ready config from the API
	 */
	async webSyncSGReadyControls(data) {
		return webClient.webSyncSGReadyControls.call(this, data);
	}

	/**
	 * Sync web socket control datapoints with values read from the portal.
	 *
	 * @param {number} idx - Socket index
	 * @param {object} data - Socket data from the API
	 */
	async webSyncSocketControls(idx, data) {
		return webClient.webSyncSocketControls.call(this, idx, data);
	}

	/**
	 * Handle a web socket control command (Apply button).
	 *
	 * @param {number} idx - Socket index
	 * @param {string} field - Field name (e.g. "Apply", "Mode")
	 * @param {object} state - ioBroker state object
	 */
	async webHandleSocketControl(idx, field, state) {
		return webClient.webHandleSocketControl.call(this, idx, field, state);
	}

	/**
	 * Perform web login to mein-senec.de via Keycloak SSO.
	 * Uses a dedicated cookie jar (webJar) separate from the App API jar.
	 *
	 * @returns {Promise<boolean>} true if login succeeded
	 */
	async webLogin() {
		return webClient.webLogin.call(this, {
			extractFormAction: apiClient.extractFormAction,
			hasOtp: apiClient.hasOtp,
			hasUsername: apiClient.hasUsername,
			hasPassword: apiClient.hasPassword,
			generateTOTP: apiClient.generateTOTP,
		});
	}

	// ── SENEC.Connect Polling ──────────────────────────────────────────────

	/**
	 * Polls the SENEC.Connect API for device data.
	 * Uses subscription key authentication (Ocp-Apim-Subscription-Key header).
	 * All requested data sections are fetched in a single request via the include parameter.
	 */
	async connectPoll() {
		return connectClient.connectPoll.call(this);
	}

	// ── Local Polling ──────────────────────────────────────────────────────

	/**
	 * Read values from Senec Home V2.1
	 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often.
	 * Adverse effects: No sync with Senec possible if called too often.
	 *
	 * @param {boolean} isHighPrio high priority poll
	 * @param {number} retry retry count
	 */
	async localPoll(isHighPrio, retry) {
		return localClient.localPoll.call(this, isHighPrio, retry);
	}

	/**
	 * Load AllTimeValueStore for given anlagenId and prefix
	 * The method retrieves the state of the specified value store and parses its value to return an object representing the all-time measurements for the given system ID and year.
	 * It checks if the retrieved state has a valid value and handles different data formats (string or object) to ensure that the returned object is correctly structured.
	 * If the value store does not exist or does not contain valid data, it returns an empty object. This method is essential for managing the historical data for each system,
	 * allowing the adapter to maintain an accurate record of all-time measurements and provide valuable insights into the long-term performance of the system.
	 *
	 * @param {string} valueStore ValueStore
	 * @returns {Promise<Record<string, number> | object>} AllTimeValueStore as object
	 */
	async readAllTimeValueStore(valueStore) {
		return rebuild.readAllTimeValueStore.call(this, valueStore);
	}

	/**
	 * Insert values into AllTimeValueStore
	 * The method reads the existing values from the AllTimeValueStore for the specified system ID and year, updates the values based on the provided sums, and then writes the updated values back to the AllTimeValueStore.
	 *
	 * @param {{ [s: string]: number; }} sums sums to insert
	 * @param {string | number} anlagenId Anlagen ID
	 * @param {number} year Year to insert for
	 */
	async insertIntoAllTimeValueStore(sums, anlagenId, year) {
		return rebuild.insertIntoAllTimeValueStore.call(this, sums, anlagenId, year);
	}

	getRebuildStartYear() {
		return rebuild.getRebuildStartYear.call(this);
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
	 */
	async updateAllTimeHistory(anlagenId) {
		return rebuild.updateAllTimeHistory.call(this, anlagenId);
	}

	/**
	 * sets a state's value and creates the state if it doesn't exist yet
	 *
	 * @param name Name of the state
	 * @param value Value of the state
	 * @param description Description of the state
	 * @param unit Unit of the state
	 * @param write Writable state
	 * @param read Readable state
	 */
	async doState(name, value, description, unit, write, read = true) {
		if (!isNaN(name.substring(0, 1))) {
			// keys cannot start with digits! Possibly SENEC delivering erraneous data
			this.log.debug(`(doState) Invalid datapoint: ${name}: ${value}`);
			return;
		}
		this.log.silly(`(doState) Update: ${name}: ${value}`);

		const valueType = value !== null && value !== undefined ? typeof value : "mixed";

		// Check object for changes:
		let obj = this.knownObjects.get(name);
		if (!obj) {
			obj = await this.getObjectAsync(name);

			if (obj) {
				this.knownObjects.set(name, obj);
			}
		}
		if (obj) {
			const newCommon = {};
			if (obj.common.name !== description) {
				this.log.debug(`(doState) Updating object: ${name} (desc): ${obj.common.name} -> ${description}`);
				newCommon.name = description;
			}
			if (obj.common.type !== valueType) {
				this.log.debug(`(doState) Updating object: ${name} (type): ${obj.common.type} -> ${valueType}`);
				newCommon.type = valueType;
			}
			if (obj.common.unit !== unit) {
				this.log.debug(`(doState) Updating object: ${name} (unit): ${obj.common.unit} -> ${unit}`);
				newCommon.unit = unit;
			}
			if (obj.common.write !== write) {
				this.log.debug(`(doState) Updating object: ${name} (write): ${obj.common.write} -> ${write}`);
				newCommon.write = write;
			}
			if (obj.common.read !== read) {
				this.log.debug(`(doState) Updating object: ${name} (read): ${obj.common.read} -> ${read}`);
				newCommon.read = read;
			}
			if (Object.keys(newCommon).length > 0) {
				await this.extendObject(name, { common: newCommon });
				obj.common = { ...obj.common, ...newCommon };
				this.knownObjects.set(name, obj);
			}
		} else {
			obj = {
				type: "state",
				common: {
					name: description,
					type: valueType,
					role: "value",
					unit: unit,
					read: read,
					write: write,
				},
				native: {},
			};

			await this.setObjectNotExistsAsync(name, obj);
			this.knownObjects.set(name, obj);
		}
		await this.setStateChangedAsync(name, {
			val: value,
			ack: true,
		});
		await this.doDecode(name, value);
	}

	/**
	 * Decodes a state value based on the language-specific translations defined in the state
	 * and updates the corresponding _Text state with the translated value.
	 * The method checks if there is a translation available for the given state name and value based on the current GUI language.
	 * If a translation is found, it retrieves the translated text and updates the corresponding _Text state with the translated value and description.
	 * This allows for dynamic translation of state values based on the user's language preferences in the ioBroker interface, enhancing the usability and accessibility of the adapter for users with different language settings.
	 * The method assumes that the state attributes contain the necessary translation information for the supported languages, and it relies on this information to perform the decoding and updating of the _Text states accurately.
	 *
	 * @param {string} name Name of the state
	 * @param {string | number} value Value of the state
	 */
	async doDecode(name, value) {
		const lang = this.guiLang || "1";
		this.log.silly(`(Decode) Senec language: ${lang}`);
		let key = name;
		if (!isNaN(Number(name.substring(name.lastIndexOf(".")) + 1))) {
			key = name.substring(0, name.lastIndexOf("."));
		}
		this.log.silly(`(Decode) Checking: ${name} -> ${key}`);

		if (state_trans[`${key}.${lang}`] !== undefined) {
			this.log.silly(`(Decode) Trans found for: ${key}.${lang}`);
			const trans =
				state_trans[`${key}.${lang}`] !== undefined
					? state_trans[`${key}.${lang}`][value] !== undefined
						? state_trans[`${key}.${lang}`][value]
						: "(unknown)"
					: "(unknown)";
			this.log.silly(`(Decode) Trans ${key}:${value} = ${trans}`);
			const desc = state_attr[`${key}_Text`] !== undefined ? state_attr[`${key}_Text`].name : key;
			await this.doState(`${name}_Text`, trans, desc, "", true);
		}
	}

	/**
	 * evaluates data polled from SENEC system.
	 * creates / updates the state.
	 *
	 * @param {{ [s: string]: object; }} obj object to evaluate
	 * @param {string} pfx prefix for state
	 * @param keyPrefix current key prefix for nested objects
	 */
	async evalPoll(obj, pfx, keyPrefix = "") {
		if (this.unloaded) {
			return;
		}

		if (Array.isArray(obj)) {
			for (const [index, value] of obj.entries()) {
				const fullKey = keyPrefix ? `${keyPrefix}.${index}` : `${index}`;
				if (typeof value === "object" && value !== null) {
					await this.evalPoll(value, pfx, fullKey);
				} else {
					await this.evalPollHelper(pfx, value, fullKey);
				}
			}
			return;
		}

		for (const [key, value] of Object.entries(obj)) {
			const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;
			if (typeof value === "object" && value !== null) {
				await this.evalPoll(value, pfx, fullKey);
			} else {
				await this.evalPollHelper(pfx, value, fullKey);
			}
		}
	}

	/**
	 * Evaluates a single polled value and updates the corresponding state.
	 * This is a helper function for evalPoll to handle individual values, including logging and state attribute resolution.
	 *
	 * @param {string} pfx - The prefix for the state name.
	 * @param {string | number | boolean} value - The value to evaluate.
	 * @param {string} fullKey - The full key for the state.
	 */
	async evalPollHelper(pfx, value, fullKey) {
		// Resolve state attribute: try exact key, then strip trailing index, then strip all indices
		const attrKey = resolveStateAttrKey(fullKey, state_attr);

		if (!attrKey) {
			this.log.debug(`REPORT_TO_DEV: State attribute definition missing for: ${fullKey}, Val: ${value}`);
		}
		this.log.silly(`API Array Value: ${fullKey} = ${value}`);
		const desc = attrKey ? state_attr[attrKey].name : fullKey;
		const unit = attrKey ? state_attr[attrKey].unit : "";
		await this.doState(pfx + fullKey, ValueTyping(attrKey || fullKey, value), desc, unit, false);
	}

	/**
	 * Update diagnostic states for AdaptiveRequestQueue.
	 * This makes the currently observed / practical concurrency visible in ioBroker.
	 */
	async apiUpdateQueueStats() {
		return apiClient.apiUpdateQueueStats.call(this);
	}

	/**
	 * Log recommended concurrency only when it changes.
	 * Info logging is only emitted when api_debug_log is enabled.
	 */
	logApiQueueRecommendationIfChanged() {
		return apiClient.logApiQueueRecommendationIfChanged.call(this);
	}

	/**
	 * Log current queue statistics only if key values changed since the last log.
	 * Info logging is only emitted when api_debug_log is enabled.
	 */
	logApiQueueStatsIfChanged() {
		return apiClient.logApiQueueStatsIfChanged.call(this);
	}

	/**
	 * Logs an error message with an optional prefix.
	 * The method checks if the error object has a message property and logs it accordingly. If the error object also contains a stack trace,
	 * it logs that at the debug level for more detailed troubleshooting information.
	 * This method is used throughout the adapter to ensure consistent and informative error logging, making it easier to identify and resolve issues that may arise during API calls, polling, or other operations.
	 *
	 * @param {Error} e - The error object or message to log.
	 * @param {string} prefix - The prefix for the error message.
	 */
	logError(e, prefix = "") {
		const msg = e?.message ?? String(e);
		this.log.error(prefix ? `${prefix}: ${msg}` : msg);

		if (e?.stack) {
			this.log.debug(e.stack);
		}
	}

	/**
	 * Update a lastPoll timestamp state.
	 *
	 * @param {string} stateId - Full state path (e.g. "_api.info.lastPoll.Dashboard")
	 * @param {string} description - Human-readable description
	 */
	async updateLastPoll(stateId, description) {
		await this.doState(stateId, new Date().toISOString(), description, "", false);
	}

	/**
	 * @param {number} lastRunTs timestamp of last run
	 * @param {number} intervalMs interval in milliseconds
	 * @returns {boolean} true if the interval has passed since lastRunTs, false otherwise
	 */
	apiShouldRunInterval(lastRunTs, intervalMs) {
		return apiClient.apiShouldRunInterval(lastRunTs, intervalMs);
	}

	/**
	 * Marks the current timestamp for the given poll type. This is used to track when the last successful poll of each type occurred, which can be helpful for debugging and ensuring that polling intervals are respected.
	 * The type parameter indicates which poll type is being marked, allowing for separate tracking of dashboard, details, and heavy polls.
	 *
	 * @param {"dashboard" | "details" | "heavy"} type - The type of poll to mark the timestamp for (e.g., "dashboard", "details", "heavy").
	 */
	apiMarkPollTimestamp(type) {
		return apiClient.apiMarkPollTimestamp.call(this, type);
	}

	/**
	 * Refreshes the cached GUI language from the existing state.
	 * No extra request is performed for this. The value is only taken
	 * from states that were already populated during normal local startup.
	 * Lang: WIZARD.GUI_LANG 0=German, 1=English, 2=Italian
	 */
	async refreshGuiLangCache() {
		try {
			const langState = await this.getStateAsync("WIZARD.GUI_LANG");

			if (langState && langState.val !== null && langState.val !== undefined && langState.val !== "") {
				this.guiLang = String(langState.val);
				this.log.info(`Cached SENEC language from existing state: ${this.guiLang}`);
				return;
			}

			this.guiLang = "1";
			this.log.info(
				"No GUI language state available. Using fallback language: 1 (English). " +
					"This is expected on first startup and can also happen on systems without local polling.",
			);
		} catch (error) {
			this.guiLang = "1";
			this.log.debug(`Failed to refresh GUI language cache: ${error.message}`);
		}
	}

	/**
	 * Generates a unique key for one rebuild step.
	 * The key is used for rebuildFailures and rebuildCompletedSteps.
	 *
	 * Rebuild includes yearly and monthly steps.
	 * Reason:
	 * - yearly rebuild is needed for complete all-time aggregation
	 * - monthly rebuild is needed because normal polling only fetches monthly breakdowns for the current and previous year
	 * - older historic monthly data would otherwise never be populated
	 *
	 * @param {string} anlagenId - System id
	 * @param {number} year - Year of the rebuild step
	 * @param {boolean} monthly - true for monthly aggregation step, false for yearly
	 * @returns {string} The unique key for the rebuild step.
	 */
	getRebuildStepKey(anlagenId, year, monthly) {
		return rebuild.getRebuildStepKey(anlagenId, year, monthly);
	}

	/**
	 * @param {string} anlagenId - System id
	 */
	getAllRebuildStepsForSystem(anlagenId) {
		return rebuild.getAllRebuildStepsForSystem.call(this, anlagenId);
	}

	getTotalRebuildStepsPerSystem() {
		return rebuild.getTotalRebuildStepsPerSystem.call(this);
	}

	/**
	 * @param {Error & { response?: { status: number }; code?: string }} error - if an error occurs
	 */
	isApiRelevantRebuildError(error) {
		return rebuild.isApiRelevantRebuildError(error);
	}

	/**
	 * @param {string} anlagenId - System id
	 */
	async getPendingRebuildSteps(anlagenId) {
		return rebuild.getPendingRebuildSteps.call(this, anlagenId);
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
	 */
	async isRebuildStepDone(anlagenId, year, monthly) {
		return rebuild.isRebuildStepDone.call(this, anlagenId, year, monthly);
	}

	/**
	 * Checks if the rebuild process is finished for a specific system.
	 *
	 * @param {string} anlagenId - The ID of the system to check.
	 * @returns {Promise<boolean>} True if the rebuild is finished for the specified system, false otherwise.
	 */
	async isRebuildFinishedForSystem(anlagenId) {
		return rebuild.isRebuildFinishedForSystem.call(this, anlagenId);
	}

	/**
	 * Checks if the rebuild process is finished for all systems.
	 *
	 * @returns {Promise<boolean>} True if the rebuild is finished for all systems, false otherwise.
	 */
	async isRebuildFinishedGlobally() {
		return rebuild.isRebuildFinishedGlobally.call(this);
	}

	/**
	 * Logs the pending rebuild failures in a user-friendly format.
	 * This method retrieves the list of pending failures and logs them in an informative way, indicating which systems and steps are still pending and when the next retry attempts will occur.
	 * If there are no pending failures, the method simply returns without logging anything.
	 */
	logRebuildPendingFailuresIfChanged() {
		return rebuild.logRebuildPendingFailuresIfChanged.call(this);
	}

	/**
	 * Executes one rebuild step.
	 *
	 * @param {string} anlagenId - The ID of the system for which to run the rebuild step
	 * @param {{ anlagenId?: string; year: number; monthly: boolean; wallbox?: { uuid: string; index: number } }} step - rebuild step
	 * @returns {Promise<boolean>} True if step finished successfully, otherwise false
	 */
	async runSingleRebuildStep(anlagenId, step) {
		return rebuild.runSingleRebuildStep.call(this, anlagenId, step);
	}

	/**
	 * Returns the state id used to persist rebuild completion for one rebuild step.
	 *
	 * @param {string} anlagenId - System id
	 * @param {number} year - year
	 * @param {boolean} monthly - monthly or yearly
	 * @returns {string} Fully qualified state id for the rebuild done marker
	 */
	getRebuildDoneStateId(anlagenId, year, monthly) {
		return rebuild.getRebuildDoneStateId(anlagenId, year, monthly);
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
	 */
	async persistRebuildDone(anlagenId, year, monthly) {
		return rebuild.persistRebuildDone.call(this, anlagenId, year, monthly);
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
	 */
	async initializeForcedRebuildIfNeeded() {
		return rebuild.initializeForcedRebuildIfNeeded.call(this);
	}

	/**
	 * @returns {string} normalized rebuild mode
	 */
	getRebuildMode() {
		return rebuild.getRebuildMode.call(this);
	}

	/**
	 * @returns {boolean} true if any rebuild mode is active
	 */
	isRebuildEnabled() {
		return rebuild.isRebuildEnabled.call(this);
	}

	/**
	 * @returns {boolean} true if current rebuild mode requests a forced full rebuild
	 */
	isForceFullRebuildRequested() {
		return rebuild.isForceFullRebuildRequested.call(this);
	}

	/**
	 * @param {number} ms - ms to wait
	 * @returns {Promise<void>}
	 */
	delay(ms) {
		return new Promise((resolve) => {
			if (this.unloaded || ms <= 0) {
				resolve(undefined);
				return;
			}

			this.setTimeout(() => {
				resolve(undefined);
			}, ms);
		});
	}

	/**
	 * Clamp an end date so it never lies in the future.
	 *
	 * @param {Date} endDate calculated period end
	 * @returns {Date} endDate or current time, whichever is earlier
	 */
	clampEndDateToNow(endDate) {
		return measurements.clampEndDateToNow(endDate);
	}
}

/**
 * Resolve a full key against state_attr with 3-level fallback:
 * 1. Exact match (e.g. "batteryModules.0.serialNumber")
 * 2. Strip trailing numeric index (e.g. "batteryModules.0" → "batteryModules")
 * 3. Strip all numeric indices (e.g. "batteryModules.0.serialNumber" → "batteryModules.serialNumber")
 *
 * @param {string} fullKey - The full dotted key
 * @param {object} attrs - The state_attr lookup object
 * @returns {string | null} The resolved key or null
 */
function resolveStateAttrKey(fullKey, attrs) {
	if (attrs[fullKey] !== undefined) {
		return fullKey;
	}
	const strippedTrailing = fullKey.replace(/\.\d+$/, "");
	if (attrs[strippedTrailing] !== undefined) {
		return strippedTrailing;
	}
	const strippedAll = fullKey.replace(/\.\d+\./g, ".");
	if (attrs[strippedAll] !== undefined) {
		return strippedAll;
	}
	return null;
}

/**
 * modifies the supplied value based upon flags set for the specific key.
 * currently handles bool, date, ip objects
 *
 * @param key key to check
 * @param value value to modify
 */
const ValueTyping = (key, value) => {
	if (!isNaN(value)) {
		value = Number(value);
	} // otherwise iobroker will note it as string
	if (state_attr[key] === undefined) {
		return value;
	}
	const isBool = state_attr[key] !== undefined && state_attr[key].booltype ? state_attr[key].booltype : false;
	const isDate = state_attr[key] !== undefined && state_attr[key].datetype ? state_attr[key].datetype : false;
	const isIP = state_attr[key] !== undefined && state_attr[key].iptype ? state_attr[key].iptype : false;
	const multiply = state_attr[key] !== undefined && state_attr[key].multiply ? state_attr[key].multiply : 1;
	if (isBool) {
		return value === 0 ? false : true;
	} else if (isDate) {
		// If value > 1e12, it's already in milliseconds; otherwise convert from seconds
		const ms = value > 1e12 ? value : value * 1000;
		return new Date(ms).toString();
	} else if (isIP) {
		return DecToIP(value);
	} else if (multiply !== 1) {
		return parseFloat((value * multiply).toFixed(2));
	}
	return value;
};

//const toFloat = (val) => {
//	if (val === null || val === undefined) return 0;
//	const num = Number(val);
//	return Number.isNaN(num) ? 0 : parseFloat(num.toFixed(2));
//};

/**
 * Converts a given decimal to a properly formatted IP address.
 * We have to do that because Senec stores IPs as regular hex values and due to the fact that we
 * are using a reviver function for the JSON we have to back-convert to hex and then build the IP
 * for proper human reading.
 *
 * @param str decimal value
 */
const DecToIP = (str) => {
	let ipHex = str.toString(16);
	while (ipHex.length < 8) {
		ipHex = `0${ipHex}`;
	}
	const fourth = ipHex.substring(0, 2);
	const third = ipHex.substring(2, 4);
	const second = ipHex.substring(4, 6);
	const first = ipHex.substring(6);
	return `${parseInt(first, 16)}.${parseInt(second, 16)}.${parseInt(third, 16)}.${parseInt(fourth, 16)}`;
};

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options] options
	 */
	module.exports = (options) => new Senec(options);
	// Export pure functions for unit testing
	module.exports._testing = {
		extractFormAction: apiClient.extractFormAction,
		hasUsername: apiClient.hasUsername,
		hasPassword: apiClient.hasPassword,
		hasUsernameAndPassword: apiClient.hasUsernameAndPassword,
		hasOtp: apiClient.hasOtp,
		generateTOTP: apiClient.generateTOTP,
		computeBackoffDelay: apiClient.computeBackoffDelay,
		normalizeRebuildMode,
		HexToFloat32,
		DecToIP,
		reviverNumParse,
		generateCodeVerifier: apiClient.generateCodeVerifier,
		generateCodeChallenge: apiClient.generateCodeChallenge,
		base64UrlEncode: apiClient.base64UrlEncode,
		resolveStateAttrKey,
		webApiErrorMsg: webClient.webApiErrorMsg,
	};
} else {
	// otherwise start the instance directly
	new Senec();
}

function normalizeRebuildMode(value) {
	const mode = String(value || "").toLowerCase();

	if (mode === REBUILD_MODE.OFF || mode === REBUILD_MODE.RESUME || mode === REBUILD_MODE.FORCE_FULL) {
		return mode;
	}

	return REBUILD_MODE.OFF;
}
