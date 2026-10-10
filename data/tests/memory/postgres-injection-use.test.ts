import assert from "node:assert/strict";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryReadContext,
  MemoryUseReport
} from "@simulatorlife/autodev-core";

import {
  MemoryConflictError,
  MemoryVectorError
} from "../../src/memory/errors.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import type { MemoryConnectionPool } from "../../src/memory/query-client.ts";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../../src/memory/schema.ts";
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
  assert.equal(
    before.exposureCount,
    1,
    "the exposure is counted before the purge"
  );

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

/**
 * The trusted-scope checks that stand in front of a use report.
 *
 * `assertTrustedUseReportScope` is what stops a caller filing an assessment
 * against an injection event belonging to a repository they were not trusted
 * for -- and its two structural checks, that the context *carries* a repository
 * and task scope at all, and that the report's own identity *matches* that
 * scope, had no failing test. The checks beside them did: authority, and a
 * blank repository id, are both asserted above. The neighbouring cases
 * (subset, eligible mode, status) were all reachable because they take a
 * report about a real event; these two are about the context around it, and
 * every fixture supplied a complete one.
 */
test("a use report is refused unless the context carries a repository and task scope", async () => {
  const repository = repo();
  const event = injectionEvent();
  await appendInjection(repository, event);
  const report = useReport(event);

  for (const [label, context] of [
    ["no repository", { ...sessionContext, repositoryId: undefined }],
    ["a blank repository", { ...sessionContext, repositoryId: "  " }],
    ["no task", { ...sessionContext, taskId: undefined }],
    ["a blank task", { ...sessionContext, taskId: "   " }]
  ] as const) {
    await assert.rejects(
      () =>
        repository.recordInjectionUseReport({
          report,
          actor: { id: "trusted-curator", authority: "root" },
          context: context as MemoryReadContext
        }),
      /require a trusted repository and task scope/u,
      `${label} must not produce a trusted scope`
    );
  }
});

test("a use report whose identity differs from the trusted scope is refused", async () => {
  const repository = repo();
  const event = injectionEvent();
  await appendInjection(repository, event);

  // The attack this closes: the event lookup below is scoped to the trusted
  // repository, but only *after* these three fields have been compared. A
  // report claiming another repository would otherwise carry its own identity
  // into storage while being read against this session's scope.
  for (const [label, overrides] of [
    ["another workspace", { workspaceId: "ws-other" }],
    ["another repository", { repositoryId: "repo-other" }],
    ["another task", { taskId: "session-other" }]
  ] as const) {
    await assert.rejects(
      () =>
        repository.recordInjectionUseReport({
          report: { ...useReport(event), ...overrides },
          actor: { id: "trusted-curator", authority: "root" },
          context: sessionContext
        }),
      /identity must match trusted repository scope/u,
      `${label} must be refused`
    );
  }
});

test("a use report naming an injection event outside the session is refused", async () => {
  const repository = repo();
  const event = injectionEvent();
  await appendInjection(repository, event);

  await assert.rejects(
    () =>
      repository.recordInjectionUseReport({
        report: useReport(event, { injectionEventId: "inj-does-not-exist" }),
        actor: { id: "trusted-curator", authority: "root" },
        context: sessionContext
      }),
    /has no scope-aligned injection/u,
    "a report must not be recorded against an event it cannot see"
  );
});

test("the repository refuses a vector width that does not match the migrated width", () => {
  // Fail-fast at construction rather than at query time. The mismatch is a
  // deployment error -- a migration that moved the column width without the
  // caller being redeployed -- and the alternative is every vector query
  // failing deep inside pgvector with a distance complaint that names neither
  // the configuration nor the migration.
  const pool = new FakeMemoryPool();
  assert.throws(
    () =>
      new PostgresMemoryRepository({
        pool,
        vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS + 1 }
      }),
    (error: unknown) =>
      error instanceof MemoryVectorError &&
      error.message.includes(String(MEMORY_EMBEDDING_DIMENSIONS + 1)) &&
      error.message.includes(String(MEMORY_EMBEDDING_DIMENSIONS)),
    "the message must name both the configured and the migrated width"
  );

  // The positive control: the matching width constructs, and no vectorSupport
  // at all is legal, so "always throw" does not pass.
  assert.doesNotThrow(
    () =>
      new PostgresMemoryRepository({
        pool,
        vectorSupport: { dimensions: MEMORY_EMBEDDING_DIMENSIONS }
      })
  );
  assert.doesNotThrow(() => new PostgresMemoryRepository({ pool }));
});

