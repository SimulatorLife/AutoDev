#!/usr/bin/env node

import {
  parseRouterStatus,
  type RouterProviderStatus,
  serializeRouterStatus
} from "../router/status.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const asRecordList = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map((entry) => asRecord(entry)) : [];

const counts = (record: unknown): string =>
  Object.entries(asRecord(record))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ") || "-";
const host = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const port = process.env.CODEX_MODEL_ROUTER_PORT ?? "4100";
const endpoint = `http://${host}:${port}/status`;
const response = await fetch(endpoint);
const body = parseRouterStatus(await response.json());
if (!response.ok) {
  const errorMessage = asRecord(body.error).message;
  writeErrorLine(
    errorMessage == null
      ? `Router status request failed with HTTP ${response.status}`
      : String(errorMessage)
  );
  process.exit(1);
}

if (process.argv.includes("--json")) {
  writeLine(serializeRouterStatus(body));
  process.exit(0);
}

writeLine(
  `Router ${body.router} (pid ${body.pid}, instance ${body.routerInstanceId})`
);
writeLine(`Started: ${body.startedAt}`);

const routing = body.routing ?? {};
const providers: Record<string, RouterProviderStatus> = body.providers ?? {};
const enabledProviders =
  routing.enabledProviders ??
  Object.keys(providers).filter(
    (p) =>
      providers[p]?.enabled !== false && providers[p]?.status !== "disabled"
  );
const disabledProviders =
  routing.disabledProviders ??
  Object.keys(providers).filter(
    (p) =>
      providers[p]?.enabled === false || providers[p]?.status === "disabled"
  );

