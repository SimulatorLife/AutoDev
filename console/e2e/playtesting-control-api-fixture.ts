/** Deterministic, explicitly synthetic Control API fixture for browser usability tests. */
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import {
  buildPlaytestCoverageManifestDraft,
  buildPlaytestFindingIdentity,
  buildReconciliationView,
  CONTROL_API_CONTRACT,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
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
  recordPlaytestOwnerDecision,
  selectPlaytestBatchReviews
} from "@simulatorlife/autodev-core";

import {
  applyCanonicalSourceWrite,
  armCanonicalSourceApplyFailure,
  canonicalSource,
  type CanonicalSourceKind,
  moveCanonicalSource,
  resetCanonicalSources
} from "./canonical-source-fixture.ts";

/**
 * The vocabulary the fixture speaks in.
 *
 * The fixture is a stand-in for the Control API, so the values it writes are
 * the API's values; naming them once keeps the fixture from spelling the
 * same mode or policy two ways.
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

const PORT = Number(process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? 4311);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
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
 * The persisted reviews, in the summary shape the Control API serves.
 *
 * The Console reads the analyst's durable record through this route, and a
 * fixture that serves only the in-process analyst envelope leaves the
 * Findings view with nothing to show — so the review a session carries is
 * projected into the shape the reader validates.
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

/** The reviews a reader sees before any analysis has been run. */
const persistedReviewRows = [reviewSummaryRow(latestReview)];

/**
 * The reviews a reader sees.
 *
 * They are the persisted ones plus any review an analyst run in this fixture
 * has just produced, so a reader who runs an analysis and comes back to the
 * Findings view finds the analysis there.
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
 * A refusal, in the shape the Runtime refuses a request in.
 *
 * The Console reads the code out of the error, so a refusal that does not
 * carry one leaves the Console guessing what happened from the status alone.
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
let failNextRunAcknowledgement = false;
let failNextRunByRequestLookup = false;
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
 * When set, the active-runs read fails. The Console must then show an explicit
 * unavailable state; a test that never sees the read fail cannot tell a stale
 * frame from a live one.
 */
let syntheticRunsReadFails = false;
let syntheticVisualReadinessEnabled = false;
let syntheticVisualRunEnabled = false;
let syntheticReadinessPendingPolls = 0;
let syntheticReadinessPollCount = 0;
let syntheticReadinessUnavailable = false;
let syntheticAnalystRunsReadFails = false;
let syntheticAnalystTaskHistoryMissing = false;
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
      !episodeIds.every((id) => typeof id === "string") ||
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
    if (syntheticAnalystRunsReadFails) {
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
      runs: syntheticAnalystTaskHistoryMissing ? [] : runs,
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
 * Whether a visual launch request is the one the fixture serves.
 *
 * The fixture answers for the Runtime, so it accepts a request only when the
 * request is exactly the shape the Console sends for an approved target --
 * no extra keys, no missing ones, and the capability revision the readiness
 * read reported.
 */
function syntheticVisualLaunchShapeIsValid(
  launch: Record<string, unknown>,
  limits: unknown
): boolean {
  if (!syntheticVisualReadinessEnabled) return false;
  if (Object.keys(launch).length !== SYNTHETIC_VISUAL_LAUNCH_KEYS.size) {
    return false;
  }
  if (
    Object.keys(launch).some((key) => !SYNTHETIC_VISUAL_LAUNCH_KEYS.has(key))
  ) {
    return false;
  }
  if (launch.schema !== PLAYTEST_LAUNCH_REQUEST_SCHEMA) return false;
  if (launch.workspaceId !== WORKSPACE_ID) return false;
  if (launch.targetId !== SYNTHETIC_VISUAL_TARGET.targetId) return false;
  if (launch.policyId !== FIXTURE_SMART_DIRECT_POLICY) return false;
  if (launch.capabilityRevision !== FIXTURE_CAPABILITY_REVISION) return false;
  if (typeof launch.requestId !== "string") return false;
  if (!REQUEST_ID_PATTERN.test(launch.requestId)) return false;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return false;
  }
  const limitKeys = Object.keys(limits);
  if (limitKeys.length !== SYNTHETIC_VISUAL_LIMIT_KEYS.size) return false;
  return !limitKeys.some((key) => !SYNTHETIC_VISUAL_LIMIT_KEYS.has(key));
}

/**
 * Whether the requested budget is inside the approved target's budget.
 *
 * The approved target is the ceiling: a launch may ask for less than the
 * approval allows and never for more.
 */
