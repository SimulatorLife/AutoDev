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
      scenarioFamily: null,
      policyCohort: null
    })
  );
  assert.throws(
    () =>
      assertPlaytestEpisodeModeFacts({
        executionProvenance: visualProvenance,
        scenarioFamily: "visual-exploration",
        policyCohort: null
      }),
    /cannot claim an unobserved engine scenario family/u
  );
  assert.doesNotThrow(() =>
    assertPlaytestEpisodeModeFacts({
      executionProvenance: visualProvenance,
      scenarioFamily: null,
      policyCohort: "validated-first-time"
    })
  );
});

test("adapter episodes still require scenario family and a validated cohort", () => {
  assert.doesNotThrow(() =>
    assertPlaytestEpisodeModeFacts({
      executionProvenance: adapterProvenance,
      scenarioFamily: "tutorial",
      policyCohort: "exploratory"
    })
  );
  assert.throws(
    () =>
      assertPlaytestEpisodeModeFacts({
        executionProvenance: adapterProvenance,
        scenarioFamily: null,
        policyCohort: "exploratory"
      }),
    /require their declared scenario family and player cohort/u
  );
});
