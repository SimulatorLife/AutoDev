import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMemoryMigrations,
  MEMORY_MIGRATIONS
} from "../../src/memory/schema.ts";
import { FakeMemoryPool } from "./fixtures/fake-memory-pool.ts";

test("memory migrations define append-only provenance and mandatory PostgreSQL/pgvector storage", () => {
  assert.deepEqual(
    MEMORY_MIGRATIONS.map((migration) => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  const initial = MEMORY_MIGRATIONS[0];
  const upgrade = MEMORY_MIGRATIONS[1];
  const skillPromotion = MEMORY_MIGRATIONS[2];
  const privacyErasure = MEMORY_MIGRATIONS[3];
  const retentionIndex = MEMORY_MIGRATIONS[4];
  const experienceEvidenceSearch = MEMORY_MIGRATIONS[5];
  const experienceMemoryMode = MEMORY_MIGRATIONS[6];
  const injectionOutcome = MEMORY_MIGRATIONS[7];
  const injectionSessionIndex = MEMORY_MIGRATIONS[8];
  const sessionOutcomeReports = MEMORY_MIGRATIONS[9];
  assert.ok(sessionOutcomeReports);
  assert.ok(initial);
  assert.ok(upgrade);
  assert.ok(skillPromotion);
  assert.ok(privacyErasure);
  assert.ok(retentionIndex);
  assert.ok(experienceEvidenceSearch);
  assert.ok(experienceMemoryMode);
  assert.ok(injectionOutcome);
  assert.ok(injectionSessionIndex);

  // Append-only experience envelopes, never transcript/prompt/tool payloads.
  assert.match(initial.sql, /CREATE TABLE memory_experiences/);
  const ddlWithoutComments = initial.sql
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith("--"))
    .join(String.fromCharCode(10));
  assert.doesNotMatch(ddlWithoutComments, /prompt/i);
  assert.doesNotMatch(ddlWithoutComments, /transcript/i);
  assert.match(initial.sql, /memory_experiences_append_only/);
  assert.match(initial.sql, /BEFORE UPDATE OR DELETE ON memory_experiences/);

  // Typed, versioned memory records with lifecycle/provenance/supersession.
  assert.match(initial.sql, /CREATE TABLE memory_records/);
  assert.match(
    initial.sql,
    /status text NOT NULL CHECK \(status IN \('proposed', 'active', 'superseded', 'invalidated', 'uncertain'\)\)/
  );
  assert.match(initial.sql, /supersedes jsonb/);
  assert.match(initial.sql, /superseded_by jsonb/);

  // Append-only governance log, independent of the mutable record snapshot.
  assert.match(initial.sql, /CREATE TABLE memory_lifecycle_events/);
  assert.match(
    initial.sql,
    /BEFORE UPDATE OR DELETE ON memory_lifecycle_events/
  );
  assert.match(initial.sql, /REFERENCES memory_records \(id\)/);
  assert.match(
    initial.sql,
    /reason_code text NOT NULL CHECK \(reason_code IN \(/
  );
  assert.match(initial.sql, /revised_after_review/);
  assert.match(initial.sql, /procedure_promoted/);
  assert.match(initial.sql, /promoted_to_skill/);

  // PostgreSQL FTS is always available; migration 2 requires pgvector instead
  // of silently degrading the canonical store to lexical-only.
  assert.match(initial.sql, /USING GIN \(claim_search\)/);
  assert.match(initial.sql, /USING GIN \(search_vector\)/);
  assert.match(upgrade.sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(upgrade.sql, /embedding vector\(1536\)/);
  assert.match(upgrade.sql, /USING ivfflat/);
  assert.match(
    upgrade.sql,
    /DROP CONSTRAINT IF EXISTS memory_lifecycle_events_reason_code_check/
  );
  assert.match(upgrade.sql, /revised_after_review/);
  assert.doesNotMatch(upgrade.sql, /EXCEPTION WHEN OTHERS/);
  assert.match(skillPromotion.sql, /memory_lifecycle_events_action_check/);
  assert.match(skillPromotion.sql, /procedure_promoted/);
  assert.match(skillPromotion.sql, /promoted_to_skill/);
  assert.match(privacyErasure.sql, /memory_experience_privacy_events/);
  assert.match(privacyErasure.sql, /experience_fingerprint text NOT NULL/);
  assert.match(privacyErasure.sql, /memory_records_experience_refs/);
  assert.match(
    privacyErasure.sql,
    /CREATE FUNCTION memory_experience_privacy_events_append_only/
  );
  assert.match(
    privacyErasure.sql,
    /BEFORE UPDATE OR DELETE ON memory_experience_privacy_events/
  );
  assert.match(
    privacyErasure.sql,
    /IF TG_OP = 'DELETE' AND current_setting\('autodev\.memory_privacy_purge', true\) = 'on'/
  );
  assert.match(retentionIndex.sql, /idx_memory_experiences_retention/);
  assert.match(retentionIndex.sql, /completed_at IS NOT NULL/);
  assert.match(experienceEvidenceSearch.sql, /DROP COLUMN search_vector/);
  assert.match(experienceEvidenceSearch.sql, /task_reference::text/);
  assert.match(experienceEvidenceSearch.sql, /validation_evidence::text/);
  assert.match(experienceEvidenceSearch.sql, /evidence::text/);
  assert.match(experienceEvidenceSearch.sql, /USING GIN \(search_vector\)/);
  assert.doesNotMatch(experienceEvidenceSearch.sql, /transcript/i);
  assert.match(experienceMemoryMode.sql, /memory_mode text/);
  assert.match(experienceMemoryMode.sql, /retrieval-only/);
  assert.match(experienceMemoryMode.sql, /idx_memory_experiences_mode_outcome/);
  assert.match(injectionOutcome.sql, /CREATE TABLE memory_injection_events/);
  assert.match(injectionOutcome.sql, /correlation_token text NOT NULL UNIQUE/);
  assert.match(injectionOutcome.sql, /CREATE TABLE memory_outcome_reports/);
  const outcomeIndex = injectionOutcome.sql.match(
    /CREATE UNIQUE INDEX uniq_memory_outcome_reports_scope_key\s+ON memory_outcome_reports\s*\(([^)]+)\)/
  );
  assert.ok(outcomeIndex);
  assert.equal(
    outcomeIndex[1]?.replaceAll(/\s+/g, ""),
    "workspace_id,correlation_token"
  );
  assert.match(
    injectionOutcome.sql,
    /BEFORE UPDATE OR DELETE ON memory_injection_events/
  );
  assert.match(
    injectionOutcome.sql,
    /BEFORE UPDATE OR DELETE ON memory_outcome_reports/
  );

  // Forward-only session index supports full-set injection counts without
  // changing migration 8's append-only event table contract.
  assert.match(
    injectionSessionIndex.sql,
    /CREATE INDEX idx_memory_injection_events_session_key\s+ON memory_injection_events\s*\(workspace_id, repository_id, task_id\)/
  );

  // Session outcome reports are a distinct append-only table, one row per
  // trusted (workspace_id, repository_id, task_id) session key -- not a
  // wrapper or fan-out of the per-injection-token memory_outcome_reports.
  assert.match(
    sessionOutcomeReports.sql,
    /CREATE TABLE memory_session_outcome_reports/
  );
  const sessionOutcomeIndex = sessionOutcomeReports.sql.match(
    /CREATE UNIQUE INDEX uniq_memory_session_outcome_reports_key\s+ON memory_session_outcome_reports\s*\(([^)]+)\)/
  );
  assert.ok(sessionOutcomeIndex);
  assert.equal(
    sessionOutcomeIndex[1]?.replaceAll(/\s+/g, ""),
    "workspace_id,repository_id,task_id"
  );
  assert.match(
    sessionOutcomeReports.sql,
    /repository_id text NOT NULL/
  );
  assert.match(
    sessionOutcomeReports.sql,
    /reporter_authority text NOT NULL CHECK \(reporter_authority IN \('root', 'curator'\)\)/
  );
  assert.match(
    sessionOutcomeReports.sql,
    /memory_session_outcome_reports_validate_session/
  );
  assert.match(
    sessionOutcomeReports.sql,
    /requires at least one recorded injection event/
  );
  assert.match(
    sessionOutcomeReports.sql,
    /BEFORE UPDATE OR DELETE ON memory_session_outcome_reports/
  );
  assert.match(
    sessionOutcomeReports.sql,
    /memory_session_outcome_reports is append-only/
  );
  assert.doesNotMatch(sessionOutcomeReports.sql, /scope_kind/);
  assert.doesNotMatch(sessionOutcomeReports.sql, /run_id/);
  assert.doesNotMatch(sessionOutcomeReports.sql, /agent_id/);
  assert.doesNotMatch(sessionOutcomeReports.sql, /session_injection_count/);
});

test("applyMemoryMigrations records applied versions and runs each migration in its own transaction", async () => {
  const pool = new FakeMemoryPool();
  await applyMemoryMigrations(pool);

  assert.deepEqual(
    pool.tables.memory_schema_migrations.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(pool.executed.filter((sql) => sql === "BEGIN").length, 10);
  assert.equal(pool.executed.filter((sql) => sql === "COMMIT").length, 10);
});

test("applyMemoryMigrations adds migration 9 transactionally to a database already at migration 8", async () => {
  const pool = new FakeMemoryPool();
  pool.tables.memory_schema_migrations.push(
    ...Array.from({ length: 8 }, (_, index) => ({
      version: index + 1,
      description: "already applied"
    }))
  );

  await applyMemoryMigrations(pool);

  assert.deepEqual(
    pool.tables.memory_schema_migrations.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(pool.executed.filter((sql) => sql === "BEGIN").length, 2);
  assert.equal(pool.executed.filter((sql) => sql === "COMMIT").length, 2);
  assert.equal(pool.executed.filter((sql) => sql === "ROLLBACK").length, 0);
  assert.ok(
    pool.executed.some((sql) =>
      sql.includes("idx_memory_injection_events_session_key")
    )
  );
  assert.ok(
    !pool.executed.some((sql) => sql.includes("CREATE TABLE memory_injection_events"))
  );
});

test("applyMemoryMigrations adds migration 10 transactionally to a database already at migration 9", async () => {
  const pool = new FakeMemoryPool();
  pool.tables.memory_schema_migrations.push(
    ...Array.from({ length: 9 }, (_, index) => ({
      version: index + 1,
      description: "already applied"
    }))
  );

  await applyMemoryMigrations(pool);

  assert.deepEqual(
    pool.tables.memory_schema_migrations.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(pool.executed.filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(pool.executed.filter((sql) => sql === "COMMIT").length, 1);
  assert.equal(pool.executed.filter((sql) => sql === "ROLLBACK").length, 0);
  assert.ok(
    pool.executed.some((sql) =>
      sql.includes("CREATE TABLE memory_session_outcome_reports")
    )
  );
  assert.ok(
    !pool.executed.some((sql) => sql.includes("CREATE TABLE memory_injection_events"))
  );
});

test("applyMemoryMigrations is idempotent: a second call applies nothing new", async () => {
  const pool = new FakeMemoryPool();
  await applyMemoryMigrations(pool);
  const executedAfterFirst = pool.executed.length;

  await applyMemoryMigrations(pool);

  assert.equal(pool.tables.memory_schema_migrations.length, 10);
  const newCalls = pool.executed.slice(executedAfterFirst);
  assert.ok(
    !newCalls.some((sql) => sql.includes("CREATE TABLE memory_experiences"))
  );
  assert.ok(!newCalls.some((sql) => sql.includes("DROP CONSTRAINT")));
  assert.ok(
    !newCalls.some((sql) => sql.includes("idx_memory_experiences_retention"))
  );
  assert.ok(
    !newCalls.some((sql) => sql.includes("idx_memory_experiences_mode_outcome"))
  );
  assert.ok(
    !newCalls.some((sql) =>
      sql.includes("idx_memory_injection_events_session_key")
    )
  );
  assert.ok(
    !newCalls.some((sql) =>
      sql.includes("CREATE TABLE memory_session_outcome_reports")
    )
  );
});
