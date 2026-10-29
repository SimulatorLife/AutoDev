import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "p".repeat(64);
const OPERATOR_ACTOR = "permission-policy-operator";
const VIEWER_ACTOR = "permission-policy-viewer";

/**
 * The canonical policy the write starts from.
 *
 * It is written the way the portable source is written: mostly comments, with
 * the settings spread across the top level and two tables. A write that
 * re-serialised the file would drop every comment, and the comment above
 * `network_access` is the one that says what the setting is for.
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
`;

const ROLE_SOURCE = `name = "orchestrator"
sandbox_mode = "danger-full-access"
`;

const READ_ONLY_ROLE_SOURCE = `name = "explorer"
sandbox_mode = "read-only"
`;

/**
 * A role that declares no sandbox of its own.
 *
 * It is silent about its mode, so the policy is the answer -- which makes it
 * the role that says whether the policy was read.
 */
const SILENT_ROLE_SOURCE = `name = "worker"
`;

interface Fixture {
  readonly repositoryRoot: string;
  readonly policyPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-permission-policy-"));
  const repositoryRoot = path.join(root, "repo");
  mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
  mkdirSync(path.join(repositoryRoot, "agents", "roles"), { recursive: true });
  const policyPath = path.join(repositoryRoot, "config", "config.autodev.toml");
  writeFileSync(policyPath, POLICY_SOURCE, "utf8");
  writeFileSync(
    path.join(repositoryRoot, "agents", "roles", "orchestrator.toml"),
    ROLE_SOURCE,
    "utf8"
  );
  writeFileSync(
    path.join(repositoryRoot, "agents", "roles", "explorer.toml"),
    READ_ONLY_ROLE_SOURCE,
    "utf8"
  );
  writeFileSync(
    path.join(repositoryRoot, "agents", "roles", "worker.toml"),
    SILENT_ROLE_SOURCE,
    "utf8"
  );
  return { repositoryRoot, policyPath };
}

async function withControlApiCredential<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  const previousViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  process.env.AUTODEV_CONTROL_VIEWERS = VIEWER_ACTOR;
  return run().finally(() => {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
    if (previousViewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = previousViewers;
  });
}

function request(
  method: string,
  url: string,
  body?: unknown,
  actor: string | null = OPERATOR_ACTOR,
  token: string | null = SERVICE_TOKEN
): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload))
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (actor !== null) headers["x-autodev-actor"] = actor;
  return Object.assign(Readable.from([payload]), {
    method,
    url,
    headers
  }) as unknown as IncomingMessage;
}

async function call(
  method: string,
  url: string,
  options: { readonly repositoryRoot: string },
  body?: unknown,
  actor: string | null = OPERATOR_ACTOR,
  token: string | null = SERVICE_TOKEN
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
  const response = responseRecorder();
  await withControlApiCredential(async () => {
    await handleControlApiRequest(
      request(method, url, body, actor, token),
      response,
      url,
      options
    );
  });
  return {
    statusCode: response.statusCode,
    body: responseBody(response) as Record<string, unknown> | null
  };
}

function errorCode(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error as { readonly code?: string } | undefined;
  return error?.code;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the permissions read publishes the policy the canonical source states", async () => {
  const options = fixture();
  const result = await call("GET", "/control/permissions", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-permissions-v2");
  assert.equal(result.body?.source, "config/config.autodev.toml");
  assert.equal(result.body?.policyStatus, "valid");
  const policy = result.body?.policy as
    | {
        readonly approvalPolicy: string;
        readonly sandboxMode: string;
        readonly approvalsReviewer: string;
        readonly networkAccess: boolean;
        readonly webSearch: boolean;
      }
    | undefined;
  assert.equal(policy?.approvalPolicy, "never");
  assert.equal(policy?.sandboxMode, "workspace-write");
  assert.equal(policy?.approvalsReviewer, "user");
  assert.equal(policy?.networkAccess, true);
  assert.equal(policy?.webSearch, true);
  // The revision is the handle a write is compared against: the sha256 of the
  // canonical file's exact bytes.
  assert.equal(result.body?.revision, sha256(readFileSync(options.policyPath)));
  // The policy carries no `defaultToolsApprovalMode`: no canonical source
  // declared one, so it was a value the product invented.
  assert.equal(Object.hasOwn(policy ?? {}, "defaultToolsApprovalMode"), false);
});

test("a role's sandbox is the one its own declaration states", async () => {
  const options = fixture();
  const result = await call("GET", "/control/permissions", options);
  const rolePermissions = result.body?.rolePermissions as
    Record<string, { readonly sandboxMode: string | null }> | undefined;
  // The orchestrator declares `danger-full-access`. The read used to answer
  // every role but the read-only ones with "workspace-write", so the product's
  // unsandboxed role was published as a sandboxed one.
  assert.equal(rolePermissions?.orchestrator?.sandboxMode, "unrestricted");
  assert.equal(rolePermissions?.explorer?.sandboxMode, "read-only");
  // A role that declares no sandbox inherits the policy's: its configuration
  // is layered over the portable source. This is the mode the policy states.
  assert.equal(rolePermissions?.worker?.sandboxMode, "workspace-write");
});

