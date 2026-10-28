"use strict";

/* exported app, logViewer, toggleTheme */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */
/* global io, i18n, t, connectorEnabled, OPENAPI_ROUTE_SECTIONS, chartColors, energyFlow, liveChart, eventTimeline, charts, systemInfo, controls, statsViewer, document, window, requestAnimationFrame, FileReader, XMLHttpRequest */

/**
 * Dashboard entry point: socket wiring, state cache, tab handling and the render loop.
 *
 * Lives in its own file rather than inline in index.html so that it can be loaded into a test
 * context the way every other dashboard module is. While it was inline, the suite tested a
 * hand-written replica of its state-update decision instead, and the replica was free to drift
 * from the real handler without any test noticing.
 */
const NAMESPACE = "senec.0";

/**
 * OpenAPI sections whose writes are live power readings, derived from the one list of routes.
 *
 * Identity and wallbox data are not: the nameplate changes once a year and the wallbox has its
 * own card. Derived rather than written out again because these names were already repeated in
 * three places — `OPENAPI_ROUTE_SECTIONS`, `READ_ROUTES` in lib/openapi-client.js and
 * `stateMap` in energy.js — and a fourth copy here meant a new section could silently fail to
 * trigger a re-render. Anything added to the route list counts as power-bearing unless named
 * below, which is the safer default of the two.
 */
const OPENAPI_POWER_SECTIONS = OPENAPI_ROUTE_SECTIONS.filter(function (section) {
	return section !== "bessNameplate" && section !== "evse";
});

