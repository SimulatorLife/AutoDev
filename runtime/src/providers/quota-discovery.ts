import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  ANTIGRAVITY_PROVIDERS,
  type AntigravityProvider,
  type ControlApiModelQuota,
  type ControlApiProviderQuota,
  type ControlApiQuotaStatus,
  type ControlApiQuotaWindow,
  type ControlApiQuotaWindowKind,
  isAntigravityProvider
} from "@simulatorlife/autodev-core";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  findAgyBinary,
  findMiniMaxBinary
} from "@simulatorlife/autodev-runtime/shared/executables";
import { antigravityProvider } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import { loadCodexAuth } from "./codex-auth.ts";

const execFileAsync = promisify(execFile);

const QUOTA_DISCOVERY_TIMEOUT_MS = 6000;
const ANTIGRAVITY_FETCH_MODELS_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const ANTIGRAVITY_QUOTA_SUMMARY_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const ANTIGRAVITY_USER_AGENT = "antigravity/1.5.3 darwin/arm64";
const CODEX_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BRIDGE_HEALTH_URL =
  process.env.CODEX_ROUTER_CLAUDE_HEALTH_URL ?? "http://127.0.0.1:4000/health";

export const MINIMAX_CONFIGURED_MODELS = [
  { model: "MiniMax-M3", displayName: "MiniMax M3" },
  { model: "MiniMax-M3.1-Flash-Preview", displayName: "MiniMax M3.1 Flash" },
  { model: "MiniMax-M2.7", displayName: "MiniMax M2.7" }
] as const;

export const CLAUDE_CONFIGURED_MODELS = [
  { model: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { model: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" }
] as const;

const ANTIGRAVITY_FLASH_TIERED_VARIANTS = [
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-max",
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gemini-4-argon-high"
] as const;

const quotaCache = new Map<string, ControlApiProviderQuota>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function canonicalIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function statusFromUsedPercent(
  usedPercent: number | null,
  unlimited = false
): ControlApiQuotaStatus {
  if (unlimited) return "unlimited";
  if (usedPercent === null || !Number.isFinite(usedPercent)) {
    return "unavailable";
  }
  if (usedPercent >= 100) return "exhausted";
  if (usedPercent >= 85) return "warning";
  return "available";
}

function combineStatuses(
  statuses: readonly ControlApiQuotaStatus[]
): ControlApiQuotaStatus {
  if (statuses.length === 0) return "unavailable";
  if (statuses.includes("exhausted")) return "exhausted";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("available")) return "available";
  if (statuses.includes("unlimited")) return "unlimited";
  return "unavailable";
}

function windowKindFromSeconds(
  seconds: number | null
): ControlApiQuotaWindowKind {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "rolling";
  }
  if (Math.abs(seconds - 18_000) <= 3600) return "five_hour";
  if (Math.abs(seconds - 86_400) <= 7200) return "daily";
  if (Math.abs(seconds - 604_800) <= 86_400) return "weekly";
  if (seconds >= 2_000_000) return "monthly";
  return "rolling";
}

function windowLabelFromKind(
  kind: ControlApiQuotaWindowKind,
  fallback: string
): string {
  switch (kind) {
    case "five_hour": {
      return "5-hour limit";
    }
    case "daily": {
      return "Daily limit";
    }
    case "weekly": {
      return "Weekly limit";
    }
    case "monthly": {
      return "Monthly limit";
    }
    default: {
      return fallback;
    }
  }
}

function cliSearchEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? homedir();
  const extraPaths = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(path.delimiter)
  };
}

/**
 * Parse `mmx quota --output json` stdout or direct `/v1/token_plan/remains` response
 * into a canonical `ControlApiProviderQuota`.
 */
export function parseMinimaxQuotaOutput(
  raw: string | unknown,
  nowMs = Date.now(),
  source = "mmx quota --output json"
): ControlApiProviderQuota | null {
  let parsed: unknown;
  if (typeof raw === "string") {
    const startIndex = raw.indexOf("{");
    const endIndex = raw.lastIndexOf("}");
    if (startIndex === -1 || endIndex <= startIndex) return null;
    try {
      parsed = JSON.parse(raw.slice(startIndex, endIndex + 1));
    } catch {
      return null;
    }
  } else {
    parsed = raw;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.model_remains)) {
    return null;
  }
  const entry =
    parsed.model_remains.find(
      (m): m is Record<string, unknown> =>
        isRecord(m) && m.model_name === "general"
    ) ?? parsed.model_remains.find(isRecord);
  if (!entry) return null;

  const windows: ControlApiQuotaWindow[] = [];
  const intervalRemaining =
    typeof entry.current_interval_remaining_percent === "number"
      ? clampPercent(entry.current_interval_remaining_percent)
      : null;
  if (intervalRemaining !== null) {
    const usedPercent = clampPercent(100 - intervalRemaining);
    const resetsAt = canonicalIso(entry.end_time);
    windows.push({
      id: "minimax-5h",
      label: "5-hour limit",
      kind: "five_hour",
      status: statusFromUsedPercent(usedPercent),
      usedPercent,
      remainingPercent: intervalRemaining,
      windowSeconds: 18_000,
      resetsAt
    });
  }

  const weeklyRemaining =
    typeof entry.current_weekly_remaining_percent === "number"
      ? clampPercent(entry.current_weekly_remaining_percent)
      : null;
  if (weeklyRemaining !== null) {
    const usedPercent = clampPercent(100 - weeklyRemaining);
    const resetsAt = canonicalIso(entry.weekly_end_time);
    windows.push({
      id: "minimax-weekly",
      label: "Weekly limit",
      kind: "weekly",
      status: statusFromUsedPercent(usedPercent),
      usedPercent,
      remainingPercent: weeklyRemaining,
      windowSeconds: 604_800,
      resetsAt
    });
  }

  if (windows.length === 0) return null;
  const summaryStatus = combineStatuses(windows.map((w) => w.status));
  const primary = windows[0]!;
  return {
    provider: "minimax",
    status: "ok",
    source,
    updatedAt: new Date(nowMs).toISOString(),
    plan: "Coding Plan",
    summaryStatus,
    windows,
    models: MINIMAX_CONFIGURED_MODELS.map((cfg) => ({
      model: cfg.model,
      displayName: cfg.displayName,
      status: summaryStatus,
      usedPercent: primary.usedPercent,
      remainingPercent: primary.remainingPercent,
      resetsAt: primary.resetsAt,
      windows
    }))
  };
}

