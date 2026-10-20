import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceConfigurationHealth,
  type WorkspaceEntry
} from "../src/index.ts";

const KNOWN_ROLES = ["orchestrator", "worker", "explorer"] as const;

function workspace(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: "SimulatorLife/AutoDev",
    baseBranch: "main",
    enabled: true,
    agentRoles: null,
    ...overrides
  };
}

test("a workspace with no role scope is configured", () => {
  // An unconfigured scope is a deliberate state -- it means every role may
  // work here -- so it is not a fault.
  assert.deepEqual(workspaceConfigurationHealth(workspace(), KNOWN_ROLES), {
    status: "configured"
  });
});

test("a role scope that names only configured roles is configured", () => {
  assert.deepEqual(
    workspaceConfigurationHealth(
      workspace({ agentRoles: ["orchestrator", "worker"] }),
      KNOWN_ROLES
    ),
    { status: "configured" }
  );
});

test("a role scope naming a role nothing answers to is a configuration fault", () => {
  // The catalog reader accepts this entry: the scope is a non-empty list of
  // unique strings. It is still unusable, because the scope excludes every
  // agent that could work in the workspace and nothing else says so.
  assert.deepEqual(
    workspaceConfigurationHealth(
      workspace({ agentRoles: ["orchestrator", "not-a-role"] }),
      KNOWN_ROLES
    ),
    { status: "invalid-role-scope", unknownRoles: ["not-a-role"] }
  );
});

test("every unknown role in a scope is named", () => {
  // The operator has to be able to fix the scope, so the fault names every
  // role the scope could not place rather than only the first one.
  assert.deepEqual(
    workspaceConfigurationHealth(
      workspace({ agentRoles: ["ghost", "phantom"] }),
      KNOWN_ROLES
    ),
    { status: "invalid-role-scope", unknownRoles: ["ghost", "phantom"] }
  );
});
