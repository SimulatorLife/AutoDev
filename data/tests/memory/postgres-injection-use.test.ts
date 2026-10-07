import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryReadContext,
  MemoryUseReport
} from "@simulatorlife/autodev-core";

import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import { makeContext, makeExperience } from "./fixtures/builders.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

const sessionContext: MemoryReadContext = makeContext({
  workspaceId: "ws-use",
  repositoryId: "repo-use",
  taskId: "session-use",
  runId: "session-run",
  agentId: "session-agent"
});

const requestContext: MemoryReadContext = {
  ...sessionContext,
  runId: "request-run",
  agentId: "request-agent"
};

function repo(pool = new FakeMemoryPool()): PostgresMemoryRepository {
  return new PostgresMemoryRepository({ pool });
}

function injectionEvent(
  overrides: Partial<MemoryInjectionEvent> = {}
): MemoryInjectionEvent {
  const workspaceId = overrides.workspaceId ?? "ws-use";
  const taskId = overrides.taskId ?? "session-use";
  const runId = overrides.runId ?? "request-run";
  return {
    id: "inj-use-1",
    workspaceId,
    repositoryId: "repo-use",
    scope: {
      kind: "task",
      workspaceId,
      taskId,
      runId
    },
    taskId,
    runId,
    agentId: "request-agent",
    correlationToken: "token-use-1",
    memoryMode: "jit",
    injectionResult: "injected",
    packetCharacterCount: 32,
    memoryIds: ["mem-use-1", "mem-use-2"],
    occurredAt: "2026-10-02T12:00:00.000Z",
    reasonCode: "packet_attached",
    evidence: [],
    recordedBy: "test-runtime",
    ...overrides
  };
}

const trajectoryEvidence = [
  { kind: "trajectory" as const, uri: "codex://captured/session-use" }
];

function useReport(
  event: MemoryInjectionEvent,
  overrides: Partial<MemoryUseReport> = {}
): MemoryUseReport {
  const useKind = overrides.useKind ?? "used";
  return {
    id: `report-${event.id}`,
    workspaceId: event.workspaceId,
    repositoryId: event.repositoryId ?? "repo-use",
    scope: {
      kind: "task",
      workspaceId: event.workspaceId,
      taskId: event.taskId,
      runId: "session-run"
    },
    taskId: event.taskId,
    runId: "session-run",
    agentId: "session-agent",
    injectionEventId: event.id,
    correlationToken: event.correlationToken,
    useKind,
    usedMemoryIds:
      useKind === "used"
        ? [...event.memoryIds]
        : useKind === "partially_used"
          ? event.memoryIds.slice(0, 1)
          : [],
    reportedAt: "2026-10-02T12:30:00.000Z",
    reporterId: "untrusted-caller-value",
    reporterAuthority: "curator",
    reasonCode:
      useKind === "unobservable"
        ? "reporter_unobservable"
        : "reporter_supplied",
    evidence: useKind === "unobservable" ? [] : trajectoryEvidence,
    ...overrides
  };
}

async function appendInjection(
  repository: PostgresMemoryRepository,
  event: MemoryInjectionEvent
): Promise<void> {
  await repository.recordInjectionEvent({
    event,
    actor: { id: "runtime", authority: "system" },
    context: { ...requestContext, taskId: event.taskId }
  });
}

test("getInjectionEventByIdForSession resolves only the trusted workspace/repository/task event", async () => {
  const repository = repo();
  const event = injectionEvent();
  await appendInjection(repository, event);

  assert.equal(
    (
      await repository.getInjectionEventByIdForSession(
        {
          workspaceId: event.workspaceId,
          repositoryId: event.repositoryId!,
          taskId: event.taskId,
          canReadGlobal: false
        },
        event.id
      )
    )?.correlationToken,
    event.correlationToken
  );
  assert.equal(
    await repository.getInjectionEventByIdForSession(
      {
        workspaceId: event.workspaceId,
        repositoryId: event.repositoryId!,
        taskId: "other-session",
        canReadGlobal: false
      },
      event.id
    ),
    null
  );
});

