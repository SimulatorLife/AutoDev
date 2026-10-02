import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryOutcomeReport,
  MemoryReadContext
} from "@simulatorlife/autodev-core";

import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import { makeContext } from "./fixtures/builders.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

function repo(pool: FakeMemoryPool): PostgresMemoryRepository {
  return new PostgresMemoryRepository({ pool });
}

const requestContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-A",
  runId: "req-1",
  agentId: "thread-1"
});

const sessionContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-A",
  runId: "session-A",
  agentId: "session-A"
});

const injectionScope = {
  scope: {
    kind: "task" as const,
    workspaceId: "ws-1",
    taskId: "session-A",
    runId: "req-1"
  },
  taskId: "session-A",
  runId: "req-1",
  agentId: "thread-1"
};

function injectionEvent(
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  return {
    id: "inj-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    ...injectionScope,
    correlationToken: "token-a",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 12,
    memoryIds: ["m-1"],
    occurredAt: "2026-01-01T12:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-runner",
    ...overrides
  };
}

function outcomeReport(
  overrides: Partial<MemoryOutcomeReport> = {}
): MemoryOutcomeReport {
  return {
    id: "rep-1",
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
    reportedAt: "2026-01-01T12:30:00.000Z",
    reporterId: "op-1",
    reporterAuthority: "root",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "file", uri: "file:///workspace/repo/PULL_REQUEST.md" }],
    ...overrides
  };
}

/** Writes two reported injections grouped into the same cell, one unreported injection, and one injection outside the default window/workspace/repository so filters have something concrete to exclude. */
async function seedCohortFixtures(
  repository: PostgresMemoryRepository
): Promise<void> {
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-a",
      correlationToken: "tok-a",
      occurredAt: "2026-01-01T00:00:00.000Z"
    }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport({
      id: "rep-a",
      correlationToken: "tok-a",
      outcomeKind: "success",
      reportKind: "task"
    }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-b",
      correlationToken: "tok-b",
      occurredAt: "2026-01-02T00:00:00.000Z"
    }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport({
      id: "rep-b",
      correlationToken: "tok-b",
      outcomeKind: "success",
      reportKind: "task"
    }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-c",
      correlationToken: "tok-c",
      memoryMode: "retrieval-only",
      injectionResult: "empty",
      memoryIds: [],
      packetCharacterCount: 0,
      occurredAt: "2026-01-03T00:00:00.000Z"
    }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
}

const cohortFilterBase = {
  context: makeContext({ workspaceId: "ws-1", repositoryId: "repo-1" }),
  occurredFrom: "2025-12-31T00:00:00.000Z",
  occurredUntil: "2026-01-10T00:00:00.000Z"
};

test("aggregateInjectionOutcomeCohorts groups reported injections by the fixed (memoryMode, injectionResult, sessionCardinality, reportKind, outcomeKind) tuple", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);

  assert.equal(page.schema, "autodev-memory-injection-outcome-cohorts-v1");
  assert.equal(page.workspaceId, "ws-1");
  assert.equal(page.repositoryId, "repo-1");
  assert.equal(page.cells.length, 2);

  const reportedCell = page.cells.find((cell) => cell.reportKind === "task");
  assert.ok(reportedCell);
  assert.equal(reportedCell?.memoryMode, "jit");
  assert.equal(reportedCell?.injectionResult, "injected");
  assert.equal(reportedCell?.outcomeKind, "success");
  // inj-a and inj-b share the grouped tuple: both must collapse into one cell.
  assert.equal(reportedCell?.exposureCount, 2);
  assert.equal(reportedCell?.reportCount, 2);

  assert.equal(page.exposureCount, 3);
  assert.equal(page.reportCount, 2);
});

test("aggregateInjectionOutcomeCohorts returns an explicit unreported cell with null reportKind/outcomeKind and reportCount 0", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);

  const unreportedCell = page.cells.find((cell) => cell.reportKind === null);
  assert.ok(unreportedCell);
  assert.equal(unreportedCell?.outcomeKind, null);
  assert.equal(unreportedCell?.memoryMode, "retrieval-only");
  assert.equal(unreportedCell?.injectionResult, "empty");
  assert.equal(unreportedCell?.exposureCount, 1);
  assert.equal(unreportedCell?.reportCount, 0);
});

