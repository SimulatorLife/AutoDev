import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildPlaytestFindingIdentity,
  type ControlApiPlaytestingEpisodeDetailResponse,
  type ControlApiPlaytestingHumanValidationResponse,
  type ControlApiPlaytestingWindowResponse,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReview,
  type WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parsePlaytestingScope } from "../src/features/playtesting/playtesting-url.ts";
import { PlaytestingSessionsWorkspace } from "../src/features/playtesting/PlaytestingSessionsWorkspace.ts";
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
    schema: "autodev-playtest-episode-v4",
    episodeId: "episode-17",
    revision: 2,
    batchId: "batch-1",
    assignmentId: "a-0017",
    branchLineage: null,
    identity: {
      workspaceId: WORKSPACE,
      repository: WORKSPACE,
      buildSha: BUILD_SHA,
      gameBuild: "fixture-build",
      scenarioId: "tutorial",
      configHash: "config-hash",
      seed: "seed-17",
      rngInitialStateHash: "b".repeat(64),
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
    termination: { reason: "game-terminal", step: 2 },
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

/** A fetched window whose lines record different subsets of the same fields. */
function traceWindow(): ControlApiPlaytestingWindowResponse {
  return {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: "episode-17",
    artifactId: "trace-window-1",
    sha256: "b".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 2,
    sourceLineCount: 2,
    omittedLineCount: 0,
    entries: [
      {
        type: "event",
        event: {
          step: 1,
          eventId: "event-1",
          type: "choice-applied",
          tick: 7,
          severity: "info"
        },
        action: { actionId: "advance" },
        phase: { phaseId: "tutorial" }
      },
      {
        type: "event",
        event: { step: 2, eventId: "event-2", type: "legal-action-rejected" }
      }
    ]
  };
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
      },
      sessionsWorkspace: React.createElement(
        "p",
        null,
        "No sessions match these filters."
      )
    })
  );
  assert.match(html, /aria-label="Playtesting views"/u);
  assert.match(html, /aria-current="page"/u);
  assert.match(html, /disabled; history is read-only/u);
  assert.match(html, /No sessions match these filters/u);
  assert.match(html, /name="workspaceId"/u);
  assert.match(html, /name="limit"/u);
});

test("session rows own analyst selection and link directly to diagnosis", () => {
  const current = episode();
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [current],
      total: 1,
      nextCursor: null
    })
  );
  assert.match(html, /data-playtesting-session-select="episode-17"/u);
  assert.match(html, /Include session episode-17 in analyst review/u);
  assert.match(html, /data-playtest-episode-link="episode-17"/u);
  assert.match(html, /Inspect/u);
  assert.doesNotMatch(html, /playtesting-selection-option/u);
  assert.match(html, /0 of 40 selected/u);
});

test("finding witness links open the exact cited step while execution and outcome remain distinct", () => {
  const identity = buildPlaytestFindingIdentity({
    workspaceId: WORKSPACE,
    mechanicKey: "action-execution",
    failureSignature: {
      events: ["legal-action-rejected"],
      action: "advance",
      witness: "tutorial-step-2"
    },
    scope: {
      scenarioFamily: "tutorial",
      phase: "tutorial",
      modality: "headless"
    }
  });
  const fingerprint = createHash("sha256")
    .update(playtestFindingIdentityHashInput(identity))
    .digest("hex");
  const finding: PlaytestFinding = {
    identity,
    fingerprint,
    findingId: "finding-" + fingerprint,
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
  const unknownFrequencyHtml = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "findings", severity: "major" }),
      workspaces: [workspace],
      list: {
        resource: "findings",
        rows: [
          {
            ...finding,
            affectedEpisodes: null,
            totalEligibleEpisodes: null,
            affectedOpportunities: null,
            totalEligibleOpportunities: null
          }
        ],
        total: 1,
        nextCursor: null
      }
    })
  );
  assert.match(unknownFrequencyHtml, /Not observed/u);
  assert.doesNotMatch(unknownFrequencyHtml, /null \/ null/u);
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

