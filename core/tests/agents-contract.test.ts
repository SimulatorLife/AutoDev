import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_AGENT_DETAIL_SCHEMA_ID,
  CONTROL_API_AGENT_ENABLEMENT_SCHEMA_ID,
  CONTROL_API_AGENTS_SCHEMA_ID,
  controlApiAgentDetailResponseSchema,
  controlApiAgentEnablementPatchResponseSchema,
  controlApiAgentsResponseSchema
} from "../src/control-api/agents.ts";

const REVISION = "a".repeat(64);
const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: REVISION,
    observedGeneration: REVISION,
    lastApplyAt: "2026-11-27T08:00:00Z",
    lastObservationAt: "2026-11-27T08:00:01Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

const AGENT_ROW = {
  id: "coder",
  role: "coder",
  kind: "leaf",
  readOnly: false,
  configured: true,
  valid: true,
  status: "ready",
  convergence: "converged",
  enablement: {
    kind: "observed",
    enabled: true,
    mutable: true,
    revision: REVISION
  },
  primaryModel: "codex/gpt-5",
  allowedProviders: ["codex"],
  mcps: ["lsp"],
  skills: ["dry"],
  hasPrompt: true
};

test("agents catalog and detail schemas enforce enablement and convergence invariants", () => {
  const catalog = {
    schema: CONTROL_API_AGENTS_SCHEMA_ID,
    source: "config/autodev-execution-contract.toml",
    readOnly: false,
    executionContractObserved: true,
    totalAgents: 1,
    agents: [AGENT_ROW]
  };
  assert.equal(controlApiAgentsResponseSchema.safeParse(catalog).success, true);
  assert.equal(
    controlApiAgentsResponseSchema.safeParse({ ...catalog, readOnly: true })
      .success,
    false
  );
  assert.equal(
    controlApiAgentsResponseSchema.safeParse({
      ...catalog,
      agents: [{ ...AGENT_ROW, status: "custom-future-state" }]
    }).success,
    true
  );
  assert.equal(
    controlApiAgentsResponseSchema.safeParse({
      ...catalog,
      agents: [{ ...AGENT_ROW, convergence: "unknown" }]
    }).success,
    false
  );
  assert.equal(
    controlApiAgentDetailResponseSchema.safeParse({
      ...AGENT_ROW,
      schema: CONTROL_API_AGENT_DETAIL_SCHEMA_ID,
      promptPath: "agents/prompts/roles/coder.md",
      systemPrompt: "# Coder",
      reconciliation: RECONCILIATION
    }).success,
    true
  );
});

test("agent enablement patch contract rejects empty actors and malformed revisions", () => {
  const valid = {
    schema: CONTROL_API_AGENT_ENABLEMENT_SCHEMA_ID,
    role: "coder",
    enabled: false,
    previous: true,
    revision: REVISION,
    actor: "local-operator",
    reconciliation: RECONCILIATION
  };
  assert.equal(
    controlApiAgentEnablementPatchResponseSchema.safeParse(valid).success,
    true
  );
  assert.equal(
    controlApiAgentEnablementPatchResponseSchema.safeParse({
      ...valid,
      actor: ""
    }).success,
    false
  );
  assert.equal(
    controlApiAgentEnablementPatchResponseSchema.safeParse({
      ...valid,
      revision: "bad"
    }).success,
    false
  );
});
