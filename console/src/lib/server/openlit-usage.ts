/** Server-only OpenLIT Usage adapter configuration and URL filter parsing. */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  USAGE_VARIABLE_IDS,
  type UsageCustomRange,
  type UsageFilterSelection,
  type UsageHistoricalTimeRange,
  type UsageTimeRange,
  type UsageVariableId
} from "@simulatorlife/autodev-core";
import {
  type OpenLITTraceResult,
  OpenLITUsageClient,
  type OpenLITUsageResult
} from "@simulatorlife/autodev-data/usage";

const DEFAULT_OPENLIT_USAGE_BASE_URL = "http://127.0.0.1:3000";
const TRAILING_SLASHES = /\/+$/u;
const SECRET_FILE_LINE_BREAK = /\r?\n/u;
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
  { readonly kind: "not-configured" } | OpenLITUsageResult;

export type ConsoleTraceResult =
  { readonly kind: "not-configured" } | OpenLITTraceResult;

function readSecretFromFile(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(SECRET_FILE_LINE_BREAK)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const stripped = trimmed.startsWith("export ")
        ? trimmed.slice(7).trim()
        : trimmed;
      if (!stripped.startsWith(`${key}=`)) continue;
      const rawValue = stripped.slice(key.length + 1).trim();
      const leading = rawValue[0];
      const trailing = rawValue.at(-1);
      const quoted =
        rawValue.length >= 2 &&
        ((leading === '"' && trailing === '"') ||
          (leading === "'" && trailing === "'"));
      const value = quoted ? rawValue.slice(1, -1) : rawValue;
      return value || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function readOpenLITUsageConfig(
  env: OpenLITUsageEnvironment = process.env
): OpenLITUsageConfig | null {
  let serviceToken = env.AUTODEV_OPENLIT_USAGE_TOKEN?.trim() ?? "";
  if (!serviceToken) {
    const home = env.HOME?.trim();
    const codexHome =
      env.CODEX_HOME?.trim() || (home ? path.join(home, ".codex") : null);
    if (codexHome) {
      const secretFile =
        env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
        path.join(codexHome, "openlit-secrets.env");
      serviceToken =
        readSecretFromFile(secretFile, "AUTODEV_OPENLIT_USAGE_TOKEN") ?? "";
    }
  }
  if (!serviceToken) return null;
  const baseUrl =
    env.AUTODEV_OPENLIT_USAGE_URL?.trim() || DEFAULT_OPENLIT_USAGE_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

export function loadOpenLITUsage(
  selection: UsageFilterSelection,
  env: OpenLITUsageEnvironment = process.env
): Promise<ConsoleUsageResult> {
  const config = readOpenLITUsageConfig(env);
  if (!config) return Promise.resolve({ kind: "not-configured" });
  return new OpenLITUsageClient(config).query(selection);
}

export function loadOpenLITTrace(
  spanId: string,
  env: OpenLITUsageEnvironment = process.env
): Promise<ConsoleTraceResult> {
  const config = readOpenLITUsageConfig(env);
  if (!config) return Promise.resolve({ kind: "not-configured" });
  return new OpenLITUsageClient(config).queryTrace(spanId);
}

export type UsageSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export function usageSelectionFromSearchParams(
  searchParams: UsageSearchParams,
  now = new Date()
): UsageFilterSelection {
  const rawRange = first(searchParams.range);
  const range: UsageTimeRange = VALID_RANGES.has(rawRange as UsageTimeRange)
    ? (rawRange as UsageTimeRange)
    : "24H";
  const values: Partial<Record<UsageVariableId, readonly string[]>> = {};
  for (const id of USAGE_VARIABLE_IDS) {
    const raw = searchParams[id];
    const entries = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const normalized = [
      ...new Set(entries.map((value) => value.trim()).filter(Boolean))
    ]
      .slice(0, 32)
      .map((value) => value.slice(0, 256));
    if (normalized.length > 0) values[id] = normalized;
  }
  const customRange: UsageCustomRange = {
    startDate: first(searchParams.startDate) || calendarDate(now, 14),
    endDate: first(searchParams.endDate) || calendarDate(now, 0)
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
