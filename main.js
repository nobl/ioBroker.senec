'use strict';

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

const utils = require('@iobroker/adapter-core');
const request = require('request');
const mode_desc = require(__dirname + '/lib/mode_desc.js');
const sys_type_desc = require(__dirname + '/lib/sys_type_desc.js');
const country_desc = require(__dirname + '/lib/country_desc.js');
const batt_type_desc = require(__dirname + '/lib/batt_type_desc.js');
const state_attr = require(__dirname + '/lib/state_attr.js');

let retry = 0; // retry-counter
let retryLowPrio = 0; // retry-counter

class Senec extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'senec',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);
        try {
            await this.checkConfig();
            await this.checkConnection();
            await this.readSenecV21();
            await this.readSenecV21LowPrio();
        } catch (error) {
            this.log.error(error);
            this.setState('info.connection', false, true);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (this.timer) {
                clearTimeout(this.timer);
            }
            if (this.timerLowPrio) {
                clearTimeout(this.timerLowPrio);
            }
            this.log.info('cleaned everything up...');
            this.setState('info.connection', false, false);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * checks config paramaters
     * Fallback to default values in case they are out of scope
     */
    async checkConfig() {
        this.log.debug("Configured polling interval high priority: " + this.config.interval);
        if (this.config.interval < 1 || this.config.interval > 3600) {
            this.log.warn("Config interval high priority " + this.config.interval + " not [1..3600] seconds. Using default: 10");
            this.config.interval = 10;
        }
        this.log.debug("Configured polling interval low priority: " + this.config.intervalLow);
        if (this.config.intervalLow < 60 || this.config.intervalLow > 3600) {
            this.log.warn("Config interval low priority " + this.config.intervalLow + " not [60..3600] minutes. Using default: 60");
            this.config.intervalLow = 60;
        }
        this.log.debug("Configured polling timeout: " + this.config.pollingTimeout);
        if (this.config.pollingTimeout < 1000 || this.config.pollingTimeout > 10000) {
            this.log.warn("Config timeout " + this.config.pollingTimeout + " not [1000..10000] ms. Using default: 5000");
            this.config.pollingTimeout = 5000;
        }
        this.log.debug("Configured num of retries: " + this.config.retries);
        if (this.config.retries < 0 || this.config.retries > 999) {
            this.log.warn("Config num of retries " + this.config.retries + " not [0..999] seconds. Using default: 10");
            this.config.retries = 10;
        }
        this.log.debug("Configured retry multiplier: " + this.config.retrymultiplier);
        if (this.config.retrymultiplier < 1 || this.config.retrymultiplier > 10) {
            this.log.warn("Config retry multiplier " + this.config.retrymultiplier + " not [1..10] seconds. Using default: 2");
            this.config.retrymultiplier = 2;
        }
    }

    /**
     * checks connection to senec service
     */
    async checkConnection() {
        const url = 'http://' + this.config.senecip + '/lala.cgi';
        const form = '{"ENERGY":{"STAT_STATE":""}}';
        try {
            this.log.info('connecting to Senec: ' + this.config.senecip);
            const body = await this.doGet(url, form, this, this.config.pollingTimeout);
            this.log.info('connected to Senec: ' + this.config.senecip);
            this.setState('info.connection', true, true);
        } catch (error) {
            throw new Error("Error connecting to Senec (IP: " + this.config.senecip + "). Exiting! (" + error + ")");
        }
    }

    /**
     * Read from url via request
     * @param url to read from
     * @param form to post
     */
    async doGet(pUrl, pForm, caller, pollingTimeout) {
        return new Promise(function (resolve, reject) {
            const options = {
                url: pUrl,
                method: 'POST',
                form: pForm,
                timeout: pollingTimeout
            };
            request(options, function (error, response, body) {
                if (error)
                    return reject(error);
                caller.log.debug('Status: ' + response.statusCode);
                if (!response || response.statusCode !== 200)
                    return reject('Cannot read from SENEC: ' + response.statusCode);
                caller.log.debug('Response: ' + JSON.stringify(response));
                caller.log.debug('Body: ' + body);
                resolve(body);
            });
        });
    }

    /**
     * Read values from Senec Home V2.1
     * Leaving out Wallbox info because it won't be supplied by senec if no wallbox configured
     */
    async readSenecV21() {
        // read by webinterface are the following values. Not all are "high priority" though.
        // "STATISTIC":{"STAT_DAY_E_HOUSE":"","STAT_DAY_E_PV":"","STAT_DAY_BAT_CHARGE":"","STAT_DAY_BAT_DISCHARGE":"","STAT_DAY_E_GRID_IMPORT":"","STAT_DAY_E_GRID_EXPORT":"","STAT_YEAR_E_PU1_ARR":""}
        // "ENERGY":{"STAT_STATE":"","STAT_STATE_DECODE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","STAT_MAINT_REQUIRED":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":""}
        // "WIZARD":{"CONFIG_LOADED":""},"SYS_UPDATE":{"UPDATE_AVAILABLE":""}
        // "PV1":{"POWER_RATIO":""},"WIZARD":{"MAC_ADDRESS_BYTES":""},"BAT1OBJ1":{"BMS_NR_INSTALLED":"","SPECIAL_TIMEOUT":"","INV_CYCLE":"","TEMP1":"","TEMP2":"","TEMP3":"","TEMP4":"","TEMP5":"","SW_VERSION":"","SW_VERSION2":"","SW_VERSION3":"","I_DC":""},"BAT1OBJ2":{"TEMP1":"","TEMP2":"","TEMP3":"","TEMP4":"","TEMP5":"","I_DC":""},"BAT1OBJ3":{"TEMP1":"","TEMP2":"","TEMP3":"","TEMP4":"","TEMP5":"","I_DC":""},"PWR_UNIT":{"POWER_L1":"","POWER_L2":"","POWER_L3":""},"BAT1":{"CEI_LIMIT":""},"BMS":{}
        // "PM1OBJ1":{"FREQ":"","U_AC":"","I_AC":"","P_AC":"","P_TOTAL":""},"PM1OBJ2":{"FREQ":"","U_AC":"","I_AC":"","P_AC":"","P_TOTAL":""}
        // "ENERGY":{"STAT_HOURS_OF_OPERATION":"","STAT_DAYS_SINCE_MAINT":"","GUI_BAT_DATA_POWER":"","GUI_BAT_DATA_VOLTAGE":"","GUI_BAT_DATA_CURRENT":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_BAT_DATA_OA_CHARGING":"","STAT_SULFAT_CHRG_COUNTER":"","STAT_LIMITED_NET_SKEW":"","STAT_LIMITED_NO_STAND_BY":"","GUI_CAP_TEST_DIS_COUNT":"","GUI_SCHARGE_REMAIN":"","GUI_SCHARGE_ELAPSED":"","GUI_CHARGING_INFO":"","OFFPEAK_DURATION":"","OFFPEAK_RUNNING":"","OFFPEAK_CURRENT":"","OFFPEAK_TARGET":""},"SYS_UPDATE":{"NPU_VER":"","NPU_IMAGE_VERSION":""}}

        const url = 'http://' + this.config.senecip + '/lala.cgi';
        var form = '{';
        form += '"ENERGY":{"STAT_STATE":"","STAT_STATE_DECODE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":"","GUI_BAT_DATA_POWER":"","GUI_BAT_DATA_VOLTAGE":"","GUI_BAT_DATA_CURRENT":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_BAT_DATA_OA_CHARGING":"","STAT_LIMITED_NET_SKEW":""}';
		// MPP_INT got replaced by MPP_POWER but might still be in use by some machines. Can be removed at a later point in time. (includes state_attr) 2020-10-22
        form += ',"PV1":{"POWER_RATIO":"","MPP_POWER":"","MPP_INT":""}';
        form += ',"PWR_UNIT":{"POWER_L1":"","POWER_L2":"","POWER_L3":""}';
        form += ',"PM1OBJ1":{"FREQ":"","U_AC":"","I_AC":"","P_AC":"","P_TOTAL":""}';
        form += ',"PM1OBJ2":{"FREQ":"","U_AC":"","I_AC":"","P_AC":"","P_TOTAL":""}';
        form += '}';

        try {
            const body = await this.doGet(url, form, this, this.config.pollingTimeout);
            var obj = JSON.parse(body, reviverNumParse);

            await this.evalPoll(obj);

            // this isn't part of the JSON but we supply it as an additional state for easier reading of system-mode
            const key = "ENERGY.STAT_STATE_Text";
            const desc = (state_attr[key] !== undefined) ? state_attr[key].name : "undefined";
            const unit = (state_attr[key] !== undefined) ? state_attr[key].unit : "";
            if (mode_desc[obj.ENERGY.STAT_STATE] === undefined) {
                this.log.warn('Senec mode definition missing for + ' + obj.ENERGY.STAT_STATE);
            }
            var value = (mode_desc[obj.ENERGY.STAT_STATE] !== undefined) ? mode_desc[obj.ENERGY.STAT_STATE].name : "unknown";
            this.doState(key, value, desc, unit);

            retry = 0;
            this.timer = setTimeout(() => this.readSenecV21(), this.config.interval * 1000);
        } catch (error) {
            if ((retry == this.config.retries) && this.config.retries < 999) {
                this.log.error("Error reading from Senec (" + this.config.senecip + "). Retried " + retry + " times. Giving up now. Check config and restart adapter. (" + error + ")");
                this.setState('info.connection', false, true);
            } else {
                retry += 1;
                this.log.warn("Error reading from Senec (" + this.config.senecip + "). Retry " + retry + "/" + this.config.retries + " in " + this.config.interval * this.config.retrymultiplier * retry + " seconds! (" + error + ")");
                this.timer = setTimeout(() => this.readSenecV21(), this.config.interval * this.config.retrymultiplier * retry * 1000);
            }
        }
    }

    /**
     * Read ALL values from Senec Home V2.1
     * This causes high demand on the SENEC machine so it shouldn't run too often. Adverse effects: No sync with Senec possible if called too often.
     */
    async readSenecV21LowPrio() {
        this.log.info('LowPrio polling ...');
        // we are polling all known objects ...

        const url = 'http://' + this.config.senecip + '/lala.cgi';
        const form = '{"STATISTIC":{},"ENERGY":{},"FEATURES":{},"LOG":{},"SYS_UPDATE":{},"WIZARD":{},"BMS":{},"BAT1":{},"BAT1OBJ1":{},"BAT1OBJ2":{},"BAT1OBJ2":{},"BAT1OBJ3":{},"BAT1OBJ4":{},"PWR_UNIT":{},"PV1":{},"FACTORY":{},"GRIDCONFIG":{}}';

        try {
            const body = await this.doGet(url, form, this, this.config.pollingTimeout);
            var obj = JSON.parse(body, reviverNumParse);

            await this.evalPoll(obj);

            retryLowPrio = 0;
            this.timerLowPrio = setTimeout(() => this.readSenecV21LowPrio(), this.config.intervalLow * 1000 * 60);
        } catch (error) {
            if ((retryLowPrio == this.config.retries) && this.config.retries < 999) {
                this.log.error("Error reading from Senec lowPrio (" + this.config.senecip + "). Retried " + retryLowPrio + " times. Giving up now. Check config and restart adapter. (" + error + ")");
                this.setState('info.connection', false, true);
            } else {
                retryLowPrio += 1;
                this.log.warn("Error reading from Senec lowPrio (" + this.config.senecip + "). Retry " + retryLowPrio + "/" + this.config.retries + " in " + this.config.interval * this.config.retrymultiplier * retryLowPrio + " minutes! (" + error + ")");
                this.timerLowPrio = setTimeout(() => this.readSenecV21LowPrio(), this.config.interval * this.config.retrymultiplier * retryLowPrio * 1000 * 60);
            }
        }
    }

    /**
     * sets a state's value and creates the state if it doesn't exist yet
     */
    async doState(name, value, description, unit) {
        await this.setObjectNotExistsAsync(name, {
            type: 'state',
            common: {
                name: description,
                type: typeof(value),
                role: 'value',
                unit: unit,
                read: true,
                write: false
            },
            native: {}
        });
        var oldState = await this.getStateAsync(name);
        if (oldState) {
            if (oldState.val === value)
                return;
            this.log.silly('Update: ' + name + ': ' + oldState.val + ' -> ' + value);
        }
        await this.setStateAsync(name, {
            val: value,
            ack: true
        });
    }

	/**
	 * evaluates data polled from SENEC system.
	 * creates / updates the state.
	 */
    async evalPoll(obj) {
        for (let[key1, value1]of Object.entries(obj)) {
            for (let[key2, value2]of Object.entries(value1)) {
                if (value2 !== "VARIABLE_NOT_FOUND" && key2 !== "OBJECT_NOT_FOUND") {
                    const key = key1 + '.' + key2;
                    if (state_attr[key] === undefined) {
                        this.log.debug('REPORT_TO_DEV: State attribute definition missing for: ' + key + ', Val: ' + value2);
                    }	
                    const desc = (state_attr[key] !== undefined) ? state_attr[key].name : key2;
                    const unit = (state_attr[key] !== undefined) ? state_attr[key].unit : "";

                    if (Array.isArray(value2)) {
                        for (var i = 0; i < value2.length; i++) {
                            this.doState(key + '.' + i, ValueTyping(key, value2[i]), desc + '[' + i + ']', unit);
                        }
                    } else {
                        this.doState(key, ValueTyping(key, value2), desc, unit);
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
	if (key === "FACTORY.SYS_TYPE") {
        return (sys_type_desc[value] !== undefined) ? sys_type_desc[value].name : "unknown";
	}
	if (key === "FACTORY.COUNTRY") {
        return (country_desc[value] !== undefined) ? country_desc[value].name : "unknown";
	}
	if (key === "FACTORY.BAT_TYPE") {
        return (batt_type_desc[value] !== undefined) ? batt_type_desc[value].name : "unknown";
	}
    if (state_attr[key] === undefined) {
        return value;
    }
	const isBool = (state_attr[key] !== undefined && state_attr[key].booltype) ? state_attr[key].booltype : false;
	const isDate = (state_attr[key] !== undefined && state_attr[key].datetype) ? state_attr[key].datetype : false;
	const isIP = (state_attr[key] !== undefined && state_attr[key].iptype) ? state_attr[key].iptype : false;
	const multiply = (state_attr[key] !== undefined && state_attr[key].multiply) ? state_attr[key].multiply : 1;
    if (isBool) {
        return (value === 0) ? false : true;
    } else if (isDate) {
        return new Date(value * 1000).toString();
    } else if (isIP) {
        return DecToIP(value);
    } else if (multiply !== 1) {
        return (value *= multiply).toFixed(2);
    } else {
        return value;
    }
}

/**
 * Converts float value in hex format to js float32.
 * Also fixes to 2 decimals.
 * @param string with hex value
 */
const HexToFloat32 = (str) => {
    var int = parseInt(str, 16);
    if (int > 0 || int < 0) {
        // var sign = (int >>> 31) ? -1 : 1;
        var sign = (int & 0x80000000) ? -1 : 1;
        var exp = (int >>> 23 & 0xff) - 127;
        var mantissa = ((int & 0x7fffff) + 0x800000).toString(2);
        var float32 = 0;
        for (var i = 0; i < mantissa.length; i++) {
            float32 += parseInt(mantissa[i]) ? Math.pow(2, exp) : 0;
            exp--;
        }
        return (float32 * sign).toFixed(2);
    } else {
        return 0;
    }
}

/**
 * Converts a given decimal to a properly formatted IP address.
 * We have to do that because Senec stores IPs as regular hex values and due to the fact that we
 * are using a reviver function for the JSON we have to back-convert to hex and then build the IP
 * for proper human reading.
 */
const DecToIP = (str) => {
    var ipHex = str.toString(16);
    while (ipHex.length < 8) {
        ipHex = '0' + ipHex;
    }
    const fourth = ipHex.substring(0, 2);
    const third = ipHex.substring(2, 4);
    const second = ipHex.substring(4, 6);
    const first = ipHex.substring(6);
    return (parseInt(first, 16) + '.' + parseInt(second, 16) + '.' + parseInt(third, 16) + '.' + parseInt(fourth, 16));
}

/**
 * Reviver function to convert numeric values to float or int.
 * Senec supplies them as hex.
 * @param key value pair as defined in reviver option
 */
const reviverNumParse = (key, value) => {
    // prepare values for output using reviver function
    if (typeof value === "string") {
        if (value.startsWith("fl_")) { // float in hex IEEE754
            return HexToFloat32(value.substring(3));
        } else if (value.startsWith("u")) { // unsigned int in hex
            return parseInt(value.substring(3), 16);
        } else if (value.startsWith("st_")) { // string?
            return value.substring(3);
        } else if (value.startsWith("i1")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((val & 0x8000) > 0) {
                    val = val - 0x10000;
                }
                return val;
            } else
                return 0;

        } else if (value.startsWith("i3")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((Math.abs(value & 0x80000000)) > 0) {
                    val = val - 0x100000000;
                }
                return val;
            } else
                return 0;

        } else if (value.startsWith("i8")) { // int
            var val = parseInt(value.substring(3), 16);
            if (!isNaN(val)) {
                if ((value & 0x80) > 0) {
                    val = val - 0x100;
                }
                return val;
            } else
                return 0;
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
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Senec(options);
} else {
    // otherwise start the instance directly
    new Senec();
}
