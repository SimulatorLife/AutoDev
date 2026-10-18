/** Deterministic selection and validation for bounded confirmatory analyst evidence packets. */

import {
  type PlaytestAdapterEpisode,
  type PlaytestCoverageManifest,
  type PlaytestEpisode,
  type PlaytestEpisodeIdentity,
  type PlaytestEvidenceCrossSessionContext,
  type PlaytestEvidenceCrossSessionEpisode,
  type PlaytestEvidenceMetricIntent,
  type PlaytestEvidenceMetricIntentV2,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidencePacket,
  type PlaytestEvidencePacketV4,
  type PlaytestEvidenceTraceStep,
  type PlaytestEvidenceWindow,
  type PlaytestGameOutcomeKind,
  type PlaytestOmittedEvidenceWindow,
  PLAYTESTS_GAME_OUTCOMES
} from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import { assertPlaytestCoverageManifest } from "./coverage.ts";
import {
  type PlaytestEvidencePacketArtifactView,
  type PlaytestEvidencePacketOmittedArtifactView,
  assertOmittedPacketArtifacts,
  assertPacketArtifactProvenance,
  assertTraceStep,
  assertUniqueSelectedEventIds,
  assertUniqueTraceEventIds,
  buildBoundedEvidenceWindows,
  EVIDENCE_SHA256_PATTERN,
  hasMandatoryEventEvidenceValue,
  isCount,
  isPlaytestEvidencePacketId,
  isRecord,
  isText,
  packetContentBytes,
  MAX_EVIDENCE_PACKET_BYTES,
  MAX_EVIDENCE_PACKET_STEPS,
  MAX_EVIDENCE_PACKET_WINDOWS,
  resolveEvidenceWindowLimits,
  suppliedArtifactsFor
} from "./evidence-trace-selection.ts";
import {
  assertPlaytestAdapterEpisode,
  assertPlaytestExecutionProvenance
} from "./execution-provenance.ts";
import { assertPlaytestNumericResults } from "./metric-evaluation.ts";
import type { PlaytestMetricRegistry } from "./registry.ts";
import { samplePlaytestSurveillance } from "./sampling.ts";
import {
  type PlaytestBatchAssignment,
  type PlaytestGameMode,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V3,
  PLAYTESTS_GAME_MODES,
  PLAYTESTS_MISSING_REASONS
} from "./types.ts";

/** Local aliases keep this file's confirmatory-only logic unchanged below. */
const SHA256_PATTERN = EVIDENCE_SHA256_PATTERN;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const MAX_PACKET_WINDOWS = MAX_EVIDENCE_PACKET_WINDOWS;
export const MAX_PACKET_CROSS_SESSION_SESSIONS = 4;
const MAX_PACKET_STEPS = MAX_EVIDENCE_PACKET_STEPS;
const MAX_PACKET_BYTES = MAX_EVIDENCE_PACKET_BYTES;
export const PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS = 32_768;
type ConfirmatoryAdapterEpisode = PlaytestAdapterEpisode & {
  readonly identity: PlaytestEpisodeIdentity & {
    readonly repository: string;
    readonly buildSha: string;
    readonly gameBuild: string;
    readonly scenarioId: string;
    readonly configHash: string;
    readonly seed: string;
    readonly protocolVersion: 1;
    readonly observationSchemaHash: string;
    readonly actionSchemaHash: string;
    readonly eventSchemaHash: string;
  };
};

/** Confirmatory scored packets require complete adapter-owned game identity. */
function assertConfirmatoryAdapterEpisode(
  episode: PlaytestEpisode
): asserts episode is ConfirmatoryAdapterEpisode {
  assertPlaytestAdapterEpisode(episode);
  const identity = episode.identity;
  if (
    typeof identity.repository !== "string" ||
    typeof identity.buildSha !== "string" ||
    typeof identity.gameBuild !== "string" ||
    typeof identity.scenarioId !== "string" ||
    typeof identity.configHash !== "string" ||
    typeof identity.seed !== "string" ||
    identity.protocolVersion !== 1 ||
    typeof identity.observationSchemaHash !== "string" ||
    typeof identity.actionSchemaHash !== "string" ||
    typeof identity.eventSchemaHash !== "string" ||
    episode.scenarioFamily.trim().length === 0 ||
    episode.policyCohort.trim().length === 0
  ) {
    throw new TypeError(
      "Confirmatory scored packets require complete adapter identity; visual sessions require a discovery packet."
    );
  }
}
const PACKET_KEYS = new Set([
  "schema",
  "packetId",
  "workspaceId",
  "batchId",
  "episodeId",
  "episodeRevision",
  "assignmentId",
  "buildSha",
  "gameBuild",
  "scenarioId",
  "scenarioFamily",
  "policyId",
  "policyVersion",
  "cohort",
  "outcome",
  "outcomeMetrics",
  "observationMode",
  "sourceStepCount",
  "rubricHash",
  "rubricVersion",
  "audience",
  "metricIntent",
  "dimensionRubrics",
  "metrics",
  "coverageCells",
  "coverageManifestHash",
  "chronologicalSummary",
  "traceArtifactId",
  "selectedWindows",
  "omittedWindows",
  "omittedArtifacts",
  "suppliedArtifacts",
  "visibleEvidenceOnly",
  "criticRole",
  "modelId",
  "modelRevision",
  "promptHash",
  "measurementVersion",
  "tokenBudget",
  "generatedAt",
  "crossSessionContext"
]);
const PACKET_V1_KEYS = new Set(
  [...PACKET_KEYS].filter((key) => key !== "crossSessionContext")
);
const PACKET_V4_KEYS = new Set([...PACKET_KEYS, "executionProvenance"]);
const METRIC_INTENT_V2_KEYS = new Set([
  "metricId",
  "version",
  "mechanicKey",
  "audience",
  "numerator",
  "denominator",
  "unit",
  "polarity",
  "targetBand",
  "exposurePredicate",
  "eventFields"
]);
const METRIC_INTENT_V3_KEYS = new Set([
  ...METRIC_INTENT_V2_KEYS,
  "analysisUnit",
  "aggregationWindow",
  "aggregation"
]);

