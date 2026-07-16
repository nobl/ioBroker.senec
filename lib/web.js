"use strict";

const https = require("node:https");

/**
 * SENEC web extension for ioBroker.web
 *
 * This module is loaded by ioBroker.web (not by the senec adapter itself).
 * It registers SENEC-specific API endpoints and supplies a welcome page entry.
 * Static files from www/ are served by ioBroker.web's built-in adapter file handling.
 *
 * @param {object} server - Node.js http/https server instance
 * @param {object} webSettings - Web adapter settings (secure, port, etc.)
 * @param {object} adapter - The ioBroker.web adapter instance (NOT the senec adapter)
 * @param {object} instanceSettings - The senec adapter instance object (config in .native)
 * @param {object} app - Express application instance
 */
function SenecWeb(server, webSettings, adapter, instanceSettings, app) {
	this.app = app;
	this.config = instanceSettings ? instanceSettings.native : {};

	const senecIp = this.config.senecip;

	// HTTPS agent for SENEC device (self-signed cert)
	const agent = new https.Agent({ rejectUnauthorized: false });

	// Proxy endpoint: fetch appliance log for a given date
	app.get("/senec/api/log", (req, res) => {
		const date = req.query.date;
		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
		}

		if (!senecIp || senecIp === "0.0.0.0") {
			return res.status(503).json({ error: "No SENEC device IP configured in adapter settings." });
		}

		const [year, month, day] = date.split("-");
		const url = `https://${senecIp}//log/${year}/${month}/${day}.log`;

		const request = https.get(url, { agent, timeout: 10000 }, (response) => {
			if (response.statusCode !== 200) {
				return res.status(response.statusCode || 502).json({
					error: `SENEC device returned HTTP ${response.statusCode}`,
				});
			}

			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf-8");
				res.type("text/plain").send(raw);
			});
		});

		request.on("error", (err) => {
			adapter.log.warn(`[SENEC] Log proxy error for ${date}: ${err.message}`);
			res.status(502).json({ error: `Could not reach SENEC device: ${err.message}` });
		});

		request.on("timeout", () => {
			request.destroy();
			res.status(504).json({ error: "Request to SENEC device timed out." });
		});
	});

	adapter.log.info("[SENEC] Web extension loaded with API endpoint at /senec/api/log");

	/** Return welcome page entry for ioBroker.web landing page */
	this.welcomePage = function () {
		return {
			link: "senec/",
			name: "SENEC Dashboard",
			img: "adapter/senec/senec.png",
			color: "#00529c",
			order: 10,
		};
	};

	/** Called when the web extension is unloaded */
	this.unload = function () {
		return new Promise((resolve) => {
			if (app._router?.stack) {
				const before = app._router.stack.length;
				app._router.stack = app._router.stack.filter(
					(layer) => !(layer.route && layer.route.path === "/senec/api/log"),
				);
				if (app._router.stack.length < before) {
					adapter.log.info("[SENEC] Web extension unloaded");
				}
			}
			resolve(undefined);
		});
	};
}

module.exports = SenecWeb;
