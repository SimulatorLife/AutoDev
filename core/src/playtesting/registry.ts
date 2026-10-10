/**
 * Metric-registry schema, default expansion and required-field rejection.
 *
 * The Core layer never silently rewrites a game-owned metric definition: any
 * omitted field is filled by shallow replacement from the registry-level
 * `defaults` block, and any field that remains absent after expansion is a
 * hard error. The expansion is intentionally *shallow* — a default for a
 * scalar field replaces the scalar; a default for an object field is dropped
 * if the override is present (the game must opt in wholesale). Deep merge
 * would silently rewrite the game-owned portion.
 *
 * The defaults themselves are typed so that the compiler rejects an unknown
 * default key, and the runtime validator below rejects any unknown override
 * key. The result is one place where the registry vocabulary is written.
 */

import {
  type PlaytestDimensionRubric,
  type PlaytestMissingReason,
  type PlaytestPolarity,
  type PlaytestProvenance,
  PLAYTESTS_POLARITIES,
  PLAYTESTS_REGISTRY_SCHEMA,
  type PlaytestScoreBand} from "./types.ts";

/** Fields every metric definition must surface after default expansion. */
export const PLAYTESTS_METRIC_REQUIRED_FIELDS = [
  "metricId",
  "version",
  "mechanicKey",
  "audience",
  "scenarioEligibility",
  "exposurePredicate",
  "eventFields",
  "evaluatorRef",
  "numerator",
  "denominator",
  "unit",
  "analysisUnit",
  "aggregationWindow",
  "aggregation",
  "polarity",
  "targetBand",
  "notObservable",
  "modality",
  "missingPolicy",
  "minExposure",
  "minIndependentUnits",
  "precisionPlanRef",
  "severityRule",
  "priorityClass",
  "provenance",
  "humanConstruct",
  "meaningfulMargin",
  "guardrailMargin"
] as const;

export type PlaytestMetricRequiredField =
  (typeof PLAYTESTS_METRIC_REQUIRED_FIELDS)[number];

/** A registry-level defaults block. */
export interface PlaytestRegistryDefaults {
  readonly audience: string;
  readonly scenarioEligibility: readonly string[];
  readonly analysisUnit:
    "episode" | "decision" | "cohort" | "learner-identity" | "participant";
  readonly aggregationWindow:
    "whole-episode" | "phase" | "session" | "response";
  readonly aggregation:
    | "ratio-of-sums-within-scenario"
    | "native-item-mean-and-category-distribution"
    | "descriptive";
  readonly modality:
    "headless" | "browser" | "native-visual" | "human-post-play";
  readonly minExposure: number;
  readonly minIndependentUnits: number;
  readonly precisionPlanRef: string;
  readonly missingPolicy:
    "null-with-reason-and-missing-count" | "impute-zero-with-flag" | "exclude";
  readonly provenance: readonly string[];
  readonly humanConstruct: string | null;
  readonly meaningfulMargin: number | null;
  readonly guardrailMargin: number | null;
  readonly severityRule: string;
  readonly priorityClass:
    "investigate" | "blocker" | "major" | "minor" | "informational";
}

/** A metric definition before default expansion. */
export interface PlaytestMetricDefinitionInput {
  readonly metricId: string;
  readonly version: number;
  readonly mechanicKey: string;
  readonly audience?: string;
  readonly scenarioEligibility?: readonly string[];
  readonly exposurePredicate: string;
  readonly eventFields: readonly string[];
  readonly evaluatorRef: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly unit: string;
  readonly analysisUnit?: PlaytestRegistryDefaults["analysisUnit"];
  readonly aggregationWindow?: PlaytestRegistryDefaults["aggregationWindow"];
  readonly aggregation?: PlaytestRegistryDefaults["aggregation"];
  readonly polarity: PlaytestPolarity;
  readonly targetBand: readonly [number | null, number | null];
  readonly notObservable: readonly PlaytestMissingReason[];
  readonly modality?: PlaytestRegistryDefaults["modality"];
  readonly missingPolicy?: PlaytestRegistryDefaults["missingPolicy"];
  readonly minExposure?: number;
  readonly minIndependentUnits?: number;
  readonly precisionPlanRef?: string;
  readonly severityRule?: string;
  readonly priorityClass?: PlaytestRegistryDefaults["priorityClass"];
  readonly provenance?: readonly string[];
  readonly humanConstruct?: string | null;
  readonly meaningfulMargin?: number | null;
  readonly guardrailMargin?: number | null;
}

