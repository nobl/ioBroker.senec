"use strict";

/**
 * Tests for the dashboard's socket lifecycle.
 *
 * The client the web adapter serves is ioBroker's own `SocketClient`, not socket.io, and it
 * dispatches `connect` and `reconnect` exclusively — `connect` on the first connection and
 * never again. The fake below reproduces that dispatch exactly, because the whole class of bug
 * here is recovery wired to an event that only ever fires once, which reads as correct.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * The web adapter's SocketClient dispatch, reduced to the part that matters.
 *
 * Taken from `socket.io.js` v3.1.0 as served on port 8082:
 * `if (this.wasConnected) { reconnectHandlers… } else { connectHandlers…; wasConnected = true }`
 *
 * @returns {object} A socket double that records every emit
 */
function makeSocket() {
	const handlers = {};
	const socket = {
		emits: [],
		wasConnected: false,
		/**
		 * @param {string} name - Event name
		 * @param {Function} cb - Handler
		 */
		on(name, cb) {
			(handlers[name] = handlers[name] || []).push(cb);
		},
		/**
		 * @param {string} name - Message name
		 * @param {...any} rest - Payload, with an optional trailing callback
		 */
		emit(name, ...rest) {
			socket.emits.push(name);
			const cb = rest[rest.length - 1];
			if (typeof cb !== "function") {
				return;
			}
			if (name === "getStates") {
				cb(null, socket.dbStates || {});
			} else if (name === "getObject") {
				cb(null, { native: { lala_use: true }, common: { language: "en" } });
			} else {
				cb(null, null);
			}
		},
		/** Raise BOTH lifecycle events for one connection, as socket.io-client v2 does. */
		raiseBoth() {
			socket.wasConnected = true;
			(handlers.connect || []).forEach((cb) => cb(true));
			(handlers.reconnect || []).forEach((cb) => cb(true));
		},

		/**
		 * Deliver a state change exactly as the web adapter would.
		 *
		 * @param {string} id - Fully qualified state id
		 * @param {object|null} state - The new state, or null for a deletion
		 */
		raiseState(id, state) {
			(handlers.stateChange || []).forEach((cb) => cb(id, state));
		},

		/** Raise the lifecycle event the real client would raise. */
		becomeReady() {
			const which = socket.wasConnected ? "reconnect" : "connect";
			if (!socket.wasConnected) {
				socket.wasConnected = true;
			}
			(handlers[which] || []).forEach((cb) => cb(true));
		},
	};
	return socket;
}

/**
 * Load app.js with the globals the page gives it.
 *
 * @param {object} socket - The socket double
 * @returns {object} The vm context
 */
