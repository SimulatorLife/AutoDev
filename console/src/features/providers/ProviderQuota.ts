import {
  ANTIGRAVITY_PROVIDERS,
  type ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";

type QuotaAxiSnapshot = NonNullable<ControlApiProvidersResponse["quotaAxi"]>;
type QuotaAxiProvider = QuotaAxiSnapshot["providers"][number];
type QuotaAxiWindow = QuotaAxiProvider["windows"][number];

export interface ProviderQuotaWindowBar {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetText: string | null;
  readonly resetAt: string | null;
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

function resolveQuotaWindowReset(window: QuotaAxiWindow): {
  readonly resetText: string | null;
  readonly resetAt: string | null;
} {
  const resetsAt = window.resetsAt ?? null;
  if (resetsAt !== null && Number.isFinite(Date.parse(resetsAt))) {
    return { resetText: null, resetAt: resetsAt };
  }
  if (
    typeof window.resetText === "string" &&
    window.resetText.trim().length > 0
  ) {
    const fallback = window.resetText.trim();
    return { resetText: fallback, resetAt: null };
  }
  return { resetText: null, resetAt: null };
}

function quotaBarsForProviderEntry(
  entry: QuotaAxiProvider,
  providerId: string
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
    const reset = resolveQuotaWindowReset(window);
    bars.push({
      key: `${entry.provider}:${accountKey}:${window.id}:${index}`,
      label: shortQuotaWindowLabel(window),
      remainingPercent: percents.remainingPercent,
      usedPercent: percents.usedPercent,
      resetText: reset.resetText,
      resetAt: reset.resetAt
    });
  }
  return bars;
}

/** Extracts compact per-provider usage bars from the quota-axi snapshot. */
export function quotaByProvider(
  report: QuotaAxiSnapshot | null
): ReadonlyMap<string, readonly ProviderQuotaWindowBar[]> {
  const grouped = new Map<string, ProviderQuotaWindowBar[]>();
  for (const entry of report?.providers ?? []) {
    // quota-axi reports the one shared Antigravity service as `agy`, while
    // AutoDev exposes its model families as separate provider rows.
    const providerRows =
      entry.provider === "agy" ? ANTIGRAVITY_PROVIDERS : [entry.provider];
    for (const providerId of providerRows) {
      const bars = quotaBarsForProviderEntry(entry, providerId);
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

function isProviderWideRoutingScope(scope: string): boolean {
  return scope === "all_models" || scope === "all_products";
}

function isModelScope(scope: string): boolean {
  return scope.startsWith("model:");
}

/**
 * The exhaustion that leaves a single-route provider unable to serve anything.
 *
 * A provider-wide scope (`all_models`/`all_products`), when reported, is the
 * whole verdict: one exhausted model under a live provider-wide scope (Claude's
 * `model:opus`) leaves the provider's other models serving. A provider that
 * reports no provider-wide scope meters its capacity only per model family --
 * MiniMax's `model:general`, bounded by both a 5h and a 7d window -- so it is
 * exhausted once every model scope it reports is exhausted, whichever of its
 * windows ran out. Non-routing workloads (`code_review`, `tools`, ...) never
 * decide it.
 */
function providerRouteExhaustion(
  entry: QuotaAxiProvider
): ProviderQuotaExhaustion | null {
  const availabilities = entry.quotaSemantics?.effectiveAvailability ?? [];
  const providerWide = availabilities.filter((availability) =>
    isProviderWideRoutingScope(availability.scope)
  );
  if (providerWide.length > 0) {
    for (const availability of providerWide) {
      const candidate = authoritativeExhaustion(entry, availability);
      if (candidate !== null) return candidate;
    }
    return null;
  }
  const modelScopes = availabilities.filter((availability) =>
    isModelScope(availability.scope)
  );
  if (modelScopes.length === 0) return null;
  let first: ProviderQuotaExhaustion | null = null;
  for (const availability of modelScopes) {
    const candidate = authoritativeExhaustion(entry, availability);
    if (candidate === null) return null;
    first ??= candidate;
  }
  return first;
}

/**
 * The shared Antigravity service has separate AutoDev routes. Do not fan an
 * unfamiliar limiter out to every route row: both its quota scope and
 * authoritative limiting window must identify the same family.
 */
function antigravityExhaustions(
  entry: QuotaAxiProvider
): [string, ProviderQuotaExhaustion][] {
  const routes: [string, ProviderQuotaExhaustion][] = [];
  for (const availability of entry.quotaSemantics?.effectiveAvailability ??
    []) {
    const candidate = authoritativeExhaustion(entry, availability);
    if (candidate === null) continue;
    const route = antigravityRouteForExhaustion(
      candidate.scope,
      candidate.limitingWindowId
    );
    if (route !== null) routes.push([route, candidate]);
  }
  return routes;
}

function hasValidGeneratedAt(report: QuotaAxiSnapshot): boolean {
  return Number.isFinite(Date.parse(report.generatedAt));
}

function isFreshQuotaEntry(entry: QuotaAxiProvider): boolean {
  return entry.state.status === "fresh" && !entry.state.stale;
}

/**
 * How much of the quota report can support an exhaustion count.
 *
 * Exhaustion is only ever projected from fresh readings, so a count of zero is
 * an observation only when some fresh reading exists. `partial` means some
 * entries are stale, failed or unreadable, so providers they cover are not
 * known to be non-exhausted.
 */
export type QuotaExhaustionEvidence =
  "fresh" | "partial" | "stale" | "invalid" | "missing";

export function quotaExhaustionEvidence(
  report: QuotaAxiSnapshot | null
): QuotaExhaustionEvidence {
  if (report === null) return "missing";
  if (!hasValidGeneratedAt(report)) return "invalid";
  const fresh = report.providers.filter(isFreshQuotaEntry).length;
  if (fresh === 0) return "stale";
  return fresh === report.providers.length ? "fresh" : "partial";
}

/**
 * Projects quota-axi's explicit, fresh exhaustion verdicts onto Console
 * provider rows: a provider is exhausted when *any* window bounding the
 * capacity it routes is exhausted -- a free 5h window does not make a provider
 * with an exhausted 7d window usable. Non-routing workloads (such as
 * `code_review`, `tools`, or `grok_bot`), a single model scope beside a
 * live provider-wide scope, stale readings, and raw percentages do not mark a
 * usable provider unavailable.
 */
export function exhaustedQuotaByProvider(
  report: QuotaAxiSnapshot | null
): ReadonlyMap<string, ProviderQuotaExhaustion> {
  const exhausted = new Map<string, ProviderQuotaExhaustion>();
  if (report === null || !hasValidGeneratedAt(report)) return exhausted;

  for (const entry of report.providers) {
    if (!isFreshQuotaEntry(entry)) continue;
    if (entry.provider !== "agy") {
      const candidate = providerRouteExhaustion(entry);
      if (candidate !== null && !exhausted.has(entry.provider))
        exhausted.set(entry.provider, candidate);
      continue;
    }
    for (const [providerId, candidate] of antigravityExhaustions(entry)) {
      if (!exhausted.has(providerId)) exhausted.set(providerId, candidate);
    }
  }
  return exhausted;
}

/**
 * What the quota report says about a provider whose reading is not fresh.
 *
 * The bars are the report's windows. A provider the report has no usable
 * window for is a different fact from a provider the report could not read at
 * all, and the row used to look the same for both: the quota cell rendered
 * nothing, so Claude -- whose quota endpoint was refusing every read -- looked
 * exactly like a provider quota-axi has no source for. The operator could not
 * tell "this provider has no quota" from "this provider's quota could not be
 * read", and only one of those is a fact about the provider.
 *
 * The state is the report's own: its status, its error and its retry hint,
 * read as supplied. AutoDev does not decide what a failed read means, and it
 * does not turn a failed read into a quota value.
 */
export interface ProviderQuotaReadState {
  /** The short fact, as the cell shows it. */
  readonly label: string;
  /** When the report asks for the read to be retried. */
  readonly retryAt: string | null;
  /** The report's own explanation, for the hover title. */
  readonly title: string;
}

/**
 * The Console's wording for each state quota-axi reports.
 *
 * `fresh` is absent on purpose: a fresh reading is the one that has bars, and a
 * state line beside fresh bars would be saying nothing. A state this Console
 * does not know is left unsaid rather than guessed at.
 */
const QUOTA_READ_STATE_LABEL: Readonly<Record<string, string>> = {
  rate_limited: "Quota rate limited",
  auth_required: "Quota sign-in required",
  unavailable: "Quota unavailable",
  error: "Quota read failed",
  stale: "Quota stale"
};

/**
 * Why each state means what it means, in the Console's voice.
 *
 * None of these is a verdict about the provider: a quota read that failed says
 * nothing about whether the provider can serve a request, which is what the
 * Status column answers. They say what is missing from this cell.
 */
const QUOTA_READ_STATE_EXPLANATION: Readonly<Record<string, string>> = {
  rate_limited:
    "The quota endpoint refused this read and asked to be retried later. The provider itself is unaffected; only its usage is not being shown.",
  auth_required:
    "Reading this provider's quota needs a sign-in this Runtime does not have, so its usage cannot be shown.",
  unavailable:
    "This provider's quota could not be read, so its usage cannot be shown.",
  error: "Reading this provider's quota failed, so its usage cannot be shown.",
  stale:
    "This quota reading is stale: it was taken earlier and has not been refreshed."
};

/**
 * The read state of every provider in the report whose reading is not fresh.
 *
 * The report is the Runtime's JSON, which is quota-axi's own apart from a
 * provider that is waiting for its retry moment, whose entry the Runtime
 * carries forward unchanged. Its inner shape is read defensively either way: a
 * state this Console does not know is left unsaid rather than guessed at, and a
 * malformed entry is skipped rather than thrown on.
 *
 * The shared Antigravity service fans out the same way its windows do: one
 * quota source, three route rows, each showing that source's state.
 */
export function quotaReadStates(
  report: QuotaAxiSnapshot | null
): ReadonlyMap<string, ProviderQuotaReadState> {
  const states = new Map<string, ProviderQuotaReadState>();
  for (const entry of report?.providers ?? []) {
    const status = (entry?.state?.status ?? "").trim().toLowerCase();
    const label = QUOTA_READ_STATE_LABEL[status];
    if (label === undefined) continue;
    const error = (entry.state?.error ?? "").trim();
    const explanation = QUOTA_READ_STATE_EXPLANATION[status] ?? "";
    const retryAfter = entry.state?.retryAfter;
    const retryAt = retryAfter ?? null;
    const state: ProviderQuotaReadState = {
      label,
      retryAt:
        retryAt !== null && Number.isFinite(Date.parse(retryAt))
          ? retryAt
          : null,
      title:
        error === ""
          ? explanation
          : `${explanation} The quota report says: ${error}.`
    };
    const providerRows =
      entry.provider === "agy" ? ANTIGRAVITY_PROVIDERS : [entry.provider];
    for (const providerId of providerRows) states.set(providerId, state);
  }
  return states;
}

/**
 * What the quota report says about each provider, in the three shapes the
 * Console reads it in: the windows it can draw bars from, the state of a
 * reading it could not draw, and the authoritative exhaustion verdicts.
 *
 * One value rather than three parallel maps, because they are three readings
 * of the same report about the same providers.
 */
export interface ProviderQuotaView {
  /** The windows each provider's usage can be drawn from. */
  readonly windows: ReadonlyMap<string, readonly ProviderQuotaWindowBar[]>;
  /** The state of each provider whose reading is not fresh. */
  readonly readStates: ReadonlyMap<string, ProviderQuotaReadState>;
  /** The fresh, known exhaustion verdicts. */
  readonly exhaustion: ReadonlyMap<string, ProviderQuotaExhaustion>;
}

export function providerQuotaView(
  report: QuotaAxiSnapshot | null
): ProviderQuotaView {
  return {
    windows: quotaByProvider(report),
    readStates: quotaReadStates(report),
    exhaustion: exhaustedQuotaByProvider(report)
  };
}

/**
 * The read state as the cell shows it: the fact and, when present, its retry
 * instant.
 */
function ProviderQuotaReadStateLine({
  providerId,
  state
}: {
  readonly providerId: string;
  readonly state: ProviderQuotaReadState;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-0.5",
      "data-provider-quota-state": providerId
    },
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-baseline justify-between gap-x-1.5 gap-y-0 text-micro leading-tight"
      },
      React.createElement(
        "span",
        {
          className: "max-w-full truncate text-fg-secondary",
          title: state.title
        },
        state.label
      ),
      React.createElement(InstantDisplay, {
        value: state.retryAt,
        label: "Quota retry time"
      })
    )
  );
}

export function ProviderQuotaCell({
  providerId,
  windows,
  readState
}: {
  readonly providerId: string;
  readonly windows: readonly ProviderQuotaWindowBar[];
  readonly readState?: ProviderQuotaReadState | undefined;
}): React.JSX.Element | null {
  if (windows.length === 0 && readState === undefined) return null;
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
      const remainingRounded = isExhausted
        ? 0
        : Math.max(1, Math.round(window.remainingPercent));
      const usedRounded = isExhausted
        ? 100
        : Math.min(99, Math.round(window.usedPercent));
      const summaryText = `${window.label} ${usedRounded}% used`;
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
      const barWidth = Math.max(0, Math.min(100, usedRounded));
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
            ? React.createElement(InstantDisplay, {
                value: window.resetAt,
                label: "Quota reset time"
              })
            : React.createElement(
                "span",
                {
                  className: "max-w-full truncate text-fg-muted",
                  title: window.resetText
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
            "aria-label": `${providerId} ${window.label} used quota`,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": usedRounded,
            "aria-valuetext": `${usedRounded}% used, ${remainingRounded}% remaining`
          },
          React.createElement("div", {
            className: `h-full rounded-full ${barColorClass}`,
            style: { width: `${barWidth}%` }
          })
        )
      );
    }),
    // The state of a reading that could not be drawn as bars. It rides in the
    // same cell because it is the same fact -- this provider's quota -- and a
    // cell that says nothing about the quota is what made a provider whose
    // read was refused look like a provider quota-axi has no source for.
    ...(readState === undefined
      ? []
      : [
          React.createElement(ProviderQuotaReadStateLine, {
            key: "read-state",
            providerId,
            state: readState
          })
        ])
  );
}
