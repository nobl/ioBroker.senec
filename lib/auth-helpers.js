"use strict";

const crypto = require("node:crypto");

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
};
