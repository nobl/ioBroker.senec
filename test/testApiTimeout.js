"use strict";

/**
 * Tests for the configurable API request timeout.
 *
 * Separate from findings B–J: this is the follow-up to a reported operational problem, where
 * Dashboard and SystemStatus requests were timing out against a slow SENEC API and the whole
 * tier was lost until the next poll cycle.
 *
 * The value reaches the adapter from a config field that an instance created before the
 * setting existed does not have at all, so resolution has to survive undefined, and an
 * out-of-range entry has to be pulled into range rather than honoured — a zero would disable
 * the timeout entirely and let a poll cycle hang.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const mainExport = proxyquire("../main", {
	"@iobroker/adapter-core": {
		Adapter: class FakeAdapter {
			constructor() {}
			on() {}
		},
		getAbsoluteDefaultDataDir: () => "/tmp",
	},
	axios: { create: () => ({}) },
	"axios-cookiejar-support": {},
	"tough-cookie": { CookieJar: class {} },
});

const { resolveApiTimeout } = mainExport._testing;

describe("resolveApiTimeout", () => {
	it("defaults to 30 seconds when the instance predates the setting", () => {
		assert.equal(resolveApiTimeout(undefined), 30000);
		assert.equal(resolveApiTimeout(null), 30000);
		assert.equal(resolveApiTimeout(""), 30000);
	});

	it("honours a configured value inside the allowed range", () => {
		assert.equal(resolveApiTimeout(45000), 45000);
		assert.equal(resolveApiTimeout("45000"), 45000);
	});

	it("accepts the exact bounds the admin field allows", () => {
		assert.equal(resolveApiTimeout(5000), 5000);
		assert.equal(resolveApiTimeout(120000), 120000);
	});

	it("pulls an out-of-range value back into range", () => {
		assert.equal(resolveApiTimeout(1000), 5000, "too short would fail requests that would have succeeded");
		assert.equal(resolveApiTimeout(999999), 120000, "too long would stall a poll cycle for minutes");
	});

	it("never disables the timeout", () => {
		// A zero timeout means "wait forever" in axios, which would hang the poll loop.
		assert.equal(resolveApiTimeout(0), 30000);
		assert.equal(resolveApiTimeout(-1), 30000);
	});

	it("falls back rather than propagating a nonsensical value", () => {
		assert.equal(resolveApiTimeout("not a number"), 30000);
		assert.equal(resolveApiTimeout(NaN), 30000);
		assert.equal(resolveApiTimeout(Infinity), 30000);
		assert.equal(resolveApiTimeout({}), 30000);
	});

	it("yields a whole number of milliseconds", () => {
		assert.equal(resolveApiTimeout(30000.7), 30001);
		assert.equal(Number.isInteger(resolveApiTimeout(45000.2)), true);
	});
});

describe("api_timeout configuration surface", () => {
	const jsonConfig = require("../admin/jsonConfig.json");
	const ioPackage = require("../io-package.json");

	/**
	 * Locate a setting anywhere in the nested jsonConfig tree.
	 *
	 * @param {object} node - Current node
	 * @param {string} key - Setting name
	 * @returns {object|null} The setting definition
	 */
	function findSetting(node, key) {
		if (!node || typeof node !== "object") {
			return null;
		}
		if (node.items && Object.prototype.hasOwnProperty.call(node.items, key)) {
			return node.items[key];
		}
		for (const value of Object.values(node)) {
			const hit = findSetting(value, key);
			if (hit) {
				return hit;
			}
		}
		return null;
	}

	it("is editable from the admin UI", () => {
		const setting = findSetting(jsonConfig, "api_timeout");
		assert.ok(setting, "a config key users cannot reach from the UI is not a setting");
		assert.equal(setting.type, "number");
		assert.equal(setting.label, "ApiTimeout");
		assert.equal(setting.help, "ApiTimeoutHelp");
	});

	it("uses the size attributes this project requires", () => {
		const setting = findSetting(jsonConfig, "api_timeout");
		assert.equal(setting.xs, 12);
		assert.equal(setting.sm, 12);
	});

	it("agrees with the clamping in code and with the shipped default", () => {
		const setting = findSetting(jsonConfig, "api_timeout");
		assert.equal(setting.default, 30000, "the field default must match the code default");
		assert.equal(setting.min, 5000);
		assert.equal(setting.max, 120000);
		assert.equal(resolveApiTimeout(setting.min), setting.min, "the field minimum must survive clamping");
		assert.equal(resolveApiTimeout(setting.max), setting.max, "the field maximum must survive clamping");
		assert.equal(ioPackage.native.api_timeout, setting.default, "new installs must get the same default");
	});

	it("is labelled in every language the adapter ships", () => {
		const languages = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
		for (const lang of languages) {
			const dict = require(`../admin/i18n/${lang}.json`);
			assert.ok(dict.ApiTimeout, `ApiTimeout missing for ${lang}`);
			assert.ok(dict.ApiTimeoutHelp, `ApiTimeoutHelp missing for ${lang}`);
		}
	});
});
