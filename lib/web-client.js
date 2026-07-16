"use strict";
// Endpoints (mein-senec.de):
//   Portal:       https://mein-senec.de
//   Auth (SSO):   https://sso.senec.com/realms/senec/protocol/openid-connect
//   Status:       /endkunde/api/status/getstatusoverview.php
//   Measurements: /endkunde/api/status/getstatus.php?type={TYPE}&period={PERIOD}
//   Autarky:      /endkunde/api/status/getautarky.php
//   AccuState:    /endkunde/api/status/getaccustate.php
//   Customer:     /endkunde/api/context/getEndkunde
//   System:       /endkunde/api/context/getAnlageBasedNavigationViewModel
//   Emergency:    /endkunde/api/senec/{pn}/emergencypower/reserve-in-percent
//   Peak Shaving: /endkunde/api/peakshaving/getSettings | saveSettings
//   SG-Ready:     /endkunde/api/senec/{pn}/sgready/state | config
//   Sockets:      /endkunde/api/steckdosen/findByGeraetenummer | save

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const { CookieJar } = require("tough-cookie");
const { WEB_HOST } = require("./constants.js");
const { extractFormAction, hasOtp, hasUsername, hasPassword, generateTOTP } = require("./auth-helpers.js");

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
	adapter.webAuthenticated = await webLogin(adapter);
	if (!adapter.webAuthenticated) {
		adapter.log.warn("[Web] ⚠️ Web login failed. Check credentials.");
		return;
	}

	// Step 2: Discover customer + system
	let systemCount = 1;
	try {
		const custRes = await webGet(adapter, `${WEB_BASE}/endkunde/api/context/getEndkunde`);
		if (custRes?.data && typeof custRes.data === "object") {
			await adapter.evalPoll(custRes.data, "_meinsenec.Customer.");
			systemCount = custRes.data.anzahlAnlagen || 1;
			adapter.log.info(`[Web] Customer devNumber=${custRes.data.devNumber}, systems=${systemCount}`);
		}
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Failed to get customer info");
	}

	// Iterate systems — first master becomes THE master, others are registered as secondary
	adapter.webSecondaryPlants = new Map();
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

			if (adapter.webMasterPlantNumber === null) {
				// First system becomes master
				adapter.webMasterPlantNumber = plantNum;
				adapter.log.info(`[Web] Master system ${plantNum}: ${sys.produktName} (${sys.steuereinheitnummer})`);

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
				adapter.log.info(`[Web] Abilities: ${JSON.stringify(adapter.webAbilities)}`);
			} else {
				// Secondary plant — register and create poll control
				const sn = String(sys.steuereinheitnummer || `plant_${plantNum}`).replace(/[^a-zA-Z0-9_-]/g, "_");
				const name = sys.produktName || `Plant ${plantNum}`;
				adapter.webSecondaryPlants.set(sn, { anlageNummer: plantNum, produktName: name });
				adapter.log.info(`[Web] Secondary plant ${plantNum}: ${name} (${sn})`);

				// Store basic system info
				const plantPfx = `_meinsenec.Plants.${sn}.`;
				await adapter.doState(`${plantPfx}System.produktName`, name, "Product Name", "", false);
				await adapter.doState(`${plantPfx}System.steuereinheitnummer`, sn, "Device Number", "", false);
				await adapter.doState(`${plantPfx}System.anlageNummer`, plantNum, "Plant Number", "", false);

				// Create poll control state
				const pollId = `control.Plants.${sn}.poll`;
				await adapter.setObjectNotExistsAsync(pollId, {
					type: "state",
					common: {
						name: `Poll measurements for ${name} (${sn})`,
						type: "boolean",
						role: "switch",
						read: true,
						write: true,
						def: false,
					},
					native: {},
				});
				await adapter.subscribeStatesAsync(pollId);

				// Initial minimum poll — fetch AllTime on first discovery (non-blocking)
				const allTimePfx = `${plantPfx}Measurements.AllTime.`;
				const existing = await adapter.getStateAsync(`${allTimePfx}lastUpdated`);
				if (!existing?.val) {
					adapter.log.info(`[Web] 🔄 Queuing initial AllTime fetch for secondary plant ${sn}`);
					const retryOpts = { maxRetries: 3, label: `AllTime plant ${sn}` };
					const pnCapture = plantNum;
					webFetchAllTypes(adapter, pnCapture, "all", {}, retryOpts)
						.then(async (data) => {
							for (const type of WEB_MEASUREMENT_TYPES) {
								if (data[type]) {
									await webWriteMeasurement(adapter, allTimePfx, type, data[type], {
										yearly: true,
									});
								}
							}
							await adapter.doState(
								`${allTimePfx}lastUpdated`,
								new Date().toISOString(),
								"Last updated",
								"",
								false,
							);
							adapter.log.info(`[Web] ✅ Initial AllTime for secondary plant ${sn} complete`);
						})
						.catch((err) => {
							adapter.logError(err, `[Web] ❌ Initial AllTime fetch for plant ${sn} failed`);
						});
				}
			}
		} catch (error) {
			adapter.logError(error, `[Web] ❌ Failed to get system ${plantNum}`);
		}
	}

	if (adapter.webMasterPlantNumber === null) {
		adapter.log.warn("[Web] ⚠️ No master system found.");
		return;
	}

	// Step 3: Create controls (if enabled) & start polling
	if (adapter.config.control_web_active) {
		await webCreateControls(adapter);
	}
	adapter.webConnected = true;
	await adapter.setState("info.webConnected", true, true);
	webPoll(adapter).catch((e) => adapter.logError(e, "[Web] ❌ initial poll failed"));
}

/**
 * Shared mein-senec.de HTTP request with session-expiry re-auth.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {"get" | "post"} method - HTTP method
 * @param {string} url - URL to request
 * @param {object} [data] - Optional JSON body (POST only)
 * @param {{ maxRetries?: number, label?: string }} [queueOptions] - Queue retry options
 * @returns {Promise<object>} axios response
 */
