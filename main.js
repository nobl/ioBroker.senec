"use strict";

const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const axios = require("axios");
const tough = require("tough-cookie");
const CookieJar = tough.CookieJar;
let wrapper;
let jar = new CookieJar();
let api_client;
let local_client;
const https = require("https");
// rejectUnauthorized needs to be false due to the local machine's certificate cannot be checked properly
const agent_local = new https.Agent({
	requestCert: true,
	rejectUnauthorized: false,
	keepAlive: true,
});

const utils = require("@iobroker/adapter-core");
const state_attr = require(`${__dirname}/lib/state_attr.js`);
const state_trans = require(`${__dirname}/lib/state_trans.js`);
const API_PFX = "_api.";
const LAST_UPDATED = "last updated";
const TOKEN_STATE = `${API_PFX}refreshToken`;

const AdaptiveRequestQueue = require(`${__dirname}/lib/AdaptiveRequestQueue.js`);
const api_parallel_limit = 4;

// API Endpoints
const HOST_SYSTEMS = "https://senec-app-systems-proxy.prod.senec.dev";
const HOST_MEASUREMENTS = "https://senec-app-measurements-proxy.prod.senec.dev";
const SSO_BASE_URL = "https://sso.senec.com/realms/senec/protocol/openid-connect";
const SSO_AUTH_URL = `${SSO_BASE_URL}/auth`;
const SSO_TOKEN_URL = `${SSO_BASE_URL}/token`;

const CONFIG = {
	authUrl: SSO_AUTH_URL,
	tokenUrl: SSO_TOKEN_URL,
	clientId: "endcustomer-app-frontend",
	redirectUri: "senec-app-auth://keycloak.prod",
	scope: "roles profile meinsenec",
};

const apiKnownSystems = new Set();

const batteryOn =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
const batteryOff =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
//const blockDischargeOn  = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
//const blockDischargeOff = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';

let apiConnected = false;
let lalaConnected = false;
let connectVia = "https://";
let rebuildRunning = false;

const allKnownObjects = new Set([
	"BAT1",
	"BAT1OBJ1",
	"BMS",
	"BMS_PARA",
	"BMZ_CURRENT_LIMITS",
	"CASC",
	"CELL_DEVIATION_ROC",
	"CURRENT_IMBALANCE_CONTROL",
	"DEBUG",
	"ENERGY",
	"FACTORY",
	"FEATURES",
	"GRIDCONFIG",
	"ISKRA",
	"LOG",
	"PM1",
	"PM1OBJ1",
	"PM1OBJ2",
	"PV1",
	"PWR_UNIT",
	"RTC",
	"SENEC_IO_INPUT",
	"SENEC_IO_OUTPUT",
	"SELFTEST_RESULTS",
	"SOCKETS",
	"STECA",
	"SYS_UPDATE",
	"TEMPMEASURE",
	"TEST",
	"UPDATE",
	"WALLBOX",
	"WIZARD",
]);

const highPrioObjects = new Map();
let lowPrioForm = "";
let highPrioForm = "";

let unloaded = false;