/** One Codex rate-limit window, named by its length when the length is known. */
function codexQuotaWindow({
  usedPercent,
  windowSeconds,
  resetsAt,
  fallbackId,
  fallbackLabel
}: {
  readonly usedPercent: number;
  readonly windowSeconds: number | null;
  readonly resetsAt: ControlApiQuotaWindow["resetsAt"];
  readonly fallbackId: string;
  readonly fallbackLabel: string;
}): ControlApiQuotaWindow {
  const kind = windowKindFromSeconds(windowSeconds);
  let id = fallbackId;
  if (kind === "five_hour") id = "codex-5h";
  else if (kind === "weekly") id = "codex-weekly";
  return {
    id,
    label: windowLabelFromKind(kind, fallbackLabel),
    kind,
    status: statusFromUsedPercent(usedPercent),
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowSeconds,
    resetsAt
  };
}

/**
 * Parse ChatGPT/Codex `/backend-api/wham/usage` payload.
 */
export function parseCodexWhamUsage(
  payload: unknown,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return null;
  const rateLimit = payload.rate_limit;
  const plan =
    typeof payload.plan_type === "string" && payload.plan_type.trim()
      ? payload.plan_type.trim()
      : null;
  const limitReached = rateLimit.limit_reached === true;
  const windows: ControlApiQuotaWindow[] = [];

  for (const [key, fallbackId] of [
    ["primary_window", "codex-primary"],
    ["secondary_window", "codex-secondary"]
  ] as const) {
    const win = rateLimit[key];
    if (!isRecord(win)) continue;
    const rawUsed =
      typeof win.used_percent === "number"
        ? clampPercent(win.used_percent)
        : null;
    if (rawUsed === null) continue;
    const usedPercent =
      limitReached && key === "primary_window"
        ? Math.max(100, rawUsed)
        : rawUsed;
    const windowSeconds =
      typeof win.limit_window_seconds === "number" &&
      Number.isFinite(win.limit_window_seconds)
        ? win.limit_window_seconds
        : null;
    windows.push(
      codexQuotaWindow({
        usedPercent,
        windowSeconds,
        resetsAt: canonicalIso(win.reset_at),
        fallbackId,
        fallbackLabel:
          key === "primary_window" ? "Primary window" : "Secondary window"
      })
    );
  }

  if (windows.length === 0) return null;
  const summaryStatus = limitReached
    ? "exhausted"
    : combineStatuses(windows.map((w) => w.status));

  return {
    provider: "codex",
    status: "ok",
    source: "chatgpt-wham-usage",
    updatedAt: new Date(nowMs).toISOString(),
    plan,
    summaryStatus,
    windows
  };
}

/**
 * Parse live `x-codex-*` rate-limit headers from a Codex upstream response.
 */
export function parseCodexResponseRateLimitHeaders(
  headers: Headers,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  const windows: ControlApiQuotaWindow[] = [];
  for (const prefix of ["primary", "secondary"] as const) {
    const usedRaw = headers.get(`x-codex-${prefix}-used-percent`);
    if (usedRaw === null) continue;
    const usedNum = Number(usedRaw);
    if (!Number.isFinite(usedNum)) continue;
    const usedPercent = clampPercent(usedNum);
    const minutesRaw = headers.get(`x-codex-${prefix}-window-minutes`);
    const minutes = minutesRaw === null ? Number.NaN : Number(minutesRaw);
    const windowSeconds =
      Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null;
    const resetRaw = headers.get(`x-codex-${prefix}-reset-at`);
    const resetNum = resetRaw === null ? Number.NaN : Number(resetRaw);
    windows.push(
      codexQuotaWindow({
        usedPercent,
        windowSeconds,
        resetsAt: Number.isFinite(resetNum)
          ? canonicalIso(resetNum)
          : canonicalIso(resetRaw),
        fallbackId: `codex-${prefix}`,
        fallbackLabel:
          prefix === "primary" ? "Primary window" : "Secondary window"
      })
    );
  }
  if (windows.length === 0) return null;
  const plan = headers.get("x-codex-plan-type")?.trim() || null;
  const summaryStatus = combineStatuses(windows.map((w) => w.status));
  return {
    provider: "codex",
    status: "ok",
    source: "x-codex-rate-limit-headers",
    updatedAt: new Date(nowMs).toISOString(),
    plan,
    summaryStatus,
    windows
  };
}

/** The label of a window whose kind says nothing more specific. */
const USAGE_LIMIT_LABEL = "Usage limit";

/** The quota window kinds Antigravity reports, in display order. */
const ANTIGRAVITY_WINDOW_KINDS = ["five_hour", "weekly"] as const;

/**
 * Parse Antigravity `v1internal:fetchAvailableModels` into one quota per
 * Antigravity provider.
 *
 * agy meters Gemini, Argon, and Claude/GPT-OSS separately, and AutoDev routes
 * each as its own provider (`antigravity-gemini`, `antigravity-argon`,
 * `antigravity-claude-gpt`), so one response yields each provider's quota. A
 * model reports its remaining fraction and next reset; a reset more than a day
 * out is the weekly window, a nearer one the 5-hour window. A provider's window
 * of each kind reads the most-used of its models, because its models draw on
 * the same quota.
 */
