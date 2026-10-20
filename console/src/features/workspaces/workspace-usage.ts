import type { UsageWorkspaceRequestBreakdown } from "@simulatorlife/autodev-core";
import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

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
 * Resolve one workspace's logical-request count from the Usage breakdown.
 *
 * A workspace that is absent from a *complete* breakdown made no requests in
 * the window, which is a measured zero and is reported as one. A workspace
 * absent from a *truncated* breakdown is simply not reported, and stays
 * unobserved -- the truncation is why the two cases are distinguished at all.
 *
 * Requests that carried no workspace attribution belong to no workspace and
 * are not counted in any of them.
 */
export function workspaceRequestReading(
  source: WorkspaceRequestSource,
  workspaceId: string
): WorkspaceRequestReading {
  if (source.kind !== "observed") return { kind: source.kind };
  const matching = source.breakdown.rows.filter(
    (row) => row.workspace === workspaceId
  );
  if (matching.length > 0) {
    return {
      kind: "observed",
      count: matching.reduce((total, row) => total + row.count, 0)
    };
  }
  return source.breakdown.partial
    ? { kind: "not-observed" }
    : { kind: "observed", count: 0 };
}

/**
 * Resolve each workspace's logical-request count from the Usage breakdown.
 *
 * The breakdown is the whole-product one, read once for the page rather than
 * per workspace: one query answers every workspace, which is what keeps this
 * surface affordable.
 */
export function workspaceRequestLookup(
  source: WorkspaceRequestSource,
  workspaceIds: readonly string[]
): WorkspaceRequestLookup {
  const readings = new Map<string, WorkspaceRequestReading>();
  for (const workspaceId of workspaceIds) {
    readings.set(workspaceId, workspaceRequestReading(source, workspaceId));
  }
  return readings;
}

/**
 * The rendered Requests value.
 *
 * A count is rendered as a number, and everything else is rendered as the
 * reason there is no number: the source could not be read, or it answered
 * without reporting this workspace. The list row and the workspace detail
 * render this same value, so the two surfaces cannot drift into different
 * vocabularies for the same fact.
 */
export function workspaceRequestValue(
  reading: WorkspaceRequestReading | undefined
): React.JSX.Element {
  if (reading === undefined || reading.kind === "not-observed") {
    return React.createElement(
      "span",
      {
        className: MUTED_META_CLASS,
        "data-workspace-requests": "not-observed"
      },
      NOT_OBSERVED_LABEL
    );
  }
  if (reading.kind === "unavailable") {
    return React.createElement(
      "span",
      {
        className: MUTED_META_CLASS,
        "data-workspace-requests": "unavailable"
      },
      "Unavailable"
    );
  }
  return React.createElement(
    "span",
    {
      className: "text-xs text-fg-secondary tabular-nums",
      "data-workspace-requests": "observed"
    },
    String(reading.count)
  );
}