function syntheticVisualLimitsWithinApproval(
  launch: Record<string, unknown>,
  limits: Record<string, unknown>
): boolean {
  const approved = SYNTHETIC_VISUAL_TARGET.limits;
  const episodes = Number(limits.episodeCount);
  if (!Number.isSafeInteger(limits.episodeCount) || episodes < 1) return false;
  if (episodes > approved.episodeCount) return false;
  const steps = Number(limits.maxStepsPerEpisode);
  if (!Number.isSafeInteger(limits.maxStepsPerEpisode) || steps < 1) {
    return false;
  }
  if (steps > approved.maxStepsPerEpisode) return false;
  if (limits.wallTimeMs !== approved.wallTimeMs) return false;
  if (limits.smartRequestsPerEpisode !== approved.smartRequestsPerEpisode) {
    return false;
  }
  if (limits.smartTokensPerEpisode !== approved.smartTokensPerEpisode) {
    return false;
  }
  if (limits.screenshotCountPerEpisode !== approved.screenshotCountPerEpisode) {
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
 * The fixture's answer to a visual launch.
 *
 * A visual launch is a different request from an adapter launch: it names an
 * approved target, a budget inside that target, and a focus. It is handled
 * on its own so the two launches cannot be confused for one another.
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
  if (!syntheticVisualRunEnabled) {
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
  if (failNextRunAcknowledgement) {
    failNextRunAcknowledgement = false;
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
  if (failNextRunAcknowledgement) {
    failNextRunAcknowledgement = false;
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
  if (await handleSyntheticComparisonMutation(request, response, url)) {
    return true;
  }
  if (await handleSyntheticLaunchMutation(request, response, url)) {
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
    "autonomous-visual": syntheticVisualReadinessEnabled
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
 * Each decision backend the visual mode offers, with its own readiness.
 *
 * A mode being ready says the browser can be driven; it does not say that
 * every backend can be reached. The launch form refuses to start a run
 * against a backend that cannot be reached, so a fixture that offered only
 * the mode's readiness would leave the form disabled for no stated reason.
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

function handleSyntheticReadFailureConfiguration(
  url: URL,
  response: ServerResponse
): boolean {
  switch (url.pathname) {
    case "/fixture/runs-read-fail": {
      syntheticRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, { syntheticRunsReadFails });
      return true;
    }
    case "/fixture/run-ack-failure": {
      failNextRunAcknowledgement = url.searchParams.get("mode") === "once";
      sendJson(response, { failNextRunAcknowledgement });
      return true;
    }
    case "/fixture/run-by-request-not-found": {
      failNextRunByRequestLookup = url.searchParams.get("mode") === "once";
      sendJson(response, { failNextRunByRequestLookup });
      return true;
    }
    case "/fixture/run-count": {
      sendJson(response, { count: syntheticRuns.size });
      return true;
    }
    case "/fixture/visual-readiness": {
      syntheticVisualReadinessEnabled = ["ready", "run"].includes(
        url.searchParams.get("mode") ?? ""
      );
      syntheticVisualRunEnabled = url.searchParams.get("mode") === "run";
      sendJson(response, {
        syntheticVisualReadinessEnabled,
        syntheticVisualRunEnabled
      });
      return true;
    }
    case "/fixture/analyses-read-fail": {
      syntheticAnalystRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, { syntheticAnalystRunsReadFails });
      return true;
    }
    case "/fixture/analyst-history": {
      syntheticAnalystTaskHistoryMissing =
        url.searchParams.get("mode") === "missing";
      sendJson(response, { syntheticAnalystTaskHistoryMissing });
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
  const transientNotFound = failNextRunByRequestLookup;
  if (transientNotFound) failNextRunByRequestLookup = false;
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
  if (syntheticRunsReadFails) {
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
  if (syntheticReadinessUnavailable) {
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
  const code = syntheticReadinessUnavailable
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
  syntheticRunsReadFails = false;
  syntheticVisualReadinessEnabled = false;
  syntheticVisualRunEnabled = false;
  failNextRunAcknowledgement = false;
  failNextRunByRequestLookup = false;
  syntheticReadinessPendingPolls = 0;
  syntheticReadinessPollCount = 0;
  syntheticReadinessUnavailable = false;
  syntheticAnalystRunsReadFails = false;
  syntheticAnalystTaskHistoryMissing = false;
  skillAssignmentRevision = INITIAL_SKILL_ASSIGNMENT_REVISION;
  skillRoles["code-review"] = [...INITIAL_SKILL_ROLES];
  runtimeUnavailable = false;
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
  syntheticReadinessUnavailable = false;
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
  syntheticReadinessUnavailable = url.searchParams.get("unavailable") === "on";
  const polls = Number(url.searchParams.get("pendingPolls") ?? 0);
  syntheticReadinessPendingPolls = Number.isSafeInteger(polls)
    ? Math.max(0, Math.min(10, polls))
    : 0;
  syntheticReadinessPollCount = 0;
  sendJson(response, {
    syntheticReadinessPendingPolls,
    syntheticReadinessUnavailable
  });
  return true;
}

/** The route that assigns the roles of one skill. */
const SKILL_ROLES_ROUTE = /^\/control\/skills\/([^/]+)$/u;

/** The route that reads one skill's canonical source. */
const SKILL_CONTENT_ROUTE = /^\/control\/skills\/([^/]+)\/content$/u;

/** The route that reads one agent's detail. */
const AGENT_DETAIL_ROUTE = /^\/control\/agents\/([^/]+)$/u;

/** The route that reads one prompt's detail. */
const PROMPT_DETAIL_ROUTE = /^\/control\/prompts\/([^/]+)$/u;

/** The moment the fixture says a write was applied. */
const FIXTURE_APPLIED_AT = "2026-01-01T00:00:00.000Z";

/** The agent kind a role runs as a leaf rather than as an orchestrator. */
const LEAF_AGENT_KIND = "leaf";

/** The convergence verdict for a state the Runtime has not reported. */
const NOT_OBSERVED_CONVERGENCE = "not-observed";

/**
 * The skill role assignment the fixture holds.
 *
 * The revision is what the Console's compare-and-swap is checked against, so
 * it has to move when the roles move: a page that loaded the old revision and
 * then saved is a conflict, which is the state the acceptance needs to reach.
 */
const INITIAL_SKILL_ASSIGNMENT_REVISION = "b".repeat(64);
const INITIAL_SKILL_ROLES = ["worker"];
let skillAssignmentRevision = INITIAL_SKILL_ASSIGNMENT_REVISION;
const skillRoles: Record<string, string[]> = {
  "code-review": [...INITIAL_SKILL_ROLES]
};

/**
 * The agent enablement the fixture holds.
 *
 * The revision is what the Console's compare-and-swap is checked against, so
 * it has to move when the enablement moves: a page that loaded the old
 * revision and then wrote is a conflict, not a silent overwrite of somebody
 * else's change. The second role has no runtime projection at all, so it has
 * no enablement to change and no revision to offer -- which is the state the
 * Console has to keep distinct from "disabled".
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
 * One role's enablement, as the Runtime reports it.
 *
 * The list and the detail read the same state through this one function, so a
 * write that lands is the same fact on both surfaces rather than two the
 * fixture keeps in step by hand.
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
 * The skill role assignment write.
 *
 * The whole desired set travels with the write, so the fixture replaces the
 * roles rather than adding to them, and the write is checked against the
 * revision the caller read: a page holding a stale revision is a conflict,
 * not a silent overwrite of somebody else's assignment.
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
  if (!roles.every((role) => typeof role === "string")) {
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
 * The agent enablement write.
 *
 * The Runtime owns this state, so the write carries the revision the caller
 * read and is checked against it: a page holding a stale revision is a
 * conflict, not a silent overwrite of somebody else's change. A role with no
 * runtime projection has nothing to enable, so the write is refused there too
 * rather than inventing a value for it.
 */
async function handleAgentEnablementMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = url.pathname.match(AGENT_DETAIL_ROUTE);
  if (match === null) return false;
  if (request.method !== "PATCH") return false;

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
 * The fixture's own control over the agent enablement.
 *
 * `/fixture/agents/state?state=revision-moved` moves the revision without this
 * Console knowing: the page that has the agent open holds the revision it was
 * rendered with, so moving it here is what makes the page's next write a
 * conflict rather than a silent overwrite of somebody else's change. The
 * `enabled` and `disabled` states put the enablement back where a test that
 * writes starts from.
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
  if (state === "enabled" || state === "disabled") {
    agentEnablement.default.enabled = state === "enabled";
    agentEnablement.default.revision = INITIAL_AGENT_ENABLEMENT_REVISION;
  } else if (state === "revision-moved") {
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
    state: state === "revision-moved" ? "revision-moved" : state,
    enabled: agentEnablement.default.enabled,
    revision: agentEnablement.default.revision
  });
  return true;
}

/**
 * The fixture's own control over the skill assignment.
 *
 * `/fixture/skills/revision` moves the canonical roles without this Console
 * knowing: the page that has the skills open holds the revision it was
 * rendered with, so bumping the revision here is what makes its next write a
 * conflict rather than a silent overwrite of somebody else's assignment.
 * `/fixture/skills/reset` puts the assignment back, so a test that writes
 * starts from the catalog the fixture declares.
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
 * The Runtime's live projection, as this fixture reports it.
 *
 * `liveAgents` is null on purpose. The Runtime registered no live-agent
 * activity source, so the Agents list keeps saying that a per-agent live
 * count is not observed instead of inventing a zero for it. The router's own
 * counters are a separate source and are reported, and they are what the
 * Usage Active Sessions scope reads.
 */
const RUNTIME_ACTIVE_SESSIONS = 3;
const RUNTIME_ACTIVE_SUBAGENT_THREADS = 2;
const RUNTIME_IN_FLIGHT_REQUESTS = 4;

/**
 * Whether the Runtime answers at all.
 *
 * A live scope that can only ever be read successfully cannot show what a
 * failed read looks like, and the difference between "the Runtime is idle" and
 * "the Runtime was never observed" is the whole point of the scope.
 */
let runtimeUnavailable = false;

/**
 * Whether the GitHub Actions runtime state can be read.
 *
 * The workflow definitions are parsed from the repository's YAML and the
 * runtime state comes from the GitHub Actions API, so the two can be read
 * apart. The page has to keep them apart too: a page that can only render
 * observed runtime facts cannot show that it refuses to invent them.
 */
let githubRuntimeUnavailable = false;

/**
 * The workspace the durable memory belongs to.
 */
const MEMORY_WORKSPACE_ID = "fixture/game";
/** The claims the store holds behind the window one read carries. */
const MEMORY_RECORDS_TOTAL = 1204;
/** The rows one read carries. */
const MEMORY_RECORDS_LIMIT = 50;

/**
 * Whether durable memory storage is connected.
 *
 * The storage status and the records read answer different questions, and the
 * page uses the status to explain a failed records read rather than guessing
 * why it failed. So the fixture has to be able to take the storage away, or
 * the page's explanation is only ever a guess that happens to be right.
 */
let memoryStorageNotConfigured = false;

/**
 * The durable claims the fixture holds.
 *
 * The rows carry the states the Memory view has to tell apart -- a claim
 * that is active, one that was proposed, one that was superseded, one that
 * was invalidated and one whose state is uncertain -- and the lifecycle
 * rollup is about the whole filtered collection rather than the rows on the
 * page, because a page is a window the reader chose.
 */
function memoryRecords(): readonly Record<string, unknown>[] {
  return [
    {
      id: "mem-0001",
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: MEMORY_WORKSPACE_ID,
        repositoryId: MEMORY_WORKSPACE_ID
      },
      claim: "The Console's breadcrumb landmark is named Breadcrumb.",
      status: "active",
      provenance: {
        experienceIds: ["exp-0001"],
        evidence: [
          {
            kind: "file",
            uri: "console/src/components/navigation/Breadcrumbs.ts",
            revision: "00b76b4d"
          }
        ],
        createdBy: FIXTURE_LOCAL_WORKSPACE,
        createdAt: "2026-02-11T09:12:00.000Z",
        verificationSource: "console/e2e/breadcrumbs-acceptance.spec.ts",
        lastVerifiedAt: "2026-02-11T10:02:00.000Z"
      },
      validity: {
        state: "verified",
        validFrom: "2026-02-11T09:12:00.000Z",
        checkedAt: "2026-02-11T10:02:00.000Z",
        verificationSource: "console/e2e/breadcrumbs-acceptance.spec.ts",
        evidence: [
          {
            kind: "file",
            uri: "console/src/components/navigation/Breadcrumbs.ts"
          }
        ]
      },
      createdAt: "2026-02-11T09:12:00.000Z",
      updatedAt: "2026-02-11T10:02:00.000Z"
    },
    {
      id: "mem-0002",
      kind: "episodic",
      scope: { kind: "workspace", workspaceId: MEMORY_WORKSPACE_ID },
      claim: "The Usage p95 latency card read a duration in milliseconds.",
      status: "proposed",
      provenance: {
        experienceIds: ["exp-0002"],
        evidence: [
          {
            kind: "trace",
            uri: "a1a1a1a100000000",
            observedAt: FIXTURE_REVIEW_TIMESTAMP
          }
        ],
        createdBy: FIXTURE_LOCAL_WORKSPACE,
        createdAt: FIXTURE_REVIEW_TIMESTAMP
      },
      validity: {
        state: "unverified",
        evidence: []
      },
      createdAt: FIXTURE_REVIEW_TIMESTAMP,
      updatedAt: FIXTURE_REVIEW_TIMESTAMP
    },
    {
      id: "mem-0003",
      kind: "procedural",
      scope: {
        kind: "role",
        workspaceId: MEMORY_WORKSPACE_ID,
        role: "orchestrator",
        repositoryId: MEMORY_WORKSPACE_ID
      },
      claim: "A duration has one owner.",
      status: "superseded",
      provenance: {
        experienceIds: ["exp-0003"],
        evidence: [{ kind: "commit", uri: "79767fb8" }],
        createdBy: FIXTURE_LOCAL_WORKSPACE,
        createdAt: "2026-02-10T16:04:00.000Z"
      },
      validity: {
        state: "contradicted",
        evidence: [{ kind: "commit", uri: "79767fb8" }]
      },
      supersededBy: ["mem-0004"],
      createdAt: "2026-02-10T16:04:00.000Z",
      updatedAt: FIXTURE_EARLIER_TIMESTAMP
    },
    {
      id: "mem-0004",
      kind: "semantic",
      scope: {
        kind: "repository",
        workspaceId: MEMORY_WORKSPACE_ID,
        repositoryId: MEMORY_WORKSPACE_ID
      },
      claim: "Every duration on the Console is rendered by one formatter.",
      status: "active",
      provenance: {
        experienceIds: ["exp-0004"],
        evidence: [{ kind: "commit", uri: "79767fb8" }],
        createdBy: FIXTURE_LOCAL_WORKSPACE,
        createdAt: FIXTURE_EARLIER_TIMESTAMP,
        verificationSource: "console/tests/duration-format.test.ts",
        lastVerifiedAt: "2026-02-11T08:31:00.000Z"
      },
      validity: {
        state: "verified",
        validFrom: FIXTURE_EARLIER_TIMESTAMP,
        checkedAt: "2026-02-11T08:31:00.000Z",
        verificationSource: "console/tests/duration-format.test.ts",
        evidence: [
          { kind: "file", uri: "console/src/components/ui/duration.ts" }
        ]
      },
      supersedes: ["mem-0003"],
      createdAt: FIXTURE_EARLIER_TIMESTAMP,
      updatedAt: "2026-02-11T08:31:00.000Z"
    },
    {
      id: "mem-0005",
      kind: "episodic",
      scope: { kind: "global" },
      claim: "The Evaluations page had never been driven in a browser.",
      status: "invalidated",
      provenance: {
        experienceIds: ["exp-0005"],
        evidence: [{ kind: "commit", uri: "8ea55f37" }],
        createdBy: FIXTURE_LOCAL_WORKSPACE,
        createdAt: "2026-02-09T11:00:00.000Z"
      },
      validity: {
        state: "contradicted",
        evidence: [{ kind: "commit", uri: "8ea55f37" }]
      },
      createdAt: "2026-02-09T11:00:00.000Z",
      updatedAt: "2026-02-11T09:05:00.000Z"
    }
  ];
}

/**
 * The durable memory reads the Memory page makes.
 *
 * The records read is a bounded window over a collection, and the lifecycle
 * rollup it carries is about the collection rather than about the rows on the
 * page -- the page is a window the reader chose, so counting off it reports
 * at most a page of claims beside a total of thousands.
 */
function handleMemoryRead(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/fixture/memory/state") {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return true;
    }
    memoryStorageNotConfigured =
      url.searchParams.get("state") === "not_configured";
    sendJson(response, {
      state: memoryStorageNotConfigured ? "not_configured" : "configured"
    });
    return true;
  }
  if (url.pathname === "/control/memory/status") {
    sendJson(response, {
      schema: "autodev-memory-status-v1",
      storage: {
        state: memoryStorageNotConfigured ? "not_configured" : "configured",
        backend: "postgresql",
        embeddings: memoryStorageNotConfigured
          ? "not_configured"
          : "configured",
        probeTimeoutMs: 2000
      }
    });
    return true;
  }
  if (url.pathname === "/control/memory/records") {
    if (memoryStorageNotConfigured) {
      response.writeHead(503).end();
      return true;
    }
    const records = memoryRecords();
    sendJson(response, {
      schema: "autodev-memory-records-v1",
      items: records,
      total: MEMORY_RECORDS_TOTAL,
      limit: MEMORY_RECORDS_LIMIT,
      offset: 0,
      statusCounts: {
        proposed: 412,
        active: 604,
        superseded: 120,
        invalidated: 48,
        uncertain: 20
      }
    });
    return true;
  }
  if (url.pathname === "/control/memory/experiences") {
    sendJson(response, {
      schema: "autodev-memory-experiences-v1",
      items: [],
      total: 0,
      limit: MEMORY_RECORDS_LIMIT,
      offset: 0
    });
    return true;
  }
  if (url.pathname === "/control/memory/session-cohorts") {
    sendJson(response, {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      cells: [],
      sessionCount: 18,
      reportedSessionCount: 12,
      unreportedSessionCount: 6
    });
    return true;
  }
  return false;
}

/**
 * The workflow definitions the repository declares.
 *
 * The rows carry the states the page has to tell apart: a workflow that is
 * active in GitHub and one that was disabled by hand, one whose runtime state
 * was never loaded, one that declares no trigger event and one that declares
 * no schedule.
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
 * The bounded recent-run sample the Actions API returned.
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
 * The GitHub workflow catalog and the observed Actions runtime state.
 *
 * The read is read-only in the product as well as here: dispatch, cancel,
 * rerun and schedule controls are unimplemented, so the fixture answers no
 * mutation of its own.
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
    githubRuntimeUnavailable = url.searchParams.get("state") === "unavailable";
    sendJson(response, {
      state: githubRuntimeUnavailable ? "unavailable" : "observed"
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
    runtimeFactsAvailable: !githubRuntimeUnavailable,
    runtimeStatus: githubRuntimeUnavailable ? "unavailable" : "available",
    runtimeMessage: githubRuntimeUnavailable
      ? "The GitHub Actions API could not be reached for the configured repository."
      : null,
    repository: "SimulatorLife/AutoDev",
    stats: githubRuntimeUnavailable
      ? null
      : {
          totalRuns: 30,
          successfulRuns: 21,
          failedRuns: 5,
          inProgressRuns: 2,
          cancelledRuns: 2,
          successRate: 0.7
        },
    recentRuns: githubRuntimeUnavailable ? [] : githubRecentRuns()
  });
  return true;
}

/**
 * The Runtime's read-only live projection, and the fixture's control over it.
 *
 * `/fixture/runtime/state` takes the Runtime away, so a page that reads it
 * has to say that the read failed rather than showing an idle Runtime.
 */
function handleRuntimeFixture(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/fixture/runtime/state") {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return true;
    }
    runtimeUnavailable = url.searchParams.get("state") === "unavailable";
    sendJson(response, {
      state: runtimeUnavailable ? "unavailable" : "observed"
    });
    return true;
  }
  if (url.pathname !== "/control/runtime") return false;
  if (runtimeUnavailable) {
    response.writeHead(503).end();
    return true;
  }
  sendJson(response, {
    schema: "autodev-control-runtime-v2",
    routerInstanceId: "fixture-router",
    lifecycle: {
      state: "ready",
      draining: false,
      changedAt: FIXTURE_APPLIED_AT,
      activeResponseRequests: 1
    },
    concurrency: {
      scope: "fixture",
      configSource: "fixture",
      configFileExists: true,
      maxConcurrentThreadsPerSession: 4,
      effectivePerSessionLimit: 4,
      activeSubagentThreads: RUNTIME_ACTIVE_SUBAGENT_THREADS,
      activeSessions: RUNTIME_ACTIVE_SESSIONS
    },
    inFlightRequestCount: RUNTIME_IN_FLIGHT_REQUESTS,
    liveAgents: null
  });
  return true;
}

/**
 * The evaluation results the fixture holds.
 *
 * The rows keep the states the Evaluations view has to tell apart: a run
 * that passed, a run that failed and a run whose verdict was never observed;
 * a run that reported a prompt and one that did not; a run whose trace the
 * Usage fixture can open and one whose trace was never retained.
 */
const EVALUATION_ROLES = ["orchestrator", "browser-tester"] as const;
const EVALUATION_MODELS = ["claude-sonnet-5", "gpt-6-meridian"] as const;
const EVALUATION_PROMPTS = ["release-notes", "review"] as const;
/** The rows one read carries. */
const EVALUATION_WINDOW = 60;
/** The results the store holds behind that window. */
const EVALUATION_STORE = 120;
/** The instant the fixture's newest run was recorded. */
const EVALUATION_NEWEST_AT = "2026-02-11T09:30:00.000Z";
/** The span id the Usage fixture never retained. */
const EVALUATION_UNOBSERVED_SPAN_ID = "ffffffffffffffff";

/**
 * One of the fixture's axes, chosen by the row's place in the window.
 */
function evaluationAxis<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error("the fixture's evaluation axes are empty");
  }
  return value;
}

