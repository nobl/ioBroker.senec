"use strict";

/* exported i18n, t, escHtml, connectorOfState, connectorEnabled, openapiSections, stateIsLive, OPENAPI_ROUTE_SECTIONS */
/* global app, document, window */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * The dashboard's shared primitives — loaded first in the page, so everything else may use them.
 *
 * Translation:
 * - t(key, params?) — translate a key with optional placeholder substitution
 * - i18n.applyAll() — scan DOM for data-i18n attributes and apply translations
 *
 * Escaping:
 * - escHtml(value) — for every sink that interpolates appliance- or user-supplied text
 *
 * Which connector a value belongs to, and whether it may be shown at all. Nothing deletes a
 * connector's states when it is switched off, so a stale value is indistinguishable from a fresh
 * one by inspection; these answer that question in one place for every card:
 * - connectorOfState(id) — the connector that writes a state, by id prefix
 * - connectorEnabled(connector) — whether the instance configuration still has it on
 * - openapiSections() — which OpenAPI sections are being polled
 * - stateIsLive(id) — the two above combined, which is the test every accessor applies
 */

var i18n = {
	lang: "en",
	dictionaries: {},
	ready: false,
	supportedLanguages: ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"],

	/**
	 * Initialize i18n: detect language and load dictionaries.
	 * Returns a Promise that resolves when translations are ready.
	 *
	 * @param {object} [conn] - socket.io connection (optional, for ioBroker system language)
	 * @returns {Promise<void>}
	 */
	init: function (conn) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;
		return new Promise(function (resolve) {
			if (conn) {
				// Try to get ioBroker system language
				conn.emit("getObject", "system.config", function (err, obj) {
					var sysLang = null;
					if (!err && obj && obj.common && obj.common.language) {
						sysLang = obj.common.language;
					}
					self.detectLanguage(sysLang);
					self.loadDictionaries().then(resolve);
				});
			} else {
				self.detectLanguage(null);
				self.loadDictionaries().then(resolve);
			}
		});
	},

	/**
	 * Detect and normalize language.
	 *
	 * @param {string|null} sysLang - ioBroker system language or null
	 */
	detectLanguage: function (sysLang) {
		// URL parameter override: ?lang=en
		var urlParams = new URLSearchParams(window.location.search);
		var urlLang = urlParams.get("lang");
		var lang = urlLang || sysLang || navigator.language || "en";

		// Normalize: "de-DE" -> "de", "zh-CN" -> "zh-cn"
		lang = lang.toLowerCase();
		if (lang.length > 2 && lang.indexOf("-") !== -1) {
			var parts = lang.split("-");
			if (parts[0] === "zh") {
				lang = "zh-cn";
			} else {
				lang = parts[0];
			}
		}

		// Only use supported languages
		if (this.supportedLanguages.indexOf(lang) === -1) {
			lang = "en";
		}

		this.lang = lang;
		document.documentElement.lang = lang;
	},

	/**
	 * Load English and (if different) the target language dictionary.
	 *
	 * @returns {Promise<void>}
	 */
	loadDictionaries: function () {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;
		var baseUrl = document.baseURI || "";

		var promises = [self.fetchDict(baseUrl, "en")];
		if (self.lang !== "en") {
			promises.push(self.fetchDict(baseUrl, self.lang));
		}

		return Promise.all(promises).then(function () {
			self.ready = true;
		});
	},

	/**
	 * Fetch a single dictionary file.
	 *
	 * @param {string} baseUrl - Base URL for resolving paths
	 * @param {string} lang - Language code
	 * @returns {Promise<void>}
	 */
	fetchDict: function (baseUrl, lang) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;
		var url = new URL(`i18n/${lang}.json`, baseUrl).href;

		// Always revalidate. Nothing under www/ is version-stamped, so a browser is free to
		// keep serving the dictionary it cached before an adapter update — which resolves any
		// key added by that update to its raw name. Unchanged files still answer 304.
		return fetch(url, { cache: "no-cache" })
			.then(function (res) {
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				return res.json();
			})
			.then(function (data) {
				self.dictionaries[lang] = data;
			})
			.catch(function (err) {
				// Non-English fetch failure is fine — falls back to English
				if (lang !== "en") {
					self.dictionaries[lang] = {};
					return;
				}
				// English is the last fallback, so losing it leaves every key unresolved.
				// Say so rather than letting the page quietly render raw key names.
				console.warn(`senec: could not load ${url} (${err.message}) — labels stay untranslated`);
			});
	},

	/**
	 * Whether a key exists in the active or the English dictionary.
	 *
	 * Tested by presence rather than by comparing translate()'s result against the key, so
	 * an entry whose value happens to equal its own key still counts as translated.
	 *
	 * @param {string} key - Translation key
	 * @returns {boolean} True when the key resolves to a real entry
	 */
	has: function (key) {
		var dict = this.dictionaries[this.lang] || {};
		var enDict = this.dictionaries.en || {};
		return dict[key] !== undefined || enDict[key] !== undefined;
	},

	/**
	 * Translate a key with optional placeholder substitution.
	 *
	 * @param {string} key - Translation key
	 * @param {{[key: string]: string|number}} [params] - Placeholder values
	 * @returns {string} Translated string
	 */
	translate: function (key, params) {
		var dict = this.dictionaries[this.lang] || {};
		var enDict = this.dictionaries.en || {};
		var str = dict[key] || enDict[key] || key;

		if (params) {
			for (var p in params) {
				str = str.split(`{${p}}`).join(String(params[p]));
			}
		}

		return str;
	},

	/**
	 * Scan DOM for data-i18n attributes and apply translations.
	 * Supports: data-i18n (textContent), data-i18n-placeholder, data-i18n-title
	 *
	 * Elements carrying an unknown key are left untouched. Each one ships English text in
	 * the markup, so keeping that beats overwriting it with the key name.
	 */
	applyAll: function () {
		var els = document.querySelectorAll("[data-i18n]");
		for (var i = 0; i < els.length; i++) {
			var key = els[i].getAttribute("data-i18n");
			if (key && this.has(key)) {
				els[i].textContent = this.translate(key);
			}
		}

		els = document.querySelectorAll("[data-i18n-placeholder]");
		for (var j = 0; j < els.length; j++) {
			var pKey = els[j].getAttribute("data-i18n-placeholder");
			if (pKey && this.has(pKey)) {
				/** @type {HTMLInputElement} */ (els[j]).placeholder = this.translate(pKey);
			}
		}

		els = document.querySelectorAll("[data-i18n-title]");
		for (var k = 0; k < els.length; k++) {
			var tKey = els[k].getAttribute("data-i18n-title");
			if (tKey && this.has(tKey)) {
				/** @type {HTMLElement} */ (els[k]).title = this.translate(tKey);
			}
		}
	},
};

