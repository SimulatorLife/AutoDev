import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertPlaytestExperiment,
  isPlaytestExperimentTransitionAllowed,
  PLAYTESTS_EXPERIMENT_TRANSITIONS,
  playtestExperimentHashInput,
  transitionPlaytestExperiment,
  type PlaytestExperiment,
  type PlaytestVersionedRef
} from "../src/playtesting/index.ts";

const WORKSPACE_ID = "fixture-game";
const HYPOTHESIS =
  "B improves consequence-forecast accuracy on the fixture scenario.";
const FALSIFIER =
  "No preregistered primary improvement of 0.10 meaningful margin.";

const BASELINE: PlaytestVersionedRef = {
  id: "fixture-artifact-A",
  version: 1,
  contentHash:
    "0000000000000000000000000000000000000000000000000000000000000001"
};
const TREATMENT: PlaytestVersionedRef = {
  id: "fixture-artifact-B",
  version: 1,
  contentHash:
    "0000000000000000000000000000000000000000000000000000000000000002"
};

function buildFixtureExperiment(overrides: {
  readonly discoveryInventory?: readonly string[];
  readonly confirmationInventory?: readonly string[];
  readonly discoveryArm?: "baseline" | "treatment";
  readonly primaryMetricId?: string;
  readonly state?: PlaytestExperiment["state"];
  readonly comparisonId?: string | null;
  readonly ownerDecision?: string | null;
  readonly attemptIds?: readonly string[];
  readonly maxAssignments?: number;
  readonly baseline?: PlaytestVersionedRef;
  readonly treatment?: PlaytestVersionedRef;
  readonly budget?: {
    readonly maxAssignments: number;
    readonly maxCritiques: number;
    readonly maxWallTimeMs: number;
  };
  readonly guardrailMetricIds?: readonly string[];
  readonly pairMap?: Readonly<Record<string, string>>;
}): PlaytestExperiment {
  const discovery = overrides.discoveryInventory ?? ["d1", "d2", "d3", "d4"];
  const confirmation = overrides.confirmationInventory ?? [
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c6",
    "c7",
    "c8",
    "c9",
    "c10",
    "c11",
    "c12",
    "c13",
    "c14",
    "c15",
    "c16"
  ];
  const ids = [...discovery, ...confirmation];
  const discoveryArm = overrides.discoveryArm ?? "baseline";
  const assignmentMap: Record<string, "baseline" | "treatment"> = {};
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    let arm: "baseline" | "treatment" = "baseline";
    if (discovery.includes(id)) {
      arm = discoveryArm;
    } else {
      arm = index % 2 === 0 ? "baseline" : "treatment";
    }
    assignmentMap[id] = arm;
  }
  const pairMap: Record<string, string> = {};
  const baselineUnits: string[] = [];
  const treatmentUnits: string[] = [];
  for (const [id, arm] of Object.entries(assignmentMap)) {
    if (arm === "baseline") baselineUnits.push(id);
    else treatmentUnits.push(id);
  }
  for (let index = 0; index < baselineUnits.length; index += 1) {
    const left = baselineUnits[index]!;
    const right = treatmentUnits[index] ?? null;
    if (right === null) continue;
    pairMap[left] = right;
    pairMap[right] = left;
  }
  const budget =
    overrides.budget ??
    ({
      maxAssignments: ids.length,
      maxCritiques: 40,
      maxWallTimeMs: 30 * 60 * 1000
    } as const);
  const manifest: Omit<PlaytestExperiment, "contentHash"> = {
    schema: "autodev-playtest-experiment-v1",
    experimentId: "experiment-warning",
    version: 1,
    workspaceId: WORKSPACE_ID,
    findingIds: ["finding-" + "f".repeat(64)],
    hypothesis: HYPOTHESIS,
    falsifier: FALSIFIER,
    alternativeExplanations: [
      "sampling noise under fixed N=20",
      "shared policy P1 encodes the change in some other way"
    ],
    benchmarkId: "fixture-benchmark-warning",
    baseline: overrides.baseline ?? BASELINE,
    treatment: overrides.treatment ?? TREATMENT,
    approvalId: "approval-001",
    exposureUnit: "learner",
    allocationSeed: "fixture-seed-v1",
    allocationMethod: "pinned-random-permutation",
    cohort: "fixture-first-time-adult",
    memoryInitialization: "no-shared-learning-memory",
    pairMap: overrides.pairMap ?? pairMap,
    assignmentMap,
    discoveryInventory: discovery,
    confirmationInventory: confirmation,
    primaryMetricId:
      overrides.primaryMetricId ?? "consequence-forecast-accuracy",
    guardrailMetricIds: overrides.guardrailMetricIds ?? [
      "crash-rate",
      "telemetry-trustworthy"
    ],
    analysisPlan: "frozen-final-analysis-after-20-assignments",
    missingnessPlan: "sensitivity-bounds-not-needed-for-n-20-descriptive-only",
    multiplicityPlan: "single-primary-no-family-correction",
    budget,
    stoppingRule: "fixed-N-stop-after-20-assignments",
    state: overrides.state ?? "draft",
    attemptIds: overrides.attemptIds ?? [],
    comparisonId: overrides.comparisonId ?? null,
    ownerDecision: overrides.ownerDecision ?? null,
    rollbackRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  return {
    ...manifest,
    contentHash: createHash("sha256")
      .update(playtestExperimentHashInput({ ...manifest, contentHash: "" }))
      .digest("hex")
  };
}

