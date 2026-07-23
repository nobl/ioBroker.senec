"use strict";
// Endpoint (Local):
//   https://{config.senecip}/lala.cgi (HTTPS POST, JSON request/response)

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const crypto = require("node:crypto");
const { allKnownObjects, deprecatedSections, reviverNumParse } = require("./constants.js");
const { computeBackoffDelay } = require("./auth-helpers.js");

/**
 * Send a control command to the local SENEC device via lala.cgi.
 * The response contains the current device state which evalPoll processes.
 * We also ack the control state itself so the user gets immediate feedback.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} stateId - The control state id to ack on success
 * @param {string} payload - The JSON payload to send
 * @param {string} description - Human-readable description for error logging
 * @returns {Promise<void>}
 */
async function localSendControl(adapter, stateId, payload, description) {
	const url = `${adapter.connectVia + adapter.config.senecip}/lala.cgi`;
	try {
		await adapter.evalPoll(
			JSON.parse(await localDoGet(adapter, url, payload, adapter.config.pollingTimeout, true), reviverNumParse),
			"",
			"",
		);
		await adapter.setState(stateId, { val: (await adapter.getStateAsync(stateId))?.val, ack: true });
	} catch (error) {
		adapter.logError(error, `[Local] ❌ Failed to control: ${description}`);
	}
}

/**
 * Handle a socket control state change.
 * For settings, the value is just stored without ack.
 * For Apply, all pending values are read and sent to the device.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} stateId - The full state id
 * @param {number} socketIdx - Socket index (0-based)
 * @param {string} field - The control field name (e.g. "ForceOn", "LowerLimit", "Apply")
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 */
async function localHandleSocketControl(adapter, stateId, socketIdx, field, value) {
	if (adapter.socketCount === undefined || socketIdx >= adapter.socketCount) {
		adapter.log.warn(
			`[Local] ⚠️ Socket ${socketIdx} does not exist (device has ${adapter.socketCount ?? 0} sockets)`,
		);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		adapter.log.debug(`[Local] Socket ${socketIdx}: pending ${field} = ${value}`);
		return;
	}

	// Apply: read unified controls and translate to local registers
	if (!value) {
		return;
	}

	const pfx = `control.Sockets.${socketIdx}`;
	adapter.log.info(`[Local] 🔄 Applying socket ${socketIdx} changes...`);

	const modeState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.Mode`);
	const onThreshState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltschwelleInWatt`);
	const offThreshState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.AbschaltschwelleInWatt`);
	const surplusDurState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
	const socketDurState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.DauerSteckdoseAnInMin`);
	const hourState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltHour`);
	const minuteState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltMinute`);

	const mode = String(modeState?.val || "OFF");
	const socketsPayload = {};
	const socketCount = adapter.socketCount;
	const arr = () => Array.from({ length: socketCount }, () => "");
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
	adapter.log.debug(`[Local] Socket control payload: ${payload}`);
	await localSendControl(adapter, stateId, payload, `applying socket ${socketIdx} changes`);

	// Ack control states with the values we just sent
	await adapter.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
	await adapter.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
		val: Number(onThreshState?.val) || 0,
		ack: true,
	});
	await adapter.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
		val: Number(offThreshState?.val) || 0,
		ack: true,
	});
	await adapter.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
		val: Number(surplusDurState?.val) || 0,
		ack: true,
	});
	await adapter.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
		val: Number(socketDurState?.val) || 0,
		ack: true,
	});
	await adapter.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: Number(hourState?.val) || 0, ack: true });
	await adapter.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: Number(minuteState?.val) || 0, ack: true });
	await adapter.setState(`${pfx}.Apply`, { val: false, ack: true });
	adapter.log.info(`[Local] ✅ Socket ${socketIdx} changes applied`);
}

/**
 * Create control datapoints for switchable sockets.
 * Called once after the first local poll reveals NUMBER_OF_SOCKETS.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localCreateSocketControls(adapter) {
	if (adapter.socketControlsCreated || !adapter.socketCount || adapter.socketCount <= 0) {
		return;
	}
	if (!adapter.config.control_active || adapter.config.control_sockets_connector !== "local") {
		return;
	}

	for (let i = 0; i < adapter.socketCount; i++) {
		await adapter.createSocketControlsForIndex(i);
	}
	await adapter.subscribeStatesAsync("control.Sockets.*");
	adapter.socketControlsCreated = true;
	adapter.log.info(`[Local] ✅ Created control datapoints for ${adapter.socketCount} socket(s)`);
}

/**
 * Remove all control channels matching a pattern (e.g. "Sockets" or "Wallbox").
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} pattern - Substring to match in channel IDs (e.g. ".control.Sockets.")
 * @param {string} label - Human-readable label for log messages
 * @returns {Promise<void>}
 */
