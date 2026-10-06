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

  const pLimits = asRecord(state.limits);
  const cooldownRemainingMs = Number(
    pLimits.cooldownRemainingMs ?? state.cooldownRemainingMs ?? 0
  );
  const cooldownResetsAt =
    pLimits.cooldownResetsAt ?? state.cooldownResetsAt ?? null;
  const cooldownKind = pLimits.cooldownKind ?? state.cooldownKind ?? null;
  const cooldownFailureClass =
    pLimits.cooldownFailureClass ?? state.cooldownFailureClass ?? null;
  const cooldownUntil = pLimits.cooldownUntil ?? state.cooldownUntil ?? null;
  const lastResortEligible =
    pLimits.lastResortEligible ?? state.lastResortEligible ?? true;

  const cooldown =
    cooldownRemainingMs > 0 || cooldownResetsAt
      ? cooldownResetsAt
        ? ` (${cooldownKind ?? "cooldown"}, resets ${cooldownResetsAt})`
        : ` (${cooldownKind ?? "cooldown"} ${Math.ceil(cooldownRemainingMs / 1000)}s)`
      : "";
  const displayStatus = String(
    isSubagentEnabled
      ? (state.subagentStatus ?? state.status ?? "ready")
      : "disabled"
  );
  const activeCount = getProviderLiveActivity(state);
  const inFlightCount = getProviderInFlight(state);
  writeLine(
    `${provider.padEnd(11)}  ${`${stateLabel}/${isOrchestratorEnabled ? "enabled" : "disabled"}`.padEnd(18)}  ${priority.padEnd(38)}  ${(displayStatus + cooldown).padEnd(39)}  ${String(activeCount).padStart(6)}  ${String(inFlightCount).padStart(9)}  ${lastFailure}`
  );

  const details: string[] = [];
  if (cooldownRemainingMs > 0 || cooldownResetsAt || cooldownKind) {
    const kind = cooldownKind ?? "transient";
    const fClass = cooldownFailureClass ? `/${cooldownFailureClass}` : "";
    details.push(`cooldown: ${kind}${fClass}`);
    if (cooldownRemainingMs > 0)
      details.push(`remaining: ${Math.ceil(cooldownRemainingMs / 1000)}s`);
    if (cooldownUntil) details.push(`until: ${cooldownUntil}`);
    if (cooldownResetsAt) details.push(`resets: ${cooldownResetsAt}`);
    details.push(
      `last resort: ${lastResortEligible ? "eligible" : "ineligible"}`
    );
  }
  if ((state.failureStreak ?? 0) > 0)
    details.push(`failure streak: ${state.failureStreak}`);
  if ((state.probeFailureStreak ?? 0) > 0)
    details.push(`probe streak: ${state.probeFailureStreak}`);

  const rawLimits =
    state.effectiveLimits ??
    state.effectiveLimit ??
    state.liveLimits ??
    state.liveLimit ??
    state.rateLimit;
  if (rawLimits != null) {
    const limStr =
      typeof rawLimits === "object" && !Array.isArray(rawLimits)
        ? Object.entries(rawLimits)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : String(rawLimits);
    if (limStr) details.push(`live limits: [${limStr}]`);
  } else if (state.limits && typeof state.limits === "object") {
    const knownKeys = new Set([
      "cooldownKind",
      "cooldownFailureClass",
      "cooldownResetsAt",
      "cooldownUntil",
      "cooldownRemainingMs",
      "lastResortEligible"
    ]);
    const customEntries = Object.entries(state.limits).filter(
      ([k, v]) => !knownKeys.has(k) && v != null && v !== ""
    );
    if (customEntries.length > 0) {
      details.push(
        `live limits: [${customEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}]`
      );
    }
  }
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
