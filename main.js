"use strict";

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
		this.webQueue = null; // created in onReady when web_use is true

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

		// Reset the connection indicators during startup
		await this.setState("info.connection", false, true);
		await this.setState("info.extension", false, true);
		await this.setObjectNotExistsAsync("info.localConnected", {
			type: "state",
			common: {
				role: "indicator.connected",
				name: "Local (lala.cgi) connected",
				type: "boolean",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync("info.apiConnected", {
			type: "state",
			common: {
				role: "indicator.connected",
				name: "SENEC App API connected",
				type: "boolean",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync("info.webConnected", {
			type: "state",
			common: {
				role: "indicator.connected",
				name: "mein-senec.de connected",
				type: "boolean",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync("info.connectConnected", {
			type: "state",
			common: {
				role: "indicator.connected",
				name: "SENEC.Connect connected",
				type: "boolean",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.setState("info.localConnected", false, true);
		await this.setState("info.apiConnected", false, true);
		await this.setState("info.webConnected", false, true);
		await this.setState("info.connectConnected", false, true);

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

			const apiMinRequestInterval = Math.max(400, Number(this.config.api_min_request_interval) || 400);
			this.apiQueue = new AdaptiveRequestQueue({
				concurrency: apiConcurrencyStart,
				minConcurrency: 1,
				maxConcurrency: apiConcurrencyMax,
				minTimeBetweenStartsMs: apiMinRequestInterval,
				successThreshold: 8,
				cooldownMs: 8000,
				onRetryLog: (msg) => this.log.warn(`[API] 🔄 ${msg}`),
				setTimeout: (fn, ms) => this.setTimeout(fn, ms),
				clearTimeout: (id) => this.clearTimeout(id),
			});

			// Web queue — created unconditionally; only used when web_use is true
			const webConcurrencyStart = Math.max(1, Number(this.config.web_concurrency_start) || 1);
			const webConcurrencyMax = Math.max(webConcurrencyStart, Number(this.config.web_concurrency_max) || 2);
			const webMinRequestInterval = Math.max(400, Number(this.config.web_min_request_interval) || 500);
			this.webQueue = new AdaptiveRequestQueue({
				concurrency: webConcurrencyStart,
				minConcurrency: 1,
				maxConcurrency: webConcurrencyMax,
				minTimeBetweenStartsMs: webMinRequestInterval,
				successThreshold: 8,
				cooldownMs: 8000,
				onRetryLog: (msg) => this.log.warn(`[Web] 🔄 ${msg}`),
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

			if (this.config.lala_use) {
				this.log.info("[Local] Usage of lala.cgi (local) configured.");
				await localClient.localCheckConnection(this);
				if (this.lalaConnected) {
					await localClient.localDiscoverSections(this);
				}
				await localClient.localInitPollSettings(this);
				if (this.lalaConnected) {
					localClient
						.localPoll(this, true, 0)
						.catch((e) => this.logError(e, "[Local] ❌ Initial local highPrio poll failed"));
					localClient
						.localPoll(this, false, 0)
						.catch((e) => this.logError(e, "[Local] ❌ Initial local lowPrio poll failed"));
				}
			} else {
				this.log.warn("[Local] Usage of lala.cgi (local) not configured.");
			}

			if (this.config.api_use) {
				this.log.info("[API] Usage of SENEC App API configured.");
				this.apiConnected = await apiClient.apiStartTokenManager(this);
				if (this.apiConnected) {
					await this.setState("info.apiConnected", true, true);
					apiClient.apiPoll(this).catch((e) => this.logError(e, "[API] ❌ Initial API poll failed"));
				} else {
					this.log.warn(
						"[API] Usage of SENEC App API configured but initial connection failed. Check credentials and connection to SENEC App API. API Polling turned off automatically until restart.",
					);
				}
			} else {
				this.log.warn("[API] Usage of SENEC App API not configured.");
			}

			if (this.config.connect_use) {
				this.log.info("[Connect] Usage of SENEC.Connect API configured.");
				connectClient.connectPoll(this).catch((e) => this.logError(e, "[Connect] ❌ Initial poll failed"));
				this.connectEnabled = true;
				await this.setState("info.connectConnected", true, true);
			}

			// Web cleanup runs regardless of web_use — cleans up states from when features were enabled
			try {
				await webClient.webStartupCleanup(this);
			} catch (e) {
				this.logError(e, "[Web] ❌ startup cleanup failed");
			}

			if (this.config.web_use) {
				this.log.info("[Web] Usage of mein-senec.de configured.");
				try {
					await webClient.webInit(this);
				} catch (e) {
					this.logError(e, "[Web] ❌ mein-senec.de init failed");
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
						`[Web] Web control command for ${controlId} ignored (mein-senec.de control not enabled or not connected)`,
					);
					return;
				}
				await webClient.webHandleControl(this, controlId, state);
				return;
			}

			// Socket controls — multi-connector, check before local gate
			const socketMatch = controlId.match(/^Sockets\.(\d+)\.(.+)$/);
			if (socketMatch) {
				if (this.config.control_sockets_connector === "local") {
					if (!this.config.control_active || !this.lalaConnected) {
						this.log.warn("[Local] Local socket control ignored (not connected via lala.cgi)");
						return;
					}
					const socketVal = state.val ?? false;
					await localClient.localHandleSocketControl(
						this,
						id,
						parseInt(socketMatch[1], 10),
						socketMatch[2],
						socketVal,
					);
					return;
				}
				if (this.config.control_sockets_connector === "web") {
					if (!this.webConnected || this.webMasterPlantNumber === null) {
						this.log.warn("[Web] Web socket control ignored (mein-senec.de not connected)");
						return;
					}
					await webClient.webHandleSocketControl(this, parseInt(socketMatch[1], 10), socketMatch[2], state);
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
						this.log.warn("[Local] Local wallbox control ignored (not connected via lala.cgi)");
						return;
					}
					const wbVal = state.val ?? false;
					await localClient.localHandleWallboxControl(
						this,
						id,
						parseInt(wallboxMatch[1], 10),
						wallboxMatch[2],
						wbVal,
					);
					return;
				}
				if (this.config.control_wallbox_connector === "api") {
					if (!this.config.control_api_active) {
						this.log.warn("[API] API wallbox control ignored (API control not enabled)");
						return;
					}
					const apiWbVal = state.val ?? false;
					await apiClient.apiHandleWallboxControl(
						this,
						parseInt(wallboxMatch[1], 10),
						wallboxMatch[2],
						apiWbVal,
					);
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
				this.log.warn(`[Local] Control command for ${controlId} ignored (not connected via lala.cgi)`);
				return;
			}

			// ForceLoadBattery
			if (controlId === "ForceLoadBattery") {
				const payload = state.val ? batteryOn : batteryOff;
				this.log.info(`[Local] ${state.val ? "Enable" : "Disable"} force battery charging...`);
				await localClient.localSendControl(this, id, payload, `setting force battery charging to ${state.val}`);
				return;
			}

			// RebootAppliance
			if (controlId === "RebootAppliance") {
				if (!this.config.control_reboot) {
					this.log.warn("[Local] Reboot command ignored (control_reboot not enabled in config)");
					return;
				}
				if (state.val) {
					this.log.info("[Local] Rebooting appliance...");
					await localClient.localSendControl(this, id, rebootAppliance, "rebooting appliance");
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
				this.log.info("Rebooting appliance in progress...");
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
		const unit = attrKey ? state_attr[attrKey].unit || "" : "";
		await this.doState(pfx + fullKey, ValueTyping(attrKey || fullKey, value), desc, unit, false);
	}

	/**
	 * Logs an error message with an optional prefix.
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
	if (state_attr[key]?.stringtype) {
		return typeof value === "string" ? value : String(value);
	}
	if (!isNaN(value)) {
		const num = Number(value);
		// Keep as string if conversion loses precision (e.g. large numeric IDs)
		if (typeof value === "string" && String(num) !== value) {
			return value;
		}
		value = num;
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
		normalizeRebuildMode,
		HexToFloat32,
		DecToIP,
		reviverNumParse,
		resolveStateAttrKey,
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