export function parseAntigravityAvailableModelsQuota(
  payload: unknown,
  nowMs = Date.now()
): Partial<Record<AntigravityProvider, ControlApiProviderQuota>> {
  if (!isRecord(payload) || !isRecord(payload.models)) return {};
  const modelsRecord = payload.models;
  const byProvider = new Map<AntigravityProvider, ControlApiModelQuota[]>();
  const seenModelIds = new Set<string>();

  const addModelEntry = (
    modelId: string,
    displayName: string | null,
    quotaInfo: Record<string, unknown>
  ): void => {
    if (seenModelIds.has(modelId)) return;
    const provider = antigravityProvider(modelId);
    if (!provider) return;
    seenModelIds.add(modelId);
    const resetsAt = canonicalIso(quotaInfo.resetTime);
    let remainingFraction: number | null = null;
    if (
      typeof quotaInfo.remainingFraction === "number" &&
      Number.isFinite(quotaInfo.remainingFraction)
    ) {
      remainingFraction = Math.max(0, Math.min(1, quotaInfo.remainingFraction));
    } else if (resetsAt !== null) {
      // In proto3 JSON, remainingFraction === 0 is omitted while resetTime is present.
      remainingFraction = 0;
    }
    if (remainingFraction === null) return;
    const remainingPercent = clampPercent(remainingFraction * 100);
    const usedPercent = clampPercent(100 - remainingPercent);
    const status = statusFromUsedPercent(usedPercent);
    const resetMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
    const remainingSec =
      Number.isFinite(resetMs) && resetMs > nowMs
        ? Math.round((resetMs - nowMs) / 1000)
        : null;
    const kind: ControlApiQuotaWindowKind =
      remainingSec !== null && remainingSec > 86_400 ? "weekly" : "five_hour";
    const win: ControlApiQuotaWindow = {
      id: `${provider}-${modelId}`,
      label: windowLabelFromKind(kind, USAGE_LIMIT_LABEL),
      kind,
      status,
      usedPercent,
      remainingPercent,
      resetsAt
    };
    const models = byProvider.get(provider) ?? [];
    models.push({
      model: modelId,
      displayName,
      status,
      usedPercent,
      remainingPercent,
      resetsAt,
      windows: [win]
    });
    byProvider.set(provider, models);
  };

  // A model the response names by its own id reports its own quota; the
  // tiered Flash entry speaks only for the variants nothing else names. The
  // API files Argon under that tiered entry today, so Argon reads the tiered
  // quota until the response carries an Argon entry of its own.
  let tiered: {
    displayName: string | null;
    quotaInfo: Record<string, unknown>;
  } | null = null;
  for (const [rawId, rawEntry] of Object.entries(modelsRecord)) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.quotaInfo)) continue;
    const displayName =
      typeof rawEntry.displayName === "string" && rawEntry.displayName.trim()
        ? rawEntry.displayName.trim()
        : null;
    if (rawId === "gemini-3.8-flash-tiered")
      tiered = { displayName, quotaInfo: rawEntry.quotaInfo };
    else addModelEntry(rawId, displayName, rawEntry.quotaInfo);
  }
  if (tiered)
    for (const variant of ANTIGRAVITY_FLASH_TIERED_VARIANTS)
      addModelEntry(variant, tiered.displayName, tiered.quotaInfo);

  const result: Partial<Record<AntigravityProvider, ControlApiProviderQuota>> =
    {};
  for (const [provider, models] of byProvider) {
    const windows = ANTIGRAVITY_WINDOW_KINDS.flatMap((kind) => {
      const members = models.flatMap((m) =>
        m.windows.filter((w) => w.kind === kind)
      );
      if (members.length === 0) return [];
      const mostUsed = members.reduce((most, w) =>
        (w.usedPercent ?? -1) > (most.usedPercent ?? -1) ? w : most
      );
      const usedPercent = mostUsed.usedPercent;
      const window: ControlApiQuotaWindow = {
        id: `${provider}-${kind}`,
        label: windowLabelFromKind(kind, USAGE_LIMIT_LABEL),
        kind,
        status: statusFromUsedPercent(usedPercent),
        usedPercent,
        remainingPercent:
          usedPercent === null ? null : clampPercent(100 - usedPercent),
        resetsAt:
          mostUsed.resetsAt ??
          members.find((w) => w.resetsAt !== null)?.resetsAt ??
          null
      };
      return [window];
    });
    result[provider] = {
      provider,
      status: "ok",
      source: "antigravity-cloudcode-api",
      updatedAt: new Date(nowMs).toISOString(),
      summaryStatus: combineStatuses(windows.map((w) => w.status)),
      windows,
      models
    };
  }
  return result;
}

/** The quota summary's own window names, as the Console's window kinds. */
const ANTIGRAVITY_SUMMARY_WINDOW_KINDS: Readonly<
  Record<string, ControlApiQuotaWindowKind>
> = { "5h": "five_hour", weekly: "weekly", daily: "daily", monthly: "monthly" };

/**
 * The Antigravity provider a quota-summary group meters, from the models the
 * group names: `Claude and GPT models` (`Models within this group: Claude
 * Opus, Claude Sonnet, GPT-OSS`) is `antigravity-claude-gpt`. Argon is named
 * before Gemini because an Argon group is also a Gemini one.
 */
function antigravitySummaryGroupProvider(
  group: Record<string, unknown>
): AntigravityProvider | null {
  const text = [group.displayName, group.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("argon")) return "antigravity-argon";
  if (text.includes("claude") || text.includes("gpt"))
    return "antigravity-claude-gpt";
  if (text.includes("gemini")) return "antigravity-gemini";
  return null;
}

/**
 * Parse Antigravity `v1internal:retrieveUserQuotaSummary` into each Antigravity
 * provider's limit windows.
 *
 * The summary is where agy states its limits as limits: within each model
 * group the models share a 5-hour limit and a weekly limit, each a bucket with
 * its own remaining fraction and reset. It lists only the groups the account
 * is metered on, so a provider it does not name keeps the windows
 * `fetchAvailableModels` implies.
 */
export function parseAntigravityQuotaSummary(
  payload: unknown,
  nowMs = Date.now()
): Partial<Record<AntigravityProvider, ControlApiQuotaWindow[]>> {
  const result: Partial<Record<AntigravityProvider, ControlApiQuotaWindow[]>> =
    {};
  if (!isRecord(payload) || !Array.isArray(payload.groups)) return result;
  for (const group of payload.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const provider = antigravitySummaryGroupProvider(group);
    if (!provider) continue;
    const windows = group.buckets.flatMap((bucket: unknown) => {
      const window = antigravitySummaryWindow(provider, bucket, nowMs);
      return window ? [window] : [];
    });
    if (windows.length > 0)
      result[provider] = windows.sort(
        (a, b) => windowOrder(a.kind) - windowOrder(b.kind)
      );
  }
  return result;
}