/**
 * Shorthand translation function.
 *
 * @param {string} key - Translation key
 * @param {{[key: string]: string|number}} [params] - Placeholder values
 * @returns {string} Translated string
 */
function t(key, params) {
	return i18n.translate(key, params);
}

/**
 * Tab label for one totals granularity, shared by every card that offers the same three tabs.
 *
 * "today" reads as "Day" here — a granularity, not a date. One helper rather than a label per
 * card, because two cards sitting on the same page with different words for the same tab read
 * as two different controls.
 *
 * @param {string} period - "today", "month" or "year"
 * @returns {string} The tab's label
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function periodTabLabel(period) {
	return t(period === "today" ? "period_day" : `period_${period}`);
}

/**
 * Which connector writes a given state, by id prefix.
 *
 * The prefixes are the adapter's own namespacing: every connector but `lala.cgi` writes under
 * one of its own, and the local connector writes the unprefixed device sections at the root.
 * Order matters only in that the prefixed entries must be tested before the root fallback.
 */
var CONNECTOR_PREFIXES = [
	{ prefix: "_api.", connector: "api" },
	{ prefix: "_meinsenec.", connector: "web" },
	{ prefix: "_openapi.", connector: "openapi" },
	{ prefix: "_connect.", connector: "connect" },
	{ prefix: "_local.", connector: "local" },
];

