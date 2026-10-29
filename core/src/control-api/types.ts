import type { AgentEnablementState } from "../agents/types.ts";
import type { EvaluationResult } from "../evaluations/types.ts";
import type {
  GithubActionsRunStats,
  GithubActionsRuntimeStatus,
  GithubWorkflowCatalogStatus,
  GithubWorkflowDefinition,
  GithubWorkflowRun
} from "../github/types.ts";
import type {
  HookAction,
  HookDeclarationOrigin,
  HookEvent
} from "../hooks/types.ts";
import type { McpServerResource } from "../mcps/types.ts";
import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryLifecycleEvent,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  MemoryStatusCounts
} from "../memory/types.ts";
import type { PermissionPolicy, SandboxMode } from "../permissions/types.ts";
import type {
  HumanPlaytestStudy,
  PlaytestBatch,
  PlaytestBatchCancellationReason,
  PlaytestBenchmark,
  PlaytestCrossSessionSynthesis,
  PlaytestDiscoverySessionReview,
  PlaytestEpisode,
  PlaytestEvidencePacket,
  PlaytestExperiment,
  PlaytestSessionReview
} from "../playtesting/artifacts.ts";
import type {
  PlaytestHumanPreferenceCounts,
  PlaytestPreferenceSensitivityDecision
} from "../playtesting/human-preference.ts";
import type {
  PlaytestArtifactReference,
  PlaytestJsonValue
} from "../playtesting/protocol-types.ts";
import type {
  PlaytestComparison,
  PlaytestEvidenceLocator,
  PlaytestFinding,
  PlaytestNumericInterval,
  PlaytestSessionReference
} from "../playtesting/types.ts";
import type { PlaytestVisualPolicyId } from "../playtesting/visual-decision.ts";
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
import type { SkillScope } from "../skills/scope.ts";
import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity
} from "../tools/types.ts";
import type { RuleSyncValidationIssue } from "../validation/types.ts";
import type { WorkspacePlaytestApproval } from "../workspaces/playtesting.ts";
import type {
  WorkspaceCatalogStatus,
  WorkspaceConfigurationHealth,
  WorkspaceEntry,
  WorkspaceRuntimeAvailability
} from "../workspaces/types.ts";
import type { WorkspaceVisualPlaytestTargetApproval } from "../workspaces/visual-playtesting.ts";

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
  readonly enablement: AgentEnablementState;
  readonly primaryModel: string;
  readonly allowedProviders: readonly string[];
  readonly mcps: readonly string[];
  readonly skills: readonly string[];
}

export interface ControlApiAgentsResponse {
  readonly schema: "autodev-control-agents-v2";
  readonly source: string;
  readonly readOnly: boolean;
  readonly totalAgents: number;
  readonly agents: readonly (ControlApiAgentRecord & {
    readonly hasPrompt: boolean;
  })[];
}

