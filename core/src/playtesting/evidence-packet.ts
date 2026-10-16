/** Deterministic selection and validation for bounded analyst evidence packets. */

import {
  type PlaytestCoverageManifest,
  type PlaytestEpisode,
  type PlaytestEvidenceCrossSessionContext,
  type PlaytestEvidenceCrossSessionEpisode,
  type PlaytestEvidenceMetricIntent,
  type PlaytestEvidenceMetricIntentV2,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidencePacket,
  type PlaytestEvidencePacketV3,
  type PlaytestEvidenceSelectionReason,
  type PlaytestEvidenceTraceEvent,
  type PlaytestEvidenceTraceStep,
  type PlaytestEvidenceWindow,
  type PlaytestGameOutcomeKind,
  type PlaytestOmittedEvidenceWindow,
  PLAYTESTS_GAME_OUTCOMES
} from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import { assertPlaytestCoverageManifest } from "./coverage.ts";
import { assertPlaytestNumericResults } from "./metric-evaluation.ts";
import type { PlaytestMetricRegistry } from "./registry.ts";
import { samplePlaytestSurveillance } from "./sampling.ts";
import {
  type PlaytestBatchAssignment,
  type PlaytestEvidenceLocator,
  type PlaytestGameMode,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2,
  PLAYTESTS_GAME_MODES,
  PLAYTESTS_MISSING_REASONS
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const PACKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PACKET_WINDOWS = 32;
export const MAX_PACKET_CROSS_SESSION_SESSIONS = 4;
const MAX_PACKET_STEPS = 256;
const MAX_PACKET_BYTES = 262_144;
export const PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS = 32_768;
const SAMPLEABLE_ACTION_EVENT_TYPES = new Set([
  "decision_applied",
  "card_played",
  "race_started",
  "reward_claimed"
]);
const MAX_STEP_EVENTS = 256;
const TRACE_STEP_KEYS = new Set([
  "step",
  "phaseId",
  "revisionBefore",
  "revisionAfter",
  "observationVisibility",
  "visibleObservation",
  "legalActionIds",
  "selectedActionId",
  "preActionPrediction",
  "authoritativeOutcome",
  "events",
  "frameRefs"
]);

/** Core-owned packet ID syntax shared by packets, receipts and reviews. */
export function isPlaytestEvidencePacketId(value: unknown): value is string {
  return typeof value === "string" && PACKET_ID_PATTERN.test(value);
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

interface SelectionRange {
  readonly startStep: number;
  readonly endStep: number;
  readonly reasons: ReadonlySet<PlaytestEvidenceSelectionReason>;
  readonly mandatory: boolean;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

function isCount(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

function isJson(value: unknown, depth = 0): boolean {
  if (depth > 48) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => isJson(entry, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJson(entry, depth + 1))
  );
}

function assertTraceStep(
  value: unknown,
  expectedStep: number
): asserts value is PlaytestEvidenceTraceStep {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== TRACE_STEP_KEYS.size ||
    Object.keys(value).some((key) => !TRACE_STEP_KEYS.has(key)) ||
    value.step !== expectedStep ||
    (value.phaseId !== null && !isText(value.phaseId)) ||
    !isCount(value.revisionBefore) ||
    (value.revisionAfter !== null && !isCount(value.revisionAfter)) ||
    (value.observationVisibility !== "structured" &&
      value.observationVisibility !== "visual-only") ||
    !isJson(value.visibleObservation) ||
    !Array.isArray(value.legalActionIds) ||
    value.legalActionIds.length > 256 ||
    value.legalActionIds.some((action) => !isText(action)) ||
    (value.selectedActionId !== null && !isText(value.selectedActionId)) ||
    (value.selectedActionId !== null &&
      !value.legalActionIds.includes(value.selectedActionId)) ||
    (value.preActionPrediction !== null &&
      !isJson(value.preActionPrediction)) ||
    (value.authoritativeOutcome !== null &&
      !isJson(value.authoritativeOutcome)) ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_STEP_EVENTS ||
    !Array.isArray(value.frameRefs)
  ) {
    throw new TypeError(
      "Evidence packet trace step is malformed or not player-visible."
    );
  }
  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      Object.keys(event).length !== 4 ||
      Object.keys(event).some(
        (key) => !["eventId", "type", "phaseId", "revision"].includes(key)
      ) ||
      !isText(event.eventId) ||
      !isText(event.type) ||
      (event.phaseId !== null && !isText(event.phaseId)) ||
      !isCount(event.revision) ||
      eventIds.has(event.eventId)
    ) {
      throw new TypeError(
        "Evidence packet trace event is malformed or duplicated."
      );
    }
    eventIds.add(event.eventId);
  }
  for (const reference of value.frameRefs) {
    if (
      !isRecord(reference) ||
      reference.kind !== "frame" ||
      !isText(reference.id) ||
      (reference.step !== undefined && reference.step !== expectedStep)
    ) {
      throw new TypeError(
        "Evidence packet contains an invalid frame reference."
      );
    }
  }
}