function experimentWith(
  overrides: Parameters<typeof buildFixtureExperiment>[0]
) {
  return buildFixtureExperiment(overrides);
}

function defaultBudget() {
  return {
    maxAssignments: 20,
    maxCritiques: 40,
    maxWallTimeMs: 30 * 60 * 1000
  } as const;
}

test("assertPlaytestExperiment accepts a fixture experiment with 20 assignments and a paired plan", () => {
  const fixture = buildFixtureExperiment({});
  assert.doesNotThrow(() => assertPlaytestExperiment(fixture));
});

test("assertPlaytestExperiment rejects legacy/noncanonical finding aliases", () => {
  const fixture = buildFixtureExperiment({});
  assert.throws(
    () => assertPlaytestExperiment({ ...fixture, findingIds: ["F-warning"] }),
    /canonical stable finding IDs/u
  );
});

test("assertPlaytestExperiment rejects a malformed record missing required identity fields", () => {
  const fixture = buildFixtureExperiment({});
  const broken: Record<string, unknown> = { ...fixture };
  delete broken["experimentId"];
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /PlaytestExperiment must have exactly its specified fields/u
  );
});

test("assertPlaytestExperiment rejects an unknown top-level field", () => {
  const fixture = buildFixtureExperiment({});
  const broken = { ...fixture, sneaky: true } as unknown;
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /unsupported field|exactly its specified fields/u
  );
});

test("assertPlaytestExperiment rejects baseline and treatment sharing an artifact id", () => {
  const shared = { ...TREATMENT, id: BASELINE.id };
  assert.throws(
    () =>
      assertPlaytestExperiment(buildFixtureExperiment({ treatment: shared })),
    /distinct approved artifacts/u
  );
});

test("assertPlaytestExperiment rejects non-disjoint discovery and confirmation inventories", () => {
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          discoveryInventory: ["c1", "c2", "c3", "c4"],
          confirmationInventory: [
            "c3",
            "c4",
            "c5",
            "c6",
            "c7",
            "c8",
            "c9",
            "c10",
            "c11",
            "c12",
            "c13",
            "c14",
            "c15",
            "c16"
          ]
        })
      ),
    /disjoint/u
  );
});

test("assertPlaytestExperiment rejects an assignmentMap that does not match the frozen inventory", () => {
  const fixture = buildFixtureExperiment({});
  const narrowedAssignment: Record<string, "baseline" | "treatment"> = {};
  for (const [id, arm] of Object.entries(fixture.assignmentMap)) {
    if (id === "c1") continue;
    narrowedAssignment[id] = arm as "baseline" | "treatment";
  }
  const broken: PlaytestExperiment = {
    ...fixture,
    assignmentMap: narrowedAssignment
  };
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /assignmentMap must assign exactly/u
  );
});

