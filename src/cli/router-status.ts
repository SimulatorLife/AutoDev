#!/usr/bin/env node

import { parseRouterStatus, serializeRouterStatus } from "../router/status.ts";

type JsonRecord = Record<string, any>;

const asRecord = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

const counts = (record: JsonRecord | null | undefined): string => Object.entries(record ?? {}).map(([ key, value ]) => `${key}: ${value}`).join(", ") || "-";
const host = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const port = process.env.CODEX_MODEL_ROUTER_PORT ?? "4100";
const endpoint = `http://${host}:${port}/status`;
const response = await fetch(endpoint);
const body = parseRouterStatus(await response.json()) as JsonRecord;
if (!response.ok) {
  console.error(body?.error?.message ?? `Router status request failed with HTTP ${response.status}`);
  process.exit(1);
}

if (process.argv.includes("--json")) {
  console.log(serializeRouterStatus(body));
  process.exit(0);
}

console.log(`Router ${body.router} (pid ${body.pid}, instance ${body.routerInstanceId})`);
console.log(`Started: ${body.startedAt}`);

const routing = asRecord(body.routing);
const providers = asRecord(body.providers);
const enabledProviders = routing.enabledProviders ?? Object.keys(providers).filter((p) => providers[p]?.enabled !== false && providers[p]?.status !== "disabled");
const disabledProviders = routing.disabledProviders ?? Object.keys(providers).filter((p) => providers[p]?.enabled === false || providers[p]?.status === "disabled");

console.log("");
console.log(`Providers: ${enabledProviders.length} enabled (${enabledProviders.join(", ") || "-"}), ${disabledProviders.length} disabled (${disabledProviders.join(", ") || "none"})`);

if (routing.providerGroups && typeof routing.providerGroups === "object") {
  console.log("Configured priority groups:");
  for (const [tier, groups] of Object.entries(asRecord(routing.providerGroups)) as Array<[string, any]>) {
    const groupDesc = (Array.isArray(groups) ? groups : []).map((g: any, idx: number) => `P${idx + 1}: [${(Array.isArray(g) ? g : [g]).join(", ")}]`).join(" -> ");
    console.log(`  ${tier}: ${groupDesc}`);
  }
}

if (body.limits && typeof body.limits === "object") {
  const lim = body.limits;
  const msToSec = (ms: unknown): string => `${Math.round(Number(ms ?? 0) / 1000)}s`;
  console.log("Effective limits & cooldowns:");
  console.log(`  transient cooldown: ${msToSec(lim.providerCooldownMs)}-${msToSec(lim.providerCooldownMaxMs)}, hard cooldown: ${msToSec(lim.hardCooldownMs)}-${msToSec(lim.hardCooldownMaxMs)}`);
  console.log(`  probe cooldown: ${msToSec(lim.probeCooldownMs)}-${msToSec(lim.probeCooldownMaxMs)} (timeout ${lim.probeTimeoutMs ?? 700}ms), exhaustion wait: ${lim.exhaustionWaitMs ?? 0}ms`);
  console.log(`  last resort max attempts: ${lim.lastResortMaxAttempts ?? 2}, chain selection deadline: ${msToSec(lim.chainSelectionDeadlineMs)}, per-session concurrency: ${lim.maxConcurrentThreadsPerSession ?? "unlimited"}`);
}

const formatProviderPriority = (providerName: string, state: JsonRecord): string => {
  if (state?.routingPriority && state.routingPriority !== "—" && state.routingPriority !== "-") {
    return state.routingPriority;
  }
  const statusPriorities = asRecord(routing.priorities)?.[providerName];
  if (statusPriorities && typeof statusPriorities === "object") {
    const parts = (Object.entries(statusPriorities) as Array<[string, any]>).map(([tier, prio]) => `${tier}: ${prio}`);
    if (parts.length) return parts.join(" · ");
  }
  const providerGroups = asRecord(routing.providerGroups);
  if (providerGroups && typeof providerGroups === "object") {
    const tierPrios: string[] = [];
    for (const [tier, groups] of Object.entries(providerGroups) as Array<[string, any]>) {
      if (Array.isArray(groups)) {
        for (let gIdx = 0; gIdx < groups.length; gIdx++) {
          const group = groups[gIdx];
          if (Array.isArray(group) && group.some((name) => typeof name === "string" && name.toLowerCase() === providerName.toLowerCase())) {
            tierPrios.push(`${tier}: P${gIdx + 1}`);
            break;
          }
        }
      }
    }
    if (tierPrios.length) return tierPrios.join(" · ");
  }
  return "-";
};

