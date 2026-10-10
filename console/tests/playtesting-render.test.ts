import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiPlaytestingEpisodeDetailResponse,
  ControlApiPlaytestingHumanValidationResponse,
  ControlApiPlaytestingWindowResponse,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestFinding,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parsePlaytestingScope } from "../src/features/playtesting/playtesting-url.ts";
import { PlaytestingSessionView } from "../src/features/playtesting/PlaytestingSessionView.ts";
import { PlaytestingView } from "../src/features/playtesting/PlaytestingView.ts";

const WORKSPACE = "owner/game";
const BUILD_SHA = "a".repeat(40);
const workspace: WorkspaceEntry = {
  id: WORKSPACE,
  baseBranch: "main",
  enabled: false,
  agentRoles: null
};

function episode(): PlaytestEpisode {
  return {
    schema: "autodev-playtest-episode-v1",
    episodeId: "episode-17",
    revision: 2,
    batchId: "batch-1",
    identity: {
      workspaceId: WORKSPACE,
      repository: WORKSPACE,
      buildSha: BUILD_SHA,
      gameBuild: "fixture-build",
      scenarioId: "tutorial",
      configHash: "config-hash",
      seed: "seed-17",
      rngAlgorithm: "fixture-rng",
      rngVersion: "1",
      policyId: "weak-bot",
      policyVersion: "v1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: "obs-hash",
      actionSchemaHash: "action-hash",
      eventSchemaHash: "event-hash",
      protocolVersion: 1,
      runtimeVersion: "runtime-v1",
      environmentHash: "env-hash"
    },
    scenarioFamily: "tutorial",
    policyCohort: "novice",
    strategy: "weak-policy-fixture",
    status: "completed",
    outcome: "loss",
    outcomeMetrics: {},
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: 1,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 1
    },
    replayStatus: "trace-replayable",
    trace: { kind: "replay-segment", id: "trace-window-1" },
    frames: [],
    stepCount: 3,
    metrics: [],
    findingIds: [],
    assignedAt: "2026-10-10T00:00:00.000Z",
    startedAt: "2026-10-10T00:00:01.000Z",
    completedAt: "2026-10-10T00:00:02.000Z",
    simulationWallMs: 100,
    logicalTicks: 3,
    policyInferenceMs: 1,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  };
}

function detail(
  record = episode()
): ControlApiPlaytestingEpisodeDetailResponse {
  return {
    schema: "autodev-control-playtesting-detail-v1",
    workspaceId: WORKSPACE,
    resource: "episode",
    readOnly: true,
    record,
    latestReview: null
  };
}

function scope(
  input: Record<string, string | readonly string[] | undefined> = {}
) {
  return parsePlaytestingScope({ workspaceId: WORKSPACE, ...input });
}

test("Playtesting list view uses accessible links and explicit empty/unavailable distinctions", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "sessions" }),
      workspaces: [workspace],
      list: {
        resource: "episodes",
        rows: [],
        total: 0,
        nextCursor: null
      }
    })
  );
  assert.match(html, /aria-label="Playtesting views"/u);
  assert.match(html, /aria-current="page"/u);
  assert.match(html, /disabled; history is read-only/u);
  assert.match(html, /No playtest episodes are recorded/u);
  assert.match(html, /name="workspaceId"/u);
  assert.match(html, /name="limit"/u);
});

test("finding witness links open the exact cited step while execution and outcome remain distinct", () => {
  const finding: PlaytestFinding = {
    findingId: "finding-1",
    version: 1,
    title: "A legal choice is rejected",
    description: "Synthetic fixture only.",
    severity: "major",
    status: "open",
    verificationStage: "not-yet-validated",
    evidenceStatus: "hypothesis",
    affectedEpisodes: 1,
    totalEligibleEpisodes: 4,
    affectedOpportunities: 1,
    totalEligibleOpportunities: 8,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-17", step: 2 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: null,
    nextReviewAt: null
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "findings", severity: "major" }),
      workspaces: [workspace],
      list: {
        resource: "findings",
        rows: [finding],
        total: 1,
        nextCursor: null
      }
    })
  );
  assert.match(html, /episode-17/iu);
  assert.match(html, /step=2/u);
  assert.match(html, /Episodes affected/u);
});

test("inspector renders only recorded structured evidence and labels missing frames and review", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", cursor: "page-2", step: "1" }),
      window: null
    })
  );
  assert.match(html, /Execution status/u);
  assert.match(html, /Game outcome/u);
  assert.match(html, /Completed/u);
  assert.match(html, /LOSS/u);
  assert.match(html, /No frame was recorded/u);
  assert.match(html, /No analyst review is recorded/u);
  assert.match(html, /Back to sessions/u);
  assert.match(html, /cursor=page-2/u);
  assert.doesNotMatch(html, /<video|<img/u);
});

