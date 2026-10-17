import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type ControlApiPlaytestingHumanValidationResponse,
  type HumanPlaytestStudy,
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestLaunchRequest,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import {
  PlaytestInvalidCursorError,
  PlaytestSourceUnavailableError,
  RestrictedHumanResponseRepository
} from "@simulatorlife/autodev-data/playtesting";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import {
  handleControlApiRequest,
  warmupDefaultPlaytestingRepository
} from "../src/control-api/index.ts";
import {
  handlePlaytestingControlApiRequest,
  type PlaytestingReadRepository
} from "../src/control-api/playtesting.ts";
import type { PlaytestingHumanStudyRepository } from "../src/control-api/playtesting-human-studies.ts";
import {
  handlePlaytestingRunControlRequest,
  type PlaytestingRunControlApiOptions
} from "../src/control-api/playtesting-run-control.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import { PlaytestSandboxUnavailableError } from "../src/playtesting/docker-sandbox.ts";
import {
  type PlaytestAnalystReviewDispatch,
  type PlaytestAnalystReviewRun,
  type PlaytestCrossSessionPacket,
  PlaytestMcpConflictError,
  type PlaytestRunCapabilities,
  type PlaytestRunControl
} from "../src/playtesting/mcp.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

let launchRequestCounter = 0;

function nextLaunchRequestId(): string {
  launchRequestCounter += 1;
  return `api-test-request-${String(launchRequestCounter)}`;
}

function batchLaunch(input: {
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly capabilityRevision?: string;
  readonly assignments: readonly {
    readonly scenario: string;
    readonly policy: string;
    readonly seed: string;
    readonly goal?: string;
    readonly maxSteps?: number;
  }[];
}): PlaytestLaunchRequest {
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: input.workspaceId ?? WORKSPACE,
    requestId: input.requestId ?? nextLaunchRequestId(),
    capabilityRevision: input.capabilityRevision ?? "c".repeat(64),
    operation: { kind: "batch", assignments: input.assignments }
  };
}

function branchLaunch(input: {
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly capabilityRevision?: string;
  readonly parentEpisodeId: string;
  readonly branchStep: number;
  readonly alternativeActionId: string;
  readonly policy?: string;
  readonly maxSteps?: number;
}): PlaytestLaunchRequest {
  const { workspaceId, requestId, capabilityRevision, ...operation } = input;
  return {
    schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
    mode: "adapter-accelerated",
    workspaceId: workspaceId ?? WORKSPACE,
    requestId: requestId ?? nextLaunchRequestId(),
    capabilityRevision: capabilityRevision ?? "c".repeat(64),
    operation: { kind: "branch", ...operation }
  };
}

const WORKSPACE = "fixture/game";

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: { host: "127.0.0.1" }
  }) as IncomingMessage;
}

function catalog() {
  return {
    status: "valid" as const,
    workspaces: [
      {
        id: WORKSPACE,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  };
}

function readRepository(
  overrides: Partial<PlaytestingReadRepository> = {}
): PlaytestingReadRepository {
  const empty = async () => ({ rows: [], total: 0, nextCursor: null });
  return {
    listBatches: empty,
    listEpisodes: empty,
    listFindings: empty,
    listComparisons: empty,
    listBenchmarks: empty,
    listExperiments: empty,
    listHumanStudies: empty,
    getEpisode: async () => null,
    getLatestReviewForEpisode: async () => null,
    ...overrides
  } as unknown as PlaytestingReadRepository;
}

async function call(
  method: string,
  url: string,
  options: Parameters<typeof handlePlaytestingControlApiRequest>[4] = {},
  actor?: { actor: string; role: "viewer" | "operator" }
): Promise<{
  readonly status: number;
  readonly headers: Record<string, string | number>;
  readonly body: Record<string, unknown>;
}> {
  const response = responseRecorder();
  await handlePlaytestingControlApiRequest(
    request(method, url),
    response as unknown as ServerResponse,
    new URL(url, "http://127.0.0.1").pathname,
    actor ?? { actor: "console-viewer", role: "viewer" },
    { readWorkspaceCatalog: catalog, repository: readRepository(), ...options }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body ?? "{}") as Record<string, unknown>
  };
}

function runRequest(
  method: string,
  url: string,
  body?: unknown
): IncomingMessage {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers:
      body === undefined
        ? { host: "127.0.0.1" }
        : {
            host: "127.0.0.1",
            "content-type": "application/json"
          }
  }) as IncomingMessage;
}

async function callRunControl(
  method: string,
  url: string,
  actor: { actor: string; role: "viewer" | "operator" },
  options: PlaytestingRunControlApiOptions,
  body?: unknown
): Promise<{
  status: number;
  headers: Record<string, string | number>;
  body: Record<string, unknown>;
}> {
  const response = responseRecorder();
  await handlePlaytestingRunControlRequest(
    runRequest(method, url, body),
    response as unknown as ServerResponse,
    new URL(url, "http://127.0.0.1").pathname,
    actor,
    {
      readWorkspaceCatalog: catalog,
      visualTargetRepository: { list: () => [] },
      ...options
    }
  );
  return {
    status: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>
  };
}

function runControlFixture(
  calls: unknown[] = []
): PlaytestRunControl & Partial<PlaytestAnalystReviewDispatch> {
  const launchReceipts = new Map<
    string,
    {
      readonly batchId: string;
      readonly assignmentCount: number;
      readonly assignmentIds: readonly string[];
      readonly createdAt: string;
      readonly status: "running";
    }
  >();
  return {
    async recordComparisonDecision() {
      throw new Error(
        "Owner-decision route is not used by this run-only fixture."
      );
    },
    getCapabilities: async (
      session,
      workspaceId
    ): Promise<PlaytestRunCapabilities> => {
      calls.push({ operation: "capabilities", session, workspaceId });
      return {
        workspaceId,
        workspaceEnabled: true,
        workspaceCatalog: "valid",
        approved: true,
        approvalRevision: 1,
        buildSha: "a".repeat(40),
        gameBuild: "fixture-build",
        allowedScenarios: ["tutorial"],
        approvedPolicies: ["random"],
        supportedPolicies: ["random"],
        runnablePolicies: ["random"],
        unsupportedApprovedPolicies: [],
        configurationStatus: "validated",
        maxBatchAssignments: 10,
        runnableAssignments: [
          {
            scenarioId: "tutorial",
            scenarioFamily: "tutorial",
            policyId: "random",
            policyVersion: "hmac-sha256-v1",
            cohort: "exploratory",
            strategy: "uniform-legal-action",
            maxStepsPerEpisode: 20
          }
        ],
        admissibleSeeds: null,
        policyProfiles: [
          {
            policyId: "random",
            version: "hmac-sha256-v1",
            cohort: "exploratory",
            strategy: "uniform-legal-action"
          }
        ],
        limits: {
          cpuCores: 1,
          memoryBytes: 64 * 1024 * 1024,
          processCount: 8,
          wallTimeMs: 60_000,
          artifactBytes: 1024 * 1024,
          workerCount: 1,
          episodeCount: 10,
          maxStepsPerEpisode: 20,
          critiqueCount: 0
        },
        issueReporting: "disabled",
        configuredIssueReporting: "disabled",
        humanStudyAllowed: false,
        revokedAt: null,
        runPreflight: "required-at-start"
      };
    },
    startRun: async (session, payload) => {
      calls.push({ operation: "start", session, request: payload });
      const assignmentCount =
        payload.mode === "adapter-accelerated" &&
        payload.operation.kind === "batch"
          ? payload.operation.assignments.length
          : 1;
      const receipt = {
        batchId: "batch-run-1",
        assignmentCount,
        assignmentIds: Array.from(
          { length: assignmentCount },
          (_, index) => `a-${String(index + 1).padStart(4, "0")}`
        ),
        createdAt: "2026-10-15T00:00:00.000Z",
        status: "running" as const
      };
      launchReceipts.set(payload.requestId, receipt);
      return receipt;
    },
    async lookupRunByRequest(_session, _workspaceId, requestId) {
      calls.push({ operation: "request-lookup", requestId });
      const receipt = launchReceipts.get(requestId);
      return {
        requestId,
        state: receipt ? "accepted" : "not-found",
        batchId: receipt?.batchId ?? null,
        assignmentCount: receipt?.assignmentCount ?? null,
        assignmentIds: receipt?.assignmentIds ?? [],
        createdAt: receipt?.createdAt ?? null,
        status: receipt?.status ?? null
      };
    },
    listAnalystReviewRuns: (session, workspaceId) => {
      calls.push({ operation: "analyst-status", session, workspaceId });
      return Promise.resolve({ runs: [], syntheses: [] });
    },
    dispatchCrossSessionReview: async (session, workspaceId, episodeIds) => {
      calls.push({
        operation: "analyst-dispatch",
        session,
        workspaceId,
        episodeIds: [...episodeIds]
      });
      const packets = episodeIds.map(
        (episodeId, index) =>
          ({
            episodeId,
            batchId: "batch-1",
            packet: {
              packetId: index === 0 ? "packet-a" : `packet-${index + 1}`
            },
            artifact: {
              artifactId: `artifact-${index + 1}`,
              sha256: "a".repeat(64),
              bytes: 1,
              mediaType: "application/json"
            }
          }) as unknown as PlaytestCrossSessionPacket
      );
      const run = {
        analysisId: "analysis-1",
        workspaceId,
        status: "running",
        createdAt: "2026-10-14T00:00:00.000Z",
        finishedAt: null,
        requestedEpisodeIds: [...episodeIds],
        packets: packets.map((packet) => ({
          episodeId: packet.episodeId,
          batchId: packet.batchId,
          packetId: packet.packet.packetId
        })),
        receipts: [],
        budget: [],
        reviews: [],
        synthesisId: null,
        error: null
      } as PlaytestAnalystReviewRun;
      return { run, packets, receipts: [], budget: [] };
    },
    prepareCrossSessionReview: async (
      session: { role: string },
      workspaceId: string,
      episodeIds: readonly string[]
    ) => {
      calls.push({
        operation: "cross-session",
        session,
        workspaceId,
        episodeIds: [...episodeIds]
      });
      return { packets: [], receipts: [], budget: [] };
    },
    listActiveRuns: (session, workspaceId) => {
      calls.push({ operation: "list", session, workspaceId });
      return [
        {
          batchId: "batch-run-1",
          assignmentCount: 1,
          createdAt: "2026-10-10T00:00:00.000Z",
          status: {
            batchId: "batch-run-1",
            status: "running",
            cancellationReason: null,
            result: null,
            error: null
          }
        }
      ];
    },
    cancelRun: (session, workspaceId, batchId) => {
      calls.push({ operation: "cancel", session, workspaceId, batchId });
      return { batchId, cancellationRequested: true };
    },
    waitForRun: async (session, workspaceId, batchId, waitMs) => {
      calls.push({ operation: "wait", session, workspaceId, batchId, waitMs });
      return {
        batchId,
        status: "completed",
        cancellationReason: null,
        result: {
          batchId: "batch-run-1",
          assignmentCount: 1,
          outcomes: [
            {
              assignmentId: "a-0001",
              episodeId: "episode-1",
              state: "completed",
              started: true,
              eligible: true
            }
          ]
        },
        error: null
      };
    }
  };
}