/**
 * A pool that records the statements it is asked to run.
 *
 * The point of the test below is that a lookup *refuses* a session it cannot
 * search with, and refusing is only observable as the absence of a query.
 * Asserting the return value cannot see it: a blank workspaceId builds
 * `scope_workspace_id = '   '`, which matches no row, so the unguarded lookup
 * returns `null` too. Six mutations that deleted the guard all passed a
 * return-value-only version of this test.
 */
function recordingPool(base: FakeMemoryPool): MemoryConnectionPool & {
  readonly statements: string[];
} {
  const statements: string[] = [];
  return {
    statements,
    query: (text, params) => {
      statements.push(text);
      return base.query(text, params);
    },
    connect: async () => {
      const connection = await base.connect();
      return {
        query: (text, params) => {
          statements.push(text);
          return connection.query(text, params);
        },
        release: () => connection.release()
      };
    },
    end: () => base.end()
  };
}

/**
 * The two session lookups, side by side.
 *
 * Both build a WHERE clause out of nothing but the caller's own session
 * identifiers, so both have to decide what a usable session context is. These
 * assert that decision from both sides for every identifier, because the two
 * methods' guards did not agree -- the token lookup checked the token alone
 * while the id lookup checked all four -- and neither guard had a failing test:
 * every fixture in the tree supplied a well-formed session.
 *
 * Each refusal is asserted as *no query was sent*, not as a `null` return.
 * See `recordingPool`.
 *
 * The repository identifier is the one genuinely different case and is asserted
 * rather than assumed. The token lookup's repository clause is optional, because
 * a workspace-scoped session has no repository; the id lookup binds
 * `repository_id` outright and cannot query without one. What both share is that
 * a repository which is *present but blank* is refused -- otherwise the clause
 * is built from whitespace and asks about a repository nobody has.
 */
test("both session lookups refuse a session context they cannot search with", async () => {
  const pool = recordingPool(new FakeMemoryPool());
  const repository = new PostgresMemoryRepository({ pool });
  const event = injectionEvent();
  await appendInjection(repository, event);

  const trusted = {
    workspaceId: event.workspaceId,
    repositoryId: event.repositoryId!,
    taskId: event.taskId,
    canReadGlobal: false
  };

  /**
   * Asserts a lookup both refuses (no statement reached the database) and says
   * nothing found. The count is read before the call, because a guard that ran
   * the query anyway and matched nothing leaves the return value unchanged.
   */
  const refuses = async (
    label: string,
    lookup: () => Promise<unknown>
  ): Promise<void> => {
    const before = pool.statements.length;
    assert.equal(await lookup(), null, `${label} must resolve to nothing`);
    assert.equal(
      pool.statements.length,
      before,
      `${label} must be refused before any query runs -- searching for an event whose workspace or task is whitespace is not a narrower search, it is a different one`
    );
  };

  // Positive control, in both halves. A well-formed session must resolve *and*
  // must have queried; without the query half, a repository that refused
  // everything would pass every refusal below.
  const byToken = await repository.findInjectionEventByTokenForSession(
    trusted,
    event.correlationToken
  );
  assert.equal(
    byToken?.id,
    event.id,
    "the trusted session must resolve by token"
  );
  const byId = await repository.getInjectionEventByIdForSession(
    trusted,
    event.id
  );
  assert.equal(byId?.id, event.id, "the trusted session must resolve by id");
  assert.ok(
    pool.statements.length > 0,
    "a well-formed session must actually reach the database, or the refusals below prove nothing"
  );

  await refuses("an empty correlation token", () =>
    repository.findInjectionEventByTokenForSession(trusted, "  ")
  );
  await refuses("a blank event id", () =>
    repository.getInjectionEventByIdForSession(trusted, "   ")
  );

  // Every blank-session-field case, on both lookups, with the identifier left
  // valid -- so what fails is the session context and not the token or the id.
  const blankContextCases: readonly [string, Partial<typeof trusted>][] = [
    ["a blank workspaceId", { workspaceId: "   " }],
    ["a blank taskId", { taskId: "  " }],
    ["a blank repositoryId", { repositoryId: " " }]
  ];
  for (const [label, overrides] of blankContextCases) {
    const context = { ...trusted, ...overrides };
    await refuses(`the token lookup refusing ${label}`, () =>
      repository.findInjectionEventByTokenForSession(
        context,
        event.correlationToken
      )
    );
    await refuses(`the id lookup refusing ${label}`, () =>
      repository.getInjectionEventByIdForSession(context, event.id)
    );
  }

  // A missing repository is only refused by the lookup that binds one. This is
  // asserted positively rather than by refusal, because both outcomes here are
  // "no query", which no count can separate.
  const { repositoryId: _omitted, ...withoutRepository } = trusted;
  const beforeWorkspaceLookup = pool.statements.length;
  assert.equal(
    (
      await repository.findInjectionEventByTokenForSession(
        withoutRepository,
        event.correlationToken
      )
    )?.id,
    event.id,
    "a workspace-scoped session has no repository, and the token lookup must still resolve it"
  );
  assert.equal(
    pool.statements.length,
    beforeWorkspaceLookup + 1,
    "the workspace-scoped lookup must have run its query without the repository clause"
  );
  const beforeIdLookup = pool.statements.length;
  assert.equal(
    await repository.getInjectionEventByIdForSession(
      withoutRepository,
      event.id
    ),
    null,
    "the id lookup binds repository_id outright and cannot resolve without one"
  );
  assert.equal(
    pool.statements.length,
    beforeIdLookup,
    "the id lookup must refuse a session with no repository before querying"
  );
});

