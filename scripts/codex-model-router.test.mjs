import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  activeProviderRequests,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  beginShutdown,
  catalogModelIds,
  classifyProviderFailure,
  clearProviderCooldown,
  cooldownProvider,
  decrementActiveRequests,
  downstreamHeaders,
  fallbackable,
  FORWARDED_REQUEST_HEADERS,
  getActiveRequests,
  getLifecycleStatus,
  concurrencyStatus,
  countToolCallsFromSse,
  countToolCallsInResponse,
  getRouterStatus,
  handle,
  codexTelemetryStatus,
  ingestOtelSignal,
  incrementActiveRequests,
  isClientDisconnectError,
  isDraining,
  isProviderCoolingDown,
  loadRouterState,
  nextProviderRetryMs,
  parseConcurrencyConfig,
  parseTurnMetadataJson,
  persistRouterStateNow,
  PROCESS_FALLBACK_SESSION_KEY,
  recordConcurrencyDenial,
  recordRouterEvent,
  recordSpawnFailure,
  releaseSubagentSlot,
  replaceModelFields,
  requestSession,
  proxyConcreteResponse,
  proxyOrchestratorResponse,
  orchestratorCandidates,
  ORCHESTRATOR_ALIAS,
  payloadForCandidate,
  resetConcurrencyTelemetry,
  resetLifecycleForTests,
  resetRouterTelemetry,
  resetOtelTelemetry,
  resolveTurnMetadataHeader,
  ROUTER_INSTANCE_ID,
  serializeRouterState,
  spawnFailureStatus,
  responseTextFromSse,
  roleCandidates,
  roleForModel,
  routeCredentialAvailable,
  routeForModel,
  transformSseEvent,
  flattenOutboundTools,
  rewriteToolNamespaces,
  bridgeTelemetryHeaders,
  ingestAgentEvents,
  noteBridgeRequest,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  subagentStatus,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  AGENT_EVENTS_URL_HEADER,
  AGENT_EVENTS_PATH,
  tryAcquireSubagentSlot,
  validateRoutingConfig,
  workspaceContextFromRequest,
} from "./codex-model-router.mjs";
import { resolveAgentEventReporter } from "./codex/lib/agent-events.mjs";
import { spawnedChildren } from "./codex-antigravity-cli-responses-proxy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the router calls the Antigravity adapter directly, with no LiteLLM hop", async () => {
  // LiteLLM used to sit between the router and the agy adapter as an identity
  // pass-through. It routed nothing, but it dropped raw request headers -- which
  // forced the router to smuggle its own headers through the Responses body --
  // and it mistranslated `response.failed`, which forced the adapter to fake a
  // completed response. Both workarounds are gone with it.
  const route = routeForModel("gemini-3.8-flash-high");
  assert.equal(route.provider, "antigravity");
  assert.equal(route.baseUrl, "http://127.0.0.1:4002/v1");
  assert.equal(route.healthUrl, "http://127.0.0.1:4002/health/liveliness");

  const router = read("scripts/codex-model-router.mjs");
  assert.doesNotMatch(router, /extra_headers = forwarded/, "router headers must travel as real headers");
  assert.doesNotMatch(router, /metadata\?\.provider_error/, "the faked-completion detector is obsolete");

  const bridge = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(bridge, /emit\("response\.failed"/, "a post-stream failure must be reported as a failure");
  assert.doesNotMatch(bridge, /failedStream/);

  for (const path of [
    "scripts/codex/litellm/antigravity.yaml",
    "scripts/run-codex-antigravity-litellm.sh",
    "scripts/codex/launchagents/com.codex.antigravity-litellm.plist",
  ]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} must be gone`);
  }
  assert.doesNotMatch(read("scripts/ensure-codex-antigravity-proxy.sh"), /litellm/i, "the ensure hook must not supervise LiteLLM");
  // The installer still names the obsolete assets, because naming them is how
  // it removes them from a host that has them; it must not install them.
  const installer = read("scripts/codex/install-codex-integration.sh");
  assert.match(installer, /obsolete_launchagent_labels=\(com\.codex\.antigravity-litellm\)/);
  assert.doesNotMatch(installer, /litellm_dir/);
});

test("loads editable provider and role models from JSON routing config", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  assert.equal(config.providers.claude.models.smart, "claude-opus-5");
  assert.equal(config.providers.codex.models.smart, "gpt-5.6-sol");
  assert.equal(config.providers.minimax.models.smart, undefined);
  assert.equal(config.providers.copilot.models.smart, undefined);
  assert.deepEqual(config.providerGroups.default, [ [ "claude", "antigravity", "minimax" ], [ "copilot" ], [ "codex" ] ]);
  assert.deepEqual(config.providerGroups.smart, [ [ "claude", "antigravity" ], [ "codex" ] ]);
  assert.deepEqual(config.providerGroups.orchestrator, [ [ "codex" ], [ "claude", "minimax", "antigravity" ] ]);
  assert.equal(config.roles.worker.tier, "default");
  assert.equal(config.roles.smart.tier, "smart");
  assert.equal(config.orchestrator.alias, "autodev/orchestrator");
  assert.equal(config.orchestrator.tier, "orchestrator");
  assert.equal(config.providers.codex.models.orchestrator, "gpt-5.6-luna");
  assert.equal(config.providers.claude.models.orchestrator, "claude-opus-5");
  assert.equal(config.providers.antigravity.models.orchestrator, "gemini-3.8-flash-high");
  assert.deepEqual(config.orchestrator.reasoningEffort, { claude: "medium", minimax: "high", antigravity: "high" });
});

test("only spawn-capable providers serve the orchestrator tier", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  // Two delegation paths both count. Codex spawns native child threads, and
  // MiniMax drives that same tool through the namespace-flattening proxy. The
  // Claude and Antigravity CLI bridges delegate inside their own runtime and
  // report those spawns over /v1/agent-events. Copilot's CLI has no subagent
  // tool, so it stays out of the orchestrator tier.
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.providers).map(([ provider, info ]) => [ provider, info.capabilities.subagentSpawn ])),
    { antigravity: true, claude: true, minimax: true, copilot: false, codex: true },
  );
  for (const group of config.providerGroups.orchestrator) {
    for (const provider of group) {
      assert.equal(
        config.providers[ provider ].capabilities.subagentSpawn,
        true,
        `${provider} serves the orchestrator tier, so it must be able to spawn subagents`,
      );
    }
  }
});

test("router status surfaces each provider's subagent spawn capability and watched tools", () => {
  const providers = getRouterStatus().providers;
  // Only the CLI-delegation bridges name tools: their spawns are invisible to
  // the router unless it tells them which tool names to report.
  assert.deepEqual(providers.claude.capabilities, { subagentSpawn: true, subagentSpawnTools: [ "Agent", "Task" ] });
  assert.deepEqual(providers.antigravity.capabilities, { subagentSpawn: true, subagentSpawnTools: [ "invoke_subagent" ] });
  assert.deepEqual(providers.codex.capabilities, { subagentSpawn: true, subagentSpawnTools: [] });
  assert.deepEqual(providers.minimax.capabilities, { subagentSpawn: true, subagentSpawnTools: [] });
  assert.deepEqual(providers.copilot.capabilities, { subagentSpawn: false, subagentSpawnTools: [] });
});

test("orchestrator alias degrades from the pinned primary provider to a load-balanced fallback group with pinned reasoning effort", () => {
  assert.equal(ORCHESTRATOR_ALIAS, "autodev/orchestrator");
  assert.equal(roleForModel(ORCHESTRATOR_ALIAS), null);

  const candidates = orchestratorCandidates(() => 0.5);
  assert.equal(candidates[ 0 ].provider, "codex", "the primary provider is always attempted first");
  assert.equal(candidates[ 0 ].model, "gpt-5.6-luna");
  assert.equal(candidates[ 0 ].reasoningEffort, null, "the primary provider keeps the caller's reasoning effort");
  assert.deepEqual(candidates.slice(1).map((candidate) => candidate.provider).sort(), [ "antigravity", "claude", "minimax" ]);

  const byProvider = Object.fromEntries(candidates.map((candidate) => [ candidate.provider, candidate ]));
  assert.equal(byProvider.claude.model, "claude-opus-5");
  assert.equal(byProvider.claude.reasoningEffort, "medium");
  assert.equal(byProvider.minimax.model, "MiniMax-M3");
  assert.equal(byProvider.minimax.reasoningEffort, "high");
  assert.equal(byProvider.antigravity.model, "gemini-3.8-flash-high");
  assert.equal(byProvider.antigravity.reasoningEffort, "high");

  // The fallback group is shuffled/least-loaded, never the pinned primary.
  assert.notDeepEqual(
    orchestratorCandidates(() => 0).slice(1).map((candidate) => candidate.provider),
    orchestratorCandidates(() => 0.999).slice(1).map((candidate) => candidate.provider),
  );

  const swapped = payloadForCandidate({ model: "autodev/orchestrator", reasoning: { summary: "auto", effort: "xhigh" } }, byProvider.claude);
  assert.equal(swapped.model, "claude-opus-5");
  assert.deepEqual(swapped.reasoning, { summary: "auto", effort: "medium" });

  const primary = payloadForCandidate({ model: "autodev/orchestrator", reasoning: { effort: "xhigh" } }, candidates[ 0 ]);
  assert.equal(primary.model, "gpt-5.6-luna");
  assert.deepEqual(primary.reasoning, { effort: "xhigh" }, "the pinned primary provider is dispatched with the caller's effort untouched");
});

test("validates routing config and requires default model for providers", () => {
  const validConfig = {
    providerGroups: {
      default: [ [ "testProvider" ], [ "fallbackProvider" ] ],
      smart: [ [ "testProvider" ], [ "fallbackProvider" ] ],
      orchestrator: [ [ "testProvider" ], [ "fallbackProvider" ] ],
    },
    providers: {
      testProvider: { capabilities: { subagentSpawn: true }, models: { default: "test-model" } },
      fallbackProvider: { capabilities: { subagentSpawn: true }, models: { default: "fallback-model" } },
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
    orchestrator: {
      alias: "autodev/orchestrator",
      tier: "orchestrator",
      reasoningEffort: { fallbackProvider: "high" },
    },
  };
  assert.doesNotThrow(() => validateRoutingConfig(validConfig));

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providers: { testProvider: { capabilities: { subagentSpawn: true }, models: {} } } }),
    /Routing config provider testProvider must define a default model/
  );

  assert.throws(
    () => validateRoutingConfig({
      ...validConfig,
      providers: { ...validConfig.providers, testProvider: { models: { default: "test-model" } } },
    }),
    /Routing config provider testProvider must declare capabilities\.subagentSpawn as a boolean/
  );

  assert.throws(
    () => validateRoutingConfig({
      ...validConfig,
      providers: {
        ...validConfig.providers,
        fallbackProvider: { capabilities: { subagentSpawn: false }, models: { default: "fallback-model" } },
      },
    }),
    /orchestrator tier orchestrator includes provider fallbackProvider, which declares capabilities\.subagentSpawn: false/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providerGroups: { default: [ [] ], smart: [ [ "testProvider" ] ], orchestrator: [ [ "testProvider" ] ] } }),
    /Routing config tier default contains an invalid provider group/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, orchestrator: undefined }),
    /Routing config requires an orchestrator block/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, orchestrator: { ...validConfig.orchestrator, alias: "orchestrator" } }),
    /orchestrator\.alias must be an autodev\/<name> alias/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, orchestrator: { ...validConfig.orchestrator, reasoningEffort: { unknownProvider: "high" } } }),
    /orchestrator\.reasoningEffort references unknown provider unknownProvider/
  );
});

test("routes supported model families without provider aliases", () => {
  assert.equal(routeForModel("gpt-5.6-luna")?.provider, "codex");
  assert.equal(routeForModel("sonnet")?.provider, "claude");
  assert.equal(routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(routeForModel("gemini-3.8-flash-medium")?.provider, "antigravity");
  assert.equal(routeForModel("unknown-model"), null);
});

test("resolves role aliases through tier-specific randomized provider groups with smart model fallback", () => {
  assert.equal(roleForModel("autodev/explorer"), "explorer");

  const explorerCandidates = roleCandidates("explorer", () => 0.5);
  const explorerProviders = explorerCandidates.map((c) => c.provider);
  assert.deepEqual(explorerProviders.slice(0, 3).sort(), [ "antigravity", "claude", "minimax" ]);
  assert.deepEqual(explorerProviders.slice(3), [ "copilot", "codex" ]);

  const smartCandidates = roleCandidates("smart", () => 0.5);
  const smartProviders = smartCandidates.map((c) => c.provider);
  assert.deepEqual(smartProviders.slice(0, 2).sort(), [ "antigravity", "claude" ]);
  assert.deepEqual(smartProviders.slice(2), [ "codex" ]);

  const smartModelMap = Object.fromEntries(smartCandidates.map((c) => [ c.provider, c.model ]));
  assert.equal(smartModelMap.antigravity, "gemini-3.8-flash-high");
  assert.equal(smartModelMap.claude, "claude-opus-5");
  assert.equal(smartModelMap.codex, "gpt-5.6-sol");

  assert.notDeepEqual(
    roleCandidates("smart", () => 0).slice(0, 2).map((candidate) => candidate.provider),
    roleCandidates("smart", () => 0.999).slice(0, 2).map((candidate) => candidate.provider),
  );
});

test("classifies provider exhaustion and transient responses for fallback", () => {
  assert.equal(fallbackable(429, "session limit reached"), true);
  assert.equal(fallbackable(503, "unavailable"), true);
  assert.equal(fallbackable(400, "provider usage limit reached"), true);
  assert.equal(fallbackable(400, "Invalid model name passed in model=gemini-3.8-flash-high"), true);
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

test("backs off repeatedly failing providers and moves them behind healthy peers", () => {
  resetRouterTelemetry();
  activeProviderRequests.clear();
  try {
    const first = cooldownProvider("claude", 1_000);
    const second = cooldownProvider("claude", 1_000);
    assert.equal(first.durationMs, 30_000);
    assert.equal(second.durationMs, 60_000);
    assert.equal(nextProviderRetryMs([ "claude", "minimax" ], 1_000), 60_000);

    const providers = roleCandidates("default", () => 0.5).map(({ provider }) => provider);
    assert.ok(providers.indexOf("claude") > providers.indexOf("antigravity"));
    assert.ok(providers.indexOf("claude") > providers.indexOf("minimax"));
  } finally {
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("reroutes a role request after a provider returns a fallbackable failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    CODEX_ROUTER_COPILOT_API_KEY: process.env.CODEX_ROUTER_COPILOT_API_KEY,
  };
  let responseCalls = 0;
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  process.env.CODEX_ROUTER_COPILOT_API_KEY = "test-provider-key";
  activeProviderRequests.clear();
  clearProviderCooldown("claude");
  clearProviderCooldown("antigravity");
  clearProviderCooldown("minimax");
  activeProviderRequests.set("antigravity", 1);
  activeProviderRequests.set("minimax", 2);
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("ok", { status: 200 });
    }
    if (target.endsWith("/responses")) {
      responseCalls += 1;
      if (responseCalls === 1) return new Response(JSON.stringify({ error: "provider throttled" }), { status: 429 });
      return new Response(JSON.stringify({ id: "fallback-response", model: "gemini-3.8-flash-medium", output_text: "fallback ok" }), {
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
      headers: { "content-type": "application/json", "x-codex-session-id": "fallback-test" },
      body: JSON.stringify({ model: "autodev/default", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "antigravity");
    assert.equal(responseCalls, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[ key ];
      else process.env[ key ] = value;
    }
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("orchestrator alias falls back to another provider when the primary is unavailable and stays attributed to the orchestrator origin", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  };
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  for (const provider of [ "codex", "claude", "antigravity", "minimax" ]) clearProviderCooldown(provider);
  let orchestratorResponseProvider = null;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    // The primary provider (chatgpt.com Codex backend) is out of usage.
    if (target.startsWith("https://chatgpt.com/")) {
      return new Response(JSON.stringify({ error: "You have hit your usage limit" }), { status: 429 });
    }
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("ok", { status: 200 });
    }
    if (target.endsWith("/responses")) {
      orchestratorResponseProvider = target;
      return new Response(JSON.stringify({ id: "orchestrator-fallback", model: "fallback", output_text: "ok" }), {
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
      headers: { "content-type": "application/json", "x-codex-session-id": "orchestrator-test" },
      body: JSON.stringify({ model: "autodev/orchestrator", stream: false, reasoning: { effort: "xhigh" } }),
    });
    assert.equal(response.status, 200);
    const servingProvider = response.headers.get("x-autodev-provider");
    assert.ok([ "claude", "minimax", "antigravity" ].includes(servingProvider), `expected a fallback-group provider, got ${servingProvider}`);
    assert.notEqual(response.headers.get("x-autodev-model"), "autodev/orchestrator");
    assert.ok(orchestratorResponseProvider && !orchestratorResponseProvider.startsWith("https://chatgpt.com/"));

    const usage = getRouterStatus().usage;
    assert.equal(usage.byOrigin.orchestrator.successes, 1, "fallback traffic is still attributed to the orchestrator origin");
    assert.equal(usage.byOrigin.subagent?.successes ?? 0, 0, "the orchestrator must not consume a subagent slot");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[ key ];
      else process.env[ key ] = value;
    }
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("reports the earliest provider retry time when every role candidate is cooling down", async () => {
  resetRouterTelemetry();
  const cooldownStartedAt = Date.now();
  for (const provider of [ "claude", "antigravity", "minimax", "copilot", "codex" ]) cooldownProvider(provider, cooldownStartedAt);
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": "cooldown-test" },
      body: JSON.stringify({ model: "autodev/default", stream: false }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.match((await response.json()).error.message, /Retry after approximately 30s/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetRouterTelemetry();
  }
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
  assert.equal(classifyProviderFailure(400, "provider usage limit reached"), "quota_exhausted");
  assert.equal(classifyProviderFailure(401, "unauthorized"), "authentication");
  assert.equal(classifyProviderFailure(400, "malformed request"), "request_error");
});

test("router flattens outbound tools and rewrites inbound tool namespaces in SSE events", () => {
  const tools = [
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [
        { type: "function", name: "spawn_agent", description: "Spawn child agent" }
      ]
    },
    {
      type: "function",
      namespace: "collaboration",
      name: "send_message"
    },
    {
      type: "function",
      name: "read_file"
    }
  ];
  const flattened = flattenOutboundTools(tools);
  assert.deepEqual(flattened, [
    { type: "function", name: "multi_agent_v1__spawn_agent", description: "Spawn child agent" },
    { type: "function", name: "collaboration__send_message" },
    { type: "function", name: "read_file" }
  ]);

  const rewritten = rewriteToolNamespaces({
    output: [
      { name: "multi_agent_v1__spawn_agent", type: "function_call" },
      { name: "collaboration__send_message", type: "function_call" },
      { name: "read_file", type: "function_call" }
    ]
  });
  assert.deepEqual(rewritten.output, [
    { name: "spawn_agent", namespace: "multi_agent_v1", type: "function_call" },
    { name: "send_message", namespace: "collaboration", type: "function_call" },
    { name: "read_file", type: "function_call" }
  ]);

  const sseEvent = 'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"multi_agent_v1__spawn_agent"}}\n\n';
  const transformed = transformSseEvent(sseEvent, "autodev/orchestrator");
  assert.match(transformed, /"namespace":"multi_agent_v1"/);
  assert.match(transformed, /"name":"spawn_agent"/);
});

test("only bridges that spawn inside their own runtime are told what to report", () => {
  const forAntigravity = bridgeTelemetryHeaders({ provider: "antigravity" }, "request-1");
  assert.deepEqual(forAntigravity, {
    [ "x-autodev-request-id" ]: "request-1",
    [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent",
    [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:4100${AGENT_EVENTS_PATH}`,
  });
  assert.equal(bridgeTelemetryHeaders({ provider: "claude" }, "request-1")[ SUBAGENT_SPAWN_TOOLS_HEADER ], "Agent,Task");
  // Codex and MiniMax spawn through the router's own role aliases, so the
  // router already sees those children and asks for no report. Copilot cannot
  // spawn at all.
  for (const provider of [ "codex", "minimax", "copilot" ]) {
    assert.deepEqual(bridgeTelemetryHeaders({ provider }, "request-1"), {}, provider);
  }
  // Without a request id there is nothing to correlate a report against.
  assert.deepEqual(bridgeTelemetryHeaders({ provider: "claude" }, null), {});
});