test("aggregateInjectionOutcomeCohorts does not attach a report from another repository or task", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);
  const misplacedReport = [...pool.tables.memory_outcome_reports.values()].find(
    (row) => row.correlation_token === "tok-a"
  );
  assert.ok(misplacedReport);
  // Simulate a row written outside the governed repository path. The cohort
  // join must still match the event's exact workspace/repository/task/token.
  misplacedReport.repository_id = "repo-2";

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);
  const reportedCell = page.cells.find((cell) => cell.reportKind === "task");
  assert.equal(reportedCell?.exposureCount, 1);
  assert.equal(reportedCell?.reportCount, 1);
  const unreportedCell = page.cells.find(
    (cell) =>
      cell.memoryMode === "jit" &&
      cell.injectionResult === "injected" &&
      cell.reportKind === null
  );
  assert.equal(unreportedCell?.exposureCount, 1);
  assert.equal(unreportedCell?.reportCount, 0);
  assert.equal(page.reportCount, 1);
});

test("aggregateInjectionOutcomeCohorts enforces reportCount <= exposureCount on every cell and in the page totals", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);

  for (const cell of page.cells) {
    assert.ok(cell.reportCount <= cell.exposureCount);
    assert.ok(Number.isInteger(cell.exposureCount));
    assert.ok(Number.isInteger(cell.reportCount));
  }
  assert.ok(page.reportCount <= page.exposureCount);
  assert.ok(Number.isInteger(page.exposureCount));
  assert.ok(Number.isInteger(page.reportCount));
});

test("aggregateInjectionOutcomeCohorts applies the hard workspace/repository filter", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);
  // A reported injection in a different repository within the same
  // workspace must never appear in a repo-1 cohort page.
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-other-repo",
      repositoryId: "repo-2",
      correlationToken: "tok-other-repo",
      occurredAt: "2026-01-01T06:00:00.000Z"
    }),
    actor: { id: "system", authority: "system" },
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "repo-2",
      taskId: "session-A",
      runId: "req-1",
      agentId: "thread-1"
    })
  });

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);
  assert.equal(page.exposureCount, 3);
});

test("aggregateInjectionOutcomeCohorts applies an inclusive occurred window", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const exactBoundaryPage = await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    occurredFrom: "2026-01-01T00:00:00.000Z",
    occurredUntil: "2026-01-01T00:00:00.000Z"
  });
  // inj-a occurs exactly at both bounds: inclusive on both ends.
  assert.equal(exactBoundaryPage.exposureCount, 1);

  const narrowedPage = await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    occurredFrom: "2026-01-02T00:00:00.001Z",
    occurredUntil: "2026-01-10T00:00:00.000Z"
  });
  // Excludes inj-a (2026-01-01) and inj-b (exactly 2026-01-02T00:00:00.000Z).
  assert.equal(narrowedPage.exposureCount, 1);
});

test("aggregateInjectionOutcomeCohorts applies bounded memoryModes/injectionResults filters", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page = await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    memoryModes: ["jit"],
    injectionResults: ["injected"]
  });
  assert.equal(page.cells.length, 1);
  assert.equal(page.exposureCount, 2);
  assert.equal(page.cells[0]!.memoryMode, "jit");
  assert.equal(
    page.cells[0]!.sessionCardinality,
    "multiple",
    "filtered jit/injected exposures retain the full session cardinality"
  );
});

test("aggregateInjectionOutcomeCohorts applies bounded reportKinds/outcomeKinds filters and naturally excludes unreported cells", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page = await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    reportKinds: ["task"],
    outcomeKinds: ["success"]
  });
  assert.equal(page.cells.length, 1);
  assert.equal(page.cells[0]!.reportKind, "task");
  assert.equal(page.exposureCount, 2);
  assert.equal(page.reportCount, 2);
  assert.equal(
    page.cells[0]!.sessionCardinality,
    "multiple",
    "report/outcome filters do not remove the unreported sibling from the session count"
  );
});

test("aggregateInjectionOutcomeCohorts never returns correlation tokens, IDs, evidence, or reporter identities", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);
  const serialized = JSON.stringify(page);
  for (const forbidden of [
    "tok-a",
    "tok-b",
    "tok-c",
    "inj-a",
    "inj-b",
    "inj-c",
    "rep-a",
    "rep-b",
    "op-1",
    "session-A",
    "req-1",
    "thread-1",
    "PULL_REQUEST.md"
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `cohort page must not leak ${forbidden}`
    );
  }
});