/** Config flag that enables each connector, as `io-package.json` names it. */
var CONNECTOR_CONFIG_KEY = {
	local: "lala_use",
	openapi: "openapi_use",
	api: "api_use",
	web: "web_use",
	connect: "connect_use",
};

/**
 * The connector that owns a state, or null when nothing owns it.
 *
 * Null means "always show": `_external.*` mirrors another adapter's states and has nothing to
 * do with a SENEC connector, and `info.*` is adapter-level rather than connector-level.
 *
 * @param {string} id - State id without the adapter namespace
 * @returns {string|null} Connector name, or null when the state is not a connector's
 */
function connectorOfState(id) {
	if (!id) {
		return null;
	}
	for (var i = 0; i < CONNECTOR_PREFIXES.length; i++) {
		if (id.indexOf(CONNECTOR_PREFIXES[i].prefix) === 0) {
			return CONNECTOR_PREFIXES[i].connector;
		}
	}
	// `control.` is the adapter's own command surface, not any one connector's readings: a
	// command is dispatched to whichever connector can carry it, so attributing these to
	// lala.cgi hid the whole Control tab whenever local polling was switched off.
	if (id.indexOf("_external.") === 0 || id.indexOf("info.") === 0 || id.indexOf("control.") === 0) {
		return null;
	}
	// Everything else is a device section written by the lala.cgi connector: ENERGY, BMS, PV1,
	// WALLBOX, FACTORY, WIZARD, TEMPMEASURE, FEATURES and the rest.
	return "local";
}

/**
 * Last configuration object `connectorEnabled` answered for.
 *
 * `connectorEnabled` is asked once per state id by the dashboard's state-tree scans, so without
 * this it walked `Object.keys(app.config)` once per id in the tree. The identity test holds
 * because `app.config` is replaced wholesale when an instance object arrives, never edited in
 * place; a caller that mutates the existing object instead would keep the previous answer.
 *
 * @type {object|null}
 */
var _connectorConfig = null;

/** Whether `_connectorConfig` was still the empty placeholder, which enables every connector. */
var _connectorConfigEmpty = true;

/**
 * Whether a connector is switched on in the instance configuration.
 *
 * Deliberately the configuration and not `info.<name>Connected`: a connector that is enabled
 * but currently failing still owns its states and must keep its place on the page, or every
 * card it feeds would vanish and reappear as the connection flaps.
 *
 * Answers true while the configuration is still loading, so the first render shows the page
 * rather than hiding all of it.
 *
 * @param {string} connector - Connector name
 * @returns {boolean} Whether its states may be displayed
 */

function connectorEnabled(connector) {
	var config = typeof app !== "undefined" && app.config ? app.config : null;
	if (_connectorConfig !== config) {
		_connectorConfig = config;
		_connectorConfigEmpty = !config || !Object.keys(config).length;
	}
	if (_connectorConfigEmpty) {
		return true;
	}
	var key = CONNECTOR_CONFIG_KEY[connector];
	return key ? config[key] !== false : true;
}

/**
 * Every section the local OpenAPI connector has a route for.
 *
 * A name that matches none of these is dropped rather than honoured, exactly as the connector
 * drops it: each section is a route of its own, so an unknown name polls nothing.
 */
var OPENAPI_ROUTE_SECTIONS = ["battery", "meter", "bess", "bessNameplate", "evse"];

