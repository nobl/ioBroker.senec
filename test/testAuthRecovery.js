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

/** A two-step login: the username form carries hidden state the SSO expects back. */
const USERNAME_FORM =
	'<form id="kc-locale-form"><input type="hidden" name="locale" value="de"></form>' +
	'<form id="kc-form-login" action="https://sso.senec.com/login-actions/authenticate?session_code=SC1">' +
	'<input type="hidden" name="execution" value="idp-discovery">' +
	'<input name="username" type="text"></form>';

const PASSWORD_FORM =
	'<form id="kc-form-login" action="https://sso.senec.com/login-actions/authenticate?session_code=SC2">' +
	'<input type="hidden" name="credentialId" value="pw-1">' +
	'<input name="username" type="text" value="user@example.com" readonly>' +
	'<input name="password" type="password"></form>';

/** The third step of a 2FA account: Keycloak names the authenticator the code belongs to. */
const OTP_FORM =
	'<form id="kc-otp-login-form" action="https://sso.senec.com/login-actions/authenticate?session_code=SC3">' +
	'<input type="hidden" name="credentialId" value="totp-1">' +
	'<input name="otp" type="text" autocomplete="one-time-code"></form>';

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

	/** The SSO's current answer to a form post. Swapped through `setPostHandler`, never rebound. */
	let postHandler;

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
		lastLoggedAuthPage: null,
		config: { api_mail: "user@example.com", api_pwd: "secret", api_showPolling: false },
		scheduledDelays: [],
		refreshPosts: 0,
		loginAttempts: 0,
		// Bodies of the form posts, so a test can assert on what was actually sent to the SSO.
		postedBodies: [],
		clearedTimers: 0,
		// What the adapter would have written to the ioBroker log. The diagnostics tests assert
		// on these strings because they are exactly what an affected user is asked to post.
		loggedErrors: [],
		warnLines: [],
		debugLines: [],
		log: {
			// The page dumps are written at debug level and skipped above it, so the level the
			// double reports decides whether the diagnostics tests exercise anything at all.
			level: "debug",
			info() {},
			debug(msg) {
				adapter.debugLines.push(String(msg));
			},
			warn(msg) {
				adapter.warnLines.push(String(msg));
			},
			error() {},
			silly() {},
		},
		logError(e, prefix = "") {
			adapter.loggedErrors.push(prefix ? `${prefix}: ${e?.message ?? e}` : String(e?.message ?? e));
		},
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

	/**
	 * The SSO a login that works answers with: tokens on the token endpoint, the app redirect on
	 * a form post. Kept separate from `authClient.post` so a test that scripts its own answers can
	 * still hand the requests it does not care about back to the working flow.
	 *
	 * @param {string} url - request URL
	 * @returns {Promise<object>} an axios-shaped response
	 */
	adapter.ssoPost = async (url) => {
		if (String(url).includes("token")) {
			return {
				status: 200,
				data: { access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 600 },
				headers: {},
			};
		}
		return { status: 302, headers: { location: "senec-app-auth://cb?code=AUTHCODE" }, data: "" };
	};

	/**
	 * Script what the SSO answers to a form post.
	 *
	 * Recording the posted bodies stays in `authClient.post` and nowhere else: when a test replaced
	 * `post` outright it had to remember to record too, so a body was recorded twice, or not at all,
	 * depending on which of the two writers happened to be active.
	 *
	 * @param {(url: string, body?: any, cfg?: any) => Promise<object>} handler - the SSO's answer
	 * @returns {void}
	 */
	adapter.setPostHandler = (handler) => {
		postHandler = handler;
	};
	adapter.setPostHandler(adapter.ssoPost);

	adapter.authClient = {
		async get() {
			// First step of the login flow: fetch the login form.
			adapter.loginAttempts++;
			if (!loginSucceeds) {
				throw new Error("SSO unreachable");
			}
			return { status: 200, data: LOGIN_FORM, headers: {} };
		},
		async post(url, body, cfg) {
			if (!String(url).includes("token")) {
				adapter.postedBodies.push(String(body ?? ""));
			}
			return postHandler(url, body, cfg);
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
	adapter.setPostHandler(async (url, body, cfg) => {
		const isRefresh = String(body || "").includes("grant_type=refresh_token");
		if (isRefresh) {
			adapter.refreshPosts++;
			const err = new Error("Request failed with status code 400");
			// @ts-expect-error test double mimicking an axios error
			err.response = { status: 400, data: { error: "invalid_grant" } };
			throw err;
		}
		return adapter.ssoPost(url, body, cfg);
	});
}

/**
 * Build an axios-shaped rejection.
 *
 * @param {number} status - HTTP status
 * @param {any} data - response body, JSON object or HTML string
 * @returns {Error} error carrying a response, as axios would throw
 */
function httpError(status, data) {
	const err = new Error(`Request failed with status code ${status}`);
	// @ts-expect-error test double mimicking an axios error
	err.response = { status, data };
	return err;
}

/** A Keycloak refusal, which arrives as a rendered page rather than as JSON. */
const KEYCLOAK_ERROR_PAGE =
	"<html><head><title>We are sorry...</title></head><body>" +
	'<span class="kc-feedback-text">Client not found.</span></body></html>';

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
			adapter.setPostHandler(async (url, body, cfg) => {
				if (String(body || "").includes("grant_type=refresh_token")) {
					adapter.refreshPosts++;
					const err = new Error("Request failed with status code 503");
					// @ts-expect-error test double mimicking an axios error
					err.response = { status: 503, data: {} };
					throw err;
				}
				return adapter.ssoPost(url, body, cfg);
			});

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

/**
 * Every request of the login flow fails with the same axios sentence — "Request failed with
 * status code 400" — which names neither the request nor the reason. A user whose account the
 * SSO refuses can then report only that sentence, and it is compatible with four unrelated
 * causes at three different endpoints, so the report cannot be acted on at all.
 *
 * These tests assert the text the user is asked to post, not the mechanism that produces it.
 */
describe("login failure diagnostics", () => {
	/**
	 * Run a login that is expected to fail and return what the adapter logged.
	 *
	 * @param {object} adapter - Fake adapter
	 * @returns {Promise<string>} the logged error line
	 */
	async function failingLogin(adapter) {
		const token = await apiClient.apiLogin(adapter);
		assert.equal(token, null, "this login was set up to fail");
		assert.equal(adapter.loggedErrors.length, 1, "a failed login must leave exactly one error line");
		return adapter.loggedErrors[0];
	}

	it("names the authorization request when the SSO refuses it", async () => {
		const adapter = makeAdapter();
		adapter.authClient.get = async () => {
			throw httpError(400, KEYCLOAK_ERROR_PAGE);
		};

		const logged = await failingLogin(adapter);

		assert.match(logged, /authorization request/, "the failing step must name itself");
		assert.match(logged, /HTTP 400/);
		assert.match(logged, /We are sorry/, "the SSO's own wording must survive into the log");
		assert.match(logged, /Client not found/);
	});

	it("names the credentials post when the SSO refuses the form", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			throw httpError(400, KEYCLOAK_ERROR_PAGE);
		});

		const logged = await failingLogin(adapter);

		assert.match(logged, /credentials/, "the failing step must name itself");
		assert.match(logged, /sso\.senec\.com/, "the endpoint belongs in the log");
		assert.match(logged, /Client not found/);
	});

	it("names the token exchange and repeats the reason the SSO gave", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				throw httpError(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
			}
			return adapter.ssoPost(url, body, cfg);
		});

		const logged = await failingLogin(adapter);

		assert.match(logged, /authorization_code exchange/, "the failing step must name itself");
		assert.match(logged, /invalid_grant/);
		assert.match(logged, /PKCE verification failed/);
	});

	it("says where the SSO sent us when the login ends somewhere other than the app", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			return {
				status: 302,
				headers: {
					location:
						"https://sso.senec.com/realms/senec/login-actions/authenticate" +
						"?session_code=SESSIONCODEVALUE&execution=otp",
				},
				data: "",
			};
		});

		const logged = await failingLogin(adapter);

		assert.match(logged, /Login incomplete/, "an unfinished login must not read as a missing code");
		assert.match(logged, /login-actions\/authenticate/, "the destination is the whole point of the message");
		assert.match(logged, /execution=otp/, "the Keycloak step must stay readable");
	});

	it("never writes a single-use login code to the log", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			return {
				status: 302,
				headers: {
					location:
						"https://sso.senec.com/realms/senec/login-actions/authenticate" +
						"?session_code=SESSIONCODEVALUE&execution=otp",
				},
				data: "",
			};
		});

		const logged = await failingLogin(adapter);

		assert.ok(!logged.includes("SESSIONCODEVALUE"), `a login code reached the log: ${logged}`);
		assert.match(logged, /session_code=\*\*\*/, "the parameter stays visible, its value does not");
	});

	it("redacts the authorization code when the app redirect carries no usable one", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			// A refusal comes back on the app's own scheme, so it passes the destination check
			// and fails on the missing code instead.
			return {
				status: 302,
				headers: { location: "senec-app-auth://cb?error=access_denied&state=STATEVALUE" },
				data: "",
			};
		});

		const logged = await failingLogin(adapter);

		assert.match(logged, /error=access_denied/, "the refusal reason must survive");
		assert.ok(!logged.includes("STATEVALUE"), `an unredacted parameter reached the log: ${logged}`);
	});

	it("names where the SSO sent us when the username step yields no password form", async () => {
		// A brokered account is redirected to its identity provider instead of being shown a
		// password form. The 3xx has no body, so the Location header is the only thing that says
		// which provider — and "Got something else." on its own is a report nobody can act on.
		const adapter = makeAdapter();
		adapter.authClient.get = async () => ({ status: 200, data: USERNAME_FORM, headers: {} });
		adapter.setPostHandler(async (url, body, cfg) =>
			String(url).includes("token")
				? adapter.ssoPost(url, body, cfg)
				: {
						status: 302,
						headers: {
							location: "https://idp.myenergykey.com/authorize?session_code=SESSIONCODEVALUE&tab_id=T1",
						},
						data: "",
					},
		);

		const logged = await failingLogin(adapter);

		assert.match(logged, /Expected: Login-Form with password/, "the failing step keeps the wording it had");
		assert.match(logged, /idp\.myenergykey\.com/, "and now also names where the SSO went");
		assert.ok(!logged.includes("SESSIONCODEVALUE"), `a login code reached the log: ${logged}`);
		assert.ok(
			adapter.debugLines.some((line) => /the username step was answered with .*idp\.myenergykey\.com/.test(line)),
			"the redirect belongs in the page diagnostics too, where there is no page to write",
		);
	});

	it("treats a refresh token the SSO has dropped as routine rather than as a fault", async () => {
		const adapter = makeAdapter({ loginSucceeds: true });
		rejectRefreshWithInvalidGrant(adapter);

		await apiClient.apiRefreshToken(adapter);

		assert.equal(adapter.currentToken, "new-access-token", "the full login must still happen");
		assert.deepEqual(
			adapter.warnLines.filter((line) => /Token refresh failed/.test(line)),
			[],
			"an expired session is not a failure worth warning about",
		);
		assert.ok(
			adapter.debugLines.some((line) => /no longer accepted/.test(line)),
			"it still has to be visible at debug level",
		);
	});

	it("still warns when a refresh fails for a reason that is not an expired session", async () => {
		const adapter = makeAdapter();
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(body || "").includes("grant_type=refresh_token")) {
				throw httpError(503, "<html><title>Service Unavailable</title></html>");
			}
			return adapter.ssoPost(url, body, cfg);
		});

		await apiClient.apiRefreshToken(adapter).catch(() => {});

		const warned = adapter.warnLines.filter((line) => /Token refresh failed/.test(line));
		assert.equal(warned.length, 1, "a real outage must still be warned about");
		assert.match(warned[0], /HTTP 503/, "the status belongs in the warning");
		assert.match(warned[0], /Service Unavailable/, "so does what the server said");
	});
});