export interface PlaytestEvidenceCrossSessionCandidate {
  readonly episode: PlaytestEpisode;
  readonly assignment: PlaytestBatchAssignment;
}

export interface BuildPlaytestEvidencePacketInput {
  readonly packetId: string;
  readonly episode: PlaytestEpisode;
  readonly assignment: PlaytestBatchAssignment;
  readonly registry: PlaytestMetricRegistry;
  readonly coverageManifest: PlaytestCoverageManifest;
  readonly crossSessionCandidates: readonly PlaytestEvidenceCrossSessionCandidate[];
  readonly crossSessionSelectionSeed: string;
  readonly crossSessionInventoryHash: string;
  readonly rubricHash: string;
  readonly measurementVersion: string;
  readonly traceHash: string;
  readonly traceSteps: readonly PlaytestEvidenceTraceStep[];
  /** Opaque frame id -> verified SHA-256, supplied by Runtime's artifact owner. */
  readonly frameHashes: Readonly<Record<string, string>>;
  readonly omittedArtifacts?: readonly PlaytestEvidenceOmittedArtifact[];
  readonly modelId: string | null;
  readonly modelRevision: string | null;
  readonly promptHash: string | null;
  readonly tokenBudget: number;
  readonly maxPacketBytes?: number;
  readonly generatedAt: string;
  readonly maxWindows?: number;
  readonly maxSelectedSteps?: number;
  readonly windowRadius?: number;
}

function metricIntentFor(
  registry: PlaytestMetricRegistry,
  scenarioId: string
): readonly PlaytestEvidenceMetricIntent[] {
  return registry.metricDefinitions
    .filter(
      (metric) =>
        metric.modality !== "human-post-play" &&
        metric.scenarioEligibility.includes(scenarioId)
    )
    .map((metric) => ({
      metricId: metric.metricId,
      version: metric.version,
      mechanicKey: metric.mechanicKey,
      audience: metric.audience,
      numerator: metric.numerator,
      denominator: metric.denominator,
      unit: metric.unit,
      polarity: metric.polarity,
      targetBand: metric.targetBand,
      exposurePredicate: metric.exposurePredicate,
      eventFields: metric.eventFields,
      analysisUnit: metric.analysisUnit,
      aggregationWindow: metric.aggregationWindow,
      aggregation: metric.aggregation
    }));
}

function matchingCoverageCells(
  manifest: PlaytestCoverageManifest,
  episode: ConfirmatoryAdapterEpisode
) {
  return manifest.cells.filter(
    (cell) =>
      cell.scenarioFamily === episode.scenarioFamily &&
      cell.cohort === episode.policyCohort &&
      cell.policy === episode.identity.policyId
  );
}

interface CrossSessionSummaryInput {
  readonly target: PlaytestEpisode;
  readonly rubricHash: string;
  readonly measurementVersion: string;
  readonly candidate: PlaytestEvidenceCrossSessionCandidate;
}

