/**
 * Fixed-fragment WHERE-clause builders for the Playtesting repository.
 *
 * Every fragment here is a constant string keyed to one named filter; the
 * only thing that varies per call is the *value* bound through
 * runParameterizedClickHouseStatement's params, never the SQL text itself.
 * A caller cannot inject a new column or operator -- only choose which of
 * these fixed, pre-written clauses to include.
 */

import type { ClickHouseParamValue } from "../clickhouse/clickhouse-client.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

import type { PlaytestKeysetCursor } from "./cursor.ts";
import type {
  PlaytestBatchFilter,
  PlaytestBenchmarkFilter,
  PlaytestComparisonFilter,
  PlaytestEpisodeFilter,
  PlaytestExperimentFilter,
  PlaytestFindingFilter,
  PlaytestHumanStudyFilter
} from "./types.ts";

export interface BoundWhereClause {
  readonly clauses: readonly string[];
  readonly params: Record<string, ClickHouseParamValue>;
}

/** workspace_id is required on every query; never optional. */
function requireWorkspace(workspaceId: string): BoundWhereClause {
  if (workspaceId.trim().length === 0) {
    throw new TypeError("workspaceId is required for every Playtesting query");
  }
  return {
    clauses: ["workspace_id = {workspaceId:String}"],
    params: { workspaceId }
  };
}

export function buildEpisodeWhereClause(
  filter: PlaytestEpisodeFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.batchId !== undefined) {
    clauses.push("batch_id = {batchId:String}");
    params.batchId = filter.batchId;
  }
  if (filter.buildSha !== undefined) {
    clauses.push("build_sha = {buildSha:String}");
    params.buildSha = filter.buildSha;
  }
  if (filter.scenario !== undefined) {
    clauses.push("scenario = {scenario:String}");
    params.scenario = filter.scenario;
  }
  if (filter.policy !== undefined) {
    clauses.push("policy = {policy:String}");
    params.policy = filter.policy;
  }
  if (filter.cohort !== undefined) {
    clauses.push("cohort = {cohort:String}");
    params.cohort = filter.cohort;
  }
  if (filter.status !== undefined) {
    clauses.push("status = {status:String}");
    params.status = filter.status;
  }
  if (filter.gameOutcome !== undefined) {
    clauses.push("game_outcome = {gameOutcome:String}");
    params.gameOutcome = filter.gameOutcome;
  }
  if (filter.reviewStatus !== undefined) {
    clauses.push(
      filter.reviewStatus === "reviewed"
        ? "episode_id IN (SELECT episode_id FROM playtest_reviews WHERE workspace_id = {workspaceId:String})"
        : "episode_id NOT IN (SELECT episode_id FROM playtest_reviews WHERE workspace_id = {workspaceId:String})"
    );
  }
  if (filter.startedAtFrom !== undefined) {
    clauses.push("started_at >= {startedAtFrom:DateTime64(3)}");
    params.startedAtFrom = filter.startedAtFrom;
  }
  if (filter.startedAtTo !== undefined) {
    clauses.push("started_at <= {startedAtTo:DateTime64(3)}");
    params.startedAtTo = filter.startedAtTo;
  }
  return { clauses, params };
}

export function buildFindingWhereClause(
  filter: PlaytestFindingFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.fingerprint !== undefined) {
    if (
      typeof filter.fingerprint !== "string" ||
      !SHA256_PATTERN.test(filter.fingerprint)
    ) {
      throw new TypeError(
        "PlaytestFindingFilter.fingerprint must be a SHA-256 hexadecimal digest."
      );
    }
    clauses.push("fingerprint = {fingerprint:String}");
    params.fingerprint = filter.fingerprint;
  }
  if (filter.severity !== undefined) {
    clauses.push("severity = {severity:String}");
    params.severity = filter.severity;
  }
  if (filter.status !== undefined) {
    clauses.push("status = {status:String}");
    params.status = filter.status;
  }
  if (filter.verificationStage !== undefined) {
    clauses.push("verification_stage = {verificationStage:String}");
    params.verificationStage = filter.verificationStage;
  }
  if (filter.evidenceStatus !== undefined) {
    clauses.push("evidence_status = {evidenceStatus:String}");
    params.evidenceStatus = filter.evidenceStatus;
  }
  return { clauses, params };
}

