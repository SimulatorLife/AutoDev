/**
 * The visual episode's wall-time budget is one budget with one owner.
 *
 * The browser driver enforces the approved per-episode wall-time ceiling
 * before every observation and every action, and the Smart-direct decision
 * deadline has to be that same ceiling: a decision may not outlive the
 * episode, and an episode that runs out of its approved budget is truncated,
 * not failed. A decision cut off by a shorter, competing cap reports a
 * healthy episode as a runtime failure.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestEpisode,
  type PlaytestLaunchRequest,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";
import { WorkspaceVisualPlaytestTargetRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestRunControl,
  type PlaytestMcpSession,
  type PlaytestingRepositoryOps
} from "../src/playtesting/mcp.ts";
import type {
  PlaytestVisualDriverOpener,
  PlaytestVisualEpisodeDriver
} from "../src/playtesting/visual-browser-driver.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./support/playtesting-launch-intents.ts";

const WORKSPACE_ID = "fixture/visual-budget";
const TARGET_ID = "racing-game-local";
const ORIGIN = "http://127.0.0.1:5173";

function approval(
  limits: WorkspaceVisualPlaytestTargetApproval["limits"]
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: TARGET_ID,
    revision: 1,
    approvalId: "visual-approval-budget-1",
    name: "Visual budget fixture",
    entryUrl: ORIGIN + "/",
    allowedOrigins: [ORIGIN],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits,
    approvedAt: "2026-10-20T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

function targetLimits(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval["limits"]> = {}
): WorkspaceVisualPlaytestTargetApproval["limits"] {
  return {
    episodeCount: 1,
    maxStepsPerEpisode: 3,
    wallTimeMs: 5_000,
    smartRequestsPerEpisode: 5,
    smartTokensPerEpisode: 20_000,
    screenshotCountPerEpisode: 10,
    artifactBytesPerEpisode: 1_073_741_824,
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

function session(): PlaytestMcpSession {
  return {
    workspaceId: WORKSPACE_ID,
    role: "playtester",
    actor: "operator-1"
  };
}

/**
 * A browser that never launches one. It reports the approved wall-time budget
 * it still has left, hands the episode a real stored frame, and records the
 * actions the episode dispatched.
 */
class FakeVisualDriver implements PlaytestVisualEpisodeDriver {
  readonly dispatched: string[] = [];
  private readonly startedAt = Date.now();
  private readonly artifacts: PlaytestArtifactStore;
  private readonly target: WorkspaceVisualPlaytestTargetApproval;
  private readonly episodeId: string;
  private readonly budgetMs: number;

  constructor(
    artifacts: PlaytestArtifactStore,
    target: WorkspaceVisualPlaytestTargetApproval,
    episodeId: string,
    budgetMs: number
  ) {
    this.artifacts = artifacts;
    this.target = target;
    this.episodeId = episodeId;
    this.budgetMs = budgetMs;
  }

  remainingWallTimeMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  async observe() {
    const bytes = new Uint8Array(Buffer.from("fake-frame-bytes"));
    const written = this.artifacts.writeArtifact({
      mediaType: "image/png",
      bytes
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(written.reference.sha256, sha256);
    const observation: PlaytestVisualObservation = {
      schema: "autodev-playtest-visual-observation-v1",
      observationId: "observation-" + String(this.dispatched.length),
      workspaceId: this.target.workspaceId,
      targetId: this.target.targetId,
      episodeId: this.episodeId,
      origin: ORIGIN,
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      frame: {
        artifactId: written.reference.artifactId,
        sha256,
        bytes: bytes.byteLength,
        mediaType: "image/png"
      },
      privacyState: "clear",
      controls: [
        {
          controlId: "control-start",
          role: "button",
          name: "START",
          enabled: true,
          focused: false,
          inputKind: "none",
          bounds: { x: 100, y: 100, width: 80, height: 24 }
        }
      ],
      visibleWarnings: [],
      phaseEvidence: null,
      progressEvidence: null
    };
    return { status: "observed" as const, observation };
  }

  async act(action: { readonly kind: string }) {
    this.dispatched.push(action.kind);
    return {
      status: "dispatched" as const,
      step: this.dispatched.length - 1,
      observationId: "observation-" + String(this.dispatched.length - 1),
      actionKind: "activate-control" as const,
      dispatchedAt: new Date().toISOString(),
      driverDurationMs: 1,
      gameAcknowledgement: "not-observed" as const
    };
  }

  async close() {
    return {};
  }
}

/** A local stand-in for the model Router, so no provider is ever contacted. */
async function startFakeRouter(
  decision: unknown,
  delayMs: number
): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly requests: number[];
}> {
  const requests: number[] = [];
  const server = createServer((request, response) => {
    requests.push(Date.now());
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture-smart-model",
          usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
          output_text: JSON.stringify(decision)
        })
      );
    }, delayMs);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

