import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryReadContext,
  MemorySessionOutcomeCohortFilter,
  MemorySessionOutcomeReport
} from "@simulatorlife/autodev-core";

import { MemoryConflictError } from "../../src/memory/errors.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import { makeContext } from "./fixtures/builders.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

function repo(pool: FakeMemoryPool): PostgresMemoryRepository {
  return new PostgresMemoryRepository({ pool });
}

function sessionContext(taskId: string): MemoryReadContext {
  return makeContext({
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId,
    runId: taskId,
    agentId: taskId
  });
}

const cohortContext: MemoryReadContext = {
  workspaceId: "ws-1",
  repositoryId: "repo-1",
  canReadGlobal: false,
  canReadTaskHistory: true
};

async function recordInjection(
  repository: PostgresMemoryRepository,
  event: MemoryInjectionEvent
): Promise<void> {
  await repository.recordInjectionEvent({
    event,
    actor: { id: "system", authority: "system" },
    context: sessionContext(event.taskId)
  });
}

function injectionEvent(
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  const taskId = overrides.taskId ?? "session-A";
  const runId = overrides.runId ?? "req-1";
  return {
    id: "inj-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    scope: {
      kind: "task" as const,
      workspaceId: "ws-1",
      taskId,
      runId
    },
    taskId,
    runId,
    agentId: "thread-1",
    correlationToken: "token-a",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 12,
    memoryIds: ["m-1"],
    occurredAt: "2026-09-01T12:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-runner",
    ...overrides
  };
}

function sessionOutcomeReport(
  overrides: Partial<MemorySessionOutcomeReport> = {}
): MemorySessionOutcomeReport {
  const taskId = overrides.taskId ?? "session-A";
  return {
    id: overrides.id ?? "rep-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    taskId,
    outcomeKind: "success",
    reportKind: "pull_request",
    reportedAt: "2026-09-01T13:00:00.000Z",
    reporterId: "curator-1",
    reporterAuthority: "curator",
    reasonCode: "reporter_supplied",
    evidence: [
      {
        kind: "pull_request",
        uri: "https://github.com/owner/repo/pull/42"
      }
    ],
    ...overrides
  };
}

const defaultFilter: MemorySessionOutcomeCohortFilter = {
  context: cohortContext,
  occurredFrom: "2026-09-01T00:00:00.000Z",
  occurredUntil: "2026-09-02T00:00:00.000Z"
};

test("recordSessionOutcomeReport: requires repository scope", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await assert.rejects(
    async () => {
      await repository.recordSessionOutcomeReport({
        report: sessionOutcomeReport({ repositoryId: "" as any }),
        actor: { id: "curator-1", authority: "curator" },
        context: sessionContext("session-A")
      });
    },
    { message: /repository/i }
  );
});

test("recordSessionOutcomeReport: requires at least one recorded injection event", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await assert.rejects(
    async () => {
      await repository.recordSessionOutcomeReport({
        report: sessionOutcomeReport({ taskId: "session-without-injection" }),
        actor: { id: "curator-1", authority: "curator" },
        context: sessionContext("session-without-injection")
      });
    },
    { message: /at least one recorded injection event/i }
  );
});

test("recordSessionOutcomeReport: non-unknown outcome requires non-empty evidence", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({ id: "inj-1", taskId: "session-1" })
  );

  await assert.rejects(
    async () => {
      await repository.recordSessionOutcomeReport({
        report: sessionOutcomeReport({
          taskId: "session-1",
          outcomeKind: "success",
          evidence: []
        }),
        actor: { id: "curator-1", authority: "curator" },
        context: sessionContext("session-1")
      });
    },
    { message: /evidence/i }
  );
});

test("recordSessionOutcomeReport: succeeds, idempotently retries on same body, fails on conflicting body", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({ id: "inj-1", taskId: "session-1" })
  );

  const initial = await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-1",
      taskId: "session-1",
      outcomeKind: "success",
      reportKind: "pull_request"
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-1")
  });
  assert.equal(initial.appended, true);
  assert.equal(initial.id, "rep-1");

  // Fetch report directly
  const fetched = await repository.getSessionOutcomeReport(
    "ws-1",
    "repo-1",
    "session-1"
  );
  assert.notEqual(fetched, null);
  assert.equal(fetched?.outcomeKind, "success");

  // Same body retry -> idempotent (appended: false)
  const retry = await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-2",
      taskId: "session-1",
      outcomeKind: "success",
      reportKind: "pull_request"
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-1")
  });
  assert.equal(retry.appended, false);
  assert.equal(retry.id, "rep-1");

  // Conflicting body -> MemoryConflictError
  await assert.rejects(
    async () => {
      await repository.recordSessionOutcomeReport({
        report: sessionOutcomeReport({
          id: "rep-3",
          taskId: "session-1",
          outcomeKind: "failure",
          reportKind: "pull_request",
          evidence: [{ kind: "issue", uri: "https://example.com/issue/1" }]
        }),
        actor: { id: "curator-1", authority: "curator" },
        context: sessionContext("session-1")
      });
    },
    (err: unknown) => {
      return (
        err instanceof MemoryConflictError && /conflict/i.test(err.message)
      );
    }
  );
});

