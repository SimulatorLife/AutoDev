import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_ACTIVITY_STATES,
  AGENT_ACTIVITY_TTL_ENV,
  createAgentActivityTracker,
  DEFAULT_AGENT_ACTIVITY_TTL_MS,
  resolveAgentActivityTtlMs
} from "../../src/agents/agent-activity.ts";
import { spawnedChildren } from "../../src/providers/antigravity.ts";
import { COOLDOWNS as cooldowns } from "../../src/router/cooldown.ts";
import * as responses from "../../src/router/responses.ts";
import {
  CONFIGURED_ORCHESTRATOR_MODEL,
  CONFIGURED_SMART_MODEL,
  ROUTING_POLICY as routing,
  validateRoutingConfig
} from "../../src/router/routing.ts";
import {
  activeProviderRequests,
  AGENT_ACTIVITY_TTL_MS,
  AGENT_EVENTS_PATH,
  AGENT_EVENTS_URL_HEADER,
  AGENT_ROLE_HEADER,
  agentActivity,
  attributionDiagnosticsStatus,
  autodevEnrichOtlpPayload,
  beginShutdown,
  bridgeTelemetryHeaders,
  carriesPendingToolResult,
  classifyProviderFailure,
  closeBridgeSubagentsForRequest,
  codexTelemetryStatus,
  concurrencyStatus,
  declaredLimit,
  decrementActiveRequests,
  downstreamHeaders,
  fallbackable,
  FORWARDED_REQUEST_HEADERS,
  getActiveRequests,
  getLifecycleStatus,
  getRouterStatus as rawGetRouterStatus,
  handle,
  incrementActiveRequests,
  ingestAgentEvents,
  ingestOtelSignal,
  isAutodevAttributesEnabled,
  isClientDisconnectError,
  isDraining,
  isLoopbackAddress,
  loadRouterState,
  lookupBridgeSessionContext,
  mcpContractForRole,
  noteBridgeRequest,
  noteBridgeSession,
  noteOrchestratorSession,
  ORCHESTRATOR_AGENT_ROLE,
  ORCHESTRATOR_ALIAS,
  orchestratorProviderForSession,
  parseConcurrencyConfig,
  parseTurnMetadataJson,
  payloadForCandidate,
  persistRouterStateNow,
  PROCESS_FALLBACK_SESSION_KEY,
  providerCapabilities,
  proxyConcreteResponse,
  recordConcurrencyDenial,
  recordNativeMcpExposure,
  recordRouterEvent,
  recordSpawnFailure,
  recordSubagentSpawn,
  registerWorkspaceId,
  releaseSubagentSlot,
  requestSession,
  resetConcurrencyTelemetry,
  resetLifecycleForTests,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resetSubagentTelemetry,
  resolveTurnMetadataHeader,
  roleCapabilityRequirements,
  ROUTER_INSTANCE_ID,
  routerAuthorizationValid,
  serializeRouterState,
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  setRouterAuthTokenForTests,
  spawnFailureStatus,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  subagentStatus,
  tryAcquireSubagentSlot,
  UNATTRIBUTED_SUBAGENT_ROLE,
  usageStatus as rawUsageStatus,
  workspaceContextFromRequest
} from "../../src/router/server.ts";
import { RESPONSES_ITEM_ID_PREFIXES } from "../../src/shared/responses-item-ids.ts";
import {
  REQUEST_ID_HEADER as AGENT_EVENTS_REQUEST_ID_HEADER,
  resolveAgentEventReporter
} from "../../src/telemetry/agent-events.ts";
import { normalizedSource } from "../source-text.ts";

const getRouterStatus = (...args: any[]): any =>
  (rawGetRouterStatus as any)(...args);
const usageStatus = (...args: any[]): any => (rawUsageStatus as any)(...args);

function listenServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const read = (path: string) => {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  return path.endsWith(".ts") ? normalizedSource(text) : text;
};

// /status is unauthenticated and machine-reachable, so it must never surface
// an absolute filesystem path (home-directory or $CODEX_HOME-rooted). This
// walks the full response recursively -- not just the top-level fields known
// to have carried a path historically -- so a new field added later that
// accidentally embeds one fails the test instead of shipping silently.
const LEAKED_PATH_PATTERN = /\/Users\/|\/home\/|CODEX_HOME/;
function assertNoLeakedPaths(value: any, path = "$") {
  if (typeof value === "string") {
    assert.equal(
      LEAKED_PATH_PATTERN.test(value),
      false,
      `leaked filesystem path at ${path}: ${value}`
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoLeakedPaths(item, `${path}[${index}]`)
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value))
      assertNoLeakedPaths(nested, `${path}.${key}`);
  }
}

// The launcher publishes CODEX_ROUTER_AUTH_TOKEN into the launchd user domain,
// so a maintainer's shell normally carries it. Without pinning, the module
// would arm the auth gate and every request-level test below -- none of which
// send an Authorization header -- would 401 on a correctly configured machine.
setRouterAuthTokenForTests("");

test("router auth is opt-in and validates bearer tokens without exposing the token", () => {
  assert.equal(routerAuthorizationValid({ headers: {} } as any), true);
  assert.equal(
    routerAuthorizationValid({ headers: {} } as any, "secret"),
    false
  );
  assert.equal(
    routerAuthorizationValid(
      { headers: { authorization: "Bearer wrong" } } as any,
      "secret"
    ),
    false
  );
  assert.equal(
    routerAuthorizationValid(
      { headers: { authorization: "Bearer secret" } } as any,
      "secret"
    ),
    true
  );
});

test("the router calls the Antigravity adapter directly, with no LiteLLM hop", async () => {
  // LiteLLM used to sit between the router and the agy adapter as an identity
  // pass-through. It routed nothing, but it dropped raw request headers -- which
  // forced the router to smuggle its own headers through the Responses body --
  // and it mistranslated `response.failed`, which forced the adapter to fake a
  // completed response. Both workarounds are gone with it.
  const route = routing.routeForModel("gemini-3.8-flash-high")!;
  assert.equal(route.provider, "antigravity");
  assert.equal(route.baseUrl, "http://127.0.0.1:4002/v1");
  assert.equal(route.healthUrl, "http://127.0.0.1:4002/health/liveliness");

  const router = read("src/router/server.ts");
  assert.doesNotMatch(
    router,
    /extra_headers = forwarded/,
    "router headers must travel as real headers"
  );
  assert.doesNotMatch(
    router,
    /metadata\?\.provider_error/,
    "the faked-completion detector is obsolete"
  );

  const bridge = read("src/providers/antigravity.ts");
  // A post-stream failure must never read as success. It is no longer a bare
  // `response.failed` either: that discarded every token already streamed. The
  // turn is closed as *incomplete* instead, carrying the work that finished --
  // which `responseWasNotCompleted` still counts as a provider failure.
  assert.match(
    bridge,
    /terminalIncompleteEvents\(\{/,
    "a post-stream failure must close the turn as incomplete"
  );
  assert.match(
    bridge,
    /"incomplete"\)/,
    "the flushed payload must not claim it completed"
  );
  assert.doesNotMatch(
    bridge,
    /emit\("response\.failed"/,
    "a flushed turn must not also be reported as failed"
  );
  assert.doesNotMatch(bridge, /failedStream/);

  for (const path of [
    "scripts/codex/litellm/antigravity.yaml",
    "scripts/run-codex-antigravity-litellm.sh",
    "scripts/codex/launchagents/com.codex.antigravity-litellm.plist"
  ]) {
    assert.equal(
      existsSync(new URL(`../../${path}`, import.meta.url)),
      false,
      `${path} must be gone`
    );
  }
  assert.doesNotMatch(
    read("scripts/ensure-codex-antigravity-proxy.sh"),
    /litellm/i,
    "the ensure hook must not supervise LiteLLM"
  );
  // The installer still names the obsolete assets, because naming them is how
  // it removes them from a host that has them; it must not install them.
  const materializer = read("src/platform/install-materializer.ts");
  assert.match(materializer, /com\.codex\.antigravity-litellm/);
  assert.doesNotMatch(materializer, /litellm_dir/);
});

test("loads editable provider and role models from JSON routing config", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../../config/model-routing.json", import.meta.url),
      "utf8"
    )
  );
  assert.equal(config.providers.claude.models.smart, "claude-opus-5-5");
  assert.equal(config.providers.codex.models.smart, CONFIGURED_SMART_MODEL);
  assert.equal(config.providers.minimax.models.smart, undefined);
  assert.equal(config.providers.copilot.models.smart, undefined);
  assert.deepEqual(config.providerGroups.default, [
    ["claude", "antigravity", "minimax"],
    ["copilot"],
    ["codex"]
  ]);
  assert.deepEqual(config.providerGroups.smart, [
    ["claude", "antigravity"],
    ["codex"]
  ]);
  assert.deepEqual(config.providerGroups.orchestrator, [
    ["codex"],
    ["claude", "copilot", "antigravity"]
  ]);
  assert.equal(config.roles.worker.tier, "default");
  assert.equal(config.roles.smart.tier, "smart");
  assert.equal(config.orchestrator.alias, "autodev/orchestrator");
  assert.equal(config.orchestrator.tier, "orchestrator");
  assert.equal(
    config.providers.codex.models.orchestrator,
    CONFIGURED_ORCHESTRATOR_MODEL
  );
  assert.equal(config.providers.claude.models.orchestrator, "claude-opus-5-5");
  assert.equal(
    config.providers.antigravity.models.orchestrator,
    "gemini-3.8-flash-high"
  );
  assert.equal(config.providers.copilot.models.orchestrator, "copilot");
  assert.deepEqual(config.orchestrator.reasoningEffort, {
    claude: "medium",
    antigravity: "high"
  });
});

test("Claude smart/orchestrator routing selects the canonical Opus 5.5 id and rejects the retired Opus 5 id", async () => {
  const raw = await readFile(
    new URL("../../config/model-routing.json", import.meta.url),
    "utf8"
  );
  const config = JSON.parse(raw);

  // Target model: the canonical, hyphen-separated Opus 5.5 id is what ships.
  assert.equal(config.providers.claude.models.smart, "claude-opus-5-5");
  assert.equal(config.providers.claude.models.orchestrator, "claude-opus-5-5");

  // Retired id: the old Opus 5 id must not be configured anywhere, and the
  // fixture text itself must not contain a lingering reference to it.
  assert.notEqual(config.providers.claude.models.smart, "claude-opus-5");
  assert.notEqual(config.providers.claude.models.orchestrator, "claude-opus-5");
  assert.doesNotMatch(
    raw,
    /"claude-opus-5"/,
    "the retired Claude Opus 5 id must not remain configured"
  );

  // Malformed variants (a dot instead of the second hyphen) must never be
  // configured either.
  assert.doesNotMatch(
    raw,
    /claude-opus-5\.5/,
    "a dot-separated Opus 5.5 id must never be configured"
  );

  // The claude route itself must accept the canonical id, family aliases,
  // and other generic hyphen-separated Claude ids, while rejecting both a
  // malformed dotted Opus 5.5 id and a malformed double-suffixed variant.
  const claudeRoute = routing.routes.find(
    (route) => route.provider === "claude"
  );
  assert.ok(claudeRoute, "the claude route must be registered");
  for (const id of ["claude-opus-5-5", "sonnet", "opus", "haiku", "claude-sonnet-5"]) {
    assert.ok(
      claudeRoute!.pattern.test(id),
      `${id}: valid Claude ids and family aliases must still match the route`
    );
  }
  for (const id of ["claude-opus-5.5", "claude-opus-5-5.5"]) {
    assert.equal(
      claudeRoute!.pattern.test(id),
      false,
      `${id}: a malformed dotted Opus 5.5 id must never match the route`
    );
  }
});

test("provider capabilities expose only providers with a real delegation path", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../../config/model-routing.json", import.meta.url),
      "utf8"
    )
  );
  for (const provider of Object.keys(config.providers)) {
    assert.equal(
      config.providers[provider].capabilities,
      undefined,
      `${provider} must not declare capabilities in routing config`
    );
  }
  assert.equal(providerCapabilities("minimax").subagentSpawn, false);
  for (const provider of ["codex", "claude", "antigravity", "copilot"]) {
    assert.equal(
      providerCapabilities(provider).subagentSpawn,
      true,
      `${provider} must be treated as spawn-capable`
    );
  }
  for (const group of config.providerGroups.orchestrator) {
    for (const provider of group) {
      assert.equal(
        providerCapabilities(provider).subagentSpawn,
        true,
        `${provider} serves the orchestrator tier, so it must be able to spawn subagents`
      );
    }
  }
});

test("router status reports only providers with a delegation path", () => {
  const providers = getRouterStatus().providers;
  for (const [name, provider] of Object.entries(providers) as [string, any][]) {
    assert.equal(provider.capabilities.subagentSpawn, name !== "minimax");
    assert.ok(Array.isArray(provider.capabilities.subagentSpawnTools));
    assert.equal("mcp" in provider.capabilities, false);
    assert.equal("skills" in provider.capabilities, false);
  }
});

test("orchestrator alias degrades from the pinned primary provider to a load-balanced fallback group with pinned reasoning effort", () => {
  assert.equal(ORCHESTRATOR_ALIAS, "autodev/orchestrator");
  assert.equal(routing.roleForModel(ORCHESTRATOR_ALIAS), null);

  const candidates: any[] = routing.orchestratorCandidates(() => 0.5);
  assert.equal(
    candidates[0].provider,
    "codex",
    "the primary provider is always attempted first"
  );
  assert.equal(candidates[0].model, CONFIGURED_ORCHESTRATOR_MODEL);
  assert.equal(
    candidates[0].reasoningEffort,
    null,
    "the primary provider keeps the caller's reasoning effort"
  );
  assert.deepEqual(
    candidates
      .slice(1)
      .map((candidate) => candidate.provider)
      .sort(),
    ["antigravity", "claude", "copilot"]
  );

  const byProvider: Record<string, any> = Object.fromEntries(
    candidates.map((candidate: any) => [candidate.provider, candidate])
  );
  assert.equal(byProvider.claude.model, "claude-opus-5-5");
  assert.equal(byProvider.claude.reasoningEffort, "medium");
  assert.equal(byProvider.copilot.model, "copilot");
  assert.equal(byProvider.copilot.reasoningEffort, null);
  assert.equal(byProvider.antigravity.model, "gemini-3.8-flash-high");
  assert.equal(byProvider.antigravity.reasoningEffort, "high");

  // The fallback group is shuffled/least-loaded, never the pinned primary.
  assert.notDeepEqual(
    routing
      .orchestratorCandidates(() => 0)
      .slice(1)
      .map((candidate) => candidate.provider),
    routing
      .orchestratorCandidates(() => 0.999)
      .slice(1)
      .map((candidate) => candidate.provider)
  );

  const swapped = payloadForCandidate(
    {
      model: "autodev/orchestrator",
      reasoning: { summary: "auto", effort: "xhigh" }
    },
    byProvider.claude
  );
  assert.equal(swapped.model, "claude-opus-5-5");
  assert.deepEqual(swapped.reasoning, { summary: "auto", effort: "medium" });

  const primary = payloadForCandidate(
    { model: "autodev/orchestrator", reasoning: { effort: "xhigh" } },
    candidates[0]
  );
  assert.equal(primary.model, CONFIGURED_ORCHESTRATOR_MODEL);
  assert.deepEqual(
    primary.reasoning,
    { effort: "xhigh" },
    "the pinned primary provider is dispatched with the caller's effort untouched"
  );
});

test("validates routing config and requires default model for providers", () => {
  const validConfig = {
    providerGroups: {
      default: [["testProvider"], ["fallbackProvider"]],
      smart: [["testProvider"], ["fallbackProvider"]],
      orchestrator: [["testProvider"], ["fallbackProvider"]]
    },
    providers: {
      testProvider: { models: { default: "test-model" } },
      fallbackProvider: { models: { default: "fallback-model" } }
    },
    roles: {
      default: { tier: "default" },
      "docs-researcher": { tier: "default" },
      "browser-tester": { tier: "default" },
      explorer: { tier: "default" },
      worker: { tier: "default" },
      validator: { tier: "default" },
      smart: { tier: "smart" }
    },
    orchestrator: {
      alias: "autodev/orchestrator",
      tier: "orchestrator",
      reasoningEffort: { fallbackProvider: "high" }
    }
  };
  assert.doesNotThrow(() => validateRoutingConfig(validConfig));

  // A model listed under a routed provider must route back to it: a mistyped
  // Claude id would otherwise load and fail at the CLI turn after turn.
  const routed = {
    ...validConfig,
    providerGroups: {
      default: [["claude"]],
      smart: [["claude"]],
      orchestrator: [["claude"]]
    },
    providers: {
      claude: { models: { default: "sonnet", orchestrator: "claude-opus-5.5" } }
    },
    orchestrator: { alias: "autodev/orchestrator", tier: "orchestrator" }
  };
  assert.throws(
    () => validateRoutingConfig(routed),
    /provider claude orchestrator model "claude-opus-5\.5" matches no provider route/
  );
  assert.doesNotThrow(() =>
    validateRoutingConfig({
      ...routed,
      providers: {
        claude: {
          models: { default: "sonnet", orchestrator: "claude-opus-5-5" }
        }
      }
    })
  );
  assert.throws(
    () =>
      validateRoutingConfig({
        ...routed,
        providers: {
          claude: { models: { default: "sonnet", orchestrator: CONFIGURED_SMART_MODEL } }
        }
      }),
    new RegExp(`provider claude orchestrator model "${CONFIGURED_SMART_MODEL}" routes to codex`)
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...validConfig,
        providers: { testProvider: { models: {} } }
      }),
    /Routing config provider testProvider must define a default model/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...validConfig,
        providerGroups: {
          default: [[]],
          smart: [["testProvider"]],
          orchestrator: [["testProvider"]]
        }
      }),
    /Routing config tier default contains an invalid provider group/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, orchestrator: undefined }),
    /Routing config requires an orchestrator block/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...validConfig,
        orchestrator: { ...validConfig.orchestrator, alias: "orchestrator" }
      }),
    /orchestrator\.alias must be an autodev\/<name> alias/
  );

  assert.throws(
    () =>
      validateRoutingConfig({
        ...validConfig,
        orchestrator: {
          ...validConfig.orchestrator,
          reasoningEffort: { unknownProvider: "high" }
        }
      }),
    /orchestrator\.reasoningEffort references unknown provider unknownProvider/
  );
});

test("routes supported model families without provider aliases", () => {
  assert.equal(routing.routeForModel(CONFIGURED_ORCHESTRATOR_MODEL)?.provider, "codex");
  assert.equal(routing.routeForModel("sonnet")?.provider, "claude");
  assert.equal(routing.routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(
    routing.routeForModel("gemini-3.8-flash-medium")?.provider,
    "antigravity"
  );
  assert.equal(routing.routeForModel("unknown-model"), null);
});

test("resolves role aliases through tier-specific randomized provider groups with smart model fallback", () => {
  assert.equal(routing.roleForModel("autodev/explorer"), "explorer");

  const explorerCandidates = routing.roleCandidates("explorer", () => 0.5);
  const explorerProviders = explorerCandidates.map((c) => c.provider);
  assert.deepEqual(explorerProviders.slice(0, 3).sort(), [
    "antigravity",
    "claude",
    "minimax"
  ]);
  assert.deepEqual(explorerProviders.slice(3), ["copilot", "codex"]);

  const smartCandidates = routing.roleCandidates("smart", () => 0.5);
  const smartProviders = smartCandidates.map((c) => c.provider);
  assert.deepEqual(smartProviders.slice(0, 2).sort(), [
    "antigravity",
    "claude"
  ]);
  assert.deepEqual(smartProviders.slice(2), ["codex"]);

  const smartModelMap = Object.fromEntries(
    smartCandidates.map((c) => [c.provider, c.model])
  );
  assert.equal(smartModelMap.antigravity, "gemini-3.8-flash-high");
  assert.equal(smartModelMap.claude, "claude-opus-5-5");
  assert.equal(smartModelMap.codex, CONFIGURED_SMART_MODEL);
  assert.notDeepEqual(
    routing
      .roleCandidates("smart", () => 0)
      .slice(0, 2)
      .map((candidate) => candidate.provider),
    routing
      .roleCandidates("smart", () => 0.999)
      .slice(0, 2)
      .map((candidate) => candidate.provider)
  );
});

test("classifies provider exhaustion and transient responses for fallback", () => {
  assert.equal(fallbackable(429, "session limit reached"), true);
  assert.equal(fallbackable(503, "unavailable"), true);
  assert.equal(fallbackable(400, "provider usage limit reached"), true);
  assert.equal(
    fallbackable(
      400,
      "Invalid model name passed in model=gemini-3.8-flash-high"
    ),
    true
  );
  assert.equal(fallbackable(400, "malformed request"), false);
});

test("temporarily omits providers after a fallbackable limit or outage", () => {
  const now = 1000;
  cooldowns.cooldownProvider("minimax", { now });
  assert.equal(cooldowns.isCooling("minimax", now + 1), true);
  assert.equal(cooldowns.isCooling("minimax", now + 30_000), false);
  cooldowns.clear("minimax");
  assert.equal(cooldowns.isCooling("minimax", now), false);
});

test("holds a provider that reported a real reset until that reset, not on the transient ladder", () => {
  const now = 1000;
  try {
    const resetsAt = new Date(now + 3_600_000).toISOString();
    const hard = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "quota_exhausted",
      resetsAt,
      structured: true
    });
    assert.equal(hard.kind, "hard");
    assert.equal(
      hard.cooldownUntil,
      Date.parse(resetsAt),
      "the provider's own reset time is authoritative"
    );
    assert.equal(hard.resetsAt, resetsAt);

    // Repeating it does not escalate: the reset time is a fact, not a guess.
    assert.equal(
      cooldowns.cooldownProvider("minimax", {
        now,
        failureClass: "quota_exhausted",
        resetsAt,
        structured: true
      }).cooldownUntil,
      Date.parse(resetsAt)
    );

    // A reset further out than the ceiling is clamped rather than trusted whole.
    cooldowns.clear("minimax");
    const far = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "quota_exhausted",
      resetsAt: new Date(now + 30 * 86_400_000).toISOString(),
      structured: true
    });
    assert.equal(far.cooldownUntil, now + 21_600_000);
  } finally {
    cooldowns.clear("minimax");
  }
});

test("a limit only inferred from prose stays on the transient ladder", () => {
  const now = 1000;
  try {
    // classifyProviderFailure matches keywords, and bridges ship stderr tails in
    // error messages. One stray "quota" must not take a provider out for the
    // hard window; only a provider *reporting* the limit does that.
    const inferred = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "quota_exhausted",
      structured: false
    });
    assert.equal(inferred.kind, "transient");
    assert.equal(inferred.durationMs, 30_000);
  } finally {
    cooldowns.clear("minimax");
  }
});

test("health probe failures and broken credentials get their own cooldowns", () => {
  const now = 1000;
  try {
    // A local bridge restarting says nothing about the provider behind it, so
    // it must not push the provider's own backoff toward its ceiling.
    const first = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "probe_unavailable"
    });
    const second = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "probe_unavailable"
    });
    assert.equal(first.kind, "probe");
    assert.equal(first.durationMs, 5000);
    assert.equal(second.durationMs, 10_000);
    assert.equal(
      getRouterStatus(now + 1).providers.minimax.failureStreak,
      0,
      "a probe failure must not move the provider's own streak"
    );

    cooldowns.clear("minimax");
    // A broken credential is deterministic: fixed, unescalating, and never
    // retried as a last resort, because re-sending cannot make it work.
    const config = cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "authentication"
    });
    assert.equal(config.kind, "config");
    assert.equal(
      cooldowns.cooldownProvider("minimax", {
        now,
        failureClass: "authentication"
      }).durationMs,
      30_000
    );
  } finally {
    cooldowns.clear("minimax");
    resetRouterTelemetry();
  }
});

test("a cooldown only ever moves later", () => {
  const now = 1000;
  try {
    const resetsAt = new Date(now + 3_600_000).toISOString();
    cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "quota_exhausted",
      resetsAt,
      structured: true
    });
    // A five-second probe failure landing on top of an hour-long usage limit
    // must not shorten it back to five seconds.
    cooldowns.cooldownProvider("minimax", {
      now,
      failureClass: "probe_unavailable"
    });
    const status = getRouterStatus(now + 1).providers.minimax;
    assert.equal(status.cooldownKind, "hard");
    assert.equal(status.cooldownResetsAt, resetsAt);
  } finally {
    cooldowns.clear("minimax");
    resetRouterTelemetry();
  }
});

test("backs off repeatedly failing providers and moves them behind healthy peers", () => {
  resetRouterTelemetry();
  activeProviderRequests.clear();
  try {
    const first = cooldowns.cooldownProvider("claude", { now: 1000 });
    const second = cooldowns.cooldownProvider("claude", { now: 1000 });
    assert.equal(first.durationMs, 30_000);
    assert.equal(second.durationMs, 60_000);
    assert.equal(cooldowns.nextRetryMs(["claude", "minimax"], 1000), 60_000);

    const providers = routing
      .roleCandidates("default", () => 0.5)
      .map(({ provider }) => provider);
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
    CODEX_ROUTER_COPILOT_API_KEY: process.env.CODEX_ROUTER_COPILOT_API_KEY
  };
  let responseCalls = 0;
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  process.env.CODEX_ROUTER_COPILOT_API_KEY = "test-provider-key";
  activeProviderRequests.clear();
  cooldowns.clear("claude");
  cooldowns.clear("antigravity");
  cooldowns.clear("minimax");
  agentActivity.beginRequest("busy-antigravity", {
    requestId: "busy-antigravity",
    provider: "antigravity",
    model: "gemini-3.8-flash-medium",
    origin: "direct"
  });
  agentActivity.beginRequest("busy-minimax-1", {
    requestId: "busy-minimax-1",
    provider: "minimax",
    model: "MiniMax-M3",
    origin: "direct"
  });
  agentActivity.beginRequest("busy-minimax-2", {
    requestId: "busy-minimax-2",
    provider: "minimax",
    model: "MiniMax-M3",
    origin: "direct"
  });
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("ok", { status: 200 });
    }
    if (target.endsWith("/responses")) {
      responseCalls += 1;
      if (responseCalls === 1)
        return Response.json(
          { error: "provider throttled" },
          {
            status: 429
          }
        );
      return Response.json(
        {
          id: "fallback-response",
          model: "gemini-3.8-flash-medium",
          output_text: "fallback ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "fallback-test"
        },
        body: JSON.stringify({ model: "autodev/default", stream: false })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "antigravity");
    assert.equal(responseCalls, 2);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("orchestrator alias falls back to another provider when the primary is unavailable and stays attributed to the orchestrator origin", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
  };
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  for (const provider of ["codex", "claude", "antigravity", "minimax"])
    cooldowns.clear(provider);
  let orchestratorResponseProvider = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    // The primary provider (chatgpt.com Codex backend) is out of usage.
    if (target.startsWith("https://chatgpt.com/")) {
      return Response.json(
        { error: "You have hit your usage limit" },
        { status: 429 }
      );
    }
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("ok", { status: 200 });
    }
    if (target.endsWith("/responses")) {
      orchestratorResponseProvider = target;
      return Response.json(
        {
          id: "orchestrator-fallback",
          model: "fallback",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "orchestrator-test"
        },
        body: JSON.stringify({
          model: "autodev/orchestrator",
          stream: false,
          reasoning: { effort: "xhigh" }
        })
      }
    );
    assert.equal(response.status, 200);
    const servingProvider = response.headers.get("x-autodev-provider");
    assert.ok(
      ["claude", "minimax", "antigravity"].includes(servingProvider!),
      `expected a fallback-group provider, got ${servingProvider}`
    );
    assert.notEqual(
      response.headers.get("x-autodev-model"),
      "autodev/orchestrator"
    );
    assert.ok(
      orchestratorResponseProvider &&
      !(orchestratorResponseProvider as string).startsWith(
        "https://chatgpt.com/"
      )
    );

    const usage = getRouterStatus().usage;
    assert.equal(
      usage.byOrigin.orchestrator.successes,
      1,
      "fallback traffic is still attributed to the orchestrator origin"
    );
    assert.equal(
      usage.byOrigin.subagent?.successes ?? 0,
      0,
      "the orchestrator must not consume a subagent slot"
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
});

test("reports the earliest provider retry time when every role candidate is cooling down", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
      return new Response("down", { status: 503 });
    }
    return originalFetch(url, options);
  };
  resetRouterTelemetry();
  const cooldownStartedAt = Date.now();
  for (const provider of [
    "claude",
    "antigravity",
    "minimax",
    "copilot",
    "codex"
  ])
    cooldowns.cooldownProvider(provider, { now: cooldownStartedAt });
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "cooldown-test"
        },
        body: JSON.stringify({ model: "autodev/default", stream: false })
      }
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.match(
      (await response.json()).error.message,
      /Retry after approximately 30s/
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const provider of [
      "claude",
      "antigravity",
      "minimax",
      "copilot",
      "codex"
    ])
      cooldowns.clear(provider);
    resetRouterTelemetry();
  }
});

test("requires configured credentials before treating keyed providers as available", () => {
  assert.equal(
    routing.routeCredentialAvailable(routing.routeForModel("MiniMax-M3"), {}),
    false
  );
  assert.equal(
    routing.routeCredentialAvailable(routing.routeForModel("MiniMax-M3"), {
      MINIMAX_API_KEY: "  "
    }),
    false
  );
  assert.equal(
    routing.routeCredentialAvailable(routing.routeForModel("MiniMax-M3"), {
      MINIMAX_API_KEY: "key-present"
    }),
    true
  );
  assert.equal(
    routing.routeCredentialAvailable(
      routing.routeForModel(CONFIGURED_ORCHESTRATOR_MODEL),
      {}
    ),
    true
  );
});

test("classifies provider failures into operator-visible limit states", () => {
  assert.equal(classifyProviderFailure(429, "too many requests"), "throttled");
  assert.equal(
    classifyProviderFailure(429, "session limit reached"),
    "session_limit"
  );
  assert.equal(
    classifyProviderFailure(429, "quota exhausted"),
    "quota_exhausted"
  );
  assert.equal(
    classifyProviderFailure(502, "You've hit your weekly limit"),
    "throttled"
  );
  assert.equal(classifyProviderFailure(503, "high demand"), "capacity");
  assert.equal(
    classifyProviderFailure(400, "quota exhausted"),
    "quota_exhausted"
  );
  assert.equal(
    classifyProviderFailure(400, "provider usage limit reached"),
    "quota_exhausted"
  );
  assert.equal(classifyProviderFailure(401, "unauthorized"), "authentication");
  assert.equal(
    classifyProviderFailure(400, "malformed request"),
    "request_error"
  );
});

test("router flattens outbound tools and rewrites inbound tool namespaces in SSE events", () => {
  const tools = [
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          description: "Spawn child agent"
        }
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
  const flattened = responses.flattenOutboundTools(tools);
  assert.deepEqual(flattened, [
    {
      type: "function",
      name: "multi_agent_v1__spawn_agent",
      description: "Spawn child agent"
    },
    { type: "function", name: "collaboration__send_message" },
    { type: "function", name: "read_file" }
  ]);

  const rewritten = responses.rewriteToolNamespaces({
    output: [
      { name: "multi_agent_v1__spawn_agent", type: "function_call" },
      { name: "collaboration__send_message", type: "function_call" },
      { name: "read_file", type: "function_call" }
    ]
  });
  assert.deepEqual((rewritten as any).output, [
    { name: "spawn_agent", namespace: "multi_agent_v1", type: "function_call" },
    { name: "send_message", namespace: "collaboration", type: "function_call" },
    { name: "read_file", type: "function_call" }
  ]);

  const sseEvent =
    'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","name":"multi_agent_v1__spawn_agent"}}\n\n';
  const transformed = responses.transformSseEvent(
    sseEvent,
    "autodev/orchestrator"
  );
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
  const { buildSpawnScript, execToolCallSseEvents } =
    await import("../../src/agents/spawn-tools.ts");
  const source = buildSpawnScript([
    { agentType: "explorer", message: "audit the catalogue" }
  ]);

  for (const [name, payload] of execToolCallSseEvents({
    itemId: "ctc_1",
    callId: "call_1",
    source
  })) {
    const transformed = responses.transformSseEvent(
      `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`,
      "autodev/orchestrator"
    );
    const back = JSON.parse(
      transformed
        .split("\n")
        .find((line: string) => line.startsWith("data: "))!
        .slice(6)
    );
    assert.deepEqual((back as any).item ?? null, (payload as any).item ?? null);
    assert.equal((back as any).delta ?? null, (payload as any).delta ?? null);
    assert.equal((back as any).input ?? null, (payload as any).input ?? null);
  }

  // The rewriting is real, so the pass-through above is not vacuous: the same
  // name as a bare `function_call` name still gets split into a namespace.
  assert.deepEqual(
    responses.rewriteToolNamespaces({
      name: "multi_agent_v1__spawn_agent",
      type: "function_call"
    }),
    { name: "spawn_agent", namespace: "multi_agent_v1", type: "function_call" }
  );
});

test("agent-events reporting is decoupled from spawn-tool availability", () => {
  const forAntigravity = bridgeTelemetryHeaders(
    { provider: "antigravity" },
    "request-1"
  );
  assert.deepEqual(forAntigravity, {
    ["x-autodev-request-id"]: "request-1",
    [SUBAGENT_SPAWN_TOOLS_HEADER]: "invoke_subagent",
    [AGENT_EVENTS_URL_HEADER]: `http://127.0.0.1:4100${AGENT_EVENTS_PATH}`
  });
  // Native Codex is observed through OTLP and the router-side role contract,
  // so local agent-events headers must not be sent to the remote Codex API.
  assert.deepEqual(
    bridgeTelemetryHeaders({ provider: "codex" }, "request-1"),
    {}
  );
  // MiniMax, Copilot, and Claude still run tools, expose skills, and reach MCP
  // servers over the same request -- those observations must not go
  // unreported just because the spawn watchlist is empty. (Claude delegates
  // through Codex's own spawn tool, so it has no bridge spawn tool to watch.)
  for (const provider of ["minimax", "copilot", "claude"]) {
    assert.deepEqual(
      bridgeTelemetryHeaders({ provider }, "request-1"),
      {
        ["x-autodev-request-id"]: "request-1",
        [AGENT_EVENTS_URL_HEADER]: `http://127.0.0.1:4100${AGENT_EVENTS_PATH}`
      },
      provider
    );
    assert.equal(
      SUBAGENT_SPAWN_TOOLS_HEADER in
      bridgeTelemetryHeaders({ provider }, "request-1"),
      false,
      provider
    );
  }
  // Without a request id there is nothing to correlate a report against.
  assert.deepEqual(bridgeTelemetryHeaders({ provider: "claude" }, null), {});
});

test("a provider with no spawn tools still gets an agent-events reporter", () => {
  // The headers a spawn-tool-less provider (minimax, copilot) actually
  // receives: no SUBAGENT_SPAWN_TOOLS_HEADER, but the events URL and request
  // id are present. resolveAgentEventReporter must not fail this caller
  // closed just because the spawn watchlist header is absent -- tool
  // execution and skill/MCP exposure are unrelated to whether this runtime
  // can spawn subagents.
  const headers = bridgeTelemetryHeaders(
    { provider: "copilot" },
    "request-decoupled"
  );
  assert.equal(SUBAGENT_SPAWN_TOOLS_HEADER in headers, false);
  const reporter = resolveAgentEventReporter(headers);
  assert.ok(reporter);
  assert.equal(reporter.isSpawnTool("anything"), false);

  // Still fails closed when the router did not authorize this request at all.
  assert.equal(resolveAgentEventReporter({}), null);
  assert.equal(
    resolveAgentEventReporter({
      [AGENT_EVENTS_URL_HEADER]: headers[AGENT_EVENTS_URL_HEADER]
    }),
    null
  );
  assert.equal(
    resolveAgentEventReporter({
      [AGENT_EVENTS_REQUEST_ID_HEADER]: "request-decoupled"
    }),
    null
  );
});

