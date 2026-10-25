"use strict";

/**
 * The life cycle of the local OpenAPI connector: when it polls again, when it deliberately
 * stops, and what it tells the rest of the adapter on the way.
 *
 * Everything here is driven through the module's own exported entry points — `openapiPoll`,
 * `openapiInit`, `openapiForgetToken` — with the appliance's HTTPS client replaced by a
 * scripted double. `scheduleOpenapiPoll` and `setOpenapiConnected` are not exported and are
 * not meant to be: they are observed through the timers the adapter is asked to arm and the
 * connection updates it is asked to publish, which is exactly how the adapter sees them.
 *
 * The defects these pin, all of which shipped at one point or another:
 *
 * - a registration that failed at startup left a poll armed whose no-token branch returned
 *   without rescheduling and without retrying the registration, so the connector sat dead
 *   until someone restarted the instance;
 * - the approval budget counted every refusal alike. Counting the transient one — the
 *   mein-senec.de connector not having signed in yet — burned the whole budget in three
 *   intervals on a cloud side that was merely slow to start; counting none of them left a
 *   refused credential re-sent once per interval for the life of the process, measured at ten
 *   real sign-ins over ten cycles, which is 8640 a day at the minimum interval and is how an
 *   account gets rate-limited. The two refusals are now told apart;
 * - the backed-off retry had no floor, so full jitter returned below the configured interval
 *   about half the time on the first failure and could return nearly zero;
 * - a 401 that the second look cleared left the previous verdict in the state for a whole
 *   interval;
 * - a certificate naming another appliance stopped the cycle but left the connector reported
 *   as connected;
 * - an appliance that was simply switched off produced one error line per cycle, 1440 a day.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const openapi = require("../lib/openapi-client.js");
const { withNoRealWait, recordingDelay } = require("./waitHelpers.js");

/** What the poll reads when a token is stored. The adapter's decrypt is the identity here. */
const STORED_TOKEN = "appliance-token";

/**
 * Build an adapter whose timers, states and connection updates are all recorded.
 *
 * The appliance client is pre-set on `openapiClient`, so the module's axios instance is never
 * created and no socket is ever opened — `test/mocha.setup.js` would refuse one anyway.
 *
 * @param {object} [over] - Overrides merged over the defaults; `config` is merged, not replaced
 * @returns {object} Adapter double
 */
function makeAdapter(over = {}) {
	const adapter = {
		namespace: "senec.0",
		unloaded: false,
		loggedConditions: new Set(),
		openapiConnected: false,
		openapiIdentityMismatch: false,
		openapiExpectedDeviceId: null,
		// Pre-pinned, so openapiInit does not go looking for a stored fingerprint.
		openapiFingerprint: "pinned",
		openapiApproveAttempts: 0,
		openapiTransportFailures: 0,
		openapiPollTimer: null,
		openapiBusy: false,
		// One flag for polls and registration sequences together, which is what keeps an Admin
		// press from overlapping a timer poll inside the approval wait.
		openapiCycleRunning: false,

		/** Every in-cycle wait asked for, in order, in milliseconds. */
		waited: [],
		/** Timers still pending: armed, not yet cleared. */
		timers: [],
		/** Every delay ever armed, in order, including those later replaced. */
		armed: [],
		cleared: 0,
		statusWrites: 0,
		states: [],
		polled: [],
		logs: [],
		/** How often openapiInit was entered — see `localHostConfigured` below. */
		initEntries: 0,
	};

	adapter.log = {
		info: (msg) => adapter.logs.push(["info", msg]),
		warn: (msg) => adapter.logs.push(["warn", msg]),
		error: (msg) => adapter.logs.push(["error", msg]),
		debug: (msg) => adapter.logs.push(["debug", msg]),
		silly: () => {},
	};
	adapter.logError = (e, prefix = "") => adapter.logs.push(["error", `${prefix}: ${e?.message ?? e}`]);
	// In-cycle waits go through adapter.delay. Settled at once so the suite does not spend real
	// seconds in the confirmation paths, and recorded so a test can pin the wait constants.
	adapter.delay = recordingDelay(adapter);
	adapter.setTimeout = (fn, ms) => {
		const handle = { fn, ms };
		adapter.timers.push(handle);
		adapter.armed.push(ms);
		return handle;
	};
	adapter.clearTimeout = (handle) => {
		adapter.cleared++;
		adapter.timers = adapter.timers.filter((t) => t !== handle);
	};
	adapter.updateConnectionStatus = async () => {
		adapter.statusWrites++;
	};
	adapter.doState = async (id, value) => {
		adapter.states.push([id, value]);
	};
	adapter.evalPoll = async (obj, pfx) => {
		adapter.polled.push([pfx, obj]);
	};
	adapter.getStateAsync = async () => null;
	adapter.decrypt = (value) => value;
	adapter.encrypt = (value) => value;
	// openapiInit is the only thing on these paths that asks, so the counter is a precise probe
	// for "the registration path was entered again", and answering `false` makes it stop there.
	adapter.localHostConfigured = () => {
		adapter.initEntries++;
		return false;
	};

	Object.assign(adapter, over);
	adapter.config = {
		openapi_use: true,
		senecip: "192.0.2.1",
		openapi_interval: 60,
		...(over.config || {}),
	};
	return adapter;
}