function mergeRanges(ranges: readonly SelectionRange[]): SelectionRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.startStep - right.startStep || left.endStep - right.endStep
  );
  const merged: SelectionRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.startStep > last.endStep + 1) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      startStep: last.startStep,
      endStep: Math.max(last.endStep, range.endStep),
      reasons: new Set([...last.reasons, ...range.reasons]),
      mandatory: last.mandatory || range.mandatory
    };
  }
  return merged;
}

function rangeStepCount(ranges: readonly SelectionRange[]): number {
  return ranges.reduce(
    (total, range) => total + range.endStep - range.startStep + 1,
    0
  );
}

function rangeAround(
  step: number,
  lastStep: number,
  radius: number,
  reason: PlaytestEvidenceSelectionReason,
  mandatory: boolean
): SelectionRange {
  return {
    startStep: Math.max(0, step - radius),
    endStep: Math.min(lastStep, step + radius),
    reasons: new Set([reason]),
    mandatory
  };
}

/**
 * Generic decision/card-play events and checked-in lifecycle transitions
 * repeat actions/state changes already carried by trace steps. Keep those lines
 * sampleable; outcome events and other game-specific events remain packet
 * anchors because they carry evidence not represented by the action.
 */
function hasMandatoryEventEvidence(entry: PlaytestEvidenceTraceStep): boolean {
  return entry.events.some(
    (event) => !SAMPLEABLE_ACTION_EVENT_TYPES.has(event.type)
  );
}

function hasMandatoryEventEvidenceValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.events) &&
    value.events.some(
      (event) =>
        isRecord(event) &&
        !SAMPLEABLE_ACTION_EVENT_TYPES.has(String(event.type))
    )
  );
}

function initiallySelectedRanges(
  trace: readonly PlaytestEvidenceTraceStep[],
  limits: {
    readonly maxWindows: number;
    readonly maxSteps: number;
    readonly radius: number;
  }
): SelectionRange[] {
  const lastStep = trace.at(-1)!.step;
  const mandatoryAnchors = trace
    .filter(hasMandatoryEventEvidence)
    .map((entry) =>
      rangeAround(entry.step, lastStep, 0, "event-bearing-step", true)
    );
  mandatoryAnchors.push(
    rangeAround(lastStep, lastStep, limits.radius, "terminal", true)
  );
  let selected = mergeRanges(mandatoryAnchors);
  if (
    selected.length > limits.maxWindows ||
    rangeStepCount(selected) > limits.maxSteps
  ) {
    throw new RangeError(
      "Mandatory event and terminal evidence exceeds the packet budget."
    );
  }

  const covered = new Set<number>();
  for (const range of selected) {
    for (let step = range.startStep; step <= range.endStep; step += 1)
      covered.add(step);
  }
  const ordinary = trace.filter(
    (entry) => !hasMandatoryEventEvidence(entry) && !covered.has(entry.step)
  );
  const remainingSlots = Math.max(0, limits.maxWindows - selected.length);
  const candidateCount = Math.min(ordinary.length, remainingSlots);
  for (let index = 0; index < candidateCount; index += 1) {
    const position = Math.floor(
      ((index + 0.5) * ordinary.length) / candidateCount
    );
    const candidate = ordinary[position];
    if (!candidate) continue;
    const ordinaryRange = rangeAround(
      candidate.step,
      lastStep,
      limits.radius,
      "ordinary-sample",
      false
    );
    if (
      selected.some(
        (range) =>
          ordinaryRange.startStep <= range.endStep &&
          ordinaryRange.endStep >= range.startStep
      )
    ) {
      continue;
    }
    const proposed = mergeRanges([...selected, ordinaryRange]);
    if (
      proposed.length <= limits.maxWindows &&
      rangeStepCount(proposed) <= limits.maxSteps
    ) {
      selected = proposed;
    }
  }
  return selected;
}

