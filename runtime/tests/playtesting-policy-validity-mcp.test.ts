/**
 * `playtest.policyValidity`, driven through the real MCP server.
 *
 * The point of this file is the seam the unit test cannot cross: that the
 * policy versions in the answer come from the *approved benchmark on disk*
 * rather than from anything the derivation assumed, and that the record is
 * built from the frozen coverage manifest the batch actually carries.
 *
 * So the checkout, the approval, the benchmark, the observation contract and
 * the rubric are all real files on disk, and the coverage manifest is computed
 * by Core from the approved rubric. Only the repository (the storage seam) and
 * the sandbox are substituted; Docker is genuinely unavailable here, a file is
 * not.
 *
 * If the tool ever stopped reading the benchmark it could not name the policy
 * version, and the cell would be reported `policy-version-undeclared` instead
 * of producing a record. That is the assertion which makes this a boundary
 * test rather than a restatement of the derivation's own unit test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  buildPlaytestCoverageManifestDraft,
  type PlaytestAssignmentManifest,
  playtestAssignmentManifestHashInput,
  type PlaytestBatch,
  type PlaytestBatchAssignment,
  type PlaytestCoverageEpisode,
  type PlaytestCoverageManifest,
  playtestCoverageManifestHashInput,
  playtestCoveragePlanForRegistry,
  type PlaytestGameConfiguration,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { loadApprovedPlaytestDefinition } from "../src/playtesting/approved-configuration.ts";
import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpSession
} from "../src/playtesting/mcp.ts";

const WORKSPACE_ID = "owner/fixture";
const BATCH_ID = "batch-policy-validity-seam";
const BUILD_SHA = "a".repeat(40);
const CREATED_AT = "2026-10-12T00:00:00.000Z";
const SAMPLE_FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A real checkout whose config is the fixture's, byte for byte. */
function setupCheckout(): {
  readonly root: string;
  readonly configBytes: Buffer;
  readonly configuration: PlaytestGameConfiguration;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "playtest-policy-validity-")
  );
  mkdirSync(path.join(root, ".autodev"));
  for (const filename of [
    "playtest.config.json",
    "playtest.binding.json",
    "node-fixture-game.mjs",
    "playtest.observation.json",
    "playtest.rubric.json",
    "playtest.benchmark.json"
  ]) {
    copyFileSync(
      path.join(SAMPLE_FIXTURE_ROOT, filename),
      path.join(root, ".autodev", filename)
    );
  }
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

function approval(
  checkout: {
    root: string;
    configBytes: Buffer;
    configuration: PlaytestGameConfiguration;
  },
  overrides: Partial<WorkspacePlaytestApproval> = {}
): WorkspacePlaytestApproval {
  const budget = checkout.configuration.budget;
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    revision: 1,
    approvalId: "approval-policy-validity",
    workspaceId: WORKSPACE_ID,
    approvedBy: "operator@example.com",
    approvedAt: "2026-10-10T00:00:00.000Z",
    checkoutRoot: checkout.root,
    buildSha: BUILD_SHA,
    gameBuild: "fixture-build-1",
    playtestConfigHash: digest(checkout.configBytes),
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
    revocationReason: null,
    ...overrides
  };
}

/** The policy and cohort the fixture's own rubric plans coverage for. */
const ASSIGNMENT: PlaytestBatchAssignment = {
  assignmentId: "a-0001",
  scenarioId: "tutorial",
  scenarioFamily: "onboarding",
  policyId: "random",
  policyVersion: "hmac-sha256-v1",
  cohort: "exploratory",
  seed: "seed-1",
  maxSteps: 20
};

