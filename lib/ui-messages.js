"use strict";
// Text that reaches the user through Admin rather than through the log.
//
// Log output in this adapter is English throughout, as it is in ioBroker generally — a log is
// read alongside js-controller's own lines and is searched for verbatim in bug reports. The
// replies a sendTo button puts in the Admin dialog are a different surface: they appear inches
// from labels Admin has already translated, so English there reads as a defect.
//
// The strings live in admin/i18n, which the translation pipeline already maintains, so a reply
// is written once in English, translated by hand into German and machine-translated into the
// rest, exactly like every label.

const fs = require("node:fs");
const path = require("node:path");

/** Loaded language files, keyed by language. Read once per language per adapter lifetime. */
const cache = new Map();

/** The language every string is guaranteed to exist in. */
const FALLBACK_LANG = "en";

/**
 * Read one language file from admin/i18n.
 *
 * @param {string} lang - Language code, e.g. "de"
 * @returns {Record<string, string>} The file's contents, or an empty object when unreadable
 */
function readLanguage(lang) {
	if (cache.has(lang)) {
		return cache.get(lang);
	}
	/** @type {Record<string, string>} */ // eslint-disable-line jsdoc/check-tag-names
	let loaded = {};
	try {
		// Only ever a language code, and only ever from this directory: a value that walked out of
		// it would read arbitrary files, and the language comes from the ioBroker configuration
		// rather than from anything this adapter controls.
		if (/^[a-z]{2}(-[a-z]{2})?$/i.test(lang)) {
			const file = path.join(__dirname, "..", "admin", "i18n", `${lang}.json`);
			loaded = JSON.parse(fs.readFileSync(file, "utf8"));
		}
	} catch {
		// A missing or malformed language file is not worth failing a button over; English is
		// complete by construction, so the caller still gets a sentence.
		loaded = {};
	}
	cache.set(lang, loaded);
	return loaded;
}

/**
 * One translated message, with `{{placeholders}}` filled in.
 *
 * Falls back to English per key rather than per language: a language file that is a translation
 * behind should produce one English sentence, not drop the whole reply.
 *
 * @param {string} lang - Language code from the ioBroker configuration
 * @param {string} key - Key in admin/i18n
 * @param {Record<string, string | number>} [vars] - Values for `{{placeholders}}`
 * @returns {string} The message, or the key itself when it exists in no language
 */
function uiMessage(lang, key, vars = {}) {
	const text = readLanguage(lang)[key] ?? readLanguage(FALLBACK_LANG)[key] ?? key;
	return String(text).replace(/\{\{(\w+)\}\}/g, (match, name) =>
		Object.hasOwn(vars, name) ? String(vars[name]) : match,
	);
}

module.exports = { uiMessage, FALLBACK_LANG };
