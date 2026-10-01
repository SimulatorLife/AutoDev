import { MEMORY_REASON_CODES } from "@simulatorlife/autodev-core";

import type { MemoryConnectionPool } from "./query-client.ts";

export interface MemoryMigration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

const SCOPE_COLUMNS_DDL = `
  scope_kind text NOT NULL,
  scope_workspace_id text,
  scope_repository_id text,
  scope_role text,
  scope_task_id text,
  scope_run_id text,
  scope_agent_id text
`;

export const MEMORY_EMBEDDING_DIMENSIONS = 1536 as const;

const MEMORY_REASON_CODE_SQL = MEMORY_REASON_CODES.map(
  (reason) => `'${reason}'`
).join(", ");

const SCOPE_KIND_CHECK = (table: string) => `
  ALTER TABLE ${table}
    ADD CONSTRAINT ${table}_scope_kind_check
    CHECK (scope_kind IN ('global', 'workspace', 'repository', 'role', 'task', 'agent'));
`;

/**
 * Versioned, forward-only migrations for the memory store. Each entry is
 * applied at most once, tracked by `memory_schema_migrations`. pgvector is
 * optional: migration 1 enables it defensively and only adds the embedding
 * column/index when the extension is actually available in the target
 * database, so a plain PostgreSQL install still gets full lexical search.
 */
