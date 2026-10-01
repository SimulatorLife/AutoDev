export type AgentRole =
  | "orchestrator"
  | "worker"
  | "explorer"
  | "validator"
  | "smart"
  | "docs-researcher"
  | "browser-tester"
  | "default"
  | (string & {});

export type AgentKind = "orchestrator" | "leaf";

export type AgentStatus =
  "configured" | "valid" | "invalid" | "ready" | "unavailable";

export type AgentConvergence =
  "converged" | "pending" | "error" | "not-observed";

export interface AgentToolEntry {
  readonly name: string;
  readonly type: "mcp" | "skill";
  readonly server?: string;
}

export interface AgentDefinition {
  readonly id: string;
  readonly role: AgentRole;
  readonly kind: AgentKind;
  readonly readOnly: boolean;
  readonly configured: boolean;
  readonly valid: boolean | null;
  readonly status: AgentStatus;
  readonly convergence: AgentConvergence;
  readonly primaryModel: string;
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly tools: readonly AgentToolEntry[];
  readonly toolNames: readonly string[];
  readonly systemPrompt?: string;
  readonly runtimeConfig?: Record<string, unknown>;
}

export function validateAgentDefinition(agent: Partial<AgentDefinition>): {
  valid: boolean;
  errors: readonly string[];
} {
  const errors: string[] = [];
  if (!agent.id || agent.id.trim().length === 0) {
    errors.push("Agent must have a non-empty id");
  }
  if (!agent.role || agent.role.trim().length === 0) {
    errors.push("Agent must have a non-empty role");
  }
  if (agent.kind !== "orchestrator" && agent.kind !== "leaf") {
    errors.push("Agent kind must be 'orchestrator' or 'leaf'");
  }
  return {
    valid: errors.length === 0,
    errors
  };
}
