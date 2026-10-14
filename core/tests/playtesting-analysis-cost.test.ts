/**
 * Cost accounting for the critic-versus-deterministic comparison.
 *
 * The corpus test in this package proves the scores; this proves the cost side
 * the contract also requires, and specifically that a *missing* measurement
 * stays missing. Reporting `0` for "not measured" would be the same defect the
 * live-run count tiles had: a value nobody produced rendered as a plausible
 * number on a decision.
 *
 * Every result here comes from the real `evaluatePlaytestDiagnosticCorpus`, so
 * the coverage the cost divides by is the coverage the scores were computed
 * against rather than a second hand-written description of it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePlaytestAnalysisCost,
  evaluatePlaytestDiagnosticCorpus,
  type PlaytestAnalysisArmUsage,
  type PlaytestDiagnosticCorpusInput
} from "@simulatorlife/autodev-core";

const protocolHash = "a".repeat(64);

function input(
  overrides: Partial<PlaytestDiagnosticCorpusInput> = {}
): PlaytestDiagnosticCorpusInput {
  return {
    referenceCorpusVersion: "fixture-v1",
    labelProtocolHash: protocolHash,
    coverage: [
      {
        stratumId: "injected-defects",
        eligibleEpisodeIds: ["episode-1", "episode-2", "episode-3"],
        reviewedEpisodeIds: ["episode-1", "episode-2", "episode-3"]
      }
    ],
    references: [
      {
        instanceId: "reference-1",
        episodeId: "episode-1",
        stratumId: "injected-defects",
        category: "correctness",
        mechanicKey: "collision",
        startStep: 10,
        endStep: 12,
        label: "positive",
        reviewerCount: 2,
        blindToPredictions: true,
        adjudication: "agreement"
      }
    ],
    predictions: [
      {
        predictionId: "prediction-1",
        source: "critic",
        episodeId: "episode-1",
        stratumId: "injected-defects",
        category: "correctness",
        mechanicKey: "collision",
        startStep: 11,
        endStep: 13
      }
    ],
    ...overrides
  };
}

/** The contract's worked fixture: three known positives, three reviewed episodes. */
const RESULT = evaluatePlaytestDiagnosticCorpus(input());

/** Per-arm usage; overrides are scoped to one arm so they cannot leak. */
function usage(
  overrides: Partial<
    Record<PlaytestAnalysisArmUsage["arm"], Partial<PlaytestAnalysisArmUsage>>
  > = {}
): PlaytestAnalysisArmUsage[] {
  const base: Record<
    PlaytestAnalysisArmUsage["arm"],
    PlaytestAnalysisArmUsage
  > = {
    critic: { arm: "critic", measuredCost: 30, critiquesRun: 30 },
    deterministic: { arm: "deterministic", measuredCost: 0, critiquesRun: 0 },
    combined: { arm: "combined", measuredCost: 30, critiquesRun: 30 }
  };
  return (Object.keys(base) as PlaytestAnalysisArmUsage["arm"][]).map(
    (arm) => ({ ...base[arm], ...overrides[arm] })
  );
}

test("cost per reviewed episode is measured cost over the scored coverage", () => {
  const comparison = comparePlaytestAnalysisCost(
    RESULT,
    usage({ critic: { measuredCost: 30, critiquesRun: 30 } })
  );
  // Three adequately reviewed episodes, 30 units spent: 10 each.
  assert.equal(
    comparison.coverage.critic?.adequatelyReviewedEpisodes,
    RESULT.critic.adequatelyReviewedEpisodes
  );
  assert.equal(comparison.costPerReviewedEpisode.critic, 30 / 3);
  assert.equal(comparison.coverageMatched, true);
  assert.equal(comparison.coverageMismatchReason, null);
  assert.equal(comparison.matchedComparisonUnavailable, null);
});

test("an arm with no usage is unmeasured, never free", () => {
  const comparison = comparePlaytestAnalysisCost(RESULT, []);
  // Absent usage must read as unknown. `0` here would mean "the critic was
  // free", which is a cost claim nobody made.
  assert.equal(comparison.costPerReviewedEpisode.critic, null);
  assert.equal(comparison.costPerReviewedEpisode.deterministic, null);
  assert.equal(comparison.costPerReviewedEpisode.combined, null);
  assert.equal(comparison.costRatioCombinedOverDeterministic, null);
  assert.equal(comparison.costDeltaPerReviewedEpisode, null);
});