/** One quota-summary bucket as a limit window, or null for one it cannot read. */
function antigravitySummaryWindow(
  provider: AntigravityProvider,
  bucket: unknown,
  nowMs: number
): ControlApiQuotaWindow | null {
  if (!isRecord(bucket) || bucket.disabled === true) return null;
  const kind =
    typeof bucket.window === "string"
      ? ANTIGRAVITY_SUMMARY_WINDOW_KINDS[bucket.window]
      : undefined;
  if (!kind) return null;
  const resetsAt = canonicalIso(bucket.resetTime);
  // A bucket whose reset has passed since the reading is a fresh, unused
  // window; proto3 JSON omits a zero remaining fraction.
  const resetPassed = resetsAt !== null && Date.parse(resetsAt) <= nowMs;
  let remainingFraction = 0;
  if (resetPassed) remainingFraction = 1;
  else if (
    typeof bucket.remainingFraction === "number" &&
    Number.isFinite(bucket.remainingFraction)
  )
    remainingFraction = Math.max(0, Math.min(1, bucket.remainingFraction));
  const remainingPercent = clampPercent(remainingFraction * 100);
  const usedPercent = clampPercent(100 - remainingPercent);
  return {
    id: `${provider}-${kind}`,
    label: windowLabelFromKind(kind, USAGE_LIMIT_LABEL),
    kind,
    status: statusFromUsedPercent(usedPercent),
    usedPercent,
    remainingPercent,
    resetsAt: resetPassed ? null : resetsAt
  };
}

function windowOrder(kind: ControlApiQuotaWindowKind): number {
  return ["five_hour", "daily", "weekly", "monthly", "rolling"].indexOf(kind);
}

/** Every Antigravity model group is metered by a 5-hour and a weekly limit. */
const ANTIGRAVITY_LIMIT_KINDS = ["five_hour", "weekly"] as const;

/**
 * Each Antigravity provider's quota: its models from `fetchAvailableModels`,
 * and its limit windows from the quota summary wherever the summary names the
 * provider's group.
 *
 * Every provider carries both of its limits. A window neither read reports --
 * the summary does not list the group, and the models imply only the window
 * their next reset falls in -- is stated as not observed rather than left
 * out, because a missing row reads as a limit the provider does not have.
 */
export function mergeAntigravityQuotas(
  modelQuotas: Partial<Record<AntigravityProvider, ControlApiProviderQuota>>,
  summaryWindows: Partial<Record<AntigravityProvider, ControlApiQuotaWindow[]>>,
  nowMs = Date.now()
): Partial<Record<AntigravityProvider, ControlApiProviderQuota>> {
  const merged: Partial<Record<AntigravityProvider, ControlApiProviderQuota>> =
    {};
  for (const provider of ANTIGRAVITY_PROVIDERS) {
    const fromModels = modelQuotas[provider];
    const reported = summaryWindows[provider] ?? fromModels?.windows;
    if (!reported) continue;
    const windows = ANTIGRAVITY_LIMIT_KINDS.map(
      (kind): ControlApiQuotaWindow =>
        reported.find((window) => window.kind === kind) ?? {
          id: `${provider}-${kind}`,
          label: windowLabelFromKind(kind, USAGE_LIMIT_LABEL),
          kind,
          status: "unavailable",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null
        }
    );
    merged[provider] = {
      provider,
      status: "ok",
      source: "antigravity-cloudcode-api",
      updatedAt: new Date(nowMs).toISOString(),
      models: fromModels?.models ?? [],
      windows,
      summaryStatus: combineStatuses(windows.map((w) => w.status))
    };
  }
  return merged;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The remaining and used shares of a Copilot snapshot, null when unreported. */
function copilotShares(
  unlimited: boolean,
  remainingPercent: number | null
): { remainingPercent: number | null; usedPercent: number | null } {
  if (unlimited) return { remainingPercent: 100, usedPercent: 0 };
  return {
    remainingPercent,
    usedPercent:
      remainingPercent === null ? null : clampPercent(100 - remainingPercent)
  };
}

function copilotPremiumWindow(
  snap: Record<string, unknown>,
  resetsAt: ControlApiQuotaWindow["resetsAt"]
): ControlApiQuotaWindow {
  const unlimited = snap.unlimited === true;
  const entitlement = finiteNumberOrNull(snap.entitlement);
  const remaining =
    finiteNumberOrNull(snap.quota_remaining) ??
    finiteNumberOrNull(snap.remaining);
  const reportedUsed = finiteNumberOrNull(snap.credits_used);
  let used = reportedUsed;
  if (used === null && entitlement !== null && remaining !== null) {
    used = Math.max(0, Math.round((entitlement - remaining) * 10) / 10);
  }
  const reportedPercent = finiteNumberOrNull(snap.percent_remaining);
  let remainingPercent: number | null = null;
  if (reportedPercent !== null)
    remainingPercent = clampPercent(reportedPercent);
  else if (entitlement && remaining !== null && entitlement > 0) {
    remainingPercent = clampPercent((remaining / entitlement) * 100);
  }
  const shares = copilotShares(unlimited, remainingPercent);
  return {
    id: "copilot-premium",
    label: "Monthly premium requests",
    kind: "monthly",
    status: statusFromUsedPercent(shares.usedPercent, unlimited),
    usedPercent: shares.usedPercent,
    remainingPercent: shares.remainingPercent,
    used,
    limit: entitlement,
    unit: "requests",
    resetsAt
  };
}

function copilotChatWindow(
  snap: Record<string, unknown>,
  resetsAt: ControlApiQuotaWindow["resetsAt"]
): ControlApiQuotaWindow {
  const unlimited = snap.unlimited === true;
  const reportedPercent =
    typeof snap.percent_remaining === "number" ? snap.percent_remaining : null;
  const shares = copilotShares(
    unlimited,
    reportedPercent === null ? null : clampPercent(reportedPercent)
  );
  return {
    id: "copilot-chat",
    label: "Chat requests",
    kind: "monthly",
    status: statusFromUsedPercent(shares.usedPercent, unlimited),
    usedPercent: shares.usedPercent,
    remainingPercent: shares.remainingPercent,
    resetsAt
  };
}

/**
 * Parse GitHub Copilot `/copilot_internal/user` payload.
 */
export function parseCopilotUserQuota(
  payload: unknown,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) return null;
  const snapshots = payload.quota_snapshots;
  const plan =
    typeof payload.copilot_plan === "string" && payload.copilot_plan.trim()
      ? payload.copilot_plan.trim()
      : null;
  const resetsAt =
    canonicalIso(payload.quota_reset_date_utc) ??
    canonicalIso(payload.quota_reset_date);
  const windows: ControlApiQuotaWindow[] = [];

  if (isRecord(snapshots.premium_interactions)) {
    windows.push(
      copilotPremiumWindow(snapshots.premium_interactions, resetsAt)
    );
  }
  if (isRecord(snapshots.chat)) {
    windows.push(copilotChatWindow(snapshots.chat, resetsAt));
  }

  if (windows.length === 0) return null;
  const primary = windows[0]!;
  return {
    provider: "copilot",
    status: "ok",
    source: "gh api /copilot_internal/user",
    updatedAt: new Date(nowMs).toISOString(),
    plan,
    summaryStatus: primary.status,
    windows
  };
}