test("subagent telemetry counts both spawn mechanisms and attributes each to a provider", () => {
  resetSubagentTelemetry();
  try {
    // A CLI bridge reports what its own runtime spawned; the router resolves
    // the provider from the request the bridge was serving.
    noteBridgeRequest("request-1", {
      activitySubject: `req:${"request-1"}`,
      provider: "claude",
      model: "claude-opus-5-5",
      role: null,
      workspace: "AutoDev"
    });
    const accepted = ingestAgentEvents({
      requestId: "request-1",
      events: [
        { type: "subagent_spawn", tool: "Agent", role: "explorer" },
        { type: "subagent_spawn", tool: "Agent", role: "worker", count: 2 },
        { type: "not_a_spawn" }
      ]
    });
    // Three children from two spawn events, and the event that named no
    // recognized type is the one rejected: the counts measure
    // subagents and events respectively, not one minus the other.
    assert.deepEqual(accepted, {
      accepted: 3,
      closed: 0,
      unavailable: 0,
      rejected: 1,
      reason: null
    });

    // A router-routed spawn is attributed to whichever provider ran the parent
    // orchestrator turn for that session.
    noteOrchestratorSession("session-a", "minimax");
    recordSubagentSpawn({
      mechanism: "router_alias",
      provider: orchestratorProviderForSession("session-a"),
      role: "validator",
      tool: "multi_agent_v1.spawn"
    });
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
    assert.deepEqual(status.spawnCapableProviders, [
      "antigravity",
      "claude",
      "copilot",
      "codex"
    ]);
    assert.equal(
      status.recent[0]!.role,
      "validator",
      "the recent list is newest first"
    );
    assert.equal(status.recent.at(-1)!.provider, "claude");

    // The request id is the only credential a report carries, so an unknown one
    // is counted nowhere.
    assert.deepEqual(
      ingestAgentEvents({
        requestId: "never-issued",
        events: [{ type: "subagent_spawn", tool: "Agent" }]
      }),
      {
        accepted: 0,
        closed: 0,
        unavailable: 0,
        rejected: 1,
        reason: "unknown_request_id"
      }
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
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    noteBridgeRequest("request-live", {
      activitySubject: `req:${"request-live"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      role: null,
      workspace: "AutoDev"
    });
    const post = (body: any) =>
      fetch(`${base}${AGENT_EVENTS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    const accepted = await post({
      requestId: "request-live",
      events: [{ type: "subagent_spawn", tool: "invoke_subagent" }]
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      accepted: 1,
      closed: 0,
      unavailable: 0,
      rejected: 0,
      reason: null
    });

    const unknown = await post({
      requestId: "request-missing",
      events: [{ type: "subagent_spawn", tool: "invoke_subagent" }]
    });
    assert.equal(unknown.status, 404);

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.subagents.total, 1);
    assert.deepEqual(status.subagents.byProvider, { antigravity: 1 });
    assert.equal(status.subagents.recent[0].tool, "invoke_subagent");
  } finally {
    await closeServer(server);
    resetSubagentTelemetry();
  }
});

test("an Antigravity batch spawn reaches the router as one count per child", async () => {
  // End to end over the real pieces: the reporter the bridge builds from the
  // router's own headers, an agy step update shaped the way the CLI recorded
  // the delegation that exposed this, and the router's live endpoint. A
  // twelve-way fan-out used to arrive as a single roleless `antigravity/null`.
  resetSubagentTelemetry();
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    noteBridgeRequest("request-batch", {
      activitySubject: `req:${"request-batch"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    const reporter = resolveAgentEventReporter({
      ...bridgeTelemetryHeaders({ provider: "antigravity" }, "request-batch"),
      [AGENT_EVENTS_URL_HEADER]: `${base}${AGENT_EVENTS_PATH}`
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
            {
              TypeName: "explorer",
              Model: "inherit",
              Prompt: "Catalog every build error"
            },
            {
              TypeName: "explorer",
              Model: "inherit",
              Prompt: "Catalog every lint error"
            },
            {
              TypeName: "validator",
              Model: "inherit",
              Prompt: "Re-run the suites"
            }
          ]
        })
      }
    };
    assert.equal(reporter!.isSpawnTool(stepUpdate.tool_name), true);
    await reporter!.reportSpawns({
      tool: stepUpdate.tool_name,
      children: spawnedChildren(stepUpdate)
    });

    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.subagents.total, 3);
    assert.deepEqual(status.subagents.byProvider, { antigravity: 3 });
    assert.deepEqual(status.subagents.byRole, { explorer: 2, validator: 1 });
    assert.deepEqual(status.subagents.byMechanism, {
      router_alias: 0,
      bridge_native: 3
    });
    for (const recentSpawn of status.subagents.recent) {
      assert.equal(recentSpawn.tool, "invoke_subagent");
      assert.equal(recentSpawn.workspace, "SimulatorLife/RacingGame");
    }
  } finally {
    await closeServer(server);
    resetSubagentTelemetry();
  }
});

test("a spawn breakdown says how its children ended, not only that they started", async () => {
  // `byStatus` is the breakdown of how spawns finished, but only the open path
  // ever wrote to it, so it read `{ started: N }` forever -- which says "none of
  // these ever finished" about children that had all completed.
  resetSubagentTelemetry();
  try {
    noteBridgeRequest("request-status", {
      activitySubject: `req:${"request-status"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    ingestAgentEvents({
      requestId: "request-status",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "research",
          count: 2,
          children: [{ id: "c1" }, { id: "c2" }]
        }
      ]
    });
    assert.deepEqual(subagentStatus().byStatus, { started: 2 });

    ingestAgentEvents({
      requestId: "request-status",
      events: [
        {
          type: "subagent_result",
          tool: "invoke_subagent",
          role: "research",
          outcome: "success",
          durationMs: 45_000,
          children: [{ id: "c1" }]
        }
      ]
    });
    // A close settles a child; it never invents one.
    assert.deepEqual(subagentStatus().byStatus, { started: 1, success: 1 });
    assert.equal(subagentStatus().total, 2, "settling is not a new spawn");

    ingestAgentEvents({
      requestId: "request-status",
      events: [
        {
          type: "subagent_result",
          tool: "invoke_subagent",
          role: "research",
          outcome: "failure",
          children: [{ id: "c2" }]
        }
      ]
    });
    assert.deepEqual(subagentStatus().byStatus, {
      started: 0,
      success: 1,
      failure: 1
    });

    // The batch row carries its own tally, so a reader can see how that
    // delegation ended rather than only how many it started.
    const [batch] = subagentStatus().recent;
    assert.equal(batch!.count, 2);
    assert.deepEqual(batch!.settled, { success: 1, failure: 1 });
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
    noteBridgeRequest("request-old-row", {
      activitySubject: `req:${"request-old-row"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "research",
          count: 1,
          children: [{ id: "c1" }]
        }
      ]
    });
    const aged = JSON.parse(serializeRouterState());
    for (const entry of aged.subagents.recent) delete entry.settled;
    await writeFile(file, JSON.stringify(aged), "utf8");

    resetSubagentTelemetry();
    assert.equal(loadRouterState(file), true);
    assert.deepEqual(
      subagentStatus().recent[0]!.settled,
      { success: 0, failure: 0 },
      "a restored row is normalized, not left ragged"
    );

    noteBridgeRequest("request-old-row", {
      activitySubject: `req:${"request-old-row"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "research",
          count: 1,
          children: [{ id: "c2" }]
        }
      ]
    });
    ingestAgentEvents({
      requestId: "request-old-row",
      events: [
        {
          type: "subagent_result",
          tool: "invoke_subagent",
          role: "research",
          outcome: "success",
          children: [{ id: "c2" }]
        }
      ]
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
    noteBridgeRequest("request-parent-close", {
      activitySubject: `req:${"request-parent-close"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    ingestAgentEvents({
      requestId: "request-parent-close",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "research",
          count: 1,
          children: [{ id: "c1" }]
        }
      ]
    });
    assert.deepEqual(subagentStatus().byStatus, { started: 1 });

    closeBridgeSubagentsForRequest("request-parent-close", "success", 45_000);
    assert.deepEqual(subagentStatus().byStatus, { started: 0, success: 1 });
    assert.deepEqual(subagentStatus().recent[0]!.settled, {
      success: 1,
      failure: 0
    });
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
  const roleAttempts = (usage: any, role: any) =>
    Number(usage.byRole?.[role]?.attempts ?? 0);
  const roleSuccesses = (usage: any, role: any) =>
    Number(usage.byRole?.[role]?.successes ?? 0);
  const modelAttempts = (usage: any, key: any) =>
    Number(usage.byModel?.[key]?.attempts ?? 0);

  resetSubagentTelemetry();
  try {
    noteBridgeRequest("request-usage", {
      activitySubject: `req:${"request-usage"}`,
      provider: "antigravity",
      model: "gemini-3.8-flash-medium",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    const stepUpdate = {
      step_index: 7,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: {
        name: "invoke_subagent",
        args: JSON.stringify({
          Subagents: [
            {
              TypeName: "explorer",
              Model: "inherit",
              Prompt: "Catalog every build error"
            },
            {
              TypeName: "explorer",
              Model: "gemini-3.8-flash-high",
              Prompt: "Catalog every lint error"
            },
            {
              Model: "inherit",
              Prompt: "A child whose step exported no archetype"
            }
          ]
        })
      }
    };
    const children = spawnedChildren(stepUpdate);
    assert.deepEqual(
      children.map(({ id }) => id),
      ["s7.0", "s7.1", "s7.2"],
      "each child is addressable so its own turn can be closed"
    );
    const spawned = ingestAgentEvents({
      requestId: "request-usage",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "explorer",
          count: 2,
          children: [
            { id: "s7.0" },
            { id: "s7.1", model: "gemini-3.8-flash-high" }
          ]
        },
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: null,
          count: 1,
          children: [{ id: "s7.2" }]
        }
      ]
    });
    assert.deepEqual(spawned, {
      accepted: 3,
      closed: 0,
      unavailable: 0,
      rejected: 0,
      reason: null
    });

    const usageOpen = getRouterStatus().usage;
    assert.equal(
      roleAttempts(usageOpen, "explorer") -
      roleAttempts(usageBefore, "explorer"),
      2
    );
    // A roleless child must not land in the `unattributed` bucket: it has its
    // own subagent role bucket, so a delegation is not credited to its parent.
    assert.equal(
      roleAttempts(usageOpen, UNATTRIBUTED_SUBAGENT_ROLE) -
      roleAttempts(usageBefore, UNATTRIBUTED_SUBAGENT_ROLE),
      1
    );
    assert.equal(
      roleAttempts(usageOpen, "unattributed"),
      roleAttempts(usageBefore, "unattributed")
    );
    // `inherit` is agy naming the parent's model rather than choosing one.
    assert.equal(
      modelAttempts(usageOpen, "antigravity/gemini-3.8-flash-medium") -
      modelAttempts(usageBefore, "antigravity/gemini-3.8-flash-medium"),
      2
    );
    assert.equal(
      modelAttempts(usageOpen, "antigravity/gemini-3.8-flash-high") -
      modelAttempts(usageBefore, "antigravity/gemini-3.8-flash-high"),
      1
    );
    assert.equal(
      Number(usageOpen.byOrigin?.subagent?.active ?? 0) -
      Number(usageBefore.byOrigin?.subagent?.active ?? 0),
      3,
      "children are in flight until they are closed"
    );
    const liveWithParent = getRouterStatus();
    assert.equal(
      liveWithParent.providers.antigravity.active,
      4,
      "the explicitly tracked parent and three children share the selected provider"
    );
    assert.equal(
      liveWithParent.providers.unattributed,
      undefined,
      "bridge activity must never create an unattributed provider"
    );

    // A close carries the duration the CLI spent on the child, which is the
    // only per-child turn measurement that exists.
    const closed = ingestAgentEvents({
      requestId: "request-usage",
      events: [
        {
          type: "subagent_result",
          tool: "invoke_subagent",
          role: "explorer",
          outcome: "success",
          durationMs: 4000,
          children: [{ id: "s7.0" }, { id: "s7.1" }]
        }
      ]
    });
    assert.deepEqual(
      closed,
      { accepted: 0, closed: 2, unavailable: 0, rejected: 0, reason: null },
      "a close settles buckets rather than counting new subagents"
    );
    assert.equal(
      subagentStatus().total,
      3,
      "closing a child does not spawn another one"
    );

    const usageClosed = getRouterStatus().usage;
    assert.equal(
      roleSuccesses(usageClosed, "explorer") -
      roleSuccesses(usageBefore, "explorer"),
      2
    );
    assert.equal(
      Number(usageClosed.byRole.explorer.maxDurationMs) >= 4000,
      true,
      "the reported duration is the child's own"
    );

    // The child the bridge never closed still ends with the parent turn, so a
    // bridge that dies mid-turn cannot strand it as permanently active.
    assert.equal(
      closeBridgeSubagentsForRequest("request-usage", "success", 9000),
      1
    );
    const usageSwept = getRouterStatus().usage;
    assert.equal(
      roleSuccesses(usageSwept, UNATTRIBUTED_SUBAGENT_ROLE) -
      roleSuccesses(usageBefore, UNATTRIBUTED_SUBAGENT_ROLE),
      1
    );
    assert.equal(
      Number(usageSwept.byOrigin?.subagent?.active ?? 0) -
      Number(usageBefore.byOrigin?.subagent?.active ?? 0),
      0
    );
    assert.equal(
      getRouterStatus().providers.antigravity.active,
      0,
      "parent and child activity settle together"
    );
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
  const reasonCount = (snapshot: any) =>
    Number(snapshot.byReason?.spawn_tool_unavailable ?? 0);
  try {
    noteBridgeRequest("request-denied", {
      activitySubject: `req:${"request-denied"}`,
      provider: "claude",
      model: "claude-opus-5-5",
      role: null,
      workspace: "SimulatorLife/RacingGame"
    });
    const result = ingestAgentEvents({
      requestId: "request-denied",
      events: [
        {
          type: "subagent_tools_unavailable",
          expected: ["Agent", "Task"],
          available: ["Read", "Bash", "Write"]
        }
      ]
    });
    // It is not a spawn, so it moves no spawn counter.
    assert.deepEqual(result, {
      accepted: 0,
      closed: 0,
      unavailable: 1,
      rejected: 0,
      reason: null
    });
    assert.equal(subagentStatus().total, 0);

    const after = getRouterStatus().spawnFailures;
    assert.equal(reasonCount(after) - reasonCount(before), 1);
    assert.equal(after.total - before.total, 1);
    assert.equal(after.recent[0].reason, "spawn_tool_unavailable");
    assert.equal(
      after.recent[0].requestedModel,
      "claude-opus-5-5",
      "the failure names the model that was left unable to delegate"
    );
  } finally {
    resetSubagentTelemetry();
  }
});

test("successful responses identify the resolved provider, model, and request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return Response.json(
        {
          id: "upstream-response",
          model: "provider-internal-model",
          output_text: "ok",
          nested: {
            model: "provider-internal-model",
            tool: {
              type: "function_call",
              name: "multi_agent_v1__spawn_agent",
              model: "provider-internal-model"
            },
            script:
              '{"model":"provider-internal-model","name":"multi_agent_v1__spawn_agent"}'
          }
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-header"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-header");
    const body = await response.json();
    assert.equal(body.model, "sonnet");
    assert.equal(body.nested.model, "sonnet");
    assert.deepEqual(body.nested.tool, {
      type: "function_call",
      name: "spawn_agent",
      model: "sonnet",
      namespace: "multi_agent_v1"
    });
    assert.equal(
      body.nested.script,
      '{"model":"provider-internal-model","name":"multi_agent_v1__spawn_agent"}'
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
  }
});

test("resolveTurnMetadataHeader prefers the canonical header and falls back to embedded client_metadata", () => {
  const rawJson = JSON.stringify({ workspaces: { main: "/tmp/ws" } });
  assert.equal(
    resolveTurnMetadataHeader(
      { headers: { "x-codex-turn-metadata": rawJson } } as any,
      {} as any
    ),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader(
      { headers: { "x-codex-turn-metadata": [rawJson] } } as any,
      {} as any
    ),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader(
      { headers: {} } as any,
      { client_metadata: { "x-codex-turn-metadata": rawJson } } as any
    ),
    rawJson
  );
  assert.equal(
    resolveTurnMetadataHeader({ headers: {} } as any, {
      client_metadata: {
        "x-codex-turn-metadata": { workspaces: { main: "/tmp/ws" } }
      }
    }),
    JSON.stringify({ workspaces: { main: "/tmp/ws" } })
  );
  assert.equal(
    resolveTurnMetadataHeader(
      { headers: { "x-codex-turn-metadata": "not json" } } as any,
      {} as any
    ),
    null
  );
  assert.equal(
    resolveTurnMetadataHeader({ headers: {} } as any, {} as any),
    null
  );
  assert.equal(parseTurnMetadataJson("[]"), null);
  assert.equal(
    (parseTurnMetadataJson(rawJson) as any).workspaces.main,
    "/tmp/ws"
  );
});

test("derives a privacy-safe repository and cwd label from turn metadata", () => {
  const context = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspaces: {
        "/Users/henrykirk/Desktop/RacingGame": {
          associated_remote_urls: {
            origin: "https://github.com/SimulatorLife/RacingGame.git"
          }
        }
      }
    })
  );
  assert.deepEqual(context, {
    key: "SimulatorLife/RacingGame",
    cwd: "RacingGame",
    workspace_id: "ws_d8911866a131"
  });
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
    workspace: { key: "SimulatorLife/RacingGame", cwd: "RacingGame" }
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
    toolCalls: 2
  });
  const workspace =
    getRouterStatus().usage.byWorkspace["SimulatorLife/RacingGame"];
  assert.equal(workspace.cwd, "RacingGame");
  assert.equal(workspace.attempts, 1);
  assert.equal(workspace.successes, 1);
  assert.equal(workspace.byRole.worker.successes, 1);
  assert.equal(workspace.byModel["claude/sonnet"].toolCalls, 2);
  assert.equal(workspace.byProvider.claude.successes, 1);
  resetRouterTelemetry();
});

test("persists workspace usage dimensions across router restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-workspace-usage-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    const workspace = { key: "SimulatorLife/RacingGame", cwd: "RacingGame" };
    recordRouterEvent({
      phase: "selected",
      requestId: "workspace-persist",
      role: "worker",
      requestedModel: "autodev/worker",
      provider: "minimax",
      model: "MiniMax-M3",
      workspace
    });
    recordRouterEvent({
      phase: "result",
      requestId: "workspace-persist",
      role: "worker",
      requestedModel: "autodev/worker",
      provider: "minimax",
      model: "MiniMax-M3",
      workspace,
      outcome: "success",
      status: 200,
      elapsedMs: 7
    });
    await persistRouterStateNow(stateFile);
    resetRouterTelemetry();
    assert.equal(loadRouterState(stateFile), true);
    const restored =
      getRouterStatus().usage.byWorkspace["SimulatorLife/RacingGame"];
    assert.equal(restored.cwd, "RacingGame");
    assert.equal(restored.byModel["minimax/MiniMax-M3"].successes, 1);
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
          associated_remote_urls: {
            origin: "https://github.com/SimulatorLife/RacingGame.git"
          }
        }
      }
    })
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
          associated_remote_urls: {
            origin: "https://github.com/Company/WebPortal.git"
          }
        }
      }
    })
  );
  assert.equal(wsContextB.key, "Company/WebPortal");
  assert.equal(wsContextB.workspace_id, "ws-beta-456");

  // Record normal turns that increment attempts, successes, and scalar toolCalls
  recordRouterEvent({
    phase: "selected",
    requestId: "req-a",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    workspace: wsContextA
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-a",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    workspace: wsContextA,
    outcome: "success",
    status: 200,
    elapsedMs: 20,
    toolCalls: 5
  });

  recordRouterEvent({
    phase: "selected",
    requestId: "req-b",
    provider: "claude",
    model: "sonnet",
    workspace: wsContextB
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
    toolCalls: 3
  });

  // Helper for OTLP points
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (
    entries: any,
    value: any,
    start: any = "1",
    time: any = "2"
  ) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value)
  });

  // Send tool and skill OTLP metrics for both workspaces
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-alpha-123"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec_command"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      4,
                      "10",
                      "20"
                    ),
                    point(
                      [
                        ["tool", "read_file"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      2,
                      "10",
                      "20"
                    )
                  ]
                }
              },
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["skill", "ccc"],
                        ["status", "ok"],
                        ["invoke_type", "explicit"]
                      ],
                      2,
                      "10",
                      "20"
                    )
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        resource: { attributes: attrs([["workspace_id", "ws-beta-456"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec_command"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      3,
                      "10",
                      "20"
                    ),
                    point(
                      [
                        ["tool", "write_file"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      1,
                      "10",
                      "20"
                    )
                  ]
                }
              },
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["skill", "lsp-mcp-server"],
                        ["status", "ok"],
                        ["invoke_type", "explicit"]
                      ],
                      5,
                      "10",
                      "20"
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const status = getRouterStatus() as any;
  const wsA = status.usage.byWorkspace["SimulatorLife/RacingGame"];
  const wsB = status.usage.byWorkspace["Company/WebPortal"];

  // Scalar toolCalls semantics preserved
  assert.equal(wsA.toolCalls, 5);
  assert.equal(wsB.toolCalls, 3);

  // Per-workspace skillUses
  assert.equal(wsA.skillUses, 2);
  assert.equal(wsB.skillUses, 5);

  // Per-workspace named tools (byTool)
  assert.equal(Array.isArray(wsA.byTool), true);
  assert.equal(
    wsA.byTool.find((t: any) => t.tool === "exec_command")?.count,
    4
  );
  assert.equal(wsA.byTool.find((t: any) => t.tool === "read_file")?.count, 2);
  assert.equal(
    wsA.byTool.find((t: any) => t.tool === "write_file"),
    undefined
  );

  assert.equal(Array.isArray(wsB.byTool), true);
  assert.equal(
    wsB.byTool.find((t: any) => t.tool === "exec_command")?.count,
    3
  );
  assert.equal(wsB.byTool.find((t: any) => t.tool === "write_file")?.count, 1);
  assert.equal(
    wsB.byTool.find((t: any) => t.tool === "read_file"),
    undefined
  );

  // Per-workspace named skills (bySkill)
  assert.equal(Array.isArray(wsA.bySkill), true);
  assert.equal(wsA.bySkill.find((s: any) => s.skill === "ccc")?.total, 2);
  assert.equal(
    wsA.bySkill.find((s: any) => s.skill === "lsp-mcp-server"),
    undefined
  );

  assert.equal(Array.isArray(wsB.bySkill), true);
  assert.equal(
    wsB.bySkill.find((s: any) => s.skill === "lsp-mcp-server")?.total,
    5
  );
  assert.equal(
    wsB.bySkill.find((s: any) => s.skill === "ccc"),
    undefined
  );

  // Global telemetry preserved and reflects aggregate of both workspaces
  const globalExec = status.codexTelemetry.tools.byTool.find(
    (t: any) => t.tool === "exec_command"
  );
  assert.equal(globalExec?.count, 7); // 4 + 3
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "read_file")
      ?.count,
    2
  );
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "write_file")
      ?.count,
    1
  );
  assert.equal(status.codexTelemetry.skills.injected.total, 7); // 2 + 5
  assert.equal(
    status.codexTelemetry.skills.injected.bySkill.find(
      (s: any) => s.skill === "ccc"
    )?.total,
    2
  );
  assert.equal(
    status.codexTelemetry.skills.injected.bySkill.find(
      (s: any) => s.skill === "lsp-mcp-server"
    )?.total,
    5
  );

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("dedupes cumulative and delta OTLP metrics independently across multiple workspaces", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  registerWorkspaceId("ws-1", "RepoA");
  registerWorkspaceId("ws-2", "RepoB");

  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any, start?: any, time?: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value)
  });

  // Workspace 1 sends cumulative 5 at T=100
  // Workspace 2 sends cumulative 3 at T=100
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-1"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2, // CUMULATIVE
                  dataPoints: [
                    point(
                      [
                        ["tool", "bash"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      5,
                      0,
                      100
                    )
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        resource: { attributes: attrs([["workspace_id", "ws-2"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2, // CUMULATIVE
                  dataPoints: [
                    point(
                      [
                        ["tool", "bash"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      3,
                      0,
                      100
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  let status = getRouterStatus();
  assert.equal(
    status.usage.byWorkspace.RepoA.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    5
  );
  assert.equal(
    status.usage.byWorkspace.RepoB.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    3
  );
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    8
  );

  // Workspace 1 sends cumulative 8 at T=200 (delta = 3)
  // Workspace 2 resends cumulative 3 at T=100 (duplicate timestamp -> delta = 0)
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-1"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    point(
                      [
                        ["tool", "bash"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      8,
                      0,
                      200
                    )
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        resource: { attributes: attrs([["workspace_id", "ws-2"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    point(
                      [
                        ["tool", "bash"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      3,
                      0,
                      100
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  status = getRouterStatus();
  assert.equal(
    status.usage.byWorkspace.RepoA.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    8
  );
  assert.equal(
    status.usage.byWorkspace.RepoB.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    3
  );
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    11
  );

  // Resend identical cumulative 8 at T=200 for Workspace 1 (duplicate timestamp)
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-1"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    point(
                      [
                        ["tool", "bash"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      8,
                      0,
                      200
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  status = getRouterStatus();
  assert.equal(
    status.usage.byWorkspace.RepoA.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    8
  );
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "bash")
      ?.count,
    11
  );

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("attributes tool call durations per-workspace and preserves global duration metrics", () => {
  resetRouterTelemetry();
  resetOtelTelemetry();

  registerWorkspaceId("ws-dur-1", "RepoDurA");
  registerWorkspaceId("ws-dur-2", "RepoDurB");

  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const histPoint = (
    entries: any,
    count: any,
    sum: any,
    start?: any,
    time?: any
  ) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    count: String(count),
    sum
  });

  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-dur-1"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call.duration_ms",
                histogram: {
                  aggregationTemporality: 1, // DELTA
                  dataPoints: [
                    histPoint(
                      [
                        ["tool_name", "exec"],
                        ["source", "builtin"]
                      ],
                      2,
                      100,
                      0,
                      10
                    )
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        resource: { attributes: attrs([["workspace_id", "ws-dur-2"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call.duration_ms",
                histogram: {
                  aggregationTemporality: 1, // DELTA
                  dataPoints: [
                    histPoint(
                      [
                        ["tool_name", "exec"],
                        ["source", "builtin"]
                      ],
                      3,
                      60,
                      0,
                      10
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const status = getRouterStatus();
  const toolA = status.usage.byWorkspace.RepoDurA.byTool.find(
    (t: any) => t.tool === "exec"
  );
  assert.equal(toolA.durationCount, 2);
  assert.equal(toolA.durationMs, 100);
  assert.equal(toolA.averageDurationMs, 50);

  const toolB = status.usage.byWorkspace.RepoDurB.byTool.find(
    (t: any) => t.tool === "exec"
  );
  assert.equal(toolB.durationCount, 3);
  assert.equal(toolB.durationMs, 60);
  assert.equal(toolB.averageDurationMs, 20);

  const globalTool = status.codexTelemetry.tools.byTool.find(
    (t: any) => t.tool === "exec"
  );
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

  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (
    entries: any,
    value: any,
    start: any = "0",
    time: any = "10"
  ) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(time),
    asInt: String(value)
  });

  // 1. Data point with an unknown workspace ID fails closed
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec"],
                        ["source", "builtin"],
                        ["workspace_id", "ws-unknown-999"]
                      ],
                      2
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  let status = getRouterStatus();
  assert.equal(status.usage.byWorkspace.KnownRepo, undefined);
  assert.equal(
    status.codexTelemetry.tools.byTool.find((t: any) => t.tool === "exec")
      ?.count,
    2
  );

  let diag = attributionDiagnosticsStatus();
  assert.equal(diag.unattributed, 1);
  assert.equal(diag.byReason.unknown_workspace_id, 1);
  assert.equal(diag.unknownWorkspaceIds.includes("ws-unknown-999"), true);

  // 2. Unambiguous resource fallback succeeds
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-known"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec"],
                        ["source", "builtin"]
                      ],
                      4,
                      10,
                      20
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  status = getRouterStatus();
  assert.equal(
    status.usage.byWorkspace.KnownRepo.byTool.find(
      (t: any) => t.tool === "exec"
    )?.count,
    4
  );
  diag = attributionDiagnosticsStatus();
  assert.equal(diag.attributed, 1);
  assert.equal(diag.bySource.resource, 1);

  // 3. Ambiguous resource fallback (conflicting workspace IDs) fails closed
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: {
          attributes: attrs([
            ["workspace_id", "ws-known"],
            ["workspace.id", "ws-different"]
          ])
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec"],
                        ["source", "builtin"]
                      ],
                      1,
                      20,
                      30
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  diag = attributionDiagnosticsStatus();
  assert.equal(diag.byReason.ambiguous_resource, 1);
  // KnownRepo should not have received the ambiguous call
  assert.equal(
    status.usage.byWorkspace.KnownRepo.byTool.find(
      (t: any) => t.tool === "exec"
    )?.count,
    4
  );

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
          associated_remote_urls: {
            origin: "https://github.com/Confidential/SecretProject.git"
          }
        }
      }
    })
  );

  // Workspace key is privacy-safe repository, and cwd is basename
  assert.equal(context.key, "Confidential/SecretProject");
  assert.equal(context.cwd, "SecretProject");
  // Opaque workspace_id hashes local file path
  assert.equal(context.workspace_id!.startsWith("ws_"), true);
  assert.equal(context.workspace_id!.includes("/Users/henrykirk"), false);

  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: "1",
    timeUnixNano: "2",
    asInt: String(value)
  });

  // OTLP datapoint with unknown path-like workspace_id
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "apply_patch"],
                        ["source", "builtin"],
                        ["workspace_id", "/Users/henrykirk/Private/Path"]
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const status = getRouterStatus();
  const serialized = JSON.stringify({
    usage: status.usage,
    attributionDiagnostics: status.attributionDiagnostics
  });
  assert.equal(serialized.includes("/Users/henrykirk"), false);
  const diag = attributionDiagnosticsStatus();
  assert.equal(JSON.stringify(diag).includes("/Users/henrykirk"), false);

  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("persists and restores per-workspace tool and skill attribution across router restarts", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "autodev-workspace-attribution-")
  );
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    resetOtelTelemetry();

    registerWorkspaceId("ws-pers-1", "OwnerA/ProjectA");
    registerWorkspaceId("ws-pers-2", "OwnerB/ProjectB");

    const attrs = (entries: any[]) =>
      entries.map(([key, value]: [any, any]) => ({
        key,
        value: { stringValue: String(value) }
      }));
    const point = (entries: any, value: any, start?: any, time?: any) => ({
      attributes: attrs(entries),
      startTimeUnixNano: String(start),
      timeUnixNano: String(time),
      asInt: String(value)
    });

    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          resource: { attributes: attrs([["workspace_id", "ws-pers-1"]]) },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.tool.call",
                  sum: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      point(
                        [
                          ["tool", "exec_command"],
                          ["source", "builtin"],
                          ["status", "ok"]
                        ],
                        6,
                        0,
                        100
                      )
                    ]
                  }
                },
                {
                  name: "codex.skill.injected",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      point(
                        [
                          ["skill", "ccc"],
                          ["status", "ok"],
                          ["invoke_type", "explicit"]
                        ],
                        3,
                        0,
                        100
                      )
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    });

    await persistRouterStateNow(stateFile);

    // Verify persisted schema
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(raw.usage.schemaVersion, 8);
    assert.ok(Array.isArray(raw.usage.workspaceRegistry));
    const savedWs = raw.usage.byWorkspace["OwnerA/ProjectA"];
    assert.equal(savedWs.skillUses, 3);
    assert.equal(
      savedWs.byTool.find((t: any) => t.tool === "exec_command")?.count,
      6
    );
    assert.equal(savedWs.bySkill.find((s: any) => s.skill === "ccc")?.total, 3);

    resetRouterTelemetry();
    resetOtelTelemetry();

    assert.equal(loadRouterState(stateFile), true);

    const restoredStatus = getRouterStatus();
    const restoredWs = restoredStatus.usage.byWorkspace["OwnerA/ProjectA"];
    assert.equal(restoredWs.skillUses, 3);
    assert.equal(
      restoredWs.byTool.find((t: any) => t.tool === "exec_command")?.count,
      6
    );
    assert.equal(
      restoredWs.bySkill.find((s: any) => s.skill === "ccc")?.total,
      3
    );

    // Subsequent cumulative metric export resumes from persisted series without double-counting
    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          resource: { attributes: attrs([["workspace_id", "ws-pers-1"]]) },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.tool.call",
                  sum: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      point(
                        [
                          ["tool", "exec_command"],
                          ["source", "builtin"],
                          ["status", "ok"]
                        ],
                        9,
                        0,
                        200
                      )
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    });

    const afterResumeStatus = getRouterStatus();
    const afterWs = afterResumeStatus.usage.byWorkspace["OwnerA/ProjectA"];
    assert.equal(
      afterWs.byTool.find((t: any) => t.tool === "exec_command")?.count,
      9
    ); // 6 + (9 - 6) = 9
  } finally {
    resetRouterTelemetry();
    resetOtelTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("downstreamHeaders forwards only the allowlisted turn-metadata header and never a client-supplied credential", () => {
  assert.deepEqual([...FORWARDED_REQUEST_HEADERS], ["x-codex-turn-metadata"]);
  const route = { provider: "claude", envKey: "LITELLM_API_KEY" };
  const withoutTurnMetadata = downstreamHeaders(route as any, null, null);
  assert.equal(withoutTurnMetadata["x-codex-turn-metadata"], undefined);
  const withTurnMetadata = downstreamHeaders(
    route as any,
    null,
    '{"workspaces":{}}'
  );
  assert.equal(withTurnMetadata["x-codex-turn-metadata"], '{"workspaces":{}}');
  assert.notEqual(
    withTurnMetadata.authorization,
    "Bearer client-supplied-secret"
  );
});

test("downstreamHeaders names the agent role the router assigned, and omits it when there is none", () => {
  const route = { provider: "claude", envKey: "LITELLM_API_KEY" };
  assert.equal(
    downstreamHeaders(route as any, null, null)[AGENT_ROLE_HEADER],
    undefined
  );
  assert.equal(
    downstreamHeaders(route as any, null, null, ORCHESTRATOR_AGENT_ROLE)[
    AGENT_ROLE_HEADER
    ],
    "orchestrator"
  );
  assert.equal(
    downstreamHeaders(route as any, null, null, "explorer")[AGENT_ROLE_HEADER],
    "explorer"
  );
});

test("downstreamHeaders forces a fresh connection per request to the codex route to avoid reusing a stale pooled keep-alive socket", () => {
  const codexHeaders = downstreamHeaders(
    { provider: "codex", envKey: null } as any,
    { token: "t", accountId: "a" },
    null
  );
  assert.equal(
    codexHeaders.connection,
    "close",
    "codex requests must never be served from a pooled keep-alive connection"
  );
});

test("downstreamHeaders leaves keep-alive pooling untouched for other providers", () => {
  for (const route of [
    { provider: "claude", envKey: "LITELLM_API_KEY" },
    { provider: "minimax", envKey: "MINIMAX_API_KEY" },
    { provider: "antigravity", envKey: "LITELLM_API_KEY" },
    { provider: "copilot", envKey: "CODEX_ROUTER_COPILOT_API_KEY" }
  ]) {
    const headers = downstreamHeaders(route as any, null, null);
    assert.equal(
      headers.connection,
      undefined,
      `${route!.provider} should keep reusing pooled connections`
    );
  }
});

test("forwards x-codex-turn-metadata to the upstream provider bridge without leaking the caller's own authorization", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders: any = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      upstreamHeaders = options.headers;
      return Response.json(
        {
          id: "upstream-response",
          model: "sonnet",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    // Codex's canonical turn metadata keys the workspaces map by absolute
    // repo/workspace path; values carry only git metadata. The router must
    // forward that exact JSON shape verbatim, with no reformatting.
    const turnMetadata = JSON.stringify({
      workspaces: {
        "/Users/henrykirk/AutoDev": { git: { branch: "main", sha: "abc123" } }
      }
    });
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer client-supplied-secret",
          "x-codex-turn-metadata": turnMetadata
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 200);
    const forwardedMetadata = JSON.parse(
      upstreamHeaders["x-codex-turn-metadata"]
    );
    assert.deepEqual(
      forwardedMetadata.workspaces,
      JSON.parse(turnMetadata).workspaces
    );
    assert.equal(forwardedMetadata.workspace_id, "ws_fe80d628d784");
    assert.notEqual(
      upstreamHeaders.authorization,
      "Bearer client-supplied-secret"
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
  }
});

test("relays the canonical workspaces-map-keyed turn metadata even when it arrives only as embedded client_metadata", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamHeaders: any = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      upstreamHeaders = options.headers;
      return Response.json(
        {
          id: "upstream-response",
          model: "sonnet",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    // Callers that cannot set custom headers embed the same canonical shape
    // under client_metadata["x-codex-turn-metadata"]; the router must
    // normalize that back into the canonical header before forwarding.
    const canonical = {
      workspaces: { "/Users/henrykirk/AutoDev": { git: { branch: "main" } } }
    };
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "sonnet",
          stream: false,
          client_metadata: { "x-codex-turn-metadata": canonical }
        })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(
      upstreamHeaders["x-codex-turn-metadata"],
      JSON.stringify({ ...canonical, workspace_id: "ws_fe80d628d784" })
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
  }
});

test("restores validated workspace metadata on role and concrete continuations", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
  };
  const workspace = await mkdtemp(
    join(tmpdir(), "autodev-workspace-continuity-")
  );
  const observedHeaders: (string | null)[] = [];
  process.env.LITELLM_API_KEY = "test-provider-key";
  process.env.MINIMAX_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  for (const provider of [
    "claude",
    "antigravity",
    "minimax",
    "copilot",
    "codex"
  ])
    cooldowns.clear(provider);
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness"))
      return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      observedHeaders.push(options.headers["x-codex-turn-metadata"] ?? null);
      return Response.json(
        { id: "workspace-continuity", output_text: "ok" },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const turnMetadata = JSON.stringify({
      workspaces: { [workspace]: { git: { branch: "main" } } }
    });
    for (const [index, model] of [
      "gemini-3.8-flash-medium",
      "autodev/default"
    ].entries()) {
      const sessionId = `workspace-continuity-${index}`;
      const send = (headers: any) =>
        originalFetch(`http://127.0.0.1:${address.port}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": sessionId,
            ...headers
          },
          body: JSON.stringify({ model, stream: false })
        });
      assert.equal(
        (await send({ "x-codex-turn-metadata": turnMetadata })).status,
        200
      );
      assert.equal((await send({})).status, 200);
      const continuedHeader = observedHeaders.at(-1);
      assert.deepEqual(JSON.parse(continuedHeader!).workspaces[workspace], {});
    }
  } finally {
    await closeServer(server);
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
  let upstreamHeaders: any = null;
  let upstreamPayload: any = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4002/v1/responses") {
      upstreamHeaders = options.headers;
      upstreamPayload = JSON.parse(options.body);
      return Response.json(
        {
          id: "antigravity-response",
          model: "gemini-3.8-flash-medium",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const turnMetadata = JSON.stringify({
      workspaces: { "/Users/henrykirk/AutoDev": { git: { branch: "main" } } }
    });
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": turnMetadata
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash-medium",
          stream: false,
          extra_headers: {
            authorization: "Bearer caller-secret",
            "x-untrusted": "should-not-forward"
          }
        })
      }
    );
    assert.equal(response.status, 200);

    // These used to ride in the Responses body because the LiteLLM hop dropped
    // raw headers. The router calls the adapter directly now, so they are
    // ordinary request headers.
    const forwardedMetadata = JSON.parse(
      upstreamHeaders["x-codex-turn-metadata"]
    );
    assert.deepEqual(
      forwardedMetadata.workspaces,
      JSON.parse(turnMetadata).workspaces
    );
    assert.equal(forwardedMetadata.workspace_id, "ws_fe80d628d784");
    assert.equal(
      upstreamHeaders["x-autodev-subagent-spawn-tools"],
      "invoke_subagent"
    );
    assert.ok(upstreamHeaders["x-autodev-request-id"]);
    assert.ok(upstreamHeaders["x-autodev-agent-events-url"]);

    // `extra_headers` is a caller-supplied escape hatch that would bypass the
    // router's credential and header allowlist, so it is dropped outright and
    // never rebuilt.
    assert.equal(Object.hasOwn(upstreamPayload, "extra_headers"), false);
    assert.notEqual(upstreamHeaders.authorization, "Bearer caller-secret");
    assert.equal(upstreamHeaders["x-untrusted"], undefined);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
  }
});

