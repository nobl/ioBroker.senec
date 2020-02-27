'use strict';

/*
 * Created with @iobroker/create-adapter v1.17.0
 */

const utils = require('@iobroker/adapter-core');
const request = require('request');

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

        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info('config senecip: ' + this.config.senecip);

        if (!this.config.senecip || this.config.senecip === "0.0.0.0") {
            this.terminate("No Senec system supplied. Exiting!");
            this.stop();
        }

        this.readSenecV21();

        this.setState('info.connection', true, true);

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
     * Read values from Senec Home V2.1
     * Leaving out Wallbox info because it won't be supplied by senec if no wallbox configured
     */
    readSenecV21() {
        //this.log.info('reading from senec: ' + this.config.senecip);

        try {
            request.post({
                url: 'http://' + this.config.senecip + '/lala.cgi',
                // From current senec cgi
                // '{"STATISTIC":{"STAT_DAY_E_HOUSE":"","STAT_DAY_E_PV":"","STAT_DAY_BAT_CHARGE":"","STAT_DAY_BAT_DISCHARGE":"","STAT_DAY_E_GRID_IMPORT":"","STAT_DAY_E_GRID_EXPORT":"","STAT_YEAR_E_PU1_ARR":""},"ENERGY":{"STAT_STATE":"","STAT_STATE_DECODE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","STAT_MAINT_REQUIRED":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":""},"WIZARD":{"CONFIG_LOADED":""},"SYS_UPDATE":{"UPDATE_AVAILABLE":""}}'
                form: '{"STATISTIC":{"STAT_DAY_E_HOUSE":"","STAT_DAY_E_PV":"","STAT_DAY_BAT_CHARGE":"","STAT_DAY_BAT_DISCHARGE":"","STAT_DAY_E_GRID_IMPORT":"","STAT_DAY_E_GRID_EXPORT":""},"ENERGY":{"STAT_STATE":"","GUI_BAT_DATA_POWER":"","GUI_INVERTER_POWER":"","GUI_HOUSE_POW":"","GUI_GRID_POW":"","STAT_MAINT_REQUIRED":"","GUI_BAT_DATA_FUEL_CHARGE":"","GUI_CHARGING_INFO":"","GUI_BOOSTING_INFO":""},"WIZARD":{"CONFIG_LOADED":""},"SYS_UPDATE":{"UPDATE_AVAILABLE":""}}'
            }, (error, response, body) => {
                if (error) {
                    this.terminate('Request to senec failed: ' + error);
                    this.stop();
                }

                // this.log.info('received data from senec (' + response.statusCode + '): ' + body);

                var obj = JSON.parse(body, reviverNumParse);

                // this only works, while senec sticks with format {"CAT1":{"ST1":"V1","STn":"Vn"},"CAT2":{...}...}
                for (let[key1, value1]of Object.entries(obj)) {
                    for (let[key2, value2]of Object.entries(value1)) {
                        var key = key1 + '.' + key2;
                        var descUnitValue = getDescUnitValue(String(key1), String(key2), value2);
                        var desc = descUnitValue[0];
                        var unit = descUnitValue[1];
                        var value = descUnitValue[2];
                        this.doState(key, value, desc, unit);
                    }
                }
                // this isn't part of the JSON but we supply it for easier reading of system-state
                var descUnitValue = getDescUnitValue("ENERGY", "STAT_STATE-Text", obj.ENERGY.STAT_STATE);
                this.doState("ENERGY.STAT_STATE_Text", descUnitValue[2], descUnitValue[0], descUnitValue[1]);

                /*
                 * unknown use: ENERGY.STAT_STATE_DECODE	Ex. Value: u8_0F
                 * unknown use: STATISTIC.STAT_YEAR_E_PU1_ARR is an array with just 0 values
                 *
                 * some have WIZARD.SETUP_NUMBER_WALLBOXES and WIZARD.SETUP_WALLBOX_SERIAL[0..3] but those don't exist on every system it appears.
                 * Need to find out if this depends on wallbox configured so maybe add a switch to admin panel.
                 */

            })
        } catch (e) {
            this.terminate(e);
            this.stop();
        }

        this.timer = setTimeout(() => this.readSenecV21(), this.config.interval * 1000);
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
		if (oldState && oldState.val === value) return; // if value didn't change, don't update
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
        } else {
            throw new Error("Unknon value in JSON: " + key + ":" + value);
        }
    } else {
        return value;
    }
}

