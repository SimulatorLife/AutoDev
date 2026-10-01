import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";

const REPO_ROOT = new URL("../../", import.meta.url);

async function listen(
  server: ReturnType<typeof createServer>
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind an IP port");
  }
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("stdio close flushes a source-owned MCP span with inherited safe resource context", async () => {
  const exportedBodies: Buffer[] = [];
  const exporter = createServer(async (request, response) => {
    exportedBodies.push(await requestBody(request));
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  const bridge = createServer(async (request, response) => {
    const payload = JSON.parse((await requestBody(request)).toString("utf8"));
    assert.equal(payload.name, "read_file");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "private tool output" }],
        isError: false
      })
    );
  });

  const exporterPort = await listen(exporter);
  const bridgePort = await listen(bridge);
  const child = spawn(
    process.execPath,
    ["runtime/src/mcp/codex-tools-shim.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        AUTODEV_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
        AUTODEV_CLAUDE_TURN: "turn-runtime-test",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${exporterPort}/v1/traces`,
        OTEL_RESOURCE_ATTRIBUTES:
          "autodev.workspace=workspace-runtime-test,autodev.agent.role=worker"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const replies = createInterface({ input: child.stdout });
  const replyLines = replies[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`
    );
    const initialize = await replyLines.next();
    assert.equal(JSON.parse(initialize.value ?? "{}").id, 1);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "read_file",
          arguments: { path: "/private/secret.txt", token: "do-not-export" }
        }
      })}\n`
    );
    const call = await replyLines.next();
    const callReply = JSON.parse(call.value ?? "{}");
    assert.equal(callReply.id, 2);
    assert.equal(callReply.result?.content?.[0]?.text, "private tool output");

    child.stdin.end();
    const [exitCode] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`shim did not shut down: ${stderr}`)),
          5000
        )
      )
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(exportedBodies.length, 1, "shutdown flushes the queued span");

    const wire = Buffer.concat(exportedBodies).toString("utf8");
    for (const expected of [
      "autodev-codex-tools-mcp",
      "workspace-runtime-test",
      "autodev.agent.role",
      "worker",
      "mcp.method.name",
      "tools/call",
      "gen_ai.tool.name",
      "read_file",
      "gen_ai.operation.name",
      "execute_tool"
    ]) {
      assert.ok(
        wire.includes(expected),
        `OTLP export must include ${expected}`
      );
    }
    assert.equal(wire.includes("/private/secret.txt"), false);
    assert.equal(wire.includes("do-not-export"), false);
    assert.equal(wire.includes("private tool output"), false);
  } finally {
    replies.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await Promise.all([close(bridge), close(exporter)]);
  }
});