test("Control API branch requests use the shared approved run owner and reject malformed bounds", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls)
  };
  const operator = { actor: "operator-branch", role: "operator" as const };
  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  const capabilityRevision = String(capabilities.body.capabilityRevision);
  const requestId = "api-branch-request-1";
  const stale = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    batchLaunch({
      workspaceId: WORKSPACE,
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "seed-1", maxSteps: 20 }
      ]
    })
  );
  assert.equal(stale.status, 409);
  assert.equal(
    (stale.body.error as { readonly code: string }).code,
    "autodev_control_playtesting_capability_revision_changed"
  );
  const started = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    branchLaunch({
      workspaceId: WORKSPACE,
      requestId,
      capabilityRevision,
      parentEpisodeId: "episode-parent",
      branchStep: 7,
      alternativeActionId: "cool-down",
      policy: "random",
      maxSteps: 12
    })
  );
  assert.equal(started.status, 202);
  assert.equal(started.body.assignmentCount, 1);
  const delegatedBranch = calls.find(
    (entry) => (entry as { operation?: string }).operation === "start"
  ) as { readonly request: unknown } | undefined;
  assert.deepEqual(
    delegatedBranch?.request,
    branchLaunch({
      workspaceId: WORKSPACE,
      requestId,
      capabilityRevision,
      parentEpisodeId: "episode-parent",
      branchStep: 7,
      alternativeActionId: "cool-down",
      policy: "random",
      maxSteps: 12
    })
  );
  const invalid = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    branchLaunch({
      workspaceId: WORKSPACE,
      parentEpisodeId: "episode-parent",
      branchStep: 100_000,
      alternativeActionId: "cool-down"
    })
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    calls.filter(
      (entry) => (entry as { operation?: string }).operation === "start"
    ).length,
    1
  );
});

test("Control API comparison decisions are operator-authorized and delegate to the shared owner", async () => {
  const calls: unknown[] = [];
  const storedDecision = {
    schema: "autodev-playtest-comparison-v2",
    comparisonId: "comparison-1",
    version: 2,
    benchmarkId: "benchmark-1",
    experimentId: "experiment-1",
    baseline: { id: "build-a", version: 1 },
    candidate: { id: "build-b", version: 1 },
    freezeStatus: "frozen",
    pairing: {
      mode: "paired-initial-condition",
      pairMap: {},
      allocationPlanHash: null,
      rngAlgorithm: null,
      rngStreamVersion: null,
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: [],
    episodeRefs: [],
    measurementVersion: "fixture-v1",
    metrics: [],
    decision: "hold-inconclusive",
    ownerDecisionAt: "2026-10-12T12:00:00.000Z",
    ownerDecisionReason: "Wait for confirmation.",
    ownerDecisionBy: "operator-1",
    ownerDisposition: "hold",
    humanPreference: { answer: "not-collected", interval: null },
    provenance: {
      workspaceId: WORKSPACE,
      measurementVersion: "fixture-v1",
      generatedAt: "2026-10-12T12:00:00.000Z"
    },
    notes: ""
  } as unknown as PlaytestComparison;
  const baseOwner = runControlFixture(calls);
  const runControl: PlaytestRunControl = {
    ...baseOwner,
    async recordComparisonDecision(
      session,
      workspaceId,
      comparisonId,
      expectedVersion,
      disposition,
      reason
    ) {
      calls.push({
        operation: "comparison-decision",
        session,
        workspaceId,
        comparisonId,
        expectedVersion,
        disposition,
        reason
      });
      return storedDecision;
    }
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const options: PlaytestingRunControlApiOptions = { runControl };
  const result = await callRunControl(
    "POST",
    "/control/playtesting/comparisons/comparison-1/decision",
    operator,
    options,
    {
      workspaceId: WORKSPACE,
      comparisonId: "comparison-1",
      expectedVersion: 1,
      disposition: "hold",
      reason: "Wait for confirmation."
    }
  );
  assert.equal(result.status, 200);
  assert.equal(
    result.body.schema,
    "autodev-control-playtesting-comparison-decision-v1"
  );
  assert.deepEqual(calls[0], {
    operation: "comparison-decision",
    session: {
      workspaceId: WORKSPACE,
      role: "operator",
      actor:
        "control-api:" +
        createHash("sha256").update(operator.actor).digest("hex")
    },
    workspaceId: WORKSPACE,
    comparisonId: "comparison-1",
    expectedVersion: 1,
    disposition: "hold",
    reason: "Wait for confirmation."
  });

  const denied = await callRunControl(
    "POST",
    "/control/playtesting/comparisons/comparison-1/decision",
    { actor: "viewer-1", role: "viewer" },
    options,
    {
      workspaceId: WORKSPACE,
      expectedVersion: 1,
      disposition: "hold",
      reason: "Not authorized."
    }
  );
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 1);
});

test("capabilities expose approved visual targets without claiming an uninstalled driver is ready", async () => {
  const runControl = runControlFixture();
  const target: WorkspaceVisualPlaytestTargetApproval = {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE,
    targetId: "racing-game-local",
    revision: 1,
    approvalId: "approval-visual-racing",
    name: "RacingGame local browser",
    entryUrl: "http://localhost:5173/",
    allowedOrigins: ["http://localhost:5173"],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 80,
      wallTimeMs: 120_000,
      smartRequestsPerEpisode: 30,
      smartTokensPerEpisode: 25_000,
      screenshotCountPerEpisode: 160,
      artifactBytesPerEpisode: 64 * 1024 * 1024
    },
    approvedAt: "2026-10-16T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
  const revokedTarget: WorkspaceVisualPlaytestTargetApproval = {
    ...target,
    targetId: "old-racing-game-local",
    approvalId: "approval-visual-racing-old",
    name: "Revoked RacingGame target",
    revision: 2,
    revokedAt: "2026-10-17T00:00:00.000Z",
    revokedBy: "operator-1",
    revocationReason: "Approval withdrawn."
  };
  const continuousTarget: WorkspaceVisualPlaytestTargetApproval = {
    ...target,
    targetId: "continuous-game-local",
    approvalId: "approval-visual-continuous",
    name: "Continuous browser game",
    controlTimingClass: "continuous"
  };
  const gatedTarget: WorkspaceVisualPlaytestTargetApproval = {
    ...target,
    targetId: "gated-game-local",
    approvalId: "approval-visual-gated",
    name: "Gated browser game",
    entryRequirements: "consent-or-age-screen"
  };
  const response = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "viewer-1", role: "viewer" },
    {
      runControl,
      visualTargetRepository: {
        list: () => [target, continuousTarget, gatedTarget, revokedTarget]
      }
    }
  );
  assert.equal(response.status, 200);
  assert.match(String(response.body.capabilityRevision), /^[a-f\d]{64}$/u);
  const modes = response.body.modeReadiness as {
    readonly "adapter-accelerated": { readonly status: string };
    readonly "autonomous-visual": {
      readonly status: string;
      readonly targetStore: string;
      readonly targets: readonly {
        readonly target: WorkspaceVisualPlaytestTargetApproval;
        readonly eligibility: string;
        readonly reasons: readonly { readonly code: string }[];
      }[];
      readonly reasons: readonly { readonly code: string }[];
    };
  };
  assert.equal(modes["adapter-accelerated"].status, "check-required");
  assert.equal(modes["autonomous-visual"].targetStore, "available");
  assert.equal(modes["autonomous-visual"].status, "check-required");
  assert.deepEqual(
    modes["autonomous-visual"].targets.map((entry) => entry.target.targetId),
    ["racing-game-local", "continuous-game-local", "gated-game-local"]
  );
  assert.deepEqual(
    modes["autonomous-visual"].targets.map((entry) => entry.eligibility),
    ["supported", "unsupported", "unsupported"]
  );
  assert.deepEqual(
    modes["autonomous-visual"].targets[0]?.reasons,
    [],
    "an unsupported sibling target does not poison the supported target"
  );
  assert.ok(
    modes["autonomous-visual"].targets[1]?.reasons.some(
      (reason) => reason.code === "visual-control-timing-unsupported"
    )
  );
  assert.ok(
    modes["autonomous-visual"].targets[2]?.reasons.some(
      (reason) => reason.code === "visual-target-setup-required"
    )
  );
  assert.ok(
    !modes["autonomous-visual"].reasons.some(
      (reason) =>
        reason.code === "visual-control-timing-unsupported" ||
        reason.code === "visual-target-setup-required"
    ),
    "target-local limitations are not reported as workspace-wide blockers"
  );
  assert.ok(
    !modes["autonomous-visual"].reasons.some(
      (reason) => reason.code === "visual-driver-unavailable"
    )
  );
  assert.ok(
    !modes["autonomous-visual"].reasons.some(
      (reason) => reason.code === "smart-direct-policy-unavailable"
    )
  );

  const operatorResponse = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "operator-1", role: "operator" },
    {
      runControl,
      visualTargetRepository: {
        list: () => [target, continuousTarget, gatedTarget]
      }
    }
  );
  assert.equal(operatorResponse.status, 200);
  const operatorModes = operatorResponse.body.modeReadiness as {
    readonly "autonomous-visual": { readonly status: string; readonly reasons: readonly unknown[] };
  };
  assert.equal(operatorModes["autonomous-visual"].status, "ready");
  assert.deepEqual(operatorModes["autonomous-visual"].reasons, []);

  const noEligibleTarget = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "viewer-1", role: "viewer" },
    {
      runControl,
      visualTargetRepository: {
        list: () => [continuousTarget, gatedTarget]
      }
    }
  );
  const noEligibleReadiness = noEligibleTarget.body.modeReadiness as {
    readonly "autonomous-visual": {
      readonly reasons: readonly { readonly code: string }[];
    };
  };
  assert.ok(
    noEligibleReadiness["autonomous-visual"].reasons.some(
      (reason) => reason.code === "visual-targets-unsupported"
    ),
    "the mode refuses when every approved target is locally unsupported"
  );

  const unreadable = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "viewer-1", role: "viewer" },
    {
      runControl,
      visualTargetRepository: {
        list() {
          throw new Error("synthetic storage failure");
        }
      }
    }
  );
  assert.equal(unreadable.status, 200);
  assert.notEqual(
    unreadable.body.capabilityRevision,
    response.body.capabilityRevision,
    "readiness changes must invalidate a launch's observed capability revision"
  );
  const unavailableModes = unreadable.body.modeReadiness as {
    readonly "adapter-accelerated": { readonly status: string };
    readonly "autonomous-visual": {
      readonly status: string;
      readonly targetStore: string;
      readonly targets: readonly unknown[];
      readonly reasons: readonly { readonly code: string }[];
    };
  };
  assert.equal(
    unavailableModes["adapter-accelerated"].status,
    "check-required"
  );
  assert.equal(
    unavailableModes["autonomous-visual"].targetStore,
    "unavailable"
  );
  assert.deepEqual(unavailableModes["autonomous-visual"].targets, []);
  assert.ok(
    unavailableModes["autonomous-visual"].reasons.some(
      (reason) => reason.code === "visual-target-store-unavailable"
    )
  );
});

