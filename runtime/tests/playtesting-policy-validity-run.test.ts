/**
 * `derivePlaytestPolicyValidity`: §6's artifact produced from a real run.
 *
 * The coverage manifest here is built by Core's real coverage computation from
 * real assignments and episodes rather than hand-written, because the whole
 * claim under test is that the derivation reports what the run actually
 * observed. A hand-written manifest would let this file agree with itself.
 *
 * Every competence metric is asserted `null` on purpose. That is the load-bearing
 * part of the design: the metrics compare a policy with a person, and this run
 * measured no person. The last test is a positive control proving the `null`s
 * are what withhold authorization — with fabricated metrics the very same
 * bounds do produce `passed`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestEvidenceLocator,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestPolicyValidity,
  defaultPlaytestRegistryDefaults,
  expandPlaytestRegistry,
  type PlaytestAdapterAssignmentManifest,
  playtestAssignmentManifestHashInput,
  type PlaytestBatch,
  type PlaytestBatchAssignment,
  type PlaytestCoverageEpisode,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  playtestCoveragePlanForRegistry,
  type PlaytestMetricRegistry,
  type PlaytestPolicyCompetenceBounds,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION
} from "@simulatorlife/autodev-core";

import { derivePlaytestPolicyValidity } from "../src/playtesting/policy-validity-run.ts";

const WORKSPACE_ID = "owner/policy-validity-fixture";
const BATCH_ID = "batch-policy-validity";
const BUILD_SHA = "a".repeat(40);
const RUBRIC_HASH = "b".repeat(64);
const ASSIGNMENT_HASH = "c".repeat(64);
const CREATED_AT = "2026-10-12T00:00:00.000Z";

/**
 * Four cells, one per situation this module has to tell apart:
 *
 * - `heuristic`/`novice` — observed with real opportunities;
 * - `tactical-policy`/`novice` — observed, so ordering has two records to sort;
 * - `zero-policy`/`zero-cohort` — assigned and observed, but the adapter emits
 *   no authoritative event, so nothing was ever eligible to measure;
 * - `unstarted-policy`/`novice` — planned, never assigned.
 */
function registry(): PlaytestMetricRegistry {
  return expandPlaytestRegistry({
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    audience: "fixture-player",
    registryVersion: "policy-validity-v1",
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
        phaseId: "cooldown",
        scenarioFamily: "easy-family",
        cohort: "novice",
        policy: "tactical-policy",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 10,
        unsupportedReason: null
      },
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "zero-family",
        cohort: "zero-cohort",
        policy: "zero-policy",
        modality: "headless",
        requiredOpportunities: 0,
        requiredIndependentUnits: 0,
        unsupportedReason: "fixture adapter emits no authoritative event"
      },
      {
        coverageMetricId: "decision-rate",
        mechanicKey: "pit-strategy",
        phaseId: "race",
        scenarioFamily: "easy-family",
        cohort: "novice",
        policy: "unstarted-policy",
        modality: "headless",
        requiredOpportunities: 10,
        requiredIndependentUnits: 10,
        unsupportedReason: null
      }
    ],
    dimensionRubrics: []
  });
}

function assignment(
  overrides: Partial<PlaytestBatchAssignment>
): PlaytestBatchAssignment {
  return {
    assignmentId: "a-1",
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
  opportunities: number
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
        phaseId: run.policyId === "tactical-policy" ? "cooldown" : "race",
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
          measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
          generatedAt: CREATED_AT
        },
        notes: "fixture"
      }
    ],
    episodeId
  } as PlaytestCoverageEpisode;
}

const RUNS: readonly PlaytestBatchAssignment[] = [
  assignment({ assignmentId: "a-1", seed: "s1" }),
  assignment({
    assignmentId: "a-2",
    policyId: "tactical-policy",
    policyVersion: "tactical-v1",
    seed: "s2"
  }),
  assignment({
    assignmentId: "a-3",
    scenarioId: "hard",
    scenarioFamily: "zero-family",
    policyId: "zero-policy",
    policyVersion: "zero-v1",
    cohort: "zero-cohort",
    seed: "s3"
  })
];