async function _webRequest(adapter, method, url, data, queueOptions) {
	if (!adapter.authClient) {
		throw new Error("authClient not initialized");
	}

	const client = adapter.authClient;
	const doRequest = async () => {
		const label = method.toUpperCase();
		adapter.log.debug(`[Web] ${label}: ${url}`);

		const baseConfig = { jar: adapter.webJar || undefined, maxRedirects: 5 };
		const headers = method === "post" && data !== undefined ? { "Content-Type": "application/json" } : undefined;
		const config = { ...baseConfig, validateStatus: () => true, ...(headers ? { headers } : {}) };

		const res = method === "get" ? await client.get(url, config) : await client.post(url, data, config);

		if (adapter.config.api_reqnresp_log) {
			adapter.log.debug(
				`[Web] ${label} response: HTTP ${res.status} → ${JSON.stringify(res.data).slice(0, 500)}`,
			);
		} else {
			adapter.log.debug(`[Web] ${label} response: HTTP ${res.status}`);
		}

		if (res.status === 200 && typeof res.data === "string" && res.data.includes("Login - SENEC")) {
			adapter.log.debug("[Web] Session expired, re-authenticating...");
			adapter.webAuthenticated = await webLogin(adapter);
			if (!adapter.webAuthenticated) {
				throw new Error("mein-senec.de re-authentication failed");
			}
			return method === "get" ? client.get(url, baseConfig) : client.post(url, data, baseConfig);
		}
		return res;
	};

	// Route through web queue if available, otherwise direct call
	if (adapter.webQueue) {
		return adapter.webQueue.add(doRequest, queueOptions);
	}
	return doRequest();
}

/**
 * GET request to mein-senec.de with auto re-auth on session expiry.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} url - URL to request
 * @param {{ maxRetries?: number, label?: string }} [queueOptions] - Queue retry options
 * @returns {Promise<object>} axios response
 */
