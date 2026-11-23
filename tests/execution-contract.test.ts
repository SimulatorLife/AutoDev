import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSandboxMode,
  roleAllowsProviderHop,
  roleSandboxMode
} from "@simulatorlife/autodev-runtime/shared/execution-contract";

void test("roleSandboxMode: a role's declaration is reported as it states it", () => {
  assert.equal(roleSandboxMode("explorer"), "read-only");
  assert.equal(roleSandboxMode("browser-tester"), "read-only");
  assert.equal(roleSandboxMode("docs-researcher"), "read-only");
  assert.equal(roleSandboxMode("validator"), "workspace-write");
  // The product's name for the unsandboxed mode: the file names it
  // `danger-full-access`, and the contract reports it as the product names
  // it.
  assert.equal(roleSandboxMode("orchestrator"), "unrestricted");
  assert.equal(roleSandboxMode("worker"), "unrestricted");
  assert.equal(roleSandboxMode("smart"), "unrestricted");
});

void test("roleSandboxMode: a role that declares no sandbox declares none", () => {
  // The role inherits the session's sandbox, so the contract says nothing
  // about it. The old boolean answered `workspace-write` here, which named a
  // sandbox the role never asked for.
  assert.equal(roleSandboxMode("default"), null);
});

void test("roleSandboxMode: empty / unknown / null returns null", () => {
  assert.equal(roleSandboxMode(null), null);
  assert.equal(roleSandboxMode(undefined), null);
  assert.equal(roleSandboxMode(""), null);
  assert.equal(roleSandboxMode("   "), null);
  assert.equal(roleSandboxMode("nonexistent-role"), null);
});

void test("roleSandboxMode: case-insensitive role keys", () => {
  assert.equal(roleSandboxMode("Explorer"), "read-only");
  assert.equal(roleSandboxMode("WORKER"), "unrestricted");
});

void test("resolveSandboxMode: the bridge tier is the mode a bridge enforces", () => {
  // The bridges enforce two tiers: a read-only role may not write, and every
  // other role may.
  assert.equal(resolveSandboxMode("explorer"), "read-only");
  assert.equal(resolveSandboxMode("browser-tester"), "read-only");
  assert.equal(resolveSandboxMode("docs-researcher"), "read-only");
  assert.equal(resolveSandboxMode("validator"), "workspace-write");
});

void test("resolveSandboxMode: a role that is not read-only is given the writable tier", () => {
  // A bridge enforces two tiers: read-only, and writable. A role that
  // declares the unrestricted sandbox, and a role that declares none and so
  // inherits the session's, both run in the writable tier. The router's word
  // is what the bridge acts on, so the tier is named for every role the
  // contract describes rather than left to the bridge's own copy of the
  // contract.
  assert.equal(resolveSandboxMode("orchestrator"), "workspace-write");
  assert.equal(resolveSandboxMode("worker"), "workspace-write");
  assert.equal(resolveSandboxMode("smart"), "workspace-write");
  assert.equal(resolveSandboxMode("default"), "workspace-write");
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
  assert.equal(resolveSandboxMode("VALIDATOR"), "workspace-write");
});

void test("roleAllowsProviderHop: only orchestrator allows cross-provider hops", () => {
  assert.equal(roleAllowsProviderHop("orchestrator"), true);
  assert.equal(roleAllowsProviderHop("ORCHESTRATOR"), true);
  assert.equal(roleAllowsProviderHop("worker"), false);
  assert.equal(roleAllowsProviderHop("explorer"), false);
  assert.equal(roleAllowsProviderHop("smart"), false);
  assert.equal(roleAllowsProviderHop(null), false);
});