test("turns a provider stream that ends before completion into an explicit failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response(
        String.raw`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet" })
      }
    );
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /partial/);
    assert.match(body, /response\.failed/);
    assert.match(body, /closed the stream before response\.completed/);
    assert.equal(getRouterStatus().providers.claude.failures > 0, true);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("does not classify an explicitly incomplete response as a successful turn", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return new Response(
        String.raw`event: response.completed\ndata: {"type":"response.completed","response":{"status":"incomplete","output_text":"partial"}}\n\ndata: [DONE]\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet" })
      }
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
    assert.equal(getRouterStatus().providers.claude.failures > 0, true);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("rejects missing or malformed models before provider routing", async () => {
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    for (const body of [
      null,
      {},
      { model: "" },
      { model: "  " },
      { model: 42 }
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.type, "invalid_request_error");
      assert.match(payload.error.message, /JSON object|non-empty string model/);
    }
  } finally {
    await closeServer(server);
  }
});

test("ingests Codex OTEL turn and MCP lifecycle telemetry without prompt content", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  ingestOtelSignal("logs", {
    resourceLogs: [
      {
        resource: {
          attributes: attributes([
            ["mcp_servers", "playwright, codex_apps, node_repl"]
          ])
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: attributes([
                  ["event.name", "codex.conversation_starts"],
                  ["conversation.id", "conversation-otel"],
                  ["model", CONFIGURED_ORCHESTRATOR_MODEL]
                ])
              },
              {
                attributes: attributes([
                  ["event.name", "codex.user_prompt"],
                  ["conversation.id", "conversation-otel"],
                  ["prompt_length", 42],
                  ["prompt_text", "do-not-store-this"]
                ])
              },
              {
                attributes: attributes([
                  ["event.name", "codex.turn_ttft"],
                  ["conversation.id", "conversation-otel"],
                  ["duration_ms", 321]
                ])
              },
              {
                attributes: attributes([
                  ["event.name", "codex.sse_event"],
                  ["event.kind", "response.completed"],
                  ["conversation.id", "conversation-otel"],
                  ["input_token_count", 100],
                  ["output_token_count", 25],
                  ["cached_token_count", 5],
                  ["reasoning_token_count", 10],
                  ["tool_token_count", 3]
                ])
              }
            ]
          }
        ]
      }
    ]
  });
  const span = (name: string, serverName: string, durationNs = 5_000_000n) => ({
    name,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + durationNs),
    attributes: attributes([["server_name", serverName]]),
    status: { code: 1 }
  });
  ingestOtelSignal("traces", {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              span("make_rmcp_client", "playwright"),
              span("list_tools_for_client_uncached", "playwright", 7_000_000n),
              span("make_rmcp_client", "node_repl", 2_000_000n)
            ]
          }
        ]
      }
    ]
  });
  ingestOtelSignal("metrics", { resourceMetrics: [] });

  const telemetry = codexTelemetryStatus(Date.now());
  assert.deepEqual(telemetry.receiver, {
    logs: 1,
    traces: 1,
    metrics: 1,
    invalid: 0,
    lastReceivedAt: telemetry.receiver.lastReceivedAt
  });
  assert.equal(telemetry.sessionsObserved, 1);
  assert.equal(telemetry.turns.prompts, 1);
  assert.equal(telemetry.turns.completed, 1);
  assert.equal(telemetry.turns.averageTtftMs, 321);
  assert.deepEqual(telemetry.tokens, {
    input: 100,
    output: 25,
    cached: 5,
    reasoning: 10,
    tool: 3,
    total: 143
  });
  assert.deepEqual(
    {
      observed: telemetry.mcpSummary.observed,
      ready: telemetry.mcpSummary.ready,
      error: telemetry.mcpSummary.error,
      stale: telemetry.mcpSummary.stale
    },
    { observed: 3, ready: 1, error: 0, stale: 1 }
  );
  assert.equal(telemetry.mcpSummary.byModel[CONFIGURED_ORCHESTRATOR_MODEL].observed, 3);
  assert.equal(telemetry.mcpSummary.byRole.unattributed.observed, 3);
  assert.equal(telemetry.mcpSummary.byWorkspace.unattributed.observed, 3);
  assert.equal(telemetry.mcpSummary.byAgent["conversation-otel"].observed, 3);
  const playwright = telemetry.mcpServers.find(
    (server: any) => server.name === "playwright"
  );
  assert.equal(playwright.health, "ready");
  assert.equal(playwright.initAttempts, 1);
  assert.equal(playwright.toolDiscoveryAttempts, 1);
  assert.equal(playwright.averageDurationMs, 6);
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  assert.equal(
    codexTelemetryStatus(Date.now() + 121_000).mcpServers.find(
      (server: any) => server.name === "playwright"
    ).health,
    "stale"
  );
  resetOtelTelemetry();
});

test("accepts Collector-forwarded OTLP JSON batches over HTTP at /v1/logs, /v1/traces, and /v1/metrics", async () => {
  // Freezes the HTTP ingress contract for Phase 3 ("Insert OpenTelemetry
  // Collector as OTLP ingress"): the fixture is a realistic OTLP JSON batch
  // shaped exactly as config/otel/collector.yaml's otlphttp/autodev exporter
  // (encoding: json) would forward it, POSTed straight at the router's
  // existing receiver over a real loopback HTTP connection. No Collector
  // process is launched; this only proves the receiver's HTTP contract
  // tolerates a Collector-shaped payload end to end.
  resetOtelTelemetry();
  // The fixture's OTLP timestamps are placeholder tokens rather than literal
  // nanoseconds: MCP server health is computed relative to wall-clock time
  // (see codexTelemetryStatus's OTEL_HEALTH_TTL_MS freshness window), so a
  // frozen literal timestamp would read as permanently stale no matter when
  // this test runs. The tokens are substituted with real, currently-fresh
  // nanosecond offsets here, exactly as a live Collector export would carry
  // its own current timestamps.
  const base = BigInt(Date.now()) * 1_000_000n;
  const fixtureTokens = {
    __OTEL_T0__: base,
    __OTEL_T500MS__: base + 500_000_000n,
    __OTEL_T900MS__: base + 900_000_000n,
    __OTEL_T1200MS__: base + 1_200_000_000n,
    __OTEL_T2S__: base + 2_000_000_000n,
    __OTEL_T6MS__: base + 6_000_000n,
    __OTEL_T13MS__: base + 13_000_000n,
    __OTEL_T20MS__: base + 20_000_000n
  };
  let fixtureText = await readFile(
    new URL("../fixtures/otel/collector-forwarded-otlp.json", import.meta.url),
    "utf8"
  );
  for (const [token, value] of Object.entries(fixtureTokens))
    fixtureText = fixtureText.replaceAll(token, String(value));
  const fixture = JSON.parse(fixtureText);
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const post = (path: string, body: any) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    const logsResponse = await post("/v1/logs", fixture.logs);
    assert.equal(logsResponse.status, 200);
    assert.deepEqual(await logsResponse.json(), {});

    const tracesResponse = await post("/v1/traces", fixture.traces);
    assert.equal(tracesResponse.status, 200);
    assert.deepEqual(await tracesResponse.json(), {});

    const metricsResponse = await post("/v1/metrics", fixture.metrics);
    assert.equal(metricsResponse.status, 200);
    assert.deepEqual(await metricsResponse.json(), {});

    // The receiver counted exactly one export per signal, with no malformed
    // requests, no matter that the batches arrived via an HTTP round trip
    // rather than a direct in-process call.
    const telemetry = codexTelemetryStatus(Date.now());
    assert.deepEqual(
      {
        logs: telemetry.receiver.logs,
        traces: telemetry.receiver.traces,
        metrics: telemetry.receiver.metrics,
        invalid: telemetry.receiver.invalid
      },
      { logs: 1, traces: 1, metrics: 1, invalid: 0 }
    );
    assert.equal(typeof telemetry.receiver.lastReceivedAt, "string");

    // The fixture's logs batch carries the same conversation/turn/token shape
    // as the direct-ingestion test above; the HTTP path must derive identical
    // telemetry semantics from it.
    assert.equal(telemetry.sessionsObserved, 1);
    assert.equal(telemetry.turns.prompts, 1);
    assert.equal(telemetry.turns.completed, 1);
    assert.equal(telemetry.turns.averageTtftMs, 410);
    assert.deepEqual(telemetry.tokens, {
      input: 200,
      output: 40,
      cached: 10,
      reasoning: 15,
      tool: 5,
      total: 270
    });

    // The fixture's traces batch reports one healthy MCP server and one that
    // errored during initialize; both must be observed from the HTTP path.
    const playwright = telemetry.mcpServers.find(
      (entry: any) => entry.name === "playwright"
    );
    const codexApps = telemetry.mcpServers.find(
      (entry: any) => entry.name === "codex_apps"
    );
    assert.equal(playwright.health, "ready");
    assert.equal(codexApps.health, "error");

    // The fixture's metrics batch reports tool, skill, and hook activity that
    // must land in the corresponding dimensions.
    assert.equal(telemetry.skills.injected.total, 2);
    assert.equal(telemetry.toolResults.total, 1);

    // No prompt content anywhere in either exposed telemetry surface, and no
    // request was ever counted as malformed.
    const status = getRouterStatus();
    assert.equal(
      JSON.stringify(telemetry).includes(
        "do-not-store-this-collector-forwarded-secret"
      ),
      false
    );
    assert.equal(
      JSON.stringify(status).includes(
        "do-not-store-this-collector-forwarded-secret"
      ),
      false
    );
  } finally {
    await closeServer(server);
    resetOtelTelemetry();
  }
});

test("dedupes repeated Collector-forwarded OTLP JSON batches so receiver counts climb but semantic aggregates stay stable", async () => {
  // Phase 3 no-double-counting HTTP contract: a misbehaving Collector that
  // redelivers the exact same OTLP JSON batch (the body the otlphttp/autodev
  // exporter emits, encoded as json) must increment the receiver's transport
  // counters, yet its cumulative-metric timestamps and tool-result call ids
  // collapse at the receiver so the semantic surface stays identical to a
  // single forward. The fixture is reused from tests/fixtures/otel/ so the
  // shape stays in lockstep with the single-POST contract test above.
  resetOtelTelemetry();
  const base = BigInt(Date.now()) * 1_000_000n;
  const fixtureTokens = {
    __OTEL_T0__: base,
    __OTEL_T500MS__: base + 500_000_000n,
    __OTEL_T900MS__: base + 900_000_000n,
    __OTEL_T1200MS__: base + 1_200_000_000n,
    __OTEL_T2S__: base + 2_000_000_000n,
    __OTEL_T6MS__: base + 6_000_000n,
    __OTEL_T13MS__: base + 13_000_000n,
    __OTEL_T20MS__: base + 20_000_000n
  };
  let fixtureText = await readFile(
    new URL("../fixtures/otel/collector-forwarded-otlp.json", import.meta.url),
    "utf8"
  );
  for (const [token, value] of Object.entries(fixtureTokens))
    fixtureText = fixtureText.replaceAll(token, String(value));
  const fixture = JSON.parse(fixtureText);
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const post = (path: string, body: any) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    // First forward.
    const logsResponse = await post("/v1/logs", fixture.logs);
    assert.equal(logsResponse.status, 200);
    assert.deepEqual(await logsResponse.json(), {});
    const tracesResponse = await post("/v1/traces", fixture.traces);
    assert.equal(tracesResponse.status, 200);
    assert.deepEqual(await tracesResponse.json(), {});
    const metricsResponse = await post("/v1/metrics", fixture.metrics);
    assert.equal(metricsResponse.status, 200);
    assert.deepEqual(await metricsResponse.json(), {});

    // Redelivered identical body, simulating a Collector retry/export
    // resend of the very same batch.
    const secondLogs = await post("/v1/logs", fixture.logs);
    assert.equal(secondLogs.status, 200);
    assert.deepEqual(await secondLogs.json(), {});
    const secondTraces = await post("/v1/traces", fixture.traces);
    assert.equal(secondTraces.status, 200);
    assert.deepEqual(await secondTraces.json(), {});
    const secondMetrics = await post("/v1/metrics", fixture.metrics);
    assert.equal(secondMetrics.status, 200);
    assert.deepEqual(await secondMetrics.json(), {});

    // The receiver counted each HTTP POST exactly once per signal, so the
    // redelivery is observable at the transport boundary; the malformed
    // counter stays at zero.
    const telemetry = codexTelemetryStatus(Date.now());
    assert.deepEqual(
      {
        logs: telemetry.receiver.logs,
        traces: telemetry.receiver.traces,
        metrics: telemetry.receiver.metrics,
        invalid: telemetry.receiver.invalid
      },
      { logs: 2, traces: 2, metrics: 2, invalid: 0 }
    );

    // Cumulative metric dedupe: the redelivered fixture reuses the same
    // OTLP timestamps, so otelSeriesDelta yields zero deltas for every
    // codex.tool.call / codex.skill.injected / codex.hooks.run point and
    // the per-tool, per-skill, and per-hook counts stay at the single-
    // forward baseline.
    assert.equal(telemetry.skills.injected.total, 2);
    assert.equal(
      telemetry.tools.byTool.find((row: any) => row.tool === "exec_command")
        ?.count,
      6
    );
    assert.equal(
      telemetry.tools.byTool.find((row: any) => row.tool === "read_file")
        ?.count,
      3
    );
    assert.equal(
      telemetry.hooks.byHook.find((row: any) => row.hook === "SessionStart")
        ?.count,
      1
    );

    // Tool-result dedupe: the fixture's codex.tool_result log carries a
    // call_id that the receiver's seenKeys collapses, so re-arrival does
    // not move the executed counter.
    assert.equal(telemetry.toolResults.total, 1);

    // Log-record and span identity dedupe: a redelivered log batch does not
    // re-count turns or tokens, and redelivered spans do not re-count MCP
    // attempts, failures, durations, or MCP dimension rows. Data-point
    // attribution diagnostics are recorded once per exported point.
    assert.deepEqual(
      {
        prompts: telemetry.turns.prompts,
        completed: telemetry.turns.completed,
        promptLength: telemetry.turns.promptLength,
        ttftCount: telemetry.turns.ttftCount
      },
      { prompts: 1, completed: 1, promptLength: 57, ttftCount: 1 }
    );
    assert.deepEqual(telemetry.tokens, {
      input: 200,
      output: 40,
      cached: 10,
      reasoning: 15,
      tool: 5,
      total: 270
    });
    assert.deepEqual(
      telemetry.mcpServers.map(
        ({
          name,
          initAttempts,
          toolDiscoveryAttempts,
          failures,
          durationCount
        }: any) => ({
          name,
          initAttempts,
          toolDiscoveryAttempts,
          failures,
          durationCount
        })
      ),
      [
        {
          name: "codex_apps",
          initAttempts: 0,
          toolDiscoveryAttempts: 0,
          failures: 1,
          durationCount: 1
        },
        {
          name: "playwright",
          initAttempts: 1,
          toolDiscoveryAttempts: 1,
          failures: 0,
          durationCount: 2
        }
      ]
    );
    assert.equal(
      telemetry.dimensions.mcp.byModel[CONFIGURED_ORCHESTRATOR_MODEL].count,
      13
    );
    assert.deepEqual(
      {
        total: getRouterStatus().attributionDiagnostics.total,
        unattributed: getRouterStatus().attributionDiagnostics.unattributed
      },
      { total: 4, unattributed: 4 }
    );

    // Stable semantic row counts: every per-key aggregation surface has
    // exactly the same set of keys it would after a single forward, so
    // dashboards and alerts keyed on these arrays do not multiply.
    assert.equal(telemetry.skills.injected.bySkill.length, 1);
    assert.equal(telemetry.tools.byTool.length, 2);
    assert.equal(telemetry.hooks.byHook.length, 1);
    assert.equal(telemetry.mcpServers.length, 2);

    // Same session observed end to end: both forwards converge on the
    // single conversation id the fixture carries.
    assert.equal(telemetry.sessionsObserved, 1);

    // MCP server health is derived from lastStatus within the freshness
    // window, so the redelivered traces do not flip either server's
    // health classification.
    const playwright = telemetry.mcpServers.find(
      (entry: any) => entry.name === "playwright"
    );
    const codexApps = telemetry.mcpServers.find(
      (entry: any) => entry.name === "codex_apps"
    );
    assert.equal(playwright.health, "ready");
    assert.equal(codexApps.health, "error");

    // No prompt content anywhere in either exposed telemetry surface, and
    // no request was ever counted as malformed.
    const status = getRouterStatus();
    assert.equal(
      JSON.stringify(telemetry).includes(
        "do-not-store-this-collector-forwarded-secret"
      ),
      false
    );
    assert.equal(
      JSON.stringify(status).includes(
        "do-not-store-this-collector-forwarded-secret"
      ),
      false
    );
  } finally {
    await closeServer(server);
    resetOtelTelemetry();
  }
});

test("Collector-forwarded OTLP semantics do not depend on logs/traces/metrics arrival order", async () => {
  // Codex exports logs, traces, and metrics as independent OTLP requests, and
  // the Collector forwards each signal on its own pipeline, so no cross-signal
  // order can be relied on. Every order, and a full redelivery, must yield the
  // same semantic projection as logs -> traces -> metrics. Ingestion-time
  // stamps (lastSeenAt/lastReceivedAt) are wall-clock and excluded; the
  // receiver and metric inventory are transport counters and excluded.
  const base = BigInt(Date.now()) * 1_000_000n;
  const fixtureTokens = {
    __OTEL_T0__: base,
    __OTEL_T500MS__: base + 500_000_000n,
    __OTEL_T900MS__: base + 900_000_000n,
    __OTEL_T1200MS__: base + 1_200_000_000n,
    __OTEL_T2S__: base + 2_000_000_000n,
    __OTEL_T6MS__: base + 6_000_000n,
    __OTEL_T13MS__: base + 13_000_000n,
    __OTEL_T20MS__: base + 20_000_000n
  };
  let fixtureText = await readFile(
    new URL("../fixtures/otel/collector-forwarded-otlp.json", import.meta.url),
    "utf8"
  );
  for (const [token, value] of Object.entries(fixtureTokens))
    fixtureText = fixtureText.replaceAll(token, String(value));
  const fixture = JSON.parse(fixtureText);
  const now = Number(base / 1_000_000n) + 5000;
  const withoutWallClock = (value: any): any =>
    Array.isArray(value)
      ? value.map(withoutWallClock)
      : value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) => key !== "lastSeenAt" && key !== "lastReceivedAt"
            )
            .map(([key, entry]) => [key, withoutWallClock(entry)])
        )
        : value;
  const semantics = (signals: any[]) => {
    resetOtelTelemetry();
    for (const signal of signals)
      ingestOtelSignal(signal, structuredClone(fixture[signal]));
    const {
      receiver: _receiver,
      metrics: _metrics,
      ...telemetry
    } = codexTelemetryStatus(now);
    const status = getRouterStatus();
    return withoutWallClock({
      telemetry,
      usage: status.usage,
      attributionDiagnostics: status.attributionDiagnostics
    });
  };
  try {
    const canonical = semantics(["logs", "traces", "metrics"]);
    const fixtureModel =
      fixture.logs.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]?.attributes?.find(
        (a: any) => a.key === "model"
      )?.value?.stringValue ?? CONFIGURED_ORCHESTRATOR_MODEL;
    const byModel = canonical.telemetry.dimensions.mcp.byModel;
    assert.deepEqual(Object.keys(byModel), [fixtureModel]);
    assert.equal(byModel[fixtureModel].count, 13);
    const buckets = Object.fromEntries(
      canonical.telemetry.mcpServers.map((server: any) => [
        server.name,
        server.byModel[fixtureModel].lastStatus
      ])
    );
    assert.deepEqual(buckets, { codex_apps: "error", playwright: "ready" });
    for (const signals of [
      ["logs", "metrics", "traces"],
      ["traces", "logs", "metrics"],
      ["traces", "metrics", "logs"],
      ["metrics", "logs", "traces"],
      ["metrics", "traces", "logs"],
      ["logs", "traces", "metrics", "logs", "traces", "metrics"],
      ["traces", "metrics", "traces", "logs", "metrics", "logs"]
    ]) {
      assert.deepEqual(semantics(signals), canonical, signals.join(" -> "));
    }

    // Spans ingested before the log naming their conversation's model are
    // projected as unattributed, never dropped, and move once the log lands.
    resetOtelTelemetry();
    ingestOtelSignal("traces", structuredClone(fixture.traces));
    const early = codexTelemetryStatus(now);
    assert.deepEqual(Object.keys(early.dimensions.mcp.byModel), [
      "unattributed"
    ]);
    assert.equal(early.dimensions.mcp.byModel.unattributed.count, 3);
    ingestOtelSignal("logs", structuredClone(fixture.logs));
    const late = codexTelemetryStatus(now);
    assert.deepEqual(Object.keys(late.dimensions.mcp.byModel), [
      fixtureModel
    ]);
    assert.equal(late.dimensions.mcp.byModel[fixtureModel].count, 13);
  } finally {
    resetOtelTelemetry();
  }
});

test("rejects malformed OTLP HTTP bodies at /v1/logs, /v1/traces, and /v1/metrics without leaking receiver state", async () => {
  // The Collector's otlphttp exporter always sends valid JSON, but the
  // receiver's HTTP contract must still reject a body that fails to parse
  // (e.g. a truncated export from a misbehaving forwarder) with a 400 and
  // count it as invalid rather than as a successful signal.
  resetOtelTelemetry();
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    for (const path of ["/v1/logs", "/v1/traces", "/v1/metrics"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-valid-json"
      });
      assert.equal(response.status, 400);
    }
    const telemetry = codexTelemetryStatus(Date.now());
    assert.deepEqual(
      {
        logs: telemetry.receiver.logs,
        traces: telemetry.receiver.traces,
        metrics: telemetry.receiver.metrics,
        invalid: telemetry.receiver.invalid
      },
      { logs: 0, traces: 0, metrics: 0, invalid: 3 }
    );
  } finally {
    await closeServer(server);
    resetOtelTelemetry();
  }
});

test("counts explicit skill activations separately from injected contexts and bridge exposure", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  registerWorkspaceId("ws-skill-use", "SkillRepo");
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any, time?: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: "1",
    timeUnixNano: String(time),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["workspace_id", "ws-skill-use"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["skill", "ccc"],
                        ["status", "injected"],
                        ["invoke_type", "explicit"]
                      ],
                      1,
                      2
                    ),
                    point(
                      [
                        ["skill", "ccc"],
                        ["status", "injected"],
                        ["invoke_type", "implicit"]
                      ],
                      2,
                      3
                    ),
                    point(
                      [
                        ["skill", "ccc"],
                        ["status", "skipped"],
                        ["invoke_type", "explicit"]
                      ],
                      1,
                      4
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  noteBridgeRequest("req-skill-use", {
    activitySubject: `req:${"req-skill-use"}`,
    provider: "claude",
    model: "sonnet",
    role: "worker",
    workspace: "SkillRepo"
  });
  const bridge = ingestAgentEvents({
    requestId: "req-skill-use",
    events: [
      { type: "skill_exposed", skill: "ccc" },
      { type: "skill_used", skill: "ccc", eventId: "skill-call-1" },
      { type: "skill_used", skill: "ccc", eventId: "skill-call-1" }
    ]
  });
  assert.equal(bridge.accepted, 1);
  const status = getRouterStatus();
  const ws = status.usage.byWorkspace.SkillRepo;
  assert.equal(ws.skillUses, 2);
  assert.equal(status.codexTelemetry.skills.used.total, 2);
  assert.equal(status.codexTelemetry.skills.injected.total, 4);
  assert.equal(status.codexTelemetry.bridgeEvents.skillExposed.total, 1);
  assert.equal(status.codexTelemetry.bridgeEvents.skillUsed.total, 1);
  resetRouterTelemetry();
  resetOtelTelemetry();
});

test("attributes session-keyed skill reads to the parent workspace", () => {
  resetRouterTelemetry();
  noteBridgeSession("session-skill-read", {
    activitySubject: "session-skill-read",
    requestId: "parent-request",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    role: null,
    workspace: "AutoDev"
  });
  const result = ingestAgentEvents({
    requestId: "session-skill-read",
    events: [
      {
        type: "skill_used",
        skill: "ccc",
        source: "skill_read",
        eventId: "read-1"
      }
    ]
  });
  assert.equal(result.accepted, 1);
  assert.equal(getRouterStatus().usage.byWorkspace.AutoDev.skillUses, 1);
  assert.equal(
    getRouterStatus().usage.byWorkspace.AutoDev.bySkill.find(
      (row: any) => row.skill === "ccc"
    )?.uses,
    1
  );
  resetRouterTelemetry();
});

test("normalizes canonical context across tool, hook, and skill telemetry", () => {
  resetOtelTelemetry();
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value:
        typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: String(value) }
    }));
  const point = (entries: any, value: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: "1000000000",
    timeUnixNano: "2000000000",
    asInt: String(value)
  });
  const common = [
    ["role", "worker"],
    ["model", "gpt-worker"],
    ["agent_id", "agent-1"],
    ["agent_kind", "subagent"],
    ["session_source", "subagent_thread_spawn_worker"],
    ["workspace_id", "ws-ctx"]
  ];
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec"],
                        ["source", "builtin"],
                        ...common,
                        ["success", true]
                      ],
                      1
                    )
                  ]
                }
              },
              {
                name: "codex.hooks.run",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["hook_name", "SessionStart"],
                        ["source", "user"],
                        ["handler_type", "command"],
                        ...common,
                        ["status", "ok"]
                      ],
                      1
                    )
                  ]
                }
              },
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["skill", "orchestration"],
                        ["status", "injected"],
                        ...common
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
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
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const skillSum = (
    skill: any,
    status: any,
    value: any,
    timeOffsetNs: any,
    extraAttributes: any[] = []
  ) => ({
    name: "codex.skill.injected",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [
        {
          attributes: attributes([
            ["skill", skill],
            ["status", status],
            ...extraAttributes
          ]),
          startTimeUnixNano: String(start),
          timeUnixNano: String(start + timeOffsetNs),
          asInt: String(value)
        }
      ]
    }
  });
  const threadHistogram = (
    name: any,
    count: any,
    sum: any,
    timeOffsetNs: any,
    extraAttributes: any[] = []
  ) => ({
    name,
    histogram: {
      aggregationTemporality: 2,
      dataPoints: [
        {
          attributes: attributes(extraAttributes),
          startTimeUnixNano: String(start),
          timeUnixNano: String(start + timeOffsetNs),
          count: String(count),
          sum
        }
      ]
    }
  });
  const resourceMetrics = (metrics: any) => ({
    resourceMetrics: [
      { resource: { attributes: [] }, scopeMetrics: [{ metrics }] }
    ]
  });

  // First export: injected=3, skipped(invoke_type=auto)=1, one thread reporting 3 enabled/2 kept, 1 truncated with 120 chars trimmed.
  ingestOtelSignal(
    "metrics",
    resourceMetrics([
      skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
      skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [
        ["invoke_type", "auto"]
      ]),
      threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
      threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
      threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
      threadHistogram(
        "codex.thread.skills.description_truncated_chars",
        1,
        120,
        1_000_000n
      )
    ])
  );
  // Exporter retry resending the identical cumulative point must not double count.
  ingestOtelSignal(
    "metrics",
    resourceMetrics([
      skillSum("lsp-mcp-server", "injected", 3, 1_000_000n),
      skillSum("lsp-mcp-server", "skipped", 1, 1_000_000n, [
        ["invoke_type", "auto"]
      ]),
      threadHistogram("codex.thread.skills.enabled_total", 1, 3, 1_000_000n),
      threadHistogram("codex.thread.skills.kept_total", 1, 2, 1_000_000n),
      threadHistogram("codex.thread.skills.truncated", 1, 1, 1_000_000n),
      threadHistogram(
        "codex.thread.skills.description_truncated_chars",
        1,
        120,
        1_000_000n
      )
    ])
  );
  // Later export with cumulative growth: only the deltas should be applied.
  ingestOtelSignal(
    "metrics",
    resourceMetrics([
      skillSum("lsp-mcp-server", "injected", 5, 2_000_000n),
      skillSum("lsp-mcp-server", "skipped", 2, 2_000_000n, [
        ["invoke_type", "auto"]
      ]),
      threadHistogram("codex.thread.skills.enabled_total", 2, 7, 2_000_000n),
      threadHistogram("codex.thread.skills.kept_total", 2, 4, 2_000_000n),
      threadHistogram("codex.thread.skills.truncated", 2, 2, 2_000_000n),
      threadHistogram(
        "codex.thread.skills.description_truncated_chars",
        2,
        190,
        2_000_000n
      )
    ])
  );

  const telemetry = codexTelemetryStatus(Date.now());
  assert.equal(telemetry.receiver.metrics, 3);
  assert.equal(telemetry.skills.injected.total, 7);
  assert.deepEqual(telemetry.skills.injected.byStatus, {
    injected: 5,
    skipped: 2
  });
  assert.deepEqual(telemetry.skills.injected.byInvokeType, { auto: 2 });
  const skill = telemetry.skills.injected.bySkill.find(
    (entry: any) => entry.skill === "lsp-mcp-server"
  );
  assert.equal(skill.total, 7);
  assert.deepEqual(skill.byStatus, { injected: 5, skipped: 2 });
  assert.deepEqual(skill.byInvokeType, { auto: 2 });
  assert.deepEqual(telemetry.skills.threads.enabledTotal, {
    count: 2,
    sum: 7,
    average: 3.5
  });
  assert.deepEqual(telemetry.skills.threads.keptTotal, {
    count: 2,
    sum: 4,
    average: 2
  });
  assert.equal(telemetry.skills.threads.truncated.count, 2);
  assert.equal(telemetry.skills.threads.truncated.sum, 2);
  assert.deepEqual(telemetry.skills.threads.descriptionTruncatedChars, {
    count: 2,
    sum: 190,
    average: 95
  });
  assert.equal(JSON.stringify(telemetry).includes("do-not-store-this"), false);
  resetOtelTelemetry();
});

test("reads skill names from skillName / skill / skill_name depending on metric source", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const injected = (skillAttribute: any, value: any) => ({
    name: "codex.skill.injected",
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: [
        {
          attributes: attrs([
            [skillAttribute, "skill-A"],
            ["status", "injected"]
          ]),
          startTimeUnixNano: String(start),
          timeUnixNano: String(start + 1n),
          asInt: String(value)
        }
      ]
    }
  });
  const ingest = (metrics: any) =>
    ingestOtelSignal("metrics", {
      resourceMetrics: [{ scopeMetrics: [{ metrics }] }]
    });

  // Modern and legacy exporters use skillName, skill, and skill_name.
  ingest([
    injected("skillName", 2),
    injected("skill", 1),
    injected("skill_name", 1)
  ]);
  const telemetry = codexTelemetryStatus();
  assert.deepEqual(
    telemetry.skills.injected.bySkill.map((row: any) => row.skill),
    ["skill-A"]
  );
  assert.equal(telemetry.skills.injected.bySkill[0].total, 4);
  assert.equal(telemetry.skills.usage, undefined);
  resetOtelTelemetry();
});

test("labels all skills without a recognised name 'unknown'", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (attributes: any, value: any) => ({
    attributes: attrs(attributes),
    startTimeUnixNano: String(start),
    timeUnixNano: String(start + 1n),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.skill.injected",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    point([["status", "injected"]], 3),
                    point(
                      [
                        ["skillName", ""],
                        ["status", "injected"]
                      ],
                      1
                    ),
                    point(
                      [
                        ["skillName", "   "],
                        ["status", "injected"]
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  // codex.skill.injected has no recognised fallback contract; the bucket must
  // be "unknown" so callers can tell apart a missing attribute from the
  // explicit literal skill name "unknown".
  assert.equal(
    telemetry.skills.injected.bySkill.find(
      (row: any) => row.skill === "unknown"
    )?.total,
    5
  );
  assert.equal(telemetry.skills.usage, undefined);
  resetOtelTelemetry();
});

test("groups skill injections by agent kind, model, and plugin metadata", () => {
  resetOtelTelemetry();
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const skillPoint = (skill: any, invokeType: any, value: any) => ({
    attributes: attributes([
      ["skill", skill],
      ["status", "ok"],
      ["invoke_type", invokeType]
    ]),
    startTimeUnixNano: "1",
    timeUnixNano: "2",
    asInt: String(value)
  });
  const resourceMetric = (resourceEntries: any, point: any) => ({
    resource: { attributes: attributes(resourceEntries) },
    scopeMetrics: [
      {
        metrics: [
          {
            name: "codex.skill.injected",
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [point]
            }
          }
        ]
      }
    ]
  });

  ingestOtelSignal("metrics", {
    resourceMetrics: [
      resourceMetric(
        [
          ["session_source", "cli"],
          ["model_slug", "gpt-root"],
          ["plugin_id", "plugin-root"]
        ],
        skillPoint("orchestration", "explicit", 2)
      ),
      resourceMetric(
        [
          ["session_source", "subagent_thread_spawn_parent_d1"],
          ["model_slug", "gpt-child"],
          ["plugin_id", "plugin-child"]
        ],
        skillPoint("orchestration", "implicit", 3)
      )
    ]
  });

  const skill = codexTelemetryStatus().skills.injected;
  assert.deepEqual(skill.byInvokeType, { explicit: 2, implicit: 3 });
  assert.deepEqual(skill.byAgentKind, { root: 2, subagent: 3 });
  assert.deepEqual(skill.byModel, { "gpt-root": 2, "gpt-child": 3 });
  assert.deepEqual(skill.byPlugin, { "plugin-root": 2, "plugin-child": 3 });
  const orchestration = skill.bySkill[0];
  assert.deepEqual(orchestration.byAgentKind, { root: 2, subagent: 3 });
  assert.deepEqual(orchestration.byModel, { "gpt-root": 2, "gpt-child": 3 });
  assert.deepEqual(orchestration.byPlugin, {
    "plugin-root": 2,
    "plugin-child": 3
  });
  resetOtelTelemetry();
});

test("ignores shadow-selection diagnostics instead of treating them as skill usage", () => {
  resetOtelTelemetry();
  const histogram = (name: any, count: any, sum: any, time: any) => ({
    name,
    histogram: {
      aggregationTemporality: 2,
      dataPoints: [
        {
          attributes: [],
          startTimeUnixNano: "1",
          timeUnixNano: String(time),
          count: String(count),
          sum
        }
      ]
    }
  });
  const ingest = (metrics: any) =>
    ingestOtelSignal("metrics", {
      resourceMetrics: [{ scopeMetrics: [{ metrics }] }]
    });
  const removed = [
    "codex.skills.shadow_selection",
    "codex.skills.shadow_selection.invocation",
    "codex.skills.shadow_selection.catalog_entries",
    "codex.skills.shadow_selection.selected_entries",
    "codex.skills.shadow_selection.query_terms",
    "codex.skills.shadow_selection.reduction_bps",
    "codex.skills.shadow_selection.duration_ms"
  ];
  ingest(
    removed.map((name) =>
      name.endsWith("invocation")
        ? {
          name,
          sum: {
            aggregationTemporality: 2,
            dataPoints: [
              {
                attributes: [],
                startTimeUnixNano: "1",
                timeUnixNano: "10",
                asInt: "3"
              }
            ]
          }
        }
        : histogram(name, 1, 8, 10)
    )
  );
  ingest([histogram("codex.skill.turn.duration_seconds", 2, 200, 10)]);

  const skills = codexTelemetryStatus();
  assert.equal(skills.skills.usage, undefined);
  assert.deepEqual(skills.skills.turnDuration.durationSeconds, {
    count: 2,
    sum: 200,
    average: 100
  });
  assert.equal(
    skills.metrics.observed.some(({ name }: any) => removed.includes(name)),
    false
  );
  resetOtelTelemetry();
});

test("counts delta-temporality skill metrics once per export", () => {
  resetOtelTelemetry();
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const metric = (name: any, value: any, timeUnixNano: any, kind = "sum") => ({
    name,
    [kind]: {
      aggregationTemporality: 1,
      ...(kind === "sum" ? { isMonotonic: true } : {}),
      dataPoints: [
        {
          attributes: attributes([
            ["skill", "orchestration"],
            ["status", "ok"]
          ]),
          timeUnixNano: String(timeUnixNano),
          ...(kind === "sum"
            ? { asInt: String(value) }
            : { count: "1", sum: value })
        }
      ]
    }
  });
  const ingest = (metrics: any) =>
    ingestOtelSignal("metrics", {
      resourceMetrics: [{ scopeMetrics: [{ metrics }] }]
    });
  ingest([
    metric("codex.skill.injected", 2, 10),
    metric("codex.thread.skills.enabled_total", 1, 10, "histogram")
  ]);
  ingest([
    metric("codex.skill.injected", 3, 20),
    metric("codex.thread.skills.enabled_total", 1, 20, "histogram")
  ]);
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.skills.injected.total, 5);
  assert.equal(telemetry.skills.threads.enabledTotal.count, 2);
  assert.equal(telemetry.skills.threads.enabledTotal.sum, 2);
  resetOtelTelemetry();
});

test("reads tool names from tool / toolName / tool_name and shows real names in the dashboard buckets", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(start + 1n),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "exec_command"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      4
                    ),
                    point(
                      [
                        ["toolName", "apply_patch"],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      2
                    ),
                    point(
                      [
                        ["toolName", ""],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      1
                    ),
                    point(
                      [
                        ["toolName", "   "],
                        ["source", "builtin"],
                        ["status", "ok"]
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  // Both modern and legacy spellings resolve to their real tool name; the dashboard
  // would otherwise show every row collapsed under the fallback bucket.
  const execRow = telemetry.tools.byTool.find(
    (row: any) => row.tool === "exec_command"
  );
  assert.equal(execRow?.count, 4);
  const applyPatchRow = telemetry.tools.byTool.find(
    (row: any) => row.tool === "apply_patch"
  );
  assert.equal(applyPatchRow?.count, 2);
  // Empty or whitespace-only names fall back to "unknown-tool" so genuinely
  // missing attributes are still visible in the dashboard rather than silently
  // dropped. With cumulative-temporality dedupe, the two empty rows collapse
  // into one because they share the same series key.
  const unknownRow = telemetry.tools.byTool.find(
    (row: any) => row.tool === "unknown-tool"
  );
  assert.equal(unknownRow?.count, 1);
  resetOtelTelemetry();
});

test("inventories native metrics and aggregates safe SQLite and tool telemetry", () => {
  resetOtelTelemetry();
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const dataPoint = (entries: any, value: any, time: any = "100") => ({
    attributes: attributes(entries),
    startTimeUnixNano: "1",
    timeUnixNano: time,
    asInt: String(value)
  });
  const histogramPoint = (
    entries: any,
    count: any,
    sum: any,
    time: any = "100"
  ) => ({
    attributes: attributes(entries),
    startTimeUnixNano: "1",
    timeUnixNano: time,
    count: String(count),
    sum
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.sqlite.init.count",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    dataPoint(
                      [
                        ["db", "logs"],
                        ["status", "success"]
                      ],
                      2
                    )
                  ]
                }
              },
              {
                name: "codex.sqlite.init.duration_ms",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    histogramPoint(
                      [
                        ["db", "logs"],
                        ["status", "success"]
                      ],
                      2,
                      40
                    )
                  ]
                }
              },
              {
                name: "codex.sqlite.fallback.count",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    dataPoint(
                      [
                        ["db", "memories"],
                        ["status", "locked"]
                      ],
                      1
                    )
                  ]
                }
              },
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    dataPoint(
                      [
                        ["tool_name", "exec"],
                        ["source", "builtin"],
                        ["status", "ok"],
                        ["arguments", "/private/path"]
                      ],
                      3
                    )
                  ]
                }
              },
              {
                name: "codex.tool.call.duration_ms",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    histogramPoint(
                      [
                        ["tool_name", "exec"],
                        ["source", "builtin"]
                      ],
                      3,
                      90
                    )
                  ]
                }
              },
              {
                name: "codex.hooks.run",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    dataPoint(
                      [
                        ["hook_name", "SessionStart"],
                        ["source", "user"],
                        ["handler_type", "command"],
                        ["status", "ok"]
                      ],
                      2
                    )
                  ]
                }
              },
              {
                name: "codex.hooks.run.duration_ms",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    histogramPoint(
                      [
                        ["hook_name", "SessionStart"],
                        ["source", "user"],
                        ["handler_type", "command"]
                      ],
                      2,
                      20
                    )
                  ]
                }
              },
              {
                name: "codex.thread.started",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [dataPoint([["source", "subagent"]], 4)]
                }
              },
              {
                name: "codex.multi_agent.spawn",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    dataPoint(
                      [
                        ["agent_role", "worker"],
                        ["requested_model", "autodev/worker"],
                        ["status", "ok"]
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const telemetry = codexTelemetryStatus();
  assert.deepEqual(telemetry.sqlite.init.byDbStatus, [
    { db: "logs", status: "success", count: 2 }
  ]);
  assert.equal(telemetry.sqlite.init.total, 2);
  assert.deepEqual(telemetry.sqlite.initDurationMs.byDbStatus, [
    { db: "logs", status: "success", count: 2, sum: 40, average: 20 }
  ]);
  assert.equal(telemetry.sqlite.fallbacks.total, 1);
  const tool = telemetry.tools.byTool.find(
    (entry: any) => entry.tool === "exec"
  );
  assert.deepEqual(tool, {
    tool: "exec",
    source: "builtin",
    server: "",
    count: 3,
    byStatus: { ok: 3 },
    durationCount: 3,
    durationMs: 90,
    averageDurationMs: 30
  });
  assert.deepEqual(telemetry.hooks.byHook, [
    {
      hook: "SessionStart",
      source: "user",
      handlerType: "command",
      count: 2,
      byStatus: { ok: 2 },
      durationCount: 2,
      durationMs: 20,
      averageDurationMs: 10
    }
  ]);
  assert.deepEqual(telemetry.threads, {
    started: { total: 4, bySource: { subagent: 4 } },
    spawns: {
      total: 1,
      byStatus: { ok: 1 },
      byRole: { worker: 1 },
      byModel: { "autodev/worker": 1 }
    }
  });
  assert.equal(JSON.stringify(telemetry).includes("/private/path"), false);
  assert.deepEqual(
    telemetry.metrics.observed.map(({ name, exports, dataPoints }: any) => ({
      name,
      exports,
      dataPoints
    })),
    [
      { name: "codex.hooks.run", exports: 1, dataPoints: 1 },
      { name: "codex.hooks.run.duration_ms", exports: 1, dataPoints: 1 },
      { name: "codex.multi_agent.spawn", exports: 1, dataPoints: 1 },
      { name: "codex.sqlite.fallback.count", exports: 1, dataPoints: 1 },
      { name: "codex.sqlite.init.count", exports: 1, dataPoints: 1 },
      { name: "codex.sqlite.init.duration_ms", exports: 1, dataPoints: 1 },
      { name: "codex.thread.started", exports: 1, dataPoints: 1 },
      { name: "codex.tool.call", exports: 1, dataPoints: 1 },
      { name: "codex.tool.call.duration_ms", exports: 1, dataPoints: 1 }
    ]
  );
  resetOtelTelemetry();
});

test("accepts histogram-shaped lifecycle metrics when Codex reports them as distributions", () => {
  resetOtelTelemetry();
  const attributes = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, count: any) => ({
    attributes: attributes(entries),
    startTimeUnixNano: "1",
    timeUnixNano: "2",
    count: String(count),
    sum: 0
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.hooks.run",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["hook_name", "SessionEnd"],
                        ["source", "user"],
                        ["handler_type", "command"],
                        ["status", "ok"]
                      ],
                      2
                    )
                  ]
                }
              },
              {
                name: "codex.thread.started",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [point([["source", "subagent"]], 3)]
                }
              },
              {
                name: "codex.multi_agent.spawn",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["agent_role", "worker"],
                        ["requested_model", "autodev/worker"],
                        ["status", "ok"]
                      ],
                      1
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.hooks.byHook[0].count, 2);
  assert.deepEqual(telemetry.threads.started, {
    total: 3,
    bySource: { subagent: 3 }
  });
  assert.deepEqual(telemetry.threads.spawns, {
    total: 1,
    byStatus: { ok: 1 },
    byRole: { worker: 1 },
    byModel: { "autodev/worker": 1 }
  });
  resetOtelTelemetry();
});

