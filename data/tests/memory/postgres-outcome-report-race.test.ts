import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryOutcomeReport,
  MemoryReadContext,
  MemorySessionOutcomeReport,
  MemoryUseReport
} from "@simulatorlife/autodev-core";

import { MemoryConflictError } from "../../src/memory/errors.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import type { MemoryConnectionPool } from "../../src/memory/query-client.ts";
import { makeContext } from "./fixtures/builders.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

/**
 * What happens when two writers report against the same key at once.
 *
 * Both report tables bind one row per key — an outcome report to its
 * correlation token, a session outcome report to its session key. The write
 * path is therefore read-then-insert, and that sequence has a window between
 * the read and the insert where a second writer can commit the same key. The
 * insert then fails on the unique index, and that failure is the *normal* end
 * of a concurrent double-submit, not an error to surface.
 *
 * So the repository re-reads and decides from the body: an identical retry is
 * idempotent and returns the row that won, while a different body for the same
 * key is a genuine conflict and must stay loud.
 *
 * The only coverage of this was `postgres-injection-outcome.integration.test.ts`,
 * which is skipped without a live database — so in an ordinary run, nineteen
 * lines of append idempotency and eighteen more for the session table were
 * unexecuted. The fake pool already models `23505`; nothing used it.
 *
 * The race is staged rather than asserted: the wrapper lets the repository's
 * own lookup run and miss, then performs a second writer's real write through a
 * second repository on the same pool, then lets the insert land so it collides
 * on the same unique index it would against Postgres.
 */

function racingPool(
  base: FakeMemoryPool,
  table:
    | "memory_outcome_reports"
    | "memory_session_outcome_reports"
    | "memory_injection_use_reports",
  race: () => Promise<void>
): MemoryConnectionPool {
  let fired = false;
  return {
    query: async (text, params) => {
      if (!fired && text.includes(`INSERT INTO ${table}`)) {
        fired = true;
        await race();
      }
      return base.query(text, params);
    },
    connect: () => base.connect(),
    end: () => base.end()
  };
}

const sessionContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-A",
  runId: "session-A",
  agentId: "session-A"
});

function injectionEvent(): MemoryInjectionEvent {
  return {
    id: "inj-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "session-A",
      runId: "session-A"
    },
    taskId: "session-A",
    runId: "session-A",
    agentId: "session-A",
    correlationToken: "token-a",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 12,
    memoryIds: ["m-1"],
    occurredAt: "2026-10-01T12:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-runner"
  };
}

function outcomeReport(
  overrides: Partial<MemoryOutcomeReport> = {}
): MemoryOutcomeReport {
  return {
    id: "rep-mine",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task",
      workspaceId: "ws-1",
      taskId: "session-A",
      runId: "session-A"
    },
    taskId: "session-A",
    runId: "session-A",
    agentId: "session-A",
    correlationToken: "token-a",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-10-01T12:30:00.000Z",
    reporterId: "op-1",
    reporterAuthority: "root",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "file", uri: "file:///workspace/repo/PULL_REQUEST.md" }],
    ...overrides
  };
}

function sessionReport(
  overrides: Partial<MemorySessionOutcomeReport> = {}
): MemorySessionOutcomeReport {
  return {
    id: "srep-mine",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId: "session-A",
    outcomeKind: "success",
    reportKind: "task",
    reportedAt: "2026-10-01T12:30:00.000Z",
    reporterId: "op-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "file", uri: "file:///workspace/repo/PULL_REQUEST.md" }],
    ...overrides
  };
}

/** A pool holding a scope-aligned injection event, so the token resolves. */
async function poolWithInjection(): Promise<FakeMemoryPool> {
  const pool = new FakeMemoryPool();
  await new PostgresMemoryRepository({ pool }).recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: sessionContext
  });
  return pool;
}

test("a concurrent identical outcome report is idempotent, not a conflict", async () => {
  const pool = await poolWithInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_outcome_reports", async () => {
      await racing.recordOutcomeReport({
        report: outcomeReport({ id: "rep-theirs" }),
        actor: { id: "op-2", authority: "root" },
        context: sessionContext
      });
    })
  });

  const result = await repository.recordOutcomeReport({
    report: outcomeReport(),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });

  // The row that won is returned, not ours: the caller asked for the report on
  // this token and the report on this token exists under someone else's id.
  assert.equal(result.appended, false);
  assert.equal(result.id, "rep-theirs");
  assert.equal(pool.tables.memory_outcome_reports.size, 1);
});