async function cleanupControlChannels(adapter, pattern, label) {
	const channels = await adapter.getChannelsOfAsync("control");
	if (!channels) {
		return;
	}
	for (const ch of channels) {
		if (ch._id && ch._id.includes(pattern)) {
			const states = await adapter.getStatesOfAsync(ch._id.replace(`${adapter.namespace}.`, ""));
			if (states) {
				for (const state of states) {
					await adapter.delObjectAsync(state._id);
				}
			}
			await adapter.delObjectAsync(ch._id);
			adapter.log.debug(`[Local] Cleaned up ${label} control channel: ${ch._id}`);
		}
	}
}

/**
 * Remove leftover socket control datapoints when sockets are unavailable or disabled.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localCleanupSocketControls(adapter) {
	await cleanupControlChannels(adapter, ".control.Sockets.", "socket");
}

/**
 * Discover device capabilities and sync all control datapoints.
 * Called after each low-priority local poll.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} obj - The full parsed poll response
 * @returns {Promise<void>}
 */
async function localDiscoverAndSyncControls(adapter, obj) {
	// Sockets
	if (obj.SOCKETS) {
		if (adapter.socketCount === undefined && typeof obj.SOCKETS.NUMBER_OF_SOCKETS === "number") {
			const count = obj.SOCKETS.NUMBER_OF_SOCKETS;
			adapter.socketCount = count;
			adapter.log.debug(`[Local] Detected ${count} socket(s)`);
			if (count > 0 && adapter.config.control_active && adapter.config.control_sockets_connector === "local") {
				await localCreateSocketControls(adapter);
			}
			if (count === 0) {
				await localCleanupSocketControls(adapter);
			}
		}
		if (adapter.config.control_sockets_connector === "local") {
			await localSyncSocketControls(adapter, obj.SOCKETS);
		}
	}

	// Wallboxes
	if (obj.WIZARD && obj.WALLBOX) {
		if (adapter.wallboxCount === undefined && typeof obj.WIZARD.SETUP_NUMBER_WALLBOXES === "number") {
			const count = obj.WIZARD.SETUP_NUMBER_WALLBOXES;
			adapter.wallboxCount = count;
			adapter.log.debug(`[Local] Detected ${count} wallbox(es)`);
			if (count > 0 && adapter.config.control_active && adapter.config.control_wallbox_connector === "local") {
				await localCreateWallboxControls(adapter);
			}
			if (count === 0) {
				await localCleanupWallboxControls(adapter);
			}
		}
		if (adapter.config.control_wallbox_connector === "local") {
			await localSyncWallboxControls(adapter, obj.WALLBOX);
		}
	}
}

/**
 * Sync socket control datapoints with values read from the device.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} socketsData - The SOCKETS section from the poll response
 * @returns {Promise<void>}
 */
async function localSyncSocketControls(adapter, socketsData) {
	if (!adapter.socketControlsCreated || !socketsData || adapter.socketCount === undefined) {
		return;
	}

	for (let i = 0; i < adapter.socketCount; i++) {
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
			await adapter.setStateChangedAsync(`${pfx}.Mode`, { val: mode, ack: true });
		}

		// Translate thresholds and durations
		const upper = getArr("UPPER_LIMIT");
		if (upper !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, { val: upper, ack: true });
		}
		const lower = getArr("LOWER_LIMIT");
		if (lower !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, { val: lower, ack: true });
		}
		const powerOnTime = getArr("POWER_ON_TIME");
		if (powerOnTime !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
				val: powerOnTime,
				ack: true,
			});
		}
		const timeLimit = getArr("TIME_LIMIT");
		if (timeLimit !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, { val: timeLimit, ack: true });
		}
		const switchHour = getArr("SWITCH_ON_HOUR");
		if (switchHour !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.EinschaltHour`, { val: switchHour, ack: true });
		}
		const switchMin = getArr("SWITCH_ON_MINUTE");
		if (switchMin !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.EinschaltMinute`, { val: switchMin, ack: true });
		}
	}
}