/**
 * Sections the local OpenAPI connector polls, given the configured include list.
 *
 * `buildOpenapiInclude` in lib/openapi-client.js is the authority; this mirrors it, including
 * the two shapes a stored value takes. An absent key means the user never chose, and defaults
 * to battery and meter; an empty array means they deselected everything, which leaves the
 * identity section the connector adds for itself and nothing more.
 *
 * @returns {Array<string>} Section names currently being polled
 */
function openapiSections() {
	var config = typeof app !== "undefined" && app.config ? app.config : null;
	// Before the configuration arrives, show everything — the same answer connectorEnabled
	// gives for the same reason ("so the first render shows the page rather than hiding all of
	// it"). Falling back to the *default* include list here contradicted it, and hid the bess
	// and wallbox cards on every page load of an install that polls them.
	if (!config || !Object.keys(config).length) {
		return OPENAPI_ROUTE_SECTIONS.slice();
	}
	var chosen = config.openapi_include;
	// `== null` covers undefined and null; the connector additionally treats any other falsy
	// value as "not configured" via `String(configured || DEFAULT_INCLUDE)`, and the two must
	// agree or the dashboard hides sections the connector is actively polling.
	if (!chosen) {
		chosen = ["battery", "meter"];
	} else if (!Array.isArray(chosen)) {
		chosen = [chosen];
	}
	var wanted = {};
	chosen.forEach(function (entry) {
		// Split on commas whichever shape it arrived in: the multi-select seeds itself from the
		// field's string default, so a stored value can be the single element ["battery,meter"].
		String(entry)
			.split(",")
			.forEach(function (name) {
				var trimmed = name.trim();
				if (trimmed) {
					wanted[trimmed] = true;
				}
			});
	});
	wanted.bessNameplate = true;
	return OPENAPI_ROUTE_SECTIONS.filter(function (section) {
		return wanted[section];
	});
}

/**
 * Whether a state may be read for display.
 *
 * A state a disabled connector wrote is still in the object database — nothing deletes it when
 * the connector is switched off — so without this check every card goes on rendering the last
 * value it ever saw, with no sign that it is months old.
 *
 * Applied per state id rather than per card, because a row may name several sources in
 * preference order: as long as one of them belongs to an enabled connector, the row stays.
 *
 * @param {string} id - State id without the adapter namespace
 * @returns {boolean} Whether the value behind this id is from a connector still in use
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function stateIsLive(id) {
	var owner = connectorOfState(id);
	if (owner === null) {
		return true;
	}
	if (!connectorEnabled(owner)) {
		return false;
	}
	// Connector granularity is not enough for the local OpenAPI: its sections are individually
	// selectable, nothing deletes the states of a section the user removes, and the completeness
	// marker only covers the sections still being asked for. Without this, a deselected `meter`
	// left month-old production and consumption values feeding the energy flow beside a live
	// battery reading, under the current timestamp.
	if (owner === "openapi") {
		var section = id.slice("_openapi.".length).split(".")[0];
		if (section !== "info" && section !== "tls") {
			return openapiSections().indexOf(section) !== -1;
		}
	}
	return true;
}

/**
 * Escape a value for interpolation into markup.
 *
 * The dashboard builds its HTML by string concatenation and assigns it through `innerHTML`, so
 * every value that did not originate in this codebase has to pass through here. That includes
 * appliance-supplied strings — a model or serial number carrying `<` or `&` would otherwise be
 * parsed as markup rather than shown.
 *
 * Lives in i18n.js because it is loaded before every other dashboard script, which is what lets
 * the view modules share one copy instead of each keeping its own.
 *
 * @param {unknown} value - Any value destined for markup
 * @returns {string} The value with HTML-significant characters replaced
 */
// Called from the view modules, which the linter cannot see across: the dashboard has no module
// system, so every shared helper is an unreferenced global here. Remove the suppression if these
// files ever gain imports.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function escHtml(value) {
	if (value === null || value === undefined) {
		return "";
	}
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
