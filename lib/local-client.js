"use strict";
// Delegate module — functions receive `this` via .call(adapter, ...)
/* eslint-disable jsdoc/check-tag-names, jsdoc/reject-any-type */

const { allKnownObjects, deprecatedSections, reviverNumParse } = require("./constants.js");

/**
 * Send a control command to the local SENEC device via lala.cgi.
 * The response contains the current device state which evalPoll processes.
 * We also ack the control state itself so the user gets immediate feedback.
 *
 * @param {string} stateId - The control state id to ack on success
 * @param {string} payload - The JSON payload to send
 * @param {string} description - Human-readable description for error logging
 * @returns {Promise<void>}
 * @this {any}
 */
async function localSendControl(stateId, payload, description) {
	const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
	try {
		await this.evalPoll(
			JSON.parse(await this.localDoGet(url, payload, this.config.pollingTimeout, true), reviverNumParse),
			"",
			"",
		);
		await this.setState(stateId, { val: (await this.getStateAsync(stateId))?.val, ack: true });
	} catch (error) {
		this.logError(error, `Failed to control: ${description}`);
	}
}

/**
 * Handle a socket control state change.
 * For settings, the value is just stored without ack.
 * For Apply, all pending values are read and sent to the device.
 *
 * @param {string} stateId - The full state id
 * @param {number} socketIdx - Socket index (0-based)
 * @param {string} field - The control field name (e.g. "ForceOn", "LowerLimit", "Apply")
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 * @this {any}
 */
