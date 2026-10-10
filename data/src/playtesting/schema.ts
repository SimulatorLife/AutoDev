/** Idempotent ClickHouse tables for Core-owned Playtesting artifacts. */

import { runParameterizedClickHouseStatement } from "../clickhouse/clickhouse-client.ts";
import { PlaytestSourceUnavailableError } from "./errors.ts";

export const PLAYTEST_DATA_SCHEMA_VERSION = 1 as const;
export const PLAYTEST_BATCHES_TABLE = "playtest_batches";
export const PLAYTEST_EPISODES_TABLE = "playtest_episodes";
export const PLAYTEST_FINDINGS_TABLE = "playtest_findings";
export const PLAYTEST_REVIEWS_TABLE = "playtest_reviews";
export const PLAYTEST_COMPARISONS_TABLE = "playtest_comparisons";
export const PLAYTEST_BENCHMARKS_TABLE = "playtest_benchmarks";
export const PLAYTEST_EXPERIMENTS_TABLE = "playtest_experiments";
export const PLAYTEST_HUMAN_STUDIES_TABLE = "playtest_human_studies";
export const PLAYTEST_HUMAN_SUMMARIES_TABLE = "playtest_human_summaries";

/* payload_json is the complete versioned Core artifact. The other columns are
 * bounded indexes only; traces and frames remain Runtime-owned artifacts. */
const CREATE_PLAYTEST_BATCHES = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_BATCHES_TABLE} (
  workspace_id String,
  batch_id String,
  revision UInt32,
  build_sha String,
  measurement_version String,
  status String,
  assigned UInt32,
  started UInt32,
  completed UInt32,
  crashed UInt32,
  infrastructure_failed UInt32,
  cancelled UInt32,
  budget_truncated UInt32,
  reviewed UInt32,
  eligible UInt32,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, batch_id, revision)
`;

const CREATE_PLAYTEST_EPISODES = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_EPISODES_TABLE} (
  workspace_id String,
  batch_id String,
  episode_id String,
  revision UInt32,
  scenario String,
  policy String,
  cohort String,
  seed String,
  status String,
  game_outcome String,
  build_sha String,
  assigned_at DateTime64(3),
  started_at Nullable(DateTime64(3)),
  completed_at Nullable(DateTime64(3)),
  step_count UInt32,
  trace_hash_manifest String,
  frame_manifest_ref Nullable(String),
  replay_status String,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, batch_id, episode_id, revision)
`;

const CREATE_PLAYTEST_FINDINGS = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_FINDINGS_TABLE} (
  workspace_id String,
  finding_id String,
  version UInt32,
  severity String,
  status String,
  verification_stage String,
  evidence_status String,
  affected_episodes UInt32,
  total_eligible_episodes UInt32,
  affected_opportunities UInt32,
  total_eligible_opportunities UInt32,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, finding_id, version)
`;

const CREATE_PLAYTEST_REVIEWS = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_REVIEWS_TABLE} (
  workspace_id String,
  episode_id String,
  review_id String,
  version UInt32,
  author_role String,
  rubric_hash String,
  measurement_version String,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, episode_id, review_id, version)
`;

const CREATE_PLAYTEST_COMPARISONS = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_COMPARISONS_TABLE} (
  workspace_id String,
  comparison_id String,
  version UInt32,
  benchmark_id String,
  experiment_id Nullable(String),
  baseline_id String,
  baseline_version String,
  candidate_id String,
  candidate_version String,
  measurement_version String,
  decision String,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, comparison_id, version)
`;

const CREATE_PLAYTEST_BENCHMARKS = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_BENCHMARKS_TABLE} (
  workspace_id String,
  benchmark_id String,
  version UInt32,
  reference_build_sha String,
  measurement_version String,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, benchmark_id, version)
`;

const CREATE_PLAYTEST_EXPERIMENTS = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_EXPERIMENTS_TABLE} (
  workspace_id String,
  experiment_id String,
  version UInt32,
  benchmark_id String,
  state String,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, experiment_id, version)
`;

const CREATE_PLAYTEST_HUMAN_STUDIES = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_HUMAN_STUDIES_TABLE} (
  workspace_id String,
  study_id String,
  version UInt32,
  benchmark_id String,
  instrument String,
  approved UInt8,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, study_id, version)
`;

const CREATE_PLAYTEST_HUMAN_SUMMARIES = `
CREATE TABLE IF NOT EXISTS ${PLAYTEST_HUMAN_SUMMARIES_TABLE} (
  workspace_id String,
  study_id String,
  revision UInt32,
  benchmark_id Nullable(String),
  build_sha Nullable(String),
  retained_participants UInt32,
  is_tombstone UInt8,
  created_at DateTime64(3),
  payload_json String
) ENGINE = MergeTree
ORDER BY (workspace_id, study_id, revision)
`;

export const PLAYTEST_SCHEMA_STATEMENTS: readonly string[] = [
  CREATE_PLAYTEST_BATCHES,
  CREATE_PLAYTEST_EPISODES,
  CREATE_PLAYTEST_FINDINGS,
  CREATE_PLAYTEST_REVIEWS,
  CREATE_PLAYTEST_COMPARISONS,
  CREATE_PLAYTEST_BENCHMARKS,
  CREATE_PLAYTEST_EXPERIMENTS,
  CREATE_PLAYTEST_HUMAN_STUDIES,
  CREATE_PLAYTEST_HUMAN_SUMMARIES
];

/** Idempotent DDL initialization; errors fail closed as typed unavailability. */
export async function ensurePlaytestSchema(
  endpoint: string,
  fetchImpl?: typeof fetch
): Promise<void> {
  await Promise.all(
    PLAYTEST_SCHEMA_STATEMENTS.map(async (statement) => {
      try {
        await runParameterizedClickHouseStatement(
          endpoint,
          statement,
          {},
          {
            ...(fetchImpl ? { fetchImpl } : {})
          }
        );
      } catch (error) {
        throw new PlaytestSourceUnavailableError(
          "failed to initialize Playtesting schema",
          error
        );
      }
    })
  );
}
