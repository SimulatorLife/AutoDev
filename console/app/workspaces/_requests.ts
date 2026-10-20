/**
 * The Usage evidence the Workspaces surface reads.
 *
 * Both Workspaces routes read the same thing from the same source, so the
 * read lives here rather than being written twice: the list resolves every
 * workspace's count from one breakdown, and the detail route resolves the
 * one workspace it is about.
 */
import {
  type WorkspaceRequestLookup,
  workspaceRequestLookup,
  type WorkspaceRequestSource
} from "../../src/features/workspaces/workspace-usage.ts";
import { loadOpenLITUsage } from "../../src/lib/server/openlit-usage.ts";

/**
 * The Usage source's answer, as the three distinct claims the surface can
 * make.
 *
 * A source the Console could not read is `unavailable`; a source that read
 * but produced no breakdown is `not-observed`. Keeping them apart is the
 * point: neither is a workspace that made no requests.
 */
export async function readWorkspaceRequestSource(): Promise<WorkspaceRequestSource> {
  const result = await loadOpenLITUsage({ range: "24H", values: {} });
  if (result.kind !== "ok") return { kind: "unavailable" };
  const breakdown = result.data.metrics.requestsByWorkspace;
  if (breakdown === null) return { kind: "not-observed" };
  return { kind: "observed", breakdown };
}

/**
 * Every workspace's logical-request count over the last 24 hours.
 *
 * The Usage telemetry groups logical routed requests by workspace, so one
 * read answers every row; asking per workspace would run one query per row
 * to read the same breakdown.
 */
export async function readWorkspaceRequests(
  workspaceIds: readonly string[]
): Promise<WorkspaceRequestLookup> {
  return workspaceRequestLookup(
    await readWorkspaceRequestSource(),
    workspaceIds
  );
}
