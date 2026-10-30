import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildPlaytestFindingIdentity,
  type ControlApiPlaytestingEpisodeDetailResponse,
  type ControlApiPlaytestingHumanValidationResponse,
  type ControlApiPlaytestingWindowResponse,
  playtestAssignmentManifestHashInput,
  type PlaytestComparison,
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestSessionReview,
  type PlaytestVisualBatch,
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
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: "episode-17",
    revision: 2,
    batchId: "batch-1",
    assignmentId: "a-0017",
    branchLineage: null,
    playerDebrief: {
      schema: "autodev-playtest-player-debrief-v1",
      status: "absent",
      reason: "legacy-no-report"
    },
    executionProvenance: {
      mode: "adapter-accelerated",
      source: {
        kind: "repo-checkout",
        repository: WORKSPACE,
        revision: BUILD_SHA,
        revisionConfidence: "verified",
        checkoutState: "clean",
        artifactFingerprint: null,
        targetId: null,
        targetOrigin: null
      },
      observationSource: "engine-adapter",
      actionSource: "engine-policy",
      derivedFrom: null
    },
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
    schema: "autodev-control-playtesting-detail-v4",
    workspaceId: WORKSPACE,
    resource: "episode",
    readOnly: true,
    record,
    latestReview: null,
    latestDiscoveryReview: null,
    visualAssignment: null
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

function visualBatch(): PlaytestVisualBatch {
  const manifestDraft = {
    schema: PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
    mode: "autonomous-visual" as const,
    batchId: "visual-batch-1",
    workspaceId: WORKSPACE,
    targetId: "racing-target",
    targetApprovalId: "approval-1",
    targetRevision: 2,
    targetOrigin: "http://racing.local",
    policyId: "smart-direct" as const,
    policyVersion: "smart-direct-v1",
    cohortId: null,
    areasOfFocus: null,
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 40,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 20,
      smartTokensPerEpisode: 10_000,
      screenshotCountPerEpisode: 40,
      artifactBytesPerEpisode: 10_000_000
    },
    createdAt: "2026-10-17T12:00:00.000Z",
    assignments: [{ assignmentId: "v-0001", ordinal: 0, maxSteps: 30 }]
  } as const;
  const manifest = {
    ...manifestDraft,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestDraft))
      .digest("hex")
  };
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    executionMode: "autonomous-visual",
    batchId: manifest.batchId,
    revision: 1,
    workspaceId: WORKSPACE,
    repository: null,
    buildSha: null,
    gameBuild: null,
    configHash: null,
    rubricHash: null,
    actionSchemaHash: null,
    observationSchemaHash: null,
    eventSchemaHash: null,
    measurementVersion: "playtesting-measurement-v2",
    protocolVersion: null,
    policyIds: ["smart-direct"],
    cohortIds: [],
    scenarioIds: [],
    assignmentInventory: { status: "frozen-visual", manifest },
    coverageManifest: null,
    unobservedAssignments: [],
    reviewSelection: {
      status: "unavailable",
      reason: "visual-discovery-session-level"
    },
    reviewPackets: [],
    reviewReceipts: [],
    status: "completed",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 1,
      started: 1,
      completed: 1,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 30,
      wallTimeMs: 60_000,
      critiqueBudget: 0,
      actualCritiques: 0
    },
    startedAt: manifest.createdAt,
    completedAt: manifest.createdAt,
    createdAt: manifest.createdAt,
    provenance: {
      workspaceId: WORKSPACE,
      buildSha: null,
      measurementVersion: "playtesting-measurement-v2",
      generatedAt: manifest.createdAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

test("overview renders visual batches without fabricating a source commit", () => {
  const current = visualBatch();
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: scope({ view: "overview" }),
      workspaces: [workspace],
      currentBuildSha: BUILD_SHA,
      overview: {
        batches: [current],
        batchCount: 1,
        episodeCount: 1,
        findingCount: 0,
        reviewCount: 0,
        latestReviews: [],
        latestEpisodes: []
      }
    })
  );
  assert.match(
    html,
    /Autonomous visual · http:\/\/racing\.local · Commit not applicable/u
  );
  assert.match(html, /1 of 1 sessions completed/u);
  assert.doesNotMatch(html, /Build aaaaaaaaaaaa/u);
  assert.doesNotMatch(html, /earlier commit than the build currently/u);
});

