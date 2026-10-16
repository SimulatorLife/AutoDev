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
  CONTROL_API_CONTRACT,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  playtestAssignmentManifestHashInput,
  type PlaytestComparison,
  playtestCoverageManifestHashInput,
  type PlaytestCrossSessionSynthesis,
  playtestFindingIdentityHashInput,
  playtestReviewOutcomeKey,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  recordPlaytestOwnerDecision,
  selectPlaytestBatchReviews
} from "@simulatorlife/autodev-core";

const PORT = Number(process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? 4311);
const WORKSPACE_ID = "fixture/game";
const BUILD_SHA = "a".repeat(40);
const MEASUREMENT_VERSION = "measurement-v1";
const RUBRIC_HASH = "d".repeat(64);
const FIXTURE_TIMESTAMP = "2026-10-10T00:00:00.000Z";
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
  schema: "autodev-playtest-episode-v4",
  episodeId: "episode-17",
  revision: 1,
  batchId: "batch-3",
  assignmentId: "a-0017",
  branchLineage: null,
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
      guardrailStatus: "not-applicable",
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
const syntheticRuns = new Map<string, SyntheticRun>();
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
  const rawAssignments = value.assignments;
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
  return { assignments };
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

async function handleSyntheticRunMutation(
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
  if (
    url.pathname === "/control/playtesting/runs" &&
    request.method === "POST"
  ) {
    const runRequest = activeSyntheticRunRequest(await readJsonBody(request));
    if (!runRequest) {
      response.writeHead(400).end();
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
      const episodeId = `episode-${batchId}-${assignment.assignmentId}`;
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
      createdAt,
      assignments: runRequest.assignments,
      assignmentCount: runRequest.assignments.length,
      manifestHash,
      reviewSelection: selectedReview,
      episodes,
      status: "running",
      cancellationRequested: false
    });
    sendJson(
      response,
      {
        schema: "autodev-control-playtesting-run-started-v1",
        workspaceId: WORKSPACE_ID,
        batchId,
        assignmentCount: runRequest.assignments.length,
        createdAt,
        status: "running"
      },
      202
    );
    return true;
  }

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
    schema: "autodev-control-playtesting-capabilities-v1",
    workspaceId: WORKSPACE_ID,
    workspaceCatalog: "valid",
    workspaceEnabled: true,
    operatorActionsAvailable: true,
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