test("assertPlaytestExperiment rejects an arm value other than baseline or treatment", () => {
  const fixture = buildFixtureExperiment({});
  const assignment = { ...fixture.assignmentMap, c1: "control" as never };
  const broken: PlaytestExperiment = { ...fixture, assignmentMap: assignment };
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /"baseline" or "treatment"/u
  );
});

test("assertPlaytestExperiment rejects a pairMap that pairs two baseline units", () => {
  const fixture = buildFixtureExperiment({});
  const baselineUnit = Object.entries(fixture.assignmentMap).find(
    ([, arm]) => arm === "baseline"
  )?.[0];
  const otherBaselineUnit = Object.entries(fixture.assignmentMap).filter(
    ([id, arm]) => arm === "baseline" && id !== baselineUnit
  )[0]?.[0];
  assert.ok(baselineUnit && otherBaselineUnit);
  const pairMap = { ...fixture.pairMap, [baselineUnit]: otherBaselineUnit };
  const broken: PlaytestExperiment = { ...fixture, pairMap };
  assert.throws(() => assertPlaytestExperiment(broken), /different arms/u);
});

test("assertPlaytestExperiment rejects a pairMap that is not symmetric", () => {
  const fixture = buildFixtureExperiment({});
  const first = Object.keys(fixture.pairMap)[0]!;
  const broken: PlaytestExperiment = {
    ...fixture,
    pairMap: { ...fixture.pairMap, [first]: "not-a-unit" }
  };
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /symmetric|reference assigned units/u
  );
});

test("assertPlaytestExperiment rejects a budget whose maxAssignments does not match the fixed assignment count", () => {
  const fixture = buildFixtureExperiment({});
  const broken: PlaytestExperiment = {
    ...fixture,
    budget: {
      maxAssignments: fixture.budget.maxAssignments + 1,
      maxCritiques: 40,
      maxWallTimeMs: 30 * 60 * 1000
    }
  };
  assert.throws(
    () => assertPlaytestExperiment(broken),
    /maxAssignments must equal the frozen assignment count/u
  );
});

test("assertPlaytestExperiment rejects a primary metric that is also a guardrail", () => {
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          primaryMetricId: "crash-rate",
          guardrailMetricIds: ["crash-rate"]
        })
      ),
    /primaryMetricId must not also be a guardrail/u
  );
});

test("assertPlaytestExperiment rejects a non-ISO createdAt", () => {
  const fixture = buildFixtureExperiment({});
  const broken: PlaytestExperiment = {
    ...fixture,
    createdAt: "not-a-timestamp"
  };
  assert.throws(() => assertPlaytestExperiment(broken), /ISO-8601/u);
});

test("assertPlaytestExperiment rejects an unknown lifecycle state", () => {
  const fixture = buildFixtureExperiment({ state: "decided" as never });
  assert.throws(() => assertPlaytestExperiment(fixture), /unsupported value/u);
});

test("allowed-transition table admits the documented main path draft -> approved -> running -> completed -> analyzed -> owner-decided", () => {
  const path: ReadonlyArray<
    Parameters<typeof isPlaytestExperimentTransitionAllowed>[1]
  > = ["approved", "running", "completed", "analyzed", "owner-decided"];
  let cursor: Parameters<typeof isPlaytestExperimentTransitionAllowed>[0] =
    "draft";
  for (const next of path) {
    assert.equal(
      isPlaytestExperimentTransitionAllowed(cursor, next),
      true,
      `expected ${cursor} -> ${next} to be allowed`
    );
    cursor = next;
  }
});

test("allowed-transition table keeps denied, cancelled, execution-failed, inconclusive and owner-decided terminal", () => {
  const terminals = [
    "denied",
    "cancelled",
    "execution-failed",
    "inconclusive",
    "owner-decided"
  ] as const;
  for (const terminal of terminals) {
    assert.equal(PLAYTESTS_EXPERIMENT_TRANSITIONS[terminal].length, 0);
    for (const target of [
      "draft",
      "approved",
      "running",
      "completed",
      "analyzed",
      "owner-decided",
      "denied",
      "cancelled",
      "execution-failed",
      "inconclusive"
    ] as const) {
      assert.equal(
        isPlaytestExperimentTransitionAllowed(terminal, target),
        false,
        `expected terminal "${terminal}" to forbid -> "${target}"`
      );
    }
  }
});

