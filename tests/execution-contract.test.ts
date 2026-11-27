import assert from "node:assert/strict";
import test from "node:test";

import {
  findRoleContract,
  hasRoleContract,
  isReadOnlyRole,
  roleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";

void test("isReadOnlyRole: reports read-only capability per contract role", () => {
  assert.equal(isReadOnlyRole("explorer"), true);
  assert.equal(isReadOnlyRole("browser-tester"), true);
  assert.equal(isReadOnlyRole("docs-researcher"), true);
  assert.equal(isReadOnlyRole("playtester"), true);
  assert.equal(isReadOnlyRole("playtest-analyst"), true);
  assert.equal(isReadOnlyRole("validator"), false);
  assert.equal(isReadOnlyRole("orchestrator"), false);
  assert.equal(isReadOnlyRole("worker"), false);
  assert.equal(isReadOnlyRole("smart"), false);
  assert.equal(isReadOnlyRole("default"), false);
});

void test("unknown, empty, or null roles fail closed (read-only and no writable fallback)", () => {
  for (const invalid of [null, undefined, "", ' '.repeat(3), "nonexistent-role"]) {
    assert.equal(isReadOnlyRole(invalid), true);
    assert.equal(hasRoleContract(invalid), false);
    assert.equal(findRoleContract(invalid), null);
    assert.throws(() => roleContract(invalid), /Unknown AutoDev agent role/u);
  }
});

void test("isReadOnlyRole and roleContract: case-insensitive role keys and full capability projection", () => {
  assert.equal(isReadOnlyRole("Explorer"), true);
  assert.equal(isReadOnlyRole("WORKER"), false);
  assert.equal(roleContract("browser-tester").shell, false);
  assert.equal(roleContract("browser-tester").hooks, false);
  assert.equal(roleContract("playtest-analyst").shell, false);
  assert.equal(
    roleContract("playtest-analyst").skillsPolicy?.bundledEnabled,
    false
  );
  assert.equal(roleContract("worker").shell, true);
  assert.equal(roleContract("worker").hooks, true);
  assert.equal(roleContract("orchestrator").mcpApprovalMode?.xacpx, "approve");
});
