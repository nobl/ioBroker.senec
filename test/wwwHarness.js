"use strict";

/**
 * Shared vm harness for the dashboard tests.
 *
 * `www/` is browser code with no module system, so each file is evaluated in a vm context
 * holding the globals it declares.
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DICTIONARY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "www", "i18n", "en.json"), "utf8"));

/**
 * The dashboard's own translation contract: a known key is translated, an unknown key comes
 * back unchanged. Several render paths branch on that, so a stub that always answers would
 * exercise the wrong half — and asserting on the English text proves the keys are wired.
 *
 * @param {string} key - Translation key
 * @param {{[key: string]: string|number}} [params] - Placeholder values
 * @returns {string} The English text, or the key when there is none
 */
function translate(key, params) {
	let text = Object.hasOwn(DICTIONARY, key) ? DICTIONARY[key] : key;
	for (const name of Object.keys(params || {})) {
		text = text.split(`{${name}}`).join(String(params[name]));
	}
	return text;
}

/**
 * Load a www module into a fresh context.
 *
 * `i18n.js` is always loaded first, because it is loaded first in the page and defines the shared
 * `escHtml` the view modules use. Loading the real one rather than stubbing it means the escaping
 * tests exercise the code that actually ships. Its `t` is then replaced by the stub above, which
 * reads the dictionary from disk instead of fetching it.
 *
 * @param {string|Array<string>} file - File name(s) under www/, loaded in page order
 * @param {object} [extraGlobals] - Globals the file expects to find
 * @returns {any} The context, carrying whatever the file declared
 */
function loadWww(file, extraGlobals = {}) {
	const context = vm.createContext({
		app: { states: {}, config: {}, connectors: {}, renderDashboard() {} },
		// energy.js resets the chart on every source change, so the stub needs the whole
		// surface it reaches for. A bare {} let a missing member go unnoticed until it was
		// a function call rather than a property write.
		liveChart: {
			buffer: [],
			_lastTs: 0,
			_loadGeneration: 0,
			_historyLoaded: false,
			_historyLoading: false,
			_historyStatus: {},
			_historyRequestedTs: Infinity,
			_newestHistoryTs: 0,
			_clearLoadTimer() {},
			record() {},
			initHistory() {},
		},
		navigator: { language: "en" },
		...extraGlobals,
	});
	// colors.js alongside it: the view modules ask it for every series color they draw.
	for (const name of ["i18n.js", "colors.js", ...(Array.isArray(file) ? file : [file])]) {
		const source = fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8");
		vm.runInContext(source, context, { filename: name });
	}
	context.t = translate;
	return context;
}

/**
 * Bring a value across the vm boundary.
 *
 * Objects built inside the context have their own Object and Array prototypes, so
 * assert.deepEqual rejects them as not reference-equal however identical their contents.
 *
 * @param {unknown} value - Value produced inside the vm context
 * @returns {any} The same value, built from this realm's prototypes
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

module.exports = { DICTIONARY, translate, loadWww, plain };
