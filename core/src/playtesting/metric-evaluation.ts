/** Validate game-owned evaluator sufficient statistics against a frozen rubric. */
import type { GameMetricEvaluation } from "./protocol-types.ts";
import type {
  PlaytestCoverageRequirement,
  PlaytestMetricDefinition,
  PlaytestMetricRegistry
} from "./registry.ts";
import {
  type PlaytestNumericResult,
  type PlaytestProvenance,
  PLAYTESTS_MISSING_REASONS
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const MAX_METRIC_EVALUATIONS = 1000;
const MAX_METRIC_NOTES_CHARS = 2048;
const RUN_MISSING_REASONS = new Set([
  "unobserved",
  "infrastructure-failed",
  "budget-truncated",
  "cancelled",
  "revoked",
  "unsupported-evaluator",
  "unsupported-modality"
]);

export interface NormalizeGameMetricEvaluationsInput {
  readonly registry: PlaytestMetricRegistry;
  readonly evaluations: readonly GameMetricEvaluation[];
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly rubricHash: string;
  readonly measurementVersion: string;
  readonly generatedAt: string;
  readonly scenarioId: string;
  readonly scenarioFamily: string;
  readonly cohort: string;
  readonly policy: string;
  readonly modality: "headless" | "browser" | "native-visual";
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(field + " must be a non-negative integer.");
  }
}

function provenanceFor(
  input: NormalizeGameMetricEvaluationsInput,
  evaluatorHash: string
): PlaytestProvenance {
  return {
    workspaceId: input.workspaceId,
    buildSha: input.buildSha,
    evaluatorHash,
    rubricHash: input.rubricHash,
    measurementVersion: input.measurementVersion,
    generatedAt: input.generatedAt
  };
}

function unavailableResult(
  metric: PlaytestMetricDefinition,
  input: NormalizeGameMetricEvaluationsInput,
  phaseId: string | null,
  reason: "unsupported-modality"
): PlaytestNumericResult {
  return {
    metricId: metric.metricId,
    metricVersion: metric.version,
    phaseId,
    numerator: 0,
    denominator: 0,
    opportunityCount: 0,
    coverage: 0,
    unit: metric.unit,
    estimate: null,
    missing: 0,
    missingReasons: [reason],
    independentUnits: 0,
    provenance: provenanceFor(input, metric.evaluatorHash),
    notes: "The evaluator modality was not observed in this run."
  };
}

