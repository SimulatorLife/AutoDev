/**
 * Versioned, game-independent TypeScript contracts for AutoDev playtesting.
 *
 * The contracts here are the Core-owned portion of the playtesting target
 * state. They are deliberately infrastructure-free: no imports from runtime,
 * data, console, the network, or any framework. Every artifact carries
 * provenance, units, denominators, coverage, missingness reasons and a
 * `measurementVersion` so a downstream consumer (Runtime runner, Data
 * projector, Console renderer) cannot silently rewrite history or fabricate a
 * result that the upstream evidence never supported.
 *
 * This module only declares types and small `is*` predicates; the heavy
 * schema/registry/measurement/sampling/comparison/evidence logic lives in
 * its own files and is consumed through `./index.ts`.
 */

import type { AgentRole } from "../agents/types.ts";

/** Current Core schema version for the playtesting artifact family. */
export const PLAYTESTS_SCHEMA_VERSION = 1 as const;

/** Identifier for the v1 JSON-RPC game-adapter envelope family. */
export const PLAYTESTS_PROTOCOL = "autodev-playtest-adapter-v1" as const;

/** Identifier for the v1 metric-registry family. */
export const PLAYTESTS_REGISTRY_SCHEMA =
  "autodev-playtest-registry-v1" as const;

/** Identifier for the v1 sampling contract. */
export const PLAYTESTS_SAMPLING_SCHEMA =
  "autodev-playtest-sampling-v1" as const;

/** Identifier for the v1 comparison contract. */
export const PLAYTESTS_COMPARISON_SCHEMA =
  "autodev-playtest-comparison-v1" as const;

/** Identifier for the v1 human-study import contract. */
export const PLAYTESTS_HUMAN_STUDY_SCHEMA =
  "autodev-playtest-human-study-v1" as const;

/** Single source of truth for the supported JSON-RPC error codes. */
export const PLAYTESTS_ADAPTER_ERROR_CODES = [
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "internal_error",
  "revision_conflict",
  "cancelled",
  "step_indeterminate",
  "policy_unavailable",
  "unsupported_modality",
  "rate_limited",
  "transport_eof"
] as const;

export type PlaytestAdapterErrorCode =
  (typeof PLAYTESTS_ADAPTER_ERROR_CODES)[number];

/** Capabilities the adapter may advertise to Runtime; closed vocabulary. */
export const PLAYTESTS_ADAPTER_CAPABILITIES = [
  "headless",
  "browser",
  "native-visual",
  "deterministic-seed",
  "snapshot-replay",
  "counterfactual-branch",
  "human-instrument-import",
  "pxi-import"
] as const;

export type PlaytestAdapterCapability =
  (typeof PLAYTESTS_ADAPTER_CAPABILITIES)[number];

/** JSON-RPC methods the Core protocol currently supports. */
export const PLAYTESTS_ADAPTER_METHODS = [
  "initialize",
  "advertise_capabilities",
  "describe_observation",
  "request_action",
  "submit_step",
  "cancel_episode",
  "finalize_episode"
] as const;

export type PlaytestAdapterMethod = (typeof PLAYTESTS_ADAPTER_METHODS)[number];

/** Polarity of a metric: lower is better, higher is better, or descriptive. */
export const PLAYTESTS_POLARITIES = [
  "lower",
  "higher",
  "target-band",
  "descriptive"
] as const;

export type PlaytestPolarity = (typeof PLAYTESTS_POLARITIES)[number];

/** Allowed evidence locator kinds; closed vocabulary. */
export const PLAYTESTS_LOCATOR_KINDS = [
  "episode",
  "event",
  "frame",
  "replay-segment",
  "review",
  "finding",
  "comparison"
] as const;

export type PlaytestLocatorKind = (typeof PLAYTESTS_LOCATOR_KINDS)[number];

/** Allowed missing-reason vocabulary; preserved verbatim on artifacts. */
export const PLAYTESTS_MISSING_REASONS = [
  "no-consent",
  "withdrawn",
  "missing-ENJ",
  "missing-before-action-probe",
  "missing-feedback",
  "missing-action-or-revision-events",
  "stochastic-outcome-without-probability-target",
  "fork-unsupported",
  "partial-alternatives",
  "reward-or-continuation-contract-mismatch",
  "wrong-instrument",
  "outside-window",
  "unobserved",
  "infrastructure-failed",
  "budget-truncated",
  "cancelled",
  "revoked"
] as const;

