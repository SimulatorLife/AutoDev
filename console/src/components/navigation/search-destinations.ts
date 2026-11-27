import type {
  ControlApiAgentsResponse,
  ControlApiModelsResponse,
  ControlApiProvidersResponse,
  ControlApiWorkspacesResponse
} from "@simulatorlife/autodev-core";

import { modelPath, providerPath } from "../../features/providers/paths.ts";
import { workspacePath } from "../../features/workspaces/paths.ts";

export interface SearchableDestination {
  readonly title: string;
  readonly detail: string;
  readonly type?: string;
}

export interface SearchDestination extends SearchableDestination {
  readonly id: string;
  readonly type: "Provider" | "Model" | "Agent role" | "Workspace";
  readonly path: string;
}

export type SearchSource =
  | "providers"
  | "models"
  | "agentRoles"
  | "workspaces"
  | "configuration"
  | "endpoint";

const SEARCH_SOURCE_LABELS: Readonly<Record<SearchSource, string>> = {
  providers: "Providers",
  models: "Models",
  agentRoles: "Agent roles",
  workspaces: "Workspaces",
  configuration: "search configuration",
  endpoint: "search service"
};

export function isSearchSource(value: unknown): value is SearchSource {
  return (
    typeof value === "string" && Object.hasOwn(SEARCH_SOURCE_LABELS, value)
  );
}

export function searchFailureMessage(
  unavailableSources: readonly SearchSource[]
): string {
  const sources = unavailableSources
    .map((source) => SEARCH_SOURCE_LABELS[source])
    .join(", ");
  const isTotalFailure =
    unavailableSources.includes("configuration") ||
    unavailableSources.includes("endpoint") ||
    ["providers", "models", "agentRoles", "workspaces"].every((source) =>
      unavailableSources.includes(source as SearchSource)
    );
  const prefix = isTotalFailure
    ? "Search records are unavailable"
    : "Some search records are unavailable";
  return `${prefix}: ${sources || "search service"}. Section results remain available. Reopen Search to retry.`;
}

export function searchDestinations(data: {
  readonly providers?: ControlApiProvidersResponse | undefined;
  readonly models?: ControlApiModelsResponse | undefined;
  readonly agents?: ControlApiAgentsResponse | undefined;
  readonly workspaces?: ControlApiWorkspacesResponse | undefined;
}): readonly SearchDestination[] {
  return [
    ...(data.providers?.providers.map((provider) => ({
      id: `provider:${provider.id}`,
      title: provider.id,
      detail: "Provider",
      type: "Provider" as const,
      path: providerPath(provider.id)
    })) ?? []),
    ...(data.models?.models.map((model) => ({
      id: `model:${model.provider}:${model.id}`,
      title: model.displayName ?? model.id,
      detail: `${model.provider} · ${model.id}`,
      type: "Model" as const,
      path: modelPath(model.provider, model.id)
    })) ?? []),
    ...(data.agents?.agents.map((agent) => ({
      id: `role:${agent.role}`,
      title: agent.role,
      detail: "Agent role",
      type: "Agent role" as const,
      path: `/agents/${encodeURIComponent(agent.id)}`
    })) ?? []),
    ...(data.workspaces?.catalogStatus === "valid"
      ? data.workspaces.workspaces.map((workspace) => ({
          id: `workspace:${workspace.id}`,
          title: workspace.id,
          detail: "Workspace",
          type: "Workspace" as const,
          path: workspacePath(workspace.id)
        }))
      : [])
  ];
}

export function matchesSearchDestination(
  result: SearchableDestination,
  query: string
): boolean {
  const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const text = `${result.title} ${result.detail} ${result.type}`.toLowerCase();
  return words.every((word) => text.includes(word));
}
