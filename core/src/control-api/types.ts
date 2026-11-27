import type { QuotaAxiResponse } from "quota-axi";

import type { AgentEnablementState } from "../agents/types.ts";
import type { ClientSurface } from "../diagnostics/client-surface.ts";
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
import type { McpGatewayGrants, McpServerResource } from "../mcps/types.ts";
import type { PermissionPolicy } from "../permissions/types.ts";
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
  WorkspaceConfigurationHealth as WorkspaceConfigHealth,
  WorkspaceEntry,
  WorkspaceRuntimeAvailability
} from "../workspaces/types.ts";
import type { WorkspaceVisualPlaytestTargetApproval } from "../workspaces/visual-playtesting.ts";
import type { ControlApiProviderModelDiscovery } from "./provider-model-discovery.ts";

export {
  canonicalTimestampSchema,
  CONTROL_API_PROVIDER_ID_PATTERN,
  CONTROL_API_PROVIDER_MODEL_DISCOVERY_SCHEMA_ID,
  controlApiProviderModelsResponseSchema,
  discoveredProviderModelSchema,
  PROVIDER_MODEL_ID_PATTERN,
  providerModelDiscoveryEntrySchema,
  providerModelDiscoverySchema
} from "./provider-model-discovery.ts";

/**
Maximum number of source-confirmed live session identities returned by Runtime.
*/
export const CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT = 100;

/**
A Control API revision: the sha256 digest of a canonical file.

The Runtime and the Console both compare-and-swap on this value, so the
shape of a revision is one contract rather than a spelling each side
keeps: a lowercase hex digest of exactly 64 characters. Uppercase is not
accepted, because a digest the Runtime computed is always lowercase and a
revision that differs only in case is not the revision that was read.

This is the revision of a canonical *file*. A git commit or build sha is a
different thing and has its own pattern, which accepts the shorter git
form as well.
*/
export const CONTROL_API_REVISION_PATTERN = /^[a-f0-9]{64}$/u;

/**
Typed response contracts exposed by the AutoDev Control API.
*/
export interface ControlApiError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/**
Standard error envelope returned by a Control API mutation route.
*/
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
  /**
  Whether the execution contract was read.
  
  The catalogue is the contract's roles. The accessor that reads the
  contract falls back to an empty contract when the read fails, so an empty
  contract and a contract nobody read look the same to every caller -- and
  the count over the catalogue depends on which one it was.
  */
  readonly executionContractObserved: boolean;
  /**
  How many agents the catalogue holds.
  
  Null when the contract was not read. A contract that was read and declares
  no role is a measured zero and stays a number: "the contract declares no
  role" and "nobody read the contract" are different claims.
  */
  readonly totalAgents: number | null;
  readonly agents: readonly (ControlApiAgentRecord & {
    readonly hasPrompt: boolean;
  })[];
}

export interface ControlApiAgentDetailResponse extends ControlApiAgentRecord {
  readonly schema: "autodev-control-agent-detail-v3";
  readonly promptPath: string | null;
  /**
  The role's system prompt, or null when the prompt file is there and could
  not be read. An unreadable prompt is not an empty prompt.
  */
  readonly systemPrompt: string | null;
  readonly reconciliation: ReconciliationView;
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

/**
Active cooldown window on a provider or one of its models.
*/
export interface ControlApiProviderCooldown {
  readonly kind: string;
  readonly failureClass: string | null;
  readonly until: string;
  readonly resetsAt: string | null;
  readonly lastResortEligible: boolean;
  readonly scope?: "provider" | "model";
  readonly model?: string | null;
}

/**
Live router evidence for one provider; absent when the router is not observed.
*/
export interface ControlApiProviderHealth {
  readonly cooldown: ControlApiProviderCooldown | null;
  readonly modelCooldowns?: Readonly<
    Record<string, ControlApiProviderCooldown>
  >;
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
    readonly model?: string | null;
  } | null;
  /**
  The latest operator-requested check (`POST /control/providers/:provider/check`):
  the provider's live probe plus its model listing. A passing check newer
  than the last failure is evidence the provider recovered; a failing one is
  evidence it has not. `null` when no check has run.
  */
  readonly lastCheck: ControlApiProviderCheck | null;
}

/**
One operator-requested provider check and what it found.
*/
export interface ControlApiProviderCheck {
  readonly at: string;
  readonly ok: boolean;
  /**
  The failure class when the check failed, else null.
  
  `probe_unavailable` is the live probe failing -- no credential, or the
  bridge's health endpoint did not answer. `missing_route` is a provider
  that is configured but has no route, so there was nothing to probe at all.
  `sign_in_required` is a bridge whose provider account must be signed in
  again (`SIGN_IN_REQUIRED_FAILURE_CLASS`).
  */
  readonly failureClass: string | null;
  /**
  What was checked, or why the check failed, in one sentence.
  */
  readonly detail: string;
  /**
  The provider models observed during the check, reported separately from the health verdict.
  */
  readonly models?: ControlApiProviderModelDiscovery | null;
}

/**
`POST /control/providers/:provider/check`: the check and the provider's health after it.
*/
export interface ControlApiProviderCheckResponse {
  readonly schema: "autodev-control-provider-check-v1";
  readonly provider: string;
  readonly check: ControlApiProviderCheck;
  readonly health: ControlApiProviderHealth | null;
  readonly models?: ControlApiProviderModelDiscovery | null;
}

/**
One provider's assignment for one of the four fixed roles.

`priority` carries participation: `disabled` is a member of the enum rather
than a separate enablement flag, so a role cannot hold a priority and be
disabled at once. `model` is preserved even while disabled so re-enabling
restores the previous choice. `mutable` is false when the provider is
globally disabled, because a disabled provider's roles cannot be edited until
it is enabled again.
*/
export interface ControlApiProviderRoleAssignment {
  readonly priority: ProviderRolePriority;
  readonly model: string | null;
  /**
  The reasoning effort this role runs with: the operator's own choice when
  they made one, otherwise the provider's configured orchestrator effort.
  */
  readonly reasoningEffort?: string | null;
  /**
  The effort that will actually be used, which a model id can override.
  */
  readonly effectiveReasoningEffort?: string | null;
  /**
  Whether the configured effort is the one in force. False when the model's
  id fixes the effort (Antigravity's `-low`/`-medium`/`-high` suffixes) and
  the configured effort disagrees with it.
  */
  readonly reasoningEffortInForce?: boolean;
  /**
  The reasoning levels the assigned model's catalog entry declares.
  
  An empty list means the levels are *unobserved*: no catalog declares this
  model, which is not the same statement as "this model supports no effort".
  A provider offers models its catalogs do not describe, and the Runtime
  cannot show that such a model refuses an effort -- only that no catalog
  states which efforts it supports.
  */
  readonly supportedReasoningLevels?: readonly string[];
  readonly mutable: boolean;
  /**
  Convergence for this single role; `not-observed` until a write occurs.
  */
  readonly convergence: ReconciliationStatus;
  /**
  Whether the provider can serve this role at all.
  
  `priority` is the operator's switch; this is the provider's capability, and
  the two are independent. A provider can be enabled and ranked for the
  orchestrator and still be unable to serve it, because an orchestrator
  creates child agents and a provider with no delegation path cannot. The
  Runtime refuses such an assignment rather than persisting one no request
  would ever route to.
  */
  readonly canServe?: boolean;
  /**
  Why the provider cannot serve this role, or null when it can.
  */
  readonly cannotServeReason?: string | null;
}

/**
Provider-wide concurrent-agent limits; `null` is the explicit Unlimited choice.
*/
export interface ControlApiProviderAgentLimits {
  readonly perSession: number | null;
  readonly acrossSessions: number | null;
}

/**
The provider's own external pages, from its routing-config `links`; `null`
when that provider configures no such page.
*/
export interface ControlApiProviderLinks {
  /**
  The provider's account usage/billing page.
  */
  readonly usage: string | null;
  /**
  The provider's documentation.
  */
  readonly documentation: string | null;
}

/**
The provider model discovery contract, stated once.

The Runtime produces this response, the Console reads it, and the Console's
startup preflight checks that the Runtime it is about to talk to speaks the
same contract. The shape and the rules live in one schema, and the types
below are read out of it, so a producer, a reader and a preflight cannot
disagree about what the contract is.
*/