test("recordInjectionUseReport enforces actor, repository, eligible mode, status, subset, and trajectory invariants", async () => {
  const repository = repo();
  const event = injectionEvent();
  await appendInjection(repository, event);
  const record = (
    report: MemoryUseReport,
    authority: "root" | "curator" | "worker" = "root"
  ) =>
    repository.recordInjectionUseReport({
      report,
      actor: { id: "trusted-curator", authority },
      context: sessionContext
    });

  await assert.rejects(
    () => record(useReport(event), "worker"),
    /authority must be root or curator/u
  );
  await assert.rejects(
    () => record(useReport(event, { repositoryId: " " })),
    /require a repository id/u
  );
  await assert.rejects(
    () => record(useReport(event, { usedMemoryIds: ["not-in-packet"] })),
    /subset of the injected memoryIds/u
  );
  await assert.rejects(
    () => record(useReport(event, { usedMemoryIds: ["mem-use-1"] })),
    /must cite every injected memory id/u
  );
  await assert.rejects(
    () =>
      record(
        useReport(event, {
          useKind: "partially_used",
          usedMemoryIds: [...event.memoryIds]
        })
      ),
    /non-empty strict subset/u
  );
  await assert.rejects(
    () =>
      record(
        useReport(event, { useKind: "not_used", usedMemoryIds: ["mem-use-1"] })
      ),
    /must not cite any memory id/u
  );
  await assert.rejects(
    () => record(useReport(event, { evidence: [] })),
    /require a trajectory evidence reference/u
  );
  await assert.rejects(
    () => record(useReport(event, { reasonCode: "scope_mismatch" as never })),
    /reasonCode is invalid/u
  );

  const disabledEvent = injectionEvent({
    id: "inj-use-disabled",
    correlationToken: "token-use-disabled",
    memoryMode: "disabled"
  });
  await appendInjection(repository, disabledEvent);
  await assert.rejects(
    () => record(useReport(disabledEvent), "root"),
    /eligible injected event/u
  );

  const emptyEvent = injectionEvent({
    id: "inj-use-empty",
    correlationToken: "token-use-empty",
    injectionResult: "empty",
    memoryIds: [],
    packetCharacterCount: 0,
    reasonCode: "no_packet_research_returned_empty"
  });
  await appendInjection(repository, emptyEvent);
  await assert.rejects(
    () => record(useReport(emptyEvent), "root"),
    /eligible injected event/u
  );
});

test("recordInjectionUseReport persists trusted reporter authority and supports idempotent retry/conflict", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  const event = injectionEvent();
  await appendInjection(repository, event);

  const first = await repository.recordInjectionUseReport({
    report: useReport(event),
    actor: { id: "root-operator", authority: "root" },
    context: sessionContext
  });
  assert.equal(first.appended, true);
  assert.equal(pool.tables.memory_injection_use_reports.size, 1);

  const retry = await repository.recordInjectionUseReport({
    report: useReport(event, {
      id: "retry-id",
      reportedAt: "2026-10-03T00:00:00.000Z",
      usedMemoryIds: ["mem-use-2", "mem-use-1"]
    }),
    actor: { id: "different-curator", authority: "curator" },
    context: sessionContext
  });
  assert.deepEqual(retry, { appended: false, id: first.id });
  assert.equal(pool.tables.memory_injection_use_reports.size, 1);
  const persisted = [...pool.tables.memory_injection_use_reports.values()][0]!;
  assert.equal(persisted.reporter_id, "root-operator");
  assert.equal(persisted.reporter_authority, "root");

  await assert.rejects(
    () =>
      repository.recordInjectionUseReport({
        report: useReport(event, {
          id: "conflict-id",
          useKind: "partially_used",
          usedMemoryIds: ["mem-use-1"]
        }),
        actor: { id: "root-operator", authority: "root" },
        context: sessionContext
      }),
    /conflicts with a previously recorded report/u
  );
  assert.equal(pool.tables.memory_injection_use_reports.size, 1);
  assert.equal(
    (
      await repository.getInjectionUseReport(
        event.workspaceId,
        event.correlationToken
      )
    )?.id,
    first.id
  );

  const unobservableEvent = injectionEvent({
    id: "inj-use-unobservable",
    correlationToken: "token-use-unobservable"
  });
  await appendInjection(repository, unobservableEvent);
  const unobservable = await repository.recordInjectionUseReport({
    report: useReport(unobservableEvent, {
      id: "report-unobservable",
      useKind: "unobservable",
      usedMemoryIds: [],
      reasonCode: "reporter_unobservable",
      evidence: []
    }),
    actor: { id: "curator", authority: "curator" },
    context: sessionContext
  });
  assert.equal(unobservable.appended, true);
  assert.equal(
    (
      await repository.getInjectionUseReport(
        unobservableEvent.workspaceId,
        unobservableEvent.correlationToken
      )
    )?.reasonCode,
    "reporter_unobservable"
  );
});

