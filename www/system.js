"use strict";

/* global t, energyFlow */
/* exported systemInfo */

/**
 * System information cards for the SENEC web dashboard.
 * Shows operating mode, battery health, grid quality, system details.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var systemInfo = {
	/**
	 * Get a state value with fallback across connectors
	 *
	 * @param {object} states - ioBroker state values
	 * @param {Array<string>} keys - State keys to try in order
	 * @returns {string|number|boolean|null} First found value or null
	 */
	getFirst: function (states, keys) {
		for (var i = 0; i < keys.length; i++) {
			var val = states[keys[i]];
			if (val !== undefined && val !== null) {
				return val;
			}
		}
		return null;
	},

	/**
	 * Detect which connector a state key comes from
	 *
	 * @param {object} states - ioBroker state values
	 * @param {Array<string>} keys - State keys to check
	 */
	sourceTag: function (states, keys) {
		for (var i = 0; i < keys.length; i++) {
			if (!keys[i]) {
				continue;
			}
			if (states[keys[i]] !== undefined && states[keys[i]] !== null) {
				if (keys[i].startsWith("_api.")) {
					return "A";
				}
				if (keys[i].startsWith("_meinsenec.")) {
					return "W";
				}
				return "L";
			}
		}
		return "";
	},

	/**
	 * Render a tiny source indicator
	 *
	 * @param {string} tag - Source tag (L/A/W)
	 */
	srcBadge: function (tag) {
		if (!tag) {
			return "";
		}
		var colors = { L: "#4caf50", A: "#2196f3", W: "#ff9800" };
		var labels = { L: "Local", A: "API", W: "Web" };
		var hasMismatch = tag.indexOf("!") !== -1;
		var clean = tag.replace(/[! ]/g, "");
		var html = " ";
		for (var ci = 0; ci < clean.length; ci++) {
			var ch = clean[ci];
			html += `<span class="src-badge" title="${labels[ch] || ch}" style="color:${colors[ch] || "#999"}">${ch}</span>`;
		}
		if (hasMismatch) {
			html += '<span class="src-badge" style="color:#f44336" title="Mismatch">!</span>';
		}
		return html;
	},

	/**
	 * Get API prefix for SystemDetails
	 *
	 * @returns {string|null} Prefix or null
	 */
	apiDetailsPfx: function () {
		var id = energyFlow.apiAnlagenId;
		return id ? `_api.Anlagen.${id}.SystemDetails.` : null;
	},

	/**
	 * Get API prefix for SystemStatus
	 *
	 * @returns {string|null} Prefix or null
	 */
	apiStatusPfx: function () {
		var id = energyFlow.apiAnlagenId;
		return id ? `_api.Anlagen.${id}.SystemStatus.` : null;
	},

	/**
	 * Get the number of battery modules from states
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {number} Module count, defaulting to 4
	 */
	getModuleCount: function (states) {
		var ap = this.apiDetailsPfx();
		var val = this.getFirst(states, ["BMS.MODULE_COUNT", ap ? `${ap}batteryPack.numberOfBatteryModules` : ""]);
		return val !== null ? Number(val) : 4;
	},

	/**
	 * Render the operating mode badge for the energy flow card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderOperatingMode: function (states) {
		var as = this.apiStatusPfx();
		var mode = this.getFirst(states, [
			"ENERGY.STAT_STATE_Text",
			as ? `${as}name` : "",
			"_meinsenec.Status.steuereinheitState",
		]);
		if (!mode) {
			return "";
		}

		// Clean up mode text: replace underscores, title case
		var modeText = String(mode).replace(/_/g, " ");
		var color = "#90a4ae";
		var lower = modeText.toLowerCase();
		if (lower.indexOf("laden") !== -1 || lower.indexOf("charg") !== -1) {
			color = "#4caf50";
		}
		if (lower.indexOf("entladen") !== -1 || lower.indexOf("discharg") !== -1) {
			color = "#ff9800";
		}
		if (lower.indexOf("standby") !== -1 || lower.indexOf("idle") !== -1) {
			color = "#90a4ae";
		}
		if (lower.indexOf("pv") !== -1) {
			color = "#f9a825";
		}
		if (lower.indexOf("netz") !== -1 || lower.indexOf("grid") !== -1) {
			color = "#ef5350";
		}

		return `<div class="system-mode-badge" style="border-color:${color};color:${color}">${modeText}</div>`;
	},

	/**
	 * Render battery SOH card (state of health, per-pack SOH, module count)
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderBatteryHealth: function (states) {
		var ap = this.apiDetailsPfx();

		// System SOH (multiply 0.1 already applied by adapter)
		var sysSohKeys = ["BMS.SYSTEM_SOH", ap ? `${ap}batteryPack.remainingCapacityInPercent` : ""];
		var sysSoh = this.getFirst(states, sysSohKeys);
		var modKeys = ["BMS.MODULE_COUNT", ap ? `${ap}batteryPack.numberOfBatteryModules` : ""];
		var modules = this.getFirst(states, modKeys);

		var moduleCount = this.getModuleCount(states);

		// Check if any per-pack SOH exists
		var hasPackSoh = false;
		for (var p = 0; p < moduleCount; p++) {
			if (this.getFirst(states, [`BMS.SOH.${p}`]) !== null) {
				hasPackSoh = true;
				break;
			}
		}

		if (sysSoh === null && !hasPackSoh && modules === null) {
			return "";
		}

		var html = `<div class="card"><h2>${t("battery_health")}</h2>`;
		html += '<div class="system-grid">';

		// System SOH
		if (sysSoh !== null) {
			var sohVal = Number(sysSoh);
			var sohColor = sohVal > 80 ? "#4caf50" : sohVal > 60 ? "#ff9800" : "#f44336";
			html += this.renderMetric(
				t("battery_soh"),
				`${Math.round(sohVal)}%`,
				sohColor,
				this.sourceTag(states, sysSohKeys),
			);
		}

		// Per-pack SOH (BMS.SOH.0, .1, ...)
		for (var ps = 0; ps < moduleCount; ps++) {
			var packSoh = this.getFirst(states, [`BMS.SOH.${ps}`]);
			if (packSoh !== null) {
				var pVal = Number(packSoh);
				var pColor = pVal > 80 ? "#4caf50" : pVal > 60 ? "#ff9800" : "#f44336";
				html += this.renderMetric(`SOH Pack ${ps + 1}`, `${Math.round(pVal)}%`, pColor, "L");
			}
		}

		if (modules !== null) {
			html += this.renderMetric(
				t("battery_modules"),
				Math.round(Number(modules)),
				"#757575",
				this.sourceTag(states, modKeys),
			);
		}

		// Module status counts
		var nrActive = this.getFirst(states, ["BMS.NR_ACTIVE"]);
		var nrCharge = this.getFirst(states, ["BMS.NR_CHARGE"]);
		var nrDischarge = this.getFirst(states, ["BMS.NR_DISCHARGE"]);
		if (nrActive !== null || nrCharge !== null || nrDischarge !== null) {
			if (nrActive !== null) {
				html += this.renderMetric(t("battery_active"), Math.round(Number(nrActive)), "#757575", "L");
			}
			if (nrCharge !== null) {
				html += this.renderMetric(t("battery_charging"), Math.round(Number(nrCharge)), "#4caf50", "L");
			}
			if (nrDischarge !== null) {
				html += this.renderMetric(t("battery_discharging"), Math.round(Number(nrDischarge)), "#ff9800", "L");
			}
		}

		html += "</div></div>";
		return html;
	},

	/**
	 * Render battery cycles and lifetime energy card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderBatteryCycles: function (states) {
		var moduleCount = this.getModuleCount(states);

		// Check if any cycle or energy data exists
		var hasData = false;
		for (var c = 0; c < moduleCount; c++) {
			if (
				this.getFirst(states, [`BMS.CYCLES.${c}`]) !== null ||
				this.getFirst(states, [`BMS.CHARGED_ENERGY.${c}`]) !== null
			) {
				hasData = true;
				break;
			}
		}

		if (!hasData) {
			return "";
		}

		var html = `<div class="card"><h2>${t("battery_cycles_energy")}${this.srcBadge("L")}</h2>`;
		html += '<table class="grid-phase-table">';

		// Column headers
		html += '<tr class="grid-header-row">';
		html += "<th></th>";
		html += `<th>${t("battery_cycles")}</th>`;
		html += `<th>${t("battery_charged")}</th>`;
		html += `<th>${t("battery_discharged")}</th>`;
		html += "</tr>";

		for (var m = 0; m < moduleCount; m++) {
			var cycles = this.getFirst(states, [`BMS.CYCLES.${m}`]);
			var charged = this.getFirst(states, [`BMS.CHARGED_ENERGY.${m}`]);
			var discharged = this.getFirst(states, [`BMS.DISCHARGED_ENERGY.${m}`]);

			if (cycles === null && charged === null && discharged === null) {
				continue;
			}

			html += "<tr>";
			html += `<td class="grid-phase-label">Pack ${m + 1}</td>`;
			html += cycles !== null ? `<td>${Math.round(Number(cycles))}</td>` : "<td>—</td>";
			html += charged !== null ? `<td>${(Number(charged) / 1000).toFixed(0)} kWh</td>` : "<td>—</td>";
			html += discharged !== null ? `<td>${(Number(discharged) / 1000).toFixed(0)} kWh</td>` : "<td>—</td>";
			html += "</tr>";
		}

		html += "</table></div>";
		return html;
	},

	/**
	 * Render battery temperatures card (overall and per-module temps, per-module cell temps)
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderBatteryTemps: function (states) {
		var ap = this.apiDetailsPfx();

		// Overall min/max temp (multiply 0.1 already applied → °C)
		var minT = this.getFirst(states, ["BMS.MIN_TEMP"]);
		var maxT = this.getFirst(states, ["BMS.MAX_TEMP"]);

		// API temps as fallback
		var apiMinT = ap ? this.getFirst(states, [`${ap}batteryModules.minTemperature`]) : null;
		var apiMaxT = ap ? this.getFirst(states, [`${ap}batteryModules.maxTemperature`]) : null;

		var moduleCount = this.getModuleCount(states);
		var modLetters = ["A", "B", "C", "D"];

		// Check if any per-module data exists
		var hasModuleTemp = false;
		for (var mt = 0; mt < moduleCount; mt++) {
			if (
				this.getFirst(states, [`BMS.TEMP_MIN.${mt}`]) !== null ||
				this.getFirst(states, [`BMS.CELL_TEMPERATURES_MODULE_${modLetters[mt]}.0`]) !== null
			) {
				hasModuleTemp = true;
				break;
			}
		}

		if (minT === null && apiMinT === null && !hasModuleTemp) {
			return "";
		}

		var html = `<div class="card"><h2>${t("battery_temp")}</h2>`;
		html += '<div class="system-grid">';

		// Overall temp range (values already in °C from multiply 0.1)
		if (minT !== null && maxT !== null) {
			html += this.renderMetric(
				t("battery_temp"),
				`${Number(minT).toFixed(1)} - ${Number(maxT).toFixed(1)} °C`,
				"#757575",
				"L",
			);
		} else if (apiMinT !== null && apiMaxT !== null) {
			html += this.renderMetric(
				t("battery_temp"),
				`${Number(apiMinT).toFixed(1)} - ${Number(apiMaxT).toFixed(1)} °C`,
				"#757575",
				"A",
			);
		}

		// Per-module temps (BMS.TEMP_MIN.n, BMS.TEMP_MAX.n)
		for (var m = 0; m < moduleCount; m++) {
			var modMinT = this.getFirst(states, [`BMS.TEMP_MIN.${m}`]);
			var modMaxT = this.getFirst(states, [`BMS.TEMP_MAX.${m}`]);
			if (modMinT !== null && modMaxT !== null) {
				html += this.renderMetric(
					`${t("battery_temp")} M${m + 1}`,
					`${Number(modMinT).toFixed(1)} - ${Number(modMaxT).toFixed(1)} °C`,
					"#757575",
					"L",
				);
			}

			// Per-module cell temperatures (BMS.CELL_TEMPERATURES_MODULE_{A-D}.{n})
			var cellTemps = [];
			for (var ct = 0; ct < 20; ct++) {
				var ctVal = this.getFirst(states, [`BMS.CELL_TEMPERATURES_MODULE_${modLetters[m]}.${ct}`]);
				if (ctVal !== null && Number(ctVal) !== 0) {
					cellTemps.push(Number(ctVal));
				}
			}
			if (cellTemps.length > 0) {
				var ctMin = Math.min.apply(null, cellTemps);
				var ctMax = Math.max.apply(null, cellTemps);
				html += this.renderMetric(
					`${t("battery_cells")} M${m + 1}`,
					`${ctMin.toFixed(1)} - ${ctMax.toFixed(1)} °C`,
					"#757575",
					"L",
				);
			}
		}

		html += "</div></div>";
		return html;
	},

	/**
	 * Render battery cell voltages card (overall range and per-module cell voltages)
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderBatteryVoltages: function (states) {
		// Overall min/max cell voltage (multiply 0.01 already applied → V)
		var minV = this.getFirst(states, ["BMS.MIN_CELL_VOLTAGE"]);
		var maxV = this.getFirst(states, ["BMS.MAX_CELL_VOLTAGE"]);

		var moduleCount = this.getModuleCount(states);
		var modLetters = ["A", "B", "C", "D"];

		// Check if any per-module voltage or current data exists
		var hasModuleVolt = false;
		var hasPackElectrical = false;
		for (var mv = 0; mv < Math.min(moduleCount, 4); mv++) {
			if (this.getFirst(states, [`BMS.CELL_VOLTAGES_MODULE_${modLetters[mv]}.0`]) !== null) {
				hasModuleVolt = true;
			}
			if (
				this.getFirst(states, [`BMS.VOLTAGE.${mv}`]) !== null ||
				this.getFirst(states, [`BMS.CURRENT.${mv}`]) !== null
			) {
				hasPackElectrical = true;
			}
		}

		if (minV === null && !hasModuleVolt && !hasPackElectrical) {
			return "";
		}

		var html = `<div class="card"><h2>${t("battery_cell_voltage")}${this.srcBadge("L")}</h2>`;
		html += '<div class="system-grid">';

		// Overall cell voltage range (values already in V from multiply 0.01)
		if (minV !== null && maxV !== null) {
			html += this.renderMetric(
				t("battery_cell_voltage"),
				`${Number(minV).toFixed(2)} - ${Number(maxV).toFixed(2)} V`,
				"#757575",
				"L",
			);
			var deltaMv = ((Number(maxV) - Number(minV)) * 1000).toFixed(0);
			var deltaColor = Number(deltaMv) < 50 ? "#4caf50" : Number(deltaMv) < 100 ? "#ff9800" : "#f44336";
			html += this.renderMetric(t("battery_cell_delta"), `${deltaMv} mV`, deltaColor, "L");
		}

		html += "</div>";

		// Per-module pack voltage and current table
		if (hasPackElectrical) {
			html += '<table class="grid-phase-table">';
			html += '<tr class="grid-header-row">';
			html += "<th></th>";
			html += `<th>${t("grid_voltage")}</th>`;
			html += `<th>${t("grid_current")}</th>`;
			html += "</tr>";

			for (var pe = 0; pe < moduleCount; pe++) {
				var packV = this.getFirst(states, [`BMS.VOLTAGE.${pe}`]);
				var packI = this.getFirst(states, [`BMS.CURRENT.${pe}`]);
				if (packV === null && packI === null) {
					continue;
				}
				html += "<tr>";
				html += `<td class="grid-phase-label">Pack ${pe + 1}</td>`;
				html += packV !== null ? `<td>${Number(packV).toFixed(1)} V</td>` : "<td>—</td>";
				html += packI !== null ? `<td>${Number(packI).toFixed(2)} A</td>` : "<td>—</td>";
				html += "</tr>";
			}

			html += "</table>";
		}

		// Per-module cell voltages — heatmap + range summary
		if (hasModuleVolt) {
			html += this.renderCellHeatmap(states, moduleCount, modLetters);
		}

		html += "</div>";
		return html;
	},

	/**
	 * Render cell voltage heatmap — SVG grid with color-coded cells.
	 * Rows = modules, columns = cells. Color: green (balanced) → yellow → red (imbalanced).
	 *
	 * @param {object} states - ioBroker state values
	 * @param {number} moduleCount - Number of battery modules
	 * @param {Array<string>} modLetters - Module letter identifiers
	 * @returns {string} HTML string with SVG heatmap
	 */
	renderCellHeatmap: function (states, moduleCount, modLetters) {
		// Collect all cell voltages per module
		var modules = [];
		var allCells = [];
		var maxCells = 0;

		for (var m = 0; m < Math.min(moduleCount, 4); m++) {
			var cells = [];
			for (var cv = 0; cv < 20; cv++) {
				var val = this.getFirst(states, [`BMS.CELL_VOLTAGES_MODULE_${modLetters[m]}.${cv}`]);
				if (val !== null && Number(val) > 0) {
					var numVal = Number(val);
					cells.push(numVal);
					allCells.push(numVal);
				}
			}
			modules.push(cells);
			if (cells.length > maxCells) {
				maxCells = cells.length;
			}
		}

		if (allCells.length === 0 || maxCells === 0) {
			return "";
		}

		// Global min/max for color scale
		var globalMin = Math.min.apply(null, allCells);
		var globalMax = Math.max.apply(null, allCells);
		var globalDelta = globalMax - globalMin;

		// SVG dimensions
		var cellW = 36;
		var cellH = 28;
		var gap = 2;
		var labelW = 40;
		var legendH = 30;
		var svgW = labelW + maxCells * (cellW + gap);
		var svgH = modules.length * (cellH + gap) + legendH + 10;

		var html = '<div style="margin-top:10px;overflow-x:auto">';
		html += `<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg" style="font-family:sans-serif;font-size:10px">`;

		// Render cells
		for (var mi = 0; mi < modules.length; mi++) {
			var y = mi * (cellH + gap);
			// Module label
			html += `<text x="2" y="${y + cellH / 2 + 4}" fill="#999" font-size="11" font-weight="bold">M${mi + 1}</text>`;

			for (var ci = 0; ci < modules[mi].length; ci++) {
				var x = labelW + ci * (cellW + gap);
				var cellVal = modules[mi][ci];
				var color = this.heatmapColor(cellVal, globalMin, globalMax, globalDelta);
				var textColor = this.heatmapTextColor(cellVal, globalMin, globalMax, globalDelta);

				html += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" fill="${color}">`;
				html += `<title>M${mi + 1} Cell ${ci + 1}: ${cellVal} mV</title>`;
				html += "</rect>";
				html += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" fill="${textColor}" font-size="9">${cellVal}</text>`;
			}

			// Per-module delta
			if (modules[mi].length > 1) {
				var modMin = Math.min.apply(null, modules[mi]);
				var modMax = Math.max.apply(null, modules[mi]);
				var modDelta = modMax - modMin;
				var deltaX = labelW + modules[mi].length * (cellW + gap) + 4;
				var deltaColor = modDelta < 50 ? "#4caf50" : modDelta < 100 ? "#ff9800" : "#f44336";
				html += `<text x="${deltaX}" y="${y + cellH / 2 + 4}" fill="${deltaColor}" font-size="10">\u0394${modDelta.toFixed(0)}</text>`;
			}
		}

		// Legend bar
		var legendY = modules.length * (cellH + gap) + 8;
		var legendW = Math.min(200, svgW - labelW - 60);
		var legendX = labelW;
		// Gradient definition
		html += "<defs>";
		html += `<linearGradient id="heatGrad" x1="0%" y1="0%" x2="100%" y2="0%">`;
		html += '<stop offset="0%" stop-color="#f44336"/>';
		html += '<stop offset="30%" stop-color="#ff9800"/>';
		html += '<stop offset="60%" stop-color="#ffeb3b"/>';
		html += '<stop offset="100%" stop-color="#4caf50"/>';
		html += "</linearGradient>";
		html += "</defs>";
		html += `<rect x="${legendX}" y="${legendY}" width="${legendW}" height="12" rx="2" fill="url(#heatGrad)"/>`;
		html += `<text x="${legendX}" y="${legendY + 24}" fill="#999" font-size="9">${globalMin} mV</text>`;
		html += `<text x="${legendX + legendW}" y="${legendY + 24}" text-anchor="end" fill="#999" font-size="9">${globalMax} mV</text>`;

		html += "</svg></div>";
		return html;
	},

	/**
	 * Calculate heatmap cell color based on value relative to global range.
	 * Lowest = red, middle = yellow, highest = green.
	 *
	 * @param {number} val - Cell voltage in mV
	 * @param {number} min - Global minimum
	 * @param {number} max - Global maximum
	 * @param {number} delta - Global delta (max - min)
	 * @returns {string} CSS color
	 */
	heatmapColor: function (val, min, max, delta) {
		if (delta < 5) {
			return "#4caf50"; // All cells essentially equal — green
		}
		var ratio = (val - min) / delta; // 0 = lowest, 1 = highest
		// Red → Orange → Yellow → Green
		if (ratio < 0.33) {
			// Red to Orange
			var r1 = Math.round(244 + (255 - 244) * (ratio / 0.33));
			var g1 = Math.round(67 + (152 - 67) * (ratio / 0.33));
			return `rgb(${r1},${g1},54)`;
		}
		if (ratio < 0.66) {
			// Orange to Yellow
			var r2 = Math.round(255);
			var g2 = Math.round(152 + (235 - 152) * ((ratio - 0.33) / 0.33));
			var b2 = Math.round(0 + (59 - 0) * ((ratio - 0.33) / 0.33));
			return `rgb(${r2},${g2},${b2})`;
		}
		// Yellow to Green
		var r3 = Math.round(255 - (255 - 76) * ((ratio - 0.66) / 0.34));
		var g3 = Math.round(235 - (235 - 175) * ((ratio - 0.66) / 0.34));
		var b3 = Math.round(59 - (59 - 80) * ((ratio - 0.66) / 0.34));
		return `rgb(${r3},${g3},${b3})`;
	},

	/**
	 * Determine text color for readability against heatmap background.
	 *
	 * @param {number} val - Cell voltage in mV
	 * @param {number} min - Global minimum
	 * @param {number} max - Global maximum
	 * @param {number} delta - Global delta
	 * @returns {string} CSS color for text
	 */
	heatmapTextColor: function (val, min, max, delta) {
		if (delta < 5) {
			return "#fff";
		}
		var ratio = (val - min) / delta;
		// Dark text on light backgrounds (yellow/green middle), white on dark (red)
		return ratio < 0.25 ? "#fff" : "#333";
	},

	/**
	 * Render a single EnFluRi meter table
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} prefix - State prefix (PM1OBJ1 or PM1OBJ2)
	 * @returns {string} HTML table or empty string
	 */
	renderMeterTable: function (states, prefix) {
		var freq = this.getFirst(states, [`${prefix}.FREQ`]);
		var pTotal = this.getFirst(states, [`${prefix}.P_TOTAL`]);
		var skew = prefix === "PM1OBJ1" ? this.getFirst(states, ["ENERGY.STAT_LIMITED_NET_SKEW"]) : null;

		// Check if meter has any non-zero voltage on any phase
		var hasVoltage = false;
		for (var c = 0; c < 3; c++) {
			var uCheck = this.getFirst(states, [`${prefix}.U_AC.${c}`]);
			if (uCheck !== null && Number(uCheck) !== 0) {
				hasVoltage = true;
				break;
			}
		}

		if (!hasVoltage) {
			return "";
		}

		var html = '<table class="grid-phase-table">';

		// Frequency as spanning header row
		if (freq !== null) {
			var freqVal = Number(freq).toFixed(2);
			var freqColor = Math.abs(Number(freq) - 50) < 0.1 ? "#4caf50" : "#ff9800";
			html += `<tr class="grid-freq-row"><td class="grid-phase-label">${t("grid_frequency")}</td>`;
			html += `<td colspan="3" style="color:${freqColor}">${freqVal} Hz`;
			if (skew !== null && Number(skew) !== 0) {
				html += ` <span style="color:#f44336;font-size:12px;margin-left:12px">⚠ ${t("grid_skew_active")}</span>`;
			}
			html += "</td></tr>";
		}

		// Total power row
		if (pTotal !== null) {
			html += `<tr class="grid-freq-row"><td class="grid-phase-label">${t("grid_power_total")}</td>`;
			html += `<td colspan="3">${Math.round(Number(pTotal))} W</td></tr>`;
		}

		// Column headers
		html += '<tr class="grid-header-row">';
		html += "<th></th>";
		html += `<th>${t("grid_voltage")}</th>`;
		html += `<th>${t("grid_power")}</th>`;
		html += `<th>${t("grid_current")}</th>`;
		html += "</tr>";

		// Per-phase rows
		for (var p = 0; p < 3; p++) {
			var uVal = this.getFirst(states, [`${prefix}.U_AC.${p}`]);
			var pVal = this.getFirst(states, [`${prefix}.P_AC.${p}`]);
			var iVal = this.getFirst(states, [`${prefix}.I_AC.${p}`]);

			if (uVal === null && pVal === null && iVal === null) {
				continue;
			}

			html += "<tr>";
			html += `<td class="grid-phase-label">L${p + 1}</td>`;

			if (uVal !== null) {
				var vColor = Math.abs(Number(uVal) - 230) < 15 ? "#4caf50" : "#ff9800";
				html += `<td style="color:${vColor}">${Number(uVal).toFixed(1)} V</td>`;
			} else {
				html += "<td>—</td>";
			}
			if (pVal !== null) {
				html += `<td>${Math.round(Number(pVal))} W</td>`;
			} else {
				html += "<td>—</td>";
			}
			if (iVal !== null) {
				html += `<td>${Number(iVal).toFixed(2)} A</td>`;
			} else {
				html += "<td>—</td>";
			}

			html += "</tr>";
		}

		html += "</table>";
		return html;
	},

	renderGridQuality: function (states) {
		var meter1 = this.renderMeterTable(states, "PM1OBJ1");
		var meter2 = this.renderMeterTable(states, "PM1OBJ2");

		if (!meter1 && !meter2) {
			return "";
		}

		var html = `<div class="card"><h2>${t("grid_quality")}${this.srcBadge("L")}</h2>`;

		if (meter1) {
			if (meter2) {
				html += `<h3 class="grid-meter-heading">EnFluRi 1</h3>`;
			}
			html += meter1;
		}

		if (meter2) {
			html += `<h3 class="grid-meter-heading">EnFluRi 2</h3>`;
			html += meter2;
		}

		html += "</div>";
		return html;
	},

	/**
	 * Render system details card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderSystemDetails: function (states) {
		var ap = this.apiDetailsPfx();
		var as = this.apiStatusPfx();

		var prodKeys = [
			"FACTORY.SYS_TYPE_Text",
			ap ? `${ap}systemOverview.productName` : "",
			"_meinsenec.Status.produktName",
		];
		var product = this.getFirst(states, prodKeys);
		var fwKeys = ["WIZARD.FIRMWARE_VERSION", as ? `${as}firmwareVersion` : ""];
		var fw = this.getFirst(states, fwKeys);
		var npuKeys = ["SYS_UPDATE.NPU_IMAGE_VERSION"];
		var npu = this.getFirst(states, npuKeys);
		var guiKeys = ["WIZARD.INTERFACE_VERSION", as ? `${as}guiVersion` : ""];
		var gui = this.getFirst(states, guiKeys);
		var ctKeys = ["TEMPMEASURE.CASE_TEMP", ap ? `${ap}casing.temperatureInCelsius` : ""];
		var casingTemp = this.getFirst(states, ctKeys);
		var mcuTemp = this.getFirst(states, ["TEMPMEASURE.MCU_TEMP"]);
		var batTemp = this.getFirst(states, ["TEMPMEASURE.BATTERY_TEMP"]);

		var invAmbKeys = ap ? [`${ap}batteryInverter.temperatures.amb`] : [];
		var invAmb = ap ? this.getFirst(states, invAmbKeys) : null;
		var invMaxKeys = ap ? [`${ap}batteryInverter.temperatures.max`] : [];
		var invMax = ap ? this.getFirst(states, invMaxKeys) : null;
		var invStateKeys = [ap ? `${ap}batteryInverter.state.name` : ""];
		var invState = this.getFirst(states, invStateKeys);

		if (!product && !fw && !casingTemp && !invAmb) {
			return "";
		}

		var html = `<div class="card"><h2>${t("system_details")}</h2>`;
		html += '<div class="system-grid">';

		if (product) {
			html += this.renderMetric(t("system_product"), product, "#757575", this.sourceTag(states, prodKeys));
		}
		if (fw) {
			html += this.renderMetric(t("system_firmware"), fw, "#757575", this.sourceTag(states, fwKeys));
		}
		if (npu) {
			html += this.renderMetric(t("system_npu_version"), String(npu), "#757575", this.sourceTag(states, npuKeys));
		}
		if (gui) {
			html += this.renderMetric(t("system_gui_version"), gui, "#757575", this.sourceTag(states, guiKeys));
		}
		if (invState) {
			html += this.renderMetric(
				t("system_inverter_state"),
				String(invState),
				"#757575",
				this.sourceTag(states, invStateKeys),
			);
		}
		if (casingTemp !== null) {
			var ct = Number(casingTemp).toFixed(1);
			html += this.renderMetric(
				t("system_casing_temp"),
				`${ct} °C`,
				Number(casingTemp) > 45 ? "#ff9800" : "#757575",
				this.sourceTag(states, ctKeys),
			);
		}
		if (mcuTemp !== null) {
			html += this.renderMetric(t("system_mcu_temp"), `${Number(mcuTemp).toFixed(1)} °C`, "#757575", "L");
		}
		if (batTemp !== null) {
			html += this.renderMetric(t("system_battery_temp"), `${Number(batTemp).toFixed(1)} °C`, "#757575", "L");
		}
		if (invAmb !== null) {
			html += this.renderMetric(t("system_inverter_temp"), `${Number(invAmb).toFixed(1)} °C`, "#757575", "A");
		}
		if (invMax !== null) {
			html += this.renderMetric(
				t("system_inverter_max_temp"),
				`${Number(invMax).toFixed(1)} °C`,
				Number(invMax) > 60 ? "#ff9800" : "#757575",
				"A",
			);
		}

		// Operating hours
		var opsHours = this.getFirst(states, ["ENERGY.STAT_HOURS_OF_OPERATION"]);
		if (opsHours !== null) {
			html += this.renderMetric(t("system_operating_hours"), `${Math.round(Number(opsHours))} h`, "#757575", "L");
		}

		// Installation date
		var installKeys = [ap ? `${ap}systemOverview.installationDateTime` : ""];
		var installDate = this.getFirst(states, installKeys);
		if (installDate !== null) {
			var dateStr = String(installDate);
			if (dateStr.length > 10) {
				dateStr = dateStr.substring(0, 10);
			}
			html += this.renderMetric(
				t("system_install_date"),
				dateStr,
				"#757575",
				this.sourceTag(states, installKeys),
			);
		}

		// Installer info
		var installerCompany = ap ? this.getFirst(states, [`${ap}installer.companyName`]) : null;
		var installerPhone = ap ? this.getFirst(states, [`${ap}installer.phoneNumber`]) : null;
		var installerEmail = ap ? this.getFirst(states, [`${ap}installer.email`]) : null;
		if (installerCompany) {
			html += this.renderMetric(t("system_installer"), String(installerCompany), "#757575", "A");
		}
		if (installerPhone) {
			html += this.renderMetric(t("system_installer_phone"), String(installerPhone), "#757575", "A");
		}
		if (installerEmail) {
			html += this.renderMetric(t("system_installer_email"), String(installerEmail), "#757575", "A");
		}

		html += "</div></div>";
		return html;
	},

	/**
	 * Render PV string details card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderPvStrings: function (states) {
		var power = this.getFirst(states, ["PV1.MPP_POWER.0"]);
		var voltage = this.getFirst(states, ["PV1.MPP_VOL.0"]);
		var current = this.getFirst(states, ["PV1.MPP_CUR.0"]);

		if (power === null && voltage === null && current === null) {
			return "";
		}

		var html = `<div class="card"><h2>${t("pv_strings")}${this.srcBadge("L")}</h2>`;
		html += '<table class="grid-phase-table">';
		html += '<tr class="grid-header-row">';
		html += "<th></th>";
		html += `<th>${t("grid_power")}</th>`;
		html += `<th>${t("grid_voltage")}</th>`;
		html += `<th>${t("grid_current")}</th>`;
		html += "</tr>";

		// Check for multiple MPP trackers (PV1.MPP_POWER.0, .1, .2...)
		for (var s = 0; s < 4; s++) {
			var sp = this.getFirst(states, [`PV1.MPP_POWER.${s}`]);
			var sv = this.getFirst(states, [`PV1.MPP_VOL.${s}`]);
			var si = this.getFirst(states, [`PV1.MPP_CUR.${s}`]);

			if (sp === null && sv === null && si === null) {
				break;
			}

			html += "<tr>";
			html += `<td class="grid-phase-label">MPP ${s + 1}</td>`;
			html += sp !== null ? `<td>${Math.round(Number(sp))} W</td>` : "<td>—</td>";
			html += sv !== null ? `<td>${Number(sv).toFixed(1)} V</td>` : "<td>—</td>";
			html += si !== null ? `<td>${Number(si).toFixed(2)} A</td>` : "<td>—</td>";
			html += "</tr>";
		}

		html += "</table></div>";
		return html;
	},

	/**
	 * Render wallbox info card (status, per-phase current)
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderWallboxInfo: function (states) {
		var evConn = this.getFirst(states, ["WALLBOX.EV_CONNECTED.0"]);
		var smartCharge = this.getFirst(states, ["WALLBOX.SMART_CHARGE_ACTIVE.0"]);
		var l1Current = this.getFirst(states, ["WALLBOX.L1_CHARGING_CURRENT.0"]);
		var l2Current = this.getFirst(states, ["WALLBOX.L2_CHARGING_CURRENT.0"]);
		var l3Current = this.getFirst(states, ["WALLBOX.L3_CHARGING_CURRENT.0"]);

		if (evConn === null && l1Current === null) {
			return "";
		}

		var html = `<div class="card"><h2>${t("energy_wallbox")}</h2>`;
		html += '<div class="system-grid">';

		if (evConn !== null) {
			var connected = this.toBool(evConn);
			html += this.renderStatus(t("wallbox_ev_connected"), connected, "L");
		}
		if (smartCharge !== null) {
			var active = this.toBool(smartCharge);
			html += this.renderStatus(t("wallbox_smart_charge"), active, "L");
		}

		html += "</div>";

		// Per-phase charging current
		if (l1Current !== null || l2Current !== null || l3Current !== null) {
			html += '<table class="grid-phase-table">';
			html += '<tr class="grid-header-row">';
			html += "<th></th>";
			html += `<th>${t("grid_current")}</th>`;
			html += "</tr>";

			var phases = [l1Current, l2Current, l3Current];
			for (var wp = 0; wp < 3; wp++) {
				if (phases[wp] !== null) {
					html += "<tr>";
					html += `<td class="grid-phase-label">L${wp + 1}</td>`;
					html += `<td>${Number(phases[wp]).toFixed(2)} A</td>`;
					html += "</tr>";
				}
			}
			html += "</table>";
		}

		html += "</div>";
		return html;
	},

	/**
	 * Render SG-Ready and peak shaving status
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	/** Feature definitions: label, keys per connector [local, api, web] */
	featureDefs: [
		{ label: "SG-Ready", local: "FEATURES.SGREADY", api: "Abilities.SG_READY", web: "info.abilities.sgReady" },
		{ label: "Peak Shaving", local: "FEATURES.PEAKSHAVING", api: null, web: "info.abilities.peakShaving" },
		{ label: "Sockets", local: "FEATURES.SOCKETS", api: "Abilities.SOCKETS", web: "info.abilities.sockets" },
		{ label: "Wallbox", local: "FEATURES.CAR", api: "Abilities.MOBILITY", web: "info.abilities.wallbox" },
		{
			label: "Heating Rod",
			local: "FEATURES.HEAT",
			api: "Abilities.HEATING_ROD",
			web: "info.abilities.heatingRod",
		},
		{ label: "Island", local: "FEATURES.ISLAND", api: null, web: "info.abilities.autarky" },
		{ label: "Island Pro", local: "FEATURES.ISLAND_PRO", api: null, web: null },
		{ label: "Cloud Ready", local: "FEATURES.CLOUDREADY", api: null, web: null },
		{ label: "SHKW", local: "FEATURES.SHKW", api: null, web: null },
		{ label: "Battery", local: null, api: null, web: "info.abilities.battery" },
	],

	toBool: function (val) {
		if (val === null || val === undefined) {
			return null;
		}
		if (val === true || val === 1 || val === "true") {
			return true;
		}
		if (val === false || val === 0 || val === "false") {
			return false;
		}
		return Number(val) > 0;
	},

	renderFeatureStatus: function (states) {
		var ap = this.apiDetailsPfx();
		var apAbilities = ap ? ap.replace("SystemDetails.", "") : null;
		var hasAny = false;

		var html = `<div class="card"><h2>${t("feature_status")}</h2>`;
		html += '<div class="system-grid">';

		for (var fi = 0; fi < this.featureDefs.length; fi++) {
			var feat = this.featureDefs[fi];
			var lKey = feat.local;
			var aKey = apAbilities && feat.api ? apAbilities + feat.api : null;
			var wKey = feat.web ? `_meinsenec.${feat.web}` : null;

			var lVal = lKey ? this.toBool(this.getFirst(states, [lKey])) : null;
			var aVal = aKey ? this.toBool(this.getFirst(states, [aKey])) : null;
			var wVal = wKey ? this.toBool(this.getFirst(states, [wKey])) : null;

			// Skip if no connector has this feature info
			if (lVal === null && aVal === null && wVal === null) {
				continue;
			}
			hasAny = true;

			// Check for mismatch between connectors
			var vals = [];
			var sources = [];
			if (lVal !== null) {
				vals.push(lVal);
				sources.push("L");
			}
			if (aVal !== null) {
				vals.push(aVal);
				sources.push("A");
			}
			if (wVal !== null) {
				vals.push(wVal);
				sources.push("W");
			}

			var allSame = vals.every(function (v) {
				return v === vals[0];
			});

			if (allSame) {
				html += this.renderStatus(feat.label, vals[0], sources.join(""));
			} else {
				// Group sources by value — show agreeing connectors together
				var trueGroup = [];
				var falseGroup = [];
				for (var si = 0; si < vals.length; si++) {
					if (vals[si]) {
						trueGroup.push(sources[si]);
					} else {
						falseGroup.push(sources[si]);
					}
				}
				if (trueGroup.length > 0) {
					html += this.renderStatus(feat.label, true, `${trueGroup.join("")} !`);
				}
				if (falseGroup.length > 0) {
					html += this.renderStatus(feat.label, false, `${falseGroup.join("")} !`);
				}
			}
		}

		// SG-Ready mode (if active)
		var sgMode = this.getFirst(states, ["WIZARD.SG_READY_CURR_MODE"]);
		if (sgMode !== null) {
			html += this.renderMetric(t("feature_sg_mode"), String(sgMode), "#757575", "L");
		}

		// Peak shaving details
		var psMode = this.getFirst(states, ["_meinsenec.Status.peakShavingMode"]);
		var psLimit = this.getFirst(states, ["_meinsenec.Status.peakShavingCapacityLimitInPercent"]);
		if (psMode !== null && Number(psMode) > 0 && psLimit !== null) {
			html += this.renderMetric(t("feature_ps_limit"), `${Math.round(Number(psLimit))}%`, "#757575", "W");
		}

		if (!hasAny) {
			return "";
		}

		html += "</div></div>";
		return html;
	},

	/**
	 * Render a single metric item
	 *
	 * @param {string} label - Metric label
	 * @param {string|number} value - Metric value
	 * @param {string} color - Accent color
	 * @param {string} src - Source tag (L/A/W)
	 * @returns {string} HTML string
	 */
	renderMetric: function (label, value, color, src) {
		return (
			`<div class="system-metric">` +
			`<div class="system-metric-label">${label}${src ? this.srcBadge(src) : ""}</div>` +
			`<div class="system-metric-value" style="color:${color}">${value}</div>` +
			`</div>`
		);
	},

	/**
	 * Render a status indicator (active/inactive)
	 *
	 * @param {string} label - Feature label
	 * @param {boolean} active - Whether feature is active
	 * @param {string} src - Source tag (L/A/W)
	 * @returns {string} HTML string
	 */
	renderStatus: function (label, active, src) {
		var color = active ? "#4caf50" : "#90a4ae";
		var text = active ? t("feature_active") : t("feature_inactive");
		return (
			`<div class="system-metric">` +
			`<div class="system-metric-label">${label}${src ? this.srcBadge(src) : ""}</div>` +
			`<div class="system-metric-value"><span class="status-dot" style="background:${color}"></span>${
				text
			}</div>` +
			`</div>`
		);
	},

	/**
	 * Render TLS certificate status card with upload
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderTlsStatus: function (states) {
		var mode = states["_local.tls.mode"] || "none";
		var fingerprint = states["_local.tls.fingerprint"] || "";

		var modeLabels = {
			user: t("tls_mode_user"),
			cached: t("tls_mode_cached"),
			tofu: t("tls_mode_tofu"),
			none: t("tls_mode_none"),
		};
		var modeColors = {
			user: "#4caf50",
			cached: "#4caf50",
			tofu: "#ff9800",
			none: "#90a4ae",
		};
		var modeLabel = modeLabels[mode] || mode;
		var modeColor = modeColors[mode] || "#90a4ae";

		var html = `<div class="card"><h2>${t("tls_title")}</h2>`;
		html += '<div class="system-grid">';
		html += this.renderMetric(t("tls_mode"), modeLabel, modeColor, "");
		if (fingerprint && mode === "tofu") {
			html += this.renderMetric(t("tls_fingerprint"), `${fingerprint.substring(0, 16)}...`, "#757575", "");
		}
		html += "</div>";

		// Upload section
		html += `<div class="tls-upload-section" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">`;
		html += `<div style="margin-bottom:8px;font-weight:600">${t("tls_upload")}</div>`;
		html += `<div style="margin-bottom:8px;font-size:13px;opacity:0.8">${t("tls_upload_hint")}</div>`;
		html += `<div style="margin-bottom:12px;font-size:12px;opacity:0.6;font-style:italic">${t("tls_upload_why")}</div>`;
		html += `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">`;
		html += `<label class="tls-upload-btn" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:6px;cursor:pointer;background:var(--card-bg);border:1px solid var(--border);font-size:13px">`;
		html += `<input type="file" accept=".pem,.zip,.crt,.cer" id="tls-cert-file" style="display:none">`;
		html += `${t("tls_choose_file")}`;
		html += `</label>`;
		html += `<span id="tls-upload-status" style="font-size:13px"></span>`;
		html += `</div></div>`;

		html += "</div>";
		return html;
	},

	/**
	 * Render all system cards
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderAll: function (states) {
		return (
			this.renderBatteryHealth(states) +
			this.renderBatteryCycles(states) +
			this.renderBatteryTemps(states) +
			this.renderBatteryVoltages(states) +
			this.renderGridQuality(states) +
			this.renderPvStrings(states) +
			this.renderWallboxInfo(states) +
			this.renderFeatureStatus(states) +
			this.renderSystemDetails(states)
		);
	},
};
