import assert from "node:assert/strict";
import test from "node:test";

import type { PlaytestBatch, PlaytestEpisode } from "@simulatorlife/autodev-core";

import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestMcpOptions,
  type PlaytestingRepositoryOps
} from "../src/playtesting/mcp.ts";

const WORKSPACE_ID = "owner/game";

/**
 * These tests pin the cross-session dispatch contract rather than packet
 * construction: an operator names a selection, and every named session comes
 * back either as a packet or as a named receipt. The one failure a review
 * cannot detect is a session that vanishes, because the analyst then reasons
 * over "several sessions" while holding evidence from one.
 */

function episode(
  episodeId: string,
  batchId: string,
  status: PlaytestEpisode["status"]
): PlaytestEpisode {
  return {
    schema: "autodev-playtest-episode-v1",
    episodeId,
    revision: 1,
    batchId,
    assignmentId: `assignment-${episodeId}`,
    branchLineage: null,
    identity: {
      workspaceId: WORKSPACE_ID,
      gameId: "fixture-game",
      buildSha: "a".repeat(40),
      mechanicKey: "tutorial",
      scenarioId: "tutorial",
      policyId: "random"
    },
    scenarioFamily: "onboarding",
    policyCohort: "baseline",
    strategy: "random",
    status,
    outcome: "loss",
    outcomeMetrics: {},
    completionCounts: {
      steps: 10,
      wins: 0,
      losses: 1,
      drawFull: 0,
      endByTimeLimit: 0,
      endByAgentQuotas: 0
    },
    replayStatus: { status: "available" },
    trace: null,
    frames: [],
    stepCount: 10,
    metrics: [],
    findingIds: [],
    assignedAt: "2026-10-12T00:00:00.000Z",
    startedAt: "2026-10-12T00:00:01.000Z",
    completedAt: "2026-10-12T00:00:10.000Z",
    simulationWallMs: 9000,
    logicalTicks: 10,
    policyInferenceMs: null,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  } as unknown as PlaytestEpisode;
}

/**
 * `selectedEpisodeIds` is the batch's frozen bounded review selection. It is a
 * separate argument so a test can set the cap or budget without accidentally
 * rewriting the selection it is trying to exercise.
 */
function batch(
  batchId: string,
  overrides: Partial<PlaytestBatch> = {},
  selectedEpisodeIds: readonly string[] = []
): PlaytestBatch {
  const { reviewSelection: selectionOverride, ...rest } = overrides;
  const cap =
    (selectionOverride as { reviewCap?: number } | undefined)?.reviewCap ?? 4;
  return {
    schema: "autodev-playtest-batch-v1",
    batchId,
    revision: 1,
    workspaceId: WORKSPACE_ID,
    buildSha: "a".repeat(40),
    gameBuild: "fixture-build-1",
    status: "completed",
    assignmentInventory: { status: "frozen" },
    coverageManifest: { contentHash: "d".repeat(64) },
    reviewReceipts: [],
    budget: {
      assignedEpisodes: 0,
      maxStepsPerEpisode: 100,
      wallTimeMs: 1_000_000,
      critiqueBudget: 4,
      actualCritiques: 0
    },
    startedAt: "2026-10-12T00:00:00.000Z",
    finishedAt: "2026-10-12T00:05:00.000Z",
    ...rest,
    reviewSelection: {
      status: "selected",
      reviewCap: cap,
      selected: selectedEpisodeIds.map((episodeId) => ({
        assignmentId: `assignment-${episodeId}`,
        episodeId
      }))
    }
  } as unknown as PlaytestBatch;
}

function serverFor(
  episodes: readonly PlaytestEpisode[],
  batches: readonly PlaytestBatch[]
): ReturnType<typeof createPlaytestMcpServer> {
  const playtestRepository = {
    getEpisode: async (_workspaceId: string, episodeId: string) =>
      episodes.find((entry) => entry.episodeId === episodeId) ?? null,
    getBatch: async (_workspaceId: string, batchId: string) =>
      batches.find((entry) => entry.batchId === batchId) ?? null
  } as unknown as PlaytestingRepositoryOps;
  // The real owner, not a stub: the MCP tool and the Control API both route
  // through it, so a stub would let the dispatch rules drift untested.
  const runControl = createPlaytestRunControl({
    playtestRepository,
    artifactStoreForWorkspace: () => {
      throw new Error("no artifacts");
    }
  });
  return createPlaytestMcpServer({
    sessionProvider: {
      current: () => ({
        workspaceId: WORKSPACE_ID,
        role: "playtest-analyst",
        actor: "analyst-1"
      })
    },
    artifactStoreForWorkspace: () => {
      throw new Error("no artifacts");
    },
    playtestRepository,
    playtestRunControl: runControl
  } as unknown as PlaytestMcpOptions);
}

