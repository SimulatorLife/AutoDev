import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertPlaytestEvidencePacket,
  buildPlaytestCoverageManifestDraft,
  buildPlaytestEvidencePacket,
  buildPlaytestFindingIdentity,
  canonicalPlaytestJson,
  playtestAssignmentManifestHashInput,
  type PlaytestAssignmentOutcome,
  type PlaytestBatch,
  type PlaytestBatchAssignment,
  type PlaytestCapabilityAdvertisement,
  type PlaytestComparison,
  type PlaytestCompletionCounts,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  playtestCoveragePlanForRegistry,
  playtestCrossSessionInventoryHashInput,
  type PlaytestDimensionRubric,
  type PlaytestEpisode,
  type PlaytestEvidenceTraceStep,
  type PlaytestFinding,
  playtestFindingIdentityHashInput,
  playtestReviewOutcomeKey,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_MEASUREMENT_VERSION,
  type PlaytestSessionReview,
  selectPlaytestBatchReviews,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";
import { PlaytestSourceUnavailableError } from "@simulatorlife/autodev-data/playtesting";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  PlaytestSandboxUnavailableError,
  type PreparedPlaytestSandbox
} from "../src/playtesting/docker-sandbox.ts";
import type { PlaytestEpisodeRunOptions } from "../src/playtesting/episode-runner.ts";
import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpOptions,
  type PlaytestMcpSession,
  type PlaytestRunControl,
  type PlaytestRunOwner
} from "../src/playtesting/mcp.ts";
import {
  assertPlaytestStdioSessionBinding,
  playtestMcpSessionProvider,
  playtestStdioConfiguration
} from "../src/playtesting/mcp-main.ts";
import { createSeededRandomPlaytestPolicy } from "../src/playtesting/policies.ts";
import { fixturePlaytestMetricRegistry } from "./support/playtesting-metric-registry.ts";

const WORKSPACE_ID = "owner/game";

function singleAssignmentRequest(
  scenario = "tutorial",
  policy = "random",
  seed = "seed-1",
  maxSteps?: number
) {
  return {
    assignments: [
      {
        scenario,
        policy,
        seed,
        ...(maxSteps === undefined ? {} : { maxSteps })
      }
    ]
  };
}

type TestPlaytestMcpOptions = Omit<PlaytestMcpOptions, "playtestRunControl"> & {
  readonly playtestRunControl?: PlaytestRunControl;
};

function createTestPlaytestMcpServer(options: TestPlaytestMcpOptions) {
  const playtestRunControl =
    options.playtestRunControl ?? createPlaytestRunControl(options);
  return createPlaytestMcpServer({ ...options, playtestRunControl });
}

function createApproval(
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    revision: 1,
    approvalId: "approval-fixture-1",
    workspaceId: WORKSPACE_ID,
    approvedBy: "operator@example.com",
    approvedAt: "2026-10-10T00:00:00.000Z",
    checkoutRoot: "/tmp/fixture-checkout",
    buildSha: "a".repeat(40),
    gameBuild: "fixture-build-1",
    playtestConfigHash: "b".repeat(64),
    adapterImageDigest: "sha256:" + "c".repeat(64),
    workingDirectory: "server",
    adapterCommand: ["./server", "--playtest"],
    allowedScenarios: ["tutorial", "boss-fight"],
    allowedPolicies: ["random", "heuristic-v1"],
    limits: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
      processCount: 16,
      wallTimeMs: 60_000,
      artifactBytes: 64 * 1024 * 1024,
      workerCount: 2,
      episodeCount: 10,
      maxStepsPerEpisode: 50,
      critiqueCount: 5
    },
    retentionDays: 30,
    issueReporting: "review",
    humanStudyAllowed: true,
    revokedAt: null,
    revocationReason: null,
    revokedBy: null,
    ...overrides
  };
}

function enabledWorkspaceCatalog(): () => WorkspaceCatalogRead {
  return () => ({
    status: "valid",
    workspaces: [
      {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  });
}

function parsedMcpError(result: any): Record<string, unknown> {
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(typeof payload.error?.code, "string");
  assert.equal(typeof payload.error?.category, "string");
  assert.equal(typeof payload.error?.retryable, "boolean");
  return payload.error;
}

function fixturePreparedSandbox(
  approval: WorkspacePlaytestApproval
): PreparedPlaytestSandbox {
  return {
    workspaceId: approval.workspaceId,
    checkoutRoot: approval.checkoutRoot,
    checkoutSha: approval.buildSha,
    imageDigest: approval.adapterImageDigest,
    workingDirectory: approval.workingDirectory,
    command: approval.adapterCommand,
    limits: approval.limits,
    configuration: {
      schemaVersion: 1,
      adapter: { transport: "stdio-jsonl", command: approval.adapterCommand },
      modes: ["headless"],
      scenarios: approval.allowedScenarios,
      scenarioFamilies: {
        tutorial: "tutorial-family",
        "boss-fight": "boss-family"
      },
      policies: approval.allowedPolicies,
      budget: {
        episodes: 10,
        maxStepsPerEpisode: 50,
        workers: 2,
        wallTimeMinutes: 60
      },
      analysis: {
        rubric: "playtest.rubric.json",
        observationContract: "playtest.observation.json",
        benchmark: null,
        critic: "auto",
        maxReviewedSessions: 5,
        reviewSelection: {
          surveillanceSessions: 0,
          discoverySessions: 0,
          discoverySignal: null
        },
        visualCapture: "off",
        counterfactuals: "off",
        understandingProbes: "off",
        learningCohorts: "off",
        humanCalibration: "off"
      },
      reporting: { githubIssues: "disabled" }
    },
    observationContract: {
      schemaVersion: 1,
      schemaHash: "d".repeat(64),
      mode: "headless",
      cohort: "standard",
      visibilityMode: "structured",
      fields: [],
      uiEquivalence: "verified",
      conformanceFixtureHash: null
    },
    benchmark: null,
    rubric: fixturePlaytestMetricRegistry(approval.workspaceId),
    rubricHash: "e".repeat(64)
  };
}

function makeCoverageManifest(
  input: Parameters<typeof buildPlaytestCoverageManifestDraft>[0]
): PlaytestCoverageManifest {
  const draft = buildPlaytestCoverageManifestDraft(input);
  return {
    ...draft,
    contentHash: createHash("sha256")
      .update(playtestCoverageManifestHashInput(draft))
      .digest("hex")
  };
}

function capabilitiesForRun(
  options: PlaytestEpisodeRunOptions
): PlaytestCapabilityAdvertisement {
  return {
    protocolVersion: 1,
    schemaHashAlgorithm: "sha256-canonical-json-v1",
    engineBuild: options.approval.gameBuild,
    modes: [options.observationContract.mode],
    scenarioIds: options.approval.allowedScenarios,
    observationSchema: { type: "object" },
    actionSchema: { type: "object" },
    eventSchema: { type: "object" },
    observationSchemaHash: options.observationContract.schemaHash,
    actionSchemaHash: "a".repeat(64),
    eventSchemaHash: "c".repeat(64),
    optionalOperations: [],
    quotas: {
      maxMessageBytes: 1_048_576,
      maxQueuedRequests: 32,
      ordinaryCallTimeoutMs: 10_000,
      resetReplayTimeoutMs: 60_000
    },
    deterministic: {
      seededRuns: true,
      rngVersion: "fixture-rng-v1",
      traceReplayable: true
    }
  };
}

function episodeForRun(
  options: Pick<
    PlaytestEpisodeRunOptions,
    | "approval"
    | "repository"
    | "batchId"
    | "assignmentId"
    | "scenarioId"
    | "scenarioFamily"
    | "seed"
    | "policy"
    | "observationContract"
    | "runtimeVersion"
    | "environmentHash"
  >,
  status: "completed" | "cancelled" = "cancelled"
): PlaytestEpisode {
  const timestamp = new Date().toISOString();
  return {
    schema: "autodev-playtest-episode-v3",
    episodeId: "ep-cancel-fixture",
    revision: 1,
    batchId: options.batchId,
    assignmentId: options.assignmentId,
    branchLineage: null,
    identity: {
      workspaceId: options.repository,
      repository: options.repository,
      buildSha: options.approval.buildSha,
      gameBuild: options.approval.gameBuild,
      scenarioId: options.scenarioId,
      configHash: options.approval.playtestConfigHash,
      seed: options.seed,
      rngInitialStateHash: null,
      rngAlgorithm: "fixture-rng",
      rngVersion: "1",
      policyId: options.policy.id,
      policyVersion: options.policy.version,
      modelId: null,
      modelRevision: null,
      observationSchemaHash: options.observationContract.schemaHash,
      actionSchemaHash: "a".repeat(64),
      eventSchemaHash: "c".repeat(64),
      protocolVersion: 1,
      runtimeVersion: options.runtimeVersion,
      environmentHash: options.environmentHash
    },
    scenarioFamily: options.scenarioFamily,
    policyCohort: options.policy.cohort,
    strategy: options.policy.strategy,
    status,
    outcome: status === "completed" ? "win" : "unknown",
    outcomeMetrics: {},
    completionCounts: {
      assigned: 1,
      started: 1,
      completed: status === "completed" ? 1 : 0,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: status === "cancelled" ? 1 : 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: status === "completed" ? 1 : 0
    },
    replayStatus: "trace-replayable",
    trace: null,
    frames: [],
    stepCount: 0,
    metrics: [],
    findingIds: [],
    assignedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    simulationWallMs: 1,
    logicalTicks: 0,
    policyInferenceMs: 0,
    nativeDurationMs: null,
    completeness: status === "completed" ? "complete" : "partial",
    missingReasons: status === "cancelled" ? ["cancelled"] : []
  };
}

function fixtureSandbox(runId: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const onExit = () => {};
  return {
    runId,
    containerName: "test-container-" + runId,
    stdin,
    stdout,
    stderr,
    onExit,
    streams: { stdin, stdout, stderr, onExit },
    cancel: async () => {},
    result: Promise.resolve({
      runId,
      containerName: "test-container-" + runId,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
      stdoutTail: [],
      stderrTail: [],
      stagingDirectory: null,
      artifacts: []
    }),
    cleanup: async () => {}
  };
}

async function waitForActiveRun(server: any): Promise<{ batchId: string }> {
  let active: { batchId: string } | undefined;
  for (let attempt = 0; attempt < 100 && active === undefined; attempt += 1) {
    const result = await server._registeredTools["playtest.activeRuns"].handler(
      {}
    );
    const payload = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(payload.runs), result.content[0].text);
    active = payload.runs[0];
    if (active === undefined)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(active?.batchId);
  return active;
}

async function triggerCancellation(
  trigger: "cancel" | "revoke" | "disable",
  server: any,
  approvalRepository: WorkspacePlaytestApprovalRepository,
  disableWorkspace: () => void,
  batchId: string
): Promise<void> {
  if (trigger === "cancel") {
    const result = await server._registeredTools["playtest.cancel"].handler({
      batchId
    });
    assert.equal(
      JSON.parse(result.content[0].text).cancellationRequested,
      true
    );
  } else if (trigger === "revoke") {
    approvalRepository.revoke(
      WORKSPACE_ID,
      "approval-fixture-1",
      1,
      "2026-10-10T02:00:00.000Z",
      "operator@example.com",
      "approval withdrawn"
    );
  } else {
    disableWorkspace();
  }
}

test("playtest stdio requires explicit trusted session context", () => {
  assert.throws(() => playtestStdioConfiguration({}), /session context/);
  assert.throws(
    () =>
      playtestStdioConfiguration({
        AUTODEV_PLAYTEST_WORKSPACE_ID: WORKSPACE_ID,
        AUTODEV_PLAYTEST_ROLE: "playtester",
        AUTODEV_PLAYTEST_ACTOR_ID: "actor-1",
        AUTODEV_PLAYTEST_TASK_ID: "task-1"
      }),
    /session context/
  );
  const validEnv = {
    AUTODEV_PLAYTEST_WORKSPACE_ID: WORKSPACE_ID,
    AUTODEV_PLAYTEST_ROLE: "playtester",
    AUTODEV_PLAYTEST_ACTOR_ID: "actor-1",
    AUTODEV_PLAYTEST_TASK_ID: "task-1",
    AUTODEV_PLAYTEST_RUN_ID: "run-1"
  };
  const config = playtestStdioConfiguration(validEnv);
  assert.deepEqual(config, {
    workspaceId: WORKSPACE_ID,
    role: "playtester",
    actor: "actor-1",
    taskId: "task-1",
    runId: "run-1",
    repositoryRoot: null
  });
  assert.deepEqual(playtestMcpSessionProvider(config).current(), {
    workspaceId: WORKSPACE_ID,
    role: "playtester",
    actor: "actor-1",
    taskId: "task-1",
    runId: "run-1",
    repositoryRoot: null
  });
  assert.throws(
    () =>
      playtestStdioConfiguration({
        ...validEnv,
        AUTODEV_PLAYTEST_WORKSPACE_ID: "owner"
      }),
    /session context/
  );
  assert.throws(
    () =>
      playtestStdioConfiguration({
        ...validEnv,
        AUTODEV_PLAYTEST_ACTOR_ID: "bad actor"
      }),
    /session context/
  );
  assert.throws(
    () =>
      playtestStdioConfiguration({
        ...validEnv,
        AUTODEV_PLAYTEST_ROLE: "not a role"
      }),
    /session context/
  );
  const canonical = {
    status: "valid" as const,
    workspaces: [
      { id: WORKSPACE_ID, baseBranch: "main", enabled: true, agentRoles: null }
    ]
  };
  assert.throws(
    () =>
      assertPlaytestStdioSessionBinding(
        { ...config, role: "unknown-role" },
        canonical,
        new Set(["playtester"])
      ),
    /role is invalid/
  );
  assert.throws(
    () =>
      assertPlaytestStdioSessionBinding(
        config,
        { status: "valid", workspaces: [] },
        new Set(["playtester"])
      ),
    /canonical catalog/
  );
  assert.throws(
    () =>
      assertPlaytestStdioSessionBinding(
        config,
        {
          status: "valid",
          workspaces: [
            {
              id: WORKSPACE_ID,
              baseBranch: "main",
              enabled: true,
              agentRoles: ["playtest-analyst"]
            }
          ]
        },
        new Set(["playtester", "playtest-analyst"])
      ),
    /role is invalid/
  );
  assert.doesNotThrow(() =>
    assertPlaytestStdioSessionBinding(
      config,
      canonical,
      new Set(["playtester"])
    )
  );
  assert.doesNotThrow(() =>
    assertPlaytestStdioSessionBinding(
      config,
      {
        status: "valid",
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: false,
            agentRoles: null
          }
        ]
      },
      new Set(["playtester"])
    )
  );
  for (const role of ["root", "operator"]) {
    assert.doesNotThrow(() =>
      assertPlaytestStdioSessionBinding(
        { ...config, role },
        {
          status: "valid",
          workspaces: [
            {
              id: WORKSPACE_ID,
              baseBranch: "main",
              enabled: true,
              agentRoles: ["playtest-analyst"]
            }
          ]
        },
        new Set(["playtester"])
      )
    );
  }
});

