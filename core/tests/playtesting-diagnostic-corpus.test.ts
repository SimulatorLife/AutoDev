import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePlaytestDiagnosticCorpus,
  type PlaytestDiagnosticCorpusInput,
  type PlaytestDiagnosticPrediction,
  type PlaytestDiagnosticReference
} from "@simulatorlife/autodev-core";

const protocolHash = "a".repeat(64);

function reference(
  overrides: Partial<PlaytestDiagnosticReference> = {}
): PlaytestDiagnosticReference {
  return {
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
    adjudication: "agreement",
    ...overrides
  };
}

function prediction(
  overrides: Partial<PlaytestDiagnosticPrediction> = {}
): PlaytestDiagnosticPrediction {
  return {
    predictionId: "prediction-1",
    source: "critic",
    episodeId: "episode-1",
    stratumId: "injected-defects",
    category: "correctness",
    mechanicKey: "collision",
    startStep: 11,
    endStep: 13,
    ...overrides
  };
}

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
      reference(),
      reference({
        instanceId: "reference-2",
        episodeId: "episode-2",
        mechanicKey: "stalled-progress",
        startStep: 20,
        endStep: 21
      }),
      reference({
        instanceId: "reference-3",
        episodeId: "episode-3",
        mechanicKey: "lost-state",
        startStep: 30,
        endStep: 30
      })
    ],
    predictions: [
      prediction(),
      prediction({
        predictionId: "prediction-2",
        episodeId: "episode-2",
        mechanicKey: "stalled-progress",
        startStep: 21,
        endStep: 22
      }),
      prediction({
        predictionId: "prediction-false-alarm",
        episodeId: "episode-3",
        mechanicKey: "unrelated-mechanic",
        startStep: 30,
        endStep: 30
      })
    ],
    ...overrides
  };
}

test("diagnostic precision and recall use one-to-one witness matching", () => {
  const result = evaluatePlaytestDiagnosticCorpus(input());
  assert.equal(result.critic.matchedInstances, 2);
  assert.equal(result.critic.falsePositiveInstances, 1);
  assert.equal(result.critic.precision, 2 / 3);
  assert.equal(result.critic.positiveReferenceInstances, 3);
  assert.equal(result.critic.recall, 2 / 3);
  assert.equal(result.critic.coverageComplete, true);
  assert.equal(result.critic.matches.length, 2);
});

test("empty critic has zero recall and undefined precision, never an invented perfect score", () => {
  const result = evaluatePlaytestDiagnosticCorpus(input({ predictions: [] }));
  assert.equal(result.critic.matchedInstances, 0);
  assert.equal(result.critic.precision, null);
  assert.equal(result.critic.recall, 0);
});

test("duplicate prediction flood contributes false positives after the first match", () => {
  const result = evaluatePlaytestDiagnosticCorpus(
    input({
      coverage: [
        {
          stratumId: "injected-defects",
          eligibleEpisodeIds: ["episode-1"],
          reviewedEpisodeIds: ["episode-1"]
        }
      ],
      references: [reference()],
      predictions: [
        prediction(),
        prediction({ predictionId: "prediction-duplicate" })
      ]
    })
  );
  assert.equal(result.critic.matchedInstances, 1);
  assert.equal(result.critic.falsePositiveInstances, 1);
  assert.equal(result.critic.duplicatePredictions, 1);
  assert.equal(result.critic.precision, 0.5);
  assert.equal(result.critic.recall, 1);
});

test("recall is unavailable when eligible hard episodes are missing from reference coverage", () => {
  const result = evaluatePlaytestDiagnosticCorpus(
    input({
      coverage: [
        {
          stratumId: "injected-defects",
          eligibleEpisodeIds: ["episode-1", "hard-episode"],
          reviewedEpisodeIds: ["episode-1"]
        }
      ],
      references: [reference()],
      predictions: [
        prediction(),
        prediction({ predictionId: "hard-missed", episodeId: "hard-episode" })
      ]
    })
  );
  assert.equal(result.critic.coverageComplete, false);
  assert.equal(result.critic.recallAvailable, false);
  assert.equal(result.critic.recall, null);
  assert.equal(result.critic.outOfCoveragePredictions, 1);
  assert.equal(result.critic.scoredPredictions, 1);
});

