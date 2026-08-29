import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { activeProviderRequests, catalogModelIds, classifyProviderFailure, clearProviderCooldown, cooldownProvider, decrementActiveRequests, fallbackable, getActiveRequests, concurrencyStatus, countToolCallsFromSse, countToolCallsInResponse, getRouterStatus, handle, codexTelemetryStatus, ingestOtelSignal, incrementActiveRequests, isProviderCoolingDown, loadRouterState, normalizeCodexTask, parseConcurrencyConfig, persistRouterStateNow, PROCESS_FALLBACK_SESSION_KEY, recordConcurrencyDenial, recordRouterEvent, recordSpawnFailure, releaseSubagentSlot, replaceModelFields, requestSession, resetConcurrencyTelemetry, resetRouterTelemetry, resetOtelTelemetry, serializeRouterState, spawnFailureStatus, summarizeCodexTasks, responseTextFromSse, roleCandidates, roleForModel, routeCredentialAvailable, routeForModel, transformSseEvent, tryAcquireSubagentSlot, validateRoutingConfig } from "./codex-model-router.mjs";

test("loads editable provider and role models from JSON routing config", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  assert.equal(config.providers.claude.models.smart, "claude-opus-4-8");
  assert.equal(config.providers.codex.models.smart, "gpt-5.6-sol");
  assert.equal(config.providers.minimax.models.smart, undefined);
  assert.equal(config.providers.copilot.models.smart, undefined);
  assert.deepEqual(config.providerGroups.default, [["claude", "antigravity", "minimax"], ["copilot"], ["codex"]]);
  assert.deepEqual(config.providerGroups.smart, [["claude", "antigravity"], ["codex"]]);
  assert.equal(config.roles.worker.tier, "default");
  assert.equal(config.roles.smart.tier, "smart");
});

test("validates routing config and requires default model for providers", () => {
  const validConfig = {
    providerGroups: {
      default: [["testProvider"], ["fallbackProvider"]],
      smart: [["testProvider"], ["fallbackProvider"]],
    },
    providers: {
      testProvider: { models: { default: "test-model" } },
      fallbackProvider: { models: { default: "fallback-model" } },
    },
    roles: {
      default: { tier: "default" },
      "docs-researcher": { tier: "default" },
      "browser-tester": { tier: "default" },
      explorer: { tier: "default" },
      worker: { tier: "default" },
      validator: { tier: "default" },
      smart: { tier: "smart" },
    },
  };
  assert.doesNotThrow(() => validateRoutingConfig(validConfig));

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providers: { testProvider: { models: {} } } }),
    /Routing config provider testProvider must define a default model/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providerGroups: { default: [[]], smart: [["testProvider"]] } }),
    /Routing config tier default contains an invalid provider group/
  );
});