test("uses canonical source attribute for hook identity so project and user hooks stay separate", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(start + 1n),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.hooks.run",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["hook_name", "SessionStart"],
                        ["source", "project"],
                        ["handler_type", "command"]
                      ],
                      2
                    ),
                    point(
                      [
                        ["hook_name", "SessionStart"],
                        ["source", "user"],
                        ["handler_type", "command"]
                      ],
                      5
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  const projectHook = telemetry.hooks.byHook.find(
    (entry: any) => entry.source === "project"
  );
  assert.equal(projectHook.count, 2);
  const userHook = telemetry.hooks.byHook.find(
    (entry: any) => entry.source === "user"
  );
  assert.equal(userHook.count, 5);
  assert.equal(telemetry.hooks.byHook.length, 2);
  resetOtelTelemetry();
});

test("normalizes Codex tool success boolean into ok and error status buckets", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const point = (entries: any, value: any, offset?: any) => ({
    attributes: entries,
    startTimeUnixNano: String(start + offset),
    timeUnixNano: String(start + offset + 1n),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        { key: "tool", value: { stringValue: "exec_command" } },
                        { key: "source", value: { stringValue: "builtin" } },
                        { key: "success", value: { boolValue: true } }
                      ],
                      3,
                      0n
                    ),
                    point(
                      [
                        { key: "tool", value: { stringValue: "exec_command" } },
                        { key: "source", value: { stringValue: "builtin" } },
                        { key: "success", value: { boolValue: false } }
                      ],
                      1,
                      2n
                    ),
                    point(
                      [
                        { key: "tool", value: { stringValue: "exec_command" } },
                        { key: "source", value: { stringValue: "builtin" } },
                        { key: "success", value: { stringValue: "true" } }
                      ],
                      2,
                      4n
                    ),
                    point(
                      [
                        { key: "tool", value: { stringValue: "exec_command" } },
                        { key: "source", value: { stringValue: "builtin" } }
                      ],
                      2,
                      6n
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  const exec = telemetry.tools.byTool.find(
    (entry: any) => entry.tool === "exec_command"
  );
  // boolean or string success=true → ok, success=false → error, missing → unknown.
  // Without normalization, Codex's string-encoded success would be lost.
  assert.deepEqual(exec.byStatus, { ok: 5, error: 1, unknown: 2 });
  resetOtelTelemetry();
});

test("reads tool server metadata from server / mcp_server without inferring it from the tool name", () => {
  resetOtelTelemetry();
  const start = BigInt(Date.now()) * 1_000_000n;
  const attrs = (entries: any[]) =>
    entries.map(([key, value]: [any, any]) => ({
      key,
      value: { stringValue: String(value) }
    }));
  const point = (entries: any, value: any) => ({
    attributes: attrs(entries),
    startTimeUnixNano: String(start),
    timeUnixNano: String(start + 1n),
    asInt: String(value)
  });
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.tool.call",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    point(
                      [
                        ["tool", "playwright_navigate"],
                        ["source", "mcp"],
                        ["mcp_server", "playwright"]
                      ],
                      1
                    ),
                    point(
                      [
                        ["tool", "playwright_navigate"],
                        ["source", "mcp"],
                        ["server", "playwright-alt"]
                      ],
                      2
                    ),
                    point(
                      [
                        ["tool", "playwright_navigate"],
                        ["source", "mcp"]
                      ],
                      3
                    ),
                    point(
                      [
                        ["tool", "codex_apps_search"],
                        ["source", "mcp"],
                        ["server", "codex_apps"]
                      ],
                      4
                    )
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
  const telemetry = codexTelemetryStatus();
  const byServer = Object.fromEntries(
    telemetry.tools.byTool
      .filter((entry: any) => entry.tool === "playwright_navigate")
      .map((entry: any) => [entry.server, entry.count])
  );
  assert.deepEqual(byServer, { playwright: 1, "playwright-alt": 2, "": 3 });
  // The router never guesses that "playwright_navigate" belongs to the
  // playwright server just because of the prefix.
  assert.equal(
    telemetry.tools.byTool.find(
      (entry: any) => entry.tool === "codex_apps_search"
    ).server,
    "codex_apps"
  );
  resetOtelTelemetry();
});

test("drops persisted hook and tool aggregates when the OTEL persistence schema bumps", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "autodev-router-hook-schema-")
  );
  const stateFile = join(directory, "router-state.json");
  try {
    resetOtelTelemetry();
    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.tool.call",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "tool",
                            value: { stringValue: "legacy_tool" }
                          },
                          { key: "source", value: { stringValue: "builtin" } },
                          { key: "success", value: { boolValue: true } }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "3"
                      }
                    ]
                  }
                },
                {
                  name: "codex.hooks.run",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "hook_name",
                            value: { stringValue: "LegacyHook" }
                          },
                          { key: "source", value: { stringValue: "project" } },
                          {
                            key: "handler_type",
                            value: { stringValue: "command" }
                          }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "1"
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
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
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.hooks.run",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "hook_name",
                            value: { stringValue: "SessionStart" }
                          },
                          { key: "source", value: { stringValue: "project" } },
                          {
                            key: "handler_type",
                            value: { stringValue: "command" }
                          }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "1"
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    });
    await persistRouterStateNow(stateFile);
    resetOtelTelemetry();
    assert.equal(loadRouterState(stateFile), true);
    const restored = getRouterStatus().codexTelemetry;
    assert.equal(restored.hooks.byHook.length, 1);
    assert.equal(restored.hooks.byHook[0].source, "project");
    assert.equal(restored.hooks.byHook[0].count, 1);
  } finally {
    resetOtelTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracks router-visible subagent spawn failure reasons", () => {
  resetRouterTelemetry();
  recordSpawnFailure({
    requestId: "req-provider-failed",
    role: "worker",
    requestedModel: "autodev/worker",
    reason: "provider_exhausted"
  });
  const failures = spawnFailureStatus();
  assert.equal(failures.scope, "router-admitted-child-requests");
  assert.equal(failures.total, 1);
  assert.equal(failures.byReason.provider_exhausted, 1);
  assert.equal(failures.recent[0]!.requestId, "req-provider-failed");
  resetRouterTelemetry();
});

test("serves the live component dashboard and keeps /status raw JSON", async () => {
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get("content-type")!, /text\/html/);
    const dashboardBody = (await dashboard.text())
      .replaceAll(/\s+/g, " ")
      .replaceAll(/>\s+</g, "><");

    // The dashboard is a live view: it fetches the raw status endpoint on load
    // and polls it without putting a second data contract in the HTML.
    assert.match(
      dashboardBody,
      /fetch\("\/status", \{ cache: "no-store", headers: \{ Accept: "application\/json" \} \}\)/
    );
    assert.match(dashboardBody, /refresh\(\); setInterval\(refresh, 3000\)/);

    // Top-level panels define the reference hierarchy. Nested panels are part
    // of their owning domain rather than independent dashboard sections.
    const panels = Array.from(
      dashboardBody.matchAll(/<dashboard-panel id="([^"]+)"/g),
      (match) => match[1]
    );
    assert.deepEqual(panels, [
      "panel-providers",
      "panel-orchestrator",
      "workspace-usage-section",
      "panel-skills",
      "panel-hooks",
      "panel-ops",
      "panel-codex-state",
      "panel-events"
    ]);
    assert.match(
      dashboardBody,
      /<dashboard-panel id="panel-orchestrator"[\s\S]*?<sub-panel id="panel-spawn-breakdown"/
    );
    assert.match(
      dashboardBody,
      /<sub-panel id="panel-spawn-breakdown"[\s\S]*?<sub-panel id="panel-spawn-failures"/
    );
    assert.match(
      dashboardBody,
      /<dashboard-panel id="panel-skills"[\s\S]*?<sub-panel id="panel-skill-context"/
    );
    assert.match(
      dashboardBody,
      /<dashboard-panel id="panel-ops"[\s\S]*?<sub-panel id="panel-native-metrics"/
    );

    // Rendering is componentized, and untrusted live labels have an explicit
    // escaping path. Event text and status metadata use textContent directly.
    for (const component of [
      "status-badge",
      "health-badge",
      "stat-card",
      "mini-stat",
      "outcome-bar",
      "metric-bar",
      "share-bar",
      "row-toggle",
      "dashboard-panel",
      "sub-panel"
    ]) {
      assert.match(
        dashboardBody,
        new RegExp(String.raw`customElements\.define\("${component}"`)
      );
    }
    assert.match(dashboardBody, /function escapeHtml\(str\)/);
    assert.match(dashboardBody, /escapeHtml\(providerName\)/);
    assert.match(dashboardBody, /escapeHtml\(wsKey\)/);
    assert.match(dashboardBody, /escapeHtml\(m\.name\)/);
    assert.match(dashboardBody, /m\.exports \?\? 0/);
    assert.match(dashboardBody, /m\.dataPoints \?\? 0/);
    assert.match(dashboardBody, /status\.concurrency \?\? \{\}/);
    assert.match(
      dashboardBody,
      /const toolsList = status\.codexTelemetry\?\.tools\?\.byTool \?\? \[\]/
    );
    assert.doesNotMatch(
      dashboardBody,
      /exportCount|dataPointsCount|codexTelemetry\?\.concurrency/
    );
    assert.match(dashboardBody, /liveFeedMeta\.textContent/);
    assert.match(dashboardBody, /metaEl\.textContent/);
    assert.match(dashboardBody, /errorEl\.textContent/);
    assert.doesNotMatch(dashboardBody, /document\.write\s*\(/);

    // MCP observations are embedded in the relevant usage/operational views;
    // there is deliberately no standalone MCP panel.
    assert.match(dashboardBody, /MCP servers/);
    assert.match(dashboardBody, /MCP ready \/ observed/);
    assert.doesNotMatch(
      dashboardBody,
      /<(?:dashboard-panel|sub-panel)[^>]*(?:id="[^"]*mcp|title="[^"]*MCP)/i
    );

    // Workspace-level named attribution is not available from the status
    // contract. The renderer must show explicit empty states, not fabricate it.
    assert.match(
      dashboardBody,
      /Named tool telemetry is unavailable per-workspace/
    );
    assert.match(
      dashboardBody,
      /Named skill attribution is unavailable per-workspace/
    );

    const browserStatus = await fetch(
      `http://127.0.0.1:${address.port}/status`,
      { headers: { Accept: "text/html" } }
    );
    assert.equal(browserStatus.status, 200);
    assert.match(
      browserStatus.headers.get("content-type")!,
      /application\/json/
    );
    const browserPayload = await browserStatus.json();
    assert.equal(browserPayload.schema, "autodev-router-status-v2");
    assert.doesNotMatch(JSON.stringify(browserPayload), /<html/i);
    assertNoLeakedPaths(browserPayload);

    // Accept negotiation remains intentionally inert: both callers receive
    // the same JSON shape even though the dashboard asks for HTML first.
    const api = await fetch(`http://127.0.0.1:${address.port}/status`, {
      headers: { Accept: "application/json" }
    });
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type")!, /application\/json/);
    const apiPayload = await api.json();
    assert.equal(apiPayload.schema, browserPayload.schema);
    assert.deepEqual(
      Object.keys(apiPayload).sort(),
      Object.keys(browserPayload).sort()
    );
  } finally {
    await closeServer(server);
  }
});

test("serves status snapshots without exposing request content", async () => {
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
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
    await closeServer(server);
  }
});

test("persists provider telemetry and recent events across router restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-state-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    recordRouterEvent({
      phase: "selected",
      requestId: "req-persist",
      role: "worker",
      requestedModel: "autodev/worker",
      provider: "minimax",
      model: "MiniMax-M3"
    });
    recordRouterEvent({
      phase: "result",
      requestId: "req-persist",
      role: "worker",
      requestedModel: "autodev/worker",
      provider: "minimax",
      model: "MiniMax-M3",
      outcome: "failure",
      status: 429,
      failureClass: "throttled",
      elapsedMs: 11
    });
    resetOtelTelemetry();
    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.skill.injected",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "skill",
                            value: { stringValue: "orchestration" }
                          },
                          { key: "status", value: { stringValue: "ok" } },
                          {
                            key: "invoke_type",
                            value: { stringValue: "implicit" }
                          }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "2"
                      }
                    ]
                  }
                },
                {},
                {
                  name: "codex.hooks.run",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          {
                            key: "hook_name",
                            value: { stringValue: "SessionStart" }
                          },
                          { key: "source", value: { stringValue: "user" } },
                          {
                            key: "handler_type",
                            value: { stringValue: "command" }
                          },
                          { key: "status", value: { stringValue: "ok" } }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "1"
                      }
                    ]
                  }
                },
                {
                  name: "codex.thread.started",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [
                          { key: "source", value: { stringValue: "subagent" } }
                        ],
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "1"
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
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
    assert.equal(restored.usage.byModel["minimax/MiniMax-M3"].failures, 1);
    assert.equal(restored.usage.byOrigin.subagent.failures, 1);
    assert.equal(restored.recentEvents[0].requestId, "req-persist");
    assert.equal(restored.recentEvents[0].toolCalls, 0);
    assert.equal(restored.codexTelemetry.skills.injected.total, 2);
    assert.equal(restored.codexTelemetry.skills.usage, undefined);
    assert.deepEqual(
      restored.codexTelemetry.skills.turnDuration.durationSeconds,
      { count: 0, sum: 0, average: 0 }
    );
    assert.equal(
      restored.codexTelemetry.skills.injected.bySkill[0].skill,
      "orchestration"
    );
    assert.deepEqual(
      restored.codexTelemetry.skills.injected.bySkill[0].byInvokeType,
      { implicit: 2 }
    );
    assert.deepEqual(restored.codexTelemetry.skills.injected.byAgentKind, {
      unattributed: 2
    });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byModel, {
      unattributed: 2
    });
    assert.deepEqual(restored.codexTelemetry.skills.injected.byPlugin, {
      none: 2
    });
    assert.equal(restored.codexTelemetry.receiver.metrics, 1);
    assert.equal(restored.codexTelemetry.hooks.byHook[0].count, 1);
    assert.deepEqual(restored.codexTelemetry.threads.started, {
      total: 1,
      bySource: { subagent: 1 }
    });
    assert.match(serializeRouterState(), /"otelTelemetry"/);
    assert.doesNotMatch(
      serializeRouterState(),
      /prompt_text|api[_-]?key|authorization/i
    );
  } finally {
    resetRouterTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("drops removed shadow-selection telemetry from persisted state", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "autodev-router-skill-migration-")
  );
  const stateFile = join(directory, "router-state.json");
  try {
    resetRouterTelemetry();
    resetOtelTelemetry();
    const state = JSON.parse(serializeRouterState());
    state.otelTelemetry.skills.usage = {
      total: 7,
      bySkill: [{ skill: "orchestration", total: 7 }]
    };
    state.otelTelemetry.skills.selection = {
      catalogEntries: { count: 1, sum: 20 }
    };
    state.otelTelemetry.metrics = {
      observed: [
        { name: "codex.skills.shadow_selection", exports: 1, dataPoints: 1 },
        {
          name: "codex.skills.shadow_selection.invocation",
          exports: 1,
          dataPoints: 1
        }
      ]
    };
    await writeFile(stateFile, JSON.stringify(state), "utf8");
    assert.equal(loadRouterState(stateFile), true);
    const telemetry = getRouterStatus().codexTelemetry;
    assert.equal(telemetry.skills.usage, undefined);
    assert.equal(telemetry.skills.selection, undefined);
    assert.equal(
      telemetry.metrics.observed.some(({ name }: any) =>
        name.startsWith("codex.skills.shadow_selection")
      ),
      false
    );
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
  const toolResponse = {
    output: [
      { id: "call-1", type: "function_call" },
      { id: "message-1", type: "message" }
    ]
  };
  assert.equal(responses.countToolCallsInResponse(toolResponse), 1);
  const stream = [
    'data: {"type":"response.output_item.added","item":{"id":"call-1","type":"function_call"}}',
    `data: ${JSON.stringify({ type: "response.completed", response: toolResponse })}`,
    "data: [DONE]",
    ""
  ].join("\n");
  assert.equal(responses.countToolCallsFromSse(stream), 1);
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
    averageDurationMs: 0
  });
  recordRouterEvent({
    phase: "selected",
    requestId: "req-usage-role",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet"
  });
  assert.equal(getRouterStatus().usage.byOrigin.subagent.active, 0);
  assert.equal(getRouterStatus().usage.byRole.explorer.active, 0);
  recordRouterEvent({
    phase: "result",
    requestId: "req-usage-role",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet",
    outcome: "success",
    status: 200,
    elapsedMs: 120,
    toolCalls: 2
  });
  recordRouterEvent({
    phase: "selected",
    requestId: "req-usage-parent",
    requestedModel: CONFIGURED_ORCHESTRATOR_MODEL,
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-usage-parent",
    requestedModel: CONFIGURED_ORCHESTRATOR_MODEL,
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    outcome: "success",
    status: 200,
    elapsedMs: 80,
    toolCalls: 1
  });

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

test("keeps orchestrator role attribution separate from direct and subagent traffic", () => {
  resetRouterTelemetry();
  // Orchestrator-origin: a direct Codex model request (no role).
  recordRouterEvent({
    phase: "selected",
    requestId: "req-orchestrator",
    requestedModel: CONFIGURED_SMART_MODEL,
    provider: "codex",
    model: CONFIGURED_SMART_MODEL
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-orchestrator",
    requestedModel: CONFIGURED_SMART_MODEL,
    provider: "codex",
    model: CONFIGURED_SMART_MODEL,
    outcome: "success",
    status: 200,
    elapsedMs: 50
  });
  // Direct-origin: a non-Codex concrete model request (no role).
  recordRouterEvent({
    phase: "selected",
    requestId: "req-direct",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-direct",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet",
    outcome: "success",
    status: 200,
    elapsedMs: 30
  });
  // Subagent-origin: two distinct role requests.
  recordRouterEvent({
    phase: "selected",
    requestId: "req-worker",
    role: "worker",
    requestedModel: "autodev/worker",
    provider: "minimax",
    model: "MiniMax-M3"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-worker",
    role: "worker",
    requestedModel: "autodev/worker",
    provider: "minimax",
    model: "MiniMax-M3",
    outcome: "success",
    status: 200,
    elapsedMs: 20,
    toolCalls: 2
  });
  recordRouterEvent({
    phase: "selected",
    requestId: "req-explorer",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-explorer",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet",
    outcome: "failure",
    status: 429,
    failureClass: "throttled",
    elapsedMs: 10
  });

  const usage = getRouterStatus().usage;
  // byOrigin keeps orchestrator and direct distinct (unchanged JSON API contract).
  assert.equal(usage.byOrigin.orchestrator.successes, 1);
  assert.equal(usage.byOrigin.direct.successes, 1);
  assert.equal(usage.byOrigin.subagent.successes, 1);
  assert.equal(usage.byOrigin.subagent.failures, 1);
  // Root Codex traffic has a canonical orchestrator role; direct non-Codex
  // traffic remains unattributed because it has no role contract.
  assert.equal(usage.byRole.orchestrator.attempts, 1);
  assert.equal(usage.byRole.orchestrator.successes, 1);
  assert.equal(
    getRouterStatus().recentEvents.find(
      (event: any) =>
        event.requestId === "req-orchestrator" && event.phase === "selected"
    ).role,
    "orchestrator"
  );
  assert.equal(usage.byRole.unattributed.attempts, 1);
  assert.equal(usage.byRole.unattributed.successes, 1);

  const roleEntries = Object.entries(usage.byRole).filter(
    ([role]) => role !== "unattributed" && role !== "orchestrator"
  );
  const subagentTotal = roleEntries.reduce(
    (total, [, bucket]) => ({
      attempts: total.attempts + (bucket as any).attempts,
      successes: total.successes + (bucket as any).successes,
      failures: total.failures + (bucket as any).failures,
      toolCalls: total.toolCalls + (bucket as any).toolCalls
    }),
    { attempts: 0, successes: 0, failures: 0, toolCalls: 0 }
  );
  // Child role-bucket rows (excluding unattributed) must aggregate to the Subagents parent totals.
  assert.equal(subagentTotal.attempts, usage.byOrigin.subagent.attempts);
  assert.equal(subagentTotal.successes, usage.byOrigin.subagent.successes);
  assert.equal(subagentTotal.failures, usage.byOrigin.subagent.failures);
  assert.equal(subagentTotal.toolCalls, usage.byOrigin.subagent.toolCalls);
  resetRouterTelemetry();
});

test("byModel live activity count is separate from transport in-flight requests", () => {
  resetRouterTelemetry();
  recordRouterEvent({
    phase: "selected",
    requestId: "req-active-1",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet"
  });
  recordRouterEvent({
    phase: "selected",
    requestId: "req-active-2",
    requestedModel: "claude-opus-5-5",
    provider: "claude",
    model: "claude-opus-5-5"
  });
  let usage = getRouterStatus().usage;
  assert.equal(usage.byModel["claude/sonnet"].active, 0);
  assert.equal(usage.byModel["claude/claude-opus-5-5"].active, 0);
  assert.equal(getRouterStatus().inFlightRequests.claude ?? 0, 0);

  recordRouterEvent({
    phase: "result",
    requestId: "req-active-1",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet",
    outcome: "success",
    status: 200,
    elapsedMs: 5
  });
  usage = getRouterStatus().usage;
  assert.equal(usage.byModel["claude/sonnet"].active, 0);
  assert.equal(usage.byModel["claude/claude-opus-5-5"].active, 0);

  recordRouterEvent({
    phase: "result",
    requestId: "req-active-2",
    requestedModel: "claude-opus-5-5",
    provider: "claude",
    model: "claude-opus-5-5",
    outcome: "success",
    status: 200,
    elapsedMs: 5
  });
  assert.equal(
    getRouterStatus().usage.byModel["claude/claude-opus-5-5"].active,
    0
  );
  resetRouterTelemetry();
});

test("keeps a stale byModel lastFailure after a later success, which the dashboard must not treat as an ongoing outage once the provider recovers", () => {
  resetRouterTelemetry();
  cooldowns.clear("claude");
  recordRouterEvent({
    phase: "selected",
    requestId: "req-model-fail",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet"
  });
  cooldowns.cooldownProvider("claude");
  recordRouterEvent({
    phase: "result",
    requestId: "req-model-fail",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet",
    outcome: "failure",
    status: 429,
    failureClass: "throttled",
    elapsedMs: 5
  });
  assert.equal(getRouterStatus().providers.claude.status, "throttled");

  // Provider recovers: cooldown clears and a later request on the same model succeeds.
  cooldowns.clear("claude");
  recordRouterEvent({
    phase: "selected",
    requestId: "req-model-recover",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-model-recover",
    requestedModel: "sonnet",
    provider: "claude",
    model: "sonnet",
    outcome: "success",
    status: 200,
    elapsedMs: 8
  });

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

test("parseConcurrencyConfig accepts multiline [agents] and inline agents={...} but ignores the legacy max_threads alias", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "autodev-concurrency-config-")
  );
  const configFile = join(directory, "config.toml");
  try {
    // Canonical multiline form -- older user configs used this form before the
    // composer switched to its canonical inline output.
    await writeFile(
      configFile,
      "[agents]\nmax_concurrent_threads_per_session = 2\nmax_depth = 1\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 2
    });
    assert.equal(
      Object.hasOwn(parseConcurrencyConfig(configFile), "maxThreads"),
      false,
      "maxThreads must not appear on the parsed shape"
    );

    // Composer-generated inline form, with nested role tables the prior regex
    // could not span because `[^{}]` stopped at the first inner brace.
    const inlineConfig =
      'agents = { enabled = true, max_concurrent_threads_per_session = 3, explorer = { description = "x" } }\n';
    await writeFile(configFile, inlineConfig);
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 3
    });

    // Missing canonical key surfaces `null`; the call sites already know
    // that means "no configured cap".
    await writeFile(configFile, "[agents]\nenabled = true\n");
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });

    // The deprecated `max_threads` alias must be ignored entirely, with no
    // fallback to the previous global semantics. A wrapper that honoured it
    // would just hide the parser bug behind a second source of truth.
    await writeFile(configFile, "[agents]\nmax_threads = 7\n");
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });

    // When both keys are present, only the canonical one feeds admission.
    await writeFile(
      configFile,
      "[agents]\nmax_threads = 5\nmax_concurrent_threads_per_session = 6\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 6
    });

    // The canonical key in a non-agents section must not bleed in.
    await writeFile(
      configFile,
      "[unrelated]\nmax_concurrent_threads_per_session = 9\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });

    // A sibling `[agents.explorer]` table must not be misattributed to the
    // `[agents]` capture -- the previous regex only anchored on the key
    // prefix and could swallow either depending on indent.
    const siblingConfig =
      '[agents]\nmax_concurrent_threads_per_session = 2\n\n[agents.explorer]\ndescription = "Read-only codebase explorer."\nmax_concurrent_threads_per_session = 99\n';
    await writeFile(configFile, siblingConfig);
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 2
    });

    // Non-integer values are not surfaced; admission reads `null` and runs
    // uncapped. A string or bareword value never coerces silently.
    await writeFile(
      configFile,
      '[agents]\nmax_concurrent_threads_per_session = "two"\n'
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });
    await writeFile(
      configFile,
      "[agents]\nmax_concurrent_threads_per_session = not_a_number\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });

    // Missing config file is reported as `null`; never throws.
    await rm(configFile, { force: true });
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: null
    });

    // Explicit zero values are preserved verbatim -- the consumer's
    // `perSessionLimit !== null && sessionActive >= perSessionLimit` check
    // then denies every acquire since `sessionActive >= 0` is always true.
    // That is the literal documented behaviour, not a misread of the cap.
    await writeFile(
      configFile,
      "[agents]\nmax_concurrent_threads_per_session = 0\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 0
    });
    await writeFile(
      configFile,
      "agents = { max_concurrent_threads_per_session = 0 }\n"
    );
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 0
    });

    // The composer-emitted full inline form -- seven nested role tables, all
    // single-line -- is the shape `$CODEX_HOME/config.toml` actually ships
    // today. The previous regex could not span it; this assertion guards
    // against any regression that brings the `[^{}]` character class back.
    const composerInline =
      'agents = { enabled = true, max_concurrent_threads_per_session = 2, max_depth = 1, default_subagent_model = "autodev/default", default_subagent_reasoning_effort = "medium", explorer = { description = "Read-only codebase explorer.", config_file = "./agents/explorer.toml" }, worker = { description = "General-purpose worker/coder.", config_file = "./agents/worker.toml" }, validator = { description = "Validation agent.", config_file = "./agents/validator.toml" }, smart = { description = "Full-capability smart agent.", config_file = "./agents/smart.toml" }, default = { description = "General-purpose developer.", config_file = "./agents/default.toml" }, docs-researcher = { description = "Documentation researcher.", config_file = "./agents/docs-researcher.toml" }, browser-tester = { description = "Read-only browser tester.", config_file = "./agents/browser-tester.toml" } }\n';
    await writeFile(configFile, composerInline);
    assert.deepEqual(parseConcurrencyConfig(configFile), {
      file: configFile,
      maxConcurrentThreadsPerSession: 2
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admission enforces the canonical limit, surfaces the same value on /status, and never reports the legacy alias", () => {
  // These assertions are gated on the module-level CONCURRENCY_CONFIG having
  // a positive integer limit. Test hosts without a configured
  // `$CODEX_HOME/config.toml` see `null` here, which the admission code
  // interprets as "no configured cap" -- that is itself part of the
  // sanitized-status contract the fixture pins separately.
  resetConcurrencyTelemetry();
  const configuredLimit = concurrencyStatus().effectivePerSessionLimit;
  assert.ok(
    configuredLimit === null ||
    (Number.isInteger(configuredLimit) && configuredLimit > 0),
    "configured limit must be null or a positive integer"
  );
  if (configuredLimit !== null) {
    for (let slot = 0; slot < configuredLimit!; slot += 1)
      assert.equal(tryAcquireSubagentSlot("admission-session"), null);
    assert.equal(
      tryAcquireSubagentSlot("admission-session"),
      "max_concurrent_threads_per_session"
    );
    recordConcurrencyDenial({
      requestId: "req-denied",
      role: "worker",
      requestedModel: "autodev/worker",
      sessionScope: "identified",
      reason: "max_concurrent_threads_per_session"
    });
    const status = concurrencyStatus();
    assert.equal(status.scope, "router-admitted-child-requests");
    assert.equal(status.maxConcurrentThreadsPerSession, configuredLimit);
    assert.equal(status.effectivePerSessionLimit, configuredLimit);
    assert.equal(
      Object.hasOwn(status, "maxThreads"),
      false,
      "maxThreads must not appear on /status"
    );
    assert.equal(status.activeSubagentThreads, configuredLimit);
    assert.equal(status.activeSessions, 1);
    assert.equal(status.denials, 1);
    assert.equal(
      status.lastDenial!.reason,
      "max_concurrent_threads_per_session"
    );
    for (let slot = 0; slot < configuredLimit!; slot += 1)
      releaseSubagentSlot("admission-session");
    assert.equal(concurrencyStatus().activeSessions, 0);
  }
  resetConcurrencyTelemetry();
});

