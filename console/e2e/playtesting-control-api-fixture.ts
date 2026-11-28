/**
Deterministic, explicitly synthetic Control API fixture for browser usability tests.
*/
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import {
  buildPlaytestCoverageManifestDraft,
  buildPlaytestFindingIdentity,
  CONTROL_API_CONTRACT,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  type ControlApiHookDeclaration,
  type ControlApiHookEvent,
  type ControlApiHooksAppliedResponse,
  type ControlApiHooksResponse,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  playtestAssignmentManifestHashInput,
  type PlaytestComparison,
  playtestCoverageManifestHashInput,
  type PlaytestCrossSessionSynthesis,
  playtestEpisodeRecordId,
  playtestFindingIdentityHashInput,
  playtestReviewOutcomeKey,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  playtestVisualEpisodeRecordId,
  type ReconciliationView,
  recordPlaytestOwnerDecision,
  selectPlaytestBatchReviews
} from "@simulatorlife/autodev-core";

import {
  canonicalSource,
  moveCanonicalSource,
  resetCanonicalSources
} from "./canonical-source-fixture.ts";
import {
  DIAGNOSTICS_SESSION_ID,
  fleetScanResponse,
  hookDenialsResponse,
  recentSessionsResponse,
  sessionDiagnosticsReport
} from "./session-diagnostics-fixture.ts";

/**
The vocabulary the fixture speaks in.

The fixture is a stand-in for the Control API, so the values it writes are
the API's values; naming them once keeps the fixture from spelling the
same mode or policy two ways.
*/
const FIXTURE_NOT_APPLICABLE = "not-applicable";
const FIXTURE_SMART_DIRECT_POLICY = "smart-direct";
const FIXTURE_AUTONOMOUS_VISUAL_MODE = "autonomous-visual";
const FIXTURE_RUN_STARTED_SCHEMA = "autodev-control-playtesting-run-started-v3";
const FIXTURE_BATCH_ID_PREFIX = /^batch-/u;
const FIXTURE_CAPABILITY_REVISION = "e".repeat(64);
const FIXTURE_LOCAL_WORKSPACE = "autodev-local";
const FIXTURE_REVIEW_TIMESTAMP = "2026-02-11T09:40:00.000Z";
const FIXTURE_EARLIER_TIMESTAMP = "2026-02-11T08:22:00.000Z";

/**
The explanation the Runtime gives for a converged surface.

It is the same sentence wherever it appears, so the wording cannot drift
between the surfaces that publish it.
*/
const FIXTURE_CONVERGED_EXPLANATION =
  "The runtime has observed the latest desired generation; convergence is recorded.";

const PORT = Number(process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? 4311);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIAGNOSTICS_SESSION_PATH_PATTERN =
  /^\/control\/diagnostics\/sessions\/(.+)$/u;
const SYNTHETIC_VISUAL_LAUNCH_KEYS = new Set([
  "schema",
  "mode",
  "workspaceId",
  "requestId",
  "capabilityRevision",
  "targetId",
  "policyId",
  "areasOfFocus",
  "limits"
]);
const SYNTHETIC_VISUAL_LIMIT_KEYS = new Set([
  "episodeCount",
  "maxStepsPerEpisode",
  "wallTimeMs",
  "smartRequestsPerEpisode",
  "smartTokensPerEpisode",
  "screenshotCountPerEpisode",
  "artifactBytesPerEpisode"
]);
const WORKSPACE_ID = "fixture/game";
/**
The canonical workspace configuration the fixture holds.

The Runtime owns the real catalog and publishes a revision the write is
compared against, so the fixture has to hold a configuration and a revision
too: a spec that writes through the Console has to be able to see that the
write landed, and a spec that moves the revision underneath an open page
has to be able to make the page's next write a conflict.
*/
const workspaceConfig = {
  id: WORKSPACE_ID,
  baseBranch: "main",
  enabled: true,
  agentRoles: null as string[] | null,
  revision: "e".repeat(64)
};
const INITIAL_WORKSPACE_REVISION = workspaceConfig.revision;

/**
The canonical permission policy the fixture holds.

The Runtime reads the policy from the canonical source that states it and
publishes a revision the write is compared against, so the fixture holds a
policy and a revision too: a spec that writes through the Console has to be
able to see that the write landed, and a spec that moves the revision
underneath an open page has to be able to make the page's next write a
conflict.
*/
/**
The sandbox the fixture's session runs in.

It is the ceiling every role runs under: a role may narrow the sandbox it
runs in, never widen it.
*/
/**
The canonical JSONC the fixture's permission policy holds.
*/
const FIXTURE_PERMISSION_SOURCE = `{
  // The portable policy the session runs under.
  "codexcli": {
    "approval_policy": "on-request",
    "approvals_reviewer": "operator",
    "tools": { "web_search": false }
  }
}`;

const permissionPolicy = {
  approvalPolicy: "on-request" as "never" | "on-request",
  approvalsReviewer: "operator",
  webSearch: false,
  // The revision names the bytes the policy is read from, which is what the
  // Runtime publishes: the sha256 of the canonical source's exact text. A
  // synthetic revision would let a page show a revision and a source that
  // name different things.
  revision: createHash("sha256")
    .update(FIXTURE_PERMISSION_SOURCE, "utf8")
    .digest("hex")
};
const INITIAL_PERMISSION_POLICY_REVISION = permissionPolicy.revision;

/**
The states the fixture's own control routes put a setting back to.

"enabled" and "disabled" say which way a setting goes, and "revision-moved"
moves the revision without this Console knowing -- so the page that holds
the revision it was rendered with writes against a setting that has moved
past it.
*/
const FIXTURE_STATE_ENABLED = "enabled";
const FIXTURE_STATE_DISABLED = "disabled";
const FIXTURE_STATE_REVISION_MOVED = "revision-moved";
const BUILD_SHA = "a".repeat(40);
const MEASUREMENT_VERSION = "measurement-v1";
const RUBRIC_HASH = "d".repeat(64);
const ADAPTER_EXECUTION_MODE = "adapter-accelerated" as const;
const FIXTURE_TIMESTAMP = "2026-10-10T00:00:00.000Z";
const SYNTHETIC_VISUAL_TARGET = {
  schema: "autodev-workspace-visual-playtest-target-v1",
  workspaceId: WORKSPACE_ID,
  targetId: "visual-fixture-target",
  revision: 1,
  approvalId: "visual-fixture-approval",
  name: "Synthetic visual browser",
  entryUrl: "http://127.0.0.1:4311/fixture-visual-game",
  allowedOrigins: ["http://127.0.0.1:4311"],
  inputCapabilities: ["keyboard", "pointer"],
  controlTimingClass: "turn-based",
  entryRequirements: "none",
  sandboxProfile: "transient-browser-profile",
  capturePolicy: "screenshots-only-redact-or-refuse",
  limits: {
    episodeCount: 2,
    maxStepsPerEpisode: 10,
    wallTimeMs: 60_000,
    smartRequestsPerEpisode: 4,
    smartTokensPerEpisode: 1000,
    screenshotCountPerEpisode: 10,
    artifactBytesPerEpisode: 1_048_576
  },
  approvedAt: FIXTURE_TIMESTAMP,
  approvedBy: "fixture-operator",
  revokedAt: null,
  revokedBy: null,
  revocationReason: null
} as const;
const COMPARISON_DECISION_ROUTE =
  /^\/control\/playtesting\/comparisons\/([^/]+)\/decision$/u;
const TRACE_ID = "trace-window-1";
const FRAME_ID = "frame-1";
const FRAME_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4nQAAAAASUVORK5CYII=",
  "base64"
);
const findingIdentity = buildPlaytestFindingIdentity({
  workspaceId: WORKSPACE_ID,
  mechanicKey: "action-execution",
  failureSignature: {
    events: ["legal-action-noop"],
    action: "advance",
    witness: "tutorial-step-2"
  },
  scope: {
    scenarioFamily: "tutorial",
    phase: "tutorial",
    modality: "headless"
  }
});
const findingFingerprint = createHash("sha256")
  .update(playtestFindingIdentityHashInput(findingIdentity))
  .digest("hex");
const findingId = "finding-" + findingFingerprint;

const counts = {
  assigned: 1,
  started: 1,
  completed: 1,
  crashed: 0,
  infrastructureFailed: 0,
  cancelled: 0,
  budgetTruncated: 0,
  reviewed: 0,
  eligible: 1
} as const;

const episode = {
  schema: PLAYTESTS_EPISODE_SCHEMA,
  episodeId: "episode-17",
  revision: 1,
  batchId: "batch-3",
  assignmentId: "a-0017",
  branchLineage: null,
  executionProvenance: {
    mode: ADAPTER_EXECUTION_MODE,
    source: {
      kind: "repo-checkout",
      repository: WORKSPACE_ID,
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
  playerDebrief: {
    schema: "autodev-playtest-player-debrief-v1",
    status: FIXTURE_NOT_APPLICABLE,
    reason: "non-reflective-policy"
  },
  identity: {
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    gameBuild: "fixture-build-1",
    scenarioId: "tutorial",
    configHash: "config-hash",
    seed: "seed-17",
    rngInitialStateHash: "e".repeat(64),
    rngAlgorithm: "fixture-rng",
    rngVersion: "1",
    policyId: "weak-bot",
    policyVersion: "1",
    modelId: null,
    modelRevision: null,
    observationSchemaHash: "obs-hash",
    actionSchemaHash: "action-hash",
    eventSchemaHash: "event-hash",
    protocolVersion: 1,
    runtimeVersion: "runtime-v1",
    environmentHash: "environment-hash"
  },
  scenarioFamily: "tutorial",
  policyCohort: "novice",
  strategy: "weak-policy-fixture",
  status: "completed",
  termination: { reason: "game-terminal", step: 1 },
  outcome: "loss",
  outcomeMetrics: { score: 10 },
  completionCounts: counts,
  replayStatus: "trace-replayable",
  trace: { kind: "replay-segment", id: TRACE_ID },
  frames: [{ kind: "frame", id: FRAME_ID, frameIndex: 0, step: 1 }],
  stepCount: 3,
  metrics: [
    {
      metricId: "legal-action-rejection",
      metricVersion: 1,
      phaseId: "tutorial",
      numerator: 0,
      denominator: 3,
      opportunityCount: 3,
      coverage: 1,
      unit: "proportion",
      estimate: 0,
      missing: 0,
      missingReasons: [],
      independentUnits: 1,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: BUILD_SHA,
        evaluatorHash: "e".repeat(64),
        rubricHash: RUBRIC_HASH,
        measurementVersion: MEASUREMENT_VERSION,
        generatedAt: FIXTURE_TIMESTAMP
      },
      notes: "Synthetic fixture metric; not a real game result."
    }
  ],
  findingIds: [findingId],
  assignedAt: FIXTURE_TIMESTAMP,
  startedAt: "2026-10-10T00:00:01.000Z",
  completedAt: "2026-10-10T00:00:02.000Z",
  simulationWallMs: 100,
  logicalTicks: 3,
  policyInferenceMs: 1,
  nativeDurationMs: null,
  completeness: "complete",
  missingReasons: []
};

const VISUAL_EPISODE_ID = "episode-visual-debrief";
const VISUAL_TRACE_ID = "trace-visual-debrief";
const VISUAL_FRAME_ID = "frame-visual-debrief";
const visualEpisode = {
  schema: PLAYTESTS_EPISODE_SCHEMA,
  episodeId: VISUAL_EPISODE_ID,
  revision: 1,
  batchId: "batch-visual-debrief",
  assignmentId: "vis-assign-debrief",
  branchLineage: null,
  playerDebrief: {
    schema: "autodev-playtest-player-debrief-v1",
    status: "complete",
    source: {
      authorRole: "player",
      policyId: FIXTURE_SMART_DIRECT_POLICY,
      policyVersion: "1",
      modelId: "synthetic-fixture-model",
      modelVersion: null
    },
    focusInterpretation: {
      schema: "autodev-playtest-focus-interpretation-v1",
      requestedFocus: "Explore the setup menu without starting a race.",
      objective: "Inspect the setup menu.",
      inScope: ["Visible setup controls"],
      forbiddenScope: ["Starting a race"],
      stopCriteria: ["Stop at the setup menu."],
      outcome: "achieved",
      assessmentSource: "smart-direct-self-report",
      evidence: [{ kind: "frame", id: VISUAL_FRAME_ID, step: 0, frameIndex: 0 }]
    },
    summary:
      "Synthetic fixture report: the setup menu was inspected without starting a race."
  },
  executionProvenance: {
    mode: FIXTURE_AUTONOMOUS_VISUAL_MODE,
    source: {
      kind: "URL-only",
      repository: null,
      revision: null,
      revisionConfidence: FIXTURE_NOT_APPLICABLE,
      checkoutState: FIXTURE_NOT_APPLICABLE,
      artifactFingerprint: null,
      targetId: "visual-fixture-target",
      targetOrigin: "http://127.0.0.1:5173"
    },
    observationSource: "browser-ui",
    actionSource: "browser-input",
    derivedFrom: null
  },
  identity: {
    workspaceId: WORKSPACE_ID,
    repository: null,
    buildSha: null,
    gameBuild: null,
    scenarioId: null,
    configHash: null,
    seed: null,
    rngInitialStateHash: null,
    rngAlgorithm: null,
    rngVersion: null,
    policyId: FIXTURE_SMART_DIRECT_POLICY,
    policyVersion: "1",
    modelId: null,
    modelRevision: null,
    observationSchemaHash: null,
    actionSchemaHash: null,
    eventSchemaHash: null,
    protocolVersion: null,
    runtimeVersion: "runtime-fixture-v1",
    environmentHash: null
  },
  scenarioFamily: null,
  policyCohort: null,
  strategy: FIXTURE_SMART_DIRECT_POLICY,
  status: "completed",
  termination: { reason: "unknown", step: null },
  outcome: "unknown",
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
    eligible: 0
  },
  replayStatus: "trace-replayable",
  trace: { kind: "replay-segment", id: VISUAL_TRACE_ID },
  frames: [{ kind: "frame", id: VISUAL_FRAME_ID, step: 0, frameIndex: 0 }],
  stepCount: 1,
  metrics: [],
  findingIds: [],
  assignedAt: FIXTURE_TIMESTAMP,
  startedAt: "2026-10-10T00:00:01.000Z",
  completedAt: "2026-10-10T00:00:02.000Z",
  simulationWallMs: 0,
  logicalTicks: null,
  policyInferenceMs: 0,
  nativeDurationMs: null,
  completeness: "complete",
  missingReasons: []
};

const loopGuardEpisode = {
  ...episode,
  episodeId: "episode-loop-guard",
  status: "budget-truncated",
  termination: { reason: "loop-guard", step: 3 },
  outcome: "unknown",
  outcomeMetrics: {},
  completionCounts: {
    ...counts,
    completed: 0,
    budgetTruncated: 1,
    eligible: 0
  },
  frames: [],
  stepCount: 3,
  metrics: [],
  findingIds: [],
  completeness: "partial",
  missingReasons: ["budget-truncated"]
} as const;

const assignmentManifestBase = {
  schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  mode: ADAPTER_EXECUTION_MODE,
  batchId: "batch-3",
  workspaceId: WORKSPACE_ID,
  buildSha: BUILD_SHA,
  configHash: "config-hash",
  rubricHash: RUBRIC_HASH,
  approvalRevision: 1,
  createdAt: FIXTURE_TIMESTAMP,
  assignments: [
    {
      assignmentId: "a-0017",
      scenarioId: episode.identity.scenarioId,
      scenarioFamily: episode.scenarioFamily,
      policyId: episode.identity.policyId,
      policyVersion: episode.identity.policyVersion,
      cohort: episode.policyCohort,
      seed: episode.identity.seed,
      maxSteps: 20
    }
  ]
} as const;

const latestReview = {
  schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
  reviewId: "review-fixture-1",
  version: 1,
  episodeId: episode.episodeId,
  supersedes: null,
  evidencePacket: {
    packetId: "packet-fixture-1",
    artifact: {
      artifactId: "packet-artifact-fixture-1",
      sha256: "c".repeat(64),
      bytes: 128,
      mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
    }
  },
  authorRole: "playtest-analyst",
  authorId: "analyst-fixture",
  rubricHash: RUBRIC_HASH,
  measurementVersion: MEASUREMENT_VERSION,
  provenance: {
    workspaceId: WORKSPACE_ID,
    measurementVersion: MEASUREMENT_VERSION,
    generatedAt: FIXTURE_TIMESTAMP
  },
  chronologicalSummary: "Synthetic reviewed session for UI usability only.",
  authoritativeMetrics: [],
  observations: [
    {
      text: "A warning event was recorded at the cited step.",
      evidenceRefs: [{ kind: "event", id: "event-1", step: 1 }]
    }
  ],
  interpretations: [
    {
      text: "This legacy interpretation has no claim-level citation.",
      evidenceRefs: []
    }
  ],
  anchors: [],
  alternativeExplanations: ["The policy may have missed the warning."],
  reportCompleteness: {
    crossSessionContext: {
      status: "unavailable",
      reason: "This fixture contains one session and no batch synthesis."
    },
    alternatives: { status: "provided" },
    experiments: {
      status: "none-recommended",
      reason: "This UI fixture does not recommend a new experiment."
    },
    followUp: {
      status: "proposed",
      text: "Review the cited warning in the selected replay."
    }
  },
  experiments: [],
  status: "hypothesis",
  findings: [],
  evidenceRefs: [
    { kind: "episode", id: episode.episodeId },
    { kind: "event", id: "event-1", step: 1 }
  ],
  createdAt: FIXTURE_TIMESTAMP,
  notes: "Synthetic fixture only; not game or human evidence."
} as const;

/**
The persisted reviews, in the summary shape the Control API serves.

The Console reads the analyst's durable record through this route, and a
fixture that serves only the in-process analyst envelope leaves the
Findings view with nothing to show — so the review a session carries is
projected into the shape the reader validates.
*/
function reviewSummaryRow(review: {
  readonly reviewId: string;
  readonly episodeId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly observations: readonly { readonly text: string }[];
  readonly interpretations: readonly { readonly text: string }[];
  readonly findings: readonly unknown[];
  readonly chronologicalSummary: string;
  readonly evidenceRefs: readonly unknown[];
}) {
  return {
    reviewId: review.reviewId,
    episodeId: review.episodeId,
    workspaceId: WORKSPACE_ID,
    kind: "discovery" as const,
    status: review.status,
    createdAt: review.createdAt,
    observationCount: review.observations.length,
    interpretationCount: review.interpretations.length,
    findingCount: review.findings.length,
    headline:
      review.interpretations[0]?.text ??
      "The analyst recorded no written conclusion for this session.",
    summary: review.chronologicalSummary,
    // The claims themselves, not only how many there are: a reader who sees
    // "1 hypothesis" still cannot read what the analyst claimed.
    hypotheses: review.interpretations.map((claim) => ({
      hypothesisId: `hyp-${String(review.interpretations.indexOf(claim) + 1)}`,
      text: claim.text,
      status: "hypothesis" as const
    })),
    findings: review.findings.map((finding) => {
      const record = finding as {
        readonly findingId?: unknown;
        readonly title?: unknown;
        readonly evidenceStatus?: unknown;
      };
      return {
        findingId: typeof record.findingId === "string" ? record.findingId : "",
        title: typeof record.title === "string" ? record.title : "",
        evidenceStatus:
          record.evidenceStatus === "verified" ||
          record.evidenceStatus === "corroborated" ||
          record.evidenceStatus === "hypothesis"
            ? record.evidenceStatus
            : "not observed"
      };
    }),
    evidenceRefs: review.evidenceRefs
  };
}

/**
The reviews a reader sees before any analysis has been run.
*/
const persistedReviewRows = [reviewSummaryRow(latestReview)];

/**
The reviews a reader sees.

They are the persisted ones plus any review an analyst run in this fixture
has just produced, so a reader who runs an analysis and comes back to the
Findings view finds the analysis there.
*/
function respondPlaytestingReviews(response: ServerResponse): void {
  const fromRuns = Array.from(syntheticRunReviews.values(), (review) =>
    reviewSummaryRow(
      review as unknown as Parameters<typeof reviewSummaryRow>[0]
    )
  );
  const rows = [...persistedReviewRows, ...fromRuns];
  sendJson(response, {
    schema: "autodev-control-playtesting-reviews-v2",
    workspaceId: WORKSPACE_ID,
    total: rows.length,
    rows,
    nextCursor: null
  });
}

