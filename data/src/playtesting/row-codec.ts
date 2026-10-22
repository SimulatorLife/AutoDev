/** Private projection codecs; public artifact contracts remain Core-owned. */

import { createHash } from "node:crypto";

import {
  assertPlaytestAssignmentManifest,
  assertPlaytestBenchmark,
  assertPlaytestBranchLineage,
  assertPlaytestComparisonOwnerDecision,
  assertPlaytestCoverageManifest,
  assertPlaytestCrossSessionSynthesis,
  assertPlaytestDiscoverySessionReview,
  assertPlaytestEpisodeIdentityForMode,
  assertPlaytestEpisodeModeFacts,
  assertPlaytestEvidenceLocator,
  assertPlaytestExecutionProvenance,
  assertPlaytestExperiment,
  assertPlaytestNumericResults,
  assertPlaytestSessionReviewHasEvidence,
  type HumanPlaytestStudy,
  isPlaytestEvidencePacketId,
  isPlaytestFindingId,
  legacyPlaytestExecutionProvenance,
  migratePlaytestCrossSessionSynthesisV1,
  PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
  PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
  type PlaytestAdapterAssignmentManifest,
  type PlaytestAdapterBatch,
  type PlaytestAssignmentManifest,
  type PlaytestAssignmentManifestDraft,
  playtestAssignmentManifestHashInput,
  type PlaytestBatch,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestComparison,
  type PlaytestComparisonV1,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  type PlaytestCrossSessionSynthesis,
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  type PlaytestEvidenceLocator,
  type PlaytestEvidencePacketReference,
  type PlaytestExperiment,
  playtestExperimentHashInput,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestReviewClaim,
  type PlaytestReviewPacketReceipt,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V3,
  PLAYTESTS_BATCH_CANCELLATION_REASONS,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V1,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA_V1,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V1,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_SCHEMA_V7,
  PLAYTESTS_EPISODE_TERMINATION_REASONS,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS,
  PLAYTESTS_REVIEW_PACKET_FAILURE_REASONS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V1,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V2,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V3,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V4,
  PLAYTESTS_SESSION_REVIEW_SCHEMA_V5,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestSessionReview,
  type PlaytestVisualBatch
} from "@simulatorlife/autodev-core";

import { PlaytestSourceUnavailableError } from "./errors.ts";
import type {
  PlaytestHumanAggregateRecord,
  PlaytestReviewClaimSummary,
  PlaytestReviewFindingSummary,
  PlaytestReviewSummary
} from "./types.ts";

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

export interface PlaytestIndexedCrossSessionSynthesisRow {
  readonly workspace_id: string;
  readonly synthesis_id: string;
  readonly analysis_id: string;
  readonly version: number;
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

export function toClickHouseDateTime(iso: string): string {
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
    build_sha: artifact.buildSha ?? "",
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
  assertPlaytestExecutionProvenance(artifact.executionProvenance);
  assertPlaytestEpisodeModeFacts(artifact);
  assertPlaytestEpisodeIdentityForMode(
    artifact.identity,
    artifact.executionProvenance
  );
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
    scenario: artifact.identity.scenarioId ?? "",
    policy: artifact.identity.policyId,
    assignment_id: artifact.assignmentId,
    cohort: artifact.policyCohort ?? "",
    seed: artifact.identity.seed ?? "",
    status: artifact.status,
    game_outcome: artifact.outcome,
    // Empty index values represent explicit null source/build facts in the
    // canonical payload; the JSON payload, not the index, is authoritative.
    build_sha: artifact.identity.buildSha ?? "",
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

const PLAYTEST_ADAPTER_EXECUTION_MODE = "adapter-accelerated" as const;
const PLAYTEST_VISUAL_EXECUTION_MODE = "autonomous-visual" as const;
const VISUAL_ASSIGNMENT_INVENTORY_STATUS = "frozen-visual" as const;
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

function assertDiscoveryEvidencePacketReference(
  value: unknown
): asserts value is PlaytestDiscoverySessionReview["evidencePacket"] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !["packetId", "artifact"].includes(key)) ||
    !isPlaytestEvidencePacketId(value.packetId) ||
    !isRecord(value.artifact)
  ) {
    throw new TypeError("Discovery evidence packet reference is malformed.");
  }
  const reference = value.artifact;
  if (
    Object.keys(reference).length !== 4 ||
    Object.keys(reference).some(
      (key) => !["artifactId", "sha256", "bytes", "mediaType"].includes(key)
    ) ||
    typeof reference.artifactId !== "string" ||
    reference.artifactId.trim().length === 0 ||
    reference.artifactId.length > MAX_ARTIFACT_REF_LENGTH ||
    typeof reference.sha256 !== "string" ||
    !SHA256_PATTERN.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    (reference.bytes as number) < 1 ||
    (reference.bytes as number) > MAX_PLAYTEST_PAYLOAD_BYTES ||
    reference.mediaType !== PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
  ) {
    throw new TypeError(
      "Discovery evidence packet artifact metadata is invalid."
    );
  }
}

export function encodeDiscoveryReview(
  workspaceId: string,
  artifact: PlaytestDiscoverySessionReview
): PlaytestIndexedReviewRow {
  assertPlaytestDiscoverySessionReview(artifact);
  if (artifact.workspaceId !== workspaceId) {
    throw new TypeError(
      "Discovery review workspace identity does not match its storage scope."
    );
  }
  assertDiscoveryEvidencePacketReference(artifact.evidencePacket);
  return {
    workspace_id: requiredRef(workspaceId, "workspaceId"),
    episode_id: requiredRef(artifact.episodeId, "episodeId"),
    review_id: requiredRef(artifact.reviewId, "reviewId"),
    version: artifact.version,
    author_role: artifact.authorRole,
    // The required ClickHouse string index is deliberately empty: discovery
    // reviews have no rubric. Canonical payloads never store a fake rubric.
    rubric_hash: "",
    measurement_version: artifact.measurementVersion,
    created_at: toClickHouseDateTime(artifact.createdAt),
    payload_json: payloadJson(artifact)
  };
}

