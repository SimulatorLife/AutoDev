import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RESPONSES_ITEM_ID_PREFIXES } from "./codex/lib/responses-item-ids.mjs";

import {
  activeProviderRequests,
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  beginShutdown,
  catalogModelIds,
  classifyProviderFailure,
  clearProviderCooldown,
  cooldownAllowsLastResort,
  cooldownProvider,
  declaredLimit,
  providerCooldownSummary,
  providerCapabilities,
  roleCapabilityRequirements,
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
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  carriesPendingToolResult,
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
  routerAuthorizationValid,
  setRouterAuthTokenForTests,
  routeForModel,
  transformSseEvent,
  flattenOutboundTools,
  rewriteToolNamespaces,
  bridgeTelemetryHeaders,
  ingestAgentEvents,
  noteBridgeRequest,
  closeBridgeSubagentsForRequest,
  UNATTRIBUTED_SUBAGENT_ROLE,
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
  upstreamPayload,
  workspaceContextFromRequest,
  registerWorkspaceId,
  attributionDiagnosticsStatus,
  resetAttributionDiagnostics,
} from "./codex-model-router.mjs";
import { resolveAgentEventReporter } from "./codex/lib/agent-events.mjs";
import { spawnedChildren } from "./codex-antigravity-cli-responses-proxy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// /status is unauthenticated and machine-reachable, so it must never surface
// an absolute filesystem path (home-directory or $CODEX_HOME-rooted). This
// walks the full response recursively -- not just the top-level fields known
// to have carried a path historically -- so a new field added later that
// accidentally embeds one fails the test instead of shipping silently.
const LEAKED_PATH_PATTERN = /\/Users\/|\/home\/|CODEX_HOME/;
function assertNoLeakedPaths(value, path = "$") {
  if (typeof value === "string") {
    assert.equal(LEAKED_PATH_PATTERN.test(value), false, `leaked filesystem path at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLeakedPaths(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) assertNoLeakedPaths(nested, `${path}.${key}`);
  }
}

// The launcher publishes CODEX_ROUTER_AUTH_TOKEN into the launchd user domain,
// so a maintainer's shell normally carries it. Without pinning, the module
// would arm the auth gate and every request-level test below -- none of which
// send an Authorization header -- would 401 on a correctly configured machine.
setRouterAuthTokenForTests("");

test("router auth is opt-in and validates bearer tokens without exposing the token", () => {
  assert.equal(routerAuthorizationValid({ headers: {} }), true);
  assert.equal(routerAuthorizationValid({ headers: {} }, "secret"), false);
  assert.equal(routerAuthorizationValid({ headers: { authorization: "Bearer wrong" } }, "secret"), false);
  assert.equal(routerAuthorizationValid({ headers: { authorization: "Bearer secret" } }, "secret"), true);
});

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
  // A post-stream failure must never read as success. It is no longer a bare
  // `response.failed` either: that discarded every token already streamed. The
  // turn is closed as *incomplete* instead, carrying the work that finished --
  // which `responseWasNotCompleted` still counts as a provider failure.
  assert.match(bridge, /terminalIncompleteEvents\(\{/, "a post-stream failure must close the turn as incomplete");
  assert.match(bridge, /"incomplete"\)/, "the flushed payload must not claim it completed");
  assert.doesNotMatch(bridge, /emit\("response\.failed"/, "a flushed turn must not also be reported as failed");
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

test("all providers are treated as capable of subagent spawning", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  for (const provider of Object.keys(config.providers)) {
    assert.equal(config.providers[provider].capabilities, undefined, `${provider} must not declare capabilities in routing config`);
    assert.equal(
      providerCapabilities(provider).subagentSpawn,
      true,
      `${provider} must be treated as spawn-capable`,
    );
  }
  for (const group of config.providerGroups.orchestrator) {
    for (const provider of group) {
      assert.equal(
        providerCapabilities(provider).subagentSpawn,
        true,
        `${provider} serves the orchestrator tier, so it must be able to spawn subagents`,
      );
    }
  }
});

test("router status treats every provider as spawn-capable without role capability metadata", () => {
  const providers = getRouterStatus().providers;
  for (const provider of Object.values(providers)) {
    assert.equal(provider.capabilities.subagentSpawn, true);
    assert.ok(Array.isArray(provider.capabilities.subagentSpawnTools));
    assert.equal("mcp" in provider.capabilities, false);
    assert.equal("skills" in provider.capabilities, false);
  }
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
    orchestrator: {
      alias: "autodev/orchestrator",
      tier: "orchestrator",
      reasoningEffort: { fallbackProvider: "high" },
    },
  };
  assert.doesNotThrow(() => validateRoutingConfig(validConfig));

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providers: { testProvider: { models: {} } } }),
    /Routing config provider testProvider must define a default model/
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
  cooldownProvider("minimax", { now });
  assert.equal(isProviderCoolingDown("minimax", now + 1), true);
  assert.equal(isProviderCoolingDown("minimax", now + 30_000), false);
  clearProviderCooldown("minimax");
  assert.equal(isProviderCoolingDown("minimax", now), false);
});

test("holds a provider that reported a real reset until that reset, not on the transient ladder", () => {
  const now = 1_000;
  try {
    const resetsAt = new Date(now + 3_600_000).toISOString();
    const hard = cooldownProvider("minimax", { now, failureClass: "quota_exhausted", resetsAt, structured: true });
    assert.equal(hard.kind, "hard");
    assert.equal(hard.cooldownUntil, Date.parse(resetsAt), "the provider's own reset time is authoritative");
    assert.equal(hard.resetsAt, resetsAt);

    // Repeating it does not escalate: the reset time is a fact, not a guess.
    assert.equal(cooldownProvider("minimax", { now, failureClass: "quota_exhausted", resetsAt, structured: true }).cooldownUntil, Date.parse(resetsAt));

    // A reset further out than the ceiling is clamped rather than trusted whole.
    clearProviderCooldown("minimax");
    const far = cooldownProvider("minimax", { now, failureClass: "quota_exhausted", resetsAt: new Date(now + 30 * 86_400_000).toISOString(), structured: true });
    assert.equal(far.cooldownUntil, now + 21_600_000);
  } finally {
    clearProviderCooldown("minimax");
  }
});

test("a limit only inferred from prose stays on the transient ladder", () => {
  const now = 1_000;
  try {
    // classifyProviderFailure matches keywords, and bridges ship stderr tails in
    // error messages. One stray "quota" must not take a provider out for the
    // hard window; only a provider *reporting* the limit does that.
    const inferred = cooldownProvider("minimax", { now, failureClass: "quota_exhausted", structured: false });
    assert.equal(inferred.kind, "transient");
    assert.equal(inferred.durationMs, 30_000);
  } finally {
    clearProviderCooldown("minimax");
  }
});

test("health probe failures and broken credentials get their own cooldowns", () => {
  const now = 1_000;
  try {
    // A local bridge restarting says nothing about the provider behind it, so
    // it must not push the provider's own backoff toward its ceiling.
    const first = cooldownProvider("minimax", { now, failureClass: "probe_unavailable" });
    const second = cooldownProvider("minimax", { now, failureClass: "probe_unavailable" });
    assert.equal(first.kind, "probe");
    assert.equal(first.durationMs, 5_000);
    assert.equal(second.durationMs, 10_000);
    assert.equal(getRouterStatus(now + 1).providers.minimax.failureStreak, 0, "a probe failure must not move the provider's own streak");

    clearProviderCooldown("minimax");
    // A broken credential is deterministic: fixed, unescalating, and never
    // retried as a last resort, because re-sending cannot make it work.
    const config = cooldownProvider("minimax", { now, failureClass: "authentication" });
    assert.equal(config.kind, "config");
    assert.equal(cooldownProvider("minimax", { now, failureClass: "authentication" }).durationMs, 30_000);
  } finally {
    clearProviderCooldown("minimax");
    resetRouterTelemetry();
  }
});

test("a cooldown only ever moves later", () => {
  const now = 1_000;
  try {
    const resetsAt = new Date(now + 3_600_000).toISOString();
    cooldownProvider("minimax", { now, failureClass: "quota_exhausted", resetsAt, structured: true });
    // A five-second probe failure landing on top of an hour-long usage limit
    // must not shorten it back to five seconds.
    cooldownProvider("minimax", { now, failureClass: "probe_unavailable" });
    const status = getRouterStatus(now + 1).providers.minimax;
    assert.equal(status.cooldownKind, "hard");
    assert.equal(status.cooldownResetsAt, resetsAt);
  } finally {
    clearProviderCooldown("minimax");
    resetRouterTelemetry();
  }
});

test("backs off repeatedly failing providers and moves them behind healthy peers", () => {
  resetRouterTelemetry();
  activeProviderRequests.clear();
  try {
    const first = cooldownProvider("claude", { now: 1_000 });
    const second = cooldownProvider("claude", { now: 1_000 });
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("down", { status: 503 });
    }
    return originalFetch(url, options);
  };
  resetRouterTelemetry();
  const cooldownStartedAt = Date.now();
  for (const provider of [ "claude", "antigravity", "minimax", "copilot", "codex" ]) cooldownProvider(provider, { now: cooldownStartedAt });
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": "cooldown-test" },
      body: JSON.stringify({ model: "autodev/default", stream: false }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.match((await response.json()).error.message, /Retry after approximately 30s/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const provider of [ "claude", "antigravity", "minimax", "copilot", "codex" ]) clearProviderCooldown(provider);
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

test("an exec tool call carrying a spawn script reaches Codex byte for byte", async () => {
  // Codex runs these models in code mode: a bridge that wants a real child
  // thread emits an `exec` custom tool call whose JavaScript calls
  // `tools.multi_agent_v1__spawn_agent`. That spawn name therefore travels
  // inside a *string* -- the script source -- and the namespace rewriting above
  // must not touch it. If it ever did, Codex would be handed a script calling a
  // function that does not exist, and every bridge-driven spawn would fail with
  // nothing in the router log to explain it.
  const { buildSpawnScript, execToolCallSseEvents } = await import("./codex/lib/codex-spawn-tools.mjs");
  const source = buildSpawnScript([ { agentType: "explorer", message: "audit the catalogue" } ]);

  for (const [ name, payload ] of execToolCallSseEvents({ itemId: "ctc_1", callId: "call_1", source })) {
    const transformed = transformSseEvent(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`, "autodev/orchestrator");
    const back = JSON.parse(transformed.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.deepEqual(back.item ?? null, payload.item ?? null);
    assert.equal(back.delta ?? null, payload.delta ?? null);
    assert.equal(back.input ?? null, payload.input ?? null);
  }

  // The rewriting is real, so the pass-through above is not vacuous: the same
  // name as a bare `function_call` name still gets split into a namespace.
  assert.deepEqual(
    rewriteToolNamespaces({ name: "multi_agent_v1__spawn_agent", type: "function_call" }),
    { name: "spawn_agent", namespace: "multi_agent_v1", type: "function_call" },
  );
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
    // Three children from two spawn events, and the event that named no
              // recognized type is the one rejected: the counts measure
              // subagents and events respectively, not one minus the other.
              assert.deepEqual(accepted, { accepted: 3, closed: 0, unavailable: 0, rejected: 1, reason: null });

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
    assert.deepEqual(status.spawnCapableProviders, [ "antigravity", "claude", "minimax", "copilot", "codex" ]);
    assert.equal(status.recent[ 0 ].role, "validator", "the recent list is newest first");
    assert.equal(status.recent.at(-1).provider, "claude");

    // The request id is the only credential a report carries, so an unknown one
    // is counted nowhere.
    assert.deepEqual(
      ingestAgentEvents({ requestId: "never-issued", events: [ { type: "subagent_spawn", tool: "Agent" } ] }),
      { accepted: 0, closed: 0, unavailable: 0, rejected: 1, reason: "unknown_request_id" },
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
    assert.deepEqual(await accepted.json(), { accepted: 1, closed: 0, unavailable: 0, rejected: 0, reason: null });

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

test("a spawn breakdown says how its children ended, not only that they started", async () => {
  // `byStatus` is the breakdown of how spawns finished, but only the open path
  // ever wrote to it, so it read `{ started: N }` forever -- which says "none of
  // these ever finished" about children that had all completed.
  resetSubagentTelemetry();
  try {
    noteBridgeRequest("request-status", { provider: "antigravity", model: "gemini-3.8-flash-medium", role: null, workspace: "SimulatorLife/RacingGame" });
    ingestAgentEvents({
      requestId: "request-status",
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "research", count: 2, children: [ { id: "c1" }, { id: "c2" } ] } ],
    });
    assert.deepEqual(subagentStatus().byStatus, { started: 2 });

    ingestAgentEvents({
      requestId: "request-status",
      events: [ { type: "subagent_result", tool: "invoke_subagent", role: "research", outcome: "success", durationMs: 45_000, children: [ { id: "c1" } ] } ],
    });
    // A close settles a child; it never invents one.
    assert.deepEqual(subagentStatus().byStatus, { started: 1, success: 1 });
    assert.equal(subagentStatus().total, 2, "settling is not a new spawn");

    ingestAgentEvents({
      requestId: "request-status",
      events: [ { type: "subagent_result", tool: "invoke_subagent", role: "research", outcome: "failure", children: [ { id: "c2" } ] } ],
    });
    assert.deepEqual(subagentStatus().byStatus, { started: 0, success: 1, failure: 1 });

    // The batch row carries its own tally, so a reader can see how that
    // delegation ended rather than only how many it started.
    const [ batch ] = subagentStatus().recent;
    assert.equal(batch.count, 2);
    assert.deepEqual(batch.settled, { success: 1, failure: 1 });
  } finally {
    resetSubagentTelemetry();
  }
});

test("a spawn row restored from an older state file still settles", async () => {
  // Rows written before `settled` existed come back without it, and the scan
  // that finds a batch reads that field on every row it walks past.
  const directory = await mkdtemp(join(tmpdir(), "router-settled-state-"));
  const file = join(directory, "state.json");
  try {
    resetSubagentTelemetry();
    noteBridgeRequest("request-old-row", { provider: "antigravity", model: "gemini-3.8-flash-medium", role: null, workspace: "SimulatorLife/RacingGame" });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "research", count: 1, children: [ { id: "c1" } ] } ],
    });
    const aged = JSON.parse(serializeRouterState());
    for (const entry of aged.subagents.recent) delete entry.settled;
    await writeFile(file, JSON.stringify(aged), "utf8");

    resetSubagentTelemetry();
    assert.equal(loadRouterState(file), true);
    assert.deepEqual(subagentStatus().recent[ 0 ].settled, { success: 0, failure: 0 }, "a restored row is normalized, not left ragged");

    noteBridgeRequest("request-old-row", { provider: "antigravity", model: "gemini-3.8-flash-medium", role: null, workspace: "SimulatorLife/RacingGame" });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "research", count: 1, children: [ { id: "c2" } ] } ],
    });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [ { type: "subagent_result", tool: "invoke_subagent", role: "research", outcome: "success", children: [ { id: "c2" } ] } ],
    });
    assert.equal(subagentStatus().byStatus.success, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    resetSubagentTelemetry();
    resetRouterTelemetry();
  }
});