function crossSessionEpisodeSummary(
  input: CrossSessionSummaryInput
): PlaytestEvidenceCrossSessionEpisode {
  const { target, rubricHash, measurementVersion, candidate } = input;
  const { episode, assignment } = candidate;
  assertConfirmatoryAdapterEpisode(target);
  assertConfirmatoryAdapterEpisode(episode);
  if (
    episode.schema !== PLAYTESTS_EPISODE_SCHEMA ||
    episode.status !== "completed" ||
    episode.completeness !== "complete" ||
    episode.assignmentId !== assignment.assignmentId ||
    episode.episodeId === target.episodeId ||
    episode.identity.workspaceId !== target.identity.workspaceId ||
    episode.batchId !== target.batchId ||
    episode.identity.buildSha !== target.identity.buildSha ||
    episode.identity.gameBuild !== target.identity.gameBuild ||
    episode.identity.scenarioId !== assignment.scenarioId ||
    episode.scenarioFamily !== assignment.scenarioFamily ||
    episode.identity.policyId !== assignment.policyId ||
    episode.identity.policyVersion !== assignment.policyVersion ||
    episode.identity.seed !== assignment.seed ||
    assignment.cohort === null ||
    episode.policyCohort !== assignment.cohort
  ) {
    throw new TypeError(
      "Cross-session packet candidate does not match a complete sibling episode."
    );
  }
  assertPlaytestNumericResults(episode.metrics);
  if (
    episode.metrics.some(
      (metric) =>
        metric.provenance.workspaceId !== target.identity.workspaceId ||
        metric.provenance.buildSha !== target.identity.buildSha ||
        metric.provenance.rubricHash !== rubricHash ||
        metric.provenance.measurementVersion !== measurementVersion
    )
  ) {
    throw new TypeError(
      "Cross-session metrics do not match the frozen batch provenance."
    );
  }
  return {
    workspaceId: episode.identity.workspaceId,
    batchId: episode.batchId,
    buildSha: episode.identity.buildSha,
    rubricHash,
    episodeId: episode.episodeId,
    episodeRevision: episode.revision,
    assignmentId: assignment.assignmentId,
    scenarioId: assignment.scenarioId,
    scenarioFamily: assignment.scenarioFamily,
    policyId: assignment.policyId,
    policyVersion: assignment.policyVersion,
    cohort: assignment.cohort,
    outcome: episode.outcome,
    outcomeMetrics: episode.outcomeMetrics,
    metrics: episode.metrics.map((metric) => ({
      metricId: metric.metricId,
      metricVersion: metric.metricVersion,
      phaseId: metric.phaseId,
      estimate: metric.estimate,
      opportunityCount: metric.opportunityCount,
      coverage: metric.coverage,
      missing: metric.missing,
      missingReasons: metric.missingReasons,
      independentUnits: metric.independentUnits,
      unit: metric.unit
    }))
  };
}

/** Stable identity projection used in packet IDs and the context inventory. */
export function playtestCrossSessionInventoryHashInput(
  candidates: readonly PlaytestEvidenceCrossSessionCandidate[]
): string {
  const identities = candidates
    .map(({ episode, assignment }) => ({
      episodeId: episode.episodeId,
      episodeRevision: episode.revision,
      assignmentId: assignment.assignmentId
    }))
    .sort((left, right) =>
      left.episodeId < right.episodeId
        ? -1
        : left.episodeId > right.episodeId
          ? 1
          : 0
    );
  return canonicalPlaytestJson(identities);
}

function buildCrossSessionContext(input: {
  readonly data: BuildPlaytestEvidencePacketInput;
}): PlaytestEvidenceCrossSessionContext {
  const { data } = input;
  if (
    !isText(data.crossSessionSelectionSeed, 256) ||
    !SHA256_PATTERN.test(data.crossSessionInventoryHash)
  ) {
    throw new TypeError(
      "Cross-session packet inventory provenance is invalid."
    );
  }
  const summaries = data.crossSessionCandidates
    .map((candidate) =>
      crossSessionEpisodeSummary({
        target: data.episode,
        rubricHash: data.rubricHash,
        measurementVersion: data.measurementVersion,
        candidate
      })
    )
    .sort((left, right) =>
      left.episodeId < right.episodeId
        ? -1
        : left.episodeId > right.episodeId
          ? 1
          : 0
    );
  if (
    new Set(summaries.map((summary) => summary.episodeId)).size !==
      summaries.length ||
    new Set(summaries.map((summary) => summary.assignmentId)).size !==
      summaries.length
  ) {
    throw new TypeError("Cross-session sibling identities must be unique.");
  }
  if (summaries.length === 0) {
    return {
      status: "unavailable",
      reason: "No other complete persisted episode exists in this batch.",
      inventoryHash: data.crossSessionInventoryHash,
      eligibleSessions: 0
    };
  }
  const sampleSize = Math.min(
    MAX_PACKET_CROSS_SESSION_SESSIONS,
    summaries.length
  );
  const sample = samplePlaytestSurveillance(
    summaries.map((summary) => ({
      id: summary.episodeId,
      stratumKey: "complete-batch-siblings"
    })),
    sampleSize,
    data.crossSessionSelectionSeed
  );
  const summaryById = new Map(
    summaries.map((summary) => [summary.episodeId, summary])
  );
  const sessions = sample.selected.map((episodeId) => {
    const summary = summaryById.get(episodeId);
    if (!summary) {
      throw new TypeError("Cross-session sampler returned an unknown episode.");
    }
    return summary;
  });
  return {
    status: "included",
    inventoryHash: data.crossSessionInventoryHash,
    selectionSeed: data.crossSessionSelectionSeed,
    eligibleSessions: summaries.length,
    inclusionProbability: sampleSize / summaries.length,
    selectionMethod: "seeded-uniform-within-batch-v1",
    sessions
  };
}

