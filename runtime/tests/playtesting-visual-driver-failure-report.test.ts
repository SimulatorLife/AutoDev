/**
 * A visual episode that could not start has to say why.
 *
 * The driver failed before the episode produced any evidence, so the episode
 * record only says "infrastructure-failed" and the batch says it was
 * recovered. Without a report of the failure, every playtest that could not
 * run looks the same: a browser that would not start, a game that could not
 * be reached and a Runtime that was too busy to answer are indistinguishable
 * from the outside.
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
  type PlaytestMcpSession} from "../src/playtesting/mcp.ts";
import {
  PlaytestVisualBrowserDriverError,
  type PlaytestVisualDriverOpener
} from "../src/playtesting/visual-browser-driver.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./support/playtesting-launch-intents.ts";

const WORKSPACE_ID = "fixture/visual-driver-failure";
const TARGET_ID = "racing-game-local";
const ORIGIN = "http://127.0.0.1:5173";

function approval(): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: TARGET_ID,
    revision: 1,
    approvalId: "visual-approval-driver-failure-1",
    name: "Visual driver failure fixture",
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
      wallTimeMs: 5000,
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

test("a visual episode that could not start reports why", async () => {
  const visualRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-driver-failure-"))
  );
  const artifactRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-driver-failure-artifacts-"))
  );
  const episodes: PlaytestEpisode[] = [];
  const reported: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    reported.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const visualTargetRepository = new WorkspaceVisualPlaytestTargetRepository(
      visualRoot
    );
    visualTargetRepository.approve(approval(), null);
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: artifactRoot
    });
    const openVisualDriver: PlaytestVisualDriverOpener = async () => {
      throw new PlaytestVisualBrowserDriverError(
        "browser-open-timeout",
        "The approved episode budget was spent before the visual browser opened."
      );
    };
    const control = createPlaytestRunControl({
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: inMemoryRepository(episodes),
      launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
      visualTargetRepository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      openVisualDriver
    });
    const request: PlaytestLaunchRequest = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "request-visual-driver-failure-1",
      capabilityRevision: "a".repeat(64),
      targetId: TARGET_ID,
      policyId: "smart-direct",
      areasOfFocus: "Explore the visible controls.",
      limits: approval().limits
    };
    const receipt = await control.startRun(session(), request);
    await control.waitForRun(session(), WORKSPACE_ID, receipt.batchId, 20_000);

    assert.ok(episodes.length > 0);
    const episode = episodes.at(-1);
    assert.ok(episode);
    assert.equal(episode.status, "infrastructure-failed");

    const events = reported
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "visual_driver_open_failed");
    assert.equal(
      events.length,
      1,
      "the failed open must be reported exactly once"
    );
    const event = events[0]!;
    assert.equal(event.schema, "autodev-playtest-runtime-event-v1");
    assert.equal(event.batchId, receipt.batchId);
    assert.equal(event.episodeId, episode.episodeId);
    assert.equal(
      event.failureCode,
      "visual-driver:browser-open-timeout",
      "the report must carry the same typed tag the episode uses"
    );
  } finally {
    process.stderr.write = originalWrite;
    rmSync(visualRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
