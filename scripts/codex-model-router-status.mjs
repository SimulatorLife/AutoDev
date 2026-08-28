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
console.log("");
console.log(`Concurrency: per-session ${limit(concurrency.effectivePerSessionLimit)}, active subagents ${concurrency.activeSubagentThreads ?? 0}, denials ${concurrency.denials ?? 0} (${denialsByReason}), last denial ${lastDenial}`);

console.log("Usage by origin:");
for (const [origin, state] of Object.entries(usage.byOrigin ?? {})) {
  console.log(`  ${origin}: ${state.active ?? 0} active, ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
console.log("Usage by role:");
for (const [role, state] of Object.entries(usage.byRole ?? {})) {
  console.log(`  ${role}: ${state.attempts} attempts, ${state.successes} successes, ${state.failures} failures, avg ${Math.round((state.averageDurationMs ?? 0) / 1000)}s, ${state.toolCalls} tool calls`);
}
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
