#!/usr/bin/env node

import {
  type RouterProviderRuntimeStatus,
  type RouterRuntimeStatus
} from "@simulatorlife/autodev-runtime/router/status";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import { fetchRouterStatus } from "./router-status-client.ts";

let body: RouterRuntimeStatus;
try {
  body = await fetchRouterStatus();
} catch (error) {
  writeErrorLine(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (process.argv.includes("--json")) {
  writeLine(JSON.stringify(body, null, 2));
  process.exit(0);
}

writeLine(
  `Router ${body.router} (pid ${body.pid}, instance ${body.routerInstanceId})`
);
writeLine(`Started: ${body.startedAt}`);

const routing = body.routing ?? {};
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const counts = (record: unknown): string =>
  Object.entries(asRecord(record))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ") || "-";
const providers: Record<string, RouterProviderRuntimeStatus> =
  body.providers ?? {};
const enabledOrchestratorProviders =
  routing.enabledOrchestratorProviders ??
  Object.keys(providers).filter(
    (p) => providers[p]?.orchestratorEnabled !== false
  );
const disabledOrchestratorProviders =
  routing.disabledOrchestratorProviders ??
  Object.keys(providers).filter(
    (p) => providers[p]?.orchestratorEnabled === false
  );
const enabledSubagentProviders =
  routing.enabledSubagentProviders ??
  Object.keys(providers).filter((p) => providers[p]?.subagentEnabled !== false);
const disabledSubagentProviders =
  routing.disabledSubagentProviders ??
  Object.keys(providers).filter((p) => providers[p]?.subagentEnabled === false);

writeLine("");
writeLine(
  `Orchestrators: ${enabledOrchestratorProviders.length} enabled (${enabledOrchestratorProviders.join(", ") || "-"}), ${disabledOrchestratorProviders.length} disabled (${disabledOrchestratorProviders.join(", ") || "none"})`
);
writeLine(
  `Subagents: ${enabledSubagentProviders.length} enabled (${enabledSubagentProviders.join(", ") || "-"}), ${disabledSubagentProviders.length} disabled (${disabledSubagentProviders.join(", ") || "none"})`
);
const disabledModels = routing.disabledModels ?? [];
writeLine(
  `Models: ${disabledModels.length} disabled (${disabledModels.join(", ") || "none"})`
);

if (routing.providerGroups && typeof routing.providerGroups === "object") {
  writeLine("Configured priority groups:");
  for (const [tier, groups] of Object.entries(
    asRecord(routing.providerGroups)
  )) {
    const groupDesc = (Array.isArray(groups) ? (groups as unknown[]) : [])
      .map(
        (g, idx) =>
          `P${idx + 1}: [${(Array.isArray(g) ? (g as unknown[]) : [g]).join(", ")}]`
      )
      .join(" -> ");
    writeLine(`  ${tier}: ${groupDesc}`);
  }
}

if (body.limits && typeof body.limits === "object") {
  const lim = body.limits;
  const msToSec = (ms: unknown): string =>
    `${Math.round(Number(ms ?? 0) / 1000)}s`;
  writeLine("Effective limits & cooldowns:");
  writeLine(
    `  transient cooldown: ${msToSec(lim.providerCooldownMs)}-${msToSec(lim.providerCooldownMaxMs)}, hard cooldown: ${msToSec(lim.hardCooldownMs)}-${msToSec(lim.hardCooldownMaxMs)}`
  );
  writeLine(
    `  probe cooldown: ${msToSec(lim.probeCooldownMs)}-${msToSec(lim.probeCooldownMaxMs)} (timeout ${lim.probeTimeoutMs ?? 700}ms), exhaustion wait: ${lim.exhaustionWaitMs ?? 0}ms`
  );
  writeLine(
    `  last resort max attempts: ${lim.lastResortMaxAttempts ?? 2}, chain selection deadline: ${msToSec(lim.chainSelectionDeadlineMs)}, per-session concurrency: ${lim.maxConcurrentThreadsPerSession ?? "unlimited"}`
  );
}

const groupContainsProvider = (group: unknown, providerName: string): boolean =>
  Array.isArray(group) &&
  (group as unknown[]).some(
    (name) =>
      typeof name === "string" &&
      name.toLowerCase() === providerName.toLowerCase()
  );

const configuredGroupPriorities = (providerName: string): string[] => {
  const tierPrios: string[] = [];
  for (const [tier, groups] of Object.entries(
    asRecord(routing.providerGroups)
  )) {
    if (!Array.isArray(groups)) continue;
    const gIdx = (groups as unknown[]).findIndex((group) =>
      groupContainsProvider(group, providerName)
    );
    if (gIdx !== -1) tierPrios.push(`${tier}: P${gIdx + 1}`);
  }
  return tierPrios;
};

const formatProviderPriority = (
  providerName: string,
  state: RouterProviderRuntimeStatus
): string => {
  if (
    state.routingPriority &&
    state.routingPriority !== "—" &&
    state.routingPriority !== "-"
  ) {
    return state.routingPriority;
  }
  const statusPriorities = asRecord(routing.priorities)[providerName];
  if (statusPriorities && typeof statusPriorities === "object") {
    const parts = Object.entries(statusPriorities).map(
      ([tier, prio]) => `${tier}: ${prio}`
    );
    if (parts.length > 0) return parts.join(" · ");
  }
  const tierPrios = configuredGroupPriorities(providerName);
  if (tierPrios.length > 0) return tierPrios.join(" · ");
  return "-";
};

const getProviderLiveActivity = (state: RouterProviderRuntimeStatus): number =>
  Number(state.active ?? 0);

const getProviderInFlight = (state: RouterProviderRuntimeStatus): number =>
  Number(state.inFlightRequests ?? 0);

// Limit keys the router itself owns. Anything else under `limits` is a
// caller-supplied live limit and is reported verbatim, so the two sets cannot
// overlap without one silently hiding the other.
const COOLDOWN_LIMIT_KEYS = new Set([
  "cooldownKind",
  "cooldownFailureClass",
  "cooldownResetsAt",
  "cooldownUntil",
  "cooldownRemainingMs",
  "lastResortEligible"
]);

/**
 * A provider's cooldown as the status report needs it: every field the router
 * may publish under `limits` (the live view) or directly on the provider
 * status (the last observed snapshot), resolved to one value per field. The
 * two surfaces drift in lockstep, so each field prefers `limits` and falls back
 * to the provider snapshot, and the caller never has to repeat that choice.
 */
type ProviderCooldown = {
  readonly remainingMs: number;
  readonly resetsAt: unknown;
  readonly kind: unknown;
  readonly failureClass: unknown;
  readonly until: unknown;
  readonly lastResortEligible: unknown;
};

const resolveCooldown = (
  state: RouterProviderRuntimeStatus
): ProviderCooldown => {
  const limits = asRecord(state.limits);
  return {
    remainingMs: Number(
      limits.cooldownRemainingMs ?? state.cooldownRemainingMs ?? 0
    ),
    resetsAt: limits.cooldownResetsAt ?? state.cooldownResetsAt ?? null,
    kind: limits.cooldownKind ?? state.cooldownKind ?? null,
    failureClass:
      limits.cooldownFailureClass ?? state.cooldownFailureClass ?? null,
    until: limits.cooldownUntil ?? state.cooldownUntil ?? null,
    lastResortEligible:
      limits.lastResortEligible ?? state.lastResortEligible ?? true
  };
};

/** The cooldown annotation appended to the provider's status column. */
const formatCooldownSuffix = (cooldown: ProviderCooldown): string =>
  cooldown.remainingMs > 0 || cooldown.resetsAt
    ? cooldown.resetsAt
      ? ` (${cooldown.kind ?? "cooldown"}, resets ${cooldown.resetsAt})`
      : ` (${cooldown.kind ?? "cooldown"} ${Math.ceil(cooldown.remainingMs / 1000)}s)`
    : "";

/** Why a provider is unavailable right now, when it is cooling down at all. */
const cooldownDetailLines = (cooldown: ProviderCooldown): string[] => {
  if (!cooldown.remainingMs && !cooldown.resetsAt && !cooldown.kind) return [];
  const kind = cooldown.kind ?? "transient";
  const fClass = cooldown.failureClass ? `/${cooldown.failureClass}` : "";
  const lines = [`cooldown: ${kind}${fClass}`];
  if (cooldown.remainingMs > 0)
    lines.push(`remaining: ${Math.ceil(cooldown.remainingMs / 1000)}s`);
  if (cooldown.until) lines.push(`until: ${cooldown.until}`);
  if (cooldown.resetsAt) lines.push(`resets: ${cooldown.resetsAt}`);
  lines.push(
    `last resort: ${cooldown.lastResortEligible ? "eligible" : "ineligible"}`
  );
  return lines;
};

/**
 * The live limits in force for a provider, or null when there are none. A
 * published effective-limit block is reported verbatim; failing that, the
 * caller's own `limits` table contributes anything the router did not claim.
 */
const formatLiveLimits = (
  state: RouterProviderRuntimeStatus
): string | null => {
  const published =
    state.effectiveLimits ??
    state.effectiveLimit ??
    state.liveLimits ??
    state.liveLimit ??
    state.rateLimit;
  if (published != null) {
    const rendered =
      typeof published === "object" && !Array.isArray(published)
        ? Object.entries(published)
            .filter(([, value]) => value != null && value !== "")
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ")
        : String(published);
    return rendered ? `live limits: [${rendered}]` : null;
  }
  if (!state.limits || typeof state.limits !== "object") return null;
  const custom = Object.entries(state.limits).filter(
    ([key, value]) =>
      !COOLDOWN_LIMIT_KEYS.has(key) && value != null && value !== ""
  );
  if (custom.length === 0) return null;
  return `live limits: [${custom.map(([key, value]) => `${key}: ${value}`).join(", ")}]`;
};

/**
 * The indented explanation printed under a provider row: what it is cooling
 * down from, how its failure streaks stand, and any live limits in force. These
 * only appear when there is something to say, so the caller prints nothing for
 * an empty list.
 */
const providerDetailLines = (
  state: RouterProviderRuntimeStatus,
  cooldown: ProviderCooldown
): string[] => {
  const details = cooldownDetailLines(cooldown);
  if ((state.failureStreak ?? 0) > 0)
    details.push(`failure streak: ${state.failureStreak}`);
  if ((state.probeFailureStreak ?? 0) > 0)
    details.push(`probe streak: ${state.probeFailureStreak}`);
  const liveLimits = formatLiveLimits(state);
  if (liveLimits) details.push(liveLimits);
  return details;
};

writeLine("");
writeLine(
  "Provider     State     Priority                                Status                                   Active  In-Flight  Last failure"
);
writeLine(
  "-----------  --------  --------------------------------------  ---------------------------------------  ------  ---------  ------------"
);
for (const [provider, state] of Object.entries(providers)) {
  const isSubagentEnabled = state.subagentEnabled !== false;
  const isOrchestratorEnabled = state.orchestratorEnabled !== false;
  const stateLabel = isSubagentEnabled ? "enabled" : "disabled";
  const priority = formatProviderPriority(provider, state);
  const lastFailure = state.lastFailure
    ? `${state.lastFailure.class}${state.lastFailure.status ? ` (HTTP ${state.lastFailure.status})` : ""}`
    : "-";

  const cooldown = resolveCooldown(state);
  const displayStatus = String(
    isSubagentEnabled
      ? (state.subagentStatus ?? state.status ?? "ready")
      : "disabled"
  );
  const activeCount = getProviderLiveActivity(state);
  const inFlightCount = getProviderInFlight(state);
  writeLine(
    `${provider.padEnd(11)}  ${`${stateLabel}/${isOrchestratorEnabled ? "enabled" : "disabled"}`.padEnd(18)}  ${priority.padEnd(38)}  ${(displayStatus + formatCooldownSuffix(cooldown)).padEnd(39)}  ${String(activeCount).padStart(6)}  ${String(inFlightCount).padStart(9)}  ${lastFailure}`
  );

  const details = providerDetailLines(state, cooldown);
  if (details.length > 0) {
    writeLine(`  ↳ ${details.join(" · ")}`);
  }
}

const concurrency = asRecord(body.concurrency);
const limit = (value: unknown): string | number =>
  value == null
    ? "unlimited"
    : typeof value === "number"
      ? value
      : String(value);
const lastDenialRecord = asRecord(concurrency.lastDenial);
const lastDenial = concurrency.lastDenial
  ? `${lastDenialRecord.reason} (${lastDenialRecord.sessionScope})`
  : "-";
const denialsByReason = counts(concurrency.denialsByReason);
const fallbackWarning = concurrency.processFallbackEnforcement
  ? ` [WARNING: ${concurrency.processFallbackActiveThreads} active thread(s) have no caller-supplied session id and are sharing one process-wide bucket instead of independent per-session slots -- over-denial risk]`
  : "";
const totalInFlight = Object.values(asRecord(body.inFlightRequests)).reduce(
  (sum: number, v) => sum + Number(v ?? 0),
  0
);
writeLine("");
writeLine(
  `Concurrency: per-session ${limit(concurrency.effectivePerSessionLimit)}, active sessions ${concurrency.activeSessions ?? 0}, active subagents ${concurrency.activeSubagentThreads ?? 0}, in-flight requests ${totalInFlight}, denials ${concurrency.denials ?? 0} (${denialsByReason}), last denial ${lastDenial}${fallbackWarning}`
);
