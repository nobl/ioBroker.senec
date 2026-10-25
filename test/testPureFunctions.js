"use strict";

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

// Mock adapter-core and axios so main.js can be loaded without js-controller
const mainExport = proxyquire("../main", {
	"@iobroker/adapter-core": {
		Adapter: class FakeAdapter {
			constructor() {}
		},
		getAbsoluteDefaultDataDir: () => "/tmp",
	},
	axios: { create: () => ({}) },
	"axios-cookiejar-support": {},
	"tough-cookie": { CookieJar: class {} },
});

const t = mainExport._testing;
const authHelpers = require("../lib/auth-helpers");
const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");
const webClient = require("../lib/web-client");
const { isDeviceSentinel } = require("../lib/constants");

describe("extractFormAction", () => {
	it("extracts action URL from a form tag", () => {
		const html = '<form id="login" action="https://sso.senec.com/auth/login" method="POST">';
		assert.equal(authHelpers.extractFormAction(html), "https://sso.senec.com/auth/login");
	});

	it("decodes &amp; in action URLs", () => {
		const html = '<form action="https://sso.senec.com/auth?a=1&amp;b=2" method="POST">';
		assert.equal(authHelpers.extractFormAction(html), "https://sso.senec.com/auth?a=1&b=2");
	});

	it("returns null when no form is present", () => {
		assert.equal(authHelpers.extractFormAction("<div>no form here</div>"), null);
	});

	it("returns null when form has no action", () => {
		assert.equal(authHelpers.extractFormAction('<form method="POST"><input name="user"></form>'), null);
	});
});

describe("hasUsername", () => {
	it("detects username input", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" name="username" />'));
	});

	it("detects email input", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" name="email" />'));
	});

	it("detects user input by id", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" id="username" />'));
	});

	it("returns falsy for password-only form", () => {
		assert.ok(!authHelpers.hasUsername('<input type="password" name="password" />'));
	});

	it("returns falsy for empty HTML", () => {
		assert.ok(!authHelpers.hasUsername(""));
	});
});

describe("hasPassword", () => {
	it("detects password input", () => {
		assert.ok(authHelpers.hasPassword('<input type="password" name="password" />'));
	});

	it("returns falsy for username-only form", () => {
		assert.ok(!authHelpers.hasPassword('<input type="text" name="username" />'));
	});
});

describe("hasUsernameAndPassword", () => {
	it("returns truthy when both are present", () => {
		const html = '<input name="username" /><input type="password" name="password" />';
		assert.ok(authHelpers.hasUsernameAndPassword(html));
	});

	it("returns falsy when only username is present", () => {
		assert.ok(!authHelpers.hasUsernameAndPassword('<input name="username" />'));
	});
});

describe("hasOtp", () => {
	it("detects OTP input by name", () => {
		assert.ok(authHelpers.hasOtp('<input type="text" name="otp" />'));
	});

	it("detects OTP input by id", () => {
		assert.ok(authHelpers.hasOtp('<input type="text" id="otp" />'));
	});

	it("returns false for username form", () => {
		assert.ok(!authHelpers.hasOtp('<input type="text" name="username" />'));
	});

	it("returns false for empty HTML", () => {
		assert.ok(!authHelpers.hasOtp(""));
	});

	it("detects OTP in a full Keycloak-style form", () => {
		const html = `
			<form action="https://sso.senec.com/auth/otp" method="POST">
				<input type="text" name="otp" autocomplete="one-time-code" />
				<button type="submit">Submit</button>
			</form>`;
		assert.ok(authHelpers.hasOtp(html));
	});
});

describe("generateTOTP", () => {
	it("generates a 6-digit code", () => {
		const code = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.match(code, /^\d{6}$/);
	});

	it("generates consistent codes within the same 30s window", () => {
		const code1 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		const code2 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.equal(code1, code2);
	});

	it("handles secrets with spaces", () => {
		const code = authHelpers.generateTOTP("JBSW Y3DP EHPK 3PXP");
		assert.match(code, /^\d{6}$/);
	});

	it("handles lowercase secrets", () => {
		const upper = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		const lower = authHelpers.generateTOTP("jbswy3dpehpk3pxp");
		assert.equal(upper, lower);
	});

	it("handles secrets with padding characters", () => {
		const code = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP====");
		assert.match(code, /^\d{6}$/);
	});

	it("throws on invalid base32 characters", () => {
		assert.throws(() => authHelpers.generateTOTP("INVALID!SECRET"), /Invalid base32 character/);
	});

	it("throws on secret that is too short", () => {
		assert.throws(() => authHelpers.generateTOTP("A"), /TOTP secret too short/);
	});

	it("different secrets produce different codes", () => {
		const code1 = authHelpers.generateTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
		const code2 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.match(code1, /^\d{6}$/);
		assert.match(code2, /^\d{6}$/);
	});
});

/**
 * Read a page's hidden fields the way the login flow does: one form match, fields from its content.
 *
 * `extractHiddenInputs` takes a form's *content* rather than a document, so that the fields posted
 * and the action they are posted to can only ever come from the same form. Composing it here keeps
 * that composition under test instead of letting each case invent its own.
 *
 * @param {string} [html] - a whole page
 * @returns {Array<[string, string]>} the login form's hidden fields
 */
function hiddenInputsOf(html) {
	return authHelpers.extractHiddenInputs(authHelpers.matchLoginForm(html)?.inner ?? "");
}

describe("matchLoginForm", () => {
	it("picks the first form that carries an action, not merely the first form", () => {
		// A locale switcher ahead of the login form carries no action; posting its `locale`
		// field to the login action would be the wrong body for the right URL.
		const html =
			'<form id="kc-locale-form"><input type="hidden" name="locale" value="de"></form>' +
			'<form id="kc-form-login" action="/login-actions/authenticate?session_code=abc">' +
			'<input type="hidden" name="credentialId" value="pw-1"><input name="username"></form>';
		const form = authHelpers.matchLoginForm(html);
		assert.equal(form.action, "/login-actions/authenticate?session_code=abc");
		assert.deepEqual(authHelpers.extractHiddenInputs(form.inner), [["credentialId", "pw-1"]]);
	});

	it("reads an action that is single-quoted or not quoted at all", () => {
		assert.equal(authHelpers.extractFormAction("<form action='/single/quoted'>"), "/single/quoted");
		assert.equal(authHelpers.extractFormAction("<form action=/unquoted method=POST>"), "/unquoted");
	});

	it("stops at a nested form so the inner form's fields cannot be posted as ours", () => {
		// Markup a browser would auto-close: the only `</form>` in the document belongs to the
		// inner form, so taking everything up to it would post the inner form's fields.
		const html =
			'<form action="/outer"><input type="hidden" name="outer" value="1">' +
			'<form action="/inner"><input type="hidden" name="inner" value="2"></form>';
		assert.deepEqual(hiddenInputsOf(html), [["outer", "1"]]);
	});

	it("yields no fields at all when the document never closes the form", () => {
		// Truncated markup: keeping the rest of the document would sweep in every later form's
		// fields, which is the cross-form mix-up the single match exists to prevent.
		const html = '<form action="/x"><input type="hidden" name="a" value="1">';
		assert.equal(authHelpers.matchLoginForm(html).inner, "");
		assert.deepEqual(hiddenInputsOf(html), []);
	});

	it("returns null for a page with no form and for a form with no action", () => {
		assert.equal(authHelpers.matchLoginForm("<div>nothing</div>"), null);
		assert.equal(authHelpers.matchLoginForm('<form><input type="hidden" name="x" value="1"></form>'), null);
		assert.equal(authHelpers.matchLoginForm(undefined), null);
	});
});

describe("extractHiddenInputs", () => {
	it("collects the hidden fields of the login form in document order", () => {
		const html = `<form action="https://sso.senec.com/x">
			<input type="hidden" name="session_code" value="abc">
			<input type="text" name="username">
			<input type="hidden" name="credentialId" value="pw-1">
		</form>`;
		assert.deepEqual(hiddenInputsOf(html), [
			["session_code", "abc"],
			["credentialId", "pw-1"],
		]);
	});

	it("decodes entities so the value goes back as the server wrote it", () => {
		const html = '<form action="/x"><input type="hidden" name="rd" value="a&amp;b&#61;c&quot;d"></form>';
		assert.deepEqual(hiddenInputsOf(html), [["rd", 'a&b=c"d']]);
	});

	it("leaves an entity the server never meant as one exactly as it was written", () => {
		// `&constructor;` resolved through the entity table's prototype chain and was posted as
		// "function Object() { [native code] }" in place of the value the SSO wrote.
		assert.equal(authHelpers.decodeHtmlEntities("&constructor;"), "&constructor;");
		const html = '<form action="/x"><input type="hidden" name="rd" value="&constructor;"></form>';
		assert.deepEqual(hiddenInputsOf(html), [["rd", "&constructor;"]]);
	});

	it("handles unquoted and single-quoted attributes, and a hidden field without a value", () => {
		const html =
			'<form action="/x"><input type=hidden name=\'tab_id\' value=xyz><input type="hidden" name="empty"></form>';
		assert.deepEqual(hiddenInputsOf(html), [
			["tab_id", "xyz"],
			["empty", ""],
		]);
	});

	it("reads the field's own name and value past the data- attributes a theme adds", () => {
		// `\b` also sits between the `-` and the `v` of `data-value`, so the anchored form is what
		// keeps `data-value="junk"` from being posted as the field's value.
		const html =
			'<form action="/x"><input data-name="junk" data-value="junk" type="hidden" name="credentialId" value="pw-1"></form>';
		assert.deepEqual(hiddenInputsOf(html), [["credentialId", "pw-1"]]);
		assert.equal(authHelpers.readTagAttribute('<input data-value="junk" value="real">', "value"), "real");
	});

	it("does not take a field whose type merely starts with hidden", () => {
		// An optional closing quote made `type="hiddenfoo"` match as a prefix, so a field the
		// browser renders and the user never fills was posted as form state.
		const html =
			'<form action="/x"><input type="hiddenfoo" name="k" value="v"><input data-type="hidden" name="d"></form>';
		assert.deepEqual(hiddenInputsOf(html), []);
	});

	it("ignores hidden fields outside the form the action was taken from", () => {
		const html =
			'<form action="/x"><input type="hidden" name="in" value="1"></form><input type="hidden" name="out" value="2">';
		assert.deepEqual(hiddenInputsOf(html), [["in", "1"]]);
	});

	it("returns nothing for a missing or empty form content", () => {
		assert.deepEqual(authHelpers.extractHiddenInputs(""), []);
		assert.deepEqual(authHelpers.extractHiddenInputs(undefined), []);
	});
});

describe("buildLoginForm", () => {
	/** The content of a form, as `matchLoginForm` hands it over. */
	const inner =
		'<input type="hidden" name="execution" value="idp-discovery">' +
		'<input type="hidden" name="username" value="stale@example.com">' +
		'<input name="username" type="text"><input name="password" type="password">';

	it("posts the form's hidden state and lets the adapter's own values win", () => {
		const body = authHelpers.buildLoginForm(inner, { username: "user@example.com", password: "secret" });
		assert.equal(body.get("execution"), "idp-discovery");
		assert.deepEqual(body.getAll("username"), ["user@example.com"], "the stale hidden copy must be replaced");
		assert.equal(body.get("password"), "secret");
	});

	it("keeps a name the form carries twice as two fields, the way a browser sends it", () => {
		const duplicated =
			'<input type="hidden" name="scope" value="openid"><input type="hidden" name="scope" value="profile">';
		const body = authHelpers.buildLoginForm(duplicated, {});
		assert.deepEqual(body.getAll("scope"), ["openid", "profile"]);
		assert.equal(body.toString(), "scope=openid&scope=profile");
	});

	it("drops a field the adapter does not supply rather than posting the form's own value", () => {
		// The username step must not carry a password at all; a hidden `password` on that page
		// would otherwise be posted as though the adapter had chosen it.
		const body = authHelpers.buildLoginForm(inner, { username: "user@example.com", password: undefined });
		assert.equal(body.has("password"), false);
		assert.ok(!body.toString().includes("password="));
	});
});