test("aggregateSessionOutcomeCohorts: zero reports yields unreported session cell", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-1",
      correlationToken: "token-1",
      memoryMode: "jit"
    })
  );

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.schema, "autodev-memory-session-outcome-cohorts-v1");
  assert.equal(page.sessionCount, 1);
  assert.equal(page.reportedSessionCount, 0);
  assert.equal(page.unreportedSessionCount, 1);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 0);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "jit",
      outcomeKind: null,
      sessionCount: 1
    }
  ]);
});

test("aggregateSessionOutcomeCohorts: one report yields reported session cell", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-1",
      correlationToken: "token-1",
      memoryMode: "jit"
    })
  );
  await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-1",
      taskId: "session-1",
      outcomeKind: "success",
      reportKind: "pull_request"
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-1")
  });

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 1);
  assert.equal(page.reportedSessionCount, 1);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 0);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "jit",
      outcomeKind: "success",
      sessionCount: 1
    }
  ]);
});

test("aggregateSessionOutcomeCohorts: multiple injections in the same session still count as one session", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-1",
      runId: "req-1",
      correlationToken: "token-1",
      memoryMode: "retrieval-only"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-2",
      taskId: "session-1",
      runId: "req-2",
      correlationToken: "token-2",
      memoryMode: "retrieval-only"
    })
  );
  await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-1",
      taskId: "session-1",
      outcomeKind: "success",
      reportKind: "pull_request"
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-1")
  });

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 1);
  assert.equal(page.reportedSessionCount, 1);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 0);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "retrieval-only",
      outcomeKind: "success",
      sessionCount: 1
    }
  ]);
});

test("aggregateSessionOutcomeCohorts: report with unknown outcome is treated as reported (not unreported)", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-1",
      correlationToken: "token-1",
      memoryMode: "disabled"
    })
  );
  await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-1",
      taskId: "session-1",
      outcomeKind: "unknown",
      reportKind: "other",
      evidence: []
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-1")
  });

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 1);
  assert.equal(page.reportedSessionCount, 1);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "disabled",
      outcomeKind: "unknown",
      sessionCount: 1
    }
  ]);
});

test("aggregateSessionOutcomeCohorts: mixed mode sessions are excluded from cells and counted in mixedModeSessionCount", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-mixed",
      runId: "req-1",
      correlationToken: "token-1",
      memoryMode: "jit",
      occurredAt: "2026-09-01T12:00:00.000Z"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-2",
      taskId: "session-mixed",
      runId: "req-2",
      correlationToken: "token-2",
      memoryMode: "disabled",
      occurredAt: "2026-09-01T13:00:00.000Z"
    })
  );

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 0);
  assert.equal(page.reportedSessionCount, 0);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 1);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.deepEqual(page.cells, []);
});

test("aggregateSessionOutcomeCohorts: mode filter selects observed sessions but full-session mode remains mixed", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  // Session has 'jit' in-window, and 'retrieval-only' out-of-window
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-multi",
      runId: "req-1",
      correlationToken: "token-1",
      memoryMode: "jit",
      occurredAt: "2026-09-01T12:00:00.000Z"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-2",
      taskId: "session-multi",
      runId: "req-2",
      correlationToken: "token-2",
      memoryMode: "retrieval-only",
      occurredAt: "2026-08-01T12:00:00.000Z"
    })
  );

  // Query with memoryModes: ['jit'] - selects session because it has a 'jit' event in window
  const page = await repository.aggregateSessionOutcomeCohorts({
    ...defaultFilter,
    memoryModes: ["jit"]
  });

  // Full-session mode is mixed, so the session is excluded from cells and
  // counted only in mixedModeSessionCount, even though it matched the
  // in-window mode filter.
  assert.equal(page.sessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 1);
  assert.deepEqual(page.cells, []);
});

test("aggregateSessionOutcomeCohorts: invalid/unknown-only sessions are excluded entirely, never coerced to disabled", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-1",
      taskId: "session-inv",
      correlationToken: "token-inv",
      memoryMode: "invalid",
      occurredAt: "2026-09-01T12:00:00.000Z"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-2",
      taskId: "session-unk",
      correlationToken: "token-unk",
      memoryMode: "unknown",
      occurredAt: "2026-09-01T12:00:00.000Z"
    })
  );

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 0);
  assert.equal(page.reportedSessionCount, 0);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 0);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.deepEqual(page.cells, []);
});