test("a concurrent outcome report with a different body still conflicts", async () => {
  const pool = await poolWithInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_outcome_reports", async () => {
      await racing.recordOutcomeReport({
        report: outcomeReport({ id: "rep-theirs", outcomeKind: "failure" }),
        actor: { id: "op-2", authority: "root" },
        context: sessionContext
      });
    })
  });

  // The message is asserted as well as the type. The write path raises
  // `MemoryConflictError` for several unrelated preconditions — an unresolvable
  // token, an unauthorised reporter, a missing injection event — so asserting
  // the type alone lets a fixture that never reaches the race pass. Only this
  // message is the collision.
  await assert.rejects(
    repository.recordOutcomeReport({
      report: outcomeReport({ outcomeKind: "success" }),
      actor: { id: "op-1", authority: "root" },
      context: sessionContext
    }),
    (error: unknown) =>
      error instanceof MemoryConflictError && /already exists/u.test(error.message)
  );
});

test("a concurrent identical session outcome report is idempotent", async () => {
  // The session table also requires an injection event to exist for the session
  // key before a report will bind, so this seeds one. Without it the write fails
  // earlier with the *same* MemoryConflictError the conflict case asserts, and
  // the conflict case would pass without ever reaching the race.
  const pool = await poolWithInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_session_outcome_reports", async () => {
      await racing.recordSessionOutcomeReport({
        report: sessionReport({ id: "srep-theirs" }),
        actor: { id: "op-2", authority: "curator" },
        context: sessionContext
      });
    })
  });

  const result = await repository.recordSessionOutcomeReport({
    report: sessionReport(),
    actor: { id: "op-1", authority: "curator" },
    context: sessionContext
  });

  assert.equal(result.appended, false);
  assert.equal(result.id, "srep-theirs");
  assert.equal(pool.tables.memory_session_outcome_reports.size, 1);
});

test("a concurrent session outcome report with a different body still conflicts", async () => {
  const pool = await poolWithInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_session_outcome_reports", async () => {
      await racing.recordSessionOutcomeReport({
        report: sessionReport({ id: "srep-theirs", outcomeKind: "partial" }),
        actor: { id: "op-2", authority: "curator" },
        context: sessionContext
      });
    })
  });

  await assert.rejects(
    repository.recordSessionOutcomeReport({
      report: sessionReport({ outcomeKind: "success" }),
      actor: { id: "op-1", authority: "curator" },
      context: sessionContext
    }),
    (error: unknown) =>
      error instanceof MemoryConflictError && /already exists/u.test(error.message)
  );
});

// The use-report table is the third place with this shape, and the one with the
// most preconditions on the way in — eligible injection mode, non-empty packet,
// cited ids a subset of the packet, trajectory evidence — so the collision is
// the only one of several reasons this call can refuse. Matching the message is
// what keeps a refused precondition from passing as a raced conflict.
const useContext: MemoryReadContext = makeContext({
  workspaceId: "ws-use",
  repositoryId: "repo-use",
  taskId: "session-use",
  runId: "session-run",
  agentId: "session-agent"
});

function useInjectionEvent(): MemoryInjectionEvent {
  return {
    id: "inj-use-1",
    workspaceId: "ws-use",
    repositoryId: "repo-use",
    scope: {
      kind: "task",
      workspaceId: "ws-use",
      taskId: "session-use",
      runId: "request-run"
    },
    taskId: "session-use",
    runId: "request-run",
    agentId: "request-agent",
    correlationToken: "token-use-1",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 32,
    memoryIds: ["mem-use-1", "mem-use-2"],
    occurredAt: "2026-10-02T12:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-runtime"
  };
}

function useReport(overrides: Partial<MemoryUseReport> = {}): MemoryUseReport {
  return {
    id: "urep-mine",
    workspaceId: "ws-use",
    repositoryId: "repo-use",
    scope: {
      kind: "task",
      workspaceId: "ws-use",
      taskId: "session-use",
      runId: "session-run"
    },
    taskId: "session-use",
    runId: "session-run",
    agentId: "session-agent",
    injectionEventId: "inj-use-1",
    correlationToken: "token-use-1",
    useKind: "used",
    usedMemoryIds: ["mem-use-1", "mem-use-2"],
    reportedAt: "2026-10-02T12:30:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "trajectory", uri: "codex://captured/session-use" }],
    ...overrides
  };
}

async function poolWithUseInjection(): Promise<FakeMemoryPool> {
  const pool = new FakeMemoryPool();
  await new PostgresMemoryRepository({ pool }).recordInjectionEvent({
    event: useInjectionEvent(),
    actor: { id: "system", authority: "system" },
    context: useContext
  });
  return pool;
}

test("a concurrent identical use report is idempotent", async () => {
  const pool = await poolWithUseInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_injection_use_reports", async () => {
      await racing.recordInjectionUseReport({
        report: useReport({ id: "urep-theirs" }),
        actor: { id: "curator-2", authority: "curator" },
        context: useContext
      });
    })
  });

  const result = await repository.recordInjectionUseReport({
    report: useReport(),
    actor: { id: "curator-1", authority: "curator" },
    context: useContext
  });

  assert.equal(result.appended, false);
  assert.equal(result.id, "urep-theirs");
  assert.equal(pool.tables.memory_injection_use_reports.size, 1);
});