test("allowed-transition table forbids draft -> running (must go through approved) and running -> analyzed (must go through completed)", () => {
  assert.equal(
    isPlaytestExperimentTransitionAllowed("draft", "running"),
    false
  );
  assert.equal(
    isPlaytestExperimentTransitionAllowed("running", "analyzed"),
    false
  );
  assert.equal(
    isPlaytestExperimentTransitionAllowed("approved", "completed"),
    false
  );
  assert.equal(
    isPlaytestExperimentTransitionAllowed("completed", "owner-decided"),
    false
  );
});

test("transitionPlaytestExperiment advances along the main path, version increments by exactly one, and every other field is preserved", () => {
  let fixture = buildFixtureExperiment({});
  const startVersion = fixture.version;
  fixture = transitionPlaytestExperiment(fixture, { to: "approved" });
  assert.equal(fixture.state, "approved");
  assert.equal(fixture.version, startVersion + 1);
  fixture = transitionPlaytestExperiment(fixture, {
    to: "running",
    attemptId: "attempt-1"
  });
  assert.equal(fixture.state, "running");
  assert.deepEqual(fixture.attemptIds, ["attempt-1"]);
  fixture = transitionPlaytestExperiment(fixture, { to: "completed" });
  assert.equal(fixture.state, "completed");
  fixture = transitionPlaytestExperiment(fixture, {
    to: "analyzed",
    comparisonId: "comparison-warning-1"
  });
  assert.equal(fixture.state, "analyzed");
  assert.equal(fixture.comparisonId, "comparison-warning-1");
  fixture = transitionPlaytestExperiment(fixture, {
    to: "owner-decided",
    ownerDecision: "hold-regression"
  });
  assert.equal(fixture.state, "owner-decided");
  assert.equal(fixture.ownerDecision, "hold-regression");
  assert.equal(fixture.comparisonId, "comparison-warning-1");
  assert.equal(fixture.version, startVersion + 5);
  assert.equal(fixture.contentHash, buildFixtureExperiment({}).contentHash);
  assert.equal(
    playtestExperimentHashInput(fixture),
    playtestExperimentHashInput(buildFixtureExperiment({}))
  );
  assert.notEqual(
    playtestExperimentHashInput({
      ...fixture,
      allocationSeed: "different-seed"
    }),
    playtestExperimentHashInput(fixture)
  );
  // All other immutable fields survive the chain.
  assert.deepEqual(
    fixture.assignmentMap,
    buildFixtureExperiment({}).assignmentMap
  );
  assert.deepEqual(fixture.pairMap, buildFixtureExperiment({}).pairMap);
  assert.equal(fixture.primaryMetricId, "consequence-forecast-accuracy");
});

test("transitionPlaytestExperiment rejects an illegal transition (running -> analyzed) with a RangeError", () => {
  const fixture = buildFixtureExperiment({
    state: "running",
    attemptIds: ["attempt-1"]
  });
  assert.throws(
    () =>
      transitionPlaytestExperiment(fixture, {
        to: "analyzed",
        comparisonId: "comparison-bad"
      }),
    RangeError
  );
});

test("transitionPlaytestExperiment rejects an unknown target state with a TypeError", () => {
  const fixture = buildFixtureExperiment({ state: "draft" });
  assert.throws(
    () =>
      transitionPlaytestExperiment(fixture, {
        to: "final" as never
      }),
    TypeError
  );
});

test("transitionPlaytestExperiment rejects entering running without a fresh attemptId", () => {
  const fixture = buildFixtureExperiment({ state: "approved" });
  assert.throws(
    () => transitionPlaytestExperiment(fixture, { to: "running" }),
    /non-empty attemptId/u
  );
  assert.throws(
    () =>
      transitionPlaytestExperiment(fixture, { to: "running", attemptId: "" }),
    /non-empty attemptId/u
  );
  const started = transitionPlaytestExperiment(fixture, {
    to: "running",
    attemptId: "attempt-1"
  });
  // Re-entering running (infrastructure retry) needs a fresh attempt id;
  // the previous attempt is preserved.
  assert.throws(
    () =>
      transitionPlaytestExperiment(started, {
        to: "running",
        attemptId: "attempt-1"
      }),
    /already been recorded/u
  );
  const retried = transitionPlaytestExperiment(started, {
    to: "running",
    attemptId: "attempt-2"
  });
  assert.equal(retried.state, "running");
  assert.deepEqual(retried.attemptIds, ["attempt-1", "attempt-2"]);
});