/** A metric definition after default expansion; frozen, normalized. */
export interface PlaytestMetricDefinition {
  readonly metricId: string;
  readonly version: number;
  readonly mechanicKey: string;
  readonly audience: string;
  readonly scenarioEligibility: readonly string[];
  readonly exposurePredicate: string;
  readonly eventFields: readonly string[];
  readonly evaluatorRef: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly unit: string;
  readonly analysisUnit: PlaytestRegistryDefaults["analysisUnit"];
  readonly aggregationWindow: PlaytestRegistryDefaults["aggregationWindow"];
  readonly aggregation: PlaytestRegistryDefaults["aggregation"];
  readonly polarity: PlaytestPolarity;
  readonly targetBand: readonly [number | null, number | null];
  readonly notObservable: readonly PlaytestMissingReason[];
  readonly modality: PlaytestRegistryDefaults["modality"];
  readonly missingPolicy: PlaytestRegistryDefaults["missingPolicy"];
  readonly minExposure: number;
  readonly minIndependentUnits: number;
  readonly precisionPlanRef: string;
  readonly severityRule: string;
  readonly priorityClass: PlaytestRegistryDefaults["priorityClass"];
  readonly provenance: readonly string[];
  readonly humanConstruct: string | null;
  readonly meaningfulMargin: number | null;
  readonly guardrailMargin: number | null;
}

/** A metric registry as supplied by the game/adapter. */
export interface PlaytestMetricRegistryInput {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly audience: string;
  readonly registryVersion: string;
  readonly eventSchemaHash: string;
  readonly defaults: PlaytestRegistryDefaults;
  readonly metricDefinitions: readonly PlaytestMetricDefinitionInput[];
  readonly dimensionRubrics?: readonly PlaytestDimensionRubric[];
}

/** A metric registry after validation and default expansion. */
export interface PlaytestMetricRegistry {
  readonly schema: typeof PLAYTESTS_REGISTRY_SCHEMA;
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly audience: string;
  readonly registryVersion: string;
  readonly eventSchemaHash: string;
  readonly defaults: PlaytestRegistryDefaults;
  readonly metricDefinitions: readonly PlaytestMetricDefinition[];
  readonly dimensionRubrics: readonly PlaytestDimensionRubric[];
}

const DIMENSION_RUBRIC_REQUIRED_FIELDS = [
  "dimensionId",
  "version",
  "unit",
  "indicator",
  "modality",
  "minExposure",
  "minIndependentUnits",
  "scoreBands",
  "counterexample",
  "evidenceChecklist",
  "insufficient",
  "humanOutcomeMapping"
] as const;

const DIMENSION_RUBRIC_KNOWN_FIELDS = new Set<string>(
  DIMENSION_RUBRIC_REQUIRED_FIELDS as readonly string[]
);

const DIMENSION_UNITS: ReadonlySet<string> = new Set([
  "decision",
  "episode",
  "cohort"
]);

const DIMENSION_MODALITIES: ReadonlySet<string> = new Set([
  "headless",
  "browser",
  "native-visual",
  "human-post-play"
]);

const ANALYSIS_UNITS: ReadonlySet<string> = new Set([
  "episode",
  "decision",
  "cohort",
  "learner-identity",
  "participant"
]);

const AGGREGATION_WINDOWS: ReadonlySet<string> = new Set([
  "whole-episode",
  "phase",
  "session",
  "response"
]);

const AGGREGATIONS: ReadonlySet<string> = new Set([
  "ratio-of-sums-within-scenario",
  "native-item-mean-and-category-distribution",
  "descriptive"
]);