test("Control API refuses unavailable visual and scripted modes without adapter fallback", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls),
    visualTargetRepository: { list: () => [] }
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const unavailableLaunches = [
    {
      schema: "autodev-playtest-launch-v1",
      mode: "autonomous-visual",
      workspaceId: WORKSPACE,
      requestId: "unavailable-visual-1",
      targetId: "racing-game-local",
      policyId: "smart-direct",
      areasOfFocus: null,
      limits: {
        episodeCount: 1,
        maxStepsPerEpisode: 80,
        wallTimeMs: 120_000,
        smartRequestsPerEpisode: 30,
        smartTokensPerEpisode: 25_000,
        screenshotCountPerEpisode: 160,
        artifactBytesPerEpisode: 64 * 1024 * 1024
      }
    },
    {
      schema: "autodev-playtest-launch-v1",
      mode: "scripted-regression",
      workspaceId: WORKSPACE,
      requestId: "unavailable-scripted-1",
      recipeId: "replay-race-settlement",
      maxSteps: 80,
      wallTimeMs: 120_000
    }
  ];
  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  const capabilityRevision = String(capabilities.body.capabilityRevision);
  for (const launch of unavailableLaunches) {
    const launchPayload = { ...launch, capabilityRevision };
    const response = await callRunControl(
      "POST",
      "/control/playtesting/runs",
      operator,
      options,
      launchPayload
    );
    assert.equal(
      response.status,
      launch.mode === "autonomous-visual" ? 409 : 503
    );
    assert.equal(
      (response.body.error as { readonly code: string }).code,
      "autodev_control_playtesting_preflight_not_ready"
    );
  }
  assert.equal(
    calls.filter(
      (entry) => (entry as { operation?: string }).operation === "start"
    ).length,
    0
  );
});

test("Control API rejects superseded flat batch and branch payloads without dispatching a run", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls),
    visualTargetRepository: { list: () => [] }
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const legacyPayloads = [
    {
      workspaceId: WORKSPACE,
      assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
    },
    {
      workspaceId: WORKSPACE,
      parentEpisodeId: "episode-1",
      branchStep: 4,
      alternativeActionId: "wait"
    }
  ];
  for (const payload of legacyPayloads) {
    const response = await callRunControl(
      "POST",
      "/control/playtesting/runs",
      operator,
      options,
      payload
    );
    assert.equal(response.status, 400);
    assert.equal(
      (response.body.error as { readonly code: string }).code,
      "autodev_control_playtesting_invalid_request"
    );
  }
  assert.deepEqual(calls, []);
});

test("Control API run, status, list, and cancel delegate to the shared Runtime run owner", async () => {
  const calls: unknown[] = [];
  const audit: unknown[] = [];
  const runControl = runControlFixture(calls);
  const options: PlaytestingRunControlApiOptions = {
    runControl,
    visualTargetRepository: { list: () => [] },
    audit: (event) => audit.push(event)
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const viewer = { actor: "viewer-1", role: "viewer" as const };
  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(capabilities.status, 200);
  assert.equal(
    capabilities.body.schema,
    "autodev-control-playtesting-capabilities-v3"
  );
  assert.deepEqual(capabilities.body.runnablePolicies, ["random"]);
  const readiness = capabilities.body.modeReadiness as {
    readonly "adapter-accelerated": { readonly status: string };
    readonly "autonomous-visual": {
      readonly status: string;
      readonly targetStore: string;
      readonly targets: readonly unknown[];
      readonly reasons: readonly { readonly code: string }[];
    };
  };
  assert.equal(readiness["adapter-accelerated"].status, "check-required");
  assert.equal(readiness["autonomous-visual"].status, "check-required");
  assert.ok(
    readiness["autonomous-visual"].reasons.some(
      (reason) => reason.code === "operator-required"
    )
  );
  assert.equal(readiness["autonomous-visual"].targetStore, "available");
  assert.deepEqual(readiness["autonomous-visual"].targets, []);
  assert.ok(
    readiness["autonomous-visual"].reasons.some(
      (reason) => reason.code === "visual-target-required"
    )
  );
  assert.ok(
    !readiness["autonomous-visual"].reasons.some(
      (reason) => reason.code === "visual-driver-unavailable"
    )
  );

  const operatorCapabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  const operatorCapabilityRevision = String(
    operatorCapabilities.body.capabilityRevision
  );
  const requestId = "api-primary-run-1";
  const launchRequest = batchLaunch({
    workspaceId: WORKSPACE,
    requestId,
    capabilityRevision: operatorCapabilityRevision,
    assignments: [
      { scenario: "tutorial", policy: "random", seed: "seed-1", maxSteps: 20 }
    ]
  });
  const started = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    launchRequest
  );
  assert.equal(started.status, 202);
  assert.deepEqual(started.body, {
    schema: "autodev-control-playtesting-run-started-v2",
    workspaceId: WORKSPACE,
    batchId: "batch-run-1",
    assignmentCount: 1,
    assignmentIds: ["a-0001"],
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "running"
  });
  const lookup = await callRunControl(
    "GET",
    `/control/playtesting/runs/by-request?workspaceId=${encodeURIComponent(WORKSPACE)}&requestId=${encodeURIComponent(requestId)}`,
    operator,
    options
  );
  assert.equal(lookup.status, 200);
  assert.deepEqual(lookup.body, {
    schema: "autodev-control-playtesting-run-request-v1",
    workspaceId: WORKSPACE,
    requestId,
    state: "accepted",
    batchId: "batch-run-1",
    assignmentCount: 1,
    assignmentIds: ["a-0001"],
    createdAt: "2026-10-15T00:00:00.000Z",
    status: "running"
  });
  runControl.getCapabilities = async () => {
    throw new Error("an accepted idempotent replay must not re-preflight");
  };
  const replayed = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    launchRequest
  );
  assert.equal(replayed.status, 202);
  assert.deepEqual(replayed.body, started.body);
  const delegatedStart = calls.find(
    (entry) => (entry as { operation?: string }).operation === "start"
  ) as
    | {
        operation: string;
        session: { workspaceId: string; role: string; actor: string };
        request: unknown;
      }
    | undefined;
  assert.ok(delegatedStart);
  assert.equal(delegatedStart.operation, "start");
  assert.equal(delegatedStart.session.workspaceId, WORKSPACE);
  assert.equal(delegatedStart.session.role, "operator");
  assert.match(delegatedStart.session.actor, /^control-api:[a-f0-9]{64}$/u);
  assert.deepEqual(delegatedStart.request, launchRequest);

  const active = await callRunControl(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(active.status, 200);
  assert.equal(active.body.schema, "autodev-control-playtesting-runs-v1");
  assert.equal((active.body.runs as unknown[]).length, 1);
  // One workspace-scoped read must carry each batch's live owner record, so a
  // Console watching many batches needs no second status authority or a
  // request per batch.
  const [listed] = active.body.runs as readonly {
    readonly status: { readonly batchId: string; readonly status: string };
  }[];
  assert.equal(listed?.status.batchId, "batch-run-1");
  assert.equal(listed?.status.status, "running");
  const listedCall = calls.find(
    (entry) => (entry as { operation?: string }).operation === "list"
  ) as { operation: string; session: { role: string } } | undefined;
  assert.equal(listedCall?.session.role, "control-viewer");
  assert.equal(listedCall?.operation, "list");

  const status = await callRunControl(
    "GET",
    `/control/playtesting/runs/batch-run-1?workspaceId=${encodeURIComponent(WORKSPACE)}&waitMs=25`,
    viewer,
    options
  );
  assert.equal(status.status, 200);
  const waitedCall = calls.find(
    (entry) => (entry as { operation?: string }).operation === "wait"
  ) as { operation: string; session: { role: string } } | undefined;
  assert.equal(waitedCall?.session.role, "control-viewer");
  assert.equal(waitedCall?.operation, "wait");
  assert.deepEqual(status.body.run, {
    batchId: "batch-run-1",
    status: "completed",
    cancellationReason: null,
    result: {
      batchId: "batch-run-1",
      assignmentCount: 1,
      outcomes: [
        {
          assignmentId: "a-0001",
          episodeId: "episode-1",
          state: "completed",
          started: true,
          eligible: true
        }
      ]
    },
    error: null
  });

  const cancelled = await callRunControl(
    "POST",
    `/control/playtesting/runs/batch-run-1/cancel?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { expectedStatus: "running" }
  );
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.body.cancellationRequested, true);
  assert.deepEqual(
    audit.map((event) => (event as { action: string }).action),
    ["start_playtest_run", "start_playtest_run", "cancel_playtest_run"]
  );
  assert.equal(calls.length, 11);
});

test("Control API preserves truncated execution status instead of normalizing it to completed", async () => {
  const base = runControlFixture();
  const runControl: PlaytestRunControl = {
    ...base,
    waitForRun: async (_session, _workspaceId, batchId) => ({
      batchId,
      status: "truncated",
      cancellationReason: null,
      result: { counts: { assigned: 2, budgetTruncated: 1 } },
      error: null
    })
  };
  const response = await callRunControl(
    "GET",
    `/control/playtesting/runs/batch-run-truncated?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "operator-1", role: "operator" },
    { runControl }
  );
  assert.equal(response.status, 200);
  assert.equal((response.body.run as { status: string }).status, "truncated");
});

