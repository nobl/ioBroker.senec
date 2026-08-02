"use strict";

/**
 * Regression tests for the user-configured high-priority datapoint fields.
 *
 * Ten sections (BMS, ENERGY, PV1, ...) each pair a free-text field with an "add to polling"
 * checkbox. The checkbox is only *hidden* while the text field is empty, never cleared, so a
 * user who fills the field, ticks the box and then empties the field again leaves the config
 * in a state the runtime has to cope with: active = true, text = "".
 *
 * addUserDps() validated the raw string with /^[A-Z0-9_,]*$/ before splitting it, which
 * conflated three unrelated cases:
 *
 *   ""            → warned about a syntax violation, when nothing was configured at all
 *   "A, B"        → a space after the comma rejected the entire field silently to the user
 *   "A,B,"        → passed the regex, then split into ["A","B",""], adding an empty datapoint
 *                   name that reached the appliance as {"BMS":{"A":"","B":"","":""}}
 *
 * Splitting first and validating each token separately settles all three. Semantics pinned:
 *
 *   empty / whitespace / missing key → nothing added, no warning (not a misconfiguration)
 *   surrounding blanks               → trimmed away, datapoint accepted
 *   empty tokens between commas      → dropped, never reach the poll form
 *   any invalid token                → whole field rejected, warning names the bad token
 *
 * The last line is a deliberate maintainer choice: a typo yields no polling rather than
 * partial polling, because the config disclaimer warns that wrong settings can reboot the
 * appliance. Do not soften it to per-token dropping without revisiting that.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const localClient = require("../lib/local-client");

/** Sections that expose a user-configurable high-priority datapoint field. */
const SECTIONS = [
	"BMS",
	"ENERGY",
	"PV1",
	"PWR_UNIT",
	"PM1OBJ1",
	"PM1OBJ2",
	"WALLBOX",
	"BAT1",
	"BAT1OBJ1",
	"TEMPMEASURE",
];

/**
 * Run addUserDps against a recording adapter double.
 *
 * @param {*} input - Raw config value for the field
 * @returns {{added: string[], warnings: string[]}} Datapoints collected and warnings emitted
 */
function run(input) {
	const warnings = [];
	const adapter = {
		log: {
			warn: (msg) => warnings.push(String(msg)),
			debug() {},
			info() {},
			error() {},
			silly() {},
		},
	};
	const objectsSet = new Set();
	localClient.addUserDps(adapter, "BMS", objectsSet, input);
	return { added: [...objectsSet], warnings };
}

/**
 * Build the high-priority poll form the way localInitPollSettings does, so the test can
 * assert on what actually reaches the appliance rather than on the intermediate Set.
 *
 * @param {string} section - Section name
 * @param {string[]} datapoints - Datapoint names collected for that section
 * @returns {string} The JSON form body
 */
function buildPollForm(section, datapoints) {
	let form = `{"${section}":{`;
	datapoints.forEach((dp) => {
		form += `"${dp}":"",`;
	});
	return `${form.slice(0, -1)}}}`;
}

