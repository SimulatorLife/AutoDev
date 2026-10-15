/** Deterministic, bounded aggregation of exact frozen playtest metric packets. */
import type {
  PlaytestCrossSessionMetricAggregate,
  PlaytestCrossSessionMetricAggregation,
  PlaytestCrossSessionMetricPacketRef,
  PlaytestEvidencePacket
} from "./artifacts.ts";
import { PLAYTESTS_MAX_ANALYSIS_SESSIONS } from "./batch-run.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import { assertPlaytestEvidencePacket } from "./evidence-packet.ts";
import { assertPlaytestNumericResults } from "./metric-evaluation.ts";
import {
  type PlaytestMissingReason,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_MISSING_REASONS
} from "./types.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const MAX_METRIC_AGGREGATION_BYTES = 16 * 1024;
const MAX_METRIC_AGGREGATE_ROWS = 256;
const MAX_SYNTHESIS_PAYLOAD_BYTES = 64 * 1024;
const AGGREGATION_METHOD = "ratio-of-sums-within-identical-stratum-v1" as const;
const RATIO_OF_SUMS_AGGREGATION = "ratio-of-sums-within-scenario" as const;
const NOT_RECORDED_STATUS = "not-recorded" as const;
const HISTORICAL_AGGREGATION_REASON =
  "historical-synthesis-predates-aggregation" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isMetricVersion(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 256)
  );
}

export interface PlaytestCrossSessionMetricPacketInput {
  readonly episodeId: string;
  readonly batchId: string;
  readonly packet: PlaytestEvidencePacket;
}

interface MetricAccumulator {
  readonly intent: {
    readonly analysisUnit: PlaytestCrossSessionMetricAggregate["analysisUnit"];
    readonly aggregationWindow: PlaytestCrossSessionMetricAggregate["aggregationWindow"];
    readonly aggregation: typeof RATIO_OF_SUMS_AGGREGATION;
  };
  readonly identity: Omit<
    PlaytestCrossSessionMetricAggregate,
    | "sourcePacketIndices"
    | "sessionCount"
    | "numerator"
    | "denominator"
    | "opportunityCount"
    | "missing"
    | "missingReasons"
    | "estimate"
    | "coverage"
    | "independentUnits"
  >;
  numerator: number;
  denominator: number;
  opportunityCount: number | null;
  missing: number;
  readonly missingReasons: Set<PlaytestMissingReason>;
  readonly packetIds: Set<string>;
}

/**
 * Pool only frozen ratio-of-sums metric rows inside identical measurement
 * strata. This is descriptive selected-session arithmetic, not a comparison,
 * confidence interval, or population estimate.
 */
export function aggregatePlaytestCrossSessionMetrics(input: {
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly packets: readonly PlaytestCrossSessionMetricPacketInput[];
}): PlaytestCrossSessionMetricAggregation {
  const sourcePackets = normalizeMetricPacketRefs(input);
  const refusal = metricAggregationRefusal(input.packets, sourcePackets);
  if (refusal !== null) {
    return metricAggregationResult({
      workspaceId: input.workspaceId,
      analysisId: input.analysisId,
      status: refusal.status,
      sourcePackets,
      reason: refusal.reason
    });
  }

  const collected = collectMetricAggregates(input);
  const rows = aggregateRows(collected.accumulators, sourcePackets);
  const omittedMetrics = sortedMetricOmissions(collected.omitted);
  return metricAggregationOutcome({
    workspaceId: input.workspaceId,
    analysisId: input.analysisId,
    sourcePackets,
    rows,
    omittedMetrics
  });
}

type MetricAggregationRefusal = {
  readonly status: "unavailable" | "insufficient-packets";
  readonly reason:
    | "historical-packet-predates-aggregation-semantics"
    | "fewer-than-two-packets";
};

function metricAggregationRefusal(
  packets: readonly PlaytestCrossSessionMetricPacketInput[],
  sourcePackets: readonly PlaytestCrossSessionMetricPacketRef[]
): MetricAggregationRefusal | null {
  if (
    packets.some(
      ({ packet }) => packet.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA
    )
  ) {
    return {
      status: "unavailable",
      reason: "historical-packet-predates-aggregation-semantics"
    };
  }
  if (sourcePackets.length < 2) {
    return { status: "insufficient-packets", reason: "fewer-than-two-packets" };
  }
  return null;
}