test("children still running when the parent turn ends are settled by it", async () => {
  // The normal path for Antigravity: `invoke_subagent` dispatches and never
  // reports a close, because agy emits no step when a child finishes. The
  // parent turn is the only honest bound on those children.
  resetSubagentTelemetry();
  try {
    noteBridgeRequest("request-parent-close", { provider: "antigravity", model: "gemini-3.8-flash-medium", role: null, workspace: "SimulatorLife/RacingGame" });
    ingestAgentEvents({
      requestId: "request-parent-close",
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "research", count: 1, children: [ { id: "c1" } ] } ],
    });
    assert.deepEqual(subagentStatus().byStatus, { started: 1 });

    closeBridgeSubagentsForRequest("request-parent-close", "success", 45_000);
    assert.deepEqual(subagentStatus().byStatus, { started: 0, success: 1 });
    assert.deepEqual(subagentStatus().recent[ 0 ].settled, { success: 1, failure: 0 });
  } finally {
    resetSubagentTelemetry();
  }
});

test("an Antigravity batch spawn contributes measured turns to the usage tables", async () => {
  // The spawn count alone left the provider that actually ran a twelve-way
  // fan-out showing exactly one turn in "Provider health and usage", and no
  // subagent row at all in "Usage by orchestrator and subagents": a
  // CLI-delegated child never reaches the router as a request. The bridge's
  // report is the only evidence it ran, so it is what has to open the bucket.
  const usageBefore = getRouterStatus().usage;
  const roleAttempts = (usage, role) => Number(usage.byRole?.[ role ]?.attempts ?? 0);
  const roleSuccesses = (usage, role) => Number(usage.byRole?.[ role ]?.successes ?? 0);
  const modelAttempts = (usage, key) => Number(usage.byModel?.[ key ]?.attempts ?? 0);

  resetSubagentTelemetry();
  try {
    noteBridgeRequest("request-usage", { provider: "antigravity", model: "gemini-3.8-flash-medium", role: null, workspace: "SimulatorLife/RacingGame" });
    const stepUpdate = {
      step_index: 7,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: {
        name: "invoke_subagent",
        args: JSON.stringify({
          Subagents: [
            { TypeName: "explorer", Model: "inherit", Prompt: "Catalog every build error" },
            { TypeName: "explorer", Model: "gemini-3.8-flash-high", Prompt: "Catalog every lint error" },
            { Model: "inherit", Prompt: "A child whose step exported no archetype" },
          ],
        }),
      },
    };
    const children = spawnedChildren(stepUpdate);
    assert.deepEqual(children.map(({ id }) => id), [ "s7.0", "s7.1", "s7.2" ], "each child is addressable so its own turn can be closed");
    const spawned = ingestAgentEvents({
      requestId: "request-usage",
      events: [
        { type: "subagent_spawn", tool: "invoke_subagent", role: "explorer", count: 2, children: [ { id: "s7.0" }, { id: "s7.1", model: "gemini-3.8-flash-high" } ] },
        { type: "subagent_spawn", tool: "invoke_subagent", role: null, count: 1, children: [ { id: "s7.2" } ] },
      ],
    });
    assert.deepEqual(spawned, { accepted: 3, closed: 0, unavailable: 0, rejected: 0, reason: null });

    const usageOpen = getRouterStatus().usage;
    assert.equal(roleAttempts(usageOpen, "explorer") - roleAttempts(usageBefore, "explorer"), 2);
    // A roleless child must not land in the `unattributed` bucket: that key is
    // roleless orchestrator traffic, which the dashboard renders as the
    // Orchestrator row, so a delegation would be credited to its parent.
    assert.equal(roleAttempts(usageOpen, UNATTRIBUTED_SUBAGENT_ROLE) - roleAttempts(usageBefore, UNATTRIBUTED_SUBAGENT_ROLE), 1);
    assert.equal(roleAttempts(usageOpen, "unattributed"), roleAttempts(usageBefore, "unattributed"));
    // `inherit` is agy naming the parent's model rather than choosing one.
    assert.equal(modelAttempts(usageOpen, "antigravity/gemini-3.8-flash-medium") - modelAttempts(usageBefore, "antigravity/gemini-3.8-flash-medium"), 2);
    assert.equal(modelAttempts(usageOpen, "antigravity/gemini-3.8-flash-high") - modelAttempts(usageBefore, "antigravity/gemini-3.8-flash-high"), 1);
    assert.equal(Number(usageOpen.byOrigin?.subagent?.active ?? 0) - Number(usageBefore.byOrigin?.subagent?.active ?? 0), 3, "children are in flight until they are closed");

    // A close carries the duration the CLI spent on the child, which is the
    // only per-child turn measurement that exists.
    const closed = ingestAgentEvents({
      requestId: "request-usage",
      events: [ { type: "subagent_result", tool: "invoke_subagent", role: "explorer", outcome: "success", durationMs: 4000, children: [ { id: "s7.0" }, { id: "s7.1" } ] } ],
    });
    assert.deepEqual(closed, { accepted: 0, closed: 2, unavailable: 0, rejected: 0, reason: null }, "a close settles buckets rather than counting new subagents");
    assert.equal(subagentStatus().total, 3, "closing a child does not spawn another one");

    const usageClosed = getRouterStatus().usage;
    assert.equal(roleSuccesses(usageClosed, "explorer") - roleSuccesses(usageBefore, "explorer"), 2);
    assert.equal(Number(usageClosed.byRole.explorer.maxDurationMs) >= 4000, true, "the reported duration is the child's own");

    // The child the bridge never closed still ends with the parent turn, so a
    // bridge that dies mid-turn cannot strand it as permanently active.
    assert.equal(closeBridgeSubagentsForRequest("request-usage", "success", 9000), 1);
    const usageSwept = getRouterStatus().usage;
    assert.equal(roleSuccesses(usageSwept, UNATTRIBUTED_SUBAGENT_ROLE) - roleSuccesses(usageBefore, UNATTRIBUTED_SUBAGENT_ROLE), 1);
    assert.equal(Number(usageSwept.byOrigin?.subagent?.active ?? 0) - Number(usageBefore.byOrigin?.subagent?.active ?? 0), 0);
  } finally {
    resetSubagentTelemetry();
  }
});