test("the decision policy is named the way an operator names it", () => {
  // The tile that says "Decision Policy" used to print the policy's own id --
  // "smart-direct" -- where the Console already has a word for it, and where
  // the run dashboard and the episode summary were already using that word.
  // One policy, three spellings, and the raw one on the page the operator is
  // looking at.
  const smart = episode();
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail({
        ...smart,
        identity: { ...smart.identity, policyId: "smart-direct" }
      }),
      scope: scope({ view: "sessions" }),
      window: null
    })
  );

  assert.match(html, /Decision Policy/u);
  assert.match(html, /Smart-directed/u);
  assert.doesNotMatch(html, />smart-direct</u);
});

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
  // The header says what the page is about and whether the workspace can be
  // played, in one sentence each.
  assert.match(html, /Playtests recorded for owner\/game/u);
  assert.match(html, /the workspace is disabled, so its history is read-only/u);
  // Each view says what it answers, so the tabs are not four bare nouns.
  assert.match(html, /data-view-summary="sessions"/u);
  assert.match(html, /Every playtest in this workspace/u);
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
  assert.match(html, /Open session/u);
  assert.match(html, /Adapter-accelerated/u);
  assert.match(html, /Verified aaaaaaaaaaaa/u);
  assert.doesNotMatch(html, /playtesting-selection-option/u);
  assert.match(html, /0 of 40 selected/u);
  assert.match(html, /aria-label="List view" aria-pressed="true"/u);
  assert.match(html, /aria-label="Grid view" aria-pressed="false"/u);

  const gridHtml = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions", layout: "grid" }),
      rows: [current],
      total: 1,
      nextCursor: null
    })
  );
  assert.match(gridHtml, /sm:grid-cols-2 xl:grid-cols-3/u);
  assert.match(gridHtml, /aria-label="Grid view" aria-pressed="true"/u);

  const visualEpisode: PlaytestEpisode = {
    ...current,
    scenarioFamily: null,
    policyCohort: null,
    identity: {
      ...current.identity,
      repository: null,
      buildSha: null,
      gameBuild: null,
      scenarioId: null,
      configHash: null,
      seed: null,
      rngInitialStateHash: null,
      rngAlgorithm: null,
      rngVersion: null,
      observationSchemaHash: "f".repeat(64),
      actionSchemaHash: "e".repeat(64),
      eventSchemaHash: "d".repeat(64),
      protocolVersion: null
    },
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-target",
        targetOrigin: "http://racing.local"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    }
  };
  const visualHtml = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [visualEpisode],
      total: 1,
      nextCursor: null
    })
  );
  assert.match(visualHtml, /Autonomous visual/u);
  assert.match(visualHtml, /Commit not applicable/u);
  assert.match(visualHtml, /No cohort assigned/u);
  assert.match(visualHtml, /http:\/\/racing\.local/u);
  assert.doesNotMatch(visualHtml, /Verified aaaaaaaaaaaa/u);
  // The row leads with the outcome; the exact stored token stays in the
  // session page's own disclosure rather than in every list row.
  assert.match(gridHtml, />Loss</u);
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
  assert.match(html, /Adapter-accelerated/u);
  assert.match(html, /Verified aaaaaaaaaaaa/u);
  assert.match(html, /Completed/u);
  assert.match(html, /Loss/u);
  assert.match(html, /No frame was recorded/u);
  assert.match(html, /No analyst review is recorded/u);
  assert.match(html, /Back to sessions/u);
  assert.match(html, /cursor=page-2/u);
  assert.doesNotMatch(html, /<video|<img/u);
  assert.doesNotMatch(html, /data-testid="visual-player-debrief"/u);
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
  assert.match(html, /Game outcome<\/dt>[^]*?No game outcome[^]*?unknown/u);
  assert.doesNotMatch(explanation, /Game lost|Player lost/u);
});