const MODALITIES: ReadonlySet<string> = new Set([
  "headless",
  "browser",
  "native-visual",
  "human-post-play"
]);

const MISSING_POLICIES: ReadonlySet<string> = new Set([
  "null-with-reason-and-missing-count",
  "impute-zero-with-flag",
  "exclude"
]);

const PRIORITY_CLASSES: ReadonlySet<string> = new Set([
  "investigate",
  "blocker",
  "major",
  "minor",
  "informational"
]);

const POLARITIES: ReadonlySet<string> = new Set(PLAYTESTS_POLARITIES);

function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `Registry field "${field}" must be a non-empty string.`
    );
  }
}

function assertStringArray(
  value: unknown,
  field: string
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError(
      `Registry field "${field}" must be an array of strings.`
    );
  }
}

function assertNonNegativeInteger(
  value: unknown,
  field: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Registry field "${field}" must be a non-negative integer.`
    );
  }
}

function assertFiniteNumber(
  value: unknown,
  field: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Registry field "${field}" must be a finite number.`);
  }
}

function assertKnownEnum<T extends string>(
  value: unknown,
  field: string,
  set: ReadonlySet<T>
): asserts value is T {
  if (typeof value !== "string" || !set.has(value as T)) {
    throw new TypeError(
      `Registry field "${field}" must be one of ${[...set].join(", ")}; received ${String(value)}.`
    );
  }
}

function assertDefaultsBlock(
  value: unknown,
  field: string
): asserts value is PlaytestRegistryDefaults {
  if (!isPlainObject(value)) {
    throw new TypeError(`Registry field "${field}" must be a plain object.`);
  }
  assertNonEmptyString(value.audience, `${field}.audience`);
  assertStringArray(value.scenarioEligibility, `${field}.scenarioEligibility`);
  assertKnownEnum(value.analysisUnit, `${field}.analysisUnit`, ANALYSIS_UNITS);
  assertKnownEnum(
    value.aggregationWindow,
    `${field}.aggregationWindow`,
    AGGREGATION_WINDOWS
  );
  assertKnownEnum(value.aggregation, `${field}.aggregation`, AGGREGATIONS);
  assertKnownEnum(value.modality, `${field}.modality`, MODALITIES);
  assertNonNegativeInteger(value.minExposure, `${field}.minExposure`);
  assertNonNegativeInteger(
    value.minIndependentUnits,
    `${field}.minIndependentUnits`
  );
  assertNonEmptyString(value.precisionPlanRef, `${field}.precisionPlanRef`);
  assertKnownEnum(
    value.missingPolicy,
    `${field}.missingPolicy`,
    MISSING_POLICIES
  );
  if (
    !Array.isArray(value.provenance) ||
    value.provenance.some((entry: unknown) => typeof entry !== "string")
  ) {
    throw new TypeError(
      `Registry field "${field}.provenance" must be an array of strings.`
    );
  }
  if (
    value.humanConstruct !== null &&
    typeof value.humanConstruct !== "string"
  ) {
    throw new TypeError(
      `Registry field "${field}.humanConstruct" must be a string or null.`
    );
  }
  if (
    value.meaningfulMargin !== null &&
    !Number.isFinite(value.meaningfulMargin as number)
  ) {
    throw new TypeError(
      `Registry field "${field}.meaningfulMargin" must be a finite number or null.`
    );
  }
  if (
    value.guardrailMargin !== null &&
    !Number.isFinite(value.guardrailMargin as number)
  ) {
    throw new TypeError(
      `Registry field "${field}.guardrailMargin" must be a finite number or null.`
    );
  }
  assertNonEmptyString(value.severityRule, `${field}.severityRule`);
  assertKnownEnum(
    value.priorityClass,
    `${field}.priorityClass`,
    PRIORITY_CLASSES
  );
}

