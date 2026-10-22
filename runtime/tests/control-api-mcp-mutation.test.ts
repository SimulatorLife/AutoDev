import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVICE_TOKEN = "m".repeat(64);
const OPERATOR_ACTOR = "mcp-mutation-operator";

/**
 * The canonical declaration the write starts from.
 *
 * It is the repository's own declaration, because the roles the projection is
 * rendered against name the servers it declares, and a declaration that left
 * one of them out would fail to render. A comment is added so the write has a
 * comment to preserve.
 */
const DECLARATION = readFileSync(
  path.join(REPOSITORY_ROOT, ".rulesync", "mcp.jsonc"),
  "utf8"
).replace(/^\{/u, "{\n  // The shared declaration.");

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from([payload]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": OPERATOR_ACTOR,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload))
    }
  }) as unknown as IncomingMessage;
}

/**
 * A repository root and a Codex home.
 *
 * The projection is generated from the declaration by RuleSync and applied to
 * the Codex home, so the fixture carries the repository's own configuration
 * and roles: they are what the projection is rendered against.
 */
function fixture(): {
  readonly repositoryRoot: string;
  readonly codexHome: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mcp-mutation-"));
  const repositoryRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex");
  mkdirSync(path.join(repositoryRoot, ".rulesync"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".rulesync", "mcp.jsonc"),
    DECLARATION,
    "utf8"
  );
  cpSync(
    path.join(REPOSITORY_ROOT, "config"),
    path.join(repositoryRoot, "config"),
    { recursive: true }
  );
  cpSync(
    path.join(REPOSITORY_ROOT, "agents"),
    path.join(repositoryRoot, "agents"),
    { recursive: true }
  );
  // RuleSync is a repository dependency, so the projection is generated with
  // the repository's own copy of it.
  symlinkSync(
    path.join(REPOSITORY_ROOT, "node_modules"),
    path.join(repositoryRoot, "node_modules"),
    "dir"
  );
  return { repositoryRoot, codexHome };
}

/**
 * The credential the Control API requires, installed for the duration of the
 * request and removed again afterwards.
 */
async function withControlApiCredential<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  return run().finally(() => {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  });
}

async function call(
  method: string,
  url: string,
  options: { readonly repositoryRoot: string; readonly codexHome: string },
  body?: unknown
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
  const response = responseRecorder();
  await withControlApiCredential(async () => {
    await handleControlApiRequest(
      request(method, url, body),
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

test("the MCP catalog carries the revision a write is compared against", async () => {
  const options = fixture();
  const result = await call("GET", "/control/mcps", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-mcps-v2");
  // The revision is the handle the write compares against, so it is present
  // and it is a digest rather than a counter.
  assert.match(String(result.body?.revision), /^[a-f0-9]{64}$/u);
});

test("a canonical MCP write changes the declaration and the applied configuration", async () => {
  const options = fixture();
  const catalog = await call("GET", "/control/mcps", options);
  const revision = String(catalog.body?.revision);

  const result = await call("PATCH", "/control/mcps/lsp", options, {
    expectedRevision: revision,
    launch: { command: "node", args: ["server.js"] }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-mcp-server-patch-v1");
  assert.equal(result.body?.name, "lsp");
  assert.equal(result.body?.target, "codexcli");
  assert.equal(result.body?.changed, true);
  assert.notEqual(result.body?.revision, revision);

  // The canonical declaration carries the new launch configuration, and the
  // target's own approval mode survived the write.
  const declaration = readFileSync(
    path.join(options.repositoryRoot, ".rulesync", "mcp.jsonc"),
    "utf8"
  );
  assert.match(declaration, /"command": "node"/u);
  assert.match(declaration, /"default_tools_approval_mode": "approve"/u);
  // The comment outside the edited entry is still there.
  assert.match(declaration, /The shared declaration\./u);

  // The applied configuration is the new one, not the one that was declared
  // before the write.
  const catalogue = JSON.parse(
    readFileSync(
      path.join(options.codexHome, "provider-runtime", "mcp-servers.json"),
      "utf8"
    )
  ) as Record<string, { command?: string; args?: string[] }>;
  assert.equal(catalogue.lsp?.command, "node");
  assert.deepEqual(catalogue.lsp?.args, ["server.js"]);

  // The runtime observed what it published, so the two agree.
  const reconciliation = result.body?.reconciliation as {
    status: { convergence: string };
  };
  assert.equal(reconciliation.status.convergence, "converged");
});

test("a canonical MCP write is refused when the declaration changed since it was read", async () => {
  const options = fixture();
  const catalog = await call("GET", "/control/mcps", options);
  const revision = String(catalog.body?.revision);

  // Another writer changes the declaration first.
  const declarationPath = path.join(
    options.repositoryRoot,
    ".rulesync",
    "mcp.jsonc"
  );
  writeFileSync(declarationPath, `${DECLARATION}\n`, "utf8");

  const result = await call("PATCH", "/control/mcps/lsp", options, {
    expectedRevision: revision,
    launch: { command: "node" }
  });
  // The write was decided on an older declaration, so it is refused rather
  // than applied over the newer one.
  assert.equal(result.statusCode, 409);
  assert.equal(
    (result.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_mcp_revision_conflict"
  );
  // The declaration the other writer left is untouched.
  assert.match(readFileSync(declarationPath, "utf8"), /"command": "bash"/u);
});

test("a canonical MCP write is refused for a body that is not a launch configuration", async () => {
  const options = fixture();
  const catalog = await call("GET", "/control/mcps", options);
  const result = await call("PATCH", "/control/mcps/lsp", options, {
    expectedRevision: String(catalog.body?.revision),
    launch: { command: 42 }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(
    (result.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_api_invalid_body"
  );
});

test("a canonical MCP write is refused without the operator credential", async () => {
  const options = fixture();
  const catalog = await call("GET", "/control/mcps", options);
  const response = responseRecorder();
  await handleControlApiRequest(
    makeRequest("PATCH", "/control/mcps/lsp"),
    response,
    "/control/mcps/lsp",
    options
  );
  assert.notEqual(response.statusCode, 200);
  // The declaration is unchanged, because the request was never authorized.
  assert.match(
    readFileSync(
      path.join(options.repositoryRoot, ".rulesync", "mcp.jsonc"),
      "utf8"
    ),
    /"command": "bash"/u
  );
  assert.ok(catalog.body);
});

test("the MCP declaration a write targets is the one the runtime applies", async () => {
  const options = fixture();
  const catalog = await call("GET", "/control/mcps", options);
  const result = await call(
    "PATCH",
    "/control/mcps/openaiDeveloperDocs",
    options,
    {
      expectedRevision: String(catalog.body?.revision),
      launch: { url: "https://other.test/mcp" }
    }
  );
  assert.equal(result.statusCode, 200);
  // The declaration the target receives is the one that changed, and the
  // shared declaration is left alone: a target's own declaration is its own.
  const declaration = readFileSync(
    path.join(options.repositoryRoot, ".rulesync", "mcp.jsonc"),
    "utf8"
  );
  assert.match(declaration, /https:\/\/other\.test\/mcp/u);
  assert.match(declaration, /https:\/\/developers\.openai\.com\/mcp/u);
  const catalogue = JSON.parse(
    readFileSync(
      path.join(options.codexHome, "provider-runtime", "mcp-servers.json"),
      "utf8"
    )
  ) as Record<string, { url?: string }>;
  assert.equal(catalogue.openaiDeveloperDocs?.url, "https://other.test/mcp");
  assert.ok(existsSync(path.join(options.codexHome, "config.toml")));
});