test("an orchestrator handed no delegation tool is reported, not read as a refusal", async () => {
  // A project `.claude/settings.json` listing `Agent` under `permissions.deny`
  // strips the tool from an orchestrator turn whatever the bridge allows, and
  // `bypassPermissions` does not override a deny. The turn then does the work
  // itself and reports zero subagents -- which reads exactly like a provider
  // that chose not to delegate. The absence has to arrive as its own fact.
  resetSubagentTelemetry();
  const before = getRouterStatus().spawnFailures;
  const reasonCount = (snapshot) => Number(snapshot.byReason?.spawn_tool_unavailable ?? 0);
  try {
    noteBridgeRequest("request-denied", { provider: "claude", model: "claude-opus-5", role: null, workspace: "SimulatorLife/RacingGame" });
    const result = ingestAgentEvents({
      requestId: "request-denied",
      events: [ { type: "subagent_tools_unavailable", expected: [ "Agent", "Task" ], available: [ "Read", "Bash", "Write" ] } ],
    });
    // It is not a spawn, so it moves no spawn counter.
    assert.deepEqual(result, { accepted: 0, closed: 0, unavailable: 1, rejected: 0, reason: null });
    assert.equal(subagentStatus().total, 0);

    const after = getRouterStatus().spawnFailures;
    assert.equal(reasonCount(after) - reasonCount(before), 1);
    assert.equal(after.total - before.total, 1);
    assert.equal(after.recent[ 0 ].reason, "spawn_tool_unavailable");
    assert.equal(after.recent[ 0 ].requestedModel, "claude-opus-5", "the failure names the model that was left unable to delegate");
  } finally {
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
  assert.deepEqual(context, { key: "SimulatorLife/RacingGame", cwd: "RacingGame", workspace_id: "ws_d8911866a131" });
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

test("attributes named tools, skills, and skillUses across two distinct workspaces while preserving global telemetry and scalar toolCalls", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  // Register two distinct workspaces with stable opaque IDs via turn metadata
  const wsContextA = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspace_id: "ws-alpha-123",
      workspaces: {
        "/Users/henrykirk/Desktop/RacingGame": {
          associated_remote_urls: { origin: "https://github.com/SimulatorLife/RacingGame.git" },
        },
      },
    }),
  );
  assert.equal(wsContextA.key, "SimulatorLife/RacingGame");
  assert.equal(wsContextA.workspace_id, "ws-alpha-123");

  const wsContextB = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspace_id: "ws-beta-456",
      workspaces: {
        "/Users/henrykirk/Desktop/WebPortal": {
          associated_remote_urls: { origin: "https://github.com/Company/WebPortal.git" },
        },
      },
    }),
  );
  assert.equal(wsContextB.key, "Company/WebPortal");
  assert.equal(wsContextB.workspace_id, "ws-beta-456");

  // Record normal turns that increment attempts, successes, and scalar toolCalls
  recordRouterEvent({
    phase: "selected",
    requestId: "req-a",
    provider: "codex",
    model: "gpt-5.6-luna",
    workspace: wsContextA,
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-a",
    provider: "codex",
    model: "gpt-5.6-luna",
    workspace: wsContextA,
    outcome: "success",
    status: 200,
    elapsedMs: 20,
    toolCalls: 5,
  });

  recordRouterEvent({
    phase: "selected",
    requestId: "req-b",
    provider: "claude",
    model: "sonnet",
    workspace: wsContextB,
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-b",
    provider: "claude",
    model: "sonnet",
    workspace: wsContextB,
    outcome: "success",
    status: 200,
    elapsedMs: 15,
    toolCalls: 3,
  });

  // Helper for OTLP points
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value, start = "1", time = "2") => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value),
  });

  // Send tool and skill OTLP metrics for both workspaces
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-alpha-123" ] ]) },
        scopeMetrics: [ {
          metrics: [
            {
              name: "codex.tool.call",
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 4, "10", "20"),
                  point([ [ "tool", "read_file" ], [ "source", "builtin" ], [ "status", "ok" ] ], 2, "10", "20"),
                ],
              },
            },
            {
              name: "codex.skill.injected",
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  point([ [ "skill", "ccc" ], [ "status", "ok" ] ], 2, "10", "20"),
                ],
              },
            },
          ],
        } ],
      },
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-beta-456" ] ]) },
        scopeMetrics: [ {
          metrics: [
            {
              name: "codex.tool.call",
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 3, "10", "20"),
                  point([ [ "tool", "write_file" ], [ "source", "builtin" ], [ "status", "ok" ] ], 1, "10", "20"),
                ],
              },
            },
            {
              name: "codex.skill.injected",
              sum: {
                aggregationTemporality: 1,
                dataPoints: [
                  point([ [ "skill", "lsp-mcp-server" ], [ "status", "ok" ] ], 5, "10", "20"),
                ],
              },
            },
          ],
        } ],
      },
    ],
  });

  const status = getRouterStatus();
  const wsA = status.usage.byWorkspace[ "SimulatorLife/RacingGame" ];
  const wsB = status.usage.byWorkspace[ "Company/WebPortal" ];

  // Scalar toolCalls semantics preserved
  assert.equal(wsA.toolCalls, 5);
  assert.equal(wsB.toolCalls, 3);

  // Per-workspace skillUses
  assert.equal(wsA.skillUses, 2);
  assert.equal(wsB.skillUses, 5);

  // Per-workspace named tools (byTool)
  assert.equal(Array.isArray(wsA.byTool), true);
  assert.equal(wsA.byTool.find((t) => t.tool === "exec_command")?.count, 4);
  assert.equal(wsA.byTool.find((t) => t.tool === "read_file")?.count, 2);
  assert.equal(wsA.byTool.find((t) => t.tool === "write_file"), undefined);

  assert.equal(Array.isArray(wsB.byTool), true);
  assert.equal(wsB.byTool.find((t) => t.tool === "exec_command")?.count, 3);
  assert.equal(wsB.byTool.find((t) => t.tool === "write_file")?.count, 1);
  assert.equal(wsB.byTool.find((t) => t.tool === "read_file"), undefined);

  // Per-workspace named skills (bySkill)
  assert.equal(Array.isArray(wsA.bySkill), true);
  assert.equal(wsA.bySkill.find((s) => s.skill === "ccc")?.total, 2);
  assert.equal(wsA.bySkill.find((s) => s.skill === "lsp-mcp-server"), undefined);

  assert.equal(Array.isArray(wsB.bySkill), true);
  assert.equal(wsB.bySkill.find((s) => s.skill === "lsp-mcp-server")?.total, 5);
  assert.equal(wsB.bySkill.find((s) => s.skill === "ccc"), undefined);

  // Global telemetry preserved and reflects aggregate of both workspaces
  const globalExec = status.codexTelemetry.tools.byTool.find((t) => t.tool === "exec_command");
  assert.equal(globalExec?.count, 7); // 4 + 3
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "read_file")?.count, 2);
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "write_file")?.count, 1);
  assert.equal(status.codexTelemetry.skills.injected.total, 7); // 2 + 5
  assert.equal(status.codexTelemetry.skills.injected.bySkill.find((s) => s.skill === "ccc")?.total, 2);
  assert.equal(status.codexTelemetry.skills.injected.bySkill.find((s) => s.skill === "lsp-mcp-server")?.total, 5);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("dedupes cumulative and delta OTLP metrics independently across multiple workspaces", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  registerWorkspaceId("ws-1", "RepoA");
  registerWorkspaceId("ws-2", "RepoB");

  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value, start, time) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value),
  });

  // Workspace 1 sends cumulative 5 at T=100
  // Workspace 2 sends cumulative 3 at T=100
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-1" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call",
            sum: {
              aggregationTemporality: 2, // CUMULATIVE
              dataPoints: [ point([ [ "tool", "bash" ], [ "source", "builtin" ], [ "status", "ok" ] ], 5, 0, 100) ],
            },
          } ],
        } ],
      },
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-2" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call",
            sum: {
              aggregationTemporality: 2, // CUMULATIVE
              dataPoints: [ point([ [ "tool", "bash" ], [ "source", "builtin" ], [ "status", "ok" ] ], 3, 0, 100) ],
            },
          } ],
        } ],
      },
    ],
  });

  let status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.RepoA.byTool.find((t) => t.tool === "bash")?.count, 5);
  assert.equal(status.usage.byWorkspace.RepoB.byTool.find((t) => t.tool === "bash")?.count, 3);
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "bash")?.count, 8);

  // Workspace 1 sends cumulative 8 at T=200 (delta = 3)
  // Workspace 2 resends cumulative 3 at T=100 (duplicate timestamp -> delta = 0)
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-1" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call",
            sum: {
              aggregationTemporality: 2,
              dataPoints: [ point([ [ "tool", "bash" ], [ "source", "builtin" ], [ "status", "ok" ] ], 8, 0, 200) ],
            },
          } ],
        } ],
      },
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-2" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call",
            sum: {
              aggregationTemporality: 2,
              dataPoints: [ point([ [ "tool", "bash" ], [ "source", "builtin" ], [ "status", "ok" ] ], 3, 0, 100) ],
            },
          } ],
        } ],
      },
    ],
  });

  status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.RepoA.byTool.find((t) => t.tool === "bash")?.count, 8);
  assert.equal(status.usage.byWorkspace.RepoB.byTool.find((t) => t.tool === "bash")?.count, 3);
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "bash")?.count, 11);

  // Resend identical cumulative 8 at T=200 for Workspace 1 (duplicate timestamp)
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      resource: { attributes: attrs([ [ "workspace_id", "ws-1" ] ]) },
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 2,
            dataPoints: [ point([ [ "tool", "bash" ], [ "source", "builtin" ], [ "status", "ok" ] ], 8, 0, 200) ],
          },
        } ],
      } ],
    } ],
  });

  status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.RepoA.byTool.find((t) => t.tool === "bash")?.count, 8);
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "bash")?.count, 11);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("attributes tool call durations per-workspace and preserves global duration metrics", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  registerWorkspaceId("ws-dur-1", "RepoDurA");
  registerWorkspaceId("ws-dur-2", "RepoDurB");

  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const histPoint = (entries, count, sum, start, time) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    count: String(count),
    sum,
  });

  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-dur-1" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call.duration_ms",
            histogram: {
              aggregationTemporality: 1, // DELTA
              dataPoints: [ histPoint([ [ "tool_name", "exec" ], [ "source", "builtin" ] ], 2, 100, 0, 10) ],
            },
          } ],
        } ],
      },
      {
        resource: { attributes: attrs([ [ "workspace_id", "ws-dur-2" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call.duration_ms",
            histogram: {
              aggregationTemporality: 1, // DELTA
              dataPoints: [ histPoint([ [ "tool_name", "exec" ], [ "source", "builtin" ] ], 3, 60, 0, 10) ],
            },
          } ],
        } ],
      },
    ],
  });

  const status = getRouterStatus();
  const toolA = status.usage.byWorkspace.RepoDurA.byTool.find((t) => t.tool === "exec");
  assert.equal(toolA.durationCount, 2);
  assert.equal(toolA.durationMs, 100);
  assert.equal(toolA.averageDurationMs, 50);

  const toolB = status.usage.byWorkspace.RepoDurB.byTool.find((t) => t.tool === "exec");
  assert.equal(toolB.durationCount, 3);
  assert.equal(toolB.durationMs, 60);
  assert.equal(toolB.averageDurationMs, 20);

  const globalTool = status.codexTelemetry.tools.byTool.find((t) => t.tool === "exec");
  assert.equal(globalTool.durationCount, 5);
  assert.equal(globalTool.durationMs, 160);
  assert.equal(globalTool.averageDurationMs, 32);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("fails closed on unknown workspace IDs and ambiguous resource fallbacks with structured diagnostics", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  registerWorkspaceId("ws-known", "KnownRepo");

  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value, start = "0", time = "10") => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value),
  });

  // 1. Data point with an unknown workspace ID fails closed
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1,
            dataPoints: [ point([ [ "tool", "exec" ], [ "source", "builtin" ], [ "workspace_id", "ws-unknown-999" ] ], 2) ],
          },
        } ],
      } ],
    } ],
  });

  let status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.KnownRepo, undefined);
  assert.equal(status.codexTelemetry.tools.byTool.find((t) => t.tool === "exec")?.count, 2);

  let diag = attributionDiagnosticsStatus();
  assert.equal(diag.unattributed, 1);
  assert.equal(diag.byReason.unknown_workspace_id, 1);
  assert.equal(diag.unknownWorkspaceIds.includes("ws-unknown-999"), true);

  // 2. Unambiguous resource fallback succeeds
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      resource: { attributes: attrs([ [ "workspace_id", "ws-known" ] ]) },
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1,
            dataPoints: [ point([ [ "tool", "exec" ], [ "source", "builtin" ] ], 4, 10, 20) ],
          },
        } ],
      } ],
    } ],
  });

  status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.KnownRepo.byTool.find((t) => t.tool === "exec")?.count, 4);
  diag = attributionDiagnosticsStatus();
  assert.equal(diag.attributed, 1);
  assert.equal(diag.bySource.resource, 1);

  // 3. Ambiguous resource fallback (conflicting workspace IDs) fails closed
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      resource: { attributes: attrs([ [ "workspace_id", "ws-known" ], [ "workspace.id", "ws-different" ] ]) },
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1,
            dataPoints: [ point([ [ "tool", "exec" ], [ "source", "builtin" ] ], 1, 20, 30) ],
          },
        } ],
      } ],
    } ],
  });

  diag = attributionDiagnosticsStatus();
  assert.equal(diag.byReason.ambiguous_resource, 1);
  // KnownRepo should not have received the ambiguous call
  assert.equal(status.usage.byWorkspace.KnownRepo.byTool.find((t) => t.tool === "exec")?.count, 4);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("ensures privacy by never leaking local filesystem paths in workspace attribution or diagnostics", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  const secretPath = "/Users/henrykirk/Desktop/SecretProject";
  const context = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspace_id: "/Users/henrykirk/local/ws-id",
      workspaces: {
        [secretPath]: {
          associated_remote_urls: { origin: "https://github.com/Confidential/SecretProject.git" },
        },
      },
    }),
  );

  // Workspace key is privacy-safe repository, and cwd is basename
  assert.equal(context.key, "Confidential/SecretProject");
  assert.equal(context.cwd, "SecretProject");
  // Opaque workspace_id hashes local file path
  assert.equal(context.workspace_id.startsWith("ws_"), true);
  assert.equal(context.workspace_id.includes("/Users/henrykirk"), false);

  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value) => ({
    attributes: attrs(entries),
    startTimeUnixNano: "1",
    timeUnixNano: "2",
    asInt: String(value),
  });

  // OTLP datapoint with unknown path-like workspace_id
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1,
            dataPoints: [ point([ [ "tool", "apply_patch" ], [ "source", "builtin" ], [ "workspace_id", "/Users/henrykirk/Private/Path" ] ], 1) ],
          },
        } ],
      } ],
    } ],
  });

  const status = getRouterStatus();
  const serialized = JSON.stringify({ usage: status.usage, attributionDiagnostics: status.attributionDiagnostics });
  assert.equal(serialized.includes("/Users/henrykirk"), false);
  const diag = attributionDiagnosticsStatus();
  assert.equal(JSON.stringify(diag).includes("/Users/henrykirk"), false);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("persists and restores per-workspace tool and skill attribution across router restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-workspace-attribution-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    resetOtelTelemetry();

    registerWorkspaceId("ws-pers-1", "OwnerA/ProjectA");
    registerWorkspaceId("ws-pers-2", "OwnerB/ProjectB");

    const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
    const point = (entries, value, start, time) => ({
      attributes: attrs(entries),
      startTimeUnixNano: String(start),
      timeUnixNano: String(time),
      asInt: String(value),
    });

    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          resource: { attributes: attrs([ [ "workspace_id", "ws-pers-1" ] ]) },
          scopeMetrics: [ {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [ point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 6, 0, 100) ],
                },
              },
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [ point([ [ "skill", "ccc" ], [ "status", "ok" ] ], 3, 0, 100) ],
                },
              },
            ],
          } ],
        },
      ],
    });

    await persistRouterStateNow(stateFile);

    // Verify persisted schema
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(raw.usage.schemaVersion, 6);
    assert.ok(Array.isArray(raw.usage.workspaceRegistry));
    const savedWs = raw.usage.byWorkspace[ "OwnerA/ProjectA" ];
    assert.equal(savedWs.skillUses, 3);
    assert.equal(savedWs.byTool.find((t) => t.tool === "exec_command")?.count, 6);
    assert.equal(savedWs.bySkill.find((s) => s.skill === "ccc")?.total, 3);

    resetRouterTelemetry();
    resetOtelTelemetry();

    assert.equal(loadRouterState(stateFile), true);

    const restoredStatus = getRouterStatus();
    const restoredWs = restoredStatus.usage.byWorkspace[ "OwnerA/ProjectA" ];
    assert.equal(restoredWs.skillUses, 3);
    assert.equal(restoredWs.byTool.find((t) => t.tool === "exec_command")?.count, 6);
    assert.equal(restoredWs.bySkill.find((s) => s.skill === "ccc")?.total, 3);

    // Subsequent cumulative metric export resumes from persisted series without double-counting
    ingestOtelSignal("metrics", {
      resourceMetrics: [ {
        resource: { attributes: attrs([ [ "workspace_id", "ws-pers-1" ] ]) },
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool.call",
            sum: {
              aggregationTemporality: 2,
              dataPoints: [ point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 9, 0, 200) ],
            },
          } ],
        } ],
      } ],
    });

    const afterResumeStatus = getRouterStatus();
    const afterWs = afterResumeStatus.usage.byWorkspace[ "OwnerA/ProjectA" ];
    assert.equal(afterWs.byTool.find((t) => t.tool === "exec_command")?.count, 9); // 6 + (9 - 6) = 9
  } finally {
    resetRouterTelemetry();
    resetOtelTelemetry();
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
    const forwardedMetadata = JSON.parse(upstreamHeaders[ "x-codex-turn-metadata" ]);
    assert.deepEqual(forwardedMetadata.workspaces, JSON.parse(turnMetadata).workspaces);
    assert.equal(forwardedMetadata.workspace_id, "ws_fe80d628d784");
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
    assert.equal(upstreamHeaders[ "x-codex-turn-metadata" ], JSON.stringify({ ...canonical, workspace_id: "ws_fe80d628d784" }));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
  }
});

