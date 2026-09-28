import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const REPO_ROOT = pathResolve(import.meta.dirname, "../..");
const FILTER = join(REPO_ROOT, "src/mcp/tool-filter.ts");

test("stdio MCP tool filter hides ungranted tools and rejects direct calls", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-mcp-tool-filter-"));
  const fakeServer = join(temp, "fake-mcp.mjs");
  writeFileSync(
    fakeServer,
    String.raw`import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
function reply(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (message.method === "tools/list") reply({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "allowed_tool", inputSchema: { type: "object" } }, { name: "hidden_tool", inputSchema: { type: "object" } }] } });
  else if (message.method === "tools/call") reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.name }] } });
});
`,
    { mode: 0o600 }
  );

  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        FILTER,
        process.execPath,
        JSON.stringify([fakeServer]),
        JSON.stringify(["allowed_tool"])
      ],
      { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const messages: Array<Record<string, any>> = [];
    const waiting: Array<{
      resolve: (message: Record<string, any>) => void;
      timer: NodeJS.Timeout;
    }> = [];
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, any>;
      const waiter = waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else messages.push(message);
    });
    const nextMessage = () =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const queued = messages.shift();
        if (queued) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiting.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiting.splice(index, 1);
          reject(new Error(`Timed out waiting for MCP output: ${stderr}`));
        }, 3000);
        timer.unref();
        waiting.push({ resolve, timer });
      });
    const send = (message: Record<string, unknown>) =>
      child!.stdin!.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      }
    });
    assert.equal((await nextMessage()).id, 1);
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await nextMessage();
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      ["allowed_tool"]
    );

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "allowed_tool", arguments: {} }
    });
    const allowed = await nextMessage();
    assert.equal(allowed.id, 3);
    assert.equal(allowed.result.content[0].text, "allowed_tool");

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "hidden_tool", arguments: {} }
    });
    const denied = await nextMessage();
    assert.equal(denied.id, 4);
    assert.equal(denied.error.code, -32_601);
    assert.equal(denied.error.message, "Tool is not enabled for this role");

    child.stdin!.end();
    await once(child, "close");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "close"),
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