export type PlaytestMissingReason = (typeof PLAYTESTS_MISSING_REASONS)[number];

/** Outcome categories a single episode/attempt may end in. */
export const PLAYTESTS_EPISODE_OUTCOMES = [
  "assigned",
  "started",
  "completed",
  "crashed",
  "infrastructure-failed",
  "cancelled",
  "budget-truncated",
  "reviewed",
  "eligible"
] as const;

export type PlaytestEpisodeOutcome =
  (typeof PLAYTESTS_EPISODE_OUTCOMES)[number];

/** One incompatible semantic quantity disables every statistical delta rule. */
export const PLAYTESTS_NOT_COMPARABLE_MODE = "not-comparable" as const;

/** Compatibility classification for a metric within a comparison. */
export const PLAYTESTS_COMPATIBILITY_MODES = [
  "paired-initial-condition",
  "paired-counterfactual",
  "distribution-matched",
  "observational",
  PLAYTESTS_NOT_COMPARABLE_MODE
] as const;

export type PlaytestCompatibilityMode =
  (typeof PLAYTESTS_COMPATIBILITY_MODES)[number];

/** Classification of a single metric delta within a comparison. */
export const PLAYTESTS_DELTA_CLASSIFICATIONS = [
  "improved",
  "regressed",
  "no-material-change",
  "inconclusive",
  PLAYTESTS_NOT_COMPARABLE_MODE,
  "breach",
  "uncertain"
] as const;

export type PlaytestDeltaClassification =
  (typeof PLAYTESTS_DELTA_CLASSIFICATIONS)[number];

/** Decision the developer-owner applies on top of per-metric classifications. */
export const PLAYTESTS_DECISION_STATUSES = [
  "eligible-for-owner-promotion",
  "hold-regression",
  "hold-inconclusive",
  "hold-not-comparable",
  "owner-decided",
  "denied"
] as const;

export type PlaytestDecisionStatus =
  (typeof PLAYTESTS_DECISION_STATUSES)[number];

/** Lifecycle states of a versioned experiment. */
export const PLAYTESTS_EXPERIMENT_STATES = [
  "draft",
  "approved",
  "running",
  "completed",
  "analyzed",
  "owner-decided",
  "denied",
  "cancelled",
  "execution-failed",
  "inconclusive"
] as const;

export type PlaytestExperimentState =
  (typeof PLAYTESTS_EXPERIMENT_STATES)[number];

/** Verification stages a finding may progress through. */
export const PLAYTESTS_VERIFICATION_STAGES = [
  "not-yet-validated",
  "fixed-on-reproduced-case",
  "sustained-improvement",
  "regressed-elsewhere",
  "insufficient-evidence"
] as const;

export type PlaytestVerificationStage =
  (typeof PLAYTESTS_VERIFICATION_STAGES)[number];

/** Severity classes a finding may belong to. */
export const PLAYTESTS_SEVERITIES = [
  "catastrophic",
  "major",
  "minor",
  "informational"
] as const;

export type PlaytestSeverity = (typeof PLAYTESTS_SEVERITIES)[number];

/** Fix lineage status: how the finding was raised. */
export type PlaytestFindingStatus =
  "open" | "fixed" | "regressed" | "withdrawn" | "stale";

/** Schema-allowed change-detection answer sources. */
export type PlaytestPreferenceAnswer = "A" | "B" | "tie" | "unable-to-judge";

/** Native Likert item range for miniPXI ENJ: -3 to +3 inclusive. */
export const PLAYTESTS_MINIPXI_ENJ_MIN = -3;
export const PLAYTESTS_MINIPXI_ENJ_MAX = 3;

/** Native Likert items for full miniPXI instruments; ENJ is exposed alone. */
export const PLAYTESTS_MINIPXI_ITEMS = [
  "ENJ",
  "AUT",
  "GR",
  "CH",
  "AE",
  "ME",
  "NA",
  "PUX",
  "PBP",
  "RP"
] as const;

export type PlaytestMiniPxiItem = (typeof PLAYTESTS_MINIPXI_ITEMS)[number];

/** Native category codes for each miniPXI Likert response. */
export const PLAYTESTS_MINIPXI_CATEGORIES = [
  "low",
  "medium-low",
  "neutral",
  "medium-high",
  "high"
] as const;

