import type { PlaytestJsonValue } from "./protocol-types.ts";
import {
  type PlaytestComparison,
  type PlaytestCompletionCounts,
  type PlaytestDimensionAnchor,
  type PlaytestEpisodeState,
  type PlaytestEvidenceLocator,
  type PlaytestExperimentState,
  type PlaytestFinding,
  type PlaytestMiniPxiItem,
  type PlaytestMissingReason,
  type PlaytestNumericResult,
  type PlaytestProvenance,
  type PLAYTESTS_BATCH_SCHEMA,
  type PLAYTESTS_EPISODE_SCHEMA,
  type PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_GAME_MODES,
  type PLAYTESTS_HUMAN_STUDY_SCHEMA,
  type PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSamplingPlan,
  type PlaytestVersionedRef
} from "./types.ts";

export const PLAYTESTS_GAME_OUTCOMES = [
  "win",
  "loss",
  "dnf",
  "other",
  "unknown"
] as const;
export type PlaytestGameOutcomeKind = (typeof PLAYTESTS_GAME_OUTCOMES)[number];
export type PlaytestReplayStatus =
  | "verified"
  | "trace-replayable"
  | "non-reproducible"
  | "unavailable"
  | "invalid";

export interface PlaytestObservationField {
  /** Dot-separated JSON keys and numeric array indices; wildcards are unsupported. */
  readonly fieldPath: string;
  readonly unit: string | null;
  readonly displayRounding: string | null;
  readonly revelationTiming: string;
  readonly playerRuleRef: string | null;
}

export interface PlaytestObservationContract {
  readonly schemaVersion: 1;
  readonly schemaHash: string;
  readonly mode: "headless" | "browser" | "native-visual";
  readonly cohort: string;
  readonly visibilityMode: "structured" | "visual-only";
  readonly fields: readonly PlaytestObservationField[];
  readonly uiEquivalence: "verified" | "unverified";
  readonly conformanceFixtureHash: string | null;
}

/** Exact execution identity needed to replay or explicitly identify nondeterminism. */
export interface PlaytestEpisodeIdentity {
  readonly workspaceId: string;
  readonly repository: string;
  readonly buildSha: string;
  readonly gameBuild: string;
  readonly scenarioId: string;
  readonly configHash: string;
  readonly seed: string;
  /** Hash of the adapter's initial RNG state; null means unobserved. */
  readonly rngInitialStateHash: string | null;
  readonly rngAlgorithm: string | null;
  readonly rngVersion: string | null;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly modelId: string | null;
  readonly modelRevision: string | null;
  readonly observationSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly eventSchemaHash: string;
  readonly protocolVersion: 1;
  readonly runtimeVersion: string;
  readonly environmentHash: string;
}

/** One step-indexed decision record; full trace bytes live in bounded artifacts. */
export interface PlaytestEpisodeStep {
  readonly step: number;
  readonly revisionBefore: number;
  readonly revisionAfter: number | null;
  readonly observationHash: string;
  readonly observationVisibility: "structured" | "visual-only" | "unverified";
  readonly observationRef: PlaytestEvidenceLocator;
  readonly legalActionIds: readonly string[];
  readonly selectedActionId: string | null;
  readonly preActionPrediction: PlaytestJsonValue | null;
  readonly authoritativeOutcome: PlaytestJsonValue | null;
  readonly eventRefs: readonly PlaytestEvidenceLocator[];
  readonly frameRef: PlaytestEvidenceLocator | null;
  readonly simulationWallMs: number | null;
  readonly logicalTicks: number | null;
  readonly policyInferenceMs: number | null;
  readonly nativeIntervals: readonly {
    readonly state:
      | "active-interaction"
      | "required-animation"
      | "deliberation"
      | "idle"
      | "unknown";
    readonly startMs: number;
    readonly endMs: number;
    readonly precedenceVersion: string;
  }[];
}