interface CollectedMetricAggregates {
  readonly accumulators: ReadonlyMap<string, MetricAccumulator>;
  readonly omitted: ReadonlyMap<
    string,
    PlaytestCrossSessionMetricAggregation["omittedMetrics"][number]
  >;
}

function collectMetricAggregates(input: {
  readonly workspaceId: string;
  readonly packets: readonly PlaytestCrossSessionMetricPacketInput[];
}): CollectedMetricAggregates {
  const accumulators = new Map<string, MetricAccumulator>();
  const omitted = new Map<
    string,
    PlaytestCrossSessionMetricAggregation["omittedMetrics"][number]
  >();
  const packets = [...input.packets].sort((left, right) =>
    left.episodeId < right.episodeId
      ? -1
      : left.episodeId > right.episodeId
        ? 1
        : 0
  );
  for (const { packet } of packets) {
    if (packet.schema !== PLAYTESTS_EVIDENCE_PACKET_SCHEMA) {
      throw new TypeError(
        "Cross-session metric aggregation requires frozen v3 metric semantics."
      );
    }
    const intents = new Map(
      packet.metricIntent.map((intent) => [intent.metricId, intent])
    );
    assertPlaytestNumericResults(packet.metrics);
    for (const metric of packet.metrics) {
      const intent = intents.get(metric.metricId);
      if (!intent || intent.version !== metric.metricVersion) {
        throw new TypeError(
          "Cross-session packet metric rows must match their frozen registry intent."
        );
      }
      if (intent.aggregation !== RATIO_OF_SUMS_AGGREGATION) {
        addUnsupportedMetric(omitted, metric.metricId, metric.metricVersion);
        continue;
      }
      addMetricContribution({
        accumulators,
        workspaceId: input.workspaceId,
        packet,
        metric,
        intent: {
          analysisUnit: intent.analysisUnit,
          aggregationWindow: intent.aggregationWindow,
          aggregation: RATIO_OF_SUMS_AGGREGATION
        }
      });
    }
  }
  return { accumulators, omitted };
}

function addUnsupportedMetric(
  omitted: Map<
    string,
    PlaytestCrossSessionMetricAggregation["omittedMetrics"][number]
  >,
  metricId: string,
  metricVersion: number | string
): void {
  const omission = {
    metricId,
    metricVersion,
    reason: "unsupported-aggregation" as const
  };
  omitted.set(canonicalPlaytestJson(omission), omission);
}

function addMetricContribution(input: {
  readonly accumulators: Map<string, MetricAccumulator>;
  readonly workspaceId: string;
  readonly packet: Extract<
    PlaytestEvidencePacket,
    { readonly schema: typeof PLAYTESTS_EVIDENCE_PACKET_SCHEMA }
  >;
  readonly metric: PlaytestEvidencePacket["metrics"][number];
  readonly intent: MetricAccumulator["intent"];
}): void {
  const { accumulators, workspaceId, packet, metric, intent } = input;
  const identity = {
    metricId: metric.metricId,
    metricVersion: metric.metricVersion,
    phaseId: metric.phaseId,
    unit: metric.unit,
    aggregation: RATIO_OF_SUMS_AGGREGATION,
    analysisUnit: intent.analysisUnit,
    aggregationWindow: intent.aggregationWindow,
    buildSha: packet.buildSha,
    gameBuild: packet.gameBuild,
    rubricHash: packet.rubricHash,
    evaluatorHash: metric.provenance.evaluatorHash ?? null,
    measurementVersion: metric.provenance.measurementVersion,
    scenarioId: packet.scenarioId,
    scenarioFamily: packet.scenarioFamily,
    policyId: packet.policyId,
    policyVersion: packet.policyVersion,
    cohort: packet.cohort,
    observationMode: packet.observationMode
  };
  if (
    identity.evaluatorHash === null ||
    !isSha256(identity.evaluatorHash) ||
    metric.provenance.workspaceId !== workspaceId ||
    metric.provenance.buildSha !== packet.buildSha ||
    metric.provenance.rubricHash !== packet.rubricHash ||
    metric.provenance.measurementVersion !== packet.measurementVersion
  ) {
    throw new TypeError(
      "Cross-session aggregation requires complete, packet-matched metric provenance."
    );
  }

  const validatedIdentity = {
    ...identity,
    evaluatorHash: identity.evaluatorHash
  };
  const groupKey = canonicalPlaytestJson(validatedIdentity);
  const accumulator =
    accumulators.get(groupKey) ??
    newMetricAccumulator(validatedIdentity, intent);
  addSufficientStatistics(accumulator, metric);
  accumulator.packetIds.add(packet.packetId);
  assertAccumulatorCounts(accumulator);
  accumulators.set(groupKey, accumulator);
}

