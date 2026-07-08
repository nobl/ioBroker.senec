"use strict";
/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const { CookieJar } = require("tough-cookie");
const { WEB_HOST } = require("./constants.js");

/**
 * Extract a human-readable error message from a mein-senec.de API response.
 *
 * @param {object} res - axios response object
 * @returns {string} error message
 */
function webApiErrorMsg(res) {
	return res.data?.message || res.data?.errorCode || JSON.stringify(res.data);
}

/**
 * Initialize mein-senec.de: authenticate, discover system, detect features, start polling.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webInit(adapter) {
	const WEB_BASE = WEB_HOST;

	// Step 1: Web login
	adapter.webAuthenticated = await adapter.webLogin();
	if (!adapter.webAuthenticated) {
		adapter.log.warn("mein-senec.de: Web login failed. Check credentials.");
		return;
	}

	// Step 2: Discover customer + system
	let systemCount = 1;
	try {
		const custRes = await webGet(adapter, `${WEB_BASE}/endkunde/api/context/getEndkunde`);
		if (custRes?.data && typeof custRes.data === "object") {
			await adapter.evalPoll(custRes.data, "_meinsenec.Customer.");
			systemCount = custRes.data.anzahlAnlagen || 1;
			adapter.log.info(`mein-senec.de: Customer devNumber=${custRes.data.devNumber}, systems=${systemCount}`);
		}
	} catch (error) {
		adapter.logError(error, "mein-senec.de: Failed to get customer info");
	}

	// Iterate systems to find our master and discover abilities
	for (let plantNum = 0; plantNum < systemCount; plantNum++) {
		try {
			const sysRes = await webGet(
				adapter,
				`${WEB_BASE}/endkunde/api/context/getAnlageBasedNavigationViewModel?anlageNummer=${plantNum}`,
			);
			if (!sysRes?.data || typeof sysRes.data !== "object") {
				break;
			}
			const sys = sysRes.data;
			if (!sys.master) {
				continue;
			}

			adapter.webMasterPlantNumber = plantNum;
			adapter.log.info(
				`mein-senec.de: Found system ${plantNum}: ${sys.produktName} (${sys.steuereinheitnummer})`,
			);

			// Store feature visibility flags
			adapter.webAbilities = {
				peakShaving: !!sys.peakShavingVisible,
				sockets: !!sys.steckdosenVisible,
				socketsEnabled: !!sys.steckdosenEnabled,
				sgReady: !!sys.sgReadyVisible,
				wallbox: !!sys.wallboxVisible,
				heatingRod: !!sys.heizstaebeVisible,
				autarky: !!sys.autarkieVisible,
				battery: !!sys.akkuVisible,
			};

			await adapter.evalPoll(sys, "_meinsenec.System.");
			for (const [key, val] of Object.entries(adapter.webAbilities)) {
				await adapter.doState(`_meinsenec.info.abilities.${key}`, val, `Feature: ${key}`, "", false);
			}

			adapter.log.info(`mein-senec.de: Abilities: ${JSON.stringify(adapter.webAbilities)}`);
			break;
		} catch (error) {
			adapter.logError(error, `mein-senec.de: Failed to get system ${plantNum}`);
			break;
		}
	}

	if (adapter.webMasterPlantNumber === null) {
		adapter.log.warn("mein-senec.de: No master system found.");
		return;
	}

	// Step 3: Create controls (if enabled) & start polling
	if (adapter.config.control_web_active) {
		await webCreateControls(adapter);
	}
	adapter.webConnected = true;
	webPoll(adapter).catch((e) => adapter.logError(e, "❌ mein-senec.de initial poll failed"));
}

/**
 * Shared mein-senec.de HTTP request with session-expiry re-auth.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {"get" | "post"} method - HTTP method
 * @param {string} url - URL to request
 * @param {object} [data] - Optional JSON body (POST only)
 * @returns {Promise<object>} axios response
 */
