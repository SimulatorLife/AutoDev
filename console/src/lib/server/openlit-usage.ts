/**
Server-only OpenLIT Usage adapter configuration and URL filter parsing.
*/

import path from "node:path";

import {
  isToolFailureCategory,
  safeAutoDevSessionId,
  type ToolFailureCategory,
  USAGE_VARIABLE_IDS,
  type UsageCustomRange,
  type UsageFilterSelection,
  type UsageHistoricalTimeRange,
  type UsageSessionQuerySelection,
  type UsageSessionSpanPagination,
  type UsageSessionSpanSortDirection,
  type UsageTimeRange,
  type UsageVariableId
} from "@simulatorlife/autodev-core";
import {
  type OpenLITSessionResult,
  type OpenLITTraceResult,
  OpenLITUsageClient,
  type OpenLITUsageResult
} from "@simulatorlife/autodev-data/usage";

import { readSecretFromFile } from "./secret-file.ts";

const DEFAULT_OPENLIT_USAGE_BASE_URL = "http://127.0.0.1:3000";
const TRAILING_SLASHES = /\/+$/u;
const VALID_RANGES = new Set<UsageTimeRange>([
  "24H",
  "7D",
  "1M",
  "3M",
  "CUSTOM",
  "ACTIVE_SESSIONS"
]);

export interface OpenLITUsageConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export type OpenLITUsageEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ConsoleUsageResult =
  OpenLITUsageResult | { readonly kind: "not-configured" };

export type ConsoleTraceResult =
  OpenLITTraceResult | { readonly kind: "not-configured" };

export type ConsoleSessionUsageResult =
  OpenLITSessionResult | { readonly kind: "not-configured" };

export function readOpenLITUsageConfig(
  environment: OpenLITUsageEnvironment = process.env
): OpenLITUsageConfig | null {
  let serviceToken = environment.AUTODEV_OPENLIT_USAGE_TOKEN?.trim() ?? "";
  if (!serviceToken) {
    const home = environment.HOME?.trim();
    const codexHome =
      environment.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : null);
    if (codexHome) {
      const secretFile =
        environment.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        path.join(codexHome, "openlit-secrets.env");
      serviceToken =
        readSecretFromFile(secretFile, "AUTODEV_OPENLIT_USAGE_TOKEN") ?? "";
    }
  }
  if (!serviceToken) return null;
  const baseUrl =
    environment.AUTODEV_OPENLIT_USAGE_URL?.trim() || DEFAULT_OPENLIT_USAGE_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

export function loadOpenLITUsage(
  selection: UsageFilterSelection,
  environment: OpenLITUsageEnvironment = process.env
): Promise<ConsoleUsageResult> {
  const config = readOpenLITUsageConfig(environment);
  if (!config) return Promise.resolve({ kind: "not-configured" });
  return new OpenLITUsageClient(config).query(selection);
}

export function loadOpenLITSessionUsage(
  sessionId: unknown,
  selection: UsageSessionQuerySelection,
  pagination: UsageSessionSpanPagination | undefined,
  environment: OpenLITUsageEnvironment = process.env
): Promise<ConsoleSessionUsageResult> {
  const config = readOpenLITUsageConfig(environment);
  if (!config) return Promise.resolve({ kind: "not-configured" });
  return new OpenLITUsageClient(config).querySession(
    sessionId,
    selection,
    pagination
  );
}

export function loadOpenLITTrace(
  spanId: string,
  environment: OpenLITUsageEnvironment = process.env
): Promise<ConsoleTraceResult> {
  const config = readOpenLITUsageConfig(environment);
  if (!config) return Promise.resolve({ kind: "not-configured" });
  return new OpenLITUsageClient(config).queryTrace(spanId);
}

export type UsageSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export function usageSelectionFromSearchParams(
  searchParameters: UsageSearchParams,
  now = new Date()
): UsageFilterSelection {
  const rawRange = first(searchParameters.range);
  const range: UsageTimeRange = VALID_RANGES.has(rawRange as UsageTimeRange)
    ? (rawRange as UsageTimeRange)
    : "24H";
  const values: Partial<Record<UsageVariableId, readonly string[]>> = {};
  for (const id of USAGE_VARIABLE_IDS) {
    const raw = searchParameters[id];
    const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const normalized = [
      ...new Set(entries.map((value) => value.trim()).filter(Boolean))
    ]
      .slice(0, 32)
      .map((value) => value.slice(0, 256));
    if (normalized.length > 0) values[id] = normalized;
  }
  const customRange: UsageCustomRange = {
    startDate: first(searchParameters.startDate) || calendarDate(now, 14),
    endDate: first(searchParameters.endDate) || calendarDate(now, 0)
  };
  if (range === "CUSTOM") return { range, values, customRange };
  // The live-session scope carries no bounds. Defaulting `customRange` onto it
  // would put a 14-day window on a selection that has no window at all, and the
  // two date inputs would then silently describe something that does not apply.
  if (range === "ACTIVE_SESSIONS") return { range, values };
  const presetRange = range as Exclude<UsageHistoricalTimeRange, "CUSTOM">;
  return { range: presetRange, values, customRange };
}