test("routes supported model families without provider aliases", () => {
  assert.equal(routeForModel("gpt-5.6-luna")?.provider, "codex");
  assert.equal(routeForModel("sonnet")?.provider, "claude");
  assert.equal(routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(routeForModel("gemini-3.6-flash-medium")?.provider, "antigravity");
  assert.equal(routeForModel("unknown-model"), null);
});

test("resolves role aliases through tier-specific randomized provider groups with smart model fallback", () => {
  assert.equal(roleForModel("autodev/explorer"), "explorer");

  const explorerCandidates = roleCandidates("explorer", () => 0.5);
  const explorerProviders = explorerCandidates.map((c) => c.provider);
  assert.deepEqual(explorerProviders.slice(0, 3).sort(), ["antigravity", "claude", "minimax"]);
  assert.deepEqual(explorerProviders.slice(3), ["copilot", "codex"]);

  const smartCandidates = roleCandidates("smart", () => 0.5);
  const smartProviders = smartCandidates.map((c) => c.provider);
  assert.deepEqual(smartProviders.slice(0, 2).sort(), ["antigravity", "claude"]);
  assert.deepEqual(smartProviders.slice(2), ["codex"]);

  const smartModelMap = Object.fromEntries(smartCandidates.map((c) => [c.provider, c.model]));
  assert.equal(smartModelMap.antigravity, "gemini-3.6-flash-high");
  assert.equal(smartModelMap.claude, "claude-opus-4-8");
  assert.equal(smartModelMap.codex, "gpt-5.6-sol");

  assert.notDeepEqual(
    roleCandidates("smart", () => 0).slice(0, 2).map((candidate) => candidate.provider),
    roleCandidates("smart", () => 0.999).slice(0, 2).map((candidate) => candidate.provider),
  );
});

test("classifies provider exhaustion and transient responses for fallback", () => {
  assert.equal(fallbackable(429, "session limit reached"), true);
  assert.equal(fallbackable(503, "unavailable"), true);
  assert.equal(fallbackable(400, "Invalid model name passed in model=gemini-3.6-flash-high"), true);
  assert.equal(fallbackable(400, "malformed request"), false);
});

test("temporarily omits providers after a fallbackable limit or outage", () => {
  const now = 1000;
  cooldownProvider("minimax", now);
  assert.equal(isProviderCoolingDown("minimax", now + 1), true);
  assert.equal(isProviderCoolingDown("minimax", now + 30_000), false);
  clearProviderCooldown("minimax");
  assert.equal(isProviderCoolingDown("minimax", now), false);
});

test("requires configured credentials before treating keyed providers as available", () => {
  assert.equal(routeCredentialAvailable(routeForModel("MiniMax-M3"), {}), false);
  assert.equal(routeCredentialAvailable(routeForModel("MiniMax-M3"), { MINIMAX_API_KEY: "  " }), false);
  assert.equal(routeCredentialAvailable(routeForModel("MiniMax-M3"), { MINIMAX_API_KEY: "key-present" }), true);
  assert.equal(routeCredentialAvailable(routeForModel("gpt-5.6-luna"), {}), true);
});

test("classifies provider failures into operator-visible limit states", () => {
  assert.equal(classifyProviderFailure(429, "too many requests"), "throttled");
  assert.equal(classifyProviderFailure(429, "session limit reached"), "session_limit");
  assert.equal(classifyProviderFailure(429, "quota exhausted"), "quota_exhausted");
  assert.equal(classifyProviderFailure(502, "You've hit your weekly limit"), "throttled");
  assert.equal(classifyProviderFailure(503, "high demand"), "capacity");
  assert.equal(classifyProviderFailure(400, "quota exhausted"), "quota_exhausted");
  assert.equal(classifyProviderFailure(401, "unauthorized"), "authentication");
  assert.equal(classifyProviderFailure(400, "malformed request"), "request_error");
});

test("successful responses identify the resolved provider, model, and request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response(JSON.stringify({ id: "upstream-response", model: "sonnet", output_text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-header" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-header");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("rejects missing or malformed models before provider routing", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    for (const body of [null, {}, { model: "" }, { model: "  " }, { model: 42 }]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.type, "invalid_request_error");
      assert.match(payload.error.message, /JSON object|non-empty string model/);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ingests Codex OTEL turn and MCP lifecycle telemetry without prompt content", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attributes = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
  ingestOtelSignal("logs", {
    resourceLogs: [{
      resource: { attributes: attributes([["mcp_servers", "playwright, codex_apps, node_repl"]]) },
      scopeLogs: [{ logRecords: [
        { attributes: attributes([["event.name", "codex.conversation_starts"], ["conversation.id", "conversation-otel"], ["model", "gpt-5.6-luna"]]) },
        { attributes: attributes([["event.name", "codex.user_prompt"], ["conversation.id", "conversation-otel"], ["prompt_length", 42], ["prompt_text", "do-not-store-this"]]) },
        { attributes: attributes([["event.name", "codex.turn_ttft"], ["conversation.id", "conversation-otel"], ["duration_ms", 321]]) },
        { attributes: attributes([["event.name", "codex.sse_event"], ["event.kind", "response.completed"], ["conversation.id", "conversation-otel"], ["input_token_count", 100], ["output_token_count", 25], ["cached_token_count", 5], ["reasoning_token_count", 10], ["tool_token_count", 3]]) },
      ] }],
    }],
  });
  const span = (name, serverName, durationNs = 5_000_000n) => ({
    name,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + durationNs),
    attributes: attributes([["server_name", serverName]]),
    status: { code: 1 },
  });
  ingestOtelSignal("traces", {
    resourceSpans: [{ scopeSpans: [{ spans: [
      span("make_rmcp_client", "playwright"),
      span("list_tools_for_client_uncached", "playwright", 7_000_000n),
      span("make_rmcp_client", "node_repl", 2_000_000n),
    ] }] }],
  });
  ingestOtelSignal("metrics", { resourceMetrics: [] });

  const telemetry = codexTelemetryStatus(Date.now());
  assert.deepEqual(telemetry.receiver, { logs: 1, traces: 1, metrics: 1, invalid: 0, lastReceivedAt: telemetry.receiver.lastReceivedAt });
  assert.equal(telemetry.sessionsObserved, 1);
  assert.equal(telemetry.turns.prompts, 1);
  assert.equal(telemetry.turns.completed, 1);
  assert.equal(telemetry.turns.averageTtftMs, 321);
  assert.deepEqual(telemetry.tokens, { input: 100, output: 25, cached: 5, reasoning: 10, tool: 3, total: 143 });
  assert.deepEqual(telemetry.mcpSummary, { observed: 3, ready: 1, error: 0, stale: 1 });
  const playwright = telemetry.mcpServers.find((server) => server.name === "playwright");
  assert.equal(playwright.health, "ready");
  assert.equal(playwright.initAttempts, 1);
  assert.equal(playwright.toolDiscoveryAttempts, 1);
  assert.equal(playwright.averageDurationMs, 6);
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  assert.equal(codexTelemetryStatus(Date.now() + 121_000).mcpServers.find((server) => server.name === "playwright").health, "stale");
  resetOtelTelemetry();
});

test("ingests Codex OTEL skill metrics with cumulative dedupe and tolerates invoke_type", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attributes = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
  const skillSum = (skill, status, value, timeOffsetNs, extraAttributes = []) => ({
    name: "codex.skill.injected",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{
        attributes: attributes([["skill", skill], ["status", status], ...extraAttributes]),
        startTimeUnixNano: String(start),
        timeUnixNano: String(start + timeOffsetNs),
        asInt: String(value),
      }],
    },
  });
  const threadHistogram = (name, count, sum, timeOffsetNs, extraAttributes = []) => ({
    name,
    histogram: {
      aggregationTemporality: 2,
      dataPoints: [{
        attributes: attributes(extraAttributes),
        startTimeUnixNano: String(start),
        timeUnixNano: String(start + timeOffsetNs),
        count: String(count),
        sum,
      }],
    },
  });
  const resourceMetrics = (metrics) => ({ resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [{ metrics }] }] });

  // First export: injected=3, skipped(invoke_type=auto)=1, one thread reporting 3 enabled/2 kept, 1 truncated with 120 chars trimmed.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
    skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [["invoke_type", "auto"]]),
    threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
    threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
    threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
    threadHistogram("codex.thread.skills.description_truncated_chars", 1, 120, 1_000_000n),
  ]));
  // Exporter retry resending the identical cumulative point must not double count.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
    skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [["invoke_type", "auto"]]),
    threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
    threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
    threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
    threadHistogram("codex.thread.skills.description_truncated_chars", 1, 120, 1_000_000n),
  ]));
  // Later export with cumulative growth: only the deltas should be applied.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 5, 2_000_000n),
    skillSum("lsp-mcp-server", "skipped", 2, 2_000_000n, [["invoke_type", "auto"]]),
    threadHistogram("codex.thread.skills.enabled_total", 2, 7, 2_000_000n),
    threadHistogram("codex.thread.skills.kept_total", 2, 4, 2_000_000n),
    threadHistogram("codex.thread.skills.truncated", 2, 2, 2_000_000n),
    threadHistogram("codex.thread.skills.description_truncated_chars", 2, 190, 2_000_000n),
  ]));

  const telemetry = codexTelemetryStatus(Date.now());
  assert.equal(telemetry.receiver.metrics, 3);
  assert.equal(telemetry.skills.injected.total, 7);
  assert.deepEqual(telemetry.skills.injected.byStatus, { injected: 5, skipped: 2 });
  assert.deepEqual(telemetry.skills.injected.byInvokeType, { auto: 2 });
  const skill = telemetry.skills.injected.bySkill.find((entry) => entry.skill === "lsp-mcp-server");
  assert.equal(skill.total, 7);
  assert.deepEqual(skill.byStatus, { injected: 5, skipped: 2 });

  assert.deepEqual(telemetry.skills.threads.enabledTotal, { count: 2, sum: 7, average: 3.5 });
  assert.deepEqual(telemetry.skills.threads.keptTotal, { count: 2, sum: 4, average: 2 });
  assert.equal(telemetry.skills.threads.truncated.count, 2);
  assert.equal(telemetry.skills.threads.truncated.sum, 2);
  assert.deepEqual(telemetry.skills.threads.descriptionTruncatedChars, { count: 2, sum: 190, average: 95 });
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  resetOtelTelemetry();
});

