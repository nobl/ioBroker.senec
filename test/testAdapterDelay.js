"use strict";

/**
 * The adapter's in-cycle wait primitive.
 *
 * `Senec` overrides the platform's `delay`, and that override is what two connectors wait on —
 * the local OpenAPI's confirmation paths and the measurement rebuild's retry backoff. The
 * platform's own version leaves its promise pending for ever once the adapter is stopping, which
 * would skip every `finally` after a wait: the shared mein-senec.de session would not be
 * released and the one-cycle-at-a-time flag would stay set. The override exists so a wait always
 * settles, and these tests are what hold it to that.
 *
 * Exercised against a controlled `this` rather than a live instance, so no js-controller, no
 * sockets and no object store are involved.
 */

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

// Same stubs the pure-function suite uses: main.js reaches for adapter-core and axios at load,
// and neither is available without a js-controller installation.
const { Senec } = proxyquire("../main", {
	"@iobroker/adapter-core": {
		Adapter: class FakeAdapter {
			constructor() {}
			// The constructor subscribes to ready/stateChange/message/unload before it returns.
			on() {}
		},
		getAbsoluteDefaultDataDir: () => "/tmp",
	},
	axios: { create: () => ({}) },
	"axios-cookiejar-support": {},
	"tough-cookie": { CookieJar: class {} },
})._testing;

/** @returns {object} A stand-in carrying only what delay() touches. */
function waiter() {
	const self = {
		unloaded: false,
		pendingDelays: new Set(),
		armed: [],
		/**
		 * @param {Function} fn - Callback
		 * @param {number} ms - Delay
		 * @returns {object} Handle
		 */
		setTimeout(fn, ms) {
			const handle = { fn, ms };
			self.armed.push(handle);
			return handle;
		},
	};
	self.delay = Senec.prototype.delay.bind(self);
	return self;
}

/**
 * @param {Promise<unknown>} promise - Promise under test
 * @returns {Promise<boolean>} Whether it settled within a turn of the event loop
 */
async function settled(promise) {
	const pending = Symbol("pending");
	const result = await Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(pending)))]);
	return result !== pending;
}

describe("the adapter's in-cycle wait", () => {
	it("settles at once, and arms nothing, when the adapter is already unloading", async () => {
		const self = waiter();
		self.unloaded = true;

		assert.equal(await settled(self.delay(5000)), true, "a wait started while stopping returns immediately");
		assert.deepEqual(self.armed, [], "and no timer is armed into an adapter that is going away");
		assert.equal(self.pendingDelays.size, 0, "so there is nothing parked to wake later");
	});

	it("settles at once for a non-positive wait", async () => {
		const self = waiter();

		assert.equal(await settled(self.delay(0)), true);
		assert.deepEqual(self.armed, [], "zero does not arm a timer");
	});

	it("waits on a tracked timer, and lets go of the waiter once it fires", async () => {
		const self = waiter();

		const wait = self.delay(3000);

		assert.equal(await settled(wait), false, "it does not resolve before its timer fires");
		assert.deepEqual(
			self.armed.map((t) => t.ms),
			[3000],
			"the timer is armed through adapter.setTimeout, so unload can clear it",
		);
		assert.equal(self.pendingDelays.size, 1, "and the waiter is parked while it waits");

		self.armed[0].fn();

		assert.equal(await settled(wait), true, "firing the timer settles the wait");
		assert.equal(self.pendingDelays.size, 0, "and the waiter removes itself rather than accumulating");
	});

	// The defect this closes: the wait was handed out on a tracked timer alone. Unload clears
	// those timers, so the promise never settled, the awaiting cycle was abandoned mid-sequence,
	// and every `finally` after the wait — releasing the session, clearing the cycle flag — was
	// skipped. Parking the resolver is what lets onUnload release the waiter instead.
	it("can be released by unload after its timer has been cleared", async () => {
		const self = waiter();

		const wait = self.delay(5000);
		assert.equal(self.pendingDelays.size, 1);

		// What unload does: the tracked timer is cleared, so it will never fire...
		self.armed.length = 0;
		assert.equal(await settled(wait), false, "a cleared timer alone would leave the caller suspended");

		// ...and then the parked waiters are drained, exactly as onUnload drains them.
		for (const wake of [...self.pendingDelays]) {
			wake();
		}

		assert.equal(await settled(wait), true, "draining the parked waiters releases the caller");
		assert.equal(self.pendingDelays.size, 0, "and leaves nothing behind");
	});

	// The parking above only helps if teardown actually drains it, so this drives the real
	// onUnload against a stand-in carrying the fields it touches.
	it("is released by onUnload, which is what makes the parking worth doing", async () => {
		const self = waiter();
		const cleared = [];
		Object.assign(self, {
			abortController: { abort: () => {} },
			openapiPollTimer: null,
			knownObjects: new Map(),
			/** @param {object} handle - Timer handle */
			clearTimeout: (handle) => cleared.push(handle),
			log: { info: () => {} },
			setState: () => {},
			logError: () => {},
		});

		// Two of them, because onUnload drains the set while each waiter removes itself from it.
		const first = self.delay(5000);
		const second = self.delay(3000);
		assert.equal(self.pendingDelays.size, 2, "both cycles are parked, waiting");

		let finished = false;
		Senec.prototype.onUnload.call(self, () => {
			finished = true;
		});

		assert.equal(finished, true, "onUnload still completes synchronously");
		assert.equal(await settled(first), true, "the waiting cycle is released rather than left suspended");
		assert.equal(await settled(second), true, "and removing one waiter mid-drain does not skip the next");
		assert.equal(self.unloaded, true, "so each wakes to find the adapter gone and unwinds");
		assert.equal(self.pendingDelays.size, 0, "with nothing parked afterwards");
	});

	// Nothing else pins this: every test above hands delay() a set of its own, so deleting the
	// constructor's initialiser would leave all of them green while the real adapter threw a
	// TypeError out of delay()'s executor and out of onUnload's drain.
	it("is given somewhere to park by the constructor", () => {
		const instance = new Senec({});

		assert.ok(instance.pendingDelays instanceof Set, "delay() parks into a Set the constructor creates");
		assert.equal(instance.pendingDelays.size, 0, "and it starts empty");
	});

	it("parks every concurrent waiter, so one wake does not strand the others", async () => {
		const self = waiter();

		const first = self.delay(3000);
		const second = self.delay(5000);
		assert.equal(self.pendingDelays.size, 2);

		for (const wake of [...self.pendingDelays]) {
			wake();
		}

		assert.equal(await settled(first), true);
		assert.equal(await settled(second), true);
		assert.equal(self.pendingDelays.size, 0);
	});
});