test("playtest MCP server: capabilities reports active or absent workspace approval without leaking host checkout paths", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  const artifactsDir = path.join(tmpRoot, "artifacts");
  const approvalsDir = path.join(tmpRoot, "approvals");
  mkdirSync(artifactsDir, { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: artifactsDir
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(approvalsDir);

  try {
    let workspaceEnabled = true;
    const currentSession: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtester",
      actor: "runner-1"
    };
    const prepareSandboxWithinTargetBudget = (
      approval: WorkspacePlaytestApproval
    ): PreparedPlaytestSandbox => {
      const prepared = fixturePreparedSandbox(approval);
      return {
        ...prepared,
        configuration: {
          ...prepared.configuration,
          budget: { ...prepared.configuration.budget, episodes: 4 }
        }
      };
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: { current: () => currentSession },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      prepareSandboxHandler: prepareSandboxWithinTargetBudget,
      readWorkspaceCatalog: () => ({
        status: "valid",
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: workspaceEnabled,
            agentRoles: null
          }
        ]
      })
    });

    // 1. Initially unapproved
    const unapprovedResult = await (server as any)._registeredTools[
      "playtest.capabilities"
    ].handler({});
    const unapproved = JSON.parse(unapprovedResult.content[0].text);
    assert.equal(unapproved.approved, false);
    assert.equal(unapproved.workspaceId, WORKSPACE_ID);

    // 2. Save active approval
    const approval = createApproval();
    approvalRepo.approve(approval, null);

    const approvedResult = await (server as any)._registeredTools[
      "playtest.capabilities"
    ].handler({});
    assert.equal("isError" in approvedResult, false);
    const approvedText = approvedResult.content[0].text as string;
    const approved = JSON.parse(approvedText);
    assert.equal(approved.approved, true);
    assert.equal(approved.maxBatchAssignments, 4);
    assert.equal(approved.buildSha, "a".repeat(40));
    assert.deepEqual(approved.allowedScenarios, ["tutorial", "boss-fight"]);
    assert.deepEqual(approved.approvedPolicies, ["random", "heuristic-v1"]);
    assert.deepEqual(approved.supportedPolicies, ["random"]);
    assert.deepEqual(approved.runnablePolicies, ["random"]);
    assert.deepEqual(approved.unsupportedApprovedPolicies, ["heuristic-v1"]);
    assert.equal(approved.limits.maxStepsPerEpisode, 50);
    // Adversarial: the host filesystem checkout path must never be returned.
    assert.equal("checkoutRoot" in approved, false);
    assert.equal(approvedText.includes(approval.checkoutRoot), false);

    // 3. Revoked approval
    approvalRepo.revoke(
      WORKSPACE_ID,
      "approval-fixture-1",
      1,
      "2026-10-10T01:00:00.000Z",
      "operator@example.com",
      "build defect"
    );
    workspaceEnabled = false;

    const revokedResult = await (server as any)._registeredTools[
      "playtest.capabilities"
    ].handler({});
    const revoked = JSON.parse(revokedResult.content[0].text);
    assert.equal(revoked.approved, false);
    assert.equal(revoked.revokedAt, "2026-10-10T01:00:00.000Z");
    assert.equal(revoked.workspaceEnabled, false);
    assert.equal(revoked.maxBatchAssignments, 0);
    assert.deepEqual(revoked.runnablePolicies, []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: cross-workspace access is denied for non-root caller", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );

  try {
    const session: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtester",
      actor: "runner-1"
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: { current: () => session },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo
    });

    const result = await (server as any)._registeredTools[
      "playtest.capabilities"
    ].handler({ workspaceId: "other/repo" });

    assert.equal(parsedMcpError(result).code, "playtest_forbidden");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: playtest.run rejects an unenabled canonical workspace even with an active approval", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(createApproval(), null);

  try {
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "runner-1"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      readWorkspaceCatalog: () => ({ status: "valid", workspaces: [] })
    });

    const result = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-1"));
    assert.equal(parsedMcpError(result).code, "playtest_forbidden");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: playtest.run enforces role permissions, approval boundaries, explicit seed and real adapter observation contract", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );

  try {
    let currentRole = "playtest-analyst";
    let mismatchNegotiatedSchemaHash = false;
    let malformedTraceEventStep = false;
    let malformedFrameStep = false;
    const insertedEpisodes: PlaytestEpisode[] = [];
    const insertedBatches: any[] = [];
    let capturedObservationContract: unknown = null;
    let capturedScenarioFamily: string | null = null;
    let capturedSeed: string | null = null;
    let capturedMeasurementVersion: string | null = null;
    let capturedEnvironmentHash: string | null = null;
    let capturedRuntimeVersion: string | null = null;

    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async (_workspaceId, batchId) =>
        [...insertedBatches]
          .reverse()
          .find((batch) => batch.batchId === batchId) ?? null,
      listBatches: async () => {
        const latest = new Map<string, any>();
        for (const batch of insertedBatches) {
          const current = latest.get(batch.batchId);
          if (!current || current.revision < batch.revision) {
            latest.set(batch.batchId, batch);
          }
        }
        const rows = [...latest.values()];
        return { rows, total: rows.length, nextCursor: null };
      },
      listEpisodes: async () => ({
        rows: insertedEpisodes,
        total: insertedEpisodes.length,
        nextCursor: null
      }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async (_ws, epId) =>
        insertedEpisodes.find((e) => e.episodeId === epId) ?? null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        insertedBatches.push(batch);
      },
      insertEpisode: async (episode) => {
        insertedEpisodes.push(episode);
      },
      insertReview: async () => {},
      insertFinding: async () => {}
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: currentRole,
          actor: "actor-1"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: (approval) => {
        const prepared = fixturePreparedSandbox(approval);
        return {
          ...prepared,
          configuration: {
            ...prepared.configuration,
            analysis: {
              ...prepared.configuration.analysis,
              reviewSelection: {
                surveillanceSessions: 1,
                discoverySessions: 0,
                discoverySignal: null
              }
            }
          }
        };
      },
      runEpisodeHandler: async (opts) => {
        capturedObservationContract = opts.observationContract;
        capturedScenarioFamily = opts.scenarioFamily;
        capturedSeed = opts.seed;
        capturedMeasurementVersion = opts.measurementVersion;
        capturedEnvironmentHash = opts.environmentHash;
        capturedRuntimeVersion = opts.runtimeVersion;
        const traceReference = artifacts.writeWindow({
          entries: Array.from({ length: 15 }, (_, step) => ({
            step,
            phaseId: "tutorial",
            revisionBefore: step,
            revisionAfter: step + 1,
            observationVisibility: "structured",
            visibleObservation: { step },
            legalActionIds: ["advance", "wait"],
            selectedActionId: "advance",
            preActionPrediction: null,
            authoritativeOutcome: null,
            events:
              step === 7
                ? [
                    {
                      eventId: "packet-event-7",
                      type: "tutorial-step",
                      phaseId: "tutorial",
                      step:
                        malformedTraceEventStep && step === 7 ? step - 1 : step,
                      revision: step + 1
                    }
                  ]
                : [],
            frameRefs: []
          }))
        }).reference;
        return {
          capabilities: capabilitiesForRun(opts),
          episode: {
            schema: "autodev-playtest-episode-v3",
            episodeId:
              opts.seed === "seed-exact-1" ? "ep-run-1" : `ep-run-${opts.seed}`,
            revision: 1,
            batchId: opts.batchId,
            assignmentId: opts.assignmentId,
            branchLineage: null,
            identity: {
              workspaceId: opts.repository,
              repository: opts.repository,
              buildSha: opts.approval.buildSha,
              gameBuild: opts.approval.gameBuild,
              scenarioId: opts.scenarioId,
              configHash: opts.approval.playtestConfigHash,
              seed: opts.seed,
              rngInitialStateHash: null,
              rngAlgorithm: null,
              rngVersion: null,
              policyId: opts.policy.id,
              policyVersion: opts.policy.version,
              modelId: null,
              modelRevision: null,
              observationSchemaHash: opts.observationContract.schemaHash,
              actionSchemaHash: mismatchNegotiatedSchemaHash
                ? "f".repeat(64)
                : "a".repeat(64),
              eventSchemaHash: "c".repeat(64),
              protocolVersion: 1,
              runtimeVersion: opts.runtimeVersion,
              environmentHash: opts.environmentHash
            },
            scenarioFamily: opts.scenarioFamily,
            policyCohort: opts.policy.cohort,
            strategy: opts.policy.strategy,
            status: "completed",
            outcome: "win",
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
            trace: {
              kind: "replay-segment",
              id: traceReference.artifactId
            },
            frames: [
              {
                kind: "frame",
                id: malformedFrameStep
                  ? "out-of-range-frame"
                  : "missing-frame-7",
                frameIndex: 0,
                step: malformedFrameStep ? 15 : 7
              }
            ],
            stepCount: 15,
            metrics: [],
            findingIds: [],
            assignedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            simulationWallMs: 1200,
            logicalTicks: 50,
            policyInferenceMs: 100,
            nativeDurationMs: null,
            completeness: "complete",
            missingReasons: []
          },
          steps: [],
          traceReference,
          sandboxResult: null,
          failure: null,
          loopDetectedAtStep: null
        };
      },
      launchSandboxHandler: async (prepared) => {
        assert.equal(prepared.workspaceId, WORKSPACE_ID);
        assert.equal(prepared.checkoutSha, createApproval().buildSha);
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const onExit = () => {};
        return {
          runId: "run-fixture-1",
          containerName: "test-container",
          stdin,
          stdout,
          stderr,
          onExit,
          streams: { stdin, stdout, stderr, onExit },
          cancel: async () => {},
          result: Promise.resolve({
            runId: "run-fixture-1",
            containerName: "test-container",
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            durationMs: 100,
            stdoutTail: [],
            stderrTail: [],
            stagingDirectory: null,
            artifacts: []
          }),
          cleanup: async () => {}
        };
      }
    });

    // 1. playtest-analyst is blocked from running episodes
    const analystRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-1"));
    assert.equal(parsedMcpError(analystRun).code, "playtest_forbidden");

    // Switch to playtester role
    currentRole = "playtester";

    // 2. Fails when unapproved
    const unapprovedRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-1"));
    assert.equal(
      parsedMcpError(unapprovedRun).code,
      "playtest_approval_required"
    );

    // Save active approval
    const boundedApproval = createApproval();
    approvalRepo.approve(
      {
        ...boundedApproval,
        limits: { ...boundedApproval.limits, episodeCount: 5 }
      },
      null
    );

    // 3. Fails when scenario is unapproved
    const badScenarioRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(
      singleAssignmentRequest("unapproved-scenario", "random", "seed-1")
    );
    assert.equal(
      parsedMcpError(badScenarioRun).code,
      "playtest_invalid_request"
    );

    // 4. Adversarial: approved-but-unsupported policy is rejected, not
    // fabricated through a generic hash-based heuristic.
    const unsupportedPolicyRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "heuristic-v1", "seed-1"));
    assert.equal(
      parsedMcpError(unsupportedPolicyRun).code,
      "playtest_invalid_request"
    );

    const overBudgetRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-1", 51));
    assert.equal(
      parsedMcpError(overBudgetRun).code,
      "playtest_invalid_request"
    );

    // 5. Successful run with an explicit seed, real scenario family and
    // real adapter observation contract (never a fabricated empty one).
    const callerChosenBatch = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      ...singleAssignmentRequest("tutorial", "random", "seed-exact-1"),
      batchId: "model-chosen-batch"
    });
    assert.equal(
      parsedMcpError(callerChosenBatch).code,
      "playtest_invalid_request"
    );

    const successRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      assignments: [
        {
          scenario: "tutorial",
          policy: "random",
          seed: "seed-exact-1",
          maxSteps: 25
        },
        {
          scenario: "tutorial",
          policy: "random",
          seed: "seed-exact-2",
          maxSteps: 25
        }
      ]
    });
    assert.equal(successRun.isError, undefined);
    const runResult = JSON.parse(successRun.content[0].text);
    assert.equal(runResult.status, "running");
    assert.ok(runResult.batchId.startsWith("batch-"));
    const completedRunResult = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: runResult.batchId, waitMs: 5000 });
    const completedRun = JSON.parse(completedRunResult.content[0].text);
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.result.assignmentCount, 2);
    assert.deepEqual(
      completedRun.result.outcomes.map(
        (outcome: { episodeId: string }) => outcome.episodeId
      ),
      ["ep-run-1", "ep-run-seed-exact-2"]
    );
    const unrecognizedViewer = {
      workspaceId: WORKSPACE_ID,
      role: "viewer",
      actor: "untrusted-viewer"
    } satisfies PlaytestMcpSession;
    await assert.rejects(
      server.playtestRunControl.waitForRun(
        unrecognizedViewer,
        WORKSPACE_ID,
        runResult.batchId,
        0
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "PlaytestMcpAuthorizationError"
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        server.playtestRunControl.listActiveRuns(
          unrecognizedViewer,
          WORKSPACE_ID
        )
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "PlaytestMcpAuthorizationError"
    );
    assert.equal(insertedBatches.length, 2);
    assert.equal(insertedBatches[0].batchId, runResult.batchId);
    assert.equal(insertedBatches[0].revision, 1);
    assert.equal(insertedBatches[0].status, "running");
    assert.equal(insertedBatches[1].revision, 2);
    assert.equal(insertedBatches[1].status, "completed");
    assert.equal(insertedBatches[1].reviewSelection.status, "selected");
    assert.equal(insertedBatches[1].reviewPackets.length, 1);
    assert.equal(insertedBatches[1].reviewPackets[0].status, "prepared");
    const reviewedEpisodeId = insertedBatches[1].reviewPackets[0].episodeId;
    assert.deepEqual(
      artifacts.listPendingArtifacts({
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
        limit: 100
      }).entries,
      []
    );
    currentRole = "playtest-analyst";
    const preparedReview = await (server as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: reviewedEpisodeId });
    assert.equal(preparedReview.isError, undefined);
    const preparedReviewPayload = JSON.parse(preparedReview.content[0].text);
    assert.equal(
      preparedReviewPayload.packet.packetId,
      insertedBatches[1].reviewPackets[0].packetId
    );
    assert.equal(
      preparedReviewPayload.packetArtifact.sha256,
      insertedBatches[1].reviewPackets[0].artifact.sha256
    );
    assert.deepEqual(preparedReviewPayload.packet.omittedArtifacts, [
      {
        kind: "frame",
        artifactId: "missing-frame-7",
        step: 7,
        reason: "missing"
      }
    ]);
    assert.equal(
      preparedReviewPayload.packet.crossSessionContext.status,
      "included"
    );
    assert.equal(
      preparedReviewPayload.packet.crossSessionContext.sessions.length,
      1
    );
    assert.notEqual(
      preparedReviewPayload.packet.crossSessionContext.sessions[0].episodeId,
      reviewedEpisodeId
    );
    const siblingEpisodeId =
      preparedReviewPayload.packet.crossSessionContext.sessions[0].episodeId;
    const siblingEpisode = insertedEpisodes.find(
      (episode) => episode.episodeId === siblingEpisodeId
    );
    const siblingAssignment =
      insertedBatches[1].assignmentInventory.manifest.assignments.find(
        (assignment: PlaytestBatchAssignment) =>
          assignment.assignmentId === siblingEpisode?.assignmentId
      );
    assert.ok(siblingEpisode);
    assert.ok(siblingAssignment);
    const expectedInventoryHash = createHash("sha256")
      .update(
        playtestCrossSessionInventoryHashInput([
          { episode: siblingEpisode, assignment: siblingAssignment }
        ])
      )
      .digest("hex");
    assert.equal(
      preparedReviewPayload.packet.crossSessionContext.inventoryHash,
      expectedInventoryHash
    );
    const expectedSelectionSeed = createHash("sha256")
      .update(
        canonicalPlaytestJson({
          purpose: "playtest-cross-session-packet-sample-v1",
          assignmentManifestHash:
            insertedBatches[1].assignmentInventory.manifest.contentHash,
          targetAssignmentId: insertedBatches[1].reviewPackets[0].assignmentId,
          targetEpisodeId: reviewedEpisodeId,
          inventoryHash: expectedInventoryHash
        })
      )
      .digest("hex");
    assert.equal(
      preparedReviewPayload.packet.crossSessionContext.selectionSeed,
      expectedSelectionSeed
    );
    currentRole = "playtester";
    assert.equal(
      insertedBatches[1].measurementVersion,
      PLAYTESTS_MEASUREMENT_VERSION
    );
    assert.equal(
      insertedEpisodes[0]!.identity.environmentHash,
      capturedEnvironmentHash
    );
    assert.notEqual(
      capturedEnvironmentHash,
      createApproval().playtestConfigHash
    );
    assert.equal(capturedRuntimeVersion, "0.1.0");
    assert.equal(capturedMeasurementVersion, PLAYTESTS_MEASUREMENT_VERSION);
    assert.equal(insertedEpisodes.length, 2);
    assert.ok(
      insertedEpisodes.some(
        (episode) => episode.identity.seed === "seed-exact-1"
      )
    );
    assert.ok(["seed-exact-1", "seed-exact-2"].includes(capturedSeed!));
    assert.equal(capturedScenarioFamily, "tutorial-family");
    assert.deepEqual(capturedObservationContract, {
      schemaVersion: 1,
      schemaHash: "d".repeat(64),
      mode: "headless",
      cohort: "standard",
      visibilityMode: "structured",
      fields: [],
      uiEquivalence: "verified",
      conformanceFixtureHash: null
    });

    // Runner output must bind exactly to the adapter's negotiated schema hashes,
    // not merely provide syntactically valid SHA-256 strings.
    mismatchNegotiatedSchemaHash = true;
    const mismatchedRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(
      singleAssignmentRequest("tutorial", "random", "seed-mismatched-schema")
    );
    const mismatchedStarted = JSON.parse(mismatchedRun.content[0].text);
    const mismatchedFinished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: mismatchedStarted.batchId, waitMs: 5000 });
    const mismatchedStatus = JSON.parse(mismatchedFinished.content[0].text);
    assert.equal(mismatchedStatus.status, "failed");
    assert.equal(mismatchedStatus.error.code, "playtest_invalid_request");
    assert.equal(insertedEpisodes.length, 2);
    assert.equal(insertedBatches.length, 4);
    assert.equal(insertedBatches[3]!.revision, 2);
    assert.equal(insertedBatches[3]!.status, "failed");
    mismatchNegotiatedSchemaHash = false;

    malformedTraceEventStep = true;
    const malformedTraceRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(
      singleAssignmentRequest("tutorial", "random", "seed-malformed-trace")
    );
    const malformedTraceStarted = JSON.parse(malformedTraceRun.content[0].text);
    const malformedTraceFinished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: malformedTraceStarted.batchId, waitMs: 5000 });
    assert.equal(
      JSON.parse(malformedTraceFinished.content[0].text).status,
      "completed"
    );
    const malformedTraceBatch = insertedBatches[5];
    assert.equal(malformedTraceBatch.reviewPackets[0].status, "unavailable");
    assert.equal(
      malformedTraceBatch.reviewPackets[0].failureReason,
      "trace-malformed"
    );
    currentRole = "playtest-analyst";
    const unavailableReviewPacket = await (server as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: "ep-run-seed-malformed-trace" });
    assert.equal(
      parsedMcpError(unavailableReviewPacket).code,
      "playtest_unavailable"
    );
    currentRole = "playtester";
    malformedTraceEventStep = false;

    malformedFrameStep = true;
    const malformedFrameRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(
      singleAssignmentRequest("tutorial", "random", "seed-malformed-frame")
    );
    const malformedFrameStarted = JSON.parse(malformedFrameRun.content[0].text);
    const malformedFrameFinished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: malformedFrameStarted.batchId, waitMs: 5000 });
    assert.equal(
      JSON.parse(malformedFrameFinished.content[0].text).status,
      "completed"
    );
    const malformedFrameBatch = insertedBatches[7];
    assert.equal(malformedFrameBatch.reviewPackets[0].status, "unavailable");
    assert.equal(
      malformedFrameBatch.reviewPackets[0].failureReason,
      "trace-malformed"
    );
    malformedFrameStep = false;

    const exhaustedBudgetRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(
      singleAssignmentRequest("tutorial", "random", "seed-after-budget")
    );
    assert.equal(
      parsedMcpError(exhaustedBudgetRun).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedEpisodes.length, 4);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: playtest.run surfaces a persistence failure instead of claiming success", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(createApproval(), null);

  try {
    const insertedBatches: PlaytestBatch[] = [];
    const insertedEpisodes: PlaytestEpisode[] = [];
    let failEpisodeInsert = true;
    let failTerminalBatchInsert = false;
    let commitTerminalThenThrow = false;
    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async (_workspaceId, batchId) =>
        [...insertedBatches]
          .reverse()
          .find((batch) => batch.batchId === batchId) ?? null,
      listBatches: async () => {
        const latest = new Map<string, PlaytestBatch>();
        for (const batch of insertedBatches) {
          const current = latest.get(batch.batchId);
          if (!current || current.revision < batch.revision) {
            latest.set(batch.batchId, batch);
          }
        }
        const rows = [...latest.values()];
        return { rows, total: rows.length, nextCursor: null };
      },
      listEpisodes: async () => {
        throw new PlaytestSourceUnavailableError("private-path-sentinel");
      },
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        if (failTerminalBatchInsert && batch.revision === 2) {
          if (commitTerminalThenThrow) insertedBatches.push(batch);
          throw new Error("ClickHouse batch revision is unreachable");
        }
        insertedBatches.push(batch);
      },
      insertEpisode: async (episode) => {
        if (failEpisodeInsert) throw new Error("ClickHouse is unreachable");
        insertedEpisodes.push(episode);
      },
      insertReview: async () => {},
      insertFinding: async () => {}
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "actor-1"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: fixturePreparedSandbox,
      runEpisodeHandler: async (opts) => ({
        capabilities: capabilitiesForRun(opts),
        episode: {
          schema: "autodev-playtest-episode-v3",
          episodeId: "ep-fail-1",
          revision: 1,
          batchId: opts.batchId,
          assignmentId: opts.assignmentId,
          branchLineage: null,
          identity: {
            workspaceId: opts.repository,
            repository: opts.repository,
            buildSha: opts.approval.buildSha,
            gameBuild: opts.approval.gameBuild,
            scenarioId: opts.scenarioId,
            configHash: opts.approval.playtestConfigHash,
            seed: opts.seed,
            rngInitialStateHash: null,
            rngAlgorithm: null,
            rngVersion: null,
            policyId: opts.policy.id,
            policyVersion: opts.policy.version,
            modelId: null,
            modelRevision: null,
            observationSchemaHash: opts.observationContract.schemaHash,
            actionSchemaHash: "a".repeat(64),
            eventSchemaHash: "c".repeat(64),
            protocolVersion: 1,
            runtimeVersion: opts.runtimeVersion,
            environmentHash: opts.environmentHash
          },
          scenarioFamily: opts.scenarioFamily,
          policyCohort: opts.policy.cohort,
          strategy: opts.policy.strategy,
          status: "completed",
          outcome: "win",
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
          trace: null,
          frames: [],
          stepCount: 1,
          metrics: [],
          findingIds: [],
          assignedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          simulationWallMs: 1,
          logicalTicks: 1,
          policyInferenceMs: 1,
          nativeDurationMs: null,
          completeness: "complete",
          missingReasons: []
        },
        steps: [],
        traceReference: null,
        sandboxResult: null,
        failure: null,
        loopDetectedAtStep: null
      }),
      launchSandboxHandler: async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const onExit = () => {};
        return {
          runId: "run-fixture-2",
          containerName: "test-container-2",
          stdin,
          stdout,
          stderr,
          onExit,
          streams: { stdin, stdout, stderr, onExit },
          cancel: async () => {},
          result: Promise.resolve({
            runId: "run-fixture-2",
            containerName: "test-container-2",
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            durationMs: 1,
            stdoutTail: [],
            stderrTail: [],
            stagingDirectory: null,
            artifacts: []
          }),
          cleanup: async () => {}
        };
      }
    });

    const result = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-1"));
    const started = JSON.parse(result.content[0].text);
    assert.equal(started.status, "running");
    const finished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: started.batchId, waitMs: 5000 });
    const finishedStatus = JSON.parse(finished.content[0].text);
    assert.equal(finishedStatus.status, "failed");
    assert.equal(finishedStatus.status, "failed");
    assert.equal(finishedStatus.result.counts.infrastructureFailed, 1);
    assert.equal(finishedStatus.error, null);
    assert.equal(
      finished.content[0].text.includes("ClickHouse is unreachable"),
      false
    );
    const sourceUnavailable = await (server as any)._registeredTools[
      "playtest.listEpisodes"
    ].handler({});
    const sourceError = parsedMcpError(sourceUnavailable);
    assert.equal(sourceError.code, "playtest_data_source_unavailable");
    assert.equal(sourceError.retryable, true);
    assert.equal(
      sourceUnavailable.content[0].text.includes("private-path-sentinel"),
      false
    );
    assert.deepEqual(
      insertedBatches.map(({ revision, status }) => ({ revision, status })),
      [
        { revision: 1, status: "running" },
        { revision: 2, status: "failed" }
      ]
    );

    // If episode persistence succeeds but the terminal batch revision fails,
    // do not write a contradictory failed batch over the durable episode.
    failEpisodeInsert = false;
    failTerminalBatchInsert = true;
    const secondStart = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-2"));
    const secondStarted = JSON.parse(secondStart.content[0].text);
    const secondWait = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: secondStarted.batchId, waitMs: 5000 });
    const secondStatus = JSON.parse(secondWait.content[0].text);
    assert.equal(secondStatus.status, "failed");
    assert.equal(secondStatus.error.code, "playtest_internal_error");
    assert.equal(secondStatus.result.counts.completed, 1);
    assert.equal(secondStatus.result.outcomes[0]!.episodeId, "ep-fail-1");
    assert.equal(insertedEpisodes.length, 1);
    assert.equal(
      insertedBatches.filter((batch) => batch.batchId === secondStarted.batchId)
        .length,
      1
    );
    assert.equal(
      insertedBatches.find((batch) => batch.batchId === secondStarted.batchId)
        ?.status,
      "running"
    );

    // A lost acknowledgement after a durable terminal insert must preserve its
    // successful revision rather than append a contradictory failed revision.
    commitTerminalThenThrow = true;
    const thirdStart = await (server as any)._registeredTools[
      "playtest.run"
    ].handler(singleAssignmentRequest("tutorial", "random", "seed-3"));
    const thirdStarted = JSON.parse(thirdStart.content[0].text);
    const thirdWait = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: thirdStarted.batchId, waitMs: 5000 });
    const thirdStatus = JSON.parse(thirdWait.content[0].text);
    assert.equal(thirdStatus.status, "completed");
    assert.deepEqual(
      insertedBatches
        .filter((batch) => batch.batchId === thirdStarted.batchId)
        .map(({ revision, status }) => ({ revision, status })),
      [
        { revision: 1, status: "running" },
        { revision: 2, status: "completed" }
      ]
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP: Docker preflight and adapter reset failures are never completed or given invented batch hashes", async () => {
  for (const failureStage of ["docker", "reset"] as const) {
    const tmpRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "playtest-mcp-preflight-test-"))
    );
    mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: path.join(tmpRoot, "artifacts")
    });
    const approvalRepo = new WorkspacePlaytestApprovalRepository(
      path.join(tmpRoot, "approvals")
    );
    approvalRepo.approve(createApproval(), null);

    try {
      const insertedBatches: unknown[] = [];
      const insertedEpisodes: PlaytestEpisode[] = [];
      const mockRepo: PlaytestingRepositoryOps = {
        getBatch: async () => null,
        listBatches: async () => ({ rows: [], total: 0, nextCursor: null }),
        listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
        listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
        listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
        listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
        listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
        listHumanStudies: async () => ({
          rows: [],
          total: 0,
          nextCursor: null
        }),
        getEpisode: async () => null,
        getLatestReviewForEpisode: async () => null,
        getFinding: async () => null,
        getLatestFindingByFingerprint: async () => null,
        getLatestReview: async () => null,
        getLatestComparison: async () => null,
        insertComparison: async () => {},
        insertBatch: async (batch) => {
          insertedBatches.push(batch);
        },
        insertEpisode: async (episode) => {
          insertedEpisodes.push(episode);
        },
        insertReview: async () => {},
        insertFinding: async () => {}
      };
      const server = createTestPlaytestMcpServer({
        sessionProvider: {
          current: () => ({
            workspaceId: WORKSPACE_ID,
            role: "playtester",
            actor: "runner-1"
          })
        },
        artifactStoreForWorkspace: () => artifacts,
        approvalRepository: approvalRepo,
        playtestRepository: mockRepo,
        readWorkspaceCatalog: enabledWorkspaceCatalog(),
        prepareSandboxHandler: fixturePreparedSandbox,
        launchSandboxHandler: async () => {
          if (failureStage === "docker") {
            throw new PlaytestSandboxUnavailableError(
              "Docker details /private/path are not caller-safe."
            );
          }
          return fixtureSandbox("reset-failure");
        },
        runEpisodeHandler: async () => ({
          capabilities: null,
          episode: null,
          steps: [],
          traceReference: null,
          sandboxResult: null,
          failure: {
            stage: "execution",
            category: "adapter",
            code: null,
            disposition: "reset failed"
          },
          loopDetectedAtStep: null
        })
      });

      const startedResult = await (server as any)._registeredTools[
        "playtest.run"
      ].handler(singleAssignmentRequest("tutorial", "random", "failure-seed"));
      const started = JSON.parse(startedResult.content[0].text);
      assert.equal(started.status, "running");
      const finishedResult = await (server as any)._registeredTools[
        "playtest.wait"
      ].handler({ batchId: started.batchId, waitMs: 2000 });
      const finished = JSON.parse(finishedResult.content[0].text);
      assert.equal(finished.status, "failed");
      assert.equal(finished.result.assignmentCount, 1);
      assert.equal(finished.result.outcomes.length, 1);
      assert.equal(finished.result.outcomes[0]!.state, "infrastructure-failed");
      assert.equal(finished.result.outcomes[0]!.episodeId, null);
      assert.equal(finished.result.counts.infrastructureFailed, 1);
      assert.equal(finished.error, null);
      assert.equal(
        finishedResult.content[0].text.includes("/private/path"),
        false
      );
      assert.equal(insertedBatches.length, 2);
      assert.equal(insertedEpisodes.length, 0);
      const [assigned, terminal] = insertedBatches as any[];
      assert.equal(assigned.revision, 1);
      assert.equal(assigned.status, "running");
      assert.equal(assigned.counts.assigned, 1);
      assert.equal(assigned.counts.started, 0);
      assert.equal(assigned.actionSchemaHash, null);
      assert.equal(assigned.observationSchemaHash, null);
      assert.equal(assigned.eventSchemaHash, null);
      assert.equal(terminal.revision, 2);
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.counts.assigned, 1);
      assert.equal(terminal.counts.infrastructureFailed, 1);
      assert.equal(terminal.actionSchemaHash, null);
      assert.equal(terminal.observationSchemaHash, null);
      assert.equal(terminal.eventSchemaHash, null);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test("workspace agent-role allowlists govern status, wait, and cancellation on the shared run owner", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-run-role-scope-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  let allowedRoles: readonly string[] = ["playtester"];
  try {
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "scope-owner"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      readWorkspaceCatalog: () => ({
        status: "valid",
        workspaces: [
          {
            id: WORKSPACE_ID,
            baseBranch: "main",
            enabled: true,
            agentRoles: allowedRoles
          }
        ]
      })
    });
    const analyst: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtest-analyst",
      actor: "analyst-1"
    };
    const denied = (error: unknown) =>
      error instanceof Error && error.name === "PlaytestMcpAuthorizationError";

    await assert.rejects(
      Promise.resolve().then(() =>
        server.playtestRunControl.listActiveRuns(analyst, WORKSPACE_ID)
      ),
      denied
    );
    await assert.rejects(
      server.playtestRunControl.waitForRun(
        analyst,
        WORKSPACE_ID,
        "batch-unknown",
        0
      ),
      denied
    );

    const controlViewer: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "control-viewer",
      actor: "console-viewer"
    };
    assert.deepEqual(
      await server.playtestRunControl.listActiveRuns(
        controlViewer,
        WORKSPACE_ID
      ),
      []
    );

    allowedRoles = ["playtest-analyst"];
    await assert.rejects(
      Promise.resolve().then(() =>
        server.playtestRunControl.cancelRun(
          {
            workspaceId: WORKSPACE_ID,
            role: "playtester",
            actor: "scope-owner"
          },
          WORKSPACE_ID,
          "batch-unknown"
        )
      ),
      denied
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP serializes concurrent assignment reservations before checking worker and episode budgets", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-assignment-lock-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(
    {
      ...createApproval(),
      limits: {
        ...createApproval().limits,
        workerCount: 1,
        episodeCount: 1
      }
    },
    null
  );

  try {
    const batchRows: PlaytestBatch[] = [];
    let runStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const repository: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => {
        const snapshot = [...batchRows];
        await new Promise((resolve) => setTimeout(resolve, 20));
        const latest = new Map<string, PlaytestBatch>();
        for (const batch of snapshot) {
          const previous = latest.get(batch.batchId);
          if (!previous || previous.revision < batch.revision) {
            latest.set(batch.batchId, batch);
          }
        }
        const rows = [...latest.values()];
        return { rows, total: rows.length, nextCursor: null };
      },
      listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        batchRows.push(batch);
      },
      insertEpisode: async () => {},
      insertReview: async () => {},
      insertFinding: async () => {}
    };
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "assignment-race"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: repository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: fixturePreparedSandbox,
      launchSandboxHandler: async () => fixtureSandbox("assignment-race"),
      runEpisodeHandler: async (options) => {
        runStarted();
        return new Promise((resolve) => {
          const finish = () =>
            resolve({
              capabilities: null,
              episode: null,
              steps: [],
              traceReference: null,
              sandboxResult: null,
              failure: {
                stage: "execution" as const,
                category: "cancelled" as const,
                code: null,
                disposition: "aborted"
              },
              loopDetectedAtStep: null
            });
          if (options.signal?.aborted) finish();
          else
            options.signal?.addEventListener("abort", finish, { once: true });
        });
      }
    });

    const session: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtester",
      actor: "assignment-race"
    };
    const attempts = await Promise.allSettled([
      server.playtestRunControl.startRun(session, {
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "race-1" }
        ]
      }),
      server.playtestRunControl.startRun(session, {
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "race-2" }
        ]
      })
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1
    );
    assert.equal(
      attempts.filter((result) => result.status === "rejected").length,
      1
    );
    await started;
    assert.equal(batchRows.length, 1);
    const activeBatchId = batchRows[0]!.batchId;
    await (server.playtestRunControl as PlaytestRunOwner).shutdown();
    const terminal = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      activeBatchId,
      2000
    );
    assert.equal(terminal.status, "cancelled");
    assert.equal(batchRows.length, 2);
    assert.equal(batchRows[1]!.revision, 2);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest batch remains cancellable while a completed assignment persists and peers are still running", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-incremental-batch-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(createApproval(), null);

  try {
    const insertedEpisodes: PlaytestEpisode[] = [];
    const insertedBatches: PlaytestBatch[] = [];
    let notifyFirstPersisted!: () => void;
    let notifySecondStarted!: () => void;
    const firstPersisted = new Promise<void>((resolve) => {
      notifyFirstPersisted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = resolve;
    });
    const repository: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({
        rows: insertedBatches,
        total: insertedBatches.length,
        nextCursor: null
      }),
      listEpisodes: async () => ({
        rows: insertedEpisodes,
        total: insertedEpisodes.length,
        nextCursor: null
      }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        insertedBatches.push(batch);
      },
      insertEpisode: async (episode) => {
        insertedEpisodes.push(episode);
        if (insertedEpisodes.length === 1) notifyFirstPersisted();
      },
      insertReview: async () => {},
      insertFinding: async () => {}
    };
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "partial-batch-owner"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: repository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: fixturePreparedSandbox,
      launchSandboxHandler: async (_prepared) =>
        fixtureSandbox("partial-batch-peer"),
      runEpisodeHandler: async (options) => {
        if (options.assignmentId === "a-0001") {
          return {
            capabilities: capabilitiesForRun(options),
            episode: {
              ...episodeForRun(options, "completed"),
              episodeId: "ep-partial-batch-a-0001"
            },
            steps: [],
            traceReference: null,
            sandboxResult: null,
            failure: null,
            loopDetectedAtStep: null
          };
        }
        notifySecondStarted();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true
          });
        });
        return {
          capabilities: capabilitiesForRun(options),
          episode: {
            ...episodeForRun(options, "cancelled"),
            episodeId: "ep-partial-batch-a-0002"
          },
          steps: [],
          traceReference: null,
          sandboxResult: null,
          failure: {
            stage: "execution",
            category: "cancelled",
            code: null,
            disposition: "aborted"
          },
          loopDetectedAtStep: null
        };
      }
    });
    const session: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtester",
      actor: "partial-batch-owner"
    };
    const started = await server.playtestRunControl.startRun(session, {
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "partial-1" },
        { scenario: "tutorial", policy: "random", seed: "partial-2" }
      ]
    });
    await Promise.all([secondStarted, firstPersisted]);
    let active = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      started.batchId,
      0
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const progress = active.result as {
        readonly counts: PlaytestCompletionCounts;
      };
      if (progress.counts.completed === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active = await server.playtestRunControl.waitForRun(
        session,
        WORKSPACE_ID,
        started.batchId,
        0
      );
    }
    assert.equal(active.status, "running");
    assert.equal(insertedEpisodes.length, 1);
    assert.equal(
      (active.result as { counts: PlaytestCompletionCounts }).counts.completed,
      1
    );

    const cancellation = await server.playtestRunControl.cancelRun(
      session,
      WORKSPACE_ID,
      started.batchId
    );
    assert.equal(cancellation.cancellationRequested, true);
    const completed = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      started.batchId,
      2000
    );
    assert.equal(completed.status, "cancelled");
    assert.deepEqual(
      (
        completed.result as { outcomes: readonly PlaytestAssignmentOutcome[] }
      ).outcomes.map((outcome) => outcome.state),
      ["completed", "cancelled"]
    );
    assert.equal(insertedBatches.at(-1)?.status, "cancelled");
    assert.deepEqual(
      {
        completed: insertedBatches.at(-1)?.counts.completed,
        cancelled: insertedBatches.at(-1)?.counts.cancelled,
        assigned: insertedBatches.at(-1)?.counts.assigned
      },
      { completed: 1, cancelled: 1, assigned: 2 }
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("review sampling selects complete sessions only and preserves truncated assignment denominators", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-reviewable-session-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  const approval = createApproval({
    limits: { ...createApproval().limits, critiqueCount: 1 }
  });
  approvalRepo.approve(approval, null);

  try {
    const insertedEpisodes: PlaytestEpisode[] = [];
    const insertedBatches: PlaytestBatch[] = [];
    const repository: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({
        rows: insertedBatches,
        total: insertedBatches.length,
        nextCursor: null
      }),
      listEpisodes: async () => ({
        rows: insertedEpisodes,
        total: insertedEpisodes.length,
        nextCursor: null
      }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        insertedBatches.push(batch);
      },
      insertEpisode: async (episode) => {
        insertedEpisodes.push(episode);
      },
      insertReview: async () => {},
      insertFinding: async () => {}
    };
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "complete-session-sampler"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: repository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: (workspaceApproval) => {
        const prepared = fixturePreparedSandbox(workspaceApproval);
        return {
          ...prepared,
          configuration: {
            ...prepared.configuration,
            analysis: {
              ...prepared.configuration.analysis,
              maxReviewedSessions: 1,
              reviewSelection: {
                surveillanceSessions: 1,
                discoverySessions: 0,
                discoverySignal: null
              }
            }
          }
        };
      },
      launchSandboxHandler: async () => fixtureSandbox("complete-session-test"),
      runEpisodeHandler: async (options) => {
        const truncated = options.assignmentId === "a-0002";
        const episode = episodeForRun(options, "completed");
        return {
          capabilities: capabilitiesForRun(options),
          episode: truncated
            ? {
                ...episode,
                episodeId: "ep-truncated-assignment",
                status: "budget-truncated",
                outcome: "unknown",
                completionCounts: {
                  ...episode.completionCounts,
                  completed: 0,
                  budgetTruncated: 1,
                  eligible: 0
                },
                completeness: "partial",
                missingReasons: ["budget-truncated"]
              }
            : { ...episode, episodeId: "ep-complete-assignment" },
          steps: [],
          traceReference: null,
          sandboxResult: null,
          failure: null,
          loopDetectedAtStep: null
        };
      }
    });

    const session: PlaytestMcpSession = {
      workspaceId: WORKSPACE_ID,
      role: "playtester",
      actor: "complete-session-sampler"
    };
    const started = await server.playtestRunControl.startRun(session, {
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "complete-seed" },
        { scenario: "tutorial", policy: "random", seed: "truncated-seed" }
      ]
    });
    const finished = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      started.batchId,
      2000
    );
    assert.equal(finished.status, "truncated");
    const result = finished.result as {
      readonly counts: PlaytestCompletionCounts;
      readonly reviewSelection: {
        readonly reviewablePopulation: number;
        readonly unreviewableAssignments: number;
        readonly selected: readonly { readonly assignmentId: string }[];
      };
    };
    assert.equal(result.counts.assigned, 2);
    assert.equal(result.counts.completed, 1);
    assert.equal(result.counts.budgetTruncated, 1);
    assert.equal(result.reviewSelection.reviewablePopulation, 1);
    assert.equal(result.reviewSelection.unreviewableAssignments, 1);
    assert.deepEqual(
      result.reviewSelection.selected.map((unit) => unit.assignmentId),
      ["a-0001"]
    );
    assert.equal(insertedBatches.at(-1)?.status, "truncated");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP: per-run cancellation and approval/workspace revocation abort the active sandbox", async () => {
  for (const trigger of ["cancel", "revoke", "disable"] as const) {
    const tmpRoot = realpathSync(
      mkdtempSync(path.join(tmpdir(), "playtest-mcp-cancel-test-"))
    );
    mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: path.join(tmpRoot, "artifacts")
    });
    const approvalRepo = new WorkspacePlaytestApprovalRepository(
      path.join(tmpRoot, "approvals")
    );
    const approval = createApproval();
    approvalRepo.approve(
      { ...approval, limits: { ...approval.limits, workerCount: 1 } },
      null
    );

    try {
      let workspaceEnabled = true;
      const insertedEpisodes: PlaytestEpisode[] = [];
      const insertedBatches: any[] = [];
      let cancelCalls = 0;
      const mockRepo: PlaytestingRepositoryOps = {
        getBatch: async () => null,
        listBatches: async () => ({
          rows: insertedBatches,
          total: insertedBatches.length,
          nextCursor: null
        }),
        listEpisodes: async () => ({
          rows: insertedEpisodes,
          total: insertedEpisodes.length,
          nextCursor: null
        }),
        listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
        listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
        listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
        listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
        listHumanStudies: async () => ({
          rows: [],
          total: 0,
          nextCursor: null
        }),
        getEpisode: async () => null,
        getLatestReviewForEpisode: async () => null,
        getFinding: async () => null,
        getLatestFindingByFingerprint: async () => null,
        getLatestReview: async () => null,
        getLatestComparison: async () => null,
        insertComparison: async () => {},
        insertBatch: async (batch) => {
          insertedBatches.push(batch);
        },
        insertEpisode: async (episode) => {
          insertedEpisodes.push(episode);
        },
        insertReview: async () => {},
        insertFinding: async () => {}
      };
      const server = createTestPlaytestMcpServer({
        sessionProvider: {
          current: () => ({
            workspaceId: WORKSPACE_ID,
            role: "playtester",
            actor: "actor-owner",
            taskId: "task-owner",
            runId: "run-owner"
          })
        },
        artifactStoreForWorkspace: () => artifacts,
        approvalRepository: approvalRepo,
        playtestRepository: mockRepo,
        readWorkspaceCatalog: () => ({
          status: "valid",
          workspaces: [
            {
              id: WORKSPACE_ID,
              baseBranch: "main",
              enabled: workspaceEnabled,
              agentRoles: null
            }
          ]
        }),
        prepareSandboxHandler: fixturePreparedSandbox,
        launchSandboxHandler: async () => {
          const sandbox = fixtureSandbox("cancel-" + trigger);
          return {
            ...sandbox,
            cancel: async () => {
              cancelCalls += 1;
            }
          };
        },
        runEpisodeHandler: async (options) => {
          const signal = options.signal!;
          return new Promise((resolve) => {
            const onAbort = () =>
              resolve({
                capabilities: capabilitiesForRun(options),
                episode: episodeForRun(options),
                steps: [],
                traceReference: null,
                sandboxResult: null,
                failure: {
                  stage: "execution" as const,
                  category: "cancelled" as const,
                  code: null,
                  disposition: "aborted"
                },
                loopDetectedAtStep: null
              });
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      });

      const runRequest = {
        assignments: [
          { scenario: "tutorial", policy: "random", seed: "cancel-seed" }
        ]
      };
      const runPromise =
        trigger === "disable"
          ? server.playtestRunControl.startRun(
              {
                workspaceId: WORKSPACE_ID,
                role: "playtester",
                actor: "actor-owner",
                taskId: "task-owner",
                runId: "run-owner"
              },
              runRequest
            )
          : (server as any)._registeredTools["playtest.run"].handler(
              runRequest
            );
      const startedResponse = await runPromise;
      const started =
        "content" in startedResponse
          ? JSON.parse(startedResponse.content[0].text)
          : startedResponse;
      assert.equal(started.status, "running");
      const active = await waitForActiveRun(server);
      assert.equal(active.batchId, started.batchId);
      assert.deepEqual(
        await server.playtestRunControl.listActiveRuns(
          {
            workspaceId: WORKSPACE_ID,
            role: "playtester",
            actor: "actor-owner",
            taskId: "task-owner",
            runId: "run-owner"
          },
          WORKSPACE_ID
        ),
        [active]
      );

      const overWorkerBudget = await (server as any)._registeredTools[
        "playtest.run"
      ].handler(
        singleAssignmentRequest("tutorial", "random", "concurrent-seed")
      );
      assert.equal(
        parsedMcpError(overWorkerBudget).code,
        "playtest_invalid_request"
      );

      await triggerCancellation(
        trigger,
        server,
        approvalRepo,
        () => {
          workspaceEnabled = false;
        },
        active.batchId
      );

      const waitResult = await (server as any)._registeredTools[
        "playtest.wait"
      ].handler({ batchId: active.batchId, waitMs: 2000 });
      assert.equal(waitResult.isError, undefined);
      const run = JSON.parse(waitResult.content[0].text);
      assert.equal(run.batchId, active.batchId);
      assert.equal(run.status, "cancelled");
      const expectedReason = {
        cancel: "cancelled",
        revoke: "approval-revoked",
        disable: "workspace-disabled"
      }[trigger];
      assert.equal(run.cancellationReason, expectedReason);
      assert.equal(run.result.outcomes.length, 1);
      assert.equal(run.result.outcomes[0]!.state, "cancelled");
      assert.equal(run.result.outcomes[0]!.started, true);
      assert.equal(insertedEpisodes.length, 1);
      assert.equal(insertedBatches.length, 2);
      assert.equal(insertedBatches[0]!.revision, 1);
      assert.equal(insertedBatches[1]!.revision, 2);
      assert.equal(insertedBatches[1]!.status, "cancelled");
      assert.equal(insertedBatches[1]!.cancellationReason, expectedReason);
      assert.equal(cancelCalls > 0, true);
      assert.equal(
        insertedEpisodes[0]!.missingReasons.includes("revoked"),
        trigger !== "cancel"
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

test("run status restores interrupted batch progress from Data and durably closes unknown assignments", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-recovery-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approval = createApproval();
  const prepared = fixturePreparedSandbox(approval);
  const observationContract = prepared.observationContract;
  const policy = createSeededRandomPlaytestPolicy();
  const createdAt = "2026-10-10T00:00:00.000Z";
  const manifestBase = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    batchId: "batch-after-restart",
    workspaceId: WORKSPACE_ID,
    buildSha: approval.buildSha,
    configHash: approval.playtestConfigHash,
    rubricHash: prepared.rubricHash,
    approvalRevision: approval.revision,
    createdAt,
    assignments: [
      {
        assignmentId: "a-0001",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial-family",
        policyId: policy.id,
        policyVersion: policy.version,
        cohort: policy.cohort,
        seed: "recovery-1",
        maxSteps: 50
      },
      {
        assignmentId: "a-0002",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial-family",
        policyId: policy.id,
        policyVersion: policy.version,
        cohort: policy.cohort,
        seed: "recovery-2",
        maxSteps: 50
      }
    ]
  } as const;
  const manifest = {
    ...manifestBase,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestBase))
      .digest("hex")
  };
  const coverageManifest = makeCoverageManifest({
    rubricHash: prepared.rubricHash,
    assignmentManifestHash: manifest.contentHash,
    mode: observationContract.mode,
    generatedAt: createdAt,
    batchId: manifest.batchId,
    workspaceId: manifest.workspaceId,
    buildSha: manifest.buildSha,
    plan: playtestCoveragePlanForRegistry(prepared.rubric),
    assignments: manifest.assignments,
    episodes: []
  });
  const recordedEpisode = {
    ...episodeForRun(
      {
        approval,
        repository: WORKSPACE_ID,
        batchId: manifest.batchId,
        assignmentId: "a-0001",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial-family",
        seed: "recovery-1",
        policy,
        observationContract,
        runtimeVersion: "1.0.0",
        environmentHash: "f".repeat(64)
      },
      "completed"
    ),
    episodeId: "ep-recovered-before-restart"
  };
  let storedBatch: PlaytestBatch = {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: manifest.batchId,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha: approval.buildSha,
    gameBuild: approval.gameBuild,
    configHash: approval.playtestConfigHash,
    rubricHash: prepared.rubricHash,
    actionSchemaHash: recordedEpisode.identity.actionSchemaHash,
    observationSchemaHash: observationContract.schemaHash,
    eventSchemaHash: recordedEpisode.identity.eventSchemaHash,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: [policy.id],
    cohortIds: [policy.cohort],
    scenarioIds: ["tutorial"],
    assignmentInventory: { status: "frozen", manifest },
    coverageManifest,
    reviewPackets: [],
    unobservedAssignments: [],
    reviewSelection: { status: "pending" },
    reviewReceipts: [],
    status: "running",
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 2,
      started: 0,
      completed: 0,
      crashed: 0,
      infrastructureFailed: 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: 0
    },
    budget: {
      assignedEpisodes: 2,
      maxStepsPerEpisode: 50,
      wallTimeMs: approval.limits.wallTimeMs,
      critiqueBudget: approval.limits.critiqueCount,
      actualCritiques: 0
    },
    startedAt: createdAt,
    completedAt: null,
    createdAt,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha: approval.buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: createdAt
    },
    evaluationIds: [],
    spanIds: []
  };
  const batchWrites: PlaytestBatch[] = [];
  const initialRunningBatch = storedBatch;
  const repository: PlaytestingRepositoryOps = {
    getBatch: async (_workspaceId, batchId) =>
      batchId === storedBatch.batchId ? storedBatch : null,
    listBatches: async () => ({
      rows: [storedBatch],
      total: 1,
      nextCursor: null
    }),
    listEpisodes: async (filter) => {
      assert.equal(filter.workspaceId, WORKSPACE_ID);
      assert.equal(filter.batchId, manifest.batchId);
      return { rows: [recordedEpisode], total: 1, nextCursor: null };
    },
    listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
    listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
    listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
    listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
    listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
    getEpisode: async () => null,
    getLatestReviewForEpisode: async () => null,
    getFinding: async () => null,
    getLatestFindingByFingerprint: async () => null,
    getLatestReview: async () => null,
    getLatestComparison: async () => null,
    insertComparison: async () => {},
    insertBatch: async (batch) => {
      storedBatch = batch;
      batchWrites.push(batch);
    },
    insertEpisode: async () => {},
    insertReview: async () => {},
    insertFinding: async () => {}
  };
  const server = createTestPlaytestMcpServer({
    sessionProvider: {
      current: () => ({
        workspaceId: WORKSPACE_ID,
        role: "playtester",
        actor: "recovered-run-reader"
      })
    },
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    readWorkspaceCatalog: enabledWorkspaceCatalog()
  });
  const session: PlaytestMcpSession = {
    workspaceId: WORKSPACE_ID,
    role: "playtester",
    actor: "recovered-run-reader"
  };

  try {
    const recovered = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      manifest.batchId,
      0
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.error?.code, "playtest_run_interrupted");
    const result = recovered.result as {
      readonly outcomes: readonly PlaytestAssignmentOutcome[];
      readonly counts: PlaytestCompletionCounts;
    };
    assert.deepEqual(
      result.outcomes.map((outcome) => ({
        assignmentId: outcome.assignmentId,
        episodeId: outcome.episodeId,
        state: outcome.state
      })),
      [
        {
          assignmentId: "a-0001",
          episodeId: recordedEpisode.episodeId,
          state: "completed"
        },
        {
          assignmentId: "a-0002",
          episodeId: null,
          state: "infrastructure-failed"
        }
      ]
    );
    assert.equal(result.counts.completed, 1);
    assert.equal(result.counts.infrastructureFailed, 1);
    assert.equal(storedBatch.revision, 2);
    assert.equal(storedBatch.status, "failed");
    assert.equal(storedBatch.failureReason, "nonterminal-batch-recovered");
    assert.equal(storedBatch.completedAt !== null, true);
    assert.deepEqual(
      storedBatch.unobservedAssignments?.map((outcome) => outcome.assignmentId),
      ["a-0002"]
    );
    assert.equal(batchWrites.length, 1);

    const restoredTerminal = await server.playtestRunControl.waitForRun(
      session,
      WORKSPACE_ID,
      manifest.batchId,
      0
    );
    assert.equal(restoredTerminal.status, "failed");
    assert.equal(restoredTerminal.error?.code, "playtest_run_interrupted");
    assert.equal(batchWrites.length, 1);

    // A fresh process also reconciles orphaned running rows when the active
    // run list is read, rather than reporting an empty active set forever.
    let listBatch = initialRunningBatch;
    const listRepository: PlaytestingRepositoryOps = {
      ...repository,
      getBatch: async (_workspaceId, batchId) =>
        batchId === listBatch.batchId ? listBatch : null,
      listBatches: async () => ({
        rows: [listBatch],
        total: 1,
        nextCursor: null
      }),
      insertBatch: async (batch) => {
        listBatch = batch;
        batchWrites.push(batch);
      }
    };
    const restartedServer = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "recovered-run-reader"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: listRepository,
      readWorkspaceCatalog: enabledWorkspaceCatalog()
    });
    const [activeRuns, restoredStatus] = await Promise.all([
      restartedServer.playtestRunControl.listActiveRuns(session, WORKSPACE_ID),
      restartedServer.playtestRunControl.waitForRun(
        session,
        WORKSPACE_ID,
        manifest.batchId,
        0
      )
    ]);
    assert.deepEqual(activeRuns, []);
    assert.equal(restoredStatus.status, "failed");
    assert.equal(restoredStatus.error?.code, "playtest_run_interrupted");
    assert.equal(listBatch.status, "failed");
    assert.equal(listBatch.revision, 2);
    assert.equal(listBatch.failureReason, "nonterminal-batch-recovered");
    assert.equal(batchWrites.length, 2);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP: batch-only contract rejects unapproved cells and over-budget inventories before any sandbox launches", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-batch-adversarial-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  // Two assignment cells: 1 worker, 1 episode fits the approval at one cell.
  approvalRepo.approve(
    {
      ...createApproval(),
      limits: {
        ...createApproval().limits,
        workerCount: 1,
        episodeCount: 1,
        maxStepsPerEpisode: 10
      }
    },
    null
  );

  try {
    const insertedBatches: any[] = [];
    let launchAttempts = 0;
    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({
        rows: insertedBatches,
        total: insertedBatches.length,
        nextCursor: null
      }),
      listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        insertedBatches.push(batch);
      },
      insertEpisode: async () => {},
      insertReview: async () => {},
      insertFinding: async () => {}
    };
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
          actor: "batch-adversary"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: fixturePreparedSandbox,
      launchSandboxHandler: async () => {
        launchAttempts += 1;
        return fixtureSandbox("batch-adversary");
      },
      runEpisodeHandler: async () => ({
        capabilities: null,
        episode: null,
        steps: [],
        traceReference: null,
        sandboxResult: null,
        failure: {
          stage: "execution" as const,
          category: "adapter" as const,
          code: null,
          disposition: "should not run"
        },
        loopDetectedAtStep: null
      })
    });

    // 1. Any unapproved cell rejects the whole batch before launch.
    const unapprovedCell = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "cell-1" },
        { scenario: "missing-scenario", policy: "random", seed: "cell-2" }
      ]
    });
    assert.equal(
      parsedMcpError(unapprovedCell).code,
      "playtest_invalid_request"
    );
    assert.equal(launchAttempts, 0);
    assert.equal(insertedBatches.length, 0);

    // 2. Over-budget: two cells, but the approval allows only one episode.
    const overBudget = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      assignments: [
        { scenario: "tutorial", policy: "random", seed: "cell-1" },
        { scenario: "tutorial", policy: "random", seed: "cell-2" }
      ]
    });
    assert.equal(parsedMcpError(overBudget).code, "playtest_invalid_request");
    assert.equal(launchAttempts, 0);
    assert.equal(insertedBatches.length, 0);

    // 3. A cell whose maxSteps exceeds the approved budget is rejected, not
    //    silently truncated.
    const overStepCell = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      assignments: [
        {
          scenario: "tutorial",
          policy: "random",
          seed: "big-step",
          maxSteps: 1_000_000
        }
      ]
    });
    assert.equal(parsedMcpError(overStepCell).code, "playtest_invalid_request");
    assert.equal(launchAttempts, 0);
    assert.equal(insertedBatches.length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest.branch reuses approved batch ownership, budgets replay steps, mounts verified trace and persists lineage", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-branch-test-"))
  );
  mkdirSync(path.join(tmpRoot, "artifacts"), { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: path.join(tmpRoot, "artifacts")
  });
  const approval = createApproval();
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(approval, null);

  try {
    let currentRole = "playtest-analyst";
    const insertedBatches: PlaytestBatch[] = [];
    const insertedEpisodes: PlaytestEpisode[] = [];
    const parentPolicy = createSeededRandomPlaytestPolicy();
    const parent = episodeForRun(
      {
        approval,
        repository: WORKSPACE_ID,
        batchId: "batch-source",
        assignmentId: "a-source",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial-family",
        seed: "branch-seed-1",
        policy: parentPolicy,
        observationContract:
          fixturePreparedSandbox(approval).observationContract,
        runtimeVersion: "runtime-v1",
        environmentHash: "d".repeat(64)
      },
      "completed"
    );
    const checkpoint = {
      stateHash: "f".repeat(64),
      rngCheckpoint: {
        algorithm: "fixture-rng",
        version: "fixture-rng-v1",
        stateHash: "e".repeat(64),
        reproducible: true
      }
    } as const;
    const sourceTrace = artifacts.writeWindow({
      entries: [
        {
          step: 3,
          executed: true,
          selectedActionId: "advance",
          legalActionIds: ["advance", "cool-down"],
          checkpoint
        }
      ]
    });
    const sourceEpisode: PlaytestEpisode = {
      ...parent,
      episodeId: "ep-branch-source",
      batchId: "batch-source",
      revision: 2,
      trace: { kind: "replay-segment", id: sourceTrace.reference.artifactId },
      stepCount: 4,
      identity: {
        ...parent.identity,
        rngInitialStateHash: "e".repeat(64),
        rngAlgorithm: "fixture-rng",
        rngVersion: "fixture-rng-v1"
      }
    };
    const wrongBuildSource: PlaytestEpisode = {
      ...sourceEpisode,
      episodeId: "ep-branch-wrong-build",
      identity: { ...sourceEpisode.identity, buildSha: "f".repeat(40) }
    };
    const storedEpisodes = [sourceEpisode, wrongBuildSource];
    let capturedInput: {
      reference: { sha256: string };
      bytes: Uint8Array;
    } | null = null;
    let capturedBranchOptions: PlaytestEpisodeRunOptions["branch"];
    let stallNextBranch = false;
    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async (filter) => {
        const latest = new Map<string, PlaytestBatch>();
        for (const batch of insertedBatches) {
          const current = latest.get(batch.batchId);
          if (!current || current.revision < batch.revision) {
            latest.set(batch.batchId, batch);
          }
        }
        const rows = [...latest.values()].filter(
          (batch) =>
            batch.workspaceId === filter.workspaceId &&
            (filter.status === undefined || batch.status === filter.status) &&
            (filter.buildSha === undefined ||
              batch.buildSha === filter.buildSha)
        );
        return { rows, total: rows.length, nextCursor: null };
      },
      listEpisodes: async (filter) => {
        const rows = [...storedEpisodes, ...insertedEpisodes].filter(
          (episode) =>
            episode.identity.workspaceId === filter.workspaceId &&
            (filter.batchId === undefined || episode.batchId === filter.batchId)
        );
        return { rows, total: rows.length, nextCursor: null };
      },
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async (workspaceId, episodeId) =>
        [...storedEpisodes, ...insertedEpisodes].find(
          (episode) =>
            episode.identity.workspaceId === workspaceId &&
            episode.episodeId === episodeId
        ) ?? null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        insertedBatches.push(batch);
      },
      insertEpisode: async (episode) => {
        insertedEpisodes.push(episode);
      },
      insertReview: async () => {},
      insertFinding: async () => {}
    };
    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: currentRole,
          actor: "branch-operator"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      prepareSandboxHandler: fixturePreparedSandbox,
      launchSandboxHandler: async (_prepared, launchOptions) => {
        capturedInput = launchOptions?.inputArtifacts?.[0] ?? null;
        return fixtureSandbox("branch-fixture");
      },
      runEpisodeHandler: async (options) => {
        capturedBranchOptions = options.branch;
        assert.ok(options.branch);
        if (stallNextBranch) {
          stallNextBranch = false;
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
            } else {
              options.signal?.addEventListener("abort", () => resolve(), {
                once: true
              });
            }
          });
        }
        const episodeStatus = options.signal?.aborted
          ? "cancelled"
          : "completed";
        const snapshot = artifacts.writeArtifact({
          mediaType: "application/vnd.fixture.snapshot",
          bytes: new TextEncoder().encode("persisted synthetic snapshot")
        }).reference;
        const trace = artifacts.writeWindow({
          entries: [
            {
              step: 0,
              executed: true,
              selectedActionId: options.branch.manifest.alternativeActionId,
              checkpoint: options.branch.manifest.parentCheckpoint
            }
          ]
        }).reference;
        const episode = episodeForRun(
          {
            approval: options.approval,
            repository: options.repository,
            batchId: options.batchId,
            assignmentId: options.assignmentId,
            scenarioId: options.scenarioId,
            scenarioFamily: options.scenarioFamily,
            seed: options.seed,
            policy: options.policy,
            observationContract: options.observationContract,
            runtimeVersion: options.runtimeVersion,
            environmentHash: options.environmentHash
          },
          episodeStatus
        );
        const parentIdentity = options.branch.parentEpisode.identity;
        return {
          capabilities: capabilitiesForRun(options),
          episode: {
            ...episode,
            episodeId: "ep-branch-" + options.batchId,
            trace: { kind: "replay-segment", id: trace.artifactId },
            stepCount: 1,
            identity: {
              ...episode.identity,
              rngInitialStateHash: parentIdentity.rngInitialStateHash,
              rngAlgorithm: parentIdentity.rngAlgorithm,
              rngVersion: parentIdentity.rngVersion
            },
            branchLineage: {
              ...options.branch.manifest,
              replayTransitionHash: "d".repeat(64),
              snapshotArtifact: snapshot,
              snapshotIntegrityHash: snapshot.sha256,
              forkStateHash: options.branch.manifest.parentCheckpoint.stateHash,
              forkRngCheckpoint:
                options.branch.manifest.parentCheckpoint.rngCheckpoint,
              continuationPolicyId: options.policy.id,
              continuationPolicyVersion: options.policy.version
            }
          },
          steps: [],
          traceReference: trace,
          sandboxResult: null,
          failure: null,
          loopDetectedAtStep: null
        };
      }
    });

    const branchTool = (server as any)._registeredTools["playtest.branch"]
      .handler;
    const request = {
      parentEpisodeId: sourceEpisode.episodeId,
      branchStep: 3,
      alternativeActionId: "cool-down",
      policy: "random",
      maxSteps: 2
    };
    const denied = await branchTool(request);
    assert.equal(parsedMcpError(denied).code, "playtest_forbidden");

    currentRole = "playtester";
    const wrongBuild = await branchTool({
      ...request,
      parentEpisodeId: wrongBuildSource.episodeId
    });
    assert.equal(parsedMcpError(wrongBuild).code, "playtest_invalid_request");
    const unavailableAction = await branchTool({
      ...request,
      alternativeActionId: "not-advertised"
    });
    assert.equal(
      parsedMcpError(unavailableAction).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedBatches.length, 0);

    const started = await branchTool(request);
    assert.equal(started.isError, undefined);
    const batchId = JSON.parse(started.content[0].text).batchId as string;
    const terminal = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({
      batchId,
      waitMs: 5000
    });
    assert.equal(JSON.parse(terminal.content[0].text).status, "completed");

    assert.equal(capturedBranchOptions?.manifest.branchStep, 3);
    assert.equal(
      capturedBranchOptions?.manifest.parentEpisodeId,
      sourceEpisode.episodeId
    );
    assert.equal(
      capturedBranchOptions?.manifest.alternativeActionId,
      "cool-down"
    );
    const mountedInput = capturedInput as {
      reference: { sha256: string };
      bytes: Uint8Array;
    } | null;
    assert.ok(mountedInput);
    assert.equal(mountedInput.reference.sha256, sourceTrace.reference.sha256);
    assert.deepEqual(
      mountedInput.bytes,
      artifacts.readWindow(sourceTrace.reference).bytes
    );
    assert.equal(insertedEpisodes.length, 1);
    const child = insertedEpisodes[0]!;
    assert.equal(child.branchLineage?.parentEpisodeId, sourceEpisode.episodeId);
    assert.equal(
      child.branchLineage?.parentTrace.sha256,
      sourceTrace.reference.sha256
    );
    assert.equal(child.branchLineage?.alternativeActionId, "cool-down");
    assert.equal(child.branchLineage?.rngPolicy, "same-stream");
    assert.ok(child.branchLineage?.snapshotArtifact);
    const batch = insertedBatches.at(-1)!;
    assert.equal(batch.assignmentInventory.status, "frozen");
    if (batch.assignmentInventory.status === "frozen") {
      const assignment = batch.assignmentInventory.manifest.assignments[0]!;
      assert.equal(assignment.maxSteps, 5);
      assert.equal(assignment.branch?.parentEpisodeId, sourceEpisode.episodeId);
      assert.equal(assignment.branch?.branchStep, 3);
    }

    const overBudget = await branchTool({ ...request, maxSteps: 48 });
    assert.equal(parsedMcpError(overBudget).code, "playtest_invalid_request");
    assert.equal(insertedBatches.length, 2);

    stallNextBranch = true;
    const cancelStart = await server.playtestRunControl.startRun(
      {
        workspaceId: WORKSPACE_ID,
        role: "playtester",
        actor: "branch-operator"
      },
      request
    );
    const cancelBatchId = cancelStart.batchId;
    const immediate = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({
      batchId: cancelBatchId,
      waitMs: 0
    });
    assert.equal(
      JSON.parse(immediate.content[0].text).status,
      "running",
      immediate.content[0].text
    );
    const cancelActive = await waitForActiveRun(server);
    assert.equal(cancelActive.batchId, cancelBatchId);
    const cancellation = await (server as any)._registeredTools[
      "playtest.cancel"
    ].handler({
      batchId: cancelBatchId
    });
    assert.equal(
      JSON.parse(cancellation.content[0].text).cancellationRequested,
      true
    );
    const cancelledStatus = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({
      batchId: cancelBatchId,
      waitMs: 5000
    });
    assert.equal(
      JSON.parse(cancelledStatus.content[0].text).status,
      "cancelled"
    );

    stallNextBranch = true;
    const revokeStart = await branchTool(request);
    const revokeBatchId = JSON.parse(revokeStart.content[0].text)
      .batchId as string;
    const revokeActive = await waitForActiveRun(server);
    assert.equal(revokeActive.batchId, revokeBatchId);
    const activeApproval = approvalRepo.read(WORKSPACE_ID)!;
    approvalRepo.revoke(
      WORKSPACE_ID,
      activeApproval.approvalId,
      activeApproval.revision,
      new Date().toISOString(),
      "fixture-operator",
      "branch-revocation-test"
    );
    const revokedStatus = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({
      batchId: revokeBatchId,
      waitMs: 5000
    });
    const revokedRun = JSON.parse(revokedStatus.content[0].text);
    assert.equal(revokedRun.status, "cancelled");
    assert.equal(revokedRun.cancellationReason, "approval-revoked");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: submitReview validates evidence against the real stored index and enforces analyst role", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  const artifactsDir = path.join(tmpRoot, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: artifactsDir
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );

  try {
    let currentRole = "playtester";
    const insertedReviews: PlaytestSessionReview[] = [];
    const insertedFindings: PlaytestFinding[] = [];
    const existingFindingOverrides = new Map<string, PlaytestFinding>();
    let failReceiptWrite = false;
    let failFindingTitle: string | null = null;
    let peerFindingPersisted = false;
    let releaseFindingFailure: (() => void) | null = null;

    // Write a real trace artifact for the episode so the known-evidence
    // index can be built from the actual persisted record, not from
    // whatever the caller claims.
    const traceSteps: PlaytestEvidenceTraceStep[] = Array.from(
      { length: 3 },
      (_, step) => ({
        step,
        phaseId: "fixture-phase",
        revisionBefore: step,
        revisionAfter: step + 1,
        observationVisibility: "structured",
        visibleObservation: { step, player: { visible: true } },
        legalActionIds: ["jump", "wait"],
        selectedActionId: "jump",
        preActionPrediction: null,
        authoritativeOutcome: null,
        events: [
          {
            eventId: `evt-real-${String(step + 1)}`,
            type: "collision",
            phaseId: "fixture-phase",
            revision: step + 1
          }
        ],
        frameRefs: []
      })
    );
    const traceWrite = artifacts.writeWindow({ entries: traceSteps });

    const realEpisode: PlaytestEpisode = {
      schema: "autodev-playtest-episode-v3",
      episodeId: "ep-1",
      revision: 1,
      batchId: "batch-1",
      assignmentId: "a-0001",
      branchLineage: null,
      identity: {
        workspaceId: WORKSPACE_ID,
        repository: WORKSPACE_ID,
        buildSha: "a".repeat(40),
        gameBuild: "build-1",
        scenarioId: "tutorial",
        configHash: "b".repeat(64),
        seed: "seed-1",
        rngInitialStateHash: null,
        rngAlgorithm: null,
        rngVersion: null,
        policyId: "random",
        policyVersion: "v1",
        modelId: null,
        modelRevision: null,
        observationSchemaHash: "b".repeat(64),
        actionSchemaHash: "b".repeat(64),
        eventSchemaHash: "b".repeat(64),
        protocolVersion: 1,
        runtimeVersion: "1.0.0",
        environmentHash: "b".repeat(64)
      },
      scenarioFamily: "tutorial-family",
      policyCohort: "random",
      strategy: "random",
      status: "completed",
      outcome: "win",
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
      trace: { kind: "replay-segment", id: traceWrite.reference.artifactId },
      frames: [],
      stepCount: 3,
      metrics: [],
      findingIds: [],
      assignedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      simulationWallMs: 1,
      logicalTicks: 1,
      policyInferenceMs: 1,
      nativeDurationMs: null,
      completeness: "complete",
      missingReasons: []
    };

    const anomalyMetric = (
      estimate: number
    ): PlaytestEpisode["metrics"][number] => ({
      metricId: "anomaly",
      metricVersion: 1,
      phaseId: null,
      numerator: estimate,
      denominator: 1,
      opportunityCount: 1,
      coverage: 1,
      unit: "fixture-score",
      estimate,
      missing: 0,
      missingReasons: [],
      independentUnits: 1,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: realEpisode.identity.buildSha,
        evaluatorHash: "f".repeat(64),
        rubricHash: "f".repeat(64),
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        generatedAt: realEpisode.assignedAt
      },
      notes: "Synthetic discovery signal for selection-boundary testing."
    });
    const episodeOne: PlaytestEpisode = {
      ...realEpisode,
      metrics: [anomalyMetric(1)]
    };
    const episodeTwo: PlaytestEpisode = {
      ...realEpisode,
      episodeId: "ep-2",
      assignmentId: "a-0002",
      branchLineage: null,
      identity: { ...realEpisode.identity, seed: "seed-2" },
      metrics: [anomalyMetric(0)]
    };

    const assignmentManifestBase = {
      schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
      batchId: "batch-1",
      workspaceId: WORKSPACE_ID,
      buildSha: realEpisode.identity.buildSha,
      configHash: realEpisode.identity.configHash,
      rubricHash: "f".repeat(64),
      approvalRevision: 1,
      createdAt: realEpisode.assignedAt,
      assignments: [
        {
          assignmentId: "a-0001",
          scenarioId: realEpisode.identity.scenarioId,
          scenarioFamily: realEpisode.scenarioFamily,
          policyId: realEpisode.identity.policyId,
          policyVersion: realEpisode.identity.policyVersion,
          cohort: realEpisode.policyCohort,
          seed: realEpisode.identity.seed,
          maxSteps: 50
        },
        {
          assignmentId: "a-0002",
          scenarioId: episodeTwo.identity.scenarioId,
          scenarioFamily: episodeTwo.scenarioFamily,
          policyId: episodeTwo.identity.policyId,
          policyVersion: episodeTwo.identity.policyVersion,
          cohort: episodeTwo.policyCohort,
          seed: episodeTwo.identity.seed,
          maxSteps: 50
        }
      ]
    } as const;
    const assignmentManifest = {
      ...assignmentManifestBase,
      contentHash: createHash("sha256")
        .update(playtestAssignmentManifestHashInput(assignmentManifestBase))
        .digest("hex")
    };
    const reviewSelection = selectPlaytestBatchReviews({
      inventoryHash: assignmentManifest.contentHash,
      maxReviewedSessions: 9,
      critiqueBudget: 9,
      surveillanceSessions: 0,
      discoverySessions: 1,
      discoverySignal: {
        metricId: "anomaly",
        version: 1,
        direction: "higher-first"
      },
      candidates: [
        {
          assignmentId: "a-0001",
          episodeId: episodeOne.episodeId,
          policyId: episodeOne.identity.policyId,
          scenarioId: episodeOne.identity.scenarioId,
          outcomeKey: playtestReviewOutcomeKey("completed", episodeOne.outcome),
          metrics: episodeOne.metrics
        },
        {
          assignmentId: "a-0002",
          episodeId: episodeTwo.episodeId,
          policyId: episodeTwo.identity.policyId,
          scenarioId: episodeTwo.identity.scenarioId,
          outcomeKey: playtestReviewOutcomeKey("completed", episodeTwo.outcome),
          metrics: episodeTwo.metrics
        }
      ],
      unreviewableAssignments: 0,
      selectedAt: realEpisode.assignedAt
    });
    const coverageManifest = makeCoverageManifest({
      rubricHash: "f".repeat(64),
      assignmentManifestHash: assignmentManifest.contentHash,
      mode: "headless",
      generatedAt: realEpisode.assignedAt,
      batchId: assignmentManifest.batchId,
      workspaceId: assignmentManifest.workspaceId,
      buildSha: assignmentManifest.buildSha,
      plan: [
        {
          coverageMetricId: "anomaly",
          metricVersion: 1,
          mechanicKey: "fixture-anomaly",
          phaseId: "fixture-phase",
          scenarioFamily: realEpisode.scenarioFamily,
          cohort: realEpisode.policyCohort,
          policy: realEpisode.identity.policyId,
          modality: "headless",
          analysisUnit: "episode",
          requiredOpportunities: 1,
          requiredIndependentUnits: 1,
          unsupportedReason: null
        }
      ],
      assignments: assignmentManifest.assignments,
      episodes: [episodeOne, episodeTwo]
    });
    const reviewDimensionRubric: PlaytestDimensionRubric = {
      dimensionId: "collision-agency",
      version: 1,
      unit: "episode",
      indicator: "anomaly@1",
      modality: "headless",
      minExposure: 1,
      minIndependentUnits: 1,
      scoreBands: [
        { score: 0, equals: 0 },
        { score: 1, greaterThan: 0, atMost: 0.25 },
        { score: 2, greaterThan: 0.25, atMost: 0.5 },
        { score: 3, greaterThan: 0.5, atMost: 0.75 },
        { score: 4, greaterThan: 0.75, atMost: 1 }
      ],
      counterexample:
        "A safe alternative avoids collision without lost progress.",
      evidenceChecklist: [
        "legal alternative observed",
        "source collision event"
      ],
      insufficient: "null",
      humanOutcomeMapping: null
    };
    const unsupportedVisualRubric: PlaytestDimensionRubric = {
      ...reviewDimensionRubric,
      dimensionId: "visual-clarity",
      indicator: "visual-clarity@1",
      modality: "native-visual"
    };
    const packet = buildPlaytestEvidencePacket({
      packetId: "packet-ep-1",
      episode: episodeOne,
      assignment: assignmentManifest.assignments[0],
      registry: fixturePlaytestMetricRegistry(WORKSPACE_ID, "anomaly", [
        reviewDimensionRubric,
        unsupportedVisualRubric
      ]),
      coverageManifest,
      crossSessionCandidates: [
        {
          episode: episodeTwo,
          assignment: assignmentManifest.assignments[1]!
        }
      ],
      crossSessionSelectionSeed: "cross-session-fixture-seed-v1",
      crossSessionInventoryHash: createHash("sha256")
        .update(
          playtestCrossSessionInventoryHashInput([
            {
              episode: episodeTwo,
              assignment: assignmentManifest.assignments[1]!
            }
          ])
        )
        .digest("hex"),
      rubricHash: "f".repeat(64),
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      traceHash: traceWrite.reference.sha256,
      traceSteps,
      frameHashes: {},
      modelId: null,
      modelRevision: null,
      promptHash: null,
      tokenBudget: 32_768,
      generatedAt: realEpisode.assignedAt
    });
    assertPlaytestEvidencePacket(packet);
    const packetArtifact = artifacts.writeArtifact({
      mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
      bytes: new TextEncoder().encode(JSON.stringify(packet))
    }).reference;
    let storedBatch: PlaytestBatch = {
      schema: PLAYTESTS_BATCH_SCHEMA,
      batchId: "batch-1",
      revision: 1,
      workspaceId: WORKSPACE_ID,
      repository: WORKSPACE_ID,
      buildSha: realEpisode.identity.buildSha,
      gameBuild: realEpisode.identity.gameBuild,
      configHash: realEpisode.identity.configHash,
      rubricHash: "f".repeat(64),
      actionSchemaHash: realEpisode.identity.actionSchemaHash,
      observationSchemaHash: realEpisode.identity.observationSchemaHash,
      eventSchemaHash: realEpisode.identity.eventSchemaHash,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      protocolVersion: 1,
      policyIds: [realEpisode.identity.policyId],
      cohortIds: [realEpisode.policyCohort],
      scenarioIds: [realEpisode.identity.scenarioId],
      assignmentInventory: { status: "frozen", manifest: assignmentManifest },
      coverageManifest,
      reviewPackets: [
        {
          status: "prepared",
          packetId: packet.packetId,
          assignmentId: "a-0001",
          episodeId: episodeOne.episodeId,
          artifact: packetArtifact,
          failureReason: null,
          createdAt: realEpisode.assignedAt
        }
      ],
      reviewSelection,
      unobservedAssignments: [],
      reviewReceipts: [],
      status: "completed",
      cancellationReason: null,
      failureReason: null,
      counts: {
        ...realEpisode.completionCounts,
        assigned: 2,
        started: 2,
        completed: 2,
        eligible: 2
      },
      budget: {
        assignedEpisodes: 2,
        maxStepsPerEpisode: 50,
        wallTimeMs: 60_000,
        critiqueBudget: 9,
        actualCritiques: 0
      },
      startedAt: realEpisode.startedAt,
      completedAt: realEpisode.completedAt,
      createdAt: realEpisode.assignedAt,
      provenance: {
        workspaceId: WORKSPACE_ID,
        buildSha: realEpisode.identity.buildSha,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        generatedAt: realEpisode.assignedAt
      },
      evaluationIds: [],
      spanIds: []
    };

    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async (_workspaceId, batchId) =>
        batchId === storedBatch.batchId ? storedBatch : null,
      listBatches: async () => ({ rows: [], total: 0, nextCursor: null }),
      listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
      listFindings: async () => ({
        rows: insertedFindings,
        total: insertedFindings.length,
        nextCursor: null
      }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async (_ws, epId) =>
        epId === episodeOne.episodeId
          ? episodeOne
          : epId === episodeTwo.episodeId
            ? episodeTwo
            : null,
      getLatestReviewForEpisode: async () => insertedReviews[0] ?? null,
      getFinding: async (_ws, findingId) =>
        insertedFindings.find((finding) => finding.findingId === findingId) ??
        null,
      getLatestFindingByFingerprint: async (_ws, fingerprint) =>
        existingFindingOverrides.get(fingerprint) ??
        [...insertedFindings]
          .filter((finding) => finding.fingerprint === fingerprint)
          .sort((a, b) => b.version - a.version)[0] ??
        null,
      getLatestReview: async (_ws, _episodeId, reviewId) =>
        insertedReviews.find((review) => review.reviewId === reviewId) ?? null,
      getLatestComparison: async () => null,
      insertComparison: async () => {},
      insertBatch: async (batch) => {
        const latestReceipt = batch.reviewReceipts.at(-1);
        const existingReceipt = latestReceipt
          ? storedBatch.reviewReceipts.find(
              (receipt) => receipt.reviewId === latestReceipt.reviewId
            )
          : undefined;
        if (
          failReceiptWrite &&
          latestReceipt?.status === "persisted" &&
          existingReceipt?.status !== "persisted"
        ) {
          failReceiptWrite = false;
          throw new Error("Simulated batch receipt persistence failure.");
        }
        storedBatch = batch;
      },
      insertEpisode: async () => {},
      insertReview: async (review) => {
        insertedReviews.push(review);
      },
      insertFinding: async (_ws, finding) => {
        if (finding.title === failFindingTitle) {
          failFindingTitle = null;
          if (!peerFindingPersisted) {
            await new Promise<void>((resolve) => {
              releaseFindingFailure = resolve;
            });
          }
          throw new Error("Simulated finding persistence failure.");
        }
        insertedFindings.push(finding);
        peerFindingPersisted = true;
        const release = releaseFindingFailure;
        releaseFindingFailure = null;
        release?.();
      }
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: currentRole,
          actor: "analyst-1"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo
    });

    const runnerPacket = await (server as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: episodeOne.episodeId });
    assert.equal(parsedMcpError(runnerPacket).code, "playtest_forbidden");
    currentRole = "playtest-analyst";
    const preparedPacket = await (server as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: episodeOne.episodeId });
    assert.equal(preparedPacket.isError, undefined);
    const preparedPayload = JSON.parse(preparedPacket.content[0].text);
    assert.equal(preparedPayload.packet.packetId, packet.packetId);
    assert.equal(preparedPayload.packetArtifact.sha256, packetArtifact.sha256);
    assert.equal(preparedPayload.packet.crossSessionContext.status, "included");
    assert.deepEqual(
      preparedPayload.packet.crossSessionContext.sessions.map(
        (sibling: { episodeId: string }) => sibling.episodeId
      ),
      [episodeTwo.episodeId]
    );
    const unselectedPacket = await (server as any)._registeredTools[
      "playtest.prepareReview"
    ].handler({ episodeId: episodeTwo.episodeId });
    assert.equal(parsedMcpError(unselectedPacket).code, "playtest_forbidden");
    const packetArgs = {
      packetId: packet.packetId,
      packetArtifactId: packetArtifact.artifactId,
      packetSha256: packetArtifact.sha256
    };
    const submitReviewInputSchema = (server as any)._registeredTools[
      "playtest.submitReview"
    ].inputSchema;
    const locatorSchemaResult = await submitReviewInputSchema.safeParseAsync({
      ...packetArgs,
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "Exact source step locator.",
      status: "hypothesis",
      observations: [
        {
          text: "Observed",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      interpretations: [
        {
          text: "Interpreted",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      alternativeExplanations: [],
      experiments: [],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "Only a session packet is available in this test."
        },
        alternatives: { status: "none-identified", reason: "No alternatives." },
        experiments: { status: "none-recommended", reason: "No experiment." },
        followUp: { status: "none", reason: "No follow-up." }
      },
      evidenceRefs: [
        {
          kind: "event",
          id: "evt-real-1",
          step: 0,
          revision: 1,
          phaseId: "fixture-phase"
        }
      ],
      rubricHash: "f".repeat(64)
    });
    assert.equal(locatorSchemaResult.success, true);
    const incompleteReportInput = {
      ...packetArgs,
      episodeId: episodeOne.episodeId,
      chronologicalSummary:
        "Missing report completeness is not a complete review.",
      status: "hypothesis",
      observations: [
        {
          text: "Observed",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      interpretations: [
        {
          text: "Interpreted",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      alternativeExplanations: [],
      experiments: [],
      evidenceRefs: [{ kind: "event", id: "evt-real-1" }],
      rubricHash: "f".repeat(64)
    };
    assert.equal(
      (await submitReviewInputSchema.safeParseAsync(incompleteReportInput))
        .success,
      false
    );
    const obsoleteLocatorFields = await submitReviewInputSchema.safeParseAsync({
      ...packetArgs,
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "Obsolete locator spelling.",
      status: "hypothesis",
      observations: [
        {
          text: "Observed",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      interpretations: [
        {
          text: "Interpreted",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      alternativeExplanations: [],
      experiments: [],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "Only a session packet is available in this test."
        },
        alternatives: { status: "none-identified", reason: "No alternatives." },
        experiments: { status: "none-recommended", reason: "No experiment." },
        followUp: { status: "none", reason: "No follow-up." }
      },
      evidenceRefs: [{ kind: "event", id: "evt-real-1", stepIndex: 0 }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(obsoleteLocatorFields.success, false);
    const submitReview = (input: Record<string, unknown>) =>
      (server as any)._registeredTools["playtest.submitReview"].handler({
        ...packetArgs,
        observations: [
          {
            text: "Synthetic observation",
            evidenceRefs: [
              {
                kind: "episode",
                id: String(input.episodeId ?? episodeOne.episodeId)
              }
            ]
          }
        ],
        interpretations: [
          {
            text: "Synthetic interpretation",
            evidenceRefs: [
              {
                kind: "episode",
                id: String(input.episodeId ?? episodeOne.episodeId)
              }
            ]
          }
        ],
        alternativeExplanations: [],
        experiments: [],
        reportCompleteness: {
          crossSessionContext: {
            status: "unavailable",
            reason: "The session packet contains no cross-session synthesis."
          },
          alternatives:
            Array.isArray(input.alternativeExplanations) &&
            input.alternativeExplanations.length > 0
              ? { status: "provided" }
              : {
                  status: "none-identified",
                  reason:
                    "No distinct alternative is present in this test report."
                },
          experiments:
            Array.isArray(input.experiments) && input.experiments.length > 0
              ? { status: "proposed" }
              : {
                  status: "none-recommended",
                  reason:
                    "No additional experiment is required by this test case."
                },
          followUp: {
            status: "proposed",
            text: "Review the evidence and run only an approved follow-up."
          }
        },
        ...input
      });

    const staleIdentity = buildPlaytestFindingIdentity({
      workspaceId: WORKSPACE_ID,
      mechanicKey: "stale-evidence-status",
      failureSignature: {
        events: ["collision"],
        action: "jump",
        witness: "preexisting-not-observed"
      },
      scope: {
        scenarioFamily: realEpisode.scenarioFamily,
        phase: null,
        modality: null
      }
    });
    const staleFingerprint = createHash("sha256")
      .update(playtestFindingIdentityHashInput(staleIdentity))
      .digest("hex");
    existingFindingOverrides.set(staleFingerprint, {
      identity: staleIdentity,
      fingerprint: staleFingerprint,
      findingId: "finding-" + staleFingerprint,
      version: 1,
      title: "Prior not-observed record",
      description: "A source-owned record with no observations.",
      severity: "informational",
      status: "open",
      verificationStage: "not-yet-validated",
      evidenceStatus: "not observed",
      affectedEpisodes: null,
      totalEligibleEpisodes: null,
      affectedOpportunities: null,
      totalEligibleOpportunities: null,
      affectedCohorts: [realEpisode.policyCohort],
      evidenceRefs: [],
      experimentIds: [],
      issueRefs: [],
      lastVerifiedBuild: null,
      nextReviewAt: null
    });
    const forgedSiblingCitation = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "An unavailable sibling is not packet evidence.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      reportCompleteness: {
        crossSessionContext: {
          status: "available",
          evidenceRefs: [{ kind: "episode", id: "not-in-packet" }]
        },
        alternatives: {
          status: "none-identified",
          reason: "No alternatives in this test."
        },
        experiments: {
          status: "none-recommended",
          reason: "No experiments in this test."
        },
        followUp: { status: "none", reason: "No follow-up in this test." }
      }
    });
    assert.equal(
      parsedMcpError(forgedSiblingCitation).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedReviews.length, 0);
    const partialFindingReview = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary:
        "One candidate conflicts with a source-owned prior status.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: episodeOne.episodeId },
        { kind: "event", id: "evt-real-1" },
        { kind: "event", id: "evt-real-2" }
      ],
      rubricHash: "f".repeat(64),
      dimensionEvidence: [
        {
          dimensionId: "collision-agency",
          rationale: "The legal wait action is a plausible safe alternative.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      alternativeExplanations: [
        "The random policy may have chosen an avoidable collision."
      ],
      experiments: [
        {
          hypothesis: "The collision is avoidable with a wait action.",
          falsifier: "A same-seed wait still collides at the same step.",
          metricId: "anomaly",
          controls: ["same build", "same seed"],
          budget: "one additional synthetic episode"
        }
      ],
      reportCompleteness: {
        crossSessionContext: {
          status: "available",
          evidenceRefs: [{ kind: "episode", id: episodeTwo.episodeId }]
        },
        alternatives: { status: "provided" },
        experiments: { status: "proposed" },
        followUp: {
          status: "proposed",
          text: "Run a root-approved matched-seed follow-up."
        }
      },
      findings: [
        {
          identity: {
            mechanicKey: "stale-evidence-status",
            failureSignature: {
              action: "jump",
              witness: "preexisting-not-observed"
            }
          },
          evidenceStatus: "hypothesis",
          title: "Conflicts with a not-observed record",
          description: "This finding must fail before any peer is written.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        },
        {
          identity: {
            mechanicKey: "independent-valid-finding",
            failureSignature: {
              action: "jump",
              witness: "valid-peer"
            }
          },
          evidenceStatus: "hypothesis",
          title: "Valid peer finding",
          description: "This finding must not persist on partial failure.",
          evidenceRefs: [{ kind: "event", id: "evt-real-2" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(partialFindingReview).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedFindings.length, 0);
    assert.equal(insertedReviews.length, 0);
    assert.equal(storedBatch.budget.actualCritiques, 0);
    existingFindingOverrides.clear();

    const unknownReviewDimension = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary:
        "A dimension outside the frozen rubric is rejected.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64),
      dimensionEvidence: [
        {
          dimensionId: "unregistered-dimension",
          rationale: "This dimension is not in the packet.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(unknownReviewDimension).code,
      "playtest_invalid_request"
    );
    const unknownExperimentMetric = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "An experiment cannot invent a metric.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64),
      experiments: [
        {
          hypothesis: "Unknown metric improves.",
          falsifier: "Unknown metric does not improve.",
          metricId: "invented-metric",
          controls: ["same seed"],
          budget: "one episode"
        }
      ]
    });
    assert.equal(
      parsedMcpError(unknownExperimentMetric).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedFindings.length, 0);

    const retryableFindings = {
      episodeId: episodeOne.episodeId,
      chronologicalSummary:
        "A review retry must reconcile finding writes already persisted.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: episodeOne.episodeId },
        { kind: "event", id: "evt-real-1" },
        { kind: "event", id: "evt-real-2" }
      ],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "retryable-mechanic-one",
            failureSignature: { witness: "retry-first" }
          },
          evidenceStatus: "hypothesis",
          title: "Retry first finding",
          description: "This finding persists before its peer fails.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        },
        {
          identity: {
            mechanicKey: "retryable-mechanic-two",
            failureSignature: { witness: "retry-second" }
          },
          evidenceStatus: "hypothesis",
          title: "Retry second finding",
          description: "This finding fails once, then succeeds on retry.",
          evidenceRefs: [{ kind: "event", id: "evt-real-2" }]
        }
      ]
    };
    failFindingTitle = "Retry second finding";
    peerFindingPersisted = false;
    const partialWrite = await submitReview(retryableFindings);
    assert.equal(parsedMcpError(partialWrite).code, "playtest_internal_error");
    assert.deepEqual(
      insertedFindings.map((finding) => [finding.title, finding.version]),
      [["Retry first finding", 1]]
    );
    assert.equal(insertedReviews.length, 0);
    const recoveredWrite = await submitReview(retryableFindings);
    assert.equal(recoveredWrite.isError, undefined);
    assert.deepEqual(
      insertedFindings.map((finding) => [finding.title, finding.version]),
      [
        ["Retry first finding", 1],
        ["Retry second finding", 1]
      ]
    );
    assert.equal(insertedReviews.length, 1);
    assert.equal(storedBatch.budget.actualCritiques, 1);
    insertedFindings.length = 0;
    insertedReviews.length = 0;
    storedBatch = {
      ...storedBatch,
      reviewReceipts: [],
      counts: { ...storedBatch.counts, reviewed: 0 },
      budget: { ...storedBatch.budget, actualCritiques: 0 }
    };

    // 1. playtester cannot submit review
    currentRole = "playtester";
    const runnerReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "summary",
      status: "verified",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(parsedMcpError(runnerReview).code, "playtest_forbidden");

    currentRole = "unexpected-role";

    const unknownRoleReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Unauthorized reviewer.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(parsedMcpError(unknownRoleReview).code, "playtest_forbidden");
    currentRole = "playtest-analyst";

    const mismatchedPacketReview = await submitReview({
      episodeId: "ep-1",
      packetSha256: "0".repeat(64),
      chronologicalSummary: "Attempted packet identity substitution.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(mismatchedPacketReview).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedReviews.length, 0);

    const outsidePacketDimensionReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "A dimension claim cites outside evidence.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      dimensionEvidence: [
        {
          dimensionId: "collision-agency",
          rationale: "This citation must not escape the packet.",
          evidenceRefs: [{ kind: "event", id: "evt-not-in-packet" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(outsidePacketDimensionReview).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedReviews.length, 0);

    // 2. Fails if review has no evidence locators
    const emptyEvidenceReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "summary",
      status: "hypothesis",
      evidenceRefs: [],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(emptyEvidenceReview).code,
      "playtest_invalid_request"
    );

    // 3. Fails for a nonexistent episode (never silently "verified").
    const missingEpisodeReview = await submitReview({
      episodeId: "ep-does-not-exist",
      chronologicalSummary: "summary",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-does-not-exist" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(missingEpisodeReview).code,
      "playtest_invalid_request"
    );

    // 4. Adversarial: a finding marked "verified" citing a fabricated event
    // id that was never actually recorded in the episode's real trace is
    // rejected, even though the caller also listed it as an evidence ref.
    // The known-evidence index must come from real stored data, not from
    // trusting whatever locators the model supplies.
    const fabricatedEventReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Player hit a fabricated hazard.",
      status: "verified",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-fabricated-1" }
      ],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "hazard-collision",
            failureSignature: { action: "jump", witness: "fabricated-hazard" }
          },
          evidenceStatus: "hypothesis",
          title: "Fabricated hazard",
          description: "Cites an event that was never recorded.",
          evidenceRefs: [{ kind: "event", id: "evt-fabricated-1" }]
        }
      ]
    });
    assert.equal(fabricatedEventReview.isError, true);
    assert.equal(
      parsedMcpError(fabricatedEventReview).code,
      "playtest_invalid_request"
    );

    const unresolvedHypothesis = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Hypothesis cites an event not in the trace.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-not-stored" }
      ],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(unresolvedHypothesis).code,
      "playtest_invalid_request"
    );

    // Locator existence alone is not independent semantic/source validation.
    // A model cannot use a real episode locator to elevate its own conclusion.
    const verifiedConclusion = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Verified from an episode locator alone.",
      status: "verified",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(verifiedConclusion).code,
      "playtest_invalid_request"
    );

    const verifiedFinding = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Unverified review with a verified finding.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "unvalidated-finding",
            failureSignature: { witness: "self-verified" }
          },
          evidenceStatus: "corroborated",
          title: "Unvalidated finding",
          description: "Attempt to self-verify.",
          evidenceRefs: [{ kind: "episode", id: "ep-1" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(verifiedFinding).code,
      "playtest_invalid_request"
    );

    // Scope and event types are server-derived. A caller cannot inject
    // alternate families/phases/modalities or pretend a trace emitted a
    // different event type.
    const forgedIdentity = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Attempted identity spoof.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: {
              events: ["forged-event"],
              witness: "forged-witness"
            },
            scope: {
              scenarioFamily: "forged-family",
              phase: "phase-9",
              modality: "native-visual"
            }
          },
          evidenceStatus: "hypothesis",
          title: "Spoofed finding",
          description:
            "Caller attempts to supply authoritative identity fields.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(forgedIdentity).code,
      "playtest_invalid_request"
    );

    const unobservedAction = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Action is not in the stored trace.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: {
              action: "teleport",
              witness: "unobserved-action"
            }
          },
          evidenceStatus: "hypothesis",
          title: "Unobserved action",
          description: "Action must be observed.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(unobservedAction).code,
      "playtest_invalid_request"
    );

    const forgedFindingState = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Attempted state and denominator forgery.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: { action: "jump", witness: "collision-on-jump" }
          },
          severity: "major",
          verificationStage: "sustained-improvement",
          evidenceStatus: "hypothesis",
          title: "Forged outcome",
          description:
            "An analyst cannot set state or claim population counts.",
          affectedEpisodes: 50,
          totalEligibleEpisodes: 50,
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ]
    });
    assert.equal(
      parsedMcpError(forgedFindingState).code,
      "playtest_invalid_request"
    );

    const oversizedFindingReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary:
        "The bounded input rejects an oversized finding collection.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-real-1" }
      ],
      rubricHash: "f".repeat(64),
      findings: Array.from({ length: 65 }, (_, index) => ({
        identity: {
          mechanicKey: "movement-collision",
          failureSignature: { action: "jump", witness: "oversized-" + index }
        },
        evidenceStatus: "hypothesis",
        title: "Finding " + index,
        description: "Bounded test input.",
        evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
      }))
    });
    assert.equal(
      parsedMcpError(oversizedFindingReview).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedFindings.length, 0);

    const unselectedEpisodeReview = await submitReview({
      episodeId: episodeTwo.episodeId,
      chronologicalSummary: "This episode was not selected for critique.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: episodeTwo.episodeId },
        { kind: "event", id: "evt-real-1" }
      ],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(unselectedEpisodeReview).code,
      "playtest_forbidden"
    );
    assert.equal(insertedReviews.length, 0);

    // 5. Successful review submission citing the episode's real event.
    const validReviewInput = {
      episodeId: "ep-1",
      chronologicalSummary: "Player completed level 1 with normal pacing.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-real-1" }
      ],
      rubricHash: "f".repeat(64),
      observations: [
        {
          text: "The trace records a collision after jump.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1", step: 0 }]
        }
      ],
      interpretations: [
        {
          text: "A failed policy choice is an alternative explanation.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1", step: 0 }]
        }
      ],
      dimensionEvidence: [
        {
          dimensionId: "collision-agency",
          rationale: "The legal wait action is a plausible safe alternative.",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ],
      alternativeExplanations: [
        "The random policy may have chosen an avoidable collision."
      ],
      experiments: [
        {
          hypothesis: "The collision is avoidable with a wait action.",
          falsifier: "A same-seed wait still collides at the same step.",
          metricId: "anomaly",
          controls: ["same build", "same seed"],
          budget: "one additional synthetic episode"
        }
      ],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "The packet covers one session and no aggregate comparison."
        },
        alternatives: { status: "provided" },
        experiments: { status: "proposed" },
        followUp: {
          status: "proposed",
          text: "Run a root-approved matched-seed follow-up."
        }
      },
      findings: [
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: { action: "jump", witness: "collision-on-jump" }
          },
          evidenceStatus: "hypothesis",
          title: "Minor pacing lull",
          description: "Lull in corridor",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        },
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: { action: "jump", witness: "collision-on-jump" }
          },
          evidenceStatus: "hypothesis",
          title: "Duplicate title must not overwrite the first finding",
          description: "Duplicate report.",
          evidenceRefs: [{ kind: "event", id: "evt-real-2" }]
        }
      ]
    };
    const contradictoryCompleteness = await submitReview({
      ...validReviewInput,
      experiments: [],
      reportCompleteness: {
        crossSessionContext: {
          status: "unavailable",
          reason: "No batch synthesis was included in this session packet."
        },
        alternatives: { status: "provided" },
        experiments: { status: "proposed" },
        followUp: {
          status: "proposed",
          text: "Run an approved matched-seed comparison."
        }
      }
    });
    assert.equal(
      parsedMcpError(contradictoryCompleteness).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedReviews.length, 0);
    assert.equal(insertedFindings.length, 0);

    const validReviewSchemaResult = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].inputSchema.safeParseAsync({ ...packetArgs, ...validReviewInput });
    assert.equal(validReviewSchemaResult.success, true);
    failReceiptWrite = true;
    const missingReceipt = await submitReview(validReviewInput);
    assert.equal(
      parsedMcpError(missingReceipt).code,
      "playtest_internal_error"
    );
    assert.equal(insertedReviews.length, 1);
    assert.equal(storedBatch.budget.actualCritiques, 0);
    assert.equal(storedBatch.reviewReceipts[0]?.status, "reserved");

    const validReview = await submitReview(validReviewInput);

    assert.equal(validReview.isError, undefined);
    const parsedReview = JSON.parse(validReview.content[0].text);
    assert.equal(parsedReview.episodeId, "ep-1");
    assert.equal(parsedReview.status, "hypothesis");
    assert.equal(parsedReview.rubricHash, "f".repeat(64));
    assert.deepEqual(parsedReview.authoritativeMetrics, packet.metrics);
    assert.deepEqual(parsedReview.observations, validReviewInput.observations);
    assert.deepEqual(
      parsedReview.interpretations,
      validReviewInput.interpretations
    );
    assert.equal(parsedReview.anchors.length, 2);
    assert.equal(parsedReview.anchors[0].dimensionId, "collision-agency");
    assert.equal(parsedReview.anchors[0].score, 4);
    assert.deepEqual(parsedReview.anchors[0].evidenceRefs, [
      { kind: "event", id: "evt-real-1" }
    ]);
    assert.equal(parsedReview.anchors[1].dimensionId, "visual-clarity");
    assert.equal(parsedReview.anchors[1].score, null);
    assert.equal(
      parsedReview.anchors[1].insufficientReason,
      "unsupported-modality"
    );
    assert.deepEqual(parsedReview.alternativeExplanations, [
      "The random policy may have chosen an avoidable collision."
    ]);
    assert.deepEqual(parsedReview.experiments, [
      {
        hypothesis: "The collision is avoidable with a wait action.",
        falsifier: "A same-seed wait still collides at the same step.",
        metricId: "anomaly",
        controls: ["same build", "same seed"],
        budget: "one additional synthetic episode"
      }
    ]);
    assert.equal(insertedReviews.length, 1);
    assert.equal(insertedFindings.length, 1);
    assert.equal(storedBatch.counts.reviewed, 1);
    assert.equal(storedBatch.budget.actualCritiques, 1);
    assert.equal(storedBatch.reviewReceipts[0]?.status, "persisted");
    assert.equal(parsedReview.findings.length, 1);
    assert.equal(
      parsedReview.findings[0].findingId,
      "finding-" + parsedReview.findings[0].fingerprint
    );
    assert.equal(parsedReview.findings[0].version, 1);
    assert.deepEqual(parsedReview.findings[0].identity.scope, {
      scenarioFamily: "tutorial-family",
      phase: null,
      modality: null
    });
    assert.deepEqual(
      parsedReview.findings[0].identity.failureSignature.events,
      ["collision"]
    );
    assert.equal(parsedReview.findings[0].title, "Minor pacing lull");
    assert.equal(parsedReview.findings[0].affectedEpisodes, null);
    assert.equal(parsedReview.findings[0].totalEligibleEpisodes, null);
    assert.equal(parsedReview.findings[0].affectedOpportunities, null);
    assert.equal(parsedReview.findings[0].totalEligibleOpportunities, null);
    assert.deepEqual(parsedReview.findings[0].affectedCohorts, ["random"]);
    assert.deepEqual(parsedReview.findings[0].experimentIds, []);
    assert.deepEqual(parsedReview.findings[0].issueRefs, []);
    assert.equal(parsedReview.findings[0].lastVerifiedBuild, null);
    assert.equal(parsedReview.findings[0].nextReviewAt, null);
    assert.deepEqual(
      parsedReview.findings[0].evidenceRefs.map(
        (reference: { id: string }) => reference.id
      ),
      ["evt-real-1", "evt-real-2"]
    );

    // Idempotent retry returns the existing review without consuming a second
    // critique receipt or appending the same finding again.
    const duplicateReviewDelivery = await submitReview(validReviewInput);
    assert.equal(duplicateReviewDelivery.isError, undefined);
    assert.equal(insertedReviews.length, 1);
    assert.equal(insertedFindings.length, 1);
    assert.equal(storedBatch.counts.reviewed, 1);
    assert.equal(storedBatch.budget.actualCritiques, 1);
    assert.equal(storedBatch.reviewReceipts.length, 1);

    // Same identity on a later review creates one append-only revision and
    // unions new evidence without allowing the caller to rewrite status or counts.
    const repeatedReview = await submitReview({
      episodeId: "ep-1",
      chronologicalSummary: "Same collision on a later observation.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-real-3" }
      ],
      rubricHash: "f".repeat(64),
      findings: [
        {
          identity: {
            mechanicKey: "movement-collision",
            failureSignature: { action: "jump", witness: "collision-on-jump" }
          },
          evidenceStatus: "hypothesis",
          title: "Attempted rewrite",
          description: "Attempted rewrite.",
          evidenceRefs: [{ kind: "event", id: "evt-real-3" }]
        }
      ]
    });
    assert.equal(repeatedReview.isError, undefined);
    assert.equal(insertedFindings.length, 2);
    assert.equal(insertedFindings[1]?.version, 2);
    assert.equal(insertedFindings[1]?.title, "Minor pacing lull");
    assert.equal(insertedFindings[1]?.severity, "informational");
    assert.equal(insertedFindings[1]?.status, "open");
    assert.equal(insertedFindings[1]?.affectedEpisodes, null);
    assert.equal(insertedFindings[1]?.totalEligibleEpisodes, null);
    assert.deepEqual(
      insertedFindings[1]?.evidenceRefs.map((reference) => reference.id),
      ["evt-real-1", "evt-real-2", "evt-real-3"]
    );

    const submitRepeatedWitness = (eventId: string) =>
      submitReview({
        episodeId: "ep-1",
        chronologicalSummary: "Concurrent repeated witness.",
        status: "hypothesis",
        evidenceRefs: [{ kind: "episode", id: "ep-1" }],
        rubricHash: "f".repeat(64),
        findings: [
          {
            identity: {
              mechanicKey: "movement-collision",
              failureSignature: { action: "jump", witness: "collision-on-jump" }
            },
            evidenceStatus: "hypothesis",
            title: "Minor pacing lull",
            description: "Lull in corridor",
            evidenceRefs: [{ kind: "event", id: eventId }]
          }
        ]
      });
    const concurrentReviews = await Promise.all([
      submitRepeatedWitness("evt-real-1"),
      submitRepeatedWitness("evt-real-2")
    ]);
    assert.ok(
      concurrentReviews.every(
        (result: { isError?: boolean }) => !result.isError
      )
    );
    // A repeated report that contributes only evidence already present does
    // not create a redundant finding revision.
    assert.equal(insertedFindings.length, 2);
    assert.deepEqual(
      insertedFindings.slice(-2).map((finding) => finding.version),
      [1, 2]
    );
    assert.equal(storedBatch.counts.reviewed, 1);
    assert.equal(storedBatch.budget.actualCritiques, 4);
    assert.equal(storedBatch.reviewReceipts.length, 4);
    const capFillReview = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "Fifth distinct critique for the selected session.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(capFillReview.isError, undefined);
    assert.equal(storedBatch.budget.actualCritiques, 5);

    const reservedReviewInput = {
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "A receipt failure reserves this critique slot.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64)
    };
    failReceiptWrite = true;
    const unfinalizedReview = await submitReview(reservedReviewInput);
    assert.equal(
      parsedMcpError(unfinalizedReview).code,
      "playtest_internal_error"
    );
    assert.equal(storedBatch.budget.actualCritiques, 5);
    assert.equal(storedBatch.reviewReceipts.at(-1)?.status, "reserved");

    for (let index = 1; index <= 3; index += 1) {
      const pressureReview = await submitReview({
        episodeId: episodeOne.episodeId,
        chronologicalSummary: `Post-reservation pressure ${index}.`,
        status: "hypothesis",
        evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
        rubricHash: "f".repeat(64)
      });
      assert.equal(pressureReview.isError, undefined);
    }
    assert.equal(storedBatch.budget.actualCritiques, 8);
    assert.equal(
      storedBatch.reviewReceipts.filter(
        (receipt) => receipt.status === "reserved"
      ).length,
      1
    );
    const blockedByReservation = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "This review cannot take the reserved ninth slot.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(blockedByReservation).code,
      "playtest_invalid_request"
    );
    const finalizedReview = await submitReview(reservedReviewInput);
    assert.equal(finalizedReview.isError, undefined);
    assert.equal(storedBatch.budget.actualCritiques, 9);
    assert.equal(storedBatch.reviewReceipts.length, 9);
    assert.ok(
      storedBatch.reviewReceipts.every(
        (receipt) => receipt.status === "persisted"
      )
    );
    const exhaustedReview = await submitReview({
      episodeId: episodeOne.episodeId,
      chronologicalSummary: "This review exceeds the frozen cap.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: episodeOne.episodeId }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(
      parsedMcpError(exhaustedReview).code,
      "playtest_invalid_request"
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("playtest MCP server: listEpisodes, readEpisode, readWindow with bounded step filtering, metrics without zero-imputed missing data, compare from stored records, findings", async () => {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mcp-test-"))
  );
  const artifactsDir = path.join(tmpRoot, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: artifactsDir
  });
  const approvalRepo = new WorkspacePlaytestApprovalRepository(
    path.join(tmpRoot, "approvals")
  );
  approvalRepo.approve(createApproval(), null);

  try {
    let currentRole = "playtester";
    const windowWrite = artifacts.writeWindow({
      entries: [
        { step: 0, note: "a" },
        { step: 1, note: "b" },
        { step: 2, note: "c" },
        { step: 3, note: "d" },
        { step: 4, note: "e" }
      ]
    });

    function makeEpisode(
      episodeId: string,
      metricEstimate: number | null
    ): PlaytestEpisode {
      return {
        schema: "autodev-playtest-episode-v3",
        episodeId,
        revision: 1,
        batchId: "batch-1",
        assignmentId: "a-0001",
        branchLineage: null,
        identity: {
          workspaceId: WORKSPACE_ID,
          repository: WORKSPACE_ID,
          buildSha: "a".repeat(40),
          gameBuild: "build-1",
          scenarioId: "tutorial",
          configHash: "b".repeat(64),
          seed: "123",
          rngInitialStateHash: null,
          rngAlgorithm: null,
          rngVersion: null,
          policyId: "random",
          policyVersion: "v1",
          modelId: null,
          modelRevision: null,
          observationSchemaHash: "b".repeat(64),
          actionSchemaHash: "b".repeat(64),
          eventSchemaHash: "b".repeat(64),
          protocolVersion: 1,
          runtimeVersion: "1.0.0",
          environmentHash: "b".repeat(64)
        },
        scenarioFamily: "tutorial-family",
        policyCohort: "random",
        strategy: "random",
        status: "completed",
        outcome: "win",
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
        trace:
          episodeId === "ep-dummy-1"
            ? { kind: "replay-segment", id: windowWrite.reference.artifactId }
            : null,
        frames: [],
        stepCount: 5,
        metrics: [
          {
            metricId: "score",
            metricVersion: 1,
            phaseId: null,
            numerator: metricEstimate === null ? 0 : metricEstimate,
            denominator: 1,
            opportunityCount: 1,
            coverage: metricEstimate === null ? 0 : 1,
            unit: "points",
            estimate: metricEstimate,
            missing: metricEstimate === null ? 1 : 0,
            missingReasons: metricEstimate === null ? ["unobserved"] : [],
            independentUnits: 1,
            provenance: {
              workspaceId: WORKSPACE_ID,
              measurementVersion: "1.0.0",
              generatedAt: new Date().toISOString()
            },
            notes: ""
          }
        ],
        findingIds: [],
        assignedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        simulationWallMs: 1000,
        logicalTicks: 10,
        policyInferenceMs: 100,
        nativeDurationMs: null,
        completeness: "complete",
        missingReasons: []
      };
    }

    const dummyEpisode = makeEpisode("ep-dummy-1", 42);
    const missingMetricEpisode = makeEpisode("ep-dummy-2", null);

    const dummyFindingIdentity = buildPlaytestFindingIdentity({
      workspaceId: WORKSPACE_ID,
      mechanicKey: "collision-stuck",
      failureSignature: {
        events: ["collision"],
        action: "advance",
        witness: "witness-collision-stuck"
      },
      scope: {
        scenarioFamily: "tutorial-family",
        phase: "phase-1",
        modality: "headless"
      }
    });
    const dummyFindingFingerprint = createHash("sha256")
      .update(playtestFindingIdentityHashInput(dummyFindingIdentity))
      .digest("hex");
    const dummyFinding: PlaytestFinding = {
      identity: dummyFindingIdentity,
      fingerprint: dummyFindingFingerprint,
      findingId: "finding-" + dummyFindingFingerprint,
      version: 1,
      title: "Major collision defect",
      description: "Collision stuck on barrier",
      severity: "major",
      status: "open",
      verificationStage: "not-yet-validated",
      evidenceStatus: "verified",
      affectedEpisodes: 1,
      totalEligibleEpisodes: 1,
      affectedOpportunities: 1,
      totalEligibleOpportunities: 1,
      affectedCohorts: ["random"],
      evidenceRefs: [{ kind: "episode", id: "ep-dummy-1" }],
      experimentIds: [],
      issueRefs: [],
      lastVerifiedBuild: null,
      nextReviewAt: null
    };

    let storedComparison: PlaytestComparison = {
      schema: PLAYTESTS_COMPARISON_SCHEMA,
      comparisonId: "comp-stored-1",
      version: 1,
      benchmarkId: "bench-1",
      experimentId: "exp-1",
      baseline: { id: "bench-1", version: 1 },
      candidate: { id: "exp-1", version: 1 },
      freezeStatus: "frozen",
      pairing: {
        mode: "distribution-matched",
        pairMap: {},
        allocationPlanHash: null,
        rngAlgorithm: null,
        rngStreamVersion: null,
        couplingDiagnostics: [],
        exclusions: []
      },
      sourceFindingIds: [],
      episodeRefs: [],
      measurementVersion: "1.0.0",
      metrics: [],
      decision: "hold-inconclusive",
      ownerDecisionAt: null,
      ownerDecisionReason: null,
      ownerDecisionBy: null,
      ownerDisposition: null,
      humanPreference: { answer: "not-collected", interval: null },
      provenance: {
        workspaceId: WORKSPACE_ID,
        measurementVersion: "1.0.0",
        generatedAt: new Date().toISOString()
      },
      notes: ""
    };
    let loseOwnerDecisionAcknowledgement = false;

    let requestedBatchMetricPage: {
      readonly batchId?: string;
      readonly limit: number | undefined;
      readonly cursor: string | undefined;
    } | null = null;
    const mockRepo: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({ rows: [], total: 0, nextCursor: null }),
      listEpisodes: async (filter, pageOptions) => {
        if (filter.batchId) {
          requestedBatchMetricPage = {
            batchId: filter.batchId,
            limit: pageOptions?.limit,
            cursor: pageOptions?.cursor
          };
        }
        return {
          rows: [dummyEpisode, missingMetricEpisode],
          total: 2,
          nextCursor: "next-page"
        };
      },
      listFindings: async () => ({
        rows: [dummyFinding],
        total: 1,
        nextCursor: null
      }),
      listComparisons: async (filter) => ({
        rows:
          filter.benchmarkId === "bench-1" && filter.experimentId === "exp-1"
            ? [storedComparison]
            : [],
        total: filter.benchmarkId === "bench-1" ? 1 : 0,
        nextCursor: null
      }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async (_ws, epId) =>
        epId === "ep-dummy-1"
          ? dummyEpisode
          : epId === "ep-dummy-2"
            ? missingMetricEpisode
            : null,
      getLatestReviewForEpisode: async () => null,
      getFinding: async (_ws, findingId) =>
        findingId === dummyFinding.findingId ? dummyFinding : null,
      getLatestFindingByFingerprint: async () => null,
      getLatestReview: async () => null,
      getLatestComparison: async (_ws, comparisonId) =>
        comparisonId === storedComparison.comparisonId
          ? storedComparison
          : null,
      insertComparison: async (comparison) => {
        storedComparison = comparison;
        if (loseOwnerDecisionAcknowledgement) {
          loseOwnerDecisionAcknowledgement = false;
          throw new Error("Simulated lost comparison write acknowledgement.");
        }
      },
      insertBatch: async () => {},
      insertEpisode: async () => {},
      insertReview: async () => {},
      insertFinding: async () => {}
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: currentRole,
          actor: "user-1"
        })
      },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      playtestRepository: mockRepo
    });

    // 1. listEpisodes
    const listRes = await (server as any)._registeredTools[
      "playtest.listEpisodes"
    ].handler({ scenario: "tutorial" });
    assert.equal(listRes.isError, undefined);
    const listParsed = JSON.parse(listRes.content[0].text);
    assert.equal(listParsed.total, 2);

    // 2. readEpisode
    const readRes = await (server as any)._registeredTools[
      "playtest.readEpisode"
    ].handler({ episodeId: "ep-dummy-1" });
    assert.equal(readRes.isError, undefined);
    const readParsed = JSON.parse(readRes.content[0].text);
    assert.equal(readParsed.episode.episodeId, "ep-dummy-1");

    // 3. readWindow honors the requested step range -- never the whole
    // underlying artifact window regardless of fromStep/toStep.
    const windowRes = await (server as any)._registeredTools[
      "playtest.readWindow"
    ].handler({
      episodeId: "ep-dummy-1",
      artifactId: windowWrite.reference.artifactId,
      fromStep: 1,
      toStep: 3
    });
    assert.equal(windowRes.isError, undefined);
    const windowParsed = JSON.parse(windowRes.content[0].text);
    assert.equal(windowParsed.lineCount, 3);
    assert.equal(windowParsed.sourceSha256, windowWrite.reference.sha256);
    assert.notEqual(windowParsed.contentSha256, windowParsed.sourceSha256);
    const decoded = Buffer.from(windowParsed.bytesBase64, "base64").toString(
      "utf8"
    );
    const steps = decoded
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line).step);
    assert.deepEqual(steps, [1, 2, 3]);

    // 3b. Adversarial: an over-tight maxBytes bound is rejected rather than
    // silently truncated.
    const tooSmallWindowRes = await (server as any)._registeredTools[
      "playtest.readWindow"
    ].handler({
      episodeId: "ep-dummy-1",
      artifactId: windowWrite.reference.artifactId,
      fromStep: 0,
      toStep: 4,
      maxBytes: 4
    });
    assert.equal(
      parsedMcpError(tooSmallWindowRes).code,
      "playtest_invalid_request"
    );

    // 3c. Adversarial: an inverted range is rejected.
    const invertedRangeRes = await (server as any)._registeredTools[
      "playtest.readWindow"
    ].handler({
      episodeId: "ep-dummy-1",
      artifactId: windowWrite.reference.artifactId,
      fromStep: 3,
      toStep: 1
    });
    assert.equal(
      parsedMcpError(invertedRangeRes).code,
      "playtest_invalid_request"
    );

    const unrelatedWindowRes = await (server as any)._registeredTools[
      "playtest.readWindow"
    ].handler({
      episodeId: "ep-dummy-2",
      artifactId: windowWrite.reference.artifactId,
      fromStep: 1,
      toStep: 2
    });
    assert.equal(parsedMcpError(unrelatedWindowRes).code, "playtest_forbidden");

    const runnerMetricsRes = await (server as any)._registeredTools[
      "playtest.metrics"
    ].handler({ episodeId: "ep-dummy-1" });
    assert.equal(parsedMcpError(runnerMetricsRes).code, "playtest_forbidden");
    const runnerCompareRes = await (server as any)._registeredTools[
      "playtest.compare"
    ].handler({ benchmarkId: "bench-1", experimentId: "exp-1" });
    assert.equal(parsedMcpError(runnerCompareRes).code, "playtest_forbidden");
    const runnerFindingsRes = await (server as any)._registeredTools[
      "playtest.findings"
    ].handler({});
    assert.equal(parsedMcpError(runnerFindingsRes).code, "playtest_forbidden");
    currentRole = "playtest-analyst";

    // 4. metrics (by episodeId)
    const metricsEpRes = await (server as any)._registeredTools[
      "playtest.metrics"
    ].handler({ episodeId: "ep-dummy-1" });
    assert.equal(metricsEpRes.isError, undefined);
    const metricsEpParsed = JSON.parse(metricsEpRes.content[0].text);
    assert.equal(metricsEpParsed.numericResults[0].estimate, 42);

    // 4b. Batch metrics return a bounded per-episode page, not a pooled
    // average with unsupported registry/independent-unit semantics.
    const metricsBatchRes = await (server as any)._registeredTools[
      "playtest.metrics"
    ].handler({ batchId: "batch-1", limit: 1, cursor: "cursor-1" });
    assert.equal(metricsBatchRes.isError, undefined);
    const metricsBatch = JSON.parse(metricsBatchRes.content[0].text);
    assert.equal(metricsBatch.kind, "per-episode-metrics");
    assert.equal(metricsBatch.total, 2);
    assert.equal(metricsBatch.rows[0].episodeId, "ep-dummy-1");
    assert.deepEqual(metricsBatch.rows[0].metrics, dummyEpisode.metrics);
    assert.equal(metricsBatch.nextCursor, "next-page");
    assert.deepEqual(requestedBatchMetricPage, {
      batchId: "batch-1",
      limit: 1,
      cursor: "cursor-1"
    });

    // 5. compare returns the latest stored comparison, never a fabricated
    // one computed from hardcoded numbers.
    const compRes = await (server as any)._registeredTools[
      "playtest.compare"
    ].handler({ benchmarkId: "bench-1", experimentId: "exp-1" });
    assert.equal(compRes.isError, undefined);
    const compParsed = JSON.parse(compRes.content[0].text);
    assert.equal(compParsed.comparisonId, "comp-stored-1");
    assert.equal(compParsed.decision, "hold-inconclusive");

    // 5b. Adversarial: no stored comparison exists for this pair -- must
    // be reported honestly, not fabricated.
    const missingCompRes = await (server as any)._registeredTools[
      "playtest.compare"
    ].handler({ benchmarkId: "bench-none", experimentId: "exp-none" });
    assert.equal(
      parsedMcpError(missingCompRes).code,
      "playtest_invalid_request"
    );

    const analystFindingsRes = await (server as any)._registeredTools[
      "playtest.findings"
    ].handler({});
    assert.equal(parsedMcpError(analystFindingsRes).code, "playtest_forbidden");
    const analystDecisionRes = await (server as any)._registeredTools[
      "playtest.decideComparison"
    ].handler({
      comparisonId: storedComparison.comparisonId,
      expectedVersion: 1,
      disposition: "hold",
      reason: "Analyst roles cannot decide releases."
    });
    assert.equal(parsedMcpError(analystDecisionRes).code, "playtest_forbidden");
    currentRole = "root";

    const ineligiblePromotion = await (server as any)._registeredTools[
      "playtest.decideComparison"
    ].handler({
      comparisonId: storedComparison.comparisonId,
      expectedVersion: 1,
      disposition: "promote",
      reason: "Attempt to override the code-owned inconclusive result."
    });
    assert.equal(
      parsedMcpError(ineligiblePromotion).code,
      "playtest_invalid_request"
    );
    assert.equal(storedComparison.version, 1);

    loseOwnerDecisionAcknowledgement = true;
    const decisionRes = await (server as any)._registeredTools[
      "playtest.decideComparison"
    ].handler({
      comparisonId: storedComparison.comparisonId,
      expectedVersion: 1,
      disposition: "hold",
      reason: "Hold pending a fresh confirmation cohort."
    });
    assert.equal(decisionRes.isError, undefined);
    const decided = JSON.parse(decisionRes.content[0].text);
    assert.equal(decided.version, 2);
    assert.equal(decided.ownerDisposition, "hold");
    assert.equal(decided.ownerDecisionBy, "user-1");
    assert.equal(
      decided.ownerDecisionReason,
      "Hold pending a fresh confirmation cohort."
    );
    assert.equal(storedComparison.version, 2);
    assert.equal(approvalRepo.read(WORKSPACE_ID)?.revision, 1);

    const idempotentDecisionRes = await (server as any)._registeredTools[
      "playtest.decideComparison"
    ].handler({
      comparisonId: storedComparison.comparisonId,
      expectedVersion: 1,
      disposition: "hold",
      reason: "Hold pending a fresh confirmation cohort."
    });
    assert.equal(idempotentDecisionRes.isError, undefined);
    assert.equal(JSON.parse(idempotentDecisionRes.content[0].text).version, 2);
    const staleDecisionRes = await (server as any)._registeredTools[
      "playtest.decideComparison"
    ].handler({
      comparisonId: storedComparison.comparisonId,
      expectedVersion: 1,
      disposition: "hold",
      reason: "A different stale decision."
    });
    assert.equal(
      parsedMcpError(staleDecisionRes).code,
      "playtest_invalid_request"
    );

    // 6. findings
    const findingsRes = await (server as any)._registeredTools[
      "playtest.findings"
    ].handler({});
    assert.equal(findingsRes.isError, undefined);
    const findingsParsed = JSON.parse(findingsRes.content[0].text);
    assert.equal(findingsParsed.total, 1);
    assert.equal(findingsParsed.rows[0].findingId, dummyFinding.findingId);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
