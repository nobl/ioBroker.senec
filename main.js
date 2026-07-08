"use strict";

const crypto = require("node:crypto");
const { URL, URLSearchParams } = require("node:url");
const axios = require("axios");
const tough = require("tough-cookie");
const CookieJar = tough.CookieJar;
let wrapper;
const https = require("node:https");

const utils = require("@iobroker/adapter-core");
const state_attr = require(`${__dirname}/lib/state_attr.js`);
const state_trans = require(`${__dirname}/lib/state_trans.js`);
const {
	API_PFX,
	LAST_UPDATED,
	TOKEN_STATE,
	API_HOST_SYSTEMS,
	API_HOST_MEASUREMENTS,
	API_HOST_ABILITIES,
	API_HOST_WALLBOX,
	CONNECT_HOST,
	WEB_HOST,
	CONFIG,
	MIN_REBUILD_START_YEAR,
	REBUILD_MODE,
	batteryOn,
	batteryOff,
	rebootAppliance,
	allKnownObjects,
	deprecatedSections,
} = require(`${__dirname}/lib/constants.js`);

const AdaptiveRequestQueue = require(`${__dirname}/lib/AdaptiveRequestQueue.js`);
const measurements = require(`${__dirname}/lib/measurements.js`);

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
		const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
		try {
			await this.evalPoll(
				JSON.parse(await this.localDoGet(url, payload, this.config.pollingTimeout, true), reviverNumParse),
				"",
				"",
			);
			await this.setState(stateId, { val: (await this.getStateAsync(stateId))?.val, ack: true });
		} catch (error) {
			this.logError(error, `Failed to control: ${description}`);
		}
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
		if (this.socketCount === undefined || socketIdx >= this.socketCount) {
			this.log.warn(`Socket ${socketIdx} does not exist (device has ${this.socketCount ?? 0} sockets)`);
			return;
		}

		// Non-Apply fields: just store the pending value (no ack)
		if (field !== "Apply") {
			this.log.debug(`Socket ${socketIdx}: pending ${field} = ${value}`);
			return;
		}

		// Apply: read unified controls and translate to local registers
		if (!value) {
			return;
		}

		const pfx = `control.Sockets.${socketIdx}`;
		this.log.info(`Applying socket ${socketIdx} changes via local...`);

		const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
		const onThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltschwelleInWatt`);
		const offThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.AbschaltschwelleInWatt`);
		const surplusDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
		const socketDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerSteckdoseAnInMin`);
		const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltHour`);
		const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltMinute`);

		const mode = String(modeState?.val || "OFF");
		const socketsPayload = {};
		const arr = () => Array.from({ length: this.socketCount }, () => "");
		const u8 = (val) => `u8_${val ? "01" : "00"}`;
		const u1 = (val) =>
			`u1_${Math.max(0, Number(val) || 0)
				.toString(16)
				.toUpperCase()
				.padStart(4, "0")}`;
		const u8n = (val) =>
			`u8_${Math.max(0, Number(val) || 0)
				.toString(16)
				.toUpperCase()
				.padStart(2, "0")}`;

		// Translate Mode → Enable/ForceOn/UseTime
		const enableArr = arr();
		const forceOnArr = arr();
		const useTimeArr = arr();
		enableArr[socketIdx] = u8(mode !== "OFF");
		forceOnArr[socketIdx] = u8(mode === "PERMANENT_ON");
		useTimeArr[socketIdx] = u8(
			mode === "AUTOMATIC" && (Number(hourState?.val) > 0 || Number(minuteState?.val) > 0),
		);
		socketsPayload.ENABLE = enableArr;
		socketsPayload.FORCE_ON = forceOnArr;
		socketsPayload.USE_TIME = useTimeArr;

		// Translate thresholds and durations
		const upperArr = arr();
		upperArr[socketIdx] = u1(onThreshState?.val);
		socketsPayload.UPPER_LIMIT = upperArr;

		const lowerArr = arr();
		lowerArr[socketIdx] = u1(offThreshState?.val);
		socketsPayload.LOWER_LIMIT = lowerArr;

		const powerOnArr = arr();
		powerOnArr[socketIdx] = u1(surplusDurState?.val);
		socketsPayload.POWER_ON_TIME = powerOnArr;

		const timeLimitArr = arr();
		timeLimitArr[socketIdx] = u1(socketDurState?.val);
		socketsPayload.TIME_LIMIT = timeLimitArr;

		const switchHourArr = arr();
		switchHourArr[socketIdx] = u8n(hourState?.val);
		socketsPayload.SWITCH_ON_HOUR = switchHourArr;

		const switchMinArr = arr();
		switchMinArr[socketIdx] = u8n(minuteState?.val);
		socketsPayload.SWITCH_ON_MINUTE = switchMinArr;

		const payload = JSON.stringify({ SOCKETS: socketsPayload });
		this.log.debug(`Socket control payload: ${payload}`);
		await this.localSendControl(stateId, payload, `applying socket ${socketIdx} changes`);

		// Ack control states with the values we just sent
		await this.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
		await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
			val: Number(onThreshState?.val) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
			val: Number(offThreshState?.val) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
			val: Number(surplusDurState?.val) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
			val: Number(socketDurState?.val) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: Number(hourState?.val) || 0, ack: true });
		await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: Number(minuteState?.val) || 0, ack: true });
		await this.setState(`${pfx}.Apply`, { val: false, ack: true });
		this.log.info(`Socket ${socketIdx} changes applied via local`);
	}

	/**
	 * Create control datapoints for switchable sockets.
	 * Called once after the first local poll reveals NUMBER_OF_SOCKETS.
	 */
	async localCreateSocketControls() {
		if (this.socketControlsCreated || !this.socketCount || this.socketCount <= 0) {
			return;
		}
		if (!this.config.control_active || this.config.control_sockets_connector !== "local") {
			return;
		}

		for (let i = 0; i < this.socketCount; i++) {
			await this.createSocketControlsForIndex(i);
		}
		await this.subscribeStatesAsync("control.Sockets.*");
		this.socketControlsCreated = true;
		this.log.info(`Created control datapoints for ${this.socketCount} socket(s)`);
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
		const channels = await this.getChannelsOfAsync("control");
		if (!channels) {
			return;
		}
		for (const ch of channels) {
			if (ch._id && ch._id.includes(pattern)) {
				const states = await this.getStatesOfAsync(ch._id.replace(`${this.namespace}.`, ""));
				if (states) {
					for (const state of states) {
						await this.delObjectAsync(state._id);
					}
				}
				await this.delObjectAsync(ch._id);
				this.log.debug(`Cleaned up ${label} control channel: ${ch._id}`);
			}
		}
	}

	async localCleanupSocketControls() {
		await this.cleanupControlChannels(".control.Sockets.", "socket");
	}

	/**
	 * Discover device capabilities and sync all control datapoints.
	 * Called after each low-priority local poll.
	 *
	 * @param {object} obj - The full parsed poll response
	 */
	async localDiscoverAndSyncControls(obj) {
		// Sockets
		if (obj.SOCKETS) {
			if (this.socketCount === undefined && typeof obj.SOCKETS.NUMBER_OF_SOCKETS === "number") {
				this.socketCount = obj.SOCKETS.NUMBER_OF_SOCKETS;
				this.log.debug(`Detected ${this.socketCount} socket(s)`);
				if (
					this.socketCount > 0 &&
					this.config.control_active &&
					this.config.control_sockets_connector === "local"
				) {
					await this.localCreateSocketControls();
				}
				if (this.socketCount === 0) {
					await this.localCleanupSocketControls();
				}
			}
			if (this.config.control_sockets_connector === "local") {
				await this.localSyncSocketControls(obj.SOCKETS);
			}
		}

		// Wallboxes
		if (obj.WIZARD && obj.WALLBOX) {
			if (this.wallboxCount === undefined && typeof obj.WIZARD.SETUP_NUMBER_WALLBOXES === "number") {
				this.wallboxCount = obj.WIZARD.SETUP_NUMBER_WALLBOXES;
				this.log.debug(`Detected ${this.wallboxCount} wallbox(es)`);
				if (
					this.wallboxCount > 0 &&
					this.config.control_active &&
					this.config.control_wallbox_connector === "local"
				) {
					await this.localCreateWallboxControls();
				}
				if (this.wallboxCount === 0) {
					await this.localCleanupWallboxControls();
				}
			}
			if (this.config.control_wallbox_connector === "local") {
				await this.localSyncWallboxControls(obj.WALLBOX);
			}
		}
	}

	/**
	 * Sync socket control datapoints with values read from the device.
	 *
	 * @param {object} socketsData - The SOCKETS section from the poll response
	 */
	async localSyncSocketControls(socketsData) {
		if (!this.socketControlsCreated || !socketsData) {
			return;
		}

		for (let i = 0; i < this.socketCount; i++) {
			const pfx = `control.Sockets.${i}`;
			const getArr = (key) =>
				Array.isArray(socketsData[key]) && socketsData[key][i] !== undefined ? socketsData[key][i] : undefined;

			// Translate Enable/ForceOn/UseTime → Mode
			const enable = getArr("ENABLE");
			const forceOn = getArr("FORCE_ON");
			if (enable !== undefined || forceOn !== undefined) {
				let mode = "OFF";
				if (forceOn) {
					mode = "PERMANENT_ON";
				} else if (enable) {
					mode = "AUTOMATIC";
				}
				await this.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
			}

			// Translate thresholds and durations
			const upper = getArr("UPPER_LIMIT");
			if (upper !== undefined) {
				await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, { val: upper, ack: true });
			}
			const lower = getArr("LOWER_LIMIT");
			if (lower !== undefined) {
				await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, { val: lower, ack: true });
			}
			const powerOnTime = getArr("POWER_ON_TIME");
			if (powerOnTime !== undefined) {
				await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
					val: powerOnTime,
					ack: true,
				});
			}
			const timeLimit = getArr("TIME_LIMIT");
			if (timeLimit !== undefined) {
				await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, { val: timeLimit, ack: true });
			}
			const switchHour = getArr("SWITCH_ON_HOUR");
			if (switchHour !== undefined) {
				await this.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: switchHour, ack: true });
			}
			const switchMin = getArr("SWITCH_ON_MINUTE");
			if (switchMin !== undefined) {
				await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: switchMin, ack: true });
			}
		}
	}

	/**
	 * Handle a wallbox control state change.
	 *
	 * @param {string} stateId - The full state id
	 * @param {number} wbIdx - Wallbox index (0-based)
	 * @param {string} field - The control field name
	 * @param {boolean | number | string} value - The value to set
	 */
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
		if (this.wallboxCount === undefined || wbIdx >= this.wallboxCount) {
			this.log.warn(`Wallbox ${wbIdx} does not exist (device has ${this.wallboxCount ?? 0} wallboxes)`);
			return;
		}

		// Non-Apply fields: just store the pending value (no ack)
		if (field !== "Apply") {
			this.log.debug(`Wallbox ${wbIdx}: pending ${field} = ${value}`);
			return;
		}

		// Apply: read all pending values and send each to device
		if (!value) {
			return;
		}

		const fieldMap = {
			SetIcmax: { key: "SET_ICMAX", type: "fl", bool: false },
			SetIdefault: { key: "SET_IDEFAULT", type: "fl", bool: false },
			MinChargingCurrent: { key: "MIN_CHARGING_CURRENT", type: "fl", bool: false },
			SmartChargeActive: { key: "SMART_CHARGE_ACTIVE", type: "u8", bool: true, onValue: "03" },
			// Note: ALLOW_INTERCHARGE may be a single value (not array) on some devices.
			// The array payload should still work; sync handles non-array gracefully.
			AllowIntercharge: { key: "ALLOW_INTERCHARGE", type: "u8", bool: true },
		};

		const pfx = `control.Wallbox.${wbIdx}`;
		this.log.info(`Applying wallbox ${wbIdx} changes...`);

		// Build one combined payload with all changed fields
		const wallboxPayload = {};
		for (const [fieldName, mapping] of Object.entries(fieldMap)) {
			const state = await this.getStateAsync(`${pfx}.${fieldName}`);
			if (!state || state.ack) {
				continue; // Skip fields that haven't been changed (still acked)
			}
			const val = state.val;

			const arr = Array.from({ length: 4 }, () => "");
			if (mapping.bool) {
				const onVal = mapping.onValue || "01";
				arr[wbIdx] = `${mapping.type}_${val ? onVal : "00"}`;
			} else if (mapping.type === "fl") {
				const buf = Buffer.alloc(4);
				buf.writeFloatBE(parseFloat(String(val)), 0);
				arr[wbIdx] = `fl_${buf.toString("hex").toUpperCase()}`;
			} else {
				const numVal = typeof val === "number" ? val : parseInt(String(val), 10);
				if (isNaN(numVal) || numVal < 0) {
					this.log.warn(`Invalid value for wallbox control ${fieldName}: ${val}`);
					continue;
				}
				const padLen = mapping.type === "u1" ? 4 : 2;
				arr[wbIdx] = `${mapping.type}_${numVal.toString(16).toUpperCase().padStart(padLen, "0")}`;
			}
			wallboxPayload[mapping.key] = arr;
			this.log.info(`Wallbox ${wbIdx} ${fieldName} = ${val}`);
		}

		if (Object.keys(wallboxPayload).length > 0) {
			const payload = JSON.stringify({ WALLBOX: wallboxPayload });
			this.log.debug(`Wallbox control payload: ${payload}`);
			await this.localSendControl(stateId, payload, `applying wallbox ${wbIdx} changes`);
		} else {
			this.log.debug(`Wallbox ${wbIdx}: no pending changes to apply`);
		}

		await this.setState(`${pfx}.Apply`, { val: false, ack: true });
		this.log.info(`Wallbox ${wbIdx} changes applied`);
	}

	/**
	 * Create control datapoints for wallboxes.
	 * Called once after the first local poll reveals wallbox data.
	 */
	async localCreateWallboxControls() {
		if (this.wallboxControlsCreated || !this.wallboxCount || this.wallboxCount <= 0) {
			return;
		}
		if (!this.config.control_active || this.config.control_wallbox_connector !== "local") {
			return;
		}

		const numStates = [
			{ id: "SetIcmax", name: "Max charging current", unit: "A", role: "level" },
			{ id: "SetIdefault", name: "Default charging current", unit: "A", role: "level" },
			{ id: "MinChargingCurrent", name: "Min charging current", unit: "A", role: "level" },
		];
		const boolStates = [
			{ id: "SmartChargeActive", name: "Smart charge active", role: "switch" },
			{ id: "AllowIntercharge", name: "Allow intercharge", role: "switch" },
		];

		for (let i = 0; i < this.wallboxCount; i++) {
			const ch = `control.Wallbox.${i}`;
			await this.setObjectNotExistsAsync(ch, {
				type: "channel",
				common: { name: `Wallbox ${i}` },
				native: {},
			});

			for (const s of boolStates) {
				await this.setObjectNotExistsAsync(`${ch}.${s.id}`, {
					type: "state",
					common: {
						name: s.name,
						type: "boolean",
						role: s.role,
						read: true,
						write: true,
						def: false,
					},
					native: {},
				});
			}

			for (const s of numStates) {
				await this.setObjectNotExistsAsync(`${ch}.${s.id}`, {
					type: "state",
					common: {
						name: s.name,
						type: "number",
						role: s.role,
						unit: s.unit,
						read: true,
						write: true,
						def: 0,
					},
					native: {},
				});
			}
		}

		// Apply button per wallbox
		for (let i = 0; i < this.wallboxCount; i++) {
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

		this.wallboxControlsCreated = true;
		this.log.info(`Created control datapoints for ${this.wallboxCount} wallbox(es)`);
	}

	/**
	 * Sync wallbox control datapoints with values read from the device.
	 *
	 * @param {object} wallboxData - The WALLBOX section from the poll response
	 */
	async localSyncWallboxControls(wallboxData) {
		if (!this.wallboxControlsCreated || !wallboxData) {
			return;
		}

		const syncMap = {
			SET_ICMAX: { field: "SetIcmax", bool: false },
			SET_IDEFAULT: { field: "SetIdefault", bool: false },
			MIN_CHARGING_CURRENT: { field: "MinChargingCurrent", bool: false },
			SMART_CHARGE_ACTIVE: { field: "SmartChargeActive", bool: true },
			ALLOW_INTERCHARGE: { field: "AllowIntercharge", bool: true },
		};

		for (let i = 0; i < this.wallboxCount; i++) {
			for (const [deviceKey, mapping] of Object.entries(syncMap)) {
				if (wallboxData[deviceKey] === undefined) {
					continue;
				}
				let rawVal;
				if (Array.isArray(wallboxData[deviceKey])) {
					rawVal = wallboxData[deviceKey][i];
				} else if (i === 0) {
					// Some fields (e.g. ALLOW_INTERCHARGE) may be a single value, not an array
					rawVal = wallboxData[deviceKey];
				}
				if (rawVal === undefined) {
					continue;
				}
				const val = mapping.bool ? !!rawVal : rawVal;
				await this.setStateChangedAsync(`control.Wallbox.${i}.${mapping.field}`, {
					val: val,
					ack: true,
				});
			}
		}
	}

	/**
	 * Remove leftover wallbox control datapoints when no wallboxes are available.
	 */
	async localCleanupWallboxControls() {
		await this.cleanupControlChannels(".control.Wallbox.", "wallbox");
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
		this.highPrioObjects.clear();
		// creating form for low priority pulling (which means pulling everything we know)
		// we can do this while preparing values for high prio
		this.lowPrioForm = "{";
		for (const value of allKnownObjects) {
			this.lowPrioForm += `"${value}":{},`;
			const objectsSet = new Set();
			switch (value) {
				case "BMS":
					[
						"CELL_TEMPERATURES_MODULE_A",
						"CELL_TEMPERATURES_MODULE_B",
						"CELL_TEMPERATURES_MODULE_C",
						"CELL_TEMPERATURES_MODULE_D",
						"CELL_VOLTAGES_MODULE_A",
						"CELL_VOLTAGES_MODULE_B",
						"CELL_VOLTAGES_MODULE_C",
						"CELL_VOLTAGES_MODULE_D",
						"CURRENT",
						"SOC",
						"SYSTEM_SOC",
						"TEMP_MAX",
						"TEMP_MIN",
						"VOLTAGE",
					].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_BMS_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_BMS);
					}
					break;
				case "ENERGY":
					[
						"STAT_STATE",
						"GUI_BAT_DATA_POWER",
						"GUI_INVERTER_POWER",
						"GUI_HOUSE_POW",
						"GUI_GRID_POW",
						"GUI_BAT_DATA_FUEL_CHARGE",
						"GUI_CHARGING_INFO",
						"GUI_BOOSTING_INFO",
						"GUI_BAT_DATA_POWER",
						"GUI_BAT_DATA_VOLTAGE",
						"GUI_BAT_DATA_CURRENT",
						"GUI_BAT_DATA_FUEL_CHARGE",
						"GUI_BAT_DATA_OA_CHARGING",
						"STAT_LIMITED_NET_SKEW",
						"SAFE_CHARGE_FORCE",
						"SAFE_CHARGE_PROHIBIT",
						"SAFE_CHARGE_RUNNING",
					].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_ENERGY_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_ENERGY);
					}
					break;
				case "PV1":
					["POWER_RATIO", "MPP_POWER"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PV1_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_PV1);
					}
					break;
				case "PWR_UNIT":
					["POWER_L1", "POWER_L2", "POWER_L3"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PWR_UNIT_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_PWR_UNIT);
					}
					break;
				case "PM1OBJ1":
					["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PM1OBJ1_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ1);
					}
					break;
				case "PM1OBJ2":
					["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PM1OBJ2_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ2);
					}
					break;
				case "WALLBOX":
					if (this.config.disclaimer && this.config.highPrio_WALLBOX_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_WALLBOX);
					}
					break;
				case "BAT1":
					if (this.config.disclaimer && this.config.highPrio_BAT1_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_BAT1);
					}
					break;
				case "BAT1OBJ1":
					if (this.config.disclaimer && this.config.highPrio_BAT1OBJ1_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_BAT1OBJ1);
					}
					break;
				case "TEMPMEASURE":
					if (this.config.disclaimer && this.config.highPrio_TEMPMEASURE_active) {
						this.addUserDps(value, objectsSet, this.config.highPrio_TEMPMEASURE);
					}
					break;
				case "SYS_UPDATE":
					["USER_REBOOT_DEVICE"].forEach((item) => objectsSet.add(item));
					break;
				default:
					// nothing to do here
					break;
			}
			if (objectsSet.size > 0) {
				this.highPrioObjects.set(value, objectsSet);
			}
		}

		this.lowPrioForm = `${this.lowPrioForm.slice(0, -1)}}`;
		this.log.debug(`(localInitPollSettings) lowPrio: ${this.lowPrioForm}`);

		// creating form for high priority pulling
		if (this.highPrioObjects.size > 0) {
			this.highPrioForm = "{";
			this.highPrioObjects.forEach((mapValue, key) => {
				this.highPrioForm += `"${key}":{`;
				mapValue.forEach((setValue) => {
					this.highPrioForm += `"${setValue}":"",`;
				});
				this.highPrioForm = `${this.highPrioForm.slice(0, -1)}},`;
			});
			this.highPrioForm = `${this.highPrioForm.slice(0, -1)}}`;
		} else {
			this.highPrioForm = "{}";
		}
		this.log.debug(`(localInitPollSettings) highPrio: ${this.highPrioForm}`);
	}

	addUserDps(value, objectsSet, dpToAdd) {
		if (dpToAdd.trim().length < 1 || !/^[A-Z0-9_,]*$/.test(dpToAdd.toUpperCase().trim())) {
			// don't accept anything but entries like DP_1,DP2,dp3
			this.log.warn(
				`(addUserDps) Datapoints config for ${
					value
				} doesn't follow [A-Z0-9_,] (no blanks allowed!) - Ignoring: ${dpToAdd.toUpperCase().trim()}`,
			);
			return;
		}
		dpToAdd
			.toUpperCase()
			.trim()
			.split(",")
			.forEach((item) => objectsSet.add(item));
		this.log.debug(`(addUserDps) Datapoints config changed for ${value}: ${dpToAdd.toUpperCase().trim()}`);
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
		const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
		const form = '{"ENERGY":{"STAT_STATE":""}}';
		try {
			this.log.info(`connecting to Senec (local): ${url}`);
			await this.localDoGet(url, form, this.config.pollingTimeout, true);
			this.log.info(`connected to Senec (local): ${url}`);
			this.lalaConnected = true;
		} catch (error) {
			throw new Error(
				`Error connecting to Senec (IP: ${this.connectVia}${this.config.senecip}). Exiting! (${
					error
				}). Check FQDN of SENEC appliance.`,
			);
		}
	}

	/**
	 * Discover available sections from the device via lala.cgi.
	 * Posts {"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}} and merges any
	 * newly discovered section names into allKnownObjects.
	 * Results are stored in the info.discoveredSections datapoint.
	 */
	async localDiscoverSections() {
		const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
		const form = '{"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}}';

		try {
			this.log.info("Discovering available sections from device...");
			const raw = await this.localDoGet(url, form, this.config.pollingTimeout, true);
			if (!raw) {
				throw new Error("Empty response from section discovery");
			}

			const data = JSON.parse(raw);
			const discovered = new Set();

			// DEBUG.SECTIONS and PLAIN.SECTIONS contain arrays of section names prefixed with "st_"
			for (const group of ["DEBUG", "PLAIN"]) {
				if (data[group] && Array.isArray(data[group].SECTIONS)) {
					for (const entry of data[group].SECTIONS) {
						const name = typeof entry === "string" && entry.startsWith("st_") ? entry.substring(3) : entry;
						if (name && typeof name === "string") {
							discovered.add(name);
						}
					}
				}
			}

			// Find sections that are new (not in allKnownObjects, not deprecated)
			const newSections = [];
			for (const section of discovered) {
				if (!allKnownObjects.has(section) && !deprecatedSections.has(section)) {
					allKnownObjects.add(section);
					newSections.push(section);
				}
			}

			// Remove hardcoded sections that the device does not have
			for (const section of [...allKnownObjects]) {
				if (!discovered.has(section)) {
					allKnownObjects.delete(section);
				}
			}

			// Find hardcoded sections that the device does not have
			const unavailable = [];
			for (const section of [...allKnownObjects]) {
				if (!discovered.has(section)) {
					unavailable.push(section);
				}
			}

			if (newSections.length > 0) {
				this.log.info(`Discovered ${newSections.length} new section(s): ${newSections.join(", ")}`);
			}
			if (unavailable.length > 0) {
				this.log.info(
					`Found ${unavailable.length} stale section(s) in ioBroker not on device: ${unavailable.join(", ")}`,
				);
			}
			if (newSections.length === 0 && unavailable.length === 0) {
				this.log.info("Section discovery complete. Device matches existing sections.");
			}

			await this.doState(
				"info.discoveredSections",
				newSections.length > 0 ? JSON.stringify(newSections) : "none",
				"Sections discovered beyond hardcoded list",
				"",
				false,
				false,
			);
			await this.doState(
				"info.unavailableSections",
				unavailable.length > 0 ? JSON.stringify(unavailable) : "none",
				"Stale sections in ioBroker that the device no longer provides",
				"",
				false,
				false,
			);
		} catch (error) {
			this.log.warn(`Section discovery failed (device may restrict access): ${error.message}`);
			await this.doState(
				"info.discoveredSections",
				`error: ${error.message}`,
				"Sections discovered beyond hardcoded list",
				"",
				false,
				false,
			);
		}
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
	 */
	async apiLogin() {
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
					loginRes.status === 200
						? "Login failed: no redirect."
						: `Login unexpected State: ${loginRes.status}`,
				);
			}

			const authCode = new URL(redirectLocation.replace("senec-app-auth://", "https://")).searchParams.get(
				"code",
			);
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
	 */
	scheduleTokenRefresh() {
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

	async apiRefreshToken() {
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
	 */
	async apiPoll() {
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
	 */
	apiScheduleNextPoll(delay) {
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
	 */
	apiBuildPollContext() {
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
	 */
	async apiEnsureSystemsLoaded() {
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
	 */
	async apiRunPollCycle() {
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
	 */
	async apiPollSingleSystem(anlagenId, ctx, rebuildAlreadyExecuted) {
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
	 */
	async apiPollDashboard(anlagenId) {
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
	 */
	async _apiPollEndpoint(anlagenId, url, evalPrefix, pollName) {
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
	 */
	async apiPollOnlineState(anlagenId) {
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
	 */
	async apiPollSystemStatus(anlagenId) {
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
	 */
	async apiPollSystemDetails(anlagenId) {
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
	 */
	async apiPollAbilities(anlagenId) {
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
					await this.doState(
						`${pfx}${pkg}`,
						res.data.packageTypes.includes(pkg),
						`Feature: ${pkg}`,
						"",
						false,
					);
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
	 */
	async apiPollForecastChargingSettings(anlagenId) {
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
	 */
	async apiPollWallboxSearch(anlagenId) {
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
	 */
	async apiCreateWallboxControls() {
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
	 */
	async apiSyncWallboxControls() {
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
	 */
	async apiHandleWallboxControl(wbIdx, field, value) {
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
						pendingAllowIntercharge != null
							? !!pendingAllowIntercharge
							: (settings.allowIntercharge ?? false),
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
	 */
	async apiPollDataAvailability(anlagenId) {
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
			await this.updateLastPoll(
				`${API_PFX}info.lastPoll.DataAvailability`,
				"Last successful DataAvailability poll",
			);
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
	 */
	async _runMeasurementTasks(anlagenId, tasks, pollName, beforeLastPoll) {
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
	 */
	async apiPollDetails(anlagenId, ctx) {
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
	 */
	async apiPollHeavy(anlagenId, ctx) {
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
	apiMergeSystemPollResult(total, single) {
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
	 */
	apiFinalizePollTimestamps(result) {
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
	 */
	async _apiRequest(method, url, data, config = {}) {
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
	 */
	async apiGet(url, config = {}) {
		return this._apiRequest("get", url, undefined, config);
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
		return this._apiRequest("post", url, data, config);
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
		return this._apiRequest("patch", url, data, config);
	}

	/**
	 * Performs the rebuild of the all-time history for a given system (Anlage).
	 *
	 * @param {string} anlagenId - The ID of the system (Anlage) for which to perform the rebuild
	 * @returns {Promise<void>} Resolves when the current rebuild batch is done
	 */
	async doRebuild(anlagenId) {
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
		if (!this.localClient) {
			throw new Error("Local client not initialized");
		}

		this.log.debug(`Calling: ${pUrl}`);

		try {
			const response = await this.localClient({
				method: isPost ? "post" : "get",
				url: pUrl,
				data: pForm,
				timeout: pollingTimeout,
			});

			const content = response.data;
			this.log.silly(`(Poll) received data (${response.status}): ${JSON.stringify(content)}`);

			return JSON.stringify(content);
		} catch (error) {
			if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
				this.log.debug("Request aborted (adapter shutdown)");
				return ""; // sauberer Rückgabewert bei Abbruch, damit wir nicht in der Fehlerbehandlung landen und ggf. neue Polls planen - bei Abbruch wollen wir ja eigentlich nur still stoppen
			}
			if (error.response) {
				this.log.warn(
					`(Poll) received error ${
						error.response.status
					} response from SENEC with content: ${JSON.stringify(error.response.data)}`,
				);
				throw new Error(`HTTP ${error.response.status}`);
			} else if (error.request) {
				this.log.info(error.message);
				throw new Error(error.message);
			} else {
				this.log.info(error.message);
				throw new Error(error?.message || "Unknown local request error");
			}
		}
	}

	/**
	 * Read values from Senec Home V2.1
	 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often.
	 * Adverse effects: No sync with Senec possible if called too often.
	 *
	 * @param isHighPrio high priority poll
	 * @param retry retry count
	 */

	// ── mein-senec.de Debug Probe ──────────────────────────────────────────

	/**
	 * Initialize mein-senec.de: authenticate, discover system, detect features, start polling.
	 */
	async webInit() {
		const WEB_BASE = WEB_HOST;

		// Step 1: Web login
		this.webAuthenticated = await this.webLogin();
		if (!this.webAuthenticated) {
			this.log.warn("mein-senec.de: Web login failed. Check credentials.");
			return;
		}

		// Step 2: Discover customer + system
		let systemCount = 1;
		try {
			const custRes = await this.webGet(`${WEB_BASE}/endkunde/api/context/getEndkunde`);
			if (custRes?.data && typeof custRes.data === "object") {
				await this.evalPoll(custRes.data, "_meinsenec.Customer.");
				systemCount = custRes.data.anzahlAnlagen || 1;
				this.log.info(`mein-senec.de: Customer devNumber=${custRes.data.devNumber}, systems=${systemCount}`);
			}
		} catch (error) {
			this.logError(error, "mein-senec.de: Failed to get customer info");
		}

		// Iterate systems to find our master and discover abilities
		for (let plantNum = 0; plantNum < systemCount; plantNum++) {
			try {
				const sysRes = await this.webGet(
					`${WEB_BASE}/endkunde/api/context/getAnlageBasedNavigationViewModel?anlageNummer=${plantNum}`,
				);
				if (!sysRes?.data || typeof sysRes.data !== "object") {
					break;
				}
				const sys = sysRes.data;
				if (!sys.master) {
					continue;
				}

				this.webMasterPlantNumber = plantNum;
				this.log.info(
					`mein-senec.de: Found system ${plantNum}: ${sys.produktName} (${sys.steuereinheitnummer})`,
				);

				// Store feature visibility flags
				this.webAbilities = {
					peakShaving: !!sys.peakShavingVisible,
					sockets: !!sys.steckdosenVisible,
					socketsEnabled: !!sys.steckdosenEnabled,
					sgReady: !!sys.sgReadyVisible,
					wallbox: !!sys.wallboxVisible,
					heatingRod: !!sys.heizstaebeVisible,
					autarky: !!sys.autarkieVisible,
					battery: !!sys.akkuVisible,
				};

				await this.evalPoll(sys, "_meinsenec.System.");
				for (const [key, val] of Object.entries(this.webAbilities)) {
					await this.doState(`_meinsenec.info.abilities.${key}`, val, `Feature: ${key}`, "", false);
				}

				this.log.info(`mein-senec.de: Abilities: ${JSON.stringify(this.webAbilities)}`);
				break;
			} catch (error) {
				this.logError(error, `mein-senec.de: Failed to get system ${plantNum}`);
				break;
			}
		}

		if (this.webMasterPlantNumber === null) {
			this.log.warn("mein-senec.de: No master system found.");
			return;
		}

		// Step 3: Create controls (if enabled) & start polling
		if (this.config.control_web_active) {
			await this.webCreateControls();
		}
		this.webConnected = true;
		this.webPoll().catch((e) => this.logError(e, "❌ mein-senec.de initial poll failed"));
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
		const label = method.toUpperCase();
		this.log.debug(`mein-senec.de ${label}: ${url}`);

		const baseConfig = { jar: this.webJar, maxRedirects: 5 };
		const headers = method === "post" && data !== undefined ? { "Content-Type": "application/json" } : undefined;
		const config = { ...baseConfig, validateStatus: () => true, ...(headers ? { headers } : {}) };

		const res =
			method === "get" ? await this.authClient.get(url, config) : await this.authClient.post(url, data, config);

		if (this.config.api_reqnresp_log) {
			this.log.debug(`mein-senec.de ${label} response: HTTP ${res.status} → ${JSON.stringify(res.data)}`);
		} else {
			this.log.debug(`mein-senec.de ${label} response: HTTP ${res.status}`);
		}

		if (res.status === 200 && typeof res.data === "string" && res.data.includes("Login - SENEC")) {
			this.log.debug("mein-senec.de: Session expired, re-authenticating...");
			this.webAuthenticated = await this.webLogin();
			if (!this.webAuthenticated) {
				throw new Error("mein-senec.de re-authentication failed");
			}
			return method === "get"
				? this.authClient.get(url, baseConfig)
				: this.authClient.post(url, data, baseConfig);
		}
		return res;
	}

	/**
	 * GET request to mein-senec.de with auto re-auth on session expiry.
	 *
	 * @param {string} url - URL to request
	 * @returns {Promise<object>} axios response
	 */
	async webGet(url) {
		return this._webRequest("get", url);
	}

	/**
	 * POST request to mein-senec.de with auto re-auth on session expiry.
	 *
	 * @param {string} url - URL to request
	 * @param {object} [data] - Optional JSON body
	 * @returns {Promise<object>} axios response
	 */
	async webPost(url, data) {
		return this._webRequest("post", url, data);
	}

	/**
	 * Poll mein-senec.de for status, spare capacity, peak shaving, SG-Ready.
	 * Self-scheduling poll loop.
	 */
	async webPoll() {
		if (this.unloaded || !this.webConnected || this.webMasterPlantNumber === null) {
			return;
		}

		const WEB_BASE = WEB_HOST;
		const pn = this.webMasterPlantNumber;
		const now = Date.now();

		try {
			this.log.debug("🔄 Polling mein-senec.de...");

			// Status overview — every poll
			try {
				const res = await this.webGet(
					`${WEB_BASE}/endkunde/api/status/getstatusoverview.php?anlageNummer=${pn}`,
				);
				if (res?.data && typeof res.data === "object") {
					await this.evalPoll(res.data, "_meinsenec.Status.");
					await this.updateLastPoll("_meinsenec.info.lastPoll.Status", "Last status poll");
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: Status poll failed");
			}

			// Emergency power reserve — every 6h
			if (!this._webLastEmergencyPowerPoll || now - this._webLastEmergencyPowerPoll >= this.webMediumIntervalMs) {
				try {
					const res = await this.webGet(
						`${WEB_BASE}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`,
					);
					if (res?.data !== undefined) {
						const val = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
						if (!isNaN(val)) {
							await this.doState(
								"_meinsenec.EmergencyPower.ReserveInPercent",
								val,
								"Emergency power reserve",
								"%",
								false,
							);
							this._webLastEmergencyPowerPoll = now;
							await this.updateLastPoll(
								"_meinsenec.info.lastPoll.EmergencyPower",
								"Last emergency power poll",
							);
							// Sync control datapoint
							await this.setStateChangedAsync("control.EmergencyPower.ReserveInPercent", {
								val: val,
								ack: true,
							});
						}
					}
				} catch (error) {
					this.logError(error, "mein-senec.de: Emergency power poll failed");
				}
			}

			// Peak shaving — daily
			if (
				this.webAbilities.peakShaving &&
				(!this._webLastPeakShavingPoll || now - this._webLastPeakShavingPoll >= this.webSlowIntervalMs)
			) {
				try {
					const res = await this.webGet(
						`${WEB_BASE}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`,
					);
					if (res?.data && typeof res.data === "object") {
						await this.evalPoll(res.data, "_meinsenec.PeakShaving.");
						this._webLastPeakShavingPoll = now;
						await this.updateLastPoll("_meinsenec.info.lastPoll.PeakShaving", "Last peak shaving poll");
						await this.webSyncPeakShavingControls(res.data);
					}
				} catch (error) {
					this.logError(error, "mein-senec.de: Peak shaving poll failed");
				}
			}

			// SG-Ready state — every 6h
			if (
				this.webAbilities.sgReady &&
				(!this._webLastSgReadyStatePoll || now - this._webLastSgReadyStatePoll >= this.webMediumIntervalMs)
			) {
				try {
					const res = await this.webGet(`${WEB_BASE}/endkunde/api/senec/${pn}/sgready/state`);
					if (res?.data !== undefined) {
						await this.doState("_meinsenec.SGReady.State", String(res.data), "SG-Ready state", "", false);
						this._webLastSgReadyStatePoll = now;
					}
				} catch (error) {
					this.logError(error, "mein-senec.de: SG-Ready state poll failed");
				}
			}

			// SG-Ready config — daily
			if (
				this.webAbilities.sgReady &&
				(!this._webLastSgReadyConfPoll || now - this._webLastSgReadyConfPoll >= this.webSlowIntervalMs)
			) {
				try {
					const res = await this.webGet(`${WEB_BASE}/endkunde/api/senec/${pn}/sgready/config`);
					if (res?.data && typeof res.data === "object") {
						await this.evalPoll(res.data, "_meinsenec.SGReady.Config.");
						this._webLastSgReadyConfPoll = now;
						await this.updateLastPoll(
							"_meinsenec.info.lastPoll.SGReadyConfig",
							"Last SG-Ready config poll",
						);
						await this.webSyncSGReadyControls(res.data);
					}
				} catch (error) {
					this.logError(error, "mein-senec.de: SG-Ready config poll failed");
				}
			}
		} catch (error) {
			this.logError(error, "❌ mein-senec.de poll cycle failed");
		}

		// Sockets via mein-senec.de — every 6h
		if (
			(this.webAbilities.sockets || this.config.control_sockets_force) &&
			(!this._webLastSocketsPoll || now - this._webLastSocketsPoll >= this.webMediumIntervalMs)
		) {
			try {
				const res = await this.webGet(
					`${WEB_BASE}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`,
				);
				if (res?.data && Array.isArray(res.data)) {
					this.webSocketData = res.data;
					if (
						this.config.control_web_active &&
						this.config.control_sockets_connector === "web" &&
						res.data.length > 0
					) {
						await this.webCreateSocketControls(res.data.length);
					}
					for (const socket of res.data) {
						const idx = socket.steckdosenummer ?? socket.steckdosennummer;
						if (idx === undefined) {
							continue;
						}
						// Strip steuereinheit metadata before evalPoll (same for all sockets)
						const { steuereinheit: _s, state: socketState, ...socketFields } = socket;
						await this.evalPoll(socketFields, `_meinsenec.Sockets.${idx}.`);
						if (socketState && typeof socketState === "object") {
							const { steuereinheit: _ss, ...stateFields } = socketState;
							await this.evalPoll(stateFields, `_meinsenec.Sockets.${idx}.State.`);
						}
						if (this.config.control_sockets_connector === "web") {
							await this.webSyncSocketControls(idx, socket);
						}
					}
					this._webLastSocketsPoll = now;
					await this.updateLastPoll("_meinsenec.info.lastPoll.Sockets", "Last sockets poll");
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: Sockets poll failed");
			}
		}

		if (!this.unloaded) {
			this.setTimeout(() => {
				this.webPoll().catch((e) => this.logError(e, "❌ mein-senec.de scheduled poll failed"));
			}, this.webStatusIntervalMs);
			this.log.debug(`⏱ Next mein-senec.de poll in ${(this.webStatusIntervalMs / 1000).toFixed(0)}s`);
		}
	}

	/**
	 * Create control datapoints for mein-senec.de features based on discovered abilities.
	 * Called once after webInit() discovers the system and its abilities.
	 */
	async webCreateControls() {
		// Emergency power reserve — always available
		await this.setObjectNotExistsAsync("control.EmergencyPower", {
			type: "channel",
			common: { name: "Emergency Power Reserve" },
			native: {},
		});
		await this.setObjectNotExistsAsync("control.EmergencyPower.ReserveInPercent", {
			type: "state",
			common: {
				name: "Reserve in percent",
				type: "number",
				role: "level",
				unit: "%",
				min: 0,
				max: 100,
				read: true,
				write: true,
				def: 0,
			},
			native: {},
		});

		// Peak shaving — only if available
		if (this.webAbilities.peakShaving) {
			await this.setObjectNotExistsAsync("control.PeakShaving", {
				type: "channel",
				common: { name: "Peak Shaving" },
				native: {},
			});
			await this.setObjectNotExistsAsync("control.PeakShaving.Mode", {
				type: "state",
				common: {
					name: "Peak shaving mode",
					type: "string",
					role: "text",
					read: true,
					write: true,
					def: "",
					states: { DEACTIVATED: "Deactivated", MANUAL: "Manual", AUTO: "Auto" },
				},
				native: {},
			});
			await this.setObjectNotExistsAsync("control.PeakShaving.CapacityLimit", {
				type: "state",
				common: {
					name: "Capacity limit",
					type: "number",
					role: "level",
					unit: "%",
					min: 0,
					max: 90,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync("control.PeakShaving.EndHour", {
				type: "state",
				common: {
					name: "End hour",
					type: "number",
					role: "level",
					min: 0,
					max: 23,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync("control.PeakShaving.EndMinute", {
				type: "state",
				common: {
					name: "End minute",
					type: "number",
					role: "level",
					min: 0,
					max: 59,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync("control.PeakShaving.Apply", {
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

		// SG-Ready — only if available
		if (this.webAbilities.sgReady) {
			await this.setObjectNotExistsAsync("control.SGReady", {
				type: "channel",
				common: { name: "SG-Ready" },
				native: {},
			});
			await this.setObjectNotExistsAsync("control.SGReady.Enabled", {
				type: "state",
				common: {
					name: "SG-Ready enabled",
					type: "boolean",
					role: "switch",
					read: true,
					write: true,
					def: false,
				},
				native: {},
			});
			const sgReadyNumStates = [
				{ id: "ModeChangeDelayInMinutes", name: "Mode change delay", unit: "min" },
				{ id: "PowerOnProposalThresholdInWatt", name: "Power-on proposal threshold", unit: "W" },
				{ id: "PowerOnCommandThresholdInWatt", name: "Power-on command threshold", unit: "W" },
				{ id: "ShutdownLevelInWatt", name: "Shutdown level", unit: "W" },
			];
			for (const s of sgReadyNumStates) {
				await this.setObjectNotExistsAsync(`control.SGReady.${s.id}`, {
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
			await this.setObjectNotExistsAsync("control.SGReady.Apply", {
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

		await this.subscribeStatesAsync("control.EmergencyPower.*");
		if (this.webAbilities.peakShaving) {
			await this.subscribeStatesAsync("control.PeakShaving.*");
		}
		if (this.webAbilities.sgReady) {
			await this.subscribeStatesAsync("control.SGReady.*");
		}
		this.log.info(
			`mein-senec.de: Created web controls (peakShaving=${this.webAbilities.peakShaving}, sgReady=${this.webAbilities.sgReady})`,
		);
	}

	/**
	 * Create web socket control datapoints after first socket poll.
	 * Called when sockets are discovered and connector is set to "web".
	 *
	 * @param {number} count - Number of sockets
	 */
	async webCreateSocketControls(count) {
		if (this.webSocketControlsCreated) {
			return;
		}
		for (let i = 0; i < count; i++) {
			await this.createSocketControlsForIndex(i);
		}
		await this.subscribeStatesAsync("control.Sockets.*");
		this.webSocketControlsCreated = true;
		this.log.info(`mein-senec.de: Created web socket controls for ${count} socket(s)`);
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
		const pn = this.webMasterPlantNumber;
		if (pn === null || pn === undefined) {
			this.log.warn("mein-senec.de: No master plant number, cannot send control command");
			return;
		}

		// Emergency power — direct send (single field, no Apply needed)
		if (subId === "EmergencyPower.ReserveInPercent") {
			const val = Math.round(Math.max(0, Math.min(100, Number(state.val) || 0)));
			this.log.info(`mein-senec.de: Setting emergency power reserve to ${val}%`);
			try {
				const postRes = await this.webPost(
					`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower?reserve-in-percent=${val}`,
				);
				if (postRes.status >= 400) {
					const errMsg = webApiErrorMsg(postRes);
					this.log.error(`mein-senec.de: Emergency power save failed (HTTP ${postRes.status}): ${errMsg}`);
					return;
				}
				// Re-read and sync back
				const res = await this.webGet(`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`);
				if (res?.data !== undefined) {
					const confirmed = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
					if (!isNaN(confirmed)) {
						await this.doState(
							"_meinsenec.EmergencyPower.ReserveInPercent",
							confirmed,
							"Emergency power reserve",
							"%",
							false,
						);
						await this.setStateAsync("control.EmergencyPower.ReserveInPercent", {
							val: confirmed,
							ack: true,
						});
					}
				}
				this.log.info(`mein-senec.de: Emergency power reserve set to ${val}%`);
			} catch (error) {
				this.logError(error, "mein-senec.de: Failed to set emergency power reserve");
			}
			return;
		}

		// Peak shaving — Apply button
		if (subId === "PeakShaving.Apply" && state.val) {
			await this.webHandlePeakShavingApply();
			return;
		}
		// Peak shaving field changes — just ack locally, wait for Apply
		if (subId.startsWith("PeakShaving.")) {
			return;
		}

		// SG-Ready — Apply button
		if (subId === "SGReady.Apply" && state.val) {
			await this.webHandleSGReadyApply();
			return;
		}
		// SG-Ready field changes — just ack locally, wait for Apply
		if (subId.startsWith("SGReady.")) {
			return;
		}

		this.log.warn(`mein-senec.de: Unknown web control: ${subId}`);
	}

	/**
	 * Apply pending peak shaving changes to mein-senec.de.
	 */
	async webHandlePeakShavingApply() {
		const pn = this.webMasterPlantNumber;
		const pfx = "control.PeakShaving";

		const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
		const capState = await this.getStateAsync(`${this.namespace}.${pfx}.CapacityLimit`);
		const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EndHour`);
		const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EndMinute`);

		const mode = String(modeState?.val || "").toUpperCase();
		const capacityLimit = Math.max(0, Math.min(90, Number(capState?.val) || 0));
		const endHour = Math.max(0, Math.min(23, Number(hourState?.val) || 0));
		const endMinute = Math.max(0, Math.min(59, Number(minuteState?.val) || 0));

		if (!mode) {
			this.log.warn("mein-senec.de: Peak shaving mode is empty, not applying");
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Construct UTC ms timestamp — API extracts hour/minute from UTC
		const now = new Date();
		const endzeitMs = String(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endHour, endMinute, 0, 0),
		);

		const params = new URLSearchParams({
			anlageNummer: String(pn),
			mode: mode,
			capacityLimit: String(capacityLimit),
			endzeit: endzeitMs,
		});

		this.log.info(
			`mein-senec.de: Applying peak shaving settings (mode=${mode}, cap=${capacityLimit}%, end=${endHour}:${String(endMinute).padStart(2, "0")})`,
		);
		try {
			const postRes = await this.webPost(
				`${WEB_HOST}/endkunde/api/peakshaving/saveSettings?${params.toString()}`,
			);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				this.log.error(`mein-senec.de: Peak shaving save failed (HTTP ${postRes.status}): ${errMsg}`);
				await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
				return;
			}

			// Re-read and sync back
			const res = await this.webGet(`${WEB_HOST}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`);
			if (res?.data && typeof res.data === "object") {
				await this.evalPoll(res.data, "_meinsenec.PeakShaving.");
				await this.webSyncPeakShavingControls(res.data);
			}
			this.log.info("mein-senec.de: Peak shaving settings applied");
		} catch (error) {
			this.logError(error, "mein-senec.de: Failed to apply peak shaving settings");
		}
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
	}

	/**
	 * Sync peak shaving control datapoints with values read from the portal.
	 *
	 * @param {object} data - Peak shaving settings from the API
	 */
	async webSyncPeakShavingControls(data) {
		const pfx = "control.PeakShaving";
		if (data.peakShavingMode !== undefined) {
			await this.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.peakShavingMode), ack: true });
		}
		if (data.peakShavingCapacityLimitInPercent !== undefined) {
			await this.setStateChangedAsync(`${pfx}.CapacityLimit`, {
				val: Number(data.peakShavingCapacityLimitInPercent),
				ack: true,
			});
		}
		if (Array.isArray(data.peakShavingLocalEndTime) && data.peakShavingLocalEndTime.length >= 2) {
			await this.setStateChangedAsync(`${pfx}.EndHour`, {
				val: Number(data.peakShavingLocalEndTime[0]) || 0,
				ack: true,
			});
			await this.setStateChangedAsync(`${pfx}.EndMinute`, {
				val: Number(data.peakShavingLocalEndTime[1]) || 0,
				ack: true,
			});
		}
	}

	/**
	 * Apply pending SG-Ready changes to mein-senec.de.
	 */
	async webHandleSGReadyApply() {
		const pn = this.webMasterPlantNumber;
		const pfx = "control.SGReady";

		// Build JSON body with only changed (unacked) fields
		const fieldMap = {
			Enabled: "enabled",
			ModeChangeDelayInMinutes: "modeChangeDelayInMinutes",
			PowerOnProposalThresholdInWatt: "powerOnProposalThresholdInWatt",
			PowerOnCommandThresholdInWatt: "powerOnCommandThresholdInWatt",
			ShutdownLevelInWatt: "shutdownLevelInWatt",
		};

		const body = {};
		for (const [stateKey, apiKey] of Object.entries(fieldMap)) {
			const s = await this.getStateAsync(`${this.namespace}.${pfx}.${stateKey}`);
			if (!s || s.ack) {
				continue; // Skip unchanged fields
			}
			body[apiKey] = s.val;
		}

		if (Object.keys(body).length === 0) {
			this.log.debug("mein-senec.de: SG-Ready — no pending changes to apply");
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		this.log.info(`mein-senec.de: Applying SG-Ready settings: ${JSON.stringify(body)}`);
		try {
			const postRes = await this.webPost(`${WEB_HOST}/endkunde/api/senec/${pn}/sgready`, body);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				this.log.error(`mein-senec.de: SG-Ready save failed (HTTP ${postRes.status}): ${errMsg}`);
				await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
				return;
			}

			// Re-read and sync back
			const res = await this.webGet(`${WEB_HOST}/endkunde/api/senec/${pn}/sgready/config`);
			if (res?.data && typeof res.data === "object") {
				await this.evalPoll(res.data, "_meinsenec.SGReady.Config.");
				await this.webSyncSGReadyControls(res.data);
			}
			this.log.info("mein-senec.de: SG-Ready settings applied");
		} catch (error) {
			this.logError(error, "mein-senec.de: Failed to apply SG-Ready settings");
		}
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
	}

	/**
	 * Sync SG-Ready control datapoints with values read from the portal.
	 *
	 * @param {object} data - SG-Ready config from the API
	 */
	async webSyncSGReadyControls(data) {
		const pfx = "control.SGReady";
		const syncMap = {
			enabled: { field: "Enabled" },
			modeChangeDelayInMinutes: { field: "ModeChangeDelayInMinutes" },
			powerOnProposalThresholdInWatt: { field: "PowerOnProposalThresholdInWatt" },
			powerOnCommandThresholdInWatt: { field: "PowerOnCommandThresholdInWatt" },
			shutdownLevelInWatt: { field: "ShutdownLevelInWatt" },
		};
		for (const [apiKey, mapping] of Object.entries(syncMap)) {
			if (data[apiKey] !== undefined) {
				await this.setStateChangedAsync(`${pfx}.${mapping.field}`, { val: data[apiKey], ack: true });
			}
		}
	}

	/**
	 * Sync web socket control datapoints with values read from the portal.
	 *
	 * @param {number} idx - Socket index
	 * @param {object} data - Socket data from the API
	 */
	async webSyncSocketControls(idx, data) {
		if (!this.webSocketControlsCreated) {
			return;
		}
		const pfx = `control.Sockets.${idx}`;
		if (data.name !== undefined) {
			await this.setStateChangedAsync(`${pfx}.Name`, { val: String(data.name), ack: true });
		}
		if (data.mode !== undefined) {
			await this.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.mode), ack: true });
		}
		if (data.einschaltschwelleInWatt !== undefined) {
			await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
				val: Number(data.einschaltschwelleInWatt),
				ack: true,
			});
		}
		if (data.abschaltschwelleInWatt !== undefined) {
			await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
				val: Number(data.abschaltschwelleInWatt),
				ack: true,
			});
		}
		if (data.dauerLeistungsueberschussInMin !== undefined) {
			await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
				val: Number(data.dauerLeistungsueberschussInMin),
				ack: true,
			});
		}
		if (data.dauerSteckdoseAnInMin !== undefined) {
			await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
				val: Number(data.dauerSteckdoseAnInMin),
				ack: true,
			});
		}
		if (Array.isArray(data.einschaltzeit) && data.einschaltzeit.length >= 2) {
			await this.setStateChangedAsync(`${pfx}.EinschaltHour`, {
				val: Number(data.einschaltzeit[0]) || 0,
				ack: true,
			});
			await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, {
				val: Number(data.einschaltzeit[1]) || 0,
				ack: true,
			});
		}
	}

	/**
	 * Handle a web socket control command (Apply button).
	 *
	 * @param {number} idx - Socket index
	 * @param {string} field - Field name (e.g. "Apply", "Mode")
	 * @param {object} state - ioBroker state object
	 */
	async webHandleSocketControl(idx, field, state) {
		// Only act on Apply button
		if (field !== "Apply" || !state.val) {
			return;
		}

		if (!this.webSocketData || !Array.isArray(this.webSocketData)) {
			this.log.warn("mein-senec.de: No socket data available, cannot apply changes");
			await this.setStateAsync(`control.Sockets.${idx}.Apply`, { val: false, ack: true });
			return;
		}

		const pn = this.webMasterPlantNumber;
		const pfx = `control.Sockets.${idx}`;

		// Read current control values
		const nameState = await this.getStateAsync(`${this.namespace}.${pfx}.Name`);
		const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
		const onThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltschwelleInWatt`);
		const offThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.AbschaltschwelleInWatt`);
		const surplusDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
		const socketDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerSteckdoseAnInMin`);
		const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltHour`);
		const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltMinute`);

		// Clone the full socket array and update the target socket
		const payload = JSON.parse(JSON.stringify(this.webSocketData));
		const socket = payload.find((s) => (s.steckdosenummer ?? s.steckdosennummer) === idx);
		if (!socket) {
			this.log.warn(`mein-senec.de: Socket ${idx} not found in stored data`);
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		if (nameState?.val !== undefined && nameState.val !== null) {
			socket.name = String(nameState.val);
		}
		socket.mode = String(modeState?.val || socket.mode);
		socket.einschaltschwelleInWatt = Number(onThreshState?.val) || 0;
		socket.abschaltschwelleInWatt = Number(offThreshState?.val) || 0;
		socket.dauerLeistungsueberschussInMin = Number(surplusDurState?.val) || 0;
		socket.dauerSteckdoseAnInMin = Number(socketDurState?.val) || 0;
		if (socket.mode === "AUTOMATIC") {
			socket.einschaltzeit = [Number(hourState?.val) || 0, Number(minuteState?.val) || 0];
		}

		this.log.info(`mein-senec.de: Applying socket ${idx} settings (mode=${socket.mode})`);
		try {
			const postRes = await this.webPost(`${WEB_HOST}/endkunde/api/steckdosen/save`, payload);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				this.log.error(`mein-senec.de: Socket save failed (HTTP ${postRes.status}): ${errMsg}`);
				await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
				return;
			}

			// Re-read and sync back
			const res = await this.webGet(`${WEB_HOST}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`);
			if (res?.data && Array.isArray(res.data)) {
				this.webSocketData = res.data;
				for (const s of res.data) {
					const sIdx = s.steckdosenummer ?? s.steckdosennummer;
					if (sIdx === undefined) {
						continue;
					}
					const { steuereinheit: _se, state: sState, ...sFields } = s;
					await this.evalPoll(sFields, `_meinsenec.Sockets.${sIdx}.`);
					if (sState && typeof sState === "object") {
						const { steuereinheit: _sse, ...sStateFields } = sState;
						await this.evalPoll(sStateFields, `_meinsenec.Sockets.${sIdx}.State.`);
					}
					await this.webSyncSocketControls(sIdx, s);
				}
			}
			this.log.info(`mein-senec.de: Socket ${idx} settings applied`);
		} catch (error) {
			this.logError(error, "mein-senec.de: Failed to apply socket settings");
		}
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
	}

	/**
	 * Perform web login to mein-senec.de via Keycloak SSO.
	 * Uses a dedicated cookie jar (webJar) separate from the App API jar.
	 *
	 * @returns {Promise<boolean>} true if login succeeded
	 */
	async webLogin() {
		const WEB_BASE = WEB_HOST;
		const email = this.config.api_mail;
		const password = this.config.api_pwd;

		if (!email || !password) {
			this.log.warn("mein-senec.de: No credentials configured (api_mail/api_pwd).");
			return false;
		}

		this.webJar = new CookieJar();

		try {
			// Step 1: GET mein-senec.de → follows redirects to SSO login form
			this.log.info("🔐 mein-senec.de: Requesting login page...");
			const pageRes = await this.authClient.get(WEB_BASE, {
				jar: this.webJar,
				maxRedirects: 10,
				validateStatus: () => true,
			});

			const html = typeof pageRes.data === "string" ? pageRes.data : "";
			const formAction = extractFormAction(html);

			if (!formAction) {
				// Maybe already authenticated?
				if (html.includes("ng-controller") || html.includes("endkunde")) {
					this.log.info("mein-senec.de: Already authenticated (no login form found).");
					return true;
				}
				this.log.warn("mein-senec.de: Could not find login form action URL.");
				this.log.debug(`🔍 Login page HTML (first 500 chars): ${html.slice(0, 500)}`);
				return false;
			}

			this.log.info("🔐 mein-senec.de: Found login form, posting credentials...");

			// Step 2: POST credentials to SSO form
			const loginRes = await this.authClient.post(
				formAction.replace(/&amp;/g, "&"),
				new URLSearchParams({ username: email, password: password }).toString(),
				{
					jar: this.webJar,
					maxRedirects: 10,
					validateStatus: () => true,
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
				},
			);

			const loginHtml = typeof loginRes.data === "string" ? loginRes.data : "";

			// Step 3: Check for TOTP/OTP form
			if (hasOtp(loginHtml)) {
				const totpSecret = this.config.api_totp_secret;
				if (!totpSecret) {
					this.log.warn("mein-senec.de: TOTP required but no TOTP secret configured.");
					return false;
				}

				const otpFormAction = extractFormAction(loginHtml);
				if (!otpFormAction) {
					this.log.warn("mein-senec.de: TOTP form found but no action URL.");
					return false;
				}

				const totpCode = generateTOTP(totpSecret);
				this.log.info("🔐 mein-senec.de: Submitting TOTP code...");

				const otpRes = await this.authClient.post(
					otpFormAction.replace(/&amp;/g, "&"),
					new URLSearchParams({ otp: totpCode }).toString(),
					{
						jar: this.webJar,
						maxRedirects: 10,
						validateStatus: () => true,
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
						},
					},
				);

				const otpHtml = typeof otpRes.data === "string" ? otpRes.data : "";
				if (otpHtml.includes("Login - SENEC") || extractFormAction(otpHtml)) {
					this.log.warn("mein-senec.de: TOTP login failed — still on login page.");
					return false;
				}
			} else if (loginHtml.includes("Login - SENEC") || (hasUsername(loginHtml) && hasPassword(loginHtml))) {
				this.log.warn("mein-senec.de: Login failed — still on login page. Check credentials.");
				return false;
			}

			// Step 4: Verify we're authenticated
			this.log.info("mein-senec.de: Login flow complete. Verifying session...");
			const verifyRes = await this.authClient.get(`${WEB_BASE}/endkunde/api/context/getEndkunde`, {
				jar: this.webJar,
				maxRedirects: 0,
				validateStatus: () => true,
			});

			if (verifyRes.status === 200 && typeof verifyRes.data === "object") {
				this.log.info(`✅ mein-senec.de: Authenticated successfully! devNumber: ${verifyRes.data.devNumber}`);
				return true;
			}

			this.log.warn(`mein-senec.de: Verification failed — HTTP ${verifyRes.status}`);
			return false;
		} catch (error) {
			this.log.warn(`mein-senec.de: Login error — ${error.message}`);
			return false;
		}
	}

	// ── SENEC.Connect Polling ──────────────────────────────────────────────

	/**
	 * Polls the SENEC.Connect API for device data.
	 * Uses subscription key authentication (Ocp-Apim-Subscription-Key header).
	 * All requested data sections are fetched in a single request via the include parameter.
	 */
	async connectPoll() {
		if (this.unloaded) {
			return;
		}

		const interval = (this.config.connect_interval || 300) * 1000;
		const include = this.config.connect_include || "battery,meter";
		const subscriptionKey = this.config.connect_subscription_key;

		if (!subscriptionKey) {
			this.log.warn("SENEC.Connect: No subscription key configured. Skipping poll.");
			return;
		}

		try {
			this.log.debug("🔄 Polling SENEC.Connect API...");

			const url = `${CONNECT_HOST}/v1/systems/device-data/general?include=${encodeURIComponent(include)}`;
			if (!this.connectClient) {
				this.connectClient = axios.create({
					timeout: this.config.pollingTimeout || 5000,
					headers: {
						"Ocp-Apim-Subscription-Key": subscriptionKey,
					},
				});
			}
			const response = await this.connectClient.get(url);

			this.log.debug(`SENEC.Connect response: ${JSON.stringify(response?.data).slice(0, 1000)}`);
			if (response?.data && Array.isArray(response.data)) {
				for (let i = 0; i < response.data.length; i++) {
					await this.evalPoll(response.data[i], `_connect.Systems.${i}.`);
				}
				await this.doState(
					"_connect.info.lastPoll",
					new Date().toISOString(),
					"Last successful SENEC.Connect poll",
					"",
					false,
				);
				this.log.debug(`SENEC.Connect: polled ${response.data.length} system(s)`);
			} else {
				this.log.warn(
					`SENEC.Connect: unexpected response format: ${JSON.stringify(response?.data).slice(0, 200)}`,
				);
			}
		} catch (error) {
			this.logError(error, "❌ SENEC.Connect poll failed");
		}

		if (!this.unloaded) {
			this.setTimeout(() => {
				this.connectPoll().catch((e) => this.logError(e, "❌ SENEC.Connect scheduled poll failed"));
			}, interval);
			this.log.debug(`⏱ Next SENEC.Connect poll scheduled in ${(interval / 1000).toFixed(0)}s`);
		}
	}

	// ── Local Polling ──────────────────────────────────────────────────────

	async localPoll(isHighPrio, retry) {
		const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
		let interval = this.config.interval * 1000;
		if (!isHighPrio) {
			this.log.info("LowPrio polling (local) ...");
			interval = this.config.intervalLow * 1000 * 60;
		}

		try {
			let body = await this.localDoGet(
				url,
				isHighPrio ? this.highPrioForm : this.lowPrioForm,
				this.config.pollingTimeout,
				true,
			);
			if (body.includes('\\"')) {
				// in rare cases senec reports back extra escape sequences on some machines ...
				this.log.debug(`(Poll) Double escapes detected!  Body inc: ${body}`);
				body = body.replace(/\\"/g, '"');
				this.log.debug(`(Poll) Double escapes autofixed! Body out: ${body}`);
			}

			if (!body) {
				if (!this.unloaded) {
					this.setTimeout(() => {
						this.localPoll(isHighPrio, retry).catch((e) =>
							this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
						);
					}, interval);
				}
				return;
			}

			const obj = JSON.parse(body, reviverNumParse);
			this.log.silly(`(Poll) Parsed object: ${JSON.stringify(obj)}`);
			await this.evalPoll(obj, "", "");

			// Discover and sync control states
			// Runs on every poll — sections may be in high-prio if user configured them there
			await this.localDiscoverAndSyncControls(obj);

			retry = 0;
			if (!this.unloaded) {
				this.setTimeout(() => {
					this.localPoll(isHighPrio, retry).catch((e) =>
						this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
					);
				}, interval);
				this.log.debug(
					`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(interval / 1000).toFixed(0)}s`,
				);
			}
		} catch (error) {
			if (retry == this.config.retries && this.config.retries < 999) {
				this.logError(
					error,
					`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retried ${
						retry
					} times. Giving up now. Check config and restart adapter. (${error})`,
				);
				await this.setState("info.connection", false, true);
			} else {
				retry += 1;
				const delay = interval * this.config.retrymultiplier * retry;
				this.log.warn(
					`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retry ${
						retry
					}/${this.config.retries} in ${delay / 1000} seconds! (${error})`,
				);
				if (!this.unloaded) {
					this.setTimeout(() => {
						this.localPoll(isHighPrio, retry).catch((e) =>
							this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
						);
					}, delay);
					this.log.debug(
						`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(delay / 1000).toFixed(0)}s`,
					);
				}
			}
		}
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
	 */
	async insertIntoAllTimeValueStore(sums, anlagenId, year) {
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

	getRebuildStartYear() {
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
	 */
	async updateAllTimeHistory(anlagenId) {
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
	 */
	logApiQueueRecommendationIfChanged() {
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
	 */
	logApiQueueStatsIfChanged() {
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
	 */
	apiMarkPollTimestamp(type) {
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
		return `${anlagenId}:${year}:${monthly ? "monthly" : "year"}`;
	}

	/**
	 * @param {string} anlagenId - System id
	 */
	getAllRebuildStepsForSystem(anlagenId) {
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

	getTotalRebuildStepsPerSystem() {
		const currentYear = new Date().getUTCFullYear();
		const startYear = this.getRebuildStartYear();
		const yearCount = currentYear - startYear + 1;
		const wallboxMultiplier = 1 + this.apiWallboxUuids.length;
		return yearCount * 2 * wallboxMultiplier;
	}

	/**
	 * @param {Error & { response?: { status: number }; code?: string }} error - if an error occurs
	 */
	isApiRelevantRebuildError(error) {
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
	 */
	async getPendingRebuildSteps(anlagenId) {
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
	 */
	async isRebuildStepDone(anlagenId, year, monthly) {
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
	 */
	async isRebuildFinishedForSystem(anlagenId) {
		const pending = await this.getPendingRebuildSteps(anlagenId);
		return pending.length === 0;
	}

	/**
	 * Checks if the rebuild process is finished for all systems.
	 *
	 * @returns {Promise<boolean>} True if the rebuild is finished for all systems, false otherwise.
	 */
	async isRebuildFinishedGlobally() {
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
	 */
	logRebuildPendingFailuresIfChanged() {
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
	 */
	async runSingleRebuildStep(anlagenId, step) {
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
					const delayMs = Math.min(
						this.rebuildRetryBaseDelayMs * Math.pow(2, attempt - 1),
						24 * 60 * 60 * 1000,
					);

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
	getRebuildDoneStateId(anlagenId, year, monthly) {
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
	 */
	async persistRebuildDone(anlagenId, year, monthly) {
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
	 */
	async initializeForcedRebuildIfNeeded() {
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
	 */
	getRebuildMode() {
		const mode = String(this.config.api_alltimeRebuildMode || REBUILD_MODE.OFF).toLowerCase();

		if (mode !== REBUILD_MODE.OFF && mode !== REBUILD_MODE.RESUME && mode !== REBUILD_MODE.FORCE_FULL) {
			return REBUILD_MODE.OFF;
		}

		return mode;
	}

	/**
	 * @returns {boolean} true if any rebuild mode is active
	 */
	isRebuildEnabled() {
		return this.getRebuildMode() !== REBUILD_MODE.OFF;
	}

	/**
	 * @returns {boolean} true if current rebuild mode requests a forced full rebuild
	 */
	isForceFullRebuildRequested() {
		return this.getRebuildMode() === REBUILD_MODE.FORCE_FULL;
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
 * Converts float value in hex format to js float32.
 * Also fixes to 2 decimals.
 *
 * @param str return value
 */
const HexToFloat32 = (str) => {
	const int = parseInt(str, 16);
	if (int > 0 || int < 0) {
		// var sign = (int >>> 31) ? -1 : 1;
		const sign = int & 0x80000000 ? -1 : 1;
		let exp = ((int >>> 23) & 0xff) - 127;
		const mantissa = ((int & 0x7fffff) + 0x800000).toString(2);
		let float32 = 0;
		for (let i = 0; i < mantissa.length; i++) {
			float32 += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
			exp--;
		}
		return (float32 * sign).toFixed(2);
	}
	return 0;
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

/**
 * Reviver function for JSON.parse to convert Senec specific value formats to proper js types.
 *
 * @param key key of the value
 * @param value value to convert
 */
const reviverNumParse = (key, value) => {
	// prepare values for output using reviver function
	if (typeof value === "string") {
		if (value.startsWith("fl_")) {
			// float in hex IEEE754
			return HexToFloat32(value.substring(3));
		} else if (value.startsWith("u")) {
			// unsigned int in hex
			return parseInt(value.substring(3), 16);
		} else if (value.startsWith("st_")) {
			// string?
			return value.substring(3);
		} else if (value.startsWith("i1")) {
			// int
			let val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				if ((val & 0x8000) > 0) {
					val = val - 0x10000;
				}
				return val;
			}
			return 0;
		} else if (value.startsWith("i3")) {
			// int
			let val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				if ((val & 0x80000000) !== 0) {
					val = val - 0x100000000;
				}
				return val;
			}
			return 0;
		} else if (value.startsWith("i8")) {
			// int
			let val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				if ((val & 0x80) !== 0) {
					val = val - 0x100;
				}
				return val;
			}
			return 0;
		} else if (value.startsWith("VARIABLE_NOT_FOUND")) {
			return "VARIABLE_NOT_FOUND";
		} else if (value.startsWith("FILE_VARIABLE_NOT_READABLE")) {
			return "";
		}
		return `REPORT TO DEV: ${key}:${value}`;
		//throw new Error("Unknown value in JSON: " + key + ":" + value);
	}
	return value;
};

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options] options
	 */
	module.exports = (options) => new Senec(options);
	// Export pure functions for unit testing
	module.exports._testing = {
		extractFormAction,
		hasUsername,
		hasPassword,
		hasUsernameAndPassword,
		hasOtp,
		generateTOTP,
		computeBackoffDelay,
		normalizeRebuildMode,
		HexToFloat32,
		DecToIP,
		reviverNumParse,
		generateCodeVerifier,
		generateCodeChallenge,
		base64UrlEncode,
		resolveStateAttrKey,
		webApiErrorMsg,
	};
} else {
	// otherwise start the instance directly
	new Senec();
}

// --- AUTHENTIFIZIERUNG (LOGIN) -----------------------------------------------
function generateCodeVerifier() {
	return base64UrlEncode(
		globalThis.crypto?.getRandomValues
			? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
			: crypto.randomBytes(32),
	);
}

function generateCodeChallenge(verifier) {
	return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function base64UrlEncode(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function extractFormAction(html) {
	const match = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
	return match && match[1] ? match[1].replace(/&amp;/g, "&") : null;
}

function hasUsername(html) {
	return html.match(/<input\b(?![^>]*\bvalue\s*=)[^>]*\b(?:name|id)\s*=\s*["']?(?:username|user|email)["']?[^>]*>/i);
}

function hasPassword(html) {
	return html.match(
		/<input\b(?=[^>]*\btype\s*=\s*["']?password["']?)(?=[^>]*\b(?:name|id)\s*=\s*["']?password["']?)[^>]*>/i,
	);
}

function hasUsernameAndPassword(html) {
	return hasUsername(html) && hasPassword(html);
}

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
	const crypto = require("node:crypto");
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

/**
 * Extract a human-readable error message from a mein-senec.de API response.
 *
 * @param {object} res - axios response object
 * @returns {string} error message
 */
function webApiErrorMsg(res) {
	return res.data?.message || res.data?.errorCode || JSON.stringify(res.data);
}

function normalizeRebuildMode(value) {
	const mode = String(value || "").toLowerCase();

	if (mode === REBUILD_MODE.OFF || mode === REBUILD_MODE.RESUME || mode === REBUILD_MODE.FORCE_FULL) {
		return mode;
	}

	return REBUILD_MODE.OFF;
}
