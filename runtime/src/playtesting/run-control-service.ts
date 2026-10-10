/** One Runtime-process Playtesting run owner shared by Control API routes. */
import { ConfigRepository } from "@simulatorlife/autodev-data";
import { PlaytestRepository } from "@simulatorlife/autodev-data/playtesting";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "./artifact-store.ts";
import { createPlaytestRunControl, type PlaytestRunOwner } from "./mcp.ts";

let defaultRunControl: PlaytestRunOwner | null = null;

/**
 * The authenticated Control API and any in-process Runtime facade share this
 * exact manager. It owns run IDs, cancellation, worker/episode reservations,
 * approval revocation monitoring and terminal status.
 */
export function getDefaultPlaytestRunControl(): PlaytestRunOwner {
  if (defaultRunControl !== null) return defaultRunControl;
  const configRepository = new ConfigRepository();
  const approvalRepository = new WorkspacePlaytestApprovalRepository();
  const playtestRepository = new PlaytestRepository();
  const artifactStores = new Map<string, PlaytestArtifactStore>();
  defaultRunControl = createPlaytestRunControl({
    artifactStoreForWorkspace(workspaceId) {
      let store = artifactStores.get(workspaceId);
      if (!store) {
        store = new PlaytestArtifactStore({ workspaceId });
        artifactStores.set(workspaceId, store);
      }
      return store;
    },
    approvalRepository,
    playtestRepository,
    readWorkspaceCatalog: () => configRepository.readWorkspaceCatalog()
  });
  return defaultRunControl;
}

/** Cancel live adapter containers before the Runtime process exits. */
export async function shutdownDefaultPlaytestRunControl(): Promise<void> {
  await defaultRunControl?.shutdown();
}
