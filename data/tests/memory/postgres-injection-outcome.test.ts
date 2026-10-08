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

const sessionContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-A",
  runId: "session-A",
  agentId: "session-A"
});

/**
 * Request-level context used to write the injection event. The runtime emits
 * injection events whose runId/agentId differ from the captured session
 * identity (runId=requestId, agentId=threadId); the event row retains those
 * request-level identifiers while the task id is the session identity.
 */
const requestContext: MemoryReadContext = makeContext({
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  taskId: "session-A",
  runId: "req-1",
  agentId: "thread-1"
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
    occurredAt: "2026-10-01T12:00:00.000Z",
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
    reportedAt: "2026-10-01T12:30:00.000Z",
    reporterId: "op-1",
    reporterAuthority: "root",
    reasonCode: "reporter_supplied",
    evidence: [{ kind: "file", uri: "file:///workspace/repo/PULL_REQUEST.md" }],
    ...overrides
  };
}

test("recordInjectionEvent appends and rejects a duplicate token", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  const event = injectionEvent();
  const first = await repository.recordInjectionEvent({
    event,
    actor: { id: "system", authority: "system" },
    context: sessionContext
  });
  assert.equal(first.appended, true);
  assert.equal(pool.tables.memory_injection_events.size, 1);
  const second = await repository.recordInjectionEvent({
    event,
    actor: { id: "system", authority: "system" },
    context: sessionContext
  });
  assert.equal(second.appended, false);
  assert.equal(pool.tables.memory_injection_events.size, 1);
});

test("recordOutcomeReport rejects a correlationToken without a scope-aligned injection", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await assert.rejects(
    () =>
      repository.recordOutcomeReport({
        report: outcomeReport(),
        actor: { id: "op-1", authority: "root" },
        context: sessionContext
      }),
    /no scope-aligned injection/
  );
});

test("recordOutcomeReport rejects when the same token lives in a different session", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await assert.rejects(
    () =>
      repository.recordOutcomeReport({
        report: outcomeReport({ correlationToken: "token-a" }),
        actor: { id: "op-1", authority: "root" },
        context: makeContext({
          workspaceId: "ws-1",
          repositoryId: "repo-1",
          taskId: "session-B",
          runId: "session-B",
          agentId: "session-B"
        })
      }),
    /no scope-aligned injection/
  );
});

test("recordOutcomeReport rejects when the same token lives in a different repository", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await assert.rejects(
    () =>
      repository.recordOutcomeReport({
        report: outcomeReport(),
        actor: { id: "op-1", authority: "root" },
        context: makeContext({
          workspaceId: "ws-1",
          repositoryId: "repo-2",
          taskId: "session-A",
          runId: "session-A",
          agentId: "session-A"
        })
      }),
    /no scope-aligned injection/
  );
});

test("recordOutcomeReport rejects a worker or system reporter authority at the Data boundary", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  for (const reporterAuthority of ["worker", "system"] as const) {
    await assert.rejects(
      () =>
        repository.recordOutcomeReport({
          // The Data boundary authorizes the trusted actor, not report
          // fields that a caller could forge.
          report: outcomeReport({ reporterAuthority: "root" }),
          actor: { id: "untrusted-reporter", authority: reporterAuthority },
          context: sessionContext
        }),
      /root or curator/
    );
  }
});

test("recordOutcomeReport rejects a non-unknown outcome that has no evidence", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await assert.rejects(
    () =>
      repository.recordOutcomeReport({
        report: outcomeReport({ evidence: [] }),
        actor: { id: "op-1", authority: "root" },
        context: sessionContext
      }),
    /evidence reference/
  );
});

