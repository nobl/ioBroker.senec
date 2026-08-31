"use strict";

const crypto = require("node:crypto");
const { URL } = require("node:url");

/** @typedef {import('./types').AuthFailure} AuthFailure */ // eslint-disable-line jsdoc/check-tag-names

/**
 * Encode a buffer as base64url.
 *
 * @param {Buffer} buffer - input buffer
 * @returns {string} base64url string
 */
function base64UrlEncode(buffer) {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate a PKCE code verifier (random base64url string).
 *
 * @returns {string} code verifier
 */
function generateCodeVerifier() {
	return base64UrlEncode(
		globalThis.crypto?.getRandomValues
			? Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)))
			: crypto.randomBytes(32),
	);
}

/**
 * Generate a PKCE code challenge from a verifier.
 *
 * @param {string} verifier - code verifier
 * @returns {string} code challenge
 */
function generateCodeChallenge(verifier) {
	return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

/**
 * Locate the form the login is submitted to: the first one carrying an `action`.
 *
 * Keycloak pages can put another form ahead of the login form — a locale switcher is the usual
 * one — and those carry no action. Skipping them is what picks the right target, and it is why
 * the action and the fields have to be read from the *same* match: taken separately, the action
 * would come from the login form while the fields came from the switcher, and the login would be
 * posted with the wrong body.
 *
 * @param {string} html - HTML content
 * @returns {{action: string, inner: string}|null} the form's action and its content, or null
 */
function matchLoginForm(html) {
	if (typeof html !== "string" || !html) {
		return null;
	}

	// `<form\b` plus indexOf rather than `<form[^>]*>`: on a body where a `<form` is never closed
	// by a `>`, the character class rescans to the end of the document for every start, which is
	// quadratic. `gt` only ever moves forward, so the whole sweep stays linear no matter what an
	// upstream proxy or a truncated response puts in front of us.
	let gt = -1;
	for (const open of html.matchAll(/<form\b/gi)) {
		if (gt < open.index) {
			gt = html.indexOf(">", open.index);
		}
		if (gt === -1) {
			break;
		}
		const tag = html.slice(open.index, gt + 1);
		const action = readTagAttribute(tag, "action");
		if (!action) {
			continue;
		}
		const start = gt + 1;
		const closing = /<\/form\s*>/gi;
		closing.lastIndex = start;
		const end = closing.exec(html);
		// A form the document never closes gives no trustworthy content: taking the rest of the
		// document would sweep in the fields of every later form, which is the cross-form mix-up
		// this function exists to prevent. The same applies when another `<form` starts before this
		// one is closed — malformed markup a browser would auto-close, where the `</form>` that
		// does appear belongs to the inner form and not to ours.
		const nested = /<form\b/gi;
		nested.lastIndex = start;
		const next = nested.exec(html);
		const stop = Math.min(end ? end.index : Infinity, next ? next.index : Infinity);
		return { action, inner: Number.isFinite(stop) ? html.slice(start, stop) : "" };
	}

	return null;
}

/**
 * Extract form action URL from HTML.
 *
 * @param {string} html - HTML content
 * @returns {string|null} action URL or null
 */
function extractFormAction(html) {
	return matchLoginForm(html)?.action ?? null;
}

/**
 * The entities Keycloak actually emits into form values.
 *
 * Null-prototype: a plain object literal answers `NAMED_ENTITIES["constructor"]` from the
 * prototype chain, so `&constructor;` decoded to `"function Object() { [native code] }"` and was
 * posted to the SSO in place of the value the server wrote.
 */
const NAMED_ENTITIES = Object.assign(Object.create(null), {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
});

/**
 * Decode the HTML entities that can appear inside an attribute value.
 *
 * A hidden field is only useful if it goes back to the server as the server wrote it, and the
 * markup escapes at least `&` — echoing `&amp;` verbatim would corrupt the value.
 *
 * @param {string} text - attribute value as it appears in the markup
 * @returns {string} decoded value
 */
function decodeHtmlEntities(text) {
	if (typeof text !== "string" || !text) {
		return "";
	}
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
		if (entity[0] === "#") {
			const code =
				entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		return named === undefined ? match : named;
	});
}