function syntheticReviewForPacket(
  packet: { readonly episodeId: string; readonly packetId: string },
  analysisId: string
) {
  const reviewId = `review-${analysisId}-${packet.episodeId}`;
  return {
    ...latestReview,
    reviewId,
    episodeId: packet.episodeId,
    evidencePacket: {
      ...latestReview.evidencePacket,
      packetId: packet.packetId,
      artifact: {
        ...latestReview.evidencePacket.artifact,
        artifactId: `packet-artifact-${reviewId}`
      }
    },
    evidenceRefs: latestReview.evidenceRefs.map((reference) =>
      reference.kind === "episode"
        ? { ...reference, id: packet.episodeId }
        : reference
    )
  };
}

const assignmentManifest = {
  ...assignmentManifestBase,
  contentHash: createHash("sha256")
    .update(playtestAssignmentManifestHashInput(assignmentManifestBase))
    .digest("hex")
};
const coverageManifestDraft = buildPlaytestCoverageManifestDraft({
  rubricHash: RUBRIC_HASH,
  assignmentManifestHash: assignmentManifest.contentHash,
  mode: "headless",
  generatedAt: FIXTURE_TIMESTAMP,
  batchId: assignmentManifest.batchId,
  workspaceId: assignmentManifest.workspaceId,
  buildSha: assignmentManifest.buildSha,
  plan: [
    {
      coverageMetricId: "legal-action-rejection",
      metricVersion: 1,
      mechanicKey: "action-execution",
      phaseId: "tutorial",
      scenarioFamily: "tutorial",
      cohort: "novice",
      policy: "weak-bot",
      modality: "headless",
      analysisUnit: "episode",
      requiredOpportunities: 3,
      requiredIndependentUnits: 1,
      unsupportedReason: null
    }
  ],
  assignments: assignmentManifest.assignments,
  episodes: [episode]
});
const coverageManifest = {
  ...coverageManifestDraft,
  contentHash: createHash("sha256")
    .update(playtestCoverageManifestHashInput(coverageManifestDraft))
    .digest("hex")
};
const reviewSelection = selectPlaytestBatchReviews({
  inventoryHash: assignmentManifest.contentHash,
  maxReviewedSessions: 1,
  critiqueBudget: 1,
  surveillanceSessions: 1,
  discoverySessions: 0,
  discoverySignal: null,
  candidates: [
    {
      assignmentId: "a-0017",
      episodeId: episode.episodeId,
      policyId: episode.identity.policyId,
      scenarioId: episode.identity.scenarioId,
      outcomeKey: playtestReviewOutcomeKey("completed", episode.outcome),
      metrics: episode.metrics
    }
  ],
  unreviewableAssignments: 0,
  selectedAt: FIXTURE_TIMESTAMP
});

const batch = {
  schema: PLAYTESTS_BATCH_SCHEMA,
  executionMode: ADAPTER_EXECUTION_MODE,
  batchId: "batch-3",
  revision: 1,
  workspaceId: WORKSPACE_ID,
  repository: WORKSPACE_ID,
  buildSha: BUILD_SHA,
  gameBuild: "fixture-build-1",
  configHash: "config-hash",
  rubricHash: RUBRIC_HASH,
  actionSchemaHash: "action-hash",
  observationSchemaHash: "obs-hash",
  eventSchemaHash: "event-hash",
  measurementVersion: MEASUREMENT_VERSION,
  protocolVersion: 1,
  policyIds: ["weak-bot"],
  cohortIds: ["novice"],
  scenarioIds: ["tutorial"],
  assignmentInventory: { status: "frozen", manifest: assignmentManifest },
  coverageManifest,
  reviewPackets: [],
  reviewSelection,
  unobservedAssignments: [],
  reviewReceipts: [],
  status: "completed",
  cancellationReason: null,
  failureReason: null,
  counts,
  budget: {
    assignedEpisodes: 1,
    maxStepsPerEpisode: 20,
    wallTimeMs: 60_000,
    critiqueBudget: 1,
    actualCritiques: 0
  },
  startedAt: FIXTURE_TIMESTAMP,
  completedAt: "2026-10-10T00:00:02.000Z",
  createdAt: FIXTURE_TIMESTAMP,
  provenance: {
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    measurementVersion: MEASUREMENT_VERSION,
    generatedAt: FIXTURE_TIMESTAMP
  },
  evaluationIds: [],
  spanIds: []
};

const finding = {
  identity: findingIdentity,
  fingerprint: findingFingerprint,
  findingId,
  version: 1,
  title: "A legal action produces no visible progress",
  description:
    "Synthetic UI fixture finding; it is not evidence about a real game.",
  severity: "major",
  status: "open",
  verificationStage: "not-yet-validated",
  evidenceStatus: "hypothesis",
  affectedEpisodes: 1,
  totalEligibleEpisodes: 3,
  affectedOpportunities: 1,
  totalEligibleOpportunities: 8,
  affectedCohorts: ["novice"],
  evidenceRefs: [{ kind: "episode", id: episode.episodeId, step: 2 }],
  experimentIds: [],
  issueRefs: [],
  lastVerifiedBuild: null,
  nextReviewAt: null
};

const initialComparison: PlaytestComparison = {
  schema: PLAYTESTS_COMPARISON_SCHEMA,
  comparisonId: "comparison-1",
  version: 1,
  benchmarkId: "benchmark-1",
  experimentId: null,
  baseline: { id: "baseline", version: 1 },
  candidate: { id: "candidate", version: 1 },
  freezeStatus: "frozen",
  pairing: {
    mode: "not-comparable",
    pairMap: {},
    allocationPlanHash: null,
    rngAlgorithm: null,
    rngStreamVersion: null,
    couplingDiagnostics: [],
    exclusions: []
  },
  sourceFindingIds: [findingId],
  episodeRefs: [{ kind: "episode", id: episode.episodeId, step: 2 }],
  measurementVersion: MEASUREMENT_VERSION,
  metrics: [
    {
      metricId: "completion",
      metricVersion: 1,
      compatibility: "not-comparable",
      meaningfulMargin: 0.02,
      guardrailMargin: null,
      orientedBenefitDelta: null,
      classification: "not-comparable",
      baseline: {
        arm: "baseline",
        assigned: 1,
        eligible: 1,
        missing: 0,
        independentUnits: 1,
        exposure: 1,
        estimate: 0.5,
        rawDelta: null,
        interval: null
      },
      candidate: {
        arm: "candidate",
        assigned: 1,
        eligible: 1,
        missing: 0,
        independentUnits: 1,
        exposure: 1,
        estimate: 0.5,
        rawDelta: null,
        interval: null
      },
      interval: null,
      sourceSemantics: {
        baseline: {
          metricId: "completion",
          metricVersion: 1,
          source: "deterministic",
          quantityHash: "a".repeat(64),
          sourceHash: "c".repeat(64),
          modality: "headless",
          independentUnit: "episode"
        },
        candidate: {
          metricId: "completion",
          metricVersion: 1,
          source: "deterministic",
          quantityHash: "b".repeat(64),
          sourceHash: "d".repeat(64),
          modality: "headless",
          independentUnit: "episode"
        }
      },
      guardrailStatus: FIXTURE_NOT_APPLICABLE,
      notes: "Synthetic UI fixture only."
    }
  ],
  decision: "hold-not-comparable",
  ownerDecisionAt: null,
  ownerDecisionReason: null,
  ownerDecisionBy: null,
  ownerDisposition: null,
  humanPreference: { answer: "not-collected", interval: null },
  provenance: {
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    measurementVersion: MEASUREMENT_VERSION,
    generatedAt: FIXTURE_TIMESTAMP
  },
  notes: "Synthetic UI fixture; no comparison of real game builds."
};
let comparison: PlaytestComparison = structuredClone(initialComparison);

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.byteLength,
    "cache-control": "no-store"
  });
  response.end(body);
}

/**
The path of one MCP server's canonical declaration.
*/
const MCP_SERVER_ROUTE = /^\/control\/mcps\/([^/]+)$/u;

/**
The moment the fixture's synthetic applied state was observed.
*/
const MCP_OBSERVED_AT = "2026-10-22T12:00:00.000Z";

/**
The canonical MCP declaration, and what the Runtime published from it.

The fixture keeps the two apart the way the Runtime does: the declaration
says what the operator asked for, the applied configuration says what the
Runtime published, and the reconciliation between them is the Runtime's own
verdict. A write moves the declaration, applies it, and the verdict follows.
*/
interface McpLaunchServer {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  readonly httpHeaderNames: readonly string[];
}

interface McpDeclarationState {
  readonly revision: string;
  readonly declaredServers: readonly McpLaunchServer[];
  readonly appliedServers: readonly McpLaunchServer[];
  readonly desiredGeneration: string;
  readonly observedGeneration: string;
  readonly converged: boolean;
}

/**
What the canonical declaration says for the `codexcli` target.

The target has no override of its own, so it inherits the shared server
whole, and the declared side of the reconciliation is the shared
declaration's own endpoint.
*/
const MCP_DECLARED_DOCS: McpLaunchServer = {
  name: "openaiDeveloperDocs",
  command: null,
  args: [],
  cwd: null,
  url: "https://docs.example.test/mcp",
  bearerTokenEnvVar: null,
  httpHeaderNames: []
};

/**
What the Runtime published, before it has observed the declaration.

The runtime is behind the declaration here, so the two sides of the
reconciliation differ and the verdict is a pending one that is true. A
fixture whose declared and published sides were the same would render a
pending verdict over two identical generations, which says the runtime has
not caught up while showing that it has.
*/
const MCP_MOVED_SERVER = "openaiDeveloperDocs";

const MCP_PUBLISHED_DOCS: McpLaunchServer = {
  ...MCP_DECLARED_DOCS,
  url: "https://developers.openai.com/mcp"
};

function mcpGeneration(servers: readonly McpLaunchServer[]): string {
  return createHash("sha256")
    .update(JSON.stringify(servers), "utf8")
    .digest("hex");
}

/**
The declaration, and what the Runtime published from it, as they start.

A reset puts them back to this, so one spec's write is not the next spec's
starting state.
*/
function initialMcpDeclaration(): McpDeclarationState {
  return {
    revision: createHash("sha256")
      .update("mcp-declaration", "utf8")
      .digest("hex"),
    declaredServers: [MCP_DECLARED_DOCS],
    appliedServers: [MCP_PUBLISHED_DOCS],
    desiredGeneration: mcpGeneration([MCP_DECLARED_DOCS]),
    observedGeneration: mcpGeneration([MCP_PUBLISHED_DOCS]),
    converged: false
  };
}

let mcpDeclaration: McpDeclarationState = initialMcpDeclaration();

/**
The fixture's hook state, in the contract's own shapes.

The published events are the contract's `ControlApiHookEvent` and the
declared ones are the contract's `ControlApiHookDeclaration`, so the fixture
cannot publish a shape the Runtime would not: an applied event that carried a
declaration origin would not compile here.

That matters because a fixture which invents a shape is how a reader and a
publisher come to disagree about what the Runtime said. It happened once --
the fixture's applied events carried an origin the Runtime never publishes,
the Console's reader was written to accept exactly that, and the two agreed
with each other and disagreed with the Runtime on every real read. Pinning
the fixture to the contract's types makes that failure impossible to write.
*/
interface FixtureHookDeclaration {
  readonly revision: string;
  readonly events: readonly ControlApiHookDeclaration[];
  readonly appliedEvents: readonly ControlApiHookEvent[];
  readonly desiredGeneration: string;
  readonly observedGeneration: string;
  readonly converged: boolean;
}

/**
The events the fixture declares.

One event every target inherits and one event the target declares alone, so
the page shows both origins rather than one.
*/
const FIXTURE_SHARED_HOOK: ControlApiHookDeclaration = {
  event: "preToolUse",
  origin: "shared",
  actions: [
    {
      type: "command",
      command: "echo guarded",
      matcher: "Bash",
      statusMessage: "Bash is guarded in this fixture."
    }
  ]
};

const FIXTURE_TARGET_HOOK: ControlApiHookDeclaration = {
  event: "sessionEnd",
  origin: "target",
  actions: [{ type: "command", command: "echo session-end" }]
};

/**
The canonical JSONC the fixture's hook declaration holds.

The comments are the point: a raw view that lost them would be a
serialization of the declaration rather than its source.
*/
const FIXTURE_HOOK_SOURCE = `{
  // The hook every target inherits.
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "matcher": "Bash",
        "command": "echo guarded",
        "statusMessage": "Bash is guarded in this fixture."
      }
    ]
  },
  // The hook this target declares alone.
  "codexcli": {
    "hooks": {
      "sessionEnd": [
        {
          "type": "command",
          "command": "echo session-end"
        }
      ]
    }
  }
}`;

/**
The collator the Runtime's own hook comparison uses.

The fixture compares the two sides the way the Runtime compares them, so a
verdict here means what the same two sides would mean there.
*/
const HOOK_COLLATOR = new Intl.Collator();

/**
The generation one side of the hook comparison holds.

The origin is left out, because the Runtime's comparison leaves it out too:
the projection the Runtime published carries no declaration origin, and a
generation that counted it would report drift between a declaration and the
very projection it produced.

The events and the actions are compared as sets, for the Runtime's reason:
the projection groups the actions by matcher, so the order across matchers
follows the grouping rather than the declaration, and comparing the lists in
order would report drift where there is none.
*/
function hookGeneration(events: readonly ControlApiHookEvent[]): string {
  const serialized = JSON.stringify(
    events
      .map((event) => ({
        event: event.event,
        actions: event.actions.map((action) => ({
          type: action.type,
          command: action.command,
          matcher: action.matcher ?? null,
          statusMessage: action.statusMessage ?? null
        }))
      }))
      .sort((left, right) => HOOK_COLLATOR.compare(left.event, right.event))
      .map((event) => ({
        event: event.event,
        actions: event.actions.sort((left, right) =>
          HOOK_COLLATOR.compare(
            `${left.matcher ?? ""}\0${left.command}\0${left.statusMessage ?? ""}`,
            `${right.matcher ?? ""}\0${right.command}\0${right.statusMessage ?? ""}`
          )
        )
      }))
  );
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
The declaration, and what the Runtime published from it, as they start.

The published side carries an older command, so the Runtime is behind the
declaration and the verdict is a pending one that is true. A fixture whose
two sides were identical would render a pending verdict over two identical
generations, which says the runtime has not caught up while showing that it
has.
*/
function initialHookDeclaration(): FixtureHookDeclaration {
  const events = [FIXTURE_SHARED_HOOK, FIXTURE_TARGET_HOOK];
  // The published side carries no declaration origin, because the projection
  // the Runtime published does not carry it either.
  const appliedEvents: ControlApiHookEvent[] = [
    {
      event: FIXTURE_SHARED_HOOK.event,
      actions: [{ type: "command", command: "echo guarded", matcher: "Bash" }]
    },
    { event: FIXTURE_TARGET_HOOK.event, actions: FIXTURE_TARGET_HOOK.actions }
  ];
  return {
    // The revision names the bytes the declaration is read from, which is what
    // the Runtime publishes: the sha256 of the canonical source's exact text.
    // A synthetic revision would let a page show a revision and a source that
    // name different things.
    revision: createHash("sha256")
      .update(FIXTURE_HOOK_SOURCE, "utf8")
      .digest("hex"),
    events,
    appliedEvents,
    desiredGeneration: hookGeneration(events),
    observedGeneration: hookGeneration(appliedEvents),
    converged: false
  };
}

let hookDeclaration: FixtureHookDeclaration = initialHookDeclaration();

/**
The Runtime's verdict on the hook declaration.

The verdict is the Runtime's own: the fixture says what it published and
the shared reconciliation contract says whether that matches the
declaration. The verdict is the contract's own type, so the fixture cannot
publish a convergence the Runtime's vocabulary does not have.
*/
function hookReconciliation(): ReconciliationView {
  return {
    status: {
      convergence: hookDeclaration.converged ? "converged" : "pending",
      desiredGeneration: hookDeclaration.desiredGeneration,
      observedGeneration: hookDeclaration.observedGeneration,
      lastApplyAt: null,
      lastObservationAt: MCP_OBSERVED_AT,
      lastError: null,
      explanation: hookDeclaration.converged
        ? FIXTURE_CONVERGED_EXPLANATION
        : "Apply wrote the latest desired generation, but the running runtime has not observed it yet. Restart the affected process or wait for the observation hook to refresh."
    },
    history: []
  };
}

/**
The write of one MCP server's launch configuration.

The write is a compare-and-swap on the declaration's revision, so a write
decided on an older declaration is refused. A write that lands moves the
declaration, applies it, and the Runtime's verdict follows.
*/
async function applyMcpDeclarationWrite(
  response: ServerResponse,
  request: IncomingMessage,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(MCP_SERVER_ROUTE);
  if (match === null || request.method !== "PATCH") return false;
  const server = decodeURIComponent(match[1] ?? "");
  const body = await readJsonBody(request);
  const expectedRevision = body?.expectedRevision;
  const launch = body?.launch;
  if (
    typeof expectedRevision !== "string" ||
    typeof launch !== "object" ||
    launch === null
  ) {
    sendCanonicalSourceError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "MCP declaration updates require exactly the expected revision and a launch configuration."
    );
    return true;
  }
  if (expectedRevision !== mcpDeclaration.revision) {
    sendCanonicalSourceError(
      response,
      409,
      "autodev_control_mcp_revision_conflict",
      "The canonical MCP declaration changed since it was loaded."
    );
    return true;
  }
  const current = mcpDeclaration.declaredServers.find(
    (entry) => entry.name === server
  );
  if (current === undefined) {
    sendCanonicalSourceError(
      response,
      400,
      "autodev_control_mcp_invalid_declaration",
      `MCP server "${server}" is not declared for the target "codexcli".`
    );
    return true;
  }
  const written: McpLaunchServer = {
    name: server,
    command: readLaunchText(launch.command, current.command),
    args: readLaunchArguments(launch.args, current.args),
    cwd: readLaunchText(launch.cwd, current.cwd),
    url: readLaunchText(launch.url, current.url),
    bearerTokenEnvVar: readLaunchText(
      launch.bearerTokenEnvVar,
      current.bearerTokenEnvVar
    ),
    httpHeaderNames: current.httpHeaderNames
  };
  const declaredServers = mcpDeclaration.declaredServers.map((entry) =>
    entry.name === server ? written : entry
  );
  const revision = createHash("sha256")
    .update(`${mcpDeclaration.revision}:${server}`, "utf8")
    .digest("hex");
  const desiredGeneration = mcpGeneration(declaredServers);
  mcpDeclaration = {
    revision,
    declaredServers,
    appliedServers: declaredServers,
    desiredGeneration,
    observedGeneration: desiredGeneration,
    converged: true
  };
  sendJson(response, {
    schema: "autodev-control-mcp-server-patch-v2",
    name: server,
    target: "codexcli",
    revision,
    changed: true,
    launch: written,
    reconciliation: {
      status: {
        convergence: "converged",
        desiredGeneration,
        observedGeneration: desiredGeneration,
        lastApplyAt: MCP_OBSERVED_AT,
        lastObservationAt: MCP_OBSERVED_AT,
        lastError: null,
        explanation: FIXTURE_CONVERGED_EXPLANATION
      },
      history: []
    }
  });
  return true;
}

function readLaunchText(raw: unknown, current: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw === "string") return raw;
  return current;
}

function readLaunchArguments(
  raw: unknown,
  current: readonly string[]
): readonly string[] {
  if (raw === null) return [];
  if (
    Array.isArray(raw) &&
    raw.every((argument) => typeof argument === "string")
  ) {
    return raw as string[];
  }
  return current;
}

/**
A refusal, in the shape the Runtime refuses a request in.

The Console reads the code out of the error, so a refusal that does not
carry one leaves the Console guessing what happened from the status alone.
*/
function sendCanonicalSourceError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    { error: { message, type: "autodev_control_api_error", code } },
    status
  );
}

function page(
  resource: string,
  rows: readonly unknown[],
  total: number,
  nextCursor: string | null = null
) {
  return {
    schema: "autodev-control-playtesting-page-v1",
    workspaceId: WORKSPACE_ID,
    resource,
    readOnly: true,
    page: { rows, total, nextCursor }
  };
}

let workspaceApproval: Record<string, unknown> | null = null;
let nextRunId = 1;
type SyntheticRunAssignment = {
  readonly assignmentId: string;
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly maxSteps: number;
};
type SyntheticRun = {
  readonly workspaceId: string;
  readonly mode: "adapter-accelerated" | FIXTURE_AUTONOMOUS_VISUAL_MODE;
  readonly createdAt: string;
  readonly assignmentCount: number;
  readonly assignments: readonly SyntheticRunAssignment[];
  readonly manifestHash: string;
  readonly reviewSelection: ReturnType<typeof selectPlaytestBatchReviews>;
  readonly episodes: readonly {
    readonly episodeId: string;
    readonly record: Record<string, unknown>;
  }[];
  status: "running" | "completed" | "cancelled";
  cancellationRequested: boolean;
};
function syntheticSessionReferences(
  mode: SyntheticRun["mode"],
  batchId: string,
  assignments: readonly SyntheticRunAssignment[]
): readonly { readonly assignmentId: string; readonly episodeId: string }[] {
  return assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    episodeId:
      mode === FIXTURE_AUTONOMOUS_VISUAL_MODE
        ? playtestVisualEpisodeRecordId(batchId, assignment.assignmentId)
        : playtestEpisodeRecordId(batchId, assignment.assignmentId)
  }));
}

