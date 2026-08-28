import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { activeProviderRequests, catalogModelIds, classifyProviderFailure, clearProviderCooldown, cooldownProvider, decrementActiveRequests, fallbackable, getActiveRequests, concurrencyStatus, countToolCallsFromSse, countToolCallsInResponse, getRouterStatus, handle, incrementActiveRequests, isProviderCoolingDown, loadRouterState, parseConcurrencyConfig, persistRouterStateNow, recordConcurrencyDenial, recordRouterEvent, releaseSubagentSlot, replaceModelFields, resetConcurrencyTelemetry, resetRouterTelemetry, serializeRouterState, responseTextFromSse, roleCandidates, roleForModel, routeCredentialAvailable, routeForModel, transformSseEvent, tryAcquireSubagentSlot, validateRoutingConfig } from "./codex-model-router.mjs";

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

test("serves a lightweight dashboard to browsers and JSON to API clients", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/status`, { headers: { Accept: "text/html" } });
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type"), /text\/html/);
    const dashboardBody = await dashboard.text();
    assert.match(dashboardBody, /setInterval\(refresh, 3000\)/);
    assert.match(dashboardBody, /id="by-origin"/);
    assert.match(dashboardBody, /id="by-role"/);
    assert.match(dashboardBody, /id="by-model"/);
    assert.match(dashboardBody, /const collapsible = models.length > 1/);
    assert.match(dashboardBody, /const modelStats = uniqueModels.reduce/);
    assert.match(dashboardBody, /const configuredCell = collapsible \? ""/);
    assert.match(dashboardBody, /Provider skips/);
    assert.match(dashboardBody, /: "";/);
    assert.doesNotMatch(dashboardBody, />—</);

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
    await persistRouterStateNow(stateFile);
    resetRouterTelemetry();
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
    assert.doesNotMatch(serializeRouterState(), /prompt|api[_-]?key|authorization/i);
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
  recordRouterEvent({ phase: "selected", requestId: "req-usage-role", role: "explorer", requestedModel: "autodev/explorer", provider: "claude", model: "sonnet" });
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
  assert.equal(status.activeSubagentThreads, 1);
  assert.equal(status.denials, 1);
  assert.equal(status.lastDenial.reason, "max_concurrent_threads_per_session");
  releaseSubagentSlot("test-session");
  resetConcurrencyTelemetry();
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


