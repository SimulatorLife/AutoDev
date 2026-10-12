import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateCadenceTriggers,
  evaluateCadenceRetry,
  evaluateJudgeCalibration,
  type PlaytestCadenceTriggerEvent,
  type PlaytestCadenceWorkItem,
  prioritizeCadenceWork,
  validatePlaytestCadenceConfig
} from "../src/playtesting/cadence.ts";
import type {
  PlaytestCadenceConfiguration,
  PlaytestJudgeValidation
} from "../src/playtesting/index.ts";

const validConfig: PlaytestCadenceConfiguration = {
  workspaceId: "test-workspace",
  enabled: true,
  tiers: {
    pr: {
      assignments: 20,
      critiques: 4,
      wallTimeMs: 10 * 60 * 1000
    },
    merged: {
      assignments: 200,
      critiques: 16,
      wallTimeMs: 30 * 60 * 1000
    },
    nightly: {
      assignments: 1000,
      critiques: 40,
      wallTimeMs: 60 * 60 * 1000
    }
  },
  retryableInfrastructureAttempts: 2,
  retentionDays: 90,
  issueReporting: "review"
};

test("validatePlaytestCadenceConfig accepts standard tiers and rejects malformed configs", () => {
  assert.doesNotThrow(() => validatePlaytestCadenceConfig(validConfig));

  assert.throws(
    () =>
      validatePlaytestCadenceConfig({
        ...validConfig,
        workspaceId: ""
      }),
    /workspaceId/u
  );

  assert.throws(
    () =>
      validatePlaytestCadenceConfig({
        ...validConfig,
        retryableInfrastructureAttempts: 5 as any
      }),
    /retryableInfrastructureAttempts/u
  );
});

test("deduplicateCadenceTriggers collapses duplicate events for the same workspace/build/benchmark/tier", () => {
  const triggers: PlaytestCadenceTriggerEvent[] = [
    {
      workspaceId: "ws-1",
      buildSha: "sha-1",
      benchmarkId: "bm-1",
      tier: "pr",
      event: "push",
      triggeredAt: "2026-10-10T00:00:00Z"
    },
    {
      workspaceId: "ws-1",
      buildSha: "sha-1",
      benchmarkId: "bm-1",
      tier: "pr",
      event: "push",
      triggeredAt: "2026-10-10T00:01:00Z"
    },
    {
      workspaceId: "ws-1",
      buildSha: "sha-2",
      benchmarkId: "bm-1",
      tier: "pr",
      event: "push",
      triggeredAt: "2026-10-10T00:02:00Z"
    }
  ];

  const deduped = deduplicateCadenceTriggers(triggers);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]!.buildSha, "sha-1");
  assert.equal(deduped[1]!.buildSha, "sha-2");
});

test("prioritizeCadenceWork orders reproducible regressions before uncovered cells before rotating discovery", () => {
  const items: PlaytestCadenceWorkItem[] = [
    {
      workItemId: "work-disc",
      kind: "rotating-discovery",
      targetId: "target-1",
      estimatedAssignments: 10
    },
    {
      workItemId: "work-regr",
      kind: "reproducible-regression",
      targetId: "target-2",
      estimatedAssignments: 5
    },
    {
      workItemId: "work-cell",
      kind: "uncovered-critical-cell",
      targetId: "target-3",
      estimatedAssignments: 15
    }
  ];

  const sorted = prioritizeCadenceWork(items);
  assert.equal(sorted[0]!.kind, "reproducible-regression");
  assert.equal(sorted[1]!.kind, "uncovered-critical-cell");
  assert.equal(sorted[2]!.kind, "rotating-discovery");
});

test("evaluateCadenceRetry strictly refuses game failure retries while allowing bounded infrastructure retries", () => {
  // Game failure must never be retried for favorable statistics!
  const gameFailure = evaluateCadenceRetry(0, "game-failure", validConfig);
  assert.equal(gameFailure.shouldRetry, false);
  assert.match(gameFailure.reason, /Game failure is an observation/u);

  // Transient infrastructure failures allowed up to retryableInfrastructureAttempts (2)
  const infraFirst = evaluateCadenceRetry(0, "infrastructure", validConfig);
  assert.equal(infraFirst.shouldRetry, true);

  const infraSecond = evaluateCadenceRetry(1, "infrastructure", validConfig);
  assert.equal(infraSecond.shouldRetry, true);

  const infraThird = evaluateCadenceRetry(2, "infrastructure", validConfig);
  assert.equal(infraThird.shouldRetry, false);
  assert.match(infraThird.reason, /Exceeded maximum infrastructure retries/u);
});

test("evaluateJudgeCalibration passes within tolerances and quarantines claims on drift", () => {
  const tolerances = {
    minRepeatAgreement: 0.85,
    minSecondJudgeAgreement: 0.8,
    minDiagnosticPrecision: 0.75,
    minDiagnosticRecall: 0.7,
    maxHumanPredictionError: 0.2,
    maxCostPerEpisode: 0.5
  };

  const passingValidation: PlaytestJudgeValidation = {
    validationId: "val-1",
    workspaceId: "ws-1",
    measurementVersion: "m-1",
    referenceCorpusVersion: "corpus-v1",
    repeatAgreement: 0.9,
    secondJudgeAgreement: 0.85,
    diagnosticPrecision: 0.82,
    diagnosticRecall: 0.78,
    humanPredictionError: 0.12,
    costPerReviewedEpisode: 0.35,
    thresholdsHash: "h-1",
    status: "passed",
    quarantinedClaimTypes: [],
    createdAt: "2026-10-10T00:00:00Z"
  };

  const passingResult = evaluateJudgeCalibration(passingValidation, tolerances);
  assert.equal(passingResult.passed, true);
  assert.equal(passingResult.status, "passed");
  assert.equal(passingResult.quarantinedClaimTypes.length, 0);

  const driftedValidation: PlaytestJudgeValidation = {
    ...passingValidation,
    repeatAgreement: 0.72, // Below 0.85
    diagnosticPrecision: 0.6 // Below 0.75
  };

  const driftedResult = evaluateJudgeCalibration(driftedValidation, tolerances);
  assert.equal(driftedResult.passed, false);
  assert.equal(driftedResult.status, "failed");
  assert.equal(driftedResult.failures.length, 2);
  assert.ok(driftedResult.quarantinedClaimTypes.includes("agency-critique"));
  assert.ok(driftedResult.quarantinedClaimTypes.includes("clarity-critique"));
});
