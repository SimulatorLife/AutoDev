import React from "react";

export type MemoryTab = "records" | "experiences" | "cohorts" | "portal";

/**
 * URL scope shared by every Memory tab: the workspace, the record filters,
 * and the outcome time window. Every Memory link and form carries the whole
 * scope, so selecting a record, filtering, or switching tabs never silently
 * resets the rest of it.
 */
export interface MemoryUrlScope {
  readonly workspaceId: string;
  readonly query: string;
  /** Record kind filter; `"all"` when unfiltered. */
  readonly kind: string;
  /** Record status filter; `"all"` when unfiltered. */
  readonly status: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
}

type MemoryScopeParam =
  "workspaceId" | "from" | "until" | "query" | "kind" | "status";

/** Search parameters encoding `scope`, omitting unfiltered values. */
function memoryScopeParams(
  scope: MemoryUrlScope
): ReadonlyArray<readonly [MemoryScopeParam, string]> {
  return [
    ["workspaceId", scope.workspaceId],
    ["from", scope.occurredFrom],
    ["until", scope.occurredUntil],
    ...(scope.query ? [["query", scope.query] as const] : []),
    ...(scope.kind === "all" ? [] : [["kind", scope.kind] as const]),
    ...(scope.status === "all" ? [] : [["status", scope.status] as const])
  ];
}

/** Memory URL for `tab` within `scope`, plus optional selection params. */
export function memoryHref(
  scope: MemoryUrlScope,
  tab: MemoryTab,
  selection: Readonly<Record<string, string>> = {}
): string {
  const params = new URLSearchParams({ tab });
  for (const [name, value] of memoryScopeParams(scope))
    params.append(name, value);
  for (const [name, value] of Object.entries(selection))
    params.append(name, value);
  return `/memory?${params.toString()}`;
}

/**
 * Hidden inputs that carry the parts of `scope` a filter form does not edit,
 * so submitting the form changes only the fields it shows.
 */
export function memoryScopeHiddenInputs(
  scope: MemoryUrlScope,
  tab: MemoryTab,
  edited: readonly MemoryScopeParam[]
): React.JSX.Element[] {
  return [
    ["tab", tab] as const,
    ...memoryScopeParams(scope).filter(([name]) => !edited.includes(name))
  ].map(([name, value]) =>
    React.createElement("input", { key: name, type: "hidden", name, value })
  );
}
