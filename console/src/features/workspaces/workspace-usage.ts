import type { UsageWorkspaceRequestBreakdown } from "@simulatorlife/autodev-core";

/**
 * What the Usage telemetry says about one workspace's logical requests.
 *
 * The three readings are three different claims and the Console keeps them
 * apart:
 *
 * - `observed` is a measured count, including a measured zero.
 * - `not-observed` is a source that answered but did not report this
 *   workspace: the request breakdown was never observed, or it was truncated
 *   before this workspace appeared in it.
 * - `unavailable` is a source that could not be reached or read at all.
 *
 * Collapsing `not-observed` into `observed` with a zero is the failure this
 * type exists to prevent: an unmeasured workspace would then look like a
 * quiet one.
 */
export type WorkspaceRequestReading =
  | { readonly kind: "observed"; readonly count: number }
  | { readonly kind: "not-observed" }
  | { readonly kind: "unavailable" };

/** Each workspace's request reading, keyed by workspace id. */
export type WorkspaceRequestLookup = ReadonlyMap<
  string,
  WorkspaceRequestReading
>;

/**
 * What the Usage source could tell this page about request counts.
 *
 * The three states are the three the readings above can express, kept
 * separate at the boundary so no caller has to infer one from another: a
 * source that was never read is not a source that observed nothing, and a
 * source that read fine but reported no breakdown is not a source that read
 * fine and observed zero requests in every workspace.
 */
export type WorkspaceRequestSource =
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-observed" }
  | {
      readonly kind: "observed";
      readonly breakdown: UsageWorkspaceRequestBreakdown;
    };

/**
 * Resolve each workspace's logical-request count from the Usage breakdown.
 *
 * The breakdown is the whole-product one, read once for the page rather than
 * per workspace: one query answers every workspace, which is what keeps this
 * surface affordable.
 *
 * A workspace that is absent from a *complete* breakdown made no requests in
 * the window, which is a measured zero and is reported as one. A workspace
 * absent from a *truncated* breakdown is simply not reported, and stays
 * unobserved -- the truncation is why the two cases are distinguished at all.
 *
 * Requests that carried no workspace attribution belong to no workspace and
 * are not counted in any of them.
 */
export function workspaceRequestLookup(
  source: WorkspaceRequestSource,
  workspaceIds: readonly string[]
): WorkspaceRequestLookup {
  const readings = new Map<string, WorkspaceRequestReading>();

  for (const workspaceId of workspaceIds) {
    if (source.kind !== "observed") {
      readings.set(workspaceId, { kind: source.kind });
      continue;
    }
    const matching = source.breakdown.rows.filter(
      (row) => row.workspace === workspaceId
    );
    if (matching.length > 0) {
      readings.set(workspaceId, {
        kind: "observed",
        count: matching.reduce((total, row) => total + row.count, 0)
      });
      continue;
    }
    readings.set(
      workspaceId,
      source.breakdown.partial
        ? { kind: "not-observed" }
        : { kind: "observed", count: 0 }
    );
  }
  return readings;
}
