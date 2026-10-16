/**
 * `playtest.cohortMixShift`, driven through the real MCP server.
 *
 * The point of this file is the seam the unit test cannot cross: that the
 * weights the gate judges against are the *approved benchmark's on disk*, and
 * that the refusal a caller sees is a named refusal rather than a padded
 * result. So the checkout, the approval and the benchmark are real files, and
 * the cohort weights come from `playtest.benchmark.json` rather than from
 * anything this test chose. Only the repository (the storage seam) and the
 * sandbox are substituted; Docker is genuinely unavailable here, a file is not.
 *
 * The fixture benchmark weights one cohort (`onboarding`), which is not the
 * two-cohort mix of §10. That is deliberate: if the tool ever stopped reading
 * the benchmark's own weights it could not standardize against `onboarding` at
 * all, and the assertion below would fail rather than quietly passing against a
 * weight this test supplied.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type PlaytestBatch,
  type PlaytestEpisode,
  type PlaytestGameConfiguration,
  type PlaytestNumericResult,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpSession
} from "../src/playtesting/mcp.ts";
import {
  commitFixtureCheckout,
  isolatedPlaytestPreparer
} from "./support/playtest-checkout.ts";

const WORKSPACE_ID = "owner/fixture";
const REFERENCE_BATCH_ID = "batch-mix-reference";
const CANDIDATE_BATCH_ID = "batch-mix-candidate";
const REFERENCE_SHA = "1".repeat(40);
const CANDIDATE_SHA = "2".repeat(40);
const CREATED_AT = "2026-10-12T00:00:00.000Z";
/** The only cohort `playtest.benchmark.json` declares a weight for. */
const WEIGHTED_COHORT = "onboarding";
const METRIC_ID = "legal-action-rejection";
const SAMPLE_FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