/** Indexed episode summary. Full traces/media remain external bounded artifacts. */
export interface PlaytestEpisode {
  readonly schema: typeof PLAYTESTS_EPISODE_SCHEMA;
  readonly episodeId: string;
  readonly revision: number;
  readonly batchId: string;
  readonly identity: PlaytestEpisodeIdentity;
  readonly scenarioFamily: string;
  readonly policyCohort: string;
  readonly strategy: string;
  readonly status: PlaytestEpisodeState;
  readonly outcome: PlaytestGameOutcomeKind;
  readonly outcomeMetrics: Readonly<Record<string, number | null>>;
  readonly completionCounts: PlaytestCompletionCounts;
  readonly replayStatus: PlaytestReplayStatus;
  readonly trace: PlaytestEvidenceLocator | null;
  readonly frames: readonly PlaytestEvidenceLocator[];
  readonly stepCount: number;
  readonly metrics: readonly PlaytestNumericResult[];
  readonly findingIds: readonly string[];
  readonly assignedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly simulationWallMs: number | null;
  readonly logicalTicks: number | null;
  readonly policyInferenceMs: number | null;
  readonly nativeDurationMs: number | null;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly missingReasons: readonly PlaytestMissingReason[];
}

export const PLAYTESTS_BATCH_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "truncated"
] as const;
export type PlaytestBatchState = (typeof PLAYTESTS_BATCH_STATES)[number];

/** Workspace-scoped batch; execution state and game outcome are separate. */
export interface PlaytestBatch {
  readonly schema: typeof PLAYTESTS_BATCH_SCHEMA;
  readonly batchId: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly repository: string;
  readonly buildSha: string;
  /** Adapter build when capabilities were observed; null for pre-negotiation failures. */
  readonly gameBuild: string | null;
  readonly configHash: string;
  readonly rubricHash: string;
  /** Negotiated schema hashes; null means the adapter failed before capabilities. */
  readonly actionSchemaHash: string | null;
  readonly observationSchemaHash: string | null;
  readonly eventSchemaHash: string | null;
  readonly measurementVersion: string;
  readonly protocolVersion: 1;
  readonly policyIds: readonly string[];
  readonly cohortIds: readonly string[];
  readonly scenarioIds: readonly string[];
  readonly samplingPlan: PlaytestSamplingPlan | null;
  readonly status: PlaytestBatchState;
  readonly counts: PlaytestCompletionCounts;
  readonly budget: {
    readonly assignedEpisodes: number;
    readonly maxStepsPerEpisode: number;
    readonly wallTimeMs: number;
    readonly critiqueBudget: number;
    readonly actualCritiques: number;
  };
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly provenance: PlaytestProvenance;
  readonly evaluationIds: readonly string[];
  readonly spanIds: readonly string[];
}

/** Immutable benchmark contract for a comparable build cohort. */
export interface PlaytestBenchmark {
  readonly benchmarkId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly referenceBuildSha: string;
  readonly scenarioInventory: readonly {
    readonly scenarioId: string;
    readonly family: string;
    readonly weight: number;
  }[];
  readonly seedInventory: readonly {
    readonly seed: string;
    readonly purpose: "discovery" | "confirmation" | "regression";
  }[];
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly competenceReportRefs: readonly PlaytestEvidenceLocator[];
  readonly memoryResetRules: string;
  readonly engineEnvironmentHash: string;
  readonly actionSchemaHash: string;
  readonly observationSchemaHash: string;
  readonly eventSchemaHash: string;
  readonly metricRegistryHash: string;
  readonly rubricHash: string;
  readonly captureMode: "headless" | "browser" | "native-visual";
  readonly measurementVersion: string;
  readonly primaryMetricIds: readonly string[];
  readonly guardrailMetricIds: readonly string[];
  readonly practicalMargins: Readonly<Record<string, number>>;
  readonly independentUnit: "episode" | "learner" | "participant" | "cluster";
  readonly precisionPlanRef: string;
  readonly missingnessBound: number;
  readonly refreshPolicy: string;
  readonly createdAt: string;
  readonly createdBy: string;
  /**
   * Frozen benchmark cohort weight vector. Drives the §10/§11 mix-shift
   * gate so per-cohort observations are standardized against a single
   * canonical distribution instead of the build's sample mix.
   * Cohort keys are unique non-empty IDs; weights are finite positive
   * numbers summing to 1.0 within the canonical hash tolerance.
   */
  readonly cohortWeights: Readonly<Record<string, number>>;
  readonly contentHash: string;
}