export type PlaytestMiniPxiCategory =
  (typeof PLAYTESTS_MINIPXI_CATEGORIES)[number];

/** Closed vocabulary of permitted agent roles for analysis/policy work. */
export type PlaytestAnalysisRole = Extract<
  AgentRole,
  "playtester" | "playtest-analyst" | "validator"
>;

/**
 * A versioned identifier pair. The Core layer never silently rewrites the
 * version: any change creates a fresh identifier and an explicit
 * "not-comparable" verdict in `PlaytestComparison`.
 */
export interface PlaytestVersionedRef {
  readonly id: string;
  readonly version: number | string;
  /** Optional content hash; recorded so a comparison can detect drift. */
  readonly contentHash?: string;
}

/** A bounded provenance reference; carries enough to replay or audit. */
export interface PlaytestProvenance {
  readonly workspaceId: string;
  readonly buildSha?: string;
  readonly evaluatorHash?: string;
  readonly rubricHash?: string;
  readonly measurementVersion: string;
  readonly instrumentVersion?: string;
  readonly generatedAt: string;
}

/** A single evidence locator; the only way a finding/review can point at data. */
export interface PlaytestEvidenceLocator {
  readonly kind: PlaytestLocatorKind;
  readonly id: string;
  /** Optional sub-range; episode and event locators include these. */
  readonly step?: number;
  readonly revision?: number;
  readonly frameIndex?: number;
  readonly phaseId?: string;
}

/** What a review records as a deterministic fact-support verdict. */
export type PlaytestEvidenceVerdict =
  "supported" | "contradicted" | "insufficient";

/** Required raw inputs of one dimension rubric evaluation. */
export interface PlaytestDimensionAnchor {
  readonly dimensionId: string;
  readonly version: number;
  readonly unit: "decision" | "episode" | "cohort";
  readonly score: 0 | 1 | 2 | 3 | 4 | null;
  readonly rationale: string;
  readonly counterexampleId?: string;
  readonly evidenceChecklist: readonly string[];
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
  /** Independent units contributing evidence; null -> null score. */
  readonly independentUnits: number | null;
  /** Eligible opportunities contributing evidence; null -> null score. */
  readonly eligibleOpportunities: number | null;
  readonly insufficientReason?: PlaytestMissingReason;
}

/** Boundary object for one score band on a 0-4 rubric. */
export interface PlaytestScoreBand {
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly equals?: number;
  readonly greaterThan?: number;
  readonly atMost?: number;
  readonly atLeast?: number;
  readonly lessThan?: number;
}

/** Dimension rubric carried by the registry; consumed by anchor scoring. */
export interface PlaytestDimensionRubric {
  readonly dimensionId: string;
  readonly version: number;
  readonly unit: "decision" | "episode" | "cohort";
  readonly indicator: string;
  readonly modality:
    "headless" | "browser" | "native-visual" | "human-post-play";
  readonly minExposure: number;
  readonly minIndependentUnits: number;
  readonly scoreBands: readonly PlaytestScoreBand[];
  readonly counterexample: string;
  readonly evidenceChecklist: readonly string[];
  readonly insufficient: "null";
  readonly humanOutcomeMapping: string | null;
}

/** A native miniPXI response record before aggregation. */
export interface PlaytestMiniPxiResponse {
  readonly studyId: string;
  readonly responseId: string;
  readonly pseudonymousParticipantId: string;
  readonly consentVersion: string;
  readonly instrumentVersion: string;
  readonly instrumentHash: string;
  readonly buildSha: string;
  readonly episodeId: string;
  readonly exposureStartedAt: string;
  readonly exposureEndedAt: string;
  readonly order: "A-first" | "B-first";
  readonly submittedAt: string;
  readonly itemId: PlaytestMiniPxiItem;
  readonly nativeValue: number | null;
  readonly missingReason?: PlaytestMissingReason;
}

/** Counters for one stratum inside the sampling budget. */
export interface PlaytestStratumAllocation {
  readonly stratumKey: string;
  readonly population: number;
  readonly allocated: number;
  readonly inclusionProbability: number;
}

/** Result of a deterministic surveillance sample. */
export interface PlaytestSurveillanceSample {
  readonly budget: number;
  readonly seed: string;
  readonly selected: readonly string[];
  readonly allocations: readonly PlaytestStratumAllocation[];
  readonly minimumStratumAllocation: number;
  readonly totalAllocated: number;
}

