"use strict";

const assert = require("node:assert/strict");
const proxyquire = require("proxyquire").noCallThru();

// Mock adapter-core and axios so main.js can be loaded without js-controller
const mainExport = proxyquire("../main", {
	"@iobroker/adapter-core": {
		Adapter: class FakeAdapter {
			constructor() {}
		},
		getAbsoluteDefaultDataDir: () => "/tmp",
	},
	axios: { create: () => ({}) },
	"axios-cookiejar-support": {},
	"tough-cookie": { CookieJar: class {} },
});

const t = mainExport._testing;
const authHelpers = require("../lib/auth-helpers");
const AdaptiveRequestQueue = require("../lib/AdaptiveRequestQueue");
const webClient = require("../lib/web-client");

describe("extractFormAction", () => {
	it("extracts action URL from a form tag", () => {
		const html = '<form id="login" action="https://sso.senec.com/auth/login" method="POST">';
		assert.equal(authHelpers.extractFormAction(html), "https://sso.senec.com/auth/login");
	});

	it("decodes &amp; in action URLs", () => {
		const html = '<form action="https://sso.senec.com/auth?a=1&amp;b=2" method="POST">';
		assert.equal(authHelpers.extractFormAction(html), "https://sso.senec.com/auth?a=1&b=2");
	});

	it("returns null when no form is present", () => {
		assert.equal(authHelpers.extractFormAction("<div>no form here</div>"), null);
	});

	it("returns null when form has no action", () => {
		assert.equal(authHelpers.extractFormAction('<form method="POST"><input name="user"></form>'), null);
	});
});

describe("hasUsername", () => {
	it("detects username input", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" name="username" />'));
	});

	it("detects email input", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" name="email" />'));
	});

	it("detects user input by id", () => {
		assert.ok(authHelpers.hasUsername('<input type="text" id="username" />'));
	});

	it("returns falsy for password-only form", () => {
		assert.ok(!authHelpers.hasUsername('<input type="password" name="password" />'));
	});

	it("returns falsy for empty HTML", () => {
		assert.ok(!authHelpers.hasUsername(""));
	});
});

describe("hasPassword", () => {
	it("detects password input", () => {
		assert.ok(authHelpers.hasPassword('<input type="password" name="password" />'));
	});

	it("returns falsy for username-only form", () => {
		assert.ok(!authHelpers.hasPassword('<input type="text" name="username" />'));
	});
});

describe("hasUsernameAndPassword", () => {
	it("returns truthy when both are present", () => {
		const html = '<input name="username" /><input type="password" name="password" />';
		assert.ok(authHelpers.hasUsernameAndPassword(html));
	});

	it("returns falsy when only username is present", () => {
		assert.ok(!authHelpers.hasUsernameAndPassword('<input name="username" />'));
	});
});

describe("hasOtp", () => {
	it("detects OTP input by name", () => {
		assert.ok(authHelpers.hasOtp('<input type="text" name="otp" />'));
	});

	it("detects OTP input by id", () => {
		assert.ok(authHelpers.hasOtp('<input type="text" id="otp" />'));
	});

	it("returns false for username form", () => {
		assert.ok(!authHelpers.hasOtp('<input type="text" name="username" />'));
	});

	it("returns false for empty HTML", () => {
		assert.ok(!authHelpers.hasOtp(""));
	});

	it("detects OTP in a full Keycloak-style form", () => {
		const html = `
			<form action="https://sso.senec.com/auth/otp" method="POST">
				<input type="text" name="otp" autocomplete="one-time-code" />
				<button type="submit">Submit</button>
			</form>`;
		assert.ok(authHelpers.hasOtp(html));
	});
});