test("a no-progress stop says the game stopped advancing and opens its stop step", () => {
  const partialEpisode: PlaytestEpisode = {
    ...episode(),
    status: "budget-truncated",
    termination: { reason: "no-progress", step: 2 },
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
  // The reader is told the game stopped advancing, not that a budget ran out.
  assert.match(explanation, /game showed the player nothing new/u);
  assert.match(explanation, /no win or loss is inferred/u);
  assert.doesNotMatch(explanation, /Token budget reached/u);
  // The step the game was showing when it stopped is one click away.
  assert.match(html, /data-playtesting-stop-step="2"/u);
  assert.match(html, /href="[^"]*step=2"[^>]*>Inspect stop at step 2/u);
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

test("a usage-budget stop says the approved budget ran out, not that the step cap was reached", () => {
  const partialEpisode: PlaytestEpisode = {
    ...episode(),
    status: "budget-truncated",
    termination: { reason: "usage-budget", step: 3 },
    outcome: "unknown",
    stepCount: 4,
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
    /The approved per-episode usage budget ran out after 4 executed decisions, before the step cap was reached/u
  );
  assert.doesNotMatch(html, /reached the episode step limit/u);
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
  // And it says that it is quoting rather than rendering, so a check that
  // reads the page's text knows to leave the machine's own words alone. A
  // recorded frame carries its moments in the wire's spelling, and the
  // Console's instant sweep would otherwise read them as a second voice for
  // the same question.
  assert.equal(
    rawJsonDetails.filter((tag) => /data-verbatim="true"/u.test(tag)).length,
    2
  );
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
  assert.match(html, /Game outcome<\/dt>[^]*?Loss/u);
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

test("visualGameSpectatorStage renders live game screen, AI intentions, scrubber, and 1-click analyst button when visual frames exist", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [
      { id: "frame-step-0", kind: "frame", step: 0, frameIndex: 0 },
      { id: "frame-step-1", kind: "frame", step: 1, frameIndex: 1 }
    ],
    stepCount: 2
  };

  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: visualEpisode.episodeId,
    artifactId: "trace-window-visual",
    sha256: "e".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 1,
    sourceLineCount: 2,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        phase: "GreenFlag",
        selectedActionId: "ArrowUp",
        preActionPrediction: {
          intention:
            "Accelerate down the straightaway and align for upcoming chicane",
          predictedVisibleEffect:
            "Vehicle speed increases to 120 km/h, car stays in center lane",
          reasonCode: "optimal_racing_line"
        },
        visibleObservation: {
          controls: [{ controlId: "pedal", name: "Throttle" }],
          warnings: [],
          phase: "GreenFlag",
          progress: "Lap 1"
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  assert.match(html, /data-testid="visual-spectator-stage"/u);
  assert.match(html, /Game Spectator Cockpit/u);
  assert.match(html, /Autonomous Visual AI Player/u);
  assert.match(html, /data-testid="spectator-game-screen"/u);
  assert.match(html, /frame-step-0/u);
  assert.match(html, /data-testid="spectator-step-scrubber"/u);
  assert.match(html, /data-testid="ai-intention-callout"/u);
  assert.match(
    html,
    /Accelerate down the straightaway and align for upcoming chicane/u
  );
  assert.match(html, /Vehicle speed increases to 120 km\/h/u);
  assert.match(html, /optimal_racing_line/u);
  assert.match(html, /data-playtesting-spectator-analyze="episode-17"/u);
  assert.match(html, /Analyze with Playtest Analyst/u);
});

test("a step that recorded no intention, prediction or action says so instead of narrating one", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    }
  };
  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: visualEpisode.episodeId,
    artifactId: "trace-window-visual",
    sha256: "e".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        // The step recorded the screen and nothing else: no intention, no
        // prediction, no executed action, no control list.
        visibleObservation: {
          controls: [],
          warnings: [],
          phase: "RacingGame Prototype",
          progress: null
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  // Every fact the step did not record is reported as unrecorded, and the
  // cockpit invents nothing: a plausible sentence about a racing car is not
  // evidence that the run observed one.
  assert.match(html, /Not recorded/u);
  assert.doesNotMatch(html, /Advancing vehicle along track curve/u);
  assert.doesNotMatch(html, /Vehicle maintains road heading/u);
  assert.doesNotMatch(html, /Steering &amp; Throttle Controls/u);
  assert.doesNotMatch(html, /tactical_progression/u);
  // The frame's own action chip says that no action was executed rather than
  // naming the policy as if it were one.
  assert.match(html, /NO ACTION RECORDED/u);
  // The policy that decided is still recorded, and the phase the screen
  // showed is still shown.
  assert.match(html, /Decision Policy/u);
  assert.match(html, /RacingGame Prototype/u);
});

test("the cockpit says how much of the screen the decision was made from", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [{ id: "frame-step-0", kind: "frame", step: 0, frameIndex: 0 }],
    stepCount: 1
  };

  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: visualEpisode.episodeId,
    artifactId: "trace-window-visual",
    sha256: "e".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        visibleObservation: {
          controls: [{ controlId: "pedal", name: "Throttle" }],
          warnings: [],
          phase: "GreenFlag",
          progress: "Lap 1"
        },
        // The choice contract carries sixteen options, so a screen with
        // nineteen actionable controls left three of them out of the question.
        authoritativeOutcome: {
          offer: {
            candidatesOffered: 16,
            actionableControls: 19,
            controlsNotOffered: 3
          }
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  assert.match(html, /data-testid="playtesting-offer-summary"/u);
  assert.match(
    html,
    /Asked about 16 of 19 actionable controls; 3 were not offered\./u
  );
});

test("the cockpit says nothing about the offer when the whole screen was offered", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [{ id: "frame-step-0", kind: "frame", step: 0, frameIndex: 0 }],
    stepCount: 1
  };

  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: visualEpisode.episodeId,
    artifactId: "trace-window-visual",
    sha256: "e".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        visibleObservation: {
          controls: [{ controlId: "pedal", name: "Throttle" }],
          warnings: [],
          phase: "GreenFlag",
          progress: "Lap 1"
        },
        authoritativeOutcome: {
          offer: {
            candidatesOffered: 2,
            actionableControls: 2,
            controlsNotOffered: 0
          }
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  assert.doesNotMatch(html, /data-testid="playtesting-offer-summary"/u);
});

