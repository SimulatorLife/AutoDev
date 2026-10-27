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

/**
 * The state the Runtime reports for an agent.
 *
 * The five states below are the ones the product has words for. The union is
 * open because the Control API is a service whose states can grow, and a
 * Console that refused to show a state it has no word for would either blank
 * the row or take the whole page down over one field. The Console's own view
 * of an agent therefore has to be able to carry a state it has not been taught,
 * so that the badge can name it.
 *
 * The Runtime's own producer narrows this back to the states it can actually
 * report, so an open union here does not make a typo in the Runtime compile.
 */
export type AgentStatus =
  "configured" | "valid" | "invalid" | "ready" | "unavailable" | (string & {});

/**
 * Whether the Runtime observed an agent's rollout converge.
 *
 * A closed vocabulary: this is a verdict the Runtime computes, and the Console
 * validates it rather than guessing at one it does not recognise.
 */
export type AgentConvergence =
  "converged" | "pending" | "error" | "not-observed";

/** Runtime-owned enablement for one named AutoDev routing alias. */
export type AgentEnablementState =
  | {
      readonly kind: "observed";
      readonly enabled: boolean;
      readonly mutable: true;
      readonly revision: string;
    }
  | {
      readonly kind: "unavailable";
      readonly enabled: null;
      readonly mutable: false;
      readonly reason: string;
    };

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
  readonly enablement: AgentEnablementState;
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