export function buildBatchWhereClause(
  filter: PlaytestBatchFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.buildSha !== undefined) {
    clauses.push("build_sha = {buildSha:String}");
    params.buildSha = filter.buildSha;
  }
  if (filter.status !== undefined) {
    clauses.push("status = {status:String}");
    params.status = filter.status;
  }
  return { clauses, params };
}

export function buildComparisonWhereClause(
  filter: PlaytestComparisonFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.benchmarkId !== undefined) {
    clauses.push("benchmark_id = {benchmarkId:String}");
    params.benchmarkId = filter.benchmarkId;
  }
  if (filter.experimentId !== undefined) {
    clauses.push("experiment_id = {experimentId:String}");
    params.experimentId = filter.experimentId;
  }
  if (filter.decision !== undefined) {
    clauses.push("decision = {decision:String}");
    params.decision = filter.decision;
  }
  return { clauses, params };
}

export function buildBenchmarkWhereClause(
  filter: PlaytestBenchmarkFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.referenceBuildSha !== undefined) {
    clauses.push("reference_build_sha = {referenceBuildSha:String}");
    params.referenceBuildSha = filter.referenceBuildSha;
  }
  if (filter.measurementVersion !== undefined) {
    clauses.push("measurement_version = {measurementVersion:String}");
    params.measurementVersion = filter.measurementVersion;
  }
  return { clauses, params };
}

export function buildExperimentWhereClause(
  filter: PlaytestExperimentFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.benchmarkId !== undefined) {
    clauses.push("benchmark_id = {benchmarkId:String}");
    params.benchmarkId = filter.benchmarkId;
  }
  if (filter.state !== undefined) {
    clauses.push("state = {state:String}");
    params.state = filter.state;
  }
  return { clauses, params };
}

export function buildHumanStudyWhereClause(
  filter: PlaytestHumanStudyFilter
): BoundWhereClause {
  const base = requireWorkspace(filter.workspaceId);
  const clauses = [...base.clauses];
  const params: Record<string, ClickHouseParamValue> = { ...base.params };

  if (filter.benchmarkId !== undefined) {
    clauses.push("benchmark_id = {benchmarkId:String}");
    params.benchmarkId = filter.benchmarkId;
  }
  if (filter.instrument !== undefined) {
    clauses.push("instrument = {instrument:String}");
    params.instrument = filter.instrument;
  }
  if (filter.approved !== undefined) {
    clauses.push("approved = {approved:UInt8}");
    params.approved = filter.approved ? 1 : 0;
  }
  return { clauses, params };
}

/**
 * Append the fixed keyset-pagination clause for "rows ordered by
 * (orderedAt DESC, id DESC), strictly before this cursor".
 */
export function appendCursorClause(
  base: BoundWhereClause,
  cursor: PlaytestKeysetCursor | null,
  orderedAtColumn: string,
  idColumn: string
): BoundWhereClause {
  if (cursor === null) return base;
  const fragment =
    "(" +
    orderedAtColumn +
    " < {cursorOrderedAt:DateTime64(3)} OR (" +
    orderedAtColumn +
    " = {cursorOrderedAt:DateTime64(3)} AND " +
    idColumn +
    " < {cursorTiebreakId:String}))";
  return {
    clauses: [...base.clauses, fragment],
    params: {
      ...base.params,
      cursorOrderedAt: cursor.orderedAt,
      cursorTiebreakId: cursor.tiebreakId
    }
  };
}

export function joinWhereClauses(clause: BoundWhereClause): string {
  return clause.clauses.join(" AND ");
}