const syntheticRuns = new Map<string, SyntheticRun>();
const syntheticLaunchIntents = new Map<
  string,
  {
    readonly launchIntentHash: string;
    readonly batchId: string;
    readonly assignmentCount: number;
    readonly assignmentIds: readonly string[];
    readonly sessions: readonly {
      readonly assignmentId: string;
      readonly episodeId: string;
    }[];
    readonly createdAt: string;
  }
>();
let isFailNextRunAcknowledgement = false;
let isFailNextRunByRequestLookup = false;
type SyntheticAnalystRun = {
  readonly run: {
    readonly analysisId: string;
    readonly workspaceId: string;
    readonly createdAt: string;
    readonly requestedEpisodeIds: readonly string[];
    readonly packets: readonly {
      readonly episodeId: string;
      readonly batchId: string;
      readonly packetId: string;
    }[];
    readonly receipts: readonly {
      readonly episodeId: string;
      readonly batchId: string | null;
      readonly reason: string;
      readonly detail: string;
    }[];
    readonly budget: readonly {
      readonly batchId: string;
      readonly reviewCap: number;
      readonly actualCritiques: number;
      readonly reserved: number;
      readonly requested: number;
      readonly remaining: number;
    }[];
    synthesisId: string | null;
  };
  synthesis: PlaytestCrossSessionSynthesis | null;
  remainingRunningReads: number;
  status: "running" | "completed";
  finishedAt: string | null;
  readonly reviews: {
    readonly episodeId: string;
    readonly reviewId: string;
    readonly status: "hypothesis";
  }[];
};
const syntheticAnalystRuns = new Map<string, SyntheticAnalystRun>();
let nextAnalystRunId = 1;

/**
When set, the active-runs read fails. The Console must then show an explicit
unavailable state; a test that never sees the read fail cannot tell a stale
frame from a live one.
*/
let isSyntheticRunsReadFails = false;
let isSyntheticVisualReadinessEnabled = false;
let isSyntheticVisualRunEnabled = false;
let syntheticReadinessPendingPolls = 0;
let syntheticReadinessPollCount = 0;
let isSyntheticReadinessUnavailable = false;
let isSyntheticAnalystRunsReadFails = false;
let isSyntheticAnalystTaskHistoryMissing = false;
const syntheticRunEpisodes = new Map<string, Record<string, unknown>>();
const syntheticRunReviews = new Map<string, Record<string, unknown>>();

async function readJsonBody(
  request: IncomingMessage
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const approvalPath = `/control/workspaces/${encodeURIComponent(WORKSPACE_ID)}/playtesting-approval`;
const revokePath = `${approvalPath}/revoke`;

async function approveSyntheticWorkspace(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readJsonBody(request);
  const limits = body?.limits;
  if (
    !body ||
    typeof limits !== "object" ||
    limits === null ||
    Array.isArray(limits)
  ) {
    response.writeHead(400).end();
    return;
  }
  const priorRevision =
    typeof body.expectedRevision === "number" ? body.expectedRevision : 0;
  workspaceApproval = {
    schema: "autodev-workspace-playtest-approval-v2",
    workspaceId: WORKSPACE_ID,
    revision: priorRevision + 1,
    approvalId: "synthetic-approval-1",
    checkoutRoot: body.checkoutRoot,
    adapterImageDigest: body.adapterImageDigest,
    workingDirectory: body.workingDirectory,
    adapterCommand: body.adapterCommand,
    allowedScenarios: body.allowedScenarios,
    allowedPolicies: body.allowedPolicies,
    limits,
    retentionDays: body.retentionDays,
    issueReporting: body.issueReporting,
    humanStudyAllowed: body.humanStudyAllowed,
    approvedAt: FIXTURE_TIMESTAMP,
    approvedBy: "synthetic-operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
  sendJson(response, {
    schema: "autodev-control-workspace-playtest-approval-v1",
    workspaceId: WORKSPACE_ID,
    workspaceEnabled: true,
    approval: workspaceApproval
  });
}

async function revokeSyntheticWorkspace(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = await readJsonBody(request);
  if (
    !body ||
    !workspaceApproval ||
    body.approvalId !== workspaceApproval.approvalId ||
    body.expectedRevision !== workspaceApproval.revision
  ) {
    response.writeHead(409).end();
    return;
  }
  workspaceApproval = {
    ...workspaceApproval,
    revision: Number(workspaceApproval.revision) + 1,
    revokedAt: FIXTURE_TIMESTAMP,
    revokedBy: "synthetic-operator",
    revocationReason: body.reason
  };
  sendJson(response, {
    schema: "autodev-control-workspace-playtest-approval-v1",
    workspaceId: WORKSPACE_ID,
    workspaceEnabled: true,
    approval: workspaceApproval
  });
}

async function handleSyntheticWorkspaceApproval(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname === revokePath && request.method === "POST") {
    await revokeSyntheticWorkspace(request, response);
    return true;
  }
  if (pathname !== approvalPath) return false;
  if (request.method === "GET") {
    sendJson(response, {
      schema: "autodev-control-workspace-playtest-approval-v1",
      workspaceId: WORKSPACE_ID,
      workspaceEnabled: true,
      approval: workspaceApproval
    });
    return true;
  }
  if (request.method === "POST") {
    await approveSyntheticWorkspace(request, response);
    return true;
  }
  response.writeHead(405).end();
  return true;
}

const CANCEL_RUN_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)\/cancel$/u;
const STATUS_RUN_ROUTE = /^\/control\/playtesting\/runs\/([^/]+)$/u;
const PLAYTEST_EPISODE_DETAIL_ROUTE =
  /^\/control\/playtesting\/episodes\/([^/]+)$/u;
const PLAYTEST_EPISODE_WINDOW_ROUTE =
  /^\/control\/playtesting\/episodes\/([^/]+)\/windows\/([^/]+)$/u;

function activeSyntheticRunRequest(value: Record<string, unknown> | null): {
  readonly requestId: string;
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly scenario: string;
    readonly policy: string;
    readonly seed: string;
    readonly maxSteps: number;
  }[];
} | null {
  if (!value || !workspaceApproval || workspaceApproval.revokedAt !== null)
    return null;
  const limits = workspaceApproval.limits as
    Record<string, unknown> | undefined;
  const scenarios = workspaceApproval.allowedScenarios;
  const policies = workspaceApproval.allowedPolicies;
  const operation =
    value.schema === "autodev-playtest-launch-v1" &&
    value.mode === ADAPTER_EXECUTION_MODE &&
    typeof value.requestId === "string" &&
    REQUEST_ID_PATTERN.test(value.requestId) &&
    value.capabilityRevision === "e".repeat(64) &&
    typeof value.operation === "object" &&
    value.operation !== null &&
    !Array.isArray(value.operation)
      ? (value.operation as Record<string, unknown>)
      : null;
  const rawAssignments =
    operation?.kind === "batch" ? operation.assignments : undefined;
  if (
    value.workspaceId !== WORKSPACE_ID ||
    !Array.isArray(rawAssignments) ||
    rawAssignments.length === 0 ||
    !limits ||
    rawAssignments.length > Number(limits.episodeCount)
  ) {
    return null;
  }
  const assignments: {
    assignmentId: string;
    scenario: string;
    policy: string;
    seed: string;
    maxSteps: number;
  }[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawAssignments.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return null;
    const assignment = raw as Record<string, unknown>;
    if (
      typeof assignment.scenario !== "string" ||
      !Array.isArray(scenarios) ||
      !scenarios.includes(assignment.scenario) ||
      assignment.policy !== "random" ||
      !Array.isArray(policies) ||
      !policies.includes(assignment.policy) ||
      typeof assignment.seed !== "string" ||
      assignment.seed.length === 0 ||
      assignment.seed.length > 256 ||
      typeof assignment.maxSteps !== "number" ||
      !Number.isSafeInteger(assignment.maxSteps) ||
      assignment.maxSteps < 1 ||
      assignment.maxSteps > Number(limits.maxStepsPerEpisode)
    ) {
      return null;
    }
    const key = JSON.stringify([
      assignment.scenario,
      assignment.policy,
      assignment.seed
    ]);
    if (seen.has(key)) return null;
    seen.add(key);
    assignments.push({
      assignmentId: "a-" + String(index + 1).padStart(4, "0"),
      scenario: assignment.scenario,
      policy: assignment.policy,
      seed: assignment.seed,
      maxSteps: assignment.maxSteps
    });
  }
  return { requestId: value.requestId as string, assignments };
}

function syntheticLaunchIntentKey(actorId: string, requestId: string): string {
  return JSON.stringify([WORKSPACE_ID, actorId, requestId]);
}

function actorIdFromRequest(request: IncomingMessage): string {
  const value = request.headers["x-autodev-actor"];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function handleSyntheticAnalysisMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== "/control/playtesting/analyses") return false;
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    const episodeIds = body?.episodeIds;
    if (
      !body ||
      body.operation !== "dispatch" ||
      !Array.isArray(episodeIds) ||
      episodeIds.length === 0 ||
      episodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
      episodeIds.some((id) => !(typeof id === "string")) ||
      new Set(episodeIds).size !== episodeIds.length ||
      url.searchParams.get("workspaceId") !== WORKSPACE_ID
    ) {
      response.writeHead(400).end();
      return true;
    }
    const analysisId = `analysis-browser-${String(nextAnalystRunId++).padStart(3, "0")}`;
    const packets = episodeIds.flatMap((episodeId) => {
      const record =
        episodeId === episode.episodeId
          ? episode
          : syntheticRunEpisodes.get(episodeId);
      if (!record) return [];
      return [
        {
          episodeId,
          batchId: String(record.batchId),
          packetId: `packet-${analysisId}-${episodeId}`
        }
      ];
    });
    const packetIds = new Set(packets.map((packet) => packet.episodeId));
    const receipts = episodeIds
      .filter((episodeId) => !packetIds.has(episodeId))
      .map((episodeId) => ({
        episodeId,
        batchId: null,
        reason: "unknown-session",
        detail: "The synthetic fixture has no record for this session."
      }));
    const packetsByBatch = new Map<string, number>();
    for (const packet of packets) {
      packetsByBatch.set(
        packet.batchId,
        (packetsByBatch.get(packet.batchId) ?? 0) + 1
      );
    }
    const budget = Array.from(packetsByBatch, ([batchId, requested]) => ({
      batchId,
      reviewCap: 1,
      actualCritiques: 0,
      reserved: requested,
      requested,
      remaining: Math.max(0, 1 - requested)
    }));
    const run: SyntheticAnalystRun = {
      run: {
        analysisId,
        workspaceId: WORKSPACE_ID,
        createdAt: FIXTURE_TIMESTAMP,
        requestedEpisodeIds: episodeIds,
        packets,
        receipts,
        budget,
        synthesisId: null
      },
      synthesis: null,
      remainingRunningReads: 1,
      status: "running",
      finishedAt: null,
      reviews: []
    };
    syntheticAnalystRuns.set(analysisId, run);
    sendJson(
      response,
      {
        schema: "autodev-control-playtesting-analysis-v1",
        operation: "dispatch",
        workspaceId: WORKSPACE_ID,
        requested: episodeIds.length,
        packets,
        receipts,
        budget,
        analysis: {
          ...run.run,
          status: "running",
          finishedAt: null,
          reviews: [],
          synthesis: null,
          error: null
        }
      },
      202
    );
    return true;
  }
  if (request.method === "GET") {
    if (isSyntheticAnalystRunsReadFails) {
      sendJson(
        response,
        {
          error: {
            code: "synthetic_analyst_unavailable",
            message: "Synthetic analyst status is offline."
          }
        },
        503
      );
      return true;
    }
    if (url.searchParams.get("workspaceId") !== WORKSPACE_ID) {
      response.writeHead(404).end();
      return true;
    }
    const runs = Array.from(syntheticAnalystRuns.values(), (entry) => {
      if (entry.status === "running" && entry.remainingRunningReads > 0) {
        entry.remainingRunningReads -= 1;
      } else if (entry.status === "running") {
        entry.status = "completed";
        entry.finishedAt = FIXTURE_TIMESTAMP;
        entry.reviews.push(
          ...entry.run.packets.map((packet) => {
            const review = syntheticReviewForPacket(
              packet,
              entry.run.analysisId
            );
            syntheticRunReviews.set(packet.episodeId, review);
            return {
              episodeId: packet.episodeId,
              reviewId: review.reviewId,
              status: "hypothesis" as const
            };
          })
        );
        if (entry.run.packets.length >= 2) {
          const sourcePackets = entry.run.packets
            .map((packet) => ({
              episodeId: packet.episodeId,
              batchId: packet.batchId,
              packetId: packet.packetId
            }))
            .sort((left, right) =>
              left.episodeId < right.episodeId
                ? -1
                : left.episodeId > right.episodeId
                  ? 1
                  : 0
            );
          const metricSourceIndex = sourcePackets.findIndex(
            (source) => source.episodeId === episode.episodeId
          );
          const metricAggregationRows =
            metricSourceIndex === -1
              ? []
              : [
                  {
                    metricId: "legal-action-rejection",
                    metricVersion: 1,
                    phaseId: "tutorial",
                    unit: "proportion",
                    aggregation: "ratio-of-sums-within-scenario" as const,
                    analysisUnit: "episode" as const,
                    aggregationWindow: "phase" as const,
                    buildSha: BUILD_SHA,
                    gameBuild: "fixture-build-1",
                    rubricHash: RUBRIC_HASH,
                    evaluatorHash: "e".repeat(64),
                    measurementVersion: MEASUREMENT_VERSION,
                    scenarioId: "tutorial",
                    scenarioFamily: "tutorial",
                    policyId: "weak-bot",
                    policyVersion: "1",
                    cohort: "novice",
                    observationMode: "headless" as const,
                    sourcePacketIndices: [metricSourceIndex],
                    sessionCount: 1,
                    numerator: 0,
                    denominator: 3,
                    opportunityCount: 3,
                    missing: 0,
                    missingReasons: [],
                    estimate: 0,
                    coverage: 1,
                    independentUnits: 1
                  }
                ];
          entry.synthesis = {
            schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
            synthesisId: `synthesis-${entry.run.analysisId}`,
            version: 1,
            analysisId: entry.run.analysisId,
            workspaceId: WORKSPACE_ID,
            authorRole: "playtest-analyst",
            authorId: "analyst-browser-fixture",
            modelId: null,
            modelRevision: null,
            promptHash: null,
            generatedAt: FIXTURE_TIMESTAMP,
            status: "hypothesis",
            summary:
              "Across the selected packets, the warning consistently precedes a no-progress action; this remains a hypothesis.",
            contributors: entry.run.packets.map((packet) => ({ ...packet })),
            packetEligibleEpisodeIds: entry.run.packets.map(
              (packet) => packet.episodeId
            ),
            metricAggregation: {
              schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
              workspaceId: WORKSPACE_ID,
              analysisId: entry.run.analysisId,
              status:
                metricAggregationRows.length === 0
                  ? "no-applicable-metrics"
                  : "available",
              method: "ratio-of-sums-within-identical-stratum-v1",
              sourcePackets,
              rows: metricAggregationRows,
              omittedMetrics: [],
              reason:
                metricAggregationRows.length === 0
                  ? "no-applicable-metric-rows"
                  : null
            },
            claims: [
              {
                kind: "pattern",
                text: "Both packets show the warning before progress stops.",
                evidenceRefs: entry.run.packets.map((packet) => ({
                  episodeId: packet.episodeId,
                  packetId: packet.packetId,
                  locator: { kind: "event" as const, id: "event-1", step: 1 }
                }))
              }
            ],
            experiments: []
          };
          entry.run.synthesisId = entry.synthesis.synthesisId;
        }
      }
      return {
        ...entry.run,
        status: entry.status,
        finishedAt: entry.finishedAt,
        reviews: entry.reviews,
        error: null
      };
    });
    sendJson(response, {
      schema: "autodev-control-playtesting-analyses-v1",
      workspaceId: WORKSPACE_ID,
      runs: isSyntheticAnalystTaskHistoryMissing ? [] : runs,
      syntheses: Array.from(syntheticAnalystRuns.values()).flatMap((entry) =>
        entry.synthesis === null ? [] : [entry.synthesis]
      )
    });
    return true;
  }
  response.writeHead(405).end();
  return true;
}

async function handleSyntheticComparisonMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const decisionMatch = url.pathname.match(COMPARISON_DECISION_ROUTE);
  if (decisionMatch && request.method === "POST") {
    const comparisonId = decodeURIComponent(decisionMatch[1]!);
    const body = await readJsonBody(request);
    if (
      !body ||
      body.workspaceId !== WORKSPACE_ID ||
      body.comparisonId !== comparisonId ||
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion !== comparison.version ||
      (body.disposition !== "promote" && body.disposition !== "hold") ||
      typeof body.reason !== "string" ||
      body.reason.trim().length === 0
    ) {
      sendJson(response, { error: "Invalid or stale decision." }, 409);
      return true;
    }
    try {
      comparison = recordPlaytestOwnerDecision(comparison, {
        disposition: body.disposition,
        decidedAt: FIXTURE_TIMESTAMP,
        decidedBy: "console-e2e-operator",
        reason: body.reason
      });
    } catch {
      sendJson(response, { error: "Decision rejected." }, 400);
      return true;
    }
    sendJson(response, {
      schema: "autodev-control-playtesting-comparison-decision-v1",
      workspaceId: WORKSPACE_ID,
      comparison
    });
    return true;
  }
  return false;
}

/**
Whether a visual launch request is the one the fixture serves.

The fixture answers for the Runtime, so it accepts a request only when the
request is exactly the shape the Console sends for an approved target --
no extra keys, no missing ones, and the capability revision the readiness
read reported.
*/
function syntheticVisualLaunchShapeIsValid(
  launch: Record<string, unknown>,
  limits: unknown
): boolean {
  if (
    !isSyntheticVisualReadinessEnabled ||
    Object.keys(launch).length !== SYNTHETIC_VISUAL_LAUNCH_KEYS.size
  ) {
    return false;
  }
  if (
    Object.keys(launch).some((key) => !SYNTHETIC_VISUAL_LAUNCH_KEYS.has(key)) ||
    launch.schema !== PLAYTEST_LAUNCH_REQUEST_SCHEMA
  )
    return false;
  if (
    launch.workspaceId !== WORKSPACE_ID ||
    launch.targetId !== SYNTHETIC_VISUAL_TARGET.targetId
  )
    return false;
  if (
    launch.policyId !== FIXTURE_SMART_DIRECT_POLICY ||
    launch.capabilityRevision !== FIXTURE_CAPABILITY_REVISION
  )
    return false;
  if (
    typeof launch.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(launch.requestId)
  )
    return false;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return false;
  }
  const limitKeys = Object.keys(limits);
  if (limitKeys.length !== SYNTHETIC_VISUAL_LIMIT_KEYS.size) return false;
  return limitKeys.every((key) => SYNTHETIC_VISUAL_LIMIT_KEYS.has(key));
}

/**
Whether the requested budget is inside the approved target's budget.

The approved target is the ceiling: a launch may ask for less than the
approval allows and never for more.
*/
function syntheticVisualLimitsWithinApproval(
  launch: Record<string, unknown>,
  limits: Record<string, unknown>
): boolean {
  const approved = SYNTHETIC_VISUAL_TARGET.limits;
  const episodes = Number(limits.episodeCount);
  if (
    !Number.isSafeInteger(limits.episodeCount) ||
    episodes < 1 ||
    episodes > approved.episodeCount
  )
    return false;
  const steps = Number(limits.maxStepsPerEpisode);
  if (
    !Number.isSafeInteger(limits.maxStepsPerEpisode) ||
    steps < 1 ||
    steps > approved.maxStepsPerEpisode
  )
    return false;
  if (
    limits.wallTimeMs !== approved.wallTimeMs ||
    limits.smartRequestsPerEpisode !== approved.smartRequestsPerEpisode
  ) {
    return false;
  }
  if (
    limits.smartTokensPerEpisode !== approved.smartTokensPerEpisode ||
    limits.screenshotCountPerEpisode !== approved.screenshotCountPerEpisode
  ) {
    return false;
  }
  if (limits.artifactBytesPerEpisode !== approved.artifactBytesPerEpisode) {
    return false;
  }
  if (launch.areasOfFocus === null) return true;
  if (typeof launch.areasOfFocus !== "string") return false;
  return launch.areasOfFocus.length <= 2000;
}