export type {
  ControlApiDiscoveredProviderModel,
  ControlApiProviderModelDiscovery,
  ControlApiProviderModelDiscoveryEntry,
  ControlApiProviderModelsResponse
} from "./provider-model-discovery.ts";

/**
The version of the CLI that serves a provider.

Every provider AutoDev routes to is served by a CLI, and the CLI's release
is the first thing an operator needs when a provider behaves differently
than it used to: a release note names a version, and a bug report needs
one. The Runtime reads the version from the CLI it would actually spawn,
so the number beside a provider is the number in use rather than the
number some other installation reports.

The two states are kept apart on purpose. A version nobody has read yet is
not the same fact as a CLI that is not installed, and the page says which
of the two it is instead of showing a blank where a version would go.
*/
export type ControlApiProviderCliVersion =
  | {
      readonly status: "observed";
      /**
      The CLI's command, as the operator would name it: `claude`, `codex`,
      `agy`, `mmx`, `copilot`, `opencli`.
      */
      readonly command: string;
      /**
      The version the CLI reported, exactly as it printed it.
      */
      readonly version: string;
      /**
      When the Runtime read it.
      */
      readonly observedAt: string;
    }
  | {
      readonly status: "unavailable";
      /**
      Why the version was not read.
      
      The two cases are different facts and the page says which one it is:
      a CLI that is not installed needs an installation, and a CLI that is
      installed but would not answer needs a different fix. Parsing the
      reason's prose to tell them apart would make the page's wording
      part of the contract.
      */
      readonly kind: "not-installed" | "not-readable";
      /**
      The command the provider's CLI would be, when the provider has one
      and the Runtime could name it, even though no version was read.
      */
      readonly command: string | null;
      /**
      Why no version was observed, in words.
      */
      readonly reason: string;
      /**
      When the Runtime last tried, or null when it never has.
      */
      readonly lastAttemptAt: string | null;
    };

/**
One provider's CLI version.
*/
export interface ControlApiProviderVersionEntry {
  readonly provider: string;
  readonly cli: ControlApiProviderCliVersion;
}

/**
The versions of the CLIs this machine has.

This is its own response rather than a field on the provider record
because it is a different kind of fact: the provider record is the
operator's routing configuration, and a version is what the machine
happens to have installed today. Keeping them apart means a Runtime that
cannot read versions still answers the providers contract exactly as
before, and the page says the version was not observed rather than
failing the whole page over a missing release number.
*/
export interface ControlApiProviderVersionsResponse {
  readonly schema: "autodev-control-provider-versions-v1";
  readonly source: "runtime-provider-cli-versions";
  readonly providers: readonly ControlApiProviderVersionEntry[];
}

/**
One agent role's model on one provider.
*/
export interface ControlApiProviderAgentModel {
  readonly role: string;
  readonly tier: string;
  /**
  The operator's choice for this role, or null to run the tier's model.
  */
  readonly model: string | null;
  /**
  The model the role's tier runs on this provider.
  */
  readonly tierModel: string | null;
}

export interface ControlApiProviderRecord {
  readonly id: string;
  readonly links: ControlApiProviderLinks;
  readonly route: {
    readonly pattern: string;
    readonly baseUrl: string;
    readonly healthUrl: string | null;
  } | null;
  /**
  Credential presence only; the value never leaves Runtime.
  */
  readonly credential: {
    readonly envKey: string | null;
    readonly configured: boolean;
  };
  /**
  Provider-level disable, independent of the per-role assignments below:
  disabling suppresses the provider for every role while preserving its
  priorities, models and limits.
  */
  readonly disabled: boolean;
  readonly roles: Readonly<
    Record<ProviderRole, ControlApiProviderRoleAssignment>
  >;
  /**
  Concurrent-agent limits for this provider, across every role.
  */
  readonly agentLimits: ControlApiProviderAgentLimits | null;
  /**
  One entry per agent role (`explorer`, `worker`, ...) whose tier this
  provider serves: the operator's model for that role, if any, and the
  tier's model it runs otherwise.
  */
  readonly agentModels: readonly ControlApiProviderAgentModel[];
  /**
  Configured model per capability tier.
  */
  readonly models: readonly {
    readonly tier: string;
    readonly model: string;
  }[];
  /**
  1-based priority group the provider occupies in each tier it serves.
  */
  readonly priorities: readonly {
    readonly tier: string;
    readonly group: number;
  }[];
  readonly orchestratorReasoningEffort: string | null;
  readonly health: ControlApiProviderHealth | null;
  /**
  Desired-vs-actual state for the provider as a whole, alongside the
  per-role convergence above.
  
  The per-role convergence answers "has this role's assignment been
  observed". This answers the provider's own question: whether the routing
  configuration the operator set -- the provider's enablement, its agent
  limits, and its role assignments together -- has been applied and observed
  as one state. The Runtime derives it, so the Console renders the Runtime's
  view rather than re-deriving a verdict of its own.
  */
  readonly reconciliation: ReconciliationView;
}

export interface ControlApiProvidersResponse {
  readonly schema: "autodev-control-providers-v5";
  readonly orchestratorTier: string;
  /**
  Exact quota-axi report; Runtime does not normalize provider quota data.
  */
  readonly quotaAxi: QuotaAxiResponse | null;
  /**
  Ordered priority/fallback groups per capability tier.
  */
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
  The assignment replaced, or null when the role had never been configured.
  
  The routing policy's own assignment rather than
  `ControlApiProviderRoleAssignment`: `mutable` and `convergence` describe how
  the current view should treat a role, and a past assignment is neither
  mutable now nor converging. Reading them off `previous` would have required
  the route to invent them.
  */
  readonly previous: ProviderRoleAssignment | null;
  readonly actor: string;
  readonly reconciliation: ReconciliationView;
}

/**
Response of `PATCH /control/providers/:provider`.
*/
export interface ControlApiProviderEnabledPatchResponse {
  readonly schema: "autodev-control-provider-enabled-v1";
  readonly provider: string;
  readonly disabled: boolean;
  readonly previous: boolean;
  readonly actor: string;
  readonly reconciliation: ReconciliationView;
}

/**
Response of `PATCH /control/providers/:provider/agents/:role`.
*/
export interface ControlApiProviderAgentModelPatchResponse {
  readonly schema: "autodev-control-provider-agent-model-v1";
  readonly provider: string;
  readonly role: string;
  /**
  The role's model preference now, or null when it runs its tier's model.
  */
  readonly model: string | null;
  readonly previous: string | null;
  readonly actor: string;
  readonly reconciliation: ReconciliationView;
}

/**
Response of `PATCH /control/providers/:provider/limits`.
*/
export interface ControlApiProviderLimitsPatchResponse {
  readonly schema: "autodev-control-provider-limits-v1";
  readonly provider: string;
  readonly agentLimits: ControlApiProviderAgentLimits;
  readonly previous: ControlApiProviderAgentLimits | null;
  readonly actor: string;
  readonly reconciliation: ReconciliationView;
}

/**
Exact body for the confirmation-bound provider overrides reset.
*/
export interface ControlApiProvidersResetRequest {
  readonly confirm: true;
}

/**
Response of `POST /control/providers/reset` -- the Providers page header's
confirmation-bound "Reset to defaults" operation.

This clears only provider Runtime overrides (role assignments, agent-role
models, provider disables, model disables, and provider agent limits), returning routing to
the static `config/model-routing.json` defaults. Agent enablement, provider
discovery snapshots, cooldown/health state, and concurrency limits are
untouched -- none of them are provider routing overrides. Bounded counts
rather than the cleared state itself are reported, so the audit trail
proves the action's exact blast radius without replaying configuration.
*/
export interface ControlApiProvidersResetResponse {
  readonly schema: "autodev-control-providers-reset-v1";
  readonly actor: string;
  readonly cleared: {
    readonly roleAssignments: number;
    readonly disabledProviders: number;
    readonly disabledModels: number;
    readonly providerLimits: number;
    readonly agentModels: number;
  };
  readonly reconciliation: ReconciliationView;
}

