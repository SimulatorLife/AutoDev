/** Private projection codecs; public artifact contracts remain Core-owned. */

import { createHash } from "node:crypto";

import {
  assertPlaytestAssignmentManifest,
  assertPlaytestBenchmark,
  assertPlaytestBranchLineage,
  assertPlaytestCoverageManifest,
  assertPlaytestExperiment,
  assertPlaytestNumericResults,
  assertPlaytestSessionReviewHasEvidence,
  type HumanPlaytestStudy,
  isPlaytestEvidencePacketId,
  isPlaytestFindingId,
  type PlaytestAssignmentManifest,
  playtestAssignmentManifestHashInput,
  type PlaytestBatch,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestComparison,
  playtestCoverageManifestHashInput,
  type PlaytestEpisode,
  type PlaytestEvidencePacketReference,
  type PlaytestExperiment,
  playtestExperimentHashInput,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestReviewPacketReceipt,
  type PlaytestReviewClaim,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2,
  PLAYTESTS_BATCH_CANCELLATION_REASONS,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V1,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V1,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS,
  PLAYTESTS_REVIEW_PACKET_FAILURE_REASONS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V2,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V3,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V1,
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
  readonly assignment_id: string | null;
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

export interface PlaytestIndexedFindingRow extends Record<string, unknown> {
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
  assertBatchAssignmentInventory(artifact);
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
  assertPlaytestNumericResults(artifact.metrics);
  if (artifact.branchLineage !== null) {
    assertPlaytestBranchLineage(artifact.branchLineage, artifact);
    if (
      artifact.branchLineage.parentEpisodeId === artifact.episodeId ||
      artifact.branchLineage.parentBatchId === artifact.batchId
    ) {
      throw new TypeError(
        "A branch episode cannot name its own episode or batch as the parent."
      );
    }
  }
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
    assignment_id: artifact.assignmentId,
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
  if (
    values.some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0)
    )
  ) {
    throw new TypeError(
      "PlaytestFinding frequency counts must be null or non-negative safe integers."
    );
  }
  if (
    (artifact.affectedEpisodes !== null &&
      artifact.totalEligibleEpisodes !== null &&
      artifact.affectedEpisodes > artifact.totalEligibleEpisodes) ||
    (artifact.affectedOpportunities !== null &&
      artifact.totalEligibleOpportunities !== null &&
      artifact.affectedOpportunities > artifact.totalEligibleOpportunities)
  ) {
    throw new TypeError(
      "PlaytestFinding affected counts cannot exceed eligible denominators."
    );
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

function assertEvidencePacketReference(
  value: unknown
): asserts value is PlaytestEvidencePacketReference | null {
  if (value === null) return;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !["packetId", "artifact"].includes(key)) ||
    !isPlaytestEvidencePacketId(value.packetId) ||
    !isRecord(value.artifact)
  ) {
    throw new TypeError("Review evidence packet reference is malformed.");
  }
  const reference = value.artifact;
  const allowedKeys = new Set([
    "artifactId",
    "sha256",
    "bytes",
    "mediaType",
    "revision"
  ]);
  if (
    Object.keys(reference).some((key) => !allowedKeys.has(key)) ||
    typeof reference.artifactId !== "string" ||
    reference.artifactId.trim().length === 0 ||
    reference.artifactId.length > MAX_ARTIFACT_REF_LENGTH ||
    typeof reference.sha256 !== "string" ||
    !SHA256_PATTERN.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    (reference.bytes as number) < 1 ||
    (reference.bytes as number) > MAX_PLAYTEST_PAYLOAD_BYTES ||
    reference.mediaType !== PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE ||
    (reference.revision !== undefined &&
      (!Number.isSafeInteger(reference.revision) ||
        (reference.revision as number) < 0))
  ) {
    throw new TypeError("Review evidence packet artifact metadata is invalid.");
  }
}

