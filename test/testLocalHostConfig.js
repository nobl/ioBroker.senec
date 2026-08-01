"use strict";

/**
 * Regression tests for starting the local connector without a configured address.
 *
 * `senecip` used to ship as "0.0.0.0" with `lala_use` on, so a freshly created instance was
 * "local enabled, no address given" until the user typed an IP. Both defaults have since
 * changed — a new instance starts with no connector selected and an empty address field —
 * but the state itself remains reachable two ways: an existing instance created under the old
 * defaults still carries them, and a user can switch the connector on and save before
 * entering an address.
 *
 * negotiateLocalTls() already classified that state, treating an empty or 0.0.0.0 host as
 * unconfigured and returning without negotiating. The connector start ignored that judgement:
 * it called localCheckConnection() on the strength of lala_use alone, failed against
 * 0.0.0.0:443, and handed the failure to the retry loop, which then kept trying with growing
 * backoff and logged an error every cycle.
 *
 * Semantics pinned below:
 *   lala_use = false                         → "not configured", whatever the address field holds
 *   lala_use = true, IP or hostname          → unchanged connection and retry behaviour
 *   lala_use = true, "" or only whitespace   → warning, no connection, no retry
 *   lala_use = true, "0.0.0.0" (legacy)      → same, for instances predating the new default
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

const localClient = require("../lib/local-client");

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
 * Values that mean "the user has not given us an address".
 *
 * "0.0.0.0" is the legacy case: it was the shipped default until this change, so every
 * instance created before it and never configured still carries it.
 */
const UNCONFIGURED = ["", "   ", "0.0.0.0"];

/** Addresses a user could plausibly have entered. */
const CONFIGURED = ["192.0.2.1", "senec.fritz.box"];

/**
 * Replace module exports for the duration of a call.
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
 * Adapter instance with the local connector enabled.
 *
 * @param {string} senecip - Configured host
 * @returns {object} Adapter instance recording logs and timers
 */
function makeAdapter(senecip) {
	const adapter = mainExport({});
	adapter.namespace = "senec.0";
	adapter.unloaded = false;
	adapter.baseTime = 60000;
	adapter.lalaConnected = false;
	adapter.config = { lala_use: true, senecip, interval: 10 };
	adapter.logs = [];
	adapter.log = {
		info: (m) => adapter.logs.push(["info", m]),
		debug: () => {},
		warn: (m) => adapter.logs.push(["warn", m]),
		error: (m) => adapter.logs.push(["error", m]),
		silly: () => {},
	};
	adapter.logError = () => {};
	adapter.updateConnectionStatus = async () => {};
	adapter.scheduled = [];
	adapter.setTimeout = (fn, ms) => {
		adapter.scheduled.push(ms);
		return { fn, ms };
	};
	adapter.clearTimeout = () => {};
	return adapter;
}

/**
 * Stubs that fail loudly if the local connector reaches for the network.
 *
 * @param {string[]} calls - Array the stub names are recorded into
 * @returns {Record<string, Function>} Stubs
 */
function noNetworkStubs(calls) {
	return {
		localCheckConnection: async () => {
			calls.push("localCheckConnection");
		},
		localDiscoverSections: async () => calls.push("localDiscoverSections"),
		localInitPollSettings: async () => calls.push("localInitPollSettings"),
		localPoll: async () => calls.push("localPoll"),
	};
}

