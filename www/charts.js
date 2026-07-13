"use strict";

/* global app, t, energyFlow */
/* exported charts */

/**
 * Measurement bar charts for the SENEC web dashboard.
 * Renders SVG bar charts from hourly/daily/monthly measurement data.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var charts = {
	period: "today", // "today", "month", "year"
	webTypes: ["powergenerated", "consumption", "gridimport", "gridexport", "accuimport", "accuexport"],

	typeConfig: {
		powergenerated: { color: "#f9a825", labelKey: "total_pv" },
		consumption: { color: "#e65100", labelKey: "total_consumption" },
		gridimport: { color: "#c62828", labelKey: "total_grid_import" },
		gridexport: { color: "#1565c0", labelKey: "total_grid_export" },
		accuimport: { color: "#00897b", labelKey: "total_battery_discharge" },
		accuexport: { color: "#2e7d32", labelKey: "total_battery_charge" },
	},

	// Which types are visible (user can toggle)
	visible: {
		powergenerated: true,
		consumption: true,
		gridimport: false,
		gridexport: false,
		accuimport: false,
		accuexport: false,
	},

	stacked: false,
	compare: false,
	compareDay: "", // YYYY-MM-DD for custom day comparison
	compareMonth: "", // YYYY-MM for custom month comparison
	compareYear: 0, // year number for custom year comparison
	hasData: false,
	lastSource: "",

	/**
	 * Read chart data from states for the selected period
	 *
	 * @param states
	 */
	/**
	 * Find which years have measurement data in the states
	 *
	 * @param states
	 */
	findAvailableYears: function (states) {
		var years = {};
		for (var key in states) {
			var m = key.match(/_meinsenec\.Measurements\.Yearly\.(\d{4})\./);
			if (m) {
				years[m[1]] = true;
			}
			var m2 = key.match(/_api\.Anlagen\.[^.]+\.Measurements\.Yearly\.(\d{4})\./);
			if (m2) {
				years[m2[1]] = true;
			}
		}
		return Object.keys(years).map(Number).sort();
	},

	getData: function (states) {
		var result = { current: null, comparison: null, compLabel: "" };
		if (this.period === "today") {
			result.current = this.getHourlyData(states, "today");
			if (this.compare) {
				result.comparison = this.getHourlyData(states, "yesterday");
				result.compLabel = t("period_yesterday");
			}
		} else if (this.period === "month") {
			result.current = this.getDailyData(states, "current_month");
			if (this.compare) {
				result.comparison = this.getDailyData(states, "previous_month");
				result.compLabel = t("period_prev_month");
			}
		} else if (this.period === "year") {
			var year = new Date().getFullYear();
			result.current = this.getMonthlyData(states, year);
			if (this.compare) {
				var compYear = this.compareYear || year - 1;
				result.comparison = this.getMonthlyData(states, compYear);
				result.compLabel = String(compYear);
			}
		}
		this.hasData = !!result.current;
		return result;
	},

	detectSource: function (states, webTestKey, apiTestKey) {
		if (states[webTestKey] !== undefined) {
			this.lastSource = "Web";
			return "web";
		}
		if (apiTestKey && states[apiTestKey] !== undefined) {
			this.lastSource = "API";
			return "api";
		}
		this.lastSource = "";
		return null;
	},

	getHourlyData: function (states, dayKey) {
		var wpfx = `_meinsenec.Measurements.Daily.${dayKey}.`;
		var data = { labels: [], series: {} };

		var apiPfx = this.getApiMeasurementPrefix(states, `Daily.${dayKey}.hourly.`);
		var src = this.detectSource(
			states,
			`${wpfx}consumption.hourly.0`,
			apiPfx ? `${apiPfx}powerConsumptionInWh.0` : null,
		);
		var hasWeb = src === "web";
		var hasApi = src === "api";

		if (!hasWeb && !hasApi) {
			return null;
		}

		for (var h = 0; h < 24; h++) {
			data.labels.push(`${h}:00`);
		}

		if (hasWeb) {
			for (var i = 0; i < this.webTypes.length; i++) {
				var type = this.webTypes[i];
				data.series[type] = [];
				for (var hh = 0; hh < 24; hh++) {
					var val = states[`${wpfx + type}.hourly.${hh}`];
					data.series[type].push(val !== undefined && val !== null ? Number(val) : 0);
				}
			}
		} else if (hasApi) {
			this.loadApiHourly(states, apiPfx, data);
		}

		this.hasData = true;
		return data;
	},

	getDailyData: function (states, monthKey) {
		var wpfx = `_meinsenec.Measurements.Monthly.${monthKey}.`;
		var data = { labels: [], series: {} };

		var apiPfx = this.getApiMeasurementPrefix(states, `Monthly.${monthKey}.daily.`);
		var src = this.detectSource(
			states,
			`${wpfx}consumption.daily.1`,
			apiPfx ? `${apiPfx}powerConsumptionInWh.1` : null,
		);
		var hasWeb = src === "web";
		var hasApi = src === "api";

		if (!hasWeb && !hasApi) {
			return null;
		}

		var daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

		for (var d = 1; d <= daysInMonth; d++) {
			data.labels.push(String(d));
		}

		if (hasWeb) {
			for (var i = 0; i < this.webTypes.length; i++) {
				var type = this.webTypes[i];
				data.series[type] = [];
				for (var dd = 1; dd <= daysInMonth; dd++) {
					var val = states[`${wpfx + type}.daily.${dd}`];
					data.series[type].push(val !== undefined && val !== null ? Number(val) : 0);
				}
			}
		} else if (hasApi) {
			this.loadApiDaily(states, apiPfx, data, daysInMonth);
		}

		this.hasData = true;
		return data;
	},

	getMonthlyData: function (states, year) {
		var wpfx = `_meinsenec.Measurements.Yearly.${year}.`;
		var data = { labels: [], series: {} };

		var apiPfx = this.getApiMeasurementPrefix(states, `Yearly.${year}.monthly.`);
		var src = this.detectSource(
			states,
			`${wpfx}monthly.consumption.1`,
			apiPfx ? `${apiPfx}powerConsumptionInWh.1` : null,
		);
		var hasWeb = src === "web";
		var hasApi = src === "api";

		if (!hasWeb && !hasApi) {
			return null;
		}

		var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		for (var m = 0; m < 12; m++) {
			data.labels.push(monthNames[m]);
		}

		if (hasWeb) {
			for (var i = 0; i < this.webTypes.length; i++) {
				var type = this.webTypes[i];
				data.series[type] = [];
				for (var mm = 1; mm <= 12; mm++) {
					var val = states[`${wpfx}monthly.${type}.${mm}`];
					data.series[type].push(val !== undefined && val !== null ? Number(val) : 0);
				}
			}
		} else if (hasApi) {
			this.loadApiMonthly(states, apiPfx, data);
		}

		this.hasData = true;
		return data;
	},

	/**
	 * Get the API measurement state prefix
	 *
	 * @param states
	 * @param suffix
	 */
	getApiMeasurementPrefix: function (states, suffix) {
		var id = energyFlow.apiAnlagenId;
		if (!id) {
			return null;
		}
		return `_api.Anlagen.${id}.Measurements.${suffix}`;
	},

	/** API type name mapping to web types */
	apiTypeMap: {
		powerGenerationInWh: "powergenerated",
		powerConsumptionInWh: "consumption",
		gridDrawInWh: "gridimport",
		gridFeedInInWh: "gridexport",
		batteryChargeInWh: "accuexport",
		batteryDischargeInWh: "accuimport",
	},

	loadApiHourly: function (states, pfx, data) {
		for (var apiKey in this.apiTypeMap) {
			var webKey = this.apiTypeMap[apiKey];
			data.series[webKey] = [];
			for (var h = 0; h < 24; h++) {
				var val = states[`${pfx + apiKey}.${h}`];
				// API values are in Wh, convert to kWh
				data.series[webKey].push(val !== undefined && val !== null ? Number(val) / 1000 : 0);
			}
		}
	},

	loadApiDaily: function (states, pfx, data, days) {
		for (var apiKey in this.apiTypeMap) {
			var webKey = this.apiTypeMap[apiKey];
			data.series[webKey] = [];
			for (var d = 1; d <= days; d++) {
				var val = states[`${pfx + apiKey}.${d}`];
				data.series[webKey].push(val !== undefined && val !== null ? Number(val) / 1000 : 0);
			}
		}
	},

	loadApiMonthly: function (states, pfx, data) {
		for (var apiKey in this.apiTypeMap) {
			var webKey = this.apiTypeMap[apiKey];
			data.series[webKey] = [];
			for (var m = 1; m <= 12; m++) {
				var val = states[`${pfx + apiKey}.${m}`];
				data.series[webKey].push(val !== undefined && val !== null ? Number(val) / 1000 : 0);
			}
		}
	},

	/**
	 * Render the chart card
	 *
	 * @param states
	 */
	render: function (states) {
		var result = this.getData(states);

		var html = '<div class="card">';
		html += '<div class="energy-header">';
		html += `<h2>${t("chart_title")}</h2>`;
		html += '<div class="day-totals-tabs">';
		var periods = ["today", "month", "year"];
		var periodKeys = { today: "period_today", month: "period_month", year: "period_year" };
		for (var i = 0; i < periods.length; i++) {
			var p = periods[i];
			var cls = this.period === p ? "period-tab active" : "period-tab";
			html += `<button class="${cls}" onclick="charts.onPeriodChange('${p}')">${t(periodKeys[p])}</button>`;
		}
		// Data source indicator
		var chartSource = this.lastSource || "";
		if (chartSource) {
			html += `<span class="energy-source-label">${t("energy_source_via", { source: chartSource })}</span>`;
		}
		html += "</div></div>";

		// Type toggles
		html += '<div class="chart-toggles">';
		for (var j = 0; j < this.webTypes.length; j++) {
			var wt = this.webTypes[j];
			var cfg = this.typeConfig[wt];
			var active = this.visible[wt] ? " active" : "";
			html +=
				`<button class="chart-toggle${active}" ` +
				`style="--toggle-color:${cfg.color}" ` +
				`onclick="charts.toggleType('${wt}')">` +
				`<span class="chart-toggle-dot" style="background:${cfg.color}"></span>${t(cfg.labelKey)}</button>`;
		}
		var stackedCls = this.stacked ? " active" : "";
		html +=
			`<button class="chart-toggle${stackedCls}" style="--toggle-color:#757575" onclick="charts.toggleStacked()">` +
			`<span class="chart-toggle-dot" style="background:#757575"></span>${t("chart_stacked")}</button>`;
		var compareCls = this.compare ? " active" : "";
		html +=
			`<button class="chart-toggle${compareCls}" style="--toggle-color:#9e9e9e" onclick="charts.toggleCompare()">` +
			`<span class="chart-toggle-dot" style="background:#9e9e9e"></span>${t("chart_compare")}</button>`;

		// Year comparison selector
		if (this.compare && this.period === "year") {
			var years = this.findAvailableYears(app.states);
			var currentYear = new Date().getFullYear();
			var selYear = this.compareYear || currentYear - 1;
			html += ' <select class="chart-compare-select" onchange="charts.onCompareYearChange(this.value)">';
			for (var yi = 0; yi < years.length; yi++) {
				if (years[yi] !== currentYear) {
					html += `<option value="${years[yi]}"${years[yi] === selYear ? " selected" : ""}>${years[yi]}</option>`;
				}
			}
			html += "</select>";
		} else if (this.compare) {
			var compLabels = { today: "period_yesterday", month: "period_prev_month" };
			html += ` <span class="energy-source-label">${t(compLabels[this.period])}</span>`;
		}
		html += "</div>";

		if (!result.current) {
			html += `<div class="stat-label">${t("chart_no_data")}</div>`;
		} else {
			html += this.renderBarChart(result);
		}

		html += "</div>";
		return html;
	},

	// Production = energy supply: PV, grid import, battery discharge
	// Consumption = energy demand: house consumption, grid export (feed-in), battery charge
	productionTypes: ["powergenerated", "gridimport", "accuimport"],
	consumptionTypes: ["consumption", "gridexport", "accuexport"],

	renderBarChart: function (result) {
		var data = result.current;
		var compData = result.comparison;

		// Respect type toggles in both grouped and stacked mode
		var visibleTypes = [];
		for (var i = 0; i < this.webTypes.length; i++) {
			if (this.visible[this.webTypes[i]] && data.series[this.webTypes[i]]) {
				visibleTypes.push(this.webTypes[i]);
			}
		}

		if (visibleTypes.length === 0) {
			return `<div class="stat-label">${t("chart_select_type")}</div>`;
		}

		var labelCount = data.labels.length;
		var maxVal = this.calcMaxVal(data, compData, visibleTypes, labelCount);
		maxVal = this.niceMax(maxVal);

		// Layout — use wider viewBox, SVG scales to container via CSS
		var padL = 50,
			padR = 15,
			padT = 15,
			padB = 40;
		var barsPerGroup = this.stacked ? 2 : visibleTypes.length;
		var compMul = compData ? 2 : 1;
		var minBarW = this.stacked ? 28 * compMul + 8 : barsPerGroup * 14 * compMul + 8;
		var chartW = Math.max(600, labelCount * minBarW + padL + padR);
		var chartH = 280;
		var plotW = chartW - padL - padR;
		var plotH = chartH - padT - padB;
		var groupW = plotW / labelCount;

		var svg = `<svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" xmlns="http://www.w3.org/2000/svg">`;
		svg += this.renderAxis(padL, padR, padT, padB, chartW, chartH, plotH, maxVal);

		if (this.stacked) {
			svg += this.renderStacked(data, compData, visibleTypes, labelCount, padL, padT, plotH, groupW, maxVal);
		} else {
			svg += this.renderGrouped(data, compData, visibleTypes, labelCount, padL, padT, plotH, groupW, maxVal);
		}

		// X axis labels
		for (var li = 0; li < labelCount; li++) {
			var showLabel = labelCount <= 13 || li % Math.ceil(labelCount / 12) === 0;
			if (showLabel) {
				var labelX = padL + li * groupW + groupW / 2;
				svg += `<text x="${labelX.toFixed(1)}" y="${chartH - 5}" text-anchor="middle" fill="#999" font-size="10">${data.labels[li]}</text>`;
			}
		}

		svg += "</svg>";
		return `<div class="chart-scroll">${svg}</div>`;
	},

	calcMaxVal: function (data, compData, visibleTypes, labelCount) {
		var maxVal = 0;
		var datasets = [data];
		if (compData) {
			datasets.push(compData);
		}

		for (var di = 0; di < datasets.length; di++) {
			var ds = datasets[di];
			if (this.stacked) {
				for (var si = 0; si < labelCount; si++) {
					var prodSum = 0,
						consSum = 0;
					for (var sv = 0; sv < visibleTypes.length; sv++) {
						var vt = visibleTypes[sv];
						var vv = (ds.series[vt] && ds.series[vt][si]) || 0;
						if (this.productionTypes.indexOf(vt) !== -1) {
							prodSum += vv;
						}
						if (this.consumptionTypes.indexOf(vt) !== -1) {
							consSum += vv;
						}
					}
					if (prodSum > maxVal) {
						maxVal = prodSum;
					}
					if (consSum > maxVal) {
						maxVal = consSum;
					}
				}
			} else {
				for (var v = 0; v < visibleTypes.length; v++) {
					var series = ds.series[visibleTypes[v]];
					if (!series) {
						continue;
					}
					for (var s = 0; s < series.length; s++) {
						if (series[s] > maxVal) {
							maxVal = series[s];
						}
					}
				}
			}
		}
		return maxVal || 1;
	},

	renderAxis: function (padL, padR, padT, padB, chartW, chartH, plotH, maxVal) {
		var svg = "";
		var gridLines = 5;
		for (var g = 0; g <= gridLines; g++) {
			var yVal = (maxVal / gridLines) * g;
			var yPos = padT + plotH - (plotH * g) / gridLines;
			svg += `<line x1="${padL}" y1="${yPos}" x2="${chartW - padR}" y2="${yPos}" stroke="var(--color-border)" stroke-width="0.5"/>`;
			svg += `<text x="${padL - 5}" y="${yPos + 4}" text-anchor="end" fill="#999" font-size="10">${yVal.toFixed(yVal >= 10 ? 0 : 1)}</text>`;
		}
		svg += `<text x="12" y="${padT + plotH / 2}" text-anchor="middle" fill="#999" font-size="10" transform="rotate(-90,12,${padT + plotH / 2})">kWh</text>`;
		return svg;
	},

	renderStacked: function (data, compData, visibleTypes, labelCount, padL, padT, plotH, groupW, maxVal) {
		var svg = "";
		var visProd = [];
		var visCons = [];
		for (var vp = 0; vp < visibleTypes.length; vp++) {
			if (this.productionTypes.indexOf(visibleTypes[vp]) !== -1) {
				visProd.push(visibleTypes[vp]);
			}
			if (this.consumptionTypes.indexOf(visibleTypes[vp]) !== -1) {
				visCons.push(visibleTypes[vp]);
			}
		}

		var numStacks = compData ? 4 : 2; // prod+cons × (current + comparison)
		var stackBarW = Math.max(4, Math.min(16, (groupW - 6) / numStacks));
		var stackGap = 2;

		for (var li = 0; li < labelCount; li++) {
			var totalW = numStacks * stackBarW + (numStacks - 1) * stackGap;
			var baseX = padL + li * groupW + (groupW - totalW) / 2;
			var slotIdx = 0;

			// Comparison bars first (behind, semi-transparent)
			if (compData) {
				svg += this.renderOneStack(
					compData,
					visProd,
					li,
					baseX + slotIdx * (stackBarW + stackGap),
					stackBarW,
					padT,
					plotH,
					maxVal,
					0.35,
				);
				slotIdx++;
				svg += this.renderOneStack(
					compData,
					visCons,
					li,
					baseX + slotIdx * (stackBarW + stackGap),
					stackBarW,
					padT,
					plotH,
					maxVal,
					0.35,
				);
				slotIdx++;
			}

			// Current bars
			svg += this.renderOneStack(
				data,
				visProd,
				li,
				baseX + slotIdx * (stackBarW + stackGap),
				stackBarW,
				padT,
				plotH,
				maxVal,
				1.0,
			);
			slotIdx++;
			svg += this.renderOneStack(
				data,
				visCons,
				li,
				baseX + slotIdx * (stackBarW + stackGap),
				stackBarW,
				padT,
				plotH,
				maxVal,
				1.0,
			);
		}

		return svg;
	},

	renderOneStack: function (data, types, idx, barX, barW, padT, plotH, maxVal, opacity) {
		var svg = "";
		var stackY = padT + plotH;
		for (var ti = 0; ti < types.length; ti++) {
			var type = types[ti];
			var val = (data.series[type] && data.series[type][idx]) || 0;
			var barH = (val / maxVal) * plotH;
			if (barH > 0.5) {
				stackY -= barH;
				svg += `<rect x="${barX.toFixed(1)}" y="${stackY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${this.typeConfig[type].color}" opacity="${opacity}" rx="1">`;
				svg += `<title>${t(this.typeConfig[type].labelKey)}: ${val.toFixed(2)} kWh</title>`;
				svg += "</rect>";
			}
		}
		return svg;
	},

	renderGrouped: function (data, compData, visibleTypes, labelCount, padL, padT, plotH, groupW, maxVal) {
		var svg = "";
		var totalTypes = visibleTypes.length;
		var slotsPerType = compData ? 2 : 1;
		var barW = Math.max(3, Math.min(14, (groupW - 4) / (totalTypes * slotsPerType)));
		var barGap = 1;
		var totalBarW = totalTypes * slotsPerType * (barW + barGap) - barGap;

		for (var li = 0; li < labelCount; li++) {
			var groupX = padL + li * groupW + (groupW - totalBarW) / 2;
			var slotIdx = 0;

			for (var bi = 0; bi < totalTypes; bi++) {
				var type = visibleTypes[bi];
				var color = this.typeConfig[type].color;

				// Comparison bar (semi-transparent, before current)
				if (compData) {
					var cVal = (compData.series[type] && compData.series[type][li]) || 0;
					var cBarH = (cVal / maxVal) * plotH;
					var cBarX = groupX + slotIdx * (barW + barGap);
					if (cBarH > 0.5) {
						svg += `<rect x="${cBarX.toFixed(1)}" y="${(padT + plotH - cBarH).toFixed(1)}" width="${barW.toFixed(1)}" height="${cBarH.toFixed(1)}" fill="${color}" opacity="0.35" rx="1">`;
						svg += `<title>${t(this.typeConfig[type].labelKey)} (${t("chart_compare")}): ${cVal.toFixed(2)} kWh</title>`;
						svg += "</rect>";
					}
					slotIdx++;
				}

				// Current bar
				var val = data.series[type][li] || 0;
				var barH = (val / maxVal) * plotH;
				var barX = groupX + slotIdx * (barW + barGap);
				if (barH > 0.5) {
					svg += `<rect x="${barX.toFixed(1)}" y="${(padT + plotH - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="1">`;
					svg += `<title>${t(this.typeConfig[type].labelKey)}: ${val.toFixed(2)} kWh</title>`;
					svg += "</rect>";
				}
				slotIdx++;
			}
		}
		return svg;
	},

	/**
	 * Round up to a "nice" axis maximum
	 *
	 * @param val
	 */
	niceMax: function (val) {
		if (val <= 0) {
			return 1;
		}
		var magnitude = Math.pow(10, Math.floor(Math.log10(val)));
		var normalized = val / magnitude;
		if (normalized <= 1) {
			return magnitude;
		}
		if (normalized <= 2) {
			return 2 * magnitude;
		}
		if (normalized <= 5) {
			return 5 * magnitude;
		}
		return 10 * magnitude;
	},

	onPeriodChange: function (val) {
		this.period = val;
		app.renderDashboard();
	},

	toggleType: function (type) {
		this.visible[type] = !this.visible[type];
		app.renderDashboard();
	},

	toggleStacked: function () {
		this.stacked = !this.stacked;
		if (this.stacked) {
			// Stacked always shows all types — mark all visible
			for (var k in this.visible) {
				this.visible[k] = true;
			}
		}
		app.renderDashboard();
	},

	toggleCompare: function () {
		this.compare = !this.compare;
		app.renderDashboard();
	},

	onCompareYearChange: function (val) {
		this.compareYear = Number(val);
		app.renderDashboard();
	},
};
