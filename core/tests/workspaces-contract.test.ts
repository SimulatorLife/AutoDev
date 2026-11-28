import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_WORKSPACE_PLAYTEST_APPROVAL_SCHEMA_ID,
  CONTROL_API_WORKSPACE_VISUAL_PLAYTEST_TARGETS_SCHEMA_ID,
  CONTROL_API_WORKSPACES_SCHEMA_ID,
  controlApiWorkspacePlaytestApprovalResponseSchema,
  controlApiWorkspacesResponseSchema,
  controlApiWorkspaceVisualPlaytestTargetsResponseSchema
} from "../src/control-api/workspaces.ts";

const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: "rev-1",
    observedGeneration: "rev-1",
    lastApplyAt: null,
    lastObservationAt: "2026-11-27T08:00:00Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

test("workspaces contract validates configuration health and strict not-observed runtime", () => {
  const valid = {
    schema: CONTROL_API_WORKSPACES_SCHEMA_ID,
    source: "config/workspaces.json",
    readOnly: false,
    catalogStatus: "valid",
    revision: "a".repeat(64),
    totalWorkspaces: 1,
    workspaces: [
      {
        id: "owner/repo",
        baseBranch: "main",
        enabled: true,
        agentRoles: ["coder"],
        configuration: { status: "configured" },
        runtime: { status: "not-observed" }
      }
    ],
    reconciliation: RECONCILIATION
  };
  assert.equal(
    controlApiWorkspacesResponseSchema.safeParse(valid).success,
    true
  );
  assert.equal(
    controlApiWorkspacesResponseSchema.safeParse({
      ...valid,
      workspaces: [
        {
          ...valid.workspaces[0],
          runtime: { status: "not-observed", liveAgents: 0 }
        }
      ]
    }).success,
    false
  );
});

test("workspace playtesting approval and visual target schemas allow empty/null states and enforce workspace scoping", () => {
  assert.equal(
    controlApiWorkspacePlaytestApprovalResponseSchema.safeParse({
      schema: CONTROL_API_WORKSPACE_PLAYTEST_APPROVAL_SCHEMA_ID,
      workspaceId: "owner/repo",
      workspaceEnabled: true,
      approval: null
    }).success,
    true
  );
  assert.equal(
    controlApiWorkspaceVisualPlaytestTargetsResponseSchema.safeParse({
      schema: CONTROL_API_WORKSPACE_VISUAL_PLAYTEST_TARGETS_SCHEMA_ID,
      workspaceId: "owner/repo",
      workspaceEnabled: true,
      targets: []
    }).success,
    true
  );
});
