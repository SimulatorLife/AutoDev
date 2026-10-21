/**
 * A visual episode that runs out of an approved budget is a truncation.
 *
 * The request count, the token budget and the per-response usage are approved
 * ceilings. An episode that reaches one of them was cut short by its
 * approval, not lost to a runtime failure, and the two must not be reported
 * the same way: the first is a truncation the operator can read in the
 * episode, the second is infrastructure loss.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestEpisode,
  type PlaytestLaunchRequest,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";
import { WorkspaceVisualPlaytestTargetRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpSession
} from "../src/playtesting/mcp.ts";
import { SmartDirectPolicyError } from "../src/playtesting/smart-direct-policy.ts";
import { type PlaytestVisualDriverOpener } from "../src/playtesting/visual-browser-driver.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./support/playtesting-launch-intents.ts";

const WORKSPACE_ID = "fixture/visual-budget-exhaustion";
const TARGET_ID = "racing-game-local";
const ORIGIN = "http://127.0.0.1:5173";

function approval(): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: TARGET_ID,
    revision: 1,
    approvalId: "visual-approval-budget-exhaustion-1",
    name: "Visual budget exhaustion fixture",
    entryUrl: ORIGIN + "/",
    allowedOrigins: [ORIGIN],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 3,
      wallTimeMs: 30_000,
      smartRequestsPerEpisode: 5,
      smartTokensPerEpisode: 20_000,
      screenshotCountPerEpisode: 10,
      artifactBytesPerEpisode: 1_073_741_824
    },
    approvedAt: "2026-10-20T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
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

function inMemoryRepository(
  episodes: PlaytestEpisode[]
): PlaytestingRepositoryOps {
  return {
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
    getLatestReview: async () => null,
    getLatestComparison: async () => null,
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
    insertFinding: async () => {}
  };
}

/** A driver that observes a playable page and never leaves the approved origin. */
function observedDriver(
  artifacts: PlaytestArtifactStore
): PlaytestVisualDriverOpener {
  return async () => {
    const frame = artifacts.writeArtifact({
      mediaType: "image/png",
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    }).reference;
    return {
      entryLoaded: true,
      async observe() {
        return {
          status: "observed" as const,
          observation: {
            capturedAt: "2026-10-21T00:00:00.000Z",
            viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
            privacyState: "clear" as const,
            controls: [
              {
                controlId: "c-0",
                name: "Race",
                role: "button" as const,
                enabled: true,
                evidence: "visible"
              }
            ],
            visibleWarnings: [],
            phaseEvidence: null,
            progressEvidence: null,
            frame
          }
        };
      },
      async act() {
        return { status: "dispatched" as const, controlId: "c-0" };
      },
      async close() {
        return undefined;
      },
      remainingWallTimeMs: () => 30_000
    } as unknown as Awaited<ReturnType<PlaytestVisualDriverOpener>>;
  };
}

test("a visual episode that exhausts an approved budget is truncated, not a runtime failure", async () => {
  const visualRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-budget-exhaustion-"))
  );
  const artifactRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-budget-exhaustion-artifacts-"))
  );
  const episodes: PlaytestEpisode[] = [];
  try {
    const visualTargetRepository = new WorkspaceVisualPlaytestTargetRepository(
      visualRoot
    );
    visualTargetRepository.approve(approval(), null);
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: artifactRoot
    });
    const control = createPlaytestRunControl({
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: inMemoryRepository(episodes),
      launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
      visualTargetRepository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      openVisualDriver: observedDriver(artifacts),
      createVisualPolicy: () => ({
        async decide() {
          throw new SmartDirectPolicyError(
            "response-usage-exceeds-budget",
            "Smart-direct response usage exceeded the approved token budget; the action was not dispatched."
          );
        },
        usage: () => ({
          requestsAttempted: 1,
          decisionsReturned: 0,
          tokensUsed: 21_000,
          tokenUsageComplete: true,
          lastLatencyMs: 10
        })
      })
    });
    const request: PlaytestLaunchRequest = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "request-visual-budget-exhaustion-1",
      capabilityRevision: "b".repeat(64),
      targetId: TARGET_ID,
      policyId: "smart-direct",
      areasOfFocus: "Explore the visible controls.",
      limits: approval().limits
    };
    const receipt = await control.startRun(session(), request);
    await control.waitForRun(session(), WORKSPACE_ID, receipt.batchId, 20_000);

    const terminal = episodes.at(-1);
    assert.ok(terminal, "the episode must be persisted");
    assert.equal(
      terminal.status,
      "budget-truncated",
      "an exhausted approved budget is a truncation, not infrastructure loss"
    );
    assert.deepEqual(terminal.missingReasons, ["budget-truncated"]);
    assert.equal(terminal.termination?.reason, "step-limit");
  } finally {
    rmSync(visualRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