function buildPacketValue(input: {
  readonly data: BuildPlaytestEvidencePacketInput;
  readonly crossSessionContext: PlaytestEvidenceCrossSessionContext;
  readonly windows: readonly PlaytestEvidenceWindow[];
  readonly omitted: readonly PlaytestOmittedEvidenceWindow[];
  readonly suppliedArtifacts: PlaytestEvidencePacket["suppliedArtifacts"];
}): PlaytestEvidencePacketV4 {
  const { data, crossSessionContext, windows, omitted, suppliedArtifacts } =
    input;
  const episode = data.episode;
  assertConfirmatoryAdapterEpisode(episode);
  const phases = [
    ...new Set(
      data.traceSteps.flatMap((entry) =>
        entry.phaseId === null ? [] : [entry.phaseId]
      )
    )
  ];
  const executionSummary = "structured engine-adapter decisions";
  const chronologicalSummary =
    `${episode.executionProvenance.mode} recorded ${String(episode.stepCount)} ${executionSummary} ` +
    `on the ${data.coverageManifest.mode} observation channel; phases: ` +
    (phases.length === 0 ? "not observed" : phases.join(", ")) +
    `; outcome: ${episode.outcome}.`;
  return {
    schema: PLAYTESTS_EVIDENCE_PACKET_SCHEMA,
    packetId: data.packetId,
    workspaceId: episode.identity.workspaceId,
    batchId: episode.batchId,
    episodeId: episode.episodeId,
    episodeRevision: episode.revision,
    assignmentId: episode.assignmentId!,
    buildSha: episode.identity.buildSha,
    gameBuild: episode.identity.gameBuild,
    scenarioId: episode.identity.scenarioId,
    scenarioFamily: episode.scenarioFamily,
    policyId: episode.identity.policyId,
    policyVersion: episode.identity.policyVersion,
    cohort: episode.policyCohort,
    outcome: episode.outcome,
    outcomeMetrics: episode.outcomeMetrics,
    observationMode: data.coverageManifest.mode,
    executionProvenance: episode.executionProvenance,
    sourceStepCount: episode.stepCount,
    rubricHash: data.rubricHash,
    rubricVersion: data.registry.registryVersion,
    audience: data.registry.audience,
    metricIntent: metricIntentFor(data.registry, episode.identity.scenarioId),
    dimensionRubrics: data.registry.dimensionRubrics,
    metrics: episode.metrics,
    coverageCells: matchingCoverageCells(data.coverageManifest, episode),
    coverageManifestHash: data.coverageManifest.contentHash,
    crossSessionContext,
    chronologicalSummary,
    traceArtifactId: episode.trace!.id,
    selectedWindows: windows,
    omittedWindows: omitted,
    omittedArtifacts: data.omittedArtifacts ?? [],
    suppliedArtifacts,
    visibleEvidenceOnly: true,
    criticRole: "playtest-analyst",
    modelId: data.modelId,
    modelRevision: data.modelRevision,
    promptHash: data.promptHash,
    measurementVersion: data.measurementVersion,
    tokenBudget: data.tokenBudget,
    generatedAt: new Date(data.generatedAt).toISOString()
  };
}

/** Freeze the exact selected evidence body before an analyst is called. */
export function buildPlaytestEvidencePacket(
  input: BuildPlaytestEvidencePacketInput
): PlaytestEvidencePacketV4 {
  assertPlaytestEvidencePacketInputs(input);
  const limits = resolveEvidenceWindowLimits(input);
  const crossSessionContext = buildCrossSessionContext({ data: input });
  const packetByteBudget = input.maxPacketBytes ?? MAX_PACKET_BYTES;
  return buildBoundedEvidenceWindows({
    traceSteps: input.traceSteps,
    limits,
    packetByteBudget,
    tokenBudget: input.tokenBudget,
    buildValue: (windows, omitted) => {
      const suppliedArtifacts = suppliedArtifactsFor({
        windows,
        hashes: input.frameHashes,
        traceArtifactId: input.episode.trace!.id,
        traceHash: input.traceHash
      });
      return buildPacketValue({
        data: input,
        crossSessionContext,
        windows,
        omitted,
        suppliedArtifacts
      });
    }
  });
}