/** Result of a deterministic discovery sample selection. */
export interface PlaytestDiscoverySample {
  readonly budget: number;
  readonly seed: string;
  readonly selected: readonly string[];
  readonly rankedBy: string;
  readonly tieBreakerSeed: string;
}

/** Combined sampling output for a single review batch. */
export interface PlaytestSamplingPlan {
  readonly surveillance: PlaytestSurveillanceSample;
  readonly discovery: PlaytestDiscoverySample;
  readonly schema: typeof PLAYTESTS_SAMPLING_SCHEMA;
}

/** Aggregate coverage/cohort breakdown used by comparisons and reviews. */
export interface PlaytestCompletionCounts {
  readonly assigned: number;
  readonly started: number;
  readonly completed: number;
  readonly crashed: number;
  readonly infrastructureFailed: number;
  readonly cancelled: number;
  readonly budgetTruncated: number;
  readonly reviewed: number;
  readonly eligible: number;
}

/** Single per-arm measurement summary required by comparisons. */
export interface PlaytestMetricArmSummary {
  readonly arm: "baseline" | "candidate";
  readonly assigned: number;
  readonly eligible: number;
  readonly missing: number;
  readonly independentUnits: number;
  readonly exposure: number;
  readonly estimate: number | null;
  readonly rawDelta: number | null;
  readonly interval: PlaytestNumericInterval | null;
}

/** Numeric interval returned by an external statistics library. */
export interface PlaytestNumericInterval {
  readonly lower: number;
  readonly upper: number;
  readonly method: string;
  readonly libraryVersion: string;
  readonly confidenceLevel: number;
  readonly resamples: number | null;
  readonly seed: string | null;
}

/** Single per-metric comparison verdict. */
export interface PlaytestMetricComparison {
  readonly metricId: string;
  readonly metricVersion: number | string;
  readonly compatibility: PlaytestCompatibilityMode;
  readonly meaningfulMargin: number | null;
  readonly guardrailMargin: number | null;
  readonly orientedBenefitDelta: number | null;
  readonly classification: PlaytestDeltaClassification;
  readonly baseline: PlaytestMetricArmSummary;
  readonly candidate: PlaytestMetricArmSummary;
  readonly interval: PlaytestNumericInterval | null;
  readonly guardrailStatus:
    "passed" | "breached" | "uncertain" | "not-applicable";
  readonly notes: string;
}

/** Full comparison envelope, including owner decision and provenance. */
export interface PlaytestComparison {
  readonly schema: typeof PLAYTESTS_COMPARISON_SCHEMA;
  readonly comparisonId: string;
  readonly version: number;
  readonly benchmarkId: string;
  readonly experimentId: string | null;
  readonly baseline: PlaytestVersionedRef;
  readonly candidate: PlaytestVersionedRef;
  readonly measurementVersion: string;
  readonly metrics: readonly PlaytestMetricComparison[];
  readonly decision: PlaytestDecisionStatus;
  readonly ownerDecisionAt: string | null;
  readonly ownerDecisionReason: string | null;
  readonly humanPreference: {
    readonly answer: PlaytestPreferenceAnswer | "not-collected";
    readonly interval: PlaytestNumericInterval | null;
  };
  readonly provenance: PlaytestProvenance;
  readonly notes: string;
}

/** A review submission; the canonical artifact for analyst output. */
export interface PlaytestReview {
  readonly schema: typeof PLAYTESTS_COMPARISON_SCHEMA;
  readonly reviewId: string;
  readonly version: number;
  readonly episodeId: string;
  readonly supersedes: string | null;
  readonly authorRole: PlaytestAnalysisRole;
  readonly authorId: string;
  readonly rubricHash: string;
  readonly measurementVersion: string;
  readonly anchors: readonly PlaytestDimensionAnchor[];
  readonly findings: readonly PlaytestFinding[];
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
  readonly createdAt: string;
  readonly notes: string;
}

