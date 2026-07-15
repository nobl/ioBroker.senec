"use strict";

/* global app, t, document */
/* exported controls */

/**
 * Control panel for the SENEC web dashboard.
 * Reads control.* states and provides UI to modify them via socket.io setState.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var controls = {
	NAMESPACE: "senec.0",
	confirmReboot: false,

	/**
	 * Set an ioBroker state via socket.io
	 *
	 * @param {string} stateId - Short state ID (without namespace)
	 * @param {string|number|boolean} value - Value to set
	 */
	setState: function (stateId, value) {
		if (app.conn) {
			app.conn.emit("setState", `${this.NAMESPACE}.${stateId}`, { val: value, ack: false });
		}
	},

	/**
	 * Render the full control panel
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	render: function (states) {
		var html = "";
		html += this.renderForceCharge(states);
		html += this.renderReboot(states);
		html += this.renderEmergencyPower(states);
		html += this.renderPeakShaving(states);
		html += this.renderSGReady(states);
		html += this.renderSockets(states);
		html += this.renderWallbox(states);

		if (!html) {
			html = `<div class="card"><div class="stat-label">${t("control_no_controls")}</div></div>`;
		}
		return html;
	},

	renderForceCharge: function (states) {
		var val = states["control.ForceLoadBattery"];
		if (val === undefined) {
			return "";
		}

		var checked = val ? " checked" : "";
		return (
			`<div class="card"><h2>${t("control_force_charge")}</h2>` +
			`<div class="control-row">` +
			`<label class="control-toggle">` +
			`<input type="checkbox"${checked} onchange="controls.setState('control.ForceLoadBattery', this.checked)">` +
			`<span class="control-slider"></span>` +
			`</label>` +
			`<span class="control-label">${val ? t("feature_active") : t("feature_inactive")}</span>` +
			`</div></div>`
		);
	},

	renderReboot: function (states) {
		var val = states["control.RebootAppliance"];
		if (val === undefined) {
			return "";
		}

		var html = `<div class="card"><h2>${t("control_reboot")}</h2>`;
		if (this.confirmReboot) {
			html +=
				`<div class="control-row control-warning">` +
				`<span>${t("control_reboot_confirm")}</span>` +
				`<button class="control-btn control-btn-danger" onclick="controls.doReboot()">${t(
					"control_reboot_yes",
				)}</button>` +
				`<button class="control-btn" onclick="controls.cancelReboot()">${t("control_reboot_no")}</button>` +
				`</div>`;
		} else {
			html +=
				`<div class="control-row">` +
				`<button class="control-btn control-btn-danger" onclick="controls.confirmRebootAction()">${t(
					"control_reboot",
				)}</button>` +
				`</div>`;
		}
		html += "</div>";
		return html;
	},

	confirmRebootAction: function () {
		this.confirmReboot = true;
		app.renderDashboard();
	},

	cancelReboot: function () {
		this.confirmReboot = false;
		app.renderDashboard();
	},

	doReboot: function () {
		this.confirmReboot = false;
		this.setState("control.RebootAppliance", true);
		app.renderDashboard();
	},

	renderEmergencyPower: function (states) {
		var reserve = states["control.EmergencyPower.ReserveInPercent"];
		if (reserve === undefined) {
			return "";
		}

		return (
			`<div class="card"><h2>${t("control_emergency")}</h2>` +
			`<div class="control-row">` +
			`<label class="control-label">${t("control_reserve")}</label>` +
			`<input type="number" class="control-input" min="0" max="100" value="${Math.round(
				Number(reserve),
			)}" id="ctrl-emergency-reserve">` +
			`<span class="control-unit">%</span>` +
			`<button class="control-btn" onclick="controls.applyEmergency()">${t("control_apply")}</button>` +
			`</div></div>`
		);
	},

	applyEmergency: function () {
		var el = document.getElementById("ctrl-emergency-reserve");
		if (el) {
			this.setState("control.EmergencyPower.ReserveInPercent", Number(el.value));
		}
	},

	renderPeakShaving: function (states) {
		var mode = states["control.PeakShaving.Mode"];
		if (mode === undefined) {
			return "";
		}

		var limit = states["control.PeakShaving.CapacityLimit"] || 0;
		var endH = states["control.PeakShaving.EndHour"] || 0;
		var endM = states["control.PeakShaving.EndMinute"] || 0;

		var html = '<div class="card"><h2>Peak Shaving</h2>';
		html += '<div class="control-form">';

		html +=
			`<div class="control-row">` +
			`<label class="control-label">${t("control_mode")}</label>` +
			`<select class="control-input" id="ctrl-ps-mode">` +
			`<option value="DEACTIVATED"${mode === "DEACTIVATED" ? " selected" : ""}>${t(
				"feature_inactive",
			)}</option>` +
			`<option value="MANUAL"${mode === "MANUAL" ? " selected" : ""}>Manual</option>` +
			`<option value="AUTO"${mode === "AUTO" ? " selected" : ""}>Auto</option>` +
			`</select></div>`;

		// Only show details in MANUAL mode
		if (mode === "MANUAL") {
			html +=
				`<div class="control-row">` +
				`<label class="control-label">${t("feature_ps_limit")}</label>` +
				`<input type="number" class="control-input" min="0" max="90" value="${Math.round(
					Number(limit),
				)}" id="ctrl-ps-limit"><span class="control-unit">%</span></div>`;

			html +=
				`<div class="control-row">` +
				`<label class="control-label">${t("control_end_time")}</label>` +
				`<input type="number" class="control-input control-input-sm" min="0" max="23" value="${Math.round(
					Number(endH),
				)}" id="ctrl-ps-endh"> : ` +
				`<input type="number" class="control-input control-input-sm" min="0" max="59" value="${Math.round(
					Number(endM),
				)}" id="ctrl-ps-endm"></div>`;
		}

		html +=
			`<div class="control-row">` +
			`<button class="control-btn" onclick="controls.applyPeakShaving()">${t("control_apply")}</button></div>`;
		html += "</div></div>";
		return html;
	},

	applyPeakShaving: function () {
		var mode = document.getElementById("ctrl-ps-mode");
		var limit = document.getElementById("ctrl-ps-limit");
		var endH = document.getElementById("ctrl-ps-endh");
		var endM = document.getElementById("ctrl-ps-endm");
		if (mode) {
			this.setState("control.PeakShaving.Mode", mode.value);
		}
		if (limit) {
			this.setState("control.PeakShaving.CapacityLimit", Number(limit.value));
		}
		if (endH) {
			this.setState("control.PeakShaving.EndHour", Number(endH.value));
		}
		if (endM) {
			this.setState("control.PeakShaving.EndMinute", Number(endM.value));
		}
		this.setState("control.PeakShaving.Apply", true);
	},

	renderSGReady: function (states) {
		var enabled = states["control.SGReady.Enabled"];
		if (enabled === undefined) {
			return "";
		}

		var html = '<div class="card"><h2>SG-Ready</h2>';
		html += '<div class="control-form">';

		var checked = enabled ? " checked" : "";
		html +=
			`<div class="control-row">` +
			`<label class="control-toggle">` +
			`<input type="checkbox"${checked} id="ctrl-sg-enabled">` +
			`<span class="control-slider"></span></label>` +
			`<span class="control-label">${t("control_enabled")}</span></div>`;

		var numFields = [
			{ id: "ModeChangeDelayInMinutes", label: "Mode change delay", unit: "min" },
			{ id: "PowerOnProposalThresholdInWatt", label: "Power-on proposal", unit: "W" },
			{ id: "PowerOnCommandThresholdInWatt", label: "Power-on command", unit: "W" },
			{ id: "ShutdownLevelInWatt", label: "Shutdown level", unit: "W" },
		];

		for (var i = 0; i < numFields.length; i++) {
			var f = numFields[i];
			var v = states[`control.SGReady.${f.id}`];
			if (v === undefined) {
				continue;
			}
			html +=
				`<div class="control-row">` +
				`<label class="control-label">${f.label}</label>` +
				`<input type="number" class="control-input" value="${Math.round(Number(v))}" id="ctrl-sg-${f.id}">` +
				`<span class="control-unit">${f.unit}</span></div>`;
		}

		html +=
			`<div class="control-row">` +
			`<button class="control-btn" onclick="controls.applySGReady()">${t("control_apply")}</button></div>`;
		html += "</div></div>";
		return html;
	},

	applySGReady: function () {
		var en = document.getElementById("ctrl-sg-enabled");
		if (en) {
			this.setState("control.SGReady.Enabled", en.checked);
		}
		var fields = [
			"ModeChangeDelayInMinutes",
			"PowerOnProposalThresholdInWatt",
			"PowerOnCommandThresholdInWatt",
			"ShutdownLevelInWatt",
		];
		for (var i = 0; i < fields.length; i++) {
			var el = document.getElementById(`ctrl-sg-${fields[i]}`);
			if (el) {
				this.setState(`control.SGReady.${fields[i]}`, Number(el.value));
			}
		}
		this.setState("control.SGReady.Apply", true);
	},

	renderSockets: function (states) {
		var html = "";
		for (var idx = 0; idx < 4; idx++) {
			var modeKey = `control.Sockets.${idx}.Mode`;
			if (states[modeKey] === undefined) {
				continue;
			}

			if (!html) {
				html = `<div class="card"><h2>${t("control_sockets")}</h2>`;
			}

			var mode = states[modeKey] || "OFF";
			var name = states[`control.Sockets.${idx}.Name`] || `Socket ${idx}`;
			html += `<div class="control-section"><h3>${name}</h3>`;
			html += '<div class="control-form">';

			html +=
				`<div class="control-row">` +
				`<label class="control-label">${t("control_mode")}</label>` +
				`<select class="control-input" id="ctrl-sock-${idx}-mode">` +
				`<option value="OFF"${mode === "OFF" ? " selected" : ""}>Off</option>` +
				`<option value="PERMANENT_ON"${mode === "PERMANENT_ON" ? " selected" : ""}>On</option>` +
				`<option value="AUTOMATIC"${mode === "AUTOMATIC" ? " selected" : ""}>Auto</option>` +
				`</select></div>`;

			// Only show threshold settings in AUTO mode
			if (mode === "AUTOMATIC") {
				var sockFields = [
					{ id: "EinschaltschwelleInWatt", label: "Switch-on threshold", unit: "W" },
					{ id: "AbschaltschwelleInWatt", label: "Switch-off threshold", unit: "W" },
					{ id: "DauerLeistungsueberschussInMin", label: "Surplus duration", unit: "min" },
					{ id: "DauerSteckdoseAnInMin", label: "On duration", unit: "min" },
				];

				for (var si = 0; si < sockFields.length; si++) {
					var sf = sockFields[si];
					var sv = states[`control.Sockets.${idx}.${sf.id}`];
					if (sv === undefined) {
						continue;
					}
					html +=
						`<div class="control-row">` +
						`<label class="control-label">${sf.label}</label>` +
						`<input type="number" class="control-input" value="${Math.round(Number(sv))}" id="ctrl-sock-${
							idx
						}-${sf.id}">` +
						`<span class="control-unit">${sf.unit}</span></div>`;
				}
			}

			html +=
				`<div class="control-row">` +
				`<button class="control-btn" onclick="controls.applySocket(${idx})">${t(
					"control_apply",
				)}</button></div>`;
			html += "</div></div>";
		}
		if (html) {
			html += "</div>";
		}
		return html;
	},

	applySocket: function (idx) {
		var mode = document.getElementById(`ctrl-sock-${idx}-mode`);
		if (mode) {
			this.setState(`control.Sockets.${idx}.Mode`, mode.value);
		}
		var fields = [
			"EinschaltschwelleInWatt",
			"AbschaltschwelleInWatt",
			"DauerLeistungsueberschussInMin",
			"DauerSteckdoseAnInMin",
		];
		for (var i = 0; i < fields.length; i++) {
			var el = document.getElementById(`ctrl-sock-${idx}-${fields[i]}`);
			if (el) {
				this.setState(`control.Sockets.${idx}.${fields[i]}`, Number(el.value));
			}
		}
	},

	renderWallbox: function (states) {
		var html = "";
		for (var idx = 0; idx < 4; idx++) {
			var smartKey = `control.Wallbox.${idx}.SmartCharge`;
			var currentKey = `control.Wallbox.${idx}.ChargingCurrent`;
			if (states[smartKey] === undefined && states[currentKey] === undefined) {
				continue;
			}

			if (!html) {
				html = `<div class="card"><h2>${t("control_wallbox")}</h2>`;
			}

			html += `<div class="control-section"><h3>Wallbox ${idx}</h3>`;
			html += '<div class="control-form">';

			if (states[smartKey] !== undefined) {
				var smartChecked = states[smartKey] ? " checked" : "";
				html +=
					`<div class="control-row">` +
					`<label class="control-toggle">` +
					`<input type="checkbox"${smartChecked} id="ctrl-wb-${idx}-smart">` +
					`<span class="control-slider"></span></label>` +
					`<span class="control-label">Smart Charge</span></div>`;
			}

			if (states[currentKey] !== undefined) {
				html +=
					`<div class="control-row">` +
					`<label class="control-label">Charging Current</label>` +
					`<input type="number" class="control-input" min="0" max="32" value="${Number(
						states[currentKey],
					)}" id="ctrl-wb-${idx}-current">` +
					`<span class="control-unit">A</span></div>`;
			}

			var interchargeKey = `control.Wallbox.${idx}.Intercharge`;
			if (states[interchargeKey] !== undefined) {
				var icChecked = states[interchargeKey] ? " checked" : "";
				html +=
					`<div class="control-row">` +
					`<label class="control-toggle">` +
					`<input type="checkbox"${icChecked} id="ctrl-wb-${idx}-intercharge">` +
					`<span class="control-slider"></span></label>` +
					`<span class="control-label">Intercharge</span></div>`;
			}

			html +=
				`<div class="control-row">` +
				`<button class="control-btn" onclick="controls.applyWallbox(${idx})">${t(
					"control_apply",
				)}</button></div>`;
			html += "</div></div>";
		}
		if (html) {
			html += "</div>";
		}
		return html;
	},

	applyWallbox: function (idx) {
		var smart = document.getElementById(`ctrl-wb-${idx}-smart`);
		if (smart) {
			this.setState(`control.Wallbox.${idx}.SmartCharge`, smart.checked);
		}
		var current = document.getElementById(`ctrl-wb-${idx}-current`);
		if (current) {
			this.setState(`control.Wallbox.${idx}.ChargingCurrent`, Number(current.value));
		}
		var ic = document.getElementById(`ctrl-wb-${idx}-intercharge`);
		if (ic) {
			this.setState(`control.Wallbox.${idx}.Intercharge`, ic.checked);
		}
	},
};
