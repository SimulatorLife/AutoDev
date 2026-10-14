import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestCrossSessionSynthesis,
  type PlaytestCrossSessionSynthesis,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA
} from "../src/playtesting/index.ts";

const contributors = [
  { episodeId: "episode-1", batchId: "batch-1", packetId: "packet-1" },
  { episodeId: "episode-2", batchId: "batch-2", packetId: "packet-2" }
] as const;

function synthesis(
  overrides: Partial<PlaytestCrossSessionSynthesis> = {}
): PlaytestCrossSessionSynthesis {
  return {
    schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
    synthesisId: "synthesis-1",
    version: 1,
    analysisId: "analysis-1",
    workspaceId: "SimulatorLife/RacingGame",
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    modelId: "autodev/smart",
    modelRevision: null,
    promptHash: null,
    generatedAt: "2026-10-14T12:00:00.000Z",
    status: "hypothesis",
    summary: "A repeated warning precedes a no-progress action.",
    contributors,
    packetEligibleEpisodeIds: contributors.map((entry) => entry.episodeId),
    metricAggregation: {
      schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
      workspaceId: "SimulatorLife/RacingGame",
      analysisId: "analysis-1",
      status: "no-applicable-metrics",
      method: "ratio-of-sums-within-identical-stratum-v1",
      sourcePackets: contributors,
      rows: [],
      omittedMetrics: [],
      reason: "no-applicable-metric-rows"
    },
    claims: [
      {
        kind: "pattern",
        text: "Both episodes show the warning before the action fails to progress.",
        evidenceRefs: contributors.map((contributor) => ({
          episodeId: contributor.episodeId,
          packetId: contributor.packetId,
          locator: {
            kind: "event" as const,
            id: `warning-${contributor.episodeId}`,
            step: 2
          }
        }))
      }
    ],
    experiments: [
      {
        hypothesis:
          "Changing the feedback timing will reduce repeated no-progress actions.",
        falsifier:
          "The no-progress rate remains unchanged under matched seeds.",
        metricId: "no-progress-action",
        controls: ["Use the same scenarios and seeds."],
        budget: "Two matched episodes per policy.",
        evidenceRefs: [
          {
            episodeId: "episode-1",
            packetId: "packet-1",
            locator: { kind: "episode", id: "episode-1" }
          }
        ]
      }
    ],
    ...overrides
  };
}

test("cross-session synthesis accepts claims cited to each exact contributing packet", () => {
  assert.doesNotThrow(() => assertPlaytestCrossSessionSynthesis(synthesis()));
});

test("cross-session synthesis rejects one-session reports and duplicate contributors", () => {
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis(
        synthesis({ contributors: [contributors[0]] })
      ),
    /2–40 distinct contributing sessions/u
  );
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis(
        synthesis({ contributors: [contributors[0], contributors[0]] })
      ),
    /distinct bounded packet identities/u
  );
});

test("cross-session citations cannot be reassigned to a different episode packet", () => {
  const value = synthesis();
  const firstClaim = value.claims[0]!;
  const firstReference = firstClaim.evidenceRefs[0]!;
  const forged = {
    ...value,
    claims: [
      {
        ...firstClaim,
        evidenceRefs: [
          { ...firstReference, packetId: "packet-2" },
          ...firstClaim.evidenceRefs.slice(1)
        ]
      }
    ]
  };
  assert.throws(
    () => assertPlaytestCrossSessionSynthesis(forged),
    /exact packet/u
  );
});

test("cross-session synthesis contributors must be a subset of the Runtime packet allowlist", () => {
  const value = synthesis();
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis({
        ...value,
        packetEligibleEpisodeIds: ["episode-1", "episode-outside-selection"]
      }),
    /distinct bounded packet identities/u
  );
});

test("cross-session synthesis requires each declared contributor to have a packet citation", () => {
  const value = synthesis();
  const singleSessionClaim = {
    ...value.claims[0]!,
    kind: "counterexample" as const,
    evidenceRefs: [value.claims[0]!.evidenceRefs[0]!]
  };
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis({
        ...value,
        claims: [singleSessionClaim]
      }),
    /cite every contributing packet/u
  );
});

test("cross-session synthesis rejects non-contributor citations and non-hypothesis verdicts", () => {
  const value = synthesis();
  const firstClaim = value.claims[0]!;
  const forged = {
    ...value,
    claims: [
      {
        ...firstClaim,
        evidenceRefs: [
          {
            episodeId: "episode-outside-selection",
            packetId: "packet-outside-selection",
            locator: {
              kind: "episode" as const,
              id: "episode-outside-selection"
            }
          }
        ]
      }
    ]
  };
  assert.throws(
    () => assertPlaytestCrossSessionSynthesis(forged),
    /exact packet/u
  );
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis({
        ...value,
        status: "verified" as "hypothesis"
      }),
    /identity is invalid/u
  );
});

test("cross-session synthesis remains bounded by the 40-session analysis limit", () => {
  const tooManyContributors = Array.from({ length: 41 }, (_, index) => ({
    episodeId: `episode-${String(index)}`,
    batchId: `batch-${String(index)}`,
    packetId: `packet-${String(index)}`
  }));
  assert.throws(
    () =>
      assertPlaytestCrossSessionSynthesis(
        synthesis({ contributors: tooManyContributors })
      ),
    /2–40 distinct contributing sessions/u
  );
});
