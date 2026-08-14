"use strict";

const API_PFX = "_api.";
const LAST_UPDATED = "last updated";
const TOKEN_STATE = `${API_PFX}refreshToken`;

// API Endpoints (updated June 2026)
const API_HOST_SYSTEMS = "https://senec-app-systems-proxy.prod.senec.dev/systems/api";
const API_HOST_MEASUREMENTS = "https://senec-app-measurements-proxy.prod.senec.dev/measurements/api";
const API_HOST_ABILITIES = "https://senec-app-abilities-proxy.prod.senec.dev/abilities/api";
const API_HOST_WALLBOX = "https://senec-app-wallbox-proxy.prod.senec.dev/wallbox/api";
const CONNECT_HOST = "https://apim-eds-gwc-prod.azure-api.net/senec-connect";
const WEB_HOST = "https://mein-senec.de";
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

const MIN_REBUILD_START_YEAR = 2009;

const REBUILD_MODE = Object.freeze({
	OFF: "off",
	RESUME: "resume",
	FORCE_FULL: "force_full",
});

const batteryOn =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"u8_01","SAFE_CHARGE_PROHIBIT":"","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
const batteryOff =
	'{"ENERGY":{"SAFE_CHARGE_FORCE":"","SAFE_CHARGE_PROHIBIT":"u8_01","SAFE_CHARGE_RUNNING":"","LI_STORAGE_MODE_START":"","LI_STORAGE_MODE_STOP":"","LI_STORAGE_MODE_RUNNING":"","STAT_STATE":""}}';
const rebootAppliance = '{"SYS_UPDATE":{"USER_REBOOT_DEVICE":"u8_01"}}';