async function dispatch(
  server: ReturnType<typeof createPlaytestMcpServer>,
  episodeIds: readonly string[]
): Promise<{
  requested: number;
  packets: readonly { episodeId: string }[];
  receipts: readonly {
    episodeId: string;
    batchId: string | null;
    reason: string;
    detail: string;
  }[];
  budget: readonly {
    batchId: string;
    reviewCap: number;
    remaining: number;
    requested: number;
  }[];
}> {
  const result = await (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools["playtest.prepareCrossSessionReview"]!.handler({
    episodeIds
  });
  const response = result as {
    isError?: boolean;
    content: readonly { text: string }[];
  };
  assert.equal(response.isError, undefined, response.content[0]?.text);
  return JSON.parse(response.content[0]!.text);
}

test("every selected session is returned as a packet or a named receipt", async () => {
  const server = serverFor(
    [
      episode("episode-complete", "batch-1", "completed"),
      episode("episode-crashed", "batch-1", "crashed"),
      episode("episode-infra", "batch-1", "infrastructure-failed"),
      episode("episode-cancelled", "batch-1", "cancelled"),
      episode("episode-truncated", "batch-1", "budget-truncated"),
      episode("episode-partial", "batch-1", "started")
    ],
    [batch("batch-1", {}, [
      "episode-complete",
      "episode-crashed",
      "episode-infra",
      "episode-cancelled",
      "episode-truncated",
      "episode-partial"
    ])]
  );
  const requested = [
    "episode-complete",
    "episode-crashed",
    "episode-infra",
    "episode-cancelled",
    "episode-truncated",
    "episode-partial",
    "episode-unknown"
  ];
  const result = await dispatch(server, requested);
  const accounted = [
    ...result.packets.map((packet) => packet.episodeId),
    ...result.receipts.map((receipt) => receipt.episodeId)
  ];
  // The invariant: nothing silently disappears.
  assert.deepEqual([...new Set(accounted)].sort(), [...requested].sort());
  const byId = new Map(
    result.receipts.map((receipt) => [receipt.episodeId, receipt])
  );
  assert.equal(byId.get("episode-crashed")?.reason, "excluded-ineligible-session");
  assert.match(byId.get("episode-crashed")?.detail ?? "", /crashed/u);
  assert.match(
    byId.get("episode-infra")?.detail ?? "",
    /infrastructure loss/u
  );
  assert.match(byId.get("episode-cancelled")?.detail ?? "", /cancelled/u);
  assert.match(byId.get("episode-truncated")?.detail ?? "", /truncated/u);
  assert.match(byId.get("episode-partial")?.detail ?? "", /partial/u);
  assert.equal(byId.get("episode-unknown")?.reason, "unknown-session");
  // The one eligible session is named too: its packet could not be read here,
  // and that is reported rather than presented as analysed.
  assert.equal(
    byId.get("episode-complete")?.reason,
    "packet-unavailable"
  );
  assert.equal(result.packets.length, 0);
});

test("the per-batch critique cap is enforced across the whole selection", async () => {
  const server = serverFor(
    Array.from({ length: 5 }, (_, index) =>
      episode(`episode-${String(index)}`, "batch-1", "completed")
    ),
    // Only two critiques remain, so a five-session selection cannot fit.
    [
      batch(
        "batch-1",
        {
          budget: {
            assignedEpisodes: 5,
            maxStepsPerEpisode: 100,
            wallTimeMs: 1_000_000,
            critiqueBudget: 4,
            actualCritiques: 1
          },
          reviewReceipts: [
            { reviewId: "review-reserved-1", status: "reserved" }
          ] as unknown as PlaytestBatch["reviewReceipts"]
        },
        Array.from({ length: 5 }, (_, index) => `episode-${String(index)}`)
      )
    ]
  );
  const result = await dispatch(
    server,
    Array.from({ length: 5 }, (_, index) => `episode-${String(index)}`)
  );
  const budget = result.budget.find((entry) => entry.batchId === "batch-1");
  assert.equal(budget?.reviewCap, 4);
  assert.equal(budget?.requested, 5);
  assert.equal(budget?.remaining, 2);
  // Three sessions cannot be analysed within the cap; they are named, not
  // silently analysed unbudgeted.
  const exhausted = result.receipts.filter(
    (receipt) => receipt.reason === "critique-budget-exhausted"
  );
  assert.equal(exhausted.length, 3);
  assert.equal(
    [...result.packets, ...result.receipts].length,
    5,
    "the cap excludes sessions by naming them, never by dropping them"
  );
});

test("an ineligible session is not charged against the critique budget", async () => {
  const server = serverFor(
    [
      episode("episode-crashed", "batch-1", "crashed"),
      episode("episode-complete", "batch-1", "completed")
    ],
    [
      // Only one critique slot remains for the whole selection.
      batch(
        "batch-1",
        { reviewSelection: { reviewCap: 1 } as unknown as PlaytestBatch["reviewSelection"] },
        ["episode-crashed", "episode-complete"]
      )
    ]
  );
  const result = await dispatch(server, [
    "episode-crashed",
    "episode-complete"
  ]);
  const budget = result.budget.find((entry) => entry.batchId === "batch-1");
  assert.equal(budget?.requested, 1);
  assert.equal(budget?.remaining, 1);
  // The one eligible session still gets the slot the crashed one never used.
  const exhausted = result.receipts.filter(
    (receipt) => receipt.reason === "critique-budget-exhausted"
  );
  assert.equal(exhausted.length, 0);
});

test("a batch that is not completed excludes its sessions", async () => {
  const server = serverFor(
    [episode("episode-x", "batch-running", "completed")],
    [batch("batch-running", { status: "running" })]
  );
  const result = await dispatch(server, ["episode-x"]);
  assert.equal(result.packets.length, 0);
  assert.equal(result.receipts[0]?.reason, "excluded-ineligible-session");
  assert.match(result.receipts[0]?.detail ?? "", /running, not completed/u);
});

test("a selection is bounded and rejects duplicates as one selection", async () => {
  const server = serverFor(
    [episode("episode-a", "batch-1", "completed")],
    [batch("batch-1", {}, ["episode-a"])]
  );
  // A duplicate names one session, so it must not be charged twice.
  const result = await dispatch(server, ["episode-a", "episode-a"]);
  assert.equal(result.packets.length + result.receipts.length, 1);

  const tooMany = await (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools["playtest.prepareCrossSessionReview"]!.handler({
    episodeIds: Array.from({ length: 17 }, (_, index) => `episode-${String(index)}`)
  });
  const response = tooMany as { isError?: boolean; content: { text: string }[] };
  // The bound is enforced by the input schema, before any workspace read.
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text, /playtest_invalid_request/u);
});

test("the analyst role is required for cross-session dispatch", async () => {
  const playtestRepository = {
    getEpisode: async () => null,
    getBatch: async () => null
  } as unknown as PlaytestingRepositoryOps;
  const runControl = createPlaytestRunControl({
    playtestRepository,
    artifactStoreForWorkspace: () => {
      throw new Error("no artifacts");
    }
  });
  const server = createPlaytestMcpServer({
    sessionProvider: {
      current: () => ({
        workspaceId: WORKSPACE_ID,
        role: "playtest-tester",
        actor: "tester-1"
      })
    },
    artifactStoreForWorkspace: () => {
      throw new Error("no artifacts");
    },
    playtestRepository,
    playtestRunControl: runControl
  } as unknown as PlaytestMcpOptions);
  const result = await (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools["playtest.prepareCrossSessionReview"]!.handler({
    episodeIds: ["episode-a"]
  });
  const response = result as { isError?: boolean; content: { text: string }[] };
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text, /playtest_forbidden/u);
});