test("a game failure is an observation, not a retry-until-pass: running -> execution-failed is terminal and cannot return to running", () => {
  const fixture = buildFixtureExperiment({
    state: "running",
    attemptIds: ["attempt-1"]
  });
  const failed = transitionPlaytestExperiment(fixture, {
    to: "execution-failed"
  });
  assert.equal(failed.state, "execution-failed");
  assert.deepEqual(failed.attemptIds, ["attempt-1"]);
  assert.throws(
    () =>
      transitionPlaytestExperiment(failed, {
        to: "running",
        attemptId: "attempt-2"
      }),
    /Illegal PlaytestExperiment transition/u
  );
});

test("transitionPlaytestExperiment rejects entering analyzed without a comparisonId", () => {
  const fixture = buildFixtureExperiment({ state: "completed" });
  assert.throws(
    () => transitionPlaytestExperiment(fixture, { to: "analyzed" }),
    /requires a stored comparisonId/u
  );
  const empty = buildFixtureExperiment({ state: "completed" });
  assert.throws(
    () =>
      transitionPlaytestExperiment(empty, {
        to: "analyzed",
        comparisonId: ""
      }),
    /requires a stored comparisonId/u
  );
});

test("transitionPlaytestExperiment forbids overwriting a stored comparisonId on a later analyzed attempt", () => {
  const fixture = buildFixtureExperiment({
    state: "analyzed",
    comparisonId: "comparison-original"
  });
  // The reassignment attempt itself is illegal: analyzed -> analyzed is not
  // in the table (only analyzed -> owner-decided | inconclusive are).
  assert.throws(
    () =>
      transitionPlaytestExperiment(fixture, {
        to: "analyzed",
        comparisonId: "comparison-replacement"
      }),
    /Illegal PlaytestExperiment transition/u
  );
});

test("transitionPlaytestExperiment rejects entering owner-decided without a prior comparisonId and forbids overwriting an existing ownerDecision", () => {
  // Start in 'analyzed' with no comparisonId: the table permits
  // analyzed -> owner-decided, but the missing comparisonId check fires
  // first and produces a clear, distinct error.
  const noComparison = buildFixtureExperiment({
    state: "analyzed",
    comparisonId: null
  });
  assert.throws(
    () =>
      transitionPlaytestExperiment(noComparison, {
        to: "owner-decided",
        ownerDecision: "anything"
      }),
    /analyze the experiment first/u
  );
  // With a comparisonId and an ownerDecision, the same analyzed state
  // advances normally and is then locked.
  const withComparison = buildFixtureExperiment({
    state: "analyzed",
    comparisonId: "comparison-1"
  });
  const ready = transitionPlaytestExperiment(withComparison, {
    to: "owner-decided",
    ownerDecision: "eligible-for-owner-promotion"
  });
  assert.equal(ready.ownerDecision, "eligible-for-owner-promotion");
  // Terminal: no further transitions at all.
  for (const next of [
    "draft",
    "approved",
    "running",
    "completed",
    "analyzed",
    "owner-decided",
    "denied",
    "cancelled",
    "execution-failed",
    "inconclusive"
  ] as const) {
    assert.throws(
      () => transitionPlaytestExperiment(ready, { to: next }),
      /Illegal PlaytestExperiment transition/u
    );
  }
});