test("subagent telemetry counts both spawn mechanisms and attributes each to a provider", () => {
  resetSubagentTelemetry();
  try {
    // A CLI bridge reports what its own runtime spawned; the router resolves
    // the provider from the request the bridge was serving.
    noteBridgeRequest("request-1", { provider: "claude", model: "claude-opus-5", role: null, workspace: "AutoDev" });
    const accepted = ingestAgentEvents({
      requestId: "request-1",
      events: [
        { type: "subagent_spawn", tool: "Agent", role: "explorer" },
        { type: "subagent_spawn", tool: "Agent", role: "worker", count: 2 },
        { type: "not_a_spawn" },
      ],
    });
    assert.deepEqual(accepted, { accepted: 3, rejected: 0, reason: null });

    // A router-routed spawn is attributed to whichever provider ran the parent
    // orchestrator turn for that session.
    noteOrchestratorSession("session-a", "minimax");
    recordSubagentSpawn({ mechanism: "router_alias", provider: orchestratorProviderForSession("session-a"), role: "validator", tool: "multi_agent_v1.spawn" });
    // Callers that supply no session id all share one bucket, so that key is
    // never joined: it would credit an unrelated caller's parent turn.
    noteOrchestratorSession("process-scope", "claude");
    assert.equal(orchestratorProviderForSession("process-scope"), null);
    assert.equal(orchestratorProviderForSession("session-never-seen"), null);

    const status = subagentStatus();
    assert.equal(status.total, 4);
    assert.deepEqual(status.byMechanism, { router_alias: 1, bridge_native: 3 });
    assert.deepEqual(status.byProvider, { claude: 3, minimax: 1 });
    assert.deepEqual(status.byRole, { explorer: 1, worker: 2, validator: 1 });
    assert.deepEqual(status.spawnCapableProviders, [ "antigravity", "claude", "minimax", "codex" ]);
    assert.equal(status.recent[ 0 ].role, "validator", "the recent list is newest first");
    assert.equal(status.recent.at(-1).provider, "claude");

    // The request id is the only credential a report carries, so an unknown one
    // is counted nowhere.
    assert.deepEqual(
      ingestAgentEvents({ requestId: "never-issued", events: [ { type: "subagent_spawn", tool: "Agent" } ] }),
      { accepted: 0, rejected: 1, reason: "unknown_request_id" },
    );
    assert.equal(subagentStatus().total, 4);
    assert.equal(recordSubagentSpawn({ mechanism: "made_up" }), null);
    assert.equal(subagentStatus().total, 4);
  } finally {
    resetSubagentTelemetry();
  }
});