async function localHandleSocketControl(stateId, socketIdx, field, value) {
	if (this.socketCount === undefined || socketIdx >= this.socketCount) {
		this.log.warn(`Socket ${socketIdx} does not exist (device has ${this.socketCount ?? 0} sockets)`);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		this.log.debug(`Socket ${socketIdx}: pending ${field} = ${value}`);
		return;
	}

	// Apply: read unified controls and translate to local registers
	if (!value) {
		return;
	}

	const pfx = `control.Sockets.${socketIdx}`;
	this.log.info(`Applying socket ${socketIdx} changes via local...`);

	const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
	const onThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltschwelleInWatt`);
	const offThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.AbschaltschwelleInWatt`);
	const surplusDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
	const socketDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerSteckdoseAnInMin`);
	const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltHour`);
	const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltMinute`);

	const mode = String(modeState?.val || "OFF");
	const socketsPayload = {};
	const arr = () => Array.from({ length: this.socketCount }, () => "");
	const u8 = (val) => `u8_${val ? "01" : "00"}`;
	const u1 = (val) =>
		`u1_${Math.max(0, Number(val) || 0)
			.toString(16)
			.toUpperCase()
			.padStart(4, "0")}`;
	const u8n = (val) =>
		`u8_${Math.max(0, Number(val) || 0)
			.toString(16)
			.toUpperCase()
			.padStart(2, "0")}`;

	// Translate Mode → Enable/ForceOn/UseTime
	const enableArr = arr();
	const forceOnArr = arr();
	const useTimeArr = arr();
	enableArr[socketIdx] = u8(mode !== "OFF");
	forceOnArr[socketIdx] = u8(mode === "PERMANENT_ON");
	useTimeArr[socketIdx] = u8(mode === "AUTOMATIC" && (Number(hourState?.val) > 0 || Number(minuteState?.val) > 0));
	socketsPayload.ENABLE = enableArr;
	socketsPayload.FORCE_ON = forceOnArr;
	socketsPayload.USE_TIME = useTimeArr;

	// Translate thresholds and durations
	const upperArr = arr();
	upperArr[socketIdx] = u1(onThreshState?.val);
	socketsPayload.UPPER_LIMIT = upperArr;

	const lowerArr = arr();
	lowerArr[socketIdx] = u1(offThreshState?.val);
	socketsPayload.LOWER_LIMIT = lowerArr;

	const powerOnArr = arr();
	powerOnArr[socketIdx] = u1(surplusDurState?.val);
	socketsPayload.POWER_ON_TIME = powerOnArr;

	const timeLimitArr = arr();
	timeLimitArr[socketIdx] = u1(socketDurState?.val);
	socketsPayload.TIME_LIMIT = timeLimitArr;

	const switchHourArr = arr();
	switchHourArr[socketIdx] = u8n(hourState?.val);
	socketsPayload.SWITCH_ON_HOUR = switchHourArr;

	const switchMinArr = arr();
	switchMinArr[socketIdx] = u8n(minuteState?.val);
	socketsPayload.SWITCH_ON_MINUTE = switchMinArr;

	const payload = JSON.stringify({ SOCKETS: socketsPayload });
	this.log.debug(`Socket control payload: ${payload}`);
	await this.localSendControl(stateId, payload, `applying socket ${socketIdx} changes`);

	// Ack control states with the values we just sent
	await this.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
	await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
		val: Number(onThreshState?.val) || 0,
		ack: true,
	});
	await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
		val: Number(offThreshState?.val) || 0,
		ack: true,
	});
	await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
		val: Number(surplusDurState?.val) || 0,
		ack: true,
	});
	await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
		val: Number(socketDurState?.val) || 0,
		ack: true,
	});
	await this.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: Number(hourState?.val) || 0, ack: true });
	await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: Number(minuteState?.val) || 0, ack: true });
	await this.setState(`${pfx}.Apply`, { val: false, ack: true });
	this.log.info(`Socket ${socketIdx} changes applied via local`);
}

/**
 * Create control datapoints for switchable sockets.
 * Called once after the first local poll reveals NUMBER_OF_SOCKETS.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localCreateSocketControls() {
	if (this.socketControlsCreated || !this.socketCount || this.socketCount <= 0) {
		return;
	}
	if (!this.config.control_active || this.config.control_sockets_connector !== "local") {
		return;
	}

	for (let i = 0; i < this.socketCount; i++) {
		await this.createSocketControlsForIndex(i);
	}
	await this.subscribeStatesAsync("control.Sockets.*");
	this.socketControlsCreated = true;
	this.log.info(`Created control datapoints for ${this.socketCount} socket(s)`);
}

/**
 * Remove all control channels matching a pattern (e.g. "Sockets" or "Wallbox").
 *
 * @param {string} pattern - Substring to match in channel IDs (e.g. ".control.Sockets.")
 * @param {string} label - Human-readable label for log messages
 * @returns {Promise<void>}
 * @this {any}
 */
async function cleanupControlChannels(pattern, label) {
	const channels = await this.getChannelsOfAsync("control");
	if (!channels) {
		return;
	}
	for (const ch of channels) {
		if (ch._id && ch._id.includes(pattern)) {
			const states = await this.getStatesOfAsync(ch._id.replace(`${this.namespace}.`, ""));
			if (states) {
				for (const state of states) {
					await this.delObjectAsync(state._id);
				}
			}
			await this.delObjectAsync(ch._id);
			this.log.debug(`Cleaned up ${label} control channel: ${ch._id}`);
		}
	}
}

/**
 * Remove leftover socket control datapoints when sockets are unavailable or disabled.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localCleanupSocketControls() {
	await this.cleanupControlChannels(".control.Sockets.", "socket");
}

/**
 * Discover device capabilities and sync all control datapoints.
 * Called after each low-priority local poll.
 *
 * @param {object} obj - The full parsed poll response
 * @returns {Promise<void>}
 * @this {any}
 */
async function localDiscoverAndSyncControls(obj) {
	// Sockets
	if (obj.SOCKETS) {
		if (this.socketCount === undefined && typeof obj.SOCKETS.NUMBER_OF_SOCKETS === "number") {
			this.socketCount = obj.SOCKETS.NUMBER_OF_SOCKETS;
			this.log.debug(`Detected ${this.socketCount} socket(s)`);
			if (
				this.socketCount > 0 &&
				this.config.control_active &&
				this.config.control_sockets_connector === "local"
			) {
				await this.localCreateSocketControls();
			}
			if (this.socketCount === 0) {
				await this.localCleanupSocketControls();
			}
		}
		if (this.config.control_sockets_connector === "local") {
			await this.localSyncSocketControls(obj.SOCKETS);
		}
	}

	// Wallboxes
	if (obj.WIZARD && obj.WALLBOX) {
		if (this.wallboxCount === undefined && typeof obj.WIZARD.SETUP_NUMBER_WALLBOXES === "number") {
			this.wallboxCount = obj.WIZARD.SETUP_NUMBER_WALLBOXES;
			this.log.debug(`Detected ${this.wallboxCount} wallbox(es)`);
			if (
				this.wallboxCount > 0 &&
				this.config.control_active &&
				this.config.control_wallbox_connector === "local"
			) {
				await this.localCreateWallboxControls();
			}
			if (this.wallboxCount === 0) {
				await this.localCleanupWallboxControls();
			}
		}
		if (this.config.control_wallbox_connector === "local") {
			await this.localSyncWallboxControls(obj.WALLBOX);
		}
	}
}

/**
 * Sync socket control datapoints with values read from the device.
 *
 * @param {object} socketsData - The SOCKETS section from the poll response
 * @returns {Promise<void>}
 * @this {any}
 */
async function localSyncSocketControls(socketsData) {
	if (!this.socketControlsCreated || !socketsData) {
		return;
	}

	for (let i = 0; i < this.socketCount; i++) {
		const pfx = `control.Sockets.${i}`;
		const getArr = (key) =>
			Array.isArray(socketsData[key]) && socketsData[key][i] !== undefined ? socketsData[key][i] : undefined;

		// Translate Enable/ForceOn/UseTime → Mode
		const enable = getArr("ENABLE");
		const forceOn = getArr("FORCE_ON");
		if (enable !== undefined || forceOn !== undefined) {
			let mode = "OFF";
			if (forceOn) {
				mode = "PERMANENT_ON";
			} else if (enable) {
				mode = "AUTOMATIC";
			}
			await this.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
		}

		// Translate thresholds and durations
		const upper = getArr("UPPER_LIMIT");
		if (upper !== undefined) {
			await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, { val: upper, ack: true });
		}
		const lower = getArr("LOWER_LIMIT");
		if (lower !== undefined) {
			await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, { val: lower, ack: true });
		}
		const powerOnTime = getArr("POWER_ON_TIME");
		if (powerOnTime !== undefined) {
			await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
				val: powerOnTime,
				ack: true,
			});
		}
		const timeLimit = getArr("TIME_LIMIT");
		if (timeLimit !== undefined) {
			await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, { val: timeLimit, ack: true });
		}
		const switchHour = getArr("SWITCH_ON_HOUR");
		if (switchHour !== undefined) {
			await this.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: switchHour, ack: true });
		}
		const switchMin = getArr("SWITCH_ON_MINUTE");
		if (switchMin !== undefined) {
			await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: switchMin, ack: true });
		}
	}
}

/**
 * Handle a local wallbox control state change.
 * For settings, the value is just stored without ack.
 * For Apply, all pending values are read and sent to the device.
 *
 * @param {string} stateId - The full state id
 * @param {number} wbIdx - Wallbox index (0-based)
 * @param {string} field - The control field name
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 * @this {any}
 */
async function localHandleWallboxControl(stateId, wbIdx, field, value) {
	if (this.wallboxCount === undefined || wbIdx >= this.wallboxCount) {
		this.log.warn(`Wallbox ${wbIdx} does not exist (device has ${this.wallboxCount ?? 0} wallboxes)`);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		this.log.debug(`Wallbox ${wbIdx}: pending ${field} = ${value}`);
		return;
	}

	// Apply: read all pending values and send each to device
	if (!value) {
		return;
	}

	const fieldMap = {
		SetIcmax: { key: "SET_ICMAX", type: "fl", bool: false },
		SetIdefault: { key: "SET_IDEFAULT", type: "fl", bool: false },
		MinChargingCurrent: { key: "MIN_CHARGING_CURRENT", type: "fl", bool: false },
		SmartChargeActive: { key: "SMART_CHARGE_ACTIVE", type: "u8", bool: true, onValue: "03" },
		// Note: ALLOW_INTERCHARGE may be a single value (not array) on some devices.
		// The array payload should still work; sync handles non-array gracefully.
		AllowIntercharge: { key: "ALLOW_INTERCHARGE", type: "u8", bool: true },
	};

	const pfx = `control.Wallbox.${wbIdx}`;
	this.log.info(`Applying wallbox ${wbIdx} changes...`);

	// Build one combined payload with all changed fields
	const wallboxPayload = {};
	for (const [fieldName, mapping] of Object.entries(fieldMap)) {
		const state = await this.getStateAsync(`${pfx}.${fieldName}`);
		if (!state || state.ack) {
			continue; // Skip fields that haven't been changed (still acked)
		}
		const val = state.val;

		const arr = Array.from({ length: 4 }, () => "");
		if (mapping.bool) {
			const onVal = mapping.onValue || "01";
			arr[wbIdx] = `${mapping.type}_${val ? onVal : "00"}`;
		} else if (mapping.type === "fl") {
			const buf = Buffer.alloc(4);
			buf.writeFloatBE(parseFloat(String(val)), 0);
			arr[wbIdx] = `fl_${buf.toString("hex").toUpperCase()}`;
		} else {
			const numVal = typeof val === "number" ? val : parseInt(String(val), 10);
			if (isNaN(numVal) || numVal < 0) {
				this.log.warn(`Invalid value for wallbox control ${fieldName}: ${val}`);
				continue;
			}
			const padLen = mapping.type === "u1" ? 4 : 2;
			arr[wbIdx] = `${mapping.type}_${numVal.toString(16).toUpperCase().padStart(padLen, "0")}`;
		}
		wallboxPayload[mapping.key] = arr;
		this.log.info(`Wallbox ${wbIdx} ${fieldName} = ${val}`);
	}

	if (Object.keys(wallboxPayload).length > 0) {
		const payload = JSON.stringify({ WALLBOX: wallboxPayload });
		this.log.debug(`Wallbox control payload: ${payload}`);
		await this.localSendControl(stateId, payload, `applying wallbox ${wbIdx} changes`);
	} else {
		this.log.debug(`Wallbox ${wbIdx}: no pending changes to apply`);
	}

	await this.setState(`${pfx}.Apply`, { val: false, ack: true });
	this.log.info(`Wallbox ${wbIdx} changes applied`);
}

/**
 * Create control datapoints for wallboxes.
 * Called once after the first local poll reveals wallbox data.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localCreateWallboxControls() {
	if (this.wallboxControlsCreated || !this.wallboxCount || this.wallboxCount <= 0) {
		return;
	}
	if (!this.config.control_active || this.config.control_wallbox_connector !== "local") {
		return;
	}

	const numStates = [
		{ id: "SetIcmax", name: "Max charging current", unit: "A", role: "level" },
		{ id: "SetIdefault", name: "Default charging current", unit: "A", role: "level" },
		{ id: "MinChargingCurrent", name: "Min charging current", unit: "A", role: "level" },
	];
	const boolStates = [
		{ id: "SmartChargeActive", name: "Smart charge active", role: "switch" },
		{ id: "AllowIntercharge", name: "Allow intercharge", role: "switch" },
	];

	for (let i = 0; i < this.wallboxCount; i++) {
		const ch = `control.Wallbox.${i}`;
		await this.setObjectNotExistsAsync(ch, {
			type: "channel",
			common: { name: `Wallbox ${i}` },
			native: {},
		});

		for (const s of boolStates) {
			await this.setObjectNotExistsAsync(`${ch}.${s.id}`, {
				type: "state",
				common: {
					name: s.name,
					type: "boolean",
					role: s.role,
					read: true,
					write: true,
					def: false,
				},
				native: {},
			});
		}

		for (const s of numStates) {
			await this.setObjectNotExistsAsync(`${ch}.${s.id}`, {
				type: "state",
				common: {
					name: s.name,
					type: "number",
					role: s.role,
					unit: s.unit,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
		}
	}

	// Apply button per wallbox
	for (let i = 0; i < this.wallboxCount; i++) {
		await this.setObjectNotExistsAsync(`control.Wallbox.${i}.Apply`, {
			type: "state",
			common: {
				name: "Apply pending changes",
				type: "boolean",
				role: "button",
				read: true,
				write: true,
				def: false,
			},
			native: {},
		});
	}

	this.wallboxControlsCreated = true;
	this.log.info(`Created control datapoints for ${this.wallboxCount} wallbox(es)`);
}

/**
 * Sync wallbox control datapoints with values read from the device.
 *
 * @param {object} wallboxData - The WALLBOX section from the poll response
 * @returns {Promise<void>}
 * @this {any}
 */
async function localSyncWallboxControls(wallboxData) {
	if (!this.wallboxControlsCreated || !wallboxData) {
		return;
	}

	const syncMap = {
		SET_ICMAX: { field: "SetIcmax", bool: false },
		SET_IDEFAULT: { field: "SetIdefault", bool: false },
		MIN_CHARGING_CURRENT: { field: "MinChargingCurrent", bool: false },
		SMART_CHARGE_ACTIVE: { field: "SmartChargeActive", bool: true },
		ALLOW_INTERCHARGE: { field: "AllowIntercharge", bool: true },
	};

	for (let i = 0; i < this.wallboxCount; i++) {
		for (const [deviceKey, mapping] of Object.entries(syncMap)) {
			if (wallboxData[deviceKey] === undefined) {
				continue;
			}
			let rawVal;
			if (Array.isArray(wallboxData[deviceKey])) {
				rawVal = wallboxData[deviceKey][i];
			} else if (i === 0) {
				// Some fields (e.g. ALLOW_INTERCHARGE) may be a single value, not an array
				rawVal = wallboxData[deviceKey];
			}
			if (rawVal === undefined) {
				continue;
			}
			const val = mapping.bool ? !!rawVal : rawVal;
			await this.setStateChangedAsync(`control.Wallbox.${i}.${mapping.field}`, {
				val: val,
				ack: true,
			});
		}
	}
}

/**
 * Remove leftover wallbox control datapoints when no wallboxes are available.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localCleanupWallboxControls() {
	await this.cleanupControlChannels(".control.Wallbox.", "wallbox");
}

/**
 * Initialize local poll settings: build low-prio and high-prio request forms.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localInitPollSettings() {
	this.highPrioObjects.clear();
	// creating form for low priority pulling (which means pulling everything we know)
	// we can do this while preparing values for high prio
	this.lowPrioForm = "{";
	for (const value of allKnownObjects) {
		this.lowPrioForm += `"${value}":{},`;
		const objectsSet = new Set();
		switch (value) {
			case "BMS":
				[
					"CELL_TEMPERATURES_MODULE_A",
					"CELL_TEMPERATURES_MODULE_B",
					"CELL_TEMPERATURES_MODULE_C",
					"CELL_TEMPERATURES_MODULE_D",
					"CELL_VOLTAGES_MODULE_A",
					"CELL_VOLTAGES_MODULE_B",
					"CELL_VOLTAGES_MODULE_C",
					"CELL_VOLTAGES_MODULE_D",
					"CURRENT",
					"SOC",
					"SYSTEM_SOC",
					"TEMP_MAX",
					"TEMP_MIN",
					"VOLTAGE",
				].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_BMS_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_BMS);
				}
				break;
			case "ENERGY":
				[
					"STAT_STATE",
					"GUI_BAT_DATA_POWER",
					"GUI_INVERTER_POWER",
					"GUI_HOUSE_POW",
					"GUI_GRID_POW",
					"GUI_BAT_DATA_FUEL_CHARGE",
					"GUI_CHARGING_INFO",
					"GUI_BOOSTING_INFO",
					"GUI_BAT_DATA_POWER",
					"GUI_BAT_DATA_VOLTAGE",
					"GUI_BAT_DATA_CURRENT",
					"GUI_BAT_DATA_FUEL_CHARGE",
					"GUI_BAT_DATA_OA_CHARGING",
					"STAT_LIMITED_NET_SKEW",
					"SAFE_CHARGE_FORCE",
					"SAFE_CHARGE_PROHIBIT",
					"SAFE_CHARGE_RUNNING",
				].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_ENERGY_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_ENERGY);
				}
				break;
			case "PV1":
				["POWER_RATIO", "MPP_POWER"].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_PV1_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_PV1);
				}
				break;
			case "PWR_UNIT":
				["POWER_L1", "POWER_L2", "POWER_L3"].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_PWR_UNIT_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_PWR_UNIT);
				}
				break;
			case "PM1OBJ1":
				["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_PM1OBJ1_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ1);
				}
				break;
			case "PM1OBJ2":
				["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
				if (this.config.disclaimer && this.config.highPrio_PM1OBJ2_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_PM1OBJ2);
				}
				break;
			case "WALLBOX":
				if (this.config.disclaimer && this.config.highPrio_WALLBOX_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_WALLBOX);
				}
				break;
			case "BAT1":
				if (this.config.disclaimer && this.config.highPrio_BAT1_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_BAT1);
				}
				break;
			case "BAT1OBJ1":
				if (this.config.disclaimer && this.config.highPrio_BAT1OBJ1_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_BAT1OBJ1);
				}
				break;
			case "TEMPMEASURE":
				if (this.config.disclaimer && this.config.highPrio_TEMPMEASURE_active) {
					this.addUserDps(value, objectsSet, this.config.highPrio_TEMPMEASURE);
				}
				break;
			case "SYS_UPDATE":
				["USER_REBOOT_DEVICE"].forEach((item) => objectsSet.add(item));
				break;
			default:
				// nothing to do here
				break;
		}
		if (objectsSet.size > 0) {
			this.highPrioObjects.set(value, objectsSet);
		}
	}

	this.lowPrioForm = `${this.lowPrioForm.slice(0, -1)}}`;
	this.log.debug(`(localInitPollSettings) lowPrio: ${this.lowPrioForm}`);

	// creating form for high priority pulling
	if (this.highPrioObjects.size > 0) {
		this.highPrioForm = "{";
		this.highPrioObjects.forEach((mapValue, key) => {
			this.highPrioForm += `"${key}":{`;
			mapValue.forEach((setValue) => {
				this.highPrioForm += `"${setValue}":"",`;
			});
			this.highPrioForm = `${this.highPrioForm.slice(0, -1)}},`;
		});
		this.highPrioForm = `${this.highPrioForm.slice(0, -1)}}`;
	} else {
		this.highPrioForm = "{}";
	}
	this.log.debug(`(localInitPollSettings) highPrio: ${this.highPrioForm}`);
}

/**
 * Add user-configured datapoints to the high-priority poll set.
 *
 * @param {string} value - Section name (e.g. "BMS", "ENERGY")
 * @param {Set<string>} objectsSet - Set to add datapoint names into
 * @param {string} dpToAdd - Comma-separated datapoint names from config
 * @returns {void}
 * @this {any}
 */
function addUserDps(value, objectsSet, dpToAdd) {
	if (dpToAdd.trim().length < 1 || !/^[A-Z0-9_,]*$/.test(dpToAdd.toUpperCase().trim())) {
		// don't accept anything but entries like DP_1,DP2,dp3
		this.log.warn(
			`(addUserDps) Datapoints config for ${
				value
			} doesn't follow [A-Z0-9_,] (no blanks allowed!) - Ignoring: ${dpToAdd.toUpperCase().trim()}`,
		);
		return;
	}
	dpToAdd
		.toUpperCase()
		.trim()
		.split(",")
		.forEach((item) => objectsSet.add(item));
	this.log.debug(`(addUserDps) Datapoints config changed for ${value}: ${dpToAdd.toUpperCase().trim()}`);
}