test("a run the runtime ended says which failure it recorded, not only that it failed", () => {
  const failedEpisode: PlaytestEpisode = {
    ...episode(),
    status: "infrastructure-failed",
    termination: { reason: "runtime-failure", step: 0 },
    stepCount: 1,
    missingReasons: ["infrastructure-failed"],
    outcome: "unknown",
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    }
  };
  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: failedEpisode.episodeId,
    artifactId: "trace-window-failed",
    sha256: "a".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        visibleObservation: {
          controls: [],
          warnings: [],
          phase: "RacingGame Prototype",
          progress: null
        },
        // The Runtime writes the cause it ended the run with onto the step it
        // ended on. That code is the only record of what went wrong.
        authoritativeOutcome: {
          runtimeFailureCode: "smart-direct:response-invalid"
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: failedEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  // The page names the failure the Runtime recorded, so an operator whose run
  // dies knows whether the game, the decision backend or the budget was at
  // fault.
  assert.match(
    html,
    /could not be read as a decision, so no action was taken/u
  );
  // And it points at the step the cause was recorded on.
  assert.match(html, /Inspect the failed step 0/u);
  // The episode's own state is still what it is: the cause does not replace it.
  assert.match(html, /Failed \(infrastructure\)/u);
});

test("a recorded failure the Console does not recognise is shown as it was recorded", () => {
  const failedEpisode: PlaytestEpisode = {
    ...episode(),
    status: "infrastructure-failed",
    termination: { reason: "runtime-failure", step: 0 },
    stepCount: 1,
    missingReasons: ["infrastructure-failed"],
    outcome: "unknown"
  };
  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: failedEpisode.episodeId,
    artifactId: "trace-window-failed-unknown",
    sha256: "c".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        authoritativeOutcome: {
          runtimeFailureCode: "smart-direct:a-failure-nobody-has-named"
        }
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: failedEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  // A cause that is not guessed at: the recorded code is shown as it is.
  assert.match(html, /smart-direct:a-failure-nobody-has-named/u);
  assert.match(html, /No terminal game outcome was observed/u);
});