/**
 * Handle a local wallbox control state change.
 * For settings, the value is just stored without ack.
 * For Apply, all pending values are read and sent to the device.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} stateId - The full state id
 * @param {number} wbIdx - Wallbox index (0-based)
 * @param {string} field - The control field name
 * @param {boolean | number | string} value - The value to set
 * @returns {Promise<void>}
 */
async function localHandleWallboxControl(adapter, stateId, wbIdx, field, value) {
	if (adapter.wallboxCount === undefined || wbIdx >= adapter.wallboxCount) {
		adapter.log.warn(
			`[Local] ⚠️ Wallbox ${wbIdx} does not exist (device has ${adapter.wallboxCount ?? 0} wallboxes)`,
		);
		return;
	}

	// Non-Apply fields: just store the pending value (no ack)
	if (field !== "Apply") {
		adapter.log.debug(`[Local] Wallbox ${wbIdx}: pending ${field} = ${value}`);
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
	adapter.log.info(`[Local] 🔄 Applying wallbox ${wbIdx} changes...`);

	// Build one combined payload with all changed fields
	const wallboxPayload = {};
	for (const [fieldName, mapping] of Object.entries(fieldMap)) {
		const state = await adapter.getStateAsync(`${pfx}.${fieldName}`);
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
				adapter.log.warn(`[Local] ⚠️ Invalid value for wallbox control ${fieldName}: ${val}`);
				continue;
			}
			const padLen = mapping.type === "u1" ? 4 : 2;
			arr[wbIdx] = `${mapping.type}_${numVal.toString(16).toUpperCase().padStart(padLen, "0")}`;
		}
		wallboxPayload[mapping.key] = arr;
		adapter.log.info(`[Local] Wallbox ${wbIdx} ${fieldName} = ${val}`);
	}

	if (Object.keys(wallboxPayload).length > 0) {
		const payload = JSON.stringify({ WALLBOX: wallboxPayload });
		adapter.log.debug(`[Local] Wallbox control payload: ${payload}`);
		await localSendControl(adapter, stateId, payload, `applying wallbox ${wbIdx} changes`);
	} else {
		adapter.log.debug(`[Local] Wallbox ${wbIdx}: no pending changes to apply`);
	}

	await adapter.setState(`${pfx}.Apply`, { val: false, ack: true });
	adapter.log.info(`[Local] ✅ Wallbox ${wbIdx} changes applied`);
}

/**
 * Create control datapoints for wallboxes.
 * Called once after the first local poll reveals wallbox data.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localCreateWallboxControls(adapter) {
	if (adapter.wallboxControlsCreated || !adapter.wallboxCount || adapter.wallboxCount <= 0) {
		return;
	}
	if (!adapter.config.control_active || adapter.config.control_wallbox_connector !== "local") {
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

	for (let i = 0; i < adapter.wallboxCount; i++) {
		const ch = `control.Wallbox.${i}`;
		await adapter.setObjectNotExistsAsync(ch, {
			type: "channel",
			common: { name: `Wallbox ${i}` },
			native: {},
		});

		for (const s of boolStates) {
			await adapter.setObjectNotExistsAsync(`${ch}.${s.id}`, {
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
			await adapter.setObjectNotExistsAsync(`${ch}.${s.id}`, {
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
	for (let i = 0; i < adapter.wallboxCount; i++) {
		await adapter.setObjectNotExistsAsync(`control.Wallbox.${i}.Apply`, {
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

	adapter.wallboxControlsCreated = true;
	adapter.log.info(`[Local] ✅ Created control datapoints for ${adapter.wallboxCount} wallbox(es)`);
}

/**
 * Sync wallbox control datapoints with values read from the device.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} wallboxData - The WALLBOX section from the poll response
 * @returns {Promise<void>}
 */
async function localSyncWallboxControls(adapter, wallboxData) {
	if (!adapter.wallboxControlsCreated || !wallboxData || adapter.wallboxCount === undefined) {
		return;
	}

	const syncMap = {
		SET_ICMAX: { field: "SetIcmax", bool: false },
		SET_IDEFAULT: { field: "SetIdefault", bool: false },
		MIN_CHARGING_CURRENT: { field: "MinChargingCurrent", bool: false },
		SMART_CHARGE_ACTIVE: { field: "SmartChargeActive", bool: true },
		ALLOW_INTERCHARGE: { field: "AllowIntercharge", bool: true },
	};

	for (let i = 0; i < adapter.wallboxCount; i++) {
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
			await adapter.setStateChangedAsync(`control.Wallbox.${i}.${mapping.field}`, {
				val: val,
				ack: true,
			});
		}
	}
}

