"use strict";

/**
 * Regression tests for mein-senec.de HTTP status handling.
 *
 * _webRequest asks axios not to reject on status (validateStatus: () => true) so that the
 * control call sites can read the portal's own error body. The hazard is that every other
 * caller then has to remember to check res.status, and most did not — an HTTP 500 arrived
 * looking exactly like a successful response and was written to states as data.
 *
 * These tests pin the central policy: anything that is not a success is raised, so a caller
 * cannot process it by accident. Callers that genuinely interpret status opt out explicitly.
 */

const assert = require("node:assert/strict");

const webClient = require("../lib/web-client");
const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");

/**
 * Build an adapter double whose HTTP layer replays scripted responses.
 *
 * @param {object} [opts] - Options
 * @param {Array<object|Error>} [opts.responses] - Responses returned in order; the last repeats
 * @param {object} [opts.config] - Adapter config overrides
 * @returns {object} Fake adapter with call recorders
 */
function makeAdapter(opts = {}) {
	const responses = opts.responses || [];
	let callIndex = 0;

	const adapter = {
		unloaded: false,
		webJar: {},
		webMasterPlantNumber: 1,
		webConnected: false,
		webAuthenticated: true,
		webStatusIntervalMs: 60000,
		webMediumIntervalMs: 6 * 3600 * 1000,
		webAbilities: {},
		config: {
			web_showPolling: false,
			web_measurements: false,
			web_reqnresp_log: false,
			...(opts.config || {}),
		},
		calls: [],
		evalPollCalls: [],
		lastPollCalls: [],
		writtenStates: [],
		loginCount: 0,
		log: { info() {}, debug() {}, warn() {}, error() {}, silly() {} },
		logError() {},
		setTimeout() {
			return null;
		},
		clearTimeout() {},
		async evalPoll(data, pfx) {
			adapter.evalPollCalls.push(pfx);
		},
		async updateLastPoll(id) {
			adapter.lastPollCalls.push(id);
		},
		async doState(id, val) {
			adapter.writtenStates.push([id, val]);
		},
		async setState() {},
		async setStateAsync() {},
		async getStateAsync() {
			return null;
		},
		async updateConnectionStatus() {},
	};

	/**
	 * @param {string} method - HTTP method
	 * @param {string} url - Requested URL
	 * @returns {Promise<object>} Scripted response
	 */
	const respond = async (method, url) => {
		adapter.calls.push(`${method} ${url}`);
		const next = responses[Math.min(callIndex, responses.length - 1)];
		callIndex++;
		if (next instanceof Error) {
			throw next;
		}
		return { status: 200, data: {}, headers: {}, ...(next || {}) };
	};

	adapter.authClient = {
		get: (url) => respond("GET", url),
		post: (url) => respond("POST", url),
	};

	adapter.webQueue = new AdaptiveRequestQueue({
		concurrency: 1,
		minConcurrency: 1,
		maxConcurrency: 2,
		minTimeBetweenStartsMs: 0,
		// Short, because a failing poll now genuinely waits out a cooldown between its
		// sub-requests. The cooldown's length is asserted in the retry-policy tests below.
		cooldownMs: 20,
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
	});

	return adapter;
}