function newMetricAccumulator(
  identity: MetricAccumulator["identity"],
  intent: MetricAccumulator["intent"]
): MetricAccumulator {
  return {
    identity: identity as MetricAccumulator["identity"],
    intent,
    numerator: 0,
    denominator: 0,
    opportunityCount: 0,
    missing: 0,
    missingReasons: new Set<PlaytestMissingReason>(),
    packetIds: new Set<string>()
  };
}

function addSufficientStatistics(
  accumulator: MetricAccumulator,
  metric: PlaytestEvidencePacket["metrics"][number]
): void {
  accumulator.numerator += metric.numerator;
  accumulator.denominator += metric.denominator;
  if (metric.opportunityCount === null) {
    accumulator.opportunityCount = null;
  } else if (accumulator.opportunityCount !== null) {
    accumulator.opportunityCount += metric.opportunityCount;
  }
  accumulator.missing += metric.missing;
  for (const reason of metric.missingReasons) {
    accumulator.missingReasons.add(reason);
  }
}

function assertAccumulatorCounts(accumulator: MetricAccumulator): void {
  if (
    !Number.isFinite(accumulator.numerator) ||
    !Number.isFinite(accumulator.denominator) ||
    !isCount(accumulator.missing) ||
    (accumulator.opportunityCount !== null &&
      !isCount(accumulator.opportunityCount))
  ) {
    throw new RangeError("Cross-session metric totals exceed safe bounds.");
  }
}

function aggregateRows(
  accumulators: ReadonlyMap<string, MetricAccumulator>,
  sourcePackets: readonly PlaytestCrossSessionMetricPacketRef[]
): readonly PlaytestCrossSessionMetricAggregate[] {
  const sourceIndexByPacketId = new Map(
    sourcePackets.map((source, index) => [source.packetId, index])
  );
  return [...accumulators.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, accumulator]) => aggregateRow(accumulator, sourceIndexByPacketId));
}

function aggregateRow(
  accumulator: MetricAccumulator,
  sourceIndexByPacketId: ReadonlyMap<string, number>
): PlaytestCrossSessionMetricAggregate {
  const packetIds = [...accumulator.packetIds].sort();
  const sourcePacketIndices = packetIds
    .map((packetId) => {
      const index = sourceIndexByPacketId.get(packetId);
      if (index === undefined) {
        throw new TypeError("Metric aggregate references an unknown packet.");
      }
      return index;
    })
    .sort((left, right) => left - right);
  const { denominator, opportunityCount, numerator, missing } = accumulator;
  return {
    ...accumulator.identity,
    evaluatorHash: accumulator.identity.evaluatorHash!,
    sourcePacketIndices,
    sessionCount: packetIds.length,
    numerator,
    denominator,
    opportunityCount,
    missing,
    missingReasons: [...accumulator.missingReasons].sort(),
    estimate: denominator === 0 ? null : numerator / denominator,
    coverage:
      opportunityCount === null
        ? null
        : opportunityCount === 0
          ? 0
          : denominator / opportunityCount,
    independentUnits:
      accumulator.intent.analysisUnit === "episode" ? packetIds.length : null
  };
}