/**
 * A span id the Usage fixture answers with a trace.
 */
function evaluationSpanId(index: number): string {
  return `a1a1a1a1${index.toString(16).padStart(8, "0")}`;
}

/**
 * One evaluation result.
 *
 * The row carries the states the Evaluations view has to tell apart: a run
 * that passed, a run that failed and a run whose verdict was never observed;
 * a run that reported a prompt and one that did not; a run whose trace the
 * Usage fixture can open and one whose trace was never retained.
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
 * The retained evaluation results, most recent first.
 *
 * The window is bounded and the store behind it is larger, because the two
 * numbers are different facts: one is what the read carried, the other is
 * what the store holds.
 */
function evaluationRows(): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < EVALUATION_WINDOW; index += 1) {
    rows.push(evaluationRow(index));
  }
  return rows;
}

/**
 * The retained evaluation results.
 *
 * The envelope says the read is a bounded window over a larger store, so the
 * page has to render the store's size and the window's size as the different
 * facts they are.
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
 * The catalog resources the Console reads: the MCP catalog and the Configure
 * group's agents, skills, hooks, prompts and permissions.
 *
 * Each response carries the states the Console has to keep apart -- a
 * declared server and one that exists only in a target projection, an
 * enabled assignment and one the Runtime could not report, a measured count
 * and an unobserved one -- so the pages are exercised against the states
 * rather than against a single happy row.
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
      schema: "autodev-control-mcps-v1",
      source: ".rulesync/mcp.jsonc",
      readOnly: true,
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
  if (url.pathname === "/control/agents") {
    // Two agents: one whose enablement the Runtime reported and one whose
    // enablement it could not report. The second is the state the Console
    // has to keep distinct from "disabled".
    sendJson(response, {
      schema: "autodev-control-agents-v2",
      source: ".rulesync/agents.jsonc",
      readOnly: false,
      totalAgents: 2,
      agents: [
        {
          id: "default",
          role: "default",
          kind: "orchestrator",
          readOnly: false,
          configured: true,
          valid: true,
          status: "idle",
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
          status: "idle",
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
      valid: true,
      issues: [],
      executionContractRevision: skillAssignmentRevision,
      assignmentRoles: ["default", "worker"],
      skills: [
        {
          name: "code-review",
          description: "Review a diff for defects.",
          path: ".rulesync/skills/code-review/SKILL.md",
          roles: skillRoles["code-review"] ?? []
        }
      ],
      unresolvedAssignments: []
    });
    return true;
  }
  if (url.pathname === "/control/hooks") {
    sendJson(response, {
      schema: "autodev-control-hooks-v1",
      source: ".rulesync/hooks.jsonc",
      readOnly: true,
      valid: true,
      issues: [],
      hooks: {
        PreToolUse: [
          {
            command: "echo guarded",
            matcher: "Bash",
            statusMessage: "Bash is guarded in this fixture."
          }
        ]
      }
    });
    return true;
  }
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
      schema: "autodev-control-permissions-v1",
      source: ".rulesync/permissions.jsonc",
      readOnly: true,
      policy: {
        approvalPolicy: "on-demand",
        sandboxMode: "workspace-write",
        networkAccess: false,
        webSearch: false,
        approvalsReviewer: "operator",
        defaultToolsApprovalMode: "on-request"
      },
      rolePermissions: {
        default: {
          readOnly: false,
          sandbox: "workspace-write",
          networkAccess: false,
          approvals: "on-demand",
          mcp: ["lsp"],
          skills: ["code-review"],
          mcpTools: { lsp: ["lsp_goto_definition"] }
        },
        worker: {
          readOnly: true,
          sandbox: "read-only",
          networkAccess: false,
          approvals: "never",
          mcp: [],
          skills: ["code-review"],
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
      status: "idle",
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
          explanation:
            "The runtime has observed the latest desired generation; convergence is recorded."
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
 * The canonical source writes.
 *
 * The Runtime's write is a compare-and-swap against the revision the editor
 * loaded, and only then the projection apply. The fixture holds a real
 * canonical source, so the conflict it answers with is raised by the rule the
 * Runtime applies rather than by a fixture that re-implements the rule and can
 * drift from it.
 */
