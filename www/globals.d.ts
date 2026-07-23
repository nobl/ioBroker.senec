/**
 * Global type declarations for the SENEC dashboard.
 * These browser-global variables are defined across multiple script files
 * loaded together via index.html. This file satisfies IDE type checking.
 *
 * Variables defined in the checked JS files (energy.js, livechart.js,
 * system.js, timeline.js, control.js, charts.js, i18n.js) are NOT
 * re-declared here to avoid TS2403 redeclaration conflicts — their types
 * are inferred from JSDoc annotations in the source files.
 */

/** Translation function (i18n.js) */
declare function t(key: string, params?: Record<string, string | number>): string;

/** App controller (index.html — not checked by www/tsconfig) */
declare var app: {
	namespace: string;
	conn: any;
	states: Record<string, any>;
	config: Record<string, any>;
	connected: boolean;
	activeTab: string;
	connectors: Record<string, { label: string; stateId: string; active: boolean }>;
	renderDashboard(): void;
	renderConnectors(): void;
	setTlsStatus(msg: string, color: string): void;
	bindTlsUpload(): void;
	showError(msg: string): void;
	_tlsUploadActive?: boolean;
};

/** Log viewer (index.html — not checked by www/tsconfig) */
declare var logViewer: {
	onConfigLoaded(): void;
};

/** Data point in the live chart buffer */
interface LiveChartPoint {
	ts: number;
	pv: number | null;
	battery: number | null;
	grid: number | null;
	house: number | null;
	wallbox: number | null;
}

/** Timeline event entry */
interface TimelineEvent {
	time: number;
	timeStr: string;
	level: string;
	category: string;
	message: string;
}
