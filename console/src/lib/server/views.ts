/**
 * Server-side helpers that adapt Control API responses to the typed shapes
 * the existing view components expect, and that explicitly omit synthetic
 * values when the upstream has no data.
 */

import type {
  AgentDefinition,
  EvaluationResult,
  HookDefinition,
  PermissionPolicy,
  PromptAsset,
  PromptDocument,
  RoleCapabilityMatrix,
  SkillDefinition,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";

import type {
  ControlApiAgentDetailResponse,
  ControlApiAgentRecord,
  ControlApiAgentsResponse,
  ControlApiHooksResponse,
  ControlApiPermissionsResponse,
  ControlApiPromptDetailResponse,
  ControlApiPromptsResponse,
  ControlApiSkillsResponse,
  ControlApiWorkspacesResponse
} from "./types.ts";

const ROLE_COLLATOR = new Intl.Collator();

export function agentsFromControlApi(
  response: ControlApiAgentsResponse
): readonly AgentDefinition[] {
  return response.agents.map(agentFromControlApi);
}

export function agentFromControlApi(
  agent: ControlApiAgentRecord & { readonly systemPrompt?: string }
): AgentDefinition {
  return {
    id: agent.id,
    role: agent.role,
    kind: agent.kind,
    readOnly: agent.readOnly,
    configured: agent.configured,
    valid: agent.valid,
    status: agent.status,
    convergence: agent.convergence,
    primaryModel: agent.primaryModel,
    models: [agent.primaryModel],
    providers: agent.allowedProviders,
    tools: [
      ...agent.skills.map<AgentDefinition["tools"][number]>((name) => ({
        name,
        type: "skill" as const
      })),
      ...agent.mcps.map<AgentDefinition["tools"][number]>((name) => ({
        name,
        type: "mcp" as const,
        server: name
      }))
    ],
    toolNames: [...agent.skills, ...agent.mcps],
    ...(agent.systemPrompt === undefined
      ? {}
      : { systemPrompt: agent.systemPrompt })
  };
}

export function agentDetailFromControlApi(
  response: ControlApiAgentDetailResponse
): AgentDefinition {
  return agentFromControlApi(response);
}

export function skillsFromControlApi(
  response: ControlApiSkillsResponse | undefined
): readonly SkillDefinition[] {
  if (!response) return [];
  return response.skills.map((skill) => ({
    name: skill.name,
    description: `Skill declared in ${skill.name}`,
    path: `.rulesync/skills/${skill.name}`
  }));
}

export function hooksFromControlApi(
  response: ControlApiHooksResponse
): readonly HookDefinition[] {
  const hooks = response.hooks;
  const events = Object.keys(hooks);
  return events
    .map((event): HookDefinition | null => {
      const actions = hooks[event];
      if (!Array.isArray(actions)) return null;
      const mapped = actions
        .map((action) => {
          if (!action || typeof action !== "object" || Array.isArray(action)) {
            return null;
          }
          const entry = action as Record<string, unknown>;
          if (typeof entry.command !== "string") return null;
          return {
            type: "command" as const,
            command: entry.command,
            ...(typeof entry.matcher === "string"
              ? { matcher: entry.matcher }
              : {}),
            ...(typeof entry.statusMessage === "string"
              ? { statusMessage: entry.statusMessage }
              : {})
          };
        })
        .filter(
          (entry): entry is HookDefinition["actions"][number] => entry !== null
        );
      if (mapped.length === 0) return null;
      return { event: event as HookDefinition["event"], actions: mapped };
    })
    .filter((entry): entry is HookDefinition => entry !== null);
}

export function permissionsFromControlApi(
  response: ControlApiPermissionsResponse
): {
  readonly policy: PermissionPolicy;
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
} {
  const roleMatrices: RoleCapabilityMatrix[] = Object.entries(
    response.rolePermissions
  )
    .map(([role, entry]) => {
      const sandboxMode: RoleCapabilityMatrix["sandboxMode"] =
        entry.sandbox === "read-only"
          ? "read-only"
          : entry.sandbox === "workspace-write"
            ? "workspace-write"
            : "unrestricted";
      return {
        role: role as RoleCapabilityMatrix["role"],
        readOnly: entry.readOnly,
        sandboxMode,
        allowedMcpServers: [],
        allowedSkills: []
      };
    })
    .sort((left, right) => ROLE_COLLATOR.compare(left.role, right.role));
  return {
    policy: {
      approvalPolicy: response.policy.approvalPolicy,
      sandboxMode: response.policy.sandboxMode,
      networkAccess: response.policy.networkAccess,
      webSearch: response.policy.webSearch,
      approvalsReviewer: response.policy.approvalsReviewer,
      defaultToolsApprovalMode: response.policy.defaultToolsApprovalMode
    },
    roleMatrices
  };
}

export function promptsFromControlApi(
  response: ControlApiPromptsResponse
): readonly PromptAsset[] {
  return [
    ...response.commands.map((command) => ({
      name: command.name,
      path: command.path,
      description: command.description
    })),
    ...response.rolePrompts.map((prompt) => ({
      name: prompt.role,
      path: prompt.path,
      description: "Agent role prompt"
    }))
  ];
}

export function promptDocumentFromControlApi(
  response: ControlApiPromptDetailResponse
): PromptDocument {
  return {
    name: response.name,
    kind: response.type,
    path: response.source,
    content: response.content
  };
}

export function workspacesFromControlApi(
  response: ControlApiWorkspacesResponse
): readonly WorkspaceEntry[] {
  return response.workspaces.map((workspace) => ({
    name: workspace.name,
    baseBranch: workspace.baseBranch,
    weight: workspace.weight
  }));
}

export const emptyEvaluations: readonly EvaluationResult[] = [];
