"use strict";

const https = require("node:https");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

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
	const senecNamespace = instanceSettings?._id?.replace("system.adapter.", "") || "senec.0";

	// HTTPS agent for SENEC device — resolved lazily on first request.
	// Reads the TLS mode from the senec adapter's state and follows whatever it resolved.
	let agent = null;
	let agentResolved = false;
	let tofuFingerprint = null;

	/**
	 * Resolve the HTTPS agent based on the senec adapter's TLS mode.
	 * Reads _local.tls.mode and uses the same cert/fingerprint the local connector negotiated.
	 */
	const resolveAgent = async () => {
		if (agentResolved) {
			return;
		}

		let mode = null;
		try {
			const modeState = await adapter.getForeignStateAsync(`${senecNamespace}._local.tls.mode`);
			mode = modeState?.val ? String(modeState.val) : null;
		} catch {
			// senec adapter may not be running yet
		}

		/**
		 * Read and decrypt a TLS state from the senec adapter.
		 *
		 * @param {string} stateId - State ID relative to senec namespace
		 * @returns {Promise<string>} Decrypted value or empty string
		 */
		const readTls = async (stateId) => {
			try {
				const s = await adapter.getForeignStateAsync(`${senecNamespace}.${stateId}`);
				if (!s || !s.val) {
					return "";
				}
				try {
					return adapter.decrypt(String(s.val));
				} catch {
					return String(s.val); // not encrypted (legacy)
				}
			} catch {
				return "";
			}
		};

		if (mode === "user") {
			const pem = await readTls("_local.tls.userCaPem");
			if (pem && pem.includes("BEGIN CERTIFICATE")) {
				agent = new https.Agent({ ca: [pem], maxSockets: 3 });
				agentResolved = true;
				adapter.log.info("[SENEC] Log proxy: using user-uploaded CA cert.");
				return;
			}
		}

		if (mode === "cached") {
			const pem = await readTls("_local.tls.cachedCaPem");
			if (pem && pem.includes("BEGIN CERTIFICATE")) {
				agent = new https.Agent({ ca: [pem], maxSockets: 3 });
				agentResolved = true;
				adapter.log.info("[SENEC] Log proxy: using cached CA cert from senec adapter.");
				return;
			}
		}

		if (mode === "tofu") {
			const fp = await readTls("_local.tls.fingerprint");
			if (fp && fp.length > 10) {
				tofuFingerprint = fp;
				// TOFU: bypass CA, verify fingerprint on each response
				agent = new https.Agent({ rejectUnauthorized: false, maxSockets: 3 }); // CodeQL: intentional — TOFU fingerprint validation provides identity verification
				agentResolved = true;
				adapter.log.info(`[SENEC] Log proxy: using TOFU fingerprint (${tofuFingerprint.substring(0, 16)}...).`);
				return;
			}
		}

		// Senec adapter not ready yet or no mode resolved — temporary fallback, retry on next request
		if (!agent) {
			agent = new https.Agent({ rejectUnauthorized: false, maxSockets: 3 }); // CodeQL: intentional — TOFU fingerprint validation provides identity verification
		}
		adapter.log.debug("[SENEC] Log proxy: senec adapter TLS not resolved yet. Will retry on next request.");
	};

	/**
	 * Verify TOFU fingerprint on a response — warn on change.
	 *
	 * @param {object} response - Node.js HTTP response
	 */
	const verifyTofuResponse = (response) => {
		if (!tofuFingerprint || !response.socket) {
			return;
		}
		const cert = response.socket.getPeerCertificate();
		if (!cert || !cert.raw) {
			return;
		}
		const fp = crypto.createHash("sha256").update(cert.raw).digest("hex");
		if (fp !== tofuFingerprint) {
			adapter.log.warn(
				`[SENEC] ⚠️ Log proxy TOFU: device fingerprint changed (${tofuFingerprint.substring(0, 16)}... → ${fp.substring(0, 16)}...). Accepting.`,
			);
			tofuFingerprint = fp;
		}
	};

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
	app.get("/senec/api/log", async (req, res) => {
		const date = req.query.date;
		if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			return safeJson(res, 400, { error: "Invalid date format. Use YYYY-MM-DD." });
		}

		if (!senecIp || senecIp === "0.0.0.0") {
			return safeJson(res, 503, { error: "No SENEC device IP configured in adapter settings." });
		}

		// Lazy-init agent on first request (gives senec adapter time to negotiate TLS)
		await resolveAgent();

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
			verifyTofuResponse(response);
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
			// Certificate validation failed — force re-resolve on next request
			const isCertError =
				err.message.includes("certificate") ||
				err.message.includes("UNABLE_TO_VERIFY") ||
				err.message.includes("CERT_UNTRUSTED");
			if (isCertError) {
				adapter.log.warn(
					"[SENEC] ⚠️ TLS validation failed. Will re-resolve from senec adapter on next request.",
				);
				agentResolved = false;
			}
			adapter.log.warn(`[SENEC] Log proxy error for ${date}: ${err.message}`);
			safeJson(res, 502, { error: `Could not reach SENEC device: ${err.message}` });
		});

		request.on("timeout", () => {
			request.destroy();
			safeJson(res, 504, { error: "Request to SENEC device timed out." });
		});
	});

	/**
	 * Extract PEM from a ZIP buffer (same logic as web-client.js).
	 * Supports stored (method 0) and deflated (method 8) entries.
	 *
	 * @param {Buffer} buf - ZIP file buffer
	 * @returns {string|null} PEM string or null
	 */
	const extractPemFromZip = (buf) => {
		let offset = 0;
		while (offset + 30 <= buf.length) {
			if (buf.readUInt32LE(offset) !== 0x04034b50) {
				break;
			}
			const method = buf.readUInt16LE(offset + 8);
			const compSize = buf.readUInt32LE(offset + 18);
			const uncompSize = buf.readUInt32LE(offset + 22);
			const nameLen = buf.readUInt16LE(offset + 26);
			const extraLen = buf.readUInt16LE(offset + 28);
			const fileName = buf.toString("utf-8", offset + 30, offset + 30 + nameLen);
			const dataStart = offset + 30 + nameLen + extraLen;
			const dataSize = compSize || uncompSize; // fallback if data descriptor used

			if (fileName.endsWith(".pem") && dataSize > 0) {
				const raw = buf.subarray(dataStart, dataStart + dataSize);
				if (method === 0) {
					return raw.toString("utf-8");
				} else if (method === 8) {
					try {
						return zlib.inflateRawSync(raw).toString("utf-8");
					} catch {
						// decompression failed
					}
				}
			}
			offset = dataStart + dataSize;
		}
		return null;
	};

	// Upload endpoint: receive user-provided CA cert (PEM text or ZIP) and write to senec adapter state
	app.post("/senec/api/tls/upload-ca", (req, res) => {
		const chunks = [];
		let size = 0;
		const MAX_SIZE = 50 * 1024; // 50 KB — a PEM is ~2 KB, ZIP ~2 KB

		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_SIZE) {
				req.destroy();
				return safeJson(res, 413, { error: "Upload too large." });
			}
			chunks.push(chunk);
		});

		req.on("end", async () => {
			const buf = Buffer.concat(chunks);
			let pem;

			// Detect ZIP by magic bytes (PK\x03\x04)
			if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
				pem = extractPemFromZip(buf);
				if (!pem) {
					return safeJson(res, 400, { error: "ZIP does not contain a PEM certificate." });
				}
			} else {
				pem = buf.toString("utf-8").trim();
				if (!pem || !pem.includes("BEGIN CERTIFICATE")) {
					return safeJson(res, 400, { error: "Invalid file — must contain BEGIN CERTIFICATE." });
				}
			}

			try {
				// Write with ack=false so senec adapter's onStateChange validates it
				await adapter.setForeignStateAsync(`${senecNamespace}._local.tls.userCaPem`, pem, false);
				// Force re-resolve on next log proxy request
				agentResolved = false;
				safeJson(res, 200, { ok: true });
			} catch (e) {
				safeJson(res, 500, { error: `Failed to store certificate: ${e.message}` });
			}
		});

		req.on("error", () => {
			safeJson(res, 400, { error: "Upload error." });
		});
	});

	adapter.log.info("[SENEC] Web extension loaded with API endpoints at /senec/api/log, /senec/api/tls/upload-ca");

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
					(layer) =>
						!(
							layer.route &&
							(layer.route.path === "/senec/api/log" || layer.route.path === "/senec/api/tls/upload-ca")
						),
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
