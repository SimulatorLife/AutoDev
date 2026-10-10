/** Deterministic, explicitly synthetic Control API fixture for browser usability tests. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

const PORT = Number(process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? 4311);
const WORKSPACE_ID = "fixture/game";
const BUILD_SHA = "a".repeat(40);
const MEASUREMENT_VERSION = "measurement-v1";
const FIXTURE_TIMESTAMP = "2026-10-10T00:00:00.000Z";
const TRACE_ID = "trace-window-1";
const FRAME_ID = "frame-1";
const FRAME_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4nQAAAAASUVORK5CYII=",
  "base64"
);

const counts = {
  assigned: 1,
  started: 1,
  completed: 1,
  crashed: 0,
  infrastructureFailed: 0,
  cancelled: 0,
  budgetTruncated: 0,
  reviewed: 0,
  eligible: 2
} as const;

const episode = {
  schema: "autodev-playtest-episode-v1",
  episodeId: "episode-17",
  revision: 1,
  batchId: "batch-3",
  identity: {
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    gameBuild: "fixture-build-1",
    scenarioId: "tutorial",
    configHash: "config-hash",
    seed: "seed-17",
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
      numerator: 0,
      denominator: 3,
      coverage: 1,
      unit: "proportion",
      estimate: 0,
      missing: 0,
      missingReasons: [],
      independentUnits: 1,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: BUILD_SHA,
        measurementVersion: MEASUREMENT_VERSION,
        generatedAt: FIXTURE_TIMESTAMP
      },
      notes: "Synthetic fixture metric; not a real game result."
    }
  ],
  findingIds: ["finding-1"],
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

const batch = {
  schema: "autodev-playtest-batch-v1",
  batchId: "batch-3",
  revision: 1,
  workspaceId: WORKSPACE_ID,
  repository: WORKSPACE_ID,
  buildSha: BUILD_SHA,
  gameBuild: "fixture-build-1",
  configHash: "config-hash",
  rubricHash: "rubric-hash",
  actionSchemaHash: "action-hash",
  observationSchemaHash: "obs-hash",
  eventSchemaHash: "event-hash",
  measurementVersion: MEASUREMENT_VERSION,
  protocolVersion: 1,
  policyIds: ["weak-bot"],
  cohortIds: ["novice"],
  scenarioIds: ["tutorial"],
  samplingPlan: null,
  status: "completed",
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
  findingId: "finding-1",
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

const comparison = {
  schema: "autodev-playtest-comparison-v1",
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
  sourceFindingIds: ["finding-1"],
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
  humanPreference: { answer: "not-collected", interval: null },
  provenance: {
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    measurementVersion: MEASUREMENT_VERSION,
    generatedAt: FIXTURE_TIMESTAMP
  },
  notes: "Synthetic UI fixture; no comparison of real game builds."
};

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
const syntheticRuns = new Map<
  string,
  {
    readonly workspaceId: string;
    readonly scenario: string;
    readonly policy: string;
    readonly seed: string;
    status: "running" | "completed" | "cancelled";
    cancellationRequested: boolean;
  }
>();

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
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: WORKSPACE_ID,
    revision: priorRevision + 1,
    approvalId: "synthetic-approval-1",
    checkoutRoot: body.checkoutRoot,
    buildSha: body.buildSha,
    gameBuild: body.gameBuild,
    playtestConfigHash: body.playtestConfigHash,
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

function activeSyntheticRunRequest(value: Record<string, unknown> | null): {
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
} | null {
  if (!value || !workspaceApproval || workspaceApproval.revokedAt !== null)
    return null;
  const limits = workspaceApproval.limits as
    Record<string, unknown> | undefined;
  const scenarios = workspaceApproval.allowedScenarios;
  const policies = workspaceApproval.allowedPolicies;
  if (
    value.workspaceId !== WORKSPACE_ID ||
    typeof value.scenario !== "string" ||
    !Array.isArray(scenarios) ||
    !scenarios.includes(value.scenario) ||
    value.policy !== "random" ||
    !Array.isArray(policies) ||
    !policies.includes(value.policy) ||
    typeof value.seed !== "string" ||
    value.seed.length === 0 ||
    value.seed.length > 256 ||
    !limits ||
    typeof value.maxSteps !== "number" ||
    !Number.isSafeInteger(value.maxSteps) ||
    value.maxSteps < 1 ||
    value.maxSteps > Number(limits.maxStepsPerEpisode)
  ) {
    return null;
  }
  return {
    scenario: value.scenario,
    policy: value.policy,
    seed: value.seed
  };
}

async function handleSyntheticRunMutation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
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
    syntheticRuns.set(batchId, {
      workspaceId: WORKSPACE_ID,
      ...runRequest,
      status: "running",
      cancellationRequested: false
    });
    sendJson(
      response,
      {
        schema: "autodev-control-playtesting-run-started-v1",
        workspaceId: WORKSPACE_ID,
        batchId,
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
    buildSha: approved ? workspaceApproval.buildSha : null,
    gameBuild: approved ? workspaceApproval.gameBuild : null,
    allowedScenarios: scenarios,
    approvedPolicies: policies,
    supportedPolicies: ["random"],
    runnablePolicies: runnableAssignments.length > 0 ? ["random"] : [],
    unsupportedApprovedPolicies: policies.filter(
      (policy) => policy !== "random"
    ),
    configurationStatus: approved ? "validated" : "not-checked",
    runnableAssignments,
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

function sendSyntheticRunStatus(
  response: ServerResponse,
  batchId: string
): boolean {
  const run = syntheticRuns.get(batchId);
  if (!run) {
    response.writeHead(404).end();
    return true;
  }
  if (run.status === "running" && run.seed !== "hold") run.status = "completed";
  sendJson(response, {
    schema: "autodev-control-playtesting-run-status-v1",
    workspaceId: WORKSPACE_ID,
    run: {
      batchId,
      status: run.status,
      cancellationReason: run.status === "cancelled" ? "cancelled" : null,
      result:
        run.status === "completed"
          ? { episodeId: episode.episodeId, outcome: episode.outcome }
          : null,
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
    const runs = [...syntheticRuns.entries()]
      .filter(
        ([, run]) =>
          run.workspaceId === WORKSPACE_ID && run.status === "running"
      )
      .map(([batchId, run]) => ({
        batchId,
        scenarioId: run.scenario,
        createdAt: FIXTURE_TIMESTAMP
      }));
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

function handleSyntheticPlaytestingRead(
  response: ServerResponse,
  url: URL
): boolean {
  if (url.pathname === "/control/playtesting/batches") {
    sendJson(response, page("batches", [batch], 1));
    return true;
  }
  if (url.pathname === "/control/playtesting/episodes") {
    sendJson(response, page("episodes", [episode], 1));
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
  if (url.pathname === `/control/playtesting/episodes/${episode.episodeId}`) {
    sendJson(response, {
      schema: "autodev-control-playtesting-detail-v1",
      workspaceId: WORKSPACE_ID,
      resource: "episode",
      readOnly: true,
      record: episode,
      latestReview: null
    });
    return true;
  }
  if (
    url.pathname ===
    `/control/playtesting/episodes/${episode.episodeId}/windows/${TRACE_ID}`
  ) {
    sendJson(response, {
      schema: "autodev-control-playtesting-window-v1",
      workspaceId: WORKSPACE_ID,
      episodeId: episode.episodeId,
      artifactId: TRACE_ID,
      sha256: "b".repeat(64),
      mediaType: "application/x-ndjson",
      startStep: Number(url.searchParams.get("startStep")),
      endStep: Number(url.searchParams.get("endStep")),
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
        }
      ].filter(
        (entry) =>
          entry.step === undefined ||
          (entry.step >= Number(url.searchParams.get("startStep")) &&
            entry.step <= Number(url.searchParams.get("endStep")))
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

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      response.writeHead(200).end("ok");
      return;
    }
    if (
      await handleSyntheticWorkspaceApproval(request, response, url.pathname)
    ) {
      return;
    }
    if (await handleSyntheticRunMutation(request, response, url)) return;
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
