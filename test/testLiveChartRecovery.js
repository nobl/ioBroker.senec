"use strict";

/**
 * Tests for the live chart's history loading under a socket that misbehaves.
 *
 * Every defect pinned here shares a shape: a guard that reads as correct but cannot be reached,
 * or state that the wrong load owns. They are only observable with a socket double that can
 * withhold an acknowledgement the way a dropped connection does — `SocketClient.close()` clears
 * its pending callbacks, and `emit` while disconnected returns without invoking one at all — so
 * a double that always answers synchronously cannot see any of them.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * A socket whose acknowledgements can be withheld, delivered late, or dropped entirely.
 *
 * @returns {object} The socket double
 */
function makeSocket() {
	const pending = [];
	const socket = {
		emits: [],
		connected: true,
		/**
		 * @param {string} name - Message name
		 * @param {...any} rest - Payload, with an optional trailing callback
		 */
		emit(name, ...rest) {
			socket.emits.push({ name, args: rest.slice(0, -1) });
			const cb = rest[rest.length - 1];
			if (typeof cb !== "function") {
				return;
			}
			if (!socket.connected) {
				// What the real client does while disconnected: the callback is never called.
				return;
			}
			pending.push({ name, cb });
		},
		/**
		 * Answer outstanding calls, oldest first.
		 *
		 * @param {number} [limit] - How many to answer; all of them by default
		 */
		flush(limit) {
			const queued = pending.splice(0, limit === undefined ? pending.length : limit);
			for (const call of queued) {
				if (call.name === "getObject") {
					call.cb(null, { common: { custom: { "history.0": { enabled: true } } } });
				} else {
					call.cb(null, []);
				}
			}
		},
		/** Throw away every outstanding call, as a dropped socket does. */
		drop() {
			pending.length = 0;
			socket.connected = false;
		},
		/** @returns {number} How many calls are still waiting */
		outstanding() {
			return pending.length;
		},
		/**
		 * @param {string} name - Message name
		 * @returns {number} How many of that message were emitted
		 */
		count(name) {
			return socket.emits.filter((e) => e.name === name).length;
		},
	};
	return socket;
}

/**
 * Load the chart and its collaborators against a scriptable socket.
 *
 * @param {object} socket - The socket double
 * @returns {object} The vm context
 */
function loadChart(socket) {
	const noop = () => undefined;
	const context = vm.createContext({
		app: {
			conn: socket,
			namespace: "senec.0",
			states: { "ENERGY.GUI_HOUSE_POW": 1000, "ENERGY.GUI_BAT_DATA_POWER": 0 },
			config: { lala_use: true, openapi_use: false, api_use: false, web_use: false },
			connectors: { local: { active: true } },
			renderDashboard: noop,
		},
		document: { getElementById: () => null, querySelectorAll: () => [] },
		window: {},
		requestAnimationFrame: noop,
		setTimeout,
		clearTimeout,
		navigator: { language: "en" },
		console,
	});
	for (const name of ["i18n.js", "energy.js", "livechart.js"]) {
		vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", name), "utf8"), context, {
			filename: name,
		});
	}
	context.energyFlow.activeSource = "local";
	context.energyFlow.source = "local";
	return context;
}

