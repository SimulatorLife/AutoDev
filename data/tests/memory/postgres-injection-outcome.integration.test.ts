import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  EvidenceReference,
  MemoryInjectionEvent,
  MemoryOutcomeReport,
  MemoryReadContext
} from "@simulatorlife/autodev-core";

import { createPgMemoryPool } from "../../src/memory/pg-pool.ts";
import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import type { MemoryConnectionPool } from "../../src/memory/query-client.ts";
import { applyMemoryMigrations } from "../../src/memory/schema.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_TEST_DATABASE_URL;

test(
  "live PostgreSQL migration 8, injection/outcome persistence, session-scoped join, and append-only history",
  { skip: !databaseUrl },
  async () => {
    const pool = createPgMemoryPool({ connectionString: databaseUrl });
    const identity = randomUUID();
    const workspaceId = `memory-io-test-${identity}`;
    const repositoryId = `repo-${identity}`;
    // The session task identity is stable for the whole captured session;
    // request-level runId/agentId (requestId/threadId) are intentionally
    // different from the session-level runId/agentId recorded alongside a
    // reporter-supplied outcome.
    const taskId = `task-${identity}`;
    const sessionRunId = `session-run-${identity}`;
    const sessionAgentId = `session-agent-${identity}`;
    const requestRunId = `req-${identity}`;
    const requestAgentId = `thread-${identity}`;
    const now = new Date().toISOString();

    const sessionContext: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId: sessionRunId,
      agentId: sessionAgentId,
      canReadGlobal: false
    };
    const requestContext: MemoryReadContext = {
      workspaceId,
      repositoryId,
      taskId,
      runId: requestRunId,
      agentId: requestAgentId,
      canReadGlobal: false
    };

    const correlationToken = `corr-${identity}`;
    const injectionEvent: MemoryInjectionEvent = {
      id: `inj-${identity}`,
      workspaceId,
      repositoryId,
      scope: { kind: "task", workspaceId, taskId, runId: requestRunId },
      taskId,
      runId: requestRunId,
      agentId: requestAgentId,
      correlationToken,
      memoryMode: "jit",
      injectionResult: "injected",
      packetCharacterCount: 42,
      memoryIds: [`mem-${identity}`],
      occurredAt: now,
      reasonCode: "packet_attached",
      evidence: [],
      recordedBy: "integration-test"
    };
    const unreportedCorrelationToken = `corr-unreported-${identity}`;
    const unreportedInjectionEvent: MemoryInjectionEvent = {
      ...injectionEvent,
      id: `inj-unreported-${identity}`,
      correlationToken: unreportedCorrelationToken,
      injectionResult: "empty",
      packetCharacterCount: 0,
      memoryIds: [],
      reasonCode: "no_packet_research_returned_empty"
    };

    const outcomeEvidence: EvidenceReference = {
      kind: "pull_request",
      uri: `https://github.com/${repositoryId}/pull/42`
    };
    const outcomeReport: MemoryOutcomeReport = {
      id: `out-${identity}`,
      workspaceId,
      repositoryId,
      scope: { kind: "task", workspaceId, taskId, runId: sessionRunId },
      taskId,
      runId: sessionRunId,
      agentId: sessionAgentId,
      correlationToken,
      outcomeKind: "success",
      reportKind: "pull_request",
      reportedAt: new Date(Date.now() + 1000).toISOString(),
      reporterId: "reporter-will-be-overridden",
      reporterAuthority: "curator",
      reasonCode: "reporter_supplied",
      evidence: [outcomeEvidence]
    };

    try {
      // Migration 8 must apply cleanly against real PostgreSQL/pgvector and
      // remain idempotent when re-run, mirroring the production migrator.
      await applyMemoryMigrations(pool);
      await applyMemoryMigrations(pool);
      const appliedMigration8 = await pool.query<{ version: number }>(
        "SELECT version FROM memory_schema_migrations WHERE version = 8"
      );
      assert.equal(appliedMigration8.rows.length, 1);
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('memory_injection_events', 'memory_outcome_reports')`
      );
      assert.deepEqual(tables.rows.map((row) => row.table_name).sort(), [
        "memory_injection_events",
        "memory_outcome_reports"
      ]);

      const repository = new PostgresMemoryRepository({ pool });

      // Request-level injection events persist under the request's own
      // runId/agentId, scoped by workspace/repository/task to the session.
      const injectionResult = await repository.recordInjectionEvent({
        event: injectionEvent,
        actor: { id: "system", authority: "system" },
        context: requestContext
      });
      assert.equal(injectionResult.appended, true);
      assert.equal(injectionResult.id, injectionEvent.id);

      const persistedInjection =
        await repository.findInjectionEventByTokenForSession(
          { workspaceId, repositoryId, taskId, canReadGlobal: false },
          correlationToken
        );
      assert.ok(persistedInjection);
      assert.equal(persistedInjection?.runId, requestRunId);
      assert.equal(persistedInjection?.agentId, requestAgentId);

      // A reporter outcome joins by (workspace, repository, task) even
      // though the reporting session's runId/agentId differ from the
      // injection event's request-level runId/agentId.
      const outcomeResult = await repository.recordOutcomeReport({
        report: outcomeReport,
        actor: { id: "operator-1", authority: "root" },
        context: sessionContext
      });
      assert.equal(outcomeResult.appended, true);

      const reportedJoin = await repository.listInjectionOutcomeJoins({
        context: sessionContext
      });
      assert.equal(reportedJoin.total, 1);
      const joinedRow = reportedJoin.items.find(
        (item) => item.injection.id === injectionEvent.id
      );
      assert.ok(joinedRow);
      assert.equal(joinedRow?.injection.runId, requestRunId);
      assert.equal(joinedRow?.injection.agentId, requestAgentId);
      assert.equal(joinedRow?.outcome?.outcomeKind, "success");
      assert.equal(joinedRow?.outcome?.runId, sessionRunId);
      assert.equal(joinedRow?.outcome?.agentId, sessionAgentId);
      assert.equal(joinedRow?.outcome?.reporterId, "operator-1");
      assert.equal(joinedRow?.outcome?.reporterAuthority, "root");

      // An unrelated workspace's session context cannot resolve this
      // workspace's correlationToken: the token is scope-bound and the
      // write fails closed rather than silently matching nothing.
      const unrelatedWorkspaceId = `memory-io-test-unrelated-${identity}`;
      await assert.rejects(
        () =>
          repository.recordOutcomeReport({
            report: {
              ...outcomeReport,
              id: `out-unrelated-${identity}`
            },
            actor: { id: "operator-1", authority: "root" },
            context: {
              workspaceId: unrelatedWorkspaceId,
              repositoryId,
              taskId,
              runId: sessionRunId,
              agentId: sessionAgentId,
              canReadGlobal: false
            }
          }),
        /no scope-aligned injection/
      );

      // A same-body retry (fresh caller-supplied id, identical fields) is
      // idempotent: it returns the original id and does not insert a row.
      const retryResult = await repository.recordOutcomeReport({
        report: { ...outcomeReport, id: `out-retry-${identity}` },
        actor: { id: "operator-1", authority: "root" },
        context: sessionContext
      });
      assert.equal(retryResult.appended, false);
      assert.equal(retryResult.id, outcomeResult.id);

      // A conflicting retry for the same correlationToken (different body)
      // is rejected rather than silently overwriting the first report.
      await assert.rejects(
        () =>
          repository.recordOutcomeReport({
            report: {
              ...outcomeReport,
              id: `out-conflict-${identity}`,
              outcomeKind: "failure"
            },
            actor: { id: "operator-1", authority: "root" },
            context: sessionContext
          }),
        /conflicts with a previously recorded report/
      );

      // Concurrent identical reports exercise the real unique-index race
      // path: one append wins and the other resolves as an idempotent retry.
      const raceToken = `corr-race-${identity}`;
      const raceInjectionEvent: MemoryInjectionEvent = {
        ...injectionEvent,
        id: `inj-race-${identity}`,
        runId: `req-race-${identity}`,
        agentId: `thread-race-${identity}`,
        correlationToken: raceToken
      };
      await repository.recordInjectionEvent({
        event: raceInjectionEvent,
        actor: { id: "system", authority: "system" },
        context: requestContext
      });
      // Hold both pre-insert existence reads until each has observed no report,
      // guaranteeing that the two INSERTs contend on the real unique index.
      let releaseOutcomeReads!: () => void;
      const outcomeReadsBarrier = new Promise<void>((resolve) => {
        releaseOutcomeReads = resolve;
      });
      let outcomeReads = 0;
      const racePool: MemoryConnectionPool = {
        async query<
          Row extends Record<string, unknown> = Record<string, unknown>
        >(text: string, params?: readonly unknown[]) {
          const result = await pool.query<Row>(text, params);
          if (/^SELECT \* FROM memory_outcome_reports/iu.test(text.trim())) {
            outcomeReads += 1;
            if (outcomeReads === 2) releaseOutcomeReads();
            await outcomeReadsBarrier;
          }
          return result;
        },
        connect: () => pool.connect(),
        end: () => pool.end()
      };
      const raceRepository = new PostgresMemoryRepository({ pool: racePool });
      const raceReports = await Promise.all([
        raceRepository.recordOutcomeReport({
          report: {
            ...outcomeReport,
            id: `out-race-a-${identity}`,
            correlationToken: raceToken
          },
          actor: { id: "operator-1", authority: "root" },
          context: sessionContext
        }),
        raceRepository.recordOutcomeReport({
          report: {
            ...outcomeReport,
            id: `out-race-b-${identity}`,
            correlationToken: raceToken
          },
          actor: { id: "operator-1", authority: "root" },
          context: sessionContext
        })
      ]);
      assert.deepEqual(raceReports.map((result) => result.appended).sort(), [
        false,
        true
      ]);
      const raceRows = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_outcome_reports WHERE correlation_token = $1",
        [raceToken]
      );
      assert.equal(raceRows.rows[0]?.count, "1");

      // An unreported injection event is hidden by default and surfaced
      // with outcome:null only when includeUnreported is requested.
      const unreportedResult = await repository.recordInjectionEvent({
        event: unreportedInjectionEvent,
        actor: { id: "system", authority: "system" },
        context: requestContext
      });
      assert.equal(unreportedResult.appended, true);

      const stillReportedOnly = await repository.listInjectionOutcomeJoins({
        context: sessionContext
      });
      assert.equal(stillReportedOnly.total, 2);

      const withUnreported = await repository.listInjectionOutcomeJoins({
        context: sessionContext,
        includeUnreported: true
      });
      assert.equal(withUnreported.total, 3);
      const unreportedRow = withUnreported.items.find(
        (item) => item.injection.id === unreportedInjectionEvent.id
      );
      assert.ok(unreportedRow);
      assert.equal(unreportedRow?.outcome, null);

      // Both event tables are append-only: UPDATE and DELETE must be
      // rejected by the database trigger, never caught/suppressed by the
      // repository layer, and no raw event row is ever deleted by this test.
      await assert.rejects(
        pool.query(
          "UPDATE memory_injection_events SET injection_result = 'skipped' WHERE id = $1",
          [injectionEvent.id]
        ),
        /append-only/
      );
      await assert.rejects(
        pool.query("DELETE FROM memory_injection_events WHERE id = $1", [
          injectionEvent.id
        ]),
        /append-only/
      );
      await assert.rejects(
        pool.query(
          "UPDATE memory_outcome_reports SET outcome_kind = 'failure' WHERE id = $1",
          [outcomeResult.id]
        ),
        /append-only/
      );
      await assert.rejects(
        pool.query("DELETE FROM memory_outcome_reports WHERE id = $1", [
          outcomeResult.id
        ]),
        /append-only/
      );
    } finally {
      await pool.end();
    }
  }
);
