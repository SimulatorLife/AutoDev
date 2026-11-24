import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approvalPolicyFromConfig,
  PermissionPolicyConflictError,
  permissionPolicyGeneration,
  permissionPolicyRevision,
  PermissionPolicyValidationError,
  readAntigravityCliPermissionDefaults,
  readAppliedPermissionPolicyFile,
  readPermissionPolicyFile,
  updatePermissionPolicy
} from "../src/config/permission-policy.ts";
import * as dataExports from "../src/index.ts";

const POLICY_SOURCE = `{
  "version": "1.0.0",
  // Codex defaults for AutoDev
  "codexcli": {
    "base_permission_profile": ":danger-full-access",
    "approval_policy": "never",
    "approvals_reviewer": "user",
    "tools": {
      "web_search": true
    }
  }
}
`;

const APPLIED_TOML = `# Codex user config
default_permissions = ":danger-full-access"
approval_policy = "never"
approvals_reviewer = "user"

[tools]
web_search = true
`;

async function policyFixture(content = POLICY_SOURCE): Promise<{
  readonly directory: string;
  readonly file: string;
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-permission-policy-")
  );
  const file = path.join(directory, "permissions.jsonc");
  await writeFile(file, content, "utf8");
  return { directory, file };
}

test("readPermissionPolicyFile reads codexcli settings and revision from .rulesync/permissions.jsonc", async () => {
  const { directory, file } = await policyFixture();
  try {
    const read = readPermissionPolicyFile(file);
    assert.equal(read.status, "valid");
    assert.equal(read.policy.approvalPolicy, "never");
    assert.equal(read.policy.approvalsReviewer, "user");
    assert.equal(read.policy.webSearch, true);
    assert.equal(read.revision, permissionPolicyRevision(POLICY_SOURCE));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readAppliedPermissionPolicyFile reads applied TOML config.toml settings", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-applied-policy-")
  );
  try {
    const file = path.join(directory, "config.toml");
    await writeFile(file, APPLIED_TOML, "utf8");
    const read = readAppliedPermissionPolicyFile(file);
    assert.equal(read.status, "valid");
    assert.equal(read.policy.approvalPolicy, "never");
    assert.equal(read.policy.approvalsReviewer, "user");
    assert.equal(read.policy.webSearch, true);
    assert.equal(read.revision, permissionPolicyRevision(APPLIED_TOML));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPermissionPolicyFile reports an incomplete policy as invalid without partial values", async () => {
  const { directory, file } = await policyFixture(
    '{\n  "codexcli": { "approval_policy": "never" }\n}\n'
  );
  try {
    const read = readPermissionPolicyFile(file);
    assert.equal(read.status, "invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPermissionPolicyFile reports unparseable JSONC as invalid while keeping revision", async () => {
  const { directory, file } = await policyFixture("{ invalid jsonc\n");
  try {
    const read = readPermissionPolicyFile(file);
    assert.equal(read.status, "invalid");
    assert.ok(read.revision);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPermissionPolicyFile reports missing files as unavailable", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-missing-policy-")
  );
  try {
    const read = readPermissionPolicyFile(
      path.join(directory, "permissions.jsonc")
    );
    assert.equal(read.status, "unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the approval policy vocabulary is translated in one place", () => {
  assert.equal(approvalPolicyFromConfig("never"), "never");
  assert.equal(approvalPolicyFromConfig("on-request"), "on-request");
  assert.equal(approvalPolicyFromConfig("on-demand"), null);
  assert.equal(approvalPolicyFromConfig("always"), null);
});

test("legacy role sandbox readers are not exported from @simulatorlife/autodev-data", () => {
  const exported = Object.keys(dataExports);
  assert.equal(exported.includes("readRoleSandboxModes"), false);
  assert.equal(exported.includes("roleSandboxMode"), false);
  assert.equal(exported.includes("sandboxModeFromConfig"), false);
  assert.equal(exported.includes("sandboxModeToConfig"), false);
});

test("a write changes the requested key while preserving comments in JSONC", async () => {
  const { directory, file } = await policyFixture();
  try {
    const before = await readFile(file, "utf8");
    const revision = permissionPolicyRevision(before);
    const written = updatePermissionPolicy({
      file,
      expectedRevision: revision,
      update: { approvalPolicy: "on-request" }
    });
    assert.equal(written.changed, true);
    assert.equal(written.policy.approvalPolicy, "on-request");
    const after = await readFile(file, "utf8");
    assert.match(after, /\/\/ Codex defaults for AutoDev/u);
    assert.match(after, /"approval_policy": "on-request"/u);
    assert.match(after, /"approvals_reviewer": "user"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write reaches nested tools.web_search cleanly", async () => {
  const { directory, file } = await policyFixture();
  try {
    const revision = permissionPolicyRevision(await readFile(file, "utf8"));
    const written = updatePermissionPolicy({
      file,
      expectedRevision: revision,
      update: { webSearch: false, approvalsReviewer: "guardian_subagent" }
    });
    assert.equal(written.changed, true);
    assert.equal(written.policy.webSearch, false);
    assert.equal(written.policy.approvalsReviewer, "guardian_subagent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write decided on a policy file that has moved is refused", async () => {
  const { directory, file } = await policyFixture();
  try {
    const revision = permissionPolicyRevision(await readFile(file, "utf8"));
    await writeFile(file, `${POLICY_SOURCE}\n`, "utf8");
    assert.throws(
      () =>
        updatePermissionPolicy({
          file,
          expectedRevision: revision,
          update: { approvalPolicy: "on-request" }
        }),
      PermissionPolicyConflictError
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a value outside the vocabulary is refused before the file is touched", async () => {
  const { directory, file } = await policyFixture();
  try {
    const revision = permissionPolicyRevision(await readFile(file, "utf8"));
    assert.throws(
      () =>
        updatePermissionPolicy({
          file,
          expectedRevision: revision,
          update: {
            approvalPolicy: "sometimes" as never
          }
        }),
      PermissionPolicyValidationError
    );
    assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write that changes nothing says so and writes nothing", async () => {
  const { directory, file } = await policyFixture();
  try {
    const revision = permissionPolicyRevision(await readFile(file, "utf8"));
    const written = updatePermissionPolicy({
      file,
      expectedRevision: revision,
      update: { approvalPolicy: "never" }
    });
    assert.equal(written.changed, false);
    assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the generation of a policy is its values, not its bytes", () => {
  const first = permissionPolicyGeneration({
    approvalPolicy: "never",
    approvalsReviewer: "user",
    webSearch: true
  });
  const second = permissionPolicyGeneration({
    approvalPolicy: "never",
    approvalsReviewer: "user",
    webSearch: true
  });
  assert.equal(first, second);
  const other = permissionPolicyGeneration({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    webSearch: true
  });
  assert.notEqual(first, other);
});

test("readAntigravityCliPermissionDefaults reads antigravity-cli overrides and handles absent files", async () => {
  const { directory, file } = await policyFixture(
    JSON.stringify({
      "antigravity-cli": {
        agentMode: "accept-edits",
        toolPermission: "always-proceed"
      }
    })
  );
  try {
    assert.deepEqual(readAntigravityCliPermissionDefaults(file), {
      agentMode: "accept-edits",
      toolPermission: "always-proceed"
    });
    assert.deepEqual(
      readAntigravityCliPermissionDefaults(
        path.join(directory, "missing.jsonc")
      ),
      {
        agentMode: null,
        toolPermission: null
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
