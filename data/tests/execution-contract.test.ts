import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assignSkillRoles,
  ExecutionContractConflictError,
  executionContractRevision,
  ExecutionContractValidationError} from "@simulatorlife/autodev-data";

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
  assert.deepEqual(rolesOf(file.path, "orchestrator"), ["ccc", "release-checklist"]);
  assert.deepEqual(rolesOf(file.path, "worker"), ["release-checklist"]);
  // Untouched, including the role it was already in.
  assert.deepEqual(rolesOf(file.path, "reviewer"), ["ccc"]);
  assert.equal(result.revision, executionContractRevision(readFileSync(file.path, "utf8")));
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