test("many null/no-effect outcomes remain visible: a single successful comparison does not delete the prior null, cancelled, and execution-failed experiments", () => {
  // Three sibling experiment records, all immutable, all stored, none
  // auto-collapsed. A "lucky" single-discovery success must not rewrite
  // history by deleting the null/cancelled/failed records.
  const nullRun = transitionPlaytestExperiment(
    buildFixtureExperiment({ state: "completed" }),
    { to: "inconclusive" }
  );
  const cancelledRun = transitionPlaytestExperiment(
    buildFixtureExperiment({ state: "approved" }),
    { to: "cancelled" }
  );
  const failedRun = transitionPlaytestExperiment(
    buildFixtureExperiment({
      state: "running",
      attemptIds: ["attempt-1"]
    }),
    { to: "execution-failed" }
  );
  const lucky = buildFixtureExperiment({ state: "completed" });
  const luckyAnalyzed = transitionPlaytestExperiment(lucky, {
    to: "analyzed",
    comparisonId: "comparison-lucky"
  });
  const luckyDecided = transitionPlaytestExperiment(luckyAnalyzed, {
    to: "owner-decided",
    ownerDecision: "eligible-for-owner-promotion"
  });

  // Each record carries its own version, own state, own terminal result.
  assert.equal(nullRun.state, "inconclusive");
  assert.equal(cancelledRun.state, "cancelled");
  assert.equal(failedRun.state, "execution-failed");
  assert.equal(luckyDecided.state, "owner-decided");
  // And the lucky record alone has a comparisonId; the others never can.
  assert.equal(nullRun.comparisonId, null);
  assert.equal(cancelledRun.comparisonId, null);
  assert.equal(failedRun.comparisonId, null);
  assert.equal(luckyDecided.comparisonId, "comparison-lucky");
  // No path from a failed/terminal sibling into the lucky outcome.
  for (const terminal of [nullRun, cancelledRun, failedRun]) {
    for (const next of [
      "draft",
      "approved",
      "running",
      "completed",
      "analyzed",
      "owner-decided"
    ] as const) {
      assert.throws(
        () => transitionPlaytestExperiment(terminal, { to: next }),
        /Illegal PlaytestExperiment transition/u
      );
    }
  }
});

test("terminal-state guards: every terminal forbids every transition, including to itself", () => {
  const terminals = [
    "denied",
    "cancelled",
    "execution-failed",
    "inconclusive",
    "owner-decided"
  ] as const;
  for (const terminal of terminals) {
    const fixture = buildFixtureExperiment({ state: terminal });
    assert.throws(
      () => transitionPlaytestExperiment(fixture, { to: terminal }),
      /Illegal PlaytestExperiment transition/u
    );
  }
});

test("the experiment object is not mutated by a successful transition", () => {
  const fixture = buildFixtureExperiment({ state: "draft" });
  const before = JSON.stringify(fixture);
  const next = transitionPlaytestExperiment(fixture, { to: "approved" });
  assert.equal(JSON.stringify(fixture), before);
  assert.notEqual(next, fixture);
  assert.equal(next.version, fixture.version + 1);
});

test("duplicate inventory ids in either inventory are rejected", () => {
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          discoveryInventory: ["d1", "d1", "d2"]
        })
      ),
    /entries must be unique/u
  );
});

test("empty confirmation inventory is rejected; empty discovery inventory is permitted (a fully confirmatory experiment is allowed)", () => {
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          confirmationInventory: []
        })
      ),
    /confirmationInventory must not be empty/u
  );
  // A fully-confirmatory experiment (zero discovery) with an even
  // confirmation inventory is permitted: the pair map is symmetric and
  // the assignment map covers exactly the frozen inventory.
  const evenConfirm = [
    "c1",
    "c2",
    "c3",
    "c4",
    "c5",
    "c6",
    "c7",
    "c8",
    "c9",
    "c10",
    "c11",
    "c12",
    "c13",
    "c14",
    "c15",
    "c16"
  ];
  const confirmOnly = buildFixtureExperiment({
    discoveryInventory: [],
    confirmationInventory: evenConfirm
  });
  assert.doesNotThrow(() => assertPlaytestExperiment(confirmOnly));
});

test("invalid baseline/treatment version types and empty strings are rejected", () => {
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          baseline: { id: "", version: 1 } as never
        })
      ),
    /non-empty string/u
  );
  assert.throws(
    () =>
      assertPlaytestExperiment(
        buildFixtureExperiment({
          treatment: {
            id: "fixture-artifact-X",
            version: null as never
          }
        })
      ),
    /number or string/u
  );
});

// Touch unused helper so the test build doesn't flag a "declared but never
// read" import under noUnusedParameters; the helper is intentionally
// callable for any future overrides.
void experimentWith;
void defaultBudget;