function loadApp(socket) {
	const noop = () => undefined;
	// The palette coalesces its repaints onto an animation frame, so the suite drives them.
	const frames = [];
	const el = () => ({
		style: {},
		hidden: false,
		classList: { add: noop, remove: noop, contains: () => false },
		setAttribute: noop,
		dataset: {},
		childElementCount: 0,
		innerHTML: "",
		addEventListener: noop,
		focus: noop,
	});
	const context = vm.createContext({
		io: { connect: () => socket },
		document: {
			getElementById: el,
			querySelector: () => null,
			querySelectorAll: () => [],
			createElement: el,
			head: { appendChild: noop },
			addEventListener: noop,
			baseURI: "http://localhost/senec/",
			documentElement: { classList: { add: noop, remove: noop, contains: () => false }, lang: "en" },
			body: { classList: { add: noop, remove: noop, contains: () => false } },
		},
		window: {
			location: { search: "" },
			addEventListener: noop,
			matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
		},
		navigator: { language: "en" },
		requestAnimationFrame: (cb) => frames.push(cb),
		localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
		t: (key) => key,
		connectorEnabled: () => true,
		liveChart: {
			resumed: 0,
			resumeAfterReconnect() {
				this.resumed++;
			},
			record: noop,
			initHistory: noop,
			refreshes: 0,
			refresh() {
				this.refreshes++;
			},
		},
		energyFlow: { update: noop, resolveSource: () => null, activeSource: null, sourceOwnsState: () => false },
		systemInfo: {
			dirtied: 0,
			evseDirty() {
				this.dirtied++;
			},
		},
		eventTimeline: { fetchEvents: noop },
		logViewer: { onConfigLoaded: noop },
		charts: {
			refreshes: 0,
			refresh() {
				this.refreshes++;
			},
		},
		controls: { isLocked: () => false },
		statsViewer: {},
		console,
	});
	// i18n.js first, as index.html loads it: it defines the shared globals app.js reads at
	// evaluation time. Its `t` and `i18n` are replaced below with the stubs this suite wants.
	for (const name of ["i18n.js", "colors.js", "app.js"]) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8"), context, {
			filename: name,
		});
	}
	// The real i18n.init fetches dictionaries over HTTP, which this context has no fetch for —
	// and the whole recovery sits inside its promise. Replace it after loading, so app.js still
	// evaluated against the real shared globals i18n.js defines.
	context.i18n = {
		lang: "en",
		init: () => Promise.resolve(),
		applyAll: noop,
		has: () => true,
		// `t` is the real one from i18n.js and delegates here, so the stub needs it: without
		// it the throw lands inside onSocketReady's promise chain and silently stops the
		// recovery, which looks exactly like the recovery not running.
		translate: (key) => key,
	};
	context.runFrames = () => {
		const queued = frames.splice(0, frames.length);
		queued.forEach((cb) => cb());
	};
	context.app.renderDashboard = noop;
	context.app.render = noop;
	context.app.renderConnectors = noop;
	return context;
}