test("inspector step window shows an exact recorded event and preserves episode source", () => {
  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: "episode-17",
    artifactId: "trace-window-1",
    sha256: "b".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 2,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        type: "event",
        event: { step: 1, eventId: "event-1", type: "choice-applied" }
      }
    ]
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", step: "1" }),
      window
    })
  );
  assert.match(html, /event-1/u);
  assert.match(html, /aria-current="step"/u);
  assert.match(html, /step=1/u);
  assert.match(html, /SHA-256/u);
});

test("recorded frame references render lazy same-origin authorized image routes", () => {
  const record = {
    ...episode(),
    frames: [{ kind: "frame", id: "frame-1", frameIndex: 0, step: 1 }]
  } as PlaytestEpisode;
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(record),
      scope: scope({ view: "sessions", step: "1" }),
      window: null
    })
  );
  assert.match(html, /<img/u);
  assert.match(
    html,
    /\/api\/playtesting\/episodes\/episode-17\/media\/frame-1\?workspaceId=owner%2Fgame/u
  );
  assert.match(html, /Recorded game frame 1 at step 1/u);
  assert.match(html, /loading="lazy"/u);
});

test("Compare shows native human outcomes separately and never reconstructs suppressed cells", () => {
  const comparison: PlaytestComparison = {
    schema: "autodev-playtest-comparison-v1",
    comparisonId: "comparison-1",
    version: 1,
    benchmarkId: "benchmark-1",
    experimentId: "experiment-1",
    baseline: { id: BUILD_SHA, version: 1 },
    candidate: { id: "b".repeat(40), version: 1 },
    freezeStatus: "frozen",
    pairing: {
      mode: "paired-initial-condition",
      pairMap: {},
      allocationPlanHash: null,
      rngAlgorithm: "fixture-rng",
      rngStreamVersion: "v1",
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: [],
    episodeRefs: [],
    measurementVersion: "playtesting-measurement-v1",
    metrics: [],
    decision: "hold-inconclusive",
    ownerDecisionAt: null,
    ownerDecisionReason: null,
    humanPreference: { answer: "not-collected", interval: null },
    provenance: {
      workspaceId: WORKSPACE,
      measurementVersion: "playtesting-measurement-v1",
      generatedAt: "2026-10-10T00:00:00.000Z"
    },
    notes: "Synthetic view fixture."
  };
  const humanValidation: ControlApiPlaytestingHumanValidationResponse = {
    schema: "autodev-control-playtesting-human-validation-v1",
    workspaceId: WORKSPACE,
    studyId: "study-1",
    buildSha: "b".repeat(40),
    summary: {
      revision: 2,
      benchmarkId: comparison.benchmarkId,
      instrument: "miniPXI",
      measurementVersion: comparison.measurementVersion,
      suppressionState: "suppressed",
      retainedParticipants: null,
      items: [
        {
          itemId: "ENJ",
          suppressionState: "suppressed",
          mean: null,
          respondentCount: null,
          missingCount: null,
          categoryCounts: null,
          unit: "native-Likert-minus3-plus3"
        }
      ],
      constructs: [],
      pairedDifferences: []
    }
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "compare", benchmarkId: comparison.benchmarkId }),
      workspaces: [workspace],
      list: {
        resource: "comparisons",
        rows: [comparison],
        total: 1,
        nextCursor: null,
        humanValidation: {
          kind: "available",
          studyId: "study-1",
          data: humanValidation
        }
      }
    })
  );
  assert.match(html, /Human validation/u);
  assert.match(html, /miniPXI/u);
  assert.match(html, /Suppressed to protect small cells/u);
  assert.match(html, /Not collected/u);
  assert.doesNotMatch(
    html,
    /participantId|responseId|pseudonymousParticipantId/u
  );
});

test("Compare labels an absent human study as not collected rather than zero", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "compare" }),
      workspaces: [workspace],
      list: {
        resource: "comparisons",
        rows: [],
        total: 0,
        nextCursor: null,
        humanValidation: {
          kind: "not-collected",
          reason: "No approved human study exists for this benchmark."
        }
      }
    })
  );
  assert.match(html, /Human validation/u);
  assert.match(html, /Not collected/u);
  assert.doesNotMatch(html, /ENJ: 0/u);
});
