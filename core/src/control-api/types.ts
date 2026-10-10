import type { EvaluationResult } from "../evaluations/types.ts";
import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowCatalogStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "../github/types.ts";
import type {
  McpServerResource,
  RuleSyncValidationIssue
} from "../mcps/types.ts";
import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryLifecycleEvent,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  MemoryStatusCounts
} from "../memory/types.ts";
import type { SandboxMode } from "../permissions/types.ts";
import type {
  HumanPlaytestStudy,
  PlaytestBatch,
  PlaytestBenchmark,
  PlaytestEpisode,
  PlaytestExperiment,
  PlaytestSessionReview
} from "../playtesting/artifacts.ts";
import type { PlaytestJsonValue } from "../playtesting/protocol-types.ts";
import type {
  PlaytestComparison,
  PlaytestFinding
} from "../playtesting/types.ts";
import type {
  OperationHistoryEntry,
  ReconciliationDiff,
  ReconciliationStatus,
  ReconciliationView
} from "../reconciliation/types.ts";
import type {
  ProviderRole,
  ProviderRoleAssignment,
  ProviderRolePriority,
  RoutingPolicyState
} from "../routing/types.ts";
import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity
} from "../tools/types.ts";
import type { WorkspacePlaytestApproval } from "../workspaces/playtesting.ts";
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

/**
 * The provider's own external pages, from its routing-config `links`; `null`
 * when that provider configures no such page.
 */
export interface ControlApiProviderLinks {
  /** The provider's account usage/billing page. */
  readonly usage: string | null;
  /** The provider's documentation. */
  readonly documentation: string | null;
}

