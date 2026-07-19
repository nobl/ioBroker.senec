"use strict";

/* global app, t, energyFlow */
/* exported liveChart */

/**
 * Live power curve for the SENEC web dashboard.
 * Renders a real-time SVG line chart from rolling power data.
 * Supports all connectors — uses whatever power data energyFlow provides.
 * Smooth monotone cubic interpolation between data points.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
var liveChart = {
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

	/** Maximum buffer size (points) — limit memory. At 10s intervals, 24h = 8640 points */
	maxPoints: 8640,

	/** Last recorded timestamp to avoid duplicates */
	_lastTs: 0,

	/**
	 * Record a new data point from the current energyFlow state.
	 * Called on each state update that affects power values.
	 */
	record: function () {
		if (this.paused) {
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

		this.buffer.push({
			ts: now,
			pv: d.pv || 0,
			battery: d.battery || 0, // signed: + charge, - discharge
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
		var cutoff = Date.now() - this.window * 60 * 1000;
		var result = [];
		for (var i = 0; i < this.buffer.length; i++) {
			if (this.buffer[i].ts >= cutoff) {
				result.push(this.buffer[i]);
			}
		}
		return result;
	},

	/**
	 * Render the live chart card
	 */
	render: function () {
		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("livechart_title")}</h2>`;
		html += '<div class="day-totals-tabs">';

		// Time window tabs
		var windows = [10, 30, 60, 120, 360, 720, 1440];
		var windowLabels = ["10m", "30m", "1h", "2h", "6h", "12h", "24h"];
		for (var i = 0; i < windows.length; i++) {
			var cls = this.window === windows[i] ? "period-tab active" : "period-tab";
			html += `<button class="${cls}" onclick="liveChart.setWindow(${windows[i]})">${windowLabels[i]}</button>`;
		}

		// Pause button
		var pauseCls = this.paused ? " active" : "";
		html += `<button class="period-tab${pauseCls}" onclick="liveChart.togglePause()">${this.paused ? "▶" : "⏸"}</button>`;
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
		if (data.length < 2) {
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
		var tMin = data[0].ts;
		var tMax = data[data.length - 1].ts;
		// Extend to full window width if data doesn't fill it yet
		var windowMs = this.window * 60 * 1000;
		if (tMax - tMin < windowMs) {
			tMin = tMax - windowMs;
		}
		var tRange = tMax - tMin;

		var svg = `<svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" xmlns="http://www.w3.org/2000/svg">`;

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
		var points = [];
		for (var i = 0; i < data.length; i++) {
			var x = padL + ((data[i].ts - tMin) / tRange) * plotW;
			var y = padT + plotH - ((data[i][key] - yMin) / range) * plotH;
			points.push({ x: x, y: y, val: data[i][key] });
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
		this.window = minutes;
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
};