async function webGet(adapter, url, queueOptions) {
	return _webRequest(adapter, "get", url, undefined, queueOptions);
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
		adapter.log.debug("[Web] 🔄 Polling mein-senec.de...");

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
			adapter.logError(error, "[Web] ❌ Status poll failed");
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
						if (adapter.config.control_web_active) {
							await adapter.setStateChangedAsync("control.EmergencyPower.ReserveInPercent", {
								val: val,
								ack: true,
							});
						}
					}
				}
			} catch (error) {
				adapter.logError(error, "[Web] ❌ Emergency power poll failed");
			}
		}

		// Battery state — every 6h
		if (!adapter._webLastAccuStatePoll || now - adapter._webLastAccuStatePoll >= adapter.webMediumIntervalMs) {
			try {
				const accuRes = await webGet(
					adapter,
					`${WEB_BASE}/endkunde/api/status/getaccustate.php?anlageNummer=${pn}`,
				);
				if (accuRes?.data && typeof accuRes.data === "object") {
					const a = accuRes.data;
					const pfx = "_meinsenec.AccuState.";
					if (typeof a.batteryvoltage === "number") {
						await adapter.doState(`${pfx}batteryvoltage`, a.batteryvoltage, "Battery Voltage", "V", false);
					}
					if (typeof a.batterycurrent === "number") {
						await adapter.doState(`${pfx}batterycurrent`, a.batterycurrent, "Battery Current", "A", false);
					}
					if (typeof a.capacity === "number") {
						await adapter.doState(`${pfx}capacity`, a.capacity, "Battery Capacity", "kWh", false);
					}
					if (a.akkutyp) {
						await adapter.doState(`${pfx}akkutyp`, String(a.akkutyp), "Battery Type", "", false);
					}
					if (Array.isArray(a.val)) {
						const formatHistory = (arr) =>
							arr.map(([ts, v]) => [new Date(ts).toISOString(), Math.round(v * 100) / 100]);
						if (a.val[0]) {
							await adapter.doState(
								`${pfx}voltageHistory`,
								JSON.stringify(formatHistory(a.val[0])),
								"Voltage history (today)",
								"",
								false,
							);
						}
						if (a.val[1]) {
							await adapter.doState(
								`${pfx}currentHistory`,
								JSON.stringify(formatHistory(a.val[1])),
								"Current history (today)",
								"",
								false,
							);
						}
					}
					await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
					await adapter.updateLastPoll("_meinsenec.info.lastPoll.AccuState", "Last battery state poll");
					adapter._webLastAccuStatePoll = now;
				}
			} catch (error) {
				adapter.logError(error, "[Web] ❌ Battery state poll failed");
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
					if (adapter.config.control_web_active) {
						await webSyncPeakShavingControls(adapter, res.data);
					}
				}
			} catch (error) {
				adapter.logError(error, "[Web] ❌ Peak shaving poll failed");
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
				adapter.logError(error, "[Web] ❌ SG-Ready state poll failed");
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
					if (adapter.config.control_web_active) {
						await webSyncSGReadyControls(adapter, res.data);
					}
				}
			} catch (error) {
				adapter.logError(error, "[Web] ❌ SG-Ready config poll failed");
			}
		}
	} catch (error) {
		adapter.logError(error, "[Web] ❌ poll cycle failed");
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
			adapter.logError(error, "[Web] ❌ Sockets poll failed");
		}
	}

	// Web measurements (gated by config toggle)
	if (adapter.config.web_measurements) {
		try {
			await webPollMeasurements(adapter, pn);
		} catch (error) {
			adapter.logError(error, "[Web] ❌ Measurements poll failed");
		}
	}

	if (!adapter.unloaded) {
		adapter.setTimeout(() => {
			webPoll(adapter).catch((e) => adapter.logError(e, "[Web] ❌ scheduled poll failed"));
		}, adapter.webStatusIntervalMs);
		adapter.log.debug(`[Web] ⏱ Next mein-senec.de poll in ${(adapter.webStatusIntervalMs / 1000).toFixed(0)}s`);
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
		`[Web] Created web controls (peakShaving=${adapter.webAbilities.peakShaving}, sgReady=${adapter.webAbilities.sgReady})`,
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
	adapter.log.info(`[Web] ✅ Created web socket controls for ${count} socket(s)`);
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
		adapter.log.warn("[Web] ⚠️ No master plant number, cannot send control command");
		return;
	}

	// Emergency power — direct send (single field, no Apply needed)
	if (subId === "EmergencyPower.ReserveInPercent") {
		const val = Math.round(Math.max(0, Math.min(100, Number(state.val) || 0)));
		adapter.log.info(`[Web] 🔄 Setting emergency power reserve to ${val}%`);
		try {
			const postRes = await webPost(
				adapter,
				`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower?reserve-in-percent=${val}`,
			);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				adapter.log.error(`[Web] Emergency power save failed (HTTP ${postRes.status}): ${errMsg}`);
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
			adapter.log.info(`[Web] ✅ Emergency power reserve set to ${val}%`);
		} catch (error) {
			adapter.logError(error, "[Web] ❌ Failed to set emergency power reserve");
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

	adapter.log.warn(`[Web] ⚠️ Unknown web control: ${subId}`);
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
		adapter.log.warn("[Web] ⚠️ Peak shaving mode is empty, not applying");
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
		`[Web] Applying peak shaving settings (mode=${mode}, cap=${capacityLimit}%, end=${endHour}:${String(endMinute).padStart(2, "0")})`,
	);
	try {
		const postRes = await webPost(
			adapter,
			`${WEB_HOST}/endkunde/api/peakshaving/saveSettings?${params.toString()}`,
		);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`[Web] Peak shaving save failed (HTTP ${postRes.status}): ${errMsg}`);
			await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`);
		if (res?.data && typeof res.data === "object") {
			await adapter.evalPoll(res.data, "_meinsenec.PeakShaving.");
			await webSyncPeakShavingControls(adapter, res.data);
		}
		adapter.log.info("[Web] ✅ Peak shaving settings applied");
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Failed to apply peak shaving settings");
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
		adapter.log.debug("[Web] SG-Ready — no pending changes to apply");
		await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
		return;
	}

	adapter.log.info(`[Web] Applying SG-Ready settings: ${JSON.stringify(body)}`);
	try {
		const postRes = await webPost(adapter, `${WEB_HOST}/endkunde/api/senec/${pn}/sgready`, body);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`[Web] SG-Ready save failed (HTTP ${postRes.status}): ${errMsg}`);
			await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/senec/${pn}/sgready/config`);
		if (res?.data && typeof res.data === "object") {
			await adapter.evalPoll(res.data, "_meinsenec.SGReady.Config.");
			await webSyncSGReadyControls(adapter, res.data);
		}
		adapter.log.info("[Web] ✅ SG-Ready settings applied");
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Failed to apply SG-Ready settings");
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
		adapter.log.warn("[Web] ⚠️ No socket data available, cannot apply changes");
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
		adapter.log.warn(`[Web] ⚠️ Socket ${idx} not found in stored data`);
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

	adapter.log.info(`[Web] 🔄 Applying socket ${idx} settings (mode=${socket.mode})`);
	try {
		const postRes = await webPost(adapter, `${WEB_HOST}/endkunde/api/steckdosen/save`, payload);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			adapter.log.error(`[Web] Socket save failed (HTTP ${postRes.status}): ${errMsg}`);
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
		adapter.log.info(`[Web] ✅ Socket ${idx} settings applied`);
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Failed to apply socket settings");
	}
	await adapter.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Perform web login to mein-senec.de via Keycloak SSO.
 * Uses a dedicated cookie jar (webJar) separate from the App API jar.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<boolean>} true if login succeeded
 */
async function webLogin(adapter) {
	const WEB_BASE = WEB_HOST;
	const email = adapter.config.api_mail;
	const password = adapter.config.api_pwd;

	if (!email || !password) {
		adapter.log.warn("[Web] ⚠️ No credentials configured (api_mail/api_pwd).");
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
		adapter.log.info("[Web] 🔐 Requesting login page...");
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
				adapter.log.info("[Web] Already authenticated (no login form found).");
				return true;
			}
			adapter.log.warn("[Web] ⚠️ Could not find login form action URL.");
			adapter.log.debug(`[Web] 🔍 Login page HTML (first 500 chars): ${html.slice(0, 500)}`);
			return false;
		}

		adapter.log.info("[Web] 🔐 Found login form, posting credentials...");

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
				adapter.log.warn("[Web] ⚠️ TOTP required but no TOTP secret configured.");
				return false;
			}

			const otpFormAction = extractFormAction(loginHtml);
			if (!otpFormAction) {
				adapter.log.warn("[Web] ⚠️ TOTP form found but no action URL.");
				return false;
			}

			const totpCode = generateTOTP(totpSecret);
			adapter.log.info("[Web] 🔐 Submitting TOTP code...");

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
				adapter.log.warn("[Web] TOTP login failed — still on login page.");
				return false;
			}
		} else if (loginHtml.includes("Login - SENEC") || (hasUsername(loginHtml) && hasPassword(loginHtml))) {
			adapter.log.warn("[Web] Login failed — still on login page. Check credentials.");
			return false;
		}

		// Step 4: Verify we're authenticated
		adapter.log.info("[Web] Login flow complete. Verifying session...");
		const verifyRes = await client.get(`${WEB_BASE}/endkunde/api/context/getEndkunde`, {
			jar: jar,
			maxRedirects: 0,
			validateStatus: () => true,
		});

		if (verifyRes.status === 200 && typeof verifyRes.data === "object") {
			adapter.log.info(`[Web] ✅ Authenticated successfully! devNumber: ${verifyRes.data.devNumber}`);
			return true;
		}

		adapter.log.warn(`[Web] Verification failed — HTTP ${verifyRes.status}`);
		return false;
	} catch (error) {
		adapter.log.warn(`[Web] Login error — ${error.message}`);
		return false;
	}
}