async function handleCanonicalSourceMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const prompt = url.pathname.match(PROMPT_DETAIL_ROUTE);
  const skill = url.pathname.match(SKILL_CONTENT_ROUTE);
  if (prompt === null && skill === null) return false;
  // The same path is read as well as written, so a method that is not the
  // write belongs to the read handler rather than to a refusal here.
  if (request.method !== "PATCH") return false;
  const kind: CanonicalSourceKind = prompt === null ? "skill" : "prompt";
  const identifier = prompt?.[1] ?? skill?.[1] ?? "";
  const name = decodeURIComponent(identifier);
  const body = await readJsonBody(request);
  const content = body?.content;
  const expectedRevision = body?.expectedRevision;
  if (typeof content !== "string" || typeof expectedRevision !== "string") {
    sendCanonicalSourceError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "A canonical source update requires exactly the expected revision and Markdown content."
    );
    return true;
  }
  const outcome = await applyCanonicalSourceWrite(kind, name, {
    content,
    expectedRevision
  });
  if (outcome.kind === "invalid-body") {
    sendCanonicalSourceError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "A canonical source update requires exactly the expected revision and Markdown content."
    );
    return true;
  }
  if (outcome.kind === "conflict") {
    sendCanonicalSourceError(
      response,
      409,
      kind === "prompt"
        ? "autodev_control_prompt_revision_conflict"
        : "autodev_control_skill_content_conflict",
      outcome.message
    );
    return true;
  }
  if (outcome.kind === "invalid-source") {
    sendCanonicalSourceError(
      response,
      400,
      kind === "prompt"
        ? "autodev_control_prompt_invalid_source"
        : "autodev_control_skill_source_invalid",
      outcome.message
    );
    return true;
  }
  if (outcome.kind === "apply-failed") {
    sendCanonicalSourceError(
      response,
      503,
      kind === "prompt"
        ? "autodev_control_prompt_apply_failed"
        : "autodev_control_skill_apply_failed",
      outcome.message
    );
    return true;
  }
  const appliedAt = new Date().toISOString();
  const reconciliation = buildReconciliationView({
    evidence: {
      desiredGeneration: outcome.source.revision,
      observedGeneration: outcome.source.revision,
      lastApplyAt: appliedAt,
      lastObservationAt: appliedAt,
      lastError: null
    },
    history: [],
    hasObservation: true,
    restartRequired: false
  });
  if (kind === "prompt") {
    sendJson(response, {
      schema: "autodev-control-prompt-command-patch-v2",
      name: outcome.source.name,
      revision: outcome.source.revision,
      changed: outcome.changed,
      diff: {
        summary: "The canonical command source was updated.",
        identifier: `prompt-${outcome.source.name}-2`
      },
      reconciliation
    });
    return true;
  }
  sendJson(response, {
    schema: "autodev-control-skill-content-patch-v1",
    name: outcome.source.name,
    revision: outcome.source.revision,
    changed: outcome.changed,
    projectionApplied: true,
    reconciliation
  });
  return true;
}

