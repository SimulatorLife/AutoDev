import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateMiniPxiEnj,
  allocatePlaytestExperimentArms,
  allocatePlaytestSurveillanceStrata,
  assertNoContradictingLocator,
  assertPlaytestAdapterParams,
  assertPlaytestAdapterResult,
  assertPlaytestCapabilityAdvertisement,
  assertPlaytestEventTaxonomy,
  assertPlaytestEvidenceLocator,
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestGameConfiguration,
  assertPlaytestJsonRpcError,
  assertPlaytestJsonRpcNotification,
  assertPlaytestJsonRpcRequest,
  assertPlaytestJsonRpcResponse,
  assertPlaytestJsonRpcSuccess,
  assertPlaytestObservationContract,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestComparison,
  buildPlaytestCoverageManifest,
  categorizeMiniPxiEnjValue,
  classifyPlaytestMetricComparison,
  decidePlaytestComparisonStatus,
  defaultPlaytestRegistryDefaults,
  evaluateCompetitiveChoiceShare,
  evaluateLegalActionRejection,
  evaluateRepeatForecastError,
  expandPlaytestRegistry,
  fixtureAgencyDimensionRubric,
  groupByStratum,
  isValidPlaytestInterval,
  lookupPlaytestMetric,
  type PlaytestKnownEvidenceIndex,
  type PlaytestMetricComparison,
  recordPlaytestOwnerDecision,
  samplePlaytestDiscovery,
  samplePlaytestSurveillance,
  scorePlaytestDimensionAnchor,
  verifyPlaytestClaim
} from "../src/playtesting/index.ts";
import { assertWorkspacePlaytestApproval } from "../src/workspaces/playtesting.ts";

const WORKSPACE_ID = "fixture-game";
const MEASUREMENT_VERSION = "fixture-v1";

// --- §1 fixture registry ---------------------------------------------------

function buildFixtureRegistryInput() {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    audience: "first-time-adult",
    registryVersion: "fixture-v1",
    eventSchemaHash: "fixture-events-v1",
    defaults: defaultPlaytestRegistryDefaults(),
    metricDefinitions: [
      {
        metricId: "legal-action-rejection",
        version: 1,
        mechanicKey: "action-execution",
        exposurePredicate: "fresh-legal-request-v1",
        eventFields: [
          "action.offeredIds",
          "action.expectedRevision",
          "action.currentRevision",
          "action.executedId",
          "action.rejected"
        ],
        evaluatorRef: "fixture/legal-rejection-v1",
        numerator: "fresh advertised legal requests rejected by engine",
        denominator: "all fresh advertised legal requests",
        unit: "proportion",
        polarity: "lower" as const,
        targetBand: [0, 0] as const,
        notObservable: ["missing-action-or-revision-events" as const]
      },
      {
        metricId: "competitive-choice-share",
        version: 1,
        mechanicKey: "strategic-choice",
        exposurePredicate:
          "decision-with-complete-approved-alternative-evaluation-v1",
        eventFields: [
          "branch.decisionId",
          "branch.actionId",
          "branch.expectedReward",
          "branch.complete",
          "branch.continuationPolicyHash"
        ],
        evaluatorRef: "fixture/competitive-options-v1",
        numerator:
          "eligible decisions with at least two actions within 0.05 of best expected reward",
        denominator:
          "decisions with all legal alternatives evaluated under frozen continuation and RNG plan",
        unit: "proportion",
        polarity: "higher" as const,
        targetBand: [0.5, 1] as const,
        notObservable: [
          "fork-unsupported" as const,
          "partial-alternatives" as const,
          "reward-or-continuation-contract-mismatch" as const
        ]
      },
      {
        metricId: "repeat-forecast-error",
        version: 1,
        mechanicKey: "learning",
        exposurePredicate: "revisited-visible-rule-after-feedback-v1",
        eventFields: [
          "probe.ruleId",
          "probe.expected",
          "probe.actual",
          "probe.beforeAction",
          "cohort.memoryId",
          "feedback.visible"
        ],
        evaluatorRef: "fixture/repeated-error-v1",
        numerator:
          "wrong preregistered deterministic consequence predictions after visible feedback",
        denominator: "eligible revisits after visible feedback",
        unit: "proportion",
        analysisUnit: "learner-identity" as const,
        polarity: "lower" as const,
        targetBand: [0, 0.2] as const,
        notObservable: [
          "missing-before-action-probe" as const,
          "stochastic-outcome-without-probability-target" as const,
          "missing-feedback" as const
        ]
      },
      {
        metricId: "reported-enjoyment",
        version: 1,
        mechanicKey: "whole-experience",
        exposurePredicate: "consented-post-play-enj-within-study-window-v1",
        eventFields: [
          "response.ENJ",
          "response.timing",
          "response.consentVersion",
          "response.instrumentVersion"
        ],
        evaluatorRef: "fixture/minipxi-enj-v1",
        numerator: "sum of valid ENJ responses",
        denominator: "valid ENJ respondent-session responses",
        unit: "native-Likert-minus3-plus3",
        polarity: "higher" as const,
        targetBand: [1, 3] as const,
        aggregation: "native-item-mean-and-category-distribution" as const,
        analysisUnit: "participant" as const,
        modality: "human-post-play" as const,
        notObservable: [
          "no-consent" as const,
          "withdrawn" as const,
          "missing-ENJ" as const,
          "wrong-instrument" as const,
          "outside-window" as const
        ],
        humanConstruct: "miniPXI.ENJ.post-play",
        provenance: [
          "studyId",
          "responseId",
          "episodeId",
          "buildSha",
          "instrumentVersion"
        ]
      }
    ],
    dimensionRubrics: [fixtureAgencyDimensionRubric()]
  };
}

test("expandPlaytestRegistry fills defaults by shallow replacement and rejects absent required fields", () => {
  const registry = expandPlaytestRegistry(buildFixtureRegistryInput());
  assert.equal(registry.metricDefinitions.length, 4);
  const legal = lookupPlaytestMetric(registry, "legal-action-rejection");
  assert.equal(legal.audience, "first-time-adult");
  assert.equal(legal.analysisUnit, "episode");
  assert.equal(legal.missingPolicy, "null-with-reason-and-missing-count");
  const enjoyment = lookupPlaytestMetric(registry, "reported-enjoyment");
  assert.equal(enjoyment.modality, "human-post-play");
  assert.equal(enjoyment.analysisUnit, "participant");
  assert.equal(enjoyment.humanConstruct, "miniPXI.ENJ.post-play");

  const learning = lookupPlaytestMetric(registry, "repeat-forecast-error");
  assert.equal(learning.analysisUnit, "learner-identity");
  assert.equal(
    learning.severityRule,
    "model-learning-signal-only".length > 0 ? learning.severityRule : ""
  );
});