describe("login form handling", () => {
	it("posts the hidden fields of the form alongside the credentials", async () => {
		const adapter = makeAdapter();
		adapter.authClient.get = async () => ({ status: 200, data: USERNAME_FORM, headers: {} });
		let formPosts = 0;
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			formPosts++;
			// The username step answers with the password form; the password step redirects.
			return formPosts === 1
				? { status: 200, data: PASSWORD_FORM, headers: {} }
				: { status: 302, headers: { location: "senec-app-auth://cb?code=AUTHCODE" }, data: "" };
		});

		const token = await apiClient.apiLogin(adapter);
		assert.equal(token, "new-access-token");

		assert.equal(adapter.postedBodies.length, 2, "a two-step login posts the form exactly twice");
		const [usernamePost, passwordPost] = adapter.postedBodies;
		assert.match(usernamePost, /execution=idp-discovery/, "the form's hidden state has to go back");
		assert.match(usernamePost, /username=user%40example\.com/);
		assert.ok(!usernamePost.includes("locale=de"), "fields of a different form must not be posted");
		assert.ok(!usernamePost.includes("password="), "the password belongs to the second step");

		assert.match(passwordPost, /credentialId=pw-1/, "the password form's hidden state too");
		assert.match(passwordPost, /password=secret/);
	});

	it("posts the TOTP form's own hidden state, not the code on its own", async () => {
		// Keycloak uses `credentialId` on the OTP step to say which authenticator the code belongs
		// to; a body of nothing but `otp` is refused on any account with more than one.
		const adapter = makeAdapter();
		adapter.config.api_totp_secret = "JBSWY3DPEHPK3PXP";
		adapter.authClient.get = async () => ({ status: 200, data: USERNAME_FORM, headers: {} });
		const answers = [
			{ status: 200, data: PASSWORD_FORM, headers: {} },
			{ status: 200, data: OTP_FORM, headers: {} },
			{ status: 302, headers: { location: "senec-app-auth://cb?code=AUTHCODE" }, data: "" },
		];
		adapter.setPostHandler(async (url, body, cfg) =>
			String(url).includes("token") ? adapter.ssoPost(url, body, cfg) : answers.shift(),
		);

		assert.equal(await apiClient.apiLogin(adapter), "new-access-token");

		assert.equal(adapter.postedBodies.length, 3, "username, password and TOTP are three posts");
		const otpPost = adapter.postedBodies[2];
		assert.match(otpPost, /credentialId=totp-1/, "the OTP form's hidden state has to go back with the code");
		assert.match(otpPost, /otp=\d{6}/, "and the generated code itself");
	});

	it("lets the adapter's own values win over a hidden field of the same name", async () => {
		const adapter = makeAdapter();
		adapter.authClient.get = async () => ({
			status: 200,
			data:
				'<form action="https://sso.senec.com/login">' +
				'<input type="hidden" name="username" value="stale@example.com">' +
				'<input name="username" type="text"><input name="password" type="password"></form>',
			headers: {},
		});

		await apiClient.apiLogin(adapter);

		assert.match(adapter.postedBodies[0], /username=user%40example\.com/);
		assert.ok(!adapter.postedBodies[0].includes("stale%40example.com"), "the stale value must be overwritten");
	});
});

