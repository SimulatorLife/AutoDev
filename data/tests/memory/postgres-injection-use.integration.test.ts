import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  ExperienceEnvelope,
  MemoryInjectionEvent,
  MemoryReadContext,
  MemoryUseReport
} from "@simulatorlife/autodev-core";

import { createPgMemoryPool } from "../../src/memory/pg-pool.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import { applyMemoryMigrations } from "../../src/memory/schema.ts";
import {
  buildInsert,
  injectionUseReportToRow
} from "../../src/memory/serialize.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL migration 11, curator injection-use invariants, idempotency, joins, append-only history, and exposure cohorts",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool({ connectionString: databaseUrl });
    const identity = randomUUID();
    const workspaceId = `memory-use-test-${identity}`;
    const repositoryId = `repo-${identity}`;
    const taskId = `session-${identity}`;
    const sessionContext: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId: `session-run-${identity}`,
      agentId: `session-agent-${identity}`,
      canReadGlobal: false
    };
    const requestContext: MemoryReadContext = {
      ...sessionContext,
      runId: `request-run-${identity}`,
      agentId: `request-agent-${identity}`
    };
    const now = new Date().toISOString();

    function event(
      suffix: string,
      overrides: Partial<MemoryInjectionEvent> = {}
    ): MemoryInjectionEvent {
      const runId = overrides.runId ?? requestContext.runId!;
      const agentId = overrides.agentId ?? requestContext.agentId!;
      return {
        id: `inj-${suffix}-${identity}`,
        workspaceId,
        repositoryId,
        scope: {
          kind: "task",
          workspaceId,
          taskId,
          runId
        },
        taskId,
        runId,
        agentId,
        correlationToken: `token-${suffix}-${identity}`,
        memoryMode: "jit",
        injectionResult: "injected",
        packetCharacterCount: 64,
        memoryIds: [`memory-a-${identity}`, `memory-b-${identity}`],
        occurredAt: now,
        reasonCode: "packet_attached",
        evidence: [],
        recordedBy: "injection-use-integration-test",
        ...overrides
      };
    }

    const trajectoryEvidence = [
      { kind: "trajectory" as const, uri: `codex://captured/${identity}` }
    ];

    function report(
      target: MemoryInjectionEvent,
      suffix: string,
      overrides: Partial<MemoryUseReport> = {}
    ): MemoryUseReport {
      const useKind = overrides.useKind ?? "used";
      return {
        id: `use-${suffix}-${identity}`,
        injectionEventId: target.id,
        workspaceId,
        repositoryId,
        scope: {
          kind: "task",
          workspaceId,
          taskId,
          runId: sessionContext.runId!
        },
        taskId,
        runId: sessionContext.runId!,
        agentId: sessionContext.agentId!,
        correlationToken: target.correlationToken,
        useKind,
        usedMemoryIds:
          useKind === "used"
            ? [...target.memoryIds]
            : useKind === "partially_used"
              ? target.memoryIds.slice(0, 1)
              : [],
        reportedAt: new Date(Date.now() + 1000).toISOString(),
        reporterId: "caller-supplied-id-is-overridden",
        reporterAuthority: "curator",
        reasonCode:
          useKind === "unobservable"
            ? "reporter_unobservable"
            : "reporter_supplied",
        evidence: useKind === "unobservable" ? [] : trajectoryEvidence,
        ...overrides
      };
    }

    async function append(target: MemoryInjectionEvent): Promise<void> {
      await repository.recordInjectionEvent({
        event: target,
        actor: { id: "system", authority: "system" },
        context: { ...requestContext, taskId: target.taskId }
      });
    }

    async function rawInsertUseReport(value: MemoryUseReport): Promise<void> {
      const insert = buildInsert(
        "memory_injection_use_reports",
        injectionUseReportToRow(value)
      );
      await pool.query(insert.text, insert.params);
    }

    let repository: PostgresMemoryRepository;
    try {
      await applyMemoryMigrations(pool);
      const applied11 = await pool.query<{ version: number }>(
        "SELECT version FROM memory_schema_migrations WHERE version = 11"
      );
      assert.equal(applied11.rows.length, 1);
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'memory_injection_use_reports'`
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        ["memory_injection_use_reports"]
      );

      repository = new PostgresMemoryRepository({ pool });
      const assessed = event("assessed");
      const pending = event("pending", {
        runId: `request-run-2-${identity}`,
        agentId: `request-agent-2-${identity}`
      });
      const emptySibling = event("empty", {
        injectionResult: "empty",
        packetCharacterCount: 0,
        memoryIds: [],
        reasonCode: "no_packet_research_returned_empty"
      });
      const disabledSibling = event("disabled", { memoryMode: "disabled" });
      const retrievalOnly = event("retrieval-only", {
        memoryMode: "retrieval-only"
      });
      const skippedSibling = event("skipped", {
        injectionResult: "skipped",
        reasonCode: "research_failure"
      });
      const invalidModeSibling = event("invalid-mode", {
        memoryMode: "invalid"
      });
      const unknownModeSibling = event("unknown-mode", {
        memoryMode: "unknown"
      });
      for (const target of [
        assessed,
        pending,
        emptySibling,
        disabledSibling,
        retrievalOnly,
        skippedSibling,
        invalidModeSibling,
        unknownModeSibling
      ]) {
        await append(target);
      }

      const resolved = await repository.getInjectionEventByIdForSession(
        {
          workspaceId,
          repositoryId,
          taskId,
          canReadGlobal: false
        },
        assessed.id
      );
      assert.equal(resolved?.correlationToken, assessed.correlationToken);
      assert.equal(
        await repository.getInjectionEventByIdForSession(
          {
            workspaceId: `unrelated-${identity}`,
            repositoryId,
            taskId,
            canReadGlobal: false
          },
          assessed.id
        ),
        null
      );

      const validReport = report(assessed, "valid", {
        useKind: "partially_used",
        usedMemoryIds: [assessed.memoryIds[0]!]
      });
      const first = await repository.recordInjectionUseReport({
        report: validReport,
        actor: { id: "curator-live", authority: "curator" },
        context: sessionContext
      });
      assert.equal(first.appended, true);
      const retry = await repository.recordInjectionUseReport({
        report: {
          ...validReport,
          id: `retry-${identity}`,
          reportedAt: new Date(Date.now() + 2000).toISOString()
        },
        actor: { id: "other-curator-live", authority: "root" },
        context: sessionContext
      });
      assert.deepEqual(retry, { appended: false, id: first.id });
      await assert.rejects(
        () =>
          repository.recordInjectionUseReport({
            report: report(assessed, "conflict", {
              useKind: "used",
              usedMemoryIds: [...assessed.memoryIds]
            }),
            actor: { id: "curator-live", authority: "curator" },
            context: sessionContext
          }),
        /conflicts with a previously recorded report/u
      );
      const stored = await repository.getInjectionUseReport(
        workspaceId,
        assessed.correlationToken
      );
      assert.equal(stored?.reporterId, "curator-live");
      assert.equal(stored?.reporterAuthority, "curator");
      const retrievalOnlyReport = await repository.recordInjectionUseReport({
        report: report(retrievalOnly, "retrieval-only", {
          useKind: "not_used",
          usedMemoryIds: []
        }),
        actor: { id: "curator-live", authority: "curator" },
        context: sessionContext
      });
      assert.equal(retrievalOnlyReport.appended, true);

      // These raw inserts bypass Core/Data checks and prove migration 11's
      // trigger rejects wrong packet membership, invalid cardinality,
      // missing trajectory anchors, and disabled-mode events.
      const badSubset = report(eligibleForRaw(assessed), "bad-subset", {
        useKind: "partially_used",
        usedMemoryIds: [`not-in-packet-${identity}`]
      });
      await assert.rejects(
        () => rawInsertUseReport(badSubset),
        /used_memory_ids must be a subset of packet memory_ids/u
      );
      const badCardinality = report(
        eligibleForRaw(pending),
        "bad-cardinality",
        {
          useKind: "used",
          usedMemoryIds: [pending.memoryIds[0]!]
        }
      );
      await assert.rejects(
        () => rawInsertUseReport(badCardinality),
        /cardinality does not match use_kind/u
      );
      const missingTrajectory = report(
        eligibleForRaw(pending),
        "bad-evidence",
        {
          useKind: "not_used",
          usedMemoryIds: [],
          evidence: []
        }
      );
      await assert.rejects(
        () => rawInsertUseReport(missingTrajectory),
        /requires trajectory evidence/u
      );
      const disabledReport = report(disabledSibling, "disabled-report");
      await assert.rejects(
        () => rawInsertUseReport(disabledReport),
        /eligible injected packet/u
      );

      const joins = await repository.listInjectionUseJoins({
        context: sessionContext,
        includeUnassessed: true
      });
      assert.equal(joins.total, 3);
      assert.equal(
        joins.items.find((item) => item.injection.id === pending.id)?.use,
        null
      );
      assert.equal(
        joins.items.find((item) => item.injection.id === assessed.id)?.use
          ?.useKind,
        "partially_used"
      );

      const cohortRequest = {
        context: {
          workspaceId,
          repositoryId,
          canReadGlobal: false
        },
        occurredFrom: new Date(Date.now() - 60_000).toISOString(),
        occurredUntil: new Date(Date.now() + 60_000).toISOString()
      };
      const cohort =
        await repository.aggregateInjectionUseCohorts(cohortRequest);
      assert.equal(cohort.exposureCount, 3);
      assert.ok(
        cohort.cells.every((cell) => cell.sessionCardinality === "multiple")
      );
      assert.ok(cohort.cells.some((cell) => cell.useKind === null));
      assert.ok(
        cohort.cells.every(
          (cell) =>
            cell.memoryMode === "jit" || cell.memoryMode === "retrieval-only"
        )
      );
      assert.ok(
        cohort.cells.some((cell) => cell.memoryMode === "retrieval-only")
      );
      const disabledCohort = await repository.aggregateInjectionUseCohorts({
        ...cohortRequest,
        memoryModes: ["disabled"]
      });
      assert.equal(disabledCohort.exposureCount, 0);
      assert.deepEqual(disabledCohort.cells, []);
      const filtered = await repository.aggregateInjectionUseCohorts({
        ...cohortRequest,
        memoryModes: ["jit"],
        useKinds: ["partially_used"]
      });
      assert.equal(filtered.exposureCount, 1);
      assert.equal(filtered.cells[0]?.sessionCardinality, "multiple");
      assert.equal("correlationToken" in filtered.cells[0]!, false);
      assert.equal("reporterId" in filtered.cells[0]!, false);
      assert.equal("usedMemoryIds" in filtered.cells[0]!, false);

      await assert.rejects(
        pool.query(
          "UPDATE memory_injection_use_reports SET use_kind = 'not_used' WHERE id = $1",
          [first.id]
        ),
        /append-only/u
      );
      await assert.rejects(
        pool.query("DELETE FROM memory_injection_use_reports WHERE id = $1", [
          first.id
        ]),
        /append-only/u
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "purgeExperience erases only the raw experience envelope; append-only curator use reports and their bounded aggregate survive the purge",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool({ connectionString: databaseUrl });
    const identity = randomUUID();
    const workspaceId = `memory-purge-use-test-${identity}`;
    const repositoryId = `repo-${identity}`;
    const taskId = `session-${identity}`;
    const runId = `run-${identity}`;
    const agentId = `agent-${identity}`;
    const context: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId,
      agentId,
      canReadGlobal: false
    };
    const now = new Date().toISOString();
    const trajectoryUri = `codex://captured/${identity}`;

    const experience: ExperienceEnvelope = {
      id: `exp-${identity}`,
      workspaceId,
      repositoryId,
      scope: { kind: "task", workspaceId, taskId, runId },
      taskId,
      runId,
      agentId,
      startedAt: now,
      completedAt: now,
      outcome: "success",
      trajectory: { format: "codex-v1", uri: trajectoryUri },
      evidence: []
    };

    const injectionEvent: MemoryInjectionEvent = {
      id: `inj-${identity}`,
      workspaceId,
      repositoryId,
      scope: { kind: "task", workspaceId, taskId, runId },
      taskId,
      runId,
      agentId,
      correlationToken: `token-${identity}`,
      memoryMode: "jit",
      injectionResult: "injected",
      packetCharacterCount: 64,
      memoryIds: [`memory-a-${identity}`, `memory-b-${identity}`],
      occurredAt: now,
      reasonCode: "packet_attached",
      evidence: [],
      recordedBy: "purge-use-integration-test"
    };

    const useReport: MemoryUseReport = {
      id: `use-${identity}`,
      injectionEventId: injectionEvent.id,
      workspaceId,
      repositoryId,
      scope: { kind: "task", workspaceId, taskId, runId },
      taskId,
      runId,
      agentId,
      correlationToken: injectionEvent.correlationToken,
      useKind: "used",
      usedMemoryIds: [...injectionEvent.memoryIds],
      reportedAt: new Date(Date.now() + 1000).toISOString(),
      reporterId: "caller-supplied-id-is-overridden",
      reporterAuthority: "curator",
      reasonCode: "reporter_supplied",
      evidence: [{ kind: "trajectory", uri: trajectoryUri }]
    };

    let repository: PostgresMemoryRepository;
    try {
      await applyMemoryMigrations(pool);
      repository = new PostgresMemoryRepository({ pool });

      // The raw trajectory envelope and its independent, append-only
      // curator-assessed use report are recorded against the same session
      // but are stored in separate tables with no FK between them: the use
      // report cites the injection event's correlation token and memory
      // IDs, never the experience ID.
      await repository.appendExperience(experience);
      await repository.recordInjectionEvent({
        event: injectionEvent,
        actor: { id: "system", authority: "system" },
        context
      });
      const recorded = await repository.recordInjectionUseReport({
        report: useReport,
        actor: { id: "curator-live", authority: "curator" },
        context
      });
      assert.equal(recorded.appended, true);

      assert.ok(await repository.getExperience(experience.id, context));
      const beforePurge = await repository.getInjectionUseReport(
        workspaceId,
        injectionEvent.correlationToken
      );
      assert.equal(beforePurge?.useKind, "used");

      const purgeEventId = `privacy-${identity}`;
      const purgeResult = await repository.purgeExperience({
        experienceId: experience.id,
        context,
        eventId: purgeEventId,
        actorId: "integration-curator",
        reason: "privacy_request",
        occurredAt: new Date().toISOString()
      });
      // No durable memory_records cite this experience, so the purge is
      // not blocked by the existence of the (unrelated) use report.
      assert.equal(purgeResult, "purged");

      // The raw envelope is now invisible...
      assert.equal(
        await repository.getExperience(experience.id, context),
        null
      );

      // ...but the append-only curator use report -- bounded IDs and
      // references, not the raw transcript payload -- remains exactly as
      // recorded before the purge.
      const afterPurge = await repository.getInjectionUseReport(
        workspaceId,
        injectionEvent.correlationToken
      );
      assert.equal(afterPurge?.useKind, "used");
      assert.deepEqual(afterPurge?.usedMemoryIds, injectionEvent.memoryIds);
      assert.equal(afterPurge?.reporterId, "curator-live");
      assert.equal(afterPurge?.id, useReport.id);

      // ...and the safe bounded aggregate -- which counts eligible packet
      // events by their own occurred_at, not by experience lifecycle --
      // still reports the same exposure and use-kind after the purge.
      const cohort = await repository.aggregateInjectionUseCohorts({
        context: { workspaceId, repositoryId, canReadGlobal: false },
        occurredFrom: new Date(Date.now() - 60_000).toISOString(),
        occurredUntil: new Date(Date.now() + 60_000).toISOString()
      });
      assert.equal(cohort.exposureCount, 1);
      assert.equal(cohort.cells.length, 1);
      assert.equal(cohort.cells[0]?.useKind, "used");

      // The purge's own tombstone is a distinct append-only audit record
      // (a one-way fingerprint, not the use report) proving the erasure
      // happened.
      const tombstone = await pool.query<{ reason: string }>(
        "SELECT reason FROM memory_experience_privacy_events WHERE id = $1",
        [purgeEventId]
      );
      assert.equal(tombstone.rows.length, 1);
      assert.equal(tombstone.rows[0]?.reason, "privacy_request");
    } finally {
      await pool.end();
    }
  }
);

function eligibleForRaw(event: MemoryInjectionEvent): MemoryInjectionEvent {
  return {
    ...event,
    memoryMode: "jit",
    injectionResult: "injected",
    memoryIds: event.memoryIds.length > 1 ? event.memoryIds : ["mem-a", "mem-b"]
  };
}