export function decodeDiscoveryReview(
  row: Record<string, unknown>
): PlaytestDiscoverySessionReview {
  const raw = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "reviewId",
    "version"
  );
  if (raw.schema !== PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an unsupported discovery review schema"
    );
  }
  try {
    assertDiscoveryEvidencePacketReference(raw.evidencePacket);
    const artifact = raw as unknown as PlaytestDiscoverySessionReview;
    assertPlaytestDiscoverySessionReview(artifact);
    assertIndexMatches(row, "workspace_id", artifact.workspaceId);
    assertIndexMatches(row, "episode_id", artifact.episodeId);
    assertIndexMatches(row, "review_id", artifact.reviewId);
    assertIndexMatches(row, "version", artifact.version);
    if (
      row.author_role !== artifact.authorRole ||
      row.rubric_hash !== "" ||
      row.measurement_version !== artifact.measurementVersion
    ) {
      throw new TypeError(
        "Discovery review indexed metadata contradicts its canonical payload."
      );
    }
    return artifact;
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse discovery review has a malformed packet reference, claim citation or index",
      error
    );
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

export function encodeCrossSessionSynthesis(
  workspaceId: string,
  artifact: PlaytestCrossSessionSynthesis
): PlaytestIndexedCrossSessionSynthesisRow {
  assertPlaytestCrossSessionSynthesis(artifact);
  if (artifact.workspaceId !== workspaceId) {
    throw new TypeError(
      "Cross-session synthesis workspace does not match its storage scope."
    );
  }
  return {
    workspace_id: requiredRef(workspaceId, "workspaceId"),
    synthesis_id: requiredRef(artifact.synthesisId, "synthesisId"),
    analysis_id: requiredRef(artifact.analysisId, "analysisId"),
    version: artifact.version,
    created_at: toClickHouseDateTime(artifact.generatedAt),
    payload_json: payloadJson(artifact)
  };
}

