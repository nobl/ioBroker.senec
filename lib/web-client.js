"use strict";
// Delegate module — functions receive `this` via .call(adapter, ...)
/* eslint-disable jsdoc/check-tag-names, jsdoc/reject-any-type */

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
 * @this {any}
 */
async function webInit() {
	const WEB_BASE = WEB_HOST;

	// Step 1: Web login
	this.webAuthenticated = await this.webLogin();
	if (!this.webAuthenticated) {
		this.log.warn("mein-senec.de: Web login failed. Check credentials.");
		return;
	}

	// Step 2: Discover customer + system
	let systemCount = 1;
	try {
		const custRes = await this.webGet(`${WEB_BASE}/endkunde/api/context/getEndkunde`);
		if (custRes?.data && typeof custRes.data === "object") {
			await this.evalPoll(custRes.data, "_meinsenec.Customer.");
			systemCount = custRes.data.anzahlAnlagen || 1;
			this.log.info(`mein-senec.de: Customer devNumber=${custRes.data.devNumber}, systems=${systemCount}`);
		}
	} catch (error) {
		this.logError(error, "mein-senec.de: Failed to get customer info");
	}

	// Iterate systems to find our master and discover abilities
	for (let plantNum = 0; plantNum < systemCount; plantNum++) {
		try {
			const sysRes = await this.webGet(
				`${WEB_BASE}/endkunde/api/context/getAnlageBasedNavigationViewModel?anlageNummer=${plantNum}`,
			);
			if (!sysRes?.data || typeof sysRes.data !== "object") {
				break;
			}
			const sys = sysRes.data;
			if (!sys.master) {
				continue;
			}

			this.webMasterPlantNumber = plantNum;
			this.log.info(`mein-senec.de: Found system ${plantNum}: ${sys.produktName} (${sys.steuereinheitnummer})`);

			// Store feature visibility flags
			this.webAbilities = {
				peakShaving: !!sys.peakShavingVisible,
				sockets: !!sys.steckdosenVisible,
				socketsEnabled: !!sys.steckdosenEnabled,
				sgReady: !!sys.sgReadyVisible,
				wallbox: !!sys.wallboxVisible,
				heatingRod: !!sys.heizstaebeVisible,
				autarky: !!sys.autarkieVisible,
				battery: !!sys.akkuVisible,
			};

			await this.evalPoll(sys, "_meinsenec.System.");
			for (const [key, val] of Object.entries(this.webAbilities)) {
				await this.doState(`_meinsenec.info.abilities.${key}`, val, `Feature: ${key}`, "", false);
			}

			this.log.info(`mein-senec.de: Abilities: ${JSON.stringify(this.webAbilities)}`);
			break;
		} catch (error) {
			this.logError(error, `mein-senec.de: Failed to get system ${plantNum}`);
			break;
		}
	}

	if (this.webMasterPlantNumber === null) {
		this.log.warn("mein-senec.de: No master system found.");
		return;
	}

	// Step 3: Create controls (if enabled) & start polling
	if (this.config.control_web_active) {
		await this.webCreateControls();
	}
	this.webConnected = true;
	this.webPoll().catch((e) => this.logError(e, "❌ mein-senec.de initial poll failed"));
}

/**
 * Shared mein-senec.de HTTP request with session-expiry re-auth.
 *
 * @param {"get" | "post"} method - HTTP method
 * @param {string} url - URL to request
 * @param {object} [data] - Optional JSON body (POST only)
 * @returns {Promise<object>} axios response
 * @this {any}
 */