function sortedMetricOmissions(
  omissions: ReadonlyMap<
    string,
    PlaytestCrossSessionMetricAggregation["omittedMetrics"][number]
  >
): PlaytestCrossSessionMetricAggregation["omittedMetrics"] {
  return [...omissions.values()].sort((left, right) => {
    const leftKey =
      String(left.metricId) +
      "@" +
      String(left.metricVersion) +
      ":" +
      left.reason;
    const rightKey =
      String(right.metricId) +
      "@" +
      String(right.metricVersion) +
      ":" +
      right.reason;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function metricAggregationOutcome(input: {
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly sourcePackets: readonly PlaytestCrossSessionMetricPacketRef[];
  readonly rows: readonly PlaytestCrossSessionMetricAggregate[];
  readonly omittedMetrics: PlaytestCrossSessionMetricAggregation["omittedMetrics"];
}): PlaytestCrossSessionMetricAggregation {
  if (input.rows.length === 0) {
    return metricAggregationResult({
      workspaceId: input.workspaceId,
      analysisId: input.analysisId,
      status:
        input.omittedMetrics.length === 0
          ? "no-applicable-metrics"
          : "unavailable",
      sourcePackets: input.sourcePackets,
      omittedMetrics: input.omittedMetrics,
      reason:
        input.omittedMetrics.length === 0
          ? "no-applicable-metric-rows"
          : "no-supported-aggregation"
    });
  }
  if (input.rows.length > MAX_METRIC_AGGREGATE_ROWS) {
    return metricAggregationResult({
      workspaceId: input.workspaceId,
      analysisId: input.analysisId,
      status: "unavailable",
      sourcePackets: input.sourcePackets,
      reason: "aggregation-result-exceeds-budget"
    });
  }
  return metricAggregationResult({
    workspaceId: input.workspaceId,
    analysisId: input.analysisId,
    status: input.omittedMetrics.length > 0 ? "partial" : "available",
    sourcePackets: input.sourcePackets,
    rows: input.rows,
    omittedMetrics: input.omittedMetrics,
    reason: null
  });
}

function normalizeMetricPacketRefs(input: {
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly packets: readonly PlaytestCrossSessionMetricPacketInput[];
}): readonly PlaytestCrossSessionMetricPacketRef[] {
  if (
    !WORKSPACE_ID_PATTERN.test(input.workspaceId) ||
    !isIdentifier(input.analysisId) ||
    !Array.isArray(input.packets) ||
    input.packets.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    throw new TypeError(
      "Cross-session metric aggregation identity is invalid."
    );
  }
  const episodeIds = new Set<string>();
  const packetIds = new Set<string>();
  const refs = input.packets.map(({ episodeId, batchId, packet }) => {
    assertPlaytestEvidencePacket(packet);
    if (
      !isIdentifier(episodeId) ||
      !isIdentifier(batchId) ||
      episodeIds.has(episodeId) ||
      packetIds.has(packet.packetId) ||
      packet.episodeId !== episodeId ||
      packet.batchId !== batchId ||
      packet.workspaceId !== input.workspaceId
    ) {
      throw new TypeError("Cross-session metric packet identity is invalid.");
    }
    episodeIds.add(episodeId);
    packetIds.add(packet.packetId);
    return { episodeId, batchId, packetId: packet.packetId };
  });
  return refs.sort((left, right) =>
    left.episodeId < right.episodeId
      ? -1
      : left.episodeId > right.episodeId
        ? 1
        : 0
  );
}

function metricAggregationResult(input: {
  readonly workspaceId: string;
  readonly analysisId: string;
  readonly status: PlaytestCrossSessionMetricAggregation["status"];
  readonly sourcePackets: readonly PlaytestCrossSessionMetricPacketRef[];
  readonly rows?: readonly PlaytestCrossSessionMetricAggregate[];
  readonly omittedMetrics?: PlaytestCrossSessionMetricAggregation["omittedMetrics"];
  readonly reason: PlaytestCrossSessionMetricAggregation["reason"];
}): PlaytestCrossSessionMetricAggregation {
  const result: PlaytestCrossSessionMetricAggregation = {
    schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
    workspaceId: input.workspaceId,
    analysisId: input.analysisId,
    status: input.status,
    method: AGGREGATION_METHOD,
    sourcePackets: input.sourcePackets,
    rows: input.rows ?? [],
    omittedMetrics: input.omittedMetrics ?? [],
    reason: input.reason
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength <=
    MAX_METRIC_AGGREGATION_BYTES
  ) {
    return result;
  }
  const unavailable: PlaytestCrossSessionMetricAggregation = {
    ...result,
    status: "unavailable",
    rows: [],
    omittedMetrics: [],
    reason: "aggregation-result-exceeds-budget"
  };
  if (
    new TextEncoder().encode(JSON.stringify(unavailable)).byteLength >
    MAX_SYNTHESIS_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      "Cross-session packet source identities exceed the immutable synthesis payload budget."
    );
  }
  return unavailable;
}

const METRIC_AGGREGATION_KEYS = new Set([
  "schema",
  "workspaceId",
  "analysisId",
  "status",
  "method",
  "sourcePackets",
  "rows",
  "omittedMetrics",
  "reason"
]);
const METRIC_AGGREGATE_ROW_KEYS = new Set([
  "metricId",
  "metricVersion",
  "phaseId",
  "unit",
  "aggregation",
  "analysisUnit",
  "aggregationWindow",
  "buildSha",
  "gameBuild",
  "rubricHash",
  "evaluatorHash",
  "measurementVersion",
  "scenarioId",
  "scenarioFamily",
  "policyId",
  "policyVersion",
  "cohort",
  "observationMode",
  "sourcePacketIndices",
  "sessionCount",
  "numerator",
  "denominator",
  "opportunityCount",
  "missing",
  "missingReasons",
  "estimate",
  "coverage",
  "independentUnits"
]);

interface MetricAggregationEnvelope extends Record<string, unknown> {
  readonly sourcePackets: readonly unknown[];
  readonly rows: readonly unknown[];
  readonly omittedMetrics: readonly unknown[];
  readonly status: PlaytestCrossSessionMetricAggregation["status"];
  readonly reason: PlaytestCrossSessionMetricAggregation["reason"];
}

function assertCrossSessionMetricAggregation(
  value: unknown,
  workspaceId: string,
  analysisId: string,
  selectedEpisodeIds: ReadonlySet<string>
): asserts value is PlaytestCrossSessionMetricAggregation {
  assertMetricAggregationEnvelope(value, workspaceId, analysisId);
  const sourceEpisodeIds = assertMetricAggregationSources(
    value.sourcePackets,
    selectedEpisodeIds
  );
  if (value.status === NOT_RECORDED_STATUS) {
    assertHistoricalMetricAggregation(value);
    return;
  }
  assertSelectedMetricPacketCoverage(sourceEpisodeIds, selectedEpisodeIds);
  assertMetricAggregationOmissions(value.omittedMetrics);
  assertMetricAggregationRows(value.rows, value.sourcePackets.length);
  assertMetricAggregationStatus(value);
}

function assertMetricAggregationEnvelope(
  value: unknown,
  workspaceId: string,
  analysisId: string
): asserts value is MetricAggregationEnvelope {
  if (!isRecord(value)) {
    throw new TypeError("Cross-session metric aggregation is malformed.");
  }
  assertMetricAggregationIdentity(value, workspaceId, analysisId);
  assertMetricAggregationLists(value);
}

function assertMetricAggregationIdentity(
  value: Record<string, unknown>,
  workspaceId: string,
  analysisId: string
): void {
  if (
    Object.keys(value).length !== METRIC_AGGREGATION_KEYS.size ||
    Object.keys(value).some((key) => !METRIC_AGGREGATION_KEYS.has(key)) ||
    value.schema !== PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA ||
    value.workspaceId !== workspaceId ||
    value.analysisId !== analysisId ||
    value.method !== AGGREGATION_METHOD ||
    !isAggregationStatus(value.status)
  ) {
    throw new TypeError(
      "Cross-session metric aggregation identity is invalid."
    );
  }
}

function isAggregationStatus(
  value: unknown
): value is PlaytestCrossSessionMetricAggregation["status"] {
  return [
    "available",
    "partial",
    "no-applicable-metrics",
    "insufficient-packets",
    "unavailable",
    NOT_RECORDED_STATUS
  ].includes(String(value));
}

function assertMetricAggregationLists(value: Record<string, unknown>): void {
  if (
    !Array.isArray(value.sourcePackets) ||
    value.sourcePackets.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_METRIC_AGGREGATE_ROWS ||
    !Array.isArray(value.omittedMetrics) ||
    value.omittedMetrics.length > 1000
  ) {
    throw new TypeError(
      "Cross-session metric aggregation lists are malformed."
    );
  }
}

function assertMetricAggregationSources(
  value: readonly unknown[],
  selectedEpisodeIds: ReadonlySet<string>
): ReadonlySet<string> {
  const sourceEpisodeIds = new Set<string>();
  const sourcePacketIds = new Set<string>();
  let previousEpisodeId: string | null = null;
  for (const source of value) {
    if (!isMetricPacketReference(source, sourceEpisodeIds, sourcePacketIds)) {
      throw new TypeError(
        "Cross-session metric packet sources must be unique selected packet identities."
      );
    }
    const episodeId = (source as { readonly episodeId: string }).episodeId;
    if (
      (previousEpisodeId !== null && episodeId < previousEpisodeId) ||
      !selectedEpisodeIds.has(episodeId)
    ) {
      throw new TypeError(
        "Cross-session metric packet sources must match the sorted trusted selection."
      );
    }
    sourceEpisodeIds.add(episodeId);
    sourcePacketIds.add((source as { readonly packetId: string }).packetId);
    previousEpisodeId = episodeId;
  }
  return sourceEpisodeIds;
}

function isMetricPacketReference(
  value: unknown,
  episodeIds: ReadonlySet<string>,
  packetIds: ReadonlySet<string>
): value is {
  readonly episodeId: string;
  readonly batchId: string;
  readonly packetId: string;
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    !Object.keys(value).some(
      (key) => !["episodeId", "batchId", "packetId"].includes(key)
    ) &&
    isIdentifier(value.episodeId) &&
    isIdentifier(value.batchId) &&
    isIdentifier(value.packetId) &&
    !episodeIds.has(value.episodeId) &&
    !packetIds.has(value.packetId)
  );
}

function assertHistoricalMetricAggregation(
  value: MetricAggregationEnvelope
): void {
  if (
    value.sourcePackets.length > 0 ||
    value.rows.length > 0 ||
    value.omittedMetrics.length > 0 ||
    value.reason !== HISTORICAL_AGGREGATION_REASON
  ) {
    throw new TypeError(
      "Historical cross-session synthesis must identify unavailable aggregation."
    );
  }
}

function assertSelectedMetricPacketCoverage(
  sourceEpisodeIds: ReadonlySet<string>,
  selectedEpisodeIds: ReadonlySet<string>
): void {
  if (
    sourceEpisodeIds.size !== selectedEpisodeIds.size ||
    [...selectedEpisodeIds].some(
      (episodeId) => !sourceEpisodeIds.has(episodeId)
    )
  ) {
    throw new TypeError(
      "Cross-session aggregation must bind every packet selected for its analysis."
    );
  }
}

function assertMetricAggregationOmissions(value: readonly unknown[]): void {
  const seen = new Set<string>();
  for (const omitted of value) {
    assertOmittedMetric(omitted);
    const key = canonicalPlaytestJson(omitted);
    if (seen.has(key)) {
      throw new TypeError(
        "Cross-session omitted metric records must be unique."
      );
    }
    seen.add(key);
  }
}

function assertOmittedMetric(
  value: unknown
): asserts value is PlaytestCrossSessionMetricAggregation["omittedMetrics"][number] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) => !["metricId", "metricVersion", "reason"].includes(key)
    ) ||
    !isIdentifier(value.metricId) ||
    !isMetricVersion(value.metricVersion) ||
    ![
      "unsupported-aggregation",
      "missing-frozen-semantics",
      "not-recorded"
    ].includes(String(value.reason))
  ) {
    throw new TypeError("Cross-session omitted metric record is malformed.");
  }
}