test("restores validated workspace metadata on role and concrete continuations", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  };
  const workspace = await mkdtemp(join(tmpdir(), "autodev-workspace-continuity-"));
  const observedHeaders = [];
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  for (const provider of [ "claude", "antigravity", "minimax", "copilot", "codex" ]) clearProviderCooldown(provider);
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      observedHeaders.push(options.headers[ "x-codex-turn-metadata" ] ?? null);
      return new Response(JSON.stringify({ id: "workspace-continuity", output_text: "ok" }), {
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
    const turnMetadata = JSON.stringify({ workspaces: { [workspace]: { git: { branch: "main" } } } });
    for (const [index, model] of ["gemini-3.8-flash-medium", "autodev/default"].entries()) {
      const sessionId = `workspace-continuity-${index}`;
      const send = (headers) => originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": sessionId, ...headers },
        body: JSON.stringify({ model, stream: false }),
      });
      assert.equal((await send({ "x-codex-turn-metadata": turnMetadata })).status, 200);
      assert.equal((await send({})).status, 200);
      const continuedHeader = observedHeaders.at(-1);
      assert.deepEqual(JSON.parse(continuedHeader).workspaces[workspace], {});
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRouterTelemetry();
    await rm(workspace, { recursive: true, force: true });
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
    const forwardedMetadata = JSON.parse(upstreamHeaders[ "x-codex-turn-metadata" ]);
    assert.deepEqual(forwardedMetadata.workspaces, JSON.parse(turnMetadata).workspaces);
    assert.equal(forwardedMetadata.workspace_id, "ws_fe80d628d784");
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
  assert.deepEqual(
    { observed: telemetry.mcpSummary.observed, ready: telemetry.mcpSummary.ready, error: telemetry.mcpSummary.error, stale: telemetry.mcpSummary.stale },
    { observed: 3, ready: 1, error: 0, stale: 1 },
  );
  assert.equal(telemetry.mcpSummary.byModel["gpt-5.6-luna"].observed, 3);
  assert.equal(telemetry.mcpSummary.byRole.unattributed.observed, 3);
  assert.equal(telemetry.mcpSummary.byWorkspace.unattributed.observed, 3);
  assert.equal(telemetry.mcpSummary.byAgent["conversation-otel"].observed, 3);
  const playwright = telemetry.mcpServers.find((server) => server.name === "playwright");
  assert.equal(playwright.health, "ready");
  assert.equal(playwright.initAttempts, 1);
  assert.equal(playwright.toolDiscoveryAttempts, 1);
  assert.equal(playwright.averageDurationMs, 6);
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  assert.equal(codexTelemetryStatus(Date.now() + 121_000).mcpServers.find((server) => server.name === "playwright").health, "stale");
  resetOtelTelemetry();
});

test("normalizes canonical context across tool, hook, and skill telemetry", () => {
  resetOtelTelemetry();
  const attrs = (entries) => entries.map(([key, value]) => ({ key, value: typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) } }));
  const point = (entries, value) => ({ attributes: attrs(entries), startTimeUnixNano: "1000000000", timeUnixNano: "2000000000", asInt: String(value) });
  const common = [["role", "worker"], ["model", "gpt-worker"], ["agent_id", "agent-1"], ["agent_kind", "subagent"], ["session_source", "subagent_thread_spawn_worker"], ["workspace_id", "ws-ctx"]];
  ingestOtelSignal("metrics", {
    resourceMetrics: [{
      scopeMetrics: [{ metrics: [
        { name: "codex.tool.call", sum: { aggregationTemporality: 1, dataPoints: [point([["tool", "exec"], ["source", "builtin"], ...common, ["success", true]], 1)] } },
        { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [point([["hook_name", "SessionStart"], ["source", "user"], ["handler_type", "command"], ...common, ["status", "ok"]], 1)] } },
        { name: "codex.skill.injected", sum: { aggregationTemporality: 1, dataPoints: [point([["skill", "orchestration"], ["status", "injected"], ...common], 1)] } },
      ] }],
    }],
  });
  const dimensions = codexTelemetryStatus().dimensions;
  assert.equal(dimensions.tools.byRole.worker.count, 1);
  assert.equal(dimensions.tools.byWorkspace["ws-ctx"].count, 1);
  assert.equal(dimensions.hooks.byModel["gpt-worker"].count, 1);
  assert.equal(dimensions.skills.byAgent["agent-1"].agentKind, "subagent");
  assert.equal(dimensions.skills.byAgent["agent-1"].count, 1);
  assert.equal(typeof dimensions.tools.byRole.worker.lastSeenAt, "string");
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

test("reads skill names from skillName / skill / skill_name depending on metric source", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const injected = (skillAttribute, value) => ({
    name: "codex.skill.injected",
    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [ {
      attributes: attrs([ [ skillAttribute, "skill-A" ], [ "status", "injected" ] ]),
      startTimeUnixNano: String(start), timeUnixNano: String(start + 1n), asInt: String(value),
    } ] },
  });
  const ingest = (metrics) => ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics } ] } ] });

  // Modern and legacy exporters use skillName, skill, and skill_name.
  ingest([ injected("skillName", 2), injected("skill", 1), injected("skill_name", 1) ]);
  const telemetry = codexTelemetryStatus();
  assert.deepEqual(telemetry.skills.injected.bySkill.map((row) => row.skill), [ "skill-A" ]);
  assert.equal(telemetry.skills.injected.bySkill[ 0 ].total, 4);
  assert.equal(telemetry.skills.usage, undefined);
  resetOtelTelemetry();
});

test("labels all skills without a recognised name 'unknown'", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (attributes, value) => ({
    attributes: attrs(attributes),
    startTimeUnixNano: String(start), timeUnixNano: String(start + 1n), asInt: String(value),
  });
  ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics: [
    { name: "codex.skill.injected", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [
      point([ [ "status", "injected" ] ], 3),
      point([ [ "skillName", "" ], [ "status", "injected" ] ], 1),
      point([ [ "skillName", "   " ], [ "status", "injected" ] ], 1),
    ] } },
  ] } ] } ] });
  const telemetry = codexTelemetryStatus();
  // codex.skill.injected has no recognised fallback contract; the bucket must
  // be "unknown" so callers can tell apart a missing attribute from the
  // explicit literal skill name "unknown".
  assert.equal(telemetry.skills.injected.bySkill.find((row) => row.skill === "unknown")?.total, 5);
  assert.equal(telemetry.skills.usage, undefined);
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

test("ignores shadow-selection diagnostics instead of treating them as skill usage", () => {
  resetOtelTelemetry();
  const histogram = (name, count, sum, time) => ({
    name,
    histogram: { aggregationTemporality: 2, dataPoints: [ { attributes: [], startTimeUnixNano: "1", timeUnixNano: String(time), count: String(count), sum } ] },
  });
  const ingest = (metrics) => ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics } ] } ] });
  const removed = [
    "codex.skills.shadow_selection",
    "codex.skills.shadow_selection.invocation",
    "codex.skills.shadow_selection.catalog_entries",
    "codex.skills.shadow_selection.selected_entries",
    "codex.skills.shadow_selection.query_terms",
    "codex.skills.shadow_selection.reduction_bps",
    "codex.skills.shadow_selection.duration_ms",
  ];
  ingest(removed.map((name) => name.endsWith("invocation")
    ? { name, sum: { aggregationTemporality: 2, dataPoints: [ { attributes: [], startTimeUnixNano: "1", timeUnixNano: "10", asInt: "3" } ] } }
    : histogram(name, 1, 8, 10)));
  ingest([ histogram("codex.skill.turn.duration_seconds", 2, 200, 10) ]);

  const skills = codexTelemetryStatus();
  assert.equal(skills.skills.usage, undefined);
  assert.deepEqual(skills.skills.turnDuration.durationSeconds, { count: 2, sum: 200, average: 100 });
  assert.equal(skills.metrics.observed.some(({ name }) => removed.includes(name)), false);
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

