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
    [1, 2, 3, 4]
  );
  const initial = MEMORY_MIGRATIONS[0];
  const upgrade = MEMORY_MIGRATIONS[1];
  const skillPromotion = MEMORY_MIGRATIONS[2];
  const privacyErasure = MEMORY_MIGRATIONS[3];
  assert.ok(initial);
  assert.ok(upgrade);
  assert.ok(skillPromotion);
  assert.ok(privacyErasure);

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
});

test("applyMemoryMigrations records applied versions and runs each migration in its own transaction", async () => {
  const pool = new FakeMemoryPool();
  await applyMemoryMigrations(pool);

  assert.deepEqual(
    pool.tables.memory_schema_migrations.map((row) => row.version),
    [1, 2, 3, 4]
  );
  assert.equal(pool.executed.filter((sql) => sql === "BEGIN").length, 4);
  assert.equal(pool.executed.filter((sql) => sql === "COMMIT").length, 4);
});

test("applyMemoryMigrations is idempotent: a second call applies nothing new", async () => {
  const pool = new FakeMemoryPool();
  await applyMemoryMigrations(pool);
  const executedAfterFirst = pool.executed.length;

  await applyMemoryMigrations(pool);

  assert.equal(pool.tables.memory_schema_migrations.length, 4);
  const newCalls = pool.executed.slice(executedAfterFirst);
  assert.ok(
    !newCalls.some((sql) => sql.includes("CREATE TABLE memory_experiences"))
  );
  assert.ok(!newCalls.some((sql) => sql.includes("DROP CONSTRAINT")));
});
