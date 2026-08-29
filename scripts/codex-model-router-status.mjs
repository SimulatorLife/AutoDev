#!/usr/bin/env node

const host = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
const port = process.env.CODEX_MODEL_ROUTER_PORT ?? "4100";
const endpoint = `http://${host}:${port}/status`;
const response = await fetch(endpoint);
const body = await response.json();
if (!response.ok) {
  console.error(body?.error?.message ?? `Router status request failed with HTTP ${response.status}`);
  process.exit(1);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

console.log(`Router ${body.router} (pid ${body.pid}, instance ${body.routerInstanceId})`);
console.log(`Started: ${body.startedAt}`);
console.log("");
console.log("Provider            Status             Active  Attempts  Successes  Failures  Last failure");
console.log("------------------  -----------------  ------  --------  ---------  --------  ------------");
for (const [provider, state] of Object.entries(body.providers ?? {})) {
  const lastFailure = state.lastFailure
    ? `${state.lastFailure.class}${state.lastFailure.status ? ` (HTTP ${state.lastFailure.status})` : ""}`
    : "-";
  const cooldown = state.cooldownRemainingMs > 0 ? ` (${Math.ceil(state.cooldownRemainingMs / 1000)}s)` : "";
  console.log(`${provider.padEnd(19)} ${(state.status + cooldown).padEnd(18)} ${String(state.activeRequests).padStart(6)}  ${String(state.attempts).padStart(8)}  ${String(state.successes).padStart(9)}  ${String(state.failures).padStart(8)}  ${lastFailure}`);
}

const spawnFailures = body.spawnFailures ?? {};
const spawnReasons = Object.entries(spawnFailures.byReason ?? {}).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "-";
console.log("");
console.log(`Subagent spawn failures: ${spawnFailures.total ?? 0} (${spawnReasons})`);

const tasks = body.codexTasks ?? {};
console.log("");
console.log(`Codex tasks: ${tasks.status ?? "unknown"} · ${Object.entries(tasks.countsByStatus ?? {}).map(([state, count]) => `${state}: ${count}`).join(", ") || "-"}`);
for (const task of (tasks.tasks ?? []).slice(0, 20)) {
  console.log(`  ${task.status} ${task.id} ${task.name ?? ""}`.trim());
}

const usage = body.usage ?? {};
console.log("");
const concurrency = body.concurrency ?? {};
const limit = (value) => value == null ? "unlimited" : value;
const lastDenial = concurrency.lastDenial ? `${concurrency.lastDenial.reason} (${concurrency.lastDenial.sessionScope})` : "-";
const denialsByReason = Object.entries(concurrency.denialsByReason ?? {}).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "-";
const fallbackWarning = concurrency.processFallbackEnforcement
  ? ` [WARNING: ${concurrency.processFallbackActiveThreads} active thread(s) have no caller-supplied session id and are sharing one process-wide bucket instead of independent per-session slots -- over-denial risk]`
  : "";
console.log("");
console.log(`Concurrency: per-session ${limit(concurrency.effectivePerSessionLimit)}, active sessions ${concurrency.activeSessions ?? 0}, active subagents ${concurrency.activeSubagentThreads ?? 0}, denials ${concurrency.denials ?? 0} (${denialsByReason}), last denial ${lastDenial}${fallbackWarning}`);

console.log("Usage by origin:");
for (const [origin, state] of Object.entries(usage.byOrigin ?? {})) {
  console.log(`  ${origin}: ${state.active ?? 0} active, ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
console.log("Usage by role:");
for (const [role, state] of Object.entries(usage.byRole ?? {})) {
  console.log(`  ${role}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
const codexTelemetry = body.codexTelemetry ?? {};
const otelReceiver = codexTelemetry.receiver ?? {};
const otelTurns = codexTelemetry.turns ?? {};
const otelTokens = codexTelemetry.tokens ?? {};
const mcpSummary = codexTelemetry.mcpSummary ?? {};
console.log("");
console.log(`Codex OTEL: logs ${otelReceiver.logs ?? 0}, traces ${otelReceiver.traces ?? 0}, metrics ${otelReceiver.metrics ?? 0}, recent sessions ${codexTelemetry.sessionsRecent ?? 0}/${codexTelemetry.sessionsObserved ?? 0}, completed turns ${otelTurns.completed ?? 0}, avg TTFT ${Math.round(otelTurns.averageTtftMs ?? 0)}ms, tokens ${otelTokens.total ?? 0}, MCP ready ${mcpSummary.ready ?? 0}/${mcpSummary.observed ?? 0}`);
console.log("MCP runtime observations:");
for (const server of (codexTelemetry.mcpServers ?? [])) {
  console.log(`  ${server.name}: ${server.health}, last ${server.lastSeenAt ?? "-"}, init ${server.initAttempts ?? 0}, discovery ${server.toolDiscoveryAttempts ?? 0}, failures ${server.failures ?? 0}, avg ${Math.round(server.averageDurationMs ?? 0)}ms`);
}

const skills = codexTelemetry.skills ?? {};
const skillsInjected = skills.injected ?? {};
const skillsThreads = skills.threads ?? {};
const countsText = (counts) => Object.entries(counts ?? {}).map(([key, value]) => `${key}: ${value}`).join(", ") || "-";
const histogramText = (histogram) => `avg ${Number(histogram?.average ?? 0).toFixed(1)} (n=${histogram?.count ?? 0}, sum=${histogram?.sum ?? 0})`;
console.log("");
console.log(`Skills injected: ${skillsInjected.total ?? 0} (${countsText(skillsInjected.byStatus)}), invoke_type: ${countsText(skillsInjected.byInvokeType)}`);
console.log(`Thread skills: enabled ${histogramText(skillsThreads.enabledTotal)}, kept ${histogramText(skillsThreads.keptTotal)}, truncated ${histogramText(skillsThreads.truncated)}, description chars ${histogramText(skillsThreads.descriptionTruncatedChars)}`);
for (const skill of (skillsInjected.bySkill ?? [])) {
  console.log(`  ${skill.skill}: ${skill.total} (${countsText(skill.byStatus)}), invoke_type: ${countsText(skill.byInvokeType)}`);
}

const nativeMetrics = codexTelemetry.metrics?.observed ?? [];
console.log("");
console.log(`Native metric names observed: ${nativeMetrics.length}`);
for (const metric of nativeMetrics) console.log(`  ${metric.name}: ${metric.exports ?? 0} export(s), ${metric.dataPoints ?? 0} data point(s)`);

const nativeTools = codexTelemetry.tools?.byTool ?? [];
const nativeHooks = codexTelemetry.hooks?.byHook ?? [];
const nativeThreads = codexTelemetry.threads ?? {};
console.log(`Native runtime telemetry: ${nativeTools.length} tool groups, ${nativeHooks.length} hook groups, ${nativeThreads.started?.total ?? 0} threads started, ${nativeThreads.spawns?.total ?? 0} agent spawns`);
for (const tool of nativeTools) console.log(`  [tool] ${tool.tool} (${tool.source}${tool.server ? `/${tool.server}` : ""}): ${tool.count ?? 0} calls (${countsText(tool.byStatus)}), avg ${Math.round(tool.averageDurationMs ?? 0)}ms`);
for (const hook of nativeHooks) console.log(`  hook ${hook.hook} (${hook.source}${hook.handlerType ? `/${hook.handlerType}` : ""}): ${hook.count ?? 0} runs (${countsText(hook.byStatus)}), avg ${Math.round(hook.averageDurationMs ?? 0)}ms`);

const sqlite = codexTelemetry.sqlite ?? {};
const sqliteDuration = sqlite.initDurationMs ?? {};
console.log(`SQLite telemetry: ${sqlite.init?.total ?? 0} initializations, ${sqlite.fallbacks?.total ?? 0} fallbacks, ${sqliteDuration.totalCount ?? 0} duration samples, avg ${sqliteDuration.totalCount ? Math.round(sqliteDuration.totalSum / sqliteDuration.totalCount) : 0}ms`);

console.log("Usage by resolved model:");
for (const [model, state] of Object.entries(usage.byModel ?? {})) {
  console.log(`  ${model}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}

const events = body.recentEvents ?? [];
if (events.length) {
  console.log("");
  console.log("Recent routing events (newest first):");
  for (const event of events.slice(0, 20)) {
    const target = `${event.provider}/${event.model}`;
    const outcome = event.outcome ?? event.failureClass ?? "-";
    console.log(`${event.timestamp} ${event.requestId} ${event.phase.padEnd(8)} ${target.padEnd(36)} ${outcome}`);
  }
}
