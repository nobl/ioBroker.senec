"use strict";

/* global app, t, escHtml, liveChart, charts, document, requestAnimationFrame */
/* exported chartColors */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Series colors shared by the dashboard charts.
 *
 * One entry per data type, so a type is drawn in the same color by every chart that shows
 * it. The energy flow diagram keeps its own lighter palette and is not driven from here.
 *
 * The palette lives in the adapter state `_dashboard.colors`, not in the browser, so a
 * wall tablet and a phone looking at the same system agree on it.
 */
var chartColors = {
	/** Palette state, relative to the adapter namespace */
	STATE_ID: "_dashboard.colors",

	/**
	 * Fallback color per series — each one a color the dashboard already drew that series in.
	 *
	 * `gridLine` and `batteryLine` are the live chart's signed power lines. They cross zero
	 * and so carry no direction, which is why they are separate from the directional entries
	 * the measurement bars use rather than reusing one of them. They share a default with a
	 * directional entry because the two never appear in one chart; they are separate so each
	 * can be picked on its own.
	 *
	 * Battery charge level had two colors before the palette was shared — teal in the live
	 * chart, purple in the measurement history — and one type now takes one color. It keeps
	 * the purple, because the measurement history draws it by default and the live chart does
	 * not; `wallbox` moves to the shade the flow diagram's wallbox total already uses, since
	 * holding the purple would have made it indistinguishable from the level line.
	 *
	 * @type {Record<string, string>}
	 */
	DEFAULTS: {
		pv: "#f9a825",
		house: "#e65100",
		wallbox: "#9c27b0",
		batterySoc: "#7e57c2",
		gridLine: "#1565c0",
		batteryLine: "#2e7d32",
		gridImport: "#c62828",
		gridExport: "#1565c0",
		batteryCharge: "#2e7d32",
		batteryDischarge: "#00897b",
	},

	/**
	 * One label per palette entry, used by the editor.
	 *
	 * The editor names entries, while a chart's toggles name that chart's own lines, so the
	 * two wordings are allowed to differ. What they may not do is give one entry two names:
	 * battery charge level is a single pickable color and reads the same in both editors.
	 *
	 * @type {Record<string, string>}
	 */
	LABEL_KEYS: {
		pv: "total_pv",
		house: "total_consumption",
		wallbox: "total_wallbox",
		batterySoc: "chart_battery_level",
		gridLine: "livechart_grid",
		batteryLine: "livechart_battery",
		gridImport: "total_grid_import",
		gridExport: "total_grid_export",
		batteryCharge: "total_battery_charge",
		batteryDischarge: "total_battery_discharge",
	},

	/**
	 * Only the deviations from `DEFAULTS` are held and stored, so a later change to a
	 * default still reaches an installation that has customised an unrelated series.
	 *
	 * @type {Record<string, string>}
	 */
	overrides: {},

	/** Set when a write could not be delivered, so the editor can say so instead of lying */
	saveFailed: false,

	/** Six-digit hex is what `<input type="color">` emits and what every chart backend takes */
	HEX_RE: /^#[0-9a-f]{6}$/i,

	/**
	 * @param {string} key - Series key
	 * @returns {string} CSS color for the series
	 */
	get: function (key) {
		if (Object.prototype.hasOwnProperty.call(this.overrides, key)) {
			return this.overrides[key];
		}
		return this.DEFAULTS[key] || "#9e9e9e";
	},

	/**
	 * Serialise a palette with its keys in a fixed order.
	 *
	 * Insertion order would otherwise depend on the order the user happened to click in,
	 * which makes two equal palettes compare as different and re-render on every ack.
	 *
	 * @param {Record<string, string>} map - Overrides to serialise
	 * @returns {string} JSON
	 */
	_serialize: function (map) {
		/** @type {Record<string, string>} */
		var out = {};
		for (var key in this.DEFAULTS) {
			if (map[key]) {
				out[key] = map[key];
			}
		}
		return JSON.stringify(out);
	},

	/**
	 * Read a stored palette, keeping only entries this build both knows and can draw.
	 *
	 * Unknown keys and malformed values are dropped rather than rejected wholesale: the
	 * state is user-writable, and one bad entry must not cost the rest of the palette.
	 *
	 * @param {string | number | boolean | null | undefined} val - Raw state value
	 * @returns {Record<string, string>} Sanitised overrides
	 */
	_parse: function (val) {
		/** @type {Record<string, string>} */
		var next = {};
		if (typeof val !== "string" || val.trim() === "") {
			return next;
		}
		var parsed = null;
		try {
			parsed = JSON.parse(val);
		} catch {
			return next;
		}
		if (!parsed || typeof parsed !== "object") {
			return next;
		}
		for (var key in this.DEFAULTS) {
			var candidate = parsed[key];
			if (typeof candidate !== "string" || !this.HEX_RE.test(candidate)) {
				continue;
			}
			var hex = candidate.toLowerCase();
			if (hex !== this.DEFAULTS[key]) {
				next[key] = hex;
			}
		}
		return next;
	},

	/**
	 * Adopt the palette carried by the adapter state.
	 *
	 * @param {string | number | boolean | null | undefined} val - Raw state value
	 * @returns {boolean} Whether the palette actually changed
	 */
	applyFromState: function (val) {
		var next = this._parse(val);
		// A pick stops being pending once the published palette agrees with it; holding it
		// any longer would keep re-applying it over a later change from another page.
		for (var key in this._pending) {
			var published = Object.prototype.hasOwnProperty.call(next, key) ? next[key] : null;
			if (published === this._pending[key]) {
				delete this._pending[key];
			}
		}
		if (this._serialize(next) === this._serialize(this.overrides)) {
			return false;
		}
		this.overrides = next;
		return true;
	},

	/**
	 * Pick a color for one series and persist the palette.
	 *
	 * @param {string} key - Series key
	 * @param {string} value - Hex color from the picker
	 * @returns {boolean} Whether the palette actually changed
	 */
	set: function (key, value) {
		if (!Object.prototype.hasOwnProperty.call(this.DEFAULTS, key) || !this.HEX_RE.test(value)) {
			return false;
		}
		var hex = value.toLowerCase();
		if (hex === this.get(key)) {
			return false;
		}
		this._commit([key], hex === this.DEFAULTS[key] ? null : hex);
		return true;
	},

	/**
	 * Drop the overrides for a set of series.
	 *
	 * @param {string[]} keys - Series to return to their default
	 * @returns {boolean} Whether the palette actually changed
	 */
	reset: function (keys) {
		var changed = [];
		for (var i = 0; i < keys.length; i++) {
			if (Object.prototype.hasOwnProperty.call(this.overrides, keys[i])) {
				changed.push(keys[i]);
			}
		}
		if (!changed.length) {
			return false;
		}
		this._commit(changed, null);
		return true;
	},

	/**
	 * Apply a change to the palette the adapter last published, and write the result back.
	 *
	 * Read-modify-write rather than sending this page's whole map: a color another page
	 * changed a moment ago is already in the state cache, and overwriting it with this page's
	 * older view of the rest of the palette is how one of two simultaneous picks disappears.
	 *
	 * @param {string[]} keys - Series being changed
	 * @param {string | null} hex - New color, or null to return the series to its default
	 */
	_commit: function (keys, hex) {
		var base = this._parse(app.states ? app.states[this.STATE_ID] : null);
		// This page's own earlier picks, which the adapter has not published back yet. Without
		// them a second pick inside one socket round trip is written against a base that
		// predates the first, and drops it.
		for (var pendingKey in this._pending) {
			if (this._pending[pendingKey]) {
				base[pendingKey] = this._pending[pendingKey];
			} else {
				delete base[pendingKey];
			}
		}
		for (var i = 0; i < keys.length; i++) {
			this._pending[keys[i]] = hex;
			if (hex) {
				base[keys[i]] = hex;
			} else {
				delete base[keys[i]];
			}
		}
		this.overrides = base;
		// Each attempt starts clean, so an error from an earlier one cannot outlive it.
		this.saveFailed = false;
		this.save();
	},

	/**
	 * Picks made here that the adapter has not published back yet.
	 *
	 * An entry's value is the chosen color, or null for a series returned to its default.
	 *
	 * @type {Record<string, string|null>}
	 */
	_pending: {},

	/**
	 * Write the palette back to the adapter, where every other browser picks it up.
	 *
	 * A write that does not go out takes its picks out of `_pending` with it. They are not
	 * in flight, so carrying them forward would let a later successful write resurrect a
	 * color the user was told had not been saved — including over a reset to the defaults.
	 */
	save: function () {
		// `socketLive` and not just `conn`, because the socket object outlives an outage: the
		// client the web adapter serves discards an emit issued while the page is disconnected
		// without ever running its callback, so failure cannot be detected afterwards. The
		// only honest moment to say so is before issuing it.
		if (!app.conn || !app.namespace || !app.socketLive) {
			this.saveFailed = true;
			this._pending = {};
			return;
		}
		// A rejected or undeliverable write has to be visible, because the write is the only
		// thing that makes a pick outlive the page.
		app.conn.emit(
			"setState",
			`${app.namespace}.${this.STATE_ID}`,
			{ val: this._serialize(this.overrides), ack: false },
			function (err) {
				chartColors.saveFailed = !!err;
				if (err) {
					chartColors._pending = {};
					console.error("[senec] storing chart colors failed:", err);
					chartColors.refreshCharts();
				}
			},
		);
	},

	/**
	 * Redraw every chart the palette feeds, whichever tab is in front.
	 *
	 * Deliberately both of them: the two charts share series, so a color picked in one
	 * leaves the other showing the previous value until its next state-driven render.
	 *
	 * Coalesced onto an animation frame for the same reason every other render in the page
	 * is, and each chart redrawn independently so a throw in one still leaves the other
	 * showing the palette the user just picked.
	 */
	refreshCharts: function () {
		if (this._repaintPending) {
			return;
		}
		this._repaintPending = true;
		requestAnimationFrame(function () {
			chartColors._repaintPending = false;
			// The live chart holds its own render off mid-gesture; a palette change arriving
			// from another page is not a reason to rebuild the canvas under a moving finger.
			if (!liveChart._dragging && !liveChart._pinching) {
				try {
					liveChart.refresh();
				} catch (e) {
					console.error("[senec] live chart repaint failed:", e);
				}
			}
			try {
				charts.refresh();
			} catch (e) {
				console.error("[senec] measurement chart repaint failed:", e);
			}
		});
	},

	/** Whether a coalesced repaint is already queued */
	_repaintPending: false,

	/**
	 * Install the editor's open, pick and reset handlers on a chart module.
	 *
	 * All three are the same for every owner, and `onColorChange` in particular has to stay
	 * the same — a guard added to one copy and not the other is exactly the divergence this
	 * removes. The owner supplies only what genuinely differs: `_colorRows()` and `refresh()`.
	 *
	 * @param {string} name - Global name of the owner, used in the editor's inline handlers
	 * @param {ColorOwner} owner - Chart module to install on
	 */
	bindOwner: function (name, owner) {
		owner._colorsOpen = false;
		// Closed over `owner` rather than using `this`: these are called from inline handlers
		// in the editor markup, where the receiver is whatever the attribute names.
		owner.toggleColors = function () {
			owner._colorsOpen = !owner._colorsOpen;
			owner.refresh();
		};
		owner.onColorChange = function (key, value) {
			if (chartColors.set(key, value)) {
				chartColors.refreshCharts();
			}
		};
		owner.resetColors = function () {
			if (chartColors.reset(owner._colorRows())) {
				chartColors.refreshCharts();
			} else {
				owner.refresh();
			}
		};
	},

	/**
	 * Render a palette editor for one chart's series.
	 *
	 * Bound to `change`, never `input`: `input` fires continuously while the picker is
	 * dragged, and each one would repaint the full chart and write a state.
	 *
	 * @param {string} owner - Global name of the owning chart module, for the handlers
	 * @param {string[]} keys - Palette entries to offer, in display order
	 * @returns {string} HTML
	 */
	renderEditor: function (owner, keys) {
		var html = '<div class="color-editor">';
		for (var i = 0; i < keys.length; i++) {
			var label = escHtml(t(this.LABEL_KEYS[keys[i]] || keys[i]));
			html +=
				'<label class="color-editor-row">' +
				`<input type="color" value="${chartColors.get(keys[i])}" ` +
				`onchange="${owner}.onColorChange('${keys[i]}', this.value)" aria-label="${label}">` +
				`<span>${label}</span>` +
				"</label>";
		}
		html +=
			`<button class="chart-toggle" style="--toggle-color:#757575" onclick="${owner}.resetColors()">` +
			`<span class="chart-toggle-dot" style="background:#757575"></span>${t("colors_reset")}</button>`;
		if (this.saveFailed) {
			html += `<span class="color-editor-error">${escHtml(t("colors_save_failed"))}</span>`;
		}
		html += "</div>";
		return html;
	},

	/**
	 * Refill the container a chart owns.
	 *
	 * This is the path the periodic render takes as well as the path a color pick takes, so
	 * a chart is always drawn from the markup that was just written rather than the previous
	 * frame's.
	 *
	 * @param {string} containerId - Element id to refill
	 * @param {function(): string} render - Markup producer
	 * @returns {HTMLElement | null} The container, for callers that paint into it afterwards
	 */
	fill: function (containerId, render) {
		var el = document.getElementById(containerId);
		if (el) {
			el.innerHTML = render();
		}
		return el;
	},
};