test("requestSession derives identity from caller-supplied headers and payload fields, never invents it", () => {
  const noSignal = (requestSession as any)({ headers: {} }, {});
  assert.deepEqual(noSignal, {
    key: PROCESS_FALLBACK_SESSION_KEY,
    scope: "process-fallback",
    thread: null
  });

  assert.deepEqual(
    (requestSession as any)(
      { headers: { "x-codex-session-id": "sess-header-1" } },
      {}
    ),
    { key: "sess-header-1", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "x-session-id": "sess-header-2" } },
      {}
    ),
    { key: "sess-header-2", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "x-conversation-id": "sess-header-3" } },
      {}
    ),
    { key: "sess-header-3", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)({ headers: {} }, { session_id: "sess-body-1" }),
    { key: "sess-body-1", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: {} },
      { conversation_id: "sess-body-2" }
    ),
    { key: "sess-body-2", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: {} },
      { metadata: { session_id: "sess-meta-1" } }
    ),
    { key: "sess-meta-1", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: {} },
      { metadata: { conversation_id: "sess-meta-2" } }
    ),
    { key: "sess-meta-2", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: {} },
      {},
      JSON.stringify({ conversation_id: "sess-turn-metadata" })
    ),
    { key: "sess-turn-metadata", scope: "identified", thread: null }
  );

  // Whitespace-only or non-string identity is treated as absent rather than trusted as-is.
  assert.deepEqual(
    (requestSession as any)({ headers: { "x-codex-session-id": "   " } }, {}),
    {
      key: PROCESS_FALLBACK_SESSION_KEY,
      scope: "process-fallback",
      thread: null
    }
  );
  assert.deepEqual(
    (requestSession as any)({ headers: {} }, { session_id: 12_345 }),
    {
      key: PROCESS_FALLBACK_SESSION_KEY,
      scope: "process-fallback",
      thread: null
    }
  );

  // A header takes priority over payload fields when both are present.
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "x-codex-session-id": "sess-header" } },
      { session_id: "sess-body" }
    ),
    { key: "sess-header", scope: "identified", thread: null }
  );

  // Codex 0.154.0 names the thread as well; a subagent's differs from its session.
  const child = (requestSession as any)(
    { headers: { "session-id": "root-1", "thread-id": "child-1" } },
    { client_metadata: { session_id: "root-1", thread_id: "child-1" } },
    JSON.stringify({
      session_id: "root-1",
      thread_id: "child-1",
      thread_source: "subagent"
    })
  );
  assert.deepEqual(child, {
    key: "root-1",
    scope: "identified",
    thread: "child-1"
  });
  assert.equal(
    (requestSession as any)(
      { headers: {} },
      { client_metadata: { thread_id: "t-meta" } },
      JSON.stringify({ session_id: "s" })
    ).thread,
    "t-meta"
  );
  assert.equal(
    (requestSession as any)(
      { headers: {} },
      {},
      JSON.stringify({ session_id: "s", thread_id: "t-turn" })
    ).thread,
    "t-turn"
  );

  // Codex 0.154.0+ canonical headers alone must identify the session so a
  // metadata-less continuation/compaction request can still resolve the same
  // session whose workspace metadata was previously remembered. Previously
  // only the legacy alias headers were recognized, so a request carrying
  // only the canonical `session-id` header collapsed to the process-wide
  // anonymous bucket and workspace metadata could not be restored.
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "session-id": "root-canon-only" } },
      {}
    ),
    { key: "root-canon-only", scope: "identified", thread: null }
  );
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "session-id": "root-canon-only" } },
      {}
    ).thread,
    null
  );
  // Canonical session header still wins when an alias also arrives.
  assert.deepEqual(
    (requestSession as any)(
      {
        headers: {
          "session-id": "root-canon",
          "x-codex-session-id": "root-alias"
        }
      },
      {}
    ),
    { key: "root-canon", scope: "identified", thread: null }
  );
  // Alias headers remain accepted so already-remembered workspace metadata
  // continues to resolve for older callers.
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "x-codex-session-id": "root-alias-only" } },
      {}
    ),
    { key: "root-alias-only", scope: "identified", thread: null }
  );

  // Codex requests providing thread-id without session-id resolve to the thread identity.
  assert.deepEqual(
    (requestSession as any)(
      { headers: { "thread-id": "root-thread-only" } },
      {}
    ),
    { key: "root-thread-only", scope: "identified", thread: "root-thread-only" }
  );
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
    for (let slot = 1; slot < configuredLimit!; slot += 1)
      assert.equal(tryAcquireSubagentSlot("session-a"), null);
    assert.equal(
      tryAcquireSubagentSlot("session-a"),
      "max_concurrent_threads_per_session"
    );
    for (let slot = 0; slot < configuredLimit!; slot += 1)
      releaseSubagentSlot("session-a");
    releaseSubagentSlot("session-b");

    // Two requests that both fail to supply any session identity share the documented
    // process-wide fallback bucket and are capped together, even though nothing proves
    // they belong to the same logical Codex session -- this is the fail-safe behavior
    // called out in docs/provider-routing.md, not true per-session enforcement.
    const first = (requestSession as any)({ headers: {} }, {});
    const second = (requestSession as any)({ headers: {} }, {});
    assert.equal(first.key, PROCESS_FALLBACK_SESSION_KEY);
    assert.equal(second.key, PROCESS_FALLBACK_SESSION_KEY);
    const fallbackLimit = concurrencyStatus().effectivePerSessionLimit;
    for (let slot = 0; slot < fallbackLimit!; slot += 1)
      assert.equal(tryAcquireSubagentSlot(first.key), null);
    assert.equal(
      concurrencyStatus().processFallbackActiveThreads,
      fallbackLimit
    );
    assert.equal(concurrencyStatus().processFallbackEnforcement, true);
    assert.equal(
      tryAcquireSubagentSlot(second.key),
      "max_concurrent_threads_per_session"
    );
    for (let slot = 0; slot < fallbackLimit!; slot += 1)
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
  cooldowns.clear("claude");
  recordRouterEvent({
    phase: "selected",
    requestId: "req-status",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet"
  });
  incrementActiveRequests("claude");
  const selected = getRouterStatus();
  assert.equal(selected.providers.claude.status, "ready");
  assert.equal(selected.providers.claude.configuredModels.default, "sonnet");
  assert.equal(selected.providers.claude.attempts, 1);
  assert.equal(selected.providers.claude.inFlightRequests, 1);
  assert.equal(selected.providers.claude.active, 0);

  cooldowns.cooldownProvider("claude");
  recordRouterEvent({
    phase: "result",
    requestId: "req-status",
    role: "explorer",
    requestedModel: "autodev/explorer",
    provider: "claude",
    model: "sonnet",
    outcome: "failure",
    status: 429,
    failureClass: "throttled",
    elapsedMs: 12
  });
  const limited = getRouterStatus();
  assert.equal(limited.providers.claude.status, "throttled");
  assert.equal(limited.providers.claude.failures, 1);
  assert.equal(limited.providers.claude.lastFailure.class, "throttled");
  assert.equal(limited.recentEvents[0].phase, "result");
  assert.equal(limited.recentEvents[0].requestId, "req-status");
  decrementActiveRequests("claude");
  cooldowns.clear("claude");
  resetRouterTelemetry();
});

test("extracts text from a Responses SSE completion", () => {
  const body = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"router"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"-ok"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"router-ok"}}',
    "data: [DONE]",
    ""
  ].join("\n");
  const response = responses.responseTextFromSse(body);
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "router-ok");
  assert.equal((response as any).output[0].content[0].text, "router-ok");
});

test("deduplicates catalog models and keeps role aliases visible", () => {
  const ids = routing.catalogModelIds(
    [{ slug: CONFIGURED_ORCHESTRATOR_MODEL }, { slug: CONFIGURED_ORCHESTRATOR_MODEL }],
    ["autodev/explorer"]
  );
  assert.deepEqual(ids, [CONFIGURED_ORCHESTRATOR_MODEL, "autodev/explorer"]);
});

test("rewrites the routed provider model back to the public role alias", () => {
  const value = responses.replaceModelFields(
    {
      model: "gemini-3.8-flash-medium",
      nested: [{ model: "gemini-3.8-flash-medium" }]
    },
    "autodev/explorer"
  );
  assert.deepEqual(value, {
    model: "autodev/explorer",
    nested: [{ model: "autodev/explorer" }]
  });

  const event = responses.transformSseEvent(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "gemini-3.8-flash-medium",
        output: [
          {
            type: "function_call",
            name: "multi_agent_v1__spawn_agent",
            model: "gemini-3.8-flash-medium"
          }
        ],
        script:
          '{"model":"gemini-3.8-flash-medium","name":"multi_agent_v1__spawn_agent"}'
      },
      model: "gemini-3.8-flash-medium"
    })}\n\n`,
    "autodev/explorer"
  );
  const parsedEvent = JSON.parse(event.match(/^data: (.+)$/m)![1]!);
  assert.equal(parsedEvent.model, "autodev/explorer");
  assert.equal(parsedEvent.response.model, "autodev/explorer");
  assert.equal(parsedEvent.response.output[0].model, "autodev/explorer");
  assert.deepEqual(parsedEvent.response.output[0], {
    type: "function_call",
    name: "spawn_agent",
    model: "autodev/explorer",
    namespace: "multi_agent_v1"
  });
  assert.equal(
    parsedEvent.response.script,
    '{"model":"gemini-3.8-flash-medium","name":"multi_agent_v1__spawn_agent"}'
  );
});

test("uses the least-busy provider before starting another provider request", () => {
  activeProviderRequests.clear();
  agentActivity.reset();
  agentActivity.beginRequest("busy-claude", {
    requestId: "busy-claude",
    provider: "claude",
    model: "sonnet"
  });
  agentActivity.beginRequest("busy-minimax", {
    requestId: "busy-minimax",
    provider: "minimax",
    model: "MiniMax-M3"
  });
  const candidates = routing
    .roleCandidates("default", () => 0.5)
    .map((candidate) => candidate.provider);
  assert.equal(candidates[0], "antigravity");
  assert.deepEqual(candidates.slice(3), ["copilot", "codex"]);
  activeProviderRequests.clear();
  agentActivity.reset();
});

test("balances candidate provider priority across active in-flight requests", () => {
  activeProviderRequests.clear();
  assert.equal(getActiveRequests("claude"), 0);

  agentActivity.reset();
  agentActivity.beginRequest("claude-1", {
    requestId: "claude-1",
    provider: "claude",
    model: "sonnet"
  });
  agentActivity.beginRequest("claude-2", {
    requestId: "claude-2",
    provider: "claude",
    model: "sonnet"
  });
  agentActivity.beginRequest("antigravity-1", {
    requestId: "antigravity-1",
    provider: "antigravity",
    model: "gemini-3.8-flash-medium"
  });
  assert.equal(agentActivity.countLive({ provider: "claude" }), 2);
  assert.equal(agentActivity.countLive({ provider: "antigravity" }), 1);
  assert.equal(agentActivity.countLive({ provider: "minimax" }), 0);

  const candidates = routing.roleCandidates("default", () => 0.5);
  const providers = candidates.map((c) => c.provider);
  // minimax (0 active) should come first, then antigravity (1 active), then claude (2 active)
  assert.equal(providers[0], "minimax");
  assert.equal(providers[1], "antigravity");
  assert.equal(providers[2], "claude");

  agentActivity.finish("claude-1", { requestId: "claude-1" });
  agentActivity.finish("claude-2", { requestId: "claude-2" });
  agentActivity.finish("antigravity-1", { requestId: "antigravity-1" });
  assert.equal(agentActivity.countLive({ provider: "claude" }), 0);
  assert.equal(agentActivity.countLive({ provider: "antigravity" }), 0);
  activeProviderRequests.clear();
  agentActivity.reset();
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
  assert.equal(routing.roleForModel(null), null);
  assert.equal(routing.roleForModel(undefined), null);
  assert.equal(routing.roleForModel(""), null);
  assert.equal(routing.roleForModel("autodev/"), null);
  assert.equal(routing.roleForModel("autodev/nonexistent-role"), null);
  assert.equal(routing.roleForModel("not-autodev/default"), null);

  assert.equal(routing.routeForModel(null), null);
  assert.equal(routing.routeForModel(undefined), null);
  assert.equal(routing.routeForModel(""), null);
  assert.equal(routing.routeForModel("custom-unsupported-model-name"), null);
});

test("handles malformed SSE lines and comments gracefully without throwing", () => {
  const malformed =
    "data: not a valid json line\n: keep-alive comment\ndata: [DONE]\n\n";
  const result = responses.transformSseEvent(malformed, "autodev/worker");
  assert.equal(result, malformed);
});

test("extracts text from SSE stream with empty lines and keep-alive comments", () => {
  const rawStream = [
    ": claude-bridge keep-alive",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"part1 "}',
    "",
    ": agy-bridge keep-alive",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"part2"}',
    "data: [DONE]",
    ""
  ].join("\n");
  const response = responses.responseTextFromSse(rawStream);
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "part1 part2");
  assert.equal((response as any).output[0].content[0].text, "part1 part2");
});

test("structured router error body carries code, retryable, failure class, provider, model, request id, and router instance id", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      return Response.json(
        { error: "upstream unavailable" },
        {
          status: 503
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-structured-error"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
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
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("wraps transport failures with actionable safe diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      const error = new Error("fetch failed");
      error.cause = { code: "ECONNRESET", syscall: "read" };
      throw error;
    }
    return originalFetch(url, options);
  };
  cooldowns.clear("claude");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-transport-error"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(
      response.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );
    const body = await response.json();
    assert.equal(body.error.code, "router_provider_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.requestId, "req-transport-error");
    assert.doesNotMatch(
      body.error.message,
      /ECONNRESET|fetch failed|127\.0\.0\.1|absolute|path/i
    );
    const transportEvents = getRouterStatus().recentEvents.filter(
      (event: any) =>
        event.phase === "transport_error" &&
        event.requestId === "req-transport-error"
    );
    assert.equal(
      transportEvents.length,
      3,
      "all bounded transport attempts should be observable"
    );
    assert.equal(transportEvents[0].errorCode, "ECONNRESET");
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request survives two pre-response transport failures in a row before succeeding", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      if (responseCalls <= 2) {
        // Mirrors the pooled keep-alive connection getting recycled out from
        // under a reuse attempt: the write fails before any response exists.
        const error = new TypeError("fetch failed");
        error.cause = {
          code: responseCalls === 1 ? "UND_ERR_SOCKET" : "EPIPE",
          syscall: "write"
        };
        throw error;
      }
      return Response.json(
        { id: "recovered", model: "sonnet", output_text: "ok" },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  cooldowns.clear("claude");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-transport-recovers"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(
      response.status,
      200,
      "a request that only ever fails pre-response should recover within its retry budget"
    );
    assert.equal(responseCalls, 3);
    const transportEvents = getRouterStatus().recentEvents.filter(
      (event: any) =>
        event.phase === "transport_error" &&
        event.requestId === "req-transport-recovers"
    );
    assert.equal(transportEvents.length, 2);
    assert.deepEqual(
      transportEvents.map((event: any) => event.errorCode).sort(),
      ["EPIPE", "UND_ERR_SOCKET"]
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("x-autodev-router-instance-id correlates every JSON response with the router instance id in the body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return Response.json(
        {
          id: "upstream-response",
          model: "sonnet",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const success = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(
      success.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );
    const badRequest = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "  " })
      }
    );
    assert.equal(
      badRequest.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );
    const badBody = await badRequest.json();
    assert.equal(badBody.error.routerInstanceId, ROUTER_INSTANCE_ID);
    assert.equal(badBody.error.type, "invalid_request_error");
    assert.equal(badBody.error.code, "invalid_request_error");
    assert.equal(badBody.error.retryable, null);
    const status = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(
      status.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );
    assert.equal((await status.json()).routerInstanceId, ROUTER_INSTANCE_ID);
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
    assert.equal(
      dashboard.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
  }
});

test("a direct concrete request registers its real session, not sessionKey: null, so a session-scoped bridge report can still correlate to it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return Response.json(
        {
          id: "concrete-session",
          model: "sonnet",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "session-concrete-1"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 200);
    // Before the fix, a direct/pinned-model request always registered
    // `sessionKey: null`, so a Codex hook or bridge report that only knows
    // the session id (skill-read telemetry, mcp_exposed, ...) could never be
    // attributed back to a concrete-model turn's provider/model/workspace.
    const sessionContext = lookupBridgeSessionContext("session-concrete-1");
    assert.ok(
      sessionContext,
      "a concrete-model request must register its session, not drop it as null"
    );
    assert.equal(sessionContext.provider, "claude");
    assert.equal(sessionContext.model, "sonnet");
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("native Codex requests record MCP exposure from the role contract without leaking bridge telemetry headers", () => {
  const codexHeaders = bridgeTelemetryHeaders(
    { provider: "codex" },
    "request-native"
  );
  assert.deepEqual(codexHeaders, {});
  assert.deepEqual(mcpContractForRole("default"), [
    "lsp",
    "cocoindex-code",
    "codegraphcontext"
  ]);
  resetOtelTelemetry();
  resetRouterTelemetry();
  recordNativeMcpExposure({
    route: { provider: "codex", model: CONFIGURED_ORCHESTRATOR_MODEL } as any,
    agentRole: "default",
    workspace: { key: "SimulatorLife/NativeCodex" },
    requestId: "request-native",
    sessionKey: "native-session"
  });
  const ws = getRouterStatus().usage.byWorkspace["SimulatorLife/NativeCodex"];
  assert.deepEqual(ws.mcpExposed, [
    { server: "cocoindex-code", count: 1 },
    { server: "codegraphcontext", count: 1 },
    { server: "lsp", count: 1 }
  ]);
  assert.deepEqual(ws.mcpUses, []);
  resetOtelTelemetry();
  resetRouterTelemetry();
});

test("direct concrete request retries once on HTTP 503 then succeeds without rerouting", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  const originalCooldown = process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
  const originalMax = process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = "10";
  process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = "20";
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      if (responseCalls === 1)
        return Response.json(
          { error: "temporarily unavailable" },
          { status: 503 }
        );
      return Response.json(
        {
          id: "retry-result",
          model: "sonnet",
          output_text: "ok"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-retry-503"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(response.headers.get("x-autodev-request-id"), "req-retry-503");
    assert.equal(responseCalls, 2);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
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
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      return Response.json(
        { error: "still unavailable" },
        {
          status: 503
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-bounded-retry"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 503);
    assert.equal(responseCalls, 2); // initial + exactly one retry, no further retries
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(
      response.headers.get("x-autodev-request-id"),
      "req-bounded-retry"
    );
    const retryAfter = Number(response.headers.get("retry-after"));
    assert.ok(
      Number.isFinite(retryAfter) && retryAfter > 0,
      "Retry-After must indicate a positive cooldown window"
    );
    const body = await response.json();
    assert.equal(body.error.code, "router_provider_unavailable");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.failureClass, "unavailable");
    assert.equal(body.error.provider, "claude");
    assert.equal(body.error.model, "sonnet");
    assert.equal(body.error.requestId, "req-bounded-retry");
    // Cooldown is now active so the next role request skips this provider.
    assert.equal(cooldowns.isCooling("claude"), true);
    // Recent events include the retry phase plus a final failure result.
    const recent = getRouterStatus().recentEvents;
    const retryEvents = recent.filter(
      (event: any) =>
        event.phase === "retry" && event.requestId === "req-bounded-retry"
    );
    assert.equal(retryEvents.length, 1);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request does not retry on auth (401) or payload (400) errors", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  let lastStatus = 0;
  for (const status of [401, 400]) {
    responseCalls = 0;
    globalThis.fetch = async (url: any, options: any = {}) => {
      if (String(url) === "http://127.0.0.1:4000/v1/responses") {
        responseCalls += 1;
        return Response.json({ error: "no" }, { status });
      }
      return originalFetch(url, options);
    };
    const server = createServer((request, response) => {
      void handle(request, response);
    });
    await listenServer(server);
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "sonnet", stream: false })
        }
      );
      lastStatus = response.status;
      assert.equal(response.status, status, `upstream returned ${status}`);
      assert.equal(
        responseCalls,
        1,
        `auth/payload errors must not trigger a retry (status=${status})`
      );
      assert.equal(
        response.headers.get("retry-after"),
        null,
        `Retry-After must not be set for non-retryable upstream ${status}`
      );
      const body = await response.json();
      assert.equal(
        body.error.code,
        status === 401 ? "router_authentication_error" : "router_upstream_error"
      );
      assert.equal(body.error.retryable, false);
      assert.equal(
        body.error.failureClass,
        status === 401 ? "authentication" : "request_error"
      );
      assert.equal(cooldowns.isCooling("claude"), false);
    } finally {
      await closeServer(server);
      activeProviderRequests.clear();
      cooldowns.clear("claude");
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
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      responseCalls += 1;
      const signal = options && options.signal;
      if (signal)
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true })
        );
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return originalFetch(url, options);
  };
  const route = routing.routeForModel("sonnet");
  const controller = new AbortController();
  const requestChunks = [
    Buffer.from(JSON.stringify({ model: "sonnet", stream: false }))
  ];
  const { IncomingMessage } = await import("node:http");
  const { Socket } = await import("node:net");
  const fakeRequest = Object.assign(new IncomingMessage(new Socket()), {
    url: "/v1/responses",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-aborted"
    },
    complete: false
  });
  for (const chunk of requestChunks) fakeRequest.push(chunk);
  fakeRequest.push(null);
  let _responseStatus = 0;
  let _responseBody = "";
  const headerStore: Record<string, any> = {};
  const fakeResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: any) {
      headerStore[name] = value;
    },
    getHeader(name: string) {
      return headerStore[name];
    },
    removeHeader(name: string) {
      delete headerStore[name];
    },
    writeHead(status: number, headers?: any) {
      this.headersSent = true;
      _responseStatus = status;
      for (const [name, value] of Object.entries(headers ?? {}))
        headerStore[name] = value;
    },
    write(chunk: any) {
      _responseBody += String(chunk);
    },
    end(chunk?: any) {
      if (chunk !== undefined) _responseBody += String(chunk);
      this.writableEnded = true;
    },
    once() { },
    on() { },
    removeListener() { }
  };
  try {
    // Schedule the abort for the next tick so the upstream fetch is in
    // flight when the signal fires; the router must then observe the
    // aborted flag and skip its bounded retry.
    setImmediate(() => controller.abort());
    await proxyConcreteResponse(
      fakeResponse as any,
      route!,
      { model: "sonnet", stream: false },
      false,
      "req-aborted",
      null,
      { key: "unknown", cwd: null },
      controller.signal
    );
    assert.equal(
      responseCalls,
      1,
      `aborted requests must not retry; got ${responseCalls} fetch calls`
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCooldown === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MS = originalCooldown;
    if (originalMax === undefined)
      delete process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS;
    else process.env.CODEX_ROUTER_CONCRETE_RETRY_MAX_MS = originalMax;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request stops retrying once the client aborts mid-way through the extended transport retry budget", async () => {
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  const controller = new AbortController();
  globalThis.fetch = async (url: any, options: any = {}) => {
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
  const route = routing.routeForModel("sonnet");
  const requestChunks = [
    Buffer.from(JSON.stringify({ model: "sonnet", stream: false }))
  ];
  const { IncomingMessage } = await import("node:http");
  const { Socket } = await import("node:net");
  const fakeRequest = Object.assign(new IncomingMessage(new Socket()), {
    url: "/v1/responses",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req-mid-budget-abort"
    },
    complete: false
  });
  for (const chunk of requestChunks) fakeRequest.push(chunk);
  fakeRequest.push(null);
  const headerStore: Record<string, any> = {};
  const fakeResponse = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: any) {
      headerStore[name] = value;
    },
    getHeader(name: string) {
      return headerStore[name];
    },
    removeHeader(name: string) {
      delete headerStore[name];
    },
    writeHead(status: number, headers?: any) {
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers ?? {}))
        headerStore[name] = value;
    },
    write() { },
    end() {
      this.writableEnded = true;
    },
    once() { },
    on() { },
    removeListener() { }
  };
  try {
    cooldowns.clear("claude");
    await proxyConcreteResponse(
      fakeResponse as any,
      route!,
      { model: "sonnet", stream: false },
      false,
      "req-mid-budget-abort",
      null,
      { key: "unknown", cwd: null },
      controller.signal
    );
    assert.equal(
      responseCalls,
      2,
      `cancellation must stop retries before the 3-attempt transport budget is exhausted; got ${responseCalls} fetch calls`
    );
    const events = getRouterStatus().recentEvents.filter(
      (event: any) => event.requestId === "req-mid-budget-abort"
    );
    const result = events.find((event: any) => event.phase === "result");
    assert.equal(
      result?.status,
      499,
      "an in-flight cancellation must report client_aborted, not spend the remaining retry budget"
    );
    assert.equal(result?.failureClass, "client_aborted");
    assert.equal(
      events.filter((event: any) => event.phase === "retry").length,
      1,
      "only the first attempt's retry should be scheduled; the second must be cut short by cancellation"
    );
  } finally {
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("direct concrete request does not reroute to a different provider when the configured one fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY
  };
  let antigravityCalls = 0;
  process.env.LITELLM_API_KEY = "test-provider-key";
  cooldowns.clear("claude");
  cooldowns.clear("antigravity");
  globalThis.fetch = async (url: any, options: any = {}) => {
    if (String(url) === "http://127.0.0.1:4000/v1/responses") {
      return Response.json(
        { error: "provider unavailable" },
        {
          status: 503
        }
      );
    }
    if (String(url) === "http://127.0.0.1:4001/v1/responses") {
      antigravityCalls += 1;
      return Response.json(
        {
          id: "antigravity-response",
          model: "gemini-3.8-flash-medium",
          output_text: "should-not-be-called"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-no-reroute"
        },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-autodev-provider"), "claude");
    assert.equal(response.headers.get("x-autodev-model"), "sonnet");
    assert.equal(
      response.headers.get("x-autodev-request-id"),
      "req-no-reroute"
    );
    assert.equal(
      antigravityCalls,
      0,
      "concrete requests must never silently reroute to another provider"
    );
    const body = await response.json();
    assert.equal(body.error.provider, "claude");
    assert.equal(body.error.model, "sonnet");
    assert.equal(body.error.routerInstanceId, ROUTER_INSTANCE_ID);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    cooldowns.clear("antigravity");
    resetRouterTelemetry();
  }
});

test("liveness stays 200 during draining while readiness returns 503 with structured router_draining body", async () => {
  resetLifecycleForTests();
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "autodev-readiness-state-")
  );
  const stateFile = join(stateDirectory, "router-state.json");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const readinessReady = await fetch(
      `http://127.0.0.1:${address.port}/health/readiness`
    );
    assert.equal(readinessReady.status, 200);
    const readyPayload = await readinessReady.json();
    assert.equal(readyPayload.status, "ready");
    assert.equal(readyPayload.lifecycle.state, "ready");
    assert.equal(isDraining(), false);

    // Force the lifecycle into draining without relying on the SIGTERM handler
    // (which would call process.exit in production).
    const { execSync } = await import("node:child_process");
    void execSync;
    const internal = await import("../../src/router/server.ts");
    void internal;

    // Trigger draining through the public lifecycle helper used by tests.
    resetLifecycleForTests();
    // Use the exported beginShutdown with a no-op server reference so we can
    // probe the endpoints while draining; only the SIGTERM handler exits.
    await beginShutdown("SIGTERM", null, stateFile as any);
    assert.equal(isDraining(), true);
    assert.equal(getLifecycleStatus().draining, true);

    const liveliness = await fetch(
      `http://127.0.0.1:${address.port}/health/liveliness`
    );
    assert.equal(liveliness.status, 200);
    const livenessBody = await liveliness.json();
    assert.equal(livenessBody.status, "ok");

    const readinessDraining = await fetch(
      `http://127.0.0.1:${address.port}/health/readiness`
    );
    assert.equal(readinessDraining.status, 503);
    const drainingBody = await readinessDraining.json();
    assert.equal(drainingBody.error.code, "router_draining");
    assert.equal(drainingBody.error.retryable, true);
    assert.equal(drainingBody.error.routerInstanceId, ROUTER_INSTANCE_ID);
    assert.equal(
      readinessDraining.headers.get("x-autodev-router-instance-id"),
      ROUTER_INSTANCE_ID
    );

    const responsesDuringDrain = await fetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(responsesDuringDrain.status, 503);
    assert.ok(
      Number(responsesDuringDrain.headers.get("retry-after")) > 0,
      "Retry-After must be set on the draining rejection"
    );
    const drainResponseBody = await responsesDuringDrain.json();
    assert.equal(drainResponseBody.error.code, "router_draining");
  } finally {
    await closeServer(server);
    resetLifecycleForTests();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("graceful shutdown drains in-flight requests, persists state, and stops accepting new traffic", async () => {
  const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), "autodev-shutdown-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetLifecycleForTests();
    resetRouterTelemetry();
    recordRouterEvent({
      phase: "selected",
      requestId: "shutdown-precondition",
      requestedModel: "sonnet",
      provider: "claude",
      model: "sonnet"
    });
    // Persist the precondition event so the test can later verify that
    // the shutdown drained a recent in-flight snapshot.
    await persistRouterStateNow(stateFile);

    // Mock fetch resolves only after the test allows it, simulating an
    // in-flight upstream call that must drain before shutdown completes.
    let upstreamResolve: any;
    const upstreamPromise = new Promise((resolve) => {
      upstreamResolve = resolve;
    });
    let upstreamCalls = 0;
    globalThis.fetch = async (url: any, options: any = {}) => {
      if (String(url) === "http://127.0.0.1:4000/v1/responses") {
        upstreamCalls += 1;
        await upstreamPromise;
        return Response.json(
          {
            id: "slow-response",
            model: "sonnet",
            output_text: "ok"
          },
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return originalFetch(url, options);
    };

    const server = createServer((request, response) => {
      void handle(request, response);
    });
    await listenServer(server);
    try {
      const address = server.address() as AddressInfo;
      const inflight = fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false })
      });

      // Wait until the request is registered with the router before draining.
      const deadline = Date.now() + 1000;
      while (
        getLifecycleStatus().activeResponseRequests === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(getLifecycleStatus().activeResponseRequests >= 1, true);

      // Begin shutdown while the request is still in flight.
      const shutdownPromise = beginShutdown(
        "SIGTERM",
        server,
        stateFile as any
      );

      // New requests during drain must be rejected immediately.
      const rejected = await fetch(
        `http://127.0.0.1:${address.port}/v1/responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "sonnet", stream: false })
        }
      );
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
      assert.equal(persisted.schema, "autodev-router-persisted-state-v4");
      assert.equal(
        persisted.recentEvents.some(
          (event: any) => event.requestId === "shutdown-precondition"
        ),
        true
      );
      assert.ok(
        typeof persisted.updatedAt === "string" &&
        persisted.updatedAt.length > 0
      );
      assert.equal(
        upstreamCalls,
        1,
        `the in-flight request must complete cleanly without a new upstream call; got ${upstreamCalls}`
      );
      assert.equal(getLifecycleStatus().state, "draining");
    } finally {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error: any) =>
            error && error.code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve()
          )
        );
      } catch {
        // The drain step inside beginShutdown already closes the server;
        // tolerate the duplicate close here.
      }
      globalThis.fetch = originalFetch;
      resetLifecycleForTests();
    }
  } finally {
    resetRouterTelemetry();
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    await rm(directory, { recursive: true, force: true });
  }
});

test("tells the provider bridge that an orchestrator turn is the orchestrator, so it is never handed the leaf prompt", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  for (const provider of ["codex", "claude", "antigravity", "minimax"])
    cooldowns.clear(provider);
  let upstreamHeaders: any = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    // Force the orchestrator off its pinned primary and onto a bridge-backed
    // fallback provider, which is exactly where the leaf prompt used to leak in.
    if (target.startsWith("https://chatgpt.com/"))
      return Response.json(
        { error: "You have hit your usage limit" },
        { status: 429 }
      );
    if (target.endsWith("/health") || target.endsWith("/health/liveliness"))
      return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      upstreamHeaders = options.headers;
      return Response.json(
        {
          id: "orchestrator",
          model: "fallback",
          output_text: "ok"
        },
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "orchestrator-role-header"
        },
        body: JSON.stringify({ model: ORCHESTRATOR_ALIAS, stream: false })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[AGENT_ROLE_HEADER], ORCHESTRATOR_AGENT_ROLE);
  } finally {
    await closeServer(server);
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
  for (const provider of [
    "codex",
    "claude",
    "antigravity",
    "minimax",
    "copilot"
  ])
    cooldowns.clear(provider);
  let upstreamHeaders: any = null;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/health") || target.endsWith("/health/liveliness"))
      return new Response("ok", { status: 200 });
    if (target.endsWith("/responses")) {
      upstreamHeaders = options.headers;
      return Response.json(
        { id: "role", model: "sonnet", output_text: "ok" },
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "leaf-role-header",
          // A leaf turn claiming to be the root: the router builds its outbound
          // header set from its own alias dispatch, so the claim never survives.
          [AGENT_ROLE_HEADER]: ORCHESTRATOR_AGENT_ROLE
        },
        body: JSON.stringify({ model: "autodev/explorer", stream: false })
      }
    );
    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders[AGENT_ROLE_HEADER], "explorer");
  } finally {
    await closeServer(server);
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
  assert.equal(
    isClientDisconnectError(
      Object.assign(new Error("broken pipe"), { code: "EPIPE" })
    ),
    true
  );
  assert.equal(
    isClientDisconnectError(
      Object.assign(new Error("conn reset"), { code: "ECONNRESET" })
    ),
    true
  );
  assert.equal(
    isClientDisconnectError(
      Object.assign(new Error("stream destroyed"), {
        code: "ERR_STREAM_DESTROYED"
      })
    ),
    true
  );
  assert.equal(
    isClientDisconnectError(
      Object.assign(new Error("write after end"), {
        code: "ERR_STREAM_WRITE_AFTER_END"
      })
    ),
    true
  );
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
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/responses")) {
      const stream = new ReadableStream({
        async start(controller) {
          // Send an initial event
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"hello"}\n\n'
            )
          );
          // Delay to allow the router-level keep-alive to fire
          await new Promise((resolve) => setTimeout(resolve, 2200));
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
            )
          );
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return originalFetch(url, options);
  };
  cooldowns.clear("claude");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: true })
      }
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(
      body,
      /: codex-router keep-alive/,
      "the router should emit keep-alive comments during quiet intervals"
    );
    assert.match(
      body,
      /"type":"response\.completed"/,
      "the completed event should follow the keep-alive"
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("abrupt client disconnect during SSE stream does not crash the router process", async () => {
  const originalFetch = globalThis.fetch;
  let _upstreamEmitted = 0;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/responses")) {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"part1"}\n\n'
            )
          );
          _upstreamEmitted += 1;
          // Wait briefly, then emit more data after client has disconnected
          await new Promise((resolve) => setTimeout(resolve, 150));
          try {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"part2"}\n\n'
              )
            );
            _upstreamEmitted += 1;
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
              )
            );
            controller.close();
          } catch {
            // Upstream controller closed
          }
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return originalFetch(url, options);
  };
  cooldowns.clear("claude");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  const port = (server.address() as AddressInfo).port;
  try {
    // Connect via raw TCP socket and abruptly destroy the socket after receiving initial data
    await new Promise<void>((resolve) => {
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
    const followUpResponse = await originalFetch(
      `http://127.0.0.1:${port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(
      followUpResponse.status,
      200,
      "router must remain healthy and responsive after a client disconnected mid-stream"
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
    resetRouterTelemetry();
  }
});

test("upstream abort mid-SSE stream emits terminal response.incomplete event rather than closing socket abruptly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.endsWith("/responses")) {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"part1"}\n\n'
            )
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.error(new Error("upstream timed out"));
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return originalFetch(url, options);
  };
  cooldowns.clear("claude");
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: true })
      }
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"type":"response\.output_text\.delta"/);
    assert.match(body, /"type":"response\.failed"/);
    assert.match(body, /upstream timed out/);
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    activeProviderRequests.clear();
    cooldowns.clear("claude");
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

const PROVIDER_KEYS = [
  "LITELLM_API_KEY",
  "MINIMAX_API_KEY",
  "CODEX_ROUTER_COPILOT_API_KEY"
];

/**
 * Run `body` with every provider credential present and fetch stubbed.
 * `prepare` runs after telemetry is reset, which is where cooldown setup has to
 * go: resetRouterTelemetry clears the cooldown map.
 */
async function withStubbedProviders(
  stub: any,
  body: any,
  prepare: any = () => { }
) {
  const originalFetch = globalThis.fetch;
  const originalCredentials = Object.fromEntries(
    PROVIDER_KEYS.map((key) => [key, process.env[key]])
  );
  for (const key of PROVIDER_KEYS) process.env[key] = "test-provider-key";
  resetRouterTelemetry();
  activeProviderRequests.clear();
  prepare();
  globalThis.fetch = async (url: any, options: any = {}) =>
    stub(String(url), options) ?? originalFetch(url, options);
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    return await body({
      port: (server.address() as AddressInfo).port,
      fetch: originalFetch
    });
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    activeProviderRequests.clear();
    resetRouterTelemetry();
  }
}

const healthyProbe = (target: any) =>
  target.endsWith("/health") || target.endsWith("/health/liveliness")
    ? new Response("ok", { status: 200 })
    : null;