test("counts delta-temporality skill metrics once per export", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
  const metric = (name, value, timeUnixNano, kind = "sum") => ({
    name,
    [kind]: {
      aggregationTemporality: 1,
      ...(kind === "sum" ? { isMonotonic: true } : {}),
      dataPoints: [{ attributes: attributes([["skill", "orchestration"], ["status", "ok"]]), timeUnixNano: String(timeUnixNano), ...(kind === "sum" ? { asInt: String(value) } : { count: "1", sum: value }) }],
    },
  });
  const ingest = (metrics) => ingestOtelSignal("metrics", { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] });
  ingest([metric("codex.skill.injected", 2, 10), metric("codex.thread.skills.enabled_total", 1, 10, "histogram")]);
  ingest([metric("codex.skill.injected", 3, 20), metric("codex.thread.skills.enabled_total", 1, 20, "histogram")]);
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.skills.injected.total, 5);
  assert.equal(telemetry.skills.threads.enabledTotal.count, 2);
  assert.equal(telemetry.skills.threads.enabledTotal.sum, 2);
  resetOtelTelemetry();
});

test("inventories native metrics and aggregates safe SQLite and tool telemetry", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
  const dataPoint = (entries, value, time = "100") => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: time, asInt: String(value) });
  const histogramPoint = (entries, count, sum, time = "100") => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: time, count: String(count), sum });
  ingestOtelSignal("metrics", { resourceMetrics: [{ scopeMetrics: [{ metrics: [
    { name: "codex.sqlite.init.count", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["db", "logs"], ["status", "success"]], 2)] } },
    { name: "codex.sqlite.init.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [histogramPoint([["db", "logs"], ["status", "success"]], 2, 40)] } },
    { name: "codex.sqlite.fallback.count", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["db", "memories"], ["status", "locked"]], 1)] } },
    { name: "codex.tool.call", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["tool_name", "exec"], ["source", "builtin"], ["status", "ok"], ["arguments", "/private/path"]], 3)] } },
    { name: "codex.tool.call.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [histogramPoint([["tool_name", "exec"], ["source", "builtin"]], 3, 90)] } },
    { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["hook_name", "SessionStart"], ["hook_source", "user"], ["handler_type", "command"], ["status", "ok"]], 2)] } },
    { name: "codex.hooks.run.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [histogramPoint([["hook_name", "SessionStart"], ["hook_source", "user"], ["handler_type", "command"]], 2, 20)] } },
    { name: "codex.thread.started", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["source", "subagent"]], 4)] } },
    { name: "codex.multi_agent.spawn", sum: { aggregationTemporality: 1, dataPoints: [dataPoint([["agent_role", "worker"], ["requested_model", "autodev/worker"], ["status", "ok"]], 1)] } },
  ] }] }] });

  const telemetry = codexTelemetryStatus();
  assert.deepEqual(telemetry.sqlite.init.byDbStatus, [{ db: "logs", status: "success", count: 2 }]);
  assert.equal(telemetry.sqlite.init.total, 2);
  assert.deepEqual(telemetry.sqlite.initDurationMs.byDbStatus, [{ db: "logs", status: "success", count: 2, sum: 40, average: 20 }]);
  assert.equal(telemetry.sqlite.fallbacks.total, 1);
  const tool = telemetry.tools.byTool.find((entry) => entry.tool === "exec");
  assert.deepEqual(tool, { tool: "exec", source: "builtin", server: "", count: 3, byStatus: { ok: 3 }, durationCount: 3, durationMs: 90, averageDurationMs: 30 });
  assert.deepEqual(telemetry.hooks.byHook, [{ hook: "SessionStart", source: "user", handlerType: "command", count: 2, byStatus: { ok: 2 }, durationCount: 2, durationMs: 20, averageDurationMs: 10 }]);
  assert.deepEqual(telemetry.threads, { started: { total: 4, bySource: { subagent: 4 } }, spawns: { total: 1, byStatus: { ok: 1 }, byRole: { worker: 1 }, byModel: { "autodev/worker": 1 } } });
  assert.equal(JSON.stringify(telemetry).includes("/private/path"), false);
  assert.deepEqual(telemetry.metrics.observed.map(({ name, exports, dataPoints }) => ({ name, exports, dataPoints })), [
    { name: "codex.hooks.run", exports: 1, dataPoints: 1 },
    { name: "codex.hooks.run.duration_ms", exports: 1, dataPoints: 1 },
    { name: "codex.multi_agent.spawn", exports: 1, dataPoints: 1 },
    { name: "codex.sqlite.fallback.count", exports: 1, dataPoints: 1 },
    { name: "codex.sqlite.init.count", exports: 1, dataPoints: 1 },
    { name: "codex.sqlite.init.duration_ms", exports: 1, dataPoints: 1 },
    { name: "codex.thread.started", exports: 1, dataPoints: 1 },
    { name: "codex.tool.call", exports: 1, dataPoints: 1 },
    { name: "codex.tool.call.duration_ms", exports: 1, dataPoints: 1 },
  ]);
  resetOtelTelemetry();
});

test("accepts histogram-shaped lifecycle metrics when Codex reports them as distributions", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, count) => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: "2", count: String(count), sum: 0 });
  ingestOtelSignal("metrics", { resourceMetrics: [{ scopeMetrics: [{ metrics: [
    { name: "codex.hooks.run", histogram: { aggregationTemporality: 1, dataPoints: [point([["hook_name", "SessionEnd"], ["hook_source", "user"], ["handler_type", "command"], ["status", "ok"]], 2)] } },
    { name: "codex.thread.started", histogram: { aggregationTemporality: 1, dataPoints: [point([["source", "subagent"]], 3)] } },
    { name: "codex.multi_agent.spawn", histogram: { aggregationTemporality: 1, dataPoints: [point([["agent_role", "worker"], ["requested_model", "autodev/worker"], ["status", "ok"]], 1)] } },
  ] }] }] });
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.hooks.byHook[0].count, 2);
  assert.deepEqual(telemetry.threads.started, { total: 3, bySource: { subagent: 3 } });
  assert.deepEqual(telemetry.threads.spawns, { total: 1, byStatus: { ok: 1 }, byRole: { worker: 1 }, byModel: { "autodev/worker": 1 } });
  resetOtelTelemetry();
});

