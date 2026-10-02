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
    const pool = createPgMemoryPool({ connectionString: databaseUrl! });
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
            : "memory_mode_disabled",
        evidence: [],
        recordedBy: "postgres-cohort-integration-test"
      };
    };

    try {
      await applyMemoryMigrations(pool);
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
      assert.deepEqual(page.cells, [
        {
          memoryMode: "disabled",
          injectionResult: "skipped",
          reportKind: null,
          outcomeKind: null,
          exposureCount: 1,
          reportCount: 0
        },
        {
          memoryMode: "jit",
          injectionResult: "injected",
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
