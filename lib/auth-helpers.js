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
 * Extract form action URL from HTML.
 *
 * @param {string} html - HTML content
 * @returns {string|null} action URL or null
 */
function extractFormAction(html) {
	const match = html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
	return match && match[1] ? match[1].replace(/&amp;/g, "&") : null;
}

/**
 * Check if HTML contains a username input field.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasUsername(html) {
	return html.match(/<input\b(?![^>]*\bvalue\s*=)[^>]*\b(?:name|id)\s*=\s*["']?(?:username|user|email)["']?[^>]*>/i);
}

/**
 * Check if HTML contains a password input field.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasPassword(html) {
	return html.match(
		/<input\b(?=[^>]*\btype\s*=\s*["']?password["']?)(?=[^>]*\b(?:name|id)\s*=\s*["']?password["']?)[^>]*>/i,
	);
}

/**
 * Check if HTML contains both username and password fields.
 *
 * @param {string} html - HTML content
 * @returns {RegExpMatchArray|null} match result
 */
function hasUsernameAndPassword(html) {
	return hasUsername(html) && hasPassword(html);
}

/**
 * Check if HTML contains an OTP input field.
 *
 * @param {string} html - HTML content
 * @returns {boolean} true if OTP field present
 */
function hasOtp(html) {
	return /<input\b[^>]*\b(?:name|id)\s*=\s*["']?otp["']?[^>]*>/i.test(html);
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

/**
 * Pull the human-readable part out of a Keycloak error page.
 *
 * Keycloak answers a rejected form post with a full HTML page, so the raw body is useless in a
 * log. The page title and the feedback/error element are the two places that carry the reason.
 *
 * @param {string} html - HTML body
 * @returns {string} short description, or "" when nothing usable was found
 */
function extractHtmlErrorText(html) {
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

	return parts.join(" | ").slice(0, 300);
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
 * @returns {string} description including status and the reason given by the SSO
 */
function describeAuthFailure(error) {
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
		detail = [code, description].filter(Boolean).join(": ");
	} else if (typeof data === "string" && data) {
		detail = data.includes("<") ? extractHtmlErrorText(data) : data.replace(/\s+/g, " ").trim().slice(0, 300);
	}

	return detail ? `HTTP ${status} — ${detail}` : `HTTP ${status} (${message})`;
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
	hasUsername,
	hasPassword,
	hasUsernameAndPassword,
	hasOtp,
	generateTOTP,
	computeBackoffDelay,
	redactAuthUrl,
	extractHtmlErrorText,
	describeAuthFailure,
};