function assertScoreBand(
  band: unknown,
  field: string
): asserts band is PlaytestScoreBand {
  if (!isPlainObject(band)) {
    throw new TypeError(`Score band ${field} must be a plain object.`);
  }
  const score = band.score;
  if (score !== 0 && score !== 1 && score !== 2 && score !== 3 && score !== 4) {
    throw new TypeError(
      `Score band ${field}.score must be an integer in [0,4].`
    );
  }
  for (const [key, value] of Object.entries(band)) {
    if (key === "score") continue;
    if (
      key !== "equals" &&
      key !== "greaterThan" &&
      key !== "atMost" &&
      key !== "atLeast" &&
      key !== "lessThan"
    ) {
      throw new TypeError(
        `Score band ${field}.${key} is not an allowed boundary field.`
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `Score band ${field}.${key} must be a finite number.`
      );
    }
  }
}

function assertDimensionRubric(
  value: unknown,
  field: string
): asserts value is PlaytestDimensionRubric {
  if (!isPlainObject(value)) {
    throw new TypeError(`Dimension rubric ${field} must be a plain object.`);
  }
  for (const required of DIMENSION_RUBRIC_REQUIRED_FIELDS) {
    if (!(required in value)) {
      throw new TypeError(
        `Dimension rubric ${field} must include field "${required}".`
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!DIMENSION_RUBRIC_KNOWN_FIELDS.has(key)) {
      throw new TypeError(
        `Dimension rubric ${field} carries unknown field "${key}".`
      );
    }
  }
  assertNonEmptyString(value.dimensionId, `${field}.dimensionId`);
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    throw new TypeError(`${field}.version must be an integer.`);
  }
  assertKnownEnum(value.unit, `${field}.unit`, DIMENSION_UNITS);
  assertNonEmptyString(value.indicator, `${field}.indicator`);
  assertKnownEnum(value.modality, `${field}.modality`, DIMENSION_MODALITIES);
  assertNonNegativeInteger(value.minExposure, `${field}.minExposure`);
  assertNonNegativeInteger(
    value.minIndependentUnits,
    `${field}.minIndependentUnits`
  );
  if (!Array.isArray(value.scoreBands)) {
    throw new TypeError(`${field}.scoreBands must be an array.`);
  }
  for (const [index, band] of value.scoreBands.entries()) {
    assertScoreBand(band, `${field}.scoreBands[${String(index)}]`);
  }
  assertNonEmptyString(value.counterexample, `${field}.counterexample`);
  assertStringArray(value.evidenceChecklist, `${field}.evidenceChecklist`);
  if (value.insufficient !== "null") {
    throw new TypeError(
      `${field}.insufficient must be the literal string "null".`
    );
  }
  if (
    value.humanOutcomeMapping !== null &&
    typeof value.humanOutcomeMapping !== "string"
  ) {
    throw new TypeError(
      `${field}.humanOutcomeMapping must be a string or null.`
    );
  }
  // Score bands must cover 0..4 exactly once each.
  const seenScores = new Set<number>();
  for (const band of value.scoreBands) {
    if (seenScores.has(band.score)) {
      throw new TypeError(
        `${field}.scoreBands must declare each score 0..4 exactly once; duplicate ${String(band.score)}.`
      );
    }
    seenScores.add(band.score);
  }
  for (const required of [0, 1, 2, 3, 4]) {
    if (!seenScores.has(required)) {
      throw new TypeError(
        `${field}.scoreBands must declare a band for score ${String(required)}.`
      );
    }
  }
}

/**
 * Shallow-merge a single metric input over the registry defaults. The merge
 * is *shallow by design*: a default for a scalar field replaces the scalar,
 * a default for an array field replaces the array, and an object default is
 * dropped if the input is present. Deep merge would silently rewrite the
 * game-owned portion of the definition.
 */
