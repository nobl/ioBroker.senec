"use strict";

/** @typedef {import('./types').SenecAdapter} SenecAdapter */ // eslint-disable-line jsdoc/check-tag-names

const axios = require("axios");
const { CONNECT_HOST } = require("./constants.js");

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
		adapter.log.warn("[Connect] No subscription key configured. Skipping poll.");
		return;
	}

	try {
		adapter.log.debug("🔄 Polling SENEC.Connect API...");

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

		adapter.log.debug(`SENEC.Connect response: ${JSON.stringify(response?.data).slice(0, 1000)}`);
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
			adapter.log.debug(`SENEC.Connect: polled ${response.data.length} system(s)`);
		} else {
			adapter.log.warn(`[Connect] Unexpected response format: ${JSON.stringify(response?.data).slice(0, 200)}`);
		}
	} catch (error) {
		adapter.logError(error, "[Connect] ❌ poll failed");
	}

	if (!adapter.unloaded) {
		adapter.setTimeout(() => {
			connectPoll(adapter).catch((e) => adapter.logError(e, "[Connect] ❌ scheduled poll failed"));
		}, interval);
		adapter.log.debug(`⏱ Next SENEC.Connect poll scheduled in ${(interval / 1000).toFixed(0)}s`);
	}
}

module.exports = {
	connectPoll,
};
