/**
The Playtesting Control API contracts, stated as Zod schemas.

Core owns the schema and exported types for every Playtesting Control API
response and typed request so Runtime producers and Console readers validate
against one contract without re-spelled local type guards.
*/
import { z } from "zod";

import type {
  HumanPlaytestStudy,
  PlaytestBatch,
  PlaytestBatchCancellationReason,
  PlaytestBenchmark,
  PlaytestCrossSessionSynthesis,
  PlaytestDiscoverySessionReview,
  PlaytestEpisode,
  PlaytestEvidencePacket,
  PlaytestExperiment,
  PlaytestSessionReview
} from "../playtesting/artifacts.ts";
import { assertPlaytestCoverageManifest } from "../playtesting/coverage.ts";
import { assertPlaytestDiscoverySessionReview } from "../playtesting/discovery-evidence-packet.ts";
import { assertPlaytestExecutionProvenance } from "../playtesting/execution-provenance.ts";
import type {
  PlaytestHumanPreferenceCounts,
  PlaytestPreferenceSensitivityDecision
} from "../playtesting/human-preference.ts";
import { assertPlaytestNumericResults } from "../playtesting/metric-evaluation.ts";
import type {
  PlaytestArtifactReference,
  PlaytestJsonValue
} from "../playtesting/protocol-types.ts";
import {
  type PlaytestComparison,
  type PlaytestEvidenceLocator,
  type PlaytestFinding,
  type PlaytestNumericInterval,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V1,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V1,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_TERMINATION_REASONS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReference
} from "../playtesting/types.ts";
import {
  isPlaytestVisualPolicyId,
  type PlaytestVisualPolicyId
} from "../playtesting/visual-decision.ts";
import { isRecord } from "../shared/object-guards.ts";
import type { WorkspacePlaytestLimits } from "../workspaces/playtesting.ts";
import {
  assertWorkspaceVisualPlaytestTargetApproval,
  type WorkspaceVisualPlaytestTargetApproval
} from "../workspaces/visual-playtesting.ts";

export type { PlaytestVisualPolicyId } from "../playtesting/visual-decision.ts";

export const CONTROL_API_PLAYTESTING_READINESS_SCHEMA =
  "autodev-control-playtesting-readiness-v1" as const;
export const CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID =
  "autodev-control-playtesting-capabilities-v3" as const;
export const CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID =
  "autodev-control-playtesting-runs-v2" as const;
export const CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID =
  "autodev-control-playtesting-run-started-v3" as const;
export const CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID =
  "autodev-control-playtesting-run-request-v2" as const;
export const CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID =
  "autodev-control-playtesting-run-status-v1" as const;
export const CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID =
  "autodev-control-playtesting-run-cancellation-v1" as const;
export const CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID =
  "autodev-control-playtesting-analysis-v1" as const;
export const CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID =
  "autodev-control-playtesting-analyses-v1" as const;
export const CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID =
  "autodev-control-playtesting-reviews-v2" as const;
export const CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID =
  "autodev-control-playtesting-comparison-decision-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID =
  "autodev-control-playtesting-human-validation-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_IMPORT_SCHEMA_ID =
  "autodev-control-playtesting-human-import-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_CONSENT_SCHEMA_ID =
  "autodev-control-playtesting-human-consent-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_WITHDRAWAL_SCHEMA_ID =
  "autodev-control-playtesting-human-withdrawal-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_QUARANTINES_SCHEMA_ID =
  "autodev-control-playtesting-human-quarantines-v1" as const;
export const CONTROL_API_PLAYTESTING_HUMAN_STUDY_REGISTRATION_SCHEMA_ID =
  "autodev-control-playtesting-human-study-registration-v1" as const;
export const CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID =
  "autodev-control-playtesting-page-v1" as const;
export const CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID =
  "autodev-control-playtesting-detail-v4" as const;
export const CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID =
  "autodev-control-playtesting-window-v1" as const;

export const PLAYTEST_WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
export const PLAYTEST_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
export const PLAYTEST_CAPABILITY_REVISION_PATTERN = /^[a-f\d]{64}$/u;
export const PLAYTEST_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
export const PLAYTEST_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PLAYTEST_ASSIGNMENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PLAYTEST_EPISODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const PLAYTEST_ENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);
const nonNegativeIntSchema = z.number().int().nonnegative();
const nullableNonNegativeIntSchema = nonNegativeIntSchema.nullable();
const finiteNumberSchema = z.number().refine(Number.isFinite);
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const workspaceIdSchema = z.string().regex(PLAYTEST_WORKSPACE_ID_PATTERN);
const shaHexSchema = z.string().regex(PLAYTEST_SHA_PATTERN);
const isoTimestampSchema = nonEmptyStringSchema.refine((value) =>
  Number.isFinite(Date.parse(value))
);
const nonEmptyStringListSchema = z.array(nonEmptyStringSchema).readonly();

function isPlaytestJsonValue(
  value: unknown,
  depth = 0
): value is PlaytestJsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isPlaytestJsonValue(entry, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isPlaytestJsonValue(entry, depth + 1))
  );
}

const playtestJsonValueSchema = z.custom<PlaytestJsonValue>((value) =>
  isPlaytestJsonValue(value)
);

/**
The canonical run-state set. Runtime validates against it and the Console
validates responses against it, so a terminal state cannot exist on one side
of the boundary and be rejected on the other.
*/
export const CONTROL_API_PLAYTESTING_RUN_STATES = [
  "running",
  "persisting",
  "completed",
  "failed",
  "cancelled",
  "truncated"
] as const;

export const controlApiPlaytestingRunStateSchema = z.enum(
  CONTROL_API_PLAYTESTING_RUN_STATES
);

export type ControlApiPlaytestingRunState = z.infer<
  typeof controlApiPlaytestingRunStateSchema
>;

export function isControlApiPlaytestingRunState(
  value: unknown
): value is ControlApiPlaytestingRunState {
  return (
    typeof value === "string" &&
    (CONTROL_API_PLAYTESTING_RUN_STATES as readonly string[]).includes(value)
  );
}

export type ControlApiPlaytestingCancellationReason =
  PlaytestBatchCancellationReason;

const runRecordErrorSchema = z
  .object({
    code: nonEmptyStringSchema,
    category: nonEmptyStringSchema,
    retryable: z.boolean(),
    message: nonEmptyStringSchema
  })
  .readonly();

const cancellationReasonSchema =
  z.custom<ControlApiPlaytestingCancellationReason>(
    (value) => typeof value === "string" && value.trim().length > 0
  );

export const controlApiPlaytestingRunRecordSchema = z
  .object({
    batchId: nonEmptyStringSchema,
    status: controlApiPlaytestingRunStateSchema,
    cancellationReason: cancellationReasonSchema.nullable(),
    result: playtestJsonValueSchema.nullable(),
    error: runRecordErrorSchema.nullable()
  })
  .readonly();

