/**
 * Typed shapes returned by the AutoDev Control API.
 *
 * These mirrors are derived from the runtime Control API handlers
 * (`runtime/src/control-api/index.ts`). They are intentionally narrow: each field is
 * an `unknown` until a runtime validator narrows it. The view layer is
 * responsible for refusing to render synthetic values when a field is missing.
 */

export interface ControlApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export interface ControlApiAgentRecord {
  readonly id: string;
  readonly role: string;
  readonly kind: "orchestrator" | "leaf";
  readonly readOnly: boolean;
  readonly configured: boolean;
  readonly valid: boolean | null;
  readonly status: "configured" | "valid" | "invalid" | "ready" | "unavailable";
  readonly convergence: "converged" | "pending" | "error" | "not-observed";
  readonly primaryModel: string;
  readonly allowedProviders: readonly string[];
  readonly mcps: readonly string[];
  readonly skills: readonly string[];
}

export interface ControlApiAgentsResponse {
  readonly schema: "autodev-control-agents-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalAgents: number;
  readonly agents: readonly (ControlApiAgentRecord & {
    readonly hasPrompt: boolean;
  })[];
}

export interface ControlApiAgentDetailResponse extends ControlApiAgentRecord {
  readonly schema: "autodev-control-agent-detail-v1";
  readonly promptPath: string | null;
  readonly systemPrompt: string;
}

export interface ControlApiProvidersResponse {
  readonly schema: "autodev-control-providers-v1";
  readonly providers: readonly {
    readonly id: string;
    readonly roles: {
      readonly orchestrator: {
        readonly enabled: boolean;
        readonly mutable: boolean;
      };
      readonly subagent: {
        readonly enabled: boolean;
        readonly mutable: boolean;
      };
    };
  }[];
  readonly disabledOrchestratorProviders: readonly string[];
  readonly disabledSubagentProviders: readonly string[];
}

export interface ControlApiModelsResponse {
  readonly schema: "autodev-control-models-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalModels: number;
  readonly models: readonly {
    readonly slug: string;
    readonly display_name?: string;
  }[];
}

export interface ControlApiMcpsResponse {
  readonly schema: "autodev-control-mcps-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly servers: readonly {
    readonly name: string;
    readonly roles: readonly string[];
  }[];
}

export interface ControlApiSkillsResponse {
  readonly schema: "autodev-control-skills-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly skills: readonly {
    readonly name: string;
    readonly roles: readonly string[];
  }[];
}

export interface ControlApiHooksResponse {
  readonly schema: "autodev-control-hooks-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  readonly hooks: Readonly<Record<string, unknown>>;
}

export interface ControlApiPermissionsResponse {
  readonly schema: "autodev-control-permissions-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly policy: {
    readonly approvalPolicy: "never" | "always" | "on-demand";
    readonly sandboxMode: "read-only" | "workspace-write" | "unrestricted";
    readonly approvalsReviewer: string;
    readonly networkAccess: boolean;
    readonly webSearch: boolean;
    readonly defaultToolsApprovalMode: string;
  };
  readonly rolePermissions: Readonly<
    Record<
      string,
      {
        readonly readOnly: boolean;
        readonly sandbox: string;
        readonly networkAccess: boolean;
        readonly approvals: string;
      }
    >
  >;
}

export interface ControlApiPromptsResponse {
  readonly schema: "autodev-control-prompts-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalCommands: number;
  readonly commands: readonly {
    readonly name: string;
    readonly path: string;
    readonly description: string;
  }[];
  readonly rolePrompts: readonly {
    readonly role: string;
    readonly path: string;
  }[];
}

export interface ControlApiPromptDetailResponse {
  readonly schema: "autodev-control-prompt-detail-v1";
  readonly name: string;
  readonly type: "command" | "role";
  readonly source: string;
  readonly content: string;
}

export interface ControlApiWorkspacesResponse {
  readonly schema: "autodev-control-workspaces-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalWorkspaces: number;
  readonly workspaces: readonly {
    readonly name: string;
    readonly baseBranch: string;
    readonly weight: number;
  }[];
}

export interface ControlApiRoutingResponse {
  readonly schema: "autodev-control-routing-v1";
  readonly runtime: {
    readonly disabledOrchestratorProviders: readonly string[];
    readonly disabledSubagentProviders: readonly string[];
  };
  readonly routes: readonly {
    readonly provider: string;
    readonly pattern: string;
    readonly baseUrl: string;
  }[];
  readonly cooldowns: Readonly<Record<string, unknown>>;
}

export interface ControlApiRuntimeResponse {
  readonly schema: "autodev-control-runtime-v1";
  readonly routerInstanceId: string;
  readonly lifecycle: { readonly state: string };
  readonly concurrency: { readonly limit: number; readonly active: number };
  readonly inFlightRequestCount: number;
}

export type ControlApiResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | {
      readonly kind: "unauthorized";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "unreachable"; readonly message: string };