describe("login page diagnostics", () => {
	/**
	 * A Keycloak page that names the identity provider a migrated account is handed to.
	 *
	 * It carries the account address in the two spellings such a page uses — percent-encoded in a
	 * link and raw in the field the user typed into — and the password in the `value` attribute a
	 * server can echo back, because a fixture that contains no secret cannot show that one is
	 * masked. `tab_id` identifies one Keycloak authentication session and is new on every attempt,
	 * which is what the collapse of repeated failures has to survive.
	 *
	 * @param {string} tabId - the authentication session id of this attempt
	 * @returns {string} the rendered error page
	 */
	function idpErrorPage(tabId) {
		return (
			"<html><head><title>We are sorry...</title><style>.x{color:red}</style></head><body>" +
			'<span class="kc-feedback-text">Unexpected error when handling authentication request to identity provider.</span>' +
			`<a href="/login-actions/restart?login_hint=user%40example.com&tab_id=${tabId}">Restart</a>` +
			`<form action="/login-actions/authenticate?session_code=SESSIONCODEVALUE&tab_id=${tabId}">` +
			'<input type="hidden" name="credentialId" value="idp-myenergykey">' +
			'<input name="username" type="text" value="user@example.com" readonly>' +
			'<input name="password" type="password" value="secret"></form>' +
			"<script>var x=1;</script></body></html>"
		);
	}

	/**
	 * Fail the form post with a rendered Keycloak page, as the SSO does.
	 *
	 * @param {object} adapter - Fake adapter
	 * @param {() => string} [page] - the page of this attempt; the default never varies
	 * @returns {void}
	 */
	function failFormPostWithPage(adapter, page = () => idpErrorPage("TAB1")) {
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				return adapter.ssoPost(url, body, cfg);
			}
			throw httpError(400, page());
		});
	}

	/**
	 * Collect the page dumps written during a login.
	 *
	 * @param {object} adapter - Fake adapter
	 * @returns {string[]} the [SSO PAGE] lines
	 */
	function pageLines(adapter) {
		return adapter.debugLines.filter((line) => line.startsWith("[SSO PAGE]"));
	}

	it("writes the page behind a failed step even with request logging switched off", async () => {
		const adapter = makeAdapter();
		assert.ok(!adapter.config.api_reqnresp_log, "this test is about the option being off");
		failFormPostWithPage(adapter);

		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 1, "a failed step must record its page without a settings change");
		assert.match(pages[0], /failed step/);
		assert.match(pages[0], /idp-myenergykey/, "the provider name is the reason for dumping the page");
		assert.match(pages[0], /identity provider/);
		assert.ok(!pages[0].includes("var x=1"), "scripts are not diagnostics");
		assert.ok(!pages[0].includes("SESSIONCODEVALUE"), "a login code must not reach the log");
		assert.ok(!pages[0].includes("user@example.com"), "nor the account mail");
		assert.ok(!pages[0].includes("user%40example.com"), "in whichever spelling the page uses");
		assert.ok(!pages[0].includes("secret"), "nor a password the page echoes back at us");
		assert.ok(pages[0].includes("***@***"), "the address is masked rather than dropped");
		assert.ok(pages[0].includes('value="***"'), "and so is the echoed password");
	});

	it("collapses the same failure even though the SSO's tab_id is new on every attempt", async () => {
		// Every attempt starts a fresh Keycloak authentication session, and `tab_id` names it — in
		// the form action, and in the URL the step is labelled with. Both are kept on purpose to
		// keep a log readable, so the collapse has to see past them or it never fires at all.
		const adapter = makeAdapter();
		let attempt = 0;
		adapter.authClient.get = async () => {
			attempt++;
			return {
				status: 200,
				data:
					`<form id="kc-form-login" action="https://sso.senec.com/login?tab_id=TAB${attempt}" method="POST">` +
					'<input name="username" type="text"><input name="password" type="password"></form>',
				headers: {},
			};
		};
		failFormPostWithPage(adapter, () => idpErrorPage(`TAB${attempt}`));

		await apiClient.apiLogin(adapter);
		await apiClient.apiLogin(adapter);
		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 3, "every attempt still says something");
		assert.match(pages[0], /idp-myenergykey/, "the first one carries the page");
		assert.match(pages[0], /tab_id=TAB1/, "the session id of this attempt stays readable");
		assert.match(pages[1], /tab_id=TAB2/, "the next attempt really is a different session");
		assert.match(pages[1], /unchanged since the last attempt/);
		assert.match(pages[2], /unchanged since the last attempt/);
	});

	it("writes the page again once a login has succeeded in between", async () => {
		const adapter = makeAdapter();
		failFormPostWithPage(adapter);

		await apiClient.apiLogin(adapter);
		adapter.setPostHandler(adapter.ssoPost);
		assert.equal(await apiClient.apiLogin(adapter), "new-access-token");
		failFormPostWithPage(adapter);
		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 2);
		assert.match(pages[1], /idp-myenergykey/, "a failure after a recovery is not a repeat");
	});

	it("writes the page again once a token refresh has recovered the session in between", async () => {
		// A refresh restores the session without a login, so it ends the run of identical failures
		// the same way: the next failure is a new one, not the one that was already reported.
		const adapter = makeAdapter();
		failFormPostWithPage(adapter);

		await apiClient.apiLogin(adapter);
		await apiClient.apiRefreshToken(adapter);
		assert.equal(adapter.currentToken, "new-access-token", "this test needs the refresh to have worked");
		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 2);
		assert.match(pages[1], /idp-myenergykey/, "a failure after a refresh is not a repeat either");
	});

	it("does not collapse a page against a failure that never had one", async () => {
		const adapter = makeAdapter();
		failFormPostWithPage(adapter);
		await apiClient.apiLogin(adapter);

		// The token exchange fails with a JSON body, so there is no page to write. Keeping the key
		// of the page before it would report the next failure that does have one as "unchanged"
		// against a page from a failure that is already over.
		adapter.setPostHandler(async (url, body, cfg) => {
			if (String(url).includes("token")) {
				throw httpError(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
			}
			return adapter.ssoPost(url, body, cfg);
		});
		await apiClient.apiLogin(adapter);
		assert.equal(adapter.lastLoggedAuthPage, null, "a failure with no page must leave no key behind");

		failFormPostWithPage(adapter);
		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 2, "the JSON failure has no page of its own to write");
		assert.match(pages[1], /idp-myenergykey/, "and the page after it is written in full");
	});

	it("writes nothing above debug level and keeps the failure unreported until debug is on", async () => {
		// Everything the dump costs — a full-body regex sweep and a hash over the result — is spent
		// on output the logger discards above debug. Marking the failure as reported anyway would
		// mean that switching the level to debug shows "unchanged since the last attempt" and never
		// the page the user turned it on for.
		const adapter = makeAdapter();
		adapter.log.level = "info";
		failFormPostWithPage(adapter);

		await apiClient.apiLogin(adapter);

		assert.deepEqual(pageLines(adapter), [], "no page is written at info level");
		assert.equal(adapter.lastLoggedAuthPage, null, "and the failure is not marked as already reported");

		adapter.log.level = "debug";
		await apiClient.apiLogin(adapter);

		const pages = pageLines(adapter);
		assert.equal(pages.length, 1);
		assert.match(pages[0], /idp-myenergykey/, "the page arrives in full as soon as it can be seen");
	});

	it("still writes the page when the adapter reports no log level at all", async () => {
		// A host that does not expose a level must not silently cost an affected user the one
		// diagnostic a failing login leaves behind — an unknown level proceeds rather than blocks.
		const adapter = makeAdapter();
		adapter.log.level = undefined;
		failFormPostWithPage(adapter);

		await apiClient.apiLogin(adapter);

		assert.equal(pageLines(adapter).length, 1, "an unknown level must not disable the diagnostic");
	});

	it("records the page the SSO answers the username step with when request logging is on", async () => {
		// A two-step login is decided by that page: whether it carries a password form, and which
		// identity provider it names. Without it a brokered account fails with a sentence that says
		// only that no password form was found.
		const adapter = makeAdapter();
		adapter.config.api_reqnresp_log = true;
		adapter.authClient.get = async () => ({ status: 200, data: USERNAME_FORM, headers: {} });
		const answers = [
			{ status: 200, data: PASSWORD_FORM, headers: {} },
			{ status: 302, headers: { location: "senec-app-auth://cb?code=AUTHCODE" }, data: "" },
		];
		adapter.setPostHandler(async (url, body, cfg) =>
			String(url).includes("token") ? adapter.ssoPost(url, body, cfg) : answers.shift(),
		);

		assert.equal(await apiClient.apiLogin(adapter), "new-access-token");

		const afterUsername = pageLines(adapter).filter((line) => line.includes("page after the username step"));
		assert.equal(afterUsername.length, 1, "the page the second step is chosen from must be recorded");
		assert.match(afterUsername[0], /name="credentialId"/, "and it has to carry the form, not just a label");
	});

	it("keeps the pages of a working login behind the request/response option", async () => {
		const adapter = makeAdapter();

		assert.equal(await apiClient.apiLogin(adapter), "new-access-token");
		assert.equal(pageLines(adapter).length, 0, "a login that works must not dump pages by default");

		adapter.config.api_reqnresp_log = true;
		assert.equal(await apiClient.apiLogin(adapter), "new-access-token");
		assert.ok(
			pageLines(adapter).some((line) => /login form as served/.test(line)),
			"with the option on the served form is recorded",
		);
	});
});