export type ControlApiPlaytestingRunRecord = z.infer<
  typeof controlApiPlaytestingRunRecordSchema
>;

export const controlApiPlaytestingCapabilityStatusSchema = z.enum([
  "ready",
  "check-required",
  "unavailable"
]);

export type ControlApiPlaytestingCapabilityStatus = z.infer<
  typeof controlApiPlaytestingCapabilityStatusSchema
>;

export const controlApiPlaytestingCapabilityReasonSchema = z
  .object({
    code: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    severity: z.enum(["check-required", "unavailable"])
  })
  .readonly();

export type ControlApiPlaytestingCapabilityReason = z.infer<
  typeof controlApiPlaytestingCapabilityReasonSchema
>;

const capabilityReasonListSchema = z
  .array(controlApiPlaytestingCapabilityReasonSchema)
  .readonly();

function expectedCapabilityStatus(
  reasons: readonly ControlApiPlaytestingCapabilityReason[]
): ControlApiPlaytestingCapabilityStatus {
  if (reasons.some((reason) => reason.severity === "unavailable")) {
    return "unavailable";
  }
  return reasons.length > 0 ? "check-required" : "ready";
}

export const controlApiPlaytestingPolicyReadinessSchema = z
  .object({
    policyId: z.custom<PlaytestVisualPolicyId>(isPlaytestVisualPolicyId),
    status: controlApiPlaytestingCapabilityStatusSchema,
    reasons: capabilityReasonListSchema
  })
  .readonly()
  .refine(
    (entry) => entry.status === expectedCapabilityStatus(entry.reasons),
    "Policy readiness status must match its reason severities."
  );

export type ControlApiPlaytestingPolicyReadiness = z.infer<
  typeof controlApiPlaytestingPolicyReadinessSchema
>;

export const controlApiPlaytestingModeReadinessSchema = z
  .object({
    status: controlApiPlaytestingCapabilityStatusSchema,
    reasons: capabilityReasonListSchema
  })
  .readonly()
  .refine(
    (entry) => entry.status === expectedCapabilityStatus(entry.reasons),
    "Mode readiness status must match its reason severities."
  );

export type ControlApiPlaytestingModeReadiness = z.infer<
  typeof controlApiPlaytestingModeReadinessSchema
>;

const visualTargetApprovalSchema =
  z.custom<WorkspaceVisualPlaytestTargetApproval>((value) => {
    try {
      assertWorkspaceVisualPlaytestTargetApproval(value);
      return true;
    } catch {
      return false;
    }
  });

export const controlApiPlaytestingVisualTargetReadinessSchema = z
  .object({
    target: visualTargetApprovalSchema,
    eligibility: z.enum(["supported", "unsupported"]),
    reasons: capabilityReasonListSchema
  })
  .readonly();

export type ControlApiPlaytestingVisualTargetReadiness = z.infer<
  typeof controlApiPlaytestingVisualTargetReadinessSchema
>;

export const controlApiPlaytestingReadinessResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_READINESS_SCHEMA),
    workspaceId: workspaceIdSchema,
    status: z.enum(["initializing", "ready"])
  })
  .readonly();

export type ControlApiPlaytestingReadinessResponse = z.infer<
  typeof controlApiPlaytestingReadinessResponseSchema
>;

const preflightModeReadinessSchema = z
  .looseObject({
    status: controlApiPlaytestingCapabilityStatusSchema,
    reasons: z.array(z.unknown()).readonly()
  })
  .readonly();

const preflightVisualTargetSchema = z
  .looseObject({
    target: z.looseObject({}).readonly(),
    eligibility: z.enum(["supported", "unsupported"]),
    reasons: z.array(z.unknown()).readonly()
  })
  .readonly();

const preflightAutonomousVisualSchema = z
  .looseObject({
    status: controlApiPlaytestingCapabilityStatusSchema,
    reasons: z.array(z.unknown()).readonly(),
    targetStore: z.enum(["available", "unavailable"]),
    targets: z.array(preflightVisualTargetSchema).readonly()
  })
  .readonly();

const preflightModeReadinessMapSchema = z
  .looseObject({
    "adapter-accelerated": preflightModeReadinessSchema,
    "autonomous-visual": preflightAutonomousVisualSchema,
    "scripted-regression": preflightModeReadinessSchema
  })
  .readonly();

/**
Minimal capability contract verified during Console startup preflight so
incompatible Playtesting routes fail startup immediately without coupling
preflight to unrelated advisory fields.
*/
export const controlApiPlaytestingCapabilitiesPreflightSchema = z
  .looseObject({
    schema: z.literal(CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID),
    workspaceId: z.string(),
    modeReadiness: preflightModeReadinessMapSchema
  })
  .readonly();

const workspacePlaytestLimitsSchema = z.custom<WorkspacePlaytestLimits>(
  (value) =>
    isRecord(value) &&
    Number.isSafeInteger(value.workerCount) &&
    (value.workerCount as number) >= 0 &&
    Number.isSafeInteger(value.episodeCount) &&
    (value.episodeCount as number) >= 0 &&
    Number.isSafeInteger(value.maxStepsPerEpisode) &&
    (value.maxStepsPerEpisode as number) >= 0 &&
    Number.isSafeInteger(value.wallTimeMs) &&
    (value.wallTimeMs as number) >= 0
);

const visualTargetReadinessListSchema = z
  .array(controlApiPlaytestingVisualTargetReadinessSchema)
  .readonly();
const policyReadinessListSchema = z
  .array(controlApiPlaytestingPolicyReadinessSchema)
  .readonly();

const autonomousVisualReadinessSchema = z
  .object({
    status: controlApiPlaytestingCapabilityStatusSchema,
    reasons: capabilityReasonListSchema,
    targetStore: z.enum(["available", "unavailable"]),
    targets: visualTargetReadinessListSchema,
    policies: policyReadinessListSchema
  })
  .readonly()
  .refine(
    (entry) =>
      entry.status === expectedCapabilityStatus(entry.reasons) &&
      (entry.targetStore !== "unavailable" || entry.targets.length === 0),
    "Visual mode readiness must agree with its reasons and target store availability."
  );

const capabilitiesModeReadinessSchema = z
  .object({
    "adapter-accelerated": controlApiPlaytestingModeReadinessSchema,
    "autonomous-visual": autonomousVisualReadinessSchema,
    "scripted-regression": controlApiPlaytestingModeReadinessSchema
  })
  .readonly();

const runnableAssignmentSchema = z
  .object({
    scenarioId: nonEmptyStringSchema,
    scenarioFamily: nonEmptyStringSchema,
    policyId: nonEmptyStringSchema,
    policyVersion: nonEmptyStringSchema,
    cohort: nonEmptyStringSchema,
    strategy: nonEmptyStringSchema,
    maxStepsPerEpisode: z.number().int().positive()
  })
  .readonly();

