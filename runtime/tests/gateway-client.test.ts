import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempDisposableSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureLocalAdmission } from "../src/mcp/gateway-admission.ts";
import { SESSION_GRANT_META_KEY } from "../src/mcp/session-grant.ts";

test("gateway adapter releases its HTTP session on stdin EOF and hides transport error bodies", {
  timeout: 15_000
}, async () => {
  using root = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-gateway-client-")
  );
  const home = realpathSync(root.path);
  const codexHome = path.join(home, ".codex");
  const workspace = path.join(home, "project");
  mkdirSync(workspace);
  ensureLocalAdmission(codexHome);
  const sentinel = "synthetic-private-upstream-error";
  const protocolVersions: Array<string | string[] | undefined> = [];
  let deleted = 0;
  let admitted = false;
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      if (req.headers["mcp-session-id"] === "fixture-session") deleted += 1;
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "fixture-session"
        }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "initialize") {
        reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "gateway-fixture", version: "1" }
        });
      } else if (message.method === "tools/call") {
        protocolVersions.push(req.headers["mcp-protocol-version"]);
        admitted = typeof message.params._meta?.[SESSION_GRANT_META_KEY] === "string";
        if (message.params.arguments?.fail) {
          res.writeHead(503).end(sentinel);
        } else {
          // Tool output is not an initialization response.
          reply({
            content: [{ type: "text", text: "fixture" }],
            protocolVersion: "not-a-negotiated-version"
          });
        }
      } else {
        reply({ tools: [] });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    path.join(codexHome, "mcp-gateway", "gateway.json"),
    JSON.stringify({ mcpPort: address.port }),
    { mode: 0o600 }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve(import.meta.dirname, "../src/mcp/gateway-client.ts"),
      "commands"
    ],
    cwd: workspace,
    env: { HOME: home, CODEX_HOME: codexHome, AUTODEV_HOME: path.join(home, ".autodev") },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "gateway-adapter-test", version: "1" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const call = (fail: boolean) =>
      client.callTool({ name: "fixture", arguments: { fail } });
    assert.match(JSON.stringify(await call(false)), /fixture/u);
    await assert.rejects(call(true), (error: unknown) =>
      error instanceof Error &&
      error.message.includes("HTTP 503") &&
      !error.message.includes(sentinel)
    );
    assert.ok(admitted);
    assert.equal(protocolVersions.length, 2);
    assert.ok(protocolVersions[0]);
    assert.equal(protocolVersions[0], protocolVersions[1]);
    await client.close();
    assert.equal(deleted, 1);
    assert.doesNotMatch(stderr, new RegExp(sentinel, "u"));
  } finally {
    await client.close().catch(() => {});
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
});
