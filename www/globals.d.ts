/**
 * Global type declarations for the SENEC dashboard.
 * These browser-global variables are defined across multiple script files
 * loaded together via index.html. This file satisfies IDE type checking.
 *
 * Variables defined in the checked JS files (app.js, energy.js, livechart.js,
 * system.js, timeline.js, control.js, charts.js, i18n.js) are NOT re-declared
 * here to avoid TS2403 redeclaration conflicts — their types are inferred from
 * the source files. Only genuinely external globals belong here.
 */

/** Translation function (i18n.js) */
declare function t(key: string, params?: Record<string, string | number>): string;

/** socket.io client, loaded at runtime from ../socket.io/socket.io.js */
declare const io: { connect(url: string, opts?: Record<string, unknown>): any };

interface Window {
	/** Simulation harness, attached only when the page is opened with ?sim=true */
	_sim?: { apply(): void };
}

interface HTMLElement {
	/** Marks a listener as already attached, so a re-render does not bind it twice */
	_bound?: boolean;
}

interface HTMLCanvasElement {
	/** The statistics chart's own equivalent of `_bound`, on the canvas it binds to */
	_statsBound?: boolean;
}

/** Data point in the live chart buffer */
interface LiveChartPoint {
	ts: number;
	pv: number | null;
	battery: number | null;
	grid: number | null;
	house: number | null;
	wallbox: number | null;
	/** Battery state of charge in percent — drawn on its own right-hand axis */
	soc?: number | null;
}

/** Timeline event entry */
interface TimelineEvent {
	time: number;
	timeStr: string;
	level: string;
	category: string;
	message: string;
}
