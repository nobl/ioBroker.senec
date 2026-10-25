"use strict";

/**
 * Who owns the mein-senec.de session, and what happens when two things want it at once.
 *
 * The session is one shared pair — `adapter.webJar` and `adapter.webAuthenticated` — and
 * `webLogin` replaces the jar outright, so every one of these is a real defect rather than a
 * hypothetical:
 *
 * - two borrowers signing in at the same time left one of them holding the jar the other's login
 *   had already replaced, which the portal answers with its login page;
 * - a borrower that released while another was still working pulled the jar out from under an
 *   in-flight request;
 * - a release that arrived while the sign-in was still in flight tore down the very session the
 *   caller was about to use, because the borrow had not been counted yet;
 * - a failed sign-in that reported `borrowed: true` had its claim released twice — once by itself
 *   and once by the caller — which dropped the session a *different* borrower was holding;
 * - `webInit` reported a refused login by returning rather than throwing, so the caller's catch
 *   never ran, the retry was never armed, and anything waiting for that session waited for the
 *   life of the process.
 *
 * These drive the real exported functions, not a stand-in. `webLogin` is module-local — both
 * `webAcquireSession` and `webInit` call it directly rather than through `module.exports`, so
 * substituting the export would change nothing — but everything it touches outside the adapter
 * goes through `adapter.authClient`. That is the seam used here: a portal page carrying the
 * application's own markup and no login form is the "you are already signed in" answer and is the
 * shortest real route through `webLogin` to `true`; a page carrying neither is its route to
 * `false`. No socket is opened either way, which `test/mocha.setup.js` would refuse anyway.
 */

const assert = require("node:assert/strict");

const webClient = require("../lib/web-client.js");

/** The portal's own markup, which webLogin reads as an established session. */
const SIGNED_IN_PAGE = '<div ng-controller="DashboardCtrl"></div>';
/** Neither a login form nor the application: webLogin's route to a refusal. */
const UNUSABLE_PAGE = "service temporarily unavailable";

/** @returns {Promise<void>} Resolves on the next turn of the event loop. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Build an adapter whose only route outwards is a scripted `authClient`.
 *
 * @param {object} [over] - Overrides merged over the defaults; `config` is merged, not replaced
 * @returns {object} Adapter double
 */
function makeAdapter(over = {}) {
	const adapter = {
		unloaded: false,
		webAuthenticated: false,
		webJar: null,
		webSessionHolders: 0,
		webSessionLogin: null,
		webMasterPlantNumber: null,
		webMasterPlantSerial: "",
		webSecondaryPlants: new Map(),
		logs: [],
		/** How many login pages were asked for — one per sign-in actually attempted. */
		pageRequests: 0,
		/** What the next login page is to be. */
		page: SIGNED_IN_PAGE,
	};

	adapter.log = {
		info: (msg) => adapter.logs.push(["info", msg]),
		warn: (msg) => adapter.logs.push(["warn", msg]),
		error: (msg) => adapter.logs.push(["error", msg]),
		debug: (msg) => adapter.logs.push(["debug", msg]),
		silly: () => {},
	};
	adapter.logError = (e, prefix = "") => adapter.logs.push(["error", `${prefix}: ${e?.message ?? e}`]);
	adapter.doState = async () => {};
	adapter.evalPoll = async () => {};
	adapter.setTimeout = (fn, ms) => ({ fn, ms });
	adapter.clearTimeout = () => {};
	adapter.authClient = {
		// Answered a turn late on purpose: a sign-in that settles synchronously cannot be raced,
		// and racing it is the whole point of the cases below.
		get: async () => {
			adapter.pageRequests++;
			await tick();
			return { data: adapter.page };
		},
		post: async () => {
			throw new Error("the login form must not be posted to on this path");
		},
	};

	Object.assign(adapter, over);
	adapter.config = { api_mail: "a@b.c", api_pwd: "secret", web_use: false, ...(over.config || {}) };
	return adapter;
}