test("Control API preserves the trusted MCP role and run ownership session across the process boundary", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls)
  };
  const operator = { actor: "playtest-runtime", role: "operator" as const };
  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  const session = {
    workspaceId: WORKSPACE,
    role: "playtester",
    actor: "agent-1",
    taskId: "task-1",
    runId: "run-1"
  };
  const sessionRequest = runRequest(
    "POST",
    "/control/playtesting/runs",
    batchLaunch({
      workspaceId: WORKSPACE,
      capabilityRevision: String(capabilities.body.capabilityRevision),
      assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
    })
  );
  sessionRequest.headers = {
    host: "127.0.0.1",
    "content-type": "application/json",
    "x-autodev-playtest-session": Buffer.from(JSON.stringify(session)).toString(
      "base64url"
    )
  };
  const response = responseRecorder();
  await handlePlaytestingRunControlRequest(
    sessionRequest,
    response as unknown as ServerResponse,
    "/control/playtesting/runs",
    operator,
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(response.statusCode, 202);
  const delegated = calls.find(
    (entry) => (entry as { operation?: string }).operation === "start"
  ) as
    | {
        session: {
          workspaceId: string;
          role: string;
          actor: string;
          taskId?: string;
          runId?: string;
        };
      }
    | undefined;
  assert.ok(delegated);
  assert.deepEqual(delegated.session, session);

  const viewerRequest = runRequest(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  viewerRequest.headers = {
    host: "127.0.0.1",
    "x-autodev-playtest-session": Buffer.from(JSON.stringify(session)).toString(
      "base64url"
    )
  };
  const forbidden = responseRecorder();
  await handlePlaytestingRunControlRequest(
    viewerRequest,
    forbidden as unknown as ServerResponse,
    "/control/playtesting/runs",
    { actor: "read-only-viewer", role: "viewer" },
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal(
    calls.filter(
      (entry) => (entry as { operation?: string }).operation === "start"
    ).length,
    1
  );

  const malformedRequest = runRequest(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  malformedRequest.headers = {
    host: "127.0.0.1",
    "x-autodev-playtest-session": "not-base64-json"
  };
  const malformed = responseRecorder();
  await handlePlaytestingRunControlRequest(
    malformedRequest,
    malformed as unknown as ServerResponse,
    "/control/playtesting/runs",
    operator,
    { readWorkspaceCatalog: catalog, ...options }
  );
  assert.equal(malformed.statusCode, 400);
});

test("Control API run actions fail closed for viewers, malformed requests, and absent run owners", async () => {
  const calls: unknown[] = [];
  const options: PlaytestingRunControlApiOptions = {
    runControl: runControlFixture(calls)
  };
  const viewer = { actor: "viewer-1", role: "viewer" as const };
  const body = batchLaunch({
    workspaceId: WORKSPACE,
    assignments: [{ scenario: "tutorial", policy: "random", seed: "seed-1" }]
  });

  const forbidden = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    viewer,
    options,
    body
  );
  assert.equal(forbidden.status, 403);
  assert.equal(calls.length, 0);

  const extraField = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    { actor: "operator-1", role: "operator" },
    options,
    { ...body, command: ["echo", "unsafe"] }
  );
  assert.equal(extraField.status, 400);
  assert.equal(calls.length, 0);

  const duplicateWorkspace = await callRunControl(
    "GET",
    `/control/playtesting/runs?workspaceId=${encodeURIComponent(WORKSPACE)}&workspaceId=${encodeURIComponent(WORKSPACE)}`,
    viewer,
    options
  );
  assert.equal(duplicateWorkspace.status, 400);
  assert.equal(calls.length, 0);

  const noOwner = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    { actor: "operator-1", role: "operator" },
    {} as PlaytestingRunControlApiOptions,
    body
  );
  assert.equal(noOwner.status, 503);
  assert.equal(calls.length, 0);
});

test("Control API returns a conflict when a requestId is bound to another payload", async () => {
  const base = runControlFixture();
  const runControl: PlaytestRunControl = {
    ...base,
    startRun: async () => {
      throw new PlaytestMcpConflictError(
        "This requestId is already bound to another payload."
      );
    }
  };
  const operator = { actor: "operator-idempotency", role: "operator" as const };
  const options = { runControl };
  const capabilities = await callRunControl(
    "GET",
    `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  const response = await callRunControl(
    "POST",
    "/control/playtesting/runs",
    operator,
    options,
    batchLaunch({
      requestId: "same-key-different-payload",
      capabilityRevision: String(capabilities.body.capabilityRevision),
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "alternate-seed" }
      ]
    })
  );
  assert.equal(response.status, 409);
  assert.equal(
    (response.body.error as { readonly code: string }).code,
    "autodev_control_playtesting_request_id_conflict"
  );
});

test("Control API reports missing Data and sandbox services as unavailable without leaking host details", async () => {
  const operator = { actor: "operator-1", role: "operator" as const };
  for (const failure of ["data", "sandbox"] as const) {
    const base = runControlFixture();
    const runControl: PlaytestRunControl = {
      ...base,
      startRun: async () => {
        if (failure === "data") {
          throw new PlaytestSourceUnavailableError("/private/data-path");
        }
        throw new PlaytestSandboxUnavailableError("/private/docker-socket");
      }
    };
    const capabilities = await callRunControl(
      "GET",
      `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
      operator,
      { runControl }
    );
    const response = await callRunControl(
      "POST",
      "/control/playtesting/runs",
      operator,
      { runControl },
      batchLaunch({
        workspaceId: WORKSPACE,
        capabilityRevision: String(capabilities.body.capabilityRevision),
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "failure-seed" }
        ]
      })
    );
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /private\/(?:data-path|docker-socket)/u
    );
    assert.equal(
      (response.body.error as { code: string }).code,
      failure === "data"
        ? "autodev_control_playtesting_source_unavailable"
        : "autodev_control_playtesting_sandbox_unavailable"
    );
  }
});