function expandMetricDefinition(
  input: PlaytestMetricDefinitionInput,
  defaults: PlaytestRegistryDefaults
): PlaytestMetricDefinition {
  const expanded: PlaytestMetricDefinition = {
    metricId: input.metricId,
    version: input.version,
    mechanicKey: input.mechanicKey,
    audience: input.audience ?? defaults.audience,
    scenarioEligibility:
      input.scenarioEligibility ?? defaults.scenarioEligibility,
    exposurePredicate: input.exposurePredicate,
    eventFields: input.eventFields,
    evaluatorRef: input.evaluatorRef,
    numerator: input.numerator,
    denominator: input.denominator,
    unit: input.unit,
    analysisUnit: input.analysisUnit ?? defaults.analysisUnit,
    aggregationWindow: input.aggregationWindow ?? defaults.aggregationWindow,
    aggregation: input.aggregation ?? defaults.aggregation,
    polarity: input.polarity,
    targetBand: input.targetBand,
    notObservable: input.notObservable,
    modality: input.modality ?? defaults.modality,
    missingPolicy: input.missingPolicy ?? defaults.missingPolicy,
    minExposure: input.minExposure ?? defaults.minExposure,
    minIndependentUnits:
      input.minIndependentUnits ?? defaults.minIndependentUnits,
    precisionPlanRef: input.precisionPlanRef ?? defaults.precisionPlanRef,
    severityRule: input.severityRule ?? defaults.severityRule,
    priorityClass: input.priorityClass ?? defaults.priorityClass,
    provenance: input.provenance ?? defaults.provenance,
    humanConstruct: input.humanConstruct ?? defaults.humanConstruct,
    meaningfulMargin: input.meaningfulMargin ?? defaults.meaningfulMargin,
    guardrailMargin: input.guardrailMargin ?? defaults.guardrailMargin
  };
  // These three fields are legitimately nullable per the measurement
  // contract (null means "no margin"/"no human construct"); every other
  // required field must resolve to a real, non-empty value.
  const nullableFields = new Set<string>([
    "humanConstruct",
    "meaningfulMargin",
    "guardrailMargin"
  ]);
  for (const required of PLAYTESTS_METRIC_REQUIRED_FIELDS) {
    const value = expanded[required];
    if (value === undefined) {
      throw new TypeError(
        `Metric "${expanded.metricId}" field "${required}" is still missing after default expansion.`
      );
    }
    if (value === null && !nullableFields.has(required)) {
      throw new TypeError(
        `Metric "${expanded.metricId}" field "${required}" is still missing after default expansion.`
      );
    }
    if (typeof value === "string" && value.length === 0) {
      throw new TypeError(
        `Metric "${expanded.metricId}" field "${required}" expanded to an empty string.`
      );
    }
  }
  return expanded;
}

function assertMetricIdentity(
  value: Readonly<Record<string, unknown>>,
  field: string
): void {
  assertNonEmptyString(value.metricId, `${field}.metricId`);
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    throw new TypeError(`${field}.version must be an integer.`);
  }
  assertNonEmptyString(value.mechanicKey, `${field}.mechanicKey`);
  if (value.audience !== undefined && typeof value.audience !== "string") {
    throw new TypeError(`${field}.audience must be a string when present.`);
  }
  if (value.scenarioEligibility !== undefined) {
    assertStringArray(
      value.scenarioEligibility,
      `${field}.scenarioEligibility`
    );
  }
}

function assertMetricCalculation(
  value: Readonly<Record<string, unknown>>,
  field: string
): void {
  assertNonEmptyString(value.exposurePredicate, `${field}.exposurePredicate`);
  assertStringArray(value.eventFields, `${field}.eventFields`);
  assertNonEmptyString(value.evaluatorRef, `${field}.evaluatorRef`);
  assertNonEmptyString(value.numerator, `${field}.numerator`);
  assertNonEmptyString(value.denominator, `${field}.denominator`);
  assertNonEmptyString(value.unit, `${field}.unit`);
  assertOptionalKnownEnum(
    value.analysisUnit,
    `${field}.analysisUnit`,
    ANALYSIS_UNITS
  );
  assertOptionalKnownEnum(
    value.aggregationWindow,
    `${field}.aggregationWindow`,
    AGGREGATION_WINDOWS
  );
  assertOptionalKnownEnum(
    value.aggregation,
    `${field}.aggregation`,
    AGGREGATIONS
  );
  assertKnownEnum(value.polarity, `${field}.polarity`, POLARITIES);
}