test("inspector renders each review claim with its exact citations and legacy missing-citation state", () => {
  const review: PlaytestSessionReview = {
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    reviewId: "review-episode-17",
    version: 1,
    episodeId: "episode-17",
    supersedes: null,
    evidencePacket: {
      packetId: "packet-episode-17",
      artifact: {
        artifactId: "packet-artifact",
        sha256: "c".repeat(64),
        bytes: 128,
        mediaType: "application/vnd.autodev.playtest-evidence-packet+json"
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    rubricHash: "d".repeat(64),
    measurementVersion: "playtesting-measurement-v2",
    provenance: {
      workspaceId: WORKSPACE,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: "2026-10-12T00:00:00.000Z"
    },
    chronologicalSummary: "A source-linked review summary.",
    authoritativeMetrics: [],
    observations: [
      {
        text: "The collision was emitted after the jump action.",
        evidenceRefs: [
          { kind: "event", id: "event-1", step: 1, revision: 2 },
          { kind: "episode", id: "episode-18" }
        ]
      }
    ],
    interpretations: [
      { text: "The policy may have missed a safer choice.", evidenceRefs: [] }
    ],
    anchors: [],
    alternativeExplanations: [],
    reportCompleteness: {
      crossSessionContext: {
        status: "available",
        evidenceRefs: [{ kind: "episode", id: "episode-18" }]
      },
      alternatives: {
        status: "none-identified",
        reason: "No alternative is included in this fixture."
      },
      experiments: {
        status: "none-recommended",
        reason: "No experiment is included in this fixture."
      },
      followUp: {
        status: "none",
        reason: "No follow-up is included in this fixture."
      }
    },
    experiments: [],
    status: "hypothesis",
    findings: [],
    evidenceRefs: [
      { kind: "episode", id: "episode-17" },
      { kind: "event", id: "event-1", step: 1, revision: 2 }
    ],
    createdAt: "2026-10-12T00:00:00.000Z",
    notes: ""
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), latestReview: review },
      scope: scope({ view: "sessions" }),
      window: null
    })
  );
  assert.match(html, /The collision was emitted after the jump action/u);
  assert.match(html, /data-review-claim-evidence="event-1"/u);
  assert.match(html, /data-review-claim-evidence="episode-18"/u);
  assert.match(html, /href="[^"]*sessions\/episode-18/u);
  assert.match(html, /event event-1/u);
  assert.match(html, /step=1/u);
  assert.match(html, /The policy may have missed a safer choice/u);
  assert.match(html, /No citations recorded/u);
  assert.match(html, /Review completeness and follow-up/u);
  assert.match(html, /Cross-session context/u);
  assert.match(html, /Cites 1 packet-supplied sibling episode/u);
  assert.match(html, /data-cross-session-episode="episode-18"/u);
  assert.match(html, /episode episode-18/u);
  assert.match(html, /Alternative explanations/u);
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

test("inspector renders each recorded step as a summary of the fields that line records", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", step: "1" }),
      window: traceWindow()
    })
  );
  assert.match(
    html,
    /Event choice-applied · event event-1 · Selected action advance · Phase tutorial · Tick 7 · Severity info/u
  );
  assert.match(html, /Event legal-action-rejected · event event-2<\/p>/u);
  assert.match(html, /data-trace-fact="action"/u);
  assert.match(html, /data-trace-fact="phase"/u);
  // The line type names the line, so it is reported as its own dimension
  // rather than being read as the event's name.
  assert.match(html, /data-trace-fact="line-type"/u);
  // A dimension a line does not record stays unrecorded: step 2 records no
  // action or phase, and neither fact is carried over from step 1.
  const stepTwoMarker = 'data-playtest-step="2"';
  const stepTwoIndex = html.indexOf(stepTwoMarker);
  const stepTwo = stepTwoIndex === -1 ? "" : html.slice(stepTwoIndex);
  assert.match(
    stepTwo,
    /data-trace-fact="action"[^]*?data-trace-fact-state="unrecorded"/u
  );
  assert.match(
    stepTwo,
    /data-trace-fact="phase"[^]*?data-trace-fact-state="unrecorded"/u
  );
});