async function _webRequest(adapter, method, url, data) {
	if (!adapter.authClient) {
		throw new Error("authClient not initialized");
	}
	const client = adapter.authClient;
	const label = method.toUpperCase();
	adapter.log.debug(`mein-senec.de ${label}: ${url}`);

	const baseConfig = { jar: adapter.webJar || undefined, maxRedirects: 5 };
	const headers = method === "post" && data !== undefined ? { "Content-Type": "application/json" } : undefined;
	const config = { ...baseConfig, validateStatus: () => true, ...(headers ? { headers } : {}) };

	const res = method === "get" ? await client.get(url, config) : await client.post(url, data, config);

	if (adapter.config.api_reqnresp_log) {
		adapter.log.debug(`mein-senec.de ${label} response: HTTP ${res.status} → ${JSON.stringify(res.data)}`);
	} else {
		adapter.log.debug(`mein-senec.de ${label} response: HTTP ${res.status}`);
	}

	if (res.status === 200 && typeof res.data === "string" && res.data.includes("Login - SENEC")) {
		adapter.log.debug("mein-senec.de: Session expired, re-authenticating...");
		adapter.webAuthenticated = await adapter.webLogin();
		if (!adapter.webAuthenticated) {
			throw new Error("mein-senec.de re-authentication failed");
		}
		return method === "get" ? client.get(url, baseConfig) : client.post(url, data, baseConfig);
	}
	return res;
}

/**
 * GET request to mein-senec.de with auto re-auth on session expiry.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - URL to request
 * @returns {Promise<object>} axios response
 */
async function webGet(adapter, url) {
	return _webRequest(adapter, "get", url);
}

/**
 * POST request to mein-senec.de with auto re-auth on session expiry.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - URL to request
 * @param {object} [data] - Optional JSON body
 * @returns {Promise<object>} axios response
 */
async function webPost(adapter, url, data) {
	return _webRequest(adapter, "post", url, data);
}