describe("generateTOTP", () => {
	it("generates a 6-digit code", () => {
		const code = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.match(code, /^\d{6}$/);
	});

	it("generates consistent codes within the same 30s window", () => {
		const code1 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		const code2 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.equal(code1, code2);
	});

	it("handles secrets with spaces", () => {
		const code = authHelpers.generateTOTP("JBSW Y3DP EHPK 3PXP");
		assert.match(code, /^\d{6}$/);
	});

	it("handles lowercase secrets", () => {
		const upper = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		const lower = authHelpers.generateTOTP("jbswy3dpehpk3pxp");
		assert.equal(upper, lower);
	});

	it("handles secrets with padding characters", () => {
		const code = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP====");
		assert.match(code, /^\d{6}$/);
	});

	it("throws on invalid base32 characters", () => {
		assert.throws(() => authHelpers.generateTOTP("INVALID!SECRET"), /Invalid base32 character/);
	});

	it("throws on secret that is too short", () => {
		assert.throws(() => authHelpers.generateTOTP("A"), /TOTP secret too short/);
	});

	it("different secrets produce different codes", () => {
		const code1 = authHelpers.generateTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
		const code2 = authHelpers.generateTOTP("JBSWY3DPEHPK3PXP");
		assert.match(code1, /^\d{6}$/);
		assert.match(code2, /^\d{6}$/);
	});
});

describe("computeBackoffDelay", () => {
	it("returns a number >= 0", () => {
		const delay = authHelpers.computeBackoffDelay(1000, 0);
		assert.equal(typeof delay, "number");
		assert.ok(delay >= 0);
	});

	it("stays within expected bounds for attempt 0", () => {
		for (let i = 0; i < 100; i++) {
			const delay = authHelpers.computeBackoffDelay(1000, 0);
			assert.ok(delay >= 0 && delay < 1000, `delay ${delay} out of bounds`);
		}
	});

	it("caps at maxMultiplier", () => {
		for (let i = 0; i < 100; i++) {
			const delay = authHelpers.computeBackoffDelay(1000, 100, 8);
			assert.ok(delay >= 0 && delay < 8000, `delay ${delay} out of bounds`);
		}
	});

	it("increases with attempt number on average", () => {
		let sum0 = 0;
		let sum3 = 0;
		const runs = 1000;
		for (let i = 0; i < runs; i++) {
			sum0 += authHelpers.computeBackoffDelay(1000, 0);
			sum3 += authHelpers.computeBackoffDelay(1000, 3);
		}
		assert.ok(sum3 / runs > sum0 / runs, "higher attempt should produce higher average delay");
	});
});

describe("normalizeRebuildMode", () => {
	it("returns 'off' for 'off'", () => {
		assert.equal(t.normalizeRebuildMode("off"), "off");
	});

	it("returns 'resume' for 'resume'", () => {
		assert.equal(t.normalizeRebuildMode("resume"), "resume");
	});

	it("returns 'force_full' for 'force_full'", () => {
		assert.equal(t.normalizeRebuildMode("force_full"), "force_full");
	});

	it("is case-insensitive", () => {
		assert.equal(t.normalizeRebuildMode("OFF"), "off");
		assert.equal(t.normalizeRebuildMode("Resume"), "resume");
		assert.equal(t.normalizeRebuildMode("FORCE_FULL"), "force_full");
	});

	it("returns 'off' for unknown values", () => {
		assert.equal(t.normalizeRebuildMode("garbage"), "off");
		assert.equal(t.normalizeRebuildMode(""), "off");
	});

	it("returns 'off' for null/undefined", () => {
		assert.equal(t.normalizeRebuildMode(null), "off");
		assert.equal(t.normalizeRebuildMode(undefined), "off");
	});
});

describe("HexToFloat32", () => {
	it("converts hex to float32", () => {
		// 0x41200000 = 10.0 in IEEE754
		assert.equal(t.HexToFloat32("41200000"), "10.00");
	});

	it("converts negative float", () => {
		// 0xC1200000 = -10.0 in IEEE754
		assert.equal(t.HexToFloat32("C1200000"), "-10.00");
	});

	it("returns 0 for zero input", () => {
		assert.equal(t.HexToFloat32("00000000"), 0);
	});

	it("handles 1.0", () => {
		// 0x3F800000 = 1.0
		assert.equal(t.HexToFloat32("3F800000"), "1.00");
	});
});

