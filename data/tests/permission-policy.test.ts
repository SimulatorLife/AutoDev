import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approvalPolicyFromConfig,
  permissionPolicyGeneration,
  permissionPolicyRevision,
  readAntigravityCliPermissionDefaults,
  readAppliedPermissionPolicyFile,
  readPermissionPolicyFile,
  readPermissionPolicySource
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

test("the canonical policy source travels with the policy it states", async () => {
  const { directory, file } = await policyFixture();
  try {
    const source = readPermissionPolicySource(file);
    assert.equal(source.read.status, "valid");
    // The text is the source as the repository holds it, comments included,
    // and the revision names the same bytes the policy was parsed from.
    assert.equal(source.content, POLICY_SOURCE);
    assert.equal(source.read.revision, permissionPolicyRevision(POLICY_SOURCE));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a canonical policy that was read and did not parse still has its text", async () => {
  const { directory, file } = await policyFixture("{ invalid jsonc\n");
  try {
    const source = readPermissionPolicySource(file);
    assert.equal(source.read.status, "invalid");
    // The fault is in the source, and the source is there to look at.
    assert.equal(source.content, "{ invalid jsonc\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a canonical policy that could not be read has no text", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-missing-policy-source-")
  );
  try {
    const source = readPermissionPolicySource(
      path.join(directory, "permissions.jsonc")
    );
    assert.equal(source.read.status, "unavailable");
    assert.equal(source.content, null);
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

test("permission reads refuse oversized sources without inventing a revision", async (t) => {
  const { directory, file } = await policyFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  // A sparse file demonstrates why the bound must be enforced before reading.
  await truncate(file, 64 * 1024 * 1024);
  for (const read of [
    readPermissionPolicyFile(file),
    readAppliedPermissionPolicyFile(file)
  ]) {
    assert.equal(read.status, "invalid");
    assert.equal(read.revision, null);
    assert.match(read.reason, /size bound/u);
  }
  assert.deepEqual(readAntigravityCliPermissionDefaults(file), {
    agentMode: null,
    toolPermission: null
  });
});

test("permission reads accept the inclusive UTF-8 byte limit and reject malformed bytes", async (t) => {
  const { directory, file } = await policyFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const prefix = POLICY_SOURCE + "\n// ";
  const remaining = 1_000_000 - Buffer.byteLength(prefix);
  const content =
    prefix + "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  assert.equal(Buffer.byteLength(content), 1_000_000);
  await writeFile(file, content);
  const valid = readPermissionPolicyFile(file);
  assert.equal(valid.status, "valid");
  assert.equal(valid.revision, permissionPolicyRevision(content));

  await writeFile(file, content + "x");
  const oversized = readPermissionPolicyFile(file);
  assert.equal(oversized.status, "invalid");
  assert.equal(oversized.revision, null);

  await writeFile(
    file,
    Buffer.concat([Buffer.from(POLICY_SOURCE + "\n// "), Buffer.from([0xff])])
  );
  const malformed = readPermissionPolicyFile(file);
  assert.equal(malformed.status, "invalid");
  assert.equal(malformed.revision, null);
  assert.match(malformed.reason, /UTF-8/u);
});

test("permission reads reject nonregular files and symlinked canonical sources", async (t) => {
  const { directory, file } = await policyFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linkedFile = path.join(directory, "linked.jsonc");
  await symlink(file, linkedFile);
  const linkedDirectory = path.join(directory, "linked-directory");
  const sourceDirectory = path.join(directory, "real-directory");
  await mkdir(sourceDirectory);
  await writeFile(
    path.join(sourceDirectory, "permissions.jsonc"),
    POLICY_SOURCE
  );
  await symlink(sourceDirectory, linkedDirectory, "dir");

  for (const candidate of [
    linkedFile,
    sourceDirectory,
    path.join(linkedDirectory, "permissions.jsonc")
  ]) {
    const read = readPermissionPolicyFile(candidate);
    assert.equal(read.status, "unavailable");
    assert.equal(read.revision, null);
  }
  assert.equal(
    readAppliedPermissionPolicyFile(linkedFile).status,
    "unavailable"
  );
  assert.deepEqual(readAntigravityCliPermissionDefaults(linkedFile), {
    agentMode: null,
    toolPermission: null
  });
  assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
});

test(
  "permission reads reject a FIFO without waiting for a writer",
  {
    skip: process.platform !== "darwin" && process.platform !== "linux"
  },
  async (t) => {
    const { directory } = await policyFixture();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fifo = path.join(directory, "policy-fifo");
    execFileSync("mkfifo", [fifo]);
    const moduleUrl = new URL(
      "../src/config/permission-policy.ts",
      import.meta.url
    );
    // Isolate the read so a regression to a blocking open cannot hang the suite.
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { readPermissionPolicyFile } from ${JSON.stringify(moduleUrl.href)};
     process.stdout.write(JSON.stringify(readPermissionPolicyFile(process.argv[1])));`,
        fifo
      ],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const read = JSON.parse(child.stdout);
    assert.equal(read.status, "unavailable");
    assert.equal(read.revision, null);
  }
);

test("applied permission parse errors never include private configuration text", async (t) => {
  const { directory, file } = await policyFixture(
    'credential = "private-fixture-secret'
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const read = readAppliedPermissionPolicyFile(file);
  assert.equal(read.status, "invalid");
  assert.equal(read.reason, "The applied permission policy is not valid TOML.");
  assert.doesNotMatch(JSON.stringify(read), /private-fixture-secret/u);
});

test("the approval policy vocabulary is translated in one place", () => {
  assert.equal(approvalPolicyFromConfig("never"), "never");
  assert.equal(approvalPolicyFromConfig("on-request"), "on-request");
  assert.equal(approvalPolicyFromConfig("on-demand"), null);
  assert.equal(approvalPolicyFromConfig("always"), null);
});

test("the permission policy has no write surface in @simulatorlife/autodev-data", () => {
  const exported = Object.keys(dataExports);
  assert.equal(exported.includes("updatePermissionPolicy"), false);
  assert.equal(exported.includes("PermissionPolicyConflictError"), false);
  assert.equal(exported.includes("PermissionPolicyValidationError"), false);
});

test("legacy role sandbox readers are not exported from @simulatorlife/autodev-data", () => {
  const exported = Object.keys(dataExports);
  assert.equal(exported.includes("readRoleSandboxModes"), false);
  assert.equal(exported.includes("roleSandboxMode"), false);
  assert.equal(exported.includes("sandboxModeFromConfig"), false);
  assert.equal(exported.includes("sandboxModeToConfig"), false);
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
