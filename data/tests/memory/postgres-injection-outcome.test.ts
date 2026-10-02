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
    evidence: [
      { kind: "file", uri: "file:///workspace/repo/PULL_REQUEST.md" }
    ],
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