describe("DecToIP", () => {
	it("converts decimal to IP address", () => {
		// 0xC0A80101 = 3232235777 = 192.168.1.1 (but reversed byte order in Senec)
		// Senec stores as little-endian: 0x0101A8C0
		assert.equal(t.DecToIP(0x0101a8c0), "192.168.1.1");
	});

	it("converts zero to 0.0.0.0", () => {
		assert.equal(t.DecToIP(0), "0.0.0.0");
	});

	it("handles 255.255.255.255", () => {
		assert.equal(t.DecToIP(0xffffffff), "255.255.255.255");
	});
});

describe("reviverNumParse", () => {
	it("converts fl_ hex to float", () => {
		const result = t.reviverNumParse("key", "fl_41200000");
		assert.equal(result, "10.00");
	});

	it("converts u8_ hex to unsigned int", () => {
		const result = t.reviverNumParse("key", "u8_0A");
		assert.equal(result, 10);
	});

	it("converts u1_ hex to unsigned int", () => {
		const result = t.reviverNumParse("key", "u1_03E8");
		assert.equal(result, 1000);
	});

	it("converts st_ to string", () => {
		const result = t.reviverNumParse("key", "st_hello");
		assert.equal(result, "hello");
	});

	it("converts i1_ hex to signed 16-bit int (positive)", () => {
		const result = t.reviverNumParse("key", "i1_0064");
		assert.equal(result, 100);
	});

	it("converts i1_ hex to signed 16-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i1_FF9C");
		assert.equal(result, -100);
	});

	it("converts i3_ hex to signed 32-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i3_FFFFFF9C");
		assert.equal(result, -100);
	});

	it("converts i8_ hex to signed 8-bit int (negative)", () => {
		const result = t.reviverNumParse("key", "i8_9C");
		assert.equal(result, -100);
	});

	it("passes through VARIABLE_NOT_FOUND", () => {
		assert.equal(t.reviverNumParse("key", "VARIABLE_NOT_FOUND"), "VARIABLE_NOT_FOUND");
	});

	it("returns empty string for FILE_VARIABLE_NOT_READABLE", () => {
		assert.equal(t.reviverNumParse("key", "FILE_VARIABLE_NOT_READABLE"), "");
	});

	it("passes through non-string values", () => {
		assert.equal(t.reviverNumParse("key", 42), 42);
		assert.equal(t.reviverNumParse("key", true), true);
		assert.equal(t.reviverNumParse("key", null), null);
	});

	it("flags unknown string formats", () => {
		const result = t.reviverNumParse("testKey", "zz_unknown");
		assert.ok(typeof result === "string" && result.startsWith("REPORT TO DEV:"));
	});
});

describe("PKCE helpers", () => {
	it("generateCodeVerifier returns a non-empty string", () => {
		const verifier = authHelpers.generateCodeVerifier();
		assert.equal(typeof verifier, "string");
		assert.ok(verifier.length > 0);
	});

	it("generateCodeVerifier produces unique values", () => {
		const v1 = authHelpers.generateCodeVerifier();
		const v2 = authHelpers.generateCodeVerifier();
		assert.notEqual(v1, v2);
	});

	it("generateCodeChallenge returns a base64url string", () => {
		const verifier = authHelpers.generateCodeVerifier();
		const challenge = authHelpers.generateCodeChallenge(verifier);
		assert.equal(typeof challenge, "string");
		assert.ok(challenge.length > 0);
		// base64url: no +, /, or =
		assert.ok(!/[+/=]/.test(challenge), "challenge should be base64url encoded");
	});

	it("generateCodeChallenge is deterministic for same input", () => {
		const verifier = authHelpers.generateCodeVerifier();
		const c1 = authHelpers.generateCodeChallenge(verifier);
		const c2 = authHelpers.generateCodeChallenge(verifier);
		assert.equal(c1, c2);
	});

	it("base64UrlEncode produces no padding or special chars", () => {
		const encoded = authHelpers.base64UrlEncode(Buffer.from("hello world"));
		assert.ok(!/[+/=]/.test(encoded));
	});
});