function batchFromApproved(
  approved: WorkspacePlaytestApproval,
  options: { readonly manifest: PlaytestCoverageManifest | null }
): PlaytestBatch {
  const manifest = assignmentManifest();
  const definition = loadApprovedPlaytestDefinition(approved);
  const benchmark = definition.benchmark;
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: BATCH_ID,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    repository: WORKSPACE_ID,
    buildSha: approved.buildSha,
    gameBuild: approved.gameBuild,
    configHash: approved.playtestConfigHash,
    rubricHash: definition.rubricHash,
    actionSchemaHash: benchmark?.actionSchemaHash ?? null,
    observationSchemaHash: definition.observationContract.schemaHash,
    eventSchemaHash: benchmark?.eventSchemaHash ?? null,
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: ["random"],
    cohortIds: ["exploratory"],
    scenarioIds: ["tutorial"],
    assignmentInventory: { status: "frozen", manifest },
    coverageManifest: options.manifest,
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
      wallTimeMs: approved.limits.wallTimeMs,
      critiqueBudget: approved.limits.critiqueCount,
      actualCritiques: 0
    },
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    createdAt: CREATED_AT,
    provenance: {
      workspaceId: WORKSPACE_ID,
      buildSha: approved.buildSha,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt: CREATED_AT
    },
    evaluationIds: [],
    spanIds: []
  };
}

/** A real content-hashed assignment manifest; a cast would hide a field rename. */
function assignmentManifest(): PlaytestAssignmentManifest {
  const base = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: BUILD_SHA,
    configHash: "f".repeat(64),
    rubricHash: "b".repeat(64),
    approvalRevision: 1,
    createdAt: CREATED_AT,
    assignments: [ASSIGNMENT]
  };
  return {
    ...base,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(base))
      .digest("hex")
  };
}

/**
 * Coverage computed by Core from the *approved* rubric, so the cells the
 * derivation reads are the ones the approved rubric actually plans.
 */
function manifestForApproved(approved: WorkspacePlaytestApproval): {
  readonly manifest: PlaytestCoverageManifest;
  readonly rubricHash: string;
} {
  const definition = loadApprovedPlaytestDefinition(approved);
  const draft = buildPlaytestCoverageManifestDraft({
    rubricHash: definition.rubricHash,
    assignmentManifestHash: digest(`assignments:${ASSIGNMENT.assignmentId}`),
    mode: definition.observationContract.mode,
    generatedAt: CREATED_AT,
    batchId: BATCH_ID,
    workspaceId: WORKSPACE_ID,
    buildSha: approved.buildSha,
    plan: playtestCoveragePlanForRegistry(definition.rubric),
    assignments: [ASSIGNMENT],
    episodes: [episodeFor(4)]
  });
  return {
    rubricHash: definition.rubricHash,
    manifest: {
      ...draft,
      contentHash: createHash("sha256")
        .update(playtestCoverageManifestHashInput(draft))
        .digest("hex")
    }
  };
}

function episodeFor(opportunities: number): PlaytestCoverageEpisode {
  return {
    batchId: BATCH_ID,
    assignmentId: ASSIGNMENT.assignmentId,
    identity: {
      workspaceId: WORKSPACE_ID,
      buildSha: BUILD_SHA,
      scenarioId: ASSIGNMENT.scenarioId,
      policyId: ASSIGNMENT.policyId,
      policyVersion: ASSIGNMENT.policyVersion,
      seed: ASSIGNMENT.seed
    },
    scenarioFamily: ASSIGNMENT.scenarioFamily,
    policyCohort: ASSIGNMENT.cohort ?? "unknown",
    metrics: [
      {
        metricId: "legal-action-rejection",
        metricVersion: 1,
        phaseId: "tutorial",
        numerator: opportunities,
        denominator: opportunities,
        opportunityCount: opportunities,
        coverage: 1,
        unit: "proportion",
        estimate: 1,
        missing: 0,
        missingReasons: [],
        independentUnits: 1,
        provenance: {
          workspaceId: WORKSPACE_ID,
          buildSha: BUILD_SHA,
          evaluatorHash: "1".repeat(64),
          rubricHash: "b".repeat(64),
          measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
          generatedAt: CREATED_AT
        },
        notes: "seam fixture"
      }
    ],
    episodeId: "ep-1"
  } as PlaytestCoverageEpisode;
}

interface Harness {
  readonly call: (args: unknown) => Promise<Record<string, unknown>>;
  /** The tool reports refusals as `isError` payloads rather than throwing. */
  readonly callExpectingRefusal: (args: unknown) => Promise<string>;
  readonly cleanup: () => void;
}