function assertPlaytestEvidencePacketInputs(
  input: BuildPlaytestEvidencePacketInput
): void {
  const { episode, registry, coverageManifest } = input;
  assertConfirmatoryAdapterEpisode(episode);
  if (
    !isPlaytestEvidencePacketId(input.packetId) ||
    !SHA256_PATTERN.test(input.rubricHash) ||
    !SHA256_PATTERN.test(input.traceHash) ||
    !isText(input.measurementVersion) ||
    !isText(input.crossSessionSelectionSeed, 256) ||
    !SHA256_PATTERN.test(input.crossSessionInventoryHash) ||
    !Array.isArray(input.crossSessionCandidates) ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !isCount(input.tokenBudget, PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS) ||
    input.tokenBudget === 0 ||
    !isCount(input.maxPacketBytes ?? MAX_PACKET_BYTES, MAX_PACKET_BYTES) ||
    (input.maxPacketBytes ?? MAX_PACKET_BYTES) === 0 ||
    !isRecord(input.frameHashes) ||
    Object.values(input.frameHashes).some(
      (hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash)
    )
  ) {
    throw new TypeError("Evidence packet identity or budget is invalid.");
  }
  if (
    episode.schema !== PLAYTESTS_EPISODE_SCHEMA ||
    episode.status !== "completed" ||
    episode.completeness !== "complete" ||
    episode.assignmentId === null ||
    episode.trace === null ||
    input.assignment.cohort === null ||
    episode.assignmentId !== input.assignment.assignmentId ||
    episode.identity.scenarioId !== input.assignment.scenarioId ||
    episode.identity.policyId !== input.assignment.policyId ||
    episode.identity.policyVersion !== input.assignment.policyVersion ||
    episode.identity.seed !== input.assignment.seed ||
    episode.policyCohort !== input.assignment.cohort ||
    episode.scenarioFamily !== input.assignment.scenarioFamily ||
    episode.identity.workspaceId !== registry.workspaceId ||
    episode.identity.workspaceId !== coverageManifest.workspaceId ||
    episode.batchId !== coverageManifest.batchId ||
    episode.identity.buildSha !== coverageManifest.buildSha ||
    coverageManifest.rubricHash !== input.rubricHash
  ) {
    throw new TypeError(
      "Evidence packet source does not match its frozen episode, rubric and coverage identities."
    );
  }
  assertPlaytestCoverageManifest(coverageManifest);
  assertPlaytestNumericResults(episode.metrics);
  if (
    episode.metrics.some(
      (metric) =>
        metric.provenance.workspaceId !== episode.identity.workspaceId ||
        metric.provenance.buildSha !== episode.identity.buildSha ||
        metric.provenance.rubricHash !== input.rubricHash ||
        metric.provenance.measurementVersion !== input.measurementVersion
    )
  ) {
    throw new TypeError(
      "Evidence packet metrics do not match the frozen episode provenance."
    );
  }
  if (input.crossSessionCandidates.length > 999) {
    throw new RangeError(
      "Cross-session packet inventory exceeds the frozen batch assignment bound."
    );
  }
  if (
    episode.stepCount < 1 ||
    input.traceSteps.length !== episode.stepCount ||
    input.traceSteps.length > MAX_PACKET_STEPS * 16
  ) {
    throw new RangeError(
      "Evidence packet requires the complete bounded episode trace."
    );
  }
  for (const [index, step] of input.traceSteps.entries()) {
    assertTraceStep(step, index);
  }
  assertUniqueTraceEventIds(input.traceSteps);
  const frameIds = new Set<string>();
  for (const step of input.traceSteps) {
    for (const reference of step.frameRefs) {
      if (
        frameIds.has(reference.id) ||
        input.frameHashes[reference.id] === undefined
      ) {
        throw new TypeError(
          "Evidence packet frame provenance is missing or duplicated."
        );
      }
      frameIds.add(reference.id);
    }
  }
  for (const hash of Object.values(input.frameHashes)) {
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      throw new TypeError("Evidence packet frame hash is invalid.");
    }
  }
  if (
    (input.modelId !== null && !isText(input.modelId)) ||
    (input.modelRevision !== null && !isText(input.modelRevision)) ||
    (input.promptHash !== null && !SHA256_PATTERN.test(input.promptHash))
  ) {
    throw new TypeError(
      "Evidence packet model or prompt provenance is invalid."
    );
  }
}

function validPacketIdentity(value: Record<string, unknown>): boolean {
  return (
    (value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA ||
      value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V3 ||
      value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2 ||
      value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1) &&
    isPlaytestEvidencePacketId(value.packetId) &&
    isText(value.workspaceId) &&
    isText(value.batchId) &&
    isText(value.episodeId) &&
    isCount(value.episodeRevision, Number.MAX_SAFE_INTEGER) &&
    isText(value.assignmentId) &&
    typeof value.buildSha === "string" &&
    BUILD_SHA_PATTERN.test(value.buildSha) &&
    isText(value.gameBuild) &&
    isText(value.scenarioId) &&
    isText(value.scenarioFamily) &&
    isText(value.policyId) &&
    isText(value.policyVersion) &&
    isText(value.cohort)
  );
}