// ── Web Measurements ─────────────────────────────────────────────────────────

/** All measurement types supported by getstatus.php */
const WEB_MEASUREMENT_TYPES = ["consumption", "powergenerated", "accuexport", "accuimport", "gridimport", "gridexport"];

/** Human-readable names for measurement types */
const WEB_MEASUREMENT_NAMES = {
	consumption: "Consumption",
	powergenerated: "Power Generated",
	accuexport: "Battery Charge",
	accuimport: "Battery Discharge",
	gridimport: "Grid Import",
	gridexport: "Grid Export",
};

/**
 * Fetch a single measurement from mein-senec.de getstatus.php.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number (anlageNummer)
 * @param {string} type - Measurement type (e.g. "powergenerated")
 * @param {string} period - Period (e.g. "today", "yesterday", "7days", "month", "range", "all")
 * @param {{ timestamp?: number, days?: number }} [params] - Optional extra params
 * @param {{ maxRetries?: number, label?: string }} [queueOptions] - Queue retry options
 * @returns {Promise<{ fullkwh: number, lastupdated: number, val: Array<[number, number]> } | null>} Measurement data or null on error
 */
async function webFetchMeasurement(adapter, pn, type, period, params = {}, queueOptions) {
	let url = `${WEB_HOST}/endkunde/api/status/getstatus.php?type=${encodeURIComponent(type)}&period=${encodeURIComponent(period)}&anlageNummer=${pn}`;
	if (params.timestamp !== undefined) {
		url += `&timestamp=${params.timestamp}`;
	}
	if (params.days !== undefined) {
		url += `&days=${params.days}`;
	}
	try {
		const res = await webGet(adapter, url, queueOptions);
		if (res?.data && typeof res.data === "object" && typeof res.data.fullkwh === "number") {
			return res.data;
		}
		adapter.log.debug(
			`[Web] ⚠️ Unexpected measurement response for ${type}/${period}: ${JSON.stringify(res?.data).slice(0, 200)}`,
		);
		return null;
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Measurement fetch failed (${type}/${period})`);
		return null;
	}
}

/**
 * Aggregate ~5-min interval kW data into hourly kWh sums.
 * Each kW value is multiplied by its actual interval duration (hours) to get kWh.
 *
 * @param {Array<[number, number]>} val - Array of [timestamp_ms, value_kw]
 * @returns {Record<number, number>} Hourly kWh sums keyed 0-23
 */
function aggregateToHourly(val) {
	/** @type {Record<number, number>} */ // eslint-disable-line jsdoc/check-tag-names
	const hourly = {};
	for (let h = 0; h < 24; h++) {
		hourly[h] = 0;
	}
	for (let i = 0; i < val.length; i++) {
		const [ts, kw] = val[i];
		// Calculate interval: use gap to next reading, or gap from previous for last entry
		let intervalMs;
		if (i < val.length - 1) {
			intervalMs = val[i + 1][0] - ts;
		} else if (i > 0) {
			intervalMs = ts - val[i - 1][0];
		} else {
			intervalMs = 300000; // fallback: 5 minutes
		}
		const intervalHours = intervalMs / 3600000;
		const hour = new Date(ts).getHours();
		hourly[hour] += kw * intervalHours;
	}
	return hourly;
}

/**
 * Aggregate daily data into per-day values keyed by day-of-month (1-31).
 *
 * @param {Array<[number, number]>} val - Array of [timestamp_ms, value_kwh]
 * @returns {Record<number, number>} Daily values keyed 1-31
 */
function aggregateToDaily(val) {
	/** @type {Record<number, number>} */ // eslint-disable-line jsdoc/check-tag-names
	const daily = {};
	for (const [ts, value] of val) {
		const day = new Date(ts).getDate();
		daily[day] = (daily[day] || 0) + value;
	}
	return daily;
}

/**
 * Aggregate daily data into per-month values keyed by month (1-12).
 *
 * @param {Array<[number, number]>} val - Array of [timestamp_ms, value_kwh]
 * @returns {Record<number, number>} Monthly values keyed 1-12
 */
function aggregateToMonthly(val) {
	/** @type {Record<number, number>} */ // eslint-disable-line jsdoc/check-tag-names
	const monthly = {};
	for (let m = 1; m <= 12; m++) {
		monthly[m] = 0;
	}
	for (const [ts, value] of val) {
		const month = new Date(ts).getMonth() + 1;
		monthly[month] += value;
	}
	return monthly;
}

/**
 * Write measurement data to adapter states for a given period/type.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} pfx - State prefix (e.g. "_meinsenec.Measurements.Daily.today.")
 * @param {string} type - Measurement type
 * @param {{ fullkwh: number, val: Array<[number, number]> }} data - Measurement data
 * @param {{ hourly?: boolean, detail?: boolean, daily?: boolean, monthly?: boolean, yearly?: boolean }} aggregations - Which aggregations to write
 * @returns {Promise<void>}
 */
async function webWriteMeasurement(adapter, pfx, type, data, aggregations = {}) {
	const name = WEB_MEASUREMENT_NAMES[type] || type;

	// Write total
	await adapter.doState(`${pfx}${type}`, data.fullkwh, `${name} (total)`, "kWh", false);

	if (aggregations.hourly && data.val) {
		const hourly = aggregateToHourly(data.val);
		for (const [hour, value] of Object.entries(hourly)) {
			await adapter.doState(`${pfx}${type}.hourly.${hour}`, value, `${name} (hour ${hour})`, "kWh", false);
		}
	}

	if (aggregations.detail && data.val) {
		for (const [ts, value] of data.val) {
			const d = new Date(ts);
			const timeKey = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
			await adapter.doState(`${pfx}${type}.detail.${timeKey}`, value, `${name} (${timeKey})`, "kW", false);
		}
	}

	if (aggregations.daily && data.val) {
		const daily = aggregateToDaily(data.val);
		for (const [day, value] of Object.entries(daily)) {
			await adapter.doState(`${pfx}${type}.daily.${day}`, value, `${name} (day ${day})`, "kWh", false);
		}
	}

	if (aggregations.monthly && data.val) {
		const monthly = aggregateToMonthly(data.val);
		for (const [month, value] of Object.entries(monthly)) {
			await adapter.doState(`${pfx}${type}.monthly.${month}`, value, `${name} (month ${month})`, "kWh", false);
		}
	}

	if (aggregations.yearly && data.val) {
		for (const [ts, value] of data.val) {
			const year = new Date(ts).getFullYear();
			await adapter.doState(`${pfx}${type}.${year}`, value, `${name} (${year})`, "kWh", false);
		}
	}
}

/**
 * Fetch all 6 measurement types for a given period in parallel.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @param {string} period - Period string for getstatus.php
 * @param {{ timestamp?: number, days?: number }} [params] - Extra URL params
 * @param {{ maxRetries?: number, label?: string }} [queueOptions] - Queue retry options
 * @returns {Promise<Record<string, { fullkwh: number, lastupdated: number, val: Array<[number, number]> } | null>>} Results keyed by type
 */
async function webFetchAllTypes(adapter, pn, period, params = {}, queueOptions) {
	const results = await Promise.allSettled(
		WEB_MEASUREMENT_TYPES.map((type) => webFetchMeasurement(adapter, pn, type, period, params, queueOptions)),
	);
	/** @type {Record<string, { fullkwh: number, lastupdated: number, val: Array<[number, number]> } | null>} */ // eslint-disable-line jsdoc/check-tag-names
	const out = {};
	for (let i = 0; i < WEB_MEASUREMENT_TYPES.length; i++) {
		const r = results[i];
		out[WEB_MEASUREMENT_TYPES[i]] = r.status === "fulfilled" ? r.value : null;
	}
	return out;
}

/**
 * Poll today's measurements (status tier).
 * Writes fullkwh total, hourly aggregation, and 5-min detail data.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @returns {Promise<void>}
 */
async function webPollMeasurementsToday(adapter, pn) {
	const now = new Date();
	const periodTag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	adapter.log.debug(`[Web] 🔄 Polling measurements: today → ${periodTag}`);
	const pfx = "_meinsenec.Measurements.Daily.today.";

	// Wipe detail states only when the day changes — within a day timestamps are stable
	if (adapter.config.web_measurements_detail) {
		const storedPeriod = await adapter.getStateAsync(`${pfx}period`);
		if (storedPeriod?.val && String(storedPeriod.val) !== periodTag) {
			for (const type of WEB_MEASUREMENT_TYPES) {
				await webCleanupStates(adapter, `${pfx}${type}.detail.`, `today ${type} detail`);
			}
		}
	}

	const data = await webFetchAllTypes(adapter, pn, "today");
	for (const type of WEB_MEASUREMENT_TYPES) {
		if (data[type]) {
			await webWriteMeasurement(adapter, pfx, type, data[type], {
				hourly: true,
				detail: !!adapter.config.web_measurements_detail,
			});
		}
	}
	await adapter.doState(`${pfx}period`, periodTag, "Polled period", "", false);
	await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	await adapter.updateLastPoll("_meinsenec.info.lastPoll.MeasurementsToday", "Last today measurements poll");
}

/**
 * Poll yesterday's measurements (medium tier).
 * Writes fullkwh total, hourly aggregation, and 5-min detail data.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @returns {Promise<void>}
 */
async function webPollMeasurementsYesterday(adapter, pn) {
	// Skip if already updated today
	const lastUpdate = await adapter.getStateAsync("_meinsenec.Measurements.Daily.yesterday.lastUpdated");
	if (lastUpdate?.val) {
		const lastDate = new Date(String(lastUpdate.val));
		const now = new Date();
		if (
			!isNaN(lastDate.getTime()) &&
			lastDate.getFullYear() === now.getFullYear() &&
			lastDate.getMonth() === now.getMonth() &&
			lastDate.getDate() === now.getDate()
		) {
			adapter.log.silly("[Web] Measurements for yesterday already updated today. Skipping.");
			return;
		}
	}

	const now = new Date();
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	const periodTag = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
	adapter.log.debug(`[Web] 🔄 Polling measurements: yesterday → ${periodTag}`);
	const pfx = "_meinsenec.Measurements.Daily.yesterday.";

	// Wipe detail states before rewriting — new day means entirely different timestamps
	if (adapter.config.web_measurements_detail) {
		for (const type of WEB_MEASUREMENT_TYPES) {
			await webCleanupStates(adapter, `${pfx}${type}.detail.`, `yesterday ${type} detail`);
		}
	}

	const data = await webFetchAllTypes(adapter, pn, "yesterday");
	for (const type of WEB_MEASUREMENT_TYPES) {
		if (data[type]) {
			await webWriteMeasurement(adapter, pfx, type, data[type], {
				hourly: true,
				detail: !!adapter.config.web_measurements_detail,
			});
		}
	}
	await adapter.doState(`${pfx}period`, periodTag, "Polled period", "", false);
	await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	await adapter.updateLastPoll("_meinsenec.info.lastPoll.MeasurementsYesterday", "Last yesterday measurements poll");
}

/**
 * Poll monthly measurements (slow tier).
 * Uses period=month with timestamp to get daily breakdown.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @param {Date} monthStart - First day of the month (UTC)
 * @param {string} label - "current_month" or "previous_month"
 * @returns {Promise<void>}
 */
async function webPollMeasurementsMonth(adapter, pn, monthStart, label) {
	// Skip previous_month if already updated this calendar month
	if (label === "previous_month") {
		const lastUpdate = await adapter.getStateAsync(`_meinsenec.Measurements.Monthly.${label}.lastUpdated`);
		if (lastUpdate?.val) {
			const lastDate = new Date(String(lastUpdate.val));
			const now = new Date();
			if (
				!isNaN(lastDate.getTime()) &&
				lastDate.getUTCFullYear() === now.getUTCFullYear() &&
				lastDate.getUTCMonth() === now.getUTCMonth()
			) {
				adapter.log.silly(`[Web] Measurements for ${label} already updated this month. Skipping.`);
				return;
			}
		}
	}

	const periodTag = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;
	adapter.log.debug(`[Web] 🔄 Polling measurements: ${label} → ${periodTag}`);
	const pfx = `_meinsenec.Measurements.Monthly.${label}.`;

	// period=month always returns current month regardless of timestamp,
	// so use period=range for past months.
	// For period=range: timestamp = end of range, days = lookback period.
	let data;
	if (label === "current_month") {
		data = await webFetchAllTypes(adapter, pn, "month", { timestamp: monthStart.getTime() });
	} else {
		// Use last day of the target month as range end (local time)
		const monthEnd = new Date(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0, 23, 59, 59);
		const daysInMonth = monthEnd.getDate();
		data = await webFetchAllTypes(adapter, pn, "range", { timestamp: monthEnd.getTime(), days: daysInMonth });
	}
	for (const type of WEB_MEASUREMENT_TYPES) {
		if (data[type]) {
			await webWriteMeasurement(adapter, pfx, type, data[type], { daily: true });
		}
	}
	await adapter.doState(`${pfx}period`, periodTag, "Polled period", "", false);
	await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	await adapter.updateLastPoll(`_meinsenec.info.lastPoll.Measurements.${label}`, `Last ${label} measurements poll`);
}

/**
 * Poll yearly measurements with monthly breakdown (slow tier).
 * Uses period=range with current timestamp and days back to Jan 1.
 * The API returns monthly aggregates automatically for large ranges.
 * Timestamp = end of range, days = lookback period.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @param {number} year - Year to poll
 * @param {string} label - "current_year" or "previous_year"
 * @returns {Promise<void>}
 */
async function webPollMeasurementsYear(adapter, pn, year, label) {
	// Skip previous year if already updated this calendar year
	if (label === "previous_year") {
		const lastUpdate = await adapter.getStateAsync(`_meinsenec.Measurements.Yearly.${year}.lastUpdated`);
		if (lastUpdate?.val) {
			const lastDate = new Date(String(lastUpdate.val));
			const now = new Date();
			if (!isNaN(lastDate.getTime()) && lastDate.getUTCFullYear() === now.getUTCFullYear()) {
				adapter.log.silly(`[Web] Measurements for year ${year} already updated this year. Skipping.`);
				return;
			}
		}
	}

	adapter.log.debug(`[Web] 🔄 Polling measurements: year ${year} (${label})`);
	const pfx = `_meinsenec.Measurements.Yearly.${year}.`;

	// Use current time as range end for current year, Dec 31 23:59 for past years
	// Timestamp = end of range, days = lookback to Jan 1
	const now = new Date();
	let rangeEnd;
	if (label === "current_year") {
		rangeEnd = now;
	} else {
		rangeEnd = new Date(year, 11, 31, 23, 59, 59); // Dec 31 local time
	}
	const jan1 = new Date(year, 0, 1); // Jan 1 local time
	const days = Math.ceil((rangeEnd.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));

	const data = await webFetchAllTypes(adapter, pn, "range", {
		timestamp: rangeEnd.getTime(),
		days,
	});

	for (const type of WEB_MEASUREMENT_TYPES) {
		if (data[type]) {
			const name = WEB_MEASUREMENT_NAMES[type] || type;
			await adapter.doState(`${pfx}${type}`, data[type].fullkwh, `${name} (${year} total)`, "kWh", false);
			// API returns monthly aggregates — val entries are per-month
			if (data[type].val) {
				for (const [ts, value] of data[type].val) {
					const month = new Date(ts).getMonth() + 1;
					await adapter.doState(
						`${pfx}monthly.${type}.${month}`,
						value,
						`${name} (month ${month})`,
						"kWh",
						false,
					);
				}
			}
		}
	}
	await adapter.doState(`${pfx}period`, String(year), "Polled period", "", false);
	await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	await adapter.updateLastPoll(
		`_meinsenec.info.lastPoll.Measurements.year_${year}`,
		`Last year ${year} measurements poll`,
	);
}

/**
 * Poll AllTime measurements (slow tier).
 * Uses period=all to get lifetime yearly totals in a single request per type.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @returns {Promise<void>}
 */
async function webPollMeasurementsAllTime(adapter, pn) {
	adapter.log.debug("[Web] 🔄 Polling measurements: AllTime");
	const pfx = "_meinsenec.Measurements.AllTime.";
	const data = await webFetchAllTypes(adapter, pn, "all");
	for (const type of WEB_MEASUREMENT_TYPES) {
		if (data[type]) {
			await webWriteMeasurement(adapter, pfx, type, data[type], { yearly: true });
		}
	}
	await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	await adapter.updateLastPoll("_meinsenec.info.lastPoll.MeasurementsAllTime", "Last AllTime measurements poll");
}

/**
 * Poll autarky data from mein-senec.de (medium tier).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @returns {Promise<void>}
 */
async function webPollAutarky(adapter, pn) {
	adapter.log.debug("[Web] 🔄 Polling autarky");
	try {
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/status/getautarky.php?anlageNummer=${pn}`);
		if (res?.data && typeof res.data === "object") {
			const pfx = "_meinsenec.Autarky.";
			for (const key of ["day", "week", "month", "year", "all"]) {
				if (typeof res.data[key] === "number") {
					await adapter.doState(`${pfx}${key}`, res.data[key], `Autarky ${key}`, "%", false);
				}
			}
			await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
			await adapter.updateLastPoll("_meinsenec.info.lastPoll.Autarky", "Last autarky poll");
		}
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Autarky poll failed");
	}
}