/**
The fixture's answer to a visual launch.

A visual launch is a different request from an adapter launch: it names an
approved target, a budget inside that target, and a focus. It is handled
on its own so the two launches cannot be confused for one another.
*/
function handleSyntheticVisualLaunch(
  launch: Record<string, unknown>,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const limits = launch.limits;
  if (!syntheticVisualLaunchShapeIsValid(launch, limits)) {
    sendJson(
      response,
      {
        error: {
          code: "synthetic_visual_launch_invalid",
          message: "Synthetic visual launch request was invalid."
        }
      },
      400
    );
    return true;
  }
  const requestedLimits = limits as Record<string, unknown>;
  if (!syntheticVisualLimitsWithinApproval(launch, requestedLimits)) {
    sendJson(
      response,
      {
        error: {
          code: "synthetic_visual_launch_out_of_bounds",
          message:
            "Synthetic visual budget exceeded the approved fixture limits."
        }
      },
      409
    );
    return true;
  }
  if (!isSyntheticVisualRunEnabled) {
    sendJson(
      response,
      {
        error: {
          code: "synthetic_visual_launch_refused",
          message:
            "Synthetic launch request captured; no browser or game was started."
        }
      },
      409
    );
    return true;
  }
  const launchIntentHash = createHash("sha256")
    .update(JSON.stringify(launch))
    .digest("hex");
  const actorId = actorIdFromRequest(request);
  const requestKey = syntheticLaunchIntentKey(
    actorId,
    launch.requestId as string
  );
  const priorIntent = syntheticLaunchIntents.get(requestKey);
  if (priorIntent) {
    if (priorIntent.launchIntentHash !== launchIntentHash) {
      sendJson(
        response,
        {
          error: {
            code: "autodev_control_playtesting_request_id_conflict",
            message: "This requestId is already bound to another payload."
          }
        },
        409
      );
      return true;
    }
    sendJson(
      response,
      {
        schema: FIXTURE_RUN_STARTED_SCHEMA,
        workspaceId: WORKSPACE_ID,
        batchId: priorIntent.batchId,
        assignmentCount: priorIntent.assignmentCount,
        assignmentIds: priorIntent.assignmentIds,
        sessions: priorIntent.sessions,
        createdAt: priorIntent.createdAt,
        status: syntheticRuns.get(priorIntent.batchId)?.status ?? "running"
      },
      202
    );
    return true;
  }
  const batchId = `batch-visual-live-${String(nextRunId++).padStart(3, "0")}`;
  const visualAssignments: SyntheticRunAssignment[] = Array.from(
    { length: Number(requestedLimits.episodeCount) },
    (_, index) => ({
      assignmentId:
        "vis-assign-" +
        batchId.replace(FIXTURE_BATCH_ID_PREFIX, "") +
        "-" +
        String(index),
      scenario: "visual-exploration",
      policy: FIXTURE_SMART_DIRECT_POLICY,
      // The synthetic run remains pending until the test fixture is reset.
      seed: "hold-visual-" + String(index),
      maxSteps: Number(requestedLimits.maxStepsPerEpisode)
    })
  );
  const sessions = syntheticSessionReferences(
    FIXTURE_AUTONOMOUS_VISUAL_MODE,
    batchId,
    visualAssignments
  );
  const createdAt = FIXTURE_TIMESTAMP;
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ batchId, sessions, createdAt }))
    .digest("hex");
  const launchedRunReviewSelection = selectPlaytestBatchReviews({
    inventoryHash: manifestHash,
    maxReviewedSessions: 0,
    critiqueBudget: 0,
    surveillanceSessions: 0,
    discoverySessions: 0,
    discoverySignal: null,
    candidates: [],
    unreviewableAssignments: 0,
    selectedAt: createdAt
  });
  syntheticRuns.set(batchId, {
    workspaceId: WORKSPACE_ID,
    mode: FIXTURE_AUTONOMOUS_VISUAL_MODE,
    createdAt,
    assignments: visualAssignments,
    assignmentCount: visualAssignments.length,
    manifestHash,
    reviewSelection: launchedRunReviewSelection,
    episodes: [],
    status: "running",
    cancellationRequested: false
  });
  const intent = {
    launchIntentHash,
    batchId,
    assignmentCount: visualAssignments.length,
    assignmentIds: visualAssignments.map(
      (assignment) => assignment.assignmentId
    ),
    sessions,
    createdAt
  };
  syntheticLaunchIntents.set(requestKey, intent);
  if (isFailNextRunAcknowledgement) {
    isFailNextRunAcknowledgement = false;
    sendJson(
      response,
      {
        error: {
          code: "synthetic_ack_lost",
          message:
            "The fixture persisted the visual launch but lost its acknowledgement."
        }
      },
      503
    );
    return true;
  }
  sendJson(
    response,
    {
      schema: FIXTURE_RUN_STARTED_SCHEMA,
      workspaceId: WORKSPACE_ID,
      batchId,
      assignmentCount: visualAssignments.length,
      assignmentIds: intent.assignmentIds,
      sessions,
      createdAt,
      status: "running"
    },
    202
  );
  return true;
}

async function handleSyntheticLaunchMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (
    url.pathname !== "/control/playtesting/runs" ||
    request.method !== "POST"
  ) {
    return false;
  }

  const launch = await readJsonBody(request);
  if (launch?.mode === FIXTURE_AUTONOMOUS_VISUAL_MODE) {
    return handleSyntheticVisualLaunch(launch, request, response);
  }
  const runRequest = activeSyntheticRunRequest(launch);
  if (!runRequest) {
    response.writeHead(400).end();
    return true;
  }
  const launchIntentHash = createHash("sha256")
    .update(JSON.stringify(launch))
    .digest("hex");
  const actorId = actorIdFromRequest(request);
  const requestKey = syntheticLaunchIntentKey(actorId, runRequest.requestId);
  const priorIntent = syntheticLaunchIntents.get(requestKey);
  if (priorIntent) {
    if (priorIntent.launchIntentHash !== launchIntentHash) {
      sendJson(
        response,
        {
          error: {
            code: "autodev_control_playtesting_request_id_conflict",
            message: "This requestId is already bound to another payload."
          }
        },
        409
      );
      return true;
    }
    const priorRun = syntheticRuns.get(priorIntent.batchId);
    if (priorRun) completeSyntheticRunIfReady(priorRun);
    sendJson(
      response,
      {
        schema: FIXTURE_RUN_STARTED_SCHEMA,
        workspaceId: WORKSPACE_ID,
        batchId: priorIntent.batchId,
        assignmentCount: priorIntent.assignmentCount,
        assignmentIds: priorIntent.assignmentIds,
        sessions: priorIntent.sessions,
        createdAt: priorIntent.createdAt,
        status: priorRun?.status ?? "running"
      },
      202
    );
    return true;
  }
  const batchId = `batch-browser-${String(nextRunId++).padStart(3, "0")}`;
  const manifestBase = {
    ...assignmentManifestBase,
    batchId,
    assignments: runRequest.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      scenarioId: assignment.scenario,
      scenarioFamily: assignment.scenario,
      policyId: assignment.policy,
      policyVersion: "hmac-sha256-v1",
      seed: assignment.seed,
      maxSteps: assignment.maxSteps
    }))
  };
  const manifestHash = createHash("sha256")
    .update(playtestAssignmentManifestHashInput(manifestBase))
    .digest("hex");
  const episodes = runRequest.assignments.map((assignment) => {
    const episodeId = playtestEpisodeRecordId(batchId, assignment.assignmentId);
    const record = {
      ...episode,
      episodeId,
      batchId,
      assignmentId: assignment.assignmentId,
      branchLineage: null,
      identity: {
        ...episode.identity,
        scenarioId: assignment.scenario,
        seed: assignment.seed
      },
      scenarioFamily: assignment.scenario,
      stepCount: Math.min(episode.stepCount, assignment.maxSteps)
    } as Record<string, unknown>;
    return { episodeId, record };
  });
  const selectedReview = selectPlaytestBatchReviews({
    inventoryHash: manifestHash,
    maxReviewedSessions: 1,
    critiqueBudget: 1,
    surveillanceSessions: 1,
    discoverySessions: 0,
    discoverySignal: null,
    candidates: runRequest.assignments.map((assignment, index) => ({
      assignmentId: assignment.assignmentId,
      episodeId: episodes[index]!.episodeId,
      policyId: assignment.policy,
      scenarioId: assignment.scenario,
      outcomeKey: playtestReviewOutcomeKey("completed", episode.outcome),
      metrics: episode.metrics
    })),
    unreviewableAssignments: 0,
    selectedAt: FIXTURE_TIMESTAMP
  });
  const createdAt = new Date().toISOString();
  syntheticRuns.set(batchId, {
    workspaceId: WORKSPACE_ID,
    mode: "adapter-accelerated",
    createdAt,
    assignments: runRequest.assignments,
    assignmentCount: runRequest.assignments.length,
    manifestHash,
    reviewSelection: selectedReview,
    episodes,
    status: "running",
    cancellationRequested: false
  });
  const intent = {
    launchIntentHash,
    batchId,
    assignmentCount: runRequest.assignments.length,
    assignmentIds: runRequest.assignments.map(
      (assignment) => assignment.assignmentId
    ),
    sessions: syntheticSessionReferences(
      "adapter-accelerated",
      batchId,
      runRequest.assignments
    ),
    createdAt
  };
  syntheticLaunchIntents.set(requestKey, intent);
  if (isFailNextRunAcknowledgement) {
    isFailNextRunAcknowledgement = false;
    sendJson(
      response,
      {
        error: {
          code: "synthetic_ack_lost",
          message:
            "The fixture persisted the launch but lost its acknowledgement."
        }
      },
      503
    );
    return true;
  }
  sendJson(
    response,
    {
      schema: FIXTURE_RUN_STARTED_SCHEMA,
      workspaceId: WORKSPACE_ID,
      batchId,
      assignmentCount: runRequest.assignments.length,
      assignmentIds: runRequest.assignments.map(
        (assignment) => assignment.assignmentId
      ),
      sessions: intent.sessions,
      createdAt,
      status: "running"
    },
    202
  );
  return true;
}

async function handleSyntheticCancellationMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(CANCEL_RUN_ROUTE);
  if (!match || request.method !== "POST") return false;
  const batchId = decodeURIComponent(match[1]!);
  const body = await readJsonBody(request);
  const run = syntheticRuns.get(batchId);
  if (
    !body ||
    url.searchParams.get("workspaceId") !== WORKSPACE_ID ||
    body.expectedStatus !== "running" ||
    !run ||
    run.status !== "running"
  ) {
    response.writeHead(409).end();
    return true;
  }
  run.status = "cancelled";
  run.cancellationRequested = true;
  sendJson(
    response,
    {
      schema: "autodev-control-playtesting-run-cancellation-v1",
      workspaceId: WORKSPACE_ID,
      batchId,
      cancellationRequested: true
    },
    202
  );
  return true;
}

async function handleSyntheticRunMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (
    (await handleSyntheticComparisonMutation(request, response, url)) ||
    (await handleSyntheticLaunchMutation(request, response, url))
  ) {
    return true;
  }
  return handleSyntheticCancellationMutation(request, response, url);
}

function syntheticModeReadiness(
  approved: boolean,
  runnableAssignmentCount: number
) {
  return {
    [ADAPTER_EXECUTION_MODE]:
      approved && runnableAssignmentCount > 0
        ? { status: "ready", reasons: [] }
        : {
            status: "check-required",
            reasons: [
              {
                code: "adapter-approval-required",
                label: "Approval required",
                message:
                  "Workspaces must approve the adapter checkout before it can run.",
                severity: "check-required"
              }
            ]
          },
    "autonomous-visual": isSyntheticVisualReadinessEnabled
      ? {
          status: "ready",
          reasons: [],
          targetStore: "available",
          targets: [
            {
              target: SYNTHETIC_VISUAL_TARGET,
              eligibility: "supported",
              reasons: []
            }
          ],
          policies: syntheticVisualPolicyReadiness()
        }
      : {
          status: "unavailable",
          reasons: [
            {
              code: "visual-target-required",
              label: "No visual target approved",
              message:
                "Approve an already-running browser game URL in Workspaces before visual play can be considered.",
              severity: "check-required"
            },
            {
              code: "visual-driver-unavailable",
              label: "Visual driver unavailable",
              message:
                "The isolated browser driver is not yet connected to the Runtime session owner and persisted visual evidence flow.",
              severity: "unavailable"
            },
            {
              code: "smart-direct-policy-unavailable",
              label: "Smart-direct policy unavailable",
              message:
                "Runtime cannot yet make bounded Smart-direct gameplay decisions for visual sessions.",
              severity: "unavailable"
            }
          ],
          targetStore: "available",
          targets: [],
          policies: []
        },
    "scripted-regression": {
      status: "unavailable",
      reasons: [
        {
          code: "scripted-regression-unavailable",
          label: "Scripted regression unavailable",
          message:
            "Runtime does not yet have the approved scripted-regression launch path.",
          severity: "unavailable"
        }
      ]
    }
  } as const;
}

/**
Each decision backend the visual mode offers, with its own readiness.

A mode being ready says the browser can be driven; it does not say that
every backend can be reached. The launch form refuses to start a run
against a backend that cannot be reached, so a fixture that offered only
the mode's readiness would leave the form disabled for no stated reason.
*/
function syntheticVisualPolicyReadiness() {
  return [
    {
      policyId: FIXTURE_SMART_DIRECT_POLICY as const,
      status: "ready" as const,
      reasons: []
    },
    {
      policyId: "onejev-local" as const,
      status: "unavailable" as const,
      reasons: [
        {
          code: "onejev-local-policy-unavailable",
          label: "Local OneJev server unavailable",
          message:
            "The local OneJev model server is not reachable. Start it with `qev serve` on the approved local endpoint, or choose the Smart-directed route.",
          severity: "unavailable" as const
        }
      ]
    }
  ];
}

function handleSyntheticReadFailureConfig(
  url: URL,
  response: ServerResponse
): boolean {
  switch (url.pathname) {
    case "/fixture/runs-read-fail": {
      isSyntheticRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, { syntheticRunsReadFails: isSyntheticRunsReadFails });
      return true;
    }
    case "/fixture/run-ack-failure": {
      isFailNextRunAcknowledgement = url.searchParams.get("mode") === "once";
      sendJson(response, {
        failNextRunAcknowledgement: isFailNextRunAcknowledgement
      });
      return true;
    }
    case "/fixture/run-by-request-not-found": {
      isFailNextRunByRequestLookup = url.searchParams.get("mode") === "once";
      sendJson(response, {
        failNextRunByRequestLookup: isFailNextRunByRequestLookup
      });
      return true;
    }
    case "/fixture/run-count": {
      sendJson(response, { count: syntheticRuns.size });
      return true;
    }
    case "/fixture/visual-readiness": {
      isSyntheticVisualReadinessEnabled = ["ready", "run"].includes(
        url.searchParams.get("mode") ?? ""
      );
      isSyntheticVisualRunEnabled = url.searchParams.get("mode") === "run";
      sendJson(response, {
        syntheticVisualReadinessEnabled: isSyntheticVisualReadinessEnabled,
        syntheticVisualRunEnabled: isSyntheticVisualRunEnabled
      });
      return true;
    }
    case "/fixture/analyses-read-fail": {
      isSyntheticAnalystRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, {
        syntheticAnalystRunsReadFails: isSyntheticAnalystRunsReadFails
      });
      return true;
    }
    case "/fixture/analyst-history": {
      isSyntheticAnalystTaskHistoryMissing =
        url.searchParams.get("mode") === "missing";
      sendJson(response, {
        syntheticAnalystTaskHistoryMissing: isSyntheticAnalystTaskHistoryMissing
      });
      return true;
    }
    default: {
      return false;
    }
  }
}

function sendSyntheticCapabilities(response: ServerResponse): void {
  const limits = workspaceApproval?.limits as
    Record<string, unknown> | undefined;
  const scenarios =
    (workspaceApproval?.allowedScenarios as string[] | undefined) ?? [];
  const policies =
    (workspaceApproval?.allowedPolicies as string[] | undefined) ?? [];
  const approved =
    workspaceApproval !== null && workspaceApproval.revokedAt === null;
  const runnableAssignments =
    approved &&
    limits &&
    scenarios.includes("tutorial") &&
    policies.includes("random")
      ? [
          {
            scenarioId: "tutorial",
            scenarioFamily: "tutorial",
            policyId: "random",
            policyVersion: "hmac-sha256-v1",
            cohort: "exploratory",
            strategy: "uniform-legal-action",
            maxStepsPerEpisode: Number(limits.maxStepsPerEpisode)
          }
        ]
      : [];
  sendJson(response, {
    schema: "autodev-control-playtesting-capabilities-v3",
    workspaceId: WORKSPACE_ID,
    capabilityRevision: "e".repeat(64),
    workspaceCatalog: "valid",
    workspaceEnabled: true,
    operatorActionsAvailable: true,
    modeReadiness: syntheticModeReadiness(approved, runnableAssignments.length),
    approved,
    approvalRevision: approved ? workspaceApproval.revision : null,
    // The synthetic checkout's latest committed build.
    buildSha: approved ? BUILD_SHA : null,
    gameBuild: approved ? BUILD_SHA : null,
    allowedScenarios: scenarios,
    approvedPolicies: policies,
    supportedPolicies: ["random"],
    runnablePolicies: runnableAssignments.length > 0 ? ["random"] : [],
    unsupportedApprovedPolicies: policies.filter(
      (policy) => policy !== "random"
    ),
    configurationStatus: approved ? "validated" : "not-checked",
    maxBatchAssignments:
      approved && limits
        ? Math.min(PLAYTESTS_MAX_BATCH_ASSIGNMENTS, Number(limits.episodeCount))
        : 0,
    runnableAssignments,
    admissibleSeeds: null,
    policyProfiles: runnableAssignments.map((assignment) => ({
      policyId: assignment.policyId,
      version: assignment.policyVersion,
      cohort: assignment.cohort,
      strategy: assignment.strategy
    })),
    limits: approved ? limits : null,
    issueReporting: approved ? workspaceApproval.issueReporting : "disabled",
    configuredIssueReporting: "disabled",
    humanStudyAllowed: approved ? workspaceApproval.humanStudyAllowed : false,
    revokedAt: workspaceApproval?.revokedAt ?? null,
    runPreflight: "required-at-start"
  });
}

function completeSyntheticRunIfReady(run: SyntheticRun): void {
  if (
    run.status === "running" &&
    !run.assignments.some(
      (assignment) =>
        assignment.seed === "hold" || assignment.seed.startsWith("hold-")
    )
  ) {
    run.status = "completed";
    for (const entry of run.episodes) {
      syntheticRunEpisodes.set(entry.episodeId, entry.record);
    }
  }
}

function syntheticRunResult(
  batchId: string,
  run: SyntheticRun
): Record<string, unknown> | null {
  if (run.status === "running") return null;
  const completed = run.status === "completed";
  const cancelled = run.status === "cancelled";
  const outcomes = run.assignments.map((assignment, index) => ({
    assignmentId: assignment.assignmentId,
    episodeId: completed ? run.episodes[index]!.episodeId : null,
    state: completed ? "completed" : "cancelled",
    started: completed,
    eligible: completed,
    gameOutcome: completed ? "unknown" : null
  }));
  const runCounts = {
    assigned: run.assignmentCount,
    started: completed ? run.assignmentCount : 0,
    completed: completed ? run.assignmentCount : 0,
    crashed: 0,
    infrastructureFailed: 0,
    cancelled: cancelled ? run.assignmentCount : 0,
    budgetTruncated: 0,
    reviewed: 0,
    eligible: completed ? run.assignmentCount : 0
  };
  return {
    batchId,
    assignmentCount: run.assignmentCount,
    manifestHash: run.manifestHash,
    concurrency: 1,
    outcomes,
    counts: runCounts,
    reviewSelection: completed
      ? run.reviewSelection
      : { status: "unavailable", reason: "batch-incomplete" },
    cancellation: cancelled ? "cancelled" : null,
    selectedReviewEpisodeIds: completed
      ? run.reviewSelection.selected.map((selected) => selected.episodeId)
      : []
  };
}

function sendSyntheticRunStatus(
  response: ServerResponse,
  batchId: string
): boolean {
  const run = syntheticRuns.get(batchId);
  if (!run) {
    response.writeHead(404).end();
    return true;
  }
  completeSyntheticRunIfReady(run);
  sendJson(response, {
    schema: "autodev-control-playtesting-run-status-v1",
    workspaceId: WORKSPACE_ID,
    run: {
      batchId,
      status: run.status,
      cancellationReason: run.status === "cancelled" ? "cancelled" : null,
      result: syntheticRunResult(batchId, run),
      error: null
    }
  });
  return true;
}

