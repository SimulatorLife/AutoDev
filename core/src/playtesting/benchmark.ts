/** Validation and canonical content projection for immutable benchmarks. */

import type { PlaytestBenchmark } from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import { assertPlaytestEvidenceLocator } from "./protocol.ts";
import { PLAYTESTS_GAME_MODES } from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const BENCHMARK_KEYS = [
  "benchmarkId",
  "version",
  "workspaceId",
  "referenceBuildSha",
  "scenarioInventory",
  "seedInventory",
  "policyVersions",
  "competenceReportRefs",
  "memoryResetRules",
  "engineEnvironmentHash",
  "actionSchemaHash",
  "observationSchemaHash",
  "eventSchemaHash",
  "metricRegistryHash",
  "rubricHash",
  "captureMode",
  "measurementVersion",
  "primaryMetricIds",
  "guardrailMetricIds",
  "practicalMargins",
  "independentUnit",
  "precisionPlanRef",
  "missingnessBound",
  "refreshPolicy",
  "createdAt",
  "createdBy",
  "cohortWeights",
  "contentHash"
] as const;

const BENCHMARK_INDEPENDENT_UNITS = new Set([
  "episode",
  "learner",
  "participant",
  "cluster"
]);

const BENCHMARK_COHORT_WEIGHT_TOLERANCE = 1e-9;