test("listInjectionUseJoins returns eligible exposures and explicit unassessed rows only when requested", async () => {
  const repository = repo();
  const reported = injectionEvent();
  const pending = injectionEvent({
    id: "inj-use-pending",
    correlationToken: "token-use-pending",
    runId: "request-run-2",
    agentId: "request-agent-2"
  });
  const empty = injectionEvent({
    id: "inj-use-empty-join",
    correlationToken: "token-use-empty-join",
    injectionResult: "empty",
    memoryIds: [],
    packetCharacterCount: 0,
    reasonCode: "no_packet_research_returned_empty"
  });
  const disabled = injectionEvent({
    id: "inj-use-disabled-join",
    correlationToken: "token-use-disabled-join",
    memoryMode: "disabled"
  });
  for (const event of [reported, pending, empty, disabled]) {
    await appendInjection(repository, event);
  }
  await repository.recordInjectionUseReport({
    report: useReport(reported, { useKind: "partially_used" }),
    actor: { id: "curator", authority: "curator" },
    context: sessionContext
  });

  const assessedOnly = await repository.listInjectionUseJoins({
    context: sessionContext
  });
  assert.equal(assessedOnly.total, 1);
  assert.equal(assessedOnly.items[0]?.use?.useKind, "partially_used");
  const includeUnassessed = await repository.listInjectionUseJoins({
    context: sessionContext,
    includeUnassessed: true
  });
  assert.equal(includeUnassessed.total, 2);
  assert.equal(
    includeUnassessed.items.find((item) => item.injection.id === pending.id)
      ?.use,
    null
  );
  assert.equal(includeUnassessed.items[0]?.sessionInjectionCount, 4);
});

test("aggregateInjectionUseCohorts includes unassessed eligible exposures, filters disabled to zero, and keeps full-session cardinality", async () => {
  const repository = repo();
  const eligibleReported = injectionEvent({
    id: "inj-use-cohort-reported",
    correlationToken: "token-use-cohort-reported",
    taskId: "cohort-session"
  });
  const eligibleUnassessed = injectionEvent({
    id: "inj-use-cohort-pending",
    correlationToken: "token-use-cohort-pending",
    taskId: "cohort-session",
    runId: "request-run-2"
  });
  const emptySibling = injectionEvent({
    id: "inj-use-cohort-empty",
    correlationToken: "token-use-cohort-empty",
    taskId: "cohort-session",
    injectionResult: "empty",
    memoryIds: [],
    packetCharacterCount: 0,
    reasonCode: "no_packet_research_returned_empty"
  });
  const disabledSibling = injectionEvent({
    id: "inj-use-cohort-disabled",
    correlationToken: "token-use-cohort-disabled",
    taskId: "cohort-session",
    memoryMode: "disabled"
  });
  for (const event of [
    eligibleReported,
    eligibleUnassessed,
    emptySibling,
    disabledSibling
  ]) {
    await appendInjection(repository, event);
  }
  await repository.recordInjectionUseReport({
    report: useReport(eligibleReported, {
      useKind: "partially_used",
      usedMemoryIds: ["mem-use-1"]
    }),
    actor: { id: "curator", authority: "curator" },
    context: makeContext({
      workspaceId: "ws-use",
      repositoryId: "repo-use",
      taskId: "cohort-session"
    })
  });
  assert.equal(
    (
      await repository.listInjectionUseJoins({
        context: makeContext({
          workspaceId: "ws-use",
          repositoryId: "repo-use",
          taskId: "cohort-session"
        }),
        includeUnassessed: true
      })
    ).items.find((item) => item.injection.id === eligibleReported.id)?.use
      ?.useKind,
    "partially_used"
  );

  const request = {
    context: makeContext({ workspaceId: "ws-use", repositoryId: "repo-use" }),
    occurredFrom: "2026-10-01T00:00:00.000Z",
    occurredUntil: "2026-10-04T00:00:00.000Z"
  };
  const cohort = await repository.aggregateInjectionUseCohorts(request);
  assert.equal(cohort.exposureCount, 2);
  assert.deepEqual(
    cohort.cells.map(
      ({ memoryMode, sessionCardinality, useKind, exposureCount }) => ({
        memoryMode,
        sessionCardinality,
        useKind,
        exposureCount
      })
    ),
    [
      {
        memoryMode: "jit",
        sessionCardinality: "multiple",
        useKind: null,
        exposureCount: 1
      },
      {
        memoryMode: "jit",
        sessionCardinality: "multiple",
        useKind: "partially_used",
        exposureCount: 1
      }
    ]
  );
  const disabled = await repository.aggregateInjectionUseCohorts({
    ...request,
    memoryModes: ["disabled"]
  });
  assert.equal(disabled.exposureCount, 0);
  assert.deepEqual(disabled.cells, []);
  const filtered = await repository.aggregateInjectionUseCohorts({
    ...request,
    memoryModes: ["jit"],
    useKinds: ["partially_used"]
  });
  assert.equal(filtered.exposureCount, 1);
  assert.equal(filtered.cells[0]?.sessionCardinality, "multiple");
  assert.equal("correlationToken" in filtered.cells[0]!, false);
  assert.equal("reporterId" in filtered.cells[0]!, false);
  assert.equal("usedMemoryIds" in filtered.cells[0]!, false);
});