export interface ControlApiModelRecord {
  readonly id: string;
  readonly provider: string;
  /**
  Capability tiers this provider serves with the model.
  */
  readonly tiers: readonly string[];
  readonly displayName: string | null;
  /**
  Model enablement carries the same desired-vs-actual contract as a provider
  role: both are mutable routing-policy toggles, so an operator asking "did my
  change land?" gets the same evidence for both. `not-observed` until a write
  has been recorded.
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
  /**
  Desired-vs-actual evidence and bounded history for the applied change.
  */
  readonly reconciliation: ReconciliationView;
}

/**
One role surface the shared MCP gateway publishes on loopback.
*/
export interface ControlApiMcpGatewaySurface {
  readonly role: string;
  /**
  The loopback Streamable HTTP endpoint that serves this role.
  */
  readonly url: string;
}

/**
The shared MCP gateway, as the Runtime installed and observes it.

A read-only operator view: the gateway's own state file is the projection
the installer wrote, and the grants are the canonical role contract's
reviewed grants narrowed by the operator. Nothing here is a second registry
or a second policy; the Console renders it and never writes it.
*/
export interface ControlApiMcpGateway {
  /**
  The LaunchAgent that supervises the gateway.
  */
  readonly label: string;
  /**
  Whether the installer has written a current gateway state.
  */
  readonly installed: boolean;
  /**
  Whether the installed service matches its state, its LaunchAgent owns the
  listener, and `/readyz` answers. `false` whenever any of those is not
  observed, including when the gateway is not installed.
  */
  readonly ready: boolean;
  readonly port: number | null;
  /**
  The loopback readiness probe; `null` when the gateway is not installed.
  */
  readonly readinessUrl: string | null;
  readonly generation: string | null;
  readonly workspace: string | null;
  /**
  The primary role: it owns the gateway's delegation coordinator.
  */
  readonly role: string;
  /**
  Every role with a published surface, primary role first.
  */
  readonly roles: readonly string[];
  readonly surfaces: readonly ControlApiMcpGatewaySurface[];
  /**
  The primary role's reviewed (role-contracted) tool grants.
  */
  readonly reviewed: McpGatewayGrants;
  /**
  The primary role's effective grants: the reviewed grants, optionally
  narrowed by the operator, never widened.
  */
  readonly grants: McpGatewayGrants;
  /**
  Why the gateway state could not be read; `null` when it was.
  */
  readonly error: string | null;
}

export interface ControlApiMcpsResponse {
  readonly schema: "autodev-control-mcps-v3";
  readonly source: ".rulesync/mcp.jsonc";
  /**
  The revision of the canonical declaration.
  
  The digest of the whole document, so it changes when any part of the
  declaration changes. A write compares against it, so a write that was
  decided on an older declaration is refused rather than applied over a
  newer one. `null` when the declaration could not be read at all.
  */
  readonly revision: string | null;
  readonly readOnly: boolean;
  readonly valid: boolean | null;
  /**
  Why the source is invalid; empty when it is valid or was not observed.
  
  Required rather than optional so `valid: false` cannot arrive alone. The
  loader knows which server declaration, or which target's override of which
  server, it could not apply.
  */
  readonly issues: readonly RuleSyncValidationIssue[];
  /**
  The canonical declaration of every MCP server, and nothing else.
  
  This is a configuration read. It says what each server *is*; it says
  nothing about whether the Runtime has reached it, and a server listed
  here has not thereby been observed. The Runtime's observations live on
  their own read path (`ControlApiMcpRuntimeResponse`) so that the
  configuration stays a configuration read.
  */
  readonly servers: readonly McpServerResource[];
  /**
  The shared MCP gateway every provider reaches these servers through.
  
  Published on the catalog rather than as another resource family: the
  MCPs resource owns gateway health, published role surfaces and effective
  grants, and its observation of individual servers stays on
  `/control/mcp-runtime` and `/control/mcp-applied`.
  */
  readonly gateway: ControlApiMcpGateway;
}

/**
The Runtime's health vocabulary for an MCP server.

`ready` and `error` are verdicts. `configured` means the Runtime saw the
server named in a session but never exercised it, and `observed` means it
saw a span that carried no readiness signal -- neither is a correctness
claim. `stale` means the Runtime saw the server, but not recently enough to
call it ready.
*/
export type ControlApiMcpRuntimeHealth =
  "configured" | "ready" | "error" | "observed" | "stale";

/**
What the Runtime has observed of one MCP server.

The declaration in `.rulesync/mcp.jsonc` says what the server *is*; this is
what the Runtime has *seen* of it. The two are different questions, and the
page has to keep them apart: a declared server is not a reached server, and
a server the Runtime has not observed is not a broken one.

Every field is an observation the Runtime recorded, not a conclusion drawn
from the declaration.
*/
export interface ControlApiMcpRuntimeEvidence {
  /**
  The Runtime's health verdict for the server.
  */
  readonly health: ControlApiMcpRuntimeHealth;
  /**
  When the Runtime last saw the server.
  */
  readonly lastSeenAt: string | null;
  /**
  The status of the last observation, as the Runtime recorded it.
  */
  readonly lastStatus: string;
  /**
  How many times the Runtime has tried to initialize the server.
  
  `null` when nothing observes the Runtime's MCP client initialization: the
  count is not a measurement then, and a zero would claim the server was
  never brought up.
  */
  readonly initAttempts: number | null;
  /**
  How many times the Runtime has tried to discover the server's tools.
  
  `null` for the same reason as `initAttempts`.
  */
  readonly toolDiscoveryAttempts: number | null;
  /**
  How many of the Runtime's attempts on this server failed.
  */
  readonly failures: number;
  /**
  How many tool calls the Runtime has observed on this server.
  
  The count is of calls the Runtime saw, not of tools the server offers: a
  server that was initialized but never called has no calls here.
  */
  readonly toolCalls: number;
  /**
  The mean duration of the server's observed calls, in milliseconds.
  */
  readonly averageDurationMs: number;
  /**
  The roles the Runtime has observed this server used from.
  */
  readonly roles: readonly {
    readonly role: string;
    readonly health: ControlApiMcpRuntimeHealth;
    readonly lastSeenAt: string | null;
    readonly lastStatus: string;
  }[];
  /**
  The tools the Runtime has observed being called on this server.
  
  This is the set of tools that were *seen in use*, not the server's tool
  inventory: a tool the server offers but nothing has called is absent, and
  a tool the server no longer offers may still be listed. The page says so
  rather than presenting the list as the server's live inventory.
  */
  readonly tools: readonly {
    readonly name: string;
    readonly count: number;
    readonly errors: number;
  }[];
}

/**
One MCP server as the Runtime has observed it.

The observation carries the server's name so that the read can be joined
against the canonical declaration without the two paths having to be merged
into one payload.
*/
export interface ControlApiMcpRuntimeServer extends ControlApiMcpRuntimeEvidence {
  readonly name: string;
}

/**
How many observed servers sit in each health verdict.

The Runtime owns this vocabulary and these counts, so the Console renders
them rather than counting the servers itself and arriving at a health
summary of its own.
*/
export interface ControlApiMcpRuntimeHealthCounts {
  readonly ready: number;
  readonly error: number;
  readonly stale: number;
  readonly configured: number;
  readonly observed: number;
}

/**
The Runtime's observation of the MCP servers it has seen.

This is published on its own path rather than folded into the MCP catalog,
because the two answer different questions and the catalog is a
configuration read. A page composes them; the contract keeps them apart.
*/
export interface ControlApiMcpRuntimeResponse {
  readonly schema: "autodev-control-mcp-runtime-v1";
  /**
  Where the observations come from.
  */
  readonly source: string;
  /**
  How many MCP servers the Runtime has observed.
  
  `null` when no live observation source is attached: the Runtime could not
  be asked, which is a different fact from having observed no server at all.
  */
  readonly observedServers: number | null;
  /**
  How the observed servers divide across the health vocabulary.
  
  `null` for the same reason as `observedServers`: the division is unknown
  until the Runtime has been asked.
  */
  readonly health: ControlApiMcpRuntimeHealthCounts | null;
  readonly servers: readonly ControlApiMcpRuntimeServer[];
}