function validateEvaluation(
  evaluation: GameMetricEvaluation,
  metric: PlaytestMetricDefinition,
  input: NormalizeGameMetricEvaluationsInput,
  phaseId: string | null
): PlaytestNumericResult {
  if (
    evaluation.metricVersion !== metric.version ||
    evaluation.phaseId !== phaseId ||
    evaluation.evaluatorRef !== metric.evaluatorRef ||
    evaluation.evaluatorHash.toLowerCase() !==
      metric.evaluatorHash.toLowerCase() ||
    evaluation.unit !== metric.unit
  ) {
    throw new TypeError(
      `Game evaluator output for "${metric.metricId}" does not match its frozen reference, version, code hash, or unit.`
    );
  }
  for (const [name, value] of [
    ["opportunityCount", evaluation.opportunityCount],
    ["denominator", evaluation.denominator],
    ["missing", evaluation.missing],
    ["independentUnits", evaluation.independentUnits]
  ] as const) {
    assertNonNegativeInteger(value, `Game metric ${metric.metricId}.${name}`);
  }
  if (
    !Number.isFinite(evaluation.numerator) ||
    (metric.unit === "proportion" &&
      (evaluation.numerator < 0 ||
        evaluation.numerator > evaluation.denominator)) ||
    evaluation.denominator > evaluation.opportunityCount ||
    evaluation.missing > evaluation.opportunityCount ||
    evaluation.denominator + evaluation.missing > evaluation.opportunityCount ||
    evaluation.independentUnits > evaluation.opportunityCount ||
    (metric.analysisUnit === "episode" &&
      evaluation.independentUnits !==
        (evaluation.opportunityCount === 0 ? 0 : 1))
  ) {
    throw new TypeError(
      `Game evaluator output for "${metric.metricId}" has inconsistent sufficient statistics.`
    );
  }
  const permittedReasons = new Set([
    ...metric.notObservable,
    ...RUN_MISSING_REASONS
  ]);
  if (
    evaluation.missingReasons.some(
      (reason) =>
        !(PLAYTESTS_MISSING_REASONS as readonly string[]).includes(reason) ||
        !permittedReasons.has(reason)
    )
  ) {
    throw new TypeError(
      `Game evaluator output for "${metric.metricId}" contains an undeclared missingness reason.`
    );
  }
  const missingReasons =
    evaluation.denominator === 0 && evaluation.opportunityCount === 0
      ? [...new Set([...evaluation.missingReasons, "unobserved" as const])]
      : [...evaluation.missingReasons];
  return {
    metricId: metric.metricId,
    metricVersion: metric.version,
    phaseId,
    numerator: evaluation.numerator,
    denominator: evaluation.denominator,
    opportunityCount: evaluation.opportunityCount,
    coverage:
      evaluation.opportunityCount === 0
        ? 0
        : evaluation.denominator / evaluation.opportunityCount,
    unit: metric.unit,
    estimate:
      evaluation.denominator === 0
        ? null
        : evaluation.numerator / evaluation.denominator,
    missing: evaluation.missing,
    missingReasons,
    independentUnits: evaluation.independentUnits,
    provenance: provenanceFor(input, metric.evaluatorHash),
    notes:
      evaluation.denominator === 0
        ? `No eligible opportunities were observed for ${metric.metricId}.`
        : `${String(evaluation.numerator)}/${String(evaluation.denominator)} eligible opportunities; coverage ${String(evaluation.denominator)}/${String(evaluation.opportunityCount)}.`
  };
}

function assertMetricEvaluationEnvelope(
  input: NormalizeGameMetricEvaluationsInput
): void {
  if (
    !Array.isArray(input.evaluations) ||
    input.evaluations.length > MAX_METRIC_EVALUATIONS ||
    !BUILD_SHA_PATTERN.test(input.buildSha) ||
    !SHA256_PATTERN.test(input.rubricHash) ||
    !Number.isFinite(Date.parse(input.generatedAt))
  ) {
    throw new TypeError(
      "Game metric evaluation envelope is invalid or oversized."
    );
  }
}

function phaseEvaluationKey(metricId: string, phaseId: string | null): string {
  return JSON.stringify([metricId, phaseId]);
}

function coverageCellsForMetric(
  metric: PlaytestMetricDefinition,
  input: NormalizeGameMetricEvaluationsInput
) {
  return input.registry.coverageRequirements.filter(
    (cell) =>
      cell.coverageMetricId === metric.metricId &&
      cell.scenarioFamily === input.scenarioFamily &&
      cell.cohort === input.cohort &&
      cell.policy === input.policy
  );
}

function indexMetricEvaluations(
  registry: PlaytestMetricRegistry,
  evaluations: readonly GameMetricEvaluation[]
): Map<string, GameMetricEvaluation> {
  const definitions = new Set(
    registry.metricDefinitions.map((metric) => metric.metricId)
  );
  const submitted = new Map<string, GameMetricEvaluation>();
  for (const evaluation of evaluations) {
    if (!definitions.has(evaluation.metricId)) {
      throw new TypeError("The adapter returned an unknown metric evaluation.");
    }
    const key = phaseEvaluationKey(evaluation.metricId, evaluation.phaseId);
    if (submitted.has(key)) {
      throw new TypeError(
        "The adapter returned a duplicate metric/phase evaluation."
      );
    }
    submitted.set(key, evaluation);
  }
  return submitted;
}

