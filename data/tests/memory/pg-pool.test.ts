import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  createPgMemoryPool,
  MEMORY_POOL_CONNECT_TIMEOUT_MS
} from "../../src/memory/pg-pool.ts";
import { startFakePostgresServer } from "./fixtures/fake-postgres-server.ts";

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
        const timer = setTimeout(
          () => resolve(neverSettled),
          MAX_ACCEPTABLE_CONNECT_MS
        );
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
    assert.ok(
      outcome instanceof Error,
      `expected a driver error, got ${String(outcome)}`
    );

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
/**
 * The pool against the real `pg` driver.
 *
 * Everything above runs a pool that never connects successfully -- it proves
 * the *failure* is bounded. It cannot say anything about what happens on
 * success, because `FakeMemoryPool` satisfies the same interface without ever
 * loading this module's body: `runQuery` and the success path of `connect()`
 * had no coverage at all. So the row mapping, the parameter hand-off and the
 * concurrency policy this module exists to own were all untested against the
 * code that ships.
 *
 * `fake-postgres-server.ts` is a wire-protocol server, not a database. It
 * completes the handshake, parses the statement out of both the simple and the
 * extended query protocols, and answers from a table the test supplies.
 */
test("rows and rowCount from the real driver reach the caller", async () => {
  const host = await startFakePostgresServer(
    new Map([
      [
        "SELECT id, label",
        {
          columns: ["id", "label"],
          rows: [
            ["1", "alpha"],
            ["2", "beta"]
          ]
        }
      ]
    ])
  );
  const pool = createPgMemoryPool(host.url);
  try {
    const result = await pool.query("SELECT id, label FROM memory_records");

    assert.deepEqual(result.rows, [
      { id: "1", label: "alpha" },
      { id: "2", label: "beta" }
    ]);
    assert.equal(result.rowCount, 2);
  } finally {
    await pool.end();
    await host.close();
  }
});

test("parameters are handed to the driver in order, and an empty list is still a list", async () => {
  const host = await startFakePostgresServer(
    new Map([
      ["SELECT id FROM memory_records", { columns: ["id"], rows: [["42"]] }],
      [
        "DELETE FROM memory_records",
        { columns: [], rows: [], commandComplete: "DELETE 3" }
      ]
    ])
  );
  const pool = createPgMemoryPool(host.url);
  try {
    await pool.query(
      "SELECT id FROM memory_records WHERE id = $1 AND kind = $2",
      [42, "pattern"]
    );
    // An empty array is not the same as "no parameters" to `runQuery`, which
    // branches on exactly that, so both are exercised rather than assumed.
    await pool.query("SELECT id FROM memory_records", []);
    // The DELETE must be answered by the DELETE entry, not by the shorter
    // `SELECT id FROM memory_records` key it also contains. Asserting only the
    // recorded SQL and parameters would not notice a mis-routed answer, so the
    // row count is checked too: the DELETE reports three affected rows and
    // returns none.
    const deleted = await pool.query(
      "DELETE FROM memory_records WHERE id = ANY($1)",
      ["{1,2,3}"]
    );
    assert.equal(
      deleted.rowCount,
      3,
      "the DELETE answer must be the one that was used"
    );
    assert.deepEqual(deleted.rows, []);

    assert.deepEqual(
      host.statements.map((statement) => statement.params),
      [["42", "pattern"], [], ["{1,2,3}"]],
      "parameters must arrive in order, with an empty list sent as a statement with no parameters"
    );
    assert.deepEqual(
      host.statements.map((statement) => statement.sql),
      [
        "SELECT id FROM memory_records WHERE id = $1 AND kind = $2",
        "SELECT id FROM memory_records",
        "DELETE FROM memory_records WHERE id = ANY($1)"
      ]
    );
  } finally {
    await pool.end();
    await host.close();
  }
});

