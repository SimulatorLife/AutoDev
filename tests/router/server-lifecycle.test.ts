import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import { getDefaultMcpProcessRegistry } from "../../src/mcp/process-registry.ts";
import { codexState } from "../../src/router/http.ts";

test("router server starts and disposes its background resources with the listener", async () => {
  const registry = getDefaultMcpProcessRegistry();
  const originalStartSweeper = registry.startIdleSweeper;
  const originalStopSweeper = registry.stopIdleSweeper;
  const startSweeper = originalStartSweeper.bind(registry);
  const stopSweeper = originalStopSweeper.bind(registry);
  let startCalls = 0;
  let stopCalls = 0;
  registry.startIdleSweeper = (intervalMs, maxIdleMs) => {
    startCalls += 1;
    return startSweeper(intervalMs, maxIdleMs);
  };
  registry.stopIdleSweeper = () => {
    stopCalls += 1;
    stopSweeper();
  };

  const processEvents = [
    "uncaughtException",
    "unhandledRejection",
    "SIGINT",
    "SIGTERM"
  ] as const;
  const listenerCounts = new Map(
    processEvents.map((event) => [event, process.listenerCount(event)])
  );
  const previousLivePollStarted = codexState.livePollStarted;
  let server: Server | undefined;

  try {
    const { startRouterServer } = await import("../../src/router/server.ts");
    assert.equal(
      startCalls,
      0,
      "importing router code should not start a timer"
    );

    server = startRouterServer(0, "127.0.0.1");
    await once(server, "listening");
    assert.equal(startCalls, 1, "the live router owns one sweeper");
    assert.equal(codexState.livePollStarted, true);

    const closed = once(server, "close");
    server.close();
    await closed;

    assert.equal(stopCalls, 1);
    assert.equal(codexState.livePollStarted, false);
    for (const event of processEvents)
      assert.equal(process.listenerCount(event), listenerCounts.get(event));
  } finally {
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    registry.stopIdleSweeper();
    codexState.collector.stopLivePoll();
    codexState.livePollStarted = previousLivePollStarted;
    registry.startIdleSweeper = originalStartSweeper;
    registry.stopIdleSweeper = originalStopSweeper;
  }
});