describe("high-priority datapoint configuration", () => {
	describe("nothing configured", () => {
		it("an emptied field with the checkbox still ticked is not a misconfiguration", () => {
			// The reported case: user filled the field, ticked "add datapoints to polling",
			// then cleared the field. The checkbox stays ticked because it is only hidden.
			const { added, warnings } = run("");

			assert.deepEqual(added, [], "nothing to add");
			assert.deepEqual(warnings, [], "an empty field must not be reported as a syntax error");
		});

		it("a field holding only blanks is treated the same", () => {
			const { added, warnings } = run("   ");

			assert.deepEqual(added, []);
			assert.deepEqual(warnings, []);
		});

		it("a missing config key neither warns nor throws", () => {
			// An instance object predating a key yields undefined here.
			for (const missing of [undefined, null]) {
				const { added, warnings } = run(missing);

				assert.deepEqual(added, [], `no datapoints for ${String(missing)}`);
				assert.deepEqual(warnings, [], `no warning for ${String(missing)}`);
			}
		});
	});

	describe("accepted input", () => {
		it("accepts a single datapoint", () => {
			const { added, warnings } = run("SOC");

			assert.deepEqual(added, ["SOC"]);
			assert.deepEqual(warnings, []);
		});

		it("accepts blanks around the comma separator", () => {
			// The most likely way a user types a list. Previously rejected the whole field.
			const { added, warnings } = run("CELL_TEMPERATURES_MODULE_A, SOC , CURRENT");

			assert.deepEqual(added, ["CELL_TEMPERATURES_MODULE_A", "SOC", "CURRENT"]);
			assert.deepEqual(warnings, [], "blanks around separators are formatting, not an error");
		});

		it("upper-cases lower-case input", () => {
			const { added, warnings } = run("soc, current");

			assert.deepEqual(added, ["SOC", "CURRENT"]);
			assert.deepEqual(warnings, []);
		});

		it("drops empty tokens instead of polling an unnamed datapoint", () => {
			const { added, warnings } = run("SOC,CURRENT,");

			assert.deepEqual(added, ["SOC", "CURRENT"]);
			assert.equal(added.includes(""), false, "an empty datapoint name must never be collected");
			assert.deepEqual(warnings, [], "a trailing comma is formatting, not an error");
		});

		it("keeps the empty name out of the poll form sent to the appliance", () => {
			const { added } = run("A,B,");

			assert.equal(
				buildPollForm("BMS", added),
				'{"BMS":{"A":"","B":""}}',
				"the form must not contain a nameless datapoint",
			);
		});

		it("collapses a repeated datapoint", () => {
			const { added } = run("SOC,SOC");

			assert.deepEqual(added, ["SOC"]);
		});
	});

	describe("rejected input", () => {
		it("rejects the whole field when one token is invalid", () => {
			// Maintainer decision: no partial polling from a config the user got wrong.
			const { added, warnings } = run("SOC, BAD-NAME, CURRENT");

			assert.deepEqual(added, [], "no datapoint is polled when any token is invalid");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /BAD-NAME/, "the warning must name the offending token");
			assert.match(warnings[0], /BMS/, "the warning must name the section");
		});

		it("does not name the valid tokens in the warning", () => {
			const { warnings } = run("SOC, BAD-NAME");

			assert.equal(/\bSOC\b/.test(warnings[0]), false, "only the offending token is worth reporting");
		});

		it("rejects blanks inside a datapoint name", () => {
			const { added, warnings } = run("CELL VOLTAGE");

			assert.deepEqual(added, []);
			assert.equal(warnings.length, 1);
		});

		it("rejects other punctuation", () => {
			for (const bad of ["A.B", "A;B", "A/B", "A-B"]) {
				const { added, warnings } = run(bad);

				assert.deepEqual(added, [], `${bad} must be rejected`);
				assert.equal(warnings.length, 1, `${bad} must warn`);
			}
		});
	});
});

describe("high-priority datapoint admin configuration", () => {
	const jsonConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "admin", "jsonConfig.json"), "utf8"));
	const items = jsonConfig.items._highpriopolling.items;

	it("covers every section that the runtime reads a field for", () => {
		for (const section of SECTIONS) {
			assert.ok(items[`highPrio_${section}`], `highPrio_${section} must exist in jsonConfig`);
			assert.ok(items[`highPrio_${section}_active`], `highPrio_${section}_active must exist in jsonConfig`);
		}
	});

	it("unticks the activation checkbox when its text field is cleared", () => {
		// Without this the checkbox keeps a stale `true` that no longer matches any field
		// content, which is the config state the runtime tests above have to tolerate.
		for (const section of SECTIONS) {
			const checkbox = items[`highPrio_${section}_active`];
			const onChange = checkbox.onChange;

			assert.ok(onChange, `highPrio_${section}_active must recalculate when the text field changes`);
			assert.deepEqual(
				onChange.alsoDependsOn,
				[`highPrio_${section}`],
				`highPrio_${section}_active must depend on its own text field`,
			);
			assert.equal(
				onChange.ignoreOwnChanges,
				true,
				"the checkbox is recalculated from its text field only, not from its own ticking",
			);
			assert.match(
				onChange.calculateFunc,
				new RegExp(`highPrio_${section}\\b`),
				"the calculation must read the matching text field",
			);
			assert.match(onChange.calculateFunc, /false/, "an empty text field must resolve to false");
		}
	});

	it("keeps the responsive sizes the admin UI requires", () => {
		for (const section of SECTIONS) {
			for (const key of [`highPrio_${section}`, `highPrio_${section}_active`]) {
				assert.equal(items[key].xs, 12, `${key} xs must be 12`);
				assert.equal(items[key].sm, 12, `${key} sm must be 12`);
			}
		}
	});
});