/** @returns {Function} A getStateAsync that answers with a stored token. */
function tokenStored() {
	return async (id) => (id === "_openapi.token" ? { val: STORED_TOKEN } : null);
}

/**
 * @param {object} body - Payload the route is to answer with
 * @returns {object} A 200, with the body as the text the appliance really sends
 */
const answers = (body) => ({ status: 200, data: JSON.stringify(body) });

/**
 * @param {number} status - Status code off the token ladder
 * @returns {object} A refusal, worded the way the appliance words them
 */
const refuses = (status) => ({ status, data: "not authorized" });

/**
 * An appliance client that answers every route the same way.
 *
 * The registration POST is refused outright unless a test asks for one, so a path that reaches
 * outside the appliance cannot be taken by accident on the cycles pinned here.
 *
 * @param {(path: string, call: number) => object} answer - What to answer a read with, per call
 * @param {(path: string, call: number) => object} [onPost] - What to answer the registration with
 * @returns {{get: Function, post: Function, calls: string[]}} The client double
 */
function appliance(answer, onPost) {
	const calls = [];
	/**
	 * @param {(path: string, call: number) => object} script - The answer to use
	 * @param {string} path - Route asked for
	 * @returns {Promise<object>} The scripted answer
	 */
	const record = async (script, path) => {
		calls.push(path);
		const response = script(path, calls.length);
		if (response instanceof Error) {
			throw response;
		}
		return response;
	};
	return {
		calls,
		get: (path) => record(answer, path),
		post: (path) => {
			if (!onPost) {
				throw new Error("the appliance must not be registered with on this path");
			}
			return record(onPost, path);
		},
	};
}

/**
 * Run `body` and assert that no cycle waited on a global timer.
 *
 * The helper collapses every timer to the next tick, so a reintroduced bare timer does not slow
 * this suite — the run stays in milliseconds either way, and a timing change would not reveal
 * one. Two things report it instead: this assertion, and the teardown test further down, which
 * never reaches `adapter.delay` and fails on its own. See `test/waitHelpers.js` for what the
 * guard does and does not cover.
 *
 * @param {() => Promise<void>} body - Work to run
 * @returns {Promise<void>}
 */
const withoutWaiting = withNoRealWait;

/**
 * @param {object} adapter - Adapter double
 * @param {string} id - State path
 * @returns {unknown} The last value written to that state, or undefined
 */
function lastWrite(adapter, id) {
	const hits = adapter.states.filter(([written]) => written === id);
	return hits.length ? hits[hits.length - 1][1] : undefined;
}

