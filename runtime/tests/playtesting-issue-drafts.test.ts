/**
 * `playtest.issueDrafts`, driven through the real MCP server.
 *
 * This deliberately crosses every boundary between a game's declaration and the
 * operator's decision: the checked-in `playtest.config.json` on disk, its
 * SHA-256 against the approval, the approval repository, the capabilities view
 * that resolves both gates, and the registered tool handler itself. A unit test
 * that injected the gates would prove the Core builder -- already covered in
 * `core/tests/playtesting-issue-drafts.test.ts` -- and would pass even if the
 * config value were still read by nothing, which is the defect this exists to
 * close.
 *
 * Only the findings repository and the sandbox are substituted. Docker is
 * genuinely unavailable here; a file on disk is not.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPlaytestFindingIdentity,
  type PlaytestFinding,
  type PlaytestGameConfiguration,
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

// Must match the sample fixture's bound rubric workspace; the loader checks it.
const WORKSPACE_ID = "owner/fixture";
const SAMPLE_FIXTURE_ROOT = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A real checkout whose `.autodev/playtest.config.json` declares
 * `reporting.githubIssues`. The config is rewritten rather than substituted so
 * the approval's `playtestConfigHash` still has to match the exact bytes on
 * disk, which is what makes this a boundary test.
 */