function omittedWindowsFor(input: {
  readonly trace: readonly PlaytestEvidenceTraceStep[];
  readonly ranges: readonly SelectionRange[];
  readonly packetBudgetOmissions: ReadonlySet<number>;
}): readonly PlaytestOmittedEvidenceWindow[] {
  const selected = new Set<number>();
  for (const range of input.ranges) {
    for (let step = range.startStep; step <= range.endStep; step += 1)
      selected.add(step);
  }
  const omitted: PlaytestOmittedEvidenceWindow[] = [];
  for (const entry of input.trace) {
    if (selected.has(entry.step)) continue;
    const reason = input.packetBudgetOmissions.has(entry.step)
      ? "packet-budget"
      : "ordinary-sampling";
    const previous = omitted.at(-1);
    if (
      previous &&
      previous.endStep + 1 === entry.step &&
      previous.reason === reason
    ) {
      omitted[omitted.length - 1] = { ...previous, endStep: entry.step };
    } else {
      omitted.push({ startStep: entry.step, endStep: entry.step, reason });
    }
  }
  return omitted;
}

function selectedWindowsFrom(
  trace: readonly PlaytestEvidenceTraceStep[],
  ranges: readonly SelectionRange[]
): readonly PlaytestEvidenceWindow[] {
  return ranges.map((range) => ({
    startStep: range.startStep,
    endStep: range.endStep,
    selectionReasons: [...range.reasons].sort(),
    steps: trace.slice(range.startStep, range.endStep + 1)
  }));
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
  episode: PlaytestEpisode
) {
  return manifest.cells.filter(
    (cell) =>
      cell.scenarioFamily === episode.scenarioFamily &&
      cell.cohort === episode.policyCohort &&
      cell.policy === episode.identity.policyId
  );
}