const admissibleSeedSchema = z
  .object({
    seed: nonEmptyStringSchema,
    purpose: z.enum(["discovery", "confirmation", "regression"])
  })
  .readonly();

const admissibleSeedListSchema = z
  .array(admissibleSeedSchema)
  .min(1)
  .readonly();

const policyProfileSchema = z
  .object({
    policyId: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    cohort: nonEmptyStringSchema,
    strategy: nonEmptyStringSchema
  })
  .readonly();

export const controlApiPlaytestingCapabilitiesResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_CAPABILITIES_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    capabilityRevision: z.string().regex(PLAYTEST_CAPABILITY_REVISION_PATTERN),
    workspaceCatalog: z.enum(["valid", "invalid", "unavailable"]),
    workspaceEnabled: z.boolean(),
    operatorActionsAvailable: z.boolean(),
    modeReadiness: capabilitiesModeReadinessSchema,
    approved: z.boolean(),
    approvalRevision: nullableNonNegativeIntSchema,
    buildSha: shaHexSchema.nullable(),
    gameBuild: z.string().nullable(),
    allowedScenarios: nonEmptyStringListSchema,
    approvedPolicies: nonEmptyStringListSchema,
    supportedPolicies: nonEmptyStringListSchema,
    runnablePolicies: nonEmptyStringListSchema,
    unsupportedApprovedPolicies: nonEmptyStringListSchema,
    configurationStatus: z.enum(["validated", "invalid", "not-checked"]),
    maxBatchAssignments: nonNegativeIntSchema,
    runnableAssignments: z.array(runnableAssignmentSchema).readonly(),
    admissibleSeeds: admissibleSeedListSchema.nullable(),
    policyProfiles: z.array(policyProfileSchema).readonly(),
    limits: workspacePlaytestLimitsSchema.nullable(),
    issueReporting: z.enum(["disabled", "review"]),
    configuredIssueReporting: z.enum(["disabled", "review"]),
    humanStudyAllowed: z.boolean(),
    revokedAt: nonEmptyStringSchema.nullable(),
    runPreflight: z.literal("required-at-start")
  })
  .readonly()
  .superRefine((data, context) => {
    const targetIds = new Set<string>();
    const targets = data.modeReadiness["autonomous-visual"].targets;
    for (const targetReadiness of targets) {
      const target = targetReadiness.target;
      if (
        target.workspaceId !== data.workspaceId ||
        target.revokedAt !== null ||
        targetIds.has(target.targetId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Visual target readiness entries must be active, unique, and scoped to the response workspace."
        });
        return;
      }
      targetIds.add(target.targetId);
    }
  });

export type ControlApiPlaytestingCapabilitiesResponse = z.infer<
  typeof controlApiPlaytestingCapabilitiesResponseSchema
>;

export const controlApiPlaytestingSessionReferenceSchema = z
  .object({
    assignmentId: z.string().regex(PLAYTEST_ASSIGNMENT_ID_PATTERN),
    episodeId: z.string().regex(PLAYTEST_EPISODE_ID_PATTERN)
  })
  .readonly();

const sessionReferenceListSchema = z
  .array(controlApiPlaytestingSessionReferenceSchema)
  .readonly();
const assignmentIdListSchema = z
  .array(z.string().regex(PLAYTEST_ASSIGNMENT_ID_PATTERN))
  .readonly();

function hasUniqueSessionReferences(
  sessions: readonly PlaytestSessionReference[],
  expectedCount: number,
  assignmentIds?: readonly string[]
): boolean {
  if (sessions.length !== expectedCount) return false;
  const expectedAssignments =
    assignmentIds === undefined ? null : new Set(assignmentIds);
  if (
    assignmentIds !== undefined &&
    expectedAssignments?.size !== assignmentIds.length
  ) {
    return false;
  }
  const seenAssignments = new Set<string>();
  const seenEpisodes = new Set<string>();
  for (const entry of sessions) {
    if (
      seenAssignments.has(entry.assignmentId) ||
      seenEpisodes.has(entry.episodeId) ||
      (expectedAssignments !== null &&
        !expectedAssignments.has(entry.assignmentId))
    ) {
      return false;
    }
    seenAssignments.add(entry.assignmentId);
    seenEpisodes.add(entry.episodeId);
  }
  return (
    expectedAssignments === null ||
    seenAssignments.size === expectedAssignments.size
  );
}

const activeRunEntrySchema = z
  .object({
    batchId: z.string().regex(PLAYTEST_RUN_ID_PATTERN),
    assignmentCount: z.number().int().positive(),
    createdAt: nonEmptyStringSchema,
    sessions: sessionReferenceListSchema,
    status: controlApiPlaytestingRunRecordSchema
  })
  .readonly()
  .refine(
    (run) =>
      hasUniqueSessionReferences(run.sessions, run.assignmentCount) &&
      run.status.batchId === run.batchId,
    "Active run sessions and status batchId must match its declared assignment count and batchId."
  );

export const controlApiPlaytestingActiveRunsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_RUNS_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    runs: z.array(activeRunEntrySchema).readonly()
  })
  .readonly();

export type ControlApiPlaytestingActiveRunsResponse = z.infer<
  typeof controlApiPlaytestingActiveRunsResponseSchema
>;

export const controlApiPlaytestingRunStartedResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_RUN_STARTED_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    batchId: z.string().regex(PLAYTEST_RUN_ID_PATTERN),
    assignmentCount: z.number().int().positive(),
    assignmentIds: assignmentIdListSchema,
    sessions: sessionReferenceListSchema,
    createdAt: isoTimestampSchema,
    status: controlApiPlaytestingRunStateSchema
  })
  .readonly()
  .refine(
    (data) =>
      data.assignmentIds.length === data.assignmentCount &&
      hasUniqueSessionReferences(
        data.sessions,
        data.assignmentCount,
        data.assignmentIds
      ),
    "Started run assignmentIds and session references must match its assignment count."
  );

export type ControlApiPlaytestingRunStartedResponse = z.infer<
  typeof controlApiPlaytestingRunStartedResponseSchema
>;

export const controlApiPlaytestingRunRequestLookupResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_RUN_REQUEST_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    requestId: z.string().regex(PLAYTEST_REQUEST_ID_PATTERN),
    state: z.enum(["not-found", "expired", "pending", "accepted"]),
    batchId: z.string().regex(PLAYTEST_RUN_ID_PATTERN).nullable(),
    assignmentCount: z.number().int().positive().nullable(),
    assignmentIds: assignmentIdListSchema,
    sessions: sessionReferenceListSchema,
    createdAt: isoTimestampSchema.nullable(),
    status: controlApiPlaytestingRunStateSchema.nullable()
  })
  .readonly()
  .refine((data) => {
    if (data.state === "not-found" || data.state === "expired") {
      return (
        data.batchId === null &&
        data.assignmentCount === null &&
        data.assignmentIds.length === 0 &&
        hasUniqueSessionReferences(data.sessions, 0) &&
        data.createdAt === null &&
        data.status === null
      );
    }
    if (
      data.batchId === null ||
      data.assignmentCount === null ||
      data.createdAt === null
    ) {
      return false;
    }
    if (data.state === "pending") {
      return (
        data.assignmentIds.length === 0 &&
        hasUniqueSessionReferences(data.sessions, 0) &&
        data.status === null
      );
    }
    return (
      data.assignmentIds.length === data.assignmentCount &&
      hasUniqueSessionReferences(
        data.sessions,
        data.assignmentCount,
        data.assignmentIds
      ) &&
      data.status !== null
    );
  }, "Run request lookup fields must agree with the request state.");

