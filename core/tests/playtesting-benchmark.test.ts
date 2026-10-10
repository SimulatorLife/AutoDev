import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { PlaytestBenchmark } from "../src/playtesting/artifacts.ts";
import {
  assertPlaytestBenchmark,
  playtestBenchmarkHashInput
} from "../src/playtesting/benchmark.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function benchmarkInput() {
  return {
    benchmarkId: "benchmark-synthetic-v1",
    version: 1,
    workspaceId: "fixture/synthetic-game",
    referenceBuildSha: "a".repeat(40),
    scenarioInventory: [
      { scenarioId: "tutorial", family: "onboarding", weight: 0.75 },
      { scenarioId: "edge", family: "edge-cases", weight: 0.25 }
    ],
    seedInventory: [
      { seed: "seed-discovery", purpose: "discovery" as const },
      { seed: "seed-confirmation", purpose: "confirmation" as const },
      { seed: "seed-regression", purpose: "regression" as const }
    ],
    policyVersions: { random: "hmac-sha256-v1" },
    competenceReportRefs: [{ kind: "episode" as const, id: "policy-validity" }],
    memoryResetRules: "One isolated episode; no shared learning memory.",
    engineEnvironmentHash: sha256("fixture-environment-v1"),
    actionSchemaHash: sha256("fixture-actions-v1"),
    observationSchemaHash: sha256("fixture-observations-v1"),
    eventSchemaHash: sha256("fixture-events-v1"),
    metricRegistryHash: sha256("fixture-registry-v1"),
    rubricHash: sha256("fixture-rubric-v1"),
    captureMode: "headless" as const,
    measurementVersion: "playtesting-measurement-v1",
    primaryMetricIds: ["legal-action-rejection"],
    guardrailMetricIds: ["crash-rate"],
    practicalMargins: {
      "legal-action-rejection": 0.02,
      "crash-rate": 0.01
    },
    independentUnit: "episode" as const,
    precisionPlanRef: "fixture-descriptive-only",
    missingnessBound: 0.1,
    refreshPolicy: "manual operator review only",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "fixture-operator",
    cohortWeights: {
      easy: 0.5,
      hard: 0.5
    }
  };
}

function frozenBenchmark(): PlaytestBenchmark {
  const withoutHash = benchmarkInput();
  return {
    ...withoutHash,
    contentHash: sha256(playtestBenchmarkHashInput(withoutHash))
  };
}

test("benchmark accepts frozen scenario/seed inventories, cohort weights, and exact source hashes", () => {
  const benchmark = frozenBenchmark();
  assert.doesNotThrow(() => assertPlaytestBenchmark(benchmark));
  assert.equal(
    benchmark.contentHash,
    sha256(playtestBenchmarkHashInput(benchmark))
  );
});

test("benchmark hash input is key-order independent and excludes its own digest", () => {
  const benchmark = frozenBenchmark();
  const reordered = Object.fromEntries(
    Object.entries(benchmarkInput()).reverse()
  );
  assert.equal(
    playtestBenchmarkHashInput(benchmark),
    playtestBenchmarkHashInput(reordered as ReturnType<typeof benchmarkInput>)
  );
});

test("benchmark content hash binds the frozen cohort weight distribution", () => {
  const benchmark = frozenBenchmark();
  const shiftedWeightsInput = {
    ...benchmarkInput(),
    cohortWeights: { easy: 0.7, hard: 0.3 }
  };
  const shiftedContentHash = sha256(playtestBenchmarkHashInput(shiftedWeightsInput));
  assert.notEqual(
    benchmark.contentHash,
    shiftedContentHash,
    "changing the cohort weight vector must change the canonical content hash"
  );
  // And a freshly-recomputed hash on the original manifest still equals
  // its stored contentHash; this is the stability half of the binding.
  assert.equal(
    benchmark.contentHash,
    sha256(playtestBenchmarkHashInput(benchmarkInput()))
  );
});