test("aggregateInjectionOutcomeCohorts parameterizes every bound instead of inlining values into the SQL text", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCohortFixtures(repository);
  pool.calls.length = 0;

  await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    memoryModes: ["jit"],
    injectionResults: ["injected"],
    reportKinds: ["task"],
    outcomeKinds: ["success"]
  });

  assert.equal(pool.calls.length, 1);
  const call = pool.calls[0]!;
  assert.match(call.sql, /\$1/);
  for (const boundValue of [
    "ws-1",
    "repo-1",
    cohortFilterBase.occurredFrom,
    cohortFilterBase.occurredUntil
  ]) {
    assert.ok(
      !call.sql.includes(boundValue),
      `SQL must not inline the bound value ${boundValue}`
    );
  }
  assert.doesNotMatch(call.sql, /'jit'|'injected'|'task'|'success'/u);
  for (const boundValue of [
    "ws-1",
    "repo-1",
    cohortFilterBase.occurredFrom,
    cohortFilterBase.occurredUntil
  ]) {
    assert.ok(call.params.includes(boundValue));
  }
  for (const boundEnum of ["jit", "injected", "task", "success"]) {
    assert.ok(
      call.params.some(
        (parameter) => Array.isArray(parameter) && parameter.includes(boundEnum)
      )
    );
  }
});

test("aggregateInjectionOutcomeCohorts rejects a request missing a repositoryId", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        context: makeContext({ workspaceId: "ws-1" })
      }),
    /requires a repository id/
  );
});

test("aggregateInjectionOutcomeCohorts rejects a context that selects a role, task, run, or agent", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  for (const identitySelector of [
    { role: "curator" },
    { taskId: "session-A" },
    { runId: "req-1" },
    { agentId: "thread-1" }
  ] as const) {
    await assert.rejects(
      () =>
        repository.aggregateInjectionOutcomeCohorts({
          ...cohortFilterBase,
          context: makeContext({
            workspaceId: "ws-1",
            repositoryId: "repo-1",
            ...identitySelector
          })
        }),
      /cannot select a role, task, run, or agent/
    );
  }
  assert.equal(pool.calls.length, 0);
});

test("aggregateInjectionOutcomeCohorts rejects an inverted occurred window", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        occurredFrom: "2026-01-10T00:00:00.000Z",
        occurredUntil: "2026-01-01T00:00:00.000Z"
      }),
    /must be greater than or equal to/
  );
});

test("aggregateInjectionOutcomeCohorts rejects an unbounded window exceeding the 365-day maximum", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        occurredFrom: "2024-01-01T00:00:00.000Z",
        occurredUntil: "2026-01-10T00:00:00.000Z"
      }),
    /365-day maximum/
  );
});

test("aggregateInjectionOutcomeCohorts rejects an invalid bounded enum filter value", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        memoryModes: ["not-a-real-mode" as never]
      }),
    /memoryMode is invalid/
  );
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        outcomeKinds: ["not-a-real-outcome" as never]
      }),
    /outcomeKind is invalid/
  );
});

test("aggregateInjectionOutcomeCohorts rejects a non-finite occurred timestamp instead of issuing an unbounded scan", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.aggregateInjectionOutcomeCohorts({
        ...cohortFilterBase,
        occurredFrom: "not-a-date"
      }),
    /not a valid timestamp/
  );
  assert.equal(pool.calls.length, 0);
});

const singleSessionRequestContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-single",
  runId: "req-single",
  agentId: "thread-single"
});

const multiSessionRequestContextA: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-multi",
  runId: "req-multi-1",
  agentId: "thread-multi-1"
});

const multiSessionRequestContextB: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-multi",
  runId: "req-multi-2",
  agentId: "thread-multi-2"
});

function sessionScopedInjectionEvent(
  taskId: string,
  runId: string,
  agentId: string,
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  return injectionEvent({
    scope: { kind: "task", workspaceId: "ws-1", taskId, runId },
    taskId,
    runId,
    agentId,
    ...overrides
  });
}

/**
 * Seeds one single-injection session and one two-injection session, both in
 * the default cohort window, so a cardinality assertion can distinguish
 * `single` from `multiple` within the same cohort read.
 */