/**
 * checks connection to senec service
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localCheckConnection() {
	const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
	const form = '{"ENERGY":{"STAT_STATE":""}}';
	try {
		this.log.info(`connecting to Senec (local): ${url}`);
		await this.localDoGet(url, form, this.config.pollingTimeout, true);
		this.log.info(`connected to Senec (local): ${url}`);
		this.lalaConnected = true;
	} catch (error) {
		throw new Error(
			`Error connecting to Senec (IP: ${this.connectVia}${this.config.senecip}). Exiting! (${
				error
			}). Check FQDN of SENEC appliance.`,
		);
	}
}

/**
 * Discover available sections from the device via lala.cgi.
 * Posts {"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}} and merges any
 * newly discovered section names into allKnownObjects.
 * Results are stored in the info.discoveredSections datapoint.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function localDiscoverSections() {
	const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
	const form = '{"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}}';

	try {
		this.log.info("Discovering available sections from device...");
		const raw = await this.localDoGet(url, form, this.config.pollingTimeout, true);
		if (!raw) {
			throw new Error("Empty response from section discovery");
		}

		const data = JSON.parse(raw);
		const discovered = new Set();

		// DEBUG.SECTIONS and PLAIN.SECTIONS contain arrays of section names prefixed with "st_"
		for (const group of ["DEBUG", "PLAIN"]) {
			if (data[group] && Array.isArray(data[group].SECTIONS)) {
				for (const entry of data[group].SECTIONS) {
					const name = typeof entry === "string" && entry.startsWith("st_") ? entry.substring(3) : entry;
					if (name && typeof name === "string") {
						discovered.add(name);
					}
				}
			}
		}

		// Find sections that are new (not in allKnownObjects, not deprecated)
		const newSections = [];
		for (const section of discovered) {
			if (!allKnownObjects.has(section) && !deprecatedSections.has(section)) {
				allKnownObjects.add(section);
				newSections.push(section);
			}
		}

		// Remove hardcoded sections that the device does not have
		for (const section of [...allKnownObjects]) {
			if (!discovered.has(section)) {
				allKnownObjects.delete(section);
			}
		}

		// Find hardcoded sections that the device does not have
		const unavailable = [];
		for (const section of [...allKnownObjects]) {
			if (!discovered.has(section)) {
				unavailable.push(section);
			}
		}

		if (newSections.length > 0) {
			this.log.info(`Discovered ${newSections.length} new section(s): ${newSections.join(", ")}`);
		}
		if (unavailable.length > 0) {
			this.log.info(
				`Found ${unavailable.length} stale section(s) in ioBroker not on device: ${unavailable.join(", ")}`,
			);
		}
		if (newSections.length === 0 && unavailable.length === 0) {
			this.log.info("Section discovery complete. Device matches existing sections.");
		}

		await this.doState(
			"info.discoveredSections",
			newSections.length > 0 ? JSON.stringify(newSections) : "none",
			"Sections discovered beyond hardcoded list",
			"",
			false,
			false,
		);
		await this.doState(
			"info.unavailableSections",
			unavailable.length > 0 ? JSON.stringify(unavailable) : "none",
			"Stale sections in ioBroker that the device no longer provides",
			"",
			false,
			false,
		);
	} catch (error) {
		this.log.warn(`Section discovery failed (device may restrict access): ${error.message}`);
		await this.doState(
			"info.discoveredSections",
			`error: ${error.message}`,
			"Sections discovered beyond hardcoded list",
			"",
			false,
			false,
		);
	}
}

/**
 * Perform GET or POST request
 *
 * @param {string} pUrl URL to call
 * @param {string} pForm Form to send
 * @param {number} pollingTimeout Timeout for call
 * @param {boolean} isPost true for POST, false for GET
 * @returns {Promise<string>} Promise with result
 * @this {any}
 */