export type ControlApiPlaytestingRunRequestLookupResponse = z.infer<
  typeof controlApiPlaytestingRunRequestLookupResponseSchema
>;

export const controlApiPlaytestingRunStatusResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_RUN_STATUS_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    run: controlApiPlaytestingRunRecordSchema
  })
  .readonly();

export type ControlApiPlaytestingRunStatusResponse = z.infer<
  typeof controlApiPlaytestingRunStatusResponseSchema
>;

const analysisPacketReferenceSchema = z
  .object({
    episodeId: nonEmptyStringSchema,
    batchId: nonEmptyStringSchema,
    packetId: nonEmptyStringSchema
  })
  .readonly();

const analysisReceiptSchema = z
  .object({
    episodeId: nonEmptyStringSchema,
    batchId: nonEmptyStringSchema.nullable(),
    reason: nonEmptyStringSchema,
    detail: nonEmptyStringSchema
  })
  .readonly();

const analysisBudgetEntrySchema = z
  .object({
    batchId: nonEmptyStringSchema,
    reviewCap: nonNegativeIntSchema,
    actualCritiques: nonNegativeIntSchema,
    reserved: nonNegativeIntSchema,
    requested: nonNegativeIntSchema,
    remaining: nonNegativeIntSchema
  })
  .readonly();

const analystReviewSummarySchema = z
  .object({
    episodeId: nonEmptyStringSchema,
    reviewId: nonEmptyStringSchema,
    status: z.enum(["verified", "corroborated", "hypothesis", "not observed"])
  })
  .readonly();

export const controlApiPlaytestingAnalystRunSchema = z
  .object({
    analysisId: nonEmptyStringSchema,
    workspaceId: nonEmptyStringSchema,
    analysisKind: z.enum(["confirmatory", "discovery"]).optional(),
    requireFindings: z.boolean().optional(),
    status: z.enum(["running", "completed", "partial", "failed"]),
    createdAt: nonEmptyStringSchema,
    finishedAt: nonEmptyStringSchema.nullable(),
    requestedEpisodeIds: nonEmptyStringListSchema,
    packets: z.array(analysisPacketReferenceSchema).readonly(),
    receipts: z.array(analysisReceiptSchema).readonly(),
    budget: z.array(analysisBudgetEntrySchema).readonly(),
    reviews: z.array(analystReviewSummarySchema).readonly(),
    synthesisId: nonEmptyStringSchema.nullable(),
    error: z.string().nullable()
  })
  .readonly()
  .refine((run) => {
    const accountedEpisodeIds = [
      ...run.packets.map((packet) => packet.episodeId),
      ...run.receipts.map((receipt) => receipt.episodeId)
    ];
    return (
      run.packets.length + run.receipts.length ===
        run.requestedEpisodeIds.length &&
      new Set(accountedEpisodeIds).size === run.requestedEpisodeIds.length &&
      accountedEpisodeIds.every((episodeId) =>
        run.requestedEpisodeIds.includes(episodeId)
      )
    );
  }, "Analyst run packets and receipts must account for every requested episode once.");

export type ControlApiPlaytestingAnalystRun = z.infer<
  typeof controlApiPlaytestingAnalystRunSchema
>;

const preparedPacketEntrySchema = z
  .object({
    episodeId: nonEmptyStringSchema,
    batchId: nonEmptyStringSchema,
    packet: z.custom<PlaytestEvidencePacket>(isRecord),
    artifact: z.custom<PlaytestArtifactReference>(isRecord)
  })
  .readonly();

export const controlApiPlaytestingPacketPreparationResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID),
    operation: z.literal("prepare"),
    workspaceId: workspaceIdSchema,
    requested: nonNegativeIntSchema,
    packets: z.array(preparedPacketEntrySchema).readonly(),
    receipts: z.array(analysisReceiptSchema).readonly(),
    budget: z.array(analysisBudgetEntrySchema).readonly(),
    analysis: z.null()
  })
  .readonly();

export type ControlApiPlaytestingPacketPreparationResponse = z.infer<
  typeof controlApiPlaytestingPacketPreparationResponseSchema
>;

export const controlApiPlaytestingAnalysisDispatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_ANALYSIS_SCHEMA_ID),
    operation: z.literal("dispatch"),
    workspaceId: workspaceIdSchema,
    requested: nonNegativeIntSchema,
    packets: z.array(analysisPacketReferenceSchema).readonly(),
    receipts: z.array(analysisReceiptSchema).readonly(),
    budget: z.array(analysisBudgetEntrySchema).readonly(),
    analysis: controlApiPlaytestingAnalystRunSchema.nullable()
  })
  .readonly()
  .refine((data) => {
    const accounted = [
      ...data.packets.map((packet) => packet.episodeId),
      ...data.receipts.map((receipt) => receipt.episodeId)
    ];
    if (
      accounted.length !== data.requested ||
      new Set(accounted).size !== data.requested ||
      (data.packets.length > 0 && data.analysis === null)
    ) {
      return false;
    }
    if (data.analysis === null) return true;
    return (
      data.analysis.workspaceId === data.workspaceId &&
      data.analysis.requestedEpisodeIds.length === data.requested &&
      data.analysis.requestedEpisodeIds.every((id) => accounted.includes(id))
    );
  }, "Analysis dispatch must account for every requested session and bind its analysis record to the workspace.");

export type ControlApiPlaytestingAnalysisDispatchResponse = z.infer<
  typeof controlApiPlaytestingAnalysisDispatchResponseSchema
>;

export const controlApiPlaytestingAnalysisResponseSchema = z.discriminatedUnion(
  "operation",
  [
    controlApiPlaytestingPacketPreparationResponseSchema,
    controlApiPlaytestingAnalysisDispatchResponseSchema
  ]
);

export type ControlApiPlaytestingAnalysisResponse = z.infer<
  typeof controlApiPlaytestingAnalysisResponseSchema
>;

export const controlApiPlaytestingAnalysesResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_ANALYSES_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    runs: z.array(controlApiPlaytestingAnalystRunSchema).readonly(),
    syntheses: z
      .array(z.custom<PlaytestCrossSessionSynthesis>(isRecord))
      .readonly()
  })
  .readonly()
  .refine(
    (data) => data.runs.every((run) => run.workspaceId === data.workspaceId),
    "Every analyst run must belong to the requested workspace."
  );

export type ControlApiPlaytestingAnalysesResponse = z.infer<
  typeof controlApiPlaytestingAnalysesResponseSchema
>;

export const controlApiPlaytestingReviewClaimSchema = z
  .object({
    hypothesisId: z.string(),
    text: z.string(),
    status: z.enum(["hypothesis", "not observed"])
  })
  .readonly();

export type ControlApiPlaytestingReviewClaim = z.infer<
  typeof controlApiPlaytestingReviewClaimSchema
>;

export const controlApiPlaytestingReviewFindingSchema = z
  .object({
    findingId: z.string(),
    title: z.string(),
    evidenceStatus: z.enum([
      "verified",
      "corroborated",
      "hypothesis",
      "not observed"
    ])
  })
  .readonly();

export type ControlApiPlaytestingReviewFinding = z.infer<
  typeof controlApiPlaytestingReviewFindingSchema
>;

export const controlApiPlaytestingReviewSchema = z
  .object({
    reviewId: nonEmptyStringSchema,
    episodeId: nonEmptyStringSchema,
    workspaceId: workspaceIdSchema,
    kind: z.enum(["discovery", "confirmatory"]),
    status: nonEmptyStringSchema,
    createdAt: nonEmptyStringSchema,
    observationCount: nonNegativeIntSchema,
    interpretationCount: nonNegativeIntSchema,
    findingCount: nonNegativeIntSchema,
    headline: z.string(),
    summary: z.string(),
    hypotheses: z.array(controlApiPlaytestingReviewClaimSchema).readonly(),
    findings: z.array(controlApiPlaytestingReviewFindingSchema).readonly(),
    evidenceRefs: z
      .array(z.custom<PlaytestEvidenceLocator>(isRecord))
      .readonly()
  })
  .readonly();

export type ControlApiPlaytestingReview = z.infer<
  typeof controlApiPlaytestingReviewSchema
>;

export const controlApiPlaytestingReviewsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_REVIEWS_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    total: nonNegativeIntSchema,
    rows: z.array(controlApiPlaytestingReviewSchema).readonly(),
    nextCursor: nonEmptyStringSchema.nullable()
  })
  .readonly()
  .refine(
    (data) => data.rows.every((row) => row.workspaceId === data.workspaceId),
    "Every review row must belong to the requested workspace."
  );

export type ControlApiPlaytestingReviewsResponse = z.infer<
  typeof controlApiPlaytestingReviewsResponseSchema
>;

export const controlApiPlaytestingRunCancellationRequestSchema = z
  .strictObject({
    expectedStatus: z.literal("running")
  })
  .readonly();

export type ControlApiPlaytestingRunCancellationRequest = z.infer<
  typeof controlApiPlaytestingRunCancellationRequestSchema
>;

export const controlApiPlaytestingRunCancellationResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_RUN_CANCELLATION_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    batchId: nonEmptyStringSchema,
    cancellationRequested: z.boolean()
  })
  .readonly();

export type ControlApiPlaytestingRunCancellationResponse = z.infer<
  typeof controlApiPlaytestingRunCancellationResponseSchema
>;

export const controlApiPlaytestingComparisonDecisionRequestSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    comparisonId: z.string().regex(PLAYTEST_ENTITY_ID_PATTERN),
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    disposition: z.enum(["promote", "hold"]),
    reason: nonEmptyStringSchema.refine((value) => value.length <= 4000)
  })
  .readonly();

export type ControlApiPlaytestingComparisonDecisionRequest = z.infer<
  typeof controlApiPlaytestingComparisonDecisionRequestSchema
>;

export const controlApiPlaytestingComparisonDecisionResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_COMPARISON_DECISION_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    comparison: z.custom<PlaytestComparison>(
      (value) =>
        isRecord(value) &&
        typeof value.comparisonId === "string" &&
        Number.isSafeInteger(value.version) &&
        (value.ownerDisposition === "promote" ||
          value.ownerDisposition === "hold") &&
        typeof value.ownerDecisionReason === "string" &&
        typeof value.ownerDecisionBy === "string" &&
        value.ownerDecisionBy.trim().length > 0
    )
  })
  .readonly();

export type ControlApiPlaytestingComparisonDecisionResponse = z.infer<
  typeof controlApiPlaytestingComparisonDecisionResponseSchema
>;

const HUMAN_RESTRICTED_FIELDS = new Set([
  "participantId",
  "pseudonymousParticipantId",
  "responseId",
  "responses",
  "freeText",
  "text"
]);

function hasNoRestrictedHumanFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoRestrictedHumanFields);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, entry]) =>
      !HUMAN_RESTRICTED_FIELDS.has(key) && hasNoRestrictedHumanFields(entry)
  );
}

const humanSuppressionStateSchema = z.enum([
  "suppressed",
  "partially-suppressed",
  "unsuppressed"
]);

const humanPreferenceCountsSchema = z
  .strictObject({
    eligibleParticipants: nonNegativeIntSchema,
    preferA: nonNegativeIntSchema,
    preferB: nonNegativeIntSchema,
    ties: nonNegativeIntSchema,
    unableToJudge: nonNegativeIntSchema,
    missing: nonNegativeIntSchema
  })
  .readonly()
  .refine(
    (counts) =>
      counts.eligibleParticipants ===
      counts.preferA +
        counts.preferB +
        counts.ties +
        counts.unableToJudge +
        counts.missing
  );

const humanPreferenceIntervalSchema = z
  .object({
    lower: finiteNumberSchema.refine((value) => value >= 0),
    upper: finiteNumberSchema.refine((value) => value <= 1),
    method: nonEmptyStringSchema,
    libraryVersion: nonEmptyStringSchema,
    confidenceLevel: finiteNumberSchema.refine(
      (value) => value > 0 && value < 1
    ),
    resamples: nullableNonNegativeIntSchema,
    seed: nonEmptyStringSchema.nullable()
  })
  .readonly()
  .refine((interval) => interval.lower <= interval.upper);

const humanPreferenceSummarySchema = z
  .strictObject({
    analysisPlanRef: nonEmptyStringSchema,
    suppressionState: z.enum(["suppressed", "unsuppressed"]),
    incompleteExposurePairs: nullableNonNegativeIntSchema,
    counts: humanPreferenceCountsSchema.nullable(),
    interval: humanPreferenceIntervalSchema.nullable(),
    decision: z.enum([
      "supports-b-preference",
      "supports-a-preference",
      "no-material-preference",
      "inconclusive"
    ]),
    reasons: nonEmptyStringListSchema
  })
  .readonly()
  .refine(
    (preference) =>
      (preference.counts !== null ||
        (preference.interval === null &&
          preference.decision === "inconclusive")) &&
      (preference.interval !== null || preference.decision === "inconclusive")
  );