export function encodeReview(
  workspaceId: string,
  artifact: PlaytestSessionReview
): PlaytestIndexedReviewRow {
  if (
    artifact.schema !== PLAYTESTS_SESSION_REVIEW_SCHEMA ||
    artifact.provenance.workspaceId !== workspaceId ||
    artifact.evidencePacket === null
  ) {
    throw new TypeError(
      "New review writes require the current schema, workspace identity and frozen evidence packet."
    );
  }
  assertEvidencePacketReference(artifact.evidencePacket);
  assertPlaytestSessionReviewHasEvidence(artifact);
  assertPlaytestSessionReviewHasEvidence(artifact);
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

function assertBatchReviewPacketReceipts(input: {
  readonly packets: readonly PlaytestReviewPacketReceipt[];
  readonly assignments: ReadonlySet<string>;
  readonly selected: ReadonlyMap<string, string>;
  readonly reviewCap: number;
}): void {
  if (
    !Array.isArray(input.packets) ||
    input.packets.length > PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS ||
    input.packets.length > input.reviewCap
  ) {
    throw new TypeError(
      "Batch evidence packet receipts exceed the frozen review cap."
    );
  }
  const packetIds = new Set<string>();
  const assignmentIds = new Set<string>();
  for (const packet of input.packets) {
    if (
      !isPlaytestEvidencePacketId(packet.packetId) ||
      !input.assignments.has(packet.assignmentId) ||
      input.selected.get(packet.assignmentId) !== packet.episodeId ||
      typeof packet.createdAt !== "string" ||
      !Number.isFinite(Date.parse(packet.createdAt)) ||
      packetIds.has(packet.packetId) ||
      assignmentIds.has(packet.assignmentId) ||
      (packet.status !== "prepared" && packet.status !== "unavailable")
    ) {
      throw new TypeError("Batch evidence packet receipt identity is invalid.");
    }
    if (packet.status === "prepared") {
      if (packet.failureReason !== null) {
        throw new TypeError(
          "Prepared packet receipt cannot have a failure reason."
        );
      }
      assertEvidencePacketReference({
        packetId: packet.packetId,
        artifact: packet.artifact
      });
    } else if (
      packet.artifact !== null ||
      packet.failureReason === null ||
      !PLAYTESTS_REVIEW_PACKET_FAILURE_REASONS.includes(packet.failureReason)
    ) {
      throw new TypeError(
        "Unavailable packet receipt requires an explicit failure reason."
      );
    }
    packetIds.add(packet.packetId);
    assignmentIds.add(packet.assignmentId);
  }
}

function assertBatchLifecycle(artifact: PlaytestBatch): void {
  if (
    artifact.status === "cancelled"
      ? artifact.cancellationReason !== null &&
        !PLAYTESTS_BATCH_CANCELLATION_REASONS.includes(
          artifact.cancellationReason
        )
      : artifact.cancellationReason !== null
  ) {
    throw new TypeError(
      "Batch cancellation reason must be absent unless the batch is cancelled."
    );
  }
  if (
    artifact.failureReason !== null &&
    (artifact.status !== "failed" ||
      artifact.failureReason !== "nonterminal-batch-recovered")
  ) {
    throw new TypeError(
      "Batch failure reason is unsupported for this execution status."
    );
  }
}

function assertBatchReviewCounts(artifact: PlaytestBatch): void {
  const receipts = artifact.reviewReceipts;
  if (!Array.isArray(receipts)) {
    throw new TypeError("Batch review receipts must be an array.");
  }
  const persistedReceipts = receipts.filter(
    (receipt) => receipt.status === "persisted"
  );
  const assignmentIds = new Set(
    persistedReceipts.map((receipt) => receipt.assignmentId)
  );
  const reviewIds = new Set(receipts.map((receipt) => receipt.reviewId));
  if (
    receipts.some(
      (receipt) =>
        (receipt.status !== "reserved" && receipt.status !== "persisted") ||
        !receipt.reviewId.trim() ||
        !receipt.assignmentId.trim() ||
        !receipt.episodeId.trim()
    ) ||
    reviewIds.size !== receipts.length ||
    artifact.counts.reviewed !== assignmentIds.size ||
    artifact.budget.actualCritiques !== persistedReceipts.length
  ) {
    throw new TypeError(
      "Batch critique counts must match its persisted review receipts and reservation ledger."
    );
  }
}

function assertBatchUnobservedAssignments(
  artifact: PlaytestBatch,
  assignmentIds: ReadonlySet<string>
): void {
  const outcomes = artifact.unobservedAssignments;
  if (
    outcomes === null ||
    outcomes.length > assignmentIds.size ||
    new Set(outcomes.map((outcome) => outcome.assignmentId)).size !==
      outcomes.length ||
    outcomes.some(
      (outcome) =>
        !assignmentIds.has(outcome.assignmentId) ||
        outcome.episodeId !== null ||
        outcome.eligible ||
        (outcome.state !== "infrastructure-failed" &&
          outcome.state !== "cancelled")
    )
  ) {
    throw new TypeError(
      "Batch no-episode outcomes must be unique terminal assignments with explicit missing episode state."
    );
  }
}

function frozenBatchInventory(artifact: PlaytestBatch): {
  readonly manifest: PlaytestAssignmentManifest;
  readonly assignmentIds: ReadonlySet<string>;
} | null {
  if (artifact.assignmentInventory.status === "unavailable") {
    if (
      artifact.unobservedAssignments !== null ||
      artifact.assignmentInventory.reason !==
        "recorded-before-assignment-manifests"
    ) {
      throw new TypeError("Batch assignment inventory has an unknown reason.");
    }
    if (
      artifact.reviewReceipts.length > 0 ||
      artifact.reviewPackets.length > 0
    ) {
      throw new TypeError(
        "A batch without a recorded assignment manifest cannot carry review or packet receipts."
      );
    }
    return null;
  }
  const manifest = artifact.assignmentInventory.manifest;
  assertPlaytestAssignmentManifest(manifest);
  const assignmentIds = new Set(
    manifest.assignments.map((assignment) => assignment.assignmentId)
  );
  assertBatchUnobservedAssignments(artifact, assignmentIds);
  return { manifest, assignmentIds };
}

function selectedReviewsForBatch(
  artifact: PlaytestBatch
): ReadonlyMap<string, string> {
  return artifact.reviewSelection.status === "selected"
    ? new Map(
        artifact.reviewSelection.selected.map((selected) => [
          selected.assignmentId,
          selected.episodeId
        ])
      )
    : new Map<string, string>();
}

function assertCompletePacketInventory(
  artifact: PlaytestBatch,
  packetReceipts: readonly PlaytestReviewPacketReceipt[]
): void {
  if (artifact.reviewSelection.status !== "selected") {
    return;
  }
  const selected = artifact.reviewSelection.selected;
  if (
    packetReceipts.length !== selected.length ||
    selected.some(
      (session) =>
        !packetReceipts.some(
          (receipt) =>
            receipt.assignmentId === session.assignmentId &&
            receipt.episodeId === session.episodeId
        )
    )
  ) {
    throw new TypeError(
      "Batch evidence packet inventory must explicitly cover every selected review session."
    );
  }
}

function assertBatchManifestIdentity(
  artifact: PlaytestBatch,
  manifest: PlaytestAssignmentManifest,
  assignmentIds: ReadonlySet<string>,
  selectedReviews: ReadonlyMap<string, string>,
  packetReceipts: readonly PlaytestReviewPacketReceipt[]
): void {
  const receipts = artifact.reviewReceipts;
  if (
    manifest.batchId !== artifact.batchId ||
    manifest.workspaceId !== artifact.workspaceId ||
    manifest.buildSha !== artifact.buildSha ||
    manifest.configHash !== artifact.configHash ||
    manifest.rubricHash !== artifact.rubricHash ||
    manifest.assignments.length !== artifact.budget.assignedEpisodes ||
    receipts.some(
      (receipt) =>
        !assignmentIds.has(receipt.assignmentId) ||
        selectedReviews.get(receipt.assignmentId) !== receipt.episodeId ||
        (receipt.packetId !== null &&
          !packetReceipts.some(
            (packet) =>
              packet.status === "prepared" &&
              packet.packetId === receipt.packetId &&
              packet.assignmentId === receipt.assignmentId &&
              packet.episodeId === receipt.episodeId
          ))
    ) ||
    (artifact.reviewSelection.status === "selected" &&
      receipts.length > artifact.reviewSelection.reviewCap)
  ) {
    throw new TypeError(
      "Batch assignment manifest or review receipts do not match the persisted batch identity, selection, or count."
    );
  }
  const contentHash = createHash("sha256")
    .update(playtestAssignmentManifestHashInput(manifest))
    .digest("hex");
  if (contentHash !== manifest.contentHash.toLowerCase()) {
    throw new TypeError("Batch assignment manifest contentHash is invalid.");
  }
}

function assertBatchAssignmentInventory(artifact: PlaytestBatch): void {
  if (artifact.schema !== PLAYTESTS_BATCH_SCHEMA) {
    throw new TypeError("Batch artifact has an unsupported schema.");
  }
  if (artifact.coverageManifest !== null) {
    assertBatchCoverageManifest(artifact);
  }
  if (!Array.isArray(artifact.reviewPackets)) {
    throw new TypeError("Batch evidence packet receipts must be an array.");
  }
  assertBatchLifecycle(artifact);
  assertBatchReviewCounts(artifact);
  const inventory = frozenBatchInventory(artifact);
  if (inventory === null) return;

  const packetReceipts = artifact.reviewPackets;
  const selectedReviews = selectedReviewsForBatch(artifact);
  assertCompletePacketInventory(artifact, packetReceipts);
  assertBatchReviewPacketReceipts({
    packets: packetReceipts,
    assignments: inventory.assignmentIds,
    selected: selectedReviews,
    reviewCap:
      artifact.reviewSelection.status === "selected"
        ? artifact.reviewSelection.reviewCap
        : 0
  });
  assertBatchManifestIdentity(
    artifact,
    inventory.manifest,
    inventory.assignmentIds,
    selectedReviews,
    packetReceipts
  );
}

function assertBatchCoverageManifest(artifact: PlaytestBatch): void {
  const coverage = artifact.coverageManifest;
  if (coverage === null) return;
  assertPlaytestCoverageManifest(coverage);
  if (
    artifact.assignmentInventory.status !== "frozen" ||
    coverage.workspaceId !== artifact.workspaceId ||
    coverage.batchId !== artifact.batchId ||
    coverage.buildSha !== artifact.buildSha ||
    coverage.rubricHash !== artifact.rubricHash ||
    coverage.assignmentManifestHash !==
      artifact.assignmentInventory.manifest.contentHash ||
    coverage.assignedEpisodes !== artifact.budget.assignedEpisodes
  ) {
    throw new TypeError(
      "Batch coverage manifest does not match its frozen rubric and assignment identity."
    );
  }
  const { contentHash, ...draft } = coverage;
  const expectedHash = createHash("sha256")
    .update(playtestCoverageManifestHashInput(draft))
    .digest("hex");
  if (expectedHash !== contentHash.toLowerCase()) {
    throw new TypeError("Batch coverage manifest content hash is invalid.");
  }
}

/**
 * One-way migration for records persisted before batch assignment manifests
 * existed. Pre-change history stays honest inventory-unavailable history; no
 * assignment is fabricated from seed text.
 */
function migrateAssignmentManifest(
  value: Record<string, unknown>
): PlaytestAssignmentManifest {
  if (value.schema === PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA) {
    try {
      assertPlaytestAssignmentManifest(value);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v3 assignment manifest is malformed",
        error
      );
    }
    return value as unknown as PlaytestAssignmentManifest;
  }
  if (
    value.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1 &&
    value.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse frozen assignment inventory has an unsupported schema"
    );
  }
  const originalHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        value as unknown as Omit<PlaytestAssignmentManifest, "contentHash">
      )
    )
    .digest("hex");
  if (
    typeof value.contentHash !== "string" ||
    originalHash !== value.contentHash.toLowerCase()
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy assignment manifest has an invalid content hash"
    );
  }
  if (
    !Array.isArray(value.assignments) ||
    value.assignments.some(
      (assignment) => !isRecord(assignment) || assignment.cohort !== undefined
    )
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy assignment manifest has malformed coverage identity"
    );
  }
  const migrated = {
    ...value,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    assignments: value.assignments.map((assignment) => ({
      ...(assignment as Record<string, unknown>),
      cohort: null
    }))
  };
  const contentHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        migrated as unknown as Omit<PlaytestAssignmentManifest, "contentHash">
      )
    )
    .digest("hex");
  const result = { ...migrated, contentHash };
  try {
    assertPlaytestAssignmentManifest(result);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse migrated assignment manifest is malformed",
      error
    );
  }
  return result as unknown as PlaytestAssignmentManifest;
}