test("the router accepts a bridge spawn report over /v1/agent-events", async () => {
  resetSubagentTelemetry();
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    noteBridgeRequest("request-live", { provider: "antigravity", model: "gemini-3.8-flash-high", role: null, workspace: "AutoDev" });
    const post = (body) => fetch(`${base}${AGENT_EVENTS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const accepted = await post({ requestId: "request-live", events: [ { type: "subagent_spawn", tool: "invoke_subagent" } ] });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { accepted: 1, rejected: 0, reason: null });

    const unknown = await post({ requestId: "request-missing", events: [ { type: "subagent_spawn", tool: "invoke_subagent" } ] });
    assert.equal(unknown.status, 404);

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.subagents.total, 1);
    assert.deepEqual(status.subagents.byProvider, { antigravity: 1 });
    assert.equal(status.subagents.recent[ 0 ].tool, "invoke_subagent");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetSubagentTelemetry();
  }
});

test("an Antigravity batch spawn reaches the router as one count per child", async () => {
  // End to end over the real pieces: the reporter the bridge builds from the
  // router's own headers, an agy step update shaped the way the CLI recorded
  // the delegation that exposed this, and the router's live endpoint. A
  // twelve-way fan-out used to arrive as a single roleless `antigravity/null`.
  resetSubagentTelemetry();
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    noteBridgeRequest("request-batch", { provider: "antigravity", model: "gemini-3.8-flash-high", role: null, workspace: "SimulatorLife/RacingGame" });
    const reporter = resolveAgentEventReporter({
      ...bridgeTelemetryHeaders({ provider: "antigravity" }, "request-batch"),
      [ AGENT_EVENTS_URL_HEADER ]: `${base}${AGENT_EVENTS_PATH}`,
    });
    const stepUpdate = {
      step_index: 3,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: {
        name: "invoke_subagent",
        args: JSON.stringify({
          Subagents: [
            { TypeName: "explorer", Model: "inherit", Prompt: "Catalog every build error" },
            { TypeName: "explorer", Model: "inherit", Prompt: "Catalog every lint error" },
            { TypeName: "validator", Model: "inherit", Prompt: "Re-run the suites" },
          ],
        }),
      },
    };
    assert.equal(reporter.isSpawnTool(stepUpdate.tool_name), true);
    await reporter.reportSpawns({ tool: stepUpdate.tool_name, children: spawnedChildren(stepUpdate) });

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.subagents.total, 3);
    assert.deepEqual(status.subagents.byProvider, { antigravity: 3 });
    assert.deepEqual(status.subagents.byRole, { explorer: 2, validator: 1 });
    assert.deepEqual(status.subagents.byMechanism, { router_alias: 0, bridge_native: 3 });
    for (const spawn of status.subagents.recent) {
      assert.equal(spawn.tool, "invoke_subagent");
      assert.equal(spawn.workspace, "SimulatorLife/RacingGame");
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetSubagentTelemetry();
  }
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

test("resolveTurnMetadataHeader prefers the canonical header and falls back to embedded client_metadata", () => {
  const rawJson = JSON.stringify({ workspaces: { main: "/tmp/ws" } });
  assert.equal(
    resolveTurnMetadataHeader({ headers: { "x-codex-turn-metadata": rawJson } }, {}),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader({ headers: { "x-codex-turn-metadata": [ rawJson ] } }, {}),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader({ headers: {} }, { client_metadata: { "x-codex-turn-metadata": rawJson } }),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader({ headers: {} }, { client_metadata: { "x-codex-turn-metadata": { workspaces: { main: "/tmp/ws" } } } }),
    JSON.stringify({ workspaces: { main: "/tmp/ws" } })
  );
  assert.equal(resolveTurnMetadataHeader({ headers: { "x-codex-turn-metadata": "not json" } }, {}), null);
  assert.equal(resolveTurnMetadataHeader({ headers: {} }, {}), null);
  assert.equal(parseTurnMetadataJson("[]"), null);
  assert.equal(parseTurnMetadataJson(rawJson).workspaces.main, "/tmp/ws");
});

test("derives a privacy-safe repository and cwd label from turn metadata", () => {
  const context = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspaces: {
        "/Users/henrykirk/Desktop/RacingGame": {
          associated_remote_urls: { origin: "https://github.com/SimulatorLife/RacingGame.git" },
        },
      },
    }),
  );
  assert.deepEqual(context, { key: "SimulatorLife/RacingGame", cwd: "RacingGame" });
  assert.equal(JSON.stringify(context).includes("/Users/henrykirk"), false);
});

test("records workspace usage with role, provider, and model dimensions", () => {
  resetRouterTelemetry();
  recordRouterEvent({
    phase: "selected",
    requestId: "workspace-metric",
    role: "worker",
    requestedModel: "autodev/worker",
    provider: "claude",
    model: "sonnet",
    workspace: { key: "SimulatorLife/RacingGame", cwd: "RacingGame" },
  });
  recordRouterEvent({
    phase: "result",
    requestId: "workspace-metric",
    role: "worker",
    requestedModel: "autodev/worker",
    provider: "claude",
    model: "sonnet",
    workspace: { key: "SimulatorLife/RacingGame", cwd: "RacingGame" },
    outcome: "success",
    status: 200,
    elapsedMs: 12,
    toolCalls: 2,
  });
  const workspace = getRouterStatus().usage.byWorkspace[ "SimulatorLife/RacingGame" ];
  assert.equal(workspace.cwd, "RacingGame");
  assert.equal(workspace.attempts, 1);
  assert.equal(workspace.successes, 1);
  assert.equal(workspace.byRole.worker.successes, 1);
  assert.equal(workspace.byModel[ "claude/sonnet" ].toolCalls, 2);
  assert.equal(workspace.byProvider.claude.successes, 1);
  resetRouterTelemetry();
});

test("persists workspace usage dimensions across router restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-workspace-usage-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    const workspace = { key: "SimulatorLife/RacingGame", cwd: "RacingGame" };
    recordRouterEvent({ phase: "selected", requestId: "workspace-persist", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3", workspace });
    recordRouterEvent({ phase: "result", requestId: "workspace-persist", role: "worker", requestedModel: "autodev/worker", provider: "minimax", model: "MiniMax-M3", workspace, outcome: "success", status: 200, elapsedMs: 7 });
    await persistRouterStateNow(stateFile);
    resetRouterTelemetry();
    assert.equal(loadRouterState(stateFile), true);
    const restored = getRouterStatus().usage.byWorkspace[ "SimulatorLife/RacingGame" ];
    assert.equal(restored.cwd, "RacingGame");
    assert.equal(restored.byModel[ "minimax/MiniMax-M3" ].successes, 1);
    assert.equal(restored.byProvider.minimax.successes, 1);
  } finally {
    resetRouterTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("downstreamHeaders forwards only the allowlisted turn-metadata header and never a client-supplied credential", () => {
  assert.deepEqual([ ...FORWARDED_REQUEST_HEADERS ], [ "x-codex-turn-metadata" ]);
  const route = { provider: "claude", envKey: "LITELLM_API_KEY" };
  const withoutTurnMetadata = downstreamHeaders(route, null, null);
  assert.equal(withoutTurnMetadata[ "x-codex-turn-metadata" ], undefined);
  const withTurnMetadata = downstreamHeaders(route, null, "{\"workspaces\":{}}");
  assert.equal(withTurnMetadata[ "x-codex-turn-metadata" ], "{\"workspaces\":{}}");
  assert.notEqual(withTurnMetadata.authorization, "Bearer client-supplied-secret");
});

test("downstreamHeaders names the agent role the router assigned, and omits it when there is none", () => {
  const route = { provider: "claude", envKey: "LITELLM_API_KEY" };
  assert.equal(downstreamHeaders(route, null, null)[ AGENT_ROLE_HEADER ], undefined);
  assert.equal(downstreamHeaders(route, null, null, ORCHESTRATOR_AGENT_ROLE)[ AGENT_ROLE_HEADER ], "orchestrator");
  assert.equal(downstreamHeaders(route, null, null, "explorer")[ AGENT_ROLE_HEADER ], "explorer");
});

test("downstreamHeaders forces a fresh connection per request to the codex route to avoid reusing a stale pooled keep-alive socket", () => {
  const codexHeaders = downstreamHeaders({ provider: "codex", envKey: null }, { token: "t", accountId: "a" }, null);
  assert.equal(codexHeaders.connection, "close", "codex requests must never be served from a pooled keep-alive connection");
});

test("downstreamHeaders leaves keep-alive pooling untouched for other providers", () => {
  for (const route of [ { provider: "claude", envKey: "LITELLM_API_KEY" }, { provider: "minimax", envKey: "MINIMAX_API_KEY" }, { provider: "antigravity", envKey: "LITELLM_API_KEY" }, { provider: "copilot", envKey: "CODEX_ROUTER_COPILOT_API_KEY" } ]) {
    const headers = downstreamHeaders(route, null, null);
    assert.equal(headers.connection, undefined, `${route.provider} should keep reusing pooled connections`);
  }
});


test("forwards x-codex-turn-metadata to the upstream provider bridge without leaking the caller's own authorization", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders = null;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      upstreamHeaders = options.headers;
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
    // Codex's canonical turn metadata keys the workspaces map by absolute
    // repo/workspace path; values carry only git metadata. The router must
    // forward that exact JSON shape verbatim, with no reformatting.
    const turnMetadata = JSON.stringify({
      workspaces: { "/Users/henrykirk/AutoDev": { git: { branch: "main", sha: "abc123" } } },
    });
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-supplied-secret",
        "x-codex-turn-metadata": turnMetadata,
      },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[ "x-codex-turn-metadata" ], turnMetadata);
    assert.notEqual(upstreamHeaders.authorization, "Bearer client-supplied-secret");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("relays the canonical workspaces-map-keyed turn metadata even when it arrives only as embedded client_metadata", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders = null;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      upstreamHeaders = options.headers;
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
    // Callers that cannot set custom headers embed the same canonical shape
    // under client_metadata["x-codex-turn-metadata"]; the router must
    // normalize that back into the canonical header before forwarding.
    const canonical = {
      workspaces: { "/Users/henrykirk/AutoDev": { git: { branch: "main" } } },
    };
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", stream: false, client_metadata: { "x-codex-turn-metadata": canonical } }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[ "x-codex-turn-metadata" ], JSON.stringify(canonical));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("sends the router's own headers to the Antigravity adapter and discards the caller's", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders = null;
  let upstreamPayload = null;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4002/v1/responses") {
      upstreamHeaders = options.headers;
      upstreamPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "antigravity-response", model: "gemini-3.8-flash-medium", output_text: "ok" }), {
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
    const turnMetadata = JSON.stringify({
      workspaces: { "/Users/henrykirk/AutoDev": { git: { branch: "main" } } },
    });
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": turnMetadata },
      body: JSON.stringify({
        model: "gemini-3.8-flash-medium",
        stream: false,
        extra_headers: { authorization: "Bearer caller-secret", "x-untrusted": "should-not-forward" },
      }),
    });
    assert.equal(response.status, 200);

    // These used to ride in the Responses body because the LiteLLM hop dropped
    // raw headers. The router calls the adapter directly now, so they are
    // ordinary request headers.
    assert.equal(upstreamHeaders[ "x-codex-turn-metadata" ], turnMetadata);
    assert.equal(upstreamHeaders[ "x-autodev-subagent-spawn-tools" ], "invoke_subagent");
    assert.ok(upstreamHeaders[ "x-autodev-request-id" ]);
    assert.ok(upstreamHeaders[ "x-autodev-agent-events-url" ]);

    // `extra_headers` is a caller-supplied escape hatch that would bypass the
    // router's credential and header allowlist, so it is dropped outright and
    // never rebuilt.
    assert.equal(Object.hasOwn(upstreamPayload, "extra_headers"), false);
    assert.notEqual(upstreamHeaders.authorization, "Bearer caller-secret");
    assert.equal(upstreamHeaders[ "x-untrusted" ], undefined);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("turns a provider stream that ends before completion into an explicit failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response('event: response.output_text.delta\\ndata: {"type":"response.output_text.delta","delta":"partial"}\\n\\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /partial/);
    assert.match(body, /response\.failed/);
    assert.match(body, /closed the stream before response\.completed/);
    assert.equal(getRouterStatus().providers.claude.failures > 0, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("does not classify an explicitly incomplete response as a successful turn", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response('event: response.completed\\ndata: {"type":"response.completed","response":{"status":"incomplete","output_text":"partial"}}\\n\\ndata: [DONE]\\n\\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet" }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(getRouterStatus().providers.claude.failures > 0, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("rejects missing or malformed models before provider routing", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    for (const body of [ null, {}, { model: "" }, { model: "  " }, { model: 42 } ]) {
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
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  ingestOtelSignal("logs", {
    resourceLogs: [ {
      resource: { attributes: attributes([ [ "mcp_servers", "playwright, codex_apps, node_repl" ] ]) },
      scopeLogs: [ {
        logRecords: [
          { attributes: attributes([ [ "event.name", "codex.conversation_starts" ], [ "conversation.id", "conversation-otel" ], [ "model", "gpt-5.6-luna" ] ]) },
          { attributes: attributes([ [ "event.name", "codex.user_prompt" ], [ "conversation.id", "conversation-otel" ], [ "prompt_length", 42 ], [ "prompt_text", "do-not-store-this" ] ]) },
          { attributes: attributes([ [ "event.name", "codex.turn_ttft" ], [ "conversation.id", "conversation-otel" ], [ "duration_ms", 321 ] ]) },
          { attributes: attributes([ [ "event.name", "codex.sse_event" ], [ "event.kind", "response.completed" ], [ "conversation.id", "conversation-otel" ], [ "input_token_count", 100 ], [ "output_token_count", 25 ], [ "cached_token_count", 5 ], [ "reasoning_token_count", 10 ], [ "tool_token_count", 3 ] ]) },
        ]
      } ],
    } ],
  });
  const span = (name, serverName, durationNs = 5_000_000n) => ({
    name,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + durationNs),
    attributes: attributes([ [ "server_name", serverName ] ]),
    status: { code: 1 },
  });
  ingestOtelSignal("traces", {
    resourceSpans: [ {
      scopeSpans: [ {
        spans: [
          span("make_rmcp_client", "playwright"),
          span("list_tools_for_client_uncached", "playwright", 7_000_000n),
          span("make_rmcp_client", "node_repl", 2_000_000n),
        ]
      } ]
    } ],
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
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const skillSum = (skill, status, value, timeOffsetNs, extraAttributes = []) => ({
    name: "codex.skill.injected",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [ {
        attributes: attributes([ [ "skill", skill ], [ "status", status ], ...extraAttributes ]),
        startTimeUnixNano: String(start),
        timeUnixNano: String(start + timeOffsetNs),
        asInt: String(value),
      } ],
    },
  });
  const threadHistogram = (name, count, sum, timeOffsetNs, extraAttributes = []) => ({
    name,
    histogram: {
      aggregationTemporality: 2,
      dataPoints: [ {
        attributes: attributes(extraAttributes),
        startTimeUnixNano: String(start),
        timeUnixNano: String(start + timeOffsetNs),
        count: String(count),
        sum,
      } ],
    },
  });
  const resourceMetrics = (metrics) => ({ resourceMetrics: [ { resource: { attributes: [] }, scopeMetrics: [ { metrics } ] } ] });

  // First export: injected=3, skipped(invoke_type=auto)=1, one thread reporting 3 enabled/2 kept, 1 truncated with 120 chars trimmed.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
    skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [ [ "invoke_type", "auto" ] ]),
    threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
    threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
    threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
    threadHistogram("codex.thread.skills.description_truncated_chars", 1, 120, 1_000_000n),
  ]));
  // Exporter retry resending the identical cumulative point must not double count.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
    skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [ [ "invoke_type", "auto" ] ]),
    threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
    threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
    threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
    threadHistogram("codex.thread.skills.description_truncated_chars", 1, 120, 1_000_000n),
  ]));
  // Later export with cumulative growth: only the deltas should be applied.
  ingestOtelSignal("metrics", resourceMetrics([
    skillSum("lsp-mcp-server", "injected", 5, 2_000_000n),
    skillSum("lsp-mcp-server", "skipped", 2, 2_000_000n, [ [ "invoke_type", "auto" ] ]),
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
  assert.deepEqual(skill.byInvokeType, { auto: 2 });

  assert.deepEqual(telemetry.skills.threads.enabledTotal, { count: 2, sum: 7, average: 3.5 });
  assert.deepEqual(telemetry.skills.threads.keptTotal, { count: 2, sum: 4, average: 2 });
  assert.equal(telemetry.skills.threads.truncated.count, 2);
  assert.equal(telemetry.skills.threads.truncated.sum, 2);
  assert.deepEqual(telemetry.skills.threads.descriptionTruncatedChars, { count: 2, sum: 190, average: 95 });
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  resetOtelTelemetry();
});

test("groups skill injections by agent kind, model, and plugin metadata", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const skillPoint = (skill, invokeType, value) => ({
    attributes: attributes([ [ "skill", skill ], [ "status", "ok" ], [ "invoke_type", invokeType ] ]),
    startTimeUnixNano: "1",
    timeUnixNano: "2",
    asInt: String(value),
  });
  const resourceMetric = (resourceEntries, point) => ({
    resource: { attributes: attributes(resourceEntries) },
    scopeMetrics: [ { metrics: [ { name: "codex.skill.injected", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [ point ] } } ] } ],
  });

  ingestOtelSignal("metrics", {
    resourceMetrics: [
      resourceMetric([ [ "session_source", "cli" ], [ "model_slug", "gpt-root" ], [ "plugin_id", "plugin-root" ] ], skillPoint("orchestration", "explicit", 2)),
      resourceMetric([ [ "session_source", "subagent_thread_spawn_parent_d1" ], [ "model_slug", "gpt-child" ], [ "plugin_id", "plugin-child" ] ], skillPoint("orchestration", "implicit", 3)),
    ],
  });

  const skill = codexTelemetryStatus().skills.injected;
  assert.deepEqual(skill.byInvokeType, { explicit: 2, implicit: 3 });
  assert.deepEqual(skill.byAgentKind, { root: 2, subagent: 3 });
  assert.deepEqual(skill.byModel, { "gpt-root": 2, "gpt-child": 3 });
  assert.deepEqual(skill.byPlugin, { "plugin-root": 2, "plugin-child": 3 });
  const orchestration = skill.bySkill[ 0 ];
  assert.deepEqual(orchestration.byAgentKind, { root: 2, subagent: 3 });
  assert.deepEqual(orchestration.byModel, { "gpt-root": 2, "gpt-child": 3 });
  assert.deepEqual(orchestration.byPlugin, { "plugin-root": 2, "plugin-child": 3 });
  resetOtelTelemetry();
});

test("tracks shadow selection invocations separately from context injections", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const invocation = (value, time) => ({
    name: "codex.skills.shadow_selection.invocation",
    sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [ { attributes: attributes([ [ "skill", "orchestration" ], [ "status", "ok" ], [ "invoke_type", "implicit" ] ]), startTimeUnixNano: "1", timeUnixNano: String(time), asInt: String(value) } ] },
  });
  const histogram = (name, count, sum, time) => ({
    name,
    histogram: { aggregationTemporality: 2, dataPoints: [ { attributes: [], startTimeUnixNano: "1", timeUnixNano: String(time), count: String(count), sum } ] },
  });
  const ingest = (metrics) => ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics } ] } ] });

  ingest([ invocation(1, 10), histogram("codex.skills.shadow_selection.catalog_entries", 1, 8, 10) ]);
  ingest([ invocation(3, 20), histogram("codex.skills.shadow_selection.catalog_entries", 2, 15, 20) ]);

  const skills = codexTelemetryStatus().skills;
  assert.equal(skills.injected.total, 0);
  assert.equal(skills.usage.total, 3);
  assert.deepEqual(skills.usage.byInvokeType, { implicit: 3 });
  assert.deepEqual(skills.usage.bySkill[ 0 ], { skill: "orchestration", total: 3, byStatus: { ok: 3 }, byInvokeType: { implicit: 3 }, byAgentKind: { unknown: 3 }, byModel: { unknown: 3 }, byPlugin: { none: 3 } });
  assert.deepEqual(skills.selection.catalogEntries, { count: 2, sum: 15, average: 7.5 });
  resetOtelTelemetry();
});

test("counts delta-temporality skill metrics once per export", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const metric = (name, value, timeUnixNano, kind = "sum") => ({
    name,
    [ kind ]: {
      aggregationTemporality: 1,
      ...(kind === "sum" ? { isMonotonic: true } : {}),
      dataPoints: [ { attributes: attributes([ [ "skill", "orchestration" ], [ "status", "ok" ] ]), timeUnixNano: String(timeUnixNano), ...(kind === "sum" ? { asInt: String(value) } : { count: "1", sum: value }) } ],
    },
  });
  const ingest = (metrics) => ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics } ] } ] });
  ingest([ metric("codex.skill.injected", 2, 10), metric("codex.thread.skills.enabled_total", 1, 10, "histogram") ]);
  ingest([ metric("codex.skill.injected", 3, 20), metric("codex.thread.skills.enabled_total", 1, 20, "histogram") ]);
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.skills.injected.total, 5);
  assert.equal(telemetry.skills.threads.enabledTotal.count, 2);
  assert.equal(telemetry.skills.threads.enabledTotal.sum, 2);
  resetOtelTelemetry();
});

test("inventories native metrics and aggregates safe SQLite and tool telemetry", () => {
  resetOtelTelemetry();
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const dataPoint = (entries, value, time = "100") => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: time, asInt: String(value) });
  const histogramPoint = (entries, count, sum, time = "100") => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: time, count: String(count), sum });
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [
          { name: "codex.sqlite.init.count", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "db", "logs" ], [ "status", "success" ] ], 2) ] } },
          { name: "codex.sqlite.init.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [ histogramPoint([ [ "db", "logs" ], [ "status", "success" ] ], 2, 40) ] } },
          { name: "codex.sqlite.fallback.count", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "db", "memories" ], [ "status", "locked" ] ], 1) ] } },
          { name: "codex.tool.call", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "tool_name", "exec" ], [ "source", "builtin" ], [ "status", "ok" ], [ "arguments", "/private/path" ] ], 3) ] } },
          { name: "codex.tool.call.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [ histogramPoint([ [ "tool_name", "exec" ], [ "source", "builtin" ] ], 3, 90) ] } },
          { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "hook_name", "SessionStart" ], [ "hook_source", "user" ], [ "handler_type", "command" ], [ "status", "ok" ] ], 2) ] } },
          { name: "codex.hooks.run.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [ histogramPoint([ [ "hook_name", "SessionStart" ], [ "hook_source", "user" ], [ "handler_type", "command" ] ], 2, 20) ] } },
          { name: "codex.thread.started", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "source", "subagent" ] ], 4) ] } },
          { name: "codex.multi_agent.spawn", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "agent_role", "worker" ], [ "requested_model", "autodev/worker" ], [ "status", "ok" ] ], 1) ] } },
        ]
      } ]
    } ]
  });

  const telemetry = codexTelemetryStatus();
  assert.deepEqual(telemetry.sqlite.init.byDbStatus, [ { db: "logs", status: "success", count: 2 } ]);
  assert.equal(telemetry.sqlite.init.total, 2);
  assert.deepEqual(telemetry.sqlite.initDurationMs.byDbStatus, [ { db: "logs", status: "success", count: 2, sum: 40, average: 20 } ]);
  assert.equal(telemetry.sqlite.fallbacks.total, 1);
  const tool = telemetry.tools.byTool.find((entry) => entry.tool === "exec");
  assert.deepEqual(tool, { tool: "exec", source: "builtin", server: "", count: 3, byStatus: { ok: 3 }, durationCount: 3, durationMs: 90, averageDurationMs: 30 });
  assert.deepEqual(telemetry.hooks.byHook, [ { hook: "SessionStart", source: "user", handlerType: "command", count: 2, byStatus: { ok: 2 }, durationCount: 2, durationMs: 20, averageDurationMs: 10 } ]);
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
  const attributes = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, count) => ({ attributes: attributes(entries), startTimeUnixNano: "1", timeUnixNano: "2", count: String(count), sum: 0 });
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [
          { name: "codex.hooks.run", histogram: { aggregationTemporality: 1, dataPoints: [ point([ [ "hook_name", "SessionEnd" ], [ "hook_source", "user" ], [ "handler_type", "command" ], [ "status", "ok" ] ], 2) ] } },
          { name: "codex.thread.started", histogram: { aggregationTemporality: 1, dataPoints: [ point([ [ "source", "subagent" ] ], 3) ] } },
          { name: "codex.multi_agent.spawn", histogram: { aggregationTemporality: 1, dataPoints: [ point([ [ "agent_role", "worker" ], [ "requested_model", "autodev/worker" ], [ "status", "ok" ] ], 1) ] } },
        ]
      } ]
    } ]
  });
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.hooks.byHook[ 0 ].count, 2);
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
  assert.equal(failures.recent[ 0 ].requestId, "req-provider-failed");
  resetRouterTelemetry();
});

test("serves HTML only from /dashboard and raw JSON from /status", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type"), /text\/html/);
    const dashboardBody = (await dashboard.text()).replace(/\s+/g, " ").replace(/>\s+</g, "><");
    assert.match(dashboardBody, /setInterval\(refresh, 3000\)/);
    assert.match(dashboardBody, /id="usage-breakdown"/);
    assert.match(dashboardBody, /id="workspace-usage"/);
    assert.match(dashboardBody, /Usage by workspace/);
    assert.match(dashboardBody, /id="usage-total-attempts"/);
    assert.doesNotMatch(dashboardBody, /id="by-origin"/);
    assert.doesNotMatch(dashboardBody, /id="by-role"/);
    assert.doesNotMatch(dashboardBody, /id="by-model"/);
    assert.match(dashboardBody, /<th>Category<\/th>\s*<th>Active<\/th>\s*<th>Attempts<\/th>/);
    assert.match(dashboardBody, /const usageBreakdownRows = \(usage\)/);
    assert.match(dashboardBody, /byRole\.unattributed \?\? \{\}/);
    assert.match(dashboardBody, /class="toggle-usage" data-usage-group="subagents"/);
    assert.match(dashboardBody, /class="usage-child" data-usage-child="subagents"\$\{expanded \? "" : " hidden"\}/);
    assert.match(dashboardBody, /const expandedUsageGroups = new Set\(\);/);
    assert.match(dashboardBody, /role !== "unattributed"/);
    assert.match(dashboardBody, /usageRow\("Orchestrator", orchestrator\)/);
    assert.match(dashboardBody, /<code>Subagents<\/code>/);
    assert.match(dashboardBody, /Usage by orchestrator and subagents/);
    assert.match(dashboardBody, /aria-controls="provider-health-section" aria-expanded="true"/);
    assert.match(dashboardBody, /aria-controls="usage-section" aria-expanded="true"/);
    assert.doesNotMatch(dashboardBody, /<h2>By origin<\/h2>/);
    assert.doesNotMatch(dashboardBody, /<h2>By role<\/h2>/);
    assert.match(dashboardBody, /id="operational-summaries"/);
    assert.match(dashboardBody, /aria-controls="operational-summaries-section"\s*aria-expanded="false"/);
    assert.match(dashboardBody, /id="operational-summaries-section" hidden/);
    assert.match(dashboardBody, /summaryRow/);
    assert.match(dashboardBody, /Codex telemetry/);
    assert.match(dashboardBody, /State database/);
    assert.match(dashboardBody, /Concurrency/);
    assert.match(dashboardBody, /Category<\/th>\s*<th>Metric<\/th>\s*<th>Value<\/th>/);
    assert.match(dashboardBody, /id="mcp-telemetry-section"/);
    assert.match(dashboardBody, /aria-controls="mcp-telemetry-section" aria-expanded="true"/);
    assert.doesNotMatch(dashboardBody, /Codex telemetry<\/button>/);
    assert.match(dashboardBody, /id="mcp-telemetry"/);
    assert.match(dashboardBody, /id="mcp-total-init"/);
    assert.match(dashboardBody, /id="mcp-total-duration"/);
    assert.match(dashboardBody, /id="skills-section"/);
    assert.match(dashboardBody, /aria-controls="skills-section" aria-expanded="true"/);
    assert.match(dashboardBody, /id="skills-table"/);
    assert.match(dashboardBody, /<th>Totals<\/th>/);
    assert.match(dashboardBody, /id="skills-total"/);
    assert.match(dashboardBody, /id="skills-total-usage"/);
    assert.match(dashboardBody, /id="skills-total-usage-invoke-type"/);
    assert.match(dashboardBody, /id="skills-selection"/);
    assert.match(dashboardBody, /skillsUsage/);
    assert.match(dashboardBody, /shadow_selection\.invocation/);
    assert.match(dashboardBody, /id="skills-selection"/);
    assert.match(dashboardBody, /aria-controls="skills-selection-section" aria-expanded="true"/);
    assert.match(dashboardBody, /<th>Skill<\/th>\s*<th>Injected<\/th>\s*<th>Invocations<\/th>\s*<th>Injection share<\/th>\s*<th>Invocation share<\/th>\s*<th>By status<\/th>\s*<th>Injected by invoke type<\/th>\s*<th>Invoked by invoke type<\/th>/);
    assert.match(dashboardBody, /id="skills-histograms"/);
    assert.match(dashboardBody, /aria-controls="skills-selection-section" aria-expanded="true"/);
    assert.match(dashboardBody, /id="skills-selection-section"/);
    assert.match(dashboardBody, /id="skills-selection"/);
    assert.match(dashboardBody, /skillShare/);
    assert.match(dashboardBody, /histogramRow/);
    assert.match(dashboardBody, /description_truncated_chars/);
    assert.match(dashboardBody, /text\(key\)/);
    assert.match(dashboardBody, /byAgentKind/);
    assert.match(dashboardBody, /byModel/);
    assert.match(dashboardBody, /byPlugin/);
    assert.match(dashboardBody, /id="native-metrics"/);
    assert.match(dashboardBody, /id="native-metrics-summary"/);
    assert.match(dashboardBody, /id="native-metrics-total-exports"/);
    assert.match(dashboardBody, /id="native-metrics-total-points"/);
    assert.match(dashboardBody, /aria-controls="native-metrics-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="native-metrics-section" hidden/);
    assert.match(dashboardBody, /millisecondsText/);
    assert.match(dashboardBody, /id="hooks-section"/);
    assert.match(dashboardBody, /aria-controls="hooks-section" aria-expanded="true"/);
    assert.match(dashboardBody, /<span class="caret">▾<\/span> Hooks<\/button>/);
    assert.match(dashboardBody, /id="native-runtime-telemetry"/);
    assert.match(dashboardBody, /id="native-runtime-total-calls"/);
    assert.match(dashboardBody, /<td>Thread<\/td>/);
    assert.match(dashboardBody, /<td>Spawn<\/td>/);
    assert.match(dashboardBody, /threadSource/);
    assert.match(dashboardBody, /spawnSource/);
    assert.doesNotMatch(dashboardBody, /id="hooks-threads-summary"/);
    assert.doesNotMatch(dashboardBody, /codex\.skill\.injected/);
    assert.match(dashboardBody, /codex\.thread\.skills\.enabled_total/);
    assert.match(dashboardBody, /MCP ready/);
    assert.match(dashboardBody, /aria-controls="recent-routing-events-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="recent-routing-events-section" hidden/);
    assert.match(dashboardBody, /document\.querySelectorAll\("\.toggle-section"\)/);
    assert.doesNotMatch(dashboardBody, /id="spawn-failures"/);
    assert.match(dashboardBody, /<th>Reason \/ type<\/th>\s*<th>Count<\/th>\s*<th>Last observed<\/th>/);
    assert.match(dashboardBody, /id="spawn-failures-by-reason"/);
    assert.match(dashboardBody, /aria-controls="spawn-failures-section" aria-expanded="false"/);
    assert.match(dashboardBody, /id="spawn-failures-section" hidden/);
    assert.match(dashboardBody, /id="spawn-failures-total"/);
    assert.match(dashboardBody, /spawnFailureRows/);
    assert.match(dashboardBody, /latestByReason/);
    assert.match(dashboardBody, /processFallbackEnforcement/);
    assert.match(dashboardBody, /process-wide bucket/);
    assert.match(dashboardBody, /\[\s*"Concurrency", "Active sessions", concurrency\.activeSessions \?\? 0\s*\]/);
    assert.doesNotMatch(dashboardBody, /id="skills-summary"|id="sqlite-telemetry"|id="concurrency"/);
    assert.match(dashboardBody, /<tfoot>/);
    assert.match(dashboardBody, /class="provider-summary"/);
    assert.match(dashboardBody, /id="summary-attempts"/);
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
    assert.equal(Object.hasOwn(status, "codexTasks"), false);
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
    ingestOtelSignal("metrics", {
      resourceMetrics: [ {
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.skill.injected",
            sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "skill", value: { stringValue: "orchestration" } }, { key: "status", value: { stringValue: "ok" } }, { key: "invoke_type", value: { stringValue: "implicit" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "2" } ] },
          }, {
            name: "codex.skills.shadow_selection.invocation",
            sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "skill", value: { stringValue: "orchestration" } }, { key: "status", value: { stringValue: "ok" } }, { key: "invoke_type", value: { stringValue: "implicit" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "2" } ] },
          }, {
            name: "codex.hooks.run",
            sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "hook_name", value: { stringValue: "SessionStart" } }, { key: "hook_source", value: { stringValue: "user" } }, { key: "handler_type", value: { stringValue: "command" } }, { key: "status", value: { stringValue: "ok" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" } ] },
          }, {
            name: "codex.thread.started",
            sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "source", value: { stringValue: "subagent" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" } ] },
          } ]
        } ]
      } ]
    });
    await persistRouterStateNow(stateFile);
    resetRouterTelemetry();
    resetOtelTelemetry();
    assert.equal(getRouterStatus().providers.minimax.failures, 0);

    assert.equal(loadRouterState(stateFile), true);
    const restored = getRouterStatus();
    assert.equal(restored.providers.minimax.failures, 1);
    assert.equal(restored.providers.minimax.lastFailure.class, "throttled");
    assert.equal(restored.usage.byRole.worker.attempts, 1);
    assert.equal(restored.usage.byModel[ "minimax/MiniMax-M3" ].failures, 1);
    assert.equal(restored.usage.byOrigin.subagent.failures, 1);
    assert.equal(restored.recentEvents[ 0 ].requestId, "req-persist");
    assert.equal(restored.recentEvents[ 0 ].toolCalls, 0);
    assert.equal(restored.codexTelemetry.skills.injected.total, 2);
    assert.equal(restored.codexTelemetry.skills.usage.total, 2);
    assert.equal(restored.codexTelemetry.skills.usage.bySkill[ 0 ].skill, "orchestration");
    assert.equal(restored.codexTelemetry.skills.injected.bySkill[ 0 ].skill, "orchestration");
    assert.deepEqual(restored.codexTelemetry.skills.injected.bySkill[ 0 ].byInvokeType, { implicit: 2 });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byAgentKind, { unknown: 2 });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byModel, { unknown: 2 });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byPlugin, { none: 2 });
    assert.equal(restored.codexTelemetry.receiver.metrics, 1);
    assert.equal(restored.codexTelemetry.hooks.byHook[ 0 ].count, 1);
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
  const toolResponse = { output: [ { id: "call-1", type: "function_call" }, { id: "message-1", type: "message" } ] };
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
  assert.equal(usage.byModel[ "claude/sonnet" ].successes, 1);
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

  const roleEntries = Object.entries(usage.byRole).filter(([ role ]) => role !== "unattributed");
  const subagentTotal = roleEntries.reduce((total, [ , bucket ]) => ({
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
  recordRouterEvent({ phase: "selected", requestId: "req-active-2", requestedModel: "claude-opus-5", provider: "claude", model: "claude-opus-5" });
  let usage = getRouterStatus().usage;
  assert.equal(usage.byModel[ "claude/sonnet" ].active, 1);
  assert.equal(usage.byModel[ "claude/claude-opus-5" ].active, 1);
  // Parent Active = sum of visible children, per model, for this provider.
  const parentActive = usage.byModel[ "claude/sonnet" ].active + usage.byModel[ "claude/claude-opus-5" ].active;
  assert.equal(parentActive, 2);

  recordRouterEvent({ phase: "result", requestId: "req-active-1", requestedModel: "sonnet", provider: "claude", model: "sonnet", outcome: "success", status: 200, elapsedMs: 5 });
  usage = getRouterStatus().usage;
  assert.equal(usage.byModel[ "claude/sonnet" ].active, 0);
  assert.equal(usage.byModel[ "claude/claude-opus-5" ].active, 1);

  recordRouterEvent({ phase: "result", requestId: "req-active-2", requestedModel: "claude-opus-5", provider: "claude", model: "claude-opus-5", outcome: "success", status: 200, elapsedMs: 5 });
  assert.equal(getRouterStatus().usage.byModel[ "claude/claude-opus-5" ].active, 0);
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
  assert.equal(status.usage.byModel[ "claude/sonnet" ].failures, 1);
  assert.ok(status.usage.byModel[ "claude/sonnet" ].lastFailure);
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
  const configuredLimit = concurrencyStatus().effectivePerSessionLimit;
  assert.ok(Number.isInteger(configuredLimit) && configuredLimit > 0);
  for (let slot = 0; slot < configuredLimit; slot += 1) assert.equal(tryAcquireSubagentSlot("test-session"), null);
  assert.equal(tryAcquireSubagentSlot("test-session"), "max_concurrent_threads_per_session");
  recordConcurrencyDenial({ requestId: "req-denied", role: "worker", requestedModel: "autodev/worker", sessionScope: "identified", reason: "max_concurrent_threads_per_session" });
  const status = concurrencyStatus();
  assert.equal(status.maxConcurrentThreadsPerSession, configuredLimit);
  assert.equal(status.effectivePerSessionLimit, configuredLimit);
  assert.equal(Object.hasOwn(status, "maxThreads"), false);
  assert.equal(status.activeSubagentThreads, configuredLimit);
  assert.equal(status.activeSessions, 1);
  assert.equal(status.denials, 1);
  assert.equal(status.lastDenial.reason, "max_concurrent_threads_per_session");
  for (let slot = 0; slot < configuredLimit; slot += 1) releaseSubagentSlot("test-session");
  assert.equal(concurrencyStatus().activeSessions, 0);
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
  assert.deepEqual(
    requestSession({ headers: {} }, {}, JSON.stringify({ conversation_id: "sess-turn-metadata" })),
    { key: "sess-turn-metadata", scope: "identified" },
  );

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
    const configuredLimit = concurrencyStatus().effectivePerSessionLimit;
    for (let slot = 1; slot < configuredLimit; slot += 1) assert.equal(tryAcquireSubagentSlot("session-a"), null);
    assert.equal(tryAcquireSubagentSlot("session-a"), "max_concurrent_threads_per_session");
    for (let slot = 0; slot < configuredLimit; slot += 1) releaseSubagentSlot("session-a");
    releaseSubagentSlot("session-b");

    // Two requests that both fail to supply any session identity share the documented
    // process-wide fallback bucket and are capped together, even though nothing proves
    // they belong to the same logical Codex session -- this is the fail-safe behavior
    // called out in docs/provider-routing.md, not true per-session enforcement.
    const first = requestSession({ headers: {} }, {});
    const second = requestSession({ headers: {} }, {});
    assert.equal(first.key, PROCESS_FALLBACK_SESSION_KEY);
    assert.equal(second.key, PROCESS_FALLBACK_SESSION_KEY);
    const fallbackLimit = concurrencyStatus().effectivePerSessionLimit;
    for (let slot = 0; slot < fallbackLimit; slot += 1) assert.equal(tryAcquireSubagentSlot(first.key), null);
    assert.equal(concurrencyStatus().processFallbackActiveThreads, fallbackLimit);
    assert.equal(concurrencyStatus().processFallbackEnforcement, true);
    assert.equal(tryAcquireSubagentSlot(second.key), "max_concurrent_threads_per_session");
    for (let slot = 0; slot < fallbackLimit; slot += 1) releaseSubagentSlot(first.key);
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
  assert.equal(limited.recentEvents[ 0 ].phase, "result");
  assert.equal(limited.recentEvents[ 0 ].requestId, "req-status");
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
  assert.equal(response.output[ 0 ].content[ 0 ].text, "router-ok");
});


test("deduplicates catalog models and keeps role aliases visible", () => {
  const ids = catalogModelIds([ { slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-luna" } ], [ "autodev/explorer" ]);
  assert.deepEqual(ids, [ "gpt-5.6-luna", "autodev/explorer" ]);
});

test("rewrites the routed provider model back to the public role alias", () => {
  const value = replaceModelFields({ model: "gemini-3.8-flash-medium", nested: [ { model: "gemini-3.8-flash-medium" } ] }, "autodev/explorer");
  assert.deepEqual(value, { model: "autodev/explorer", nested: [ { model: "autodev/explorer" } ] });

  const event = transformSseEvent('data: {"type":"response.completed","response":{"model":"gemini-3.8-flash-medium"},"model":"gemini-3.8-flash-medium"}\n\n', "autodev/explorer");
  assert.match(event, /autodev\/explorer/);
  assert.equal((event.match(/autodev\/explorer/g) ?? []).length, 2);
});

test("uses the least-busy provider before starting another provider request", () => {
  activeProviderRequests.clear();
  incrementActiveRequests("claude");
  incrementActiveRequests("minimax");
  const candidates = roleCandidates("default", () => 0.5).map((candidate) => candidate.provider);
  assert.equal(candidates[ 0 ], "antigravity");
  assert.deepEqual(candidates.slice(3), [ "copilot", "codex" ]);
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
  assert.equal(providers[ 0 ], "minimax");
  assert.equal(providers[ 1 ], "antigravity");
  assert.equal(providers[ 2 ], "claude");

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
  assert.equal(response.output[ 0 ].content[ 0 ].text, "part1 part2");
});

test("structured router error body carries code, retryable, failure class, provider, model, request id, and router instance id", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 });
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-structured-error" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.type, "router_provider_unavailable");
    assert.equal(body.error.code, "router_provider_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.failureClass, "unavailable");
    assert.equal(body.error.provider, "claude");
    assert.equal(body.error.model, "sonnet");
    assert.equal(body.error.requestId, "req-structured-error");
    assert.equal(body.error.routerInstanceId, ROUTER_INSTANCE_ID);
    // Legacy message field remains so existing callers keep working.
    assert.match(body.error.message, /sonnet \(claude\) failed with HTTP 503/);
    assert.equal(responseCalls, 2); // 503 first attempt then 503 second attempt (single retry exhausted)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("wraps transport failures with actionable safe diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      const error = new Error("fetch failed");
      error.cause = { code: "ECONNRESET", syscall: "read" };
      throw error;
    }
    return originalFetch(url, options);
  };
  clearProviderCooldown("claude");
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-transport-error" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);
    const body = await response.json();
    assert.equal(body.error.code, "router_provider_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.requestId, "req-transport-error");
    assert.doesNotMatch(body.error.message, /ECONNRESET|fetch failed|127\.0\.0\.1|absolute|path/i);
    const transportEvents = getRouterStatus().recentEvents.filter((event) => event.phase === "transport_error" && event.requestId === "req-transport-error");
    assert.equal(transportEvents.length, 3, "all bounded transport attempts should be observable");
    assert.equal(transportEvents[ 0 ].errorCode, "ECONNRESET");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request survives two pre-response transport failures in a row before succeeding", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      if (responseCalls <= 2) {
        // Mirrors the pooled keep-alive connection getting recycled out from
        // under a reuse attempt: the write fails before any response exists.
        const error = new TypeError("fetch failed");
        error.cause = { code: responseCalls === 1 ? "UND_ERR_SOCKET" : "EPIPE", syscall: "write" };
        throw error;
      }
      return new Response(JSON.stringify({ id: "recovered", model: "sonnet", output_text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(url, options);
  };
  clearProviderCooldown("claude");
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-transport-recovers" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 200, "a request that only ever fails pre-response should recover within its retry budget");
    assert.equal(responseCalls, 3);
    const transportEvents = getRouterStatus().recentEvents.filter((event) => event.phase === "transport_error" && event.requestId === "req-transport-recovers");
    assert.equal(transportEvents.length, 2);
    assert.deepEqual(transportEvents.map((event) => event.errorCode).sort(), [ "EPIPE", "UND_ERR_SOCKET" ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("x-autodev-router-instance-id correlates every JSON response with the router instance id in the body", async () => {
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
    const success = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(success.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);
    const badRequest = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "  " }),
    });
    assert.equal(badRequest.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);
    const badBody = await badRequest.json();
    assert.equal(badBody.error.routerInstanceId, ROUTER_INSTANCE_ID);
    assert.equal(badBody.error.type, "invalid_request_error");
    assert.equal(badBody.error.code, "invalid_request_error");
    assert.equal(badBody.error.retryable, null);
    const status = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(status.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);
    assert.equal((await status.json()).routerInstanceId, ROUTER_INSTANCE_ID);
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(dashboard.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("direct concrete request retries once on HTTP 503 then succeeds without rerouting", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  const originalCooldown = process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
  const originalMax = process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = "10";
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = "20";
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      if (responseCalls === 1) return new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ id: "retry-result", model: "sonnet", output_text: "ok" }), {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-retry-503" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-retry-503");
    assert.equal(responseCalls, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request stops after the single bounded retry and surfaces a Retry-After with structured diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  const originalCooldown = process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
  const originalMax = process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = "10";
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = "20";
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      return new Response(JSON.stringify({ error: "still unavailable" }), { status: 503 });
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-bounded-retry" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 503);
    assert.equal(responseCalls, 2); // initial + exactly one retry, no further retries
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-bounded-retry");
    const retryAfter = Number(response.headers.get("retry-after"));
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, "Retry-After must indicate a positive cooldown window");
    const body = await response.json();
    assert.equal(body.error.code, "router_provider_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.failureClass, "unavailable");
    assert.equal(body.error.provider, "claude");
    assert.equal(body.error.model, "sonnet");
    assert.equal(body.error.requestId, "req-bounded-retry");
    // Cooldown is now active so the next role request skips this provider.
    assert.equal(isProviderCoolingDown("claude"), true);
    // Recent events include the retry phase plus a final failure result.
    const recent = getRouterStatus().recentEvents;
    const retryEvents = recent.filter((event) => event.phase === "retry" && event.requestId === "req-bounded-retry");
    assert.equal(retryEvents.length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request does not retry on auth (401) or payload (400) errors", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  let lastStatus = 0;
  for (const status of [ 401, 400 ]) {
    responseCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url) === "http://127.0.0.1:4000/v1/responses") {
        responseCalls += 1;
        return new Response(JSON.stringify({ error: "no" }), { status });
      }
      return originalFetch(url, options);
    };
    const server = createServer((request, response) => { void handle(request, response); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false }),
      });
      lastStatus = response.status;
      assert.equal(response.status, status, `upstream returned ${status}`);
      assert.equal(responseCalls, 1, `auth/payload errors must not trigger a retry (status=${status})`);
      assert.equal(response.headers.get("retry-after"), null, `Retry-After must not be set for non-retryable upstream ${status}`);
      const body = await response.json();
      assert.equal(body.error.code, status === 401 ? "router_authentication_error" : "router_upstream_error");
      assert.equal(body.error.retryable, false);
      assert.equal(body.error.failureClass, status === 401 ? "authentication" : "request_error");
      assert.equal(isProviderCoolingDown("claude"), false);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      activeProviderRequests.clear();
      clearProviderCooldown("claude");
      resetRouterTelemetry();
    }
  }
  assert.equal(lastStatus, 400);
  globalThis.fetch = originalFetch;
});

test("direct concrete request does not retry once the client signal is aborted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCooldown = process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
  const originalMax = process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = "10";
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = "20";
  let responseCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      const signal = options && options.signal;
      if (signal) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return originalFetch(url, options);
  };
  const route = routeForModel("sonnet");
  const controller = new AbortController();
  const requestChunks = [ Buffer.from(JSON.stringify({ model: "sonnet", stream: false })) ];
  const { IncomingMessage } = await import("node:http");
  const { Socket } = await import("node:net");
  const fakeRequest = Object.assign(new IncomingMessage(new Socket()), {
    url: "/v1/responses",
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-aborted" },
    complete: false,
  });
  fakeRequest.push(...requestChunks);
  fakeRequest.push(null);
  let responseStatus = 0;
  let responseBody = "";
  const headerStore = {};
  const fakeResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) { headerStore[ name ] = value; },
    getHeader(name) { return headerStore[ name ]; },
    removeHeader(name) { delete headerStore[ name ]; },
    writeHead(status, headers) {
      this.headersSent = true;
      responseStatus = status;
      for (const [ name, value ] of Object.entries(headers ?? {})) headerStore[ name ] = value;
    },
    write(chunk) { responseBody += String(chunk); },
    end(chunk) {
      if (chunk !== undefined) responseBody += String(chunk);
      this.writableEnded = true;
    },
    once() { },
    on() { },
    removeListener() { },
  };
  try {
    // Schedule the abort for the next tick so the upstream fetch is in
    // flight when the signal fires; the router must then observe the
    // aborted flag and skip its bounded retry.
    setImmediate(() => controller.abort());
    await proxyConcreteResponse(fakeResponse, route, { model: "sonnet", stream: false }, false, "req-aborted", null, { key: "unknown", cwd: null }, controller.signal);
    assert.equal(responseCalls, 1, `aborted requests must not retry; got ${responseCalls} fetch calls`);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined) delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request stops retrying once the client aborts mid-way through the extended transport retry budget", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      if (responseCalls === 1) {
        // Mirrors the pooled keep-alive connection getting recycled out from
        // under the first reuse attempt; the bounded transport budget still
        // has a second retry (of 3 total attempts) available at this point.
        const error = new TypeError("fetch failed");
        error.cause = { code: "UND_ERR_SOCKET", syscall: "write" };
        throw error;
      }
      // The client cancels while its second attempt is in flight, i.e.
      // before the extended transport budget (3 attempts) is exhausted.
      // Cancellation must win over the remaining budget instead of the
      // router spending the last attempt anyway.
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return originalFetch(url, options);
  };
  const route = routeForModel("sonnet");
  const requestChunks = [ Buffer.from(JSON.stringify({ model: "sonnet", stream: false })) ];
  const { IncomingMessage } = await import("node:http");
  const { Socket } = await import("node:net");
  const fakeRequest = Object.assign(new IncomingMessage(new Socket()), {
    url: "/v1/responses",
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-mid-budget-abort" },
    complete: false,
  });
  fakeRequest.push(...requestChunks);
  fakeRequest.push(null);
  const headerStore = {};
  const fakeResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) { headerStore[ name ] = value; },
    getHeader(name) { return headerStore[ name ]; },
    removeHeader(name) { delete headerStore[ name ]; },
    writeHead(status, headers) {
      this.headersSent = true;
      for (const [ name, value ] of Object.entries(headers ?? {})) headerStore[ name ] = value;
    },
    write() { },
    end() { this.writableEnded = true; },
    once() { },
    on() { },
    removeListener() { },
  };
  try {
    clearProviderCooldown("claude");
    await proxyConcreteResponse(fakeResponse, route, { model: "sonnet", stream: false }, false, "req-mid-budget-abort", null, { key: "unknown", cwd: null }, controller.signal);
    assert.equal(responseCalls, 2, `cancellation must stop retries before the 3-attempt transport budget is exhausted; got ${responseCalls} fetch calls`);
    const events = getRouterStatus().recentEvents.filter((event) => event.requestId === "req-mid-budget-abort");
    const result = events.find((event) => event.phase === "result");
    assert.equal(result?.status, 499, "an in-flight cancellation must report client_aborted, not spend the remaining retry budget");
    assert.equal(result?.failureClass, "client_aborted");
    assert.equal(events.filter((event) => event.phase === "retry").length, 1, "only the first attempt's retry should be scheduled; the second must be cut short by cancellation");
  } finally {
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request does not reroute to a different provider when the configured one fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
  };
  let antigravityCalls = 0;
  process.env.LITELLM_API_KEY = "test-provider-key";
  clearProviderCooldown("claude");
  clearProviderCooldown("antigravity");
  globalThis.fetch = async (url, options) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 });
    }
    if (String(url) === "http://127.0.0.1:4001/v1/responses") {
      antigravityCalls += 1;
      return new Response(JSON.stringify({ id: "antigravity-response", model: "gemini-3.8-flash-medium", output_text: "should-not-be-called" }), {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-no-reroute" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-no-reroute");
    assert.equal(antigravityCalls, 0, "concrete requests must never silently reroute to another provider");
    const body = await response.json();
    assert.equal(body.error.provider, "claude");
    assert.equal(body.error.model, "sonnet");
    assert.equal(body.error.routerInstanceId, ROUTER_INSTANCE_ID);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const [ key, value ] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[ key ];
      else process.env[ key ] = value;
    }
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    clearProviderCooldown("antigravity");
    resetRouterTelemetry();
  }
});

test("liveness stays 200 during draining while readiness returns 503 with structured router_draining body", async () => {
  resetLifecycleForTests();
  const stateDirectory = await mkdtemp(join(tmpdir(), "autodev-readiness-state-"));
  const stateFile = join(stateDirectory, "router-state.json");
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const readinessReady = await fetch(`http://127.0.0.1:${address.port}/health/readiness`);
    assert.equal(readinessReady.status, 200);
    const readyPayload = await readinessReady.json();
    assert.equal(readyPayload.status, "ready");
    assert.equal(readyPayload.lifecycle.state, "ready");
    assert.equal(isDraining(), false);

    // Force the lifecycle into draining without relying on the SIGTERM handler
    // (which would call process.exit in production).
    const { execSync } = await import("node:child_process");
    void execSync;
    const internal = await import("./codex-model-router.mjs");
    void internal;

    // Trigger draining through the public lifecycle helper used by tests.
    resetLifecycleForTests();
    // Use the exported beginShutdown with a no-op server reference and the
    // test escape hatch so we can probe the endpoints while draining.
    process.env.CODEX_ROUTER_TEST_NO_EXIT = "1";
    try {
      await beginShutdown("SIGTERM", null, stateFile);
    } finally {
      delete process.env.CODEX_ROUTER_TEST_NO_EXIT;
    }
    assert.equal(isDraining(), true);
    assert.equal(getLifecycleStatus().draining, true);

    const liveliness = await fetch(`http://127.0.0.1:${address.port}/health/liveliness`);
    assert.equal(liveliness.status, 200);
    const livenessBody = await liveliness.json();
    assert.equal(livenessBody.status, "ok");

    const readinessDraining = await fetch(`http://127.0.0.1:${address.port}/health/readiness`);
    assert.equal(readinessDraining.status, 503);
    const drainingBody = await readinessDraining.json();
    assert.equal(drainingBody.error.code, "router_draining");
    assert.equal(drainingBody.error.retryable, true);
    assert.equal(drainingBody.error.routerInstanceId, ROUTER_INSTANCE_ID);
    assert.equal(readinessDraining.headers.get("x-autodev-router-instance-id"), ROUTER_INSTANCE_ID);

    const responsesDuringDrain = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(responsesDuringDrain.status, 503);
    assert.ok(Number(responsesDuringDrain.headers.get("retry-after")) > 0, "Retry-After must be set on the draining rejection");
    const drainResponseBody = await responsesDuringDrain.json();
    assert.equal(drainResponseBody.error.code, "router_draining");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetLifecycleForTests();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("graceful shutdown drains in-flight requests, persists state, and stops accepting new traffic", async () => {
  const originalFetch = globalThis.fetch;
  process.env.CODEX_ROUTER_TEST_NO_EXIT = "1";
  const directory = await mkdtemp(join(tmpdir(), "autodev-shutdown-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetLifecycleForTests();
    resetRouterTelemetry();
    recordRouterEvent({ phase: "selected", requestId: "shutdown-precondition", requestedModel: "sonnet", provider: "claude", model: "sonnet" });
    // Persist the precondition event so the test can later verify that
    // the shutdown drained a recent in-flight snapshot.
    await persistRouterStateNow(stateFile);

    // Mock fetch resolves only after the test allows it, simulating an
    // in-flight upstream call that must drain before shutdown completes.
    let upstreamResolve;
    const upstreamPromise = new Promise((resolve) => { upstreamResolve = resolve; });
    let upstreamCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url) === "http://127.0.0.1:4000/v1/responses") {
        upstreamCalls += 1;
        await upstreamPromise;
        return new Response(JSON.stringify({ id: "slow-response", model: "sonnet", output_text: "ok" }), {
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
      const inflight = fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false }),
      });

      // Wait until the request is registered with the router before draining.
      const deadline = Date.now() + 1000;
      while (getLifecycleStatus().activeResponseRequests === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(getLifecycleStatus().activeResponseRequests >= 1, true);

      // Begin shutdown while the request is still in flight.
      const shutdownPromise = beginShutdown("SIGTERM", server, stateFile);

      // New requests during drain must be rejected immediately.
      const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false }),
      });
      assert.equal(rejected.status, 503);
      const rejectedBody = await rejected.json();
      assert.equal(rejectedBody.error.code, "router_draining");

      // Resolve the in-flight upstream and confirm drain completes.
      upstreamResolve();
      const inflightResponse = await inflight;
      assert.equal(inflightResponse.status, 200);
      await shutdownPromise;

      // State must have been persisted before shutdown completed. We seed
      // the test path with the precondition event and let beginShutdown
      // perform its own flush; both paths are covered.
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(persisted.schema, "autodev-router-persisted-state-v1");
      assert.equal(persisted.recentEvents.some((event) => event.requestId === "shutdown-precondition"), true);
      assert.ok(typeof persisted.updatedAt === "string" && persisted.updatedAt.length > 0);
      assert.equal(upstreamCalls, 1, `the in-flight request must complete cleanly without a new upstream call; got ${upstreamCalls}`);
      assert.equal(getLifecycleStatus().state, "draining");
    } finally {
      try {
        await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      } catch {
        // The drain step inside beginShutdown already closes the server;
        // tolerate the duplicate close here.
      }
      globalThis.fetch = originalFetch;
      resetLifecycleForTests();
    }
  } finally {
    delete process.env.CODEX_ROUTER_TEST_NO_EXIT;
    resetRouterTelemetry();
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    await rm(directory, { recursive: true, force: true });
  }
});