const allKnownObjects = new Set([
	"AMPACE",
	"BAT1",
	"BAT1OBJ1",
	"BMS",
	"BMS_PARA",
	"BMZ_CURRENT_LIMITS",
	"CASC",
	"CELL_DEVIATION_ROC",
	"CURRENT_IMBALANCE_CONTROL",
	"DEBUG",
	"DISPLAY",
	"ENERGY",
	"FACTORY",
	"FAN_SPEED",
	"FAN_TEST",
	"FEATURES",
	"FILE",
	"GRIDCONFIG",
	"IPU",
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

// Sections deprecated by SENEC — still reported by device but no longer functional
const deprecatedSections = new Set(["STATISTIC"]);

/**
 * Converts float value in hex format to js float32.
 * Also fixes to 2 decimals.
 *
 * @param {string} str hex string
 * @returns {number | string} float value
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
 * What an existing state is set to once the appliance has said it does not have that datapoint.
 * Deliberately a plain sentence rather than the appliance's own marker word: it appears verbatim
 * in the object tree, so it has to read as an explanation. States are never removed for this —
 * clearing out states the appliance stopped reporting is a separate concern.
 */
const DATAPOINT_UNAVAILABLE = "not provided by appliance";

/**
 * The values the appliance sends instead of a reading when it will not or cannot deliver one.
 * `er_` is a prefix rather than a fixed word, so it is handled separately by isDeviceSentinel.
 */
const DEVICE_SENTINELS = ["VARIABLE_NOT_FOUND", "FORBIDDEN", "OBJECT_NOT_FOUND", "MALFORMED_VALUE"];

/**
 * Match a raw device string against the sentinel list.
 *
 * @param {unknown} value raw or decoded value
 * @returns {string | null} the canonical sentinel name, or null
 */
function matchSentinel(value) {
	if (typeof value !== "string") {
		return null;
	}
	return DEVICE_SENTINELS.find((name) => value.startsWith(name)) || null;
}

/**
 * Whether a decoded value means "the appliance did not deliver a reading".
 *
 * Covers the named sentinels and the `er_` error prefix. Callers must check this before
 * coercing a value to a number, boolean, date or IP: those conversions turn a sentinel into
 * a plausible-looking reading (`true`, `NaN`, "Invalid Date", a garbage address).
 *
 * @param {unknown} value decoded value as produced by reviverNumParse
 * @returns {boolean} true when the value is an unavailability marker rather than data
 */
function isDeviceSentinel(value) {
	return typeof value === "string" && (matchSentinel(value) !== null || value.startsWith("er_"));
}

/**
 * The markers that mean "this appliance does not have this datapoint", as opposed to "reading it
 * went wrong just now".
 *
 * Not every marker is permanent. A datapoint that is absent from the model, absent from the
 * section, or above the adapter's access level stays that way for the life of the installation —
 * nothing the adapter does later will make it appear. MALFORMED_VALUE and `er_` are the opposite:
 * the datapoint exists and the appliance failed to deliver it this once, so its state must be left
 * alone rather than removed.
 *
 * @param {unknown} value decoded value as produced by reviverNumParse
 * @returns {boolean} true when the datapoint is absent rather than temporarily unreadable
 */
function isAbsentSentinel(value) {
	const name = matchSentinel(value);
	return name === "VARIABLE_NOT_FOUND" || name === "OBJECT_NOT_FOUND" || name === "FORBIDDEN";
}

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
		} else if (/^u[1368]_/.test(value)) {
			// unsigned int in hex. The device's own decoder knows exactly u1/u3/u6/u8, so match
			// those rather than a bare leading "u" — that matched any lowercase-u string and
			// hex-parsed it, so "under_voltage" decoded to 14 and "unknownthing" to NaN, which
			// was then published as a number.
			const val = parseInt(value.substring(3), 16);
			if (!isNaN(val)) {
				return val;
			}
			return `REPORT TO DEV: ${key}:${value}`;
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
		} else if (value.startsWith("ch_")) {
			// char/string, same shape as st_. The device's own decoder (Senec.jsonValUnpack
			// in senec_values.js) knows this prefix; splitting on "_" the way it does would
			// truncate at the first underscore, so take everything after the prefix.
			return value.substring(3);
		} else if (value.startsWith("er_")) {
			// The device reports an error for this variable. Kept whole, prefix included, so
			// it cannot be mistaken for a reading — the device's decoder returns the bare
			// remainder, which is indistinguishable from real data.
			return value;
		}
		// The sentinels the device answers with when it will not or cannot read a datapoint.
		// FORBIDDEN is the one seen in practice: a datapoint above the adapter's user level,
		// which custom high-priority datapoints can ask for. All of them are normalised to
		// their bare name so that "is this a real reading?" has exactly one answer downstream
		// — see isDeviceSentinel, which ValueTyping uses to keep these out of the numeric,
		// boolean, date and IP conversions.
		const sentinel = matchSentinel(value);
		if (sentinel) {
			return sentinel;
		}
		if (value.startsWith("FILE_VARIABLE_NOT_READABLE")) {
			return "";
		}
		return `REPORT TO DEV: ${key}:${value}`;
		//throw new Error("Unknown value in JSON: " + key + ":" + value);
	}
	return value;
};

module.exports = {
	API_PFX,
	LAST_UPDATED,
	TOKEN_STATE,
	API_HOST_SYSTEMS,
	API_HOST_MEASUREMENTS,
	API_HOST_ABILITIES,
	API_HOST_WALLBOX,
	CONNECT_HOST,
	WEB_HOST,
	SSO_BASE_URL,
	SSO_AUTH_URL,
	SSO_TOKEN_URL,
	CONFIG,
	MIN_REBUILD_START_YEAR,
	REBUILD_MODE,
	batteryOn,
	batteryOff,
	rebootAppliance,
	allKnownObjects,
	deprecatedSections,
	HexToFloat32,
	reviverNumParse,
	DEVICE_SENTINELS,
	DATAPOINT_UNAVAILABLE,
	isDeviceSentinel,
	isAbsentSentinel,
};
