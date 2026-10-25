import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assignedSkillRoles,
  assignSkillRoles,
  contractSkillRoles,
  ExecutionContractConflictError,
  executionContractRevision,
  ExecutionContractValidationError
} from "@simulatorlife/autodev-data";

/**
 * The assignment is the operation the memory system needed to finish a
 * promotion, so the properties that matter are the ones a concurrent edit or a
 * typo would break silently.
 */

function contractFile(contract: unknown): { path: string; revision: string } {
  const directory = mkdtempSync(join(tmpdir(), "autodev-contract-"));
  const path = join(directory, "execution-contract.json");
  const content = `${JSON.stringify(contract, null, 2)}\n`;
  writeFileSync(path, content, "utf8");
  return { path, revision: executionContractRevision(content) };
}

const BASE = {
  roles: {
    orchestrator: { kind: "primary", skills: ["ccc"] },
    worker: { kind: "subagent", skills: [] },
    reviewer: { kind: "subagent", skills: ["ccc"] }
  },
  providers: {}
};

function rolesOf(path: string, role: string): string[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    roles: Record<string, { skills: string[] }>;
  };
  return parsed.roles[role]?.skills ?? [];
}

test("assigning a skill puts it in exactly the roles named", async () => {
  const file = contractFile(BASE);
  const result = await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "release-checklist",
    roles: ["worker", "orchestrator"]
  });

  assert.deepEqual([...result.roles], ["orchestrator", "worker"]);
  assert.deepEqual(rolesOf(file.path, "orchestrator"), [
    "ccc",
    "release-checklist"
  ]);
  assert.deepEqual(rolesOf(file.path, "worker"), ["release-checklist"]);
  // Untouched, including the role it was already in.
  assert.deepEqual(rolesOf(file.path, "reviewer"), ["ccc"]);
  assert.equal(
    result.revision,
    executionContractRevision(readFileSync(file.path, "utf8"))
  );
});

test("the roles list is the whole desired set, so unassigning is the same call", async () => {
  const file = contractFile(BASE);
  await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "ccc",
    roles: ["orchestrator"]
  });
  const revision = executionContractRevision(readFileSync(file.path, "utf8"));

  await assignSkillRoles({
    file: file.path,
    expectedRevision: revision,
    skill: "ccc",
    roles: []
  });

  // An empty list removes it everywhere rather than being a no-op, because the
  // body is a set and not an addition. Without that, "unassign" would need a
  // second verb that does not exist.
  assert.deepEqual(rolesOf(file.path, "orchestrator"), []);
  assert.deepEqual(rolesOf(file.path, "reviewer"), []);
});

test("a stale revision is refused rather than merged over", async () => {
  const file = contractFile(BASE);
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: "0".repeat(64),
      skill: "release-checklist",
      roles: ["worker"]
    }),
    ExecutionContractConflictError,
    "two operators assigning at once must not silently discard the first write"
  );
  assert.deepEqual(rolesOf(file.path, "worker"), []);
});

test("a role that is not in the contract cannot be assigned", async () => {
  const file = contractFile(BASE);
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: file.revision,
      skill: "release-checklist",
      roles: ["nonexistent"]
    }),
    ExecutionContractValidationError
  );
  // Silently creating the role would invent a role no provider spawns under.
  const parsed = JSON.parse(readFileSync(file.path, "utf8")) as {
    roles: Record<string, unknown>;
  };
  assert.equal(parsed.roles.nonexistent, undefined);
});

test("a malformed name is refused before anything is read", async () => {
  const file = contractFile(BASE);
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: file.revision,
      skill: "Release Checklist",
      roles: ["worker"]
    }),
    ExecutionContractValidationError
  );
  assert.equal(
    executionContractRevision(readFileSync(file.path, "utf8")),
    file.revision,
    "the contract is untouched by a refused assignment"
  );
});

test("a contract that is not JSON is refused rather than overwritten", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-contract-"));
  const path = join(directory, "execution-contract.json");
  const broken = "{ not json";
  writeFileSync(path, broken, "utf8");
  await assert.rejects(
    assignSkillRoles({
      file: path,
      expectedRevision: executionContractRevision(broken),
      skill: "release-checklist",
      roles: ["worker"]
    }),
    ExecutionContractValidationError
  );
  assert.equal(readFileSync(path, "utf8"), broken);
});

test("an assignment that changes nothing reports the revision it read", async () => {
  const file = contractFile(BASE);
  // `ccc` is already on orchestrator and reviewer; asking for exactly that is
  // not an error and must not rewrite the file with reordered keys.
  const before = readFileSync(file.path, "utf8");
  const result = await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "ccc",
    roles: ["reviewer", "orchestrator"]
  });
  assert.equal(readFileSync(file.path, "utf8"), before);
  assert.equal(result.revision, file.revision);
});

/**
 * The workspace dimension of the contract.
 *
 * A skill installed inside a repository belongs to that repository's workspace
 * alone. Its assignment therefore lives in the workspace's section of the
 * contract, and the global section keeps its own separate assignments -- the
 * two are not two views of one list, because a global claim on a workspace's
 * skill would hand it to workspaces it does not belong to.
 */

const WORKSPACE = "SimulatorLife/AutoDev";