const knownObjects = new Map();

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

		this.apiQueue = new AdaptiveRequestQueue({
			concurrency: api_parallel_limit,
			minConcurrency: 1,
			maxConcurrency: 6,
		});

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
		this.lastHeavyUpdate = 0;
		this.baseTime = 60000;

		this.abortController = new AbortController(); // used to cancel ongoing API calls on unload

		this.timers = [];

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// load axios-cookiejar-support dynamically (ESM compatible)
		if (!wrapper) {
			const mod = await import("axios-cookiejar-support");
			wrapper = mod.wrapper;
		}

		local_client = wrapper(
			axios.create({
				httpsAgent: agent_local,
				timeout: 10000,
				signal: this.abortController?.signal,
			}),
		);

		api_client = wrapper(
			axios.create({
				withCredentials: true,
				timeout: 10000,
				signal: this.abortController?.signal,
			}),
		);
		api_client.defaults.headers.post["Content-Type"] = "application/json";
		const { setTimeout } = require("timers/promises");
		api_client.interceptors.response.use(
			// upon 429 Too Many Requests axis will auto-retry without breaking the poll-loop and without throwing an error to trigger the retry logic in pollSenecApi,
			// which includes increasing the delay between polls in case of repeated 429 responses.
			// This is important to prevent overwhelming the SENEC API in case of temporary issues or if we are polling too aggressively.
			(response) => response,
			async (error) => {
				if (error.response && error.response.status === 429 && !unloaded) {
					this.log.debug("Experiencing 429. Retrying within axios logic once.");
					if (!error.config._retry429) {
						error.config._retry429 = true;
						await setTimeout(2000); // wait 2s before retrying - this is a simple fixed delay to give the server some time to recover, since we don't have information about how long the client should wait until retrying (like Retry-After header)
						return api_client.request(error.config);
					}
				}
				throw error;
			},
		);

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		try {
			await this.checkConfig();

			if (this.config.lala_use) {
				this.log.info("Usage of lala.cgi (local) configured.");
				await this.initPollSettings();
				await this.checkConnection();
				if (lalaConnected) {
					await this.pollSenecLocal(true, 0); // highPrio
					await this.pollSenecLocal(false, 0); // lowPrio
				}
			} else {
				this.log.warn("Usage of lala.cgi (local) not configured. Only polling SENEC App API if configured.");
			}

			if (this.config.api_use) {
				this.log.info("Usage of SENEC App API configured.");
				apiConnected = await this.startTokenManager();
				if (apiConnected) {
					await this.pollSenecApi();
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

			if (lalaConnected || apiConnected) {
				this.setState("info.connection", true, true);
			} else {
				this.log.error("Neither local connection nor API connection configured. Please check config!");
			}

			if (this.config.control_active) {
				this.log.info("Active appliance control (local) activated!");
				await this.subscribeStatesAsync("control.*"); // subscribe on all state changes in control.
				await this.subscribeStatesAsync("ENERGY.STAT_STATE");
			}
		} catch (error) {
			this.log.error(error);
			this.setState("info.connection", false, true);
		}
	}

	/**
	 * @param {string} id The id of the state that changed
	 * @param {ioBroker.State | null | undefined} state The state object that changed
	 */
	async onStateChange(id, state) {
		if (state && !state.ack) {
			this.log.debug(`State changed: ${id} ( ${JSON.stringify(state)} )`);
			if (this.config.control_active) {
				// All state-changes for .control.* need active config value
				if (id === `${this.namespace}.control.ForceLoadBattery` && lalaConnected) {
					const url = `${connectVia + this.config.senecip}/lala.cgi`;
					try {
						if (state.val) {
							this.log.info("Enable force battery charging ...");
							this.evalPoll(
								JSON.parse(
									await this.doGetLocal(url, batteryOn, this, this.config.pollingTimeout, true),
									reviverNumParse,
								),
								"",
								"",
							);
						} else {
							this.log.info("Disable force battery charging ...");
							this.evalPoll(
								JSON.parse(
									await this.doGetLocal(url, batteryOff, this, this.config.pollingTimeout, true),
									reviverNumParse,
								),
								"",
								"",
							);
						}
					} catch (error) {
						this.log.error(error);
						this.log.error(`Failed to control: setting force battery charging mode to ${state.val}`);
						return;
					}
				}
			}
			// this.setStateAsync(id, { val: state.val, ack: true }); // Verarbeitung bestätigen
			this.setState(id, { val: state.val, ack: true }); // Verarbeitung bestätigen
		} else if (state && id === `${this.namespace}.ENERGY.STAT_STATE`) {
			// states that do have state.ack already
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
					this.setStateChangedAsync(`${this.namespace}.control.ForceLoadBattery`, {
						val: true,
						ack: true,
					});
				}
			} else {
				if (forceLoad != null && forceLoad.val) {
					this.log.info(
						"Battery forced loading deactivated (from outside or just lag). Syncing control-state.",
					);
					this.setStateChangedAsync(`${this.namespace}.control.ForceLoadBattery`, {
						val: false,
						ack: true,
					});
				}
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
			unloaded = true;
			for (const t of this.timers) {
				// clear all timers that we have scheduled in this.timers to prevent them from running after unload and to prevent memory leaks
				clearTimeout(t);
			}
			this.timers = [];

			if (this.abortController) {
				// abort any ongoing API calls to prevent them from running after unload and to prevent memory leaks
				this.abortController.abort();
			}

			// might be redundant due to the loop above but to be sure, we also clear these specific timers that are used for polling and token refresh
			if (this.timerAPI) {
				clearTimeout(this.timerAPI);
			}
			if (this.timerTokenRefresh) {
				clearTimeout(this.timerTokenRefresh);
			}

			knownObjects.clear(); // empty objects cache
			this.log.info("cleaned everything up...");
			this.setState("info.connection", false, true);
			callback();
		} catch (e) {
			this.log.error(e);
			callback();
		}
	}

	async initPollSettings() {
		// creating form for low priority pulling (which means pulling everything we know)
		// we can do this while preparing values for high prio
		lowPrioForm = "{";
		for (const value of allKnownObjects) {
			lowPrioForm += `"${value}":{},`;
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
				default:
					// nothing to do here
					break;
			}
			if (objectsSet.size > 0) {
				highPrioObjects.set(value, objectsSet);
			}
		}

		lowPrioForm = `${lowPrioForm.slice(0, -1)}}`;
		this.log.debug(`(initPollSettings) lowPrio: ${lowPrioForm}`);

		// creating form for high priority pulling
		highPrioForm = "{";
		//highPrioObjects.forEach(function (mapValue, key, map) {
		highPrioObjects.forEach(function (mapValue, key) {
			highPrioForm += `"${key}":{`;
			mapValue.forEach(function (setValue) {
				highPrioForm += `"${setValue}":"",`;
			});
			highPrioForm = `${highPrioForm.slice(0, -1)}},`;
		});
		highPrioForm = `${highPrioForm.slice(0, -1)}}`;
		this.log.debug(`(initPollSettings) highPrio: ${highPrioForm}`);
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
	async checkConfig() {
		this.log.debug(`(checkConf) Configured polling interval high priority: ${this.config.interval}`);
		if (this.config.interval < 1 || this.config.interval > 3600) {
			this.log.warn(
				`(checkConf) Config interval high priority ${
					this.config.interval
				} not [1..3600] seconds. Using default: 10`,
			);
			this.config.interval = 10;
		}
		this.log.debug(`(checkConf) Configured polling interval low priority: ${this.config.intervalLow}`);
		if (this.config.intervalLow < 10 || this.config.intervalLow > 3600) {
			this.log.warn(
				`(checkConf) Config interval low priority ${
					this.config.intervalLow
				} not [10..3600] minutes. Using default: 60`,
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
		this.log.debug(`(checkConf) Configured api polling interval: ${this.config.api_interval}`);
		if (this.config.api_interval < 3 || this.config.api_interval > 1440) {
			this.log.warn(
				`(checkConf) Config api polling interval ${
					this.config.api_interval
				} not [3..1440] seconds. Using default: 5`,
			);
			this.config.api_interval = 5;
		}
	}

	/**
	 * checks connection to senec service
	 */
	async checkConnection() {
		const url = `${connectVia + this.config.senecip}/lala.cgi`;
		const form = '{"ENERGY":{"STAT_STATE":""}}';
		try {
			this.log.info(`connecting to Senec (local): ${url}`);
			await this.doGetLocal(url, form, this, this.config.pollingTimeout, true);
			this.log.info(`connected to Senec (local): ${url}`);
			lalaConnected = true;
		} catch (error) {
			throw new Error(
				`Error connecting to Senec (IP: ${connectVia}${this.config.senecip}). Exiting! (${
					error
				}). Check FQDN of SENEC appliance.`,
			);
		}
	}

	async startTokenManager() {
		try {
			const tokenState = await this.getStateAsync(`${TOKEN_STATE}`);
			this.refreshToken = tokenState?.val ? this.decrypt(String(tokenState.val)) : null;
			// No refresh token at all → full login
			if (!this.refreshToken) {
				this.log.info("🔐 No refresh token present. Performing full login...");
				const token = await this.senecLogin();
				return !!token;
			}
			this.log.info("🔐 Using existing refresh token.");

			// We have a refresh token → try refresh
			this.log.info("🔐 Trying initial token refresh...");
			await this.refreshTokenSingleFlight();
			return !!this.currentToken;
		} catch (error) {
			this.log.warn(`⚠️ Initial refresh failed. Falling back to full login... ${error.message}`);
			const token = await this.senecLogin();
			return !!token;
		}
	}

	async senecLogin() {
		this.log.info("🔄 Start Senec API Login Flow...");
		jar = new CookieJar();

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
			const pageRes = await api_client.get(`${CONFIG.authUrl}?${authParams}`, { jar });
			let actionUrl = extractFormAction(pageRes.data);
			if (!actionUrl) {
				throw new Error("Login-Form URL not found.");
			}

			const postForm = (url, data) =>
				api_client.post(url, data, {
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					maxRedirects: 0,
					validateStatus: (s) => s >= 200 && s < 400,
					jar,
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

			const tokenRes = await api_client.post(
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
			this.log.error(`❌ Login Error: ${e.message}`);
			return null;
		}
	}

	scheduleTokenRefresh() {
		if (!this.tokenExpiresAt || unloaded) {
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

		if (this.timerTokenRefresh) {
			clearTimeout(this.timerTokenRefresh);
		}

		if (!unloaded) {
			this.log.debug(
				`🔐 Next token refresh in ${(delay / 1000).toFixed(0)}s ` +
					`(remaining ${Math.round(remaining / 1000 / 60)} min, failures=${this.tokenFailureCount})`,
			);
			this.timerTokenRefresh = setTimeout(() => {
				this.timers = this.timers.filter((t) => t !== this.timerTokenRefresh);
				this.refreshTokenSingleFlight().catch((err) => {
					this.log.debug(`⚠ Token refresh failed: ${err.message}`);
				});
			}, delay);
			this.timers.push(this.timerTokenRefresh);
		}
	}

	async refreshTokenSingleFlight() {
		if (unloaded) {
			return;
		}

		// Prevent multiple refreshes from different poll workers
		if (this.refreshing) {
			this.log.debug("🔐 Refresh already in progress, waiting for it to complete...");
			await this.refreshPromise;
			return;
		}
		this.refreshing = true;

		// cancel scheduled refresh while manual refresh runs
		if (this.timerTokenRefresh) {
			clearTimeout(this.timerTokenRefresh);
			this.timerTokenRefresh = null;
		}
		if (this.timerTokenRefresh && this.tokenFailureCount > 0) {
			this.log.debug("🔐 Refresh retry already scheduled — skipping immediate refresh.");
			return;
		}
		if (!this.refreshToken) {
			this.log.debug("🔐 No refresh token available — skipping refresh.");
			return this.senecLogin();
		}
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = (async () => {
			try {
				this.log.debug("🔐 Refreshing API token...");

				const response = await api_client.post(
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
					//`${this.namespace}${TOKEN_STATE}`,
					`${TOKEN_STATE}`,
					this.encrypt(this.refreshToken),
					"Encrypted Refresh Token (never log or expose!)",
					"",
					false,
					false,
				);

				this.tokenFailureCount = 0;
				this.authBlocked = false;
				const expiresIn = data.expires_in || 600; // fallback 10min
				this.tokenExpiresAt = Date.now() + expiresIn * 1000;
				this.log.info(`✅ Token refreshed. Expires in ${expiresIn}s`);
				this.scheduleTokenRefresh();
			} catch (err) {
				this.authBlocked = true;
				const status = err.response?.status;
				const errorCode = err.response?.data?.error;

				this.log.warn(`⚠️ Token refresh failed: ${err.message} (HTTP ${status || "unknown"})`);

				// If refresh token invalid → fallback to full login
				if (errorCode === "invalid_grant" || status === 400) {
					this.log.warn("⚠️ Refresh token invalid → full login required.");
					await this.senecLogin();
					return;
				}

				this.tokenFailureCount++;
				const attempt = this.tokenFailureCount; // 1,2,3,...
				let retryDelay = computeBackoffDelay(
					this.tokenBackoff.baseDelayMs,
					attempt - 1, // attempt beginnt bei 0 für ersten Fehler
					this.tokenBackoff.maxMultiplier,
				);
				retryDelay = Math.max(retryDelay, 10000); // never < 10 s
				retryDelay = Math.min(retryDelay, this.tokenBackoff.maxDelayMs); // never > maxDelayMs

				if (this.timerTokenRefresh) {
					clearTimeout(this.timerTokenRefresh);
				}

				if (!unloaded) {
					this.log.warn(
						`🔁 Token refresh retry #${attempt} scheduled in ${(retryDelay / 1000).toFixed(0)}s ` +
							`(failures = ${this.tokenFailureCount})`,
					);
					this.timerTokenRefresh = setTimeout(() => {
						this.timers = this.timers.filter((t) => t !== this.timerTokenRefresh);
						this.refreshTokenSingleFlight().catch(() => {});
					}, retryDelay);
					this.timers.push(this.timerTokenRefresh);
				}

				throw err;
			} finally {
				this.refreshPromise = null;
				this.refreshing = false; // Release lock
			}
		})();

		return this.refreshPromise;
	}

	async pollSenecApi() {
		if (unloaded) {
			return;
		}

		if (this.authBlocked) {
			this.log.debug("⏸ Poll skipped - authentication currently recovering.");
			return;
		}
		if (this.timerAPI) {
			clearTimeout(this.timerAPI);
			this.timerAPI = null;
		}

		if (!this.config.api_use || !apiConnected || unloaded) {
			this.log.info("Usage of SENEC App API not configured or not connected.");
			return;
		}

		if (this.apiPollRunning) {
			this.log.warn("API poll still running — skipping overlapping execution.");
			return;
		}

		this.apiPollRunning = true;

		const baseInterval = this.config.api_interval * this.baseTime;
		let nextDelay = baseInterval;

		try {
			this.log.info("🔄 Polling SENEC App API...");

			// Ensure token exists
			if (!this.currentToken) {
				await this.refreshTokenSingleFlight();
			}

			// Read systems once from API and keep them in memory - we will need them for every poll and they don't change that often
			if (apiKnownSystems.size === 0) {
				this.log.debug("🔄 Reading available systems from API ...");
				const sysRes = await this.apiGet(`${HOST_SYSTEMS}/v1/systems`);
				if (!sysRes?.data?.length) {
					throw new Error("No systems returned from API.");
				}
				for (const sys of sysRes.data) {
					this.log.debug(`System found: ${JSON.stringify(sys)}`);
					apiKnownSystems.add(sys.id);
					this.evalPoll(sys, `${API_PFX}Anlagen.${sys.id}.`);
				}
			}

			// Precompute dates once
			// today/yesterday must not be UTC or they will be off - month / year must be UTC or we will have issues at month / year boundaries
			// that way daily numbers are ok - but month/year are off a bit compared to mein-senec.de
			const now = new Date();
			const utcYear = now.getUTCFullYear();
			const utcMonth = now.getUTCMonth();
			const utcDate = now.getUTCDate();

			const today = new Date(utcYear, utcMonth, utcDate, 0, 0, 0, 0);
			const yesterday = new Date(utcYear, utcMonth, utcDate - 1, 0, 0, 0, 0);
			const currentMonth = new Date(Date.UTC(utcYear, utcMonth, 1));
			const lastMonth = new Date(Date.UTC(utcYear, utcMonth - 1, 1));

			const nowTs = Date.now();
			const heavyInterval = 24 * 60 * 60 * 1000;
			const shouldRunHeavy = nowTs - this.lastHeavyUpdate > heavyInterval;

			let successCount = 0;
			let failureCount = 0;

			for (const anlagenId of apiKnownSystems) {
				try {
					this.log.debug(`🔄 Polling system ${anlagenId}...`);

					// Dashboard (frequent)
					const dashRes = await this.apiGet(`${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/dashboard`);
					this.log.silly(`DashRes keys: ${Object.keys(dashRes.data).join(", ")}`);
					this.evalPoll(dashRes.data, `${API_PFX}Anlagen.${anlagenId}.Dashboard.`);
					// If dashboard worked, count as success
					successCount++;

					// Frequent measurements
					await Promise.all([
						this.doMeasurementsDay(anlagenId, today, "today"),
						this.doMeasurementsDay(anlagenId, today, "today.hourly"),
						this.doMeasurementsDay(anlagenId, yesterday, "yesterday"),
						this.doMeasurementsDay(anlagenId, yesterday, "yesterday.hourly"),
					]);

					// Heavy measurements (once daily)
					if (shouldRunHeavy) {
						await Promise.all([
							this.doMeasurementsMonth(anlagenId, currentMonth, "current_month"),
							this.doMeasurementsMonth(anlagenId, currentMonth, "current_month.daily"),
							this.doMeasurementsMonth(anlagenId, lastMonth, "previous_month"),
							this.doMeasurementsMonth(anlagenId, lastMonth, "previous_month.daily"),
							this.doMeasurementsYear(anlagenId, utcYear, false), // Current year
							this.doMeasurementsYear(anlagenId, utcYear, true), // Current year
							this.doMeasurementsYear(anlagenId, utcYear - 1, false), // check if we need last year too
							this.doMeasurementsYear(anlagenId, utcYear - 1, true), // check if we need last year too
						]);
						this.lastHeavyUpdate = nowTs;
						await this.updateAllTimeHistory(anlagenId);
					}

					if (this.config.api_alltimeRebuild) {
						// rebuild all-time history if requested - will also pull everying again
						await this.doRebuild(anlagenId);
					}
				} catch (systemError) {
					// Important: isolate system failure
					failureCount++;
					this.log.error(`❌ System ${anlagenId} failed: ${systemError.message}`);
				}
			}

			// ---- Evaluate Global Result ----
			if (successCount === 0) {
				// TOTAL FAILURE
				throw new Error("All systems failed during polling.");
			}

			// Partial or full success
			if (failureCount > 0) {
				this.log.warn(`⚠ Partial API failure: ${failureCount} system(s) failed, ${successCount} succeeded.`);
			}

			// Reset global failure counter
			this.apiFailureCount = 0;

			// Connection is healthy
			this.setState("info.connection", true, true);

			nextDelay = baseInterval;
		} catch (err) {
			// ---- TOTAL FAILURE HANDLING ----
			this.apiFailureCount = (this.apiFailureCount || 0) + 1;
			this.log.error(`🚨 API Poll failed: ${err.message} - ⚠️ Failure count: ${this.apiFailureCount}`);
			this.setState("info.connection", false, true);

			// Exponential full jitter backoff
			nextDelay = computeBackoffDelay(baseInterval, this.apiFailureCount);
			// Safety cap (max 8x base interval)
			const maxDelay = baseInterval * 8;
			nextDelay = Math.min(nextDelay, maxDelay);
			this.log.warn(`⏱ Backoff delay: Retry ${this.apiFailureCount} in ${(nextDelay / 1000).toFixed(0)}s`);
		} finally {
			this.apiPollRunning = false;
			if (!unloaded) {
				if (this.timerAPI) {
					clearTimeout(this.timerAPI);
					this.timerAPI = null;
				}
				this.timerAPI = setTimeout(() => {
					this.timers = this.timers.filter((t) => t !== this.timerAPI);
					this.pollSenecApi();
				}, nextDelay);
				this.timers.push(this.timerAPI);
				this.log.debug(`⏱ Next API poll scheduled in ${(nextDelay / 1000).toFixed(0)}s`);
			}
		}
	}

	/**
	 * API Get with automatic token refresh on 401 and retry mechanism using AdaptiveRequestQueue to avoid multiple parallel token refreshes and to limit parallel API calls in general.
	 *
	 * @param {any} url url to call
	 * @param config config for API call - will be extended by auth header - can be used to pass additional headers or other axios config parameters
	 */
	async apiGet(url, config = {}) {
		if (unloaded) {
			return;
		}
		return this.apiQueue.add(async () => {
			// Proactive expiry check - if token is close to expiry, refresh before making the call to avoid edge cases with token expiry during the call
			if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt - this.baseTime) {
				// 60s before expiry to avoid keycloak-server timedrift issues (usually 5-10 sec)
				this.log.debug("🔐 Token close to expiry. Refreshing before request...");
				await this.refreshTokenSingleFlight();
			}

			if (!this.currentToken) {
				this.log.debug("🔐 no current Token. Refreshing before request...");
				await this.refreshTokenSingleFlight();
			}

			const maxAttempts = 3;
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				try {
					return await api_client.get(url, {
						...config,
						headers: {
							Authorization: `Bearer ${this.currentToken}`,
							...(config.headers || {}),
						},
					});
				} catch (e) {
					const status = e.response?.status;
					// 🔐 Token expired
					if (status === 401 && attempt < maxAttempts - 1) {
						this.log.debug("🔐 401 received. Refreshing token...");
						await this.refreshTokenSingleFlight();
						continue;
					}

					// 🚦 Rate limited
					if (status === 429) {
						this.log.warn("🚦 API returned 429 (rate limited) - increasing next poll delay.");
						const delay = this.config.api_interval * this.baseTime * 2; // doppelte Basiszeit
						if (!unloaded && this.timerAPI) {
							clearTimeout(this.timerAPI);
							this.timerAPI = setTimeout(() => {
								this.timers = this.timers.filter((t) => t !== this.timerAPI);
								this.pollSenecApi();
							}, delay);
							this.timers.push(this.timerAPI);
						}
					}

					throw e;
				}
			}
		});
	}

	/**
	 * Rebuild all-time measurements
	 *
	 * @param {string | number} anlagenId Anlagen ID to read measurements for
	 */
	async doRebuild(anlagenId) {
		rebuildRunning = true;
		for (let year = new Date().getFullYear(); year >= 2009; year--) {
			// senec was founded in 2009 by Mathias Hammer as Deutsche Energieversorgung GmbH (DEV) - so no way we have older data :)
			await this.doMeasurementsYear(anlagenId, year, false);
			await this.doMeasurementsYear(anlagenId, year, true);
		}
		this.log.info(`Rebuild ended. Adapter restarting ...`);
		rebuildRunning = false;
		this.extendForeignObject(`system.adapter.${this.namespace}`, {
			native: { api_alltimeRebuild: false },
		});
	}

	/**
	 * Poll measurements by year
	 *
	 * @param {string | number} anlagenId Anlagen ID to read measurements for
	 * @param {number} year Year to read measurements for
	 * @param {boolean} months Read daily measurements
	 */
	async doMeasurementsYear(anlagenId, year, months) {
		this.log.debug(`🔄 Reading measurements for year: ${year}${months ? ".monthly" : ""}`);
		const pfx = `${API_PFX}Anlagen.${anlagenId}.` + `Measurements.Yearly.`;
		const lastUpdate = await this.getStateAsync(`${pfx + year}.${months ? "monthly." : ""}${LAST_UPDATED}`);
		const now = new Date();
		let lastDate = null;
		if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
			lastDate = new Date(String(lastUpdate.val));
		}
		if (year != new Date().getUTCFullYear()) {
			// check if a previous was already updated this year
			// this ensures that we read last year data at most once per year and current year data at most once per day (in case of daily reset of measurements in SENEC App API)
			if (
				!rebuildRunning &&
				lastDate != null &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getUTCFullYear() === now.getUTCFullYear()
			) {
				this.log.debug(
					`Measurements for ${year}${months ? ".monthly" : ""} already updated this year. Skipping.`,
				);
				return;
			}
		} else {
			// current year - check if already updated today
			if (
				!rebuildRunning &&
				lastDate != null &&
				!isNaN(lastDate.getTime()) &&
				lastDate.getUTCFullYear() === now.getUTCFullYear() &&
				lastDate.getUTCMonth() === now.getUTCMonth() &&
				lastDate.getUTCDate() === now.getUTCDate()
			) {
				this.log.debug(`Measurements for ${year}${months ? ".monthly" : ""} already updated today. Skipping.`);
				return;
			}
		}
		const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
		const endDate = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());
		let resolution = "YEAR";
		if (months) {
			resolution = "MONTH";
		}
		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=${resolution}&from=${start}&to=${end}`;
		this.log.debug(`🔄 Polling measurements for ${url}`);
		const measurements = await this.apiGet(url);
		if (!measurements.data.timeSeries || measurements.data.timeSeries.length === 0) {
			this.log.debug(`No measurements found for ${year}. Skipping.`);
			return;
		}
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, `year${months ? ".monthly" : ""}`);
	}

	/**
	 * Poll measurements by month
	 *
	 * @param {string | number} anlagenId Anlagen ID to read measurements for
	 * @param {Date} date Date to read measurements for
	 * @param {string} period period to sum for
	 */
	async doMeasurementsMonth(anlagenId, date, period) {
		this.log.debug(`🔄 Reading measurements for ${period}.`);
		const pfx = `${API_PFX}Anlagen.${anlagenId}.` + `Measurements.Monthly.`;
		if (period === "previous_month" || period === "previous_month.daily") {
			// check if already updated this month
			const lastUpdate = await this.getStateAsync(`${pfx + period}.${LAST_UPDATED}`);
			if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
				const lastDate = new Date(String(lastUpdate.val));
				if (
					!rebuildRunning &&
					!isNaN(lastDate.getTime()) &&
					lastDate.getUTCFullYear() === new Date().getUTCFullYear() &&
					lastDate.getUTCMonth() === new Date().getUTCMonth()
				) {
					this.log.debug(`Measurements for ${period} already updated this month. Skipping.`);
					return;
				}
			}
		}
		const startDate = date;
		const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());
		let resolution = "MONTH";
		if (period === "current_month.daily" || period === "previous_month.daily") {
			resolution = "DAY";
		}
		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=${resolution}&from=${start}&to=${end}`;
		this.log.debug(`🔄 Polling measurements for ${url}`);
		const measurements = await this.apiGet(url);
		if (!measurements?.data?.timeSeries) {
			this.log.warn(`Malformed measurement response for ${url}`);
			return;
		}
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, period);
	}

	/**
	 * Poll measurements by day
	 *
	 * @param {string | number} anlagenId Anlagen ID to read measurements for
	 * @param {Date} date Date to read measurements for
	 * @param {string} period period to sum for
	 */
	async doMeasurementsDay(anlagenId, date, period) {
		this.log.debug(`🔄 Reading measurements for ${period}`);
		const pfx = `${API_PFX}Anlagen.${anlagenId}.` + `Measurements.Daily.`;
		if (period === "yesterday" || period === "yesterday.hourly") {
			// check if already updated today
			const lastUpdate = await this.getStateAsync(`${pfx + period}.${LAST_UPDATED}`);
			if (lastUpdate && lastUpdate.val !== null && lastUpdate.val !== undefined) {
				const lastDate = new Date(String(lastUpdate.val));
				if (
					!rebuildRunning &&
					!isNaN(lastDate.getTime()) &&
					lastDate.getFullYear() === new Date().getFullYear() &&
					lastDate.getMonth() === new Date().getMonth() &&
					lastDate.getDate() === new Date().getDate()
				) {
					this.log.debug(`Measurements for ${period} already updated today. Skipping.`);
					return;
				}
			}
		}
		const startDate = date;
		const endDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());
		let resolution = "DAY";
		if (period === "today.hourly" || period === "yesterday.hourly") {
			resolution = "HOUR";
		}
		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=${resolution}&from=${start}&to=${end}`;
		this.log.debug(`🔄 Polling measurements for ${url}`);
		const measurements = await this.apiGet(url);
		if (!measurements?.data?.timeSeries) {
			this.log.warn(`Malformed measurement response for ${url}`);
			return;
		}
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, period);
	}

	/**
	 * @param {any} data measurement data
	 * @param {string | number} anlagenId Anlagen ID
	 * @param {string} pfx prefix for state
	 * @param {string} period period to sum for
	 */
	async doSumMeasurements(data, anlagenId, pfx, period) {
		this.log.debug(`Measurements sample: ${JSON.stringify(data).slice(0, 500)}`);
		const sums = Object.fromEntries(data.measurements.map((key) => [key, 0]));
		const year = new Date(data.timeSeries[0].date).getUTCFullYear();

		// Durch timeSeries iterieren und Werte addieren
		data.timeSeries.forEach((entry) => {
			entry.measurements.values.forEach((value, index) => {
				const key = data.measurements[index];
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
		this.evalPoll(sums, `${pfx + groupBy}.`);
	}

	/**
	 * Perform GET or POST request
	 *
	 * @param {string} pUrl URL to call
	 * @param {string} pForm Form to send
	 * @param {Senec} caller Calling instance
	 * @param {number} pollingTimeout Timeout for call
	 * @param {boolean} isPost true for POST, false for GET
	 * @returns {Promise<string>} Promise with result
	 */
	async doGetLocal(pUrl, pForm, caller, pollingTimeout, isPost) {
		this.log.debug(`Calling: ${pUrl}`);

		try {
			const response = await local_client({
				method: isPost ? "post" : "get",
				url: pUrl,
				data: pForm,
				timeout: pollingTimeout,
			});

			const content = response.data;
			caller.log.silly(`(Poll) received data (${response.status}): ${JSON.stringify(content)}`);

			return JSON.stringify(content);
		} catch (error) {
			if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
				caller.log.debug("Request aborted (adapter shutdown)");
				return ""; // sauberer Rückgabewert bei Abbruch, damit wir nicht in der Fehlerbehandlung landen und ggf. neue Polls planen - bei Abbruch wollen wir ja eigentlich nur still stoppen
			}
			if (error.response) {
				caller.log.warn(
					`(Poll) received error ${
						error.response.status
					} response from SENEC with content: ${JSON.stringify(error.response.data)}`,
				);
				throw error.response.status;
			} else if (error.request) {
				caller.log.info(error.message);
				throw error.message;
			} else {
				caller.log.info(error.message);
				throw error.status;
			}
		}
	}

	/**
	 * Read values from Senec Home V2.1
	 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often. Adverse effects: No sync with Senec possible if called too often.
	 *
	 * @param isHighPrio high priority poll
	 * @param retry retry count
	 */
	async pollSenecLocal(isHighPrio, retry) {
		const url = `${connectVia + this.config.senecip}/lala.cgi`;
		let interval = this.config.interval * 1000;
		if (!isHighPrio) {
			this.log.info("LowPrio polling (local) ...");
			interval = this.config.intervalLow * 1000 * 60;
		}

		try {
			let body = await this.doGetLocal(
				url,
				isHighPrio ? highPrioForm : lowPrioForm,
				this,
				this.config.pollingTimeout,
				true,
			);
			if (body.includes('\\"')) {
				// in rare cases senec reports back extra escape sequences on some machines ...
				this.log.debug(`(Poll) Double escapes detected!  Body inc: ${body}`);
				body = body.replace(/\\"/g, '"');
				this.log.debug(`(Poll) Double escapes autofixed! Body out: ${body}`);
			}
			const obj = JSON.parse(body, reviverNumParse);
			this.log.silly(`(Poll) Parsed object: ${JSON.stringify(obj)}`);
			//await this.evalPollLocal(obj);
			await this.evalPoll(obj, "", "");

			retry = 0;
			if (!unloaded) {
				const timer = setTimeout(() => {
					this.timers = this.timers.filter((t) => t !== timer);
					this.pollSenecLocal(isHighPrio, retry).catch((e) => this.log.error(e));
				}, interval);
				this.timers.push(timer);
				timer.unref?.();
				this.log.debug(
					`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(interval / 1000).toFixed(0)}s`,
				);
			}
		} catch (error) {
			if (retry == this.config.retries && this.config.retries < 999) {
				this.log.error(
					`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retried ${
						retry
					} times. Giving up now. Check config and restart adapter. (${error})`,
				);
				this.setState("info.connection", false, true);
			} else {
				retry += 1;
				this.log.warn(
					`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retry ${
						retry
					}/${this.config.retries} in ${(interval * this.config.retrymultiplier * retry) / 1000} seconds! (${
						error
					})`,
				);
				if (!unloaded) {
					const delay = interval * this.config.retrymultiplier * retry;
					const timer = setTimeout(() => {
						this.timers = this.timers.filter((t) => t !== timer);
						this.pollSenecLocal(isHighPrio, retry).catch((e) => this.log.error(e));
					}, delay);
					this.timers.push(timer);
					timer.unref?.();
					this.log.debug(
						`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(delay / 1000).toFixed(0)}s`,
					);
				}
			}
		}
	}

	/**
	 * Load AllTimeValueStore for given anlagenId and prefix
	 *
	 * @param {string} valueStore ValueStore
	 * @returns {Promise<{ [s: string]: any; }>} AllTimeValueStore as object
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
	 *
	 * @param {{ [s: string]: number; } | ArrayLike<any>} sums sums to insert
	 * @param {string | number} anlagenId Anlagen ID
	 * @param {number} year Year to insert for
	 */
	async insertIntoAllTimeValueStore(sums, anlagenId, year) {
		const valueStore = `${API_PFX}Anlagen.${anlagenId}.` + `Measurements.AllTime.valueStore`;
		const stats = await this.readAllTimeValueStore(valueStore);
		for (const [key, value] of Object.entries(sums)) {
			if (key === LAST_UPDATED) {
				continue;
			}
			if (!stats[key]) {
				stats[key] = {};
			}
			if (!stats[key][year]) {
				stats[key][year] = {};
			}
			stats[key][year] = value;
			await this.doState(valueStore, JSON.stringify(stats), "", "", false);
		}
	}

	/**
	 * Updated AllTimeHistory based on what we have in our AllTimeValueStore
	 *
	 * @param {string | number} anlagenId Anlagen ID
	 */
	async updateAllTimeHistory(anlagenId) {
		const pfx = `${API_PFX}Anlagen.${anlagenId}.` + `Measurements.AllTime.`;
		const valueStore = `${pfx}valueStore`;
		const input = await this.readAllTimeValueStore(valueStore);

		// Spezialfälle definieren + benötigte Keys
		const specialHandlers = {
			AUTARKY_IN_PERCENT: {
				keys: ["POWER_GENERATION", "GRID_EXPORT", "BATTERY_IMPORT", "BATTERY_EXPORT", "POWER_CONSUMPTION"],
				fn: (values, sums) =>
					((sums.POWER_GENERATION - sums.GRID_EXPORT - sums.BATTERY_IMPORT + sums.BATTERY_EXPORT) /
						sums.POWER_CONSUMPTION) *
					100,
			},
			BATTERY_LEVEL_IN_PERCENT: {
				keys: [],
				fn: (values) => values.reduce((a, b) => a + b, 0) / values.length,
			},
		};

		// Summen der benötigten Keys nur einmal berechnen
		const sumKeys = Object.fromEntries(
			specialHandlers.AUTARKY_IN_PERCENT.keys.map((k) => [k, Object.values(input[k]).reduce((a, b) => a + b, 0)]),
		);

		// Ergebnis berechnen
		const result = Object.fromEntries(
			Object.entries(input).map(([key, years]) => {
				const values = Object.values(years);
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
		this.evalPoll(result, pfx);
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
		let obj = knownObjects.get(name);
		if (!obj) {
			obj = await this.getObjectAsync(name);

			if (obj) {
				knownObjects.set(name, obj);
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
				knownObjects.set(name, obj);
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
			knownObjects.set(name, obj);
		}
		await this.setStateChangedAsync(name, {
			val: value,
			ack: true,
		});
		await this.doDecode(name, value);
	}

	/**
	 * Checks if there is decoding possible for a given value and creates/updates a decoded state
	 * Language used for translations is the language of the SENEC appliance
	 *
	 * @param name Name of State
	 * @param value Value of State
	 */
	async doDecode(name, value) {
		// Lang: WIZARD.GUI_LANG 0=German, 1=English, 2=Italian
		let lang = "1"; // fallback to english
		const langState = await this.getStateAsync("WIZARD.GUI_LANG");
		if (langState && langState.val !== null && langState.val !== undefined) {
			lang = String(langState.val);
		}
		this.log.silly(`(Decode) Senec language: ${lang}`);
		let key = name;
		if (!isNaN(name.substring(name.lastIndexOf(".")) + 1)) {
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
	 * @param {{ [s: string]: any; } | ArrayLike<any>} obj object to evaluate
	 * @param {string} pfx prefix for state
	 * @param keyPrefix current key prefix for nested objects
	 */
	async evalPoll(obj, pfx, keyPrefix = "") {
		if (unloaded) {
			return;
		}
		if (Array.isArray(obj)) {
			obj.forEach((value, index) => {
				const fullKey = `${keyPrefix}.${index}`;
				if (typeof value === "object" && value !== null) {
					this.evalPoll(value, fullKey);
				} else {
					this.evalPollHelper(pfx, value, fullKey);
				}
			});
			return;
		}
		for (const key in obj) {
			const value = obj[key];
			const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;
			if (typeof value === "object" && value !== null) {
				this.evalPoll(value, pfx, fullKey);
			} else {
				this.evalPollHelper(pfx, value, fullKey);
			}
		}
	}

	async evalPollHelper(pfx, value, fullKey) {
		if (state_attr[fullKey] === undefined && state_attr[fullKey.replace(/\.\d+$/, "")] === undefined) {
			this.log.debug(`REPORT_TO_DEV: State attribute definition missing for: ${fullKey}, Val: ${value}`);
		}
		this.log.silly(`API Array Value: ${fullKey} = ${value}`);
		const desc =
			state_attr[fullKey] !== undefined
				? state_attr[fullKey].name
				: state_attr[fullKey.replace(/\.\d+$/, "")]
					? state_attr[fullKey.replace(/\.\d+$/, "")].name
					: fullKey;
		const unit =
			state_attr[fullKey] !== undefined
				? state_attr[fullKey].unit
				: state_attr[fullKey.replace(/\.\d+$/, "")]
					? state_attr[fullKey.replace(/\.\d+$/, "")].unit
					: "";
		this.doState(pfx + fullKey, ValueTyping(fullKey, value), desc, unit, false);
	}
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
		return new Date(value * 1000).toString();
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
