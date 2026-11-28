import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PROVIDER_CHECK_SCHEMA_ID,
  CONTROL_API_PROVIDER_VERSIONS_SCHEMA_ID,
  CONTROL_API_PROVIDER_VERSIONS_SOURCE,
  CONTROL_API_PROVIDERS_SCHEMA_ID,
  controlApiProviderCheckResponseSchema,
  controlApiProvidersResponseSchema,
  controlApiProviderVersionsResponseSchema
} from "../src/control-api/providers.ts";

const TS = "2026-11-27T08:00:00.000Z";
const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: "gen-1",
    observedGeneration: "gen-1",
    lastApplyAt: TS,
    lastObservationAt: TS,
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

const ROLE_ASSIGNMENT = {
  priority: 1,
  model: "gpt-5",
  mutable: true,
  convergence: RECONCILIATION.status
};

const PROVIDER_ROW = {
  id: "codex",
  links: { usage: "https://usage.example.test", documentation: null },
  route: { pattern: "^codex/", baseUrl: "http://127.0.0.1:4100", healthUrl: null },
  credential: { envKey: "OPENAI_API_KEY", configured: true },
  disabled: false,
  roles: { orchestrator: ROLE_ASSIGNMENT, subagent: ROLE_ASSIGNMENT },
  agentLimits: { perSession: null, acrossSessions: 4 },
  agentModels: [{ role: "coder", tier: "balanced", model: null, tierModel: "gpt-5" }],
  models: [{ tier: "balanced", model: "gpt-5" }],
  priorities: [{ tier: "balanced", group: 1 }],
  orchestratorReasoningEffort: "medium",
  health: null,
  reconciliation: RECONCILIATION
};

test("providers response rejects duplicate provider ids and validates role convergence", () => {
  const valid = {
    schema: CONTROL_API_PROVIDERS_SCHEMA_ID,
    orchestratorTier: "balanced",
    quotaAxi: null,
    tiers: [{ tier: "balanced", groups: [["codex"]] }],
    providers: [PROVIDER_ROW]
  };
  assert.equal(controlApiProvidersResponseSchema.safeParse(valid).success, true);
  const { route: _omittedRoute, ...providerWithoutRoute } = PROVIDER_ROW;
  const parsedWithoutRoute = controlApiProvidersResponseSchema.safeParse({
    ...valid,
    providers: [providerWithoutRoute]
  });
  assert.equal(parsedWithoutRoute.success, true);
  assert.equal(
    parsedWithoutRoute.success && "route" in parsedWithoutRoute.data.providers[0]!,
    false
  );
  assert.equal(
    controlApiProvidersResponseSchema.safeParse({
      ...valid,
      providers: [PROVIDER_ROW, PROVIDER_ROW]
    }).success,
    false
  );
  assert.equal(
    controlApiProvidersResponseSchema.safeParse({
      ...valid,
      providers: [{ ...PROVIDER_ROW, roles: { orchestrator: ROLE_ASSIGNMENT } }]
    }).success,
    false
  );
});

test("provider check and CLI versions contracts validate observed and unavailable states", () => {
  assert.equal(
    controlApiProviderCheckResponseSchema.safeParse({
      schema: CONTROL_API_PROVIDER_CHECK_SCHEMA_ID,
      provider: "codex",
      check: { at: TS, ok: true, failureClass: null, detail: "Healthy." },
      health: null
    }).success,
    true
  );
  assert.equal(
    controlApiProviderVersionsResponseSchema.safeParse({
      schema: CONTROL_API_PROVIDER_VERSIONS_SCHEMA_ID,
      source: CONTROL_API_PROVIDER_VERSIONS_SOURCE,
      providers: [
        {
          provider: "codex",
          cli: {
            status: "observed",
            command: "codex",
            version: "1.0.0",
            observedAt: TS
          }
        },
        {
          provider: "claude",
          cli: {
            status: "unavailable",
            kind: "not-installed",
            command: "claude",
            reason: "Not installed",
            lastAttemptAt: null
          }
        }
      ]
    }).success,
    true
  );
});