describe("live chart — recovery when the socket misbehaves", () => {
	let socket;
	let ctx;
	let liveChart;

	beforeEach(() => {
		socket = makeSocket();
		ctx = loadChart(socket);
		liveChart = ctx.liveChart;
	});

	/** Bring the chart to a state where discovery has completed and instances are known. */
	function completeDiscovery() {
		liveChart.initHistory(socket, "senec.0", ctx.app.connectors);
		socket.flush(); // the getObject probes
		socket.flush(); // the getHistory fan-out they trigger
		socket.emits.length = 0;
	}

	it("re-probes a discovery that was lost to the drop", () => {
		// `_historyLoaded` used to be latched before the probes answered, so a drop during
		// discovery left every entry at instance:null for the life of the tab: `_hasHistory()`
		// false for ever, and every later initHistory refused at its own guard.
		liveChart.initHistory(socket, "senec.0", ctx.app.connectors);
		assert.ok(socket.outstanding() > 0, "probes are in flight");
		socket.drop();
		assert.equal(liveChart._hasHistory(), false, "nothing was discovered");

		socket.connected = true;
		socket.emits.length = 0;
		liveChart.resumeAfterReconnect(socket, "senec.0", ctx.app.connectors);

		assert.ok(socket.count("getObject") > 0, "the reconnect did not re-probe");
	});

	it("re-probes a discovery that only partly answered", () => {
		// The harder half of the same defect: one probe answered before the drop, so the chart
		// believes it has history and `_hasHistory()` is true — but the round never completed,
		// so `onDone` never fired and no load was ever issued. Latching "loaded" on entry made
		// that state permanent.
		liveChart.initHistory(socket, "senec.0", ctx.app.connectors);
		socket.flush(1);
		assert.equal(liveChart._hasHistory(), true, "one instance is known");
		assert.equal(socket.count("getHistory"), 0, "but the round never completed, so nothing loaded");
		socket.drop();

		socket.connected = true;
		socket.emits.length = 0;
		liveChart.resumeAfterReconnect(socket, "senec.0", ctx.app.connectors);

		assert.ok(socket.count("getObject") > 0, "an incomplete discovery was treated as done");
	});

	it("still fills the gap when a load was in flight at the moment of the drop", () => {
		// The drop that strands a load is the same event that triggers the gap fill, so the
		// one request able to close a mid-buffer hole always arrived while the in-progress
		// guard was closed — and nothing else ever asks for a hole in the middle.
		completeDiscovery();
		liveChart._newestHistoryTs = Date.now() - 10 * 60 * 1000;
		liveChart._loadHistory(socket, "senec.0", "local");
		assert.equal(liveChart._historyLoading, true, "a load is in flight");

		socket.drop();
		socket.connected = true;
		socket.emits.length = 0;
		// The outage lasted a while: the stranded load had claimed up to the moment it started,
		// and the page has been off the air since.
		liveChart._newestHistoryTs = Date.now() - 5000;
		liveChart.resumeAfterReconnect(socket, "senec.0", ctx.app.connectors);
		assert.equal(socket.count("getHistory"), 0, "the in-progress guard refuses it, as it must");
		// The queued gap is issued once the stranded load settles.
		liveChart._mergeHistory({}, "local");

		return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
			assert.ok(socket.count("getHistory") > 0, "the gap fill was dropped and never retried");
		});
	});

	it("gives back a range whose request was never sent", () => {
		// `_historyRequestedTs` is widened before the emit so that a reply which comes back
		// short cannot make the callers loop. A request the client silently refused to send
		// while disconnected has to undo that, or the range reads as covered for ever.
		completeDiscovery();
		const before = liveChart._historyRequestedTs;
		socket.connected = false;
		// Shortened so the real release timer can run; the production value is 90 s.
		liveChart.HISTORY_ACK_TIMEOUT_MS = 5;

		liveChart._loadHistory(socket, "senec.0", "local", Date.now() - 6 * 60 * 60 * 1000);
		assert.ok(liveChart._historyRequestedTs < before, "the range was claimed");
		assert.ok(socket.count("getHistory") > 0, "the emits were attempted but never answered");

		return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
			assert.equal(liveChart._historyLoading, false, "the timeout released the in-progress flag");
			assert.equal(liveChart._historyRequestedTs, before, "the unfetched range is still marked covered");
		});
	});

	it("does not let a superseded load disown the one that replaced it", () => {
		// `_historyLoading` and `_loadTimer` are single slots. A stale callback used to clear
		// both unconditionally, cancelling the ack timeout of the load that had replaced it
		// and letting a third start on top of both.
		completeDiscovery();
		liveChart._loadHistory(socket, "senec.0", "local");
		const firstToken = liveChart._loadToken;
		const firstCalls = socket.outstanding();
		assert.ok(firstCalls > 0, "the first load is in flight");

		// A source switch: generation bumps, the in-flight load becomes stale, a new one runs.
		liveChart._loadGeneration++;
		liveChart._historyLoading = false;
		liveChart._loadHistory(socket, "senec.0", "local");
		const secondToken = liveChart._loadToken;
		assert.notEqual(firstToken, secondToken, "the two loads have distinct identities");
		const secondTimer = liveChart._loadTimer;

		// Only the first (now stale) load's replies arrive. The second is still outstanding.
		socket.flush(firstCalls);

		assert.equal(liveChart._loadTimer, secondTimer, "the stale load cancelled the current load's ack timer");
		assert.equal(liveChart._historyLoading, true, "and it released the current load's in-progress flag");
		assert.equal(liveChart._loadToken, secondToken, "ownership stays with the current load");
	});

	it("asks history for the interval a collapsed chart did not collect", () => {
		completeDiscovery();
		liveChart._newestHistoryTs = Date.now() - 10 * 60 * 1000;
		liveChart.disabled = true;
		socket.emits.length = 0;

		liveChart.toggleDisabled();

		assert.ok(socket.count("getHistory") > 0, "the collapsed interval is a hole with no other path to fill it");
	});

	it("asks history for the interval a paused chart did not collect", () => {
		completeDiscovery();
		liveChart._newestHistoryTs = Date.now() - 10 * 60 * 1000;
		liveChart.paused = true;
		socket.emits.length = 0;

		liveChart.togglePause();

		assert.ok(socket.count("getHistory") > 0, "resuming left the hole in place");
	});
});
