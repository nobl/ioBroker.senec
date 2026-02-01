"use strict";
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // not cool, not nice - but well ... just a last option if everything else fails

const https = require("https");
const agent = new https.Agent({
	requestCert: true,
	rejectUnauthorized: false,
});

const utils = require("@iobroker/adapter-core");

const axios = require("axios").default;
axios.defaults.headers.post["Content-Type"] = "application/json";

const tough = require("tough-cookie");
const cheerio = require("cheerio");
let wrapper;
(async () => {
	wrapper = (await import("axios-cookiejar-support")).wrapper;
})();

const state_attr = require(__dirname + "/lib/state_attr.js");
const state_trans = require(__dirname + "/lib/state_trans.js");
const api_trans = require(__dirname + "/lib/api_trans.js");
const kiloList = ["W", "Wh"];

const apiUrl = "https://mein-senec.de/endkunde/api/status/getstatusoverview.php?anlageNummer=0";
const apiLoginUrl = "https://mein-senec.de/endkunde/oauth2/authorization/endkunde-portal";
const apiKnownSystems = [];

const batteryOn =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
const batteryOff =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
//const blockDischargeOn  = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
//const blockDischargeOff = '{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';

let apiConnected = false;
let lalaConnected = false;
let apiLoginToken = "";
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
					await this.pollSenec(true, 0); // highPrio
					await this.pollSenec(false, 0); // lowPrio
				}
			} else {
				this.log.warn("Usage of lala.cgi not configured. Only polling SENEC App API if configured.");
			}
			if (this.config.api_use) {
				this.log.info("Usage of SENEC App API configured.");
				await this.initSenecAppApi();
				if (apiConnected) {
					await this.getWebApiSystems();
					await this.pollSenecWebApi(0); // Web API
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
							);
						} else {
							this.log.info("Disable force battery charging ...");
							this.evalPoll(
								JSON.parse(
									await this.doGet(url, batteryOff, this, this.config.pollingTimeout, true),
									reviverNumParse,
								),
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
				if (!forceLoad.val) {
					this.log.info(
						"Battery forced loading activated (from outside or just lag). Syncing control-state.",
					);
					this.setStateChangedAsync(this.namespace + ".control.ForceLoadBattery", { val: true, ack: true });
				}
			} else {
				if (forceLoad.val) {
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

	/**
	 * Inits connection to senec app api
	 */
	async initSenecAppApi() {
		if (!this.config.api_use) {
			this.log.info("Usage of SENEC App API not configured. Not using it");
			return;
		}
		/** new for WEB API */
		this.log.info("Connecting to SENEC Portal (mein-senec.de) login...");

		try {
			// create cookie jar and a wrapped axios client that keeps cookies
			const jar = new tough.CookieJar();
			const webClient = wrapper(
				axios.create({
					jar,
					withCredentials: true,
					//httpsAgent: agent,
					headers: {
						"User-Agent": "Mozilla/5.0 (iobroker-senec-adapter)",
					},
					timeout: this.config.pollingTimeout || 5000,
					maxRedirects: 5,
					validateStatus: () => true,
				}),
			);

			// STEP 1: fetch login page
			this.log.info("STEP 1: fetch login portal page...");
			const resp1 = await webClient.get(apiLoginUrl);
			this.log.debug("Portal GET status: " + resp1.status);
			this.log.silly("Portal GET response url: " + (resp1.request && resp1.request.res ? resp1.request.res.responseUrl : ""));

			// parse form
			const $ = cheerio.load(resp1.data);
			const form = $("form#kc-form-login");
			if (!form.length) {
				throw new Error("Login form not found on portal page");
			}
			const actionAttr = form.attr("action");
			const actionUrl = new URL(actionAttr, resp1.request.res.responseUrl).href;

			// collect hidden inputs
			const formData = {};
			form.find("input").each((i, el) => {
				const name = $(el).attr("name");
				const value = $(el).attr("value") || "";
				if (name) formData[name] = value;
			});
			formData.username = this.config.api_mail;
			formData.password = this.config.api_pwd;

			this.log.debug("Posting login to Keycloak action URL: " + actionUrl);

			const resp2 = await webClient.post(
				actionUrl,
				new URLSearchParams(formData).toString(),
				{
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Referer: resp1.request.res.responseUrl,
					},
					maxRedirects: 5,
					validateStatus: () => true,
				},
			);

			this.log.debug("Login POST status: " + resp2.status);
			// check cookies in jar
			const cookies = await jar.getCookies("https://mein-senec.de");
			this.log.debug("Cookies after login: " + cookies.map((c) => c.cookieString()).join("; "));

			if (resp2.status >= 400) {
				throw new Error("Portal login failed: " + resp2.status);
			}

			// store web client for subsequent portal requests
			this.senecWebClient = webClient;
			this.senecWebJar = jar;
			apiConnected = true;
			this.log.info("Connected to SENEC Portal via web login.");
		} catch (error) {
			apiConnected = false;
			this.log.error("Error connecting to SENEC Portal: " + error);
			throw new Error("Error connecting to SENEC Portal. (" + error + ")");
		}
		/** end new WEB API */
	}

	/**
	 * Reads system data from senec app api
	 *
	 * Replaced: reads portal status overview and creates _api.Portal.Overview
	 */
	async getWebApiSystems() {
		const pfx = "_api.Portal.Profile.";
		if (!this.config.api_use || !apiConnected || !this.senecWebClient) {
			this.log.info("Usage of SENEC Portal not configured or not connected.");
			return;
		}
		this.log.info("Reading Systems Information from SENEC Portal (status overview)");

		const PROFILE_SETTINGS = "https://mein-senec.de/endkunde/api/settings/getProfileSettings";

		try {
			const resp = await this.senecWebClient.get(PROFILE_SETTINGS);
			if (resp.status !== 200) {
				throw new Error("Profile Settings returned HTTP " + resp.status);
			}
			const obj = resp.data;

			// try to populate profile settings
			apiKnownSystems.length = 0;

			for (const [key, value] of Object.entries(obj)) {
				if (key == "id") apiKnownSystems.push(value);
				if (key == "land" || key == "sprache") {
					for (const [key2, value2] of Object.entries(value)) {
						this.log.debug("profileSetting: " + pfx + key + "." + key2 + ":" + value);
						await this.doState(pfx + key + "." + key2, JSON.stringify(value2), "", "", false);
					}
				} else {
					this.log.debug("profileSetting: " + pfx + key + ":" + value);
					await this.doState(pfx + key, value, "", "", false);
				}
			}

			/*
			** ensure uniqueness, if there are multiple systems
			const uniq = [...new Set(apiKnownSystems)];
			apiKnownSystems.length = 0;
			uniq.forEach((x) => apiKnownSystems.push(x));
			*/

			this.log.info("Detected systems from portal overview: " + JSON.stringify(apiKnownSystems));
			//await this.doState(pfx + "IDs", JSON.stringify(apiKnownSystems), "Portal detected system IDs", "", false);
		} catch (error) {
			throw new Error("Error reading Systems Information from SENEC Portal. (" + error + ").");
		}
	}

	/**
	 * Reads system data from senec app api
	 * @deprecated
	 */
	async getApiSystems() {
		const pfx = "_api.Anlagen.";
		if (!this.config.api_use || !apiConnected) {
			this.log.info("Usage of SENEC App API not configured or not connected.");
			return;
		}
		this.log.info("Reading Systems Information from Senec App API " + apiSystemsUrl);
		try {
			const body = await this.doGet(apiSystemsUrl, "", this, this.config.pollingTimeout, false);
			this.log.info("Read Systems Information from Senec AppAPI.");
			const obj = JSON.parse(body);
			for (const [key, value] of Object.entries(obj)) {
				this.log.debug("ApiPull: " + key + ":" + JSON.stringify(value));
				const systemId = value.id;
				apiKnownSystems.push(systemId);
				for (const [key2, value2] of Object.entries(value)) {
					if (typeof value2 === "object")
						await this.doState(pfx + systemId + "." + key2, JSON.stringify(value2), "", "", false);
					else await this.doState(pfx + systemId + "." + key2, value2, "", "", false);
				}
			}
			await this.doState(pfx + "IDs", JSON.stringify(apiKnownSystems), "Anlagen IDs", "", false);
		} catch (error) {
			throw new Error("Error reading Systems Information from Senec AppAPI. (" + error + ").");
		}
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
						if (error.response.status == 403 && apiConnected) {
							apiConnected = false; // apparently the api is inaccessible
							this.initSenecAppApi();
						}
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
	async pollSenec(isHighPrio, retry) {
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
			await this.evalPoll(obj);

			retry = 0;
			if (unloaded) return;
			this.timer = setTimeout(() => this.pollSenec(isHighPrio, retry), interval);
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
					() => this.pollSenec(isHighPrio, retry),
					interval * this.config.retrymultiplier * retry,
				);
			}
		}
	}

	/**
	 * Read values from Senec App API - old style
	 * @deprecated
	 */
	async pollSenecAppApi(retry) {
		if (!this.config.api_use || !apiConnected) {
			this.log.info("Usage of SENEC App API not configured or not connected.");
			return;
		}
		const interval = this.config.api_interval * 60000;
		const dates = new Map([
			["THIS_DAY", new Date().toISOString().split("T")[0]],
			["LAST_DAY", new Date(new Date().setDate(new Date().getDate() - 1)).toISOString().split("T")[0]],
			["THIS_MONTH", new Date().toISOString().split("T")[0]],
			["LAST_MONTH", new Date(new Date().setDate(0)).toISOString().split("T")[0]],
			["THIS_YEAR", new Date().toISOString().split("T")[0]],
			["LAST_YEAR", new Date(new Date().getFullYear() - 1, 1, 1).toISOString().split("T")[0]],
		]);

		this.log.debug("Polling API ...");
		let body = "";
		try {
			for (let i = 0; i < apiKnownSystems.length; i++) {
				// const baseUrl = apiSystemsUrl + "/" + apiKnownSystems[i];
				const baseUrl = api2SystemsUrl + "/" + apiKnownSystems[i];
				const baseUrlMonitor = apiMonitorUrl + "/" + apiKnownSystems[i];
				let url = "";
				const tzObj = await this.getStateAsync("_api.Anlagen." + apiKnownSystems[i] + ".zeitzone");
				const tz = tzObj ? encodeURIComponent(tzObj.val) : encodeURIComponent("Europe/Berlin");

				// dashboard
				url = baseUrl + "/dashboard";
				body = await this.doGet(url, "", this, this.config.pollingTimeout, false);
				await this.decodeDashboard(apiKnownSystems[i], JSON.parse(body));

				for (const [key, value] of dates.entries()) {
					// statistik for period
					url =
						baseUrlMonitor +
						"/data?period=" +
						api_trans[key].api +
						"&date=" +
						value +
						"&locale=de_DE&timezone=" +
						tz;
					body = await this.doGet(url, "", this, this.config.pollingTimeout, false);
					await this.decodeStatistik(apiKnownSystems[i], JSON.parse(body), api_trans[key].dp);
				}
				if (this.config.api_alltimeRebuild) await this.rebuildAllTimeHistory(apiKnownSystems[i]);
			}
			retry = 0;
			if (unloaded) return;
			this.timerAPI = setTimeout(() => this.pollSenecAppApi(retry), interval);
		} catch (error) {
			if (retry == this.config.retries && this.config.retries < 999) {
				this.log.error(
					"Error reading from Senec AppAPI. Retried " +
						retry +
						" times. Giving up now. Check config and restart adapter. (" +
						error +
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
						error +
						")",
				);
				this.timerAPI = setTimeout(
					() => this.pollSenecAppApi(retry),
					interval * this.config.retrymultiplier * retry,
				);
			}
		}
	}

	/**
	 * Read values from Senec App API (replaced to query the mein-senec portal endpoints)
	 */
	async pollSenecWebApi(retry) {
		if (!this.config.api_use || !apiConnected || !this.senecWebClient) {
			this.log.info("Usage of SENEC Portal not configured or not connected.");
			return;
		}

		const interval = this.config.api_interval * 60000;
		const base = "https://mein-senec.de/endkunde/api/status";
		const endpoints = {
			statusoverview: base + "/getstatusoverview.php?anlageNummer=0",
			technischeDaten: base + "/technischeDaten?anlageNummer=0",
			status24: base + "/getstatus24.php?anlageNummer=0",
			autarky: base + "/getautarky.php?anlageNummer=0",
			accustate: base + "/getaccustate.php?anlageNummer=0",
			accusavings: base + "/getaccusavings.php?anlageNummer=0",
		};
		// also interesting endpoints:

		// also prepare getstatus types
		const statusTypes = [
			"accuexport",
			"accuimport",
			"gridexport",
			"gridimport",
			"powergenerated",
			"consumption",
		];

		this.log.debug("Polling Portal API ...");

		try {
			// statusoverview
			let r = await this.senecWebClient.get(endpoints.statusoverview);
			if (r.status === 200) {
				await this.decodeStatusOverview(r.data);
			} else {
				this.log.warn("statusoverview returned HTTP " + r.status);
			}

			// technischeDaten
			r = await this.senecWebClient.get(endpoints.technischeDaten);
			if (r.status === 200) {
				await this.decodeTechnischeDaten(r.data);
			} else {
				this.log.warn("technischeDaten returned HTTP " + r.status);
			}

			// status24
			r = await this.senecWebClient.get(endpoints.status24);
			if (r.status === 200) {
				await this.decodeStatus24(r.data);
			} else {
				this.log.warn("stats24 returned HTTP " + r.status);
			}

			// autarky
			r = await this.senecWebClient.get(endpoints.autarky);
			if (r.status === 200) {
				await this.decodeAutarky(r.data);
			} else {
				this.log.warn("autarky returned HTTP " + r.status);
			}

			// accustate
			r = await this.senecWebClient.get(endpoints.accustate);
			if (r.status === 200) {
				await this.decodeAccuState(r.data);
			} else {
				this.log.warn("accustate returned HTTP " + r.status);
			}

			// accusavings
			r = await this.senecWebClient.get(endpoints.accusavings);
			if (r.status === 200) {
				await this.decodeAccuSavings(r.data);
			} else {
				this.log.warn("accusavings returned HTTP " + r.status);
			}

			// getstatus with many types
			for (let i = 0; i < statusTypes.length; i++) {
				const t = statusTypes[i];
				const url = base + "/getstatus.php?type=" + encodeURIComponent(t) + "&period=all&anlageNummer=0";
				try {
					const res = await this.senecWebClient.get(url);
					if (res.status === 200) {	
						await this.decodeStatus(res.data, t);										
					} else {
						this.log.warn("getstatus(" + t + ") returned HTTP " + res.status);
					}
				} catch (err) {
					this.log.warn("Error fetching getstatus(" + t + "): " + err);
				}
			}

			retry = 0;
			if (unloaded) return;
			this.timerAPI = setTimeout(() => this.pollSenecWebApi(retry), interval);
		} catch (error) {
			if (retry == this.config.retries && this.config.retries < 999) {
				this.log.error(
					"Error reading from SENEC Portal. Retried " +
						retry +
						" times. Giving up now. Check config and restart adapter. (" +
						error +
						")",
				);
				this.setState("info.connection", false, true);
			} else {
				retry += 1;
				this.log.warn(
					"Error reading from SENEC Portal. Retry " +
						retry +
						"/" +
						this.config.retries +
						" in " +
						(this.config.api_interval * 60000 * this.config.retrymultiplier * retry) / 1000 +
						" seconds! (" +
						error +
						")",
				);
				this.timerAPI = setTimeout(
					() => this.pollSenecWebApi(retry),
					this.config.api_interval * 60000 * this.config.retrymultiplier * retry,
				);
			}
		}
	}

	/** 
	 * Decodes StatusOverview from WebAPI
	 */
	async decodeStatusOverview(obj) {		
		const pfx = "_api.Portal.StatusOverview.";
		// store raw data
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Status Overview", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key == "wartungsplan" || key === "gridimport" || key === "gridexport" || key === "powergenerated" || key === "consumption" || key === "accuexport" || key === "accuimport" || key === "acculevel") {
				for (const [key2, value2] of Object.entries(value)) {
					if (key2 == "possibleMaintenanceTypes") continue; // skip this one
					this.log.debug("decodeStatusOverview: " + pfx + key + "." + key2 + ":" + value);
					await this.doState(pfx + key + "." + key2, ValueTyping(key2, JSON.stringify(value2)), "", "", false);
				}
			} else if (key === "lastupdated") {
				let date = new Date(value);
				this.log.debug("decodeStatusOverview: " + pfx + key + ":" + date.toString());
				await this.doState(pfx + key, date.toString(), "", "", false);
			} else {
				if (key === "suppressedNotificationIds")	continue; // skip this one - empty array
				this.log.debug("decodeStatusOverview: " + pfx + key + ":" + value);
				await this.doState(pfx + key, ValueTyping(key, value), "", "", false);
			}
		}
	}

	/** 
     * Decodes technischeDaten from WebAPI
	 */
	async decodeTechnischeDaten(obj) {		
		const pfx = "_api.Portal.TechnischeDaten.";
		// store raw data
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Status Overview", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key == "installationsdatum") {
				let date = new Date(value);
				this.log.debug("decodeTechnischeDaten: " + pfx + key + ":" + date.toString());
				await this.doState(pfx + key, date.toString(), "", "", false);
			} else {
				this.log.debug("decodeTechnischeDaten: " + pfx + key + ":" + value);
				await this.doState(pfx + key, value, "", "", false);
			}
		}
	}

	/** 
    * Decodes Status24 from WebAPI
	*/
	async decodeStatus24(obj) {		
		const pfx = "_api.Portal.Status24.";
		// store raw data
		await this.doState(pfx + "json", JSON.stringify(obj), "Portal Status24", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key === "val") {
				const accuExportArr = value[0];
				const accuImportArr = value[1];
				const gridExportArr = value[2];
				const gridImportArr = value[3];
				const powergeneratedArr = value[4];
				const consumptionArr = value[5];

				// AccuExport
				let i = 0;
				for (const [ts, val] of accuExportArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "AccuExport." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "AccuExport." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "AccuExport.json", JSON.stringify(accuExportArr), "", "", false);

				// AccuImport
				i = 0;
				for (const [ts, val] of accuImportArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "AccuImport." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "AccuImport." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "AccuImport.json", JSON.stringify(accuImportArr), "", "", false);

				// GridExport
				i = 0;
				for (const [ts, val] of gridExportArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "GridExport." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "GridExport." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "GridExport.json", JSON.stringify(gridExportArr), "", "", false);

				// GridImport
				i = 0;
				for (const [ts, val] of gridImportArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "GridImport." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "GridImport." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "GridImport.json", JSON.stringify(gridImportArr), "", "", false);

				// PowerGenerated
				i = 0;
				for (const [ts, val] of powergeneratedArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "PowerGenerated." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "PowerGenerated." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "PowerGenerated.json", JSON.stringify(powergeneratedArr), "", "", false);

				// Consumption
				i = 0; 
				for (const [ts, val] of consumptionArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "Consumption." + i + ".ts", dateStr, "Timestamp", "", false);
					await this.doState(pfx + "Consumption." + i + ".value", Number(val.toFixed(3)), "", "", false);
				}
				await this.doState(pfx + "Consumption.json", JSON.stringify(consumptionArr), "", "", false);
			} else {
				await this.doState(pfx + key, ValueTyping(key, value), "", "", false);
			}
		}
	}

	/** 
    * Decodes decodeAutarky from WebAPI	* 
	*/
	async decodeAutarky(obj) {		
		const pfx = "_api.Portal.Autarky.";
		// store raw data
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Autarky", "", false);
		for (const [key, value] of Object.entries(obj)) {
			this.log.debug("decodeAutarky: " + pfx + key + ":" + value);
			await this.doState(pfx + key, ValueTyping(key, value), "", "%", false);
		}
	}

	/** 
    * Decodes AccuState from WebAPI
	*/
	async decodeAccuState(obj) {		
		const pfx = "_api.Portal.AccuState.";
		// store raw json
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Accu State", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key === "val") {
				const voltageArr = value[0];
				const currentArr = value[1];

				// Voltage
				let i = 0;
				for (const [ts, val] of voltageArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "Voltage." + i + ".ts", dateStr, "Timestamp", "", false);
					await this.doState(pfx + "Voltage." + i + ".value", Number(val.toFixed(3)), "Voltage", "V", false);
				}

				// Current
				i = 0;
				for (const [ts, val] of currentArr) {
					i++;
					const dateStr = new Date(ts).toString();
					await this.doState(pfx + "Current." + i + ".ts", dateStr, "Timestampe", "", false);
					await this.doState(pfx + "Current." + i + ".value", Number(val.toFixed(3)), "Power", "A", false);
				}
			} else if (key === "lastupdated") {
				await this.doState(pfx + key, new Date(value).toString(), "Last updated", "", false);
			} else {
				await this.doState(pfx + key, ValueTyping(key, value), "", "", false);
			}
		}
	}

	/** 
    * Decodes AccuSavings from WebAPI
	*/
	async decodeAccuSavings(obj) {		
		const pfx = "_api.Portal.AccuSavings.";
		// store raw json
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Accu Savings", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key == "lastupdated") {
				await this.doState(pfx + key, new Date(value).toString(), "Last Update", "", false);
			} else {
				await this.doState(pfx + key, ValueTyping(key, value), "", "", false);
			}
		}
	}

	/** 
    * Decodes Status from WebAPI
	*/
	async decodeStatus(obj, typ) {		
		const pfx = "_api.Portal.Status." + typ + ".";
		// store raw json
		//await this.doState(pfx + "_json", JSON.stringify(obj), "Portal Status", "", false);
		for (const [key, value] of Object.entries(obj)) {
			if (key == "val") { // includes six arrays for the last 24 hours for different metrics (order? : accu import, accu export, grid import, grid export, power generated, consumption)
				const yearly = await this.decodeYearlyValues(value);
				for (const [year, aggregation] of Object.entries(yearly)) {
					await this.doState(pfx + year, Number(aggregation.toFixed(3)), "", "", false);
				}
			} else if (key == "lastupdated") {
				await this.doState(pfx + key, new Date(value).toString(), "Last Updated", "", false);
			} else {
				await this.doState(pfx + key, ValueTyping(key, value), "", "", false);
			}
		}
	}

	/**
	 * Converts SENEC yearly arrays into {year: value} object.
	 */
	async decodeYearlyValues(val) {
		if (!val || !Array.isArray(val)) return {};

		const result = {};

		for (const [ts, value] of val) {
			const year = new Date(ts).getFullYear(); // get year from timestamp
			result[year] = Number(value.toFixed(3)); // round to 3 decimal places 
		}
		return result;
	}

	/**
	 * Decodes Dashboard information from SENEC App API
	 * @deprecated
	 */
	async decodeDashboard(system, obj) {
		const pfx = "_api.Anlagen." + system + ".Dashboard.";
		for (const [key, value] of Object.entries(obj)) {
			this.log.debug("(decodeDashboard) Key: " + key + " - Value:" + JSON.stringify(value));
			if (key == "timestamp" || key == "electricVehicleConnected") {
				await this.doState(pfx + key, value, "", "", false);
			} else {
				for (const [key2, value2] of Object.entries(value)) {
					this.log.debug("(decodeDashboard) Key2: " + key2 + " - Value: " + JSON.stringify(value2));
					const keyParts = ParseApi2KeyParts(key2);
					await this.doState(pfx + key + "." + key2, Number(value2.toFixed(2)), "", keyParts.unit, false);
					if (kiloList.includes(keyParts.unit)) {
						await this.doState(
							pfx + key + "." + keyParts.prefix + " (k" + keyParts.unit + ")",
							Number((value2 / 1000).toFixed(2)),
							"",
							"k" + keyParts.unit,
							false,
						);
					}
				}
			}
		}
	}

	/**
	 * Decodes Statistik information from SENEC App API
	 * @deprecated
	 */
	async decodeStatistik(system, obj, period) {
		if (obj == null || obj == undefined || obj.aggregation == null || obj.aggregation == undefined) return; // could happen (e.g.) if we pull information for "last year" when the appliance isn't that old yet
		const pfx = "_api.Anlagen." + system + ".Statistik." + period + ".";
		for (const [key, value] of Object.entries(obj.aggregation)) {
			this.log.debug("decodeStatistic: " + pfx + key + ":" + value);
			// only reading 'aggregation' - no interest in fine granular information
			if (key == "startDate") {
				await this.doState(pfx + key, value, "", "", false);
			} else {
				if (!this.config.api_alltimeRebuild) {
					// don't update DPs if we are AllTime-Rebuild-Process
					await this.doState(pfx + key, Number(value.value.toFixed(2)), "", value.unit, false);
					if (kiloList.includes(value.unit)) {
						await this.doState(
							pfx + key + " (k" + value.unit + ")",
							Number((value.value / 1000).toFixed(2)),
							"",
							"k" + value.unit,
							false,
						);
					}
				}
				if (period == api_trans["THIS_YEAR"].dp)
					await this.insertAllTimeHistory(
						system,
						key,
						new Date(obj.aggregation.startDate).getFullYear(),
						Number(value.value.toFixed(0)),
						value.unit,
					);
			}
		}
		if (obj.aggregation.totalUsage.value != 0) {
			const autarky = Number(
				(
					((obj.aggregation.generation.value -
						obj.aggregation.gridFeedIn.value -
						obj.aggregation.storageLoad.value +
						obj.aggregation.storageConsumption.value) /
						obj.aggregation.totalUsage.value) *
					100
				).toFixed(2),
			);
			await this.doState(pfx + "Autarkie", autarky, "", "%", false);
		}
		await this.updateAllTimeHistory(system);
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
		const stats = statsObj ? JSON.parse(statsObj.val) : {};
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
		const stats = statsObj ? JSON.parse(statsObj.val) : {};
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
	 * Rebuilds AllTimeHistory from SENEC App API
	 */
	async rebuildAllTimeHistory(system) {
		if (!this.config.api_use || !apiConnected) {
			this.log.info("Usage of SENEC App API not configured or not connected.");
			return;
		}

		this.log.info("Rebuilding AllTime History ...");
		let year = new Date(new Date().getFullYear() - 1, 1, 1).toISOString().split("T")[0]; // starting last year, because we already got current year covered
		let body = "";
		try {
			while (new Date(year).getFullYear() > 2008) {
				// senec was founded in 2009 by Mathias Hammer as Deutsche Energieversorgung GmbH (DEV) - so no way we have older data :)
				this.log.info("Rebuilding AllTime History - Year: " + new Date(year).getFullYear());
				const baseUrl = apiMonitorUrl + "/" + system;
				let url = "";
				const tzObj = await this.getStateAsync("_api.Anlagen." + system + ".zeitzone");
				const tz = tzObj ? encodeURIComponent(tzObj.val) : encodeURIComponent("Europe/Berlin");
				url = baseUrl + "/data?period=YEAR&date=" + year + "&locale=de_DE&timezone=" + tz;
				this.log.debug("Polling: " + url);
				body = await this.doGet(url, "", this, this.config.pollingTimeout, false);
				await this.decodeStatistik(system, JSON.parse(body), api_trans["THIS_YEAR"].dp);
				year = new Date(new Date(year).getFullYear() - 1, 1, 1).toISOString().split("T")[0];
				if (unloaded) return;
			}
		} catch (error) {
			this.log.info("Rebuild ended: " + error);
		}
		this.log.info("Restarting ...");
		this.extendForeignObject(`system.adapter.${this.namespace}`, { native: { api_alltimeRebuild: false } });
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
	 */
	async evalPoll(obj) {
		if (unloaded) return;
		for (const [key1, value1] of Object.entries(obj)) {
			for (const [key2, value2] of Object.entries(value1)) {
				if (value2 !== "VARIABLE_NOT_FOUND" && key2 !== "OBJECT_NOT_FOUND") {
					const key = key1 + "." + key2;
					if (state_attr[key] === undefined) {
						this.log.debug(
							"REPORT_TO_DEV: State attribute definition missing for: " + key + ", Val: " + value2,
						);
					}
					const desc = state_attr[key] !== undefined ? state_attr[key].name : key2;
					const unit = state_attr[key] !== undefined ? state_attr[key].unit : "";

					if (Array.isArray(value2)) {
						for (let i = 0; i < value2.length; i++) {
							this.doState(key + "." + i, ValueTyping(key, value2[i]), desc + "[" + i + "]", unit, false);
						}
					} else {
						this.doState(key, ValueTyping(key, value2), desc, unit, false);
					}
				}
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

const ParseApi2KeyParts = (key) => {
	//const match = key.match(/In([A-Za-z]+)$/);
	//var unit = match ? match[1] : "";
	//if (unit == "Percent") unit = "%";
	//return unit;
	const match = key.match(/^(.*)In([A-Za-z]+)$/);
	if (match) {
		return {
			prefix: match[1], // part before "In"
			unit: match[2] === "Percent" ? "%" : match[2], // replace "Percent" with "%"
		};
	}
	return {
		// default response for error
		prefix: "unknownKey",
		unit: "",
	};
};

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

/**
 * Returns the current day of the year
 */
//const getCurDay = () => {
//	return (Math.round((new Date().setHours(23) - new Date(new Date().getYear()+1900, 0, 1, 0, 0, 0))/1000/60/60/24));
//}

/**
 * Returns the current month of the year
 */
//const getCurMonth = () => {
//	return (new Date().getMonth());
//}

/**
 * Returns the current year
 */
//const getCurYear = () => {
//	return (new Date().getFullYear());
//}

/**
 * Returns the current week of the year
 * Using Standard ISO8601
 */
//const getCurWeek = () => {
//	var tdt = new Date();
//	var dayn = (tdt.getDay() + 6) % 7;
//	tdt.setDate(tdt.getDate() - dayn + 3);
//	var firstThursday = tdt.valueOf();
//	tdt.setMonth(0, 1);
//	if (tdt.getDay() !== 4) {
//		tdt.setMonth(0, 1 + ((4 - tdt.getDay()) + 7) % 7);
//	}
//	return 1 + Math.ceil((firstThursday - tdt) / 604800000);
//};

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
