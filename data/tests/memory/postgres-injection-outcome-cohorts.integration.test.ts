import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryOutcomeReport,
  MemoryReadContext
} from "@simulatorlife/autodev-core";
import {
  applyMemoryMigrations,
  createPgMemoryPool,
  PostgresMemoryRepository
} from "@simulatorlife/autodev-data";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL groups scoped injection/outcome rows and preserves an unreported cell",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool(databaseUrl!);
    const repository = new PostgresMemoryRepository({ pool });
    const suffix = randomUUID();
    const workspaceId = `cohort-workspace-${suffix}`;
    const repositoryId = `cohort-repository-${suffix}`;
    const taskId = `cohort-task-${suffix}`;
    const context: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId: taskId,
      agentId: taskId,
      canReadGlobal: false,
      canReadTaskHistory: true
    };
    const baseInjection = (
      idSuffix: string,
      memoryMode: MemoryInjectionEvent["memoryMode"],
      injectionResult: MemoryInjectionEvent["injectionResult"],
      occurredAt: string
    ): MemoryInjectionEvent => {
      const runId = `cohort-request-${idSuffix}-${suffix}`;
      return {
        id: `cohort-injection-${idSuffix}-${suffix}`,
        workspaceId,
        repositoryId,
        scope: { kind: "task", workspaceId, taskId, runId },
        taskId,
        runId,
        agentId: `cohort-agent-${idSuffix}-${suffix}`,
        correlationToken: `cohort-token-${idSuffix}-${suffix}`,
        memoryMode,
        injectionResult,
        packetCharacterCount: injectionResult === "injected" ? 32 : 0,
        memoryIds: injectionResult === "injected" ? ["cohort-memory"] : [],
        occurredAt,
        reasonCode:
          injectionResult === "injected"
            ? "packet_attached"
            : memoryMode === "disabled"
              ? "memory_mode_disabled"
              : "no_packet_research_returned_empty",
        evidence: [],
        recordedBy: "postgres-cohort-integration-test"
      };
    };

    try {
      await applyMemoryMigrations(pool);
      const index = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_memory_injection_events_session_key'`
      );
      assert.equal(index.rows.length, 1);
      assert.match(
        index.rows[0]!.indexdef,
        /\(workspace_id, repository_id, task_id\)/u
      );

      // Confirm PostgreSQL can use the migration's key index for the exact
      // lookup pattern feeding full-session counts, even on a tiny test table.
      const planConnection = await pool.connect();
      try {
        await planConnection.query("BEGIN");
        await planConnection.query("SET LOCAL enable_seqscan = off");
        const plan = await planConnection.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT COUNT(*) FROM memory_injection_events
           WHERE workspace_id = $1 AND repository_id = $2 AND task_id = $3`,
          [workspaceId, repositoryId, taskId]
        );
        assert.match(
          plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
          /idx_memory_injection_events_session_key/u
        );
      } finally {
        await planConnection.query("ROLLBACK");
        planConnection.release();
      }
      const reportedEvent = baseInjection(
        "reported",
        "jit",
        "injected",
        "2026-10-01T12:00:00.000Z"
      );
      await repository.recordInjectionEvent({
        event: reportedEvent,
        actor: { id: "integration-runtime", authority: "system" },
        context
      });
      const report: MemoryOutcomeReport = {
        id: `cohort-report-${suffix}`,
        workspaceId,
        repositoryId,
        scope: { kind: "task", workspaceId, taskId, runId: taskId },
        taskId,
        runId: taskId,
        agentId: taskId,
        correlationToken: reportedEvent.correlationToken,
        outcomeKind: "success",
        reportKind: "task",
        reportedAt: "2026-10-01T12:10:00.000Z",
        reporterId: "integration-operator",
        reporterAuthority: "root",
        reasonCode: "reporter_supplied",
        evidence: [{ kind: "commit", uri: `git://repo/commit/${suffix}` }]
      };
      await repository.recordOutcomeReport({
        report,
        actor: { id: "integration-operator", authority: "root" },
        context
      });
      await repository.recordInjectionEvent({
        event: baseInjection(
          "unreported",
          "disabled",
          "skipped",
          "2026-10-01T12:05:00.000Z"
        ),
        actor: { id: "integration-runtime", authority: "system" },
        context
      });
      // This same-session event is outside the cohort time window and must
      // affect cardinality without appearing in exposureCount or a cell.
      await repository.recordInjectionEvent({
        event: baseInjection(
          "outside-window",
          "retrieval-only",
          "empty",
          "2026-09-30T12:00:00.000Z"
        ),
        actor: { id: "integration-runtime", authority: "system" },
        context
      });

      const page = await repository.aggregateInjectionOutcomeCohorts({
        context: {
          workspaceId,
          repositoryId,
          canReadGlobal: false,
          canReadTaskHistory: true
        },
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-10-01T23:59:59.999Z"
      });
      assert.equal(page.exposureCount, 2);
      assert.equal(page.reportCount, 1);
      // Both in-window injections and the out-of-window sibling share the
      // same session key, so both visible cells are still 'multiple'.
      assert.deepEqual(page.cells, [
        {
          memoryMode: "disabled",
          injectionResult: "skipped",
          sessionCardinality: "multiple",
          reportKind: null,
          outcomeKind: null,
          exposureCount: 1,
          reportCount: 0
        },
        {
          memoryMode: "jit",
          injectionResult: "injected",
          sessionCardinality: "multiple",
          reportKind: "task",
          outcomeKind: "success",
          exposureCount: 1,
          reportCount: 1
        }
      ]);
      assert.doesNotMatch(
        JSON.stringify(page),
        /cohort-token-|cohort-injection-|cohort-agent-|cohort-memory|integration-operator|reporterId|git:\/\//u
      );
    } finally {
      await pool.end();
    }
  }
);