const nullableCategoryCountsSchema = z
  .record(z.string(), nullableNonNegativeIntSchema)
  .readonly();

const humanValidationItemSchema = z
  .object({
    itemId: nonEmptyStringSchema,
    suppressionState: humanSuppressionStateSchema,
    mean: nullableFiniteNumberSchema,
    respondentCount: nullableNonNegativeIntSchema,
    missingCount: nullableNonNegativeIntSchema,
    categoryCounts: nullableCategoryCountsSchema.nullable(),
    unit: nonEmptyStringSchema
  })
  .readonly();

const humanValidationConstructSchema = z
  .object({
    constructId: nonEmptyStringSchema,
    suppressionState: humanSuppressionStateSchema,
    mean: nullableFiniteNumberSchema,
    respondentCount: nullableNonNegativeIntSchema,
    missingCount: nullableNonNegativeIntSchema,
    unit: nonEmptyStringSchema
  })
  .readonly();

const humanValidationPairedDifferenceSchema = z
  .object({
    itemId: nonEmptyStringSchema,
    suppressionState: z.enum(["suppressed", "unsuppressed"]),
    pairedParticipants: nullableNonNegativeIntSchema,
    meanDifference: nullableFiniteNumberSchema
  })
  .readonly();

const humanValidationSummarySchema = z
  .object({
    revision: nonNegativeIntSchema,
    benchmarkId: nonEmptyStringSchema.nullable(),
    instrument: nonEmptyStringSchema,
    measurementVersion: nonEmptyStringSchema,
    suppressionState: humanSuppressionStateSchema,
    retainedParticipants: nullableNonNegativeIntSchema,
    items: z.array(humanValidationItemSchema).readonly(),
    constructs: z.array(humanValidationConstructSchema).readonly(),
    pairedDifferences: z.array(humanValidationPairedDifferenceSchema).readonly()
  })
  .readonly();

const humanValidationEnvelopeSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_HUMAN_VALIDATION_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    studyId: z.string().regex(PLAYTEST_ENTITY_ID_PATTERN),
    buildSha: shaHexSchema,
    preference: humanPreferenceSummarySchema.nullable(),
    summary: humanValidationSummarySchema.nullable()
  })
  .readonly();

export const controlApiPlaytestingHumanValidationResponseSchema = z
  .unknown()
  .refine(hasNoRestrictedHumanFields, {
    message:
      "Restricted participant or free-text fields must not cross this boundary."
  })
  .pipe(
    humanValidationEnvelopeSchema
  ) as z.ZodType<ControlApiPlaytestingHumanValidationResponse>;

export interface ControlApiPlaytestingHumanValidationResponse {
  readonly schema: "autodev-control-playtesting-human-validation-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly buildSha: string;
  readonly preference: {
    readonly analysisPlanRef: string;
    readonly suppressionState: "suppressed" | "unsuppressed";
    readonly incompleteExposurePairs: number | null;
    readonly counts: PlaytestHumanPreferenceCounts | null;
    readonly interval: PlaytestNumericInterval | null;
    readonly decision: PlaytestPreferenceSensitivityDecision;
    readonly reasons: readonly string[];
  } | null;
  readonly summary: {
    readonly revision: number;
    readonly benchmarkId: string | null;
    readonly instrument: string;
    readonly measurementVersion: string;
    readonly suppressionState:
      "suppressed" | "partially-suppressed" | "unsuppressed";
    readonly retainedParticipants: number | null;
    readonly items: readonly {
      readonly itemId: string;
      readonly suppressionState:
        "suppressed" | "partially-suppressed" | "unsuppressed";
      readonly mean: number | null;
      readonly respondentCount: number | null;
      readonly missingCount: number | null;
      readonly categoryCounts: Readonly<Record<string, number | null>> | null;
      readonly unit: string;
    }[];
    readonly constructs: readonly {
      readonly constructId: string;
      readonly suppressionState:
        "suppressed" | "partially-suppressed" | "unsuppressed";
      readonly mean: number | null;
      readonly respondentCount: number | null;
      readonly missingCount: number | null;
      readonly unit: string;
    }[];
    readonly pairedDifferences: readonly {
      readonly itemId: string;
      readonly suppressionState: "suppressed" | "unsuppressed";
      readonly pairedParticipants: number | null;
      readonly meanDifference: number | null;
    }[];
  } | null;
}

export const controlApiPlaytestingHumanImportResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_HUMAN_IMPORT_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    studyId: nonEmptyStringSchema,
    revision: nonNegativeIntSchema,
    acceptedCount: nonNegativeIntSchema,
    unchangedCount: nonNegativeIntSchema,
    rejectedCount: nonNegativeIntSchema,
    rejectedByReason: z.record(z.string(), nonNegativeIntSchema).readonly(),
    quarantinedCount: nonNegativeIntSchema,
    retainedParticipants: nullableNonNegativeIntSchema
  })
  .readonly();

export type ControlApiPlaytestingHumanImportResponse = z.infer<
  typeof controlApiPlaytestingHumanImportResponseSchema
>;

export const controlApiPlaytestingHumanConsentResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_HUMAN_CONSENT_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    studyId: nonEmptyStringSchema,
    recorded: z.literal(true)
  })
  .readonly();

export type ControlApiPlaytestingHumanConsentResponse = z.infer<
  typeof controlApiPlaytestingHumanConsentResponseSchema
>;

export const controlApiPlaytestingHumanWithdrawalResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_HUMAN_WITHDRAWAL_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    studyId: nonEmptyStringSchema,
    revision: nonNegativeIntSchema,
    retainedParticipants: nullableNonNegativeIntSchema
  })
  .readonly();

export type ControlApiPlaytestingHumanWithdrawalResponse = z.infer<
  typeof controlApiPlaytestingHumanWithdrawalResponseSchema
>;

const humanQuarantineEntrySchema = z
  .object({
    responseIds: nonEmptyStringListSchema,
    instrument: nonEmptyStringSchema,
    reason: z.literal("duplicate-participant-episode-instrument")
  })
  .readonly();

const preferenceQuarantineEntrySchema = z
  .object({
    responseIds: nonEmptyStringListSchema,
    buildAId: nonEmptyStringSchema,
    buildBId: nonEmptyStringSchema,
    reason: z.literal("duplicate-participant-pair-preference")
  })
  .readonly();

export const controlApiPlaytestingHumanQuarantinesResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_HUMAN_QUARANTINES_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    studyId: nonEmptyStringSchema,
    quarantines: z.array(humanQuarantineEntrySchema).readonly(),
    preferenceQuarantines: z.array(preferenceQuarantineEntrySchema).readonly()
  })
  .readonly();

export type ControlApiPlaytestingHumanQuarantinesResponse = z.infer<
  typeof controlApiPlaytestingHumanQuarantinesResponseSchema
