import assert from "node:assert/strict";
import test from "node:test";

import {
  type MemoryConnectionPool,
  type MemoryPooledConnection,
  withMemoryTransaction
} from "../../src/memory/query-client.ts";

/**
 * The transaction helper every multi-statement write goes through.
 *
 * It had no direct test. `transitionMemories` and two other writes run inside it,
 * and their tests reach it only by accident — and an accidental reach cannot
 * fail for the reasons that matter here. The two properties below are both about
 * what happens when something is already going wrong, which is precisely the
 * situation an incidental test never constructs:
 *
 * - the connection comes back to the pool exactly once, on every path including
 *   the failing ones. `release()` is how `pg` returns a client to its pool;
 *   leaking one does not throw, it quietly shrinks the pool until a busy router
 *   cannot get a connection at all.
 * - a rollback that itself fails must not replace the error that caused it. The
 *   caller's bug is the thing worth reporting, and a swallowed rollback is what
 *   keeps the original error intact.
 */

interface Recorder {
  pool: MemoryConnectionPool;
  readonly statements: string[];
  releaseCount: number;
}

function recordingPool(
  options: {
    readonly failOn?: (sql: string) => boolean;
    readonly connectFails?: boolean;
  } = {}
): Recorder {
  const recorder: Recorder = {
    statements: [],
    releaseCount: 0,
    pool: undefined as unknown as MemoryConnectionPool
  };
  const connection: MemoryPooledConnection = {
    query: async (text) => {
      recorder.statements.push(text);
      if (options.failOn?.(text)) {
        throw new Error(`statement failed: ${text}`);
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      recorder.releaseCount += 1;
    }
  };
  recorder.pool = {
    query: connection.query,
    connect: async () => {
      if (options.connectFails === true) {
        throw new Error("pool is exhausted");
      }
      return connection;
    },
    end: async () => undefined
  };
  return recorder;
}

test("a transaction that succeeds commits and returns the work's result", async () => {
  const recorder = recordingPool();

  const result = await withMemoryTransaction(recorder.pool, async () => {
    recorder.statements.push("WORK");
    return "committed";
  });

  assert.equal(result, "committed");
  assert.deepEqual(recorder.statements, ["BEGIN", "WORK", "COMMIT"]);
  assert.equal(
    recorder.releaseCount,
    1,
    "the connection was not returned to the pool"
  );
});

test("work that throws rolls back and propagates the original error", async () => {
  const recorder = recordingPool();
  const failure = new Error("the write violated a constraint");

  await assert.rejects(
    withMemoryTransaction(recorder.pool, async () => {
      throw failure;
    }),
    (error: unknown) => {
      // Identity, not just the message: a wrapper that rethrows with its own
      // text loses the stack the caller needs to find the failing statement.
      assert.equal(
        error,
        failure,
        "the error was replaced rather than propagated"
      );
      return true;
    }
  );

  assert.deepEqual(
    recorder.statements,
    ["BEGIN", "ROLLBACK"],
    "a failed transaction must not commit"
  );
  assert.equal(
    recorder.releaseCount,
    1,
    "a failed transaction leaked its connection"
  );
});

test("a rollback that fails does not replace the error that caused it", async () => {
  // The swallowed rollback is the whole reason this is worth a test. If
  // `ROLLBACK` rejected without the `.catch`, the rollback failure would become
  // the reported error and the caller's actual bug would disappear — reported as
  // a database problem from a line that never ran.
  const recorder = recordingPool({
    failOn: (sql) => sql === "ROLLBACK"
  });
  const failure = new Error("the caller's bug");

  await assert.rejects(
    withMemoryTransaction(recorder.pool, async () => {
      throw failure;
    }),
    (error: unknown) => {
      assert.equal(
        error,
        failure,
        "a failed rollback replaced the original error"
      );
      return true;
    }
  );

  assert.equal(
    recorder.releaseCount,
    1,
    "a failed rollback leaked its connection"
  );
});

test("a commit that fails rolls back, releases, and reports the commit failure", async () => {
  const recorder = recordingPool({ failOn: (sql) => sql === "COMMIT" });

  await assert.rejects(
    withMemoryTransaction(recorder.pool, async () => "done"),
    /statement failed: COMMIT/u
  );

  assert.deepEqual(
    recorder.statements,
    ["BEGIN", "COMMIT", "ROLLBACK"],
    "a failed commit must be rolled back"
  );
  assert.equal(
    recorder.releaseCount,
    1,
    "a failed commit leaked its connection"
  );
});

test("a pool that cannot hand out a connection releases nothing", async () => {
  // There is no connection to return, and the helper must not pretend otherwise.
  // A `release()` on a client it never acquired is how a pool's accounting goes
  // wrong in the direction that eventually hands the same client to two callers.
  const recorder = recordingPool({ connectFails: true });

  await assert.rejects(
    withMemoryTransaction(recorder.pool, async () => "unreachable"),
    /pool is exhausted/u
  );

  assert.deepEqual(recorder.statements, []);
  assert.equal(recorder.releaseCount, 0);
});