export function encodeComparison(
  artifact: PlaytestComparison
): PlaytestIndexedComparisonRow {
  assertPlaytestComparisonOwnerDecision(artifact);
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

function frozenBatchInventory(artifact: PlaytestAdapterBatch): {
  readonly manifest: PlaytestAdapterAssignmentManifest;
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
  if (manifest.mode !== PLAYTEST_ADAPTER_EXECUTION_MODE) {
    throw new TypeError(
      "PlaytestBatch v4 cannot store a non-adapter assignment manifest."
    );
  }
  const adapterManifest = manifest;
  const assignmentIds = new Set(
    adapterManifest.assignments.map((assignment) => assignment.assignmentId)
  );
  assertBatchUnobservedAssignments(artifact, assignmentIds);
  return { manifest: adapterManifest, assignmentIds };
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
  manifest: PlaytestAdapterAssignmentManifest,
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

function assertVisualBatchInventory(artifact: PlaytestVisualBatch): void {
  const inventory = artifact.assignmentInventory;
  if (inventory.status !== VISUAL_ASSIGNMENT_INVENTORY_STATUS) {
    throw new TypeError(
      "Visual batches require a frozen visual assignment inventory."
    );
  }
  assertPlaytestAssignmentManifest(inventory.manifest);
  const manifest = inventory.manifest;
  if (
    manifest.mode !== PLAYTEST_VISUAL_EXECUTION_MODE ||
    manifest.batchId !== artifact.batchId ||
    manifest.workspaceId !== artifact.workspaceId ||
    manifest.assignments.length !== artifact.budget.assignedEpisodes ||
    artifact.repository !== null ||
    artifact.buildSha !== null ||
    artifact.gameBuild !== null ||
    artifact.configHash !== null ||
    artifact.rubricHash !== null ||
    artifact.actionSchemaHash !== null ||
    artifact.observationSchemaHash !== null ||
    artifact.eventSchemaHash !== null ||
    artifact.protocolVersion !== null ||
    artifact.coverageManifest !== null ||
    artifact.reviewSelection.status !== "unavailable" ||
    artifact.reviewSelection.reason !== "visual-discovery-session-level" ||
    artifact.reviewPackets.length > 0 ||
    artifact.reviewReceipts.length > 0 ||
    artifact.provenance.buildSha !== null ||
    artifact.provenance.workspaceId !== artifact.workspaceId ||
    artifact.provenance.measurementVersion !== artifact.measurementVersion ||
    artifact.budget.critiqueBudget !== 0 ||
    artifact.budget.actualCritiques !== 0 ||
    artifact.policyIds.length !== 1 ||
    artifact.policyIds[0] !== manifest.policyId ||
    (manifest.cohortId === null
      ? artifact.cohortIds.length > 0
      : artifact.cohortIds.length !== 1 ||
        artifact.cohortIds[0] !== manifest.cohortId) ||
    artifact.scenarioIds.length > 0
  ) {
    throw new TypeError(
      "Visual batch identity contains adapter facts or mismatched discovery state."
    );
  }
  if (
    artifact.budget.maxStepsPerEpisode > manifest.limits.maxStepsPerEpisode ||
    artifact.budget.wallTimeMs > manifest.limits.wallTimeMs
  ) {
    throw new TypeError(
      "Visual batch budget exceeds its frozen target limits."
    );
  }
  const assignmentIds = new Set(
    manifest.assignments.map((assignment) => assignment.assignmentId)
  );
  assertBatchUnobservedAssignments(artifact, assignmentIds);
  const contentHash = createHash("sha256")
    .update(playtestAssignmentManifestHashInput(manifest))
    .digest("hex");
  if (contentHash !== manifest.contentHash.toLowerCase()) {
    throw new TypeError("Visual assignment manifest contentHash is invalid.");
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
  if (artifact.executionMode === PLAYTEST_VISUAL_EXECUTION_MODE) {
    assertVisualBatchInventory(artifact);
    return;
  }
  if (artifact.executionMode !== PLAYTEST_ADAPTER_EXECUTION_MODE) {
    throw new TypeError("Batch execution mode is unsupported.");
  }
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
  if (artifact.executionMode !== PLAYTEST_ADAPTER_EXECUTION_MODE) {
    throw new TypeError("Visual batches cannot carry confirmatory coverage.");
  }
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
        "ClickHouse v4 assignment manifest is malformed",
        error
      );
    }
    return value as unknown as PlaytestAssignmentManifest;
  }
  if (value.schema === PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA) {
    try {
      assertPlaytestAssignmentManifest(value);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse visual assignment manifest is malformed",
        error
      );
    }
    return value as unknown as PlaytestAssignmentManifest;
  }
  if (
    value.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1 &&
    value.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2 &&
    value.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V3
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse frozen assignment inventory has an unsupported schema"
    );
  }
  const originalHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        value as unknown as PlaytestAssignmentManifestDraft
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
  if (!Array.isArray(value.assignments)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy assignment manifest has malformed assignment inventory"
    );
  }
  const predatesCohortCoverage =
    value.schema === PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V1 ||
    value.schema === PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA_V2;
  if (
    value.assignments.some(
      (assignment) =>
        !isRecord(assignment) ||
        (predatesCohortCoverage
          ? assignment.cohort !== undefined
          : !Object.hasOwn(assignment, "cohort"))
    )
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy assignment manifest has malformed coverage identity"
    );
  }
  const migrated = {
    ...value,
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: PLAYTEST_ADAPTER_EXECUTION_MODE,
    assignments: predatesCohortCoverage
      ? value.assignments.map((assignment) => ({
          ...(assignment as Record<string, unknown>),
          cohort: null
        }))
      : value.assignments
  };
  const contentHash = createHash("sha256")
    .update(
      playtestAssignmentManifestHashInput(
        migrated as unknown as PlaytestAssignmentManifestDraft
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
  if (
    (value.status !== "frozen" &&
      value.status !== VISUAL_ASSIGNMENT_INVENTORY_STATUS) ||
    !isRecord(value.manifest)
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse frozen assignment inventory has a malformed manifest"
    );
  }
  const manifest = migrateAssignmentManifest(value.manifest);
  if (value.status === VISUAL_ASSIGNMENT_INVENTORY_STATUS) {
    if (manifest.mode !== PLAYTEST_VISUAL_EXECUTION_MODE) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse visual inventory has a non-visual manifest"
      );
    }
    return { status: VISUAL_ASSIGNMENT_INVENTORY_STATUS, manifest };
  }
  if (manifest.mode !== PLAYTEST_ADAPTER_EXECUTION_MODE) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse adapter inventory has a visual assignment manifest"
    );
  }
  return { status: "frozen", manifest };
}

/**
 * Assignment-manifest promotions change the manifest hash even when the
 * recorded assignments remain identical. Preserve an attached coverage plan
 * by verifying its legacy binding first, then rebinding and rehashing it to
 * the canonical manifest. Never repair a coverage record that was already
 * inconsistent with the batch it claims to describe.
 */