function assertSupportedMetricWindow(metric: PlaytestMetricDefinition): void {
  if (
    metric.aggregationWindow !== "phase" &&
    metric.aggregationWindow !== "whole-episode"
  ) {
    throw new TypeError(
      `Eligible metric "${metric.metricId}" must produce episode- or phase-window sufficient statistics.`
    );
  }
}

function assertNoOutputForUnsupportedCells(
  metric: PlaytestMetricDefinition,
  cells: readonly PlaytestCoverageRequirement[],
  submitted: Map<string, GameMetricEvaluation>
): void {
  for (const cell of cells) {
    if (
      cell.unsupportedReason !== null &&
      submitted.has(phaseEvaluationKey(metric.metricId, cell.phaseId))
    ) {
      throw new TypeError(
        `The adapter returned output for unsupported coverage cell "${metric.metricId}" phase "${cell.phaseId}".`
      );
    }
  }
}

function phasesForMetric(
  metric: PlaytestMetricDefinition,
  cells: readonly PlaytestCoverageRequirement[]
): readonly (string | null)[] {
  const supported = cells.filter((cell) => cell.unsupportedReason === null);
  if (metric.aggregationWindow === "phase") {
    return supported.map((cell) => cell.phaseId);
  }
  return supported.length === 0 && cells.length > 0 ? [] : [null];
}

function normalizeEvaluationForPhase(
  metric: PlaytestMetricDefinition,
  input: NormalizeGameMetricEvaluationsInput,
  phaseId: string | null,
  submitted: Map<string, GameMetricEvaluation>
): PlaytestNumericResult {
  const key = phaseEvaluationKey(metric.metricId, phaseId);
  const evaluation = submitted.get(key);
  if (evaluation === undefined) {
    throw new TypeError(
      "The approved adapter omitted required evaluator output for " +
        metric.metricId +
        " phase " +
        String(phaseId) +
        "."
    );
  }
  submitted.delete(key);
  return validateEvaluation(evaluation, metric, input, phaseId);
}

function normalizeMetricDefinition(
  metric: PlaytestMetricDefinition,
  input: NormalizeGameMetricEvaluationsInput,
  submitted: Map<string, GameMetricEvaluation>
): readonly PlaytestNumericResult[] {
  if (
    metric.modality === "human-post-play" ||
    !metric.scenarioEligibility.includes(input.scenarioId)
  ) {
    return [];
  }
  const cells = coverageCellsForMetric(metric, input);
  if (metric.aggregationWindow === "phase" && cells.length === 0) {
    throw new TypeError(
      `The frozen coverage plan has no cell for eligible metric "${metric.metricId}" in this scenario, cohort, policy, and phase.`
    );
  }
  assertSupportedMetricWindow(metric);
  assertNoOutputForUnsupportedCells(metric, cells, submitted);
  const phases = phasesForMetric(metric, cells);
  if (metric.modality !== input.modality) {
    return phases.map((phaseId) =>
      unavailableResult(metric, input, phaseId, "unsupported-modality")
    );
  }
  return phases.map((phaseId) =>
    normalizeEvaluationForPhase(metric, input, phaseId, submitted)
  );
}

/**
 * Normalize adapter-emitted game facts to the Core-owned indexed result shape.
 * The game adapter executes target-owned code; Runtime never loads or executes
 * arbitrary evaluator code. Results are accepted only for the exact frozen
 * metric id/reference/version/hash/unit and the assigned phase/profile cells.
 */
export function normalizeGameMetricEvaluations(
  input: NormalizeGameMetricEvaluationsInput
): readonly PlaytestNumericResult[] {
  assertMetricEvaluationEnvelope(input);
  const submitted = indexMetricEvaluations(input.registry, input.evaluations);
  const results = input.registry.metricDefinitions.flatMap((metric) =>
    normalizeMetricDefinition(metric, input, submitted)
  );
  if (submitted.size > 0) {
    throw new TypeError(
      "The adapter returned metric/phase evaluations outside the frozen coverage plan."
    );
  }
  return results;
}