describe("dashboard — socket lifecycle", () => {
	let socket;
	let app;
	let ctx;

	beforeEach(() => {
		socket = makeSocket();
		ctx = loadApp(socket);
		app = ctx.app;
		app.conn = socket;
		app.onSocketLoaded();
	});

	/**
	 * Settle the promise chain `onSocketReady` runs its recovery in.
	 *
	 * @returns {Promise<void>} Resolves once the microtasks have drained
	 */
	const settle = () => new Promise((r) => setImmediate(r));

	it("recovers on the first connection", async () => {
		socket.dbStates = { "senec.0.info.connection": { val: true } };
		socket.becomeReady();
		await settle();

		assert.ok(socket.emits.includes("subscribeObjects"), "object subscription asked for");
		assert.ok(socket.emits.includes("getStates"), "state cache built");
	});

	it("recovers again on every reconnection", async () => {
		// The bug this pins: the recovery hung off `connect`, which this client fires once and
		// never again, so none of it ran after a dropped socket — and because the handler also
		// owned the `reconnected` flag, that flag was always false and the dead branch looked
		// deliberate.
		socket.dbStates = { "senec.0.info.connection": { val: true } };
		socket.becomeReady();
		await settle();
		const first = socket.emits.length;
		socket.emits.length = 0;

		socket.becomeReady();
		await settle();

		assert.ok(first > 0, "the first connection did something to compare against");
		assert.ok(socket.emits.includes("subscribeObjects"), "object subscription re-issued");
		assert.ok(socket.emits.includes("getStates"), "state cache rebuilt");
		assert.equal(ctx.liveChart.resumed, 1, "the chart's reconnect gap fill ran exactly once");
	});

	it("runs the recovery once when a client raises both lifecycle events", async () => {
		// The web adapter can be configured to serve socket.io-client v2 instead of ioBroker's
		// own ws client, and v2 forwards `reconnect` to the namespace socket as well as
		// `connect`. Keying the recovery on the event name ran it twice there — two i18n
		// loads, two getStates — and the gap fill not at all on a client that raises only one.
		socket.dbStates = { "senec.0.info.connection": { val: true } };
		socket.becomeReady();
		await settle();
		socket.emits.length = 0;

		socket.raiseBoth();
		await settle();

		const getStates = socket.emits.filter((name) => name === "getStates").length;
		assert.equal(getStates, 1, `the recovery ran ${getStates} times for one connection`);
		assert.equal(ctx.liveChart.resumed, 1, "and the chart gap fill ran exactly once");
	});

	it("drops a state that disappeared while the socket was down", async () => {
		socket.dbStates = {
			"senec.0.info.connection": { val: true },
			"senec.0._openapi.evse.1.chargingPower": { val: 7400 },
		};
		socket.becomeReady();
		await settle();
		assert.equal(app.states["_openapi.evse.1.chargingPower"], 7400);

		// The appliance stopped reporting the slot, and the adapter deleted it, while the page
		// was disconnected. It is simply absent from the next getStates — a merge would keep it
		// on display as a car still connected and still drawing its last power.
		delete socket.dbStates["senec.0._openapi.evse.1.chargingPower"];
		socket.becomeReady();
		await settle();

		assert.ok(!("_openapi.evse.1.chargingPower" in app.states), "the stale slot is gone");
		assert.ok(ctx.systemInfo.dirtied > 0, "and the memoised slot scan was invalidated");
	});

	describe("a chart palette arriving over the socket", () => {
		/**
		 * Bring the page up with an empty palette.
		 *
		 * @returns {Promise<void>} Resolves once the first recovery has settled
		 */
		async function ready() {
			socket.dbStates = { "senec.0.info.connection": { val: true } };
			socket.becomeReady();
			await settle();
			ctx.liveChart.refreshes = 0;
			ctx.charts.refreshes = 0;
			// Rebuilding the state cache invalidates the memoised wallbox scan; that belongs to
			// coming up, not to anything these cases do afterwards.
			ctx.systemInfo.dirtied = 0;
		}

		it("adopts a palette another page picked, and repaints both charts", async () => {
			// The headline behaviour: a color changed on a phone reaches a wall tablet without a
			// reload. It arrives here, through the same handler as every device reading.
			await ready();

			socket.raiseState("senec.0._dashboard.colors", { val: '{"pv":"#010203"}', ack: true });
			ctx.runFrames();

			assert.equal(ctx.chartColors.get("pv"), "#010203");
			assert.equal(ctx.liveChart.refreshes, 1);
			assert.equal(ctx.charts.refreshes, 1);
		});

		it("does not repaint when the adapter acks back a palette already applied", async () => {
			// Every pick produces an ack carrying the same value. Repainting on it would redraw
			// both charts a second time for every single color the user chooses.
			await ready();
			socket.raiseState("senec.0._dashboard.colors", { val: '{"pv":"#010203"}', ack: true });
			ctx.runFrames();
			ctx.liveChart.refreshes = 0;
			ctx.charts.refreshes = 0;

			socket.raiseState("senec.0._dashboard.colors", { val: '{"pv":"#010203"}', ack: true });
			ctx.runFrames();

			assert.equal(ctx.liveChart.refreshes, 0);
			assert.equal(ctx.charts.refreshes, 0);
		});

		it("does not treat the palette as a device reading", async () => {
			// It carries no measurement, so none of the energy recompute applies to it.
			await ready();
			let updates = 0;
			ctx.energyFlow.update = () => {
				updates++;
			};

			socket.raiseState("senec.0._dashboard.colors", { val: '{"house":"#040506"}', ack: true });
			ctx.runFrames();

			assert.equal(updates, 0);
			assert.equal(ctx.systemInfo.dirtied, 0);
		});

		it("takes the stored palette on a reconnect, so a page joins with the shared colors", async () => {
			await ready();
			socket.dbStates = {
				"senec.0.info.connection": { val: true },
				"senec.0._dashboard.colors": { val: '{"house":"#070809"}' },
			};

			socket.becomeReady();
			await settle();

			assert.equal(ctx.chartColors.get("house"), "#070809");
		});
	});
});
