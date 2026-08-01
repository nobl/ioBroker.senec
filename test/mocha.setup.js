// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
	throw e;
});

// The unit suites drive the connectors with scripted doubles, and the URLs they pass around
// are inert strings. Make that a guarantee rather than a convention: a test that reaches for
// a socket or a DNS lookup fails immediately and says so. Nothing here may ever touch a real
// SENEC appliance, the SENEC API or mein-senec.de.
const net = require("node:net");
const dns = require("node:dns");

/**
 * @param {string} what - The operation that was attempted
 * @returns {never} Always throws
 */
function refuseNetwork(what) {
	throw new Error(
		`Unit tests must not use the network (attempted ${what}). ` +
			"Drive the connector with a scripted double instead.",
	);
}

net.Socket.prototype.connect = function () {
	return refuseNetwork("a TCP connection");
};
dns.lookup = function () {
	return refuseNetwork("a DNS lookup");
};

// The adapter template wires up chai, chai-as-promised and sinon-chai here. This project
// asserts with node:assert/strict, so nothing ever consumed them — and because they belong
// to @iobroker/testing rather than to this package, they are not hoisted to the top level
// and a bare require() for them throws, taking the whole unit suite down with it.
//
// Left in place, commented, in case a future test wants the chai interface. Reviving it
// means resolving the packages through @iobroker/testing rather than adding them here,
// since ioBroker deliberately stopped adapters declaring them.
//
// const sinonChai = require("sinon-chai");
// const chaiAsPromised = require("chai-as-promised");
// const { should, use } = require("chai");
//
// should();
// use(sinonChai);
// use(chaiAsPromised);
