"use strict";

/**
 * The unit suites drive the connectors with scripted doubles, so no test may ever reach a
 * real SENEC appliance, the SENEC API or mein-senec.de. test/mocha.setup.js enforces that by
 * refusing sockets and DNS lookups.
 *
 * These two assertions guard the guard: if the enforcement is ever removed or stops working,
 * the suite says so here rather than quietly starting to make real requests.
 */

const assert = require("node:assert/strict");
const net = require("node:net");
const dns = require("node:dns");

describe("unit suite network isolation", () => {
	it("refuses to open a TCP connection", () => {
		assert.throws(() => new net.Socket().connect(443, "mein-senec.de"), /must not use the network/);
	});

	it("refuses to resolve a hostname", () => {
		assert.throws(() => dns.lookup("mein-senec.de", () => {}), /must not use the network/);
	});
});