test(
  "live PostgreSQL derives sessionCardinality and sessionInjectionCount from the identical canonical (workspace, repository, task) session key",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool(databaseUrl!);
    const repository = new PostgresMemoryRepository({ pool });
    const suffix = randomUUID();
    const workspaceId = `cardinality-workspace-${suffix}`;
    const repositoryId = `cardinality-repository-${suffix}`;
    const singleTaskId = `cardinality-single-task-${suffix}`;
    const multiTaskId = `cardinality-multi-task-${suffix}`;

    const makeInjection = (
      taskId: string,
      idSuffix: string,
      occurredAt: string
    ): MemoryInjectionEvent => {
      const runId = `cardinality-request-${idSuffix}-${suffix}`;
      return {
        id: `cardinality-injection-${idSuffix}-${suffix}`,
        workspaceId,
        repositoryId,
        scope: { kind: "task", workspaceId, taskId, runId },
        taskId,
        runId,
        agentId: `cardinality-agent-${idSuffix}-${suffix}`,
        correlationToken: `cardinality-token-${idSuffix}-${suffix}`,
        memoryMode: "jit",
        injectionResult: "injected",
        packetCharacterCount: 16,
        memoryIds: ["cardinality-memory"],
        occurredAt,
        reasonCode: "packet_attached",
        evidence: [],
        recordedBy: "postgres-cardinality-integration-test"
      };
    };

    try {
      await applyMemoryMigrations(pool);

      // One session with exactly one injection.
      await repository.recordInjectionEvent({
        event: makeInjection(
          singleTaskId,
          "single",
          "2026-10-02T12:00:00.000Z"
        ),
        actor: { id: "integration-runtime", authority: "system" },
        context: {
          workspaceId,
          repositoryId,
          taskId: singleTaskId,
          runId: singleTaskId,
          agentId: singleTaskId,
          canReadGlobal: false
        }
      });

      // One session with exactly two injections sharing the same
      // (memoryMode, injectionResult) so they collapse into one cohort cell.
      const multiContext: MemoryReadContext = {
        workspaceId,
        repositoryId,
        taskId: multiTaskId,
        runId: multiTaskId,
        agentId: multiTaskId,
        canReadGlobal: false
      };
      await repository.recordInjectionEvent({
        event: makeInjection(
          multiTaskId,
          "multi-a",
          "2026-10-02T12:05:00.000Z"
        ),
        actor: { id: "integration-runtime", authority: "system" },
        context: multiContext
      });
      await repository.recordInjectionEvent({
        event: makeInjection(
          multiTaskId,
          "multi-b",
          "2026-10-02T12:06:00.000Z"
        ),
        actor: { id: "integration-runtime", authority: "system" },
        context: multiContext
      });

      // The session-scoped join reports sessionInjectionCount from the
      // full event set for (workspace, repository, task) -- the same
      // canonical key the cohort aggregate groups by.
      const joinPage = await repository.listInjectionOutcomeJoins({
        context: multiContext,
        includeUnreported: true
      });
      assert.equal(joinPage.total, 2);
      for (const item of joinPage.items) {
        assert.equal(item.sessionInjectionCount, 2);
      }

      const singleJoinPage = await repository.listInjectionOutcomeJoins({
        context: {
          workspaceId,
          repositoryId,
          taskId: singleTaskId,
          runId: singleTaskId,
          agentId: singleTaskId,
          canReadGlobal: false
        },
        includeUnreported: true
      });
      assert.equal(singleJoinPage.total, 1);
      assert.equal(singleJoinPage.items[0]!.sessionInjectionCount, 1);

      const cohortPage = await repository.aggregateInjectionOutcomeCohorts({
        context: { workspaceId, repositoryId, canReadGlobal: false },
        occurredFrom: "2026-10-02T00:00:00.000Z",
        occurredUntil: "2026-10-02T23:59:59.999Z"
      });
      assert.equal(cohortPage.exposureCount, 3);
      const singleCell = cohortPage.cells.find(
        (cell) => cell.sessionCardinality === "single"
      );
      const multipleCell = cohortPage.cells.find(
        (cell) => cell.sessionCardinality === "multiple"
      );
      assert.ok(
        singleCell,
        "expected a 'single' cell for the one-injection session"
      );
      assert.ok(
        multipleCell,
        "expected a 'multiple' cell for the two-injection session"
      );
      assert.equal(singleCell?.exposureCount, 1);
      // The cohort's exposureCount for the 'multiple' cell (2) matches the
      // join's sessionInjectionCount (2) seen above, confirming both reads
      // derive the cardinality signal from the identical canonical session
      // key rather than two independently-defined notions of "session".
      assert.equal(multipleCell?.exposureCount, 2);
    } finally {
      await pool.end();
    }
  }
);