const getProviderLiveActivity = (state: JsonRecord): number => Number(state?.active ?? 0);

const getProviderInFlight = (state: JsonRecord): number => Number(state?.inFlightRequests ?? 0);


console.log("");
console.log("Provider     State     Priority                                Status                                   Active  In-Flight  Attempts  Successes  Failures  Last failure");
console.log("-----------  --------  --------------------------------------  ---------------------------------------  ------  ---------  --------  ---------  --------  ------------");
for (const [provider, state] of Object.entries(providers) as Array<[string, JsonRecord]>) {
  const isEnabled = state.enabled !== false && state.status !== "disabled" && !disabledProviders.includes(provider);
  const stateLabel = isEnabled ? "enabled" : "disabled";
  const priority = formatProviderPriority(provider, state);
  const lastFailure = state.lastFailure
    ? `${state.lastFailure.class}${state.lastFailure.status ? ` (HTTP ${state.lastFailure.status})` : ""}`
    : "-";

  const pLimits = asRecord(state.limits);
  const cooldownRemainingMs = Number(pLimits.cooldownRemainingMs ?? state.cooldownRemainingMs ?? 0);
  const cooldownResetsAt = pLimits.cooldownResetsAt ?? state.cooldownResetsAt ?? null;
  const cooldownKind = pLimits.cooldownKind ?? state.cooldownKind ?? null;
  const cooldownFailureClass = pLimits.cooldownFailureClass ?? state.cooldownFailureClass ?? null;
  const cooldownUntil = pLimits.cooldownUntil ?? state.cooldownUntil ?? null;
  const lastResortEligible = pLimits.lastResortEligible ?? state.lastResortEligible ?? true;

  const cooldown = cooldownRemainingMs > 0 || cooldownResetsAt
    ? cooldownResetsAt
      ? ` (${cooldownKind ?? "cooldown"}, resets ${cooldownResetsAt})`
      : ` (${cooldownKind ?? "cooldown"} ${Math.ceil(cooldownRemainingMs / 1000)}s)`
    : "";
  const displayStatus = String((!isEnabled || state.status === "disabled") ? "disabled" : state.status);
  const activeCount = getProviderLiveActivity(state);
  const inFlightCount = getProviderInFlight(state);
  console.log(`${provider.padEnd(11)}  ${stateLabel.padEnd(8)}  ${priority.padEnd(38)}  ${(displayStatus + cooldown).padEnd(39)}  ${String(activeCount).padStart(6)}  ${String(inFlightCount).padStart(9)}  ${String(state.attempts).padStart(8)}  ${String(state.successes).padStart(9)}  ${String(state.failures).padStart(8)}  ${lastFailure}`);

  const details: string[] = [];
  if (cooldownRemainingMs > 0 || cooldownResetsAt || cooldownKind) {
    const kind = cooldownKind ?? "transient";
    const fClass = cooldownFailureClass ? `/${cooldownFailureClass}` : "";
    details.push(`cooldown: ${kind}${fClass}`);
    if (cooldownRemainingMs > 0) details.push(`remaining: ${Math.ceil(cooldownRemainingMs / 1000)}s`);
    if (cooldownUntil) details.push(`until: ${cooldownUntil}`);
    if (cooldownResetsAt) details.push(`resets: ${cooldownResetsAt}`);
    details.push(`last resort: ${lastResortEligible ? "eligible" : "ineligible"}`);
  }
  if ((state.failureStreak ?? 0) > 0) details.push(`failure streak: ${state.failureStreak}`);
  if ((state.probeFailureStreak ?? 0) > 0) details.push(`probe streak: ${state.probeFailureStreak}`);

  const rawLimits = state.effectiveLimits ?? state.effectiveLimit ?? state.liveLimits ?? state.liveLimit ?? state.rateLimit;
  if (rawLimits != null) {
    const limStr = typeof rawLimits === "object" && !Array.isArray(rawLimits)
      ? Object.entries(rawLimits).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`).join(", ")
      : String(rawLimits);
    if (limStr) details.push(`live limits: [${limStr}]`);
  } else if (state.limits && typeof state.limits === "object") {
    const knownKeys = new Set(["cooldownKind", "cooldownFailureClass", "cooldownResetsAt", "cooldownUntil", "cooldownRemainingMs", "lastResortEligible"]);
    const customEntries = Object.entries(state.limits).filter(([k, v]) => !knownKeys.has(k) && v != null && v !== "");
    if (customEntries.length) {
      details.push(`live limits: [${customEntries.map(([k, v]) => `${k}: ${v}`).join(", ")}]`);
    }
  }
  if (details.length) {
    console.log(`  ↳ ${details.join(" · ")}`);
  }
}

const subagents = asRecord(body.subagents);
console.log("");
const recentSubagentCount = Array.isArray(subagents.recent) ? subagents.recent.length : 0;
console.log(`Subagents spawned: ${recentSubagentCount} recent / ${subagents.total ?? 0} total (${counts(subagents.byMechanism)})`);
console.log(`  by provider: ${counts(subagents.byProvider)}`);
console.log(`  by role: ${counts(subagents.byRole)}`);
console.log(`  by outcome: ${counts(subagents.byStatus)}`);
console.log(`  spawn-capable providers: ${(subagents.spawnCapableProviders ?? []).join(", ") || "-"}; Codex-native OTEL spawns: ${subagents.codexNativeSpawns ?? 0}`);
for (const spawn of (subagents.recent ?? []).slice(0, 10)) {
  console.log(`  ${spawn.timestamp} ${spawn.mechanism} ${spawn.provider}/${spawn.role} ${spawn.tool ?? "-"}`);
}

const spawnFailures = asRecord(body.spawnFailures);
console.log("");
console.log(`Subagent spawn failures: ${spawnFailures.total ?? 0} (${counts(spawnFailures.byReason)})`);

const usage = asRecord(body.usage);
console.log("");
const concurrency = asRecord(body.concurrency);
const limit = (value: unknown): string | number => value == null ? "unlimited" : typeof value === "number" ? value : String(value);
const lastDenial = concurrency.lastDenial ? `${concurrency.lastDenial.reason} (${concurrency.lastDenial.sessionScope})` : "-";
const denialsByReason = counts(concurrency.denialsByReason);
const fallbackWarning = concurrency.processFallbackEnforcement
  ? ` [WARNING: ${concurrency.processFallbackActiveThreads} active thread(s) have no caller-supplied session id and are sharing one process-wide bucket instead of independent per-session slots -- over-denial risk]`
  : "";
const totalInFlight = Object.values(asRecord(body.inFlightRequests)).reduce((sum: number, v: any) => sum + Number(v ?? 0), 0);
console.log("");
console.log(`Concurrency: per-session ${limit(concurrency.effectivePerSessionLimit)}, active sessions ${concurrency.activeSessions ?? 0}, active subagents ${concurrency.activeSubagentThreads ?? 0}, in-flight requests ${totalInFlight}, denials ${concurrency.denials ?? 0} (${denialsByReason}), last denial ${lastDenial}${fallbackWarning}`);

console.log("Usage by origin:");
for (const [origin, state] of Object.entries(asRecord(usage.byOrigin)) as Array<[string, JsonRecord]>) {
  console.log(`  ${origin}: ${state.active ?? 0} active, ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
console.log("Usage by role:");
for (const [role, state] of Object.entries(asRecord(usage.byRole)) as Array<[string, JsonRecord]>) {
  console.log(`  ${role}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
const codexTelemetry = asRecord(body.codexTelemetry);
const otelReceiver = asRecord(codexTelemetry.receiver);
const otelTurns = asRecord(codexTelemetry.turns);
const otelTokens = asRecord(codexTelemetry.tokens);
const mcpSummary = asRecord(codexTelemetry.mcpSummary);
console.log("");
console.log(`Codex OTEL: logs ${otelReceiver.logs ?? 0}, traces ${otelReceiver.traces ?? 0}, metrics ${otelReceiver.metrics ?? 0}, recent sessions ${codexTelemetry.sessionsRecent ?? 0}/${codexTelemetry.sessionsObserved ?? 0}, completed turns ${otelTurns.completed ?? 0}, avg TTFT ${Math.round(otelTurns.averageTtftMs ?? 0)}ms, tokens ${otelTokens.total ?? 0}, MCP ready ${mcpSummary.ready ?? 0}/${mcpSummary.observed ?? 0}`);
console.log("MCP runtime observations:");
for (const server of (Array.isArray(codexTelemetry.mcpServers) ? codexTelemetry.mcpServers : []) as JsonRecord[]) {
  console.log(`  ${server.name}: ${server.health}, last ${server.lastSeenAt ?? "-"}, init ${server.initAttempts ?? 0}, discovery ${server.toolDiscoveryAttempts ?? 0}, failures ${server.failures ?? 0}, avg ${Math.round(server.averageDurationMs ?? 0)}ms`);
}

const skills = asRecord(codexTelemetry.skills);
const skillsInjected = asRecord(skills.injected);
const skillsTurnDuration = asRecord(skills.turnDuration);
const skillsThreads = asRecord(skills.threads);
const histogramText = (histogram: JsonRecord): string => `avg ${Number(histogram?.average ?? 0).toFixed(1)} (n=${histogram?.count ?? 0}, sum=${histogram?.sum ?? 0})`;
console.log("");
console.log(`Skills injected: ${skillsInjected.total ?? 0} (${counts(skillsInjected.byStatus)}), invoke_type: ${counts(skillsInjected.byInvokeType)}, agent kind: ${counts(skillsInjected.byAgentKind)}`);
console.log(`Skill turn duration: ${histogramText(skillsTurnDuration.durationSeconds)}`);
console.log(`Thread skills: enabled ${histogramText(skillsThreads.enabledTotal)}, kept ${histogramText(skillsThreads.keptTotal)}, truncated ${histogramText(skillsThreads.truncated)}, description chars ${histogramText(skillsThreads.descriptionTruncatedChars)}`);
for (const skill of (Array.isArray(skillsInjected.bySkill) ? skillsInjected.bySkill : []) as JsonRecord[]) {
  console.log(`  ${skill.skill}: injected ${skill.total} (${counts(skill.byStatus)}), invoke_type: ${counts(skill.byInvokeType)}, agent kind: ${counts(skill.byAgentKind)}, models: ${counts(skill.byModel)}, plugins: ${counts(skill.byPlugin)}`);
}

const nativeMetrics = (Array.isArray(asRecord(codexTelemetry.metrics).observed) ? asRecord(codexTelemetry.metrics).observed : []) as JsonRecord[];
console.log("");
console.log(`Native metric names observed: ${nativeMetrics.length}`);
for (const metric of nativeMetrics) console.log(`  ${metric.name}: ${metric.exports ?? 0} export(s), ${metric.dataPoints ?? 0} data point(s)`);

const nativeTools = (Array.isArray(asRecord(codexTelemetry.tools).byTool) ? asRecord(codexTelemetry.tools).byTool : []) as JsonRecord[];
const nativeHooks = (Array.isArray(asRecord(codexTelemetry.hooks).byHook) ? asRecord(codexTelemetry.hooks).byHook : []) as JsonRecord[];
const nativeThreads = asRecord(codexTelemetry.threads);
console.log(`Native runtime telemetry: ${nativeTools.length} tool groups, ${nativeHooks.length} hook groups, ${nativeThreads.started?.total ?? 0} threads started, ${nativeThreads.spawns?.total ?? 0} agent spawns`);
for (const tool of nativeTools) console.log(`  [tool] ${tool.tool} (${tool.source}${tool.server ? `/${tool.server}` : ""}): ${tool.count ?? 0} calls (${counts(tool.byStatus)}), avg ${Math.round(tool.averageDurationMs ?? 0)}ms`);
for (const hook of nativeHooks) console.log(`  hook ${hook.hook} (${hook.source}${hook.handlerType ? `/${hook.handlerType}` : ""}): ${hook.count ?? 0} runs (${counts(hook.byStatus)}), avg ${Math.round(hook.averageDurationMs ?? 0)}ms`);

const sqlite = asRecord(codexTelemetry.sqlite);
const sqliteDuration = asRecord(sqlite.initDurationMs);
console.log(`SQLite telemetry: ${sqlite.init?.total ?? 0} initializations, ${sqlite.fallbacks?.total ?? 0} fallbacks, ${sqliteDuration.totalCount ?? 0} duration samples, avg ${sqliteDuration.totalCount ? Math.round(sqliteDuration.totalSum / sqliteDuration.totalCount) : 0}ms`);

console.log("Usage by resolved model:");
for (const [model, state] of Object.entries(asRecord(usage.byModel)) as Array<[string, JsonRecord]>) {
  console.log(`  ${model}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}

const events = (Array.isArray(body.recentEvents) ? body.recentEvents : []) as JsonRecord[];
if (events.length) {
  console.log("");
  console.log("Recent routing events (newest first):");
  for (const event of events.slice(0, 20)) {
    const target = `${event.provider}/${event.model}`;
    const outcome = event.outcome ?? event.failureClass ?? "-";
    console.log(`${event.timestamp} ${event.requestId} ${event.phase.padEnd(8)} ${target.padEnd(36)} ${outcome}`);
  }
}