/**
 * Remove leftover wallbox control datapoints when no wallboxes are available.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localCleanupWallboxControls(adapter) {
	await cleanupControlChannels(adapter, ".control.Wallbox.", "wallbox");
}

/**
 * Initialize local poll settings: build low-prio and high-prio request forms.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localInitPollSettings(adapter) {
	adapter.highPrioObjects.clear();
	// creating form for low priority pulling (which means pulling everything we know)
	// we can do this while preparing values for high prio
	adapter.lowPrioForm = "{";
	for (const value of allKnownObjects) {
		adapter.lowPrioForm += `"${value}":{},`;
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
				if (adapter.config.disclaimer && adapter.config.highPrio_BMS_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_BMS);
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
				if (adapter.config.disclaimer && adapter.config.highPrio_ENERGY_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_ENERGY);
				}
				break;
			case "PV1":
				["POWER_RATIO", "MPP_POWER"].forEach((item) => objectsSet.add(item));
				if (adapter.config.disclaimer && adapter.config.highPrio_PV1_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_PV1);
				}
				break;
			case "PWR_UNIT":
				["POWER_L1", "POWER_L2", "POWER_L3"].forEach((item) => objectsSet.add(item));
				if (adapter.config.disclaimer && adapter.config.highPrio_PWR_UNIT_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_PWR_UNIT);
				}
				break;
			case "PM1OBJ1":
				["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
				if (adapter.config.disclaimer && adapter.config.highPrio_PM1OBJ1_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_PM1OBJ1);
				}
				break;
			case "PM1OBJ2":
				["FREQ", "U_AC", "I_AC", "P_AC", "P_TOTAL"].forEach((item) => objectsSet.add(item));
				if (adapter.config.disclaimer && adapter.config.highPrio_PM1OBJ2_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_PM1OBJ2);
				}
				break;
			case "WALLBOX":
				if (adapter.config.disclaimer && adapter.config.highPrio_WALLBOX_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_WALLBOX);
				}
				break;
			case "BAT1":
				if (adapter.config.disclaimer && adapter.config.highPrio_BAT1_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_BAT1);
				}
				break;
			case "BAT1OBJ1":
				if (adapter.config.disclaimer && adapter.config.highPrio_BAT1OBJ1_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_BAT1OBJ1);
				}
				break;
			case "TEMPMEASURE":
				if (adapter.config.disclaimer && adapter.config.highPrio_TEMPMEASURE_active) {
					addUserDps(adapter, value, objectsSet, adapter.config.highPrio_TEMPMEASURE);
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
			adapter.highPrioObjects.set(value, objectsSet);
		}
	}

	adapter.lowPrioForm = `${adapter.lowPrioForm.slice(0, -1)}}`;
	adapter.log.debug(`[Local] (localInitPollSettings) lowPrio: ${adapter.lowPrioForm}`);

	// creating form for high priority pulling
	if (adapter.highPrioObjects.size > 0) {
		adapter.highPrioForm = "{";
		adapter.highPrioObjects.forEach((mapValue, key) => {
			adapter.highPrioForm += `"${key}":{`;
			mapValue.forEach((setValue) => {
				adapter.highPrioForm += `"${setValue}":"",`;
			});
			adapter.highPrioForm = `${adapter.highPrioForm.slice(0, -1)}},`;
		});
		adapter.highPrioForm = `${adapter.highPrioForm.slice(0, -1)}}`;
	} else {
		adapter.highPrioForm = "{}";
	}
	adapter.log.debug(`[Local] (localInitPollSettings) highPrio: ${adapter.highPrioForm}`);
}

/**
 * Add user-configured datapoints to the high-priority poll set.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} value - Section name (e.g. "BMS", "ENERGY")
 * @param {Set<string>} objectsSet - Set to add datapoint names into
 * @param {string} dpToAdd - Comma-separated datapoint names from config
 * @returns {void}
 */
