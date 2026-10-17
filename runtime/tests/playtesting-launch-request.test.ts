import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestLaunchRequest
} from "@simulatorlife/autodev-core";

import {
  playtestBranchLaunchRequestSchema,
  playtestLaunchRequestSchema
} from "../src/playtesting/launch-request-schema.ts";

const WORKSPACE = "owner/game";

function batchRequest(): PlaytestLaunchRequest {
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: WORKSPACE,
    requestId: "request-fixture-1",
    capabilityRevision: "a".repeat(64),
    operation: {
      kind: "batch",
      assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
    }
  };
}

function branchRequest(): PlaytestLaunchRequest {
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: WORKSPACE,
    requestId: "request-fixture-2",
    capabilityRevision: "a".repeat(64),
    operation: {
      kind: "branch",
      parentEpisodeId: "episode-1",
      branchStep: 4,
      alternativeActionId: "wait",
      maxSteps: 12
    }
  };
}

test("the single PlaytestLaunchRequest schema distinguishes modes and adapter operations", () => {
  assert.equal(
    playtestLaunchRequestSchema.safeParse(batchRequest()).success,
    true
  );
  assert.equal(
    playtestLaunchRequestSchema.safeParse(branchRequest()).success,
    true
  );
  assert.equal(
    playtestBranchLaunchRequestSchema.safeParse(batchRequest()).success,
    false
  );
  assert.equal(
    playtestBranchLaunchRequestSchema.safeParse(branchRequest()).success,
    true
  );
});

test("autonomous visual and scripted requests are versioned and keep mode-specific fields", () => {
  const visual: PlaytestLaunchRequest = {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "autonomous-visual",
    workspaceId: WORKSPACE,
    requestId: "request-fixture-3",
    capabilityRevision: "a".repeat(64),
    targetId: "racing-game-local",
    policyId: "smart-direct",
    areasOfFocus: "Explore the race start and pit decisions.",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 80,
      wallTimeMs: 120_000,
      smartRequestsPerEpisode: 30,
      smartTokensPerEpisode: 25_000,
      screenshotCountPerEpisode: 160,
      artifactBytesPerEpisode: 64 * 1024 * 1024
    }
  };
  const scripted: PlaytestLaunchRequest = {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "scripted-regression",
    workspaceId: WORKSPACE,
    requestId: "request-fixture-4",
    capabilityRevision: "a".repeat(64),
    recipeId: "replay-race-settlement",
    maxSteps: 80,
    wallTimeMs: 120_000
  };
  assert.equal(playtestLaunchRequestSchema.safeParse(visual).success, true);
  assert.equal(playtestLaunchRequestSchema.safeParse(scripted).success, true);
  assert.equal(
    playtestLaunchRequestSchema.safeParse({
      ...visual,
      mode: "adapter-accelerated"
    }).success,
    false
  );
  assert.equal(
    playtestLaunchRequestSchema.safeParse({
      ...batchRequest(),
      command: "node adapter.mjs"
    }).success,
    false
  );
});

test("superseded flat batch and branch payloads are rejected without fallback", () => {
  assert.equal(
    playtestLaunchRequestSchema.safeParse({
      workspaceId: WORKSPACE,
      assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
    }).success,
    false
  );
  assert.equal(
    playtestLaunchRequestSchema.safeParse({
      workspaceId: WORKSPACE,
      parentEpisodeId: "episode-1",
      branchStep: 4,
      alternativeActionId: "wait"
    }).success,
    false
  );
  const missingRequestId = { ...batchRequest() } as Record<string, unknown>;
  delete missingRequestId.requestId;
  assert.equal(
    playtestLaunchRequestSchema.safeParse(missingRequestId).success,
    false
  );
  assert.equal(
    playtestLaunchRequestSchema.safeParse({
      ...batchRequest(),
      requestId: "contains spaces"
    }).success,
    false
  );
});