/**
 * The fixture's answer to a request for the run a request id started.
 */
function respondSyntheticRunByRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  const requestId = url.searchParams.get("requestId") ?? "";
  const intent = syntheticLaunchIntents.get(
    syntheticLaunchIntentKey(actorIdFromRequest(request), requestId)
  );
  // A one-shot transient: the prior Visual POST was persisted, but this
  // single by-request recovery must temporarily report the canonical
  // not-found envelope so the Console can re-POST the saved payload.
  const transientNotFound = isFailNextRunByRequestLookup;
  if (transientNotFound) isFailNextRunByRequestLookup = false;
  if (!intent || transientNotFound) {
    sendJson(response, {
      schema: "autodev-control-playtesting-run-request-v2",
      workspaceId: WORKSPACE_ID,
      requestId,
      state: "not-found",
      batchId: null,
      assignmentCount: null,
      assignmentIds: [],
      sessions: [],
      createdAt: null,
      status: null
    });
    return true;
  }
  const run = syntheticRuns.get(intent.batchId);
  if (run) completeSyntheticRunIfReady(run);
  sendJson(response, {
    schema: "autodev-control-playtesting-run-request-v2",
    workspaceId: WORKSPACE_ID,
    requestId,
    state: run ? "accepted" : "pending",
    batchId: intent.batchId,
    assignmentCount: intent.assignmentCount,
    assignmentIds: run ? intent.assignmentIds : [],
    sessions: run ? intent.sessions : [],
    createdAt: intent.createdAt,
    status: run ? run.status : null
  });
  return true;
}

/**
 * The fixture's answer to a request for every run in the workspace.
 */
function respondSyntheticRunList(response: ServerResponse): boolean {
  // Like the Runtime, a batch progresses regardless of which read observes
  // it; the active list then omits it once it is terminal.
  for (const run of syntheticRuns.values()) completeSyntheticRunIfReady(run);
  const runs = [...syntheticRuns.entries()]
    .filter(
      ([, run]) => run.workspaceId === WORKSPACE_ID && run.status === "running"
    )
    .map(([batchId, run]) => ({
      batchId,
      assignmentCount: run.assignmentCount,
      createdAt: run.createdAt,
      sessions: syntheticSessionReferences(run.mode, batchId, run.assignments),
      // The same owner record the single-batch status route returns, so one
      // workspace read renders every live batch.
      status: {
        batchId,
        status: "running",
        cancellationReason: null,
        result: syntheticRunResult(batchId, run),
        error: null
      }
    }));
  if (isSyntheticRunsReadFails) {
    // A deliberately unreadable read: the Console must show an explicit
    // unavailable state rather than freezing the last good frame.
    sendJson(
      response,
      {
        error: {
          code: "synthetic_unavailable",
          message: "Synthetic run store is offline."
        }
      },
      503
    );
    return true;
  }
  sendJson(response, {
    schema: "autodev-control-playtesting-runs-v2",
    workspaceId: WORKSPACE_ID,
    runs
  });
  return true;
}

function handleSyntheticRunRead(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/control/playtesting/capabilities") {
    sendSyntheticCapabilities(response);
    return true;
  }
  if (url.pathname === "/control/playtesting/runs/by-request") {
    return respondSyntheticRunByRequest(request, response, url);
  }
  if (url.pathname === "/control/playtesting/runs") {
    return respondSyntheticRunList(response);
  }
  const match = url.pathname.match(STATUS_RUN_ROUTE);
  return match
    ? sendSyntheticRunStatus(response, decodeURIComponent(match[1]!))
    : false;
}

function respondSyntheticReadiness(
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/control/playtesting/readiness") return false;
  if (isSyntheticReadinessUnavailable) {
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_playtesting_source_unavailable",
          message: "Synthetic Playtesting schema initialization failed."
        }
      },
      503
    );
    return true;
  }
  const poll = syntheticReadinessPollCount++;
  const status =
    poll < syntheticReadinessPendingPolls ? "initializing" : "ready";
  sendJson(response, {
    schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
    workspaceId: WORKSPACE_ID,
    status
  });
  return true;
}

function respondSyntheticPlaytestingDataReadiness(
  response: ServerResponse
): boolean {
  const code = isSyntheticReadinessUnavailable
    ? "autodev_control_playtesting_source_unavailable"
    : syntheticReadinessPollCount < syntheticReadinessPendingPolls
      ? "autodev_control_playtesting_source_initializing"
      : null;
  if (code === null) return false;
  sendJson(
    response,
    {
      error: {
        code,
        message:
          code === "autodev_control_playtesting_source_unavailable"
            ? "Synthetic Playtesting schema initialization failed."
            : "Synthetic Playtesting schema is initializing."
      }
    },
    503
  );
  return true;
}

function syntheticEpisodeFor(episodeId: string) {
  if (episodeId === episode.episodeId) return episode;
  if (episodeId === VISUAL_EPISODE_ID) return visualEpisode;
  if (episodeId === loopGuardEpisode.episodeId) return loopGuardEpisode;
  return syntheticRunEpisodes.get(episodeId);
}

/**
 * The fixture's answer to a request for one episode.
 */
function respondSyntheticEpisodeDetail(
  response: ServerResponse,
  url: URL
): boolean {
  const episodeMatch = url.pathname.match(PLAYTEST_EPISODE_DETAIL_ROUTE);
  if (episodeMatch) {
    const episodeId = decodeURIComponent(episodeMatch[1]!);
    const record = syntheticEpisodeFor(episodeId);
    if (!record) {
      sendJson(response, { error: "Not found" }, 404);
      return true;
    }
    sendJson(response, {
      schema: "autodev-control-playtesting-detail-v4",
      workspaceId: WORKSPACE_ID,
      resource: "episode",
      readOnly: true,
      record,
      latestReview:
        episodeId === episode.episodeId
          ? latestReview
          : (syntheticRunReviews.get(episodeId) ?? null),
      latestDiscoveryReview: null,
      visualAssignment:
        episodeId === VISUAL_EPISODE_ID
          ? {
              targetId: "visual-fixture-target",
              targetApprovalId: "visual-fixture-approval",
              targetRevision: 1,
              targetOrigin: "http://127.0.0.1:5173",
              areasOfFocus: "Explore the setup menu without starting a race."
            }
          : null
    });
    return true;
  }
  return false;
}

/**
 * The fixture's answer to a request for one episode's evidence window.
 */
function respondSyntheticEpisodeWindow(
  response: ServerResponse,
  url: URL
): boolean {
  const windowMatch = url.pathname.match(PLAYTEST_EPISODE_WINDOW_ROUTE);
  if (windowMatch) {
    const episodeId = decodeURIComponent(windowMatch[1]!);
    const artifactId = decodeURIComponent(windowMatch[2]!);
    const record = syntheticEpisodeFor(episodeId);
    const visualTrace =
      episodeId === VISUAL_EPISODE_ID && artifactId === VISUAL_TRACE_ID;
    if (!record || (artifactId !== TRACE_ID && !visualTrace)) {
      response.writeHead(404).end();
      return true;
    }
    const startStep = Number(url.searchParams.get("startStep"));
    const endStep = Number(url.searchParams.get("endStep"));
    const entries = (
      visualTrace
        ? [
            {
              step: 0,
              phaseId: "setup",
              observationVisibility: "visual-only",
              visibleObservation: {
                capturedAt: FIXTURE_TIMESTAMP,
                phase: "setup",
                controls: [
                  {
                    controlId: "start-race",
                    name: "Start race",
                    enabled: true
                  },
                  { controlId: "select-car", name: "Select car", enabled: true }
                ]
              },
              selectedActionId: null,
              preActionPrediction: {
                intention: "Explore the setup menu.",
                predictedVisibleEffect: "The menu remains open."
              },
              authoritativeOutcome: { stopReason: "step-limit" },
              events: []
            }
          ]
        : [
            {
              type: "step",
              step: 0,
              state: { room: "start" },
              actionId: "look"
            },
            {
              type: "event",
              event: { step: 1, eventId: "event-1", type: "warning-shown" }
            },
            {
              type: "event",
              event: {
                step: 2,
                eventId: "event-2",
                type: "legal-action-noop"
              }
            },
            {
              step: 3,
              selectedActionId: "advance-segment",
              observationHash: "c".repeat(16),
              visibleObservation: { phaseId: "race_and_energy" },
              executed: false,
              events: []
            }
          ]
    ).filter(
      (entry) =>
        entry.step === undefined ||
        (entry.step >= startStep && entry.step <= endStep)
    );
    sendJson(response, {
      schema: "autodev-control-playtesting-window-v1",
      workspaceId: WORKSPACE_ID,
      episodeId,
      artifactId,
      sha256: visualTrace ? "d".repeat(64) : "b".repeat(64),
      mediaType: "application/x-ndjson",
      startStep,
      endStep,
      sourceLineCount: visualTrace ? 1 : 3,
      omittedLineCount: 0,
      entries
    });
    return true;
  }
  return false;
}

function handleSyntheticPlaytestingRead(
  response: ServerResponse,
  url: URL
): boolean {
  if (respondSyntheticReadiness(response, url)) return true;
  if (respondSyntheticPlaytestingDataReadiness(response)) return true;
  if (url.pathname === "/control/playtesting/batches") {
    sendJson(response, page("batches", [batch], 1));
    return true;
  }
  if (url.pathname === "/control/playtesting/episodes") {
    const episodes = [episode, ...syntheticRunEpisodes.values()];
    sendJson(response, page("episodes", episodes, episodes.length));
    return true;
  }
  if (url.pathname === "/control/playtesting/findings") {
    sendJson(response, page("findings", [finding], 1));
    return true;
  }
  if (url.pathname === "/control/playtesting/reviews") {
    respondPlaytestingReviews(response);
    return true;
  }
  if (url.pathname === "/control/playtesting/comparisons") {
    sendJson(response, page("comparisons", [comparison], 1));
    return true;
  }
  if (PLAYTEST_EPISODE_DETAIL_ROUTE.test(url.pathname)) {
    return respondSyntheticEpisodeDetail(response, url);
  }
  if (PLAYTEST_EPISODE_WINDOW_ROUTE.test(url.pathname)) {
    return respondSyntheticEpisodeWindow(response, url);
  }
  if (
    url.pathname ===
      `/control/playtesting/episodes/${episode.episodeId}/media/${FRAME_ID}` ||
    url.pathname ===
      `/control/playtesting/episodes/${VISUAL_EPISODE_ID}/media/${VISUAL_FRAME_ID}`
  ) {
    response
      .writeHead(200, {
        "content-type": "image/png",
        "content-length": FRAME_BYTES.byteLength,
        "cache-control": "no-store"
      })
      .end(FRAME_BYTES);
    return true;
  }
  return false;
}

function resetSyntheticFixture(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  if (request.url === undefined || !request.url.startsWith("/fixture/reset")) {
    return false;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  workspaceApproval = null;
  comparison = structuredClone(initialComparison);
  syntheticRuns.clear();
  syntheticLaunchIntents.clear();
  syntheticRunEpisodes.clear();
  syntheticRunReviews.clear();
  syntheticAnalystRuns.clear();
  nextRunId = 1;
  nextAnalystRunId = 1;
  isSyntheticRunsReadFails = false;
  isSyntheticVisualReadinessEnabled = false;
  isSyntheticVisualRunEnabled = false;
  isFailNextRunAcknowledgement = false;
  isFailNextRunByRequestLookup = false;
  syntheticReadinessPendingPolls = 0;
  syntheticReadinessPollCount = 0;
  isSyntheticReadinessUnavailable = false;
  isSyntheticAnalystRunsReadFails = false;
  isSyntheticAnalystTaskHistoryMissing = false;
  skillAssignmentRevision = INITIAL_SKILL_ASSIGNMENT_REVISION;
  skillRoles["code-review"] = [...INITIAL_SKILL_ROLES];
  isRuntimeUnavailable = false;
  mcpDeclaration = initialMcpDeclaration();
  sendJson(response, { reset: true });
  return true;
}

function handleSyntheticReadinessInitialization(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/control/playtesting/initialize") return false;
  if (
    request.method !== "POST" ||
    url.searchParams.get("workspaceId") !== WORKSPACE_ID
  ) {
    response.writeHead(400).end();
    return true;
  }
  isSyntheticReadinessUnavailable = false;
  syntheticReadinessPendingPolls = 0;
  sendJson(response, {
    schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
    workspaceId: WORKSPACE_ID,
    status: "ready"
  });
  return true;
}

function configureReadinessFixture(
  url: URL,
  response: ServerResponse
): boolean {
  if (url.pathname !== "/fixture/readiness") return false;
  isSyntheticReadinessUnavailable =
    url.searchParams.get("unavailable") === "on";
  const polls = Number(url.searchParams.get("pendingPolls") ?? 0);
  syntheticReadinessPendingPolls = Number.isSafeInteger(polls)
    ? Math.max(0, Math.min(10, polls))
    : 0;
  syntheticReadinessPollCount = 0;
  sendJson(response, {
    syntheticReadinessPendingPolls,
    syntheticReadinessUnavailable: isSyntheticReadinessUnavailable
  });
  return true;
}

/**
The route that assigns the roles of one skill.
*/
const SKILL_ROLES_ROUTE = /^\/control\/skills\/([^/]+)$/u;

/**
The route that reads one skill's canonical source.
*/
const SKILL_CONTENT_ROUTE = /^\/control\/skills\/([^/]+)\/content$/u;

/**
The route that reads one agent's detail.
*/
const AGENT_DETAIL_ROUTE = /^\/control\/agents\/([^/]+)$/u;

/**
The route that reads one prompt's detail.
*/
const PROMPT_DETAIL_ROUTE = /^\/control\/prompts\/([^/]+)$/u;

/**
The moment the fixture says a write was applied.
*/
const FIXTURE_APPLIED_AT = "2026-01-01T00:00:00.000Z";

/**
The agent kind a role runs as a leaf rather than as an orchestrator.
*/
const LEAF_AGENT_KIND = "leaf";

/**
The convergence verdict for a state the Runtime has not reported.
*/
const NOT_OBSERVED_CONVERGENCE = "not-observed";

/**
The skill role assignment the fixture holds.

The revision is what the Console's compare-and-swap is checked against, so
it has to move when the roles move: a page that loaded the old revision and
then saved is a conflict, which is the state the acceptance needs to reach.
*/
const INITIAL_SKILL_ASSIGNMENT_REVISION = "b".repeat(64);
const INITIAL_SKILL_ROLES = ["worker"];
let skillAssignmentRevision = INITIAL_SKILL_ASSIGNMENT_REVISION;
const skillRoles: Record<string, string[]> = {
  "code-review": [...INITIAL_SKILL_ROLES]
};

/**
The agent enablement the fixture holds.

The revision is what the Console's compare-and-swap is checked against, so
it has to move when the enablement moves: a page that loaded the old
revision and then wrote is a conflict, not a silent overwrite of somebody
else's change. The second role has no runtime projection at all, so it has
no enablement to change and no revision to offer -- which is the state the
Console has to keep distinct from "disabled".
*/
const INITIAL_AGENT_ENABLEMENT_REVISION = "a".repeat(64);
const agentEnablement: Record<
  string,
  { mutable: boolean; enabled: boolean; revision: string }
> = {
  default: {
    mutable: true,
    enabled: true,
    revision: INITIAL_AGENT_ENABLEMENT_REVISION
  },
  worker: { mutable: false, enabled: false, revision: "" }
};

function nextAgentEnablementRevision(revision: string): string {
  return (BigInt(`0x${revision}`) + 1n).toString(16).padStart(64, "0");
}

/**
The next revision of the canonical workspace configuration.

The revision is the catalog's own handle, so moving it is what makes a page
that holds the old one write against a catalog that has moved past it.
*/
function nextWorkspaceRevision(revision: string): string {
  return nextRevision(revision);
}

/**
The next revision of a canonical source.

The revision is the source's own handle, so moving it is what makes a page
that holds the old one write against a source that has moved past it.
*/
function nextRevision(revision: string): string {
  return (BigInt(`0x${revision}`) + 1n).toString(16).padStart(64, "0");
}

/**
One workspace's configuration, as the Runtime reports it.

The list and the detail read the same state through this one function, so a
write that lands is the same fact on both surfaces rather than two the
fixture keeps in step by hand.
*/
function workspaceConfigRecord(): {
  id: string;
  baseBranch: string;
  enabled: boolean;
  agentRoles: string[] | null;
  configuration: { status: "configured" };
  runtime: { status: "not-observed" };
} {
  return {
    id: workspaceConfig.id,
    baseBranch: workspaceConfig.baseBranch,
    enabled: workspaceConfig.enabled,
    agentRoles: workspaceConfig.agentRoles,
    configuration: { status: "configured" },
    runtime: { status: "not-observed" }
  };
}

/**
The canonical catalog's desired-vs-actual view, as the Runtime reports it.

The catalog is the file the fixture serves, so the observed generation is
the revision the fixture holds -- the same fact the write answers with.
*/
function workspaceConfigReconciliation(): {
  status: {
    convergence: "converged";
    desiredGeneration: string;
    observedGeneration: string;
    lastApplyAt: string | null;
    lastObservationAt: string | null;
    lastError: null;
    explanation: string;
  };
  history: unknown[];
} {
  return {
    status: {
      convergence: "converged",
      desiredGeneration: workspaceConfig.revision,
      observedGeneration: workspaceConfig.revision,
      lastApplyAt: null,
      lastObservationAt: null,
      lastError: null,
      explanation: "The canonical catalog matches the desired state."
    },
    history: []
  };
}

/**
One role's enablement, as the Runtime reports it.

The list and the detail read the same state through this one function, so a
write that lands is the same fact on both surfaces rather than two the
fixture keeps in step by hand.
*/
function agentEnablementFor(role: string): {
  kind: "observed" | "unavailable";
  enabled: boolean | null;
  mutable: boolean;
  revision?: string;
  reason?: string;
} {
  const state = agentEnablement[role];
  if (state === undefined || !state.mutable) {
    return {
      kind: "unavailable",
      enabled: null,
      mutable: false,
      reason: "The fixture has no runtime enablement projection."
    };
  }
  return {
    kind: "observed",
    enabled: state.enabled,
    mutable: true,
    revision: state.revision
  };
}

function nextSkillAssignmentRevision(): string {
  return (BigInt(`0x${skillAssignmentRevision}`) + 1n)
    .toString(16)
    .padStart(64, "0");
}

/**
Where the fixture's skills are installed.

The fixture's catalogue is a repository's own `.rulesync/skills` directory,
so the skill is installed inside that repository and belongs to the
workspace that repository is. The scope is read from the machine and is
never the caller's to say, so a write that names a different workspace is
refused rather than applied somewhere it does not belong.
*/
const FIXTURE_SKILL_SCOPES: Readonly<
  Record<
    string,
    { readonly scope: string | null; readonly workspace: string | null }
  >
> = {
  "code-review": { scope: "repo", workspace: WORKSPACE_ID }
};

/**
Why an assignment may not be made where it was asked for, if it may not.

`null` is "the assignment may be made here". The rule is the Runtime's own:
a skill installed inside a repository belongs to that repository's workspace
alone, and a skill installed anywhere else is assigned to agent roles
globally rather than to one workspace.
*/
function skillScopeRefusal(
  name: string,
  requestedWorkspace: string | null
): string | null {
  const facts = FIXTURE_SKILL_SCOPES[name] ?? null;
  if (facts?.scope === "repo") {
    if (facts.workspace === null) {
      return "This skill is installed inside the repository, and the repository is not one of the configured workspaces, so there is nowhere to assign it.";
    }
    if (requestedWorkspace !== facts.workspace) {
      return `This skill belongs to the workspace "${facts.workspace}" and can only be assigned inside it.`;
    }
    return null;
  }
  if (requestedWorkspace !== null) {
    return "This skill is not installed inside the repository, so it is assigned to agent roles globally rather than to one workspace.";
  }
  return null;
}

/**
The skill role assignment write.

The whole desired set travels with the write, so the fixture replaces the
roles rather than adding to them, and the write is checked against the
revision the caller read: a page holding a stale revision is a conflict,
not a silent overwrite of somebody else's assignment.
*/
async function handleSyntheticSkillRoleMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(SKILL_ROLES_ROUTE);
  if (match === null) return false;
  if (request.method !== "PATCH") {
    response.writeHead(405).end();
    return true;
  }
  const name = decodeURIComponent(match[1]);
  const body = await readJsonBody(request);
  const expectedRevision = body?.expectedRevision;
  const roles = body?.roles;
  if (typeof expectedRevision !== "string" || !Array.isArray(roles)) {
    sendJson(
      response,
      {
        code: "autodev_control_api_invalid_body",
        message: "The fixture needs an expectedRevision and a roles array."
      },
      400
    );
    return true;
  }
  if (roles.some((role) => typeof role !== "string")) {
    sendJson(
      response,
      {
        code: "autodev_control_execution_contract_invalid",
        message: "The fixture only accepts role names."
      },
      400
    );
    return true;
  }
  const workspace = body?.workspace;
  if (workspace !== undefined && typeof workspace !== "string") {
    sendJson(
      response,
      {
        code: "autodev_control_execution_contract_invalid",
        message: "The fixture only accepts a workspace name."
      },
      400
    );
    return true;
  }
  const refusal = skillScopeRefusal(
    name,
    typeof workspace === "string" ? workspace : null
  );
  if (refusal !== null) {
    sendJson(
      response,
      {
        code: "autodev_control_execution_contract_invalid",
        message: refusal
      },
      400
    );
    return true;
  }
  if (expectedRevision !== skillAssignmentRevision) {
    sendJson(
      response,
      {
        code: "autodev_control_execution_contract_conflict",
        message:
          "The execution contract moved since this page was loaded; reload before writing."
      },
      409
    );
    return true;
  }
  skillRoles[name] = [...(roles as string[])];
  skillAssignmentRevision = nextSkillAssignmentRevision();
  const generation = `skill-assignment-${skillAssignmentRevision.slice(0, 8)}`;
  sendJson(response, {
    schema: "autodev-control-skill-assignment-v2",
    skill: name,
    desiredRoles: skillRoles[name],
    // The fixture has no runtime projection, so the roles the runtime
    // actually holds are not observed rather than empty.
    actualRoles: null,
    revision: skillAssignmentRevision,
    reconciliation: {
      status: {
        convergence: "pending",
        desiredGeneration: generation,
        observedGeneration: null,
        lastApplyAt: FIXTURE_APPLIED_AT,
        lastObservationAt: null,
        lastError: null,
        explanation:
          "The desired assignment was written; the runtime has not reported it back yet."
      },
      history: []
    },
    diff: {
      summary: `Assigned ${name} to ${skillRoles[name].join(", ") || "no role"}.`,
      identifier: generation
    }
  });
  return true;
}

