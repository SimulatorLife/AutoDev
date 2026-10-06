import { extractWorkspaceIdWithAmbiguity, safeWorkspaceId } from "./usage.ts";

/**
 * Workspace attribution policy.
 *
 * Deciding which workspace a metric datapoint belongs to is a question about
 * the payload alone: which of the two attribute sources names a workspace, and
 * whether that naming is trustworthy. It used to be answered inside
 * `OtelTracker.resolveDatapointWorkspace`, which mutated diagnostic counters
 * and a bounded ring of unknown ids in the middle of deciding -- so the rule
 * could only be exercised by driving a whole tracker and reading its telemetry
 * back out.
 *
 * The evaluator here is pure. It reads the registry and the conflict set without
 * writing to either, returns a verdict, and mutates nothing. Recording what the
 * verdict means stays with the caller, which is what makes the distinction
 * between "unattributable" and "not counted" expressible at all: an id the
 * registry has never seen is unattributable regardless of whether this
 * particular observation is the one being counted.
 */

export type WorkspaceAttributionSource = "datapoint" | "resource";

export type WorkspaceUnattributedReason =
  "ambiguous_resource" | "missing_workspace" | "unknown_workspace_id";

export interface WorkspaceAttributionInputs {
  readonly dataPointAttributes: unknown;
  readonly resourceAttributes: unknown;
  /** Sanitised workspace id -> the bucket key it was registered under. */
  readonly registeredKeys: ReadonlyMap<string, string>;
  /** Ids two buckets both claimed; never attributable, by construction. */
  readonly conflictedIds: ReadonlySet<string>;
}

export interface WorkspaceAttributionVerdict {
  readonly status: "attributed" | "unattributed";
  readonly workspaceKey: string | null;
  /**
   * Present even when unattributed for an unknown id: the datapoint still
   * carries that id, and callers use it as the series identity so a workspace
   * does not appear to have stopped reporting just because it was not in the
   * registry when the datapoint arrived.
   */
  readonly workspaceId: string | null;
  readonly source: WorkspaceAttributionSource | null;
  readonly reason?: WorkspaceUnattributedReason;
}

interface ExtractedWorkspace {
  readonly datapoint: { id: string | null; ambiguous: boolean };
  readonly resource: { id: string | null; ambiguous: boolean };
  readonly datapointId: string | null;
  readonly resourceId: string | null;
}

function extract(inputs: WorkspaceAttributionInputs): ExtractedWorkspace {
  const datapoint = extractWorkspaceIdWithAmbiguity(inputs.dataPointAttributes);
  const resource = extractWorkspaceIdWithAmbiguity(inputs.resourceAttributes);
  return {
    datapoint,
    resource,
    datapointId: datapoint.id ? safeWorkspaceId(datapoint.id) : null,
    resourceId: resource.id ? safeWorkspaceId(resource.id) : null
  };
}

/**
 * An id is ambiguous when either source names more than one workspace, or when
 * both name one and disagree. Disagreement is only decidable once both
 * sanitise to something, so a source that named nothing cannot conflict.
 */
function isAmbiguous(ids: ExtractedWorkspace): boolean {
  return (
    ids.datapoint.ambiguous ||
    ids.resource.ambiguous ||
    (ids.datapointId !== null &&
      ids.resourceId !== null &&
      ids.datapointId !== ids.resourceId)
  );
}

function unattributed(
  workspaceId: string | null,
  reason: WorkspaceUnattributedReason,
  source: WorkspaceAttributionSource | null
): WorkspaceAttributionVerdict {
  return {
    status: "unattributed",
    workspaceKey: null,
    workspaceId,
    reason,
    source
  };
}

export function evaluateWorkspaceAttribution(
  inputs: WorkspaceAttributionInputs
): WorkspaceAttributionVerdict {
  const ids = extract(inputs);
  if (isAmbiguous(ids))
    // A conflict names the source that disagreed, so an ambiguous pair with
    // nothing on the resource side still reports it as the fallback source.
    return unattributed(
      null,
      "ambiguous_resource",
      ids.datapoint.id ? "datapoint" : "resource"
    );

  const workspaceId = ids.datapointId ?? ids.resourceId;
  const source: WorkspaceAttributionSource | null = ids.datapointId
    ? "datapoint"
    : ids.resourceId
      ? "resource"
      : null;
  if (!workspaceId) return unattributed(null, "missing_workspace", null);

  // A conflicted id was registered, then un-registered and blacklisted. It
  // resolves to nothing, and it must stay unattributed even though the registry
  // may still hold the key it was first claimed with.
  if (inputs.conflictedIds.has(workspaceId))
    return unattributed(workspaceId, "unknown_workspace_id", source);

  const workspaceKey = inputs.registeredKeys.get(workspaceId);
  if (workspaceKey)
    return { status: "attributed", workspaceKey, workspaceId, source };
  return unattributed(workspaceId, "unknown_workspace_id", source);
}
