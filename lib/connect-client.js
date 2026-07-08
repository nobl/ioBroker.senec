"use strict";
// Delegate module — functions receive `this` via .call(adapter, ...)
/* eslint-disable jsdoc/check-tag-names, jsdoc/reject-any-type */

const axios = require("axios");
const { CONNECT_HOST } = require("./constants.js");

/**
 * Polls the SENEC.Connect API for device data.
 * Uses subscription key authentication (Ocp-Apim-Subscription-Key header).
 * All requested data sections are fetched in a single request via the include parameter.
 *
 * @returns {Promise<void>}
 * @this {any}
 */
async function connectPoll() {
	if (this.unloaded) {
		return;
	}

	const interval = (this.config.connect_interval || 300) * 1000;
	const include = this.config.connect_include || "battery,meter";
	const subscriptionKey = this.config.connect_subscription_key;

	if (!subscriptionKey) {
		this.log.warn("SENEC.Connect: No subscription key configured. Skipping poll.");
		return;
	}

	try {
		this.log.debug("🔄 Polling SENEC.Connect API...");

		const url = `${CONNECT_HOST}/v1/systems/device-data/general?include=${encodeURIComponent(include)}`;
		if (!this.connectClient) {
			this.connectClient = axios.create({
				timeout: this.config.pollingTimeout || 5000,
				headers: {
					"Ocp-Apim-Subscription-Key": subscriptionKey,
				},
			});
		}
		const response = await this.connectClient.get(url);

		this.log.debug(`SENEC.Connect response: ${JSON.stringify(response?.data).slice(0, 1000)}`);
		if (response?.data && Array.isArray(response.data)) {
			for (let i = 0; i < response.data.length; i++) {
				await this.evalPoll(response.data[i], `_connect.Systems.${i}.`);
			}
			await this.doState(
				"_connect.info.lastPoll",
				new Date().toISOString(),
				"Last successful SENEC.Connect poll",
				"",
				false,
			);
			this.log.debug(`SENEC.Connect: polled ${response.data.length} system(s)`);
		} else {
			this.log.warn(`SENEC.Connect: unexpected response format: ${JSON.stringify(response?.data).slice(0, 200)}`);
		}
	} catch (error) {
		this.logError(error, "❌ SENEC.Connect poll failed");
	}

	if (!this.unloaded) {
		this.setTimeout(() => {
			this.connectPoll().catch((e) => this.logError(e, "❌ SENEC.Connect scheduled poll failed"));
		}, interval);
		this.log.debug(`⏱ Next SENEC.Connect poll scheduled in ${(interval / 1000).toFixed(0)}s`);
	}
}

module.exports = {
	connectPoll,
};