test("recordOutcomeReport persists a valid success report with reporterAuthority from actor", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  const result = await repository.recordOutcomeReport({
    report: outcomeReport({
      reporterId: "forged-reporter",
      reporterAuthority: "curator"
    }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  assert.equal(result.appended, true);
  assert.equal(pool.tables.memory_outcome_reports.size, 1);
  const row = [...pool.tables.memory_outcome_reports.values()][0]!;
  assert.equal(row.reporter_id, "op-1");
  assert.equal(row.reporter_authority, "root");
});

test("recordOutcomeReport allows identical retries but conflicts on a different report for the same correlationToken", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  const first = await repository.recordOutcomeReport({
    report: outcomeReport(),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  assert.equal(first.appended, true);
  // A retry with an identical body (even under a different caller-supplied
  // id) must not create a second row: one outcome report per
  // correlationToken, and the retry is safe to repeat.
  const retry = await repository.recordOutcomeReport({
    report: outcomeReport({ id: "rep-2" }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  assert.equal(retry.appended, false);
  assert.equal(retry.id, first.id);
  assert.equal(pool.tables.memory_outcome_reports.size, 1);
  await assert.rejects(
    () =>
      repository.recordOutcomeReport({
        report: outcomeReport({ id: "rep-2", outcomeKind: "failure" }),
        actor: { id: "op-1", authority: "root" },
        context: sessionContext
      }),
    /conflicts with a previously recorded report/
  );
  assert.equal(pool.tables.memory_outcome_reports.size, 1);
});

test("listInjectionOutcomeJoins returns one row per injection with outcome attached", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport(),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  const page = await repository.listInjectionOutcomeJoins({
    context: sessionContext
  });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.injection.runId, "req-1");
  assert.equal(page.items[0]!.outcome?.outcomeKind, "success");
  assert.equal(page.items[0]!.outcome?.runId, "session-A");
  assert.equal(page.items[0]!.outcome?.agentId, "session-A");
});

test("listInjectionOutcomeJoins excludes rows whose injection ran in a different request but the same session", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  // request-level runId differs from session runId: this must still match because
  // the join key is (workspace, repository, task).
  await repository.recordInjectionEvent({
    event: injectionEvent({ runId: "req-other", agentId: "thread-other" }),
    actor: { id: "system", authority: "system" },
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      taskId: "session-A",
      runId: "req-other",
      agentId: "thread-other"
    })
  });
  await repository.recordOutcomeReport({
    report: outcomeReport(),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  const page = await repository.listInjectionOutcomeJoins({
    context: sessionContext
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0]!.injection.runId, "req-other");
  assert.equal(page.items[0]!.outcome?.outcomeKind, "success");
});

test("listInjectionOutcomeJoins defaults to reported-only and reveals unreported rows via includeUnreported", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent({ id: "inj-reported", correlationToken: "rep" }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport({ correlationToken: "rep" }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-pending",
      correlationToken: "pen",
      memoryIds: [],
      packetCharacterCount: 0
    }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  const reportedOnly = await repository.listInjectionOutcomeJoins({
    context: sessionContext
  });
  assert.equal(reportedOnly.total, 1);
  const withUnreported = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    includeUnreported: true
  });
  assert.equal(withUnreported.total, 2);
  assert.equal(
    withUnreported.items.find((row) => row.injection.id === "inj-pending")
      ?.outcome,
    null
  );
});

test("listInjectionOutcomeJoins does not match injection events in a different session", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport(),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  const otherSession = makeContext({
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId: "session-OTHER",
    runId: "session-OTHER",
    agentId: "session-OTHER"
  });
  const page = await repository.listInjectionOutcomeJoins({
    context: otherSession
  });
  assert.equal(page.total, 0);
});

test("listInjectionOutcomeJoins reports sessionInjectionCount of 1 for a single-injection session", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent(),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  const page = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    includeUnreported: true
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0]!.sessionInjectionCount, 1);
});

test("listInjectionOutcomeJoins reports sessionInjectionCount across every request-level injection in the session, inclusive of the current row", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent({ id: "inj-1", correlationToken: "tok-1" }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-2",
      correlationToken: "tok-2",
      runId: "req-2",
      agentId: "thread-2"
    }),
    actor: { id: "system", authority: "system" },
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      taskId: "session-A",
      runId: "req-2",
      agentId: "thread-2"
    })
  });
  const page = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    includeUnreported: true
  });
  assert.equal(page.total, 2);
  for (const item of page.items) {
    assert.equal(item.sessionInjectionCount, 2);
  }
});

test("listInjectionOutcomeJoins sessionInjectionCount is not reduced by memory-mode/result filters on the surrounding query", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-jit",
      correlationToken: "tok-jit",
      memoryMode: "jit",
      injectionResult: "injected"
    }),
    actor: { id: "system", authority: "system" },
    context: requestContext
  });
  await repository.recordInjectionEvent({
    event: injectionEvent({
      id: "inj-disabled",
      correlationToken: "tok-disabled",
      memoryMode: "disabled",
      injectionResult: "skipped",
      runId: "req-2",
      agentId: "thread-2"
    }),
    actor: { id: "system", authority: "system" },
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      taskId: "session-A",
      runId: "req-2",
      agentId: "thread-2"
    })
  });
  const filtered = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    includeUnreported: true,
    memoryModes: ["jit"]
  });
  assert.equal(filtered.total, 1);
  assert.equal(
    filtered.items[0]!.sessionInjectionCount,
    2,
    "the session's full event set has two injections even though the memoryMode filter only surfaces one row"
  );
});