test("reads tool names from tool / toolName / tool_name and shows real names in the dashboard buckets", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start), timeUnixNano: String(start + 1n), asInt: String(value),
  });
  ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics: [ {
    name: "codex.tool.call",
    sum: { aggregationTemporality: 1, dataPoints: [
      point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 4),
      point([ [ "toolName", "apply_patch" ], [ "source", "builtin" ], [ "status", "ok" ] ], 2),
      point([ [ "toolName", "" ], [ "source", "builtin" ], [ "status", "ok" ] ], 1),
      point([ [ "toolName", "   " ], [ "source", "builtin" ], [ "status", "ok" ] ], 1),
    ] },
  } ] } ] } ] });
  const telemetry = codexTelemetryStatus();
  // Both modern and legacy spellings resolve to their real tool name; the dashboard
  // would otherwise show every row collapsed under the fallback bucket.
  const execRow = telemetry.tools.byTool.find((row) => row.tool === "exec_command");
  assert.equal(execRow?.count, 4);
  const applyPatchRow = telemetry.tools.byTool.find((row) => row.tool === "apply_patch");
  assert.equal(applyPatchRow?.count, 2);
  // Empty or whitespace-only names fall back to "unknown-tool" so genuinely
  // missing attributes are still visible in the dashboard rather than silently
  // dropped. With cumulative-temporality dedupe, the two empty rows collapse
  // into one because they share the same series key.
  const unknownRow = telemetry.tools.byTool.find((row) => row.tool === "unknown-tool");
  assert.equal(unknownRow?.count, 1);
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
          { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [ dataPoint([ [ "hook_name", "SessionStart" ], [ "source", "user" ], [ "handler_type", "command" ], [ "status", "ok" ] ], 2) ] } },
          { name: "codex.hooks.run.duration_ms", histogram: { aggregationTemporality: 1, dataPoints: [ histogramPoint([ [ "hook_name", "SessionStart" ], [ "source", "user" ], [ "handler_type", "command" ] ], 2, 20) ] } },
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
          { name: "codex.hooks.run", histogram: { aggregationTemporality: 1, dataPoints: [ point([ [ "hook_name", "SessionEnd" ], [ "source", "user" ], [ "handler_type", "command" ], [ "status", "ok" ] ], 2) ] } },
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

test("uses canonical source attribute for hook identity so project and user hooks stay separate", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start), timeUnixNano: String(start + 1n), asInt: String(value),
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.hooks.run",
          sum: {
            aggregationTemporality: 1, dataPoints: [
              point([ [ "hook_name", "SessionStart" ], [ "source", "project" ], [ "handler_type", "command" ] ], 2),
              point([ [ "hook_name", "SessionStart" ], [ "source", "user" ], [ "handler_type", "command" ] ], 5),
            ]
          },
        } ]
      } ]
    } ]
  });
  const telemetry = codexTelemetryStatus();
  const projectHook = telemetry.hooks.byHook.find((entry) => entry.source === "project");
  assert.equal(projectHook.count, 2);
  const userHook = telemetry.hooks.byHook.find((entry) => entry.source === "user");
  assert.equal(userHook.count, 5);
  assert.equal(telemetry.hooks.byHook.length, 2);
  resetOtelTelemetry();
});

test("normalizes Codex tool success boolean into ok and error status buckets", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const point = (entries, value, offset) => ({
    attributes: entries,
    startTimeUnixNano: String(start + offset), timeUnixNano: String(start + offset + 1n), asInt: String(value),
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1, dataPoints: [
              point([ { key: "tool", value: { stringValue: "exec_command" } }, { key: "source", value: { stringValue: "builtin" } }, { key: "success", value: { boolValue: true } } ], 3, 0n),
              point([ { key: "tool", value: { stringValue: "exec_command" } }, { key: "source", value: { stringValue: "builtin" } }, { key: "success", value: { boolValue: false } } ], 1, 2n),
              point([ { key: "tool", value: { stringValue: "exec_command" } }, { key: "source", value: { stringValue: "builtin" } }, { key: "success", value: { stringValue: "true" } } ], 2, 4n),
              point([ { key: "tool", value: { stringValue: "exec_command" } }, { key: "source", value: { stringValue: "builtin" } } ], 2, 6n),
            ]
          },
        } ]
      } ]
    } ]
  });
  const telemetry = codexTelemetryStatus();
  const exec = telemetry.tools.byTool.find((entry) => entry.tool === "exec_command");
  // boolean or string success=true → ok, success=false → error, missing → unknown.
  // Without normalization, Codex's string-encoded success would be lost.
  assert.deepEqual(exec.byStatus, { ok: 5, error: 1, unknown: 2 });
  resetOtelTelemetry();
});

test("reads tool server metadata from server / mcp_server without inferring it from the tool name", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
  const point = (entries, value) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start), timeUnixNano: String(start + 1n), asInt: String(value),
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool.call",
          sum: {
            aggregationTemporality: 1, dataPoints: [
              point([ [ "tool", "playwright_navigate" ], [ "source", "mcp" ], [ "mcp_server", "playwright" ] ], 1),
              point([ [ "tool", "playwright_navigate" ], [ "source", "mcp" ], [ "server", "playwright-alt" ] ], 2),
              point([ [ "tool", "playwright_navigate" ], [ "source", "mcp" ] ], 3),
              point([ [ "tool", "codex_apps_search" ], [ "source", "mcp" ], [ "server", "codex_apps" ] ], 4),
            ]
          },
        } ]
      } ]
    } ]
  });
  const telemetry = codexTelemetryStatus();
  const byServer = Object.fromEntries(telemetry.tools.byTool.filter((entry) => entry.tool === "playwright_navigate").map((entry) => [ entry.server, entry.count ]));
  assert.deepEqual(byServer, { playwright: 1, "playwright-alt": 2, "": 3 });
  // The router never guesses that "playwright_navigate" belongs to the
  // playwright server just because of the prefix.
  assert.equal(telemetry.tools.byTool.find((entry) => entry.tool === "codex_apps_search").server, "codex_apps");
  resetOtelTelemetry();
});