function coverageManifest(): PlaytestCoverageManifest {
  const draft = buildPlaytestCoverageManifestDraft({
    rubricHash: RUBRIC_HASH,
    assignmentManifestHash: ASSIGNMENT_HASH,
    mode: "headless",
    generatedAt: CREATED_AT,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    plan: playtestCoveragePlanForRegistry(registry()),
    assignments: RUNS,
    episodes: [
      // Two of four opportunities observed for `heuristic`, so coverage is a
      // real fraction rather than a convenient 1.
      episodeFor(RUNS[0]!, "ep-1", 4),
      episodeFor(RUNS[1]!, "ep-2", 6),
      episodeFor(RUNS[2]!, "ep-3", 3)
    ]
  });
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
}

const POLICY_VERSIONS: Readonly<Record<string, string>> = {
  heuristic: "heuristic-v1",
  "tactical-policy": "tactical-v1",
  "zero-policy": "zero-v1"
};

/** A real content-hashed assignment manifest; a cast would hide a field rename. */
function assignmentManifest(): PlaytestAdapterAssignmentManifest {
  const base = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "adapter-accelerated" as const,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    configHash: "f".repeat(64),
    rubricHash: RUBRIC_HASH,
    approvalRevision: 1,
    createdAt: CREATED_AT,
    assignments: [...RUNS]
  };
  return {
    ...base,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(base))
      .digest("hex")
  };
}

function batch(overrides: Partial<PlaytestBatch> = {}): PlaytestBatch {
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    executionMode: "adapter-accelerated",
    batchId: BATCH_ID,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    gameBuild: "fixture-game-build-1",
    configHash: "f".repeat(64),
    rubricHash: RUBRIC_HASH,
    actionSchemaHash: "1".repeat(64),
    observationSchemaHash: "2".repeat(64),
    eventSchemaHash: "3".repeat(64),
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: ["heuristic", "tactical-policy", "zero-policy"],
    cohortIds: ["novice", "zero-cohort"],
    scenarioIds: ["easy", "hard"],
    assignmentInventory: { status: "frozen", manifest: assignmentManifest() },
    coverageManifest: coverageManifest(),
    unobservedAssignments: [],
    reviewPackets: [],
    reviewSelection: { status: "pending" },
    reviewReceipts: [],
    status: "completed",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 3,
      started: 3,
      completed: 3,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 3
    },
    budget: {
      assignedEpisodes: 3,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      critiqueBudget: 4,
      actualCritiques: 0
    },
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    createdAt: CREATED_AT,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: CREATED_AT
    },
    evaluationIds: [],
    spanIds: [],
    ...overrides
  } as PlaytestBatch;
}

const BOUNDS: PlaytestPolicyCompetenceBounds = {
  minLegalityRate: 0.9,
  minRepeatability: 0.9,
  minActionAgreement: 0.9,
  maxDistributionDivergence: 0.1,
  minCoverage: 0.5
};