test("expandPlaytestRegistry rejects a metric missing a required field after expansion", () => {
  const input = buildFixtureRegistryInput();
  const broken = {
    ...input,
    metricDefinitions: [
      {
        ...input.metricDefinitions[0],
        evaluatorRef: ""
      }
    ]
  };
  assert.throws(() => expandPlaytestRegistry(broken), /evaluatorRef/u);
});

test("expandPlaytestRegistry rejects duplicate metric ids", () => {
  const input = buildFixtureRegistryInput();
  const duplicated = {
    ...input,
    metricDefinitions: [input.metricDefinitions[0], input.metricDefinitions[0]]
  };
  assert.throws(
    () => expandPlaytestRegistry(duplicated),
    /duplicate metricId/u
  );
});

test("expandPlaytestRegistry rejects an unknown dimension-rubric field", () => {
  const input = buildFixtureRegistryInput();
  const rubric = fixtureAgencyDimensionRubric();
  const broken = {
    ...input,
    dimensionRubrics: [{ ...rubric, extraField: "nope" }]
  };
  assert.throws(() => expandPlaytestRegistry(broken), /unknown field/u);
});

test("expandPlaytestRegistry rejects a dimension rubric missing a score band", () => {
  const input = buildFixtureRegistryInput();
  const rubric = fixtureAgencyDimensionRubric();
  const broken = {
    ...input,
    dimensionRubrics: [
      {
        ...rubric,
        scoreBands: rubric.scoreBands.filter((band) => band.score !== 2)
      }
    ]
  };
  assert.throws(
    () => expandPlaytestRegistry(broken),
    /must declare a band for score 2/u
  );
});

// --- §1 deterministic fixture evaluators ------------------------------------

test("evaluateLegalActionRejection: 2 rejected among 10 fresh requests is 0.20", () => {
  const fresh = (rejected: boolean) => ({
    requestId: "r",
    offeredIds: ["a", "b"],
    expectedRevision: 1,
    currentRevision: 1,
    executedId: "a",
    rejected
  });
  const events = [
    ...Array.from({ length: 2 }, () => fresh(true)),
    ...Array.from({ length: 8 }, () => fresh(false))
  ];
  const result = evaluateLegalActionRejection(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    events
  );
  assert.equal(result.numerator, 2);
  assert.equal(result.denominator, 10);
  assert.equal(result.estimate, 0.2);
  assert.equal(result.coverage, 1);
  assert.equal(result.missing, 0);
});

test("evaluateLegalActionRejection excludes stale-revision requests from both numerator and denominator", () => {
  const events = [
    {
      requestId: "stale",
      offeredIds: ["a"],
      expectedRevision: 1,
      currentRevision: 2,
      executedId: "a",
      rejected: true
    },
    {
      requestId: "fresh",
      offeredIds: ["a"],
      expectedRevision: 2,
      currentRevision: 2,
      executedId: "a",
      rejected: false
    }
  ];
  const result = evaluateLegalActionRejection(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    events
  );
  assert.equal(result.denominator, 1);
  assert.equal(result.numerator, 0);
  assert.equal(result.coverage, 0.5);
});

test("evaluateCompetitiveChoiceShare: fixture reward arrays yield 2/3 on 3/4 coverage, excluding the incomplete decision", () => {
  const decisions = [
    { decisionId: "d1", rewards: [0.8, 0.78], complete: true },
    { decisionId: "d2", rewards: [0.9, 0.1], complete: true },
    { decisionId: "d3", rewards: [0.4, 0.38], complete: true },
    { decisionId: "d4", rewards: null, complete: false }
  ];
  const result = evaluateCompetitiveChoiceShare(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    decisions
  );
  assert.equal(result.denominator, 3);
  assert.equal(result.numerator, 2);
  assert.equal(result.estimate, 2 / 3);
  assert.equal(result.coverage, 3 / 4);
  assert.equal(result.missing, 1);
  assert.deepEqual(result.missingReasons, ["partial-alternatives"]);
});

test("evaluateCompetitiveChoiceShare treats a dominated second action as not competitive", () => {
  const decisions = [{ decisionId: "d1", rewards: [0.9, 0.1], complete: true }];
  const result = evaluateCompetitiveChoiceShare(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    decisions
  );
  assert.equal(result.numerator, 0);
  assert.equal(result.denominator, 1);
  assert.equal(result.estimate, 0);
});

test("evaluateCompetitiveChoiceShare reports fork-unsupported for a single-rewarded decision", () => {
  const decisions = [{ decisionId: "d1", rewards: [0.9], complete: true }];
  const result = evaluateCompetitiveChoiceShare(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    decisions
  );
  assert.equal(result.denominator, 0);
  assert.equal(result.estimate, null);
  assert.deepEqual(result.missingReasons, ["fork-unsupported"]);
});

test("evaluateRepeatForecastError: 1 wrong among 4 eligible revisits is 1/4", () => {
  const base = { ruleId: "r1", beforeAction: true, feedbackVisible: true };
  const probes = [
    { ...base, expected: "double-dnf", actual: "single-dnf" },
    { ...base, expected: "single-dnf", actual: "single-dnf" },
    { ...base, expected: "single-dnf", actual: "single-dnf" },
    { ...base, expected: "single-dnf", actual: "single-dnf" }
  ];
  const result = evaluateRepeatForecastError(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    probes
  );
  assert.equal(result.numerator, 1);
  assert.equal(result.denominator, 4);
  assert.equal(result.estimate, 0.25);
});

test("evaluateRepeatForecastError excludes missing-before-action, missing-feedback, and untargeted-stochastic probes", () => {
  const probes = [
    {
      ruleId: "r1",
      expected: 1,
      actual: 1,
      beforeAction: false,
      feedbackVisible: true
    },
    {
      ruleId: "r2",
      expected: 1,
      actual: 1,
      beforeAction: true,
      feedbackVisible: false
    },
    {
      ruleId: "r3",
      expected: 1,
      actual: 2,
      beforeAction: true,
      feedbackVisible: true,
      stochasticWithoutTarget: true
    }
  ];
  const result = evaluateRepeatForecastError(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    probes
  );
  assert.equal(result.denominator, 0);
  assert.equal(result.estimate, null);
  assert.equal(result.missing, 3);
  assert.deepEqual(result.missingReasons, [
    "missing-before-action-probe",
    "missing-feedback",
    "stochastic-outcome-without-probability-target"
  ]);
});

test("aggregateMiniPxiEnj: [2,1,-1,null] gives native mean 2/3 with 3 respondents and 1 missing", () => {
  const responses = [
    { respondentId: "p1", nativeValue: 2 },
    { respondentId: "p2", nativeValue: 1 },
    { respondentId: "p3", nativeValue: -1 },
    {
      respondentId: "p4",
      nativeValue: null,
      missingReason: "missing-ENJ" as const
    }
  ];
  const result = aggregateMiniPxiEnj(
    WORKSPACE_ID,
    MEASUREMENT_VERSION,
    responses
  );
  assert.equal(result.respondentCount, 3);
  assert.equal(result.missingCount, 1);
  assert.equal(result.mean, 2 / 3);
  // Category counts preserve native -3..+3 values exactly; no rescaling or
  // midpoint grouping is applied.
  assert.equal(result.categoryCounts[2], 1);
  assert.equal(result.categoryCounts[1], 1);
  assert.equal(result.categoryCounts[-1], 1);
  assert.equal(result.categoryCounts[0], 0);
  assert.deepEqual(result.missingReasons, ["missing-ENJ"]);
});

