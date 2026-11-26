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

  assert.throws(
    () => updatePermissionPolicy({
      file,
      expectedRevision: permissionPolicyRevision(POLICY_SOURCE),
      update: { webSearch: false }
    }),
    /size bound/u
  );
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
  await writeFile(path.join(sourceDirectory, "permissions.jsonc"), POLICY_SOURCE);
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
  assert.equal(readAppliedPermissionPolicyFile(linkedFile).status, "unavailable");
  assert.deepEqual(readAntigravityCliPermissionDefaults(linkedFile), {
    agentMode: null,
    toolPermission: null
  });
  assert.throws(
    () => updatePermissionPolicy({
      file: linkedFile,
      expectedRevision: permissionPolicyRevision(POLICY_SOURCE),
      update: { webSearch: false }
    }),
    PermissionPolicyValidationError
  );
  assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
});

test("permission reads reject a FIFO without waiting for a writer", {
  skip: process.platform !== "darwin" && process.platform !== "linux"
}, async (t) => {
  const { directory } = await policyFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = path.join(directory, "policy-fifo");
  execFileSync("mkfifo", [fifo]);
  const moduleUrl = new URL(
    "../src/config/permission-policy.ts",
    import.meta.url
  );
  // Isolate the read so a regression to a blocking open cannot hang the suite.
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { readPermissionPolicyFile } from ${JSON.stringify(moduleUrl.href)};
     process.stdout.write(JSON.stringify(readPermissionPolicyFile(process.argv[1])));`,
    fifo
  ], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const read = JSON.parse(child.stdout);
  assert.equal(read.status, "unavailable");
  assert.equal(read.revision, null);
});

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

test("a policy update cannot persist a source above its read limit", async (t) => {
  const { directory, file } = await policyFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(
    () => updatePermissionPolicy({
      file,
      expectedRevision: permissionPolicyRevision(POLICY_SOURCE),
      update: { approvalsReviewer: "x".repeat(1_000_000) }
    }),
    /size bound/u
  );
  assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
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