/**
 * Poll mein-senec.de for status, spare capacity, peak shaving, SG-Ready.
 * Self-scheduling poll loop.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webPoll(adapter) {
	if (adapter.unloaded || !adapter.webConnected || adapter.webMasterPlantNumber === null) {
		return;
	}

	const WEB_BASE = WEB_HOST;
	const pn = adapter.webMasterPlantNumber;
	const now = Date.now();

	try {
		adapter.log.debug("🔄 Polling mein-senec.de...");

		// Status overview — every poll
		try {
			const res = await webGet(
				adapter,
				`${WEB_BASE}/endkunde/api/status/getstatusoverview.php?anlageNummer=${pn}`,
			);
			if (res?.data && typeof res.data === "object") {
				await adapter.evalPoll(res.data, "_meinsenec.Status.");
				await adapter.updateLastPoll("_meinsenec.info.lastPoll.Status", "Last status poll");
			}
		} catch (error) {
			adapter.logError(error, "mein-senec.de: Status poll failed");
		}

		// Emergency power reserve — every 6h
		if (
			!adapter._webLastEmergencyPowerPoll ||
			now - adapter._webLastEmergencyPowerPoll >= adapter.webMediumIntervalMs
		) {
			try {
				const res = await webGet(
					adapter,
					`${WEB_BASE}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`,
				);
				if (res?.data !== undefined) {
					const val = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
					if (!isNaN(val)) {
						await adapter.doState(
							"_meinsenec.EmergencyPower.ReserveInPercent",
							val,
							"Emergency power reserve",
							"%",
							false,
						);
						adapter._webLastEmergencyPowerPoll = now;
						await adapter.updateLastPoll(
							"_meinsenec.info.lastPoll.EmergencyPower",
							"Last emergency power poll",
						);
						// Sync control datapoint
						await adapter.setStateChangedAsync("control.EmergencyPower.ReserveInPercent", {
							val: val,
							ack: true,
						});
					}
				}
			} catch (error) {
				adapter.logError(error, "mein-senec.de: Emergency power poll failed");
			}
		}

		// Peak shaving — daily
		if (
			adapter.webAbilities.peakShaving &&
			(!adapter._webLastPeakShavingPoll || now - adapter._webLastPeakShavingPoll >= adapter.webSlowIntervalMs)
		) {
			try {
				const res = await webGet(
					adapter,
					`${WEB_HOST}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`,
				);
				if (res?.data && typeof res.data === "object") {
					await adapter.evalPoll(res.data, "_meinsenec.PeakShaving.");
					adapter._webLastPeakShavingPoll = now;
					await adapter.updateLastPoll("_meinsenec.info.lastPoll.PeakShaving", "Last peak shaving poll");
					await webSyncPeakShavingControls(adapter, res.data);
				}
			} catch (error) {
				adapter.logError(error, "mein-senec.de: Peak shaving poll failed");
			}
		}

		// SG-Ready state — every 6h
		if (
			adapter.webAbilities.sgReady &&
			(!adapter._webLastSgReadyStatePoll || now - adapter._webLastSgReadyStatePoll >= adapter.webMediumIntervalMs)
		) {
			try {
				const res = await webGet(adapter, `${WEB_BASE}/endkunde/api/senec/${pn}/sgready/state`);
				if (res?.data !== undefined) {
					await adapter.doState("_meinsenec.SGReady.State", String(res.data), "SG-Ready state", "", false);
					adapter._webLastSgReadyStatePoll = now;
				}
			} catch (error) {
				adapter.logError(error, "mein-senec.de: SG-Ready state poll failed");
			}
		}

		// SG-Ready config — daily
		if (
			adapter.webAbilities.sgReady &&
			(!adapter._webLastSgReadyConfPoll || now - adapter._webLastSgReadyConfPoll >= adapter.webSlowIntervalMs)
		) {
			try {
				const res = await webGet(adapter, `${WEB_BASE}/endkunde/api/senec/${pn}/sgready/config`);
				if (res?.data && typeof res.data === "object") {
					await adapter.evalPoll(res.data, "_meinsenec.SGReady.Config.");
					adapter._webLastSgReadyConfPoll = now;
					await adapter.updateLastPoll("_meinsenec.info.lastPoll.SGReadyConfig", "Last SG-Ready config poll");
					await webSyncSGReadyControls(adapter, res.data);
				}
			} catch (error) {
				adapter.logError(error, "mein-senec.de: SG-Ready config poll failed");
			}
		}
	} catch (error) {
		adapter.logError(error, "❌ mein-senec.de poll cycle failed");
	}

	// Sockets via mein-senec.de — every 6h
	if (
		(adapter.webAbilities.sockets || adapter.config.control_sockets_force) &&
		(!adapter._webLastSocketsPoll || now - adapter._webLastSocketsPoll >= adapter.webMediumIntervalMs)
	) {
		try {
			const res = await webGet(
				adapter,
				`${WEB_BASE}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`,
			);
			if (res?.data && Array.isArray(res.data)) {
				adapter.webSocketData = res.data;
				if (
					adapter.config.control_web_active &&
					adapter.config.control_sockets_connector === "web" &&
					res.data.length > 0
				) {
					await webCreateSocketControls(adapter, res.data.length);
				}
				for (const socket of res.data) {
					const idx = socket.steckdosenummer ?? socket.steckdosennummer;
					if (idx === undefined) {
						continue;
					}
					// Strip steuereinheit metadata before evalPoll (same for all sockets)
					const { steuereinheit: _s, state: socketState, ...socketFields } = socket;
					await adapter.evalPoll(socketFields, `_meinsenec.Sockets.${idx}.`);
					if (socketState && typeof socketState === "object") {
						const { steuereinheit: _ss, ...stateFields } = socketState;
						await adapter.evalPoll(stateFields, `_meinsenec.Sockets.${idx}.State.`);
					}
					if (adapter.config.control_sockets_connector === "web") {
						await webSyncSocketControls(adapter, idx, socket);
					}
				}
				adapter._webLastSocketsPoll = now;
				await adapter.updateLastPoll("_meinsenec.info.lastPoll.Sockets", "Last sockets poll");
			}
		} catch (error) {
			adapter.logError(error, "mein-senec.de: Sockets poll failed");
		}
	}

	if (!adapter.unloaded) {
		adapter.setTimeout(() => {
			webPoll(adapter).catch((e) => adapter.logError(e, "❌ mein-senec.de scheduled poll failed"));
		}, adapter.webStatusIntervalMs);
		adapter.log.debug(`⏱ Next mein-senec.de poll in ${(adapter.webStatusIntervalMs / 1000).toFixed(0)}s`);
	}
}

/**
 * Create control datapoints for mein-senec.de features based on discovered abilities.
 * Called once after webInit() discovers the system and its abilities.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webCreateControls(adapter) {
	// Emergency power reserve — always available
	await adapter.setObjectNotExistsAsync("control.EmergencyPower", {
		type: "channel",
		common: { name: "Emergency Power Reserve" },
		native: {},
	});
	await adapter.setObjectNotExistsAsync("control.EmergencyPower.ReserveInPercent", {
		type: "state",
		common: {
			name: "Reserve in percent",
			type: "number",
			role: "level",
			unit: "%",
			min: 0,
			max: 100,
			read: true,
			write: true,
			def: 0,
		},
		native: {},
	});

	// Peak shaving — only if available
	if (adapter.webAbilities.peakShaving) {
		await adapter.setObjectNotExistsAsync("control.PeakShaving", {
			type: "channel",
			common: { name: "Peak Shaving" },
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.PeakShaving.Mode", {
			type: "state",
			common: {
				name: "Peak shaving mode",
				type: "string",
				role: "text",
				read: true,
				write: true,
				def: "",
				states: { DEACTIVATED: "Deactivated", MANUAL: "Manual", AUTO: "Auto" },
			},
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.PeakShaving.CapacityLimit", {
			type: "state",
			common: {
				name: "Capacity limit",
				type: "number",
				role: "level",
				unit: "%",
				min: 0,
				max: 90,
				read: true,
				write: true,
				def: 0,
			},
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.PeakShaving.EndHour", {
			type: "state",
			common: {
				name: "End hour",
				type: "number",
				role: "level",
				min: 0,
				max: 23,
				read: true,
				write: true,
				def: 0,
			},
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.PeakShaving.EndMinute", {
			type: "state",
			common: {
				name: "End minute",
				type: "number",
				role: "level",
				min: 0,
				max: 59,
				read: true,
				write: true,
				def: 0,
			},
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.PeakShaving.Apply", {
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

	// SG-Ready — only if available
	if (adapter.webAbilities.sgReady) {
		await adapter.setObjectNotExistsAsync("control.SGReady", {
			type: "channel",
			common: { name: "SG-Ready" },
			native: {},
		});
		await adapter.setObjectNotExistsAsync("control.SGReady.Enabled", {
			type: "state",
			common: {
				name: "SG-Ready enabled",
				type: "boolean",
				role: "switch",
				read: true,
				write: true,
				def: false,
			},
			native: {},
		});
		const sgReadyNumStates = [
			{ id: "ModeChangeDelayInMinutes", name: "Mode change delay", unit: "min" },
			{ id: "PowerOnProposalThresholdInWatt", name: "Power-on proposal threshold", unit: "W" },
			{ id: "PowerOnCommandThresholdInWatt", name: "Power-on command threshold", unit: "W" },
			{ id: "ShutdownLevelInWatt", name: "Shutdown level", unit: "W" },
		];
		for (const s of sgReadyNumStates) {
			await adapter.setObjectNotExistsAsync(`control.SGReady.${s.id}`, {
				type: "state",
				common: {
					name: s.name,
					type: "number",
					role: "level",
					unit: s.unit,
					read: true,
					write: true,
					def: 0,
				},
				native: {},
			});
		}
		await adapter.setObjectNotExistsAsync("control.SGReady.Apply", {
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

	await adapter.subscribeStatesAsync("control.EmergencyPower.*");
	if (adapter.webAbilities.peakShaving) {
		await adapter.subscribeStatesAsync("control.PeakShaving.*");
	}
	if (adapter.webAbilities.sgReady) {
		await adapter.subscribeStatesAsync("control.SGReady.*");
	}
	adapter.log.info(
		`mein-senec.de: Created web controls (peakShaving=${adapter.webAbilities.peakShaving}, sgReady=${adapter.webAbilities.sgReady})`,
	);
}

/**
 * Create web socket control datapoints after first socket poll.
 * Called when sockets are discovered and connector is set to "web".
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} count - Number of sockets
 * @returns {Promise<void>}
 */