function calendarDate(now: Date, daysBefore: number): string {
  const date = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysBefore
    )
  );
  return date.toISOString().slice(0, 10);
}

function first(value: string | readonly string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
The unscoped Usage views: the fleet aggregate and the two fleet diagnostics.
*/
type UsageFleetView = "overview" | "sessions" | "hooks";

/**
The session-scoped Usage tabs.
*/
type UsageSessionTab =
  "overview" | "threads" | "failures" | "requests" | "spans";

/**
Everything the Usage page reads out of its own URL.
*/
export interface UsageViewState {
  readonly selection: UsageFilterSelection;
  /**
  The session id exactly as the operator typed it, before validation.
  */
  readonly rawSessionId: string;
  /**
  The validated session id, or null when the typed one is not usable.
  */
  readonly sessionId: string | null;
  readonly view: UsageFleetView;
  readonly tab: UsageSessionTab;
  readonly spanOffset: number;
  readonly spanLimit: 50 | 100 | 200;
  readonly spanSort: UsageSessionSpanSortDirection;
  readonly eventsOffset: number;
  readonly eventsLimit: 50 | 100;
  readonly itemsOffset: number;
  readonly itemsLimit: 50 | 100;
  readonly threadId: string | undefined;
  readonly failureCategory: ToolFailureCategory | undefined;
  readonly hooksSinceDays: 1 | 7 | 30;
}

const FLEET_VIEWS = new Set<UsageFleetView>(["overview", "sessions", "hooks"]);
const SESSION_TABS = new Set<UsageSessionTab>([
  "overview",
  "threads",
  "failures",
  "requests",
  "spans"
]);
const SPAN_LIMITS = [50, 100, 200] as const;
const SMALL_PAGE_LIMITS = [50, 100] as const;
const HOOK_WINDOWS = [1, 7, 30] as const;
const WHOLE_NUMBER_PATTERN = /^\d+$/u;

function oneOf<T extends number>(
  value: string,
  allowed: readonly T[],
  fallback: T
): T {
  const parsed = Number(value);
  return (allowed as readonly number[]).includes(parsed)
    ? (parsed as T)
    : fallback;
}

function offsetValue(value: string): number {
  if (!WHOLE_NUMBER_PATTERN.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
Read the Usage page's view state out of its URL.

A session id is a *view scope*, not a Usage filter: it is validated with the
shared session-identity rule, it never becomes an OpenTelemetry metric
dimension, and it is carried separately from the filter selection so the
fleet-wide query can be skipped entirely when it is present.
*/
export function usageViewStateFromSearchParams(
  searchParameters: UsageSearchParams,
  now = new Date()
): UsageViewState {
  const selection = usageSelectionFromSearchParams(searchParameters, now);
  const rawSessionId = first(searchParameters.sessionId).trim();
  const validatedThreadId = first(searchParameters.threadId).trim();
  const threadId = safeAutoDevSessionId(validatedThreadId) ?? undefined;
  const rawFailureCategory = first(searchParameters.failureCategory).trim();
  const rawView = first(searchParameters.view);
  const rawTab = first(searchParameters.tab);
  const rawSpanSort = first(searchParameters.spanSort);
  return {
    selection,
    rawSessionId,
    sessionId: safeAutoDevSessionId(rawSessionId),
    view: FLEET_VIEWS.has(rawView as UsageFleetView)
      ? (rawView as UsageFleetView)
      : "overview",
    tab: SESSION_TABS.has(rawTab as UsageSessionTab)
      ? (rawTab as UsageSessionTab)
      : "overview",
    spanOffset: offsetValue(first(searchParameters.spanOffset)),
    spanLimit: oneOf(first(searchParameters.spanLimit), SPAN_LIMITS, 50),
    spanSort: rawSpanSort === "asc" ? "asc" : "desc",
    eventsOffset: offsetValue(first(searchParameters.eventsOffset)),
    eventsLimit: oneOf(first(searchParameters.eventsLimit), SMALL_PAGE_LIMITS, 50),
    itemsOffset: offsetValue(first(searchParameters.itemsOffset)),
    itemsLimit: oneOf(first(searchParameters.itemsLimit), SMALL_PAGE_LIMITS, 50),
    threadId,
    failureCategory: isToolFailureCategory(rawFailureCategory)
      ? rawFailureCategory
      : undefined,
    hooksSinceDays: oneOf(first(searchParameters.hooksSinceDays), HOOK_WINDOWS, 7)
  };
}
