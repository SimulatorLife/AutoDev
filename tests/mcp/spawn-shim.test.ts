import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type RequestRecord = { path: string; body: JsonObject };

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const shimPath = join(repoRoot, "src/mcp/spawn-shim.ts");

async function readJsonLine(
  child: ChildProcessWithoutNullStreams
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      child.stdout.off("data", onData);
      try {
        const value: unknown = JSON.parse(line);
        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        )
          resolve(value as JsonObject);
        else reject(new Error("spawn shim returned a non-object response"));
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });
}

function send(
  child: ChildProcessWithoutNullStreams,
  message: JsonObject
): Promise<JsonObject> {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return readJsonLine(child);
}

async function closeChild(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  child.stdin.end();
  if (!child.killed) child.kill();
  await once(child, "close").catch(() => undefined);
}

async function withBridge(
  handler: (requests: RequestRecord[]) => JsonObject,
  run: (url: string, requests: RequestRecord[]) => Promise<void>
): Promise<void> {
  const requests: RequestRecord[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = {};
        }
        const record: RequestRecord = {
          path: request.url ?? "",
          body:
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
              ? (parsed as JsonObject)
              : {}
        };
        requests.push(record);
        const payload = handler(requests);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}

test("spawn shim preserves initialize and gated tools/list protocol", async () => {
  await withBridge(
    (requests) =>
      requests.at(-1)?.path.endsWith("/attach") ? { spawnAllowed: true } : {},
    async (url) => {
      const child = spawn(process.execPath, [shimPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AUTODEV_BRIDGE_URL: url,
          AUTODEV_SPAWN_SESSION: "session-1"
        },
        stdio: "pipe"
      });
      try {
        const initialized = await send(child, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-01-01" }
        });
        assert.deepEqual(initialized.result, {
          protocolVersion: "2025-01-01",
          capabilities: { tools: {} },
          serverInfo: { name: "autodev-spawn", version: "1.0.0" }
        });
        const listed = await send(child, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        });
        const tools = (listed.result as JsonObject).tools as JsonObject[];
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.name, "spawn_subagent");
      } finally {
        await closeChild(child);
      }
    }
  );
});

test("spawn shim forwards a valid call and returns bridge text", async () => {
  await withBridge(
    (requests) =>
      requests.at(-1)?.path.endsWith("/call")
        ? { text: "Dispatched 1 subagent." }
        : { spawnAllowed: true },
    async (url, requests) => {
      const child = spawn(process.execPath, [shimPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          AUTODEV_BRIDGE_URL: url,
          AUTODEV_SPAWN_SESSION: "session-2"
        },
        stdio: "pipe"
      });
      try {
        const response = await send(child, {
          jsonrpc: "2.0",
          id: "call-1",
          method: "tools/call",
          params: {
            name: "spawn_subagent",
            arguments: {
              children: [{ agent_type: "explorer", message: "audit" }]
            }
          }
        });
        assert.deepEqual(response.result, {
          content: [{ type: "text", text: "Dispatched 1 subagent." }]
        });
        const call = requests.find((request) => request.path.endsWith("/call"));
        assert.deepEqual(call?.body.children, [
          { agent_type: "explorer", message: "audit" }
        ]);
        assert.equal(call?.body.session, "session-2");
      } finally {
        await closeChild(child);
      }
    }
  );
});

test("spawn shim rejects malformed and unknown calls as model-readable errors", async () => {
  await withBridge(
    () => ({ spawnAllowed: false }),
    async (url) => {
      const child = spawn(process.execPath, [shimPath], {
        cwd: repoRoot,
        env: { ...process.env, AUTODEV_BRIDGE_URL: url },
        stdio: "pipe"
      });
      try {
        const unknown = await send(child, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "other" }
        });
        assert.deepEqual(unknown.error, {
          code: -32_602,
          message: "unknown tool: other"
        });
        const malformed = await send(child, {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "spawn_subagent", arguments: {} }
        });
        assert.deepEqual(malformed.result, {
          content: [
            {
              type: "text",
              text: "spawn_subagent requires a non-empty `children` array."
            }
          ],
          isError: true
        });
        const listed = await send(child, {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/list"
        });
        assert.deepEqual(listed.result, { tools: [] });
      } finally {
        await closeChild(child);
      }
    }
  );
});