describe("mein-senec.de status handling", () => {
	it("HTTP 500 is raised, not returned as data", async () => {
		const adapter = makeAdapter({ responses: [{ status: 500, data: { error: "boom" } }] });

		await assert.rejects(
			() => webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/anything"),
			/500/,
			"a server error must not resolve as a successful response",
		);
	});

	it("HTTP 500 during a poll updates neither data, lastPoll nor the connection flag", async () => {
		const adapter = makeAdapter({ responses: [{ status: 500, data: { error: "boom" } }] });

		await webClient.webPoll(adapter);

		assert.deepEqual(adapter.evalPollCalls, [], "no state may be written from an error response");
		assert.deepEqual(adapter.lastPollCalls, [], "lastPoll must not advance on a failed poll");
		assert.equal(adapter.webConnected, false, "a failing portal is not a live connection");
	});

	it("HTTP 429 activates the queue cooldown and is not counted as a success", async () => {
		const adapter = makeAdapter({ responses: [{ status: 429, data: "", headers: { "retry-after": "30" } }] });

		await assert.rejects(() => webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/anything"));

		const stats = adapter.webQueue.getStats();
		assert.equal(stats.rateLimited, 1, "429 must be counted as rate limiting");
		assert.equal(stats.succeeded, 0, "a throttled request is not a successful one");
		assert.ok(stats.cooldownCount >= 1, "cooldown must have been started");
	});

	it("a valid 200 response still resolves and carries its data", async () => {
		const adapter = makeAdapter({ responses: [{ status: 200, data: { fullkwh: 12.5 } }] });

		const res = await webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/anything");

		assert.equal(res.status, 200);
		assert.deepEqual(res.data, { fullkwh: 12.5 });
	});

	it("the login page served with HTTP 200 triggers exactly one re-authentication", async () => {
		// Every response is the login page — a retry loop would re-login without end.
		const adapter = makeAdapter({
			responses: [{ status: 200, data: "<html><title>Login - SENEC</title></html>" }],
		});
		let logins = 0;
		const realLogin = webClient.webLogin;
		try {
			webClient.webLogin = async () => {
				logins++;
				return true;
			};
			await webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/anything").catch(() => {});
		} finally {
			webClient.webLogin = realLogin;
		}

		assert.equal(logins, 1, `re-authentication ran ${logins} times, expected exactly 1`);
		assert.equal(adapter.calls.length, 2, "the request is retried once after the re-login");
	});

	it("a failing control POST is sent exactly once", async () => {
		const adapter = makeAdapter({ responses: [{ status: 500, data: { message: "nope" } }] });

		await webClient
			.webPost(adapter, "https://mein-senec.de/endkunde/api/senec/1/emergencypower?reserve-in-percent=20", {})
			.catch(() => {});

		const posts = adapter.calls.filter((c) => c.startsWith("POST"));
		assert.equal(posts.length, 1, "a control command must never be replayed automatically");
	});

	describe("retry policy against a struggling portal", () => {
		/**
		 * An adapter whose queue matches the shipped web configuration, with a short cooldown
		 * so the test does not wait on wall-clock seconds.
		 *
		 * @param {object[]} responses - Scripted responses
		 * @returns {object} Fake adapter
		 */
		function makeQueuedAdapter(responses) {
			const adapter = makeAdapter({ responses });
			adapter.webQueue = new AdaptiveRequestQueue({
				concurrency: 2,
				minConcurrency: 1,
				maxConcurrency: 2,
				minTimeBetweenStartsMs: 0,
				cooldownMs: 60,
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (id) => clearTimeout(id),
			});
			return adapter;
		}

		it("a retried GET is attempted the initial time plus its retry budget, and no more", async () => {
			const adapter = makeQueuedAdapter([{ status: 500, data: "" }]);

			await webClient
				.webGet(adapter, "https://mein-senec.de/endkunde/api/alltime", { maxRetries: 3, label: "AllTime" })
				.catch(() => {});

			assert.equal(adapter.calls.length, 4, "one initial attempt plus three retries");
		});

		it("a 5xx puts the whole queue into cooldown rather than retrying straight away", async () => {
			const adapter = makeQueuedAdapter([{ status: 503, data: "" }]);

			await webClient
				.webGet(adapter, "https://mein-senec.de/endkunde/api/alltime", { maxRetries: 1, label: "AllTime" })
				.catch(() => {});

			const stats = adapter.webQueue.getStats();
			assert.ok(stats.cooldownCount >= 1, "a server error must trigger backoff, not an immediate retry");
		});

		it("a 5xx honours Retry-After when the portal sends one", async () => {
			const adapter = makeQueuedAdapter([{ status: 503, data: "", headers: { "retry-after": "30" } }]);
			const before = Date.now();

			await webClient
				.webGet(adapter, "https://mein-senec.de/endkunde/api/alltime", { label: "AllTime" })
				.catch(() => {});

			const waitMs = adapter.webQueue.cooldownUntil - before;
			assert.ok(waitMs > 25000, `cooldown was ${waitMs}ms, expected the requested 30s`);
		});

		it("other portal requests wait out the cooldown instead of piling on", async () => {
			const adapter = makeQueuedAdapter([{ status: 500, data: "" }]);

			await webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/first").catch(() => {});
			const afterFirst = adapter.calls.length;

			const second = webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/second").catch(() => {});
			// Give the queue a turn: without a cooldown it would start the second request now.
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(adapter.calls.length, afterFirst, "the next request must not start during cooldown");

			await second;
			assert.ok(adapter.calls.length > afterFirst, "and must still run once the cooldown expires");
		});

		it("a control POST is never retried, whatever the portal answers", async () => {
			const adapter = makeQueuedAdapter([{ status: 500, data: { message: "boom" } }]);

			await webClient
				.webPost(adapter, "https://mein-senec.de/endkunde/api/senec/1/sgready", { on: true }, { rawStatus: true })
				.catch(() => {});

			const posts = adapter.calls.filter((c) => c.startsWith("POST"));
			assert.equal(posts.length, 1, "a control command must reach the appliance at most once");
		});

		it("a permanent 4xx is not retried at all", async () => {
			const adapter = makeQueuedAdapter([{ status: 404, data: "" }]);

			await webClient
				.webGet(adapter, "https://mein-senec.de/endkunde/api/gone", { maxRetries: 3, label: "AllTime" })
				.catch(() => {});

			assert.equal(adapter.calls.length, 1, "retrying a 404 cannot help and only adds load");
		});
	});

	describe("rawStatus control POSTs still take part in overload accounting", () => {
		/**
		 * A control POST that opts out of status raising, against a scripted portal.
		 *
		 * @param {object} response - Scripted response
		 * @returns {Promise<{ adapter: object, res: any }>} Adapter and returned response
		 */
		async function controlPost(response) {
			const adapter = makeAdapter({ responses: [response] });
			adapter.webQueue = new AdaptiveRequestQueue({
				concurrency: 2,
				minConcurrency: 1,
				maxConcurrency: 2,
				minTimeBetweenStartsMs: 0,
				cooldownMs: 40,
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (id) => clearTimeout(id),
			});
			const res = await webClient
				.webPost(adapter, "https://mein-senec.de/endkunde/api/senec/1/sgready", { on: true }, { rawStatus: true })
				.catch(() => null);
			return { adapter, res };
		}

		it("a 500 starts the queue-wide cooldown even though the caller reads the status", async () => {
			const { adapter } = await controlPost({ status: 500, data: { message: "boom" } });
			assert.ok(adapter.webQueue.getStats().cooldownCount >= 1, "rawStatus must not bypass overload accounting");
		});

		it("a 503 starts the queue-wide cooldown", async () => {
			const { adapter } = await controlPost({ status: 503, data: "" });
			assert.ok(adapter.webQueue.getStats().cooldownCount >= 1);
		});

		it("a 429 starts the cooldown, is counted, and honours a numeric Retry-After", async () => {
			const before = Date.now();
			const { adapter } = await controlPost({ status: 429, data: "", headers: { "retry-after": "20" } });

			const stats = adapter.webQueue.getStats();
			assert.equal(stats.rateLimited, 1, "a throttled control POST must be counted as rate limiting");
			assert.ok(adapter.webQueue.cooldownUntil - before > 15000, "Retry-After must set the cooldown length");
		});

		it("an overload response is not scored as a successful request", async () => {
			const { adapter } = await controlPost({ status: 429, data: "" });
			assert.equal(adapter.webQueue.getStats().succeeded, 0);
		});

		it("a 5xx control POST is never replayed", async () => {
			const { adapter } = await controlPost({ status: 500, data: "" });
			assert.equal(adapter.calls.filter((c) => c.startsWith("POST")).length, 1);
		});

		it("a 429 control POST is never replayed", async () => {
			const { adapter } = await controlPost({ status: 429, data: "" });
			assert.equal(adapter.calls.filter((c) => c.startsWith("POST")).length, 1);
		});

		it("the portal's own response still reaches the control handler", async () => {
			const { adapter, res } = await controlPost({ status: 500, data: { message: "reserve out of range" } });

			assert.equal(res.status, 500, "rawStatus exists so the handler can report the portal's refusal");
			assert.equal(webClient.webApiErrorMsg(res), "reserve out of range");
			assert.ok(adapter.webQueue.getStats().cooldownCount >= 1, "and the queue still backs off");
		});

		it("a permanent 4xx neither backs off nor is retried", async () => {
			const { adapter, res } = await controlPost({ status: 400, data: { message: "bad request" } });

			assert.equal(res.status, 400);
			assert.equal(adapter.calls.filter((c) => c.startsWith("POST")).length, 1, "a 400 cannot be fixed by retrying");
			assert.equal(
				adapter.webQueue.getStats().cooldownCount,
				0,
				"a client mistake is not an overload signal and must not pause the queue",
			);
		});
	});

	describe("re-authentication", () => {
		/**
		 * Replace webLogin for the duration of a call.
		 *
		 * @param {() => Promise<boolean>} fn - Stub implementation
		 * @param {() => Promise<any>} body - Work to run
		 * @returns {Promise<any>} Result of body
		 */
		async function withLogin(fn, body) {
			const real = webClient.webLogin;
			webClient.webLogin = fn;
			try {
				return await body();
			} finally {
				webClient.webLogin = real;
			}
		}

		it("a 401 on a GET re-authenticates once and retries once", async () => {
			const adapter = makeAdapter({ responses: [{ status: 401, data: "" }, { status: 200, data: { ok: true } }] });
			let logins = 0;

			const res = await withLogin(
				async () => {
					logins++;
					return true;
				},
				() => webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/thing"),
			);

			assert.equal(logins, 1);
			assert.equal(adapter.calls.length, 2, "the original request is retried exactly once");
			assert.equal(res.status, 200);
		});

		it("a persistent 401 re-authenticates only once and then raises", async () => {
			const adapter = makeAdapter({ responses: [{ status: 401, data: "" }] });
			let logins = 0;

			await assert.rejects(() =>
				withLogin(
					async () => {
						logins++;
						return true;
					},
					() => webClient.webGet(adapter, "https://mein-senec.de/endkunde/api/thing"),
				),
			);

			assert.equal(logins, 1, "a portal that keeps refusing must not drive a login loop");
			assert.equal(adapter.calls.length, 2, "and must not drive a request loop either");
		});

		it("a control POST meeting an expired session is sent at most twice", async () => {
			// The first 401 means the portal rejected the request before acting on it, so one
			// replay after re-authenticating cannot double-apply the command. A second refusal
			// is reported, not retried again.
			const adapter = makeAdapter({ responses: [{ status: 401, data: "" }] });
			let logins = 0;

			const res = await withLogin(
				async () => {
					logins++;
					return true;
				},
				() =>
					webClient.webPost(
						adapter,
						"https://mein-senec.de/endkunde/api/senec/1/sgready",
						{ on: true },
						{ rawStatus: true },
					),
			);

			assert.equal(logins, 1);
			assert.equal(adapter.calls.filter((c) => c.startsWith("POST")).length, 2);
			assert.equal(res.status, 401, "a still-refused control call is reported to its caller, not thrown");
		});

		it("a control caller sees an authentication refusal as a status, not as data", async () => {
			const adapter = makeAdapter({ responses: [{ status: 403, data: { message: "forbidden" } }] });

			const res = await withLogin(
				async () => true,
				() =>
					webClient.webPost(
						adapter,
						"https://mein-senec.de/endkunde/api/senec/1/sgready",
						{ on: true },
						{ rawStatus: true },
					),
			);

			assert.equal(res.status, 403);
			assert.equal(webClient.webApiErrorMsg(res), "forbidden");
		});
	});

	it("control callers can still read the portal's own error status and body", async () => {
		const adapter = makeAdapter({ responses: [{ status: 400, data: { message: "reserve out of range" } }] });

		const res = await webClient.webPost(
			adapter,
			"https://mein-senec.de/endkunde/api/senec/1/emergencypower?reserve-in-percent=200",
			{},
			{ rawStatus: true },
		);

		assert.equal(res.status, 400);
		assert.equal(webClient.webApiErrorMsg(res), "reserve out of range");
	});
});