const CLAUDE_PRO_PLAN = "Claude Pro Plan";

/** Claude's usage windows, in display order: the 5-hour session window first. */
const CLAUDE_USAGE_WINDOWS = [
  ["five_hour", "claude-5h", "5-hour limit", "five_hour"],
  ["seven_day", "claude-weekly", "Weekly limit", "weekly"],
  ["seven_day_opus", "claude-weekly-opus", "Weekly Opus limit", "weekly"],
  ["seven_day_sonnet", "claude-weekly-sonnet", "Weekly Sonnet limit", "weekly"]
] as const satisfies ReadonlyArray<
  readonly [string, string, string, ControlApiQuotaWindowKind]
>;

/** Wraps Claude windows in the provider envelope shared by every Claude source. */
function claudeProviderQuota(
  source: string,
  plan: string,
  windows: ControlApiQuotaWindow[],
  nowMs: number
): ControlApiProviderQuota {
  const primary = windows[0]!;
  return {
    provider: "claude",
    status: "ok",
    source,
    updatedAt: new Date(nowMs).toISOString(),
    plan,
    summaryStatus: combineStatuses(windows.map((w) => w.status)),
    windows,
    models: CLAUDE_CONFIGURED_MODELS.map((cfg) => ({
      model: cfg.model,
      displayName: cfg.displayName,
      status: primary.status,
      usedPercent: primary.usedPercent,
      remainingPercent: primary.remainingPercent,
      resetsAt: primary.resetsAt,
      windows
    }))
  };
}

/**
 * Parse Anthropic OAuth `/api/oauth/usage` payload.
 */
export function parseClaudeOAuthUsage(
  payload: unknown,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  if (!isRecord(payload)) return null;
  const windows: ControlApiQuotaWindow[] = [];
  for (const [key, id, label, kind] of CLAUDE_USAGE_WINDOWS) {
    const bucket = payload[key];
    if (!isRecord(bucket)) continue;
    const rawUtil =
      bucket.utilization ?? bucket.percent_used ?? bucket.used_percent;
    if (typeof rawUtil !== "number" || !Number.isFinite(rawUtil)) continue;
    const usedPercent = clampPercent(
      rawUtil <= 1 && rawUtil > 0 ? rawUtil * 100 : rawUtil
    );
    const remainingPercent = clampPercent(100 - usedPercent);
    const resetsAt = canonicalIso(bucket.resets_at ?? bucket.reset_at);
    windows.push({
      id,
      label,
      kind,
      status: statusFromUsedPercent(usedPercent),
      usedPercent,
      remainingPercent,
      resetsAt
    });
  }
  if (windows.length === 0) return null;
  return claudeProviderQuota(
    "anthropic-oauth-usage",
    CLAUDE_PRO_PLAN,
    windows,
    nowMs
  );
}

/** A Claude window whose current usage no source has reported. */
function claudeUnreportedWindow([
  ,
  id,
  label,
  kind
]: (typeof CLAUDE_USAGE_WINDOWS)[number]): ControlApiQuotaWindow {
  return {
    id,
    label,
    kind,
    status: "unavailable",
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null
  };
}

/**
 * Builds one Claude window from a CLI rate-limit reading. The CLI reports
 * `utilization` as a 0..1 fraction. A window whose reset time has already
 * passed has rolled over since the reading was captured (a persisted reading
 * can be days old), and any Claude use since then is invisible to it, so its
 * usage is unreported rather than assumed to be 0%.
 */
function claudeEventWindow(
  spec: (typeof CLAUDE_USAGE_WINDOWS)[number],
  reading: {
    utilization: unknown;
    resetsAt: unknown;
    eventStatus: string | null;
  },
  nowMs: number
): ControlApiQuotaWindow | null {
  const resetsAt = canonicalIso(reading.resetsAt);
  if (resetsAt !== null && Date.parse(resetsAt) <= nowMs) {
    return claudeUnreportedWindow(spec);
  }
  const [, id, label, kind] = spec;
  const usedPercent =
    typeof reading.utilization === "number" &&
    Number.isFinite(reading.utilization)
      ? clampPercent(reading.utilization * 100)
      : reading.eventStatus === "rejected"
        ? 100
        : null;
  const status: ControlApiQuotaStatus =
    reading.eventStatus === "rejected"
      ? "exhausted"
      : reading.eventStatus === "allowed_warning"
        ? "warning"
        : usedPercent === null
          ? reading.eventStatus === "allowed"
            ? "available"
            : "unavailable"
          : statusFromUsedPercent(usedPercent);
  if (status === "unavailable" && resetsAt === null) return null;
  return {
    id,
    label,
    kind,
    status,
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : clampPercent(100 - usedPercent),
    resetsAt
  };
}

/**
 * Parse Claude CLI `rate_limit_event` (`rate_limit_info`) captured by the local bridge.
 *
 * The event's top-level `status`/`utilization`/`resetsAt` describe only the
 * window named by `rateLimitType`; `unifiedWindows` carries every window
 * (5-hour session and weekly), so each one is reported. Returns null when every
 * window has rolled over since the event, so discovery moves on to a source
 * that reports current usage.
 */