/**
 * Update web queue diagnostics states (mirrors apiUpdateQueueStats pattern).
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webUpdateQueueStats(adapter) {
	if (!adapter.webQueue || typeof adapter.webQueue.getStats !== "function") {
		return;
	}

	const stats = adapter.webQueue.getStats();
	const pfx = "_meinsenec.diagnostics.queue.";

	await adapter.doState(`${pfx}currentConcurrency`, stats.concurrency, "Current queue concurrency", "", false);
	await adapter.doState(`${pfx}pendingRequests`, stats.pending, "Pending requests", "", false);
	await adapter.doState(`${pfx}activeRequests`, stats.active, "Active requests", "", false);
	await adapter.doState(`${pfx}totalRequests`, stats.total, "Total requests processed", "", false);
	await adapter.doState(`${pfx}successRate`, stats.successRate, "Success rate", "%", false);
	await adapter.doState(
		`${pfx}recommendedConcurrency`,
		stats.recommendedConcurrency,
		"Recommended concurrency",
		"",
		false,
	);
}

/**
 * Main web measurements poll entry point.
 * Called from webPoll() when web_measurements is enabled.
 * Handles tier-based scheduling for all measurement periods.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number
 * @returns {Promise<void>}
 */
async function webPollMeasurements(adapter, pn) {
	const now = Date.now();

	// Medium tier — today, yesterday, autarky
	if (
		!adapter._webLastMeasurementsMediumPoll ||
		now - adapter._webLastMeasurementsMediumPoll >= adapter.webMediumIntervalMs
	) {
		try {
			await webPollMeasurementsToday(adapter, pn);
			await webPollMeasurementsYesterday(adapter, pn);
			await webPollAutarky(adapter, pn);
			adapter._webLastMeasurementsMediumPoll = now;
		} catch (error) {
			adapter.logError(error, "[Web] ❌ Medium-tier measurements failed");
		}
	}

	// Slow tier — months, years, alltime
	if (
		!adapter._webLastMeasurementsSlowPoll ||
		now - adapter._webLastMeasurementsSlowPoll >= adapter.webSlowIntervalMs
	) {
		try {
			const utcNow = new Date();
			const currentYear = utcNow.getUTCFullYear();
			const currentMonthStart = new Date(Date.UTC(currentYear, utcNow.getUTCMonth(), 1));
			const lastMonthStart = new Date(Date.UTC(currentYear, utcNow.getUTCMonth() - 1, 1));

			await webPollMeasurementsMonth(adapter, pn, currentMonthStart, "current_month");
			await webPollMeasurementsMonth(adapter, pn, lastMonthStart, "previous_month");
			await webPollMeasurementsYear(adapter, pn, currentYear, "current_year");
			await webPollMeasurementsYear(adapter, pn, currentYear - 1, "previous_year");
			await webPollMeasurementsAllTime(adapter, pn);
			adapter._webLastMeasurementsSlowPoll = now;
			// Check for stale states after first slow poll completes
		} catch (error) {
			adapter.logError(error, "[Web] ❌ Slow-tier measurements failed");
		}
	}

	// Secondary plants — full poll when enabled (on slow tier cycle, non-blocking)
	try {
		if (
			adapter.webSecondaryPlants?.size > 0 &&
			(!adapter._webLastMeasurementsSlowPoll || now - adapter._webLastMeasurementsSlowPoll < 5000) // only run when slow tier just ran
		) {
			for (const [sn, plant] of adapter.webSecondaryPlants) {
				const pollState = await adapter.getStateAsync(`control.Plants.${sn}.poll`);
				if (!pollState?.val) {
					continue;
				}
				webPollSecondaryPlant(adapter, plant.anlageNummer, sn).catch((error) =>
					adapter.logError(error, `[Web] ❌ Secondary plant ${sn} poll failed`),
				);
			}
		}
	} catch (error) {
		adapter.logError(error, "[Web] ❌ Secondary plants check failed");
	}

	// Update queue diagnostics (gated by debug toggle)
	if (adapter.config.api_debug_states) {
		await webUpdateQueueStats(adapter);
	}
}

