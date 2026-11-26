/**
The Commands backend's durable task store.

The store keeps the task lifecycle in the Runtime's private run directory, so
a backend that ends leaves a record behind. These tests prove what that
record is allowed to say: an interrupted task is failed, never completed, and
a finished task keeps its result.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { DurableCommandTaskStore } from "../src/mcp/command-task-store.ts";

const STORE = path.resolve(
  import.meta.dirname,
  "..",
  "src",
  "mcp",
  "command-task-store.ts"
);

const request = {
  method: "tools/call",
  params: { name: "test", arguments: {} }
};

/**
A private directory for one scope's task records.
*/
function directoryFixture(): string {
  return mkdtempSync(path.join(tmpdir(), "autodev-command-tasks-"));
}

test("the task store isolates explicit and absent transport sessions", async () => {
  const directory = directoryFixture();
  const store = new DurableCommandTaskStore({ directory, authorize: () => {} });
  try {
    const stdio = await store.createTask({ ttl: 10_000 }, 1, request);
    const explicit = await store.createTask(
      { ttl: 10_000 },
      2,
      request,
      "stdio"
    );
    assert.equal((await store.getTask(stdio.taskId))?.taskId, stdio.taskId);
    assert.equal(await store.getTask(stdio.taskId, "stdio"), null);
    assert.equal(await store.getTask(explicit.taskId), null);
    assert.equal(await store.getTask(explicit.taskId, "other"), null);
    assert.deepEqual(
      (await store.listTasks()).tasks.map((task) => task.taskId),
      [stdio.taskId]
    );
    assert.deepEqual(
      (await store.listTasks(undefined, "stdio")).tasks.map(
        (task) => task.taskId
      ),
      [explicit.taskId]
    );
    const result = { content: [{ type: "text", text: "fixture" }] };
    await assert.rejects(
      store.storeTaskResult(explicit.taskId, "completed", result),
      /not found/u
    );
    await assert.rejects(
      store.updateTaskStatus(explicit.taskId, "cancelled"),
      /not found/u
    );
    assert.equal(
      (await store.getTask(explicit.taskId, "stdio"))?.status,
      "working"
    );
    await store.storeTaskResult(explicit.taskId, "completed", result, "stdio");
    await assert.rejects(store.getTaskResult(explicit.taskId), /not found/u);
    assert.deepEqual(
      await store.getTaskResult(explicit.taskId, "stdio"),
      result
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a finished task keeps its result when the backend that ran it is gone", async () => {
  const directory = directoryFixture();
  try {
    const result = { content: [{ type: "text", text: "durable" }] };
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    const task = await store.createTask({ ttl: 600_000 }, 1, request);
    await store.storeTaskResult(task.taskId, "completed", result);
    // A later backend reads the record the earlier one left behind.
    const later = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    assert.equal((await later.getTask(task.taskId))?.status, "completed");
    assert.deepEqual(await later.getTaskResult(task.taskId), result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a task whose backend ended is failed, never completed, and is not replayed", async () => {
  const directory = directoryFixture();
  try {
    // A backend that creates a task and then ends, exactly as a killed
    // Commands process does.
    const script = path.join(directory, "backend.ts");
    writeFileSync(
      script,
      [
        `import { DurableCommandTaskStore } from ${JSON.stringify(STORE)};`,
        `const store = new DurableCommandTaskStore({ directory: process.argv[2], authorize: () => {} });`,
        `const task = await store.createTask({ ttl: 600_000 }, 1, { method: "tools/call", params: {} });`,
        `process.stdout.write(task.taskId);`
      ].join("\n"),
      "utf8"
    );
    const created = spawnSync(process.execPath, [script, directory], {
      encoding: "utf8"
    });
    assert.equal(created.status, 0, created.stderr);
    const taskId = created.stdout.trim();
    assert.match(taskId, /^[a-f0-9]{32}$/u);

    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    const reconciled = await store.getTask(taskId);
    assert.equal(reconciled?.status, "failed");
    assert.match(reconciled?.statusMessage ?? "", /backend process ended/u);
    // The outcome of an interrupted command is unknown, and is reported as
    // unknown rather than reconstructed.
    const result = await store.getTaskResult(taskId);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /unknown/u);
    assert.match(JSON.stringify(result.content), /not replayed/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a live backend's task is not reconciled by a sibling backend", async () => {
  const directory = directoryFixture();
  try {
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    const task = await store.createTask({ ttl: 600_000 }, 1, request);
    const sibling = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    assert.equal((await sibling.getTask(task.taskId))?.status, "working");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the task store is bounded by count and by retention", async () => {
  const directory = directoryFixture();
  try {
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {},
      maxTasks: 2
    });
    // A record that outlives its retention window is dropped, not kept.
    const expiring = await store.createTask({ ttl: 1 }, 1, request);
    await delay(20);
    assert.equal(await store.getTask(expiring.taskId), null);
    assert.deepEqual(
      readdirSync(directory).filter((entry) => entry.endsWith(".json")),
      []
    );
    await store.createTask({ ttl: 600_000 }, 2, request);
    await store.createTask({ ttl: 600_000 }, 3, request);
    await assert.rejects(
      store.createTask({ ttl: 600_000 }, 4, request),
      /retention limit/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an interrupted command is recorded as failed with an unknown outcome", async () => {
  const directory = directoryFixture();
  try {
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    const task = await store.createTask({ ttl: 600_000 }, 1, request);
    store.interrupt(
      task.taskId,
      "The command was interrupted when the backend closed."
    );
    const interrupted = await store.getTask(task.taskId);
    assert.equal(interrupted?.status, "failed");
    assert.match(interrupted?.statusMessage ?? "", /interrupted/u);
    const result = await store.getTaskResult(task.taskId);
    assert.equal(result.isError, true);
    // A terminal task cannot be completed afterwards.
    await assert.rejects(
      store.storeTaskResult(task.taskId, "completed", {
        content: [{ type: "text", text: "late" }]
      }),
      /terminal status/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the task store refuses every operation once the grant is revoked", async () => {
  const directory = directoryFixture();
  try {
    let isAuthorized = true;
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {
        if (!isAuthorized)
          throw new Error("Command execution grant is unavailable or revoked.");
      }
    });
    const task = await store.createTask({ ttl: 600_000 }, 1, request);
    isAuthorized = false;
    await assert.rejects(store.getTask(task.taskId), /revoked/u);
    await assert.rejects(store.listTasks(), /revoked/u);
    await assert.rejects(
      store.createTask({ ttl: 600_000 }, 2, request),
      /revoked/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the task store's records are private to their scope", async () => {
  const directory = directoryFixture();
  try {
    const store = new DurableCommandTaskStore({
      directory,
      authorize: () => {}
    });
    await store.createTask({ ttl: 600_000 }, 1, request);
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    assert.ok(files[0]?.endsWith(".json"));
    assert.ok(existsSync(path.join(directory, files[0]!)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