const STOP_DECISION = {
  decision: "stop",
  intention: "The title screen has no further visible progress to make.",
  prediction: "Exploration ends with the title screen unchanged.",
  reasonCode: "objective-achieved",
  action: null,
  stopReason: "objective-achieved",
  focusReport: {
    objective: "Explore the visible controls.",
    inScope: ["title screen"],
    forbiddenScope: ["hidden game state"],
    stopCriteria: ["no visible progress"],
    outcome: "achieved",
    summary:
      "The visible title screen offers one control and no further progress.",
    evidenceSteps: [0]
  }
};

interface EpisodeRun {
  readonly episode: PlaytestEpisode;
  readonly driver: FakeVisualDriver;
  readonly routerRequests: number;
}

/**
 * Runs one autonomous-visual episode against the fake browser and the fake
 * router, and returns the persisted episode.
 */
async function runVisualEpisode(options: {
  readonly budgetMs: number;
  readonly decision: unknown;
  readonly routerDelayMs: number;
  readonly limits?: WorkspaceVisualPlaytestTargetApproval["limits"];
}): Promise<EpisodeRun> {
  const visualRoot = mkdtempSync(path.join(tmpdir(), "visual-budget-target-"));
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "visual-budget-artifacts-")
  );
  const router = await startFakeRouter(options.decision, options.routerDelayMs);
  const previousPort = process.env.CODEX_MODEL_ROUTER_PORT;
  process.env.CODEX_MODEL_ROUTER_PORT = String(router.port);
  const episodes: PlaytestEpisode[] = [];
  let driver: FakeVisualDriver | null = null;
  try {
    const visualTargetRepository = new WorkspaceVisualPlaytestTargetRepository(
      visualRoot
    );
    const limits = options.limits ?? targetLimits();
    visualTargetRepository.approve(approval(limits), null);
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: artifactRoot
    });
    const repository: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({ rows: [], total: 0, nextCursor: null }),
      listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getLatestDiscoveryReviewForEpisode: async () => null,
      insertDiscoveryReview: async () => {},
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      insertComparison: async () => {},
      insertBatch: async () => {},
      insertEpisode: async (episode) => {
        episodes.push(episode);
      },
      insertCrossSessionSynthesis: async () => {},
      getCrossSessionSynthesisForAnalysis: async () => null,
      listCrossSessionSyntheses: async () => ({
        rows: [],
        total: 0,
        nextCursor: null
      }),
      insertReview: async () => {},
      insertFinding: async () => {},
      getLatestReview: async () => null,
      getLatestComparison: async () => null
    };
    const openVisualDriver: PlaytestVisualDriverOpener = async (
      driverOptions
    ) => {
      driver = new FakeVisualDriver(
        driverOptions.artifacts,
        driverOptions.target,
        driverOptions.episodeId,
        options.budgetMs
      );
      return driver;
    };
    const control = createPlaytestRunControl({
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: repository,
      launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
      visualTargetRepository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      openVisualDriver
    });
    const request: PlaytestLaunchRequest = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "request-visual-budget-1",
      capabilityRevision: "a".repeat(64),
      targetId: TARGET_ID,
      policyId: "smart-direct",
      areasOfFocus: "Explore the visible controls.",
      limits
    };
    const receipt = await control.startRun(session(), request);
    await control.waitForRun(session(), WORKSPACE_ID, receipt.batchId, 20_000);
    assert.ok(episodes.length >= 1);
    assert.ok(driver);
    const episode = episodes[episodes.length - 1];
    assert.ok(episode);
    return {
      // Every revision of the one episode is persisted; the last one is final.
      episode,
      driver,
      routerRequests: router.requests.length
    };
  } finally {
    if (previousPort === undefined) delete process.env.CODEX_MODEL_ROUTER_PORT;
    else process.env.CODEX_MODEL_ROUTER_PORT = previousPort;
    await router.close();
    rmSync(visualRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

test("a visual episode stops at the approved wall-time budget instead of failing", async () => {
  const run = await runVisualEpisode({
    // The approved budget is already spent when the decision is due.
    budgetMs: 0,
    decision: STOP_DECISION,
    routerDelayMs: 0
  });
  assert.equal(
    run.routerRequests,
    0,
    "a decision must not be sent once the approved wall-time budget is spent"
  );
  assert.equal(run.episode.status, "budget-truncated");
  assert.deepEqual(run.episode.termination, {
    reason: "step-limit",
    step: 0
  });
  assert.deepEqual(run.episode.completionCounts.budgetTruncated, 1);
  assert.deepEqual(run.episode.completionCounts.infrastructureFailed, 0);
});

test("a decision is bounded by the approved wall-time budget, not by a shorter cap", async () => {
  const run = await runVisualEpisode({
    // The approved budget has to survive the work the episode does before the
    // decision is due -- reading the observation and storing the frame -- or
    // the decision is refused before it is ever sent, and the test would be
    // measuring how fast the host is rather than how the deadline is cut. It
    // stays well below the model's answer, so a decision that is not cut is
    // still distinguishable from one that is.
    budgetMs: 1500,
    decision: STOP_DECISION,
    // The model answers long after the approved budget is gone.
    routerDelayMs: 5000
  });
  assert.equal(run.routerRequests, 1);
  assert.equal(run.episode.status, "budget-truncated");
  assert.deepEqual(run.episode.completionCounts.budgetTruncated, 1);
  assert.deepEqual(run.episode.completionCounts.infrastructureFailed, 0);
  assert.ok(
    (run.episode.simulationWallMs ?? 0) < 3000,
    `the decision must be cut at the approved budget, not later (wall ${String(run.episode.simulationWallMs)} ms)`
  );
});

test("a visual episode completes when the model answers inside the budget", async () => {
  const run = await runVisualEpisode({
    budgetMs: 20_000,
    decision: STOP_DECISION,
    routerDelayMs: 0
  });
  assert.equal(run.routerRequests, 1);
  assert.equal(run.episode.status, "completed");
  assert.deepEqual(run.episode.completionCounts.completed, 1);
  assert.deepEqual(run.episode.completionCounts.infrastructureFailed, 0);
});

test("a visual episode records the usage budget, not the step cap, when the policy's budget runs out", async () => {
  const run = await runVisualEpisode({
    budgetMs: 20_000,
    decision: STOP_DECISION,
    routerDelayMs: 0,
    // The model answers with 340 tokens and the approved per-episode token
    // budget is smaller, so the decision is refused once the response is read.
    limits: targetLimits({ smartTokensPerEpisode: 300 })
  });
  assert.equal(run.routerRequests, 1);
  assert.equal(run.episode.status, "budget-truncated");
  assert.deepEqual(
    run.episode.termination,
    { reason: "usage-budget", step: 0 },
    "the episode never reached the step cap, so the recorded reason must not claim that it did"
  );
  assert.deepEqual(run.episode.missingReasons, ["budget-truncated"]);
  assert.deepEqual(run.episode.completionCounts.budgetTruncated, 1);
  assert.deepEqual(run.episode.completionCounts.infrastructureFailed, 0);
});