/** Canonical frozen experiment manifest; no moving branch is an approved treatment. */
export interface PlaytestExperiment {
  readonly schema: typeof PLAYTESTS_EXPERIMENT_SCHEMA;
  readonly experimentId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly findingIds: readonly string[];
  readonly hypothesis: string;
  readonly falsifier: string;
  readonly alternativeExplanations: readonly string[];
  readonly benchmarkId: string;
  readonly baseline: PlaytestVersionedRef;
  readonly treatment: PlaytestVersionedRef;
  readonly approvalId: string | null;
  readonly exposureUnit: "episode" | "learner" | "participant" | "cluster";
  readonly allocationSeed: string;
  readonly allocationMethod: string;
  readonly cohort: string;
  readonly memoryInitialization: string;
  readonly pairMap: Readonly<Record<string, string>>;
  readonly assignmentMap: Readonly<Record<string, string>>;
  readonly discoveryInventory: readonly string[];
  readonly confirmationInventory: readonly string[];
  readonly primaryMetricId: string;
  readonly guardrailMetricIds: readonly string[];
  readonly analysisPlan: string;
  readonly missingnessPlan: string;
  readonly multiplicityPlan: string;
  readonly budget: {
    readonly maxAssignments: number;
    readonly maxCritiques: number;
    readonly maxWallTimeMs: number;
  };
  readonly stoppingRule: string;
  readonly state: PlaytestExperimentState;
  readonly attemptIds: readonly string[];
  readonly comparisonId: string | null;
  readonly ownerDecision: string | null;
  readonly rollbackRefs: readonly string[];
  readonly createdAt: string;
  readonly contentHash: string;
}

/** Packet records exactly which windows/artifacts were supplied to an analyst. */
export interface PlaytestEvidencePacket {
  readonly packetId: string;
  readonly episodeId: string;
  readonly rubricVersion: string;
  readonly audience: string;
  readonly intent: readonly string[];
  readonly metricRefs: readonly PlaytestEvidenceLocator[];
  readonly selectedWindows: readonly PlaytestEvidenceLocator[];
  readonly omittedWindowReasons: readonly string[];
  readonly suppliedArtifactHashes: readonly string[];
  readonly visibleEvidenceOnly: boolean;
  readonly criticRole: "playtest-analyst";
  readonly modelId: string;
  readonly modelRevision: string | null;
  readonly measurementVersion: string;
  readonly tokenBudget: number;
  readonly createdAt: string;
}

/** Versioned analyst review; facts, interpretations and human outcomes stay separate. */
export interface PlaytestSessionReview {
  readonly schema: typeof PLAYTESTS_SESSION_REVIEW_SCHEMA;
  readonly reviewId: string;
  readonly version: number;
  readonly episodeId: string;
  readonly supersedes: string | null;
  readonly authorRole: "playtest-analyst";
  readonly authorId: string;
  readonly rubricHash: string;
  readonly measurementVersion: string;
  readonly provenance: PlaytestProvenance;
  readonly chronologicalSummary: string;
  readonly authoritativeMetrics: readonly PlaytestNumericResult[];
  readonly observations: readonly string[];
  readonly interpretations: readonly string[];
  readonly anchors: readonly PlaytestDimensionAnchor[];
  readonly alternativeExplanations: readonly string[];
  readonly experiments: readonly {
    readonly hypothesis: string;
    readonly falsifier: string;
    readonly metricId: string;
    readonly controls: readonly string[];
    readonly budget: string;
  }[];
  readonly status: "verified" | "corroborated" | "hypothesis" | "not observed";
  readonly findings: readonly PlaytestFinding[];
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
  readonly createdAt: string;
  readonly notes: string;
}

/** Instrument identities accepted by the consented human-study import path. */
export const PLAYTESTS_HUMAN_INSTRUMENTS = [
  "miniPXI",
  "PXI",
  "project-authored"
] as const;
export type PlaytestHumanInstrument =
  (typeof PLAYTESTS_HUMAN_INSTRUMENTS)[number];

/** Approved human study metadata; participant identity stays in its consent owner. */
export interface HumanPlaytestStudy {
  readonly schema: typeof PLAYTESTS_HUMAN_STUDY_SCHEMA;
  readonly studyId: string;
  readonly version: number;
  readonly workspaceId: string;
  readonly benchmarkId: string;
  /** Exact immutable builds permitted for this study's exposures. */
  readonly allowedBuilds: readonly PlaytestVersionedRef[];
  /** Hash of the operator-approved item→construct map for full PXI, otherwise null. */
  readonly pxiItemConstructMappingHash: string | null;
  readonly instrument: PlaytestHumanInstrument;
  readonly instrumentVersion: string;
  readonly instrumentHash: string;
  readonly consentVersion: string;
  readonly consentScope: string;
  readonly approved: boolean;
  readonly approvedBy: string | null;
  readonly responseWindowMs: number;
  readonly minimumExposureMs: number;
  readonly orderDesign: "A/B" | "AB/BA" | "single-build";
  readonly independentUnit: "participant" | "participant-pair";
  readonly missingItemPolicy: "null-construct" | "item-wise";
  readonly invitedCount: number;
  readonly eligibleCount: number;
  readonly respondedCount: number;
  readonly withdrawnCount: number;
  readonly createdAt: string;
}

