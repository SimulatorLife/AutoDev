import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import {
  errorCode,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";
import { sha256 } from "./support/hash.ts";

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
const POLICY_SOURCE = `{
  "version": "1.0.0",
  // Codex CLI defaults for AutoDev
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

interface Fixture {
  readonly repositoryRoot: string;
  readonly policyPath: string;
  readonly codexHome: string;
  readonly root: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-permission-policy-"));
  const repositoryRoot = path.join(root, "repo");
  mkdirSync(path.join(repositoryRoot, ".rulesync"), { recursive: true });
  mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
  mkdirSync(path.join(repositoryRoot, "agents", "roles"), { recursive: true });
  const policyPath = path.join(
    repositoryRoot,
    ".rulesync",
    "permissions.jsonc"
  );
  writeFileSync(policyPath, POLICY_SOURCE, "utf8");
  const codexHome = path.join(root, "codex");
  mkdirSync(codexHome);
  return { repositoryRoot, policyPath, codexHome, root };
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
  options: { readonly repositoryRoot: string; readonly codexHome: string },
  body?: unknown,
  actor: string | null = OPERATOR_ACTOR,
  token: string | null = SERVICE_TOKEN
): Promise<{
  statusCode: number;
  headers: Record<string, string | number>;
  body: Record<string, unknown> | null;
}> {
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
    headers: response.headers,
    body: responseBody(response) as Record<string, unknown> | null
  };
}

test("the permissions read publishes the policy the canonical source states", async () => {
  const options = fixture();
  const result = await call("GET", "/control/permissions", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-permissions-v2");
  assert.equal(result.body?.source, ".rulesync/permissions.jsonc");
  assert.equal(result.body?.readOnly, true);
  assert.equal(result.body?.policyStatus, "valid");
  const policy = result.body?.policy as
    | {
        readonly approvalPolicy: string;
        readonly approvalsReviewer: string;
        readonly webSearch: boolean;
      }
    | undefined;
  assert.equal(policy?.approvalPolicy, "never");
  assert.equal(policy?.approvalsReviewer, "user");
  assert.equal(policy?.webSearch, true);
  // The revision is the handle a write is compared against: the sha256 of the
  // canonical file's exact bytes.
  assert.equal(result.body?.revision, sha256(readFileSync(options.policyPath)));
  // The policy carries no removed sandbox or network keys.
  assert.equal(Object.hasOwn(policy ?? {}, "sandboxMode"), false);
  assert.equal(Object.hasOwn(policy ?? {}, "networkAccess"), false);
});

test("role permissions expose contract readOnly flags", async () => {
  const options = fixture();
  const result = await call("GET", "/control/permissions", options);
  const rolePermissions = result.body?.rolePermissions as
    Record<string, { readonly readOnly: boolean }> | undefined;
  assert.equal(rolePermissions?.orchestrator?.readOnly, false);
  assert.equal(rolePermissions?.explorer?.readOnly, true);
  assert.equal(rolePermissions?.default?.readOnly, false);
});

test("a policy that cannot be read is reported as not observed, not as defaults", async () => {
  const options = fixture();
  writeFileSync(options.policyPath, "{ invalid jsonc\n", "utf8");
  const result = await call("GET", "/control/permissions", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.policyStatus, "invalid");
  assert.equal(result.body?.policy, null);
  assert.equal(typeof result.body?.policyReason, "string");
});

test("Permissions rejects every non-GET method for both authorized roles without changing sources", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  const appliedPath = path.join(options.codexHome, "config.toml");
  const applied = 'approval_policy = "never"\napprovals_reviewer = "user"\n[tools]\nweb_search = true\n';
  writeFileSync(appliedPath, applied);

  for (const actor of [OPERATOR_ACTOR, VIEWER_ACTOR]) {
    const read = await call("GET", "/control/permissions", options, undefined, actor);
    assert.equal(read.statusCode, 200);
    assert.equal(read.body?.readOnly, true);
    assert.deepEqual(read.body?.applied, read.body?.policy);
    for (const method of ["PATCH", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
      const result = await call(method, "/control/permissions", options, {
        expectedRevision: read.body?.revision,
        approvalPolicy: "on-request",
        webSearch: false
      }, actor);
      assert.equal(result.statusCode, 405, `${actor} ${method}`);
      assert.equal(result.headers.allow, "GET");
      assert.equal(errorCode(result.body), "autodev_control_api_method_not_allowed");
      assert.equal(readFileSync(options.policyPath, "utf8"), POLICY_SOURCE);
      assert.equal(readFileSync(appliedPath, "utf8"), applied);
    }
  }
});

test("Permissions reports an external repository edit without applying it", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  const before = await call("GET", "/control/permissions", options);
  const changed = POLICY_SOURCE.replace('"approval_policy": "never"', '"approval_policy": "on-request"');
  writeFileSync(options.policyPath, changed);
  const after = await call("GET", "/control/permissions", options);
  assert.equal(after.statusCode, 200);
  assert.equal(after.body?.readOnly, true);
  assert.notEqual(after.body?.revision, before.body?.revision);
  assert.equal(after.body?.revision, sha256(Buffer.from(changed)));
  assert.equal((after.body?.policy as { approvalPolicy: string }).approvalPolicy, "on-request");
  assert.equal(after.body?.applied, null);
});

test("Permissions rejects unauthenticated reads and writes", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  for (const method of ["GET", "PATCH"]) {
    const result = await call(method, "/control/permissions", options, undefined, OPERATOR_ACTOR, null);
    assert.equal(result.statusCode, 401);
  }
  assert.equal(readFileSync(options.policyPath, "utf8"), POLICY_SOURCE);
});