var app = {
	namespace: NAMESPACE,
	conn: null,

	/**
	 * Whether the socket is currently usable for a write.
	 *
	 * `conn` survives an outage, so it answers "was a socket ever made", not "will this
	 * emit arrive". Writes need the second question.
	 */
	socketLive: false,
	states: {},
	config: {},
	connected: false,
	activeTab: "overview",
	connectors: {
		local: { label: "Local (lala.cgi)", stateId: "info.localConnected", active: false },
		openapi: { label: "Local OpenAPI", stateId: "info.openapiConnected", active: false },
		api: { label: "SENEC App API", stateId: "info.apiConnected", active: false },
		web: { label: "mein-senec.de", stateId: "info.webConnected", active: false },
		connect: { label: "SENEC.Connect", stateId: "info.connectConnected", active: false },
	},

	init: function () {
		this.initTabs();
		this.connectSocket();
	},

	switchTab: function (tab) {
		var tabs = document.querySelectorAll(".nav-tab");
		var panels = document.querySelectorAll(".tab-content");
		tabs.forEach(function (t) {
			t.classList.remove("active");
			t.setAttribute("aria-selected", "false");
			t.setAttribute("tabindex", "-1");
		});
		panels.forEach(function (/** @type {HTMLElement} */ c) {
			c.classList.remove("active");
			c.hidden = true;
		});
		tab.classList.add("active");
		tab.setAttribute("aria-selected", "true");
		tab.setAttribute("tabindex", "0");
		var target = document.getElementById(`tab-${tab.dataset.tab}`);
		if (target) {
			target.classList.add("active");
			target.hidden = false;
		}
		app.activeTab = tab.dataset.tab;
		app.renderDashboard();
	},

	initTabs: function () {
		var tabList = document.querySelectorAll(".nav-tab");
		tabList.forEach(function (tab) {
			tab.addEventListener("click", function () {
				app.switchTab(tab);
			});
			tab.addEventListener(
				"keydown",
				/** @param {KeyboardEvent} e - Key event */ function (e) {
					var tabs = Array.from(tabList);
					var idx = tabs.indexOf(tab);
					if (e.key === "ArrowRight" || e.key === "ArrowDown") {
						e.preventDefault();
						var next = /** @type {HTMLElement} */ (tabs[(idx + 1) % tabs.length]);
						next.focus();
						app.switchTab(next);
					} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
						e.preventDefault();
						var prev = /** @type {HTMLElement} */ (tabs[(idx - 1 + tabs.length) % tabs.length]);
						prev.focus();
						app.switchTab(prev);
					} else if (e.key === "Home") {
						e.preventDefault();
						var firstTab = /** @type {HTMLElement} */ (tabs[0]);
						firstTab.focus();
						app.switchTab(firstTab);
					} else if (e.key === "End") {
						e.preventDefault();
						var lastTab = /** @type {HTMLElement} */ (tabs[tabs.length - 1]);
						lastTab.focus();
						app.switchTab(lastTab);
					}
				},
			);
		});
	},

	connectSocket: function () {
		var script = document.createElement("script");
		script.src = "../socket.io/socket.io.js";
		script.onload = function () {
			app.onSocketLoaded();
		};
		script.onerror = function () {
			app.showError(t("socket_error"));
		};
		document.head.appendChild(script);
	},

	onSocketLoaded: function () {
		this.conn = io.connect("", { path: "/socket.io" });

		// Both events, and the distinction is not cosmetic. The client the web adapter serves is
		// ioBroker's own SocketClient, not socket.io, and it fires these two exclusively:
		//
		//     if (this.wasConnected) { reconnectHandlers… } else { connectHandlers…; wasConnected = true }
		//
		// So `connect` fires on the first connection and never again. Hanging the recovery off
		// it alone meant none of it had ever run: after any dropped socket the page kept a state
		// cache that could no longer shrink, stopped hearing about configuration changes, and
		// left the chart with a hole it had no other path to ask for. The `reconnected` flag
		// inside that handler was likewise always false, which is what made it look harmless.
		// Both events, and the handler derives "is this a reconnect" from its own flag rather
		// than from which event fired. ioBroker's own ws client raises `connect` on the first
		// connection and `reconnect` on every later one, exclusively — but the web adapter can
		// be configured to serve socket.io-client v2 instead, which forwards `reconnect` to the
		// namespace socket *as well as* `connect`. Keying the behaviour on the event name
		// therefore ran the whole recovery twice on one client and not at all on another.
		this.conn.on("connect", function () {
			app.onSocketReady();
		});
		this.conn.on("reconnect", function () {
			app.onSocketReady();
		});

		this.conn.on("disconnect", function () {
			// `conn` stays in place across an outage, so it is not a usable liveness test.
			// Anything that writes has to know, or it reports a write as delivered that the
			// client either dropped or will flush at an unknown later time.
			app.socketLive = false;
			app.showError(t("disconnected"));
		});

		// Re-read config when adapter object changes (user changed settings)
		this.conn.on("objectChange", function (id, obj) {
			if (id === `system.adapter.${NAMESPACE}` && obj && obj.native) {
				app.config = obj.native;
				app.renderDashboard();
			}
		});
		this.conn.on("stateChange", function (id, state) {
			if (!id.startsWith(`${NAMESPACE}.`)) {
				return;
			}
			var shortId = id.substring(NAMESPACE.length + 1);
			if (!state) {
				// A deletion. Dropping it from the cache rather than ignoring it is what
				// lets a collection shrink on an open page: the adapter removes a wallbox
				// slot the appliance has stopped reporting, and a retained value would go
				// on rendering that slot as connected and charging until a reload.
				delete app.states[shortId];
				app.onStateUpdate(shortId, null);
				return;
			}
			app.states[shortId] = state.val;
			app.onStateUpdate(shortId, state.val);
		});
	},

	/**
	 * Bring the page back up on a socket that has just become usable.
	 *
	 * Idempotent: two lifecycle events for one connection must not run it twice.
	 */
	onSocketReady: function () {
		if (this._readyFor === this.conn && this._readyPending) {
			return;
		}
		this._readyPending = true;
		this._readyFor = this.conn;
		var reconnected = this._hasConnected;
		this._hasConnected = true;
		this.socketLive = true;
		document.getElementById("error-banner").style.display = "none";
		// Object subscriptions live on the server side of the socket, so a reconnect loses them
		// and they have to be asked for again — including the adapter object carrying the
		// connector enable flags that every card now tests before rendering a value.
		app.conn.emit("subscribeObjects", `system.adapter.${NAMESPACE}`);
		// Load i18n, config, and states — render once all are ready
		i18n.init(app.conn).then(function () {
			i18n.applyAll();
			// Anything a tab click asked for while the dictionaries were loading
			// was skipped by _doRender — draw it now that the text is available.
			app.renderDashboard();
			app.loadConfig();
			// Rebuilds the state cache from scratch, which is how a state deleted while the
			// socket was down leaves the page. The gap fill waits for it: `subscribe` only
			// *emits* getStates, so running straight on would resolve the source against a
			// cache as old as the outage, and query the wrong connector's state ids.
			app.subscribe(function () {
				app._readyPending = false;
				// A dropped socket leaves a hole in the middle of the chart buffer. No other
				// path asks for it: the pan and zoom backfills compare the visible window
				// against the oldest edge they have requested, which a gap at the newest edge
				// never trips.
				if (reconnected) {
					liveChart.resumeAfterReconnect(app.conn, NAMESPACE, app.connectors);
				}
			});
		});
	},

	loadConfig: function () {
		this.conn.emit("getObject", `system.adapter.${NAMESPACE}`, function (err, obj) {
			if (!err && obj && obj.native) {
				app.config = obj.native;
				logViewer.onConfigLoaded();
				eventTimeline.fetchEvents();
				// Every card now tests the connector enable flags before showing a value, and
				// those flags live in this config. Whatever was drawn before it arrived was
				// drawn against an empty config, so it has to be drawn again.
				app.renderDashboard();
			}
		});
	},

	/**
	 * Subscribe and rebuild the state cache.
	 *
	 * @param {function(): void} [onLoaded] - Called once the cache has actually been replaced
	 */
	subscribe: function (onLoaded) {
		this.conn.emit("subscribe", `${NAMESPACE}.*`);

		this.conn.emit("getStates", `${NAMESPACE}.*`, function (err, states) {
			if (err) {
				app.showError(t("error_loading_states", { error: err }));
				app._readyPending = false;
				return;
			}

			// Replaced, not merged. A state deleted while the socket was down is simply absent
			// from the reply, and merging left it in the cache for the life of the page — so a
			// wallbox slot the appliance had stopped reporting, or a connector's states after it
			// was switched off, went on rendering as current.
			/** @type {Record<string, string | number | boolean | null>} */
			var fresh = {};
			if (states) {
				for (var id in states) {
					if (states[id] && id.startsWith(`${NAMESPACE}.`)) {
						fresh[id.substring(NAMESPACE.length + 1)] = states[id].val;
					}
				}
			}
			app.states = fresh;
			chartColors.applyFromState(app.states[chartColors.STATE_ID]);
			// The set of wallbox slots is memoised off the state ids, and this is the one place
			// that can change all of them at once.
			systemInfo.evseDirty();

			app.connected = !!app.states["info.connection"];
			app.render();
			if (onLoaded) {
				onLoaded();
			}
		});
	},

	onStateUpdate: function (shortId, val) {
		// Carries no device reading, so none of the recompute below applies to it. Another
		// browser picking a color arrives here too, which is what keeps two open pages in step.
		if (shortId === chartColors.STATE_ID) {
			if (chartColors.applyFromState(val)) {
				chartColors.refreshCharts();
			}
			return;
		}
		if (shortId === "info.connection") {
			this.connected = !!val;
		}
		// The only thing that can change the set of wallbox slots, so it is also the only
		// place that has to invalidate the memoised scan of them.
		if (shortId.startsWith("_openapi.evse.")) {
			systemInfo.evseDirty();
		}
		// Tell energyFlow where this write falls in the OpenAPI cycle, so the render path can
		// refuse to recompute from a part-written one.
		energyFlow.noteOpenapiWrite(shortId);
		for (var key in this.connectors) {
			if (shortId === this.connectors[key].stateId) {
				this.connectors[key].active = !!val;
				break;
			}
		}
		this.renderConnectors();

		// Re-render on energy-relevant state changes
		// The OpenAPI publishes a cycle one section at a time, from separate requests, so any
		// single section write is a half-updated reading. Recomputing on one of them drew a
		// fresh battery value against the previous cycle's meter — which inverts the grid
		// direction, because the direction is derived from the balance of the two. The
		// end-of-cycle marker is the only point at which the set is coherent.
		var isOpenapiSection = OPENAPI_POWER_SECTIONS.some(function (section) {
			return shortId.startsWith(`_openapi.${section}.`);
		});
		// Both markers, because the connector writes `lastPoll` first and `lastCompletePoll`
		// only afterwards: on `lastPoll` the completeness test below still sees the previous
		// cycle's stamp, so keying the recompute on `lastPoll` alone recorded nothing at all.
		var isOpenapiCycleEnd = shortId === "_openapi.info.lastPoll" || shortId === "_openapi.info.lastCompletePoll";
		var isEnergyState =
			shortId.startsWith("ENERGY.GUI_") ||
			isOpenapiSection ||
			isOpenapiCycleEnd ||
			shortId.indexOf("currently.") !== -1 ||
			shortId.indexOf("today.") !== -1 ||
			shortId.indexOf("Status.") !== -1 ||
			shortId.indexOf("WALLBOX.") !== -1;
		var isMeasurementState = shortId.indexOf("Measurements.") !== -1 || shortId.indexOf("hourly.") !== -1;
		var isSystemState =
			shortId.startsWith("BMS.") ||
			shortId.startsWith("PM1OBJ1.") ||
			shortId.startsWith("TEMPMEASURE.") ||
			shortId.startsWith("PV1.") ||
			shortId.startsWith("WIZARD.") ||
			shortId.startsWith("_local.tls.") ||
			shortId.startsWith("_openapi.tls.") ||
			shortId.startsWith("_openapi.info.") ||
			shortId.startsWith("_openapi.bessNameplate.") ||
			shortId.startsWith("_openapi.evse.") ||
			shortId.startsWith("_openapi.bess.") ||
			shortId.indexOf("SystemDetails.") !== -1 ||
			shortId.indexOf("SystemStatus.") !== -1;

		if (isEnergyState) {
			// One test, asked in one place. Under the OpenAPI a cycle is written section by
			// section, so a recompute part-way through pairs a fresh reading with the previous
			// cycle's — and `_doRender` below asks the same question, because a second copy of
			// this condition is how the hold came to be bypassed in the first place.
			if (!energyFlow.openapiMidCycle(this.states)) {
				energyFlow.update(this.states, this.connectors);
			}
			// Only the active source's own states produce a sample — see
			// energyFlow.sourceOwnsState for which those are, and why. A cycle that did not
			// serve every section is shown, so the page never silently freezes, but it is not
			// recorded: a chart point mixing two cycles cannot be told from a real one later.
			if (energyFlow.activeSource && energyFlow.sourceOwnsState(energyFlow.activeSource, shortId)) {
				if (energyFlow.activeSource !== "openapi" || energyFlow.openapiCycleComplete(this.states)) {
					liveChart.record();
				}
			}
		}
		if (this.activeTab === "overview" && (isEnergyState || isSystemState)) {
			this.renderDashboard();
		}
		if (this.activeTab === "battery" && (isEnergyState || isSystemState)) {
			this.renderDashboard();
		}
		if (this.activeTab === "system" && isSystemState) {
			this.renderDashboard();
		}
		if (this.activeTab === "control" && shortId.startsWith("control.") && !controls.isLocked()) {
			this.renderDashboard();
		}
		if (this.activeTab === "charts" && charts.autoUpdate && (isEnergyState || isMeasurementState)) {
			this.renderDashboard();
			if (charts.period === "today") {
				charts.scrollToLatest();
			}
		}
	},

	render: function () {
		document.getElementById("loading").style.display = "none";
		document.getElementById("content").style.display = "block";

		this.connected = !!this.states["info.connection"];
		for (var key in this.connectors) {
			this.connectors[key].active = !!this.states[this.connectors[key].stateId];
		}

		this.renderConnectors();
		// energyFlow.update runs inside the render, so the first point can only be taken after
		// it. Recording here instead stamped `now` on whatever energyFlow.data still held —
		// nothing at all on the first load, and the pre-outage values on a reconnect.
		// No initHistory here: the first render resolves the source, and energyFlow re-arms the
		// chart as part of that. Probing before it was resolved meant every callback of that
		// discovery was discarded by the generation bump that followed — twelve object reads
		// per page load where six suffice.
		this.renderDashboard();
	},

	renderConnectors: function () {
		var el = document.getElementById("connectors");
		var html = "";
		for (var key in this.connectors) {
			var c = this.connectors[key];
			var cls = c.active ? "active" : "inactive";
			html += `<span class="connector-badge ${cls}"><span class="dot"></span>${c.label}</span>`;
		}
		el.innerHTML = html;
	},

	/** Whether any connection has been established before, so a recovery knows which it is. */
	_hasConnected: false,

	/** Guard making onSocketReady idempotent across two lifecycle events for one connection. */
	_readyPending: false,
	_readyFor: null,

	_renderPending: false,

	renderDashboard: function () {
		// Debounce: coalesce rapid state updates into a single render per frame
		if (this._renderPending) {
			return;
		}
		this._renderPending = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;
		requestAnimationFrame(function () {
			self._renderPending = false;
			self._doRender();
		});
	},

	_doRender: function () {
		// The view modules build their markup with t(), so rendering before the
		// dictionaries are in produces raw key names. Tabs are clickable from the
		// moment the page parses, well ahead of that — hold off and let the render
		// that follows i18n.init() do the work.
		if (!i18n.ready) {
			return;
		}

		var el = document.getElementById("dashboard");
		// The same hold onStateUpdate applies, because this is where the recompute really
		// happens: suppressing the direct call there achieved nothing while this one ran
		// unconditionally on the next animation frame, and a mid-cycle recompute pairs a fresh
		// battery reading with the previous cycle's meter — which inverts the grid arrow.
		if (!energyFlow.openapiMidCycle(this.states)) {
			energyFlow.update(this.states, this.connectors);
		}
		if (window._sim) {
			window._sim.apply();
		}
		el.innerHTML = energyFlow.render(systemInfo.renderOperatingMode(this.states));

		// An open color editor holds this redraw off. Replacing the markup under a native
		// color dialog detaches the input it was opened from, and the editor's own controls
		// would lose focus on every poll. Every control inside the two cards redraws through
		// its own module's `refresh()`, which is not held, so nothing else freezes with it.
		if (!liveChart._dragging && !liveChart._pinching && !liveChart._colorsOpen) {
			liveChart.refresh();
		}

		var timelineEl = document.getElementById("timeline-container");
		if (timelineEl) {
			timelineEl.innerHTML = eventTimeline.render();
		}

		var batteryEl = document.getElementById("battery-container");
		if (batteryEl) {
			batteryEl.innerHTML =
				systemInfo.renderBatteryLive(this.states) +
				systemInfo.renderBatteryHealth(this.states) +
				systemInfo.renderBatteryCycles(this.states) +
				systemInfo.renderBatteryTemps(this.states) +
				systemInfo.renderBatteryVoltages(this.states);
		}

		if (!charts._colorsOpen) {
			charts.refresh();
		}

		var statsEl = document.getElementById("statistics-container");
		if (statsEl) {
			statsEl.innerHTML = statsViewer.render(this.states);
			statsViewer.paintChart();
		}

		var systemEl = document.getElementById("system-container");
		if (systemEl) {
			systemEl.innerHTML =
				systemInfo.renderGridQuality(this.states) +
				systemInfo.renderPvStrings(this.states) +
				systemInfo.renderWallboxInfo(this.states) +
				systemInfo.renderOpenapiStatus(this.states) +
				systemInfo.renderFeatureStatus(this.states) +
				systemInfo.renderSystemDetails(this.states);
		}
		// TLS card lives in its own container — only re-render when not uploading
		var tlsEl = document.getElementById("tls-container");
		if (tlsEl && !this._tlsUploadActive) {
			tlsEl.innerHTML = systemInfo.renderTlsStatus(this.states);
			this.bindTlsUpload();
		}

		var controlEl = document.getElementById("control-container");
		if (controlEl) {
			controlEl.innerHTML = controls.render(this.states);
		}

		this.syncTabVisibility();
	},

	/**
	 * Containers each tab is built from. A tab with none of them filled has nothing to
	 * show and is hidden.
	 *
	 * Overview and the appliance logs are not listed: the overview states its own "no
	 * data" case and is the landing tab, and the log viewer reads the appliance directly
	 * from a configured address rather than from any connector's states.
	 */
	tabContainers: {
		battery: ["battery-container"],
		charts: ["charts-container"],
		system: ["system-container", "tls-container"],
		control: ["control-container"],
		statistics: ["statistics-container"],
	},

	/**
	 * Connectors that can feed a tab at all, where emptiness alone cannot decide it.
	 *
	 * These three keep rendering a frame — period buttons, a plant picker, an
	 * explanatory line — when they have nothing, so the container is never empty and
	 * the DOM test below would always keep them. Which connector supplies them is a
	 * question about the configuration, so it is answered from the configuration:
	 * measurements come from the two cloud connectors, the statistics download from
	 * mein-senec.de, and a control command from whichever connector can carry it.
	 */
	tabConnectors: {
		charts: ["api", "web"],
		statistics: ["web"],
		control: ["local", "api", "web"],
	},

	/**
	 * Hide the tabs whose cards all declined to render.
	 *
	 * Two tests, and a tab needs both. `tabConnectors` names the connectors a tab's content can
	 * come from, where there is such a list, and short-circuits before the DOM is consulted at
	 * all — so a card added to one of those tabs is *not* covered automatically. Otherwise the
	 * test is whether anything was produced, which the cards answer by returning an empty
	 * string when none of their sources is live.
	 */
	syncTabVisibility: function () {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;
		var hidTheActiveTab = false;
		Object.keys(this.tabContainers).forEach(function (name) {
			var sources = self.tabConnectors[name];
			var possible = !sources || sources.some(connectorEnabled);
			var filled =
				possible &&
				self.tabContainers[name].some(function (id) {
					var el = document.getElementById(id);
					// childElementCount, not innerHTML: the cards are element nodes, and
					// serialising every container's markup on each render just to ask whether
					// it is empty is a cost that stays invisible until the tree is large.
					return !!el && el.childElementCount > 0;
				});
			var button = /** @type {HTMLElement|null} */ (document.querySelector(`.nav-tab[data-tab="${name}"]`));
			if (!button) {
				return;
			}
			button.hidden = !filled;
			if (!filled && self.activeTab === name) {
				hidTheActiveTab = true;
			}
		});
		// Standing on a tab that has just emptied — a connector switched off, say —
		// would otherwise leave a blank page with no tab marked active.
		if (hidTheActiveTab) {
			var overview = document.querySelector('.nav-tab[data-tab="overview"]');
			if (overview) {
				self.switchTab(overview);
			}
		}
	},

	/**
	 * Bind the TLS cert file upload handler after rendering the system tab.
	 */
	/**
	 * Update the TLS upload status text in the DOM.
	 *
	 * @param {string} msg - Status message
	 * @param {string} color - CSS color
	 */
	setTlsStatus: function (msg, color) {
		var el = document.getElementById("tls-upload-status");
		if (el) {
			el.textContent = msg;
			el.style.color = color;
		}
	},

	bindTlsUpload: function () {
		var fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById("tls-cert-file"));
		if (!fileInput || fileInput._bound) {
			return;
		}
		fileInput._bound = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		var self = this;

		fileInput.addEventListener("change", function () {
			var file = fileInput && fileInput.files && fileInput.files[0];
			if (!file) {
				return;
			}
			self._tlsUploadActive = true;
			self.setTlsStatus(t("tls_uploading"), "#ff9800");

			// Send the raw file to the server — it handles both PEM and ZIP
			var reader = new FileReader();
			reader.onload = function () {
				var xhr = new XMLHttpRequest();
				xhr.open("POST", "/senec/api/tls/upload-ca");
				xhr.setRequestHeader("Content-Type", "application/octet-stream");
				xhr.timeout = 15000;
				xhr.onload = function () {
					if (xhr.status === 200) {
						// Watch for mode change via socket.io state subscription
						var checkCount = 0;
						var checkInterval = setInterval(function () {
							checkCount++;
							var mode = self.states["_local.tls.mode"];
							if (mode === "user") {
								clearInterval(checkInterval);
								self._tlsUploadActive = false;
								self.setTlsStatus(t("tls_upload_success"), "#4caf50");
								setTimeout(function () {
									var tlsEl = document.getElementById("tls-container");
									if (tlsEl) {
										tlsEl.innerHTML = systemInfo.renderTlsStatus(self.states);
										self.bindTlsUpload();
									}
								}, 3000);
							} else if (checkCount > 20) {
								clearInterval(checkInterval);
								self._tlsUploadActive = false;
								self.setTlsStatus(t("tls_upload_failed"), "#f44336");
								setTimeout(function () {
									var tlsEl = document.getElementById("tls-container");
									if (tlsEl) {
										tlsEl.innerHTML = systemInfo.renderTlsStatus(self.states);
										self.bindTlsUpload();
									}
								}, 3000);
							}
						}, 500);
					} else {
						self._tlsUploadActive = false;
						try {
							var resp = JSON.parse(xhr.responseText);
							self.setTlsStatus(
								t("tls_upload_error").replace("{error}", resp.error || xhr.status),
								"#f44336",
							);
						} catch {
							self.setTlsStatus(t("tls_upload_error").replace("{error}", String(xhr.status)), "#f44336");
						}
					}
				};
				xhr.onerror = function () {
					self._tlsUploadActive = false;
					self.setTlsStatus(t("tls_upload_error").replace("{error}", "network error"), "#f44336");
				};
				// readAsArrayBuffer is what fills this, so the union's string arm cannot occur here.
				var bytes = /** @type {ArrayBuffer} */ (reader.result);
				xhr.send(new Uint8Array(bytes));
			};
			reader.readAsArrayBuffer(file);
		});
	},

	showError: function (msg) {
		var el = document.getElementById("error-banner");
		el.textContent = msg;
		el.style.display = "block";
	},
};