test("a loop-guard stop explains the repeated decision and opens its stop step by default", () => {
  const partialEpisode: PlaytestEpisode = {
    ...episode(),
    status: "budget-truncated",
    termination: { reason: "loop-guard", step: 2 },
    outcome: "unknown",
    completeness: "partial",
    missingReasons: ["budget-truncated"]
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(partialEpisode),
      scope: scope({ view: "sessions" }),
      window: traceWindow()
    })
  );
  const explanation =
    /data-testid="playtesting-truncation-explanation"[^>]*>([^<]*)/u.exec(
      html
    )?.[1] ?? "";
  assert.match(explanation, /No terminal game outcome was observed/u);
  assert.match(explanation, /no win or loss is inferred/u);
  assert.match(explanation, /loop guard stopped at step 2/u);
  assert.match(explanation, /action was not executed/u);
  assert.match(html, /data-playtesting-stop-step="2"/u);
  assert.match(html, /href="[^"]*step=2"[^>]*>Inspect stop at step 2/u);
  assert.match(
    html,
    /<details(?=[^>]*data-playtest-step-details="2")(?=[^>]*open="")[^>]*>/u
  );
  assert.match(html, /Game outcome<\/dt>[^]*?Not observed[^]*?unknown/u);
  assert.doesNotMatch(explanation, /Game lost|Player lost/u);
});

test("a step-limit stop says how many decisions ran without inventing a game outcome", () => {
  const partialEpisode: PlaytestEpisode = {
    ...episode(),
    status: "budget-truncated",
    termination: { reason: "step-limit", step: null },
    outcome: "unknown",
    stepCount: 1200,
    completeness: "partial",
    missingReasons: ["budget-truncated"]
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(partialEpisode),
      scope: scope({ view: "sessions" }),
      window: traceWindow()
    })
  );
  assert.match(
    html,
    /Runtime reached the episode step limit after 1200 executed decisions/u
  );
  assert.doesNotMatch(html, /Inspect stop at step/u);
});

test("step details open only for the addressed step and raw trace JSON stays collapsed", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", step: "1" }),
      window: traceWindow()
    })
  );
  const stepDetails =
    html.match(/<details\b[^>]*data-playtest-step-details[^>]*>/gu) ?? [];
  const rawJsonDetails =
    html.match(/<details\b[^>]*data-playtest-json="true"[^>]*>/gu) ?? [];
  assert.equal(stepDetails.length, 2);
  assert.equal(stepDetails.filter((tag) => /\sopen=""/u.test(tag)).length, 1);
  assert.equal(rawJsonDetails.length, 2);
  assert.equal(
    rawJsonDetails.filter((tag) => /\sopen=""/u.test(tag)).length,
    0
  );
  assert.match(html, /aria-label="Recorded data for step 1"/u);
  assert.match(html, /aria-label="Recorded data for step 2"/u);
  // The disclosure hides nothing: the recorded line itself is still rendered
  // verbatim behind the collapsed summary.
  assert.match(html, /&quot;eventId&quot;: &quot;event-2&quot;/u);
  assert.match(html, /Recorded JSON/u);
});

test("RacingGame-shaped trace lines summarize recorded events and keep JSON closed by default", () => {
  const racingWindow: ControlApiPlaytestingWindowResponse = {
    ...traceWindow(),
    startStep: 0,
    endStep: 0,
    entries: [
      {
        step: 0,
        selectedActionId: "select-ticket:ticket_bottom3_team_apex",
        visibleObservation: { phaseId: "read_and_bet" },
        events: [
          {
            eventId: "evt-1",
            type: "decision_applied",
            phaseId: "read_and_bet"
          }
        ]
      }
    ]
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions" }),
      window: racingWindow
    })
  );
  assert.match(html, /Event decision_applied/u);
  assert.match(html, /event evt-1/u);
  assert.match(html, /Selected action select-ticket:ticket_bottom3_team_apex/u);
  assert.match(html, /Phase read_and_bet/u);
  assert.doesNotMatch(html, /No event, selected action or phase is recorded/u);
  assert.doesNotMatch(html, /data-trace-fact="tick"/u);
  assert.doesNotMatch(html, /data-trace-fact="severity"/u);
  assert.doesNotMatch(html, /data-trace-fact="line-type"/u);
  assert.match(html, /<details[^>]*data-playtest-json="true"/u);
  assert.doesNotMatch(html, /<details[^>]*open=""[^>]*data-playtest-json/u);
});