/**
The MCP launch configuration the Runtime published for one server.

These are the keys that say how a server is started or where it is
reached: the whole of what the applied projection carries. They are the
configuration, not evidence that the server works.
*/
export interface ControlApiMcpAppliedServer {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  /**
  The names of the HTTP headers the server is launched with, sorted. The
  values are credentials and never leave the Runtime.
  */
  readonly httpHeaderNames: readonly string[];
}

/**
The launch configuration the canonical declaration gives one server.

This is the desired side of the comparison, for the target the Runtime
applies: what the declaration says the server is launched with, after the
target's own declaration has replaced the shared one. The applied side is
`ControlApiMcpAppliedServer`, and the two are compared key for key.
*/
export interface ControlApiMcpDeclaredServer {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  /**
  The names of the HTTP headers the server is launched with, sorted. The
  values are credentials and never leave the Runtime.
  */
  readonly httpHeaderNames: readonly string[];
}

/**
The MCP configuration the Runtime applied, against the canonical
declaration.

The canonical RuleSync source is authoritative and the applied projection
is generated from it, so the two are worth comparing: a server that is
declared but not applied is a gap the operator can act on. The comparison
is the Runtime's, and the Console renders it.
*/
export interface ControlApiMcpAppliedResponse {
  readonly schema: "autodev-control-mcp-applied-v3";
  /**
  Where the applied configuration was read from.
  */
  readonly source: string;
  /**
  The canonical declaration the applied configuration is compared against.
  */
  readonly declarationSource: ".rulesync/mcp.jsonc";
  /**
  The target whose configuration the applied projection holds.
  */
  readonly target: string;
  /**
  Whether the applied configuration could be read at all.
  
  `false` means the Runtime could not be asked, which is a different fact
  from an applied configuration that holds no servers.
  */
  readonly available: boolean;
  /**
  The launch configuration the canonical declaration gives the target.
  
  The declared side of the comparison. It is published so the page can show
  what was declared next to what was applied, and so a write has the
  configuration to edit.
  */
  readonly declaredServers: readonly ControlApiMcpDeclaredServer[];
  /**
  The servers the Runtime published.
  */
  readonly servers: readonly ControlApiMcpAppliedServer[];
  /**
  The shared reconciliation view of the declaration against the applied state.
  */
  readonly reconciliation: ReconciliationView;
}

/**
The result of a canonical MCP declaration write.

The write is a compare-and-swap on the declaration's revision, so the
response carries the revision the declaration now has, what the target
declares after the write, and the reconciliation the Runtime observed once
the projection was applied.
*/
export interface ControlApiMcpServerPatchResponse {
  readonly schema: "autodev-control-mcp-server-patch-v2";
  /**
  The server whose launch configuration was written.
  */
  readonly name: string;
  /**
  The target whose declaration was written.
  */
  readonly target: string;
  /**
  The revision of the canonical declaration after the write.
  */
  readonly revision: string;
  /**
  Whether the declaration's content changed.
  */
  readonly changed: boolean;
  /**
  The launch configuration the target declares after the write.
  */
  readonly launch: ControlApiMcpDeclaredServer;
  /**
  The shared reconciliation view of the declaration against the applied state.
  */
  readonly reconciliation: ReconciliationView;
}

/**
A canonical MCP declaration write.

The write owns the launch keys of one server: a key that is absent is left
as the declaration has it and a key that is `null` is removed. The target's
enablement, approval mode and tool allowlist are not part of it.
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
  Whether the execution contract was read.
  
  The catalogue's second half is the contract's role projection: which roles
  reach which tools. The accessor that reads the contract falls back to an
  empty contract when the read fails, so an empty contract and a contract
  nobody read look the same to a caller. They are not the same claim -- the
  first says the contract declares no roles, the second says nobody read it
  -- and every count over the catalogue, and every statement about a tool's
  role exposure, depends on which one it was.
  
  False when the contract could not be read. The entries that arrived are
  then the ones the RuleSync source alone declared, and the catalogue's size
  is not known.
  */
  readonly executionContractObserved: boolean;
  /**
  How many tools the composite catalogue holds.
  
  The catalogue is built from two independent reads -- the execution
  contract's roles and the RuleSync tool catalogue -- so the count is a
  number only when both were observed. One unread read makes the count
  incomplete rather than small, and an incomplete count is not a count.
  
  Null when either read was not observed. A catalogue that was read and
  holds no tools is a measured zero and stays a number: "nothing was there"
  and "nobody looked" are different claims.
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
  Why the canonical catalog is invalid; empty when valid or not observed.
  
  Required rather than optional so `valid: false` cannot arrive alone. The
  loader distinguishes a symlinked skill directory, an unusable directory
  name, a missing SKILL.md, absent or invalid frontmatter, and frontmatter that
  names a different skill -- six faults that shared one flag.
  */
  readonly issues: readonly RuleSyncValidationIssue[];
  /**
  Whether the execution contract was read.
  
  The role assignments come from the contract, and the accessor that reads
  it falls back to an empty contract when the read fails: an empty contract
  and a contract nobody read look the same to a caller that only sees the
  roles. The eligibility a card counts, and the roles an assignment form
  may offer, both depend on which one it was.
  
  False when the contract could not be read. The catalogue's own entries are
  then still what the RuleSync source declared, and the assignments are not
  known.
  */
  readonly executionContractObserved: boolean;
  /**
  Digest of the execution contract that backs role assignment, or `null`
  when no contract file was found.
  
  It is carried on the collection rather than per-skill because it is a
  property of the contract, not of any skill: every row in one render was
  written against the same revision. An assignment form needs it to detect a
  concurrent write, and fetching it per skill would mean one request per row
  to hand a page what it already knows. `null` is a distinct third state --
  it means "no contract exists", not "revision zero" -- so a Console that
  cannot tell them apart does not offer the form at all.
  */
  readonly executionContractRevision: string | null;
  /**
  Roles an assignment form may offer, from the same contract as the revision.
  
  Taken from the contract rather than from `/control/agents` because the
  contract is what the write edits and what decides validity: a role that is
  not listed here would be refused, so offering it would be offering a
  submission that cannot succeed.
  */
  readonly assignmentRoles: readonly string[];
  /**
  Whether the Runtime has observed any skill telemetry at all.
  
  The collection-level fact behind "Awaiting OTel evidence": without it a
  page cannot tell "nothing has been observed yet" from "it was observed and
  nothing happened", which are different facts about a different subject.
  */
  readonly telemetryObserved: boolean;
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly roles: readonly string[];
    /**
    Where the skill is installed, read live.
    
    `null` when the skill is in the catalogue and installed nowhere: a
    skill no agent can reach is a configuration defect, and the Console
    says so rather than listing it as though it were live.
    */
    readonly scope: SkillScope | null;
    /**
    The directory the skill was found in.
    */
    readonly scopeLocation: string | null;
    /**
    The workspace a repo-scoped skill belongs to.
    
    `null` for every other scope, and for a repo-scoped skill whose
    repository is not one of the configured workspaces. A repo-scoped
    skill is that workspace's skill: its roles are assigned inside that
    workspace and nowhere else.
    */
    readonly workspace: string | null;
    /**
    Times the skill was exposed to an agent; `null` when nothing has been
    observed for it.
    
    `null` means "not observed" and `0` means "observed, and never
    happened", so the two are kept apart.
    */
    readonly observedExposure: number | null;
    /**
    Times the skill was used; `null` when nothing has been observed for it.
    */
    readonly observedUse: number | null;
    /**
    Times a skill operation did not succeed; `null` when nothing has been
    observed for it.
    
    A skill whose every read failed was observed, and this is how often it
    failed. It is kept apart from the use count because "the skill was
    tried and did not work" and "the skill was never tried" are different
    facts, and a failure folded into a use would hide both.
    */
    readonly observedError: number | null;
  }[];
  /**
  The skills the execution contract assigns that no canonical RuleSync
  source exists for.
  
  Null when the catalogue was not read. The check is a join between the
  contract's assignments and the catalogue's names, so a catalogue nobody
  read leaves the join unperformed -- and an empty list there would say
  every assignment resolves, which is a claim the catalogue did not make.
  
  An empty list beside a read catalogue is a measured answer: every
  assignment resolves.
  */
  readonly unresolvedAssignments:
    | readonly {
        readonly name: string;
        readonly roles: readonly string[];
      }[]
    | null;
}