export interface ControlApiAgentDetailResponse extends ControlApiAgentRecord {
  readonly schema: "autodev-control-agent-detail-v3";
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

export interface ControlApiAgentEnablementPatchRequest {
  readonly enabled: boolean;
  readonly expectedRevision: string;
}

export interface ControlApiAgentEnablementPatchResponse {
  readonly schema: "autodev-control-agent-enablement-v1";
  readonly role: string;
  readonly enabled: boolean;
  readonly previous: boolean;
  readonly revision: string;
  readonly actor: string;
  readonly reconciliation: ReconciliationView;
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
  readonly reasoningEffort?: string | null;
  readonly effectiveReasoningEffort?: string | null;
  readonly reasoningEffortInForce?: boolean;
  readonly supportedReasoningLevels?: readonly string[];
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

/** One source-reported model and whether this Runtime can route it. */
export interface ControlApiDiscoveredProviderModel {
  readonly id: string;
  readonly displayName: string | null;
  readonly routeability:
    | { readonly status: "supported" }
    | { readonly status: "unsupported"; readonly reason: string };
}

/** Provider-owned model availability, kept separate from operator routing. */
export type ControlApiProviderModelDiscovery =
  | {
      readonly status: "observed";
      readonly source: string;
      readonly observedAt: string;
      readonly lastAttemptAt: string;
      readonly models: readonly ControlApiDiscoveredProviderModel[];
    }
  | {
      readonly status: "stale";
      readonly source: string;
      readonly observedAt: string;
      readonly lastAttemptAt: string;
      readonly reason: string;
      readonly models: readonly ControlApiDiscoveredProviderModel[];
    }
  | {
      readonly status: "unavailable";
      readonly source: string | null;
      readonly lastAttemptAt: string | null;
      readonly reason: string;
    };

export interface ControlApiProviderModelDiscoveryEntry {
  readonly provider: string;
  readonly discovery: ControlApiProviderModelDiscovery;
}

export interface ControlApiProviderModelsResponse {
  readonly schema: "autodev-control-provider-model-discovery-v1";
  readonly source: "runtime-provider-discovery";
  readonly providers: readonly ControlApiProviderModelDiscoveryEntry[];
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
  /**
   * Desired-vs-actual state for the provider as a whole, alongside the
   * per-role convergence above.
   *
   * The per-role convergence answers "has this role's assignment been
   * observed". This answers the provider's own question: whether the routing
   * configuration the operator set -- the provider's enablement, its agent
   * limits, and its role assignments together -- has been applied and observed
   * as one state. The Runtime derives it, so the Console renders the Runtime's
   * view rather than re-deriving a verdict of its own.
   */
  readonly reconciliation: ReconciliationView;
}

export interface ControlApiProvidersResponse {
  readonly schema: "autodev-control-providers-v3";
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
  readonly reasoningEffort?: string | null;
  readonly effectiveReasoningEffort?: string | null;
  readonly reasoningEffortInForce?: boolean;
  readonly supportedReasoningLevels?: readonly string[];
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

/** Exact body for the confirmation-bound provider overrides reset. */
export interface ControlApiProvidersResetRequest {
  readonly confirm: true;
}

/**
 * Response of `POST /control/providers/reset` -- the Providers page header's
 * confirmation-bound "Reset to defaults" operation.
 *
 * This clears only provider Runtime overrides (role assignments, provider
 * disables, model disables, and provider agent limits), returning routing to
 * the static `config/model-routing.json` defaults. Agent enablement, provider
 * discovery snapshots, cooldown/health state, and concurrency limits are
 * untouched -- none of them are provider routing overrides. Bounded counts
 * rather than the cleared state itself are reported, so the audit trail
 * proves the action's exact blast radius without replaying configuration.
 */
export interface ControlApiProvidersResetResponse {
  readonly schema: "autodev-control-providers-reset-v1";
  readonly actor: string;
  readonly cleared: {
    readonly roleAssignments: number;
    readonly disabledProviders: number;
    readonly disabledModels: number;
    readonly providerLimits: number;
  };
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
  readonly schema: "autodev-control-mcps-v2";
  readonly source: ".rulesync/mcp.jsonc";
  /**
   * The revision of the canonical declaration.
   *
   * The digest of the whole document, so it changes when any part of the
   * declaration changes. A write compares against it, so a write that was
   * decided on an older declaration is refused rather than applied over a
   * newer one. `null` when the declaration could not be read at all.
   */
  readonly revision: string | null;
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
  /**
   * The canonical declaration of every MCP server, and nothing else.
   *
   * This is a configuration read. It says what each server *is*; it says
   * nothing about whether the Runtime has reached it, and a server listed
   * here has not thereby been observed. The Runtime's observations live on
   * their own read path (`ControlApiMcpRuntimeResponse`) so that the
   * configuration stays a configuration read.
   */
  readonly servers: readonly McpServerResource[];
}

/**
 * The Runtime's health vocabulary for an MCP server.
 *
 * `ready` and `error` are verdicts. `configured` means the Runtime saw the
 * server named in a session but never exercised it, and `observed` means it
 * saw a span that carried no readiness signal -- neither is a correctness
 * claim. `stale` means the Runtime saw the server, but not recently enough to
 * call it ready.
 */
export type ControlApiMcpRuntimeHealth =
  "configured" | "ready" | "error" | "observed" | "stale";

/**
 * What the Runtime has observed of one MCP server.
 *
 * The declaration in `.rulesync/mcp.jsonc` says what the server *is*; this is
 * what the Runtime has *seen* of it. The two are different questions, and the
 * page has to keep them apart: a declared server is not a reached server, and
 * a server the Runtime has not observed is not a broken one.
 *
 * Every field is an observation the Runtime recorded, not a conclusion drawn
 * from the declaration.
 */
export interface ControlApiMcpRuntimeEvidence {
  /** The Runtime's health verdict for the server. */
  readonly health: ControlApiMcpRuntimeHealth;
  /** When the Runtime last saw the server. */
  readonly lastSeenAt: string | null;
  /** The status of the last observation, as the Runtime recorded it. */
  readonly lastStatus: string;
  /** How many times the Runtime has tried to initialize the server. */
  readonly initAttempts: number;
  /** How many times the Runtime has tried to discover the server's tools. */
  readonly toolDiscoveryAttempts: number;
  /** How many of the Runtime's attempts on this server failed. */
  readonly failures: number;
  /**
   * How many tool calls the Runtime has observed on this server.
   *
   * The count is of calls the Runtime saw, not of tools the server offers: a
   * server that was initialized but never called has no calls here.
   */
  readonly toolCalls: number;
  /** The mean duration of the server's observed calls, in milliseconds. */
  readonly averageDurationMs: number;
  /** The roles the Runtime has observed this server used from. */
  readonly roles: readonly {
    readonly role: string;
    readonly health: ControlApiMcpRuntimeHealth;
    readonly lastSeenAt: string | null;
    readonly lastStatus: string;
  }[];
  /**
   * The tools the Runtime has observed being called on this server.
   *
   * This is the set of tools that were *seen in use*, not the server's tool
   * inventory: a tool the server offers but nothing has called is absent, and
   * a tool the server no longer offers may still be listed. The page says so
   * rather than presenting the list as the server's live inventory.
   */
  readonly tools: readonly {
    readonly name: string;
    readonly count: number;
    readonly errors: number;
  }[];
}

/**
 * One MCP server as the Runtime has observed it.
 *
 * The observation carries the server's name so that the read can be joined
 * against the canonical declaration without the two paths having to be merged
 * into one payload.
 */
export interface ControlApiMcpRuntimeServer extends ControlApiMcpRuntimeEvidence {
  readonly name: string;
}

/**
 * How many observed servers sit in each health verdict.
 *
 * The Runtime owns this vocabulary and these counts, so the Console renders
 * them rather than counting the servers itself and arriving at a health
 * summary of its own.
 */
export interface ControlApiMcpRuntimeHealthCounts {
  readonly ready: number;
  readonly error: number;
  readonly stale: number;
  readonly configured: number;
  readonly observed: number;
}

/**
 * The Runtime's observation of the MCP servers it has seen.
 *
 * This is published on its own path rather than folded into the MCP catalog,
 * because the two answer different questions and the catalog is a
 * configuration read. A page composes them; the contract keeps them apart.
 */
export interface ControlApiMcpRuntimeResponse {
  readonly schema: "autodev-control-mcp-runtime-v1";
  /** Where the observations come from. */
  readonly source: string;
  /**
   * How many MCP servers the Runtime has observed.
   *
   * `null` when no live observation source is attached: the Runtime could not
   * be asked, which is a different fact from having observed no server at all.
   */
  readonly observedServers: number | null;
  /**
   * How the observed servers divide across the health vocabulary.
   *
   * `null` for the same reason as `observedServers`: the division is unknown
   * until the Runtime has been asked.
   */
  readonly health: ControlApiMcpRuntimeHealthCounts | null;
  readonly servers: readonly ControlApiMcpRuntimeServer[];
}

/**
 * The MCP launch configuration the Runtime published for one server.
 *
 * These are the keys that say how a server is started or where it is
 * reached: the whole of what the applied projection carries. They are the
 * configuration, not evidence that the server works.
 */
export interface ControlApiMcpAppliedServer {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  readonly httpHeaders: Readonly<Record<string, string>>;
}

/**
 * The launch configuration the canonical declaration gives one server.
 *
 * This is the desired side of the comparison, for the target the Runtime
 * applies: what the declaration says the server is launched with, after the
 * target's own declaration has replaced the shared one. The applied side is
 * `ControlApiMcpAppliedServer`, and the two are compared key for key.
 */
export interface ControlApiMcpDeclaredServer {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  readonly httpHeaders: Readonly<Record<string, string>>;
}

/**
 * The MCP configuration the Runtime applied, against the canonical
 * declaration.
 *
 * The canonical RuleSync source is authoritative and the applied projection
 * is generated from it, so the two are worth comparing: a server that is
 * declared but not applied is a gap the operator can act on. The comparison
 * is the Runtime's, and the Console renders it.
 */
export interface ControlApiMcpAppliedResponse {
  readonly schema: "autodev-control-mcp-applied-v2";
  /** Where the applied configuration was read from. */
  readonly source: string;
  /** The canonical declaration the applied configuration is compared against. */
  readonly declarationSource: ".rulesync/mcp.jsonc";
  /** The target whose configuration the applied projection holds. */
  readonly target: string;
  /**
   * Whether the applied configuration could be read at all.
   *
   * `false` means the Runtime could not be asked, which is a different fact
   * from an applied configuration that holds no servers.
   */
  readonly available: boolean;
  /**
   * The launch configuration the canonical declaration gives the target.
   *
   * The declared side of the comparison. It is published so the page can show
   * what was declared next to what was applied, and so a write has the
   * configuration to edit.
   */
  readonly declaredServers: readonly ControlApiMcpDeclaredServer[];
  /** The servers the Runtime published. */
  readonly servers: readonly ControlApiMcpAppliedServer[];
  /** The shared reconciliation view of the declaration against the applied state. */
  readonly reconciliation: ReconciliationView;
}

/**
 * The result of a canonical MCP declaration write.
 *
 * The write is a compare-and-swap on the declaration's revision, so the
 * response carries the revision the declaration now has, what the target
 * declares after the write, and the reconciliation the Runtime observed once
 * the projection was applied.
 */
export interface ControlApiMcpServerPatchResponse {
  readonly schema: "autodev-control-mcp-server-patch-v1";
  /** The server whose launch configuration was written. */
  readonly name: string;
  /** The target whose declaration was written. */
  readonly target: string;
  /** The revision of the canonical declaration after the write. */
  readonly revision: string;
  /** Whether the declaration's content changed. */
  readonly changed: boolean;
  /** The launch configuration the target declares after the write. */
  readonly launch: ControlApiMcpDeclaredServer;
  /** The shared reconciliation view of the declaration against the applied state. */
  readonly reconciliation: ReconciliationView;
}

/**
 * A canonical MCP declaration write.
 *
 * The write owns the launch keys of one server: a key that is absent is left
 * as the declaration has it and a key that is `null` is removed. The target's
 * enablement, approval mode and tool allowlist are not part of it.
 */
export interface ControlApiMcpServerPatchRequest {
  readonly expectedRevision: string;
  readonly launch: {
    readonly command?: string | null;
    readonly args?: readonly string[] | null;
    readonly cwd?: string | null;
    readonly url?: string | null;
    readonly bearerTokenEnvVar?: string | null;
    readonly httpHeaders?: Readonly<Record<string, string>> | null;
  };
}

export interface ControlApiToolsResponse {
  readonly schema: "autodev-control-tools-v2";
  readonly source: string;
  readonly readOnly: true;
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  /**
   * How many tools the composite catalogue holds.
   *
   * The catalogue is built from two independent reads -- the execution
   * contract's roles and the RuleSync tool catalogue -- so the count is a
   * number only when both were observed. One unread read makes the count
   * incomplete rather than small, and an incomplete count is not a count.
   *
   * Null when either read was not observed. A catalogue that was read and
   * holds no tools is a measured zero and stays a number: "nothing was there"
   * and "nobody looked" are different claims.
   */
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
  /**
   * Whether the Runtime has observed any skill telemetry at all.
   *
   * The collection-level fact behind "Awaiting OTel evidence": without it a
   * page cannot tell "nothing has been observed yet" from "it was observed and
   * nothing happened", which are different facts about a different subject.
   */
  readonly telemetryObserved: boolean;
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly roles: readonly string[];
    /**
     * Where the skill is installed, read live.
     *
     * `null` when the skill is in the catalogue and installed nowhere: a
     * skill no agent can reach is a configuration defect, and the Console
     * says so rather than listing it as though it were live.
     */
    readonly scope: SkillScope | null;
    /** The directory the skill was found in. */
    readonly scopeLocation: string | null;
    /**
     * The workspace a repo-scoped skill belongs to.
     *
     * `null` for every other scope, and for a repo-scoped skill whose
     * repository is not one of the configured workspaces. A repo-scoped
     * skill is that workspace's skill: its roles are assigned inside that
     * workspace and nowhere else.
     */
    readonly workspace: string | null;
    /**
     * Times the skill was exposed to an agent; `null` when nothing has been
     * observed for it.
     *
     * `null` means "not observed" and `0` means "observed, and never
     * happened", so the two are kept apart.
     */
    readonly observedExposure: number | null;
    /** Times the skill was used; `null` when nothing has been observed for it. */
    readonly observedUse: number | null;
  }[];
  /**
   * The skills the execution contract assigns that no canonical RuleSync
   * source exists for.
   *
   * Null when the catalogue was not read. The check is a join between the
   * contract's assignments and the catalogue's names, so a catalogue nobody
   * read leaves the join unperformed -- and an empty list there would say
   * every assignment resolves, which is a claim the catalogue did not make.
   *
   * An empty list beside a read catalogue is a measured answer: every
   * assignment resolves.
   */
  readonly unresolvedAssignments:
    | readonly {
        readonly name: string;
        readonly roles: readonly string[];
      }[]
    | null;
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
  /**
   * The workspace the assignment belongs to.
   *
   * Absent for a global assignment. A skill installed inside a repository
   * belongs to that repository's workspace alone, so its assignment is made
   * there and nowhere else; a skill installed anywhere else is assigned
   * globally and names no workspace. The Control API refuses an assignment
   * whose workspace does not match where the skill is installed.
   */
  readonly workspace?: string;
}

export interface ControlApiSkillRolesPatchResponse {
  readonly schema: "autodev-control-skill-assignment-v2";
  readonly skill: string;
  readonly desiredRoles: readonly string[];
  /** Null means no runtime observation; an empty array is observed-empty. */
  readonly actualRoles: readonly string[] | null;
  readonly revision: string;
  readonly reconciliation: ReconciliationView;
  readonly diff: ReconciliationDiff;
}

/** Canonical RuleSync source for one existing skill. */
export interface ControlApiSkillContentResponse {
  readonly schema: "autodev-control-skill-content-v2";
  readonly name: string;
  readonly path: string;
  /** Exact `.rulesync/skills/<name>/SKILL.md` text. */
  readonly content: string;
  /** SHA-256 of the exact source text; used for compare-and-swap writes. */
  readonly revision: string;
  /**
   * Reusable reconciliation view shared with every other mutable resource.
   *
   * A skill is linked into the runtime rather than projected into it, so the
   * observed generation is the canonical revision whenever the runtime is
   * running this very source. The Console renders this view rather than
   * deriving its own, so the skill page cannot drift from the shared contract.
   */
  readonly reconciliation: ReconciliationView;
}

/** Replaces one existing skill source against the revision the editor loaded. */
export interface ControlApiSkillContentPatchRequest {
  readonly expectedRevision: string;
  readonly content: string;
}

export interface ControlApiSkillContentPatchResponse {
  readonly schema: "autodev-control-skill-content-patch-v1";
  readonly name: string;
  readonly revision: string;
  readonly changed: boolean;
  /** RuleSync generation and its check both confirmed the source projection. */
  readonly projectionApplied: true;
  readonly reconciliation: {
    readonly status: ReconciliationStatus;
    readonly history: readonly OperationHistoryEntry[];
  };
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

/**
 * One hook event and the actions it runs.
 *
 * The actions are the complete list the event runs, not a delta: RuleSync
 * replaces an event's whole action list when a target declares that event, so
 * a partial list would be read as the whole list and would silently drop the
 * actions it left out.
 */
export interface ControlApiHookEvent {
  readonly event: HookEvent;
  readonly actions: readonly HookAction[];
}

/**
 * One hook event, as the canonical declaration gives it for a target.
 *
 * It is the declared side, so it carries where the declaration of the event
 * lives: `shared` means every target inherits it and `target` means this
 * target declares it alone. The applied projection says nothing about that,
 * which is why the applied side is a `ControlApiHookEvent` and not one of
 * these.
 */
export interface ControlApiHookDeclaration extends ControlApiHookEvent {
  readonly origin: HookDeclarationOrigin;
}

export interface ControlApiHooksResponse {
  readonly schema: "autodev-control-hooks-v2";
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
  /**
   * The revision of the canonical declaration, which a write compares against.
   *
   * `null` when the declaration could not be read, and a write against `null`
   * has nothing to compare, so the editor stays disabled with the reason
   * rather than offering a write that cannot be guarded.
   */
  readonly revision: string | null;
  /** The target whose effective declaration this read publishes. */
  readonly target: string;
  /**
   * The events the target declares.
   *
   * The effective declaration for the target: the shared declaration with the
   * target's own declaration merged over it, one event at a time, which is how
   * RuleSync merges them.
   */
  readonly events: readonly ControlApiHookDeclaration[];
}

/**
 * The hook projection the Runtime published, against the canonical
 * declaration.
 *
 * The projection is generated from the declaration, so the two are worth
 * comparing: a hook the operator declared but the Runtime did not install is
 * a gap they can act on. The comparison is the Runtime's, and the Console
 * renders it.
 */
export interface ControlApiHooksAppliedResponse {
  readonly schema: "autodev-control-hooks-applied-v1";
  /** Where the applied projection was read from. */
  readonly source: string;
  /** The canonical declaration the applied projection is compared against. */
  readonly declarationSource: ".rulesync/hooks.jsonc";
  /** The target whose projection was applied. */
  readonly target: string;
  /**
   * Whether the applied projection could be read at all.
   *
   * `false` means the Runtime could not read it, which is a different fact
   * from a projection that holds no hooks.
   */
  readonly available: boolean;
  /**
   * The events the canonical declaration gives the target.
   *
   * The declared side of the comparison. It is published so the page can show
   * what was declared next to what was applied, and so a write has the
   * declaration to edit.
   */
  readonly declaredEvents: readonly ControlApiHookDeclaration[];
  /** The events the Runtime published. */
  readonly events: readonly ControlApiHookEvent[];
  /** The shared reconciliation view of the declaration against the applied state. */
  readonly reconciliation: ReconciliationView;
}

/**
 * A canonical hook declaration write.
 *
 * The write owns one event's action list: the whole of it, because the
 * declaration replaces an event's list rather than adding to it.
 */
export interface ControlApiHookEventPatchRequest {
  readonly expectedRevision: string;
  readonly actions: readonly HookAction[];
}

/**
 * The result of a canonical hook declaration write.
 *
 * The write is a compare-and-swap on the declaration's revision, so the
 * response carries the revision the declaration now has, what the target
 * declares after the write, and the reconciliation the Runtime observed once
 * the projection was applied.
 */
export interface ControlApiHookEventPatchResponse {
  readonly schema: "autodev-control-hook-event-patch-v1";
  /** The event whose actions were written. */
  readonly event: HookEvent;
  /** The target whose declaration was written. */
  readonly target: string;
  /** The revision of the canonical declaration after the write. */
  readonly revision: string;
  /** Whether the declaration's content changed. */
  readonly changed: boolean;
  /** The actions the target declares for the event after the write. */
  readonly actions: readonly HookAction[];
  /** The shared reconciliation view of the declaration against the applied state. */
  readonly reconciliation: ReconciliationView;
}

/**
 * The permission policy, as the canonical source states it.
 *
 * These are the keys the portable source declares, and no others: a policy
 * field with no canonical key behind it is a value the product would be
 * inventing.
 */
export type ControlApiPermissionPolicy = PermissionPolicy;

/**
 * The permission policy as the Runtime published it and the Console reads it.
 *
 * The policy is the portable source's, read from it: the response names the
 * file it was read from, and publishes the revision a write is compared
 * against.
 */
export interface ControlApiPermissionsResponse {
  readonly schema: "autodev-control-permissions-v2";
  /** The canonical file the policy was read from. */
  readonly source: string;
  readonly readOnly: boolean;
  /** The revision of the canonical file: the sha256 of its exact bytes. */
  readonly revision: string | null;
  /**
   * The policy the canonical source states.
   *
   * Null when the source could not be read or could not be parsed. A policy
   * that states defaults is not a policy the operator chose, so a source that
   * does not say what its keys are is reported as not observed rather than
   * filled in.
   */
  readonly policy: ControlApiPermissionPolicy | null;
  /** Whether the canonical source could be read, and whether it parsed. */
  readonly policyStatus: "valid" | "invalid" | "unavailable";
  /** Why the policy could not be read; null when it could. */
  readonly policyReason: string | null;
  /**
   * The policy the Runtime applied, read from the composed user configuration.
   *
   * Null when the applied configuration could not be read. A configuration that
   * exists but was not observed is not a policy of defaults.
   */
  readonly applied: ControlApiPermissionPolicy | null;
  /** Where the applied policy was read from. */
  readonly appliedSource: string;
  readonly rolePermissions: Readonly<
    Record<
      string,
      {
        /**
         * The sandbox this role runs in, as its own declaration states it.
         *
         * The projection the Runtime installs keeps a boolean instead, so a
         * role declared `danger-full-access` was reported as `workspace-write`
         * -- the product's most privileged role named as a sandboxed one.
         *
         * Null when the role's declaration could not be read: the sandbox is
         * then not observed, which is neither the read-only mode nor the
         * unrestricted one.
         */
        readonly sandboxMode: SandboxMode | null;
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

/**
 * A request to change the permission policy.
 *
 * The policy is written one setting at a time, because each setting is a
 * separate control on the surface: a request names the settings it changes and
 * the revision it decided on, and the rest of the policy is left as the
 * canonical source has it.
 */
export interface ControlApiPermissionsPatchRequest {
  /** The revision of the canonical policy file the change was decided on. */
  readonly expectedRevision: string;
  readonly approvalPolicy?: "never" | "always" | "on-demand";
  readonly sandboxMode?: SandboxMode;
  readonly approvalsReviewer?: string;
  readonly networkAccess?: boolean;
  readonly webSearch?: boolean;
}

/**
 * The result of a permission policy write.
 *
 * The write is a compare-and-swap on the policy file's revision, so the
 * response carries the revision the file now has, the policy it now states,
 * and the reconciliation the Runtime observed once the composed
 * configuration was refreshed.
 */
export interface ControlApiPermissionsPatchResponse {
  readonly schema: "autodev-control-permissions-patch-v1";
  /** The revision of the canonical policy file after the write. */
  readonly revision: string;
  /** Whether the policy file's content changed. */
  readonly changed: boolean;
  /** The policy the canonical source states after the write. */
  readonly policy: ControlApiPermissionPolicy;
  /** The policy the Runtime applied, read from the composed configuration. */
  readonly applied: ControlApiPermissionPolicy | null;
  /** The shared reconciliation view of the policy against the applied state. */
  readonly reconciliation: ReconciliationView;
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
  readonly schema: "autodev-control-prompt-versions-v2";
  readonly name: string;
  readonly status: "available" | "unavailable";
  readonly versions: readonly ControlApiPromptVersionReference[];
  /** Whether a version exists after this page. */
  readonly hasMore: boolean;
  /**
   * The page this response carries: how many versions were passed over before
   * it, and how many it asked for. A caller walks the history by asking for
   * the next offset, so the page has to be part of the answer rather than
   * something the caller has to remember.
   */
  readonly offset: number;
  readonly limit: number;
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

/**
 * One workspace as the Control API reports it.
 *
 * The catalog entry is the canonical configuration; `configuration` and
 * `runtime` are the two facts an operator needs beside it -- whether the
 * entry is usable, and whether the runtime is currently serving the
 * workspace. They are separate fields because they come from separate
 * authorities: the configuration is judged against the canonical role list,
 * and the runtime fact is a live projection that may be absent.
 */
export interface ControlApiWorkspaceRecord extends WorkspaceEntry {
  readonly configuration: WorkspaceConfigurationHealth;
  readonly runtime: WorkspaceRuntimeAvailability;
}

export interface ControlApiWorkspacesResponse {
  readonly schema: "autodev-control-workspaces-v3";
  readonly source: string;
  readonly readOnly: boolean;
  readonly catalogStatus: WorkspaceCatalogStatus;
  /**
   * The revision of the canonical catalog: the sha256 of its exact bytes, or
   * null when the file could not be read.
   *
   * It is the handle a write is compared against, so a reader that cannot
   * name it is saying that there is nothing to write against.
   */
  readonly revision: string | null;
  readonly totalWorkspaces: number | null;
  readonly workspaces: readonly ControlApiWorkspaceRecord[];
  /**
   * The shared desired-vs-actual view of the canonical catalog.
   *
   * The catalog is the desired state, and the Runtime reads it from disk on
   * every request, so the generation it observes is the generation the file
   * holds. Publishing it is what lets the Workspaces surface say the same word
   * as every other canonical write -- converged, pending or not observed --
   * instead of leaving the operator to infer convergence from a write that
   * said it succeeded.
   */
  readonly reconciliation: ReconciliationView;
}

/**
 * One workspace's configuration write.
 *
 * The write is a compare-and-swap on the catalog's revision, so it names the
 * revision it was decided on. Only the fields the body carries change, and
 * `id` is not among them: a workspace's identity is what the catalog is
 * indexed by.
 */
export interface ControlApiWorkspacePatchRequest {
  readonly expectedRevision: string;
  readonly enabled?: boolean | undefined;
  readonly baseBranch?: string | undefined;
  readonly agentRoles?: readonly string[] | null | undefined;
}

export interface ControlApiWorkspacePatchResponse {
  readonly schema: "autodev-control-workspace-patch-v2";
  readonly id: string;
  /** The revision of the catalog after the write. */
  readonly revision: string;
  readonly changed: boolean;
  /** The workspace as the catalog now declares it. */
  readonly workspace: ControlApiWorkspaceRecord;
  /**
   * The shared desired-vs-actual view of the canonical catalog after the
   * write.
   *
   * The observed generation is a second read of the canonical source, not a
   * copy of the generation the write produced: a catalog that moved again
   * between the write and the observation is reported as pending, and a
   * catalog that cannot be read at all is reported as not observed. Neither
   * is dressed up as convergence.
   */
  readonly reconciliation: ReconciliationView;
  /**
   * What the write changed, in the catalog's own vocabulary.
   *
   * The summary names the fields that moved and the identifier is the
   * generation they produced, so the Console can render "what changed and
   * which generation it is" without inventing a second diff vocabulary.
   */
  readonly diff: ReconciliationDiff;
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
  /**
   * The runs the Actions API returned for the workflows on this page.
   *
   * Null when the Actions read did not happen -- the token was missing, the
   * repository was not trusted, the request ran out of its deadline. An empty
   * list there would say the workflows have never run, which is a claim about
   * the repository rather than about this read, and `runtimeFactsAvailable`
   * already says the read did not happen.
   *
   * An empty list beside an available read is a measured zero and stays a
   * list: the workflows were asked and none had run.
   */
  readonly recentRuns: readonly GithubWorkflowRun[] | null;
}

export interface ControlApiConcurrencyStatus {
  readonly scope?: string;
  readonly configSource?: string;
  readonly configFileExists?: boolean;
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
  readonly revision?: number;
}

export interface ControlApiConcurrencyPatchRequest {
  readonly maxConcurrentThreadsPerSession?: number | null;
  readonly resetToConfigFile?: boolean;
  readonly revision?: number;
}

export interface ControlApiConcurrencyPatchResponse {
  readonly schema: "autodev-control-concurrency-v1";
  readonly concurrency: ControlApiConcurrencyStatus;
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
  readonly schema: "autodev-control-runtime-v2";
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
  /**
   * Canonical live agent activity, grouped by its observed provider, model,
   * and role attribution. `null` means Runtime did not register an activity
   * source; a measured empty map means the observed count is zero.
   */
  readonly liveAgents: ControlApiLiveAgentCounts | null;
}

/** Runtime's current live agent records, not historical usage telemetry. */
export interface ControlApiLiveAgentCounts {
  readonly count: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
  /** Keys use the canonical `<provider>/<model>` identifier. */
  readonly byModel: Readonly<Record<string, number>>;
  /**
   * Keys use the canonical workspace id -- the same `owner/repository` key
   * `config/workspaces.json` names. A workspace the source did not list has
   * zero live agents, which is a measured fact rather than a missing one.
   */
  readonly byWorkspace: Readonly<Record<string, number>>;
  readonly missingProvider: number;
  readonly missingModel: number;
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
  "running" | "persisting" | "completed" | "failed" | "cancelled" | "truncated";

/**
 * The canonical run-state set. Runtime validates against it and the Console
 * validates responses against it, so a terminal state cannot exist on one side
 * of the boundary and be rejected on the other.
 */
export const CONTROL_API_PLAYTESTING_RUN_STATES = [
  "running",
  "persisting",
  "completed",
  "failed",
  "cancelled",
  "truncated"
] as const satisfies readonly ControlApiPlaytestingRunState[];

export function isControlApiPlaytestingRunState(
  value: unknown
): value is ControlApiPlaytestingRunState {
  return (
    typeof value === "string" &&
    (CONTROL_API_PLAYTESTING_RUN_STATES as readonly string[]).includes(value)
  );
}

export type ControlApiPlaytestingCancellationReason =
  PlaytestBatchCancellationReason;

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

export type ControlApiPlaytestingCapabilityStatus =
  "ready" | "check-required" | "unavailable";

export interface ControlApiPlaytestingCapabilityReason {
  readonly code: string;
  readonly label: string;
  readonly message: string;
  readonly severity: "check-required" | "unavailable";
}

/** One decision backend's readiness, inside a mode's readiness. */
export interface ControlApiPlaytestingPolicyReadiness {
  readonly policyId: PlaytestVisualPolicyId;
  readonly status: ControlApiPlaytestingCapabilityStatus;
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

export interface ControlApiPlaytestingModeReadiness {
  readonly status: ControlApiPlaytestingCapabilityStatus;
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

/** Target-local entry/timing eligibility, separate from workspace driver readiness. */
export interface ControlApiPlaytestingVisualTargetReadiness {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly eligibility: "supported" | "unsupported";
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

/** Safe run-form preview; raw command, checkout path, and image are omitted. */
export interface ControlApiPlaytestingCapabilitiesResponse {
  readonly schema: "autodev-control-playtesting-capabilities-v3";
  readonly workspaceId: string;
  /** Content hash of all readiness facts used by this preflight. */
  readonly capabilityRevision: string;
  readonly workspaceCatalog: "valid" | "invalid" | "unavailable";
  readonly workspaceEnabled: boolean;
  readonly operatorActionsAvailable: boolean;
  readonly modeReadiness: {
    readonly "adapter-accelerated": ControlApiPlaytestingModeReadiness;
    readonly "autonomous-visual": ControlApiPlaytestingModeReadiness & {
      readonly targetStore: "available" | "unavailable";
      readonly targets: readonly ControlApiPlaytestingVisualTargetReadiness[];
      /**
       * Each decision backend the mode offers, with its own readiness.
       *
       * A mode being ready says the browser can be driven; it does not say
       * that every backend can be reached. The local OneJev route needs a
       * model server the operator runs, and that is a separate fact from
       * the Smart-directed route's model router.
       */
      readonly policies: readonly ControlApiPlaytestingPolicyReadiness[];
    };
    readonly "scripted-regression": ControlApiPlaytestingModeReadiness;
  };
  readonly approved: boolean;
  readonly approvalRevision: number | null;
  /** The approved checkout's latest committed build at read time; null when unresolvable. */
  readonly buildSha: string | null;
  readonly gameBuild: string | null;
  readonly allowedScenarios: readonly string[];
  readonly approvedPolicies: readonly string[];
  readonly supportedPolicies: readonly string[];
  readonly runnablePolicies: readonly string[];
  readonly unsupportedApprovedPolicies: readonly string[];
  readonly configurationStatus: "validated" | "invalid" | "not-checked";
  /** Maximum assignments in one request after checked-in and approved limits. */
  readonly maxBatchAssignments: number;
  readonly runnableAssignments: readonly {
    readonly scenarioId: string;
    readonly scenarioFamily: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly cohort: string;
    readonly strategy: string;
    readonly maxStepsPerEpisode: number;
  }[];
  /**
   * Seeds the latest build's frozen benchmark admits, in inventory order.
   * `null` when that build freezes no benchmark, so any bounded printable
   * seed is admissible. A run request outside this list is refused.
   */
  readonly admissibleSeeds:
    | readonly {
        readonly seed: string;
        readonly purpose: "discovery" | "confirmation" | "regression";
      }[]
    | null;
  readonly policyProfiles: readonly {
    readonly policyId: string;
    readonly version: string;
    readonly cohort: string;
    readonly strategy: string;
  }[];
  readonly limits: WorkspacePlaytestApproval["limits"] | null;
  readonly issueReporting: "disabled" | "review";
  /**
   * The game's checked-in `reporting.githubIssues`. Carried alongside the
   * operator's `issueReporting` grant because neither has meaning alone, and an
   * operator reading this view could otherwise not tell a game that asked for
   * review from one that asked for nothing.
   */
  readonly configuredIssueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
  readonly revokedAt: string | null;
  readonly runPreflight: "required-at-start";
}

/** Typed active-run response; Data remains the authoritative batch history. */
export interface ControlApiPlaytestingActiveRunsResponse {
  readonly schema: "autodev-control-playtesting-runs-v2";
  readonly workspaceId: string;
  readonly runs: readonly {
    readonly batchId: string;
    readonly assignmentCount: number;
    readonly createdAt: string;
    /** Frozen assignment-to-session links for in-progress Watch navigation. */
    readonly sessions: readonly PlaytestSessionReference[];
    /**
     * The same owner-read record the single-batch status route returns, so one
     * list renders every nonterminal batch without a request per batch.
     */
    readonly status: ControlApiPlaytestingRunRecord;
  }[];
}

/** Stable launch receipt; status may reflect an idempotent replay. */
export interface ControlApiPlaytestingRunStartedResponse {
  readonly schema: "autodev-control-playtesting-run-started-v3";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly assignmentCount: number;
  /** Frozen manifest IDs; a session reference is an identity, not an outcome. */
  readonly assignmentIds: readonly string[];
  /** Exact deterministic session IDs for these frozen assignments. */
  readonly sessions: readonly PlaytestSessionReference[];
  /** The exact Runtime-registered timestamp, shared with active-run reads. */
  readonly createdAt: string;
  readonly status: ControlApiPlaytestingRunState;
}

/** Workspace/actor-scoped recovery lookup for an uncertain client launch. */
export interface ControlApiPlaytestingRunRequestLookupResponse {
  readonly schema: "autodev-control-playtesting-run-request-v2";
  readonly workspaceId: string;
  readonly requestId: string;
  readonly state: "not-found" | "expired" | "pending" | "accepted";
  readonly batchId: string | null;
  readonly assignmentCount: number | null;
  readonly assignmentIds: readonly string[];
  readonly sessions: readonly PlaytestSessionReference[];
  readonly createdAt: string | null;
  readonly status: ControlApiPlaytestingRunState | null;
}

/** Typed status response; a null result while active means still running. */
export interface ControlApiPlaytestingRunStatusResponse {
  readonly schema: "autodev-control-playtesting-run-status-v1";
  readonly workspaceId: string;
  readonly run: ControlApiPlaytestingRunRecord;
}

/** Read-only state of a Runtime-owned playtest-analyst dispatch. */
export interface ControlApiPlaytestingAnalystRun {
  readonly analysisId: string;
  readonly workspaceId: string;
  readonly analysisKind?: "confirmatory" | "discovery";
  /**
   * Whether the operator's request was for a review that must file findings.
   *
   * A hypothesis review states what the packet shows; a findings request also
   * files the defect claims the packet supports. The two are different jobs,
   * so the run records which one was asked for.
   */
  readonly requireFindings?: boolean;
  readonly status: "running" | "completed" | "partial" | "failed";
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly requestedEpisodeIds: readonly string[];
  readonly packets: readonly {
    readonly episodeId: string;
    readonly batchId: string;
    readonly packetId: string;
  }[];
  readonly receipts: readonly {
    readonly episodeId: string;
    readonly batchId: string | null;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly budget: readonly {
    readonly batchId: string;
    readonly reviewCap: number;
    readonly actualCritiques: number;
    readonly reserved: number;
    readonly requested: number;
    readonly remaining: number;
  }[];
  readonly reviews: readonly {
    readonly episodeId: string;
    readonly reviewId: string;
    readonly status: PlaytestSessionReview["status"];
  }[];
  readonly synthesisId: string | null;
  readonly error: string | null;
}

/** The MCP-only packet preparation operation; evidence stays out of Console views. */
export interface ControlApiPlaytestingPacketPreparationResponse {
  readonly schema: "autodev-control-playtesting-analysis-v1";
  readonly operation: "prepare";
  readonly workspaceId: string;
  readonly requested: number;
  readonly packets: readonly {
    readonly episodeId: string;
    readonly batchId: string;
    readonly packet: PlaytestEvidencePacket;
    readonly artifact: PlaytestArtifactReference;
  }[];
  readonly receipts: readonly {
    readonly episodeId: string;
    readonly batchId: string | null;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly budget: readonly {
    readonly batchId: string;
    readonly reviewCap: number;
    readonly actualCritiques: number;
    readonly reserved: number;
    readonly requested: number;
    readonly remaining: number;
  }[];
  readonly analysis: null;
}

/** Console-owned asynchronous dispatch; packets themselves never cross to the browser. */
export interface ControlApiPlaytestingAnalysisDispatchResponse {
  readonly schema: "autodev-control-playtesting-analysis-v1";
  readonly operation: "dispatch";
  readonly workspaceId: string;
  readonly requested: number;
  readonly packets: readonly {
    readonly episodeId: string;
    readonly batchId: string;
    readonly packetId: string;
  }[];
  readonly receipts: readonly {
    readonly episodeId: string;
    readonly batchId: string | null;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly budget: readonly {
    readonly batchId: string;
    readonly reviewCap: number;
    readonly actualCritiques: number;
    readonly reserved: number;
    readonly requested: number;
    readonly remaining: number;
  }[];
  readonly analysis: ControlApiPlaytestingAnalystRun | null;
}

export type ControlApiPlaytestingAnalysisResponse =
  | ControlApiPlaytestingPacketPreparationResponse
  | ControlApiPlaytestingAnalysisDispatchResponse;

export interface ControlApiPlaytestingAnalysesResponse {
  readonly schema: "autodev-control-playtesting-analyses-v1";
  readonly workspaceId: string;
  readonly runs: readonly ControlApiPlaytestingAnalystRun[];
  /** Persisted independently so aggregate results survive Runtime restarts. */
  readonly syntheses: readonly PlaytestCrossSessionSynthesis[];
}

/**
 * One claim the analyst recorded, with the status it carries.
 *
 * A review claims two kinds of thing: something the analyst asserts, and
 * something the analyst explicitly could not confirm. The payload records the
 * second kind as a claim with the `not observed` status, so it would be wrong
 * to read every recorded claim as an asserted conclusion.
 */
export interface ControlApiPlaytestingReviewClaim {
  readonly hypothesisId: string;
  readonly text: string;
  /** "hypothesis" for an asserted claim, "not observed" for an explicit null. */
  readonly status: "hypothesis" | "not observed";
}

/**
 * One finding the analyst recorded, with the evidence status it carries.
 *
 * The status is the part a reader needs: a finding whose evidence was never
 * reproduced is still a candidate, and the Console has to be able to tell a
 * candidate from a verified defect.
 */
export interface ControlApiPlaytestingReviewFinding {
  readonly findingId: string;
  readonly title: string;
  readonly evidenceStatus: PlaytestFinding["evidenceStatus"];
}

/**
 * One persisted analyst review, as the Console reads it.
 *
 * The review is the analyst's durable record about an episode: what it
 * observed, what it concluded, and what evidence each conclusion rests
 * on. It is persisted, so it outlives the Runtime process that produced
 * it — which is the reason this read exists at all.
 */
export interface ControlApiPlaytestingReview {
  readonly reviewId: string;
  readonly episodeId: string;
  readonly workspaceId: string;
  /** Which review contract the analyst ran under. */
  readonly kind: "discovery" | "confirmatory";
  /** The review's own status, verbatim from the stored payload. */
  readonly status: string;
  readonly createdAt: string;
  /** How many observations the analyst recorded. */
  readonly observationCount: number;
  /** How many interpretations — the analyst's hypotheses — the review holds. */
  readonly interpretationCount: number;
  /** How many findings the review carries. */
  readonly findingCount: number;
  /** A one-line statement of what the analyst concluded. */
  readonly headline: string;
  /** The review's chronological summary, bounded for display. */
  readonly summary: string;
  /**
   * The analyst's interpretations, in the order the review recorded them.
   *
   * The count alone was not enough: a reader who sees "5 hypotheses" still
   * cannot read what the analyst claimed, and the claims are the review.
   */
  readonly hypotheses: readonly ControlApiPlaytestingReviewClaim[];
  /** The findings the review carries, with each one's evidence status. */
  readonly findings: readonly ControlApiPlaytestingReviewFinding[];
  /** The evidence the review cites. */
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
}

/**
 * The workspace's persisted analyst reviews.
 *
 * This is the durable counterpart to the analyst-run envelope, which lives
 * in the Runtime process and is therefore lost on restart. A reader who
 * ran an analysis and came back after a restart must still see it.
 */
export interface ControlApiPlaytestingReviewsResponse {
  readonly schema: "autodev-control-playtesting-reviews-v2";
  readonly workspaceId: string;
  readonly total: number;
  readonly rows: readonly ControlApiPlaytestingReview[];
  readonly nextCursor: string | null;
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

/** Expected-revision owner action for one stored comparison; never a deploy command. */
export interface ControlApiPlaytestingComparisonDecisionRequest {
  readonly workspaceId: string;
  readonly comparisonId: string;
  readonly expectedVersion: number;
  readonly disposition: "promote" | "hold";
  readonly reason: string;
}

export interface ControlApiPlaytestingComparisonDecisionResponse {
  readonly schema: "autodev-control-playtesting-comparison-decision-v1";
  readonly workspaceId: string;
  readonly comparison: PlaytestComparison;
}

/** Aggregated, suppression-aware human-study read; raw responses never cross this boundary. */
export interface ControlApiPlaytestingHumanValidationResponse {
  readonly schema: "autodev-control-playtesting-human-validation-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly buildSha: string;
  /** Separate paired-preference outcome; no PXI scale or participant IDs. */
  readonly preference: {
    readonly analysisPlanRef: string;
    readonly suppressionState: "suppressed" | "unsuppressed";
    readonly incompleteExposurePairs: number | null;
    readonly counts: PlaytestHumanPreferenceCounts | null;
    readonly interval: PlaytestNumericInterval | null;
    readonly decision: PlaytestPreferenceSensitivityDecision;
    readonly reasons: readonly string[];
  } | null;
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
  readonly preferenceQuarantines: readonly {
    readonly responseIds: readonly string[];
    readonly buildAId: string;
    readonly buildBId: string;
    readonly reason: "duplicate-participant-pair-preference";
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

/** Schema identifier for the Data-owned Playtesting readiness response. */
export const CONTROL_API_PLAYTESTING_READINESS_SCHEMA =
  "autodev-control-playtesting-readiness-v1" as const;

/** Readiness of the Data-owned Playtesting schema before resource reads begin. */
export interface ControlApiPlaytestingReadinessResponse {
  readonly schema: typeof CONTROL_API_PLAYTESTING_READINESS_SCHEMA;
  readonly workspaceId: string;
  readonly status: "initializing" | "ready";
}

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
/**
 * Workspace/batch/assignment-bound visual target state for one episode,
 * copied verbatim from the exact frozen visual batch assignment manifest.
 *
 * Null for every adapter-accelerated episode, which has no visual target.
 * An autonomous-visual episode either carries this validated record or the
 * detail read fails closed: there is no "unavailable" placeholder value,
 * because a client cannot act on an attested batch of one that might be
 * wrong.
 */
export interface ControlApiPlaytestingVisualAssignment {
  readonly targetId: string;
  readonly targetApprovalId: string;
  readonly targetRevision: number;
  readonly targetOrigin: string;
  readonly areasOfFocus: string | null;
}

export interface ControlApiPlaytestingEpisodeDetailResponse {
  readonly schema: "autodev-control-playtesting-detail-v4";
  readonly workspaceId: string;
  readonly resource: "episode";
  readonly readOnly: true;
  readonly record: PlaytestEpisode;
  readonly latestReview: PlaytestSessionReview | null;
  readonly latestDiscoveryReview: PlaytestDiscoverySessionReview | null;
  readonly visualAssignment: ControlApiPlaytestingVisualAssignment | null;
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

/** Workspaces-owned list of approved visual targets; no Runtime readiness claim. */
export interface ControlApiWorkspaceVisualPlaytestTargetsResponse {
  readonly schema: "autodev-control-workspace-visual-playtest-targets-v1";
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly targets: readonly WorkspaceVisualPlaytestTargetApproval[];
}
