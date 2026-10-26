"use strict";

/* global app, t, escHtml, stateIsLive, connectorEnabled, liveChart */
/* exported energyFlow */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Energy flow data layer and visualization.
 *
 * Normalizes power data from different connectors into a unified format,
 * then renders an SVG energy flow diagram.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var energyFlow = {
	// Normalized energy data — all power values in W (signed: positive = generation/import/charge)

	data: {
		pv: 0,
		battery: 0,
		grid: 0,
		house: 0,
		/** @type {number|null} */ soc: null,
		/** @type {number|null} */ todayPv: null,
		/** @type {number|null} */ todayConsumption: null,
		/** @type {number|null} */ todayGridImport: null,
		/** @type {number|null} */ todayGridExport: null,
		/** @type {number|null} */ todayBatteryCharge: null,
		/** @type {number|null} */ todayBatteryDischarge: null,
		wallbox: 0,
		/** @type {number|null} */ todayWallbox: null,
		/** @type {number|null} */ autarkyCurrent: null, // % self-sufficiency right now (live)
		/** @type {number|null} */ autarky: null, // % self-sufficiency for current period
		/** @type {number|null} */ autarkyWeek: null, // % self-sufficiency this week (web only)
		/** @type {number|null} */ autarkyAll: null, // % self-sufficiency lifetime (web only)
		/** @type {number|null} */ batteryCapacity: null, // kWh — design capacity for time estimates
		// External sources (separate mode only — integrate mode values already added to pv/wallbox/battery)
		/** @type {Array<{power: number, label: string}>} */ externalPv: [], // array of { power, label }
		/** @type {Array<{power: number, label: string}>} */ externalConsumer: [], // array of { power, label }
		/**
		 * @type {Array<{power: number, label: string, soc?: number|null, capacity?: number|null}>}
		 */
		externalBattery: [], // array of { power, label } — signed: +charge/-discharge
	},

	source: "auto", // "auto", "local", "openapi", "api", "web"
	period: "today", // "today", "month", "year"

	/** @type {string|null} */ activeSource: null, // which source is actually providing data

	/** @type {string|null} */ apiAnlagenId: null, // discovered API system ID
	hasData: false,

	// State ID mappings per connector
	stateMap: {
		local: {
			pv: "ENERGY.GUI_INVERTER_POWER",
			battery: "ENERGY.GUI_BAT_DATA_POWER", // signed: positive=charge, negative=discharge
			grid: "ENERGY.GUI_GRID_POW", // signed: positive=import, negative=export
			house: "ENERGY.GUI_HOUSE_POW",
			soc: "ENERGY.GUI_BAT_DATA_FUEL_CHARGE",
		},
		openapi: {
			pv: "_openapi.meter.production",
			battery: "_openapi.battery.power", // signed: positive=charge, negative=discharge
			grid: "_openapi.meter.gridPower", // direction resolved by resolveOpenapiGrid
			house: "_openapi.meter.houseConsumption",
			soc: "_openapi.battery.stateOfCharge",
		},
		// API and Web use dynamic prefixes — resolved at runtime
	},

	/**
	 * Discover API system ID from loaded states
	 *
	 * @param {object} states - ioBroker state values
	 */
	discoverApiId: function (states) {
		// A disabled App API leaves its whole _api.Anlagen tree behind. Discovering an id from it
		// would hand every `${apiPrefix()}` chain in the dashboard a live-looking prefix over
		// stale data — including the day totals, which test for the states directly.
		if (!connectorEnabled("api")) {
			this.apiAnlagenId = null;
			return;
		}
		var fallback = null;
		for (var key in states) {
			var m = key.match(/^_api\.Anlagen\.([^.]+)\./);
			if (m) {
				// Prefer the ID that has Dashboard data (avoids stale/old IDs)
				if (key.indexOf(".Dashboard.") !== -1) {
					this.apiAnlagenId = m[1];
					return;
				}
				if (!fallback) {
					fallback = m[1];
				}
			}
		}
		if (fallback) {
			this.apiAnlagenId = fallback;
		}
	},

	/** Get the API state prefix for the discovered system */
	apiPrefix: function () {
		return this.apiAnlagenId ? `_api.Anlagen.${this.apiAnlagenId}.Dashboard.` : null;
	},

	/**
	 * State ids each source needs before it can describe a power flow.
	 *
	 * A connector reports itself connected as soon as it has read anything at all, which is right
	 * for a connection state and not enough to select a source: the local OpenAPI counts a
	 * nameplate-only cycle as a success, and the App API reports connected before a plant has been
	 * discovered. Selecting such a source drew a diagram of zeros over a working connector.
	 *
	 * Any one of a source's power states is enough, so a single failed section does not
	 * disqualify a source that is otherwise reporting.
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} src - Source name
	 * @returns {boolean} Whether the source has published any power reading
	 */
	sourceHasPower: function (states, src) {
		var keys;
		if (src === "openapi") {
			keys = [this.stateMap.openapi.pv, this.stateMap.openapi.house, this.stateMap.openapi.battery];
		} else if (src === "local") {
			keys = [this.stateMap.local.pv, this.stateMap.local.house, this.stateMap.local.battery];
		} else if (src === "api") {
			// resolveSource is also called directly, outside update(), so the plant id may not
			// have been discovered yet. Discovering here keeps those callers correct and costs a
			// scan only until the id is known.
			if (!this.apiAnlagenId) {
				this.discoverApiId(states);
			}
			var apfx = this.apiPrefix();
			if (!apfx) {
				return false;
			}
			keys = [`${apfx}currently.powerGenerationInW`, `${apfx}currently.powerConsumptionInW`];
		} else if (src === "web") {
			keys = ["_meinsenec.Status.powergenerated.now", "_meinsenec.Status.consumption.now"];
		} else {
			return false;
		}
		// A reading, not merely a present state: a field carrying an unavailability marker is
		// not a power value, and selecting a source on the strength of one draws a diagram of
		// zeros — the thing this test exists to prevent.
		for (var i = 0; i < keys.length; i++) {
			if (this.getStateOrNull(states, keys[i]) !== null) {
				return true;
			}
		}
		return false;
	},

	/**
	 * Determine which source to use based on priority and connectivity
	 *
	 * @param {object} states - ioBroker state values
	 * @param {object} connectors - Connector status objects
	 */
	resolveSource: function (states, connectors) {
		if (this.source !== "auto") {
			return this.source;
		}
		// Priority: local > openapi > api > web. The local connector polls at 10s by default
		// against the OpenAPI's 60s, so it wins where both run; the OpenAPI is still a local
		// reading and outranks either cloud connector.
		//
		// Only `openapi` is null-guarded: `app.connectors` always defines all five keys, but a
		// caller written before this source existed does not, and the dashboard is served from the
		// object DB so a stale page can outlive the adapter that matches it. The other three
		// predate every caller.
		var order = ["local", "openapi", "api", "web"];
		for (var i = 0; i < order.length; i++) {
			var name = order[i];
			if (connectors[name] && connectors[name].active && this.sourceHasPower(states, name)) {
				return name;
			}
		}
		return null;
	},

	/**
	 * Read a state value, returning 0 if missing
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 */
	getState: function (states, key) {
		var val = this.liveValue(states, key);
		if (val === undefined || val === null) {
			return 0;
		}
		// See getStateOrNull: a non-numeric value must not become NaN. Zero is this accessor's
		// established answer for "nothing to read".
		var num = Number(val);
		return Number.isFinite(num) ? num : 0;
	},

	/**
	 * Read a state value, returning null if missing
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 */
	getStateOrNull: function (states, key) {
		var val = this.liveValue(states, key);
		if (val === undefined || val === null) {
			return null;
		}
		// Not merely Number(). A W-unit field carrying a non-numeric string — which the
		// appliance's own unavailability markers are, and which `state_attr` does not stop for a
		// field with a unit but no numtype — yields NaN, and NaN fails every comparison silently:
		// the grid balance stops resolving, both deadband tests fall through, and the magnitude
		// is read as an import. Absent is the honest reading of a value that is not a number.
		var num = Number(val);
		return Number.isFinite(num) ? num : null;
	},

	/**
	 * Read a state only if the connector that writes it is still switched on.
	 *
	 * Nothing deletes a connector's states when it is disabled, so without this the flow and
	 * the totals go on rendering whatever that connector last wrote — on a long-disabled
	 * connector, values months old presented as a current measurement.
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 * @returns {unknown} The value, or undefined when its connector is switched off
	 */
	liveValue: function (states, key) {
		return stateIsLive(key) ? states[key] : undefined;
	},

	/**
	 * Whether a state is present AND written by a connector that is still switched on.
	 *
	 * @param {object} states - ioBroker state values
	 * @param {string} key - State ID
	 * @returns {boolean} True when the value may be used
	 */
	hasLive: function (states, key) {
		return this.liveValue(states, key) !== undefined;
	},

	/**
	 * Update energy data from states
	 *
	 * @param {object} states - ioBroker state values
	 * @param {object} connectors - Connector status objects
	 */
	update: function (states, connectors) {
		this.discoverApiId(states);
		var src = this.resolveSource(states, connectors);
		var changed = src !== this.activeSource;
		this.activeSource = src;

		if (!src) {
			this.hasData = false;
			return;
		}

		// An automatic switch — a connector dropping out and another taking over — has to reset
		// the chart the same way the dropdown does. The sources do not produce their grid value
		// the same way (one is the device's own signed figure, another is derived from a power
		// balance), so a buffer holding both steps sign-wise with no cause in the plant, and the
		// history discovery left behind belongs to the previous source's state ids.
		if (changed) {
			this.resetChart();
		}

		// Each reader reports whether any of its mapped power states is present. Asserting
		// hasData regardless published a diagram of zeros, or the previous source's values, as a
		// current reading.
		var found = false;
		if (src === "local") {
			found = this.updateFromLocal(states);
		} else if (src === "openapi") {
			found = this.updateFromOpenapi(states);
		} else if (src === "api") {
			found = this.updateFromApi(states);
		} else if (src === "web") {
			found = this.updateFromWeb(states);
		}

		if (!found) {
			this.hasData = false;
			// The reset above emptied `_historyStatus`, which is what every backfill trigger
			// tests through `_hasHistory()`. Returning without re-arming leaves the chart with
			// no path back to its history until the page is reloaded — the same trap the
			// re-arm at the end of this function exists to avoid.
			if (changed) {
				this.rearmChart();
			}
			return;
		}

		// Current autarky — API provides it natively, otherwise calculate
		if (src === "api") {
			var pfx = this.apiPrefix();
			this.data.autarkyCurrent = this.getStateOrNull(states, `${pfx}currently.selfSufficiencyInPercent`);
		} else {
			this.data.autarkyCurrent = this.calcAutarky(this.data.house, this.data.grid);
		}

		// External energy sources
		this.updateExternalSources(states);

		// Day totals — try API first (Wh), then Web (kWh)
		this.updateDayTotals(states);

		this.hasData = true;

		// Discovery has to be started again for the new source, not merely discarded. resetChart
		// empties `_historyStatus`, which is what every backfill trigger tests through
		// `_hasHistory()` — so without this the chart is left clean and permanently empty, with
		// no path back to its history until the page is reloaded.
		if (changed) {
			this.rearmChart();
		}
	},

	/**
	 * Discard chart state that belongs to the source we have just stopped using.
	 *
	 * Resetting and re-arming are separate because the dropdown has to reset before `update()`
	 * runs and re-arm after it, while an automatic switch does both from inside `update()`.
	 */
	resetChart: function () {
		if (typeof liveChart === "undefined") {
			return;
		}
		liveChart.buffer = [];
		liveChart._historyLoaded = false;
		liveChart._historyStatus = {};
		liveChart._historyRequestedTs = Infinity;
		liveChart._newestHistoryTs = 0;
		// The 2 s throttle in `record` is keyed on wall-clock time, not on the source, so a
		// switch made within 2 s of the old source's last point threw away the new source's
		// first one — and `rearmChart` is the only thing that records it.
		liveChart._lastTs = 0;
		liveChart._loadGeneration++;
		liveChart._clearLoadTimer();
		liveChart._historyLoading = false;
	},

	/**
	 * Record a first point for the new source and rediscover which of its states are logged.
	 *
	 * Both are no-ops until a source is resolved and its data has been read, which is why this
	 * runs at the end of `update()` rather than beside `resetChart`.
	 */
	rearmChart: function () {
		if (typeof liveChart === "undefined" || typeof app === "undefined" || !app.conn) {
			return;
		}
		// Not during an incomplete OpenAPI cycle. Its sections are a dozen separate writes, so
		// a reading taken mid-cycle mixes this cycle's values with the previous one's — which is
		// tolerable in the diagram, where it is labelled as such, but not on a chart whose
		// x-axis is the claim being made. The next complete cycle is one interval away.
		if (this.activeSource !== "openapi" || this.openapiCycleComplete(app.states)) {
			liveChart.record();
		}
		liveChart.initHistory(app.conn, app.namespace, app.connectors);
	},

	updateFromLocal: function (states) {
		var map = this.stateMap.local;
		if (!this.sourceHasPower(states, "local")) {
			return false;
		}
		this.data.pv = Math.abs(this.getState(states, map.pv));
		this.data.battery = this.getState(states, map.battery); // already signed
		this.data.grid = this.getState(states, map.grid); // already signed
		this.data.house = Math.abs(this.getState(states, map.house));
		this.data.soc = this.getStateOrNull(states, map.soc);
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
		// Wallbox — array values stored as individual indices (WALLBOX.APPARENT_CHARGING_POWER.0, .1, etc.)
		this.data.wallbox = 0;
		for (var i = 0; i < 4; i++) {
			var v = this.getStateOrNull(states, `WALLBOX.APPARENT_CHARGING_POWER.${i}`);
			if (v !== null) {
				this.data.wallbox += v;
			}
		}
		return true;
	},

	/**
	 * Residual in W inside which the power balance is noise rather than a direction.
	 *
	 * A working figure with headroom over the 5 W residual measured on the one recorded import
	 * sample; no export sample exists yet, so it is not derived from the spread of real residuals.
	 * The measurement itself is in docs/LOCAL_OPENAPI_4424.md.
	 */
	openapiGridDeadband: 50,

	/**
	 * Resolve the signed grid power reported by the local OpenAPI.
	 *
	 * `meter.gridPower` has only been observed while importing, so whether it carries a sign or a
	 * magnitude is undecided — and the appliance reports `powerSurplus` separately, which would be
	 * redundant under a signed convention. Three readings, in order:
	 *
	 * 1. A negative value is a signed reading and is trusted as it stands.
	 * 2. Otherwise the direction comes from the power balance, which is sign-correct wherever the
	 *    metered magnitude is. Inside the deadband the balance places nothing: a magnitude also
	 *    inside the band reads as 0, and a larger one is kept and read as an import.
	 * 3. When the direction is export but `gridPower` reads 0, the field is import-only and
	 *    `powerSurplus` carries the feed-in; that figure becomes the magnitude. Correct under both
	 *    candidate conventions, since a signed field never reaches this branch.
	 *
	 * Known limit: the SENEC.Connect schema specifies the matching `consumption` field as
	 * excluding the wallbox load. If the local meter aggregates that way too, the balance reads
	 * low while a wallbox charges and can mistake an import for an export.
	 *
	 * @param {number} gridPower - meter.gridPower as reported
	 * @param {number} house - meter.houseConsumption in W
	 * @param {number} battery - battery.power in W, positive = charging
	 * @param {number} production - meter.production in W
	 * @param {number} [surplus] - meter.powerSurplus in W, when reported
	 * @returns {number} Grid power in W, positive = import
	 */
	resolveOpenapiGrid: function (gridPower, house, battery, production, surplus) {
		if (gridPower < 0) {
			return gridPower;
		}
		// What the grid has to supply: the house load plus whatever charges the battery, less
		// what the PV generates. Negative means the appliance has power left over.
		var balance = house + battery - production;
		var magnitude = Math.abs(gridPower);
		if (balance < -this.openapiGridDeadband) {
			// Exporting. A gridPower of 0 here means the field does not carry feed-in at all.
			var feedIn = magnitude > 0 ? magnitude : Math.abs(Number(surplus) || 0);
			// Not `-feedIn`: negating zero yields -0, which is a confusing value to hand a
			// renderer for "nothing is flowing".
			return feedIn === 0 ? 0 : -feedIn;
		}
		if (balance > this.openapiGridDeadband) {
			return magnitude;
		}
		// Inside the band the balance establishes no direction. When the meter's own magnitude is
		// inside it too, nothing meaningful is flowing either way and zero is the honest answer.
		if (magnitude <= this.openapiGridDeadband) {
			return 0;
		}
		// A magnitude well outside the band with a flat balance is the wallbox-exclusion case in
		// the note above: the measurement is real even though the balance cannot place it, so it
		// is kept rather than discarded, read as the import it usually is.
		return magnitude;
	},

	updateFromOpenapi: function (states) {
		var map = this.stateMap.openapi;
		// The connector omits a state rather than publishing a fabricated zero for a value the
		// appliance did not report, and a section left out of the include list is never written at
		// all. Reading those absences as 0 drew a diagram of zeros labelled with a fresh
		// timestamp, and a missing battery term inverted the grid direction.
		var pv = this.getStateOrNull(states, map.pv);
		var house = this.getStateOrNull(states, map.house);
		var battery = this.getStateOrNull(states, map.battery);
		var grid = this.getStateOrNull(states, map.grid);
		if (pv === null && house === null && battery === null) {
			return false;
		}

		this.data.pv = pv === null ? 0 : Math.abs(pv);
		this.data.battery = battery === null ? 0 : battery; // already signed
		this.data.house = house === null ? 0 : Math.abs(house);
		// Every balance term has to be present for the direction to mean anything. Without them
		// the magnitude is still a measurement, so it is shown as an import — the common case —
		// rather than being guessed from an incomplete balance.
		this.data.grid =
			grid === null
				? 0
				: pv !== null && house !== null && battery !== null
					? this.resolveOpenapiGrid(
							grid,
							this.data.house,
							this.data.battery,
							this.data.pv,
							this.getStateOrNull(states, "_openapi.meter.powerSurplus"),
						)
					: Math.abs(grid);
		this.data.soc = this.getStateOrNull(states, map.soc);
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
		// The flow diagram branches the wallbox off the house node, so it needs a house figure
		// that already contains the charging load. Nothing establishes that the local meter
		// aggregates that way, so the wallbox stays out of the flow math and `_openapi.evse.*`
		// is reported on the system tab instead.
		this.data.wallbox = 0;
		return true;
	},

	updateFromApi: function (states) {
		var pfx = this.apiPrefix();
		// A discovered plant id is not a reading: the id can come from a SystemDetails poll while
		// the dashboard section has published nothing, and reading those absences as zero drew a
		// diagram of zeros. Checked the same way as every other source.
		if (!pfx || !this.sourceHasPower(states, "api")) {
			return false;
		}

		this.data.pv = this.getState(states, `${pfx}currently.powerGenerationInW`);
		var charge = this.getState(states, `${pfx}currently.batteryChargeInW`);
		var discharge = this.getState(states, `${pfx}currently.batteryDischargeInW`);
		this.data.battery = charge - discharge; // positive = charging
		var gridDraw = this.getState(states, `${pfx}currently.gridDrawInW`);
		var gridFeed = this.getState(states, `${pfx}currently.gridFeedInInW`);
		this.data.grid = gridDraw - gridFeed; // positive = importing
		this.data.house = this.getState(states, `${pfx}currently.powerConsumptionInW`);
		this.data.soc = this.getStateOrNull(states, `${pfx}currently.batteryLevelInPercent`);
		this.data.wallbox = this.getState(states, `${pfx}currently.wallboxInW`);
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
		return true;
	},

	updateFromWeb: function (states) {
		// Web connector stores power values in kW — multiply by 1000 to normalize to W
		var pfx = "_meinsenec.Status.";
		if (!this.sourceHasPower(states, "web")) {
			return false;
		}
		this.data.pv = this.getState(states, `${pfx}powergenerated.now`) * 1000;
		// accuexport = export power to battery (charge), accuimport = import power from battery (discharge)
		var charge = this.getState(states, `${pfx}accuexport.now`) * 1000;
		var discharge = this.getState(states, `${pfx}accuimport.now`) * 1000;
		this.data.battery = charge - discharge;
		var gridImport = this.getState(states, `${pfx}gridimport.now`) * 1000;
		var gridExport = this.getState(states, `${pfx}gridexport.now`) * 1000;
		this.data.grid = gridImport - gridExport;
		this.data.house = this.getState(states, `${pfx}consumption.now`) * 1000;
		this.data.soc = this.getStateOrNull(states, `${pfx}acculevel.now`); // % — no conversion
		this.data.wallbox = 0; // Web connector doesn't provide live wallbox power
		this.data.batteryCapacity = this.resolveBatteryCapacity(states);
		return true;
	},

	/**
	 * Read external energy source states and integrate/separate them.
	 * Integrate mode: adds to data.pv / data.wallbox / data.battery.
	 * Separate mode: populates data.externalPv / externalConsumer / externalBattery arrays.
	 *
	 * @param {object} states - ioBroker state values
	 */
	updateExternalSources: function (states) {
		this.data.externalPv = [];
		this.data.externalConsumer = [];
		this.data.externalBattery = [];

		var types = ["pv", "consumer", "battery"];
		for (var ti = 0; ti < types.length; ti++) {
			var type = types[ti];
			for (var idx = 0; idx < 10; idx++) {
				var pfx = `_external.${type}.${idx}.`;
				var power = this.getStateOrNull(states, `${pfx}power`);
				if (power === null) {
					break; // no more sources of this type
				}

				var mode = states[`${pfx}mode`] || "integrate";
				var label = states[`${pfx}label`] || "";
				var val = Number(power);

				var entry = { power: val, label: label };
				if (type === "battery") {
					entry.soc = this.getStateOrNull(states, `${pfx}soc`);
					entry.capacity = this.getStateOrNull(states, `${pfx}capacity`);
				}

				if (mode === "integrate") {
					// Add directly to the SENEC total
					if (type === "pv") {
						this.data.pv += Math.abs(val);
					} else if (type === "consumer") {
						// Consumers always show as separate nodes (they have individual labels)
						this.data.externalConsumer.push(entry);
					} else if (type === "battery") {
						this.data.battery += val; // signed
					}
				} else {
					// Separate mode for diagram rendering
					if (type === "pv") {
						this.data.externalPv.push(entry);
					} else if (type === "consumer") {
						this.data.externalConsumer.push(entry);
					} else if (type === "battery") {
						this.data.externalBattery.push(entry);
					}
				}
			}
		}
	},

	updateDayTotals: function (states) {
		if (this.period === "today") {
			this.updateTotalsToday(states);
		} else if (this.period === "month") {
			this.updateTotalsMonth(states);
		} else if (this.period === "year") {
			this.updateTotalsYear(states);
		}
	},

	updateTotalsToday: function (states) {
		// Try API Dashboard first (values in Wh → convert to kWh)
		var pfx = this.apiPrefix();
		if (pfx && this.hasLive(states, `${pfx}today.powerGenerationInWh`)) {
			this.data.todayPv = this.getState(states, `${pfx}today.powerGenerationInWh`) / 1000;
			this.data.todayConsumption = this.getState(states, `${pfx}today.powerConsumptionInWh`) / 1000;
			this.data.todayGridImport = this.getState(states, `${pfx}today.gridDrawInWh`) / 1000;
			this.data.todayGridExport = this.getState(states, `${pfx}today.gridFeedInInWh`) / 1000;
			this.data.todayBatteryCharge = this.getState(states, `${pfx}today.batteryChargeInWh`) / 1000;
			this.data.todayBatteryDischarge = this.getState(states, `${pfx}today.batteryDischargeInWh`) / 1000;
			this.data.todayWallbox = this.getState(states, `${pfx}today.wallboxInWh`) / 1000;
			this.data.autarky = this.getStateOrNull(states, `${pfx}today.selfSufficiencyInPercent`);
			this.data.autarkyWeek = this.getStateOrNull(states, "_meinsenec.Autarky.week");
			this.data.autarkyAll = this.getStateOrNull(states, "_meinsenec.Autarky.all");
			return;
		}

		// Try Web Status (values already in kWh)
		var wpfx = "_meinsenec.Status.";
		if (this.hasLive(states, `${wpfx}powergenerated.today`)) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated.today`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption.today`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport.today`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport.today`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport.today`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport.today`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.day");
			this.data.autarkyWeek = this.getStateOrNull(states, "_meinsenec.Autarky.week");
			this.data.autarkyAll = this.getStateOrNull(states, "_meinsenec.Autarky.all");
			return;
		}

		// No source for today's totals, which is the normal state of an install running only a
		// local connector. Cleared rather than left behind, as the month and year paths do.
		this.clearTotals();
	},

	updateTotalsMonth: function (states) {
		// Web measurements: _meinsenec.Measurements.Monthly.current_month.{type}
		var wpfx = "_meinsenec.Measurements.Monthly.current_month.";
		if (this.hasLive(states, `${wpfx}powergenerated`)) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.month");
			return;
		}

		// API measurements: _api.Anlagen.{id}.Measurements.Monthly.current_month.{key}
		var pfx = this.apiPrefix();
		if (pfx) {
			var apfx = pfx.replace("Dashboard.", "Measurements.Monthly.current_month.");
			if (this.hasLive(states, `${apfx}powerGenerationInWh`)) {
				this.data.todayPv = this.getState(states, `${apfx}powerGenerationInWh`) / 1000;
				this.data.todayConsumption = this.getState(states, `${apfx}powerConsumptionInWh`) / 1000;
				this.data.todayGridImport = this.getState(states, `${apfx}gridDrawInWh`) / 1000;
				this.data.todayGridExport = this.getState(states, `${apfx}gridFeedInInWh`) / 1000;
				this.data.todayBatteryCharge = this.getState(states, `${apfx}batteryChargeInWh`) / 1000;
				this.data.todayBatteryDischarge = this.getState(states, `${apfx}batteryDischargeInWh`) / 1000;
				this.data.todayWallbox = this.getStateOrNull(states, `${apfx}wallboxInWh`);
				if (this.data.todayWallbox !== null) {
					this.data.todayWallbox /= 1000;
				}
				this.data.autarky = null;
				return;
			}
		}

		this.clearTotals();
	},

	updateTotalsYear: function (states) {
		var year = new Date().getFullYear();

		// Web measurements: _meinsenec.Measurements.Yearly.{year}.{type}
		var wpfx = `_meinsenec.Measurements.Yearly.${year}.`;
		if (this.hasLive(states, `${wpfx}powergenerated`)) {
			this.data.todayPv = this.getStateOrNull(states, `${wpfx}powergenerated`);
			this.data.todayConsumption = this.getStateOrNull(states, `${wpfx}consumption`);
			this.data.todayGridImport = this.getStateOrNull(states, `${wpfx}gridimport`);
			this.data.todayGridExport = this.getStateOrNull(states, `${wpfx}gridexport`);
			this.data.todayBatteryCharge = this.getStateOrNull(states, `${wpfx}accuexport`);
			this.data.todayBatteryDischarge = this.getStateOrNull(states, `${wpfx}accuimport`);
			this.data.todayWallbox = null;
			this.data.autarky = this.getStateOrNull(states, "_meinsenec.Autarky.year");
			return;
		}

		// API measurements: _api.Anlagen.{id}.Measurements.Yearly.{year}.{key}
		var pfx = this.apiPrefix();
		if (pfx) {
			var apfx = pfx.replace("Dashboard.", `Measurements.Yearly.${year}.`);
			if (this.hasLive(states, `${apfx}powerGenerationInWh`)) {
				this.data.todayPv = this.getState(states, `${apfx}powerGenerationInWh`) / 1000;
				this.data.todayConsumption = this.getState(states, `${apfx}powerConsumptionInWh`) / 1000;
				this.data.todayGridImport = this.getState(states, `${apfx}gridDrawInWh`) / 1000;
				this.data.todayGridExport = this.getState(states, `${apfx}gridFeedInInWh`) / 1000;
				this.data.todayBatteryCharge = this.getState(states, `${apfx}batteryChargeInWh`) / 1000;
				this.data.todayBatteryDischarge = this.getState(states, `${apfx}batteryDischargeInWh`) / 1000;
				this.data.todayWallbox = this.getStateOrNull(states, `${apfx}wallboxInWh`);
				if (this.data.todayWallbox !== null) {
					this.data.todayWallbox /= 1000;
				}
				this.data.autarky = null;
				return;
			}
		}

		this.clearTotals();
	},

	clearTotals: function () {
		this.data.todayPv = null;
		this.data.todayConsumption = null;
		this.data.todayGridImport = null;
		this.data.todayGridExport = null;
		this.data.todayBatteryCharge = null;
		this.data.todayBatteryDischarge = null;
		this.data.todayWallbox = null;
		this.data.autarky = null;
		this.data.autarkyWeek = null;
		this.data.autarkyAll = null;
	},

	/**
	 * Calculate autarky from house consumption and grid import
	 *
	 * @param {number} house - House consumption in W
	 * @param {number} grid - Grid value in W (positive = importing)
	 * @returns {number|null} Self-sufficiency in percent
	 */
	calcAutarky: function (house, grid) {
		if (!house || house <= 0) {
			return null;
		}
		var gridImport = grid > 0 ? grid : 0;
		var pct = (1 - gridImport / house) * 100;
		return Math.max(0, Math.min(100, pct));
	},

	/**
	 * Format watts for display
	 *
	 * @param {number} w - Power in watts
	 */
	formatPower: function (w) {
		var abs = Math.abs(w);
		if (abs >= 1000) {
			return `${(abs / 1000).toFixed(2)} kW`;
		}
		return `${Math.round(abs)} W`;
	},

	/**
	 * Format kWh for display
	 *
	 * @param {number} v - Value in kWh
	 */
	formatKwh: function (v) {
		if (v === null || v === undefined) {
			return "-";
		}
		return `${v.toFixed(1)} kWh`;
	},

	/**
	 * Resolve battery capacity in kWh: API > Web > configured value
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {number|null} Capacity in kWh, or null when no source reports one
	 */
	resolveBatteryCapacity: function (states) {
		// API SystemDetails
		var pfx = this.apiPrefix();
		if (pfx) {
			var sysPfx = pfx.replace("Dashboard.", "SystemDetails.");
			var apiCap = this.getStateOrNull(states, `${sysPfx}batteryPack.maxCapacityInKwh`);
			if (apiCap && apiCap > 0) {
				return apiCap;
			}
		}

		// Web AccuState
		var webCap = this.getStateOrNull(states, "_meinsenec.AccuState.capacity");
		if (webCap && webCap > 0) {
			return webCap;
		}

		// An explicitly configured capacity, which the user typed and the cloud sources above do
		// not have.
		var configCap = app.config.battery_capacity;
		if (configCap && configCap > 0) {
			return configCap;
		}

		// No fallback to `_openapi.bessNameplate.designCapacity`. It is one module rather than
		// the pack — measured, see docs/LOCAL_OPENAPI_4424.md — and the module count is only
		// readable from lala.cgi or the App API, so on an OpenAPI-only instance the pack size
		// cannot be derived from it. Using it halved every time-to-full and time-to-empty on
		// the two-module appliance it was measured on. No estimate is better than a wrong one;
		// the figure is still shown, labelled as per-module, on the Local OpenAPI card.
		return null;
	},

	/**
	 * Get the last update time for the active energy flow source
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string|null} Formatted time or null
	 */
	getLastUpdateTime: function (states) {
		var isoStr = null;

		if (this.activeSource === "local") {
			isoStr = states["info.lastPoll.HighPrio"] || null;
		} else if (this.activeSource === "openapi") {
			// The complete-cycle marker, not `lastPoll`: the connector stamps that one as soon as
			// any one section answered, so a cycle whose meter route failed would report the
			// current time next to a diagram holding the previous cycle's meter values.
			// No fallback to `lastPoll` on purpose: an install whose meter route keeps failing
			// would otherwise keep reporting a fresh time forever, which is the thing being fixed.
			// Showing no time is the honest answer, and the Local OpenAPI card carries the detail.
			isoStr = states["_openapi.info.lastCompletePoll"] || null;
		} else if (this.activeSource === "api") {
			isoStr = states["_api.info.lastPoll.Dashboard"] || null;
		} else if (this.activeSource === "web") {
			isoStr = states["_meinsenec.info.lastPoll.Status"] || null;
		}

		if (!isoStr) {
			return null;
		}

		var d = new Date(isoStr);
		if (isNaN(d.getTime())) {
			return null;
		}

		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
	},

	/**
	 * Format hours as "Xh Ym"
	 *
	 * @param {number} hours - Duration in hours
	 */
	formatTime: function (hours) {
		if (hours <= 0 || !isFinite(hours)) {
			return null;
		}
		if (hours > 99) {
			return ">99h";
		}
		var h = Math.floor(hours);
		var m = Math.round((hours - h) * 60);
		if (m === 60) {
			h++;
			m = 0;
		}
		if (h === 0) {
			return `${m}m`;
		}
		if (m === 0) {
			return `${h}h`;
		}
		return `${h}h ${m}m`;
	},

	/**
	 * Estimate battery time remaining or time to full
	 *
	 * @param {number} soc - state of charge (0-100)
	 * @param {number} capacity - battery capacity in Wh
	 * @param {number} power - current charge/discharge power in W
	 */
	getBatteryTimeEstimate: function (soc, capacity, power) {
		// Use passed params or fall back to main battery data
		var s = soc !== undefined ? soc : this.data.soc;
		var cap = capacity !== undefined ? capacity : this.data.batteryCapacity;
		var powerW = power !== undefined ? power : this.data.battery;
		if (s === null || cap === null || cap <= 0) {
			return null;
		}
		var absW = Math.abs(powerW);
		if (absW < 50) {
			return null;
		} // below noise threshold

		if (powerW < 0) {
			// Discharging — time until empty
			var remainKwh = (cap * s) / 100;
			var hours = remainKwh / (absW / 1000);
			var formatted = this.formatTime(hours);
			return formatted ? t("battery_until_empty", { time: formatted }) : null;
		}
		// Charging — time until full
		var neededKwh = (cap * (100 - s)) / 100;
		var hoursToFull = neededKwh / (absW / 1000);
		var fmtd = this.formatTime(hoursToFull);
		return fmtd ? t("battery_until_full", { time: fmtd }) : null;
	},

	/**
	 * Render the energy flow SVG + today's summary
	 *
	 * @param {string} [modeBadge] - HTML for operating mode badge
	 */
	render: function (modeBadge) {
		if (!this.hasData) {
			return `<div class="card"><h2>${t("energy_flow")}</h2>${
				modeBadge || ""
			}<div class="stat-label">${t("energy_no_data")}</div></div>`;
		}

		var d = this.data;
		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("energy_flow")}</h2>`;
		html += '<div class="energy-source">';
		html += '<select id="energy-source" onchange="energyFlow.onSourceChange(this.value)">';
		html += `<option value="auto"${this.source === "auto" ? " selected" : ""}>Auto</option>`;
		html += `<option value="local"${this.source === "local" ? " selected" : ""}>Local</option>`;
		html += `<option value="openapi"${this.source === "openapi" ? " selected" : ""}>OpenAPI</option>`;
		html += `<option value="api"${this.source === "api" ? " selected" : ""}>API</option>`;
		html += `<option value="web"${this.source === "web" ? " selected" : ""}>Web</option>`;
		html += "</select>";
		html += `<span class="energy-source-label">${t(this.activeSource ? "energy_source_via" : "energy_source_none", {
			source: this.activeSource || "",
		})}</span>`;
		// Last update from the active connector
		var lastUpdate = this.getLastUpdateTime(app.states);
		if (lastUpdate) {
			html += `<span class="energy-source-label">${t("energy_last_update", { time: lastUpdate })}</span>`;
		}
		// Beside the time, not instead of it. The time shown for the OpenAPI is the last
		// *complete* cycle's, so a partial cycle displays a stale one — and as an `else if` this
		// warning only ever appeared on an install that had never completed a cycle at all,
		// which is the one case where the stale time is not the problem. The question is whether
		// the latest cycle served every section, which is what openapiCycleComplete answers.
		if (
			this.activeSource === "openapi" &&
			app.states["_openapi.info.lastPoll"] &&
			!this.openapiCycleComplete(app.states)
		) {
			html += `<span class="energy-source-label" style="color:#ff9800">${t("energy_partial_cycle")}</span>`;
		}
		html += "</div></div>";

		// Operating mode badge + current autarky
		if (modeBadge || d.autarkyCurrent !== null) {
			html += '<div class="energy-status-row">';
			if (modeBadge) {
				html += modeBadge;
			}
			if (d.autarkyCurrent !== null) {
				html += `<div class="system-mode-badge" style="border-color:#157c00;color:#157c00">${t("autarky_now")}: ${Math.round(d.autarkyCurrent)}%</div>`;
			}
			html += "</div>";
		}

		// SVG energy flow diagram
		html += this.renderFlowDiagram(d);

		// Today's totals
		html += this.renderDayTotals(d);

		html += "</div>";
		return html;
	},

	// SVG icon paths (compact)
	icons: {
		sun: "M12 2v2m0 16v2m-8-10H2m20 0h-2m-2.93-6.07l-1.41 1.41M7.05 16.95l-1.41 1.41m0-12.73l1.41 1.41m9.9 9.9l1.41 1.41M12 6a6 6 0 100 12 6 6 0 000-12z",
		house: "M3 12l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-4v6H6a1 1 0 01-1-1v-9z",
		grid: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
		battery: "M6 7h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zm16 3v4",
		wallbox: "M5 3v18l7-3 7 3V3H5zm4 4h6m-6 3h6m-6 3h4",
	},

	renderFlowDiagram: function (d) {
		// Individual external PV sources
		var pvSources = [];
		var extPvPower = 0;
		for (var epi = 0; epi < d.externalPv.length; epi++) {
			var pvPow = Math.abs(d.externalPv[epi].power);
			extPvPower += pvPow;
			if (pvPow > 10) {
				pvSources.push({
					power: pvPow,
					label: d.externalPv[epi].label || `Ext. PV ${epi + 1}`,
				});
			}
		}
		var hasSeparatePv = pvSources.length > 0;

		// Individual consumers (each gets its own node — preserve sign for flow direction)
		var consumers = [];
		for (var ewi = 0; ewi < d.externalConsumer.length; ewi++) {
			var conPower = d.externalConsumer[ewi].power;
			if (Math.abs(conPower) > 10) {
				consumers.push({
					power: conPower,
					label: d.externalConsumer[ewi].label || `Consumer ${ewi + 1}`,
				});
			}
		}

		// Individual external batteries
		var batSources = [];
		for (var ebi = 0; ebi < d.externalBattery.length; ebi++) {
			var batPow = d.externalBattery[ebi].power;
			if (Math.abs(batPow) > 10) {
				batSources.push({
					power: batPow,
					label: d.externalBattery[ebi].label || `Ext. Bat ${ebi + 1}`,
					soc: d.externalBattery[ebi].soc,
					capacity: d.externalBattery[ebi].capacity,
				});
			}
		}
		var hasWallbox = d.wallbox > 10 || d.todayWallbox > 0;

		// Total PV for flow math (includes all PV regardless of mode — separate PV still produces)
		var totalPv = d.pv + extPvPower;

		// Collect right-side nodes (branch from house)
		var rightNodeList = [];
		if (hasWallbox) {
			rightNodeList.push("wallbox");
		}
		for (var ci = 0; ci < consumers.length; ci++) {
			rightNodeList.push(`consumer_${ci}`);
		}

		// Collect bottom nodes
		var bottomNodeList = ["battery"];
		for (var bni = 0; bni < batSources.length; bni++) {
			bottomNodeList.push(`extBat_${bni}`);
		}

		// Zigzag layout: single column, alternating left/right indent
		// Horizontal row layout: fills a row, overflow wraps to next row
		// direction: -1 = overflow upward (PV), +1 = overflow downward (batteries)
		var rowLayout = function (count, anchorX, anchorY, spaceX, rowSpaceY, maxPerRow, direction) {
			var perRow = Math.min(count, maxPerRow);
			var rows = Math.ceil(count / perRow);
			var positions = [];
			var placed = 0;
			for (var row = rows - 1; row >= 0; row--) {
				var inRow = Math.min(perRow, count - placed);
				var rowW = (inRow - 1) * spaceX;
				for (var col = 0; col < inRow; col++) {
					positions.push({
						x: anchorX - rowW / 2 + col * spaceX,
						y: anchorY + row * rowSpaceY * direction,
					});
					placed++;
				}
			}
			return positions;
		};

		// Zigzag layout for right-side nodes (consumers)
		var zigzagLayout = function (count, anchorX, anchorY, indentX, spaceY) {
			var positions = [];
			for (var gi = 0; gi < count; gi++) {
				positions.push({
					x: anchorX + (gi % 2 === 1 ? indentX : 0),
					y: anchorY + (gi - (count - 1) / 2) * spaceY,
				});
			}
			return positions;
		};

		// Sizing
		var topPvCount = hasSeparatePv ? 1 + pvSources.length : 0;
		var rightCount = rightNodeList.length;
		var bottomCount = bottomNodeList.length;
		var pvMaxPerRow = 4;
		var batMaxPerRow = 4;
		var pvRows = hasSeparatePv ? Math.ceil(topPvCount / pvMaxPerRow) : 0;
		var batRows = Math.ceil(bottomCount / batMaxPerRow);

		// SVG dimensions
		var extraRight = rightCount > 0 ? 140 : 0;
		var pvRowW = hasSeparatePv ? Math.min(topPvCount, pvMaxPerRow) * 140 + 100 : 0;
		var batRowW = Math.min(bottomCount, batMaxPerRow) * 100 + 100;
		var baseW = Math.max(520, pvRowW, batRowW);
		var w = baseW + extraRight;
		var extraTop = pvRows > 0 ? pvRows * 80 + 10 : 0;
		var extraBottom = batSources.length > 0 ? 90 + (batRows - 1) * 80 : batRows > 1 ? (batRows - 1) * 80 : 0;
		var rightH = rightCount > 1 ? (rightCount - 1) * 80 : 0;
		var baseH = Math.max(380, 280 + rightH);
		var h = baseH + extraTop + extraBottom;
		var coreW = w - extraRight;
		var cx = coreW / 2;
		var topY = extraTop + 55;
		var cy = extraTop + 190;

		// Node positions — diamond core
		var nodes = {};
		if (hasSeparatePv) {
			// PV sources in rows, bottom row at y=extraTop-25, overflow upward
			var pvBaseY = extraTop - 25;
			var pvPos = rowLayout(topPvCount, cx, pvBaseY, 140, 80, pvMaxPerRow, -1);
			nodes.senecPv = pvPos[0];
			for (var pni = 0; pni < pvSources.length; pni++) {
				nodes[`extPv_${pni}`] = pvPos[pni + 1];
			}
			nodes.pv = { x: cx, y: topY }; // production node
		} else {
			nodes.pv = { x: cx, y: topY };
		}
		nodes.grid = { x: 80, y: cy };
		nodes.house = { x: coreW - 80, y: cy };

		// Bottom nodes — batteries
		var hasBatSummary = batSources.length > 0;
		if (hasBatSummary) {
			// Summary node at the diamond position, individual batteries below
			nodes.batSummary = { x: cx, y: baseH + extraTop - 75 };
			var batIndY = baseH + extraTop - 75 + 90;
			var botPos = rowLayout(bottomCount, cx, batIndY, 120, 80, batMaxPerRow, 1);
			for (var bi = 0; bi < bottomNodeList.length; bi++) {
				nodes[bottomNodeList[bi]] = botPos[bi];
			}
		} else {
			nodes[bottomNodeList[0]] = { x: cx, y: baseH + extraTop - 75 };
		}

		// Right-side nodes — zigzag to the right of house
		if (rightCount > 0) {
			var rightAnchorX = coreW + extraRight / 2 - 20;
			var rPos = zigzagLayout(rightCount, rightAnchorX, cy, 40, 80);
			for (var ri = 0; ri < rightNodeList.length; ri++) {
				nodes[rightNodeList[ri]] = rPos[ri];
			}
		}

		var svg = `<svg class="energy-flow-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

		// Defs — filters for glow effects
		svg += "<defs>";
		svg += '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">';
		svg += '<feGaussianBlur stdDeviation="3" result="blur"/>';
		svg += '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>';
		svg += "</filter>";
		svg += '<filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">';
		svg += '<feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.1"/>';
		svg += "</filter>";
		svg += "</defs>";

		// Flow paths (curved, behind nodes)
		var gridExport = d.grid < 0 ? Math.abs(d.grid) : 0;
		var gridImport = d.grid > 0 ? d.grid : 0;
		var batDischarge = d.battery < 0 ? Math.abs(d.battery) : 0;
		var batCharge = d.battery > 0 ? d.battery : 0;

		// Flow math uses totalPv (SENEC + external) for allocation
		var pvToHouse = Math.min(totalPv, d.house);
		var pvToBat = Math.min(batCharge, Math.max(0, totalPv - pvToHouse));
		var pvToGrid = Math.max(0, totalPv - pvToHouse - pvToBat);

		var houseRemaining = Math.max(0, d.house - pvToHouse);
		var gridToHouse = Math.min(gridImport, houseRemaining);
		var batToHouse = Math.min(batDischarge, Math.max(0, houseRemaining - gridToHouse));
		var batToGrid = Math.max(0, Math.min(gridExport - pvToGrid, batDischarge - batToHouse));
		var gridToBat = Math.min(Math.max(0, gridImport - gridToHouse), Math.max(0, batCharge - pvToBat));

		// The PV flow origin node — production node if separate PV, else PV node
		var pvFlowOrigin = nodes.pv;

		// Separate PV: each source → Production node
		if (hasSeparatePv) {
			if (d.pv > 10) {
				svg += this.renderCurvedFlow(nodes.senecPv, nodes.pv, "#f9a825", d.pv);
			}
			for (var pvfi = 0; pvfi < pvSources.length; pvfi++) {
				var pvfNode = nodes[`extPv_${pvfi}`];
				if (pvfNode && pvSources[pvfi].power > 10) {
					svg += this.renderCurvedFlow(pvfNode, nodes.pv, "#f9a825", pvSources[pvfi].power);
				}
			}
		}

		// The battery flow node — summary if external batteries, else direct
		var batFlowNode = hasBatSummary ? nodes.batSummary : nodes.battery;

		// Production/PV → House, Battery, Grid
		if (pvToHouse > 10) {
			svg += this.renderCurvedFlow(pvFlowOrigin, nodes.house, "#f9a825", pvToHouse);
		}
		if (pvToBat > 10) {
			svg += this.renderCurvedFlow(pvFlowOrigin, batFlowNode, "#f9a825", pvToBat, -30);
		}
		if (pvToGrid > 10) {
			svg += this.renderCurvedFlow(pvFlowOrigin, nodes.grid, "#42a5f5", pvToGrid, 30);
		}
		if (batToHouse > 10) {
			svg += this.renderCurvedFlow(batFlowNode, nodes.house, "#4caf50", batToHouse);
		}
		if (batToGrid > 10) {
			svg += this.renderCurvedFlow(batFlowNode, nodes.grid, "#42a5f5", batToGrid, 30);
		}
		if (gridToBat > 10) {
			svg += this.renderCurvedFlow(nodes.grid, batFlowNode, "#ef5350", gridToBat, 30);
		}
		if (gridToHouse > 10) {
			svg += this.renderCurvedFlow(nodes.grid, nodes.house, "#ef5350", gridToHouse);
		}

		// House → Wallbox
		if (hasWallbox && d.wallbox > 10) {
			svg += this.renderCurvedFlow(nodes.house, nodes.wallbox, "#ab47bc", d.wallbox);
		}
		// House ↔ External consumers (direction follows power sign)
		for (var cfi = 0; cfi < consumers.length; cfi++) {
			var conNode = nodes[`consumer_${cfi}`];
			if (conNode && Math.abs(consumers[cfi].power) > 10) {
				if (consumers[cfi].power > 0) {
					svg += this.renderCurvedFlow(nodes.house, conNode, "#ff7043", consumers[cfi].power);
				} else {
					svg += this.renderCurvedFlow(conNode, nodes.house, "#4caf50", -consumers[cfi].power);
				}
			}
		}

		// Battery summary flows — individual batteries ↔ summary node (direction follows power sign)
		if (hasBatSummary) {
			// SENEC battery ↔ summary
			if (Math.abs(d.battery) > 10) {
				if (d.battery > 0) {
					svg += this.renderCurvedFlow(nodes.batSummary, nodes.battery, "#4caf50", d.battery);
				} else {
					svg += this.renderCurvedFlow(nodes.battery, nodes.batSummary, "#4caf50", -d.battery);
				}
			}
			// External batteries ↔ summary
			for (var bfi = 0; bfi < batSources.length; bfi++) {
				var batNode = nodes[`extBat_${bfi}`];
				var batPwr = batSources[bfi].power;
				if (batNode && Math.abs(batPwr) > 10) {
					if (batPwr > 0) {
						svg += this.renderCurvedFlow(nodes.batSummary, batNode, "#4caf50", batPwr);
					} else {
						svg += this.renderCurvedFlow(batNode, nodes.batSummary, "#4caf50", -batPwr);
					}
				}
			}
		}

		// Node circles — PV
		if (hasSeparatePv) {
			svg += this.renderNode(nodes.senecPv, "sun", "SENEC PV", this.formatPower(d.pv), "#f9a825", d.pv > 10);
			for (var pvni = 0; pvni < pvSources.length; pvni++) {
				var pvnNode = nodes[`extPv_${pvni}`];
				if (pvnNode) {
					svg += this.renderNode(
						pvnNode,
						"sun",
						pvSources[pvni].label,
						this.formatPower(pvSources[pvni].power),
						"#f9a825",
						pvSources[pvni].power > 10,
					);
				}
			}
			svg += this.renderNode(nodes.pv, "sun", t("energy_pv"), this.formatPower(totalPv), "#e6a200", totalPv > 10);
		} else {
			svg += this.renderNode(nodes.pv, "sun", t("energy_pv"), this.formatPower(d.pv), "#f9a825", d.pv > 10);
		}

		svg += this.renderNode(nodes.house, "house", t("energy_house"), this.formatPower(d.house), "#ff7043", true);
		if (hasBatSummary) {
			// Summary battery node (total power)
			var totalBatPower = d.battery;
			for (var tbi = 0; tbi < batSources.length; tbi++) {
				totalBatPower += batSources[tbi].power;
			}
			svg += this.renderBatteryNode(nodes.batSummary, null, totalBatPower, t("energy_battery"));
			// Individual SENEC battery
			svg += this.renderBatteryNode(nodes.battery, d.soc, d.battery, "SENEC");
		} else {
			svg += this.renderBatteryNode(nodes.battery, d.soc, d.battery);
		}
		svg += this.renderNode(
			nodes.grid,
			"grid",
			t("energy_grid"),
			this.formatPower(d.grid),
			d.grid > 0 ? "#ef5350" : d.grid < -10 ? "#42a5f5" : "#90a4ae",
			Math.abs(d.grid) > 10,
		);

		if (hasWallbox && (d.wallbox > 10 || d.todayWallbox > 0)) {
			svg += this.renderNode(
				nodes.wallbox,
				"wallbox",
				t("energy_wallbox"),
				this.formatPower(d.wallbox),
				"#ab47bc",
				d.wallbox > 10,
			);
		}
		for (var cni = 0; cni < consumers.length; cni++) {
			var conNodeR = nodes[`consumer_${cni}`];
			if (conNodeR) {
				svg += this.renderNode(
					conNodeR,
					"house",
					consumers[cni].label,
					this.formatPower(consumers[cni].power),
					"#ff7043",
					true,
				);
			}
		}
		// Node circles — external batteries
		for (var batni = 0; batni < batSources.length; batni++) {
			var batNNode = nodes[`extBat_${batni}`];
			if (batNNode) {
				var bCap = batSources[batni].capacity;
				svg += this.renderBatteryNode(
					batNNode,
					batSources[batni].soc,
					batSources[batni].power,
					batSources[batni].label,
					bCap > 0 ? bCap : null,
				);
			}
		}

		svg += "</svg>";
		return `<div class="energy-flow-wrap">${svg}</div>`;
	},

	renderNode: function (pos, icon, label, value, color, active) {
		var r = 36;
		var bgOpacity = active ? 0.12 : 0.05;
		var svg = `<g>`;

		// Outer glow when active
		if (active) {
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r + 4}" fill="${color}" opacity="0.08"/>`;
		}

		// Background circle
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="var(--color-card)" filter="url(#shadow)"/>`;
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="${color}" opacity="${bgOpacity}" stroke="${color}" stroke-width="${active ? 2.5 : 1.5}" stroke-opacity="${active ? 0.8 : 0.3}"/>`;

		// Icon
		svg += `<g transform="translate(${pos.x - 10}, ${pos.y - 24}) scale(0.83)" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
		svg += `<path d="${this.icons[icon]}"/>`;
		svg += `</g>`;

		// Value below
		svg += `<text x="${pos.x}" y="${pos.y + 10}" text-anchor="middle" fill="var(--color-text)" font-size="13" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${value}</text>`;

		// Label below circle
		svg += `<text x="${pos.x}" y="${pos.y + r + 16}" text-anchor="middle" fill="var(--color-text-secondary)" font-size="11" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${escHtml(label)}</text>`;

		svg += "</g>";
		return svg;
	},

	renderBatteryNode: function (pos, soc, power, customLabel, capacity) {
		var r = 36;
		var socRounded = soc !== null ? Math.round(soc) : null;
		var color = "#4caf50";
		var active = Math.abs(power) > 10;
		var isLow = socRounded !== null && socRounded <= 20;
		if (isLow) {
			color = "#ff9800";
		}

		var svg = "<g>";

		if (active) {
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r + 4}" fill="${color}" opacity="0.08"/>`;
		}

		// Background
		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="var(--color-card)" filter="url(#shadow)"/>`;

		// SOC fill — arc/clip approach
		if (socRounded !== null) {
			var fillH = (r * 2 * socRounded) / 100;
			var clipY = pos.y + r - fillH;
			var clipId = `bat-clip-${Math.random().toString(36).substr(2, 5)}`;
			svg += `<defs><clipPath id="${clipId}"><rect x="${pos.x - r}" y="${clipY}" width="${r * 2}" height="${fillH}"/></clipPath></defs>`;
			svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r - 1}" fill="${color}" opacity="0.15" clip-path="url(#${clipId})"/>`;
		}

		svg += `<circle cx="${pos.x}" cy="${pos.y}" r="${r}" fill="none" stroke="${color}" stroke-width="${active ? 2.5 : 1.5}" stroke-opacity="${active ? 0.8 : 0.3}"/>`;

		// Icon
		svg += `<g transform="translate(${pos.x - 10}, ${pos.y - 24}) scale(0.83)" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
		svg += `<path d="${this.icons.battery}"/>`;
		svg += `</g>`;

		// Power value (same position as other nodes)
		svg += `<text x="${pos.x}" y="${pos.y + 10}" text-anchor="middle" fill="var(--color-text)" font-size="13" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${this.formatPower(power)}</text>`;

		// Label below: "Battery · 86%"  + optional time estimate. Escaped at the sink below,
		// because an external battery contributes its configured name here and SVG text is as
		// happy to parse markup as HTML is.
		var label = customLabel || t("energy_battery");
		if (socRounded !== null) {
			label += ` \u00b7 ${socRounded}%`;
		}
		svg += `<text x="${pos.x}" y="${pos.y + r + 16}" text-anchor="middle" fill="var(--color-text-secondary)" font-size="11" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${escHtml(label)}</text>`;

		var timeEst = this.getBatteryTimeEstimate(soc, capacity, power);
		if (timeEst) {
			svg += `<text x="${pos.x}" y="${pos.y + r + 32}" text-anchor="middle" fill="#999999" font-size="11" font-style="italic" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${timeEst}</text>`;
		}

		svg += "</g>";
		return svg;
	},

	renderCurvedFlow: function (from, to, color, power, curveOffset) {
		if (Math.abs(power) < 1) {
			return "";
		}

		var thickness = Math.min(6, Math.max(2, Math.log10(Math.abs(power) + 1) * 1.5));
		var opacity = Math.min(0.9, Math.max(0.3, Math.abs(power) / 5000));

		// Control point for quadratic curve
		var mx = (from.x + to.x) / 2;
		var my = (from.y + to.y) / 2;
		var offset = curveOffset || 0;

		// Perpendicular offset for curve
		var dx = to.x - from.x;
		var dy = to.y - from.y;
		var len = Math.sqrt(dx * dx + dy * dy);
		if (len > 0 && offset) {
			mx += (-dy / len) * offset;
			my += (dx / len) * offset;
		}

		// Shorten path to not overlap with node circles (radius 36)
		var r = 38;
		var angle1 = Math.atan2(my - from.y, mx - from.x);
		var sx = from.x + r * Math.cos(angle1);
		var sy = from.y + r * Math.sin(angle1);
		var angle2 = Math.atan2(my - to.y, mx - to.x);
		var ex = to.x + r * Math.cos(angle2);
		var ey = to.y + r * Math.sin(angle2);

		var path = `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;

		// Glow under the main path
		var svg = `<path d="${path}" fill="none" stroke="${color}" stroke-width="${(thickness + 4).toFixed(1)}" stroke-opacity="${(opacity * 0.15).toFixed(2)}" stroke-linecap="round"/>`;

		// Main animated path
		svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="${thickness.toFixed(1)}" stroke-opacity="${opacity.toFixed(2)}" stroke-linecap="round" stroke-dasharray="8 6" class="flow-arrow"/>`;

		// Arrowhead at end
		var headAngle = Math.atan2(ey - my, ex - mx);
		var headLen = Math.min(10, thickness + 4);
		var ax = ex - headLen * Math.cos(headAngle - 0.35);
		var ay = ey - headLen * Math.sin(headAngle - 0.35);
		var bx = ex - headLen * Math.cos(headAngle + 0.35);
		var by = ey - headLen * Math.sin(headAngle + 0.35);
		svg += `<polygon points="${ex.toFixed(1)},${ey.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`;

		// Power label at curve midpoint
		var labelX = (sx + 2 * mx + ex) / 4;
		var labelY = (sy + 2 * my + ey) / 4;
		svg += `<text x="${labelX.toFixed(1)}" y="${(labelY - 4).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="10" font-weight="600" stroke="var(--color-bg)" stroke-width="3" paint-order="stroke">${this.formatPower(power)}</text>`;

		return svg;
	},

	periodLabel: function (p) {
		return t(`period_${p}`);
	},

	renderDayTotals: function (d) {
		var html = '<div class="day-totals">';
		html += '<div class="day-totals-header">';
		html += `<div class="day-totals-title">${this.periodLabel(this.period)}</div>`;
		html += '<div class="day-totals-tabs">';
		var periods = ["today", "month", "year"];
		for (var i = 0; i < periods.length; i++) {
			var p = periods[i];
			var cls = this.period === p ? "period-tab active" : "period-tab";
			html += `<button class="${cls}" onclick="energyFlow.onPeriodChange('${p}')">${this.periodLabel(
				p,
			)}</button>`;
		}
		html += "</div></div>";

		if (d.todayPv === null && d.todayConsumption === null) {
			html += `<div class="stat-label">${t("period_no_data", {
				period: this.periodLabel(this.period).toLowerCase(),
			})}</div>`;
			html += "</div>";
			return html;
		}

		html += '<div class="day-totals-grid">';

		html += this.renderTotalItem(t("total_pv"), d.todayPv, "#f9a825");
		html += this.renderTotalItem(t("total_consumption"), d.todayConsumption, "#ff7043");
		html += this.renderTotalItem(t("total_grid_import"), d.todayGridImport, "#f44336");
		html += this.renderTotalItem(t("total_grid_export"), d.todayGridExport, "#2196f3");
		html += this.renderTotalItem(t("total_battery_charge"), d.todayBatteryCharge, "#4caf50");
		html += this.renderTotalItem(t("total_battery_discharge"), d.todayBatteryDischarge, "#66bb6a");

		if (d.todayWallbox !== null && d.todayWallbox > 0) {
			html += this.renderTotalItem(t("total_wallbox"), d.todayWallbox, "#9c27b0");
		}

		if (d.autarky !== null) {
			var autarkyParts = [`${Math.round(d.autarky)}%`];
			if (d.autarkyWeek !== null && this.period === "today") {
				autarkyParts.push(`${t("period_week")}: ${Math.round(d.autarkyWeek)}%`);
			}
			if (d.autarkyAll !== null && this.period === "today") {
				autarkyParts.push(`${t("period_all")}: ${Math.round(d.autarkyAll)}%`);
			}
			html += this.renderTotalItem(t("total_self_sufficiency"), null, "#157c00", autarkyParts.join(" · "));
		}

		html += "</div></div>";
		return html;
	},

	renderTotalItem: function (label, value, color, customValue) {
		return (
			`<div class="day-total-item">` +
			`<div class="day-total-color" style="background:${color}"></div>` +
			`<div class="day-total-label">${label}</div>` +
			`<div class="day-total-value">${customValue || this.formatKwh(value)}</div>` +
			`</div>`
		);
	},

	/**
	 * Whether the OpenAPI's latest cycle delivered every section it asked for.
	 *
	 * The connector stamps both markers from one timestamp, so equality is exact: they differ
	 * only when a section failed or answered with nothing. A cycle that did not complete leaves
	 * some sections holding the previous cycle's values, which is why the flow is marked partial
	 * rather than presented as a measurement.
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {boolean} True when the last poll served every requested section
	 */
	openapiCycleComplete: function (states) {
		var polled = states["_openapi.info.lastPoll"];
		var complete = states["_openapi.info.lastCompletePoll"];
		return !!polled && complete === polled;
	},

	/**
	 * State ids that belong to each source, as a prefix or exact-id test.
	 *
	 * Used to decide whether an arriving state change should produce a chart sample: only the
	 * active source's own states may, or another connector's poll samples this one's data.
	 *
	 * The OpenAPI entry is deliberately only its complete-cycle marker, because its sections
	 * arrive as a dozen separate writes and no individual one of them is a whole reading.
	 *
	 * @param {string} src - Source name
	 * @param {string} shortId - State id without the adapter namespace
	 * @returns {boolean} Whether the state belongs to that source
	 */
	sourceOwnsState: function (src, shortId) {
		if (src === "openapi") {
			// The end-of-cycle markers, which the connector writes after the sections. Not the
			// individual section writes: they arrive a dozen at a time from separate requests,
			// and sampling on one of them pairs a fresh value with the rest of the previous
			// cycle. Both markers count because `lastCompletePoll` is written after `lastPoll`,
			// so it is the later of the two that carries a complete cycle — whether this one is
			// complete is a separate question, see openapiCycleComplete.
			return shortId === "_openapi.info.lastPoll" || shortId === "_openapi.info.lastCompletePoll";
		}
		if (src === "local") {
			return shortId.startsWith("ENERGY.GUI_") || shortId.startsWith("WALLBOX.");
		}
		if (src === "api") {
			return shortId.startsWith("_api.") && shortId.indexOf("currently.") !== -1;
		}
		if (src === "web") {
			return shortId.startsWith("_meinsenec.Status.");
		}
		return false;
	},

	onSourceChange: function (val) {
		this.source = val;
		// Before update(), so update()'s own activeSource-change reset does not fight this one.
		this.resetChart();
		this.update(app.states, app.connectors);
		// Unconditional, because the user may well have picked the source auto had already
		// resolved — in which case update() saw no change and re-armed nothing.
		this.rearmChart();
		app.renderDashboard();
	},

	onPeriodChange: function (val) {
		this.period = val;
		this.update(app.states, app.connectors);
		app.renderDashboard();
	},
};
