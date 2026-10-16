import assert from "node:assert/strict";
import test from "node:test";

import {
  type PlaytestCrossSessionSynthesis,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parsePlaytestingScope } from "../src/features/playtesting/playtesting-url.ts";
import { PlaytestingAnalysisResults } from "../src/features/playtesting/PlaytestingAnalysisResults.ts";
import { PlaytestingSelectionPanel } from "../src/features/playtesting/PlaytestingSelectionPanel.ts";

const scope = parsePlaytestingScope({
  view: "sessions",
  workspaceId: "fixture/game"
});

const run = {
  analysisId: "analysis-1",
  workspaceId: "fixture/game",
  status: "completed" as const,
  createdAt: "2026-10-14T12:00:00.000Z",
  finishedAt: "2026-10-14T12:00:05.000Z",
  requestedEpisodeIds: ["episode-1", "episode-2"],
  packets: [
    {
      episodeId: "episode-1",
      batchId: "batch-1",
      packetId: "packet-1"
    }
  ],
  receipts: [
    {
      episodeId: "episode-2",
      batchId: null,
      reason: "unknown-session",
      detail: "The session does not exist in the authorized workspace."
    }
  ],
  budget: [],
  reviews: [
    {
      episodeId: "episode-1",
      reviewId: "review-1",
      status: "hypothesis" as const
    }
  ],
  synthesisId: null,
  error: null
};

test("multi-session Console action starts the bounded read-only analyst role", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingSelectionPanel, {
      scope,
      selectedEpisodeIds: ["episode-1"],
      rejectedSelection: false,
      onSelectionChange: () => {}
    })
  );

  assert.match(markup, /Multi-session analyst review/u);
  assert.match(markup, /Analyze selected sessions/u);
  assert.match(markup, /Optional read-only review/u);
  assert.match(markup, /This does not run gameplay/u);
  assert.match(markup, /Start analyst review/u);
});

test("the full first-milestone critique ceiling remains selectable", () => {
  const selectedEpisodeIds = Array.from(
    { length: 40 },
    (_, index) => `episode-${String(index + 1)}`
  );
  const selectionScope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: "fixture/game",
    sessions: selectedEpisodeIds.join(",")
  });
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingSelectionPanel, {
      scope: selectionScope,
      selectedEpisodeIds: selectionScope.selectedEpisodeIds,
      rejectedSelection: selectionScope.invalidSelection,
      onSelectionChange: () => {}
    })
  );

  assert.equal(selectionScope.selectedEpisodeIds.length, 40);
  assert.match(markup, /data-selected="40"/u);
  assert.doesNotMatch(markup, /playtesting-selection-invalid-query/u);
  assert.doesNotMatch(markup, /Start analyst review" disabled/u);
});

test("an oversized shareable selection is explicitly rejected without truncation", () => {
  const oversizedSelection = Array.from(
    { length: 41 },
    (_, index) => `episode-${String(index + 1)}`
  ).join(",");
  const rejectedScope = parsePlaytestingScope({
    view: "sessions",
    workspaceId: "fixture/game",
    sessions: oversizedSelection
  });
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingSelectionPanel, {
      scope: rejectedScope,
      selectedEpisodeIds: rejectedScope.selectedEpisodeIds,
      rejectedSelection: rejectedScope.invalidSelection,
      onSelectionChange: () => {}
    })
  );

  assert.equal(rejectedScope.selectedEpisodeIds.length, 0);
  assert.match(markup, /shared session selection was rejected/u);
  assert.match(markup, /nothing was truncated or started/u);
  assert.match(markup, /data-selected="0"/u);
  assert.match(markup, /disabled=""/u);
});

test("dispatch with no prepared packet renders the Runtime receipt and session link", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingAnalysisResults, {
      scope,
      result: {
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "dispatch",
        workspaceId: "fixture/game",
        requested: 1,
        packets: [],
        receipts: [
          {
            episodeId: "episode-unverified",
            batchId: "batch-unverified",
            reason: "packet-unavailable",
            detail:
              "Player-visible analyst review is withheld because the game's observation/UI equivalence is unverified for this episode's trace; the step is recorded without being projected into player-visible evidence."
          }
        ],
        budget: [],
        analysis: null
      },
      runs: [],
      syntheses: [],
      stale: false
    })
  );

  assert.match(markup, /No analyst process was started/u);
  assert.match(markup, /playtesting-analysis-dispatch-receipt/u);
  assert.match(markup, /packet-unavailable/u);
  assert.match(markup, /observation\/UI equivalence is unverified/u);
  assert.match(markup, /Open session episode-unverified/u);
});