test("drops persisted hook and tool aggregates when the OTEL persistence schema bumps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-hook-schema-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetOtelTelemetry();
    ingestOtelSignal("metrics", {
      resourceMetrics: [ {
        scopeMetrics: [ {
          metrics: [
            { name: "codex.tool.call", sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "tool", value: { stringValue: "legacy_tool" } }, { key: "source", value: { stringValue: "builtin" } }, { key: "success", value: { boolValue: true } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "3" } ] } },
            { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "hook_name", value: { stringValue: "LegacyHook" } }, { key: "source", value: { stringValue: "project" } }, { key: "handler_type", value: { stringValue: "command" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" } ] } },
          ]
        } ]
      } ]
    });
    await persistRouterStateNow(stateFile);
    resetOtelTelemetry();
    // Simulate a stale snapshot from before the schema bump: the previous
    // router version persisted under schemaVersion 1 with source and
    // server_name attributes. The current router must treat that file as
    // incompatible and discard every hook/tool aggregate so the next export
    // is not silently mixed with old counts.
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    raw.otelTelemetry.schemaVersion = 1;
    await writeFile(stateFile, JSON.stringify(raw), "utf8");
    assert.equal(loadRouterState(stateFile), true);
    const discarded = getRouterStatus().codexTelemetry;
    assert.equal(discarded.tools.byTool.length, 0);
    assert.equal(discarded.hooks.byHook.length, 0);
    // Schema 2 snapshots written by the current router still restore cleanly
    // with the canonical source and server metadata attributes.
    ingestOtelSignal("metrics", {
      resourceMetrics: [ {
        scopeMetrics: [ {
          metrics: [ { name: "codex.hooks.run", sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "hook_name", value: { stringValue: "SessionStart" } }, { key: "source", value: { stringValue: "project" } }, { key: "handler_type", value: { stringValue: "command" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" } ] } } ]
        } ]
      } ]
    });
    await persistRouterStateNow(stateFile);
    resetOtelTelemetry();
    assert.equal(loadRouterState(stateFile), true);
    const restored = getRouterStatus().codexTelemetry;
    assert.equal(restored.hooks.byHook.length, 1);
    assert.equal(restored.hooks.byHook[ 0 ].source, "project");
    assert.equal(restored.hooks.byHook[ 0 ].count, 1);
  } finally {
    resetOtelTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracks router-visible subagent spawn failure reasons", () => {
  resetRouterTelemetry();
  recordSpawnFailure({ requestId: "req-provider-failed", role: "worker", requestedModel: "autodev/worker", reason: "provider_exhausted" });
  const failures = spawnFailureStatus();
  assert.equal(failures.scope, "router-admitted-child-requests");
  assert.equal(failures.total, 1);
  assert.equal(failures.byReason.provider_exhausted, 1);
  assert.equal(failures.recent[ 0 ].requestId, "req-provider-failed");
  resetRouterTelemetry();
});

test("serves the live component dashboard and keeps /status raw JSON", async () => {
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type"), /text\/html/);
    const dashboardBody = (await dashboard.text()).replace(/\s+/g, " ").replace(/>\s+</g, "><");

    // The dashboard is a live view: it fetches the raw status endpoint on load
    // and polls it without putting a second data contract in the HTML.
    assert.match(dashboardBody, /fetch\("\/status", \{ cache: "no-store", headers: \{ Accept: "application\/json" \} \}\)/);
    assert.match(dashboardBody, /refresh\(\); setInterval\(refresh, 3000\)/);

    // Top-level panels define the reference hierarchy. Nested panels are part
    // of their owning domain rather than independent dashboard sections.
    const panels = [...dashboardBody.matchAll(/<dashboard-panel id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(panels, [
      "panel-providers",
      "panel-orchestrator",
      "workspace-usage-section",
      "panel-skills",
      "panel-hooks",
      "panel-ops",
      "panel-codex-state",
      "panel-events",
    ]);
    assert.match(dashboardBody, /<dashboard-panel id="panel-orchestrator"[\s\S]*?<sub-panel id="panel-spawn-breakdown"/);
    assert.match(dashboardBody, /<sub-panel id="panel-spawn-breakdown"[\s\S]*?<sub-panel id="panel-spawn-failures"/);
    assert.match(dashboardBody, /<dashboard-panel id="panel-skills"[\s\S]*?<sub-panel id="panel-skill-context"/);
    assert.match(dashboardBody, /<dashboard-panel id="panel-ops"[\s\S]*?<sub-panel id="panel-native-metrics"/);

    // Rendering is componentized, and untrusted live labels have an explicit
    // escaping path. Event text and status metadata use textContent directly.
    for (const component of [
      "status-badge", "health-badge", "stat-card", "mini-stat", "outcome-bar",
      "metric-bar", "share-bar", "row-toggle", "dashboard-panel", "sub-panel",
    ]) {
      assert.match(dashboardBody, new RegExp(`customElements\\.define\\("${component}"`));
    }
    assert.match(dashboardBody, /function escapeHtml\(str\)/);
    assert.match(dashboardBody, /escapeHtml\(providerName\)/);
    assert.match(dashboardBody, /escapeHtml\(wsKey\)/);
    assert.match(dashboardBody, /escapeHtml\(m\.name\)/);
    assert.match(dashboardBody, /m\.exports \?\? 0/);
    assert.match(dashboardBody, /m\.dataPoints \?\? 0/);
    assert.match(dashboardBody, /status\.concurrency \?\? \{\}/);
    assert.match(dashboardBody, /const toolsList = status\.codexTelemetry\?\.tools\?\.byTool \?\? \[\]/);
    assert.doesNotMatch(dashboardBody, /exportCount|dataPointsCount|codexTelemetry\?\.concurrency/);
    assert.match(dashboardBody, /logEl\.textContent = events\.map/);
    assert.match(dashboardBody, /metaEl\.textContent/);
    assert.match(dashboardBody, /errorEl\.textContent/);
    assert.doesNotMatch(dashboardBody, /document\.write\s*\(/);

    // MCP observations are embedded in the relevant usage/operational views;
    // there is deliberately no standalone MCP panel.
    assert.match(dashboardBody, /MCP servers/);
    assert.match(dashboardBody, /MCP ready \/ observed/);
    assert.doesNotMatch(dashboardBody, /<(?:dashboard-panel|sub-panel)[^>]*(?:id="[^"]*mcp|title="[^"]*MCP)/i);

    // Workspace-level named attribution is not available from the status
    // contract. The renderer must show explicit empty states, not fabricate it.
    assert.match(dashboardBody, /Named tool telemetry is unavailable per-workspace/);
    assert.match(dashboardBody, /Named skill attribution is unavailable per-workspace/);

    const browserStatus = await fetch(`http://127.0.0.1:${address.port}/status`, { headers: { Accept: "text/html" } });
    assert.equal(browserStatus.status, 200);
    assert.match(browserStatus.headers.get("content-type"), /application\/json/);
    const browserPayload = await browserStatus.json();
    assert.equal(browserPayload.schema, "autodev-router-status-v2");
    assert.doesNotMatch(JSON.stringify(browserPayload), /<html/i);
    assertNoLeakedPaths(browserPayload);

    // Accept negotiation remains intentionally inert: both callers receive
    // the same JSON shape even though the dashboard asks for HTML first.
    const api = await fetch(`http://127.0.0.1:${address.port}/status`, { headers: { Accept: "application/json" } });
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type"), /application\/json/);
    const apiPayload = await api.json();
    assert.equal(apiPayload.schema, browserPayload.schema);
    assert.deepEqual(Object.keys(apiPayload).sort(), Object.keys(browserPayload).sort());
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
    assert.equal(status.schema, "autodev-router-status-v2");
    assert.equal(Object.hasOwn(status, "codexTasks"), false);
    assert.equal(status.providers.claude.configuredModels.default, "sonnet");
    assert.equal(Object.hasOwn(status, "prompt"), false);
    assert.equal(Object.hasOwn(status.providers.claude, "apiKey"), false);
    // Internal absolute paths (STATE_FILE, CONCURRENCY_CONFIG.file) stay
    // operational for the process itself; only their public /status
    // representation is redacted to safe booleans/source metadata.
    assert.equal(Object.hasOwn(status.telemetryPersistence, "file"), false);
    assert.equal(typeof status.telemetryPersistence.source, "string");
    assert.equal(typeof status.telemetryPersistence.exists, "boolean");
    assert.equal(Object.hasOwn(status.concurrency, "configFile"), false);
    assert.equal(typeof status.concurrency.configSource, "string");
    assert.equal(typeof status.concurrency.configFileExists, "boolean");
    assertNoLeakedPaths(status);
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
          }, {
            name: "codex.hooks.run",
            sum: { aggregationTemporality: 1, dataPoints: [ { attributes: [ { key: "hook_name", value: { stringValue: "SessionStart" } }, { key: "source", value: { stringValue: "user" } }, { key: "handler_type", value: { stringValue: "command" } }, { key: "status", value: { stringValue: "ok" } } ], startTimeUnixNano: "1", timeUnixNano: "2", asInt: "1" } ] },
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
    assert.equal(restored.codexTelemetry.skills.usage, undefined);
    assert.deepEqual(restored.codexTelemetry.skills.turnDuration.durationSeconds, { count: 0, sum: 0, average: 0 });
    assert.equal(restored.codexTelemetry.skills.injected.bySkill[ 0 ].skill, "orchestration");
    assert.deepEqual(restored.codexTelemetry.skills.injected.bySkill[ 0 ].byInvokeType, { implicit: 2 });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byAgentKind, { unattributed: 2 });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byModel, { unattributed: 2 });
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

test("drops removed shadow-selection telemetry from persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-skill-migration-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    resetOtelTelemetry();
    const state = JSON.parse(serializeRouterState());
    state.otelTelemetry.skills.usage = { total: 7, bySkill: [ { skill: "orchestration", total: 7 } ] };
    state.otelTelemetry.skills.selection = { catalogEntries: { count: 1, sum: 20 } };
    state.otelTelemetry.metrics = { observed: [
      { name: "codex.skills.shadow_selection", exports: 1, dataPoints: 1 },
      { name: "codex.skills.shadow_selection.invocation", exports: 1, dataPoints: 1 },
    ] };
    await writeFile(stateFile, JSON.stringify(state), "utf8");
    assert.equal(loadRouterState(stateFile), true);
    const telemetry = getRouterStatus().codexTelemetry;
    assert.equal(telemetry.skills.usage, undefined);
    assert.equal(telemetry.skills.selection, undefined);
    assert.equal(telemetry.metrics.observed.some(({ name }) => name.startsWith("codex.skills.shadow_selection")), false);
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
  assert.equal(status.scope, "router-admitted-child-requests");
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
      assert.equal(persisted.schema, "autodev-router-persisted-state-v2");
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


// --- provider exhaustion: keeping the caller's turn alive ------------------
//
// A cooldown is load-shedding advice, not proof a provider is dead. The router
// used to enforce it as though it were: every candidate cooling meant nothing
// was attempted and the caller's turn ended on a 503 listing four providers as
// "cooldown active". The tests below pin the three ways out of that -- a bounded
// last-resort pass, a bounded wait for a cooldown about to lapse, and an error
// that actually says what to do -- and the limits on each.

const PROVIDER_KEYS = [ "LITELLM_API_KEY", "MINIMAX_API_KEY", "CODEX_ROUTER_COPILOT_API_KEY" ];

/**
 * Run `body` with every provider credential present and fetch stubbed.
 * `prepare` runs after telemetry is reset, which is where cooldown setup has to
 * go: resetRouterTelemetry clears the cooldown map.
 */
async function withStubbedProviders(stub, body, prepare = () => {}) {
  const originalFetch = globalThis.fetch;
  const originalCredentials = Object.fromEntries(PROVIDER_KEYS.map((key) => [ key, process.env[ key ] ]));
  for (const key of PROVIDER_KEYS) process.env[ key ] = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  prepare();
  globalThis.fetch = async (url, options) => stub(String(url), options) ?? originalFetch(url, options);
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await body({ port: server.address().port, fetch: originalFetch });
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
}

const healthyProbe = (target) => (target.endsWith("/health") || target.endsWith("/health/liveliness") ? new Response("ok", { status: 200 }) : null);
const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const DEFAULT_TIER = [ "claude", "antigravity", "minimax", "copilot", "codex" ];

test("attempts a cooling provider as a last resort rather than stranding the caller", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? (responseCalls += 1, jsonResponse({ id: "last-resort", model: "sonnet", output_text: "served" }))
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "last-resort-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 200, "a soft cooldown must not be an absolute bar");
      assert.equal(responseCalls, 1);
      assert.ok(getRouterStatus().recentEvents.some((event) => event.selection === "last_resort"), "the last-resort pass must be visible in the event log");
      // Serving clears the cooldown: the chain heals itself.
      assert.equal(isProviderCoolingDown(response.headers.get("x-autodev-provider")), false);
    },
    // Out of usage with no stated reset: the 15-minute floor is the router's own
    // guess, so a last resort may still challenge it -- and it is far enough out
    // that the bounded wait cannot fire and confuse what is being measured.
    () => { for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "quota_exhausted", structured: true }); },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("bounds how many cooling providers the last-resort pass will try", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? (responseCalls += 1, new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 }))
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "last-resort-cap" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 503);
      // Five cooling candidates, but the pass is capped: falling back to fumes
      // must not become a way to hammer everything that is already struggling.
      assert.equal(responseCalls, 2);
      assert.equal((await response.json()).error.details.lastResortAttempts, 2);
    },
    () => { for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "quota_exhausted", structured: true }); },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("never re-attempts a provider that stated a reset time still in the future", async () => {
  let responseCalls = 0;
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/") ? (responseCalls += 1, jsonResponse({ id: "x" })) : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "hard-limit-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 503);
      // The providers said they will not serve until the reset. Attempting them
      // anyway is guaranteed to fail and is exactly the hammering a cooldown
      // exists to prevent.
      assert.equal(responseCalls, 0);
      const body = await response.json();
      assert.equal(body.error.details.recommendedAction, "summarize_and_yield");
      assert.equal(body.error.details.resetsAt, resetsAt);
      assert.equal(body.error.failureClass, "quota_exhausted");
      assert.match(body.error.message, /Return a summary of the work completed so far/);
      assert.equal(response.headers.get("x-autodev-limit-resets-at"), resetsAt);
      assert.equal(response.headers.get("x-autodev-limit-class"), "quota_exhausted");
      for (const entry of body.error.details.providers) assert.equal(entry.state, "hard");
    },
    () => { for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "quota_exhausted", resetsAt, structured: true }); },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("waits out a cooldown that is about to lapse instead of ending the turn", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? (responseCalls += 1, jsonResponse({ id: "after-wait", model: "sonnet", output_text: "served" }))
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "wait-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 200);
      assert.equal(responseCalls, 1);
      assert.ok(getRouterStatus().recentEvents.some((event) => event.phase === "exhaustion_wait"));
    },
    // A stated reset moments away. The last-resort pass will not touch it -- the
    // provider has said it will not serve yet -- so the wait is the only thing
    // that can save this turn.
    () => {
      const resetsAt = new Date(Date.now() + 250).toISOString();
      for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "quota_exhausted", resetsAt, structured: true });
    },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("a provider whose bridge is down does not consume the attempt the wait bought", async () => {
  let responseCalls = 0;
  // Only MiniMax's bridge is up. Whatever order the tier shuffles into, every
  // other candidate fails its health probe first.
  const MINIMAX_PORT = "18765";
  await withStubbedProviders(
    (target) => {
      if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
        return new Response("", { status: target.includes(MINIMAX_PORT) ? 200 : 503 });
      }
      if (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")) {
        responseCalls += 1;
        return jsonResponse({ id: "after-wait", model: "m", output_text: "served" });
      }
      return null;
    },
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "wait-skip-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      // A candidate whose bridge did not answer was never asked anything, so it
      // must not consume the single attempt the wait bought. Spending it on a
      // health probe wasted the whole wait.
      assert.equal(response.status, 200);
      assert.equal(responseCalls, 1);
      assert.equal(response.headers.get("x-autodev-provider"), "minimax");
    },
    () => {
      const resetsAt = new Date(Date.now() + 250).toISOString();
      for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "session_limit", resetsAt, structured: true });
    },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("does not wait for a cooldown that is nowhere near lapsing", async () => {
  const startedAt = Date.now();
  const resetsAt = new Date(startedAt + 3_600_000).toISOString();
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") ? jsonResponse({ id: "never" }) : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "no-wait-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 503);
      // An hour is not something to hold a subagent slot for.
      assert.ok(Date.now() - startedAt < 5_000, "the router must not hold the request for a distant reset");
    },
    () => { for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "session_limit", resetsAt, structured: true }); },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("holds a provider until the reset time it declared in its response", async () => {
  const resetsAt = new Date(Date.now() + 7_200_000).toISOString();
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? new Response(JSON.stringify({ error: { message: "out of usage", type: "rate_limit_error" } }), {
        status: 429,
        headers: { "x-autodev-limit-class": "quota_exhausted", "x-autodev-limit-type": "weekly", "x-autodev-limit-resets-at": resetsAt, "x-autodev-limit-source": "reported" },
      })
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "declared-limit-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 503);
      const claude = getRouterStatus().providers.claude;
      // The provider's own word, not a 30s guess doubling toward ten minutes.
      assert.equal(claude.cooldownKind, "hard");
      assert.equal(claude.cooldownResetsAt, resetsAt);
      assert.equal(claude.cooldownUntil, resetsAt);
      assert.equal(claude.lastResortEligible, false);
    },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("a turn a provider closed as incomplete reaches the caller and cools on the reported class", async () => {
  const resetsAt = new Date(Date.now() + 5_400_000).toISOString();
  const incomplete = [
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message"}}',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"half a result"}',
    `data: {"type":"response.completed","response":{"id":"resp_1","status":"incomplete","output_text":"half a result","incomplete_details":{"reason":"provider_limit","provider_limit":{"class":"session_limit","type":"session","resets_at":"${resetsAt}","source":"reported"}}}}`,
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? new Response(incomplete, { status: 200, headers: { "content-type": "text/event-stream" } })
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "incomplete-test" },
        body: JSON.stringify({ model: "autodev/default", stream: true }),
      });
      const body = await response.text();
      // The work the child did reaches the parent; it is not replaced by an
      // error string, and it is not replayed on another provider either --
      // a stream cannot be taken back once it has started.
      assert.match(body, /half a result/);
      const served = response.headers.get("x-autodev-provider");
      const provider = getRouterStatus().providers[ served ];
      assert.equal(provider.cooldownKind, "hard", "an incomplete turn is still a provider failure");
      assert.equal(provider.cooldownResetsAt, resetsAt);
      assert.equal(provider.failures, 1);
    },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("closes an abandoned stream as incomplete, carrying what it already forwarded", async () => {
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
  const truncated = [
    'data: {"type":"response.created","response":{"id":"resp_2"}}',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_2","type":"message"}}',
    'data: {"type":"response.output_text.delta","item_id":"msg_2","delta":"work in progress"}',
  ].join("\n\n") + "\n\n";
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") || target.startsWith("https://chatgpt.com/")
      ? new Response(truncated, { status: 200, headers: { "content-type": "text/event-stream" } })
      : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "truncated-test" },
        body: JSON.stringify({ model: "autodev/default", stream: true }),
      });
      const body = await response.text();
      // A stream that just stops is indistinguishable from a hung provider.
      // The router closes it itself, and the partial work survives.
      assert.match(body, /"status":"incomplete"/);
      assert.match(body, /"reason":"provider_interrupted"/);
      assert.match(body, /work in progress/);
      assert.doesNotMatch(body, /closed the stream before response\.completed/);
    },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
});

