import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAgentLaunchSuccessRatePercent,
  deriveContextCompactionRatePercent
} from "../src/usage/rules.ts";

test("context-compaction rate is a share of observed logical requests", () => {
  assert.equal(deriveContextCompactionRatePercent(3, 42), (3 / 42) * 100);
  assert.equal(deriveContextCompactionRatePercent(0, 42), 0);
});

test("context-compaction rate remains unavailable for missing or inconsistent counts", () => {
  assert.equal(deriveContextCompactionRatePercent(null, 42), null);
  assert.equal(deriveContextCompactionRatePercent(3, null), null);
  assert.equal(deriveContextCompactionRatePercent(0, 0), null);
  assert.equal(deriveContextCompactionRatePercent(43, 42), null);
  assert.equal(deriveContextCompactionRatePercent(1.5, 42), null);
});

test("agent-launch success rate separates pre-start resolution from post-start outcomes", () => {
  assert.equal(deriveAgentLaunchSuccessRatePercent(4, 1, 1), (4 / 6) * 100);
  assert.equal(deriveAgentLaunchSuccessRatePercent(0, 2, 0), 0);
  assert.equal(deriveAgentLaunchSuccessRatePercent(0, 0, 0), null);
  assert.equal(deriveAgentLaunchSuccessRatePercent(4, null, 0), null);
  assert.equal(deriveAgentLaunchSuccessRatePercent(4, -1, 0), null);
});