test("unresolved references are counted and overlapping predictions are not called false positives", () => {
  const result = evaluatePlaytestDiagnosticCorpus(
    input({
      coverage: [
        {
          stratumId: "injected-defects",
          eligibleEpisodeIds: ["episode-1"],
          reviewedEpisodeIds: ["episode-1"]
        }
      ],
      references: [
        reference({
          label: "unresolved",
          adjudication: "unresolved"
        })
      ],
      predictions: [prediction()]
    })
  );
  assert.equal(result.critic.unresolvedReferenceInstances, 1);
  assert.equal(result.critic.unresolvedExcludedPredictions, 1);
  assert.equal(result.critic.falsePositiveInstances, 0);
  assert.equal(result.critic.precision, null);
});

test("critic and deterministic-only baselines and injected/natural strata stay separate", () => {
  const result = evaluatePlaytestDiagnosticCorpus(
    input({
      coverage: [
        {
          stratumId: "injected-defects",
          eligibleEpisodeIds: ["episode-1"],
          reviewedEpisodeIds: ["episode-1"]
        },
        {
          stratumId: "natural-problems",
          eligibleEpisodeIds: ["episode-4"],
          reviewedEpisodeIds: ["episode-4"]
        }
      ],
      references: [
        reference(),
        reference({
          instanceId: "natural-reference",
          episodeId: "episode-4",
          stratumId: "natural-problems",
          mechanicKey: "resource-loss",
          startStep: 40,
          endStep: 41
        })
      ],
      predictions: [
        prediction(),
        prediction({
          predictionId: "critic-natural-false-alarm",
          episodeId: "episode-4",
          stratumId: "natural-problems",
          mechanicKey: "unrelated",
          startStep: 40,
          endStep: 41
        }),
        prediction({
          predictionId: "deterministic-correct",
          source: "deterministic",
          episodeId: "episode-4",
          stratumId: "natural-problems",
          mechanicKey: "resource-loss",
          startStep: 40,
          endStep: 41
        })
      ]
    })
  );
  assert.equal(result.critic.precision, 0.5);
  assert.equal(result.deterministic.precision, 1);
  assert.equal(result.deterministic.recall, 0.5);
  assert.equal(result.combined.matchedInstances, 2);
  assert.equal(result.combined.falsePositiveInstances, 1);
  assert.equal(result.combined.precision, 2 / 3);
  assert.equal(result.combined.recall, 1);
  assert.equal(result.byStratum["injected-defects"]?.critic.recall, 1);
  assert.equal(result.byStratum["natural-problems"]?.critic.recall, 0);
});

test("diagnostic labels must be blind, independently reviewed and adjudication-consistent", () => {
  assert.throws(
    () =>
      evaluatePlaytestDiagnosticCorpus(
        input({
          references: [reference({ reviewerCount: 1 })]
        })
      ),
    /at least two reviewers/u
  );
  assert.throws(
    () =>
      evaluatePlaytestDiagnosticCorpus(
        input({
          references: [reference({ blindToPredictions: false })]
        })
      ),
    /blind to critic predictions/u
  );
  assert.throws(
    () =>
      evaluatePlaytestDiagnosticCorpus(
        input({
          references: [reference({ label: "unresolved" })]
        })
      ),
    /label and adjudication state disagree/u
  );
});

test("diagnostic windows and reference protocol hashes reject invalid inputs", () => {
  assert.throws(
    () =>
      evaluatePlaytestDiagnosticCorpus(
        input({
          predictions: [prediction({ startStep: 5, endStep: 4 })]
        })
      ),
    /ordered, non-negative step window/u
  );
  assert.throws(
    () => evaluatePlaytestDiagnosticCorpus(input({ labelProtocolHash: "bad" })),
    /SHA-256/u
  );
});