export function assertPlaytestCohortWeights(
  value: unknown,
  label: string
): asserts value is Readonly<Record<string, number>> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const cohortKeys = Object.keys(value);
  if (cohortKeys.length === 0) {
    throw new TypeError(`${label} must declare at least one cohort weight.`);
  }
  const seen = new Set<string>();
  let weightSum = 0;
  for (const cohortKey of cohortKeys) {
    if (cohortKey.trim().length === 0 || seen.has(cohortKey)) {
      throw new TypeError(
        `${label} contains an empty or duplicate cohort key "${cohortKey}".`
      );
    }
    seen.add(cohortKey);
    const weight = value[cohortKey];
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new TypeError(
        `${label} weight for "${cohortKey}" must be a finite number.`
      );
    }
    if (weight <= 0) {
      throw new TypeError(
        `${label} weight for "${cohortKey}" must be a positive number.`
      );
    }
    weightSum += weight;
  }
  if (Math.abs(weightSum - 1) > BENCHMARK_COHORT_WEIGHT_TOLERANCE) {
    throw new TypeError(
      `${label} must sum to 1.0 within ${String(
        BENCHMARK_COHORT_WEIGHT_TOLERANCE
      )}; observed ${String(weightSum)}.`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 hexadecimal digest.`);
  }
}

function assertUniqueStrings(
  value: unknown,
  label: string
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !nonEmpty(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} must contain unique non-empty strings.`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set<string>(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains an unknown field.`);
  }
}

function isIsoTimestampSeparator(value: string, index: number): boolean {
  return index === 4 || index === 7
    ? value[index] === "-"
    : index === 10
      ? value[index] === "T"
      : index === 13 || index === 16
        ? value[index] === ":"
        : false;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 24) {
    return false;
  }
  for (const index of [4, 7, 10, 13, 16]) {
    if (!isIsoTimestampSeparator(value, index)) return false;
  }
  if (value.at(-1) !== "Z") return false;
  for (let index = 0; index < 19; index += 1) {
    if (isIsoTimestampSeparator(value, index)) continue;
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  if (value.length > 20) {
    if (value[19] !== "." || value.length < 22 || value.length > 24)
      return false;
    for (let index = 20; index < value.length - 1; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 48 || code > 57) return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

function assertScenarioInventory(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Benchmark scenario inventory must not be empty.");
  }
  const scenarioIds = new Set<string>();
  let scenarioWeight = 0;
  for (const [index, scenario] of value.entries()) {
    if (
      !isRecord(scenario) ||
      !nonEmpty(scenario.scenarioId) ||
      !nonEmpty(scenario.family) ||
      !Number.isFinite(scenario.weight) ||
      (scenario.weight as number) <= 0 ||
      scenarioIds.has(scenario.scenarioId)
    ) {
      throw new TypeError(
        `Benchmark scenarioInventory[${String(index)}] is invalid.`
      );
    }
    assertOnlyKeys(
      scenario,
      ["scenarioId", "family", "weight"],
      `Benchmark scenarioInventory[${String(index)}]`
    );
    scenarioIds.add(scenario.scenarioId);
    scenarioWeight += scenario.weight as number;
  }
  if (Math.abs(scenarioWeight - 1) > 1e-9) {
    throw new TypeError("Benchmark scenario weights must sum to 1.");
  }
}

function assertSeedInventory(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Benchmark seedInventory must not be empty.");
  }
  const seeds = new Set<string>();
  for (const [index, seed] of value.entries()) {
    if (
      !isRecord(seed) ||
      !nonEmpty(seed.seed) ||
      seeds.has(seed.seed) ||
      !["discovery", "confirmation", "regression"].includes(
        String(seed.purpose)
      )
    ) {
      throw new TypeError(
        `Benchmark seedInventory[${String(index)}] is invalid.`
      );
    }
    assertOnlyKeys(
      seed,
      ["seed", "purpose"],
      `Benchmark seedInventory[${String(index)}]`
    );
    seeds.add(seed.seed);
  }
}

function assertPolicyVersions(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new TypeError(
      "Benchmark policyVersions must name at least one frozen policy."
    );
  }
  for (const [policyId, version] of Object.entries(value)) {
    if (!nonEmpty(policyId) || !nonEmpty(version)) {
      throw new TypeError(
        "Benchmark policy IDs and versions must be non-empty."
      );
    }
  }
}

function assertBenchmarkMetrics(value: Record<string, unknown>): void {
  assertUniqueStrings(value.primaryMetricIds, "Benchmark primaryMetricIds");
  assertUniqueStrings(value.guardrailMetricIds, "Benchmark guardrailMetricIds");
  if (value.primaryMetricIds.length === 0) {
    throw new TypeError(
      "Benchmark must preregister at least one primary metric."
    );
  }
  const primary = new Set(value.primaryMetricIds);
  if (value.guardrailMetricIds.some((id) => primary.has(id))) {
    throw new TypeError(
      "A benchmark metric cannot be both primary and guardrail."
    );
  }
  const requiredMetrics = new Set([
    ...value.primaryMetricIds,
    ...value.guardrailMetricIds
  ]);
  if (!isRecord(value.practicalMargins)) {
    throw new TypeError("Benchmark practicalMargins must be an object.");
  }
  const margins = Object.keys(value.practicalMargins);
  if (
    margins.length !== requiredMetrics.size ||
    margins.some((id) => !requiredMetrics.has(id))
  ) {
    throw new TypeError(
      "Benchmark must define exactly one margin per primary and guardrail metric."
    );
  }
  for (const [metricId, margin] of Object.entries(value.practicalMargins)) {
    if (!Number.isFinite(margin) || (margin as number) < 0) {
      throw new TypeError(
        `Benchmark practical margin for ${metricId} is invalid.`
      );
    }
  }
}

function assertBenchmarkMetadata(value: Record<string, unknown>): void {
  if (
    typeof value.captureMode !== "string" ||
    !(PLAYTESTS_GAME_MODES as readonly string[]).includes(value.captureMode)
  ) {
    throw new TypeError("Benchmark captureMode is unsupported.");
  }
  if (
    typeof value.independentUnit !== "string" ||
    !BENCHMARK_INDEPENDENT_UNITS.has(value.independentUnit)
  ) {
    throw new TypeError("Benchmark independentUnit is unsupported.");
  }
  if (
    !Number.isFinite(value.missingnessBound) ||
    (value.missingnessBound as number) < 0 ||
    (value.missingnessBound as number) > 1
  ) {
    throw new TypeError("Benchmark missingnessBound must be between 0 and 1.");
  }
  assertPlaytestCohortWeights(value.cohortWeights, "Benchmark cohortWeights");
  if (!isIsoTimestamp(value.createdAt)) {
    throw new TypeError(
      "Benchmark createdAt must be an ISO-compatible timestamp."
    );
  }
}

/**
 * Validate the immutable benchmark manifest before Runtime/Data accept it.
 * Scenario weights are an explicit probability distribution, and all
 * preregistered metrics must carry exactly one practical margin.
 */
export function assertPlaytestBenchmark(
  value: unknown
): asserts value is PlaytestBenchmark {
  if (!isRecord(value)) throw new TypeError("Benchmark must be an object.");
  assertOnlyKeys(value, BENCHMARK_KEYS, "Benchmark");
  if (!nonEmpty(value.benchmarkId) || !nonEmpty(value.workspaceId)) {
    throw new TypeError("Benchmark requires a stable ID and workspace.");
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new TypeError("Benchmark version must be a positive integer.");
  }
  if (
    typeof value.referenceBuildSha !== "string" ||
    !BUILD_SHA_PATTERN.test(value.referenceBuildSha)
  ) {
    throw new TypeError(
      "Benchmark referenceBuildSha must be an immutable Git SHA."
    );
  }
  assertScenarioInventory(value.scenarioInventory);
  assertSeedInventory(value.seedInventory);
  assertPolicyVersions(value.policyVersions);
  if (!Array.isArray(value.competenceReportRefs)) {
    throw new TypeError("Benchmark competenceReportRefs must be an array.");
  }
  for (const reference of value.competenceReportRefs)
    assertPlaytestEvidenceLocator(reference);
  for (const key of [
    "memoryResetRules",
    "measurementVersion",
    "precisionPlanRef",
    "refreshPolicy",
    "createdBy"
  ]) {
    if (!nonEmpty(value[key]))
      throw new TypeError(`Benchmark ${key} must be non-empty.`);
  }
  for (const key of [
    "engineEnvironmentHash",
    "actionSchemaHash",
    "observationSchemaHash",
    "eventSchemaHash",
    "metricRegistryHash",
    "rubricHash",
    "contentHash"
  ]) {
    assertHash(value[key], `Benchmark ${key}`);
  }
  assertBenchmarkMetrics(value);
  assertBenchmarkMetadata(value);
}

/** Stable JSON payload used by Runtime to compute the benchmark contentHash. */
export function playtestBenchmarkHashInput(
  benchmark: Omit<PlaytestBenchmark, "contentHash">
): string {
  const hashable = { ...benchmark } as Record<string, unknown>;
  delete hashable.contentHash;
  return canonicalPlaytestJson(hashable);
}