test("the visible controls are listed one name per line and the overflow is counted", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    }
  };
  // A game whose controls carry whole sentences as their accessible names:
  // nine of them is more than the preview names, and each one is long.
  const controls = Array.from({ length: 9 }, (_, index) => ({
    controlId: `control-${String(index)}`,
    name: `Control ${String(index)} - Lap 4, 65% of the lap - Delta +7.6 seconds`
  }));
  const window: ControlApiPlaytestingWindowResponse = {
    schema: "autodev-control-playtesting-window-v1",
    workspaceId: WORKSPACE,
    episodeId: visualEpisode.episodeId,
    artifactId: "trace-window-controls",
    sha256: "f".repeat(64),
    mediaType: "application/x-ndjson",
    startStep: 0,
    endStep: 0,
    sourceLineCount: 1,
    omittedLineCount: 0,
    entries: [
      {
        step: 0,
        visibleObservation: {
          controls,
          warnings: [],
          phase: "RacingGame Prototype",
          progress: null
        },
        frameRefs: [{ id: "frame-step-0", kind: "frame" }]
      }
    ]
  };

  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode },
      scope: scope({ view: "sessions", step: "0" }),
      window
    })
  );

  // Each name is its own line, so a reader can skip down the list instead of
  // reading a paragraph of run-on text.
  assert.match(
    html,
    /<li>Control 0 - Lap 4, 65% of the lap - Delta \+7\.6 seconds<\/li>/u
  );
  assert.doesNotMatch(html, /Control 0 - Lap 4[^<]*·/u);
  // The preview names six of them; the rest are counted and kept one
  // disclosure away rather than dropped.
  const panel = html.slice(html.indexOf("Visible Controls &amp; Phase"));
  const disclosureAt = panel.indexOf("<details");
  const preview = panel.slice(0, disclosureAt);
  const disclosure = panel.slice(disclosureAt);
  assert.match(preview, /<li>Control 5 - Lap 4[^<]*<\/li>/u);
  assert.doesNotMatch(preview, /<li>Control 6 - Lap 4[^<]*<\/li>/u);
  assert.match(html, /3 more controls observed/u);
  assert.match(disclosure, /<li>Control 6 - Lap 4[^<]*<\/li>/u);
});

test("visual spectator derives the latest step from frames, follows live, and shows Persisted Analyst Hypotheses only", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    status: "started",
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [
      { id: "frame-step-0", kind: "frame", step: 0, frameIndex: 0 },
      { id: "frame-step-1", kind: "frame", step: 1, frameIndex: 1 },
      { id: "frame-step-2", kind: "frame", step: 2, frameIndex: 2 }
    ],
    stepCount: 3
  };
  const baseDetail = detail();
  const detailWithReview: typeof baseDetail = {
    ...baseDetail,
    record: visualEpisode,
    latestReview: {
      schema: "autodev-playtest-session-review-v6",
      reviewId: "rev-1",
      version: 1,
      episodeId: visualEpisode.episodeId,
      supersedes: null,
      evidencePacket: null,
      authorRole: "playtest-analyst",
      authorId: "analyst",
      rubricHash: "a".repeat(64),
      measurementVersion: "v1",
      provenance: {
        workspaceId: WORKSPACE,
        measurementVersion: "v1",
        generatedAt: "2026-10-17T00:00:00.000Z"
      },
      chronologicalSummary: "Summary only",
      authoritativeMetrics: [],
      observations: [
        {
          text: "The visible prediction banner named the next betting phase.",
          evidenceRefs: [{ kind: "frame", id: "frame-step-0", step: 0 }]
        }
      ],
      interpretations: [
        {
          text: "The prediction may help the player prepare a wager.",
          evidenceRefs: [{ kind: "frame", id: "frame-step-1", step: 1 }]
        }
      ],
      anchors: [],
      alternativeExplanations: [],
      reportCompleteness: {
        crossSessionContext: {
          status: "not-recorded",
          reason: "no cross-session packet provided"
        },
        alternatives: {
          status: "not-recorded",
          reason: "no alternatives in this fixture"
        },
        experiments: { status: "proposed" },
        followUp: { status: "proposed", text: "follow" }
      },
      experiments: [
        {
          hypothesis: "Slow chicane exit reduces lap time",
          falsifier: "Time trial exit 5x slower than baseline",
          metricId: "lap-time-ms",
          controls: ["lap-time-ms", "track-position"],
          budget: "10s extra wall-time"
        }
      ],
      status: "hypothesis",
      findings: [],
      evidenceRefs: [],
      createdAt: "2026-10-17T00:00:00.000Z",
      notes: "no notes"
    }
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detailWithReview,
      scope: scope({ view: "sessions" }),
      window: null
    })
  );
  assert.match(html, /Following live/u);
  assert.match(html, /data-testid="follow-live-active"/u);
  assert.match(html, /Persisted Analyst Hypotheses/u);
  assert.match(html, /Slow chicane exit reduces lap time/u);
  assert.match(html, /data-testid="analyst-hypotheses-list"/u);
  assert.match(html, /data-testid="session-live-watch"/u);
  assert.doesNotMatch(html, /Executive Debrief/u);
  assert.doesNotMatch(html, /9.0 \/ 10/u);
});