export function parseClaudeRateLimitEvent(
  info: unknown,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  if (!isRecord(info)) return null;
  const eventStatus = typeof info.status === "string" ? info.status : "";
  const rateLimitType =
    typeof info.rateLimitType === "string" && info.rateLimitType
      ? info.rateLimitType
      : "five_hour";
  const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  const windows: ControlApiQuotaWindow[] = [];
  for (const spec of CLAUDE_USAGE_WINDOWS) {
    const key = spec[0];
    const isEventWindow = key === rateLimitType;
    const bucket = unified[key];
    if (!isRecord(bucket) && !isEventWindow) continue;
    const reading = isRecord(bucket)
      ? {
          utilization: bucket.utilization,
          resetsAt: bucket.resetsAt ?? bucket.resets_at,
          eventStatus: isEventWindow ? eventStatus : null
        }
      : {
          utilization: info.utilization,
          resetsAt: info.resetsAt ?? info.resets_at,
          eventStatus
        };
    const win = claudeEventWindow(spec, reading, nowMs);
    if (win) windows.push(win);
  }
  if (windows.every((w) => w.usedPercent === null && w.resetsAt === null)) {
    return null;
  }
  return claudeProviderQuota(
    "claude-cli-rate-limit-event",
    CLAUDE_PRO_PLAN,
    windows,
    nowMs
  );
}

/**
 * Overlay an active router quota cooldown onto a provider quota snapshot, so a
 * provider the router has cooled down for its quota reads exhausted in the UI.
 */
export function overlayRouterCooldownsOnQuota(
  provider: string,
  quota: ControlApiProviderQuota | null,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  if (!quota) return null;
  const providerCooldown = COOLDOWNS.get(provider, nowMs);
  if (
    providerCooldown &&
    (providerCooldown.failureClass === "quota_exhausted" ||
      providerCooldown.failureClass === "session_limit")
  )
    return { ...quota, summaryStatus: "exhausted" };
  return quota;
}

/**
 * Synchronize discovered quota exhaustion / recovery into `COOLDOWNS`.
 */
export function syncQuotaToCooldowns(
  quota: ControlApiProviderQuota,
  nowMs = Date.now()
): void {
  if (quota.status !== "ok") return;
  if (quota.summaryStatus === "exhausted") {
    const exhaustedWin = quota.windows.find((w) => w.status === "exhausted");
    const resetsAt =
      exhaustedWin?.resetsAt && Date.parse(exhaustedWin.resetsAt) > nowMs
        ? exhaustedWin.resetsAt
        : null;
    COOLDOWNS.cooldownProvider(quota.provider, {
      now: nowMs,
      failureClass: "quota_exhausted",
      resetsAt,
      structured: Boolean(resetsAt)
    });
  } else if (
    quota.summaryStatus === "available" ||
    quota.summaryStatus === "unlimited"
  ) {
    const existing = COOLDOWNS.get(quota.provider, nowMs);
    if (
      existing &&
      (existing.failureClass === "quota_exhausted" ||
        existing.failureClass === "session_limit" ||
        existing.kind === "hard")
    ) {
      COOLDOWNS.clear(quota.provider);
    }
  }
}

export function getCachedProviderQuota(
  provider: string,
  nowMs = Date.now()
): ControlApiProviderQuota | null {
  const cached = quotaCache.get(provider) ?? null;
  return overlayRouterCooldownsOnQuota(provider, cached, nowMs);
}

export function setCachedProviderQuota(
  provider: string,
  quota: ControlApiProviderQuota,
  options: { syncCooldowns?: boolean; nowMs?: number } = {}
): void {
  const nowMs = options.nowMs ?? Date.now();
  quotaCache.set(provider, quota);
  if (options.syncCooldowns) {
    syncQuotaToCooldowns(quota, nowMs);
  }
}

export function clearProviderQuotaCacheForTests(): void {
  quotaCache.clear();
  antigravityQuotaRead = null;
}

export async function readMinimaxAuth(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): Promise<{ token: string; baseUrl: string } | null> {
  const envKey = env.MINIMAX_API_KEY?.trim();
  if (envKey) {
    return {
      token: envKey,
      baseUrl: env.MINIMAX_API_BASE_URL?.trim() || "https://api.minimax.io"
    };
  }
  const configPath = path.join(home, ".mmx", "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      if (isRecord(parsed.oauth)) {
        const accessToken =
          typeof parsed.oauth.access_token === "string"
            ? parsed.oauth.access_token.trim()
            : "";
        if (accessToken) {
          const resourceUrl =
            typeof parsed.oauth.resource_url === "string" &&
            parsed.oauth.resource_url.trim()
              ? parsed.oauth.resource_url.trim()
              : "https://api.minimax.io";
          return { token: accessToken, baseUrl: resourceUrl };
        }
      }
      if (typeof parsed.api_key === "string" && parsed.api_key.trim()) {
        return {
          token: parsed.api_key.trim(),
          baseUrl: "https://api.minimax.io"
        };
      }
    }
  } catch {
    // Config file not present or unreadable
  }
  return null;
}

async function discoverMinimaxQuota(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  const auth = await readMinimaxAuth().catch(() => null);
  if (auth) {
    try {
      const response = await fetch(`${auth.baseUrl}/v1/token_plan/remains`, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(QUOTA_DISCOVERY_TIMEOUT_MS)
      });
      if (response.ok) {
        const payload = (await response.json()) as unknown;
        const parsed = parseMinimaxQuotaOutput(
          payload,
          nowMs,
          "minimax-token-plan-api"
        );
        if (parsed) return parsed;
      }
    } catch {
      // Direct REST API failed; try CLI fallback below
    }
  }

  try {
    const { stdout } = await execFileAsync(
      findMiniMaxBinary() ?? "mmx",
      ["quota", "--output", "json"],
      {
        timeout: QUOTA_DISCOVERY_TIMEOUT_MS,
        env: cliSearchEnv()
      }
    );
    return parseMinimaxQuotaOutput(stdout, nowMs, "mmx quota --output json");
  } catch {
    return null;
  }
}

async function discoverCodexQuota(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const auth = await loadCodexAuth();
    if (!auth?.token) return null;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json"
    };
    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }
    const response = await fetch(CODEX_WHAM_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(QUOTA_DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return parseCodexWhamUsage(payload, nowMs);
  } catch {
    return null;
  }
}

function parseAntigravityTokenJson(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    const jsonText = trimmed.startsWith("go-keyring-base64:")
      ? Buffer.from(
          trimmed.slice("go-keyring-base64:".length),
          "base64"
        ).toString("utf8")
      : trimmed;
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isRecord(parsed)) return null;
    const tokenObj = isRecord(parsed.token) ? parsed.token : parsed;
    const accessToken =
      typeof tokenObj.access_token === "string"
        ? tokenObj.access_token.trim()
        : "";
    return accessToken || null;
  } catch {
    return null;
  }
}