function validPacketOutcomeAndMeasurement(
  value: Record<string, unknown>
): boolean {
  return (
    PLAYTESTS_GAME_OUTCOMES.includes(
      value.outcome as PlaytestGameOutcomeKind
    ) &&
    isRecord(value.outcomeMetrics) &&
    Object.values(value.outcomeMetrics).every(
      (metric) =>
        metric === null ||
        (typeof metric === "number" && Number.isFinite(metric))
    ) &&
    PLAYTESTS_GAME_MODES.includes(value.observationMode as PlaytestGameMode) &&
    isCount(value.sourceStepCount, 4096) &&
    value.sourceStepCount !== 0 &&
    typeof value.rubricHash === "string" &&
    SHA256_PATTERN.test(value.rubricHash) &&
    isText(value.rubricVersion) &&
    isText(value.audience) &&
    Array.isArray(value.metricIntent) &&
    Array.isArray(value.dimensionRubrics) &&
    Array.isArray(value.metrics) &&
    Array.isArray(value.coverageCells) &&
    typeof value.coverageManifestHash === "string" &&
    SHA256_PATTERN.test(value.coverageManifestHash)
  );
}

function validPacketReviewMetadata(value: Record<string, unknown>): boolean {
  return (
    isText(value.chronologicalSummary, 4096) &&
    isText(value.traceArtifactId) &&
    Array.isArray(value.selectedWindows) &&
    Array.isArray(value.omittedWindows) &&
    Array.isArray(value.omittedArtifacts) &&
    Array.isArray(value.suppliedArtifacts) &&
    value.visibleEvidenceOnly === true &&
    value.criticRole === "playtest-analyst" &&
    (value.modelId === null || isText(value.modelId)) &&
    (value.modelRevision === null || isText(value.modelRevision)) &&
    (value.promptHash === null ||
      (typeof value.promptHash === "string" &&
        SHA256_PATTERN.test(value.promptHash))) &&
    isText(value.measurementVersion) &&
    isCount(value.tokenBudget, PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS) &&
    value.tokenBudget !== 0 &&
    Number.isFinite(Date.parse(String(value.generatedAt)))
  );
}

/** Validate packet fields before persistence or model exposure. */
export function assertPlaytestEvidencePacket(
  value: unknown
): asserts value is PlaytestEvidencePacket {
  const packetKeys =
    isRecord(value) && value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1
      ? PACKET_V1_KEYS
      : isRecord(value) && value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA
        ? PACKET_V4_KEYS
        : PACKET_KEYS;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== packetKeys.size ||
    Object.keys(value).some((key) => !packetKeys.has(key))
  ) {
    throw new TypeError(
      "Playtest evidence packet has unknown or missing fields."
    );
  }
  if (
    !validPacketIdentity(value) ||
    !validPacketOutcomeAndMeasurement(value) ||
    !validPacketReviewMetadata(value)
  ) {
    throw new TypeError("Playtest evidence packet fields are invalid.");
  }
  assertPacketMetricIntent(
    value.metricIntent,
    value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA ||
      value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V3
  );
  if (value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA) {
    assertPlaytestExecutionProvenance(value.executionProvenance);
  }
  if (value.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1) {
    assertCrossSessionContext(value.crossSessionContext, value);
  }
  assertPacketArtifactProvenance(
    value as unknown as PlaytestEvidencePacketArtifactView
  );
  assertOmittedPacketArtifacts(
    value as unknown as PlaytestEvidencePacketOmittedArtifactView
  );

  assertPlaytestNumericResults(value.metrics);
  const ordered = (value.selectedWindows as unknown[]).map((window) => {
    if (
      !isRecord(window) ||
      Object.keys(window).length !== 4 ||
      Object.keys(window).some(
        (key) =>
          !["startStep", "endStep", "selectionReasons", "steps"].includes(key)
      ) ||
      !isCount(window.startStep) ||
      !isCount(window.endStep) ||
      window.endStep < window.startStep ||
      !Array.isArray(window.selectionReasons) ||
      window.selectionReasons.length === 0 ||
      !window.selectionReasons.every((reason) =>
        ["event-bearing-step", "terminal", "ordinary-sample"].includes(
          String(reason)
        )
      ) ||
      !Array.isArray(window.steps) ||
      window.steps.length !==
        (window.endStep as number) - (window.startStep as number) + 1
    ) {
      throw new TypeError("Playtest evidence packet window is malformed.");
    }
    for (const [index, step] of window.steps.entries()) {
      assertTraceStep(step, (window.startStep as number) + index);
    }
    const reasons = window.selectionReasons as readonly unknown[];
    if (
      window.steps.some(hasMandatoryEventEvidenceValue) &&
      !reasons.includes("event-bearing-step")
    ) {
      throw new TypeError(
        "Packet omitted the event-bearing selection reason for an event step."
      );
    }
    if (
      window.endStep === (value.sourceStepCount as number) - 1 &&
      !reasons.includes("terminal")
    ) {
      throw new TypeError(
        "Packet must mark its terminal trace step as selected."
      );
    }
    return {
      startStep: window.startStep as number,
      endStep: window.endStep as number
    };
  });
  assertUniqueSelectedEventIds(
    value.selectedWindows as readonly PlaytestEvidenceWindow[]
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startStep <= ordered[index - 1]!.endStep + 1) {
      throw new TypeError(
        "Playtest evidence packet windows overlap or are not ordered."
      );
    }
  }
  const partitions = [
    ...ordered.map((range) => ({ ...range, kind: "selected" as const })),
    ...(value.omittedWindows as unknown[]).map((window) => {
      if (
        !isRecord(window) ||
        Object.keys(window).length !== 3 ||
        Object.keys(window).some(
          (key) => !["startStep", "endStep", "reason"].includes(key)
        ) ||
        !isCount(window.startStep) ||
        !isCount(window.endStep) ||
        window.endStep < window.startStep ||
        (window.reason !== "ordinary-sampling" &&
          window.reason !== "packet-budget")
      ) {
        throw new TypeError("Packet omitted-window record is malformed.");
      }
      return {
        startStep: window.startStep,
        endStep: window.endStep,
        kind: "omitted" as const
      };
    })
  ].sort((left, right) => left.startStep - right.startStep);
  let nextStep = 0;
  for (const range of partitions) {
    if (
      range.startStep !== nextStep ||
      range.endStep >= (value.sourceStepCount as number)
    ) {
      throw new TypeError(
        "Packet selected and omitted ranges do not partition the source trace."
      );
    }
    nextStep = range.endStep + 1;
  }
  if (nextStep !== value.sourceStepCount) {
    throw new TypeError(
      "Packet selected and omitted ranges leave source steps unaccounted."
    );
  }
  if (
    (value.selectedWindows as unknown[]).length > MAX_PACKET_WINDOWS ||
    ordered.reduce((sum, item) => sum + item.endStep - item.startStep + 1, 0) >
      MAX_PACKET_STEPS ||
    packetContentBytes(value as unknown as PlaytestEvidencePacket) >
      Math.min(MAX_PACKET_BYTES, value.tokenBudget as number)
  ) {
    throw new RangeError(
      "Playtest evidence packet exceeds its window/token budget."
    );
  }
}

