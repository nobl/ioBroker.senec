'use strict';

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

const utils = require('@iobroker/adapter-core');
const request = require('request');
const mode_desc = require(__dirname + '/lib/mode_desc.js');
const state_attr = require(__dirname + '/lib/state_attr.js');

let retry = 0; // retry-counter

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
        this.log.debug("Configured polling interval: " + this.config.interval);
        if (this.config.interval < 1 || this.config.interval > 3600) {
            this.log.warn("Config interval " + this.config.interval + " not [1..3600] seconds. Using default: 10");
            this.config.interval = 10;
        }
        this.log.debug("Configured polling timout: " + this.config.pollingTimeout);
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
        const form = '{"STATISTIC":{"STAT_DAY_E_HOUSE":""}}';
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
        // From current senec cgi
        //"STATISTIC":{"STAT_DAY_E_HOUSE":"","STAT_DAY_E_PV":"","STAT_DAY_BAT_CHARGE":"","STAT_DAY_BAT_DISCHARGE":"","STAT_DAY_E_GRID_IMPORT":"","STAT_DAY_E_GRID_EXPORT":"","STAT_YEAR_E_PU1_ARR":""}
        //"ENERGY":{"STAT_STATE":"","STAT_STATE_DECODE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","STAT_MAINT_REQUIRED":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":"","GUI_BAT_DATA_VOLTAGE":"","GUI_BAT_DATA_CURRENT":"","STAT_HOURS_OF_OPERATION":""}
        //"WIZARD":{"CONFIG_LOADED":"","SETUP_NUMBER_WALLBOXES":"","SETUP_WALLBOX_SERIAL0":"","SETUP_WALLBOX_SERIAL1":"","SETUP_WALLBOX_SERIAL2":"","SETUP_WALLBOX_SERIAL3":"","GUI_LANG":"","FEATURECODE_ENTERED":"","APPLICATION_VERSION":"","INTERFACE_VERSION":""}
        //"SYS_UPDATE":{"UPDATE_AVAILABLE":"","NPU_VER":"","NPU_IMAGE_VERSION":""}
        //"LOG":{"USER_LEVEL":"","USERNAME":""}
        //"RTC":{"WEB_TIME":""}
        //"FEATURES":{}
        //"BMS":{"MODULE_COUNT":"","MODULES_CONFIGURED":""}

        const url = 'http://' + this.config.senecip + '/lala.cgi';
        const form = '{"STATISTIC":{"STAT_DAY_E_HOUSE":"","STAT_DAY_E_PV":"","STAT_DAY_BAT_CHARGE":"","STAT_DAY_BAT_DISCHARGE":"","STAT_DAY_E_GRID_IMPORT":"","STAT_DAY_E_GRID_EXPORT":""},"ENERGY":{"STAT_STATE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","STAT_MAINT_REQUIRED":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":"","GUI_BAT_DATA_VOLTAGE":"","GUI_BAT_DATA_CURRENT":"","STAT_HOURS_OF_OPERATION":""},"WIZARD":{"CONFIG_LOADED":"","SETUP_NUMBER_WALLBOXES":"","SETUP_WALLBOX_SERIAL0":"","SETUP_WALLBOX_SERIAL1":"","SETUP_WALLBOX_SERIAL2":"","SETUP_WALLBOX_SERIAL3":"","APPLICATION_VERSION":"","INTERFACE_VERSION":""},"SYS_UPDATE":{"UPDATE_AVAILABLE":"","NPU_VER":"","NPU_IMAGE_VERSION":""},"BMS":{"MODULE_COUNT":"","MODULES_CONFIGURED":""}}';

        try {
            const body = await this.doGet(url, form, this, this.config.pollingTimeout);
            var obj = JSON.parse(body, reviverNumParse);

            // this only works, while senec sticks with format {"CAT1":{"ST1":"V1","STn":"Vn"},"CAT2":{...}...}
            for (let[key1, value1]of Object.entries(obj)) {
                for (let[key2, value2]of Object.entries(value1)) {
                    if (value2 !== "VARIABLE_NOT_FOUND") {
                        const key = key1 + '.' + key2;
                        if (state_attr[key] === undefined) {
                            this.log.warn('State attribute definition missing for + ' + key);
                        }
                        const desc = (state_attr[key] !== undefined) ? state_attr[key].name : "undefined";
                        const unit = (state_attr[key] !== undefined) ? state_attr[key].unit : "";
                        var value = value2;
                        if (state_attr[key] !== undefined && state_attr[key].booltype) {
                            value = (value2 === 0) ? false : true;
                        }
                        this.doState(key, value, desc, unit);
                    }
                }
            }
            // this isn't part of the JSON but we supply it as an additional state for easier reading of system-mode
            const key = "ENERGY.STAT_STATE_Text";
            const desc = (state_attr[key] !== undefined) ? state_attr[key].name : "undefined";
            const unit = (state_attr[key] !== undefined) ? state_attr[key].unit : "";
            if (mode_desc[obj.ENERGY.STAT_STATE] === undefined) {
                this.log.warn('Senec mode definition missing for + ' + obj.ENERGY.STAT_STATE);
            }
            var value = (mode_desc[obj.ENERGY.STAT_STATE] !== undefined) ? mode_desc[obj.ENERGY.STAT_STATE].name : "unknown";
            this.doState(key, value, desc, unit);

            /*
             * unknown use: ENERGY.STAT_STATE_DECODE	Ex. Value: u8_0F
             * unknown use: STATISTIC.STAT_YEAR_E_PU1_ARR is an array with just 0 values
             *
             * In regards to wallboxes there might be a value designating status (like loading, car signals problem soandso, ...).
             * Need examples for the JSON to add this.
             */

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
        if (oldState && oldState.val === value)
            return; // if value didn't change, don't update
        await this.setStateAsync(name, {
            val: value,
            ack: true
        });
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
        var sign = (int >>> 31) ? -1 : 1;
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
 * Reviver function to convert numeric values to float or int.
 * Senec supplies them as hex.
 * @param key value pair as defined in reviver option
 */
const reviverNumParse = (key, value) => {
    // prepare values for output using reviver function
    if (typeof value === "string") {
        if (value.startsWith("fl_")) { // float in hex IEEE754
            return HexToFloat32(value.substring(3));
        } else if (value.startsWith("u") || value.startsWith("u")) { // unsigned int in hex
            return parseInt(value.substring(3), 16);
        } else if (value.startsWith("st_")) { // string?
            return value.substring(3);
        } else if (value.startsWith("VARIABLE_NOT_FOUND")) {
            return "VARIABLE_NOT_FOUND";
        } else {
            return "REPORT DO DEV: " + key + ":" + value.substring(3);
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
