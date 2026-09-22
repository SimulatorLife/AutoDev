import test from "node:test";
import assert from "node:assert/strict";

import {
  McpProcessRegistry,
  setDefaultMcpProcessRegistry,
  getDefaultMcpProcessRegistry
} from "../../src/mcp/process-registry.ts";

void test("register / touch / unregister manage the lifecycle", () => {
  const calls: Array<[number, string]> = [];
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      calls.push([pid, signal]);
    },
    now: () => 1_000
  });
  registry.register(101, "session-A", "lsp");
  registry.register(102, "session-A", "cocoindex-code");
  registry.register(103, "session-B", "context7");
  assert.equal(registry.status().total, 3);
  assert.equal(registry.status().byServer.lsp, 1);
  assert.equal(registry.status().bySession["session-A"], 2);

  registry.touch(101);
  registry.unregister(103);
  assert.equal(registry.status().total, 2);

  registry.unregister(999); // unknown pid is a no-op
  assert.equal(registry.status().total, 2);
});

void test("reapStale kills processes idle longer than maxIdleMs", () => {
  const killed: number[] = [];
  let nowMs = 1_000;
  const registry = new McpProcessRegistry({
    kill: (pid) => {
      killed.push(pid);
    },
    now: () => nowMs
  });
  registry.register(201, "session-A", "lsp");
  registry.register(202, "session-A", "lsp");
  nowMs += 60_000; // 60s
  registry.touch(201);
  registry.register(203, "session-B", "context7"); // registered at nowMs=61s
  nowMs += 60_000; // 121s; 201 touched 60s ago, 202 idle 121s, 203 idle 60s
  const result = registry.reapStale(90_000); // reap idle > 90s
  assert.equal(result.killed, 1);
  assert.deepEqual(killed, [202]);
  assert.equal(result.remaining, 2);
});

void test("cleanupSession signals every process owned by a session", async () => {
  const killed: Array<[number, string]> = [];
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
    killTimeoutMs: 50
  });
  registry.register(301, "session-X", "lsp");
  registry.register(302, "session-X", "lsp");
  registry.register(303, "session-Y", "lsp");

  await registry.cleanupSession("session-X");
  // 301, 302 should each receive SIGTERM; the waitForExit probe then calls
  // kill(pid, 0) on a regular interval to confirm exit. The test asserts the
  // first signal for each PID is SIGTERM and that both PIDs were signalled.
  const firstSignalForPid = new Map<number, string>();
  for (const [pid, signal] of killed) {
    if (!firstSignalForPid.has(pid)) firstSignalForPid.set(pid, signal);
  }
  assert.deepEqual(
    [...firstSignalForPid.entries()].sort(([a], [b]) => a - b),
    [
      [301, "SIGTERM"],
      [302, "SIGTERM"]
    ]
  );
  assert.equal(registry.status().total, 1);
  assert.equal(registry.status().bySession["session-Y"], 1);
});

void test("cleanupSession is a no-op for unknown session keys", async () => {
  const killed: number[] = [];
  const registry = new McpProcessRegistry({
    kill: (pid) => {
      killed.push(pid);
    }
  });
  registry.register(401, "session-A", "lsp");
  await registry.cleanupSession("nonexistent");
  assert.deepEqual(killed, []);
  assert.equal(registry.status().total, 1);
});

void test("default registry is a singleton and replaceable for tests", () => {
  const previous = getDefaultMcpProcessRegistry();
  const replacement = new McpProcessRegistry();
  const restored = setDefaultMcpProcessRegistry(replacement);
  try {
    assert.equal(restored, previous);
    assert.equal(getDefaultMcpProcessRegistry(), replacement);
  } finally {
    setDefaultMcpProcessRegistry(previous);
  }
  assert.equal(getDefaultMcpProcessRegistry(), previous);
});

void test("eviction keeps the registry at most maxEntries entries", () => {
  const killed: number[] = [];
  const registry = new McpProcessRegistry({
    kill: (pid) => {
      killed.push(pid);
    },
    maxEntries: 2,
    now: () => 1_000
  });
  registry.register(501, "s", "lsp");
  registry.register(502, "s", "lsp");
  registry.register(503, "s", "lsp"); // evicts 501
  assert.equal(registry.status().total, 2);
  // Eviction does NOT call kill -- it is a memory-management step, not a
  // process-management step. Cleanup is the caller's responsibility.
  assert.deepEqual(killed, []);
});

void test("startIdleSweeper and stopIdleSweeper are idempotent", () => {
  const registry = new McpProcessRegistry({});
  const handle1 = registry.startIdleSweeper(10_000, 60_000);
  const handle2 = registry.startIdleSweeper(10_000, 60_000);
  // Second call replaces the first.
  assert.notEqual(handle1, handle2);
  registry.stopIdleSweeper();
  // Stopping twice is safe.
  registry.stopIdleSweeper();
});
