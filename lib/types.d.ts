import type { AxiosInstance } from "axios";
import type { CookieJar } from "tough-cookie";
import type { AdapterClass } from "@iobroker/types/build/types";
import type AdaptiveRequestQueue from "./AdaptiveRequestQueue";

/**
 * The Senec adapter instance type.
 *
 * Extends the ioBroker AdapterClass with every dynamic property that
 * the Senec class sets at runtime (constructor + onReady + module code).
 * This gives lib modules full IDE autocomplete and compile-time typo
 * detection on all property accesses.
 */
export interface SenecAdapter extends AdapterClass {
    // ── Connection flags ──────────────────────────────────────────────
    apiConnected: boolean;
    lalaConnected: boolean;
    webConnected: boolean;
    connectEnabled: boolean;
    connectConnected: boolean;
    unloaded: boolean;
    connectVia: string;

    // ── Rebuild state ─────────────────────────────────────────────────
    rebuildRunning: boolean;
    rebuildStepsPerCycle: number;
    rebuildStepMaxRetries: number;
    rebuildRetryBaseDelayMs: number;
    rebuildFailures: Map<string, { attempts: number; nextTryAt: number; lastError: string }>;
    rebuildCompletedSteps: Set<string>;
    lastLoggedRebuildPendingSummary: string;
    rebuildInitializedForRun: boolean;
    rebuildForceFullRunActive: boolean;

    // ── API polling timing ────────────────────────────────────────────
    lastApiDashboardPoll: number;
    lastApiDetailsPoll: number;
    lastApiHeavyPoll: number;
    dashboardInterval: number;
    detailsInterval: number;
    heavyInterval: number;
    baseTime: number;
    timerAPI: ioBroker.Timeout | null;
    apiPollRunning: boolean;
    apiFailureCount: number;

    // ── API clients & infrastructure ──────────────────────────────────
    apiQueue: AdaptiveRequestQueue | null;
    apiAgent: import("node:https").Agent | null;
    apiClient: AxiosInstance | null;
    authClient: AxiosInstance | null;
    jar: any; // CookieJar — typed as any to avoid CJS/ESM type mismatch
    apiKnownSystems: Set<string>;
    abortController: AbortController;

    // ── API token state ───────────────────────────────────────────────
    currentToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: number;
    timerTokenRefresh: ioBroker.Timeout | null;
    tokenFailureCount: number;
    refreshPromise: Promise<void> | null;
    authBlocked: boolean;
    tokenBackoff: { baseDelayMs: number; maxDelayMs: number; maxMultiplier: number };

    // ── API wallbox state ─────────────────────────────────────────────
    apiWallboxCount: number;
    apiWallboxUuids: string[];
    apiWallboxObjects: Record<string, any>[];
    apiWallboxSystemId: string | null;

    // ── API logging dedup ─────────────────────────────────────────────
    lastLoggedRecommendedConcurrency: number | null;
    lastLoggedQueueSnapshot: string | null;

    // ── Web logging dedup ────────────────────────────────────────────
    _lastLoggedWebRecommendedConcurrency: number | null;
    _lastLoggedWebQueueSnapshot: string | null;

    // ── Local (lala.cgi) state ────────────────────────────────────────
    localAgent: import("node:https").Agent | null;
    localClient: AxiosInstance | null;
    socketCount: number | undefined;
    socketControlsCreated: boolean;
    wallboxCount: number | undefined;
    wallboxControlsCreated: boolean;
    highPrioObjects: Map<string, Set<string>>;
    lowPrioForm: string;
    highPrioForm: string;
    knownObjects: Map<string, object>;

    // ── Web (mein-senec.de) state ─────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webJar: any;
    webAuthenticated: boolean;
    webMasterPlantNumber: number | null;
    webSecondaryPlants: Map<string, { anlageNummer: number; produktName: string }>;
    webAbilities: Record<string, boolean>;
    webStatusIntervalMs: number;
    webMediumIntervalMs: number;
    webSlowIntervalMs: number;
    webQueue: AdaptiveRequestQueue | null;
    _webLastEmergencyPowerPoll: number | undefined;
    _webLastAccuStatePoll: number | undefined;
    _webLastPeakShavingPoll: number | undefined;
    _webLastSgReadyStatePoll: number | undefined;
    _webLastSgReadyConfPoll: number | undefined;
    _webLastSocketsPoll: number | undefined;
    _webLastMeasurementsMediumPoll: number | undefined;
    _webLastMeasurementsSlowPoll: number | undefined;
    webSocketData: object[] | null;
    webSocketControlsCreated: boolean;

