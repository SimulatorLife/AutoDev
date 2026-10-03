import {
  MEMORY_INJECTION_EVENT_REASON_CODES,
  MEMORY_OUTCOME_REPORT_REASON_CODES,
  MEMORY_REASON_CODES
} from "@simulatorlife/autodev-core";

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

const MEMORY_INJECTION_EVENT_REASON_SQL =
  MEMORY_INJECTION_EVENT_REASON_CODES.map((reason) => `'${reason}'`).join(", ");

const MEMORY_OUTCOME_REPORT_REASON_SQL = MEMORY_OUTCOME_REPORT_REASON_CODES.map(
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
  },
  {
    version: 5,
    description: "Index bounded retention scans of completed experiences",
    sql: `
CREATE INDEX IF NOT EXISTS idx_memory_experiences_retention
  ON memory_experiences (scope_workspace_id, repository_id, completed_at, id)
  WHERE completed_at IS NOT NULL;
`
  },
  {
    version: 6,
    description: "Search raw-experience evidence and source references",
    sql: `
-- Raw experiences retain the searchable technical references needed for
-- later curation: files, commits, PRs/issues, task/plan links, and validation
-- evidence. This indexes references only; source payloads remain external.
DROP INDEX IF EXISTS idx_memory_experiences_search;
ALTER TABLE memory_experiences DROP COLUMN search_vector;
ALTER TABLE memory_experiences
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(repository_id, '') || ' ' ||
      coalesce(task_kind, '') || ' ' || coalesce(agent_role, '') || ' ' ||
      coalesce(provider, '') || ' ' || coalesce(model, '') || ' ' ||
      coalesce(branch, '') || ' ' || outcome || ' ' ||
      coalesce(base_commit, '') || ' ' || coalesce(head_commit, '') || ' ' ||
      coalesce(trajectory_uri, '') || ' ' ||
      coalesce(task_reference::text, '') || ' ' ||
      coalesce(plan_reference::text, '') || ' ' ||
      coalesce(validation_evidence::text, '') || ' ' ||
      coalesce(evidence::text, '')
    )
  ) STORED;
CREATE INDEX idx_memory_experiences_search
  ON memory_experiences USING GIN (search_vector);
`
  },
  {
    version: 7,
    description: "Store the host-selected memory mode on each experience",
    sql: `
ALTER TABLE memory_experiences
  ADD COLUMN memory_mode text
  CHECK (memory_mode IN ('jit', 'retrieval-only', 'disabled', 'invalid', 'unknown'));
CREATE INDEX idx_memory_experiences_mode_outcome
  ON memory_experiences (
    scope_workspace_id,
    repository_id,
    memory_mode,
    outcome,
    completed_at
  )
  WHERE memory_mode IS NOT NULL;
`
  },
  {
    version: 8,
    description:
      "Record actual memory packet injection events and reporter-supplied outcome joins",
    sql: `
-- Actual memory packet injection events are append-only observations of the
-- runtime boundary. They record the host-selected mode, the injected/empty
-- decision, and the bounded memory references that were attached; the
-- durable correlationToken is opaque, contains no transcript or claim
-- content, and is never propagated into metric dimensions or model prompts.
-- The (workspace, repository, task, run, agent) scope mirrors
-- memory_experiences so visibility/authority reuse buildScopeFilterSql.
CREATE TABLE memory_injection_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  repository_id text,
  ${SCOPE_COLUMNS_DDL},
  task_id text NOT NULL,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  agent_role text,
  -- SHA-256 tokens include workspace/repository/task/request identity; global
  -- uniqueness makes an accidental cross-workspace token collision fail closed.
  correlation_token text NOT NULL UNIQUE,
  memory_mode text NOT NULL CHECK (memory_mode IN ('jit', 'retrieval-only', 'disabled', 'invalid', 'unknown')),
  injection_result text NOT NULL CHECK (injection_result IN ('injected', 'empty', 'skipped')),
  packet_character_count integer NOT NULL DEFAULT 0 CHECK (packet_character_count >= 0),
  packet_token_count integer CHECK (packet_token_count IS NULL OR packet_token_count >= 0),
  memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  occurred_at timestamptz NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN (${MEMORY_INJECTION_EVENT_REASON_SQL})),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
${SCOPE_KIND_CHECK("memory_injection_events")}
CREATE INDEX idx_memory_injection_events_scope_time
  ON memory_injection_events (scope_workspace_id, repository_id, task_id, run_id, agent_id, occurred_at);

CREATE FUNCTION memory_injection_events_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_injection_events is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER memory_injection_events_no_update
  BEFORE UPDATE OR DELETE ON memory_injection_events
  FOR EACH ROW EXECUTE FUNCTION memory_injection_events_append_only();

-- Reporter-supplied outcome reports are append-only and must point at a
-- previously observed injection event in the session scope (workspace,
-- repository, task). Injection run_id/agent_id are request-level details
-- and are intentionally not part of the join. One outcome report is
-- permitted per injection:
-- a unique (workspace_id, correlation_token) key makes a same-body retry
-- idempotent (the repository returns appended: false) while a conflicting
-- retry for the same token is rejected, so every injection joins to at
-- most one reporter-supplied outcome and analytics never double-count
-- one exposure.
CREATE TABLE memory_outcome_reports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  repository_id text,
  ${SCOPE_COLUMNS_DDL},
  task_id text NOT NULL,
  run_id text NOT NULL,
  agent_id text NOT NULL,
  correlation_token text NOT NULL,
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('success', 'partial', 'failure', 'cancelled', 'unknown')),
  report_kind text NOT NULL CHECK (report_kind IN ('task', 'pull_request', 'issue', 'other')),
  reported_at timestamptz NOT NULL,
  reporter_id text NOT NULL,
  -- "worker" and "system" must never appear in the recorded authority:
  -- worker actors cannot author outcomes, and system actors only emit
  -- injection events, not outcomes. Only root/curator are eligible.
  reporter_authority text NOT NULL CHECK (reporter_authority IN ('root', 'curator')),
  reason_code text NOT NULL CHECK (reason_code IN (${MEMORY_OUTCOME_REPORT_REASON_SQL})),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One row per (workspace_id, correlation_token): see the table comment
-- above for the cardinality/idempotency contract this enforces.
CREATE UNIQUE INDEX uniq_memory_outcome_reports_scope_key
  ON memory_outcome_reports (
    workspace_id,
    correlation_token
  );
${SCOPE_KIND_CHECK("memory_outcome_reports")}
CREATE INDEX idx_memory_outcome_reports_scope_token
  ON memory_outcome_reports (workspace_id, correlation_token);
CREATE INDEX idx_memory_outcome_reports_scope_time
  ON memory_outcome_reports (scope_workspace_id, repository_id, task_id, run_id, agent_id, reported_at);

CREATE FUNCTION memory_outcome_reports_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_outcome_reports is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER memory_outcome_reports_no_update
  BEFORE UPDATE OR DELETE ON memory_outcome_reports
  FOR EACH ROW EXECUTE FUNCTION memory_outcome_reports_append_only();
`
  },
  {
    version: 9,
    description: "Index captured-session injection event lookups",
    sql: `
-- Session counts are derived across all injection rows for the canonical
-- (workspace_id, repository_id, task_id) key. This index supports the
-- full-session aggregation independently of occurred-time or cohort filters.
CREATE INDEX idx_memory_injection_events_session_key
  ON memory_injection_events (workspace_id, repository_id, task_id);
`
  },
  {
    version: 10,
    description: "Create append-only session outcome reports table",
    sql: `
-- Session-level outcome reports are append-only: exactly one report per trusted
-- (workspace_id, repository_id, task_id) session key.
-- Requires repository scope and at least one recorded injection event.
CREATE TABLE memory_session_outcome_reports (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  task_id text NOT NULL,
  outcome_kind text NOT NULL CHECK (outcome_kind IN ('success', 'partial', 'failure', 'cancelled', 'unknown')),
  report_kind text NOT NULL CHECK (report_kind IN ('task', 'pull_request', 'issue', 'other')),
  reported_at timestamptz NOT NULL,
  reporter_id text NOT NULL,
  -- "worker" and "system" must never appear in the recorded authority:
  -- worker actors cannot author outcomes, and system actors only emit
  -- injection events, not outcomes. Only root/curator are eligible.
  reporter_authority text NOT NULL CHECK (reporter_authority IN ('root', 'curator')),
  reason_code text NOT NULL CHECK (reason_code IN (${MEMORY_OUTCOME_REPORT_REASON_SQL})),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_memory_session_outcome_evidence CHECK (
    outcome_kind = 'unknown' OR jsonb_array_length(evidence) > 0
  )
);

-- Unique session key constraint: exactly one outcome report per session
CREATE UNIQUE INDEX uniq_memory_session_outcome_reports_key
  ON memory_session_outcome_reports (workspace_id, repository_id, task_id);

CREATE INDEX idx_memory_session_outcome_reports_session_key
  ON memory_session_outcome_reports (workspace_id, repository_id, task_id);

CREATE INDEX idx_memory_session_outcome_reports_reported_at
  ON memory_session_outcome_reports (workspace_id, repository_id, reported_at);

-- Trigger ensuring that at least one matching row in memory_injection_events exists for (workspace_id, repository_id, task_id)
CREATE FUNCTION memory_session_outcome_reports_validate_session() RETURNS trigger AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memory_injection_events
    WHERE workspace_id = NEW.workspace_id
      AND repository_id = NEW.repository_id
      AND task_id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'memory_session_outcome_reports requires at least one recorded injection event for (workspace_id, repository_id, task_id)';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER memory_session_outcome_reports_check_session
  BEFORE INSERT ON memory_session_outcome_reports
  FOR EACH ROW EXECUTE FUNCTION memory_session_outcome_reports_validate_session();

-- Append-only trigger: prevents UPDATE or DELETE
CREATE FUNCTION memory_session_outcome_reports_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'memory_session_outcome_reports is append-only: % is not permitted', TG_OP;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER memory_session_outcome_reports_no_update
  BEFORE UPDATE OR DELETE ON memory_session_outcome_reports
  FOR EACH ROW EXECUTE FUNCTION memory_session_outcome_reports_append_only();
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
