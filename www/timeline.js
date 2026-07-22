"use strict";

/* global app, t, XMLHttpRequest, document */
/* exported eventTimeline */

/**
 * Warning/event timeline for the SENEC web dashboard Overview tab.
 * Shows today's log events (W/E/P) as colored markers on a 24h time axis.
 * Fetches data from the log proxy endpoint, refreshes every 10 minutes.
 */

var eventTimeline = {
	/** Parsed warning/error/panic entries */
	events: [],

	/** Whether data has been loaded */
	loaded: false,

	/** Whether loading is in progress */
	loading: false,

	/** Whether the timeline is disabled */
	disabled: false,

	/** Last fetch timestamp */
	_lastFetch: 0,

	/** Refresh interval in ms (10 minutes) */
	refreshInterval: 600000,

	/**
	 * Fetch today's log and extract warnings/errors/panics.
	 * Reuses logViewer data if available, otherwise fetches independently.
	 */
	fetchEvents: function () {
		if (this.disabled || this.loading) {
			return;
		}

		var now = Date.now();
		// Skip if fetched recently
		if (this.loaded && now - this._lastFetch < this.refreshInterval) {
			return;
		}

		// Check if device IP is configured
		if (!app.config || !app.config.senecip) {
			return;
		}

		this.loading = true;
		var today = this.getUtcDateString();

		var xhr = new XMLHttpRequest();
		xhr.open("GET", `api/log?date=${encodeURIComponent(today)}`);
		xhr.timeout = 15000;
		xhr.onload = function () {
			eventTimeline.loading = false;
			eventTimeline._lastFetch = Date.now();
			if (xhr.status === 200) {
				eventTimeline.parseEvents(xhr.responseText);
				eventTimeline.loaded = true;
			} else {
				eventTimeline.events = [];
				eventTimeline.loaded = true;
			}
			eventTimeline.renderSelf();
		};
		xhr.onerror = function () {
			eventTimeline.loading = false;
			eventTimeline.loaded = true;
			eventTimeline.events = [];
		};
		xhr.ontimeout = function () {
			eventTimeline.loading = false;
			eventTimeline.loaded = true;
			eventTimeline.events = [];
		};
		xhr.send();
	},

	/**
	 * Parse log text and extract W/E/P entries with timestamps.
	 *
	 * @param {string} raw - Raw log text
	 */
	parseEvents: function (raw) {
		var lines = raw.split("\n");
		var events = [];

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (!line) {
				continue;
			}

			var match = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+\[(\w)\|([^\]]+)\]\s*(.*)$/);
			if (!match) {
				continue;
			}

			var level = match[5];
			// Only show warnings, errors, and panics
			if (level !== "W" && level !== "E" && level !== "P") {
				continue;
			}

			var hour = parseInt(match[2], 10);
			var minute = parseInt(match[3], 10);
			var second = parseInt(match[4], 10);
			var timeMinutes = hour * 60 + minute + second / 60; // fractional minutes since midnight

			events.push({
				time: timeMinutes,
				timeStr: `${match[2]}:${match[3]}:${match[4]}`,
				level: level,
				category: match[6],
				message: match[7],
			});
		}

		this.events = events;
	},

	/**
	 * Get today's date as UTC string YYYY-MM-DD
	 */
	getUtcDateString: function () {
		var d = new Date();
		var y = d.getUTCFullYear();
		var m = String(d.getUTCMonth() + 1).padStart(2, "0");
		var day = String(d.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	},

	/**
	 * Render the timeline card
	 */
	render: function () {
		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("timeline_title")}</h2>`;

		// Disable toggle
		var disabledCls = this.disabled ? "" : " active";
		html += `<button class="chart-toggle${disabledCls}" style="--toggle-color:#757575;margin-left:auto" onclick="eventTimeline.toggleDisabled()">`;
		html += `<span class="chart-toggle-dot" style="background:#757575"></span>${this.disabled ? "▶" : "●"}</button>`;

		if (this.disabled) {
			html += "</div></div>";
			return html;
		}
		html += "</div>";

		if (!this.loaded) {
			html += `<div class="stat-label">${t("timeline_loading")}</div>`;
			html += "</div>";
			return html;
		}

		if (this.events.length === 0) {
			html += `<div class="stat-label" style="color:#4caf50">${t("timeline_no_events")}</div>`;
			html += "</div>";
			return html;
		}

		html += this.renderSvg();
		html += "</div>";
		return html;
	},

	/**
	 * Render the SVG timeline
	 */
	renderSvg: function () {
		var chartW = 1400;
		var chartH = 80;
		var padL = 35;
		var padR = 15;
		var padT = 10;
		var padB = 20;
		var plotW = chartW - padL - padR;
		var plotH = chartH - padT - padB;

		// Time axis: 0–24h (1440 minutes)
		var currentMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();

		var svg = `<svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" xmlns="http://www.w3.org/2000/svg" style="min-height:80px">`;

		// Background
		svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="var(--color-border)" opacity="0.2" rx="3"/>`;

		// "Now" indicator line
		var nowX = padL + (currentMinutes / 1440) * plotW;
		svg += `<line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${padT + plotH}" stroke="#999" stroke-width="1" stroke-dasharray="3,2"/>`;

		// Hour markers
		for (var h = 0; h <= 24; h += 3) {
			var hx = padL + (h / 24) * plotW;
			svg += `<line x1="${hx.toFixed(1)}" y1="${padT + plotH - 4}" x2="${hx.toFixed(1)}" y2="${padT + plotH}" stroke="#999" stroke-width="0.5"/>`;
			if (h < 24) {
				svg += `<text x="${hx.toFixed(1)}" y="${chartH - 2}" text-anchor="middle" fill="#999" font-size="9">${h}:00</text>`;
			}
		}

		// Event markers
		var levelColors = { W: "#ff9800", E: "#f44336", P: "#9c27b0" };
		var levelNames = { W: "Warning", E: "Error", P: "Panic" };
		var markerR = 5;

		// Stack overlapping markers vertically
		var lanes = [];
		for (var ei = 0; ei < this.events.length; ei++) {
			var evt = this.events[ei];
			var ex = padL + (evt.time / 1440) * plotW;
			var color = levelColors[evt.level] || "#999";

			// Find a free lane (avoid overlap within 8px)
			var lane = 0;
			for (var li = 0; li < lanes.length; li++) {
				if (Math.abs(lanes[li] - ex) > markerR * 2.5) {
					lane = li;
					break;
				}
				lane = li + 1;
			}
			lanes[lane] = ex;

			var ey = padT + plotH / 2 + ((lane % 3) - 1) * (markerR * 2.2);
			// Keep within bounds
			ey = Math.max(padT + markerR, Math.min(padT + plotH - markerR, ey));

			var tooltip = `${evt.timeStr} [${levelNames[evt.level]}] ${evt.category}: ${evt.message}`;
			// Invisible hit area
			svg += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="10" fill="transparent" style="cursor:pointer"><title>${this.escapeXml(tooltip)}</title></circle>`;
			// Visible marker
			svg += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${markerR}" fill="${color}" opacity="0.85" pointer-events="none"/>`;
		}

		// Legend
		var legendX = padL + 5;
		var legendY = padT + 2;
		var levels = ["W", "E", "P"];
		for (var lgi = 0; lgi < levels.length; lgi++) {
			var lv = levels[lgi];
			var count = 0;
			for (var ci = 0; ci < this.events.length; ci++) {
				if (this.events[ci].level === lv) {
					count++;
				}
			}
			if (count > 0) {
				svg += `<circle cx="${legendX}" cy="${legendY}" r="4" fill="${levelColors[lv]}"/>`;
				svg += `<text x="${legendX + 7}" y="${legendY + 3}" fill="#999" font-size="9">${count} ${levelNames[lv]}</text>`;
				legendX += 70;
			}
		}

		svg += "</svg>";
		return `<div class="chart-scroll">${svg}</div>`;
	},

	escapeXml: function (str) {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	},

	// --- Interaction ---

	toggleDisabled: function () {
		this.disabled = !this.disabled;
		if (!this.disabled && !this.loaded) {
			this.fetchEvents();
		}
		this.renderSelf();
	},

	/** Update only the timeline container without full dashboard re-render */
	renderSelf: function () {
		var el = document.getElementById("timeline-container");
		if (el) {
			el.innerHTML = this.render();
		}
	},
};