function assertMetricEvidencePolicy(
  value: Readonly<Record<string, unknown>>,
  field: string
): void {
  if (!Array.isArray(value.targetBand) || value.targetBand.length !== 2) {
    throw new TypeError(`${field}.targetBand must be a 2-element array.`);
  }
  for (const [index, bound] of (value.targetBand as unknown[]).entries()) {
    if (bound === null) continue;
    assertFiniteNumber(bound, `${field}.targetBand[${String(index)}]`);
  }
  assertStringArray(value.notObservable, `${field}.notObservable`);
  assertOptionalKnownEnum(value.modality, `${field}.modality`, MODALITIES);
  assertOptionalKnownEnum(
    value.missingPolicy,
    `${field}.missingPolicy`,
    MISSING_POLICIES
  );
  if (value.minExposure !== undefined) {
    assertNonNegativeInteger(value.minExposure, `${field}.minExposure`);
  }
  if (value.minIndependentUnits !== undefined) {
    assertNonNegativeInteger(
      value.minIndependentUnits,
      `${field}.minIndependentUnits`
    );
  }
  if (value.precisionPlanRef !== undefined) {
    assertNonEmptyString(value.precisionPlanRef, `${field}.precisionPlanRef`);
  }
  if (value.severityRule !== undefined) {
    assertNonEmptyString(value.severityRule, `${field}.severityRule`);
  }
  assertOptionalKnownEnum(
    value.priorityClass,
    `${field}.priorityClass`,
    PRIORITY_CLASSES
  );
}

function assertMetricHumanAndMargins(
  value: Readonly<Record<string, unknown>>,
  field: string
): void {
  if (value.provenance !== undefined) {
    assertStringArray(value.provenance, `${field}.provenance`);
  }
  if (
    value.humanConstruct !== undefined &&
    value.humanConstruct !== null &&
    typeof value.humanConstruct !== "string"
  ) {
    throw new TypeError(
      `${field}.humanConstruct must be a string or null when present.`
    );
  }
  for (const marginField of ["meaningfulMargin", "guardrailMargin"] as const) {
    const margin = value[marginField];
    if (margin !== undefined && margin !== null) {
      assertFiniteNumber(margin, `${field}.${marginField}`);
      if (margin < 0) {
        throw new TypeError(`${field}.${marginField} must be non-negative.`);
      }
    }
  }
}

function assertOptionalKnownEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>
): void {
  if (value !== undefined) assertKnownEnum(value, field, allowed);
}

function assertMetricDefinition(
  value: unknown,
  field: string
): asserts value is PlaytestMetricDefinitionInput {
  if (!isPlainObject(value)) {
    throw new TypeError(`Metric definition ${field} must be a plain object.`);
  }
  assertMetricIdentity(value, field);
  assertMetricCalculation(value, field);
  assertMetricEvidencePolicy(value, field);
  assertMetricHumanAndMargins(value, field);
}