function assertMetricAggregationRows(
  value: readonly unknown[],
  sourcePacketCount: number
): void {
  const seen = new Set<string>();
  for (const row of value) {
    const identity = assertMetricAggregateRow(row, sourcePacketCount);
    if (seen.has(identity)) {
      throw new TypeError(
        "Cross-session metric aggregation rows must be unique."
      );
    }
    seen.add(identity);
  }
}

function assertMetricAggregateRow(
  value: unknown,
  sourcePacketCount: number
): string {
  if (!isRecord(value)) {
    throw new TypeError("Cross-session metric aggregate row is malformed.");
  }
  assertMetricAggregateKeys(value);
  assertMetricAggregateSemantics(value);
  assertMetricAggregateProvenance(value);
  assertMetricAggregateSourceIndices(value, sourcePacketCount);
  assertMetricAggregateCounts(value);
  assertMetricAggregateMeasures(value);
  return metricAggregateIdentity(value);
}

function assertMetricAggregateKeys(value: Record<string, unknown>): void {
  if (
    Object.keys(value).length !== METRIC_AGGREGATE_ROW_KEYS.size ||
    Object.keys(value).some((key) => !METRIC_AGGREGATE_ROW_KEYS.has(key))
  ) {
    throw new TypeError(
      "Cross-session metric aggregate row has unknown fields."
    );
  }
}

