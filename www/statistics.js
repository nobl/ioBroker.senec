"use strict";

/* global app, t, document, window */
/* exported statsViewer */
/* eslint-disable jsdoc/check-tag-names -- @type annotations are required for TS type checking */

/**
 * Statistics viewer for the SENEC web dashboard.
 *
 * mein-senec.de offers a weekly CSV export at 5-minute resolution, reaching back years —
 * far more data than belongs in ioBroker states. So nothing here is stored: the adapter
 * polls only the index of available weeks, and this view asks it to fetch one week at a
 * time on demand. The adapter is lending its portal session to a page that cannot
 * authenticate itself; the data lives only as long as the tab is open.
 */

var statsViewer = {
	/** @type {Array<{n: number, name: string, device: string, polled: boolean, weeks: Array<{jahr: number, kw: number, von: number, bis: number}>}>} */
	plants: [],

	/** Selected plant number, null until the index arrives */
	/** @type {number|null} */
	plant: null,

	/** Selected week as "year-kw", null until chosen */
	/** @type {string|null} */
	week: null,

	/** Column headers of the loaded week */
	/** @type {string[]} */
	header: [],

	/** Timestamps of the loaded week */
	/** @type {number[]} */
	ts: [],

	/** Values of the loaded week, one array per row */
	/** @type {Array<Array<number|null>>} */
	rows: [],

	/** Day filter — "all" or a YYYY-MM-DD key */
	day: "all",

	/** Row resolution — "raw" (5 minutes) or "hourly" (means) */
	resolution: "hourly",

	/** Which value columns are shown, by index into header (0 is the timestamp) */
	/** @type {Record<number, boolean>} */
	visible: {},

	/** Sort column index, null for chronological */
	/** @type {number|null} */
	sortCol: null,

	/** Sort direction */
	sortDir: "asc",

	/** Display mode — "table" or "chart" */
	mode: "chart",

	/** Whether a fetch is in flight */
	loading: false,

	/** Increments per request so a late reply from a superseded fetch is ignored */
	_reqToken: 0,

	/** Row index under the pointer in the chart, null when not hovering */
	/** @type {number|null} */
	_hoverIdx: null,

	/** Chart geometry from the last paint, used for hit testing */
	/** @type {{xs: number[], rows: Array<{ts: number, label: string, v: Array<number|null>}>, cols: number[], padT: number, plotH: number}|null} */
	_chart: null,

	/** Last error, cleared on a successful load */
	/** @type {string|null} */
	error: null,

	/** Columns that are percentages rather than power — kept off the kW scale */
	_pctCols: {},

	/**
	 * Read the week index the adapter polls into states.
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {boolean} True when the plant list changed
	 */
	readPlants: function (states) {
		var found = {};
		for (var id in states) {
			var m = /^_meinsenec\.Statistics\.(\d+)\.(name|deviceNumber|polled|weeks)$/.exec(id);
			if (m) {
				var n = Number(m[1]);
				found[n] = found[n] || { n: n, name: "", device: "", polled: false, weeks: [] };
				if (m[2] === "name") {
					found[n].name = String(states[id] || "");
				} else if (m[2] === "deviceNumber") {
					found[n].device = String(states[id] || "");
				} else if (m[2] === "polled") {
					found[n].polled = !!states[id];
				} else if (m[2] === "weeks") {
					try {
						found[n].weeks = JSON.parse(String(states[id] || "[]"));
					} catch {
						found[n].weeks = [];
					}
				}
			}
		}
		var list = Object.keys(found)
			.map(Number)
			.sort(function (a, b) {
				return a - b;
			})
			.map(function (n) {
				return found[n];
			})
			.filter(function (p) {
				return p.weeks.length > 0;
			});

		var changed =
			JSON.stringify(list.map((p) => [p.n, p.weeks.length])) !==
			JSON.stringify(this.plants.map((p) => [p.n, p.weeks.length]));
		this.plants = list;

		// Preselect the plant this instance polls; fall back to the first with data
		if (this.plant === null && list.length) {
			var polled = list.filter(function (p) {
				return p.polled;
			})[0];
			this.plant = (polled || list[0]).n;
		}
		return changed;
	},

	/**
	 * The currently selected plant record.
	 *
	 * @returns {{n: number, name: string, device: string, polled: boolean, weeks: Array<{jahr: number, kw: number, von: number, bis: number}>}|null} Plant or null
	 */
	currentPlant: function () {
		for (var i = 0; i < this.plants.length; i++) {
			if (this.plants[i].n === this.plant) {
				return this.plants[i];
			}
		}
		return null;
	},

	/**
	 * Request one week from the adapter. Nothing is cached beyond the current selection.
	 *
	 * @returns {void}
	 */
	load: function () {
		var p = this.currentPlant();
		if (!p || !this.week || this.loading) {
			return;
		}
		var parts = this.week.split("-");
		this.loading = true;
		this.error = null;
		this.rows = [];
		this.ts = [];
		app.renderDashboard();

		// A message that never arrives would otherwise leave the view on "loading"
		// forever — most likely cause is the adapter not accepting messages at all.
		var token = ++this._reqToken;
		window.setTimeout(function () {
			if (statsViewer.loading && statsViewer._reqToken === token) {
				statsViewer.loading = false;
				statsViewer.error = t("stats_timeout");
				app.renderDashboard();
			}
		}, 60000);

		app.conn.emit(
			"sendTo",
			app.namespace,
			"statsCsv",
			{ anlageNummer: p.n, jahr: Number(parts[0]), woche: Number(parts[1]) },
			function (res) {
				if (statsViewer._reqToken !== token) {
					return; // a newer request superseded this one
				}
				statsViewer.loading = false;
				if (!res || res.error) {
					statsViewer.error = (res && res.error) || t("stats_load_failed");
				} else {
					var r = res.result || {};
					statsViewer.header = r.header || [];
					statsViewer.ts = r.ts || [];
					statsViewer.rows = r.rows || [];
					statsViewer.day = "all";
					statsViewer.sortCol = null;
					statsViewer._initColumns();
				}
				app.renderDashboard();
			},
		);
	},

	/**
	 * Pick the initially visible columns and remember which are percentages.
	 *
	 * Power and percentage columns are shown; battery voltage and current are not.
	 * They are neither — around 51 V and -74 A, they would stretch the chart's kW axis
	 * to roughly -75..55 and flatten every power curve into a line near zero. Both stay
	 * one click away.
	 */
	_initColumns: function () {
		this._pctCols = {};
		for (var j = 1; j < this.header.length; j++) {
			if (/\[%\]/.test(this.header[j])) {
				this._pctCols[j] = true;
			}
		}
		if (Object.keys(this.visible).length === 0) {
			for (var i = 1; i < this.header.length; i++) {
				this.visible[i] = /\[(kW|%)\]/.test(this.header[i]);
			}
		}
	},

	/**
	 * Local day key for a timestamp.
	 *
	 * @param {number} ts - Epoch ms
	 * @returns {string} YYYY-MM-DD
	 */
	_dayKey: function (ts) {
		var d = new Date(ts);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	},

	/**
	 * Days present in the loaded week.
	 *
	 * @returns {string[]} Sorted day keys
	 */
	days: function () {
		var seen = {};
		for (var i = 0; i < this.ts.length; i++) {
			seen[this._dayKey(this.ts[i])] = true;
		}
		return Object.keys(seen).sort();
	},

	/**
	 * Rows after day filtering, resolution and sorting.
	 *
	 * Percentages are averaged when collapsing to hourly; everything else is a power
	 * reading, so it is averaged too — these are instantaneous kW, not counters.
	 *
	 * @returns {Array<{ts: number, label: string, v: Array<number|null>}>} Display rows
	 */
	view: function () {
		var out = [];
		var i;
		for (i = 0; i < this.ts.length; i++) {
			if (this.day !== "all" && this._dayKey(this.ts[i]) !== this.day) {
				continue;
			}
			out.push({ ts: this.ts[i], v: this.rows[i] });
		}

		if (this.resolution === "hourly") {
			var buckets = {};
			for (i = 0; i < out.length; i++) {
				var d = new Date(out[i].ts);
				d.setMinutes(0, 0, 0);
				var k = d.getTime();
				buckets[k] = buckets[k] || [];
				buckets[k].push(out[i].v);
			}
			out = Object.keys(buckets)
				.map(Number)
				.sort(function (a, b) {
					return a - b;
				})
				.map(function (k) {
					var set = buckets[k];
					var mean = [];
					for (var c = 0; c < statsViewer.header.length - 1; c++) {
						var sum = 0;
						var n = 0;
						for (var r = 0; r < set.length; r++) {
							if (set[r][c] != null) {
								sum += set[r][c];
								n++;
							}
						}
						mean.push(n ? Math.round((sum / n) * 1000) / 1000 : null);
					}
					return { ts: k, v: mean };
				});
		}

		for (i = 0; i < out.length; i++) {
			var dt = new Date(out[i].ts);
			out[i].label =
				this.day === "all"
					? `${dt.getDate()}.${String(dt.getMonth() + 1).padStart(2, "0")}. ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
					: `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
		}

		if (this.sortCol !== null) {
			var col = this.sortCol - 1;
			var dir = this.sortDir === "asc" ? 1 : -1;
			out.sort(function (a, b) {
				var x = a.v[col];
				var y = b.v[col];
				if (x == null && y == null) {
					return 0;
				}
				if (x == null) {
					return 1; // missing values sort last regardless of direction
				}
				if (y == null) {
					return -1;
				}
				return (x - y) * dir;
			});
		}
		return out;
	},

	/**
	 * Min, max and mean per visible column over the current view.
	 *
	 * @param {Array<{v: Array<number|null>}>} rows - Display rows
	 * @returns {Record<number, {min: number, max: number, mean: number}>} Stats by column index
	 */
	summary: function (rows) {
		var res = {};
		for (var c = 1; c < this.header.length; c++) {
			if (!this.visible[c]) {
				continue;
			}
			var min = Infinity;
			var max = -Infinity;
			var sum = 0;
			var n = 0;
			for (var r = 0; r < rows.length; r++) {
				var v = rows[r].v[c - 1];
				if (v == null) {
					continue;
				}
				if (v < min) {
					min = v;
				}
				if (v > max) {
					max = v;
				}
				sum += v;
				n++;
			}
			if (n) {
				res[c] = { min: min, max: max, mean: sum / n };
			}
		}
		return res;
	},

	// ── Interaction ──────────────────────────────────────────────────────────

	onPlantChange: function (v) {
		this.plant = Number(v);
		this.week = null;
		this.rows = [];
		this.ts = [];
		app.renderDashboard();
	},

	onWeekChange: function (v) {
		this.week = v || null;
		if (this.week) {
			this.load();
		} else {
			app.renderDashboard();
		}
	},

	setDay: function (d) {
		this.day = d;
		app.renderDashboard();
	},

	setResolution: function (r) {
		this.resolution = r;
		app.renderDashboard();
	},

	setMode: function (m) {
		this.mode = m;
		app.renderDashboard();
	},

	/**
	 * Move to an adjacent week. The portal lists newest first, so +1 goes back in time.
	 *
	 * @param {number} delta - Steps through the list
	 * @returns {void}
	 */
	stepWeek: function (delta) {
		var p = this.currentPlant();
		if (!p || !this.week) {
			return;
		}
		var idx = -1;
		for (var i = 0; i < p.weeks.length; i++) {
			if (`${p.weeks[i].jahr}-${p.weeks[i].kw}` === this.week) {
				idx = i;
				break;
			}
		}
		var next = idx + delta;
		if (idx < 0 || next < 0 || next >= p.weeks.length) {
			return;
		}
		this.week = `${p.weeks[next].jahr}-${p.weeks[next].kw}`;
		this.load();
	},

	/**
	 * Whether stepping in that direction is possible — used to disable the buttons.
	 *
	 * @param {number} delta - Steps through the list
	 * @returns {boolean} True when a week exists there
	 */
	canStep: function (delta) {
		var p = this.currentPlant();
		if (!p || !this.week) {
			return false;
		}
		for (var i = 0; i < p.weeks.length; i++) {
			if (`${p.weeks[i].jahr}-${p.weeks[i].kw}` === this.week) {
				return i + delta >= 0 && i + delta < p.weeks.length;
			}
		}
		return false;
	},

	toggleColumn: function (i) {
		this.visible[i] = !this.visible[i];
		app.renderDashboard();
	},

	sortBy: function (i) {
		if (this.sortCol === i) {
			if (this.sortDir === "asc") {
				this.sortDir = "desc";
			} else {
				this.sortCol = null; // third click restores chronological order
				this.sortDir = "asc";
			}
		} else {
			this.sortCol = i;
			this.sortDir = "asc";
		}
		app.renderDashboard();
	},

	/** Save the current view as CSV, honouring filters, resolution and column choice */
	download: function () {
		var rows = this.view();
		var cols = [];
		for (var c = 1; c < this.header.length; c++) {
			if (this.visible[c]) {
				cols.push(c);
			}
		}
		var lines = [["Time"].concat(cols.map((c) => this.header[c])).join(";")];
		for (var r = 0; r < rows.length; r++) {
			var line = [new Date(rows[r].ts).toISOString()];
			for (var i = 0; i < cols.length; i++) {
				var v = rows[r].v[cols[i] - 1];
				line.push(v == null ? "" : String(v).replace(".", ","));
			}
			lines.push(line.join(";"));
		}
		var blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
		var url = URL.createObjectURL(blob);
		var a = document.createElement("a");
		a.href = url;
		a.download = `senec-${this.plant}-${this.week}${this.day === "all" ? "" : `-${this.day}`}.csv`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	},

	/**
	 * Canvas placeholder for the chart — painted after the container is in the DOM.
	 *
	 * @returns {string} Canvas HTML
	 */
	_renderChart: function () {
		var rows = this.chronoView();
		if (rows.length < 2) {
			return `<div class="stat-label">${t("stats_no_columns")}</div>`;
		}
		return (
			`<div class="stat-label">${t("stats_rows", { count: rows.length })}</div>` +
			'<div class="chart-scroll"><canvas id="stats-canvas" width="1400" height="380" style="width:100%"></canvas></div>'
		);
	},

	/**
	 * Display rows in time order, ignoring the table sort — a chart with a sorted
	 * x axis would be meaningless.
	 *
	 * @returns {Array<{ts: number, label: string, v: Array<number|null>}>} Display rows
	 */
	chronoView: function () {
		var saved = this.sortCol;
		this.sortCol = null;
		var rows = this.view();
		this.sortCol = saved;
		return rows;
	},

	/**
	 * Paint the chart. Power columns share a left kW axis; percentage columns get their
	 * own right-hand 0-100 axis, so a charge level cannot distort the power scale.
	 *
	 * @returns {void}
	 */
	paintChart: function () {
		var canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-canvas"));
		if (!canvas) {
			return;
		}
		var ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}
		var rows = this.chronoView();
		if (rows.length < 2) {
			return;
		}

		var W = 1400;
		var H = 380;
		var padL = 60;
		var padT = 15;
		var padB = 35;
		var cols = [];
		var c;
		for (c = 1; c < this.header.length; c++) {
			if (this.visible[c]) {
				cols.push(c);
			}
		}
		var hasPct = cols.some((k) => this._pctCols[k]);
		var padR = hasPct ? 45 : 15;
		var plotW = W - padL - padR;
		var plotH = H - padT - padB;

		var dpr = window.devicePixelRatio || 1;
		canvas.width = W * dpr;
		canvas.height = H * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);

		// kW range across visible power columns only
		var yMin = 0;
		var yMax = 0;
		for (var r = 0; r < rows.length; r++) {
			for (var i = 0; i < cols.length; i++) {
				if (this._pctCols[cols[i]]) {
					continue;
				}
				var v = rows[r].v[cols[i] - 1];
				if (v == null) {
					continue;
				}
				if (v > yMax) {
					yMax = v;
				}
				if (v < yMin) {
					yMin = v;
				}
			}
		}
		if (yMax === yMin) {
			yMax = yMin + 1;
		}
		var pad = (yMax - yMin) * 0.1;
		yMax += pad;
		yMin -= pad;
		var range = yMax - yMin;

		// grid and axes
		ctx.strokeStyle = "#666";
		ctx.lineWidth = 0.5;
		ctx.font = "10px sans-serif";
		ctx.fillStyle = "#999";
		ctx.textBaseline = "middle";
		for (var g = 0; g <= 5; g++) {
			var yv = yMin + (range / 5) * g;
			var yp = padT + plotH - ((yv - yMin) / range) * plotH;
			ctx.beginPath();
			ctx.moveTo(padL, yp);
			ctx.lineTo(W - padR, yp);
			ctx.stroke();
			ctx.textAlign = "right";
			ctx.fillText(yv.toFixed(2), padL - 5, yp);
			if (hasPct) {
				ctx.textAlign = "left";
				ctx.fillStyle = "#00897b";
				ctx.fillText(`${Math.round((g / 5) * 100)}%`, W - padR + 5, yp);
				ctx.fillStyle = "#999";
			}
		}

		// x labels
		ctx.textAlign = "center";
		ctx.textBaseline = "alphabetic";
		var labelCount = Math.min(10, rows.length - 1);
		for (var xi = 0; xi <= labelCount; xi++) {
			var idx = Math.round((xi / labelCount) * (rows.length - 1));
			ctx.fillText(rows[idx].label, padL + (plotW / labelCount) * xi, H - 5);
		}

		// Geometry for hit testing — rebuilt on every paint
		var xs = [];
		for (var xp = 0; xp < rows.length; xp++) {
			xs.push(padL + (xp / (rows.length - 1)) * plotW);
		}
		this._chart = { xs: xs, rows: rows, cols: cols, padT: padT, plotH: plotH };

		// lines
		ctx.save();
		ctx.beginPath();
		ctx.rect(padL, padT, plotW, plotH);
		ctx.clip();
		for (var ci = 0; ci < cols.length; ci++) {
			var col = cols[ci];
			var pct = !!this._pctCols[col];
			ctx.strokeStyle = this._colColor(col);
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			var started = false;
			for (var p = 0; p < rows.length; p++) {
				var val = rows[p].v[col - 1];
				if (val == null) {
					started = false; // break the line across gaps rather than bridging them
					continue;
				}
				var x = padL + (p / (rows.length - 1)) * plotW;
				var y = pct ? padT + plotH - (val / 100) * plotH : padT + plotH - ((val - yMin) / range) * plotH;
				if (started) {
					ctx.lineTo(x, y);
				} else {
					ctx.moveTo(x, y);
					started = true;
				}
			}
			ctx.stroke();
		}
		ctx.restore();

		this._paintTooltip(ctx, W, padR);
		this._bindChart(canvas);
	},

	/**
	 * Vertical guide and a readout of every visible series at the hovered time.
	 *
	 * A multi-series chart is read by comparison, so snapping to the nearest time and
	 * showing all of them beats picking the single closest point.
	 *
	 * @param {CanvasRenderingContext2D} ctx - Canvas context
	 * @param {number} W - Canvas width
	 * @param {number} padR - Right padding
	 * @returns {void}
	 */
	_paintTooltip: function (ctx, W, padR) {
		var g = this._chart;
		if (!g || this._hoverIdx === null || this._hoverIdx >= g.rows.length) {
			return;
		}
		var row = g.rows[this._hoverIdx];
		var x = g.xs[this._hoverIdx];

		ctx.save();
		ctx.strokeStyle = "#888";
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 3]);
		ctx.beginPath();
		ctx.moveTo(x, g.padT);
		ctx.lineTo(x, g.padT + g.plotH);
		ctx.stroke();
		ctx.restore();

		var lines = [{ label: row.label, color: null }];
		for (var i = 0; i < g.cols.length; i++) {
			var v = row.v[g.cols[i] - 1];
			lines.push({
				label: `${this._shortHeader(g.cols[i])}: ${v == null ? "-" : this._fmt(v, g.cols[i])}`,
				color: this._colColor(g.cols[i]),
			});
		}

		ctx.font = "11px sans-serif";
		var wide = 0;
		for (var m = 0; m < lines.length; m++) {
			wide = Math.max(wide, ctx.measureText(lines[m].label).width);
		}
		var boxW = wide + 26;
		var boxH = lines.length * 15 + 8;
		var boxX = x + 12;
		var boxY = g.padT + 8;
		if (boxX + boxW > W - padR) {
			boxX = x - 12 - boxW;
		}

		ctx.save();
		ctx.fillStyle = "rgba(0,0,0,0.82)";
		ctx.fillRect(boxX, boxY, boxW, boxH);
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		for (var l = 0; l < lines.length; l++) {
			var ly = boxY + 12 + l * 15;
			if (lines[l].color) {
				ctx.fillStyle = lines[l].color;
				ctx.fillRect(boxX + 7, ly - 3, 6, 6);
			}
			ctx.fillStyle = "#fff";
			ctx.fillText(lines[l].label, boxX + (lines[l].color ? 19 : 7), ly);
		}
		ctx.restore();
	},

	/**
	 * Attach hover handlers. The canvas is replaced on every render, so this runs each
	 * paint; the listeners close over nothing and are discarded with the old element.
	 *
	 * @param {HTMLCanvasElement} canvas - Chart canvas
	 * @returns {void}
	 */
	_bindChart: function (canvas) {
		if (canvas._statsBound) {
			return;
		}
		canvas._statsBound = true;
		canvas.addEventListener("mousemove", function (e) {
			var g = statsViewer._chart;
			if (!g || !g.xs.length) {
				return;
			}
			var rect = canvas.getBoundingClientRect();
			var mx = ((e.clientX - rect.left) / rect.width) * 1400;
			var best = 0;
			for (var i = 1; i < g.xs.length; i++) {
				if (Math.abs(g.xs[i] - mx) < Math.abs(g.xs[best] - mx)) {
					best = i;
				}
			}
			if (statsViewer._hoverIdx !== best) {
				statsViewer._hoverIdx = best;
				statsViewer.paintChart();
			}
		});
		canvas.addEventListener("mouseleave", function () {
			if (statsViewer._hoverIdx !== null) {
				statsViewer._hoverIdx = null;
				statsViewer.paintChart();
			}
		});
	},

	// ── Rendering ────────────────────────────────────────────────────────────

	/**
	 * Render the statistics viewer.
	 *
	 * @param {object} states - ioBroker state values
	 * @returns {string} Card HTML
	 */
	render: function (states) {
		this.readPlants(states);

		var html = '<div class="card">';
		html += `<div class="energy-header"><h2>${t("stats_title")}</h2></div>`;

		html += `<div class="stats-note">${t("stats_note")}</div>`;

		if (!this.plants.length) {
			html += `<div class="stat-label">${t("stats_unavailable")}</div></div>`;
			return html;
		}

		html += '<div class="chart-toggles" style="align-items:center">';

		// Plant selector — pointless with a single plant, so it is left out entirely
		if (this.plants.length > 1) {
			html += '<select class="chart-compare-select" onchange="statsViewer.onPlantChange(this.value)">';
			for (var pi = 0; pi < this.plants.length; pi++) {
				var p = this.plants[pi];
				var sel = p.n === this.plant ? " selected" : "";
				html += `<option value="${p.n}"${sel}>${this._esc(p.name || `Plant ${p.n}`)}</option>`;
			}
			html += "</select>";
		}

		var plant = this.currentPlant();
		html += '<select class="chart-compare-select" onchange="statsViewer.onWeekChange(this.value)">';
		html += `<option value="">${t("stats_pick_week")}</option>`;
		for (var wi = 0; plant && wi < plant.weeks.length; wi++) {
			var w = plant.weeks[wi];
			var key = `${w.jahr}-${w.kw}`;
			html += `<option value="${key}"${key === this.week ? " selected" : ""}>${this._weekLabel(w)}</option>`;
		}
		html += "</select>";

		if (this.week) {
			var back = this.canStep(1) ? "" : " disabled";
			var fwd = this.canStep(-1) ? "" : " disabled";
			html += `<button class="chart-toggle" title="${t("stats_prev_week")}" onclick="statsViewer.stepWeek(1)"${back}>\u25c0</button>`;
			html += `<button class="chart-toggle" title="${t("stats_next_week")}" onclick="statsViewer.stepWeek(-1)"${fwd}>\u25b6</button>`;
		}

		if (this.rows.length) {
			html += `<button class="chart-toggle" onclick="statsViewer.download()">${t("stats_download")}</button>`;
		}
		html += "</div>";

		if (this.loading) {
			html += `<div class="stat-label">${t("stats_loading")}</div></div>`;
			return html;
		}
		if (this.error) {
			html += `<div class="stat-label" style="color:#c62828">${this._esc(this.error)}</div></div>`;
			return html;
		}
		if (!this.rows.length) {
			html += `<div class="stat-label">${t("stats_pick_week")}</div></div>`;
			return html;
		}

		// Day filter
		var days = this.days();
		html += '<div class="day-totals-tabs">';
		html += `<button class="period-tab${this.day === "all" ? " active" : ""}" onclick="statsViewer.setDay('all')">${t("stats_whole_week")}</button>`;
		for (var di = 0; di < days.length; di++) {
			var dd = new Date(`${days[di]}T00:00:00`);
			var lbl = `${dd.getDate()}.${String(dd.getMonth() + 1).padStart(2, "0")}.`;
			html += `<button class="period-tab${this.day === days[di] ? " active" : ""}" onclick="statsViewer.setDay('${days[di]}')">${lbl}</button>`;
		}
		html += "</div>";

		// Resolution
		html += '<div class="day-totals-tabs">';
		html += `<button class="period-tab${this.resolution === "hourly" ? " active" : ""}" onclick="statsViewer.setResolution('hourly')">${t("stats_hourly")}</button>`;
		html += `<button class="period-tab${this.resolution === "raw" ? " active" : ""}" onclick="statsViewer.setResolution('raw')">${t("stats_5min")}</button>`;
		html += `<button class="period-tab${this.mode === "table" ? " active" : ""}" style="margin-left:12px" onclick="statsViewer.setMode('table')">${t("stats_table")}</button>`;
		html += `<button class="period-tab${this.mode === "chart" ? " active" : ""}" onclick="statsViewer.setMode('chart')">${t("stats_chart")}</button>`;
		html += "</div>";

		// Column toggles
		html += '<div class="chart-toggles">';
		for (var ci = 1; ci < this.header.length; ci++) {
			var active = this.visible[ci] ? " active" : "";
			var colColor = this._colColor(ci);
			html +=
				`<button class="chart-toggle${active}" style="--toggle-color:${colColor}" onclick="statsViewer.toggleColumn(${ci})">` +
				`<span class="chart-toggle-dot" style="background:${colColor}"></span>${this._esc(this._shortHeader(ci))}</button>`;
		}
		html += "</div>";

		html += this.mode === "chart" ? this._renderChart() : this._renderTable();
		html += "</div>";
		return html;
	},

	/**
	 * Table with sortable headers and a summary row.
	 *
	 * @returns {string} Table HTML
	 */
	_renderTable: function () {
		var rows = this.view();
		var stats = this.summary(rows);
		var cols = [];
		for (var c = 1; c < this.header.length; c++) {
			if (this.visible[c]) {
				cols.push(c);
			}
		}
		if (!cols.length) {
			return `<div class="stat-label">${t("stats_no_columns")}</div>`;
		}

		var html = `<div class="stat-label">${t("stats_rows", { count: rows.length })}</div>`;
		html += '<div class="chart-scroll"><table class="chart-data-table"><thead><tr>';
		html += `<th>${t("stats_time")}</th>`;
		for (var i = 0; i < cols.length; i++) {
			var arrow = this.sortCol === cols[i] ? (this.sortDir === "asc" ? " \u25b2" : " \u25bc") : "";
			html += `<th style="cursor:pointer" onclick="statsViewer.sortBy(${cols[i]})">${this._esc(this._shortHeader(cols[i]))}${arrow}</th>`;
		}
		html += "</tr></thead><tbody>";

		for (var r = 0; r < rows.length; r++) {
			html += `<tr><td>${rows[r].label}</td>`;
			for (var k = 0; k < cols.length; k++) {
				var v = rows[r].v[cols[k] - 1];
				html += `<td>${v == null ? "" : this._fmt(v, cols[k])}</td>`;
			}
			html += "</tr>";
		}
		html += "</tbody><tfoot><tr>";
		html += `<th>${t("stats_summary")}</th>`;
		for (var s = 0; s < cols.length; s++) {
			var st = stats[cols[s]];
			html += `<th style="font-weight:normal;font-size:11px">${
				st
					? `${this._fmt(st.min, cols[s])} / ${this._fmt(st.mean, cols[s])} / ${this._fmt(st.max, cols[s])}`
					: ""
			}</th>`;
		}
		html += "</tr></tfoot></table></div>";
		html += `<div class="stat-label" style="font-size:11px">${t("stats_summary_hint")}</div>`;
		return html;
	},

	/**
	 * Format a value for its column.
	 *
	 * @param {number} v - Value
	 * @param {number} col - Column index
	 * @returns {string} Formatted value
	 */
	_fmt: function (v, col) {
		return this._pctCols[col] ? `${Math.round(v)}` : v.toFixed(3);
	},

	/**
	 * Strip the unit suffix so column chips stay short.
	 *
	 * @param {number} i - Column index
	 * @returns {string} Short header
	 */
	_shortHeader: function (i) {
		return String(this.header[i] || "").replace(/\s*\[.*\]$/, "");
	},

	/**
	 * Stable colour per column, reusing the chart palette.
	 *
	 * @param {number} i - Column index
	 * @returns {string} CSS colour
	 */
	_colColor: function (i) {
		var palette = [
			"#c62828",
			"#1565c0",
			"#e65100",
			"#2e7d32",
			"#00897b",
			"#f9a825",
			"#6d4c41",
			"#7e57c2",
			"#00897b",
		];
		return palette[(i - 1) % palette.length];
	},

	/**
	 * Label a week entry with its date range.
	 *
	 * @param {{jahr: number, kw: number, von: number, bis: number}} w - Week entry
	 * @returns {string} Label
	 */
	_weekLabel: function (w) {
		var f = function (ms) {
			var d = new Date(ms);
			return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
		};
		return w.von && w.bis ? `${w.jahr} KW${w.kw}  (${f(w.von)} – ${f(w.bis)})` : `${w.jahr} KW${w.kw}`;
	},

	/**
	 * Escape a value for HTML output — product names come from the portal.
	 *
	 * @param {string} str - Raw value
	 * @returns {string} Escaped value
	 */
	_esc: function (str) {
		return String(str == null ? "" : str)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	},
};