describe("the mein-senec.de session and who owns it", () => {
	describe("two borrowers at once", () => {
		// The defect: both signed in, and whichever login finished second replaced the jar the
		// other was already making requests with.
		it("sign in exactly once between them, and both owe a release", async () => {
			const adapter = makeAdapter();

			const [first, second] = await Promise.all([
				webClient.webAcquireSession(adapter, "errand A"),
				webClient.webAcquireSession(adapter, "errand B"),
			]);

			assert.equal(adapter.pageRequests, 1, "concurrent sign-ins collapse onto one login");
			assert.deepEqual(first, { ok: true, borrowed: true });
			assert.deepEqual(second, { ok: true, borrowed: true });
			assert.equal(adapter.webSessionHolders, 2, "two claims stand, so two releases are owed");
			assert.equal(adapter.webAuthenticated, true);
			assert.notEqual(adapter.webJar, null, "the one login built the one jar both of them use");
		});

		// A release is not the end of the session while somebody else is still holding it: dropping
		// the pair here empties the jar under a request another borrower has already queued.
		it("keeps the session up until the last of them gives it back", async () => {
			const adapter = makeAdapter();
			await Promise.all([
				webClient.webAcquireSession(adapter, "errand A"),
				webClient.webAcquireSession(adapter, "errand B"),
			]);
			const jar = adapter.webJar;

			webClient.webReleaseSession(adapter);

			assert.equal(adapter.webSessionHolders, 1);
			assert.equal(adapter.webAuthenticated, true, "the other borrower is still working");
			assert.equal(adapter.webJar, jar, "and still making requests with this jar");

			webClient.webReleaseSession(adapter);

			assert.equal(adapter.webSessionHolders, 0);
			assert.equal(adapter.webAuthenticated, false, "the last one out drops the session");
			assert.equal(adapter.webJar, null, "an instance that polls nothing keeps no session alive for nobody");
		});

		// The claim is taken before the login is awaited, which is what makes a release landing
		// mid-login harmless. Counting it afterwards instead let that release see a count of zero,
		// run the last-one-out branch, and null the jar the in-flight login had already built —
		// leaving the two borrowers authenticated with no cookies.
		it("counts the borrow before the login is awaited, so a release mid-login cannot drop it", async () => {
			const adapter = makeAdapter();

			const borrowers = [
				webClient.webAcquireSession(adapter, "errand A"),
				webClient.webAcquireSession(adapter, "errand B"),
			];
			assert.equal(adapter.webSessionHolders, 2, "both claims stand before either login has resolved");

			// Somebody else's release, arriving while the sign-in is still in flight.
			webClient.webReleaseSession(adapter);

			const results = await Promise.all(borrowers);

			assert.deepEqual(
				results.map((r) => r.ok),
				[true, true],
			);
			assert.equal(adapter.webSessionHolders, 1);
			assert.equal(adapter.webAuthenticated, true);
			assert.notEqual(adapter.webJar, null, "the jar the login built has to survive that release");
		});
	});

	describe("while the mein-senec.de connector is enabled", () => {
		// That connector's own startup owns the session. Signing in alongside it is the two-jars
		// defect again, and there is no queue here — the caller is told to come back instead.
		it("refuses the borrow rather than racing the connector's login", async () => {
			const adapter = makeAdapter({ config: { web_use: true } });

			const session = await webClient.webAcquireSession(adapter, "errand A");

			assert.equal(session.ok, false);
			assert.equal(session.borrowed, false);
			assert.match(session.reason, /mein-senec\.de connector/);
			assert.equal(adapter.pageRequests, 0, "no second sign-in is attempted");
			assert.equal(adapter.webSessionHolders, 0, "and nothing is owed");
		});

		it("uses the connector's session as it is, without owing a release", async () => {
			const adapter = makeAdapter({ config: { web_use: true }, webAuthenticated: true });

			const session = await webClient.webAcquireSession(adapter, "errand A");

			assert.deepEqual(session, { ok: true, borrowed: false });
			assert.equal(adapter.pageRequests, 0);
		});

		// The session is not the borrower's to drop: a release reaching the counter here would
		// clear the pair the connector itself is polling with.
		it("makes a release a no-op, so a stray one cannot drop the connector's session", async () => {
			const jar = { cookies: "the connector's" };
			const adapter = makeAdapter({
				config: { web_use: true },
				webAuthenticated: true,
				webSessionHolders: 1,
				webJar: jar,
			});

			webClient.webReleaseSession(adapter);

			assert.equal(adapter.webAuthenticated, true);
			assert.equal(adapter.webJar, jar, "the connector is still polling with this jar");
			assert.equal(adapter.webSessionHolders, 1, "and the counter is not the borrower's to touch");
		});
	});

	describe("a sign-in that failed", () => {
		// It releases its own claim, so it must not report one as owed: a caller that released
		// what it was told it borrowed would take the count down twice, dropping the session a
		// different borrower was still holding.
		it("gives its own claim back and reports nothing borrowed", async () => {
			const adapter = makeAdapter({ page: UNUSABLE_PAGE });

			const session = await webClient.webAcquireSession(adapter, "errand A");

			assert.equal(session.ok, false);
			assert.equal(session.borrowed, false, "a caller that released this too would release it twice");
			assert.match(session.reason, /logged in/);
			assert.equal(adapter.pageRequests, 1, "it did try, rather than refusing without looking");
			assert.equal(adapter.webSessionHolders, 0, "and left no claim standing");
			assert.equal(adapter.webAuthenticated, false);
			assert.equal(adapter.webJar, null);
		});

		// The single-flight promise is cleared whatever happened, or the first failure would be
		// handed to every later borrower for the life of the process.
		it("is attempted again by the next borrower rather than cached", async () => {
			const adapter = makeAdapter({ page: UNUSABLE_PAGE });

			const refused = await webClient.webAcquireSession(adapter, "errand A");
			assert.equal(refused.ok, false);
			assert.equal(adapter.webSessionLogin, null, "the collapsed sign-in is released whatever happened");

			adapter.page = SIGNED_IN_PAGE;
			const granted = await webClient.webAcquireSession(adapter, "errand B");

			assert.deepEqual(granted, { ok: true, borrowed: true });
			assert.equal(adapter.pageRequests, 2);
		});
	});

	describe("webInit", () => {
		// Thrown, not returned. The caller arms retryConnectorInit from its catch, so a bare
		// return left the retry unarmed: the connector was dead until the instance was restarted,
		// and anything waiting on the session waited for the life of the process.
		it("signals a refused login by throwing, so the caller's catch can arm the retry", async () => {
			const adapter = makeAdapter({
				page: UNUSABLE_PAGE,
				webMasterPlantNumber: 3,
				webMasterPlantSerial: "st_111111111111",
				webSecondaryPlants: new Map([["st_999999999999", { anlageNummer: 1, produktName: "old" }]]),
			});

			await assert.rejects(
				() => webClient.webInit(adapter),
				/login failed/,
				"a bare return here leaves the retry unarmed",
			);

			assert.equal(adapter.pageRequests, 1, "it stopped at the login rather than carrying on without one");
			// The inventory is rebuilt from scratch on every run, so the previous run's master must
			// not survive into this one — keeping the number while clearing the secondaries filed
			// plant 0 as a secondary next time and inflated the plant count other connectors read.
			assert.equal(adapter.webMasterPlantNumber, null);
			assert.equal(adapter.webMasterPlantSerial, "");
			assert.equal(adapter.webSecondaryPlants.size, 0);
		});
	});
});