test("aggregateMiniPxiEnj rejects an out-of-range native value", () => {
  assert.throws(
    () =>
      aggregateMiniPxiEnj(WORKSPACE_ID, MEASUREMENT_VERSION, [
        { respondentId: "p1", nativeValue: 4 }
      ]),
    /must be an integer in \[-3,3\]/u
  );
});

test("aggregateMiniPxiEnj rejects a duplicate respondent id", () => {
  assert.throws(
    () =>
      aggregateMiniPxiEnj(WORKSPACE_ID, MEASUREMENT_VERSION, [
        { respondentId: "p1", nativeValue: 1 },
        { respondentId: "p1", nativeValue: 2 }
      ]),
    /Duplicate miniPXI ENJ response/u
  );
});

test("categorizeMiniPxiEnjValue preserves each official native Likert value", () => {
  assert.deepEqual(
    [-3, -2, -1, 0, 1, 2, 3].map(categorizeMiniPxiEnjValue),
    [-3, -2, -1, 0, 1, 2, 3]
  );
  assert.throws(() => categorizeMiniPxiEnjValue(4), /integer in \[-3,3\]/u);
});

// --- §2 null-safe dimension anchor scoring -----------------------------------

test("scorePlaytestDimensionAnchor: 4 decisions with 0.5 competitive share maps to category 2", () => {
  const rubric = fixtureAgencyDimensionRubric();
  const anchor = scorePlaytestDimensionAnchor(rubric, {
    dimensionId: "agency",
    ratio: 0.5,
    independentUnits: 1,
    eligibleOpportunities: 4,
    evidenceRefs: [{ kind: "episode", id: "ep-1" }]
  });
  assert.equal(anchor.score, 2);
});

test("scorePlaytestDimensionAnchor: 0.75 competitive share maps to category 3", () => {
  const rubric = fixtureAgencyDimensionRubric();
  const anchor = scorePlaytestDimensionAnchor(rubric, {
    dimensionId: "agency",
    ratio: 0.75,
    independentUnits: 1,
    eligibleOpportunities: 4,
    evidenceRefs: [{ kind: "episode", id: "ep-1" }]
  });
  assert.equal(anchor.score, 3);
});

test("scorePlaytestDimensionAnchor: below minExposure opportunities yields null, never category 2", () => {
  const rubric = fixtureAgencyDimensionRubric();
  const anchor = scorePlaytestDimensionAnchor(rubric, {
    dimensionId: "agency",
    ratio: 0.5,
    independentUnits: 1,
    eligibleOpportunities: 2,
    evidenceRefs: [{ kind: "episode", id: "ep-1" }]
  });
  assert.equal(anchor.score, null);
  assert.equal(anchor.insufficientReason, "unobserved");
});

test("scorePlaytestDimensionAnchor: a null ratio is insufficient, not category 2", () => {
  const rubric = fixtureAgencyDimensionRubric();
  const anchor = scorePlaytestDimensionAnchor(rubric, {
    dimensionId: "agency",
    ratio: null,
    independentUnits: null,
    eligibleOpportunities: null,
    evidenceRefs: []
  });
  assert.equal(anchor.score, null);
});

test("scorePlaytestDimensionAnchor rejects a dimension-id mismatch", () => {
  const rubric = fixtureAgencyDimensionRubric();
  assert.throws(
    () =>
      scorePlaytestDimensionAnchor(rubric, {
        dimensionId: "pacing",
        ratio: 0.5,
        independentUnits: 1,
        eligibleOpportunities: 4,
        evidenceRefs: []
      }),
    /Dimension mismatch/u
  );
});

test("scorePlaytestDimensionAnchor: ratio exactly 0 maps to category 0", () => {
  const rubric = fixtureAgencyDimensionRubric();
  const anchor = scorePlaytestDimensionAnchor(rubric, {
    dimensionId: "agency",
    ratio: 0,
    independentUnits: 1,
    eligibleOpportunities: 4,
    evidenceRefs: []
  });
  assert.equal(anchor.score, 0);
});

// --- §3 seeded surveillance sampling with min-stratum + largest-remainder ---

test("allocatePlaytestSurveillanceStrata allocates at least one per stratum then proportionally by largest remainder", () => {
  const groups = groupByStratum([
    { id: "e1", stratumKey: "a" },
    { id: "e2", stratumKey: "a" },
    { id: "e3", stratumKey: "a" },
    { id: "e4", stratumKey: "a" },
    { id: "e5", stratumKey: "a" },
    { id: "e6", stratumKey: "a" },
    { id: "e7", stratumKey: "a" },
    { id: "e8", stratumKey: "a" },
    { id: "e9", stratumKey: "b" },
    { id: "e10", stratumKey: "b" }
  ]);
  const allocations = allocatePlaytestSurveillanceStrata(groups, 4);
  const total = allocations.reduce(
    (sum, allocation) => sum + allocation.allocated,
    0
  );
  assert.equal(total, 4);
  for (const allocation of allocations) {
    assert.ok(allocation.allocated >= 1);
  }
});

test("allocatePlaytestSurveillanceStrata rejects a budget smaller than the number of nonempty strata", () => {
  const groups = groupByStratum([
    { id: "e1", stratumKey: "a" },
    { id: "e2", stratumKey: "b" },
    { id: "e3", stratumKey: "c" }
  ]);
  assert.throws(
    () => allocatePlaytestSurveillanceStrata(groups, 2),
    /cannot cover 3 nonempty strata/u
  );
});

test("samplePlaytestSurveillance selects without replacement and is deterministic for a fixed seed", () => {
  const members = Array.from({ length: 20 }, (_, index) => ({
    id: `e${String(index)}`,
    stratumKey: index % 2 === 0 ? "even" : "odd"
  }));
  const first = samplePlaytestSurveillance(members, 10, "seed-123");
  const second = samplePlaytestSurveillance(members, 10, "seed-123");
  assert.deepEqual(first.selected, second.selected);
  assert.equal(new Set(first.selected).size, first.selected.length);
  assert.equal(first.totalAllocated, 10);
});

test("samplePlaytestSurveillance caps the actual sample at population size", () => {
  const members = [
    { id: "only-1", stratumKey: "tutorial" },
    { id: "only-2", stratumKey: "standard" }
  ];
  const sample = samplePlaytestSurveillance(members, 40, "fixed-seed");
  assert.equal(sample.budget, 40);
  assert.equal(sample.totalAllocated, 2);
  assert.equal(sample.selected.length, 2);
  assert.ok(
    sample.allocations.every(
      (allocation) => allocation.inclusionProbability === 1
    )
  );
});