function assertPacketMetricIntent(
  value: unknown,
  hasAggregationSemantics: boolean
): asserts value is readonly (
  PlaytestEvidenceMetricIntent | PlaytestEvidenceMetricIntentV2
)[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new TypeError("Evidence packet metric intent is malformed.");
  }
  const keys = hasAggregationSemantics
    ? METRIC_INTENT_V3_KEYS
    : METRIC_INTENT_V2_KEYS;
  const metricIds = new Set<string>();
  for (const intent of value) {
    if (
      !isRecord(intent) ||
      Object.keys(intent).length !== keys.size ||
      Object.keys(intent).some((key) => !keys.has(key)) ||
      !isText(intent.metricId) ||
      !isCount(intent.version, Number.MAX_SAFE_INTEGER) ||
      intent.version === 0 ||
      !isText(intent.mechanicKey) ||
      !isText(intent.audience) ||
      !isText(intent.numerator, 2000) ||
      !isText(intent.denominator, 2000) ||
      !isText(intent.unit) ||
      !isText(intent.polarity) ||
      !Array.isArray(intent.targetBand) ||
      intent.targetBand.length !== 2 ||
      intent.targetBand.some(
        (bound) => bound !== null && typeof bound !== "number"
      ) ||
      !isText(intent.exposurePredicate) ||
      !Array.isArray(intent.eventFields) ||
      intent.eventFields.some((field) => !isText(field)) ||
      metricIds.has(intent.metricId)
    ) {
      throw new TypeError("Evidence packet metric intent is malformed.");
    }
    if (
      hasAggregationSemantics &&
      (![
        "episode",
        "decision",
        "cohort",
        "learner-identity",
        "participant"
      ].includes(String(intent.analysisUnit)) ||
        !["whole-episode", "phase", "session", "response"].includes(
          String(intent.aggregationWindow)
        ) ||
        ![
          "ratio-of-sums-within-scenario",
          "native-item-mean-and-category-distribution",
          "descriptive"
        ].includes(String(intent.aggregation)))
    ) {
      throw new TypeError(
        "Evidence packet metric aggregation semantics are malformed."
      );
    }
    metricIds.add(intent.metricId);
  }
}

