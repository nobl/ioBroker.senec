"use strict";

/**
 * The four sendTo handlers behind the Local OpenAPI buttons in Admin.
 *
 * They are the only paths by which a user can reach into the portal side of this connector, and
 * what each one is allowed to do while the connector is switched off is a decision, not an
 * oversight:
 *
 * - **Register** and **Check approval** are gated on `openapi_use`. A panel Admin happens to be
 *   showing is not an authorization check, and registering puts an entry into the user's SENEC
 *   account that only they can remove.
 * - **Discard the token** is deliberately *not* gated. It is the only action that withdraws that
 *   entry again, so gating it meant switching the connector off made a granted registration —
 *   and the appliance token behind it — impossible to clean up from the UI. The re-registration
 *   that follows a discard stays gated, so discarding while the connector is off discards and
 *   stops there.
 *
 * Also pinned here: the lock that keeps two registrations from overlapping (two entries of the
 * same name cannot be told apart afterwards), the rule that a withdrawal of "unknown" must not
 * be followed by a fresh registration, and onMessage's guarantee that a button always gets an
 * answer — Admin spins until it gives up otherwise, with nothing to show the user.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const openapiLib = require("../lib/openapi-client.js");

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
 * Replace the named module functions for the duration of a call.
 *
 * main.js reaches the connector through the module object — `openapiClientLib.openapiRegister`
 * and friends — so substituting the exports is what lets a handler be driven without an
 * appliance or a portal behind it.
 *
 * @param {object} module - Module whose exports are substituted
 * @param {Record<string, Function>} stubs - Replacements keyed by export name
 * @param {() => Promise<any>} body - Work to run
 * @returns {Promise<any>} Result of body
 */
async function withStubs(module, stubs, body) {
	const originals = {};
	for (const [name, fn] of Object.entries(stubs)) {
		originals[name] = module[name];
		module[name] = fn;
	}
	try {
		return await body();
	} finally {
		for (const [name, fn] of Object.entries(originals)) {
			module[name] = fn;
		}
	}
}

/**
 * Build an adapter whose replies, logs and connection updates are recorded.
 *
 * @param {object} [over] - Overrides; `config` is merged over the defaults rather than replacing them
 * @returns {object} Adapter instance
 */
function makeAdapter(over = {}) {
	const adapter = mainExport({});
	adapter.namespace = "senec.0";
	adapter.unloaded = false;
	adapter.logs = [];
	adapter.sent = [];
	adapter.cleared = [];
	adapter.statusWrites = 0;
	adapter.log = {
		info: (msg) => adapter.logs.push(["info", msg]),
		warn: (msg) => adapter.logs.push(["warn", msg]),
		error: (msg) => adapter.logs.push(["error", msg]),
		debug: (msg) => adapter.logs.push(["debug", msg]),
		silly: () => {},
	};
	adapter.localHostConfigured = () => true;
	adapter.updateConnectionStatus = async () => {
		adapter.statusWrites++;
	};
	adapter.clearTimeout = (handle) => adapter.cleared.push(handle);
	adapter.setTimeout = (fn, ms) => ({ fn, ms });
	adapter.sendTo = (from, command, payload, callback) => adapter.sent.push({ from, command, payload, callback });
	adapter.getForeignObjectAsync = async () => ({ common: { language: "en" } });

	Object.assign(adapter, over);
	adapter.config = {
		openapi_use: true,
		senecip: "192.0.2.1",
		openapi_device_name: "ioBroker",
		...(over.config || {}),
	};
	return adapter;
}

/** @returns {{replies: unknown[], reply: (payload: unknown) => void}} A reply sink. */
function sink() {
	const replies = [];
	return { replies, reply: (payload) => replies.push(payload) };
}

/**
 * The translator the handlers are given, answering with the key itself.
 *
 * A reply can then be asserted by the name of the text it carries rather than by a sentence
 * that belongs to admin/i18n and changes with it.
 *
 * @param {string} key - Translation key
 * @returns {Promise<string>} The key
 */
const say = async (key) => key;

