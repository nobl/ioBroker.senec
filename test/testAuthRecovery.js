"use strict";

/**
 * Regression tests for API authentication recovery.
 *
 * When the SENEC SSO rejects a refresh token with invalid_grant, the adapter falls back to a
 * full login. The hazard is that the fallback's return value was discarded: a failed login
 * left authBlocked set, currentToken null, no retry scheduled — and apiRefreshToken resolved
 * as though it had succeeded. Nothing would ever try again.
 *
 * These tests pin the recovery contract, not the mechanism.
 */

const assert = require("node:assert/strict");

const apiClient = require("../lib/api-client");

/** A login form the login flow accepts in a single step. */
const LOGIN_FORM =
	'<form id="kc-form-login" action="https://sso.senec.com/login" method="POST">' +
	'<input name="username" type="text"><input name="password" type="password"></form>';

/**
 * Build an adapter double for the auth flow.
 *
 * @param {object} [opts] - Options
 * @param {boolean} [opts.loginSucceeds] - Whether the scripted full login completes
 * @param {string|null} [opts.refreshToken] - Stored refresh token
 * @returns {object} Fake adapter with recorders
 */
function makeAdapter(opts = {}) {
	const loginSucceeds = opts.loginSucceeds !== false;

	const adapter = {
		unloaded: false,
		baseTime: 60000,
		currentToken: null,
		refreshToken: "refreshToken" in opts ? opts.refreshToken : "stored-refresh-token",
		refreshPromise: null,
		tokenExpiresAt: 0,
		tokenFailureCount: 0,
		tokenBackoff: { baseDelayMs: 30000, maxMultiplier: 8, maxDelayMs: 3600000 },
		authBlocked: false,
		timerTokenRefresh: null,
		config: { api_mail: "user@example.com", api_pwd: "secret", api_showPolling: false },
		scheduledDelays: [],
		refreshPosts: 0,
		loginAttempts: 0,
		clearedTimers: 0,
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		logError() {},
		encrypt: (v) => v,
		decrypt: (v) => v,
		async getStateAsync() {
			return adapter.refreshToken ? { val: adapter.refreshToken } : null;
		},
		async doState() {},
		setTimeout(fn, ms) {
			adapter.scheduledDelays.push(ms);
			// Return a handle without ever running the callback — these tests assert that a
			// retry was scheduled, not that it fires.
			return { fn, ms };
		},
		clearTimeout() {
			adapter.clearedTimers++;
		},
	};

	adapter.authClient = {
		async get() {
			// First step of the login flow: fetch the login form.
			adapter.loginAttempts++;
			if (!loginSucceeds) {
				throw new Error("SSO unreachable");
			}
			return { status: 200, data: LOGIN_FORM, headers: {} };
		},
		async post(url) {
			if (String(url).includes("token")) {
				if (String(url).includes("token") && adapter._expectRefresh) {
					adapter._expectRefresh = false;
				}
				return {
					status: 200,
					data: { access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 600 },
					headers: {},
				};
			}
			return { status: 302, headers: { location: "senec-app-auth://cb?code=AUTHCODE" }, data: "" };
		},
	};

	return adapter;
}

/**
 * Make the refresh-token POST fail the way SSO rejects a dead refresh token.
 *
 * @param {object} adapter - Fake adapter
 * @returns {void}
 */
function rejectRefreshWithInvalidGrant(adapter) {
	const realPost = adapter.authClient.post;
	adapter.authClient.post = async (url, body, cfg) => {
		const isRefresh = String(body || "").includes("grant_type=refresh_token");
		if (isRefresh) {
			adapter.refreshPosts++;
			const err = new Error("Request failed with status code 400");
			// @ts-expect-error test double mimicking an axios error
			err.response = { status: 400, data: { error: "invalid_grant" } };
			throw err;
		}
		return realPost(url, body, cfg);
	};
}

