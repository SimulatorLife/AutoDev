import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestAdapterParams,
  assertPlaytestAdapterResult,
  assertPlaytestAssignmentBranch,
  assertPlaytestBranchLineage,
  type PlaytestAssignmentBranch,
  type PlaytestBranchLineage,
  samePlaytestCheckpoint
} from "../src/playtesting/index.ts";

const digest = (letter: string): string => letter.repeat(64);

const rng = {
  algorithm: "fixture-pcg",
  version: "fixture-rng-v1",
  stateHash: digest("a"),
  reproducible: true
} as const;

const checkpoint = {
  stateHash: digest("b"),
  rngCheckpoint: rng
} as const;

const trace = {
  artifactId: "trace-fixture",
  sha256: digest("c"),
  bytes: 256,
  mediaType: "application/x-ndjson"
} as const;

function branchSource(): PlaytestAssignmentBranch {
  return {
    parentEpisodeId: "episode-parent",
    parentEpisodeRevision: 1,
    parentBatchId: "batch-parent",
    branchStep: 7,
    parentTrace: trace,
    parentCheckpoint: checkpoint,
    alternativeActionId: "cool-down",
    rngPolicy: "same-stream",
    rngPolicyVersion: "same-stream-state-v1"
  };
}

test("checkpoint equality requires exact hidden-state and reproducible RNG identity", () => {
  assert.equal(samePlaytestCheckpoint(checkpoint, checkpoint), true);
  assert.equal(
    samePlaytestCheckpoint(checkpoint, {
      ...checkpoint,
      stateHash: digest("d")
    }),
    false
  );
  assert.equal(
    samePlaytestCheckpoint(checkpoint, {
      ...checkpoint,
      rngCheckpoint: { ...rng, stateHash: digest("e") }
    }),
    false
  );
  assert.equal(
    samePlaytestCheckpoint(checkpoint, {
      ...checkpoint,
      rngCheckpoint: { ...rng, reproducible: false }
    }),
    false
  );
});

test("branch assignment source requires a full same-stream checkpoint and content reference", () => {
  assert.doesNotThrow(() => assertPlaytestAssignmentBranch(branchSource()));
  assert.throws(
    () =>
      assertPlaytestAssignmentBranch({
        ...branchSource(),
        parentCheckpoint: {
          ...checkpoint,
          rngCheckpoint: { ...rng, stateHash: null }
        }
      }),
    /SHA-256/u
  );
  assert.throws(
    () =>
      assertPlaytestAssignmentBranch({
        ...branchSource(),
        rngPolicyVersion: "unverified"
      }),
    /version is unsupported/u
  );
  assert.throws(
    () =>
      assertPlaytestAssignmentBranch({
        ...branchSource(),
        parentTrace: { ...trace, bytes: 0 }
      }),
    /bytes is outside the artifact storage bound/u
  );
});

test("snapshot digest and retained artifact have distinct strict wire shapes", () => {
  const base = {
    episodeId: "episode-1",
    revision: 4,
    stateHash: checkpoint.stateHash,
    rngCheckpoint: rng
  };
  assertPlaytestAdapterParams("game.snapshot", {
    episodeId: "episode-1",
    expectedRevision: 4,
    includeArtifact: false
  });
  assertPlaytestAdapterResult(
    "game.snapshot",
    { episodeId: "episode-1", expectedRevision: 4, includeArtifact: false },
    { ...base, snapshot: null, integrityHash: null }
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult(
        "game.snapshot",
        { episodeId: "episode-1", expectedRevision: 4, includeArtifact: false },
        {
          ...base,
          snapshot: trace,
          integrityHash: trace.sha256
        }
      ),
    /must not return a snapshot artifact/u
  );
  assertPlaytestAdapterResult(
    "game.snapshot",
    { episodeId: "episode-1", expectedRevision: 4, includeArtifact: true },
    { ...base, snapshot: trace, integrityHash: trace.sha256 }
  );
  assert.throws(
    () =>
      assertPlaytestAdapterResult(
        "game.snapshot",
        { episodeId: "episode-1", expectedRevision: 4, includeArtifact: true },
        { ...base, snapshot: trace, integrityHash: digest("f") }
      ),
    /must match/u
  );
});

test("replay must stop at the requested pre-action decision with state/RNG evidence", () => {
  const params = {
    trace,
    expectedBuildSha: digest("1"),
    throughStep: 7
  };
  assertPlaytestAdapterParams("game.replay", params);
  const result = {
    episodeId: "replay-1",
    revision: 8,
    replayStatus: "verified",
    transitionHash: digest("2"),
    firstDivergentStep: null,
    replayedThroughStep: 7,
    stateHash: checkpoint.stateHash,
    rngCheckpoint: rng,
    diagnostics: []
  } as const;
  assertPlaytestAdapterResult("game.replay", params, result);
  assert.throws(
    () =>
      assertPlaytestAdapterResult("game.replay", params, {
        ...result,
        replayedThroughStep: 8
      }),
    /requested pre-action decision step/u
  );
});

test("branch lineage is rejected when fork state or stream diverges from its source", () => {
  const lineage: PlaytestBranchLineage = {
    ...branchSource(),
    replayTransitionHash: digest("4"),
    snapshotArtifact: {
      artifactId: "snapshot-fixture",
      sha256: digest("5"),
      bytes: 1024,
      mediaType: "application/vnd.autodev.playtest-snapshot"
    },
    snapshotIntegrityHash: digest("5"),
    forkStateHash: checkpoint.stateHash,
    forkRngCheckpoint: rng,
    continuationPolicyId: "random",
    continuationPolicyVersion: "hmac-sha256-v1"
  };
  assert.doesNotThrow(() => assertPlaytestBranchLineage(lineage));
  assert.throws(
    () =>
      assertPlaytestBranchLineage({
        ...lineage,
        forkRngCheckpoint: { ...rng, stateHash: digest("6") }
      }),
    /state or RNG lineage/u
  );
  assert.throws(
    () =>
      assertPlaytestBranchLineage(
        { ...lineage, snapshotArtifact: null },
        { completeness: "complete", missingReasons: [] }
      ),
    /explicitly incomplete/u
  );
  assert.doesNotThrow(() =>
    assertPlaytestBranchLineage(
      { ...lineage, snapshotArtifact: null },
      { completeness: "partial", missingReasons: ["infrastructure-failed"] }
    )
  );
});