async function seedCardinalityFixtures(
  repository: PostgresMemoryRepository
): Promise<void> {
  await repository.recordInjectionEvent({
    event: sessionScopedInjectionEvent(
      "session-single",
      "req-single",
      "thread-single",
      {
        id: "inj-single",
        correlationToken: "tok-single",
        occurredAt: "2026-01-04T00:00:00.000Z"
      }
    ),
    actor: { id: "system", authority: "system" },
    context: singleSessionRequestContext
  });
  await repository.recordInjectionEvent({
    event: sessionScopedInjectionEvent(
      "session-multi",
      "req-multi-1",
      "thread-multi-1",
      {
        id: "inj-multi-1",
        correlationToken: "tok-multi-1",
        memoryMode: "jit",
        injectionResult: "injected",
        occurredAt: "2026-01-05T00:00:00.000Z"
      }
    ),
    actor: { id: "system", authority: "system" },
    context: multiSessionRequestContextA
  });
  await repository.recordInjectionEvent({
    event: sessionScopedInjectionEvent(
      "session-multi",
      "req-multi-2",
      "thread-multi-2",
      {
        id: "inj-multi-2",
        correlationToken: "tok-multi-2",
        memoryMode: "disabled",
        injectionResult: "skipped",
        memoryIds: [],
        packetCharacterCount: 0,
        occurredAt: "2026-01-06T00:00:00.000Z"
      }
    ),
    actor: { id: "system", authority: "system" },
    context: multiSessionRequestContextB
  });
  // This sibling sits outside cohortFilterBase's occurred window. It still
  // contributes to sessionCardinality without contributing an exposure.
  await repository.recordInjectionEvent({
    event: sessionScopedInjectionEvent(
      "session-multi",
      "req-multi-3",
      "thread-multi-3",
      {
        id: "inj-multi-outside-window",
        correlationToken: "tok-multi-outside-window",
        memoryMode: "retrieval-only",
        injectionResult: "empty",
        memoryIds: [],
        packetCharacterCount: 0,
        occurredAt: "2026-02-06T00:00:00.000Z"
      }
    ),
    actor: { id: "system", authority: "system" },
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      taskId: "session-multi",
      runId: "req-multi-3",
      agentId: "thread-multi-3"
    })
  });
}

test("aggregateInjectionOutcomeCohorts marks a one-injection session's cell sessionCardinality 'single'", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCardinalityFixtures(repository);

  const page = await repository.aggregateInjectionOutcomeCohorts(
    cohortFilterBase
  );
  const singleCell = page.cells.find(
    (cell) => cell.sessionCardinality === "single"
  );
  assert.ok(
    singleCell,
    "expected the lone single-injection session to form a 'single' cell"
  );
  assert.equal(singleCell?.memoryMode, "jit");
  assert.equal(singleCell?.injectionResult, "injected");
  assert.equal(singleCell?.exposureCount, 1);

  const multipleCells = page.cells.filter(
    (cell) => cell.sessionCardinality === "multiple"
  );
  // session-multi contributed two distinct (memoryMode, injectionResult)
  // rows (jit/injected and disabled/skipped), so it forms two 'multiple'
  // cells, each still counted once.
  assert.equal(multipleCells.length, 2);
  assert.equal(
    multipleCells.reduce((sum, cell) => sum + cell.exposureCount, 0),
    2
  );
});

test("aggregateInjectionOutcomeCohorts keeps sessionCardinality 'multiple' for a multi-injection session's cell even when a memoryMode filter removes its sibling row", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await seedCardinalityFixtures(repository);

  const filtered = await repository.aggregateInjectionOutcomeCohorts({
    ...cohortFilterBase,
    memoryModes: ["jit"]
  });
  // Only the jit/injected rows survive the filter: one from session-single
  // (cardinality 'single') and one from session-multi (cardinality
  // 'multiple', even though its sibling disabled/skipped row was filtered
  // out of this read).
  assert.equal(filtered.cells.length, 2);
  const multiSessionCell = filtered.cells.find(
    (cell) => cell.sessionCardinality === "multiple"
  );
  assert.ok(multiSessionCell);
  assert.equal(multiSessionCell?.memoryMode, "jit");
  assert.equal(multiSessionCell?.injectionResult, "injected");
  assert.equal(multiSessionCell?.exposureCount, 1);

  const singleSessionCell = filtered.cells.find(
    (cell) => cell.sessionCardinality === "single"
  );
  assert.ok(singleSessionCell);
  assert.equal(singleSessionCell?.exposureCount, 1);
});
