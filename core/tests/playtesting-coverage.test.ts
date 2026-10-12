import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestCoverageManifest,
  assertPlaytestCoveragePlanCoversAssignments,
  buildPlaytestCoverageManifestDraft,
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type PlaytestBatchAssignment,
  type PlaytestCoverageEpisode,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  playtestCoveragePlanForRegistry,
  type PlaytestMetricRegistry
} from "../src/playtesting/index.ts";

const WORKSPACE_ID = "owner/coverage-fixture";
const BATCH_ID = "batch-coverage-fixture";
const BUILD_SHA = "a".repeat(40);
const RUBRIC_HASH = "b".repeat(64);
const ASSIGNMENT_HASH = "c".repeat(64);

function registry(): PlaytestMetricRegistry {
  return expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    audience: "fixture-player",
    registryVersion: "coverage-v1",
    eventSchemaHash: "d".repeat(64),
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [
      {
        metricId: "decision-rate",
        version: 2,
        mechanicKey: "pit-strategy",
        scenarioEligibility: ["easy", "hard"],
        exposurePredicate: "fixture-opportunity-v1",
        eventFields: ["decision.eligible"],
        aggregationWindow: "phase",
        evaluatorRef: "game/evaluator.ts#decision-rate",
        evaluatorHash: "e".repeat(64),
        numerator: "positive decisions",
        denominator: "eligible decisions",
        unit: "proportion",
        polarity: "higher",
        targetBand: [0, 1],
        notObservable: ["unobserved"]
      }
    ],
    coverageRequirements: [
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "easy-family",
        cohort: "novice",
        policy: "heuristic",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 10,
        unsupportedReason: null
      },
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "hard-family",
        cohort: "novice",
        policy: "heuristic",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 1,
        unsupportedReason: null
      },
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "standard-family",
        cohort: "visual-only",
        policy: "visual-observer",
        modality: "headless",
        requiredOpportunities: 0,
        requiredIndependentUnits: 0,
        unsupportedReason:
          "target adapter has no authoritative visual event emitter"
      }
    ],
    dimensionRubrics: []
  });
}

function assignment(
  overrides: Partial<PlaytestBatchAssignment> = {}
): PlaytestBatchAssignment {
  return {
    assignmentId: "assignment-1",
    scenarioId: "easy",
    scenarioFamily: "easy-family",
    policyId: "heuristic",
    policyVersion: "heuristic-v1",
    cohort: "novice",
    seed: "seed-1",
    maxSteps: 20,
    ...overrides
  };
}

function episodeFor(
  run: PlaytestBatchAssignment,
  episodeId: string,
  opportunities = 1
): PlaytestCoverageEpisode {
  return {
    batchId: BATCH_ID,
    assignmentId: run.assignmentId,
    identity: {
      workspaceId: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      scenarioId: run.scenarioId,
      policyId: run.policyId,
      policyVersion: run.policyVersion,
      seed: run.seed
    },
    scenarioFamily: run.scenarioFamily,
    policyCohort: run.cohort ?? "unknown",
    metrics: [
      {
        metricId: "decision-rate",
        metricVersion: 2,
        phaseId: "race",
        numerator: opportunities,
        denominator: opportunities,
        opportunityCount: opportunities,
        coverage: opportunities === 0 ? 0 : 1,
        unit: "proportion",
        estimate: opportunities === 0 ? null : 1,
        missing: 0,
        missingReasons: [],
        independentUnits: opportunities === 0 ? 0 : 1,
        provenance: {
          workspaceId: WORKSPACE_ID,
          buildSha: BUILD_SHA,
          evaluatorHash: "e".repeat(64),
          rubricHash: RUBRIC_HASH,
          measurementVersion: "playtesting-measurement-v2",
          generatedAt: "2026-10-12T00:00:00.000Z"
        },
        notes: "fixture"
      }
    ],
    // The identifier is useful in failure output and proves every episode row
    // in the fixture is deliberately distinct.
    episodeId
  } as PlaytestCoverageEpisode;
}

function manifest(
  assignments: readonly PlaytestBatchAssignment[],
  episodes: readonly PlaytestCoverageEpisode[] = [],
  mode: "headless" | "browser" | "native-visual" = "headless"
): PlaytestCoverageManifest {
  const draft = buildPlaytestCoverageManifestDraft({
    rubricHash: RUBRIC_HASH,
    assignmentManifestHash: ASSIGNMENT_HASH,
    mode,
    generatedAt: "2026-10-12T00:00:00.000Z",
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    plan: playtestCoveragePlanForRegistry(registry()),
    assignments,
    episodes
  });
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
}

