/** Private projection codecs; public artifact contracts remain Core-owned. */

import { createHash } from "node:crypto";

import {
  assertPlaytestBenchmark,
  assertPlaytestExperiment,
  isPlaytestFindingId,
  type HumanPlaytestStudy,
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestExperiment,
  type PlaytestFinding,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  playtestBenchmarkHashInput,
  playtestExperimentHashInput,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestSessionReview
} from "@simulatorlife/autodev-core";

import { PlaytestSourceUnavailableError } from "./errors.ts";
import type { PlaytestHumanAggregateRecord } from "./types.ts";

/** Keep indexed records bounded; bulk trace/frame bytes belong to Runtime artifacts. */
export const MAX_PLAYTEST_PAYLOAD_BYTES = 512 * 1024;
const MAX_ARTIFACT_REF_LENGTH = 512;

export interface PlaytestIndexedBatchRow {
  readonly workspace_id: string;
  readonly batch_id: string;
  readonly revision: number;
  readonly build_sha: string;
  readonly measurement_version: string;
  readonly status: string;
  readonly assigned: number;
  readonly started: number;
  readonly completed: number;
  readonly crashed: number;
  readonly infrastructure_failed: number;
  readonly cancelled: number;
  readonly budget_truncated: number;
  readonly reviewed: number;
  readonly eligible: number;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedEpisodeRow {
  readonly workspace_id: string;
  readonly batch_id: string;
  readonly episode_id: string;
  readonly revision: number;
  readonly scenario: string;
  readonly policy: string;
  readonly cohort: string;
  readonly seed: string;
  readonly status: string;
  readonly game_outcome: string;
  readonly build_sha: string;
  readonly assigned_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly step_count: number;
  readonly trace_hash_manifest: string;
  readonly frame_manifest_ref: string | null;
  readonly replay_status: string;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedFindingRow {
  readonly workspace_id: string;
  readonly finding_id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly severity: string;
  readonly status: string;
  readonly verification_stage: string;
  readonly evidence_status: string;
  readonly affected_episodes: number | null;
  readonly total_eligible_episodes: number | null;
  readonly affected_opportunities: number | null;
  readonly total_eligible_opportunities: number | null;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedReviewRow {
  readonly workspace_id: string;
  readonly episode_id: string;
  readonly review_id: string;
  readonly version: number;
  readonly author_role: string;
  readonly rubric_hash: string;
  readonly measurement_version: string;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedComparisonRow {
  readonly workspace_id: string;
  readonly comparison_id: string;
  readonly version: number;
  readonly benchmark_id: string;
  readonly experiment_id: string | null;
  readonly baseline_id: string;
  readonly baseline_version: string;
  readonly candidate_id: string;
  readonly candidate_version: string;
  readonly measurement_version: string;
  readonly decision: string;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedBenchmarkRow {
  readonly workspace_id: string;
  readonly benchmark_id: string;
  readonly version: number;
  readonly reference_build_sha: string;
  readonly measurement_version: string;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedExperimentRow {
  readonly workspace_id: string;
  readonly experiment_id: string;
  readonly version: number;
  readonly benchmark_id: string;
  readonly state: string;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedHumanStudyRow {
  readonly workspace_id: string;
  readonly study_id: string;
  readonly version: number;
  readonly benchmark_id: string;
  readonly instrument: string;
  readonly approved: number;
  readonly created_at: string;
  readonly payload_json: string;
}

export interface PlaytestIndexedHumanSummaryRow {
  readonly workspace_id: string;
  readonly study_id: string;
  readonly revision: number;
  readonly benchmark_id: string | null;
  readonly build_sha: string | null;
  readonly retained_participants: number;
  readonly is_tombstone: number;
  readonly created_at: string;
  readonly payload_json: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadJson(artifact: object): string {
  const payload = JSON.stringify(artifact);
  if (Buffer.byteLength(payload, "utf8") > MAX_PLAYTEST_PAYLOAD_BYTES) {
    throw new RangeError(
      `Playtesting payload exceeds the ${MAX_PLAYTEST_PAYLOAD_BYTES}-byte indexed artifact limit; store bulk evidence in Runtime artifacts.`
    );
  }
  return payload;
}

function requiredRef(value: string, field: string): string {
  if (value.length === 0 || value.length > MAX_ARTIFACT_REF_LENGTH) {
    throw new TypeError(`${field} must be a non-empty bounded identifier`);
  }
  return value;
}

function toClickHouseDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()))
    throw new TypeError("Invalid ISO timestamp");
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function nullableDateTime(iso: string | null): string | null {
  return iso === null ? null : toClickHouseDateTime(iso);
}

function numericCounts(
  counts: PlaytestBatch["counts"]
): Pick<
  PlaytestIndexedBatchRow,
  | "assigned"
  | "started"
  | "completed"
  | "crashed"
  | "infrastructure_failed"
  | "cancelled"
  | "budget_truncated"
  | "reviewed"
  | "eligible"
> {
  return {
    assigned: counts.assigned,
    started: counts.started,
    completed: counts.completed,
    crashed: counts.crashed,
    infrastructure_failed: counts.infrastructureFailed,
    cancelled: counts.cancelled,
    budget_truncated: counts.budgetTruncated,
    reviewed: counts.reviewed,
    eligible: counts.eligible
  };
}

export function encodeBatch(artifact: PlaytestBatch): PlaytestIndexedBatchRow {
  return {
    workspace_id: requiredRef(artifact.workspaceId, "workspaceId"),
    batch_id: requiredRef(artifact.batchId, "batchId"),
    revision: artifact.revision,
    build_sha: artifact.buildSha,
    measurement_version: artifact.measurementVersion,
    status: artifact.status,
    ...numericCounts(artifact.counts),
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeEpisode(
  artifact: PlaytestEpisode
): PlaytestIndexedEpisodeRow {
  const traceRef = artifact.trace?.id ?? "";
  if (traceRef.length > MAX_ARTIFACT_REF_LENGTH) {
    throw new TypeError(
      "Episode trace reference exceeds the bounded identifier limit"
    );
  }
  const frameRef = artifact.frames[0]?.id ?? null;
  if (frameRef !== null && frameRef.length > MAX_ARTIFACT_REF_LENGTH) {
    throw new TypeError(
      "Episode frame reference exceeds the bounded identifier limit"
    );
  }
  return {
    workspace_id: requiredRef(artifact.identity.workspaceId, "workspaceId"),
    batch_id: requiredRef(artifact.batchId, "batchId"),
    episode_id: requiredRef(artifact.episodeId, "episodeId"),
    revision: artifact.revision,
    scenario: artifact.identity.scenarioId,
    policy: artifact.identity.policyId,
    cohort: artifact.policyCohort,
    seed: artifact.identity.seed,
    status: artifact.status,
    game_outcome: artifact.outcome,
    build_sha: artifact.identity.buildSha,
    assigned_at: toClickHouseDateTime(artifact.assignedAt),
    started_at: nullableDateTime(artifact.startedAt),
    completed_at: nullableDateTime(artifact.completedAt),
    step_count: artifact.stepCount,
    trace_hash_manifest: traceRef,
    frame_manifest_ref: frameRef,
    replay_status: artifact.replayStatus,
    created_at: toClickHouseDateTime(artifact.assignedAt),
    payload_json: payloadJson(artifact)
  };
}

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

/**
 * Recompute the SHA-256 fingerprint Runtime promises to set on every
 * persisted finding. Data enforces it on the way in and on the way out so
 * a tampered payload, a stale import, or a row produced by a buggy
 * writer cannot reach a reader claiming a fingerprint Runtime never agreed
 * to.
 */
function assertFindingFingerprint(artifact: PlaytestFinding): string {
  const expected = createHash("sha256")
    .update(playtestFindingIdentityHashInput(artifact.identity))
    .digest("hex");
  if (!SHA256_PATTERN.test(artifact.fingerprint)) {
    throw new TypeError(
      "PlaytestFinding.fingerprint must be a SHA-256 hexadecimal digest."
    );
  }
  if (artifact.fingerprint !== expected) {
    throw new TypeError(
      "PlaytestFinding.fingerprint does not match SHA-256(canonical identity)."
    );
  }
  return expected;
}

/** Validate optional finding counts without treating unknown as zero. */
function assertFindingFrequency(artifact: PlaytestFinding): void {
  const values = [
    artifact.affectedEpisodes,
    artifact.totalEligibleEpisodes,
    artifact.affectedOpportunities,
    artifact.totalEligibleOpportunities
  ];
  if (values.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
    throw new TypeError("PlaytestFinding frequency counts must be null or non-negative safe integers.");
  }
  if (
    (artifact.affectedEpisodes !== null &&
      artifact.totalEligibleEpisodes !== null &&
      artifact.affectedEpisodes > artifact.totalEligibleEpisodes) ||
    (artifact.affectedOpportunities !== null &&
      artifact.totalEligibleOpportunities !== null &&
      artifact.affectedOpportunities > artifact.totalEligibleOpportunities)
  ) {
    throw new TypeError("PlaytestFinding affected counts cannot exceed eligible denominators.");
  }
}

/** Verify a finding's stable id is derivable from its full fingerprint. */
function assertStableFindingId(artifact: PlaytestFinding): void {
  const expected = playtestFindingIdFromFingerprint(artifact.fingerprint);
  if (artifact.findingId !== expected) {
    throw new TypeError(
      `PlaytestFinding.findingId must be the canonical full-fingerprint ID; expected "${expected}".`
    );
  }
}

export function encodeFinding(
  workspaceId: string,
  artifact: PlaytestFinding
): PlaytestIndexedFindingRow {
  if (workspaceId !== artifact.identity.workspaceId) {
    throw new TypeError(
      "PlaytestFinding identity workspaceId must match its indexed workspace."
    );
  }
  const fingerprint = assertFindingFingerprint(artifact);
  assertStableFindingId(artifact);
  assertFindingFrequency(artifact);
  if (artifact.version < 1 || !Number.isSafeInteger(artifact.version)) {
    throw new TypeError(
      "PlaytestFinding.version must be a positive safe integer (append-only)."
    );
  }
  return {
    workspace_id: requiredRef(workspaceId, "workspaceId"),
    finding_id: requiredRef(artifact.findingId, "findingId"),
    version: artifact.version,
    fingerprint,
    severity: artifact.severity,
    status: artifact.status,
    verification_stage: artifact.verificationStage,
    evidence_status: artifact.evidenceStatus,
    affected_episodes: artifact.affectedEpisodes,
    total_eligible_episodes: artifact.totalEligibleEpisodes,
    affected_opportunities: artifact.affectedOpportunities,
    total_eligible_opportunities: artifact.totalEligibleOpportunities,
    created_at: toClickHouseDateTime(new Date().toISOString()),
    payload_json: payloadJson(artifact)
  };
}

export function encodeReview(
  workspaceId: string,
  artifact: PlaytestSessionReview
): PlaytestIndexedReviewRow {
  return {
    workspace_id: requiredRef(workspaceId, "workspaceId"),
    episode_id: requiredRef(artifact.episodeId, "episodeId"),
    review_id: requiredRef(artifact.reviewId, "reviewId"),
    version: artifact.version,
    author_role: artifact.authorRole,
    rubric_hash: artifact.rubricHash,
    measurement_version: artifact.measurementVersion,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeComparison(
  artifact: PlaytestComparison
): PlaytestIndexedComparisonRow {
  if (!artifact.sourceFindingIds.every(isPlaytestFindingId)) {
    throw new TypeError(
      "PlaytestComparison.sourceFindingIds must contain canonical stable finding IDs."
    );
  }
  return {
    workspace_id: requiredRef(artifact.provenance.workspaceId, "workspaceId"),
    comparison_id: requiredRef(artifact.comparisonId, "comparisonId"),
    version: artifact.version,
    benchmark_id: artifact.benchmarkId,
    experiment_id: artifact.experimentId,
    baseline_id: artifact.baseline.id,
    baseline_version: String(artifact.baseline.version),
    candidate_id: artifact.candidate.id,
    candidate_version: String(artifact.candidate.version),
    measurement_version: artifact.measurementVersion,
    decision: artifact.decision,
    created_at: toClickHouseDateTime(artifact.provenance.generatedAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeBenchmark(
  artifact: PlaytestBenchmark
): PlaytestIndexedBenchmarkRow {
  assertPlaytestBenchmark(artifact);
  assertBenchmarkContentHash(artifact);
  return {
    workspace_id: requiredRef(artifact.workspaceId, "workspaceId"),
    benchmark_id: requiredRef(artifact.benchmarkId, "benchmarkId"),
    version: artifact.version,
    reference_build_sha: artifact.referenceBuildSha,
    measurement_version: artifact.measurementVersion,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeExperiment(
  artifact: PlaytestExperiment
): PlaytestIndexedExperimentRow {
  assertPlaytestExperiment(artifact);
  assertExperimentContentHash(artifact);
  return {
    workspace_id: requiredRef(artifact.workspaceId, "workspaceId"),
    experiment_id: requiredRef(artifact.experimentId, "experimentId"),
    version: artifact.version,
    benchmark_id: artifact.benchmarkId,
    state: artifact.state,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeHumanStudy(
  artifact: HumanPlaytestStudy
): PlaytestIndexedHumanStudyRow {
  return {
    workspace_id: requiredRef(artifact.workspaceId, "workspaceId"),
    study_id: requiredRef(artifact.studyId, "studyId"),
    version: artifact.version,
    benchmark_id: artifact.benchmarkId,
    instrument: artifact.instrument,
    approved: artifact.approved ? 1 : 0,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeHumanSummary(
  artifact: PlaytestHumanAggregateRecord
): PlaytestIndexedHumanSummaryRow {
  // Enforce privacy: never allow raw participant responses, participant IDs, or free text in Data
  for (const key of Object.keys(artifact)) {
    if (
      key === "participantId" ||
      key === "pseudonymousParticipantId" ||
      key === "freeText" ||
      key === "text" ||
      key === "responseId"
    ) {
      throw new TypeError(
        `Participant-identifying or raw response field "${key}" is prohibited in Playtesting Data persistence.`
      );
    }
  }
  for (const item of artifact.items) {
    if (
      "participantId" in item ||
      "responseId" in item ||
      "freeText" in item ||
      "text" in item
    ) {
      throw new TypeError(
        "Raw participant or response fields are prohibited in human item summaries."
      );
    }
  }

  return {
    workspace_id: requiredRef(artifact.workspaceId, "workspaceId"),
    study_id: requiredRef(artifact.studyId, "studyId"),
    revision: artifact.revision,
    benchmark_id: artifact.benchmarkId ?? null,
    build_sha: artifact.buildSha ?? null,
    retained_participants: Math.max(0, artifact.retainedParticipants),
    is_tombstone: artifact.isTombstone ? 1 : 0,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

function decodePayload<T>(
  row: Record<string, unknown>,
  idKey: string,
  versionKey: string,
  schema?: string
): T {
  if (
    typeof row.payload_json !== "string" ||
    Buffer.byteLength(row.payload_json, "utf8") > MAX_PLAYTEST_PAYLOAD_BYTES
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned a missing or oversized canonical payload"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned malformed canonical payload JSON",
      error
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed[idKey] !== "string" ||
    typeof parsed[versionKey] !== "number"
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse canonical payload is missing its identity/version"
    );
  }
  if (schema !== undefined && parsed.schema !== schema) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse canonical payload has an unsupported schema version"
    );
  }
  return parsed as T;
}

function assertIndexMatches(
  row: Record<string, unknown>,
  column: string,
  expected: string | number
): void {
  if (String(row[column]) !== String(expected)) {
    throw new PlaytestSourceUnavailableError(
      `ClickHouse index column ${column} disagrees with its canonical payload`
    );
  }
}

function assertBenchmarkContentHash(artifact: PlaytestBenchmark): void {
  const contentHash = createHash("sha256")
    .update(playtestBenchmarkHashInput(artifact))
    .digest("hex");
  if (contentHash !== artifact.contentHash.toLowerCase()) {
    throw new TypeError(
      "Benchmark contentHash does not match its canonical manifest."
    );
  }
}

function assertExperimentContentHash(artifact: PlaytestExperiment): void {
  const contentHash = createHash("sha256")
    .update(playtestExperimentHashInput(artifact))
    .digest("hex");
  if (contentHash !== artifact.contentHash.toLowerCase()) {
    throw new TypeError(
      "Experiment contentHash does not match its frozen manifest."
    );
  }
}

export function decodeBatch(row: Record<string, unknown>): PlaytestBatch {
  const artifact = decodePayload<PlaytestBatch>(
    row,
    "batchId",
    "revision",
    PLAYTESTS_BATCH_SCHEMA
  );
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "batch_id", artifact.batchId);
  assertIndexMatches(row, "revision", artifact.revision);
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "build_sha", artifact.buildSha);
  return artifact;
}

export function decodeEpisode(row: Record<string, unknown>): PlaytestEpisode {
  const artifact = decodePayload<PlaytestEpisode>(
    row,
    "episodeId",
    "revision",
    PLAYTESTS_EPISODE_SCHEMA
  );
  assertIndexMatches(row, "workspace_id", artifact.identity.workspaceId);
  assertIndexMatches(row, "batch_id", artifact.batchId);
  assertIndexMatches(row, "episode_id", artifact.episodeId);
  assertIndexMatches(row, "revision", artifact.revision);
  assertIndexMatches(row, "scenario", artifact.identity.scenarioId);
  assertIndexMatches(row, "policy", artifact.identity.policyId);
  assertIndexMatches(row, "cohort", artifact.policyCohort);
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "game_outcome", artifact.outcome);
  return artifact;
}

export function decodeFinding(row: Record<string, unknown>): PlaytestFinding {
  const artifact = decodePayload<PlaytestFinding>(row, "findingId", "version");
  if (
    artifact.identity === null ||
    typeof artifact.identity !== "object" ||
    typeof artifact.identity.workspaceId !== "string"
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse finding payload is missing its stable identity"
    );
  }
  assertIndexMatches(row, "workspace_id", artifact.identity.workspaceId);
  assertIndexMatches(row, "finding_id", artifact.findingId);
  assertIndexMatches(row, "version", artifact.version);
  assertIndexMatches(row, "severity", artifact.severity);
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "verification_stage", artifact.verificationStage);
  assertIndexMatches(row, "evidence_status", artifact.evidenceStatus);
  // Fingerprint is a server-derived invariant; reject rows where the
  // indexed fingerprint disagrees with either the payload's claim or the
  // SHA-256 of the canonical identity payload.
  if (typeof row.fingerprint !== "string") {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse finding row is missing its indexed fingerprint column"
    );
  }
  if (!SHA256_PATTERN.test(row.fingerprint)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse finding fingerprint index column is not a SHA-256 hexadecimal digest"
    );
  }
  const expectedFingerprint = assertFindingFingerprint(artifact);
  if (String(row.fingerprint).toLowerCase() !== expectedFingerprint) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse finding fingerprint index column disagrees with SHA-256(canonical identity)"
    );
  }
  assertStableFindingId(artifact);
  assertFindingFrequency(artifact);
  return artifact;
}

export function decodeReview(
  row: Record<string, unknown>
): PlaytestSessionReview {
  const artifact = decodePayload<PlaytestSessionReview>(
    row,
    "reviewId",
    "version",
    PLAYTESTS_SESSION_REVIEW_SCHEMA
  );
  assertIndexMatches(row, "workspace_id", artifact.provenance.workspaceId);
  assertIndexMatches(row, "episode_id", artifact.episodeId);
  assertIndexMatches(row, "review_id", artifact.reviewId);
  assertIndexMatches(row, "version", artifact.version);
  return artifact;
}

export function decodeComparison(
  row: Record<string, unknown>
): PlaytestComparison {
  const artifact = decodePayload<PlaytestComparison>(
    row,
    "comparisonId",
    "version",
    PLAYTESTS_COMPARISON_SCHEMA
  );
  assertIndexMatches(row, "workspace_id", artifact.provenance.workspaceId);
  assertIndexMatches(row, "comparison_id", artifact.comparisonId);
  assertIndexMatches(row, "version", artifact.version);
  assertIndexMatches(row, "benchmark_id", artifact.benchmarkId);
  if (
    !Array.isArray(artifact.sourceFindingIds) ||
    !artifact.sourceFindingIds.every(isPlaytestFindingId)
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse comparison payload contains a noncanonical source finding ID"
    );
  }
  return artifact;
}

export function decodeBenchmark(
  row: Record<string, unknown>
): PlaytestBenchmark {
  const artifact = decodePayload<PlaytestBenchmark>(
    row,
    "benchmarkId",
    "version"
  );
  assertPlaytestBenchmark(artifact);
  assertBenchmarkContentHash(artifact);
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "benchmark_id", artifact.benchmarkId);
  assertIndexMatches(row, "version", artifact.version);
  assertIndexMatches(row, "reference_build_sha", artifact.referenceBuildSha);
  return artifact;
}

export function decodeExperiment(
  row: Record<string, unknown>
): PlaytestExperiment {
  const artifact = decodePayload<PlaytestExperiment>(
    row,
    "experimentId",
    "version",
    PLAYTESTS_EXPERIMENT_SCHEMA
  );
  assertPlaytestExperiment(artifact);
  assertExperimentContentHash(artifact);
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "experiment_id", artifact.experimentId);
  assertIndexMatches(row, "version", artifact.version);
  assertIndexMatches(row, "benchmark_id", artifact.benchmarkId);
  assertIndexMatches(row, "state", artifact.state);
  return artifact;
}

export function decodeHumanStudy(
  row: Record<string, unknown>
): HumanPlaytestStudy {
  const artifact = decodePayload<HumanPlaytestStudy>(
    row,
    "studyId",
    "version",
    PLAYTESTS_HUMAN_STUDY_SCHEMA
  );
  if (
    !Array.isArray(artifact.allowedBuilds) ||
    artifact.allowedBuilds.length === 0 ||
    (artifact.instrument === "PXI"
      ? typeof artifact.pxiItemConstructMappingHash !== "string"
      : artifact.pxiItemConstructMappingHash !== null)
  ) {
    throw new TypeError(
      "Human-study build or instrument-mapping provenance is invalid."
    );
  }
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "study_id", artifact.studyId);
  assertIndexMatches(row, "version", artifact.version);
  assertIndexMatches(row, "benchmark_id", artifact.benchmarkId);
  assertIndexMatches(row, "instrument", artifact.instrument);
  return artifact;
}

export function decodeHumanSummary(
  row: Record<string, unknown>
): PlaytestHumanAggregateRecord {
  const artifact = decodePayload<PlaytestHumanAggregateRecord>(
    row,
    "studyId",
    "revision"
  );
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "study_id", artifact.studyId);
  assertIndexMatches(row, "revision", artifact.revision);
  return artifact;
}