/**
 * An injection event's scope must be the trusted session's scope.
 *
 * The event a caller hands `recordInjectionEvent` carries its own workspace,
 * repository and task, and the row that is persisted is what every later
 * session-scoped read is filtered by. The guard is the only thing standing
 * between a caller and a row filed against someone else's session, and it is
 * five independent clauses -- none of which had a failing test, because every
 * caller in the suite built the event with `context: { ...requestContext,
 * taskId: event.taskId }`, which makes the task clause match by construction.
 *
 * Each clause is varied on its own here. A single assertion that the method
 * "rejects a mis-scoped event" would pass on whichever clause fired first and
 * prove nothing about the rest.
 */
test("recordInjectionEvent refuses an event whose scope is not the trusted session", async () => {
  const repository = repo();
  const trusted = requestContext;

  // Positive control, and the first case's other side: an event with no
  // repository at all is a workspace-scoped injection, which is legitimate and
  // must not be caught by the repository clause. The key is *omitted* rather
  // than set to undefined -- `exactOptionalPropertyTypes` is on, and an absent
  // repository is the state under test.
  const workspaceScoped: Partial<MemoryInjectionEvent> = {
    id: "inj-workspace-scoped",
    correlationToken: "token-workspace-scoped",
    scope: {
      kind: "workspace",
      workspaceId: "ws-use"
    },
    taskId: "session-use",
    runId: "request-run"
  };
  await assert.doesNotReject(
    repository.recordInjectionEvent({
      event: injectionEvent(workspaceScoped),
      actor: { id: "runtime", authority: "system" },
      context: trusted
    }),
    "an injection with no repository belongs to the workspace, not to a forged repository"
  );

  const refusals: readonly {
    readonly why: string;
    readonly event: Partial<MemoryInjectionEvent>;
  }[] = [
    {
      why: "the event names another workspace",
      event: { id: "inj-ws", correlationToken: "t-ws", workspaceId: "ws-other" }
    },
    {
      why: "the event names another repository",
      event: {
        id: "inj-repo",
        correlationToken: "t-repo",
        repositoryId: "repo-other"
      }
    },
    {
      // Not a case of its own: `MemoryScope`'s "global" variant carries no
      // `workspaceId` at all, while the event's own is required, so this is
      // refused by the scope-workspace clause below whatever the global clause
      // does. It is kept because an injection event should never be global, not
      // because the guard here is what stops it -- see the finding reported
      // alongside this commit.
      why: "the event claims global scope",
      event: {
        id: "inj-global",
        correlationToken: "t-global",
        scope: { kind: "global" }
      }
    },
    {
      why: "the event's scope workspace disagrees with its own workspace",
      event: {
        id: "inj-split",
        correlationToken: "t-split",
        scope: {
          kind: "workspace",
          workspaceId: "ws-other"
        }
      }
    },
    {
      why: "the event names another session's task",
      event: {
        id: "inj-task",
        correlationToken: "t-task",
        taskId: "other-session",
        scope: {
          kind: "task",
          workspaceId: "ws-use",
          taskId: "other-session",
          runId: "request-run"
        }
      }
    }
  ];

  for (const { why, event } of refusals) {
    await assert.rejects(
      repository.recordInjectionEvent({
        event: injectionEvent(event),
        actor: { id: "runtime", authority: "system" },
        context: trusted
      }),
      MemoryConflictError,
      `${why} must be refused`
    );
  }
});

/**
 * A correlation token already recorded against a different event is a collision.
 *
 * The retry path returns `appended: false` only when the stored row is the very
 * event being written again. Two different ids under one token means the token
 * has been reused for a different execution, which is the case where a caller
 * could otherwise be told "already recorded, nothing to do" while its evidence
 * was silently dropped.
 */