test("Playtesting episodes API forwards validated filters and cursor paging to Data", async () => {
  let received: unknown;
  const repository = readRepository({
    listEpisodes: async (filter, page) => {
      received = { filter, page };
      return {
        rows: [],
        total: 10_000,
        nextCursor: "next-cursor"
      };
    }
  });
  const response = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}&limit=100&cursor=after&buildSha=${"a".repeat(40)}&cohort=novice`,
    { repository }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body, {
    schema: "autodev-control-playtesting-page-v1",
    workspaceId: WORKSPACE,
    resource: "episodes",
    readOnly: true,
    page: { rows: [], total: 10_000, nextCursor: "next-cursor" }
  });
  assert.deepEqual(received, {
    filter: {
      workspaceId: WORKSPACE,
      buildSha: "a".repeat(40),
      cohort: "novice"
    },
    page: { limit: 100, cursor: "after" }
  });
});

test("Playtesting reads distinguish unknown workspaces, unavailable catalogs, and unavailable source", async () => {
  const unknown = await call(
    "GET",
    "/control/playtesting/episodes?workspaceId=other/game",
    { repository: readRepository() }
  );
  assert.equal(unknown.status, 404);
  assert.equal(
    unknown.body.error && (unknown.body.error as { code?: string }).code,
    "autodev_control_playtesting_workspace_not_found"
  );

  const unavailableCatalog = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    {
      readWorkspaceCatalog: () => ({ status: "unavailable", workspaces: [] }),
      repository: readRepository()
    }
  );
  assert.equal(unavailableCatalog.status, 503);
  assert.equal(
    (unavailableCatalog.body.error as { code: string }).code,
    "autodev_control_playtesting_workspace_catalog_unavailable"
  );

  const unavailableSource = await call(
    "GET",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    {
      repository: readRepository({
        listEpisodes: async () => {
          throw new PlaytestSourceUnavailableError("fixture offline");
        }
      })
    }
  );
  assert.equal(unavailableSource.status, 503);
  assert.equal(
    (unavailableSource.body.error as { code: string }).code,
    "autodev_control_playtesting_source_unavailable"
  );
  assert.doesNotMatch(
    JSON.stringify(unavailableSource.body),
    /fixture offline/u
  );
});

test("default workspace-scoped Playtesting reads gate on readiness and reuse an explicit schema retry", async () => {
  const originalFetch = globalThis.fetch;
  let failSchemaInitialization = true;
  const clickHouseCalls: { query: string; workspaceId: string | null }[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query") ?? "";
    clickHouseCalls.push({
      query,
      workspaceId: url.searchParams.get("param_workspaceId")
    });
    if (
      failSchemaInitialization &&
      /^(?:CREATE TABLE|ALTER TABLE)/iu.test(query.trim())
    ) {
      return new Response("ClickHouse unavailable", { status: 503 });
    }
    return query.toLowerCase().includes("count(")
      ? new Response('{"total":"0"}\n', { status: 200 })
      : new Response("", { status: 200 });
  }) as typeof fetch;

  const callDefaultRepository = async (resource: "episodes" | "findings") => {
    const url = `/control/playtesting/${resource}?workspaceId=${encodeURIComponent(WORKSPACE)}`;
    const response = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request("GET", url),
      response as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1").pathname,
      { actor: "console-viewer", role: "viewer" },
      { readWorkspaceCatalog: catalog }
    );
    return {
      status: response.statusCode,
      body: JSON.parse(response.body ?? "{}") as Record<string, unknown>
    };
  };
  const callReadiness = async (
    method: "GET" | "POST",
    role: "viewer" | "operator" = "viewer"
  ) => {
    const readinessPath =
      method === "POST"
        ? "/control/playtesting/initialize"
        : "/control/playtesting/readiness";
    const url = `${readinessPath}?workspaceId=${encodeURIComponent(WORKSPACE)}`;
    const response = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request(method, url),
      response as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1").pathname,
      {
        actor: role === "operator" ? "playtest-operator" : "console-viewer",
        role
      },
      { readWorkspaceCatalog: catalog }
    );
    return {
      status: response.statusCode,
      body: JSON.parse(response.body ?? "{}") as Record<string, unknown>
    };
  };

  try {
    const initializing = await callDefaultRepository("episodes");
    assert.equal(initializing.status, 503);
    assert.equal(
      (initializing.body.error as { code: string }).code,
      "autodev_control_playtesting_source_initializing"
    );
    await assert.rejects(warmupDefaultPlaytestingRepository());

    const unavailable = await callReadiness("GET");
    assert.equal(unavailable.status, 503);
    assert.equal(
      (unavailable.body.error as { code: string }).code,
      "autodev_control_playtesting_source_unavailable"
    );
    const failedSchemaCallCount = clickHouseCalls.filter((statement) =>
      /^(?:CREATE TABLE|ALTER TABLE)/iu.test(statement.query.trim())
    ).length;
    const unavailableRead = await callDefaultRepository("episodes");
    assert.equal(unavailableRead.status, 503);
    assert.equal(
      (unavailableRead.body.error as { code: string }).code,
      "autodev_control_playtesting_source_unavailable"
    );
    assert.equal(
      clickHouseCalls.filter((statement) =>
        /^(?:CREATE TABLE|ALTER TABLE)/iu.test(statement.query.trim())
      ).length,
      failedSchemaCallCount,
      "a viewer resource read must not restart failed schema DDL"
    );

    failSchemaInitialization = false;
    const retry = await callReadiness("POST", "operator");
    assert.equal(retry.status, 200);
    assert.equal((retry.body as { status: string }).status, "initializing");
    await warmupDefaultPlaytestingRepository();

    const [episodes, findings] = await Promise.all([
      callDefaultRepository("episodes"),
      callDefaultRepository("findings")
    ]);

    assert.equal(episodes.status, 200);
    assert.equal(findings.status, 200);
    const schemaCalls = clickHouseCalls.filter((statement) =>
      /^(?:CREATE TABLE|ALTER TABLE)/iu.test(statement.query.trim())
    );
    assert.ok(
      schemaCalls.length > 0,
      "the explicit retry provisions the Data schema"
    );
    const workspaceReads = clickHouseCalls.filter(
      (statement) =>
        /^SELECT/iu.test(statement.query.trim()) &&
        !statement.query.includes(
          "JSONExtractString(payload_json, 'schema')"
        ) &&
        /playtest_(?:episodes|findings)/iu.test(statement.query)
    );
    assert.ok(workspaceReads.length > 0);
    assert.ok(
      workspaceReads.every((statement) => statement.workspaceId === WORKSPACE)
    );

    const schemaCallCount = schemaCalls.length;
    const repeated = await callDefaultRepository("episodes");
    assert.equal(repeated.status, 200);
    assert.equal(
      clickHouseCalls.filter((statement) =>
        /^(?:CREATE TABLE|ALTER TABLE)/iu.test(statement.query.trim())
      ).length,
      schemaCallCount,
      "later reads reuse the successfully initialized schema"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Playtesting filters reject duplicate, unknown, invalid, and inverted values before Data", async () => {
  let reads = 0;
  const repository = readRepository({
    listEpisodes: async () => {
      reads += 1;
      return { rows: [], total: 0, nextCursor: null };
    }
  });
  const base = `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`;
  for (const query of [
    "&cohort=novice&cohort=expert",
    "&rawSql=1",
    "&status=not-a-state",
    "&startedAtFrom=2026-02-01T00:00:00Z&startedAtTo=2026-01-01T00:00:00Z",
    "&limit=0"
  ]) {
    const response = await call("GET", base + query, { repository });
    assert.equal(response.status, 400, query);
  }
  assert.equal(reads, 0);
});

test("Playtesting invalid keyset cursors return 400, never an empty page", async () => {
  const response = await call(
    "GET",
    `/control/playtesting/findings?workspaceId=${encodeURIComponent(WORKSPACE)}&cursor=malformed`,
    {
      repository: readRepository({
        listFindings: async () => {
          throw new PlaytestInvalidCursorError();
        }
      })
    }
  );
  assert.equal(response.status, 400);
  assert.equal(
    (response.body.error as { code: string }).code,
    "autodev_control_playtesting_invalid_cursor"
  );
});

test("selected episode returns its latest review and remains workspace-scoped", async () => {
  const episode = {
    episodeId: "episode-1",
    schema: PLAYTESTS_EPISODE_SCHEMA,
    executionProvenance: {
      mode: "adapter-accelerated",
      source: {
        kind: "repo-checkout",
        repository: WORKSPACE,
        revision: "a".repeat(40),
        revisionConfidence: "verified",
        checkoutState: "clean",
        artifactFingerprint: null,
        targetId: null,
        targetOrigin: null
      },
      observationSource: "engine-adapter",
      actionSource: "engine-policy",
      derivedFrom: null
    }
  };
  const review = { reviewId: "review-1", status: "hypothesis" };
  let lookup: unknown;
  const repository = readRepository({
    getEpisode: async (workspaceId, episodeId) => {
      lookup = { workspaceId, episodeId };
      return episode as never;
    },
    getLatestReviewForEpisode: async () => review as never
  });
  const response = await call(
    "GET",
    `/control/playtesting/episodes/episode-1?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { repository }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(lookup, { workspaceId: WORKSPACE, episodeId: "episode-1" });
  assert.equal(response.body.schema, "autodev-control-playtesting-detail-v1");
  assert.deepEqual(response.body.record, episode);
  assert.deepEqual(response.body.latestReview, review);
});