describe("local OpenAPI connector: life cycle", () => {
	describe("a registration that could not be made yet", () => {
		// The defect this closes: the no-token branch wrote "unregistered" and returned. The poll
		// that brought it there was the last one ever armed, and nothing re-entered registration,
		// so an appliance that was not up yet when the host booted kept the connector dead until
		// the instance was restarted by hand.
		//
		// The registration is re-entered in the body of the sequence rather than through its
		// guarded entry point, because this cycle already holds the one cycle flag — and the
		// sequence, not the poll, is what arms the next attempt. One timer per cycle, not two:
		// the poll used to start the registration un-awaited *and* schedule for itself, which
		// announced two next polls and left the second chain racing the first.
		it("comes back for it, and re-enters registration, when registering is automatic", async () => {
			const adapter = makeAdapter({
				config: { openapi_register_automatically: true },
				// The appliance is simply not up yet — the state this whole branch exists for.
				openapiClient: appliance(
					() => answers({}),
					() => Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:4424"), { code: "ECONNREFUSED" }),
				),
			});
			// Configured, so the registration really runs rather than declining at the address
			// check; the counter still says whether the sequence was entered.
			adapter.localHostConfigured = () => {
				adapter.initEntries++;
				return true;
			};

			await openapi.openapiPoll(adapter);

			assert.equal(lastWrite(adapter, "_openapi.info.approvalState"), "unregistered");
			assert.equal(adapter.initEntries, 1, "the registration itself has to be attempted again");
			assert.ok(
				adapter.logs.some(([, msg]) => /Registering as/.test(msg)),
				"and really attempted: the re-entry is the registration sequence, not another read",
			);
			assert.equal(
				adapter.armed.length,
				1,
				`a poll has to stay armed, and exactly one — was ${adapter.armed.join(" and ")}`,
			);
			assert.ok(
				adapter.armed[0] >= 10000 && adapter.armed[0] <= 15 * 60 * 1000,
				`and it comes back within the retry's own bounds — was ${adapter.armed[0]}`,
			);
			assert.equal(
				adapter.logs.filter(([, msg]) => /Next local OpenAPI poll/.test(msg)).length,
				1,
				"announced once: the sequence and the poll that re-entered it are one cycle, not two",
			);
		});

		// With automatic registration off, registering is the user's job — so nothing registers
		// behind their back. The chain still stays alive: the Register button mints the token, and
		// a poll chain that had stopped would never report what it produced.
		it("comes back for the token, but registers nothing, when registering is the user's job", async () => {
			const adapter = makeAdapter({
				config: { openapi_register_automatically: false },
				openapiClient: appliance(() => answers({})),
			});

			await openapi.openapiPoll(adapter);

			assert.equal(lastWrite(adapter, "_openapi.info.approvalState"), "unregistered");
			assert.deepEqual(adapter.armed, [60000], "one poll stays armed, at the flat interval");
			assert.equal(adapter.initEntries, 0, "and nothing registers behind the user's back");
			assert.deepEqual(
				adapter.openapiClient.calls,
				[],
				"nor is the appliance asked anything: there is no token to ask about",
			);
		});
	});

	describe("the one poll timer", () => {
		// Polling is re-entered from the Admin buttons as well, so two chains against the same
		// appliance is a real state to get into — and once in it, it lasts for the life of the
		// instance. Every scheduling point therefore replaces the pending timer rather than
		// arming a second one.
		it("is replaced rather than stacked, so exactly one poll is ever pending", async () => {
			const adapter = makeAdapter({
				// An unreadable token state: reported, rescheduled, and nothing else.
				getStateAsync: async () => {
					throw new Error("state store unavailable");
				},
			});

			await openapi.openapiPoll(adapter);
			assert.equal(adapter.timers.length, 1);
			assert.equal(adapter.cleared, 0, "nothing to replace yet");

			await openapi.openapiPoll(adapter);
			assert.equal(adapter.cleared, 1, "the pending one is cleared before the next is armed");
			assert.equal(adapter.timers.length, 1, "and exactly one is left pending");
			assert.equal(adapter.timers[0], adapter.openapiPollTimer, "the handle the adapter holds is that one");
		});

		it("arms nothing, and says nothing, once the adapter is unloading", async () => {
			const adapter = makeAdapter();
			adapter.getStateAsync = async () => {
				// Teardown while the cycle is between its own unload checks.
				adapter.unloaded = true;
				throw new Error("state store unavailable");
			};

			await openapi.openapiPoll(adapter);

			assert.deepEqual(adapter.timers, [], "a stopping adapter must not be left holding a timer");
			assert.deepEqual(adapter.armed, []);
			assert.ok(
				!adapter.logs.some(([, msg]) => /Next local OpenAPI poll/.test(msg)),
				"and must not announce a poll it did not schedule",
			);
		});
	});

	describe("the connection indicator", () => {
		// Written through one helper precisely so the five hand-written copies that preceded it
		// cannot disagree — and only on a change, because every exit from the poll writes it.
		it("is published only when it changes", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => answers({ stateOfCharge: 47 })),
			});

			await openapi.openapiPoll(adapter);
			assert.equal(adapter.openapiConnected, true);
			assert.equal(adapter.statusWrites, 1, "disconnected → connected is a change");

			await openapi.openapiPoll(adapter);
			assert.equal(adapter.statusWrites, 1, "a second successful cycle changes nothing");

			adapter.openapiClient = appliance(() => Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
			await openapi.openapiPoll(adapter);
			assert.equal(adapter.openapiConnected, false);
			assert.equal(adapter.statusWrites, 2, "and losing it is a change again");
		});
	});

	describe("the bounded approval rounds", () => {
		// The budget turns on one distinction, and both sides of it are a real failure that
		// shipped. A refusal that cannot improve on its own has to count, or the attempt is
		// repeated once per interval for the life of the process: measured at ten real
		// mein-senec.de sign-ins over ten cycles with the counter still at zero, which is 8640
		// a day at the minimum interval and is how an account gets rate-limited. A refusal that
		// does improve on its own must not count, or a cloud side that was merely slow to start
		// burned the whole budget in three intervals and nothing tried again until a restart.
		it("stops asking once a refusal that cannot improve has spent the rounds", async () => {
			const adapter = makeAdapter({
				// No account credentials at all: openapiPortalReady refuses before it reaches
				// the portal, and nothing but the user entering them changes that.
				config: { openapi_auto_approve: true },
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => refuses(511)),
			});

			for (let cycle = 0; cycle < 4; cycle++) {
				await openapi.openapiPoll(adapter);
			}

			assert.equal(adapter.openapiApproveAttempts, 3, "the rounds are spent, so the asking stops");
			assert.equal(
				adapter.logs.filter(([, msg]) => /Not approving automatically/.test(msg)).length,
				3,
				"and the fourth cycle does not try at all — an unbounded retry is what locks an account out",
			);
			assert.ok(
				adapter.logs.some(([, msg]) => /no SENEC account credentials/.test(msg)),
				"the refusal counted is the kind that asking again cannot change",
			);
		});

		// The other side of the same distinction: the mein-senec.de connector owns the session
		// when it is enabled, and until it has signed in there is nothing to borrow. That is a
		// startup order rather than a configuration fault, and it resolves by waiting.
		it("spends no round while the refusal is one that passes on its own", async () => {
			const adapter = makeAdapter({
				config: {
					openapi_auto_approve: true,
					web_use: true,
					api_mail: "a@b.c",
					api_pwd: "x",
				},
				webAuthenticated: false,
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => refuses(511)),
			});

			for (let cycle = 0; cycle < 4; cycle++) {
				await openapi.openapiPoll(adapter);
			}

			assert.equal(adapter.openapiApproveAttempts, 0, "a wait is not a refusal, so no round is spent");
			assert.equal(
				adapter.logs.filter(([, msg]) => /Not approving automatically/.test(msg)).length,
				4,
				"so every cycle is still willing to try",
			);
			assert.ok(
				adapter.logs.some(([, msg]) => /has not established its session yet/.test(msg)),
				"and the refusal left free is the transient one",
			);
		});

		it("gives the rounds and the backoff back once the appliance answers", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => answers({ stateOfCharge: 47 })),
				openapiApproveAttempts: 3,
				openapiTransportFailures: 2,
				loggedConditions: new Set(["openapi-transport:ECONNREFUSED"]),
			});

			await openapi.openapiPoll(adapter);

			assert.equal(lastWrite(adapter, "_openapi.info.approvalState"), "approved");
			assert.equal(adapter.openapiApproveAttempts, 0, "a later pending state gets its attempts back");
			assert.equal(adapter.openapiTransportFailures, 0, "and the interval its normal length");
			assert.equal(
				adapter.loggedConditions.has("openapi-transport:ECONNREFUSED"),
				false,
				"the next outage is reported rather than deduplicated against the one that is over",
			);
		});
	});

	describe("what the appliance's refusals mean", () => {
		// 511 is "registered, waiting for the account holder", which the adapter cannot be told
		// about any other way — so the chain stays alive.
		it("takes 511 as pending and keeps polling", async () => {
			const adapter = makeAdapter({
				config: { openapi_auto_approve: false },
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => refuses(511)),
			});

			await openapi.openapiPoll(adapter);

			assert.equal(lastWrite(adapter, "_openapi.info.approvalState"), "pending");
			assert.deepEqual(adapter.armed, [60000], "approval happens in the portal, so keep asking");
			assert.ok(
				adapter.logs.some(([, msg]) => /senec-open-api/.test(msg)),
				"and the log carries the approval link while it waits",
			);
		});

		// 401 is indistinguishable from a revocation, and nothing changes until the user acts.
		// Retrying it on a timer would ask a question with a known answer once a minute forever.
		it("takes a confirmed 401 as terminal and arms no timer", async () => {
			await withoutWaiting(async () => {
				const adapter = makeAdapter({
					getStateAsync: tokenStored(),
					openapiClient: appliance(() => refuses(401)),
				});

				await openapi.openapiPoll(adapter);

				assert.equal(lastWrite(adapter, "_openapi.info.approvalState"), "rejected");
				assert.ok(
					adapter.openapiClient.calls.length >= 2,
					"the refusal is confirmed on a second look before it is believed",
				);
				assert.deepEqual(adapter.armed, [], "nothing changes until the user acts");
				assert.deepEqual(
					adapter.waited,
					[3000],
					"and it waits the confirmation delay once — pinned so the constant cannot drift " +
						"or be swapped with the approval one",
				);
			});
		});

		// The appliance's view of a token follows the portal's through the cloud, and a restarting
		// appliance answers 401 before its token store is loaded. Believing the first one stopped
		// the connector until someone pressed a button.
		it("reports a 401 the second look cleared as approved, and reads again straight away", async () => {
			await withoutWaiting(async () => {
				const adapter = makeAdapter({
					getStateAsync: tokenStored(),
					// Refused once, accepted on the confirming look.
					openapiClient: appliance((_path, call) =>
						call === 1 ? refuses(401) : answers({ stateOfCharge: 47 }),
					),
				});

				await openapi.openapiPoll(adapter);

				assert.equal(
					lastWrite(adapter, "_openapi.info.approvalState"),
					"approved",
					"leaving the previous verdict standing would say 'rejected' for a whole interval",
				);
				assert.deepEqual(adapter.armed, [1000], "and the data this cycle did not fetch is read at once");
				assert.ok(
					!adapter.logs.some(([, msg]) => /Next local OpenAPI poll/.test(msg)),
					"the immediate re-read is quiet; it is not a scheduling decision worth announcing",
				);
			});
		});
	});

	describe("a certificate that names another appliance", () => {
		/**
		 * A response whose socket presents a certificate naming an appliance.
		 *
		 * @param {string} cn - Common name of the certificate subject
		 * @returns {object} A 200 with the certificate reachable off its socket
		 */
		const presenting = (cn) => ({
			status: 200,
			data: JSON.stringify({ stateOfCharge: 47 }),
			request: { socket: { getPeerCertificate: () => ({ raw: Buffer.from("other"), subject: { CN: cn } }) } },
		});

		// Two devices in one instance would attribute one appliance's readings to the other, so
		// the cycle stops. The indicator has to stop with it: returning without clearing it left
		// the connector reported as connected while it had in fact given up.
		it("stops the cycle and takes the connection indicator down with it", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiExpectedDeviceId: "209719282544",
				openapiConnected: true,
				openapiClient: appliance(() => presenting("S999999999999")),
			});

			await openapi.openapiPoll(adapter);

			assert.equal(adapter.openapiIdentityMismatch, true);
			assert.equal(adapter.openapiConnected, false, "a connector that has stopped is not connected");
			assert.equal(adapter.statusWrites, 1, "and says so once");
			assert.deepEqual(adapter.polled, [], "nothing of the wrong appliance's reading is published");
			assert.deepEqual(adapter.armed, [], "and it is not retried: a configuration error does not pass");
		});

		it("does not poll at all while that mismatch stands", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiIdentityMismatch: true,
				openapiConnected: true,
				openapiClient: appliance(() => answers({ stateOfCharge: 47 })),
			});

			await openapi.openapiPoll(adapter);

			assert.deepEqual(adapter.openapiClient.calls, [], "the token is not offered to an unidentified peer");
			assert.equal(adapter.openapiConnected, false);
			assert.deepEqual(adapter.armed, []);
		});
	});

	describe("an appliance that cannot be reached", () => {
		/** The floor and the ceiling the retry is held between, whatever the jitter samples. */
		const FLOOR_MS = 10 * 1000;
		const CEILING_MS = 15 * 60 * 1000;

		/**
		 * The delay one failing cycle arms, with the real jitter rather than a pinned one.
		 *
		 * The failure count is seeded one short of the number under test, because the cycle's own
		 * failure makes it up — which is also the only way to reach the delay at all, since the
		 * helper that computes it is deliberately not exported.
		 *
		 * @param {number} intervalSeconds - The configured poll interval
		 * @param {number} failures - Consecutive failures the delay is to be computed for
		 * @returns {Promise<number>} The delay the cycle armed
		 */
		async function retryDelay(intervalSeconds, failures) {
			const adapter = makeAdapter({
				config: { openapi_interval: intervalSeconds },
				getStateAsync: tokenStored(),
				openapiTransportFailures: failures - 1,
				openapiClient: appliance(() => Object.assign(new Error("timeout"), { code: "ECONNABORTED" })),
			});

			await openapi.openapiPoll(adapter);

			assert.equal(adapter.armed.length, 1, "one failing cycle arms one retry");
			return adapter.armed[0];
		}

		/**
		 * @param {number} intervalSeconds - The configured poll interval
		 * @param {number} failures - Consecutive failures the delays are to be computed for
		 * @param {number} [count] - How many samples to draw
		 * @returns {Promise<number[]>} That many independently jittered delays
		 */
		async function sampleDelays(intervalSeconds, failures, count = 200) {
			const samples = [];
			for (let draw = 0; draw < count; draw++) {
				samples.push(await retryDelay(intervalSeconds, failures));
			}
			return samples;
		}

		/**
		 * @param {number[]} samples - Delays drawn
		 * @returns {number} The middle one
		 */
		const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

		/**
		 * @param {number[]} samples - Delays drawn
		 * @returns {string} Their range, for a failure message a human can read
		 */
		const spread = (samples) => `${samples.length} draws spanning ${Math.min(...samples)}–${Math.max(...samples)}`;

		// An appliance that is switched off is a condition, not an event: it produced one error
		// line per cycle, 1440 a day at the default interval, which buries every other
		// connector's diagnostics. Said once, then retried on the shared backoff.
		it("says so once rather than once per cycle", async () => {
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiClient: appliance(() =>
					Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
				),
			});

			await openapi.openapiPoll(adapter);
			await openapi.openapiPoll(adapter);

			const errors = adapter.logs.filter(([level]) => level === "error");
			assert.equal(errors.length, 1, "the second failure of the same kind is a debug line");
			assert.ok(
				adapter.logs.some(([level, msg]) => level === "debug" && /failed again/.test(msg)),
				"but it is still recorded, at a level that does not shout",
			);
			assert.equal(adapter.openapiTransportFailures, 2);
			assert.equal(adapter.armed.length, 2, "and each cycle arms exactly one retry");
		});

		// The backoff applies full jitter, which is a uniform draw over the whole window — so
		// "the retry grew" is not a property of any one sample and a test that pins Math.random
		// to 0.9 proves only that 0.9 is large. What holds for every sample is the floor: without
		// it, at the minimum interval, half of all draws came back sooner than the interval the
		// user configured, and a draw near zero came back at once.
		it("never comes back sooner than the floor, whatever the jitter", async () => {
			// At the minimum interval the first failure's window is 0–20s, so half of it lies
			// below the floor: a missing floor shows up within a handful of draws.
			const samples = await sampleDelays(10, 1);

			assert.ok(Math.min(...samples) >= FLOOR_MS, `every retry waits at least the floor — ${spread(samples)}`);
			assert.ok(
				samples.includes(FLOOR_MS),
				"and the floor is what holds them there, rather than the arithmetic never going low",
			);
			assert.ok(Math.max(...samples) < 20000, "while the window itself is still the jittered one");
		});

		it("never comes back later than the ceiling, whatever the jitter", async () => {
			// A day-long interval with ten failures behind it: the unbounded window would be
			// weeks, so all but a vanishing fraction of draws land on the ceiling.
			const samples = await sampleDelays(86400, 10);

			assert.ok(Math.max(...samples) <= CEILING_MS, `a long outage is still asked about — ${spread(samples)}`);
			assert.ok(samples.includes(CEILING_MS), "and the ceiling is what holds them there");
		});

		// What the growth really means with full jitter: the window widens, so the distribution
		// moves up even though individual draws cross over.
		it("waits longer the more cycles have failed in a row", async () => {
			const early = median(await sampleDelays(60, 1));
			const late = median(await sampleDelays(60, 6));

			assert.ok(
				late >= 2 * early,
				`a longer outage is asked about less often — ${early} then ${late} at the median`,
			);
			assert.ok(early >= FLOOR_MS && late <= CEILING_MS, "and both stay between the floor and the ceiling");
		});
	});

	// `main.js`'s delay() parks its resolver and onUnload wakes every parked waiter, precisely so
	// a cycle caught mid-wait still unwinds. Modelled here the way the real pair behaves: the
	// wait does not settle on its own, and teardown is what releases it.
	describe("a wait released by teardown rather than by its timer", () => {
		it("unwinds through its finally, so the cycle flag is not left set", async () => {
			let wake = null;
			const adapter = makeAdapter({
				getStateAsync: tokenStored(),
				openapiClient: appliance(() => refuses(401)),
			});
			// The real delay() resolves from either the timer or onUnload's drain; this one only
			// ever from the drain, which is the case that used to strand the caller for ever.
			adapter.delay = () =>
				new Promise((resolve) => {
					wake = () => {
						adapter.unloaded = true;
						resolve(undefined);
					};
				});

			const cycle = openapi.openapiPoll(adapter);
			await new Promise((resolve) => setImmediate(resolve));

			assert.ok(wake, "the cycle reaches the confirmation wait");
			assert.equal(adapter.openapiCycleRunning, true, "and holds the one-cycle flag while it waits");

			wake();
			await cycle;

			assert.equal(
				adapter.openapiCycleRunning,
				false,
				"a woken wait returns through the finally that releases the flag",
			);
		});
	});

	describe("teardown in the middle of a cycle", () => {
		// Writes that land after onUnload has run write into an adapter that is already gone, and
		// a timer armed then outlives the instance.
		it("writes no state and leaves no timer behind once the adapter is unloading", async () => {
			const adapter = makeAdapter({ getStateAsync: tokenStored() });
			adapter.openapiClient = appliance(() => {
				adapter.unloaded = true;
				return answers({ stateOfCharge: 47 });
			});

			await openapi.openapiPoll(adapter);

			assert.deepEqual(adapter.polled, [], "the section that arrived during teardown is dropped");
			assert.deepEqual(adapter.states, [], "nothing is written into an adapter that has stopped");
			assert.deepEqual(adapter.armed, [], "and nothing is armed to fire after it");
			assert.equal(adapter.openapiCycleRunning, false, "the cycle flag is released whatever happened");
		});
	});

	describe("openapiInit", () => {
		// A failed read is not an unregistered instance. Registering on one mints a second portal
		// entry while the first is still live and holding the token the read failed to produce —
		// and nothing can tell two entries of the same name apart afterwards.
		it("does not register on a token it could not read, but comes back for it", async () => {
			const adapter = makeAdapter({
				config: { openapi_register_automatically: true },
				localHostConfigured: () => true,
				getStateAsync: async () => {
					throw new Error("state store unavailable");
				},
				openapiClient: appliance(() => answers({})),
			});

			await openapi.openapiInit(adapter);

			assert.deepEqual(adapter.armed, [60000], "it tries again on the next cycle");
			assert.ok(
				adapter.logs.some(([level, msg]) => level === "error" && /could not be read/.test(msg)),
				"and says why it did not register",
			);
			assert.ok(
				!adapter.logs.some(([, msg]) => /Registering as/.test(msg)),
				"a second registration would be indistinguishable from the first",
			);
		});
	});

	// The poll and the registration sequence call each other: a poll that finds no token hands
	// over to the registration, and the registration finishes by reading. Each direction is
	// bounded by an argument — `thenPoll` on the way in, `mayRegister` on the way back — and
	// with neither of them the pair recursed until the V8 heap was gone, minting a portal entry
	// per turn. The appliance double here refuses a fourth registration rather than letting a
	// regression take the suite down with it.
	describe("the hand-over between polling and registering", () => {
		/**
		 * An instance whose token never reads back, which is the condition that keeps the
		 * no-token branch reachable from inside the registration sequence.
		 *
		 * @param {object} [over] - Overrides merged over the defaults
		 * @returns {{adapter: object, registrations: () => number}} The double and its counter
		 */
		function neverReadsBack(over = {}) {
			let registrations = 0;
			const adapter = makeAdapter({
				config: { openapi_register_automatically: true, openapi_auto_approve: false, ...(over.config || {}) },
				// Deliberately not tokenStored(): the registration stores a token through doState,
				// which this double does not feed back into getStateAsync.
				getStateAsync: async () => null,
				openapiClient: appliance(
					() => refuses(401),
					() => {
						registrations++;
						if (registrations > 3) {
							throw new Error(`registration ${registrations}: the hand-over is unbounded`);
						}
						return { status: 200, data: STORED_TOKEN };
					},
				),
				...over,
			});
			adapter.localHostConfigured = () => {
				adapter.initEntries++;
				return true;
			};
			return { adapter, registrations: () => registrations };
		}

		// Entered from the registration sequence's own closing read. That read finds no token —
		// the token it just stored did not read back — and must not conclude that this instance
		// is unregistered and register a second time.
		it("does not register again when the sequence's closing read finds no token", async () => {
			const { adapter, registrations } = neverReadsBack();

			await withoutWaiting(() => openapi.openapiInit(adapter));

			assert.equal(
				registrations(),
				1,
				"one portal entry, not one per turn: nothing afterwards can tell two of the same name apart",
			);
			assert.equal(adapter.initEntries, 1, "and the registration sequence runs once");
			assert.equal(
				adapter.armed.length,
				1,
				`while the chain stays alive, with exactly one poll pending — was ${adapter.armed.join(" and ")}`,
			);
		});

		// Entered from a timer poll that found nothing stored. The registration succeeds, so the
		// connector now holds a token it has never read with — and the only thing that will bring
		// it back to read is a poll this cycle leaves armed.
		it("registers once, and leaves a poll armed, when a timer poll finds no token", async () => {
			const { adapter, registrations } = neverReadsBack();

			await withoutWaiting(() => openapi.openapiPoll(adapter));

			assert.equal(registrations(), 1, "the hand-over mints one portal entry");
			assert.equal(adapter.initEntries, 1, "and enters the registration sequence once");
			assert.equal(
				adapter.armed.length,
				1,
				`a successful registration has to leave the chain alive — was ${adapter.armed.length} armed`,
			);
		});
	});

	// The withdraw path is the one place where "the portal does not list this registration" has
	// to be read differently depending on how the plant was arrived at — which is what the
	// `verified` flag openapiPortalReady now returns is for. A plant typed into the Admin field
	// is authoritative for building the approval link, but nothing has checked it against this
	// appliance, so an empty list there means "we looked in the wrong place".
	describe("withdrawing the registration in the portal", () => {
		/**
		 * openapi-client with the portal answering an empty registration list.
		 *
		 * The session rules are not what is under test here, so the session is simply granted;
		 * `test/testPureFunctions.js` is where acquiring it is pinned.
		 *
		 * @returns {object} The module, with its portal calls stubbed
		 */
		function withEmptyPortal() {
			return proxyquire("../lib/openapi-client.js", {
				"./web-client.js": {
					webAcquireSession: async () => ({ ok: true, borrowed: false }),
					webReleaseSession: () => {},
					webGet: async () => ({ data: [] }),
					webPost: async () => ({ status: 200, data: "" }),
				},
			});
		}

		it("reports an empty list on a verified plant as the entry being gone", async () => {
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x" },
				getStateAsync: tokenStored(),
				// Matched on this appliance's own control-unit number, so the plant is established.
				openapiExpectedDeviceId: "209719282544",
				webMasterPlantNumber: 0,
				webMasterPlantSerial: "st_209719282544",
				webSecondaryPlants: new Map(),
			});

			assert.equal(await withEmptyPortal().openapiForgetToken(adapter), "absent");
			assert.ok(
				adapter.logs.some(([, msg]) => /no longer lists this registration/.test(msg)),
				"having looked and found none saves the user a trip to the portal",
			);
		});

		it("will not call an empty list on a plant nobody verified the entry being gone", async () => {
			const adapter = makeAdapter({
				config: { api_mail: "a@b.c", api_pwd: "x", openapi_plant: "1" },
				getStateAsync: tokenStored(),
				openapiExpectedDeviceId: null,
				webMasterPlantNumber: null,
				webMasterPlantSerial: null,
				webSecondaryPlants: new Map(),
			});

			assert.equal(
				await withEmptyPortal().openapiForgetToken(adapter),
				"unknown",
				"we may simply have looked at the wrong plant of the account",
			);
			assert.ok(
				adapter.logs.some(([, msg]) => /could not be confirmed to hold this appliance/.test(msg)),
				"and the user is told the entry may still be there",
			);
		});
	});
});