/**
 * Read a single attribute out of one HTML tag.
 *
 * The name is anchored with `(?<![-\w])` rather than `\b`, because a word boundary also sits
 * between the `-` and the `v` of `data-value`: with `\b` the tag `<input data-value="junk"
 * name="k" value="real">` reads back as `junk`, and the adapter posts a field the server never
 * wrote. Keycloak themes do carry `data-*` attributes, so this is a live shape, not a hypothetical
 * one.
 *
 * @param {string} tag - the complete tag, e.g. `<input type="hidden" name="x" value="y">`
 * @param {string} name - attribute name; a literal, escaped here so a caller cannot inject a pattern
 * @returns {string|null} the decoded value, or null when the attribute is absent
 */
function readTagAttribute(tag, name) {
	const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = tag.match(new RegExp(`(?<![-\\w])${literal}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
	if (!match) {
		return null;
	}
	return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * Check whether a tag declares a given attribute value exactly.
 *
 * `/\btype\s*=\s*["']?hidden["']?/` accepts `type="hiddenfoo"` — the closing quote is optional, so
 * the pattern matches a prefix — and `data-type="hidden"` as well. Reading the attribute and
 * comparing it is both narrower and easier to be sure about.
 *
 * @param {string} tag - the complete tag
 * @param {string} name - attribute name
 * @param {string} expected - the value the attribute must have, compared case-insensitively
 * @returns {boolean} true when the attribute is present and matches
 */
function tagAttributeIs(tag, name, expected) {
	const value = readTagAttribute(tag, name);
	return value !== null && value.trim().toLowerCase() === expected;
}

/**
 * Upper bound on the hidden fields echoed back to the SSO.
 *
 * Every field the server writes is posted back verbatim, so without a bound a hostile or
 * misbehaving endpoint can have the adapter upload arbitrary volume on every retry. A real
 * Keycloak form carries a handful of small fields; these limits are far above that and far below
 * anything that matters on a Raspberry Pi.
 */
const MAX_HIDDEN_FIELDS = 64;
const MAX_HIDDEN_VALUE_LENGTH = 8192;

/**
 * Collect the hidden fields of a login form.
 *
 * A browser posts every field the form carries, not just the ones the user typed. Keycloak uses
 * hidden fields to carry state through a flow — which credential was selected, which identity
 * provider a username resolved to — so a post that drops them is not the post the server is
 * waiting for.
 *
 * Takes the *content* of one form, as returned by {@link matchLoginForm}, rather than a whole
 * document: the fields posted must come from the same form as the action they are posted to.
 *
 * @param {string} formInner - the content of the login form
 * @returns {Array<[string, string]>} name/value pairs, in document order
 */
function extractHiddenInputs(formInner) {
	/** @type {Array<[string, string]>} */ // eslint-disable-line jsdoc/check-tag-names
	const fields = [];
	if (typeof formInner !== "string" || !formInner) {
		return fields;
	}

	for (const match of formInner.matchAll(/<input\b[^>]*>/gi)) {
		const tag = match[0];
		if (!tagAttributeIs(tag, "type", "hidden")) {
			continue;
		}
		const name = readTagAttribute(tag, "name");
		if (!name) {
			continue;
		}
		const value = readTagAttribute(tag, "value") ?? "";
		if (value.length > MAX_HIDDEN_VALUE_LENGTH) {
			continue;
		}
		fields.push([name, value]);
		if (fields.length >= MAX_HIDDEN_FIELDS) {
			break;
		}
	}

	return fields;
}

/**
 * Build the body for a login form post: everything the form carries, then our own values on top.
 *
 * A browser submits the hidden fields the server put in the form, and Keycloak uses those to carry
 * the state of a multi-step flow. Posting only the typed fields drops that state, so the hidden
 * ones go in first — with `append`, because a form may legitimately carry the same name twice and
 * a browser sends both — and the adapter's own values are then `set` on top, which replaces every
 * copy of that name.
 *
 * @param {string} formInner - the content of the login form, from {@link matchLoginForm}
 * @param {Record<string, string|undefined>} values - the fields the adapter supplies
 * @returns {URLSearchParams} the form body
 */
function buildLoginForm(formInner, values) {
	const body = new URLSearchParams();
	for (const [name, value] of extractHiddenInputs(formInner)) {
		body.append(name, value);
	}
	for (const [name, value] of Object.entries(values)) {
		if (value !== undefined && value !== null) {
			body.set(name, String(value));
		} else {
			// An absent value means "the adapter does not supply this field", so a hidden field of
			// the same name must not stand in for it — a stale `password` on the username page
			// would otherwise be posted as though the adapter had chosen it.
			body.delete(name);
		}
	}
	return body;
}

/**
 * Find the first `<input>` of a page or form that satisfies a predicate.
 *
 * The field checks used to be single regexes with an optional closing quote, which made them match
 * on a *prefix*: `name="userHandle"` — a WebAuthn field of the passkey form — satisfied the test
 * for a `user` field. Reading the attributes and comparing them is both narrower and legible.
 *
 * @param {string} html - HTML content
 * @param {(tag: string) => boolean} predicate - decides whether a tag is the field being looked for
 * @returns {string|null} the matching tag, or null
 */
function findInput(html, predicate) {
	if (typeof html !== "string" || !html) {
		return null;
	}
	for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
		if (predicate(match[0])) {
			return match[0];
		}
	}
	return null;
}

/**
 * The field name a login form gives the account identifier.
 *
 * @param {string} tag - the complete input tag
 * @returns {string} the lower-cased `name`, or the `id` when the tag carries no name
 */
function inputName(tag) {
	return (readTagAttribute(tag, "name") ?? readTagAttribute(tag, "id") ?? "").toLowerCase();
}

/** What a login form may call the account identifier. */
const USERNAME_FIELDS = new Set(["username", "user", "email"]);

/**
 * Check if HTML contains a username input field.
 *
 * This deliberately does *not* reject a field that carries a `value`. The previous check did, and
 * SENEC's Keycloak renders the field as `<input ... name="username" value="" …>` — so the real
 * login form did not count as carrying a username at all, and the flow only got past this check
 * because `name="userHandle"` elsewhere on the page matched by prefix. A hidden field of the same
 * name is carried flow state rather than the field to fill in, so that one is excluded.
 *
 * @param {string} html - HTML content
 * @returns {string|null} the matching input tag, or null
 */
function hasUsername(html) {
	return findInput(
		html,
		(tag) =>
			(readTagAttribute(tag, "type") ?? "text").toLowerCase() !== "hidden" && USERNAME_FIELDS.has(inputName(tag)),
	);
}

/**
 * Check if HTML contains a password input field.
 *
 * @param {string} html - HTML content
 * @returns {string|null} the matching input tag, or null
 */
function hasPassword(html) {
	return findInput(
		html,
		(tag) => (readTagAttribute(tag, "type") ?? "").toLowerCase() === "password" && inputName(tag) === "password",
	);
}

/**
 * Check if HTML contains both username and password fields.
 *
 * @param {string} html - HTML content
 * @returns {boolean} true when the form asks for both at once
 */
function hasUsernameAndPassword(html) {
	return Boolean(hasUsername(html) && hasPassword(html));
}

/**
 * Check if HTML contains an OTP input field.
 *
 * @param {string} html - HTML content
 * @returns {boolean} true if OTP field present
 */
function hasOtp(html) {
	return findInput(html, (tag) => inputName(tag) === "otp") !== null;
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * Uses Node built-in crypto — no external dependency needed.
 *
 * @param {string} base32Secret - The base32-encoded TOTP secret
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(base32Secret) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const clean = base32Secret.replace(/[\s=-]+/g, "").toUpperCase();

	// base32 decode
	let bits = "";
	for (const ch of clean) {
		const idx = alphabet.indexOf(ch);
		if (idx === -1) {
			throw new Error(`Invalid base32 character: ${ch}`);
		}
		bits += idx.toString(2).padStart(5, "0");
	}
	const bytes = bits.match(/.{8}/g);
	if (!bytes) {
		throw new Error("TOTP secret too short");
	}
	const key = Buffer.from(bytes.map((b) => parseInt(b, 2)));

	// TOTP counter (30-second window)
	const counter = Math.floor(Date.now() / 30000);
	const counterBuf = Buffer.alloc(8);
	counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
	counterBuf.writeUInt32BE(counter >>> 0, 4);

	// HMAC-SHA1
	const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();

	// Dynamic truncation
	const offset = hmac[hmac.length - 1] & 0x0f;
	const code =
		(((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]) %
		1000000;

	return code.toString().padStart(6, "0");
}

/**
 * Query parameters that must never reach the log. `code`, `session_code` and `code_verifier`
 * are single-use secrets of the running login; `state`/`nonce` are not secret but are noise.
 */
const REDACTED_QUERY_PARAMS = new Set(["code", "session_code", "code_verifier", "state", "nonce"]);

/**
 * Strip the secrets out of an SSO URL so it can be logged.
 *
 * The path and the remaining parameters (`execution`, `client_id`, `tab_id`, …) are what makes
 * a login log readable — they name the Keycloak step the request belongs to — so only the
 * values that carry credentials or single-use codes are masked.
 *
 * @param {string} url - URL to redact
 * @returns {string} URL safe to log
 */
function redactAuthUrl(url) {
	if (typeof url !== "string" || !url) {
		return String(url ?? "n/a");
	}
	try {
		const parsed = new URL(url);
		for (const key of parsed.searchParams.keys()) {
			if (REDACTED_QUERY_PARAMS.has(key)) {
				parsed.searchParams.set(key, "***");
			}
		}
		return parsed.toString();
	} catch {
		// Relative form actions and custom schemes are not parseable — drop the query wholesale
		// rather than risk logging a code.
		return url.split("?")[0];
	}
}

/** Cap for a logged login page. Enough for the form and the error text, short of a log flood. */
const AUTH_HTML_LOG_LIMIT = 6000;

/**
 * Slack kept past the log cap while redacting, so a secret lying across the cut is masked whole
 * rather than surviving as the fragment neither the literal match nor the pattern below can see.
 * Comfortably longer than any address or password.
 */
const AUTH_HTML_REDACT_MARGIN = 512;

/** Hard bound on the body examined at all, so an oversized response cannot dominate a poll. */
const AUTH_HTML_INPUT_LIMIT = 256 * 1024;

/** An address in the three encodings a Keycloak page can carry one in: raw, URL, entity. */
const EMAIL_PATTERN = /[\w.+-]{1,64}(?:@|%40|&#0*64;|&commat;)[\w-]{1,63}(?:\.[\w-]{1,63}){1,4}/gi;

/**
 * Remove a `<tag>…</tag>` block without rescanning on an unterminated one.
 *
 * `/<script\b[\s\S]*?<\/script>/g` expands to the end of the input for every start that has no
 * terminator, which is quadratic: a body of unterminated `<script` starts measured 9.5 s at 273 KB
 * and grows fourfold per doubling, and this runs before anything checks the log level. Both cursors
 * here only move forward, so the sweep is linear whatever shape the response has.
 *
 * @param {string} html - HTML body
 * @param {string} tag - tag name, e.g. `script`
 * @returns {string} the body with every closed block of that tag removed
 */
function stripTagBlocks(html, tag) {
	const open = new RegExp(`<${tag}\\b`, "gi");
	const close = new RegExp(`</${tag}\\s*>`, "gi");
	let out = "";
	let cursor = 0;
	let match;
	while ((match = open.exec(html)) !== null) {
		close.lastIndex = open.lastIndex;
		const end = close.exec(html);
		if (!end) {
			// Nothing closes this one, so nothing after it can be attributed to a block either.
			break;
		}
		out += html.slice(cursor, match.index);
		cursor = end.index + end[0].length;
		open.lastIndex = cursor;
	}
	return out + html.slice(cursor);
}

/**
 * Mask the values a login page must never put in a log.
 *
 * Shared by the two functions that turn a Keycloak page into log text, so the page cannot be
 * masked on one route and logged verbatim on the other.
 *
 * @param {string} text - already-shortened page text
 * @param {{mail?: string, password?: string}} [secrets] - the configured account values
 * @returns {string} text with codes, addresses and any echoed password masked
 */
function maskAuthSecrets(text, secrets = {}) {
	let out = text;

	// Single-use login state, both as a query parameter and as the hidden input Keycloak uses to
	// carry the same value through a flow. Only the query form was masked before, so a page
	// carrying `<input name="session_code" value="…">` published the code verbatim.
	out = out.replace(
		new RegExp(`\\b(${[...REDACTED_QUERY_PARAMS].join("|")})=([^"'&\\s<>]+)`, "gi"),
		(_match, key) => `${key}=***`,
	);
	out = out.replace(/<input\b[^>]{0,2048}>/gi, (tag) => {
		const name = readTagAttribute(tag, "name");
		if (!name || !REDACTED_QUERY_PARAMS.has(name.toLowerCase())) {
			return tag;
		}
		return tag.replace(/(?<![-\w])value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i, 'value="***"');
	});

	// The address, however it is written: configured spelling, then anything address-shaped.
	if (secrets.mail && secrets.mail.length >= 3) {
		const local = secrets.mail.split("@")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`${local}(?:@|%40|&#0*64;|&commat;)[\\w.+%-]{1,255}`, "gi"), "***@***");
	}
	out = out.replace(EMAIL_PATTERN, "***@***");

	// The password is masked only inside a `value="…"` attribute — the one place a server could
	// echo a credential back. A blind substring replace turns a password that happens to be a
	// markup word into a disclosure: `hidden` rewrote every `type="hidden"` to `type="***"`, which
	// both destroys the page and tells any reader what the password is.
	if (secrets.password && secrets.password.length >= 3) {
		const literal = secrets.password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`((?<![-\\w])value\\s*=\\s*")[^"]*${literal}[^"]*(")`, "g"), "$1***$2");
	}

	return out;
}

/**
 * Reduce a login page to something that can be put in a log and asked for in a bug report.
 *
 * `extractHtmlErrorText` deliberately keeps only the feedback element, which is the right amount
 * for a normal error line but drops what a failing login has to be diagnosed from: the fields the
 * form carries and the identity provider a page names. Script and style blocks make up most of a
 * Keycloak page and none of that, so they go.
 *
 * @param {string} html - HTML body
 * @param {{mail?: string, password?: string}} [secrets] - the configured account values
 * @returns {string} redacted, whitespace-collapsed and truncated markup
 */
function redactAuthHtml(html, secrets = {}) {
	if (typeof html !== "string" || !html) {
		return "";
	}

	const bounded = html.length > AUTH_HTML_INPUT_LIMIT ? html.slice(0, AUTH_HTML_INPUT_LIMIT) : html;
	let stripped = stripTagBlocks(bounded, "script");
	stripped = stripTagBlocks(stripped, "style");
	stripped = stripped.replace(/<!--[\s\S]{0,8192}?-->/g, "");
	stripped = stripped.replace(/\s+/g, " ").trim();

	// Redact first and cut afterwards. Cutting first left whatever straddled the boundary as a
	// fragment — `user@exa`, or the first characters of the password — which matches neither the
	// configured spelling nor an address-shaped pattern, so it reached the log intact. The margin
	// keeps the masking work bounded while still covering anything that spans the cut.
	const truncated = stripped.length > AUTH_HTML_LOG_LIMIT;
	const window = truncated ? stripped.slice(0, AUTH_HTML_LOG_LIMIT + AUTH_HTML_REDACT_MARGIN) : stripped;
	const masked = maskAuthSecrets(window, secrets);

	return masked.length > AUTH_HTML_LOG_LIMIT ? `${masked.slice(0, AUTH_HTML_LOG_LIMIT)} …(truncated)` : masked;
}

/**
 * Pull the human-readable part out of a Keycloak error page.
 *
 * Keycloak answers a rejected form post with a full HTML page, so the raw body is useless in a
 * log. The page title and the feedback/error element are the two places that carry the reason.
 *
 * Keycloak's own message bundle renders the account address into several feedback strings, and
 * this text is surfaced at `error` level — visible at the default log level, a wider audience than
 * the debug page dump. It goes through the same masking, so the two routes cannot disagree about
 * what a login page is allowed to say.
 *
 * @param {string} html - HTML body
 * @param {{mail?: string, password?: string}} [secrets] - the configured account values
 * @returns {string} short description, or "" when nothing usable was found
 */
function extractHtmlErrorText(html, secrets = {}) {
	const parts = [];

	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (title && title[1]) {
		parts.push(title[1].replace(/\s+/g, " ").trim());
	}

	const feedback = html.match(
		/<(?:span|div|p)[^>]*(?:class|id)="[^"]*(?:kc-feedback-text|kc-error-message|instruction)[^"]*"[^>]*>([\s\S]*?)<\//i,
	);
	if (feedback && feedback[1]) {
		const text = feedback[1]
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) {
			parts.push(text);
		}
	}

	return maskAuthSecrets(parts.join(" | "), secrets).slice(0, 300);
}