function migrateAssignmentInventory(
  value: unknown
): PlaytestBatch["assignmentInventory"] {
  if (value === undefined) {
    return {
      status: "unavailable",
      reason: "recorded-before-assignment-manifests"
    };
  }
  if (!isRecord(value)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse batch has a malformed assignment inventory"
    );
  }
  if (value.status === "unavailable") {
    if (value.reason !== "recorded-before-assignment-manifests") {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse batch has an unsupported unavailable assignment reason"
      );
    }
    return value as PlaytestBatch["assignmentInventory"];
  }
  if (value.status !== "frozen" || !isRecord(value.manifest)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse frozen assignment inventory has a malformed manifest"
    );
  }
  return {
    status: "frozen",
    manifest: migrateAssignmentManifest(value.manifest)
  };
}

/**
 * One-way migration for batch, assignment and coverage fields. Missing legacy
 * evidence stays unavailable; malformed frozen state never becomes history.
 */
function migrateBatchArtifact(
  artifact: Readonly<Record<string, unknown>>
): PlaytestBatch {
  const schema = artifact.schema;
  if (
    schema !== PLAYTESTS_BATCH_SCHEMA &&
    schema !== PLAYTESTS_BATCH_SCHEMA_V2 &&
    schema !== PLAYTESTS_BATCH_SCHEMA_V1
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an unsupported playtest batch schema"
    );
  }
  if (
    schema !== PLAYTESTS_BATCH_SCHEMA_V1 &&
    artifact.coverageManifest === undefined
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse batch is missing its coverage-manifest field"
    );
  }
  if (
    schema === PLAYTESTS_BATCH_SCHEMA &&
    (artifact.reviewPackets === undefined ||
      !Array.isArray(artifact.reviewReceipts))
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v3 batch is missing its packet or review receipt inventory"
    );
  }
  if (
    schema === PLAYTESTS_BATCH_SCHEMA_V2 &&
    !Array.isArray(artifact.reviewReceipts)
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v2 batch is missing its review receipt inventory"
    );
  }
  const assignmentInventory = migrateAssignmentInventory(
    artifact.assignmentInventory
  );
  const reviewSelection =
    artifact.reviewSelection === undefined
      ? {
          status: "unavailable" as const,
          reason: "recorded-before-review-selection" as const
        }
      : artifact.reviewSelection;
  const reviewReceipts = Array.isArray(artifact.reviewReceipts)
    ? schema === PLAYTESTS_BATCH_SCHEMA
      ? artifact.reviewReceipts
      : artifact.reviewReceipts.map((receipt) =>
          isRecord(receipt)
            ? {
                ...receipt,
                packetId: receipt.packetId ?? null,
                status: receipt.status ?? "persisted"
              }
            : receipt
        )
    : [];
  const reviewPackets =
    schema === PLAYTESTS_BATCH_SCHEMA && Array.isArray(artifact.reviewPackets)
      ? artifact.reviewPackets
      : migrateLegacyPacketReceipts({
          batchId: artifact.batchId,
          createdAt: artifact.createdAt,
          assignmentInventory,
          reviewSelection
        });
  const normalized: Record<string, unknown> = {
    ...artifact,
    schema: PLAYTESTS_BATCH_SCHEMA
  };
  delete normalized.samplingPlan;
  delete normalized.reviewedAssignmentIds;
  delete normalized.assignmentOutcomes;
  return {
    ...normalized,
    assignmentInventory,
    coverageManifest:
      schema === PLAYTESTS_BATCH_SCHEMA_V1
        ? null
        : (artifact.coverageManifest as PlaytestBatch["coverageManifest"]),
    reviewPackets,
    unobservedAssignments:
      artifact.unobservedAssignments === undefined
        ? null
        : artifact.unobservedAssignments,
    reviewSelection,
    reviewReceipts,
    cancellationReason: artifact.cancellationReason ?? null,
    failureReason: artifact.failureReason ?? null
  } as unknown as PlaytestBatch;
}