/**
The agent enablement write.

The Runtime owns this state, so the write carries the revision the caller
read and is checked against it: a page holding a stale revision is a
conflict, not a silent overwrite of somebody else's change. A role with no
runtime projection has nothing to enable, so the write is refused there too
rather than inventing a value for it.
*/
async function handleAgentEnablementMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(AGENT_DETAIL_ROUTE);
  if (match === null || request.method !== "PATCH") return false;

  const role = decodeURIComponent(match[1]);
  const body = await readJsonBody(request);
  const enabled = body?.enabled;
  const expectedRevision = body?.expectedRevision;
  if (typeof enabled !== "boolean" || typeof expectedRevision !== "string") {
    sendJson(
      response,
      {
        code: "autodev_control_api_invalid_body",
        message: "The fixture needs an enabled boolean and an expectedRevision."
      },
      400
    );
    return true;
  }

  const state = agentEnablement[role];
  if (state === undefined) {
    sendJson(
      response,
      {
        code: "autodev_control_agent_not_found",
        message: "The fixture has no agent with that role."
      },
      404
    );
    return true;
  }
  if (!state.mutable) {
    sendJson(
      response,
      {
        code: "autodev_control_agent_enablement_not_mutable",
        message:
          "The fixture has no runtime enablement projection for that agent, so there is nothing to enable."
      },
      409
    );
    return true;
  }
  if (expectedRevision !== state.revision) {
    sendJson(
      response,
      {
        code: "autodev_control_agent_enablement_conflict",
        message:
          "The enablement changed after this page was read, so nothing was written."
      },
      409
    );
    return true;
  }

  const previous = state.enabled;
  state.enabled = enabled;
  state.revision = nextAgentEnablementRevision(state.revision);
  sendJson(response, {
    schema: "autodev-control-agent-enablement-v1",
    role,
    enabled,
    previous,
    revision: state.revision,
    actor: "fixture-operator",
    reconciliation: {
      status: {
        convergence: "pending",
        desiredGeneration: `agent-${role}`,
        observedGeneration: null,
        lastApplyAt: FIXTURE_APPLIED_AT,
        lastObservationAt: null,
        lastError: null,
        explanation:
          "The desired enablement was written; the runtime has not reported it back yet."
      },
      history: []
    }
  });
  return true;
}

/**
The fixture's own control over the agent enablement.

`/fixture/agents/state?state=revision-moved` moves the revision without this
Console knowing: the page that has the agent open holds the revision it was
rendered with, so moving it here is what makes the page's next write a
conflict rather than a silent overwrite of somebody else's change. The
`enabled` and `disabled` states put the enablement back where a test that
writes starts from.
*/
function configureAgentEnablementFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/fixture/agents/state") return false;
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  const state = url.searchParams.get("state");
  if (state === FIXTURE_STATE_ENABLED || state === FIXTURE_STATE_DISABLED) {
    agentEnablement.default.enabled = state === FIXTURE_STATE_ENABLED;
    agentEnablement.default.revision = INITIAL_AGENT_ENABLEMENT_REVISION;
  } else if (state === FIXTURE_STATE_REVISION_MOVED) {
    agentEnablement.default.revision = nextAgentEnablementRevision(
      agentEnablement.default.revision
    );
  } else {
    sendJson(
      response,
      {
        code: "autodev_fixture_unknown_state",
        message: "The fixture knows enabled, disabled and revision-moved."
      },
      400
    );
    return true;
  }
  sendJson(response, {
    state:
      state === FIXTURE_STATE_REVISION_MOVED
        ? FIXTURE_STATE_REVISION_MOVED
        : state,
    enabled: agentEnablement.default.enabled,
    revision: agentEnablement.default.revision
  });
  return true;
}

/**
One workspace's own configuration route.
*/
const WORKSPACE_CONFIGURATION_ROUTE =
  /^\/control\/workspaces\/([^/]+)\/([^/]+)$/u;

/**
The write to one workspace's canonical configuration.

The Runtime owns the catalog, so the fixture has to do what the Runtime
does: compare the revision the write was decided on against the revision it
holds, refuse a write that names a revision the catalog has moved past, and
answer a write that lands with the catalog's new revision.
*/
async function applyWorkspaceConfigWrite(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(WORKSPACE_CONFIGURATION_ROUTE);
  if (match === null || request.method !== "PATCH") return false;

  const workspaceId = `${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`;
  if (workspaceId !== workspaceConfig.id) {
    sendJson(
      response,
      {
        code: "autodev_control_workspace_unknown",
        message: `Workspace ${workspaceId} is not in the canonical catalog.`
      },
      404
    );
    return true;
  }

  const body = await readJsonBody(request);
  const expectedRevision = body?.expectedRevision;
  if (typeof expectedRevision !== "string") {
    sendJson(
      response,
      {
        code: "autodev_control_workspace_invalid_update",
        message: "The fixture needs an expectedRevision."
      },
      400
    );
    return true;
  }
  if (expectedRevision !== workspaceConfig.revision) {
    sendJson(
      response,
      {
        code: "autodev_control_workspace_revision_conflict",
        message:
          "The workspace catalog changed after it was read, so the write was not applied."
      },
      409
    );
    return true;
  }

  const before = JSON.stringify({
    baseBranch: workspaceConfig.baseBranch,
    enabled: workspaceConfig.enabled,
    agentRoles: workspaceConfig.agentRoles
  });
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      sendJson(
        response,
        {
          code: "autodev_control_workspace_invalid_update",
          message: "The fixture needs an enabled boolean."
        },
        400
      );
      return true;
    }
    workspaceConfig.enabled = body.enabled;
  }
  if ("baseBranch" in body) {
    if (typeof body.baseBranch !== "string" || body.baseBranch.trim() === "") {
      sendJson(
        response,
        {
          code: "autodev_control_workspace_invalid_update",
          message: "The fixture needs a base branch."
        },
        400
      );
      return true;
    }
    workspaceConfig.baseBranch = body.baseBranch.trim();
  }
  if ("agentRoles" in body) {
    if (
      body.agentRoles !== null &&
      (!Array.isArray(body.agentRoles) ||
        body.agentRoles.some((role: unknown) => typeof role !== "string"))
    ) {
      sendJson(
        response,
        {
          code: "autodev_control_workspace_invalid_update",
          message:
            "The fixture needs a role scope of null or a list of role names."
        },
        400
      );
      return true;
    }
    workspaceConfig.agentRoles = body.agentRoles as string[] | null;
  }
  const after = JSON.stringify({
    baseBranch: workspaceConfig.baseBranch,
    enabled: workspaceConfig.enabled,
    agentRoles: workspaceConfig.agentRoles
  });
  const isChanged = before !== after;
  if (isChanged) {
    workspaceConfig.revision = nextWorkspaceRevision(workspaceConfig.revision);
  }
  sendJson(response, {
    schema: "autodev-control-workspace-patch-v2",
    id: workspaceConfig.id,
    revision: workspaceConfig.revision,
    changed: isChanged,
    workspace: workspaceConfigRecord(),
    reconciliation: workspaceConfigReconciliation(),
    diff: {
      summary: isChanged
        ? "Canonical workspace configuration changed."
        : "Canonical workspace configuration unchanged; the catalog already held these values.",
      identifier: workspaceConfig.revision
    }
  });
  return true;
}

/**
The canonical permission policy, as the Runtime reports it.

The read and external source-change fixture share the same observed state.
*/
function permissionPolicyRecord(): {
  approvalPolicy: string;
  approvalsReviewer: string;
  webSearch: boolean;
} {
  return {
    approvalPolicy: permissionPolicy.approvalPolicy,
    approvalsReviewer: permissionPolicy.approvalsReviewer,
    webSearch: permissionPolicy.webSearch
  };
}

/**
The fixture's own control over the canonical permission policy.

`/fixture/permissions/state?state=revision-moved` moves the revision
without this Console knowing: the page that has the permissions open holds
the revision it was rendered with, so moving it here is what makes the
page's next write a conflict rather than a silent overwrite of somebody
else's change. The `reset` state puts the policy back where a test that
writes starts.
*/
function configurePermissionPolicyFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/fixture/permissions/state") return false;
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  const state = url.searchParams.get("state");
  if (state === "reset") {
    permissionPolicy.approvalPolicy = "on-request";
    permissionPolicy.approvalsReviewer = "operator";
    permissionPolicy.webSearch = false;
    permissionPolicy.revision = INITIAL_PERMISSION_POLICY_REVISION;
  } else if (state === FIXTURE_STATE_REVISION_MOVED) {
    permissionPolicy.revision = nextRevision(permissionPolicy.revision);
  } else {
    sendJson(
      response,
      {
        code: "autodev_fixture_unknown_state",
        message: "The fixture knows reset and revision-moved."
      },
      400
    );
    return true;
  }
  sendJson(response, {
    state,
    policy: permissionPolicyRecord(),
    revision: permissionPolicy.revision
  });
  return true;
}

/**
The fixture's own control over the canonical workspace configuration.

`/fixture/workspaces/state?state=revision-moved` moves the revision without
this Console knowing: the page that has the workspace open holds the
revision it was rendered with, so moving it here is what makes the page's
next write a conflict rather than a silent overwrite of somebody else's
change. The `enabled` and `disabled` states put the configuration back
where a test that writes starts.
*/
function configureWorkspaceFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/fixture/workspaces/state") return false;
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  const state = url.searchParams.get("state");
  if (state === FIXTURE_STATE_ENABLED || state === FIXTURE_STATE_DISABLED) {
    workspaceConfig.enabled = state === FIXTURE_STATE_ENABLED;
    workspaceConfig.baseBranch = "main";
    workspaceConfig.agentRoles = null;
    workspaceConfig.revision = INITIAL_WORKSPACE_REVISION;
  } else if (state === FIXTURE_STATE_REVISION_MOVED) {
    workspaceConfig.revision = nextWorkspaceRevision(workspaceConfig.revision);
  } else {
    sendJson(
      response,
      {
        code: "autodev_fixture_unknown_state",
        message: "The fixture knows enabled, disabled and revision-moved."
      },
      400
    );
    return true;
  }
  sendJson(response, {
    state:
      state === FIXTURE_STATE_REVISION_MOVED
        ? FIXTURE_STATE_REVISION_MOVED
        : state,
    enabled: workspaceConfig.enabled,
    baseBranch: workspaceConfig.baseBranch,
    agentRoles: workspaceConfig.agentRoles,
    revision: workspaceConfig.revision
  });
  return true;
}

/**
The fixture's own control over the skill assignment.

`/fixture/skills/revision` moves the canonical roles without this Console
knowing: the page that has the skills open holds the revision it was
rendered with, so bumping the revision here is what makes its next write a
conflict rather than a silent overwrite of somebody else's assignment.
`/fixture/skills/reset` puts the assignment back, so a test that writes
starts from the catalog the fixture declares.
*/
function configureSkillFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (
    url.pathname !== "/fixture/skills/revision" &&
    url.pathname !== "/fixture/skills/reset"
  ) {
    return false;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  if (url.pathname === "/fixture/skills/reset") {
    skillAssignmentRevision = INITIAL_SKILL_ASSIGNMENT_REVISION;
    skillRoles["code-review"] = [...INITIAL_SKILL_ROLES];
    sendJson(response, { revision: skillAssignmentRevision });
    return true;
  }
  skillAssignmentRevision = nextSkillAssignmentRevision();
  sendJson(response, { revision: skillAssignmentRevision });
  return true;
}

/**
Moves the canonical hook declaration without the Console knowing.

The page that has the declaration open holds the revision it was rendered
with, so moving the declaration here is what makes its next write a
conflict rather than a silent overwrite of somebody else's edit.

`/fixture/hooks/reset` puts it back the way the fixture declares it, so one
spec's write is not the next spec's starting state.
*/
function configureHookFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (
    url.pathname !== "/fixture/hooks/move" &&
    url.pathname !== "/fixture/hooks/reset"
  ) {
    return false;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  if (url.pathname === "/fixture/hooks/reset") {
    hookDeclaration = initialHookDeclaration();
    sendJson(response, { revision: hookDeclaration.revision });
    return true;
  }
  // The declaration moves under an open editor, so the write the editor
  // carries is decided on a revision that is no longer the declaration's.
  hookDeclaration = {
    ...hookDeclaration,
    revision: createHash("sha256")
      .update(`${hookDeclaration.revision}:moved`, "utf8")
      .digest("hex")
  };
  sendJson(response, { revision: hookDeclaration.revision });
  return true;
}

/**
Moves the canonical MCP declaration without the Console knowing.

The page that has the declaration open holds the revision it was rendered
with, so moving the declaration here is what makes its next write a conflict
rather than a silent overwrite of somebody else's edit.

`/fixture/mcp/reset` puts it back the way the fixture declares it, so one
spec's write is not the next spec's starting state.
*/
function configureMcpFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (
    url.pathname !== "/fixture/mcp/move" &&
    url.pathname !== "/fixture/mcp/reset"
  ) {
    return false;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  if (url.pathname === "/fixture/mcp/reset") {
    mcpDeclaration = initialMcpDeclaration();
    sendJson(response, { revision: mcpDeclaration.revision });
    return true;
  }
  const declaredServers = mcpDeclaration.declaredServers.map((entry) =>
    entry.name === MCP_MOVED_SERVER
      ? { ...entry, url: `https://moved.example.test/${entry.name}` }
      : entry
  );
  const revision = createHash("sha256")
    .update(`${mcpDeclaration.revision}:moved`, "utf8")
    .digest("hex");
  const desiredGeneration = mcpGeneration(declaredServers);
  mcpDeclaration = {
    revision,
    declaredServers,
    appliedServers: declaredServers,
    desiredGeneration,
    observedGeneration: desiredGeneration,
    converged: true
  };
  sendJson(response, { revision });
  return true;
}

/**
The Runtime's live projection, as this fixture reports it.

`liveAgents` is null on purpose. The Runtime registered no live-agent
activity source, so the Agents list keeps saying that a per-agent live
count is not observed instead of inventing a zero for it. The router's own
counters are a separate source and are reported, and they are what the
Usage Active Sessions scope reads.
*/
const RUNTIME_ACTIVE_SESSIONS = 3;
const RUNTIME_ACTIVE_SUBAGENT_THREADS = 2;
const RUNTIME_IN_FLIGHT_REQUESTS = 4;

/**
Whether the Runtime answers at all.

A live scope that can only ever be read successfully cannot show what a
failed read looks like, and the difference between "the Runtime is idle" and
"the Runtime was never observed" is the whole point of the scope.
*/
let isRuntimeUnavailable = false;

/**
Whether the GitHub Actions runtime state can be read.

The workflow definitions are parsed from the repository's YAML and the
runtime state comes from the GitHub Actions API, so the two can be read
apart. The page has to keep them apart too: a page that can only render
observed runtime facts cannot show that it refuses to invent them.
*/
let isGithubRuntimeUnavailable = false;

/**
The workflow definitions the repository declares.

The rows carry the states the page has to tell apart: a workflow that is
active in GitHub and one that was disabled by hand, one whose runtime state
was never loaded, one that declares no trigger event and one that declares
no schedule.
*/
function githubWorkflows(): readonly Record<string, unknown>[] {
  return [
    {
      id: "_scheduler.yml",
      name: "Scheduler",
      path: ".github/workflows/_scheduler.yml",
      events: ["push", "schedule", "workflow_dispatch"],
      schedules: ["0 3 * * *"],
      actionsState: "active",
      actionsWorkflowId: 101,
      actionsHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/101",
      recentRunsCount: 12,
      lastRunStatus: "completed",
      lastRunConclusion: "success",
      lastRunCreatedAt: "2026-02-11T03:00:12.000Z",
      lastRunHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/runs/9001"
    },
    {
      id: "ci.yml",
      name: "CI",
      path: ".github/workflows/ci.yml",
      events: ["pull_request", "push"],
      schedules: [],
      actionsState: "disabled_manually",
      actionsWorkflowId: 102,
      actionsHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/102",
      recentRunsCount: 7,
      lastRunStatus: "completed",
      lastRunConclusion: "failure",
      lastRunCreatedAt: "2026-02-10T21:14:40.000Z",
      lastRunHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/runs/9003"
    },
    {
      id: "release.yml",
      name: "Release",
      path: ".github/workflows/release.yml",
      events: ["release"],
      schedules: ["0 0 1 * *"],
      // The definition was read; this workflow's runtime state was not.
      actionsState: "unavailable",
      actionsWorkflowId: null,
      actionsHtmlUrl: null,
      recentRunsCount: null,
      lastRunStatus: null,
      lastRunConclusion: null,
      lastRunCreatedAt: null,
      lastRunHtmlUrl: null
    },
    {
      id: "nightly.yml",
      name: null,
      path: ".github/workflows/nightly.yml",
      events: [],
      schedules: [],
      actionsState: "active",
      actionsWorkflowId: 104,
      actionsHtmlUrl:
        "https://github.com/SimulatorLife/AutoDev/actions/workflows/104",
      recentRunsCount: 0,
      lastRunStatus: null,
      lastRunConclusion: null,
      lastRunCreatedAt: null,
      lastRunHtmlUrl: null
    }
  ];
}

/**
The bounded recent-run sample the Actions API returned.
*/
function githubRecentRuns(): readonly Record<string, unknown>[] {
  return [
    {
      id: 9001,
      name: "Scheduler",
      workflowId: 101,
      workflowPath: ".github/workflows/_scheduler.yml",
      headBranch: "main",
      headSha: "9f2c41ab7d5e6083",
      event: "schedule",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/SimulatorLife/AutoDev/actions/runs/9001",
      createdAt: "2026-02-11T03:00:12.000Z",
      updatedAt: "2026-02-11T03:04:55.000Z",
      runAttempt: 1
    },
    {
      id: 9002,
      name: "CI",
      workflowId: 102,
      workflowPath: ".github/workflows/ci.yml",
      headBranch: "feature/breadcrumbs",
      headSha: "1c77e0d9a2b4f631",
      event: "pull_request",
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://github.com/SimulatorLife/AutoDev/actions/runs/9002",
      createdAt: "2026-02-11T09:41:03.000Z",
      updatedAt: "2026-02-11T09:41:03.000Z",
      runAttempt: 1
    },
    {
      id: 9003,
      name: "CI",
      workflowId: 102,
      workflowPath: ".github/workflows/ci.yml",
      headBranch: "main",
      headSha: "3ab90cd117f2e845",
      event: "push",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.com/SimulatorLife/AutoDev/actions/runs/9003",
      createdAt: "2026-02-10T21:14:40.000Z",
      updatedAt: "2026-02-10T21:19:02.000Z",
      runAttempt: 1
    },
    {
      id: 9004,
      name: "Release",
      workflowId: 103,
      workflowPath: ".github/workflows/release.yml",
      headBranch: "main",
      headSha: "77de0194bb31a2c6",
      event: "release",
      status: "completed",
      conclusion: "cancelled",
      htmlUrl: "https://github.com/SimulatorLife/AutoDev/actions/runs/9004",
      createdAt: "2026-02-09T12:00:00.000Z",
      updatedAt: "2026-02-09T12:02:11.000Z",
      runAttempt: 1
    }
  ];
}