test("session detail renders persisted visual discovery hypotheses with packet-linked evidence", () => {
  const visual = {
    ...episode(),
    episodeId: "ep-discovery-1",
    batchId: "batch-discovery-1",
    assignmentId: "vis-assign-1",
    status: "completed" as const,
    termination: { reason: "unknown" as const, step: 0 },
    outcome: "unknown" as const,
    outcomeMetrics: {},
    executionProvenance: {
      mode: "autonomous-visual" as const,
      source: {
        kind: "URL-only" as const,
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable" as const,
        checkoutState: "not-applicable" as const,
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://127.0.0.1:5173"
      },
      observationSource: "browser-ui" as const,
      actionSource: "browser-input" as const,
      derivedFrom: null
    },
    frames: [
      {
        id: "discovery-frame-0",
        kind: "frame" as const,
        step: 0,
        frameIndex: 0
      }
    ],
    stepCount: 1
  } satisfies PlaytestEpisode;
  const discoveryReview: PlaytestDiscoverySessionReview = {
    schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
    analysisKind: "discovery",
    reviewId: "discovery-review-1",
    version: 1,
    workspaceId: WORKSPACE,
    batchId: visual.batchId,
    episodeId: visual.episodeId,
    supersedes: null,
    evidencePacket: {
      packetId: "discovery-packet-1",
      artifact: {
        artifactId: "discovery-packet-1",
        sha256: "a".repeat(64),
        bytes: 512,
        mediaType: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    measurementVersion: "playtesting-measurement-v2",
    chronologicalSummary:
      "One menu choice was visible, but its effect was not observed.",
    observations: [
      {
        hypothesisId: "observation-1",
        status: "hypothesis",
        text: "The race setup menu showed a selectable stage.",
        evidenceRefs: [
          { kind: "frame", id: "discovery-frame-0", step: 0, frameIndex: 0 }
        ]
      }
    ],
    interpretations: [
      {
        hypothesisId: "interpretation-1",
        status: "not-observed",
        text: "The packet does not show whether selecting the stage starts a race.",
        evidenceRefs: [
          { kind: "frame", id: "discovery-frame-0", step: 0, frameIndex: 0 }
        ]
      }
    ],
    alternativeExplanations: [],
    experiments: [],
    evidenceRefs: [
      { kind: "frame", id: "discovery-frame-0", step: 0, frameIndex: 0 }
    ],
    createdAt: "2026-10-17T12:00:00.000Z",
    status: "hypothesis"
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: {
        ...detail(visual),
        latestDiscoveryReview: discoveryReview,
        visualAssignment: {
          targetId: "racing-game-local",
          targetApprovalId: "approval-racinggame-1",
          targetRevision: 1,
          targetOrigin: "http://127.0.0.1:5173",
          areasOfFocus: "Explore the race setup screen."
        }
      },
      scope: scope({ view: "sessions" }),
      window: null
    })
  );
  assert.match(html, /Player debrief/u);
  assert.match(html, /data-testid="visual-player-debrief"/u);
  assert.match(html, /Explore the race setup screen/u);
  assert.match(html, /No player debrief was persisted/u);
  assert.doesNotMatch(html, /Explore the setup menu\./u);
  assert.match(html, /approval-racinggame-1/u);
  assert.match(html, /Not independently verified/u);
  assert.match(html, /step=0/u);
  assert.match(html, /Visual Discovery Review/u);
  assert.match(html, /race setup menu showed a selectable stage/u);
  assert.match(
    html,
    /The packet does not show whether selecting the stage starts a race/u
  );
  assert.match(html, /data-discovery-evidence="frame"/u);
  assert.doesNotMatch(html, /Verified bug/u);
  assert.doesNotMatch(html, /fun score/u);
});

