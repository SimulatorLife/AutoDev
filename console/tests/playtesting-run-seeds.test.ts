import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialPlaytestingSeed,
  isAdmissiblePlaytestingSeed,
  nextPlaytestingSeed,
  type PlaytestingAdmissibleSeeds
} from "../src/features/playtesting/playtesting-run-seeds.ts";

const FROZEN: PlaytestingAdmissibleSeeds = [
  { seed: "discovery", purpose: "discovery" },
  { seed: "confirmation", purpose: "confirmation" },
  { seed: "regression", purpose: "regression" }
];

function row(seed: string, scenarioId = "championship-run") {
  return { scenarioId, policyId: "random", seed };
}

test("a frozen benchmark inventory is the only seed source the run form offers", () => {
  assert.equal(initialPlaytestingSeed(FROZEN), "discovery");
  assert.equal(isAdmissiblePlaytestingSeed(FROZEN, " confirmation "), true);
  assert.equal(isAdmissiblePlaytestingSeed(FROZEN, "seed-1"), false);
  assert.equal(
    nextPlaytestingSeed(
      FROZEN,
      [row("discovery")],
      "championship-run",
      "random"
    ),
    "confirmation"
  );
  assert.equal(
    nextPlaytestingSeed(
      FROZEN,
      [row("discovery"), row("confirmation"), row("regression")],
      "championship-run",
      "random"
    ),
    null,
    "an exhausted inventory offers no further assignment in that cell"
  );
  assert.equal(
    nextPlaytestingSeed(
      FROZEN,
      [row("discovery", "other-scenario")],
      "championship-run",
      "random"
    ),
    "discovery",
    "seeds are unique per scenario/policy cell, not per batch"
  );
});

test("without a frozen inventory the run form numbers free seeds", () => {
  assert.equal(initialPlaytestingSeed(null), "seed-1");
  assert.equal(isAdmissiblePlaytestingSeed(null, "any-seed"), true);
  assert.equal(isAdmissiblePlaytestingSeed(null, "   "), false);
  assert.equal(
    nextPlaytestingSeed(null, [row("seed-1"), row("seed-3")], "x", "random"),
    "seed-4"
  );
});
