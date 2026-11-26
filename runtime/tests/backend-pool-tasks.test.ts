import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  CreateTaskResultSchema,
  TaskSchema
} from "@modelcontextprotocol/sdk/types.js";

import { startChatgptBackendPool } from "../src/mcp/chatgpt-backend-pool.ts";

const TTL_MS = 500;
const IDLE_MS = 80;

async function fixture(conversationScoped = false) {
  const temporary = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-pool-task-")
  );
  try {
    const script = path.join(temporary.path, "backend.mjs");
    writeFileSync(script, String.raw`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const tasks = new Map();
let next = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize") {
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, tasks: {} },
      serverInfo: { name: "task-fixture", version: "1" } });
  } else if (request.method === "tools/call") {
    if (request.params.arguments?.loseReply) return;
    if (request.params.task) {
      const taskId = String(++next);
      const now = new Date().toISOString();
      const task = { taskId, status: "working", createdAt: now, lastUpdatedAt: now, ttl: ${TTL_MS} };
      tasks.set(taskId, task);
      reply({ task });
    } else {
      if (request.params.arguments?.finishAll) {
        for (const task of tasks.values()) {
          task.status = "completed";
          task.lastUpdatedAt = new Date().toISOString();
          send({ method: "notifications/tasks/status", params: task });
        }
      }
      reply({ content: [{ type: "text", text: "ordinary" }] });
    }
  } else if (request.method === "tasks/get") {
    const task = tasks.get(request.params.taskId);
    if (!task) {
      send({ id: request.id, error: { code: -32602, message: "Unknown task" } });
      return;
    }
    if (request.params._meta?.finishFixture) {
      task.status = "completed";
      task.lastUpdatedAt = new Date().toISOString();
    }
    reply(task);
  } else if (request.method === "tasks/result") {
    reply({ content: [{ type: "text", text: "retained result" }] });
  } else if (request.method === "tasks/list") {
    reply({ tasks: [...tasks.values()] });
  } else if (request.method === "tasks/cancel") {
    const task = tasks.get(request.params.taskId);
    task.status = "cancelled";
    reply(task);
  }
});
`);
    const pool = await startChatgptBackendPool(
      {
        version: 1,
        servers: {
          fixture: {
            kind: "stdio",
            server: "fixture",
            command: process.execPath,
            args: [script],
            cwd: temporary.path,
            tools: ["echo"],
            ...(conversationScoped
              ? {
                  conversationScopedEnv: "AUTODEV_XACPX_COORDINATOR_SESSION",
                  env: { AUTODEV_XACPX_COORDINATOR_SESSION: "fixture" }
                }
              : {})
          }
        }
      },
      {
        gatewayEnv: {},
        idleTimeoutMs: IDLE_MS,
        toolCallTimeoutMs: 800,
        maxConversations: 1
      }
    );
    const url = `http://127.0.0.1:${pool.port}/mcp/fixture`;
    const headers = {
      authorization: `Bearer ${pool.token}`,
      "content-type": "application/json"
    };
    const request = async (session: string | null, method: string, params: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: session ? { ...headers, "mcp-session-id": session } : headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(5_000)
      });
      assert.equal(response.status, 200);
      return { session: response.headers.get("mcp-session-id"), body: await response.json() };
    };
    const open = async () => {
      const response = await request(null, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {}
      });
      assert.ok(response.session);
      assert.ok(response.body.result);
      return response.session;
    };
    return {
      pool,
      open,
      request,
      close: async () => {
        try {
          await pool.close();
        } finally {
          temporary.remove();
        }
      }
    };
  } catch (error) {
    temporary.remove();
    throw error;
  }
}

async function waitForReap(
  pool: Awaited<ReturnType<typeof startChatgptBackendPool>>,
  signal: AbortSignal
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!pool.stats().fixture?.running) return;
    await delay(30, undefined, { signal });
  }
  assert.fail("backend did not become idle after the task retention window");
}

test("native task handles retain their backend past idle and unrelated RPC timeout", {
  timeout: 15_000
}, async (t) => {
  const f = await fixture();
  try {
    const session = await f.open();
    const call = (params: unknown) => f.request(session, "tools/call", params);
    const { body } = await call({ name: "echo", arguments: {}, task: { ttl: TTL_MS } });
    const { task } = CreateTaskResultSchema.parse(body.result);
    assert.equal(f.pool.stats().fixture?.retainedTasks, 1);
    assert.equal(f.pool.stats().fixture?.activeCalls, 0);
    await delay(TTL_MS + IDLE_MS, undefined, { signal: t.signal });
    assert.equal(f.pool.stats().fixture?.running, true);
    const lost = await call({ name: "echo", arguments: { loseReply: true } });
    assert.match(lost.body.error.message, /timed out/u);
    assert.equal(f.pool.stats().fixture?.running, true);
    assert.equal(f.pool.stats().fixture?.spawns, 1);
    const working = await f.request(session, "tasks/get", { taskId: task.taskId });
    assert.equal(TaskSchema.parse(working.body.result).status, "working");
    const completed = await f.request(session, "tasks/get", {
      taskId: task.taskId,
      _meta: { finishFixture: true }
    });
    assert.equal(TaskSchema.parse(completed.body.result).status, "completed");
    const result = await f.request(session, "tasks/result", { taskId: task.taskId });
    assert.match(JSON.stringify(result.body.result), /retained result/u);
    assert.equal(f.pool.stats().fixture?.retainedTasks, 1);
    await waitForReap(f.pool, t.signal);
    assert.equal(f.pool.stats().fixture?.retainedTasks, 0);
  } finally {
    await f.close();
  }
});