/**
 * The outcome list's own filters, and the session it refuses to list without.
 *
 * `listInjectionOutcomeJoins` narrows on injection result, outcome kind and
 * report kind, and this file exercised none of the three -- `includeUnreported`
 * and `memoryModes` were covered, these were not. They are the filters an
 * operator drives from the evaluations tab, so a list that ignored them would
 * show every row and look correct.
 *
 * The missing-task guard is asserted as *no query*, not as an empty page: a
 * context with no taskId builds `scope_task_id = ''`, which matches no row, so
 * the unguarded query returns the same empty page and an assertion on the page
 * proves nothing about whether the guard fired.
 */
test("the outcome list applies its own filters and refuses a context without a session", async () => {
  const statements: string[] = [];
  const base = new FakeMemoryPool();
  const pool = {
    query: <Row extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[]
    ) => {
      statements.push(text);
      return base.query<Row>(text, params);
    },
    connect: () => base.connect(),
    end: () => base.end()
  };
  const repository = new PostgresMemoryRepository({ pool });

  const injected = injectionEvent({ id: "inj-injected", correlationToken: "token-injected" });
  const empty = injectionEvent({
    id: "inj-empty",
    correlationToken: "token-empty",
    injectionResult: "empty",
    memoryIds: [],
    packetCharacterCount: 0,
    reasonCode: "no_packet_research_returned_empty"
  });
  const reported = injectionEvent({
    id: "inj-reported",
    correlationToken: "token-reported",
    runId: "req-2",
    agentId: "thread-2"
  });
  for (const event of [injected, empty, reported]) {
    await repository.recordInjectionEvent({
      event,
      actor: { id: "test-runner", authority: "system" },
      context: { ...requestContext, taskId: event.taskId }
    });
  }
  console.log("EVENT ROWS", JSON.stringify([...base.tables.memory_injection_events.values()].map((r) => ({ id: r.id, token: r.correlation_token, ws: r.scope_workspace_id, repo: r.repository_id, task: r.scope_task_id })), null, 1));
  await repository.recordOutcomeReport({
    report: outcomeReport({
      correlationToken: injected.correlationToken,
      outcomeKind: "success",
      reportKind: "task"
    }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });
  await repository.recordOutcomeReport({
    report: outcomeReport({
      id: "rep-2",
      correlationToken: "token-reported",
      outcomeKind: "failure",
      reportKind: "pull_request"
    }),
    actor: { id: "op-1", authority: "root" },
    context: sessionContext
  });

  assert.equal(
    (await repository.listInjectionOutcomeJoins({ context: sessionContext })).total,
    2,
    "only the two reported exposures are listed by default"
  );

  const byResult = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    injectionResults: ["empty"],
    includeUnreported: true
  });
  assert.equal(byResult.total, 1);
  assert.equal(
    byResult.items[0]?.injection.id,
    empty.id,
    "injectionResults must narrow the list"
  );

  const byOutcome = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    outcomeKinds: ["failure"]
  });
  assert.equal(byOutcome.total, 1);
  assert.equal(
    byOutcome.items[0]?.injection.id,
    reported.id,
    "outcomeKinds narrows by the reporter-supplied outcome"
  );
  assert.equal(
    (
      await repository.listInjectionOutcomeJoins({
        context: sessionContext,
        outcomeKinds: ["unknown"]
      })
    ).total,
    0,
    "an outcome kind no report carries selects nothing"
  );

  const byReportKind = await repository.listInjectionOutcomeJoins({
    context: sessionContext,
    reportKinds: ["pull_request"]
  });
  assert.equal(byReportKind.total, 1);
  assert.equal(
    byReportKind.items[0]?.injection.id,
    reported.id,
    "reportKinds narrows by the kind of evidence the report cites"
  );
  assert.equal(
    (
      await repository.listInjectionOutcomeJoins({
        context: sessionContext,
        reportKinds: ["issue"]
      })
    ).total,
    0,
    "a report kind no report carries selects nothing"
  );

  // The context that cannot name a session. The repository is optional here --
  // only the task id is required -- so that is the one field broken.
  const { taskId: _noTask, ...withoutTask } = sessionContext;
  for (const [why, context] of [
    ["no task", withoutTask],
    ["a blank task", { ...sessionContext, taskId: "  " }]
  ] as const) {
    const before = statements.length;
    const page = await repository.listInjectionOutcomeJoins({ context });
    assert.deepEqual(
      { items: page.items, total: page.total },
      { items: [], total: 0 },
      `${why} must list nothing`
    );
    assert.equal(
      statements.length,
      before,
      `${why} must be refused before any query runs -- an outcome list scoped to no task is a query over every task in the workspace`
    );
  }
});
