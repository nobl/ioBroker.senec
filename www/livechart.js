"use strict";

/* global app, t, energyFlow, document, window */
/* exported liveChart */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Live power curve for the SENEC web dashboard.
 * Renders a real-time SVG line chart from rolling power data.
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
	},

	/** Line colors — match energy flow diagram */
	colors: {
		pv: "#f9a825",
		house: "#e65100",
		grid: "#1565c0",
		battery: "#2e7d32",
		wallbox: "#7e57c2",
	},

	/** Whether the chart is paused */
	paused: false,

	/** Whether the chart is disabled (collapsed, no recording) */
	disabled: false,

	/** Maximum buffer size (points) — limit memory. Downsampling keeps rendering fast */
	maxPoints: 50000,

	/** Last recorded timestamp to avoid duplicates */
	_lastTs: 0,

	/** @type {string|null} History adapter instance (e.g. "influxdb.0") — discovered on init */
	_historyInstance: null,

	/** Oldest timestamp loaded from history — for delta loading on window expansion */
	_historyOldestTs: Infinity,

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

	/**
	 * State keys per source for history queries
	 */
	_stateKeys: {
		local: {
			pv: "ENERGY.GUI_INVERTER_POWER",
			battery: "ENERGY.GUI_BAT_DATA_POWER",
			grid: "ENERGY.GUI_GRID_POW",
			house: "ENERGY.GUI_HOUSE_POW",
			wallbox: "WALLBOX.APPARENT_CHARGING_POWER.0",
		},

		/** @type {Record<string, string|null>} */
		api: {
			// Filled dynamically with discovered anlagenId prefix
			pv: null,
			battery: null,
			grid: null,
			house: null,
			wallbox: null,
		},

		/** @type {Record<string, string|null>} */
		web: {
			pv: "_meinsenec.Status.powergenerated.now",
			battery: null, // Web uses charge/discharge separately — handled in transform
			grid: null, // Web uses import/export separately — handled in transform
			house: "_meinsenec.Status.consumption.now",
			wallbox: null,
		},
	},

	/**
	 * Initialize history backfill — discover history adapter and load past data.
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
		this._historyLoaded = true;

		// Determine which source to use
		var src = energyFlow.resolveSource(connectors);
		if (!src) {
			return;
		}

		// Build API state keys if needed
		if (src === "api" && energyFlow.apiAnlagenId) {
			var pfx = `_api.Anlagen.${energyFlow.apiAnlagenId}.Dashboard.currently.`;
			this._stateKeys.api.pv = `${pfx}powerGenerationInW`;
			this._stateKeys.api.battery = `${pfx}batteryChargeInW`; // will need discharge too
			this._stateKeys.api.grid = `${pfx}gridDrawInW`; // will need feedIn too
			this._stateKeys.api.house = `${pfx}powerConsumptionInW`;
			this._stateKeys.api.wallbox = `${pfx}wallboxInW`;
		}

		// Pick a representative state to check for history
		var checkState;
		if (src === "local") {
			checkState = `${namespace}.ENERGY.GUI_HOUSE_POW`;
		} else if (src === "api" && this._stateKeys.api.house) {
			checkState = `${namespace}.${this._stateKeys.api.house}`;
		} else if (src === "web") {
			checkState = `${namespace}.${this._stateKeys.web.house}`;
		} else {
			return;
		}

		conn.emit("getObject", checkState, function (err, obj) {
			if (err || !obj || !obj.common || !obj.common.custom) {
				return;
			}
			// Find first enabled history instance
			var instance = null;
			for (var key in obj.common.custom) {
				if (obj.common.custom[key] && obj.common.custom[key].enabled) {
					instance = key;
					break;
				}
			}
			if (!instance) {
				return;
			}
			liveChart._historyInstance = instance;

			liveChart._loadHistory(conn, namespace, /** @type {string} */ (src));
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
		this._historyLoading = true;

		var windowMs = this.window * 60 * 1000;
		var start = startOverride != null ? startOverride : Date.now() - windowMs;
		var end = endOverride != null ? endOverride : Date.now();
		var instance = this._historyInstance;

		if (src === "local") {
			this._loadHistoryLocal(conn, namespace, instance, start, end);
		} else if (src === "api") {
			this._loadHistoryApi(conn, namespace, instance, start, end);
		} else if (src === "web") {
			this._loadHistoryWeb(conn, namespace, instance, start, end);
		}
	},

	/**
	 * Query history for a list of fields, skipping states without history enabled.
	 *
	 * @param {object} conn - socket.io connection
	 * @param {string} namespace - adapter namespace
	 * @param {string} instance - history adapter instance
	 * @param {number} start - query start timestamp
	 * @param {number} end - query end timestamp
	 * @param {Array<{name: string, key: string}>} fields - fields to query
	 * @param {string} src - source type for _mergeHistory
	 */
	_queryHistoryFields: function (conn, namespace, instance, start, end, fields, src) {
		var pending = {};
		for (var pi = 0; pi < fields.length; pi++) {
			pending[fields[pi].name] = null;
		}

		// Check which states have history enabled, then query only those
		var checked = 0;
		var toQuery = [];

		var checkOne = function (field) {
			var fullId = `${namespace}.${field.key}`;
			conn.emit("getObject", fullId, function (err, obj) {
				if (
					!err &&
					obj &&
					obj.common &&
					obj.common.custom &&
					obj.common.custom[instance] &&
					obj.common.custom[instance].enabled
				) {
					toQuery.push(field);
				}
				checked++;
				if (checked === fields.length) {
					if (toQuery.length === 0) {
						liveChart._historyLoading = false;
						return;
					}
					var done = 0;
					var total = toQuery.length;
					for (var qi = 0; qi < toQuery.length; qi++) {
						(function (f) {
							conn.emit(
								"getHistory",
								`${namespace}.${f.key}`,
								{
									instance: instance,
									start: start,
									end: end,
									aggregate: "none",
									returnNewestEntries: true,
									removeBorderValues: true,
									count: 50000,
								},
								function (histErr, result) {
									if (!histErr && result) {
										pending[f.name] = result;
									}
									done++;
									if (done === total) {
										liveChart._mergeHistory(pending, src);
									}
								},
							);
						})(toQuery[qi]);
					}
				}
			});
		};

		for (var fi = 0; fi < fields.length; fi++) {
			checkOne(fields[fi]);
		}
	},

	_loadHistoryLocal: function (conn, namespace, instance, start, end) {
		var keys = this._stateKeys.local;
		this._queryHistoryFields(
			conn,
			namespace,
			instance,
			start,
			end,
			[
				{ name: "pv", key: keys.pv },
				{ name: "battery", key: keys.battery },
				{ name: "grid", key: keys.grid },
				{ name: "house", key: keys.house },
				{ name: "wallbox", key: keys.wallbox },
			],
			"local",
		);
	},

	_loadHistoryApi: function (conn, namespace, instance, start, end) {
		var keys = this._stateKeys.api;
		if (!keys.house) {
			return;
		}

		var pfx = `_api.Anlagen.${energyFlow.apiAnlagenId}.Dashboard.currently.`;
		this._queryHistoryFields(
			conn,
			namespace,
			instance,
			start,
			end,
			[
				{ name: "pv", key: `${pfx}powerGenerationInW` },
				{ name: "house", key: `${pfx}powerConsumptionInW` },
				{ name: "charge", key: `${pfx}batteryChargeInW` },
				{ name: "discharge", key: `${pfx}batteryDischargeInW` },
				{ name: "draw", key: `${pfx}gridDrawInW` },
				{ name: "feed", key: `${pfx}gridFeedInInW` },
				{ name: "wallbox", key: `${pfx}wallboxInW` },
			],
			"api",
		);
	},

	_loadHistoryWeb: function (conn, namespace, instance, start, end) {
		var wpfx = "_meinsenec.Status.";
		this._queryHistoryFields(
			conn,
			namespace,
			instance,
			start,
			end,
			[
				{ name: "pv", key: `${wpfx}powergenerated.now` },
				{ name: "house", key: `${wpfx}consumption.now` },
				{ name: "charge", key: `${wpfx}accuexport.now` },
				{ name: "discharge", key: `${wpfx}accuimport.now` },
				{ name: "gridImport", key: `${wpfx}gridimport.now` },
				{ name: "gridExport", key: `${wpfx}gridexport.now` },
			],
			"web",
		);
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
				var gapEnd = this._historyOldestTs < Infinity ? this._historyOldestTs : now;
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

		// Collect all unique timestamps from the primary state (house for reliability)
		var primary = pending.house;
		if (!primary || primary.length === 0) {
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
			]);
			for (var i = 0; i < merged.length; i++) {
				points.push({
					ts: merged[i].ts,
					pv: nAbs(merged[i].pv),
					battery: merged[i].battery,
					grid: merged[i].grid,
					house: nAbs(merged[i].house),
					wallbox: merged[i].wallbox,
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
			(points[0].wallbox == null || points[0].wallbox === 0)
		) {
			points.shift();
		}
		if (points.length === 0) {
			return;
		}

		// Track oldest loaded timestamp for delta loading
		if (points[0].ts < this._historyOldestTs) {
			this._historyOldestTs = points[0].ts;
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

		// Trim to max
		if (this.buffer.length > this.maxPoints) {
			this.buffer = this.buffer.slice(this.buffer.length - this.maxPoints);
		}

		// Update only live chart container
		var el = document.getElementById("livechart-container");
		if (el) {
			el.innerHTML = this.render();
			this.bindDrag();
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
		});

		// Trim to max buffer size
		if (this.buffer.length > this.maxPoints) {
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
		// Enable/disable toggle
		var disabledCls = this.disabled ? "" : " active";
		html += `<button class="chart-toggle${disabledCls}" style="--toggle-color:#757575;margin-left:auto;margin-right:8px" onclick="liveChart.toggleDisabled()">`;
		html += `<span class="chart-toggle-dot" style="background:#757575"></span>${this.disabled ? "▶" : "●"}</button>`;
		if (this.disabled) {
			html += "</div></div>";
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
		var lines = ["pv", "house", "grid", "battery", "wallbox"];
		var labelKeys = {
			pv: "total_pv",
			house: "total_consumption",
			grid: "livechart_grid",
			battery: "livechart_battery",
			wallbox: "livechart_wallbox",
		};
		for (var li = 0; li < lines.length; li++) {
			var key = lines[li];
			var active = this.visible[key] ? " active" : "";
			html +=
				`<button class="chart-toggle${active}" style="--toggle-color:${this.colors[key]}" ` +
				`onclick="liveChart.toggleLine('${key}')">` +
				`<span class="chart-toggle-dot" style="background:${this.colors[key]}"></span>${t(labelKeys[key])}</button>`;
		}
		html += "</div>";

		// SVG chart
		var data = this.getVisibleData();
		if (data.length < 2 && this.viewOffset === 0) {
			html += `<div class="stat-label">${t("livechart_waiting")}</div>`;
		} else {
			html += this.renderSvg(data);
		}

		html += "</div>";
		return html;
	},

	/**
	 * Render the SVG line chart
	 *
	 * @param {Array} data - Visible data points
	 */
	renderSvg: function (data) {
		var chartW = 1400,
			chartH = 350;
		var padL = 55,
			padR = 15,
			padT = 15,
			padB = 35;
		var plotW = chartW - padL - padR;
		var plotH = chartH - padT - padB;

		// Calculate Y range
		var yMin = 0,
			yMax = 0;
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

		// Time range — use viewOffset-based window, not data extent
		var windowMs = this.window * 60 * 1000;
		var tMax = Date.now() - this.viewOffset;
		var tMin = tMax - windowMs;
		var tRange = tMax - tMin;

		var svg = `<svg class="chart-svg" id="livechart-svg" viewBox="0 0 ${chartW} ${chartH}" xmlns="http://www.w3.org/2000/svg" style="cursor:grab">`;

		// Grid lines and Y axis labels
		var gridLines = 5;
		var useKw = Math.abs(yMax) >= 10000 || Math.abs(yMin) >= 10000;
		for (var g = 0; g <= gridLines; g++) {
			var yVal = yMin + (range / gridLines) * g;
			var yPos = padT + plotH - ((yVal - yMin) / range) * plotH;
			svg += `<line x1="${padL}" y1="${yPos.toFixed(1)}" x2="${chartW - padR}" y2="${yPos.toFixed(1)}" stroke="var(--color-border)" stroke-width="0.5"/>`;
			var label = useKw ? (yVal / 1000).toFixed(1) : Math.round(yVal);
			svg += `<text x="${padL - 5}" y="${yPos.toFixed(1)}" dy="4" text-anchor="end" fill="#999" font-size="10">${label}</text>`;
		}
		// Y axis unit label
		var unitLabel = useKw ? "kW" : "W";
		svg += `<text x="12" y="${padT + plotH / 2}" text-anchor="middle" fill="#999" font-size="10" transform="rotate(-90,12,${padT + plotH / 2})">${unitLabel}</text>`;

		// Zero line if range spans zero
		if (yMin < 0 && yMax > 0) {
			var zeroY = padT + plotH - ((0 - yMin) / range) * plotH;
			svg += `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${chartW - padR}" y2="${zeroY.toFixed(1)}" stroke="#666" stroke-width="1" stroke-dasharray="4,2"/>`;
		}

		// X axis time labels
		var xLabelCount = Math.min(8, Math.floor(plotW / 100));
		for (var xi = 0; xi <= xLabelCount; xi++) {
			var xTs = tMin + (tRange / xLabelCount) * xi;
			var xPos = padL + (plotW / xLabelCount) * xi;
			var d = new Date(xTs);
			var timeStr = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
			svg += `<text x="${xPos.toFixed(1)}" y="${chartH - 5}" text-anchor="middle" fill="#999" font-size="10">${timeStr}</text>`;
		}

		// Midnight markers — vertical line + date label at each day boundary
		var startDay = new Date(tMin);
		startDay.setHours(0, 0, 0, 0);
		if (startDay.getTime() < tMin) {
			startDay.setDate(startDay.getDate() + 1);
		}
		for (var midnight = startDay.getTime(); midnight < tMax; midnight += 86400000) {
			var mxPos = padL + ((midnight - tMin) / tRange) * plotW;
			if (mxPos > padL + 30 && mxPos < chartW - padR - 30) {
				svg += `<line x1="${mxPos.toFixed(1)}" y1="${padT}" x2="${mxPos.toFixed(1)}" y2="${padT + plotH}" stroke="#888" stroke-width="1" stroke-dasharray="6,3"/>`;
				var mDate = new Date(midnight);
				var dateStr = `${mDate.getDate()}.${(mDate.getMonth() + 1).toString().padStart(2, "0")}.`;
				svg += `<text x="${mxPos.toFixed(1)}" y="${padT - 3}" text-anchor="middle" fill="#aaa" font-size="10" font-weight="bold">${dateStr}</text>`;
			}
		}

		// Render lines
		for (var rl = 0; rl < lines.length; rl++) {
			var lineKey = lines[rl];
			if (!this.visible[lineKey]) {
				continue;
			}
			svg += this.renderLine(data, lineKey, tMin, tRange, yMin, range, padL, padT, plotW, plotH);
		}

		svg += "</svg>";
		return `<div class="chart-scroll">${svg}</div>`;
	},

	/**
	 * Render a single line with monotone cubic interpolation
	 *
	 * @param {Array} data - Data points
	 * @param {string} key - Data key (pv, house, grid, battery, wallbox)
	 * @param {number} tMin - Time range start
	 * @param {number} tRange - Time range span
	 * @param {number} yMin - Y axis minimum
	 * @param {number} range - Y axis range
	 * @param {number} padL - Left padding
	 * @param {number} padT - Top padding
	 * @param {number} plotW - Plot width
	 * @param {number} plotH - Plot height
	 * @returns {string} SVG path elements
	 */
	renderLine: function (data, key, tMin, tRange, yMin, range, padL, padT, plotW, plotH) {
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
			return "";
		}

		// Monotone cubic spline path
		var pathD = this.monotonePath(points);
		var color = this.colors[key];

		var svg = `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;

		// Tooltip dots at actual data points (sparse — every Nth to avoid clutter)
		var dotInterval = Math.max(1, Math.floor(points.length / 30));
		for (var di = 0; di < points.length; di += dotInterval) {
			var useKw = Math.abs(points[di].val) >= 10000;
			var valStr = useKw ? `${(points[di].val / 1000).toFixed(2)} kW` : `${Math.round(points[di].val)} W`;
			var tooltip = `${t(this.getLabelKey(key))}: ${valStr}`;
			// Invisible larger hit area for tooltip
			svg += `<circle cx="${points[di].x.toFixed(1)}" cy="${points[di].y.toFixed(1)}" r="10" fill="transparent" style="cursor:pointer"><title>${tooltip}</title></circle>`;
			svg += `<circle cx="${points[di].x.toFixed(1)}" cy="${points[di].y.toFixed(1)}" r="2.5" fill="${color}" opacity="0.7" pointer-events="none"/>`;
		}
		// Always show last point
		if (points.length > 1) {
			var last = points[points.length - 1];
			var lastKw = Math.abs(last.val) >= 10000;
			var lastStr = lastKw ? `${(last.val / 1000).toFixed(2)} kW` : `${Math.round(last.val)} W`;
			var lastTooltip = `${t(this.getLabelKey(key))}: ${lastStr}`;
			svg += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="12" fill="transparent" style="cursor:pointer"><title>${lastTooltip}</title></circle>`;
			svg += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" fill="${color}" pointer-events="none"/>`;
		}

		return svg;
	},

	getLabelKey: function (key) {
		var map = {
			pv: "total_pv",
			house: "total_consumption",
			grid: "livechart_grid",
			battery: "livechart_battery",
			wallbox: "livechart_wallbox",
		};
		return map[key] || key;
	},

	/**
	 * Generate a monotone cubic Hermite spline SVG path.
	 * Prevents overshoot — suitable for power data.
	 *
	 * @param {Array<{x: number, y: number}>} points - Point array
	 * @returns {string} SVG path d attribute
	 */
	monotonePath: function (points) {
		var n = points.length;
		if (n < 2) {
			return "";
		}
		if (n === 2) {
			return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
		}

		// Calculate tangent slopes (Fritsch-Carlson method)
		var dx = [],
			dy = [],
			m = [];
		for (var i = 0; i < n - 1; i++) {
			dx.push(points[i + 1].x - points[i].x);
			dy.push(points[i + 1].y - points[i].y);
			m.push(dx[i] === 0 ? 0 : dy[i] / dx[i]);
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

		// Build cubic Bézier path
		var path = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
		for (var p = 0; p < n - 1; p++) {
			var dxi = dx[p] / 3;
			var cp1x = points[p].x + dxi;
			var cp1y = points[p].y + tangents[p] * dxi;
			var cp2x = points[p + 1].x - dxi;
			var cp2y = points[p + 1].y - tangents[p + 1] * dxi;
			path += `C${cp1x.toFixed(1)},${cp1y.toFixed(1)},${cp2x.toFixed(1)},${cp2y.toFixed(1)},${points[p + 1].x.toFixed(1)},${points[p + 1].y.toFixed(1)}`;
		}
		return path;
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
		if (minutes > oldWindow && this._historyInstance) {
			var src = energyFlow.resolveSource(app.connectors);
			if (src) {
				if (this._historyLoading) {
					// A load is in progress — queue a full reload for the new window
					this._pendingWindowLoad = minutes;
				} else {
					var now = Date.now();
					var newStart = now - minutes * 60 * 1000;
					// Delta: only fetch the gap between new start and oldest data we have
					var gapEnd = this._historyOldestTs < Infinity ? this._historyOldestTs : now;
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
		app.renderDashboard();
	},

	/** Whether document-level drag listeners are installed */
	_dragBound: false,

	/**
	 * Bind drag start on the SVG element (re-called after each render).
	 * Document-level move/end listeners are installed once.
	 */
	bindDrag: function () {
		var svg = document.getElementById("livechart-svg");
		if (!svg) {
			return;
		}

		svg.addEventListener("mousedown", liveChart._onDragStart);
		svg.addEventListener("touchstart", liveChart._onDragStart, { passive: false });
		svg.addEventListener("wheel", liveChart._onWheel, { passive: false });

		// Document-level listeners: install once, never re-add
		if (!this._dragBound) {
			this._dragBound = true;
			document.addEventListener("mousemove", liveChart._onDragMove);
			document.addEventListener("touchmove", liveChart._onDragMove, { passive: false });
			document.addEventListener("mouseup", liveChart._onDragEnd);
			document.addEventListener("touchend", liveChart._onDragEnd);
		}
	},

	_onDragStart: function (/** @type {MouseEvent|TouchEvent} */ e) {
		liveChart._dragging = true;
		liveChart._dragStartX = liveChart._getEventX(e);
		liveChart._dragStartOffset = liveChart.viewOffset;
		var svg = document.getElementById("livechart-svg");
		if (svg) {
			svg.style.cursor = "grabbing";
		}
		e.preventDefault();
	},

	_onDragMove: function (/** @type {MouseEvent|TouchEvent} */ e) {
		if (!liveChart._dragging) {
			return;
		}
		var dx = liveChart._getEventX(e) - liveChart._dragStartX;
		// Convert pixel delta to time delta
		var plotW = 1400 - 55 - 15; // chartW - padL - padR
		var windowMs = liveChart.window * 60 * 1000;
		var dtMs = (dx / plotW) * windowMs;
		liveChart.viewOffset = Math.max(0, liveChart._dragStartOffset + dtMs);

		// Lazy-load: if panning past buffered data, trigger history load
		var viewStart = Date.now() - liveChart.viewOffset - windowMs;
		if (viewStart < liveChart._historyOldestTs && liveChart._historyInstance && !liveChart._historyLoading) {
			var src = energyFlow.resolveSource(app.connectors);
			if (src) {
				liveChart._loadHistory(app.conn, app.namespace, src, viewStart, liveChart._historyOldestTs);
			}
		}

		// Re-render chart only (not full dashboard — too slow during drag)
		var el = document.getElementById("livechart-container");
		if (el) {
			var scrollX = window.scrollX;
			var scrollY = window.scrollY;
			el.innerHTML = liveChart.render();
			window.scrollTo(scrollX, scrollY);
			// Re-bind SVG listeners (innerHTML destroyed them), but NOT document listeners
			var svg = document.getElementById("livechart-svg");
			if (svg) {
				svg.addEventListener("mousedown", liveChart._onDragStart);
				svg.addEventListener("touchstart", liveChart._onDragStart, { passive: false });
				svg.addEventListener("wheel", liveChart._onWheel, { passive: false });
				svg.style.cursor = "grabbing";
			}
		}
	},

	_onDragEnd: function () {
		if (!liveChart._dragging) {
			return;
		}
		liveChart._dragging = false;
		var svg = document.getElementById("livechart-svg");
		if (svg) {
			svg.style.cursor = "grab";
		}
		// Snap to live if very close to now
		if (liveChart.viewOffset < 5000) {
			liveChart.viewOffset = 0;
		}
		app.renderDashboard();
	},

	_getEventX: function (/** @type {MouseEvent|TouchEvent} */ e) {
		var svg = document.getElementById("livechart-svg");
		if (!svg) {
			return 0;
		}
		var rect = svg.getBoundingClientRect();
		var me = /** @type {MouseEvent} */ (e);
		var te = /** @type {TouchEvent} */ (e);
		var clientX = te.touches ? te.touches[0].clientX : me.clientX;
		return ((clientX - rect.left) / rect.width) * 1400;
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
		var svg = document.getElementById("livechart-svg");
		if (svg) {
			var rect = svg.getBoundingClientRect();
			var cursorRatio = (e.clientX - rect.left) / rect.width; // 0=left edge, 1=right edge
			// Adjust viewOffset so the time under the cursor stays fixed
			var oldWindowMs = oldWindow * 60 * 1000;
			var newWindowMs = newWindow * 60 * 1000;
			var cursorTimeFromRight = (1 - cursorRatio) * oldWindowMs;
			var newCursorTimeFromRight = (1 - cursorRatio) * newWindowMs;
			liveChart.viewOffset = Math.max(0, liveChart.viewOffset + (newCursorTimeFromRight - cursorTimeFromRight));
		}

		liveChart.window = newWindow;

		// Load history if zooming out past what we have
		if (newWindow > oldWindow && liveChart._historyInstance && !liveChart._historyLoading) {
			var src = energyFlow.resolveSource(app.connectors);
			if (src) {
				var now = Date.now();
				var newStart = now - liveChart.viewOffset - newWindow * 60 * 1000;
				var gapEnd = liveChart._historyOldestTs < Infinity ? liveChart._historyOldestTs : now;
				if (newStart < gapEnd) {
					liveChart._loadHistory(app.conn, app.namespace, src, newStart, gapEnd);
				}
			}
		}

		var el = document.getElementById("livechart-container");
		if (el) {
			var scrollX = window.scrollX;
			var scrollY = window.scrollY;
			el.innerHTML = liveChart.render();
			window.scrollTo(scrollX, scrollY);
			liveChart.bindDrag();
		}
	},
};