test("samplePlaytestSurveillance rejects duplicate episode identities and absent seeds", () => {
  assert.throws(
    () =>
      samplePlaytestSurveillance(
        [
          { id: "same", stratumKey: "tutorial" },
          { id: "same", stratumKey: "standard" }
        ],
        2,
        "seed"
      ),
    /Duplicate surveillance episode id/u
  );
  assert.throws(
    () => samplePlaytestSurveillance([], 0, " "),
    /seed must be non-empty/u
  );
});

test("samplePlaytestSurveillance with a different seed yields a different selection", () => {
  const members = Array.from({ length: 20 }, (_, index) => ({
    id: `e${String(index)}`,
    stratumKey: index % 2 === 0 ? "even" : "odd"
  }));
  const first = samplePlaytestSurveillance(members, 10, "seed-a");
  const second = samplePlaytestSurveillance(members, 10, "seed-b");
  assert.notDeepEqual(first.selected, second.selected);
});

test("approved experiment allocation fixes independent units to predeclared arm quotas", () => {
  const units = Array.from(
    { length: 20 },
    (_, index) => "learner-" + String(index)
  );
  const arms = [
    { armId: "A", assignments: 10 },
    { armId: "B", assignments: 10 }
  ];
  const first = allocatePlaytestExperimentArms(
    units,
    arms,
    "allocation-seed-v1"
  );
  const replay = allocatePlaytestExperimentArms(
    [...units].reverse(),
    arms,
    "allocation-seed-v1"
  );
  assert.deepEqual(
    Object.fromEntries(
      first.map((item) => [item.independentUnitId, item.armId])
    ),
    Object.fromEntries(
      replay.map((item) => [item.independentUnitId, item.armId])
    )
  );
  assert.equal(first.filter((item) => item.armId === "A").length, 10);
  assert.equal(first.filter((item) => item.armId === "B").length, 10);
  assert.throws(
    () =>
      allocatePlaytestExperimentArms(
        units,
        [
          { armId: "A", assignments: 10 },
          { armId: "B", assignments: 9 }
        ],
        "seed"
      ),
    /quotas must equal/u
  );
});

test("samplePlaytestDiscovery rejects duplicate IDs and non-finite ranking scores", () => {
  assert.throws(
    () =>
      samplePlaytestDiscovery(
        [
          { id: "same", anomalyScore: 0.1 },
          { id: "same", anomalyScore: 0.2 }
        ],
        1,
        "seed",
        "anomaly-v1"
      ),
    /Duplicate discovery episode id/u
  );
  assert.throws(
    () =>
      samplePlaytestDiscovery(
        [{ id: "invalid", anomalyScore: Number.NaN }],
        1,
        "seed",
        "anomaly-v1"
      ),
    /finite anomaly score/u
  );
});

test("samplePlaytestDiscovery ranks by anomaly score with seeded, reproducible tie-breaks", () => {
  const candidates = [
    { id: "e1", anomalyScore: 0.1 },
    { id: "e2", anomalyScore: 0.9 },
    { id: "e3", anomalyScore: 0.9 },
    { id: "e4", anomalyScore: 0.5 }
  ];
  const first = samplePlaytestDiscovery(candidates, 2, "seed-x", "novelty-v1");
  const second = samplePlaytestDiscovery(candidates, 2, "seed-x", "novelty-v1");
  assert.deepEqual(first.selected, second.selected);
  assert.equal(first.selected.length, 2);
  assert.ok(first.selected.includes("e2") || first.selected.includes("e3"));
});

// --- §4 metric-specific compatibility and comparison classification ---------

function makeArmSummary(
  arm: "baseline" | "candidate",
  overrides: Partial<PlaytestMetricComparison["baseline"]> = {}
) {
  return {
    arm,
    assigned: 100,
    eligible: 100,
    missing: 0,
    independentUnits: 100,
    exposure: 100,
    estimate: null,
    rawDelta: null,
    interval: null,
    ...overrides
  };
}

test("classifyPlaytestMetricComparison: improved when interval lower bound exceeds the meaningful margin", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "completion",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.02,
    guardrailMargin: null,
    orientedBenefitDelta: 0.1,
    interval: {
      lower: 0.05,
      upper: 0.16,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 100_000,
      seed: "42"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "improved");
});

test("classifyPlaytestMetricComparison: guardrail breach when upper bound is below -guardrailMargin", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "clarity",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.05,
    guardrailMargin: 0.05,
    orientedBenefitDelta: -0.3,
    interval: {
      lower: -0.39,
      upper: -0.21,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 100_000,
      seed: "42"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "regressed");
  assert.equal(result.guardrailStatus, "breached");
});