test("recordInjectionEvent reports a correlation token already claimed by another event", async () => {
  const repository = repo();
  const first = injectionEvent();
  await repository.recordInjectionEvent({
    event: first,
    actor: { id: "runtime", authority: "system" },
    context: { ...requestContext, taskId: first.taskId }
  });

  // The exact retry is the accepted case, and it is what the refusal below has
  // to be distinguished from -- both find a stored row under the same token.
  const retried = await repository.recordInjectionEvent({
    event: first,
    actor: { id: "runtime", authority: "system" },
    context: { ...requestContext, taskId: first.taskId }
  });
  assert.deepEqual(retried, { appended: false, id: first.id });

  await assert.rejects(
    repository.recordInjectionEvent({
      event: injectionEvent({ id: "inj-a-different-event" }),
      actor: { id: "runtime", authority: "system" },
      context: { ...requestContext, taskId: first.taskId }
    }),
    /correlationToken is already recorded with a different id/u,
    "one token cannot stand for two different injection events"
  );
});

/**
 * The exposure list's own filters, and the context it refuses to list without.
 *
 * Three things this list decides were not asserted by the test above: the
 * `memoryModes` and `useKinds` narrowings, and the early return when the
 * context carries no repository or task.
 *
 * That last one needs the recording pool rather than an empty result. A context
 * with no repositoryId builds `i.repository_id = NULL`, which matches no row --
 * so the unguarded query returns an empty page too, and an assertion on the
 * returned page passes against a list that ran a query it had no business
 * running. What is observable is that no statement was sent.
 */
test("the exposure list applies its own filters and refuses a context without a session", async () => {
  const pool = recordingPool(new FakeMemoryPool());
  const repository = new PostgresMemoryRepository({ pool });
  const jit = injectionEvent({ id: "inj-mode-jit", correlationToken: "t-jit" });
  const retrieval = injectionEvent({
    id: "inj-mode-retrieval",
    correlationToken: "t-retrieval",
    memoryMode: "retrieval-only",
    runId: "request-run-2",
    agentId: "request-agent-2"
  });
  for (const event of [jit, retrieval])
    await appendInjection(repository, event);
  await repository.recordInjectionUseReport({
    report: useReport(jit, { useKind: "partially_used" }),
    actor: { id: "curator", authority: "curator" },
    context: sessionContext
  });
  await repository.recordInjectionUseReport({
    report: useReport(retrieval, { useKind: "not_used" }),
    actor: { id: "curator", authority: "curator" },
    context: sessionContext
  });

  const beforeFilter = await repository.listInjectionUseJoins({
    context: sessionContext
  });
  assert.equal(
    beforeFilter.total,
    2,
    "both eligible modes are listed unfiltered"
  );

  const jitOnly = await repository.listInjectionUseJoins({
    context: sessionContext,
    memoryModes: ["jit"]
  });
  assert.equal(jitOnly.total, 1);
  assert.equal(
    jitOnly.items[0]?.injection.id,
    jit.id,
    "memoryModes must narrow the list, not describe it"
  );

  const retrievalOnly = await repository.listInjectionUseJoins({
    context: sessionContext,
    memoryModes: ["retrieval-only"]
  });
  assert.equal(retrievalOnly.total, 1);
  assert.equal(
    retrievalOnly.items[0]?.injection.id,
    retrieval.id,
    "the other eligible mode is reachable through its own value"
  );

  const notUsed = await repository.listInjectionUseJoins({
    context: sessionContext,
    useKinds: ["not_used"]
  });
  assert.equal(notUsed.total, 1);
  assert.equal(
    notUsed.items[0]?.injection.id,
    retrieval.id,
    "useKinds narrows by the reported kind"
  );
  assert.equal(
    (
      await repository.listInjectionUseJoins({
        context: sessionContext,
        useKinds: ["used"]
      })
    ).total,
    0,
    "a use kind no report carries selects nothing"
  );

  // The contexts that cannot name a session at all. Each returns an empty page
  // *and* sends nothing, which is the part an empty-page assertion cannot see.
  // Keys are *omitted* rather than set to undefined -- `exactOptionalPropertyTypes`
  // is on, and "absent" is the state under test, distinct from "present and
  // empty".
  const { repositoryId: _noRepository, ...withoutRepository } = sessionContext;
  const { taskId: _noTask, ...withoutTask } = sessionContext;
  const unscoped: readonly [string, MemoryReadContext][] = [
    ["no repository", withoutRepository],
    ["no task", withoutTask],
    ["a blank repository", { ...sessionContext, repositoryId: "   " }],
    ["a blank task", { ...sessionContext, taskId: "  " }]
  ];
  for (const [why, context] of unscoped) {
    const before = pool.statements.length;
    const page = await repository.listInjectionUseJoins({ context });
    assert.deepEqual(
      { items: page.items, total: page.total },
      { items: [], total: 0 },
      `${why} must list nothing`
    );
    assert.equal(
      pool.statements.length,
      before,
      `${why} must be refused before any query runs -- an exposure list scoped to no repository is a query against every workspace it can reach`
    );
  }
});
