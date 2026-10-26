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

const SERVICE_TOKEN = "w".repeat(64);
const OPERATOR_ACTOR = "workspace-mutation-operator";
const VIEWER_ACTOR = "workspace-mutation-viewer";

/**
 * The canonical catalog the write starts from.
 *
 * It declares two workspaces so a write that lands in the wrong place is
 * visible: the entry that changed and the entry that did not are told apart
 * by the file itself.
 */
const CATALOG = `{
  "schema": "autodev-workspaces-v1",
  "workspaces": [
    {
      "id": "SimulatorLife/AutoDev",
      "baseBranch": "main",
      "enabled": true,
      "agentRoles": null
    },
    {
      "id": "SimulatorLife/Colourful-Life",
      "baseBranch": "master",
      "enabled": true,
      "agentRoles": null
    }
  ]
}
`;

interface Fixture {
  readonly repositoryRoot: string;
  readonly catalogPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-workspace-mutation-"));
  const repositoryRoot = path.join(root, "repo");
  mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
  const catalogPath = path.join(repositoryRoot, "config", "workspaces.json");
  writeFileSync(catalogPath, CATALOG, "utf8");
  return { repositoryRoot, catalogPath };
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

test("the workspaces read publishes the revision a write is compared against", async () => {
  const options = fixture();
  const result = await call("GET", "/control/workspaces", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-workspaces-v2");
  assert.equal(result.body?.source, "config/workspaces.json");
  assert.equal(result.body?.readOnly, false);
  assert.equal(result.body?.catalogStatus, "valid");
  // The revision is the handle the write compares against, so it is the
  // sha256 of the catalog's exact bytes on disk.
  assert.equal(
    result.body?.revision,
    sha256(
      readFileSync(
        path.join(options.repositoryRoot, "config", "workspaces.json")
      )
    )
  );
  assert.match(String(result.body?.revision), /^[a-f0-9]{64}$/u);
});

test("a workspace write changes the canonical catalog and answers with the new revision", async () => {
  const options = fixture();
  const read = await call("GET", "/control/workspaces", options);
  const revision = String(read.body?.revision);

  const result = await call(
    "PATCH",
    "/control/workspaces/SimulatorLife/AutoDev",
    options,
    {
      expectedRevision: revision,
      baseBranch: "release",
      agentRoles: ["worker"]
    }
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-workspace-patch-v1");
  assert.equal(result.body?.id, "SimulatorLife/AutoDev");
  assert.equal(result.body?.changed, true);
  assert.notEqual(result.body?.revision, revision);
  const workspace = result.body?.workspace as
    | {
        readonly id: string;
        readonly baseBranch: string;
        readonly enabled: boolean;
        readonly agentRoles: readonly string[] | null;
      }
    | undefined;
  assert.equal(workspace?.id, "SimulatorLife/AutoDev");
  assert.equal(workspace?.baseBranch, "release");
  assert.equal(workspace?.enabled, true);
  assert.deepEqual(workspace?.agentRoles, ["worker"]);

  // The file on disk carries the change, in the shape it already had.
  const written = readFileSync(options.catalogPath, "utf8");
  assert.match(written, /"baseBranch": "release"/u);
  assert.match(written, /"agentRoles": \[\n\s+"worker"\n\s+\]/u);
  assert.ok(written.endsWith("}\n"));
  assert.ok(written.includes('\n  "schema": "autodev-workspaces-v1",\n'));
  // The entry the write did not name is untouched.
  assert.match(written, /"id": "SimulatorLife\/Colourful-Life"/u);
  assert.match(written, /"baseBranch": "master"/u);
  // The answer names the file that is now on disk.
  assert.equal(result.body?.revision, sha256(written));
});

test("a workspace write is refused when the catalog moved since it was read", async () => {
  const options = fixture();
  const read = await call("GET", "/control/workspaces", options);
  const revision = String(read.body?.revision);
  const before = readFileSync(options.catalogPath, "utf8");

  // Another writer changes the catalog first.
  writeFileSync(
    options.catalogPath,
    before.replace('"baseBranch": "master"', '"baseBranch": "trunk"'),
    "utf8"
  );
  const moved = readFileSync(options.catalogPath, "utf8");

  const result = await call(
    "PATCH",
    "/control/workspaces/SimulatorLife/AutoDev",
    options,
    { expectedRevision: revision, enabled: false }
  );
  assert.equal(result.statusCode, 409);
  assert.equal(
    errorCode(result.body),
    "autodev_control_workspace_revision_conflict"
  );
  // The refused write did not touch the file.
  assert.equal(readFileSync(options.catalogPath, "utf8"), moved);
});

test("a malformed workspace write is refused and the catalog is untouched", async () => {
  const options = fixture();
  const read = await call("GET", "/control/workspaces", options);
  const revision = String(read.body?.revision);
  const before = readFileSync(options.catalogPath, "utf8");

  const bodies: readonly unknown[] = [
    // No revision to compare against.
    { enabled: false },
    // A revision that is not one.
    { expectedRevision: "not-a-revision", enabled: false },
    // A field of the wrong type.
    { expectedRevision: revision, enabled: "yes" },
    // A role scope that is not a list of names.
    { expectedRevision: revision, agentRoles: "worker" },
    // An identity is not a field a write may set.
    { expectedRevision: revision, id: "SimulatorLife/Other" },
    // A write that changes nothing.
    { expectedRevision: revision }
  ];
  for (const body of bodies) {
    const result = await call(
      "PATCH",
      "/control/workspaces/SimulatorLife/AutoDev",
      options,
      body
    );
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(
      errorCode(result.body),
      "autodev_control_workspace_invalid_update",
      JSON.stringify(body)
    );
  }
  assert.equal(readFileSync(options.catalogPath, "utf8"), before);
});

test("a write to a workspace the catalog does not declare is refused", async () => {
  const options = fixture();
  const read = await call("GET", "/control/workspaces", options);
  const revision = String(read.body?.revision);
  const before = readFileSync(options.catalogPath, "utf8");

  const result = await call(
    "PATCH",
    "/control/workspaces/SimulatorLife/Nothing",
    options,
    { expectedRevision: revision, enabled: false }
  );
  assert.equal(result.statusCode, 404);
  assert.equal(errorCode(result.body), "autodev_control_workspace_unknown");
  assert.equal(readFileSync(options.catalogPath, "utf8"), before);
});

test("a workspace write without an operator is refused", async () => {
  const options = fixture();
  const read = await call("GET", "/control/workspaces", options);
  const revision = String(read.body?.revision);
  const before = readFileSync(options.catalogPath, "utf8");

  // No credential at all.
  const anonymous = await call(
    "PATCH",
    "/control/workspaces/SimulatorLife/AutoDev",
    options,
    { expectedRevision: revision, enabled: false },
    null,
    null
  );
  assert.equal(anonymous.statusCode, 401);
  assert.equal(errorCode(anonymous.body), "autodev_control_api_unauthorized");

  // A viewer is authorized to read, not to write the canonical catalog.
  const viewer = await call(
    "PATCH",
    "/control/workspaces/SimulatorLife/AutoDev",
    options,
    { expectedRevision: revision, enabled: false },
    VIEWER_ACTOR
  );
  assert.equal(viewer.statusCode, 403);
  assert.equal(errorCode(viewer.body), "autodev_control_api_forbidden");

  assert.equal(readFileSync(options.catalogPath, "utf8"), before);
});

test("a workspace configuration is written through PATCH only", async () => {
  const options = fixture();
  const result = await call(
    "GET",
    "/control/workspaces/SimulatorLife/AutoDev",
    options
  );
  assert.equal(result.statusCode, 405);
  assert.equal(result.body?.error !== undefined, true);
});