function migrateBatchCoverageManifest(
  artifact: Readonly<Record<string, unknown>>,
  assignmentInventory: PlaytestBatch["assignmentInventory"]
): PlaytestBatch["coverageManifest"] {
  const coverage = artifact.coverageManifest;
  if (coverage === null) return null;
  if (!isRecord(coverage)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse batch has a malformed coverage manifest."
    );
  }
  try {
    assertPlaytestCoverageManifest(coverage);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse batch coverage manifest is invalid before assignment migration.",
      error
    );
  }
  const { contentHash: originalContentHash, ...originalDraft } = coverage;
  const expectedOriginalHash = createHash("sha256")
    .update(
      playtestCoverageManifestHashInput(
        originalDraft as unknown as Omit<
          PlaytestCoverageManifest,
          "contentHash"
        >
      )
    )
    .digest("hex");
  if (
    typeof originalContentHash !== "string" ||
    expectedOriginalHash !== originalContentHash.toLowerCase()
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy coverage manifest content hash is invalid before assignment migration."
    );
  }

  const originalInventory = artifact.assignmentInventory;
  if (
    !isRecord(originalInventory) ||
    originalInventory.status !== "frozen" ||
    !isRecord(originalInventory.manifest) ||
    assignmentInventory.status !== "frozen"
  ) {
    return coverage as unknown as PlaytestBatch["coverageManifest"];
  }

  const originalManifest = originalInventory.manifest;
  const migratedManifest = assignmentInventory.manifest;
  if (
    typeof originalManifest.contentHash !== "string" ||
    originalManifest.contentHash.toLowerCase() === migratedManifest.contentHash
  ) {
    return coverage as unknown as PlaytestBatch["coverageManifest"];
  }

  const budget = artifact.budget;
  if (
    !isRecord(budget) ||
    coverage.workspaceId !== artifact.workspaceId ||
    coverage.batchId !== artifact.batchId ||
    coverage.buildSha !== artifact.buildSha ||
    coverage.rubricHash !== artifact.rubricHash ||
    typeof coverage.assignmentManifestHash !== "string" ||
    coverage.assignmentManifestHash.toLowerCase() !==
      originalManifest.contentHash.toLowerCase() ||
    coverage.assignedEpisodes !== budget.assignedEpisodes
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy coverage manifest does not match its original batch and assignment identity."
    );
  }

  const migratedDraft = {
    ...originalDraft,
    assignmentManifestHash: migratedManifest.contentHash
  };
  const contentHash = createHash("sha256")
    .update(
      playtestCoverageManifestHashInput(
        migratedDraft as unknown as Omit<
          PlaytestCoverageManifest,
          "contentHash"
        >
      )
    )
    .digest("hex");
  const migratedCoverage = { ...migratedDraft, contentHash };
  try {
    assertPlaytestCoverageManifest(migratedCoverage);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse migrated coverage manifest is invalid.",
      error
    );
  }
  return migratedCoverage as PlaytestCoverageManifest;
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
    schema !== PLAYTESTS_BATCH_SCHEMA_V3 &&
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
    (schema === PLAYTESTS_BATCH_SCHEMA ||
      schema === PLAYTESTS_BATCH_SCHEMA_V3) &&
    (artifact.reviewPackets === undefined ||
      !Array.isArray(artifact.reviewReceipts))
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse batch schema requires its packet and review receipt inventory"
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
  if (
    schema !== PLAYTESTS_BATCH_SCHEMA &&
    assignmentInventory.status === VISUAL_ASSIGNMENT_INVENTORY_STATUS
  ) {
    throw new PlaytestSourceUnavailableError(
      "Legacy ClickHouse batch schema cannot contain visual assignments"
    );
  }
  const reviewSelection =
    artifact.reviewSelection === undefined
      ? {
          status: "unavailable" as const,
          reason: "recorded-before-review-selection" as const
        }
      : artifact.reviewSelection;
  const reviewReceipts = Array.isArray(artifact.reviewReceipts)
    ? schema === PLAYTESTS_BATCH_SCHEMA || schema === PLAYTESTS_BATCH_SCHEMA_V3
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
    (schema === PLAYTESTS_BATCH_SCHEMA ||
      schema === PLAYTESTS_BATCH_SCHEMA_V3) &&
    Array.isArray(artifact.reviewPackets)
      ? artifact.reviewPackets
      : migrateLegacyPacketReceipts({
          batchId: artifact.batchId,
          createdAt: artifact.createdAt,
          assignmentInventory,
          reviewSelection
        });
  const normalized: Record<string, unknown> = {
    ...artifact,
    schema: PLAYTESTS_BATCH_SCHEMA,
    executionMode:
      schema === PLAYTESTS_BATCH_SCHEMA
        ? artifact.executionMode
        : PLAYTEST_ADAPTER_EXECUTION_MODE
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
        : migrateBatchCoverageManifest(artifact, assignmentInventory),
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
function assertEpisodeAssignmentIdentity(
  artifact: Readonly<Record<string, unknown>>,
  version: string
): void {
  if (
    typeof artifact.assignmentId !== "string" &&
    artifact.assignmentId !== null
  ) {
    throw new PlaytestSourceUnavailableError(
      `ClickHouse ${version} episode is missing its batch assignment identity`
    );
  }
}

function assertEpisodeBranchLineage(
  artifact: Readonly<Record<string, unknown>>,
  version: string
): void {
  if (artifact.branchLineage === undefined) {
    throw new PlaytestSourceUnavailableError(
      `ClickHouse ${version} episode is missing its branch-lineage field`
    );
  }
}

type LegacyPlaytestEpisode = Omit<
  PlaytestEpisode,
  "executionProvenance" | "playerDebrief"
>;

function migrateEpisodeV1(
  artifact: Readonly<Record<string, unknown>>
): LegacyPlaytestEpisode {
  return {
    ...artifact,
    schema: PLAYTESTS_EPISODE_SCHEMA_V4,
    assignmentId:
      typeof artifact.assignmentId === "string" ? artifact.assignmentId : null,
    branchLineage: null,
    termination: { reason: "unknown", step: null },
    metrics: Array.isArray(artifact.metrics)
      ? artifact.metrics.map((metric) =>
          isRecord(metric)
            ? { ...metric, phaseId: null, opportunityCount: null }
            : metric
        )
      : []
  } as unknown as LegacyPlaytestEpisode;
}

function migrateEpisodeV2(
  artifact: Readonly<Record<string, unknown>>
): LegacyPlaytestEpisode {
  assertEpisodeAssignmentIdentity(artifact, "v2");
  assertEpisodeBranchLineage(artifact, "v2");
  return {
    ...artifact,
    schema: PLAYTESTS_EPISODE_SCHEMA_V4,
    termination: { reason: "unknown", step: null },
    metrics: Array.isArray(artifact.metrics)
      ? artifact.metrics.map((metric) =>
          isRecord(metric) && metric.phaseId === undefined
            ? { ...metric, phaseId: null }
            : metric
        )
      : []
  } as unknown as LegacyPlaytestEpisode;
}

function migrateEpisodeV3(
  artifact: Readonly<Record<string, unknown>>
): LegacyPlaytestEpisode {
  assertEpisodeAssignmentIdentity(artifact, "v3");
  assertEpisodeBranchLineage(artifact, "v3");
  return {
    ...artifact,
    schema: PLAYTESTS_EPISODE_SCHEMA_V4,
    termination: { reason: "unknown", step: null }
  } as unknown as LegacyPlaytestEpisode;
}

function validateEpisodeV4(
  artifact: Readonly<Record<string, unknown>>
): LegacyPlaytestEpisode {
  assertEpisodeAssignmentIdentity(artifact, "v4");
  assertEpisodeBranchLineage(artifact, "v4");
  const termination = artifact.termination;
  if (
    !isRecord(termination) ||
    !(PLAYTESTS_EPISODE_TERMINATION_REASONS as readonly unknown[]).includes(
      termination.reason
    ) ||
    (termination.step !== null &&
      (!Number.isSafeInteger(termination.step) || Number(termination.step) < 0))
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v4 episode contains an invalid termination record"
    );
  }
  return artifact as unknown as LegacyPlaytestEpisode;
}