async function localDoGet(pUrl, pForm, pollingTimeout, isPost) {
	if (!this.localClient) {
		throw new Error("Local client not initialized");
	}

	this.log.debug(`Calling: ${pUrl}`);

	try {
		const response = await this.localClient({
			method: isPost ? "post" : "get",
			url: pUrl,
			data: pForm,
			timeout: pollingTimeout,
		});

		const content = response.data;
		this.log.silly(`(Poll) received data (${response.status}): ${JSON.stringify(content)}`);

		return JSON.stringify(content);
	} catch (error) {
		if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
			this.log.debug("Request aborted (adapter shutdown)");
			return ""; // sauberer Rückgabewert bei Abbruch, damit wir nicht in der Fehlerbehandlung landen und ggf. neue Polls planen - bei Abbruch wollen wir ja eigentlich nur still stoppen
		}
		if (error.response) {
			this.log.warn(
				`(Poll) received error ${
					error.response.status
				} response from SENEC with content: ${JSON.stringify(error.response.data)}`,
			);
			throw new Error(`HTTP ${error.response.status}`);
		} else if (error.request) {
			this.log.info(error.message);
			throw new Error(error.message);
		} else {
			this.log.info(error.message);
			throw new Error(error?.message || "Unknown local request error");
		}
	}
}

