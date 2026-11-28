import assert from "node:assert/strict";
import test from "node:test";

import {
  availableGrantSelection,
  computePolicyDigest,
  previousGrantSelection
} from "../src/platform/mcp-gateway-policy-review.ts";

test("review identity changes with the installed generation and workspace", () => {
  const digest = (generation: string, workspace: string) =>
    computePolicyDigest(
      "orchestrator",
      "{}",
      "{}",
      { xacpx: { command: "fixture" } },
      {},
      "sha256:fixture",
      generation,
      workspace
    );
  const first = digest("/home/.codex/.src-a", "/project");
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, digest("/home/.codex/.src-a", "/project"));
  assert.notEqual(first, digest("/home/.codex/.src-b", "/project"));
  assert.notEqual(first, digest("/home/.codex/.src-a", "/other-project"));
});

test("default grants follow review; an existing narrow grant remains explicit", () => {
  const reviewed = { xacpx: ["delegate_request", "task_watch"] };
  const base = {
    role: "orchestrator",
    policyFile: "/project/permissions.jsonc",
    reviewed,
    grants: { xacpx: ["task_watch", "delegate_request"] }
  };
  assert.equal(previousGrantSelection(undefined, base.role, base.policyFile), undefined);
  assert.equal(previousGrantSelection(base, base.role, base.policyFile), undefined);
  const narrowed = { ...base, grants: { xacpx: ["delegate_request"] } };
  assert.deepEqual(
    previousGrantSelection(narrowed, base.role, base.policyFile),
    narrowed.grants
  );
  assert.equal(previousGrantSelection(narrowed, "worker", base.policyFile), undefined);
});

test("explicit selection survives temporarily missing tools and never gains new tools", () => {
  const selection = {
    filesystem: ["read_text_file"],
    xacpx: ["delegate_request"]
  };
  const reduced = { filesystem: ["read_text_file"] };
  assert.deepEqual(availableGrantSelection(selection, reduced), reduced);
  const state = {
    role: "orchestrator",
    policyFile: "/project/permissions.jsonc",
    reviewed: reduced,
    grants: reduced,
    grantSelection: selection
  };
  const persisted = previousGrantSelection(state, state.role, state.policyFile);
  assert.deepEqual(persisted, selection);
  assert.deepEqual(
    availableGrantSelection(persisted!, {
      filesystem: ["read_text_file", "write_file"],
      xacpx: ["delegate_request", "task_watch", "task_get"],
      commands: ["test"]
    }),
    selection
  );
  assert.deepEqual(availableGrantSelection(selection, {}), {});
});
