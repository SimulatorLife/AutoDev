import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PermissionPolicyConflictError,
  permissionPolicyGeneration,
  permissionPolicyRevision,
  PermissionPolicyValidationError,
  readPermissionPolicyFile,
  readRoleSandboxModes,
  sandboxModeFromConfig,
  sandboxModeToConfig,
  updatePermissionPolicy
} from "../src/config/permission-policy.ts";

/**
 * The permission policy's own tests.
 *
 * The policy is a TOML file that is mostly comments, and the write edits it in
 * place. These tests hold the two properties that matter: the read answers
 * from the file, and the write changes the key it was asked to change and
 * nothing else -- byte for byte, comments included.
 */

const POLICY_SOURCE = `# The portable source.
model = "autodev/orchestrator"

# The approval policy.
approval_policy = "never"
sandbox_mode = "workspace-write"
approvals_reviewer = "user"

[sandbox_workspace_write]
# Network access for workspace-write sessions.
network_access = true

[tools]
web_search = true

[model_providers.local_model_router]
name = "Local router"
`;

async function policyFixture(
  content: string = POLICY_SOURCE
): Promise<{ readonly directory: string; readonly file: string }> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-permission-policy-")
  );
  const file = path.join(directory, "config.autodev.toml");
  await writeFile(file, content, "utf8");
  return { directory, file };
}

test("the policy is read from the file, not assumed", async () => {
  const { file } = await policyFixture();
  const read = readPermissionPolicyFile(file);
  assert.equal(read.status, "valid");
  if (read.status !== "valid") return;
  assert.equal(read.policy.approvalPolicy, "never");
  assert.equal(read.policy.sandboxMode, "workspace-write");
  assert.equal(read.policy.approvalsReviewer, "user");
  assert.equal(read.policy.networkAccess, true);
  assert.equal(read.policy.webSearch, true);
  assert.equal(
    read.revision,
    permissionPolicyRevision(await readFile(file, "utf8"))
  );
});

test("a source that omits a policy key is invalid, not defaulted", async () => {
  const { file } = await policyFixture(
    'approval_policy = "never"\nsandbox_mode = "workspace-write"\n'
  );
  const read = readPermissionPolicyFile(file);
  assert.equal(read.status, "invalid");
  if (read.status !== "invalid") return;
  assert.match(read.reason, /approvals_reviewer/u);
});

test("a source that is not TOML is invalid rather than unread", async () => {
  const { file } = await policyFixture("approval_policy = \n");
  const read = readPermissionPolicyFile(file);
  assert.equal(read.status, "invalid");
});

test("a policy file that is not there is unavailable, not empty", () => {
  const read = readPermissionPolicyFile(
    path.join(
      tmpdir(),
      "autodev-permission-policy-absent",
      "config.autodev.toml"
    )
  );
  assert.equal(read.status, "unavailable");
  assert.equal(read.revision, null);
});

test("the sandbox vocabulary is translated in one place, both ways", () => {
  assert.equal(sandboxModeFromConfig("read-only"), "read-only");
  assert.equal(sandboxModeFromConfig("workspace-write"), "workspace-write");
  // The product names the unsandboxed mode "unrestricted"; the file names it
  // "danger-full-access". Collapsing the two is what made the Console report
  // the orchestrator as a sandboxed role.
  assert.equal(sandboxModeFromConfig("danger-full-access"), "unrestricted");
  assert.equal(sandboxModeFromConfig("something-else"), null);
  assert.equal(sandboxModeToConfig("unrestricted"), "danger-full-access");
  assert.equal(sandboxModeToConfig("read-only"), "read-only");
});

test("a role's sandbox is the one its own declaration states", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autodev-role-sandbox-"));
  await writeFile(
    path.join(directory, "orchestrator.toml"),
    'name = "orchestrator"\nsandbox_mode = "danger-full-access"\n',
    "utf8"
  );
  await writeFile(
    path.join(directory, "explorer.toml"),
    'name = "explorer"\nsandbox_mode = "read-only"\n',
    "utf8"
  );
  await writeFile(
    path.join(directory, "default.toml"),
    'name = "default"\n',
    "utf8"
  );
  const modes = readRoleSandboxModes(directory, "workspace-write");
  assert.equal(modes.orchestrator, "unrestricted");
  assert.equal(modes.explorer, "read-only");
  // A role that declares no sandbox inherits the policy's: its configuration
  // is layered over the portable source.
  assert.equal(modes.default, "workspace-write");
});

test("a role that declares a sandbox the product does not support is unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autodev-role-sandbox-"));
  await writeFile(
    path.join(directory, "odd.toml"),
    'name = "odd"\nsandbox_mode = "somewhere-else"\n',
    "utf8"
  );
  const modes = readRoleSandboxModes(directory, "workspace-write");
  assert.equal(modes.odd, null);
});