test("tells the provider bridge that an orchestrator turn is the orchestrator, so it is never handed the leaf prompt", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  for (const provider of [ "codex", "claude", "antigravity", "minimax" ]) clearProviderCooldown(provider);
  let upstreamHeaders = null;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    // Force the orchestrator off its pinned primary and onto a bridge-backed
    // fallback provider, which is exactly where the leaf prompt used to leak in.
    if (target.startsWith("https://chatgpt.com/")) return new Response(JSON.stringify({ error: "You have hit your usage limit" }), { status: 429 });
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      upstreamHeaders = options.headers;
      return new Response(JSON.stringify({ id: "orchestrator", model: "fallback", output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": "orchestrator-role-header" },
      body: JSON.stringify({ model: ORCHESTRATOR_ALIAS, stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[ AGENT_ROLE_HEADER ], ORCHESTRATOR_AGENT_ROLE);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = originalKey;
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("a delegated role is named as that role, and a client cannot claim to be the orchestrator", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  for (const provider of [ "codex", "claude", "antigravity", "minimax", "copilot" ]) clearProviderCooldown(provider);
  let upstreamHeaders = null;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      upstreamHeaders = options.headers;
      return new Response(JSON.stringify({ id: "role", model: "sonnet", output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-session-id": "leaf-role-header",
        // A leaf turn claiming to be the root: the router builds its outbound
        // header set from its own alias dispatch, so the claim never survives.
        [ AGENT_ROLE_HEADER ]: ORCHESTRATOR_AGENT_ROLE,
      },
      body: JSON.stringify({ model: "autodev/explorer", stream: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[ AGENT_ROLE_HEADER ], "explorer");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = originalKey;
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("isClientDisconnectError correctly classifies client socket and broken pipe errors", () => {
  assert.equal(isClientDisconnectError(null), false);
  assert.equal(isClientDisconnectError({}), false);
  assert.equal(isClientDisconnectError(new TypeError("regular error")), false);
  assert.equal(isClientDisconnectError(Object.assign(new Error("broken pipe"), { code: "EPIPE" })), true);
  assert.equal(isClientDisconnectError(Object.assign(new Error("conn reset"), { code: "ECONNRESET" })), true);
  assert.equal(isClientDisconnectError(Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" })), true);
  assert.equal(isClientDisconnectError(Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" })), true);
  // Nested cause
  const nested = new Error("fetch failed");
  nested.cause = { code: "EPIPE" };
  assert.equal(isClientDisconnectError(nested), true);
  const otherNested = new Error("fetch failed");
  otherNested.cause = { code: "EINVAL" };
  assert.equal(isClientDisconnectError(otherNested), false);
});

test("writeResponseStream emits active keep-alive comments down to the client during quiet streaming intervals", async () => {
  const originalFetch = globalThis.fetch;
  let streamClosed = false;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/responses")) {
      const stream = new ReadableStream({
        async start(controller) {
          // Send an initial event
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
          // Delay to allow the router-level keep-alive to fire
          await new Promise((resolve) => setTimeout(resolve, 2200));
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(url, options);
  };
  clearProviderCooldown("claude");
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", stream: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /: codex-router keep-alive/, "the router should emit keep-alive comments during quiet intervals");
    assert.match(body, /"type":"response\.completed"/, "the completed event should follow the keep-alive");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});

test("abrupt client disconnect during SSE stream does not crash the router process", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamEmitted = 0;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/responses")) {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"part1"}\n\n'));
          upstreamEmitted += 1;
          // Wait briefly, then emit more data after client has disconnected
          await new Promise((resolve) => setTimeout(resolve, 150));
          try {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"part2"}\n\n'));
            upstreamEmitted += 1;
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
            controller.close();
          } catch {
            // Upstream controller closed
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(url, options);
  };
  clearProviderCooldown("claude");
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    // Connect via raw TCP socket and abruptly destroy the socket after receiving initial data
    await new Promise((resolve, reject) => {
      const client = connect(port, "127.0.0.1", () => {
        const payload = JSON.stringify({ model: "sonnet", stream: true });
        client.write(
          `POST /v1/responses HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          `Connection: close\r\n\r\n` +
          payload
        );
      });
      client.on("data", () => {
        // Abruptly destroy client socket mid-stream (broken pipe simulation)
        client.destroy();
        resolve();
      });
      client.on("error", () => resolve());
    });

    // Allow time for upstream writes to fire against the dead socket
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify the router is still fully alive and accepts subsequent requests
    const followUpResponse = await originalFetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sonnet", stream: false }),
    });
    assert.equal(followUpResponse.status, 200, "router must remain healthy and responsive after a client disconnected mid-stream");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    clearProviderCooldown("claude");
    resetRouterTelemetry();
  }
});


