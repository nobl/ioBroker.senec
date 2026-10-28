"use strict";

/* global app, t, escHtml, chartColors, energyFlow, document, window, requestAnimationFrame */
/* exported liveChart */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Live power curve for the SENEC web dashboard.
 * Renders a real-time Canvas line chart from rolling power data.
 * Supports all connectors — uses whatever power data energyFlow provides.
 * Smooth monotone cubic interpolation between data points.
 */

var liveChart = {
	/** @type {LiveChartPoint[]} */
	buffer: [],

	/** Time window in minutes */
	window: 30,

	/** Which lines are visible */
	visible: {
		pv: true,
		house: true,
		grid: true,
		battery: true,
		wallbox: true,
		soc: false,
	},

	/**
	 * Shared palette entry behind each line.
	 *
	 * `grid` and `battery` are signed here — one line crossing zero — so they map to the
	 * palette's undirected line entries rather than to its import/export pair.
	 */
	_colorKeys: {
		pv: "pv",
		house: "house",
		grid: "gridLine",
		battery: "batteryLine",
		wallbox: "wallbox",
		soc: "batterySoc",
	},

	/** Whether the chart is paused */
	paused: false,

	/** Whether the chart is disabled (collapsed, no recording) */
	disabled: false,

	/** Maximum buffer size — derived from max zoom (30 days at 10s ≈ 260k points, with margin) */
	maxPoints: 300000,

	/** Last recorded timestamp to avoid duplicates */
	_lastTs: 0,

	/**
	 * History adapter instance per state, discovered on init.
	 * Each state is resolved independently — states may be logged by different
	 * adapters, or by none at all, without affecting the others.
	 *
	 * @type {Record<string, {key: string, line: string, instance: string|null}>}
	 */
	_historyStatus: {},

	/**
	 * Oldest timestamp we have *asked* history for — the boundary for delta loading.
	 *
	 * Deliberately the requested start, not the oldest timestamp actually received.
	 * A query that comes back short (history does not reach that far back yet) still
	 * marks the range as attempted, so nothing re-requests it. Tracking the received
	 * timestamp instead makes the "need more data" condition self-perpetuating: the
	 * follow-up query returns only the boundary point already held, the value never
	 * moves, and the retry re-arms every 200 ms for as long as the page is open.
	 */
	_historyRequestedTs: Infinity,

	/** Whether history backfill has been attempted */
	_historyLoaded: false,

	/** Whether a history load is currently in progress */
	_historyLoading: false,

	/**
	 * How close two samples must be to count as the same moment when merging.
	 *
	 * Below the 2 s throttle in `record`, so two live points are never collapsed into one, and
	 * far below the shortest poll interval, so two genuine readings are never collapsed either.
	 */
	MERGE_DEDUPE_MS: 1000,

	/** Pending release of `_historyLoading`, in case the getHistory emit is never acked */
	_loadTimer: null,

	/** Identity of the load that currently owns `_historyLoading` and `_loadTimer`. */
	_loadToken: 0,

	/** True while discovery probes are outstanding, so a second pass is not started on top. */
	_discovering: false,

	/** A gap fill that arrived while a load was running, to be issued when it finishes. */
	/** @type {{start: number, end: number|undefined}|null} */
	_queuedGap: null,

	/**
	 * How long to wait for a getHistory reply before assuming it will not come.
	 *
	 * Generous on purpose: a 30-day range against an SQL backend on a Raspberry Pi takes tens
	 * of seconds, and releasing the flag early only costs a duplicate query, while releasing it
	 * too late costs nothing but a slower recovery from a dropped socket.
	 */
	HISTORY_ACK_TIMEOUT_MS: 90000,

	/**
	 * Incremented whenever the source changes, so a load started for the previous source can be
	 * recognised and discarded when it comes back. Without it, a source switched while a load was
	 * in flight merged the old source's samples into the new source's buffer, and the load the new
	 * source needed was dropped by the in-progress guard.
	 */
	_loadGeneration: 0,

	/**
	 * Newest moment the buffer holds data for, whether a query covered it or `record` collected it.
	 *
	 * Both, deliberately: it is what `resumeAfterReconnect` asks history for the other side of, so
	 * leaving it behind while the page collected live samples made the gap fill re-request minutes
	 * the page already had.
	 *
	 * `_historyRequestedTs` tracks the oldest edge, which is what the pan/zoom backfill needs. It
	 * cannot see a hole in the middle: after a socket reconnect the gap sits between the last
	 * sample taken before the drop and the first one after it, and every backfill trigger compares
	 * against the oldest edge only, so nothing ever asked for it.
	 */
	_newestHistoryTs: 0,

	/** Queued window expansion (minutes) — executed after current load finishes */
	_pendingWindowLoad: 0,

	/** View offset from now in ms (0 = live, >0 = panned back in time) */
	viewOffset: 0,

	/** Whether a drag is in progress */
	_dragging: false,

	/** X position at drag start */
	_dragStartX: 0,

	/** viewOffset at drag start */
	_dragStartOffset: 0,

	/** Whether a requestAnimationFrame repaint is pending */
	_rafPending: false,

	/** Whether a pinch-to-zoom is in progress */
	_pinching: false,

	/** Distance between two touch points at pinch start */
	_pinchStartDist: 0,

	/** Window value at pinch start */
	_pinchStartWindow: 0,

	/** Midpoint X of two touch points at pinch start (logical canvas coords) */
	_pinchStartMidX: 0,

	/**
	 * Chart lines in display order, mapped to their i18n label key.
	 *
	 * Single source of truth for the toggles, the tooltip and the history info panel —
	 * these used to keep their own copies, and a line added to one was missing from
	 * the others.
	 */
	_lineLabels: {
		pv: "total_pv",
		house: "total_consumption",
		grid: "livechart_grid",
		battery: "livechart_battery",
		wallbox: "livechart_wallbox",
		soc: "livechart_soc",
	},

	/**
	 * State keys feeding each chart line, per source.
	 *
	 * Single source of truth for the history loader and the history info panel —
	 * the two must not drift apart. `name` is the internal field name used by
	 * _mergeHistory, `line` is the chart line the field contributes to (several
	 * fields may feed one line, e.g. charge + discharge → battery).
	 *
	 * @param {string} src - Active source ("local", "openapi", "api", "web")
	 * @returns {Array<{name: string, key: string, line: string}>} Field definitions
	 */
	_historyFields: function (src) {
		if (src === "local") {
			return [
				{ name: "pv", key: "ENERGY.GUI_INVERTER_POWER", line: "pv" },
				{ name: "house", key: "ENERGY.GUI_HOUSE_POW", line: "house" },
				{ name: "grid", key: "ENERGY.GUI_GRID_POW", line: "grid" },
				{ name: "battery", key: "ENERGY.GUI_BAT_DATA_POWER", line: "battery" },
				{ name: "wallbox", key: "WALLBOX.APPARENT_CHARGING_POWER.0", line: "wallbox" },
				{ name: "soc", key: "ENERGY.GUI_BAT_DATA_FUEL_CHARGE", line: "soc" },
			];
		}
		if (src === "openapi") {
			return [
				{ name: "pv", key: "_openapi.meter.production", line: "pv" },
				{ name: "house", key: "_openapi.meter.houseConsumption", line: "house" },
				{ name: "grid", key: "_openapi.meter.gridPower", line: "grid" },
				{ name: "battery", key: "_openapi.battery.power", line: "battery" },
				// Not a line of its own: it supplies the export magnitude when gridPower turns out
				// to be import-only. See energyFlow.resolveOpenapiGrid.
				{ name: "surplus", key: "_openapi.meter.powerSurplus", line: "grid" },
				{ name: "soc", key: "_openapi.battery.stateOfCharge", line: "soc" },
			];
		}
		if (src === "api") {
			if (!energyFlow.apiAnlagenId) {
				return [];
			}
			var pfx = `_api.Anlagen.${energyFlow.apiAnlagenId}.Dashboard.currently.`;
			return [
				{ name: "pv", key: `${pfx}powerGenerationInW`, line: "pv" },
				{ name: "house", key: `${pfx}powerConsumptionInW`, line: "house" },
				{ name: "draw", key: `${pfx}gridDrawInW`, line: "grid" },
				{ name: "feed", key: `${pfx}gridFeedInInW`, line: "grid" },
				{ name: "charge", key: `${pfx}batteryChargeInW`, line: "battery" },
				{ name: "discharge", key: `${pfx}batteryDischargeInW`, line: "battery" },
				{ name: "wallbox", key: `${pfx}wallboxInW`, line: "wallbox" },
				{ name: "soc", key: `${pfx}batteryLevelInPercent`, line: "soc" },
			];
		}
		if (src === "web") {
			var wpfx = "_meinsenec.Status.";
			return [
				{ name: "pv", key: `${wpfx}powergenerated.now`, line: "pv" },
				{ name: "house", key: `${wpfx}consumption.now`, line: "house" },
				{ name: "gridImport", key: `${wpfx}gridimport.now`, line: "grid" },
				{ name: "gridExport", key: `${wpfx}gridexport.now`, line: "grid" },
				{ name: "charge", key: `${wpfx}accuexport.now`, line: "battery" },
				{ name: "discharge", key: `${wpfx}accuimport.now`, line: "battery" },
				{ name: "soc", key: `${wpfx}acculevel.now`, line: "soc" },
			];
		}
		return [];
	},

	/**
	 * Whether at least one state has a history adapter enabled.
	 *
	 * @returns {boolean} True if any state can be backfilled
	 */
	_hasHistory: function () {
		for (var name in this._historyStatus) {
			if (this._historyStatus[name].instance) {
				return true;
			}
		}
		return false;
	},

	/** Whether the history info panel is expanded */
	_infoOpen: false,

	/**
	 * Signature of the current recording status — used to detect changes on re-probe.
	 *
	 * @returns {string} Stable "field=instance" signature
	 */
	_historySignature: function () {
		var parts = [];
		for (var name in this._historyStatus) {
			parts.push(`${name}=${this._historyStatus[name].instance || ""}`);
		}
		return parts.sort().join("|");
	},

	/** Toggle the history info panel */
	toggleInfo: function () {
		this._infoOpen = !this._infoOpen;
		if (this._infoOpen) {
			// Re-probe on every open, not just the first. The panel's job is to point at
			// unrecorded states, so a user who just enabled logging must see it here —
			// and get the backfill — without reloading the page. Also covers the disabled
			// chart, where initHistory never runs at all.
			var before = this._historySignature();
			this.discoverHistory(app.conn, app.namespace, app.connectors, function (src) {
				if (liveChart._historySignature() !== before && liveChart._hasHistory()) {
					// Recording changed — refetch the visible window so new states catch up
					liveChart._historyRequestedTs = Infinity;
					liveChart._loadHistory(app.conn, app.namespace, src);
				}
				// Named, not `this`: discoverHistory calls this back bare, so in strict mode
				// `this` is undefined here.
				liveChart.refresh();
			});
		}
		this.refresh();
	},

	/**
	 * Escape a value for HTML output. State IDs and adapter instance names come
	 * from the object database, so they are not trusted markup.
	 *
	 * @param {string} str - Raw value
	 * @returns {string} Escaped value
	 */
	_esc: function (str) {
		return escHtml(str);
	},

	/**
	 * Render the history info panel: which states feed which chart line, and
	 * whether each one is recorded by a history adapter.
	 *
	 * Indicators are read-only — enabling logging happens in the object settings.
	 *
	 * @returns {string} Panel HTML
	 */
	renderHistoryInfo: function () {
		var labelKeys = this._lineLabels;
		var order = Object.keys(labelKeys);
		var names = Object.keys(this._historyStatus);

		var html = '<div class="history-info">';
		html += `<div class="history-info-intro">${t("livechart_history_intro")}</div>`;

		if (names.length === 0) {
			html += `<div class="history-info-intro">${t("livechart_history_pending")}</div></div>`;
			return html;
		}

		for (var oi = 0; oi < order.length; oi++) {
			var line = order[oi];
			var rows = "";
			for (var ni = 0; ni < names.length; ni++) {
				var st = this._historyStatus[names[ni]];
				if (st.line !== line) {
					continue;
				}
				var ok = !!st.instance;
				rows +=
					'<div class="history-info-state">' +
					`<span class="history-info-mark" style="color:${ok ? "#2e7d32" : "#c62828"}">${ok ? "✓" : "✗"}</span>` +
					`<code>${this._esc(st.key)}</code>` +
					`<span class="history-info-inst">${ok ? this._esc(st.instance) : t("livechart_history_not_recorded")}</span>` +
					"</div>";
			}
			if (!rows) {
				continue;
			}
			html +=
				`<div class="history-info-line">` +
				`<div class="history-info-title"><span class="chart-toggle-dot" style="background:${this.color(line)}"></span>${t(labelKeys[line])}</div>` +
				`${rows}</div>`;
		}

		html += `<div class="history-info-hint">${t(this._hasHistory() ? "livechart_history_hint" : "livechart_history_none")}</div>`;
		html += "</div>";
		return html;
	},

	/**
	 * Discover which history adapter records each state, filling _historyStatus.
	 *
	 * Every state is probed independently: states may be recorded by different
	 * history adapters, and a state without recording only costs its own line.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace (e.g. "senec.0")
	 * @param {object} connectors - connector status
	 * @param {function(string): void} [onDone] - called with the resolved source once all states are probed
	 */
	discoverHistory: function (conn, namespace, connectors, onDone) {
		var src = energyFlow.resolveSource(app.states, connectors);
		if (!src) {
			return;
		}

		var fields = this._historyFields(src);
		if (fields.length === 0) {
			// Source not resolvable yet (e.g. API plant id still unknown) — retry on next call
			return;
		}

		this._historyStatus = {};
		var checked = 0;
		// Discovery is a dozen outstanding getObject calls, and a source switch between the
		// first and the last of them empties `_historyStatus` underneath them. Without this,
		// a stale callback re-creates the entry it was probing — so the new source's chart
		// reports a line it does not have, and `onDone` fires a backfill for the old source.
		var generation = this._loadGeneration;

		var checkOne = function (field) {
			liveChart._historyStatus[field.name] = { key: field.key, line: field.line, instance: null };
			conn.emit("getObject", `${namespace}.${field.key}`, function (err, obj) {
				if (generation !== liveChart._loadGeneration) {
					return;
				}
				var entry = liveChart._historyStatus[field.name];
				if (!entry) {
					return;
				}
				if (!err && obj && obj.common && obj.common.custom) {
					// First enabled instance wins — history/sql/influxdb are equivalent here
					for (var inst in obj.common.custom) {
						if (obj.common.custom[inst] && obj.common.custom[inst].enabled) {
							entry.instance = inst;
							break;
						}
					}
				}
				checked++;
				if (checked === fields.length && onDone) {
					onDone(/** @type {string} */ (src));
				}
			});
		};

		for (var fi = 0; fi < fields.length; fi++) {
			checkOne(fields[fi]);
		}
		return;
	},

	/**
	 * Initialize history backfill — discover recording status, then load past data.
	 * Called once after initial state load.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace (e.g. "senec.0")
	 * @param {object} connectors - connector status
	 */
	initHistory: function (conn, namespace, connectors) {
		if (this._historyLoaded || this._discovering || this.disabled) {
			return;
		}
		var src = energyFlow.resolveSource(app.states, connectors);
		if (!src || this._historyFields(src).length === 0) {
			// Source not resolvable yet (e.g. API plant id still unknown) — retry on next call
			return;
		}
		// In progress, not done. Latching "loaded" before the probes answered meant a socket
		// drop during discovery left every entry at instance:null for the life of the tab:
		// `_hasHistory()` false for ever, and every later initHistory refused at the guard
		// above. The flag only becomes true when a probe round actually completes.
		this._discovering = true;

		this.discoverHistory(conn, namespace, connectors, function (src) {
			liveChart._discovering = false;
			liveChart._historyLoaded = true;
			if (liveChart._hasHistory()) {
				liveChart._loadHistory(conn, namespace, src);
			}
			if (liveChart._infoOpen) {
				liveChart.refresh();
			}
		});
	},

	/**
	 * Fill the hole a dropped socket left in the middle of the buffer.
	 *
	 * Nothing else asks for it: every backfill trigger compares the visible window against
	 * `_historyRequestedTs`, the oldest edge, which a reconnect gap is nowhere near. `initHistory`
	 * cannot help either — it is one-shot by design, so it returns immediately after the first
	 * load of the page.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace
	 * @param {object} connectors - connector status
	 */
	resumeAfterReconnect: function (conn, namespace, connectors) {
		if (this.disabled) {
			return;
		}
		// A discovery that was in flight when the socket dropped lost every ack, so its probes
		// will never answer. Start it again rather than waiting on callbacks that are gone.
		if (this._discovering) {
			this._discovering = false;
		}
		if (!this._historyLoaded || !this._hasHistory()) {
			// Never completed a discovery — the ordinary path still applies, and it is the only
			// thing that can re-probe.
			this._historyLoaded = false;
			this.initHistory(conn, namespace, connectors);
			return;
		}
		var src = energyFlow.resolveSource(app.states, connectors);
		if (!src || !this._newestHistoryTs) {
			return;
		}
		var now = Date.now();
		if (this._newestHistoryTs >= now) {
			return;
		}
		this._loadHistory(conn, namespace, src, this._newestHistoryTs, now);
	},

	/**
	 * Load historical data from the discovered history adapter.
	 * Supports delta loading — if startOverride/endOverride are given, only that range is fetched.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace
	 * @param {string} src - active source ("local", "openapi", "api", "web")
	 * @param {number} [startOverride] - custom start timestamp (for delta loading)
	 * @param {number} [endOverride] - custom end timestamp (for delta loading)
	 */
	_loadHistory: function (conn, namespace, src, startOverride, endOverride) {
		// Prevent stacking: skip if a history load is already in progress
		if (this._historyLoading) {
			// Remember what was asked for instead of dropping it. The socket drop that strands
			// a load is the same event that triggers the reconnect gap fill, so the one request
			// that can close a mid-buffer hole arrived exactly when this guard was closed —
			// and no other trigger ever asks for a hole in the middle.
			if (startOverride != null) {
				this._queuedGap =
					this._queuedGap && this._queuedGap.start < startOverride
						? this._queuedGap
						: { start: startOverride, end: endOverride };
			}
			return;
		}
		// Each load owns its own timer and its own claim on the in-progress flag. They used to
		// be single slots mutated by whichever callback arrived, so a superseded load released
		// and re-armed state belonging to the load that replaced it — three concurrent
		// fan-outs, and the survivor left with no ack timeout.
		var generation = this._loadGeneration;
		var token = ++this._loadToken;

		var fields = this._historyFields(src);
		if (fields.length === 0) {
			return;
		}

		// Query only states that actually have a history adapter — each with its own instance
		var toQuery = [];
		/** @type {Record<string, object|null>} */
		var pending = {};
		for (var fi = 0; fi < fields.length; fi++) {
			pending[fields[fi].name] = null;
			var status = this._historyStatus[fields[fi].name];
			if (status && status.instance) {
				toQuery.push({ field: fields[fi], instance: status.instance });
			}
		}
		if (toQuery.length === 0) {
			return;
		}

		this._historyLoading = true;
		// The socket client does not time out an un-acked emit, and `_historyLoading` is the
		// flag every backfill trigger tests before asking for more. A getHistory lost to an
		// adapter restart or a dropped socket therefore wedges the chart for the life of the
		// page. Releasing the flag lets the next trigger retry, and the range this load claimed
		// is given back so that a trigger will actually ask for it again.
		this._clearLoadTimer();
		var priorRequested = this._historyRequestedTs;
		var priorNewest = this._newestHistoryTs;
		this._loadTimer = setTimeout(function () {
			if (token === liveChart._loadToken && liveChart._historyLoading) {
				liveChart._historyLoading = false;
				liveChart._loadTimer = null;
				liveChart._releaseRange(priorRequested, priorNewest);
			}
		}, this.HISTORY_ACK_TIMEOUT_MS);

		var windowMs = this.window * 60 * 1000;
		var start = startOverride != null ? startOverride : Date.now() - windowMs;
		// Infinity means "nothing requested yet" — a delta caller may pass it through as the gap end
		var end = endOverride != null && isFinite(endOverride) ? endOverride : Date.now();

		// Mark the range as attempted before the results arrive, so a short or empty
		// response cannot make the callers re-request it. Rolled back by `_releaseRange` if the
		// request is never answered — otherwise a pan performed while the socket was down, when
		// the client drops the emit without invoking its callback, recorded a range as covered
		// that was never requested, and no trigger would ever ask for it again.
		if (start < this._historyRequestedTs) {
			this._historyRequestedTs = start;
		}
		if (end > this._newestHistoryTs) {
			this._newestHistoryTs = end;
		}

		var done = 0;
		var total = toQuery.length;
		for (var qi = 0; qi < toQuery.length; qi++) {
			(function (q) {
				conn.emit(
					"getHistory",
					`${namespace}.${q.field.key}`,
					{
						instance: q.instance,
						start: start,
						end: end,
						aggregate: "none",
						removeBorderValues: true,
						count: 999999,
					},
					function (histErr, result) {
						// A failing state only loses its own line — the rest still merge
						if (!histErr && result) {
							pending[q.field.name] = result;
						}
						done++;
						if (done === total) {
							// A load that belongs to a source the user has since left must not
							// merge into the new source's buffer. Clearing the in-progress flag
							// is still this callback's job, or nothing would ever load again.
							if (generation !== liveChart._loadGeneration) {
								// Only the load that currently owns the flag and the timer may
								// release them. A superseded load touching them cancelled the
								// ack timeout of the load that replaced it and let a third
								// start on top of both.
								if (token === liveChart._loadToken) {
									liveChart._clearLoadTimer();
									liveChart._historyLoading = false;
									liveChart._historyLoaded = false;
									liveChart.initHistory(conn, namespace, app.connectors);
								}
								return;
							}
							liveChart._mergeHistory(pending, src);
						}
					},
				);
			})(toQuery[qi]);
		}
	},

	/**
	 * Drop the pending release of `_historyLoading`.
	 */
	/**
	 * Give back the range a load claimed but never actually fetched.
	 *
	 * The edges are widened before the request goes out, so that a reply which comes back
	 * short cannot make the callers ask again in a loop. A request that was never answered —
	 * or never sent, which the socket client does silently while disconnected — has to undo
	 * that, or the range stays marked covered with nothing in it and no trigger will ask.
	 *
	 * @param {number} requested - `_historyRequestedTs` before the load claimed its range
	 * @param {number} newest - `_newestHistoryTs` before the load claimed its range
	 */
	_releaseRange: function (requested, newest) {
		this._historyRequestedTs = requested;
		// Not below whatever `record()` has since collected: those points really are present.
		this._newestHistoryTs = Math.max(newest, this._lastTs);
	},

	_clearLoadTimer: function () {
		if (this._loadTimer) {
			clearTimeout(this._loadTimer);
			this._loadTimer = null;
		}
	},

	/**
	 * How far apart two OpenAPI writes may be and still belong to one poll cycle.
	 *
	 * Five seconds, flat. The sections of a cycle land a few hundred milliseconds apart however
	 * slow the appliance is, and the connector clamps the poll interval to at least ten
	 * seconds — so half the interval, which would be the general correctness bound, is never
	 * the binding one and deriving it only produced a branch that could not be taken.
	 *
	 * One exception is real: after an approval or a cleared 401 the connector re-polls after a
	 * second (`APPROVED_REPOLL_MS`), so two cycles can both fall inside this window. Same-cycle
	 * writes are still far nearer, so the nearest-sample lookup picks correctly; only a term
	 * absent from one of the two cycles could be taken from the other.
	 *
	 * @returns {number} Window in milliseconds
	 */
	_cycleWindowMs: function () {
		return 5000;
	},

	/**
	 * Merge history results into the buffer.
	 * Aligns timestamps across multiple state histories.
	 *
	 * @param {object} pending - History results per field
	 * @param {string} src - Source type
	 */
	_mergeHistory: function (pending, src) {
		this._clearLoadTimer();
		this._historyLoading = false;

		// A gap fill refused while this load was running. Nothing else asks for a hole in the
		// middle of the buffer, so dropping it left the hole there for good.
		if (this._queuedGap) {
			var gap = this._queuedGap;
			this._queuedGap = null;
			var gapSrc = energyFlow.resolveSource(app.states, app.connectors);
			if (gapSrc && gap.start < Date.now()) {
				setTimeout(function () {
					liveChart._loadHistory(app.conn, app.namespace, gapSrc, gap.start, gap.end);
				}, 0);
			}
		}

		// If a window expansion was queued while loading, execute it now
		if (this._pendingWindowLoad) {
			var queuedMinutes = this._pendingWindowLoad;
			this._pendingWindowLoad = 0;
			var queuedSrc = energyFlow.resolveSource(app.states, app.connectors);
			if (queuedSrc) {
				var now = Date.now();
				var newStart = now - queuedMinutes * 60 * 1000;
				var gapEnd = this._historyRequestedTs < Infinity ? this._historyRequestedTs : now;
				if (newStart < gapEnd) {
					// Don't return — still merge the current results first, then load the gap
					setTimeout(
						function (s, src2, t1, t2) {
							s._loadHistory(app.conn, app.namespace, src2, t1, t2);
						},
						100,
						this,
						queuedSrc,
						newStart,
						gapEnd,
					);
				}
			}
		}

		// Collect all unique timestamps — try house first, fall back to any field with data
		var primary = pending.house;
		if (!primary || primary.length === 0) {
			for (var pk in pending) {
				if (pending[pk] && pending[pk].length > 0) {
					primary = pending[pk];
					break;
				}
			}
		}
		if (!primary || primary.length === 0) {
			// Nothing came back — _loadHistory already marked the range as requested
			return;
		}

		// Build sorted array of {ts, val} from history result
		var toSorted = function (arr) {
			if (!arr) {
				return [];
			}
			var result = [];
			for (var i = 0; i < arr.length; i++) {
				if (arr[i] && arr[i].ts) {
					result.push({ ts: arr[i].ts, val: arr[i].val });
				}
			}
			result.sort(function (a, b) {
				return a.ts - b.ts;
			});
			return result;
		};

		// Merge all state timelines — store null for fields without data at a timestamp.
		// Each line is rendered independently from its own real data points,
		// letting the monotone cubic spline handle smooth interpolation.
		var mergeTimelines = function (fields) {
			// Collect all timestamps
			var allTs = {};
			for (var fi = 0; fi < fields.length; fi++) {
				for (var di = 0; di < fields[fi].data.length; di++) {
					allTs[fields[fi].data[di].ts] = true;
				}
			}
			var timestamps = Object.keys(allTs)
				.map(Number)
				.sort(function (a, b) {
					return a - b;
				});

			// Build value maps per field for exact lookup
			var maps = [];
			for (var mi = 0; mi < fields.length; mi++) {
				var map = {};
				for (var mdi = 0; mdi < fields[mi].data.length; mdi++) {
					var d = fields[mi].data[mdi];
					if (d && d.ts) {
						// null, not 0. A recorded null means the appliance did not report the
						// value — `markDatapointUnavailable` writes a string for exactly that —
						// and coercing it to a confident zero made it a balance term in the
						// OpenAPI branch, which decides the grid sign: a 3.2 kW export read as
						// a 3.2 kW import.
						var num = d.val === null || d.val === undefined ? null : Number(d.val);
						map[d.ts] = Number.isFinite(num) ? num : null;
					}
				}
				maps.push(map);
			}

			var points = [];
			for (var ti = 0; ti < timestamps.length; ti++) {
				var t = timestamps[ti];
				var point = { ts: t };
				var hasAny = false;
				for (var fj = 0; fj < fields.length; fj++) {
					var cell = maps[fj][t];
					point[fields[fj].name] = cell === undefined ? null : cell;
					// A row that carries only nulls is not a reading. Counting a recorded null
					// as presence produced points with no plotted value at all.
					if (cell !== undefined && cell !== null) {
						hasAny = true;
					}
				}
				if (hasAny) {
					points.push(point);
				}
			}
			return points;
		};

		var points = [];

		// Null-safe helpers for transforms
		var nAbs = function (v) {
			return v != null ? Math.abs(v) : null;
		};
		var nSub = function (a, b) {
			return a != null && b != null ? a - b : a != null ? a : b != null ? -b : null;
		};
		var nMul = function (v, f) {
			return v != null ? v * f : null;
		};
		var nSubMul = function (a, b, f) {
			var d = nSub(a, b);
			return d != null ? d * f : null;
		};

		if (src === "local") {
			var merged = mergeTimelines([
				{ name: "house", data: toSorted(pending.house) },
				{ name: "pv", data: toSorted(pending.pv) },
				{ name: "battery", data: toSorted(pending.battery) },
				{ name: "grid", data: toSorted(pending.grid) },
				{ name: "wallbox", data: toSorted(pending.wallbox) },
				{ name: "soc", data: toSorted(pending.soc) },
			]);
			for (var i = 0; i < merged.length; i++) {
				points.push({
					ts: merged[i].ts,
					pv: nAbs(merged[i].pv),
					battery: merged[i].battery,
					grid: merged[i].grid,
					house: nAbs(merged[i].house),
					wallbox: merged[i].wallbox,
					soc: merged[i].soc,
				});
			}
		} else if (src === "openapi") {
			var oaMerged = mergeTimelines([
				{ name: "house", data: toSorted(pending.house) },
				{ name: "pv", data: toSorted(pending.pv) },
				{ name: "battery", data: toSorted(pending.battery) },
				{ name: "grid", data: toSorted(pending.grid) },
				{ name: "surplus", data: toSorted(pending.surplus) },
				{ name: "soc", data: toSorted(pending.soc) },
			]);

			// Two properties of the recorded data shape this.
			//
			// The balance terms never share a timestamp with the grid sample: each state is
			// written by its own setStateChangedAsync from a different request, and
			// mergeTimelines keys on an exact match. So a term has to be looked up, not read
			// off the row.
			//
			// And an unchanged value is not recorded at all — that is what setStateChangedAsync
			// means — so there may be no sample anywhere near the grid point. A battery sitting
			// at 0 while a full pack exports stops being logged entirely, which is exactly when
			// the direction matters most.
			//
			// Hence two tiers, in this order. Nearest sample within one cycle width, in either
			// direction, wins: the meter section is written after the battery section and
			// therefore sorts later, so a term carried only forward pairs each grid sample with
			// the *previous* cycle's house and PV, and inverts the sign of the first point after
			// every direction reversal. Only when no sample falls inside that window does the
			// last known value carry forward without limit — there, a stale reading beats no
			// reading, because the alternative is discarding the point.
			var cycleWindow = this._cycleWindowMs();
			var seriesOf = function (field, abs) {
				var out = [];
				for (var si = 0; si < oaMerged.length; si++) {
					var raw = abs ? nAbs(oaMerged[si][field]) : oaMerged[si][field];
					if (raw != null) {
						out.push({ ts: oaMerged[si].ts, val: raw });
					}
				}
				return out;
			};
			var series = {
				house: seriesOf("house", true),
				battery: seriesOf("battery", false),
				pv: seriesOf("pv", true),
				surplus: seriesOf("surplus", false),
			};

			// Binary search, not a scan over every sample: scanning here was quadratic in the
			// number of cycles, which at the 30-day zoom is ~43k points per term and froze the
			// tab for minutes.
			var valueAt = function (field, ts) {
				var arr = series[field];
				if (!arr.length) {
					return null;
				}
				var lo = 0;
				var hi = arr.length - 1;
				var prev = -1;
				while (lo <= hi) {
					var mid = (lo + hi) >> 1;
					if (arr[mid].ts <= ts) {
						prev = mid;
						lo = mid + 1;
					} else {
						hi = mid - 1;
					}
				}
				var next = prev + 1;
				var gapPrev = prev >= 0 ? ts - arr[prev].ts : Infinity;
				var gapNext = next < arr.length ? arr[next].ts - ts : Infinity;
				if (gapPrev <= cycleWindow || gapNext <= cycleWindow) {
					return gapNext < gapPrev ? arr[next].val : arr[prev].val;
				}
				// Outside the window: carry the last known value forward without limit. Where
				// there is nothing earlier at all — the leading edge of a loaded range, whose
				// preceding sample `removeBorderValues: true` has excluded — the first later
				// sample is reached backwards instead. That is a guess either way, and the
				// alternative is discarding a point whose magnitude was really measured.
				return prev >= 0 ? arr[prev].val : arr[0].val;
			};

			// One point per cycle, not per row. Each `_openapi.*` state is written by its own
			// setStateChangedAsync at its own millisecond, so mergeTimelines — which keys on an
			// exact timestamp — yields a row per state, each carrying a single field. Emitting
			// a point for every one of them inflated the buffer several-fold with near-empty
			// objects, and a row for a term that is not plotted at all (surplus feeds the grid
			// magnitude, it is not a line) produced a point with no data whatsoever.
			var cycles = [];
			for (var ci = 0; ci < oaMerged.length; ci++) {
				var row = oaMerged[ci];
				var last = cycles[cycles.length - 1];
				if (last && row.ts - last.ts <= cycleWindow) {
					for (var fname in row) {
						if (fname !== "ts" && row[fname] != null) {
							last[fname] = row[fname];
						}
					}
				} else {
					cycles.push(Object.assign({}, row));
				}
			}
			oaMerged = cycles;

			for (var oi = 0; oi < oaMerged.length; oi++) {
				var om = oaMerged[oi];
				var oaHouse = nAbs(om.house);
				var oaPv = nAbs(om.pv);
				var oaGrid = null;
				if (om.grid != null) {
					if (om.grid < 0) {
						// Signed reading — definitive on its own, no balance needed.
						oaGrid = om.grid;
					} else {
						var nHouse = oaHouse != null ? oaHouse : valueAt("house", om.ts);
						var nBattery = om.battery != null ? om.battery : valueAt("battery", om.ts);
						var nPv = oaPv != null ? oaPv : valueAt("pv", om.ts);
						if (nHouse != null && nBattery != null && nPv != null) {
							oaGrid = energyFlow.resolveOpenapiGrid(
								om.grid,
								nHouse,
								nBattery,
								nPv,
								om.surplus != null ? om.surplus : valueAt("surplus", om.ts),
							);
						} else {
							// A term with no sample anywhere in the range — not recorded at all,
							// by any adapter. The magnitude is still a measurement, so the point
							// is kept rather than dropped, read as the commoner direction.
							oaGrid = Math.abs(om.grid);
						}
					}
				}
				points.push({
					ts: om.ts,
					pv: oaPv,
					battery: om.battery,
					grid: oaGrid,
					house: oaHouse,
					wallbox: null,
					soc: om.soc,
				});
			}
		} else if (src === "api") {
			var apiMerged = mergeTimelines([
				{ name: "house", data: toSorted(pending.house) },
				{ name: "pv", data: toSorted(pending.pv) },
				{ name: "charge", data: toSorted(pending.charge) },
				{ name: "discharge", data: toSorted(pending.discharge) },
				{ name: "draw", data: toSorted(pending.draw) },
				{ name: "feed", data: toSorted(pending.feed) },
				{ name: "wallbox", data: toSorted(pending.wallbox) },
				{ name: "soc", data: toSorted(pending.soc) },
			]);
			for (var ai = 0; ai < apiMerged.length; ai++) {
				var am = apiMerged[ai];
				points.push({
					ts: am.ts,
					pv: am.pv,
					battery: nSub(am.charge, am.discharge),
					grid: nSub(am.draw, am.feed),
					house: am.house,
					wallbox: am.wallbox,
					soc: am.soc,
				});
			}
		} else if (src === "web") {
			var webMerged = mergeTimelines([
				{ name: "house", data: toSorted(pending.house) },
				{ name: "pv", data: toSorted(pending.pv) },
				{ name: "charge", data: toSorted(pending.charge) },
				{ name: "discharge", data: toSorted(pending.discharge) },
				{ name: "gridImport", data: toSorted(pending.gridImport) },
				{ name: "gridExport", data: toSorted(pending.gridExport) },
				{ name: "soc", data: toSorted(pending.soc) },
			]);
			for (var wi = 0; wi < webMerged.length; wi++) {
				var wm = webMerged[wi];
				points.push({
					ts: wm.ts,
					pv: nMul(wm.pv, 1000),
					battery: nSubMul(wm.charge, wm.discharge, 1000),
					grid: nSubMul(wm.gridImport, wm.gridExport, 1000),
					house: nMul(wm.house, 1000),
					wallbox: null,
					soc: wm.soc,
				});
			}
		}

		if (points.length === 0) {
			return;
		}

		// Sort by timestamp and prepend to buffer (history is older than live data)
		points.sort(function (a, b) {
			return a.ts - b.ts;
		});

		// Strip leading all-zero/null points (adapter startup artifacts)
		while (
			points.length > 0 &&
			(points[0].pv == null || points[0].pv === 0) &&
			(points[0].battery == null || points[0].battery === 0) &&
			(points[0].grid == null || points[0].grid === 0) &&
			(points[0].house == null || points[0].house === 0) &&
			(points[0].wallbox == null || points[0].wallbox === 0) &&
			// SOC too, or an idle night with real charge level would be stripped as an artifact
			(points[0].soc == null || points[0].soc === 0)
		) {
			points.shift();
		}
		if (points.length === 0) {
			return;
		}

		// Merge the two sorted series rather than letting history replace its whole span.
		// Dropping every buffer point between the oldest and newest loaded sample erased live
		// points the history adapter had not written out yet — the recorder flushes on its own
		// schedule, so a reconnect gap fill ending at `now` routinely returns less than the page
		// had already collected, and the chart lost minutes it was displaying a moment earlier.
		// Where both carry the same moment, history wins: it is what was stored, and the live
		// point is only this page's reading of it.
		var stitched = [];
		var mbi = 0;
		var mpi = 0;
		while (mbi < this.buffer.length || mpi < points.length) {
			if (mpi >= points.length) {
				stitched.push(this.buffer[mbi++]);
			} else if (mbi >= this.buffer.length) {
				stitched.push(points[mpi++]);
			} else if (Math.abs(this.buffer[mbi].ts - points[mpi].ts) <= this.MERGE_DEDUPE_MS) {
				stitched.push(points[mpi++]);
				mbi++;
			} else if (this.buffer[mbi].ts < points[mpi].ts) {
				stitched.push(this.buffer[mbi++]);
			} else {
				stitched.push(points[mpi++]);
			}
		}
		this.buffer = stitched;

		// Trim to max — only at live view so panned-back data isn't lost
		if (this.viewOffset === 0 && this.buffer.length > this.maxPoints) {
			this.buffer = this.buffer.slice(this.buffer.length - this.maxPoints);
		}

		// Update only live chart container
		this.refresh();

		// After merge, check if current view still needs more data (user panned further during load)
		var viewWindowMs = liveChart.window * 60 * 1000;
		var viewStart = Date.now() - liveChart.viewOffset - viewWindowMs;
		if (viewStart < liveChart._historyRequestedTs && liveChart._hasHistory()) {
			var viewSrc = energyFlow.resolveSource(app.states, app.connectors);
			if (viewSrc) {
				setTimeout(
					function (s, src2, t1, t2) {
						s._loadHistory(app.conn, app.namespace, src2, t1, t2);
					},
					200,
					liveChart,
					viewSrc,
					viewStart,
					liveChart._historyRequestedTs,
				);
			}
		}
	},

	/**
	 * Record a new data point from the current energyFlow state.
	 * Called on each state update that affects power values.
	 */
	record: function () {
		if (this.paused || this.disabled) {
			return;
		}
		var d = energyFlow.data;
		if (!energyFlow.hasData) {
			return;
		}

		var now = Date.now();
		// Deduplicate — skip if less than 2s since last record
		if (now - this._lastTs < 2000) {
			return;
		}
		// Never behind the previous point. A backward clock step — NTP correction, VM resume,
		// container skew — would otherwise leave the buffer locally unsorted, and the merge
		// below advances two cursors on the assumption that it is not.
		if (now <= this._lastTs) {
			now = this._lastTs + 1;
		}
		this._lastTs = now;

		// Include separate external sources in totals for live chart
		var extPv = 0;
		var extBat = 0;
		for (var epi = 0; epi < (d.externalPv || []).length; epi++) {
			extPv += Math.abs(d.externalPv[epi].power);
		}
		for (var ebi = 0; ebi < (d.externalBattery || []).length; ebi++) {
			extBat += d.externalBattery[ebi].power;
		}

		this.buffer.push({
			ts: now,
			pv: (d.pv || 0) + extPv,
			battery: (d.battery || 0) + extBat, // signed: + charge, - discharge
			grid: d.grid || 0, // signed: + import, - export
			house: d.house || 0,
			wallbox: d.wallbox || 0,
			soc: d.soc, // percent, null when the source does not report it
		});

		// The page now holds data for this moment, so a reconnect must not ask history for it.
		// `_newestHistoryTs` is the only record of where the covered range ends; leaving it at
		// the last query's end made resumeAfterReconnect re-request every minute the page had
		// been collecting live, which the merge then had to reconcile against itself.
		if (now > this._newestHistoryTs) {
			this._newestHistoryTs = now;
		}

		// Trim to max buffer size — only when at live view, so panned-back data isn't lost
		if (this.viewOffset === 0 && this.buffer.length > this.maxPoints) {
			this.buffer = this.buffer.slice(this.buffer.length - this.maxPoints);
		}
	},

	/**
	 * Get visible data points within the current time window
	 */
	getVisibleData: function () {
		var windowMs = this.window * 60 * 1000;
		var end = Date.now() - this.viewOffset;
		var start = end - windowMs;
		var result = [];
		for (var i = 0; i < this.buffer.length; i++) {
			if (this.buffer[i].ts >= start && this.buffer[i].ts <= end) {
				result.push(this.buffer[i]);
			}
		}
		return result;
	},

	/**
	 * Downsample data to at most maxPts points.
	 * Uses min/max per bucket to preserve peaks and valleys.
	 *
	 * @param {LiveChartPoint[]} data - Input data points
	 * @param {number} maxPts - Maximum output points
	 * @returns {LiveChartPoint[]} Downsampled data
	 */
	downsample: function (data, maxPts) {
		if (data.length <= maxPts) {
			return data;
		}
		// Always keep first and last
		var result = [data[0]];
		var bucketSize = (data.length - 2) / (maxPts - 2);
		for (var b = 0; b < maxPts - 2; b++) {
			var start = Math.floor(b * bucketSize) + 1;
			var end = Math.floor((b + 1) * bucketSize) + 1;
			if (end > data.length - 1) {
				end = data.length - 1;
			}
			// Find point with largest absolute power value in this bucket
			var best = start;
			var bestMag = 0;
			for (var i = start; i < end; i++) {
				var mag =
					Math.abs(data[i].pv || 0) +
					Math.abs(data[i].house || 0) +
					Math.abs(data[i].grid || 0) +
					Math.abs(data[i].battery || 0);
				if (mag > bestMag) {
					bestMag = mag;
					best = i;
				}
			}
			result.push(data[best]);
		}
		result.push(data[data.length - 1]);
		return result;
	},

	/**
	 * Render the live chart card
	 */
	render: function () {
		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("livechart_title")}</h2>`;
		// History info toggle
		var infoCls = this._infoOpen ? " active" : "";
		html +=
			`<button class="chart-toggle${infoCls}" style="--toggle-color:#757575;margin-left:auto;margin-right:8px" ` +
			`title="${t("livechart_history_info")}" onclick="liveChart.toggleInfo()">ⓘ</button>`;
		// Enable/disable toggle
		var disabledCls = this.disabled ? "" : " active";
		html += `<button class="chart-toggle${disabledCls}" style="--toggle-color:#757575;margin-right:8px" onclick="liveChart.toggleDisabled()">`;
		html += `<span class="chart-toggle-dot" style="background:#757575"></span>${this.disabled ? "▶" : "●"}</button>`;
		if (this.disabled) {
			html += "</div>";
			if (this._infoOpen) {
				html += this.renderHistoryInfo();
			}
			html += "</div>";
			return html;
		}
		html += '<div class="day-totals-tabs">';

		// Time window tabs
		var windows = [10, 30, 60, 120, 360, 720, 1440];
		var windowLabels = ["10m", "30m", "1h", "2h", "6h", "12h", "24h"];
		for (var i = 0; i < windows.length; i++) {
			var isActive = Math.abs(this.window - windows[i]) < 0.5;
			var cls = isActive ? "period-tab active" : "period-tab";
			html += `<button class="${cls}" onclick="liveChart.setWindow(${windows[i]})">${windowLabels[i]}</button>`;
		}

		// Pause button
		var pauseCls = this.paused ? " active" : "";
		html += `<button class="period-tab${pauseCls}" onclick="liveChart.togglePause()">${this.paused ? "▶" : "⏸"}</button>`;

		// Live snap-back button (visible when panned away from now)
		if (this.viewOffset > 0) {
			html += `<button class="period-tab active" style="background:#4caf50;color:#fff;border-color:#4caf50" onclick="liveChart.goLive()">● Live</button>`;
		}

		html += "</div></div>";

		// Line toggles
		html += '<div class="chart-toggles">';
		var labelKeys = this._lineLabels;
		var lines = Object.keys(labelKeys);
		for (var li = 0; li < lines.length; li++) {
			var key = lines[li];
			var active = this.visible[key] ? " active" : "";
			html +=
				`<button class="chart-toggle${active}" style="--toggle-color:${this.color(key)}" ` +
				`onclick="liveChart.toggleLine('${key}')">` +
				`<span class="chart-toggle-dot" style="background:${this.color(key)}"></span>${t(labelKeys[key])}</button>`;
		}
		var colorsCls = this._colorsOpen ? " active" : "";
		html +=
			`<button class="chart-toggle${colorsCls}" style="--toggle-color:#757575" onclick="liveChart.toggleColors()">` +
			`<span class="chart-toggle-dot" style="background:#757575"></span>${t("colors_title")}</button>`;
		html += "</div>";

		if (this._colorsOpen) {
			html += chartColors.renderEditor("liveChart", this._colorRows());
		}

		if (this._infoOpen) {
			html += this.renderHistoryInfo();
		}

		// Loading / data range indicator
		if (this._historyLoading) {
			html += `<div style="text-align:center;padding:4px 0;font-size:12px;color:#ff9800">${t("livechart_loading_history")}</div>`;
		} else if (this.buffer.length > 0) {
			var oldest = new Date(this.buffer[0].ts);
			var newest = new Date(this.buffer[this.buffer.length - 1].ts);
			var fmt = function (d) {
				return `${d.getDate()}.${(d.getMonth() + 1).toString().padStart(2, "0")}. ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
			};
			html +=
				`<div style="text-align:center;padding:2px 0;font-size:11px;color:#999">` +
				`${t("livechart_points", { count: this.buffer.length })} | ${fmt(oldest)} — ${fmt(newest)}</div>`;
		}

		// Canvas chart
		var data = this.getVisibleData();
		if (data.length < 2 && this.viewOffset === 0) {
			html += `<div class="stat-label">${t("livechart_waiting")}</div>`;
		} else {
			html +=
				'<div class="chart-scroll"><canvas id="livechart-canvas" width="1400" height="350" style="width:100%;cursor:grab;touch-action:none"></canvas></div>';
		}

		html += "</div>";
		return html;
	},

	// Current tooltip point: {x, y, val, key} or null
	/** @type {{x: number, y: number, val: number, key: string}|null} */
	_tooltipPoint: null,

	// Rendered line points per key for tooltip lookup
	/** @type {Record<string, Array<{x: number, y: number, val: number}>>} */
	_tooltipData: {},

	// Paint the chart onto the canvas element
	paintCanvas: function () {
		var canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("livechart-canvas"));
		if (!canvas) {
			return;
		}
		var ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}

		var chartW = 1400,
			chartH = 350;
		var padL = 55,
			padR = this.visible.soc ? 42 : 15,
			padT = 15,
			padB = 35;
		var plotW = chartW - padL - padR;
		var plotH = chartH - padT - padB;

		// High-DPI setup
		var dpr = window.devicePixelRatio || 1;
		canvas.width = chartW * dpr;
		canvas.height = chartH * dpr;
		canvas.style.width = "100%";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Clear
		ctx.clearRect(0, 0, chartW, chartH);

		// Get fresh visible data
		var data = this.getVisibleData();

		// Calculate Y range
		var yMin = 0,
			yMax = 0;
		// SOC is excluded deliberately: it is a percentage on its own right-hand axis
		var lines = ["pv", "house", "grid", "battery", "wallbox"];
		for (var di = 0; di < data.length; di++) {
			for (var li = 0; li < lines.length; li++) {
				if (!this.visible[lines[li]]) {
					continue;
				}
				var val = data[di][lines[li]];
				if (val == null) {
					continue;
				}
				if (val > yMax) {
					yMax = val;
				}
				if (val < yMin) {
					yMin = val;
				}
			}
		}

		// Ensure some range
		if (yMax === yMin) {
			yMax = yMin + 100;
		}
		// Add 10% padding
		var range = yMax - yMin;
		yMax += range * 0.1;
		yMin -= range * 0.1;

		// Nice round numbers
		yMax = this.niceAxis(yMax, true);
		yMin = this.niceAxis(yMin, false);
		range = yMax - yMin;

		// Time range
		var windowMs = this.window * 60 * 1000;
		var tMax = Date.now() - this.viewOffset;
		var tMin = tMax - windowMs;
		var tRange = tMax - tMin;

		// Grid lines and Y axis labels
		var gridLines = 5;
		var useKw = Math.abs(yMax) >= 10000 || Math.abs(yMin) >= 10000;
		ctx.strokeStyle = "#666";
		ctx.lineWidth = 0.5;
		ctx.font = "10px sans-serif";
		ctx.fillStyle = "#999";
		ctx.textBaseline = "middle";
		for (var g = 0; g <= gridLines; g++) {
			var yVal = yMin + (range / gridLines) * g;
			var yPos = padT + plotH - ((yVal - yMin) / range) * plotH;
			ctx.beginPath();
			ctx.moveTo(padL, yPos);
			ctx.lineTo(chartW - padR, yPos);
			ctx.stroke();
			var label = useKw ? (yVal / 1000).toFixed(1) : String(Math.round(yVal));
			ctx.textAlign = "right";
			ctx.fillText(label, padL - 5, yPos);
		}

		// Y axis unit label (rotated)
		var unitLabel = useKw ? "kW" : "W";
		ctx.save();
		ctx.translate(12, padT + plotH / 2);
		ctx.rotate(-Math.PI / 2);
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillStyle = "#999";
		ctx.fillText(unitLabel, 0, 0);
		ctx.restore();

		// Zero line if range spans zero
		if (yMin < 0 && yMax > 0) {
			var zeroY = padT + plotH - ((0 - yMin) / range) * plotH;
			ctx.save();
			ctx.strokeStyle = "#666";
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 2]);
			ctx.beginPath();
			ctx.moveTo(padL, zeroY);
			ctx.lineTo(chartW - padR, zeroY);
			ctx.stroke();
			ctx.restore();
		}

		// X axis time labels
		var xLabelCount = Math.min(8, Math.floor(plotW / 100));
		ctx.fillStyle = "#999";
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		ctx.font = "10px sans-serif";
		for (var xi = 0; xi <= xLabelCount; xi++) {
			var xTs = tMin + (tRange / xLabelCount) * xi;
			var xPos = padL + (plotW / xLabelCount) * xi;
			var d = new Date(xTs);
			var timeStr = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
			ctx.fillText(timeStr, xPos, chartH - 5);
		}

		// Midnight markers
		var startDay = new Date(tMin);
		startDay.setHours(0, 0, 0, 0);
		if (startDay.getTime() < tMin) {
			startDay.setDate(startDay.getDate() + 1);
		}
		for (var midnight = startDay.getTime(); midnight < tMax; midnight += 86400000) {
			var mxPos = padL + ((midnight - tMin) / tRange) * plotW;
			if (mxPos > padL + 30 && mxPos < chartW - padR - 30) {
				ctx.save();
				ctx.strokeStyle = "#888";
				ctx.lineWidth = 1;
				ctx.setLineDash([6, 3]);
				ctx.beginPath();
				ctx.moveTo(mxPos, padT);
				ctx.lineTo(mxPos, padT + plotH);
				ctx.stroke();
				ctx.restore();
				var mDate = new Date(midnight);
				var dateStr = `${mDate.getDate()}.${(mDate.getMonth() + 1).toString().padStart(2, "0")}.`;
				ctx.fillStyle = "#aaa";
				ctx.font = "bold 10px sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "alphabetic";
				ctx.fillText(dateStr, mxPos, padT - 3);
				ctx.font = "10px sans-serif";
				ctx.fillStyle = "#999";
			}
		}

		// Data lines — clipped to plot area
		ctx.save();
		ctx.beginPath();
		ctx.rect(padL, padT, plotW, plotH);
		ctx.clip();

		this._tooltipData = {};
		for (var rl = 0; rl < lines.length; rl++) {
			var lineKey = lines[rl];
			if (!this.visible[lineKey]) {
				continue;
			}
			this.paintLine(ctx, data, lineKey, tMin, tRange, yMin, range, padL, padT, plotW, plotH);
		}
		// SOC rides its own fixed 0-100% scale over the same plot area
		if (this.visible.soc) {
			this.paintLine(ctx, data, "soc", tMin, tRange, 0, 100, padL, padT, plotW, plotH);
		}
		ctx.restore();

		if (this.visible.soc) {
			ctx.font = "10px sans-serif";
			ctx.fillStyle = this.color("soc");
			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			for (var pct = 0; pct <= 100; pct += 25) {
				ctx.fillText(`${pct}%`, chartW - padR + 5, padT + plotH - (pct / 100) * plotH);
			}
		}

		// Tooltip overlay
		if (this._tooltipPoint) {
			var tp = this._tooltipPoint;
			var tpKw = Math.abs(tp.val) >= 10000;
			var tpStr =
				tp.key === "soc"
					? `${Math.round(tp.val)}%`
					: tpKw
						? `${(tp.val / 1000).toFixed(2)} kW`
						: `${Math.round(tp.val)} W`;
			var tpLabel = `${t(this.getLabelKey(tp.key))}: ${tpStr}`;

			ctx.font = "12px sans-serif";
			var tpWidth = ctx.measureText(tpLabel).width + 12;
			var tpHeight = 22;
			var tpX = tp.x + 10;
			var tpY = tp.y - 10 - tpHeight;
			// Keep tooltip within canvas bounds
			if (tpX + tpWidth > chartW - padR) {
				tpX = tp.x - 10 - tpWidth;
			}
			if (tpY < padT) {
				tpY = tp.y + 10;
			}

			// Draw dot
			ctx.beginPath();
			ctx.arc(tp.x, tp.y, 4, 0, Math.PI * 2);
			ctx.fillStyle = this.color(tp.key);
			ctx.fill();

			// Draw tooltip box
			ctx.fillStyle = "rgba(30,30,30,0.9)";
			ctx.beginPath();
			ctx.roundRect(tpX, tpY, tpWidth, tpHeight, 4);
			ctx.fill();
			ctx.fillStyle = "#fff";
			ctx.textBaseline = "middle";
			ctx.textAlign = "left";
			ctx.fillText(tpLabel, tpX + 6, tpY + tpHeight / 2);
		}
	},

	// Paint a single data line onto the canvas
	paintLine: function (ctx, data, key, tMin, tRange, yMin, range, padL, padT, plotW, plotH) {
		// Extract non-null points for this specific line
		var raw = [];
		for (var i = 0; i < data.length; i++) {
			var val = data[i][key];
			if (val != null) {
				raw.push({ ts: data[i].ts, val: val });
			}
		}

		// Downsample per line — max 400 points, preserving peaks/valleys
		if (raw.length > 400) {
			var sampled = [raw[0]];
			var bucketSize = (raw.length - 2) / 398;
			for (var b = 0; b < 398; b++) {
				var bStart = Math.floor(b * bucketSize) + 1;
				var bEnd = Math.floor((b + 1) * bucketSize) + 1;
				if (bEnd > raw.length - 1) {
					bEnd = raw.length - 1;
				}
				var best = bStart;
				var bestMag = 0;
				for (var bi = bStart; bi < bEnd; bi++) {
					var mag = Math.abs(raw[bi].val);
					if (mag > bestMag) {
						bestMag = mag;
						best = bi;
					}
				}
				sampled.push(raw[best]);
			}
			sampled.push(raw[raw.length - 1]);
			raw = sampled;
		}

		// Convert to screen coordinates
		var points = [];
		for (var pi = 0; pi < raw.length; pi++) {
			var x = padL + ((raw[pi].ts - tMin) / tRange) * plotW;
			var y = padT + plotH - ((raw[pi].val - yMin) / range) * plotH;
			points.push({ x: x, y: y, val: raw[pi].val });
		}

		if (points.length < 2) {
			return;
		}

		// Store for tooltip lookup
		this._tooltipData[key] = points;

		var color = this.color(key);

		// Draw the line using monotone cubic bezier curves
		var tangentData = this.monotoneTangents(points);
		var tangents = tangentData.tangents;
		var dx = tangentData.dx;

		ctx.beginPath();
		ctx.moveTo(points[0].x, points[0].y);
		for (var p = 0; p < points.length - 1; p++) {
			var dxi = dx[p] / 3;
			var cp1x = points[p].x + dxi;
			var cp1y = points[p].y + tangents[p] * dxi;
			var cp2x = points[p + 1].x - dxi;
			var cp2y = points[p + 1].y - tangents[p + 1] * dxi;
			ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, points[p + 1].x, points[p + 1].y);
		}
		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.globalAlpha = 0.9;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		ctx.stroke();
		ctx.globalAlpha = 1.0;

		// Tooltip dots at actual data points (sparse — every Nth to avoid clutter)
		var dotInterval = Math.max(1, Math.floor(points.length / 30));
		for (var di = 0; di < points.length; di += dotInterval) {
			ctx.beginPath();
			ctx.arc(points[di].x, points[di].y, 2.5, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.7;
			ctx.fill();
		}
		// Always show last point
		if (points.length > 1) {
			var last = points[points.length - 1];
			ctx.beginPath();
			ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
			ctx.globalAlpha = 1.0;
			ctx.fillStyle = color;
			ctx.fill();
		}
		ctx.globalAlpha = 1.0;
	},

	getLabelKey: function (key) {
		return this._lineLabels[key] || key;
	},

	/**
	 * Current color of one line.
	 *
	 * @param {string} key - Line key
	 * @returns {string} CSS color
	 */
	color: function (key) {
		return chartColors.get(this._colorKeys[key] || key);
	},

	/**
	 * The palette entries this chart offers, in the order its toggles appear.
	 *
	 * @returns {string[]} Palette keys
	 */
	_colorRows: function () {
		var keys = [];
		for (var key in this._lineLabels) {
			keys.push(this._colorKeys[key]);
		}
		return keys;
	},

	/**
	 * Redraw the card in place.
	 *
	 * Also the path the periodic render takes, so the canvas is always repainted against
	 * the markup that was just written rather than the previous frame's.
	 */
	refresh: function () {
		if (chartColors.fill("livechart-container", this.render.bind(this))) {
			this.bindDrag();
			this.paintCanvas();
		}
	},

	// Compute monotone cubic Hermite tangents (Fritsch-Carlson method).
	// Returns {tangents, dx} arrays for use with bezierCurveTo.
	monotoneTangents: function (points) {
		var n = points.length;
		var dx = [],
			dy = [],
			m = [];
		for (var i = 0; i < n - 1; i++) {
			dx.push(points[i + 1].x - points[i].x);
			dy.push(points[i + 1].y - points[i].y);
			m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
		}

		if (n === 2) {
			return { tangents: [m[0], m[0]], dx: dx };
		}

		// Tangent at each point
		var tangents = [m[0]];
		for (var j = 1; j < n - 1; j++) {
			if (m[j - 1] * m[j] <= 0) {
				tangents.push(0);
			} else {
				tangents.push((m[j - 1] + m[j]) / 2);
			}
		}
		tangents.push(m[n - 2]);

		// Monotonicity constraint
		for (var k = 0; k < n - 1; k++) {
			if (m[k] === 0) {
				tangents[k] = 0;
				tangents[k + 1] = 0;
			} else {
				var alpha = tangents[k] / m[k];
				var beta = tangents[k + 1] / m[k];
				var sum = alpha * alpha + beta * beta;
				if (sum > 9) {
					var s = 3 / Math.sqrt(sum);
					tangents[k] = s * alpha * m[k];
					tangents[k + 1] = s * beta * m[k];
				}
			}
		}

		return { tangents: tangents, dx: dx };
	},

	/**
	 * Round to a nice axis value
	 *
	 * @param {number} val - Value to round
	 * @param {boolean} up - Round up if true, down if false
	 */
	niceAxis: function (val, up) {
		if (val === 0) {
			return 0;
		}
		var abs = Math.abs(val);
		var magnitude = Math.pow(10, Math.floor(Math.log10(abs)));
		var step = magnitude;
		if (abs / magnitude > 5) {
			step = magnitude;
		} else if (abs / magnitude > 2) {
			step = magnitude / 2;
		} else {
			step = magnitude / 5;
		}

		if (up) {
			return val >= 0 ? Math.ceil(val / step) * step : Math.floor(val / step) * step;
		}
		return val >= 0 ? Math.floor(val / step) * step : Math.ceil(val / step) * step;
	},

	// --- Interaction handlers ---

	setWindow: function (minutes) {
		var oldWindow = this.window;
		this.window = minutes;
		// Load history when expanding to a larger window
		if (minutes > oldWindow && this._hasHistory()) {
			var src = energyFlow.resolveSource(app.states, app.connectors);
			if (src) {
				if (this._historyLoading) {
					// A load is in progress — queue a full reload for the new window
					this._pendingWindowLoad = minutes;
				} else {
					var now = Date.now();
					var newStart = now - minutes * 60 * 1000;
					// Delta: only fetch the gap between new start and oldest data we have
					var gapEnd = this._historyRequestedTs < Infinity ? this._historyRequestedTs : now;
					if (newStart < gapEnd) {
						this._loadHistory(app.conn, app.namespace, src, newStart, gapEnd);
					}
				}
			}
		}
		this.refresh();
	},

	togglePause: function () {
		this.paused = !this.paused;
		if (!this.paused) {
			// Same hole as a collapsed chart, for the same reason.
			this._fillCollectionGap();
		}
		this.refresh();
	},

	toggleLine: function (key) {
		this.visible[key] = !this.visible[key];
		this.refresh();
	},

	toggleDisabled: function () {
		this.disabled = !this.disabled;
		if (!this.disabled) {
			// Fill the hole first, and only then record. `record()` advances `_newestHistoryTs`
			// to now, which is the very boundary the gap fill needs — doing it the other way
			// round left the collapsed interval empty with no path to fill it, the same defect
			// a dropped socket has, for a cause the user chose.
			this._fillCollectionGap();
			this.record();
			if (!this._historyLoaded) {
				this.initHistory(app.conn, app.namespace, app.connectors);
			}
		}
		this.refresh();
	},

	/**
	 * Ask history for whatever was missed while the chart was not collecting.
	 *
	 * `record()` returns early while paused or collapsed, so the buffer gains a hole in the
	 * middle — and a mid-buffer hole is exactly what no pan or zoom trigger can see, because
	 * they all compare the visible window against the oldest edge.
	 */
	_fillCollectionGap: function () {
		if (!app.conn || !this._hasHistory() || !this._newestHistoryTs) {
			return;
		}
		var now = Date.now();
		if (this._newestHistoryTs >= now) {
			return;
		}
		var src = energyFlow.resolveSource(app.states, app.connectors);
		if (src) {
			this._loadHistory(app.conn, app.namespace, src, this._newestHistoryTs, now);
		}
	},

	/** Snap back to live (rightmost edge = now) */
	goLive: function () {
		this.viewOffset = 0;
		// _historyRequestedTs is deliberately kept: snapping forward needs no older data,
		// and the range it covers has already been fetched
		this.refresh();
	},

	/** Whether document-level drag listeners are installed */
	_dragBound: false,

	// Bind drag/touch/wheel on the canvas element (re-called after each render).
	// Document-level move/end listeners are installed once.
	bindDrag: function () {
		var canvas = document.getElementById("livechart-canvas");
		if (!canvas) {
			return;
		}

		// Mouse, touch, wheel, and mousemove on canvas (re-bound after each render)
		canvas.addEventListener("mousedown", liveChart._onMouseDown);
		canvas.addEventListener("touchstart", liveChart._onTouchStart, { passive: false });
		canvas.addEventListener("wheel", liveChart._onWheel, { passive: false });
		canvas.addEventListener("mousemove", liveChart._onMouseMove);
		canvas.addEventListener("mouseleave", liveChart._onMouseLeave);

		// Document-level listeners: install once, never re-add
		if (!this._dragBound) {
			this._dragBound = true;
			document.addEventListener("mousemove", liveChart._onDragMove);
			document.addEventListener("touchmove", liveChart._onTouchMove, { passive: false });
			document.addEventListener("mouseup", liveChart._onDragEnd);
			document.addEventListener("touchend", liveChart._onTouchEnd);
		}
	},

	/** Timestamp of last touch event — to suppress compatibility mouse events on mobile */
	_lastTouchTs: 0,

	_onMouseDown: function (/** @type {MouseEvent} */ e) {
		// Suppress compatibility mouse events generated by touch on mobile
		if (Date.now() - liveChart._lastTouchTs < 500) {
			return;
		}
		liveChart._dragging = true;
		liveChart._tooltipPoint = null;
		liveChart._dragStartX = liveChart._getEventX(e);
		liveChart._dragStartOffset = liveChart.viewOffset;
		var canvas = document.getElementById("livechart-canvas");
		if (canvas) {
			canvas.style.cursor = "grabbing";
		}
		e.preventDefault();
	},

	// Tooltip on hover — find nearest data point and repaint
	_onMouseMove: function (/** @type {MouseEvent} */ e) {
		if (liveChart._dragging) {
			return;
		}
		var canvas = document.getElementById("livechart-canvas");
		if (!canvas) {
			return;
		}
		var rect = canvas.getBoundingClientRect();
		var mx = ((e.clientX - rect.left) / rect.width) * 1400;
		var my = ((e.clientY - rect.top) / rect.height) * 350;

		// Find nearest point across all visible lines
		var bestDist = Infinity;
		var bestPoint = null;
		var bestKey = "";
		var keys = Object.keys(liveChart._tooltipData);
		for (var ki = 0; ki < keys.length; ki++) {
			var pts = liveChart._tooltipData[keys[ki]];
			for (var pi = 0; pi < pts.length; pi++) {
				var ddx = pts[pi].x - mx;
				var ddy = pts[pi].y - my;
				var dist = ddx * ddx + ddy * ddy;
				if (dist < bestDist) {
					bestDist = dist;
					bestPoint = pts[pi];
					bestKey = keys[ki];
				}
			}
		}

		// Show tooltip if within 30px (logical)
		if (bestPoint && bestDist < 900) {
			liveChart._tooltipPoint = { x: bestPoint.x, y: bestPoint.y, val: bestPoint.val, key: bestKey };
		} else {
			liveChart._tooltipPoint = null;
		}
		liveChart.paintCanvas();
	},

	// Clear tooltip when mouse leaves canvas
	_onMouseLeave: function () {
		if (liveChart._tooltipPoint) {
			liveChart._tooltipPoint = null;
			liveChart.paintCanvas();
		}
	},

	/** Timestamp of last touch re-render — for throttling */
	_touchRenderTs: 0,

	_onTouchStart: function (/** @type {TouchEvent} */ e) {
		liveChart._lastTouchTs = Date.now();
		if (e.touches.length === 2) {
			liveChart._pinching = true;
			liveChart._dragging = false;
			liveChart._pinchStartDist = liveChart._getTouchDist(e);
			liveChart._pinchStartWindow = liveChart.window;
			e.preventDefault();
		} else if (e.touches.length === 1) {
			liveChart._dragging = true;
			liveChart._pinching = false;
			liveChart._dragStartX = liveChart._getEventX(e);
			liveChart._dragStartOffset = liveChart.viewOffset;
			e.preventDefault();
		}
	},

	/** Clamp viewOffset so user can't pan far past buffered data */
	_clampOffset: function () {
		if (liveChart.buffer.length === 0) {
			return;
		}
		var oldestTs = liveChart.buffer[0].ts;
		// Allow panning until oldest data reaches the right edge of the view.
		// The empty left side triggers lazy-load to fill it.
		var maxOffset = Date.now() - oldestTs;
		if (maxOffset < 0) {
			maxOffset = 0;
		}
		if (liveChart.viewOffset > maxOffset) {
			liveChart.viewOffset = maxOffset;
		}
	},

	// Handle mouse move (drag pan)
	_onDragMove: function (/** @type {MouseEvent} */ e) {
		if (!liveChart._dragging) {
			return;
		}
		liveChart._applyDrag(liveChart._getEventX(e));
	},

	// Handle touch move — repaint canvas with updated offset
	_onTouchMove: function (/** @type {TouchEvent} */ e) {
		if (liveChart._pinching && e.touches.length >= 2) {
			e.preventDefault();
			var dist = liveChart._getTouchDist(e);
			if (liveChart._pinchStartDist === 0) {
				return;
			}
			var ratio = liveChart._pinchStartDist / dist;
			liveChart.window = Math.max(
				liveChart._minZoom,
				Math.min(liveChart._maxZoom, liveChart._pinchStartWindow * ratio),
			);
			liveChart._clampOffset();
			liveChart.paintCanvas();
			return;
		}
		if (liveChart._dragging && e.touches.length === 1) {
			e.preventDefault();
			var currentX = liveChart._getEventX(e);
			var dx = currentX - liveChart._dragStartX;
			var plotW = 1400 - 55 - 15;
			var windowMs = liveChart.window * 60 * 1000;
			var dtMs = (dx / plotW) * windowMs;
			liveChart.viewOffset = Math.max(0, liveChart._dragStartOffset + dtMs);
			liveChart._clampOffset();
			// Throttle repaint to screen refresh rate
			if (!liveChart._rafPending) {
				liveChart._rafPending = true;
				requestAnimationFrame(function () {
					liveChart._rafPending = false;
					liveChart.paintCanvas();
				});
			}
		}
	},

	// Common drag logic for mouse and touch
	_applyDrag: function (currentX) {
		var dx = currentX - liveChart._dragStartX;
		var plotW = 1400 - 55 - 15;
		var windowMs = liveChart.window * 60 * 1000;
		var dtMs = (dx / plotW) * windowMs;
		liveChart.viewOffset = Math.max(0, liveChart._dragStartOffset + dtMs);
		liveChart._clampOffset();

		// Lazy-load: if view is near the edge of buffered data, trigger history load
		var viewStart = Date.now() - liveChart.viewOffset - windowMs;
		if (viewStart < liveChart._historyRequestedTs && liveChart._hasHistory() && !liveChart._historyLoading) {
			var src = energyFlow.resolveSource(app.states, app.connectors);
			if (src) {
				liveChart._loadHistory(app.conn, app.namespace, src, viewStart, liveChart._historyRequestedTs);
			}
		}

		liveChart.paintCanvas();
	},

	_onDragEnd: function () {
		if (!liveChart._dragging) {
			return;
		}
		liveChart._dragging = false;
		var canvas = document.getElementById("livechart-canvas");
		if (canvas) {
			canvas.style.cursor = "grab";
		}
		liveChart._finishInteraction();
	},

	_onTouchEnd: function (/** @type {TouchEvent} */ e) {
		if (liveChart._pinching) {
			if (e.touches.length >= 2) {
				return;
			}
			liveChart._pinching = false;
			liveChart._finishInteraction();
			return;
		}
		if (liveChart._dragging) {
			liveChart._dragging = false;
			liveChart._finishInteraction();
		}
	},

	// Common end-of-interaction logic
	_finishInteraction: function () {
		// Snap to live if very close to now
		if (liveChart.viewOffset < 5000) {
			liveChart.viewOffset = 0;
		}
		// Lazy-load if view extends past buffered data
		if (liveChart.viewOffset > 0 && liveChart._hasHistory() && !liveChart._historyLoading) {
			var windowMs = liveChart.window * 60 * 1000;
			var viewStart = Date.now() - liveChart.viewOffset - windowMs;
			if (viewStart < liveChart._historyRequestedTs) {
				var src = energyFlow.resolveSource(app.states, app.connectors);
				if (src) {
					liveChart._loadHistory(app.conn, app.namespace, src, viewStart, liveChart._historyRequestedTs);
				}
			}
		}
		liveChart.refresh();
	},

	// Get X in logical canvas coords from mouse or single-touch event
	_getEventX: function (/** @type {MouseEvent|TouchEvent} */ e) {
		var canvas = document.getElementById("livechart-canvas");
		if (!canvas) {
			return 0;
		}
		var rect = canvas.getBoundingClientRect();
		var te = /** @type {TouchEvent} */ (e);
		var me = /** @type {MouseEvent} */ (e);
		var clientX = te.touches && te.touches.length > 0 ? te.touches[0].clientX : me.clientX;
		return ((clientX - rect.left) / rect.width) * 1400;
	},

	// Get distance between two touch points
	_getTouchDist: function (/** @type {TouchEvent} */ e) {
		if (e.touches.length < 2) {
			return 0;
		}
		var dx = e.touches[1].clientX - e.touches[0].clientX;
		var dy = e.touches[1].clientY - e.touches[0].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	},

	// Get midpoint X of two touch points in screen coords
	_getTouchMidX: function (/** @type {TouchEvent} */ e) {
		if (e.touches.length < 2) {
			return 0;
		}
		return (e.touches[0].clientX + e.touches[1].clientX) / 2;
	},

	/** Minimum zoom in minutes */
	_minZoom: 5,
	/** Maximum zoom in minutes */
	_maxZoom: 43200, // 30 days

	_onWheel: function (/** @type {WheelEvent} */ e) {
		e.preventDefault();
		var factor = e.deltaY > 0 ? 1.3 : 1 / 1.3; // scroll down = zoom out
		var oldWindow = liveChart.window;
		var newWindow = Math.max(liveChart._minZoom, Math.min(liveChart._maxZoom, oldWindow * factor));

		// Zoom centered on cursor position within the chart
		var canvas = document.getElementById("livechart-canvas");
		if (canvas) {
			var rect = canvas.getBoundingClientRect();
			var cursorRatio = (e.clientX - rect.left) / rect.width; // 0=left edge, 1=right edge
			// Adjust viewOffset so the time under the cursor stays fixed
			var oldWindowMs = oldWindow * 60 * 1000;
			var newWindowMs = newWindow * 60 * 1000;
			var cursorTimeFromRight = (1 - cursorRatio) * oldWindowMs;
			var newCursorTimeFromRight = (1 - cursorRatio) * newWindowMs;
			liveChart.viewOffset = Math.max(0, liveChart.viewOffset + (newCursorTimeFromRight - cursorTimeFromRight));
		}

		liveChart.window = newWindow;
		liveChart._clampOffset();

		// Load history if zooming out past what we have
		if (newWindow > oldWindow && liveChart._hasHistory() && !liveChart._historyLoading) {
			var src = energyFlow.resolveSource(app.states, app.connectors);
			if (src) {
				var now = Date.now();
				var newStart = now - liveChart.viewOffset - newWindow * 60 * 1000;
				var gapEnd = liveChart._historyRequestedTs < Infinity ? liveChart._historyRequestedTs : now;
				if (newStart < gapEnd) {
					liveChart._loadHistory(app.conn, app.namespace, src, newStart, gapEnd);
				}
			}
		}

		liveChart.paintCanvas();
	},
};

// The editor behaves identically for every chart, so its handlers come from one place.
chartColors.bindOwner("liveChart", liveChart);