test("Playtesting API is GET-only and reports a missing episode as not found", async () => {
  const method = await call(
    "POST",
    `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET");

  const missing = await call(
    "GET",
    `/control/playtesting/episodes/missing?workspaceId=${encodeURIComponent(WORKSPACE)}`
  );
  assert.equal(missing.status, 404);
  assert.equal(
    (missing.body.error as { code: string }).code,
    "autodev_control_playtesting_episode_not_found"
  );
});

test("Control API authenticates and routes workspace-scoped Playtesting reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-api-"));
  const workspaceRoot = path.join(root, "repo", "config");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const envBefore = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  const token = "t".repeat(64);
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_VIEWERS = "playtesting-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "playtesting-operator";
  const headers = {
    host: "127.0.0.1",
    authorization: `Bearer ${token}`,
    "x-autodev-actor": "playtesting-viewer"
  };
  const uri = `/control/playtesting/episodes?workspaceId=${encodeURIComponent(WORKSPACE)}`;
  const repository = readRepository({
    listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null })
  });
  try {
    const response = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: uri,
        headers
      }) as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      "/control/playtesting/episodes",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRepository: repository
      }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(
      (JSON.parse(response.body ?? "{}") as { schema?: string }).schema,
      "autodev-control-playtesting-page-v1"
    );

    const delegatedRunControl = runControlFixture();
    const viewerRun = responseRecorder();
    const viewerRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      batchLaunch({
        workspaceId: WORKSPACE,
        assignments: [
          {
            scenario: "tutorial",
            policy: "random",
            seed: "auth-boundary-seed"
          }
        ]
      })
    );
    viewerRequest.headers = {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      "x-autodev-actor": "playtesting-viewer",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      viewerRequest,
      viewerRun as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(viewerRun.statusCode, 403);

    const capabilitiesResponse = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`,
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${token}`,
          "x-autodev-actor": "playtesting-operator"
        }
      }) as unknown as IncomingMessage,
      capabilitiesResponse as unknown as ServerResponse,
      "/control/playtesting/capabilities",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(capabilitiesResponse.statusCode, 200);
    const capabilityRevision = (
      JSON.parse(capabilitiesResponse.body ?? "{}") as {
        readonly capabilityRevision: string;
      }
    ).capabilityRevision;
    const runRequestBody = batchLaunch({
      workspaceId: WORKSPACE,
      capabilityRevision,
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "auth-boundary-seed" }
      ]
    });

    const operatorRun = responseRecorder();
    const operatorRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      runRequestBody
    );
    operatorRequest.headers = {
      host: "127.0.0.1",
      authorization: `Bearer ${token}`,
      "x-autodev-actor": "playtesting-operator",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      operatorRequest,
      operatorRun as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(operatorRun.statusCode, 202);
    assert.equal(
      (JSON.parse(operatorRun.body ?? "{}") as { schema?: string }).schema,
      "autodev-control-playtesting-run-started-v2"
    );

    const unauthorized = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: uri,
        headers: {
          host: "127.0.0.1",
          authorization: `Bearer ${token}`,
          "x-autodev-actor": "unknown"
        }
      }) as unknown as IncomingMessage,
      unauthorized,
      "/control/playtesting/episodes",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRepository: repository
      }
    );
    assert.equal(unauthorized.statusCode, 403);
  } finally {
    if (envBefore.token === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = envBefore.token;
    if (envBefore.viewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = envBefore.viewers;
    if (envBefore.operators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = envBefore.operators;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Playtesting run credentials cannot authorize cross-session analysis", async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "autodev-playtesting-scoped-api-")
  );
  const workspaceRoot = path.join(root, "repo", "config");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const envKeys = [
    "AUTODEV_CONTROL_API_TOKEN",
    "AUTODEV_CONTROL_API_VIEWERS",
    "AUTODEV_CONTROL_API_OPERATORS",
    "AUTODEV_CONTROL_VIEWERS",
    "AUTODEV_CONTROL_OPERATORS",
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN",
    "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
    "AUTODEV_PLAYTEST_CONTROL_API_ROLE",
    "AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN"
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.AUTODEV_CONTROL_API_TOKEN = "console-control-secret";
    process.env.AUTODEV_CONTROL_VIEWERS = "";
    process.env.AUTODEV_CONTROL_OPERATORS = "console-operator";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN = "scoped-playtest-secret";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR = "playtest-runtime";
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE = "playtester";
    process.env.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN =
      "analyst-scoped-secret";
    const session = {
      workspaceId: WORKSPACE,
      role: "playtester",
      actor: "agent-1",
      taskId: "task-1",
      runId: "run-1"
    };
    const delegatedCalls: unknown[] = [];
    const delegatedRunControl = runControlFixture(delegatedCalls);
    const capabilityRequest = runRequest(
      "GET",
      `/control/playtesting/capabilities?workspaceId=${encodeURIComponent(WORKSPACE)}`
    );
    capabilityRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify(session)
      ).toString("base64url")
    };
    const capabilityResponse = responseRecorder();
    await handleControlApiRequest(
      capabilityRequest,
      capabilityResponse as unknown as ServerResponse,
      "/control/playtesting/capabilities",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(capabilityResponse.statusCode, 200);
    const capabilityRevision = (
      JSON.parse(capabilityResponse.body ?? "{}") as {
        readonly capabilityRevision: string;
      }
    ).capabilityRevision;
    const scopedRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      batchLaunch({
        workspaceId: WORKSPACE,
        capabilityRevision,
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "scoped-token-seed" }
        ]
      })
    );
    scopedRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify(session)
      ).toString("base64url")
    };
    const runResponse = responseRecorder();
    await handleControlApiRequest(
      scopedRequest,
      runResponse as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: delegatedRunControl
      }
    );
    assert.equal(runResponse.statusCode, 202);
    assert.equal(
      delegatedCalls.filter(
        (entry) => (entry as { operation?: string }).operation === "start"
      ).length,
      1
    );

    const analystSession = {
      workspaceId: WORKSPACE,
      role: "playtest-analyst",
      actor: "analyst-1",
      taskId: "analysis-task-1",
      runId: "analysis-run-1"
    };
    const analystRequest = runRequest(
      "POST",
      `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
      { episodeIds: ["episode-1"] }
    );
    analystRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer analyst-scoped-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify(analystSession)
      ).toString("base64url")
    };
    const analystResponse = responseRecorder();
    await handleControlApiRequest(
      analystRequest,
      analystResponse as unknown as ServerResponse,
      `/control/playtesting/analyses`,
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(analystResponse.statusCode, 401);
    assert.equal(
      delegatedCalls.filter(
        (entry) => (entry as { operation?: string }).operation === "start"
      ).length,
      1
    );

    const consoleDispatchRequest = runRequest(
      "POST",
      `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
      { episodeIds: ["episode-1"], operation: "dispatch" }
    );
    consoleDispatchRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer console-control-secret",
      "x-autodev-actor": "console-operator",
      "content-type": "application/json"
    };
    const consoleDispatchResponse = responseRecorder();
    await handleControlApiRequest(
      consoleDispatchRequest,
      consoleDispatchResponse as unknown as ServerResponse,
      "/control/playtesting/analyses",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(consoleDispatchResponse.statusCode, 202);
    assert.deepEqual(
      delegatedCalls.find(
        (entry) =>
          (entry as { operation?: string }).operation === "analyst-dispatch"
      ),
      {
        operation: "analyst-dispatch",
        session: {
          workspaceId: WORKSPACE,
          role: "operator",
          actor: `control-api:${createHash("sha256")
            .update("console-operator")
            .digest("hex")}`
        },
        workspaceId: WORKSPACE,
        episodeIds: ["episode-1"]
      }
    );

    const analystCannotUseRunnerCredential = runRequest(
      "POST",
      "/control/playtesting/runs",
      batchLaunch({
        workspaceId: WORKSPACE,
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "analyst-run-denied" }
        ]
      })
    );
    analystCannotUseRunnerCredential.headers = {
      host: "127.0.0.1",
      authorization: "Bearer analyst-scoped-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify(analystSession)
      ).toString("base64url")
    };
    const analystRunDenied = responseRecorder();
    await handleControlApiRequest(
      analystCannotUseRunnerCredential,
      analystRunDenied as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(analystRunDenied.statusCode, 401);
    assert.equal(delegatedCalls.length, 5);

    const missingSessionResponse = responseRecorder();
    const missingSessionRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      batchLaunch({
        workspaceId: WORKSPACE,
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "missing-session" }
        ]
      })
    );
    missingSessionRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json"
    };
    await handleControlApiRequest(
      missingSessionRequest,
      missingSessionResponse as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(missingSessionResponse.statusCode, 401);
    assert.equal(delegatedCalls.length, 5);

    const escalatedSessionRequest = runRequest(
      "POST",
      "/control/playtesting/runs",
      batchLaunch({
        workspaceId: WORKSPACE,
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "escalated-role" }
        ]
      })
    );
    escalatedSessionRequest.headers = {
      host: "127.0.0.1",
      authorization: "Bearer scoped-playtest-secret",
      "content-type": "application/json",
      "x-autodev-playtest-session": Buffer.from(
        JSON.stringify({ ...session, role: "root" })
      ).toString("base64url")
    };
    const escalated = responseRecorder();
    await handleControlApiRequest(
      escalatedSessionRequest,
      escalated as unknown as ServerResponse,
      "/control/playtesting/runs",
      {
        repositoryRoot: path.join(root, "repo"),
        playtestingRunControl: runControlFixture(delegatedCalls)
      }
    );
    assert.equal(escalated.statusCode, 403);
    assert.equal(delegatedCalls.length, 5);

    const forbiddenSurface = responseRecorder();
    await handleControlApiRequest(
      Object.assign(Readable.from([]), {
        method: "GET",
        url: "/control/providers",
        headers: {
          host: "127.0.0.1",
          authorization: "Bearer scoped-playtest-secret",
          "x-autodev-actor": "agent-1"
        }
      }) as unknown as IncomingMessage,
      forbiddenSurface as unknown as ServerResponse,
      "/control/providers"
    );
    assert.equal(forbiddenSurface.statusCode, 401);
    assert.equal(
      (
        JSON.parse(forbiddenSurface.body ?? "{}") as {
          error?: { code?: string };
        }
      ).error?.code,
      "autodev_control_api_unauthorized"
    );
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized human-study API registers consent, imports idempotently, suppresses withdrawal, and exposes no identities", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-human-study-api-"));
  const repositoryRoot = path.join(root, "repo");
  mkdirSync(path.join(repositoryRoot, "config"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, "config", "workspaces.json"),
    JSON.stringify({
      schema: "autodev-workspaces-v1",
      workspaces: [
        { id: WORKSPACE, baseBranch: "main", enabled: true, agentRoles: null }
      ]
    }),
    "utf8"
  );
  const buildA = "a".repeat(40);
  const buildB = "b".repeat(40);
  const buildAContentHash = "f".repeat(64);
  const buildBContentHash = "e".repeat(64);
  const studyId = "study-fixture-1";
  const studies = new Map<string, HumanPlaytestStudy>();
  const episodeRows = new Map<string, PlaytestEpisode>();
  const benchmark = {
    benchmarkId: "benchmark-human-1",
    workspaceId: WORKSPACE,
    referenceBuildSha: buildA
  } as PlaytestBenchmark;
  const repository: PlaytestingHumanStudyRepository = {
    getLatestHumanStudy: async (_workspaceId, id) => studies.get(id) ?? null,
    getLatestBenchmark: async () => benchmark,
    listExperiments: async () =>
      ({
        rows: [
          {
            experimentId: "experiment-human-1",
            benchmarkId: benchmark.benchmarkId,
            state: "approved",
            baseline: { id: buildA, version: "1" },
            treatment: { id: buildB, version: "1" }
          }
        ],
        total: 1,
        nextCursor: null
      }) as never,
    getEpisodesByIds: async (_workspaceId, ids) =>
      ids.flatMap((id) => {
        const episode = episodeRows.get(id);
        return episode ? [episode] : [];
      }),
    insertHumanStudy: async (study) => {
      studies.set(study.studyId, study);
    }
  };
  mkdirSync(path.join(root, "approvals"), { recursive: true });
  const approvalRepository = new WorkspacePlaytestApprovalRepository(
    realpathSync(path.join(root, "approvals"))
  );
  approvalRepository.approve(
    {
      schema: "autodev-workspace-playtest-approval-v2",
      revision: 1,
      approvalId: "human-approval-1",
      workspaceId: WORKSPACE,
      approvedBy: "study-operator",
      approvedAt: "2026-10-10T00:00:00.000Z",
      checkoutRoot: path.join(root, "game"),
      adapterImageDigest: "ghcr.io/fixture/adapter@sha256:" + "d".repeat(64),
      workingDirectory: ".",
      adapterCommand: ["./adapter"],
      allowedScenarios: ["tutorial"],
      allowedPolicies: ["random"],
      limits: {
        cpuCores: 1,
        memoryBytes: 64 * 1024 * 1024,
        processCount: 8,
        wallTimeMs: 60_000,
        artifactBytes: 1024 * 1024,
        workerCount: 1,
        episodeCount: 100,
        maxStepsPerEpisode: 10,
        critiqueCount: 0
      },
      retentionDays: 30,
      issueReporting: "disabled",
      humanStudyAllowed: true,
      revokedAt: null,
      revocationReason: null,
      revokedBy: null
    },
    null
  );
  const restricted = new RestrictedHumanResponseRepository({
    rootDirectory: path.join(root, "restricted")
  });
  const token = "human-api-token-0123456789";
  const priorEnv = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_VIEWERS = "human-study-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "human-study-operator";
  const baseOptions = {
    repositoryRoot,
    playtestingHumanStudyRepository: repository,
    restrictedHumanResponseRepository: restricted,
    workspacePlaytestApprovalRepository: approvalRepository,
    preferenceStatistics: {
      exactBinomialProportionInterval: async ({ confidenceLevel = 0.95 }) => ({
        lower: Number("0.47817624989501856"),
        upper: 1,
        method: "scipy-binomial-exact",
        libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
        confidenceLevel,
        resamples: null,
        seed: null
      })
    }
  };
  const callApi = async (
    method: string,
    url: string,
    role: "viewer" | "operator",
    body?: unknown
  ) => {
    const req = runRequest(method, url, body);
    req.headers = {
      ...req.headers,
      authorization: `Bearer ${token}`,
      "x-autodev-actor":
        role === "operator" ? "human-study-operator" : "human-study-viewer"
    };
    const response = responseRecorder();
    await handleControlApiRequest(
      req,
      response as unknown as ServerResponse,
      new URL(url, "http://127.0.0.1").pathname,
      baseOptions
    );
    return {
      status: response.statusCode,
      body: JSON.parse(response.body || "{}") as Record<string, unknown>
    };
  };
  const workspaceQuery = `workspaceId=${encodeURIComponent(WORKSPACE)}`;
  const episodeLink = (participant: string, buildSha: string) => {
    const episodeId = `episode-${participant}-${buildSha === buildA ? "a" : "b"}`;
    episodeRows.set(episodeId, {
      episodeId,
      status: "completed",
      identity: { workspaceId: WORKSPACE, buildSha }
    } as PlaytestEpisode);
    return episodeId;
  };

  try {
    const registration = await callApi(
      "POST",
      "/control/playtesting/human-studies/register",
      "operator",
      {
        study: {
          schema: "autodev-playtest-human-study-v1",
          studyId,
          version: 1,
          workspaceId: WORKSPACE,
          benchmarkId: benchmark.benchmarkId,
          allowedBuilds: [
            { id: buildA, version: "1", contentHash: buildAContentHash },
            { id: buildB, version: "1", contentHash: buildBContentHash }
          ],
          preferencePlan: {
            analysisPlanRef: "preference-analysis-v1",
            questionVersion: "preference-question-v1",
            questionHash: "9".repeat(64),
            buildA: {
              id: buildA,
              version: "1",
              contentHash: buildAContentHash
            },
            buildB: {
              id: buildB,
              version: "1",
              contentHash: buildBContentHash
            },
            maximumExclusionRate: 0.25,
            practicalMargin: 0.05,
            minimumIndependentParticipants: 5,
            interval: {
              method: "scipy-binomial-exact",
              libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
              confidenceLevel: 0.95,
              resamples: null,
              seed: null
            }
          },
          pxiItemConstructMappingHash: null,
          instrument: "miniPXI",
          instrumentVersion: "miniPXI-v1",
          instrumentHash: "e".repeat(64),
          consentVersion: "consent-v1",
          consentScope: "post-play",
          responseWindowMs: 24 * 60 * 60 * 1000,
          minimumExposureMs: 60_000,
          orderDesign: "AB/BA",
          independentUnit: "participant",
          missingItemPolicy: "null-construct",
          invitedCount: 10,
          eligibleCount: 10,
          respondedCount: 10,
          withdrawnCount: 0,
          createdAt: "2026-10-10T00:00:00.000Z"
        }
      }
    );
    assert.equal(registration.status, 201);
    assert.equal((registration.body as { approved?: boolean }).approved, true);

    const rows: Record<string, string>[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const participantId = `participant-${index}`;
      const order = index % 2 === 0 ? "B-first" : "A-first";
      const consent = await callApi(
        "POST",
        `/control/playtesting/human-studies/${studyId}/consents?${workspaceQuery}`,
        "operator",
        {
          participantId,
          consentVersion: "consent-v1",
          consentScope: "post-play"
        }
      );
      assert.equal(consent.status, 201);
      rows.push(
        ...[
          {
            buildId: buildA,
            order,
            episodeId: episodeLink(participantId, buildA),
            exposureStartedAt:
              order === "A-first"
                ? "2026-10-10T00:00:00.000Z"
                : "2026-10-10T00:20:00.000Z",
            exposureEndedAt:
              order === "A-first"
                ? "2026-10-10T00:10:00.000Z"
                : "2026-10-10T00:30:00.000Z"
          },
          {
            buildId: buildB,
            order,
            episodeId: episodeLink(participantId, buildB),
            exposureStartedAt:
              order === "A-first"
                ? "2026-10-10T00:20:00.000Z"
                : "2026-10-10T00:00:00.000Z",
            exposureEndedAt:
              order === "A-first"
                ? "2026-10-10T00:30:00.000Z"
                : "2026-10-10T00:10:00.000Z"
          }
        ].map(
          (
            {
              buildId,
              order: exposureOrder,
              episodeId,
              exposureStartedAt,
              exposureEndedAt
            },
            armIndex
          ) => ({
            studyId,
            responseId: `${participantId}-response-${armIndex}`,
            revision: "1",
            supersedes: "",
            participantId,
            consentVersion: "consent-v1",
            consentScope: "post-play",
            instrument: "miniPXI",
            instrumentVersion: "miniPXI-v1",
            instrumentHash: "e".repeat(64),
            workspaceId: WORKSPACE,
            buildId,
            buildVersion: "1",
            buildHash:
              buildId === buildA ? buildAContentHash : buildBContentHash,
            episodeId,
            exposureStartedAt,
            exposureEndedAt,
            order: exposureOrder,
            submittedAt:
              exposureOrder === "A-first"
                ? armIndex === 0
                  ? "2026-10-10T00:15:00.000Z"
                  : "2026-10-10T00:35:00.000Z"
                : armIndex === 0
                  ? "2026-10-10T00:35:00.000Z"
                  : "2026-10-10T00:15:00.000Z",
            completionStatus: "completed",
            enj: "1",
            enjMissingReason: ""
          })
        )
      );
    }
    const manifest = {
      studyIdColumn: "studyId",
      responseIdColumn: "responseId",
      revisionColumn: "revision",
      supersedesColumn: "supersedes",
      participantIdColumn: "participantId",
      consentVersionColumn: "consentVersion",
      consentScopeColumn: "consentScope",
      instrumentColumn: "instrument",
      instrumentVersionColumn: "instrumentVersion",
      instrumentHashColumn: "instrumentHash",
      workspaceIdColumn: "workspaceId",
      buildIdColumn: "buildId",
      buildVersionColumn: "buildVersion",
      buildHashColumn: "buildHash",
      episodeIdColumn: "episodeId",
      exposureStartedAtColumn: "exposureStartedAt",
      exposureEndedAtColumn: "exposureEndedAt",
      orderColumn: "order",
      submittedAtColumn: "submittedAt",
      completionStatusColumn: "completionStatus",
      items: [
        {
          itemId: "ENJ",
          valueColumn: "enj",
          missingReasonColumn: "enjMissingReason"
        }
      ]
    };
    const importUrl = `/control/playtesting/human-studies/${studyId}/import?${workspaceQuery}`;
    const exportText = JSON.stringify(rows);
    const firstImport = await callApi("POST", importUrl, "operator", {
      format: "json",
      manifest,
      exportText
    });
    assert.equal(firstImport.status, 200);
    assert.equal(firstImport.body.acceptedCount, 10);
    assert.doesNotMatch(
      JSON.stringify(firstImport.body),
      /participant-1|response-0/u
    );

    const repeatedImport = await callApi("POST", importUrl, "operator", {
      format: "json",
      manifest,
      exportText
    });
    assert.equal(repeatedImport.body.acceptedCount, 0);
    assert.equal(repeatedImport.body.unchangedCount, 10);

    const preferenceManifest = {
      studyIdColumn: "studyId",
      responseIdColumn: "responseId",
      revisionColumn: "revision",
      supersedesColumn: "supersedes",
      participantIdColumn: "participantId",
      consentVersionColumn: "consentVersion",
      consentScopeColumn: "consentScope",
      workspaceIdColumn: "workspaceId",
      episodeAColumn: "episodeA",
      exposureAStartedAtColumn: "exposureAStartedAt",
      exposureAEndedAtColumn: "exposureAEndedAt",
      episodeBColumn: "episodeB",
      exposureBStartedAtColumn: "exposureBStartedAt",
      exposureBEndedAtColumn: "exposureBEndedAt",
      orderColumn: "order",
      submittedAtColumn: "submittedAt",
      answerColumn: "answer"
    };
    const preferenceRows = Array.from({ length: 5 }, (_, index) => {
      const participantId = `participant-${index + 1}`;
      const order = index % 2 === 1 ? "B-first" : "A-first";
      return {
        studyId,
        responseId: `preference-response-${index + 1}`,
        revision: "1",
        supersedes: "",
        participantId,
        consentVersion: "consent-v1",
        consentScope: "post-play",
        workspaceId: WORKSPACE,
        episodeA: episodeLink(participantId, buildA),
        exposureAStartedAt:
          order === "A-first"
            ? "2026-10-10T00:00:00.000Z"
            : "2026-10-10T00:20:00.000Z",
        exposureAEndedAt:
          order === "A-first"
            ? "2026-10-10T00:10:00.000Z"
            : "2026-10-10T00:30:00.000Z",
        episodeB: episodeLink(participantId, buildB),
        exposureBStartedAt:
          order === "A-first"
            ? "2026-10-10T00:20:00.000Z"
            : "2026-10-10T00:00:00.000Z",
        exposureBEndedAt:
          order === "A-first"
            ? "2026-10-10T00:30:00.000Z"
            : "2026-10-10T00:10:00.000Z",
        order,
        submittedAt: "2026-10-10T00:35:00.000Z",
        answer: "B"
      };
    });
    const preferenceImportUrl = `/control/playtesting/human-studies/${studyId}/preferences/import?${workspaceQuery}`;
    const unauthorizedPreferenceImport = await callApi(
      "POST",
      preferenceImportUrl,
      "viewer",
      {
        format: "json",
        manifest: preferenceManifest,
        exportText: JSON.stringify(preferenceRows)
      }
    );
    assert.equal(unauthorizedPreferenceImport.status, 403);
    const preferenceImport = await callApi(
      "POST",
      preferenceImportUrl,
      "operator",
      {
        format: "json",
        manifest: preferenceManifest,
        exportText: JSON.stringify(preferenceRows)
      }
    );
    assert.equal(preferenceImport.status, 200);
    assert.equal(preferenceImport.body.acceptedCount, 5);
    assert.equal(preferenceImport.body.rejectedCount, 0);
    assert.doesNotMatch(
      JSON.stringify(preferenceImport.body),
      /participant-1/u
    );
    const repeatedPreferenceImport = await callApi(
      "POST",
      preferenceImportUrl,
      "operator",
      {
        format: "json",
        manifest: preferenceManifest,
        exportText: JSON.stringify(preferenceRows)
      }
    );
    assert.equal(repeatedPreferenceImport.body.acceptedCount, 0);
    assert.equal(repeatedPreferenceImport.body.unchangedCount, 5);

    const duplicatePreferenceImport = await callApi(
      "POST",
      preferenceImportUrl,
      "operator",
      {
        format: "json",
        manifest: preferenceManifest,
        exportText: JSON.stringify([
          {
            ...preferenceRows[0]!,
            responseId: "preference-response-1-duplicate",
            answer: "A"
          }
        ])
      }
    );
    assert.equal(duplicatePreferenceImport.body.quarantinedCount, 1);
    const preferenceQuarantinesUrl = `/control/playtesting/human-studies/${studyId}/preferences/quarantines?${workspaceQuery}`;
    const preferenceQuarantines = await callApi(
      "GET",
      preferenceQuarantinesUrl,
      "operator"
    );
    assert.equal(preferenceQuarantines.status, 200);
    assert.deepEqual(preferenceQuarantines.body.quarantines, []);
    const prefGroups = preferenceQuarantines.body
      .preferenceQuarantines as readonly {
      responseIds: readonly string[];
    }[];
    assert.equal(prefGroups.length, 1);
    assert.equal(prefGroups[0]!.responseIds.length, 2);
    const instrumentQuarantines = await callApi(
      "GET",
      `/control/playtesting/human-studies/${studyId}/quarantines?${workspaceQuery}`,
      "operator"
    );
    assert.equal(instrumentQuarantines.status, 200);
    assert.deepEqual(instrumentQuarantines.body.preferenceQuarantines, []);
    assert.doesNotMatch(
      JSON.stringify(preferenceQuarantines.body),
      /participant-1/u
    );
    const resolvePreference = await callApi(
      "POST",
      `/control/playtesting/human-studies/${studyId}/preferences/quarantines/resolve?${workspaceQuery}`,
      "operator",
      { responseIdToKeep: "preference-response-1" }
    );
    assert.equal(resolvePreference.status, 200);

    const summaryUrl = `/control/playtesting/human-studies/${studyId}/validation?${workspaceQuery}&buildSha=${buildA}&aBuildSha=${buildA}&bBuildSha=${buildB}`;
    const summary = await callApi("GET", summaryUrl, "viewer");
    assert.equal(summary.status, 200);
    const preferenceSummary = summary.body.preference as NonNullable<
      ControlApiPlaytestingHumanValidationResponse["preference"]
    >;
    assert.equal(preferenceSummary.suppressionState, "unsuppressed");
    assert.equal(preferenceSummary.counts?.eligibleParticipants, 5);
    assert.equal(preferenceSummary.counts?.preferB, 5);
    assert.equal(preferenceSummary.decision, "inconclusive");
    assert.ok(preferenceSummary.interval);
    assert.equal(preferenceSummary.interval.method, "scipy-binomial-exact");
    assert.ok(
      Math.abs(
        preferenceSummary.interval.lower - Number("0.47817624989501856")
      ) < 1e-12
    );
    assert.equal(
      (summary.body.summary as { retainedParticipants: number })
        .retainedParticipants,
      5
    );
    assert.doesNotMatch(
      JSON.stringify(summary.body),
      /participant-1|response-0/u
    );

    const withdrawal = await callApi(
      "POST",
      `/control/playtesting/human-studies/${studyId}/withdrawals?${workspaceQuery}`,
      "operator",
      { participantId: "participant-5" }
    );
    assert.equal(withdrawal.status, 200);
    assert.equal(withdrawal.body.retainedParticipants, null);
    const afterWithdrawal = await callApi("GET", summaryUrl, "viewer");
    const suppressed = afterWithdrawal.body.summary as {
      retainedParticipants: number | null;
      suppressionState: string;
    };
    assert.equal(suppressed.retainedParticipants, null);
    assert.equal(suppressed.suppressionState, "suppressed");
    assert.equal(
      (afterWithdrawal.body.preference as { counts: unknown }).counts,
      null
    );
    assert.deepEqual(
      restricted.getTombstonedHistory(studyId).map((item) => item.status),
      ["stale", "stale", "stale", "withdrawn"]
    );
  } finally {
    if (priorEnv.token === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = priorEnv.token;
    if (priorEnv.viewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = priorEnv.viewers;
    if (priorEnv.operators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = priorEnv.operators;
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode windows are workspace-bound, integrity-checked, and step-filtered", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-window-"));
  try {
    const store = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: root
    });
    const written = store.writeWindow({
      entries: [
        { type: "step", step: 0, actionId: "advance" },
        { type: "event", event: { step: 1, eventId: "event-1" } },
        { type: "step", step: 8, actionId: "finish" }
      ]
    });
    const episode = {
      episodeId: "episode-window",
      trace: { kind: "replay-segment", id: written.reference.artifactId }
    };
    const repository = readRepository({
      getEpisode: async () => episode as never
    });
    const response = await call(
      "GET",
      `/control/playtesting/episodes/episode-window/windows/${written.reference.artifactId}?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=1&endStep=4`,
      { repository, artifactStoreForWorkspace: () => store }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entries, [
      { type: "event", event: { step: 1, eventId: "event-1" } }
    ]);
    assert.equal(response.body.sourceLineCount, 3);
    assert.equal(response.body.omittedLineCount, 2);

    const unlinked = await call(
      "GET",
      `/control/playtesting/episodes/episode-window/windows/other-window?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=1&endStep=4`,
      { repository, artifactStoreForWorkspace: () => store }
    );
    assert.equal(unlinked.status, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("episode window API rejects invalid or oversized ranges before reading artifacts", async () => {
  let reads = 0;
  const response = await call(
    "GET",
    `/control/playtesting/episodes/episode-window/windows/window-1?workspaceId=${encodeURIComponent(WORKSPACE)}&startStep=0&endStep=4096`,
    {
      repository: readRepository({
        getEpisode: async () => {
          reads += 1;
          return null;
        }
      })
    }
  );
  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("frame API serves only linked, bounded, signature-checked raster images", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtesting-frame-"));
  try {
    const store = new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: root
    });
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
    ]);
    const written = store.writeArtifact({
      mediaType: "image/png",
      bytes: imageBytes
    });
    const episode = {
      episodeId: "episode-frame",
      frames: [
        { kind: "frame", id: written.reference.artifactId, frameIndex: 0 }
      ]
    };
    const repository = readRepository({
      getEpisode: async () => episode as never
    });
    const response = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request(
        "GET",
        `/control/playtesting/episodes/episode-frame/media/${written.reference.artifactId}?workspaceId=${encodeURIComponent(WORKSPACE)}`
      ),
      response as unknown as ServerResponse,
      `/control/playtesting/episodes/episode-frame/media/${written.reference.artifactId}`,
      { actor: "console-viewer", role: "viewer" },
      {
        readWorkspaceCatalog: catalog,
        repository,
        artifactStoreForWorkspace: () => store
      }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["content-length"], imageBytes.byteLength);

    const unlinked = responseRecorder();
    await handlePlaytestingControlApiRequest(
      request(
        "GET",
        `/control/playtesting/episodes/episode-frame/media/unlinked-frame?workspaceId=${encodeURIComponent(WORKSPACE)}`
      ),
      unlinked as unknown as ServerResponse,
      "/control/playtesting/episodes/episode-frame/media/unlinked-frame",
      { actor: "console-viewer", role: "viewer" },
      {
        readWorkspaceCatalog: catalog,
        repository,
        artifactStoreForWorkspace: () => store
      }
    );
    assert.equal(unlinked.statusCode, 404);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-session analysis delegates to the owner and bounds the selection", async () => {
  const calls: unknown[] = [];
  const options = {
    runControl: runControlFixture(calls)
  };
  const operator = { actor: "operator-1", role: "operator" as const };
  const selection = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: ["episode-a", "episode-b"] }
  );
  assert.equal(selection.status, 200);
  assert.equal(
    selection.body.schema,
    "autodev-control-playtesting-analysis-v1"
  );
  assert.equal(selection.body.workspaceId, WORKSPACE);
  assert.equal(selection.body.requested, 2);
  assert.equal(selection.body.operation, "prepare");
  // The owner decides eligibility, caps and receipts; the route must not
  // answer a selection question on its own.
  const forwarded = calls.find(
    (entry) => (entry as { operation?: string }).operation === "cross-session"
  ) as { workspaceId: string; episodeIds: string[] } | undefined;
  assert.equal(forwarded?.workspaceId, WORKSPACE);
  assert.deepEqual(forwarded?.episodeIds, ["episode-a", "episode-b"]);
  assert.equal(selection.headers["cache-control"], "no-store");

  const empty = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: [] }
  );
  assert.equal(empty.status, 400);

  const oversized = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: Array.from({ length: 17 }, (_, i) => `episode-${i}`) }
  );
  assert.equal(oversized.status, 400);

  const status = await callRunControl(
    "GET",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  assert.equal(status.status, 200);
  assert.equal(status.body.schema, "autodev-control-playtesting-analyses-v1");
  assert.deepEqual(status.body.runs, []);
  assert.deepEqual(status.body.syntheses, []);
  const viewerDispatch = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    { actor: "viewer-1", role: "viewer" },
    options,
    { episodeIds: ["episode-a"], operation: "dispatch" }
  );
  assert.equal(viewerDispatch.status, 403);
  assert.equal(
    calls.some(
      (entry) =>
        (entry as { operation?: string }).operation === "analyst-dispatch"
    ),
    false
  );

  const dispatched = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: ["episode-a"], operation: "dispatch" }
  );
  assert.equal(dispatched.status, 202);
  assert.equal(dispatched.body.operation, "dispatch");
  assert.deepEqual(dispatched.body.packets, [
    { episodeId: "episode-a", batchId: "batch-1", packetId: "packet-a" }
  ]);
  assert.equal("packet" in (dispatched.body.packets as object[])[0]!, false);
  assert.equal(
    (dispatched.body.analysis as { analysisId: string }).analysisId,
    "analysis-1"
  );
  assert.ok(
    calls.some(
      (entry) =>
        (entry as { operation?: string }).operation === "analyst-dispatch"
    )
  );

  const fortySessions = Array.from(
    { length: 40 },
    (_, index) => `episode-${String(index + 1)}`
  );
  const dispatchAtLimit = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: fortySessions, operation: "dispatch" }
  );
  assert.equal(dispatchAtLimit.status, 202);
  assert.equal(dispatchAtLimit.body.requested, 40);
  assert.equal((dispatchAtLimit.body.packets as unknown[]).length, 40);
  const lastDispatch = calls.at(-1) as
    { operation?: string; episodeIds?: readonly string[] } | undefined;
  assert.equal(lastDispatch?.operation, "analyst-dispatch");
  assert.deepEqual(lastDispatch?.episodeIds, fortySessions);

  const fortyOneSessions = [...fortySessions, "episode-41"];
  const delegatedCountBeforeLimitCheck = calls.length;
  const dispatchOverLimit = await callRunControl(
    "POST",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options,
    { episodeIds: fortyOneSessions, operation: "dispatch" }
  );
  assert.equal(dispatchOverLimit.status, 400);
  assert.equal(calls.length, delegatedCountBeforeLimitCheck);

  const wrongMethod = await callRunControl(
    "DELETE",
    `/control/playtesting/analyses?workspaceId=${encodeURIComponent(WORKSPACE)}`,
    operator,
    options
  );
  assert.equal(wrongMethod.status, 405);
});