/**
Canonical RuleSync source for one existing skill.
*/
export interface ControlApiSkillContentResponse {
  readonly schema: "autodev-control-skill-content-v2";
  readonly name: string;
  readonly path: string;
  /**
  Exact `.rulesync/skills/<name>/SKILL.md` text.
  */
  readonly content: string;
  /**
  SHA-256 of the exact source text; used for compare-and-swap writes.
  */
  readonly revision: string;
  /**
  Reusable reconciliation view shared with every other mutable resource.
  
  A skill is linked into the runtime rather than projected into it, so the
  observed generation is the canonical revision whenever the runtime is
  running this very source. The Console renders this view rather than
  deriving its own, so the skill page cannot drift from the shared contract.
  */
  readonly reconciliation: ReconciliationView;
}

/**
One reason a canonical source could not be applied.

`location` names the part at fault in the terms the operator is looking at --
an event name, an action index, or a source line -- and `message` says what is
wrong with it.
*/
export interface ControlApiValidationIssue {
  readonly location: string;
  readonly message: string;
}

/**
One hook event and the actions it runs.

The actions are the complete list the event runs, not a delta: RuleSync
replaces an event's whole action list when a target declares that event, so
a partial list would be read as the whole list and would silently drop the
actions it left out.
*/
export interface ControlApiHookEvent {
  readonly event: HookEvent;
  readonly actions: readonly HookAction[];
}

/**
One hook event, as the canonical declaration gives it for a target.

It is the declared side, so it carries where the declaration of the event
lives: `shared` means every target inherits it and `target` means this
target declares it alone. The applied projection says nothing about that,
which is why the applied side is a `ControlApiHookEvent` and not one of
these.
*/
export interface ControlApiHookDeclaration extends ControlApiHookEvent {
  readonly origin: HookDeclarationOrigin;
}

export interface ControlApiHooksResponse {
  readonly schema: "autodev-control-hooks-v2";
  readonly source: string;
  readonly readOnly: true;
  readonly valid: boolean | null;
  /**
  Why the source is invalid; empty when it is valid or was not observed.
  
  Required rather than optional so `valid: false` can never arrive alone. A
  loader that has already located the fault and reports only the boolean
  leaves the operator to re-find what the system read in a single pass.
  */
  readonly issues: readonly ControlApiValidationIssue[];
  /**
  The observed canonical declaration revision, or null when unreadable.
  */
  readonly revision: string | null;
  /**
  The canonical declaration's exact source text, or null when it was not read.
  
  It travels with the events it was read with, so the source an operator
  inspects and the declaration the page renders are one read rather than two
  that can straddle a change.
  */
  readonly sourceText: string | null;
  /**
  The target whose effective declaration this read publishes.
  */
  readonly target: string;
  /**
  The events the target declares.
  
  The effective declaration for the target: the shared declaration with the
  target's own declaration merged over it, one event at a time, which is how
  RuleSync merges them.
  */
  readonly events: readonly ControlApiHookDeclaration[];
}

/**
The hook projection the Runtime published, against the canonical
declaration.

The projection is generated from the declaration, so the two are worth
comparing: a hook the operator declared but the Runtime did not install is
a gap they can act on. The comparison is the Runtime's, and the Console
renders it.
*/
export interface ControlApiHooksAppliedResponse {
  readonly schema: "autodev-control-hooks-applied-v1";
  /**
  Where the applied projection was read from.
  */
  readonly source: string;
  /**
  The canonical declaration the applied projection is compared against.
  */
  readonly declarationSource: ".rulesync/hooks.jsonc";
  /**
  The target whose projection was applied.
  */
  readonly target: string;
  /**
  Whether the applied projection could be read at all.
  
  `false` means the Runtime could not read it, which is a different fact
  from a projection that holds no hooks.
  */
  readonly available: boolean;
  /**
  The events the canonical declaration gives the target.
  
  The declared side of the comparison. It is published so the page can show
  what was declared next to what was applied.
  */
  readonly declaredEvents: readonly ControlApiHookDeclaration[];
  /**
  The events the Runtime published.
  */
  readonly events: readonly ControlApiHookEvent[];
  /**
  The shared reconciliation view of the declaration against the applied state.
  */
  readonly reconciliation: ReconciliationView;
}

/**
The permission policy, as the canonical source states it.

These are the keys the portable source declares, and no others: a policy
field with no canonical key behind it is a value the product would be
inventing.
*/
export type ControlApiPermissionPolicy = PermissionPolicy;