/** A finding is a testable, evidence-linked design or defect claim. */
export interface PlaytestFinding {
  readonly findingId: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly severity: PlaytestSeverity;
  readonly status: PlaytestFindingStatus;
  readonly verificationStage: PlaytestVerificationStage;
  readonly evidenceStatus:
    "verified" | "corroborated" | "hypothesis" | "not observed";
  readonly affectedEpisodes: number;
  readonly totalEligibleEpisodes: number;
  readonly affectedOpportunities: number;
  readonly totalEligibleOpportunities: number;
  readonly affectedCohorts: readonly string[];
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
  readonly experimentIds: readonly string[];
  readonly issueRefs: readonly string[];
  readonly lastVerifiedBuild: string | null;
  readonly nextReviewAt: string | null;
}

/** JSON-RPC v1 request envelope. */
export interface PlaytestJsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: PlaytestAdapterMethod;
  readonly params: Readonly<Record<string, unknown>>;
}

/** JSON-RPC v1 success response envelope. */
export interface PlaytestJsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

/** JSON-RPC v1 error response envelope. */
export interface PlaytestJsonRpcError {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly error: {
    readonly code: PlaytestAdapterErrorCode | number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type PlaytestJsonRpcResponse =
  PlaytestJsonRpcSuccess | PlaytestJsonRpcError;

/** Capability advertisement returned by `advertise_capabilities`. */
export interface PlaytestCapabilityAdvertisement {
  readonly protocol: typeof PLAYTESTS_PROTOCOL;
  readonly capabilities: readonly PlaytestAdapterCapability[];
  readonly supportedMethods: readonly PlaytestAdapterMethod[];
  readonly eventSchemaHash: string;
  readonly observationSchemaHash: string;
  readonly maxStep: number | null;
}

/** Observation descriptor returned by `describe_observation`. */
export interface PlaytestObservationDescriptor {
  readonly schemaHash: string;
  readonly fields: readonly string[];
  readonly visibilityMode: "structured" | "visual-only";
  readonly supportsReplay: boolean;
}

/** Action request issued by Runtime; bound to the lowest-Revision call. */
export interface PlaytestActionRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly observationHash: string;
  readonly offeredActionIds: readonly string[];
  readonly deadlineAt: string;
}

/** The legal, deterministic step result returned by `submit_step`. */
export interface PlaytestStepResult {
  readonly episodeId: string;
  readonly step: number;
  readonly revision: number;
  readonly executedActionId: string;
  readonly rejected: boolean;
  readonly observedStateHash: string;
  readonly eventIds: readonly string[];
  readonly observationLocator: PlaytestEvidenceLocator;
  readonly timestamp: string;
}

/** Episode record input expected by finalize/finalize_episode. */
export interface PlaytestEpisodeInput {
  readonly episodeId: string;
  readonly workspaceId: string;
  readonly scenario: string;
  readonly policy: string;
  readonly cohort: string;
  readonly seed: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: PlaytestEpisodeOutcome;
  readonly steps: readonly PlaytestStepResult[];
  readonly buildSha: string;
  readonly measurementVersion: string;
  readonly completionCounts: PlaytestCompletionCounts;
}

/** Bare-bones numeric scoring result; common denominator across evaluators. */
export interface PlaytestNumericResult {
  readonly metricId: string;
  readonly metricVersion: number | string;
  readonly numerator: number;
  readonly denominator: number;
  readonly coverage: number;
  readonly unit: string;
  readonly estimate: number | null;
  readonly missing: number;
  readonly missingReasons: readonly PlaytestMissingReason[];
  readonly independentUnits: number;
  readonly provenance: PlaytestProvenance;
  readonly notes: string;
}

/** MiniPXI ENJ aggregation result; preserves units/native scale. */
export interface PlaytestMiniPxiEnjAggregation {
  readonly metricId: "reported-enjoyment";
  readonly metricVersion: number | string;
  readonly mean: number | null;
  readonly respondentCount: number;
  readonly missingCount: number;
  readonly categoryCounts: Readonly<Record<PlaytestMiniPxiCategory, number>>;
  readonly unit: "native-Likert-minus3-plus3";
  readonly missingReasons: readonly PlaytestMissingReason[];
  readonly independentUnits: number;
  readonly provenance: PlaytestProvenance;
}

/** Compatibility verdict between two measurement versions. */
export type PlaytestCompatibilityVerdict =
  "compatible" | "compatible-with-bridge" | "not-comparable";

/** Single compatibility verdict entry. */
export interface PlaytestCompatibilityEntry {
  readonly metricId: string;
  readonly verdict: PlaytestCompatibilityVerdict;
  readonly reasons: readonly string[];
  readonly requiresBridge: boolean;
}