test("player debrief renders persisted self-report and exact stored frame/trace references, not raw trace text", () => {
  const visual: PlaytestEpisode = {
    ...episode(),
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "target",
        targetOrigin: "http://localhost"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [{ id: "debrief-frame", kind: "frame", step: 1, frameIndex: 4 }],
    playerDebrief: {
      schema: "autodev-playtest-player-debrief-v1",
      status: "complete",
      source: {
        authorRole: "player",
        policyId: "smart-direct",
        policyVersion: "1",
        modelId: "synthetic-model",
        modelVersion: null
      },
      focusInterpretation: {
        schema: "autodev-playtest-focus-interpretation-v1",
        requestedFocus: "Inspect the visible setup menu.",
        objective: "Inspect setup",
        inScope: ["visible setup"],
        forbiddenScope: [],
        stopCriteria: [],
        outcome: "achieved",
        assessmentSource: "smart-direct-self-report",
        evidence: [
          { kind: "frame", id: "debrief-frame", step: 1, frameIndex: 4 }
        ]
      },
      summary: "Synthetic persisted report: I inspected the setup menu."
    }
  };
  const window: ControlApiPlaytestingWindowResponse = {
    ...traceWindow(),
    entries: [
      {
        step: 1,
        preActionPrediction: {
          intention: "RAW TRACE MUST NOT BECOME REPORT",
          predictedVisibleEffect: "TRACE PREDICTION MUST NOT BECOME REPORT"
        }
      }
    ]
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(visual),
      scope: scope({ view: "sessions" }),
      window
    })
  );
  const start = html.indexOf('data-testid="visual-player-debrief"');
  const end = html.indexOf('data-testid="visual-spectator-stage"', start);
  const panel = html.slice(start, end);
  assert.match(
    panel,
    /Synthetic persisted report: I inspected the setup menu/u
  );
  assert.match(panel, /Interpreted objective/u);
  assert.match(panel, /Inspect setup/u);
  assert.match(panel, /In scope/u);
  assert.match(panel, /visible setup/u);
  assert.match(panel, /Report source/u);
  assert.match(panel, /synthetic-model/u);
  assert.match(panel, /Player self-reported outcome/u);
  assert.match(panel, /not a verified game outcome/u);
  assert.match(panel, /debrief-frame/u);
  assert.match(panel, /step=1/u);
  assert.doesNotMatch(panel, /RAW TRACE MUST NOT BECOME REPORT/u);
  assert.doesNotMatch(panel, /TRACE PREDICTION MUST NOT BECOME REPORT/u);
});

test("adapter episode renders its persisted not-applicable debrief state", () => {
  const record: PlaytestEpisode = {
    ...episode(),
    playerDebrief: {
      schema: "autodev-playtest-player-debrief-v1",
      status: "not-applicable",
      reason: "non-reflective-policy"
    }
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(record),
      scope: scope({ view: "sessions" }),
      window: null
    })
  );
  assert.match(html, /data-player-debrief-status="not-applicable"/u);
  assert.match(html, /not applicable to this non-reflective policy/u);
});

test("visual spectator surfaces the Follow live jump link when the operator navigates away from the latest step", () => {
  const visualEpisode: PlaytestEpisode = {
    ...episode(),
    status: "completed",
    executionProvenance: {
      mode: "autonomous-visual",
      source: {
        kind: "URL-only",
        repository: null,
        revision: null,
        revisionConfidence: "not-applicable",
        checkoutState: "not-applicable",
        artifactFingerprint: null,
        targetId: "racing-game-local",
        targetOrigin: "http://localhost:5173"
      },
      observationSource: "browser-ui",
      actionSource: "browser-input",
      derivedFrom: null
    },
    frames: [
      { id: "frame-step-0", kind: "frame", step: 0, frameIndex: 0 },
      { id: "frame-step-1", kind: "frame", step: 1, frameIndex: 1 }
    ],
    stepCount: 2
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: { ...detail(), record: visualEpisode, latestReview: null },
      scope: scope({ view: "sessions", step: "0" }),
      window: null
    })
  );
  assert.match(html, /data-testid="jump-to-live"/u);
  assert.doesNotMatch(html, /Following live/u);
});

test("the session page names the limit that cut a truncated episode short", () => {
  const truncated = {
    ...episode(),
    status: "budget-truncated",
    termination: { reason: "usage-budget", step: 3 }
  } as PlaytestEpisode;
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(truncated),
      scope: scope({ view: "sessions", step: "1" }),
      window: traceWindow()
    })
  );
  // The episode state cannot say which limit; the termination reason can, and
  // the page has to read it, or the badge falls back to saying only that a
  // limit happened.
  assert.match(html, /Execution status<\/dt>[^]*?Budget exhausted/u);
  assert.doesNotMatch(html, /Execution status<\/dt>[^]*?Limit reached/u);
});