/**
 * Describe a failed SSO request in a single line that is worth putting in a log.
 *
 * Axios reduces every 4xx to "Request failed with status code 400", which is exactly as much
 * as an adapter user can do nothing with. Keycloak always says why — as `error` /
 * `error_description` on the token endpoint and as an HTML page on the form endpoints — so the
 * response body is where the diagnosis lives. Credentials are never part of a response body,
 * and the parts that are extracted here are the ones Keycloak means to be read.
 *
 * @param {AuthFailure} error - error thrown by axios
 * @param {{mail?: string, password?: string}} [secrets] - the configured account values
 * @returns {string} description including status and the reason given by the SSO
 */
function describeAuthFailure(error, secrets = {}) {
	const message = error?.message ?? String(error);
	const response = error?.response;
	if (!response) {
		return message;
	}

	const status = response.status;
	const data = response.data;
	let detail = "";

	if (data && typeof data === "object") {
		const code = data.error;
		const description = data.error_description || data.errorDescription;
		detail = maskAuthSecrets([code, description].filter(Boolean).join(": "), secrets);
	} else if (typeof data === "string" && data) {
		detail = data.includes("<")
			? extractHtmlErrorText(data, secrets)
			: maskAuthSecrets(data.replace(/\s+/g, " ").trim(), secrets).slice(0, 300);
	}

	return detail ? `HTTP ${status} — ${detail}` : `HTTP ${status} (${message})`;
}