function migrateLegacyPacketReceipts(input: {
  readonly batchId: unknown;
  readonly createdAt: unknown;
  readonly assignmentInventory: PlaytestBatch["assignmentInventory"];
  readonly reviewSelection: unknown;
}): readonly PlaytestReviewPacketReceipt[] {
  const batchId = input.batchId;
  const createdAt = input.createdAt;
  if (
    !isRecord(input.reviewSelection) ||
    input.reviewSelection.status !== "selected"
  ) {
    return [];
  }
  if (
    input.assignmentInventory.status !== "frozen" ||
    typeof batchId !== "string" ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !Array.isArray(input.reviewSelection.selected)
  ) {
    throw new PlaytestSourceUnavailableError(
      "Legacy batch selection cannot be represented as explicit unavailable packet receipts."
    );
  }
  return input.reviewSelection.selected.map((selected) => {
    if (
      !isRecord(selected) ||
      typeof selected.assignmentId !== "string" ||
      selected.assignmentId.trim().length === 0 ||
      typeof selected.episodeId !== "string" ||
      selected.episodeId.trim().length === 0
    ) {
      throw new PlaytestSourceUnavailableError(
        "Legacy batch has a malformed selected review session."
      );
    }
    const packetId =
      "packet-legacy-" +
      createHash("sha256")
        .update(
          JSON.stringify([batchId, selected.assignmentId, selected.episodeId])
        )
        .digest("hex");
    return {
      status: "unavailable",
      packetId,
      assignmentId: selected.assignmentId,
      episodeId: selected.episodeId,
      artifact: null,
      failureReason: "recorded-before-evidence-packets",
      createdAt
    };
  });
}