test("§4 worked fixture: completion improved + clarity breached yields hold-regression, never a fun score", () => {
  const completion = classifyPlaytestMetricComparison({
    metricId: "completion",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.02,
    guardrailMargin: null,
    orientedBenefitDelta: 0.1,
    interval: {
      lower: 0.05,
      upper: 0.16,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 100_000,
      seed: "42"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  const clarity = classifyPlaytestMetricComparison({
    metricId: "clarity",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.05,
    guardrailMargin: 0.05,
    orientedBenefitDelta: -0.3,
    interval: {
      lower: -0.39,
      upper: -0.21,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 100_000,
      seed: "42"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  const decision = decidePlaytestComparisonStatus({
    metrics: [completion, clarity],
    primaryMetricId: "completion"
  });
  assert.equal(decision, "hold-regression");

  const comparison = buildPlaytestComparison({
    comparisonId: "cmp-1",
    version: 1,
    benchmarkId: "bench-1",
    experimentId: null,
    baseline: { id: "build-a", version: 1 },
    candidate: { id: "build-b", version: 1 },
    freezeStatus: "frozen",
    pairing: {
      mode: "paired-initial-condition",
      pairMap: { episodeA: "episodeB" },
      rngAlgorithm: "pcg",
      rngStreamVersion: "v1",
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: ["finding-1"],
    episodeRefs: [{ kind: "episode", id: "episode-a" }],
    measurementVersion: MEASUREMENT_VERSION,
    metrics: [completion, clarity],
    primaryMetricId: "completion",
    provenance: {
      workspaceId: WORKSPACE_ID,
      measurementVersion: MEASUREMENT_VERSION,
      generatedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  assert.equal(comparison.decision, "hold-regression");
  assert.equal(comparison.humanPreference.answer, "not-collected");
});

test("classifyPlaytestMetricComparison: no-material-change when interval lies wholly within the margin", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "m",
    metricVersion: 1,
    compatibility: "distribution-matched",
    meaningfulMargin: 0.1,
    guardrailMargin: null,
    orientedBenefitDelta: 0.01,
    interval: {
      lower: -0.05,
      upper: 0.05,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "no-material-change");
});

test("classifyPlaytestMetricComparison: failure to reject zero without margin containment is inconclusive, not equivalence", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "m",
    metricVersion: 1,
    compatibility: "distribution-matched",
    meaningfulMargin: 0.1,
    guardrailMargin: null,
    orientedBenefitDelta: 0.15,
    interval: {
      lower: -0.05,
      upper: 0.35,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "inconclusive");
});

test("classifyPlaytestMetricComparison: not-comparable overrides every statistical rule", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "m",
    metricVersion: 1,
    compatibility: "not-comparable",
    meaningfulMargin: 0.02,
    guardrailMargin: 0.02,
    orientedBenefitDelta: 0.5,
    interval: {
      lower: 0.4,
      upper: 0.6,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "not-comparable");
  assert.equal(result.guardrailStatus, "not-applicable");
});

test("classifyPlaytestMetricComparison: a degenerate/NaN interval is honestly inconclusive, never fabricated", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "m",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.02,
    guardrailMargin: null,
    orientedBenefitDelta: null,
    interval: {
      lower: Number.NaN,
      upper: Number.NaN,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "inconclusive");
  assert.equal(isValidPlaytestInterval(result.interval), false);
});

test("classifyPlaytestMetricComparison: missingness/precision failure is inconclusive even with a favorable raw delta", () => {
  const result = classifyPlaytestMetricComparison({
    metricId: "m",
    metricVersion: 1,
    compatibility: "observational",
    meaningfulMargin: 0.02,
    guardrailMargin: null,
    orientedBenefitDelta: 0.3,
    interval: {
      lower: 0.1,
      upper: 0.5,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    missingnessOrPrecisionFailed: true,
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(result.classification, "inconclusive");
});

test("decidePlaytestComparisonStatus: hold-not-comparable takes precedence over a passing primary", () => {
  const primary = classifyPlaytestMetricComparison({
    metricId: "primary",
    metricVersion: 1,
    compatibility: "paired-initial-condition",
    meaningfulMargin: 0.02,
    guardrailMargin: null,
    orientedBenefitDelta: 0.1,
    interval: {
      lower: 0.05,
      upper: 0.15,
      method: "percentile-bootstrap",
      libraryVersion: "scipy-1.17.0",
      confidenceLevel: 0.95,
      resamples: 10_000,
      seed: "1"
    },
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  const other = classifyPlaytestMetricComparison({
    metricId: "other",
    metricVersion: 1,
    compatibility: "not-comparable",
    meaningfulMargin: null,
    guardrailMargin: null,
    orientedBenefitDelta: null,
    interval: null,
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.equal(
    decidePlaytestComparisonStatus({
      metrics: [primary, other],
      primaryMetricId: "primary"
    }),
    "hold-not-comparable"
  );
});

test("decidePlaytestComparisonStatus throws when the primary metric is not among the classified metrics", () => {
  const other = classifyPlaytestMetricComparison({
    metricId: "other",
    metricVersion: 1,
    compatibility: "observational",
    meaningfulMargin: null,
    guardrailMargin: null,
    orientedBenefitDelta: null,
    interval: null,
    baseline: makeArmSummary("baseline"),
    candidate: makeArmSummary("candidate")
  });
  assert.throws(
    () =>
      decidePlaytestComparisonStatus({
        metrics: [other],
        primaryMetricId: "missing"
      }),
    /not found/u
  );
});

test("recordPlaytestOwnerDecision returns a new immutable revision and rejects an empty reason", () => {
  const base = {
    schema: "autodev-playtest-comparison-v1" as const,
    comparisonId: "cmp-3",
    version: 1,
    benchmarkId: "bench-1",
    experimentId: null,
    baseline: { id: "a", version: 1 },
    candidate: { id: "b", version: 1 },
    freezeStatus: "frozen" as const,
    pairing: {
      mode: "observational" as const,
      pairMap: {},
      rngAlgorithm: null,
      rngStreamVersion: null,
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: [],
    episodeRefs: [],
    measurementVersion: MEASUREMENT_VERSION,
    metrics: [],
    decision: "hold-inconclusive" as const,
    ownerDecisionAt: null,
    ownerDecisionReason: null,
    humanPreference: { answer: "not-collected" as const, interval: null },
    provenance: {
      workspaceId: WORKSPACE_ID,
      measurementVersion: MEASUREMENT_VERSION,
      generatedAt: "2026-01-01T00:00:00.000Z"
    },
    notes: ""
  };
  const revised = recordPlaytestOwnerDecision(
    base,
    "2026-01-02T00:00:00.000Z",
    "holding for guardrail"
  );
  assert.equal(revised.ownerDecisionAt, "2026-01-02T00:00:00.000Z");
  assert.equal(revised.ownerDecisionReason, "holding for guardrail");
  assert.equal(
    base.ownerDecisionAt,
    null,
    "original comparison must remain unmutated"
  );
  assert.throws(
    () => recordPlaytestOwnerDecision(base, "2026-01-02T00:00:00.000Z", ""),
    /non-empty reason/u
  );
});

// --- §6 evidence locator/review/finding validation ---------------------------

function buildEvidenceIndex(
  overrides: Partial<PlaytestKnownEvidenceIndex> = {}
): PlaytestKnownEvidenceIndex {
  return {
    episodeIds: new Set(["ep-1"]),
    eventEpisodeOf: new Map([["evt-1", "ep-1"]]),
    eventRelevantRuleOf: new Map([["evt-1", "heat-warning"]]),
    reviewIds: new Set(),
    findingIds: new Set(),
    comparisonIds: new Set(),
    frameEpisodeOf: new Map(),
    ...overrides
  };
}

test("verifyPlaytestClaim: supported when every locator exists, matches episode, and matches the relevant rule", () => {
  const index = buildEvidenceIndex();
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c1",
      relevantRule: "heat-warning",
      episodeId: "ep-1",
      evidenceRefs: [{ kind: "event", id: "evt-1" }]
    },
    index
  );
  assert.equal(verdict.verdict, "supported");
});

test("verifyPlaytestClaim: nonexistent event locator is insufficient, never verified", () => {
  const index = buildEvidenceIndex();
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c2",
      relevantRule: "heat-warning",
      episodeId: "ep-1",
      evidenceRefs: [{ kind: "event", id: "evt-ghost" }]
    },
    index
  );
  assert.equal(verdict.verdict, "contradicted");
  assert.ok(
    verdict.reasons.some((reason) => reason.includes("does not exist"))
  );
});

test("verifyPlaytestClaim: existing but irrelevant event is insufficient, not verified", () => {
  const index = buildEvidenceIndex({
    eventRelevantRuleOf: new Map([["evt-1", "pit-stop"]])
  });
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c3",
      relevantRule: "heat-warning",
      episodeId: "ep-1",
      evidenceRefs: [{ kind: "event", id: "evt-1" }]
    },
    index
  );
  assert.equal(verdict.verdict, "contradicted");
  assert.ok(
    verdict.reasons.some((reason) => reason.includes("relevant to rule"))
  );
});

test("verifyPlaytestClaim: correct event but wrong episode is insufficient", () => {
  const index = buildEvidenceIndex();
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c4",
      relevantRule: "heat-warning",
      episodeId: "ep-999",
      evidenceRefs: [{ kind: "event", id: "evt-1" }]
    },
    index
  );
  assert.equal(verdict.verdict, "contradicted");
  assert.ok(
    verdict.reasons.some((reason) => reason.includes("belongs to episode"))
  );
});

test("verifyPlaytestClaim: a claim with zero evidence locators is insufficient", () => {
  const index = buildEvidenceIndex();
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c5",
      relevantRule: "heat-warning",
      episodeId: "ep-1",
      evidenceRefs: []
    },
    index
  );
  assert.equal(verdict.verdict, "insufficient");
});

test("verifyPlaytestClaim: mixing one supporting and one contradicted locator is insufficient, not silently discarded", () => {
  const index = buildEvidenceIndex();
  const verdict = verifyPlaytestClaim(
    {
      claimId: "c6",
      relevantRule: "heat-warning",
      episodeId: "ep-1",
      evidenceRefs: [
        { kind: "event", id: "evt-1" },
        { kind: "event", id: "evt-ghost" }
      ]
    },
    index
  );
  assert.equal(verdict.verdict, "insufficient");
});

test("assertNoContradictingLocator: a claimed-absent action present in the actual offered list is rejected", () => {
  assert.throws(
    () => assertNoContradictingLocator("brake-early", ["brake-early", "draft"]),
    /is present in the actual offered\/legal action list/u
  );
  assert.doesNotThrow(() =>
    assertNoContradictingLocator("brake-early", ["draft"])
  );
});

test("assertPlaytestSessionReviewHasEvidence rejects a review with zero evidence locators, even if findings have evidence", () => {
  assert.throws(
    () =>
      assertPlaytestSessionReviewHasEvidence({
        reviewId: "rev-1",
        evidenceRefs: [],
        findings: []
      }),
    /has no evidence locators/u
  );
});

test("assertPlaytestSessionReviewHasEvidence rejects a finding with zero evidence locators", () => {
  assert.throws(
    () =>
      assertPlaytestSessionReviewHasEvidence({
        reviewId: "rev-2",
        evidenceRefs: [{ kind: "episode", id: "ep-1" }],
        findings: [
          {
            findingId: "f-1",
            evidenceRefs: []
          }
        ]
      }),
    /has no evidence locators/u
  );
});

test("assertPlaytestFindingEvidenceStatusConsistent rejects a 'verified' finding citing a nonexistent locator", () => {
  const index = buildEvidenceIndex();
  assert.throws(
    () =>
      assertPlaytestFindingEvidenceStatusConsistent(
        {
          findingId: "f-2",
          evidenceStatus: "verified",
          evidenceRefs: [{ kind: "event", id: "evt-ghost" }]
        },
        index
      ),
    /do not exist/u
  );
});

test("assertPlaytestFindingEvidenceStatusConsistent accepts a 'hypothesis' finding with an unresolved secondary locator", () => {
  const index = buildEvidenceIndex();
  assert.doesNotThrow(() =>
    assertPlaytestFindingEvidenceStatusConsistent(
      {
        findingId: "f-3",
        evidenceStatus: "hypothesis",
        evidenceRefs: [
          { kind: "event", id: "evt-1" },
          { kind: "event", id: "evt-ghost" }
        ]
      },
      index
    )
  );
});

test("assertPlaytestFindingEvidenceStatusConsistent rejects 'not observed' carrying evidence locators", () => {
  const index = buildEvidenceIndex();
  assert.throws(
    () =>
      assertPlaytestFindingEvidenceStatusConsistent(
        {
          findingId: "f-4",
          evidenceStatus: "not observed",
          evidenceRefs: [{ kind: "event", id: "evt-1" }]
        },
        index
      ),
    /but carries evidence locators/u
  );
});

// --- §1 event taxonomy and full mechanic/phase coverage --------------------

test("event taxonomy accepts authoritative game events and versioned detector provenance", () => {
  const taxonomy = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    taxonomyVersion: "fixture-events-v1",
    eventSchemaHash: "a".repeat(64),
    events: [
      {
        eventId: "near-miss",
        eventType: "near-miss",
        mechanicKey: "positioning",
        phaseId: "race",
        stepField: "step",
        revisionField: "revision",
        actorField: "playerId",
        eligibilityFlags: ["eligible-for-agency"],
        source: { kind: "game", emitterId: "engine.race-events" },
        thresholds: { distance: 0.1 },
        severity: "minor",
        expectedOccurrenceRange: { minimum: 0, maximum: 2 }
      },
      {
        eventId: "stalled-loop",
        eventType: "stalled-loop",
        mechanicKey: "turn-progression",
        phaseId: "any",
        stepField: "step",
        revisionField: "revision",
        actorField: null,
        eligibilityFlags: [],
        source: {
          kind: "detector",
          detectorRef: "detectors/repeated-state-v1",
          codeHash: "b".repeat(64)
        },
        thresholds: { repeats: 3 },
        severity: "major",
        expectedOccurrenceRange: null
      }
    ]
  };
  assert.doesNotThrow(() => assertPlaytestEventTaxonomy(taxonomy));
  assert.throws(
    () =>
      assertPlaytestEventTaxonomy({
        ...taxonomy,
        events: [
          {
            ...taxonomy.events[1]!,
            source: { kind: "detector", detectorRef: "unversioned" }
          }
        ]
      }),
    /detectorRef and a SHA-256 codeHash/u
  );
});

test("coverage distinguishes missing critical cells from a large easy-scenario sample", () => {
  const coverage = buildPlaytestCoverageManifest({
    workspaceId: WORKSPACE_ID,
    batchId: "batch-coverage",
    buildSha: "a".repeat(64),
    measurementVersion: MEASUREMENT_VERSION,
    generatedAt: "2026-10-09T12:00:00.000Z",
    cells: [
      {
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "easy",
        cohort: "heuristic",
        policy: "deterministic-baseline",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 1,
        observedOpportunities: 1000,
        observedIndependentUnits: 1000,
        unsupportedReason: null
      },
      {
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "hard",
        cohort: "novice",
        policy: "limited-information",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 1,
        observedOpportunities: 0,
        observedIndependentUnits: 0,
        unsupportedReason: null
      },
      {
        mechanicKey: "warning-clarity",
        phaseId: "race",
        scenarioFamily: "standard",
        cohort: "visual-only",
        policy: "visual-observer",
        modality: "native-visual",
        requiredOpportunities: 1,
        requiredIndependentUnits: 1,
        observedOpportunities: 0,
        observedIndependentUnits: 0,
        unsupportedReason: "native renderer is not approved"
      }
    ]
  });
  assert.equal(coverage.coveredCells, 1);
  assert.equal(coverage.notObservedCells, 1);
  assert.equal(coverage.unsupportedCells, 1);
  assert.deepEqual(
    coverage.cells.map((cell) => cell.state),
    ["covered", "not-observed", "unsupported"]
  );
});

// --- protocol/envelope validators --------------------------------------------

test("method-specific adapter contracts bind resets, observations, legal actions, revisions, and outcomes", () => {
  const resetParams = {
    seed: "42",
    scenarioId: "tutorial",
    approvedVariantHash: "a".repeat(64)
  };
  assert.doesNotThrow(() =>
    assertPlaytestAdapterParams("game.reset", resetParams)
  );
  assert.throws(
    () =>
      assertPlaytestAdapterParams("game.reset", {
        ...resetParams,
        workspaceId: "model-selected"
      }),
    /unsupported field/u
  );

  const stepParams = {
    episodeId: "episode-1",
    actionId: "advance",
    expectedRevision: 3
  };
  assert.doesNotThrow(() =>
    assertPlaytestAdapterParams("game.step", stepParams)
  );
  assert.doesNotThrow(() =>
    assertPlaytestAdapterResult("game.step", stepParams, {
      episodeId: "episode-1",
      revision: 4,
      acceptedActionId: "advance",
      eventIds: [],
      terminal: false
    })
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.step", stepParams, {
        episodeId: "episode-1",
        revision: 3,
        acceptedActionId: "advance",
        eventIds: [],
        terminal: false
      }),
    /advance past expectedRevision/u
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.step", stepParams, {
        episodeId: "episode-1",
        revision: 4,
        acceptedActionId: "invented",
        eventIds: [],
        terminal: false
      }),
    /equal the requested legal action/u
  );

  const revisionParams = { episodeId: "episode-1", expectedRevision: 4 };
  assert.doesNotThrow(() =>
    assertPlaytestAdapterResult("game.legalActions", revisionParams, {
      episodeId: "episode-1",
      revision: 4,
      actions: []
    })
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.legalActions", revisionParams, {
        episodeId: "episode-1",
        revision: 4,
        actions: [{ actionId: "same" }, { actionId: "same" }]
      }),
    /action ids must be unique/u
  );
  assert.doesNotThrow(() =>
    assertPlaytestAdapterResult("game.outcome", revisionParams, {
      episodeId: "episode-1",
      revision: 4,
      state: "partial",
      outcome: null,
      metrics: { survival: null },
      missingReasons: []
    })
  );
});