const jsonResponse = (body: any, init: any = {}) =>
  Response.json(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
const DEFAULT_TIER = ["claude", "antigravity", "minimax", "copilot", "codex"];

test("attempts a cooling provider as a last resort rather than stranding the caller", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      if (
        target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
      ) {
        responseCalls += 1;
        return jsonResponse({
          id: "last-resort",
          model: "sonnet",
          output_text: "served"
        });
      }
      return null;
    },
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "last-resort-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(
        response.status,
        200,
        "a soft cooldown must not be an absolute bar"
      );
      assert.equal(responseCalls, 1);
      assert.ok(
        getRouterStatus().recentEvents.some(
          (event: any) => event.selection === "last_resort"
        ),
        "the last-resort pass must be visible in the event log"
      );
      // Serving clears the cooldown: the chain heals itself.
      assert.equal(
        cooldowns.isCooling(response.headers.get("x-autodev-provider")),
        false
      );
    },
    // Out of usage with no stated reset: the 15-minute floor is the router's own
    // guess, so a last resort may still challenge it -- and it is far enough out
    // that the bounded wait cannot fire and confuse what is being measured.
    () => {
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "quota_exhausted",
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("bounds how many cooling providers the last-resort pass will try", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      if (
        target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
      ) {
        responseCalls += 1;
        return Response.json(
          { error: "temporarily unavailable" },
          { status: 503 }
        );
      }
      return null;
    },
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "last-resort-cap"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(response.status, 503);
      // Five cooling candidates, but the pass is capped: falling back to fumes
      // must not become a way to hammer everything that is already struggling.
      assert.equal(responseCalls, 2);
      assert.equal((await response.json()).error.details.lastResortAttempts, 2);
    },
    () => {
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "quota_exhausted",
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("never re-attempts a provider that stated a reset time still in the future", async () => {
  let responseCalls = 0;
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await withStubbedProviders(
    (target: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      if (
        target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
      ) {
        responseCalls += 1;
        return jsonResponse({ id: "x" });
      }
      return null;
    },
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "hard-limit-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(response.status, 503);
      // The providers said they will not serve until the reset. Attempting them
      // anyway is guaranteed to fail and is exactly the hammering a cooldown
      // exists to prevent.
      assert.equal(responseCalls, 0);
      const body = await response.json();
      assert.equal(body.error.details.recommendedAction, "summarize_and_yield");
      assert.equal(body.error.details.resetsAt, resetsAt);
      assert.equal(body.error.failureClass, "quota_exhausted");
      assert.match(
        body.error.message,
        /Return a summary of the work completed so far/
      );
      assert.equal(response.headers.get("x-autodev-limit-resets-at"), resetsAt);
      assert.equal(
        response.headers.get("x-autodev-limit-class"),
        "quota_exhausted"
      );
      for (const entry of body.error.details.providers)
        assert.equal(entry.state, "hard");
    },
    () => {
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "quota_exhausted",
          resetsAt,
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("waits out a cooldown that is about to lapse instead of ending the turn", async () => {
  let responseCalls = 0;
  await withStubbedProviders(
    (target: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      if (
        target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
      ) {
        responseCalls += 1;
        return jsonResponse({
          id: "after-wait",
          model: "sonnet",
          output_text: "served"
        });
      }
      return null;
    },
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "wait-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(response.status, 200);
      assert.equal(responseCalls, 1);
      assert.ok(
        getRouterStatus().recentEvents.some(
          (event: any) => event.phase === "exhaustion_wait"
        )
      );
    },
    // A stated reset moments away. The last-resort pass will not touch it -- the
    // provider has said it will not serve yet -- so the wait is the only thing
    // that can save this turn.
    () => {
      const resetsAt = new Date(Date.now() + 250).toISOString();
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "quota_exhausted",
          resetsAt,
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("a provider whose bridge is down does not consume the attempt the wait bought", async () => {
  let responseCalls = 0;
  // Only MiniMax's bridge is up. Whatever order the tier shuffles into, every
  // other candidate fails its health probe first.
  const MINIMAX_PORT = "18765";
  await withStubbedProviders(
    (target: any) => {
      if (target.endsWith("/health") || target.endsWith("/health/liveliness")) {
        return new Response("", {
          status: target.includes(MINIMAX_PORT) ? 200 : 503
        });
      }
      if (
        target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
      ) {
        responseCalls += 1;
        return jsonResponse({
          id: "after-wait",
          model: "m",
          output_text: "served"
        });
      }
      return null;
    },
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "wait-skip-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      // A candidate whose bridge did not answer was never asked anything, so it
      // must not consume the single attempt the wait bought. Spending it on a
      // health probe wasted the whole wait.
      assert.equal(response.status, 200);
      assert.equal(responseCalls, 1);
      assert.equal(response.headers.get("x-autodev-provider"), "minimax");
    },
    () => {
      const resetsAt = new Date(Date.now() + 250).toISOString();
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "session_limit",
          resetsAt,
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("does not wait for a cooldown that is nowhere near lapsing", async () => {
  const startedAt = Date.now();
  const resetsAt = new Date(startedAt + 3_600_000).toISOString();
  await withStubbedProviders(
    (target: any) =>
      healthyProbe(target) ??
      (target.endsWith("/responses") ? jsonResponse({ id: "never" }) : null),
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "no-wait-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(response.status, 503);
      // An hour is not something to hold a subagent slot for.
      assert.ok(
        Date.now() - startedAt < 5000,
        "the router must not hold the request for a distant reset"
      );
    },
    () => {
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "session_limit",
          resetsAt,
          structured: true
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("holds a provider until the reset time it declared in its response", async () => {
  const resetsAt = new Date(Date.now() + 7_200_000).toISOString();
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
  await withStubbedProviders(
    (target: any) =>
      healthyProbe(target) ??
      (target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
        ? Response.json(
          {
            error: { message: "out of usage", type: "rate_limit_error" }
          },
          {
            status: 429,
            headers: {
              "x-autodev-limit-class": "quota_exhausted",
              "x-autodev-limit-type": "weekly",
              "x-autodev-limit-resets-at": resetsAt,
              "x-autodev-limit-source": "reported"
            }
          }
        )
        : null),
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "declared-limit-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      assert.equal(response.status, 503);
      const claude = getRouterStatus().providers.claude;
      // The provider's own word, not a 30s guess doubling toward ten minutes.
      assert.equal(claude.cooldownKind, "hard");
      assert.equal(claude.cooldownResetsAt, resetsAt);
      assert.equal(claude.cooldownUntil, resetsAt);
      assert.equal(claude.lastResortEligible, false);
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("a turn a provider closed as incomplete reaches the caller and cools on the reported class", async () => {
  const resetsAt = new Date(Date.now() + 5_400_000).toISOString();
  const incomplete =
    [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message"}}',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"half a result"}',
      `data: {"type":"response.completed","response":{"id":"resp_1","status":"incomplete","output_text":"half a result","incomplete_details":{"reason":"provider_limit","provider_limit":{"class":"session_limit","type":"session","resets_at":"${resetsAt}","source":"reported"}}}}`,
      "data: [DONE]"
    ].join("\n\n") + "\n\n";
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
  await withStubbedProviders(
    (target: any) =>
      healthyProbe(target) ??
      (target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
        ? new Response(incomplete, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
        : null),
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "incomplete-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: true })
        }
      );
      const body = await response.text();
      // The work the child did reaches the parent; it is not replaced by an
      // error string, and it is not replayed on another provider either --
      // a stream cannot be taken back once it has started.
      assert.match(body, /half a result/);
      const served = response.headers.get("x-autodev-provider");
      const provider = getRouterStatus().providers[served];
      assert.equal(
        provider.cooldownKind,
        "hard",
        "an incomplete turn is still a provider failure"
      );
      assert.equal(provider.cooldownResetsAt, resetsAt);
      assert.equal(provider.failures, 1);
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("closes an abandoned stream as incomplete, carrying what it already forwarded", async () => {
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
  const truncated =
    [
      'data: {"type":"response.created","response":{"id":"resp_2"}}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_2","type":"message"}}',
      'data: {"type":"response.output_text.delta","item_id":"msg_2","delta":"work in progress"}'
    ].join("\n\n") + "\n\n";
  await withStubbedProviders(
    (target: any) =>
      healthyProbe(target) ??
      (target.endsWith("/responses") ||
        target.startsWith("https://chatgpt.com/")
        ? new Response(truncated, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
        : null),
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "truncated-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: true })
        }
      );
      const body = await response.text();
      // A stream that just stops is indistinguishable from a hung provider.
      // The router closes it itself, and the partial work survives.
      assert.match(body, /"status":"incomplete"/);
      assert.match(body, /"reason":"provider_interrupted"/);
      assert.match(body, /work in progress/);
      assert.doesNotMatch(body, /closed the stream before response\.completed/);
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
});

test("releases the subagent slot when every provider is exhausted", async () => {
  resetConcurrencyTelemetry();
  await withStubbedProviders(
    (target: any) =>
      healthyProbe(target) ??
      (target.endsWith("/responses") ? jsonResponse({ id: "never" }) : null),
    async ({ port, fetch: realFetch }: any) => {
      const response = await realFetch(
        `http://127.0.0.1:${port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-session-id": "slot-release-test"
          },
          body: JSON.stringify({ model: "autodev/default", stream: false })
        }
      );
      // Every candidate is out for a reason only the user can fix, so the
      // router answers a non-retryable 400 rather than a 5xx Codex retries.
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.retryable, false);
      // A wedged or exhausted child must not hold a slot: with a per-session
      // limit of two, two of those end delegation for the session.
      assert.equal(concurrencyStatus().activeSubagentThreads, 0);
      assert.equal(concurrencyStatus().activeSessions, 0);
    },
    // A broken credential: never retried as a last resort, so this exhausts
    // immediately and the only question is whether the slot came back.
    () => {
      for (const provider of DEFAULT_TIER)
        cooldowns.cooldownProvider(provider, {
          failureClass: "authentication"
        });
    }
  );
  for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
  resetConcurrencyTelemetry();
});

test("a model the provider rejects fails the turn once, non-retryably, and leaves the provider's other models usable", async () => {
  const others = DEFAULT_TIER.filter((provider) => provider !== "claude");
  const requested: string[] = [];
  try {
    await withStubbedProviders(
      (target: string, options: any) => {
        const probe = healthyProbe(target);
        if (probe) return probe;
        if (!target.startsWith("http://127.0.0.1:4000/")) return null;
        const model = JSON.parse(String(options.body)).model;
        requested.push(model);
        return model === "sonnet"
          ? jsonResponse({
              id: "resp_sonnet",
              status: "completed",
              model,
              output: []
            })
          : jsonResponse(
              {
                error: {
                  type: "invalid_request_error",
                  code: "invalid_model",
                  message:
                    "Claude Code 2.1.240 does not support this model; version 2.1.280 or newer is required."
                }
              },
              { status: 400 }
            );
      },
      async ({ port, fetch: realFetch }: any) => {
        const post = (model: string) =>
          realFetch(`http://127.0.0.1:${port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, stream: false })
          });

        const turn = await post("autodev/orchestrator");
        // A 5xx is retried by Codex; nothing a retry does can fix this.
        assert.equal(turn.status, 400);
        assert.equal(turn.headers.get("retry-after"), null);
        const body = await turn.json();
        assert.equal(body.error.code, "router_provider_exhausted");
        assert.equal(body.error.retryable, false);
        assert.equal(body.error.failureClass, "invalid_model");
        assert.equal(body.error.details.recommendedAction, "fix_configuration");
        assert.match(
          body.error.message,
          /claude: invalid_model for claude-opus-5-5 \(Claude Code 2\.1\.240 does not support this model; version 2\.1\.280 or newer is required\.\)/
        );
        assert.doesNotMatch(body.error.message, /unavailable|Retry after/);
        assert.equal(
          spawnFailureStatus().total,
          0,
          "a root orchestrator turn spawns nothing, so it is no spawn failure"
        );

        // The rejected model is cooled down, not Claude: Sonnet still serves.
        const child = await post("autodev/default");
        assert.equal(child.status, 200);
        assert.deepEqual(requested, ["claude-opus-5-5", "sonnet"]);
      },
      () => {
        for (const provider of others) {
          routing.setProviderEnabledForRole(provider, "orchestrator", false);
          routing.setProviderEnabledForRole(provider, "subagent", false);
        }
      }
    );
  } finally {
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");
    cooldowns.clear("claude");
  }
});

test("a client that disconnects mid-stream is recorded as client_aborted and cools no provider down", async () => {
  // Observed 2026-09-24: Codex Desktop archived a side thread mid-turn. The
  // router read the truncated stream as upstream_error and cooled Codex down
  // for 30s, failing every other session's orchestrator turn. A real socket
  // close reaches the response before the request's close handler aborts the
  // client signal, so this must go through a real server and client.
  const encoder = new TextEncoder();
  await withStubbedProviders(
    (target: string, options: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      const signal: AbortSignal | undefined = options?.signal;
      let timer: NodeJS.Timeout | null = null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let sequence = 0;
          const push = () => {
            sequence += 1;
            controller.enqueue(
              encoder.encode(
                `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: `line ${sequence}\n` })}\n\n`
              )
            );
            timer = setTimeout(push, 10);
          };
          push();
          signal?.addEventListener("abort", () => {
            if (timer) clearTimeout(timer);
            controller.error(signal.reason);
          });
        },
        cancel() {
          if (timer) clearTimeout(timer);
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    },
    async ({ port, fetch: realFetch }: any) => {
      const client = new AbortController();
      const response = await realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "autodev/default", stream: true }),
        signal: client.signal
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      let received = 0;
      while (received < 300) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
      }
      client.abort();
      await reader.cancel().catch(() => {});

      const deadline = Date.now() + 5000;
      let result: any = null;
      while (!result && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        result = getRouterStatus().recentEvents?.find(
          (event: any) => event.phase === "result"
        );
      }
      assert.ok(result, "the router records the aborted request");
      assert.equal(result.status, 499);
      assert.equal(result.failureClass, "client_aborted");
      for (const provider of DEFAULT_TIER)
        assert.equal(
          cooldowns.isCooling(provider),
          false,
          `${provider} must not be cooled down by a client leaving`
        );
    }
  );
});

test("a client that gives up before the provider answers cools no provider down", async () => {
  let upstreamStarted = 0;
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  await withStubbedProviders(
    (target: string, options: any) => {
      const probe = healthyProbe(target);
      if (probe) return probe;
      upstreamStarted += 1;
      markStarted();
      const signal: AbortSignal | undefined = options?.signal;
      // A provider still thinking: it answers only when the request is aborted.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    },
    async ({ port, fetch: realFetch }: any) => {
      const client = new AbortController();
      const pending = realFetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "autodev/default", stream: true }),
        signal: client.signal
      }).catch(() => null);
      await started;
      client.abort();
      await pending;

      const deadline = Date.now() + 5000;
      let result: any = null;
      while (!result && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        result = getRouterStatus().recentEvents?.find(
          (event: any) => event.phase === "result"
        );
      }
      assert.ok(result, "the router records the aborted request");
      assert.equal(result.failureClass, "client_aborted");
      assert.equal(upstreamStarted, 1, "no fallback to another provider");
      for (const provider of DEFAULT_TIER)
        assert.equal(cooldowns.isCooling(provider), false, provider);
    }
  );
});

test("only a provider-declared cooldown survives a router restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-cooldown-state-"));
  const file = join(directory, "state.json");
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  try {
    resetRouterTelemetry();
    cooldowns.cooldownProvider("claude", {
      failureClass: "quota_exhausted",
      resetsAt,
      structured: true
    });
    cooldowns.cooldownProvider("minimax", {});
    cooldowns.cooldownProvider("copilot", {
      failureClass: "probe_unavailable"
    });
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
    for (const provider of DEFAULT_TIER) cooldowns.clear(provider);
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
    older.subagents = {
      total: 7,
      byMechanism: { bridge_native: 7 },
      byProvider: { antigravity: 7 },
      byRole: {},
      byStatus: {},
      recent: []
    };
    older.spawnFailures = {
      total: 2,
      byReason: { provider_exhausted: 2 },
      recent: []
    };
    await writeFile(file, JSON.stringify(older), "utf8");

    resetRouterTelemetry();
    assert.equal(
      loadRouterState(file),
      true,
      "an envelope this router wrote must still load"
    );
    assert.equal(
      subagentStatus().total,
      7,
      "subagent history survives an unrelated addition"
    );
    assert.equal(spawnFailureStatus().total, 2);

    // A file that is not this router's state at all is still refused.
    await writeFile(
      file,
      JSON.stringify({ schema: "something-else", subagents: { total: 99 } }),
      "utf8"
    );
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
  const fromHeaders = declaredLimit(
    new Headers({
      "x-autodev-limit-class": "session_limit",
      "x-autodev-limit-resets-at": resetsAt,
      "x-autodev-limit-source": "reported"
    }),
    ""
  );
  assert.equal(fromHeaders!.limitClass, "session_limit");
  assert.equal(fromHeaders!.resetsAt, resetsAt);
  assert.equal(fromHeaders!.source, "reported");

  const fromBody = declaredLimit(
    new Headers(),
    JSON.stringify({
      error: {
        limit: {
          class: "quota_exhausted",
          resets_at: resetsAt,
          source: "reported"
        }
      }
    })
  );
  assert.equal(fromBody!.limitClass, "quota_exhausted");
  assert.equal(fromBody!.resetsAt, resetsAt);

  // A provider that declared nothing must not be read as declaring something:
  // that is what leaves the router guessing from prose.
  assert.equal(
    declaredLimit(new Headers(), "you have exceeded your quota"),
    null
  );
  assert.equal(declaredLimit(new Headers(), "not json at all"), null);
});

test("summarizes every candidate's cooldown for the exhaustion body", () => {
  const now = 1_000_000;
  try {
    const resetsAt = new Date(now + 600_000).toISOString();
    cooldowns.cooldownProvider("claude", {
      now,
      failureClass: "quota_exhausted",
      resetsAt,
      structured: true
    });
    cooldowns.cooldownProvider("minimax", { now });
    const summary = cooldowns.summary(
      [
        { provider: "claude", model: "sonnet" },
        { provider: "minimax", model: "MiniMax-M3" },
        { provider: "codex", model: CONFIGURED_ORCHESTRATOR_MODEL }
      ],
      now + 1
    );
    assert.deepEqual(
      summary.map(({ provider, state }) => [provider, state]),
      [
        ["claude", "hard"],
        ["minimax", "transient"],
        ["codex", "available"]
      ]
    );
    assert.equal(summary[0]!.resetsAt, resetsAt);
    assert.equal(summary[1]!.retryAfterMs, 29_999);
    assert.equal(cooldowns.allowsLastResort(null), true);
  } finally {
    cooldowns.clear("claude");
    cooldowns.clear("minimax");
  }
});

test("a bridge is told which Codex conversation it is serving, and how sure the router is", () => {
  // A bridge that drives Codex's own spawner has to split one CLI turn across
  // two requests, so it needs to recognise the continuation as the same
  // conversation. Codex serves its own children and is never told.
  const claude = downstreamHeaders(
    { provider: "claude", envKey: "LITELLM_API_KEY" } as any,
    {} as any,
    null,
    "orchestrator",
    "req-1",
    { key: "sess-1", scope: "identified" }
  );
  assert.equal(claude[SESSION_ID_HEADER], "sess-1");
  assert.equal(claude[SESSION_SCOPE_HEADER], "identified");

  const codex = downstreamHeaders(
    { provider: "codex" } as any,
    { token: "t", accountId: "a" },
    null,
    "orchestrator",
    "req-1",
    { key: "sess-1", scope: "identified" }
  );
  assert.equal(codex[SESSION_ID_HEADER], undefined);

  // The scope is what stops a bridge holding CLI state under the router's
  // process-wide fallback key, where two unrelated conversations would share
  // one process and see each other's work.
  const unidentified = downstreamHeaders(
    { provider: "claude", envKey: "LITELLM_API_KEY" } as any,
    {} as any,
    null,
    "orchestrator",
    "req-1",
    { key: PROCESS_FALLBACK_SESSION_KEY, scope: "process-fallback" }
  );
  assert.equal(unidentified[SESSION_SCOPE_HEADER], "process-fallback");

  // No session resolved at all means no header, not an empty one.
  const none = downstreamHeaders(
    { provider: "claude", envKey: "LITELLM_API_KEY" } as any,
    {} as any,
    null,
    "orchestrator",
    "req-1",
    null
  );
  assert.equal(none[SESSION_ID_HEADER], undefined);
  assert.equal(none[SESSION_SCOPE_HEADER], undefined);
});

test("the session headers are router-generated and never forwarded from the client", () => {
  // Same trust argument as the agent role: a bridge acts on these, so a client
  // must not be able to name someone else's session.
  assert.equal(FORWARDED_REQUEST_HEADERS.includes(SESSION_ID_HEADER), false);
  assert.equal(FORWARDED_REQUEST_HEADERS.includes(SESSION_SCOPE_HEADER), false);
});

test("a turn continuing a tool call is recognised as one", () => {
  assert.equal(
    carriesPendingToolResult({
      input: [{ type: "custom_tool_call_output", call_id: "c1", output: "x" }]
    }),
    true
  );
  assert.equal(
    carriesPendingToolResult({
      input: [{ type: "function_call_output", call_id: "c1", output: "x" }]
    }),
    true
  );
  assert.equal(
    carriesPendingToolResult({
      input: [{ type: "message", role: "user", content: [] }]
    }),
    false
  );
  assert.equal(carriesPendingToolResult({}), false);
  assert.equal(carriesPendingToolResult(null), false);
});

test("a continuation prefers the provider still holding the turn, without pinning to it", () => {
  // The bridge that made the tool call is holding a live CLI for the answer.
  // Sending the continuation elsewhere strands it and loses the turn's work.
  const providers = (list: any[]) => list.map((c: any) => c.provider);
  const plain = routing.orchestratorCandidates(() => 0);
  assert.ok(
    plain.length > 1,
    "this test needs a multi-provider orchestrator tier"
  );

  const last = plain.at(-1)!.provider;
  const hoisted = routing.orchestratorCandidates(() => 0, last);
  assert.equal(
    hoisted[0]!.provider,
    last,
    "the holding provider is tried first"
  );
  // Still a preference, not a pin: every candidate survives, exactly once, so
  // the chain can still degrade if that provider is down.
  assert.deepEqual(
    [...providers(hoisted)].sort(),
    [...providers(plain)].sort()
  );
  assert.equal(new Set(providers(hoisted)).size, hoisted.length);

  // An unknown or already-first preference changes nothing.
  assert.deepEqual(
    providers(routing.orchestratorCandidates(() => 0, "not-a-provider")),
    providers(plain)
  );
  assert.deepEqual(
    providers(routing.orchestratorCandidates(() => 0, plain[0]!.provider)),
    providers(plain)
  );
  assert.deepEqual(
    providers(routing.orchestratorCandidates(() => 0, null)),
    providers(plain)
  );
});

// A turn served by a provider that mints ids the Responses contract rejects
// poisons the session permanently: Codex stores what it was handed and replays
// it on every later turn, so the first request that lands on a provider which
// validates fails, and so does every request after it.
test("outbound item ids are corrected to match their item type", () => {
  const poisoned = [
    { type: "message", id: "msg_1", role: "user", content: [] },
    { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs" },
    {
      type: "custom_tool_call",
      id: "06ef3bc08924acade1facee14da0af2e_fc_0",
      call_id: "call_8ec20ad454e0460d9d4b6662",
      name: "exec",
      input: "text()"
    },
    {
      type: "custom_tool_call_output",
      id: "ctco_1",
      call_id: "call_8ec20ad454e0460d9d4b6662",
      output: "ok"
    }
  ];

  // Non-Codex providers preserve reasoning items with their minted IDs for continuity,
  // while self-contained items like tool calls are normalized.
  for (const model of ["MiniMax-M3", "sonnet"]) {
    const route = routing.routeForModel(model);
    const sent: any = responses.upstreamPayload(
      route as any,
      { model, input: poisoned },
      true
    );
    assert.equal(sent.input.length, 4);
    assert.equal(sent.input[0].id, "msg_1");
    assert.equal(
      sent.input[1].id,
      "06eea1506b9c37f6f3f4bb02f90abd28_rs",
      `${route!.provider} reasoning id preserved`
    );
    assert.match(
      sent.input[2].id,
      /^ctc_/,
      `${route!.provider} tool call id normalized`
    );
    assert.equal(sent.input[3].id, "ctco_1");
    assert.equal(sent.input[2].call_id, "call_8ec20ad454e0460d9d4b6662");
    assert.equal(sent.input[3].call_id, "call_8ec20ad454e0460d9d4b6662");
  }

  // On Codex routes, reasoning items without encrypted_content are unresolvable references
  // under store: false and are dropped outright, while tool calls are normalized.
  const codexRoute = routing.routeForModel(CONFIGURED_ORCHESTRATOR_MODEL);
  const codexSent: any = responses.upstreamPayload(
    codexRoute as any,
    { model: CONFIGURED_ORCHESTRATOR_MODEL, input: poisoned },
    true
  );
  assert.equal(
    codexSent.input.length,
    3,
    "unresolvable foreign reasoning item dropped"
  );
  assert.equal(codexSent.input[0].id, "msg_1");
  assert.match(codexSent.input[1].id, /^ctc_/, "tool call id normalized");
  assert.equal(codexSent.input[2].id, "ctco_1");
  assert.equal(codexSent.input[1].call_id, "call_8ec20ad454e0460d9d4b6662");
  assert.equal(codexSent.input[2].call_id, "call_8ec20ad454e0460d9d4b6662");

  // A genuine reasoning item carrying encrypted_content survives on Codex.
  const withEncrypted = [
    {
      type: "reasoning",
      id: "rs_0252e954049dbf1c016aa00850d46087d1853ed6aa5cb47915",
      encrypted_content: "enc_data"
    },
    {
      type: "custom_tool_call",
      id: "06ef3bc08924acade1facee14da0af2e_fc_0",
      call_id: "call_8ec20ad454e0460d9d4b6662",
      name: "exec",
      input: "text()"
    }
  ];
  const codexSurvives: any = responses.upstreamPayload(
    codexRoute as any,
    { model: CONFIGURED_ORCHESTRATOR_MODEL, input: withEncrypted },
    true
  );
  assert.equal(codexSurvives.input.length, 2);
  assert.equal(
    codexSurvives.input[0].id,
    "rs_0252e954049dbf1c016aa00850d46087d1853ed6aa5cb47915"
  );
  assert.match(codexSurvives.input[1].id, /^ctc_/);

  // The caller's array is never mutated in place.
  assert.equal(poisoned[2]!.id, "06ef3bc08924acade1facee14da0af2e_fc_0");
});

test("a payload whose ids already conform is forwarded unchanged", () => {
  const input = [
    { type: "reasoning", id: "rs_abc", encrypted_content: "enc_1" },
    { type: "custom_tool_call", id: "ctc_abc", call_id: "call_1", name: "exec" }
  ];
  const sent: any = responses.upstreamPayload(
    routing.routeForModel(CONFIGURED_ORCHESTRATOR_MODEL) as any,
    { model: CONFIGURED_ORCHESTRATOR_MODEL, input },
    true
  );
  assert.equal(sent.input, input);
});

test("every provider normalises item ids", () => {
  for (const provider of Object.keys(
    JSON.parse(
      readFileSync(
        new URL("../../config/model-routing.json", import.meta.url),
        "utf8"
      )
    ).providers
  )) {
    assert.equal(
      providerCapabilities(provider).normalizeItemIds,
      true,
      provider
    );
  }
});

// The escape hatch has to actually reach upstreamPayload, not just parse. Run
// it in a child so the routing config can be swapped before module load.
test("end-to-end: unresolvable reasoning items dropped and tool call ids normalized on codex route", async () => {
  resetRouterTelemetry();
  const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/poisoned-rollout-items.json", import.meta.url),
      "utf8"
    )
  );

  const unresolvable1 = {
    type: "reasoning",
    id: "06eea1506b9c37f6f3f4bb02f90abd28_rs"
  };
  const unresolvable2 = { type: "reasoning", id: "rs_bridge_synthetic_123456" };
  const extraGenuine = {
    type: "reasoning",
    id: "rs_extra_genuine_123456789012345678901234567890123456789012",
    encrypted_content: "enc_extra"
  };

  const inputWithForeign = [
    ...fixture.items,
    unresolvable1,
    unresolvable2,
    extraGenuine
  ];

  let upstreamRequestBody: any = null;
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // 1. Format validation (400)
      for (let i = 0; i < upstreamRequestBody.input.length; i++) {
        const item = upstreamRequestBody.input[i];
        const prefix =
          RESPONSES_ITEM_ID_PREFIXES[
          item.type as keyof typeof RESPONSES_ITEM_ID_PREFIXES
          ];
        if (
          prefix &&
          typeof item.id === "string" &&
          !item.id.startsWith(prefix)
        ) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: `Invalid 'input[${i}].id': '${item.id}'. Expected an ID that begins with '${prefix.slice(0, -1)}'.`,
                type: "invalid_request_error"
              }
            })
          );
          return;
        }
      }
      // 2. Lookup rule (404)
      if (upstreamRequestBody.store === false) {
        for (const item of upstreamRequestBody.input) {
          if (
            item.type === "reasoning" &&
            (!item.encrypted_content ||
              typeof item.encrypted_content !== "string")
          ) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  message: `Item with id '${item.id}' not found. Items are not persisted when store is set to false.`,
                  type: "invalid_request_error"
                }
              })
            );
            return;
          }
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_success", output: [] }));
    });
  });
  await listenServer(upstream);
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (
      target.startsWith("https://chatgpt.com/") ||
      target.endsWith("/responses")
    ) {
      return originalFetch(
        `http://127.0.0.1:${upstreamPort}/v1/responses`,
        options
      );
    }
    return originalFetch(url, options);
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  try {
    const address = server.address() as AddressInfo;
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "e2e-reasoning-drop-test"
        },
        body: JSON.stringify({
          model: CONFIGURED_ORCHESTRATOR_MODEL,
          input: inputWithForeign,
          stream: false
        })
      }
    );
    assert.equal(response.status, 200);

    const events = getRouterStatus().recentEvents;
    const dropEvent = events.find(
      (e: any) => e.phase === "foreign_reasoning_dropped"
    );
    const normEvent = events.find(
      (e: any) => e.phase === "item_ids_normalized"
    );

    assert.ok(dropEvent, "foreign_reasoning_dropped event fired");
    assert.equal(dropEvent.droppedReasoningItems, 2);

    assert.ok(normEvent, "item_ids_normalized event fired");
    assert.equal(normEvent.normalizedItemIds, 9);

    // Verify upstream saw 0 non-conforming IDs
    const nonConforming = upstreamRequestBody.input.filter((item: any) => {
      const prefix =
        RESPONSES_ITEM_ID_PREFIXES[
        item.type as keyof typeof RESPONSES_ITEM_ID_PREFIXES
        ];
      return (
        prefix && typeof item.id === "string" && !item.id.startsWith(prefix)
      );
    });
    assert.equal(nonConforming.length, 0);

    // input[18].id on the wire is ctc_e60e73b91d8baea7b1f1d138d2967e27 (was 06ef3bc43b096c4935a65885c28fb67b_fc_0)
    assert.equal(
      upstreamRequestBody.input[18].id,
      "ctc_e60e73b91d8baea7b1f1d138d2967e27"
    );

    // All 26 call_ids (13 tool calls, 13 outputs) from fixture are preserved exactly
    const wireCalls = upstreamRequestBody.input.filter(
      (i: any) => i.type === "custom_tool_call"
    );
    const wireOutputs = upstreamRequestBody.input.filter(
      (i: any) => i.type === "custom_tool_call_output"
    );
    assert.equal(wireCalls.length, 13);
    assert.equal(wireOutputs.length, 13);
    assert.deepEqual(
      wireCalls.map((i: any) => i.call_id),
      fixture.items
        .filter((i: any) => i.type === "custom_tool_call")
        .map((i: any) => i.call_id)
    );
    assert.deepEqual(
      wireOutputs.map((i: any) => i.call_id),
      fixture.items
        .filter((i: any) => i.type === "custom_tool_call_output")
        .map((i: any) => i.call_id)
    );

    // Reasoning items reaching upstream: 4 from fixture + 1 extra = 5 genuine encrypted ones
    const wireReasoning = upstreamRequestBody.input.filter(
      (i: any) => i.type === "reasoning"
    );
    assert.equal(wireReasoning.length, 5);
    for (const r of wireReasoning) {
      assert.match(r.id, /^rs_/);
      assert.ok(r.encrypted_content && r.encrypted_content.length > 0);
    }
  } finally {
    await closeServer(server);
    await new Promise((resolve) => upstream.close(resolve));
    globalThis.fetch = originalFetch;
    resetRouterTelemetry();
  }
});

test("research roles request website tools without a provider routing capability gate", () => {
  for (const role of ["docs-researcher", "smart", "orchestrator"]) {
    const requirements = roleCapabilityRequirements(role);
    assert.deepEqual(
      requirements.webResearch.search,
      true,
      `${role} search requirement`
    );
    assert.deepEqual(
      requirements.webResearch.fetch,
      true,
      `${role} fetch requirement`
    );
  }
  for (const provider of [
    "codex",
    "claude",
    "antigravity",
    "copilot",
    "minimax"
  ]) {
    assert.equal(
      "webResearch" in providerCapabilities(provider),
      false,
      `${provider} must not gate web research through routing metadata`
    );
  }
});

test("orchestrator role contract does not require playwright", () => {
  const requirements = roleCapabilityRequirements("orchestrator");
  assert.ok(
    !requirements.mcp.has("playwright"),
    "orchestrator must not require playwright"
  );
  assert.equal(requirements.webResearch.search, true);
  assert.equal(requirements.webResearch.fetch, true);
});