describe("redactAuthHtml", () => {
	it("keeps the form fields and the error text a failing login has to be read from", () => {
		const html = `<html><head><style>.a{color:red}</style></head><body>
			<span class="kc-feedback-text">Unexpected error when handling authentication request to identity provider.</span>
			<form action="/login-actions/authenticate?session_code=SECRET&execution=e1">
			<input type="hidden" name="credentialId" value="idp-myenergykey"></form>
			<script>var x=1;</script></body></html>`;
		const out = authHelpers.redactAuthHtml(html);
		assert.ok(out.includes("identity provider"));
		assert.ok(out.includes('name="credentialId"'));
		assert.ok(out.includes("idp-myenergykey"));
		assert.ok(out.includes("execution=e1"));
		assert.ok(!out.includes("color:red"));
		assert.ok(!out.includes("var x=1"));
	});

	it("masks the session code, the configured credentials and any mail address", () => {
		const html =
			'<form action="/x?session_code=SECRET"><input value="user@example.com">' +
			'<input type="password" value="hunter2"></form>';
		const out = authHelpers.redactAuthHtml(html, { mail: "user@example.com", password: "hunter2" });
		assert.ok(!out.includes("SECRET"));
		assert.ok(!out.includes("user@example.com"));
		assert.ok(!out.includes("hunter2"));
		assert.ok(out.includes("session_code=***"));
	});

	it("masks the login code Keycloak carries as a hidden field, not only the one in a URL", () => {
		const html = '<form action="/x"><input type="hidden" name="session_code" value="SESSIONCODEVALUE"></form>';
		const out = authHelpers.redactAuthHtml(html);
		assert.ok(!out.includes("SESSIONCODEVALUE"), `a login code reached the log: ${out}`);
		assert.ok(out.includes('name="session_code"'), "the field stays visible, its value does not");
		assert.ok(out.includes('value="***"'));
	});

	it("masks the account address however the page spells it", () => {
		const mail = "user@example.com";
		const html =
			"<p>raw user@example.com</p>" +
			'<a href="/login?login_hint=user%40example.com">x</a>' +
			"<p>user&#64;example.com</p>" +
			'<a href="/restart?login_hint=user%40example%2Ecom">y</a>';
		const out = authHelpers.redactAuthHtml(html, { mail: mail, password: "secret" });
		assert.ok(!out.includes("user@example.com"), "the raw spelling");
		assert.ok(!out.includes("user%40example.com"), "the percent-encoded one the SSO puts in links");
		assert.ok(!out.includes("user&#64;example.com"), "and the entity-encoded one");
		// The address-shaped backstop cannot see a percent-encoded dot, so this spelling is the one
		// that shows the *configured* address is being masked and not merely anything mail-shaped.
		assert.ok(!out.includes("user%40example%2Ecom"), "and one escaped past what the backstop matches");
		assert.equal(
			(out.match(/\*\*\*@\*\*\*/g) ?? []).length,
			4,
			"each spelling has to be masked, not just the first",
		);
	});

	it("names the login account by its domain without writing the address out", () => {
		// The point of the line this feeds is comparing two addresses against each other — the one
		// configured and the one the reporter believes is configured — so the domain has to survive
		// while the local part must not.
		assert.equal(authHelpers.maskMailAddress("uwe.mueller@example.com"), "u***@example.com");
		assert.equal(authHelpers.maskMailAddress("  uwe.mueller@example.com  "), "u***@example.com");
		// A plus-addressed local part is still a local part, and an address may carry more than one
		// `@` — the domain is what follows the last one.
		assert.equal(authHelpers.maskMailAddress('"a@b"@example.com'), '"***@example.com');
		// Not an address at all: a misconfiguration that has to be visible as one, with nothing to
		// keep but the first character.
		assert.equal(authHelpers.maskMailAddress("uwe.mueller"), "u***");
		assert.equal(authHelpers.maskMailAddress("@example.com"), "@***");
		for (const empty of ["", "   ", undefined, null, 42]) {
			assert.equal(authHelpers.maskMailAddress(empty), "(not configured)", `for ${String(empty)}`);
		}
	});

	it("masks an address the adapter was never told about", () => {
		// The backstop is what covers a support address or a second account the page names: the
		// configured spelling only masks the one address the adapter happens to know.
		const out = authHelpers.maskAuthSecrets("Contact other.person+tag@some-provider.co.uk for help.", {});
		assert.ok(!out.includes("other.person+tag@some-provider.co.uk"));
		assert.ok(out.includes("***@***"));
	});

	it("does not rewrite the page when the password happens to be a markup word", () => {
		// A blind substring replace turned `type="hidden"` into `type="***"` for a password of
		// `hidden`, which destroys the page and tells every reader what the password is.
		const html = '<form action="/x"><input type="hidden" name="credentialId" value="pw-1"></form>';
		const out = authHelpers.redactAuthHtml(html, { mail: "user@example.com", password: "hidden" });
		assert.ok(out.includes('type="hidden"'), `the markup was mangled: ${out}`);
		assert.ok(!out.includes('type="***"'), "and the password must not be disclosed by what got masked");
	});

	it("masks a secret that lies across the truncation boundary", () => {
		// Cutting before redacting left `user@exa` — matching neither the configured spelling nor
		// an address-shaped pattern — in the log. Sweep the offsets where the cut falls inside the
		// secret, so the case cannot pass by the secret having been truncated away instead.
		const mail = "boundaryuser@example.com";
		const password = "straddlingpassword";
		for (let back = 4; back < mail.length; back++) {
			const pad = authHelpers.AUTH_HTML_LOG_LIMIT - "<p></p>".length - back;
			const html = `<p>${"x".repeat(pad)}${mail}</p><input value="${password}">`;
			const out = authHelpers.redactAuthHtml(html, { mail: mail, password: password });
			assert.ok(
				!out.includes("boundaryuser"),
				`the address survived the cut at offset ${back}: …${out.slice(-80)}`,
			);
			assert.ok(out.includes("***@***"), `the address was truncated away rather than masked at offset ${back}`);
		}
		// The password sits past the cut on every pad above, so it is checked where the cut falls
		// inside it: same sweep, this time with the address out of the way.
		for (let back = 4; back < password.length; back++) {
			const pad = authHelpers.AUTH_HTML_LOG_LIMIT - '<p></p><input value="'.length - back;
			const html = `<p>${"x".repeat(pad)}</p><input value="${password}">`;
			const out = authHelpers.redactAuthHtml(html, { mail: "user@example.com", password: password });
			assert.ok(
				!out.includes("straddling"),
				`the password survived the cut at offset ${back}: …${out.slice(-80)}`,
			);
			assert.ok(out.includes('value="***"'), `the password was truncated away rather than masked at ${back}`);
		}
	});

	it("truncates a long page instead of flooding the log", () => {
		const out = authHelpers.redactAuthHtml(`<p>${"x".repeat(20000)}</p>`);
		assert.equal(out.length, authHelpers.AUTH_HTML_LOG_LIMIT + " …(truncated)".length);
		assert.ok(out.endsWith("…(truncated)"));
	});

	it("survives a missing body", () => {
		assert.equal(authHelpers.redactAuthHtml(undefined), "");
	});
});

describe("redactAuthUrl", () => {
	it("masks the single-use login code but keeps the endpoint readable", () => {
		const url = authHelpers.redactAuthUrl(
			"https://sso.senec.com/realms/senec/login-actions/authenticate?session_code=abc&execution=pwd&tab_id=xyz",
		);
		assert.ok(!url.includes("abc"));
		assert.ok(url.includes("session_code=***"));
		assert.ok(url.includes("execution=pwd"));
		assert.ok(url.includes("tab_id=xyz"));
	});

	it("masks the authorization code in the app redirect", () => {
		const url = authHelpers.redactAuthUrl("senec-app-auth://keycloak.prod?code=SECRETCODE&state=s");
		assert.ok(!url.includes("SECRETCODE"));
		assert.ok(url.includes("code=***"));
	});

	it("keeps an error redirect legible so the reason survives", () => {
		const url = authHelpers.redactAuthUrl("senec-app-auth://keycloak.prod?error=access_denied");
		assert.ok(url.includes("error=access_denied"));
	});

	it("drops the query of an unparseable URL rather than risking a code in the log", () => {
		assert.equal(
			authHelpers.redactAuthUrl("/login-actions/authenticate?session_code=abc"),
			"/login-actions/authenticate",
		);
	});

	it("survives a missing URL", () => {
		assert.equal(authHelpers.redactAuthUrl(undefined), "n/a");
	});
});

describe("describeAuthFailure", () => {
	it("reports the OAuth error and description from a token endpoint refusal", () => {
		const described = authHelpers.describeAuthFailure({
			message: "Request failed with status code 400",
			response: { status: 400, data: { error: "invalid_grant", error_description: "Token is not active" } },
		});
		assert.ok(described.includes("HTTP 400"));
		assert.ok(described.includes("invalid_grant"));
		assert.ok(described.includes("Token is not active"));
	});

	it("pulls the readable part out of a Keycloak HTML error page", () => {
		const html =
			"<html><head><title>We are sorry...</title></head><body>" +
			'<span class="kc-feedback-text">Invalid username or password.</span></body></html>';
		const described = authHelpers.describeAuthFailure({
			message: "Request failed with status code 400",
			response: { status: 400, data: html },
		});
		assert.ok(described.includes("We are sorry"));
		assert.ok(described.includes("Invalid username or password."));
	});

	it("falls back to the bare status when the body says nothing", () => {
		const described = authHelpers.describeAuthFailure({
			message: "Request failed with status code 400",
			response: { status: 400, data: "" },
		});
		assert.ok(described.includes("HTTP 400"));
		assert.ok(described.includes("Request failed with status code 400"));
	});

	it("passes a network error through unchanged", () => {
		assert.equal(authHelpers.describeAuthFailure({ message: "socket hang up" }), "socket hang up");
	});
});

// Shared by the request queue's cooldown and the SENEC.Connect poll. A header the caller
// cannot read is worse than no header: it drops a server's explicit backoff request on the
// floor and invites a longer block.
describe("parseRetryAfterMs", () => {
	const parse = authHelpers.parseRetryAfterMs;
	const FALLBACK = 30000;
	const MAX = 3600000;

	it("reads delay-seconds", () => {
		assert.equal(parse("120", FALLBACK, MAX), 120000);
	});

	it("reads a numeric value that did not arrive as a string", () => {
		assert.equal(parse(90, FALLBACK, MAX), 90000);
	});

	it("tolerates surrounding whitespace", () => {
		assert.equal(parse("  45  ", FALLBACK, MAX), 45000);
	});

	// RFC 9110 allows an HTTP-date, and parseInt() used to return NaN for one — which silently
	// discarded the wait a date-answering server asked for.
	it("reads an HTTP-date as a wait from now", () => {
		const when = new Date(Date.now() + 60000).toUTCString();
		const parsed = parse(when, FALLBACK, MAX);
		assert.ok(parsed > 50000 && parsed <= 60000, `expected about 60s, got ${parsed}`);
	});

	it("falls back rather than not waiting at all", () => {
		for (const nothing of [undefined, null, "", "   ", "soon", "NaN"]) {
			assert.equal(parse(nothing, FALLBACK, MAX), FALLBACK, `${JSON.stringify(nothing)} should fall back`);
		}
	});

	it("falls back for a date already in the past", () => {
		assert.equal(parse(new Date(Date.now() - 60000).toUTCString(), FALLBACK, MAX), FALLBACK);
	});

	it("falls back for a negative or zero delay", () => {
		assert.equal(parse("0", FALLBACK, MAX), FALLBACK);
		assert.equal(parse(-5, FALLBACK, MAX), FALLBACK);
	});

	// A mistaken header — milliseconds sent as seconds, a date years out — must not be able to
	// park an unattended adapter for days with only a log line to explain the silence.
	it("caps a wait the server asks for", () => {
		assert.equal(parse("999999", FALLBACK, MAX), MAX);
		assert.equal(parse(new Date(Date.now() + 86400000 * 365).toUTCString(), FALLBACK, MAX), MAX);
	});
});

describe("computeBackoffDelay", () => {
	it("returns a number >= 0", () => {
		const delay = authHelpers.computeBackoffDelay(1000, 0);
		assert.equal(typeof delay, "number");
		assert.ok(delay >= 0);
	});

	it("stays within expected bounds for attempt 0", () => {
		for (let i = 0; i < 100; i++) {
			const delay = authHelpers.computeBackoffDelay(1000, 0);
			assert.ok(delay >= 0 && delay < 1000, `delay ${delay} out of bounds`);
		}
	});

	it("caps at maxMultiplier", () => {
		for (let i = 0; i < 100; i++) {
			const delay = authHelpers.computeBackoffDelay(1000, 100, 8);
			assert.ok(delay >= 0 && delay < 8000, `delay ${delay} out of bounds`);
		}
	});

	it("increases with attempt number on average", () => {
		let sum0 = 0;
		let sum3 = 0;
		const runs = 1000;
		for (let i = 0; i < runs; i++) {
			sum0 += authHelpers.computeBackoffDelay(1000, 0);
			sum3 += authHelpers.computeBackoffDelay(1000, 3);
		}
		assert.ok(sum3 / runs > sum0 / runs, "higher attempt should produce higher average delay");
	});
});

describe("normalizeRebuildMode", () => {
	it("returns 'off' for 'off'", () => {
		assert.equal(t.normalizeRebuildMode("off"), "off");
	});

	it("returns 'resume' for 'resume'", () => {
		assert.equal(t.normalizeRebuildMode("resume"), "resume");
	});

	it("returns 'force_full' for 'force_full'", () => {
		assert.equal(t.normalizeRebuildMode("force_full"), "force_full");
	});

	it("is case-insensitive", () => {
		assert.equal(t.normalizeRebuildMode("OFF"), "off");
		assert.equal(t.normalizeRebuildMode("Resume"), "resume");
		assert.equal(t.normalizeRebuildMode("FORCE_FULL"), "force_full");
	});

	it("returns 'off' for unknown values", () => {
		assert.equal(t.normalizeRebuildMode("garbage"), "off");
		assert.equal(t.normalizeRebuildMode(""), "off");
	});

	it("returns 'off' for null/undefined", () => {
		assert.equal(t.normalizeRebuildMode(null), "off");
		assert.equal(t.normalizeRebuildMode(undefined), "off");
	});
});

describe("HexToFloat32", () => {
	it("converts hex to float32", () => {
		// 0x41200000 = 10.0 in IEEE754
		assert.equal(t.HexToFloat32("41200000"), "10.00");
	});

	it("converts negative float", () => {
		// 0xC1200000 = -10.0 in IEEE754
		assert.equal(t.HexToFloat32("C1200000"), "-10.00");
	});

	it("returns 0 for zero input", () => {
		assert.equal(t.HexToFloat32("00000000"), 0);
	});

	it("handles 1.0", () => {
		// 0x3F800000 = 1.0
		assert.equal(t.HexToFloat32("3F800000"), "1.00");
	});
});