function assertMetricAggregateSemantics(value: Record<string, unknown>): void {
  if (
    !isIdentifier(value.metricId) ||
    !isMetricVersion(value.metricVersion) ||
    (value.phaseId !== null && !isIdentifier(value.phaseId)) ||
    !isText(value.unit, 256) ||
    value.aggregation !== RATIO_OF_SUMS_AGGREGATION ||
    ![
      "episode",
      "decision",
      "cohort",
      "learner-identity",
      "participant"
    ].includes(String(value.analysisUnit)) ||
    !["whole-episode", "phase", "session", "response"].includes(
      String(value.aggregationWindow)
    ) ||
    !["headless", "browser", "native-visual"].includes(
      String(value.observationMode)
    )
  ) {
    throw new TypeError(
      "Cross-session metric aggregate semantics are invalid."
    );
  }
}

function assertMetricAggregateProvenance(value: Record<string, unknown>): void {
  if (
    !BUILD_SHA_PATTERN.test(String(value.buildSha)) ||
    !isText(value.gameBuild) ||
    !isSha256(value.rubricHash) ||
    !isSha256(value.evaluatorHash) ||
    !isText(value.measurementVersion) ||
    !isIdentifier(value.scenarioId) ||
    !isIdentifier(value.scenarioFamily) ||
    !isIdentifier(value.policyId) ||
    !isIdentifier(value.policyVersion) ||
    !isIdentifier(value.cohort)
  ) {
    throw new TypeError(
      "Cross-session metric aggregate provenance is invalid."
    );
  }
}

