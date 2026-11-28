import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_CONCURRENCY_SCHEMA_ID,
  CONTROL_API_ROUTING_SCHEMA_ID,
  CONTROL_API_RUNTIME_SCHEMA_ID,
  controlApiConcurrencyPatchResponseSchema,
  controlApiRoutingResponseSchema,
  controlApiRuntimeResponseSchema
} from "../src/control-api/runtime.ts";

const CONCURRENCY = {
  scope: "session",
  configSource: "default",
  configFileSource: "default_codex_home",
  configFileExists: true,
  maxConcurrentThreadsPerSession: null,
  effectivePerSessionLimit: null,
  activeSubagentThreads: 1,
  activeSessions: 1,
  denials: 0,
  denialsByReason: {},
  lastDenial: null,
  revision: 1
};

const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: "unlimited",
    observedGeneration: "unlimited",
    lastApplyAt: "2026-11-27T08:00:00Z",
    lastObservationAt: "2026-11-27T08:00:01Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

test("runtime response validates lifecycle, concurrency, liveAgents, and strict liveSessions invariants", () => {
  const valid = {
    schema: CONTROL_API_RUNTIME_SCHEMA_ID,
    routerInstanceId: "router-1",
    lifecycle: {
      state: "ready",
      draining: false,
      changedAt: "2026-11-27T08:00:00Z",
      activeResponseRequests: 1
    },
    concurrency: CONCURRENCY,
    inFlightRequestCount: 1,
    liveAgents: {
      count: 1,
      byRole: { coder: 1 },
      byProvider: { codex: 1 },
      byModel: { "codex/gpt-5": 1 },
      byWorkspace: { autodev: 1 },
      byProviderRole: { codex: { coder: 1 } },
      byModelRole: { "codex/gpt-5": { coder: 1 } },
      missingProvider: 0,
      missingModel: 0
    },
    liveSessions: {
      identitiesObserved: [
        {
          sessionId: "session-a",
          state: "active",
          lastActivityAt: 1_700_000_000_000,
          provider: "codex",
          model: "gpt-5",
          role: "coder",
          clientSurface: "codex_cli"
        },
        {
          sessionId: "session-b",
          state: "tool_wait",
          lastActivityAt: 1_700_000_001_000,
          provider: null,
          model: null,
          role: null,
          clientSurface: null
        }
      ],
      identifiedSessionCount: 2,
      partial: false,
      unattributedLiveActivityCount: 0
    }
  };
  assert.equal(controlApiRuntimeResponseSchema.safeParse(valid).success, true);
  assert.equal(
    controlApiRuntimeResponseSchema.safeParse({
      ...valid,
      lifecycle: { ...valid.lifecycle, state: "starting" }
    }).success,
    false
  );
  assert.equal(
    controlApiRuntimeResponseSchema.safeParse({
      ...valid,
      liveSessions: {
        ...valid.liveSessions,
        identitiesObserved: [
          valid.liveSessions.identitiesObserved[1],
          valid.liveSessions.identitiesObserved[0]
        ]
      }
    }).success,
    false,
    "identitiesObserved must remain strictly sorted"
  );
  assert.equal(
    controlApiRuntimeResponseSchema.safeParse({
      ...valid,
      liveSessions: {
        ...valid.liveSessions,
        partial: true
      }
    }).success,
    false,
    "partial cannot be true below cap"
  );
});

test("concurrency patch contract validates schema and reconciliation bundle", () => {
  assert.equal(
    controlApiConcurrencyPatchResponseSchema.safeParse({
      schema: CONTROL_API_CONCURRENCY_SCHEMA_ID,
      concurrency: CONCURRENCY,
      reconciliation: RECONCILIATION
    }).success,
    true
  );
  assert.equal(
    controlApiConcurrencyPatchResponseSchema.safeParse({
      schema: CONTROL_API_CONCURRENCY_SCHEMA_ID,
      concurrency: { ...CONCURRENCY, configSource: "unknown_source" },
      reconciliation: RECONCILIATION
    }).success,
    false
  );
});

test("routing response validates schema and policy state", () => {
  assert.equal(
    controlApiRoutingResponseSchema.safeParse({
      schema: CONTROL_API_ROUTING_SCHEMA_ID,
      runtime: {
        roleAssignments: {
          codex: { orchestrator: { priority: 1, model: "gpt-5" } }
        },
        disabledProviders: [],
        disabledModels: [],
        disabledAgentRoles: [],
        agentEnablementRevisions: {},
        providerLimits: {},
        agentModels: {}
      },
      routes: [
        {
          provider: "codex",
          pattern: "gpt-*",
          baseUrl: "http://127.0.0.1:4100"
        }
      ],
      cooldowns: {},
      concurrency: CONCURRENCY
    }).success,
    true
  );
});