    // ── SENEC.Connect state ───────────────────────────────────────────
    connectClient: AxiosInstance | null;

    // ── GUI / misc ────────────────────────────────────────────────────
    guiLang: string;

    // ── Shared adapter methods (defined in main.js class body) ────────
    evalPoll(obj: Record<string, any>, pfx: string, keyPrefix?: string): Promise<void>;
    doState(name: string, value: any, description: string, unit: string, write: boolean, read?: boolean): Promise<void>;
    logError(e: Error | string, prefix?: string): void;
    updateLastPoll(stateId: string, description: string): Promise<void>;
    updateConnectionStatus(): Promise<void>;
    delay(ms: number): Promise<void>;
    createSocketControlsForIndex(idx: number): Promise<void>;
    cleanupControlChannels(pattern: string, label: string): Promise<void>;
    buildUserAgent(): string;
    applyDefaultHeaders(client: AxiosInstance, userAgent: string): void;
    checkConfig(): void;
    refreshGuiLangCache(): Promise<void>;
    doDecode(name: string, value: string | number): Promise<void>;

    // ── Stub methods (delegated to lib modules, still on adapter during Phase 1) ──
    apiGet(url: string, config?: object): Promise<any>;
    apiPost(url: string, data?: object, config?: object): Promise<any>;
    apiPatch(url: string, data?: object, config?: object): Promise<any>;
    insertIntoAllTimeValueStore(sums: Record<string, number>, anlagenId: string | number, year: number): Promise<void>;
    readAllTimeValueStore(valueStore: string): Promise<Record<string, number> | object>;
    updateAllTimeHistory(anlagenId: string | number): Promise<void>;
    doMeasurementsYear(anlagenId: string | number, year: number, months: boolean, wallbox?: { uuid: string; index: number }): Promise<{ status: string }>;
    doMeasurementsMonth(anlagenId: string | number, date: Date, period: string, wallbox?: { uuid: string; index: number }): Promise<{ status: string }>;
    doMeasurementsDay(anlagenId: string | number, date: Date, period: string, wallbox?: { uuid: string; index: number }): Promise<{ status: string }>;
    doSumMeasurements(data: object, anlagenId: string | number, pfx: string, period: string): Promise<void>;
    summarizeMeasurementResults(results: Array<{ label: string; status: string }>): { success: number; no_data: number; skipped_existing: number; total: number };
    formatMeasurementSummary(summary: { success: number; no_data: number; skipped_existing: number; total: number }): string;
    classifyMeasurementSummary(summary: { success: number; no_data: number; skipped_existing: number; total: number }): string;
    formatMeasurementClassification(classification: string): string;
    doRebuild(anlagenId: string): Promise<void>;
    initializeForcedRebuildIfNeeded(): Promise<void>;
    getRebuildStartYear(): number;
    isRebuildEnabled(): boolean;
    isForceFullRebuildRequested(): boolean;
    getAllRebuildStepsForSystem(anlagenId: string): Array<{ year: number; monthly: boolean; wallbox?: { uuid: string; index: number } }>;
    getTotalRebuildStepsPerSystem(): number;
    clampEndDateToNow(endDate: Date): Date;
    buildMeasurementUrlAndPrefix(anlagenId: string | number, resolution: string, start: string, end: string, tier: string, wallbox?: { uuid: string; index: number }): { url: string; pfx: string };
    localSendControl(stateId: string, payload: string, description: string): Promise<void>;
    webLogin(deps?: object): Promise<boolean>;
    connectPoll(): Promise<void>;
    localPoll(isHighPrio: boolean, retry: number): Promise<void>;
    apiPoll(): Promise<void>;
    webInit(): Promise<void>;
}
