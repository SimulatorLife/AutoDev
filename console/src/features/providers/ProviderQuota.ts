import {
  ANTIGRAVITY_PROVIDERS,
  type ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { instantLabel } from "../../components/ui/instant.ts";

type QuotaAxiSnapshot = NonNullable<ControlApiProvidersResponse["quotaAxi"]>;
type QuotaAxiProvider = QuotaAxiSnapshot["providers"][number];
type QuotaAxiWindow = QuotaAxiProvider["windows"][number];

export interface ProviderQuotaWindowBar {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetText: string | null;
  readonly resetTitle: string | null;
}

/** A fresh, authoritative quota scope that quota-axi says is exhausted now. */
export interface ProviderQuotaExhaustion {
  readonly scope: string;
  readonly limitingWindowId: string;
}

/** Clamps a reported percentage into 0-100 for bar geometry and ARIA only. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function resolveQuotaWindowPercents(window: QuotaAxiWindow): {
  readonly remainingPercent: number;
  readonly usedPercent: number;
} | null {
  const rawRemaining =
    typeof window.percentRemaining === "number" &&
    Number.isFinite(window.percentRemaining)
      ? clampPercent(window.percentRemaining)
      : undefined;
  const rawUsed =
    typeof window.percentUsed === "number" &&
    Number.isFinite(window.percentUsed)
      ? clampPercent(window.percentUsed)
      : undefined;
  if (rawRemaining === undefined && rawUsed === undefined) return null;
  const remainingPercent = rawRemaining ?? clampPercent(100 - rawUsed!);
  const usedPercent = rawUsed ?? clampPercent(100 - remainingPercent);
  return { remainingPercent, usedPercent };
}

function isModelWindow(window: QuotaAxiWindow): boolean {
  const kind: string = (window.kind ?? "").trim().toLowerCase();
  const id = (window.id ?? "").trim().toLowerCase();
  return kind === "model" || id.startsWith("model:");
}

function agyWindowMatchesProvider(
  window: QuotaAxiWindow,
  providerId: string
): boolean {
  const id = (window.id ?? "").trim().toLowerCase();
  if (id.startsWith("gemini_argon") || id.includes("argon")) {
    return providerId === "antigravity-argon";
  }
  if (id.startsWith("gemini_") || id.startsWith("model:gemini")) {
    return providerId === "antigravity-gemini";
  }
  if (
    id.startsWith("claude_gpt") ||
    id.startsWith("claude") ||
    id.startsWith("gpt") ||
    id.startsWith("model:claude") ||
    id.startsWith("model:gpt")
  ) {
    return providerId === "antigravity-claude-gpt";
  }
  return true;
}

const GEMINI_ARGON_PREFIX_RE = /^gemini\s+argon\s+/iu;
const GEMINI_PREFIX_RE = /^gemini\s+/iu;
const CLAUDE_GPT_PREFIX_RE = /^claude\/gpt\s+/iu;

function shortQuotaWindowLabel(window: QuotaAxiWindow): string {
  const id = (window.id ?? "").trim().toLowerCase();
  const rawLabel = (window.label ?? "").trim();
  const lowerLabel = rawLabel.toLowerCase();
  const kind: string = (window.kind ?? "").trim().toLowerCase();
  if (
    id === "5h" ||
    id === "five_hour" ||
    id === "session" ||
    id.endsWith("_5h") ||
    id.endsWith(":5h") ||
    lowerLabel.includes("5h") ||
    lowerLabel.includes("5-hour") ||
    lowerLabel.includes("5 hour") ||
    kind === "rolling"
  ) {
    return "5h";
  }
  if (
    id === "weekly" ||
    id === "7d" ||
    id === "seven_day" ||
    id.endsWith("_weekly") ||
    id.endsWith(":7d") ||
    lowerLabel.includes("weekly") ||
    lowerLabel.includes("7d") ||
    lowerLabel.includes("7-day") ||
    lowerLabel.includes("7 day") ||
    kind === "weekly"
  ) {
    return "7d";
  }
  if (
    id === "daily" ||
    id === "24h" ||
    id.endsWith("_daily") ||
    id.endsWith(":24h") ||
    lowerLabel.includes("daily") ||
    lowerLabel.includes("24h") ||
    kind === "daily"
  ) {
    return "24h";
  }
  if (
    id === "monthly" ||
    lowerLabel === "monthly" ||
    (kind === "monthly" &&
      (lowerLabel.length === 0 || lowerLabel === "monthly"))
  ) {
    return "Monthly";
  }
  const base = rawLabel || window.id || window.kind || "Quota";
  const stripped = base
    .replace(GEMINI_ARGON_PREFIX_RE, "")
    .replace(GEMINI_PREFIX_RE, "")
    .replace(CLAUDE_GPT_PREFIX_RE, "")
    .trim();
  return stripped.length > 0 ? stripped : base.trim();
}

function formatQuotaResetRemaining(
  resetsAt: string | null | undefined,
  nowMs: number
): string | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  if (!Number.isFinite(parsed)) return null;
  const remainingMs = parsed - nowMs;
  if (remainingMs <= 0) return "resetting";
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `in ${totalHours}h ${minutes}m` : `in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

function resolveQuotaWindowReset(
  window: QuotaAxiWindow,
  nowMs: number
): {
  readonly resetText: string | null;
  readonly resetTitle: string | null;
} {
  const relative = formatQuotaResetRemaining(window.resetsAt, nowMs);
  if (relative !== null) {
    const formattedInstant = instantLabel(window.resetsAt);
    return {
      resetText: relative,
      resetTitle:
        formattedInstant.length > 0
          ? `${relative} (${formattedInstant})`
          : relative
    };
  }
  if (
    typeof window.resetText === "string" &&
    window.resetText.trim().length > 0
  ) {
    const fallback = window.resetText.trim();
    return { resetText: fallback, resetTitle: fallback };
  }
  return { resetText: null, resetTitle: null };
}

function quotaBarsForProviderEntry(
  entry: QuotaAxiProvider,
  providerId: string,
  nowMs: number
): ProviderQuotaWindowBar[] {
  const routeWindows = entry.windows.filter(
    (window) =>
      window.shareOf === undefined &&
      (entry.provider !== "agy" || agyWindowMatchesProvider(window, providerId))
  );
  const hasAggregate = routeWindows.some((window) => !isModelWindow(window));
  const selectedWindows = hasAggregate
    ? routeWindows.filter((window) => !isModelWindow(window))
    : routeWindows;
  const accountKey = entry.accountKey ?? "default";
  const bars: ProviderQuotaWindowBar[] = [];
  for (const [index, window] of selectedWindows.entries()) {
    const percents = resolveQuotaWindowPercents(window);
    if (percents === null) continue;
    const reset = resolveQuotaWindowReset(window, nowMs);
    bars.push({
      key: `${entry.provider}:${accountKey}:${window.id}:${index}`,
      label: shortQuotaWindowLabel(window),
      remainingPercent: percents.remainingPercent,
      usedPercent: percents.usedPercent,
      resetText: reset.resetText,
      resetTitle: reset.resetTitle
    });
  }
  return bars;
}

/** Extracts compact per-provider remaining-usage bars from the quota-axi snapshot. */
export function quotaByProvider(
  report: QuotaAxiSnapshot | null,
  nowMs: number
): ReadonlyMap<string, readonly ProviderQuotaWindowBar[]> {
  const grouped = new Map<string, ProviderQuotaWindowBar[]>();
  for (const entry of report?.providers ?? []) {
    // quota-axi reports the one shared Antigravity service as `agy`, while
    // AutoDev exposes its model families as separate provider rows.
    const providerRows =
      entry.provider === "agy" ? ANTIGRAVITY_PROVIDERS : [entry.provider];
    for (const providerId of providerRows) {
      const bars = quotaBarsForProviderEntry(entry, providerId, nowMs);
      if (bars.length === 0) continue;
      const existing = grouped.get(providerId);
      if (existing === undefined) grouped.set(providerId, bars);
      else existing.push(...bars);
    }
  }
  return grouped;
}

function authoritativeExhaustion(
  entry: QuotaAxiProvider,
  availability: NonNullable<
    QuotaAxiProvider["quotaSemantics"]
  >["effectiveAvailability"][number]
): ProviderQuotaExhaustion | null {
  const limitingWindowId = availability.runway?.limitingWindowId;
  if (
    availability.status !== "known" ||
    availability.boundConflict !== undefined ||
    availability.runway?.status !== "exhausted_now" ||
    typeof limitingWindowId !== "string" ||
    !availability.boundedBy.includes(limitingWindowId) ||
    !entry.windows.some(
      (window) => window.id === limitingWindowId && window.shareOf === undefined
    )
  ) {
    return null;
  }
  return { scope: availability.scope, limitingWindowId };
}

function antigravityRouteForExhaustion(
  scope: string,
  limitingWindowId: string
): string | null {
  if (
    scope === "gemini" &&
    (limitingWindowId === "gemini_5h" || limitingWindowId === "gemini_weekly")
  ) {
    return "antigravity-gemini";
  }
  if (
    scope === "claude_gpt" &&
    (limitingWindowId === "claude_gpt_5h" ||
      limitingWindowId === "claude_gpt_weekly")
  ) {
    return "antigravity-claude-gpt";
  }
  return null;
}

function prefersProviderWideExhaustion(
  current: ProviderQuotaExhaustion | undefined,
  candidate: ProviderQuotaExhaustion
): boolean {
  if (current === undefined) return true;
  const candidateIsProviderWide =
    candidate.scope === "all_models" || candidate.scope === "all_products";
  const currentIsProviderWide =
    current.scope === "all_models" || current.scope === "all_products";
  return candidateIsProviderWide && !currentIsProviderWide;
}

/**
 * Projects only quota-axi's explicit, fresh exhaustion verdicts onto Console
 * provider rows. Percentages remain presentation-only bars: they do not prove
 * exhaustion, provider health, or a routing/cooldown decision.
 */
export function exhaustedQuotaByProvider(
  report: QuotaAxiSnapshot | null
): ReadonlyMap<string, ProviderQuotaExhaustion> {
  const exhausted = new Map<string, ProviderQuotaExhaustion>();
  if (report === null || !Number.isFinite(Date.parse(report.generatedAt))) {
    return exhausted;
  }

  for (const entry of report.providers) {
    if (entry.state.status !== "fresh" || entry.state.stale) continue;
    for (const availability of entry.quotaSemantics?.effectiveAvailability ??
      []) {
      const candidate = authoritativeExhaustion(entry, availability);
      if (candidate === null) continue;
      // The shared service has separate AutoDev routes. Do not fan an
      // unfamiliar limiter out to every route row: both its quota scope and
      // authoritative limiting window must identify the same family.
      const providerId =
        entry.provider === "agy"
          ? antigravityRouteForExhaustion(
              candidate.scope,
              candidate.limitingWindowId
            )
          : entry.provider;
      if (providerId === null) continue;
      const current = exhausted.get(providerId);
      // Prefer a provider-wide verdict when the report also names narrower
      // exhausted scopes, while retaining one explicit scope for the badge.
      if (prefersProviderWideExhaustion(current, candidate)) {
        exhausted.set(providerId, candidate);
      }
    }
  }
  return exhausted;
}

export function ProviderQuotaCell({
  providerId,
  windows
}: {
  readonly providerId: string;
  readonly windows: readonly ProviderQuotaWindowBar[];
}): React.JSX.Element | null {
  if (windows.length === 0) return null;
  return React.createElement(
    "div",
    {
      className: "mt-1 flex w-36 max-w-full flex-col gap-1",
      "data-provider-quota": providerId
    },
    ...windows.map((window) => {
      const isExhausted =
        window.usedPercent >= 100 || window.remainingPercent <= 0;
      const isWarning =
        !isExhausted &&
        (window.usedPercent > 95 || window.remainingPercent < 5);
      const remainingRounded = Math.round(window.remainingPercent);
      const remainingLabel = `${remainingRounded}%`;
      const summaryText = `${window.label} ${remainingLabel}`;
      const barColorClass = isExhausted
        ? "bg-error"
        : isWarning
          ? "bg-warning"
          : "bg-accent";
      const textColorClass = isExhausted
        ? "text-error"
        : isWarning
          ? "text-warning"
          : "text-fg-secondary";
      const barWidth = isExhausted
        ? 100
        : Math.max(0, Math.min(100, remainingRounded));
      return React.createElement(
        "div",
        { key: window.key, className: "flex flex-col gap-0.5" },
        React.createElement(
          "div",
          {
            className:
              "flex flex-wrap items-baseline justify-between gap-x-1.5 gap-y-0 font-mono text-micro leading-tight"
          },
          React.createElement(
            "span",
            {
              className: `max-w-full truncate ${textColorClass}`,
              title: summaryText
            },
            summaryText
          ),
          window.resetText === null
            ? null
            : React.createElement(
                "span",
                {
                  className: "max-w-full truncate text-fg-muted",
                  title: window.resetTitle ?? window.resetText
                },
                window.resetText
              )
        ),
        React.createElement(
          "div",
          {
            className:
              "h-1 w-full overflow-hidden rounded-full bg-surface-raised",
            role: "progressbar",
            "aria-label": `${providerId} ${window.label} remaining usage`,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": remainingRounded
          },
          React.createElement("div", {
            className: `h-full rounded-full ${barColorClass}`,
            style: { width: `${barWidth}%` }
          })
        )
      );
    })
  );
}