function assertMetricAggregateSourceIndices(
  value: Record<string, unknown>,
  sourcePacketCount: number
): void {
  if (
    !Array.isArray(value.sourcePacketIndices) ||
    value.sourcePacketIndices.length === 0 ||
    value.sourcePacketIndices.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
    value.sourcePacketIndices.some(
      (index) => !isCount(index) || index >= sourcePacketCount
    ) ||
    value.sourcePacketIndices.some(
      (index, position, indices) =>
        position > 0 && index <= (indices[position - 1] as number)
    )
  ) {
    throw new TypeError(
      "Cross-session metric aggregate packet indices are invalid."
    );
  }
}

function assertMetricAggregateCounts(value: Record<string, unknown>): void {
  if (
    !isCount(value.sessionCount) ||
    value.sessionCount !==
      (value.sourcePacketIndices as readonly unknown[]).length ||
    !isFiniteNumber(value.numerator) ||
    !isFiniteNumber(value.denominator) ||
    value.denominator < 0 ||
    (value.opportunityCount !== null && !isCount(value.opportunityCount)) ||
    !isCount(value.missing) ||
    !Array.isArray(value.missingReasons) ||
    value.missingReasons.some(
      (reason) => !PLAYTESTS_MISSING_REASONS.includes(reason as never)
    ) ||
    new Set(value.missingReasons).size !== value.missingReasons.length ||
    (value.independentUnits !== null && !isCount(value.independentUnits))
  ) {
    throw new TypeError("Cross-session metric aggregate counts are invalid.");
  }
}

function assertMetricAggregateMeasures(value: Record<string, unknown>): void {
  if (
    (value.estimate !== null && !isFiniteNumber(value.estimate)) ||
    (value.coverage !== null &&
      (!isFiniteNumber(value.coverage) ||
        value.coverage < 0 ||
        value.coverage > 1))
  ) {
    throw new TypeError("Cross-session metric aggregate measures are invalid.");
  }
  if (
    value.analysisUnit === "episode"
      ? value.independentUnits !== value.sessionCount
      : value.independentUnits !== null
  ) {
    throw new TypeError(
      "Cross-session independent units must be episode-deduplicated or explicitly unavailable."
    );
  }
  const opportunityCount = value.opportunityCount as number | null;
  const denominator = value.denominator as number;
  const missing = value.missing as number;
  assertPooledEstimate(value);
  assertAggregateCoverage(value, opportunityCount);
  if (
    opportunityCount !== null &&
    (denominator > opportunityCount ||
      missing > opportunityCount ||
      denominator + missing > opportunityCount)
  ) {
    throw new TypeError(
      "Cross-session aggregate exposure counts are inconsistent."
    );
  }
}

