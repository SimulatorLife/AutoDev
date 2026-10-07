import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  createPgMemoryPool,
  MEMORY_POOL_CONNECT_TIMEOUT_MS
} from "../../src/memory/pg-pool.ts";

/**
 * A database that accepts the TCP connection and then never speaks -- the
 * shape a firewall or a silently dropping host presents. Deliberately not a
 * closed port: a closed port refuses instantly, which is why probing
 * `127.0.0.1:1` cannot distinguish "the connect is bounded" from "the connect
 * fails for an unrelated reason".
 */
async function startSilentHost(): Promise<{
  url: string;
  close: () => void;
}> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `postgres://autodev:autodev@127.0.0.1:${address.port}/memory`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

/**
 * The longest a connect is allowed to take, stated absolutely.
 *
 * Deliberately not derived from `MEMORY_POOL_CONNECT_TIMEOUT_MS`: a deadline
 * computed from the value under test scales with any mutation of it, so
 * raising the bound to 60s moved this test's own deadline to 180s and it
 * passed anyway -- after waiting a minute for the thing it was meant to catch.
 * The bound's job is to beat the operating system's TCP timeout, so "short" is
 * part of what is being asserted, and only an independent number can assert it.
 */
const MAX_ACCEPTABLE_CONNECT_MS = 10_000;

test("a black-holed database fails its connect instead of hanging forever", async () => {
  // The migration CLI is the caller this protects. It has no deadline of its
  // own -- unlike the Runtime host, whose health probe races its own -- so an
  // unbounded connect here hangs the one command whose output an operator is
  // waiting on. Measured without the bound: still pending when killed at 15s.
  const host = await startSilentHost();
  const pool = createPgMemoryPool(host.url);
  const neverSettled = Symbol("connect never settled");
  const started = process.hrtime.bigint();
  try {
    // Racing against a sentinel rather than `assert.rejects`: a rejection
    // proves nothing here, because the race's own timer rejects too. What has
    // to be shown is that the *connect* settled, so the sentinel is
    // distinguished from a real driver error by identity.
    const outcome = await Promise.race([
      pool.connect().then(
        () => "connected" as const,
        (error: unknown) => error
      ),
      new Promise<typeof neverSettled>((resolve) => {
        const timer = setTimeout(() => resolve(neverSettled), MAX_ACCEPTABLE_CONNECT_MS);
        timer.unref();
      })
    ]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.notEqual(
      outcome,
      neverSettled,
      `the connect had not settled after ${MAX_ACCEPTABLE_CONNECT_MS}ms: the pool must bound how long a connection attempt may hang`
    );
    assert.notEqual(outcome, "connected");
    assert.ok(outcome instanceof Error, `expected a driver error, got ${String(outcome)}`);

    // Not immediate. An instant failure would mean the connect broke for some
    // other reason and the bound did nothing; this asserts the configured
    // timeout is what ended it.
    assert.ok(
      elapsedMs >= MEMORY_POOL_CONNECT_TIMEOUT_MS / 2,
      `the connect failed after ${Math.round(elapsedMs)}ms, before the configured ${MEMORY_POOL_CONNECT_TIMEOUT_MS}ms bound could apply`
    );
  } finally {
    host.close();
  }
});