/**
 * The fixture's own control over the canonical source.
 *
 * `/fixture/canonical-source/move` changes a canonical source without this
 * Console knowing: the page that has the source open holds the revision it
 * was rendered with, so moving the source here is what makes its next write a
 * conflict rather than a silent overwrite of somebody else's edit.
 * `/fixture/canonical-source/apply-failure` arms the projection apply to fail
 * after the canonical source was saved -- the state the Runtime reports
 * separately, because the source was written and the projections were not.
 * `/fixture/canonical-source/reset` puts the sources back, so a test that
 * writes starts from the sources the fixture declares.
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
  if (action === "apply-failure") {
    armCanonicalSourceApplyFailure(kind);
    sendJson(response, { kind, armed: true });
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
 * The fixture's own control routes and the catalog resources it answers.
 *
 * One dispatch from the request handler rather than two, so the handler
 * stays within the complexity budget it was written to.
 */
function handleFixtureCatalogRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): boolean {
  if (configureSkillFixture(request, response, url)) return true;
  if (configureCanonicalSourceFixture(request, response, url)) return true;
  if (handleRuntimeFixture(request, response, url)) return true;
  if (handleGithubRead(request, response, url)) return true;
  if (handleMemoryRead(request, response, url)) return true;
  if (handleEvaluationsRead(url, response)) return true;
  return handleCatalogResourceRead(url, response);
}

