"use strict";

/* global app, t */
/* exported energyFlow */

/**
 * Energy flow data layer and visualization.
 *
 * Normalizes power data from different connectors into a unified format,
 * then renders an SVG energy flow diagram.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var energyFlow = {
	// Normalized energy data — all power values in W (signed: positive = generation/import/charge)

	data: {
		pv: 0,
		battery: 0,
		grid: 0,
		house: 0,
		soc: null,
		todayPv: null,
		todayConsumption: null,
		todayGridImport: null,
		todayGridExport: null,
		todayBatteryCharge: null,
		todayBatteryDischarge: null,
		wallbox: 0,
		todayWallbox: null,
		autarky: null, // % self-sufficiency today
		batteryCapacity: null, // kWh — design capacity for time estimates
	},

	source: "auto", // "auto", "local", "api", "web"
	period: "today", // "today", "month", "year"

	activeSource: null, // which source is actually providing data

	apiAnlagenId: null, // discovered API system ID
	hasData: false,

	// State ID mappings per connector
	stateMap: {
		local: {
			pv: "ENERGY.GUI_INVERTER_POWER",
			battery: "ENERGY.GUI_BAT_DATA_POWER", // signed: positive=charge, negative=discharge
			grid: "ENERGY.GUI_GRID_POW", // signed: positive=import, negative=export
			house: "ENERGY.GUI_HOUSE_POW",
			soc: "ENERGY.GUI_BAT_DATA_FUEL_CHARGE",
		},
		// API and Web use dynamic prefixes — resolved at runtime
	},

	/**
	 * Discover API system ID from loaded states
	 *
	 * @param {object} states - ioBroker state values
	 */
	discoverApiId: function (states) {
		for (var key in states) {
			var m = key.match(/^_api\.Anlagen\.([^.]+)\./);
			if (m) {
				this.apiAnlagenId = m[1];
				return;
			}
		}
	},

	/** Get the API state prefix for the discovered system */
	apiPrefix: function () {
		return this.apiAnlagenId ? `_api.Anlagen.${this.apiAnlagenId}.Dashboard.` : null;
	},

	/**
	 * Determine which source to use based on priority and connectivity
	 *
	 * @param {object} connectors - Connector status objects
	 */
	resolveSource: function (connectors) {
		if (this.source !== "auto") {
			return this.source;
		}
		// Priority: local > api > web
		if (connectors.local.active) {
			return "local";
		}
		if (connectors.api.active) {
			return "api";
		}
		if (connectors.web.active) {
			return "web";
		}
		return null;
	},

	/**
	 * Read a state value, returning 0 if missing
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 */
	getState: function (states, key) {
		var val = states[key];
		return val !== undefined && val !== null ? Number(val) : 0;
	},

	/**
	 * Read a state value, returning null if missing
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 */
	getStateOrNull: function (states, key) {
		var val = states[key];
		return val !== undefined && val !== null ? Number(val) : null;
	},

	/**
	 * Update energy data from states
	 *
	 * @param {object} states - ioBroker state values
	 * @param {object} connectors - Connector status objects
	 */
	update: function (states, connectors) {
		this.discoverApiId(states);
		var src = this.resolveSource(connectors);
		this.activeSource = src;

		if (!src) {
			this.hasData = false;
			return;
		}

		if (src === "local") {
			this.updateFromLocal(states);
		} else if (src === "api") {
			this.updateFromApi(states);
		} else if (src === "web") {
			this.updateFromWeb(states);
		}

		// Day totals — try API first (Wh), then Web (kWh)
		this.updateDayTotals(states);

		this.hasData = true;
	},

	updateFromLocal: function (states) {
		var map = this.stateMap.local;
		this.data.pv = Math.abs(this.getState(states, map.pv));
		this.data.battery = this.getState(states, map.battery); // already signed
		this.data.grid = this.getState(states, map.grid); // already signed
		this.data.house = Math.abs(this.getState(states, map.house));
		this.data.soc = this.getStateOrNull(states, map.soc);
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
		// Wallbox — array values stored as individual indices (WALLBOX.APPARENT_CHARGING_POWER.0, .1, etc.)
		this.data.wallbox = 0;
		for (var i = 0; i < 4; i++) {
			var v = this.getStateOrNull(states, `WALLBOX.APPARENT_CHARGING_POWER.${i}`);
			if (v !== null) {
				this.data.wallbox += v;
			}
		}
	},

	updateFromApi: function (states) {
		var pfx = this.apiPrefix();
		if (!pfx) {
			this.hasData = false;
			return;
		}

		this.data.pv = this.getState(states, `${pfx}currently.powerGenerationInW`);
		var charge = this.getState(states, `${pfx}currently.batteryChargeInW`);
		var discharge = this.getState(states, `${pfx}currently.batteryDischargeInW`);
		this.data.battery = charge - discharge; // positive = charging
		var gridDraw = this.getState(states, `${pfx}currently.gridDrawInW`);
		var gridFeed = this.getState(states, `${pfx}currently.gridFeedInInW`);
		this.data.grid = gridDraw - gridFeed; // positive = importing
		this.data.house = this.getState(states, `${pfx}currently.powerConsumptionInW`);
		this.data.soc = this.getStateOrNull(states, `${pfx}currently.batteryLevelInPercent`);
		this.data.wallbox = this.getState(states, `${pfx}currently.wallboxInW`);
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
	},

	updateFromWeb: function (states) {
		// Web connector stores power values in kW — multiply by 1000 to normalize to W
		var pfx = "_meinsenec.Status.";
		this.data.pv = this.getState(states, `${pfx}powergenerated.now`) * 1000;
		// accuexport = export power to battery (charge), accuimport = import power from battery (discharge)
		var charge = this.getState(states, `${pfx}accuexport.now`) * 1000;
		var discharge = this.getState(states, `${pfx}accuimport.now`) * 1000;
		this.data.battery = charge - discharge;
		var gridImport = this.getState(states, `${pfx}gridimport.now`) * 1000;
		var gridExport = this.getState(states, `${pfx}gridexport.now`) * 1000;
		this.data.grid = gridImport - gridExport;
		this.data.house = this.getState(states, `${pfx}consumption.now`) * 1000;
		this.data.soc = this.getStateOrNull(states, `${pfx}acculevel.now`); // % — no conversion
		this.data.wallbox = 0; // Web connector doesn't provide live wallbox power
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
	},

	updateDayTotals: function (states) {
		if (this.period === "today") {
			this.updateTotalsToday(states);
		} else if (this.period === "month") {
			this.updateTotalsMonth(states);
		} else if (this.period === "year") {
			this.updateTotalsYear(states);
		}
	},

	updateTotalsToday: function (states) {
		// Try API Dashboard first (values in Wh → convert to kWh)
		var pfx = this.apiPrefix();
		if (pfx && states[`${pfx}today.powerGenerationInWh`] !== undefined) {
			this.data.todayPv = this.getState(states, `${pfx}today.powerGenerationInWh`) / 1000;
			this.data.todayConsumption = this.getState(states, `${pfx}today.powerConsumptionInWh`) / 1000;
			this.data.todayGridImport = this.getState(states, `${pfx}today.gridDrawInWh`) / 1000;
			this.data.todayGridExport = this.getState(states, `${pfx}today.gridFeedInInWh`) / 1000;
			this.data.todayBatteryCharge = this.getState(states, `${pfx}today.batteryChargeInWh`) / 1000;
			this.data.todayBatteryDischarge = this.getState(states, `${pfx}today.batteryDischargeInWh`) / 1000;
			this.data.todayWallbox = this.getState(states, `${pfx}today.wallboxInWh`) / 1000;
			this.data.autarky = this.getStateOrNull(states, `${pfx}today.selfSufficiencyInPercent`);
			return;
		}

		// Try Web Status (values already in kWh)
		var wpfx = "_meinsenec.Status.";
		if (states[`${wpfx}powergenerated.today`] !== undefined) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated.today`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption.today`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport.today`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport.today`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport.today`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport.today`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.day");
		}
	},

	updateTotalsMonth: function (states) {
		// Web measurements: _meinsenec.Measurements.Monthly.current_month.{type}
		var wpfx = "_meinsenec.Measurements.Monthly.current_month.";
		if (states[`${wpfx}powergenerated`] !== undefined) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.month");
			return;
		}

		// API measurements: _api.Anlagen.{id}.Measurements.Monthly.current_month.{key}
		var pfx = this.apiPrefix();
		if (pfx) {
			var apfx = pfx.replace("Dashboard.", "Measurements.Monthly.current_month.");
			if (states[`${apfx}powerGenerationInWh`] !== undefined) {
				this.data.todayPv = this.getState(states, `${apfx}powerGenerationInWh`) / 1000;
				this.data.todayConsumption = this.getState(states, `${apfx}powerConsumptionInWh`) / 1000;
				this.data.todayGridImport = this.getState(states, `${apfx}gridDrawInWh`) / 1000;
				this.data.todayGridExport = this.getState(states, `${apfx}gridFeedInInWh`) / 1000;
				this.data.todayBatteryCharge = this.getState(states, `${apfx}batteryChargeInWh`) / 1000;
				this.data.todayBatteryDischarge = this.getState(states, `${apfx}batteryDischargeInWh`) / 1000;
				this.data.todayWallbox = this.getStateOrNull(states, `${apfx}wallboxInWh`);
				if (this.data.todayWallbox !== null) {
					this.data.todayWallbox /= 1000;
				}
				this.data.autarky = null;
				return;
			}
		}

		this.clearTotals();
	},

	updateTotalsYear: function (states) {
		var year = new Date().getFullYear();

		// Web measurements: _meinsenec.Measurements.Yearly.{year}.{type}
		var wpfx = `_meinsenec.Measurements.Yearly.${year}.`;
		if (states[`${wpfx}powergenerated`] !== undefined) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.year");
			return;
		}

		// API measurements: _api.Anlagen.{id}.Measurements.Yearly.{year}.{key}
		var pfx = this.apiPrefix();
		if (pfx) {
			var apfx = pfx.replace("Dashboard.", `Measurements.Yearly.${year}.`);
			if (states[`${apfx}powerGenerationInWh`] !== undefined) {
				this.data.todayPv = this.getState(states, `${apfx}powerGenerationInWh`) / 1000;
				this.data.todayConsumption = this.getState(states, `${apfx}powerConsumptionInWh`) / 1000;
				this.data.todayGridImport = this.getState(states, `${apfx}gridDrawInWh`) / 1000;
				this.data.todayGridExport = this.getState(states, `${apfx}gridFeedInInWh`) / 1000;
				this.data.todayBatteryCharge = this.getState(states, `${apfx}batteryChargeInWh`) / 1000;
				this.data.todayBatteryDischarge = this.getState(states, `${apfx}batteryDischargeInWh`) / 1000;
				this.data.todayWallbox = this.getStateOrNull(states, `${apfx}wallboxInWh`);
				if (this.data.todayWallbox !== null) {
					this.data.todayWallbox /= 1000;
				}
				this.data.autarky = null;
				return;
			}
		}

		this.clearTotals();
	},

	clearTotals: function () {
		this.data.todayPv = null;
		this.data.todayConsumption = null;
		this.data.todayGridImport = null;
		this.data.todayGridExport = null;
		this.data.todayBatteryCharge = null;
		this.data.todayBatteryDischarge = null;
		this.data.todayWallbox = null;
		this.data.autarky = null;
	},

	/**
	 * Format watts for display
	 *
	 * @param {number} w - Power in watts
	 */
	formatPower: function (w) {
		var abs = Math.abs(w);
		if (abs >= 1000) {
			return `${(abs / 1000).toFixed(2)} kW`;
		}
		return `${Math.round(abs)} W`;
	},

	/**
	 * Format kWh for display
	 *
	 * @param {number} v - Value in kWh
	 */
	formatKwh: function (v) {
		if (v === null || v === undefined) {
			return "-";
		}
		return `${v.toFixed(1)} kWh`;
	},

	/**
	 * Resolve battery capacity: config > API SystemDetails > null
	 *
	 * @param {object} states - ioBroker state values
	 */
	resolveBatteryCapacity: function (states) {
		// User-configured value takes priority (0 = auto-detect)
		var configCap = app.config.battery_capacity;
		if (configCap && configCap > 0) {
			return configCap;
		}

		// API SystemDetails
		var pfx = this.apiPrefix();
		if (pfx) {
			var sysPfx = pfx.replace("Dashboard.", "SystemDetails.");
			var apiCap = this.getStateOrNull(states, `${sysPfx}batteryPack.maxCapacityInKwh`);
			if (apiCap && apiCap > 0) {
				return apiCap;
			}
		}

		return null;
	},

	/**
	 * Format hours as "Xh Ym"
	 *
	 * @param {number} hours - Duration in hours
	 */
	formatTime: function (hours) {
		if (hours <= 0 || !isFinite(hours)) {
			return null;
		}
		if (hours > 99) {
			return ">99h";
		}
		var h = Math.floor(hours);
		var m = Math.round((hours - h) * 60);
		if (m === 60) {
			h++;
			m = 0;
		}
		if (h === 0) {
			return `${m}m`;
		}
		if (m === 0) {
			return `${h}h`;
		}
		return `${h}h ${m}m`;
	},

	/** Estimate battery time remaining or time to full */
	getBatteryTimeEstimate: function () {
		var d = this.data;
		if (d.soc === null || d.batteryCapacity === null || d.batteryCapacity <= 0) {
			return null;
		}
		var cap = d.batteryCapacity; // kWh
		var powerW = d.battery;
		var absW = Math.abs(powerW);
		if (absW < 50) {
			return null;
		} // below noise threshold

		if (powerW < 0) {
			// Discharging — time until empty
			var remainKwh = (cap * d.soc) / 100;
			var hours = remainKwh / (absW / 1000);
			var formatted = this.formatTime(hours);
			return formatted ? t("battery_until_empty", { time: formatted }) : null;
		}
		// Charging — time until full
		var neededKwh = (cap * (100 - d.soc)) / 100;
		var hoursToFull = neededKwh / (absW / 1000);
		var fmtd = this.formatTime(hoursToFull);
		return fmtd ? t("battery_until_full", { time: fmtd }) : null;
	},

	/**
	 * Render the energy flow SVG + today's summary
	 *
	 * @param {string} [modeBadge] - HTML for operating mode badge
	 */
	render: function (modeBadge) {
		if (!this.hasData) {
			return `<div class="card"><h2>${t("energy_flow")}</h2>${
				modeBadge || ""
			}<div class="stat-label">${t("energy_no_data")}</div></div>`;
		}

		var d = this.data;
		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("energy_flow")}</h2>`;
		html += '<div class="energy-source">';
		html += '<select id="energy-source" onchange="energyFlow.onSourceChange(this.value)">';
		html += `<option value="auto"${this.source === "auto" ? " selected" : ""}>Auto</option>`;
		html += `<option value="local"${this.source === "local" ? " selected" : ""}>Local</option>`;
		html += `<option value="api"${this.source === "api" ? " selected" : ""}>API</option>`;
		html += `<option value="web"${this.source === "web" ? " selected" : ""}>Web</option>`;
		html += "</select>";
		html += `<span class="energy-source-label">${t(this.activeSource ? "energy_source_via" : "energy_source_none", {
			source: this.activeSource || "",
		})}</span>`;
		// Last update timestamp (shows when the dashboard last received data from the active connector)
		var now = new Date();
		var timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
		html += `<span class="energy-source-label">${t("energy_last_update", { time: timeStr })}</span>`;
		html += "</div></div>";

		// Operating mode badge
		if (modeBadge) {
			html += modeBadge;
		}

		// SVG energy flow diagram
		html += this.renderFlowDiagram(d);

		// Today's totals
		html += this.renderDayTotals(d);

		html += "</div>";
		return html;
	},

	// SVG icon paths (compact)
	icons: {
		sun: "M12 2v2m0 16v2m-8-10H2m20 0h-2m-2.93-6.07l-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.73l1.41 1.41m9.9 9.9l1.41 1.41M12 6a6 6 0 100 12 6 6 0 000-12z",
		house: "M3 12l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-4v6H6a1 1 0 01-1-1v-9z",
		grid: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
		battery: "M6 7h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zm16 3v4",
		wallbox: "M5 3v18l7-3 7 3V3H5zm4 4h6m-6 3h6m-6 3h4",
	},

	renderFlowDiagram: function (d) {
		var hasWallbox = d.wallbox > 10 || d.todayWallbox > 0;
		var w = 520,
			h = hasWallbox ? 440 : 380;
		var cx = w / 2,
			cy = h / 2;

		// Node positions — diamond layout
		var nodes = {
			pv: { x: cx, y: 55 },
			house: { x: w - 80, y: cy },
			battery: { x: cx, y: h - 75 },
			grid: { x: 80, y: cy },
		};
		if (hasWallbox) {
			nodes.wallbox = { x: w - 80, y: h - 75 };
			nodes.house.y = cy - 20;
		}

		var svg = `<svg class="energy-flow-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

		// Defs — filters for glow effects
		svg += "<defs>";
		svg += '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">';
		svg += '<feGaussianBlur stdDeviation="3" result="blur"/>';
		svg += '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>';
		svg += "</filter>";
		svg += '<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">';
		svg += '<feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.1"/>';
		svg += "</filter>";
		svg += "</defs>";

		// Flow paths (curved, behind nodes)
		if (d.pv > 0) {
			svg += this.renderCurvedFlow(nodes.pv, nodes.house, "#f9a825", d.pv);
		}
		if (d.pv > 0 && d.battery > 0) {
			svg += this.renderCurvedFlow(nodes.pv, nodes.battery, "#f9a825", Math.min(d.pv, d.battery), -30);
		}
		if (d.battery < 0) {
			svg += this.renderCurvedFlow(nodes.battery, nodes.house, "#4caf50", Math.abs(d.battery));
		}
		if (d.grid > 0) {
			svg += this.renderCurvedFlow(nodes.grid, nodes.house, "#ef5350", d.grid);
		}
		if (d.grid < 0) {
			svg += this.renderCurvedFlow(nodes.pv, nodes.grid, "#42a5f5", Math.abs(d.grid), 30);
		}
		if (d.grid > 0 && d.battery > 0) {
			svg += this.renderCurvedFlow(nodes.grid, nodes.battery, "#ef5350", Math.min(d.grid, d.battery), 30);
		}
		if (hasWallbox && d.wallbox > 10) {
			svg += this.renderCurvedFlow(nodes.house, nodes.wallbox, "#ab47bc", d.wallbox);
		}

		// Node circles with icons
		svg += this.renderNode(nodes.pv, "sun", t("energy_pv"), this.formatPower(d.pv), "#f9a825", d.pv > 10);
		svg += this.renderNode(nodes.house, "house", t("energy_house"), this.formatPower(d.house), "#ff7043", true);
		svg += this.renderBatteryNode(nodes.battery, d.soc, d.battery);
		svg += this.renderNode(
			nodes.grid,
			"grid",
			t("energy_grid"),
			this.formatPower(d.grid),
			d.grid > 0 ? "#ef5350" : d.grid < -10 ? "#42a5f5" : "#90a4ae",
			Math.abs(d.grid) > 10,
		);

		if (hasWallbox) {
			svg += this.renderNode(
				nodes.wallbox,
				"wallbox",
				t("energy_wallbox"),
				this.formatPower(d.wallbox),
				"#ab47bc",
				d.wallbox > 10,
			);
		}

		svg += "</svg>";
		return `<div class="energy-flow-wrap">${svg}</div>`;
	},

	renderNode: function (pos, icon, label, value, color, active) {
		var r = 36;
		var bgOpacity = active ? 0.12 : 0.05;
		var svg = `<g>`;

		// Outer glow when active
		if (active) {
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r + 4}" fill="${color}" opacity="0.08"/>`;
		}

		// Background circle
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="var(--color-card)" filter="url(#shadow)"/>`;
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="${color}" opacity="${bgOpacity}" stroke="${color}" stroke-width="${active ? 2.5 : 1.5}" stroke-opacity="${active ? 0.8 : 0.3}"/>`;

		// Icon
		svg += `<g transform="translate(${pos.x - 10}, ${pos.y - 24}) scale(0.83)" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
		svg += `<path d="${this.icons[icon]}"/>`;
		svg += `</g>`;

		// Value below
		svg += `<text x="${pos.x}" y="${pos.y + 10}" text-anchor="middle" fill="var(--color-text)" font-size="13" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${value}</text>`;

		// Label below circle
		svg += `<text x="${pos.x}" y="${pos.y + r + 16}" text-anchor="middle" fill="var(--color-text-secondary)" font-size="11" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${label}</text>`;

		svg += "</g>";
		return svg;
	},

	renderBatteryNode: function (pos, soc, power) {
		var r = 36;
		var socRounded = soc !== null ? Math.round(soc) : null;
		var color = "#4caf50";
		var active = Math.abs(power) > 10;
		var isLow = socRounded !== null && socRounded <= 20;
		if (isLow) {
			color = "#ff9800";
		}

		var svg = "<g>";

		if (active) {
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r + 4}" fill="${color}" opacity="0.08"/>`;
		}

		// Background
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="var(--color-card)" filter="url(#shadow)"/>`;

		// SOC fill — arc/clip approach
		if (socRounded !== null) {
			var fillH = (r * 2 * socRounded) / 100;
			var clipY = pos.y + r - fillH;
			var clipId = `bat-clip-${Math.random().toString(36).substr(2, 5)}`;
			svg += `<defs><clipPath id="${clipId}"><rect x="${pos.x - r}" y="${clipY}" width="${r * 2}" height="${fillH}"/></clipPath></defs>`;
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r - 1}" fill="${color}" opacity="0.15" clip-path="url(#${clipId})"/>`;
		}

		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="none" stroke="${color}" stroke-width="${active ? 2.5 : 1.5}" stroke-opacity="${active ? 0.8 : 0.3}"/>`;

		// Icon
		svg += `<g transform="translate(${pos.x - 10}, ${pos.y - 24}) scale(0.83)" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
		svg += `<path d="${this.icons.battery}"/>`;
		svg += `</g>`;

		// Power value (same position as other nodes)
		svg += `<text x="${pos.x}" y="${pos.y + 10}" text-anchor="middle" fill="var(--color-text)" font-size="13" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${this.formatPower(power)}</text>`;

		// Label below: "Battery · 86%"  + optional time estimate
		var label = t("energy_battery");
		if (socRounded !== null) {
			label += ` \u00b7 ${socRounded}%`;
		}
		svg += `<text x="${pos.x}" y="${pos.y + r + 16}" text-anchor="middle" fill="var(--color-text-secondary)" font-size="11" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${label}</text>`;

		var timeEst = this.getBatteryTimeEstimate();
		if (timeEst) {
			svg += `<text x="${pos.x}" y="${pos.y + r + 32}" text-anchor="middle" fill="#999999" font-size="11" font-style="italic" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${timeEst}</text>`;
		}

		svg += "</g>";
		return svg;
	},

	renderCurvedFlow: function (from, to, color, power, curveOffset) {
		if (Math.abs(power) < 1) {
			return "";
		}

		var thickness = Math.min(6, Math.max(2, Math.log10(Math.abs(power) + 1) * 1.5));
		var opacity = Math.min(0.9, Math.max(0.3, Math.abs(power) / 5000));

		// Control point for quadratic curve
		var mx = (from.x + to.x) / 2;
		var my = (from.y + to.y) / 2;
		var offset = curveOffset || 0;

		// Perpendicular offset for curve
		var dx = to.x - from.x;
		var dy = to.y - from.y;
		var len = Math.sqrt(dx * dx + dy * dy);
		if (len > 0 && offset) {
			mx += (-dy / len) * offset;
			my += (dx / len) * offset;
		}

		// Shorten path to not overlap with node circles (radius 36)
		var r = 38;
		var angle1 = Math.atan2(my - from.y, mx - from.x);
		var sx = from.x + r * Math.cos(angle1);
		var sy = from.y + r * Math.sin(angle1);
		var angle2 = Math.atan2(my - to.y, mx - to.x);
		var ex = to.x + r * Math.cos(angle2);
		var ey = to.y + r * Math.sin(angle2);

		var path = `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;

		// Glow under the main path
		var svg = `<path d="${path}" fill="none" stroke="${color}" stroke-width="${(thickness + 4).toFixed(1)}" stroke-opacity="${(opacity * 0.15).toFixed(2)}" stroke-linecap="round"/>`;

		// Main animated path
		svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="${thickness.toFixed(1)}" stroke-opacity="${opacity.toFixed(2)}" stroke-linecap="round" stroke-dasharray="8 6" class="flow-arrow"/>`;

		// Arrowhead at end
		var headAngle = Math.atan2(ey - my, ex - mx);
		var headLen = Math.min(10, thickness + 4);
		var ax = ex - headLen * Math.cos(headAngle - 0.35);
		var ay = ey - headLen * Math.sin(headAngle - 0.35);
		var bx = ex - headLen * Math.cos(headAngle + 0.35);
		var by = ey - headLen * Math.sin(headAngle + 0.35);
		svg += `<polygon points="${ex.toFixed(1)},${ey.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;

		return svg;
	},

	periodLabel: function (p) {
		return t(`period_${p}`);
	},

	renderDayTotals: function (d) {
		var html = '<div class="day-totals">';
		html += '<div class="day-totals-header">';
		html += `<div class="day-totals-title">${this.periodLabel(this.period)}</div>`;
		html += '<div class="day-totals-tabs">';
		var periods = ["today", "month", "year"];
		for (var i = 0; i < periods.length; i++) {
			var p = periods[i];
			var cls = this.period === p ? "period-tab active" : "period-tab";
			html += `<button class="${cls}" onclick="energyFlow.onPeriodChange('${p}')">${this.periodLabel(
				p,
			)}</button>`;
		}
		html += "</div></div>";

		if (d.todayPv === null && d.todayConsumption === null) {
			html += `<div class="stat-label">${t("period_no_data", {
				period: this.periodLabel(this.period).toLowerCase(),
			})}</div>`;
			html += "</div>";
			return html;
		}

		html += '<div class="day-totals-grid">';

		html += this.renderTotalItem(t("total_pv"), d.todayPv, "#f9a825");
		html += this.renderTotalItem(t("total_consumption"), d.todayConsumption, "#ff7043");
		html += this.renderTotalItem(t("total_grid_import"), d.todayGridImport, "#f44336");
		html += this.renderTotalItem(t("total_grid_export"), d.todayGridExport, "#2196f3");
		html += this.renderTotalItem(t("total_battery_charge"), d.todayBatteryCharge, "#4caf50");
		html += this.renderTotalItem(t("total_battery_discharge"), d.todayBatteryDischarge, "#66bb6a");

		if (d.todayWallbox !== null && d.todayWallbox > 0) {
			html += this.renderTotalItem(t("total_wallbox"), d.todayWallbox, "#9c27b0");
		}

		if (d.autarky !== null) {
			html += this.renderTotalItem(t("total_self_sufficiency"), null, "#157c00", `${Math.round(d.autarky)}%`);
		}

		html += "</div></div>";
		return html;
	},

	renderTotalItem: function (label, value, color, customValue) {
		return (
			`<div class="day-total-item">` +
			`<div class="day-total-color" style="background:${color}"></div>` +
			`<div class="day-total-label">${label}</div>` +
			`<div class="day-total-value">${customValue || this.formatKwh(value)}</div>` +
			`</div>`
		);
	},

	onSourceChange: function (val) {
		this.source = val;
		this.update(app.states, app.connectors);
		app.renderDashboard();
	},

	onPeriodChange: function (val) {
		this.period = val;
		this.update(app.states, app.connectors);
		app.renderDashboard();
	},
};