test("derives an unvalidated-synthetic record from what the run actually observed", () => {
  const { records, unmeasurable } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });

  const heuristic = records.find(
    (record) => record.validity.policyId === "heuristic"
  );
  assert.ok(heuristic, "the observed policy produced a record");

  // The real coverage computation observed 4 of 4 eligible opportunities.
  assert.equal(heuristic.validity.competence, "unvalidated-synthetic");
  assert.equal(heuristic.validity.coverage, 1);
  assert.equal(heuristic.observedOpportunities, 4);
  assert.equal(heuristic.eligibleOpportunities, 4);
  assert.equal(heuristic.observedEpisodes, 1);

  // Identity comes from the batch that ran, not from the caller.
  assert.equal(heuristic.validity.workspaceId, WORKSPACE_ID);
  assert.equal(heuristic.validity.buildSha, BUILD_SHA);
  assert.equal(heuristic.validity.cohortId, "novice");
  assert.equal(heuristic.validity.policyVersion, "heuristic-v1");
  assert.equal(heuristic.validity.observationSchemaHash, "2".repeat(64));
  assert.equal(heuristic.validity.actionSchemaHash, "1".repeat(64));

  // No human data means no held-out states and no measured comparison.
  assert.deepEqual(heuristic.validity.heldOutHumanStateIds, []);
  assert.equal(heuristic.validity.legalityRate, null);
  assert.equal(heuristic.validity.repeatability, null);
  assert.equal(heuristic.validity.actionAgreement, null);
  assert.equal(heuristic.validity.distributionDivergence, null);
  assert.equal(heuristic.validity.interval, null);

  // §6's downgrade travels with the record rather than being left implicit.
  assert.ok(heuristic.humanProxyRefusal);
  assert.match(heuristic.humanProxyRefusal, /synthetic cohort/);
  assert.match(heuristic.humanProxyRefusal, /model-specific signal/);

  assert.ok(
    unmeasurable.some(
      (cell) =>
        cell.policyId === "unstarted-policy" &&
        cell.reason === "no-observed-episodes"
    )
  );
});

test("a cell with nothing eligible is named rather than scored as zero coverage", () => {
  const { records, unmeasurable } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });

  // `zero-policy` ran an episode but the metric never had an eligible
  // opportunity. Coverage here would be 0/0, and 0 would assert the policy was
  // observed and never behaved.
  assert.equal(
    records.some((record) => record.validity.policyId === "zero-policy"),
    false
  );
  const zero = unmeasurable.find((cell) => cell.policyId === "zero-policy");
  assert.ok(zero, "the unmeasurable cell is named");
  assert.equal(zero.reason, "no-eligible-opportunities");
  assert.equal(zero.policyVersion, "zero-v1");
});

test("an undeclared policy version is named rather than guessed", () => {
  const { records, unmeasurable } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: { "tactical-policy": "tactical-v1" },
    createdAt: CREATED_AT
  });

  assert.equal(
    records.some((record) => record.validity.policyId === "heuristic"),
    false
  );
  const missing = unmeasurable.find((cell) => cell.policyId === "heuristic");
  assert.ok(missing);
  assert.equal(missing.reason, "policy-version-undeclared");
  assert.equal(missing.policyVersion, null);
});

test("a batch that never negotiated schemas names why it cannot be scored", () => {
  const { records, unmeasurable } = derivePlaytestPolicyValidity({
    batch: batch({ actionSchemaHash: null }),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });

  assert.equal(records.length, 0);
  assert.ok(unmeasurable.length > 0);
  for (const cell of unmeasurable) {
    assert.equal(cell.reason, "schema-hashes-unavailable");
  }
});

test("a batch with no frozen coverage manifest produces no records", () => {
  const { records, unmeasurable } = derivePlaytestPolicyValidity({
    batch: batch({ coverageManifest: null }),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });

  // Nothing recorded what this batch observed, so there is no cell to name and
  // no basis to report. The tool surfaces the missing manifest itself.
  assert.deepEqual(records, []);
  assert.deepEqual(unmeasurable, []);
});

test("preregistered bounds and held-out states still cannot pass on unmeasured metrics", () => {
  const { records } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    preregistration: {
      heldOutHumanStateIdsByPolicyId: { heuristic: ["human-state-1"] },
      boundsByPolicyId: { heuristic: BOUNDS }
    },
    createdAt: CREATED_AT
  });

  const heuristic = records.find(
    (record) => record.validity.policyId === "heuristic"
  );
  assert.ok(heuristic);
  assert.deepEqual(heuristic.validity.heldOutHumanStateIds, ["human-state-1"]);
  // Bounds exist and human states exist, but nothing was measured against
  // them, so the criteria could not be applied.
  assert.equal(heuristic.validity.competence, "insufficient");
  assert.match(heuristic.humanProxyRefusal ?? "", /never measured/);
});

