import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultMcpProcessRegistry,
  McpProcessRegistry,
  registerLogical,
  setDefaultMcpProcessRegistry
} from "@simulatorlife/autodev-runtime/mcp/process-registry";

void test("register / touch / unregister manage the lifecycle", () => {
  const calls: Array<[number, string]> = [];
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      calls.push([pid, signal]);
    },
    now: () => 1000
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
  let nowMs = 1000;
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
  const killed: Array<[number, string]> = [];
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
    maxEntries: 2,
    now: () => 1000
  });
  registry.register(501, "s", "lsp");
  registry.register(502, "s", "lsp");
  registry.register(503, "s", "lsp"); // evicts 501
  assert.equal(registry.status().total, 2);
  // The cap exists to bound *processes*, so the entry it drops has to be
  // disposed of. Once 501 leaves the map nothing -- sweeper, session cleanup,
  // shutdown hooks -- can ever signal it again, so a silent drop is an
  // orphan that outlives the registry.
  assert.deepEqual(killed, [[501, "SIGTERM"]]);
});

void test("registry owns the idle sweeper for exactly the lifetime of registered processes", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let starts = 0;
  let stops = 0;
  const fakeTimer = { unref() {} } as unknown as NodeJS.Timeout;
  globalThis.setInterval = (() => {
    starts += 1;
    return fakeTimer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {
    stops += 1;
  }) as typeof clearInterval;
  try {
    const registry = new McpProcessRegistry({
      sweepIntervalMs: 10_000,
      kill: () => undefined
    });
    assert.equal(starts, 0);
    registry.register(101, "session-a", "lsp");
    assert.equal(starts, 1);
    registry.register(102, "session-a", "context7");
    assert.equal(starts, 1, "one active registry owns one sweeper");
    registry.unregister(101);
    assert.equal(stops, 0, "sweeper remains while entries remain");
    registry.unregister(102);
    assert.equal(stops, 1, "empty registry stops its owned sweeper");
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

void test("registerLogical tracks the server instead of throwing", () => {
  const registry = new McpProcessRegistry({ kill: () => undefined });
  // The router calls this for every `mcp_exposed` agent event. If it throws,
  // `applyAgentEvent` swallows the failure and the server is never tracked --
  // so no sweeper ever reaps it and no session cleanup ever kills it.
  const handle = registerLogical("session-a", "lsp", registry);
  assert.equal(registry.status().total, 1);
  assert.equal(registry.status().byServer.lsp, 1);
  assert.equal(registry.status().bySession["session-a"], 1);
  assert.ok(handle < 0, "a logical handle is distinguishable from a real pid");
});

void test("a logical handle is never handed to kill", () => {
  const killed: Array<[number, string]> = [];
  let nowMs = 1000;
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
    maxIdleMs: 1000,
    now: () => nowMs
  });
  const handle = registerLogical("session-a", "lsp", registry);
  nowMs += 5000; // idle past maxIdleMs
  // `process.kill(-n)` signals process *group* n. A logical entry names a server
  // whose process lives outside AutoDev's tree, so the registry may time it out
  // but must never signal it -- and it must never reach the kill seam at all.
  const result = registry.reapStale();
  assert.deepEqual(
    killed,
    [],
    "reaping a logical entry must not signal anything"
  );
  assert.equal(result.killed, 0, "a logical handle is not a killed process");
  assert.equal(result.remaining, 0, "but it is still timed out and dropped");
  assert.ok(handle < 0);
});

void test("repeated mcp_exposed events evict a real server process without orphaning it", () => {
  const killed: Array<[number, string]> = [];
  const registry = new McpProcessRegistry({
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
    maxEntries: 4
  });
  // One real MCP server the router spawned, tracked by pid.
  registry.register(4242, "session-real", "lsp");
  // A steady stream of `mcp_exposed` events for a *different* logical server.
  // Each call mints a fresh handle, so the cap is reachable without any
  // particular number of distinct servers.
  for (let index = 0; index < 64; index += 1) {
    registerLogical("session-a", "cocoindex-code", registry);
  }
  assert.ok(
    registry.status().total <= 4,
    `the cap holds under a stream of exposures (got ${registry.status().total})`
  );
  assert.ok(
    !("lsp" in registry.status().byServer),
    "the real pid is no longer tracked"
  );
  // Evicted is not the same as disposed: nothing can reach 4242 any more.
  assert.deepEqual(
    killed,
    [[4242, "SIGTERM"]],
    "the evicted process is signalled exactly once, then forgotten"
  );
});