async function _webRequest(method, url, data) {
	const label = method.toUpperCase();
	this.log.debug(`mein-senec.de ${label}: ${url}`);

	const baseConfig = { jar: this.webJar, maxRedirects: 5 };
	const headers = method === "post" && data !== undefined ? { "Content-Type": "application/json" } : undefined;
	const config = { ...baseConfig, validateStatus: () => true, ...(headers ? { headers } : {}) };

	const res =
		method === "get" ? await this.authClient.get(url, config) : await this.authClient.post(url, data, config);

	if (this.config.api_reqnresp_log) {
		this.log.debug(`mein-senec.de ${label} response: HTTP ${res.status} → ${JSON.stringify(res.data)}`);
	} else {
		this.log.debug(`mein-senec.de ${label} response: HTTP ${res.status}`);
	}

	if (res.status === 200 && typeof res.data === "string" && res.data.includes("Login - SENEC")) {
		this.log.debug("mein-senec.de: Session expired, re-authenticating...");
		this.webAuthenticated = await this.webLogin();
		if (!this.webAuthenticated) {
			throw new Error("mein-senec.de re-authentication failed");
		}
		return method === "get" ? this.authClient.get(url, baseConfig) : this.authClient.post(url, data, baseConfig);
	}
	return res;
}

/**
 * GET request to mein-senec.de with auto re-auth on session expiry.
 *
 * @param {string} url - URL to request
 * @returns {Promise<object>} axios response
 * @this {any}
 */
async function webGet(url) {
	return this._webRequest("get", url);
}

/**
 * POST request to mein-senec.de with auto re-auth on session expiry.
 *
 * @param {string} url - URL to request
 * @param {object} [data] - Optional JSON body
 * @returns {Promise<object>} axios response
 * @this {any}
 */
async function webPost(url, data) {
	return this._webRequest("post", url, data);
}

/**
 * Poll mein-senec.de for status, spare capacity, peak shaving, SG-Ready.
 * Self-scheduling poll loop.
 *
 * @this {any}
 */