/** Validate a metric-registry input and return the expanded form. */
export function expandPlaytestRegistry(input: unknown): PlaytestMetricRegistry {
  if (!isPlainObject(input)) {
    throw new TypeError("Metric registry must be a plain object.");
  }
  if (input.schemaVersion !== 1) {
    throw new TypeError("Metric registry schemaVersion must be the integer 1.");
  }
  assertNonEmptyString(input.workspaceId, "workspaceId");
  assertNonEmptyString(input.audience, "audience");
  assertNonEmptyString(input.registryVersion, "registryVersion");
  assertNonEmptyString(input.eventSchemaHash, "eventSchemaHash");
  assertDefaultsBlock(input.defaults, "defaults");
  if (!Array.isArray(input.metricDefinitions)) {
    throw new TypeError(
      "Metric registry `metricDefinitions` must be an array."
    );
  }
  if (input.metricDefinitions.length === 0) {
    throw new TypeError(
      "Metric registry must declare at least one metric definition."
    );
  }
  const seenIds = new Set<string>();
  const expandedMetrics: PlaytestMetricDefinition[] = [];
  for (const [index, definition] of (
    input.metricDefinitions as unknown[]
  ).entries()) {
    assertMetricDefinition(definition, `metricDefinitions[${String(index)}]`);
    const typed = definition as PlaytestMetricDefinitionInput;
    if (seenIds.has(typed.metricId)) {
      throw new TypeError(
        `Metric registry declares duplicate metricId "${typed.metricId}".`
      );
    }
    seenIds.add(typed.metricId);
    expandedMetrics.push(
      expandMetricDefinition(typed, input.defaults as PlaytestRegistryDefaults)
    );
  }
  const dimensionRubrics: PlaytestDimensionRubric[] = [];
  if (input.dimensionRubrics !== undefined) {
    if (!Array.isArray(input.dimensionRubrics)) {
      throw new TypeError(
        "Metric registry `dimensionRubrics` must be an array."
      );
    }
    for (const [index, rubric] of (
      input.dimensionRubrics as unknown[]
    ).entries()) {
      assertDimensionRubric(rubric, `dimensionRubrics[${String(index)}]`);
      dimensionRubrics.push(rubric as PlaytestDimensionRubric);
    }
  }
  return {
    schema: PLAYTESTS_REGISTRY_SCHEMA,
    schemaVersion: 1,
    workspaceId: input.workspaceId as string,
    audience: input.audience as string,
    registryVersion: input.registryVersion as string,
    eventSchemaHash: input.eventSchemaHash as string,
    defaults: input.defaults as PlaytestRegistryDefaults,
    metricDefinitions: expandedMetrics,
    dimensionRubrics
  };
}

/** Look up an expanded metric definition by its stable id. */
export function lookupPlaytestMetric(
  registry: PlaytestMetricRegistry,
  metricId: string
): PlaytestMetricDefinition {
  for (const metric of registry.metricDefinitions) {
    if (metric.metricId === metricId) return metric;
  }
  throw new Error(`Metric "${metricId}" not found in registry.`);
}

/** Look up a dimension rubric by its stable id (or `null` if absent). */
export function lookupPlaytestDimensionRubric(
  registry: PlaytestMetricRegistry,
  dimensionId: string
): PlaytestDimensionRubric | null {
  for (const rubric of registry.dimensionRubrics) {
    if (rubric.dimensionId === dimensionId) return rubric;
  }
  return null;
}

/**
 * Build a minimal default registry-level defaults block that matches the
 * normative `metric contract §1` sample. Intended for tests and fixtures;
 * production registries must construct their own.
 */
export function defaultPlaytestRegistryDefaults(): PlaytestRegistryDefaults {
  return {
    audience: "first-time-adult",
    scenarioEligibility: ["tutorial", "standard"],
    analysisUnit: "episode",
    aggregationWindow: "whole-episode",
    aggregation: "ratio-of-sums-within-scenario",
    modality: "headless",
    minExposure: 1,
    minIndependentUnits: 1,
    precisionPlanRef: "fixture-descriptive-only",
    missingPolicy: "null-with-reason-and-missing-count",
    provenance: ["episodeId", "eventId", "buildSha", "evaluatorHash"],
    humanConstruct: null,
    meaningfulMargin: null,
    guardrailMargin: null,
    severityRule: "descriptive-until-verified",
    priorityClass: "investigate"
  };
}

/** Build the canonical provenance helper used by every evaluator. */
export function makePlaytestProvenance(
  workspaceId: string,
  measurementVersion: string,
  options: {
    readonly buildSha?: string;
    readonly evaluatorHash?: string;
    readonly rubricHash?: string;
    readonly instrumentVersion?: string;
    readonly generatedAt?: string;
  } = {}
): PlaytestProvenance {
  const generatedAt = options.generatedAt ?? new Date(0).toISOString();
  return {
    workspaceId,
    measurementVersion,
    ...(options.buildSha === undefined ? {} : { buildSha: options.buildSha }),
    ...(options.evaluatorHash === undefined
      ? {}
      : { evaluatorHash: options.evaluatorHash }),
    ...(options.rubricHash === undefined
      ? {}
      : { rubricHash: options.rubricHash }),
    ...(options.instrumentVersion === undefined
      ? {}
      : { instrumentVersion: options.instrumentVersion }),
    generatedAt
  };
}