export interface ControlApiProviderRecord {
  readonly id: string;
  readonly links: ControlApiProviderLinks;
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
  /**
   * The assignment replaced, or null when the role had never been configured.
   *
   * The routing policy's own assignment rather than
   * `ControlApiProviderRoleAssignment`: `mutable` and `convergence` describe how
   * the current view should treat a role, and a past assignment is neither
   * mutable now nor converging. Reading them off `previous` would have required
   * the route to invent them.
   */
  readonly previous: ProviderRoleAssignment | null;
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
  /**
   * Why the source is invalid; empty when it is valid or was not observed.
   *
   * Required rather than optional so `valid: false` cannot arrive alone. The
   * loader knows which server declaration, or which target's override of which
   * server, it could not apply.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
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
  /**
   * Why the canonical catalog is invalid; empty when valid or not observed.
   *
   * Required rather than optional so `valid: false` cannot arrive alone. The
   * loader distinguishes a symlinked skill directory, an unusable directory
   * name, a missing SKILL.md, absent or invalid frontmatter, and frontmatter that
   * names a different skill -- six faults that shared one flag.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
  /**
   * Digest of the execution contract that backs role assignment, or `null`
   * when no contract file was found.
   *
   * It is carried on the collection rather than per-skill because it is a
   * property of the contract, not of any skill: every row in one render was
   * written against the same revision. An assignment form needs it to detect a
   * concurrent write, and fetching it per skill would mean one request per row
   * to hand a page what it already knows. `null` is a distinct third state --
   * it means "no contract exists", not "revision zero" -- so a Console that
   * cannot tell them apart does not offer the form at all.
   */
  readonly executionContractRevision: string | null;
  /**
   * Roles an assignment form may offer, from the same contract as the revision.
   *
   * Taken from the contract rather than from `/control/agents` because the
   * contract is what the write edits and what decides validity: a role that is
   * not listed here would be refused, so offering it would be offering a
   * submission that cannot succeed.
   */
  readonly assignmentRoles: readonly string[];
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

/**
 * Assigns a skill to exactly the roles named.
 *
 * A complete desired set rather than an addition, so unassigning is the same
 * call with an empty list and there is no second verb to get wrong. The
 * revision is the contract's own digest, because the failure this guards
 * against is two operators assigning at once: last-writer-wins would discard
 * the first assignment and leave both of them believing theirs took.
 */
export interface ControlApiSkillRolesPatchRequest {
  readonly expectedRevision: string;
  readonly roles: readonly string[];
}

export interface ControlApiSkillRolesPatchResponse {
  readonly schema: "autodev-control-skill-assignment-v1";
  readonly skill: string;
  /**
   * Roles as read back after the write, not as requested. The Runtime
   * re-reads the contract to confirm, and reporting the requested set would
   * hide the case where the file was changed underneath the write.
   */
  readonly roles: readonly string[];
  readonly revision: string;
}

/**
 * One reason a canonical source could not be applied.
 *
 * `location` names the part at fault in the terms the operator is looking at --
 * an event name, an action index, or a source line -- and `message` says what is
 * wrong with it.
 */
export interface ControlApiValidationIssue {
  readonly location: string;
  readonly message: string;
}

export interface ControlApiHooksResponse {
  readonly schema: "autodev-control-hooks-v1";
  readonly source: string;
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  /**
   * Why the source is invalid; empty when it is valid or was not observed.
   *
   * Required rather than optional so `valid: false` can never arrive alone. A
   * loader that has already located the fault and reports only the boolean
   * leaves the operator to re-find what the system read in a single pass.
   */
  readonly issues: readonly ControlApiValidationIssue[];
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
        /**
         * Which tools of which MCP server this role may call.
         *
         * Kept alongside the server list rather than folded into it: the
         * execution contract grants both separately, and a projection that
         * carried only the servers would say a role reaches `lsp` without
         * saying which of its tools, which reads as unrestricted.
         */
        readonly mcpTools: Readonly<Record<string, readonly string[]>>;
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
  /** Why the catalog is invalid; empty when valid or not observed. */
  readonly issues: readonly RuleSyncValidationIssue[];
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
  /**
   * `null` means no per-session limit is configured, which is the default.
   *
   * Not optional-and-not-nullable because "unlimited" is an observed fact about
   * this deployment, not a missing field: the Runtime's own status CLI prints it
   * as `unlimited`, and collapsing it to `undefined` here would make a router
   * that deliberately runs without a limit indistinguishable from one whose
   * limit was never read.
   */
  readonly maxConcurrentThreadsPerSession?: number | null;
  readonly effectivePerSessionLimit?: number | null;
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
    /**
     * The Runtime's own `RouterLifecycleState`. Declared here as the union it
     * already is, rather than as the `string` it used to be: the Console renders
     * this value as the operator-facing word on a status badge, so widening it
     * to `string` let any new state appear verbatim — which is how `/agents`
     * came to read a lowercase `ready` beside a `Ready` three rows away. A
     * closed union is what forces the Runtime and the Console to agree on the
     * vocabulary rather than leaving the reader to spot the drift.
     */
    readonly state: "ready" | "draining";
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
  /**
   * Every evaluation row the source holds.
   *
   * This is not `evaluations.length`. The read is capped, so the array is the
   * most recent N results while this is how many exist -- and a consumer that
   * derived a total from the array would report the cap as the size of the
   * store.
   */
  readonly totalEvaluations: number;
  /**
   * Whether `evaluations` is a bounded window rather than the whole table.
   *
   * Required rather than inferred. A consumer can compare `totalEvaluations`
   * against `evaluations.length` itself, and every such comparison is a place to
   * forget it and render a capped window as the complete history.
   */
  readonly truncated: boolean;
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

/**
 * The Memory record action request contract shared by Runtime and Console.
 * Runtime enforces these key sets; Console shapes requests from the same types.
 */
/** Field value types used by the accepted Memory action-body key sets below. */
interface ControlApiMemoryRecordActionFields {
  readonly task: string;
  readonly query: string;
  readonly taskId?: string;
  readonly relevantPaths?: readonly string[];
  readonly evidence: readonly {
    readonly kind: string;
    readonly uri: string;
    readonly revision?: string;
  }[];
  readonly reasonCode?: string;
  readonly claim: string;
  readonly experienceIds: readonly string[];
  readonly priorId: string;
  readonly skillName: string;
  readonly description: string;
  readonly content: string;
}

export const CONTROL_API_MEMORY_RESEARCH_BODY_KEYS = [
  "task",
  "query",
  "taskId",
  "relevantPaths"
] as const;

export const CONTROL_API_MEMORY_RECORD_ACTION_BODY_KEYS = {
  verify: CONTROL_API_MEMORY_RESEARCH_BODY_KEYS,
  invalidate: ["evidence", "reasonCode"],
  revise: ["claim", "experienceIds", "evidence"],
  supersede: ["priorId", ...CONTROL_API_MEMORY_RESEARCH_BODY_KEYS],
  "promote-skill": [
    "skillName",
    "description",
    "content",
    ...CONTROL_API_MEMORY_RESEARCH_BODY_KEYS
  ]
} as const satisfies Readonly<
  Record<string, readonly (keyof ControlApiMemoryRecordActionFields)[]>
>;

export type ControlApiMemoryRecordAction =
  keyof typeof CONTROL_API_MEMORY_RECORD_ACTION_BODY_KEYS;

export type ControlApiMemoryRecordTransitionAction = Exclude<
  ControlApiMemoryRecordAction,
  "promote-skill"
>;

export type ControlApiMemoryRecordActionBody<
  Action extends ControlApiMemoryRecordAction
> = Action extends ControlApiMemoryRecordAction
  ? Pick<
      ControlApiMemoryRecordActionFields,
      (typeof CONTROL_API_MEMORY_RECORD_ACTION_BODY_KEYS)[Action][number]
    >
  : never;

/** Console client input; workspaceId is encoded in the query, not the JSON body. */
export type ControlApiMemoryRecordActionPayload<
  Action extends ControlApiMemoryRecordAction = ControlApiMemoryRecordAction
> = Action extends ControlApiMemoryRecordAction
  ? { readonly workspaceId: string } & ControlApiMemoryRecordActionBody<Action>
  : never;

export type ControlApiMemoryRecordsResponse =
  ControlApiMemoryPage<MemoryRecord> & {
    readonly schema: "autodev-memory-records-v1";
    /**
     * The lifecycle breakdown of the filtered collection, not of this page.
     *
     * Published because the Console cannot derive it: the page is a window the
     * reader chose, so counting active claims off the rows on it reports at most
     * `limit` of them beside a `total` of 1,204 and reads as a share. Every
     * status is present, zeros included.
     */
    readonly statusCounts: MemoryStatusCounts;
  };

export type ControlApiMemoryExperiencesResponse =
  ControlApiMemoryPage<ExperienceEnvelope> & {
    readonly schema: "autodev-memory-experiences-v1";
  };

/** The Control API projection for a reporter-supplied session outcome. */
export interface ControlApiMemorySessionOutcomeReportResponse {
  readonly schema: "autodev-memory-session-outcome-report-v1";
  readonly experienceId: string;
  readonly report: {
    readonly outcomeKind: string;
    readonly reportKind: string;
    readonly reporterId: string;
    readonly reportedAt: string;
    readonly reasonCode: string;
    readonly evidence: readonly {
      readonly kind: string;
      readonly uri: string;
    }[];
  };
}

/**
 * Whether durable memory storage is connected on this Runtime.
 *
 * Three states, and the point of separating them is that they are three
 * different operator problems. Every `/control/memory/*` read answers the same
 * `503 autodev_memory_unavailable` when the store is not configured *and* when
 * it is configured but unreachable, so a Console reading them in isolation
 * cannot tell "nobody has set this up" from "this is down", and neither from
 * "there is nothing stored yet". An operator diagnosing a memory surface has to
 * be able to tell those apart without leaving the Console.
 *
 * `not_configured` and `unreachable` are deliberately not merged: the first is
 * fixed by setting `AUTODEV_MEMORY_DATABASE_URL`, the second by whatever is
 * wrong with the database behind it. One remedy each, and reporting the wrong one
 * sends the reader to the wrong place.
 */
export type ControlApiMemoryStorageState =
  "not_configured" | "unreachable" | "reachable";

export interface ControlApiMemoryStatusResponse {
  readonly schema: "autodev-memory-status-v1";
  readonly storage: {
    readonly state: ControlApiMemoryStorageState;
    readonly backend: "postgresql";
    /**
     * Whether an embedding provider is configured. Memory capture needs one, so
     * a connected store with no embeddings stores records it cannot retrieve
     * with -- a configuration the operator has to see, and one no read failure
     * would ever name.
     */
    readonly embeddings: "not_configured" | "configured";
    /**
     * The bound probe's own deadline, in milliseconds. Reported so a reader can
     * tell "answered in time and said unreachable" from "answered eventually",
     * which is the difference between a database that is down and one that is
     * merely slow.
     */
    readonly probeTimeoutMs: number;
  };
}

export interface ControlApiMemoryRecordDetailResponse {
  readonly schema: "autodev-memory-record-v1";
  readonly memory: MemoryRecord;
}

/**
 * One record's lifecycle, as the Console's Transition History panel reads it.
 *
 * `transitions` carries `MemoryLifecycleEvent` unchanged rather than a second
 * spelling of it. The panel previously declared its own `{ actor, timestamp,
 * reason }` row, and the route emitted the repository's `{ actorId, occurredAt,
 * reasonCode, evidence }` event instead -- two shapes for one fact, so the
 * panel could never render: the Console refused the response as unreadable and
 * the record detail page failed to open at all.
 *
 * `reasonCode` in particular is the only field that says *why* a claim stopped
 * being trustworthy, and a free-text `reason` the producer never set is how that
 * answer went missing.
 */
export interface ControlApiMemoryHistoryResponse {
  readonly schema: "autodev-memory-history-v1";
  readonly memory: MemoryRecord;
  readonly relatedMemories: readonly MemoryRecord[];
  readonly transitions: readonly MemoryLifecycleEvent[];
}

export interface ControlApiMemoryExperienceDetailResponse {
  readonly schema: "autodev-memory-experience-v1";
  readonly experience: ExperienceEnvelope;
}

/**
 * The Runtime's eligibility-bounded explanation of one record.
 *
 * This is not the same answer as `provenance.experienceIds`. A record cites the
 * experiences it was derived from; `why` returns the ones this reader can
 * *currently* resolve, plus the records it supersedes or is superseded by. The
 * two sets differ whenever a cited experience has fallen outside the caller's
 * scope, and that difference is the interesting part -- a record whose sources
 * cannot be shown is not the same as one that has no sources.
 *
 * `sourceExperiences` is therefore allowed to be shorter than the citation list,
 * and the Console reports the gap rather than presenting the shorter list as
 * though it were the whole truth.
 */
export interface ControlApiMemoryWhyResponse {
  readonly schema: "autodev-memory-why-v1";
  readonly memory: MemoryRecord;
  readonly relatedMemories: readonly MemoryRecord[];
  readonly sourceExperiences: readonly ExperienceEnvelope[];
}

export type ControlApiMemoryCohortsResponse = MemorySessionOutcomeCohortPage;
export type ControlApiMemoryUseCohortsResponse = MemoryInjectionUseCohortPage;

/**
 * What the Runtime observed, and what a reporter separately claimed, for one
 * stored injection.
 *
 * These are three different kinds of claim and the wire keeps them apart on
 * purpose. `injection` is observed by the runtime that attached the packet.
 * `outcome` is a reporter's statement about the task, and is null until one
 * exists — null means *unreported*, never *failed*. `sessionInjectionCount`
 * says how many injections the session produced and is not evidence that any of
 * them were read.
 *
 * Collapsing an unreported outcome into a failed one, or presenting the three
 * as one verdict, is what turns absent evidence into a false conclusion, so the
 * Console renders them as separate classes rather than a single status.
 */
export interface ControlApiMemoryInjectionOutcomeJoin {
  readonly injection: {
    readonly id: string;
    /**
     * The key a reporter-supplied outcome for *this* injection binds to.
     *
     * Content-free by design -- it never enters a prompt or a metric -- and
     * safe for an operator interface to carry, because
     * `MemoryService.recordOutcomeReport` resolves it against the reporter's
     * trusted session scope and rejects a token that matches no injection there.
     * A report is therefore always bound to an injection the reporter could
     * legitimately see, and a wrong token fails closed rather than mis-binding.
     */
    readonly correlationToken: string;
    readonly memoryMode: string;
    readonly injectionResult: string;
    readonly packetCharacterCount: number;
    readonly memoryIds: readonly string[];
    readonly occurredAt: string;
  };
  readonly outcome: {
    readonly outcomeKind: string;
    readonly reportKind: string;
    readonly reportedAt: string;
    readonly reporterId: string;
    readonly reporterAuthority: string;
    readonly reasonCode: string;
  } | null;
  readonly sessionInjectionCount: number;
}

export type ControlApiMemoryInjectionOutcomesResponse =
  ControlApiMemoryPage<ControlApiMemoryInjectionOutcomeJoin> & {
    readonly schema: "autodev-memory-injection-outcomes-v1";
    readonly experienceId: string;
  };

/**
 * A curator's assessment of whether an actually-injected packet was used.
 *
 * Same discipline as the outcome join: `use` is null until a curator has
 * assessed, and `unobservable` is a distinct verdict from `not_used` — one says
 * nobody could tell, the other says nobody saw it used.
 *
 * This row is deliberately *not* the outcome join's injection with fields
 * removed, and it is worth saying why rather than leaving the difference to be
 * discovered. The outcome join carries `correlationToken` because a reporter
 * needs it to bind a new outcome to an injection. This read has no such caller:
 * it answers "was this packet used?", and withholding the token keeps the read
 * from being a capability to address any injection in the workspace. So the
 * token is absent here by design, not by omission — which is why the declaration
 * must not simply mirror its sibling's.
 *
 * `use.evidence` is included even though it is not in the outcome join: a
 * curator reading an assessment is deciding on the basis of what was observed,
 * and the evidence is the observation. It arrives sanitized by the service.
 */
export interface ControlApiMemoryInjectionUseAssessment {
  readonly injection: {
    readonly id: string;
    readonly memoryMode: string;
    readonly injectionResult: string;
    readonly packetCharacterCount: number;
    readonly memoryIds: readonly string[];
    readonly occurredAt: string;
  };
  readonly use: {
    readonly useKind: string;
    readonly usedMemoryIds: readonly string[];
    readonly reportedAt: string;
    readonly evidence: readonly EvidenceReference[];
  } | null;
  readonly sessionInjectionCount: number;
}

export type ControlApiMemoryInjectionUseAssessmentsResponse =
  ControlApiMemoryPage<ControlApiMemoryInjectionUseAssessment> & {
    readonly schema: "autodev-memory-injection-use-assessments-v1";
    readonly experienceId: string;
  };

/** Runtime run state surfaced by authenticated Playtesting actions. */
export type ControlApiPlaytestingRunState =
  "running" | "persisting" | "completed" | "failed" | "cancelled";

export type ControlApiPlaytestingCancellationReason =
  "cancelled" | "approval-revoked" | "workspace-disabled";

export interface ControlApiPlaytestingRunRecord {
  readonly batchId: string;
  readonly status: ControlApiPlaytestingRunState;
  readonly cancellationReason: ControlApiPlaytestingCancellationReason | null;
  readonly result: PlaytestJsonValue | null;
  readonly error: {
    readonly code: string;
    readonly category: string;
    readonly retryable: boolean;
    readonly message: string;
  } | null;
}

/** Safe run-form preview; raw command, checkout path, and image are omitted. */
export interface ControlApiPlaytestingCapabilitiesResponse {
  readonly schema: "autodev-control-playtesting-capabilities-v1";
  readonly workspaceId: string;
  readonly workspaceCatalog: "valid" | "invalid" | "unavailable";
  readonly workspaceEnabled: boolean;
  readonly operatorActionsAvailable: boolean;
  readonly approved: boolean;
  readonly approvalRevision: number | null;
  readonly buildSha: string | null;
  readonly gameBuild: string | null;
  readonly allowedScenarios: readonly string[];
  readonly approvedPolicies: readonly string[];
  readonly supportedPolicies: readonly string[];
  readonly runnablePolicies: readonly string[];
  readonly unsupportedApprovedPolicies: readonly string[];
  readonly configurationStatus: "validated" | "invalid" | "not-checked";
  readonly runnableAssignments: readonly {
    readonly scenarioId: string;
    readonly scenarioFamily: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly cohort: string;
    readonly strategy: string;
    readonly maxStepsPerEpisode: number;
  }[];
  readonly policyProfiles: readonly {
    readonly policyId: string;
    readonly version: string;
    readonly cohort: string;
    readonly strategy: string;
  }[];
  readonly limits: WorkspacePlaytestApproval["limits"] | null;
  readonly issueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
  readonly revokedAt: string | null;
  readonly runPreflight: "required-at-start";
}

/** Typed active-run response; Data remains the authoritative batch history. */
export interface ControlApiPlaytestingActiveRunsResponse {
  readonly schema: "autodev-control-playtesting-runs-v1";
  readonly workspaceId: string;
  readonly runs: readonly {
    readonly batchId: string;
    readonly scenarioId: string;
    readonly createdAt: string;
  }[];
}

/** One typed approved run request; never carries a command or executable path. */
export interface ControlApiPlaytestingRunRequest {
  readonly workspaceId: string;
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly goal?: string;
  readonly maxSteps?: number;
}

/** Typed run-start acknowledgement; completion is read from the run route. */
export interface ControlApiPlaytestingRunStartedResponse {
  readonly schema: "autodev-control-playtesting-run-started-v1";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly status: "running";
}

/** Typed status response; a null result while active means still running. */
export interface ControlApiPlaytestingRunStatusResponse {
  readonly schema: "autodev-control-playtesting-run-status-v1";
  readonly workspaceId: string;
  readonly run: ControlApiPlaytestingRunRecord;
}

/** Confirmation that the operator is cancelling a currently running assignment. */
export interface ControlApiPlaytestingRunCancellationRequest {
  readonly expectedStatus: "running";
}

/** Explicit acknowledgement that cancellation was requested, not rollback. */
export interface ControlApiPlaytestingRunCancellationResponse {
  readonly schema: "autodev-control-playtesting-run-cancellation-v1";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly cancellationRequested: boolean;
}

/** Aggregated, suppression-aware human-study read; raw responses never cross this boundary. */
export interface ControlApiPlaytestingHumanValidationResponse {
  readonly schema: "autodev-control-playtesting-human-validation-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly buildSha: string;
  readonly summary: {
    readonly revision: number;
    readonly benchmarkId: string | null;
    readonly instrument: string;
    readonly measurementVersion: string;
    readonly suppressionState:
      "suppressed" | "partially-suppressed" | "unsuppressed";
    readonly retainedParticipants: number | null;
    readonly items: readonly {
      readonly itemId: string;
      readonly suppressionState:
        "suppressed" | "partially-suppressed" | "unsuppressed";
      readonly mean: number | null;
      readonly respondentCount: number | null;
      readonly missingCount: number | null;
      readonly categoryCounts: Readonly<Record<string, number | null>> | null;
      readonly unit: string;
    }[];
    readonly constructs: readonly {
      readonly constructId: string;
      readonly suppressionState:
        "suppressed" | "partially-suppressed" | "unsuppressed";
      readonly mean: number | null;
      readonly respondentCount: number | null;
      readonly missingCount: number | null;
      readonly unit: string;
    }[];
    readonly pairedDifferences: readonly {
      readonly itemId: string;
      readonly suppressionState: "suppressed" | "unsuppressed";
      readonly pairedParticipants: number | null;
      readonly meanDifference: number | null;
    }[];
  } | null;
}

/** Import response exposes only reason counts and suppression-aware totals. */
export interface ControlApiPlaytestingHumanImportResponse {
  readonly schema: "autodev-control-playtesting-human-import-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly acceptedCount: number;
  readonly unchangedCount: number;
  readonly rejectedCount: number;
  readonly rejectedByReason: Readonly<Record<string, number>>;
  readonly quarantinedCount: number;
  readonly retainedParticipants: number | null;
}

/** Consent registration acknowledgement omits participant pseudonyms. */
export interface ControlApiPlaytestingHumanConsentResponse {
  readonly schema: "autodev-control-playtesting-human-consent-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly recorded: true;
}

/** Withdrawal acknowledgement contains no participant identity. */
export interface ControlApiPlaytestingHumanWithdrawalResponse {
  readonly schema: "autodev-control-playtesting-human-withdrawal-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly retainedParticipants: number | null;
}

/** Quarantine read for an authorized operator; participant IDs are omitted. */
export interface ControlApiPlaytestingHumanQuarantinesResponse {
  readonly schema: "autodev-control-playtesting-human-quarantines-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly quarantines: readonly {
    readonly responseIds: readonly string[];
    readonly instrument: string;
    readonly reason: "duplicate-participant-episode-instrument";
  }[];
}

/** Registration acknowledgement for an operator-approved study manifest. */
export interface ControlApiPlaytestingHumanStudyRegistrationResponse {
  readonly schema: "autodev-control-playtesting-human-study-registration-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly benchmarkId: string;
  readonly approved: true;
  readonly idempotent: boolean;
}

/** Resource names exposed by the authenticated Playtesting API. */
export const CONTROL_API_PLAYTESTING_RESOURCES = [
  "batches",
  "episodes",
  "findings",
  "comparisons",
  "benchmarks",
  "experiments",
  "human-studies"
] as const;
export type ControlApiPlaytestingResource =
  (typeof CONTROL_API_PLAYTESTING_RESOURCES)[number];

/** Data's keyset page carried across the authenticated Control API boundary. */
export interface ControlApiPlaytestingPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly nextCursor: string | null;
}

