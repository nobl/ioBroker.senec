"use strict";

/* exported i18n, t */
/* global document, window */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Lightweight i18n runtime for the SENEC web dashboard.
 *
 * Loads JSON dictionaries from www/i18n/ and provides:
 * - t(key, params?) — translate a key with optional placeholder substitution
 * - i18n.applyAll() — scan DOM for data-i18n attributes and apply translations
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

		return fetch(url)
			.then(function (res) {
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}
				return res.json();
			})
			.then(function (data) {
				self.dictionaries[lang] = data;
			})
			.catch(function () {
				// Non-English fetch failure is fine — falls back to English
				if (lang !== "en") {
					self.dictionaries[lang] = {};
				}
			});
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
	 */
	applyAll: function () {
		var els = document.querySelectorAll("[data-i18n]");
		for (var i = 0; i < els.length; i++) {
			var key = els[i].getAttribute("data-i18n");
			if (key) {
				els[i].textContent = this.translate(key);
			}
		}

		els = document.querySelectorAll("[data-i18n-placeholder]");
		for (var j = 0; j < els.length; j++) {
			var pKey = els[j].getAttribute("data-i18n-placeholder");
			if (pKey) {
				/** @type {HTMLInputElement} */ (els[j]).placeholder = this.translate(pKey);
			}
		}

		els = document.querySelectorAll("[data-i18n-title]");
		for (var k = 0; k < els.length; k++) {
			var tKey = els[k].getAttribute("data-i18n-title");
			if (tKey) {
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function t(key, params) {
	return i18n.translate(key, params);
}