/** Consent-scoped response item; raw free-text/direct identity are not stored here. */
export interface HumanExperienceResponse {
  readonly studyId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly pseudonymousParticipantId: string;
  readonly consentVersion: string;
  readonly consentScope: string;
  readonly instrument: PlaytestHumanInstrument;
  readonly instrumentVersion: string;
  readonly instrumentHash: string;
  readonly build: PlaytestVersionedRef;
  readonly episodeId: string;
  readonly exposureStartedAt: string;
  readonly exposureEndedAt: string;
  readonly order: "A-first" | "B-first" | "single-build";
  readonly submittedAt: string;
  readonly itemId: PlaytestMiniPxiItem | string;
  readonly nativeValue: number | null;
  readonly missingReason?: PlaytestMissingReason;
  readonly withdrawn: boolean;
}

/** Human-data-grounded policy validity; absent human samples remain unvalidated. */
export interface PlayerPolicyValidity {
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly cohortId: string;
  readonly observationSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly heldOutHumanStateIds: readonly string[];
  readonly competence:
    "passed" | "failed" | "insufficient" | "unvalidated-synthetic";
  readonly legalityRate: number | null;
  readonly repeatability: number | null;
  readonly actionAgreement: number | null;
  readonly distributionDivergence: number | null;
  readonly coverage: number;
  readonly failureModes: readonly string[];
  readonly interval: PlaytestComparison["metrics"][number]["interval"];
  readonly createdAt: string;
}

/** Blinded repeat/second-judge validation for an exact measurement version. */
export interface PlaytestJudgeValidation {
  readonly validationId: string;
  readonly workspaceId: string;
  readonly measurementVersion: string;
  readonly referenceCorpusVersion: string;
  readonly repeatAgreement: number | null;
  readonly secondJudgeAgreement: number | null;
  readonly diagnosticPrecision: number | null;
  readonly diagnosticRecall: number | null;
  readonly humanPredictionError: number | null;
  readonly costPerReviewedEpisode: number | null;
  readonly thresholdsHash: string;
  readonly status: "passed" | "failed" | "insufficient" | "stale";
  readonly quarantinedClaimTypes: readonly string[];
  readonly createdAt: string;
}

export interface PlaytestCadenceConfiguration {
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly tiers: Readonly<
    Record<
      string,
      {
        readonly assignments: number;
        readonly critiques: number;
        readonly wallTimeMs: number;
      }
    >
  >;
  readonly retryableInfrastructureAttempts: 0 | 1 | 2;
  readonly retentionDays: number;
  readonly issueReporting: "disabled" | "review";
}

export interface PlaytestFixLineage {
  readonly findingId: string;
  readonly experimentId: string | null;
  readonly issueRef: string | null;
  readonly pullRequestRef: string | null;
  readonly candidateBuildSha: string | null;
  readonly retestBatchIds: readonly string[];
  readonly comparisonIds: readonly string[];
  readonly verificationStage:
    | "not-yet-validated"
    | "fixed-on-reproduced-case"
    | "sustained-improvement"
    | "regressed-elsewhere"
    | "insufficient-evidence";
  readonly recurrenceCount: number;
  readonly lastVerifiedBuild: string | null;
  readonly nextReviewAt: string | null;
}

const SHA256_HEX_PATTERN = /^[a-f\d]{64}$/iu;

const OBSERVATION_CONTRACT_FIELDS = [
  "schemaVersion",
  "schemaHash",
  "mode",
  "cohort",
  "visibilityMode",
  "fields",
  "uiEquivalence",
  "conformanceFixtureHash"
] as const;
const OBSERVATION_FIELD_PROPERTIES = [
  "fieldPath",
  "unit",
  "displayRounding",
  "revelationTiming",
  "playerRuleRef"
] as const;
const OBSERVATION_NULLABLE_PROPERTIES = [
  "unit",
  "displayRounding",
  "playerRuleRef"
] as const;
const OBSERVATION_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const OBSERVATION_ARRAY_INDEX_PATTERN = /^(0|[1-9]\d{0,3})$/u;
const OBSERVATION_FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor"
]);
const MAX_OBSERVATION_PATH_SEGMENTS = 32;
const MAX_OBSERVATION_ARRAY_INDEX = 4095;
const MAX_OBSERVATION_FIELDS = 4096;

function isPlainRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new TypeError(field + " has an unknown field.");
  }
}

function assertNonEmptyArtifactString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(field + " must be a non-empty string.");
  }
}

function assertObservationField(value: unknown, seenPaths: Set<string>): void {
  if (!isPlainRecord(value))
    throw new TypeError("Observation allowlist entry must be an object.");
  assertOnlyKeys(value, OBSERVATION_FIELD_PROPERTIES, "Observation field");
  const fieldPath = value.fieldPath;
  assertNonEmptyArtifactString(fieldPath, "Observation fieldPath");
  const pathSegments = fieldPath.split(".");
  if (
    pathSegments.length > MAX_OBSERVATION_PATH_SEGMENTS ||
    pathSegments.some(
      (segment) =>
        !OBSERVATION_PATH_SEGMENT_PATTERN.test(segment) ||
        OBSERVATION_FORBIDDEN_PATH_SEGMENTS.has(segment) ||
        (OBSERVATION_ARRAY_INDEX_PATTERN.test(segment) &&
          Number(segment) > MAX_OBSERVATION_ARRAY_INDEX)
    )
  ) {
    throw new TypeError(
      "Observation fieldPath must use safe dot-separated keys or bounded array indices."
    );
  }
  assertNonEmptyArtifactString(
    value.revelationTiming,
    "Observation revelationTiming"
  );
  for (const field of OBSERVATION_NULLABLE_PROPERTIES) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new TypeError(
        "Observation field metadata must be a string or null."
      );
    }
  }
  if (
    [...seenPaths].some(
      (known) =>
        known === fieldPath ||
        known.startsWith(fieldPath + ".") ||
        fieldPath.startsWith(known + ".")
    )
  ) {
    throw new TypeError(
      "Observation fieldPath entries must be unique and non-overlapping."
    );
  }
  seenPaths.add(fieldPath);
}

/** Core validation for a game-owned, player-visible observation allowlist. */
export function assertPlaytestObservationContract(
  value: unknown
): asserts value is PlaytestObservationContract {
  if (!isPlainRecord(value))
    throw new TypeError("Observation contract must be an object.");
  assertOnlyKeys(value, OBSERVATION_CONTRACT_FIELDS, "Observation contract");
  if (value.schemaVersion !== 1)
    throw new TypeError("Observation contract schemaVersion must be 1.");
  if (
    typeof value.schemaHash !== "string" ||
    !SHA256_HEX_PATTERN.test(value.schemaHash)
  ) {
    throw new TypeError(
      "Observation contract schemaHash must be a SHA-256 hex digest."
    );
  }
  if (!(PLAYTESTS_GAME_MODES as readonly unknown[]).includes(value.mode)) {
    throw new TypeError("Observation contract mode is unsupported.");
  }
  assertNonEmptyArtifactString(value.cohort, "Observation contract cohort");
  if (
    value.visibilityMode !== "structured" &&
    value.visibilityMode !== "visual-only"
  ) {
    throw new TypeError("Observation contract visibilityMode is invalid.");
  }
  if (
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > MAX_OBSERVATION_FIELDS
  ) {
    throw new TypeError(
      "Observation contract fields must be a non-empty bounded allowlist."
    );
  }
  const seenPaths = new Set<string>();
  for (const field of value.fields) assertObservationField(field, seenPaths);
  if (
    value.uiEquivalence !== "verified" &&
    value.uiEquivalence !== "unverified"
  ) {
    throw new TypeError("Observation contract uiEquivalence is invalid.");
  }
  const fixtureHash = value.conformanceFixtureHash;
  if (
    fixtureHash !== null &&
    (typeof fixtureHash !== "string" || !SHA256_HEX_PATTERN.test(fixtureHash))
  ) {
    throw new TypeError(
      "Observation conformanceFixtureHash must be a SHA-256 digest or null."
    );
  }
  if (value.uiEquivalence === "verified" && fixtureHash === null) {
    throw new TypeError(
      "A verified observation requires a conformance fixture."
    );
  }
}