/**
The permission policy as the Runtime published it and the Console reads it.

The policy is the portable source's, read from it: the response names the
file it was read from, and publishes the observed source revision.
The repository is the only change authority.
*/
export interface ControlApiPermissionsResponse {
  readonly schema: "autodev-control-permissions-v2";
  /**
  The canonical file the policy was read from.
  */
  readonly source: string;
  readonly readOnly: true;
  /**
  Whether the execution contract was read.
  
  The role matrices are the contract's roles, and the accessor that reads the
  contract falls back to an empty contract when the read fails. An empty
  contract and a contract nobody read are different claims, and the matrices
  cannot tell them apart on their own.
  */
  readonly executionContractObserved: boolean;
  /**
  The revision of the canonical file: the sha256 of its exact bytes.
  */
  readonly revision: string | null;
  /**
  The canonical source's exact text, or null when its text could not be read.
  
  The canonical source is a declaration, so it is published whole and the
  policy beside it is parsed from the same read. The applied configuration
  is never published as text.
  */
  readonly sourceText: string | null;
  /**
  The policy the canonical source states.
  
  Null when the source could not be read or could not be parsed. A policy
  that states defaults is not a policy the operator chose, so a source that
  does not say what its keys are is reported as not observed rather than
  filled in.
  */
  readonly policy: ControlApiPermissionPolicy | null;
  /**
  Whether the canonical source could be read, and whether it parsed.
  */
  readonly policyStatus: "valid" | "invalid" | "unavailable";
  /**
  Why the policy could not be read; null when it could.
  */
  readonly policyReason: string | null;
  /**
  The policy the Runtime applied, read from the composed user configuration.
  
  Null when the applied configuration could not be read. A configuration that
  exists but was not observed is not a policy of defaults.
  */
  readonly applied: ControlApiPermissionPolicy | null;
  /**
  Where the applied policy was read from.
  */
  readonly appliedSource: string;
  readonly rolePermissions: Readonly<
    Record<
      string,
      {
        /**
        Whether this role is restricted to read-only capabilities in the
        execution contract (`# role-access: read-only` / `AUTODEV_MCP_READ_ONLY`).
        */
        readonly readOnly: boolean;
        /**
        MCP servers this role is permitted to reach, projected from the same
        execution contract that backs `/control/agents`. Kept here so the
        effective capability matrix is one authoritative join rather than a
        value the Console has to guess.
        */
        readonly mcp: readonly string[];
        /**
        Which tools of which MCP server this role may call.
        
        Kept alongside the server list rather than folded into it: the
        execution contract grants both separately, and a projection that
        carried only the servers would say a role reaches `lsp` without
        saying which of its tools, which reads as unrestricted.
        */
        readonly mcpTools: Readonly<Record<string, readonly string[]>>;
        /**
        Skills this role is eligible for, from the execution contract.
        */
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
  /**
  Why the catalog is invalid; empty when valid or not observed.
  */
  readonly issues: readonly RuleSyncValidationIssue[];
  readonly totalCommands: number | null;
  readonly commands: readonly {
    readonly name: string;
    readonly path: string;
    readonly description?: string;
  }[];
  /**
  The canonical role prompts, or null when they were not observed.
  
  The prompts live in `agents/prompts/roles/`, and the directory's absence
  is an observation: no role prompt is configured there, and that is a
  measured zero. A read that failed for any other reason is not an
  observation, and the list is then null -- an empty list there would claim
  the repository holds no role prompt, which is a claim about the read
  rather than about the repository.
  
  The catalogue is two independent reads -- this one and the RuleSync
  command catalogue -- so every count over it is a number only when both
  were observed.
  */
  readonly rolePrompts:
    | readonly {
        readonly role: string;
        readonly path: string;
      }[]
    | null;
}

export interface ControlApiPromptDetailResponse {
  readonly schema: "autodev-control-prompt-detail-v4";
  readonly name: string;
  readonly type: "command" | "role";
  readonly source: string;
  readonly content: string;
  readonly preview: string;
  readonly revision: string;
  /**
  Bounded diff summary between the canonical and projected state.
  */
  readonly diff: ReconciliationDiff;
  readonly reconciliation: ReconciliationView;
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
  /**
  Whether a version exists after this page.
  */
  readonly hasMore: boolean;
  /**
  The page this response carries: how many versions were passed over before
  it, and how many it asked for. A caller walks the history by asking for
  the next offset, so the page has to be part of the answer rather than
  something the caller has to remember.
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

/**
One workspace as the Control API reports it.

The catalog entry is the canonical configuration; `configuration` and
`runtime` are the two facts an operator needs beside it -- whether the
entry is usable, and whether the runtime is currently serving the
workspace. They are separate fields because they come from separate
authorities: the configuration is judged against the canonical role list,
and the runtime fact is a live projection that may be absent.
*/
export interface ControlApiWorkspaceRecord extends WorkspaceEntry {
  readonly configuration: WorkspaceConfigHealth;
  readonly runtime: WorkspaceRuntimeAvailability;
}

export interface ControlApiWorkspacesResponse {
  readonly schema: "autodev-control-workspaces-v3";
  readonly source: string;
  readonly readOnly: boolean;
  readonly catalogStatus: WorkspaceCatalogStatus;
  /**
  The revision of the canonical catalog: the sha256 of its exact bytes, or
  null when the file could not be read.
  
  It is the handle a write is compared against, so a reader that cannot
  name it is saying that there is nothing to write against.
  */
  readonly revision: string | null;
  readonly totalWorkspaces: number | null;
  readonly workspaces: readonly ControlApiWorkspaceRecord[];
  /**
  The shared desired-vs-actual view of the canonical catalog.
  
  The catalog is the desired state, and the Runtime reads it from disk on
  every request, so the generation it observes is the generation the file
  holds. Publishing it is what lets the Workspaces surface say the same word
  as every other canonical write -- converged, pending or not observed --
  instead of leaving the operator to infer convergence from a write that
  said it succeeded.
  */
  readonly reconciliation: ReconciliationView;
}

/**
One workspace's configuration write.

The write is a compare-and-swap on the catalog's revision, so it names the
revision it was decided on. Only the fields the body carries change, and
`id` is not among them: a workspace's identity is what the catalog is
indexed by.
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
  /**
  The revision of the catalog after the write.
  */
  readonly revision: string;
  readonly changed: boolean;
  /**
  The workspace as the catalog now declares it.
  */
  readonly workspace: ControlApiWorkspaceRecord;
  /**
  The shared desired-vs-actual view of the canonical catalog after the
  write.
  
  The observed generation is a second read of the canonical source, not a
  copy of the generation the write produced: a catalog that moved again
  between the write and the observation is reported as pending, and a
  catalog that cannot be read at all is reported as not observed. Neither
  is dressed up as convergence.
  */
  readonly reconciliation: ReconciliationView;
  /**
  What the write changed, in the catalog's own vocabulary.
  
  The summary names the fields that moved and the identifier is the
  generation they produced, so the Console can render "what changed and
  which generation it is" without inventing a second diff vocabulary.
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
  The runs the Actions API returned for the workflows on this page.
  
  Null when the Actions read did not happen -- the token was missing, the
  repository was not trusted, the request ran out of its deadline. An empty
  list there would say the workflows have never run, which is a claim about
  the repository rather than about this read, and `runtimeFactsAvailable`
  already says the read did not happen.
  
  An empty list beside an available read is a measured zero and stays a
  list: the workflows were asked and none had run.
  */
  readonly recentRuns: readonly GithubWorkflowRun[] | null;
}

/**
Where the session concurrency limit in force came from.

A stored override is the operator's own write; `config_file` is the limit the
config file declares; `default` is nothing that could be read declaring a
limit. The Console renders this word next to the limit, so it names the
limit's source -- not the file's location, which is a different fact and
travels as `configFileSource`.
*/
export type ControlApiConcurrencyLimitSource =
  "stored_override" | "config_file" | "default";

/**
Which config file the router read.

`env_override` means `CODEX_ROUTER_CODEX_CONFIG_FILE` redirected the read
away from the default Codex home. It is a fact about the read, not about the
limit.
*/
export type ControlApiConcurrencyConfigFileSource =
  "default_codex_home" | "env_override";

export interface ControlApiConcurrencyStatus {
  readonly scope?: string;
  /**
  Where the limit in force came from.
  
  A closed union rather than a `string`: the Console branches on it to
  decide what it tells the operator about the limit, so a value it has no
  word for must not reach the page. It was a `string` carrying a different
  fact entirely -- the file's location -- which left the branch the Console
  reads unreachable and every configured limit labelled as a default.
  */
  readonly configSource?: ControlApiConcurrencyLimitSource;
  /**
  Which config file the router read. A different fact from the limit's source.
  */
  readonly configFileSource?: ControlApiConcurrencyConfigFileSource;
  readonly configFileExists?: boolean;
  /**
  The limit the config file declares.
  
  Three states. A number is a file that was read and declares that limit;
  `null` is a file that was read and declares no limit, which is the default
  deployment; and an absent field is a file that was there and could not be
  read, so nobody knows what it declares.
  
  `null` is an observed fact about this deployment rather than a missing
  field: the Runtime's own status CLI prints it as `unlimited`, and
  collapsing it to `undefined` would make a router that deliberately runs
  without a limit indistinguishable from one whose limit was never read.
  The absent state is a different claim again, and the Runtime publishes it
  as absence rather than as `null` so the two stay apart.
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

/**
Response of `PATCH /control/runtime/concurrency` -- the session concurrency
limit the Agents surface writes.

It carries the shared reconciliation view because the limit is a mutable
resource like every other one the Console writes: the desired generation is
the limit the operator asked for, and the observed generation is the limit
the Runtime is enforcing. The limit is applied by the router's own
concurrency manager, in the same process that serves the write, so the
observation is immediate -- but "the write was accepted" and "the Runtime is
enforcing this limit" are two claims, and only the second one says what the
operator will actually get.
*/
export interface ControlApiConcurrencyPatchResponse {
  readonly schema: "autodev-control-concurrency-v2";
  readonly concurrency: ControlApiConcurrencyStatus;
  readonly reconciliation: ReconciliationView;
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
  readonly schema: "autodev-control-runtime-v3";
  readonly routerInstanceId: string;
  /**
  Every field here is emitted on every response by `getLifecycleStatus()`;
  none is conditional. Declaring the extras optional let the Console read a
  missing one as "no evidence" when the Runtime had in fact always reported
  it, which is how a required field quietly became a guess.
  */
  readonly lifecycle: {
    /**
    The Runtime's own `RouterLifecycleState`. Declared here as the union it
    already is, rather than as the `string` it used to be: the Console renders
    this value as the operator-facing word on a status badge, so widening it
    to `string` let any new state appear verbatim — which is how `/agents`
    came to read a lowercase `ready` beside a `Ready` three rows away. A
    closed union is what forces the Runtime and the Console to agree on the
    vocabulary rather than leaving the reader to spot the drift.
    */
    readonly state: "ready" | "draining";
    readonly draining: boolean;
    readonly changedAt: string;
    readonly activeResponseRequests: number;
  };
  /**
  The same concurrency projection `/control/routing` carries. It was
  previously declared as `{ limit, active } & ControlApiConcurrencyStatus`,
  but the Runtime emits no such fields: the real names are
  `effectivePerSessionLimit` and `activeSubagentThreads`. That fiction made
  the Console read two always-undefined properties and fall through to a
  hardcoded zero while the evidence it wanted was in the response.
  */
  readonly concurrency: ControlApiConcurrencyStatus;
  readonly inFlightRequestCount: number;
  /**
  Canonical live agent activity, grouped by its observed provider, model,
  and role attribution. `null` means Runtime did not register an activity
  source; a measured empty map means the observed count is zero.
  */
  readonly liveAgents: ControlApiLiveAgentCounts | null;
  /**
  Source-confirmed session identities on live AgentActivityTracker records.
  `null` means the Runtime did not register the source. `identitiesObserved`
  contains only IDs explicitly supplied and validated on activity records;
  it is not a claim that every live conversation was identified. The
  un-attributed field counts live activity records, not guessed sessions.
  */
  readonly liveSessions: ControlApiLiveSessions | null;
}

export type ControlApiLiveSessionState =
  "active" | "tool_wait" | "user_wait" | "subagent_wait" | "resumed";

export interface ControlApiLiveSessionIdentity {
  readonly sessionId: string;
  readonly state: ControlApiLiveSessionState;
  /**
  Unix epoch milliseconds of the latest observed activity for this ID.
  */
  readonly lastActivityAt: number;
  /**
  Newest non-null source observation for each dimension; null if absent.
  */
  readonly provider: string | null;
  readonly model: string | null;
  readonly role: string | null;
  /**
  First observed client surface for this session; null if absent.
  */
  readonly clientSurface: ClientSurface | null;
}

export interface ControlApiLiveSessions {
  /**
  Distinct validated identities, sorted by session ID and capped at 100.
  */
  readonly identitiesObserved: readonly ControlApiLiveSessionIdentity[];
  /**
  Exact unique identified-session count before the 100-row list cap.
  */
  readonly identifiedSessionCount: number;
  /**
  True only when more than 100 distinct identified sessions were observed.
  */
  readonly partial: boolean;
  /**
  Live agent-activity records lacking a valid ID; this is not a session
  count. If nonzero, the overall live-session total is unavailable even
  though `identifiedSessionCount` remains exact for known IDs.
  */
  readonly unattributedLiveActivityCount: number;
}

/**
Runtime's current live agent records, not historical usage telemetry.
*/
export interface ControlApiLiveAgentCounts {
  readonly count: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
  /**
  Keys use the canonical `<provider>/<model>` identifier.
  */
  readonly byModel: Readonly<Record<string, number>>;
  /**
  Keys use the canonical workspace id -- the same `owner/repository` key
  `config/workspaces.json` names. A workspace the source did not list has
  zero live agents, which is a measured fact rather than a missing one.
  */
  readonly byWorkspace: Readonly<Record<string, number>>;
  /**
  The same live agents per provider, split by the role each one serves, so
  a provider's count can say what it is made of. Roles a provider has no
  live agent in are absent; an agent with no role is under `unattributed`.
  */
  readonly byProviderRole: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  /**
  `byProviderRole` per canonical `<provider>/<model>` identifier.
  */
  readonly byModelRole: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  readonly missingProvider: number;
  readonly missingModel: number;
}

export interface ControlApiEvaluationsResponse {
  readonly schema: "autodev-control-evaluations-v1";
  readonly source: string;
  readonly readOnly: boolean;
  /**
  Every evaluation row the source holds.
  
  This is not `evaluations.length`. The read is capped, so the array is the
  most recent N results while this is how many exist -- and a consumer that
  derived a total from the array would report the cap as the size of the
  store.
  */
  readonly totalEvaluations: number;
  /**
  Whether `evaluations` is a bounded window rather than the whole table.
  
  Required rather than inferred. A consumer can compare `totalEvaluations`
  against `evaluations.length` itself, and every such comparison is a place to
  forget it and render a capped window as the complete history.
  */
  readonly truncated: boolean;
  readonly evaluations: readonly EvaluationResult[];
}

/**
Runtime run state surfaced by authenticated Playtesting actions.
*/
export type ControlApiPlaytestingRunState =
  "running" | "persisting" | "completed" | "failed" | "cancelled" | "truncated";

/**
The canonical run-state set. Runtime validates against it and the Console
validates responses against it, so a terminal state cannot exist on one side
of the boundary and be rejected on the other.
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

/**
One decision backend's readiness, inside a mode's readiness.
*/
export interface ControlApiPlaytestingPolicyReadiness {
  readonly policyId: PlaytestVisualPolicyId;
  readonly status: ControlApiPlaytestingCapabilityStatus;
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

export interface ControlApiPlaytestingModeReadiness {
  readonly status: ControlApiPlaytestingCapabilityStatus;
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

/**
Target-local entry/timing eligibility, separate from workspace driver readiness.
*/
export interface ControlApiPlaytestingVisualTargetReadiness {
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  readonly eligibility: "supported" | "unsupported";
  readonly reasons: readonly ControlApiPlaytestingCapabilityReason[];
}

/**
Safe run-form preview; raw command, checkout path, and image are omitted.
*/
export interface ControlApiPlaytestingCapabilitiesResponse {
  readonly schema: "autodev-control-playtesting-capabilities-v3";
  readonly workspaceId: string;
  /**
  Content hash of all readiness facts used by this preflight.
  */
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
      Each decision backend the mode offers, with its own readiness.
      