test("aggregateSessionOutcomeCohorts: multi-session scenario with non-leaking check", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  // 3 sessions with jit/success
  for (let i = 1; i <= 3; i++) {
    const taskId = `task-jit-s-${i}`;
    await recordInjection(
      repository,
      injectionEvent({
        id: `inj-jit-s-${i}`,
        taskId,
        correlationToken: `tok-jit-s-${i}`,
        memoryMode: "jit"
      })
    );
    await repository.recordSessionOutcomeReport({
      report: sessionOutcomeReport({
        id: `rep-jit-s-${i}`,
        taskId,
        outcomeKind: "success",
        reportKind: "pull_request"
      }),
      actor: { id: "curator-1", authority: "curator" },
      context: sessionContext(taskId)
    });
  }

  // 1 session with jit/unreported
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-jit-unrep",
      taskId: "task-jit-unrep",
      correlationToken: "tok-jit-unrep",
      memoryMode: "jit"
    })
  );

  // 1 session with mixed modes -- excluded from cells, counted separately
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-mix-1",
      taskId: "task-mix",
      runId: "req-1",
      correlationToken: "tok-mix-1",
      memoryMode: "jit"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-mix-2",
      taskId: "task-mix",
      runId: "req-2",
      correlationToken: "tok-mix-2",
      memoryMode: "retrieval-only"
    })
  );

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  // sessionCount excludes the mixed-mode session: 3 reported jit + 1
  // unreported jit = 4 single-assigned-mode sessions.
  assert.equal(page.sessionCount, 4);
  assert.equal(page.reportedSessionCount, 3);
  assert.equal(page.unreportedSessionCount, 1);
  assert.equal(page.conflictingOutcomeSessionCount, 0);
  assert.equal(page.mixedModeSessionCount, 1);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "jit",
      outcomeKind: null,
      sessionCount: 1
    },
    {
      memoryMode: "jit",
      outcomeKind: "success",
      sessionCount: 3
    }
  ]);

  // Non-leaking response checks:
  const json = JSON.stringify(page);
  assert.equal(json.includes("tok-"), false, "never leaks correlation tokens");
  assert.equal(json.includes("task-"), false, "never leaks task IDs");
  assert.equal(json.includes("curator-"), false, "never leaks reporter id");
  assert.equal(
    json.includes("https://github.com"),
    false,
    "never leaks evidence"
  );
});

test("aggregateSessionOutcomeCohorts: computes conflictingOutcomeSessionCount from per-injection token reports", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);

  // Session with 2 injections and conflicting token-level reports
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-conflict-1",
      taskId: "session-conflict",
      runId: "req-1",
      correlationToken: "tok-conflict-1",
      memoryMode: "jit"
    })
  );
  await recordInjection(
    repository,
    injectionEvent({
      id: "inj-conflict-2",
      taskId: "session-conflict",
      runId: "req-2",
      correlationToken: "tok-conflict-2",
      memoryMode: "jit"
    })
  );

  // Token 1 reported as success
  await repository.recordOutcomeReport({
    report: {
      id: "rep-tok-1",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      scope: {
        kind: "task",
        workspaceId: "ws-1",
        taskId: "session-conflict",
        runId: "req-1"
      },
      taskId: "session-conflict",
      runId: "req-1",
      agentId: "thread-1",
      correlationToken: "tok-conflict-1",
      outcomeKind: "success",
      reportKind: "task",
      reportedAt: "2026-09-01T13:00:00.000Z",
      reporterId: "curator-1",
      reporterAuthority: "curator",
      reasonCode: "reporter_supplied",
      evidence: [{ kind: "document", uri: "https://example.com/doc1" }]
    },
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-conflict")
  });

  // Token 2 reported as failure -> conflicting per-injection outcomes
  await repository.recordOutcomeReport({
    report: {
      id: "rep-tok-2",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      scope: {
        kind: "task",
        workspaceId: "ws-1",
        taskId: "session-conflict",
        runId: "req-2"
      },
      taskId: "session-conflict",
      runId: "req-2",
      agentId: "thread-1",
      correlationToken: "tok-conflict-2",
      outcomeKind: "failure",
      reportKind: "task",
      reportedAt: "2026-09-01T13:05:00.000Z",
      reporterId: "curator-1",
      reporterAuthority: "curator",
      reasonCode: "reporter_supplied",
      evidence: [{ kind: "document", uri: "https://example.com/doc2" }]
    },
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-conflict")
  });

  // Session-level report is recorded and remains canonical regardless of
  // the per-injection token disagreement above.
  await repository.recordSessionOutcomeReport({
    report: sessionOutcomeReport({
      id: "rep-sess-1",
      taskId: "session-conflict",
      outcomeKind: "success",
      reportKind: "task"
    }),
    actor: { id: "curator-1", authority: "curator" },
    context: sessionContext("session-conflict")
  });

  const page = await repository.aggregateSessionOutcomeCohorts(defaultFilter);

  assert.equal(page.sessionCount, 1);
  assert.equal(page.reportedSessionCount, 1);
  assert.equal(page.unreportedSessionCount, 0);
  assert.equal(page.conflictingOutcomeSessionCount, 1);
  assert.equal(page.mixedModeSessionCount, 0);
  assert.deepEqual(page.cells, [
    {
      memoryMode: "jit",
      outcomeKind: "success",
      sessionCount: 1
    }
  ]);
});