/**
 * Full measurement poll for a secondary plant.
 * Same tiers as master: today, yesterday, autarky, month, year, AllTime.
 * States written under _meinsenec.Plants.{sn}.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {number} pn - Plant number (anlageNummer)
 * @param {string} sn - Steuereinheitnummer (state key)
 */
async function webPollSecondaryPlant(adapter, pn, sn) {
	const base = `_meinsenec.Plants.${sn}.`;
	adapter.log.info(`[Web] 🔄 Polling secondary plant ${sn} (anlageNummer=${pn})`);

	// Today
	try {
		const data = await webFetchAllTypes(adapter, pn, "today");
		const pfx = `${base}Measurements.Daily.today.`;
		for (const type of WEB_MEASUREMENT_TYPES) {
			if (data[type]) {
				await webWriteMeasurement(adapter, pfx, type, data[type], { hourly: true });
			}
		}
		await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} today failed`);
	}

	// Yesterday
	try {
		const data = await webFetchAllTypes(adapter, pn, "yesterday");
		const pfx = `${base}Measurements.Daily.yesterday.`;
		for (const type of WEB_MEASUREMENT_TYPES) {
			if (data[type]) {
				await webWriteMeasurement(adapter, pfx, type, data[type], { hourly: true });
			}
		}
		await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} yesterday failed`);
	}

	// Autarky
	try {
		const res = await webGet(adapter, `${WEB_HOST}/endkunde/api/status/getautarky.php?anlageNummer=${pn}`);
		if (res?.data && typeof res.data === "object") {
			const pfx = `${base}Autarky.`;
			for (const key of ["day", "week", "month", "year", "all"]) {
				if (typeof res.data[key] === "number") {
					await adapter.doState(`${pfx}${key}`, res.data[key], `Autarky ${key}`, "%", false);
				}
			}
			await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
		}
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} autarky failed`);
	}

	// Current + previous month
	try {
		const utcNow = new Date();
		const curYear = utcNow.getUTCFullYear();
		const months = [
			{ start: new Date(Date.UTC(curYear, utcNow.getUTCMonth(), 1)), label: "current_month" },
			{ start: new Date(Date.UTC(curYear, utcNow.getUTCMonth() - 1, 1)), label: "previous_month" },
		];

		for (const m of months) {
			const pfx = `${base}Measurements.Monthly.${m.label}.`;
			let data;
			if (m.label === "current_month") {
				data = await webFetchAllTypes(adapter, pn, "month", { timestamp: m.start.getTime() });
			} else {
				const monthEnd = new Date(m.start.getUTCFullYear(), m.start.getUTCMonth() + 1, 0, 23, 59, 59);
				data = await webFetchAllTypes(adapter, pn, "range", {
					timestamp: monthEnd.getTime(),
					days: monthEnd.getDate(),
				});
			}
			for (const type of WEB_MEASUREMENT_TYPES) {
				if (data[type]) {
					await webWriteMeasurement(adapter, pfx, type, data[type], { daily: true });
				}
			}
			await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
		}
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} monthly failed`);
	}

	// Current + previous year
	try {
		const currentYear = new Date().getUTCFullYear();
		const years = [
			{ year: currentYear, label: "current_year" },
			{ year: currentYear - 1, label: "previous_year" },
		];

		for (const y of years) {
			const pfx = `${base}Measurements.Yearly.${y.year}.`;
			const now = new Date();
			const rangeEnd = y.label === "current_year" ? now : new Date(y.year, 11, 31, 23, 59, 59);
			const jan1 = new Date(y.year, 0, 1);
			const days = Math.ceil((rangeEnd.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));

			const data = await webFetchAllTypes(adapter, pn, "range", { timestamp: rangeEnd.getTime(), days });
			for (const type of WEB_MEASUREMENT_TYPES) {
				if (data[type]) {
					const name = WEB_MEASUREMENT_NAMES[type] || type;
					await adapter.doState(
						`${pfx}${type}`,
						data[type].fullkwh,
						`${name} (${y.year} total)`,
						"kWh",
						false,
					);
					if (data[type].val) {
						for (const [ts, value] of data[type].val) {
							const month = new Date(ts).getMonth() + 1;
							await adapter.doState(
								`${pfx}monthly.${type}.${month}`,
								value,
								`${name} (month ${month})`,
								"kWh",
								false,
							);
						}
					}
				}
			}
			await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
		}
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} yearly failed`);
	}

	// AllTime
	try {
		const pfx = `${base}Measurements.AllTime.`;
		const data = await webFetchAllTypes(adapter, pn, "all");
		for (const type of WEB_MEASUREMENT_TYPES) {
			if (data[type]) {
				await webWriteMeasurement(adapter, pfx, type, data[type], { yearly: true });
			}
		}
		await adapter.doState(`${pfx}lastUpdated`, new Date().toISOString(), "Last updated", "", false);
	} catch (error) {
		adapter.logError(error, `[Web] ❌ Secondary plant ${sn} AllTime failed`);
	}

	adapter.log.info(`[Web] ✅ Secondary plant ${sn} poll complete`);
}

/**
 * Delete all states under a given prefix.
 * Used for cleanup when features are disabled.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @param {string} prefix - State prefix to delete (e.g. "_meinsenec.diagnostics.queue.")
 * @param {string} label - Human-readable label for log messages
 * @returns {Promise<number>} Number of states deleted
 */
async function webCleanupStates(adapter, prefix, label) {
	const fullPrefix = `${adapter.namespace}.${prefix}`;
	const objects = await adapter.getAdapterObjectsAsync();
	let count = 0;
	for (const id of Object.keys(objects)) {
		if (id.startsWith(fullPrefix)) {
			try {
				await adapter.delObjectAsync(id);
				count++;
			} catch {
				// ignore
			}
		}
	}
	if (count > 0) {
		adapter.log.info(`[Web] Cleaned up ${count} ${label} states`);
	}
	return count;
}

/**
 * Run cleanup tasks on startup based on config.
 * Deletes states for disabled features.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function webStartupCleanup(adapter) {
	// Clean up queue diagnostics if debug states are disabled (both connectors)
	if (!adapter.config.api_debug_states) {
		await webCleanupStates(adapter, "_meinsenec.diagnostics.queue.", "web queue diagnostics");
		await webCleanupStates(adapter, "_api.diagnostics.queue.", "API queue diagnostics");
	}

	// Clean up detail states if detail is disabled
	if (!adapter.config.web_measurements_detail) {
		for (const period of ["today", "yesterday"]) {
			for (const type of WEB_MEASUREMENT_TYPES) {
				await webCleanupStates(
					adapter,
					`_meinsenec.Measurements.Daily.${period}.${type}.detail.`,
					`${period} ${type} detail`,
				);
			}
		}
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
	// Measurements
	webPollMeasurements,
	webFetchMeasurement,
	webFetchAllTypes,
	webWriteMeasurement,
	webPollMeasurementsToday,
	webPollMeasurementsYesterday,
	webPollMeasurementsMonth,
	webPollMeasurementsYear,
	webPollMeasurementsAllTime,
	webPollAutarky,
	webUpdateQueueStats,
	webCleanupStates,
	webStartupCleanup,
	// Pure helpers
	aggregateToHourly,
	aggregateToDaily,
	aggregateToMonthly,
};