async function webCreateSocketControls(adapter, count) {
	if (adapter.webSocketControlsCreated) {
		return;
	}
	for (let i = 0; i < count; i++) {
		await adapter.createSocketControlsForIndex(i);
	}
	await adapter.subscribeStatesAsync("control.Sockets.*");
	adapter.webSocketControlsCreated = true;
	adapter.log.info(`mein-senec.de: Created web socket controls for ${count} socket(s)`);
}

/**
 * Handle a mein-senec.de control command.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} subId - The control ID (e.g. "EmergencyPower.ReserveInPercent")
 * @param {object} state - The ioBroker state object
 * @returns {Promise<void>}
 */
async function webHandleControl(adapter, subId, state) {
	const pn = adapter.webMasterPlantNumber;
	if (pn === null || pn === undefined) {
		adapter.log.warn("mein-senec.de: No master plant number, cannot send control command");
		return;
	}

	// Emergency power — direct send (single field, no Apply needed)
	if (subId === "EmergencyPower.ReserveInPercent") {
		const val = Math.round(Math.max(0, Math.min(100, Number(state.val) || 0)));
		adapter.log.info(`mein-senec.de: Setting emergency power reserve to ${val}%`);
		try {
			const postRes = await webPost(
				adapter,
				`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower?reserve-in-percent=${val}`,
			);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				adapter.log.error(`mein-senec.de: Emergency power save failed (HTTP ${postRes.status}): ${errMsg}`);
				return;
			}
			// Re-read and sync back
			const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`);
			if (res?.data !== undefined) {
				const confirmed = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
				if (!isNaN(confirmed)) {
					await adapter.doState(
						"_meinsenec.EmergencyPower.ReserveInPercent",
						confirmed,
						"Emergency power reserve",
						"%",
						false,
					);
					await adapter.setStateAsync("control.EmergencyPower.ReserveInPercent", {
						val: confirmed,
						ack: true,
					});
				}
			}
			adapter.log.info(`mein-senec.de: Emergency power reserve set to ${val}%`);
		} catch (error) {
			adapter.logError(error, "mein-senec.de: Failed to set emergency power reserve");
		}
		return;
	}

	// Peak shaving — Apply button
	if (subId === "PeakShaving.Apply" && state.val) {
		await webHandlePeakShavingApply(adapter);
		return;
	}
	// Peak shaving field changes — just ack locally, wait for Apply
	if (subId.startsWith("PeakShaving.")) {
		return;
	}

	// SG-Ready — Apply button
	if (subId === "SGReady.Apply" && state.val) {
		await webHandleSGReadyApply(adapter);
		return;
	}
	// SG-Ready field changes — just ack locally, wait for Apply
	if (subId.startsWith("SGReady.")) {
		return;
	}

	adapter.log.warn(`mein-senec.de: Unknown web control: ${subId}`);
}

/**
 * Apply pending peak shaving changes to mein-senec.de.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webHandlePeakShavingApply(adapter) {
	const pn = adapter.webMasterPlantNumber;
	const pfx = "control.PeakShaving";

	const modeState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.Mode`);
	const capState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.CapacityLimit`);
	const hourState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EndHour`);
	const minuteState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EndMinute`);

	const mode = String(modeState?.val || "").toUpperCase();
	const capacityLimit = Math.max(0, Math.min(90, Number(capState?.val) || 0));
	const endHour = Math.max(0, Math.min(23, Number(hourState?.val) || 0));
	const endMinute = Math.max(0, Math.min(59, Number(minuteState?.val) || 0));

	if (!mode) {
		adapter.log.warn("mein-senec.de: Peak shaving mode is empty, not applying");
		await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
		return;
	}

	// Construct UTC ms timestamp — API extracts hour/minute from UTC
	const now = new Date();
	const endzeitMs = String(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), endHour, endMinute, 0, 0),
	);

	const params = new URLSearchParams({
		anlageNummer: String(pn),
		mode: mode,
		capacityLimit: String(capacityLimit),
		endzeit: endzeitMs,
	});

	adapter.log.info(
		`mein-senec.de: Applying peak shaving settings (mode=${mode}, cap=${capacityLimit}%, end=${endHour}:${String(endMinute).padStart(2, "0")})`,
	);
	try {
		const postRes = await webPost(
			adapter,
			`${WEB_HOST}/endkunde/api/peakshaving/saveSettings?${params.toString()}`,
		);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`mein-senec.de: Peak shaving save failed (HTTP ${postRes.status}): ${errMsg}`);
			await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`);
		if (res?.data && typeof res.data === "object") {
			await adapter.evalPoll(res.data, "_meinsenec.PeakShaving.");
			await webSyncPeakShavingControls(adapter, res.data);
		}
		adapter.log.info("mein-senec.de: Peak shaving settings applied");
	} catch (error) {
		adapter.logError(error, "mein-senec.de: Failed to apply peak shaving settings");
	}
	await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Sync peak shaving control datapoints with values read from the portal.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} data - Peak shaving settings from the API
 * @returns {Promise<void>}
 */
