"use strict";

const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const axiosRaw = require("axios");
const axiosApi = axiosRaw.create({
	timeout: 10000,
});
const axios = require("axios");
axios.defaults.headers.post["Content-Type"] = "application/json";

const https = require("https");
const agent = new https.Agent({
	requestCert: true,
	rejectUnauthorized: false,
});

const utils = require("@iobroker/adapter-core");
const state_attr = require(__dirname + "/lib/state_attr.js");
const state_trans = require(__dirname + "/lib/state_trans.js");
//const api_trans = require(__dirname + "/lib/api_trans.js");
const kiloList = ["W", "Wh"];
const API_PFX = "_api.";
const ID_TOKEN_STATE = API_PFX + "AuthToken";

// API Endpoints
const HOST_SYSTEMS = "https://senec-app-systems-proxy.prod.senec.dev";
const HOST_MEASUREMENTS = "https://senec-app-measurements-proxy.prod.senec.dev";

const CONFIG = {
	authUrl: "https://sso.senec.com/realms/senec/protocol/openid-connect/auth",
	tokenUrl: "https://sso.senec.com/realms/senec/protocol/openid-connect/token",
	clientId: "endcustomer-app-frontend",
	redirectUri: "senec-app-auth://keycloak.prod",
	scope: "roles meinsenec openid",
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
let connectVia = "http://";

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

const knownObjects = {};

class Senec extends utils.Adapter {
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		// @ts-ignore
		super({
			...options,
			name: "senec",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);
		try {
			await this.checkConfig();
			if (this.config.lala_use) {
				this.log.info("Usage of lala.cgi configured.");
				await this.initPollSettings();
				await this.checkConnection();
				if (lalaConnected) {
					await this.pollSenecLocal(true, 0); // highPrio
					await this.pollSenecLocal(false, 0); // lowPrio
				}
			} else {
				this.log.warn("Usage of lala.cgi not configured. Only polling SENEC App API if configured.");
			}
			if (this.config.api_use) {
				this.log.info("Usage of SENEC App API configured.");
				apiConnected = await this.senecLogin();
				if (apiConnected != null) {
					await this.pollSenecApi();
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
				this.log.info("Active appliance control activated!");
				await this.subscribeStatesAsync("control.*"); // subscribe on all state changes in control.
				await this.subscribeStatesAsync("ENERGY.STAT_STATE");
			}
		} catch (error) {
			this.log.error(error);
			this.setState("info.connection", false, true);
		}
	}

	/**
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state && !state.ack) {
			this.log.debug("State changed: " + id + " ( " + JSON.stringify(state) + " )");
			if (this.config.control_active) {
				// All state-changes for .control.* need active config value
				if (id === this.namespace + ".control.ForceLoadBattery" && lalaConnected) {
					const url = connectVia + this.config.senecip + "/lala.cgi";
					try {
						if (state.val) {
							this.log.info("Enable force battery charging ...");
							this.evalPoll(
								JSON.parse(
									await this.doGet(url, batteryOn, this, this.config.pollingTimeout, true),
									reviverNumParse,
								),
								"",
								"",
							);
						} else {
							this.log.info("Disable force battery charging ...");
							this.evalPoll(
								JSON.parse(
									await this.doGet(url, batteryOff, this, this.config.pollingTimeout, true),
									reviverNumParse,
								),
								"",
								"",
							);
						}
					} catch (error) {
						this.log.error(error);
						this.log.error("Failed to control: setting force battery charging mode to " + state.val);
						return;
					}
				}
			}
			this.setStateAsync(id, { val: state.val, ack: true }); // Verarbeitung bestätigen
		} else if (state && id === this.namespace + ".ENERGY.STAT_STATE") {
			// states that do have state.ack already
			this.log.debug("State changed: " + id + " ( " + JSON.stringify(state) + " )");
			const forceLoad = await this.getStateAsync(this.namespace + ".control.ForceLoadBattery");
			if (state.val == 8 || state.val == 9) {
				if (state.val == 9) this.log.info("Battery forced loading completed (battery full).");
				if (forceLoad != null && !forceLoad.val) {
					this.log.info(
						"Battery forced loading activated (from outside or just lag). Syncing control-state.",
					);
					this.setStateChangedAsync(this.namespace + ".control.ForceLoadBattery", { val: true, ack: true });
				}
			} else {
				if (forceLoad != null && forceLoad.val) {
					this.log.info(
						"Battery forced loading deactivated (from outside or just lag). Syncing control-state.",
					);
					this.setStateChangedAsync(this.namespace + ".control.ForceLoadBattery", { val: false, ack: true });
				}
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			unloaded = true;
			if (this.timer) {
				clearTimeout(this.timer);
			}
			if (this.timerAPI) {
				clearTimeout(this.timerAPI);
			}
			this.log.info("cleaned everything up...");
			this.setState("info.connection", false, true);
			callback();
		} catch (e) {
			callback(e);
		}
	}

	async initPollSettings() {
		// creating form for low priority pulling (which means pulling everything we know)
		// we can do this while preparing values for high prio
		lowPrioForm = "{";
		for (const value of allKnownObjects) {
			lowPrioForm += '"' + value + '":{},';
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
					if (this.config.disclaimer && this.config.highPrio_BMS_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_BMS);
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
					if (this.config.disclaimer && this.config.highPrio_ENERGY_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_ENERGY);
					break;
				case "PV1":
					["POWER_RATIO", "MPP_POWER"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PV1_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_PV1);
					break;
				case "PWR_UNIT":
					["POWER_L1", "POWER_L2", "POWER_L3"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PWR_UNIT_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_PWR_UNIT);
					break;
				case "PM1OBJ1":
					["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PM1OBJ1_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ1);
					break;
				case "PM1OBJ2":
					["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
					if (this.config.disclaimer && this.config.highPrio_PM1OBJ2_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ2);
					break;
				case "WALLBOX":
					if (this.config.disclaimer && this.config.highPrio_WALLBOX_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_WALLBOX);
					break;
				case "BAT1":
					if (this.config.disclaimer && this.config.highPrio_BAT1_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_BAT1);
					break;
				case "BAT1OBJ1":
					if (this.config.disclaimer && this.config.highPrio_BAT1OBJ1_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_BAT1OBJ1);
					break;
				case "TEMPMEASURE":
					if (this.config.disclaimer && this.config.highPrio_TEMPMEASURE_active)
						this.addUserDps(value, objectsSet, this.config.highPrio_TEMPMEASURE);
					break;
				default:
					// nothing to do here
					break;
			}
			if (objectsSet.size > 0) {
				highPrioObjects.set(value, objectsSet);
			}
		}

		lowPrioForm = lowPrioForm.slice(0, -1) + "}";
		this.log.info("(initPollSettings) lowPrio: " + lowPrioForm);

		// creating form for high priority pulling
		highPrioForm = "{";
		//highPrioObjects.forEach(function (mapValue, key, map) {
		highPrioObjects.forEach(function (mapValue, key) {
			highPrioForm += '"' + key + '":{';
			mapValue.forEach(function (setValue) {
				highPrioForm += '"' + setValue + '":"",';
			});
			highPrioForm = highPrioForm.slice(0, -1) + "},";
		});
		highPrioForm = highPrioForm.slice(0, -1) + "}";
		this.log.info("(initPollSettings) highPrio: " + highPrioForm);
	}

	addUserDps(value, objectsSet, dpToAdd) {
		if (dpToAdd.trim().length < 1 || !/^[A-Z0-9_,]*$/.test(dpToAdd.toUpperCase().trim())) {
			// don't accept anything but entries like DP_1,DP2,dp3
			this.log.warn(
				"(addUserDps) Datapoints config for " +
					value +
					" doesn't follow [A-Z0-9_,] (no blanks allowed!) - Ignoring: " +
					dpToAdd.toUpperCase().trim(),
			);
			return;
		}
		dpToAdd
			.toUpperCase()
			.trim()
			.split(",")
			.forEach((item) => objectsSet.add(item));
		this.log.info("(addUserDps) Datapoints config changed for " + value + ": " + dpToAdd.toUpperCase().trim());
	}

	/**
	 * checks config paramaters
	 * Fallback to default values in case they are out of scope
	 */
	async checkConfig() {
		this.log.debug("(checkConf) Configured polling interval high priority: " + this.config.interval);
		if (this.config.interval < 1 || this.config.interval > 3600) {
			this.log.warn(
				"(checkConf) Config interval high priority " +
					this.config.interval +
					" not [1..3600] seconds. Using default: 10",
			);
			this.config.interval = 10;
		}
		this.log.debug("(checkConf) Configured polling interval low priority: " + this.config.intervalLow);
		if (this.config.intervalLow < 10 || this.config.intervalLow > 3600) {
			this.log.warn(
				"(checkConf) Config interval low priority " +
					this.config.intervalLow +
					" not [10..3600] minutes. Using default: 60",
			);
			this.config.intervalLow = 60;
		}
		this.log.debug("(checkConf) Configured polling timeout: " + this.config.pollingTimeout);
		if (this.config.pollingTimeout < 1000 || this.config.pollingTimeout > 10000) {
			this.log.warn(
				"(checkConf) Config timeout " +
					this.config.pollingTimeout +
					" not [1000..10000] ms. Using default: 5000",
			);
			this.config.pollingTimeout = 5000;
		}
		this.log.debug("(checkConf) Configured num of retries: " + this.config.retries);
		if (this.config.retries < 0 || this.config.retries > 999) {
			this.log.warn(
				"(checkConf) Config num of retries " + this.config.retries + " not [0..999] seconds. Using default: 10",
			);
			this.config.retries = 10;
		}
		this.log.debug("(checkConf) Configured retry multiplier: " + this.config.retrymultiplier);
		if (this.config.retrymultiplier < 1 || this.config.retrymultiplier > 10) {
			this.log.warn(
				"(checkConf) Config retry multiplier " +
					this.config.retrymultiplier +
					" not [1..10] seconds. Using default: 2",
			);
			this.config.retrymultiplier = 2;
		}
		this.log.debug("(checkConf) Configured https-usage: " + this.config.useHttps);
		if (this.config.useHttps) {
			connectVia = "https://";
			this.log.debug("(checkConf) Switching to https ... " + this.config.useHttps);
		}
		this.log.debug("(checkConf) Configured api polling interval: " + this.config.api_interval);
		if (this.config.api_interval < 3 || this.config.api_interval > 1440) {
			this.log.warn(
				"(checkConf) Config api polling interval " +
					this.config.api_interval +
					" not [3..1440] seconds. Using default: 5",
			);
			this.config.api_interval = 5;
		}
	}

	/**
	 * checks connection to senec service
	 */
	async checkConnection() {
		const url = connectVia + this.config.senecip + "/lala.cgi";
		const form = '{"ENERGY":{"STAT_STATE":""}}';
		try {
			this.log.info("connecting to Senec: " + url);
			await this.doGet(url, form, this, this.config.pollingTimeout, true);
			this.log.info("connected to Senec: " + url);
			lalaConnected = true;
		} catch (error) {
			throw new Error(
				"Error connecting to Senec (IP: " +
					connectVia +
					this.config.senecip +
					"). Exiting! (" +
					error +
					"). Try to toggle https-mode in settings and check FQDN of SENEC appliance.",
			);
		}
	}

	async senecLogin() {
		this.log.info("🔄 Start Senec Login Flow...");
		try {
			const codeVerifier = generateCodeVerifier();
			const codeChallenge = generateCodeChallenge(codeVerifier);

			const pageRes = await axiosApi.get(
				`${CONFIG.authUrl}?${new URLSearchParams({
					response_type: "code",
					client_id: CONFIG.clientId,
					redirect_uri: CONFIG.redirectUri,
					scope: CONFIG.scope,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
				}).toString()}`,
			);

			const actionUrl = extractFormAction(pageRes.data);
			if (!actionUrl) throw new Error("Login-Formular URL nicht gefunden.");

			const formData = new URLSearchParams();
			formData.append("username", this.config.api_mail);
			formData.append("password", this.config.api_pwd);
			formData.append("credentialId", "");

			const loginRes = await axiosApi.post(actionUrl, formData, {
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: formatCookies(pageRes.headers),
				},
				maxRedirects: 0,
				validateStatus: (s) => s >= 200 && s < 400,
			});

			const redirectLocation = loginRes.headers["location"];
			if (!redirectLocation) {
				if (loginRes.status === 200) throw new Error("Login fehlgeschlagen (Kein Redirect).");
				throw new Error(`Login unerwarteter Status: ${loginRes.status}`);
			}

			const authCode = new URL(redirectLocation.replace("senec-app-auth://", "https://")).searchParams.get(
				"code",
			);
			if (!authCode) throw new Error("Authorization code not found in redirect.");

			const tokenRes = await axiosApi.post(
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

			const accessToken = tokenRes.data.access_token;
			this.log.info("✅ Login erfolgreich.");
			this.doState(ID_TOKEN_STATE, accessToken, "Access Token", "", false);
			return accessToken;
		} catch (e) {
			this.log.error(`❌ Login Error: ${e.message}`);
			return null;
		}
	}

	async pollSenecApi(isRetry = false, retry) {
		if (!this.config.api_use || !apiConnected) {
			this.log.info("Usage of SENEC App API not configured or not connected.");
			return;
		}
		const interval = this.config.api_interval * 60000;

		this.log.info("🔄 Polling SENEC App API...");
		const tokenState = await this.getStateAsync(this.namespace + "." + ID_TOKEN_STATE);
		let token = tokenState ? tokenState.val : null;

		if (!token) {
			if (isRetry) return;
			token = await this.senecLogin();
		}
		if (!token) return;

		try {
			// get Systems
			const sysRes = await axiosApi.get(`${HOST_SYSTEMS}/v1/systems`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!sysRes.data || !sysRes.data[0]) throw new Error("Keine Anlagen gefunden.");

			// collect all systems
			for (const data of sysRes.data) {
				apiKnownSystems.add(data.id);
			}
			const systemData = sysRes.data[0];

			const anlagenId = systemData.id;
			this.evalPoll(systemData, API_PFX + "Anlagen." + anlagenId + ".");
			this.log.debug("Sysres" + JSON.stringify(systemData));

			for (const anlagenId of apiKnownSystems) {
				this.log.info(`🔄 Polling data for system ${anlagenId}...`);
				// get Dashboard data
				const dashRes = await axiosApi.get(`${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/dashboard`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				this.log.debug("DashRes" + JSON.stringify(dashRes.data));
				this.evalPoll(dashRes.data, API_PFX + "Anlagen." + anlagenId + "." + "Dashboard.");

				// get Measurements for current year
				await this.doMeasurementsCurrentYear(anlagenId, token);
				await this.doMeasurementsCurrentMonth(anlagenId, token);
				await this.doMeasurementsPreviousMonth(anlagenId, token);
			}
			retry = 0; // reset retry counter on success

			// schedule next poll
			if (!unloaded) {
				this.timerAPI = setTimeout(() => this.pollSenecApi(false), interval);
			}
		} catch (e) {
			if (e.response && e.response.status === 401) {
				if (isRetry) return;
				this.log.info("⚠️ Token abgelaufen. Starte Re-Login...");
				const newToken = await this.senecLogin();
				if (newToken) setTimeout(() => this.pollSenecApi(true, retry), 2000);
			} else {
				this.log.error(`❌ Fehler beim Datenabruf: ${e.message}`);
				if (retry == this.config.retries && this.config.retries < 999) {
					this.log.error(
						"Error reading from Senec AppAPI. Retried " +
							retry +
							" times. Giving up now. Check config and restart adapter. (" +
							e +
							")",
					);
					this.setState("info.connection", false, true);
				} else {
					retry += 1;
					this.log.warn(
						"Error reading from Senec AppAPI. Retry " +
							retry +
							"/" +
							this.config.retries +
							" in " +
							(interval * this.config.retrymultiplier * retry) / 1000 +
							" seconds! (" +
							e +
							")",
					);
					this.timerAPI = setTimeout(
						() => this.pollSenecApi(false, retry),
						interval * this.config.retrymultiplier * retry,
					);
				}
			}
		}
	}

	/**
	 * @param {any} token
	 * @param {string | number | boolean} anlagenId
	 */
	async doMeasurementsCurrentYear(anlagenId, token) {
		const pfx = API_PFX + "Anlagen." + anlagenId + "." + "Measurements.Yearly.";
		const now = new Date();
		const startDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0));
		const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) - 1);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());
		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=MONTH&from=${start}&to=${end}`;
		this.log.debug("🔄 Polling measurements for " + url);
		const measurements = await axiosApi.get(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, "year");
	}

	/**
	 * @param {any} token
	 * @param {string | number | boolean} anlagenId
	 */
	async doMeasurementsCurrentMonth(anlagenId, token) {
		const pfx = API_PFX + "Anlagen." + anlagenId + "." + "Measurements.Monthly.";
		const now = new Date();
		const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
		const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) - 1);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());
		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=MONTH&from=${start}&to=${end}`;
		this.log.debug("🔄 Polling measurements for " + url);
		const measurements = await axiosApi.get(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, "current_month");
	}

	/**
	 * @param {any} token
	 * @param {string | number | boolean} anlagenId
	 */
	async doMeasurementsPreviousMonth(anlagenId, token) {
		const pfx = API_PFX + "Anlagen." + anlagenId + "." + "Measurements.Monthly.";
		const now = new Date();
		const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0));
		const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0) - 1);
		const start = encodeURIComponent(startDate.toISOString());
		const end = encodeURIComponent(endDate.toISOString());

		const url = `${HOST_MEASUREMENTS}/v1/systems/${anlagenId}/measurements?resolution=MONTH&from=${start}&to=${end}`;
		this.log.debug("🔄 Polling measurements for " + url);
		const measurements = await axiosApi.get(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		await this.doSumMeasurements(measurements.data, anlagenId, pfx, "previous_month");
	}

	async doSumMeasurements(data, anlagenId, pfx, period) {
		this.log.debug("Measurements: " + JSON.stringify(data));
		const sums = Object.fromEntries(data.measurements.map((key) => [key, 0]));
		const year = new Date(data.timeSeries[0].date).getUTCFullYear();

		// Durch timeSeries iterieren und Werte addieren
		data.timeSeries.forEach((entry) => {
			entry.measurements.values.forEach((value, index) => {
				const key = data.measurements[index];
				sums[key] += value;
			});
		});

		this.log.info("Sums: " + JSON.stringify(sums));
		let groupBy;
		switch (period) {
			case "year":
				groupBy = year;
				break;
			case "current_month":
				groupBy = "current_month";
				break;
			case "previous_month":
				groupBy = "previous_month";
				break;
			default:
				throw new Error("Unknown period for doSumMeasurements: " + period);
		}
		this.evalPoll(sums, pfx + groupBy + ".");
	}

	/**
	 * Read from url via axios
	 * @param url to read from
	 * @param form to post
	 */
	doGet(pUrl, pForm, caller, pollingTimeout, isPost) {
		this.log.debug("Calling: " + pUrl);
		return new Promise(function (resolve, reject) {
			axios({
				method: isPost ? "post" : "get",
				httpsAgent: agent,
				url: pUrl,
				data: pForm,
				timeout: pollingTimeout,
			})
				.then(async (response) => {
					const content = response.data;
					caller.log.debug("(Poll) received data (" + response.status + "): " + JSON.stringify(content));
					resolve(JSON.stringify(content));
				})
				.catch((error) => {
					if (error.response) {
						// The request was made and the server responded with a status code
						caller.log.warn(
							"(Poll) received error " +
								error.response.status +
								" response from SENEC with content: " +
								JSON.stringify(error.response.data),
						);
						reject(error.response.status);
					} else if (error.request) {
						// The request was made but no response was received
						// `error.request` is an instance of XMLHttpRequest in the browser and an instance of http.ClientRequest in node.js<div></div>
						caller.log.info(error.message);
						reject(error.message);
					} else {
						// Something happened in setting up the request that triggered an Error
						caller.log.info(error.message);
						reject(error.status);
					}
				});
		});
	}

	/**
	 * Read values from Senec Home V2.1
	 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often. Adverse effects: No sync with Senec possible if called too often.
	 */
	async pollSenecLocal(isHighPrio, retry) {
		const url = connectVia + this.config.senecip + "/lala.cgi";
		let interval = this.config.interval * 1000;
		if (!isHighPrio) {
			this.log.info("LowPrio polling ...");
			interval = this.config.intervalLow * 1000 * 60;
		}

		try {
			let body = await this.doGet(
				url,
				isHighPrio ? highPrioForm : lowPrioForm,
				this,
				this.config.pollingTimeout,
				true,
			);
			if (body.includes('\\"')) {
				// in rare cases senec reports back extra escape sequences on some machines ...
				this.log.info("(Poll) Double escapes detected!  Body inc: " + body);
				body = body.replace(/\\"/g, '"');
				this.log.info("(Poll) Double escapes autofixed! Body out: " + body);
			}
			const obj = JSON.parse(body, reviverNumParse);
			this.log.debug("(Poll) Parsed object: " + JSON.stringify(obj));
			//await this.evalPollLocal(obj);
			await this.evalPoll(obj, "", "");

			retry = 0;
			if (unloaded) return;
			this.timer = setTimeout(() => this.pollSenecLocal(isHighPrio, retry), interval);
		} catch (error) {
			if (retry == this.config.retries && this.config.retries < 999) {
				this.log.error(
					"Error reading from Senec " +
						(isHighPrio ? "high" : "low") +
						"Prio (" +
						this.config.senecip +
						"). Retried " +
						retry +
						" times. Giving up now. Check config and restart adapter. (" +
						error +
						")",
				);
				this.setState("info.connection", false, true);
			} else {
				retry += 1;
				this.log.warn(
					"Error reading from Senec " +
						(isHighPrio ? "high" : "low") +
						"Prio (" +
						this.config.senecip +
						"). Retry " +
						retry +
						"/" +
						this.config.retries +
						" in " +
						(interval * this.config.retrymultiplier * retry) / 1000 +
						" seconds! (" +
						error +
						")",
				);
				this.timer = setTimeout(
					() => this.pollSenecLocal(isHighPrio, retry),
					interval * this.config.retrymultiplier * retry,
				);
			}
		}
	}

	/**
	 * inserts a value for a given key and year into AllTimeValueStore
	 */
	async insertAllTimeHistory(system, key, year, value, einheit) {
		this.log.debug("Insert AllTimeHistory: " + system + "/" + key + "/" + year + "/" + value + "/" + einheit);
		if (key === "__proto__" || key === "constructor" || key === "prototype") return; // Security fix
		if (isNaN(year) || isNaN(value)) return; // Security fix
		const pfx = "_api.Anlagen." + system + ".Statistik.AllTime.";
		const valueStore = pfx + "valueStore";
		const statsObj = await this.getStateAsync(valueStore);
		const stats = statsObj && statsObj.val ? JSON.parse(statsObj.val) : {};
		if (!stats[key]) stats[key] = {};
		if (!stats[key][year]) stats[key][year] = {};
		stats[key][year] = value;
		stats[key]["einheit"] = einheit;
		await this.doState(valueStore, JSON.stringify(stats), "", "", false);
	}

	/**
	 * Updated AllTimeHistory based on what we have in our AllTimeValueStore
	 */
	async updateAllTimeHistory(system) {
		const pfx = "_api.Anlagen." + system + ".Statistik.AllTime.";
		const valueStore = pfx + "valueStore";
		const statsObj = await this.getStateAsync(valueStore);
		const stats = statsObj && statsObj.val ? JSON.parse(statsObj.val) : {};
		const sums = {};
		for (const [key, value] of Object.entries(stats)) {
			let einheit = "";
			let sum = 0.0;
			for (const [key2, value2] of Object.entries(value)) {
				if (key2 == "einheit") {
					einheit = value2;
				} else {
					sum += value2;
				}
			}
			sums[key] = sum;
			if (kiloList.includes(einheit)) {
				await this.doState(pfx + key, Number((sum / 1000).toFixed(0)), "", "k" + einheit, false);
			} else {
				await this.doState(pfx + key, Number(sum.toFixed(0)), "", einheit, false);
			}
		}
		if (sums.totalUsage != 0) {
			const autarky = Number(
				(
					((sums.generation - sums.gridFeedIn - sums.storageLoad + sums.storageConsumption) /
						sums.totalUsage) *
					100
				).toFixed(0),
			);
			await this.doState(pfx + "Autarkie", autarky, "", "%", false);
		}
	}

	/**
	 * sets a state's value and creates the state if it doesn't exist yet
	 */
	async doState(name, value, description, unit, write) {
		if (!isNaN(name.substring(0, 1))) {
			// keys cannot start with digits! Possibly SENEC delivering erraneous data
			this.log.debug("(doState) Invalid datapoint: " + name + ": " + value);
			return;
		}
		this.log.silly("(doState) Update: " + name + ": " + value);

		const valueType = value !== null && value !== undefined ? typeof value : "mixed";

		// Check object for changes:
		const obj = knownObjects[name] ? knownObjects[name] : await this.getObjectAsync(name);
		if (obj) {
			const newCommon = {};
			if (obj.common.name !== description) {
				this.log.debug(
					"(doState) Updating object: " + name + " (desc): " + obj.common.name + " -> " + description,
				);
				newCommon.name = description;
			}
			if (obj.common.type !== valueType) {
				this.log.debug(
					"(doState) Updating object: " + name + " (type): " + obj.common.type + " -> " + typeof value,
				);
				newCommon.type = valueType;
			}
			if (obj.common.unit !== unit) {
				this.log.debug("(doState) Updating object: " + name + " (unit): " + obj.common.unit + " -> " + unit);
				newCommon.unit = unit;
			}
			if (obj.common.write !== write) {
				this.log.debug("(doState) Updating object: " + name + " (write): " + obj.common.write + " -> " + write);
				newCommon.write = write;
			}
			if (Object.keys(newCommon).length > 0) {
				await this.extendObjectAsync(name, { common: newCommon });
			}
		} else {
			knownObjects[name] = {
				type: "state",
				common: {
					name: description,
					type: valueType,
					role: "value",
					unit: unit,
					read: true,
					write: write,
				},
				native: {},
			};
			await this.setObjectNotExistsAsync(name, knownObjects[name]);
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
	 */
	async doDecode(name, value) {
		// Lang: WIZARD.GUI_LANG 0=German, 1=English, 2=Italian
		let lang = 1; // fallback to english
		const langState = await this.getStateAsync("WIZARD.GUI_LANG");
		if (langState) lang = langState.val;
		this.log.silly("(Decode) Senec language: " + lang);
		let key = name;
		if (!isNaN(name.substring(name.lastIndexOf(".")) + 1)) key = name.substring(0, name.lastIndexOf("."));
		this.log.silly("(Decode) Checking: " + name + " -> " + key);

		if (state_trans[key + "." + lang] !== undefined) {
			this.log.silly("(Decode) Trans found for: " + key + "." + lang);
			const trans =
				state_trans[key + "." + lang] !== undefined
					? state_trans[key + "." + lang][value] !== undefined
						? state_trans[key + "." + lang][value]
						: "(unknown)"
					: "(unknown)";
			this.log.silly("(Decode) Trans " + key + ":" + value + " = " + trans);
			const desc = state_attr[key + "_Text"] !== undefined ? state_attr[key + "_Text"].name : key;
			await this.doState(name + "_Text", trans, desc, "", true);
		}
	}

	/**
	 * evaluates data polled from SENEC system.
	 * creates / updates the state.
	 * @param {{ [s: string]: any; } | ArrayLike<any>} obj
	 * @param {string} pfx
	 */
	async evalPoll(obj, pfx, keyPrefix = "") {
		if (unloaded) return;
		if (Array.isArray(obj)) {
			obj.forEach((value, index) => {
				const fullKey = `${keyPrefix}.${index}`;
				if (typeof value === "object" && value !== null) {
					this.evalPoll(value, fullKey);
				} else {
					if (state_attr[fullKey] === undefined) {
						this.log.debug(
							"REPORT_TO_DEV: State attribute definition missing for: " + fullKey + ", Val: " + value,
						);
					}
					this.log.info("API Array Value: " + fullKey + " = " + value);
					const desc = state_attr[fullKey] !== undefined ? state_attr[fullKey].name : fullKey;
					const unit = state_attr[fullKey] !== undefined ? state_attr[fullKey].unit : "";
					this.doState(pfx + fullKey, ValueTyping(value), desc, unit, false);
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
				if (state_attr[fullKey] === undefined) {
					this.log.debug(
						"REPORT_TO_DEV: State attribute definition missing for: " + fullKey + ", Val: " + value,
					);
				}
				this.log.debug("API Value: " + fullKey + " = " + value);
				const desc = state_attr[fullKey] !== undefined ? state_attr[fullKey].name : fullKey;
				const unit = state_attr[fullKey] !== undefined ? state_attr[fullKey].unit : "";
				this.doState(pfx + fullKey, ValueTyping(fullKey, value), desc, unit, false);
			}
		}
	}
}

/**
 * modifies the supplied value based upon flags set for the specific key.
 * currently handles bool, date, ip objects
 */
const ValueTyping = (key, value) => {
	if (!isNaN(value)) value = Number(value); // otherwise iobroker will note it as string
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
	} else {
		return value;
	}
};

//const toFloat = (val) => {
//	if (val === null || val === undefined) return 0;
//	const num = Number(val);
//	return Number.isNaN(num) ? 0 : parseFloat(num.toFixed(2));
//};

/**
 * Converts float value in hex format to js float32.
 * Also fixes to 2 decimals.
 * @param string with hex value
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
	} else {
		return 0;
	}
};

/**
 * Converts a given decimal to a properly formatted IP address.
 * We have to do that because Senec stores IPs as regular hex values and due to the fact that we
 * are using a reviver function for the JSON we have to back-convert to hex and then build the IP
 * for proper human reading.
 */
const DecToIP = (str) => {
	let ipHex = str.toString(16);
	while (ipHex.length < 8) {
		ipHex = "0" + ipHex;
	}
	const fourth = ipHex.substring(0, 2);
	const third = ipHex.substring(2, 4);
	const second = ipHex.substring(4, 6);
	const first = ipHex.substring(6);
	return parseInt(first, 16) + "." + parseInt(second, 16) + "." + parseInt(third, 16) + "." + parseInt(fourth, 16);
};

/**
 * Reviver function to convert numeric values to float or int.
 * Senec supplies them as hex.
 * @param key value pair as defined in reviver option
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
			} else return 0;
		} else if (value.startsWith("i3")) {
			// int
			let val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				if (Math.abs(value & 0x80000000) > 0) {
					val = val - 0x100000000;
				}
				return val;
			} else return 0;
		} else if (value.startsWith("i8")) {
			// int
			let val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				if ((value & 0x80) > 0) {
					val = val - 0x100;
				}
				return val;
			} else return 0;
		} else if (value.startsWith("VARIABLE_NOT_FOUND")) {
			return "VARIABLE_NOT_FOUND";
		} else if (value.startsWith("FILE_VARIABLE_NOT_READABLE")) {
			return "";
		} else {
			return "REPORT TO DEV: " + key + ":" + value;
			//throw new Error("Unknown value in JSON: " + key + ":" + value);
		}
	} else {
		return value;
	}
};

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Senec(options);
} else {
	// otherwise start the instance directly
	new Senec();
}

// --- AUTHENTIFIZIERUNG (LOGIN) -----------------------------------------------
function generateCodeVerifier() {
	return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
	return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function base64UrlEncode(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function formatCookies(headers) {
	const setCookie = headers["set-cookie"];
	if (!setCookie) return "";
	return Array.isArray(setCookie) ? setCookie.map((c) => c.split(";")[0]).join("; ") : setCookie.split(";")[0];
}

function extractFormAction(html) {
	const match = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
	return match && match[1] ? match[1].replace(/&amp;/g, "&") : null;
}