function assertPooledEstimate(value: Record<string, unknown>): void {
  if (
    value.denominator === 0
      ? value.estimate !== null
      : value.estimate === null ||
        Math.abs(
          (value.estimate as number) -
            (value.numerator as number) / (value.denominator as number)
        ) > 1e-12
  ) {
    throw new TypeError(
      "Cross-session pooled estimate disagrees with its sufficient statistics."
    );
  }
}

function assertAggregateCoverage(
  value: Record<string, unknown>,
  opportunityCount: number | null
): void {
  if (
    opportunityCount === null
      ? value.coverage !== null
      : opportunityCount === 0
        ? value.coverage !== 0 || value.denominator !== 0
        : value.coverage === null ||
          Math.abs(
            (value.coverage as number) -
              (value.denominator as number) / opportunityCount
          ) > 1e-12
  ) {
    throw new TypeError(
      "Cross-session aggregate coverage disagrees with its opportunity counts."
    );
  }
}

function metricAggregateIdentity(value: Record<string, unknown>): string {
  return canonicalPlaytestJson({
    metricId: value.metricId,
    metricVersion: value.metricVersion,
    phaseId: value.phaseId,
    unit: value.unit,
    aggregation: value.aggregation,
    analysisUnit: value.analysisUnit,
    aggregationWindow: value.aggregationWindow,
    buildSha: value.buildSha,
    gameBuild: value.gameBuild,
    rubricHash: value.rubricHash,
    evaluatorHash: value.evaluatorHash,
    measurementVersion: value.measurementVersion,
    scenarioId: value.scenarioId,
    scenarioFamily: value.scenarioFamily,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    cohort: value.cohort,
    observationMode: value.observationMode
  });
}

function assertMetricAggregationStatus(value: MetricAggregationEnvelope): void {
  const { status, rows, sourcePackets, omittedMetrics, reason } = value;
  if (
    (status === "available" &&
      (rows.length === 0 || omittedMetrics.length > 0 || reason !== null)) ||
    (status === "partial" &&
      (rows.length === 0 || omittedMetrics.length === 0 || reason !== null)) ||
    (status === "no-applicable-metrics" &&
      (rows.length > 0 ||
        omittedMetrics.length > 0 ||
        reason !== "no-applicable-metric-rows")) ||
    (status === "insufficient-packets" &&
      (sourcePackets.length >= 2 ||
        rows.length > 0 ||
        reason !== "fewer-than-two-packets")) ||
    (status === "unavailable" &&
      (rows.length > 0 ||
        ![
          "no-supported-aggregation",
          "aggregation-result-exceeds-budget",
          "historical-packet-predates-aggregation-semantics"
        ].includes(String(reason))))
  ) {
    throw new TypeError(
      "Cross-session metric aggregation status is inconsistent."
    );
  }
}

/** Validate the trusted Runtime aggregate against its exact analyst selection. */
export function assertPlaytestCrossSessionMetricAggregation(
  value: unknown,
  workspaceId: string,
  analysisId: string,
  episodeIds: readonly string[],
  options: { readonly allowNotRecorded?: boolean } = {}
): asserts value is PlaytestCrossSessionMetricAggregation {
  if (
    episodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
    new Set(episodeIds).size !== episodeIds.length
  ) {
    throw new TypeError("Cross-session metric selection is invalid.");
  }
  assertCrossSessionMetricAggregation(
    value,
    workspaceId,
    analysisId,
    new Set(episodeIds)
  );
  if (
    value.status === NOT_RECORDED_STATUS &&
    options.allowNotRecorded !== true
  ) {
    throw new TypeError(
      "New analyst dispatches cannot use historical unaggregated synthesis data."
    );
  }
}
