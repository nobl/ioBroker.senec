"use strict";

/* global app, t, energyFlow, document, window, requestAnimationFrame */
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

	/** Line colors — match energy flow diagram */
	colors: {
		pv: "#f9a825",
		house: "#e65100",
		grid: "#1565c0",
		battery: "#2e7d32",
		wallbox: "#7e57c2",
		soc: "#00897b",
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
	 * @param {string} src - Active source ("local", "api", "web")
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
				app.renderDashboard();
			});
		}
		app.renderDashboard();
	},

	/**
	 * Escape a value for HTML output. State IDs and adapter instance names come
	 * from the object database, so they are not trusted markup.
	 *
	 * @param {string} str - Raw value
	 * @returns {string} Escaped value
	 */
	_esc: function (str) {
		return String(str == null ? "" : str)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
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
				`<div class="history-info-title"><span class="chart-toggle-dot" style="background:${this.colors[line]}"></span>${t(labelKeys[line])}</div>` +
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
		var src = energyFlow.resolveSource(connectors);
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

		var checkOne = function (field) {
			liveChart._historyStatus[field.name] = { key: field.key, line: field.line, instance: null };
			conn.emit("getObject", `${namespace}.${field.key}`, function (err, obj) {
				if (!err && obj && obj.common && obj.common.custom) {
					// First enabled instance wins — history/sql/influxdb are equivalent here
					for (var inst in obj.common.custom) {
						if (obj.common.custom[inst] && obj.common.custom[inst].enabled) {
							liveChart._historyStatus[field.name].instance = inst;
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
		if (this._historyLoaded || this.disabled) {
			return;
		}
		var src = energyFlow.resolveSource(connectors);
		if (!src || this._historyFields(src).length === 0) {
			// Source not resolvable yet (e.g. API plant id still unknown) — retry on next call
			return;
		}
		this._historyLoaded = true;

		this.discoverHistory(conn, namespace, connectors, function (src) {
			if (liveChart._hasHistory()) {
				liveChart._loadHistory(conn, namespace, src);
			}
			if (liveChart._infoOpen) {
				app.renderDashboard();
			}
		});
	},

	/**
	 * Load historical data from the discovered history adapter.
	 * Supports delta loading — if startOverride/endOverride are given, only that range is fetched.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace
	 * @param {string} src - active source ("local", "api", "web")
	 * @param {number} [startOverride] - custom start timestamp (for delta loading)
	 * @param {number} [endOverride] - custom end timestamp (for delta loading)
	 */
	_loadHistory: function (conn, namespace, src, startOverride, endOverride) {
		// Prevent stacking: skip if a history load is already in progress
		if (this._historyLoading) {
			return;
		}

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

		var windowMs = this.window * 60 * 1000;
		var start = startOverride != null ? startOverride : Date.now() - windowMs;
		// Infinity means "nothing requested yet" — a delta caller may pass it through as the gap end
		var end = endOverride != null && isFinite(endOverride) ? endOverride : Date.now();

		// Mark the range as attempted before the results arrive, so a short or empty
		// response cannot make the callers re-request it
		if (start < this._historyRequestedTs) {
			this._historyRequestedTs = start;
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
							liveChart._mergeHistory(pending, src);
						}
					},
				);
			})(toQuery[qi]);
		}
	},

	/**
	 * Merge history results into the buffer.
	 * Aligns timestamps across multiple state histories.
	 *
	 * @param {object} pending - History results per field
	 * @param {string} src - Source type
	 */
	_mergeHistory: function (pending, src) {
		this._historyLoading = false;

		// If a window expansion was queued while loading, execute it now
		if (this._pendingWindowLoad) {
			var queuedMinutes = this._pendingWindowLoad;
			this._pendingWindowLoad = 0;
			var queuedSrc = energyFlow.resolveSource(app.connectors);
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
						map[d.ts] = Number(d.val) || 0;
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
					if (maps[fj][t] !== undefined) {
						point[fields[fj].name] = maps[fj][t];
						hasAny = true;
					} else {
						point[fields[fj].name] = null;
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

		// Merge history into buffer — avoid duplicates, maintain sort order
		var latestHistoryTs = points[points.length - 1].ts;
		var oldestHistoryTs = points[0].ts;
		// Find existing buffer points that are outside the new history range
		var before = [];
		var after = [];
		for (var li = 0; li < this.buffer.length; li++) {
			if (this.buffer[li].ts < oldestHistoryTs) {
				before.push(this.buffer[li]);
			} else if (this.buffer[li].ts > latestHistoryTs) {
				after.push(this.buffer[li]);
			}
		}

		this.buffer = before.concat(points, after);

		// Trim to max — only at live view so panned-back data isn't lost
		if (this.viewOffset === 0 && this.buffer.length > this.maxPoints) {
			this.buffer = this.buffer.slice(this.buffer.length - this.maxPoints);
		}

		// Update only live chart container
		var el = document.getElementById("livechart-container");
		if (el) {
			el.innerHTML = this.render();
			this.bindDrag();
			this.paintCanvas();
		}

		// After merge, check if current view still needs more data (user panned further during load)
		var viewWindowMs = liveChart.window * 60 * 1000;
		var viewStart = Date.now() - liveChart.viewOffset - viewWindowMs;
		if (viewStart < liveChart._historyRequestedTs && liveChart._hasHistory()) {
			var viewSrc = energyFlow.resolveSource(app.connectors);
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
				`<button class="chart-toggle${active}" style="--toggle-color:${this.colors[key]}" ` +
				`onclick="liveChart.toggleLine('${key}')">` +
				`<span class="chart-toggle-dot" style="background:${this.colors[key]}"></span>${t(labelKeys[key])}</button>`;
		}
		html += "</div>";

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
			ctx.fillStyle = this.colors.soc;
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
			ctx.fillStyle = this.colors[tp.key];
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

		var color = this.colors[key];

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
			var src = energyFlow.resolveSource(app.connectors);
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
		app.renderDashboard();
	},

	togglePause: function () {
		this.paused = !this.paused;
		app.renderDashboard();
	},

	toggleLine: function (key) {
		this.visible[key] = !this.visible[key];
		app.renderDashboard();
	},

	toggleDisabled: function () {
		this.disabled = !this.disabled;
		if (!this.disabled) {
			// Re-enable: record current state and try history backfill
			this.record();
			if (!this._historyLoaded) {
				this.initHistory(app.conn, app.namespace, app.connectors);
			}
		}
		app.renderDashboard();
	},

	/** Snap back to live (rightmost edge = now) */
	goLive: function () {
		this.viewOffset = 0;
		// _historyRequestedTs is deliberately kept: snapping forward needs no older data,
		// and the range it covers has already been fetched
		app.renderDashboard();
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
			var src = energyFlow.resolveSource(app.connectors);
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
				var src = energyFlow.resolveSource(app.connectors);
				if (src) {
					liveChart._loadHistory(app.conn, app.namespace, src, viewStart, liveChart._historyRequestedTs);
				}
			}
		}
		app.renderDashboard();
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
			var src = energyFlow.resolveSource(app.connectors);
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
