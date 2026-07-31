"use strict";
// Endpoint (SENEC.Connect):
//   https://apim-eds-gwc-prod.azure-api.net/senec-connect/v1/systems/device-data/general

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const axios = require("axios");
const { CONNECT_HOST } = require("./constants.js");

/**
 * Extract the server-provided reason from a failed SENEC.Connect request.
 *
 * The API documents application/problem+json (RFC 7807) bodies for 4xx/5xx, and Azure API
 * Management adds its own { statusCode, message } shape — notably when the monthly request
 * quota is exhausted. Axios reduces all of these to "Request failed with status code NNN",
 * so without this the actual reason is lost.
 *
 * @param {{ response?: { data?: string | Record<string, unknown> | null } }} error - axios error
 * @returns {string} Server-provided detail, or "" when the response carried none
 */
function connectErrorDetail(error) {
	const data = error?.response?.data;
	if (!data) {
		return "";
	}
	if (typeof data === "string") {
		return data.trim().slice(0, 300);
	}
	if (typeof data === "object") {
		// problem+json uses detail/title; Azure APIM uses message
		const detail = data.detail || data.title || data.message;
		return String(detail || JSON.stringify(data)).slice(0, 300);
	}
	return "";
}

/**
 * Polls the SENEC.Connect API for device data.
 * Uses subscription key authentication (Ocp-Apim-Subscription-Key header).
 * All requested data sections are fetched in a single request via the include parameter.
 *
 * @param {SenecAdapter} adapter - Senec adapter instance
 * @returns {Promise<void>}
 */
async function connectPoll(adapter) {
	if (adapter.unloaded) {
		return;
	}

	const interval = (adapter.config.connect_interval || 300) * 1000;
	const include = adapter.config.connect_include || "battery,meter";
	const subscriptionKey = adapter.config.connect_subscription_key;

	if (!subscriptionKey) {
		adapter.log.warn("[Connect] ⚠️ No subscription key configured. Skipping poll.");
		return;
	}

	try {
		const connectLog = adapter.config.connect_showPolling ? "info" : "debug";
		adapter.log[connectLog]("[Connect] 🔄 Polling SENEC.Connect API...");

		const url = `${CONNECT_HOST}/v1/systems/device-data/general?include=${encodeURIComponent(include)}`;
		if (!adapter.connectClient) {
			adapter.connectClient = axios.create({
				timeout: adapter.config.pollingTimeout || 5000,
				headers: {
					"Ocp-Apim-Subscription-Key": subscriptionKey,
				},
			});
		}
		const response = await adapter.connectClient.get(url);

		if (adapter.config.connect_reqnresp_log) {
			adapter.log.debug(`[Connect] SENEC.Connect response: ${JSON.stringify(response?.data).slice(0, 1000)}`);
		}
		if (response?.data && Array.isArray(response.data)) {
			for (let i = 0; i < response.data.length; i++) {
				await adapter.evalPoll(response.data[i], `_connect.Systems.${i}.`);
			}
			await adapter.doState(
				"_connect.info.lastPoll",
				new Date().toISOString(),
				"Last successful SENEC.Connect poll",
				"",
				false,
			);
			adapter.log[connectLog](`[Connect] Polled ${response.data.length} system(s)`);
			if (!adapter.connectConnected) {
				adapter.connectConnected = true;
				await adapter.updateConnectionStatus();
			}
		} else {
			adapter.log.warn(
				`[Connect] ⚠️ Unexpected response format: ${JSON.stringify(response?.data).slice(0, 200)}`,
			);
		}
	} catch (error) {
		adapter.logError(error, "[Connect] ❌ poll failed");
		const detail = connectErrorDetail(error);
		if (detail) {
			adapter.log.warn(`[Connect] ⚠️ Server response: ${detail}`);
		}
		if (adapter.connectConnected) {
			adapter.connectConnected = false;
			await adapter.updateConnectionStatus();
		}
	}

	if (!adapter.unloaded) {
		adapter.setTimeout(() => {
			connectPoll(adapter).catch((e) => adapter.logError(e, "[Connect] ❌ scheduled poll failed"));
		}, interval);
		adapter.log[adapter.config.connect_showPolling ? "info" : "debug"](
			`[Connect] ⏱ Next SENEC.Connect poll scheduled in ${(interval / 1000).toFixed(0)}s`,
		);
	}
}

module.exports = {
	connectPoll,
};