function readLegacyEpisodeArtifact(
  artifact: Readonly<Record<string, unknown>>
): LegacyPlaytestEpisode {
  switch (artifact.schema) {
    case PLAYTESTS_EPISODE_SCHEMA_V1: {
      return migrateEpisodeV1(artifact);
    }
    case PLAYTESTS_EPISODE_SCHEMA_V2: {
      return migrateEpisodeV2(artifact);
    }
    case PLAYTESTS_EPISODE_SCHEMA_V3: {
      return migrateEpisodeV3(artifact);
    }
    case PLAYTESTS_EPISODE_SCHEMA_V4: {
      return validateEpisodeV4(artifact);
    }
    default: {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse returned an unsupported playtest episode schema"
      );
    }
  }
}

/** One-time persisted-row migration; normal reads accept only the current schema. */
export function migrateLegacyEpisodeForStorage(
  row: Record<string, unknown>
): PlaytestEpisode {
  const artifact = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "episodeId",
    "revision"
  );
  if (
    artifact.schema === PLAYTESTS_EPISODE_SCHEMA_V5 ||
    artifact.schema === PLAYTESTS_EPISODE_SCHEMA_V6 ||
    artifact.schema === PLAYTESTS_EPISODE_SCHEMA_V7
  ) {
    assertEpisodeAssignmentIdentity(artifact, "v5");
    assertEpisodeBranchLineage(artifact, "v5");
    const termination = artifact.termination;
    if (
      !isRecord(termination) ||
      !(PLAYTESTS_EPISODE_TERMINATION_REASONS as readonly unknown[]).includes(
        termination.reason
      ) ||
      (termination.step !== null &&
        (!Number.isSafeInteger(termination.step) ||
          Number(termination.step) < 0))
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse legacy episode contains an invalid termination record"
      );
    }
    const visualMode =
      isRecord(artifact.executionProvenance) &&
      artifact.executionProvenance.mode === "autonomous-visual";
    const migrated = {
      ...artifact,
      schema: PLAYTESTS_EPISODE_SCHEMA,
      // v1-v7 rows predate the player-authored debrief field; preserve that
      // historical absence explicitly rather than inventing a report.
      playerDebrief: {
        schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
        status: "absent",
        reason: "legacy-no-report"
      },
      scenarioFamily: visualMode ? null : artifact.scenarioFamily,
      policyCohort: visualMode ? null : artifact.policyCohort
    } as unknown as PlaytestEpisode;
    try {
      assertPlaytestExecutionProvenance(migrated.executionProvenance);
      assertPlaytestEpisodeModeFacts(migrated);
      assertPlaytestEpisodeIdentityForMode(
        migrated.identity,
        migrated.executionProvenance
      );
      assertPlaytestNumericResults(migrated.metrics);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse legacy episode contains invalid execution identity or metrics",
        error
      );
    }
    assertIndexMatches(row, "workspace_id", migrated.identity.workspaceId);
    assertIndexMatches(row, "batch_id", migrated.batchId);
    assertIndexMatches(row, "episode_id", migrated.episodeId);
    assertIndexMatches(row, "revision", migrated.revision);
    assertIndexMatches(row, "scenario", migrated.identity.scenarioId ?? "");
    assertIndexMatches(row, "seed", migrated.identity.seed ?? "");
    assertIndexMatches(row, "build_sha", migrated.identity.buildSha ?? "");
    assertIndexMatches(row, "policy", migrated.identity.policyId);
    assertIndexMatches(
      row,
      "cohort",
      typeof artifact.policyCohort === "string" ? artifact.policyCohort : ""
    );
    assertIndexMatches(row, "status", migrated.status);
    assertIndexMatches(row, "game_outcome", migrated.outcome);
    return migrated;
  }

  const legacy = readLegacyEpisodeArtifact(artifact);
  const migrated: PlaytestEpisode = {
    ...legacy,
    schema: PLAYTESTS_EPISODE_SCHEMA,
    // Schema promotion is not a new gameplay revision. Retaining the episode
    // revision keeps already-persisted packet/review bindings exact.
    executionProvenance: legacyPlaytestExecutionProvenance({
      identity: legacy.identity,
      branchLineage: legacy.branchLineage
    }),
    // v1-v4 rows predate the player-authored debrief field; preserve that
    // historical absence explicitly rather than inventing a report.
    playerDebrief: {
      schema: PLAYTEST_PLAYER_DEBRIEF_SCHEMA,
      status: "absent",
      reason: "legacy-no-report"
    },
    scenarioFamily:
      typeof legacy.scenarioFamily === "string" ? legacy.scenarioFamily : null,
    policyCohort:
      typeof legacy.policyCohort === "string" ? legacy.policyCohort : null
  };
  assertIndexMatches(row, "workspace_id", migrated.identity.workspaceId);
  assertIndexMatches(row, "batch_id", migrated.batchId);
  assertIndexMatches(row, "episode_id", migrated.episodeId);
  assertPlaytestEpisodeModeFacts(migrated);
  assertIndexMatches(row, "revision", legacy.revision);
  assertIndexMatches(row, "scenario", migrated.identity.scenarioId ?? "");
  assertIndexMatches(row, "seed", migrated.identity.seed ?? "");
  assertIndexMatches(row, "build_sha", migrated.identity.buildSha ?? "");
  return migrated;
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
  assertIndexMatches(row, "build_sha", artifact.buildSha ?? "");
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
  assertIndexMatches(row, "scenario", artifact.identity.scenarioId ?? "");
  assertIndexMatches(row, "seed", artifact.identity.seed ?? "");
  assertIndexMatches(row, "build_sha", artifact.identity.buildSha ?? "");
  assertIndexMatches(row, "policy", artifact.identity.policyId);
  if (row.assignment_id !== undefined && artifact.assignmentId !== null) {
    assertIndexMatches(row, "assignment_id", artifact.assignmentId);
  }
  assertIndexMatches(row, "cohort", artifact.policyCohort ?? "");
  assertIndexMatches(row, "status", artifact.status);
  assertIndexMatches(row, "game_outcome", artifact.outcome);
  try {
    assertPlaytestExecutionProvenance(artifact.executionProvenance);
    assertPlaytestEpisodeModeFacts(artifact);
    assertPlaytestEpisodeIdentityForMode(
      artifact.identity,
      artifact.executionProvenance
    );
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

function isLegacyReviewSchema(schema: unknown): boolean {
  return (
    schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V1 ||
    schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V2 ||
    schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V3 ||
    schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V4 ||
    schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V5
  );
}

function notRecordedReviewCompleteness(
  schemaLabel: string
): PlaytestSessionReview["reportCompleteness"] {
  const sectionReason = (section: string): string =>
    `${section} was not represented in review schema ${schemaLabel}.`;
  return {
    crossSessionContext: {
      status: PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
      reason: sectionReason("Cross-session context")
    },
    alternatives: {
      status: PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
      reason: sectionReason("Alternative-explanation completeness")
    },
    experiments: {
      status: PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
      reason: sectionReason("Experiment completeness")
    },
    followUp: {
      status: PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
      reason: sectionReason("Follow-up completeness")
    }
  };
}

function migrateLegacyReview(
  raw: Readonly<Record<string, unknown>>
): PlaytestSessionReview {
  const isVersionOne = raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V1;
  const isVersionFour = raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V4;
  const isVersionFive = raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA_V5;
  if (!isVersionOne && raw.evidencePacket === undefined) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse legacy review is missing its evidence-packet field"
    );
  }
  if (!isVersionOne) {
    try {
      assertEvidencePacketReference(raw.evidencePacket);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse legacy review has a malformed evidence-packet reference",
        error
      );
    }
  }
  if (isVersionFive) {
    const migrated = {
      ...raw,
      schema: PLAYTESTS_SESSION_REVIEW_SCHEMA
    } as unknown as PlaytestSessionReview;
    try {
      assertPlaytestSessionReviewHasEvidence(migrated);
      return migrated;
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v5 review has malformed packet citations or report fields",
        error
      );
    }
  }
  if (isVersionFour) {
    const migrated = {
      ...raw,
      schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
      reportCompleteness: notRecordedReviewCompleteness("v4")
    } as unknown as PlaytestSessionReview;
    try {
      assertPlaytestSessionReviewHasEvidence(migrated, {
        allowHistoricalNotRecorded: true
      });
      return migrated;
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v4 review has malformed packet citations or report fields",
        error
      );
    }
  }
  return {
    ...raw,
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    evidencePacket: isVersionOne
      ? null
      : (raw.evidencePacket as PlaytestSessionReview["evidencePacket"]),
    reportCompleteness: notRecordedReviewCompleteness("legacy"),
    observations: migrateLegacyReviewClaims(raw.observations, "observations"),
    interpretations: migrateLegacyReviewClaims(
      raw.interpretations,
      "interpretations"
    )
  } as unknown as PlaytestSessionReview;
}