>;

export const controlApiPlaytestingHumanStudyRegistrationResponseSchema = z
  .object({
    schema: z.literal(
      CONTROL_API_PLAYTESTING_HUMAN_STUDY_REGISTRATION_SCHEMA_ID
    ),
    workspaceId: workspaceIdSchema,
    studyId: nonEmptyStringSchema,
    benchmarkId: nonEmptyStringSchema,
    approved: z.literal(true),
    idempotent: z.boolean()
  })
  .readonly();

export type ControlApiPlaytestingHumanStudyRegistrationResponse = z.infer<
  typeof controlApiPlaytestingHumanStudyRegistrationResponseSchema
>;

/**
Resource names exposed by the authenticated Playtesting API.
*/
export const CONTROL_API_PLAYTESTING_RESOURCES = [
  "batches",
  "episodes",
  "findings",
  "comparisons",
  "benchmarks",
  "experiments",
  "human-studies"
] as const;

export const controlApiPlaytestingResourceSchema = z.enum(
  CONTROL_API_PLAYTESTING_RESOURCES
);

export type ControlApiPlaytestingResource = z.infer<
  typeof controlApiPlaytestingResourceSchema
>;

export type ControlApiPlaytestingEntityMap = {
  readonly batches: PlaytestBatch;
  readonly episodes: PlaytestEpisode;
  readonly findings: PlaytestFinding;
  readonly comparisons: PlaytestComparison;
  readonly benchmarks: PlaytestBenchmark;
  readonly experiments: PlaytestExperiment;
  readonly "human-studies": HumanPlaytestStudy;
};

export interface ControlApiPlaytestingPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface ControlApiPlaytestingPageResponse<T> {
  readonly schema: "autodev-control-playtesting-page-v1";
  readonly workspaceId: string;
  readonly resource: ControlApiPlaytestingResource;
  readonly readOnly: true;
  readonly page: ControlApiPlaytestingPage<T>;
}

const VALID_BATCH_SCHEMAS = new Set<string>([
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA_V3,
  PLAYTESTS_BATCH_SCHEMA_V2,
  PLAYTESTS_BATCH_SCHEMA_V1
]);

const VALID_EPISODE_SCHEMAS = new Set<string>([
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA_V6,
  PLAYTESTS_EPISODE_SCHEMA_V5,
  PLAYTESTS_EPISODE_SCHEMA_V4,
  PLAYTESTS_EPISODE_SCHEMA_V3,
  PLAYTESTS_EPISODE_SCHEMA_V2,
  PLAYTESTS_EPISODE_SCHEMA_V1
]);

const RESOURCE_SCHEMAS: Readonly<
  Record<ControlApiPlaytestingResource, string>
