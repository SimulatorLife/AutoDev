import type { AgentRole } from "../agents/types.ts";

/** Canonical AutoDev workspace/repository configuration. */
export interface WorkspaceEntry {
  /** Stable workspace key; currently the canonical GitHub owner/repository. */
  readonly id: string;
  readonly baseBranch: string;
  readonly enabled: boolean;
  /** Null means workspace role scope has not been configured. */
  readonly agentRoles: readonly AgentRole[] | null;
}

export type WorkspaceCatalogStatus = "valid" | "invalid" | "unavailable";

/**
 * Whether one workspace's canonical configuration entry is usable.
 *
 * The catalog reader validates the *shape* of an entry: a malformed entry
 * makes the whole catalog invalid. It cannot judge an entry's *meaning*, and
 * one meaning is judgeable -- a role scope that names a role AutoDev does not
 * define. Such an entry parses, the catalog reports "valid", and the scope
 * silently excludes every agent that could ever work in the workspace.
 */
export type WorkspaceConfigurationHealth =
  | { readonly status: "configured" }
  | {
      readonly status: "invalid-role-scope";
      /** The scope names that no configured role answers to. */
      readonly unknownRoles: readonly string[];
    };

/**
 * What the runtime currently reports for one workspace.
 *
 * `not-observed` means the runtime reported no live-agent source at all, so
 * the workspace's activity is unknown. `observed` means the source answered:
 * `liveAgents` is then a measured count, and a workspace the source did not
 * list has zero live agents rather than an unknown state. This is the same
 * distinction the Agents and Providers surfaces make, and it is the only
 * honest one: an idle workspace and an unobserved workspace are different
 * facts.
 */
export type WorkspaceRuntimeAvailability =
  | { readonly status: "not-observed" }
  | { readonly status: "observed"; readonly liveAgents: number };

export interface WorkspaceAttribution {
  readonly workspace: string;
  readonly workspaceId?: string;
  readonly isLocal: boolean;
}
