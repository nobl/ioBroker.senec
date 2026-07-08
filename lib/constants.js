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
};
