import type {
  EvaluationCaseMatrix,
  EvaluationCriterionType,
  EvaluationDefinition,
  EvaluationDefinitionCatalogStatus,
  EvaluationDefinitionValidation,
  EvaluationResult,
  EvaluationResultsFilter,
  EvaluationRunSummary,
  EvaluationTargetComparison,
  EvaluationTraceSpan
} from "../evaluations/types.ts";
import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowCatalogStatus,
  GithubWorkflowDefinition,
  GithubWorkflowMutationResult,
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
import type { ToolCatalogItem } from "../tools/types.ts";
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
  readonly source: ".rulesync/mcp.jsonc";
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  readonly servers: readonly McpServerResource[];
}

export interface ControlApiToolsResponse {
  readonly schema: "autodev-control-tools-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly coverage: "partial" | "unknown";
  readonly totalTools: number | null;
  readonly tools: readonly ToolCatalogItem[];
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
  /**
   * True when the Runtime Control API has validated every precondition
   * required to compute authoritative mutation operations for this actor:
   * a confirmed operator role, a validated enabled workspace with
   * observed GitHub Actions runtime facts, and write-token presence.
   * False means every workflow's `allowedOperations` is empty and the
   * Console must render no mutation affordances.
   */
  readonly operationsAvailable: boolean;
}

export type ControlApiGithubMutationResponse = GithubWorkflowMutationResult;

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
  readonly concurrency?: ControlApiConcurrencyStatus;
}

export interface ControlApiRuntimeResponse {
  readonly schema: "autodev-control-runtime-v1";
  readonly routerInstanceId: string;
  readonly lifecycle: {
    readonly state: string;
    readonly draining?: boolean;
    readonly changedAt?: string;
    readonly activeResponseRequests?: number;
  };
  readonly concurrency: {
    readonly limit: number;
    readonly active: number;
  } & ControlApiConcurrencyStatus;
  readonly inFlightRequestCount: number;
}

export const CONTROL_API_EVALUATIONS_SCHEMA = "autodev-control-evaluations-v2";
export const CONTROL_API_EVALUATION_DETAIL_SCHEMA =
  "autodev-control-evaluation-v2";
export const CONTROL_API_EVALUATION_RESULT_SCHEMA =
  "autodev-control-evaluation-result-v2";

/** Availability of the OpenLIT evaluation result store for one read. */
export type EvaluationResultsStatus = "available" | "unavailable";

export interface ControlApiEvaluationDefinitionRecord {
  readonly definition: EvaluationDefinition;
  /** Content revision used for optimistic concurrency on writes. */
  readonly revision: string;
  readonly validation: EvaluationDefinitionValidation;
  /** Latest stored or in-process run; null when none was observed. */
  readonly latestRun: EvaluationRunSummary | null;
}

export interface ControlApiEvaluationsResponse {
  readonly schema: typeof CONTROL_API_EVALUATIONS_SCHEMA;
  readonly definitionsSource: "config/evaluations.json";
  readonly catalogStatus: EvaluationDefinitionCatalogStatus;
  readonly catalogErrors: readonly string[];
  readonly definitions: readonly ControlApiEvaluationDefinitionRecord[];
  readonly criterionTypes: readonly EvaluationCriterionType[];
  readonly resultsSource: "openlit_evaluation";
  readonly resultsStatus: EvaluationResultsStatus;
  readonly resultsMessage: string | null;
  readonly filter: EvaluationResultsFilter;
  readonly results: readonly EvaluationResult[];
  readonly runs: readonly EvaluationRunSummary[];
}

export interface ControlApiEvaluationDetailResponse {
  readonly schema: typeof CONTROL_API_EVALUATION_DETAIL_SCHEMA;
  readonly definition: EvaluationDefinition;
  readonly revision: string;
  readonly validation: EvaluationDefinitionValidation;
  readonly resultsStatus: EvaluationResultsStatus;
  readonly resultsMessage: string | null;
  readonly runs: readonly EvaluationRunSummary[];
  /** Run whose results, comparisons, and case matrix are returned. */
  readonly selectedRunId: string | null;
  readonly comparisons: readonly EvaluationTargetComparison[];
  readonly caseMatrix: EvaluationCaseMatrix | null;
  readonly results: readonly EvaluationResult[];
}

export interface ControlApiEvaluationResultResponse {
  readonly schema: typeof CONTROL_API_EVALUATION_RESULT_SCHEMA;
  readonly result: EvaluationResult;
  /** `not_observed` when the result has no trace id or no exported spans. */
  readonly traceStatus: "available" | "not_observed" | "unavailable";
  readonly traceMessage: string | null;
  readonly spans: readonly EvaluationTraceSpan[];
}

/** Body of `PUT /control/evaluations/{id}`. */
export interface EvaluationDefinitionWriteRequest {
  readonly definition: EvaluationDefinition;
  /** Revision the operator edited; null when creating a new definition. */
  readonly expectedRevision: string | null;
}

/** Body of `DELETE /control/evaluations/{id}`. */
export interface EvaluationDefinitionDeleteRequest {
  readonly expectedRevision: string;
}

export interface ControlApiEvaluationDefinitionWriteResponse {
  readonly schema: "autodev-control-evaluation-definition-v1";
  readonly result: "created" | "updated" | "deleted";
  readonly definitionId: string;
  /** New revision; null after a delete. */
  readonly revision: string | null;
}

/** Body of `POST /control/evaluations/{id}/runs`. */
export interface EvaluationRunRequest {
  readonly idempotencyKey: string;
}

export interface ControlApiEvaluationRunResponse {
  readonly schema: "autodev-control-evaluation-run-v1";
  readonly result: "accepted" | "replayed";
  readonly run: EvaluationRunSummary;
}

export interface ControlApiMemoryRecordsResponse {
  readonly schema: "autodev-memory-records-v1";
  readonly items: readonly MemoryRecord[];
  readonly totalCount: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

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

export interface ControlApiMemoryExperiencesResponse {
  readonly schema: "autodev-memory-experiences-v1";
  readonly items: readonly ExperienceEnvelope[];
  readonly totalCount: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

export interface ControlApiMemoryExperienceDetailResponse {
  readonly schema: "autodev-memory-experience-v1";
  readonly experience: ExperienceEnvelope;
}

export type ControlApiMemoryCohortsResponse = MemorySessionOutcomeCohortPage;
export type ControlApiMemoryUseCohortsResponse = MemoryInjectionUseCohortPage;