test("releases the subagent slot when every provider is exhausted", async () => {
  resetConcurrencyTelemetry();
  await withStubbedProviders(
    (target) => healthyProbe(target) ?? (target.endsWith("/responses") ? jsonResponse({ id: "never" }) : null),
    async ({ port, fetch: realFetch }) => {
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-session-id": "slot-release-test" },
        body: JSON.stringify({ model: "autodev/default", stream: false }),
      });
      assert.equal(response.status, 503);
      // A wedged or exhausted child must not hold a slot: with a per-session
      // limit of two, two of those end delegation for the session.
      assert.equal(concurrencyStatus().activeSubagentThreads, 0);
      assert.equal(concurrencyStatus().activeSessions, 0);
    },
    // A broken credential: never retried as a last resort, so this exhausts
    // immediately and the only question is whether the slot came back.
    () => { for (const provider of DEFAULT_TIER) cooldownProvider(provider, { failureClass: "authentication" }); },
  );
  for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
  resetConcurrencyTelemetry();
});

test("only a provider-declared cooldown survives a router restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-cooldown-state-"));
  const file = join(directory, "state.json");
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  try {
    resetRouterTelemetry();
    cooldownProvider("claude", { failureClass: "quota_exhausted", resetsAt, structured: true });
    cooldownProvider("minimax", {});
    cooldownProvider("copilot", { failureClass: "probe_unavailable" });
    await writeFile(file, serializeRouterState(), "utf8");

    resetRouterTelemetry();
    assert.equal(loadRouterState(file), true);
    const providers = getRouterStatus().providers;
    // The provider said it is out until the reset, and a launchd restart does
    // not change that. The router's own guesses about a moment that has passed
    // are worth re-checking, so they are not carried over.
    assert.equal(providers.claude.cooldownKind, "hard");
    assert.equal(providers.claude.cooldownResetsAt, resetsAt);
    assert.equal(providers.minimax.cooldownUntil, null);
    assert.equal(providers.copilot.cooldownUntil, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
    for (const provider of DEFAULT_TIER) clearProviderCooldown(provider);
    resetRouterTelemetry();
  }
});

test("an added section does not throw away the history already persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-state-schema-"));
  const file = join(directory, "state.json");
  try {
    resetRouterTelemetry();
    // A file written before provider cooldowns were persisted at all. Adding a
    // section used to bump a global schema stamp, which made the loader discard
    // the whole file -- so one additive change silently wiped every counter the
    // router had. Restoring is per-section now.
    const older = JSON.parse(serializeRouterState());
    older.schema = "autodev-router-persisted-state-v1";
    delete older.providerCooldowns;
    older.subagents = { total: 7, byMechanism: { bridge_native: 7 }, byProvider: { antigravity: 7 }, byRole: {}, byStatus: {}, recent: [] };
    older.spawnFailures = { total: 2, byReason: { provider_exhausted: 2 }, recent: [] };
    await writeFile(file, JSON.stringify(older), "utf8");

    resetRouterTelemetry();
    assert.equal(loadRouterState(file), true, "an envelope this router wrote must still load");
    assert.equal(subagentStatus().total, 7, "subagent history survives an unrelated addition");
    assert.equal(spawnFailureStatus().total, 2);

    // A file that is not this router's state at all is still refused.
    await writeFile(file, JSON.stringify({ schema: "something-else", subagents: { total: 99 } }), "utf8");
    resetRouterTelemetry();
    assert.equal(loadRouterState(file), false);
    assert.equal(subagentStatus().total, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    resetRouterTelemetry();
  }
});

test("reads a declared limit from headers or from the error body", () => {
  const resetsAt = "2026-09-06T15:40:00.000Z";
  const fromHeaders = declaredLimit(new Headers({ "x-autodev-limit-class": "session_limit", "x-autodev-limit-resets-at": resetsAt, "x-autodev-limit-source": "reported" }), "");
  assert.equal(fromHeaders.limitClass, "session_limit");
  assert.equal(fromHeaders.resetsAt, resetsAt);
  assert.equal(fromHeaders.source, "reported");

  const fromBody = declaredLimit(new Headers(), JSON.stringify({ error: { limit: { class: "quota_exhausted", resets_at: resetsAt, source: "reported" } } }));
  assert.equal(fromBody.limitClass, "quota_exhausted");
  assert.equal(fromBody.resetsAt, resetsAt);

  // A provider that declared nothing must not be read as declaring something:
  // that is what leaves the router guessing from prose.
  assert.equal(declaredLimit(new Headers(), "you have exceeded your quota"), null);
  assert.equal(declaredLimit(new Headers(), "not json at all"), null);
});

test("summarizes every candidate's cooldown for the exhaustion body", () => {
  const now = 1_000_000;
  try {
    const resetsAt = new Date(now + 600_000).toISOString();
    cooldownProvider("claude", { now, failureClass: "quota_exhausted", resetsAt, structured: true });
    cooldownProvider("minimax", { now });
    const summary = providerCooldownSummary([ "claude", "minimax", "codex" ], now + 1);
    assert.deepEqual(summary.map(({ provider, state }) => [ provider, state ]), [ [ "claude", "hard" ], [ "minimax", "transient" ], [ "codex", "available" ] ]);
    assert.equal(summary[ 0 ].resetsAt, resetsAt);
    assert.equal(summary[ 1 ].retryAfterMs, 29_999);
    assert.equal(cooldownAllowsLastResort(null), true);
  } finally {
    clearProviderCooldown("claude");
    clearProviderCooldown("minimax");
  }
});