test("a policy that cannot be read is reported as not observed, not as defaults", async () => {
  const options = fixture();
  writeFileSync(options.policyPath, "approval_policy = \n", "utf8");
  const result = await call("GET", "/control/permissions", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.policyStatus, "invalid");
  assert.equal(result.body?.policy, null);
  assert.equal(typeof result.body?.policyReason, "string");

  const rolePermissions = result.body?.rolePermissions as
    Record<string, { readonly sandboxMode: string | null }> | undefined;
  // A role that declares no sandbox inherits the policy's, and the policy
  // could not be read: there is no mode to inherit, so the role's sandbox is
  // not observed. It used to be published as `workspace-write`, which named a
  // role as sandboxed on the strength of a policy nobody read.
  assert.equal(rolePermissions?.worker?.sandboxMode, null);
  // A role that declares its own mode is still known: the policy is only the
  // answer for a role that is silent.
  assert.equal(rolePermissions?.orchestrator?.sandboxMode, "unrestricted");
});

test("a policy write changes the canonical source and answers with the new revision", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);

  const result = await call("PATCH", "/control/permissions", options, {
    expectedRevision: revision,
    approvalPolicy: "on-demand",
    sandboxMode: "read-only",
    approvalsReviewer: "operator",
    networkAccess: false,
    webSearch: false
  });
  // The compose step runs the RuleSync projection and the install's own
  // materializer, which need the repository's own toolchain. A fixture
  // repository has none, so the write reports the applied state it could not
  // refresh rather than claiming the policy was applied.
  assert.ok(
    result.statusCode === 200 || result.statusCode === 503,
    `unexpected status ${result.statusCode}`
  );
  if (result.statusCode === 503) {
    assert.equal(
      errorCode(result.body),
      "autodev_control_permission_policy_apply_failed"
    );
  }

  // The canonical source carries the change either way: the policy was
  // written, and only the applied configuration could not be refreshed.
  const written = readFileSync(options.policyPath, "utf8");
  assert.match(written, /^approval_policy = "on-demand"$/mu);
  assert.match(written, /^sandbox_mode = "read-only"$/mu);
  assert.match(written, /^approvals_reviewer = "operator"$/mu);
  assert.match(written, /^network_access = false$/mu);
  assert.match(written, /^web_search = false$/mu);
  // The file is edited in place: the comments are the explanation of what
  // each setting means, and they are still there.
  assert.match(
    written,
    /# Network access for workspace-write sessions\.\nnetwork_access = false/u
  );
  assert.match(written, /^# The approval policy\.$/mu);
});

test("a policy write that carries the whole policy changes only what differs", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);
  const before = readFileSync(options.policyPath, "utf8");

  const result = await call("PATCH", "/control/permissions", options, {
    expectedRevision: revision,
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
    approvalsReviewer: "user",
    networkAccess: false,
    webSearch: true
  });
  assert.ok(
    result.statusCode === 200 || result.statusCode === 503,
    `unexpected status ${result.statusCode}`
  );
  const after = readFileSync(options.policyPath, "utf8");
  const changed = after
    .split("\n")
    .filter((line, index) => line !== before.split("\n")[index]);
  assert.deepEqual(changed, ["network_access = false"]);
});

test("a policy write is refused when the canonical source moved since it was read", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);

  // Another writer changes the policy first.
  writeFileSync(
    options.policyPath,
    POLICY_SOURCE.replace(
      'approval_policy = "never"',
      'approval_policy = "always"'
    ),
    "utf8"
  );

  const result = await call("PATCH", "/control/permissions", options, {
    expectedRevision: revision,
    approvalPolicy: "on-demand"
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    errorCode(result.body),
    "autodev_control_permission_policy_revision_conflict"
  );
  // The file is as the other writer left it.
  assert.match(
    readFileSync(options.policyPath, "utf8"),
    /^approval_policy = "always"$/mu
  );
});

test("a policy write that cannot be expressed is refused before the file is touched", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);

  const result = await call("PATCH", "/control/permissions", options, {
    expectedRevision: revision,
    sandboxMode: "somewhere-else"
  });
  assert.equal(result.statusCode, 400);
  assert.equal(
    errorCode(result.body),
    "autodev_control_permission_policy_invalid_update"
  );
  assert.equal(readFileSync(options.policyPath, "utf8"), POLICY_SOURCE);
});

test("a policy write needs a viewer to be an operator", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);

  const result = await call(
    "PATCH",
    "/control/permissions",
    options,
    { expectedRevision: revision, approvalPolicy: "always" },
    VIEWER_ACTOR
  );
  assert.equal(result.statusCode, 403);
  assert.equal(readFileSync(options.policyPath, "utf8"), POLICY_SOURCE);
});

test("a policy write without a credential is refused", async () => {
  const options = fixture();
  const read = await call("GET", "/control/permissions", options);
  const revision = String(read.body?.revision);

  const result = await call(
    "PATCH",
    "/control/permissions",
    options,
    { expectedRevision: revision, approvalPolicy: "always" },
    OPERATOR_ACTOR,
    null
  );
  assert.equal(result.statusCode, 401);
  assert.equal(readFileSync(options.policyPath, "utf8"), POLICY_SOURCE);
});