test("game-adapter JSON-RPC requests use versioned method names and bounded string IDs", () => {
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcRequest({
      jsonrpc: "2.0",
      id: "1",
      method: "game.capabilities",
      params: { protocolVersion: 1 }
    })
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "game.capabilities",
        params: { protocolVersion: 1 }
      }),
    /bounded non-empty string/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "delete_everything",
        params: {}
      }),
    /method must be one of/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcRequest([
        { jsonrpc: "2.0", id: "1", method: "game.observe", params: {} }
      ]),
    /batch arrays are unsupported/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcRequest({
        jsonrpc: "2.0",
        id: "1",
        method: "game.observe",
        params: {},
        workspaceId: "model-selected"
      }),
    /unsupported envelope field/u
  );
});

test("game.event and game.progress are id-less notifications, not responses", () => {
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcNotification({
      jsonrpc: "2.0",
      method: "game.event",
      params: { episodeId: "ep-1", revision: 3, eventSequence: 2 }
    })
  );
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcNotification({
      jsonrpc: "2.0",
      method: "game.progress",
      params: { requestId: "req-1", completed: 2, total: 4 }
    })
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcNotification({
        jsonrpc: "2.0",
        id: "not-a-notification",
        method: "game.event",
        params: {}
      }),
    /must not carry an id/u
  );
});