export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  {
    version: 1,
    description:
      "Create append-only experience envelopes and versioned memory records",
    sql: `
-- Experience envelopes are append-only: raw execution evidence, never
-- transcript/prompt/tool payloads (those stay in their source systems).
CREATE TABLE memory_experiences (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  repository_id text,
  ${SCOPE_COLUMNS_DDL},
  task_id text NOT NULL,
  run_id text NOT NULL,
  task_kind text,
  task_reference jsonb,
  plan_reference jsonb,
  agent_id text NOT NULL,
  agent_role text,
  provider text,
  model text,
  branch text,
  base_commit text,
  head_commit text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('success', 'partial', 'failure', 'cancelled', 'unknown')),
  validation_state text CHECK (validation_state IN ('passed', 'failed', 'partial', 'not_run')),
  validation_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  trajectory_format text NOT NULL,
  trajectory_uri text NOT NULL,
  trajectory_digest text,
  trajectory_record_count integer,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(task_kind, '') || ' ' || coalesce(agent_role, '') || ' ' ||
      coalesce(provider, '') || ' ' || coalesce(model, '') || ' ' ||
      coalesce(branch, '') || ' ' || outcome || ' ' || trajectory_uri
    )
  ) STORED
);
${SCOPE_KIND_CHECK("memory_experiences")}
CREATE INDEX idx_memory_experiences_scope
  ON memory_experiences (scope_kind, scope_workspace_id, scope_repository_id, scope_task_id, scope_run_id, scope_agent_id);
CREATE INDEX idx_memory_experiences_search ON memory_experiences USING GIN (search_vector);

-- Reject any attempt to mutate or remove raw experience evidence.
CREATE FUNCTION memory_experiences_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_experiences is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER memory_experiences_no_update
  BEFORE UPDATE OR DELETE ON memory_experiences
  FOR EACH ROW EXECUTE FUNCTION memory_experiences_append_only();

-- Typed memory records: the current, mutable snapshot per memory id.
-- Every lifecycle transition is also recorded in memory_lifecycle_events,
-- which is append-only, so history is never lost even though this table
-- is updated in place.
CREATE TABLE memory_records (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('episodic', 'semantic', 'procedural')),
  ${SCOPE_COLUMNS_DDL},
  claim text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'invalidated', 'uncertain')),
  provenance jsonb NOT NULL,
  validity_state text NOT NULL CHECK (validity_state IN ('unverified', 'verified', 'uncertain', 'contradicted')),
  validity_valid_from timestamptz,
  validity_valid_to timestamptz,
  validity_detail jsonb NOT NULL,
  supersedes jsonb NOT NULL DEFAULT '[]'::jsonb,
  superseded_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  claim_search tsvector GENERATED ALWAYS AS (to_tsvector('english', claim)) STORED
);
${SCOPE_KIND_CHECK("memory_records")}
CREATE INDEX idx_memory_records_scope
  ON memory_records (scope_kind, scope_workspace_id, scope_repository_id, scope_role, scope_task_id, scope_run_id, scope_agent_id);
CREATE INDEX idx_memory_records_status ON memory_records (status);
CREATE INDEX idx_memory_records_claim_search ON memory_records USING GIN (claim_search);

-- Append-only governance log: every proposal/verification/revision/
-- invalidation/supersession/promotion decision, independent of the mutable
-- memory_records snapshot.
CREATE TABLE memory_lifecycle_events (
  id text PRIMARY KEY,
  memory_id text NOT NULL REFERENCES memory_records (id),
  action text NOT NULL CHECK (action IN ('proposed', 'verified', 'revised', 'invalidated', 'superseded', 'promoted', 'procedure_promoted')),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN ('proposed', 'active', 'superseded', 'invalidated', 'uncertain')),
  to_status text NOT NULL CHECK (to_status IN ('proposed', 'active', 'superseded', 'invalidated', 'uncertain')),
  -- Keep in sync with core/src/memory/types.ts MEMORY_REASON_CODES.
  reason_code text NOT NULL CHECK (reason_code IN (${MEMORY_REASON_CODE_SQL})),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_memory_lifecycle_events_memory ON memory_lifecycle_events (memory_id, occurred_at);

CREATE FUNCTION memory_lifecycle_events_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_lifecycle_events is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER memory_lifecycle_events_no_update
  BEFORE UPDATE OR DELETE ON memory_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION memory_lifecycle_events_append_only();

-- Initial schema attempted pgvector installation defensively. Migration 2
-- makes the extension mandatory and upgrades the embedding column/index.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension unavailable; continuing without vector search';
  END;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS embedding vector(${MEMORY_EMBEDDING_DIMENSIONS})';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_memory_records_embedding ON memory_records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  END IF;
END
$$;
`
  },
  {
    version: 2,
    description: "Require pgvector and align lifecycle reason codes with Core",
    sql: `
-- PostgreSQL + pgvector is the canonical memory store. Fail migration clearly
-- when the server cannot install the required extension; lexical search alone
-- is not a complete substitute for the documented store.
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memory_records ADD COLUMN IF NOT EXISTS embedding vector(${MEMORY_EMBEDDING_DIMENSIONS});
CREATE INDEX IF NOT EXISTS idx_memory_records_embedding
  ON memory_records USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE memory_lifecycle_events
  DROP CONSTRAINT IF EXISTS memory_lifecycle_events_reason_code_check;
ALTER TABLE memory_lifecycle_events
  ADD CONSTRAINT memory_lifecycle_events_reason_code_check
  CHECK (reason_code IN (${MEMORY_REASON_CODE_SQL}));
`
  },
  {
    version: 3,
    description: "Record canonical RuleSync procedure promotions",
    sql: `
ALTER TABLE memory_lifecycle_events
  DROP CONSTRAINT IF EXISTS memory_lifecycle_events_action_check;
ALTER TABLE memory_lifecycle_events
  ADD CONSTRAINT memory_lifecycle_events_action_check
  CHECK (action IN ('proposed', 'verified', 'revised', 'invalidated', 'superseded', 'promoted', 'procedure_promoted'));
ALTER TABLE memory_lifecycle_events
  DROP CONSTRAINT IF EXISTS memory_lifecycle_events_reason_code_check;
ALTER TABLE memory_lifecycle_events
  ADD CONSTRAINT memory_lifecycle_events_reason_code_check
  CHECK (reason_code IN (${MEMORY_REASON_CODE_SQL}));
`
  },
  {
    version: 4,
    description: "Allow audited erasure of unreferenced raw experiences",
    sql: `
CREATE TABLE IF NOT EXISTS memory_experience_privacy_events (
  id text PRIMARY KEY,
  experience_fingerprint text NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('privacy_request', 'retention_expired')),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_experience_privacy_events_time
  ON memory_experience_privacy_events (occurred_at);
CREATE FUNCTION memory_experience_privacy_events_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_experience_privacy_events is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER memory_experience_privacy_events_no_update
  BEFORE UPDATE OR DELETE ON memory_experience_privacy_events
  FOR EACH ROW EXECUTE FUNCTION memory_experience_privacy_events_append_only();

CREATE INDEX IF NOT EXISTS idx_memory_records_experience_refs
  ON memory_records USING GIN ((provenance->'experienceIds'));

CREATE OR REPLACE FUNCTION memory_experiences_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('autodev.memory_privacy_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory_experiences is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
`
  }
];

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS memory_schema_migrations (
  version integer PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * Applies every migration that has not yet been recorded in
 * `memory_schema_migrations`, in version order, each in its own
 * transaction.
 */
export async function applyMemoryMigrations(
  pool: MemoryConnectionPool
): Promise<void> {
  await pool.query(MIGRATIONS_TABLE_DDL);
  const applied = await pool.query<{ version: number }>(
    "SELECT version FROM memory_schema_migrations"
  );
  const appliedVersions = new Set(applied.rows.map((row) => row.version));

  const pending = MEMORY_MIGRATIONS.filter(
    (m) => !appliedVersions.has(m.version)
  ).sort((a, b) => a.version - b.version);

  // Migrations must apply in version order, each fully committed before the
  // next begins, so this loop is intentionally sequential rather than parallel.
  /* eslint-disable no-await-in-loop -- migrations must commit strictly in version order */
  for (const migration of pending) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(migration.sql);
      await connection.query(
        "INSERT INTO memory_schema_migrations (version, description) VALUES ($1, $2)",
        [migration.version, migration.description]
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  /* eslint-enable no-await-in-loop */
}