// --- Log Viewer ---
var logViewer = {
	entries: [],
	filtered: [],
	rawText: "",
	filterText: "",
	filterLevel: "",
	filterCategory: "",
	categories: [],
	loading: false,
	deviceConfigured: false,
	highlightRows: true,
	currentDate: "",
	liveMode: false,
	liveTimer: null,
	liveIntervalMs: 30000,
	_activeXhr: null,

	onConfigLoaded: function () {
		var ip = app.config.senecip;
		this.deviceConfigured = !!(ip && ip !== "0.0.0.0");
		this.renderLogViewer();
	},

	renderLogViewer: function () {
		var el = document.getElementById("log-viewer");

		if (!this.deviceConfigured) {
			el.innerHTML =
				`<div class="warning-box">` +
				`<strong>${t("log_no_device")}</strong> ${t("log_no_device_detail")}</div>`;
			return;
		}

		var today = new Date().toISOString().slice(0, 10);
		var dateField = /** @type {HTMLInputElement|null} */ (document.getElementById("log-date"));
		var rawDate = dateField ? dateField.value : today;
		var dateVal = this.escapeHtml(rawDate);

		var html =
			`<div class="card">` +
			`<h2>${t("log_title")}</h2>` +
			`<div class="log-toolbar">` +
			`<input type="date" id="log-date" value="${dateVal}" max="${today}">` +
			`<button id="log-load" onclick="logViewer.loadLog()">${t("log_load")}</button>` +
			`<button class="toggle-btn${this.liveMode ? " active" : ""}" onclick="logViewer.toggleLive()" title="${t(
				"log_live",
			)}">${t("log_live")}</button>` +
			`<input type="text" id="log-filter" placeholder="${t("log_filter_placeholder")}" value="${this.escapeHtml(
				this.filterText,
			)}" oninput="logViewer.onFilterChange()">` +
			`<select id="log-level-filter" onchange="logViewer.onFilterChange()">` +
			`<option value="">${t("log_level_all")}</option>` +
			`<option value="I"${this.filterLevel === "I" ? " selected" : ""}>${t("log_level_info")}</option>` +
			`<option value="W"${this.filterLevel === "W" ? " selected" : ""}>${t("log_level_warning")}</option>` +
			`<option value="E"${this.filterLevel === "E" ? " selected" : ""}>${t("log_level_error")}</option>` +
			`<option value="P"${this.filterLevel === "P" ? " selected" : ""}>${t("log_level_panic")}</option>` +
			`</select>` +
			`<select id="log-cat-filter" onchange="logViewer.onFilterChange()">` +
			`<option value="">${t("log_category_all")}</option>`;

		for (var i = 0; i < this.categories.length; i++) {
			var sel = this.filterCategory === this.categories[i] ? " selected" : "";
			html += `<option value="${this.escapeHtml(this.categories[i])}"${sel}>${this.escapeHtml(
				this.categories[i],
			)}</option>`;
		}

		html +=
			`</select>` +
			`<button class="toggle-btn${
				this.highlightRows ? " active" : ""
			}" onclick="logViewer.toggleHighlight()" title="${t("log_highlight")}">${t("log_highlight")}</button>` +
			`<button class="toggle-btn" onclick="logViewer.downloadLog()"${
				this.entries.length === 0 ? " disabled" : ""
			} title="${t("log_download")}">${t("log_download")}</button>` +
			`<span class="spacer"></span>` +
			`<span class="log-count" id="log-count"></span>` +
			`</div>`;

		if (this.loading) {
			html += `<div class="loading"><div class="spinner"></div><div>${t("log_loading")}</div></div>`;
		} else if (this.noLog) {
			html += `<div class="stat-label">${t("log_no_log", { date: this.escapeHtml(this.currentDate) })}</div>`;
		} else if (this.entries.length > 0) {
			html += this.renderTable();
		} else {
			html += `<div class="stat-label">${t("log_select_date")}</div>`;
		}

		html += "</div>";
		el.innerHTML = html;
		this.updateCount();
	},

	renderTable: function () {
		var rows = this.filtered;
		var hlClass = this.highlightRows ? " highlight-rows" : "";
		var html =
			`<div class="log-table-wrap">` +
			`<table class="log-table${hlClass}">` +
			`<thead><tr>` +
			`<th>Time</th><th>Level</th><th>Category</th><th>Message</th>` +
			`</tr></thead><tbody>`;

		for (var i = 0; i < rows.length; i++) {
			var r = rows[i];
			var levelCls = `log-level-${r.level.toLowerCase()}`;
			var rowCls =
				r.level === "W" || r.level === "E" || r.level === "P" ? ` log-row-${r.level.toLowerCase()}` : "";
			html +=
				`<tr class="${rowCls}">` +
				`<td class="log-time">${this.escapeHtml(r.time)}</td>` +
				`<td><span class="log-level ${levelCls}">${this.escapeHtml(r.level)}</span></td>` +
				`<td class="log-category">${this.escapeHtml(r.category)}</td>` +
				`<td class="log-message">${this.escapeHtml(r.message)}</td>` +
				`</tr>`;
		}

		html += "</tbody></table></div>";
		return html;
	},

	loadLog: function (isLiveRefresh) {
		var dateEl = /** @type {HTMLInputElement|null} */ (document.getElementById("log-date"));
		if (!dateEl || !dateEl.value) {
			return;
		}

		// Turn off live mode if user manually loads a different date
		if (!isLiveRefresh && this.liveMode) {
			if (dateEl.value !== this.getUtcDate()) {
				this.liveMode = false;
				if (this.liveTimer) {
					clearInterval(this.liveTimer);
					this.liveTimer = null;
				}
			}
		}

		if (!isLiveRefresh) {
			this.loading = true;
		}
		this.currentDate = dateEl.value;
		this.noLog = false;
		if (!isLiveRefresh) {
			this.entries = [];
			this.filtered = [];
			this.categories = [];
			this.rawText = "";
			this.renderLogViewer();
		}

		// Abort any in-flight request before starting a new one
		if (this._activeXhr) {
			this._activeXhr.abort();
			this._activeXhr = null;
		}

		var xhr = new XMLHttpRequest();
		this._activeXhr = xhr;
		xhr.open("GET", `api/log?date=${encodeURIComponent(dateEl.value)}`);
		xhr.timeout = 15000;
		xhr.onload = function () {
			logViewer._activeXhr = null;
			logViewer.loading = false;
			if (xhr.status === 200) {
				logViewer.rawText = xhr.responseText;
				logViewer.parseLog(xhr.responseText);
			} else if (xhr.status === 404) {
				logViewer.noLog = true;
			} else {
				try {
					var err = JSON.parse(xhr.responseText);
					app.showError(t("log_load_failed", { error: err.error || "Unknown error" }));
				} catch {
					app.showError(t("log_load_failed", { error: `HTTP ${xhr.status}` }));
				}
			}
			logViewer.renderLogViewer();
		};
		xhr.onerror = function () {
			logViewer._activeXhr = null;
			logViewer.loading = false;
			app.showError(t("log_network_error"));
			logViewer.renderLogViewer();
		};
		xhr.ontimeout = function () {
			logViewer._activeXhr = null;
			logViewer.loading = false;
			app.showError(t("log_load_failed", { error: "Request timed out" }));
			logViewer.renderLogViewer();
		};
		xhr.send();
	},

	toggleHighlight: function () {
		this.highlightRows = !this.highlightRows;
		var table = document.querySelector(".log-table");
		if (table) {
			if (this.highlightRows) {
				table.classList.add("highlight-rows");
			} else {
				table.classList.remove("highlight-rows");
			}
		}
		var btn = document.querySelector(".toggle-btn");
		if (btn) {
			if (this.highlightRows) {
				btn.classList.add("active");
			} else {
				btn.classList.remove("active");
			}
		}
	},

	getUtcDate: function () {
		var d = new Date();
		var y = d.getUTCFullYear();
		var m = String(d.getUTCMonth() + 1).padStart(2, "0");
		var day = String(d.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	},

	toggleLive: function () {
		this.liveMode = !this.liveMode;
		if (this.liveMode) {
			// SENEC logs use UTC — use UTC date
			var utcToday = this.getUtcDate();
			var dateEl = /** @type {HTMLInputElement|null} */ (document.getElementById("log-date"));
			if (dateEl) {
				dateEl.value = utcToday;
			}
			this.loadLog();
			this.liveTimer = setInterval(function () {
				// Auto-switch date on UTC day rollover
				var utcNow = logViewer.getUtcDate();
				var dateInput = /** @type {HTMLInputElement|null} */ (document.getElementById("log-date"));
				if (dateInput) {
					dateInput.value = utcNow;
				}
				logViewer.loadLog(true);
			}, this.liveIntervalMs);
		} else {
			if (this.liveTimer) {
				clearInterval(this.liveTimer);
				this.liveTimer = null;
			}
		}
		this.renderLogViewer();
	},

	scrollToBottom: function () {
		var wrap = document.querySelector(".log-table-wrap");
		if (wrap) {
			wrap.scrollTop = wrap.scrollHeight;
		}
	},

	downloadLog: function () {
		if (!this.rawText) {
			return;
		}
		var blob = new Blob([this.rawText], { type: "text/plain" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = `senec-log-${this.currentDate}.log`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	},

	parseLog: function (raw) {
		var lines = raw.split("\n");
		var entries = [];
		var catSet = {};

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (!line) {
				continue;
			}

			var entry = this.parseLine(line);
			entries.push(entry);
			if (entry.category) {
				catSet[entry.category] = true;
			}
		}

		this.entries = entries.reverse();
		this.categories = Object.keys(catSet).sort();
		this.applyFilters();
	},

	parseLine: function (line) {
		// Format: "2026-07-11 00:00:15 [I|Energy Management] some message"
		// Or raw lines without brackets
		var match = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\[(\w)\|([^\]]+)\]\s*(.*)$/);
		if (match) {
			return {
				date: match[1],
				time: match[2],
				level: match[3],
				category: match[4],
				message: match[5],
			};
		}

		// Try format without brackets: "2026-07-11 00:00:15 some message"
		var match2 = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/);
		if (match2) {
			return {
				date: match2[1],
				time: match2[2],
				level: "-",
				category: "",
				message: match2[3],
			};
		}

		// Fallback: unparseable line
		return { date: "", time: "", level: "-", category: "", message: line };
	},

	onFilterChange: function () {
		var filterEl = /** @type {HTMLInputElement|null} */ (document.getElementById("log-filter"));
		var levelEl = /** @type {HTMLInputElement|null} */ (document.getElementById("log-level-filter"));
		var catEl = /** @type {HTMLInputElement|null} */ (document.getElementById("log-cat-filter"));

		this.filterText = filterEl ? filterEl.value : "";
		this.filterLevel = levelEl ? levelEl.value : "";
		this.filterCategory = catEl ? catEl.value : "";

		this.applyFilters();

		// Re-render just the table body and count
		var wrap = document.querySelector(".log-table-wrap");
		if (wrap && this.filtered.length > 0) {
			var html = "";
			for (var i = 0; i < this.filtered.length; i++) {
				var r = this.filtered[i];
				var levelCls = `log-level-${r.level.toLowerCase()}`;
				var rowCls =
					r.level === "W" || r.level === "E" || r.level === "P" ? ` log-row-${r.level.toLowerCase()}` : "";
				html +=
					`<tr class="${rowCls}">` +
					`<td class="log-time">${this.escapeHtml(r.time)}</td>` +
					`<td><span class="log-level ${levelCls}">${this.escapeHtml(r.level)}</span></td>` +
					`<td class="log-category">${this.escapeHtml(r.category)}</td>` +
					`<td class="log-message">${this.escapeHtml(r.message)}</td>` +
					`</tr>`;
			}
			var tbody = document.querySelector(".log-table tbody");
			if (tbody) {
				tbody.innerHTML = html;
			}
		} else if (wrap && this.filtered.length === 0 && this.entries.length > 0) {
			var parent = wrap.parentNode;
			if (parent) {
				parent.removeChild(wrap);
				var noMatch = document.createElement("div");
				noMatch.className = "stat-label";
				noMatch.textContent = t("log_no_match");
				parent.appendChild(noMatch);
			}
		} else if (!wrap && this.filtered.length > 0) {
			this.renderLogViewer();
		}

		this.updateCount();
	},

	applyFilters: function () {
		var text = this.filterText.toLowerCase();
		var level = this.filterLevel;
		var cat = this.filterCategory;

		this.filtered = [];
		for (var i = 0; i < this.entries.length; i++) {
			var e = this.entries[i];
			if (level && e.level !== level) {
				continue;
			}
			if (cat && e.category !== cat) {
				continue;
			}
			if (text && e.message.toLowerCase().indexOf(text) === -1 && e.category.toLowerCase().indexOf(text) === -1) {
				continue;
			}
			this.filtered.push(e);
		}
	},

	updateCount: function () {
		var el = document.getElementById("log-count");
		if (!el) {
			return;
		}
		if (this.entries.length === 0) {
			el.textContent = "";
		} else if (this.filtered.length === this.entries.length) {
			el.textContent = t("log_entries", { count: this.entries.length });
		} else {
			el.textContent = t("log_entries_filtered", { filtered: this.filtered.length, total: this.entries.length });
		}
	},

	escapeHtml: function (str) {
		if (!str) {
			return "";
		}
		return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	},
};

