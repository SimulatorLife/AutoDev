import type { EvaluationResult } from "../evaluations/types.ts";
import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowCatalogStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "../github/types.ts";
import type { McpServerResource } from "../mcps/types.ts";
import type {
  ExperienceEnvelope,
  MemoryActor,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  MemoryStatus
} from "../memory/types.ts";
import type { SandboxMode } from "../permissions/types.ts";
import type {
  OperationHistoryEntry,
  ReconciliationDiff,
  ReconciliationStatus,
  ReconciliationView
} from "../reconciliation/types.ts";
import type {
  ProviderRole,
  ProviderRolePriority,
  RoutingPolicyState
} from "../routing/types.ts";
import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity
} from "../tools/types.ts";
import type {
  WorkspaceCatalogStatus,
  WorkspaceEntry
} from "../workspaces/types.ts";

/** Typed response contracts exposed by the AutoDev Control API. */
export interface ControlApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/** Standard error envelope returned by a Control API mutation route. */
export interface ControlApiErrorEnvelope {
  readonly error: ControlApiError;
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
  readonly schema: "autodev-control-agent-detail-v2";
  readonly promptPath: string | null;
  readonly systemPrompt: string;
  /** Reusable reconciliation view shared with mutation responses. */
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

export interface ControlApiEnablement {
  readonly enabled: boolean;
  readonly mutable: boolean;
}

/** Live router evidence for one provider; absent when the router is not observed. */
export interface ControlApiProviderHealth {
  readonly cooldown: {
    readonly kind: string;
    readonly failureClass: string | null;
    readonly until: string;
    readonly resetsAt: string | null;
    readonly lastResortEligible: boolean;
  } | null;
  readonly failureStreak: number;
  readonly probeFailureStreak: number;
  readonly inFlightRequests: number;
  readonly activeAgents: number;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailure: {
    readonly at: string;
    readonly failureClass: string | null;
    readonly status: number | null;
  } | null;
}

/**
 * One provider's assignment for one of the four fixed roles.
 *
 * `priority` carries participation: `disabled` is a member of the enum rather
 * than a separate enablement flag, so a role cannot hold a priority and be
 * disabled at once. `model` is preserved even while disabled so re-enabling
 * restores the previous choice. `mutable` is false when the provider is
 * globally disabled, because a disabled provider's roles cannot be edited until
 * it is enabled again.
 */
export interface ControlApiProviderRoleAssignment {
  readonly priority: ProviderRolePriority;
  readonly model: string | null;
  readonly mutable: boolean;
  /** Convergence for this single role; `not-observed` until a write occurs. */
  readonly convergence: ReconciliationStatus;
}

/** Provider-wide concurrent-agent limits; `null` is the explicit Unlimited choice. */
export interface ControlApiProviderAgentLimits {
  readonly perSession: number | null;
  readonly acrossSessions: number | null;
}

export interface ControlApiProviderRecord {
  readonly id: string;
  readonly route: {
    readonly pattern: string;
    readonly baseUrl: string;
    readonly healthUrl: string | null;
  } | null;
  /** Credential presence only; the value never leaves Runtime. */
  readonly credential: {
    readonly envKey: string | null;
    readonly configured: boolean;
  };
  /**
   * Provider-level disable, independent of the per-role assignments below:
   * disabling suppresses the provider for every role while preserving its
   * priorities, models and limits.
   */
  readonly disabled: boolean;
  readonly roles: Readonly<
    Record<ProviderRole, ControlApiProviderRoleAssignment>
  >;
  /** Concurrent-agent limits for this provider, across every role. */
  readonly agentLimits: ControlApiProviderAgentLimits | null;
  /** Configured model per capability tier. */
  readonly models: readonly {
    readonly tier: string;
    readonly model: string;
  }[];
  /** 1-based priority group the provider occupies in each tier it serves. */
  readonly priorities: readonly {
    readonly tier: string;
    readonly group: number;
  }[];
  readonly orchestratorReasoningEffort: string | null;
  readonly health: ControlApiProviderHealth | null;
}

export interface ControlApiProvidersResponse {
  readonly schema: "autodev-control-providers-v2";
  readonly orchestratorTier: string;
  /** Ordered priority/fallback groups per capability tier. */
  readonly tiers: readonly {
    readonly tier: string;
    readonly groups: readonly (readonly string[])[];
  }[];
  readonly providers: readonly ControlApiProviderRecord[];
}

export interface ControlApiProviderRolePatchResponse {
  readonly schema: "autodev-control-provider-role-v3";
  readonly provider: string;
  readonly role: ProviderRole;
  readonly priority: ProviderRolePriority;
  readonly model: string | null;
  /** The assignment replaced, or null when the role had never been configured. */
  readonly previous: ControlApiProviderRoleAssignment | null;
  readonly actor: string;
  /** Reusable reconciliation view shared with read paths. */
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

/** Response of `PATCH /control/providers/:provider`. */
export interface ControlApiProviderEnabledPatchResponse {
  readonly schema: "autodev-control-provider-enabled-v1";
  readonly provider: string;
  readonly disabled: boolean;
  readonly previous: boolean;
  readonly actor: string;
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

/** Response of `PATCH /control/providers/:provider/limits`. */
export interface ControlApiProviderLimitsPatchResponse {
  readonly schema: "autodev-control-provider-limits-v1";
  readonly provider: string;
  readonly agentLimits: ControlApiProviderAgentLimits;
  readonly previous: ControlApiProviderAgentLimits | null;
  readonly actor: string;
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

export interface ControlApiModelRecord {
  readonly id: string;
  readonly provider: string;
  /** Capability tiers this provider serves with the model. */
  readonly tiers: readonly string[];
  readonly displayName: string | null;
  /**
   * Model enablement carries the same desired-vs-actual contract as a provider
   * role: both are mutable routing-policy toggles, so an operator asking "did my
   * change land?" gets the same evidence for both. `not-observed` until a write
   * has been recorded.
   */
  readonly enablement: ControlApiEnablement & {
    readonly convergence: ReconciliationStatus;
  };
}

export interface ControlApiModelsResponse {
  readonly schema: "autodev-control-models-v2";
  readonly source: string;
  readonly models: readonly ControlApiModelRecord[];
}

export interface ControlApiModelPatchResponse {
  readonly schema: "autodev-control-model-v1";
  readonly model: string;
  readonly enabled: boolean;
  readonly previous: boolean;
  readonly actor: string;
  /** Desired-vs-actual evidence and bounded history for the applied change. */
  readonly reconciliation: ReconciliationView;
}

export interface ControlApiMcpsResponse {
  readonly schema: "autodev-control-mcps-v1";
  readonly source: ".rulesync/mcp.jsonc";
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  readonly servers: readonly McpServerResource[];
}

export interface ControlApiToolsResponse {
  readonly schema: "autodev-control-tools-v2";
  readonly source: string;
  readonly readOnly: true;
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly totalTools: number | null;
  readonly tools: readonly ToolCatalogItem[];
  readonly usageLink: string;
}

export interface ControlApiSkillsResponse {
  readonly schema: "autodev-control-skills-v2";
  readonly source: string;
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly roles: readonly string[];
  }[];
  readonly unresolvedAssignments: readonly {
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
    readonly sandboxMode: SandboxMode;
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
        /**
         * MCP servers this role is permitted to reach, projected from the same
         * execution contract that backs `/control/agents`. Kept here so the
         * effective capability matrix is one authoritative join rather than a
         * value the Console has to guess.
         */
        readonly mcp: readonly string[];
        /** Skills this role is eligible for, from the execution contract. */
        readonly skills: readonly string[];
      }
    >
  >;
}

export interface ControlApiPromptsResponse {
  readonly schema: "autodev-control-prompts-v2";
  readonly source: string;
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  readonly totalCommands: number | null;
  readonly commands: readonly {
    readonly name: string;
    readonly path: string;
    readonly description?: string;
  }[];
  readonly rolePrompts: readonly {
    readonly role: string;
    readonly path: string;
  }[];
}

export interface ControlApiPromptDetailResponse {
  readonly schema: "autodev-control-prompt-detail-v4";
  readonly name: string;
  readonly type: "command" | "role";
  readonly source: string;
  readonly content: string;
  readonly preview: string;
  readonly revision: string;
  /** Bounded diff summary between the canonical and projected state. */
  readonly diff: ReconciliationDiff;
  /** Reusable reconciliation view shared with mutation responses. */
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

export interface ControlApiPromptVersionReference {
  readonly versionHash: string;
  readonly updatedAt: string;
}

export interface ControlApiPromptVersionsResponse {
  readonly schema: "autodev-control-prompt-versions-v1";
  readonly name: string;
  readonly status: "available" | "unavailable";
  readonly versions: readonly ControlApiPromptVersionReference[];
  readonly hasMore: boolean;
}

export interface ControlApiPromptVersionResponse {
  readonly schema: "autodev-control-prompt-version-v1";
  readonly name: string;
  readonly versionHash: string;
  readonly updatedAt: string;
  readonly content: string;
  readonly diff: string;
}

export interface ControlApiPromptCommandPatchRequest {
  readonly expectedRevision: string;
  readonly content: string;
}

export interface ControlApiPromptCommandPatchResponse {
  readonly schema: "autodev-control-prompt-command-patch-v2";
  readonly name: string;
  readonly revision: string;
  readonly changed: boolean;
  /** Bounded diff summary between the canonical and projected state. */
  readonly diff: ReconciliationDiff;
  /** Reusable reconciliation view shared with read paths. */
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
}

export interface ControlApiWorkspacesResponse {
  readonly schema: "autodev-control-workspaces-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly catalogStatus: WorkspaceCatalogStatus;
  readonly totalWorkspaces: number | null;
  readonly workspaces: readonly WorkspaceEntry[];
}

export interface ControlApiGithubResponse {
  readonly schema: "autodev-control-github-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly catalogStatus: GithubWorkflowCatalogStatus;
  readonly totalWorkflows: number | null;
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly runtimeFactsAvailable: boolean;
  readonly runtimeStatus: GithubActionsRuntimeStatus;
  readonly runtimeMessage: string | null;
  readonly repository: string | null;
  readonly stats: GithubActionsRunStats | null;
  readonly recentRuns: readonly GithubWorkflowRun[];
}

export interface ControlApiConcurrencyStatus {
  readonly scope?: string;
  readonly maxConcurrentThreadsPerSession?: number;
  readonly effectivePerSessionLimit?: number;
  readonly activeSubagentThreads?: number;
  readonly activeSessions?: number;
  readonly denials?: number;
  readonly denialsByReason?: Readonly<Record<string, number>>;
  readonly lastDenial?: {
    readonly requestId?: string;
    readonly role?: string;
    readonly requestedModel?: string;
    readonly reason?: string;
    readonly timestamp?: string;
  } | null;
}

export interface ControlApiRoutingResponse {
  readonly schema: "autodev-control-routing-v1";
  readonly runtime: RoutingPolicyState;
  readonly routes: readonly {
    readonly provider: string;
    readonly pattern: string;
    readonly baseUrl: string;
  }[];
  readonly cooldowns: Readonly<Record<string, unknown>>;
  readonly concurrency?: ControlApiConcurrencyStatus;
}

export interface ControlApiRuntimeResponse {
  readonly schema: "autodev-control-runtime-v1";
  readonly routerInstanceId: string;
  /**
   * Every field here is emitted on every response by `getLifecycleStatus()`;
   * none is conditional. Declaring the extras optional let the Console read a
   * missing one as "no evidence" when the Runtime had in fact always reported
   * it, which is how a required field quietly became a guess.
   */
  readonly lifecycle: {
    readonly state: string;
    readonly draining: boolean;
    readonly changedAt: string;
    readonly activeResponseRequests: number;
  };
  /**
   * The same concurrency projection `/control/routing` carries. It was
   * previously declared as `{ limit, active } & ControlApiConcurrencyStatus`,
   * but the Runtime emits no such fields: the real names are
   * `effectivePerSessionLimit` and `activeSubagentThreads`. That fiction made
   * the Console read two always-undefined properties and fall through to a
   * hardcoded zero while the evidence it wanted was in the response.
   */
  readonly concurrency: ControlApiConcurrencyStatus;
  readonly inFlightRequestCount: number;
}

export interface ControlApiEvaluationsResponse {
  readonly schema: "autodev-control-evaluations-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalEvaluations: number;
  readonly evaluations: readonly EvaluationResult[];
}

/**
 * Paged Memory collection envelope. The wire field is `total` (not
 * `totalCount`) and there is no `hasMore` flag: the Runtime forwards
 * `MemoryService`'s `MemoryPage<T>` verbatim, and pagination state is derived
 * from `total`/`limit`/`offset` by the consumer. Naming these fields anything
 * else made the Console read `undefined` totals and render "0 of undefined".
 */
export interface ControlApiMemoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type ControlApiMemoryRecordsResponse =
  ControlApiMemoryPage<MemoryRecord> & {
    readonly schema: "autodev-memory-records-v1";
  };

export type ControlApiMemoryExperiencesResponse =
  ControlApiMemoryPage<ExperienceEnvelope> & {
    readonly schema: "autodev-memory-experiences-v1";
  };

export interface ControlApiMemoryRecordDetailResponse {
  readonly schema: "autodev-memory-record-v1";
  readonly memory: MemoryRecord;
}

export interface ControlApiMemoryHistoryResponse {
  readonly schema: "autodev-memory-history-v1";
  readonly memory: MemoryRecord;
  readonly transitions: readonly {
    readonly fromStatus?: MemoryStatus;
    readonly toStatus: MemoryStatus;
    readonly actor: MemoryActor;
    readonly reason?: string;
    readonly timestamp: string;
  }[];
}

export interface ControlApiMemoryExperienceDetailResponse {
  readonly schema: "autodev-memory-experience-v1";
  readonly experience: ExperienceEnvelope;
}

export type ControlApiMemoryCohortsResponse = MemorySessionOutcomeCohortPage;
export type ControlApiMemoryUseCohortsResponse = MemoryInjectionUseCohortPage;