describe("DecToIP", () => {
	it("converts decimal to IP address", () => {
		// 0xC0A80101 = 3232235777 = 192.168.1.1 (but reversed byte order in Senec)
		// Senec stores as little-endian: 0x0101A8C0
		assert.equal(t.DecToIP(0x0101a8c0), "192.168.1.1");
	});

	it("converts zero to 0.0.0.0", () => {
		assert.equal(t.DecToIP(0), "0.0.0.0");
	});

	it("handles 255.255.255.255", () => {
		assert.equal(t.DecToIP(0xffffffff), "255.255.255.255");
	});
});

describe("reviverNumParse", () => {
	it("converts fl_ hex to float", () => {
		const result = t.reviverNumParse("key", "fl_41200000");
		assert.equal(result, "10.00");
	});

	it("converts u8_ hex to unsigned int", () => {
		const result = t.reviverNumParse("key", "u8_0A");
		assert.equal(result, 10);
	});

	it("converts u1_ hex to unsigned int", () => {
		const result = t.reviverNumParse("key", "u1_03E8");
		assert.equal(result, 1000);
	});

	it("converts st_ to string", () => {
		const result = t.reviverNumParse("key", "st_hello");
		assert.equal(result, "hello");
	});

	it("converts i1_ hex to signed 16-bit int (positive)", () => {
		const result = t.reviverNumParse("key", "i1_0064");
		assert.equal(result, 100);
	});

	it("converts i1_ hex to signed 16-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i1_FF9C");
		assert.equal(result, -100);
	});

	it("converts i3_ hex to signed 32-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i3_FFFFFF9C");
		assert.equal(result, -100);
	});

	it("converts i8_ hex to signed 8-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i8_9C");
		assert.equal(result, -100);
	});

	it("passes through VARIABLE_NOT_FOUND", () => {
		assert.equal(t.reviverNumParse("key", "VARIABLE_NOT_FOUND"), "VARIABLE_NOT_FOUND");
	});

	it("returns empty string for FILE_VARIABLE_NOT_READABLE", () => {
		assert.equal(t.reviverNumParse("key", "FILE_VARIABLE_NOT_READABLE"), "");
	});

	it("passes through the remaining device sentinels", () => {
		assert.equal(t.reviverNumParse("key", "FORBIDDEN"), "FORBIDDEN");
		assert.equal(t.reviverNumParse("key", "OBJECT_NOT_FOUND"), "OBJECT_NOT_FOUND");
		assert.equal(t.reviverNumParse("key", "MALFORMED_VALUE"), "MALFORMED_VALUE");
	});

	it("decodes ch_ without truncating at embedded underscores", () => {
		assert.equal(t.reviverNumParse("key", "ch_ABC_DEF"), "ABC_DEF");
	});

	it("keeps er_ whole so an error cannot pass as a reading", () => {
		assert.equal(t.reviverNumParse("key", "er_0042"), "er_0042");
	});

	it("passes through non-string values", () => {
		assert.equal(t.reviverNumParse("key", 42), 42);
		assert.equal(t.reviverNumParse("key", true), true);
		assert.equal(t.reviverNumParse("key", null), null);
	});

	it("flags unknown string formats", () => {
		const result = t.reviverNumParse("testKey", "zz_unknown");
		assert.ok(typeof result === "string" && result.startsWith("REPORT TO DEV:"));
	});

	// The appliance appends detail to a sentinel ("FORBIDDEN <variable>"), so an equality test
	// downstream missed it and the suffixed form was published as if it were a reading.
	it("normalises a sentinel that carries a suffix to its bare name", () => {
		assert.equal(t.reviverNumParse("key", "FORBIDDEN junk"), "FORBIDDEN");
		assert.equal(t.reviverNumParse("key", "VARIABLE_NOT_FOUND junk"), "VARIABLE_NOT_FOUND");
		assert.equal(t.reviverNumParse("key", "OBJECT_NOT_FOUND junk"), "OBJECT_NOT_FOUND");
		assert.equal(t.reviverNumParse("key", "MALFORMED_VALUE junk"), "MALFORMED_VALUE");
	});

	// A bare leading "u" used to select the unsigned-int branch, so the word "under_voltage"
	// was hex-parsed into the number 14 and published as a reading.
	it("does not decode a plain word starting with u as an unsigned int", () => {
		const result = t.reviverNumParse("key", "under_voltage");
		assert.equal(result, "REPORT TO DEV: key:under_voltage");
	});

	// An empty payload after the prefix parses to NaN, which used to reach setState as a number.
	it("never returns NaN for an empty unsigned-int payload", () => {
		const result = t.reviverNumParse("key", "u8_");
		assert.ok(typeof result === "string" && result.startsWith("REPORT TO DEV:"));
		assert.notEqual(typeof result, "number");
	});

	// ValueTyping asks isDeviceSentinel before coercing to number/boolean/date/IP; a sentinel
	// slipping past that check turns into a plausible-looking reading (NaN, true, garbage IP).
	it("isDeviceSentinel recognises every unavailability marker", () => {
		for (const sentinel of ["VARIABLE_NOT_FOUND", "FORBIDDEN", "OBJECT_NOT_FOUND", "MALFORMED_VALUE"]) {
			assert.ok(isDeviceSentinel(t.reviverNumParse("key", sentinel)), `${sentinel} not recognised`);
		}
		assert.ok(isDeviceSentinel(t.reviverNumParse("key", "er_0042")));
	});

	it("isDeviceSentinel accepts a real reading and an empty string", () => {
		assert.equal(isDeviceSentinel(t.reviverNumParse("key", "u8_0A")), false);
		assert.equal(isDeviceSentinel(t.reviverNumParse("key", "FILE_VARIABLE_NOT_READABLE")), false);
		assert.equal(isDeviceSentinel(""), false);
	});
});

describe("state_trans keys", () => {
	const state_trans = require("../lib/state_trans.js");
	const state_attr = require("../lib/state_attr.js");

	// Group the flat "<SECTION>.<DATAPOINT>.<lang>" keys by their datapoint.
	function byDatapoint() {
		const grouped = {};
		for (const key of Object.keys(state_trans)) {
			const dp = key.substring(0, key.lastIndexOf("."));
			(grouped[dp] ||= []).push(key.substring(key.lastIndexOf(".") + 1));
		}
		return grouped;
	}

	// doDecode builds its lookup key as "<dotted state name>.<lang>", so a key written with
	// an underscore where the state has a dot never matches and the _Text state is silently
	// never created. ENERGY_STAT_STATE.1/.2 were wrong this way, which cost every non-German
	// system its system-mode text.
	// Mixed case is allowed because the appliance's own sections are upper case while the keys
	// of the cloud APIs are the lower-case field names of those APIs. What this guards is the
	// separator, not the case.
	it("uses dot separators so doDecode can find them", () => {
		for (const key of Object.keys(state_trans)) {
			assert.ok(
				/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+\.\d$/.test(key),
				`${key} is not "<SECTION>.<DATAPOINT>.<lang>" — doDecode will never match it`,
			);
		}
	});

	// guiLang is "0" German, "1" English, "2" Italian, and defaults to "1". doDecode falls back
	// <lang> -> 1 -> 0, so a datapoint need not carry all three tables — but English is the last
	// stop before German, and without it an Italian user silently gets no text at all.
	it("provides the English fallback table for every datapoint", () => {
		for (const [dp, langs] of Object.entries(byDatapoint())) {
			assert.ok(langs.includes("1"), `${dp} has no English (.1) table for doDecode to fall back to`);
		}
	});

	// A table under an unknown language id is dead weight: doDecode only ever asks for 0, 1 or 2,
	// so a typo'd id looks like a translation but can never be reached.
	it("uses only the known language ids 0, 1 and 2", () => {
		for (const [dp, langs] of Object.entries(byDatapoint())) {
			for (const lang of langs) {
				assert.ok(["0", "1", "2"].includes(lang), `${dp}.${lang} is not a language doDecode requests`);
			}
		}
	});

	// doDecode writes its result to "<datapoint>_Text". Without a state_attr entry that state is
	// created with no name, role or type, so the decoded text shows up as an untyped raw object.
	it("has a matching state_attr _Text entry for every datapoint", () => {
		for (const dp of Object.keys(byDatapoint())) {
			assert.ok(Object.hasOwn(state_attr, `${dp}_Text`), `state_attr is missing "${dp}_Text"`);
		}
	});

	// Adding a new code to the German table only leaves every other language returning
	// "(unknown <value>)" for it — exactly the shape of the ENERGY.STAT_STATE bug.
	it("covers the same numeric codes in every language of a datapoint", () => {
		for (const [dp, langs] of Object.entries(byDatapoint())) {
			const reference = Object.keys(state_trans[`${dp}.${langs[0]}`]).sort();
			for (const lang of langs) {
				assert.deepEqual(
					Object.keys(state_trans[`${dp}.${lang}`]).sort(),
					reference,
					`${dp}.${lang} does not define the same codes as ${dp}.${langs[0]}`,
				);
			}
		}
	});
});

describe("PKCE helpers", () => {
	it("generateCodeVerifier returns a non-empty string", () => {
		const verifier = authHelpers.generateCodeVerifier();
		assert.equal(typeof verifier, "string");
		assert.ok(verifier.length > 0);
	});

	it("generateCodeVerifier produces unique values", () => {
		const v1 = authHelpers.generateCodeVerifier();
		const v2 = authHelpers.generateCodeVerifier();
		assert.notEqual(v1, v2);
	});

	it("generateCodeChallenge returns a base64url string", () => {
		const verifier = authHelpers.generateCodeVerifier();
		const challenge = authHelpers.generateCodeChallenge(verifier);
		assert.equal(typeof challenge, "string");
		assert.ok(challenge.length > 0);
		// base64url: no +, /, or =
		assert.ok(!/[+/=]/.test(challenge), "challenge should be base64url encoded");
	});

	it("generateCodeChallenge is deterministic for same input", () => {
		const verifier = authHelpers.generateCodeVerifier();
		const c1 = authHelpers.generateCodeChallenge(verifier);
		const c2 = authHelpers.generateCodeChallenge(verifier);
		assert.equal(c1, c2);
	});

	it("base64UrlEncode produces no padding or special chars", () => {
		const encoded = authHelpers.base64UrlEncode(Buffer.from("hello world"));
		assert.ok(!/[+/=]/.test(encoded));
	});
});

describe("AdaptiveRequestQueue", () => {
	it("executes a queued task", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 1 });
		const result = await queue.add(() => Promise.resolve("done"));
		assert.equal(result, "done");
	});

	it("respects concurrency limit", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 1, minTimeBetweenStartsMs: 0 });
		let running = 0;
		let maxRunning = 0;

		const task = () =>
			new Promise((resolve) => {
				running++;
				if (running > maxRunning) {
					maxRunning = running;
				}
				setTimeout(() => {
					running--;
					resolve();
				}, 20);
			});

		await Promise.all([queue.add(task), queue.add(task), queue.add(task)]);
		assert.equal(maxRunning, 1);
	});

	it("handles task failures without breaking the queue", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 2, minTimeBetweenStartsMs: 0 });

		await assert.rejects(() => queue.add(() => Promise.reject(new Error("fail"))), /fail/);

		// Queue should still work after a failure
		const result = await queue.add(() => Promise.resolve("ok"));
		assert.equal(result, "ok");
	});

	it("tracks statistics", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 2, minTimeBetweenStartsMs: 0 });

		await queue.add(() => Promise.resolve("ok"));
		await assert.rejects(() => queue.add(() => Promise.reject(new Error("fail"))));

		const stats = queue.getStats();
		assert.equal(stats.started, 2);
		assert.equal(stats.succeeded, 1);
		assert.equal(stats.failed, 1);
	});

	it("reduces concurrency on overload signal", async () => {
		const queue = new AdaptiveRequestQueue({
			concurrency: 3,
			minConcurrency: 1,
			minTimeBetweenStartsMs: 0,
			cooldownMs: 50,
		});

		const err = new Error("rate limited");
		err.response = { status: 429, headers: {} };
		await assert.rejects(() => queue.add(() => Promise.reject(err)));

		const stats = queue.getStats();
		assert.ok(stats.concurrency < 3, "concurrency should have been reduced");
		assert.equal(stats.rateLimited, 1);
	});

	it("accepts custom setTimeout/clearTimeout", async () => {
		let timerCalled = false;
		const queue = new AdaptiveRequestQueue({
			concurrency: 1,
			minTimeBetweenStartsMs: 0,
			setTimeout: (fn, ms) => {
				timerCalled = true;
				return setTimeout(fn, ms);
			},
			clearTimeout: (id) => clearTimeout(id),
		});

		// Trigger a cooldown to use the timer
		const err = new Error("rate limited");
		err.response = { status: 429, headers: {} };
		await assert.rejects(() => queue.add(() => Promise.reject(err)));

		assert.ok(timerCalled, "custom setTimeout should have been called for cooldown");
	});
});

