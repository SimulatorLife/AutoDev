import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type PlaytestArtifactReference,
  playtestAssignmentManifestHashInput,
  type PlaytestBatch,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_REVIEW_SELECTION_SCHEMA,
  PLAYTESTS_REVIEW_STRATIFICATION
} from "@simulatorlife/autodev-core";
import {
  type PlaytestBatchArtifactState,
  PlaytestRepository
} from "@simulatorlife/autodev-data/playtesting";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  PLAYTEST_PACKET_PENDING_GRACE_MS,
  reconcilePendingPlaytestPackets
} from "../src/playtesting/packet-artifact-reconciliation.ts";

function createArtifacts(now: () => number): {
  readonly root: string;
  readonly store: PlaytestArtifactStore;
  readonly cleanup: () => void;
} {
  const rawRoot = mkdtempSync(path.join(tmpdir(), "packet-reconcile-"));
  const root = realpathSync(rawRoot);
  return {
    root,
    store: new PlaytestArtifactStore({
      workspaceId: "owner/game",
      rootDirectory: root,
      now,
      retentionMs: PLAYTEST_PACKET_PENDING_GRACE_MS * 8
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function writePendingPacket(
  store: PlaytestArtifactStore,
  packetId: string,
  batchId: string,
  content: string
): PlaytestArtifactReference {
  return store.writeArtifact({
    artifactId: packetId,
    mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
    bytes: new TextEncoder().encode(content),
    pendingCommitId: batchId
  }).reference;
}

function repositoryWith(
  states: ReadonlyMap<string, PlaytestBatchArtifactState>,
  beforeRead?: (batchId: string) => void
) {
  return {
    async getBatchArtifactState(_workspaceId: string, batchId: string) {
      beforeRead?.(batchId);
      const state = states.get(batchId);
      if (!state) throw new Error("synthetic Data outage");
      return state;
    }
  };
}

function batchArtifact(input: {
  readonly batchId: string;
  readonly status: "running" | "completed" | "failed";
  readonly packet?: PlaytestArtifactReference;
  readonly revision?: number;
}): PlaytestBatch {
  const generatedAt = "2026-10-12T00:00:00.000Z";
  const manifestDraft = {
    schema: PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
    batchId: input.batchId,
    workspaceId: "owner/game",
    buildSha: "a".repeat(40),
    configHash: "b".repeat(64),
    rubricHash: "c".repeat(64),
    approvalRevision: 1,
    createdAt: generatedAt,
    assignments: [
      {
        assignmentId: "a-0001",
        scenarioId: "tutorial",
        scenarioFamily: "tutorial",
        policyId: "heuristic",
        policyVersion: "1",
        cohort: "novice",
        seed: "seed-1",
        maxSteps: 20
      }
    ]
  } as const;
  const manifest = {
    ...manifestDraft,
    contentHash: createHash("sha256")
      .update(playtestAssignmentManifestHashInput(manifestDraft))
      .digest("hex")
  };
  const selected = input.packet !== undefined;
  const failed = input.status === "failed";
  const selectedReview = {
    schema: PLAYTESTS_REVIEW_SELECTION_SCHEMA,
    status: "selected" as const,
    inventoryHash: manifest.contentHash,
    seed: "review-seed",
    stratification: PLAYTESTS_REVIEW_STRATIFICATION,
    maxReviewedSessions: 1,
    critiqueBudget: 1,
    reviewCap: 1,
    reviewablePopulation: 1,
    unreviewableAssignments: 0,
    surveillance: { status: "disabled" as const, budget: 0 as const },
    discovery: { status: "disabled" as const, budget: 0 as const },
    selected: [
      {
        assignmentId: "a-0001",
        episodeId: "episode-1",
        stream: "surveillance" as const,
        stratumKey: "heuristic/tutorial/win",
        inclusionProbability: null,
        discoveryRank: null,
        signalValue: null
      }
    ],
    selectedAt: generatedAt
  };
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: input.batchId,
    revision: input.revision ?? 1,
    workspaceId: "owner/game",
    repository: "owner/game",
    buildSha: "a".repeat(40),
    gameBuild: "fixture-build",
    configHash: "b".repeat(64),
    rubricHash: "c".repeat(64),
    actionSchemaHash: "d".repeat(64),
    observationSchemaHash: "e".repeat(64),
    eventSchemaHash: "f".repeat(64),
    measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
    protocolVersion: 1,
    policyIds: ["heuristic"],
    cohortIds: ["novice"],
    scenarioIds: ["tutorial"],
    assignmentInventory: { status: "frozen", manifest },
    coverageManifest: null,
    unobservedAssignments: failed
      ? [
          {
            assignmentId: "a-0001",
            episodeId: null,
            state: "infrastructure-failed",
            started: false,
            eligible: false
          }
        ]
      : [],
    reviewSelection: selected
      ? selectedReview
      : input.status === "running"
        ? { status: "pending" }
        : { status: "unavailable", reason: "batch-incomplete" },
    reviewPackets:
      input.packet === undefined
        ? []
        : [
            {
              status: "prepared",
              packetId: "packet-integration-1",
              assignmentId: "a-0001",
              episodeId: "episode-1",
              artifact: input.packet,
              failureReason: null,
              createdAt: generatedAt
            }
          ],
    reviewReceipts: [],
    status: input.status,
    cancellationReason: null,
    failureReason: null,
    counts: {
      assigned: 1,
      started: input.status === "completed" ? 1 : 0,
      completed: input.status === "completed" ? 1 : 0,
      crashed: 0,
      infrastructureFailed: failed ? 1 : 0,
      cancelled: 0,
      budgetTruncated: 0,
      reviewed: 0,
      eligible: input.status === "completed" ? 1 : 0
    },
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      critiqueBudget: 1,
      actualCritiques: 0
    },
    startedAt: input.status === "completed" ? generatedAt : null,
    completedAt: input.status === "completed" ? generatedAt : null,
    createdAt: generatedAt,
    provenance: {
      workspaceId: "owner/game",
      buildSha: "a".repeat(40),
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      generatedAt
    },
    evaluationIds: [],
    spanIds: []
  };
}

function clickHouseForBatches() {
  const rows: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query") ?? "";
    if (query.startsWith("INSERT INTO playtest_batches")) {
      for (const line of String(init?.body ?? "")
        .split("\n")
        .filter(Boolean)) {
        rows.push(JSON.parse(line) as Record<string, unknown>);
      }
      return new Response("", { status: 200 });
    }
    if (query.includes("FROM playtest_batches")) {
      const workspaceId = url.searchParams.get("param_workspaceId");
      const batchId = url.searchParams.get("param_batchId");
      const matching = rows
        .filter(
          (row) => row.workspace_id === workspaceId && row.batch_id === batchId
        )
        .sort((left, right) => Number(right.revision) - Number(left.revision));
      return new Response(
        matching.map((row) => JSON.stringify(row)).join("\n"),
        {
          status: 200
        }
      );
    }
    return new Response("unexpected query", { status: 500 });
  };
  return new PlaytestRepository({ fetchImpl });
}

test("cross-store packet recovery composes the real Data repository with Runtime artifacts", async () => {
  let now = 500_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const repository = clickHouseForBatches();
    const durablePacket = writePendingPacket(
      store,
      "packet-integration-artifact",
      "batch-history",
      "durable"
    );
    await repository.insertBatch(
      batchArtifact({
        batchId: "batch-history",
        status: "completed",
        revision: 2,
        packet: durablePacket
      })
    );
    await repository.insertBatch(
      batchArtifact({
        batchId: "batch-history",
        status: "failed",
        revision: 3
      })
    );

    const orphanPacket = writePendingPacket(
      store,
      "packet-integration-orphan",
      "batch-orphan",
      "orphan"
    );
    await repository.insertBatch(
      batchArtifact({ batchId: "batch-orphan", status: "failed" })
    );
    now += PLAYTEST_PACKET_PENDING_GRACE_MS + 1;

    const result = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository,
      now
    });
    assert.equal(result.status, "complete");
    assert.equal(result.committed, 1);
    assert.equal(result.removed, 1);
    assert.equal(
      store.referenceForId(durablePacket.artifactId)?.sha256,
      durablePacket.sha256
    );
    assert.equal(store.referenceForId(orphanPacket.artifactId), null);
    assert.deepEqual(
      store.listPendingArtifacts({
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
        limit: 10
      }).entries,
      []
    );
  } finally {
    cleanup();
  }
});