// Dark/light theme toggle
// Brightness4 = half-moon (shown in light mode), Brightness7 = full sun (shown in dark mode)
var ICON_DARK =
	'<path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12zM12 18c-.89 0-1.74-.2-2.5-.55C11.56 16.5 13 14.42 13 12s-1.44-4.5-3.5-5.45C10.26 6.2 11.11 6 12 6c3.31 0 6 2.69 6 6s-2.69 6-6 6"/>';
var ICON_LIGHT =
	'<path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6m0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4"/>';

function updateThemeIcon() {
	var icon = document.getElementById("theme-icon");
	if (!icon) {
		return;
	}
	var isDark =
		document.documentElement.classList.contains("dark") ||
		(!document.documentElement.classList.contains("light") &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);
	icon.innerHTML = isDark ? ICON_DARK : ICON_LIGHT;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toggleTheme() {
	var root = document.documentElement;
	var isDark =
		root.classList.contains("dark") ||
		(!root.classList.contains("light") && window.matchMedia("(prefers-color-scheme: dark)").matches);

	root.classList.remove("dark", "light");
	if (isDark) {
		root.classList.add("light");
		localStorage.setItem("senec-theme", "light");
	} else {
		root.classList.add("dark");
		localStorage.setItem("senec-theme", "dark");
	}
	updateThemeIcon();
}

(function () {
	var saved = localStorage.getItem("senec-theme");
	if (saved === "dark") {
		document.documentElement.classList.add("dark");
	} else if (saved === "light") {
		document.documentElement.classList.add("light");
	}
	updateThemeIcon();
})();

document.addEventListener("DOMContentLoaded", function () {
	app.init();
});