// doDecode is handed the full state path. For the appliance's own tree the path IS the
// translation key, so every table that worked before must still be reached by the first
// candidate — a regression here silently drops every _Text state the appliance has.
describe("translationCandidates", () => {
	const candidates = t.translationCandidates;
	const state_trans = require("../lib/state_trans.js");

	it("tries the untouched path first, so appliance tables keep resolving", () => {
		for (const path of ["ENERGY.STAT_STATE", "FACTORY.BAT_TYPE", "BMS.MANUFACTURER", "WIZARD.GUI_LANG"]) {
			assert.equal(candidates(path)[0], path, `${path} must be tried unchanged and first`);
		}
	});

	it("adds nothing for a path of the appliance's own tree", () => {
		assert.deepEqual(candidates("ENERGY.STAT_STATE"), ["ENERGY.STAT_STATE"]);
	});

	it("strips the per-system prefix of SENEC.Connect", () => {
		assert.deepEqual(candidates("_connect.Systems.a1b2c3.battery.state"), [
			"_connect.Systems.a1b2c3.battery.state",
			"battery.state",
		]);
	});

	it("strips the prefix of the local OpenAPI", () => {
		assert.deepEqual(candidates("_openapi.battery.operatingState"), [
			"_openapi.battery.operatingState",
			"battery.operatingState",
		]);
	});

	// A system key containing a dot cannot occur — sanitizeKey replaces it — but if one ever did,
	// `[^.]+` would consume only its first segment and the greedy tail would capture everything
	// after it. That direction is the only one possible: the capture can leave a fragment of the
	// system key in front of the section, but it cannot swallow the section itself, so what comes
	// out is always still section-qualified rather than a bare field name.
	it("under-strips a dotted system key rather than losing the section", () => {
		assert.equal(candidates("_connect.Systems.sys1.meter.grid_power")[1], "meter.grid_power");
		const dotted = candidates("_connect.Systems.sy.s1.meter.grid_power")[1];
		assert.equal(dotted, "s1.meter.grid_power", "the leftover fragment stays in front of the section");
		assert.ok(dotted.endsWith("meter.grid_power"), "the section must survive the strip");
	});

	// The one case where a candidate really is a bare name: a path holding a single segment after
	// the prefix has nothing but that segment left to capture. This is the current behaviour, not a
	// guarded case — state_trans holds no single-segment table today (its only battery keys are
	// battery.state.{0,1,2}), so the collision is latent. Written down so that the day a bare-name
	// table is added, this test says where the clash comes from.
	it("collapses a single segment after the prefix to a bare name", () => {
		assert.deepEqual(candidates("_openapi.token"), ["_openapi.token", "token"]);
		assert.deepEqual(candidates("_connect.Systems.sys1.battery"), ["_connect.Systems.sys1.battery", "battery"]);
	});

	it("never produces an empty or duplicate candidate", () => {
		for (const path of ["_connect.Systems.x.battery.state", "_openapi.meter.gridPower", "ENERGY.STAT_STATE"]) {
			const keys = candidates(path);
			assert.deepEqual(keys, [...new Set(keys)], `${path} produced a duplicate candidate`);
			assert.ok(
				keys.every((key) => typeof key === "string" && key.length > 0),
				`${path} produced an empty candidate`,
			);
		}
	});

	// The trees listed in TRANSLATION_PREFIXES share one translation namespace, so a field two
	// connectors spell alike gets the same table whether or not that was meant. The local
	// OpenAPI battery state is the known case: SENEC.Connect documents 0=OK/1=error, while a
	// healthy V3 reports 1 locally. It must not reach the SENEC.Connect table.
	// Asserted as "no table at all" rather than "not that one table": comparing against
	// state_trans["battery.state.1"] is what the earlier version of this test did, and with both
	// sides undefined for a key that resolves to nothing it passed without testing anything — and
	// it would have gone on passing if someone copied the SENEC.Connect table under the new name,
	// which is the exact mistake being guarded. The language suffixes are the three doDecode tries.
	it("does not let the local OpenAPI battery states reach any translation table", () => {
		for (const path of [
			"_openapi.battery.operatingState",
			"_openapi.battery.stateOfCharge",
			"_openapi.battery.power",
		]) {
			for (const key of candidates(path)) {
				for (const lang of ["0", "1", "2"]) {
					assert.equal(
						state_trans[`${key}.${lang}`],
						undefined,
						`${path} resolved to the table ${key}.${lang}`,
					);
				}
			}
		}
	});

	// The other half, so the test above cannot pass merely because nothing resolves anywhere:
	// without the rename the path strips to battery.state, and the SENEC.Connect table is right
	// there waiting for it. Remove the rename in normalizeOpenapiSection and the test above fails.
	it("would have reached the SENEC.Connect table under the unrenamed name", () => {
		assert.deepEqual(candidates("_openapi.battery.state"), ["_openapi.battery.state", "battery.state"]);
		assert.ok(state_trans["battery.state.1"], "the table the rename exists to avoid must still be there");
	});
});