      A mode being ready says the browser can be driven; it does not say
      that every backend can be reached. The local OneJev route needs a
      model server the operator runs, and that is a separate fact from
      the Smart-directed route's model router.
      */
      readonly policies: readonly ControlApiPlaytestingPolicyReadiness[];
    };
    readonly "scripted-regression": ControlApiPlaytestingModeReadiness;
  };
  readonly approved: boolean;
  readonly approvalRevision: number | null;
  /**
  The approved checkout's latest committed build at read time; null when unresolvable.
  */
  readonly buildSha: string | null;
  readonly gameBuild: string | null;
  readonly allowedScenarios: readonly string[];
  readonly approvedPolicies: readonly string[];
  readonly supportedPolicies: readonly string[];
  readonly runnablePolicies: readonly string[];
  readonly unsupportedApprovedPolicies: readonly string[];
  readonly configurationStatus: "validated" | "invalid" | "not-checked";
  /**
  Maximum assignments in one request after checked-in and approved limits.
  */
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
  Seeds the latest build's frozen benchmark admits, in inventory order.
  `null` when that build freezes no benchmark, so any bounded printable
  seed is admissible. A run request outside this list is refused.
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
  The game's checked-in `reporting.githubIssues`. Carried alongside the
  operator's `issueReporting` grant because neither has meaning alone, and an
  operator reading this view could otherwise not tell a game that asked for
  review from one that asked for nothing.
  */
  readonly configuredIssueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
  readonly revokedAt: string | null;
  readonly runPreflight: "required-at-start";
}

/**
Typed active-run response; Data remains the authoritative batch history.
*/
export interface ControlApiPlaytestingActiveRunsResponse {
  readonly schema: "autodev-control-playtesting-runs-v2";
  readonly workspaceId: string;
  readonly runs: readonly {
    readonly batchId: string;
    readonly assignmentCount: number;
    readonly createdAt: string;
    /**
    Frozen assignment-to-session links for in-progress Watch navigation.
    */
    readonly sessions: readonly PlaytestSessionReference[];
    /**
    The same owner-read record the single-batch status route returns, so one
    list renders every nonterminal batch without a request per batch.
    */
    readonly status: ControlApiPlaytestingRunRecord;
  }[];
}

/**
Stable launch receipt; status may reflect an idempotent replay.
*/
export interface ControlApiPlaytestingRunStartedResponse {
  readonly schema: "autodev-control-playtesting-run-started-v3";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly assignmentCount: number;
  /**
  Frozen manifest IDs; a session reference is an identity, not an outcome.
  */
  readonly assignmentIds: readonly string[];
  /**
  Exact deterministic session IDs for these frozen assignments.
  */
  readonly sessions: readonly PlaytestSessionReference[];
  /**
  The exact Runtime-registered timestamp, shared with active-run reads.
  */
  readonly createdAt: string;
  readonly status: ControlApiPlaytestingRunState;
}

/**
Workspace/actor-scoped recovery lookup for an uncertain client launch.
*/
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

/**
Typed status response; a null result while active means still running.
*/
export interface ControlApiPlaytestingRunStatusResponse {
  readonly schema: "autodev-control-playtesting-run-status-v1";
  readonly workspaceId: string;
  readonly run: ControlApiPlaytestingRunRecord;
}

/**
Read-only state of a Runtime-owned playtest-analyst dispatch.
*/
export interface ControlApiPlaytestingAnalystRun {
  readonly analysisId: string;
  readonly workspaceId: string;
  readonly analysisKind?: "confirmatory" | "discovery";
  /**
  Whether the operator's request was for a review that must file findings.
  
  A hypothesis review states what the packet shows; a findings request also
  files the defect claims the packet supports. The two are different jobs,
  so the run records which one was asked for.
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

/**
The MCP-only packet preparation operation; evidence stays out of Console views.
*/
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

/**
Console-owned asynchronous dispatch; packets themselves never cross to the browser.
*/
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
  /**
  Persisted independently so aggregate results survive Runtime restarts.
  */
  readonly syntheses: readonly PlaytestCrossSessionSynthesis[];
}

/**
One claim the analyst recorded, with the status it carries.

A review claims two kinds of thing: something the analyst asserts, and
something the analyst explicitly could not confirm. The payload records the
second kind as a claim with the `not observed` status, so it would be wrong
to read every recorded claim as an asserted conclusion.
*/
export interface ControlApiPlaytestingReviewClaim {
  readonly hypothesisId: string;
  readonly text: string;
  /**
  "hypothesis" for an asserted claim, "not observed" for an explicit null.
  */
  readonly status: "hypothesis" | "not observed";
}

/**
One finding the analyst recorded, with the evidence status it carries.

The status is the part a reader needs: a finding whose evidence was never
reproduced is still a candidate, and the Console has to be able to tell a
candidate from a verified defect.
*/
export interface ControlApiPlaytestingReviewFinding {
  readonly findingId: string;
  readonly title: string;
  readonly evidenceStatus: PlaytestFinding["evidenceStatus"];
}

/**
One persisted analyst review, as the Console reads it.

The review is the analyst's durable record about an episode: what it
observed, what it concluded, and what evidence each conclusion rests
on. It is persisted, so it outlives the Runtime process that produced
it — which is the reason this read exists at all.
*/
export interface ControlApiPlaytestingReview {
  readonly reviewId: string;
  readonly episodeId: string;
  readonly workspaceId: string;
  /**
  Which review contract the analyst ran under.
  */
  readonly kind: "discovery" | "confirmatory";
  /**
  The review's own status, verbatim from the stored payload.
  */
  readonly status: string;
  readonly createdAt: string;
  /**
  How many observations the analyst recorded.
  */
  readonly observationCount: number;
  /**
  How many interpretations — the analyst's hypotheses — the review holds.
  */
  readonly interpretationCount: number;
  /**
  How many findings the review carries.
  */
  readonly findingCount: number;
  /**
  A one-line statement of what the analyst concluded.
  */
  readonly headline: string;
  /**
  The review's chronological summary, bounded for display.
  */
  readonly summary: string;
  /**
  The analyst's interpretations, in the order the review recorded them.
  
  The count alone was not enough: a reader who sees "5 hypotheses" still
  cannot read what the analyst claimed, and the claims are the review.
  */
  readonly hypotheses: readonly ControlApiPlaytestingReviewClaim[];
  /**
  The findings the review carries, with each one's evidence status.
  */
  readonly findings: readonly ControlApiPlaytestingReviewFinding[];
  /**
  The evidence the review cites.
  */
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
}

/**
The workspace's persisted analyst reviews.

This is the durable counterpart to the analyst-run envelope, which lives
in the Runtime process and is therefore lost on restart. A reader who
ran an analysis and came back after a restart must still see it.
*/
export interface ControlApiPlaytestingReviewsResponse {
  readonly schema: "autodev-control-playtesting-reviews-v2";
  readonly workspaceId: string;
  readonly total: number;
  readonly rows: readonly ControlApiPlaytestingReview[];
  readonly nextCursor: string | null;
}

/**
Confirmation that the operator is cancelling a currently running assignment.
*/
export interface ControlApiPlaytestingRunCancellationRequest {
  readonly expectedStatus: "running";
}

/**
Explicit acknowledgement that cancellation was requested, not rollback.
*/
export interface ControlApiPlaytestingRunCancellationResponse {
  readonly schema: "autodev-control-playtesting-run-cancellation-v1";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly cancellationRequested: boolean;
}

/**
Expected-revision owner action for one stored comparison; never a deploy command.
*/
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

/**
Aggregated, suppression-aware human-study read; raw responses never cross this boundary.
*/
export interface ControlApiPlaytestingHumanValidationResponse {
  readonly schema: "autodev-control-playtesting-human-validation-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly buildSha: string;
  /**
  Separate paired-preference outcome; no PXI scale or participant IDs.
  */
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

/**
Import response exposes only reason counts and suppression-aware totals.
*/
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

/**
Consent registration acknowledgement omits participant pseudonyms.
*/
export interface ControlApiPlaytestingHumanConsentResponse {
  readonly schema: "autodev-control-playtesting-human-consent-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly recorded: true;
}

/**
Withdrawal acknowledgement contains no participant identity.
*/
export interface ControlApiPlaytestingHumanWithdrawalResponse {
  readonly schema: "autodev-control-playtesting-human-withdrawal-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly retainedParticipants: number | null;
}

/**
Quarantine read for an authorized operator; participant IDs are omitted.
*/
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

/**
Registration acknowledgement for an operator-approved study manifest.
*/
export interface ControlApiPlaytestingHumanStudyRegistrationResponse {
  readonly schema: "autodev-control-playtesting-human-study-registration-v1";
  readonly workspaceId: string;
  readonly studyId: string;
  readonly benchmarkId: string;
  readonly approved: true;
  readonly idempotent: boolean;
}

/**
Resource names exposed by the authenticated Playtesting API.
*/
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

/**
Schema identifier for the Data-owned Playtesting readiness response.
*/
export const CONTROL_API_PLAYTESTING_READINESS_SCHEMA =
  "autodev-control-playtesting-readiness-v1" as const;

/**
Readiness of the Data-owned Playtesting schema before resource reads begin.
*/
export interface ControlApiPlaytestingReadinessResponse {
  readonly schema: typeof CONTROL_API_PLAYTESTING_READINESS_SCHEMA;
  readonly workspaceId: string;
  readonly status: "initializing" | "ready";
}

/**
Data's keyset page carried across the authenticated Control API boundary.
*/
export interface ControlApiPlaytestingPage<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly nextCursor: string | null;
}

/**
Typed read-only list response; missing/unavailable is an HTTP error, not an empty page.
*/
export interface ControlApiPlaytestingPageResponse<T> {
  readonly schema: "autodev-control-playtesting-page-v1";
  readonly workspaceId: string;
  readonly resource: ControlApiPlaytestingResource;
  readonly readOnly: true;
  readonly page: ControlApiPlaytestingPage<T>;
}

/**
Workspace-bound selected episode and its newest append-only analyst review.
*/
/**
Workspace/batch/assignment-bound visual target state for one episode,
copied verbatim from the exact frozen visual batch assignment manifest.

Null for every adapter-accelerated episode, which has no visual target.
An autonomous-visual episode either carries this validated record or the
detail read fails closed: there is no "unavailable" placeholder value,
because a client cannot act on an attested batch of one that might be
wrong.
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

/**
Integrity-checked, workspace-bound bounded JSONL evidence window.
*/
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

/**
Compile-time entity mapping for Console/server consumers.
*/
export type ControlApiPlaytestingEntityMap = {
  readonly batches: PlaytestBatch;
  readonly episodes: PlaytestEpisode;
  readonly findings: PlaytestFinding;
  readonly comparisons: PlaytestComparison;
  readonly benchmarks: PlaytestBenchmark;
  readonly experiments: PlaytestExperiment;
  readonly "human-studies": HumanPlaytestStudy;
};

/**
Workspaces-owned operator approval; the response never contains local secret material.
*/
export interface ControlApiWorkspacePlaytestApprovalResponse {
  readonly schema: "autodev-control-workspace-playtest-approval-v1";
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly approval: WorkspacePlaytestApproval | null;
}

/**
Workspaces-owned list of approved visual targets; no Runtime readiness claim.
*/
export interface ControlApiWorkspaceVisualPlaytestTargetsResponse {
  readonly schema: "autodev-control-workspace-visual-playtest-targets-v1";
  readonly workspaceId: string;
  readonly workspaceEnabled: boolean;
  readonly targets: readonly WorkspaceVisualPlaytestTargetApproval[];
}