describe("shipped defaults for the local connector", () => {
	const ioPackage = require("../io-package.json");
	const jsonConfig = require("../admin/jsonConfig.json");

	/**
	 * Locate a setting anywhere in the nested jsonConfig tree.
	 *
	 * @param {object} node - Current node
	 * @param {string} key - Setting name
	 * @returns {object|null} The setting definition
	 */
	function findSetting(node, key) {
		if (!node || typeof node !== "object") {
			return null;
		}
		if (node.items && Object.prototype.hasOwnProperty.call(node.items, key)) {
			return node.items[key];
		}
		for (const value of Object.values(node)) {
			const hit = findSetting(value, key);
			if (hit) {
				return hit;
			}
		}
		return null;
	}

	it("does not enable local polling before anything has been configured", () => {
		// The adapter began as local-only, where enabling by default made sense. With four
		// connectors and a mandatory address it means a new instance is switched on for a
		// device nobody has named yet.
		assert.equal(ioPackage.native.lala_use, false);
	});

	it("keeps the admin field in step with the shipped default", () => {
		const field = findSetting(jsonConfig, "lala_use");
		assert.ok(field, "the setting must exist in the admin config");
		assert.equal(
			field.default,
			ioPackage.native.lala_use,
			"a field default that disagrees with io-package makes the UI lie about a new instance",
		);
	});

	it("ships an empty address rather than one that looks real", () => {
		// "0.0.0.0" reads like a host and invites a connection attempt; an empty field says
		// what is actually true, which is that nothing has been entered.
		assert.equal(ioPackage.native.senecip, "");
		assert.equal(findSetting(jsonConfig, "senecip").default, ioPackage.native.senecip);
	});

	it("still treats the old 0.0.0.0 default as unconfigured", () => {
		// Changing the shipped default only affects new instances. Anyone who created one
		// before this and never typed an address still carries "0.0.0.0" in their config.
		const adapter = makeAdapter("0.0.0.0");
		assert.equal(adapter.localHostConfigured(), false);
	});

	it("does not remove the enabled-but-unconfigured case", () => {
		// A user can still switch the connector on and save before typing an address, which
		// is precisely what the guard below covers.
		const adapter = makeAdapter("");
		adapter.config.lala_use = true;
		assert.equal(adapter.localHostConfigured(), false);
	});
});

describe("an instance with no connector enabled", () => {
	/**
	 * Adapter with every connector switched off, as a new instance now ships.
	 *
	 * @returns {object} Adapter instance
	 */
	function makeBareAdapter() {
		const adapter = makeAdapter("");
		adapter.config = { lala_use: false, api_use: false, web_use: false, connect_use: false };
		adapter.connectEnabled = false;
		adapter.apiConnected = false;
		adapter.webConnected = false;
		adapter.refreshGuiLangCache = async () => {
			throw new Error("nothing is connected, so there is no language cache to refresh");
		};
		return adapter;
	}

	it("warns rather than logging an error", async () => {
		// Since the defaults changed this is the deliberate starting state of every new
		// instance, not a fault: the user has simply not chosen connectors yet.
		const adapter = makeBareAdapter();

		await adapter.reportConnectorStatus();

		assert.ok(
			adapter.logs.some(([level, msg]) => level === "warn" && /no connectors/i.test(msg)),
			`expected a warning, got ${JSON.stringify(adapter.logs)}`,
		);
		assert.equal(
			adapter.logs.some(([level]) => level === "error"),
			false,
			"an unconfigured new instance is not an error condition",
		);
	});

	it("stays quiet when a connector is enabled but has not connected yet", async () => {
		// The connectors report their own failures; this is not a second place to do it.
		const adapter = makeBareAdapter();
		adapter.config.lala_use = true;

		await adapter.reportConnectorStatus();

		assert.deepEqual(adapter.logs, []);
	});

	it("refreshes the language cache once something is connected", async () => {
		const adapter = makeBareAdapter();
		adapter.config.lala_use = true;
		adapter.lalaConnected = true;
		let refreshed = false;
		adapter.refreshGuiLangCache = async () => {
			refreshed = true;
		};

		await adapter.reportConnectorStatus();

		assert.equal(refreshed, true);
		assert.deepEqual(adapter.logs, []);
	});

	it("still reports a genuine connection failure as an error", async () => {
		// The severity change applies to "nothing configured", not to a connector that was
		// configured and then failed.
		const adapter = makeAdapter("192.0.2.1");

		await withStubs(
			localClient,
			{
				...noNetworkStubs([]),
				localCheckConnection: async () => {
					throw new Error("connect ECONNREFUSED");
				},
			},
			() => adapter.startLocalConnector(),
		);

		assert.ok(
			adapter.logs.some(([level, msg]) => level === "error" && /Initial connection failed/i.test(msg)),
			"a configured device that refuses the connection is still an error",
		);
	});
});