async function readAntigravityCliAccessToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"],
      {
        timeout: 2500,
        env: cliSearchEnv()
      }
    );
    const keyringToken = parseAntigravityTokenJson(stdout);
    if (keyringToken) return keyringToken;
  } catch {
    // Fall back to the file-backed token below.
  }

  const home = process.env.HOME ?? homedir();
  const tokenPath = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "antigravity-oauth-token"
  );
  try {
    const raw = await readFile(tokenPath, "utf8");
    return parseAntigravityTokenJson(raw);
  } catch {
    return null;
  }
}

function fetchAntigravityWithToken(
  url: string,
  accessToken: string
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_USER_AGENT
    },
    body: "{}",
    signal: AbortSignal.timeout(QUOTA_DISCOVERY_TIMEOUT_MS)
  });
}

async function fetchAntigravityQuotas(
  nowMs: number
): Promise<Partial<Record<AntigravityProvider, ControlApiProviderQuota>>> {
  try {
    let token = await readAntigravityCliAccessToken();
    if (!token) return {};
    let response = await fetchAntigravityWithToken(
      ANTIGRAVITY_FETCH_MODELS_URL,
      token
    );
    if (response.status === 401 || response.status === 403) {
      // Trigger `agy models` once so the CLI refreshes its stored OAuth token.
      await execFileAsync(findAgyBinary() ?? "agy", ["models"], {
        timeout: QUOTA_DISCOVERY_TIMEOUT_MS,
        env: cliSearchEnv()
      }).catch(() => null);
      token = await readAntigravityCliAccessToken();
      if (!token) return {};
      response = await fetchAntigravityWithToken(
        ANTIGRAVITY_FETCH_MODELS_URL,
        token
      );
    }
    if (!response.ok) return {};
    const modelQuotas = parseAntigravityAvailableModelsQuota(
      await response.json(),
      nowMs
    );
    // The limit windows are a separate read; without them each provider keeps
    // the window its models imply.
    const summary = await fetchAntigravityWithToken(
      ANTIGRAVITY_QUOTA_SUMMARY_URL,
      token
    ).catch(() => null);
    const summaryWindows = summary?.ok
      ? parseAntigravityQuotaSummary(await summary.json(), nowMs)
      : {};
    return mergeAntigravityQuotas(modelQuotas, summaryWindows, nowMs);
  } catch {
    return {};
  }
}

/**
 * How long one Antigravity quota read answers for all three Antigravity
 * providers. A refresh discovers each provider separately; one
 * `fetchAvailableModels` and quota-summary read carries all three, so the
 * second and third read the first's answer instead of asking the API again.
 */
const ANTIGRAVITY_QUOTA_SHARE_MS = 10_000;

let antigravityQuotaRead: {
  readonly startedAt: number;
  readonly result: Promise<
    Partial<Record<AntigravityProvider, ControlApiProviderQuota>>
  >;
} | null = null;

async function discoverAntigravityQuota(
  provider: AntigravityProvider,
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  if (
    antigravityQuotaRead === null ||
    Math.abs(nowMs - antigravityQuotaRead.startedAt) >
      ANTIGRAVITY_QUOTA_SHARE_MS
  )
    antigravityQuotaRead = {
      startedAt: nowMs,
      result: fetchAntigravityQuotas(nowMs)
    };
  const quotas = await antigravityQuotaRead.result;
  return quotas[provider] ?? null;
}

async function discoverCopilotQuota(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["api", "/copilot_internal/user"],
      {
        timeout: QUOTA_DISCOVERY_TIMEOUT_MS,
        env: cliSearchEnv()
      }
    );
    const payload = JSON.parse(stdout) as unknown;
    return parseCopilotUserQuota(payload, nowMs);
  } catch {
    return null;
  }
}

export interface ClaudePlanMetadata {
  readonly plan: string;
  readonly billingType?: string | null;
  readonly rateLimitTier?: string | null;
  readonly displayName?: string | null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

/** The plan `~/.claude.json` names for the signed-in account, if it names one. */
async function planFromClaudeJson(
  home: string
): Promise<ClaudePlanMetadata | null> {
  try {
    const raw = await readFile(path.join(home, ".claude.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) return null;
    const account = parsed.oauthAccount;
    const orgType = trimmedString(account.organizationType) ?? "";
    const billingType = trimmedString(account.billingType);
    const details = {
      billingType,
      rateLimitTier: trimmedString(account.organizationRateLimitTier),
      displayName: trimmedString(account.displayName)
    };
    if (orgType === "claude_pro" || billingType === "stripe_subscription") {
      return { plan: CLAUDE_PRO_PLAN, ...details };
    }
    if (!orgType) return null;
    return {
      plan: orgType
        .replaceAll("_", " ")
        .replaceAll(/\b\w/g, (c) => c.toUpperCase()),
      ...details
    };
  } catch {
    // .claude.json not present or unreadable
    return null;
  }
}

/** The plan the macOS Keychain credentials name, if they name one. */
async function planFromKeychain(): Promise<ClaudePlanMetadata | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 2500 }
    );
    const creds = JSON.parse(stdout.trim()) as unknown;
    if (!isRecord(creds) || !isRecord(creds.claudeAiOauth)) return null;
    const oauth = creds.claudeAiOauth;
    const subType = trimmedString(oauth.subscriptionType) ?? "";
    const details = {
      billingType: null,
      rateLimitTier: trimmedString(oauth.rateLimitTier),
      displayName: null
    };
    if (subType === "pro") return { plan: CLAUDE_PRO_PLAN, ...details };
    if (!subType) return null;
    return {
      plan: `Claude ${subType.charAt(0).toUpperCase()}${subType.slice(1)} Plan`,
      ...details
    };
  } catch {
    // Keychain lookup failed
    return null;
  }
}

export async function readClaudePlanMetadata(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): Promise<ClaudePlanMetadata | null> {
  const fromJson = await planFromClaudeJson(home);
  return fromJson ?? planFromKeychain();
}

export async function readPersistedClaudeRateLimit(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): Promise<Record<string, unknown> | null> {
  const codeHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const filePath = path.join(codeHome, "run", "claude-rate-limit.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid
  }
  return null;
}

/**
 * The plan-metadata fallback: names the Claude plan, but knows nothing of its
 * usage, so both windows are unreported.
 */
