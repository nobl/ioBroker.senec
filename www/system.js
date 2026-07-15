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
		return ` <span class="src-badge" title="${labels[tag] || tag}" style="color:${colors[tag] || "#999"}">${tag}</span>`;
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
	 * Render battery health card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderBatteryHealth: function (states) {
		var ap = this.apiDetailsPfx();

		// System SOH (multiply 0.1 already applied by adapter)
		var sysSohKeys = ["BMS.SYSTEM_SOH", ap ? `${ap}batteryPack.remainingCapacityInPercent` : ""];
		var sysSoh = this.getFirst(states, sysSohKeys);
		var cyclesKeys = ["BMS.CYCLES"];
		var cycles = this.getFirst(states, cyclesKeys);
		var modKeys = ["BMS.MODULE_COUNT", ap ? `${ap}batteryPack.numberOfBatteryModules` : ""];
		var modules = this.getFirst(states, modKeys);

		// Overall min/max cell voltage (multiply 0.01 already applied → V)
		var minV = this.getFirst(states, ["BMS.MIN_CELL_VOLTAGE"]);
		var maxV = this.getFirst(states, ["BMS.MAX_CELL_VOLTAGE"]);

		// Overall min/max temp (multiply 0.1 already applied → °C)
		var minT = this.getFirst(states, ["BMS.MIN_TEMP"]);
		var maxT = this.getFirst(states, ["BMS.MAX_TEMP"]);

		// API temps as fallback
		var apiMinT = ap ? this.getFirst(states, [`${ap}batteryModules.minTemperature`]) : null;
		var apiMaxT = ap ? this.getFirst(states, [`${ap}batteryModules.maxTemperature`]) : null;

		if (sysSoh === null && cycles === null && minV === null && minT === null && apiMinT === null) {
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
		var moduleCount = modules ? Number(modules) : 4;
		for (var p = 0; p < moduleCount; p++) {
			var packSoh = this.getFirst(states, [`BMS.SOH.${p}`]);
			if (packSoh !== null) {
				var pVal = Number(packSoh);
				var pColor = pVal > 80 ? "#4caf50" : pVal > 60 ? "#ff9800" : "#f44336";
				html += this.renderMetric(`SOH Pack ${p + 1}`, `${Math.round(pVal)}%`, pColor, "L");
			}
		}

		if (cycles !== null) {
			html += this.renderMetric(
				t("battery_cycles"),
				Math.round(Number(cycles)),
				"#757575",
				this.sourceTag(states, cyclesKeys),
			);
		}
		if (modules !== null) {
			html += this.renderMetric(
				t("battery_modules"),
				Math.round(Number(modules)),
				"#757575",
				this.sourceTag(states, modKeys),
			);
		}

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

		// Per-module temps (BMS.TEMP_MAX.0, TEMP_MIN.0, ...)
		for (var mt = 0; mt < moduleCount; mt++) {
			var modMinT = this.getFirst(states, [`BMS.TEMP_MIN.${mt}`]);
			var modMaxT = this.getFirst(states, [`BMS.TEMP_MAX.${mt}`]);
			if (modMinT !== null && modMaxT !== null) {
				html += this.renderMetric(
					`${t("battery_temp")} M${mt + 1}`,
					`${Number(modMinT).toFixed(1)} - ${Number(modMaxT).toFixed(1)} °C`,
					"#757575",
					"L",
				);
			}
		}

		// Per-module cell voltages (BMS.CELL_VOLTAGES_MODULE_A.0, ...)
		var modLetters = ["A", "B", "C", "D"];
		for (var mv = 0; mv < Math.min(moduleCount, 4); mv++) {
			var cellVoltages = [];
			for (var cv = 0; cv < 20; cv++) {
				var cvVal = this.getFirst(states, [`BMS.CELL_VOLTAGES_MODULE_${modLetters[mv]}.${cv}`]);
				if (cvVal !== null && Number(cvVal) > 0) {
					cellVoltages.push(Number(cvVal));
				}
			}
			if (cellVoltages.length > 0) {
				var cvMin = Math.min.apply(null, cellVoltages);
				var cvMax = Math.max.apply(null, cellVoltages);
				var cvDelta = cvMax - cvMin;
				var cvColor = cvDelta < 50 ? "#4caf50" : cvDelta < 100 ? "#ff9800" : "#f44336";
				html += this.renderMetric(
					`${t("battery_cell_voltage")} M${mv + 1}`,
					`${cvMin} - ${cvMax} mV (\u0394${cvDelta.toFixed(0)})`,
					cvColor,
					"L",
				);
			}
		}

		html += "</div></div>";
		return html;
	},

	/**
	 * Render grid quality card
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderGridQuality: function (states) {
		var freq = this.getFirst(states, ["PM1OBJ1.FREQ"]);
		// Phase voltages/currents are arrays stored as .0, .1, .2
		var u0 = this.getFirst(states, ["PM1OBJ1.U_AC.0"]);
		var u1 = this.getFirst(states, ["PM1OBJ1.U_AC.1"]);
		var u2 = this.getFirst(states, ["PM1OBJ1.U_AC.2"]);
		var skew = this.getFirst(states, ["ENERGY.STAT_LIMITED_NET_SKEW"]);

		if (freq === null && u0 === null) {
			return "";
		}

		var html = `<div class="card"><h2>${t("grid_quality")}</h2>`;
		html += '<div class="system-grid">';

		if (freq !== null) {
			var freqVal = Number(freq).toFixed(2);
			var freqColor = Math.abs(Number(freq) - 50) < 0.1 ? "#4caf50" : "#ff9800";
			html += this.renderMetric(t("grid_frequency"), `${freqVal} Hz`, freqColor, "L");
		}

		if (u0 !== null) {
			var phases = [u0];
			if (u1 !== null) {
				phases.push(u1);
			}
			if (u2 !== null) {
				phases.push(u2);
			}
			for (var p = 0; p < phases.length; p++) {
				var vVal = Number(phases[p]).toFixed(1);
				var vColor = Math.abs(Number(phases[p]) - 230) < 15 ? "#4caf50" : "#ff9800";
				html += this.renderMetric(`L${p + 1}`, `${vVal} V`, vColor, "L");
			}
		}

		if (skew !== null && Number(skew) !== 0) {
			html += this.renderMetric(t("grid_skew"), t("grid_skew_active"), "#f44336", "L");
		}

		html += "</div></div>";
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

		var prodKeys = [ap ? `${ap}systemOverview.productName` : "", "_meinsenec.Status.produktName"];
		var product = this.getFirst(states, prodKeys);
		var fwKeys = ["WIZARD.FIRMWARE_VERSION", as ? `${as}firmwareVersion` : ""];
		var fw = this.getFirst(states, fwKeys);
		var guiKeys = [as ? `${as}guiVersion` : ""];
		var gui = this.getFirst(states, guiKeys);
		var ctKeys = ["TEMPMEASURE.CASE_TEMP", ap ? `${ap}casing.temperatureInCelsius` : ""];
		var casingTemp = this.getFirst(states, ctKeys);
		var mcuTemp = this.getFirst(states, ["TEMPMEASURE.MCU_TEMP"]);
		var batTemp = this.getFirst(states, ["TEMPMEASURE.BATTERY_TEMP"]);

		var invAmbKeys = ap ? [`${ap}batteryInverter.temperatures.amb`] : [];
		var invAmb = ap ? this.getFirst(states, invAmbKeys) : null;
		var invMaxKeys = ap ? [`${ap}batteryInverter.temperatures.max`] : [];
		var invMax = ap ? this.getFirst(states, invMaxKeys) : null;
		var invStateKeys = [ap ? `${ap}batteryInverter.state.name` : "", "PV1.INTERNAL_INV_STATE"];
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

		html += "</div></div>";
		return html;
	},

	/**
	 * Render SG-Ready and peak shaving status
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderFeatureStatus: function (states) {
		var sgKeys = ["WIZARD.SG_READY_ENABLED", "_meinsenec.Status.sgReadyVisible"];
		var sgEnabled = this.getFirst(states, sgKeys);
		var sgModeKeys = ["WIZARD.SG_READY_CURR_MODE"];
		var sgMode = this.getFirst(states, sgModeKeys);
		var psVisible = this.getFirst(states, ["_meinsenec.Status.peakShavingVisible"]);
		var psMode = this.getFirst(states, ["_meinsenec.Status.peakShavingMode"]);
		var psLimitKeys = ["_meinsenec.Status.peakShavingCapacityLimitInPercent"];
		var psLimit = this.getFirst(states, psLimitKeys);

		if (sgEnabled === null && psVisible === null) {
			return "";
		}

		var html = `<div class="card"><h2>${t("feature_status")}</h2>`;
		html += '<div class="system-grid">';

		if (sgEnabled !== null) {
			var sgActive = Number(sgEnabled) > 0 || sgEnabled === true;
			html += this.renderStatus("SG-Ready", sgActive, this.sourceTag(states, sgKeys));
			if (sgMode !== null && sgActive) {
				html += this.renderMetric(
					t("feature_sg_mode"),
					String(sgMode),
					"#757575",
					this.sourceTag(states, sgModeKeys),
				);
			}
		}

		if (psVisible !== null && (psVisible === true || Number(psVisible) > 0)) {
			var psActive = psMode !== null && Number(psMode) > 0;
			html += this.renderStatus("Peak Shaving", psActive, "W");
			if (psLimit !== null && psActive) {
				html += this.renderMetric(t("feature_ps_limit"), `${Math.round(Number(psLimit))}%`, "#757575", "W");
			}
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
	 * Render all system cards
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	renderAll: function (states) {
		return (
			this.renderBatteryHealth(states) +
			this.renderGridQuality(states) +
			this.renderFeatureStatus(states) +
			this.renderSystemDetails(states)
		);
	},
};