async function webPoll() {
	if (this.unloaded || !this.webConnected || this.webMasterPlantNumber === null) {
		return;
	}

	const WEB_BASE = WEB_HOST;
	const pn = this.webMasterPlantNumber;
	const now = Date.now();

	try {
		this.log.debug("🔄 Polling mein-senec.de...");

		// Status overview — every poll
		try {
			const res = await this.webGet(`${WEB_BASE}/endkunde/api/status/getstatusoverview.php?anlageNummer=${pn}`);
			if (res?.data && typeof res.data === "object") {
				await this.evalPoll(res.data, "_meinsenec.Status.");
				await this.updateLastPoll("_meinsenec.info.lastPoll.Status", "Last status poll");
			}
		} catch (error) {
			this.logError(error, "mein-senec.de: Status poll failed");
		}

		// Emergency power reserve — every 6h
		if (!this._webLastEmergencyPowerPoll || now - this._webLastEmergencyPowerPoll >= this.webMediumIntervalMs) {
			try {
				const res = await this.webGet(`${WEB_BASE}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`);
				if (res?.data !== undefined) {
					const val = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
					if (!isNaN(val)) {
						await this.doState(
							"_meinsenec.EmergencyPower.ReserveInPercent",
							val,
							"Emergency power reserve",
							"%",
							false,
						);
						this._webLastEmergencyPowerPoll = now;
						await this.updateLastPoll(
							"_meinsenec.info.lastPoll.EmergencyPower",
							"Last emergency power poll",
						);
						// Sync control datapoint
						await this.setStateChangedAsync("control.EmergencyPower.ReserveInPercent", {
							val: val,
							ack: true,
						});
					}
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: Emergency power poll failed");
			}
		}

		// Peak shaving — daily
		if (
			this.webAbilities.peakShaving &&
			(!this._webLastPeakShavingPoll || now - this._webLastPeakShavingPoll >= this.webSlowIntervalMs)
		) {
			try {
				const res = await this.webGet(`${WEB_BASE}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`);
				if (res?.data && typeof res.data === "object") {
					await this.evalPoll(res.data, "_meinsenec.PeakShaving.");
					this._webLastPeakShavingPoll = now;
					await this.updateLastPoll("_meinsenec.info.lastPoll.PeakShaving", "Last peak shaving poll");
					await this.webSyncPeakShavingControls(res.data);
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: Peak shaving poll failed");
			}
		}

		// SG-Ready state — every 6h
		if (
			this.webAbilities.sgReady &&
			(!this._webLastSgReadyStatePoll || now - this._webLastSgReadyStatePoll >= this.webMediumIntervalMs)
		) {
			try {
				const res = await this.webGet(`${WEB_BASE}/endkunde/api/senec/${pn}/sgready/state`);
				if (res?.data !== undefined) {
					await this.doState("_meinsenec.SGReady.State", String(res.data), "SG-Ready state", "", false);
					this._webLastSgReadyStatePoll = now;
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: SG-Ready state poll failed");
			}
		}

		// SG-Ready config — daily
		if (
			this.webAbilities.sgReady &&
			(!this._webLastSgReadyConfPoll || now - this._webLastSgReadyConfPoll >= this.webSlowIntervalMs)
		) {
			try {
				const res = await this.webGet(`${WEB_BASE}/endkunde/api/senec/${pn}/sgready/config`);
				if (res?.data && typeof res.data === "object") {
					await this.evalPoll(res.data, "_meinsenec.SGReady.Config.");
					this._webLastSgReadyConfPoll = now;
					await this.updateLastPoll("_meinsenec.info.lastPoll.SGReadyConfig", "Last SG-Ready config poll");
					await this.webSyncSGReadyControls(res.data);
				}
			} catch (error) {
				this.logError(error, "mein-senec.de: SG-Ready config poll failed");
			}
		}
	} catch (error) {
		this.logError(error, "❌ mein-senec.de poll cycle failed");
	}

	// Sockets via mein-senec.de — every 6h
	if (
		(this.webAbilities.sockets || this.config.control_sockets_force) &&
		(!this._webLastSocketsPoll || now - this._webLastSocketsPoll >= this.webMediumIntervalMs)
	) {
		try {
			const res = await this.webGet(`${WEB_BASE}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`);
			if (res?.data && Array.isArray(res.data)) {
				this.webSocketData = res.data;
				if (
					this.config.control_web_active &&
					this.config.control_sockets_connector === "web" &&
					res.data.length > 0
				) {
					await this.webCreateSocketControls(res.data.length);
				}
				for (const socket of res.data) {
					const idx = socket.steckdosenummer ?? socket.steckdosennummer;
					if (idx === undefined) {
						continue;
					}
					// Strip steuereinheit metadata before evalPoll (same for all sockets)
					const { steuereinheit: _s, state: socketState, ...socketFields } = socket;
					await this.evalPoll(socketFields, `_meinsenec.Sockets.${idx}.`);
					if (socketState && typeof socketState === "object") {
						const { steuereinheit: _ss, ...stateFields } = socketState;
						await this.evalPoll(stateFields, `_meinsenec.Sockets.${idx}.State.`);
					}
					if (this.config.control_sockets_connector === "web") {
						await this.webSyncSocketControls(idx, socket);
					}
				}
				this._webLastSocketsPoll = now;
				await this.updateLastPoll("_meinsenec.info.lastPoll.Sockets", "Last sockets poll");
			}
		} catch (error) {
			this.logError(error, "mein-senec.de: Sockets poll failed");
		}
	}

	if (!this.unloaded) {
		this.setTimeout(() => {
			this.webPoll().catch((e) => this.logError(e, "❌ mein-senec.de scheduled poll failed"));
		}, this.webStatusIntervalMs);
		this.log.debug(`⏱ Next mein-senec.de poll in ${(this.webStatusIntervalMs / 1000).toFixed(0)}s`);
	}
}

/**
 * Create control datapoints for mein-senec.de features based on discovered abilities.
 * Called once after webInit() discovers the system and its abilities.
 *
 * @this {any}
 */
async function webCreateControls() {
	// Emergency power reserve — always available
	await this.setObjectNotExistsAsync("control.EmergencyPower", {
		type: "channel",
		common: { name: "Emergency Power Reserve" },
		native: {},
	});
	await this.setObjectNotExistsAsync("control.EmergencyPower.ReserveInPercent", {
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
	if (this.webAbilities.peakShaving) {
		await this.setObjectNotExistsAsync("control.PeakShaving", {
			type: "channel",
			common: { name: "Peak Shaving" },
			native: {},
		});
		await this.setObjectNotExistsAsync("control.PeakShaving.Mode", {
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
		await this.setObjectNotExistsAsync("control.PeakShaving.CapacityLimit", {
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
		await this.setObjectNotExistsAsync("control.PeakShaving.EndHour", {
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
		await this.setObjectNotExistsAsync("control.PeakShaving.EndMinute", {
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
		await this.setObjectNotExistsAsync("control.PeakShaving.Apply", {
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
	if (this.webAbilities.sgReady) {
		await this.setObjectNotExistsAsync("control.SGReady", {
			type: "channel",
			common: { name: "SG-Ready" },
			native: {},
		});
		await this.setObjectNotExistsAsync("control.SGReady.Enabled", {
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
			await this.setObjectNotExistsAsync(`control.SGReady.${s.id}`, {
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
		await this.setObjectNotExistsAsync("control.SGReady.Apply", {
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

	await this.subscribeStatesAsync("control.EmergencyPower.*");
	if (this.webAbilities.peakShaving) {
		await this.subscribeStatesAsync("control.PeakShaving.*");
	}
	if (this.webAbilities.sgReady) {
		await this.subscribeStatesAsync("control.SGReady.*");
	}
	this.log.info(
		`mein-senec.de: Created web controls (peakShaving=${this.webAbilities.peakShaving}, sgReady=${this.webAbilities.sgReady})`,
	);
}

/**
 * Create web socket control datapoints after first socket poll.
 * Called when sockets are discovered and connector is set to "web".
 *
 * @param {number} count - Number of sockets
 * @this {any}
 */
async function webCreateSocketControls(count) {
	if (this.webSocketControlsCreated) {
		return;
	}
	for (let i = 0; i < count; i++) {
		await this.createSocketControlsForIndex(i);
	}
	await this.subscribeStatesAsync("control.Sockets.*");
	this.webSocketControlsCreated = true;
	this.log.info(`mein-senec.de: Created web socket controls for ${count} socket(s)`);
}

/**
 * Handle a mein-senec.de control command.
 *
 * @param {string} subId - The control ID (e.g. "EmergencyPower.ReserveInPercent")
 * @param {object} state - The ioBroker state object
 * @this {any}
 */
async function webHandleControl(subId, state) {
	const pn = this.webMasterPlantNumber;
	if (pn === null || pn === undefined) {
		this.log.warn("mein-senec.de: No master plant number, cannot send control command");
		return;
	}

	// Emergency power — direct send (single field, no Apply needed)
	if (subId === "EmergencyPower.ReserveInPercent") {
		const val = Math.round(Math.max(0, Math.min(100, Number(state.val) || 0)));
		this.log.info(`mein-senec.de: Setting emergency power reserve to ${val}%`);
		try {
			const postRes = await this.webPost(
				`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower?reserve-in-percent=${val}`,
			);
			if (postRes.status >= 400) {
				const errMsg = webApiErrorMsg(postRes);
				this.log.error(`mein-senec.de: Emergency power save failed (HTTP ${postRes.status}): ${errMsg}`);
				return;
			}
			// Re-read and sync back
			const res = await this.webGet(`${WEB_HOST}/endkunde/api/senec/${pn}/emergencypower/reserve-in-percent`);
			if (res?.data !== undefined) {
				const confirmed = typeof res.data === "number" ? res.data : parseInt(String(res.data), 10);
				if (!isNaN(confirmed)) {
					await this.doState(
						"_meinsenec.EmergencyPower.ReserveInPercent",
						confirmed,
						"Emergency power reserve",
						"%",
						false,
					);
					await this.setStateAsync("control.EmergencyPower.ReserveInPercent", {
						val: confirmed,
						ack: true,
					});
				}
			}
			this.log.info(`mein-senec.de: Emergency power reserve set to ${val}%`);
		} catch (error) {
			this.logError(error, "mein-senec.de: Failed to set emergency power reserve");
		}
		return;
	}

	// Peak shaving — Apply button
	if (subId === "PeakShaving.Apply" && state.val) {
		await this.webHandlePeakShavingApply();
		return;
	}
	// Peak shaving field changes — just ack locally, wait for Apply
	if (subId.startsWith("PeakShaving.")) {
		return;
	}

	// SG-Ready — Apply button
	if (subId === "SGReady.Apply" && state.val) {
		await this.webHandleSGReadyApply();
		return;
	}
	// SG-Ready field changes — just ack locally, wait for Apply
	if (subId.startsWith("SGReady.")) {
		return;
	}

	this.log.warn(`mein-senec.de: Unknown web control: ${subId}`);
}

/**
 * Apply pending peak shaving changes to mein-senec.de.
 *
 * @this {any}
 */
async function webHandlePeakShavingApply() {
	const pn = this.webMasterPlantNumber;
	const pfx = "control.PeakShaving";

	const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
	const capState = await this.getStateAsync(`${this.namespace}.${pfx}.CapacityLimit`);
	const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EndHour`);
	const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EndMinute`);

	const mode = String(modeState?.val || "").toUpperCase();
	const capacityLimit = Math.max(0, Math.min(90, Number(capState?.val) || 0));
	const endHour = Math.max(0, Math.min(23, Number(hourState?.val) || 0));
	const endMinute = Math.max(0, Math.min(59, Number(minuteState?.val) || 0));

	if (!mode) {
		this.log.warn("mein-senec.de: Peak shaving mode is empty, not applying");
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
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

	this.log.info(
		`mein-senec.de: Applying peak shaving settings (mode=${mode}, cap=${capacityLimit}%, end=${endHour}:${String(endMinute).padStart(2, "0")})`,
	);
	try {
		const postRes = await this.webPost(`${WEB_HOST}/endkunde/api/peakshaving/saveSettings?${params.toString()}`);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			this.log.error(`mein-senec.de: Peak shaving save failed (HTTP ${postRes.status}): ${errMsg}`);
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await this.webGet(`${WEB_HOST}/endkunde/api/peakshaving/getSettings?anlageNummer=${pn}`);
		if (res?.data && typeof res.data === "object") {
			await this.evalPoll(res.data, "_meinsenec.PeakShaving.");
			await this.webSyncPeakShavingControls(res.data);
		}
		this.log.info("mein-senec.de: Peak shaving settings applied");
	} catch (error) {
		this.logError(error, "mein-senec.de: Failed to apply peak shaving settings");
	}
	await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Sync peak shaving control datapoints with values read from the portal.
 *
 * @param {object} data - Peak shaving settings from the API
 * @this {any}
 */
async function webSyncPeakShavingControls(data) {
	const pfx = "control.PeakShaving";
	if (data.peakShavingMode !== undefined) {
		await this.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.peakShavingMode), ack: true });
	}
	if (data.peakShavingCapacityLimitInPercent !== undefined) {
		await this.setStateChangedAsync(`${pfx}.CapacityLimit`, {
			val: Number(data.peakShavingCapacityLimitInPercent),
			ack: true,
		});
	}
	if (Array.isArray(data.peakShavingLocalEndTime) && data.peakShavingLocalEndTime.length >= 2) {
		await this.setStateChangedAsync(`${pfx}.EndHour`, {
			val: Number(data.peakShavingLocalEndTime[0]) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.EndMinute`, {
			val: Number(data.peakShavingLocalEndTime[1]) || 0,
			ack: true,
		});
	}
}

/**
 * Apply pending SG-Ready changes to mein-senec.de.
 *
 * @this {any}
 */
async function webHandleSGReadyApply() {
	const pn = this.webMasterPlantNumber;
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
		const s = await this.getStateAsync(`${this.namespace}.${pfx}.${stateKey}`);
		if (!s || s.ack) {
			continue; // Skip unchanged fields
		}
		body[apiKey] = s.val;
	}

	if (Object.keys(body).length === 0) {
		this.log.debug("mein-senec.de: SG-Ready — no pending changes to apply");
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
		return;
	}

	this.log.info(`mein-senec.de: Applying SG-Ready settings: ${JSON.stringify(body)}`);
	try {
		const postRes = await this.webPost(`${WEB_HOST}/endkunde/api/senec/${pn}/sgready`, body);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			this.log.error(`mein-senec.de: SG-Ready save failed (HTTP ${postRes.status}): ${errMsg}`);
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await this.webGet(`${WEB_HOST}/endkunde/api/senec/${pn}/sgready/config`);
		if (res?.data && typeof res.data === "object") {
			await this.evalPoll(res.data, "_meinsenec.SGReady.Config.");
			await this.webSyncSGReadyControls(res.data);
		}
		this.log.info("mein-senec.de: SG-Ready settings applied");
	} catch (error) {
		this.logError(error, "mein-senec.de: Failed to apply SG-Ready settings");
	}
	await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Sync SG-Ready control datapoints with values read from the portal.
 *
 * @param {object} data - SG-Ready config from the API
 * @this {any}
 */
async function webSyncSGReadyControls(data) {
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
			await this.setStateChangedAsync(`${pfx}.${mapping.field}`, { val: data[apiKey], ack: true });
		}
	}
}

/**
 * Sync web socket control datapoints with values read from the portal.
 *
 * @param {number} idx - Socket index
 * @param {object} data - Socket data from the API
 * @this {any}
 */
async function webSyncSocketControls(idx, data) {
	if (!this.webSocketControlsCreated) {
		return;
	}
	const pfx = `control.Sockets.${idx}`;
	if (data.name !== undefined) {
		await this.setStateChangedAsync(`${pfx}.Name`, { val: String(data.name), ack: true });
	}
	if (data.mode !== undefined) {
		await this.setStateChangedAsync(`${pfx}.Mode`, { val: String(data.mode), ack: true });
	}
	if (data.einschaltschwelleInWatt !== undefined) {
		await this.setStateChangedAsync(`${pfx}.EinschaltschwelleInWatt`, {
			val: Number(data.einschaltschwelleInWatt),
			ack: true,
		});
	}
	if (data.abschaltschwelleInWatt !== undefined) {
		await this.setStateChangedAsync(`${pfx}.AbschaltschwelleInWatt`, {
			val: Number(data.abschaltschwelleInWatt),
			ack: true,
		});
	}
	if (data.dauerLeistungsueberschussInMin !== undefined) {
		await this.setStateChangedAsync(`${pfx}.DauerLeistungsueberschussInMin`, {
			val: Number(data.dauerLeistungsueberschussInMin),
			ack: true,
		});
	}
	if (data.dauerSteckdoseAnInMin !== undefined) {
		await this.setStateChangedAsync(`${pfx}.DauerSteckdoseAnInMin`, {
			val: Number(data.dauerSteckdoseAnInMin),
			ack: true,
		});
	}
	if (Array.isArray(data.einschaltzeit) && data.einschaltzeit.length >= 2) {
		await this.setStateChangedAsync(`${pfx}.EinschaltHour`, {
			val: Number(data.einschaltzeit[0]) || 0,
			ack: true,
		});
		await this.setStateChangedAsync(`${pfx}.EinschaltMinute`, {
			val: Number(data.einschaltzeit[1]) || 0,
			ack: true,
		});
	}
}

/**
 * Handle a web socket control command (Apply button).
 *
 * @param {number} idx - Socket index
 * @param {string} field - Field name (e.g. "Apply", "Mode")
 * @param {object} state - ioBroker state object
 * @returns {Promise<void>}
 * @this {any}
 */
async function webHandleSocketControl(idx, field, state) {
	// Only act on Apply button
	if (field !== "Apply" || !state.val) {
		return;
	}

	if (!this.webSocketData || !Array.isArray(this.webSocketData)) {
		this.log.warn("mein-senec.de: No socket data available, cannot apply changes");
		await this.setStateAsync(`control.Sockets.${idx}.Apply`, { val: false, ack: true });
		return;
	}

	const pn = this.webMasterPlantNumber;
	const pfx = `control.Sockets.${idx}`;

	// Read current control values
	const nameState = await this.getStateAsync(`${this.namespace}.${pfx}.Name`);
	const modeState = await this.getStateAsync(`${this.namespace}.${pfx}.Mode`);
	const onThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltschwelleInWatt`);
	const offThreshState = await this.getStateAsync(`${this.namespace}.${pfx}.AbschaltschwelleInWatt`);
	const surplusDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerLeistungsueberschussInMin`);
	const socketDurState = await this.getStateAsync(`${this.namespace}.${pfx}.DauerSteckdoseAnInMin`);
	const hourState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltHour`);
	const minuteState = await this.getStateAsync(`${this.namespace}.${pfx}.EinschaltMinute`);

	// Clone the full socket array and update the target socket
	const payload = JSON.parse(JSON.stringify(this.webSocketData));
	const socket = payload.find((s) => (s.steckdosenummer ?? s.steckdosennummer) === idx);
	if (!socket) {
		this.log.warn(`mein-senec.de: Socket ${idx} not found in stored data`);
		await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
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

	this.log.info(`mein-senec.de: Applying socket ${idx} settings (mode=${socket.mode})`);
	try {
		const postRes = await this.webPost(`${WEB_HOST}/endkunde/api/steckdosen/save`, payload);
		if (postRes.status >= 400) {
			const errMsg = webApiErrorMsg(postRes);
			this.log.error(`mein-senec.de: Socket save failed (HTTP ${postRes.status}): ${errMsg}`);
			await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
			return;
		}

		// Re-read and sync back
		const res = await this.webGet(`${WEB_HOST}/endkunde/api/steckdosen/findByGeraetenummer?anlageNummer=${pn}`);
		if (res?.data && Array.isArray(res.data)) {
			this.webSocketData = res.data;
			for (const s of res.data) {
				const sIdx = s.steckdosenummer ?? s.steckdosennummer;
				if (sIdx === undefined) {
					continue;
				}
				const { steuereinheit: _se, state: sState, ...sFields } = s;
				await this.evalPoll(sFields, `_meinsenec.Sockets.${sIdx}.`);
				if (sState && typeof sState === "object") {
					const { steuereinheit: _sse, ...sStateFields } = sState;
					await this.evalPoll(sStateFields, `_meinsenec.Sockets.${sIdx}.State.`);
				}
				await this.webSyncSocketControls(sIdx, s);
			}
		}
		this.log.info(`mein-senec.de: Socket ${idx} settings applied`);
	} catch (error) {
		this.logError(error, "mein-senec.de: Failed to apply socket settings");
	}
	await this.setStateAsync(`${pfx}.Apply`, { val: false, ack: true });
}

/**
 * Perform web login to mein-senec.de via Keycloak SSO.
 * Uses a dedicated cookie jar (webJar) separate from the App API jar.
 *
 * @param {{ extractFormAction: (html: string) => string|null, hasOtp: (html: string) => boolean, hasUsername: (html: string) => boolean, hasPassword: (html: string) => boolean, generateTOTP: (secret: string) => string }} deps - Helper functions
 * @returns {Promise<boolean>} true if login succeeded
 * @this {any}
 */
async function webLogin(deps) {
	const { extractFormAction, hasOtp, hasUsername, hasPassword, generateTOTP } = deps;
	const WEB_BASE = WEB_HOST;
	const email = this.config.api_mail;
	const password = this.config.api_pwd;

	if (!email || !password) {
		this.log.warn("mein-senec.de: No credentials configured (api_mail/api_pwd).");
		return false;
	}

	this.webJar = new CookieJar();

	try {
		// Step 1: GET mein-senec.de → follows redirects to SSO login form
		this.log.info("🔐 mein-senec.de: Requesting login page...");
		const pageRes = await this.authClient.get(WEB_BASE, {
			jar: this.webJar,
			maxRedirects: 10,
			validateStatus: () => true,
		});

		const html = typeof pageRes.data === "string" ? pageRes.data : "";
		const formAction = extractFormAction(html);

		if (!formAction) {
			// Maybe already authenticated?
			if (html.includes("ng-controller") || html.includes("endkunde")) {
				this.log.info("mein-senec.de: Already authenticated (no login form found).");
				return true;
			}
			this.log.warn("mein-senec.de: Could not find login form action URL.");
			this.log.debug(`🔍 Login page HTML (first 500 chars): ${html.slice(0, 500)}`);
			return false;
		}

		this.log.info("🔐 mein-senec.de: Found login form, posting credentials...");

		// Step 2: POST credentials to SSO form
		const loginRes = await this.authClient.post(
			formAction.replace(/&amp;/g, "&"),
			new URLSearchParams({ username: email, password: password }).toString(),
			{
				jar: this.webJar,
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
			const totpSecret = this.config.api_totp_secret;
			if (!totpSecret) {
				this.log.warn("mein-senec.de: TOTP required but no TOTP secret configured.");
				return false;
			}

			const otpFormAction = extractFormAction(loginHtml);
			if (!otpFormAction) {
				this.log.warn("mein-senec.de: TOTP form found but no action URL.");
				return false;
			}

			const totpCode = generateTOTP(totpSecret);
			this.log.info("🔐 mein-senec.de: Submitting TOTP code...");

			const otpRes = await this.authClient.post(
				otpFormAction.replace(/&amp;/g, "&"),
				new URLSearchParams({ otp: totpCode }).toString(),
				{
					jar: this.webJar,
					maxRedirects: 10,
					validateStatus: () => true,
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
				},
			);

			const otpHtml = typeof otpRes.data === "string" ? otpRes.data : "";
			if (otpHtml.includes("Login - SENEC") || extractFormAction(otpHtml)) {
				this.log.warn("mein-senec.de: TOTP login failed — still on login page.");
				return false;
			}
		} else if (loginHtml.includes("Login - SENEC") || (hasUsername(loginHtml) && hasPassword(loginHtml))) {
			this.log.warn("mein-senec.de: Login failed — still on login page. Check credentials.");
			return false;
		}

		// Step 4: Verify we're authenticated
		this.log.info("mein-senec.de: Login flow complete. Verifying session...");
		const verifyRes = await this.authClient.get(`${WEB_BASE}/endkunde/api/context/getEndkunde`, {
			jar: this.webJar,
			maxRedirects: 0,
			validateStatus: () => true,
		});

		if (verifyRes.status === 200 && typeof verifyRes.data === "object") {
			this.log.info(`✅ mein-senec.de: Authenticated successfully! devNumber: ${verifyRes.data.devNumber}`);
			return true;
		}

		this.log.warn(`mein-senec.de: Verification failed — HTTP ${verifyRes.status}`);
		return false;
	} catch (error) {
		this.log.warn(`mein-senec.de: Login error — ${error.message}`);
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