const NUMERIC_RESULT_KEYS = new Set([
  "metricId",
  "metricVersion",
  "phaseId",
  "numerator",
  "denominator",
  "opportunityCount",
  "coverage",
  "unit",
  "estimate",
  "missing",
  "missingReasons",
  "independentUnits",
  "provenance",
  "notes"
]);
const PROVENANCE_KEYS = new Set([
  "workspaceId",
  "buildSha",
  "evaluatorHash",
  "rubricHash",
  "measurementVersion",
  "instrumentVersion",
  "generatedAt"
]);
function assertNumericResultIdentity(result: Record<string, unknown>): void {
  if (
    Object.keys(result).length !== NUMERIC_RESULT_KEYS.size ||
    Object.keys(result).some((key) => !NUMERIC_RESULT_KEYS.has(key))
  ) {
    throw new TypeError(
      "Playtest numeric result contains unsupported or missing fields."
    );
  }
  if (
    typeof result.metricId !== "string" ||
    result.metricId.trim().length === 0
  ) {
    throw new TypeError("Playtest numeric result metricId must be non-empty.");
  }
  const validNumberVersion =
    typeof result.metricVersion === "number" &&
    Number.isSafeInteger(result.metricVersion) &&
    result.metricVersion >= 1;
  const validStringVersion =
    typeof result.metricVersion === "string" &&
    result.metricVersion.trim().length > 0;
  if (!validNumberVersion && !validStringVersion) {
    throw new TypeError("Playtest numeric result metricVersion is invalid.");
  }
  if (
    result.phaseId !== null &&
    (typeof result.phaseId !== "string" || result.phaseId.trim().length === 0)
  ) {
    throw new TypeError(
      "Playtest numeric result phaseId must be null or non-empty."
    );
  }
}

function assertNumericResultMeasures(result: Record<string, unknown>): void {
  if (
    typeof result.numerator !== "number" ||
    !Number.isFinite(result.numerator) ||
    typeof result.denominator !== "number" ||
    !Number.isFinite(result.denominator) ||
    result.denominator < 0
  ) {
    throw new TypeError(
      "Playtest numeric result numerator/denominator are invalid."
    );
  }
  if (
    result.opportunityCount !== null &&
    (!Number.isSafeInteger(result.opportunityCount) ||
      (result.opportunityCount as number) < 0)
  ) {
    throw new TypeError("Playtest numeric result opportunityCount is invalid.");
  }
  if (
    typeof result.coverage !== "number" ||
    !Number.isFinite(result.coverage) ||
    result.coverage < 0 ||
    result.coverage > 1 ||
    typeof result.unit !== "string" ||
    result.unit.trim().length === 0 ||
    (result.estimate !== null &&
      (typeof result.estimate !== "number" ||
        !Number.isFinite(result.estimate)))
  ) {
    throw new TypeError(
      "Playtest numeric result estimate, coverage, or unit is invalid."
    );
  }
  for (const key of ["missing", "independentUnits"] as const) {
    if (!Number.isSafeInteger(result[key]) || (result[key] as number) < 0) {
      throw new TypeError("Playtest numeric result " + key + " is invalid.");
    }
  }
  if (
    result.denominator === 0
      ? result.estimate !== null
      : result.estimate === null ||
        Math.abs(
          (result.estimate as number) -
            (result.numerator as number) / (result.denominator as number)
        ) > 1e-12
  ) {
    throw new TypeError(
      "Playtest numeric result estimate disagrees with its counts."
    );
  }
  if (
    result.unit === "proportion" &&
    ((result.numerator as number) < 0 ||
      (result.numerator as number) > (result.denominator as number))
  ) {
    throw new TypeError(
      "Proportion metric numerator must be within its denominator."
    );
  }
}