test(
  "live PostgreSQL counts nullable repository session keys without conflating them with a repository value",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool(databaseUrl!);
    const repository = new PostgresMemoryRepository({ pool });
    const suffix = randomUUID();
    const workspaceId = `nullable-cardinality-workspace-${suffix}`;
    const repositoryId = `nullable-cardinality-repository-${suffix}`;
    const taskId = `nullable-cardinality-task-${suffix}`;
    const actor = { id: "integration-runtime", authority: "system" as const };

    const makeInjection = (
      idSuffix: string,
      repositoryValue: string | undefined
    ): MemoryInjectionEvent => {
      const runId = `nullable-request-${idSuffix}-${suffix}`;
      return {
        id: `nullable-injection-${idSuffix}-${suffix}`,
        workspaceId,
        ...(repositoryValue === undefined
          ? {}
          : { repositoryId: repositoryValue }),
        scope: { kind: "task", workspaceId, taskId, runId },
        taskId,
        runId,
        agentId: `nullable-agent-${idSuffix}-${suffix}`,
        correlationToken: `nullable-token-${idSuffix}-${suffix}`,
        memoryMode: "jit",
        injectionResult: "injected",
        packetCharacterCount: 8,
        memoryIds: ["nullable-memory"],
        occurredAt: "2026-10-02T12:00:00.000Z",
        reasonCode: "packet_attached",
        evidence: [],
        recordedBy: "postgres-nullable-session-integration-test"
      };
    };

    try {
      await applyMemoryMigrations(pool);
      const nullRepositoryContext: MemoryReadContext = {
        workspaceId,
        taskId,
        runId: taskId,
        agentId: taskId,
        canReadGlobal: false
      };
      await repository.recordInjectionEvent({
        event: makeInjection("null-a", undefined),
        actor,
        context: nullRepositoryContext
      });
      await repository.recordInjectionEvent({
        event: makeInjection("null-b", undefined),
        actor,
        context: nullRepositoryContext
      });
      await repository.recordInjectionEvent({
        event: makeInjection("repository", repositoryId),
        actor,
        context: { ...nullRepositoryContext, repositoryId }
      });

      // Omitting the repository filter returns both repository values. The
      // grouped CTE must join NULL repository keys null-safely: the two NULL
      // rows count as two, while the non-NULL repository row counts as one.
      const page = await repository.listInjectionOutcomeJoins({
        context: nullRepositoryContext,
        includeUnreported: true
      });
      assert.equal(page.total, 3);
      const nullRepositoryRows = page.items.filter(
        (item) => item.injection.repositoryId === undefined
      );
      const nonNullRepositoryRows = page.items.filter(
        (item) => item.injection.repositoryId === repositoryId
      );
      assert.equal(nullRepositoryRows.length, 2);
      assert.ok(
        nullRepositoryRows.every((item) => item.sessionInjectionCount === 2)
      );
      assert.equal(nonNullRepositoryRows.length, 1);
      assert.equal(nonNullRepositoryRows[0]!.sessionInjectionCount, 1);
    } finally {
      await pool.end();
    }
  }
);
