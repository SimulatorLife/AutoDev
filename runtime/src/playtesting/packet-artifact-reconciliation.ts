/**
 * Reconcile Runtime-owned packet artifacts with durable Data batch receipts.
 *
 * The filesystem and ClickHouse do not share a transaction. Packet references
 * remain pending until the terminal batch revision commits; this reconciler
 * finalizes committed markers or removes old, unreferenced packets. A live
 * batch or an unavailable/corrupt Data read always preserves the artifact.
 */
import {
  type PlaytestArtifactReference,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
} from "@simulatorlife/autodev-core";
import type { PlaytestBatchArtifactState } from "@simulatorlife/autodev-data/playtesting";

import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import type { PlaytestArtifactStore } from "./artifact-store.ts";

/** Approved playtest runs are capped at one hour; grace covers final persistence. */
export const PLAYTEST_PACKET_PENDING_GRACE_MS = 2 * 60 * 60 * 1000;
export const PLAYTEST_PACKET_PENDING_SCAN_LIMIT = 10_000;
export const PLAYTEST_PACKET_PENDING_BATCH_LIMIT = 64;
const PACKET_STATE_READ_CONCURRENCY = 4;

export interface PlaytestPacketArtifactRepository {
  getBatchArtifactState(
    workspaceId: string,
    batchId: string
  ): Promise<PlaytestBatchArtifactState>;
}

export interface PlaytestPacketArtifactReconciliationResult {
  readonly status: "complete" | "deferred";
  readonly candidates: number;
  readonly committed: number;
  readonly removed: number;
  readonly retained: number;
  readonly truncated: boolean;
}

type PendingPacket = ReturnType<
  PlaytestArtifactStore["listPendingArtifacts"]
>["entries"][number];

interface BatchCandidates {
  readonly batchId: string;
  readonly packets: readonly PendingPacket[];
}

function groupByBatch(
  packets: readonly PendingPacket[]
): readonly BatchCandidates[] {
  const grouped = new Map<string, PendingPacket[]>();
  for (const packet of packets) {
    const entries = grouped.get(packet.pendingCommitId);
    if (entries) entries.push(packet);
    else grouped.set(packet.pendingCommitId, [packet]);
  }
  return Array.from(grouped, ([batchId, entries]) => ({
    batchId,
    packets: entries
  }));
}

function sameArtifact(
  left: PlaytestArtifactReference,
  right: PlaytestArtifactReference
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.mediaType === right.mediaType
  );
}

interface ReconciledPacketCounts {
  readonly committed: number;
  readonly removed: number;
  readonly retained: number;
}

function reclaimExpiredPackets(input: {
  readonly entries: readonly PendingPacket[];
  readonly artifacts: PlaytestArtifactStore;
  readonly now: number;
}): { readonly removed: number; readonly retained: number } {
  let removed = 0;
  let retained = 0;
  for (const entry of input.entries) {
    if (entry.expiresAt > input.now) continue;
    try {
      if (input.artifacts.remove(entry.reference).removed) removed += 1;
      else retained += 1;
    } catch {
      retained += 1;
    }
  }
  return { removed, retained };
}

function reconcileBatchPackets(input: {
  readonly batchId: string;
  readonly packets: readonly PendingPacket[];
  readonly state: PlaytestBatchArtifactState | null | undefined;
  readonly artifacts: PlaytestArtifactStore;
}): ReconciledPacketCounts {
  if (!input.state) {
    return {
      committed: 0,
      removed: 0,
      retained: input.packets.length
    };
  }
  const active =
    input.state.latestStatus === "queued" ||
    input.state.latestStatus === "running";
  let committed = 0;
  let removed = 0;
  let retained = 0;
  for (const packet of input.packets) {
    const sameId = input.state.packetArtifacts.find(
      (reference) => reference.artifactId === packet.reference.artifactId
    );
    if (sameId) {
      if (!sameArtifact(sameId, packet.reference)) {
        retained += 1;
        continue;
      }
      try {
        input.artifacts.markArtifactCommitted(packet.reference, input.batchId);
        committed += 1;
      } catch {
        retained += 1;
      }
      continue;
    }
    if (active) {
      retained += 1;
      continue;
    }
    try {
      if (input.artifacts.remove(packet.reference).removed) removed += 1;
      else retained += 1;
    } catch {
      retained += 1;
    }
  }
  return { committed, removed, retained };
}

/**
 * Finalize pending packet markers and reclaim stale packet artifacts that have
 * no durable receipt. The operation is idempotent and safe to repeat at MCP
 * startup after a process or storage failure.
 */
export async function reconcilePendingPlaytestPackets(input: {
  readonly workspaceId: string;
  readonly artifacts: PlaytestArtifactStore;
  readonly repository: PlaytestPacketArtifactRepository;
  readonly now?: number;
}): Promise<PlaytestPacketArtifactReconciliationResult> {
  const zero = {
    candidates: 0,
    committed: 0,
    removed: 0,
    retained: 0,
    truncated: false
  };
  if (input.artifacts.boundWorkspaceId() !== input.workspaceId) {
    return { ...zero, status: "deferred", retained: 1 };
  }
  let pending: ReturnType<PlaytestArtifactStore["listPendingArtifacts"]>;
  try {
    pending = input.artifacts.listPendingArtifacts({
      mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
      limit: PLAYTEST_PACKET_PENDING_SCAN_LIMIT
    });
  } catch {
    return { ...zero, status: "deferred", retained: 1 };
  }
  const now = input.now ?? Date.now();
  const expired = reclaimExpiredPackets({
    entries: pending.entries,
    artifacts: input.artifacts,
    now
  });
  const eligible = pending.entries.filter(
    (entry) =>
      entry.expiresAt > now &&
      entry.createdAt <= now - PLAYTEST_PACKET_PENDING_GRACE_MS
  );
  const groups = groupByBatch(eligible);
  const selected = groups.slice(0, PLAYTEST_PACKET_PENDING_BATCH_LIMIT);
  const counts = {
    candidates: eligible.length,
    committed: 0,
    removed: expired.removed,
    retained:
      expired.retained +
      pending.entries.filter(
        (entry) =>
          entry.expiresAt > now &&
          entry.createdAt > now - PLAYTEST_PACKET_PENDING_GRACE_MS
      ).length,
    truncated: pending.truncated || groups.length > selected.length
  };
  if (selected.length === 0) {
    return {
      ...counts,
      status: counts.truncated ? "deferred" : "complete"
    };
  }

  const states = await mapConcurrentOrdered(
    selected,
    PACKET_STATE_READ_CONCURRENCY,
    async ({ batchId }) => {
      try {
        return await input.repository.getBatchArtifactState(
          input.workspaceId,
          batchId
        );
      } catch {
        return null;
      }
    }
  );
  for (const [index, group] of selected.entries()) {
    const reconciled = reconcileBatchPackets({
      batchId: group.batchId,
      packets: group.packets,
      state: states[index],
      artifacts: input.artifacts
    });
    counts.committed += reconciled.committed;
    counts.removed += reconciled.removed;
    counts.retained += reconciled.retained;
  }
  return {
    ...counts,
    status: counts.truncated || counts.retained > 0 ? "deferred" : "complete"
  };
}