test("persisted analyst review and unavailable receipts link to their full session details", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingAnalysisResults, {
      scope,
      result: null,
      runs: [run],
      syntheses: [],
      stale: false
    })
  );

  assert.match(
    markup,
    /Analyst process completed; 1 of 2 selected sessions have a persisted review./u
  );
  assert.match(markup, /playtesting-analysis-review-link/u);
  assert.match(markup, /Open hypothesis review for episode-1/u);
  assert.match(
    markup,
    /href="\/playtesting\/sessions\/episode-1\?view=sessions&amp;workspaceId=fixture%2Fgame"/u
  );
  assert.match(markup, /Open session episode-2/u);
  assert.match(
    markup,
    /href="\/playtesting\/sessions\/episode-2\?view=sessions&amp;workspaceId=fixture%2Fgame"/u
  );
  assert.match(markup, /does not exist in the authorized workspace/u);
});

test("persisted cross-session synthesis remains visible when Runtime task history is absent", () => {
  const synthesis: PlaytestCrossSessionSynthesis = {
    schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
    synthesisId: "synthesis-1",
    version: 1,
    analysisId: "analysis-1",
    workspaceId: "fixture/game",
    authorRole: "playtest-analyst",
    authorId: "analyst-fixture",
    modelId: null,
    modelRevision: null,
    promptHash: null,
    generatedAt: "2026-10-14T12:00:00.000Z",
    status: "hypothesis",
    summary: "The warning recurs before a no-progress action.",
    packetEligibleEpisodeIds: ["episode-1", "episode-2"],
    contributors: [
      { episodeId: "episode-1", batchId: "batch-1", packetId: "packet-1" },
      { episodeId: "episode-2", batchId: "batch-2", packetId: "packet-2" }
    ],
    metricAggregation: {
      schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
      workspaceId: "fixture/game",
      analysisId: "analysis-1",
      status: "available",
      method: "ratio-of-sums-within-identical-stratum-v1",
      sourcePackets: [
        { episodeId: "episode-1", batchId: "batch-1", packetId: "packet-1" },
        { episodeId: "episode-2", batchId: "batch-2", packetId: "packet-2" }
      ],
      rows: [
        {
          metricId: "legal-action-rejection",
          metricVersion: 1,
          phaseId: "race",
          unit: "proportion",
          aggregation: "ratio-of-sums-within-scenario",
          analysisUnit: "episode",
          aggregationWindow: "phase",
          buildSha: "a".repeat(40),
          gameBuild: "fixture-build",
          rubricHash: "b".repeat(64),
          evaluatorHash: "c".repeat(64),
          measurementVersion: "measurement-v2",
          scenarioId: "standard",
          scenarioFamily: "race",
          policyId: "heuristic",
          policyVersion: "v1",
          cohort: "novice",
          observationMode: "headless",
          sourcePacketIndices: [0, 1],
          sessionCount: 2,
          numerator: 2,
          denominator: 5,
          opportunityCount: 6,
          missing: 1,
          missingReasons: [],
          estimate: 0.4,
          coverage: 5 / 6,
          independentUnits: 2
        }
      ],
      omittedMetrics: [],
      reason: null
    },
    claims: [
      {
        kind: "pattern",
        text: "The same warning preceded the no-progress action in both sessions.",
        evidenceRefs: [
          {
            episodeId: "episode-1",
            packetId: "packet-1",
            locator: { kind: "event", id: "event-1", step: 2 }
          },
          {
            episodeId: "episode-2",
            packetId: "packet-2",
            locator: { kind: "event", id: "event-2", step: 2 }
          }
        ]
      }
    ],
    experiments: []
  };
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingAnalysisResults, {
      scope,
      result: null,
      runs: [],
      syntheses: [synthesis],
      stale: false
    })
  );

  assert.match(markup, /Saved batch-level synthesis/u);
  assert.match(markup, /hypotheses only/u);
  assert.match(markup, /same warning preceded/u);
  assert.match(markup, /data-synthesis-citation="episode-1"/u);
  assert.match(markup, /data-synthesis-citation="episode-2"/u);
  assert.match(markup, /Deterministic selected-session metrics/u);
  assert.match(markup, /2 \/ 5 proportion · ratio 0.4/u);
  assert.match(markup, /This is not a matched-seed effect/u);
  assert.match(markup, /data-aggregate-source="episode-1"/u);
});

test("status failures are rendered as stale rather than current", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingAnalysisResults, {
      scope,
      result: null,
      runs: [run],
      syntheses: [],
      stale: true
    })
  );

  assert.match(markup, /data-analysis-status="stale"/u);
  assert.match(markup, /Last known status/u);
});
