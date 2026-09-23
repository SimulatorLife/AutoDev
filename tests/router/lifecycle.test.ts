import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RouterLifecycle } from "../../src/router/lifecycle.ts";

const ROUTER_SERVER = fileURLToPath(
  new URL("../../src/router/server.ts", import.meta.url)
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("port server did not expose an address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

test("RouterLifecycle initializes in ready state and tracks status", () => {
  const lifecycle = new RouterLifecycle({
    startedAt: "2026-09-16T12:00:00.000Z",
    drainTimeoutMs: 1000,
    routerInstanceId: "test-instance"
  });

  assert.equal(lifecycle.state, "ready");
  assert.equal(lifecycle.isDraining(), false);
  const status = lifecycle.getLifecycleStatus();
  assert.deepEqual(status, {
    state: "ready",
    draining: false,
    changedAt: "2026-09-16T12:00:00.000Z",
    activeResponseRequests: 0
  });
});

test("RouterLifecycle registers, tracks, and aborts active requests", () => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: "test-instance" });
  const controller1 = new AbortController();
  const controller2 = new AbortController();

  lifecycle.registerActiveRequest(controller1);
  lifecycle.registerActiveRequest(controller2);
  assert.equal(lifecycle.activeRequestCount, 2);

  lifecycle.unregisterActiveRequest(controller1);
  assert.equal(lifecycle.activeRequestCount, 1);

  assert.equal(controller2.signal.aborted, false);
  lifecycle.abortActiveResponseRequests();
  assert.equal(controller2.signal.aborted, true);
});

test("RouterLifecycle transitions to draining and drains requests during shutdown", async () => {
  const lifecycle = new RouterLifecycle({
    routerInstanceId: "test-instance",
    drainTimeoutMs: 50
  });
  const controller = new AbortController();
  lifecycle.registerActiveRequest(controller);

  let persisted = false;
  let closed = false;

  const server = {
    close(cb: (err?: Error) => void) {
      closed = true;
      cb();
    }
  };

  const drainTimeoutMs = 200;
  const unregisterAfterMs = 20;
  const shutdownPromise = lifecycle.beginShutdown({
    signal: "SIGTERM",
    server,
    drainTimeoutMs,
    persistState: async () => {
      persisted = true;
    }
  });

  assert.equal(lifecycle.isDraining(), true);
  assert.equal(lifecycle.state, "draining");

  // Simulate in-flight request completion after the loop has had a chance to
  // observe at least one non-empty in-flight tick. Drain checks every 50ms;
  // finishing inside that window is what proves a graceful drain rather
  // than the timeout-driven abort path.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(unregisterAfterMs, 10))
  );
  lifecycle.unregisterActiveRequest(controller);

  await shutdownPromise;

  assert.equal(persisted, true);
  assert.equal(closed, true);
  assert.equal(controller.signal.aborted, false); // completed before timeout, so not aborted
});

test("RouterLifecycle resets state for tests", () => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: "test-instance" });
  lifecycle.setLifecycleState("draining");
  lifecycle.registerActiveRequest(new AbortController());
  assert.equal(lifecycle.isDraining(), true);

  lifecycle.resetLifecycleForTests();
  assert.equal(lifecycle.isDraining(), false);
  assert.equal(lifecycle.activeRequestCount, 0);
});

test("shutdown force-closes lingering connections once the drain window ends", async (t) => {
  const lifecycle = new RouterLifecycle({ routerInstanceId: "test-instance" });
  const kill = t.mock.method(process, "kill", () => true);
  let closeCallback: (() => void) | null = null;
  let connectionsClosed = false;
  await lifecycle.beginShutdown({
    signal: "SIGTERM",
    drainTimeoutMs: 0,
    server: {
      // A keep-alive client keeps close() pending until its socket goes away.
      close(cb) {
        closeCallback = cb;
      },
      closeAllConnections() {
        connectionsClosed = true;
        closeCallback?.();
      }
    }
  });
  assert.equal(connectionsClosed, true);
  assert.equal(
    kill.mock.callCount(),
    0,
    "re-raising SIGTERM would only re-enter the router's own handler"
  );
});

test("the router process exits on SIGTERM with a request still in flight, and persists its state", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "autodev-router-exit-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_MODEL_ROUTER_PORT: String(port),
    CODEX_ROUTER_SHUTDOWN_DRAIN_MS: "500"
  };
  delete env.CODEX_ROUTER_STATE_FILE;
  delete env.CODEX_ROUTER_AUTH_TOKEN;
  const child = spawn(process.execPath, [ROUTER_SERVER], {
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let client: Socket | null = null;
  try {
    const deadline = Date.now() + 15_000;
    while (!stderr.includes("listening at") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(stderr, /listening at/u, stderr);

    // A client mid-request (body still arriving), as a streaming Codex turn
    // is: server.close() alone waits on this socket indefinitely.
    client = connect(port, "127.0.0.1");
    client.on("error", () => {});
    await once(client, "connect");
    client.write(
      "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 10_000).unref()
    );
    const outcome = await Promise.race([exited, timeout]);
    assert.notEqual(
      outcome,
      "timeout",
      `router kept running after SIGTERM:\n${stderr}`
    );
    assert.deepEqual(outcome, [0, null]);
    assert.match(stderr, /"phase":"shutdown_complete"/u);
    assert.equal(
      existsSync(join(codexHome, "codex-router-state.json")),
      true,
      "graceful shutdown persists router state"
    );
  } finally {
    client?.destroy();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(codexHome, { recursive: true, force: true });
  }
});