describe("local OpenAPI client", () => {
	const openapi = require("../lib/openapi-client.js");
	const state_attr = require("../lib/state_attr.js");

	describe("buildOpenapiInclude", () => {
		it("accepts the array the Admin multi-select stores", () => {
			assert.deepEqual(openapi.buildOpenapiInclude(["meter", "battery"]), ["battery", "meter", "bessNameplate"]);
		});

		it("accepts a comma-separated string, as configured by hand", () => {
			assert.deepEqual(openapi.buildOpenapiInclude("battery, meter"), ["battery", "meter", "bessNameplate"]);
		});

		// What Admin actually stored when the field's default was written as a string: the
		// multi-select seeded itself from it, giving an array holding the whole comma-joined
		// list as one element. Matching nothing, it silently reduced polling to the nameplate.
		it("splits an array whose single element is the whole comma-joined list", () => {
			assert.deepEqual(openapi.buildOpenapiInclude(["battery,meter,bessNameplate,evse"]), [
				"battery",
				"meter",
				"bessNameplate",
				"evse",
			]);
		});

		it("falls back to the default when nothing is configured", () => {
			for (const nothing of [undefined, null, ""]) {
				assert.deepEqual(
					openapi.buildOpenapiInclude(nothing),
					openapi.buildOpenapiInclude(openapi.DEFAULT_INCLUDE),
					`${JSON.stringify(nothing)} should fall back to the default`,
				);
			}
		});

		// Which sections the default is, spelled out rather than compared against itself: `bess`
		// answers nulls for activePower and reactivePower on a V3, and `evse` reports four wallbox
		// slots whether or not anything is attached to them — so including either by default gives
		// every owner empty channels and an extra request per cycle. The nameplate is not optional:
		// the certificate check and the plant matching are both built on it. Must stay in step with
		// the defaults in io-package.json and admin/jsonConfig.json.
		it("defaults to the battery, the meter and the nameplate, and to nothing else", () => {
			assert.equal(openapi.DEFAULT_INCLUDE, "battery,meter");
			assert.deepEqual(openapi.buildOpenapiInclude(undefined), ["battery", "meter", "bessNameplate"]);
		});

		// Every section is a route of its own here, so a name matching nothing would silently
		// poll one section fewer than the user asked for.
		it("drops a section the appliance has no route for", () => {
			assert.deepEqual(openapi.buildOpenapiInclude(["battery", "nonsense"]), ["battery", "bessNameplate"]);
		});

		// The certificate check compares the serial the nameplate reports against the subject of
		// the certificate, so leaving it out would disarm that check.
		it("always polls the nameplate, however it was configured away", () => {
			for (const without of [["battery"], "meter", ["evse", "bess"]]) {
				assert.ok(
					openapi.buildOpenapiInclude(without).includes("bessNameplate"),
					`${JSON.stringify(without)} must still include the nameplate`,
				);
			}
		});

		it("returns sections in route order, not in the order they were configured", () => {
			assert.deepEqual(openapi.buildOpenapiInclude(["evse", "battery", "meter"]), [
				"battery",
				"meter",
				"bessNameplate",
				"evse",
			]);
		});
	});

	describe("identityDigits", () => {
		// lala.cgi reports st_2097…, the certificate names the same appliance S2097….
		it("reduces both spellings of one appliance to the same digits", () => {
			assert.equal(openapi.identityDigits("st_209719282544"), "209719282544");
			assert.equal(openapi.identityDigits("S209719282544"), "209719282544");
			assert.equal(openapi.identityDigits("209719282544"), "209719282544");
		});

		// Both prefixes case-insensitively. Matching one that way and the other not meant a
		// lowercase "s2097…" kept its letter, failed the digits test and resolved to nothing —
		// which is "this appliance cannot be identified", and that blocks the plant matching.
		it("strips either prefix whatever case it arrives in", () => {
			for (const spelling of ["st_209719282544", "ST_209719282544", "S209719282544", "s209719282544"]) {
				assert.equal(openapi.identityDigits(spelling), "209719282544", spelling);
			}
		});

		it("rejects anything that is not an identifier", () => {
			for (const bad of [null, undefined, {}, [], "", "senecGuiSelf", "S", "st_", "12", true]) {
				assert.equal(openapi.identityDigits(bad), null, `${JSON.stringify(bad)} should not be an identity`);
			}
		});
	});

	describe("normalizeOpenapiSection", () => {
		// SENEC.Connect documents battery.state as 0 = OK / 1 = error, and state_attr plus the
		// translation tables are keyed on the object path rather than on the connector. A healthy
		// V3 reports 1 locally, so sharing that key would label a working battery as faulty.
		it("renames the battery state, which does not mean what SENEC.Connect's does", () => {
			const out = openapi.normalizeOpenapiSection("battery", { state: 1, stateOfCharge: 47 });
			assert.equal(out.operatingState, 1);
			assert.ok(!("state" in out), "the ambiguous name must not survive");
			assert.equal(out.stateOfCharge, 47);
		});

		it("renames the house consumption, which is not provably the same figure", () => {
			const out = openapi.normalizeOpenapiSection("meter", { consumption: 1181, production: 244 });
			assert.equal(out.houseConsumption, 1181);
			assert.ok(!("consumption" in out));
			assert.equal(out.production, 244, "production means the same in both and stays shared");
		});

		// /v1/bess answers activePower and reactivePower as null on a V3 — the route is partly
		// unimplemented. A null carried into the tree does not stay a null: ValueTyping coerces
		// every value with a unit through Number(), and Number(null) is 0 while isNaN(null) is
		// false, so the field was published as a confident "0 W" and could not be told apart from
		// a measured zero. Leaving the key out writes no state at all, so the last real reading is
		// not overwritten with a fabricated one. Absence is asserted with `in`, not by comparing to
		// undefined: evalPoll walks Object.entries, so a key present with value undefined would
		// still create a state and a value assertion would pass while the defect lived.
		it("omits a field the appliance reports as not available, rather than publishing it as zero", () => {
			const out = openapi.normalizeOpenapiSection("bess", {
				apparentPower: -237,
				activePower: null,
				reactivePower: undefined,
				voltage: 79,
				acRelayConnected: true,
			});
			assert.ok(!("activePower" in out), "a null must not be published as a reading");
			assert.ok(!("reactivePower" in out), "an absent field must not be published either");
			assert.equal(out.apparentPower, -237, "the fields that do carry readings must survive");
			assert.equal(out.voltage, 79);
			assert.equal(out.acRelayConnected, true, "a false-y but real value must not be dropped with them");
		});

		// A zero, unlike a null, is a measurement. Dropping it would hide a real reading, so the
		// two must not be treated alike.
		it("keeps a genuine zero", () => {
			const out = openapi.normalizeOpenapiSection("meter", { gridPower: 0, powerSurplus: 0 });
			assert.equal(out.gridPower, 0);
			assert.ok("powerSurplus" in out);
		});

		// The nameplate nests: `ratedPower` is an object whose leaves carry units of their own, so
		// a filter that only looked at the top level left those publishing fabricated zeros.
		it("drops an unavailable leaf however deeply it is nested", () => {
			const out = openapi.normalizeOpenapiSection("bessNameplate", {
				ratedPower: { charge: 2500, discharge: null, perPhase: { l1: null, l2: 833 } },
			});
			assert.ok(!("discharge" in out.ratedPower), "one level down");
			assert.ok(!("l1" in out.ratedPower.perPhase), "and two");
			assert.equal(out.ratedPower.perPhase.l2, 833, "while the readings beside them survive");
		});

		it("leaves sections without an ambiguous field untouched", () => {
			const plate = { manufacturer: "SENEC GmbH", model: "SENEC.Home V3 hybrid LFP" };
			assert.deepEqual(openapi.normalizeOpenapiSection("bessNameplate", plate), plate);
		});

		it("survives a body that is not an object", () => {
			for (const odd of [null, undefined, 5, "x", []]) {
				assert.doesNotThrow(() => openapi.normalizeOpenapiSection("battery", odd));
			}
		});

		// The rename is only worth anything if the new name actually resolves to a definition of
		// its own, and the old one still resolves to SENEC.Connect's.
		it("renames onto keys that have their own state_attr definitions", () => {
			assert.ok(state_attr["battery.operatingState"], "battery.operatingState needs a definition");
			assert.ok(state_attr["meter.houseConsumption"], "meter.houseConsumption needs a definition");
			assert.notEqual(
				state_attr["battery.operatingState"].name,
				state_attr["battery.state"].name,
				"the renamed field must not reuse SENEC.Connect's description",
			);
		});
	});

	// evalPoll keys state_attr on the object path it walks, not on the state prefix. Passing a
	// bare payload under a "_openapi.battery." prefix therefore produced keys like
	// "stateOfCharge" with the section lost, and every definition went unmatched — the states
	// appeared, undescribed and unitless, and the adapter logged REPORT_TO_DEV for each. This
	// walks the payloads the appliance actually returned and asserts every leaf resolves.
	describe("state_attr coverage for the recorded payloads", () => {
		const resolve = t.resolveStateAttrKey;
		const state_attr = require("../lib/state_attr.js");

		// Verbatim shapes from the appliance; see docs/LOCAL_OPENAPI_4424.md.
		const payloads = {
			battery: { state: 1, stateOfCharge: 47, power: -850.8078, voltage: 52.2, current: -16.299 },
			meter: { gridPower: 91, consumption: 1181, production: 244, powerSurplus: 0, fullRangePowerSurplus: 0 },
			// activePower and reactivePower really are null here — /v1/bess is partly
			// unimplemented on the appliance. Substituting zeros would make this fixture a
			// different payload than the recorded one, and it is exactly the null that the
			// normalizer has to drop.
			bess: {
				apparentPower: -237,
				activePower: null,
				reactivePower: null,
				voltage: 79,
				current: -3,
				acRelayConnected: true,
			},
			bessNameplate: {
				manufacturer: "SENEC GmbH",
				model: "SENEC.Home V3 hybrid LFP",
				serialNumber: "S0000",
				designCapacity: 5000,
				ratedPower: {
					activeChargePower: 2500,
					activeDischargePower: 4600,
					reactiveChargePower: 1500,
					reactiveDischargePower: 2760,
				},
			},
			evse: {
				devices: [
					{ id: 1, evConnected: false, evCharging: false, limitationStatus: 0, chargingPower: 0 },
					{ id: 2, evConnected: true, evCharging: true, limitationStatus: 0, chargingPower: 3600 },
				],
			},
		};

		/**
		 * Every leaf key evalPoll would build for one section, exactly as the connector hands it over.
		 *
		 * @param {string} section - Section name
		 * @returns {string[]} Dotted keys
		 */
		function keysFor(section) {
			const body =
				section === "evse"
					? openapi.keyOpenapiWallboxes(payloads.evse)
					: openapi.normalizeOpenapiSection(section, payloads[section]);
			const keys = [];
			const walk = (obj, prefix) => {
				for (const [k, v] of Object.entries(obj)) {
					const key = prefix ? `${prefix}.${k}` : k;
					if (v !== null && typeof v === "object") {
						walk(v, key);
					} else {
						keys.push(key);
					}
				}
			};
			walk({ [section]: body }, "");
			return keys;
		}

		for (const section of Object.keys(payloads)) {
			it(`defines every field of /v1/${section === "bessNameplate" ? "bess/nameplate" : section}`, () => {
				const missing = keysFor(section).filter((key) => !resolve(key, state_attr));
				assert.deepEqual(missing, [], `no state_attr definition for: ${missing.join(", ")}`);
			});
		}

		// The nulls above drop out of the walk, so the loop no longer reaches these two keys — yet
		// they are defined, and will be written the moment the appliance starts reporting figures
		// for them. Their units are also precisely what made the null dangerous: ValueTyping
		// coerces anything carrying a unit through Number(), and Number(null) is 0 with
		// isNaN(null) false, so a missing reading would have been published as a confident 0 W.
		it("defines the bess fields the appliance currently reports as null", () => {
			for (const key of ["bess.activePower", "bess.reactivePower"]) {
				assert.ok(resolve(key, state_attr), `no state_attr definition for ${key}`);
				assert.ok(state_attr[key].unit, `${key} carries a unit, which is why a null must not become 0`);
			}
			assert.ok(!keysFor("bess").includes("bess.activePower"), "a null must not reach the object tree");
			assert.ok(!keysFor("bess").includes("bess.reactivePower"));
		});

		// The renames only pay off if the new names carry their own definitions and the old ones
		// still belong to SENEC.Connect.
		it("keeps the renamed fields distinct from the SENEC.Connect ones", () => {
			assert.ok(keysFor("battery").includes("battery.operatingState"));
			assert.ok(!keysFor("battery").includes("battery.state"));
			assert.ok(keysFor("meter").includes("meter.houseConsumption"));
			assert.ok(!keysFor("meter").includes("meter.consumption"));
		});

		// A wallbox is keyed on its slot id, so the definition has to be found with that interior
		// segment removed — which is resolveStateAttrKey's job, not a copy of each key per slot.
		it("resolves wallbox fields through the slot id", () => {
			assert.equal(resolve("evse.2.chargingPower", state_attr), "evse.chargingPower");
			assert.equal(resolve("evse.2.limitationStatus", state_attr), "evse.limitationStatus");
		});
	});

	describe("keyOpenapiWallboxes", () => {
		const body = {
			devices: [
				{ id: 1, evConnected: false, chargingPower: 0 },
				{ id: 2, evConnected: true, chargingPower: 3600 },
			],
		};

		it("keys the slots on the id the appliance reports", () => {
			const keyed = openapi.keyOpenapiWallboxes(body);
			assert.deepEqual(Object.keys(keyed), ["1", "2"]);
			assert.equal(keyed["2"].chargingPower, 3600);
		});

		it("accepts a bare array as well as the documented wrapper", () => {
			assert.deepEqual(Object.keys(openapi.keyOpenapiWallboxes(body.devices)), ["1", "2"]);
		});

		it("returns nothing for a body that carries no devices", () => {
			for (const empty of [null, undefined, {}, { devices: null }, 7, "x"]) {
				assert.deepEqual(openapi.keyOpenapiWallboxes(empty), {});
			}
		});

		// Falling back to the position keeps a slot with no usable id from colliding with another.
		it("falls back to the position when a slot reports no id", () => {
			const keyed = openapi.keyOpenapiWallboxes({ devices: [{ evConnected: false }, { evConnected: true }] });
			assert.deepEqual(Object.keys(keyed), ["0", "1"]);
		});

		it("skips entries that are not objects instead of abandoning the rest", () => {
			const keyed = openapi.keyOpenapiWallboxes({ devices: [null, { id: 3 }, "nope"] });
			assert.deepEqual(Object.keys(keyed), ["3"]);
		});

		it("makes an id with path-unsafe characters safe", () => {
			const keyed = openapi.keyOpenapiWallboxes({ devices: [{ id: "WB.01" }] });
			assert.deepEqual(Object.keys(keyed), ["WB_01"]);
		});

		// Sanitising is lossy: "WB/01" and "WB.01" are two slots that both become "WB_01". Keeping
		// one key for both would serve one slot's states out of the other slot's payload — the
		// wrong charging power under the wrong wallbox, which is worse than an ugly key. The
		// payloads are told apart by a field of their own, because counting keys alone would not
		// notice an overwrite.
		it("gives two slots whose ids sanitise alike distinct keys", () => {
			const keyed = openapi.keyOpenapiWallboxes({
				devices: [
					{ id: "WB/01", chargingPower: 3600 },
					{ id: "WB.01", chargingPower: 0 },
				],
			});
			assert.deepEqual(Object.keys(keyed), ["WB_01", "WB_01-2"]);
			assert.equal(keyed["WB_01"].chargingPower, 3600, "the first slot keeps its own payload");
			assert.equal(keyed["WB_01-2"].chargingPower, 0, "the second slot is not served from the first");
		});

		// The slots bypassed the null filter entirely, so an unattached slot reporting
		// `chargingPower: null` published a confident 0 VA and `evConnected: null` published
		// false — ValueTyping coerces anything carrying a unit through Number(), and Number(null)
		// is 0. They go through the same filter as every other section now, nesting included.
		it("drops a slot's unavailable fields rather than publishing them as zeros", () => {
			const keyed = openapi.keyOpenapiWallboxes({
				devices: [
					{
						id: 4,
						chargingPower: null,
						evConnected: null,
						limits: { current: null, phases: 3 },
					},
				],
			});
			assert.ok(!("chargingPower" in keyed["4"]), "a null must not become a reading");
			assert.ok(!("evConnected" in keyed["4"]), "nor a confident false");
			assert.ok(!("current" in keyed["4"].limits), "and the filter reaches into the nested values");
			assert.equal(keyed["4"].limits.phases, 3);
		});

		// The positional fallback is not a safe key either: position 1 is "1", and a slot that
		// reports id 1 claims that name first.
		it("does not let the positional fallback collide with a real id", () => {
			const keyed = openapi.keyOpenapiWallboxes({ devices: [{ id: "1", chargingPower: 3600 }, {}] });
			assert.deepEqual(Object.keys(keyed), ["1", "1-2"]);
			assert.equal(keyed["1"].chargingPower, 3600, "the slot that named itself keeps the plain key");
			assert.ok(!("chargingPower" in keyed["1-2"]), "the nameless slot must not inherit the other's payload");
		});
	});

	// Approving and withdrawing both name a plant, so this decides which appliance of the
	// account gets written to. Acting on a guessed number would act on someone else's system.
	//
	// What it needs is the account credentials, NOT the mein-senec.de connector: an instance
	// that polls nothing from the cloud but has credentials can still drive the portal, logging
	// in on demand. These cases cover that distinction.
	describe("openapiPortalReady", () => {
		/**
		 * A faithful stand-in for the session ownership web-client now holds.
		 *
		 * `webAcquireSession` is not a formality to be stubbed away with `{ok: true}`: it decides
		 * whether this connector may touch the portal at all, and its three answers — "the
		 * mein-senec.de connector owns the session, wait for it", "nobody does, so sign in and owe
		 * a release", "the sign-in failed" — are precisely what the cases below are about. So this
		 * mirrors the real rules: `web_use` hands ownership to that connector, the account
		 * credentials are the dependency otherwise, borrowers are counted, and the sign-in goes
		 * through the stubbed `webLogin` so a test can see whether one happened.
		 *
		 * Not reproduced: the single-flight promise that collapses concurrent sign-ins. That is
		 * web-client's own contract and nothing here calls in twice at once.
		 *
		 * @param {object} [over] - Overrides; `webLogin` decides whether the sign-in succeeds
		 * @returns {{stub: object, calls: {logins: number, releases: number}}} Module double, with counters
		 */
		function sessionStub(over = {}) {
			const calls = { logins: 0, releases: 0 };
			const login = over.webLogin || (async () => true);
			const stub = {
				webGet: over.webGet || (async () => ({ data: {} })),
				webPost: over.webPost || (async () => ({ status: 200, data: "" })),
				webLogin: async (a) => {
					calls.logins++;
					return login(a);
				},
				webAcquireSession: async (a) => {
					if (a.config.web_use) {
						return a.webAuthenticated
							? { ok: true, borrowed: false }
							: {
									ok: false,
									borrowed: false,
									reason: "the mein-senec.de connector has not established its session yet",
								};
					}
					if (!a.config.api_mail || !a.config.api_pwd) {
						return {
							ok: false,
							borrowed: false,
							reason: "no SENEC account credentials are configured (SENEC Account tab)",
						};
					}
					// Counted before the login is awaited, the way the real one does it, so a
					// release arriving mid-login cannot tear the session down under the caller.
					a.webSessionHolders = (a.webSessionHolders || 0) + 1;
					if (!a.webAuthenticated) {
						a.webAuthenticated = await stub.webLogin(a);
						if (!a.webAuthenticated) {
							stub.webReleaseSession(a);
							return {
								ok: false,
								borrowed: false,
								reason: "the SENEC account could not be logged in to",
							};
						}
					}
					return { ok: true, borrowed: true };
				},
				webReleaseSession: (a) => {
					calls.releases++;
					if (a.config.web_use) {
						return;
					}
					a.webSessionHolders = Math.max(0, (a.webSessionHolders || 0) - 1);
					if (a.webSessionHolders === 0) {
						a.webAuthenticated = false;
						a.webJar = null;
					}
				},
			};
			return { stub, calls };
		}

		const adapter = (over = {}) => ({
			// Already authenticated, so no login is attempted and no network is touched.
			webAuthenticated: true,
			webMasterPlantNumber: 0,
			webMasterPlantSerial: "st_209719282544",
			webSecondaryPlants: new Map(),
			openapiExpectedDeviceId: "209719282544",
			unloaded: false,
			log: { warn: () => {}, info: () => {} },
			...over,
			// After the spread, so an override merges with the credentials rather than replacing
			// the whole config and silently removing them.
			config: { api_mail: "a@b.c", api_pwd: "x", ...(over.config || {}) },
		});

		it("proceeds when the plant is identified by the appliance's own serial", async () => {
			const ready = await openapi.openapiPortalReady(adapter());
			assert.equal(ready.ok, true);
			assert.equal(ready.plant, 0);
			// Matched against this appliance's own control-unit number, so the withdraw path may
			// read "not listed on this plant" as "the entry is gone".
			assert.equal(ready.verified, true);
		});

		it("refuses without account credentials, whatever else is set", async () => {
			for (const creds of [
				{ api_mail: "", api_pwd: "x" },
				{ api_mail: "a@b.c", api_pwd: "" },
				{ api_mail: "", api_pwd: "" },
			]) {
				const ready = await openapi.openapiPortalReady(adapter({ config: creds }));
				assert.equal(ready.ok, false, JSON.stringify(creds));
				assert.match(ready.reason, /credentials/);
			}
		});

		// The point of the rewrite: web_use off must not block it. Credentials are the dependency.
		it("does not require the mein-senec.de connector to be enabled", async () => {
			const ready = await openapi.openapiPortalReady(adapter({ config: { web_use: false } }));
			assert.equal(ready.ok, true);
			assert.equal(ready.plant, 0);
		});

		// A configured plant is honoured over anything derivable, but it does not remove the need
		// for a session: approving and withdrawing are portal calls themselves. Signing in here
		// also marks the session as ours, so the caller drops it again afterwards.
		it("honours a configured plant but still establishes a session", async () => {
			const { stub, calls } = sessionStub();
			const signsIn = proxyquire("../lib/openapi-client.js", { "./web-client.js": stub });
			const ready = await signsIn.openapiPortalReady(
				adapter({
					config: { api_mail: "a@b.c", api_pwd: "x", openapi_plant: "1" },
					webAuthenticated: false,
					webMasterPlantSerial: "st_111111111111",
					webSecondaryPlants: new Map([["st_999999999999", { anlageNummer: 1, produktName: "old" }]]),
				}),
			);
			assert.equal(ready.ok, true);
			assert.equal(ready.plant, 1);
			assert.equal(calls.logins, 1, "the portal calls that follow need a session");
			assert.equal(ready.ours, true, "a session opened here is ours to drop again");
			// A number typed into the field is authoritative for building the approval link, but
			// nothing has checked it against this appliance — so the withdraw path must not read
			// "no entry on this plant" as "the entry is gone".
			assert.equal(ready.verified, false, "a plant typed by hand is not verified against this appliance");
		});

		it("reports a refused sign-in rather than acting without a session", async () => {
			const { stub, calls } = sessionStub({ webLogin: async () => false });
			const refused = proxyquire("../lib/openapi-client.js", { "./web-client.js": stub });
			const ready = await refused.openapiPortalReady(
				adapter({
					config: { api_mail: "a@b.c", api_pwd: "x", openapi_plant: "1" },
					webAuthenticated: false,
				}),
			);
			assert.equal(ready.ok, false);
			assert.match(ready.reason, /logged in/);
			assert.equal(calls.logins, 1, "it did try, rather than refusing without looking");
		});

		// An existing session is not signed into again — but it is still borrowed, because
		// web-client counts borrowers and only the last one out drops the pair. A caller that
		// took `ours: false` from here and skipped its release would leave the count standing
		// and the session alive for nobody.
		it("does not sign in again when a session already exists, but still owes a release", async () => {
			const { stub, calls } = sessionStub();
			const shared = proxyquire("../lib/openapi-client.js", { "./web-client.js": stub });
			const a = adapter({ config: { api_mail: "a@b.c", api_pwd: "x", openapi_plant: "1" } });
			const ready = await shared.openapiPortalReady(a);
			assert.equal(ready.ok, true);
			assert.equal(ready.plant, 1);
			assert.equal(calls.logins, 0, "an established session is used as it is");
			assert.equal(ready.ours, true);
			assert.equal(a.webSessionHolders, 1, "the borrow is counted, so the release is owed");
		});

		// With the mein-senec.de connector enabled, its startup owns the session; signing in here
		// would hand one of the two an emptied cookie jar.
		it("waits for the mein-senec.de connector rather than racing its login", async () => {
			const ready = await openapi.openapiPortalReady(
				adapter({
					config: { api_mail: "a@b.c", api_pwd: "x", openapi_plant: "1", web_use: true },
					webAuthenticated: false,
				}),
			);
			assert.equal(ready.ok, false);
			assert.match(ready.reason, /mein-senec\.de connector/);
		});

		// The cases below reach the portal walk, so web-client is stubbed. No network, but the
		// decision logic is the real thing.
		describe("when the appliance could not be identified", () => {
			/**
			 * openapi-client with its portal calls stubbed out.
			 *
			 * @param {Array<object>} plants - One entry per plant the account is to report
			 * @returns {object} The module, with webGet answering from `plants`
			 */
			function withPlants(plants) {
				const { stub } = sessionStub({
					webGet: async (_adapter, url) => {
						if (url.includes("getEndkunde")) {
							return { data: { anzahlAnlagen: plants.length } };
						}
						const n = Number(new URL(url).searchParams.get("anlageNummer"));
						return { data: plants[n] || {} };
					},
				});
				return proxyquire("../lib/openapi-client.js", { "./web-client.js": stub });
			}

			const blind = (over = {}) =>
				adapter({
					// No identity from lala.cgi, and the certificate probe cannot run in a test.
					openapiExpectedDeviceId: null,
					webMasterPlantNumber: null,
					webMasterPlantSerial: null,
					log: { warn: () => {}, info: () => {}, debug: () => {} },
					applyDefaultHeaders: () => {},
					buildUserAgent: () => "test",
					...over,
				});

			// A one-appliance household is the ordinary case, and there is nothing to confuse the
			// plant with — so it must work even with no identity at all.
			it("uses the only plant when the account holds exactly one", async () => {
				const mod = withPlants([{ steuereinheitnummer: "S209719282544" }]);
				const ready = await mod.openapiPortalReady(blind());
				assert.equal(ready.ok, true);
				assert.equal(ready.plant, 0);
				// Nothing to confuse it with, so this one counts as checked: a withdrawal that
				// finds no entry here really has found none.
				assert.equal(ready.verified, true);
			});

			// This is the guard that matters: several plants and no way to tell which is ours.
			// Writing against a guess here would act on another of the account's appliances.
			it("refuses when the account holds several and none can be matched", async () => {
				const mod = withPlants([
					{ steuereinheitnummer: "S111111111111" },
					{ steuereinheitnummer: "S999999999999" },
				]);
				const ready = await mod.openapiPortalReady(blind());
				assert.equal(ready.ok, false);
				assert.match(ready.reason, /could not be identified/);
			});

			// With an identity, the right plant is picked out of several rather than guessed.
			it("picks the matching plant out of several", async () => {
				const mod = withPlants([
					{ steuereinheitnummer: "S111111111111" },
					{ steuereinheitnummer: "S209719282544" },
				]);
				const ready = await mod.openapiPortalReady(blind({ openapiExpectedDeviceId: "209719282544" }));
				assert.equal(ready.ok, true);
				assert.equal(ready.plant, 1);
				assert.equal(ready.verified, true, "matched on this appliance's own identity");
			});

			it("refuses when several plants exist and the identity matches none of them", async () => {
				const mod = withPlants([
					{ steuereinheitnummer: "S111111111111" },
					{ steuereinheitnummer: "S999999999999" },
				]);
				const ready = await mod.openapiPortalReady(blind({ openapiExpectedDeviceId: "209719282544" }));
				assert.equal(ready.ok, false);
				assert.match(ready.reason, /none of the 2/);
			});

			// A refusal reached after this connector signed in for itself still has to say whose
			// session it is. Dropping `ours` from the failure path leaves an authenticated
			// mein-senec.de session behind on an instance that asked for none — which is the one
			// thing this connector promises not to do — and the caller has no other way to know.
			it("still reports the session as ours when it refuses after signing in", async () => {
				const mod = withPlants([
					{ steuereinheitnummer: "S111111111111" },
					{ steuereinheitnummer: "S999999999999" },
				]);
				const ready = await mod.openapiPortalReady(blind({ webAuthenticated: false }));
				assert.equal(ready.ok, false);
				assert.equal(ready.ours, true, "the caller has to release the session it made us open");
				assert.match(ready.reason, /could not be identified/);
			});

			// The portal walk is two network calls, so it can fail outright. Throwing here would
			// abandon the session as well as the registration, since nothing above this catches.
			it("reports a failed plant walk rather than throwing, and still owns up to the session", async () => {
				const { stub } = sessionStub({
					webGet: async () => {
						throw new Error("portal unreachable");
					},
				});
				const broken = proxyquire("../lib/openapi-client.js", { "./web-client.js": stub });
				const ready = await broken.openapiPortalReady(blind({ webAuthenticated: false }));
				assert.equal(ready.ok, false);
				assert.equal(ready.ours, true);
				assert.match(ready.reason, /could not be read: portal unreachable/);
			});
		});
	});

	// There is no published CA for the chain on port 4424, so this is what stands in for chain
	// validation: the certificate names the individual appliance, so it can be pinned to a device
	// rather than merely to "something that answered". Three decisions live here and each one is
	// load-bearing — refusing two devices in one instance, pinning on first use, and adopting the
	// identity the appliance presents when nothing else knows it.
	describe("openapiVerifyPeer", () => {
		const crypto = require("node:crypto");

		/**
		 * Adapter with the two sinks openapiVerifyPeer writes to recorded.
		 *
		 * @param {object} [over] - Overrides merged over the defaults
		 * @returns {object} Adapter double with `states` and `logs`
		 */
		const adapter = (over = {}) => {
			const a = {
				openapiExpectedDeviceId: null,
				openapiFingerprint: null,
				openapiIdentityMismatch: false,
				states: [],
				logs: [],
				doState: async (id, value) => {
					a.states.push([id, value]);
				},
				log: {
					error: (msg) => a.logs.push(["error", msg]),
					warn: (msg) => a.logs.push(["warn", msg]),
					debug: (msg) => a.logs.push(["debug", msg]),
				},
				...over,
			};
			return a;
		};

		/**
		 * A certificate as the TLS layer presents it.
		 *
		 * @param {string} cn - Common name of the subject
		 * @param {string} [body] - Bytes the fingerprint is taken over
		 * @returns {{raw: Buffer, subject: {CN: string}}} Certificate double
		 */
		const cert = (cn, body = "cert-one") => ({ raw: Buffer.from(body), subject: { CN: cn } });

		/**
		 * @param {string} body - The same bytes handed to `cert()`
		 * @returns {string} The fingerprint openapiVerifyPeer must compute
		 */
		const fingerprintOf = (body) => crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");

		// Two appliances in one instance is a configuration error, and everything downstream —
		// polling, registering, approving — keys off this flag to stop. It must be set, and the
		// contradicting identity must not be adopted on the way out.
		it("refuses a certificate naming another appliance, and adopts nothing from it", async () => {
			const a = adapter({ openapiExpectedDeviceId: "209719282544" });
			await openapi.openapiVerifyPeer(a, cert("S999999999999"));
			assert.equal(a.openapiIdentityMismatch, true);
			assert.equal(a.openapiExpectedDeviceId, "209719282544", "the configured appliance stands");
			assert.equal(a.openapiFingerprint, null, "a refused certificate must not be pinned either");
			assert.deepEqual(a.states, [], "and nothing about it is written");
			assert.ok(
				a.logs.some(([level, msg]) => level === "error" && /different appliance/.test(msg)),
				"a mismatch is an error, not a debug line",
			);
		});

		// Trust on first use, and it has to be written down: the state is what openapiInit reads
		// back on the next start, so a pin kept only in memory would re-pin silently after every
		// restart and the check below would never fire.
		it("pins the first certificate it sees and writes the fingerprint down", async () => {
			const a = adapter();
			await openapi.openapiVerifyPeer(a, cert("S209719282544"));
			assert.equal(a.openapiFingerprint, fingerprintOf("cert-one"));
			assert.deepEqual(a.states, [["_openapi.tls.fingerprint", fingerprintOf("cert-one")]]);
			assert.equal(a.openapiIdentityMismatch, false);
		});

		// A certificate does get replaced, so this is reported and then accepted — refusing to
		// talk to the appliance until someone intervenes would be the worse failure.
		it("warns about a changed certificate and then re-pins it", async () => {
			const a = adapter({ openapiFingerprint: fingerprintOf("cert-one") });
			await openapi.openapiVerifyPeer(a, cert("S209719282544", "cert-two"));
			assert.ok(
				a.logs.some(([level, msg]) => level === "warn" && /certificate on port 4424 changed/.test(msg)),
				"a swapped certificate has to be said out loud",
			);
			assert.equal(a.openapiFingerprint, fingerprintOf("cert-two"), "and then accepted");
			assert.deepEqual(a.states, [["_openapi.tls.fingerprint", fingerprintOf("cert-two")]]);
		});

		// The handshake is the only identity available to an instance that polls nothing from
		// lala.cgi and holds no approved token — which is the state auto-approval works from.
		it("adopts the appliance identity from the certificate when nothing else knows it", async () => {
			const a = adapter();
			await openapi.openapiVerifyPeer(a, cert("S209719282544"));
			assert.equal(a.openapiExpectedDeviceId, "209719282544");
		});

		// Only when nothing is known: an identity that came from FACTORY.DEVICE_ID has to keep
		// its spelling, because it is the one the mismatch check above compares against.
		it("leaves a known identity alone rather than restating it from the certificate", async () => {
			const a = adapter({ openapiExpectedDeviceId: "st_209719282544" });
			await openapi.openapiVerifyPeer(a, cert("S209719282544"));
			assert.equal(a.openapiIdentityMismatch, false, "the two spellings name the same appliance");
			assert.equal(a.openapiExpectedDeviceId, "st_209719282544", "not overwritten by the certificate");
		});

		// A response whose certificate cannot be read says nothing about which appliance answered,
		// so it must not be taken as the all-clear: a standing refusal stays standing. Reporting
		// "no mismatch" here would reopen polling and registration on an instance that had already
		// established it is talking to two different devices.
		it("does not clear a standing mismatch on a certificate it cannot read", async () => {
			for (const unreadable of [undefined, null, {}, { subject: { CN: "S209719282544" } }]) {
				const a = adapter({ openapiIdentityMismatch: true, openapiExpectedDeviceId: "209719282544" });
				await openapi.openapiVerifyPeer(a, unreadable);
				assert.equal(a.openapiIdentityMismatch, true, JSON.stringify(unreadable));
				assert.deepEqual(a.states, [], "and nothing is pinned from it");
			}
		});
	});

	describe("openapiResolvePlant", () => {
		const adapter = (over = {}) => ({
			config: {},
			webMasterPlantNumber: null,
			webMasterPlantSerial: null,
			webSecondaryPlants: new Map(),
			openapiExpectedDeviceId: null,
			log: { warn: () => {} },
			...over,
		});

		it("returns the plant number the approval URL is built from", () => {
			const resolved = openapi.openapiResolvePlant(
				adapter({
					webMasterPlantNumber: 0,
					webMasterPlantSerial: "st_111111111111",
					webSecondaryPlants: new Map([["st_209719282544", { anlageNummer: 1, produktName: "V3" }]]),
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.deepEqual(resolved, { plant: 1, exact: true });
		});

		// The guard that keeps "the only plant we found" from being reported as a fact. The
		// comparison above has already failed on this master's control unit, so it is positively a
		// different appliance — and the callers that write to the user's portal short-circuit their
		// own verification on `exact`, which would have them approving or withdrawing a
		// registration on somebody else's system on the strength of a guess.
		it("will not call a master that is positively another appliance certain", () => {
			const resolved = openapi.openapiResolvePlant(
				adapter({
					webMasterPlantNumber: 0,
					webMasterPlantSerial: "st_9999999",
					webSecondaryPlants: new Map(),
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.deepEqual(resolved, { plant: 0, exact: false });
		});

		// The other direction, so the guard cannot be satisfied by simply never being certain: a
		// master whose control unit is unknown has not contradicted anything, and a single-plant
		// account is this appliance by definition. This is the ordinary one-appliance household,
		// and refusing it would send every such instance to the manual approval route.
		it("still calls the only plant certain when nothing contradicts it", () => {
			for (const serial of [null, "", undefined]) {
				const resolved = openapi.openapiResolvePlant(
					adapter({
						webMasterPlantNumber: 0,
						webMasterPlantSerial: serial,
						webSecondaryPlants: new Map(),
						openapiExpectedDeviceId: "209719282544",
					}),
				);
				assert.deepEqual(resolved, { plant: 0, exact: true }, `serial ${JSON.stringify(serial)}`);
			}
		});

		// And the agreeing case, which never reaches the guard at all: the identity match returns
		// first. Here so the three together cover every route out of the master branch.
		it("calls a master that is this appliance certain", () => {
			const resolved = openapi.openapiResolvePlant(
				adapter({
					webMasterPlantNumber: 2,
					webMasterPlantSerial: "st_209719282544",
					webSecondaryPlants: new Map([["st_9999999", { anlageNummer: 3, produktName: "other" }]]),
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.deepEqual(resolved, { plant: 2, exact: true });
		});

		// The URL builder and the portal writers must never disagree about which plant this is.
		it("agrees with openapiApprovalUrl", () => {
			for (const over of [
				{
					webMasterPlantNumber: 3,
					webMasterPlantSerial: "S209719282544",
					openapiExpectedDeviceId: "209719282544",
				},
				{ webMasterPlantNumber: 0, webSecondaryPlants: new Map([["st_9", { anlageNummer: 1 }]]) },
				{},
			]) {
				const a = adapter(over);
				const resolved = openapi.openapiResolvePlant(a);
				const link = openapi.openapiApprovalUrl(a);
				assert.equal(link.exact, resolved.exact);
				assert.ok(link.url.includes(`/#/${resolved.plant}/`), `${link.url} vs plant ${resolved.plant}`);
			}
		});
	});

	describe("resolveOpenapiTimeout", () => {
		it("keeps a value inside the range the admin field allows", () => {
			assert.equal(openapi.resolveOpenapiTimeout(10000), 10000);
		});

		// A zero would disable the timeout and hang the poll cycle; an instance predating the
		// setting has no value at all.
		it("falls back for anything unusable", () => {
			for (const bad of [undefined, null, "", 0, -1, NaN, "abc"]) {
				assert.equal(openapi.resolveOpenapiTimeout(bad), 10000, `${JSON.stringify(bad)} should fall back`);
			}
		});

		it("pulls an out-of-range value back into range", () => {
			assert.equal(openapi.resolveOpenapiTimeout(1), 2000);
			assert.equal(openapi.resolveOpenapiTimeout(999999), 60000);
		});
	});

	// Configured in seconds, used as a timer in milliseconds. The conversion is the point: a value
	// returned in seconds would poll a local appliance a thousand times too often, and a value
	// above 2^31-1 ms makes setTimeout fire immediately, which is the same tight loop by another
	// route. Nothing guarantees the value came through the Admin field — a script, a restored
	// backup or a hand-edited instance can hold anything, including nothing at all.
	describe("resolveOpenapiInterval", () => {
		it("returns milliseconds for a value inside the range the admin field allows", () => {
			assert.equal(openapi.resolveOpenapiInterval(60), 60000);
			assert.equal(openapi.resolveOpenapiInterval("30"), 30000, "Admin may store the number as a string");
		});

		// A zero or a negative would arm a timer that fires at once; an instance predating the
		// setting has no value at all, and a non-numeric one is simply unusable.
		it("falls back to the default for anything unusable", () => {
			for (const bad of [undefined, null, "", 0, -1, -86400, NaN, "abc", {}, []]) {
				assert.equal(
					openapi.resolveOpenapiInterval(bad),
					60000,
					`${JSON.stringify(bad)} should fall back to the default`,
				);
			}
		});

		it("pulls an out-of-range value back into range", () => {
			assert.equal(openapi.resolveOpenapiInterval(1), 10000, "below the floor, so the appliance is not hammered");
			assert.equal(openapi.resolveOpenapiInterval(9), 10000);
			assert.equal(openapi.resolveOpenapiInterval(999999), 86400000, "a day is the longest useful interval");
			assert.equal(openapi.resolveOpenapiInterval(Infinity), 60000, "not finite, so not a configured value");
		});

		// The clamped maximum has to stay inside what setTimeout can actually wait for, or the
		// clamp would hand back the very value it exists to prevent.
		it("never returns a delay a timer cannot hold", () => {
			for (const value of [1, 60, 86400, 999999, 2 ** 40]) {
				const ms = openapi.resolveOpenapiInterval(value);
				assert.ok(ms > 0 && ms <= 2 ** 31 - 1, `${value} resolved to ${ms} ms`);
			}
		});
	});

	// Reading the token can fail for reasons that have nothing to do with whether one exists, and
	// the two must stay distinguishable: a failed read answering "no token" reads as an
	// unregistered instance, and an unregistered instance registers — minting a second portal
	// entry while the first is still live, which nothing can undo or even tell apart afterwards.
	describe("openapiReadTokenResult", () => {
		const adapter = (over = {}) => ({
			getStateAsync: async () => ({ val: "cipher" }),
			decrypt: (value) => `plain:${value}`,
			log: { warn: () => {} },
			...over,
		});

		it("reports the stored token", async () => {
			const result = await openapi.openapiReadTokenResult(adapter());
			assert.deepEqual(result, { ok: true, token: "plain:cipher" });
		});

		// "There is no token" is a legitimate answer, and the caller may act on it by registering.
		it("reports the absence of a token as a successful read", async () => {
			for (const stored of [null, undefined, { val: null }, { val: "" }]) {
				const result = await openapi.openapiReadTokenResult(adapter({ getStateAsync: async () => stored }));
				assert.deepEqual(
					result,
					{ ok: true, token: null },
					`${JSON.stringify(stored)} means there is no token, not that the read failed`,
				);
			}
		});

		// What openapiForgetToken leaves behind: the state exists and holds an empty string. It
		// must read as "none stored", not as a failure, or forgetting a token would block the fresh
		// registration it exists to allow.
		it("reads a forgotten token as none stored", async () => {
			const result = await openapi.openapiReadTokenResult(adapter({ getStateAsync: async () => ({ val: "" }) }));
			assert.equal(result.ok, true);
			assert.equal(result.token, null);
		});

		it("reports a failed read as a failure, not as an absent token", async () => {
			let warned = "";
			const result = await openapi.openapiReadTokenResult(
				adapter({
					getStateAsync: async () => {
						throw new Error("objects database not connected");
					},
					log: {
						warn: (message) => {
							warned = message;
						},
					},
				}),
			);
			assert.equal(result.ok, false, "a failed read must never pass for an unregistered instance");
			assert.equal(result.token, null);
			assert.match(warned, /could not be read/, "the reason belongs in the log");
		});

		// Decryption is part of reading it: a token that cannot be decrypted is not a token.
		it("treats a token it cannot decrypt as unreadable", async () => {
			const result = await openapi.openapiReadTokenResult(
				adapter({
					decrypt: () => {
						throw new Error("bad secret");
					},
				}),
			);
			assert.equal(result.ok, false);
			assert.equal(result.token, null);
		});

		// The convenience wrapper keeps the token and throws the distinction away, which is fine
		// for callers that only want the value — but the two must not disagree about the value.
		it("agrees with openapiReadToken about the token itself", async () => {
			assert.equal(await openapi.openapiReadToken(adapter()), "plain:cipher");
			assert.equal(await openapi.openapiReadToken(adapter({ getStateAsync: async () => null })), null);
		});
	});

	// Every path that can create a portal entry goes through this lock. Two of them overlapping is
	// not a slow-down but a permanent mess: entries are identified only by the device name the
	// client chose, so two entries of the same name cannot be told apart or cleaned up afterwards.
	describe("withOpenapiRegistration", () => {
		it("runs the work and hands back its value", async () => {
			const adapter = {};
			const result = await openapi.withOpenapiRegistration(adapter, async () => "token");
			assert.deepEqual(result, { ok: true, value: "token" });
			assert.ok(!adapter.openapiBusy, "the lock must not be left held");
		});

		// The second caller is refused rather than queued: a queued registration would still mint
		// the duplicate entry, only later. The first call is deliberately left in flight — the lock
		// has to be taken before the first await, since a check in one tick and a set in the next
		// is no guard at all.
		it("refuses a second caller while the first is still running", async () => {
			const adapter = {};
			let runs = 0;
			let release;
			const gate = new Promise((resolve) => {
				release = resolve;
			});

			const first = openapi.withOpenapiRegistration(adapter, async () => {
				runs++;
				await gate;
				return "done";
			});
			const second = await openapi.withOpenapiRegistration(adapter, async () => {
				runs++;
				return "duplicate";
			});

			assert.deepEqual(second, { ok: false }, "the second caller must be told it did not run");
			assert.equal(runs, 1, "the work must have run exactly once");

			release();
			assert.deepEqual(await first, { ok: true, value: "done" }, "the first caller is unaffected");
		});

		// A failed registration still has to let the next attempt in, or one error would leave the
		// Register button dead for the lifetime of the instance.
		it("releases the lock when the work throws", async () => {
			const adapter = {};
			await assert.rejects(
				() =>
					openapi.withOpenapiRegistration(adapter, async () => {
						throw new Error("appliance refused");
					}),
				/appliance refused/,
			);
			// Proved by what the lock allows next, rather than by reading the flag: the flag is an
			// implementation detail, being able to try again is the behaviour.
			assert.deepEqual(await openapi.withOpenapiRegistration(adapter, async () => "retry"), {
				ok: true,
				value: "retry",
			});
		});

		it("releases the lock when the work is refused for its own reasons", async () => {
			const adapter = {};
			await openapi.withOpenapiRegistration(adapter, async () => ({ ok: false }));
			assert.deepEqual(await openapi.withOpenapiRegistration(adapter, async () => "after"), {
				ok: true,
				value: "after",
			});
		});
	});

	// The portal answers HTTP 200 with its login form when the session is not valid, which is
	// otherwise indistinguishable from a successful call — so a page recognised as an answer would
	// be read as "no registrations exist" and the user would be told the wrong thing.
	describe("looksLikePortalLoginPage", () => {
		it("recognises the login page however the document announces itself", () => {
			for (const page of [
				'<!DOCTYPE html><html lang="de"><body><form action="/login"></form></body></html>',
				"<!doctype html>\n<html>",
				"<html><head><title>Anmelden</title></head></html>",
				'  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">',
			]) {
				assert.equal(openapi.looksLikePortalLoginPage(page), true, page.slice(0, 40));
			}
		});

		// The success case is a JSON array of registrations. Mistaking one for a login page would
		// throw away a perfectly good answer and report the session as invalid.
		it("does not mistake the registration list for a login page", () => {
			assert.equal(openapi.looksLikePortalLoginPage([{ tokenValue: "x", tokenState: "GRANTED" }]), false);
			assert.equal(openapi.looksLikePortalLoginPage('[{"tokenValue":"x","tokenState":"GRANTED"}]'), false);
			assert.equal(openapi.looksLikePortalLoginPage("[]"), false);
		});

		// It is handed `res?.data`, which can be anything the transport produced — including
		// nothing at all when the request never got an answer.
		it("survives a body that is not a string", () => {
			for (const odd of [null, undefined, 0, 404, {}, [], true]) {
				assert.equal(openapi.looksLikePortalLoginPage(odd), false, JSON.stringify(odd));
			}
		});
	});

	// The approval page is unreachable from the portal's menu, so the plant number in this link
	// is the difference between the feature working and the user being stuck. An account also
	// keeps plants the user has no interest in — a replaced appliance stays listed — so the
	// number must never be guessed silently when it can be established or was chosen.
	describe("openapiApprovalUrl", () => {
		const adapter = (over = {}) => ({
			config: {},
			webMasterPlantNumber: null,
			webMasterPlantSerial: null,
			webSecondaryPlants: new Map(),
			openapiExpectedDeviceId: null,
			log: { warn: () => {} },
			...over,
		});

		it("honours an explicitly configured plant above everything else", () => {
			const link = openapi.openapiApprovalUrl(
				adapter({
					config: { openapi_plant: "2" },
					// Deliberately contradicted by a match that would otherwise win.
					webMasterPlantNumber: 0,
					webMasterPlantSerial: "st_209719282544",
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.equal(link.url, "https://mein-senec.de/endkunde/#/2/senec-open-api");
			assert.equal(link.exact, true);
		});

		it("ignores a configured plant that is not a plant number", () => {
			for (const junk of ["abc", "-1", "1.5", "   "]) {
				const link = openapi.openapiApprovalUrl(
					adapter({ config: { openapi_plant: junk }, webMasterPlantNumber: 0 }),
				);
				assert.equal(link.url, "https://mein-senec.de/endkunde/#/0/senec-open-api", junk);
			}
		});

		// The point of matching: on a multi-plant account the master's number would send the user
		// to the wrong appliance's approval page.
		it("finds the plant whose control unit is this appliance", () => {
			const link = openapi.openapiApprovalUrl(
				adapter({
					webMasterPlantNumber: 0,
					webMasterPlantSerial: "st_111111111111",
					webSecondaryPlants: new Map([["st_209719282544", { anlageNummer: 1, produktName: "V3" }]]),
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.equal(link.url, "https://mein-senec.de/endkunde/#/1/senec-open-api");
			assert.equal(link.exact, true);
		});

		it("matches the master plant when the appliance is that one", () => {
			const link = openapi.openapiApprovalUrl(
				adapter({
					webMasterPlantNumber: 3,
					webMasterPlantSerial: "S209719282544",
					openapiExpectedDeviceId: "st_209719282544",
				}),
			);
			assert.equal(link.url, "https://mein-senec.de/endkunde/#/3/senec-open-api");
			assert.equal(link.exact, true);
		});

		it("is certain about the master when it is the only plant", () => {
			const link = openapi.openapiApprovalUrl(adapter({ webMasterPlantNumber: 0 }));
			assert.equal(link.exact, true, "a single plant cannot be the wrong one");
		});

		// This is the case worth being honest about: several plants, none matched.
		it("does not claim certainty about the master when several plants exist and none matched", () => {
			const link = openapi.openapiApprovalUrl(
				adapter({
					webMasterPlantNumber: 0,
					webSecondaryPlants: new Map([["st_999", { anlageNummer: 1, produktName: "old" }]]),
					openapiExpectedDeviceId: "209719282544",
				}),
			);
			assert.equal(link.url, "https://mein-senec.de/endkunde/#/0/senec-open-api");
			assert.equal(link.exact, false, "an unmatched multi-plant account is a guess");
		});

		it("guesses the first plant and admits it when nothing at all is known", () => {
			const link = openapi.openapiApprovalUrl(adapter());
			assert.equal(link.url, "https://mein-senec.de/endkunde/#/0/senec-open-api");
			assert.equal(link.exact, false);
		});
	});
});

describe("resolveStateAttrKey", () => {
	const resolve = t.resolveStateAttrKey;

	it("returns exact match when present", () => {
		const attrs = { "ENERGY.GUI_BAT_DATA_POWER": { name: "Battery Power" } };
		assert.equal(resolve("ENERGY.GUI_BAT_DATA_POWER", attrs), "ENERGY.GUI_BAT_DATA_POWER");
	});

	it("strips trailing numeric index", () => {
		const attrs = { batteryModules: { name: "Battery Modules" } };
		assert.equal(resolve("batteryModules.0", attrs), "batteryModules");
	});

	it("strips all embedded numeric indices (array resolution)", () => {
		const attrs = { "batteryModules.serialNumber": { name: "Serial Number" } };
		assert.equal(resolve("batteryModules.0.serialNumber", attrs), "batteryModules.serialNumber");
	});

	it("strips multiple embedded numeric indices", () => {
		const attrs = { "a.b.c": { name: "Nested" } };
		assert.equal(resolve("a.0.b.1.c", attrs), "a.b.c");
	});

	it("prefers exact match over stripped variants", () => {
		const attrs = {
			"batteryModules.0.serialNumber": { name: "Specific" },
			"batteryModules.serialNumber": { name: "Generic" },
		};
		assert.equal(resolve("batteryModules.0.serialNumber", attrs), "batteryModules.0.serialNumber");
	});

	it("returns null when no resolution matches", () => {
		const attrs = { "OTHER.KEY": { name: "Other" } };
		assert.equal(resolve("MISSING.KEY", attrs), null);
	});
});

describe("webApiErrorMsg", () => {
	it("returns message when present", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { message: "Not found" } }), "Not found");
	});

	it("falls back to errorCode when no message", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { errorCode: "ERR_001" } }), "ERR_001");
	});

	it("falls back to JSON.stringify when neither message nor errorCode", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { foo: "bar" } }), '{"foo":"bar"}');
	});

	it("prefers message over errorCode", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { message: "msg", errorCode: "code" } }), "msg");
	});

	it("handles null data", () => {
		assert.equal(webClient.webApiErrorMsg({ data: null }), "null");
	});
});