async function webSyncPeakShavingControls(adapter, data) {
	const pfx = "control.PeakShaving";
	if (data.peakShavingMode !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.peakShavingMode), ack: true });
	}
	if (data.peakShavingCapacityLimitInPercent !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.CapacityLimit`, {
			val: Number(data.peakShavingCapacityLimitInPercent),
			ack: true,
		});
	}
	if (Array.isArray(data.peakShavingLocalEndTime) && data.peakShavingLocalEndTime.length >= 2) {
		await adapter.setStateChangedAsync(`${pfx}.EndHour`, {
			val: Number(data.peakShavingLocalEndTime[0]) || 0,
			ack: true,
		});
		await adapter.setStateChangedAsync(`${pfx}.EndMinute`, {
			val: Number(data.peakShavingLocalEndTime[1]) || 0,
			ack: true,
		});
	}
}

/**
 * Apply pending SG-Ready changes to mein-senec.de.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webHandleSGReadyApply(adapter) {
	const pn = adapter.webMasterPlantNumber;
	const pfx = "control.SGReady";

	// Build JSON body with only changed (unacked) fields
	const fieldMap = {
		Enabled: "enabled",
		ModeChangeDelayInMinutes: "modeChangeDelayInMinutes",
		PowerOnProposalThresholdInWatt: "powerOnProposalThresholdInWatt",
		PowerOnCommandThresholdInWatt: "powerOnCommandThresholdInWatt",
		ShutdownLevelInWatt: "shutdownLevelInWatt",
	};

	const body = {};
	for (const [stateKey, apiKey] of Object.entries(fieldMap)) {
		const s = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.${stateKey}`);
		if (!s || s.ack) {
			continue; // Skip unchanged fields
		}
		body[apiKey] = s.val;
	}

	if (Object.keys(body).length === 0) {
		adapter.log.debug("mein-senec.de: SG-Ready — no pending changes to apply");
		await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
		return;
	}

	adapter.log.info(`mein-senec.de: Applying SG-Ready settings: ${JSON.stringify(body)}`);
	try {
		const postRes = await webPost(adapter, `${WEB_HOST}/endkunde/api/senec/${pn}/sgready`, body);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`mein-senec.de: SG-Ready save failed (HTTP ${postRes.status}): ${errMsg}`);
			await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/senec/${pn}/sgready/config`);
		if (res?.data && typeof res.data === "object") {
			await adapter.evalPoll(res.data, "_meinsenec.SGReady.Config.");
			await webSyncSGReadyControls(adapter, res.data);
		}
		adapter.log.info("mein-senec.de: SG-Ready settings applied");
	} catch (error) {
		adapter.logError(error, "mein-senec.de: Failed to apply SG-Ready settings");
	}
	await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Sync SG-Ready control datapoints with values read from the portal.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {object} data - SG-Ready config from the API
 * @returns {Promise<void>}
 */
async function webSyncSGReadyControls(adapter, data) {
	const pfx = "control.SGReady";
	const syncMap = {
		enabled: { field: "Enabled" },
		modeChangeDelayInMinutes: { field: "ModeChangeDelayInMinutes" },
		powerOnProposalThresholdInWatt: { field: "PowerOnProposalThresholdInWatt" },
		powerOnCommandThresholdInWatt: { field: "PowerOnCommandThresholdInWatt" },
		shutdownLevelInWatt: { field: "ShutdownLevelInWatt" },
	};
	for (const [apiKey, mapping] of Object.entries(syncMap)) {
		if (data[apiKey] !== undefined) {
			await adapter.setStateChangedAsync(`${pfx}.${mapping.field}`, { val: data[apiKey], ack: true });
		}
	}
}

/**
 * Sync web socket control datapoints with values read from the portal.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} idx - Socket index
 * @param {object} data - Socket data from the API
 * @returns {Promise<void>}
 */
async function webSyncSocketControls(adapter, idx, data) {
	if (!adapter.webSocketControlsCreated) {
		return;
	}
	const pfx = `control.Sockets.${idx}`;
	if (data.name !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.Name`, { val: String(data.name), ack: true });
	}
	if (data.mode !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.mode), ack: true });
	}
	if (data.einschaltschwelleInWatt !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
			val: Number(data.einschaltschwelleInWatt),
			ack: true,
		});
	}
	if (data.abschaltschwelleInWatt !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
			val: Number(data.abschaltschwelleInWatt),
			ack: true,
		});
	}
	if (data.dauerLeistungsueberschussInMin !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
			val: Number(data.dauerLeistungsueberschussInMin),
			ack: true,
		});
	}
	if (data.dauerSteckdoseAnInMin !== undefined) {
		await adapter.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
			val: Number(data.dauerSteckdoseAnInMin),
			ack: true,
		});
	}
	if (Array.isArray(data.einschaltzeit) && data.einschaltzeit.length >= 2) {
		await adapter.setStateChangedAsync(`${pfx}.EinschaltHour`, {
			val: Number(data.einschaltzeit[0]) || 0,
			ack: true,
		});
		await adapter.setStateChangedAsync(`${pfx}.EinschaltMinute`, {
			val: Number(data.einschaltzeit[1]) || 0,
			ack: true,
		});
	}
}