/**
The GitHub workflow catalog and the observed Actions runtime state.

The read is read-only in the product as well as here: dispatch, cancel,
rerun and schedule controls are unimplemented, so the fixture answers no
mutation of its own.
*/
function handleGithubRead(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/fixture/github/state") {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return true;
    }
    isGithubRuntimeUnavailable =
      url.searchParams.get("state") === "unavailable";
    sendJson(response, {
      state: isGithubRuntimeUnavailable ? "unavailable" : "observed"
    });
    return true;
  }
  if (url.pathname !== "/control/github") return false;
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return true;
  }
  const workflows = githubWorkflows();
  sendJson(response, {
    schema: "autodev-control-github-v1",
    source: ".github/workflows",
    readOnly: true,
    catalogStatus: "valid",
    totalWorkflows: workflows.length,
    workflows,
    runtimeFactsAvailable: !isGithubRuntimeUnavailable,
    runtimeStatus: isGithubRuntimeUnavailable ? "unavailable" : "available",
    runtimeMessage: isGithubRuntimeUnavailable
      ? "The GitHub Actions API could not be reached for the configured repository."
      : null,
    repository: "SimulatorLife/AutoDev",
    stats: isGithubRuntimeUnavailable
      ? null
      : {
          totalRuns: 30,
          successfulRuns: 21,
          failedRuns: 5,
          inProgressRuns: 2,
          cancelledRuns: 2,
          successRate: 0.7
        },
    recentRuns: isGithubRuntimeUnavailable ? null : githubRecentRuns()
  });
  return true;
}

/**
The Runtime's read-only live projection, and the fixture's control over it.

`/fixture/runtime/state` takes the Runtime away, so a page that reads it
has to say that the read failed rather than showing an idle Runtime.
*/
let mcpRuntimeState: "ready" | "stale" = "ready";

function handleRuntimeFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/fixture/mcp-runtime/state") {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return true;
    }
    mcpRuntimeState =
      url.searchParams.get("state") === "stale" ? "stale" : "ready";
    sendJson(response, { state: mcpRuntimeState });
    return true;
  }
  if (url.pathname === "/fixture/runtime/state") {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return true;
    }
    isRuntimeUnavailable = url.searchParams.get("state") === "unavailable";
    sendJson(response, {
      state: isRuntimeUnavailable ? "unavailable" : "observed"
    });
    return true;
  }
  if (url.pathname !== "/control/runtime") return false;
  if (isRuntimeUnavailable) {
    response.writeHead(503).end();
    return true;
  }
  sendJson(response, {
    schema: "autodev-control-runtime-v3",
    routerInstanceId: "fixture-router",
    lifecycle: {
      state: "ready",
      draining: false,
      changedAt: FIXTURE_APPLIED_AT,
      activeResponseRequests: 1
    },
    concurrency: {
      scope: "fixture",
      configSource: "config_file",
      configFileSource: "default_codex_home",
      configFileExists: true,
      maxConcurrentThreadsPerSession: 4,
      effectivePerSessionLimit: 4,
      activeSubagentThreads: RUNTIME_ACTIVE_SUBAGENT_THREADS,
      activeSessions: RUNTIME_ACTIVE_SESSIONS
    },
    inFlightRequestCount: RUNTIME_IN_FLIGHT_REQUESTS,
    liveSessions: null,
    liveAgents: null
  });
  return true;
}

/**
The evaluation results the fixture holds.

The rows keep the states the Evaluations view has to tell apart: a run
that passed, a run that failed and a run whose verdict was never observed;
a run that reported a prompt and one that did not; a run whose trace the
Usage fixture can open and one whose trace was never retained.
*/
const EVALUATION_ROLES = ["orchestrator", "browser-tester"] as const;
const EVALUATION_MODELS = ["claude-sonnet-5", "gpt-6-meridian"] as const;
const EVALUATION_PROMPTS = ["release-notes", "review"] as const;
/**
The rows one read carries.
*/
const EVALUATION_WINDOW = 60;
/**
The results the store holds behind that window.
*/
const EVALUATION_STORE = 120;
/**
The instant the fixture's newest run was recorded.
*/
const EVALUATION_NEWEST_AT = "2026-02-11T09:30:00.000Z";
/**
The span id the Usage fixture never retained.
*/
const EVALUATION_UNOBSERVED_SPAN_ID = "ffffffffffffffff";

/**
One of the fixture's axes, chosen by the row's place in the window.
*/
function evaluationAxis<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error("the fixture's evaluation axes are empty");
  }
  return value;
}

/**
A span id the Usage fixture answers with a trace.
*/
function evaluationSpanId(index: number): string {
  return `a1a1a1a1${index.toString(16).padStart(8, "0")}`;
}

/**
One evaluation result.

The row carries the states the Evaluations view has to tell apart: a run
that passed, a run that failed and a run whose verdict was never observed;
a run that reported a prompt and one that did not; a run whose trace the
Usage fixture can open and one whose trace was never retained.
*/
function evaluationRow(index: number): Record<string, unknown> {
  const verdict = index % 3;
  const passed = verdict === 0 ? true : verdict === 1 ? false : null;
  const spanId =
    index % 4 === 0
      ? evaluationSpanId(index)
      : index % 7 === 3
        ? EVALUATION_UNOBSERVED_SPAN_ID
        : undefined;
  const row: Record<string, unknown> = {
    id: `eval-${String(index + 1).padStart(4, "0")}`,
    agentRole: evaluationAxis(EVALUATION_ROLES, index),
    model: evaluationAxis(EVALUATION_MODELS, Math.floor(index / 2)),
    metrics: [
      {
        name: index % 2 === 0 ? "tool_failures" : "latency_ms",
        value: index % 2 === 0 ? index % 4 : 120 + index,
        threshold: index % 2 === 0 ? 0 : 500,
        pass: passed
      }
    ],
    passed,
    timestamp: new Date(
      Date.parse(EVALUATION_NEWEST_AT) - index * 60_000
    ).toISOString()
  };
  // One run in five never reported a prompt, so the row that says so is
  // present rather than implied.
  if (index % 5 !== 4) {
    row.promptName = evaluationAxis(EVALUATION_PROMPTS, index);
  }
  if (spanId !== undefined) {
    row.spanId = spanId;
  }
  return row;
}

/**
The retained evaluation results, most recent first.

The window is bounded and the store behind it is larger, because the two
numbers are different facts: one is what the read carried, the other is
what the store holds.
*/
function evaluationRows(): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < EVALUATION_WINDOW; index += 1) {
    rows.push(evaluationRow(index));
  }
  return rows;
}

/**
The retained evaluation results.

The envelope says the read is a bounded window over a larger store, so the
page has to render the store's size and the window's size as the different
facts they are.
*/
function handleEvaluationsRead(url: URL, response: ServerResponse): boolean {
  if (url.pathname !== "/control/evaluations") return false;
  const rows = evaluationRows();
  sendJson(response, {
    schema: "autodev-control-evaluations-v1",
    source: "fixture",
    readOnly: true,
    totalEvaluations: EVALUATION_STORE,
    truncated: EVALUATION_STORE > rows.length,
    evaluations: rows
  });
  return true;
}

/**
The hook reads the Configure group publishes.

The declaration and the projection the Runtime published are two different
questions, so they are two different reads. The fixture publishes both from
the contract's own types, so a published event cannot carry a field the
Runtime would not send it.
*/
function handleHookCatalogRead(url: URL, response: ServerResponse): boolean {
  if (url.pathname === "/control/hooks") {
    const body: ControlApiHooksResponse = {
      schema: "autodev-control-hooks-v2",
      source: ".rulesync/hooks.jsonc",
      readOnly: true,
      valid: true,
      issues: [],
      revision: hookDeclaration.revision,
      sourceText: FIXTURE_HOOK_SOURCE,
      target: "codexcli",
      events: hookDeclaration.events
    };
    sendJson(response, body);
    return true;
  }
  if (url.pathname === "/control/hooks-applied") {
    // The hook configuration the Runtime published, against the canonical
    // declaration. The published side carries an older command, so the page
    // can tell a declared hook from one the Runtime has caught up with -- and
    // the verdict is the Runtime's own.
    //
    // The response is the contract's own type, so the published side cannot
    // carry a declaration origin: the projection the Runtime published has no
    // declaration site, and a fixture that gave it one would teach the
    // Console to expect a field the Runtime never sends.
    const body: ControlApiHooksAppliedResponse = {
      schema: "autodev-control-hooks-applied-v1",
      source: "/codex/hooks.json",
      declarationSource: ".rulesync/hooks.jsonc",
      target: "codexcli",
      available: true,
      declaredEvents: hookDeclaration.events,
      events: hookDeclaration.appliedEvents,
      reconciliation: hookReconciliation()
    };
    sendJson(response, body);
    return true;
  }
  // The hook paths are the ones this read owns; anything else belongs to a
  // different read, and saying so is how the caller knows to keep looking.
  return false;
}

/**
The catalog resources the Console reads: the MCP catalog and the Configure
group's agents, skills, hooks, prompts and permissions.

Each response carries the states the Console has to keep apart -- a
declared server and one that exists only in a target projection, an
enabled assignment and one the Runtime could not report, a measured count
and an unobserved one -- so the pages are exercised against the states
rather than against a single happy row.
*/
function handleCatalogResourceRead(
  url: URL,
  response: ServerResponse
): boolean {
  if (url.pathname === "/control/contracts") {
    sendJson(response, {
      schema: "autodev-control-api-contract-v1",
      version: CONTROL_API_CONTRACT.version
    });
    return true;
  }
  if (url.pathname === "/control/mcps") {
    // Three servers that keep the three states apart: a declared and enabled
    // stdio server with a target override, a server that is only present in a
    // target projection (so its default state is not observed), and a
    // declared http server with no target overrides at all.
    sendJson(response, {
      schema: "autodev-control-mcps-v3",
      source: ".rulesync/mcp.jsonc",
      gateway: {
        label: "com.codex.autodev-mcp-gateway",
        installed: true,
        ready: true,
        port: 3312,
        readinessUrl: "http://127.0.0.1:3312/readyz",
        generation: "generation-1",
        workspace: "/workspace",
        role: "orchestrator",
        roles: ["orchestrator"],
        surfaces: [
          {
            role: "orchestrator",
            url: "http://127.0.0.1:3312/orchestrator/mcp"
          }
        ],
        reviewed: { lsp: ["lsp_hover"] },
        grants: { lsp: ["lsp_hover"] },
        error: null
      },
      revision: mcpDeclaration.revision,
      readOnly: false,
      valid: true,
      issues: [],
      servers: [
        {
          name: "lsp",
          enabled: true,
          transport: "stdio",
          targetOverrides: [
            {
              target: "codex",
              enabled: true,
              defaultToolsApprovalMode: "never",
              enabledTools: ["lsp_goto_definition"]
            }
          ],
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-lsp"],
          envKeys: ["LSP_ROOT"],
          cwd: "/workspace",
          defaultToolsApprovalMode: "on-request",
          declared: true,
          roles: ["worker", "orchestrator"]
        },
        {
          name: "antigravity-cli",
          enabled: false,
          transport: "stdio",
          targetOverrides: [{ target: "codex", enabled: false }],
          command: "antigravity",
          args: ["mcp"],
          declared: false,
          roles: []
        },
        {
          name: "openaiDeveloperDocs",
          enabled: null,
          transport: "http",
          targetOverrides: [],
          url: "https://docs.example.test/mcp",
          declared: true,
          roles: ["orchestrator"]
        }
      ]
    });
    return true;
  }
  if (url.pathname === "/control/mcp-applied") {
    // The MCP configuration the Runtime published, against the canonical
    // declaration. The docs server is in the applied configuration and the
    // other two are not, so the page can tell an applied server from one that
    // was never applied -- and the verdict is the Runtime's own.
    sendJson(response, {
      schema: "autodev-control-mcp-applied-v3",
      source: "/codex/provider-runtime/mcp-servers.json",
      declarationSource: ".rulesync/mcp.jsonc",
      target: "codexcli",
      available: true,
      declaredServers: mcpDeclaration.declaredServers,
      servers: mcpDeclaration.appliedServers,
      reconciliation: {
        status: {
          convergence: mcpDeclaration.converged ? "converged" : "pending",
          desiredGeneration: mcpDeclaration.desiredGeneration,
          observedGeneration: mcpDeclaration.observedGeneration,
          lastApplyAt: null,
          lastObservationAt: MCP_OBSERVED_AT,
          lastError: null,
          explanation: mcpDeclaration.converged
            ? FIXTURE_CONVERGED_EXPLANATION
            : "Apply wrote the latest desired generation, but the running runtime has not observed it yet. Restart the affected process or wait for the observation hook to refresh."
        },
        history: []
      }
    });
    return true;
  }
  if (url.pathname === "/control/mcp-runtime") {
    // The Runtime's observation of the MCP servers it has seen. It is a
    // separate read from the catalog, and it carries only the servers the
    // Runtime actually reached -- the catalog's other two servers have never
    // been seen, and the page has to say so rather than borrow this verdict.
    const isStale = mcpRuntimeState === "stale";
    sendJson(response, {
      schema: "autodev-control-mcp-runtime-v1",
      source: "mcp-gateway",
      observedServers: 1,
      health: {
        ready: isStale ? 0 : 1,
        error: 0,
        stale: isStale ? 1 : 0,
        configured: 0,
        observed: 0
      },
      servers: [
        {
          name: "openaiDeveloperDocs",
          health: mcpRuntimeState,
          lastSeenAt: "2026-10-22T12:00:00.000Z",
          lastStatus: isStale ? "ok" : "ready",
          initAttempts: 2,
          toolDiscoveryAttempts: 1,
          failures: 0,
          toolCalls: 6,
          averageDurationMs: 128,
          roles: [
            {
              role: "orchestrator",
              health: mcpRuntimeState,
              lastSeenAt: "2026-10-22T12:00:00.000Z",
              lastStatus: isStale ? "ok" : "ready"
            }
          ],
          tools: [{ name: "search_docs", count: 6, errors: 0 }]
        }
      ]
    });
    return true;
  }
  if (url.pathname === "/control/agents") {
    // Two agents: one whose enablement the Runtime reported and one whose
    // enablement it could not report. The second is the state the Console
    // has to keep distinct from "disabled".
    sendJson(response, {
      schema: "autodev-control-agents-v2",
      source: ".rulesync/agents.jsonc",
      readOnly: false,
      executionContractObserved: true,
      totalAgents: 2,
      agents: [
        {
          id: "default",
          role: "default",
          kind: "orchestrator",
          readOnly: false,
          configured: true,
          valid: true,
          status: "configured",
          convergence: "converged",
          enablement: agentEnablementFor("default"),
          primaryModel: "claude",
          allowedProviders: ["claude"],
          mcps: ["lsp"],
          skills: [],
          hasPrompt: true
        },
        {
          id: "worker",
          role: "worker",
          kind: LEAF_AGENT_KIND,
          readOnly: false,
          configured: true,
          valid: true,
          status: "unavailable",
          convergence: NOT_OBSERVED_CONVERGENCE,
          enablement: agentEnablementFor("worker"),
          primaryModel: "claude",
          allowedProviders: ["claude"],
          mcps: [],
          skills: [],
          hasPrompt: false
        }
      ]
    });
    return true;
  }
  if (url.pathname === "/control/skills") {
    sendJson(response, {
      schema: "autodev-control-skills-v2",
      source: ".rulesync/skills",
      readOnly: true,
      executionContractObserved: true,
      valid: true,
      issues: [],
      executionContractRevision: skillAssignmentRevision,
      assignmentRoles: ["default", "worker"],
      // The Runtime has observed no skill telemetry at all, so the page has to
      // say "not observed" rather than "zero".
      telemetryObserved: false,
      skills: [
        {
          name: "code-review",
          description: "Review a diff for defects.",
          path: ".rulesync/skills/code-review/SKILL.md",
          roles: skillRoles["code-review"] ?? [],
          // The fixture's catalogue is a repository's own `.rulesync/skills`
          // directory, so the skill is installed in that repository and
          // belongs to the workspace that repository is. The scope facts are
          // part of the contract: a catalogue that left them out reads as a
          // skill installed nowhere, and the page says so.
          scope: "repo",
          scopeLocation: `/tmp/${WORKSPACE_ID}/.rulesync/skills/code-review`,
          workspace: WORKSPACE_ID,
          // Nothing has been observed for this skill, and that is not the
          // same as observing that it was never exposed or used.
          observedExposure: null,
          observedUse: null,
          observedError: null
        },
        {
          name: "release-notes",
          description: "Draft the release notes for a version.",
          path: ".rulesync/skills/release-notes/SKILL.md",
          // The second kind of catalogue entry: defined in the catalogue, and
          // installed nowhere on this machine, so no agent role can invoke
          // it. It is the state an operator is most likely to be confused by,
          // and a fixture that holds only installed skills never shows it.
          roles: [],
          scope: null,
          scopeLocation: null,
          workspace: null,
          observedExposure: null,
          observedUse: null,
          observedError: null
        }
      ],
      unresolvedAssignments: []
    });
    return true;
  }
  if (handleHookCatalogRead(url, response)) return true;
  if (url.pathname === "/control/prompts") {
    sendJson(response, {
      schema: "autodev-control-prompts-v2",
      source: ".rulesync/prompts",
      readOnly: true,
      valid: true,
      issues: [],
      totalCommands: 1,
      commands: [
        {
          name: "review",
          path: ".rulesync/prompts/review.md",
          description: "Review the pending diff."
        }
      ],
      rolePrompts: [{ role: "default", path: ".rulesync/prompts/default.md" }]
    });
    return true;
  }
  if (url.pathname === "/control/permissions") {
    sendJson(response, {
      schema: "autodev-control-permissions-v2",
      source: ".rulesync/permissions.jsonc",
      readOnly: true,
      executionContractObserved: true,
      revision: permissionPolicy.revision,
      sourceText: FIXTURE_PERMISSION_SOURCE,
      policyStatus: "valid",
      policyReason: null,
      applied: null,
      appliedSource: "/fixture/codex/config.toml",
      policy: {
        approvalPolicy: permissionPolicy.approvalPolicy,
        webSearch: permissionPolicy.webSearch,
        approvalsReviewer: permissionPolicy.approvalsReviewer
      },
      rolePermissions: {
        default: {
          readOnly: false,
          mcp: ["lsp"],
          skills: ["code-review"],
          mcpTools: { lsp: ["lsp_goto_definition"] }
        },
        worker: {
          readOnly: true,
          mcp: [],
          skills: ["code-review"],
          mcpTools: {}
        },
        orchestrator: {
          readOnly: false,
          mcp: [],
          skills: [],
          mcpTools: {}
        }
      }
    });
    return true;
  }
  const agentDetail = url.pathname.match(AGENT_DETAIL_ROUTE);
  if (agentDetail !== null) {
    sendJson(response, {
      schema: "autodev-control-agent-detail-v3",
      id: decodeURIComponent(agentDetail[1]),
      role: decodeURIComponent(agentDetail[1]),
      kind: "orchestrator",
      readOnly: false,
      configured: true,
      valid: true,
      status: "configured",
      convergence: "converged",
      enablement: agentEnablementFor(decodeURIComponent(agentDetail[1])),
      primaryModel: "claude",
      allowedProviders: ["claude"],
      mcps: ["lsp"],
      skills: [],
      hasPrompt: true,
      promptPath: "agents/prompts/default.md",
      systemPrompt: "You are the AutoDev orchestrator.",
      reconciliation: {
        status: {
          convergence: "converged",
          desiredGeneration: "agent-default",
          observedGeneration: "agent-default",
          lastApplyAt: FIXTURE_APPLIED_AT,
          lastObservationAt: FIXTURE_APPLIED_AT,
          lastError: null,
          explanation: "The agent matches the canonical source."
        },
        history: []
      }
    });
    return true;
  }
  const skillContent = url.pathname.match(SKILL_CONTENT_ROUTE);
  if (skillContent !== null) {
    const name = decodeURIComponent(skillContent[1] ?? "");
    const source = canonicalSource("skill", name);
    if (source === null) {
      sendJson(
        response,
        {
          error: {
            message: `The skill "${name}" does not exist.`,
            type: "autodev_control_api_error",
            code: "autodev_control_skill_not_found"
          }
        },
        404
      );
      return true;
    }
    sendJson(response, {
      schema: "autodev-control-skill-content-v2",
      name: source.name,
      path: source.path,
      content: source.content,
      revision: source.revision,
      // The skill reaches the runtime as a link to this very source, so the
      // observed generation is the canonical revision whenever the link holds
      // it. The Console renders this view rather than deriving its own, so the
      // skill page cannot drift from the shared reconciliation contract.
      reconciliation: {
        status: {
          convergence: "converged",
          desiredGeneration: source.revision,
          observedGeneration: source.revision,
          lastApplyAt: FIXTURE_APPLIED_AT,
          lastObservationAt: FIXTURE_APPLIED_AT,
          lastError: null,
          explanation: FIXTURE_CONVERGED_EXPLANATION
        },
        history: []
      }
    });
    return true;
  }
  const promptDetail = url.pathname.match(PROMPT_DETAIL_ROUTE);
  if (promptDetail !== null) {
    const name = decodeURIComponent(promptDetail[1] ?? "");
    const source = canonicalSource("prompt", name);
    if (source === null) {
      sendJson(
        response,
        {
          error: {
            message: `The command "${name}" does not exist.`,
            type: "autodev_control_api_error",
            code: "autodev_control_api_unknown_path"
          }
        },
        404
      );
      return true;
    }
    sendJson(response, {
      schema: "autodev-control-prompt-detail-v4",
      name: source.name,
      type: "command",
      source: source.path,
      content: source.content,
      preview: source.preview ?? source.content,
      revision: source.revision,
      diff: {
        summary: "The canonical command source.",
        identifier: `prompt-${source.name}-1`
      },
      reconciliation: {
        status: {
          convergence: "converged",
          desiredGeneration: `prompt-${source.name}-1`,
          observedGeneration: `prompt-${source.name}-1`,
          lastApplyAt: FIXTURE_APPLIED_AT,
          lastObservationAt: FIXTURE_APPLIED_AT,
          lastError: null,
          explanation: "The command matches the canonical source."
        },
        history: []
      }
    });
    return true;
  }
  return false;
}