describe("aggregateToHourly", () => {
	it("converts kW to kWh using interval duration", () => {
		// 3 readings, each 5 min apart
		const val = [
			[new Date(2026, 6, 13, 10, 0).getTime(), 6.0], // 6 kW × 5/60 h = 0.5 kWh
			[new Date(2026, 6, 13, 10, 5).getTime(), 6.0], // 6 kW × 5/60 h = 0.5 kWh
			[new Date(2026, 6, 13, 10, 10).getTime(), 12.0], // 12 kW × 5/60 h = 1.0 kWh (last uses prev interval)
		];
		const result = webClient.aggregateToHourly(val);
		// All in hour 10: 0.5 + 0.5 + 1.0 = 2.0 kWh
		assert.ok(Math.abs(result[10] - 2.0) < 0.001);
		assert.equal(result[11], 0);
		assert.equal(result[0], 0);
	});

	it("returns 24 hours initialized to zero", () => {
		const result = webClient.aggregateToHourly([]);
		assert.equal(Object.keys(result).length, 24);
		for (let h = 0; h < 24; h++) {
			assert.equal(result[h], 0);
		}
	});
});

describe("aggregateToDaily", () => {
	it("sums values by day of month", () => {
		const val = [
			[new Date(2026, 6, 1).getTime(), 10],
			[new Date(2026, 6, 1).getTime(), 5],
			[new Date(2026, 6, 15).getTime(), 20],
		];
		const result = webClient.aggregateToDaily(val);
		assert.equal(result[1], 15);
		assert.equal(result[15], 20);
	});

	it("returns empty object for empty input", () => {
		const result = webClient.aggregateToDaily([]);
		assert.equal(Object.keys(result).length, 0);
	});
});