/**
 * Handle a web socket control command (Apply button).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} idx - Socket index
 * @param {string} field - Field name (e.g. "Apply", "Mode")
 * @param {object} state - ioBroker state object
 * @returns {Promise<void>}
 */
async function webHandleSocketControl(adapter, idx, field, state) {
	// Only act on Apply button
	if (field !== "Apply" || !state.val) {
		return;
	}

	if (!adapter.webSocketData || !Array.isArray(adapter.webSocketData)) {
		adapter.log.warn("mein-senec.de: No socket data available, cannot apply changes");
		await adapter.setStateAsync(`control.Sockets.${idx}.Apply`, { val: false, ack: true });
		return;
	}

	const pn = adapter.webMasterPlantNumber;
	const pfx = `control.Sockets.${idx}`;

	// Read current control values
	const nameState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.Name`);
	const modeState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.Mode`);
	const onThreshState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltschwelleInWatt`);
	const offThreshState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.AbschaltschwelleInWatt`);
	const surplusDurState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
	const socketDurState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.DauerSteckdoseAnInMin`);
	const hourState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltHour`);
	const minuteState = await adapter.getStateAsync(`${adapter.namespace}.${pfx}.EinschaltMinute`);

	// Clone the full socket array and update the target socket
	const payload = JSON.parse(JSON.stringify(adapter.webSocketData));
	const socket = payload.find((s) => (s.steckdosenummer ?? s.steckdosennummer) === idx);
	if (!socket) {
		adapter.log.warn(`mein-senec.de: Socket ${idx} not found in stored data`);
		await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
		return;
	}

	if (nameState?.val !== undefined && nameState.val !== null) {
		socket.name = String(nameState.val);
	}
	socket.mode = String(modeState?.val || socket.mode);
	socket.einschaltschwelleInWatt = Number(onThreshState?.val) || 0;
	socket.abschaltschwelleInWatt = Number(offThreshState?.val) || 0;
	socket.dauerLeistungsueberschussInMin = Number(surplusDurState?.val) || 0;
	socket.dauerSteckdoseAnInMin = Number(socketDurState?.val) || 0;
	if (socket.mode === "AUTOMATIC") {
		socket.einschaltzeit = [Number(hourState?.val) || 0, Number(minuteState?.val) || 0];
	}

	adapter.log.info(`mein-senec.de: Applying socket ${idx} settings (mode=${socket.mode})`);
	try {
		const postRes = await webPost(adapter, `${WEB_HOST}/endkunde/api/steckdosen/save`, payload);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`mein-senec.de: Socket save failed (HTTP ${postRes.status}): ${errMsg}`);
			await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`);
		if (res?.data && Array.isArray(res.data)) {
			adapter.webSocketData = res.data;
			for (const s of res.data) {
				const sIdx = s.steckdosenummer ?? s.steckdosennummer;
				if (sIdx === undefined) {
					continue;
				}
				const { steuereinheit: _se, state: sState, ...sFields } = s;
				await adapter.evalPoll(sFields, `_meinsenec.Sockets.${sIdx}.`);
				if (sState && typeof sState === "object") {
					const { steuereinheit: _sse, ...sStateFields } = sState;
					await adapter.evalPoll(sStateFields, `_meinsenec.Sockets.${sIdx}.State.`);
				}
				await webSyncSocketControls(adapter, sIdx, s);
			}
		}
		adapter.log.info(`mein-senec.de: Socket ${idx} settings applied`);
	} catch (error) {
		adapter.logError(error, "mein-senec.de: Failed to apply socket settings");
	}
	await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Perform web login to mein-senec.de via Keycloak SSO.
 * Uses a dedicated cookie jar (webJar) separate from the App API jar.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {{ extractFormAction: (html: string) => string|null, hasOtp: (html: string) => boolean, hasUsername: (html: string) => boolean, hasPassword: (html: string) => boolean, generateTOTP: (secret: string) => string }} deps - Helper functions
 * @returns {Promise<boolean>} true if login succeeded
 */
async function webLogin(adapter, deps) {
	const { extractFormAction, hasOtp, hasUsername, hasPassword, generateTOTP } = deps;
	const WEB_BASE = WEB_HOST;
	const email = adapter.config.api_mail;
	const password = adapter.config.api_pwd;

	if (!email || !password) {
		adapter.log.warn("mein-senec.de: No credentials configured (api_mail/api_pwd).");
		return false;
	}

	if (!adapter.authClient) {
		throw new Error("authClient not initialized");
	}
	adapter.webJar = new CookieJar();
	const client = adapter.authClient;
	const jar = adapter.webJar;

	try {
		// Step 1: GET mein-senec.de → follows redirects to SSO login form
		adapter.log.info("🔐 mein-senec.de: Requesting login page...");
		const pageRes = await client.get(WEB_BASE, {
			jar: jar,
			maxRedirects: 10,
			validateStatus: () => true,
		});

		const html = typeof pageRes.data === "string" ? pageRes.data : "";
		const formAction = extractFormAction(html);

		if (!formAction) {
			// Maybe already authenticated?
			if (html.includes("ng-controller") || html.includes("endkunde")) {
				adapter.log.info("mein-senec.de: Already authenticated (no login form found).");
				return true;
			}
			adapter.log.warn("mein-senec.de: Could not find login form action URL.");
			adapter.log.debug(`🔍 Login page HTML (first 500 chars): ${html.slice(0, 500)}`);
			return false;
		}

		adapter.log.info("🔐 mein-senec.de: Found login form, posting credentials...");

		// Step 2: POST credentials to SSO form
		const loginRes = await client.post(
			formAction.replace(/&amp;/g, "&"),
			new URLSearchParams({ username: email, password: password }).toString(),
			{
				jar: jar,
				maxRedirects: 10,
				validateStatus: () => true,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			},
		);

		const loginHtml = typeof loginRes.data === "string" ? loginRes.data : "";

		// Step 3: Check for TOTP/OTP form
		if (hasOtp(loginHtml)) {
			const totpSecret = adapter.config.api_totp_secret;
			if (!totpSecret) {
				adapter.log.warn("mein-senec.de: TOTP required but no TOTP secret configured.");
				return false;
			}

			const otpFormAction = extractFormAction(loginHtml);
			if (!otpFormAction) {
				adapter.log.warn("mein-senec.de: TOTP form found but no action URL.");
				return false;
			}

			const totpCode = generateTOTP(totpSecret);
			adapter.log.info("🔐 mein-senec.de: Submitting TOTP code...");

			const otpRes = await client.post(
				otpFormAction.replace(/&amp;/g, "&"),
				new URLSearchParams({ otp: totpCode }).toString(),
				{
					jar: jar,
					maxRedirects: 10,
					validateStatus: () => true,
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
				},
			);

			const otpHtml = typeof otpRes.data === "string" ? otpRes.data : "";
			if (otpHtml.includes("Login - SENEC") || extractFormAction(otpHtml)) {
				adapter.log.warn("mein-senec.de: TOTP login failed — still on login page.");
				return false;
			}
		} else if (loginHtml.includes("Login - SENEC") || (hasUsername(loginHtml) && hasPassword(loginHtml))) {
			adapter.log.warn("mein-senec.de: Login failed — still on login page. Check credentials.");
			return false;
		}

		// Step 4: Verify we're authenticated
		adapter.log.info("mein-senec.de: Login flow complete. Verifying session...");
		const verifyRes = await client.get(`${WEB_BASE}/endkunde/api/context/getEndkunde`, {
			jar: jar,
			maxRedirects: 0,
			validateStatus: () => true,
		});

		if (verifyRes.status === 200 && typeof verifyRes.data === "object") {
			adapter.log.info(`✅ mein-senec.de: Authenticated successfully! devNumber: ${verifyRes.data.devNumber}`);
			return true;
		}

		adapter.log.warn(`mein-senec.de: Verification failed — HTTP ${verifyRes.status}`);
		return false;
	} catch (error) {
		adapter.log.warn(`mein-senec.de: Login error — ${error.message}`);
		return false;
	}
}

module.exports = {
	webApiErrorMsg,
	webInit,
	_webRequest,
	webGet,
	webPost,
	webPoll,
	webCreateControls,
	webCreateSocketControls,
	webHandleControl,
	webHandlePeakShavingApply,
	webSyncPeakShavingControls,
	webHandleSGReadyApply,
	webSyncSGReadyControls,
	webSyncSocketControls,
	webHandleSocketControl,
	webLogin,
};