function assertNumericResultProvenance(result: Record<string, unknown>): void {
  if (
    result.provenance === null ||
    typeof result.provenance !== "object" ||
    Array.isArray(result.provenance)
  ) {
    throw new TypeError(
      "Playtest numeric result provenance must be an object."
    );
  }
  const provenance = result.provenance as Record<string, unknown>;
  if (
    Object.keys(provenance).some((key) => !PROVENANCE_KEYS.has(key)) ||
    typeof provenance.workspaceId !== "string" ||
    provenance.workspaceId.trim().length === 0 ||
    typeof provenance.measurementVersion !== "string" ||
    provenance.measurementVersion.trim().length === 0 ||
    typeof provenance.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(provenance.generatedAt))
  ) {
    throw new TypeError("Playtest numeric result provenance is malformed.");
  }
  if (result.opportunityCount === null) return;
  if (
    typeof provenance.buildSha !== "string" ||
    !BUILD_SHA_PATTERN.test(provenance.buildSha) ||
    typeof provenance.evaluatorHash !== "string" ||
    !SHA256_PATTERN.test(provenance.evaluatorHash) ||
    typeof provenance.rubricHash !== "string" ||
    !SHA256_PATTERN.test(provenance.rubricHash)
  ) {
    throw new TypeError(
      "Current playtest metric provenance requires build, evaluator, and rubric hashes."
    );
  }
}

function assertNumericResultMissingness(result: Record<string, unknown>): void {
  if (
    !Array.isArray(result.missingReasons) ||
    result.missingReasons.some(
      (reason) =>
        typeof reason !== "string" ||
        !(PLAYTESTS_MISSING_REASONS as readonly string[]).includes(reason)
    )
  ) {
    throw new TypeError("Playtest numeric result missingReasons are invalid.");
  }
  if (
    typeof result.notes !== "string" ||
    result.notes.length > MAX_METRIC_NOTES_CHARS
  ) {
    throw new TypeError("Playtest numeric result notes are unbounded.");
  }
}

function assertNumericResultExposure(result: Record<string, unknown>): void {
  if (result.opportunityCount === null) return;
  const opportunities = result.opportunityCount as number;
  const denominator = result.denominator as number;
  const missing = result.missing as number;
  const independent = result.independentUnits as number;
  const expectedCoverage =
    opportunities === 0 ? 0 : denominator / opportunities;
  if (
    denominator > opportunities ||
    missing > opportunities ||
    denominator + missing > opportunities ||
    independent > opportunities ||
    Math.abs((result.coverage as number) - expectedCoverage) > 1e-12
  ) {
    throw new TypeError(
      "Playtest numeric result exposure statistics are inconsistent."
    );
  }
}

/** Validate the persisted per-episode measurement shape without recomputing it. */
export function assertPlaytestNumericResult(
  value: unknown
): asserts value is PlaytestNumericResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Playtest numeric result must be an object.");
  }
  const result = value as Record<string, unknown>;
  assertNumericResultIdentity(result);
  assertNumericResultMeasures(result);
  assertNumericResultProvenance(result);
  assertNumericResultMissingness(result);
  assertNumericResultExposure(result);
}

/** Validate an episode's bounded, unique metric/phase row set. */
export function assertPlaytestNumericResults(
  value: unknown
): asserts value is readonly PlaytestNumericResult[] {
  if (!Array.isArray(value) || value.length > MAX_METRIC_EVALUATIONS) {
    throw new TypeError("Playtest numeric results must be a bounded array.");
  }
  const phases = new Set<string>();
  for (const result of value) {
    assertPlaytestNumericResult(result);
    const key = phaseEvaluationKey(result.metricId, result.phaseId);
    if (phases.has(key)) {
      throw new TypeError(
        "Playtest numeric results must have unique metric/phase pairs."
      );
    }
    phases.add(key);
  }
}