export function buildClaudeSubscriptionQuota(
  planMeta: ClaudePlanMetadata,
  nowMs = Date.now()
): ControlApiProviderQuota {
  const windows = CLAUDE_USAGE_WINDOWS.slice(0, 2).map(claudeUnreportedWindow);
  return claudeProviderQuota(
    "claude-plan-subscription",
    planMeta.plan,
    windows,
    nowMs
  );
}

/** The rate limit the local Claude bridge reports through its health endpoint. */
async function claudeQuotaFromBridge(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const bridgeResponse = await fetch(CLAUDE_BRIDGE_HEALTH_URL, {
      signal: AbortSignal.timeout(2500)
    }).catch(() => null);
    if (!bridgeResponse?.ok) return null;
    const body = (await bridgeResponse.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !body.rateLimitInfo) return null;
    return parseClaudeRateLimitEvent(body.rateLimitInfo, nowMs);
  } catch {
    // Ignore local bridge health errors.
    return null;
  }
}

/** The rate limit the Claude bridge last persisted to disk. */
async function claudeQuotaFromPersistedLimit(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const persisted = await readPersistedClaudeRateLimit();
    return persisted ? parseClaudeRateLimitEvent(persisted, nowMs) : null;
  } catch {
    // Ignore persisted read errors.
    return null;
  }
}

/** The usage the Anthropic OAuth endpoint reports for the Keychain credentials. */
async function claudeQuotaFromOAuth(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 3000 }
    );
    const creds = JSON.parse(stdout.trim()) as unknown;
    if (!isRecord(creds) || !isRecord(creds.claudeAiOauth)) return null;
    const oauth = creds.claudeAiOauth;
    const accessToken = trimmedString(oauth.accessToken) ?? "";
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    if (!accessToken || (expiresAt !== 0 && expiresAt <= nowMs)) return null;
    const response = await fetch(ANTHROPIC_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(QUOTA_DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return parseClaudeOAuthUsage(await response.json(), nowMs);
  } catch {
    // OAuth usage endpoint unavailable or forbidden
    return null;
  }
}

/** The plan-only quota, for when no source reports usage. */
async function claudeQuotaFromPlan(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const planMeta = await readClaudePlanMetadata();
    return planMeta ? buildClaudeSubscriptionQuota(planMeta, nowMs) : null;
  } catch {
    // Plan metadata unreadable
    return null;
  }
}

function discoverClaudeQuota(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  const sources = [
    claudeQuotaFromBridge,
    claudeQuotaFromPersistedLimit,
    claudeQuotaFromOAuth,
    claudeQuotaFromPlan
  ];
  // Each source is tried only when every earlier one came back empty.
  return sources.reduce<Promise<ControlApiProviderQuota | null>>(
    (previous, source) => previous.then((found) => found ?? source(nowMs)),
    Promise.resolve(null)
  );
}

export async function discoverProviderQuota(
  provider: string,
  options: { now?: number; syncCooldowns?: boolean } = {}
): Promise<ControlApiProviderQuota | null> {
  const nowMs = options.now ?? Date.now();
  let discovered: ControlApiProviderQuota | null;
  switch (provider) {
    case "minimax": {
      discovered = await discoverMinimaxQuota(nowMs);
      break;
    }
    case "codex": {
      discovered = await discoverCodexQuota(nowMs);
      break;
    }
    case "copilot": {
      discovered = await discoverCopilotQuota(nowMs);
      break;
    }
    case "claude": {
      discovered = await discoverClaudeQuota(nowMs);
      break;
    }
    default: {
      discovered = isAntigravityProvider(provider)
        ? await discoverAntigravityQuota(provider, nowMs)
        : null;
      break;
    }
  }
  if (discovered) {
    setCachedProviderQuota(provider, discovered, {
      syncCooldowns: options.syncCooldowns ?? true,
      nowMs
    });
    return getCachedProviderQuota(provider, nowMs);
  }
  return getCachedProviderQuota(provider, nowMs);
}

export async function refreshAllProviderQuotas(
  providers: readonly string[],
  options: { now?: number; syncCooldowns?: boolean } = {}
): Promise<Record<string, ControlApiProviderQuota | null>> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      const quota = await discoverProviderQuota(provider, options).catch(
        () => null
      );
      return [provider, quota] as const;
    })
  );
  return Object.fromEntries(results);
}

export const DEFAULT_QUOTA_PROVIDERS = [
  ...ANTIGRAVITY_PROVIDERS,
  "codex",
  "minimax",
  "copilot",
  "claude"
] as const;

export const PROVIDER_QUOTA_REFRESH_INTERVAL_MS = 60_000;

export interface ProviderQuotaDiscoveryService {
  start(): void;
  stop(): void;
  refresh(): Promise<Record<string, ControlApiProviderQuota | null>>;
  refreshProvider(provider: string): Promise<ControlApiProviderQuota | null>;
  snapshot(): Record<string, ControlApiProviderQuota | null>;
}

export function createProviderQuotaDiscoveryService(
  options: {
    providers?: readonly string[];
    intervalMs?: number;
    now?: () => number;
  } = {}
): ProviderQuotaDiscoveryService {
  const providers = options.providers ?? DEFAULT_QUOTA_PROVIDERS;
  const intervalMs = options.intervalMs ?? PROVIDER_QUOTA_REFRESH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<Record<string, ControlApiProviderQuota | null>> | null =
    null;

  const refresh = (): Promise<
    Record<string, ControlApiProviderQuota | null>
  > => {
    if (inFlight) return inFlight;
    inFlight = refreshAllProviderQuotas(providers, {
      now: now(),
      syncCooldowns: true
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const refreshProvider = (
    provider: string
  ): Promise<ControlApiProviderQuota | null> => {
    const nowMs = now();
    return discoverProviderQuota(provider, {
      now: nowMs,
      syncCooldowns: true
    });
  };

  const snapshot = (): Record<string, ControlApiProviderQuota | null> => {
    const nowMs = now();
    const result: Record<string, ControlApiProviderQuota | null> = {};
    for (const p of providers) {
      result[p] = getCachedProviderQuota(p, nowMs);
    }
    return result;
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      void refresh().catch(() => {});
      timer = setInterval(() => {
        void refresh().catch(() => {});
      }, intervalMs);
      if (timer.unref) {
        timer.unref();
      }
    },
    stop(): void {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    refresh,
    refreshProvider,
    snapshot
  };
}
