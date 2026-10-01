import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterRuntimeStatus } from "../../src/router/status.ts";

test("router runtime status selects operational fields and excludes history", () => {
  const status = parseRouterRuntimeStatus({
    schema: "autodev-router-status-v2",
    router: "codex-model-router",
    pid: 12,
    routerInstanceId: "router-1",
    startedAt: "2026-09-30T00:00:00.000Z",
    authentication: { responseRequests: true, credential: "secret" },
    routing: {
      enabledOrchestratorProviders: ["openai"],
      providerGroups: { normal: [["openai"]] },
      internalHistory: ["hidden"]
    },
    limits: { providerCooldownMs: 1000 },
    providers: {
      openai: {
        status: "ready",
        active: 1,
        attempts: 20,
        failures: 2,
        lastFailure: { class: "rate_limit", status: 429 }
      }
    },
    concurrency: { activeSessions: 2, denials: 1, internalHistory: ["hidden"] },
    inFlightRequests: { openai: 1 },
    liveActivity: 3,
    agents: { canonicalLiveCount: 3 },
    usage: { byWorkspace: { private: { requests: 1 } } },
    codexTelemetry: { tokens: { total: 100 } },
    recentEvents: [{ requestId: "private" }],
    liveFeed: [{ prompt: "private" }],
    telemetryPersistence: { path: "/private/path" },
    subagents: { recent: [{ thread: "private" }] },
    spawnFailures: { total: 8 },
    codexState: { recentThreads: ["private"] }
  });

  assert.deepEqual(status, {
    schema: "autodev-router-status-v2",
    router: "codex-model-router",
    pid: 12,
    routerInstanceId: "router-1",
    startedAt: "2026-09-30T00:00:00.000Z",
    authentication: { responseRequests: true },
    routing: {
      enabledOrchestratorProviders: ["openai"],
      providerGroups: { normal: [["openai"]] }
    },
    limits: { providerCooldownMs: 1000 },
    providers: {
      openai: {
        status: "ready",
        active: 1,
        lastFailure: { class: "rate_limit", status: 429 }
      }
    },
    concurrency: { activeSessions: 2, denials: 1 },
    inFlightRequests: { openai: 1 },
    liveActivity: 3,
    agents: { canonicalLiveCount: 3 }
  });
});

test("router runtime status rejects non-object responses", () => {
  assert.throws(() => parseRouterRuntimeStatus(null), /must be a JSON object/);
  assert.throws(() => parseRouterRuntimeStatus([]), /must be a JSON object/);
});

test("router runtime status retains API errors for failed HTTP responses", () => {
  assert.deepEqual(
    parseRouterRuntimeStatus({
      error: { message: "unavailable", code: "down", path: "/private" }
    }),
    { error: { message: "unavailable", code: "down" } }
  );
});