test("step navigation moves within the fetched window and preserves list state", () => {
  const selected = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", cursor: "page-2", step: "1" }),
      window: traceWindow()
    })
  );
  // Step 1 is the first indexed step this window holds, so there is nothing
  // before it; the next step is a link that keeps workspace and cursor state.
  assert.match(selected, /data-playtest-step-prev="disabled"/u);
  assert.match(selected, /data-playtest-step-next="2"/u);
  assert.match(
    selected,
    /href="\/playtesting\/sessions\/episode-17\?view=sessions&amp;workspaceId=owner%2Fgame&amp;cursor=page-2&amp;step=2"/u
  );
  const last = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", step: "2" }),
      window: traceWindow()
    })
  );
  assert.match(last, /data-playtest-step-next="disabled"/u);
  assert.match(last, /data-playtest-step-prev="1"/u);
  // Navigation never leaves the fetched window, so it cannot address a step
  // this page has no evidence for.
  assert.doesNotMatch(last, /step=3/u);
});

test("session status strip stays scannable and keeps exact tokens in a disclosure", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(),
      scope: scope({ view: "sessions", step: "1" }),
      window: traceWindow()
    })
  );
  for (const dimension of [
    "game-outcome",
    "execution-status",
    "replay-integrity",
    "evidence-completeness"
  ]) {
    assert.match(html, new RegExp(`data-status-dimension="${dimension}"`, "u"));
  }
  assert.match(html, /aria-label="Independent session status dimensions"/u);
  assert.match(html, /data-playtesting-analyze-session="episode-17"/u);
  assert.match(html, /sessions=episode-17/u);
  // The first scan is human-readable; exact stored values remain available in
  // one collapsed disclosure rather than being repeated beside every badge.
  assert.match(html, /Game outcome<\/dt>[^]*?LOSS/u);
  assert.match(html, /Execution status<\/dt>[^]*?Completed/u);
  assert.match(html, /Replay integrity<\/dt>[^]*?Trace replayable/u);
  assert.match(html, /Evidence completeness<\/dt>[^]*?Complete/u);
  assert.match(html, /data-recorded-session-status="true"/u);
  assert.match(html, /Game outcome token<\/dt>[^]*?<dd[^>]*>loss<\/dd>/u);
  assert.match(
    html,
    /Execution status token<\/dt>[^]*?<dd[^>]*>completed<\/dd>/u
  );
});

test("Compare shows native human outcomes separately and never reconstructs suppressed cells", () => {
  const comparison: PlaytestComparison = {
    schema: "autodev-playtest-comparison-v2",
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
    measurementVersion: "playtesting-measurement-v2",
    metrics: [],
    decision: "hold-inconclusive",
    ownerDecisionAt: "2026-10-10T00:00:00.000Z",
    ownerDecisionReason: "Wait for a fresh confirmation cohort.",
    ownerDecisionBy: "release-owner",
    ownerDisposition: "hold",
    humanPreference: { answer: "not-collected", interval: null },
    provenance: {
      workspaceId: WORKSPACE,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: "2026-10-10T00:00:00.000Z"
    },
    notes: "Synthetic view fixture."
  };
  const humanValidation: ControlApiPlaytestingHumanValidationResponse = {
    schema: "autodev-control-playtesting-human-validation-v1",
    workspaceId: WORKSPACE,
    studyId: "study-1",
    buildSha: "b".repeat(40),
    preference: {
      analysisPlanRef: "paired-preference-plan-v1",
      suppressionState: "unsuppressed",
      incompleteExposurePairs: 0,
      counts: {
        eligibleParticipants: 10,
        preferA: 1,
        preferB: 5,
        ties: 1,
        unableToJudge: 1,
        missing: 2
      },
      interval: {
        lower: 0.65,
        upper: 0.95,
        method: "scipy-binomial-exact",
        libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      },
      decision: "supports-b-preference",
      reasons: []
    },
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
  assert.match(
    html,
    /hold by release-owner: Wait for a fresh confirmation cohort/u
  );
  assert.match(html, /Human validation/u);
  assert.match(html, /miniPXI/u);
  assert.match(html, /Suppressed to protect small cells/u);
  assert.match(html, /Paired-build preference \(separate from PXI\)/u);
  assert.match(html, /Eligible completed pairs 10 · A 1 · B 5/u);
  assert.match(
    html,
    /Evidence supports a preference for build B beyond the registered margin/u
  );
  assert.match(html, /Pr\(B preferred \| decisive response\)/u);
  assert.match(html, /exact interval \[0.650, 0.950\]/u);
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