test("the session page says the runtime refused the action", () => {
  const refused = {
    ...episode(),
    status: "crashed",
    termination: { reason: "action-refused", step: 2 }
  } as PlaytestEpisode;
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionView, {
      detail: detail(refused),
      scope: scope({ view: "sessions", step: "2" }),
      window: traceWindow()
    })
  );
  // The episode state alone says "crashed", which is not what happened: the
  // runtime declined to act. The badge reads the termination reason.
  assert.match(html, /Execution status<\/dt>[^]*?Action refused/u);
  assert.doesNotMatch(html, /Execution status<\/dt>[^]*?>Crashed</u);
  // The page says what the refusal means and where the refused step is.
  assert.match(html, /The runtime refused the episode/u);
  assert.match(html, /action and ended the episode\./u);
  assert.match(html, /data-playtesting-refused-step="2"/u);
  // No game outcome was observed, and none is inferred.
  assert.match(html, /no win or loss is inferred/u);
});

test("a session row says what the analyst recorded about that session", () => {
  const current = episode();
  const review = {
    reviewId: "review-episode-17",
    episodeId: current.episodeId,
    workspaceId: WORKSPACE,
    kind: "discovery" as const,
    status: "hypothesis",
    createdAt: "2026-10-21T12:00:00.000Z",
    observationCount: 10,
    interpretationCount: 5,
    findingCount: 2,
    headline: "The fast-forward button may have no visible effect.",
    summary: "Ten observations were recorded against the four captured frames.",
    hypotheses: [
      {
        hypothesisId: "int-1",
        text: "The fast-forward button may have no visible effect.",
        status: "hypothesis" as const
      }
    ],
    findings: [],
    evidenceRefs: []
  };
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [current],
      total: 1,
      nextCursor: null,
      reviews: [review],
      reviewTotal: 1
    })
  );
  assert.match(html, /Analysed · 5 hypotheses · 10 observations · 2 findings/u);
  assert.match(html, /data-session-analysis="episode-17"/u);
  // Every review was read, so a session with none of its own says so.
  const withoutReview = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [current],
      total: 1,
      nextCursor: null,
      reviews: [],
      reviewTotal: 0
    })
  );
  assert.match(withoutReview, /No analyst review recorded/u);
});

test("a session row claims no analysis when the review read did not answer", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [episode()],
      total: 1,
      nextCursor: null,
      reviews: null,
      reviewTotal: null
    })
  );
  // A failed read is not evidence that no review exists.
  assert.doesNotMatch(html, /No analyst review recorded/u);
  assert.doesNotMatch(html, /Analysed ·/u);
});

test("a session row says when only part of the workspace's reviews was read", () => {
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: scope({ view: "sessions" }),
      rows: [episode()],
      total: 1,
      nextCursor: null,
      reviews: [],
      reviewTotal: 120
    })
  );
  assert.match(
    html,
    /Analysis counts are shown for the 0 most recent of 120 analyst reviews\./u
  );
  // A review this page never saw is not the same as no review at all.
  assert.doesNotMatch(html, /No analyst review recorded/u);
});

test("the session list offers a search that the server applies", () => {
  const searched = scope({ view: "sessions", q: "ep-b141d962" });
  const html = renderToStaticMarkup(
    React.createElement(PlaytestingSessionsWorkspace, {
      scope: searched,
      rows: [],
      total: 0,
      nextCursor: null
    })
  );
  // The search is a form that carries the rest of the scope, so it reaches
  // the server rather than filtering the page in the browser.
  assert.match(html, /aria-label="Session search"/u);
  assert.match(html, /name="q"/u);
  assert.match(html, /value="ep-b141d962"/u);
  // The field keeps an accessible name of its own.
  assert.match(html, /for="filter-q"/u);
  assert.match(html, /Search sessions/u);
  // It carries the workspace and the view with it, so a search does not drop
  // the operator out of the scope they are in.
  assert.match(html, /name="workspaceId" value="owner\/game"/u);
  assert.match(html, /name="view" value="sessions"/u);

  // And it is the only search: the Filters panel carries the other filters,
  // not a second copy of this one. It does carry the term, so applying a
  // filter does not quietly drop the search.
  const view = renderToStaticMarkup(
    React.createElement(PlaytestingView, {
      scope: searched,
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ],
      list: {
        resource: "episodes",
        rows: [],
        total: 0,
        nextCursor: null
      }
    })
  );
  assert.doesNotMatch(view, /type="search"/u);
  assert.match(view, /name="q" value="ep-b141d962"/u);
});