test("reconciliation commits referenced packets and removes terminal unreferenced packets", async () => {
  let now = 100_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const committed = writePendingPacket(
      store,
      "packet-committed",
      "batch-1",
      "one"
    );
    now += 1;
    const orphan = writePendingPacket(store, "packet-orphan", "batch-2", "two");
    now += PLAYTEST_PACKET_PENDING_GRACE_MS + 1;

    const result = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository: repositoryWith(
        new Map([
          [
            "batch-1",
            { latestStatus: "completed", packetArtifacts: [committed] }
          ],
          ["batch-2", { latestStatus: "failed", packetArtifacts: [] }]
        ])
      ),
      now
    });

    assert.deepEqual(result, {
      status: "complete",
      candidates: 2,
      committed: 1,
      removed: 1,
      retained: 0,
      truncated: false
    });
    assert.equal(
      store.listPendingArtifacts({
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
        limit: 10
      }).entries.length,
      0
    );
    assert.equal(
      store.referenceForId(committed.artifactId)?.sha256,
      committed.sha256
    );
    assert.equal(store.referenceForId(orphan.artifactId), null);
  } finally {
    cleanup();
  }
});

test("reconciliation preserves active-batch packets and young pending writes", async () => {
  let now = 200_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const active = writePendingPacket(
      store,
      "packet-active",
      "batch-active",
      "active"
    );
    now += PLAYTEST_PACKET_PENDING_GRACE_MS + 1;
    const young = writePendingPacket(
      store,
      "packet-young",
      "batch-young",
      "young"
    );
    let queried = 0;
    const repository = repositoryWith(
      new Map([
        ["batch-active", { latestStatus: "running", packetArtifacts: [] }]
      ]),
      () => {
        queried += 1;
      }
    );

    const result = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository,
      now
    });
    assert.equal(result.status, "deferred");
    assert.equal(result.retained, 2);
    assert.equal(result.removed, 0);
    assert.equal(queried, 1);
    assert.equal(
      store.referenceForId(active.artifactId)?.sha256,
      active.sha256
    );
    assert.equal(store.referenceForId(young.artifactId)?.sha256, young.sha256);
  } finally {
    cleanup();
  }
});