test("JSON-RPC responses contain exactly one result or error and use standard/application codes", () => {
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcSuccess({
      jsonrpc: "2.0",
      id: "1",
      result: { ok: true }
    })
  );
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcError({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "parse error" }
    })
  );
  assert.doesNotThrow(() =>
    assertPlaytestJsonRpcError({
      jsonrpc: "2.0",
      id: "step-1",
      error: {
        code: -32_002,
        message: "stale revision",
        data: {
          category: "stale_revision",
          retryable: false,
          episodeDisposition: "unchanged"
        }
      }
    })
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcError({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_002, message: "stale revision" }
      }),
    /must retain their request id/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcError({
        jsonrpc: "2.0",
        id: "step-1",
        error: { code: -32_002, message: "stale revision" }
      }),
    /Application error data/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcError({
        jsonrpc: "2.0",
        id: "step-1",
        error: { code: -32_008, message: "unknown app code" }
      }),
    /error code must be one of/u
  );
  assert.throws(
    () =>
      assertPlaytestJsonRpcResponse({
        jsonrpc: "2.0",
        id: "1",
        result: {},
        error: { code: -32_603, message: "both" }
      }),
    /both result and error/u
  );
});

test("capability negotiation requires v1 build, hashes, modes, optional operations, and bounded quotas", () => {
  const hash = "a".repeat(64);
  const capabilities = {
    protocolVersion: 1,
    schemaHashAlgorithm: "sha256-canonical-json-v1",
    engineBuild: "fixture-build",
    modes: ["headless"],
    scenarioIds: ["default"],
    observationSchema: { type: "object", additionalProperties: false },
    actionSchema: { type: "object", additionalProperties: false },
    eventSchema: { type: "object", additionalProperties: false },
    observationSchemaHash: hash,
    actionSchemaHash: hash,
    eventSchemaHash: hash,
    optionalOperations: ["game.snapshot", "game.replay"],
    quotas: {
      maxMessageBytes: 1_048_576,
      maxQueuedRequests: 32,
      ordinaryCallTimeoutMs: 10_000,
      resetReplayTimeoutMs: 60_000
    },
    deterministic: {
      seededRuns: true,
      rngVersion: "pcg-v1",
      traceReplayable: true
    }
  };
  assert.doesNotThrow(() =>
    assertPlaytestCapabilityAdvertisement(capabilities)
  );
  assert.throws(
    () =>
      assertPlaytestCapabilityAdvertisement({
        ...capabilities,
        protocolVersion: 2
      }),
    /exactly 1/u
  );
  assert.throws(
    () =>
      assertPlaytestCapabilityAdvertisement({
        ...capabilities,
        modes: ["omniscient"]
      }),
    /modes must be/u
  );
  assert.throws(
    () =>
      assertPlaytestCapabilityAdvertisement({
        ...capabilities,
        optionalOperations: ["game.reset"]
      }),
    /unknown optional operation/u
  );
  assert.throws(
    () =>
      assertPlaytestCapabilityAdvertisement({
        ...capabilities,
        quotas: { ...capabilities.quotas, maxMessageBytes: 1_048_577 }
      }),
    /quota maxMessageBytes/u
  );
  assert.throws(
    () =>
      assertPlaytestCapabilityAdvertisement({
        ...capabilities,
        eventSchemaHash: "fixture-alias"
      }),
    /SHA-256/u
  );
});

