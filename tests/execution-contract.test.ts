import test from "node:test";
import assert from "node:assert/strict";

import { resolveSandboxMode } from "../src/shared/execution-contract.ts";

void test("resolveSandboxMode: read-only roles return 'read-only'", () => {
  assert.equal(resolveSandboxMode("explorer"), "read-only");
  assert.equal(resolveSandboxMode("validator"), "read-only");
  assert.equal(resolveSandboxMode("browser-tester"), "read-only");
  assert.equal(resolveSandboxMode("docs-researcher"), "read-only");
});

void test("resolveSandboxMode: write-capable roles return 'workspace-write'", () => {
  assert.equal(resolveSandboxMode("orchestrator"), "workspace-write");
  assert.equal(resolveSandboxMode("worker"), "workspace-write");
  assert.equal(resolveSandboxMode("default"), "workspace-write");
  assert.equal(resolveSandboxMode("smart"), "workspace-write");
});

void test("resolveSandboxMode: empty / unknown / null returns null", () => {
  assert.equal(resolveSandboxMode(null), null);
  assert.equal(resolveSandboxMode(undefined), null);
  assert.equal(resolveSandboxMode(""), null);
  assert.equal(resolveSandboxMode("   "), null);
  assert.equal(resolveSandboxMode("nonexistent-role"), null);
});

void test("resolveSandboxMode: case-insensitive role keys", () => {
  assert.equal(resolveSandboxMode("Explorer"), "read-only");
  assert.equal(resolveSandboxMode("WORKER"), "workspace-write");
});