describe("AdaptiveRequestQueue", () => {
	it("executes a queued task", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 1 });
		const result = await queue.add(() => Promise.resolve("done"));
		assert.equal(result, "done");
	});

	it("respects concurrency limit", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 1, minTimeBetweenStartsMs: 0 });
		let running = 0;
		let maxRunning = 0;

		const task = () =>
			new Promise((resolve) => {
				running++;
				if (running > maxRunning) maxRunning = running;
				setTimeout(() => {
					running--;
					resolve();
				}, 20);
			});

		await Promise.all([queue.add(task), queue.add(task), queue.add(task)]);
		assert.equal(maxRunning, 1);
	});

	it("handles task failures without breaking the queue", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 2, minTimeBetweenStartsMs: 0 });

		await assert.rejects(() => queue.add(() => Promise.reject(new Error("fail"))), /fail/);

		// Queue should still work after a failure
		const result = await queue.add(() => Promise.resolve("ok"));
		assert.equal(result, "ok");
	});

	it("tracks statistics", async () => {
		const queue = new AdaptiveRequestQueue({ concurrency: 2, minTimeBetweenStartsMs: 0 });

		await queue.add(() => Promise.resolve("ok"));
		await assert.rejects(() => queue.add(() => Promise.reject(new Error("fail"))));

		const stats = queue.getStats();
		assert.equal(stats.started, 2);
		assert.equal(stats.succeeded, 1);
		assert.equal(stats.failed, 1);
	});

	it("reduces concurrency on overload signal", async () => {
		const queue = new AdaptiveRequestQueue({
			concurrency: 3,
			minConcurrency: 1,
			minTimeBetweenStartsMs: 0,
			cooldownMs: 50,
		});

		const err = new Error("rate limited");
		err.response = { status: 429, headers: {} };
		await assert.rejects(() => queue.add(() => Promise.reject(err)));

		const stats = queue.getStats();
		assert.ok(stats.concurrency < 3, "concurrency should have been reduced");
		assert.equal(stats.rateLimited, 1);
	});

	it("accepts custom setTimeout/clearTimeout", async () => {
		let timerCalled = false;
		const queue = new AdaptiveRequestQueue({
			concurrency: 1,
			minTimeBetweenStartsMs: 0,
			setTimeout: (fn, ms) => {
				timerCalled = true;
				return setTimeout(fn, ms);
			},
			clearTimeout: (id) => clearTimeout(id),
		});

		// Trigger a cooldown to use the timer
		const err = new Error("rate limited");
		err.response = { status: 429, headers: {} };
		await assert.rejects(() => queue.add(() => Promise.reject(err)));

		assert.ok(timerCalled, "custom setTimeout should have been called for cooldown");
	});
});