test("a role that declares no sandbox under an unreadable policy has no observed sandbox", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "autodev-role-sandbox-"));
  await writeFile(
    path.join(directory, "default.toml"),
    'name = "default"\n',
    "utf8"
  );
  await writeFile(
    path.join(directory, "explorer.toml"),
    'name = "explorer"\nsandbox_mode = "read-only"\n',
    "utf8"
  );
  // The policy could not be read, so there is no mode for a role that declares
  // none to inherit. The nearest mode the product knows is not a mode any
  // source stated, so the role's sandbox is not observed.
  const modes = readRoleSandboxModes(directory, null);
  assert.equal(modes.default, null);
  // A role that declares its own mode is still known: the policy is only the
  // answer for a role that is silent.
  assert.equal(modes.explorer, "read-only");
});

test("a write changes the key it was asked to change and nothing else", async () => {
  const { file } = await policyFixture();
  const before = await readFile(file, "utf8");
  const revision = permissionPolicyRevision(before);
  const written = updatePermissionPolicy({
    file,
    expectedRevision: revision,
    update: { approvalPolicy: "on-demand" }
  });
  assert.equal(written.changed, true);
  const after = await readFile(file, "utf8");
  assert.match(after, /^approval_policy = "on-demand"$/mu);
  // Every other line is untouched, comments included.
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  const changed = afterLines.filter(
    (line, index) => line !== beforeLines[index]
  );
  assert.deepEqual(changed, ['approval_policy = "on-demand"']);
});

test("a write reaches the key inside its own table", async () => {
  const { file } = await policyFixture();
  const revision = permissionPolicyRevision(await readFile(file, "utf8"));
  updatePermissionPolicy({
    file,
    expectedRevision: revision,
    update: { networkAccess: false, webSearch: false }
  });
  const after = await readFile(file, "utf8");
  assert.match(after, /^network_access = false$/mu);
  assert.match(after, /^web_search = false$/mu);
  // The comment that explains the table is still above it.
  assert.match(
    after,
    /# Network access for workspace-write sessions\.\nnetwork_access = false/u
  );
});

test("a key the source does not carry is added to its own table", async () => {
  const { file } = await policyFixture(
    'approval_policy = "never"\nsandbox_mode = "workspace-write"\napprovals_reviewer = "user"\n\n[sandbox_workspace_write]\n\n[tools]\nweb_search = true\n'
  );
  const revision = permissionPolicyRevision(await readFile(file, "utf8"));
  const written = updatePermissionPolicy({
    file,
    expectedRevision: revision,
    update: { networkAccess: true }
  });
  assert.equal(written.policy.networkAccess, true);
  const after = await readFile(file, "utf8");
  assert.match(after, /\[sandbox_workspace_write\]\nnetwork_access = true/u);
});

test("a write decided on a policy file that has moved is refused", async () => {
  const { file } = await policyFixture();
  const revision = permissionPolicyRevision(await readFile(file, "utf8"));
  await writeFile(file, `${POLICY_SOURCE}\n`, "utf8");
  assert.throws(
    () =>
      updatePermissionPolicy({
        file,
        expectedRevision: revision,
        update: { approvalPolicy: "always" }
      }),
    PermissionPolicyConflictError
  );
  // The file is as the other writer left it.
  assert.match(await readFile(file, "utf8"), /^approval_policy = "never"$/mu);
});

test("a value outside the vocabulary is refused before the file is touched", async () => {
  const { file } = await policyFixture();
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
});

test("a write that changes nothing says so and writes nothing", async () => {
  const { file } = await policyFixture();
  const revision = permissionPolicyRevision(await readFile(file, "utf8"));
  const written = updatePermissionPolicy({
    file,
    expectedRevision: revision,
    update: { approvalPolicy: "never" }
  });
  assert.equal(written.changed, false);
  assert.equal(await readFile(file, "utf8"), POLICY_SOURCE);
});

test("a write that carries the whole policy changes only what differs", async () => {
  const { file } = await policyFixture();
  const before = await readFile(file, "utf8");
  const revision = permissionPolicyRevision(before);
  const written = updatePermissionPolicy({
    file,
    expectedRevision: revision,
    update: {
      // The control that made this write shows the whole policy, so the write
      // carries the whole policy. The other four settings already say what the
      // operator chose, and rewriting them would move the file's bytes for no
      // reason -- which refuses every other operator's write.
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: false,
      webSearch: true
    }
  });
  assert.equal(written.changed, true);
  assert.equal(written.policy.networkAccess, false);
  const after = await readFile(file, "utf8");
  const changed = after
    .split("\n")
    .filter((line, index) => line !== before.split("\n")[index]);
  assert.deepEqual(changed, ["network_access = false"]);
});

test("the generation of a policy is its values, not its bytes", () => {
  const first = permissionPolicyGeneration({
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    networkAccess: true,
    webSearch: true
  });
  const second = permissionPolicyGeneration({
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    networkAccess: true,
    webSearch: true
  });
  assert.equal(first, second);
  const other = permissionPolicyGeneration({
    approvalPolicy: "always",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    networkAccess: true,
    webSearch: true
  });
  assert.notEqual(first, other);
});
