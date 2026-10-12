import assert from "node:assert/strict";
import test from "node:test";

import {
  type PlaytestNativeTimingInput,
  summarizePlaytestNativeTiming
} from "../src/playtesting/native-timing.ts";

const precedence = [
  "active-interaction",
  "required-animation",
  "deliberation",
  "idle"
] as const;

function input(
  overrides: Partial<PlaytestNativeTimingInput> = {}
): PlaytestNativeTimingInput {
  return {
    durationMs: 10,
    precedenceVersion: "ui-state-v1",
    precedence,
    intervals: [],
    ...overrides
  };
}

test("native timing resolves overlaps by the declared game-owned precedence", () => {
  const result = summarizePlaytestNativeTiming(
    input({
      intervals: [
        {
          state: "idle",
          startMs: 0,
          endMs: 10,
          precedenceVersion: "ui-state-v1"
        },
        {
          state: "required-animation",
          startMs: 2,
          endMs: 8,
          precedenceVersion: "ui-state-v1"
        },
        {
          state: "active-interaction",
          startMs: 4,
          endMs: 6,
          precedenceVersion: "ui-state-v1"
        }
      ]
    })
  );
  assert.deepEqual(
    result.intervals.map(({ state, startMs, endMs }) => ({
      state,
      startMs,
      endMs
    })),
    [
      { state: "idle", startMs: 0, endMs: 2 },
      { state: "required-animation", startMs: 2, endMs: 4 },
      { state: "active-interaction", startMs: 4, endMs: 6 },
      { state: "required-animation", startMs: 6, endMs: 8 },
      { state: "idle", startMs: 8, endMs: 10 }
    ]
  );
  assert.deepEqual(result.durationByStateMs, {
    "active-interaction": 2,
    "required-animation": 4,
    deliberation: 0,
    idle: 4,
    unknown: 0
  });
});

test("uncovered time and explicitly unknown intervals remain unknown", () => {
  const result = summarizePlaytestNativeTiming(
    input({
      durationMs: 12,
      intervals: [
        {
          state: "deliberation",
          startMs: 2,
          endMs: 5,
          precedenceVersion: "ui-state-v1"
        },
        {
          state: "unknown",
          startMs: 8,
          endMs: 10,
          precedenceVersion: "ui-state-v1"
        }
      ]
    })
  );
  assert.deepEqual(
    result.intervals.map(({ state, startMs, endMs }) => [
      state,
      startMs,
      endMs
    ]),
    [
      ["unknown", 0, 2],
      ["deliberation", 2, 5],
      ["unknown", 5, 12]
    ]
  );
  assert.equal(result.durationByStateMs.unknown, 9);
  assert.equal(
    Object.values(result.durationByStateMs).reduce(
      (sum, duration) => sum + duration,
      0
    ),
    result.durationMs
  );
});

test("native timing refuses mixed precedence versions and invalid contracts", () => {
  assert.throws(
    () =>
      summarizePlaytestNativeTiming(
        input({
          intervals: [
            {
              state: "idle",
              startMs: 0,
              endMs: 1,
              precedenceVersion: "stale-v0"
            }
          ]
        })
      ),
    /declared precedenceVersion/
  );
  assert.throws(
    () =>
      summarizePlaytestNativeTiming(
        input({
          precedence: [
            "idle",
            "idle"
          ] as unknown as PlaytestNativeTimingInput["precedence"]
        })
      ),
    /precedence must order each observable state/
  );
});

test("native timing refuses malformed or out-of-capture intervals instead of clipping", () => {
  for (const invalid of [
    { state: "idle", startMs: -1, endMs: 2, precedenceVersion: "ui-state-v1" },
    { state: "idle", startMs: 2, endMs: 2, precedenceVersion: "ui-state-v1" },
    { state: "idle", startMs: 2, endMs: 11, precedenceVersion: "ui-state-v1" },
    {
      state: "impossible",
      startMs: 0,
      endMs: 1,
      precedenceVersion: "ui-state-v1"
    }
  ]) {
    assert.throws(() =>
      summarizePlaytestNativeTiming(
        input({
          intervals: [invalid as PlaytestNativeTimingInput["intervals"][number]]
        })
      )
    );
  }
});

test("simulation and inference values cannot be mixed into native-state totals", () => {
  const result = summarizePlaytestNativeTiming(
    input({ durationMs: 35 * 60 * 1000 })
  );
  assert.equal(result.durationMs, 2_100_000);
  assert.equal(result.durationByStateMs.unknown, 2_100_000);
});