/** Typed read-only list response; missing/unavailable is an HTTP error, not an empty page. */
export interface ControlApiPlaytestingPageResponse<T> {
  readonly schema: "autodev-control-playtesting-page-v1";
  readonly workspaceId: string;
  readonly resource: ControlApiPlaytestingResource;
  readonly readOnly: true;
  readonly page: ControlApiPlaytestingPage<T>;
}

/** Workspace-bound selected episode and its newest append-only analyst review. */
export interface ControlApiPlaytestingEpisodeDetailResponse {
  readonly schema: "autodev-control-playtesting-detail-v1";
  readonly workspaceId: string;
  readonly resource: "episode";
  readonly readOnly: true;
  readonly record: PlaytestEpisode;
  readonly latestReview: PlaytestSessionReview | null;
}

/** Integrity-checked, workspace-bound bounded JSONL evidence window. */
export interface ControlApiPlaytestingWindowResponse {
  readonly schema: "autodev-control-playtesting-window-v1";
  readonly workspaceId: string;
  readonly episodeId: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly startStep: number;
  readonly endStep: number;
  readonly sourceLineCount: number;
  readonly omittedLineCount: number;
  readonly entries: readonly PlaytestJsonValue[];
}

/** Compile-time entity mapping for Console/server consumers. */
export type ControlApiPlaytestingEntityMap = {
  readonly batches: PlaytestBatch;
  readonly episodes: PlaytestEpisode;
  readonly findings: PlaytestFinding;
  readonly comparisons: PlaytestComparison;
  readonly benchmarks: PlaytestBenchmark;
  readonly experiments: PlaytestExperiment;
  readonly "human-studies": HumanPlaytestStudy;
};

/** Workspaces-owned operator approval; the response never contains local secret material. */
export interface ControlApiWorkspacePlaytestApprovalResponse {
  readonly schema: "autodev-control-workspace-playtest-approval-v1";
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly approval: WorkspacePlaytestApproval | null;
}
