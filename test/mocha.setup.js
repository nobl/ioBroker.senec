// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
	throw e;
});

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