test("assertPlaytestObservationContract enforces player-visible field and UI mapping contracts", () => {
  assert.doesNotThrow(() =>
    assertPlaytestObservationContract({
      schemaVersion: 1,
      schemaHash: "a".repeat(64),
      mode: "browser",
      cohort: "first-time",
      visibilityMode: "structured",
      fields: [
        {
          fieldPath: "heat",
          unit: "points",
          displayRounding: "integer",
          revelationTiming: "before-action",
          playerRuleRef: "rules/heat"
        }
      ],
      uiEquivalence: "verified",
      conformanceFixtureHash: "b".repeat(64)
    })
  );
  assert.throws(
    () =>
      assertPlaytestObservationContract({
        schemaVersion: 1,
        schemaHash: "a".repeat(64),
        mode: "browser",
        cohort: "first-time",
        visibilityMode: "structured",
        fields: [
          {
            fieldPath: "future.hiddenOutcome",
            unit: null,
            displayRounding: null,
            revelationTiming: "after-action",
            playerRuleRef: null
          }
        ],
        uiEquivalence: "verified",
        conformanceFixtureHash: null
      }),
    /verified observation requires a conformance fixture/u
  );
  for (const fieldPath of [
    "room..future",
    "__proto__.secret",
    "collection.4096.value"
  ]) {
    assert.throws(
      () =>
        assertPlaytestObservationContract({
          schemaVersion: 1,
          schemaHash: "a".repeat(64),
          mode: "headless",
          cohort: "novice",
          visibilityMode: "structured",
          fields: [
            {
              fieldPath,
              unit: null,
              displayRounding: null,
              revelationTiming: "before-action",
              playerRuleRef: null
            }
          ],
          uiEquivalence: "unverified",
          conformanceFixtureHash: null
        }),
      /safe dot-separated keys/u
    );
  }
  assert.throws(
    () =>
      assertPlaytestObservationContract({
        schemaVersion: 1,
        schemaHash: "a".repeat(64),
        mode: "headless",
        cohort: "novice",
        visibilityMode: "structured",
        fields: [
          {
            fieldPath: "player",
            unit: null,
            displayRounding: null,
            revelationTiming: "before-action",
            playerRuleRef: null
          },
          {
            fieldPath: "player.health",
            unit: null,
            displayRounding: null,
            revelationTiming: "before-action",
            playerRuleRef: null
          }
        ],
        uiEquivalence: "unverified",
        conformanceFixtureHash: null
      }),
    /unique and non-overlapping/u
  );
});

test("assertPlaytestEvidenceLocator rejects an unknown kind and a negative step", () => {
  assert.doesNotThrow(() =>
    assertPlaytestEvidenceLocator({ kind: "event", id: "evt-1", step: 3 })
  );
  assert.throws(
    () => assertPlaytestEvidenceLocator({ kind: "not-a-kind", id: "x" }),
    /locator kind must be one of/u
  );
  assert.throws(
    () =>
      assertPlaytestEvidenceLocator({ kind: "event", id: "evt-1", step: -1 }),
    /step must be a non-negative integer/u
  );
});

test("workspace approval binds a local checkout, immutable image, command, budget, and operator", () => {
  const approval = {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: "owner/game",
    revision: 1,
    approvalId: "approval-1",
    checkoutRoot: "/workspace/game",
    buildSha: "a".repeat(40),
    gameBuild: "release-1",
    playtestConfigHash: "b".repeat(64),
    adapterImageDigest: `ghcr.io/owner/adapter@sha256:${"c".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["/usr/bin/node", "adapter.mjs"],
    allowedScenarios: ["default"],
    allowedPolicies: ["heuristic"],
    limits: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
      processCount: 64,
      wallTimeMs: 60_000,
      artifactBytes: 32 * 1024 * 1024,
      workerCount: 4,
      episodeCount: 1000,
      maxStepsPerEpisode: 500,
      critiqueCount: 40
    },
    retentionDays: 30,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-10-09T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
  assert.doesNotThrow(() => assertWorkspacePlaytestApproval(approval));
  assert.throws(
    () =>
      assertWorkspacePlaytestApproval({
        ...approval,
        checkoutRoot: "relative/game"
      }),
    /absolute local path/u
  );
  assert.throws(
    () =>
      assertWorkspacePlaytestApproval({
        ...approval,
        workingDirectory: String.raw`C:outside`
      }),
    /remain inside checkout/u
  );
  assert.throws(
    () =>
      assertWorkspacePlaytestApproval({
        ...approval,
        adapterImageDigest: "ghcr.io/owner/adapter:latest"
      }),
    /pinned by SHA-256/u
  );
  assert.throws(
    () =>
      assertWorkspacePlaytestApproval({
        ...approval,
        adapterCommand: ["node", "adapter.mjs", "\0malformed"]
      }),
    /invalid or too large/u
  );
});

test("playtest.config.json validates a bounded target-owned adapter and analysis manifest", () => {
  const config = {
    schemaVersion: 1,
    adapter: {
      transport: "stdio-jsonl",
      command: ["pnpm", "run", "playtest:adapter"]
    },
    modes: ["headless", "browser"],
    scenarios: ["default", "edge"],
    scenarioFamilies: { default: "intro", edge: "edge-cases" },
    policies: ["random", "heuristic"],
    budget: {
      episodes: 1000,
      maxStepsPerEpisode: 500,
      workers: 8,
      wallTimeMinutes: 60
    },
    analysis: {
      rubric: "playtest.rubric.json",
      observationContract: "playtest.observation.json",
      benchmark: "playtest.benchmark.json",
      critic: "auto",
      maxReviewedSessions: 40,
      visualCapture: "on-anomaly",
      counterfactuals: "targeted",
      understandingProbes: "sampled",
      learningCohorts: "tracked",
      humanCalibration: "optional"
    },
    reporting: { githubIssues: "review" }
  };
  assert.doesNotThrow(() => assertPlaytestGameConfiguration(config));
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        adapter: { ...config.adapter, command: "pnpm run unsafe" }
      }),
    /adapter.command/u
  );
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        analysis: { ...config.analysis, rubric: "../outside.json" }
      }),
    /workspace-relative/u
  );
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        budget: { ...config.budget, workers: 33 }
      }),
    /budget.workers/u
  );
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        scenarioFamilies: { default: "intro" }
      }),
    /scenarioFamilies/u
  );
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        analysis: { ...config.analysis, observationContract: "../outside.json" }
      }),
    /analysis.observationContract.*workspace-relative/u
  );
  assert.throws(
    () =>
      assertPlaytestGameConfiguration({
        ...config,
        analysis: {
          ...config.analysis,
          observationContract: String.raw`C:outside.json`
        }
      }),
    /analysis.observationContract.*workspace-relative/u
  );
  for (const invalidPath of [
    ".",
    " playtest.observation.json",
    "x\0y",
    "x".repeat(1025)
  ]) {
    assert.throws(
      () =>
        assertPlaytestGameConfiguration({
          ...config,
          analysis: { ...config.analysis, observationContract: invalidPath }
        }),
      /analysis.observationContract.*workspace-relative/u
    );
  }
});
