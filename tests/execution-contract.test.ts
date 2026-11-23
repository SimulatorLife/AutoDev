import assert from "node:assert/strict";
import test from "node:test";

import {
  isReadOnlyRole,
  roleAllowsProviderHop
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

void test("isReadOnlyRole: empty / unknown / null returns false", () => {
  assert.equal(isReadOnlyRole(null), false);
  assert.equal(isReadOnlyRole(undefined), false);
  assert.equal(isReadOnlyRole(""), false);
  assert.equal(isReadOnlyRole("   "), false);
  assert.equal(isReadOnlyRole("nonexistent-role"), false);
});

void test("isReadOnlyRole: case-insensitive role keys", () => {
  assert.equal(isReadOnlyRole("Explorer"), true);
  assert.equal(isReadOnlyRole("WORKER"), false);
});

void test("roleAllowsProviderHop: only orchestrator allows cross-provider hops", () => {
  assert.equal(roleAllowsProviderHop("orchestrator"), true);
  assert.equal(roleAllowsProviderHop("ORCHESTRATOR"), true);
  assert.equal(roleAllowsProviderHop("worker"), false);
  assert.equal(roleAllowsProviderHop("explorer"), false);
  assert.equal(roleAllowsProviderHop("smart"), false);
  assert.equal(roleAllowsProviderHop(null), false);
});