async function harness(
  approved: WorkspacePlaytestApproval,
  manifest: PlaytestCoverageManifest | null
): Promise<Harness> {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-policy-validity-run-"))
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
  const stored = batchFromApproved(approved, { manifest });
  // Respects the requested id: a stub that returned `stored` unconditionally
  // would let the missing-batch branch go untested while appearing to pass.
  const repository = {
    async getBatch(_workspaceId: string, batchId: string) {
      return batchId === BATCH_ID ? stored : null;
    }
  } as unknown as PlaytestingRepositoryOps;

  const playtestRunControl = createPlaytestRunControl({
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
    role: "playtest-analyst",
    actor: "analyst-1"
  };
  const server = createPlaytestMcpServer({
    sessionProvider: { current: () => session },
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    approvalRepository: approvalRepo,
    playtestRunControl
  });
  approvalRepo.approve(approved, null);

  const invoke = async (args: unknown) => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    return (await tools["playtest.policyValidity"]!.handler(args)) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
  };

  return {
    call: async (args: unknown) => {
      const result = await invoke(args);
      const text = result.content.find((part) => part.text)?.text ?? "{}";
      return JSON.parse(text) as Record<string, unknown>;
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
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true })
  };
}

test("policy validity is derived from the run, with the policy version taken from the approved benchmark", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { manifest } = manifestForApproved(approved);
    const { call, cleanup } = await harness(approved, manifest);
    try {
      const result = await call({
        workspaceId: WORKSPACE_ID,
        batchId: BATCH_ID
      });

      assert.equal(result.batchId, BATCH_ID);
      assert.equal(result.buildSha, BUILD_SHA);
      assert.equal(result.coverageManifestHash, manifest.contentHash);
      assert.equal(result.preregisteredHumanEvidence, false);

      // The basis is named and is the approved benchmark's own hash, so a
      // reader can check which declaration supplied the versions.
      const definition = loadApprovedPlaytestDefinition(approved);
      assert.equal(result.policyVersionsBasis, definition.benchmarkHash);

      const records = result.records as readonly {
        validity: Record<string, unknown>;
        humanProxyRefusal: string | null;
        observedEpisodes: number;
        eligibleOpportunities: number;
      }[];
      assert.equal(records.length, 1);
      const record = records[0]!;

      // `hmac-sha256-v1` exists only in the approved benchmark on disk.
      assert.equal(record.validity.policyId, "random");
      assert.equal(record.validity.policyVersion, "hmac-sha256-v1");
      assert.equal(record.validity.cohortId, "exploratory");
      assert.equal(record.validity.competence, "unvalidated-synthetic");
      assert.deepEqual(record.validity.heldOutHumanStateIds, []);
      assert.equal(record.validity.legalityRate, null);
      assert.equal(record.validity.repeatability, null);
      assert.equal(record.validity.actionAgreement, null);
      assert.equal(record.validity.distributionDivergence, null);
      assert.equal(record.observedEpisodes, 1);
      assert.equal(record.eligibleOpportunities, 4);

      // §6's downgrade travels with the record instead of being implied.
      assert.match(record.humanProxyRefusal ?? "", /synthetic cohort/);

      assert.deepEqual(result.unmeasurable, []);
    } finally {
      cleanup();
    }
  } finally {
    checkout.cleanup();
  }
});

test("an absent frozen manifest is reported as an absent basis, not as an empty result", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { call, cleanup } = await harness(approved, null);
    try {
      const result = await call({
        workspaceId: WORKSPACE_ID,
        batchId: BATCH_ID
      });
      assert.equal(result.coverageManifestHash, null);
      assert.deepEqual(result.records, []);
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
    const { manifest } = manifestForApproved(approved);
    const { callExpectingRefusal, cleanup } = await harness(approved, manifest);
    try {
      const text = await callExpectingRefusal({
        workspaceId: WORKSPACE_ID,
        batchId: "batch-does-not-exist"
      });
      // A missing batch is a validation refusal, which is how a caller tells
      // it apart from a successful call whose policies were all unmeasurable.
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

test("the tool refuses a workspace the session is not authorized for", async () => {
  const checkout = setupCheckout();
  try {
    const approved = approval(checkout);
    const { manifest } = manifestForApproved(approved);
    const { callExpectingRefusal, cleanup } = await harness(approved, manifest);
    try {
      const text = await callExpectingRefusal({
        workspaceId: "other/workspace",
        batchId: BATCH_ID
      });
      // The refusal is an authorization error. Its message is deliberately
      // generic, so assert the machine-readable code rather than prose.
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
