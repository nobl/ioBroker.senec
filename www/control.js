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
	pendingStates: {},
	applyLockUntil: 0,

	/** Check if re-rendering should be skipped (apply cooldown active) */
	isLocked: function () {
		return Date.now() < this.applyLockUntil;
	},

	/**
	 * Set an ioBroker state via socket.io
	 *
	 * @param {string} stateId - Short state ID (without namespace)
	 * @param {string|number|boolean} value - Value to set
	 */
	setState: function (stateId, value) {
		if (app.conn) {
			app.conn.emit("setState", `${this.NAMESPACE}.${stateId}`, { val: value, ack: false });
			// Store pending value to prevent UI snap-back before ack
			this.pendingStates[stateId] = { val: value, ts: Date.now() };
		}
	},

	/**
	 * Show "sent" feedback on a button, disable for 3s
	 *
	 * @param {HTMLElement} btn - Button element for feedback
	 */
	showSent: function (btn) {
		if (!btn) {
			return;
		}
		this.applyLockUntil = Date.now() + 3500;
		var orig = btn.textContent;
		btn.textContent = `\u2713 ${t("control_sent")}`;
		btn.disabled = true;
		btn.classList.add("control-btn-sent");
		setTimeout(function () {
			btn.textContent = orig;
			btn.disabled = false;
			btn.classList.remove("control-btn-sent");
		}, 3000);
	},

	/**
	 * Get effective state value — use pending if recent, otherwise actual
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 */
	getVal: function (states, key) {
		var pending = this.pendingStates[key];
		if (pending && Date.now() - pending.ts < 5000) {
			return pending.val;
		}
		if (pending) {
			delete this.pendingStates[key];
		}
		return states[key];
	},

	/**
	 * Render the full control panel
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} HTML string
	 */
	/** Check connector availability */
	isLocalActive: function () {
		return !!app.connectors.local.active;
	},
	isApiActive: function () {
		return !!app.connectors.api.active;
	},
	isWebActive: function () {
		return !!app.connectors.web.active;
	},

	/**
	 * Render a disabled overlay when connector is missing
	 *
	 * @param {string} connector - Connector name (Local/API/Web)
	 */
	connectorWarning: function (connector) {
		return `<div class="control-row control-disabled">${t("control_no_connector", { connector: connector })}</div>`;
	},

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
		if (states["control.ForceLoadBattery"] === undefined) {
			return "";
		}
		var val = this.getVal(states, "control.ForceLoadBattery");
		var disabled = !this.isLocalActive();

		var checked = val ? " checked" : "";
		var dis = disabled ? " disabled" : "";
		var html = `<div class="card"><h2>${t("control_force_charge")}</h2>`;
		if (disabled) {
			html += this.connectorWarning("Local");
		}
		html +=
			`<div class="control-row">` +
			`<label class="control-toggle">` +
			`<input type="checkbox"${checked}${dis} onchange="controls.setState('control.ForceLoadBattery', this.checked)" aria-label="${t("control_force_charge")}">` +
			`<span class="control-slider"></span>` +
			`</label>` +
			`<span class="control-label">${val ? t("feature_active") : t("feature_inactive")}</span>` +
			`</div></div>`;
		return html;
	},

	renderReboot: function (states) {
		var val = states["control.RebootAppliance"];
		if (val === undefined) {
			return "";
		}
		if (!app.config.control_reboot) {
			return "";
		}
		var disabled = !this.isLocalActive();

		var html = `<div class="card"><h2>${t("control_reboot")}</h2>`;
		if (disabled) {
			html += this.connectorWarning("Local");
		}
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
				`<button class="control-btn control-btn-danger" onclick="controls.confirmRebootAction()"${disabled ? " disabled" : ""}>${t(
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
		var disabled = !this.isWebActive();

		var html = `<div class="card"><h2>${t("control_emergency")}</h2>`;
		if (disabled) {
			html += this.connectorWarning("Web");
		}
		var dis = disabled ? " disabled" : "";
		return (
			`${html}<div class="control-row">` +
			`<label class="control-label">${t("control_reserve")}</label>` +
			`<input type="number" class="control-input" min="0" max="100" value="${Math.round(
				Number(reserve),
			)}" id="ctrl-emergency-reserve"${dis}>` +
			`<span class="control-unit">%</span>` +
			`<button class="control-btn" onclick="controls.applyEmergency(this)"${dis}>${t("control_apply")}</button>` +
			`</div></div>`
		);
	},

	applyEmergency: function (btn) {
		var el = document.getElementById("ctrl-emergency-reserve");
		if (el) {
			this.setState("control.EmergencyPower.ReserveInPercent", Number(el.value));
			this.showSent(btn);
		}
	},

	renderPeakShaving: function (states) {
		var mode = states["control.PeakShaving.Mode"];
		if (mode === undefined) {
			return "";
		}
		var disabled = !this.isWebActive();

		var limit = states["control.PeakShaving.CapacityLimit"] || 0;
		var endH = states["control.PeakShaving.EndHour"] || 0;
		var endM = states["control.PeakShaving.EndMinute"] || 0;

		var html = '<div class="card"><h2>Peak Shaving</h2>';
		if (disabled) {
			html += this.connectorWarning("Web");
		}
		html += '<div class="control-form">';

		html +=
			`<div class="control-row">` +
			`<label class="control-label">${t("control_mode")}</label>` +
			`<select class="control-input" id="ctrl-ps-mode" onchange="controls.onPeakShavingModeChange(this.value)">` +
			`<option value="DEACTIVATED"${mode === "DEACTIVATED" ? " selected" : ""}>${t(
				"feature_inactive",
			)}</option>` +
			`<option value="MANUAL"${mode === "MANUAL" ? " selected" : ""}>Manual</option>` +
			`<option value="AUTO"${mode === "AUTO" ? " selected" : ""}>Auto</option>` +
			`</select></div>`;

		// Details — shown/hidden based on mode
		var showDetails = mode === "MANUAL" ? "" : ' style="display:none"';
		html += `<div id="ctrl-ps-details"${showDetails}>`;
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
		html += "</div>";

		html +=
			`<div class="control-row">` +
			`<button class="control-btn" onclick="controls.applyPeakShaving(this)">${t("control_apply")}</button></div>`;
		html += "</div></div>";
		return html;
	},

	onPeakShavingModeChange: function (mode) {
		var details = document.getElementById("ctrl-ps-details");
		if (details) {
			details.style.display = mode === "MANUAL" ? "" : "none";
		}
	},

	applyPeakShaving: function (btn) {
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
		this.showSent(btn);
	},

	renderSGReady: function (states) {
		var enabled = states["control.SGReady.Enabled"];
		if (enabled === undefined) {
			return "";
		}
		var disabled = !this.isWebActive();

		var html = '<div class="card"><h2>SG-Ready</h2>';
		if (disabled) {
			html += this.connectorWarning("Web");
		}
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
			`<button class="control-btn" onclick="controls.applySGReady(this)">${t("control_apply")}</button></div>`;
		html += "</div></div>";
		return html;
	},

	applySGReady: function (btn) {
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
		this.showSent(btn);
	},

	renderSockets: function (states) {
		var sockConn = app.config.control_sockets_connector || "off";
		if (sockConn === "off") {
			return "";
		}
		var sockActive = (sockConn === "local" && this.isLocalActive()) || (sockConn === "web" && this.isWebActive());

		var html = "";
		for (var idx = 0; idx < 4; idx++) {
			var modeKey = `control.Sockets.${idx}.Mode`;
			if (states[modeKey] === undefined) {
				continue;
			}

			if (!html) {
				html = `<div class="card"><h2>${t("control_sockets")}</h2>`;
				if (!sockActive) {
					html += this.connectorWarning(sockConn === "local" ? "Local" : "Web");
				}
			}

			var mode = states[modeKey] || "OFF";
			var name = states[`control.Sockets.${idx}.Name`] || `Socket ${idx}`;
			html += `<div class="control-section"><h3>${name}</h3>`;
			html += '<div class="control-form">';

			// Name input — only editable via web connector
			if (sockConn === "web") {
				html +=
					`<div class="control-row">` +
					`<label class="control-label">Name</label>` +
					`<input type="text" class="control-input" value="${name}" id="ctrl-sock-${idx}-name" style="width:200px">` +
					`</div>`;
			}

			html +=
				`<div class="control-row">` +
				`<label class="control-label">${t("control_mode")}</label>` +
				`<select class="control-input" id="ctrl-sock-${idx}-mode" onchange="controls.onSocketModeChange(${idx}, this.value)">` +
				`<option value="OFF"${mode === "OFF" ? " selected" : ""}>Off</option>` +
				`<option value="PERMANENT_ON"${mode === "PERMANENT_ON" ? " selected" : ""}>On</option>` +
				`<option value="AUTOMATIC"${mode === "AUTOMATIC" ? " selected" : ""}>Auto</option>` +
				`</select></div>`;

			// Threshold settings — shown/hidden based on mode
			var showSock = mode === "AUTOMATIC" ? "" : ' style="display:none"';
			html += `<div id="ctrl-sock-${idx}-details"${showSock}>`;
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
			html += "</div>";

			html +=
				`<div class="control-row">` +
				`<button class="control-btn" onclick="controls.applySocket(${idx}, this)">${t(
					"control_apply",
				)}</button></div>`;
			html += "</div></div>";
		}
		if (html) {
			html += "</div>";
		}
		return html;
	},

	onSocketModeChange: function (idx, mode) {
		var details = document.getElementById(`ctrl-sock-${idx}-details`);
		if (details) {
			details.style.display = mode === "AUTOMATIC" ? "" : "none";
		}
	},

	applySocket: function (idx, btn) {
		var nameEl = document.getElementById(`ctrl-sock-${idx}-name`);
		if (nameEl) {
			this.setState(`control.Sockets.${idx}.Name`, nameEl.value);
		}
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
		this.setState(`control.Sockets.${idx}.Apply`, true);
		this.showSent(btn);
	},

	renderWallbox: function (states) {
		var wbConn = app.config.control_wallbox_connector || "off";
		if (wbConn === "off") {
			return "";
		}
		var wbActive = (wbConn === "local" && this.isLocalActive()) || (wbConn === "api" && this.isApiActive());

		var html = "";
		for (var idx = 0; idx < 4; idx++) {
			var smartKey = `control.Wallbox.${idx}.SmartCharge`;
			var currentKey = `control.Wallbox.${idx}.ChargingCurrent`;
			if (states[smartKey] === undefined && states[currentKey] === undefined) {
				continue;
			}

			if (!html) {
				html = `<div class="card"><h2>${t("control_wallbox")}</h2>`;
				if (!wbActive) {
					html += this.connectorWarning(wbConn === "local" ? "Local" : "API");
				}
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
				`<button class="control-btn" onclick="controls.applyWallbox(${idx}, this)">${t(
					"control_apply",
				)}</button></div>`;
			html += "</div></div>";
		}
		if (html) {
			html += "</div>";
		}
		return html;
	},

	applyWallbox: function (idx, btn) {
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
		this.setState(`control.Wallbox.${idx}.Apply`, true);
		this.showSent(btn);
	},
};
