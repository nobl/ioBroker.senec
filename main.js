"use strict";

const axios = require("axios");
const tough = require("tough-cookie");
const CookieJar = tough.CookieJar;
let wrapper;
const https = require("node:https");
const tls = require("node:tls");
const crypto = require("node:crypto");

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
	isDeviceSentinel,
	isAbsentSentinel,
	DATAPOINT_UNAVAILABLE,
} = require(`${__dirname}/lib/constants.js`);

const AdaptiveRequestQueue = require(`${__dirname}/lib/AdaptiveRequestQueue.js`);
const webClient = require(`${__dirname}/lib/web-client.js`);
const localClient = require(`${__dirname}/lib/local-client.js`);
const apiClient = require(`${__dirname}/lib/api-client.js`);
const connectClient = require(`${__dirname}/lib/connect-client.js`);
const { computeBackoffDelay, redactAuthUrl, extractHtmlErrorText, maskAuthSecrets } = require(
	`${__dirname}/lib/auth-helpers.js`,
);

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
		this.connectConnected = false;
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

		// Foreign state id → every consumer of it, and the parsed formula entries.
		// Created here so they exist before onReady, which is when a stateChange can first
		// arrive, and reset by initExternalSources on each configuration load.
		this._externalSourceMap = {};
		this._externalFormulas = [];

		this.apiKnownSystems = new Set();
		this.highPrioObjects = new Map();
		this.lowPrioForm = "";
		this.highPrioForm = "";
		this.knownObjects = new Map();
		// Datapoints the appliance already refused during this run. Polling repeats every few
		// seconds, so without this the same refusal would flood the log forever.
		this.loggedSentinelKeys = new Set();

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

		// SENEC.Connect
		this.connectSystemNames = new Map(); // system key -> channel name, keeps object reads off the poll
		this.connectKnownKeys = null; // system keys of the last reconciled poll, null until one succeeded
		this.connectIdentityAliases = new Map(); // every identifier a system answers to -> its key
		this.connectLoggedConditions = new Set(); // conditions already warned about, so they log on entry only

		this.abortController = new AbortController(); // used to cancel ongoing API calls on unload

		this.lastLoggedRecommendedConcurrency = null;
		this.lastLoggedQueueSnapshot = null;
		// Fingerprint of the last login page written to the log, so a login failing the same way on
		// every retry is reported once instead of every few seconds. A successful login clears it.
		this.lastLoggedAuthPage = null;
		this._lastLoggedWebRecommendedConcurrency = null;
		this._lastLoggedWebQueueSnapshot = null;

		this.guiLang = "1"; // fallback english
		this.loggedLangFallback = new Set(); // languages already reported as having no translation table

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("message", this.onMessage.bind(this));
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
		await this.setObjectNotExistsAsync("info.connectionStatus", {
			type: "state",
			common: {
				role: "text",
				name: "Connection status (all/partial/none)",
				type: "string",
				read: true,
				write: false,
				def: "none",
			},
			native: {},
		});
		await this.setState("info.connectionStatus", "none", true);
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

			// create agents first — TLS negotiation for local happens after state init
			this.localAgent = this.createLocalAgent();
			if (this.config.lala_use) {
				await this.initTlsStates();
				await this.negotiateLocalTls();
			}

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

			// The SENEC API is regularly slow enough that 10s cost whole readings — Dashboard
			// and SystemStatus time out on a bad day and the tier is lost until the next
			// cycle. The dashboard tier runs every 6 minutes, so waiting longer for an answer
			// costs nothing that a lost reading does not cost more. Measurements keep their
			// own, longer budget via api_measurement_timeout.
			//
			// Clamped rather than trusted: the value reaches us from a config field that an
			// older instance may not have at all, and an out-of-range entry should be pulled
			// into range instead of disabling the timeout or making it useless.
			this.apiClient = axios.create({
				timeout: resolveApiTimeout(this.config.api_timeout),
				signal: this.abortController?.signal,
				httpsAgent: this.apiAgent,
				// axios 1.x buffers a response of any size by default (-1 = unlimited). Every API
				// answer is JSON over a bounded window — the largest, a measurement tier, asks for
				// a fixed from/to range at a fixed resolution — so a body past this bound is a
				// malfunction, and on a Raspberry Pi it is one that would be paid for in RAM.
				maxContentLength: API_MAX_RESPONSE_BYTES,
				maxBodyLength: API_MAX_RESPONSE_BYTES,
			});

			this.authClient = wrapper(
				axios.create({
					withCredentials: true,
					timeout: 10000,
					signal: this.abortController?.signal,
					// Same reasoning for the SSO: a real Keycloak page measures ~13 KB, so the bound
					// is orders of magnitude above anything the login flow legitimately returns.
					maxContentLength: API_MAX_RESPONSE_BYTES,
					maxBodyLength: API_MAX_RESPONSE_BYTES,
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

				// The SSO login runs on authClient, not apiClient, so without these the one flow
				// users actually report problems with is the one the debug log says nothing
				// about. Request bodies are never logged — they carry the account's mail address
				// and password — and every URL goes through redactAuthUrl so that single-use
				// login codes stay out of the log.
				this.authClient.interceptors.request.use((config) => {
					try {
						const method = (config.method || "GET").toUpperCase();
						this.log.debug(`[SSO REQUEST] ${method} ${redactAuthUrl(config.url)}`);
					} catch (err) {
						this.log.debug(`SSO request logging failed: ${err.message}`);
					}
					return config;
				});

				this.authClient.interceptors.response.use(
					(response) => {
						try {
							const method = (response.config?.method || "GET").toUpperCase();
							const location = response.headers?.location;
							this.log.debug(
								`[SSO RESPONSE] ${response.status} ${method} ${redactAuthUrl(response.config?.url)}${
									location ? ` → ${redactAuthUrl(location)}` : ""
								}`,
							);
						} catch (err) {
							this.log.debug(`SSO response logging failed: ${err.message}`);
						}
						return response;
					},
					(error) => {
						try {
							const method = (error.config?.method || "GET").toUpperCase();
							const status = error.response?.status || "no-status";
							const body = error.response?.data;
							const secrets = { mail: this.config.api_mail, password: this.config.api_pwd };
							let reason = "";
							if (body && typeof body === "object") {
								// Masked like the HTML branch below: an OAuth error_description names the
								// account often enough that letting this one route past the redaction
								// would undo it for everyone whose failure arrives as JSON.
								reason = maskAuthSecrets(
									[body.error, body.error_description].filter(Boolean).join(": "),
									secrets,
								);
							} else if (typeof body === "string" && body) {
								reason = extractHtmlErrorText(body, secrets);
							}
							this.log.debug(
								`[SSO ERROR] ${status} ${method} ${redactAuthUrl(error.config?.url)}${reason ? `: ${reason}` : ""}`,
							);
						} catch (err) {
							this.log.debug(`SSO error logging failed: ${err.message}`);
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

			await this.startLocalConnector();

			if (this.config.api_use) {
				this.log.info("[API] Usage of SENEC App API configured.");
				this.apiConnected = await apiClient.apiStartTokenManager(this);
				if (this.apiConnected) {
					apiClient.apiPoll(this).catch((e) => this.logError(e, "[API] ❌ Initial API poll failed"));
				} else {
					this.log.warn("[API] ❌ Initial connection failed. Check credentials.");
					this.retryConnectorInit("api");
				}
			} else {
				this.log.warn("[API] Usage of SENEC App API not configured.");
			}

			if (this.config.connect_use) {
				this.log.info("[Connect] Usage of SENEC.Connect API configured.");
				connectClient.connectPoll(this).catch((e) => this.logError(e, "[Connect] ❌ Initial poll failed"));
				this.connectEnabled = true;
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
					this.retryConnectorInit("web");
				}
			}

			// After web connector is up, try to download CA cert if still on TOFU
			if (this.config.lala_use) {
				await this.attemptCertDownload();
			}

			await this.reportConnectorStatus();

			if (this.config.control_active) {
				this.log.info("Active appliance control (local) activated!");
				await this.subscribeStatesAsync("control.*"); // subscribe on all state changes in control.
				await this.subscribeStatesAsync("ENERGY.STAT_STATE");
				await this.subscribeStatesAsync("SYS_UPDATE.USER_REBOOT_DEVICE");
			}

			// External energy sources (PV, consumers, batteries from other adapters)
			const extSources = Array.isArray(this.config.external_sources) ? this.config.external_sources : [];
			await this.cleanupExternalStates(extSources);
			if (extSources.length > 0) {
				await this.initExternalSources(extSources);
			}
		} catch (error) {
			this.logError(error, "❌ Adapter startup failed");
			await this.updateConnectionStatus();
		}
	}

	/**
	 * Recalculate and update connection indicators based on current connector states.
	 * Sets info.connection (boolean), info.connectionStatus (all/partial/none),
	 * and per-connector info.*Connected states.
	 */
	async updateConnectionStatus() {
		const configured = {
			local: !!this.config.lala_use,
			api: !!this.config.api_use,
			web: !!this.config.web_use,
			connect: !!this.config.connect_use,
		};
		const connected = {
			local: !!this.lalaConnected,
			api: !!this.apiConnected,
			web: !!this.webConnected,
			connect: !!this.connectConnected,
		};

		// Update per-connector indicators
		await this.setStateAsync("info.localConnected", connected.local, true);
		await this.setStateAsync("info.apiConnected", connected.api, true);
		await this.setStateAsync("info.webConnected", connected.web, true);
		await this.setStateAsync("info.connectConnected", connected.connect, true);

		// Count configured vs connected
		const configuredCount = Object.values(configured).filter(Boolean).length;
		const connectedCount = Object.keys(configured).filter((k) => configured[k] && connected[k]).length;

		const anyConnected = connectedCount > 0;
		let status = "none";
		if (connectedCount === configuredCount && configuredCount > 0) {
			status = "all";
		} else if (connectedCount > 0) {
			status = "partial";
		}

		await this.setStateAsync("info.connection", anyConnected, true);
		await this.setStateAsync("info.connectionStatus", status, true);
	}

	/** Standard HTTPS agent options for local SENEC device */
	get _localAgentOptions() {
		return { keepAlive: true, maxSockets: 10, maxFreeSockets: 5, timeout: 60000 };
	}

	/**
	 * Create initial HTTPS agent — starts unvalidated.
	 * Full negotiation happens in negotiateLocalTls() which upgrades to
	 * user-provided CA, cached CA, or TOFU as appropriate.
	 *
	 * @returns {https.Agent} configured HTTPS agent
	 */
	createLocalAgent() {
		this._localTlsMode = "none";
		// TOFU fingerprint validation in localDoGet provides identity verification until negotiateLocalTls upgrades
		return new https.Agent({ ...this._localAgentOptions, rejectUnauthorized: false }); // CodeQL: intentional — TOFU fingerprint validation provides identity verification
	}

	/**
	 * Replace the local HTTPS agent cleanly.
	 *
	 * @param {https.Agent} newAgent - replacement agent
	 */
	swapLocalAgent(newAgent) {
		if (this.localAgent) {
			this.localAgent.destroy();
		}
		this.localAgent = newAgent;
	}

	/**
	 * Create TLS state objects for cert validation tracking.
	 */
	/**
	 * Read and decrypt a TLS state value.
	 *
	 * @param {string} id - State ID (e.g. "_local.tls.fingerprint")
	 * @returns {Promise<string>} Decrypted value or empty string
	 */
	async readTlsState(id) {
		const state = await this.getStateAsync(id);
		if (!state || !state.val) {
			return "";
		}
		try {
			return this.decrypt(String(state.val));
		} catch {
			return String(state.val); // not encrypted (legacy or empty)
		}
	}

	/**
	 * Encrypt and write a TLS state value.
	 *
	 * @param {string} id - State ID (e.g. "_local.tls.fingerprint")
	 * @param {string} val - Value to encrypt and store
	 */
	async writeTlsState(id, val) {
		const encrypted = val ? this.encrypt(val) : "";
		await this.setStateAsync(id, encrypted, true);
	}

	async initTlsStates() {
		await this.setObjectNotExistsAsync("_local.tls", {
			type: "channel",
			common: { name: "TLS certificate validation" },
			native: {},
		});
		const states = [
			{ id: "_local.tls.mode", name: "Active TLS mode", type: "string", def: "none", write: false },
			{
				id: "_local.tls.fingerprint",
				name: "Device cert fingerprint (TOFU)",
				type: "string",
				def: "",
				write: false,
			},
			{
				id: "_local.tls.userCaPem",
				name: "User-uploaded CA cert (PEM)",
				type: "string",
				def: "",
				write: true,
			},
			{
				id: "_local.tls.cachedCaPem",
				name: "Cached CA cert from mein-senec.de",
				type: "string",
				def: "",
				write: false,
			},
			{
				id: "_local.tls.certFetchFailed",
				name: "CA cert download failed (set to false to retry)",
				type: "boolean",
				def: false,
				write: true,
			},
		];
		for (const s of states) {
			// @ts-expect-error s.type is always a valid CommonType
			await this.setObjectNotExistsAsync(s.id, {
				type: "state",
				common: {
					role: "text",
					name: s.name,
					type: s.type,
					read: true,
					write: s.write,
					def: s.def,
				},
				native: {},
			});
		}
		// Subscribe to user-writable TLS states for runtime changes
		await this.subscribeStatesAsync("_local.tls.certFetchFailed");
		await this.subscribeStatesAsync("_local.tls.userCaPem");
	}

	/**
	 * Probe the SENEC device's TLS certificate using tls.connect.
	 * Returns whether the agent's CA validated the cert, plus the fingerprint.
	 *
	 * @param {https.Agent} agent - HTTPS agent to test
	 * @returns {Promise<{valid: boolean, fingerprint: string}>} probe result
	 */
	async tlsProbe(agent) {
		return new Promise((resolve) => {
			const host = this.config.senecip;
			const isIp = /^[\d.]+$/.test(host) || host.includes(":");
			const tlsOpts = {
				ca: agent.options.ca,
				rejectUnauthorized: agent.options.rejectUnauthorized !== false,
			};
			if (!isIp) {
				tlsOpts.servername = host;
			}
			const socket = tls.connect(443, host, tlsOpts, () => {
				const cert = socket.getPeerCertificate();
				const valid = socket.authorized;
				const fp = cert && cert.raw ? crypto.createHash("sha256").update(cert.raw).digest("hex") : "";
				socket.destroy();
				resolve({ valid, fingerprint: fp });
			});
			socket.on("error", () => {
				socket.destroy();
				// If the error is a cert validation error, we can still get the fingerprint
				// by re-probing with rejectUnauthorized: false
				resolve({ valid: false, fingerprint: "" });
			});
			socket.setTimeout(5000, () => {
				socket.destroy();
				resolve({ valid: false, fingerprint: "" });
			});
		});
	}

	/**
	 * Get the device cert fingerprint regardless of CA validation.
	 *
	 * @returns {Promise<string>} SHA-256 fingerprint hex string, or empty on failure
	 */
	async getDeviceFingerprint() {
		const host = this.config.senecip;
		const isIp = /^[\d.]+$/.test(host) || host.includes(":");
		return new Promise((resolve) => {
			// Must bypass CA validation to probe the device's cert fingerprint (TOFU)
			const opts = { rejectUnauthorized: false }; // CodeQL: intentional — TOFU fingerprint validation provides identity verification
			if (!isIp) {
				opts.servername = host;
			}
			const socket = tls.connect(443, host, opts, () => {
				const cert = socket.getPeerCertificate();
				const fp = cert && cert.raw ? crypto.createHash("sha256").update(cert.raw).digest("hex") : "";
				socket.destroy();
				resolve(fp);
			});
			socket.on("error", () => {
				socket.destroy();
				resolve("");
			});
			socket.setTimeout(5000, () => {
				socket.destroy();
				resolve("");
			});
		});
	}

	/**
	 * Negotiate TLS validation for the local SENEC device connection.
	 * Runs the multi-layer waterfall: user CA → cached CA → TOFU.
	 * Called during startup and on cert errors during polling.
	 */
	async negotiateLocalTls() {
		if (!this.config.senecip || this.config.senecip === "0.0.0.0") {
			this._localTlsMode = "none";
			return;
		}

		// Step 1: Try user-uploaded CA cert
		const userPem = await this.readTlsState("_local.tls.userCaPem");
		if (userPem && userPem.includes("BEGIN CERTIFICATE")) {
			const userAgent = new https.Agent({ ...this._localAgentOptions, ca: [userPem] });
			const result = await this.tlsProbe(userAgent);
			if (result.valid) {
				this.swapLocalAgent(userAgent);
				this._localTlsMode = "user";
				await this.setStateAsync("_local.tls.mode", "user", true);
				this.log.info("[Local] ✅ TLS: Using user-uploaded CA cert.");
				return;
			}
			userAgent.destroy();
			this.log.warn("[Local] User-uploaded CA cert did not validate device cert.");
		}

		// Step 2: Try cached CA cert from adapter state
		const cachedPem = await this.readTlsState("_local.tls.cachedCaPem");
		if (cachedPem && cachedPem.includes("BEGIN CERTIFICATE")) {
			const cachedAgent = new https.Agent({ ...this._localAgentOptions, ca: [cachedPem] });
			const result = await this.tlsProbe(cachedAgent);
			if (result.valid) {
				this.swapLocalAgent(cachedAgent);
				this._localTlsMode = "cached";
				await this.setStateAsync("_local.tls.mode", "cached", true);
				this.log.info("[Local] ✅ TLS: Using cached CA cert from mein-senec.de.");
				return;
			}
			cachedAgent.destroy();
			this.log.debug("[Local] Cached CA did not validate device cert. Clearing stale cached PEM.");
			await this.writeTlsState("_local.tls.cachedCaPem", "");
		}

		// Step 3+4: TOFU — fingerprint pinning
		const storedFp = await this.readTlsState("_local.tls.fingerprint");
		const deviceFp = await this.getDeviceFingerprint();

		if (!deviceFp) {
			this.log.warn("[Local] ⚠️ Could not reach device for TLS fingerprint probe.");
			this._localTlsMode = "none";
			await this.setStateAsync("_local.tls.mode", "none", true);
			return;
		}

		// TOFU agent — CA validation bypassed, identity verified via fingerprint in localDoGet
		const tofuAgent = new https.Agent({ ...this._localAgentOptions, rejectUnauthorized: false }); // CodeQL: intentional — TOFU fingerprint validation provides identity verification
		this.swapLocalAgent(tofuAgent);
		this._localTlsMode = "tofu";
		await this.setStateAsync("_local.tls.mode", "tofu", true);

		if (storedFp && storedFp === deviceFp) {
			// Step 3: Stored fingerprint matches
			this._localTofuFingerprint = deviceFp;
			this.log.info(`[Local] ✅ TLS: TOFU fingerprint validated (${deviceFp.substring(0, 16)}...).`);
		} else if (storedFp && storedFp !== deviceFp) {
			// Step 4a: Fingerprint changed
			this.log.warn(
				`[Local] ⚠️ TLS: Device certificate fingerprint changed! ` +
					`Old: ${storedFp.substring(0, 16)}... → New: ${deviceFp.substring(0, 16)}... ` +
					`This may indicate a firmware update. Accepting new certificate.`,
			);
			this._localTofuFingerprint = deviceFp;
			await this.writeTlsState("_local.tls.fingerprint", deviceFp);
		} else {
			// Step 4b: No stored fingerprint — first use
			this.log.info(`[Local] TLS: TOFU — stored device fingerprint: ${deviceFp.substring(0, 16)}...`);
			this._localTofuFingerprint = deviceFp;
			await this.writeTlsState("_local.tls.fingerprint", deviceFp);
		}
	}

	/**
	 * Verify a TLS peer certificate fingerprint during TOFU mode.
	 * Called from localDoGet after each successful request.
	 *
	 * @param {string} fingerprint - SHA-256 hex fingerprint of the peer cert
	 */
	async verifyTofuFingerprint(fingerprint) {
		if (!fingerprint) {
			return;
		}
		if (!this._localTofuFingerprint) {
			// First observation
			this._localTofuFingerprint = fingerprint;
			await this.writeTlsState("_local.tls.fingerprint", fingerprint);
			this.log.info(`[Local] TOFU: Stored device fingerprint: ${fingerprint.substring(0, 16)}...`);
		} else if (this._localTofuFingerprint !== fingerprint) {
			// Fingerprint changed during operation
			this.log.warn(
				`[Local] ⚠️ TOFU: Device fingerprint changed during operation! ` +
					`Old: ${this._localTofuFingerprint.substring(0, 16)}... → New: ${fingerprint.substring(0, 16)}... ` +
					`Accepting new certificate.`,
			);
			this._localTofuFingerprint = fingerprint;
			await this.writeTlsState("_local.tls.fingerprint", fingerprint);
		}
	}

	/**
	 * Attempt to download a fresh CA cert from mein-senec.de.
	 * Called after webInit() if still on TOFU mode.
	 */
	async attemptCertDownload() {
		if (this._localTlsMode !== "tofu" || !this.config.web_use || !this.webConnected) {
			return;
		}
		const fetchFailed = await this.getStateAsync("_local.tls.certFetchFailed");
		if (fetchFailed && fetchFailed.val === true) {
			this.log.info(
				"[Local] TLS: Skipping CA cert download — previous attempt failed. " +
					"Set _local.tls.certFetchFailed to false to retry.",
			);
			return;
		}

		this.log.info("[Local] TLS: Attempting to download CA cert from mein-senec.de...");
		try {
			const webClient = require(`${__dirname}/lib/web-client.js`);
			const pem = await webClient.webFetchCaCert(this);
			if (!pem) {
				this.log.warn("[Local] TLS: Could not find SenecGui-Root cert on mein-senec.de.");
				await this.setStateAsync("_local.tls.certFetchFailed", true, true);
				return;
			}

			// Validate the downloaded cert against the device
			const testAgent = new https.Agent({ ...this._localAgentOptions, ca: [pem] });
			const result = await this.tlsProbe(testAgent);
			if (result.valid) {
				// Success — upgrade from TOFU to cached CA
				this.swapLocalAgent(testAgent);
				this._localTlsMode = "cached";
				await this.setStateAsync("_local.tls.mode", "cached", true);
				await this.writeTlsState("_local.tls.cachedCaPem", pem);
				this.log.info(
					"[Local] ✅ TLS: Downloaded and validated CA cert from mein-senec.de. Upgraded to CA validation.",
				);
			} else {
				testAgent.destroy();
				this.log.warn("[Local] TLS: Downloaded cert did not validate device. Staying on TOFU.");
				await this.setStateAsync("_local.tls.certFetchFailed", true, true);
			}
		} catch (e) {
			this.log.warn(`[Local] TLS: CA cert download failed: ${e.message}. Staying on TOFU.`);
			await this.setStateAsync("_local.tls.certFetchFailed", true, true);
		}
	}

	/**
	 * Publish the connection state and, if nothing is set up at all, say so.
	 *
	 * Logged at warning level rather than as an error: since a new instance ships with no
	 * connector preselected, "nothing enabled" is its deliberate starting state and something
	 * for the user to complete, not a fault the adapter ran into. A connector that was
	 * configured and then failed still reports that as an error, where it belongs.
	 *
	 * @returns {Promise<void>}
	 */
	async reportConnectorStatus() {
		await this.updateConnectionStatus();

		if (this.lalaConnected || this.apiConnected || this.connectEnabled || this.webConnected) {
			await this.refreshGuiLangCache();
			return;
		}

		// Only when nothing is even switched on. If a connector is enabled but has not come
		// up, it has already reported that itself — repeating it here would say it twice.
		if (!this.config.lala_use && !this.config.api_use && !this.config.web_use && !this.config.connect_use) {
			this.log.warn("No connectors are enabled yet. Open the adapter settings and choose which ones to use.");
		}
	}

	/**
	 * Whether the local connector has an address it could actually reach.
	 *
	 * `senecip` ships as "0.0.0.0", which is the absence of a setting rather than a host — the
	 * same reading negotiateLocalTls() already applies before it declines to negotiate.
	 *
	 * @returns {boolean} True when a usable host is configured
	 */
	localHostConfigured() {
		const host = String(this.config.senecip || "").trim();
		return host !== "" && host !== "0.0.0.0";
	}

	/**
	 * Bring up the local connector, or explain why it stays down.
	 *
	 * Extracted from onReady so the "enabled but unconfigured" case can be exercised without
	 * standing up the whole adapter.
	 *
	 * @returns {Promise<void>}
	 */
	async startLocalConnector() {
		if (!this.config.lala_use) {
			this.log.warn("[Local] Usage of lala.cgi (local) not configured.");
			return;
		}

		// A fresh instance has lala_use on and senecip still at its default, so without this
		// the adapter opened a connection to 0.0.0.0:443, failed, and handed the failure to
		// the retry loop — which then kept trying with growing backoff and logged an error
		// every cycle, for a setting the user simply had not filled in yet.
		if (!this.localHostConfigured()) {
			this.log.warn(
				"[Local] lala.cgi is enabled but no SENEC IP is configured. No local connection will be " +
					"attempted — enter the address of your appliance in the adapter settings.",
			);
			return;
		}

		this.log.info("[Local] Usage of lala.cgi (local) configured.");
		try {
			await localClient.localCheckConnection(this);
		} catch (e) {
			this.log.error(`[Local] ❌ Initial connection failed: ${e.message || e}. Other connectors will continue.`);
		}
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
		} else {
			this.retryConnectorInit("local");
		}
	}

	/**
	 * Retry a connector's initialization with exponential backoff and jitter.
	 *
	 * @param {"local" | "api" | "web"} connector - which connector to retry
	 * @param {number} [attempt] - current attempt number (0-based)
	 */
	async retryConnectorInit(connector, attempt = 0) {
		if (this.unloaded) {
			return;
		}

		const labels = { local: "Local", api: "API", web: "Web" };
		const label = labels[connector];

		// Defensive: nothing should reach here without an address, but retrying one can only
		// fail, so return without arming another timer rather than looping for ever.
		if (connector === "local" && !this.localHostConfigured()) {
			this.log.warn("[Local] No SENEC IP configured — not retrying the local connection.");
			return;
		}

		// Already connected — stop retrying
		if (
			(connector === "local" && this.lalaConnected) ||
			(connector === "api" && this.apiConnected) ||
			(connector === "web" && this.webConnected)
		) {
			return;
		}

		this.log.info(`[${label}] 🔄 Retry attempt ${attempt + 1}...`);

		// Attempt connection
		try {
			if (connector === "local") {
				await localClient.localCheckConnection(this);
			} else if (connector === "api") {
				this.apiConnected = await apiClient.apiStartTokenManager(this);
			} else if (connector === "web") {
				await webClient.webInit(this);
			}
		} catch (e) {
			this.log.warn(`[${label}] ⚠️ Retry ${attempt + 1} failed: ${e.message || e}`);
		}

		// Check if now connected
		const connected =
			(connector === "local" && this.lalaConnected) ||
			(connector === "api" && this.apiConnected) ||
			(connector === "web" && this.webConnected);

		if (connected) {
			this.log.info(`[${label}] ✅ Connection established on retry.`);
			if (connector === "local") {
				await localClient.localDiscoverSections(this);
				// The forms in place here were built at startup, while the device was still
				// unreachable and discovery could not run. Rebuild them before polling starts,
				// or a section this retry just discovered is not requested until a restart.
				await localClient.localInitPollSettings(this);
				localClient
					.localPoll(this, true, 0)
					.catch((e) => this.logError(e, "[Local] ❌ Local highPrio poll failed"));
				localClient
					.localPoll(this, false, 0)
					.catch((e) => this.logError(e, "[Local] ❌ Local lowPrio poll failed"));
			} else if (connector === "api") {
				apiClient.apiPoll(this).catch((e) => this.logError(e, "[API] ❌ API poll failed"));
			}
			// Web starts its own polling in webInit
			await this.updateConnectionStatus();
		} else {
			const bases = {
				local: this.config.interval * 1000 * 3,
				api: (this.config.api_interval || 6) * this.baseTime,
				web: (this.config.web_interval_status || 6) * this.baseTime,
			};
			// Floor: never retry faster than 10s (protect SENEC device from rapid requests)
			const delay = Math.max(10000, computeBackoffDelay(bases[connector], attempt));
			this.log.warn(`[${label}] Next retry (#${attempt + 2}) in ${(delay / 1000).toFixed(0)}s.`);
			this.setTimeout(() => this.retryConnectorInit(connector, attempt + 1), delay);
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

		// TLS certFetchFailed reset — user wants to retry CA download
		if (id === `${this.namespace}._local.tls.certFetchFailed` && state.val === false && !state.ack) {
			this.log.info("[Local] TLS: certFetchFailed reset by user — attempting CA cert download...");
			this.attemptCertDownload().catch((e) => this.logError(e, "[Local] TLS cert download retry failed"));
			return;
		}

		// TLS user CA cert upload — validate and upgrade
		if (id === `${this.namespace}._local.tls.userCaPem` && !state.ack) {
			const pem = state.val ? String(state.val) : "";
			if (!pem || !pem.includes("BEGIN CERTIFICATE")) {
				// User cleared the cert — re-negotiate without it
				this.log.info("[Local] TLS: User CA cert cleared — re-negotiating...");
				await this.negotiateLocalTls();
				return;
			}
			this.log.info("[Local] TLS: User CA cert uploaded — validating against device...");
			const testAgent = new https.Agent({ ...this._localAgentOptions, ca: [pem] });
			const result = await this.tlsProbe(testAgent);
			if (result.valid) {
				this.swapLocalAgent(testAgent);
				this._localTlsMode = "user";
				await this.setStateAsync("_local.tls.mode", "user", true);
				await this.writeTlsState("_local.tls.userCaPem", pem); // encrypt and ack
				this.log.info("[Local] ✅ TLS: User-uploaded CA cert validated. Upgraded to CA validation.");
			} else {
				testAgent.destroy();
				await this.writeTlsState("_local.tls.userCaPem", ""); // clear invalid cert
				this.log.warn("[Local] ⚠️ TLS: Uploaded CA cert did not validate the device. Cert rejected.");
			}
			return;
		}

		// External energy source updates (ack=true from foreign adapters)
		if (state.ack && this._externalSourceMap && this._externalSourceMap[id]) {
			// One foreign state can feed several consumers; every one of them updates.
			for (const consumer of this._externalSourceMap[id]) {
				await this.applyExternalConsumer(consumer, state.val);
			}
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
	 * Remove _external.* states that no longer match the current config.
	 *
	 * @param {Array} sources - Current external sources config
	 */
	async cleanupExternalStates(sources) {
		// Build set of expected channel prefixes: _external.{type}.{index}
		const expected = new Set();
		const counters = { pv: 0, consumer: 0, battery: 0 };
		for (const src of sources) {
			if (src.stateId && src.sourceType && counters[src.sourceType] !== undefined) {
				expected.add(`${this.namespace}._external.${src.sourceType}.${counters[src.sourceType]}`);
				counters[src.sourceType]++;
			}
		}

		this.log.debug(`[External] Expected channels: ${[...expected].join(", ") || "(none)"}`);

		// Find all existing _external.* objects and delete orphans
		try {
			const allObjects = await this.getAdapterObjectsAsync();
			const nsParts = this.namespace.split(".").length; // e.g. "senec.0" → 2
			const toDelete = [];
			for (const id in allObjects) {
				if (id.includes("._external.")) {
					// Extract the channel prefix: namespace + _external + type + index
					const parts = id.split(".");
					const channelId = parts.slice(0, nsParts + 3).join(".");
					if (!expected.has(channelId)) {
						toDelete.push(id);
					} else {
						this.log.debug(`[External] Keeping: ${id} (matches ${channelId})`);
					}
				}
			}
			for (const id of toDelete) {
				const shortId = id.replace(`${this.namespace}.`, "");
				this.log.info(`[External] Cleaning up orphaned state: ${shortId}`);
				await this.delObjectAsync(shortId);
			}
			if (toDelete.length > 0) {
				this.log.info(`[External] Cleaned up ${toDelete.length} orphaned states`);
			}
		} catch (err) {
			this.log.warn(`[External] Cleanup failed: ${err.message}`);
		}
	}

	/**
	 * Initialize external energy sources — subscribe to foreign states and create mirror objects.
	 *
	 * @param {Array<{stateId: string, sourceType: string, unit: string, mode: string, label: string, socStateId?: string, capacity?: number}>} sources - external source configurations
	 */
	async initExternalSources(sources) {
		this._externalSourceMap = {}; // foreign stateId → every consumer of it
		this._externalFormulas = []; // formula entries with parsed refs
		const counters = { pv: 0, consumer: 0, battery: 0 };
		const validTypes = ["pv", "consumer", "battery"];

		for (const src of sources) {
			if (!src.stateId || !src.sourceType) {
				continue;
			}
			if (!validTypes.includes(src.sourceType)) {
				this.log.warn(`[External] Unsupported source type: ${src.sourceType}`);
				continue;
			}

			const idx = counters[src.sourceType]++;
			const pfx = `_external.${src.sourceType}.${idx}`;
			// Detect formula: has {stateId} references OR contains math operators
			const hasExplicitRefs = src.stateId.includes("{");
			const hasMathOps = /[+\-*/]/.test(src.stateId);
			const isFormula = hasExplicitRefs || (hasMathOps && src.stateId.includes("."));

			// Auto-wrap bare state IDs in formulas without braces:
			// "a.0.x * a.0.y" → "{a.0.x} * {a.0.y}"
			let formulaStr = src.stateId;
			if (isFormula && !hasExplicitRefs) {
				formulaStr = src.stateId.replace(/([a-zA-Z_][\w-]*(?:\.[\w-]+)+)/g, "{$1}");
				this.log.info(`[External] Auto-wrapped formula: ${src.stateId} → ${formulaStr}`);
			}

			await this.setObjectNotExistsAsync(pfx, {
				type: "channel",
				common: { name: src.label || `External ${src.sourceType} ${idx}` },
				native: {},
			});
			await this.doState(`${pfx}.power`, 0, `${src.label || src.sourceType} power`, "W", false);
			await this.doState(`${pfx}.sourceId`, formulaStr, "Foreign state ID or formula", "", false);
			await this.doState(`${pfx}.label`, src.label || "", "User label", "", false);
			await this.doState(`${pfx}.mode`, src.mode || "integrate", "Display mode", "", false);

			// Battery SOC and capacity (optional)
			if (src.sourceType === "battery") {
				if (src.socStateId) {
					await this.doState(`${pfx}.soc`, 0, `${src.label || "Battery"} SOC`, "%", false);
					await this.addExternalConsumer(src.socStateId, { kind: "soc", pfx: pfx });
					this.log.info(`[External] SOC subscribed: ${src.socStateId} → ${pfx}.soc`);
				}
				if (src.capacity && src.capacity > 0) {
					await this.doState(
						`${pfx}.capacity`,
						src.capacity,
						`${src.label || "Battery"} capacity`,
						"kWh",
						false,
					);
				}
			}

			if (isFormula) {
				// Parse {stateId} references from formula. A state named twice in one formula
				// is one reference — registering it twice would evaluate the formula twice
				// for every change of it.
				const refs = [];
				const regex = /\{([^{}]+)\}/g;
				let match;
				while ((match = regex.exec(formulaStr)) !== null) {
					if (!refs.includes(match[1])) {
						refs.push(match[1]);
					}
				}

				const formulaEntry = {
					formula: formulaStr,
					refs: refs,
					sourceType: src.sourceType,
					index: idx,
					unit: src.unit || "W",
					label: src.label || "",
					pfx: pfx,
				};
				this._externalFormulas.push(formulaEntry);

				// Every referenced state gets this formula as one of its consumers.
				for (const ref of refs) {
					await this.addExternalConsumer(ref, { kind: "formula", entry: formulaEntry });
				}
				this.log.info(`[External] Formula → ${pfx}: ${src.stateId} (${refs.length} refs)`);
			} else {
				await this.addExternalConsumer(src.stateId, {
					kind: "simple",
					sourceType: src.sourceType,
					index: idx,
					unit: src.unit || "W",
					label: src.label || "",
				});
				this.log.info(
					`[External] Subscribed to ${src.stateId} → ${pfx} (${src.sourceType}, ${src.unit}, ${src.mode})`,
				);
			}
		}

		// Subscriptions only deliver changes. Without this pass a source whose foreign state
		// happens to be steady reads 0 — its initialised value — until it next moves, which
		// on a quiet consumer can be hours after startup.
		await this.loadExternalCurrentValues();

		this.log.info(
			`[External] Initialized ${counters.pv} PV, ${counters.consumer} consumer, ${counters.battery} battery external sources`,
		);
	}

	/**
	 * Register one consumer of a foreign state, subscribing on first use.
	 *
	 * A foreign state can legitimately feed several things at once: two sources reading the
	 * same meter, a state used directly and again inside a formula, a battery SOC that a
	 * formula also references. Keeping a list rather than a single entry per state is what
	 * lets all of them update — previously the last registration silently replaced the rest.
	 *
	 * @param {string} stateId - Foreign state id
	 * @param {{ kind: "simple" | "soc" | "formula", [key: string]: unknown }} consumer - What to update when it changes
	 * @returns {Promise<void>}
	 */
	async addExternalConsumer(stateId, consumer) {
		if (!this._externalSourceMap[stateId]) {
			this._externalSourceMap[stateId] = [];
			try {
				await this.subscribeForeignStatesAsync(stateId);
			} catch (err) {
				this.log.warn(`[External] Failed to subscribe to ${stateId}: ${err.message}`);
			}
		}
		this._externalSourceMap[stateId].push(consumer);
	}

	/**
	 * Update one consumer of a foreign state.
	 *
	 * @param {object} consumer - Consumer registered by addExternalConsumer
	 * @param {string|number|boolean|null|undefined} value - Current value of the foreign state (unused for formulas, which read their own refs)
	 * @returns {Promise<void>}
	 */
	async applyExternalConsumer(consumer, value) {
		if (consumer.kind === "soc") {
			// `|| 0` catches NaN but lets Infinity through, and a battery percentage of
			// Infinity propagates into every chart drawn from it.
			const soc = Number(value);
			await this.doState(`${consumer.pfx}.soc`, isFinite(soc) ? soc : 0, "Battery SOC", "%", false);
			return;
		}

		const target = consumer.kind === "formula" ? consumer.entry : consumer;
		let raw = consumer.kind === "formula" ? await this.evaluateFormula(target.formula, target.refs) : Number(value);
		if (!isFinite(raw)) {
			raw = 0;
		}
		if (target.unit === "kW") {
			raw *= 1000;
			// A value finite in kW can leave the range in W, so the check has to happen after
			// the conversion as well as before it.
			if (!isFinite(raw)) {
				raw = 0;
			}
		}
		const normalized = target.sourceType === "battery" ? raw : Math.abs(raw);
		await this.doState(
			`_external.${target.sourceType}.${target.index}.power`,
			normalized,
			`${target.label || target.sourceType} power`,
			"W",
			false,
		);
	}

	/**
	 * Read every subscribed foreign state once and apply it, so the external states hold real
	 * values from startup rather than waiting for the first change.
	 *
	 * @returns {Promise<void>}
	 */
	async loadExternalCurrentValues() {
		const applied = new Set();
		for (const [stateId, consumers] of Object.entries(this._externalSourceMap)) {
			// A formula reads its own references when it is evaluated, so this state only has
			// to be fetched for consumers that are handed the value directly.
			const needsValue = consumers.some((consumer) => consumer.kind !== "formula");
			let current = null;
			if (needsValue) {
				try {
					current = await this.getForeignStateAsync(stateId);
				} catch (err) {
					this.log.debug(`[External] Could not read ${stateId} at startup: ${err.message}`);
				}
			}
			for (const consumer of consumers) {
				// A formula is registered once per reference, each time in its own wrapper, so
				// deduplicating on the wrapper never matched and an N-reference formula was
				// evaluated N times — re-reading all N references on every pass.
				const key = consumer.kind === "formula" ? consumer.entry : consumer;
				if (applied.has(key)) {
					continue;
				}
				applied.add(key);
				await this.applyExternalConsumer(consumer, current?.val);
			}
		}
	}

	/**
	 * Evaluate a formula expression with {stateId} references.
	 * Only supports + - * / ( ) and numeric state values. Safe — no eval().
	 *
	 * @param {string} formula - Formula string with {stateId} references
	 * @param {Array<string>} refs - State ID references extracted from formula
	 * @returns {Promise<number>} Evaluated result
	 */
	async evaluateFormula(formula, refs) {
		// Substitute {stateId} with current values
		let expr = formula;
		for (const ref of refs) {
			const state = await this.getForeignStateAsync(ref);
			const val = state && state.val !== null && state.val !== undefined ? Number(state.val) : 0;
			expr = expr.replace(new RegExp(`\\{${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g"), String(val));
		}

		// Safe math evaluation — only allow digits, operators, parentheses, dots, spaces, minus
		expr = expr.replace(/\s/g, "");
		if (!/^[0-9+\-*/().]+$/.test(expr)) {
			this.log.warn(`[External] Invalid formula expression: ${expr}`);
			return 0;
		}

		try {
			// Use Function constructor (safer than eval, no access to scope)
			const result = Number(new Function(`"use strict"; return (${expr})`)());
			// NaN already collapses to 0 through the check below, but a division by zero
			// yields Infinity, which is truthy — it used to be written to a power state and
			// then propagated into every total and chart built from it.
			if (!isFinite(result)) {
				this.log.warn(`[External] Formula "${formula}" produced ${result}; using 0.`);
				return 0;
			}
			return result;
		} catch (err) {
			this.log.warn(`[External] Formula evaluation error: ${err.message}`);
			return 0;
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
			this.setState("info.connectionStatus", "none", true);
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
		// The admin field enforces these bounds, but a value written straight into
		// system.adapter.senec.N.native — by a script, a restored backup or a hand edit — never
		// passes through it. A negative interval would make setTimeout fire immediately and poll
		// a per-request-billed API in a tight loop.
		this.log.debug(`(checkConf) Configured SENEC.Connect polling interval: ${this.config.connect_interval}s`);
		if (this.config.connect_interval < 60 || this.config.connect_interval > 86400) {
			this.log.warn(
				`(checkConf) Config SENEC.Connect interval ${
					this.config.connect_interval
				} not [60..86400] seconds. Using default: 300`,
			);
			this.config.connect_interval = 300;
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
	 * @param role ioBroker role of the state, defaults to a plain value
	 */
	async doState(name, value, description, unit, write, read = true, role = "value") {
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
			if (obj.common.role !== role) {
				this.log.debug(`(doState) Updating object: ${name} (role): ${obj.common.role} -> ${role}`);
				newCommon.role = role;
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
					role: role,
					unit: unit,
					read: read,
					write: write,
				},
				native: {},
			};

			await this.setObjectNotExistsAsync(name, obj);
			this.knownObjects.set(name, obj);
		}
		// Keep the language cache warm at its source. refreshGuiLangCache() only runs once during
		// onReady, which is after the first local polls have already written their _Text states, so
		// on a non-English appliance those would be decoded with the English fallback. Updating
		// here costs nothing, always reflects the latest poll and picks up a language change on the
		// appliance without an adapter restart.
		if (
			name === "WIZARD.GUI_LANG" &&
			value !== null &&
			value !== undefined &&
			value !== "" &&
			!isDeviceSentinel(value)
		) {
			this.guiLang = String(value);
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
		// doState() calls us and we write the derived text state through doState() again. That
		// recursion currently ends only because no translation table happens to be named "*_Text";
		// bail out on the suffix so it stays bounded no matter what tables are added.
		if (name.endsWith("_Text")) {
			return;
		}
		const lang = this.guiLang || "1";
		this.log.silly(`(Decode) Senec language: ${lang}`);
		// A trailing array index is not part of the translation key: "CASC.STATE.0" is one entry of
		// the "CASC.STATE" table. Same rule as resolveStateAttrKey applies to state_attr.
		const key = name.replace(/\.\d+$/, "");
		this.log.silly(`(Decode) Checking: ${name} -> ${key}`);

		// The language is unvalidated device input, so anything outside 0/1/2 would silently switch
		// off every _Text state. Fall back to English and then German instead.
		const table = state_trans[`${key}.${lang}`] ?? state_trans[`${key}.1`] ?? state_trans[`${key}.0`];
		if (table === undefined) {
			return;
		}
		if (state_trans[`${key}.${lang}`] === undefined && !this.loggedLangFallback.has(lang)) {
			this.loggedLangFallback.add(lang);
			this.log.warn(
				`(Decode) No translations for appliance language "${lang}" (e.g. ${key}). ` +
					"Falling back to English, then German texts.",
			);
		}
		this.log.silly(`(Decode) Trans found for: ${key}.${lang}`);
		// Plain indexing would resolve Object.prototype members, so a device value of "toString" or
		// "constructor" would publish a function instead of a text.
		const trans = Object.hasOwn(table, value) ? table[value] : `(unknown ${value})`;
		this.log.silly(`(Decode) Trans ${key}:${value} = ${trans}`);
		const desc = state_attr[`${key}_Text`] !== undefined ? state_attr[`${key}_Text`].name : key;
		// Nothing in onStateChange acts on a _Text write, so these are read-only derived states.
		await this.doState(`${name}_Text`, trans, desc, "", false, true, "text");
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
				// An appliance without a section answers {"SECTION":{"OBJECT_NOT_FOUND":""}} — the
				// marker arrives as a key, not as a value, so it slips past the sentinel check in
				// evalPollHelper and would otherwise be stored as a state called
				// "SECTION.OBJECT_NOT_FOUND" holding an empty string. The section is simply not
				// there; record nothing for it.
				if (Object.keys(value).length === 1 && Object.hasOwn(value, "OBJECT_NOT_FOUND")) {
					const marker = `${pfx}${fullKey}.OBJECT_NOT_FOUND`;
					if (!this.loggedSentinelKeys.has(marker)) {
						this.loggedSentinelKeys.add(marker);
						this.log.debug(`Section ${fullKey} is not provided by this appliance.`);
						await this.markDatapointUnavailable(marker);
					}
					continue;
				}
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
	/**
	 * Say plainly, in the state itself, that the appliance does not have this datapoint.
	 *
	 * The adapter asks every appliance for the same superset of datapoints, so such a state exists
	 * only because an earlier version stored the appliance's refusal, or because a firmware update
	 * dropped a field that used to be there. Left alone it keeps its last value and goes on looking
	 * like a current reading; marked, it is unmistakable at a glance in the object tree.
	 *
	 * The state is deliberately NOT deleted. Removing it would discard any history or logging
	 * setting attached to it, and clearing out states the appliance no longer reports is a separate
	 * concern with its own rules — this only relabels what the appliance has explicitly refused.
	 *
	 * Only called for markers that mean the datapoint is absent for good. A transient read failure
	 * leaves the state untouched, because the real reading is expected back.
	 *
	 * @param {string} id - Full state id, without the adapter namespace
	 * @returns {Promise<void>}
	 */
	async markDatapointUnavailable(id) {
		for (const candidate of [id, `${id}_Text`]) {
			try {
				// Only an existing state is marked. Creating one would add a datapoint to a clean
				// installation purely to announce that it does not exist, which is noise; the state
				// is only here at all because an earlier version stored the appliance's refusal.
				if (!this.knownObjects.has(candidate) && !(await this.getObjectAsync(candidate))) {
					continue;
				}
				await this.setStateChangedAsync(candidate, { val: DATAPOINT_UNAVAILABLE, ack: true });
				this.log.debug(`Marked ${candidate} as not provided by this appliance.`);
			} catch (error) {
				this.log.debug(`Could not mark ${candidate} as unavailable: ${error.message}`);
			}
		}
	}

	async evalPollHelper(pfx, value, fullKey) {
		// Resolve state attribute: try exact key, then strip trailing index, then strip all indices
		const attrKey = resolveStateAttrKey(fullKey, state_attr);

		if (!attrKey) {
			this.log.debug(`REPORT_TO_DEV: State attribute definition missing for: ${fullKey}, Val: ${value}`);
		}
		// The appliance answered with an unavailability marker instead of a reading. Logged once per
		// datapoint and run: polling repeats every few seconds and the answer does not change, so
		// repeating it would be pure noise.
		//
		// Deliberately debug, never warn: the adapter asks every appliance for the same superset of
		// datapoints and no model provides all of them, so an unanswered one is the normal case
		// rather than a fault. Raising it would tell users something is wrong when nothing is.
		//
		// A marker is never stored. Writing it produced a state whose value was a word where a
		// reading belongs, and flipped the object between "number" and "string" on every poll of a
		// datapoint that answered intermittently.
		if (isDeviceSentinel(value)) {
			const sentinelKey = pfx + fullKey;
			if (!this.loggedSentinelKeys.has(sentinelKey)) {
				this.loggedSentinelKeys.add(sentinelKey);
				this.log.debug(`Datapoint ${sentinelKey} was not delivered by the appliance (${value}).`);
				if (isAbsentSentinel(value)) {
					await this.markDatapointUnavailable(sentinelKey);
				}
			}
			return;
		}
		this.log.silly(`API Array Value: ${fullKey} = ${value}`);
		const desc = attrKey ? state_attr[attrKey].name : fullKey;
		const unit = attrKey ? state_attr[attrKey].unit || "" : "";
		await this.doState(pfx + fullKey, ValueTyping(attrKey || fullKey, value), desc, unit, false);
	}

	/**
	 * Handle a sendTo message.
	 *
	 * The dashboard runs in the browser with no way to authenticate against mein-senec.de,
	 * so for data that is fetched on demand rather than polled into states it asks the
	 * adapter to make the request on its behalf. Nothing is stored — the response goes
	 * straight back to the caller.
	 *
	 * @param {ioBroker.Message} obj - Incoming message
	 * @returns {Promise<void>}
	 */
	async onMessage(obj) {
		if (!obj?.command) {
			return;
		}
		const reply = (payload) => {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, payload, obj.callback);
			}
		};

		if (obj.command === "statsCsv") {
			if (!this.config.web_use) {
				return reply({ error: "mein-senec.de connector is not enabled" });
			}
			if (!this.webAuthenticated) {
				return reply({ error: "mein-senec.de is not connected" });
			}
			const msg = obj.message || {};
			const pn = Number(msg.anlageNummer);
			const week = Number(msg.woche);
			const year = Number(msg.jahr);
			if (!isFinite(pn) || !isFinite(week) || !isFinite(year)) {
				return reply({ error: "anlageNummer, woche and jahr are required" });
			}
			try {
				const data = await webClient.webFetchStatisticsWeek(this, pn, week, year);
				return reply({ result: data });
			} catch (e) {
				this.logError(e, "[Web] ❌ Statistics download failed");
				return reply({ error: e?.message || String(e) });
			}
		}

		reply({ error: `Unknown command: ${obj.command}` });
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
 * 4. Drop one interior segment (e.g. "evse.wb-1.charging_power" → "evse.charging_power"), for
 *    trees keyed on a dynamic identifier rather than an index
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
	// A dynamic identifier used as a path segment, e.g. a wallbox stored under its own id in
	// "evse.<wallbox id>.charging_power". Only interior segments are dropped, and only while at
	// least two remain, so a two-part key like "battery.state" can never collapse to "state"
	// and pick up an unrelated definition.
	const parts = fullKey.split(".");
	for (let i = 1; i < parts.length - 1; i++) {
		const candidate = [...parts.slice(0, i), ...parts.slice(i + 1)].join(".");
		if (attrs[candidate] !== undefined) {
			return candidate;
		}
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
	// An unavailability marker is not a reading and must reach doState unchanged. Typing it would
	// invent plausible data: a booltype turns "FORBIDDEN" into an asserted true, a multiply into
	// NaN, a datetype into "Invalid Date" and an iptype into "222.NaN.NaN.15".
	if (isDeviceSentinel(value)) {
		return value;
	}
	if (state_attr[key]?.stringtype) {
		return typeof value === "string" ? value : String(value);
	}
	// States with a physical unit or explicit numtype must always be numeric.
	// Scaling has to happen here as well: this branch returns early, so the multiply
	// handling further down is unreachable for anything carrying a unit — which is
	// every entry that defines one.
	// An empty value means the appliance delivered no payload at all. isNaN("") is false, so it used
	// to fall through to Number("") || 0 and publish a 0 that is indistinguishable from a reading.
	if (value !== "" && (state_attr[key]?.numtype || (state_attr[key]?.unit && !isNaN(value)))) {
		const num = Number(value) || 0;
		const factor = state_attr[key]?.multiply;
		return factor ? parseFloat((num * factor).toFixed(2)) : num;
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
		resolveApiTimeout,
		HexToFloat32,
		DecToIP,
		reviverNumParse,
		resolveStateAttrKey,
	};
} else {
	// otherwise start the instance directly
	new Senec();
}

/** Bounds for api_timeout, mirroring the min/max the admin field enforces. */
const API_TIMEOUT_MIN_MS = 5000;
const API_TIMEOUT_MAX_MS = 120000;
const API_TIMEOUT_DEFAULT_MS = 30000;

/**
 * Upper bound for a buffered cloud response, in bytes.
 *
 * Far above anything the SENEC cloud or its SSO legitimately answers with, and small enough that a
 * runaway body cannot exhaust the memory of the small hosts this adapter typically runs on.
 */
const API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the timeout for ordinary API requests.
 *
 * An instance created before this setting existed has no value at all, so the default has to
 * survive undefined, null and empty string. Anything outside the range the admin field allows
 * is pulled back into it rather than honoured: a zero would disable the timeout entirely and
 * hang the poll cycle, and an hour-long value would do much the same.
 *
 * @param {unknown} value - Configured value, if any
 * @returns {number} Timeout in milliseconds
 */
function resolveApiTimeout(value) {
	const requested = Number(value);
	if (!isFinite(requested) || requested <= 0) {
		return API_TIMEOUT_DEFAULT_MS;
	}
	return Math.min(API_TIMEOUT_MAX_MS, Math.max(API_TIMEOUT_MIN_MS, Math.round(requested)));
}

function normalizeRebuildMode(value) {
	const mode = String(value || "").toLowerCase();

	if (mode === REBUILD_MODE.OFF || mode === REBUILD_MODE.RESUME || mode === REBUILD_MODE.FORCE_FULL) {
		return mode;
	}

	return REBUILD_MODE.OFF;
}