/** One-way migration: pre-change episodes carry no batch-local assignment id. */
function migrateEpisodeArtifact(
  artifact: Readonly<Record<string, unknown>>
): PlaytestEpisode {
  if (
    artifact.schema !== PLAYTESTS_EPISODE_SCHEMA_V1 &&
    artifact.schema !== PLAYTESTS_EPISODE_SCHEMA_V2 &&
    artifact.schema !== PLAYTESTS_EPISODE_SCHEMA
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an unsupported playtest episode schema"
    );
  }
  if (artifact.schema === PLAYTESTS_EPISODE_SCHEMA_V1) {
    return {
      ...artifact,
      schema: PLAYTESTS_EPISODE_SCHEMA,
      assignmentId:
        typeof artifact.assignmentId === "string"
          ? artifact.assignmentId
          : null,
      branchLineage: null,
      metrics: Array.isArray(artifact.metrics)
        ? artifact.metrics.map((metric) =>
            isRecord(metric)
              ? { ...metric, phaseId: null, opportunityCount: null }
              : metric
          )
        : []
    } as unknown as PlaytestEpisode;
  }
  if (artifact.schema === PLAYTESTS_EPISODE_SCHEMA_V2) {
    if (
      typeof artifact.assignmentId !== "string" &&
      artifact.assignmentId !== null
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v2 episode is missing its batch assignment identity"
      );
    }
    if (artifact.branchLineage === undefined) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v2 episode is missing its branch-lineage field"
      );
    }
    return {
      ...artifact,
      schema: PLAYTESTS_EPISODE_SCHEMA,
      metrics: Array.isArray(artifact.metrics)
        ? artifact.metrics.map((metric) =>
            isRecord(metric) && metric.phaseId === undefined
              ? { ...metric, phaseId: null }
              : metric
          )
        : []
    } as unknown as PlaytestEpisode;
  }
  if (
    typeof artifact.assignmentId !== "string" &&
    artifact.assignmentId !== null
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v2 episode is missing its batch assignment identity"
    );
  }
  if (artifact.branchLineage === undefined) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v2 episode is missing its branch-lineage field"
    );
  }
  return artifact as unknown as PlaytestEpisode;
}