function addUserDps(adapter, value, objectsSet, dpToAdd) {
	if (dpToAdd.trim().length < 1 || !/^[A-Z0-9_,]*$/.test(dpToAdd.toUpperCase().trim())) {
		// don't accept anything but entries like DP_1,DP2,dp3
		adapter.log.warn(
			`[Local] ⚠️ Datapoints config for ${
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
	adapter.log.debug(`[Local] (addUserDps) Datapoints config changed for ${value}: ${dpToAdd.toUpperCase().trim()}`);
}

/**
 * checks connection to senec service
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localCheckConnection(adapter) {
	const url = `${adapter.connectVia + adapter.config.senecip}/lala.cgi`;
	const form = '{"ENERGY":{"STAT_STATE":""}}';
	try {
		adapter.log.info(`[Local] 🔄 Connecting to Senec: ${url}`);
		await localDoGet(adapter, url, form, adapter.config.pollingTimeout, true);
		adapter.log.info(`[Local] ✅ Connected to Senec: ${url}`);
		adapter.lalaConnected = true;
		await adapter.setState("info.localConnected", true, true);
	} catch (error) {
		throw new Error(
			`Error connecting to Senec (IP: ${adapter.connectVia}${adapter.config.senecip}). (${
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
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function localDiscoverSections(adapter) {
	const url = `${adapter.connectVia + adapter.config.senecip}/lala.cgi`;
	const form = '{"DEBUG":{"SECTIONS":""},"PLAIN":{"SECTIONS":""}}';

	try {
		adapter.log.info("[Local] 🔄 Discovering available sections from device...");
		const raw = await localDoGet(adapter, url, form, adapter.config.pollingTimeout, true);
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
			adapter.log.info(`[Local] Discovered ${newSections.length} new section(s): ${newSections.join(", ")}`);
		}
		if (unavailable.length > 0) {
			adapter.log.info(
				`[Local] Found ${unavailable.length} stale section(s) in ioBroker not on device: ${unavailable.join(", ")}`,
			);
		}
		if (newSections.length === 0 && unavailable.length === 0) {
			adapter.log.info("[Local] ✅ Section discovery complete. Device matches existing sections.");
		}

		await adapter.doState(
			"info.discoveredSections",
			newSections.length > 0 ? JSON.stringify(newSections) : "none",
			"Sections discovered beyond hardcoded list",
			"",
			false,
			false,
		);
		await adapter.doState(
			"info.unavailableSections",
			unavailable.length > 0 ? JSON.stringify(unavailable) : "none",
			"Stale sections in ioBroker that the device no longer provides",
			"",
			false,
			false,
		);
	} catch (error) {
		adapter.log.warn(`[Local] ⚠️ Section discovery failed (device may restrict access): ${error.message}`);
		await adapter.doState(
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
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} pUrl URL to call
 * @param {string} pForm Form to send
 * @param {number} pollingTimeout Timeout for call
 * @param {boolean} isPost true for POST, false for GET
 * @returns {Promise<string>} Promise with result
 */
async function localDoGet(adapter, pUrl, pForm, pollingTimeout, isPost) {
	if (!adapter.localClient) {
		throw new Error("Local client not initialized");
	}

	if (adapter.config.local_reqnresp_log) {
		adapter.log.debug(`[Local] Calling: ${pUrl}`);
	}

	try {
		const response = await adapter.localClient({
			method: isPost ? "post" : "get",
			url: pUrl,
			data: pForm,
			timeout: pollingTimeout,
			httpsAgent: adapter.localAgent, // always use current agent (may change after TLS renegotiation)
		});

		// TOFU fingerprint validation after successful TLS handshake
		if (adapter._localTlsMode === "tofu" && response.request?.socket) {
			const peerCert = response.request.socket.getPeerCertificate();
			if (peerCert && peerCert.raw) {
				const fp = crypto.createHash("sha256").update(peerCert.raw).digest("hex");
				await adapter.verifyTofuFingerprint(fp);
			}
		}

		const content = response.data;
		if (adapter.config.local_reqnresp_log) {
			adapter.log.debug(
				`[Local] (Poll) received data (${response.status}): ${JSON.stringify(content).slice(0, 500)}`,
			);
		} else {
			adapter.log.silly(`[Local] (Poll) received data (${response.status}): ${JSON.stringify(content)}`);
		}

		return JSON.stringify(content);
	} catch (error) {
		if (error.code === "ERR_CANCELED" || error.name === "CanceledError") {
			adapter.log.debug("[Local] Request aborted (adapter shutdown)");
			return "";
		}
		// Certificate validation failed — re-negotiate TLS and retry once
		const certErrors = [
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			"CERT_UNTRUSTED",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"SELF_SIGNED_CERT_IN_CHAIN",
		];
		if (certErrors.includes(error.code)) {
			adapter.log.warn("[Local] ⚠️ TLS validation error during polling — re-negotiating...");
			await adapter.negotiateLocalTls();
			return localDoGet(adapter, pUrl, pForm, pollingTimeout, isPost);
		}
		if (error.response) {
			adapter.log.warn(
				`[Local] ⚠️ Received error ${
					error.response.status
				} response from SENEC with content: ${JSON.stringify(error.response.data)}`,
			);
			throw new Error(`HTTP ${error.response.status}`);
		} else if (error.request) {
			adapter.log.info(`[Local] ${error.message}`);
			throw new Error(error.message);
		} else {
			adapter.log.info(`[Local] ${error.message}`);
			throw new Error(error?.message || "Unknown local request error");
		}
	}
}

/**
 * Read values from Senec Home V2.1
 * Careful with the amount and interval of HighPrio values polled because this causes high demand on the SENEC machine so it shouldn't run too often.
 * Adverse effects: No sync with Senec possible if called too often.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {boolean} isHighPrio high priority poll
 * @param {number} retry retry count
 * @returns {Promise<void>}
 */
async function localPoll(adapter, isHighPrio, retry) {
	const url = `${adapter.connectVia + adapter.config.senecip}/lala.cgi`;
	const localLog = adapter.config.local_showPolling ? "info" : "debug";
	let interval = adapter.config.interval * 1000;
	if (!isHighPrio) {
		adapter.log[localLog]("[Local] 🔄 LowPrio polling...");
		interval = adapter.config.intervalLow * 1000 * 60;
	} else {
		adapter.log[localLog]("[Local] 🔄 HighPrio polling...");
	}

	try {
		let body = await localDoGet(
			adapter,
			url,
			isHighPrio ? adapter.highPrioForm : adapter.lowPrioForm,
			adapter.config.pollingTimeout,
			true,
		);
		if (body.includes('\\"')) {
			// in rare cases senec reports back extra escape sequences on some machines ...
			adapter.log.debug(`[Local] (Poll) Double escapes detected!  Body inc: ${body}`);
			body = body.replace(/\\"/g, '"');
			adapter.log.debug(`[Local] (Poll) Double escapes autofixed! Body out: ${body}`);
		}

		if (!body) {
			if (!adapter.unloaded) {
				adapter.setTimeout(() => {
					localPoll(adapter, isHighPrio, retry).catch((e) =>
						adapter.logError(e, `[Local] ❌ Local poll failed (highPrio=${isHighPrio})`),
					);
				}, interval);
			}
			return;
		}

		const obj = JSON.parse(body, reviverNumParse);
		adapter.log.silly(`[Local] (Poll) Parsed object: ${JSON.stringify(obj)}`);
		await adapter.evalPoll(obj, "", "");
		await adapter.updateLastPoll(
			isHighPrio ? "info.lastPoll.HighPrio" : "info.lastPoll.LowPrio",
			isHighPrio ? "Last successful high priority local poll" : "Last successful low priority local poll",
		);

		// Discover and sync control states
		// Runs on every poll — sections may be in high-prio if user configured them there
		await localDiscoverAndSyncControls(adapter, obj);

		retry = 0;
		if (!adapter.lalaConnected) {
			adapter.lalaConnected = true;
			await adapter.updateConnectionStatus();
			adapter.log.info("[Local] ✅ Connection restored.");
		}
		if (!adapter.unloaded) {
			adapter.setTimeout(() => {
				localPoll(adapter, isHighPrio, retry).catch((e) =>
					adapter.logError(e, `[Local] ❌ Local poll failed (highPrio=${isHighPrio})`),
				);
			}, interval);
			adapter.log[localLog](
				`[Local] ⏱ Next local poll (highPrio=${isHighPrio}) scheduled in ${(interval / 1000).toFixed(0)}s`,
			);
		}
	} catch (error) {
		retry += 1;
		// Exponential backoff with jitter, floor 10s, ceiling 5 min
		const delay = Math.min(300000, Math.max(10000, computeBackoffDelay(interval, retry, 30)));

		if (adapter.lalaConnected) {
			adapter.lalaConnected = false;
			await adapter.updateConnectionStatus();
		}

		adapter.log.warn(
			`[Local] ⚠️ Error reading from Senec ${isHighPrio ? "high" : "low"}Prio (${adapter.config.senecip}). Retry ${
				retry
			} in ${(delay / 1000).toFixed(0)}s. (${error})`,
		);
		if (!adapter.unloaded) {
			adapter.setTimeout(() => {
				localPoll(adapter, isHighPrio, retry).catch((e) =>
					adapter.logError(e, `[Local] ❌ Local poll failed (highPrio=${isHighPrio})`),
				);
			}, delay);
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