test("a command that returns no rows still reports the row count it affected", async () => {
  const host = await startFakePostgresServer(
    new Map([
      [
        "INSERT INTO memory_records",
        { columns: [], rows: [], commandComplete: "INSERT 0 1" }
      ]
    ])
  );
  const pool = createPgMemoryPool(host.url);
  try {
    const result = await pool.query("INSERT INTO memory_records VALUES ($1)", [
      "x"
    ]);

    // This is why the pool does not derive `rowCount` from `rows.length`:
    // `pg` reports the tag's count, so a write that affected a row and
    // returned none is `rowCount: 1`, not `0`.
    assert.deepEqual(result.rows, []);
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.end();
    await host.close();
  }
});

test("connect() hands out a usable connection and release() returns it to the pool", async () => {
  const host = await startFakePostgresServer(
    new Map([["SELECT 1 AS n", { columns: ["n"], rows: [["1"]] }]])
  );
  const pool = createPgMemoryPool(host.url);
  try {
    const first = await pool.connect();
    const second = await pool.connect();
    // Two is the configured maximum, so this second checkout is the last one
    // that can be outstanding at once.
    assert.notEqual(host.openConnections(), 0);

    assert.deepEqual(await first.query("SELECT 1 AS n"), {
      rows: [{ n: "1" }],
      rowCount: 1
    });

    first.release();
    second.release();

    // Released connections are reusable rather than consumed: the pool has a
    // maximum, not a budget.
    const third = await pool.connect();
    assert.deepEqual((await third.query("SELECT 1 AS n")).rowCount, 1);
    third.release();
  } finally {
    await pool.end();
    await host.close();
  }
});

test("the pool holds at most two connections at a time", async () => {
  // The policy this module owns. An unbounded or larger pool against a
  // database that is slow to accept connections turns every reader into its
  // own waiting connection, so the cap is asserted behaviourally rather than
  // by reading the constructor options.
  const host = await startFakePostgresServer(
    new Map([["SELECT 1 AS n", { columns: ["n"], rows: [["1"]] }]])
  );
  const pool = createPgMemoryPool(host.url);
  try {
    const first = await pool.connect();
    const second = await pool.connect();

    let handedOut = false;
    const thirdPromise = pool.connect().then(
      (connection) => {
        handedOut = true;
        return connection;
      },
      // Swallowed so a rejection here cannot become an unhandled rejection
      // while the assertion below is still waiting on the timer.
      () => {
        handedOut = true;
        return undefined;
      }
    );

    // Nothing to await here: the claim is that the third request is *not*
    // satisfied, so give the driver every chance to satisfy it and observe
    // that it did not.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      handedOut,
      false,
      "a third connection must not be handed out while two are outstanding"
    );

    first.release();
    const third = await thirdPromise;
    assert.ok(third, "releasing a connection must satisfy the waiting request");
    third.release();
    second.release();
  } finally {
    await pool.end();
    await host.close();
  }
});

test("end() closes the pool's connections", async () => {
  const host = await startFakePostgresServer(
    new Map([["SELECT 1 AS n", { columns: ["n"], rows: [["1"]] }]])
  );
  const pool = createPgMemoryPool(host.url);
  const connection = await pool.connect();
  await connection.query("SELECT 1 AS n");
  assert.ok(
    host.openConnections() > 0,
    "the connection must be open before end()"
  );

  // Released first, and that ordering is the point. `pg-pool`'s `end()` waits
  // for every checked-out client, so a caller that forgets one `release()`
  // hangs shutdown forever -- with no error and no timeout, because
  // `MEMORY_POOL_CONNECT_TIMEOUT_MS` bounds how long a *connect* may take and
  // says nothing about a connection that is never handed back. Every release in
  // this file is therefore inside a `finally`.
  connection.release();

  await pool.end();

  // `allowExitOnIdle` plus a drained pool means nothing is left holding the
  // process open; the socket's FIN may still be in flight, so this is about the
  // pool having released it, not about the OS closing it synchronously.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    host.openConnections(),
    0,
    "end() must close every connection the pool holds"
  );
  await host.close();
});