describe("aggregateToMonthly", () => {
	it("sums values by month", () => {
		const val = [
			[new Date(2026, 0, 15).getTime(), 100],
			[new Date(2026, 0, 20).getTime(), 50],
			[new Date(2026, 5, 1).getTime(), 200],
		];
		const result = webClient.aggregateToMonthly(val);
		assert.equal(result[1], 150);
		assert.equal(result[6], 200);
		assert.equal(result[12], 0);
	});

	it("returns 12 months initialized to zero", () => {
		const result = webClient.aggregateToMonthly([]);
		assert.equal(Object.keys(result).length, 12);
		for (let m = 1; m <= 12; m++) {
			assert.equal(result[m], 0);
		}
	});
});

describe("formula ref regex", () => {
	// Same regex as main.js — extracts {stateId} references from formula strings
	const regex = /\{([^{}]+)\}/g;

	function extractRefs(str) {
		const refs = [];
		let match;
		while ((match = regex.exec(str)) !== null) {
			refs.push(match[1]);
		}
		return refs;
	}

	it("extracts single state reference", () => {
		assert.deepEqual(extractRefs("{adapter.0.voltage}"), ["adapter.0.voltage"]);
	});

	it("extracts multiple state references", () => {
		assert.deepEqual(extractRefs("{a.0.x} * {a.0.y}"), ["a.0.x", "a.0.y"]);
	});

	it("extracts references with math operators", () => {
		assert.deepEqual(extractRefs("({a.0.v} * {a.0.i}) / 1000"), ["a.0.v", "a.0.i"]);
	});

	it("returns empty for plain state ID without braces", () => {
		assert.deepEqual(extractRefs("adapter.0.voltage"), []);
	});

	it("returns empty for empty string", () => {
		assert.deepEqual(extractRefs(""), []);
	});

	it("ignores empty braces", () => {
		assert.deepEqual(extractRefs("{}"), []);
	});

	it("ignores nested braces (no match)", () => {
		assert.deepEqual(extractRefs("{{nested}}"), ["nested"]);
	});

	it("handles complex formula with three refs", () => {
		assert.deepEqual(extractRefs("{wallbox.0.L1_V} * {wallbox.0.L1_A} + {wallbox.0.L2_V} * {wallbox.0.L2_A}"), [
			"wallbox.0.L1_V",
			"wallbox.0.L1_A",
			"wallbox.0.L2_V",
			"wallbox.0.L2_A",
		]);
	});

	it("handles state IDs with hyphens and underscores", () => {
		assert.deepEqual(extractRefs("{my-adapter.0.my_state}"), ["my-adapter.0.my_state"]);
	});

	it("does not hang on pathological input (ReDoS protection)", () => {
		const start = Date.now();
		// Pathological: many { without closing }
		extractRefs(`{${"|{".repeat(1000)}`);
		assert.ok(Date.now() - start < 100, "regex should complete in under 100ms");
	});
});

