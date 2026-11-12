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

import { loadCodexAuth } from "../router/proxy.ts";

const execFileAsync = promisify(execFile);

const QUOTA_DISCOVERY_TIMEOUT_MS = 6000;
const ANTIGRAVITY_FETCH_MODELS_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
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
    const remainingPercent = clampPercent(100 - usedPercent);
    const windowSeconds =
      typeof win.limit_window_seconds === "number" &&
      Number.isFinite(win.limit_window_seconds)
        ? win.limit_window_seconds
        : null;
    const kind = windowKindFromSeconds(windowSeconds);
    const resetsAt = canonicalIso(win.reset_at);
    windows.push({
      id:
        kind === "five_hour"
          ? "codex-5h"
          : kind === "weekly"
            ? "codex-weekly"
            : fallbackId,
      label: windowLabelFromKind(
        kind,
        key === "primary_window" ? "Primary window" : "Secondary window"
      ),
      kind,
      status: statusFromUsedPercent(usedPercent),
      usedPercent,
      remainingPercent,
      windowSeconds,
      resetsAt
    });
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
    const remainingPercent = clampPercent(100 - usedPercent);
    const minutesRaw = headers.get(`x-codex-${prefix}-window-minutes`);
    const minutes = minutesRaw === null ? Number.NaN : Number(minutesRaw);
    const windowSeconds =
      Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null;
    const kind = windowKindFromSeconds(windowSeconds);
    const resetRaw = headers.get(`x-codex-${prefix}-reset-at`);
    const resetNum = resetRaw === null ? Number.NaN : Number(resetRaw);
    const resetsAt = Number.isFinite(resetNum)
      ? canonicalIso(resetNum)
      : canonicalIso(resetRaw);
    windows.push({
      id:
        kind === "five_hour"
          ? "codex-5h"
          : kind === "weekly"
            ? "codex-weekly"
            : `codex-${prefix}`,
      label: windowLabelFromKind(
        kind,
        prefix === "primary" ? "Primary window" : "Secondary window"
      ),
      kind,
      status: statusFromUsedPercent(usedPercent),
      usedPercent,
      remainingPercent,
      windowSeconds,
      resetsAt
    });
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
      label: windowLabelFromKind(kind, "Usage limit"),
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
        label: windowLabelFromKind(kind, "Usage limit"),
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
    const snap = snapshots.premium_interactions;
    const unlimited = snap.unlimited === true;
    const entitlement =
      typeof snap.entitlement === "number" && Number.isFinite(snap.entitlement)
        ? snap.entitlement
        : null;
    const remaining =
      typeof snap.quota_remaining === "number" &&
      Number.isFinite(snap.quota_remaining)
        ? snap.quota_remaining
        : typeof snap.remaining === "number" && Number.isFinite(snap.remaining)
          ? snap.remaining
          : null;
    const used =
      typeof snap.credits_used === "number" &&
      Number.isFinite(snap.credits_used)
        ? snap.credits_used
        : entitlement !== null && remaining !== null
          ? Math.max(0, Math.round((entitlement - remaining) * 10) / 10)
          : null;
    const remainingPercent = unlimited
      ? 100
      : typeof snap.percent_remaining === "number" &&
          Number.isFinite(snap.percent_remaining)
        ? clampPercent(snap.percent_remaining)
        : entitlement && remaining !== null && entitlement > 0
          ? clampPercent((remaining / entitlement) * 100)
          : null;
    const usedPercent = unlimited
      ? 0
      : remainingPercent === null
        ? null
        : clampPercent(100 - remainingPercent);
    windows.push({
      id: "copilot-premium",
      label: "Monthly premium requests",
      kind: "monthly",
      status: statusFromUsedPercent(usedPercent, unlimited),
      usedPercent,
      remainingPercent,
      used,
      limit: entitlement,
      unit: "requests",
      resetsAt
    });
  }

  if (isRecord(snapshots.chat)) {
    const snap = snapshots.chat;
    const unlimited = snap.unlimited === true;
    const remainingPercent = unlimited
      ? 100
      : typeof snap.percent_remaining === "number"
        ? clampPercent(snap.percent_remaining)
        : null;
    const usedPercent = unlimited
      ? 0
      : remainingPercent === null
        ? null
        : clampPercent(100 - remainingPercent);
    windows.push({
      id: "copilot-chat",
      label: "Chat requests",
      kind: "monthly",
      status: statusFromUsedPercent(usedPercent, unlimited),
      usedPercent,
      remainingPercent,
      resetsAt
    });
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
    "Claude Pro Plan",
    windows,
    nowMs
  );
}