test("tracks router-visible subagent spawn failure reasons", () => {
  resetRouterTelemetry();
  recordSpawnFailure({ requestId: "req-provider-failed", role: "worker", requestedModel: "autodev/worker", reason: "provider_exhausted" });
  const failures = spawnFailureStatus();
  assert.equal(failures.total, 1);
  assert.equal(failures.byReason.provider_exhausted, 1);
  assert.equal(failures.recent[0].requestId, "req-provider-failed");
  resetRouterTelemetry();
});

test("normalizes and summarizes Codex task statuses for status reporting", () => {
  const summary = summarizeCodexTasks([
    { id: "task-active", status: { type: "active" }, name: "Active task", cwd: "/tmp", modelProvider: "local_model_router", createdAt: 1787940648, updatedAt: 1787954665 },
    { id: "task-idle", status: "idle", name: "Idle task" },
    { sessionId: "task-not-loaded", status: { type: "notLoaded" }, name: "Saved task" },
  ]);
  assert.deepEqual(summary.countsByStatus, { active: 1, idle: 1, notLoaded: 1 });
  assert.equal(summary.tasks[0].status, "active");
  assert.equal(summary.tasks[0].createdAt, "2026-08-28T18:10:48.000Z");
  assert.equal(summary.tasks[0].updatedAt, "2026-08-28T22:04:25.000Z");
  assert.equal(summary.tasks[2].id, "task-not-loaded");
  assert.equal(normalizeCodexTask({ id: "task", status: { type: "notLoaded" } }).status, "notLoaded");
});

test("keeps Codex task timestamp normalization compatible with millisecond and ISO inputs", () => {
  assert.equal(normalizeCodexTask({ id: "task", updatedAt: 1787954665000 }).updatedAt, "2026-08-28T22:04:25.000Z");
  assert.equal(normalizeCodexTask({ id: "task", updatedAt: "2026-08-28T22:04:25Z" }).updatedAt, "2026-08-28T22:04:25.000Z");
  assert.equal(normalizeCodexTask({ id: "task", updatedAt: "not-a-timestamp" }).updatedAt, null);
});