/**
The fixture's own control over the canonical source.

`/fixture/canonical-source/move` changes a canonical source without this
Console knowing: the page that has the source open holds the revision it
was rendered with, so moving the source here is what makes its next write a
conflict rather than a silent overwrite of somebody else's edit.
`/fixture/canonical-source/reset` puts the sources back, so a test starts
from the sources the fixture declares.
*/
function configureCanonicalSourceFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (!url.pathname.startsWith("/fixture/canonical-source/")) return false;
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  const action = url.pathname.slice("/fixture/canonical-source/".length);
  if (action === "reset") {
    resetCanonicalSources();
    sendJson(response, { reset: true });
    return true;
  }
  const kind = url.searchParams.get("kind");
  if (kind !== "prompt" && kind !== "skill") {
    sendJson(response, { error: "A canonical source kind is required." }, 400);
    return true;
  }
  if (action !== "move") {
    response.writeHead(404).end();
    return true;
  }
  const name = url.searchParams.get("name") ?? "";
  const moved = moveCanonicalSource(kind, name);
  if (moved === null) {
    sendJson(response, { error: `No canonical ${kind} named "${name}".` }, 404);
    return true;
  }
  sendJson(response, { kind, revision: moved.revision });
  return true;
}

/**
The fixture's own control routes and the catalog resources it answers.

One dispatch from the request handler rather than two, so the handler
stays within the complexity budget it was written to.
*/
function handleFixtureCatalogRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (
    configureSkillFixture(request, response, url) ||
    configureMcpFixture(request, response, url) ||
    configureHookFixture(request, response, url) ||
    configureWorkspaceFixture(request, response, url) ||
    configurePermissionPolicyFixture(request, response, url) ||
    configureCanonicalSourceFixture(request, response, url) ||
    handleRuntimeFixture(request, response, url) ||
    handleGithubRead(request, response, url) ||
    handleEvaluationsRead(url, response)
  )
    return true;
  return handleCatalogResourceRead(url, response);
}

/**
The role a provider assignment is for, as the Console writes it.
*/
const PROVIDER_ROLE_ROUTE =
  /^\/control\/providers\/([^/]+)\/roles\/(orchestrator|subagent)$/u;
const PROVIDER_AGENT_MODEL_ROUTE =
  /^\/control\/providers\/([^/]+)\/agents\/([a-z0-9-]+)$/u;
/**
The agent roles each fixture provider lists under its Subagent model.
*/
const FIXTURE_AGENT_ROLES = [
  { role: "explorer", tier: "default" },
  { role: "worker", tier: "default" },
  { role: "smart", tier: "smart" }
] as const;
/**
Agent-role model writes the fixture has accepted, by `provider:role`.
*/
const agentModelWrites = new Map<string, string>();

function fixtureAgentModels(provider: string, tierModel: string | null) {
  return FIXTURE_AGENT_ROLES.map(({ role, tier }) => ({
    role,
    tier,
    model: agentModelWrites.get(`${provider}:${role}`) ?? null,
    tierModel
  }));
}

async function handleAgentModelMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(PROVIDER_AGENT_MODEL_ROUTE);
  if (match === null || request.method !== "PATCH") return false;
  const provider = decodeURIComponent(match[1] ?? "");
  const role = match[2] ?? "";
  const body = await readJsonBody(request);
  const model = body?.model;
  if (model !== null && typeof model !== "string") {
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_api_bad_body",
          message: "The fixture needs a model or null.",
          type: "invalid_request_error"
        }
      },
      400
    );
    return true;
  }
  if (model === null) agentModelWrites.delete(`${provider}:${role}`);
  else agentModelWrites.set(`${provider}:${role}`, model);
  sendJson(response, { provider, role, model, previous: null });
  return true;
}
type FixtureProviderRole = "orchestrator" | "subagent";
type FixtureRolePriority = 1 | 2 | 3 | "disabled";
const INITIAL_ROLE_PRIORITIES: Readonly<
  Record<FixtureProviderRole, FixtureRolePriority>
> = { orchestrator: 2, subagent: 1 };

/**
The provider role writes the fixture has accepted, by `provider:role`.

The provider list is otherwise static. A role write is held here so the
list read after it carries what was written, as the Runtime's does, and
the specs read it back to see what reached the "Runtime".
*/
const providerRoleWrites = new Map<
  string,
  { priority: FixtureRolePriority; model: string | null }
>();
/**
A code the next role write is refused with, as the Runtime would.
*/
let refuseNextProviderRoleWrite: string | null = null;

function fixtureProviderRole(
  provider: string,
  role: FixtureProviderRole,
  model: string | null
): { priority: FixtureRolePriority; model: string | null } {
  return (
    providerRoleWrites.get(`${provider}:${role}`) ?? {
      priority: INITIAL_ROLE_PRIORITIES[role],
      model
    }
  );
}

async function handleProviderRoleMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(PROVIDER_ROLE_ROUTE);
  if (match === null || request.method !== "PATCH") return false;
  const provider = decodeURIComponent(match[1] ?? "");
  const role = match[2] as FixtureProviderRole;
  const body = await readJsonBody(request);
  const priority = body?.priority;
  const model = body?.model ?? null;
  if (
    (priority !== 1 &&
      priority !== 2 &&
      priority !== 3 &&
      priority !== "disabled") ||
    (model !== null && typeof model !== "string")
  ) {
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_api_bad_body",
          message: "The fixture needs a priority and a model.",
          type: "invalid_request_error"
        }
      },
      400
    );
    return true;
  }
  if (refuseNextProviderRoleWrite !== null) {
    const code = refuseNextProviderRoleWrite;
    refuseNextProviderRoleWrite = null;
    sendJson(
      response,
      {
        error: {
          code,
          message: "The fixture refused this role write.",
          type: "conflict"
        }
      },
      409
    );
    return true;
  }
  providerRoleWrites.set(`${provider}:${role}`, { priority, model });
  sendJson(response, { provider, role, priority, model });
  return true;
}

/**
The fixture's own control over provider roles.

`POST /fixture/providers/roles?state=reset` forgets every write;
`?state=refuse-next&code=<code>` refuses the next write with that code;
`GET` lists the writes that were accepted.
*/
function configureProviderRoleFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname !== "/fixture/providers/roles") return false;
  if (request.method === "GET") {
    sendJson(response, { writes: Object.fromEntries(providerRoleWrites) });
    return true;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return true;
  }
  const state = url.searchParams.get("state");
  if (state === "reset") {
    providerRoleWrites.clear();
    agentModelWrites.clear();
    refuseNextProviderRoleWrite = null;
  } else if (state === "refuse-next") {
    refuseNextProviderRoleWrite =
      url.searchParams.get("code") ?? "autodev_control_api_bad_body";
  } else {
    sendJson(
      response,
      {
        code: "autodev_fixture_unknown_state",
        message: "The fixture knows reset and refuse-next."
      },
      400
    );
    return true;
  }
  sendJson(response, { state });
  return true;
}

/**
The fixture's own write routes.

One dispatch for the writes, so the request handler stays within the
complexity budget it was written to. Each of these answers a route that the
read-only guard would otherwise reject with a bare 405 -- which reads as a
route that does not exist.
*/
async function handleSyntheticMutationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (
    (await handleSyntheticWorkspaceApproval(request, response, url.pathname)) ||
    (await handleSyntheticAnalysisMutation(request, response, url)) ||
    (await handleSyntheticRunMutation(request, response, url)) ||
    handleSyntheticReadinessInitialization(request, response, url) ||
    (await handleSyntheticSkillRoleMutation(request, response, url)) ||
    (await handleAgentEnablementMutation(request, response, url)) ||
    (await handleProviderRoleMutation(request, response, url)) ||
    (await handleAgentModelMutation(request, response, url)) ||
    configureProviderRoleFixture(request, response, url) ||
    (await applyMcpDeclarationWrite(response, request, url))
  ) {
    return true;
  }
  if (url.pathname.startsWith("/control/hooks/")) {
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_api_unknown_path",
          message: "Unknown Control API path."
        }
      },
      404
    );
    return true;
  }
  if (await applyWorkspaceConfigWrite(request, response, url)) {
    return true;
  }
  if (
    (PROMPT_DETAIL_ROUTE.test(url.pathname) ||
      SKILL_CONTENT_ROUTE.test(url.pathname)) &&
    request.method !== "GET"
  ) {
    response.setHeader("allow", "GET");
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_api_method_not_allowed",
          message: PROMPT_DETAIL_ROUTE.test(url.pathname)
            ? "Prompt detail is read-only via GET."
            : "Canonical skill content is read-only; a skill is changed in its repository source and reconciled by the standard workflow."
        }
      },
      405
    );
    return true;
  }
  if (
    [
      "/control/permissions",
      "/control/hooks",
      "/control/hooks-applied"
    ].includes(url.pathname) &&
    request.method !== "GET"
  ) {
    response.setHeader("allow", "GET");
    sendJson(
      response,
      {
        error: {
          code: "autodev_control_api_method_not_allowed",
          message: "Control API collections are read-only via GET."
        }
      },
      405
    );
    return true;
  }
  return configureAgentEnablementFixture(request, response, url);
}

/**
The session-diagnostics routes.

The Console's session-scoped Usage view reads them, so the stand-in answers
them with the Core contract's own shapes. A session id that names no
session answers with `found: false` rather than a 404: a session that does
not exist is a fact about the machine, not a missing route.
*/
function respondSessionDiagnostics(
  url: URL,
  response: ServerResponse
): boolean {
  if (!url.pathname.startsWith("/control/diagnostics/")) return false;
  if (url.pathname === "/control/diagnostics/sessions/recent") {
    sendJson(response, recentSessionsResponse());
    return true;
  }
  if (url.pathname === "/control/diagnostics/sessions/scan") {
    sendJson(response, fleetScanResponse());
    return true;
  }
  if (url.pathname === "/control/diagnostics/hooks") {
    sendJson(response, hookDenialsResponse());
    return true;
  }
  const sessionMatch = url.pathname.match(DIAGNOSTICS_SESSION_PATH_PATTERN);
  if (sessionMatch?.[1]) {
    const report = sessionDiagnosticsReport();
    const requested = decodeURIComponent(sessionMatch[1]);
    sendJson(
      response,
      requested === DIAGNOSTICS_SESSION_ID
        ? report
        : { ...report, found: false, requestedId: requested, threads: [] }
    );
    return true;
  }
  response.writeHead(404).end();
  return true;
}

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200).end("ok");
      return;
    }
    if (
      resetSyntheticFixture(request, response) ||
      configureReadinessFixture(url, response) ||
      handleSyntheticReadFailureConfig(url, response) ||
      (await handleSyntheticMutationRoutes(request, response, url))
    )
      return;
    // The catalog and the fixture's own control routes are answered before the
    // read-only guard: one of them is a write, and a write that the guard
    // rejects with a bare 405 is a route that does not exist.
    if (handleFixtureCatalogRoutes(request, response, url)) return;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (respondSessionDiagnostics(url, response)) return;
    if (url.pathname === "/control/workspaces") {
      sendJson(response, {
        schema: "autodev-control-workspaces-v3",
        source: "fixture",
        readOnly: false,
        catalogStatus: "valid",
        revision: workspaceConfig.revision,
        totalWorkspaces: 1,
        reconciliation: workspaceConfigReconciliation(),
        workspaces: [
          {
            id: workspaceConfig.id,
            baseBranch: workspaceConfig.baseBranch,
            enabled: workspaceConfig.enabled,
            agentRoles: workspaceConfig.agentRoles,
            configuration: { status: "configured" },
            runtime: { status: "not-observed" }
          }
        ]
      });
      return;
    }
    if (url.pathname === "/control/providers") {
      const convergence = {
        convergence: NOT_OBSERVED_CONVERGENCE,
        desiredGeneration: "fixture",
        observedGeneration: "fixture",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Provider fixture state."
      };
      const provider = (
        id: string,
        model: string | null,
        groups: readonly { tier: string; group: number }[]
      ) => ({
        id,
        links: { usage: null, documentation: null },
        route: {
          pattern: id === "claude" ? "^(sonnet|claude-.*)$" : "^gpt-.*$",
          baseUrl: `http://127.0.0.1:4100/${id}`,
          healthUrl: null
        },
        credential: { envKey: null, configured: true },
        disabled: false,
        roles: Object.fromEntries(
          (["orchestrator", "subagent"] as const).map((role) => [
            role,
            {
              ...fixtureProviderRole(id, role, model),
              mutable: true,
              canServe: true,
              cannotServeReason: null,
              convergence
            }
          ])
        ),
        agentLimits: null,
        agentModels: fixtureAgentModels(id, model),
        models: model === null ? [] : [{ tier: "default", model }],
        priorities: groups,
        orchestratorReasoningEffort: null,
        health: null,
        // The provider's own view. The fixture's runtime has never applied
        // anything to a provider, so the observation is missing rather than
        // empty: the page must say the convergence is unknown instead of
        // claiming one. The desired generation is the identity of the
        // provider's configured routing state, which the runtime reports even
        // before anything is applied.
        reconciliation: {
          status: {
            convergence: NOT_OBSERVED_CONVERGENCE,
            desiredGeneration: createHash("sha256")
              .update(`provider:${id}`, "utf8")
              .digest("hex"),
            observedGeneration: null,
            lastApplyAt: null,
            lastObservationAt: null,
            lastError: null,
            explanation:
              "The runtime has not yet reported observed state for this resource; convergence is unknown."
          },
          history: []
        }
      });
      sendJson(response, {
        schema: "autodev-control-providers-v5",
        quotaAxi: null,
        orchestratorTier: "orchestrator",
        tiers: [
          { tier: "default", groups: [["claude"], ["codex"]] },
          { tier: "orchestrator", groups: [["codex"], ["claude"]] }
        ],
        providers: [
          provider("claude", "sonnet", [{ tier: "default", group: 1 }]),
          provider("codex", "gpt-6-luna", [{ tier: "default", group: 2 }]),
          provider("copilot", null, [])
        ]
      });
      return;
    }
    if (url.pathname === "/control/models") {
      const convergence = {
        convergence: NOT_OBSERVED_CONVERGENCE,
        desiredGeneration: "enabled=true",
        observedGeneration: "enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Model fixture state."
      };
      sendJson(response, {
        schema: "autodev-control-models-v2",
        source: "synthetic-provider-fixture",
        models: [
          {
            id: "sonnet",
            provider: "claude",
            tiers: ["default", "smart", "subagent"],
            displayName: "Claude Sonnet fixture",
            enablement: { enabled: true, mutable: true, convergence }
          },
          {
            id: "gpt-6-luna",
            provider: "codex",
            tiers: ["default"],
            displayName: "Codex fixture",
            enablement: { enabled: true, mutable: false, convergence }
          }
        ]
      });
      return;
    }
    if (url.pathname === "/control/provider-models") {
      sendJson(response, {
        schema: "autodev-control-provider-model-discovery-v1",
        source: "runtime-provider-discovery",
        providers: [
          {
            provider: "claude",
            discovery: {
              status: "observed",
              source: "synthetic Claude listing",
              observedAt: FIXTURE_TIMESTAMP,
              lastAttemptAt: FIXTURE_TIMESTAMP,
              models: [
                {
                  id: "sonnet",
                  displayName: "Claude Sonnet fixture",
                  routeability: { status: "supported" }
                },
                {
                  id: "claude-preview-unroutable",
                  displayName: "Claude Preview fixture",
                  routeability: {
                    status: "unsupported",
                    reason: "The fixture Runtime has no route for this model."
                  }
                }
              ]
            }
          },
          {
            provider: "codex",
            discovery: {
              status: "stale",
              source: "synthetic Codex listing",
              observedAt: "2026-10-09T00:00:00.000Z",
              lastAttemptAt: FIXTURE_TIMESTAMP,
              reason: "The latest synthetic provider read timed out.",
              models: [
                {
                  id: "gpt-6-luna",
                  displayName: "Codex fixture",
                  routeability: { status: "supported" }
                }
              ]
            }
          },
          {
            provider: "copilot",
            discovery: {
              status: "unavailable",
              source: null,
              lastAttemptAt: null,
              reason: "The fixture has no Copilot model listing adapter."
            }
          }
        ]
      });
      return;
    }
    if (url.pathname === "/control/provider-versions") {
      // The three cases the page has to tell apart: a CLI that reported its
      // version, one that is installed but would not answer, and one that is
      // not installed at all.
      sendJson(response, {
        schema: "autodev-control-provider-versions-v1",
        source: "runtime-provider-cli-versions",
        providers: [
          {
            provider: "claude",
            cli: {
              status: "observed",
              command: "claude",
              version: "2.1.280",
              observedAt: FIXTURE_TIMESTAMP
            }
          },
          {
            provider: "codex",
            cli: {
              status: "unavailable",
              kind: "not-readable",
              command: "codex",
              reason: "Reading the codex CLI's version timed out.",
              lastAttemptAt: FIXTURE_TIMESTAMP
            }
          },
          {
            provider: "copilot",
            cli: {
              status: "unavailable",
              kind: "not-installed",
              command: "copilot",
              reason: "The Copilot CLI (copilot) is not installed.",
              lastAttemptAt: FIXTURE_TIMESTAMP
            }
          }
        ]
      });
      return;
    }
    if (url.pathname === "/control/tools") {
      sendJson(response, {
        schema: "autodev-control-tools-v2",
        source: "synthetic-tools-fixture",
        readOnly: true,
        coverage: "complete",
        validity: "valid",
        executionContractObserved: true,
        totalTools: 2,
        usageLink: "/usage",
        tools: [
          {
            name: "read_file",
            source: "native",
            sourceAuthority: "codex-native",
            exposedRoles: ["orchestrator", "worker"],
            availability: "configured"
          },
          {
            name: "lsp_goto_definition",
            source: "mcp",
            sourceAuthority: "rulesync-mcp",
            server: "lsp",
            description: "Jump to symbol definition.",
            exposedRoles: ["worker"],
            availability: "configured",
            canonicalEditSurface: { section: "mcps", identifier: "lsp" }
          }
        ]
      });
      return;
    }

    if (!url.pathname.startsWith("/control/playtesting/")) {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("workspaceId") !== WORKSPACE_ID) {
      response.writeHead(404).end();
      return;
    }
    if (
      handleSyntheticRunRead(request, response, url) ||
      handleSyntheticPlaytestingRead(response, url)
    )
      return;
    response.writeHead(404).end();
  }
);
server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