function setupCheckout(githubIssues: "disabled" | "review"): {
  readonly root: string;
  readonly configBytes: Buffer;
  readonly configuration: PlaytestGameConfiguration;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "playtest-issue-drafts-")
  );
  mkdirSync(path.join(root, ".autodev"));
  for (const filename of [
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
  const configPath = path.join(root, ".autodev", "playtest.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const configuration = { ...config, reporting: { githubIssues } };
  writeFileSync(configPath, JSON.stringify(configuration) + "\n");
  return {
    root,
    configBytes: readFileSync(configPath),
    configuration: configuration as unknown as PlaytestGameConfiguration,
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
  // Taken from the config rather than restated, so the approval stays bound to
  // whatever the fixture declares. Hardcoding these drifted out of agreement
  // with the fixture budget, which the loader rejects -- a fail-closed check
  // doing exactly its job.
  const budget = checkout.configuration.budget;
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    revision: 1,
    approvalId: "approval-issue-drafts",
    workspaceId: WORKSPACE_ID,
    approvedBy: "operator@example.com",
    approvedAt: "2026-10-10T00:00:00.000Z",
    checkoutRoot: checkout.root,
    buildSha: "a".repeat(40),
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

function finding(
  overrides: Partial<PlaytestFinding> & { findingId: string }
): PlaytestFinding {
  return {
    identity: buildPlaytestFindingIdentity({
      workspaceId: WORKSPACE_ID,
      mechanicKey: "action-execution",
      failureSignature: { events: ["action.rejected"], witness: overrides.findingId },
      scope: { scenarioFamily: "onboarding" }
    }),
    fingerprint: "a".repeat(64),
    version: 1,
    title: "Legal action rejected mid-phase",
    description: "A freshly advertised action was refused by the engine.",
    severity: "major",
    status: "open",
    verificationStage: "not-yet-validated",
    evidenceStatus: "verified",
    affectedEpisodes: 4,
    totalEligibleEpisodes: 20,
    affectedOpportunities: 9,
    totalEligibleOpportunities: 40,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-17", step: 23 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: null,
    nextReviewAt: null,
    ...overrides
  };
}

/** Only the storage seam is substituted; the gate logic under test is not. */
function findingsRepository(
  rows: readonly PlaytestFinding[]
): PlaytestingRepositoryOps {
  return {
    async listFindings() {
      return { rows: [...rows], total: rows.length, nextCursor: null };
    }
  } as unknown as PlaytestingRepositoryOps;
}

interface Harness {
  readonly callIssueDrafts: () => Promise<Record<string, unknown>>;
  readonly callCapabilities: () => Promise<Record<string, unknown>>;
  readonly cleanup: () => void;
}

async function harness(
  approved: WorkspacePlaytestApproval,
  rows: readonly PlaytestFinding[]
): Promise<Harness> {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-issue-drafts-run-"))
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
  const playtestRunControl = createPlaytestRunControl({
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: findingsRepository(rows),
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
    role: "operator",
    actor: "operator-1"
  };
  const server = createPlaytestMcpServer({
    sessionProvider: { current: () => session },
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: findingsRepository(rows),
    playtestRunControl
  });
  approvalRepo.approve(approved, null);

  const call = async (tool: string, args: unknown) => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    const typed = (await tools[tool]!.handler(args)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(typed.isError, undefined, `${tool} must not error`);
    return JSON.parse(typed.content[0]!.text) as Record<string, unknown>;
  };

  return {
    callIssueDrafts: () => call("playtest.issueDrafts", {}),
    callCapabilities: () => call("playtest.capabilities", {}),
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true })
  };
}

test("playtest.issueDrafts drafts findings when the checked-in config asks for review", async () => {
  const checkout = setupCheckout("review");
  let api: Harness | undefined;
  try {
    const approved = approval(checkout);
    api = await harness(approved, [
      finding({ findingId: "finding-verified" }),
      finding({
        findingId: "finding-hypothesis",
        evidenceStatus: "hypothesis"
      })
    ]);
    // The two gates must both be visible on the capabilities view, or an
    // operator cannot tell a game that asked for review from one that did not.
    const capabilities = await api.callCapabilities();
    assert.equal(capabilities.configuredIssueReporting, "review");
    assert.equal(capabilities.issueReporting, "review");

    const result = await api.callIssueDrafts();
    assert.equal(result.refusal, null);
    assert.equal(result.published, false);
    assert.equal(result.requiresOperatorAction, true);
    assert.equal(result.examinedFindings, 2);

    const drafts = result.drafts as {
      findingId: string;
      disposition: string;
      body: string;
      requiresOperatorAction: boolean;
    }[];
    assert.deepEqual(
      drafts.map((draft) => [draft.findingId, draft.disposition]),
      [
        ["finding-verified", "ready-for-operator-review"],
        ["finding-hypothesis", "hypothesis-not-a-confirmed-defect"]
      ]
    );
    for (const draft of drafts) {
      assert.equal(draft.requiresOperatorAction, true);
      assert.match(draft.body, /drafted by AutoDev, not filed/u);
      assert.match(draft.body, /Nothing was published/u);
    }
    // The hypothesis draft must carry the instruction, not a reminder.
    assert.match(
      drafts[1]!.body,
      /must not be published as a confirmed defect/u
    );
  } finally {
    checkout.cleanup();
    api?.cleanup();
  }
});

test("a game asking for review cannot grant itself the operator's withheld authority", async () => {
  const checkout = setupCheckout("review");
  let api: Harness | undefined;
  try {
    // The config still says review; the operator withheld the grant.
    api = await harness(
      approval(checkout, { issueReporting: "disabled" }),
      [finding({ findingId: "finding-verified" })]
    );
    const capabilities = await api.callCapabilities();
    assert.equal(capabilities.configuredIssueReporting, "review");
    assert.equal(capabilities.issueReporting, "disabled");

    const result = await api.callIssueDrafts();
    assert.deepEqual(result.drafts, []);
    assert.match(
      result.refusal as string,
      /workspace approval does not grant issueReporting/u
    );
  } finally {
    checkout.cleanup();
    api?.cleanup();
  }
});

test("a game that asked for nothing produces no drafts even with an operator grant", async () => {
  const checkout = setupCheckout("disabled");
  let api: Harness | undefined;
  try {
    api = await harness(approval(checkout), [
      finding({ findingId: "finding-verified" })
    ]);
    const capabilities = await api.callCapabilities();
    assert.equal(capabilities.configuredIssueReporting, "disabled");
    assert.equal(capabilities.issueReporting, "review");

    const result = await api.callIssueDrafts();
    assert.deepEqual(result.drafts, []);
    assert.match(
      result.refusal as string,
      /reporting\.githubIssues="disabled"/u
    );
  } finally {
    checkout.cleanup();
    api?.cleanup();
  }
});

test("an unreadable checkout config fails closed rather than claiming authority", async () => {
  const checkout = setupCheckout("review");
  let api: Harness | undefined;
  try {
    const approved = approval(checkout);
    // Destroy the config after the approval's digest was computed: the
    // approval is still "review", but nothing readable declares review.
    rmSync(path.join(checkout.root, ".autodev", "playtest.config.json"));
    api = await harness(approved, [
      finding({ findingId: "finding-verified" })
    ]);

    const capabilities = await api.callCapabilities();
    assert.equal(capabilities.configuredIssueReporting, "disabled");
    assert.equal(capabilities.issueReporting, "review");

    const result = await api.callIssueDrafts();
    assert.deepEqual(result.drafts, []);
    assert.match(
      result.refusal as string,
      /reporting\.githubIssues="disabled"/u
    );
  } finally {
    checkout.cleanup();
    api?.cleanup();
  }
});
