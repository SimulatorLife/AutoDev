/**
 * Server-side helpers that adapt Control API responses to the typed shapes
 * the existing view components expect, and that explicitly omit synthetic
 * values when the upstream has no data.
 */

import type {
  AgentDefinition,
  ControlApiAgentDetailResponse,
  ControlApiAgentRecord,
  ControlApiAgentsResponse,
  ControlApiHooksResponse,
  ControlApiPermissionsResponse,
  ControlApiPromptDetailResponse,
  ControlApiPromptsResponse,
  ControlApiSkillsResponse,
  ControlApiWorkspacesResponse,
  HookDefinition,
  PermissionPolicy,
  PromptAsset,
  PromptDocument,
  RoleCapabilityMatrix,
  SkillDefinition,
  SkillEligibility,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";

const ROLE_COLLATOR = new Intl.Collator();

/**
 * Display order for the capability matrix's rows.
 *
 * The matrix sorted roles alphabetically, so it showed `orchestrator` before
 * `smart` -- an order no other role surface used. The target state fixes the
 * sequence: "the four fixed roles -- Default, Smart, Orchestrator, Subagent"
 * are "the canonical roles". Alphabetical is neither that order nor any stated
 * one, so an operator had to re-learn the sequence per page.
 *
 * The order is declared here rather than read from Core's `PROVIDER_ROLES`,
 * which models the two routing roles a *provider* can be enabled for. These
 * rows are agent roles, and `AgentRole` is an open union: a Runtime may
 * legitimately report `worker` or `explorer`. Those rank after the canonical
 * four and are ordered among themselves by the collator -- they stay visible,
 * because dropping a role the API sent would hide evidence, and they stay
 * deterministic, because an arbitrary order would churn between reads.
 */
const CANONICAL_ROLE_ORDER = ["default", "smart", "orchestrator", "subagent"];

const ROLE_RANK = new Map<string, number>(
  CANONICAL_ROLE_ORDER.map((role, index) => [role, index])
);

function compareRoles(left: string, right: string): number {
  const leftRank = ROLE_RANK.get(left) ?? CANONICAL_ROLE_ORDER.length;
  const rightRank = ROLE_RANK.get(right) ?? CANONICAL_ROLE_ORDER.length;
  return leftRank - rightRank || ROLE_COLLATOR.compare(left, right);
}

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
  response: ControlApiSkillsResponse
): readonly SkillDefinition[] {
  return response.skills.map(({ name, description, path }) => ({
    name,
    description,
    path
  }));
}

export function skillEligibilityFromControlApi(
  response: ControlApiSkillsResponse
): readonly SkillEligibility[] {
  return response.skills.map((skill) => ({
    skill: skill.name,
    roles: skill.roles
  }));
}

export function unresolvedSkillAssignmentsFromControlApi(
  response: ControlApiSkillsResponse
): readonly SkillEligibility[] {
  return response.unresolvedAssignments.map(({ name, roles }) => ({
    skill: name,
    roles
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
        allowedMcpServers: entry.mcp,
        allowedMcpTools: entry.mcpTools,
        allowedSkills: entry.skills
      };
    })
    .sort((left, right) => compareRoles(left.role, right.role));
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
      kind: "command" as const,
      ...(command.description === undefined
        ? {}
        : { description: command.description })
    })),
    ...response.rolePrompts.map((prompt) => ({
      name: prompt.role,
      path: prompt.path,
      kind: "role" as const,
      description: `Agent role prompt for ${prompt.role}`
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
    content: response.content,
    preview: response.preview,
    revision: response.revision
  };
}

export function workspacesFromControlApi(
  response: ControlApiWorkspacesResponse
): readonly WorkspaceEntry[] {
  return response.workspaces;
}