function setupCheckout(): {
  readonly root: string;
  readonly configBytes: Buffer;
  readonly configuration: PlaytestGameConfiguration;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "playtest-mix-shift-")
  );
  mkdirSync(path.join(root, ".autodev"));
  for (const filename of [
    "playtest.binding.json",
    "playtest.config.json",
    "playtest.observation.json",
    "playtest.rubric.json",
    "playtest.benchmark.json"
  ]) {
    copyFileSync(
      path.join(SAMPLE_FIXTURE_ROOT, filename),
      path.join(root, ".autodev", filename)
    );
  }
  commitFixtureCheckout(root);
  const configPath = path.join(root, ".autodev", "playtest.config.json");
  return {
    root,
    configBytes: readFileSync(configPath),
    configuration: JSON.parse(
      readFileSync(configPath, "utf8")
    ) as PlaytestGameConfiguration,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function approval(checkout: {
  readonly root: string;
  readonly configBytes: Buffer;
  readonly configuration: PlaytestGameConfiguration;
}): WorkspacePlaytestApproval {
  const budget = checkout.configuration.budget;
  return {
    schema: "autodev-workspace-playtest-approval-v2",
    revision: 1,
    approvalId: "approval-mix-shift",
    workspaceId: WORKSPACE_ID,
    approvedBy: "operator@example.com",
    approvedAt: "2026-10-10T00:00:00.000Z",
    checkoutRoot: checkout.root,
    adapterImageDigest: `sha256:${"c".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: [...checkout.configuration.adapter.command],
    allowedScenarios: [...checkout.configuration.scenarios],
    allowedPolicies: [...checkout.configuration.policies],
    limits: {
      cpuCores: 2,
      memoryBytes: 512 * 1024 * 1024,
      processCount: 16,
      wallTimeMs: budget.wallTimeMinutes * 60_000,
      artifactBytes: 64 * 1024 * 1024,
      workerCount: budget.workers,
      episodeCount: budget.episodes,
      maxStepsPerEpisode: budget.maxStepsPerEpisode,
      critiqueCount: checkout.configuration.analysis.maxReviewedSessions
    },
    retentionDays: 30,
    issueReporting: "review",
    humanStudyAllowed: false,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

function batch(batchId: string, buildSha: string): PlaytestBatch {
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha,
    gameBuild: "fixture-build-1",
    configHash: "b".repeat(64),
    rubricHash: "3".repeat(64),
    actionSchemaHash: "d".repeat(64),
    observationSchemaHash: "c".repeat(64),
    eventSchemaHash: "e".repeat(64),
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: ["random"],
    cohortIds: [WEIGHTED_COHORT],
    scenarioIds: ["tutorial"],
    assignmentInventory: {
      status: "unavailable",
      reason: "recorded-before-assignment-manifests"
    },
    coverageManifest: null,
    unobservedAssignments: [],
    reviewPackets: [],
    reviewSelection: { status: "pending" },
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
      eligible: 1
    },
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      critiqueBudget: 4,
      actualCritiques: 0
    },
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    createdAt: CREATED_AT,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: CREATED_AT
    },
    evaluationIds: [],
    spanIds: []
  } as unknown as PlaytestBatch;
}

function metricRow(
  buildSha: string,
  overrides: Partial<PlaytestNumericResult> = {}
): PlaytestNumericResult {
  const numerator = overrides.numerator ?? 8;
  const denominator = overrides.denominator ?? 10;
  const missing = overrides.missing ?? 0;
  const opportunityCount = overrides.opportunityCount ?? denominator + missing;
  return {
    metricId: METRIC_ID,
    metricVersion: 1,
    phaseId: "tutorial",
    numerator,
    denominator,
    opportunityCount,
    coverage: opportunityCount === 0 ? 0 : denominator / opportunityCount,
    unit: "proportion",
    estimate: denominator === 0 ? null : numerator / denominator,
    missing,
    missingReasons: missing > 0 ? ["outside-window"] : [],
    independentUnits: 1,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha,
      evaluatorHash: "9".repeat(64),
      rubricHash: "3".repeat(64),
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: CREATED_AT
    },
    notes: "seam fixture",
    ...overrides
  };
}

function episode(
  episodeId: string,
  batchId: string,
  buildSha: string,
  rows: readonly PlaytestNumericResult[]
): PlaytestEpisode {
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId,
    revision: 1,
    batchId,
    assignmentId: `assignment-${episodeId}`,
    branchLineage: null,
    identity: {
      workspaceId: WORKSPACE_ID,
      repository: WORKSPACE_ID,
      buildSha,
      gameBuild: "fixture-build-1",
      scenarioId: "tutorial",
      configHash: "b".repeat(64),
      seed: `seed-${episodeId}`,
      rngInitialStateHash: null,
      rngAlgorithm: null,
      rngVersion: null,
      policyId: "random",
      policyVersion: "hmac-sha256-v1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: "c".repeat(64),
      actionSchemaHash: "d".repeat(64),
      eventSchemaHash: "e".repeat(64),
      protocolVersion: 1,
      runtimeVersion: "1.0.0",
      environmentHash: "f".repeat(64)
    },
    scenarioFamily: "onboarding",
    policyCohort: WEIGHTED_COHORT,
    strategy: "seam fixture",
    status: "completed",
    termination: { reason: "game-terminal", step: 0 },
    outcome: "completed",
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
    replayStatus: { status: "not-requested" },
    trace: null,
    frames: [],
    stepCount: 10,
    metrics: [...rows],
    findingIds: [],
    assignedAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    simulationWallMs: null,
    logicalTicks: null,
    policyInferenceMs: null,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  } as unknown as PlaytestEpisode;
}

interface Harness {
  readonly call: (args: unknown) => Promise<MixShiftPayload>;
  readonly callExpectingRefusal: (args: unknown) => Promise<string>;
  readonly cleanup: () => void;
}

async function harness(options: {
  readonly approved: WorkspacePlaytestApproval;
  readonly role?: PlaytestMcpSession["role"];
  /** Rows the reference batch's episode recorded. */
  readonly referenceRows: readonly PlaytestNumericResult[];
  readonly candidateRows: readonly PlaytestNumericResult[];
}): Promise<Harness> {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-mix-shift-run-"))
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

  const stored = new Map<string, PlaytestBatch>([
    [REFERENCE_BATCH_ID, batch(REFERENCE_BATCH_ID, REFERENCE_SHA)],
    [CANDIDATE_BATCH_ID, batch(CANDIDATE_BATCH_ID, CANDIDATE_SHA)]
  ]);
  const episodesByBatch: Record<string, readonly PlaytestEpisode[]> = {
    [REFERENCE_BATCH_ID]: [
      episode(
        "ep-reference",
        REFERENCE_BATCH_ID,
        REFERENCE_SHA,
        options.referenceRows
      )
    ],
    [CANDIDATE_BATCH_ID]: [
      episode(
        "ep-candidate",
        CANDIDATE_BATCH_ID,
        CANDIDATE_SHA,
        options.candidateRows
      )
    ]
  };

  // Respects the requested ids: a stub that always returned the reference
  // would let the missing-batch branch pass while exercising nothing.
  const repository = {
    async getBatch(_workspaceId: string, batchId: string) {
      return stored.get(batchId) ?? null;
    },
    async listEpisodes(args: { readonly batchId: string }) {
      const rows = episodesByBatch[args.batchId] ?? [];
      return { rows, total: rows.length, nextCursor: null };
    }
  } as unknown as PlaytestingRepositoryOps;

  const preparer = isolatedPlaytestPreparer();
  const playtestRunControl = createPlaytestRunControl({
    prepareSandboxHandler: preparer.prepare,
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    approvalRepository: approvalRepo,
    readWorkspaceCatalog: () => ({
      status: "valid",
      workspaces: [
        {
          id: WORKSPACE_ID,
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        }
      ]
    })
  });
  const session: PlaytestMcpSession = {
    workspaceId: WORKSPACE_ID,
    role: options.role ?? "playtest-analyst",
    actor: "analyst-1"
  };
  const server = createPlaytestMcpServer({
    sessionProvider: { current: () => session },
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    approvalRepository: approvalRepo,
    playtestRunControl,
    prepareSandboxHandler: preparer.prepare
  });
  approvalRepo.approve(options.approved, null);

  const invoke = async (args: unknown) => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    return (await tools["playtest.cohortMixShift"]!.handler(args)) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
  };

  return {
    call: async (args: unknown) => {
      const result = await invoke(args);
      const text = result.content.find((part) => part.text)?.text ?? "{}";
      return JSON.parse(text) as MixShiftPayload;
    },
    callExpectingRefusal: async (args: unknown) => {
      const result = await invoke(args);
      assert.equal(
        result.isError,
        true,
        "a refusal must arrive as an error rather than as an empty result"
      );
      return result.content.find((part) => part.text)?.text ?? "";
    },
    cleanup: () => {
      preparer.cleanup();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  };
}

function closeTo(actual: unknown, expected: number): void {
  assert.equal(
    typeof actual === "number" && Math.abs(actual - expected) < 1e-12,
    true,
    `expected ${String(actual)} to equal ${String(expected)}`
  );
}

/** The tool's JSON payload, typed at the fields these tests assert on. */
interface MixShiftPayload {
  standardized: boolean;
  result: {
    builds: { buildId: string; standardizedRate: number }[];
  } | null;
  refusals: unknown[];
  referenceBuildSha: string;
  candidateBuildSha: string;
  buildObservations: Record<string, unknown>;
  contributingEpisodesByBuild: Record<string, number>;
  skippedRowsByBuild: Record<string, number>;
}

test("both builds are standardized against the approved benchmark's own cohort weights", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { call, cleanup } = await harness({
      approved,
      referenceRows: [metricRow(REFERENCE_SHA, { numerator: 8 })],
      candidateRows: [
        metricRow(CANDIDATE_SHA, { numerator: 5, denominator: 10 })
      ]
    });
    try {
      const result = await call({
        workspaceId: WORKSPACE_ID,
        referenceBatchId: REFERENCE_BATCH_ID,
        candidateBatchId: CANDIDATE_BATCH_ID,
        metricId: METRIC_ID
      });

      assert.equal(result.standardized, true);
      assert.deepEqual(result.refusals, []);
      assert.equal(result.referenceBuildSha, REFERENCE_SHA);
      assert.equal(result.candidateBuildSha, CANDIDATE_SHA);

      // `onboarding` is the only cohort the on-disk benchmark weights, so a
      // tool inventing its own weights could not have produced this shape.
      assert.deepEqual(result.buildObservations, {
        [REFERENCE_SHA]: {
          [WEIGHTED_COHORT]: { numerator: 8, denominator: 10, missing: 0 }
        },
        [CANDIDATE_SHA]: {
          [WEIGHTED_COHORT]: { numerator: 5, denominator: 10, missing: 0 }
        }
      });

      const builds = result.result!.builds;
      assert.deepEqual(
        builds.map((build) => build.buildId),
        [REFERENCE_SHA, CANDIDATE_SHA]
      );
      closeTo(builds[0]!.standardizedRate, 0.8);
      closeTo(builds[1]!.standardizedRate, 0.5);
      assert.equal(result.skippedRowsByBuild[REFERENCE_SHA], 0);
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});

test("a build that never observed the weighted cohort is named, not zero-filled", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { call, cleanup } = await harness({
      approved,
      // The reference recorded rows, just not for this metric.
      referenceRows: [
        metricRow(REFERENCE_SHA, { metricId: "some-other-metric" })
      ],
      candidateRows: [metricRow(CANDIDATE_SHA)]
    });
    try {
      const result = await call({
        workspaceId: WORKSPACE_ID,
        referenceBatchId: REFERENCE_BATCH_ID,
        candidateBatchId: CANDIDATE_BATCH_ID,
        metricId: METRIC_ID
      });

      // No result at all: the alternative would be claiming the reference run
      // looked at `onboarding` and observed nothing.
      assert.equal(result.standardized, false);
      assert.equal(result.result, null);
      assert.deepEqual(result.refusals, [
        {
          buildId: REFERENCE_SHA,
          reason: "cohort-set-mismatch",
          unobservedCohorts: [WEIGHTED_COHORT],
          unweightedCohorts: []
        }
      ]);
      assert.deepEqual(result.buildObservations[REFERENCE_SHA], {});
      // The row was skipped, not silently dropped.
      assert.equal(result.skippedRowsByBuild[REFERENCE_SHA], 1);
      assert.equal(result.contributingEpisodesByBuild[REFERENCE_SHA], 0);
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});

test("an unknown batch is a validation refusal rather than an empty result", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { callExpectingRefusal, cleanup } = await harness({
      approved,
      referenceRows: [metricRow(REFERENCE_SHA)],
      candidateRows: [metricRow(CANDIDATE_SHA)]
    });
    try {
      const text = await callExpectingRefusal({
        workspaceId: WORKSPACE_ID,
        referenceBatchId: "batch-does-not-exist",
        candidateBatchId: CANDIDATE_BATCH_ID,
        metricId: METRIC_ID
      });
      // The message is redacted by the shared error layer, so assert the
      // machine-readable code rather than the handler's own wording.
      const payload = JSON.parse(text) as {
        error: { code: string; category: string };
      };
      assert.equal(payload.error.category, "validation");
      assert.equal(payload.error.code, "playtest_invalid_request");
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});

test("a runner may not read the comparison", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    // `playtester` executes and observes; interpreting a mix shift is the
    // analyst's job, per the target state's two-role split.
    const { callExpectingRefusal, cleanup } = await harness({
      approved,
      role: "playtester",
      referenceRows: [metricRow(REFERENCE_SHA)],
      candidateRows: [metricRow(CANDIDATE_SHA)]
    });
    try {
      const text = await callExpectingRefusal({
        workspaceId: WORKSPACE_ID,
        referenceBatchId: REFERENCE_BATCH_ID,
        candidateBatchId: CANDIDATE_BATCH_ID,
        metricId: METRIC_ID
      });
      const payload = JSON.parse(text) as {
        error: { code: string; category: string };
      };
      assert.equal(payload.error.category, "authorization");
      assert.equal(payload.error.code, "playtest_forbidden");
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});

test("the tool refuses a workspace the session is not authorized for", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { callExpectingRefusal, cleanup } = await harness({
      approved,
      referenceRows: [metricRow(REFERENCE_SHA)],
      candidateRows: [metricRow(CANDIDATE_SHA)]
    });
    try {
      const text = await callExpectingRefusal({
        workspaceId: "other/workspace",
        referenceBatchId: REFERENCE_BATCH_ID,
        candidateBatchId: CANDIDATE_BATCH_ID,
        metricId: METRIC_ID
      });
      const payload = JSON.parse(text) as {
        error: { code: string; category: string };
      };
      assert.equal(payload.error.category, "authorization");
      assert.equal(payload.error.code, "playtest_forbidden");
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});