describe("API auth recovery after invalid_grant", () => {
	it("a successful fallback login counts as recovery", async () => {
		const adapter = makeAdapter({ loginSucceeds: true });
		rejectRefreshWithInvalidGrant(adapter);

		await apiClient.apiRefreshToken(adapter);

		assert.equal(adapter.currentToken, "new-access-token", "a recovered session must hold a token");
		assert.equal(adapter.authBlocked, false, "recovery must clear the auth block");
		assert.equal(adapter.tokenFailureCount, 0, "a recovered session starts from a clean failure count");
	});

	it("a failed fallback login is not reported as success", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		rejectRefreshWithInvalidGrant(adapter);

		await assert.rejects(
			() => apiClient.apiRefreshToken(adapter),
			"refresh must not resolve when there is no usable token afterwards",
		);
		assert.equal(adapter.currentToken, null);
	});

	it("a failed fallback login schedules a bounded retry", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		rejectRefreshWithInvalidGrant(adapter);

		await apiClient.apiRefreshToken(adapter).catch(() => {});

		assert.ok(adapter.scheduledDelays.length > 0, "a future recovery attempt must be scheduled");
		const delay = adapter.scheduledDelays[adapter.scheduledDelays.length - 1];
		assert.ok(delay >= 10000, `retry delay ${delay}ms is too aggressive`);
		assert.ok(delay <= adapter.tokenBackoff.maxDelayMs, `retry delay ${delay}ms exceeds the cap`);
		assert.ok(adapter.timerTokenRefresh, "the retry handle must be kept so unload can clear it");
	});

	it("repeated failures back off instead of looping tightly", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		rejectRefreshWithInvalidGrant(adapter);

		// computeBackoffDelay applies full jitter — Math.random() * expDelay — so single
		// delays are deliberately not monotonic. Pin the randomness so the assertion is about
		// the growing ceiling rather than about a coin toss.
		const realRandom = Math.random;
		Math.random = () => 0.9;
		try {
			await apiClient.apiRefreshToken(adapter).catch(() => {});
			const first = adapter.scheduledDelays[adapter.scheduledDelays.length - 1];
			await apiClient.apiRefreshToken(adapter).catch(() => {});
			const second = adapter.scheduledDelays[adapter.scheduledDelays.length - 1];

			assert.ok(adapter.tokenFailureCount >= 2, "each failure must count");
			assert.ok(second > first, `backoff must grow (${first}ms then ${second}ms)`);
		} finally {
			Math.random = realRandom;
		}
	});

	it("every scheduled retry stays within the configured bounds", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		rejectRefreshWithInvalidGrant(adapter);

		for (let i = 0; i < 12; i++) {
			await apiClient.apiRefreshToken(adapter).catch(() => {});
		}

		assert.equal(adapter.scheduledDelays.length, 12, "every failure must leave an attempt behind");
		for (const delay of adapter.scheduledDelays) {
			assert.ok(delay >= 10000, `retry delay ${delay}ms is below the 10s floor`);
			assert.ok(delay <= adapter.tokenBackoff.maxDelayMs, `retry delay ${delay}ms exceeds the cap`);
		}
	});

	it("missing credentials do not produce a login loop", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		adapter.config.api_pwd = "";
		rejectRefreshWithInvalidGrant(adapter);

		await apiClient.apiRefreshToken(adapter).catch(() => {});

		assert.ok(adapter.loginAttempts <= 1, `login was attempted ${adapter.loginAttempts} times in one refresh`);
	});

	it("concurrent refresh calls share a single flight", async () => {
		const adapter = makeAdapter({ loginSucceeds: true });
		rejectRefreshWithInvalidGrant(adapter);

		await Promise.all([
			apiClient.apiRefreshToken(adapter),
			apiClient.apiRefreshToken(adapter),
			apiClient.apiRefreshToken(adapter),
		]);

		assert.equal(adapter.refreshPosts, 1, "three concurrent callers must cause one refresh, not three");
		assert.equal(adapter.loginAttempts, 1, "and one fallback login, not three");
	});

	it("with no stored refresh token, concurrent callers still cause one login", async () => {
		const adapter = makeAdapter({ loginSucceeds: true, refreshToken: null });

		await Promise.all([apiClient.apiRefreshToken(adapter), apiClient.apiRefreshToken(adapter)]);

		assert.equal(adapter.loginAttempts, 1, "the no-token path must be single-flighted too");
		assert.equal(adapter.currentToken, "new-access-token");
	});

	describe("startup recovery through apiStartTokenManager", () => {
		// apiStartTokenManager is what main.js calls at startup and on every connector retry.
		// apiRefreshToken already owns invalid_grant recovery: it attempts one fallback login
		// and, when that fails, schedules a backed-off retry. The token manager must not run
		// a second login of its own on top of that, and must not report a failure that sets
		// main.js retrying the connector in parallel with the token retry already pending.

		it("a stored refresh token the SSO rejects causes exactly one full login", async () => {
			const adapter = makeAdapter({ loginSucceeds: false });
			rejectRefreshWithInvalidGrant(adapter);

			await apiClient.apiStartTokenManager(adapter);

			assert.equal(adapter.refreshPosts, 1, "one refresh attempt");
			assert.equal(adapter.loginAttempts, 1, `full login ran ${adapter.loginAttempts} times, expected 1`);
		});

		it("leaves exactly one recovery mechanism armed", async () => {
			// Ownership: at startup the connector retry is the recovery mechanism, because it
			// re-runs the whole init and restarts polling, which a bare token refresh does
			// not. So the token manager reports failure and stands the token-level retry down
			// rather than letting both loops run and double every request.
			const adapter = makeAdapter({ loginSucceeds: false });
			rejectRefreshWithInvalidGrant(adapter);

			const connected = await apiClient.apiStartTokenManager(adapter);

			assert.equal(connected, false, "no token means the connector is not connected");
			assert.equal(adapter.timerTokenRefresh, null, "the token-level retry must be stood down at startup");
			assert.ok(adapter.clearedTimers > 0, "and its timer actually cancelled");
		});

		it("still reports failure when nothing is retrying", async () => {
			// No stored token and a login that fails: there is no refresh path to own
			// recovery, so the caller has to be told, and the connector retry is the
			// mechanism that applies.
			const adapter = makeAdapter({ loginSucceeds: false, refreshToken: null });

			const connected = await apiClient.apiStartTokenManager(adapter);

			assert.equal(connected, false);
			assert.equal(adapter.loginAttempts, 1, "one login attempt, not two");
		});

		it("reports success when the fallback login works", async () => {
			const adapter = makeAdapter({ loginSucceeds: true });
			rejectRefreshWithInvalidGrant(adapter);

			const connected = await apiClient.apiStartTokenManager(adapter);

			assert.equal(connected, true);
			assert.equal(adapter.currentToken, "new-access-token");
			assert.equal(adapter.loginAttempts, 1);
			assert.equal(adapter.tokenFailureCount, 0, "a recovered session carries no failure count");
		});

		it("reports success when the plain refresh works", async () => {
			const adapter = makeAdapter({ loginSucceeds: true });

			const connected = await apiClient.apiStartTokenManager(adapter);

			assert.equal(connected, true);
			assert.equal(adapter.loginAttempts, 0, "a working refresh needs no login at all");
		});

		it("a transient refresh error retries without a full login", async () => {
			// A 503 is not invalid_grant: the stored token may still be good, so re-logging in
			// would throw away a working credential over a momentary server problem.
			const adapter = makeAdapter({ loginSucceeds: true });
			const realPost = adapter.authClient.post;
			adapter.authClient.post = async (url, body, cfg) => {
				if (String(body || "").includes("grant_type=refresh_token")) {
					adapter.refreshPosts++;
					const err = new Error("Request failed with status code 503");
					// @ts-expect-error test double mimicking an axios error
					err.response = { status: 503, data: {} };
					throw err;
				}
				return realPost(url, body, cfg);
			};

			await apiClient.apiStartTokenManager(adapter);

			assert.equal(adapter.loginAttempts, 0, "a transient refresh failure must not force a full login");
			assert.equal(adapter.timerTokenRefresh, null, "startup hands recovery to the connector retry");
		});
	});

	it("an unloaded adapter neither logs in nor schedules anything", async () => {
		const adapter = makeAdapter({ loginSucceeds: false });
		rejectRefreshWithInvalidGrant(adapter);
		adapter.unloaded = true;

		await apiClient.apiRefreshToken(adapter).catch(() => {});

		assert.equal(adapter.loginAttempts, 0);
		assert.deepEqual(adapter.scheduledDelays, [], "a shutting-down adapter must not leave timers behind");
	});
});