> = {
  batches: PLAYTESTS_BATCH_SCHEMA,
  episodes: PLAYTESTS_EPISODE_SCHEMA,
  findings: "",
  comparisons: PLAYTESTS_COMPARISON_SCHEMA,
  benchmarks: "",
  experiments: "autodev-playtest-experiment-v1",
  "human-studies": "autodev-playtest-human-study-v1"
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasRecordSchema(
  value: unknown,
  resource: ControlApiPlaytestingResource
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (resource === "batches") {
    return (
      typeof value.schema === "string" && VALID_BATCH_SCHEMAS.has(value.schema)
    );
  }
  if (resource === "episodes") {
    return (
      typeof value.schema === "string" &&
      VALID_EPISODE_SCHEMAS.has(value.schema)
    );
  }
  const expectedSchema = RESOURCE_SCHEMAS[resource];
  return expectedSchema === "" || value.schema === expectedSchema;
}

function isValidBatchRecord(
  value: Record<string, unknown>,
  workspaceId: string
): boolean {
  const batch = value as unknown as PlaytestBatch;
  if (batch.coverageManifest !== null) {
    try {
      assertPlaytestCoverageManifest(batch.coverageManifest);
    } catch {
      return false;
    }
    if (
      batch.assignmentInventory.status !== "frozen" ||
      batch.coverageManifest.workspaceId !== batch.workspaceId ||
      batch.coverageManifest.batchId !== batch.batchId ||
      batch.coverageManifest.buildSha !== batch.buildSha ||
      batch.coverageManifest.rubricHash !== batch.rubricHash ||
      batch.coverageManifest.assignmentManifestHash !==
        batch.assignmentInventory.manifest.contentHash ||
      batch.coverageManifest.assignedEpisodes !== batch.budget.assignedEpisodes
    ) {
      return false;
    }
  }
  return (
    batch.workspaceId === workspaceId &&
    isNonEmptyString(batch.batchId) &&
    isCount(batch.revision) &&
    Array.isArray(batch.policyIds) &&
    isCount(batch.counts?.assigned)
  );
}

function isValidEpisodeRecord(
  value: Record<string, unknown>,
  workspaceId: string
): boolean {
  const episode = value as unknown as PlaytestEpisode;
  try {
    assertPlaytestExecutionProvenance(episode.executionProvenance);
    assertPlaytestNumericResults(episode.metrics);
  } catch {
    return false;
  }
  const termination = episode.termination;
  return (
    episode.identity?.workspaceId === workspaceId &&
    isNonEmptyString(episode.episodeId) &&
    isNonEmptyString(episode.batchId) &&
    isCount(episode.revision) &&
    isCount(episode.stepCount) &&
    Array.isArray(episode.frames) &&
    isRecord(termination) &&
    (PLAYTESTS_EPISODE_TERMINATION_REASONS as readonly unknown[]).includes(
      termination.reason
    ) &&
    (termination.step === null || isCount(termination.step))
  );
}

function isValidPlaytestRecord<R extends ControlApiPlaytestingResource>(
  value: unknown,
  resource: R,
  workspaceId: string
): value is ControlApiPlaytestingEntityMap[R] {
  if (!hasRecordSchema(value, resource)) return false;
  switch (resource) {
    case "batches": {
      return isValidBatchRecord(value, workspaceId);
    }
    case "episodes": {
      return isValidEpisodeRecord(value, workspaceId);
    }
    case "findings": {
      const finding = value as unknown as PlaytestFinding;
      return (
        isNonEmptyString(finding.findingId) &&
        isNonEmptyString(finding.title) &&
        isCount(finding.version) &&
        (finding.affectedEpisodes === null ||
          isCount(finding.affectedEpisodes)) &&
        (finding.totalEligibleEpisodes === null ||
          isCount(finding.totalEligibleEpisodes)) &&
        (finding.affectedOpportunities === null ||
          isCount(finding.affectedOpportunities)) &&
        (finding.totalEligibleOpportunities === null ||
          isCount(finding.totalEligibleOpportunities)) &&
        Array.isArray(finding.evidenceRefs)
      );
    }
    case "comparisons": {
      const comparison = value as unknown as PlaytestComparison;
      return (
        isNonEmptyString(comparison.comparisonId) &&
        isNonEmptyString(comparison.benchmarkId) &&
        isCount(comparison.version) &&
        Array.isArray(comparison.metrics)
      );
    }
    case "benchmarks": {
      const benchmark = value as unknown as PlaytestBenchmark;
      return (
        benchmark.workspaceId === workspaceId &&
        isNonEmptyString(benchmark.benchmarkId) &&
        isCount(benchmark.version) &&
        PLAYTEST_SHA_PATTERN.test(benchmark.referenceBuildSha)
      );
    }
    case "experiments": {
      const experiment = value as unknown as PlaytestExperiment;
      return (
        experiment.workspaceId === workspaceId &&
        isNonEmptyString(experiment.experimentId) &&
        isCount(experiment.version) &&
        Array.isArray(experiment.findingIds)
      );
    }
    case "human-studies": {
      const study = value as unknown as HumanPlaytestStudy;
      return (
        study.workspaceId === workspaceId &&
        isNonEmptyString(study.studyId) &&
        isCount(study.version) &&
        isNonEmptyString(study.instrumentVersion) &&
        !("participantId" in value) &&
        !("responses" in value)
      );
    }
    default: {
      return false;
    }
  }
}

export function controlApiPlaytestingPageResponseSchema<
  R extends ControlApiPlaytestingResource
>(
  resource: R
): z.ZodType<
  ControlApiPlaytestingPageResponse<ControlApiPlaytestingEntityMap[R]>
> {
  const rowSchema = z.custom<ControlApiPlaytestingEntityMap[R]>();
  const pageSchema = z
    .object({
      rows: z.array(rowSchema).readonly(),
      total: nonNegativeIntSchema,
      nextCursor: nonEmptyStringSchema.nullable()
    })
    .readonly();
  return z
    .object({
      schema: z.literal(CONTROL_API_PLAYTESTING_PAGE_SCHEMA_ID),
      workspaceId: workspaceIdSchema,
      resource: z.literal(resource),
      readOnly: z.literal(true),
      page: pageSchema
    })
    .readonly()
    .refine(
      (data) =>
        data.page.rows.every((row) =>
          isValidPlaytestRecord(row, resource, data.workspaceId)
        ),
      "Every page row must satisfy the Playtesting resource contract for the declared workspace."
    ) as z.ZodType<
    ControlApiPlaytestingPageResponse<ControlApiPlaytestingEntityMap[R]>
  >;
}

const sessionReviewPacketArtifactSchema = z
  .looseObject({
    artifactId: nonEmptyStringSchema,
    sha256: shaHexSchema,
    bytes: nonNegativeIntSchema,
    mediaType: z.literal(
      "application/vnd.autodev.playtest-evidence-packet+json"
    )
  })
  .readonly();

const sessionReviewEvidencePacketSchema = z
  .looseObject({
    packetId: nonEmptyStringSchema,
    artifact: sessionReviewPacketArtifactSchema
  })
  .readonly();

const sessionReviewSchema = z
  .looseObject({
    schema: z.literal(PLAYTESTS_SESSION_REVIEW_SCHEMA),
    episodeId: nonEmptyStringSchema,
    reviewId: nonEmptyStringSchema,
    version: nonNegativeIntSchema,
    authorRole: z.literal("playtest-analyst"),
    evidencePacket: sessionReviewEvidencePacketSchema.nullable(),
    findings: z.array(z.unknown()).readonly(),
    evidenceRefs: z.array(z.unknown()).readonly()
  })
  .readonly();

export const controlApiPlaytestingVisualAssignmentSchema = z
  .strictObject({
    targetId: nonEmptyStringSchema,
    targetApprovalId: nonEmptyStringSchema,
    targetRevision: z.number().int().positive(),
    targetOrigin: nonEmptyStringSchema,
    areasOfFocus: z
      .string()
      .refine((value) => value.length > 0 && value.length <= 2000)
      .nullable()
  })
  .readonly();

export type ControlApiPlaytestingVisualAssignment = z.infer<
  typeof controlApiPlaytestingVisualAssignmentSchema
>;

const playtestEpisodeCustomSchema = z.custom<PlaytestEpisode>(isRecord);
const nullableLatestReviewSchema = z.custom<PlaytestSessionReview | null>(
  (value) => value === null || sessionReviewSchema.safeParse(value).success
);
const nullableLatestDiscoveryReviewSchema =
  z.custom<PlaytestDiscoverySessionReview | null>((value) => {
    if (value === null) return true;
    try {
      assertPlaytestDiscoverySessionReview(value);
      return true;
    } catch {
      return false;
    }
  });

export const controlApiPlaytestingEpisodeDetailResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_DETAIL_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    resource: z.literal("episode"),
    readOnly: z.literal(true),
    record: playtestEpisodeCustomSchema,
    latestReview: nullableLatestReviewSchema,
    latestDiscoveryReview: nullableLatestDiscoveryReviewSchema,
    visualAssignment: controlApiPlaytestingVisualAssignmentSchema.nullable()
  })
  .readonly()
  .refine((data) => {
    if (!isValidPlaytestRecord(data.record, "episodes", data.workspaceId)) {
      return false;
    }
    const episode = data.record;
    if (
      data.latestReview !== null &&
      data.latestReview.episodeId !== episode.episodeId
    ) {
      return false;
    }
    if (
      data.latestDiscoveryReview !== null &&
      (data.latestDiscoveryReview.workspaceId !== data.workspaceId ||
        data.latestDiscoveryReview.episodeId !== episode.episodeId)
    ) {
      return false;
    }
    if (episode.executionProvenance.mode !== "autonomous-visual") {
      return data.visualAssignment === null;
    }
    const source = episode.executionProvenance.source;
    return (
      data.visualAssignment !== null &&
      data.visualAssignment.targetId === source.targetId &&
      data.visualAssignment.targetOrigin === source.targetOrigin
    );
  }, "Episode detail must satisfy episode, review, and visual assignment invariants.");

export type ControlApiPlaytestingEpisodeDetailResponse = z.infer<
  typeof controlApiPlaytestingEpisodeDetailResponseSchema
>;

export const controlApiPlaytestingWindowResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PLAYTESTING_WINDOW_SCHEMA_ID),
    workspaceId: workspaceIdSchema,
    episodeId: nonEmptyStringSchema,
    artifactId: nonEmptyStringSchema,
    sha256: shaHexSchema,
    mediaType: nonEmptyStringSchema,
    startStep: nonNegativeIntSchema,
    endStep: nonNegativeIntSchema,
    sourceLineCount: nonNegativeIntSchema,
    omittedLineCount: nonNegativeIntSchema,
    entries: z.array(playtestJsonValueSchema).readonly()
  })
  .readonly();

export type ControlApiPlaytestingWindowResponse = z.infer<
  typeof controlApiPlaytestingWindowResponseSchema
>;