export function decodeBatch(row: Record<string, unknown>): PlaytestBatch {
  const payload = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "batchId",
    "revision"
  );
  const artifact = migrateBatchArtifact(payload);
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "batch_id", artifact.batchId);
  assertIndexMatches(row, "revision", artifact.revision);
  assertBatchAssignmentInventory(artifact);
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "build_sha", artifact.buildSha);
  return artifact;
}

export function decodeEpisode(row: Record<string, unknown>): PlaytestEpisode {
  const artifact = migrateEpisodeArtifact(
    decodePayload<Readonly<Record<string, unknown>>>(
      row,
      "episodeId",
      "revision"
    )
  );
  assertIndexMatches(row, "workspace_id", artifact.identity.workspaceId);
  assertIndexMatches(row, "batch_id", artifact.batchId);
  assertIndexMatches(row, "episode_id", artifact.episodeId);
  assertIndexMatches(row, "revision", artifact.revision);
  assertIndexMatches(row, "scenario", artifact.identity.scenarioId);
  assertIndexMatches(row, "policy", artifact.identity.policyId);
  if (row.assignment_id !== undefined && artifact.assignmentId !== null) {
    assertIndexMatches(row, "assignment_id", artifact.assignmentId);
  }
  assertIndexMatches(row, "cohort", artifact.policyCohort);
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "game_outcome", artifact.outcome);
  try {
    assertPlaytestNumericResults(artifact.metrics);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse episode contains invalid or duplicate metric results",
      error
    );
  }
  if (artifact.branchLineage !== null) {
    assertPlaytestBranchLineage(artifact.branchLineage, artifact);
    if (
      artifact.branchLineage.parentEpisodeId === artifact.episodeId ||
      artifact.branchLineage.parentBatchId === artifact.batchId
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse branch episode names itself as its parent episode or batch"
      );
    }
  }
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
  const raw = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "reviewId",
    "version"
  );
  let artifact: PlaytestSessionReview;
  if (
    raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V1 ||
    raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V2 ||
    raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V3
  ) {
    if (
      raw.schema !== PLAYTESTS_SESSION_REVIEW_SCHEMA_V1 &&
      raw.evidencePacket === undefined
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse legacy review is missing its evidence-packet field"
      );
    }
    if (raw.schema !== PLAYTESTS_SESSION_REVIEW_SCHEMA_V1) {
      try {
        assertEvidencePacketReference(raw.evidencePacket);
      } catch (error) {
        throw new PlaytestSourceUnavailableError(
          "ClickHouse legacy review has a malformed evidence-packet reference",
          error
        );
      }
    }
    artifact = {
      ...raw,
      schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
      evidencePacket:
        raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V1
          ? null
          : (raw.evidencePacket as PlaytestSessionReview["evidencePacket"]),
      observations: migrateLegacyReviewClaims(raw.observations, "observations"),
      interpretations: migrateLegacyReviewClaims(
        raw.interpretations,
        "interpretations"
      )
    } as unknown as PlaytestSessionReview;
  } else if (raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA) {
    if (raw.evidencePacket === undefined || raw.evidencePacket === null) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v4 playtest review is missing its evidence-packet reference"
      );
    }
    try {
      assertEvidencePacketReference(raw.evidencePacket);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse review has a malformed evidence-packet reference",
        error
      );
    }
    artifact = raw as unknown as PlaytestSessionReview;
    try {
      assertPlaytestSessionReviewHasEvidence(artifact);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse review has malformed per-claim citations",
        error
      );
    }
    try {
      assertPlaytestSessionReviewHasEvidence(artifact);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse review has missing or malformed claim citations",
        error
      );
    }
  } else {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an unsupported playtest review schema"
    );
  }
  assertIndexMatches(row, "workspace_id", artifact.provenance.workspaceId);
  assertIndexMatches(row, "episode_id", artifact.episodeId);
  assertIndexMatches(row, "review_id", artifact.reviewId);
  assertIndexMatches(row, "version", artifact.version);
  return artifact;
}

function migrateLegacyReviewClaims(
  value: unknown,
  field: "observations" | "interpretations"
): readonly PlaytestReviewClaim[] {
  if (
    !Array.isArray(value) ||
    value.some((claim) => typeof claim !== "string")
  ) {
    throw new PlaytestSourceUnavailableError(
      `ClickHouse legacy review has malformed ${field}.`
    );
  }
  return value.map((text) => ({
    text: text as string,
    // Historical strings did not bind citations per claim. Preserve them as
    // visibly unlinked legacy evidence rather than inventing references.
    evidenceRefs: []
  }));
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