function decodeCurrentReview(
  raw: Readonly<Record<string, unknown>>
): PlaytestSessionReview {
  if (raw.evidencePacket === undefined || raw.evidencePacket === null) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v6 playtest review is missing its evidence-packet reference"
    );
  }
  try {
    assertEvidencePacketReference(raw.evidencePacket);
    const review = raw as unknown as PlaytestSessionReview;
    assertPlaytestSessionReviewHasEvidence(review);
    return review;
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse v6 review has a malformed packet reference, claim citation or report-completeness record",
      error
    );
  }
}

export function decodeReview(
  row: Record<string, unknown>
): PlaytestSessionReview {
  const raw = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "reviewId",
    "version"
  );
  const artifact = isLegacyReviewSchema(raw.schema)
    ? migrateLegacyReview(raw)
    : raw.schema === PLAYTESTS_SESSION_REVIEW_SCHEMA
      ? decodeCurrentReview(raw)
      : null;
  if (artifact === null) {
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

/** Review list rows surface bounded text; the archive keeps the full payload. */
export const MAX_PLAYTEST_REVIEW_HEADLINE_CHARS = 240;
export const MAX_PLAYTEST_REVIEW_SUMMARY_CHARS = 600;
export const MAX_PLAYTEST_REVIEW_EVIDENCE_REFS = 8;
/** One claim is a sentence the analyst wrote; the drawer shows it whole. */
export const MAX_PLAYTEST_REVIEW_CLAIM_CHARS = 600;
/** How many claims one review row carries. */
export const MAX_PLAYTEST_REVIEW_CLAIMS = 50;

/**
 * Bound a free-text field to the length a list row may carry. This is the
 * one bounded-text helper the Playtesting codecs use; a longer value is
 * truncated rather than dropped so the row still says something.
 *
 * The cut lands on a word boundary and is marked. A raw `slice` cut the
 * review's conclusion in the middle of a word -- "The step 1 pred" -- which
 * reads as a corrupted record rather than a shortened one, and left the
 * reader unable to tell a truncation from a mistake.
 *
 * The ellipsis is inside the bound: the result is never longer than `max`.
 */
export function boundPlaytestText(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/**
 * Read a ClickHouse `DateTime64(3)` column value as an ISO-8601 timestamp.
 * The inverse of {@link toClickHouseDateTime}; an unreadable value yields an
 * empty string so the caller's own validation decides what that means.
 */
export function clickHouseDateTimeAsIso(value: unknown): string {
  if (typeof value !== "string") return "";
  const isoValue = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(isoValue);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** The claim text of a review entry, tolerating the plain-string legacy shape. */
function reviewClaimText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.text === "string") {
    return value.text.trim();
  }
  return "";
}

/** The text of the first entry of a claim array, or an empty string. */
function firstReviewClaimText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return reviewClaimText(value[0]);
}