test("contract rendering fails when a research role is missing webResearch or has invalid configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "render-contract-neg-"));
  try {
    const rolesDir = join(directory, "agents");
    await mkdir(rolesDir, { recursive: true });
    const srcDir = new URL("../../agents/roles", import.meta.url).pathname;
    const { readdirSync, copyFileSync } = await import("node:fs");
    for (const file of readdirSync(srcDir)) {
      if (file.endsWith(".toml")) {
        copyFileSync(join(srcDir, file), join(rolesDir, file));
      }
    }
    await writeFile(
      join(rolesDir, "docs-researcher.toml"),
      `
name = "docs-researcher"
sandbox_mode = "read-only"
[mcp_servers.openaiDeveloperDocs]
enabled = true
url = "https://developers.openai.com/mcp"
transport = "streamable_http"
`
    );

    const renderer = new URL(
      "../../src/config/render-execution-contract.ts",
      import.meta.url
    ).pathname;
    const rootConfig = new URL(
      "../../config/config.autodev.toml",
      import.meta.url
    ).pathname;
    const contractPath = new URL(
      "../../config/execution-contract.json",
      import.meta.url
    ).pathname;
    const outputPath = join(directory, "output.json");

    const child = spawn(
      process.execPath,
      [
        renderer,
        "--source-dir",
        rolesDir,
        "--root-config",
        rootConfig,
        "--contract",
        contractPath,
        "--output",
        outputPath
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.notEqual(
      code,
      0,
      "contract rendering should fail when docs-researcher lacks webResearch"
    );
    assert.match(stderr, /role 'docs-researcher' must declare webResearch/);

    // Also verify an invalid native tools declaration fails.
    await writeFile(
      join(rolesDir, "docs-researcher.toml"),
      `
name = "docs-researcher"
sandbox_mode = "read-only"
[tools]
web_search = "invalid-not-bool"
[mcp_servers.openaiDeveloperDocs]
enabled = true
url = "https://developers.openai.com/mcp"
transport = "streamable_http"
`
    );
    const child2 = spawn(
      process.execPath,
      [
        renderer,
        "--source-dir",
        rolesDir,
        "--root-config",
        rootConfig,
        "--contract",
        contractPath,
        "--output",
        outputPath
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr2 = "";
    child2.stderr.on("data", (chunk) => {
      stderr2 += chunk;
    });
    const code2 = await new Promise((resolve) => child2.on("close", resolve));
    assert.notEqual(
      code2,
      0,
      "contract rendering should fail when web_search has an invalid type"
    );
    assert.match(stderr2, /tools\.web_search must be boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("router status includes sanitized routing and limits metadata", () => {
  routing.resetDisabledProvidersForRole("subagent");
  routing.resetDisabledProvidersForRole("orchestrator");
  const status = getRouterStatus();

  // Status shape for routing metadata
  assert.ok(status.routing, "status must contain routing metadata");
  assert.ok(
    ["default_codex_home", "env_override"].includes(status.routing.configSource)
  );
  assert.equal(typeof status.routing.configFileExists, "boolean");
  assert.equal(typeof status.routing.orchestrator, "object");
  assert.equal(status.routing.orchestrator.alias, "autodev/orchestrator");
  assert.equal(typeof status.routing.orchestrator.tier, "string");
  assert.equal(typeof status.routing.roles, "object");
  assert.equal(typeof status.routing.providerGroups, "object");
  assert.ok(Array.isArray(status.routing.configuredProviders));
  assert.ok(status.routing.configuredProviders.includes("claude"));
  assert.ok(status.routing.configuredProviders.includes("codex"));
  assert.ok(Array.isArray(status.routing.enabledSubagentProviders));
  assert.ok(Array.isArray(status.routing.disabledSubagentProviders));
  assert.equal(typeof status.routing.routes, "object");
  for (const [_provider, route] of Object.entries(status.routing.routes) as [
    string,
    any
  ][]) {
    assert.equal(typeof route.pattern, "string");
    assert.equal(typeof route.baseUrl, "string");
    assert.equal(typeof route.credentialConfigured, "boolean");
  }

  // Status shape for limits metadata
  assert.ok(status.limits, "status must contain limits metadata");
  assert.equal(typeof status.limits.providerCooldownMs, "number");
  assert.equal(typeof status.limits.providerCooldownMaxMs, "number");
  assert.equal(typeof status.limits.hardCooldownMs, "number");
  assert.equal(typeof status.limits.hardCooldownMaxMs, "number");
  assert.equal(typeof status.limits.probeCooldownMs, "number");
  assert.equal(typeof status.limits.probeCooldownMaxMs, "number");
  assert.equal(typeof status.limits.probeTimeoutMs, "number");
  assert.equal(typeof status.limits.lastResortMaxAttempts, "number");
  assert.equal(typeof status.limits.exhaustionWaitMs, "number");
  assert.equal(typeof status.limits.chainSelectionDeadlineMs, "number");
  assert.equal(typeof status.limits.upstreamTimeoutMs, "number");
  assert.equal(typeof status.limits.concreteRetryBaseMs, "number");
  assert.equal(typeof status.limits.concreteRetryMaxMs, "number");
  assert.equal(typeof status.limits.concreteStatusMaxAttempts, "number");
  assert.equal(typeof status.limits.concreteTransportMaxAttempts, "number");
  assert.equal(typeof status.limits.shutdownDrainTimeoutMs, "number");
  assert.equal(typeof status.limits.maxConcurrentThreadsPerSession, "number");

  // Per-provider enabled property and status
  assert.ok(status.providers, "status must contain providers");
  for (const provider of Object.values(status.providers) as any[]) {
    assert.equal(typeof provider.orchestratorEnabled, "boolean");
    assert.equal(typeof provider.subagentEnabled, "boolean");
    assert.equal(provider.orchestratorEnabled, true);
    assert.equal(provider.subagentEnabled, true);
    assert.equal(provider.status, "ready");
  }

  // Verify sanitized: no absolute paths or secret tokens leaked
  assertNoLeakedPaths(status.routing);
  assertNoLeakedPaths(status.limits);
});

test("loopback-only POST /v1/providers/:provider endpoint validation and state persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-provider-routing-"));
  const stateFile = join(directory, "codex-router-state.json");
  const previousStateFile = process.env.CODEX_ROUTER_STATE_FILE;
  process.env.CODEX_ROUTER_STATE_FILE = stateFile;

  const originalFetch = globalThis.fetch;
  const server = createServer((request, response) => {
    if (request.headers["x-test-remote-ip"]) {
      Object.defineProperty(request.socket, "remoteAddress", {
        value: request.headers["x-test-remote-ip"],
        configurable: true
      });
    }
    void handle(request, response);
  });
  await listenServer(server);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    resetRouterTelemetry();
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");

    // 1. Non-loopback request is rejected with 403
    const nonLoopbackRes = await originalFetch(
      `${baseUrl}/v1/providers/claude`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-remote-ip": "192.168.1.55"
        },
        body: JSON.stringify({ role: "subagent", enabled: false })
      }
    );
    assert.equal(nonLoopbackRes.status, 403);
    const nonLoopbackJson = await nonLoopbackRes.json();
    assert.equal(nonLoopbackJson.error?.code, "router_access_denied");

    // Helper check
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("192.168.1.1"), false);
    assert.equal(isLoopbackAddress("10.0.0.1"), false);
    assert.equal(isLoopbackAddress(null), false);

    // 2. Invalid method (e.g. GET) is rejected with 405
    const getRes = await originalFetch(`${baseUrl}/v1/providers/claude`, {
      method: "GET"
    });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get("allow"), "POST");

    // 3. Unknown provider is rejected with 404
    const unknownRes = await originalFetch(
      `${baseUrl}/v1/providers/unknown_provider_xyz`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "subagent", enabled: false })
      }
    );
    assert.equal(unknownRes.status, 404);
    const unknownJson = await unknownRes.json();
    assert.equal(unknownJson.error?.code, "router_unknown_provider");

    // 4. Invalid body (not valid JSON) is rejected with 400
    const malformedRes = await originalFetch(`${baseUrl}/v1/providers/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{"
    });
    assert.equal(malformedRes.status, 400);

    // 5. Missing / non-boolean enabled is rejected with 400
    const invalidPayloadRes1 = await originalFetch(
      `${baseUrl}/v1/providers/claude`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "subagent", enabled: "false" })
      }
    );
    assert.equal(invalidPayloadRes1.status, 400);

    const invalidPayloadRes2 = await originalFetch(
      `${baseUrl}/v1/providers/claude`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "invalid", enabled: false })
      }
    );
    assert.equal(invalidPayloadRes2.status, 400);
    assert.equal(
      (await invalidPayloadRes2.clone().json()).error?.code,
      "router_invalid_role"
    );

    // 6. Disable provider for subagents successfully
    const disableRes = await originalFetch(`${baseUrl}/v1/providers/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "subagent", enabled: false })
    });
    assert.equal(disableRes.status, 200);
    const disableJson = await disableRes.json();
    assert.equal(disableJson.ok, true);
    assert.equal(disableJson.provider, "claude");
    assert.equal(disableJson.enabled, false);
    assert.equal(disableJson.status, "disabled");

    // In-memory status is updated
    assert.equal(routing.isProviderEnabledForRole("claude", "subagent"), false);
    const statusAfterDisable = getRouterStatus();
    assert.equal(statusAfterDisable.providers.claude.subagentEnabled, false);
    assert.equal(
      statusAfterDisable.providers.claude.subagentStatus,
      "disabled"
    );
    assert.ok(
      statusAfterDisable.routing.disabledSubagentProviders.includes("claude")
    );
    assert.equal(
      statusAfterDisable.routing.enabledSubagentProviders.includes("claude"),
      false
    );

    const orchestratorDisableRes = await originalFetch(
      `${baseUrl}/v1/providers/claude`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "orchestrator", enabled: false })
      }
    );
    assert.equal(orchestratorDisableRes.status, 200);
    const orchestratorDisableJson = await orchestratorDisableRes.json();
    assert.equal(orchestratorDisableJson.role, "orchestrator");
    assert.equal(orchestratorDisableJson.enabled, false);
    const statusAfterBothDisabled = getRouterStatus();
    assert.equal(
      statusAfterBothDisabled.providers.claude.orchestratorEnabled,
      false
    );
    assert.equal(
      statusAfterBothDisabled.providers.claude.subagentEnabled,
      false
    );
    assert.ok(
      statusAfterBothDisabled.routing.disabledOrchestratorProviders.includes(
        "claude"
      )
    );
    assert.ok(
      statusAfterBothDisabled.routing.disabledSubagentProviders.includes(
        "claude"
      )
    );

    // Persistence: verify both role states are written and loadable
    assert.equal(existsSync(stateFile), true);
    const savedState = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(savedState.disabledOrchestratorProviders, ["claude"]);
    assert.deepEqual(savedState.disabledSubagentProviders, ["claude"]);

    // Reset memory and restore from file
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");
    assert.equal(routing.isProviderEnabledForRole("claude", "subagent"), true);
    assert.equal(
      routing.isProviderEnabledForRole("claude", "orchestrator"),
      true
    );
    assert.equal(loadRouterState(stateFile), true);
    assert.equal(routing.isProviderEnabledForRole("claude", "subagent"), false);
    assert.equal(
      routing.isProviderEnabledForRole("claude", "orchestrator"),
      false
    );

    // 7. Re-enable provider successfully
    const enableRes = await originalFetch(`${baseUrl}/v1/providers/claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "subagent", enabled: true })
    });
    assert.equal(enableRes.status, 200);
    const enableJson = await enableRes.json();
    assert.equal(enableJson.ok, true);
    assert.equal(enableJson.provider, "claude");
    assert.equal(enableJson.role, "subagent");
    assert.equal(enableJson.enabled, true);
    assert.equal(enableJson.status, "ready");

    assert.equal(routing.isProviderEnabledForRole("claude", "subagent"), true);
    const orchestratorEnableRes = await originalFetch(
      `${baseUrl}/v1/providers/claude`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "orchestrator", enabled: true })
      }
    );
    assert.equal(orchestratorEnableRes.status, 200);
    const statusAfterEnable = getRouterStatus();
    assert.equal(statusAfterEnable.providers.claude.subagentEnabled, true);
    assert.equal(statusAfterEnable.providers.claude.subagentStatus, "ready");
    assert.equal(
      statusAfterEnable.routing.disabledSubagentProviders.includes("claude"),
      false
    );
  } finally {
    await closeServer(server);
    if (previousStateFile === undefined)
      delete process.env.CODEX_ROUTER_STATE_FILE;
    else process.env.CODEX_ROUTER_STATE_FILE = previousStateFile;
    await rm(directory, { recursive: true, force: true });
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");
    resetRouterTelemetry();
  }
});

test("disabled providers are excluded across role aliases, orchestrator, and fallback chains", async () => {
  resetRouterTelemetry();
  routing.resetDisabledProvidersForRole("subagent");
  routing.resetDisabledProvidersForRole("orchestrator");

  // Baseline: all enabled
  const baselineCandidates = routing.roleCandidates("default", () => 0.5);
  assert.ok(baselineCandidates.some((c) => c.provider === "claude"));

  // 1. Role aliases exclude disabled provider
  routing.setProviderEnabledForRole("claude", "subagent", false);
  const filteredCandidates = routing.roleCandidates("default", () => 0.5);
  assert.equal(
    filteredCandidates.some((c) => c.provider === "claude"),
    false,
    "disabled provider must be excluded from role candidates"
  );
  assert.ok(filteredCandidates.length > 0);

  // 2. Orchestrator excludes disabled provider
  const baselineOrch = routing.orchestratorCandidates(() => 0.5);
  assert.equal(baselineOrch[0]!.provider, "codex");

  routing.setProviderEnabledForRole("codex", "orchestrator", false);
  const filteredOrch = routing.orchestratorCandidates(() => 0.5);
  assert.equal(
    filteredOrch.some((c) => c.provider === "codex"),
    false,
    "disabled provider must be excluded from orchestrator candidates"
  );

  // Continuation preferred provider is not hoisted if disabled
  const preferredOrch = routing.orchestratorCandidates(() => 0.5, "codex");
  assert.equal(
    preferredOrch.some((c) => c.provider === "codex"),
    false,
    "disabled preferred provider must not be hoisted"
  );

  // 3. Fallback request skips disabled provider
  const originalFetch = globalThis.fetch;
  const originalCredentials = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
  };
  process.env.LITELLM_API_KEY = "test-key";
  process.env.MINIMAX_API_KEY = "test-key";

  const attemptedProviders: string[] = [];
  globalThis.fetch = async (url: any, _options: any = {}) => {
    const target = String(url);
    if (target.includes("/health")) return new Response("ok", { status: 200 });
    let provider = null;
    if (target.includes(":4000/")) provider = "claude";
    else if (target.includes(":4002/")) provider = "antigravity";
    else if (target.includes(":18765/")) provider = "minimax";
    if (provider) attemptedProviders.push(provider);

    // Claude is disabled, so it should not even be called.
    // First attempted candidate returns 503 so fallback triggers.
    if (attemptedProviders.length === 1) {
      return Response.json(
        { error: "provider unavailable" },
        {
          status: 503
        }
      );
    }
    // Second attempted candidate succeeds
    return Response.json(
      {
        id: "resp-ok",
        model: "model-ok",
        output_text: "success"
      },
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  const port = (server.address() as AddressInfo).port;

  try {
    // claude is disabled, first candidate fails, second should succeed via fallback
    const response = await originalFetch(
      `http://127.0.0.1:${port}/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "fallback-disabled-test"
        },
        body: JSON.stringify({ model: "autodev/default", stream: false })
      }
    );

    assert.equal(response.status, 200);
    assert.equal(
      attemptedProviders.includes("claude"),
      false,
      "claude was disabled and must not have been attempted"
    );
    assert.equal(
      attemptedProviders.length,
      2,
      "fallback should attempt the first candidate, fail, then try and succeed with the second"
    );
    assert.ok(
      attemptedProviders.includes("antigravity") &&
      attemptedProviders.includes("minimax")
    );

    // 4. Direct concrete request to disabled provider is rejected with 503
    const directRes = await originalFetch(
      `http://127.0.0.1:${port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sonnet", stream: false })
      }
    );
    assert.equal(directRes.status, 503);
    const directJson = await directRes.json();
    assert.equal(directJson.error?.code, "router_provider_unavailable");
    assert.equal(directJson.error?.failureClass, "provider_disabled");
    assert.equal(directJson.error?.provider, "claude");
    assert.equal(directRes.headers.get("x-autodev-provider"), "claude");
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRouterTelemetry();
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");
  }
});

test("all-disabled behavior rejects aliases, orchestrator, and concrete requests", async () => {
  resetRouterTelemetry();
  routing.resetDisabledProvidersForRole("subagent");
  routing.resetDisabledProvidersForRole("orchestrator");
  const allProviders = ["claude", "antigravity", "minimax", "copilot", "codex"];
  for (const provider of allProviders) {
    routing.setProviderEnabledForRole(provider, "subagent", false);
    routing.setProviderEnabledForRole(provider, "orchestrator", false);
  }

  const status = getRouterStatus();
  assert.equal(status.routing.enabledSubagentProviders.length, 0);
  assert.deepEqual(
    status.routing.disabledSubagentProviders,
    allProviders.sort()
  );
  for (const p of Object.values(status.providers) as any[]) {
    assert.equal(p.orchestratorEnabled, false);
    assert.equal(p.subagentEnabled, false);
    assert.equal(p.orchestratorStatus, "disabled");
    assert.equal(p.subagentStatus, "disabled");
  }

  // Candidate lists are empty
  assert.deepEqual(routing.roleCandidates("default"), []);
  assert.deepEqual(routing.roleCandidates("smart"), []);
  assert.deepEqual(routing.orchestratorCandidates(), []);

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Role alias returns 503 provider exhausted
    const roleRes = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "autodev/default", stream: false })
    });
    assert.equal(roleRes.status, 503);
    const roleJson = await roleRes.json();
    assert.equal(roleJson.error?.code, "router_provider_exhausted");
    assert.equal(roleJson.error?.failureClass, "provider_disabled");

    // 2. Orchestrator alias returns 503 provider exhausted
    const orchRes = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "autodev/orchestrator", stream: false })
    });
    assert.equal(orchRes.status, 503);
    const orchJson = await orchRes.json();
    assert.equal(orchJson.error?.code, "router_provider_exhausted");
    assert.equal(orchJson.error?.failureClass, "provider_disabled");

    // 3. Direct concrete request returns 503 provider unavailable
    const concreteRes = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CONFIGURED_ORCHESTRATOR_MODEL, stream: false })
    });
    assert.equal(concreteRes.status, 503);
    const concreteJson = await concreteRes.json();
    assert.equal(concreteJson.error?.code, "router_provider_unavailable");
    assert.equal(concreteJson.error?.failureClass, "provider_disabled");
    assert.equal(concreteJson.error?.provider, "codex");
  } finally {
    await closeServer(server);
    routing.resetDisabledProvidersForRole("subagent");
    routing.resetDisabledProvidersForRole("orchestrator");
    resetRouterTelemetry();
  }
});

// --- Agent activity: shared state machine (src/agents/agent-activity.ts) ---

test("agent activity: TTL resolves from CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS with a 300000ms default", () => {
  assert.equal(resolveAgentActivityTtlMs({}), DEFAULT_AGENT_ACTIVITY_TTL_MS);
  assert.equal(DEFAULT_AGENT_ACTIVITY_TTL_MS, 300_000);
  assert.equal(
    resolveAgentActivityTtlMs({ [AGENT_ACTIVITY_TTL_ENV]: "45000" }),
    45_000
  );
  // Invalid/non-positive overrides fall back to the default rather than
  // producing a tracker with a zero or NaN TTL.
  assert.equal(
    resolveAgentActivityTtlMs({ [AGENT_ACTIVITY_TTL_ENV]: "not-a-number" }),
    DEFAULT_AGENT_ACTIVITY_TTL_MS
  );
  assert.equal(
    resolveAgentActivityTtlMs({ [AGENT_ACTIVITY_TTL_ENV]: "0" }),
    DEFAULT_AGENT_ACTIVITY_TTL_MS
  );
  assert.equal(
    resolveAgentActivityTtlMs({ [AGENT_ACTIVITY_TTL_ENV]: "-1" }),
    DEFAULT_AGENT_ACTIVITY_TTL_MS
  );
  assert.equal(AGENT_ACTIVITY_TTL_MS, resolveAgentActivityTtlMs(process.env));
});

test("agent activity: a response with a tool call opens tool_wait, spanning the gap until the continuation", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("session-a", {
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5",
    role: null
  });
  assert.equal(tracker.getState("session-a"), "active");
  tracker.endRequest("session-a", {
    requestId: "req-1",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(tracker.getState("session-a"), "tool_wait");
  assert.equal(tracker.countLive({ provider: "codex" }), 1);
  // A normal response with no tool call is terminal; explicit user waits arrive
  // through lifecycle events.
  const tracker2 = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker2.beginRequest("session-b", {
    requestId: "req-2",
    provider: "codex",
    model: "gpt-5"
  });
  tracker2.endRequest("session-b", {
    requestId: "req-2",
    outcome: "success",
    hasToolCalls: false
  });
  assert.equal(tracker2.getState("session-b"), "finished");
});

test("agent activity: a continuation after a wait is observed as resumed", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("session-a", {
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.endRequest("session-a", {
    requestId: "req-1",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(tracker.getState("session-a"), "tool_wait");
  // The continuation carries the tool result on a new requestId, against the
  // same session subject the router resolves for both requests.
  const record = tracker.beginRequest("session-a", {
    requestId: "req-2",
    provider: "codex",
    model: "gpt-5"
  });
  assert.equal(record.state, "resumed");
  assert.equal(tracker.getState("session-a"), "resumed");
  assert.equal(tracker.countLive({}), 1, "a resumed subject is still live");
  // A begin with no prior wait (fresh subject) is "active", not "resumed".
  const fresh = tracker.beginRequest("session-c", {
    requestId: "req-3",
    provider: "codex",
    model: "gpt-5"
  });
  assert.equal(fresh.state, "active");
});

test("agent activity: user_wait and subagent_wait are both reachable and distinguishable", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("orchestrator-session", {
    requestId: "req-1",
    provider: "claude",
    model: "sonnet"
  });
  // Explicit lifecycle signal enters user_wait; a normal final response does not.
  tracker.applyLifecycleEvent("orchestrator-session", {
    state: "user_wait",
    eventId: "user-wait-1"
  });
  assert.equal(tracker.getState("orchestrator-session"), "user_wait");
  // The orchestrator spawns a subagent: it is now waiting on the child.
  tracker.noteSubagentWait("orchestrator-session");
  assert.equal(tracker.getState("orchestrator-session"), "subagent_wait");
  // Re-applying while already waiting is a no-op (idempotent).
  tracker.noteSubagentWait("orchestrator-session");
  assert.equal(tracker.getState("orchestrator-session"), "subagent_wait");
  // Resolving when not in subagent_wait is a no-op.
  const untouched = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  untouched.beginRequest("s", {
    requestId: "r",
    provider: "codex",
    model: "m"
  });
  const noop = untouched.noteSubagentResolved("s");
  assert.equal(noop.state, "active");
  // The child reports back: the parent resumes.
  const resolved = tracker.noteSubagentResolved("orchestrator-session");
  assert.equal(resolved.state, "resumed");
});

test("agent activity: a matured wait state expires to stale under a fake clock, honoring the TTL", () => {
  let clock = 0;
  const tracker = createAgentActivityTracker({ ttlMs: 5000, now: () => clock });
  tracker.beginRequest("session-a", {
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.endRequest("session-a", {
    requestId: "req-1",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(tracker.getState("session-a"), "tool_wait");
  assert.equal(tracker.countLive({}), 1);
  clock += 4999;
  assert.equal(
    tracker.getState("session-a"),
    "tool_wait",
    "not yet past the TTL"
  );
  assert.equal(tracker.countLive({}), 1);
  clock += 2; // now 5001ms since the wait state was entered, past the 5000ms TTL
  assert.equal(tracker.getState("session-a"), "stale");
  assert.equal(tracker.countLive({}), 0, "a stale record is not live");
  assert.equal(tracker.countByState({}).stale, 1);
  // A terminal record never goes stale, no matter how old it is.
  const terminal = createAgentActivityTracker({ ttlMs: 10, now: () => clock });
  terminal.beginRequest("s2", {
    requestId: "r",
    provider: "codex",
    model: "m"
  });
  terminal.endRequest("s2", { requestId: "r", outcome: "failure" });
  clock += 100_000;
  assert.equal(terminal.getState("s2"), "failed");
});

test("agent activity: duplicate terminal events are idempotent while later turns reopen the session", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("session-a", {
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.endRequest("session-a", { requestId: "req-1", outcome: "failure" });
  assert.equal(tracker.getState("session-a"), "failed");
  // Redelivering the same result (same requestId) is a no-op.
  tracker.endRequest("session-a", {
    requestId: "req-1",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(
    tracker.getState("session-a"),
    "failed",
    "a settled requestId cannot flip a terminal record"
  );
  // A different requestId is a new turn for the same identified session.
  const afterBegin = tracker.beginRequest("session-a", {
    requestId: "req-2",
    provider: "codex",
    model: "gpt-5"
  });
  assert.equal(afterBegin.state, "active");
  assert.equal(tracker.countLive({}), 1);

  // The same guarantee holds for explicit lifecycle events: a duplicated
  // "finished" (matched by eventId) does not double-apply, and a "failed"
  // delivered after "finished" does not overwrite it.
  const tracker2 = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker2.beginRequest("session-b", {
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5"
  });
  const first = tracker2.applyLifecycleEvent("session-b", {
    state: "finished",
    eventId: "evt-1"
  });
  assert.equal(first.state, "finished");
  const redelivered = tracker2.applyLifecycleEvent("session-b", {
    state: "finished",
    eventId: "evt-1"
  });
  assert.equal(redelivered.state, "finished");
  const contradicting = tracker2.applyLifecycleEvent("session-b", {
    state: "failed",
    eventId: "evt-2"
  });
  assert.equal(
    contradicting.state,
    "finished",
    "a terminal record is never reopened by a later lifecycle event"
  );
  // An unrecognized state is rejected rather than silently ignored.
  assert.equal(
    tracker2.applyLifecycleEvent("session-c", { state: "not_a_real_state" }),
    null
  );
});

test("agent activity: counts are always nonnegative, including under out-of-order and unmatched events", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  // endRequest / finish / noteSubagentResolved with no prior beginRequest are no-ops, not underflows.
  assert.equal(
    tracker.endRequest("ghost", { requestId: "r", outcome: "failure" }),
    null
  );
  assert.equal(tracker.finish("ghost", { requestId: "r" }), null);
  assert.equal(tracker.noteSubagentResolved("ghost"), null);
  assert.equal(tracker.countLive({}), 0);
  assert.equal(tracker.countByState({}).active, 0);

  // A burst of begins and ends across several subjects, some unmatched, never
  // produces a negative count for any state.
  for (let i = 0; i < 5; i += 1) {
    tracker.beginRequest(`s${i}`, {
      requestId: `r${i}`,
      provider: "codex",
      model: "m"
    });
  }
  for (let i = 0; i < 3; i += 1) {
    tracker.endRequest(`s${i}`, {
      requestId: `r${i}`,
      outcome: "success",
      hasToolCalls: i % 2 === 0
    });
  }
  // Extra, unmatched ends for subjects that were never begun.
  tracker.endRequest("never-began-1", { requestId: "x", outcome: "success" });
  tracker.endRequest("never-began-2", { requestId: "y", outcome: "failure" });
  const counts = tracker.countByState({});
  for (const state of AGENT_ACTIVITY_STATES) {
    assert.ok(counts[state] >= 0, `count for ${state} must never be negative`);
  }
  assert.ok(tracker.countLive({}) >= 0);
  assert.ok(tracker.distinctTags({}).length >= 0);
});

test("agent activity: snapshot groups live activity by provider and by provider/model", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("s1", {
    requestId: "r1",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.beginRequest("s2", {
    requestId: "r2",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.beginRequest("s3", {
    requestId: "r3",
    provider: "claude",
    model: "sonnet"
  });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.live, 3);
  assert.equal(snapshot.byProvider.codex.active, 2);
  assert.equal(snapshot.byProvider.claude.active, 1);
  assert.equal(snapshot.byModel["codex/gpt-5"].active, 2);
  assert.equal(snapshot.byModel["claude/sonnet"].active, 1);
  assert.equal(snapshot.ttlMs, 60_000);
});

test("agent activity: kind/tag scoping isolates a concurrency-style count from an unrelated dimension", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  tracker.beginRequest("slot:sess-a:1", {
    requestId: "slot:sess-a:1",
    kind: "subagent_slot",
    tag: "sess-a"
  });
  tracker.beginRequest("slot:sess-a:2", {
    requestId: "slot:sess-a:2",
    kind: "subagent_slot",
    tag: "sess-a"
  });
  tracker.beginRequest("slot:sess-b:1", {
    requestId: "slot:sess-b:1",
    kind: "subagent_slot",
    tag: "sess-b"
  });
  tracker.beginRequest("sess-a", {
    requestId: "r",
    provider: "codex",
    model: "m"
  }); // kind "session", unrelated
  assert.equal(tracker.countLive({ kind: "subagent_slot" }), 3);
  assert.equal(tracker.countLive({ kind: "subagent_slot", tag: "sess-a" }), 2);
  assert.equal(tracker.countLive({ kind: "subagent_slot", tag: "sess-b" }), 1);
  assert.deepEqual(tracker.distinctTags({ kind: "subagent_slot" }).sort(), [
    "sess-a",
    "sess-b"
  ]);
  assert.equal(tracker.countLive({ kind: "session" }), 1);
});

// --- Agent activity wired into the router: usage/provider live activity, ---
// --- concurrency subagent slots, inFlightRequests, and lifecycle events.  ---

test("router status exposes inFlightRequests (transport counters) with no activeRequests alias at the top level", () => {
  resetRouterTelemetry();
  const status = getRouterStatus();
  assert.equal(typeof status.inFlightRequests, "object");
  assert.equal(
    status.activeRequests,
    undefined,
    "the top-level transport counter map has no compatibility alias"
  );
  assert.equal(typeof status.liveActivity, "number");
  assert.ok(status.liveActivity >= 0);
  for (const provider of Object.values(status.providers) as any[]) {
    // Per-provider entries expose live activity and a separate transport count.
    assert.equal(typeof provider.active, "number");
    assert.equal(typeof provider.inFlightRequests, "number");
    assert.ok(provider.active >= 0);
  }
});

test("router usage status carries a live-activity snapshot distinct from each bucket's request-scoped active count", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  const status = usageStatus();
  assert.ok(status.activity, "usage.activity must be present");
  assert.equal(status.activity.ttlMs, AGENT_ACTIVITY_TTL_MS);
  assert.equal(status.activity.live, 0);
  assert.deepEqual(
    Object.keys(status.activity.byState).sort(),
    [...AGENT_ACTIVITY_STATES].sort()
  );
  agentActivity.beginRequest("some-session", {
    requestId: "req-1",
    provider: "claude",
    model: "sonnet"
  });
  const withActivity = usageStatus();
  assert.equal(withActivity.activity.live, 1);
  assert.equal(withActivity.activity.byProvider.claude.active, 1);
  assert.equal(withActivity.activity.byModel["claude/sonnet"].active, 1);
  agentActivity.reset();
});

test("router concurrency status derives active subagent slots from agent activity, matching the admission counter exactly", async () => {
  resetRouterTelemetry();
  const configuredLimit = concurrencyStatus().effectivePerSessionLimit ?? 4;
  assert.equal(agentActivity.countLive({ kind: "subagent_slot" }), 0);
  const slotsToAcquire = Math.max(1, Math.min(2, configuredLimit));
  for (let i = 0; i < slotsToAcquire; i += 1) {
    assert.equal(tryAcquireSubagentSlot("activity-concurrency-session"), null);
  }
  assert.equal(concurrencyStatus().activeSubagentThreads, slotsToAcquire);
  assert.equal(
    agentActivity.countLive({ kind: "subagent_slot" }),
    slotsToAcquire,
    "concurrency's admission count and agent-activity's live count must agree"
  );
  assert.equal(
    agentActivity.countLive({
      kind: "subagent_slot",
      tag: "activity-concurrency-session"
    }),
    slotsToAcquire
  );
  for (let i = 0; i < slotsToAcquire; i += 1)
    releaseSubagentSlot("activity-concurrency-session");
  assert.equal(concurrencyStatus().activeSubagentThreads, 0);
  assert.equal(agentActivity.countLive({ kind: "subagent_slot" }), 0);
  resetConcurrencyTelemetry();
});

test("router-visible response tool calls and continuations drive session activity through a full round trip", async () => {
  resetRouterTelemetry();
  agentActivity.reset();
  const originalFetch = globalThis.fetch;
  const originalCredentials = { LITELLM_API_KEY: process.env.LITELLM_API_KEY };
  process.env.LITELLM_API_KEY = "test-key";
  let callCount = 0;
  globalThis.fetch = async (url: any, options: any = {}) => {
    const target = String(url);
    if (target.includes("/health")) return new Response("ok", { status: 200 });
    if (target.includes("/responses")) {
      callCount += 1;
      if (callCount === 1) {
        // First turn: the provider asks for a tool call.
        return Response.json(
          {
            id: "resp-1",
            model: "model-ok",
            output: [
              {
                id: "call-1",
                type: "function_call",
                name: "some_tool",
                arguments: "{}"
              }
            ]
          },
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // Second turn (the continuation carrying the tool result): a plain answer.
      return Response.json(
        {
          id: "resp-2",
          model: "model-ok",
          output_text: "done"
        },
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    return originalFetch(url, options);
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await listenServer(server);
  const port = (server.address() as AddressInfo).port;
  const sessionHeader = { "x-codex-session-id": "activity-round-trip-session" };
  try {
    const first = await originalFetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sessionHeader },
      body: JSON.stringify({ model: "autodev/default", stream: false })
    });
    assert.equal(first.status, 200);
    assert.equal(
      agentActivity.getState("activity-round-trip-session"),
      "tool_wait",
      "a response carrying a tool call opens tool_wait"
    );

    const second = await originalFetch(
      `http://127.0.0.1:${port}/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...sessionHeader },
        body: JSON.stringify({
          model: "autodev/default",
          stream: false,
          input: [
            { type: "function_call_output", call_id: "call-1", output: "ok" }
          ]
        })
      }
    );
    assert.equal(second.status, 200);
    // The continuation's own begin is observable as "resumed" mid-flight, and
    // settles to finished once its (tool-call-free) response lands.
    assert.equal(
      agentActivity.getState("activity-round-trip-session"),
      "finished"
    );
  } finally {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalCredentials)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRouterTelemetry();
    agentActivity.reset();
  }
});

test("agent-events endpoint applies only bridge-only lifecycle facts, to the request's own agent", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  const requestId = "lifecycle-req-1";
  noteBridgeRequest(requestId, {
    activitySubject: "lifecycle-agent",
    provider: "antigravity",
    model: "flash",
    role: null,
    workspace: null,
    sessionKey: "lifecycle-session"
  });
  agentActivity.beginRequest("lifecycle-agent", {
    requestId,
    provider: "antigravity",
    model: "flash"
  });

  // A bridge's in-CLI delegation is the one lifecycle fact the router cannot see.
  const waiting = ingestAgentEvents({
    requestId,
    events: [{ type: "activity", state: "subagent_wait" }]
  });
  assert.equal(waiting.accepted, 1);
  assert.equal(agentActivity.getState("lifecycle-agent"), "subagent_wait");
  assert.equal(
    agentActivity.getState("lifecycle-session"),
    null,
    "the shared session key is never the subject"
  );

  const resumed = ingestAgentEvents({
    requestId,
    events: [{ type: "activity", state: "resumed" }]
  });
  assert.equal(resumed.accepted, 1);
  assert.equal(agentActivity.getState("lifecycle-agent"), "resumed");

  // States the router settles from the response itself are refused.
  const refused = ingestAgentEvents({
    requestId,
    events: [
      "tool_wait",
      "user_wait",
      "finished",
      "failed",
      "not_a_real_state"
    ].map((state) => ({ type: "activity", state }))
  });
  assert.equal(refused.rejected, 5);
  assert.equal(refused.accepted, 0);
  assert.equal(agentActivity.getState("lifecycle-agent"), "resumed");

  agentActivity.reset();
  resetRouterTelemetry();
});