/**
 * Builds one Claude window from a CLI rate-limit reading. The CLI reports
 * `utilization` as a 0..1 fraction. A window whose reset time has already
 * passed has rolled over since the reading was captured, so it reports a fresh
 * window rather than the stale usage (a persisted reading can be days old).
 */
function claudeEventWindow(
  [, id, label, kind]: (typeof CLAUDE_USAGE_WINDOWS)[number],
  reading: {
    utilization: unknown;
    resetsAt: unknown;
    eventStatus: string | null;
  },
  nowMs: number
): ControlApiQuotaWindow | null {
  const resetsAt = canonicalIso(reading.resetsAt);
  if (resetsAt !== null && Date.parse(resetsAt) <= nowMs) {
    return {
      id,
      label,
      kind,
      status: "available",
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null
    };
  }
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
 * (5-hour session and weekly), so each one is reported.
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
  if (windows.length === 0) return null;
  return claudeProviderQuota(
    "claude-cli-rate-limit-event",
    "Claude Pro Plan",
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

async function fetchAntigravityModelsWithToken(
  accessToken: string
): Promise<Response> {
  return fetch(ANTIGRAVITY_FETCH_MODELS_URL, {
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
    let response = await fetchAntigravityModelsWithToken(token);
    if (response.status === 401 || response.status === 403) {
      // Trigger `agy models` once so the CLI refreshes its stored OAuth token.
      await execFileAsync(findAgyBinary() ?? "agy", ["models"], {
        timeout: QUOTA_DISCOVERY_TIMEOUT_MS,
        env: cliSearchEnv()
      }).catch(() => null);
      token = await readAntigravityCliAccessToken();
      if (!token) return {};
      response = await fetchAntigravityModelsWithToken(token);
    }
    if (!response.ok) return {};
    const payload = await response.json();
    return parseAntigravityAvailableModelsQuota(payload, nowMs);
  } catch {
    return {};
  }
}

/**
 * How long one Antigravity quota read answers for all three Antigravity
 * providers. A refresh discovers each provider separately; one
 * `fetchAvailableModels` response carries all three, so the second and third
 * read the first's answer instead of asking the API again.
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

export async function readClaudePlanMetadata(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): Promise<ClaudePlanMetadata | null> {
  const claudeJsonPath = path.join(home, ".claude.json");
  try {
    const raw = await readFile(claudeJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && isRecord(parsed.oauthAccount)) {
      const account = parsed.oauthAccount;
      const orgType =
        typeof account.organizationType === "string"
          ? account.organizationType.trim()
          : "";
      const billingType =
        typeof account.billingType === "string"
          ? account.billingType.trim()
          : null;
      const rateLimitTier =
        typeof account.organizationRateLimitTier === "string"
          ? account.organizationRateLimitTier.trim()
          : null;
      const displayName =
        typeof account.displayName === "string"
          ? account.displayName.trim()
          : null;
      if (orgType === "claude_pro" || billingType === "stripe_subscription") {
        return {
          plan: "Claude Pro Plan",
          billingType,
          rateLimitTier,
          displayName
        };
      }
      if (orgType) {
        return {
          plan: orgType
            .replaceAll("_", " ")
            .replaceAll(/\b\w/g, (c) => c.toUpperCase()),
          billingType,
          rateLimitTier,
          displayName
        };
      }
    }
  } catch {
    // .claude.json not present or unreadable
  }

  // Fallback to macOS Keychain
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 2500 }
    );
    const creds = JSON.parse(stdout.trim()) as unknown;
    if (isRecord(creds) && isRecord(creds.claudeAiOauth)) {
      const oauth = creds.claudeAiOauth;
      const subType =
        typeof oauth.subscriptionType === "string"
          ? oauth.subscriptionType.trim()
          : "";
      const rateLimitTier =
        typeof oauth.rateLimitTier === "string"
          ? oauth.rateLimitTier.trim()
          : null;
      if (subType === "pro") {
        return {
          plan: "Claude Pro Plan",
          billingType: null,
          rateLimitTier,
          displayName: null
        };
      }
      if (subType) {
        return {
          plan: `Claude ${subType.charAt(0).toUpperCase()}${subType.slice(1)} Plan`,
          billingType: null,
          rateLimitTier,
          displayName: null
        };
      }
    }
  } catch {
    // Keychain lookup failed
  }
  return null;
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

export function buildClaudeSubscriptionQuota(
  planMeta: ClaudePlanMetadata,
  nowMs = Date.now()
): ControlApiProviderQuota {
  const windows: ControlApiQuotaWindow[] = CLAUDE_USAGE_WINDOWS.slice(0, 2).map(
    ([, id, label, kind]) => ({
      id,
      label,
      kind,
      status: "available",
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: null
    })
  );
  return claudeProviderQuota(
    "claude-plan-subscription",
    planMeta.plan,
    windows,
    nowMs
  );
}

async function discoverClaudeQuota(
  nowMs: number
): Promise<ControlApiProviderQuota | null> {
  try {
    const bridgeResponse = await fetch(CLAUDE_BRIDGE_HEALTH_URL, {
      signal: AbortSignal.timeout(2500)
    }).catch(() => null);
    if (bridgeResponse?.ok) {
      const body = (await bridgeResponse.json().catch(() => null)) as unknown;
      if (isRecord(body) && body.rateLimitInfo) {
        const parsedEvent = parseClaudeRateLimitEvent(
          body.rateLimitInfo,
          nowMs
        );
        if (parsedEvent) return parsedEvent;
      }
    }
  } catch {
    // Ignore local bridge health errors.
  }

  try {
    const persisted = await readPersistedClaudeRateLimit();
    if (persisted) {
      const parsedEvent = parseClaudeRateLimitEvent(persisted, nowMs);
      if (parsedEvent) return parsedEvent;
    }
  } catch {
    // Ignore persisted read errors.
  }

  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 3000 }
    );
    const creds = JSON.parse(stdout.trim()) as unknown;
    if (isRecord(creds) && isRecord(creds.claudeAiOauth)) {
      const oauth = creds.claudeAiOauth;
      const accessToken =
        typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
      const expiresAt =
        typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
      if (accessToken && (expiresAt === 0 || expiresAt > nowMs)) {
        const response = await fetch(ANTHROPIC_OAUTH_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(QUOTA_DISCOVERY_TIMEOUT_MS)
        });
        if (response.ok) {
          const payload = await response.json();
          const parsed = parseClaudeOAuthUsage(payload, nowMs);
          if (parsed) return parsed;
        }
      }
    }
  } catch {
    // OAuth usage endpoint unavailable or forbidden
  }

  try {
    const planMeta = await readClaudePlanMetadata();
    if (planMeta) {
      return buildClaudeSubscriptionQuota(planMeta, nowMs);
    }
  } catch {
    // Plan metadata unreadable
  }

  return null;
}

export async function discoverProviderQuota(
  provider: string,
  options: { now?: number; syncCooldowns?: boolean } = {}
): Promise<ControlApiProviderQuota | null> {
  const nowMs = options.now ?? Date.now();
  let discovered: ControlApiProviderQuota | null = null;
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

  const refresh = async (): Promise<
    Record<string, ControlApiProviderQuota | null>
  > => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const nowMs = now();
        return await refreshAllProviderQuotas(providers, {
          now: nowMs,
          syncCooldowns: true
        });
      } finally {
        inFlight = null;
      }
    })();
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