test("purging the raw experience envelope leaves the use reports and their bounded aggregate untouched", async () => {
  // The spec is explicit that a purge "erases only the raw `memory_experiences`
  // envelope", is "not blocked by, the independent append-only injection
  // events, reporter-supplied outcome reports, curator-assessed use reports, or
  // session outcome reports", and that the bounded aggregates count by their
  // own timestamps, so "a purge changes nothing about counts already recorded
  // before it ran".
  //
  // That claim was reachable only from a live-PostgreSQL integration test. It
  // never needed a database: the fake already refuses UPDATE and DELETE against
  // `memory_injection_use_reports` as append-only, and computes the same cohort
  // aggregate the repository asks for. So this is a privacy boundary that had
  // no non-integration home, not a property only Postgres can show.
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  const experience = makeExperience({
    id: "exp-use-purge",
    workspaceId: "ws-use",
    scope: {
      kind: "task",
      workspaceId: "ws-use",
      taskId: "session-use",
      runId: "session-run"
    },
    taskId: "session-use",
    runId: "session-run",
    agentId: "session-agent"
  });
  await repository.appendExperience(experience);
  const event = injectionEvent({
    id: "inj-use-purge",
    correlationToken: "token-use-purge"
  });
  await appendInjection(repository, event);
  await repository.recordInjectionUseReport({
    report: useReport(event),
    actor: { id: "root", authority: "root" },
    context: sessionContext
  });

  const cohortRequest = {
    context: makeContext({ workspaceId: "ws-use", repositoryId: "repo-use" }),
    occurredFrom: "2026-10-01T00:00:00.000Z",
    occurredUntil: "2026-10-04T00:00:00.000Z"
  };
  const before = await repository.aggregateInjectionUseCohorts(cohortRequest);
  assert.equal(before.exposureCount, 1, "the exposure is counted before the purge");

  assert.equal(
    await repository.purgeExperience({
      experienceId: experience.id,
      context: sessionContext,
      eventId: "privacy-event-use-purge",
      actorId: "curator-1",
      reason: "privacy_request",
      occurredAt: "2026-10-05T12:00:00.000Z"
    }),
    "purged"
  );
  assert.equal(
    await repository.getExperience(experience.id, sessionContext),
    null,
    "the raw envelope is what a purge removes"
  );

  assert.deepEqual(
    await repository.aggregateInjectionUseCohorts(cohortRequest),
    before,
    "a purge must not move a bounded aggregate recorded before it ran"
  );
  assert.equal(
    (
      await repository.listInjectionUseJoins({
        context: sessionContext,
        includeUnassessed: true
      })
    ).items.find((item) => item.injection.id === event.id)?.use?.useKind,
    "used",
    "the curator's append-only use report must survive the purge"
  );
});

test("memory injection use reports reject UPDATE and DELETE in the fake append-only table", async () => {
  const pool = new FakeMemoryPool();
  const repository = repo(pool);
  const event = injectionEvent();
  await appendInjection(repository, event);
  const report = await repository.recordInjectionUseReport({
    report: useReport(event),
    actor: { id: "root", authority: "root" },
    context: sessionContext
  });

  await assert.rejects(
    pool.query(
      "UPDATE memory_injection_use_reports SET use_kind = 'not_used' WHERE id = $1",
      [report.id]
    ),
    /append-only/u
  );
  await assert.rejects(
    pool.query("DELETE FROM memory_injection_use_reports WHERE id = $1", [
      report.id
    ]),
    /append-only/u
  );
});