test("a bridge is told which Codex conversation it is serving, and how sure the router is", () => {
  // A bridge that drives Codex's own spawner has to split one CLI turn across
  // two requests, so it needs to recognise the continuation as the same
  // conversation. Codex serves its own children and is never told.
  const claude = downstreamHeaders({ provider: "claude", envKey: "LITELLM_API_KEY" }, {}, null, "orchestrator", "req-1", { key: "sess-1", scope: "identified" });
  assert.equal(claude[ SESSION_ID_HEADER ], "sess-1");
  assert.equal(claude[ SESSION_SCOPE_HEADER ], "identified");

  const codex = downstreamHeaders({ provider: "codex" }, { token: "t", accountId: "a" }, null, "orchestrator", "req-1", { key: "sess-1", scope: "identified" });
  assert.equal(codex[ SESSION_ID_HEADER ], undefined);

  // The scope is what stops a bridge holding CLI state under the router's
  // process-wide fallback key, where two unrelated conversations would share
  // one process and see each other's work.
  const unidentified = downstreamHeaders({ provider: "claude", envKey: "LITELLM_API_KEY" }, {}, null, "orchestrator", "req-1", { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" });
  assert.equal(unidentified[ SESSION_SCOPE_HEADER ], "process-fallback");

  // No session resolved at all means no header, not an empty one.
  const none = downstreamHeaders({ provider: "claude", envKey: "LITELLM_API_KEY" }, {}, null, "orchestrator", "req-1", null);
  assert.equal(none[ SESSION_ID_HEADER ], undefined);
  assert.equal(none[ SESSION_SCOPE_HEADER ], undefined);
});

test("the session headers are router-generated and never forwarded from the client", () => {
  // Same trust argument as the agent role: a bridge acts on these, so a client
  // must not be able to name someone else's session.
  assert.equal(FORWARDED_REQUEST_HEADERS.includes(SESSION_ID_HEADER), false);
  assert.equal(FORWARDED_REQUEST_HEADERS.includes(SESSION_SCOPE_HEADER), false);
});

test("a turn continuing a tool call is recognised as one", () => {
  assert.equal(carriesPendingToolResult({ input: [ { type: "custom_tool_call_output", call_id: "c1", output: "x" } ] }), true);
  assert.equal(carriesPendingToolResult({ input: [ { type: "function_call_output", call_id: "c1", output: "x" } ] }), true);
  assert.equal(carriesPendingToolResult({ input: [ { type: "message", role: "user", content: [] } ] }), false);
  assert.equal(carriesPendingToolResult({}), false);
  assert.equal(carriesPendingToolResult(null), false);
});

test("a continuation prefers the provider still holding the turn, without pinning to it", () => {
  // The bridge that made the tool call is holding a live CLI for the answer.
  // Sending the continuation elsewhere strands it and loses the turn's work.
  const providers = (list) => list.map((c) => c.provider);
  const plain = orchestratorCandidates(() => 0);
  assert.ok(plain.length > 1, "this test needs a multi-provider orchestrator tier");

  const last = plain.at(-1).provider;
  const hoisted = orchestratorCandidates(() => 0, last);
  assert.equal(hoisted[ 0 ].provider, last, "the holding provider is tried first");
  // Still a preference, not a pin: every candidate survives, exactly once, so
  // the chain can still degrade if that provider is down.
  assert.deepEqual([ ...providers(hoisted) ].sort(), [ ...providers(plain) ].sort());
  assert.equal(new Set(providers(hoisted)).size, hoisted.length);

  // An unknown or already-first preference changes nothing.
  assert.deepEqual(providers(orchestratorCandidates(() => 0, "not-a-provider")), providers(plain));
  assert.deepEqual(providers(orchestratorCandidates(() => 0, plain[ 0 ].provider)), providers(plain));
  assert.deepEqual(providers(orchestratorCandidates(() => 0, null)), providers(plain));
});

// A turn served by a provider that mints ids the Responses contract rejects
// poisons the session permanently: Codex stores what it was handed and replays
// it on every later turn, so the first request that lands on a provider which
// validates fails, and so does every request after it.
test("outbound item ids are corrected to match their item type", () => {
  const poisoned = [
    { type: "message", id: "msg_1", role: "user", content: [] },
    { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs" },
    { type: "custom_tool_call", id: "06ef3bc08924acade1facee14da0af2e_fc_0", call_id: "call_8ec20ad454e0460d9d4b6662", name: "exec", input: "text()" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_8ec20ad454e0460d9d4b6662", output: "ok" },
  ];

  // Non-Codex providers preserve reasoning items with their minted IDs for continuity,
  // while self-contained items like tool calls are normalized.
  for (const model of [ "MiniMax-M3", "sonnet" ]) {
    const route = routeForModel(model);
    const sent = upstreamPayload(route, { model, input: poisoned }, true);
    assert.equal(sent.input.length, 4);
    assert.equal(sent.input[ 0 ].id, "msg_1");
    assert.equal(sent.input[ 1 ].id, "06eea1506b9c37f6f3f4bb02f90abd28_rs", `${route.provider} reasoning id preserved`);
    assert.match(sent.input[ 2 ].id, /^ctc_/, `${route.provider} tool call id normalized`);
    assert.equal(sent.input[ 3 ].id, "ctco_1");
    assert.equal(sent.input[ 2 ].call_id, "call_8ec20ad454e0460d9d4b6662");
    assert.equal(sent.input[ 3 ].call_id, "call_8ec20ad454e0460d9d4b6662");
  }

  // On Codex routes, reasoning items without encrypted_content are unresolvable references
  // under store: false and are dropped outright, while tool calls are normalized.
  const codexRoute = routeForModel("gpt-5.6-luna");
  const codexSent = upstreamPayload(codexRoute, { model: "gpt-5.6-luna", input: poisoned }, true);
  assert.equal(codexSent.input.length, 3, "unresolvable foreign reasoning item dropped");
  assert.equal(codexSent.input[ 0 ].id, "msg_1");
  assert.match(codexSent.input[ 1 ].id, /^ctc_/, "tool call id normalized");
  assert.equal(codexSent.input[ 2 ].id, "ctco_1");
  assert.equal(codexSent.input[ 1 ].call_id, "call_8ec20ad454e0460d9d4b6662");
  assert.equal(codexSent.input[ 2 ].call_id, "call_8ec20ad454e0460d9d4b6662");

  // A genuine reasoning item carrying encrypted_content survives on Codex.
  const withEncrypted = [
    { type: "reasoning", id: "rs_0252e954049dbf1c016aa00850d46087d1853ed6aa5cb47915", encrypted_content: "enc_data" },
    { type: "custom_tool_call", id: "06ef3bc08924acade1facee14da0af2e_fc_0", call_id: "call_8ec20ad454e0460d9d4b6662", name: "exec", input: "text()" },
  ];
  const codexSurvives = upstreamPayload(codexRoute, { model: "gpt-5.6-luna", input: withEncrypted }, true);
  assert.equal(codexSurvives.input.length, 2);
  assert.equal(codexSurvives.input[ 0 ].id, "rs_0252e954049dbf1c016aa00850d46087d1853ed6aa5cb47915");
  assert.match(codexSurvives.input[ 1 ].id, /^ctc_/);

  // The caller's array is never mutated in place.
  assert.equal(poisoned[ 2 ].id, "06ef3bc08924acade1facee14da0af2e_fc_0");
});

test("a payload whose ids already conform is forwarded unchanged", () => {
  const input = [
    { type: "reasoning", id: "rs_abc", encrypted_content: "enc_1" },
    { type: "custom_tool_call", id: "ctc_abc", call_id: "call_1", name: "exec" },
  ];
  const sent = upstreamPayload(routeForModel("gpt-5.6-luna"), { model: "gpt-5.6-luna", input }, true);
  assert.equal(sent.input, input);
});

test("every provider normalises item ids", () => {
  for (const provider of Object.keys(JSON.parse(readFileSync(new URL("./codex/model-routing.json", import.meta.url), "utf8")).providers)) {
    assert.equal(providerCapabilities(provider).normalizeItemIds, true, provider);
  }
});

// The escape hatch has to actually reach upstreamPayload, not just parse. Run
// it in a child so the routing config can be swapped before module load.
test("end-to-end: unresolvable reasoning items dropped and tool call ids normalized on codex route", async () => {
  resetRouterTelemetry();
  const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/poisoned-rollout-items.json", import.meta.url), "utf8"));

  const unresolvable1 = { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs" };
  const unresolvable2 = { type: "reasoning", id: "rs_bridge_synthetic_123456" };
  const extraGenuine = { type: "reasoning", id: "rs_extra_genuine_123456789012345678901234567890123456789012", encrypted_content: "enc_extra" };

  const inputWithForeign = [
    ...fixture.items,
    unresolvable1,
    unresolvable2,
    extraGenuine,
  ];

  let upstreamRequestBody = null;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // 1. Format validation (400)
      for (let i = 0; i < upstreamRequestBody.input.length; i++) {
        const item = upstreamRequestBody.input[i];
        const prefix = RESPONSES_ITEM_ID_PREFIXES[item.type];
        if (prefix && typeof item.id === "string" && !item.id.startsWith(prefix)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: {
              message: `Invalid 'input[${i}].id': '${item.id}'. Expected an ID that begins with '${prefix.slice(0, -1)}'.`,
              type: "invalid_request_error",
            },
          }));
          return;
        }
      }
      // 2. Lookup rule (404)
      if (upstreamRequestBody.store === false) {
        for (const item of upstreamRequestBody.input) {
          if (item.type === "reasoning" && (!item.encrypted_content || typeof item.encrypted_content !== "string")) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({
              error: {
                message: `Item with id '${item.id}' not found. Items are not persisted when store is set to false.`,
                type: "invalid_request_error",
              },
            }));
            return;
          }
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_success", output: [] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith("https://chatgpt.com/") || target.endsWith("/responses")) {
      return originalFetch(`http://127.0.0.1:${upstreamPort}/v1/responses`, options);
    }
    return originalFetch(url, options);
  };

  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": "e2e-reasoning-drop-test" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: inputWithForeign, stream: false }),
    });
    assert.equal(response.status, 200);

    const events = getRouterStatus().recentEvents;
    const dropEvent = events.find((e) => e.phase === "foreign_reasoning_dropped");
    const normEvent = events.find((e) => e.phase === "item_ids_normalized");

    assert.ok(dropEvent, "foreign_reasoning_dropped event fired");
    assert.equal(dropEvent.droppedReasoningItems, 2);

    assert.ok(normEvent, "item_ids_normalized event fired");
    assert.equal(normEvent.normalizedItemIds, 9);

    // Verify upstream saw 0 non-conforming IDs
    const nonConforming = upstreamRequestBody.input.filter((item) => {
      const prefix = RESPONSES_ITEM_ID_PREFIXES[item.type];
      return prefix && typeof item.id === "string" && !item.id.startsWith(prefix);
    });
    assert.equal(nonConforming.length, 0);

    // input[18].id on the wire is ctc_e60e73b91d8baea7b1f1d138d2967e27 (was 06ef3bc43b096c4935a65885c28fb67b_fc_0)
    assert.equal(upstreamRequestBody.input[ 18 ].id, "ctc_e60e73b91d8baea7b1f1d138d2967e27");

    // All 26 call_ids (13 tool calls, 13 outputs) from fixture are preserved exactly
    const wireCalls = upstreamRequestBody.input.filter((i) => i.type === "custom_tool_call");
    const wireOutputs = upstreamRequestBody.input.filter((i) => i.type === "custom_tool_call_output");
    assert.equal(wireCalls.length, 13);
    assert.equal(wireOutputs.length, 13);
    assert.deepEqual(wireCalls.map((i) => i.call_id), fixture.items.filter((i) => i.type === "custom_tool_call").map((i) => i.call_id));
    assert.deepEqual(wireOutputs.map((i) => i.call_id), fixture.items.filter((i) => i.type === "custom_tool_call_output").map((i) => i.call_id));

    // Reasoning items reaching upstream: 4 from fixture + 1 extra = 5 genuine encrypted ones
    const wireReasoning = upstreamRequestBody.input.filter((i) => i.type === "reasoning");
    assert.equal(wireReasoning.length, 5);
    for (const r of wireReasoning) {
      assert.match(r.id, /^rs_/);
      assert.ok(r.encrypted_content && r.encrypted_content.length > 0);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => upstream.close(resolve));
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("research roles request website tools without a provider routing capability gate", () => {
  for (const role of ["docs-researcher", "smart", "orchestrator"]) {
    const requirements = roleCapabilityRequirements(role);
    assert.deepEqual(requirements.webResearch.search, true, `${role} search requirement`);
    assert.deepEqual(requirements.webResearch.fetch, true, `${role} fetch requirement`);
  }
  for (const provider of ["codex", "claude", "antigravity", "copilot", "minimax"]) {
    assert.equal("webResearch" in providerCapabilities(provider), false, `${provider} must not gate web research through routing metadata`);
  }
});

test("orchestrator role contract does not require playwright", () => {
  const requirements = roleCapabilityRequirements("orchestrator");
  assert.ok(!requirements.mcp.has("playwright"), "orchestrator must not require playwright");
  assert.equal(requirements.webResearch.search, true);
  assert.equal(requirements.webResearch.fetch, true);
});

test("contract rendering fails when a research role is missing webResearch or has invalid configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "render-contract-neg-"));
  try {
    const rolesDir = join(directory, "agents");
    await mkdir(rolesDir, { recursive: true });
    const srcDir = new URL("./codex/agents", import.meta.url).pathname;
    const { readdirSync, copyFileSync } = await import("node:fs");
    for (const file of readdirSync(srcDir)) {
      if (file.endsWith(".toml")) {
        copyFileSync(join(srcDir, file), join(rolesDir, file));
      }
    }
    await writeFile(join(rolesDir, "docs-researcher.toml"), `
name = "docs-researcher"
sandbox_mode = "read-only"
[mcp_servers.openaiDeveloperDocs]
enabled = true
url = "https://developers.openai.com/mcp"
transport = "streamable_http"
`);

    const renderer = new URL("./codex/render-execution-contract.py", import.meta.url).pathname;
    const rootConfig = new URL("./codex/config.toml", import.meta.url).pathname;
    const contractPath = new URL("./codex/execution-contract.json", import.meta.url).pathname;
    const outputPath = join(directory, "output.json");

    const child = spawn("python3", [
      renderer,
      "--source-dir", rolesDir,
      "--root-config", rootConfig,
      "--contract", contractPath,
      "--output", outputPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.notEqual(code, 0, "contract rendering should fail when docs-researcher lacks webResearch");
    assert.match(stderr, /role 'docs-researcher' must declare webResearch/);

    // Also verify an invalid native tools declaration fails.
    await writeFile(join(rolesDir, "docs-researcher.toml"), `
name = "docs-researcher"
sandbox_mode = "read-only"
[tools]
web_search = "invalid-not-bool"
[mcp_servers.openaiDeveloperDocs]
enabled = true
url = "https://developers.openai.com/mcp"
transport = "streamable_http"
`);
    const child2 = spawn("python3", [
      renderer,
      "--source-dir", rolesDir,
      "--root-config", rootConfig,
      "--contract", contractPath,
      "--output", outputPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr2 = "";
    child2.stderr.on("data", (chunk) => { stderr2 += chunk; });
    const code2 = await new Promise((resolve) => child2.on("close", resolve));
    assert.notEqual(code2, 0, "contract rendering should fail when web_search has an invalid type");
    assert.match(stderr2, /tools\.web_search must be boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
