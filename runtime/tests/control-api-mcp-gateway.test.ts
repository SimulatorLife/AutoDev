import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ControlApiMcpGateway,
  ControlApiMcpsResponse
} from "@simulatorlife/autodev-core";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import { MCP_GATEWAY_LABEL } from "../src/platform/mcp-gateway-service.ts";
import {
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVICE_TOKEN = "g".repeat(64);
const OPERATOR_ACTOR = "mcp-gateway-operator";

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": OPERATOR_ACTOR
    }
  }) as unknown as IncomingMessage;
}

async function call(
  method: string,
  codexHome: string
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  try {
    const response = responseRecorder();
    await handleControlApiRequest(
      request(method, "/control/mcps"),
      response,
      "/control/mcps",
      { repositoryRoot: REPOSITORY_ROOT, codexHome }
    );
    return { status: response.statusCode, body: responseBody(response) };
  } finally {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
}

async function readGateway(codexHome: string): Promise<ControlApiMcpGateway> {
  const read = await call("GET", codexHome);
  assert.equal(read.status, 200);
  const body = read.body as unknown as ControlApiMcpsResponse;
  assert.equal(body.schema, "autodev-control-mcps-v3");
  return body.gateway;
}

function emptyCodexHome(): string {
  return mkdtempSync(path.join(tmpdir(), "autodev-mcp-gateway-view-"));
}

// Writes the gateway state the installer projects, as a private file.
function writeGatewayState(codexHome: string, content: string): void {
  const directory = path.join(codexHome, "mcp-gateway");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "gateway.json");
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const INSTALLED_STATE = {
  version: 1,
  workspace: "/Users/operator/Projects/example",
  role: "orchestrator",
  roles: ["orchestrator", "reviewer"],
  policyFile: "/Users/operator/AutoDev/.rulesync/permissions.jsonc",
  policyDigest: "a".repeat(64),
  reviewed: { lsp: ["lsp_hover", "lsp_goto_definition"], memory: ["read"] },
  grants: { lsp: ["lsp_hover"] },
  generation: "generation-test",
  mcpPort: 3312,
  node: "/usr/local/bin/node",
  supergateway: "/opt/supergateway/dist/index.js",
  servicePath: "/usr/bin:/bin"
};

test("the MCP catalog reports an uninstalled gateway as not installed and not ready", async () => {
  const gateway = await readGateway(emptyCodexHome());
  assert.equal(gateway.label, MCP_GATEWAY_LABEL);
  assert.equal(gateway.installed, false);
  assert.equal(gateway.ready, false);
  assert.equal(gateway.port, null);
  assert.equal(gateway.readinessUrl, null);
  assert.equal(gateway.generation, null);
  assert.equal(gateway.error, null);
  // Without an installation there is no published endpoint, but the primary
  // role and its reviewed grants are still the canonical role contract's.
  assert.deepEqual(gateway.surfaces, []);
  assert.equal(gateway.role, "orchestrator");
  assert.deepEqual(gateway.grants, gateway.reviewed);
});

test("the MCP catalog publishes the installed gateway's role surfaces and effective grants", async () => {
  const codexHome = emptyCodexHome();
  writeGatewayState(codexHome, JSON.stringify(INSTALLED_STATE));
  const gateway = await readGateway(codexHome);
  assert.equal(gateway.installed, true);
  // The state names a generation whose rendered files are absent, so the
  // service check cannot prove the gateway serves it.
  assert.equal(gateway.ready, false);
  assert.equal(gateway.port, 3312);
  assert.equal(gateway.readinessUrl, "http://127.0.0.1:3312/readyz");
  assert.equal(gateway.generation, "generation-test");
  assert.equal(gateway.workspace, INSTALLED_STATE.workspace);
  assert.equal(gateway.role, "orchestrator");
  assert.deepEqual(gateway.roles, ["orchestrator", "reviewer"]);
  assert.deepEqual(gateway.surfaces, [
    { role: "orchestrator", url: "http://127.0.0.1:3312/orchestrator/mcp" },
    { role: "reviewer", url: "http://127.0.0.1:3312/reviewer/mcp" }
  ]);
  assert.deepEqual(gateway.reviewed, INSTALLED_STATE.reviewed);
  assert.deepEqual(gateway.grants, INSTALLED_STATE.grants);
  assert.equal(gateway.error, null);
});

test("an unreadable gateway state is reported, not mistaken for an absent gateway", async () => {
  const codexHome = emptyCodexHome();
  writeGatewayState(codexHome, "{ not json");
  const gateway = await readGateway(codexHome);
  assert.equal(gateway.installed, false);
  assert.equal(gateway.ready, false);
  assert.equal(gateway.error, "The MCP gateway state could not be read.");
});

test("the gateway view is read-only through the MCP catalog", async () => {
  const write = await call("POST", emptyCodexHome());
  assert.equal(write.status, 405);
});