/** @returns {Promise<string>} No caveat; openapiApprovalUrl's own tests cover the hint. */
const noHint = async () => "";

/**
 * A stub that fails the test if anything reaches it.
 *
 * @param {string} what - What this test says must not be called
 * @returns {() => never} The stub to put in its place
 */
const forbidden = (what) => () => {
	throw new Error(`${what} must not be called here`);
};

describe("local OpenAPI: the sendTo handlers", () => {
	describe("the openapi_use gate", () => {
		it("will not register while the connector is switched off", async () => {
			const adapter = makeAdapter({ config: { openapi_use: false } });
			const { replies, reply } = sink();

			await withStubs(
				openapiLib,
				{
					withOpenapiRegistration: forbidden("the registration lock"),
					openapiRegister: forbidden("openapiRegister"),
				},
				() => adapter.dispatchMessage({ command: "openapiRegister" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyNotEnabled" }]);
		});

		it("will not check the approval while the connector is switched off", async () => {
			const adapter = makeAdapter({ config: { openapi_use: false } });
			const { replies, reply } = sink();

			await withStubs(openapiLib, { openapiCheckToken: forbidden("openapiCheckToken") }, () =>
				adapter.dispatchMessage({ command: "openapiCheckApproval" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyNotEnabled" }]);
		});

		// The one that must NOT be gated. Switching the connector off left a granted entry in the
		// user's SENEC account and an appliance token in the state tree, with no way to remove
		// either from the UI — and this is the only action that withdraws them.
		it("still discards the token while the connector is switched off", async () => {
			const adapter = makeAdapter({
				config: { openapi_use: false, openapi_register_automatically: true },
				openapiConnected: true,
				openapiPollTimer: { armed: true },
			});
			const { replies, reply } = sink();
			let forgotten = 0;
			let reinitialised = 0;

			await withStubs(
				openapiLib,
				{
					openapiForgetToken: async () => {
						forgotten++;
						return "revoked";
					},
					openapiInit: async () => {
						reinitialised++;
					},
				},
				() => adapter.dispatchMessage({ command: "openapiForgetToken" }, reply, say, noHint),
			);

			assert.equal(forgotten, 1, "withdrawing a leftover portal registration has to stay possible");
			assert.deepEqual(replies, [{ result: "openapiReplyForgottenAndRevoked" }]);
			assert.equal(reinitialised, 0, "but registering again is not what was asked for");
			assert.deepEqual(adapter.cleared, [{ armed: true }], "the armed poll would write over the discard");
			assert.equal(adapter.openapiConnected, false);
			assert.equal(adapter.statusWrites, 1, "and the indicator says so");
		});
	});

	// The second gate, and not the same question as the first. The connector can be switched on
	// while the appliance address at the top of the Local Connection tab is still empty — it is a
	// different tab — and this connector has no address of its own: it uses that one. Registering
	// then would post to `https://undefined:4424`, and checking the approval would present the
	// stored token to whatever answers there. Both refuse and say which field is missing.
	describe("the configured-address gate", () => {
		it("will not register while no appliance address is configured", async () => {
			const adapter = makeAdapter({ localHostConfigured: () => false });
			const { replies, reply } = sink();

			await withStubs(
				openapiLib,
				{
					withOpenapiRegistration: forbidden("the registration lock"),
					openapiRegister: forbidden("openapiRegister"),
				},
				() => adapter.dispatchMessage({ command: "openapiRegister" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyNoAddress" }]);
		});

		it("will not check the approval while no appliance address is configured", async () => {
			const adapter = makeAdapter({ localHostConfigured: () => false });
			const { replies, reply } = sink();

			await withStubs(openapiLib, { openapiCheckToken: forbidden("openapiCheckToken") }, () =>
				adapter.dispatchMessage({ command: "openapiCheckApproval" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyNoAddress" }]);
		});

		// The other direction, so neither gate can be satisfied by refusing everything: with the
		// address configured, both reach the connector.
		it("lets both through once the address is configured", async () => {
			const adapter = makeAdapter({ localHostConfigured: () => true });
			let registered = 0;
			let checked = 0;

			await withStubs(
				openapiLib,
				{
					openapiReadTokenResult: async () => ({ ok: true, token: null }),
					openapiRegister: async () => {
						registered++;
						return { ok: true, token: "minted-token" };
					},
					openapiStoreToken: async () => {},
					openapiInit: async () => {},
					openapiCheckToken: async () => {
						checked++;
						return { state: "unregistered", status: null, message: "No token yet." };
					},
					openapiReportApproval: async () => {},
				},
				async () => {
					const first = sink();
					await adapter.dispatchMessage({ command: "openapiRegister" }, first.reply, say, noHint);
					const second = sink();
					await adapter.dispatchMessage({ command: "openapiCheckApproval" }, second.reply, say, noHint);
					// What each one then answers is its own business — the check reports whatever the
					// ladder said. Neither may be turned away for want of an address.
					for (const [name, replies] of [
						["register", first.replies],
						["check", second.replies],
					]) {
						assert.notEqual(
							replies[0].error,
							"openapiReplyNoAddress",
							`${name} was turned away for want of an address: ${JSON.stringify(replies[0])}`,
						);
					}
				},
			);

			assert.equal(registered, 1);
			assert.equal(checked, 1);
		});
	});

	describe("the registration lock", () => {
		// Every path that can create a portal entry takes the same lock, because each entry is
		// indistinguishable from another of the same name once it exists.
		it("answers busy rather than starting a second registration", async () => {
			const adapter = makeAdapter({ openapiBusy: true });
			const { replies, reply } = sink();

			await withStubs(
				openapiLib,
				{ openapiRegister: forbidden("openapiRegister"), openapiReadTokenResult: forbidden("the token read") },
				() => adapter.dispatchMessage({ command: "openapiRegister" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyBusy" }]);
		});

		// Discarding and registering are the same lock: a discard landing inside a registration
		// would throw the token away that the registration had just stored.
		it("answers busy rather than discarding under a running registration", async () => {
			const adapter = makeAdapter({ openapiBusy: true });
			const { replies, reply } = sink();

			await withStubs(openapiLib, { openapiForgetToken: forbidden("openapiForgetToken") }, () =>
				adapter.dispatchMessage({ command: "openapiForgetToken" }, reply, say, noHint),
			);

			assert.deepEqual(replies, [{ error: "openapiReplyBusy" }]);
		});
	});

	describe("registering again after a discard", () => {
		/**
		 * Drive the Forget button and report what followed.
		 *
		 * @param {object} adapter - Adapter double
		 * @param {"revoked" | "absent" | "unknown" | "none"} withdrawn - What became of the portal entry
		 * @returns {Promise<{replies: unknown[], reinitialised: number}>} Reply and whether init ran
		 */
		async function discard(adapter, withdrawn) {
			const { replies, reply } = sink();
			let reinitialised = 0;
			await withStubs(
				openapiLib,
				{
					openapiForgetToken: async () => withdrawn,
					openapiInit: async () => {
						reinitialised++;
					},
				},
				() => adapter.dispatchMessage({ command: "openapiForgetToken" }, reply, say, noHint),
			);
			return { replies, reinitialised };
		}

		// Automatic registration runs in onReady and nowhere else, and the Register button is
		// hidden while it is on — so without this, discarding a token left the connector dormant
		// until the next restart with no way to move it on.
		it("starts the sequence again once the old entry is known to be gone", async () => {
			const adapter = makeAdapter({ config: { openapi_register_automatically: true } });

			const { replies, reinitialised } = await discard(adapter, "revoked");

			assert.equal(reinitialised, 1);
			assert.deepEqual(replies, [
				{ result: "openapiReplyForgottenAndRevoked openapiReplyRegisteringAgain" },
				// Said in the same breath, so the reply does not stop at "forgotten" while a
				// registration is already under way.
			]);
		});

		// "Unknown" means the portal could not be asked, so the old entry may still be there.
		// Registering on top of it produces exactly the pair of indistinguishable entries this
		// flow exists to avoid — while the reply is telling the user to go and remove the old one.
		it("does not, when the portal could not be asked", async () => {
			const adapter = makeAdapter({ config: { openapi_register_automatically: true } });

			const { replies, reinitialised } = await discard(adapter, "unknown");

			assert.equal(reinitialised, 0);
			assert.deepEqual(replies, [{ result: "openapiReplyForgotten" }]);
		});

		it("does not, when registering is the user's job", async () => {
			const adapter = makeAdapter({ config: { openapi_register_automatically: false } });

			const { replies, reinitialised } = await discard(adapter, "revoked");

			assert.equal(reinitialised, 0);
			assert.deepEqual(replies, [{ result: "openapiReplyForgottenAndRevoked" }]);
		});

		// Having looked and found nothing is a different answer from "there may still be an
		// entry", and the one that saves the user a trip to the portal.
		it("says which of the four outcomes the discard had", async () => {
			for (const [withdrawn, key] of [
				["revoked", "openapiReplyForgottenAndRevoked"],
				["absent", "openapiReplyForgottenNoEntry"],
				["none", "openapiReplyNothingStored"],
				["unknown", "openapiReplyForgotten"],
			]) {
				const { replies } = await discard(makeAdapter(), withdrawn);
				assert.deepEqual(replies, [{ result: key }], withdrawn);
			}
		});
	});

	describe("onMessage", () => {
		// A button whose handler throws must still answer. Admin shows a spinner until the reply
		// arrives and then gives up with nothing to show, which reads as the adapter being broken
		// rather than as the one command having failed.
		it("always answers, even when the handler throws", async () => {
			const adapter = makeAdapter();

			await withStubs(
				openapiLib,
				{
					openapiListPlants: async () => {
						throw new Error("the portal is unreachable");
					},
				},
				() =>
					adapter.onMessage({
						command: "openapiListPlants",
						from: "system.adapter.admin.0",
						callback: { ack: false, id: 7 },
					}),
			);

			assert.equal(adapter.sent.length, 1, "exactly one answer, and there is one");
			assert.deepEqual(adapter.sent[0].payload, {
				error: "openapiListPlants failed: the portal is unreachable",
			});
			assert.ok(
				adapter.logs.some(([level, msg]) => level === "error" && /openapiListPlants failed/.test(msg)),
				"and the log carries it as a failure rather than only the dialog",
			);
		});

		// The answer goes back once, not twice: a handler that replied before throwing must not
		// have a second answer sent on top of its own.
		it("does not answer twice when a handler replies and then throws", async () => {
			const adapter = makeAdapter({ config: { openapi_use: false } });

			// The gate answers "not enabled" first; the throw comes afterwards, which is the
			// ordering the `answered` flag exists for.
			const gated = adapter.dispatchMessage.bind(adapter);
			adapter.dispatchMessage = async (obj, reply, sayFn, hint) => {
				await gated(obj, reply, sayFn, hint);
				throw new Error("after the reply");
			};
			await adapter.onMessage({
				command: "openapiRegister",
				from: "system.adapter.admin.0",
				callback: { ack: false, id: 8 },
			});

			// onMessage builds its own translator, so this reply carries the real sentence. What
			// matters is that it is the handler's own answer and not the catch-all's.
			assert.equal(adapter.sent.length, 1);
			assert.match(String(adapter.sent[0].payload.error), /not enabled/);
			assert.ok(
				!/after the reply/.test(String(adapter.sent[0].payload.error)),
				"the answer the handler already gave stands",
			);
		});

		it("says nothing at all to a message carrying no command", async () => {
			const adapter = makeAdapter();
			await adapter.onMessage({ from: "system.adapter.admin.0", callback: { ack: false, id: 9 } });
			assert.deepEqual(adapter.sent, []);
		});

		it("answers an unknown command rather than leaving the caller waiting", async () => {
			const adapter = makeAdapter();
			const { replies, reply } = sink();
			await adapter.dispatchMessage({ command: "somethingElse" }, reply, say, noHint);
			assert.deepEqual(replies, [{ error: "Unknown command: somethingElse" }]);
		});
	});
});