/** The length of a claim array, counting an absent array as no claims. */
function reviewClaimCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * The status a claim or a finding carries when nothing was confirmed.
 *
 * It is the honest reading of a payload that says nothing: not "verified",
 * and not "there was no finding".
 */
const REVIEW_NOT_OBSERVED = "not observed";

/**
 * The evidence statuses a finding may carry.
 *
 * A status outside this set is not a status the product knows, and it is
 * read as "not observed" rather than as anything stronger: an unknown label
 * must never upgrade a finding into a verified defect.
 */
const REVIEW_FINDING_EVIDENCE_STATUSES = new Set<
  PlaytestFinding["evidenceStatus"]
>(["verified", "corroborated", "hypothesis", REVIEW_NOT_OBSERVED]);

/**
 * The findings the review carries, with the evidence status each one holds.
 *
 * The status is read from the payload rather than assumed: a finding with no
 * readable status is a candidate, not a verified defect.
 */
function decodeReviewFindings(
  value: unknown
): readonly PlaytestReviewFindingSummary[] {
  if (!Array.isArray(value)) return [];
  const findings: PlaytestReviewFindingSummary[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const findingId =
      typeof entry.findingId === "string" ? entry.findingId : "";
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (findingId === "" && title === "") continue;
    const rawStatus = entry.evidenceStatus;
    const evidenceStatus =
      typeof rawStatus === "string" &&
      REVIEW_FINDING_EVIDENCE_STATUSES.has(
        rawStatus as PlaytestFinding["evidenceStatus"]
      )
        ? (rawStatus as PlaytestFinding["evidenceStatus"])
        : REVIEW_NOT_OBSERVED;
    findings.push({ findingId, title, evidenceStatus });
  }
  return findings;
}

/**
 * The analyst's claims, in the order the review recorded them.
 *
 * The payload keeps them as claims -- an id, a status and the text -- and
 * this projects them to the three fields a reader needs. The status is kept
 * because a review also records what the analyst could *not* confirm, and
 * reading that as an asserted conclusion would turn an explicit null into a
 * finding.
 *
 * A claim with no text contributes nothing to read and is skipped; the
 * payload's own count of claims is not changed by this projection.
 */
function decodeReviewClaims(
  value: unknown
): readonly PlaytestReviewClaimSummary[] {
  if (!Array.isArray(value)) return [];
  const claims: PlaytestReviewClaimSummary[] = [];
  for (const claim of value) {
    const text = reviewClaimText(claim);
    if (text.length === 0) continue;
    const record = isRecord(claim) ? claim : {};
    const hypothesisId =
      typeof record.hypothesisId === "string" ? record.hypothesisId : "";
    const rawStatus = record.status;
    const status: PlaytestReviewClaimSummary["status"] =
      rawStatus === REVIEW_NOT_OBSERVED || rawStatus === "not-observed"
        ? REVIEW_NOT_OBSERVED
        : "hypothesis";
    claims.push({
      hypothesisId,
      text: boundPlaytestText(text, MAX_PLAYTEST_REVIEW_CLAIM_CHARS),
      status
    });
    if (claims.length >= MAX_PLAYTEST_REVIEW_CLAIMS) break;
  }
  return claims;
}

/**
 * The headline: the first claim the analyst asserted.
 *
 * The first *asserted* claim, not simply the first one. A review records
 * what it could not confirm alongside what it claims, and a headline that
 * leads with an explicit null would state the opposite of what the analyst
 * concluded.
 */
function firstAssertedReviewClaimText(value: unknown): string {
  const claims = decodeReviewClaims(value);
  const asserted = claims.find((claim) => claim.status === "hypothesis");
  return asserted?.text ?? claims[0]?.text ?? "";
}

/** The workspace a review payload claims, wherever that payload keeps it. */
function reviewPayloadWorkspaceId(
  payload: Readonly<Record<string, unknown>>
): string | null {
  if (typeof payload.workspaceId === "string") return payload.workspaceId;
  const provenance = payload.provenance;
  if (isRecord(provenance) && typeof provenance.workspaceId === "string") {
    return provenance.workspaceId;
  }
  return null;
}

/**
 * Decode the evidence a review cites. Locators are deduplicated and capped,
 * because a list row may not carry a review's whole citation ledger. A
 * malformed locator is a real defect and stays loud.
 */