describe("Admin dialog messages (lib/ui-messages.js)", () => {
	const { uiMessage, FALLBACK_LANG } = require("../lib/ui-messages.js");
	const fs = require("node:fs");
	const path = require("node:path");

	const i18nDir = path.join(__dirname, "..", "admin", "i18n");
	const languages = fs
		.readdirSync(i18nDir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.replace(/\.json$/, ""));
	const english = JSON.parse(fs.readFileSync(path.join(i18nDir, `${FALLBACK_LANG}.json`), "utf8"));
	const replyKeys = Object.keys(english).filter((key) => key.startsWith("openapiReply"));

	it("finds the English text", () => {
		assert.equal(uiMessage("en", "openapiReplyApproved"), english.openapiReplyApproved);
	});

	it("translates when the language has the key", () => {
		const german = JSON.parse(fs.readFileSync(path.join(i18nDir, "de.json"), "utf8"));
		assert.equal(uiMessage("de", "openapiReplyApproved"), german.openapiReplyApproved);
	});

	it("falls back to English for an unknown language", () => {
		assert.equal(uiMessage("xx", "openapiReplyApproved"), english.openapiReplyApproved);
	});

	it("refuses a language that is not a language code", () => {
		// A traversing value must not read a file; the English text is what comes back.
		assert.equal(uiMessage("../../package", "openapiReplyApproved"), english.openapiReplyApproved);
	});

	it("returns the key when it exists nowhere", () => {
		assert.equal(uiMessage("en", "noSuchKeyAnywhere"), "noSuchKeyAnywhere");
	});

	it("substitutes placeholders", () => {
		const text = uiMessage("en", "openapiReplyRegistered", { name: "ioBroker", url: "https://example.invalid/" });
		assert.ok(text.includes("ioBroker"));
		assert.ok(text.includes("https://example.invalid/"));
		assert.ok(!text.includes("{{"), "every placeholder should be filled");
	});

	it("leaves an unknown placeholder alone rather than printing undefined", () => {
		assert.equal(uiMessage("en", "noSuchKey{{missing}}", {}), "noSuchKey{{missing}}");
	});

	it("has every reply in every language, with the same placeholders", () => {
		assert.ok(replyKeys.length > 0, "there should be reply texts to check");
		for (const lang of languages) {
			const file = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), "utf8"));
			for (const key of replyKeys) {
				assert.ok(file[key], `${lang}.json is missing ${key}`);
				const wanted = [...String(english[key]).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
				const found = [...String(file[key]).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
				assert.deepEqual(found, wanted, `${lang}.json ${key} has different placeholders`);
			}
		}
	});

	// Comparing placeholders is not enough: these replies are concatenated with each other in the
	// dialog, and a leading or trailing space is therefore load-bearing punctuation that the
	// placeholder check cannot see. openapiReplyPlantHint was authored with a deliberate leading
	// space in en and de, the nine machine-translated copies lost it, and two sentences arrived
	// fused in the dialog — past a guard that compared only {{names}}. Asserting "no whitespace at
	// either end, in any language" rules out both that defect and its mirror image, where a space
	// is added back after the joining moved into the code.
	it("has no reply that leans on whitespace at either end", () => {
		for (const lang of languages) {
			const file = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), "utf8"));
			for (const key of replyKeys) {
				const text = String(file[key] ?? "");
				assert.equal(
					text,
					text.trim(),
					`${lang}.json ${key} begins or ends with whitespace — the dialog joins these texts itself`,
				);
			}
		}
	});

	it("names only keys that exist in English from the connector", () => {
		// The register path hands main.js a key rather than a sentence, so a rename there would
		// otherwise surface as the bare key in the dialog.
		const lib = fs.readFileSync(path.join(__dirname, "..", "lib", "openapi-client.js"), "utf8");
		const keys = [...lib.matchAll(/key: "([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
		assert.ok(keys.length > 0, "the connector should name translated replies");
		for (const key of keys) {
			assert.ok(english[key], `en.json is missing ${key}, named in openapi-client.js`);
		}
	});

	it("uses only keys that exist in English", () => {
		// The replies are selected in main.js by name, so a renamed key would otherwise surface as
		// the bare key in the dialog.
		const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
		// Every reply name spelled in main.js, not only the ones passed to say() directly: some
		// are picked out of a lookup, and a typo there would reach the dialog as the bare key.
		const used = [...main.matchAll(/"(openapiReply[A-Za-z0-9_]*)"/g)].map((match) => match[1]);
		assert.ok(used.length > 0, "main.js should ask for translated replies");
		for (const key of used) {
			assert.ok(english[key], `en.json is missing ${key}, used in main.js`);
		}
	});
});
