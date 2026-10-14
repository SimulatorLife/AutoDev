import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestAssignmentManifest,
  assertPlaytestAssignmentsMatchBenchmark,
  assertPlaytestBatchAssignments,
  type PlaytestAssignmentManifest,
  playtestAssignmentManifestHashInput,
  playtestAssignmentStrataLowerBound,
  type PlaytestBatchAssignment,
  playtestBatchCountsFromAssignments,
  playtestBatchTerminalState,
  type PlaytestDiscoverySignal,
  type PlaytestReviewCandidate,
  playtestReviewSelectionSeed,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  selectPlaytestBatchReviews
} from "../src/playtesting/index.ts";

function assignment(
  overrides: Partial<PlaytestBatchAssignment> = {}
): PlaytestBatchAssignment {
  return {
    assignmentId: "a-1",
    scenarioId: "tutorial",
    scenarioFamily: "onboarding",
    policyId: "random",
    policyVersion: "v1",
    seed: "seed-1",
    maxSteps: 20,
    ...overrides,
    cohort: overrides.cohort === undefined ? "exploratory" : overrides.cohort
  };
}

function manifest(
  assignments: readonly PlaytestBatchAssignment[]
): PlaytestAssignmentManifest {
  const base = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    batchId: "batch-fixture-1",
    workspaceId: "owner/game",
    buildSha: "a".repeat(40),
    configHash: "b".repeat(64),
    rubricHash: "c".repeat(64),
    approvalRevision: 3,
    createdAt: "2026-10-11T00:00:00.000Z",
    assignments
  } as const;
  return {
    ...base,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(base))
      .digest("hex")
  };
}

const SIGNAL: PlaytestDiscoverySignal = {
  metricId: "legal-action-rejection",
  version: 1,
  direction: "higher-first"
};

function candidate(
  overrides: Partial<PlaytestReviewCandidate> & { assignmentId: string }
): PlaytestReviewCandidate {
  return {
    episodeId: "ep-" + overrides.assignmentId,
    policyId: "random",
    scenarioId: "tutorial",
    outcomeKey: "completed:win",
    metrics: [],
    ...overrides
  };
}

function metric(metricId: string, version: number, estimate: number | null) {
  return {
    metricId,
    metricVersion: version,
    phaseId: null,
    numerator: estimate === null ? 0 : 1,
    denominator: estimate === null ? 0 : 1,
    opportunityCount: 1,
    coverage: estimate === null ? 0 : 1,
    unit: "count",
    estimate,
    missing: estimate === null ? 1 : 0,
    missingReasons: [],
    independentUnits: 1,
    provenance: {
      workspaceId: "owner/game",
      buildSha: "a".repeat(40),
      measurementVersion: "autodev-playtest-measurement-v1",
      generatedAt: "2026-10-11T00:00:00.000Z"
    },
    notes: ""
  } as const;
}

test("batch assignment validation rejects duplicates, malformed and oversized inventories", () => {
  assert.throws(() => assertPlaytestBatchAssignments([]), /between 1 and 1000/);
  assert.throws(
    () =>
      assertPlaytestBatchAssignments(
        Array.from(
          { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS + 1 },
          (_, index) => assignment({ assignmentId: "a-" + String(index) })
        )
      ),
    /between 1 and 1000/
  );
  assert.throws(
    () =>
      assertPlaytestBatchAssignments([
        assignment({ assignmentId: "a-1" }),
        assignment({ assignmentId: "a-1", seed: "seed-2" })
      ]),
    /Duplicate playtest assignment id/
  );
  assert.throws(
    () =>
      assertPlaytestBatchAssignments([
        assignment({ assignmentId: "a-1" }),
        assignment({ assignmentId: "a-2" })
      ]),
    /Duplicate playtest assignment content/
  );
  assert.throws(
    () => assertPlaytestBatchAssignments([assignment({ maxSteps: 0 })]),
    /malformed/
  );
  // Repeated seed text across policies/scenarios is a legitimate paired design.
  assert.doesNotThrow(() =>
    assertPlaytestBatchAssignments([
      assignment({ assignmentId: "a-1", policyId: "random" }),
      assignment({ assignmentId: "a-2", policyId: "heuristic" }),
      assignment({ assignmentId: "a-3", scenarioId: "boss-fight" })
    ])
  );
});