/**
 * Read values from Senec Home V2.1
 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often.
 * Adverse effects: No sync with Senec possible if called too often.
 *
 * @param {boolean} isHighPrio high priority poll
 * @param {number} retry retry count
 * @returns {Promise<void>}
 * @this {any}
 */
async function localPoll(isHighPrio, retry) {
	const url = `${this.connectVia + this.config.senecip}/lala.cgi`;
	let interval = this.config.interval * 1000;
	if (!isHighPrio) {
		this.log.info("LowPrio polling (local) ...");
		interval = this.config.intervalLow * 1000 * 60;
	}

	try {
		let body = await this.localDoGet(
			url,
			isHighPrio ? this.highPrioForm : this.lowPrioForm,
			this.config.pollingTimeout,
			true,
		);
		if (body.includes('\\"')) {
			// in rare cases senec reports back extra escape sequences on some machines ...
			this.log.debug(`(Poll) Double escapes detected!  Body inc: ${body}`);
			body = body.replace(/\\"/g, '"');
			this.log.debug(`(Poll) Double escapes autofixed! Body out: ${body}`);
		}

		if (!body) {
			if (!this.unloaded) {
				this.setTimeout(() => {
					this.localPoll(isHighPrio, retry).catch((e) =>
						this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
					);
				}, interval);
			}
			return;
		}

		const obj = JSON.parse(body, reviverNumParse);
		this.log.silly(`(Poll) Parsed object: ${JSON.stringify(obj)}`);
		await this.evalPoll(obj, "", "");

		// Discover and sync control states
		// Runs on every poll — sections may be in high-prio if user configured them there
		await this.localDiscoverAndSyncControls(obj);

		retry = 0;
		if (!this.unloaded) {
			this.setTimeout(() => {
				this.localPoll(isHighPrio, retry).catch((e) =>
					this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
				);
			}, interval);
			this.log.debug(`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(interval / 1000).toFixed(0)}s`);
		}
	} catch (error) {
		if (retry == this.config.retries && this.config.retries < 999) {
			this.logError(
				error,
				`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retried ${
					retry
				} times. Giving up now. Check config and restart adapter. (${error})`,
			);
			await this.setState("info.connection", false, true);
		} else {
			retry += 1;
			const delay = interval * this.config.retrymultiplier * retry;
			this.log.warn(
				`Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${this.config.senecip}). Retry ${
					retry
				}/${this.config.retries} in ${delay / 1000} seconds! (${error})`,
			);
			if (!this.unloaded) {
				this.setTimeout(() => {
					this.localPoll(isHighPrio, retry).catch((e) =>
						this.logError(e, `❌ Local poll failed (highPrio=${isHighPrio})`),
					);
				}, delay);
				this.log.debug(`⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(delay / 1000).toFixed(0)}s`);
			}
		}
	}
}

module.exports = {
	localSendControl,
	localHandleSocketControl,
	localCreateSocketControls,
	cleanupControlChannels,
	localCleanupSocketControls,
	localDiscoverAndSyncControls,
	localSyncSocketControls,
	localHandleWallboxControl,
	localCreateWallboxControls,
	localSyncWallboxControls,
	localCleanupWallboxControls,
	localInitPollSettings,
	addUserDps,
	localCheckConnection,
	localDiscoverSections,
	localDoGet,
	localPoll,
};