test("serves HTML only from /dashboard and raw JSON from /status", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type"), /text\/html/);
    const dashboardBody = await dashboard.text();
    assert.match(dashboardBody, /setInterval\(refresh, 3000\)/);
    assert.match(dashboardBody, /id="usage-breakdown"/);
    assert.doesNotMatch(dashboardBody, /id="by-origin"/);
    assert.doesNotMatch(dashboardBody, /id="by-role"/);
    assert.doesNotMatch(dashboardBody, /id="by-model"/);
    assert.match(dashboardBody, /<th>Category<\/th><th>Active<\/th><th>Attempts<\/th>/);
    assert.match(dashboardBody, /const usageBreakdownRows = \(usage\)/);
    assert.match(dashboardBody, /byRole\.unattributed \?\? \{\}/);
    assert.match(dashboardBody, /class="toggle-usage" data-usage-group="subagents"/);
    assert.match(dashboardBody, /class="usage-child" data-usage-child="subagents"\$\{expanded \? "" : " hidden"\}/);
    assert.match(dashboardBody, /const expandedUsageGroups = new Set\(\);/);
    assert.match(dashboardBody, /role !== "unattributed"/);
    assert.match(dashboardBody, /usageRow\("Orchestrator", orchestrator\)/);
    assert.match(dashboardBody, /<code>Subagents<\/code>/);
    assert.match(dashboardBody, /<h2>Orchestrator &amp; subagents<\/h2>/);
    assert.doesNotMatch(dashboardBody, /<h2>By origin<\/h2>/);
    assert.doesNotMatch(dashboardBody, /<h2>By role<\/h2>/);
    assert.match(dashboardBody, /id="codex-telemetry"/);
    assert.match(dashboardBody, /id="mcp-telemetry"/);
    assert.match(dashboardBody, /id="skills-summary"/);
    assert.match(dashboardBody, /id="skills-table"/);
    assert.match(dashboardBody, /id="native-metrics"/);
    assert.match(dashboardBody, /id="sqlite-telemetry"/);
    assert.match(dashboardBody, /id="native-metrics-summary"/);
    assert.match(dashboardBody, /aria-controls="native-metrics-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="native-metrics-section" hidden/);
    assert.match(dashboardBody, /millisecondsText/);
    assert.match(dashboardBody, /id="native-runtime-telemetry"/);
    assert.match(dashboardBody, /id="hooks-threads-summary"/);
    assert.match(dashboardBody, /codex\.skill\.injected/);
    assert.match(dashboardBody, /codex\.thread\.skills\.enabled_total/);
    assert.match(dashboardBody, /MCP ready/);
    assert.match(dashboardBody, /id="codex-tasks"/);
    assert.match(dashboardBody, /aria-controls="codex-tasks-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="codex-tasks-section" hidden/);
    assert.match(dashboardBody, /aria-controls="recent-routing-events-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="recent-routing-events-section" hidden/);
    assert.match(dashboardBody, /document\.querySelectorAll\("\.toggle-section"\)/);
    assert.match(dashboardBody, /id="spawn-failures"/);
    assert.match(dashboardBody, /processFallbackEnforcement/);
    assert.match(dashboardBody, /process-wide bucket/);
    assert.match(dashboardBody, /active sessions: \$\{concurrency\.activeSessions \?\? 0\}/);
    assert.match(dashboardBody, /<tfoot>/);
    assert.match(dashboardBody, /class="provider-summary"/);
    assert.match(dashboardBody, /id="summary-attempts"/);
    assert.match(dashboardBody, /Status: \$\{taskStatus.status/);
    assert.match(dashboardBody, /const collapsible = models.length > 1/);
    assert.match(dashboardBody, /const modelStats = uniqueModels.reduce/);
    assert.match(dashboardBody, /total\.active \+= stats\.active \?\? 0;/);
    assert.match(dashboardBody, /\$\{cooldown\}<\/td><td>\$\{modelStats\.active\}<\/td><td>\$\{modelStats\.attempts\}<\/td>/);
    assert.match(dashboardBody, /const modelLimited = limited && \(stats\.failures \?\? 0\) > 0 && stats\.lastFailure;/);
    assert.match(dashboardBody, /\$\{text\(modelStatus\)\}<\/td><td>\$\{stats\.active \?\? 0\}<\/td><td>\$\{stats\.attempts \?\? 0\}<\/td>/);
    assert.doesNotMatch(dashboardBody, /<\/td><td>0<\/td><td>\$\{stats\.attempts \?\? 0\}<\/td>/);
    assert.match(dashboardBody, /const configuredCell = collapsible \? ""/);
    assert.match(dashboardBody, /<th>Provider<\/th><th>Model<\/th>/);
    assert.match(dashboardBody, /id="providers-table"/);
    assert.match(dashboardBody, /#providers-table \{ table-layout: fixed; min-width: 0; width: 100%; \}/);
    assert.match(dashboardBody, /class="table-scroll"/);
    assert.match(dashboardBody, /<th>Tool calls<\/th><th>Avg\. turn<\/th>/);
    assert.match(dashboardBody, /const configuredCell = collapsible \? ""/);
    assert.match(dashboardBody, /Provider skips/);
    assert.match(dashboardBody, /: "";/);
    assert.doesNotMatch(dashboardBody, />—</);

    const browserStatus = await fetch(`http://127.0.0.1:${address.port}/status`, { headers: { Accept: "text/html" } });
    assert.equal(browserStatus.status, 200);
    assert.match(browserStatus.headers.get("content-type"), /application\/json/);
    assert.equal((await browserStatus.json()).schema, "autodev-router-status-v1");

    const api = await fetch(`http://127.0.0.1:${address.port}/status`, { headers: { Accept: "application/json" } });
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type"), /application\/json/);
    assert.equal((await api.json()).schema, "autodev-router-status-v1");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("serves status snapshots without exposing request content", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.schema, "autodev-router-status-v1");
    assert.equal(status.codexTasks.status, "pending");
    assert.equal(status.providers.claude.configuredModels.default, "sonnet");
    assert.equal(Object.hasOwn(status, "prompt"), false);
    assert.equal(Object.hasOwn(status.providers.claude, "apiKey"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("persists provider telemetry and recent events across router restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-state-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    recordRouterEvent({ phase: "selected", requestId: "req-persist", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3" });
    recordRouterEvent({ phase: "result", requestId: "req-persist", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3", outcome: "failure", status: 429, failureClass: "throttled", elapsedMs: 11 });
    resetOtelTelemetry();
    ingestOtelSignal("metrics", { resourceMetrics: [{ scopeMetrics: [{ metrics: [{
      name: "codex.skill.injected",
      sum: { aggregationTemporality: 1, dataPoints: [{ attributes: [{ key: "skill", value: { stringValue: "orchestration" } }, { key: "status", value: { stringValue: "ok" } }], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "2" }] },
    }, {
      name: "codex.hooks.run",
      sum: { aggregationTemporality: 1, dataPoints: [{ attributes: [{ key: "hook_name", value: { stringValue: "SessionStart" } }, { key: "hook_source", value: { stringValue: "user" } }, { key: "handler_type", value: { stringValue: "command" } }, { key: "status", value: { stringValue: "ok" } }], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" }] },
    }, {
      name: "codex.thread.started",
      sum: { aggregationTemporality: 1, dataPoints: [{ attributes: [{ key: "source", value: { stringValue: "subagent" } }], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" }] },
    }] }] }] });
    await persistRouterStateNow(stateFile);
    resetRouterTelemetry();
    resetOtelTelemetry();
    assert.equal(getRouterStatus().providers.minimax.failures, 0);

    assert.equal(loadRouterState(stateFile), true);
    const restored = getRouterStatus();
    assert.equal(restored.providers.minimax.failures, 1);
    assert.equal(restored.providers.minimax.lastFailure.class, "throttled");
    assert.equal(restored.usage.byRole.worker.attempts, 1);
    assert.equal(restored.usage.byModel["minimax/MiniMax-M3"].failures, 1);
    assert.equal(restored.usage.byOrigin.subagent.failures, 1);
    assert.equal(restored.recentEvents[0].requestId, "req-persist");
    assert.equal(restored.recentEvents[0].toolCalls, 0);
    assert.equal(restored.codexTelemetry.skills.injected.total, 2);
    assert.equal(restored.codexTelemetry.skills.injected.bySkill[0].skill, "orchestration");
    assert.equal(restored.codexTelemetry.receiver.metrics, 1);
    assert.equal(restored.codexTelemetry.hooks.byHook[0].count, 1);
    assert.deepEqual(restored.codexTelemetry.threads.started, { total: 1, bySource: { subagent: 1 } });
    assert.match(serializeRouterState(), /"otelTelemetry"/);
    assert.doesNotMatch(serializeRouterState(), /prompt_text|api[_-]?key|authorization/i);
  } finally {
    resetRouterTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores a corrupt persisted router state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-state-"));
  const stateFile = join(directory, "router-state.json");
  try {
    await writeFile(stateFile, "{not-json");
    assert.equal(loadRouterState(stateFile), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counts tool calls without double-counting streamed output items", () => {
  const toolResponse = { output: [{ id: "call-1", type: "function_call" }, { id: "message-1", type: "message" }] };
  assert.equal(countToolCallsInResponse(toolResponse), 1);
  const stream = [
    'data: {"type":"response.output_item.added","item":{"id":"call-1","type":"function_call"}}',
    `data: ${JSON.stringify({ type: "response.completed", response: toolResponse })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal(countToolCallsFromSse(stream), 1);
});

test("aggregates usage by role, resolved model, origin, duration, and tool calls", () => {
  resetRouterTelemetry();
  assert.deepEqual(getRouterStatus().usage.byRole.smart, {
    attempts: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    active: 0,
    durationMs: 0,
    maxDurationMs: 0,
    toolCalls: 0,
    lastUsedAt: null,
    lastFailure: null,
    averageDurationMs: 0,
  });
  recordRouterEvent({ phase: "selected", requestId: "req-usage-role", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet" });
  assert.equal(getRouterStatus().usage.byOrigin.subagent.active, 1);
  assert.equal(getRouterStatus().usage.byRole.explorer.active, 1);
  recordRouterEvent({ phase: "result", requestId: "req-usage-role", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet", outcome: "success", status: 200, elapsedMs: 120, toolCalls: 2 });
  recordRouterEvent({ phase: "selected", requestId: "req-usage-parent", requestedModel: "gpt-5.6-luna", provider: "codex", model: "gpt-5.6-luna" });
  recordRouterEvent({ phase: "result", requestId: "req-usage-parent", requestedModel: "gpt-5.6-luna", provider: "codex", model: "gpt-5.6-luna", outcome: "success", status: 200, elapsedMs: 80, toolCalls: 1 });

  const usage = getRouterStatus().usage;
  assert.equal(usage.byRole.explorer.attempts, 1);
  assert.equal(usage.byRole.explorer.successes, 1);
  assert.equal(usage.byRole.explorer.averageDurationMs, 120);
  assert.equal(usage.byRole.explorer.toolCalls, 2);
  assert.equal(usage.byModel["claude/sonnet"].successes, 1);
  assert.equal(usage.byOrigin.subagent.successes, 1);
  assert.equal(usage.byOrigin.orchestrator.successes, 1);
  assert.equal(usage.totals.toolCalls, 3);
  resetRouterTelemetry();
});

test("folds roleless orchestrator and direct traffic into a single unattributed bucket that sums to the Subagents role totals", () => {
  resetRouterTelemetry();
  // Orchestrator-origin: a direct Codex model request (no role).
  recordRouterEvent({ phase: "selected", requestId: "req-orchestrator", requestedModel: "gpt-5.6-sol", provider: "codex", model: "gpt-5.6-sol" });
  recordRouterEvent({ phase: "result", requestId: "req-orchestrator", requestedModel: "gpt-5.6-sol", provider: "codex", model: "gpt-5.6-sol", outcome: "success", status: 200, elapsedMs: 50 });
  // Direct-origin: a non-Codex concrete model request (no role).
  recordRouterEvent({ phase: "selected", requestId: "req-direct", requestedModel: "sonnet", provider: "claude", model: "sonnet" });
  recordRouterEvent({ phase: "result", requestId: "req-direct", requestedModel: "sonnet", provider: "claude", model: "sonnet", outcome: "success", status: 200, elapsedMs: 30 });
  // Subagent-origin: two distinct role requests.
  recordRouterEvent({ phase: "selected", requestId: "req-worker", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3" });
  recordRouterEvent({ phase: "result", requestId: "req-worker", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3", outcome: "success", status: 200, elapsedMs: 20, toolCalls: 2 });
  recordRouterEvent({ phase: "selected", requestId: "req-explorer", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet" });
  recordRouterEvent({ phase: "result", requestId: "req-explorer", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet", outcome: "failure", status: 429, failureClass: "throttled", elapsedMs: 10 });

  const usage = getRouterStatus().usage;
  // byOrigin keeps orchestrator and direct distinct (unchanged JSON API contract).
  assert.equal(usage.byOrigin.orchestrator.successes, 1);
  assert.equal(usage.byOrigin.direct.successes, 1);
  assert.equal(usage.byOrigin.subagent.successes, 1);
  assert.equal(usage.byOrigin.subagent.failures, 1);
  // The dashboard's Orchestrator row folds both roleless origins into byRole.unattributed.
  assert.equal(usage.byRole.unattributed.attempts, 2);
  assert.equal(usage.byRole.unattributed.successes, 2);

  const roleEntries = Object.entries(usage.byRole).filter(([role]) => role !== "unattributed");
  const subagentTotal = roleEntries.reduce((total, [, bucket]) => ({
    attempts: total.attempts + bucket.attempts,
    successes: total.successes + bucket.successes,
    failures: total.failures + bucket.failures,
    toolCalls: total.toolCalls + bucket.toolCalls,
  }), { attempts: 0, successes: 0, failures: 0, toolCalls: 0 });
  // Child role-bucket rows (excluding unattributed) must aggregate to the Subagents parent totals.
  assert.equal(subagentTotal.attempts, usage.byOrigin.subagent.attempts);
  assert.equal(subagentTotal.successes, usage.byOrigin.subagent.successes);
  assert.equal(subagentTotal.failures, usage.byOrigin.subagent.failures);
  assert.equal(subagentTotal.toolCalls, usage.byOrigin.subagent.toolCalls);
  resetRouterTelemetry();
});

test("byModel active count tracks in-flight requests per model so the dashboard can sum child active into the provider parent", () => {
  resetRouterTelemetry();
  recordRouterEvent({ phase: "selected", requestId: "req-active-1", requestedModel: "sonnet", provider: "claude", model: "sonnet" });
  recordRouterEvent({ phase: "selected", requestId: "req-active-2", requestedModel: "claude-opus-4-8", provider: "claude", model: "claude-opus-4-8" });
  let usage = getRouterStatus().usage;
  assert.equal(usage.byModel["claude/sonnet"].active, 1);
  assert.equal(usage.byModel["claude/claude-opus-4-8"].active, 1);
  // Parent Active = sum of visible children, per model, for this provider.
  const parentActive = usage.byModel["claude/sonnet"].active + usage.byModel["claude/claude-opus-4-8"].active;
  assert.equal(parentActive, 2);

  recordRouterEvent({ phase: "result", requestId: "req-active-1", requestedModel: "sonnet", provider: "claude", model: "sonnet", outcome: "success", status: 200, elapsedMs: 5 });
  usage = getRouterStatus().usage;
  assert.equal(usage.byModel["claude/sonnet"].active, 0);
  assert.equal(usage.byModel["claude/claude-opus-4-8"].active, 1);

  recordRouterEvent({ phase: "result", requestId: "req-active-2", requestedModel: "claude-opus-4-8", provider: "claude", model: "claude-opus-4-8", outcome: "success", status: 200, elapsedMs: 5 });
  assert.equal(getRouterStatus().usage.byModel["claude/claude-opus-4-8"].active, 0);
  resetRouterTelemetry();
});

test("keeps a stale byModel lastFailure after a later success, which the dashboard must not treat as an ongoing outage once the provider recovers", () => {
  resetRouterTelemetry();
  clearProviderCooldown("claude");
  recordRouterEvent({ phase: "selected", requestId: "req-model-fail", requestedModel: "sonnet", provider: "claude", model: "sonnet" });
  cooldownProvider("claude");
  recordRouterEvent({ phase: "result", requestId: "req-model-fail", requestedModel: "sonnet", provider: "claude", model: "sonnet", outcome: "failure", status: 429, failureClass: "throttled", elapsedMs: 5 });
  assert.equal(getRouterStatus().providers.claude.status, "throttled");

  // Provider recovers: cooldown clears and a later request on the same model succeeds.
  clearProviderCooldown("claude");
  recordRouterEvent({ phase: "selected", requestId: "req-model-recover", requestedModel: "sonnet", provider: "claude", model: "sonnet" });
  recordRouterEvent({ phase: "result", requestId: "req-model-recover", requestedModel: "sonnet", provider: "claude", model: "sonnet", outcome: "success", status: 200, elapsedMs: 8 });

  const status = getRouterStatus();
  // The provider itself fully recovers: no active cooldown means "ready", and the
  // provider-level lastFailure is cleared by the following success.
  assert.equal(status.providers.claude.status, "ready");
  assert.equal(status.providers.claude.lastFailure, null);
  // The per-model usage bucket has no success-path reset for lastFailure, so it keeps
  // the earlier failure forever. The dashboard's child-row status must gate on the
  // provider's current limited state rather than this stale per-model failure, or a
  // recovered model would render "limited" indefinitely.
  assert.equal(status.usage.byModel["claude/sonnet"].failures, 1);
  assert.ok(status.usage.byModel["claude/sonnet"].lastFailure);
  resetRouterTelemetry();
});

test("reads and enforces Codex per-session and global thread limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-concurrency-"));
  const configFile = join(directory, "config.toml");
  try {
    await writeFile(configFile, "[agents]\nmax_concurrent_threads_per_session = 2\nmax_threads = 3\n");
    assert.deepEqual(parseConcurrencyConfig(configFile), { file: configFile, maxConcurrentThreadsPerSession: 2, maxThreads: 3 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  resetConcurrencyTelemetry();
  assert.equal(tryAcquireSubagentSlot("test-session"), null);
  assert.equal(tryAcquireSubagentSlot("test-session"), "max_concurrent_threads_per_session");
  recordConcurrencyDenial({ requestId: "req-denied", role: "worker", requestedModel: "autodev/worker", sessionScope: "identified", reason: "max_concurrent_threads_per_session" });
  const status = concurrencyStatus();
  assert.equal(status.maxConcurrentThreadsPerSession, 1);
  assert.equal(status.effectivePerSessionLimit, 1);
  assert.equal(Object.hasOwn(status, "maxThreads"), false);
  assert.equal(status.activeSubagentThreads, 1);
  assert.equal(status.denials, 1);
  assert.equal(status.lastDenial.reason, "max_concurrent_threads_per_session");
  releaseSubagentSlot("test-session");
  resetConcurrencyTelemetry();
});

test("requestSession derives identity from caller-supplied headers and payload fields, never invents it", () => {
  const noSignal = requestSession({ headers: {} }, {});
  assert.deepEqual(noSignal, { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" });

  assert.deepEqual(requestSession({ headers: { "x-codex-session-id": "sess-header-1" } }, {}), { key: "sess-header-1", scope: "identified" });
  assert.deepEqual(requestSession({ headers: { "x-session-id": "sess-header-2" } }, {}), { key: "sess-header-2", scope: "identified" });
  assert.deepEqual(requestSession({ headers: { "x-conversation-id": "sess-header-3" } }, {}), { key: "sess-header-3", scope: "identified" });
  assert.deepEqual(requestSession({ headers: {} }, { session_id: "sess-body-1" }), { key: "sess-body-1", scope: "identified" });
  assert.deepEqual(requestSession({ headers: {} }, { conversation_id: "sess-body-2" }), { key: "sess-body-2", scope: "identified" });
  assert.deepEqual(requestSession({ headers: {} }, { metadata: { session_id: "sess-meta-1" } }), { key: "sess-meta-1", scope: "identified" });
  assert.deepEqual(requestSession({ headers: {} }, { metadata: { conversation_id: "sess-meta-2" } }), { key: "sess-meta-2", scope: "identified" });

  // Whitespace-only or non-string identity is treated as absent rather than trusted as-is.
  assert.deepEqual(requestSession({ headers: { "x-codex-session-id": "   " } }, {}), { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" });
  assert.deepEqual(requestSession({ headers: {} }, { session_id: 12345 }), { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" });

  // A header takes priority over payload fields when both are present.
  assert.deepEqual(requestSession({ headers: { "x-codex-session-id": "sess-header" } }, { session_id: "sess-body" }), { key: "sess-header", scope: "identified" });
});

test("per-session slot limit gives distinct identified sessions independent capacity while capping a shared or missing identity", () => {
  resetConcurrencyTelemetry();
  try {
    // Two distinct identified sessions each get their own slot at the same limit.
    assert.equal(tryAcquireSubagentSlot("session-a"), null);
    assert.equal(tryAcquireSubagentSlot("session-b"), null);
    assert.equal(concurrencyStatus().activeSubagentThreads, 2);
    assert.equal(concurrencyStatus().activeSessions, 2);

    // The same identified session is capped by the configured per-session limit.
    assert.equal(tryAcquireSubagentSlot("session-a"), "max_concurrent_threads_per_session");
    releaseSubagentSlot("session-a");
    releaseSubagentSlot("session-b");

    // Two requests that both fail to supply any session identity share the documented
    // process-wide fallback bucket and are capped together, even though nothing proves
    // they belong to the same logical Codex session -- this is the fail-safe behavior
    // called out in docs/provider-routing.md, not true per-session enforcement.
    const first = requestSession({ headers: {} }, {});
    const second = requestSession({ headers: {} }, {});
    assert.equal(first.key, PROCESS_FALLBACK_SESSION_KEY);
    assert.equal(second.key, PROCESS_FALLBACK_SESSION_KEY);
    assert.equal(tryAcquireSubagentSlot(first.key), null);
    assert.equal(concurrencyStatus().processFallbackActiveThreads, 1);
    assert.equal(concurrencyStatus().processFallbackEnforcement, true);
    assert.equal(tryAcquireSubagentSlot(second.key), "max_concurrent_threads_per_session");
    releaseSubagentSlot(first.key);
    assert.equal(concurrencyStatus().processFallbackActiveThreads, 0);
    assert.equal(concurrencyStatus().processFallbackEnforcement, false);
  } finally {
    resetConcurrencyTelemetry();
  }
});

test("status snapshot exposes configured models, active work, cooldowns, and recent events", () => {
  resetRouterTelemetry();
  activeProviderRequests.clear();
  clearProviderCooldown("claude");
  recordRouterEvent({ phase: "selected", requestId: "req-status", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet" });
  incrementActiveRequests("claude");
  const selected = getRouterStatus();
  assert.equal(selected.providers.claude.status, "ready");
  assert.equal(selected.providers.claude.configuredModels.default, "sonnet");
  assert.equal(selected.providers.claude.attempts, 1);
  assert.equal(selected.providers.claude.activeRequests, 1);

  cooldownProvider("claude");
  recordRouterEvent({ phase: "result", requestId: "req-status", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet", outcome: "failure", status: 429, failureClass: "throttled", elapsedMs: 12 });
  const limited = getRouterStatus();
  assert.equal(limited.providers.claude.status, "throttled");
  assert.equal(limited.providers.claude.failures, 1);
  assert.equal(limited.providers.claude.lastFailure.class, "throttled");
  assert.equal(limited.recentEvents[0].phase, "result");
  assert.equal(limited.recentEvents[0].requestId, "req-status");
  decrementActiveRequests("claude");
  clearProviderCooldown("claude");
  resetRouterTelemetry();
});

test("extracts text from a Responses SSE completion", () => {
  const body = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"router"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"-ok"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"router-ok"}}',
    "data: [DONE]",
    "",
  ].join("\n");
  const response = responseTextFromSse(body);
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "router-ok");
  assert.equal(response.output[0].content[0].text, "router-ok");
});


test("deduplicates catalog models and keeps role aliases visible", () => {
  const ids = catalogModelIds([{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-luna" }], ["autodev/explorer"]);
  assert.deepEqual(ids, ["gpt-5.6-luna", "autodev/explorer"]);
});

test("rewrites the routed provider model back to the public role alias", () => {
  const value = replaceModelFields({ model: "gemini-3.6-flash-medium", nested: [{ model: "gemini-3.6-flash-medium" }] }, "autodev/explorer");
  assert.deepEqual(value, { model: "autodev/explorer", nested: [{ model: "autodev/explorer" }] });

  const event = transformSseEvent('data: {"type":"response.completed","response":{"model":"gemini-3.6-flash-medium"},"model":"gemini-3.6-flash-medium"}\n\n', "autodev/explorer");
  assert.match(event, /autodev\/explorer/);
  assert.equal((event.match(/autodev\/explorer/g) ?? []).length, 2);
});

test("uses the least-busy provider before starting another provider request", () => {
  activeProviderRequests.clear();
  incrementActiveRequests("claude");
  incrementActiveRequests("minimax");
  const candidates = roleCandidates("default", () => 0.5).map((candidate) => candidate.provider);
  assert.equal(candidates[0], "antigravity");
  assert.deepEqual(candidates.slice(3), ["copilot", "codex"]);
  activeProviderRequests.clear();
});

test("balances candidate provider priority across active in-flight requests", () => {
  activeProviderRequests.clear();
  assert.equal(getActiveRequests("claude"), 0);

  incrementActiveRequests("claude");
  incrementActiveRequests("claude");
  incrementActiveRequests("antigravity");
  assert.equal(getActiveRequests("claude"), 2);
  assert.equal(getActiveRequests("antigravity"), 1);
  assert.equal(getActiveRequests("minimax"), 0);

  const candidates = roleCandidates("default", () => 0.5);
  const providers = candidates.map((c) => c.provider);
  // minimax (0 active) should come first, then antigravity (1 active), then claude (2 active)
  assert.equal(providers[0], "minimax");
  assert.equal(providers[1], "antigravity");
  assert.equal(providers[2], "claude");

  decrementActiveRequests("claude");
  decrementActiveRequests("claude");
  decrementActiveRequests("antigravity");
  assert.equal(getActiveRequests("claude"), 0);
  assert.equal(getActiveRequests("antigravity"), 0);
  activeProviderRequests.clear();
});

test("handles safe decrement on inactive providers without going negative", () => {
  activeProviderRequests.clear();
  decrementActiveRequests("nonexistent_provider");
  assert.equal(getActiveRequests("nonexistent_provider"), 0);
  assert.equal(activeProviderRequests.has("nonexistent_provider"), false);

  incrementActiveRequests("test_provider");
  assert.equal(getActiveRequests("test_provider"), 1);
  decrementActiveRequests("test_provider");
  assert.equal(getActiveRequests("test_provider"), 0);
  assert.equal(activeProviderRequests.has("test_provider"), false);
});

test("rejects invalid role model patterns and unknown models", () => {
  assert.equal(roleForModel(null), null);
  assert.equal(roleForModel(undefined), null);
  assert.equal(roleForModel(""), null);
  assert.equal(roleForModel("autodev/"), null);
  assert.equal(roleForModel("autodev/nonexistent-role"), null);
  assert.equal(roleForModel("not-autodev/default"), null);

  assert.equal(routeForModel(null), null);
  assert.equal(routeForModel(undefined), null);
  assert.equal(routeForModel(""), null);
  assert.equal(routeForModel("custom-unsupported-model-name"), null);
});

test("handles malformed SSE lines and comments gracefully without throwing", () => {
  const malformed = 'data: not a valid json line\n: keep-alive comment\ndata: [DONE]\n\n';
  const result = transformSseEvent(malformed, "autodev/worker");
  assert.equal(result, malformed);
});

test("extracts text from SSE stream with empty lines and keep-alive comments", () => {
  const rawStream = [
    ': claude-bridge keep-alive',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"part1 "}',
    '',
    ': agy-bridge keep-alive',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"part2"}',
    'data: [DONE]',
    '',
  ].join('\n');
  const response = responseTextFromSse(rawStream);
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "part1 part2");
  assert.equal(response.output[0].content[0].text, "part1 part2");
});