/**
 * The fixture's own write routes.
 *
 * One dispatch for the writes, so the request handler stays within the
 * complexity budget it was written to. Each of these answers a route that the
 * read-only guard would otherwise reject with a bare 405 -- which reads as a
 * route that does not exist.
 */
async function handleSyntheticMutationRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (await handleSyntheticWorkspaceApproval(request, response, url.pathname)) {
    return true;
  }
  if (await handleSyntheticAnalysisMutation(request, response, url))
    return true;
  if (await handleSyntheticRunMutation(request, response, url)) return true;
  if (handleSyntheticReadinessInitialization(request, response, url))
    return true;
  if (await handleSyntheticSkillRoleMutation(request, response, url))
    return true;
  if (await handleAgentEnablementMutation(request, response, url)) return true;
  if (await handleCanonicalSourceMutation(request, response, url)) return true;
  return configureAgentEnablementFixture(request, response, url);
}

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200).end("ok");
      return;
    }
    if (resetSyntheticFixture(request, response)) return;
    if (configureReadinessFixture(url, response)) return;
    if (handleSyntheticReadFailureConfiguration(url, response)) return;
    if (await handleSyntheticMutationRoutes(request, response, url)) return;
    // The catalog and the fixture's own control routes are answered before the
    // read-only guard: one of them is a write, and a write that the guard
    // rejects with a bare 405 is a route that does not exist.
    if (handleFixtureCatalogRoutes(request, response, url)) return;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/control/workspaces") {
      sendJson(response, {
        schema: "autodev-control-workspaces-v2",
        source: "fixture",
        readOnly: true,
        catalogStatus: "valid",
        totalWorkspaces: 1,
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: true,
            agentRoles: null,
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
        roles: {
          default: { priority: 1, model, mutable: true, convergence },
          smart: { priority: 1, model, mutable: true, convergence },
          orchestrator: { priority: 2, model, mutable: true, convergence },
          subagent: { priority: 1, model, mutable: true, convergence }
        },
        agentLimits: null,
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
        schema: "autodev-control-providers-v3",
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
    if (url.pathname === "/control/tools") {
      sendJson(response, {
        schema: "autodev-control-tools-v2",
        source: "synthetic-tools-fixture",
        readOnly: true,
        coverage: "complete",
        validity: "valid",
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
    if (handleSyntheticRunRead(request, response, url)) return;
    if (handleSyntheticPlaytestingRead(response, url)) return;
    response.writeHead(404).end();
  }
);
server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
