import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  type PlaytestBatch,
  type PlaytestCapabilityAdvertisement,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestFinding,
  PLAYTESTS_MEASUREMENT_VERSION,
  type PlaytestSessionReview,
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

const WORKSPACE_ID = "owner/game";

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
    rubricHash: "e".repeat(64)
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
  options: PlaytestEpisodeRunOptions,
  status: "completed" | "cancelled" = "cancelled"
): PlaytestEpisode {
  const timestamp = new Date().toISOString();
  return {
    schema: "autodev-playtest-episode-v1",
    episodeId: "ep-cancel-fixture",
    revision: 1,
    batchId: options.batchId,
    identity: {
      workspaceId: options.repository,
      repository: options.repository,
      buildSha: options.approval.buildSha,
      gameBuild: options.approval.gameBuild,
      scenarioId: options.scenarioId,
      configHash: options.approval.playtestConfigHash,
      seed: options.seed,
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
    active = JSON.parse(result.content[0].text).runs[0];
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

    const server = createTestPlaytestMcpServer({
      sessionProvider: { current: () => currentSession },
      artifactStoreForWorkspace: () => artifacts,
      approvalRepository: approvalRepo,
      prepareSandboxHandler: fixturePreparedSandbox,
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
    ].handler({ scenario: "tutorial", policy: "random", seed: "seed-1" });
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
    const insertedEpisodes: PlaytestEpisode[] = [];
    const insertedBatches: any[] = [];
    let capturedObservationContract: unknown = null;
    let capturedScenarioFamily: string | null = null;
    let capturedSeed: string | null = null;
    let capturedMeasurementVersion: string | null = null;
    let capturedEnvironmentHash: string | null = null;
    let capturedRuntimeVersion: string | null = null;

    const mockRepo: PlaytestingRepositoryOps = {
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
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
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
      prepareSandboxHandler: fixturePreparedSandbox,
      runEpisodeHandler: async (opts) => {
        capturedObservationContract = opts.observationContract;
        capturedScenarioFamily = opts.scenarioFamily;
        capturedSeed = opts.seed;
        capturedMeasurementVersion = opts.measurementVersion;
        capturedEnvironmentHash = opts.environmentHash;
        capturedRuntimeVersion = opts.runtimeVersion;
        return {
          capabilities: capabilitiesForRun(opts),
          episode: {
            schema: "autodev-playtest-episode-v1",
            episodeId: "ep-run-1",
            revision: 1,
            batchId: opts.batchId,
            identity: {
              workspaceId: opts.repository,
              repository: opts.repository,
              buildSha: opts.approval.buildSha,
              gameBuild: opts.approval.gameBuild,
              scenarioId: opts.scenarioId,
              configHash: opts.approval.playtestConfigHash,
              seed: opts.seed,
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
            trace: null,
            frames: [],
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
          traceReference: null,
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
    ].handler({ scenario: "tutorial", policy: "random", seed: "seed-1" });
    assert.equal(parsedMcpError(analystRun).code, "playtest_forbidden");

    // Switch to playtester role
    currentRole = "playtester";

    // 2. Fails when unapproved
    const unapprovedRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({ scenario: "tutorial", policy: "random", seed: "seed-1" });
    assert.equal(
      parsedMcpError(unapprovedRun).code,
      "playtest_approval_required"
    );

    // Save active approval
    const boundedApproval = createApproval();
    approvalRepo.approve(
      {
        ...boundedApproval,
        limits: { ...boundedApproval.limits, episodeCount: 2 }
      },
      null
    );

    // 3. Fails when scenario is unapproved
    const badScenarioRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "unapproved-scenario",
      policy: "random",
      seed: "seed-1"
    });
    assert.equal(
      parsedMcpError(badScenarioRun).code,
      "playtest_invalid_request"
    );

    // 4. Adversarial: approved-but-unsupported policy is rejected, not
    // fabricated through a generic hash-based heuristic.
    const unsupportedPolicyRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "tutorial",
      policy: "heuristic-v1",
      seed: "seed-1"
    });
    assert.equal(
      parsedMcpError(unsupportedPolicyRun).code,
      "playtest_invalid_request"
    );

    const overBudgetRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-1",
      maxSteps: 51
    });
    assert.equal(
      parsedMcpError(overBudgetRun).code,
      "playtest_invalid_request"
    );

    // 5. Successful run with an explicit seed, real scenario family and
    // real adapter observation contract (never a fabricated empty one).
    const callerChosenBatch = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-exact-1",
      batchId: "model-chosen-batch"
    });
    assert.equal(
      parsedMcpError(callerChosenBatch).code,
      "playtest_invalid_request"
    );

    const successRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-exact-1",
      maxSteps: 25
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
    assert.equal(completedRun.result.episodeId, "ep-run-1");
    assert.equal(completedRun.result.outcome, "win");
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
    assert.throws(
      () =>
        server.playtestRunControl.listActiveRuns(
          unrecognizedViewer,
          WORKSPACE_ID
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
    assert.equal(insertedEpisodes.length, 1);
    assert.equal(insertedEpisodes[0]!.identity.seed, "seed-exact-1");
    assert.equal(capturedSeed, "seed-exact-1");
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
    ].handler({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-mismatched-schema"
    });
    const mismatchedStarted = JSON.parse(mismatchedRun.content[0].text);
    const mismatchedFinished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: mismatchedStarted.batchId, waitMs: 5000 });
    const mismatchedStatus = JSON.parse(mismatchedFinished.content[0].text);
    assert.equal(mismatchedStatus.status, "failed");
    assert.equal(mismatchedStatus.error.code, "playtest_invalid_request");
    assert.equal(insertedEpisodes.length, 1);
    assert.equal(insertedBatches.length, 4);
    assert.equal(insertedBatches[3]!.revision, 2);
    assert.equal(insertedBatches[3]!.status, "failed");
    mismatchNegotiatedSchemaHash = false;

    const exhaustedBudgetRun = await (server as any)._registeredTools[
      "playtest.run"
    ].handler({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-after-budget"
    });
    assert.equal(
      parsedMcpError(exhaustedBudgetRun).code,
      "playtest_invalid_request"
    );
    assert.equal(insertedEpisodes.length, 1);
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
    const mockRepo: PlaytestingRepositoryOps = {
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
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
      insertBatch: async (batch) => {
        if (failTerminalBatchInsert && batch.revision === 2) {
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
          schema: "autodev-playtest-episode-v1",
          episodeId: "ep-fail-1",
          revision: 1,
          batchId: opts.batchId,
          identity: {
            workspaceId: opts.repository,
            repository: opts.repository,
            buildSha: opts.approval.buildSha,
            gameBuild: opts.approval.gameBuild,
            scenarioId: opts.scenarioId,
            configHash: opts.approval.playtestConfigHash,
            seed: opts.seed,
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
    ].handler({ scenario: "tutorial", policy: "random", seed: "seed-1" });
    const started = JSON.parse(result.content[0].text);
    assert.equal(started.status, "running");
    const finished = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: started.batchId, waitMs: 5000 });
    const finishedStatus = JSON.parse(finished.content[0].text);
    assert.equal(finishedStatus.status, "failed");
    assert.equal(finishedStatus.error.code, "playtest_internal_error");
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
    ].handler({ scenario: "tutorial", policy: "random", seed: "seed-2" });
    const secondStarted = JSON.parse(secondStart.content[0].text);
    const secondWait = await (server as any)._registeredTools[
      "playtest.wait"
    ].handler({ batchId: secondStarted.batchId, waitMs: 5000 });
    const secondStatus = JSON.parse(secondWait.content[0].text);
    assert.equal(secondStatus.status, "failed");
    assert.equal(secondStatus.error.code, "playtest_internal_error");
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
        getLatestReview: async () => null,
        getLatestComparison: async () => null,
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
      ].handler({
        scenario: "tutorial",
        policy: "random",
        seed: "failure-seed"
      });
      const started = JSON.parse(startedResult.content[0].text);
      assert.equal(started.status, "running");
      const finishedResult = await (server as any)._registeredTools[
        "playtest.wait"
      ].handler({ batchId: started.batchId, waitMs: 2000 });
      const finished = JSON.parse(finishedResult.content[0].text);
      assert.equal(finished.status, "failed");
      if (failureStage === "docker") {
        assert.equal(finished.result, null);
      } else {
        assert.equal(finished.result.episodeId, null);
        assert.equal(finished.result.outcome, "unknown");
        assert.equal(finished.result.failure.category, "adapter");
      }
      if (failureStage === "docker") {
        assert.equal(finished.error.code, "playtest_sandbox_unavailable");
      } else {
        assert.equal(finished.error, null);
      }
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

    assert.throws(
      () => server.playtestRunControl.listActiveRuns(analyst, WORKSPACE_ID),
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
      server.playtestRunControl.listActiveRuns(controlViewer, WORKSPACE_ID),
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
      getLatestReview: async () => null,
      getLatestComparison: async () => null,
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
        scenario: "tutorial",
        policy: "random",
        seed: "race-1"
      }),
      server.playtestRunControl.startRun(session, {
        scenario: "tutorial",
        policy: "random",
        seed: "race-2"
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
        getLatestReview: async () => null,
        getLatestComparison: async () => null,
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
        scenario: "tutorial",
        policy: "random",
        seed: "cancel-seed"
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
        server.playtestRunControl.listActiveRuns(
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
      ].handler({
        scenario: "tutorial",
        policy: "random",
        seed: "concurrent-seed"
      });
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
      assert.equal(
        run.result.failure.category,
        trigger === "cancel" ? "cancelled" : "approval-revoked"
      );
      assert.equal(insertedEpisodes.length, 1);
      assert.equal(insertedBatches.length, 2);
      assert.equal(insertedBatches[0]!.revision, 1);
      assert.equal(insertedBatches[1]!.revision, 2);
      assert.equal(insertedBatches[1]!.status, "cancelled");
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

test("playtest MCP server: playtest.branch rejects role, then reports unsupported rather than fabricating a completed branch", async () => {
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
    let currentRole = "playtest-analyst";
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
      readWorkspaceCatalog: enabledWorkspaceCatalog()
    });

    const analystBranch = await (server as any)._registeredTools[
      "playtest.branch"
    ].handler({
      parentEpisodeId: "ep-dummy-1",
      branchStep: 3,
      policy: "random"
    });
    assert.equal(analystBranch.isError, true);
    assert.equal(parsedMcpError(analystBranch).code, "playtest_forbidden");

    currentRole = "playtester";
    const branchResult = await (server as any)._registeredTools[
      "playtest.branch"
    ].handler({
      parentEpisodeId: "ep-dummy-1",
      branchStep: 3,
      policy: "random"
    });
    assert.equal(parsedMcpError(branchResult).code, "playtest_unavailable");
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

    // Write a real trace artifact for the episode so the known-evidence
    // index can be built from the actual persisted record, not from
    // whatever the caller claims.
    const traceWrite = artifacts.writeWindow({
      entries: [
        {
          step: 0,
          events: [{ eventId: "evt-real-1", type: "collision" }]
        }
      ]
    });

    const realEpisode: PlaytestEpisode = {
      schema: "autodev-playtest-episode-v1",
      episodeId: "ep-1",
      revision: 1,
      batchId: "batch-1",
      identity: {
        workspaceId: WORKSPACE_ID,
        repository: WORKSPACE_ID,
        buildSha: "a".repeat(40),
        gameBuild: "build-1",
        scenarioId: "tutorial",
        configHash: "b".repeat(64),
        seed: "seed-1",
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
    };

    const mockRepo: PlaytestingRepositoryOps = {
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
      getEpisode: async (_ws, epId) => (epId === "ep-1" ? realEpisode : null),
      getLatestReviewForEpisode: async () => insertedReviews[0] ?? null,
      getFinding: async (_ws, findingId) =>
        insertedFindings.find((finding) => finding.findingId === findingId) ??
        null,
      getLatestReview: async (_ws, _episodeId, reviewId) =>
        insertedReviews.find((review) => review.reviewId === reviewId) ?? null,
      getLatestComparison: async () => null,
      insertBatch: async () => {},
      insertEpisode: async () => {},
      insertReview: async (review) => {
        insertedReviews.push(review);
      },
      insertFinding: async (_ws, finding) => {
        insertedFindings.push(finding);
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

    // 1. playtester cannot submit review
    const runnerReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
      episodeId: "ep-1",
      chronologicalSummary: "summary",
      status: "verified",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(parsedMcpError(runnerReview).code, "playtest_forbidden");

    currentRole = "unexpected-role";

    const unknownRoleReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
      episodeId: "ep-1",
      chronologicalSummary: "Unauthorized reviewer.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64)
    });
    assert.equal(parsedMcpError(unknownRoleReview).code, "playtest_forbidden");
    currentRole = "playtest-analyst";

    // 2. Fails if review has no evidence locators
    const emptyEvidenceReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
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
    const missingEpisodeReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
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
    const fabricatedEventReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
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
          findingId: "find-fabricated",
          severity: "major",
          status: "new",
          verificationStage: "candidate",
          evidenceStatus: "verified",
          title: "Fabricated hazard",
          description: "Cites an event that was never recorded.",
          evidenceRefs: [{ kind: "event", id: "evt-fabricated-1" }]
        }
      ]
    });
    assert.equal(fabricatedEventReview.isError, true);

    const unresolvedHypothesis = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
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
    const verifiedConclusion = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
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

    const verifiedFinding = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
      episodeId: "ep-1",
      chronologicalSummary: "Unverified review with a verified finding.",
      status: "hypothesis",
      evidenceRefs: [{ kind: "episode", id: "ep-1" }],
      rubricHash: "f".repeat(64),
      findings: [
        {
          findingId: "find-verified",
          severity: "major",
          status: "new",
          verificationStage: "candidate",
          evidenceStatus: "verified",
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

    // 5. Successful review submission citing the episode's real event.
    const validReview = await (server as any)._registeredTools[
      "playtest.submitReview"
    ].handler({
      episodeId: "ep-1",
      chronologicalSummary: "Player completed level 1 with normal pacing.",
      status: "hypothesis",
      evidenceRefs: [
        { kind: "episode", id: "ep-1" },
        { kind: "event", id: "evt-real-1" }
      ],
      rubricHash: "f".repeat(64),
      findings: [
        {
          findingId: "find-1",
          severity: "minor",
          status: "new",
          verificationStage: "candidate",
          evidenceStatus: "hypothesis",
          title: "Minor pacing lull",
          description: "Lull in corridor",
          evidenceRefs: [{ kind: "event", id: "evt-real-1" }]
        }
      ]
    });

    assert.equal(validReview.isError, undefined);
    const parsedReview = JSON.parse(validReview.content[0].text);
    assert.equal(parsedReview.episodeId, "ep-1");
    assert.equal(parsedReview.status, "hypothesis");
    assert.equal(parsedReview.rubricHash, "f".repeat(64));
    assert.equal(insertedReviews.length, 1);
    assert.equal(insertedFindings.length, 1);
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
        schema: "autodev-playtest-episode-v1",
        episodeId,
        revision: 1,
        batchId: "batch-1",
        identity: {
          workspaceId: WORKSPACE_ID,
          repository: WORKSPACE_ID,
          buildSha: "a".repeat(40),
          gameBuild: "build-1",
          scenarioId: "tutorial",
          configHash: "b".repeat(64),
          seed: "123",
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
            numerator: metricEstimate === null ? 0 : metricEstimate,
            denominator: 1,
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
        findingIds: episodeId === "ep-dummy-1" ? ["find-2"] : [],
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

    const dummyFinding: PlaytestFinding = {
      findingId: "find-2",
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

    const storedComparison: PlaytestComparison = {
      schema: "autodev-playtest-comparison-v1",
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
      humanPreference: { answer: "not-collected", interval: null },
      provenance: {
        workspaceId: WORKSPACE_ID,
        measurementVersion: "1.0.0",
        generatedAt: new Date().toISOString()
      },
      notes: ""
    };

    let requestedBatchMetricPage: {
      readonly batchId?: string;
      readonly limit: number | undefined;
      readonly cursor: string | undefined;
    } | null = null;
    const mockRepo: PlaytestingRepositoryOps = {
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
      getLatestReview: async () => null,
      getLatestComparison: async (_ws, comparisonId) =>
        comparisonId === storedComparison.comparisonId
          ? storedComparison
          : null,
      insertBatch: async () => {},
      insertEpisode: async () => {},
      insertReview: async () => {},
      insertFinding: async () => {}
    };

    const server = createTestPlaytestMcpServer({
      sessionProvider: {
        current: () => ({
          workspaceId: WORKSPACE_ID,
          role: "playtester",
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

    // 6. findings
    const findingsRes = await (server as any)._registeredTools[
      "playtest.findings"
    ].handler({});
    assert.equal(findingsRes.isError, undefined);
    const findingsParsed = JSON.parse(findingsRes.content[0].text);
    assert.equal(findingsParsed.total, 1);
    assert.equal(findingsParsed.rows[0].findingId, "find-2");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