function suppliedArtifactsFor(input: {
  readonly windows: readonly PlaytestEvidenceWindow[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly traceArtifactId: string;
  readonly traceHash: string;
}): PlaytestEvidencePacket["suppliedArtifacts"] {
  const artifacts = new Map<
    string,
    PlaytestEvidencePacket["suppliedArtifacts"][number]
  >([
    [
      "trace:" + input.traceArtifactId,
      {
        kind: "trace",
        artifactId: input.traceArtifactId,
        sha256: input.traceHash.toLowerCase()
      }
    ]
  ]);
  for (const window of input.windows) {
    for (const step of window.steps) {
      for (const reference of step.frameRefs) {
        const hash = input.hashes[reference.id];
        if (hash !== undefined) {
          artifacts.set("frame:" + reference.id, {
            kind: "frame",
            artifactId: reference.id,
            sha256: hash.toLowerCase()
          });
        }
      }
    }
  }
  return [...artifacts.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    if (left.artifactId === right.artifactId) return 0;
    return left.artifactId < right.artifactId ? -1 : 1;
  });
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

function packetContentBytes(packet: PlaytestEvidencePacket): number {
  return new TextEncoder().encode(canonicalPlaytestJson(packet)).byteLength;
}

function buildPacketValue(input: {
  readonly data: BuildPlaytestEvidencePacketInput;
  readonly crossSessionContext: PlaytestEvidenceCrossSessionContext;
  readonly windows: readonly PlaytestEvidenceWindow[];
  readonly omitted: readonly PlaytestOmittedEvidenceWindow[];
  readonly suppliedArtifacts: PlaytestEvidencePacket["suppliedArtifacts"];
}): PlaytestEvidencePacketV3 {
  const { data, crossSessionContext, windows, omitted, suppliedArtifacts } =
    input;
  const episode = data.episode;
  const phases = [
    ...new Set(
      data.traceSteps.flatMap((entry) =>
        entry.phaseId === null ? [] : [entry.phaseId]
      )
    )
  ];
  const chronologicalSummary =
    `Completed ${String(episode.stepCount)} player-visible decisions; phases: ` +
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
): PlaytestEvidencePacketV3 {
  assertPlaytestEvidencePacketInputs(input);
  const maxWindows = input.maxWindows ?? 16;
  const maxSelectedSteps = input.maxSelectedSteps ?? 128;
  const radius = input.windowRadius ?? 1;
  if (
    !isCount(maxWindows, MAX_PACKET_WINDOWS) ||
    maxWindows < 1 ||
    !isCount(maxSelectedSteps, MAX_PACKET_STEPS) ||
    maxSelectedSteps < 1 ||
    !isCount(radius, 4)
  ) {
    throw new RangeError(
      "Evidence packet selection limits are outside their approved bounds."
    );
  }
  let ranges = initiallySelectedRanges(input.traceSteps, {
    maxWindows,
    maxSteps: maxSelectedSteps,
    radius
  });
  const crossSessionContext = buildCrossSessionContext({ data: input });
  const packetByteBudget = input.maxPacketBytes ?? MAX_PACKET_BYTES;
  const packetBudgetOmissions = new Set<number>();
  let omitted = omittedWindowsFor({
    trace: input.traceSteps,
    ranges,
    packetBudgetOmissions
  });
  while (true) {
    const windows = selectedWindowsFrom(input.traceSteps, ranges);
    const suppliedArtifacts = suppliedArtifactsFor({
      windows,
      hashes: input.frameHashes,
      traceArtifactId: input.episode.trace!.id,
      traceHash: input.traceHash
    });
    const packet = buildPacketValue({
      data: input,
      crossSessionContext,
      windows,
      omitted,
      suppliedArtifacts
    });
    const bytes = packetContentBytes(packet);
    if (bytes <= packetByteBudget && bytes <= input.tokenBudget) return packet;
    const removable = [...ranges]
      .reverse()
      .find(
        (range) => !range.mandatory && range.reasons.has("ordinary-sample")
      );
    if (!removable) {
      throw new RangeError(
        "Mandatory event and terminal evidence exceeds the analyst packet byte/token budget."
      );
    }
    for (let step = removable.startStep; step <= removable.endStep; step += 1) {
      packetBudgetOmissions.add(step);
    }
    ranges = ranges.filter((range) => range !== removable);
    omitted = omittedWindowsFor({
      trace: input.traceSteps,
      ranges,
      packetBudgetOmissions
    });
  }
}

function assertPlaytestEvidencePacketInputs(
  input: BuildPlaytestEvidencePacketInput
): void {
  const { episode, registry, coverageManifest } = input;
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

function assertPacketArtifactProvenance(packet: PlaytestEvidencePacket): void {
  const expectedFrames = new Set<string>();
  for (const window of packet.selectedWindows) {
    for (const step of window.steps) {
      for (const reference of step.frameRefs) expectedFrames.add(reference.id);
    }
  }
  const frameIds = new Set<string>();
  let traceCount = 0;
  for (const artifact of packet.suppliedArtifacts) {
    if (
      !isRecord(artifact) ||
      Object.keys(artifact).length !== 3 ||
      Object.keys(artifact).some(
        (key) => !["kind", "artifactId", "sha256"].includes(key)
      ) ||
      !isText(artifact.artifactId) ||
      typeof artifact.sha256 !== "string" ||
      !SHA256_PATTERN.test(artifact.sha256)
    ) {
      throw new TypeError(
        "Evidence packet supplied-artifact provenance is invalid."
      );
    }
    if (artifact.kind === "trace") {
      traceCount += 1;
      if (artifact.artifactId !== packet.traceArtifactId) {
        throw new TypeError(
          "Evidence packet trace artifact identity is inconsistent."
        );
      }
    } else if (artifact.kind === "frame") {
      if (
        !expectedFrames.has(artifact.artifactId) ||
        frameIds.has(artifact.artifactId)
      ) {
        throw new TypeError(
          "Evidence packet frame artifact identity is inconsistent."
        );
      }
      frameIds.add(artifact.artifactId);
    } else {
      throw new TypeError(
        "Evidence packet supplied artifact kind is unsupported."
      );
    }
  }
  if (
    traceCount !== 1 ||
    frameIds.size !== expectedFrames.size ||
    [...expectedFrames].some((frameId) => !frameIds.has(frameId))
  ) {
    throw new TypeError(
      "Evidence packet does not bind every supplied trace and frame."
    );
  }
}

function assertOmittedPacketArtifacts(packet: PlaytestEvidencePacket): void {
  const suppliedFrameIds = new Set(
    packet.suppliedArtifacts
      .filter((artifact) => artifact.kind === "frame")
      .map((artifact) => artifact.artifactId)
  );
  const omittedIds = new Set<string>();
  for (const artifact of packet.omittedArtifacts) {
    if (
      artifact.kind !== "frame" ||
      !isText(artifact.artifactId) ||
      !isCount(artifact.step) ||
      ![
        "missing",
        "expired",
        "invalid-reference",
        "unsupported-media"
      ].includes(artifact.reason) ||
      suppliedFrameIds.has(artifact.artifactId) ||
      omittedIds.has(artifact.artifactId)
    ) {
      throw new TypeError(
        "Evidence packet omitted-artifact record is malformed."
      );
    }
    omittedIds.add(artifact.artifactId);
  }
}

/** Validate packet fields before persistence or model exposure. */
export function assertPlaytestEvidencePacket(
  value: unknown
): asserts value is PlaytestEvidencePacket {
  const packetKeys =
    isRecord(value) && value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1
      ? PACKET_V1_KEYS
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
    (value.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA &&
      value.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V2 &&
      value.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1) ||
    !isPlaytestEvidencePacketId(value.packetId) ||
    !isText(value.workspaceId) ||
    !isText(value.batchId) ||
    !isText(value.episodeId) ||
    !isCount(value.episodeRevision, Number.MAX_SAFE_INTEGER) ||
    !isText(value.assignmentId) ||
    typeof value.buildSha !== "string" ||
    !BUILD_SHA_PATTERN.test(value.buildSha) ||
    !isText(value.gameBuild) ||
    !isText(value.scenarioId) ||
    !isText(value.scenarioFamily) ||
    !isText(value.policyId) ||
    !isText(value.policyVersion) ||
    !isText(value.cohort) ||
    !PLAYTESTS_GAME_OUTCOMES.includes(
      value.outcome as PlaytestGameOutcomeKind
    ) ||
    !isRecord(value.outcomeMetrics) ||
    Object.values(value.outcomeMetrics).some(
      (metric) =>
        metric !== null &&
        (typeof metric !== "number" || !Number.isFinite(metric))
    ) ||
    !PLAYTESTS_GAME_MODES.includes(value.observationMode as PlaytestGameMode) ||
    !isCount(value.sourceStepCount, 4096) ||
    value.sourceStepCount === 0 ||
    !SHA256_PATTERN.test(String(value.rubricHash)) ||
    !isText(value.rubricVersion) ||
    !isText(value.audience) ||
    !Array.isArray(value.metricIntent) ||
    !Array.isArray(value.dimensionRubrics) ||
    !Array.isArray(value.metrics) ||
    !Array.isArray(value.coverageCells) ||
    !SHA256_PATTERN.test(String(value.coverageManifestHash)) ||
    !isText(value.chronologicalSummary, 4096) ||
    !isText(value.traceArtifactId) ||
    !Array.isArray(value.selectedWindows) ||
    !Array.isArray(value.omittedWindows) ||
    !Array.isArray(value.omittedArtifacts) ||
    !Array.isArray(value.suppliedArtifacts) ||
    value.visibleEvidenceOnly !== true ||
    value.criticRole !== "playtest-analyst" ||
    (value.modelId !== null && !isText(value.modelId)) ||
    (value.modelRevision !== null && !isText(value.modelRevision)) ||
    (value.promptHash !== null &&
      !SHA256_PATTERN.test(String(value.promptHash))) ||
    !isText(value.measurementVersion) ||
    !isCount(value.tokenBudget, PLAYTESTS_EVIDENCE_PACKET_MAX_TOKENS) ||
    value.tokenBudget === 0 ||
    !Number.isFinite(Date.parse(String(value.generatedAt)))
  ) {
    throw new TypeError("Playtest evidence packet fields are invalid.");
  }
  assertPacketMetricIntent(
    value.metricIntent,
    value.schema === PLAYTESTS_EVIDENCE_PACKET_SCHEMA
  );
  if (value.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA_V1) {
    assertCrossSessionContext(value.crossSessionContext, value);
  }
  assertPacketArtifactProvenance(value as unknown as PlaytestEvidencePacket);
  assertOmittedPacketArtifacts(value as unknown as PlaytestEvidencePacket);
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

function assertUniqueSelectedEventIds(
  windows: readonly PlaytestEvidenceWindow[]
): void {
  const eventIds = new Set<string>();
  for (const window of windows) {
    assertUniqueTraceEventIds(window.steps, eventIds);
  }
}

function assertUniqueTraceEventIds(
  steps: readonly PlaytestEvidenceTraceStep[],
  eventIds = new Set<string>()
): void {
  for (const step of steps) {
    for (const event of step.events) {
      if (eventIds.has(event.eventId)) {
        throw new TypeError(
          "Playtest evidence packet contains a duplicate event ID."
        );
      }
      eventIds.add(event.eventId);
    }
  }
}

interface EvidencePacketLocatorIndex {
  readonly selectedSteps: ReadonlySet<number>;
  readonly events: ReadonlyMap<
    string,
    { readonly event: PlaytestEvidenceTraceEvent; readonly step: number }
  >;
  readonly frames: ReadonlyMap<string, PlaytestEvidenceLocator>;
}

function evidencePacketLocatorIndex(
  packet: PlaytestEvidencePacket
): EvidencePacketLocatorIndex {
  const selectedSteps = new Set<number>();
  const events = new Map<
    string,
    { readonly event: PlaytestEvidenceTraceEvent; readonly step: number }
  >();
  const frames = new Map<string, PlaytestEvidenceLocator>();
  for (const window of packet.selectedWindows) {
    for (const step of window.steps) {
      selectedSteps.add(step.step);
      for (const event of step.events) {
        events.set(event.eventId, { event, step: step.step });
      }
      for (const frame of step.frameRefs) frames.set(frame.id, frame);
    }
  }
  return { selectedSteps, events, frames };
}

function assertEpisodeLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  packet: PlaytestEvidencePacket,
  selectedSteps: ReadonlySet<number>
): void {
  if (locator.id === packet.episodeId) {
    if (locator.step !== undefined && !selectedSteps.has(locator.step)) {
      throw new TypeError(
        "Review episode locator points outside the selected evidence packet."
      );
    }
    return;
  }
  const siblingEpisodes =
    "crossSessionContext" in packet &&
    packet.crossSessionContext.status === "included"
      ? packet.crossSessionContext.sessions
      : [];
  if (
    !siblingEpisodes.some((episode) => episode.episodeId === locator.id) ||
    locator.step !== undefined ||
    locator.revision !== undefined ||
    locator.frameIndex !== undefined ||
    locator.phaseId !== undefined
  ) {
    throw new TypeError(
      "Review episode locator points outside the selected evidence packet or cites a sibling at unsupported granularity."
    );
  }
}

function assertReplayLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  packet: PlaytestEvidencePacket,
  selectedSteps: ReadonlySet<number>
): void {
  if (
    locator.id !== packet.traceArtifactId ||
    (locator.step !== undefined && !selectedSteps.has(locator.step))
  ) {
    throw new TypeError(
      "Review replay locator points outside the selected evidence packet."
    );
  }
}

function assertEventLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  events: EvidencePacketLocatorIndex["events"]
): void {
  if (locator.kind !== "event") return;
  const event = events.get(locator.id);
  if (
    !event ||
    (locator.step !== undefined && locator.step !== event.step) ||
    (locator.revision !== undefined &&
      locator.revision !== event.event.revision) ||
    (locator.phaseId !== undefined && locator.phaseId !== event.event.phaseId)
  ) {
    throw new TypeError(
      "Review event locator is absent from the selected evidence packet."
    );
  }
}

function assertFrameLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  frames: EvidencePacketLocatorIndex["frames"]
): void {
  if (locator.kind !== "frame") return;
  const frame = frames.get(locator.id);
  if (
    !frame ||
    (locator.step !== undefined && locator.step !== frame.step) ||
    (locator.frameIndex !== undefined &&
      locator.frameIndex !== frame.frameIndex)
  ) {
    throw new TypeError(
      "Review frame locator is absent from the selected evidence packet."
    );
  }
}

/** Keep analyst citations within the exact packet delivered for this review. */
export function assertPlaytestEvidenceLocatorsWithinPacket(
  values: readonly PlaytestEvidenceLocator[],
  packet: PlaytestEvidencePacket
): void {
  const index = evidencePacketLocatorIndex(packet);
  for (const locator of values) {
    switch (locator.kind) {
      case "episode": {
        assertEpisodeLocatorWithinPacket(locator, packet, index.selectedSteps);
        break;
      }
      case "replay-segment": {
        assertReplayLocatorWithinPacket(locator, packet, index.selectedSteps);
        break;
      }
      case "event": {
        assertEventLocatorWithinPacket(locator, index.events);
        break;
      }
      case "frame": {
        assertFrameLocatorWithinPacket(locator, index.frames);
        break;
      }
      default: {
        throw new TypeError(
          "Review packet citations may reference only the delivered episode, replay, event and frame evidence."
        );
      }
    }
  }
}
