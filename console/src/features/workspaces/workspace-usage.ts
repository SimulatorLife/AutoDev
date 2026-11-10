import React from "react";

import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import type { UsageWorkspaceRequestSource } from "../usage/usage-api.ts";

/**
 * What the Usage telemetry says about one workspace's logical requests.
 *
 * The four readings are four different claims and the Console keeps them
 * apart:
 *
 * - `observed` is a measured count, including a measured zero.
 * - `not-observed` is a source that answered but did not report this
 *   workspace: the request breakdown was never observed, or it was truncated
 *   before this workspace appeared in it.
 * - `unavailable` is a source that could not be reached or read at all.
 * - `pending` is a reading that has not been made yet: the surface is
 *   waiting for the answer and has none.
 *
 * Collapsing `not-observed` into `observed` with a zero is the failure this
 * type exists to prevent: an unmeasured workspace would then look like a
 * quiet one. `pending` is kept apart for the same reason, and it is the
 * reason a zero is never rendered for a workspace whose number is on its
 * way: a zero is a measurement, and a number that has not arrived is not a
 * measurement of anything.
 */
export type WorkspaceRequestReading =
  | { readonly kind: "observed"; readonly count: number }
  | { readonly kind: "not-observed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "pending" };

/** Each workspace's request reading, keyed by workspace id. */
export type WorkspaceRequestLookup = ReadonlyMap<
  string,
  WorkspaceRequestReading
>;

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
  source: UsageWorkspaceRequestSource,
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
  source: UsageWorkspaceRequestSource,
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
 * reason there is no number: the source could not be read, it answered
 * without reporting this workspace, or the reading has not arrived yet. The
 * list row and the workspace detail render this same value, so the two
 * surfaces cannot drift into different vocabularies for the same fact.
 *
 * The pending reading carries `aria-busy`, so assistive technology is told
 * that the cell is still being filled in. That is the difference between a
 * number that is on its way and a number that will never arrive, and it is
 * the difference the reader would otherwise have to guess at.
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
  if (reading.kind === "pending") {
    return React.createElement(
      "span",
      {
        className: MUTED_META_CLASS,
        "data-workspace-requests": "pending",
        "aria-busy": "true"
      },
      "Pending"
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
