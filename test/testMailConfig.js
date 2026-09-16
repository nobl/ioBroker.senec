"use strict";

/**
 * Regression tests for a mail address that carries invisible characters.
 *
 * A trailing space in the configured address made the SENEC App API login fail on every single
 * attempt, and the reason it gave named neither the address nor the space. The app client's login
 * asks for the username first and resolves the domain behind the `@` to decide whether the account
 * belongs to an identity provider; `example.com ` is not a domain, that handover throws, and
 * Keycloak answers the username step with HTTP 400 and "Unexpected error when handling
 * authentication request to identity provider" — which reads like a dead endpoint or a rejected
 * account, and was reported as both.
 *
 * What made it undiagnosable is that the mein-senec.de connector is served a single form carrying
 * username *and* password: that flow validates the credentials directly and trims the username on
 * the way, so the same stray character passes there unnoticed and the two connectors disagree
 * about credentials that are in fact identical.
 *
 * Verified against the SSO: a trailing space, tab, CR or LF — and anything else that leaves an
 * invalid domain, such as a trailing dot — is refused, while a space *before* the `@` is not,
 * because the domain stays intact. Hence trimming the ends rather than stripping whitespace
 * throughout: the local part is the user's to spell.
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

/**
 * Adapter instance carrying nothing but the configured address.
 *
 * @param {unknown} api_mail - the value as it comes out of the instance configuration
 * @returns {object} adapter instance recording its warnings
 */
function makeAdapter(api_mail) {
	const adapter = mainExport({});
	const warnings = [];
	adapter.config = { api_mail, api_pwd: " keep me " };
	adapter.log = {
		warn: (msg) => warnings.push(String(msg)),
		info: () => {},
		debug: () => {},
		error: () => {},
	};
	adapter.warnings = warnings;
	return adapter;
}

describe("mail address normalisation", () => {
	it("removes what the SSO refuses and says so once", () => {
		const adapter = makeAdapter("uwe.mueller@example.com ");
		adapter.normalizeMailConfig();
		assert.equal(adapter.config.api_mail, "uwe.mueller@example.com");
		assert.equal(adapter.warnings.length, 1, "the correction has to be visible, it is silent otherwise");
		assert.ok(
			!adapter.warnings[0].includes("uwe.mueller@example.com"),
			`the address must not be written out: ${adapter.warnings[0]}`,
		);
		assert.ok(adapter.warnings[0].includes("u***@example.com"), "but it has to be identifiable");
	});

	it("covers every character that travels through a copy & paste unseen", () => {
		const mail = "uwe.mueller@example.com";
		// The last two are zero-width: `trim()` does not touch them, and they are as invisible in a
		// config field as the space that started this.
		for (const stray of [" ", "\t", "\n", "\r", "\u00A0", "\u200B", "\uFEFF"]) {
			const adapter = makeAdapter(`${mail}${stray}`);
			adapter.normalizeMailConfig();
			assert.equal(adapter.config.api_mail, mail, `trailing ${JSON.stringify(stray)}`);

			const leading = makeAdapter(`${stray}${mail}`);
			leading.normalizeMailConfig();
			assert.equal(leading.config.api_mail, mail, `leading ${JSON.stringify(stray)}`);
		}
	});

	it("leaves an address the user spelled deliberately alone", () => {
		// A space inside the local part reaches the password step unharmed — the domain is what the
		// login parses — so it is not this function's business to decide it is a mistake.
		for (const mail of ["uwe.mueller@example.com", "uwe mueller@example.com", "uwe+senec@example.com"]) {
			const adapter = makeAdapter(mail);
			adapter.normalizeMailConfig();
			assert.equal(adapter.config.api_mail, mail);
			assert.deepEqual(adapter.warnings, [], `nothing to correct, so nothing to say: ${mail}`);
		}
	});

	it("never touches the password", () => {
		// A space at either end of a password may well be part of it, and silently dropping one
		// would turn a working login into a failing one.
		const adapter = makeAdapter("uwe.mueller@example.com ");
		adapter.normalizeMailConfig();
		assert.equal(adapter.config.api_pwd, " keep me ");
	});

	it("passes through a field that is empty or not a string", () => {
		for (const value of ["", undefined, null, 42]) {
			const adapter = makeAdapter(value);
			adapter.normalizeMailConfig();
			assert.equal(adapter.config.api_mail, value, `for ${String(value)}`);
			assert.deepEqual(adapter.warnings, [], "an unconfigured instance is not a misconfigured one");
		}
	});
});