test("a zero cost arm yields a null ratio rather than an infinite cheapness", () => {
  const comparison = comparePlaytestAnalysisCost(
    RESULT,
    usage({ critic: { measuredCost: 30, critiquesRun: 30 } })
  );
  // deterministic costs 0 per reviewed episode, so combined/deterministic is a
  // division by zero, not "infinitely expensive".
  assert.equal(comparison.costPerReviewedEpisode.deterministic, 0);
  assert.equal(comparison.costRatioCombinedOverDeterministic, null);
});

test("coverage is matched by construction across the arms", () => {
  const comparison = comparePlaytestAnalysisCost(
    RESULT,
    usage({ critic: { measuredCost: 30, critiquesRun: 30 } })
  );
  // The evaluator scores all three sources over one frozen coverage set, so
  // this holds for every real result. Asserting it is what makes a future
  // change that lets arms diverge a failing test rather than a silently
  // invalid comparison.
  assert.equal(comparison.coverageMatched, true);
  assert.equal(comparison.coverageMismatchReason, null);
  assert.equal(
    comparison.coverage.deterministic?.adequatelyReviewedEpisodes,
    comparison.coverage.critic?.adequatelyReviewedEpisodes
  );
});

test("an arm scored over different episodes makes the comparison unavailable", () => {
  // The evaluator cannot produce this today, so the divergent result is built
  // by hand: it stands for the one change that could break the invariant above
  // (an evaluator letting arms score over different episode sets). The guard
  // has to reject that result, because the contract defines the comparison at
  // matched coverage and unequal episode sets are not comparable at any cost.
  const divergent = {
    ...RESULT,
    deterministic: {
      ...RESULT.deterministic,
      adequatelyReviewedEpisodes:
        RESULT.deterministic.adequatelyReviewedEpisodes - 1
    }
  };
  const comparison = comparePlaytestAnalysisCost(
    divergent,
    usage({ critic: { measuredCost: 30, critiquesRun: 30 } })
  );
  assert.equal(comparison.coverageMatched, false);
  assert.match(
    comparison.coverageMismatchReason ?? "",
    /adequately reviewed episodes/u
  );
  assert.match(
    comparison.matchedComparisonUnavailable ?? "",
    /not comparable regardless of cost/u
  );
});

test("cost accounting refuses measurements it cannot stand behind", () => {
  const arms: PlaytestAnalysisArmUsage[] = [
    { arm: "critic", measuredCost: Number.NaN, critiquesRun: 1 }
  ];
  assert.throws(
    () => comparePlaytestAnalysisCost(RESULT, arms),
    /finite non-negative/u
  );
  // A negative cost is a sign error, not a discount. Accepting it would put a
  // negative figure on a budget comparison, where it reads as "cheaper than
  // free" and quietly improves the arm's ratio.
  assert.throws(
    () =>
      comparePlaytestAnalysisCost(RESULT, [
        { arm: "critic", measuredCost: -5, critiquesRun: 1 }
      ]),
    /finite non-negative/u
  );
  assert.throws(
    () =>
      comparePlaytestAnalysisCost(RESULT, [
        { arm: "critic", measuredCost: 1, critiquesRun: 1.5 }
      ]),
    /non-negative integer/u
  );
  assert.throws(
    () =>
      comparePlaytestAnalysisCost(RESULT, [
        {
          arm: "oracle" as PlaytestAnalysisArmUsage["arm"],
          measuredCost: 1,
          critiquesRun: 1
        }
      ]),
    /Unknown analysis arm/u
  );
});

test("a run that reviewed nothing reports no cost at all", () => {
  const unreviewed = evaluatePlaytestDiagnosticCorpus(
    input({
      coverage: [
        {
          stratumId: "injected-defects",
          eligibleEpisodeIds: ["episode-1"],
          reviewedEpisodeIds: []
        }
      ],
      references: [],
      predictions: []
    })
  );
  const comparison = comparePlaytestAnalysisCost(
    unreviewed,
    usage({ critic: { measuredCost: 500, critiquesRun: 40 } })
  );
  // 500 units were genuinely spent, but over zero reviewed episodes the
  // per-episode figure is undefined. Reporting 0 here would claim the spend
  // was free; reporting 500 would invent a denominator.
  assert.equal(comparison.coverage.critic?.adequatelyReviewedEpisodes, 0);
  assert.equal(comparison.costPerReviewedEpisode.critic, null);
});