describe("local connector without a configured address", () => {
	describe("startLocalConnector", () => {
		for (const senecip of UNCONFIGURED) {
			it(`attempts nothing for senecip=${JSON.stringify(senecip)}`, async () => {
				const adapter = makeAdapter(senecip);
				const calls = [];

				await withStubs(localClient, noNetworkStubs(calls), () => adapter.startLocalConnector());

				assert.equal(
					calls.includes("localCheckConnection"),
					false,
					"no connection may be attempted without an address",
				);
				assert.deepEqual(adapter.scheduled, [], "and no retry timer may be armed");
				assert.equal(adapter.lalaConnected, false);
			});

			it(`explains itself for senecip=${JSON.stringify(senecip)}`, async () => {
				const adapter = makeAdapter(senecip);

				await withStubs(localClient, noNetworkStubs([]), () => adapter.startLocalConnector());

				const warning = adapter.logs.find(([level, msg]) => level === "warn" && /no senec ip/i.test(msg));
				assert.ok(warning, `expected a clear warning, got: ${JSON.stringify(adapter.logs)}`);
				assert.equal(
					adapter.logs.some(([level]) => level === "error"),
					false,
					"a missing setting is a configuration gap, not a runtime error",
				);
			});
		}

		for (const senecip of CONFIGURED) {
			it(`behaves exactly as before with ${JSON.stringify(senecip)}`, async () => {
				const adapter = makeAdapter(senecip);
				const calls = [];

				await withStubs(
					localClient,
					{
						...noNetworkStubs(calls),
						localCheckConnection: async (a) => {
							calls.push("localCheckConnection");
							a.lalaConnected = true;
						},
					},
					() => adapter.startLocalConnector(),
				);

				assert.deepEqual(calls, [
					"localCheckConnection",
					"localDiscoverSections",
					"localInitPollSettings",
					"localPoll",
					"localPoll",
				]);
			});
		}

		it("still retries when a real host simply did not answer", async () => {
			const adapter = makeAdapter("192.0.2.1");
			const calls = [];

			await withStubs(localClient, noNetworkStubs(calls), () => adapter.startLocalConnector());

			assert.ok(calls.includes("localCheckConnection"));
			assert.equal(adapter.scheduled.length, 1, "an unreachable but configured device is still worth retrying");
		});

		for (const senecip of ["", "0.0.0.0", "192.0.2.1"]) {
			it(`reports the connector as not configured when lala_use is off (senecip=${JSON.stringify(senecip)})`, async () => {
				const adapter = makeAdapter(senecip);
				adapter.config.lala_use = false;
				const calls = [];

				await withStubs(localClient, noNetworkStubs(calls), () => adapter.startLocalConnector());

				assert.deepEqual(calls, [], "a disabled connector starts nothing, whatever the address field holds");
				assert.deepEqual(adapter.scheduled, []);
				assert.ok(adapter.logs.some(([level, msg]) => level === "warn" && /not configured/i.test(msg)));
			});
		}
	});

	describe("retryConnectorInit entered directly", () => {
		// Defensive: nothing should reach the retry loop without an address, but if it ever
		// does it must return without arming a new timer rather than looping for ever.
		for (const senecip of UNCONFIGURED) {
			it(`returns without connecting or re-arming for senecip=${JSON.stringify(senecip)}`, async () => {
				const adapter = makeAdapter(senecip);
				const calls = [];

				await withStubs(localClient, noNetworkStubs(calls), () => adapter.retryConnectorInit("local"));

				assert.equal(calls.includes("localCheckConnection"), false);
				assert.deepEqual(adapter.scheduled, [], "an unconfigured address must not sustain a retry loop");
			});
		}

		it("keeps retrying a configured host that is unreachable", async () => {
			const adapter = makeAdapter("192.0.2.1");
			const calls = [];

			await withStubs(localClient, noNetworkStubs(calls), () => adapter.retryConnectorInit("local"));

			assert.ok(calls.includes("localCheckConnection"));
			assert.equal(adapter.scheduled.length, 1);
		});
	});
});