test("reconciliation fails closed on Data outages and conflicting artifact identity", async () => {
  let now = 300_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const pending = writePendingPacket(
      store,
      "packet-conflict",
      "batch-conflict",
      "value"
    );
    now += PLAYTEST_PACKET_PENDING_GRACE_MS + 1;
    const unavailable = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository: repositoryWith(new Map()),
      now
    });
    assert.equal(unavailable.status, "deferred");
    assert.equal(unavailable.retained, 1);
    assert.equal(
      store.referenceForId(pending.artifactId)?.sha256,
      pending.sha256
    );

    const conflictingReference = {
      ...pending,
      sha256: "a".repeat(64)
    };
    const conflict = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository: repositoryWith(
        new Map([
          [
            "batch-conflict",
            {
              latestStatus: "failed",
              packetArtifacts: [conflictingReference]
            }
          ]
        ])
      ),
      now
    });
    assert.equal(conflict.status, "deferred");
    assert.equal(conflict.retained, 1);
    assert.equal(
      store.referenceForId(pending.artifactId)?.sha256,
      pending.sha256
    );
  } finally {
    cleanup();
  }
});

test("expired pending packets are reclaimed by the artifact retention policy", async () => {
  let now = 400_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const pending = writePendingPacket(
      store,
      "packet-expired",
      "batch-expired",
      "expired"
    );
    now += PLAYTEST_PACKET_PENDING_GRACE_MS * 8 + 1;
    let queried = false;
    const result = await reconcilePendingPlaytestPackets({
      workspaceId: "owner/game",
      artifacts: store,
      repository: {
        async getBatchArtifactState() {
          queried = true;
          throw new Error("Expired metadata must not require Data.");
        }
      },
      now
    });
    assert.equal(result.status, "complete");
    assert.equal(result.removed, 1);
    assert.equal(queried, false);
    assert.equal(store.state(pending), "not-authorized");
  } finally {
    cleanup();
  }
});

test("reconciliation fails closed on a cross-workspace reference", async () => {
  let now = 400_000;
  const { store, cleanup } = createArtifacts(() => now);
  try {
    const pending = writePendingPacket(
      store,
      "packet-scope",
      "batch-scope",
      "scoped"
    );
    now += PLAYTEST_PACKET_PENDING_GRACE_MS + 1;
    const result = await reconcilePendingPlaytestPackets({
      workspaceId: "other/game",
      artifacts: store,
      repository: repositoryWith(new Map()),
      now
    });
    assert.equal(result.status, "deferred");
    assert.equal(
      store.referenceForId(pending.artifactId)?.sha256,
      pending.sha256
    );
  } finally {
    cleanup();
  }
});