test("a retained task prevents conversation eviction until its retention expires", {
  timeout: 15_000
}, async (t) => {
  const f = await fixture(true);
  try {
    const session = await f.open();
    const call = (conversation: string, task = false) =>
      f.request(session, "tools/call", {
        name: "echo",
        arguments: {},
        _meta: { "openai/session": conversation },
        ...(task ? { task: { ttl: TTL_MS } } : {})
      });
    const { task } = CreateTaskResultSchema.parse((await call("a", true)).body.result);
    await delay(IDLE_MS * 3, undefined, { signal: t.signal });
    assert.match((await call("b")).body.error.message, /busy/u);
    const status = await f.request(session, "tasks/get", {
      taskId: task.taskId,
      _meta: { "openai/session": "a", finishFixture: true }
    });
    assert.equal(TaskSchema.parse(status.body.result).status, "completed");
    assert.match((await call("b")).body.error.message, /busy/u);
    await waitForReap(f.pool, t.signal);
    assert.match(JSON.stringify((await call("b")).body.result), /ordinary/u);
  } finally {
    await f.close();
  }
});

test("a native terminal status notification releases retention without a client poll", {
  timeout: 15_000
}, async (t) => {
  const f = await fixture();
  try {
    const session = await f.open();
    await f.request(session, "tools/call", {
      name: "echo", arguments: {}, task: { ttl: TTL_MS }
    });
    assert.equal(f.pool.stats().fixture?.retainedTasks, 1);
    await f.request(session, "tools/call", {
      name: "echo", arguments: { finishAll: true }
    });
    assert.equal(f.pool.stats().fixture?.retainedTasks, 1);
    await waitForReap(f.pool, t.signal);
    assert.equal(f.pool.stats().fixture?.retainedTasks, 0);
  } finally {
    await f.close();
  }
});

test("an uncertain task creation is not treated as idle or safe to retry", {
  timeout: 15_000
}, async (t) => {
  const f = await fixture();
  try {
    const session = await f.open();
    const call = (loseReply: boolean) =>
      f.request(session, "tools/call", {
        name: "echo",
        arguments: { loseReply },
        task: { ttl: TTL_MS }
      });
    assert.match((await call(true)).body.error.message, /timed out/u);
    await delay(IDLE_MS * 3, undefined, { signal: t.signal });
    assert.equal(f.pool.stats().fixture?.running, true);
    assert.equal(f.pool.stats().fixture?.uncertainTaskCreation, true);
    assert.match((await call(false)).body.error.message, /retention capacity/u);
    assert.equal(f.pool.stats().fixture?.spawns, 1);
  } finally {
    await f.close();
  }
});

test("a task is visible only to the session or conversation that created it", {
  timeout: 15_000
}, async () => {
  const f = await fixture();
  try {
    const owner = await f.open();
    const other = await f.open();
    const created = await f.request(owner, "tools/call", {
      name: "echo",
      arguments: {},
      task: { ttl: TTL_MS }
    });
    const { task } = CreateTaskResultSchema.parse(created.body.result);
    for (const method of ["tasks/get", "tasks/result", "tasks/cancel"]) {
      const foreign = await f.request(other, method, { taskId: task.taskId });
      assert.equal(foreign.body.error?.message, "Task not found", method);
    }
    const foreignList = await f.request(other, "tasks/list", {});
    assert.deepEqual(foreignList.body.result.tasks, []);
    const ownList = await f.request(owner, "tasks/list", {});
    assert.deepEqual(
      ownList.body.result.tasks.map((entry: { taskId: string }) => entry.taskId),
      [task.taskId]
    );
    const own = await f.request(owner, "tasks/get", { taskId: task.taskId });
    assert.equal(TaskSchema.parse(own.body.result).status, "working");

    // A platform conversation identity owns its tasks across MCP sessions,
    // and a different conversation on the same session sees none of them.
    const meta = (conversation: string) => ({
      _meta: { "openai/session": conversation }
    });
    const viaConversation = await f.request(owner, "tools/call", {
      name: "echo",
      arguments: {},
      task: { ttl: TTL_MS },
      ...meta("conversation-a")
    });
    const conversationTask = CreateTaskResultSchema.parse(
      viaConversation.body.result
    ).task;
    const sameConversation = await f.request(other, "tasks/get", {
      taskId: conversationTask.taskId,
      ...meta("conversation-a")
    });
    assert.equal(TaskSchema.parse(sameConversation.body.result).status, "working");
    const otherConversation = await f.request(owner, "tasks/get", {
      taskId: conversationTask.taskId,
      ...meta("conversation-b")
    });
    assert.equal(otherConversation.body.error?.message, "Task not found");

  } finally {
    await f.close();
  }
});
