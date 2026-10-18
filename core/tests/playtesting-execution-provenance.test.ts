import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestEpisodeModeFacts,
  type PlaytestExecutionProvenance
} from "../src/playtesting/index.ts";

const adapterProvenance: PlaytestExecutionProvenance = {
  mode: "adapter-accelerated",
  source: {
    kind: "repo-checkout",
    repository: "owner/game",
    revision: "a".repeat(40),
    revisionConfidence: "verified",
    checkoutState: "clean",
    artifactFingerprint: null,
    targetId: null,
    targetOrigin: null
  },
  observationSource: "engine-adapter",
  actionSource: "engine-policy",
  derivedFrom: null
};

const visualProvenance: PlaytestExecutionProvenance = {
  mode: "autonomous-visual",
  source: {
    kind: "URL-only",
    repository: null,
    revision: null,
    revisionConfidence: "not-applicable",
    checkoutState: "not-applicable",
    artifactFingerprint: null,
    targetId: "target-1",
    targetOrigin: "http://localhost:5173"
  },
  observationSource: "browser-ui",
  actionSource: "browser-input",
  derivedFrom: null
};

test("visual episodes require missing scenario-family facts to remain null", () => {
  assert.doesNotThrow(() =>
    assertPlaytestEpisodeModeFacts({
      executionProvenance: visualProvenance,
      identity: { policyId: "smart-direct" },
      status: "completed",
      scenarioFamily: null,
      policyCohort: null,
      playerDebrief: {
        schema: "autodev-playtest-player-debrief-v1",
        status: "absent",
        reason: "legacy-no-report"
      },
      frames: []
    })
  );
  assert.throws(
    () =>
      assertPlaytestEpisodeModeFacts({
        executionProvenance: visualProvenance,
        identity: { policyId: "smart-direct" },
        status: "completed",
        scenarioFamily: "visual-exploration",
        policyCohort: null,
        playerDebrief: {
          schema: "autodev-playtest-player-debrief-v1",
          status: "absent",
          reason: "legacy-no-report"
        },
        frames: []
      }),
    /cannot claim an unobserved engine scenario family/u
  );
  assert.doesNotThrow(() =>
    assertPlaytestEpisodeModeFacts({
      executionProvenance: visualProvenance,
      identity: { policyId: "smart-direct" },
      status: "completed",
      scenarioFamily: null,
      policyCohort: "validated-first-time",
      playerDebrief: {
        schema: "autodev-playtest-player-debrief-v1",
        status: "absent",
        reason: "legacy-no-report"
      },
      frames: []
    })
  );
});

test("adapter episodes still require scenario family and a validated cohort", () => {
  assert.doesNotThrow(() =>
    assertPlaytestEpisodeModeFacts({
      executionProvenance: adapterProvenance,
      identity: { policyId: "random" },
      status: "completed",
      scenarioFamily: "tutorial",
      policyCohort: "exploratory",
      playerDebrief: {
        schema: "autodev-playtest-player-debrief-v1",
        status: "not-applicable",
        reason: "non-reflective-policy"
      },
      frames: []
    })
  );
  assert.throws(
    () =>
      assertPlaytestEpisodeModeFacts({
        executionProvenance: adapterProvenance,
        identity: { policyId: "random" },
        status: "completed",
        scenarioFamily: null,
        policyCohort: "exploratory",
        playerDebrief: {
          schema: "autodev-playtest-player-debrief-v1",
          status: "not-applicable",
          reason: "non-reflective-policy"
        },
        frames: []
      }),
    /require their declared scenario family and player cohort/u
  );
});