test("a concurrent use report with a different body still conflicts", async () => {
  const pool = await poolWithUseInjection();
  const racing = new PostgresMemoryRepository({ pool });

  const repository = new PostgresMemoryRepository({
    pool: racingPool(pool, "memory_injection_use_reports", async () => {
      await racing.recordInjectionUseReport({
        // A *valid* differing body. `not_used` with the full packet cited would
        // have been refused on the subset invariant before ever reaching the
        // race, so the collision under test would never have happened.
        report: useReport({
          id: "urep-theirs",
          useKind: "partially_used",
          usedMemoryIds: ["mem-use-1"]
        }),
        actor: { id: "curator-2", authority: "curator" },
        context: useContext
      });
    })
  });

  await assert.rejects(
    repository.recordInjectionUseReport({
      report: useReport({ useKind: "used" }),
      actor: { id: "curator-1", authority: "curator" },
      context: useContext
    }),
    (error: unknown) =>
      error instanceof MemoryConflictError && /already exists/u.test(error.message)
  );
});

/**
 * The other half of the same catch block: what an insert failure that is *not*
 * a collision does.
 *
 * `isUniqueViolation` is the only discriminator in those blocks, so every other
 * driver failure has to reach the caller as itself. That is not a stylistic
 * preference. A connection lost, a missing table, a constraint the schema
 * added after this code shipped — all of them would otherwise be reported as
 * `MemoryConflictError("... already exists ...")`, which tells the reporter
 * their report lost a race with another writer. Nothing raced. The reporter
 * reads a collision, concludes a duplicate is already stored, and the report
 * is dropped with no signal that it was never written at all.
 *
 * So the assertion is object identity, not type: it fails both if the error is
 * swallowed and if it is converted, and the converted case is the one that
 * matters. These are the last unexecuted lines of the three write paths.
 *
 * The injected error carries a `code` because that is the harder shape to
 * discriminate. `isUniqueViolation` tests the code's *value*, so an error that
 * has a code and is not `23505` exercises the decision itself rather than the
 * `typeof`/`in` guards above it — and `08006` is a real pg
 * `connection_failure`, not a value invented to pass.
 */
function driverFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function failingInsertPool(
  base: FakeMemoryPool,
  table:
    | "memory_outcome_reports"
    | "memory_session_outcome_reports"
    | "memory_injection_use_reports",
  failure: Error
): MemoryConnectionPool {
  return {
    query: (text, params) => {
      if (text.includes(`INSERT INTO ${table}`)) return Promise.reject(failure);
      return base.query(text, params);
    },
    connect: () => base.connect(),
    end: () => base.end()
  };
}

test("a non-collision outcome-report insert failure surfaces as itself", async () => {
  const pool = await poolWithInjection();
  const failure = driverFailure("08006", "connection terminated unexpectedly");
  const repository = new PostgresMemoryRepository({
    pool: failingInsertPool(pool, "memory_outcome_reports", failure)
  });

  await assert.rejects(
    repository.recordOutcomeReport({
      report: outcomeReport(),
      actor: { id: "op-1", authority: "root" },
      context: sessionContext
    }),
    // Identity, not `instanceof`: `MemoryConflictError` is also what four
    // unrelated preconditions on this path throw, so a type check would pass
    // for a write that never reached the insert at all.
    (error: unknown) => error === failure
  );
  assert.equal(pool.tables.memory_outcome_reports.size, 0);
});

test("a non-collision session-report insert failure surfaces as itself", async () => {
  const pool = await poolWithInjection();
  const failure = driverFailure("08006", "connection terminated unexpectedly");
  const repository = new PostgresMemoryRepository({
    pool: failingInsertPool(pool, "memory_session_outcome_reports", failure)
  });

  await assert.rejects(
    repository.recordSessionOutcomeReport({
      report: sessionReport(),
      actor: { id: "op-1", authority: "curator" },
      context: sessionContext
    }),
    (error: unknown) => error === failure
  );
  assert.equal(pool.tables.memory_session_outcome_reports.size, 0);
});

test("a non-collision use-report insert failure surfaces as itself", async () => {
  const pool = await poolWithUseInjection();
  const failure = driverFailure("08006", "connection terminated unexpectedly");
  const repository = new PostgresMemoryRepository({
    pool: failingInsertPool(pool, "memory_injection_use_reports", failure)
  });

  await assert.rejects(
    repository.recordInjectionUseReport({
      report: useReport(),
      actor: { id: "curator-1", authority: "curator" },
      context: useContext
    }),
    (error: unknown) => error === failure
  );
  assert.equal(pool.tables.memory_injection_use_reports.size, 0);
});