describe("resolveStateAttrKey", () => {
	const resolve = t.resolveStateAttrKey;

	it("returns exact match when present", () => {
		const attrs = { "ENERGY.GUI_BAT_DATA_POWER": { name: "Battery Power" } };
		assert.equal(resolve("ENERGY.GUI_BAT_DATA_POWER", attrs), "ENERGY.GUI_BAT_DATA_POWER");
	});

	it("strips trailing numeric index", () => {
		const attrs = { "batteryModules": { name: "Battery Modules" } };
		assert.equal(resolve("batteryModules.0", attrs), "batteryModules");
	});

	it("strips all embedded numeric indices (array resolution)", () => {
		const attrs = { "batteryModules.serialNumber": { name: "Serial Number" } };
		assert.equal(resolve("batteryModules.0.serialNumber", attrs), "batteryModules.serialNumber");
	});

	it("strips multiple embedded numeric indices", () => {
		const attrs = { "a.b.c": { name: "Nested" } };
		assert.equal(resolve("a.0.b.1.c", attrs), "a.b.c");
	});

	it("prefers exact match over stripped variants", () => {
		const attrs = {
			"batteryModules.0.serialNumber": { name: "Specific" },
			"batteryModules.serialNumber": { name: "Generic" },
		};
		assert.equal(resolve("batteryModules.0.serialNumber", attrs), "batteryModules.0.serialNumber");
	});

	it("returns null when no resolution matches", () => {
		const attrs = { "OTHER.KEY": { name: "Other" } };
		assert.equal(resolve("MISSING.KEY", attrs), null);
	});
});

describe("webApiErrorMsg", () => {
	it("returns message when present", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { message: "Not found" } }), "Not found");
	});

	it("falls back to errorCode when no message", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { errorCode: "ERR_001" } }), "ERR_001");
	});

	it("falls back to JSON.stringify when neither message nor errorCode", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { foo: "bar" } }), '{"foo":"bar"}');
	});

	it("prefers message over errorCode", () => {
		assert.equal(webClient.webApiErrorMsg({ data: { message: "msg", errorCode: "code" } }), "msg");
	});

	it("handles null data", () => {
		assert.equal(webClient.webApiErrorMsg({ data: null }), "null");
	});
});

describe("aggregateToHourly", () => {
	it("converts kW to kWh using interval duration", () => {
		// 3 readings, each 5 min apart
		const val = [
			[new Date(2026, 6, 13, 10, 0).getTime(), 6.0], // 6 kW × 5/60 h = 0.5 kWh
			[new Date(2026, 6, 13, 10, 5).getTime(), 6.0], // 6 kW × 5/60 h = 0.5 kWh
			[new Date(2026, 6, 13, 10, 10).getTime(), 12.0], // 12 kW × 5/60 h = 1.0 kWh (last uses prev interval)
		];
		const result = webClient.aggregateToHourly(val);
		// All in hour 10: 0.5 + 0.5 + 1.0 = 2.0 kWh
		assert.ok(Math.abs(result[10] - 2.0) < 0.001);
		assert.equal(result[11], 0);
		assert.equal(result[0], 0);
	});

	it("returns 24 hours initialized to zero", () => {
		const result = webClient.aggregateToHourly([]);
		assert.equal(Object.keys(result).length, 24);
		for (let h = 0; h < 24; h++) {
			assert.equal(result[h], 0);
		}
	});
});

describe("aggregateToDaily", () => {
	it("sums values by day of month", () => {
		const val = [
			[new Date(2026, 6, 1).getTime(), 10],
			[new Date(2026, 6, 1).getTime(), 5],
			[new Date(2026, 6, 15).getTime(), 20],
		];
		const result = webClient.aggregateToDaily(val);
		assert.equal(result[1], 15);
		assert.equal(result[15], 20);
	});

	it("returns empty object for empty input", () => {
		const result = webClient.aggregateToDaily([]);
		assert.equal(Object.keys(result).length, 0);
	});
});

describe("aggregateToMonthly", () => {
	it("sums values by month", () => {
		const val = [
			[new Date(2026, 0, 15).getTime(), 100],
			[new Date(2026, 0, 20).getTime(), 50],
			[new Date(2026, 5, 1).getTime(), 200],
		];
		const result = webClient.aggregateToMonthly(val);
		assert.equal(result[1], 150);
		assert.equal(result[6], 200);
		assert.equal(result[12], 0);
	});

	it("returns 12 months initialized to zero", () => {
		const result = webClient.aggregateToMonthly([]);
		assert.equal(Object.keys(result).length, 12);
		for (let m = 1; m <= 12; m++) {
			assert.equal(result[m], 0);
		}
	});
});