test("one frozen manifest can represent the bounded 1,000-assignment batch", () => {
  const assignments = Array.from(
    { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
    (_, index) =>
      assignment({
        assignmentId: "a-" + String(index + 1).padStart(4, "0"),
        seed: "seed-" + String(index + 1)
      })
  );
  const frozen = manifest(assignments);
  assert.doesNotThrow(() => assertPlaytestAssignmentManifest(frozen));
  assert.equal(frozen.assignments.length, PLAYTESTS_MAX_BATCH_ASSIGNMENTS);
});

test("assignment manifest binds a canonical content hash over the frozen inventory", () => {
  const frozen = manifest([
    assignment({ assignmentId: "a-1" }),
    assignment({ assignmentId: "a-2", seed: "seed-2" })
  ]);
  assertPlaytestAssignmentManifest(frozen);
  assert.equal(
    frozen.contentHash,
    createHash("sha256")
      .update(playtestAssignmentManifestHashInput(frozen))
      .digest("hex")
  );
  const reordered = manifest([
    assignment({ assignmentId: "a-2", seed: "seed-2" }),
    assignment({ assignmentId: "a-1" })
  ]);
  // The inventory is ordered and complete: order is part of the frozen plan.
  assert.notEqual(reordered.contentHash, frozen.contentHash);
  assert.throws(() =>
    assertPlaytestAssignmentManifest({
      ...frozen,
      contentHash: "not-a-digest"
    })
  );
});

test("assignments must match the benchmark scenario family, policy version and seed inventory", () => {
  const benchmark = {
    benchmarkId: "benchmark-1",
    version: 1,
    workspaceId: "owner/game",
    referenceBuildSha: "a".repeat(40),
    scenarioInventory: [
      { scenarioId: "tutorial", family: "onboarding", weight: 1 }
    ],
    seedInventory: [{ seed: "seed-1", purpose: "discovery" as const }],
    policyVersions: { random: "hmac-sha256-v1" },
    competenceReportRefs: [],
    memoryResetRules: "fresh",
    engineEnvironmentHash: "b".repeat(64),
    actionSchemaHash: "c".repeat(64),
    observationSchemaHash: "d".repeat(64),
    eventSchemaHash: "e".repeat(64),
    metricRegistryHash: "f".repeat(64),
    rubricHash: "1".repeat(64),
    captureMode: "headless",
    measurementVersion: "playtesting-measurement-v2",
    primaryMetricIds: ["completion"],
    guardrailMetricIds: [],
    practicalMargins: { completion: 0.05 },
    independentUnit: "episode",
    precisionPlanRef: "plan-v1",
    missingnessBound: 0.1,
    refreshPolicy: "manual",
    createdAt: "2026-10-10T00:00:00.000Z",
    createdBy: "operator",
    cohortWeights: { onboarding: 1 },
    contentHash: "2".repeat(64)
  } as const;
  const validAssignment = {
    assignmentId: "a-0001",
    scenarioId: "tutorial",
    scenarioFamily: "onboarding",
    policyId: "random",
    policyVersion: "hmac-sha256-v1",
    cohort: "exploratory",
    seed: "seed-1",
    maxSteps: 50
  };
  assert.doesNotThrow(() =>
    assertPlaytestAssignmentsMatchBenchmark([validAssignment], benchmark)
  );
  assert.throws(
    () =>
      assertPlaytestAssignmentsMatchBenchmark(
        [{ ...validAssignment, seed: "unregistered-seed" }],
        benchmark
      ),
    /seed is not present/u
  );
  assert.throws(
    () =>
      assertPlaytestAssignmentsMatchBenchmark(
        [{ ...validAssignment, policyVersion: "other-version" }],
        benchmark
      ),
    /policy version does not match/u
  );
  assert.throws(
    () =>
      assertPlaytestAssignmentsMatchBenchmark(
        [{ ...validAssignment, scenarioFamily: "different-family" }],
        benchmark
      ),
    /scenario\/family does not match/u
  );
});

test("batch aggregates keep all nine denominators with game and infrastructure apart", () => {
  const counts = playtestBatchCountsFromAssignments({
    assignmentCount: 8,
    reviewed: 2,
    outcomes: [
      {
        assignmentId: "a-1",
        episodeId: "ep-1",
        state: "completed",
        started: true,
        eligible: true
      },
      {
        assignmentId: "a-2",
        episodeId: "ep-2",
        state: "completed",
        started: true,
        eligible: true
      },
      {
        assignmentId: "a-3",
        episodeId: "ep-3",
        state: "crashed",
        started: true,
        eligible: false
      },
      {
        assignmentId: "a-4",
        episodeId: null,
        state: "infrastructure-failed",
        started: false,
        eligible: false
      },
      {
        assignmentId: "a-5",
        episodeId: "ep-5",
        state: "cancelled",
        started: true,
        eligible: false
      },
      {
        assignmentId: "a-6",
        episodeId: "ep-6",
        state: "budget-truncated",
        started: true,
        eligible: false
      }
    ]
  });
  assert.deepEqual(counts, {
    assigned: 8,
    started: 5,
    completed: 2,
    crashed: 1,
    infrastructureFailed: 1,
    cancelled: 1,
    budgetTruncated: 1,
    reviewed: 2,
    eligible: 2
  });
  assert.throws(
    () =>
      playtestBatchCountsFromAssignments({
        assignmentCount: 1,
        reviewed: 2,
        outcomes: []
      }),
    RangeError
  );
});

test("batch terminal state separates cancellation, infrastructure loss and truncation", () => {
  const completed = [
    {
      assignmentId: "a-1",
      episodeId: "ep-1",
      state: "completed" as const,
      started: true,
      eligible: true
    }
  ];
  assert.equal(
    playtestBatchTerminalState({
      assignmentCount: 1,
      outcomes: completed,
      cancelled: false,
      aborted: false
    }),
    "completed"
  );
  assert.equal(
    playtestBatchTerminalState({
      assignmentCount: 1,
      outcomes: [
        {
          assignmentId: "a-1",
          episodeId: "ep-1",
          state: "crashed",
          started: true,
          eligible: false
        }
      ],
      cancelled: false,
      aborted: false
    }),
    "completed"
  );
  assert.equal(
    playtestBatchTerminalState({
      assignmentCount: 1,
      outcomes: [
        {
          assignmentId: "a-1",
          episodeId: null,
          state: "infrastructure-failed",
          started: false,
          eligible: false
        }
      ],
      cancelled: false,
      aborted: false
    }),
    "failed"
  );
  assert.equal(
    playtestBatchTerminalState({
      assignmentCount: 1,
      outcomes: completed,
      cancelled: true,
      aborted: false
    }),
    "cancelled"
  );
  assert.equal(
    playtestBatchTerminalState({
      assignmentCount: 2,
      outcomes: completed,
      cancelled: false,
      aborted: false
    }),
    "failed"
  );
});

test("review budgets must satisfy surveillance + discovery <= max <= approved critique budget", () => {
  const base = {
    inventoryHash: "d".repeat(64),
    maxReviewedSessions: 6,
    critiqueBudget: 10,
    surveillanceSessions: 4,
    discoverySessions: 2,
    discoverySignal: SIGNAL,
    candidates: [candidate({ assignmentId: "a-1" })],
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  };
  assert.equal(selectPlaytestBatchReviews(base).reviewCap, 6);
  assert.throws(
    () =>
      selectPlaytestBatchReviews({
        ...base,
        surveillanceSessions: 4,
        discoverySessions: 3
      }),
    RangeError
  );
  assert.throws(
    () => selectPlaytestBatchReviews({ ...base, maxReviewedSessions: 11 }),
    RangeError
  );
  assert.equal(
    selectPlaytestBatchReviews({
      ...base,
      maxReviewedSessions: 40,
      critiqueBudget: 40
    }).reviewCap,
    40
  );
  assert.throws(
    () =>
      selectPlaytestBatchReviews({
        ...base,
        maxReviewedSessions: 41,
        critiqueBudget: 41
      }),
    RangeError
  );
});

test("the first-milestone critique ceiling selects 40 complete sessions", () => {
  const selection = selectPlaytestBatchReviews({
    inventoryHash: "d".repeat(64),
    maxReviewedSessions: 40,
    critiqueBudget: 40,
    surveillanceSessions: 40,
    discoverySessions: 0,
    discoverySignal: null,
    candidates: Array.from({ length: 40 }, (_, index) =>
      candidate({ assignmentId: `a-${String(index + 1)}` })
    ),
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  });

  assert.equal(selection.reviewCap, 40);
  assert.equal(selection.selected.length, 40);
  assert.equal(
    new Set(selection.selected.map((entry) => entry.episodeId)).size,
    40
  );
});

test("surveillance is deterministic, stratified and keeps inclusion probabilities", () => {
  const candidates: PlaytestReviewCandidate[] = Array.from(
    { length: 12 },
    (_, index) =>
      candidate({
        assignmentId: "a-" + String(index),
        outcomeKey: index % 2 === 0 ? "completed:win" : "completed:loss"
      })
  );
  const input = {
    inventoryHash: "e".repeat(64),
    maxReviewedSessions: 4,
    critiqueBudget: 4,
    surveillanceSessions: 4,
    discoverySessions: 0,
    discoverySignal: null,
    candidates,
    unreviewableAssignments: 1,
    selectedAt: "2026-10-11T00:00:00.000Z"
  };
  const first = selectPlaytestBatchReviews(input);
  const second = selectPlaytestBatchReviews(input);
  assert.deepEqual(first.selected, second.selected);
  assert.equal(first.seed, playtestReviewSelectionSeed("e".repeat(64)));
  assert.equal(first.reviewablePopulation, 12);
  assert.equal(first.unreviewableAssignments, 1);
  assert.equal(first.surveillance.status, "selected");
  assert.equal(
    first.surveillance.status === "selected"
      ? first.surveillance.sample.selected.length
      : 0,
    4
  );
  for (const unit of first.selected) {
    assert.ok(unit.inclusionProbability !== null);
    assert.ok(unit.inclusionProbability > 0 && unit.inclusionProbability <= 1);
    assert.equal(unit.discoveryRank, null);
  }
  // Both policy x scenario x outcome strata are represented.
  assert.equal(new Set(first.selected.map((unit) => unit.stratumKey)).size, 2);
});

test("an over-stratified surveillance design is rejected rather than coarsened", () => {
  const candidates = ["win", "loss", "dnf", "other"].map((outcome, index) =>
    candidate({
      assignmentId: "a-" + String(index),
      outcomeKey: "completed:" + outcome
    })
  );
  const selection = selectPlaytestBatchReviews({
    inventoryHash: "f".repeat(64),
    maxReviewedSessions: 3,
    critiqueBudget: 3,
    surveillanceSessions: 3,
    discoverySessions: 0,
    discoverySignal: null,
    candidates,
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  });
  assert.equal(selection.surveillance.status, "rejected");
  assert.deepEqual(selection.selected, []);
});

test("discovery ranks only by the named versioned signal and excludes surveillance ids", () => {
  const candidates: PlaytestReviewCandidate[] = Array.from(
    { length: 6 },
    (_, index) =>
      candidate({
        assignmentId: "a-" + String(index),
        metrics: [metric("legal-action-rejection", 1, index / 10)]
      })
  );
  const selection = selectPlaytestBatchReviews({
    inventoryHash: "a".repeat(64),
    maxReviewedSessions: 4,
    critiqueBudget: 4,
    surveillanceSessions: 2,
    discoverySessions: 2,
    discoverySignal: SIGNAL,
    candidates,
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  });
  assert.equal(selection.discovery.status, "selected");
  if (selection.discovery.status !== "selected") {
    throw new Error("unreachable");
  }
  assert.equal(
    selection.discovery.sample.rankedBy,
    "legal-action-rejection@v1:higher-first"
  );
  const discovery = selection.selected.filter(
    (unit) => unit.stream === "discovery"
  );
  assert.deepEqual(
    discovery.map((unit) => unit.assignmentId),
    ["a-5", "a-4"]
  );
  assert.deepEqual(
    discovery.map((unit) => unit.discoveryRank),
    [1, 2]
  );
  assert.equal(discovery[0]!.inclusionProbability, null);
  const surveillanceIds = new Set(
    selection.selected
      .filter((unit) => unit.stream === "surveillance")
      .map((unit) => unit.assignmentId)
  );
  assert.ok(discovery.every((unit) => !surveillanceIds.has(unit.assignmentId)));
  assert.equal(selection.selected.length, 4);
});

test("discovery persists an explicit unavailable state when no signal is approved or observed", () => {
  const candidates = [candidate({ assignmentId: "a-1" })];
  const unapproved = selectPlaytestBatchReviews({
    inventoryHash: "b".repeat(64),
    maxReviewedSessions: 2,
    critiqueBudget: 2,
    surveillanceSessions: 0,
    discoverySessions: 2,
    discoverySignal: null,
    candidates,
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  });
  assert.equal(unapproved.discovery.status, "unavailable");
  assert.equal(
    unapproved.discovery.status === "unavailable"
      ? unapproved.discovery.reason
      : null,
    "no-approved-signal"
  );
  assert.deepEqual(unapproved.selected, []);

  const unobserved = selectPlaytestBatchReviews({
    inventoryHash: "b".repeat(64),
    maxReviewedSessions: 2,
    critiqueBudget: 2,
    surveillanceSessions: 0,
    discoverySessions: 2,
    discoverySignal: SIGNAL,
    candidates,
    unreviewableAssignments: 0,
    selectedAt: "2026-10-11T00:00:00.000Z"
  });
  assert.equal(
    unobserved.discovery.status === "unavailable"
      ? unobserved.discovery.reason
      : null,
    "signal-not-observed"
  );
  assert.deepEqual(unobserved.selected, []);
});

test("pre-execution policy x scenario cells give the surveillance strata lower bound", () => {
  assert.equal(
    playtestAssignmentStrataLowerBound([
      assignment({ assignmentId: "a-1" }),
      assignment({ assignmentId: "a-2", seed: "seed-2" }),
      assignment({
        assignmentId: "a-3",
        policyId: "heuristic",
        seed: "seed-3"
      })
    ]),
    2
  );
});
