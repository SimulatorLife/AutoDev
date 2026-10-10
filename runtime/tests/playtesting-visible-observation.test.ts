import assert from "node:assert/strict";
import test from "node:test";

import type { PlaytestObservationContract } from "@simulatorlife/autodev-core";

import { projectPlaytestVisibleObservation } from "../src/playtesting/visible-observation.ts";

const contract: PlaytestObservationContract = {
  schemaVersion: 1,
  schemaHash: "a".repeat(64),
  mode: "headless",
  cohort: "novice",
  visibilityMode: "structured",
  fields: [
    {
      fieldPath: "room",
      unit: null,
      displayRounding: null,
      revelationTiming: "before-action",
      playerRuleRef: null
    },
    {
      fieldPath: "player.health",
      unit: "points",
      displayRounding: "integer",
      revelationTiming: "before-action",
      playerRuleRef: "rules/health"
    }
  ],
  uiEquivalence: "unverified",
  conformanceFixtureHash: null
};

test("player-visible projection excludes adapter extras and nested debug state", () => {
  const result = projectPlaytestVisibleObservation(
    {
      room: "hall",
      hiddenOutcome: "secret-win",
      player: { health: 4, debugSeed: "secret-seed" }
    },
    contract
  );
  assert.deepEqual(result, { room: "hall", player: { health: 4 } });
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
});

test("player-visible projection supports bounded array-index field paths", () => {
  const result = projectPlaytestVisibleObservation(
    {
      players: [
        { health: 1, private: "a" },
        { health: 2, private: "b" }
      ]
    },
    {
      ...contract,
      fields: [
        {
          fieldPath: "players.1.health",
          unit: "points",
          displayRounding: "integer",
          revelationTiming: "before-action",
          playerRuleRef: null
        }
      ]
    }
  );
  assert.deepEqual(result, { players: [null, { health: 2 }] });
  assert.doesNotMatch(JSON.stringify(result), /private/u);
});

test("projection refuses missing fields and object-valued allowlist leaves", () => {
  assert.throws(
    () => projectPlaytestVisibleObservation({ room: "hall" }, contract),
    /player.health.*missing/u
  );
  assert.throws(
    () =>
      projectPlaytestVisibleObservation(
        { state: { health: 4, secret: "hidden" } },
        {
          ...contract,
          fields: [
            {
              fieldPath: "state",
              unit: null,
              displayRounding: null,
              revelationTiming: "before-action",
              playerRuleRef: null
            }
          ]
        }
      ),
    /object-valued allowlisted fields/iu
  );
});