test("positive control: those same bounds do pass once metrics are measured", () => {
  // Proves the previous test's `insufficient` is caused by the unmeasured
  // metrics rather than by a rule that refuses to pass anything.
  const permissive: PlaytestPolicyCompetenceBounds = {
    minLegalityRate: 0,
    minRepeatability: 0,
    minActionAgreement: 0,
    maxDistributionDivergence: 1,
    minCoverage: 0
  };
  const validity = buildPlaytestPolicyValidity({
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    cohortId: "novice",
    observationSchemaHash: "2".repeat(64),
    actionSchemaHash: "1".repeat(64),
    policyId: "heuristic",
    policyVersion: "heuristic-v1",
    heldOutHumanStateIds: ["human-state-1"],
    bounds: permissive,
    legalityRate: 1,
    repeatability: 1,
    actionAgreement: 1,
    distributionDivergence: 0,
    coverage: 1,
    failureModes: [],
    interval: null,
    createdAt: CREATED_AT
  });

  assert.equal(validity.competence, "passed");
});

test("records are returned in a stable order regardless of input order", () => {
  const { records } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });

  const ordered = records.map(
    (record) => `${record.validity.policyId}/${record.validity.cohortId}`
  );
  assert.deepEqual(ordered, [...ordered].sort());
  assert.deepEqual(ordered, ["heuristic/novice", "tactical-policy/novice"]);

  // The manifest lists `heuristic` first; reversing the batch's declared ids
  // must not reorder the derivation, which reads the manifest's own cells.
  const second = derivePlaytestPolicyValidity({
    batch: batch({ policyIds: [...batch().policyIds].reverse() }),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });
  assert.deepEqual(
    second.records.map((record) => record.validity.policyId),
    records.map((record) => record.validity.policyId)
  );
});

test("each record carries a citable identity a benchmark can attest to", () => {
  const { records } = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });
  const heuristic = records.find(
    (record) => record.validity.policyId === "heuristic"
  );
  assert.ok(heuristic);

  // Content-addressed, so a citation cannot keep answering for a record that
  // has since changed.
  assert.match(heuristic.validityId, /^[a-f\d]{64}$/u);
  assert.deepEqual(heuristic.locator, {
    kind: "policy-validity",
    id: heuristic.validityId
  });
  // The citation must satisfy the same closed vocabulary as every other
  // evidence locator, or a benchmark would refuse to store it.
  assert.doesNotThrow(() => assertPlaytestEvidenceLocator(heuristic.locator));

  // Same run, same identity: the id is derived, not generated per call.
  const again = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });
  assert.equal(
    again.records.find((r) => r.validity.policyId === "heuristic")?.validityId,
    heuristic.validityId
  );
});

test("a different verdict is a different identity", () => {
  const synthetic = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    createdAt: CREATED_AT
  });
  const preregistered = derivePlaytestPolicyValidity({
    batch: batch(),
    policyVersions: POLICY_VERSIONS,
    preregistration: {
      heldOutHumanStateIdsByPolicyId: { heuristic: ["human-state-1"] },
      boundsByPolicyId: { heuristic: BOUNDS }
    },
    createdAt: CREATED_AT
  });

  const before = synthetic.records.find(
    (r) => r.validity.policyId === "heuristic"
  );
  const after = preregistered.records.find(
    (r) => r.validity.policyId === "heuristic"
  );
  assert.ok(before && after);
  assert.equal(before.validity.competence, "unvalidated-synthetic");
  assert.equal(after.validity.competence, "insufficient");
  // Otherwise the earlier citation would still read as current.
  assert.notEqual(after.validityId, before.validityId);
});