/**
 * Translate senec numeric system state to the official human readable representation.
 * Please report unknown values.
 * @param numeric state value
 */
const stateHumanForm = (state) => {
	// if you can supply me with the correct (senec chargon!) values in english, please open a ticket
    switch (state) {
    case 8:
        return "Maximale Sicherheitsladung";
    case 9:
        return "Sicherheitsladung fertig";
    case 13:
        return "Akku voll";
    case 14:
        return "Laden";
    case 15:
        return "Akku leer";
    case 16:
        return "Entladen";
    case 17:
        return "Entladen + PV";
    case 18:
        return "Entladen + Netz";
    case 20:
        return "Ausgeschaltet";
    case 21:
        return "Eigenverbrauch";
    case 36:
        return "FEHLER: NA-SCHUTZ NETZ";
    case 39:
        return "BMS Fehler";
    case 54:
        return "Ladeschlussphase";
    case 56:
        return "PEAK-SHAVING: WARTEN";
    default:
        return "Unknown: " + state + " (Please report to Dev)";
    }
}

/**
 * Returns the description, unit and (if needed) a modified value for a state object
 * @param the two keys per JSON, current value
 * @return [description,unit,value]
 */
const getDescUnitValue = (key1, key2, value) => {
    var w = "W";
    var kwh = "kWh";
    var pct = "%";
    switch (key1) {
    case "ENERGY":
        switch (key2) {
        case "STAT_STATE":
            return ["System Mode", "", value];
        case "STAT_STATE-Text":
            return ["System Mode", "", stateHumanForm(value)];
        case "GUI_BAT_DATA_FUEL_CHARGE":
            return ["Accu Level", pct, value];
        case "GUI_INVERTER_POWER":
            return ["PV Power current", w, value];
        case "GUI_GRID_POW":
            return ["Net Power current", w, value];
        case "GUI_BAT_DATA_POWER":
            return ["Accu Power current", w, value];
        case "GUI_HOUSE_POW":
            return ["House Power current", w, value];
        case "GUI_CHARGING_INFO":
            return ["Accu charging", "", (value === 0 ? false : true)];
        case "GUI_BOOSTING_INFO":
            return ["Boost", "", (value === 0 ? false : true)];
        case "STAT_MAINT_REQUIRED":
            return ["Maintenance required", "", (value === 0 ? false : true)];
        }

    case "STATISTIC":
        switch (key2) {
        case "STAT_DAY_E_PV":
            return ["PV Power Day", kwh, value];
        case "STAT_DAY_E_GRID_IMPORT":
            return ["Net Import Day", kwh, value];
        case "STAT_DAY_E_GRID_EXPORT":
            return ["Net Export Day", kwh, value];
        case "STAT_DAY_BAT_CHARGE":
            return ["Accu Charged Day", kwh, value];
        case "STAT_DAY_BAT_DISCHARGE":
            return ["Accu Discharged Day", kwh, value];
        case "STAT_DAY_E_HOUSE":
            return ["House Power Day", kwh, value];
        }

    case "SYS_UPDATE":
        switch (key2) {
        case "UPDATE_AVAILABLE":
            return ["Update available", "", (value === 0 ? false : true)];
        }

    case "WIZARD":
        switch (key2) {
        case "CONFIG_LOADED":
            return ["Configuration loaded", "", (value === 0 ? false : true)];
        }

    }
    return ["Unknown: " + key1 + "." + key2, "", value];
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