function parsedContract(path: string): {
  roles: Record<string, { skills?: string[] }>;
  workspaces?: Record<
    string,
    { roles?: Record<string, { skills?: string[] }> }
  >;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    roles: Record<string, { skills?: string[] }>;
    workspaces?: Record<
      string,
      { roles?: Record<string, { skills?: string[] }> }
    >;
  };
}

function workspaceRolesOf(
  path: string,
  workspace: string,
  role: string
): string[] {
  return (
    parsedContract(path).workspaces?.[workspace]?.roles?.[role]?.skills ?? []
  );
}

test("assigning inside a workspace writes the workspace section and leaves the global list alone", async () => {
  const file = contractFile(BASE);
  const result = await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker"],
    workspace: WORKSPACE
  });

  assert.equal(result.workspace, WORKSPACE);
  assert.deepEqual([...result.roles], ["worker"]);
  assert.deepEqual(workspaceRolesOf(file.path, WORKSPACE, "worker"), [
    "autodev-codex-request-capture"
  ]);
  // The global section is untouched: the skill is that workspace's alone.
  assert.deepEqual(rolesOf(file.path, "worker"), []);
  assert.deepEqual(rolesOf(file.path, "orchestrator"), ["ccc"]);
});

test("assigning globally writes the global list and leaves the workspace section alone", async () => {
  const file = contractFile(BASE);
  const result = await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "release-checklist",
    roles: ["worker"]
  });

  assert.equal(result.workspace, null);
  assert.deepEqual(rolesOf(file.path, "worker"), ["release-checklist"]);
  assert.equal(parsedContract(file.path).workspaces, undefined);
});

test("a workspace assignment removes the skill from the workspace's other roles", async () => {
  const file = contractFile(BASE);
  await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker", "reviewer"],
    workspace: WORKSPACE
  });
  const revision = executionContractRevision(readFileSync(file.path, "utf8"));

  await assignSkillRoles({
    file: file.path,
    expectedRevision: revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker"],
    workspace: WORKSPACE
  });

  assert.deepEqual(workspaceRolesOf(file.path, WORKSPACE, "worker"), [
    "autodev-codex-request-capture"
  ]);
  assert.deepEqual(workspaceRolesOf(file.path, WORKSPACE, "reviewer"), []);
});

test("a workspace id that is not an owner/repository key is refused", async () => {
  const file = contractFile(BASE);
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: file.revision,
      skill: "autodev-codex-request-capture",
      roles: ["worker"],
      workspace: "SimulatorLife"
    }),
    ExecutionContractValidationError
  );
  assert.equal(
    executionContractRevision(readFileSync(file.path, "utf8")),
    file.revision,
    "the contract is untouched by a refused assignment"
  );
});

test("a role the contract does not define cannot be assigned inside a workspace", async () => {
  const file = contractFile(BASE);
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: file.revision,
      skill: "autodev-codex-request-capture",
      roles: ["nonexistent"],
      workspace: WORKSPACE
    }),
    ExecutionContractValidationError
  );
  assert.equal(parsedContract(file.path).workspaces, undefined);
});

test("the read side is the exact inverse of the write", async () => {
  const file = contractFile(BASE);
  await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker"],
    workspace: WORKSPACE
  });

  assert.deepEqual(
    [
      ...assignedSkillRoles({
        file: file.path,
        skill: "autodev-codex-request-capture"
      })
    ],
    [],
    "a workspace assignment claims the skill globally nowhere"
  );
  assert.deepEqual(
    [
      ...assignedSkillRoles({
        file: file.path,
        skill: "autodev-codex-request-capture",
        workspace: WORKSPACE
      })
    ],
    ["worker"]
  );
  assert.deepEqual(
    [...assignedSkillRoles({ file: file.path, skill: "ccc" })],
    ["orchestrator", "reviewer"]
  );
  assert.deepEqual(
    [
      ...assignedSkillRoles({
        file: file.path,
        skill: "ccc",
        workspace: WORKSPACE
      })
    ],
    [],
    "a global assignment claims the skill in no workspace"
  );
});

test("the contract's role map is read per workspace", async () => {
  const file = contractFile(BASE);
  await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker"],
    workspace: WORKSPACE
  });

  const parsed = parsedContract(file.path);
  assert.deepEqual(
    contractSkillRoles(parsed as Record<string, unknown>).worker,
    []
  );
  assert.deepEqual(
    contractSkillRoles(parsed as Record<string, unknown>, WORKSPACE).worker,
    ["autodev-codex-request-capture"]
  );
});

test("the revision changes when the workspace section changes", async () => {
  const file = contractFile(BASE);
  const result = await assignSkillRoles({
    file: file.path,
    expectedRevision: file.revision,
    skill: "autodev-codex-request-capture",
    roles: ["worker"],
    workspace: WORKSPACE
  });

  assert.notEqual(result.revision, file.revision);
  assert.equal(
    result.revision,
    executionContractRevision(readFileSync(file.path, "utf8"))
  );
  // A second operator's stale read is refused, workspace section or not.
  await assert.rejects(
    assignSkillRoles({
      file: file.path,
      expectedRevision: file.revision,
      skill: "autodev-codex-request-capture",
      roles: ["reviewer"],
      workspace: WORKSPACE
    }),
    ExecutionContractConflictError
  );
});