test("coverage aggregates exact phase/profile cells and never substitutes easy volume for a missing hard cell", () => {
  const easyAssignments = Array.from({ length: 100 }, (_, index) =>
    assignment({
      assignmentId: `easy-${String(index)}`,
      seed: `seed-${String(index)}`
    })
  );
  const episodes = easyAssignments.map((run, index) =>
    episodeFor(run, `episode-${String(index)}`)
  );
  const coverage = manifest(easyAssignments, episodes);
  assert.equal(coverage.cells[0]?.observedOpportunities, 100);
  assert.equal(coverage.cells[0]?.observedIndependentUnits, 100);
  assert.equal(coverage.cells[0]?.status, "covered");
  assert.equal(coverage.cells[1]?.assignedEpisodes, 0);
  assert.equal(coverage.cells[1]?.status, "not-assigned");
  assert.equal(coverage.cells[2]?.status, "unsupported");
  assert.doesNotThrow(() => assertPlaytestCoverageManifest(coverage));
});

test("coverage preserves missing assignments, missing metric rows, and unresolved historical cohorts", () => {
  const hard = assignment({
    assignmentId: "hard-1",
    scenarioId: "hard",
    scenarioFamily: "hard-family",
    seed: "hard-seed"
  });
  const missingEpisode = manifest([hard]);
  assert.equal(missingEpisode.cells[1]?.status, "partial");
  assert.equal(missingEpisode.cells[1]?.missingAssignments, 1);

  const noMetric: PlaytestCoverageEpisode = {
    ...episodeFor(hard, "hard-episode"),
    metrics: []
  };
  const missingResult = manifest([hard], [noMetric]);
  assert.equal(missingResult.cells[1]?.status, "partial");
  assert.equal(missingResult.cells[1]?.missingMetricResults, 1);

  const unresolved = assignment({
    ...hard,
    assignmentId: "legacy-hard",
    cohort: null
  });
  const unresolvedCoverage = manifest([unresolved]);
  assert.equal(unresolvedCoverage.cells[1]?.unresolvedCohortAssignments, 1);
  assert.equal(unresolvedCoverage.cells[1]?.status, "partial");
});

test("coverage distinguishes unavailable modality from a game-declared unsupported cell", () => {
  const run = assignment({
    assignmentId: "hard-browser",
    scenarioId: "hard",
    scenarioFamily: "hard-family",
    seed: "hard-browser"
  });
  const coverage = manifest(
    [run],
    [episodeFor(run, "episode-browser")],
    "browser"
  );
  assert.equal(coverage.cells[0]?.status, "unsupported-modality");
  assert.equal(coverage.cells[1]?.status, "unsupported-modality");
  assert.equal(coverage.cells[2]?.status, "unsupported");
  assert.equal(
    coverage.cells[2]?.unsupportedReason,
    "target adapter has no authoritative visual event emitter"
  );
});

test("coverage does not sum learner-identity counts across episodes without deduplication keys", () => {
  const base = registry();
  const learnerRegistry = expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: base.workspaceId,
    audience: base.audience,
    registryVersion: base.registryVersion,
    eventSchemaHash: base.eventSchemaHash,
    defaults: base.defaults,
    metricDefinitions: base.metricDefinitions.map((metric) => ({
      ...metric,
      analysisUnit: "learner-identity"
    })),
    coverageRequirements: base.coverageRequirements,
    dimensionRubrics: []
  });
  const runs = [
    assignment({ assignmentId: "learner-1", seed: "seed-1" }),
    assignment({ assignmentId: "learner-2", seed: "seed-2" })
  ];
  const coveredOpportunities = manifest(runs, [
    episodeFor(runs[0]!, "learner-episode-1"),
    episodeFor(runs[1]!, "learner-episode-2")
  ]);
  const safeDraft = buildPlaytestCoverageManifestDraft({
    rubricHash: RUBRIC_HASH,
    assignmentManifestHash: ASSIGNMENT_HASH,
    mode: "headless",
    generatedAt: "2026-10-12T00:00:00.000Z",
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    plan: playtestCoveragePlanForRegistry(learnerRegistry),
    assignments: runs,
    episodes: [
      episodeFor(runs[0]!, "learner-episode-1"),
      episodeFor(runs[1]!, "learner-episode-2")
    ]
  });
  const safeCoverage = {
    ...safeDraft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(safeDraft))
      .digest("hex")
  };
  assert.equal(coveredOpportunities.cells[0]?.observedIndependentUnits, 2);
  assert.equal(safeCoverage.cells[0]?.observedOpportunities, 2);
  assert.equal(safeCoverage.cells[0]?.observedIndependentUnits, null);
  assert.equal(safeCoverage.cells[0]?.status, "insufficient");
});

test("coverage rejects orphaned episodes, duplicate assignments, plan omissions, and tampered hashes", () => {
  const run = assignment();
  assert.throws(
    () =>
      manifest(
        [run],
        [episodeFor(assignment({ assignmentId: "other" }), "orphan")]
      ),
    /does not match its frozen assignment/u
  );
  assert.throws(() => manifest([run, run]), /unique IDs/u);
  assert.throws(
    () =>
      assertPlaytestCoveragePlanCoversAssignments({
        registry: registry(),
        plan: [],
        assignments: [run]
      }),
    /omits eligible metric/u
  );
  const valid = manifest([run], [episodeFor(run, "episode-1")]);
  assert.throws(
    () => assertPlaytestCoverageManifest({ ...valid, contentHash: "invalid" }),
    /identity is malformed/u
  );
});
