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

	// HTTPS agent for SENEC device (self-signed cert, limited concurrent connections)
	const agent = new https.Agent({ rejectUnauthorized: false, maxSockets: 3 });

	// Rate limiter: allow max 1 request per second per client
	const recentRequests = new Map();
	const RATE_LIMIT_MS = 1000;

	/**
	 * Safe response helper — catches writes to destroyed/finished responses.
	 *
	 * @param {object} res - Express response object
	 * @param {number} status - HTTP status code
	 * @param {object} body - JSON response body
	 */
	const safeJson = (res, status, body) => {
		try {
			if (!res.headersSent && !res.destroyed) {
				res.status(status).json(body);
			}
		} catch {
			// Response already closed — nothing to do
		}
	};
	/**
	 * Safe send helper — catches writes to destroyed/finished responses.
	 *
	 * @param {object} res - Express response object
	 * @param {string} type - Content type
	 * @param {string} data - Response body
	 */
	const safeSend = (res, type, data) => {
		try {
			if (!res.headersSent && !res.destroyed) {
				res.type(type).send(data);
			}
		} catch {
			// Response already closed — nothing to do
		}
	};

	// Proxy endpoint: fetch appliance log for a given date
	app.get("/senec/api/log", (req, res) => {
		const date = req.query.date;
		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			return safeJson(res, 400, { error: "Invalid date format. Use YYYY-MM-DD." });
		}

		if (!senecIp || senecIp === "0.0.0.0") {
			return safeJson(res, 503, { error: "No SENEC device IP configured in adapter settings." });
		}

		// Rate limit: reject rapid duplicate requests
		const clientKey = `${req.ip}_${date}`;
		const lastReq = recentRequests.get(clientKey);
		if (lastReq && Date.now() - lastReq < RATE_LIMIT_MS) {
			return safeJson(res, 429, { error: "Too many requests. Please wait." });
		}
		recentRequests.set(clientKey, Date.now());
		// Clean up old entries periodically
		if (recentRequests.size > 100) {
			const cutoff = Date.now() - RATE_LIMIT_MS * 10;
			for (const [k, v] of recentRequests) {
				if (v < cutoff) {
					recentRequests.delete(k);
				}
			}
		}

		const [year, month, day] = date.split("-");
		const url = `https://${senecIp}//log/${year}/${month}/${day}.log`;

		const request = https.get(url, { agent, timeout: 10000 }, (response) => {
			if (response.statusCode !== 200) {
				safeJson(res, response.statusCode || 502, {
					error: `SENEC device returned HTTP ${response.statusCode}`,
				});
				response.resume(); // drain the response
				return;
			}

			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				safeSend(res, "text/plain", Buffer.concat(chunks).toString("utf-8"));
			});
			response.on("error", () => {
				safeJson(res, 502, { error: "Connection to SENEC device interrupted." });
			});
		});

		// Abort upstream request if client disconnects
		res.on("close", () => {
			if (!res.writableFinished) {
				request.destroy();
			}
		});

		request.on("error", (err) => {
			adapter.log.warn(`[SENEC] Log proxy error for ${date}: ${err.message}`);
			safeJson(res, 502, { error: `Could not reach SENEC device: ${err.message}` });
		});

		request.on("timeout", () => {
			request.destroy();
			safeJson(res, 504, { error: "Request to SENEC device timed out." });
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