function assertCrossSessionContext(
  value: unknown,
  packet: Record<string, unknown>
): asserts value is PlaytestEvidenceCrossSessionContext {
  if (!isRecord(value) || !SHA256_PATTERN.test(String(value.inventoryHash))) {
    throw new TypeError("Evidence packet cross-session context is malformed.");
  }
  if (value.status === "unavailable") {
    if (
      Object.keys(value).length !== 4 ||
      !["status", "reason", "inventoryHash", "eligibleSessions"].every(
        (key) => key in value
      ) ||
      !isText(value.reason, 2000) ||
      value.eligibleSessions !== 0
    ) {
      throw new TypeError(
        "Evidence packet unavailable cross-session context is malformed."
      );
    }
    return;
  }
  if (
    value.status !== "included" ||
    Object.keys(value).length !== 7 ||
    ![
      "status",
      "inventoryHash",
      "selectionSeed",
      "eligibleSessions",
      "inclusionProbability",
      "selectionMethod",
      "sessions"
    ].every((key) => key in value) ||
    !isText(value.selectionSeed, 256) ||
    !isCount(value.eligibleSessions, 999) ||
    value.eligibleSessions === 0 ||
    value.selectionMethod !== "seeded-uniform-within-batch-v1" ||
    !Array.isArray(value.sessions) ||
    value.sessions.length === 0 ||
    value.sessions.length > MAX_PACKET_CROSS_SESSION_SESSIONS ||
    value.sessions.length > value.eligibleSessions ||
    value.sessions.length !==
      Math.min(MAX_PACKET_CROSS_SESSION_SESSIONS, value.eligibleSessions) ||
    typeof value.inclusionProbability !== "number" ||
    value.inclusionProbability !==
      value.sessions.length / value.eligibleSessions
  ) {
    throw new TypeError(
      "Evidence packet included cross-session context is malformed."
    );
  }
  const episodeIds = new Set<string>();
  const assignmentIds = new Set<string>();
  for (const session of value.sessions) {
    if (
      !isRecord(session) ||
      Object.keys(session).length !== 15 ||
      ![
        "workspaceId",
        "batchId",
        "buildSha",
        "rubricHash",
        "episodeId",
        "episodeRevision",
        "assignmentId",
        "scenarioId",
        "scenarioFamily",
        "policyId",
        "policyVersion",
        "cohort",
        "outcome",
        "outcomeMetrics",
        "metrics"
      ].every((key) => key in session) ||
      !isText(session.workspaceId) ||
      !isText(session.batchId) ||
      !BUILD_SHA_PATTERN.test(String(session.buildSha)) ||
      !SHA256_PATTERN.test(String(session.rubricHash)) ||
      !isText(session.episodeId) ||
      !isCount(session.episodeRevision, Number.MAX_SAFE_INTEGER) ||
      !isText(session.assignmentId) ||
      !isText(session.scenarioId) ||
      !isText(session.scenarioFamily) ||
      !isText(session.policyId) ||
      !isText(session.policyVersion) ||
      !isText(session.cohort) ||
      !PLAYTESTS_GAME_OUTCOMES.includes(
        session.outcome as PlaytestGameOutcomeKind
      ) ||
      !isRecord(session.outcomeMetrics) ||
      Object.values(session.outcomeMetrics).some(
        (metric) =>
          metric !== null &&
          (typeof metric !== "number" || !Number.isFinite(metric))
      ) ||
      !Array.isArray(session.metrics) ||
      session.metrics.length > 1000 ||
      session.workspaceId !== packet.workspaceId ||
      session.batchId !== packet.batchId ||
      session.buildSha !== packet.buildSha ||
      session.rubricHash !== packet.rubricHash ||
      session.episodeId === packet.episodeId ||
      session.assignmentId === packet.assignmentId ||
      episodeIds.has(String(session.episodeId)) ||
      assignmentIds.has(String(session.assignmentId))
    ) {
      throw new TypeError(
        "Evidence packet sibling episode summary is malformed or mismatched."
      );
    }
    episodeIds.add(session.episodeId as string);
    assignmentIds.add(session.assignmentId as string);
    const metricKeys = new Set<string>();
    for (const metric of session.metrics) {
      if (
        !isRecord(metric) ||
        Object.keys(metric).length !== 10 ||
        ![
          "metricId",
          "metricVersion",
          "phaseId",
          "estimate",
          "opportunityCount",
          "coverage",
          "missing",
          "missingReasons",
          "independentUnits",
          "unit"
        ].every((key) => key in metric) ||
        !isText(metric.metricId) ||
        ((typeof metric.metricVersion !== "string" ||
          !isText(metric.metricVersion)) &&
          !isCount(metric.metricVersion, Number.MAX_SAFE_INTEGER)) ||
        (metric.phaseId !== null && !isText(metric.phaseId)) ||
        (metric.estimate !== null &&
          (typeof metric.estimate !== "number" ||
            !Number.isFinite(metric.estimate))) ||
        (metric.opportunityCount !== null &&
          !isCount(metric.opportunityCount)) ||
        typeof metric.coverage !== "number" ||
        !Number.isFinite(metric.coverage) ||
        metric.coverage < 0 ||
        metric.coverage > 1 ||
        !isCount(metric.missing) ||
        !Array.isArray(metric.missingReasons) ||
        metric.missingReasons.some(
          (reason) =>
            !PLAYTESTS_MISSING_REASONS.includes(
              reason as (typeof PLAYTESTS_MISSING_REASONS)[number]
            )
        ) ||
        !isCount(metric.independentUnits) ||
        !isText(metric.unit)
      ) {
        throw new TypeError(
          "Evidence packet sibling metric summary is malformed."
        );
      }
      const key = `${metric.metricId}\0${metric.phaseId ?? "<whole-episode>"}`;
      if (metricKeys.has(key)) {
        throw new TypeError(
          "Evidence packet sibling metrics contain a duplicate metric/phase pair."
        );
      }
      metricKeys.add(key);
    }
  }
}