test("agent activity: heartbeat touch keeps active, tool_wait, and subagent_wait records live past the original TTL", () => {
  let clock = 0;
  const tracker = createAgentActivityTracker({ ttlMs: 5000, now: () => clock });

  // 1. An active record kept alive via touch()
  // No request id models an active lifecycle span whose liveness is supplied
  // by explicit heartbeat touches rather than an open HTTP request.
  tracker.beginRequest("sess-active", { provider: "codex", model: "gpt-5" });
  assert.equal(tracker.getState("sess-active"), "active");

  // 2. A tool_wait record kept alive via touch()
  tracker.beginRequest("sess-tool", {
    requestId: "req-tool",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.endRequest("sess-tool", {
    requestId: "req-tool",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(tracker.getState("sess-tool"), "tool_wait");

  // 3. A subagent_wait record kept alive via touch()
  tracker.noteSubagentWait("sess-sub", { kind: "session" });
  assert.equal(tracker.getState("sess-sub"), "subagent_wait");

  // 4. A silent record that will receive no touches and expire to stale
  tracker.beginRequest("sess-silent", {
    requestId: "req-silent",
    provider: "codex",
    model: "gpt-5"
  });
  tracker.endRequest("sess-silent", {
    requestId: "req-silent",
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(tracker.getState("sess-silent"), "tool_wait");

  assert.equal(tracker.countLive({}), 4);

  // Advance time to 4000ms (within 5000ms TTL) and touch the first three
  clock = 4000;
  tracker.touch("sess-active");
  tracker.touch("sess-tool");
  tracker.touch("sess-sub");

  // Advance clock past the original 5000ms mark to 7000ms
  clock = 7000;

  // Touched records remain live and retain their exact state
  assert.equal(tracker.getState("sess-active"), "active");
  assert.equal(tracker.getState("sess-tool"), "tool_wait");
  assert.equal(tracker.getState("sess-sub"), "subagent_wait");

  // Silent record expired to stale, releasing its capacity
  assert.equal(tracker.getState("sess-silent"), "stale");
  assert.equal(tracker.countLive({}), 3);

  // Once a record goes silent and exceeds its touched TTL, it also goes stale
  clock = 9001; // 5001ms after clock=4000 touch
  assert.equal(tracker.getState("sess-active"), "stale");
  assert.equal(tracker.getState("sess-tool"), "stale");
  assert.equal(tracker.getState("sess-sub"), "stale");
  assert.equal(tracker.countLive({}), 0);
});

test("agent activity: a heartbeat cannot revive a record that already exceeded the TTL", () => {
  let clock = 0;
  const tracker = createAgentActivityTracker({ ttlMs: 5000, now: () => clock });
  tracker.beginRequest("silent", { requestId: "req-silent" });
  tracker.endRequest("silent", {
    requestId: "req-silent",
    outcome: "success",
    hasToolCalls: true
  });
  clock = 5001;

  // A delayed heartbeat must not resurrect abandoned work and leak a slot.
  assert.equal(tracker.touch("silent").state, "stale");
  assert.equal(tracker.getState("silent"), "stale");
  assert.equal(tracker.countLive({}), 0);
});

test("agent activity: subagent_slot records do not inflate liveActivity or snapshot totals", () => {
  const tracker = createAgentActivityTracker({
    ttlMs: 60_000,
    now: () => 1000
  });
  // One real agent working in one workspace
  tracker.beginRequest("agent-session", {
    requestId: "req-1",
    kind: "session",
    provider: "codex",
    model: "gpt-5",
    role: "worker",
    workspace: "AutoDev"
  });

  // Concurrency slots held for the session
  tracker.beginRequest("subagent_slot:agent-session:1", {
    requestId: "subagent_slot:agent-session:1",
    kind: "subagent_slot",
    tag: "agent-session"
  });
  tracker.beginRequest("subagent_slot:agent-session:2", {
    requestId: "subagent_slot:agent-session:2",
    kind: "subagent_slot",
    tag: "agent-session"
  });

  // Canonical live count must be exactly 1 (only the real agent, slots excluded)
  assert.equal(tracker.countLive({}), 1);

  // Snapshot totals and breakdowns must reflect exactly 1 agent
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.live, 1);
  assert.equal(snapshot.byRole.worker.active, 1);
  assert.equal(snapshot.byRole.unattributed, undefined);
  assert.equal(snapshot.byWorkspace.AutoDev.active, 1);

  // Concurrency queries with explicit kind filter still see the slot tickets
  assert.equal(tracker.countLive({ kind: "subagent_slot" }), 2);
  assert.equal(
    tracker.countLive({ kind: "subagent_slot", tag: "agent-session" }),
    2
  );
});

test("router: a live subagent is counted only when its activity is explicitly tracked", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // One subagent active in workspace AutoDev
  agentActivity.beginRequest("subagent-session", {
    requestId: "req-sub-1",
    kind: "session",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "AutoDev"
  });

  // Session acquires a subagent slot
  assert.equal(tryAcquireSubagentSlot("subagent-session"), null);

  const status = getRouterStatus();
  // The admission slot is excluded and no workspace-based parent is invented.
  assert.equal(status.liveActivity, 1);

  const usage = usageStatus();
  assert.equal(usage.totals.active, 1);
  assert.equal(usage.activity.byRole.worker.active, 1);
  assert.equal(usage.byRole.orchestrator.active, 0);
  // Workspace dimension still has 1 active agent working in it; it is not
  // added to the two-agent total.
  assert.equal(usage.activity.byWorkspace.AutoDev.active, 1);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("router: bridge heartbeat and tool observation events touch the request's agent without altering its state", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  const requestId = "req-bridge-heartbeat";
  noteBridgeRequest(requestId, {
    activitySubject: "thread:hb-child",
    provider: "claude",
    model: "sonnet",
    role: "worker",
    workspace: "AutoDev",
    sessionKey: "session-hb"
  });
  agentActivity.beginRequest("thread:hb-child", {
    requestId,
    provider: "claude",
    model: "sonnet",
    role: "worker",
    workspace: "AutoDev",
    tag: "session-hb"
  });
  assert.equal(tryAcquireSubagentSlot("session-hb"), null);
  agentActivity.endRequest("thread:hb-child", {
    requestId,
    outcome: "success",
    hasToolCalls: true
  });
  assert.equal(agentActivity.getState("thread:hb-child"), "tool_wait");

  const before = agentActivity.getRecord("thread:hb-child")!.updatedAt;
  const hbReport = ingestAgentEvents({
    requestId,
    events: [{ type: "activity", state: "heartbeat" }]
  });
  assert.equal(hbReport.accepted, 1);
  assert.equal(
    agentActivity.getState("thread:hb-child"),
    "tool_wait",
    "a heartbeat does not transition"
  );
  assert.ok(agentActivity.getRecord("thread:hb-child")!.updatedAt >= before);

  ingestAgentEvents({
    requestId,
    events: [
      { type: "tool_executed", tool: "read_file", callId: "c1", status: "ok" }
    ]
  });
  assert.equal(agentActivity.getState("thread:hb-child"), "tool_wait");
  assert.equal(
    agentActivity.getState("session-hb"),
    null,
    "no record is created under the shared session key"
  );

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: only explicitly tracked parent and children are counted", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // 1. Simulate prior settled orchestrator turn that created telemetry bucket in byRole.orchestrator
  agentActivity.beginRequest("parent-sess", {
    requestId: "req-p1",
    role: "orchestrator",
    origin: "orchestrator",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    workspace: "AutoDev"
  });
  agentActivity.endRequest("parent-sess", {
    requestId: "req-p1",
    hasToolCalls: false,
    outcome: "success"
  });

  // 2. Start two live subagents in workspace AutoDev
  agentActivity.beginRequest("sub-sess-1", {
    requestId: "req-c1",
    role: "worker",
    origin: "subagent",
    provider: "minimax",
    model: "MiniMax-M3",
    workspace: "AutoDev"
  });
  agentActivity.beginRequest("sub-sess-2", {
    requestId: "req-c2",
    role: "validator",
    origin: "subagent",
    provider: "claude",
    model: "sonnet",
    workspace: "AutoDev"
  });

  const status = getRouterStatus();
  // The settled parent is not reconstructed from workspace activity.
  assert.equal(status.liveActivity, 2);
  assert.equal(status.usage.totals.active, 2);

  assert.equal(status.usage.byRole.orchestrator.active, 0);
  assert.equal(status.usage.byRole.worker.active, 1);
  assert.equal(status.usage.byRole.validator.active, 1);

  // Total of byRole active equals canonical total
  const roleSum = Object.values(status.usage.byRole).reduce(
    (sum: number, b: any) => sum + Number(b?.active ?? 0),
    0
  );
  assert.equal(roleSum, 2);

  // Workspace total contains only the two explicitly tracked subagents.
  assert.equal(status.usage.byWorkspace.AutoDev.active, 2);
  assert.equal(status.usage.byWorkspace.AutoDev.byRole.orchestrator.active, 0);
  assert.equal(status.usage.byWorkspace.AutoDev.byRole.worker.active, 1);
  assert.equal(status.usage.byWorkspace.AutoDev.byRole.validator.active, 1);

  // Provider breakdown contains only concrete routed providers.
  assert.equal(status.usage.byWorkspace.AutoDev.byProvider.minimax.active, 1);
  assert.equal(status.usage.byWorkspace.AutoDev.byProvider.claude.active, 1);
  assert.equal(
    status.usage.byWorkspace.AutoDev.byProvider.unattributed,
    undefined
  );

  // Status providers contain only configured providers.
  assert.equal(status.providers.minimax.active, 1);
  assert.equal(status.providers.claude.active, 1);
  assert.equal(status.providers.codex.active, 0);
  assert.equal(status.providers.unattributed, undefined);
  const providerSum = Object.values(status.providers).reduce(
    (sum: number, p: any) => sum + Number(p.active ?? 0),
    0
  );
  assert.equal(providerSum, 2);

  // Activity snapshot breakdown
  assert.equal(status.usage.activity.live, 2);
  assert.equal(status.usage.activity.inferredOrchestrators, undefined);
  assert.equal(
    status.usage.activity.byRole.orchestrator?.subagent_wait ?? 0,
    0
  );
  assert.equal(status.usage.activity.byProvider.unattributed, undefined);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: multi-provider and multi-workspace reconciliation across all dimensions", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // Workspace A: 2 explicitly tracked subagents on different providers.
  agentActivity.beginRequest("sub-a1", {
    requestId: "req-a1",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "RepoAlpha"
  });
  agentActivity.beginRequest("sub-a2", {
    requestId: "req-a2",
    provider: "claude",
    model: "sonnet",
    role: "docs-researcher",
    origin: "subagent",
    workspace: "RepoAlpha"
  });

  // Workspace B: 1 live orchestrator on codex + 1 subagent on antigravity -> NO inferred orchestrator
  agentActivity.beginRequest("orch-b", {
    requestId: "req-b-orch",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    role: "orchestrator",
    origin: "orchestrator",
    workspace: "RepoBeta"
  });
  agentActivity.beginRequest("sub-b1", {
    requestId: "req-b1",
    provider: "antigravity",
    model: "gemini-3.8-flash",
    role: "explorer",
    origin: "subagent",
    workspace: "RepoBeta"
  });

  // Workspace C: 1 roleless direct turn on copilot -> NO inferred orchestrator
  agentActivity.beginRequest("direct-c", {
    requestId: "req-c-direct",
    provider: "copilot",
    model: "gpt-4o",
    role: null,
    origin: "direct",
    workspace: "RepoGamma"
  });

  // Total canonical count: RepoAlpha (2) + RepoBeta (1 orch + 1 sub = 2) + RepoGamma (1) = 5
  const status = getRouterStatus();
  assert.equal(status.liveActivity, 5);
  assert.equal(status.usage.totals.active, 5);

  // 1. Workspace dimension totals reconcile
  assert.equal(status.usage.byWorkspace.RepoAlpha.active, 2);
  assert.equal(status.usage.byWorkspace.RepoBeta.active, 2);
  assert.equal(status.usage.byWorkspace.RepoGamma.active, 1);
  const workspaceSum = Object.values(status.usage.byWorkspace).reduce(
    (s: number, b: any) => s + Number(b?.active ?? 0),
    0
  );
  assert.equal(workspaceSum, 5);

  // 2. Role dimension totals reconcile
  assert.equal(status.usage.byRole.worker.active, 1);
  assert.equal(status.usage.byRole["docs-researcher"].active, 1);
  assert.equal(status.usage.byRole.orchestrator.active, 1);
  assert.equal(status.usage.byRole.explorer.active, 1);
  assert.equal(status.usage.byRole.unattributed.active, 1); // roleless in Gamma
  const roleSum = Object.values(status.usage.byRole).reduce(
    (s: number, b: any) => s + Number(b?.active ?? 0),
    0
  );
  assert.equal(roleSum, 5);

  // 3. Origin dimension totals reconcile
  assert.equal(status.usage.byOrigin.subagent.active, 3);
  assert.equal(status.usage.byOrigin.orchestrator.active, 1);
  assert.equal(status.usage.byOrigin.direct.active, 1);
  const originSum = Object.values(status.usage.byOrigin).reduce(
    (s: number, b: any) => s + Number(b?.active ?? 0),
    0
  );
  assert.equal(originSum, 5);

  // 4. Status providers active counts reflect only verified attribution.
  assert.equal(status.providers.minimax.active, 1);
  assert.equal(status.providers.claude.active, 1);
  assert.equal(status.providers.codex.active, 1);
  assert.equal(status.providers.antigravity.active, 1);
  assert.equal(status.providers.copilot.active, 1);
  assert.equal(status.providers.unattributed, undefined);
  const providerSum = Object.values(status.providers).reduce(
    (s: number, p: any) => s + Number(p.active ?? 0),
    0
  );
  assert.equal(providerSum, 5);

  // 5. No provider residual is fabricated for the missing parent.
  assert.equal(status.usage.activity.byProvider.unattributed, undefined);

  // 6. Per-workspace internal consistency
  const alphaByRoleSum = Object.values(
    status.usage.byWorkspace.RepoAlpha.byRole
  ).reduce((s: number, b: any) => s + Number(b?.active ?? 0), 0);
  assert.equal(alphaByRoleSum, 2);
  const alphaByProviderSum = Object.values(
    status.usage.byWorkspace.RepoAlpha.byProvider
  ).reduce((s: number, b: any) => s + Number(b?.active ?? 0), 0);
  assert.equal(alphaByProviderSum, 2);

  const betaByRoleSum = Object.values(
    status.usage.byWorkspace.RepoBeta.byRole
  ).reduce((s: number, b: any) => s + Number(b?.active ?? 0), 0);
  assert.equal(betaByRoleSum, 2);
  const betaByProviderSum = Object.values(
    status.usage.byWorkspace.RepoBeta.byProvider
  ).reduce((s: number, b: any) => s + Number(b?.active ?? 0), 0);
  assert.equal(betaByProviderSum, 2);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: roleless activity reconciles to unattributed role while preserving verified provider/model", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  agentActivity.beginRequest("roleless-turn", {
    requestId: "req-roleless",
    provider: "claude",
    model: "sonnet",
    role: null,
    origin: "direct",
    workspace: "AutoDev"
  });

  const status = getRouterStatus();
  assert.equal(status.liveActivity, 1);
  assert.equal(status.usage.totals.active, 1);

  // Role dimension: roleless activity is explicitly categorized as unattributed
  assert.equal(status.usage.byRole.unattributed.active, 1);
  assert.equal(status.usage.byRole.orchestrator.active, 0);

  // Provider and model dimensions preserve verified attribution
  assert.equal(status.providers.claude.active, 1);
  assert.equal(status.usage.activity.byProvider.claude.active, 1);
  assert.equal(status.usage.byModel["claude/sonnet"].active, 1);
  assert.equal(status.usage.activity.byModel["claude/sonnet"].active, 1);

  // Workspace dimension
  assert.equal(status.usage.byWorkspace.AutoDev.active, 1);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: wait states keep explicitly tracked agents live, while stale/terminal states clear them", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  const now = 100_000;
  agentActivity.beginRequest("subagent-wait-sess", {
    requestId: "req-wait-1",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "AutoDev",
    timestamp: now
  });

  // Initially active: one explicitly tracked subagent.
  let status = getRouterStatus(now);
  assert.equal(status.liveActivity, 1);
  assert.equal(status.usage.totals.active, 1);

  // Settle request with tool wait (clears openRequestId so it can mature to stale past TTL)
  agentActivity.endRequest("subagent-wait-sess", {
    requestId: "req-wait-1",
    hasToolCalls: true,
    timestamp: now + 500
  });
  status = getRouterStatus(now + 500);
  assert.equal(status.liveActivity, 1);
  assert.equal(status.usage.totals.active, 1);

  // Transition through each wait state: tool_wait, user_wait, subagent_wait, resumed
  for (const state of ["tool_wait", "user_wait", "subagent_wait", "resumed"]) {
    agentActivity.applyLifecycleEvent("subagent-wait-sess", {
      state,
      timestamp: now + 1000
    });
    status = getRouterStatus(now + 1000);
    assert.equal(
      status.liveActivity,
      1,
      `liveActivity should be 1 in state ${state}`
    );
    assert.equal(
      status.usage.totals.active,
      1,
      `usage.totals.active should be 1 in state ${state}`
    );
    assert.equal(status.usage.byWorkspace.AutoDev.active, 1);
  }

  // Matured past TTL: becomes stale
  const ttlMs = AGENT_ACTIVITY_TTL_MS;
  const staleTime = now + 1000 + ttlMs + 5000;
  status = getRouterStatus(staleTime);
  // Stale child stops being live; no workspace-based parent is fabricated.
  assert.equal(status.liveActivity, 0);
  assert.equal(status.usage.totals.active, 0);
  assert.equal(status.usage.byRole.orchestrator.active, 0);
  assert.equal(status.usage.byWorkspace.AutoDev?.active ?? 0, 0);

  // Reopen with new request and then finish (terminal)
  agentActivity.beginRequest("subagent-wait-sess", {
    requestId: "req-terminal-1",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "AutoDev",
    timestamp: staleTime + 1000
  });
  assert.equal(getRouterStatus(staleTime + 1000).liveActivity, 1);

  // Terminal finish
  agentActivity.finish("subagent-wait-sess", {
    requestId: "req-terminal-1",
    outcome: "success",
    timestamp: staleTime + 2000
  });
  status = getRouterStatus(staleTime + 2000);
  assert.equal(status.liveActivity, 0);
  assert.equal(status.usage.totals.active, 0);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: subagent slots and in-flight requests are tracked separately and do not inflate live agent totals", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // Acquire concurrency admission slots (these use kind: "subagent_slot")
  assert.equal(tryAcquireSubagentSlot("session-slot-1"), null);
  assert.equal(tryAcquireSubagentSlot("session-slot-2"), null);
  assert.equal(concurrencyStatus().activeSubagentThreads, 2);

  // Increment transport in-flight requests
  incrementActiveRequests("minimax");
  incrementActiveRequests("claude");

  // Status check: transport and slots report non-zero, but live agent counts remain 0
  let status = getRouterStatus();
  assert.equal(status.inFlightRequests.minimax, 1);
  assert.equal(status.inFlightRequests.claude, 1);
  assert.equal(status.concurrency.activeSubagentThreads, 2);
  assert.equal(
    status.liveActivity,
    0,
    "slots and transport requests must not inflate liveActivity"
  );
  assert.equal(
    status.usage.totals.active,
    0,
    "slots and transport requests must not inflate usage.totals.active"
  );
  assert.equal(
    status.providers.minimax.active,
    0,
    "providers.active must not count transport in-flight or slots"
  );
  assert.equal(status.providers.claude.active, 0);

  // Now start a genuine subagent turn
  agentActivity.beginRequest("real-subagent", {
    requestId: "req-real-1",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "AutoDev"
  });

  status = getRouterStatus();
  // Live activity is exactly one explicitly tracked subagent.
  assert.equal(status.liveActivity, 1);
  assert.equal(status.usage.totals.active, 1);
  assert.equal(status.providers.minimax.active, 1); // 1 real agent on minimax
  assert.equal(status.providers.claude.active, 0); // claude still has 0 live agents, only in-flight transport

  // Decrement transport requests
  decrementActiveRequests("minimax");
  decrementActiveRequests("claude");
  status = getRouterStatus();
  assert.equal(status.inFlightRequests.minimax ?? 0, 0);
  assert.equal(status.inFlightRequests.claude ?? 0, 0);
  assert.equal(status.providers.minimax.inFlightRequests, 0);
  assert.equal(status.providers.claude.inFlightRequests, 0);
  assert.equal(
    status.liveActivity,
    1,
    "settling in-flight transport does not close agent-level gap activity"
  );

  // Release slots
  releaseSubagentSlot("session-slot-1");
  releaseSubagentSlot("session-slot-2");
  status = getRouterStatus();
  assert.equal(status.concurrency.activeSubagentThreads, 0);
  assert.equal(
    status.liveActivity,
    1,
    "releasing concurrency slots does not close agent activity"
  );

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: residual active provider and workspace buckets are visible and reconcile rendered totals", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // 1. Roleless activity with unproven workspace and unproven provider
  agentActivity.beginRequest("sess-residual-direct", {
    requestId: "req-res-1",
    role: null,
    origin: "direct",
    workspace: null,
    provider: null,
    model: null
  });

  let status = getRouterStatus();
  assert.equal(status.liveActivity, 1);
  assert.equal(status.usage.totals.active, 1);

  // Missing provider identity is a diagnostic, never a synthetic provider row.
  assert.equal(status.providers.unattributed, undefined);
  assert.equal(status.liveAgentAttribution.missingProvider, 1);

  // Provider health total matches canonical total exactly
  let providerSum = Object.values(status.providers).reduce(
    (sum: number, p: any) => sum + Number(p.active ?? 0),
    0
  );
  assert.equal(providerSum, 0);

  // Unattributed workspace bucket exists and includes the roleless agent
  assert.ok(
    status.usage.byWorkspace.unattributed,
    "unattributed workspace bucket must be present"
  );
  assert.equal(status.usage.byWorkspace.unattributed.active, 1);
  let workspaceSum = Object.values(status.usage.byWorkspace).reduce(
    (sum: number, w: any) => sum + Number(w.active ?? 0),
    0
  );
  assert.equal(workspaceSum, 1);

  // 2. Add a subagent with unproven workspace but verified provider (claude)
  agentActivity.beginRequest("sess-sub-unattributed-ws", {
    requestId: "req-res-2",
    role: "worker",
    origin: "subagent",
    workspace: null,
    provider: "claude",
    model: "sonnet"
  });

  // Total: one direct roleless agent plus one explicitly tracked subagent.
  status = getRouterStatus();
  assert.equal(status.liveActivity, 2);
  assert.equal(status.usage.totals.active, 2);

  // Provider health reports only the concrete routed provider.
  assert.equal(status.providers.claude.active, 1);
  assert.equal(status.providers.unattributed, undefined);
  providerSum = Object.values(status.providers).reduce(
    (sum: number, p: any) => sum + Number(p.active ?? 0),
    0
  );
  assert.equal(providerSum, 1);

  // Workspace usage includes all 3 in the unattributed workspace bucket
  assert.equal(status.usage.byWorkspace.unattributed.active, 2);
  workspaceSum = Object.values(status.usage.byWorkspace).reduce(
    (sum: number, w: any) => sum + Number(w.active ?? 0),
    0
  );
  assert.equal(workspaceSum, 2);

  // Internal workspace breakdown reconciles
  assert.equal(status.usage.byWorkspace.unattributed.byRole.worker.active, 1);
  assert.equal(
    status.usage.byWorkspace.unattributed.byRole.orchestrator.active,
    0
  );
  assert.equal(
    status.usage.byWorkspace.unattributed.byRole.unattributed.active,
    1
  );
  assert.equal(
    status.usage.byWorkspace.unattributed.byProvider.claude.active,
    1
  );
  assert.equal(
    status.usage.byWorkspace.unattributed.byProvider.unattributed,
    undefined
  );

  // 3. Settle and finish all agents -> active counts clear cleanly
  agentActivity.finish("sess-residual-direct", {
    requestId: "req-res-1",
    outcome: "success"
  });
  agentActivity.finish("sess-sub-unattributed-ws", {
    requestId: "req-res-2",
    outcome: "success"
  });

  status = getRouterStatus();
  assert.equal(status.liveActivity, 0);
  assert.equal(status.usage.totals.active, 0);
  assert.equal(
    status.providers.unattributed,
    undefined,
    "unattributed provider rows are never rendered"
  );
  providerSum = Object.values(status.providers).reduce(
    (sum: number, p: any) => sum + Number(p.active ?? 0),
    0
  );
  assert.equal(providerSum, 0);
  assert.equal(status.usage.byWorkspace.unattributed?.active ?? 0, 0);
  workspaceSum = Object.values(status.usage.byWorkspace).reduce(
    (sum: number, w: any) => sum + Number(w.active ?? 0),
    0
  );
  assert.equal(workspaceSum, 0);

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

test("active-agent reconciliation: /status exposes status.agents (autodev-agent-status-v1) with canonical live count, liveBy partitions, and slot-vs-agent reconciliation", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();

  // A mix of routed agents and roleless activity to exercise every
  // status.agents partition.
  agentActivity.beginRequest("session:parent", {
    requestId: "req-agent-parent",
    provider: "codex",
    model: CONFIGURED_ORCHESTRATOR_MODEL,
    role: "orchestrator",
    origin: "orchestrator",
    workspace: "AutoDev"
  });
  agentActivity.beginRequest("session:child-worker", {
    requestId: "req-agent-worker",
    provider: "minimax",
    model: "MiniMax-M3",
    role: "worker",
    origin: "subagent",
    workspace: "AutoDev"
  });
  agentActivity.beginRequest("bridge:child-validator", {
    requestId: "req-agent-validator",
    kind: "bridge_subagent",
    provider: "claude",
    model: "sonnet",
    role: "validator",
    origin: "subagent",
    workspace: "codex-runtime"
  });
  agentActivity.beginRequest("session:roleless", {
    requestId: "req-agent-rl",
    role: null,
    origin: "direct",
    workspace: "AutoDev"
  });

  // Two admission slots on an identified session to exercise slotVsAgent.
  tryAcquireSubagentSlot("reconcile-status-identified");
  tryAcquireSubagentSlot("reconcile-status-identified");

  const status = getRouterStatus();

  // status.agents is the canonical home for live-agent reconciliation
  // and must expose the frozen schema tag.
  assert.equal(status.agents.schema, "autodev-agent-status-v1");
  assert.equal(status.agents.canonicalLiveCount, 4);

  // liveBy partitions reflect the projection's role/origin/workspace
  // distributions and retain the explicit unattributed residual.
  assert.deepEqual(status.agents.liveByKind, {
    session: 3,
    bridge_subagent: 1
  });
  assert.deepEqual(status.agents.liveByRole, {
    orchestrator: 1,
    worker: 1,
    validator: 1,
    unattributed: 1
  });
  assert.deepEqual(status.agents.liveByOrigin, {
    orchestrator: 1,
    subagent: 2,
    direct: 1
  });
  assert.deepEqual(status.agents.liveByWorkspace, {
    AutoDev: 3,
    "codex-runtime": 1
  });

  // Provider/model dimensions contain concrete routed values; the diagnostic
  // missingProvider / missingModel flags surface the roleless residual.
  assert.deepEqual(status.agents.liveByProvider, {
    codex: 1,
    minimax: 1,
    claude: 1
  });
  assert.deepEqual(status.agents.liveByModel, {
    [`codex/${CONFIGURED_ORCHESTRATOR_MODEL}`]: 1,
    "minimax/MiniMax-M3": 1,
    "claude/sonnet": 1
  });
  assert.equal(status.agents.missingProvider, 1);
  assert.equal(status.agents.missingModel, 1);

  // byState covers the full tracker state histogram; "active" holds the
  // four live agents we just seeded and every other state is zero.
  assert.equal(status.agents.byState.active, 4);
  assert.equal(status.agents.byState.finished, 0);
  assert.equal(status.agents.byState.failed, 0);
  assert.equal(status.agents.byState.stale, 0);

  // slotVsAgent reconciles the agent projection against the slot tracker
  // and the process-fallback admission count is reported separately.
  assert.equal(status.agents.slotVsAgent.agentLive, 4);
  assert.equal(status.agents.slotVsAgent.admissionSlots, 2);
  assert.equal(status.agents.slotVsAgent.activeAdmissionSessions, 1);
  assert.equal(status.agents.slotVsAgent.processFallbackActiveThreads, 0);

  // The agent and concurrency projections must agree on the slot counters,
  // confirming reconciledWithConcurrency was evaluated at the same instant.
  assert.equal(
    status.agents.slotVsAgent.admissionSlots,
    status.concurrency.activeSubagentThreads
  );
  assert.equal(
    status.agents.slotVsAgent.activeAdmissionSessions,
    status.concurrency.activeSessions
  );
  assert.equal(
    status.agents.slotVsAgent.processFallbackActiveThreads,
    status.concurrency.processFallbackActiveThreads
  );
  assert.equal(status.agents.reconciledWithConcurrency, true);

  // status.agents.canonicalLiveCount must agree with every other live
  // count that has historically described "how many agents are live".
  assert.equal(status.agents.canonicalLiveCount, status.liveActivity);
  assert.equal(status.agents.canonicalLiveCount, status.usage.totals.active);
  assert.equal(status.agents.canonicalLiveCount, status.usage.activity.live);

  // Settle every agent and confirm the canonical live count clears while
  // terminal entries remain visible in byState.
  agentActivity.finish("session:parent", {
    requestId: "req-agent-parent",
    outcome: "success"
  });
  agentActivity.finish("session:child-worker", {
    requestId: "req-agent-worker",
    outcome: "success"
  });
  agentActivity.finish("bridge:child-validator", {
    requestId: "req-agent-validator",
    outcome: "success"
  });
  agentActivity.finish("session:roleless", {
    requestId: "req-agent-rl",
    outcome: "success"
  });

  const settled = getRouterStatus() as any;
  assert.equal(settled.agents.canonicalLiveCount, 0);
  assert.equal(settled.agents.byState.finished, 4);
  assert.equal(
    settled.agents.slotVsAgent.admissionSlots,
    2,
    "admission slots outlive agent finishes -- they only release on releaseSubagentSlot"
  );

  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetRouterTelemetry();
});

// Phase 3 in-repo slice: opt-in autodev.* attribute emission. Each assertion
// line quotes a property of the frozen contract (resources only carry resource
// keys; events only carry event keys; unknown values are omitted; no prompt
// content may be carried). The flag stays off by default so all of the
// pre-existing tests run on the unchanged default path.
const autodevAttr = (entries: any) =>
  entries.map(([key, value]: [any, any]) => ({
    key,
    value: { stringValue: String(value) }
  }));

function autodevBuildPayload() {
  return {
    logs: {
      resourceLogs: [
        {
          resource: {
            attributes: autodevAttr([
              ["service.name", "codex-cli"],
              ["service.version", "1.2.3"],
              ["role", "orchestrator"],
              ["workspace_id", "ws-autodev-test"],
              ["provider", "openai"],
              ["model", CONFIGURED_ORCHESTRATOR_MODEL]
            ])
          },
          scopeLogs: [
            {
              scope: { name: "codex", version: "1.2.3" },
              logRecords: [
                {
                  timeUnixNano: "1",
                  attributes: autodevAttr([
                    ["event.name", "codex.user_prompt"],
                    ["conversation.id", "c-autodev-test"],
                    ["prompt_length", 17],
                    ["prompt_text", "do-not-store-this-secret"]
                  ])
                },
                {
                  timeUnixNano: "2",
                  attributes: autodevAttr([
                    ["event.name", "codex.subagent_spawn"],
                    ["conversation.id", "c-autodev-test"],
                    ["spawn_mechanism", "task-tool"]
                  ])
                },
                {
                  timeUnixNano: "3",
                  attributes: autodevAttr([
                    ["event.name", "codex.skill_invoke"],
                    ["conversation.id", "c-autodev-test"],
                    ["skill", "ccc"]
                  ])
                },
                {
                  timeUnixNano: "4",
                  attributes: autodevAttr([
                    ["event.name", "codex.mcp_tool_call"],
                    ["conversation.id", "c-autodev-test"],
                    ["server_name", "playwright"]
                  ])
                },
                {
                  timeUnixNano: "5",
                  attributes: autodevAttr([
                    ["event.name", "codex.tool_result"],
                    ["conversation.id", "c-autodev-test"],
                    ["tool", "exec_command"],
                    ["status", "success"]
                  ])
                }
              ]
            }
          ]
        }
      ]
    },
    traces: {
      resourceSpans: [
        {
          resource: {
            attributes: autodevAttr([
              ["service.name", "codex-cli"],
              ["role", "orchestrator"],
              ["workspace_id", "ws-autodev-test"],
              ["provider", "openai"],
              ["model", CONFIGURED_ORCHESTRATOR_MODEL]
            ])
          },
          scopeSpans: [
            {
              scope: { name: "codex", version: "1.2.3" },
              spans: [
                {
                  name: "make_rmcp_client",
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: autodevAttr([
                    ["server_name", "playwright"],
                    ["conversation.id", "c-autodev-test"]
                  ]),
                  status: { code: 1 }
                },
                {
                  name: "internal_unattributed_step",
                  startTimeUnixNano: "3",
                  endTimeUnixNano: "4",
                  attributes: autodevAttr([
                    ["conversation.id", "c-autodev-test"]
                  ]),
                  status: { code: 1 }
                }
              ]
            }
          ]
        }
      ]
    },
    metrics: {
      resourceMetrics: [
        {
          resource: {
            attributes: autodevAttr([
              ["service.name", "codex-cli"],
              ["role", "orchestrator"],
              ["workspace_id", "ws-autodev-test"],
              ["provider", "openai"],
              ["model", CONFIGURED_ORCHESTRATOR_MODEL]
            ])
          },
          scopeMetrics: [
            {
              scope: { name: "codex", version: "1.2.3" },
              metrics: [
                {
                  name: "codex.skill.injected",
                  sum: {
                    aggregationTemporality: 1,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        attributes: autodevAttr([
                          ["skill", "ccc"],
                          ["status", "injected"]
                        ]),
                        startTimeUnixNano: "1",
                        timeUnixNano: "2",
                        asInt: "3"
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

function autodevAttrMap(attributes: any): Record<string, any> {
  const map: Record<string, any> = {};
  for (const entry of attributes ?? [])
    map[entry.key] = entry.value?.stringValue;
  return map;
}

test("autodev attributes are off by default and require AUTODEV_OTEL_ATTRIBUTES=v1", () => {
  // The helper itself is always callable, but ingestOtelSignal must not call
  // it unless the opt-in flag is set. Default-off is the entire contract.
  const previous = process.env.AUTODEV_OTEL_ATTRIBUTES;
  delete process.env.AUTODEV_OTEL_ATTRIBUTES;
  try {
    assert.equal(isAutodevAttributesEnabled(), false);
    resetOtelTelemetry();
    const payload = autodevBuildPayload();
    const before = structuredClone(payload);
    ingestOtelSignal("logs", payload.logs);
    ingestOtelSignal("traces", payload.traces);
    ingestOtelSignal("metrics", payload.metrics);
    // Default path leaves payload untouched and emits zero autodev keys.
    assert.deepEqual(payload, before);
    const enriched = autodevEnrichOtlpPayload("logs", payload.logs);
    assert.notEqual(
      enriched,
      payload.logs,
      "the helper returns a fresh clone, not the input"
    );
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_OTEL_ATTRIBUTES;
    else process.env.AUTODEV_OTEL_ATTRIBUTES = previous;
  }
});

test("AUTODEV_OTEL_ATTRIBUTES=v1 enriches resource and event keys without changing routing state", () => {
  const previous = process.env.AUTODEV_OTEL_ATTRIBUTES;
  process.env.AUTODEV_OTEL_ATTRIBUTES = "v1";
  try {
    assert.equal(isAutodevAttributesEnabled(), true);
    resetOtelTelemetry();
    const payload = autodevBuildPayload();
    const beforeSnapshot = structuredClone(payload);
    ingestOtelSignal("logs", payload.logs);
    ingestOtelSignal("traces", payload.traces);
    ingestOtelSignal("metrics", payload.metrics);
    // ingestOtelSignal must not mutate its inputs even when enrichment is on.
    assert.deepEqual(
      payload,
      beforeSnapshot,
      "the input payload must be untouched"
    );
    // All three signals were counted: the receiver counter is the only
    // route-visible side effect and must be preserved.
    const status = codexTelemetryStatus(Date.now());
    assert.equal(status.receiver.logs, 1);
    assert.equal(status.receiver.traces, 1);
    assert.equal(status.receiver.metrics, 1);
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_OTEL_ATTRIBUTES;
    else process.env.AUTODEV_OTEL_ATTRIBUTES = previous;
  }
});

test("autodevEnrichOtlpPayload places resource keys only on resource.attributes", () => {
  const payload = autodevBuildPayload();
  const enriched = autodevEnrichOtlpPayload("logs", payload.logs);
  const resource = enriched.resourceLogs[0].resource;
  const resourceMap = autodevAttrMap(resource.attributes);
  // Resource-scope keys from the frozen contract map directly from their aliases.
  assert.equal(resourceMap["autodev.role"], "orchestrator");
  assert.equal(resourceMap["autodev.workspace"], "ws-autodev-test");
  assert.equal(resourceMap["autodev.provider"], "openai");
  assert.equal(resourceMap["autodev.model"], CONFIGURED_ORCHESTRATOR_MODEL);
  // Originals are still there.
  assert.equal(resourceMap["service.name"], "codex-cli");
  assert.equal(resourceMap.role, "orchestrator");
  assert.equal(resourceMap.workspace_id, "ws-autodev-test");
  // Resource-scope keys never leak into event/span/datapoint attributes.
  for (const scopeLog of enriched.resourceLogs[0].scopeLogs) {
    for (const record of scopeLog.logRecords) {
      const eventMap = autodevAttrMap(record.attributes);
      assert.equal(eventMap["autodev.role"], undefined);
      assert.equal(eventMap["autodev.workspace"], undefined);
      assert.equal(eventMap["autodev.provider"], undefined);
      assert.equal(eventMap["autodev.model"], undefined);
    }
  }
});

test("autodevEnrichOtlpPayload places event keys only on the right event types", () => {
  const payload = autodevBuildPayload();
  const logsEnriched = autodevEnrichOtlpPayload("logs", payload.logs);
  const records = logsEnriched.resourceLogs[0].scopeLogs[0].logRecords;
  const byName: Record<string, any> = Object.fromEntries(
    records.map((r: any) => [
      r.attributes.find((a: any) => a.key === "event.name")?.value?.stringValue,
      autodevAttrMap(r.attributes)
    ])
  );
  assert.equal(
    byName["codex.subagent_spawn"]["autodev.spawn.mechanism"],
    "task-tool"
  );
  assert.equal(byName["codex.skill_invoke"]["autodev.skill"], "ccc");
  assert.equal(
    byName["codex.mcp_tool_call"]["autodev.mcp.server"],
    "playwright"
  );
  // Records that don't carry the relevant alias get no autodev key.
  assert.equal(byName["codex.user_prompt"]["autodev.skill"], undefined);
  assert.equal(byName["codex.user_prompt"]["autodev.mcp.server"], undefined);
  assert.equal(byName["codex.tool_result"]["autodev.skill"], undefined);

  const tracesEnriched = autodevEnrichOtlpPayload("traces", payload.traces);
  const spans = tracesEnriched.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(
    spans[0].attributes.find((a: any) => a.key === "autodev.mcp.server")?.value
      ?.stringValue,
    "playwright"
  );
  // No server_name alias → no autodev.mcp.server decoration on the unattributed span.
  assert.equal(
    spans[1].attributes.find((a: any) => a.key === "autodev.mcp.server"),
    undefined
  );

  const metricsEnriched = autodevEnrichOtlpPayload("metrics", payload.metrics);
  const dataPointAttributes =
    metricsEnriched.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      .dataPoints[0].attributes;
  assert.equal(
    dataPointAttributes.find((a: any) => a.key === "autodev.skill")?.value
      ?.stringValue,
    "ccc"
  );
});

test("autodevEnrichOtlpPayload is non-mutating: the input is left untouched", () => {
  // Source-of-truth check that the helper never rewrites caller data: every
  // nested array/object on the input must be identical post-call. The helper
  // returns a brand new top-level object; comparing identity alone is not
  // enough because structuredClone always produces a fresh tree.
  const payload = autodevBuildPayload();
  const inputLogs = structuredClone(payload.logs);
  const inputTraces = structuredClone(payload.traces);
  const inputMetrics = structuredClone(payload.metrics);
  const enrichedLogs = autodevEnrichOtlpPayload("logs", payload.logs);
  const enrichedTraces = autodevEnrichOtlpPayload("traces", payload.traces);
  const enrichedMetrics = autodevEnrichOtlpPayload("metrics", payload.metrics);
  assert.notEqual(
    enrichedLogs,
    payload.logs,
    "logs helper returns a new object"
  );
  assert.notEqual(
    enrichedTraces,
    payload.traces,
    "traces helper returns a new object"
  );
  assert.notEqual(
    enrichedMetrics,
    payload.metrics,
    "metrics helper returns a new object"
  );
  assert.deepEqual(
    payload.logs,
    inputLogs,
    "the input logs payload is untouched"
  );
  assert.deepEqual(
    payload.traces,
    inputTraces,
    "the input traces payload is untouched"
  );
  assert.deepEqual(
    payload.metrics,
    inputMetrics,
    "the input metrics payload is untouched"
  );
  // Mutating the cloned enriched result must not touch the original input.
  enrichedLogs.resourceLogs[0].resource.attributes.push({
    key: "autodev.injected",
    value: { stringValue: "marker" }
  });
  assert.equal(
    payload.logs.resourceLogs[0]?.resource.attributes.find(
      (a: any) => a.key === "autodev.injected"
    ),
    undefined
  );
});

test("autodevEnrichOtlpPayload never carries prompt or response content", () => {
  // The frozen contract forbids prompt/response content in any autodev.* key.
  // The user_prompt record carries a prompt_text value the helper must ignore;
  // the original prompt_text entry must remain on the record so the rest of
  // the pipeline keeps working, but no autodev.* attribute value may equal it.
  const payload = autodevBuildPayload();
  const enriched = autodevEnrichOtlpPayload("logs", payload.logs);
  const promptSecret = "do-not-store-this-secret";
  let inspectedAutodevEntries = 0;
  for (const resourceLog of enriched.resourceLogs) {
    for (const entry of resourceLog.resource.attributes) {
      if (entry.key.startsWith("autodev.")) {
        inspectedAutodevEntries += 1;
        assert.notEqual(
          entry.value?.stringValue,
          promptSecret,
          `no autodev.* key may equal the prompt text (${entry.key})`
        );
      }
    }
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        for (const entry of record.attributes) {
          if (entry.key.startsWith("autodev.")) {
            inspectedAutodevEntries += 1;
            assert.notEqual(
              entry.value?.stringValue,
              promptSecret,
              `no autodev.* key may equal the prompt text (${entry.key})`
            );
          }
        }
      }
    }
  }
  // Defensive: ensure something was actually inspected so a no-op helper
  // cannot pass the test by accident.
  assert.ok(
    inspectedAutodevEntries > 0,
    "at least one autodev.* attribute must be inspected"
  );
  // prompt_text is preserved verbatim on its record (the helper never edits
  // existing non-autodev keys) so the rest of the pipeline keeps working.
  const userPromptRecord =
    enriched.resourceLogs[0].scopeLogs[0].logRecords.find(
      (r: any) =>
        r.attributes.find((a: any) => a.key === "event.name")?.value
          ?.stringValue === "codex.user_prompt"
    );
  assert.ok(userPromptRecord, "the user_prompt record must still be present");
  const promptText = userPromptRecord.attributes.find(
    (a: any) => a.key === "prompt_text"
  )?.value?.stringValue;
  assert.equal(
    promptText,
    promptSecret,
    "prompt_text is preserved on its record (not modified by the helper)"
  );
});

test("autodevEnrichOtlpPayload omits unknown values and avoids duplicate keys", () => {
  // Empty / whitespace / oversized alias values must produce no autodev.* key
  // and calling the helper twice must never double-add an autodev.* entry.
  const logsPayload = {
    resourceLogs: [
      {
        resource: {
          attributes: autodevAttr([
            ["service.name", "codex-cli"],
            ["role", ""],
            ["workspace_id", "   "],
            ["provider", "openai"],
            ["model", CONFIGURED_ORCHESTRATOR_MODEL]
          ])
        },
        scopeLogs: [
          {
            scope: { name: "codex", version: "1.2.3" },
            logRecords: [
              {
                timeUnixNano: "1",
                attributes: autodevAttr([
                  ["event.name", "codex.heartbeat"],
                  ["conversation.id", "c-autodev-test"]
                ])
              }
            ]
          }
        ]
      }
    ]
  };
  const once = autodevEnrichOtlpPayload("logs", logsPayload);
  const onceResource = autodevAttrMap(once.resourceLogs[0].resource.attributes);
  assert.equal(
    onceResource["autodev.role"],
    undefined,
    "empty role alias produces no key"
  );
  assert.equal(
    onceResource["autodev.workspace"],
    undefined,
    "whitespace workspace_id alias produces no key"
  );
  assert.equal(onceResource["autodev.provider"], "openai");
  assert.equal(onceResource["autodev.model"], CONFIGURED_ORCHESTRATOR_MODEL);
  // Heartbeat has no skill / spawn_mechanism / server_name alias: nothing added.
  const heartBeat = once.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(
    autodevAttrMap(heartBeat.attributes)["autodev.skill"],
    undefined
  );
  assert.equal(
    autodevAttrMap(heartBeat.attributes)["autodev.spawn.mechanism"],
    undefined
  );
  assert.equal(
    autodevAttrMap(heartBeat.attributes)["autodev.mcp.server"],
    undefined
  );

  // Duplicate stability: re-running the helper on already-enriched data must
  // not add a second copy of any autodev.* key, and must leave existing values
  // verbatim (the helper treats presence as "do not touch").
  const twice = autodevEnrichOtlpPayload("logs", once);
  const twiceResourceAttributes = twice.resourceLogs[0].resource.attributes;
  const providerOccurrences = twiceResourceAttributes.filter(
    (a: any) => a.key === "autodev.provider"
  );
  const modelOccurrences = twiceResourceAttributes.filter(
    (a: any) => a.key === "autodev.model"
  );
  assert.equal(
    providerOccurrences.length,
    1,
    "autodev.provider must appear exactly once after a second enrichment pass"
  );
  assert.equal(
    modelOccurrences.length,
    1,
    "autodev.model must appear exactly once after a second enrichment pass"
  );
  assert.equal(providerOccurrences[0].value.stringValue, "openai");
  assert.equal(modelOccurrences[0].value.stringValue, CONFIGURED_ORCHESTRATOR_MODEL);
  // Pre-existing autodev.* entries with a non-empty value must survive a
  // second enrichment untouched (the helper does not overwrite).
  once.resourceLogs[0].resource.attributes.unshift({
    key: "autodev.provider",
    value: { stringValue: "pinned-openai" }
  });
  const thrice = autodevEnrichOtlpPayload("logs", once);
  const providerValues = thrice.resourceLogs[0].resource.attributes
    .filter((a: any) => a.key === "autodev.provider")
    .map((a: any) => a.value.stringValue);
  assert.deepEqual(
    providerValues,
    ["pinned-openai", "openai"],
    "pre-existing autodev.* entries are preserved verbatim"
  );
});

test("autodevEnrichOtlpPayload preserves aggregation semantics on metrics", () => {
  // The opt-in emission must not change aggregations: number values, start/end
  // timestamps, temporality flags, and data point identity stay exactly the same.
  const payload = autodevBuildPayload();
  const before = structuredClone(payload.metrics);
  const enriched = autodevEnrichOtlpPayload("metrics", payload.metrics);
  const dataPointBefore =
    before.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
  const dataPointAfter =
    enriched.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
  assert.equal(dataPointAfter.asInt, dataPointBefore.asInt);
  assert.equal(
    dataPointAfter.startTimeUnixNano,
    dataPointBefore.startTimeUnixNano
  );
  assert.equal(dataPointAfter.timeUnixNano, dataPointBefore.timeUnixNano);
  assert.equal(
    enriched.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      .aggregationTemporality,
    before.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      .aggregationTemporality
  );
  assert.equal(
    enriched.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.isMonotonic,
    before.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.isMonotonic
  );
  // Pre-existing data-point attributes are still there untouched.
  const afterKeys = new Set(dataPointAfter.attributes.map((a: any) => a.key));
  for (const key of ["skill", "status", "autodev.skill"])
    assert.equal(afterKeys.has(key), true);
});