function handleSyntheticRunRead(response: ServerResponse, url: URL): boolean {
  if (url.pathname === "/control/playtesting/capabilities") {
    sendSyntheticCapabilities(response);
    return true;
  }
  if (url.pathname === "/control/playtesting/runs") {
    // Like the Runtime, a batch progresses regardless of which read observes
    // it; the active list then omits it once it is terminal.
    for (const run of syntheticRuns.values()) completeSyntheticRunIfReady(run);
    const runs = [...syntheticRuns.entries()]
      .filter(
        ([, run]) =>
          run.workspaceId === WORKSPACE_ID && run.status === "running"
      )
      .map(([batchId, run]) => ({
        batchId,
        assignmentCount: run.assignmentCount,
        createdAt: run.createdAt,
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
      schema: "autodev-control-playtesting-runs-v1",
      workspaceId: WORKSPACE_ID,
      runs
    });
    return true;
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
  if (episodeId === loopGuardEpisode.episodeId) return loopGuardEpisode;
  return syntheticRunEpisodes.get(episodeId);
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
  if (url.pathname === "/control/playtesting/comparisons") {
    sendJson(response, page("comparisons", [comparison], 1));
    return true;
  }
  const episodeMatch = url.pathname.match(PLAYTEST_EPISODE_DETAIL_ROUTE);
  if (episodeMatch) {
    const episodeId = decodeURIComponent(episodeMatch[1]!);
    const record = syntheticEpisodeFor(episodeId);
    if (!record) {
      sendJson(response, { error: "Not found" }, 404);
      return true;
    }
    sendJson(response, {
      schema: "autodev-control-playtesting-detail-v1",
      workspaceId: WORKSPACE_ID,
      resource: "episode",
      readOnly: true,
      record,
      latestReview:
        episodeId === episode.episodeId
          ? latestReview
          : (syntheticRunReviews.get(episodeId) ?? null)
    });
    return true;
  }
  const windowMatch = url.pathname.match(PLAYTEST_EPISODE_WINDOW_ROUTE);
  if (windowMatch) {
    const episodeId = decodeURIComponent(windowMatch[1]!);
    const artifactId = decodeURIComponent(windowMatch[2]!);
    const record = syntheticEpisodeFor(episodeId);
    if (!record || artifactId !== TRACE_ID) {
      response.writeHead(404).end();
      return true;
    }
    const startStep = Number(url.searchParams.get("startStep"));
    const endStep = Number(url.searchParams.get("endStep"));
    sendJson(response, {
      schema: "autodev-control-playtesting-window-v1",
      workspaceId: WORKSPACE_ID,
      episodeId,
      artifactId,
      sha256: "b".repeat(64),
      mediaType: "application/x-ndjson",
      startStep,
      endStep,
      sourceLineCount: 3,
      omittedLineCount: 0,
      entries: [
        { type: "step", step: 0, state: { room: "start" }, actionId: "look" },
        {
          type: "event",
          event: { step: 1, eventId: "event-1", type: "warning-shown" }
        },
        {
          type: "event",
          event: { step: 2, eventId: "event-2", type: "legal-action-noop" }
        },
        {
          step: 3,
          selectedActionId: "advance-segment",
          observationHash: "c".repeat(16),
          visibleObservation: { phaseId: "race_and_energy" },
          executed: false,
          events: []
        }
      ].filter(
        (entry) =>
          entry.step === undefined ||
          (entry.step >= startStep && entry.step <= endStep)
      )
    });
    return true;
  }
  if (
    url.pathname ===
    `/control/playtesting/episodes/${episode.episodeId}/media/${FRAME_ID}`
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
  syntheticRunEpisodes.clear();
  syntheticRunReviews.clear();
  syntheticAnalystRuns.clear();
  nextRunId = 1;
  nextAnalystRunId = 1;
  syntheticRunsReadFails = false;
  syntheticReadinessPendingPolls = 0;
  syntheticReadinessPollCount = 0;
  syntheticReadinessUnavailable = false;
  syntheticAnalystRunsReadFails = false;
  syntheticAnalystTaskHistoryMissing = false;
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

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200).end("ok");
      return;
    }
    if (resetSyntheticFixture(request, response)) return;
    if (configureReadinessFixture(url, response)) return;
    if (url.pathname === "/fixture/runs-read-fail") {
      syntheticRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, { syntheticRunsReadFails });
      return;
    }
    if (url.pathname === "/fixture/analyses-read-fail") {
      syntheticAnalystRunsReadFails = url.searchParams.get("mode") !== "off";
      sendJson(response, { syntheticAnalystRunsReadFails });
      return;
    }
    if (url.pathname === "/fixture/analyst-history") {
      syntheticAnalystTaskHistoryMissing =
        url.searchParams.get("mode") === "missing";
      sendJson(response, { syntheticAnalystTaskHistoryMissing });
      return;
    }
    if (
      await handleSyntheticWorkspaceApproval(request, response, url.pathname)
    ) {
      return;
    }
    if (await handleSyntheticAnalysisMutation(request, response, url)) return;
    if (await handleSyntheticRunMutation(request, response, url)) return;
    if (handleSyntheticReadinessInitialization(request, response, url)) return;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === "/control/workspaces") {
      sendJson(response, {
        schema: "autodev-control-workspaces-v1",
        source: "fixture",
        readOnly: true,
        catalogStatus: "valid",
        totalWorkspaces: 1,
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      });
      return;
    }
    if (url.pathname === "/control/contracts") {
      sendJson(response, {
        schema: "autodev-control-api-contract-v1",
        version: CONTROL_API_CONTRACT.version
      });
      return;
    }
    if (url.pathname === "/control/providers") {
      const convergence = {
        convergence: "not-observed",
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
        health: null
      });
      sendJson(response, {
        schema: "autodev-control-providers-v2",
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
        convergence: "not-observed",
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
    if (handleSyntheticRunRead(response, url)) return;
    if (handleSyntheticPlaytestingRead(response, url)) return;
    response.writeHead(404).end();
  }
);
server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