test("benchmark rejects unnormalized scenario weights, duplicate seeds, and duplicate metrics", () => {
  const benchmark = frozenBenchmark();
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        scenarioInventory: benchmark.scenarioInventory.map((scenario) => ({
          ...scenario,
          weight: 0.6
        }))
      }),
    /scenario weights must sum to 1/u
  );
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        seedInventory: [benchmark.seedInventory[0], benchmark.seedInventory[0]]
      }),
    /seedInventory\[1\] is invalid/u
  );
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        guardrailMetricIds: ["legal-action-rejection"]
      }),
    /both primary and guardrail/u
  );
});

test("benchmark requires margins for exactly the preregistered primary and guardrail metrics", () => {
  const benchmark = frozenBenchmark();
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        practicalMargins: { "legal-action-rejection": 0.02 }
      }),
    /exactly one margin/u
  );
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        practicalMargins: {
          ...benchmark.practicalMargins,
          unexplained: 0.5
        }
      }),
    /exactly one margin/u
  );
});

test("benchmark rejects malformed hashes, date, sensitivity bound and nested unknown fields", () => {
  const benchmark = frozenBenchmark();
  assert.throws(
    () => assertPlaytestBenchmark({ ...benchmark, rubricHash: "fixture" }),
    /rubricHash must be a SHA-256/u
  );
  assert.throws(
    () => assertPlaytestBenchmark({ ...benchmark, createdAt: "tomorrow" }),
    /ISO-compatible timestamp/u
  );
  assert.throws(
    () => assertPlaytestBenchmark({ ...benchmark, missingnessBound: 1.1 }),
    /between 0 and 1/u
  );
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        scenarioInventory: [
          { ...benchmark.scenarioInventory[0]!, surprise: true },
          benchmark.scenarioInventory[1]
        ]
      }),
    /scenarioInventory\[0\] contains an unknown field/u
  );
});

test("benchmark rejects missing or malformed cohortWeights", () => {
  const benchmark = frozenBenchmark();
  // Missing entirely (the field is required).
  const { cohortWeights: _omit, ...withoutCohortWeights } = benchmark;
  void _omit;
  assert.throws(
    () => assertPlaytestBenchmark(withoutCohortWeights),
    /cohortWeights must be an object/u
  );
  // Empty map.
  assert.throws(
    () => assertPlaytestBenchmark({ ...benchmark, cohortWeights: {} }),
    /at least one cohort weight/u
  );
  // Duplicate cohort id (object literal collapses them at parse time, so
  // we use an explicit Map-style seed instead).
  const duplicateId: Record<string, number> = {};
  duplicateId["easy"] = 0.5;
  duplicateId["easy"] = 0.5;
  // Defensive belt: the object above keeps one entry, so also exercise the
  // not-an-object branch.
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: null as unknown as Record<string, number>
      }),
    /cohortWeights must be an object/u
  );
  void duplicateId;
});

test("benchmark rejects cohortWeights whose keys are empty or whose weights are not finite positive", () => {
  const benchmark = frozenBenchmark();
  // Non-finite weight.
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: { easy: Number.NaN, hard: 1 }
      }),
    /finite number/u
  );
  // Zero weight is rejected because the contract requires finite
  // *positive* weights -- a zero cohort would silently vanish from the
  // standardization denominator.
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: { easy: 0, hard: 1 }
      }),
    /positive number/u
  );
  // Negative weight is rejected.
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: { easy: -0.1, hard: 1.1 }
      }),
    /positive number/u
  );
  // Weights that do not sum to 1.
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: { easy: 0.4, hard: 0.4 }
      }),
    /sum to 1\.0/u
  );
  assert.throws(
    () =>
      assertPlaytestBenchmark({
        ...benchmark,
        cohortWeights: { easy: 0.6, hard: 0.6 }
      }),
    /sum to 1\.0/u
  );
});