/**
 * Reduce a redacted login page to a key that identifies the *failure*, not the attempt.
 *
 * The collapse of repeated identical failures compared whole redacted pages, which never matched
 * in practice: `tab_id` identifies one Keycloak authentication session, `redactAuthUrl` keeps it
 * on purpose so a log stays readable, and every attempt starts a fresh session — so the page
 * differed every time and the full dump was written on every retry. Dropping the query strings of
 * the URLs in the markup removes the per-attempt values without touching what a reader needs.
 *
 * @param {string} page - output of {@link redactAuthHtml}
 * @returns {string} a value stable across attempts that fail the same way
 */
function authPageFingerprint(page) {
	if (typeof page !== "string" || !page) {
		return "";
	}
	return page.replace(/(=\s*["'])([^"']{0,2048}?)\?[^"']{0,2048}(["'])/g, "$1$2$3");
}

/**
 * Compute a backoff delay with exponential backoff and full jitter.
 *
 * @param {number} baseInterval - Base interval in milliseconds.
 * @param {number} attempt - Attempt count (0-based).
 * @param {number} [maxMultiplier] - Maximum multiplier used to cap the exponent.
 * @returns {number} backoff delay in milliseconds
 */
function computeBackoffDelay(baseInterval, attempt, maxMultiplier = 8) {
	const cappedAttempt = Math.min(attempt, Math.log2(maxMultiplier));
	const expDelay = baseInterval * Math.pow(2, cappedAttempt);

	// Full jitter
	return Math.floor(Math.random() * expDelay);
}

module.exports = {
	generateCodeVerifier,
	generateCodeChallenge,
	base64UrlEncode,
	extractFormAction,
	matchLoginForm,
	extractHiddenInputs,
	buildLoginForm,
	decodeHtmlEntities,
	readTagAttribute,
	hasUsername,
	hasPassword,
	hasUsernameAndPassword,
	hasOtp,
	generateTOTP,
	computeBackoffDelay,
	redactAuthUrl,
	redactAuthHtml,
	maskAuthSecrets,
	authPageFingerprint,
	AUTH_HTML_LOG_LIMIT,
	extractHtmlErrorText,
	describeAuthFailure,
};
