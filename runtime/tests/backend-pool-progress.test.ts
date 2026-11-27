import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { startChatgptBackendPool } from "../src/mcp/chatgpt-backend-pool.ts";

test(
  "pooled MCP progress is scoped to pending requests, not broadcast across sessions",
  {
    timeout: 30_000
  },
  async (t) => {
    const temporary = mkdtempDisposableSync(
      path.join(tmpdir(), "autodev-progress-")
    );
    const script = path.join(temporary.path, "backend.mjs");
    writeFileSync(
      script,
      String.raw`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const progress = (progressToken, message) => send({
  method: "notifications/progress",
  params: { progressToken, progress: 1, message }
});
const finish = (request) => send({ id: request.id, result: {
  content: [{ type: "text", text: request.params.arguments.label }]
} });
const calls = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "progress-fixture", version: "1" }
    } });
  } else if (request.method === "tools/call") {
    if (request.params.arguments.label === "no-token") {
      progress(request.id, "unrequested");
      finish(request);
      return;
    }
    calls.push(request);
    if (calls.length !== 2) return;
    const [first, second] = calls;
    for (const call of calls) {
      progress(call.params._meta.progressToken, call.params.arguments.label);
    }
    progress("not-a-request", "unsolicited");
    send({ method: "notifications/tools/list_changed", params: { _meta: { private: "fixture-private" } } });
    finish(first);
    progress(first.params._meta.progressToken, "late");
    finish(second);
  }
});
`
    );
    let pool: Awaited<ReturnType<typeof startChatgptBackendPool>> | undefined;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, t.signal]);
    try {
      pool = await startChatgptBackendPool(
        {
          version: 1,
          servers: {
            fixture: {
              kind: "stdio",
              server: "fixture",
              command: process.execPath,
              args: [script],
              cwd: temporary.path,
              tools: ["echo"]
            }
          }
        },
        { gatewayEnv: {}, idleTimeoutMs: 0 }
      );
      const url = `http://127.0.0.1:${pool.port}/mcp/fixture`;
      const headers = {
        authorization: `Bearer ${pool.token}`,
        "content-type": "application/json"
      };
      const request = (sessionId: string | null, body: unknown) =>
        fetch(url, {
          method: "POST",
          headers: sessionId
            ? { ...headers, "mcp-session-id": sessionId }
            : headers,
          body: JSON.stringify(body),
          signal
        });
      const open = async () => {
        const response = await request(null, {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} }
        });
        assert.equal(response.status, 200);
        const id = response.headers.get("mcp-session-id");
        assert.ok(id);
        assert.ok((await response.json()).result);
        const stream = await fetch(url, {
          headers: {
            ...headers,
            "mcp-session-id": id,
            accept: "text/event-stream"
          },
          signal
        });
        assert.equal(stream.status, 200);
        // Consume each stream concurrently; DELETE ends it deterministically.
        const events = stream.text();
        // A failed assertion can close the stream before we await its body.
        void events.catch(() => undefined);
        return { id, events };
      };
      const [a, b] = await Promise.all([open(), open()]);
      const call = (id: string, label: string, withProgress = true) =>
        request(id, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { label },
            ...(withProgress ? { _meta: { progressToken: 0 } } : {})
          }
        });
      const [first, second] = await Promise.all([
        call(a.id, "first"),
        call(b.id, "second")
      ]);
      assert.equal((await first.json()).result.content[0].text, "first");
      assert.equal((await second.json()).result.content[0].text, "second");
      assert.equal(
        (await (await call(a.id, "no-token", false)).json()).result.content[0]
          .text,
        "no-token"
      );
      for (const session of [a, b]) {
        const closed = await fetch(url, {
          method: "DELETE",
          headers: { ...headers, "mcp-session-id": session.id },
          signal
        });
        assert.equal(closed.status, 204);
      }
      const notifications = async (stream: Promise<string>) => {
        const messages = (await stream)
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        assert.deepEqual(
          messages.filter(
            (message) => message.method === "notifications/tools/list_changed"
          ),
          [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]
        );
        return messages
          .filter(
            (message) => message.method !== "notifications/tools/list_changed"
          )
          .map((message) => ProgressNotificationSchema.parse(message).params);
      };
      assert.deepEqual(await notifications(a.events), [
        { progressToken: 0, progress: 1, message: "first" }
      ]);
      assert.deepEqual(await notifications(b.events), [
        { progressToken: 0, progress: 1, message: "second" }
      ]);
      assert.equal(pool.stats().fixture?.spawns, 1);
    } finally {
      abort.abort();
      await pool?.close();
      temporary.remove();
    }
  }
);
