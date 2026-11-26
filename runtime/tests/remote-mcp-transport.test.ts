import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import { startChatgptBackendPool } from "../src/mcp/chatgpt-backend-pool.ts";
import {
  createRemoteMcpTransport,
  remoteTransportErrorMessage
} from "../src/mcp/remote-transport.ts";

const SECRET = "synthetic-private-credential-fixture";
const RPC_ERROR = -32042;

test("remote transport diagnostics never expose raw URLs or exception contents", () => {
  for (const url of [
    `invalid endpoint ${SECRET}`,
    `https://user:${SECRET}@example.invalid/mcp`,
    `file:///tmp/${SECRET}`,
    `https://example.invalid/mcp#${SECRET}`
  ]) {
    assert.throws(
      () => createRemoteMcpTransport({ url }, "fixture", {}),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Invalid remote MCP endpoint." &&
        error.cause === undefined
    );
  }
  assert.equal(
    remoteTransportErrorMessage(new StreamableHTTPError(503, SECRET)),
    "Remote MCP request failed (HTTP 503)."
  );
  for (const error of [
    new StreamableHTTPError(200, SECRET),
    new Error(SECRET),
    { code: 401, message: SECRET },
    SECRET
  ]) {
    assert.equal(remoteTransportErrorMessage(error), "Remote MCP request failed.");
  }
});

async function remoteFixture() {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401).end("fixture credential missing");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
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
      const reply = (fields: Record<string, unknown>) => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, ...fields })
        );
      };
      if (message.method === "initialize") {
        reply({
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "remote-fixture", version: "1" }
          }
        });
      } else if (message.method === "tools/list") {
        reply({
          result: {
            tools: [{ name: "fixture", inputSchema: { type: "object" } }]
          }
        });
      } else if (message.method === "tools/call") {
        switch (message.params.arguments?.mode) {
          case "http":
            res.writeHead(503).end(`upstream diagnostic echoed ${SECRET}`);
            break;
          case "rpc":
            reply({
              error: {
                code: RPC_ERROR,
                message: `upstream diagnostic echoed ${SECRET}`,
                data: { private: SECRET }
              }
            });
            break;
          case "tool-error":
            reply({
              result: {
                isError: true,
                content: [{ type: "text", text: "legitimate tool-level diagnostic" }]
              }
            });
            break;
          default:
            reply({
              result: { content: [{ type: "text", text: "ordinary tool result" }] }
            });
        }
      } else {
        reply({ result: {} });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  };
}

async function assertRemoteBehavior(client: Client): Promise<void> {
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["fixture"]);
  const call = (mode: string) =>
    client.callTool({ name: "fixture", arguments: { mode } });
  await assert.rejects(
    call("http"),
    (error: unknown) =>
      error instanceof McpError &&
      error.message.includes("Remote MCP request failed (HTTP 503).") &&
      !JSON.stringify(error).includes(SECRET) &&
      !String(error).includes(SECRET)
  );
  await assert.rejects(
    call("rpc"),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === RPC_ERROR &&
      error.message.includes("Remote MCP server returned a JSON-RPC error.") &&
      error.data === undefined &&
      !JSON.stringify(error).includes(SECRET)
  );
  const toolError = await call("tool-error");
  assert.equal(toolError.isError, true);
  assert.match(JSON.stringify(toolError), /legitimate tool-level diagnostic/u);
  assert.match(JSON.stringify(await call("success")), /ordinary tool result/u);
}

test("the warm MCP pool redacts upstream HTTP and JSON-RPC diagnostics", { timeout: 30_000 }, async () => {
  const fixture = await remoteFixture();
  let pool: Awaited<ReturnType<typeof startChatgptBackendPool>> | undefined;
  const client = new Client({ name: "remote-error-pool-test", version: "1" });
  try {
    pool = await startChatgptBackendPool({
      version: 1,
      servers: {
        "orchestrator.fixture": {
          kind: "remote",
          url: fixture.url,
          bearer_token_env_var: "FIXTURE_TOKEN",
          tools: ["fixture"]
        }
      }
    }, {
      gatewayEnv: {},
      secretEnv: { FIXTURE_TOKEN: SECRET }
    });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${pool.port}/mcp/orchestrator.fixture`),
      { requestInit: { headers: { Authorization: `Bearer ${pool.token}` } } }
    ));
    await assertRemoteBehavior(client);
  } finally {
    await client.close().catch(() => {});
    await pool?.close();
    await fixture.close();
  }
});

test("the stdio MCP filter redacts upstream diagnostics from replies and stderr", { timeout: 30_000 }, async () => {
  const fixture = await remoteFixture();
  const client = new Client({ name: "remote-error-filter-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve(import.meta.dirname, "../src/mcp/tool-filter.ts"),
      "--remote",
      JSON.stringify({ url: fixture.url, bearer_token_env_var: "FIXTURE_TOKEN" }),
      JSON.stringify(["fixture"]),
      "external",
      "fixture"
    ],
    env: { FIXTURE_TOKEN: SECRET },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    await assertRemoteBehavior(client);
  } finally {
    await client.close().catch(() => {});
    await fixture.close();
  }
  assert.ok(!stderr.includes(SECRET), "remote error logs must not expose credentials");
});