writeLine("");
writeLine(
  `Providers: ${enabledProviders.length} enabled (${enabledProviders.join(", ") || "-"}), ${disabledProviders.length} disabled (${disabledProviders.join(", ") || "none"})`
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
  state: RouterProviderStatus
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

const getProviderLiveActivity = (state: RouterProviderStatus): number =>
  Number(state.active ?? 0);

const getProviderInFlight = (state: RouterProviderStatus): number =>
  Number(state.inFlightRequests ?? 0);

writeLine("");
writeLine(
  "Provider     State     Priority                                Status                                   Active  In-Flight  Attempts  Successes  Failures  Last failure"
);
writeLine(
  "-----------  --------  --------------------------------------  ---------------------------------------  ------  ---------  --------  ---------  --------  ------------"
);
for (const [provider, state] of Object.entries(providers)) {
  const isEnabled =
    state.enabled !== false &&
    state.status !== "disabled" &&
    !disabledProviders.includes(provider);
  const stateLabel = isEnabled ? "enabled" : "disabled";
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
    !isEnabled || state.status === "disabled" ? "disabled" : state.status
  );
  const activeCount = getProviderLiveActivity(state);
  const inFlightCount = getProviderInFlight(state);
  writeLine(
    `${provider.padEnd(11)}  ${stateLabel.padEnd(8)}  ${priority.padEnd(38)}  ${(displayStatus + cooldown).padEnd(39)}  ${String(activeCount).padStart(6)}  ${String(inFlightCount).padStart(9)}  ${String(state.attempts).padStart(8)}  ${String(state.successes).padStart(9)}  ${String(state.failures).padStart(8)}  ${lastFailure}`
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

const subagents = body.subagents ?? {};
writeLine("");
const recentSubagentCount = Array.isArray(subagents.recent)
  ? subagents.recent.length
  : 0;
writeLine(
  `Subagents spawned: ${recentSubagentCount} recent / ${subagents.total ?? 0} total (${counts(subagents.byMechanism)})`
);
writeLine(`  by provider: ${counts(subagents.byProvider)}`);
writeLine(`  by role: ${counts(subagents.byRole)}`);
writeLine(`  by outcome: ${counts(subagents.byStatus)}`);
writeLine(
  `  spawn-capable providers: ${(subagents.spawnCapableProviders ?? []).join(", ") || "-"}; Codex-native OTEL spawns: ${subagents.codexNativeSpawns ?? 0}`
);
for (const spawn of (subagents.recent ?? []).slice(0, 10)) {
  writeLine(
    `  ${spawn.timestamp} ${spawn.mechanism} ${spawn.provider}/${spawn.role} ${spawn.tool ?? "-"}`
  );
}

const spawnFailures = asRecord(body.spawnFailures);
writeLine("");
writeLine(
  `Subagent spawn failures: ${spawnFailures.total ?? 0} (${counts(spawnFailures.byReason)})`
);

const usage = asRecord(body.usage);
writeLine("");
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

writeLine("Usage by origin:");
for (const [origin, entry] of Object.entries(asRecord(usage.byOrigin))) {
  const state = asRecord(entry);
  writeLine(
    `  ${origin}: ${state.active ?? 0} active, ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round(Number(state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`
  );
}
writeLine("Usage by role:");
for (const [role, entry] of Object.entries(asRecord(usage.byRole))) {
  const state = asRecord(entry);
  writeLine(
    `  ${role}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round(Number(state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`
  );
}
const codexTelemetry = asRecord(body.codexTelemetry);
const otelReceiver = asRecord(codexTelemetry.receiver);
const otelTurns = asRecord(codexTelemetry.turns);
const otelTokens = asRecord(codexTelemetry.tokens);
const mcpSummary = asRecord(codexTelemetry.mcpSummary);
writeLine("");
writeLine(
  `Codex OTEL: logs ${otelReceiver.logs ?? 0}, traces ${otelReceiver.traces ?? 0}, metrics ${otelReceiver.metrics ?? 0}, recent sessions ${codexTelemetry.sessionsRecent ?? 0}/${codexTelemetry.sessionsObserved ?? 0}, completed turns ${otelTurns.completed ?? 0}, avg TTFT ${Math.round(Number(otelTurns.averageTtftMs ?? 0))}ms, tokens ${otelTokens.total ?? 0}, MCP ready ${mcpSummary.ready ?? 0}/${mcpSummary.observed ?? 0}`
);
writeLine("MCP runtime observations:");
for (const server of asRecordList(codexTelemetry.mcpServers)) {
  writeLine(
    `  ${server.name}: ${server.health}, last ${server.lastSeenAt ?? "-"}, init ${server.initAttempts ?? 0}, discovery ${server.toolDiscoveryAttempts ?? 0}, failures ${server.failures ?? 0}, avg ${Math.round(Number(server.averageDurationMs ?? 0))}ms`
  );
}

const skills = asRecord(codexTelemetry.skills);
const skillsInjected = asRecord(skills.injected);
const skillsTurnDuration = asRecord(skills.turnDuration);
const skillsThreads = asRecord(skills.threads);
const histogramText = (value: unknown): string => {
  const histogram = asRecord(value);
  return `avg ${Number(histogram.average ?? 0).toFixed(1)} (n=${histogram.count ?? 0}, sum=${histogram.sum ?? 0})`;
};
writeLine("");
writeLine(
  `Skills injected: ${skillsInjected.total ?? 0} (${counts(skillsInjected.byStatus)}), invoke_type: ${counts(skillsInjected.byInvokeType)}, agent kind: ${counts(skillsInjected.byAgentKind)}`
);
writeLine(
  `Skill turn duration: ${histogramText(skillsTurnDuration.durationSeconds)}`
);
writeLine(
  `Thread skills: enabled ${histogramText(skillsThreads.enabledTotal)}, kept ${histogramText(skillsThreads.keptTotal)}, truncated ${histogramText(skillsThreads.truncated)}, description chars ${histogramText(skillsThreads.descriptionTruncatedChars)}`
);
for (const skill of asRecordList(skillsInjected.bySkill)) {
  writeLine(
    `  ${skill.skill}: injected ${skill.total} (${counts(skill.byStatus)}), invoke_type: ${counts(skill.byInvokeType)}, agent kind: ${counts(skill.byAgentKind)}, models: ${counts(skill.byModel)}, plugins: ${counts(skill.byPlugin)}`
  );
}

const nativeMetrics = asRecordList(asRecord(codexTelemetry.metrics).observed);
writeLine("");
writeLine(`Native metric names observed: ${nativeMetrics.length}`);
for (const metric of nativeMetrics)
  writeLine(
    `  ${metric.name}: ${metric.exports ?? 0} export(s), ${metric.dataPoints ?? 0} data point(s)`
  );

const nativeTools = asRecordList(asRecord(codexTelemetry.tools).byTool);
const nativeHooks = asRecordList(asRecord(codexTelemetry.hooks).byHook);
const nativeThreads = asRecord(codexTelemetry.threads);
writeLine(
  `Native runtime telemetry: ${nativeTools.length} tool groups, ${nativeHooks.length} hook groups, ${asRecord(nativeThreads.started).total ?? 0} threads started, ${asRecord(nativeThreads.spawns).total ?? 0} agent spawns`
);
for (const tool of nativeTools)
  writeLine(
    `  [tool] ${tool.tool} (${tool.source}${tool.server ? `/${tool.server}` : ""}): ${tool.count ?? 0} calls (${counts(tool.byStatus)}), avg ${Math.round(Number(tool.averageDurationMs ?? 0))}ms`
  );
for (const hook of nativeHooks)
  writeLine(
    `  hook ${hook.hook} (${hook.source}${hook.handlerType ? `/${hook.handlerType}` : ""}): ${hook.count ?? 0} runs (${counts(hook.byStatus)}), avg ${Math.round(Number(hook.averageDurationMs ?? 0))}ms`
  );

const sqlite = asRecord(codexTelemetry.sqlite);
const sqliteDuration = asRecord(sqlite.initDurationMs);
writeLine(
  `SQLite telemetry: ${asRecord(sqlite.init).total ?? 0} initializations, ${asRecord(sqlite.fallbacks).total ?? 0} fallbacks, ${sqliteDuration.totalCount ?? 0} duration samples, avg ${sqliteDuration.totalCount ? Math.round(Number(sqliteDuration.totalSum) / Number(sqliteDuration.totalCount)) : 0}ms`
);

writeLine("Usage by resolved model:");
for (const [model, entry] of Object.entries(asRecord(usage.byModel))) {
  const state = asRecord(entry);
  writeLine(
    `  ${model}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round(Number(state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`
  );
}

const events = asRecordList(body.recentEvents);
if (events.length > 0) {
  writeLine("");
  writeLine("Recent routing events (newest first):");
  for (const event of events.slice(0, 20)) {
    const target = `${event.provider}/${event.model}`;
    const outcome = event.outcome ?? event.failureClass ?? "-";
    writeLine(
      `${event.timestamp} ${event.requestId} ${String(event.phase).padEnd(8)} ${target.padEnd(36)} ${outcome}`
    );
  }
}