function decodeReviewEvidenceRefs(
  value: unknown
): readonly PlaytestEvidenceLocator[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse review payload has a malformed evidenceRefs array"
    );
  }
  const refs: PlaytestEvidenceLocator[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    try {
      assertPlaytestEvidenceLocator(entry);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse review payload has a malformed evidence locator",
        error
      );
    }
    const key = [
      entry.kind,
      entry.id,
      entry.step ?? "",
      entry.revision ?? "",
      entry.frameIndex ?? "",
      entry.phaseId ?? ""
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(entry);
    if (refs.length === MAX_PLAYTEST_REVIEW_EVIDENCE_REFS) break;
  }
  return refs;
}

/**
 * Project one persisted review row into the summary a list may show.
 *
 * The derivation is shape-tolerant on purpose: discovery and confirmatory
 * reviews keep their claims in different shapes, and a payload that lacks a
 * key degrades to an empty or zero value instead of failing the read. Only
 * a genuinely broken payload -- unparsable JSON, a missing identity, a
 * malformed locator -- raises.
 */
export function decodeReviewSummary(
  row: Record<string, unknown>
): PlaytestReviewSummary {
  const payload = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "reviewId",
    "version"
  );
  const { workspace_id: workspaceId, episode_id: episodeId } = row;
  const reviewId = row.review_id;
  if (
    typeof workspaceId !== "string" ||
    typeof episodeId !== "string" ||
    typeof reviewId !== "string"
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse review row is missing its indexed identity columns"
    );
  }
  const payloadWorkspaceId = reviewPayloadWorkspaceId(payload);
  if (payloadWorkspaceId !== null) {
    assertIndexMatches(row, "workspace_id", payloadWorkspaceId);
  }
  const payloadEpisodeId = payload.episodeId;
  const payloadReviewId = payload.reviewId;
  const payloadVersion = payload.version;
  if (
    typeof payloadEpisodeId !== "string" ||
    typeof payloadReviewId !== "string" ||
    typeof payloadVersion !== "number"
  ) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse review payload is missing its identity"
    );
  }
  assertIndexMatches(row, "episode_id", payloadEpisodeId);
  assertIndexMatches(row, "review_id", payloadReviewId);
  assertIndexMatches(row, "version", payloadVersion);

  const summary = boundPlaytestText(
    typeof payload.chronologicalSummary === "string"
      ? payload.chronologicalSummary.trim()
      : "",
    MAX_PLAYTEST_REVIEW_SUMMARY_CHARS
  );
  const headline = boundPlaytestText(
    firstAssertedReviewClaimText(payload.interpretations) ||
      firstReviewClaimText(payload.observations) ||
      summary,
    MAX_PLAYTEST_REVIEW_HEADLINE_CHARS
  );
  return {
    reviewId,
    episodeId,
    workspaceId,
    kind:
      payload.schema === PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA
        ? "discovery"
        : "confirmatory",
    createdAt: clickHouseDateTimeAsIso(row.created_at),
    status: typeof payload.status === "string" ? payload.status : "",
    observationCount: reviewClaimCount(payload.observations),
    interpretationCount: reviewClaimCount(payload.interpretations),
    findingCount: reviewClaimCount(payload.findings),
    headline,
    summary,
    hypotheses: decodeReviewClaims(payload.interpretations),
    findings: decodeReviewFindings(payload.findings),
    evidenceRefs: decodeReviewEvidenceRefs(payload.evidenceRefs)
  };
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

export function decodeCrossSessionSynthesis(
  row: Record<string, unknown>
): PlaytestCrossSessionSynthesis {
  const payload = decodePayload<unknown>(row, "synthesisId", "version");
  const artifact =
    isRecord(payload) &&
    payload.schema === PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1
      ? migratePlaytestCrossSessionSynthesisV1(payload)
      : (payload as PlaytestCrossSessionSynthesis);
  try {
    if (artifact.schema !== PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA) {
      throw new TypeError("Cross-session synthesis schema is unsupported.");
    }
    assertPlaytestCrossSessionSynthesis(artifact);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned a malformed cross-session synthesis",
      error
    );
  }
  assertIndexMatches(row, "workspace_id", artifact.workspaceId);
  assertIndexMatches(row, "analysis_id", artifact.analysisId);
  assertIndexMatches(row, "synthesis_id", artifact.synthesisId);
  assertIndexMatches(row, "version", artifact.version);
  return artifact;
}

export function decodeComparison(
  row: Record<string, unknown>
): PlaytestComparison {
  const payload = decodePayload<Readonly<Record<string, unknown>>>(
    row,
    "comparisonId",
    "version"
  );
  let artifact: PlaytestComparison;
  if (payload.schema === PLAYTESTS_COMPARISON_SCHEMA_V1) {
    const historical = payload as unknown as PlaytestComparisonV1;
    if (
      (historical.ownerDecisionAt !== null &&
        typeof historical.ownerDecisionAt !== "string") ||
      (historical.ownerDecisionReason !== null &&
        typeof historical.ownerDecisionReason !== "string") ||
      (historical.ownerDecisionAt === null) !==
        (historical.ownerDecisionReason === null)
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse v1 comparison has an incomplete owner-decision record"
      );
    }
    const hasHistoricalDecision = historical.ownerDecisionAt !== null;
    artifact = {
      ...historical,
      schema: PLAYTESTS_COMPARISON_SCHEMA,
      ownerDecisionBy: null,
      ownerDisposition: hasHistoricalDecision ? "not-recorded" : null
    };
  } else if (payload.schema === PLAYTESTS_COMPARISON_SCHEMA) {
    artifact = payload as unknown as PlaytestComparison;
  } else {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse comparison payload has an unsupported schema version"
    );
  }
  try {
    assertPlaytestComparisonOwnerDecision(artifact);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse comparison has a malformed owner-decision record",
      error
    );
  }
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
