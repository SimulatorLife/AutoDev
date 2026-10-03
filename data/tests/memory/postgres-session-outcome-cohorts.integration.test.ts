import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  MemoryInjectionEvent,
  MemoryReadContext,
  MemorySessionOutcomeReport
} from "@simulatorlife/autodev-core";
import {
  applyMemoryMigrations,
  createPgMemoryPool,
  PostgresMemoryRepository
} from "@simulatorlife/autodev-data";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL groups session outcome cohorts, computes consensus, and excludes conflicts and mixed modes",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool({ connectionString: databaseUrl! });
    const repository = new PostgresMemoryRepository({ pool });
    const suffix = randomUUID();
    const workspaceId = `sess-cohort-ws-${suffix}`;
    const repositoryId = `sess-cohort-repo-${suffix}`;

    const makeContext = (taskId: string): MemoryReadContext => ({
      workspaceId,
      repositoryId,
      taskId,
      runId: taskId,
      agentId: taskId,
      canReadGlobal: false,
      canReadTaskHistory: true
    });

    const makeInjection = (
      taskId: string,
      idSuffix: string,
      memoryMode: MemoryInjectionEvent["memoryMode"],
      occurredAt: string
    ): MemoryInjectionEvent => {
      const runId = `req-${idSuffix}-${suffix}`;
      return {
        id: `inj-${idSuffix}-${suffix}`,
        workspaceId,
        repositoryId,
        scope: { kind: "task", workspaceId, taskId, runId },
        taskId,
        runId,
        agentId: `agent-${idSuffix}-${suffix}`,
        correlationToken: `tok-${idSuffix}-${suffix}`,
        memoryMode,
        injectionResult: "injected",
        packetCharacterCount: 16,
        memoryIds: ["memory-1"],
        occurredAt,
        reasonCode: "packet_attached",
        evidence: [],
        recordedBy: "postgres-session-cohort-integration-test"
      };
    };

    const makeSessionReport = (
      taskId: string,
      outcomeKind: MemorySessionOutcomeReport["outcomeKind"]
    ): MemorySessionOutcomeReport => ({
      id: `rep-${randomUUID()}`,
      workspaceId,
      repositoryId,
      taskId,
      outcomeKind,
      reportKind: "task",
      reportedAt: "2026-10-01T14:00:00.000Z",
      reporterId: "integration-operator",
      reporterAuthority: "curator",
      reasonCode: "reporter_supplied",
      evidence: [{ kind: "commit", uri: `git://repo/commit/${suffix}` }]
    });

    try {
      await applyMemoryMigrations(pool);

      // Session 1: jit / reported success
      const s1TaskId = `s1-jit-success-${suffix}`;
      const s1Inj = makeInjection(s1TaskId, "s1", "jit", "2026-10-01T12:00:00.000Z");
      await repository.recordInjectionEvent({
        event: s1Inj,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s1TaskId)
      });
      const s1Report = makeSessionReport(s1TaskId, "success");
      const writeResult1 = await repository.recordSessionOutcomeReport({
        report: s1Report,
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s1TaskId)
      });
      assert.equal(writeResult1.appended, true);

      // Idempotent retry: same body returns appended: false
      const idempotentRetry = await repository.recordSessionOutcomeReport({
        report: { ...s1Report, id: `rep-retry-${randomUUID()}` },
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s1TaskId)
      });
      assert.equal(idempotentRetry.appended, false);
      assert.equal(idempotentRetry.id, s1Report.id);

      // Conflicting retry: different body throws MemoryConflictError
      await assert.rejects(
        () =>
          repository.recordSessionOutcomeReport({
            report: {
              ...s1Report,
              id: `rep-conflict-${randomUUID()}`,
              outcomeKind: "failure",
              evidence: [{ kind: "issue", uri: "https://example.com/issue/1" }]
            },
            actor: { id: "curator", authority: "curator" },
            context: makeContext(s1TaskId)
          }),
        (err: unknown) => err instanceof Error && /conflict/i.test(err.message)
      );

      // Session 2: jit / unreported
      const s2TaskId = `s2-jit-unrep-${suffix}`;
      const s2Inj = makeInjection(s2TaskId, "s2", "jit", "2026-10-01T12:05:00.000Z");
      await repository.recordInjectionEvent({
        event: s2Inj,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s2TaskId)
      });

      // Session 3: retrieval-only / failure
      const s3TaskId = `s3-retrieval-fail-${suffix}`;
      const s3Inj = makeInjection(s3TaskId, "s3", "retrieval-only", "2026-10-01T12:10:00.000Z");
      await repository.recordInjectionEvent({
        event: s3Inj,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s3TaskId)
      });
      await repository.recordSessionOutcomeReport({
        report: makeSessionReport(s3TaskId, "failure"),
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s3TaskId)
      });

      // Session 4: multiple injections in same session (single mode)
      const s4TaskId = `s4-multi-inj-${suffix}`;
      const s4Inj1 = makeInjection(s4TaskId, "s4-1", "jit", "2026-10-01T12:15:00.000Z");
      const s4Inj2 = makeInjection(s4TaskId, "s4-2", "jit", "2026-10-01T12:20:00.000Z");
      await repository.recordInjectionEvent({
        event: s4Inj1,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s4TaskId)
      });
      await repository.recordInjectionEvent({
        event: s4Inj2,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s4TaskId)
      });
      await repository.recordSessionOutcomeReport({
        report: makeSessionReport(s4TaskId, "success"),
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s4TaskId)
      });

      // Session 5: mixed mode (jit and retrieval-only)
      const s5TaskId = `s5-mixed-${suffix}`;
      const s5Inj1 = makeInjection(s5TaskId, "s5-1", "jit", "2026-10-01T12:25:00.000Z");
      const s5Inj2 = makeInjection(s5TaskId, "s5-2", "retrieval-only", "2026-10-01T12:30:00.000Z");
      await repository.recordInjectionEvent({
        event: s5Inj1,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s5TaskId)
      });
      await repository.recordInjectionEvent({
        event: s5Inj2,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s5TaskId)
      });

      // Session 6: outside window
      const s6TaskId = `s6-outside-${suffix}`;
      const s6Inj = makeInjection(s6TaskId, "s6", "jit", "2026-09-15T12:00:00.000Z");
      await repository.recordInjectionEvent({
        event: s6Inj,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s6TaskId)
      });

      // Session 7: session with conflicting per-injection token reports
      const s7TaskId = `s7-conflict-${suffix}`;
      const s7Inj1 = makeInjection(s7TaskId, "s7-1", "jit", "2026-10-01T12:35:00.000Z");
      const s7Inj2 = makeInjection(s7TaskId, "s7-2", "jit", "2026-10-01T12:40:00.000Z");
      await repository.recordInjectionEvent({
        event: s7Inj1,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s7TaskId)
      });
      await repository.recordInjectionEvent({
        event: s7Inj2,
        actor: { id: "runtime", authority: "system" },
        context: makeContext(s7TaskId)
      });
      // Per-injection outcome 1: success
      await repository.recordOutcomeReport({
        report: {
          id: `rep-tok1-${suffix}`,
          workspaceId,
          repositoryId,
          scope: { kind: "task", workspaceId, taskId: s7TaskId, runId: s7Inj1.runId },
          taskId: s7TaskId,
          runId: s7Inj1.runId,
          agentId: s7Inj1.agentId,
          correlationToken: s7Inj1.correlationToken,
          outcomeKind: "success",
          reportKind: "task",
          reportedAt: "2026-10-01T14:00:00.000Z",
          reporterId: "integration-operator",
          reporterAuthority: "curator",
          reasonCode: "reporter_supplied",
          evidence: [{ kind: "commit", uri: `git://repo/commit/${suffix}` }]
        },
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s7TaskId)
      });
      // Per-injection outcome 2: failure -> conflict across tokens in s7
      await repository.recordOutcomeReport({
        report: {
          id: `rep-tok2-${suffix}`,
          workspaceId,
          repositoryId,
          scope: { kind: "task", workspaceId, taskId: s7TaskId, runId: s7Inj2.runId },
          taskId: s7TaskId,
          runId: s7Inj2.runId,
          agentId: s7Inj2.agentId,
          correlationToken: s7Inj2.correlationToken,
          outcomeKind: "failure",
          reportKind: "task",
          reportedAt: "2026-10-01T14:05:00.000Z",
          reporterId: "integration-operator",
          reporterAuthority: "curator",
          reasonCode: "reporter_supplied",
          evidence: [{ kind: "commit", uri: `git://repo/commit/${suffix}` }]
        },
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s7TaskId)
      });
      // Session-level outcome for s7: success
      await repository.recordSessionOutcomeReport({
        report: makeSessionReport(s7TaskId, "success"),
        actor: { id: "curator", authority: "curator" },
        context: makeContext(s7TaskId)
      });

      const page = await repository.aggregateSessionOutcomeCohorts({
        context: {
          workspaceId,
          repositoryId,
          canReadGlobal: false,
          canReadTaskHistory: true
        },
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-10-01T23:59:59.999Z"
      });

      assert.equal(page.schema, "autodev-memory-session-outcome-cohorts-v1");
      // Sessions in window: s1, s2, s3, s4, s5, s7 = 6 sessions, but s5 is
      // mixed-mode and is excluded from sessionCount/cells, counted only in
      // mixedModeSessionCount: s1, s2, s3, s4, s7 = 5 eligible sessions.
      assert.equal(page.sessionCount, 5);
      assert.equal(page.reportedSessionCount, 4);
      assert.equal(page.unreportedSessionCount, 1);
      assert.equal(page.conflictingOutcomeSessionCount, 1);
      assert.equal(page.mixedModeSessionCount, 1);

      assert.deepEqual(page.cells, [
        { memoryMode: "jit", outcomeKind: null, sessionCount: 1 },
        { memoryMode: "jit", outcomeKind: "success", sessionCount: 3 },
        { memoryMode: "retrieval-only", outcomeKind: "failure", sessionCount: 1 }
      ]);

      // Mode filter test: query with memoryModes: ['retrieval-only']
      // S3 has retrieval-only (single, failure). S5 has mixed mode (which had an in-window retrieval-only event).
      const filteredPage = await repository.aggregateSessionOutcomeCohorts({
        context: {
          workspaceId,
          repositoryId,
          canReadGlobal: false,
          canReadTaskHistory: true
        },
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-10-01T23:59:59.999Z",
        memoryModes: ["retrieval-only"]
      });
      // S3 (retrieval-only, eligible) and S5 (mixed, excluded from
      // sessionCount but still counted in mixedModeSessionCount).
      assert.equal(filteredPage.sessionCount, 1);
      assert.equal(filteredPage.reportedSessionCount, 1);
      assert.equal(filteredPage.unreportedSessionCount, 0);
      assert.equal(filteredPage.mixedModeSessionCount, 1);

      const serialized = JSON.stringify(page);
      assert.doesNotMatch(
        serialized,
        /tok-|inj-|agent-|memory-1|integration-operator|curator|git:\/\//u
      );
      assert.equal(serialized.includes(s1TaskId), false);
      assert.equal(serialized.includes(s2TaskId), false);
      assert.equal(serialized.includes(s3TaskId), false);
      assert.equal(serialized.includes(s4TaskId), false);
      assert.equal(serialized.includes(s5TaskId), false);
      assert.equal(serialized.includes(s7TaskId), false);
    } finally {
      await pool.end();
    }
  }
);
