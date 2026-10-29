import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  buildReconciliationView,
  CONTROL_API_CONTRACT,
  type ControlApiAgentDetailResponse,
  type ControlApiAgentEnablementPatchResponse,
  type ControlApiAgentRecord,
  type ControlApiAgentsResponse,
  type ControlApiContractResponse,
  type ControlApiEvaluationsResponse,
  type ControlApiGithubResponse,
  type ControlApiHookDeclaration,
  type ControlApiHookEvent,
  type ControlApiHookEventPatchResponse,
  type ControlApiHooksResponse,
  type ControlApiLiveAgentCounts,
  type ControlApiMcpAppliedServer,
  type ControlApiMcpDeclaredServer,
  type ControlApiMcpRuntimeHealth,
  type ControlApiMcpRuntimeHealthCounts,
  type ControlApiMcpRuntimeServer,
  type ControlApiMcpServerPatchResponse,
  type ControlApiMcpsResponse,
  type ControlApiModelPatchResponse,
  type ControlApiModelsResponse,
  type ControlApiPermissionPolicy,
  type ControlApiPermissionsPatchRequest,
  type ControlApiPermissionsPatchResponse,
  type ControlApiPermissionsResponse,
  type ControlApiPromptCommandPatchResponse,
  type ControlApiPromptDetailResponse,
  type ControlApiPromptsResponse,
  type ControlApiPromptVersionResponse,
  type ControlApiPromptVersionsResponse,
  type ControlApiProviderEnabledPatchResponse,
  type ControlApiProviderHealth,
  type ControlApiProviderLimitsPatchResponse,
  type ControlApiProviderModelDiscovery,
  type ControlApiProviderModelsResponse,
  type ControlApiProviderRoleAssignment,
  type ControlApiProviderRolePatchResponse,
  type ControlApiProvidersResetRequest,
  type ControlApiProvidersResetResponse,
  type ControlApiProvidersResponse,
  type ControlApiRoutingResponse,
  type ControlApiRuntimeResponse,
  type ControlApiSkillContentPatchResponse,
  type ControlApiSkillContentResponse,
  type ControlApiSkillRolesPatchResponse,
  type ControlApiSkillsResponse,
  type ControlApiToolsResponse,
  type ControlApiWorkspacePatchResponse,
  type ControlApiWorkspacesResponse,
  type GithubActionsRuntimeStatus,
  type GithubWorkflowDefinition,
  type GithubWorkflowRun,
  type GithubWorkflowState,
  type HookAction,
  type HookEvent,
  isHookEvent,
  isSandboxMode,
  LOCAL_CONTROL_API_ACTOR,
  type McpServerResource,
  type OperationHistoryEntry,
  PROVIDER_ROLES,
  providerHealthReadiness,
  type ProviderRole,
  type ProviderRoleAssignment,
  type ReconciliationDiff,
  type ReconciliationEvidence,
  type ReconciliationStatus,
  type ReconciliationView,
  type SandboxMode,
  type SkillScopeFacts,
  type ToolCatalogItem,
  type ToolCatalogView,
  workspaceConfigurationHealth,
  type WorkspaceRuntimeAvailability
} from "@simulatorlife/autodev-core";
import {
  assignSkillRoles,
  auditEnvelopesToHistory,
  boundReconciliationError,
  ConfigRepository,
  contractSkillRoles,
  EvaluationRepository,
  EvaluationSourceUnavailableError,
  ExecutionContractConflictError,
  executionContractRevision,
  ExecutionContractValidationError,
  getDefaultRestrictedHumanResponseRepository,
  GithubActionsAdapter,
  GithubActionsApiError,
  type GithubActionsRuntimeSnapshot,
  type GithubApiWorkflow,
  GithubWorkflowRepository,
  PermissionPolicyConflictError,
  permissionPolicyGeneration,
  PermissionPolicyValidationError,
  PlaytestRepository,
  readPermissionPolicyFile,
  readRoleSandboxModes,
  reconcileDiffSummary,
  reconcileDiffWithIdentifier,
  resolveSkillScopes,
  type RestrictedHumanResponseRepository,
  RULE_SYNC_COMMAND_HISTORY_MAX_PAGE_SIZE,
  RULE_SYNC_COMMAND_HISTORY_PAGE_SIZE,
  RuleSyncCommandConflictError,
  type RuleSyncCommandHistoryPage,
  RuleSyncCommandValidationError,
  RuleSyncHooksConflictError,
  RuleSyncHooksValidationError,
  RuleSyncMcpConflictError,
  RuleSyncMcpValidationError,
  RuleSyncRepository,
  RuleSyncSkillConflictError,
  RuleSyncSkillSourceUnavailableError,
  RuleSyncSkillValidationError,
  ToolCatalogAdapter,
  updatePermissionPolicy,
  updateWorkspaceCatalogEntry,
  WorkspaceCatalogConflictError,
  type WorkspaceCatalogField,
  WorkspaceCatalogUnknownWorkspaceError,
  WorkspaceCatalogValidationError,
  type WorkspaceCatalogWrite,
  WorkspacePlaytestApprovalRepository,
  type WorkspaceVisualPlaytestTargetRepository
} from "@simulatorlife/autodev-data";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { getDefaultRouterLifecycle } from "@simulatorlife/autodev-runtime/router/lifecycle";
import { getDefaultPersistenceManager } from "@simulatorlife/autodev-runtime/router/persistence";
import {
  ROUTES,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import { getDefaultUsageTracker } from "@simulatorlife/autodev-runtime/router/usage";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { readRuntimeSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import {
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";

import {
  installedSkillMatches,
  materializeCommands,
  materializeCurrentHookProjections,
  materializeCurrentMcpConfiguration,
  materializeRuleSyncSkillProjections
} from "../platform/install-materializer.ts";
import type { PlaytestRunControl } from "../playtesting/mcp.ts";
import { getDefaultPlaytestRunControl } from "../playtesting/run-control-service.ts";
import { errorBody, ROUTER_INSTANCE_ID, sendJson } from "../router/proxy.ts";
import {
  executionContractFile,
  executionContractObserved,
  getDefaultExecutionContract,
  reloadExecutionContract
} from "../router/subagents.ts";
import { routerTelemetryTracer } from "../router/telemetry.ts";
import { readControlApiJsonObject } from "./body.ts";
import { handleMemoryControlApiRequest } from "./memory.ts";
import {
  handlePlaytestingControlApiRequest,
  type PlaytestingControlRepository
} from "./playtesting.ts";
import {
  handlePlaytestingHumanStudyControlApiRequest,
  type PlaytestingHumanStudyRepository
} from "./playtesting-human-studies.ts";
import { handlePlaytestingRunControlRequest } from "./playtesting-run-control.ts";
import { handleWorkspacePlaytestingApprovalRequest } from "./workspace-playtesting.ts";
import { handleWorkspaceVisualPlaytestTargetRequest } from "./workspace-visual-playtesting.ts";

export const CONTROL_API_BASE = "/control";
export const CONTROL_API_PATHS = {
  contracts: CONTROL_API_CONTRACT.path,
  agents: "/control/agents",
  providers: "/control/providers",
  providersReset: "/control/providers/reset",
  providerModels: "/control/provider-models",
  models: "/control/models",
  mcps: "/control/mcps",
  mcpRuntime: "/control/mcp-runtime",
  mcpApplied: "/control/mcp-applied",
  tools: "/control/tools",
  skills: "/control/skills",
  hooks: "/control/hooks",
  hooksApplied: "/control/hooks-applied",
  permissions: "/control/permissions",
  prompts: "/control/prompts",
  workspaces: "/control/workspaces",
  routing: "/control/routing",
  runtime: "/control/runtime",
  memory: "/control/memory",
  evaluations: "/control/evaluations",
  github: "/control/github",
  playtesting: "/control/playtesting",
  playtestingReadiness: "/control/playtesting/readiness",
  playtestingInitialization: "/control/playtesting/initialize",
  concurrency: "/control/runtime/concurrency"
} as const;

const PLAYTESTING_CAPABILITIES_PATH = `${CONTROL_API_PATHS.playtesting}/capabilities`;
const PLAYTESTING_RUNS_PATH = `${CONTROL_API_PATHS.playtesting}/runs`;
const PLAYTEST_SERVICE_NOT_MATCHED = { kind: "not-matched" } as const;

const PROVIDER_ROLE_PATH = new RegExp(
  `^/control/providers/([a-zA-Z0-9._-]+)/roles/(${PROVIDER_ROLES.join("|")})$`,
  "u"
);
const PROVIDER_LIMITS_PATH =
  /^\/control\/providers\/([a-zA-Z0-9._-]+)\/limits$/u;
const PROVIDER_PATH = /^\/control\/providers\/([a-zA-Z0-9._-]+)$/u;
const DEFAULT_REPO_ROOT = resolveRuntimeSourceRoot(
  import.meta.dirname,
  process.env.AUTODEV_REPO_ROOT
);

const MODEL_EFFORT_SUFFIX = /-(low|medium|high)$/;
function modelEffort(model: unknown): string | null {
  return typeof model === "string"
    ? (MODEL_EFFORT_SUFFIX.exec(model)?.[1] ?? null)
    : null;
}

interface ModelCatalogReasoningInfo {
  readonly defaultLevel: string | null;
  readonly supportedLevels: readonly string[];
}

interface CachedModelCatalog {
  readonly mtimeMs: number;
  readonly reasoningLevels: Map<string, ModelCatalogReasoningInfo>;
  readonly displayNames: Map<string, string>;
}
const MODEL_CATALOG_CACHE = new Map<string, CachedModelCatalog>();

/**
 * The reasoning level a catalog entry defaults to, or `null` when it declares
 * none. A catalog is untrusted JSON, so every field is read as `unknown`.
 */
function catalogDefaultReasoningLevel(entry: object): string | null {
  const raw = (entry as { default_reasoning_level?: unknown })
    .default_reasoning_level;
  return typeof raw === "string" ? raw : null;
}

/** The reasoning levels a catalog entry supports, in the order it lists them. */
function catalogSupportedReasoningLevels(entry: object): readonly string[] {
  const raw = (entry as { supported_reasoning_levels?: unknown })
    .supported_reasoning_levels;
  if (!Array.isArray(raw)) return [];
  const levels: string[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { effort?: unknown }).effort === "string"
    ) {
      levels.push((item as { effort: string }).effort);
    }
  }
  return levels;
}

/** The display name a catalog entry declares, or `null` when it declares none. */
function catalogDisplayName(entry: object): string | null {
  const raw = (entry as { display_name?: unknown }).display_name;
  return typeof raw === "string" ? raw : null;
}

function loadModelCatalogData(catalogPath: string): CachedModelCatalog {
  const stat = statSync(catalogPath);
  const cached = MODEL_CATALOG_CACHE.get(catalogPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }
  const levels = new Map<string, ModelCatalogReasoningInfo>();
  const names = new Map<string, string>();
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models?: unknown;
    };
    if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models as unknown[]) {
        if (!entry || typeof entry !== "object") continue;
        const slug = (entry as { slug?: unknown }).slug;
        if (typeof slug !== "string") continue;
        levels.set(slug, {
          defaultLevel: catalogDefaultReasoningLevel(entry),
          supportedLevels: catalogSupportedReasoningLevels(entry)
        });
        const displayName = catalogDisplayName(entry);
        if (displayName !== null) names.set(slug, displayName);
      }
    }
  } catch {
    // An unreadable catalog leaves reasoning levels and display names unobserved.
  }
  const result: CachedModelCatalog = {
    mtimeMs: stat.mtimeMs,
    reasoningLevels: levels,
    displayNames: names
  };
  MODEL_CATALOG_CACHE.set(catalogPath, result);
  return result;
}

function modelCatalogReasoningLevels(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Map<string, ModelCatalogReasoningInfo> {
  const catalogPath = path.join(
    repositoryRoot,
    "config",
    "catalogs",
    "codex-model-catalog.json"
  );
  if (!existsSync(catalogPath)) return new Map();
  try {
    return loadModelCatalogData(catalogPath).reasoningLevels;
  } catch {
    return new Map();
  }
}

/**
 * Whether a submitted agent limit is usable. `null` is Unlimited; any other
 * value must be an integer of at least one, so a zero, a fraction, a string or
 * a non-finite number cannot become an active limit.
 */
function isAgentLimitBody(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 1)
  );
}
const MODEL_PATH = /^\/control\/models\/([a-zA-Z0-9._-]+)$/u;
const AGENT_DETAIL_PATH = /^\/control\/agents\/([a-zA-Z0-9._-]+)$/u;
const PROMPT_DETAIL_PATH = /^\/control\/prompts\/([a-zA-Z0-9._-]+)$/u;
const MCP_SERVER_PATH =
  /^\/control\/mcps\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const HOOK_EVENT_PATH = /^\/control\/hooks\/([a-z][A-Za-z]{0,63})$/u;
/**
 * One workspace's own configuration route.
 *
 * The owner and the repository are separate segments, because a workspace is
 * an `owner/repository` pair and the route has to name it the way the Console
 * names it. A percent-encoded slash inside one segment would be a different
 * key from the pair the catalog is indexed by.
 */
const WORKSPACE_DETAIL_PATH = /^\/control\/workspaces\/([^/\s]+)\/([^/\s]+)$/u;
const SKILL_ROLES_PATH = /^\/control\/skills\/([a-zA-Z0-9._-]+)$/u;
const SKILL_CONTENT_PATH = /^\/control\/skills\/([a-z0-9-]{1,64})\/content$/u;
const SKILL_CONTENT_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const AGENT_ENABLEMENT_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SKILL_CONTENT_REQUEST_MAX_BYTES = 300_000;
const routerStateMutationTails = new Map<string, Promise<void>>();

/**
 * Shared serialization key for every Control API mutation that persists the
 * Runtime's shared router state (provider role, provider enabled, provider
 * limits, model enabled, agent enablement, runtime concurrency, and the
 * providers reset). A single key rather than one per resource, because reset
 * spans multiple provider settings and must not interleave with a mutation
 * whose failure rollback could otherwise overwrite part of that state.
 */
const ROUTER_STATE_MUTATION_KEY = "router-state";

async function serializeRouterStateMutation<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = routerStateMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  routerStateMutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (routerStateMutationTails.get(key) === tail)
      routerStateMutationTails.delete(key);
  }
}

/**
 * The contract's digest, read without throwing.
 *
 * A contract that cannot be read is reported as `null` rather than as a
 * revision: the assignment view must still render, and it has to be able to say
 * that the revision is unavailable instead of refusing to draw.
 */
function readContract(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
const PROMPT_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const CONTROL_API_COLLATOR = new Intl.Collator();
const EXECUTION_CONTRACT_SOURCE = "execution-contract" as const;
const MD_EXTENSION_PATTERN = /\.md$/u;
const CONTROL_VARY_HEADER = "Authorization, X-AutoDev-Actor";
/**
 * The audit reason for a request whose method the route does not accept.
 *
 * Named because it is one reason and it is written in one place: a reason
 * spelled out at every call site is a reason the audit log can spell two
 * ways.
 */
const AUDIT_REASON_METHOD_NOT_ALLOWED = "method_not_allowed";
/**
 * The methods a route that is read and written allows.
 *
 * Named because it is one answer -- what a route allows -- and it is written
 * in four places.
 */
const ALLOWED_METHODS_READ_AND_PATCH = "GET, PATCH";
const GITHUB_CONTROL_API_SCHEMA = "autodev-control-github-v1";
const GITHUB_WORKFLOW_YAML_SOURCE = ".github/workflows";
/**
 * Where the MCP runtime observations come from.
 *
 * Named so the reader can tell an observation apart from a declaration: the
 * MCP catalog's source is `.rulesync/mcp.jsonc`, and this is the Runtime's own
 * telemetry of the servers it has seen.
 */
const MCP_RUNTIME_EVIDENCE_SOURCE = "runtime.telemetry";

export type ControlApiRole = "viewer" | "operator";

/** Trusted host options for isolated Control API integration tests. */
export interface ControlApiRequestOptions {
  readonly repositoryRoot?: string;
  readonly codexHome?: string;
  /**
   * The user's home directory, which is where the runtime's skills are
   * installed. The host owns it; a request never chooses it.
   */
  readonly home?: string;
  /** Test seams for Data-owned readers; never supplied by a request. */
  readonly playtestingRepository?: PlaytestingControlRepository;
  readonly playtestingHumanStudyRepository?: PlaytestingHumanStudyRepository;
  readonly restrictedHumanResponseRepository?: RestrictedHumanResponseRepository;
  /** Must be the same Runtime run-control instance exposed by the MCP facade. */
  readonly playtestingRunControl?: PlaytestRunControl;
  readonly workspacePlaytestApprovalRepository?: WorkspacePlaytestApprovalRepository;
  readonly workspaceVisualPlaytestTargetRepository?: WorkspaceVisualPlaytestTargetRepository;
}

export interface ControlApiActor {
  actor: string;
  role: ControlApiRole;
  /** Private Playtesting credential; its route and bound role are enforced. */
  readonly playtestingService?: true;
  readonly playtestingServiceRole?:
    "playtester" | "validator" | "root" | "operator";
}
export interface ControlApiConfig {
  serviceToken: string;
  viewers: ReadonlySet<string>;
  operators: ReadonlySet<string>;
}
export type ControlApiAvailability =
  | { enabled: false; reason: string }
  | { enabled: true; config: ControlApiConfig };
export type ControlApiAuthorization =
  | ({ authorized: true } & ControlApiActor)
  | {
      authorized: false;
      status: number;
      code: string;
      message: string;
    };

function actorSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((actor) => actor.trim())
      .filter((actor) => actor.length > 0 && ACTOR_ID_PATTERN.test(actor))
  );
}

export function getControlApiAvailability(
  env: NodeJS.ProcessEnv = process.env
): ControlApiAvailability {
  const serviceToken = env.AUTODEV_CONTROL_API_TOKEN?.trim() ?? "";
  const viewers = actorSet(env.AUTODEV_CONTROL_VIEWERS);
  const operators = actorSet(env.AUTODEV_CONTROL_OPERATORS);
  if (!serviceToken) {
    return {
      enabled: false,
      reason: "Configure AUTODEV_CONTROL_API_TOKEN."
    };
  }
  // A private, service-authenticated request from the Console is the local
  // single-user identity. Explicit actor allowlists replace this local mode.
  if (viewers.size === 0 && operators.size === 0)
    operators.add(LOCAL_CONTROL_API_ACTOR);
  return { enabled: true, config: { serviceToken, viewers, operators } };
}

function header(request: IncomingMessage, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function actorClaim(request: IncomingMessage): string | null {
  const actor = header(request, "x-autodev-actor");
  return actor && ACTOR_ID_PATTERN.test(actor) ? actor : null;
}

function secretMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeControlApiRequest(
  request: IncomingMessage,
  availability: ControlApiAvailability = getControlApiAvailability()
): ControlApiAuthorization {
  if (!availability.enabled) {
    return {
      authorized: false,
      status: 503,
      code: "autodev_control_api_disabled",
      message: availability.reason
    };
  }
  const authorization = header(request, "authorization");
  if (
    !authorization ||
    !secretMatches(authorization, "Bearer " + availability.config.serviceToken)
  ) {
    return {
      authorized: false,
      status: 401,
      code: "autodev_control_api_unauthorized",
      message:
        "Control API requires the AutoDev server-side service credential."
    };
  }
  const actor = actorClaim(request);
  if (!actor) {
    return {
      authorized: false,
      status: 401,
      code: "autodev_control_api_actor_missing",
      message: "Control API requires a verified AutoDev user identity."
    };
  }
  if (availability.config.operators.has(actor))
    return { authorized: true, actor, role: "operator" };
  if (availability.config.viewers.has(actor))
    return { authorized: true, actor, role: "viewer" };
  return {
    authorized: false,
    status: 403,
    code: "autodev_control_api_actor_forbidden",
    message: "The AutoDev user is not authorized for AutoDev control."
  };
}

function recordMutationTelemetry(record: {
  actorVerified: boolean;
  role: ControlApiRole | null;
  action: string;
  resource: string;
  outcome: "ok" | "denied" | "error";
  reason?: string;
}): void {
  const attributes: Record<string, string | boolean> = {
    "autodev.control.action": record.action,
    "autodev.control.resource": record.resource.slice(0, 200),
    "autodev.control.outcome": record.outcome,
    "autodev.control.actor_verified": record.actorVerified
  };
  if (record.role) attributes["autodev.control.actor_role"] = record.role;
  if (record.reason) attributes["error.type"] = record.reason;
  try {
    const span = routerTelemetryTracer().startSpan("autodev.control.mutation", {
      attributes
    });
    span.setStatus(
      record.outcome === "ok"
        ? { code: SpanStatusCode.OK }
        : {
            code: SpanStatusCode.ERROR,
            message: "control mutation did not succeed"
          }
    );
    span.end();
  } catch {
    // Telemetry failure must never change the outcome of a control operation.
  }
}

function auditMutation(record: {
  actor: string | null;
  actorVerified: boolean;
  role: ControlApiRole | null;
  action: string;
  resource: string;
  outcome: "ok" | "denied" | "error";
  changes: Record<string, unknown> | null;
  reason?: string;
  desiredGeneration?: string | null;
  observedGeneration?: string | null;
  restartRequired?: boolean;
}): void {
  const restartRequired = record.restartRequired === true;
  const event: Record<string, unknown> = {
    schema: "autodev-control-api-audit-v1",
    timestamp: new Date().toISOString(),
    routerInstanceId: ROUTER_INSTANCE_ID,
    actor: record.actor,
    actorVerified: record.actorVerified,
    actorRole: record.role,
    action: record.action,
    resource: record.resource.slice(0, 200),
    outcome: record.outcome,
    changes: record.changes,
    desiredGeneration: record.desiredGeneration ?? null,
    observedGeneration: record.observedGeneration ?? null,
    restartRequired
  };
  if (record.reason) event.reason = record.reason;
  writeErrorLine(JSON.stringify(event));
  recordAuditEnvelope(event);
  recordMutationTelemetry(record);
}

/**
 * Bounded, in-memory ring of recent audit envelopes. The Runtime keeps the
 * most recent 32 entries so the Control API GET responses can surface a
 * bounded operation history on the Console without touching the stderr
 * audit sink or duplicating the audit storage. Newest entries come first.
 */
const OPERATION_HISTORY_BUFFER = 32;
const auditHistory: Record<string, unknown>[] = [];

function recordAuditEnvelope(event: Record<string, unknown>): void {
  auditHistory.unshift(event);
  if (auditHistory.length > OPERATION_HISTORY_BUFFER) {
    auditHistory.length = OPERATION_HISTORY_BUFFER;
  }
}

/**
 * Returns the bounded operation history filtered by the supplied resource
 * prefix. Callers pass the canonical resource path (`/control/...` or the
 * resource id) and the runtime returns only envelopes whose `resource`
 * field matches.
 */
export function getOperationHistory(
  resourceFilter?: string | null
): readonly Record<string, unknown>[] {
  if (!resourceFilter) return [...auditHistory];
  const filter = resourceFilter.trim();
  if (!filter) return [...auditHistory];
  return auditHistory.filter(
    (entry) =>
      typeof entry.resource === "string" && entry.resource.startsWith(filter)
  );
}

/** Test-only escape hatch: clears the in-memory audit ring. */
export function resetOperationHistoryForTests(): void {
  auditHistory.length = 0;
}

function sendControlError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_control_api_error", { code }),
    {
      "cache-control": "no-store",
      vary: CONTROL_VARY_HEADER
    }
  );
}

/** Live router evidence keyed by provider id. */
export type ControlApiProviderHealthSource = (
  now: number
) => Readonly<Record<string, ControlApiProviderHealth>>;

/** Canonical Runtime activity source for the read-only live-count projection. */
export type ControlApiLiveAgentCountsSource = (
  now: number
) => ControlApiLiveAgentCounts;

/**
 * The Runtime's observation of the MCP servers it has seen.
 *
 * Registered by the router, like the live agent counts: a Control API that
 * runs without a router has no live evidence to publish, and it says so
 * rather than reporting an empty observation as a fact.
 */
export type ControlApiMcpObservationsSource =
  () => readonly ControlApiMcpRuntimeServer[];

let providerHealthSource: ControlApiProviderHealthSource | null = null;
let liveAgentCountsSource: ControlApiLiveAgentCountsSource | null = null;
let mcpObservationsSource: ControlApiMcpObservationsSource | null = null;
let providerModelDiscoverySource:
  (() => ControlApiProviderModelsResponse) | null = null;

/**
 * The router registers its live per-provider evidence here. Without a
 * registered source (for example a standalone Control API in tests) provider
 * health is reported as unobserved rather than healthy.
 */
export function setControlApiProviderHealthSource(
  source: ControlApiProviderHealthSource | null
): void {
  providerHealthSource = source;
}

/**
 * The router registers its live activity projection here. A standalone Control
 * API has no live evidence and reports `null` rather than an observed zero.
 */
export function setControlApiLiveAgentCountsSource(
  source: ControlApiLiveAgentCountsSource | null
): void {
  liveAgentCountsSource = source;
}

/**
 * The router registers its observation of the MCP servers it has seen here.
 * Without a registered source the MCP runtime read reports the evidence as
 * unavailable rather than reporting an empty observation.
 */
export function setControlApiMcpObservationsSource(
  source: ControlApiMcpObservationsSource | null
): void {
  mcpObservationsSource = source;
}

/** Register the Runtime-owned provider model discovery snapshot. */
export function setControlApiProviderModelDiscoverySource(
  source: (() => ControlApiProviderModelsResponse) | null
): void {
  providerModelDiscoverySource = source;
}

function providerTierPriorities(
  provider: string
): { tier: string; group: number }[] {
  return Object.entries(ROUTING_POLICY.config.providerGroups).flatMap(
    ([tier, groups]) => {
      const index = groups.findIndex((group) =>
        group.some((name) => name.trim().toLowerCase() === provider)
      );
      return index === -1 ? [] : [{ tier, group: index + 1 }];
    }
  );
}

function providerRoleConvergence(
  provider: string,
  role: ProviderRole
): ReconciliationStatus {
  const resource = `${CONTROL_API_PATHS.providers}/${provider}/roles/${role}`;
  const latest = findLatestAuditFor(resource);
  const observed =
    ROUTING_POLICY.isProviderEnabledForRole(provider, role) === true;
  const desiredGeneration = `${role}:enabled=${observed ? "true" : "false"}`;
  const observedGeneration = desiredGeneration;
  return buildReconciliationView({
    evidence: {
      desiredGeneration,
      observedGeneration,
      lastApplyAt: latest?.timestamp ?? null,
      lastObservationAt: latest?.timestamp ?? null,
      lastError: boundReconciliationError(latest?.reason ?? null)
    },
    history: historyForResource(resource),
    hasObservation: latest !== null
  }).status;
}

/**
 * The provider's own audit resources: the provider path itself (its global
 * enablement), its agent limits, and its role assignments.
 *
 * `getOperationHistory` matches by prefix, so the provider path `claude` would
 * also match the history of a provider named `claude-code`. A provider's
 * resources are therefore matched exactly here: the provider path itself, or
 * anything under it.
 */
function isProviderResource(provider: string, resource: string): boolean {
  const base = `${CONTROL_API_PATHS.providers}/${provider}`.toLowerCase();
  const candidate = resource.toLowerCase();
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * The audit envelopes recorded for one provider's own resources.
 *
 * The provider path is recorded with the id as it was typed, so the comparison
 * ignores case.
 */
function providerAuditEnvelopes(
  provider: string
): readonly Record<string, unknown>[] {
  return getOperationHistory().filter(
    (entry) =>
      typeof entry.resource === "string" &&
      isProviderResource(provider, entry.resource)
  );
}

function historyForProvider(
  provider: string
): readonly OperationHistoryEntry[] {
  return auditEnvelopesToHistory(providerAuditEnvelopes(provider));
}

/**
 * The identity of one provider's configured routing state.
 *
 * The state covered here is the part of the routing policy the operator can
 * change through the Control API: whether the provider is disabled, its agent
 * limits, and its assignment in each provider role. The digest is taken over a
 * canonical serialization of that state, so it changes exactly when the
 * provider's configuration changes and is the same for two providers in the
 * same state.
 *
 * The role assignments are recorded as the operator set them. An assignment
 * that was never made reads as `unset` rather than as the default priority,
 * because "the operator chose this" and "nobody has touched this" are
 * different histories for the same served configuration.
 */
function providerConfigurationGeneration(provider: string): string {
  const limits = ROUTING_POLICY.limitsFor(provider);
  const roles = PROVIDER_ROLES.map((role) => {
    const assignment = ROUTING_POLICY.assignmentFor(provider, role);
    return [
      role,
      assignment?.priority ?? "unset",
      assignment?.model ?? "unset",
      assignment?.reasoningEffort ?? "unset"
    ].join(":");
  }).join(",");
  const serialized = [
    `enabled=${ROUTING_POLICY.isProviderEnabled(provider) ? "true" : "false"}`,
    `limits=${
      limits
        ? `${limits.perSession ?? "unlimited"}/${limits.acrossSessions ?? "unlimited"}`
        : "unlimited"
    }`,
    `roles=${roles}`
  ].join(";");
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * The reconciliation view for one provider.
 *
 * A provider's routing configuration is Runtime-owned: the router consults the
 * live routing policy for every request, so there is no separate projection to
 * refresh and nothing to restart between an apply and its effect. The desired
 * generation is therefore the provider's configured routing state, and the
 * observed generation is that same state read back from the policy the router
 * serves.
 *
 * The two cannot drift apart on their own, so what the view really reports is
 * *whether an apply has been observed*: a provider nobody has written through
 * the Control API stays `not-observed`, and a provider whose last write failed
 * reports that error. Both generations are still reported, because "what the
 * operator asked for" and "what the runtime has observed" are two separate
 * statements and the panel shows both.
 */
function providerReconciliationView(provider: string): ReconciliationView {
  const desiredGeneration = providerConfigurationGeneration(provider);
  const latest = latestAuditEvidence(providerAuditEnvelopes(provider));
  const observed = latest !== null;
  return buildReconciliationView({
    evidence: {
      desiredGeneration,
      observedGeneration: observed ? desiredGeneration : null,
      lastApplyAt: latest?.timestamp ?? null,
      lastObservationAt: latest?.timestamp ?? null,
      lastError: boundReconciliationError(latest?.reason ?? null)
    },
    history: historyForProvider(provider),
    hasObservation: observed
  });
}

/**
 * Desired-vs-actual verdict for one model's enablement.
 *
 * Model enablement is the same kind of mutable resource as a provider role: the
 * live routing policy *is* the applied state, so the two generations cannot drift
 * apart on their own. What is genuinely unknown is whether anything has been
 * applied yet, so convergence stays `not-observed` until a write is recorded for
 * this model. Deriving the verdict here rather than from the toggle's on/off
 * keeps "the model is enabled" and "we have observed that enablement converge"
 * as two separate, separately-evidenced statements.
 */
function modelConvergence(model: string): ReconciliationStatus {
  const latest = findLatestAuditFor(model);
  const live = ROUTING_POLICY.isModelEnabled(model) === true;
  const desiredGeneration = `enabled=${live ? "true" : "false"}`;
  const observedGeneration = desiredGeneration;
  return buildReconciliationView({
    evidence: {
      desiredGeneration,
      observedGeneration,
      lastApplyAt: latest?.timestamp ?? null,
      lastObservationAt: latest?.timestamp ?? null,
      lastError: boundReconciliationError(latest?.reason ?? null)
    },
    history: historyForResource(model),
    hasObservation: latest !== null
  }).status;
}

/**
 * One entry per provider role, keyed by role.
 *
 * `Object.fromEntries` over `PROVIDER_ROLES` produces exactly this at runtime,
 * but its result type is an index signature, so the compiler saw a record that
 * might be missing every role and rejected it against `Record<ProviderRole, …>`.
 * The cast is confined here, and it is safe precisely because the loop runs over
 * the same `PROVIDER_ROLES` the record type enumerates -- adding a role to Core
 * adds it to the loop, so the two cannot fall out of step.
 */
function rolesForEveryProviderRole(
  build: (role: ProviderRole) => ControlApiProviderRoleAssignment
): Record<ProviderRole, ControlApiProviderRoleAssignment> {
  const assigned = {} as Record<ProviderRole, ControlApiProviderRoleAssignment>;
  for (const role of PROVIDER_ROLES) assigned[role] = build(role);
  return assigned;
}

function providersView(now: number): Record<string, unknown> {
  const names = ROUTING_POLICY.providerIds();
  const reasoningEffort = ROUTING_POLICY.config.orchestrator.reasoningEffort;
  const health = providerHealthSource?.(now) ?? null;
  const reasoningCatalog = modelCatalogReasoningLevels();
  const providers = names.map((provider) => {
    const route = ROUTES.find((entry) => entry.provider === provider) ?? null;
    const disabled = !ROUTING_POLICY.isProviderEnabled(provider);
    const agentLimits = ROUTING_POLICY.limitsFor(provider) ?? null;
    const assignments = Object.fromEntries(
      PROVIDER_ROLES.map((role) => [
        role,
        ROUTING_POLICY.assignmentFor(provider, role)
      ])
    );
    const links = ROUTING_POLICY.config.providers[provider]?.links;
    return {
      id: provider,
      links: {
        usage: links?.usage ?? null,
        documentation: links?.documentation ?? null
      },
      route: route
        ? {
            pattern: route.pattern.source,
            baseUrl: route.baseUrl,
            healthUrl: route.healthUrl ?? null
          }
        : null,
      credential: {
        envKey: route?.envKey ?? null,
        configured: ROUTING_POLICY.routeCredentialAvailable(route)
      },
      disabled,
      // Derived from PROVIDER_ROLES so a role added to Core cannot be missing
      // from this response.
      roles: rolesForEveryProviderRole((role) => {
        const assignment = assignments[role];
        const assignedModel = assignment?.model ?? null;
        const configuredEffort =
          assignment?.reasoningEffort ??
          (role === "orchestrator"
            ? (reasoningEffort?.[provider] ?? null)
            : null);
        const modelInfo = assignedModel
          ? reasoningCatalog.get(assignedModel)
          : undefined;
        const supportedReasoningLevels = modelInfo?.supportedLevels ?? [];
        const isAgyFixed =
          provider === "antigravity" &&
          Boolean(modelEffort(assignedModel ?? ""));
        const effectiveReasoningEffort = isAgyFixed
          ? modelEffort(assignedModel ?? "")
          : (configuredEffort ?? modelInfo?.defaultLevel ?? null);
        const reasoningEffortInForce =
          !isAgyFixed ||
          configuredEffort === null ||
          configuredEffort === effectiveReasoningEffort;

        return {
          // An unobserved assignment is reported as enabled rather than as
          // a disabled role: a provider nobody has touched must keep routing,
          // and "disabled" is a decision the operator makes.
          priority: disabled ? "disabled" : (assignment?.priority ?? 1),
          model: assignedModel,
          reasoningEffort: configuredEffort,
          effectiveReasoningEffort,
          reasoningEffortInForce,
          supportedReasoningLevels,
          // A globally disabled provider's roles cannot be edited until it
          // is enabled again, but their values are preserved.
          mutable: !disabled,
          convergence: providerRoleConvergence(provider, role)
        };
      }),
      agentLimits,
      models: Object.entries(
        ROUTING_POLICY.config.providers[provider]?.models ?? {}
      ).map(([tier, model]) => ({ tier, model: model.trim() })),
      priorities: providerTierPriorities(provider),
      orchestratorReasoningEffort: reasoningEffort?.[provider] ?? null,
      health: health?.[provider] ?? null,
      reconciliation: providerReconciliationView(provider)
    };
  });
  return {
    schema: "autodev-control-providers-v3",
    orchestratorTier: ROUTING_POLICY.config.orchestrator.tier,
    tiers: Object.entries(ROUTING_POLICY.config.providerGroups).map(
      ([tier, groups]) => ({ tier, groups })
    ),
    providers
  } satisfies ControlApiProvidersResponse;
}

function configuredRoleExposure(
  field: "mcp" | "skills"
): Array<{ name: string; roles: string[] }> {
  const exposure = new Map<string, Set<string>>();
  const roles = getDefaultExecutionContract().roles ?? {};
  for (const [role, raw] of Object.entries(roles)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const values = (raw as Record<string, unknown>)[field];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const name = value.trim();
      const exposedRoles = exposure.get(name) ?? new Set<string>();
      exposedRoles.add(role);
      exposure.set(name, exposedRoles);
    }
  }
  return Array.from(exposure, ([name, exposedRoles]) => ({
    name,
    roles: Array.from(exposedRoles).sort()
  })).sort((left, right) =>
    CONTROL_API_COLLATOR.compare(left.name, right.name)
  );
}

/**
 * Roles the execution contract defines, and therefore the only roles an
 * assignment can name.
 *
 * Enumerated from the contract rather than from `/control/agents`: the write
 * edits the contract, so a role absent from it would be refused. Offering one
 * anyway turns a correct answer into a failed submission.
 */
function assignableRoles(): string[] {
  const roles = getDefaultExecutionContract().roles ?? {};
  return Object.keys(roles).sort((left, right) =>
    CONTROL_API_COLLATOR.compare(left, right)
  );
}

/**
 * The Runtime's observation of the MCP servers it has seen.
 *
 * This is published on its own path rather than folded into the MCP catalog.
 * The catalog answers "what is declared"; this answers "what has the Runtime
 * actually reached". A page composes the two, and the contract keeps them
 * apart so that a server's presence in the catalog never reads as evidence
 * that the server was reached.
 *
 * The observations arrive through a registered source rather than through a
 * direct call into the router's telemetry, for the same reason the live agent
 * counts do: a Control API with no router attached has no live evidence, and
 * it says so rather than reporting an empty observation as a fact.
 */
function mcpRuntimeView(): Record<string, unknown> {
  // `null` means no observation source is attached: the Runtime could not be
  // asked, which is a different fact from having observed no server at all.
  const observed = mcpObservationsSource?.() ?? null;
  const servers = observed ?? [];
  // Accumulated in a mutable local and frozen into the published shape: the
  // contract's counts are readonly, so they are built rather than incremented
  // in place.
  const counts: Record<ControlApiMcpRuntimeHealth, number> = {
    ready: 0,
    error: 0,
    stale: 0,
    configured: 0,
    observed: 0
  };
  for (const server of servers) {
    counts[server.health] += 1;
  }
  const health: ControlApiMcpRuntimeHealthCounts | null =
    observed === null
      ? null
      : {
          ready: counts.ready,
          error: counts.error,
          stale: counts.stale,
          configured: counts.configured,
          observed: counts.observed
        };
  return {
    schema: "autodev-control-mcp-runtime-v1",
    source: MCP_RUNTIME_EVIDENCE_SOURCE,
    observedServers: observed === null ? null : servers.length,
    health,
    servers
  };
}

/**
 * The target whose MCP configuration the applied catalogue holds.
 *
 * The bridge catalogue is rendered from the Codex target's projection, so it
 * carries that target's launch configuration rather than a merge of every
 * target's.
 */
const MCP_APPLIED_TARGET = "codexcli";

/**
 * The applied MCP configuration the Runtime published, in the shape the
 * contract publishes.
 */
interface McpLaunchEntry {
  readonly name: string;
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly bearerTokenEnvVar: string | null;
  readonly httpHeaders: Readonly<Record<string, string>>;
}

/**
 * The digest of one side of the MCP configuration.
 *
 * Both sides are serialized through this one function, so the two digests are
 * comparable: the desired side is the canonical declaration's launch
 * configuration and the observed side is the applied projection's, and a
 * difference in any launch key changes the digest.
 */
function mcpLaunchGeneration(entries: readonly McpLaunchEntry[]): string {
  const serialized = JSON.stringify(
    entries.map((entry) => ({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      url: entry.url,
      bearerTokenEnvVar: entry.bearerTokenEnvVar,
      httpHeaders: Object.fromEntries(
        Object.entries(entry.httpHeaders).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      )
    }))
  );
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * The message a read failure carries when it has no better one.
 *
 * One spelling of it, so a failure that cannot say more reads the same way
 * wherever it happened.
 */
const UNKNOWN_READ_ERROR = "unknown error";

/**
 * Whether a value is a plain object rather than an array or null.
 *
 * The applied catalogue is untrusted input: it is a file on disk that
 * anything can write, and every field the reconciliation reads comes out of
 * it.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A launch key's value, or `null` when the key is absent or is not a string.
 *
 * The applied catalogue is untrusted input, so a key that is present but is
 * not the type the configuration uses is treated as absent rather than
 * guessed at.
 */
function launchString(candidate: unknown): string | null {
  return typeof candidate === "string" ? candidate : null;
}

/**
 * The launch configuration of one applied catalogue entry.
 *
 * A catalogue entry that is not an object, or whose launch keys are not the
 * types the configuration uses, is refused rather than guessed at: a half-read
 * entry would compare as a difference the operator cannot act on.
 */
function mcpAppliedEntry(name: string, value: unknown): McpLaunchEntry | null {
  if (!isPlainRecord(value)) return null;
  const args = value.args;
  if (
    args !== undefined &&
    (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
  )
    return null;
  const headers = value.http_headers;
  if (
    headers !== undefined &&
    (!isPlainRecord(headers) ||
      !Object.values(headers).every((entry) => typeof entry === "string"))
  )
    return null;
  return {
    name,
    command: launchString(value.command),
    args: (args as string[] | undefined) ?? [],
    cwd: launchString(value.cwd),
    url: launchString(value.url),
    bearerTokenEnvVar: launchString(value.bearer_token_env_var),
    httpHeaders: (headers as Record<string, string> | undefined) ?? {}
  };
}

/**
 * The MCP launch configuration the Runtime published.
 *
 * Read from the bridge catalogue the installer renders from the canonical
 * declaration's projection. A catalogue that is not there means the Runtime
 * has published no MCP configuration, which is a finding and not a failure;
 * a catalogue that cannot be read is a failure and is reported as one.
 */
function readAppliedMcpCatalogue(codexHome: string): {
  readonly available: boolean;
  readonly servers: readonly McpLaunchEntry[];
  readonly observedAt: string | null;
  readonly error: string | null;
} {
  const cataloguePath = path.join(
    codexHome,
    "provider-runtime",
    "mcp-servers.json"
  );
  if (!existsSync(cataloguePath))
    return {
      available: false,
      servers: [],
      observedAt: null,
      error: null
    };
  let content: string;
  try {
    content = readFileSync(cataloguePath, "utf8");
  } catch (error) {
    return {
      available: false,
      servers: [],
      observedAt: null,
      error: `The applied MCP catalogue could not be read: ${error instanceof Error ? error.message : UNKNOWN_READ_ERROR}`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      available: false,
      servers: [],
      observedAt: null,
      error: `The applied MCP catalogue is not valid JSON: ${error instanceof Error ? error.message : UNKNOWN_READ_ERROR}`
    };
  }
  if (!isPlainRecord(parsed)) {
    return {
      available: false,
      servers: [],
      observedAt: null,
      error: "The applied MCP catalogue is not an object."
    };
  }
  const servers: McpLaunchEntry[] = [];
  for (const name of Object.keys(parsed).sort(CONTROL_API_COLLATOR.compare)) {
    const entry = mcpAppliedEntry(name, parsed[name]);
    if (entry === null) {
      return {
        available: false,
        servers: [],
        observedAt: null,
        error: `The applied MCP catalogue entry "${name}" is not a usable launch configuration.`
      };
    }
    servers.push(entry);
  }
  let observedAt: string | null = null;
  try {
    observedAt = statSync(cataloguePath).mtime.toISOString();
  } catch {
    // The catalogue was read; the moment it was written is a nicety, and its
    // absence does not change what the configuration is.
  }
  return { available: true, servers, observedAt, error: null };
}

/**
 * The MCP configuration the Runtime applied, against the canonical
 * declaration.
 *
 * The two sides are compared through the shared reconciliation contract: the
 * desired generation is the declaration's launch configuration and the
 * observed generation is the applied projection's. A Control API with no
 * applied catalogue has not observed anything, and says so rather than
 * reporting a converged empty configuration.
 */
function mcpAppliedState(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string | undefined = defaultCodexHomeForReconciliation()
): {
  readonly available: boolean;
  readonly declaredServers: readonly ControlApiMcpDeclaredServer[];
  readonly servers: readonly ControlApiMcpAppliedServer[];
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly reconciliation: ReconciliationView;
} {
  const declaration = new RuleSyncRepository(repositoryRoot).loadMcpLaunchState(
    MCP_APPLIED_TARGET
  );
  const applied = readAppliedMcpCatalogue(codexHome);
  const declaredServers: ControlApiMcpDeclaredServer[] =
    declaration.servers.map((server) => ({
      name: server.name,
      command: server.command ?? null,
      args: server.args ?? [],
      cwd: server.cwd ?? null,
      url: server.url ?? null,
      bearerTokenEnvVar: server.bearerTokenEnvVar ?? null,
      httpHeaders: server.httpHeaders ?? {}
    }));
  const desiredGeneration =
    declaration.valid === true && declaredServers.length > 0
      ? mcpLaunchGeneration(declaredServers)
      : null;
  const observedGeneration =
    applied.available && applied.servers.length > 0
      ? mcpLaunchGeneration(applied.servers)
      : null;
  const evidence: ReconciliationEvidence = {
    desiredGeneration,
    observedGeneration,
    // No Control API operation applies an MCP configuration, so there is no
    // apply to date. The observation is the applied catalogue's own moment.
    lastApplyAt: null,
    lastObservationAt: applied.observedAt,
    lastError: applied.error
  };
  return {
    available: applied.available,
    declaredServers,
    servers: applied.servers,
    desiredGeneration,
    observedGeneration,
    reconciliation: buildReconciliationView({
      evidence,
      history: [],
      hasObservation: applied.available
    })
  };
}

function mcpAppliedView(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string | undefined = defaultCodexHomeForReconciliation()
): Record<string, unknown> {
  const state = mcpAppliedState(repositoryRoot, codexHome);
  return {
    schema: "autodev-control-mcp-applied-v2",
    source: path.join(codexHome, "provider-runtime", "mcp-servers.json"),
    declarationSource: ".rulesync/mcp.jsonc",
    target: MCP_APPLIED_TARGET,
    available: state.available,
    declaredServers: state.declaredServers,
    servers: state.servers,
    reconciliation: state.reconciliation
  };
}

function mcpsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const repository = new RuleSyncRepository(repositoryRoot);
  const state = repository.loadMcpState();
  // The revision is the handle a write compares against, so it is read with
  // the declaration it belongs to rather than on its own.
  const revision = repository.loadMcpRevision().revision;
  if (state.valid !== true) {
    return {
      schema: "autodev-control-mcps-v2",
      source: state.source,
      revision,
      readOnly: false,
      valid: state.valid,
      // Carried on the failure branch too: "no servers" and "these servers
      // could not be applied" are different states, and the second one is only
      // actionable with the reasons.
      issues: state.issues,
      servers: []
    };
  }

  const exposures = configuredRoleExposure("mcp");
  const rolesByServer = new Map(
    exposures.map(({ name, roles }) => [name, roles])
  );
  const declaredNames = new Set(state.servers.map((server) => server.name));
  const declared = state.servers.map((server) => ({
    ...server,
    declared: true,
    roles: rolesByServer.get(server.name) ?? []
  }));
  // Typed rather than left to inference: `transport: "unknown"` in an inferred
  // array widens to `string`, which quietly stopped satisfying the declared
  // `McpServerTransport` union and let this projection drift from the contract
  // it is supposed to publish.
  const unbackedRoleExposures: McpServerResource[] = exposures
    .filter(({ name }) => !declaredNames.has(name))
    .map(({ name, roles }) => ({
      name,
      enabled: null,
      transport: "unknown",
      targetOverrides: [],
      declared: false,
      roles
    }));
  return {
    schema: "autodev-control-mcps-v2",
    source: state.source,
    revision,
    readOnly: false,
    valid: state.valid,
    // A valid source has none. Carried explicitly rather than omitted so the
    // field means the same thing on both branches of the projection.
    issues: state.issues,
    servers: [...declared, ...unbackedRoleExposures].sort((left, right) =>
      CONTROL_API_COLLATOR.compare(left.name, right.name)
    )
  } satisfies ControlApiMcpsResponse;
}

interface ToolCatalogExecutionContractSummary {
  readonly mcp?: readonly string[];
  readonly mcpTools?: Readonly<Record<string, readonly string[]>>;
  readonly webResearch?: {
    readonly search?: boolean;
    readonly fetch?: boolean;
  };
}

interface ToolCatalogSource {
  readonly name: string;
  readonly source: ToolCatalogItem["source"];
  readonly sourceAuthority: ToolCatalogItem["sourceAuthority"];
  readonly server?: string;
  readonly availability: ToolCatalogItem["availability"];
  readonly exposedRoles: Set<string>;
}

function addToolToCatalog(
  catalog: Map<string, ToolCatalogSource>,
  input: {
    name: string;
    source: ToolCatalogItem["source"];
    sourceAuthority: ToolCatalogItem["sourceAuthority"];
    role: string;
    server?: string;
    availability: ToolCatalogItem["availability"];
  }
): void {
  if (!input.name.trim()) return;
  const key = `${input.source}\u0000${input.server ?? ""}\u0000${input.name}`;
  let item = catalog.get(key);
  if (!item) {
    item = {
      name: input.name,
      source: input.source,
      sourceAuthority: input.sourceAuthority,
      availability: input.availability,
      ...(input.server ? { server: input.server } : {}),
      exposedRoles: new Set<string>()
    };
    catalog.set(key, item);
  }
  item.exposedRoles.add(input.role);
}

function addNativeResearchTools(
  catalog: Map<string, ToolCatalogSource>,
  role: string,
  contract: { webResearch?: { search?: boolean; fetch?: boolean } }
): void {
  if (contract.webResearch?.search === true) {
    addToolToCatalog(catalog, {
      name: WEB_SEARCH_TOOL,
      source: "native",
      sourceAuthority: "codex-native",
      availability: "configured",
      role
    });
  }
  if (contract.webResearch?.fetch === true) {
    addToolToCatalog(catalog, {
      name: WEB_FETCH_TOOL,
      source: "native",
      sourceAuthority: "codex-native",
      availability: "configured",
      role
    });
  }
}

function addExecutionContractMcpTools(
  catalog: Map<string, ToolCatalogSource>,
  role: string,
  contract: { mcpTools?: unknown; mcp?: readonly string[] }
): void {
  const mcpTools = readMcpToolsRecord(contract.mcpTools);
  if (!mcpTools) return;
  for (const [server, names] of Object.entries(mcpTools)) {
    addServerAllowlistTools(catalog, server, names, role);
  }
}

function readMcpToolsRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function addServerAllowlistTools(
  catalog: Map<string, ToolCatalogSource>,
  server: string,
  names: unknown,
  role: string
): void {
  if (!Array.isArray(names)) return;
  const source: ToolCatalogItem["source"] =
    server === "codex_app" ? "plugin" : "mcp";
  const sourceAuthority: ToolCatalogItem["sourceAuthority"] =
    server === "codex_app" ? "rulesync-plugin" : "execution-contract";
  for (const name of names) {
    if (typeof name !== "string") continue;
    addToolToCatalog(catalog, {
      name,
      source,
      sourceAuthority,
      availability: "configured",
      role,
      server
    });
  }
}

function mergeRuleSyncDeclaredTools(
  catalog: Map<string, ToolCatalogSource>,
  rulesyncTools: readonly ToolCatalogItem[]
): void {
  // The RuleSync adapter is the canonical authority for declared
  // `enabled_tools` lists on every MCP target projection; merge those
  // entries so the catalog never loses a declared tool just because the
  // execution-contract role projection did not enumerate it for the current
  // role. Roles remain empty when no execution-contract role exposed the
  // tool; the entry is still presented so the operator can see the declared
  // surface.
  for (const tool of rulesyncTools) {
    if (tool.exposedRoles.length > 0) continue;
    const key = `${tool.source}\u0000${tool.server ?? ""}\u0000${tool.name}`;
    if (catalog.has(key)) continue;
    catalog.set(key, {
      name: tool.name,
      source: tool.source,
      sourceAuthority: tool.sourceAuthority,
      ...(tool.server ? { server: tool.server } : {}),
      availability: tool.availability,
      exposedRoles: new Set<string>()
    });
  }
}

function toolCatalogItems(
  catalog: Map<string, ToolCatalogSource>
): ToolCatalogItem[] {
  return Array.from(catalog.values())
    .map((item) => {
      const exposedRoles = Array.from(item.exposedRoles).sort(
        CONTROL_API_COLLATOR.compare
      );
      const canonicalEditSurface =
        item.sourceAuthority === "codex-native"
          ? {
              section: "agents" as const,
              identifier: "any",
              label: "Provider role exposure"
            }
          : item.server
            ? {
                section: "mcps" as const,
                identifier: item.server,
                label: `MCP ${item.server}`
              }
            : undefined;
      return {
        name: item.name,
        source: item.source,
        sourceAuthority: item.sourceAuthority,
        ...(item.server ? { server: item.server } : {}),
        exposedRoles,
        availability: item.availability,
        ...(canonicalEditSurface ? { canonicalEditSurface } : {})
      };
    })
    .sort((left, right) =>
      CONTROL_API_COLLATOR.compare(
        `${left.source}:${left.server ?? ""}:${left.name}`,
        `${right.source}:${right.server ?? ""}:${right.name}`
      )
    );
}

function deriveCoverage(
  catalog: Map<string, ToolCatalogSource>,
  rulesyncValidity: "valid" | "invalid" | "not-observed"
): ToolCatalogView["coverage"] {
  if (catalog.size === 0) {
    return rulesyncValidity === "valid" ? "unavailable" : "unknown";
  }
  const hasRulesyncBacked = Array.from(catalog.values()).some(
    (entry) =>
      entry.sourceAuthority === "rulesync-mcp" ||
      entry.sourceAuthority === "rulesync-plugin"
  );
  if (hasRulesyncBacked) return "complete";
  return "partial";
}

function toolsView(): ToolCatalogView {
  const adapter = new ToolCatalogAdapter();
  const rulesyncCatalog = adapter.load();
  const catalog = new Map<string, ToolCatalogSource>();
  const executionContract = getDefaultExecutionContract();
  const roles = Object.entries(
    (executionContract.roles ?? {}) as Readonly<
      Record<string, ToolCatalogExecutionContractSummary>
    >
  );

  // The catalogue is built from two independent reads: the execution
  // contract's roles and the RuleSync tool catalogue. A count over a scope
  // that was only partly read is not a count -- the number is exactly right
  // for the half that was read and merely incomplete for the half that was
  // not -- so the count is a number only when both reads were observed. One
  // unread read never turns the other's count into a zero.
  const contractObserved = executionContractObserved();
  const catalogueObserved =
    rulesyncCatalog.validity === "valid" && contractObserved;

  if (roles.length === 0 && rulesyncCatalog.tools.length === 0) {
    return {
      schema: "autodev-control-tools-v2",
      source: rulesyncCatalog.source,
      readOnly: true,
      coverage:
        rulesyncCatalog.validity === "valid" ? "unavailable" : "unknown",
      validity: rulesyncCatalog.validity,
      // Whether the contract was read is a fact about the read, and the
      // catalogue's own claims depend on it: the entries that arrived are the
      // ones the RuleSync source alone declared, and every statement about a
      // tool's role exposure is unobserved when the contract was not read.
      executionContractObserved: contractObserved,
      // A catalogue that was read and holds no tools is a measured zero and
      // stays a number. A catalogue that was not read is not observed, and
      // `coverage` beside it already says so.
      totalTools: catalogueObserved ? 0 : null,
      tools: [],
      usageLink: "/usage"
    } satisfies ControlApiToolsResponse;
  }

  for (const [role, contract] of roles) {
    addNativeResearchTools(catalog, role, contract);
    addExecutionContractMcpTools(catalog, role, contract);
  }
  // Always pull in declared RuleSync tool entries so an MCP server's
  // `enabled_tools` projection is visible to the console without needing a
  // role projection to enumerate it. Already-enumerated entries keep the
  // role attribution from the execution-contract pass.
  mergeRuleSyncDeclaredTools(catalog, rulesyncCatalog.tools);

  const tools = toolCatalogItems(catalog);
  return {
    schema: "autodev-control-tools-v2",
    source: rulesyncCatalog.source,
    readOnly: true,
    coverage: deriveCoverage(catalog, rulesyncCatalog.validity),
    validity: rulesyncCatalog.validity,
    // The contract's read is a fact about the read. The coverage beside it
    // says what the catalogue holds, and the count below is a number only
    // when both reads were observed; this says which read was the one that
    // was not.
    executionContractObserved: contractObserved,
    totalTools: catalogueObserved ? tools.length : null,
    tools,
    usageLink: "/usage"
  } satisfies ControlApiToolsResponse;
}

/**
 * The workspace ids this installation serves.
 *
 * A repository's remote names a project, but a remote is not a workspace: the
 * catalogue is what says which projects are workspaces here. When the
 * catalogue cannot be read, no ids are declared and the repository's own
 * remote decides alone -- a skill in a repository nobody configured still
 * belongs to the project that repository is.
 */
function configuredWorkspaceIds(
  repositoryRoot: string
): readonly string[] | undefined {
  const catalog = new ConfigRepository(repositoryRoot).readWorkspaceCatalog();
  return catalog.status === "valid"
    ? catalog.workspaces.map((workspace) => workspace.id)
    : undefined;
}

/**
 * Where a skill is installed, read live from the machine.
 *
 * The catalogue says a skill exists; the scope says whether any agent can
 * reach it and which workspace it belongs to. Both are read at the moment the
 * Console asks, so a skill that has just been installed or removed shows what
 * is true now rather than what was true when the page was written.
 */
function liveSkillScopes(
  names: readonly string[],
  repositoryRoot: string
): ReadonlyMap<string, SkillScopeFacts> {
  const home = process.env.HOME ?? homedir();
  return resolveSkillScopes(names, {
    roots: {
      home,
      codexHome: process.env.CODEX_HOME ?? path.join(home, ".codex"),
      repositoryRoot
    },
    workspaces: configuredWorkspaceIds(repositoryRoot)
  });
}

/**
 * The roles a skill is assigned to, in the place that skill belongs to.
 *
 * A repo-scoped skill belongs to one workspace, so its roles are that
 * workspace's roles; every other skill's roles are the global ones. A
 * repo-scoped skill whose repository is not a configured workspace has no
 * roles at all, because there is nowhere to assign it.
 */
function assignedSkillRoles(skill: string, workspace: string | null): string[] {
  const contract = getDefaultExecutionContract() as unknown as Record<
    string,
    unknown
  >;
  const roles = contractSkillRoles(
    contract,
    workspace === null ? undefined : workspace
  );
  return Object.entries(roles)
    .filter(([, skills]) => skills.includes(skill))
    .map(([role]) => role)
    .sort((left, right) => CONTROL_API_COLLATOR.compare(left, right));
}

/**
 * The skill exposure and use the Runtime has observed.
 *
 * The Runtime's usage telemetry already counts both: an injected skill is an
 * exposure, and a skill that was used is a use. The telemetry keeps the counts
 * per workspace, because that is the dimension it attributes by, and the
 * Console asks for a total across the workspaces it is showing.
 *
 * A skill the Runtime has never seen is absent from the map, which is not the
 * same as a skill it saw and never injected: `null` means "not observed", and
 * a number means "observed, and this is how often".
 */
function observedSkillUsage(): {
  readonly observed: boolean;
  readonly bySkill: ReadonlyMap<string, { exposure: number; use: number }>;
} {
  const bySkill = new Map<string, { exposure: number; use: number }>();
  const telemetry = getDefaultUsageTracker().usageTelemetry;
  for (const bucket of Object.values(telemetry.byWorkspace)) {
    for (const skill of bucket.skills.values()) {
      const entry = bySkill.get(skill.skill) ?? { exposure: 0, use: 0 };
      entry.exposure += skill.total;
      entry.use += skill.uses;
      bySkill.set(skill.skill, entry);
    }
  }
  return { observed: bySkill.size > 0, bySkill };
}

function skillsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const catalog = new RuleSyncRepository(repositoryRoot).loadSkills();
  const assignments = configuredRoleExposure("skills");
  const rolesBySkill = new Map(
    assignments.map(({ name, roles }) => [name, roles])
  );
  const catalogNames = new Set(catalog.skills.map((skill) => skill.name));
  // The Console renders an assignment form per row, and that form has to post
  // the revision it was drawn from or it cannot detect a concurrent write. The
  // contract is one file shared by every row, so it is read once here rather
  // than once per skill.
  const contractFile = executionContractFile();
  const scopes = liveSkillScopes(
    catalog.skills.map((skill) => skill.name),
    repositoryRoot
  );
  const usage = observedSkillUsage();
  return {
    schema: "autodev-control-skills-v2",
    source: `${catalog.source}+${EXECUTION_CONTRACT_SOURCE}`,
    // The skills collection has canonical write paths -- role assignment at
    // `PATCH /control/skills/:name` and the canonical source at
    // `PATCH /control/skills/:name/content` -- so it is not read-only. This
    // used to say it was, which was a stale constant: the write paths arrived
    // after it and the flag was never revisited.
    readOnly: false,
    valid: catalog.valid,
    issues: catalog.issues,
    // The role assignments come from the execution contract, and the accessor
    // that reads it falls back to an empty contract when the read fails: an
    // empty contract and a contract nobody read look the same to a caller
    // that only sees the roles. The eligibility a card counts, and the
    // assignment form's roles, both depend on which one it was.
    executionContractObserved: executionContractObserved(),
    executionContractRevision:
      contractFile === null
        ? null
        : executionContractRevision(readContract(contractFile)),
    assignmentRoles: assignableRoles(),
    // Whether the Runtime has seen any skill telemetry at all. Without it a
    // page cannot tell "not observed" from "observed nothing", which are
    // different facts about a different subject.
    telemetryObserved: usage.observed,
    skills: catalog.skills.map((skill) => {
      const facts = scopes.get(skill.name);
      // Only a repo-scoped skill belongs to a workspace; every other scope
      // belongs to the machine and is assigned globally.
      const workspace = facts?.scope === "repo" ? facts.workspace : null;
      const observed = usage.bySkill.get(skill.name);
      return {
        ...skill,
        scope: facts?.scope ?? null,
        scopeLocation: facts?.location ?? null,
        workspace,
        roles:
          workspace === null
            ? (rolesBySkill.get(skill.name) ?? [])
            : assignedSkillRoles(skill.name, workspace),
        observedExposure: observed?.exposure ?? null,
        observedUse: observed?.use ?? null
      };
    }),
    // The unresolved assignments are a join between the contract's assignments
    // and the catalogue's names. A catalogue that was not read leaves the join
    // unperformed, and an empty list there would say every assignment
    // resolves -- a claim the catalogue did not make.
    unresolvedAssignments:
      catalog.valid === true
        ? assignments.filter(({ name }) => !catalogNames.has(name))
        : null
  } satisfies ControlApiSkillsResponse;
}

function runtimeView(now: number): Record<string, unknown> {
  const runtime = getDefaultRouterLifecycle();
  return {
    schema: "autodev-control-runtime-v2",
    routerInstanceId: ROUTER_INSTANCE_ID,
    lifecycle: runtime.getLifecycleStatus(),
    concurrency: getDefaultConcurrencyManager().concurrencyStatus(now),
    inFlightRequestCount: runtime.activeRequestCount,
    liveAgents: liveAgentCountsSource?.(now) ?? null
  } satisfies ControlApiRuntimeResponse;
}

/**
 * One workspace's live-agent availability, as the runtime reports it.
 *
 * The live projection is the only authority on whether the runtime is
 * currently serving a workspace, and it may be absent: a standalone Control
 * API has no live evidence and says so rather than reporting a zero that
 * would read as an idle workspace.
 */
function workspaceRuntimeAvailability(
  workspaceId: string,
  liveAgents: ControlApiLiveAgentCounts | null
): WorkspaceRuntimeAvailability {
  if (liveAgents === null) return { status: "not-observed" };
  return {
    status: "observed",
    liveAgents: liveAgents.byWorkspace[workspaceId] ?? 0
  };
}

/**
 * The role names the execution contract defines.
 *
 * A workspace's role scope is a list of these, and a scope that names
 * something else excludes every agent that could work in the workspace.
 */
function configuredAgentRoleNames(): readonly string[] {
  return Object.keys(getDefaultExecutionContract().roles ?? {});
}

/**
 * The canonical catalog's desired-vs-actual view.
 *
 * The catalog is the desired state, and the Runtime reads that same file on
 * every request rather than a copy of it, so the observation is a live fact:
 * the catalog the Runtime reads is the catalog that was written, or it is not.
 *
 * The observed generation is therefore a second read of the canonical source
 * and never a copy of the generation a write produced. A catalog that moved
 * again between the write and the observation is reported as pending, and a
 * catalog that cannot be read at all is reported as not observed -- neither is
 * dressed up as convergence, because the operator would be reading a verdict
 * the Runtime never reached.
 */
function workspaceCatalogReconciliation(args: {
  readonly repositoryRoot: string;
  readonly desiredGeneration: string | null;
}): ReconciliationView {
  const resource = CONTROL_API_PATHS.workspaces;
  const latest = findLatestAuditFor(resource);
  const observed = new ConfigRepository(
    args.repositoryRoot
  ).readWorkspaceCatalog();
  const observedGeneration =
    observed.status === "valid" ? (observed.revision ?? null) : null;
  const evidence: ReconciliationEvidence = {
    desiredGeneration: args.desiredGeneration,
    observedGeneration,
    lastApplyAt: latest?.timestamp ?? null,
    // The observation is the read, so the time of the observation is the time
    // of this read rather than the time of an apply that refreshed a copy.
    lastObservationAt:
      observedGeneration === null ? null : new Date().toISOString(),
    lastError: boundReconciliationError(latest?.reason ?? null)
  };
  return buildReconciliationView({
    evidence,
    history: historyForResource(resource),
    hasObservation: observedGeneration !== null,
    restartRequired: false
  });
}

/**
 * What a workspace configuration write changed, in the catalog's vocabulary.
 *
 * The fields are the catalog's own names, so the summary says "base branch"
 * rather than a second word for it, and the identifier is the generation the
 * write produced.
 */
function workspaceConfigurationDiff(args: {
  readonly changedFields: readonly WorkspaceCatalogField[];
  readonly revision: string;
}): ReconciliationDiff {
  if (args.changedFields.length === 0) {
    return reconcileDiffSummary({
      summary:
        "Canonical workspace configuration unchanged; the catalog already held these values."
    });
  }
  const labels = args.changedFields.map((field) =>
    field === "enabled"
      ? "enablement"
      : field === "baseBranch"
        ? "base branch"
        : "role scope"
  );
  return reconcileDiffWithIdentifier({
    summary: `Canonical workspace configuration changed: ${labels.join(", ")}.`,
    identifier: args.revision
  });
}

function workspacesView(repositoryRoot?: string): Record<string, unknown> {
  const catalog = new ConfigRepository(repositoryRoot).readWorkspaceCatalog();
  const liveAgents = liveAgentCountsSource?.(Date.now()) ?? null;
  const knownRoles = configuredAgentRoleNames();
  return {
    schema: "autodev-control-workspaces-v3",
    source: "config/workspaces.json",
    readOnly: false,
    catalogStatus: catalog.status,
    // The revision a write is compared against. It is published here because
    // this read is the only place the catalog's exact bytes are named.
    revision: catalog.revision ?? null,
    totalWorkspaces:
      catalog.status === "valid" ? catalog.workspaces.length : null,
    reconciliation: workspaceCatalogReconciliation({
      repositoryRoot: repositoryRoot ?? DEFAULT_REPO_ROOT,
      desiredGeneration: catalog.revision ?? null
    }),
    workspaces:
      catalog.status === "valid"
        ? catalog.workspaces.map((workspace) => ({
            ...workspace,
            configuration: workspaceConfigurationHealth(workspace, knownRoles),
            runtime: workspaceRuntimeAvailability(workspace.id, liveAgents)
          }))
        : []
  } satisfies ControlApiWorkspacesResponse;
}

/** The fields a workspace update may carry, and nothing else. */
const WORKSPACE_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "expectedRevision",
  "enabled",
  "baseBranch",
  "agentRoles"
]);

/** The revision a workspace write is compared against. */
const WORKSPACE_REVISION_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * The change a workspace write asks for, or null when the body cannot be one.
 *
 * The body has to name the revision the write was decided on and at least one
 * field to change, and it may not carry anything else: `id` in particular is
 * not a field a write may set, because a workspace's identity is what the
 * catalog is indexed by.
 */
function workspaceUpdateFromBody(body: Record<string, unknown>): {
  readonly expectedRevision: string;
  readonly change: {
    readonly enabled?: boolean | undefined;
    readonly baseBranch?: string | undefined;
    readonly agentRoles?: readonly string[] | null | undefined;
  };
} | null {
  for (const key of Object.keys(body)) {
    if (!WORKSPACE_UPDATE_KEYS.has(key)) return null;
  }
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== "string" ||
    !WORKSPACE_REVISION_PATTERN.test(expectedRevision)
  ) {
    return null;
  }
  const change: {
    enabled?: boolean | undefined;
    baseBranch?: string | undefined;
    agentRoles?: readonly string[] | null | undefined;
  } = {};
  let fields = 0;
  if ("enabled" in body) {
    const enabled = body.enabled;
    if (typeof enabled !== "boolean") return null;
    change.enabled = enabled;
    fields += 1;
  }
  if ("baseBranch" in body) {
    const baseBranch = body.baseBranch;
    if (typeof baseBranch !== "string") return null;
    change.baseBranch = baseBranch;
    fields += 1;
  }
  if ("agentRoles" in body) {
    const agentRoles = body.agentRoles;
    if (agentRoles === null) {
      change.agentRoles = null;
    } else {
      if (
        !Array.isArray(agentRoles) ||
        agentRoles.some((role) => typeof role !== "string")
      ) {
        return null;
      }
      change.agentRoles = agentRoles as readonly string[];
    }
    fields += 1;
  }
  if (fields === 0) return null;
  return { expectedRevision, change };
}

/**
 * The refusal a write to the canonical catalog answers with.
 *
 * A conflict, an unknown workspace and a write that could not be expressed are
 * three different facts, and the caller is told which one happened.
 */
function sendWorkspaceWriteFailure(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  error: unknown
): void {
  const conflict = error instanceof WorkspaceCatalogConflictError;
  const unknownWorkspace =
    error instanceof WorkspaceCatalogUnknownWorkspaceError;
  const validation = error instanceof WorkspaceCatalogValidationError;
  if (!conflict && !unknownWorkspace && !validation) throw error;
  let status = 400;
  let code = "autodev_control_workspace_invalid_update";
  let reason = "invalid_update";
  if (conflict) {
    status = 409;
    code = "autodev_control_workspace_revision_conflict";
    reason = "revision_conflict";
  } else if (unknownWorkspace) {
    status = 404;
    code = "autodev_control_workspace_unknown";
    reason = "unknown_workspace";
  }
  const message =
    error instanceof Error
      ? error.message
      : "The workspace catalog could not be written.";
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_workspace_catalog_entry",
    resource,
    outcome: "error",
    changes: null,
    reason
  });
  sendControlError(response, status, code, message);
}

/**
 * Write one workspace's configuration to the canonical catalog.
 *
 * The catalog's rules and its write live in the module that owns them, so this
 * route decides only what a Control API request is: who may write, what the
 * body has to say, and which refusal the caller is told about.
 */
async function patchWorkspace(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  owner: string,
  repository: string,
  repositoryRoot: string
): Promise<void> {
  const workspaceId = `${owner}/${repository}`;
  const resource = `${CONTROL_API_PATHS.workspaces}/${owner}/${repository}`;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_workspace_catalog_entry",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Updating a workspace's canonical configuration requires an operator."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_workspace_catalog_entry",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const update = workspaceUpdateFromBody(parsed.body);
  if (update === null) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_workspace_catalog_entry",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_update"
    });
    sendControlError(
      response,
      400,
      "autodev_control_workspace_invalid_update",
      "A workspace update requires the expected revision and at least one of enablement, base branch or role scope."
    );
    return;
  }

  let written: WorkspaceCatalogWrite;
  try {
    written = updateWorkspaceCatalogEntry(
      new ConfigRepository(repositoryRoot).workspaceCatalogPath(),
      workspaceId,
      update.expectedRevision,
      update.change
    );
  } catch (error) {
    sendWorkspaceWriteFailure(response, actor, resource, error);
    return;
  }

  const knownRoles = configuredAgentRoleNames();
  const liveAgents = liveAgentCountsSource?.(Date.now()) ?? null;
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_workspace_catalog_entry",
    resource,
    outcome: "ok",
    changes: { id: workspaceId, revision: written.revision }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-workspace-patch-v2",
      id: workspaceId,
      revision: written.revision,
      changed: written.changed,
      workspace: {
        ...written.workspace,
        configuration: workspaceConfigurationHealth(
          written.workspace,
          knownRoles
        ),
        runtime: workspaceRuntimeAvailability(written.workspace.id, liveAgents)
      },
      // The observation is a second read of the canonical catalog, so a
      // catalog that moved again between the write and the observation is
      // reported as pending rather than as the write having landed.
      reconciliation: workspaceCatalogReconciliation({
        repositoryRoot,
        desiredGeneration: written.revision
      }),
      diff: workspaceConfigurationDiff({
        changedFields: written.changedFields,
        revision: written.revision
      })
    } satisfies ControlApiWorkspacePatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

let githubActionsAdapterOverride: GithubActionsAdapter | null = null;
interface CachedGithubSnapshot {
  readonly timestamp: number;
  readonly snapshot: GithubActionsRuntimeSnapshot;
}
const GITHUB_SNAPSHOT_CACHE = new Map<string, CachedGithubSnapshot>();
const GITHUB_SNAPSHOT_CACHE_TTL_MS = 15_000;

export function clearGithubSnapshotCacheForTests(): void {
  GITHUB_SNAPSHOT_CACHE.clear();
}

export function setGithubActionsAdapterForTests(
  adapter: GithubActionsAdapter | null
): void {
  githubActionsAdapterOverride = adapter;
  clearGithubSnapshotCacheForTests();
}

export interface GithubWorkflowsViewOptions {
  readonly actionsAdapter?: GithubActionsAdapter;
  readonly token?: string;
  readonly repository?: string;
}

type GithubWorkflowCatalogStatus = "valid" | "invalid" | "unavailable";

interface GithubUnavailableResponseOptions {
  readonly catalogStatus: GithubWorkflowCatalogStatus;
  readonly totalWorkflows: number | null;
  readonly workflows: readonly GithubWorkflowDefinition[];
  readonly runtimeStatus: GithubActionsRuntimeStatus;
  readonly runtimeMessage: string;
  readonly repository: string | null;
}

function unavailableGithubResponse(
  options: GithubUnavailableResponseOptions
): Record<string, unknown> {
  return {
    schema: GITHUB_CONTROL_API_SCHEMA,
    source: GITHUB_WORKFLOW_YAML_SOURCE,
    readOnly: true,
    catalogStatus: options.catalogStatus,
    totalWorkflows: options.totalWorkflows,
    workflows: options.workflows,
    runtimeFactsAvailable: false,
    runtimeStatus: options.runtimeStatus,
    runtimeMessage: options.runtimeMessage,
    repository: options.repository,
    stats: null,
    // The Actions read did not happen, so the runs were never asked for. An
    // empty list here would say the workflows have never run, which is a claim
    // about the repository rather than about this read.
    recentRuns: null
  };
}

function unavailableWorkflowDefinitions(
  workflows: readonly GithubWorkflowDefinition[]
): GithubWorkflowDefinition[] {
  return workflows.map((workflow) => ({
    ...workflow,
    actionsState: "unavailable",
    actionsWorkflowId: null,
    actionsHtmlUrl: null,
    recentRunsCount: null,
    lastRunStatus: null,
    lastRunConclusion: null,
    lastRunCreatedAt: null,
    lastRunHtmlUrl: null
  }));
}

type GithubRuntimeBindingResolution =
  | {
      readonly available: true;
      readonly owner: string;
      readonly repo: string;
      readonly repository: string;
      readonly token: string | undefined;
      readonly unavailableWorkflows: readonly GithubWorkflowDefinition[];
    }
  | {
      readonly available: false;
      readonly response: Record<string, unknown>;
    };

function resolveGithubRuntimeBinding(
  root: string,
  workflows: readonly GithubWorkflowDefinition[],
  options: GithubWorkflowsViewOptions
): GithubRuntimeBindingResolution {
  const unavailableWorkflows = unavailableWorkflowDefinitions(workflows);
  const configuredToken = options.token ?? process.env.AUTODEV_GITHUB_TOKEN;
  const token = configuredToken?.trim() ? configuredToken.trim() : undefined;
  const repository =
    options.repository ??
    process.env.AUTODEV_GITHUB_REPOSITORY ??
    process.env.GITHUB_REPOSITORY ??
    null;

  const unavailable = (
    runtimeStatus: GithubActionsRuntimeStatus,
    runtimeMessage: string
  ): GithubRuntimeBindingResolution => ({
    available: false,
    response: unavailableGithubResponse({
      catalogStatus: "valid",
      totalWorkflows: workflows.length,
      workflows: unavailableWorkflows,
      runtimeStatus,
      runtimeMessage,
      repository
    })
  });

  if (!repository) {
    return unavailable(
      "unavailable",
      "AUTODEV_GITHUB_REPOSITORY is not configured; no repository is bound."
    );
  }

  const workspaceCatalog = new ConfigRepository(root).readWorkspaceCatalog();
  const workspace =
    workspaceCatalog.status === "valid"
      ? workspaceCatalog.workspaces.find((entry) => entry.id === repository)
      : undefined;
  if (!workspace) {
    return unavailable(
      "invalid",
      `Configured repository "${repository}" is not a recognized workspace in config/workspaces.json.`
    );
  }

  if (!workspace.enabled) {
    return unavailable(
      "invalid",
      `Configured workspace "${repository}" is disabled in config/workspaces.json.`
    );
  }

  const [owner, repo, extraSegment] = repository.split("/");
  if (!owner || !repo || extraSegment !== undefined) {
    return unavailable(
      "invalid",
      `Invalid repository identifier format: "${repository}". Expected "owner/repo".`
    );
  }

  return {
    available: true,
    owner,
    repo,
    repository,
    token,
    unavailableWorkflows
  };
}

function addToIndex<Key, Value>(
  index: Map<Key, Value[]>,
  key: Key,
  value: Value
): void {
  const values = index.get(key);
  if (values) {
    values.push(value);
  } else {
    index.set(key, [value]);
  }
}

function githubWorkflowState(state: string | undefined): GithubWorkflowState {
  if (
    state === "active" ||
    state === "disabled_manually" ||
    state === "disabled_inactivity" ||
    state === "deleted"
  ) {
    return state;
  }
  return "unknown";
}

interface ProjectedGithubWorkflows {
  readonly workflows: readonly GithubWorkflowDefinition[];
}

function projectGithubWorkflows(
  definitions: readonly GithubWorkflowDefinition[],
  snapshot: GithubActionsRuntimeSnapshot
): ProjectedGithubWorkflows {
  const apiWorkflowByPathOrFile = new Map<string, GithubApiWorkflow>();
  for (const workflow of snapshot.workflows) {
    apiWorkflowByPathOrFile.set(workflow.path, workflow);
    apiWorkflowByPathOrFile.set(path.basename(workflow.path), workflow);
  }

  const runsByWorkflowId = new Map<number, GithubWorkflowRun[]>();
  const runsByWorkflowPath = new Map<string, GithubWorkflowRun[]>();
  for (const run of snapshot.runs) {
    addToIndex(runsByWorkflowId, run.workflowId, run);
    if (run.workflowPath) {
      addToIndex(runsByWorkflowPath, run.workflowPath, run);
      addToIndex(runsByWorkflowPath, path.basename(run.workflowPath), run);
    }
  }

  const workflows = definitions.map((definition) => {
    const apiWorkflow =
      apiWorkflowByPathOrFile.get(definition.path) ??
      apiWorkflowByPathOrFile.get(definition.id);
    const matchedRuns = apiWorkflow
      ? (runsByWorkflowId.get(apiWorkflow.id) ?? [])
      : (runsByWorkflowPath.get(definition.path) ??
        runsByWorkflowPath.get(definition.id) ??
        []);
    const latestRun = matchedRuns[0];

    return {
      ...definition,
      actionsState: githubWorkflowState(apiWorkflow?.state),
      actionsWorkflowId: apiWorkflow?.id ?? null,
      actionsHtmlUrl: apiWorkflow?.htmlUrl ?? null,
      recentRunsCount: matchedRuns.length,
      lastRunStatus: latestRun?.status ?? null,
      lastRunConclusion: latestRun?.conclusion ?? null,
      lastRunCreatedAt: latestRun?.createdAt ?? null,
      lastRunHtmlUrl: latestRun?.htmlUrl ?? null
    };
  });
  return { workflows };
}

/**
 * Observed GitHub Actions workflow *definitions* parsed from
 * `.github/workflows/*.yml` along with authoritative read-only GitHub Actions
 * runtime state and bounded recent run statistics.
 *
 * Runtime Control API owns authentication and validates configured
 * AUTODEV_GITHUB_REPOSITORY (or standard runner GITHUB_REPOSITORY). Public
 * repositories may be read without a GitHub token; private repositories need
 * a server-side AUTODEV_GITHUB_TOKEN with read-only Actions permission.
 * Returns an explicit unavailable/invalid state when configuration or API
 * access is absent/invalid.
 */
export async function githubWorkflowsView(
  repositoryRoot?: string,
  options: GithubWorkflowsViewOptions = {}
): Promise<Record<string, unknown>> {
  const root = repositoryRoot ?? DEFAULT_REPO_ROOT;
  const catalog = new GithubWorkflowRepository(root).readWorkflowCatalog();

  if (catalog.status !== "valid") {
    return unavailableGithubResponse({
      catalogStatus: catalog.status,
      totalWorkflows: null,
      workflows: [],
      runtimeStatus: catalog.status === "invalid" ? "invalid" : "unavailable",
      runtimeMessage:
        catalog.status === "invalid"
          ? "Workflow YAML definitions under .github/workflows could not be parsed."
          : ".github/workflows directory is missing or unreadable.",
      repository: null
    });
  }

  const binding = resolveGithubRuntimeBinding(root, catalog.workflows, options);
  if (!binding.available) {
    return binding.response;
  }

  const adapter =
    options.actionsAdapter ??
    githubActionsAdapterOverride ??
    new GithubActionsAdapter();

  const isTestOverride = Boolean(
    options.actionsAdapter || githubActionsAdapterOverride
  );
  const cacheKey = `${binding.owner}/${binding.repo}:${binding.token ? "auth" : "anon"}`;
  const now = Date.now();
  const cached = isTestOverride
    ? undefined
    : GITHUB_SNAPSHOT_CACHE.get(cacheKey);

  try {
    let snapshot: GithubActionsRuntimeSnapshot;
    if (cached && now - cached.timestamp < GITHUB_SNAPSHOT_CACHE_TTL_MS) {
      snapshot = cached.snapshot;
    } else {
      snapshot = await adapter.fetchRuntimeSnapshot(
        binding.owner,
        binding.repo,
        binding.token,
        { limit: 30 }
      );
      if (!isTestOverride) {
        // A slow external Actions read must not age out its own cache entry
        // before the snapshot is available to the next Console request.
        GITHUB_SNAPSHOT_CACHE.set(cacheKey, {
          timestamp: Date.now(),
          snapshot
        });
      }
    }
    const projected = projectGithubWorkflows(catalog.workflows, snapshot);

    return {
      schema: GITHUB_CONTROL_API_SCHEMA,
      source: GITHUB_WORKFLOW_YAML_SOURCE,
      readOnly: true,
      catalogStatus: "valid",
      totalWorkflows: catalog.workflows.length,
      workflows: projected.workflows,
      runtimeFactsAvailable: true,
      runtimeStatus: "available",
      runtimeMessage: null,
      repository: binding.repository,
      stats: snapshot.stats,
      recentRuns: snapshot.runs
    } satisfies ControlApiGithubResponse;
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const isAuthFailure =
      error instanceof GithubActionsApiError && error.status === 401;

    return unavailableGithubResponse({
      catalogStatus: "valid",
      totalWorkflows: binding.unavailableWorkflows.length,
      workflows: binding.unavailableWorkflows,
      runtimeStatus: isAuthFailure ? "invalid" : "unavailable",
      runtimeMessage: `GitHub Actions API error: ${rawMessage}`,
      repository: binding.repository
    });
  }
}

async function evaluationsView(): Promise<Record<string, unknown>> {
  const repository = new EvaluationRepository();
  const page = await repository.listEvaluations();
  return {
    schema: "autodev-control-evaluations-v1",
    source: "openlit_evaluation",
    readOnly: true,
    // The table's own size, not the size of the window. This used to be
    // `evaluations.length`, so a table holding more rows than the read's cap
    // reported the cap as the total and the Console had no way to tell.
    totalEvaluations: page.total,
    truncated: page.total > page.results.length,
    evaluations: page.results
  } satisfies ControlApiEvaluationsResponse;
}

function agentEnablementRevision(
  role: string,
  alias: string,
  enabled: boolean,
  generation: number
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "agent-enable-v1",
        role,
        alias,
        enabled,
        generation
      })
    )
    .digest("hex");
}

function agentEnablementView(
  role: string
): ControlApiAgentRecord["enablement"] {
  const alias = ROUTING_POLICY.agentModelAlias(role);
  if (alias === null) {
    return {
      kind: "unavailable",
      enabled: null,
      mutable: false,
      reason:
        "This configured Agent has no matching AutoDev model-router alias, so Runtime cannot enforce its enablement."
    };
  }
  const enabled = ROUTING_POLICY.isAgentEnabled(role);
  const generation = ROUTING_POLICY.agentEnablementGeneration(role);
  if (enabled === null || generation === null) {
    return {
      kind: "unavailable",
      enabled: null,
      mutable: false,
      reason:
        "Runtime could not observe enablement for this AutoDev model-router alias."
    };
  }
  return {
    kind: "observed",
    enabled,
    mutable: true,
    revision: agentEnablementRevision(role, alias, enabled, generation)
  };
}

function agentStatus(
  role: string,
  hasPrompt: boolean,
  allowedProviders: readonly string[]
): ControlApiAgentRecord["status"] {
  if (!hasPrompt || allowedProviders.length === 0) {
    return "unavailable";
  }
  const enablement = agentEnablementView(role);
  if (enablement.kind === "unavailable" || !enablement.enabled) {
    return "unavailable";
  }
  const health = providerHealthSource?.(Date.now()) ?? null;
  const eligibleProviders = allowedProviders.filter((provider) => {
    if (!ROUTING_POLICY.isProviderEnabled(provider)) return false;
    const route = ROUTES.find((entry) => entry.provider === provider);
    return (
      route !== undefined && ROUTING_POLICY.routeCredentialAvailable(route)
    );
  });
  if (eligibleProviders.length === 0) return "unavailable";

  const readiness = eligibleProviders.map((provider) =>
    providerHealthReadiness(health?.[provider] ?? null)
  );
  if (readiness.includes("ready")) return "ready";
  if (readiness.every((state) => state === "unavailable")) {
    return "unavailable";
  }
  return "configured";
}

function agentConvergence(
  role: string,
  hasPrompt: boolean
): ControlApiAgentRecord["convergence"] {
  const resource = CONTROL_API_PATHS.agents + "/" + role;
  const latest = findLatestAuditFor(resource);
  const alias = ROUTING_POLICY.agentModelAlias(role);
  if (!hasPrompt || alias === null) {
    return "error";
  }
  const enabled = ROUTING_POLICY.isAgentEnabled(role);
  if (enabled === null || latest === null) {
    return "not-observed";
  }
  const observedGeneration =
    latest.observedGeneration === null
      ? null
      : `enabled=${enabled ? "true" : "false"}`;
  return buildReconciliationView({
    evidence: {
      desiredGeneration: latest.desiredGeneration,
      observedGeneration,
      lastApplyAt: latest?.timestamp ?? null,
      lastObservationAt: observedGeneration === null ? null : latest.timestamp,
      lastError: boundReconciliationError(latest?.reason ?? null)
    },
    history: historyForResource(resource),
    hasObservation: observedGeneration !== null
  }).status.convergence;
}

function agentsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const roles = getDefaultExecutionContract().roles ?? {};
  const names = Object.keys(roles).sort(CONTROL_API_COLLATOR.compare);
  const agents = names.map(
    (
      role
    ): ControlApiAgentRecord & {
      readonly hasPrompt: boolean;
    } => {
      const raw = roles[role] as Record<string, unknown> | undefined;
      const isOrchestrator = role === "orchestrator";
      // Normalised rather than passed through. `kind` comes out of a hand-editable
      // JSON contract, and the contract declares two words; a typo there used to
      // reach the Console as a third, and the Console could only either show it or
      // reject the whole page. The role name is validated, so the derived value is
      // the safe answer whenever the file's own is not one of the two.
      const declaredKind = raw?.kind;
      const kind: ControlApiAgentRecord["kind"] =
        declaredKind === "orchestrator" || declaredKind === "leaf"
          ? declaredKind
          : isOrchestrator
            ? "orchestrator"
            : "leaf";
      const readOnly = Boolean(raw?.readOnly);
      const mcps = Array.isArray(raw?.mcp) ? raw.mcp : [];
      const skills = Array.isArray(raw?.skills) ? raw.skills : [];
      const roleType = isOrchestrator ? "orchestrator" : "subagent";
      const allowedProviders = [
        "codex",
        "claude",
        "antigravity",
        "copilot",
        "minimax"
      ].filter((provider) =>
        ROUTING_POLICY.isProviderEnabledForRole(provider, roleType)
      );
      const promptPath = path.join(
        repositoryRoot,
        "agents",
        "prompts",
        "roles",
        `${role}.md`
      );
      const hasPrompt = existsSync(promptPath);
      const status = agentStatus(role, hasPrompt, allowedProviders);
      const convergence = agentConvergence(role, hasPrompt);
      const valid = hasPrompt && allowedProviders.length > 0;
      return {
        id: role,
        role,
        kind,
        readOnly,
        configured: true,
        valid,
        status,
        convergence,
        enablement: agentEnablementView(role),
        primaryModel: isOrchestrator
          ? "autodev/orchestrator"
          : "autodev/subagent",
        allowedProviders,
        hasPrompt: existsSync(promptPath),
        mcps,
        skills
      };
    }
  );
  const contractObserved = executionContractObserved();
  return {
    schema: "autodev-control-agents-v2",
    source: EXECUTION_CONTRACT_SOURCE,
    readOnly: false,
    // The catalogue is the execution contract's roles. The accessor that reads
    // the contract falls back to an empty contract when the read fails, so an
    // empty contract and a contract nobody read look the same to every caller
    // -- and the count over the catalogue depends on which one it was.
    executionContractObserved: contractObserved,
    totalAgents: contractObserved ? agents.length : null,
    agents
  } satisfies ControlApiAgentsResponse;
}

/**
 * One role prompt, read.
 *
 * Three outcomes, and the third is not the second: the prompt was read, the
 * role has no prompt file, or the prompt is there and could not be read. Only
 * the second is an empty prompt. The third is no observation at all, and an
 * empty string there would claim the prompt was read and held nothing -- and
 * it would hand the reconciliation a digest of nothing to compare against,
 * which is an identity that names no prompt.
 */
interface RolePromptRead {
  /** Whether a prompt file is there at all. */
  readonly present: boolean;
  /** The prompt's content, or null when it could not be read. */
  readonly content: string | null;
  /** The prompt's canonical revision, or null when it could not be read. */
  readonly revision: string | null;
}

function readRolePrompt(promptPath: string): RolePromptRead {
  if (!existsSync(promptPath)) {
    // A role with no prompt file has an empty prompt. That was observed.
    return { present: false, content: "", revision: null };
  }
  // A path that is there and is not a regular file cannot be read as a
  // prompt. The canonical command catalogue refuses a non-regular entry the
  // same way, and the reason is the same: the path exists, the prompt does
  // not.
  let regularFile = false;
  try {
    regularFile = statSync(promptPath).isFile();
  } catch {
    // The path could not be inspected, so it cannot be a readable prompt.
  }
  if (!regularFile) {
    return { present: true, content: null, revision: null };
  }
  try {
    const content = readFileSync(promptPath, "utf8").trim();
    return {
      present: true,
      content,
      revision: createHash("sha256").update(content, "utf8").digest("hex")
    };
  } catch {
    // The file is there and could not be read.
    return { present: true, content: null, revision: null };
  }
}

function agentDetailView(
  role: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): ReadOnlyDetailResult {
  const roles = getDefaultExecutionContract().roles ?? {};
  const raw = roles[role] as Record<string, unknown> | undefined;
  if (!raw) {
    // The roles are the execution contract's, and the accessor that reads the
    // contract falls back to an empty contract when the read fails: an empty
    // contract and a contract nobody read look the same to a caller that only
    // sees the roles. A 404 here would say the role does not exist, which is
    // a claim the contract never made.
    if (!executionContractObserved()) {
      return {
        status: "unreadable",
        code: "autodev_control_api_execution_contract_not_observed",
        message:
          "The execution contract was not read, so the agent roles are not known."
      };
    }
    return { status: "unknown" };
  }
  const isOrchestrator = role === "orchestrator";
  // Normalised for the same reason as in `agentsView`, and the two must agree:
  // a role whose `kind` is a typo has to read one way on the list and the same way
  // on its own detail page, or the Console rejects the detail as unrecognised
  // while the list rendered it without complaint.
  const declaredKind = raw.kind;
  const kind: ControlApiAgentRecord["kind"] =
    declaredKind === "orchestrator" || declaredKind === "leaf"
      ? declaredKind
      : isOrchestrator
        ? "orchestrator"
        : "leaf";
  const readOnly = Boolean(raw?.readOnly);
  const mcps = Array.isArray(raw?.mcp) ? raw.mcp : [];
  const skills = Array.isArray(raw?.skills) ? raw.skills : [];
  const promptPath = path.join(
    repositoryRoot,
    "agents",
    "prompts",
    "roles",
    `${role}.md`
  );
  // The prompt is read as an observation, not as a string: a prompt that is
  // there and cannot be read is not an empty prompt, and an empty prompt would
  // also give the reconciliation a digest of nothing to compare against.
  const rolePrompt = readRolePrompt(promptPath);
  const roleType = isOrchestrator ? "orchestrator" : "subagent";
  const allowedProviders = [
    "codex",
    "claude",
    "antigravity",
    "copilot",
    "minimax"
  ].filter((provider) =>
    ROUTING_POLICY.isProviderEnabledForRole(provider, roleType)
  );

  const hasPrompt = rolePrompt.present;
  const status = agentStatus(role, hasPrompt, allowedProviders);
  const convergence = agentConvergence(role, hasPrompt);
  const valid = hasPrompt && allowedProviders.length > 0;

  return {
    status: "found",
    detail: {
      schema: "autodev-control-agent-detail-v3",
      id: role,
      role,
      kind,
      readOnly,
      configured: true,
      valid,
      status,
      convergence,
      enablement: agentEnablementView(role),
      primaryModel: isOrchestrator
        ? "autodev/orchestrator"
        : "autodev/subagent",
      allowedProviders,
      mcps,
      skills,
      promptPath: rolePrompt.present ? `agents/prompts/roles/${role}.md` : null,
      systemPrompt: rolePrompt.content,
      reconciliation: promptReconciliationView({
        name: role,
        codexHome: defaultCodexHomeForReconciliation(),
        // The canonical revision of a prompt nobody could read is not known,
        // and a digest of nothing is not a revision of anything.
        expectedRevision: rolePrompt.revision
      })
    } satisfies ControlApiAgentDetailResponse
  };
}

function providerModelsView(): ControlApiProviderModelsResponse {
  const discovery = providerModelDiscoverySource?.();
  if (discovery) return discovery;
  const providers = ROUTING_POLICY.providerIds().map((provider) => ({
    provider,
    discovery: {
      status: "unavailable" as const,
      source: null,
      lastAttemptAt: null,
      reason: "Runtime has not started provider model discovery."
    }
  }));
  return {
    schema: "autodev-control-provider-model-discovery-v1",
    source: "runtime-provider-discovery",
    providers
  } satisfies ControlApiProviderModelsResponse;
}

function providerDiscoveryFor(
  provider: string
): ControlApiProviderModelDiscovery | null {
  return (
    providerModelDiscoverySource?.().providers.find(
      (entry) => entry.provider === provider
    )?.discovery ?? null
  );
}

function providerHasCurrentModelDiscovery(
  provider: string,
  model: string
): boolean {
  const discovery = providerDiscoveryFor(provider);
  return (
    discovery?.status === "observed" &&
    discovery.models.some(
      (candidate) =>
        candidate.id === model && candidate.routeability.status === "supported"
    )
  );
}

function modelHasCurrentDiscovery(model: string): boolean {
  const discovery = providerModelDiscoverySource?.();
  return (
    discovery?.providers.some(
      (entry) =>
        entry.discovery.status === "observed" &&
        entry.discovery.models.some(
          (candidate) =>
            candidate.id === model &&
            candidate.routeability.status === "supported"
        )
    ) ?? false
  );
}

function modelHasDiscoveryRecord(model: string): boolean {
  return (
    providerModelDiscoverySource?.().providers.some(
      (entry) =>
        entry.discovery.status !== "unavailable" &&
        entry.discovery.models.some((candidate) => candidate.id === model)
    ) ?? false
  );
}

/** Display names from the Codex model catalog; absent names stay null. */
function modelCatalogDisplayNames(repositoryRoot: string): Map<string, string> {
  const catalogPath = path.join(
    repositoryRoot,
    "config",
    "catalogs",
    "codex-model-catalog.json"
  );
  if (!existsSync(catalogPath)) return new Map();
  try {
    return loadModelCatalogData(catalogPath).displayNames;
  } catch {
    return new Map();
  }
}

function modelsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const displayNames = modelCatalogDisplayNames(repositoryRoot);
  const byId = new Map<
    string,
    { readonly id: string; readonly provider: string; readonly tiers: string[] }
  >();
  for (const entry of ROUTING_POLICY.configuredModels()) {
    byId.set(entry.model, {
      id: entry.model,
      provider: entry.provider,
      tiers: entry.tiers
    });
  }
  const discovery = providerModelDiscoverySource?.();
  const discoveryStatus = new Map(
    (discovery?.providers ?? []).map((entry) => [
      entry.provider,
      entry.discovery.status
    ])
  );
  const currentlyRouteableModelIds = new Set(
    (discovery?.providers ?? []).flatMap((entry) =>
      entry.discovery.status === "observed"
        ? entry.discovery.models
            .filter((model) => model.routeability.status === "supported")
            .map((model) => model.id)
        : []
    )
  );
  for (const discovered of ROUTING_POLICY.discoveredModels()) {
    const status = discoveryStatus.get(discovered.provider);
    if (
      discovered.routeability.status !== "supported" ||
      (status !== "observed" && status !== "stale")
    ) {
      continue;
    }
    const configured = byId.get(discovered.id);
    if (!configured) {
      byId.set(discovered.id, {
        id: discovered.id,
        provider: discovered.provider,
        tiers: []
      });
    }
    if (!displayNames.has(discovered.id) && discovered.displayName !== null) {
      displayNames.set(discovered.id, discovered.displayName);
    }
  }
  const models = Array.from(byId.values(), (entry) => ({
    ...entry,
    displayName: displayNames.get(entry.id) ?? null,
    enablement: {
      enabled: ROUTING_POLICY.isModelEnabled(entry.id),
      mutable: currentlyRouteableModelIds.has(entry.id),
      convergence: modelConvergence(entry.id)
    }
  })).sort(
    (left, right) =>
      CONTROL_API_COLLATOR.compare(left.provider, right.provider) ||
      CONTROL_API_COLLATOR.compare(left.id, right.id)
  );
  return {
    schema: "autodev-control-models-v2",
    source: path.basename(ROUTING_POLICY.configFile),
    models
  } satisfies ControlApiModelsResponse;
}

/**
 * The target whose hook declaration the Runtime applies.
 *
 * The AutoDev runtime installs one hook projection, the Codex one, so the
 * declaration it manages is the Codex target's effective declaration. The
 * other targets RuleSync can project to are not the Runtime's to install.
 */
const HOOK_APPLIED_TARGET = "codexcli";

/**
 * The canonical hook events, under the names Codex gives them.
 *
 * RuleSync projects the canonical event names into the target's own names, so
 * the applied projection is read in Codex's names. This is the map between
 * them, and it is what lets the applied read answer in the canonical
 * vocabulary the declaration and the Console both use.
 */
const CODEX_HOOK_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  stop: "Stop",
  stopCancelled: "Interrupt",
  permissionRequest: "PermissionRequest",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  postCompact: "PostCompact"
};

const CODEX_HOOK_EVENT_BY_NAME: ReadonlyMap<string, HookEvent> = new Map(
  Object.entries(CODEX_HOOK_EVENT_NAMES).map(([event, name]) => [
    name,
    event as HookEvent
  ])
);

/**
 * The canonical hook declaration, as the target the Runtime applies receives
 * it.
 *
 * The events are the target's effective declaration: the shared declaration
 * with the target's own merged over it, one event at a time, which is how
 * RuleSync merges them. The revision is published with them because a write
 * compares against it.
 */
function hooksView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const repository = new RuleSyncRepository(repositoryRoot);
  const state = repository.loadHooksState(HOOK_APPLIED_TARGET);
  const revision = repository.loadHooksRevision().revision;
  return {
    schema: "autodev-control-hooks-v2",
    source: state.source,
    readOnly: false,
    valid: state.valid,
    issues: state.issues,
    revision,
    target: state.target,
    events: state.events
  } satisfies ControlApiHooksResponse;
}

/**
 * The action one projected hook runs.
 *
 * The projection groups the actions by matcher, so an action's matcher is the
 * group's matcher rather than its own. A group without a matcher gives its
 * actions none.
 */
function appliedHookAction(
  value: unknown,
  matcher: unknown
): HookAction | null {
  if (!isPlainRecord(value)) return null;
  if (value.type !== "command") return null;
  if (typeof value.command !== "string") return null;
  if (value.command.trim().length === 0) return null;
  const actionMatcher =
    typeof matcher === "string"
      ? matcher
      : typeof value.matcher === "string"
        ? value.matcher
        : undefined;
  const statusMessage =
    typeof value.statusMessage === "string" ? value.statusMessage : undefined;
  return {
    type: "command",
    command: value.command,
    ...(actionMatcher === undefined ? {} : { matcher: actionMatcher }),
    ...(statusMessage === undefined ? {} : { statusMessage })
  };
}

/**
 * The events one applied hook projection holds.
 *
 * `null` means the projection could not be read as a hook configuration, which
 * is a different fact from a projection that holds no events.
 */
function appliedHookEvents(
  parsed: unknown
): readonly ControlApiHookEvent[] | null {
  if (!isPlainRecord(parsed)) return null;
  const hooks = parsed.hooks;
  if (!isPlainRecord(hooks)) return null;
  const events: ControlApiHookEvent[] = [];
  for (const [name, value] of Object.entries(hooks)) {
    const event = CODEX_HOOK_EVENT_BY_NAME.get(name);
    // An event Codex runs that this contract does not name is not projected
    // into the canonical vocabulary, and an event the contract does name but
    // Codex does not run cannot appear in the projection at all.
    if (event === undefined) continue;
    if (!Array.isArray(value)) return null;
    const actions = appliedHookActions(value);
    if (actions === null) return null;
    events.push({ event, actions });
  }
  return events;
}

/**
 * The actions one projected hook event runs.
 *
 * The projection groups the actions by matcher, so an event's actions are the
 * groups' actions flattened. `null` means the groups could not be read as
 * groups, which is a different fact from a group that holds no actions.
 */
function appliedHookActions(groups: readonly unknown[]): HookAction[] | null {
  const actions: HookAction[] = [];
  for (const group of groups) {
    if (!isPlainRecord(group)) return null;
    const groupHooks = group.hooks;
    if (!Array.isArray(groupHooks)) return null;
    for (const entry of groupHooks) {
      const action = appliedHookAction(entry, group.matcher);
      if (action === null) return null;
      actions.push(action);
    }
  }
  return actions;
}

/**
 * The hook projection the Runtime published.
 *
 * The projection is a file in the Codex home, so it is read the way any file
 * on disk is read: it may be absent, unreadable, or not a hook configuration,
 * and those are three different facts from a projection that holds no hooks.
 */
function readAppliedHookProjection(codexHome: string): {
  readonly available: boolean;
  readonly events: readonly ControlApiHookEvent[];
  readonly observedAt: string | null;
  readonly error: string | null;
} {
  const projectionPath = path.join(codexHome, "hooks.json");
  if (!existsSync(projectionPath))
    return {
      available: false,
      events: [],
      observedAt: null,
      error: null
    };
  let content: string;
  try {
    content = readFileSync(projectionPath, "utf8");
  } catch (error) {
    return {
      available: false,
      events: [],
      observedAt: null,
      error: `The applied hook projection could not be read: ${error instanceof Error ? error.message : UNKNOWN_READ_ERROR}`
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      available: false,
      events: [],
      observedAt: null,
      error: `The applied hook projection is not valid JSON: ${error instanceof Error ? error.message : UNKNOWN_READ_ERROR}`
    };
  }
  const events = appliedHookEvents(parsed);
  if (events === null) {
    return {
      available: false,
      events: [],
      observedAt: null,
      error: "The applied hook projection is not a usable hook configuration."
    };
  }
  let observedAt: string | null;
  try {
    observedAt = statSync(projectionPath).mtime.toISOString();
  } catch {
    observedAt = null;
  }
  return { available: true, events, observedAt, error: null };
}

/**
 * The generation one side of the hook comparison holds.
 *
 * The actions are compared as a set rather than as a list: the projection
 * groups the actions by matcher, so two actions that share a matcher are
 * emitted together and the order across matchers follows the grouping rather
 * than the declaration. Comparing the lists in order would report drift
 * where there is none.
 */
function hookGeneration(events: readonly ControlApiHookEvent[]): string {
  const serialized = JSON.stringify(
    events
      .map((event) => ({
        event: event.event,
        actions: event.actions.map((action) => ({
          type: action.type,
          command: action.command,
          matcher: action.matcher ?? null,
          statusMessage: action.statusMessage ?? null
        }))
      }))
      .sort((left, right) =>
        CONTROL_API_COLLATOR.compare(left.event, right.event)
      )
      .map((event) => ({
        event: event.event,
        actions: event.actions.sort((left, right) =>
          CONTROL_API_COLLATOR.compare(
            `${left.matcher ?? ""}\u0000${left.command}\u0000${left.statusMessage ?? ""}`,
            `${right.matcher ?? ""}\u0000${right.command}\u0000${right.statusMessage ?? ""}`
          )
        )
      }))
  );
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * The hook configuration the Runtime applied, against the canonical
 * declaration.
 *
 * The two sides are compared through the shared reconciliation contract: the
 * desired generation is the declaration's effective events and the observed
 * generation is the projection's. A Codex home with no applied projection has
 * not observed anything, and says so rather than reporting a converged empty
 * configuration.
 */
function hooksAppliedState(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string = defaultCodexHomeForReconciliation()
): {
  readonly available: boolean;
  readonly declaredEvents: readonly ControlApiHookDeclaration[];
  readonly events: readonly ControlApiHookEvent[];
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly reconciliation: ReconciliationView;
} {
  const declaration = new RuleSyncRepository(repositoryRoot).loadHooksState(
    HOOK_APPLIED_TARGET
  );
  const applied = readAppliedHookProjection(codexHome);
  const declaredEvents: ControlApiHookDeclaration[] = declaration.events.map(
    (event) => ({
      event: event.event,
      origin: event.origin,
      actions: event.actions
    })
  );
  const desiredGeneration =
    declaration.valid === true && declaredEvents.length > 0
      ? hookGeneration(declaredEvents)
      : null;
  const observedGeneration =
    applied.available && applied.events.length > 0
      ? hookGeneration(applied.events)
      : null;
  const evidence: ReconciliationEvidence = {
    desiredGeneration,
    observedGeneration,
    // No Control API operation applies a hook configuration on its own, so
    // there is no apply to date. The observation is the projection's own
    // moment.
    lastApplyAt: null,
    lastObservationAt: applied.observedAt,
    lastError: applied.error
  };
  return {
    available: applied.available,
    declaredEvents,
    events: applied.events,
    desiredGeneration,
    observedGeneration,
    reconciliation: buildReconciliationView({
      evidence,
      history: [],
      hasObservation: applied.available
    })
  };
}

function hooksAppliedView(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string = defaultCodexHomeForReconciliation()
): Record<string, unknown> {
  const state = hooksAppliedState(repositoryRoot, codexHome);
  return {
    schema: "autodev-control-hooks-applied-v1",
    source: path.join(codexHome, "hooks.json"),
    declarationSource: ".rulesync/hooks.jsonc",
    target: HOOK_APPLIED_TARGET,
    available: state.available,
    declaredEvents: state.declaredEvents,
    events: state.events,
    reconciliation: state.reconciliation
  };
}

/**
 * The action list one hook write sets.
 *
 * The list is the event's whole list, because the declaration replaces an
 * event's list rather than adding to it. An action that is not a command hook
 * with a command is refused rather than dropped, because a write that quietly
 * dropped one of the operator's actions would say it succeeded.
 */
function hookActionsFromBody(value: unknown): HookAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions: HookAction[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) return null;
    if (entry.type !== "command") return null;
    if (typeof entry.command !== "string") return null;
    if (entry.command.trim().length === 0) return null;
    if (entry.matcher !== undefined && typeof entry.matcher !== "string") {
      return null;
    }
    if (
      entry.statusMessage !== undefined &&
      typeof entry.statusMessage !== "string"
    ) {
      return null;
    }
    actions.push({
      type: "command",
      command: entry.command,
      ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
      ...(typeof entry.statusMessage === "string"
        ? { statusMessage: entry.statusMessage }
        : {})
    });
  }
  return actions;
}

/**
 * The refusal of a canonical hook declaration write.
 *
 * A conflict and a refused declaration are different facts: the first says the
 * declaration moved under the write, the second says the write could not be
 * expressed. They get different codes, and the reason is the Runtime's.
 */
function sendHookWriteFailure(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  error: unknown
): void {
  const conflict = error instanceof RuleSyncHooksConflictError;
  const validation = error instanceof RuleSyncHooksValidationError;
  if (!conflict && !validation) throw error;
  const status = conflict ? 409 : 400;
  const code = conflict
    ? "autodev_control_hook_revision_conflict"
    : "autodev_control_hook_invalid_declaration";
  const message =
    error instanceof Error
      ? error.message
      : "The canonical hook declaration is invalid.";
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_hook_declaration",
    resource,
    outcome: "error",
    changes: null,
    reason: conflict ? "revision_conflict" : "invalid_declaration"
  });
  sendControlError(response, status, code, message);
}

/**
 * Write one hook event's action list to the canonical declaration.
 *
 * The write is a compare-and-swap on the declaration's revision, so a write
 * decided on an older declaration is refused rather than applied over a newer
 * one. The projection is applied afterwards and the applied state is read
 * again, so the response says what the Runtime published rather than what the
 * write asked for.
 */
async function patchHookEvent(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  event: string,
  repositoryRoot: string,
  codexHome: string
): Promise<void> {
  const resource = `${CONTROL_API_PATHS.hooks}/${event}`;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_hook_declaration",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Updating the canonical hook declaration requires an operator."
    );
    return;
  }
  if (!isHookEvent(event)) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_hook_declaration",
      resource,
      outcome: "error",
      changes: null,
      reason: "unknown_event"
    });
    sendControlError(
      response,
      400,
      "autodev_control_hook_unknown_event",
      `"${event}" is not a hook event the Codex runtime runs.`
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_hook_declaration",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const { body } = parsed;
  const actions = hookActionsFromBody(body.actions);
  if (
    Object.keys(body).length !== 2 ||
    typeof body.expectedRevision !== "string" ||
    actions === null
  ) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_hook_declaration",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendControlError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "Hook declaration updates require exactly the expected revision and an action list."
    );
    return;
  }

  let updated;
  try {
    updated = await new RuleSyncRepository(repositoryRoot).updateHookEvent({
      event,
      target: HOOK_APPLIED_TARGET,
      actions,
      expectedRevision: body.expectedRevision
    });
  } catch (error) {
    sendHookWriteFailure(response, actor, resource, error);
    return;
  }

  try {
    materializeCurrentHookProjections({ repositoryRoot, codexHome });
  } catch {
    // The declaration was written, so this is not a failed write: the applied
    // state is older than the declaration, and the response says so.
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_hook_declaration",
      resource,
      outcome: "error",
      changes: { event, revision: updated.revision },
      reason: "projection_apply_failed"
    });
    sendControlError(
      response,
      503,
      "autodev_control_hook_apply_failed",
      "Canonical declaration was updated, but the hook projection could not be applied. Reload the hooks before retrying."
    );
    return;
  }

  const applied = hooksAppliedState(repositoryRoot, codexHome);
  const reconciliation = applied.reconciliation;
  const desiredGeneration = applied.desiredGeneration;
  const observedGeneration = applied.observedGeneration;
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_hook_declaration",
    resource,
    outcome: "ok",
    changes: {
      event,
      revision: updated.revision,
      target: HOOK_APPLIED_TARGET
    },
    desiredGeneration,
    observedGeneration
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-hook-event-patch-v1",
      event,
      target: HOOK_APPLIED_TARGET,
      revision: updated.revision,
      changed: updated.revision !== body.expectedRevision,
      actions: updated.actions,
      reconciliation
    } satisfies ControlApiHookEventPatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

/**
 * The per-server tool grants of one role, narrowed to what can be projected.
 *
 * A server whose value is not an array of strings is dropped rather than
 * reported as an empty list. An empty list would say "this role may call no
 * tools on this server", which is a permission claim; dropping it says the
 * grant could not be read, which is what actually happened. Same distinction the
 * servers column makes, where an absent entry is not "all servers".
 */
function contractMcpTools(value: unknown): Record<string, readonly string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const tools: Record<string, readonly string[]> = {};
  for (const [server, names] of Object.entries(value)) {
    if (
      Array.isArray(names) &&
      names.every((name): name is string => typeof name === "string")
    ) {
      tools[server] = names;
    }
  }
  return tools;
}

/**
 * The permission policy the Runtime applied, against the canonical source.
 *
 * The two sides are compared through the shared reconciliation contract: the
 * desired generation is the canonical source's policy values and the observed
 * generation is the composed configuration's. A Codex home with no composed
 * configuration has not observed anything, and says so rather than reporting a
 * converged policy.
 */
function permissionPolicyAppliedState(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string = defaultCodexHomeForReconciliation()
): {
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly applied: ControlApiPermissionPolicy | null;
  readonly reconciliation: ReconciliationView;
} {
  const state = permissionPolicyState(repositoryRoot, codexHome);
  const desiredGeneration =
    state.policy === null ? null : permissionPolicyGeneration(state.policy);
  const observedGeneration =
    state.applied === null ? null : permissionPolicyGeneration(state.applied);
  const evidence: ReconciliationEvidence = {
    desiredGeneration,
    observedGeneration,
    // The apply is the compose, and the observation is the composed
    // configuration's own contents; neither is dated by the Control API
    // itself, so neither is dated here.
    lastApplyAt: null,
    lastObservationAt: null,
    lastError: null
  };
  return {
    desiredGeneration,
    observedGeneration,
    applied: state.applied,
    reconciliation: buildReconciliationView({
      evidence,
      history: [],
      hasObservation: state.applied !== null
    })
  };
}

/**
 * The settings a permission policy write may change.
 *
 * The body is strict: a key the policy does not have is a request the route
 * does not understand, and a body that carries one is refused rather than
 * partly applied.
 */
const PERMISSION_POLICY_UPDATE_KEYS = new Set([
  "expectedRevision",
  "approvalPolicy",
  "sandboxMode",
  "approvalsReviewer",
  "networkAccess",
  "webSearch"
]);

/** A revision is a sha256: the canonical file's own digest. */
const PERMISSION_POLICY_REVISION_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * One setting of the policy, read from a request body.
 *
 * Each setting is read by its own reader, so a setting that is absent is
 * absent rather than a default, and a setting that is present but wrong is
 * refused rather than coerced.
 */
type PermissionPolicySetting =
  | { readonly ok: true; readonly value: string | boolean }
  | { readonly ok: false };

function permissionPolicyApprovalPolicy(
  value: unknown
): PermissionPolicySetting {
  if (value !== "never" && value !== "always" && value !== "on-demand") {
    return { ok: false };
  }
  return { ok: true, value };
}

function permissionPolicySandboxMode(value: unknown): PermissionPolicySetting {
  if (!isSandboxMode(value)) return { ok: false };
  return { ok: true, value };
}

function permissionPolicyApprovalsReviewer(
  value: unknown
): PermissionPolicySetting {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

function permissionPolicyBoolean(value: unknown): PermissionPolicySetting {
  if (typeof value !== "boolean") return { ok: false };
  return { ok: true, value };
}

function permissionPolicyUpdateFromBody(body: Record<string, unknown>): {
  readonly expectedRevision: string;
  readonly update: Omit<ControlApiPermissionsPatchRequest, "expectedRevision">;
} | null {
  for (const key of Object.keys(body)) {
    if (!PERMISSION_POLICY_UPDATE_KEYS.has(key)) return null;
  }
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== "string" ||
    !PERMISSION_POLICY_REVISION_PATTERN.test(expectedRevision)
  ) {
    return null;
  }
  const update: {
    -readonly [
      Key in keyof Omit<ControlApiPermissionsPatchRequest, "expectedRevision">
    ]: Omit<ControlApiPermissionsPatchRequest, "expectedRevision">[Key];
  } = {};
  let fields = 0;

  const approvalPolicy = body.approvalPolicy;
  if (approvalPolicy !== undefined) {
    const read = permissionPolicyApprovalPolicy(approvalPolicy);
    if (!read.ok || typeof read.value !== "string") return null;
    update.approvalPolicy = read.value as "never" | "always" | "on-demand";
    fields += 1;
  }
  const sandboxMode = body.sandboxMode;
  if (sandboxMode !== undefined) {
    const read = permissionPolicySandboxMode(sandboxMode);
    if (!read.ok || typeof read.value !== "string") return null;
    update.sandboxMode = read.value as SandboxMode;
    fields += 1;
  }
  const approvalsReviewer = body.approvalsReviewer;
  if (approvalsReviewer !== undefined) {
    const read = permissionPolicyApprovalsReviewer(approvalsReviewer);
    if (!read.ok || typeof read.value !== "string") return null;
    update.approvalsReviewer = read.value;
    fields += 1;
  }
  const networkAccess = body.networkAccess;
  if (networkAccess !== undefined) {
    const read = permissionPolicyBoolean(networkAccess);
    if (!read.ok || typeof read.value !== "boolean") return null;
    update.networkAccess = read.value;
    fields += 1;
  }
  const webSearch = body.webSearch;
  if (webSearch !== undefined) {
    const read = permissionPolicyBoolean(webSearch);
    if (!read.ok || typeof read.value !== "boolean") return null;
    update.webSearch = read.value;
    fields += 1;
  }
  if (fields === 0) return null;
  return { expectedRevision, update };
}

/**
 * The refusal a write to the canonical policy answers with.
 *
 * A conflict and a write that could not be expressed are two different facts,
 * and the caller is told which one happened.
 */
function sendPermissionPolicyWriteFailure(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  error: unknown
): void {
  const conflict = error instanceof PermissionPolicyConflictError;
  const validation = error instanceof PermissionPolicyValidationError;
  if (!conflict && !validation) throw error;
  const status = conflict ? 409 : 400;
  const code = conflict
    ? "autodev_control_permission_policy_revision_conflict"
    : "autodev_control_permission_policy_invalid_update";
  const message =
    error instanceof Error
      ? error.message
      : "The permission policy could not be written.";
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_permission_policy",
    resource,
    outcome: "error",
    changes: null,
    reason: conflict ? "revision_conflict" : "invalid_update"
  });
  sendControlError(response, status, code, message);
}

/**
 * Change one setting of the canonical permission policy.
 *
 * The write is a compare-and-swap on the policy file's revision, so a change
 * decided on a policy that has since moved is refused rather than applied over
 * the newer one. The composed configuration is refreshed afterwards and the
 * applied policy is read again, so the response says what the Runtime
 * published rather than what the write asked for.
 */
async function patchPermissions(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  repositoryRoot: string,
  codexHome: string
): Promise<void> {
  const resource = CONTROL_API_PATHS.permissions;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_permission_policy",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Changing the permission policy requires an operator."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_permission_policy",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const update = permissionPolicyUpdateFromBody(parsed.body);
  if (update === null) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_permission_policy",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_update"
    });
    sendControlError(
      response,
      400,
      "autodev_control_permission_policy_invalid_update",
      "A permission policy update requires the expected revision and at least one of approval policy, sandbox mode, approvals reviewer, network access or web search."
    );
    return;
  }

  let written;
  try {
    written = updatePermissionPolicy({
      file: new ConfigRepository(repositoryRoot).permissionPolicyPath(),
      expectedRevision: update.expectedRevision,
      update: update.update
    });
  } catch (error) {
    sendPermissionPolicyWriteFailure(response, actor, resource, error);
    return;
  }

  try {
    materializeCurrentMcpConfiguration({ repositoryRoot, codexHome });
  } catch {
    // The policy was written, so this is not a failed write: the applied
    // configuration is older than the policy, and the response says so.
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_permission_policy",
      resource,
      outcome: "error",
      changes: { revision: written.revision },
      reason: "apply_failed"
    });
    sendControlError(
      response,
      503,
      "autodev_control_permission_policy_apply_failed",
      "The permission policy was updated, but the user configuration could not be composed. Reload the permissions before retrying."
    );
    return;
  }

  const applied = permissionPolicyAppliedState(repositoryRoot, codexHome);
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_permission_policy",
    resource,
    outcome: "ok",
    changes: { revision: written.revision, changed: written.changed },
    desiredGeneration: applied.desiredGeneration,
    observedGeneration: applied.observedGeneration
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-permissions-patch-v1",
      revision: written.revision,
      changed: written.changed,
      policy: written.policy,
      applied: applied.applied,
      reconciliation: applied.reconciliation
    } satisfies ControlApiPermissionsPatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

/**
 * Where the Runtime applies the permission policy.
 *
 * The portable source is composed into the user configuration Codex reads, so
 * the applied policy is read from the composed file rather than from the
 * source: a source that was written but never composed is a policy the product
 * is not running.
 */
const CODEX_USER_CONFIG_FILE = "config.toml";

/**
 * The permission policy, as the canonical source states it and as the Runtime
 * applied it.
 *
 * The two are separate facts. The canonical source is what the operator
 * declared; the composed configuration is what Codex reads. A policy that was
 * written and never applied is a pending change, not a failure and not a
 * converged one.
 */
function permissionPolicyState(
  repositoryRoot: string,
  codexHome: string
): {
  readonly source: string;
  readonly revision: string | null;
  readonly policy: ControlApiPermissionPolicy | null;
  readonly policyStatus: "valid" | "invalid" | "unavailable";
  readonly policyReason: string | null;
  readonly appliedSource: string;
  readonly applied: ControlApiPermissionPolicy | null;
  readonly appliedRevision: string | null;
} {
  const repository = new ConfigRepository(repositoryRoot);
  const source = "config/config.autodev.toml";
  const read = readPermissionPolicyFile(repository.permissionPolicyPath());
  const appliedSource = path.join(codexHome, CODEX_USER_CONFIG_FILE);
  const appliedRead = readPermissionPolicyFile(appliedSource);
  return {
    source,
    revision: read.status === "unavailable" ? null : read.revision,
    policy: read.status === "valid" ? read.policy : null,
    policyStatus: read.status,
    policyReason: read.status === "valid" ? null : read.reason,
    appliedSource,
    applied: appliedRead.status === "valid" ? appliedRead.policy : null,
    appliedRevision:
      appliedRead.status === "unavailable" ? null : appliedRead.revision
  };
}

/**
 * The effective capability matrix, with each role's real sandbox.
 *
 * The matrix used to name every role's sandbox by way of a boolean the
 * execution contract keeps: a role declared `danger-full-access` came back as
 * `workspace-write`, so the Console named the orchestrator, the smart agent
 * and the worker as sandboxed roles when they are the product's three
 * unsandboxed ones. The mode is read from the role's own declaration now, and
 * a role whose declaration cannot be read is reported as not observed rather
 * than as the nearest mode the product knows.
 */
function permissionsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT,
  codexHome: string = defaultCodexHomeForReconciliation()
): Record<string, unknown> {
  const roles = getDefaultExecutionContract().roles ?? {};
  const repository = new ConfigRepository(repositoryRoot);
  const state = permissionPolicyState(repositoryRoot, codexHome);
  const roleSandboxes = readRoleSandboxModes(
    repository.agentRolesPath(),
    // A role that declares no sandbox inherits the policy's. When the policy
    // could not be read there is no mode to inherit, and the role's sandbox
    // is not observed -- it is not the product's nearest mode. This used to
    // fall back to `workspace-write`, which named a role as sandboxed on the
    // strength of a policy nobody read.
    state.policy?.sandboxMode ?? null
  );
  // Typed as the contract's own entry rather than `Record<string, unknown>`:
  // the anonymous shape above *is* the published one, and writing it out here is
  // what stops the two from drifting without a compiler noticing. Mutable
  // because the published type is `Readonly` and this loop is what fills it.
  const rolePermissions: Record<
    string,
    ControlApiPermissionsResponse["rolePermissions"][string]
  > = {};
  for (const [role, raw] of Object.entries(roles)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    rolePermissions[role] = {
      // A role with no readable declaration has no observed sandbox. It is
      // not the read-only mode and it is not the unrestricted one: both would
      // be a claim the source does not support.
      sandboxMode: roleSandboxes[role] ?? null,
      // Same execution-contract join `/control/agents` uses, so the effective
      // capability matrix never contradicts the Agents surface.
      mcp: Array.isArray(entry.mcp) ? entry.mcp : [],
      // The per-server tool grants are projected too. Server exposure without
      // them answers "may this role reach lsp?" and not "may it call
      // lsp_goto_definition", which is the question the matrix exists to answer.
      mcpTools: contractMcpTools(entry.mcpTools),
      skills: Array.isArray(entry.skills) ? entry.skills : []
    };
  }
  return {
    schema: "autodev-control-permissions-v2",
    source: state.source,
    readOnly: false,
    revision: state.revision,
    policy: state.policy,
    policyStatus: state.policyStatus,
    policyReason: state.policyReason,
    applied: state.applied,
    appliedSource: state.appliedSource,
    rolePermissions
  } satisfies ControlApiPermissionsResponse;
}

/**
 * Read the canonical role prompts, or report that they were not observed.
 *
 * The directory's absence is an observation: no role prompt is configured
 * there, and that is a measured zero. A read that failed for any other reason
 * is not an observation, and the list of role prompts is then not known -- an
 * empty list there would claim the repository holds none, which is a claim
 * about the read rather than about the repository.
 */
function readRolePrompts(
  rolePromptsDir: string
): Array<{ role: string; path: string }> | null {
  try {
    return readdirSync(rolePromptsDir)
      .filter((file) => file.endsWith(".md"))
      .sort(CONTROL_API_COLLATOR.compare)
      .map((file) => ({
        role: file.replace(MD_EXTENSION_PATTERN, ""),
        path: `agents/prompts/roles/${file}`
      }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

function promptsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const commandState = new RuleSyncRepository(repositoryRoot).loadCommands();
  const commands =
    commandState.valid === true
      ? commandState.commands.map((command) => ({
          name: command.name,
          path: command.path,
          ...(command.description === undefined
            ? {}
            : { description: command.description })
        }))
      : [];
  const rolePromptsDir = path.join(
    repositoryRoot,
    "agents",
    "prompts",
    "roles"
  );
  const rolePrompts = readRolePrompts(rolePromptsDir);
  return {
    schema: "autodev-control-prompts-v2",
    source: commandState.source,
    // The prompts collection has a canonical write path -- the command's own
    // source at `PATCH /control/prompts/:name` -- so it is not read-only. This
    // used to say it was, which was a stale constant: the write path arrived
    // after it and the flag was never revisited.
    readOnly: false,
    valid: commandState.valid,
    issues: commandState.issues,
    totalCommands: commandState.valid === true ? commands.length : null,
    commands,
    rolePrompts
  } satisfies ControlApiPromptsResponse;
}

/**
 * Observe the projected Codex prompt file for a RuleSync command and return
 * the sha256 content hash of its bytes. Returns `null` when the file is
 * missing, unreadable, or the canonical command is not a RuleSync command;
 * either way the observation is "not observed" rather than a synthetic
 * success.
 */
function observePromptProjection(
  name: string,
  codexHome: string
): string | null {
  const projectedPath = path.join(codexHome, "prompts", `${name}.md`);
  try {
    const content = readFileSync(projectedPath, "utf8");
    return createHash("sha256").update(content, "utf8").digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function hashString(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Look up the most recent audit envelope for a resource identifier and
 * extract its bounded fields. Returns `null` when no audit entry exists
 * yet, so callers can render `not-observed` rather than fabricating a
 * last-apply timestamp.
 */
function findLatestAuditFor(resourceFilter: string): {
  readonly timestamp: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
  readonly reason: string | null;
} | null {
  return latestAuditEvidence(getOperationHistory(resourceFilter));
}

/**
 * The most recent non-denied apply recorded in a list of audit envelopes.
 *
 * A `denied` envelope is skipped. A refusal is not an apply: nothing was
 * attempted and nothing changed, so treating it as the latest evidence would
 * stamp the resource with a last-apply time and a `lastError` describing a
 * request that was correctly rejected — reporting a failed apply for a resource
 * that is still perfectly converged. Validation and persistence failures are
 * `error`, not `denied`, and remain evidence.
 */
function latestAuditEvidence(envelopes: readonly Record<string, unknown>[]): {
  readonly timestamp: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
  readonly reason: string | null;
} | null {
  for (const envelope of envelopes) {
    if (
      typeof envelope.timestamp === "string" &&
      typeof envelope.outcome === "string" &&
      envelope.outcome !== "denied"
    ) {
      return {
        timestamp: envelope.timestamp,
        desiredGeneration:
          typeof envelope.desiredGeneration === "string"
            ? envelope.desiredGeneration
            : null,
        observedGeneration:
          typeof envelope.observedGeneration === "string"
            ? envelope.observedGeneration
            : null,
        restartRequired: envelope.restartRequired === true,
        reason: typeof envelope.reason === "string" ? envelope.reason : null
      };
    }
  }
  return null;
}

function historyForResource(
  resource: string
): readonly OperationHistoryEntry[] {
  return auditEnvelopesToHistory(getOperationHistory(resource));
}

/**
 * Generation identity for one canonical prompt.
 *
 * Both sides of the comparison must be expressed in the same domain or they
 * can never be equal. The canonical revision is the only stable identity the
 * Runtime holds, so the desired generation is the current canonical revision
 * and the observed generation is the canonical revision that the projection
 * on disk was generated from (recorded by the apply that wrote it). Hashing
 * the projected file bytes here instead would compare a revision against a
 * rendering of it, which can never converge.
 */
function promptGeneration(revision: string | null | undefined): string | null {
  return typeof revision === "string" && revision.length > 0 ? revision : null;
}

function promptReconciliationView(args: {
  readonly name: string;
  readonly codexHome: string;
  readonly expectedRevision: string | null;
}): {
  readonly status: ReconciliationStatus;
  readonly history: readonly OperationHistoryEntry[];
} {
  const resource = `${CONTROL_API_PATHS.prompts}/${args.name}`;
  const desiredGeneration = promptGeneration(args.expectedRevision);
  const latest = findLatestAuditFor(resource);
  // The projection counts as observed only when the last successful apply
  // projected the *current* canonical revision and that projection still
  // exists on disk. A stale projection, or one generated from an older
  // revision, stays pending instead of being reported as converged.
  const projectionPresent =
    observePromptProjection(args.name, args.codexHome) !== null;
  const observedGeneration =
    latest !== null &&
    latest.observedGeneration !== null &&
    latest.observedGeneration === desiredGeneration &&
    projectionPresent
      ? latest.observedGeneration
      : null;
  const evidence: ReconciliationEvidence = {
    desiredGeneration,
    observedGeneration,
    lastApplyAt: latest?.timestamp ?? null,
    lastObservationAt:
      observedGeneration === null ? null : (latest?.timestamp ?? null),
    lastError: boundReconciliationError(latest?.reason ?? null)
  };
  return buildReconciliationView({
    evidence,
    history: historyForResource(resource),
    hasObservation: projectionPresent,
    restartRequired: false
  });
}

/**
 * The reconciliation view for one canonical RuleSync skill.
 *
 * A skill reaches the runtime differently from a command: the installer links
 * the canonical source into the user's skills directory, so the runtime reads
 * the canonical source itself rather than a copy of it. The observation is
 * therefore a live fact -- the runtime's installed skill is this source, or it
 * is not -- and not an apply that has to be refreshed.
 *
 * So the observed generation is the canonical revision whenever the installed
 * link holds this source, and `null` when it does not. A skill that was never
 * written through the Console is still observed, because the runtime reads the
 * same file the operator is editing; a skill whose link is missing or points
 * somewhere else is not observed at all, and the Console says so rather than
 * claiming the two agree.
 */
function skillReconciliationView(args: {
  readonly name: string;
  readonly repositoryRoot: string;
  readonly home: string;
  readonly desiredRevision: string;
}): {
  readonly status: ReconciliationStatus;
  readonly history: readonly OperationHistoryEntry[];
} {
  const resource = `${CONTROL_API_PATHS.skills}/${args.name}/content`;
  const desiredGeneration = promptGeneration(args.desiredRevision);
  const latest = findLatestAuditFor(resource);
  const installed = installedSkillMatches({
    repositoryRoot: args.repositoryRoot,
    home: args.home,
    name: args.name
  });
  const observedGeneration = installed ? desiredGeneration : null;
  const evidence: ReconciliationEvidence = {
    desiredGeneration,
    observedGeneration,
    lastApplyAt: latest?.timestamp ?? null,
    // The observation is the link, and the link is read now, so the time of
    // the observation is the time of this read rather than the time of an
    // apply that refreshed a copy.
    lastObservationAt:
      observedGeneration === null ? null : new Date().toISOString(),
    lastError: boundReconciliationError(latest?.reason ?? null)
  };
  return buildReconciliationView({
    evidence,
    history: historyForResource(resource),
    hasObservation: installed,
    restartRequired: false
  });
}

function promptDiffSummary(args: {
  readonly name: string;
  readonly codexHome: string;
  readonly projectionUpdated: boolean;
}): ReconciliationDiff {
  const observed = observePromptProjection(args.name, args.codexHome);
  if (args.projectionUpdated && observed === null) {
    return reconcileDiffSummary({
      summary:
        "Canonical source updated; Rulesync projection is pending observation."
    });
  }
  if (args.projectionUpdated) {
    return reconcileDiffWithIdentifier({
      summary: "Canonical source updated; Rulesync projection applied.",
      identifier: observed ?? ""
    });
  }
  return reconcileDiffSummary({
    summary: "Canonical source unchanged."
  });
}

function defaultHomeForReconciliation(): string {
  return process.env.HOME?.trim() || homedir();
}

function defaultCodexHomeForReconciliation(): string {
  const home = defaultHomeForReconciliation();
  return process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
}

/**
 * The prompt's own read.
 *
 * A prompt has two canonical sources -- the RuleSync command catalogue and the
 * role-prompt directory -- and the detail is served from whichever holds it.
 * Each read says which of the three things happened: the prompt was read, the
 * prompt is not there, or the source could not be read. The third is not the
 * second: "this prompt does not exist" and "the file that holds this prompt
 * could not be parsed" are different claims, and only the first is a 404.
 */
function promptDetailView(
  name: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): ReadOnlyDetailResult {
  const repo = new RuleSyncRepository(repositoryRoot);
  const command = repo.loadCommand(name);
  if (command.status === "unreadable") {
    return {
      status: "unreadable",
      code: "autodev_control_api_prompt_command_source_not_read",
      message: `The canonical command "${name}" could not be read: ${command.reason}`
    };
  }
  if (command.status === "found") {
    const reconciliation = promptReconciliationView({
      name,
      codexHome: defaultCodexHomeForReconciliation(),
      expectedRevision: command.command.revision
    });
    return {
      status: "found",
      detail: {
        schema: "autodev-control-prompt-detail-v4",
        name,
        type: "command",
        source: command.command.path,
        content: command.command.content,
        preview: command.command.prompt,
        revision: command.command.revision,
        diff: reconcileDiffWithIdentifier({
          summary:
            "Canonical RuleSync command; Rulesync projection observed via Codex home.",
          identifier: hashString(command.command.revision) ?? ""
        }),
        reconciliation
      } satisfies ControlApiPromptDetailResponse
    };
  }
  const rolePath = path.join(
    repositoryRoot,
    "agents",
    "prompts",
    "roles",
    `${name}.md`
  );
  if (existsSync(rolePath)) {
    try {
      const content = readFileSync(rolePath, "utf8");
      const revision = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
      return {
        status: "found",
        detail: {
          schema: "autodev-control-prompt-detail-v4",
          name,
          type: "role",
          source: `agents/prompts/roles/${name}.md`,
          content,
          preview: content,
          revision,
          diff: reconcileDiffSummary({
            summary:
              "Role prompt is read-only; canonical source lives under agents/prompts/roles/."
          }),
          reconciliation: promptReconciliationView({
            name,
            codexHome: defaultCodexHomeForReconciliation(),
            expectedRevision: revision
          })
        } satisfies ControlApiPromptDetailResponse
      };
    } catch (error) {
      return {
        status: "unreadable",
        code: "autodev_control_api_prompt_role_source_not_read",
        message: `The role prompt "${name}" could not be read: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      };
    }
  }
  return { status: "unknown" };
}

function promptVersionsView(
  name: string,
  page: RuleSyncCommandHistoryPage,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): ReadOnlyDetailResult {
  const history = new RuleSyncRepository(repositoryRoot).loadCommandHistory(
    name,
    page
  );
  if (!history) return { status: "unknown" };
  return {
    status: "found",
    detail: {
      schema: "autodev-control-prompt-versions-v2",
      name,
      status: history.status,
      versions: history.versions,
      hasMore: history.hasMore,
      offset: page.offset,
      limit: page.limit
    } satisfies ControlApiPromptVersionsResponse
  };
}

function promptVersionView(
  name: string,
  versionHash: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): ReadOnlyDetailResult {
  const version = new RuleSyncRepository(repositoryRoot).loadCommandVersion(
    name,
    versionHash
  );
  if (version.status === "unreadable") {
    return {
      status: "unreadable",
      code: "autodev_control_api_prompt_version_source_not_read",
      message: version.reason
    };
  }
  if (version.status === "not-found") return { status: "unknown" };
  return {
    status: "found",
    detail: {
      schema: "autodev-control-prompt-version-v1",
      name: version.version.name,
      versionHash: version.version.versionHash,
      updatedAt: version.version.updatedAt,
      content: version.version.content,
      diff: version.version.diff
    } satisfies ControlApiPromptVersionResponse
  };
}

function routingView(now: number): Record<string, unknown> {
  const activeCooldowns: Record<string, unknown> = {};
  for (const route of ROUTES) {
    const entry = COOLDOWNS.get(route.provider, now);
    if (entry) {
      activeCooldowns[route.provider] = entry;
    }
  }
  return {
    schema: "autodev-control-routing-v1",
    runtime: ROUTING_POLICY.runtimeState(),
    routes: ROUTES.map((r) => ({
      provider: r.provider,
      pattern: r.pattern.source,
      baseUrl: r.baseUrl
    })),
    cooldowns: activeCooldowns,
    concurrency: getDefaultConcurrencyManager().concurrencyStatus(now)
  } satisfies ControlApiRoutingResponse;
}

async function persistRoutingPolicy(): Promise<void> {
  const persisted = await getDefaultPersistenceManager().persistNow();
  if (!persisted) throw new Error("Routing policy persistence failed.");
}

/**
 * Reconciliation fields an enablement result can carry back into the audit
 * envelope, so the operation history records the same generations the
 * response reports.
 */
interface EnablementReconciliation {
  readonly desiredGeneration: string;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
}

/** Spread helper so a `null` reconciliation contributes no audit fields. */
function auditReconciliationFields(
  reconciliation: EnablementReconciliation | null
): Partial<{
  desiredGeneration: string;
  observedGeneration: string | null;
  restartRequired: boolean;
}> {
  return reconciliation === null ? {} : reconciliation;
}

/**
 * Read the reconciliation evidence out of a mutation response body. Returns
 * `null` for a mutation that publishes no reconciliation, which leaves the audit
 * generations null rather than inventing them. Every enablement mutation
 * (provider role and model alike) publishes it.
 */
function reconciliationOf(body: unknown): EnablementReconciliation | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const reconciliation = (body as Record<string, unknown>).reconciliation;
  if (!reconciliation || typeof reconciliation !== "object") return null;
  const status = (reconciliation as { readonly status?: unknown }).status;
  if (!status || typeof status !== "object") return null;
  const { desiredGeneration, observedGeneration } = status as {
    readonly desiredGeneration?: unknown;
    readonly observedGeneration?: unknown;
  };
  if (typeof desiredGeneration !== "string") return null;
  return {
    desiredGeneration,
    observedGeneration:
      typeof observedGeneration === "string" ? observedGeneration : null,
    restartRequired: false
  };
}

/**
 * One operator-only `{ "enabled": boolean }` toggle over Runtime routing
 * policy state. Provider-role and model enablement share this flow so every
 * toggle validates, persists, rolls back, and audits identically.
 */
type EnablementPatchResult =
  | Omit<ControlApiModelPatchResponse, "actor">
  | Omit<ControlApiAgentEnablementPatchResponse, "actor">;

interface EnablementMutation {
  readonly action: string;
  readonly resource: string;
  readonly subject: string;
  readonly known: boolean;
  readonly unknownReason: string;
  readonly unknownCode: string;
  readonly unknownMessage: string;
  readonly unknownStatus?: number;
  readonly current: () => boolean;
  readonly currentRevision?: () => string | null;
  readonly revisionConflictCode?: string;
  readonly serializeKey?: string;
  readonly apply: (enabled: boolean) => void;
  /**
   * The body minus `actor`, which `patchEnablement` stamps from the verified
   * caller. Modelled as an explicit response union rather than a bare record so
   * each resource mutation still satisfies its own wire contract.
   */
  readonly result: (
    enabled: boolean,
    previous: boolean
  ) => EnablementPatchResult;
}

async function patchEnablement(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  mutation: EnablementMutation
): Promise<void> {
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string,
    reconciliation: EnablementReconciliation | null = null
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: mutation.action,
      resource: mutation.resource,
      outcome,
      changes,
      ...(reason ? { reason } : {}),
      ...auditReconciliationFields(reconciliation)
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      `Operator access is required to change ${mutation.subject} state.`
    );
    return;
  }

  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      parsedBody.status,
      parsedBody.code,
      parsedBody.message
    );
    return;
  }
  const body = parsedBody.body;
  const revisionAware = mutation.currentRevision !== undefined;
  if (
    Object.keys(body).length !== (revisionAware ? 2 : 1) ||
    typeof body.enabled !== "boolean" ||
    (revisionAware &&
      (typeof body.expectedRevision !== "string" ||
        !AGENT_ENABLEMENT_REVISION_PATTERN.test(body.expectedRevision)))
  ) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      revisionAware
        ? `${mutation.subject.charAt(0).toUpperCase()}${mutation.subject.slice(1)} body must contain only boolean enabled and a valid expectedRevision.`
        : `${mutation.subject.charAt(0).toUpperCase()}${mutation.subject.slice(1)} body must contain only a boolean enabled field.`
    );
    return;
  }
  const enabled = body.enabled;

  if (!mutation.known) {
    audit("error", { enabled }, mutation.unknownReason);
    sendControlError(
      response,
      mutation.unknownStatus ?? 404,
      mutation.unknownCode,
      mutation.unknownMessage
    );
    return;
  }

  const applyMutation = async (): Promise<void> => {
    if (mutation.currentRevision) {
      const currentRevision = mutation.currentRevision();
      if (
        currentRevision === null ||
        body.expectedRevision !== currentRevision
      ) {
        audit("error", { enabled }, "revision_conflict");
        sendControlError(
          response,
          409,
          mutation.revisionConflictCode ??
            "autodev_control_api_revision_conflict",
          `${mutation.subject.charAt(0).toUpperCase()}${mutation.subject.slice(1)} state changed after it was read; reload and retry.`
        );
        return;
      }
    }

    const previous = mutation.current();
    let result: EnablementPatchResult;
    let reconciliation: EnablementReconciliation | null;
    try {
      mutation.apply(enabled);
      result = mutation.result(enabled, previous);
      reconciliation = reconciliationOf(result);
      await persistRoutingPolicy();
    } catch {
      try {
        mutation.apply(previous);
      } catch {
        // Preserve the original failure; the audit record below captures it.
      }
      audit("error", { enabled, previous }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        `${mutation.subject.charAt(0).toUpperCase()}${mutation.subject.slice(1)} change could not be persisted.`
      );
      return;
    }

    // The response and audit evidence are derived before persistence commits.
    // If deriving either throws, the same catch path restores the policy.
    audit("ok", { enabled, previous }, undefined, reconciliation);
    sendJson(
      response,
      200,
      { ...result, actor: actor.actor },
      {
        "cache-control": "no-store",
        vary: CONTROL_VARY_HEADER
      }
    );
  };

  if (mutation.serializeKey)
    await serializeRouterStateMutation(mutation.serializeKey, applyMutation);
  else await applyMutation();
}

async function patchProviderRole(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  providerInput: string,
  role: ProviderRole
): Promise<void> {
  const provider = providerInput.toLowerCase();
  const resource = `${CONTROL_API_PATHS.providers}/${providerInput}/roles/${role}`;
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string,
    reconciliation: EnablementReconciliation | null = null
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome,
      changes,
      ...(reason ? { reason } : {}),
      ...auditReconciliationFields(reconciliation)
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to change provider role state."
    );
    return;
  }

  const known =
    Object.hasOwn(ROUTING_POLICY.config.providers ?? {}, provider) ||
    ROUTES.some((route) => route.provider === provider);

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit("error", null, "invalid_body");
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const body = parsed.body;
  const priority = body.priority;
  const model = body.model ?? null;
  const rawEffort = body.reasoningEffort;
  const reasoningEffort =
    rawEffort === undefined || rawEffort === null || rawEffort === ""
      ? null
      : typeof rawEffort === "string"
        ? rawEffort.trim()
        : rawEffort;

  const reasoningCatalog = modelCatalogReasoningLevels();
  const assignedModel = typeof model === "string" ? model : null;
  const modelInfo = assignedModel
    ? reasoningCatalog.get(assignedModel)
    : undefined;
  const supportedReasoningLevels = modelInfo?.supportedLevels ?? [];

  const priorityIsValid =
    priority === 1 ||
    priority === 2 ||
    priority === 3 ||
    priority === "disabled";
  // Model routeability depends on mutable assignments and discovery state. It
  // is checked inside the serialized mutation turn below, not against a value
  // that may be cleared or disabled while this request waits in the queue.
  const modelTypeIsValid = model === null || typeof model === "string";
  const reasoningEffortIsValid =
    reasoningEffort === null ||
    (typeof reasoningEffort === "string" &&
      model !== null &&
      supportedReasoningLevels.includes(reasoningEffort));

  if (
    Object.keys(body).some(
      (key) =>
        key !== "priority" && key !== "model" && key !== "reasoningEffort"
    ) ||
    !priorityIsValid ||
    !modelTypeIsValid ||
    !reasoningEffortIsValid
  ) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      'Provider role body must carry a priority of 1, 2, 3 or "disabled", an optional reasoningEffort that matches one of the assigned model\'s supported reasoning levels, and a model that is null, unchanged from the current assignment, or currently observed as routeable for this provider.'
    );
    return;
  }
  if (!known) {
    audit(
      "error",
      {
        priority,
        model,
        ...(body.reasoningEffort === undefined ? {} : { reasoningEffort })
      },
      "unknown_provider"
    );
    sendControlError(
      response,
      404,
      "autodev_control_api_unknown_provider",
      "Unknown provider."
    );
    return;
  }

  const isAgyFixed =
    provider === "antigravity" && Boolean(modelEffort(assignedModel ?? ""));
  const effectiveReasoningEffort = isAgyFixed
    ? modelEffort(assignedModel ?? "")
    : (reasoningEffort ?? modelInfo?.defaultLevel ?? null);
  const reasoningEffortInForce =
    !isAgyFixed ||
    reasoningEffort === null ||
    reasoningEffort === effectiveReasoningEffort;

  await serializeRouterStateMutation(ROUTER_STATE_MUTATION_KEY, async () => {
    // State-dependent checks belong inside the same serialized turn as the
    // write. Otherwise a role request accepted as "unchanged" can wait behind
    // Reset to defaults, then reintroduce a model that is no longer configured
    // or currently observed after the reset clears its prior assignment.
    if (ROUTING_POLICY.isProviderDisabled(provider)) {
      audit(
        "denied",
        {
          priority,
          model,
          ...(body.reasoningEffort === undefined ? {} : { reasoningEffort })
        },
        "provider_disabled"
      );
      sendControlError(
        response,
        409,
        "autodev_control_api_provider_disabled",
        "This provider is disabled. Enable it before changing its roles."
      );
      return;
    }

    const previous = ROUTING_POLICY.assignmentFor(provider, role) ?? null;
    const modelIsValid =
      model === null ||
      (typeof model === "string" &&
        (model === previous?.model ||
          (ROUTING_POLICY.isModelAvailableForProvider(provider, model) &&
            providerHasCurrentModelDiscovery(provider, model))));
    if (!modelIsValid) {
      audit("error", null, "invalid_body");
      sendControlError(
        response,
        400,
        "autodev_control_api_bad_body",
        'Provider role body must carry a priority of 1, 2, 3 or "disabled", an optional reasoningEffort that matches one of the assigned model\'s supported reasoning levels, and a model that is null, unchanged from the current assignment, or currently observed as routeable for this provider.'
      );
      return;
    }

    const next: ProviderRoleAssignment = {
      priority,
      model,
      reasoningEffort
    };
    // An unobserved assignment is reported as null on the wire: JSON carries no
    // undefined, and "there was no assignment" must not be reported as an empty
    // object, which would read as a role whose model was cleared.
    const auditChanges: Record<string, unknown> = {
      priority,
      model,
      ...(body.reasoningEffort === undefined ? {} : { reasoningEffort })
    };
    try {
      ROUTING_POLICY.setProviderAssignment(provider, role, next);
      await persistRoutingPolicy();
    } catch {
      try {
        // Restoring the prior state means clearing the assignment when there was
        // none, not only writing back the one this change replaced. A rejected
        // change must never keep steering routing just because it had nothing to
        // overwrite.
        if (previous)
          ROUTING_POLICY.setProviderAssignment(provider, role, previous);
        else ROUTING_POLICY.clearProviderAssignment(provider, role);
      } catch {
        // Preserve the original failure; the audit record captures it.
      }
      audit("error", { ...auditChanges, previous }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        "Provider role change could not be persisted."
      );
      return;
    }

    const observed = ROUTING_POLICY.assignmentFor(provider, role) ?? null;
    const desiredGeneration = `${role}:${priority}/${model ?? "none"}`;
    const observedGeneration =
      observed?.priority === priority &&
      observed?.model === model &&
      (observed?.reasoningEffort ?? null) === reasoningEffort
        ? desiredGeneration
        : null;
    const appliedAt = new Date().toISOString();
    // The audit record and the response body must carry the same generations the
    // operator sees, so both are derived from these two values rather than
    // computed twice.
    const auditReconciliation: EnablementReconciliation = {
      desiredGeneration,
      observedGeneration,
      restartRequired: false
    };
    const reconciliation = buildReconciliationView({
      evidence: {
        desiredGeneration,
        observedGeneration,
        lastApplyAt: appliedAt,
        lastObservationAt: observedGeneration === null ? null : appliedAt,
        lastError: null
      },
      history: historyForResource(resource),
      hasObservation: observedGeneration !== null
    });
    audit("ok", { ...auditChanges, previous }, undefined, auditReconciliation);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-provider-role-v3",
        provider,
        role,
        priority,
        model,
        reasoningEffort,
        effectiveReasoningEffort,
        reasoningEffortInForce,
        supportedReasoningLevels,
        previous,
        actor: actor.actor,
        reconciliation
      } satisfies ControlApiProviderRolePatchResponse,
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  });
}
/**
 * Whether the runtime currently serves this provider at all. Used by both
 * provider-wide mutations to decide whether an applied change really landed.
 */
function providerIsKnown(provider: string): boolean {
  return (
    Object.hasOwn(ROUTING_POLICY.config.providers ?? {}, provider) ||
    ROUTES.some((route) => route.provider === provider)
  );
}

/**
 * Build the reconciliation block and audit/response envelope shared by the
 * provider-wide mutations. The audit record and the response body are derived
 * from the same two generations so they cannot drift apart.
 */
function providerMutationReconciliation(
  resource: string,
  desiredGeneration: string,
  observed: boolean
): {
  audit: EnablementReconciliation;
  view: ReturnType<typeof buildReconciliationView>;
} {
  const evidence = {
    desiredGeneration,
    observedGeneration: observed ? desiredGeneration : null,
    lastApplyAt: new Date().toISOString(),
    lastObservationAt: observed ? new Date().toISOString() : null,
    lastError: null
  };
  return {
    audit: {
      desiredGeneration,
      observedGeneration: evidence.observedGeneration,
      restartRequired: false
    },
    view: buildReconciliationView({
      evidence,
      history: historyForResource(resource),
      hasObservation: observed
    })
  };
}

/**
 * `POST /control/providers/reset` -- the Providers page header's
 * confirmation-bound "Reset to defaults" operation.
 *
 * Clears only provider Runtime overrides -- role assignments, provider
 * disables, model disables, and provider agent limits -- returning routing to
 * the static `config/model-routing.json` defaults. Agent enablement,
 * provider discovery snapshots, cooldown/health state, and concurrency
 * limits are untouched: none of them are provider routing overrides.
 *
 * Runs inside `ROUTER_STATE_MUTATION_KEY`'s serialized queue alongside
 * every other mutation that persists the shared router state, so the
 * snapshot taken for rollback and the reset itself can never interleave with
 * a concurrent provider/model/agent/concurrency mutation. The body must be
 * exactly `{ confirm: true }`: there is no implicit or partial reset.
 */
function isProvidersResetRequest(
  value: Record<string, unknown>
): value is Record<string, unknown> & ControlApiProvidersResetRequest {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "confirm" && value.confirm === true;
}

async function resetProviders(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor
): Promise<void> {
  const resource = CONTROL_API_PATHS.providersReset;
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string,
    reconciliation: EnablementReconciliation | null = null
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "reset_providers",
      resource,
      outcome,
      changes,
      ...(reason ? { reason } : {}),
      ...auditReconciliationFields(reconciliation)
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to reset providers to defaults."
    );
    return;
  }

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit("error", null, "invalid_body");
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const body = parsed.body;
  if (!isProvidersResetRequest(body)) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      "Provider reset requires a body of exactly { confirm: true }."
    );
    return;
  }

  await serializeRouterStateMutation(ROUTER_STATE_MUTATION_KEY, async () => {
    const snapshot = ROUTING_POLICY.runtimeState();
    const cleared = ROUTING_POLICY.resetProviderOverrides();
    try {
      await persistRoutingPolicy();
    } catch {
      // The snapshot was taken, and the reset applied, inside this same
      // serialized turn, so no other mutation could have run in between: the
      // restore below cannot erase a concurrent change.
      ROUTING_POLICY.restoreRuntimeState(snapshot);
      audit("error", { cleared }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        "Provider reset could not be persisted."
      );
      return;
    }

    const reconciliation = providerMutationReconciliation(
      resource,
      `cleared=${JSON.stringify(cleared)}`,
      true
    );
    audit("ok", { cleared }, undefined, reconciliation.audit);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-providers-reset-v1",
        actor: actor.actor,
        cleared,
        reconciliation: reconciliation.view
      } satisfies ControlApiProvidersResetResponse,
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  });
}

/**
 * `PATCH /control/providers/:provider` -- enable or disable a provider globally.
 *
 * Disabling preserves every role assignment and agent limit, so re-enabling
 * restores the configuration the operator had rather than requiring it to be
 * re-entered. `disabled` is the only accepted key.
 */
async function patchProviderEnabled(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  providerInput: string
): Promise<void> {
  const provider = providerInput.toLowerCase();
  const resource = `${CONTROL_API_PATHS.providers}/${providerInput}`;
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string,
    reconciliation: EnablementReconciliation | null = null
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_enabled",
      resource,
      outcome,
      changes,
      ...(reason ? { reason } : {}),
      ...auditReconciliationFields(reconciliation)
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to enable or disable a provider."
    );
    return;
  }
  if (!providerIsKnown(provider)) {
    audit("error", null, "unknown_provider");
    sendControlError(
      response,
      404,
      "autodev_control_api_unknown_provider",
      "Unknown provider."
    );
    return;
  }

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit("error", null, "invalid_body");
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const body = parsed.body;
  if (Object.keys(body).length !== 1 || typeof body.disabled !== "boolean") {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      "Provider enablement body must contain only a boolean disabled field."
    );
    return;
  }
  const disabled = body.disabled;

  await serializeRouterStateMutation(ROUTER_STATE_MUTATION_KEY, async () => {
    const previous = ROUTING_POLICY.isProviderDisabled(provider);
    try {
      ROUTING_POLICY.setProviderEnabled(provider, !disabled);
      await persistRoutingPolicy();
    } catch {
      try {
        ROUTING_POLICY.setProviderEnabled(provider, !previous);
      } catch {
        // Preserve the original failure; the audit record captures it.
      }
      audit("error", { disabled, previous }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        "Provider enablement change could not be persisted."
      );
      return;
    }

    const observed = ROUTING_POLICY.isProviderDisabled(provider) === disabled;
    const reconciliation = providerMutationReconciliation(
      resource,
      `disabled=${disabled ? "true" : "false"}`,
      observed
    );
    audit("ok", { disabled, previous }, undefined, reconciliation.audit);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-provider-enabled-v1",
        provider,
        disabled,
        previous,
        actor: actor.actor,
        reconciliation: reconciliation.view
      } satisfies ControlApiProviderEnabledPatchResponse,
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  });
}

/**
 * `PATCH /control/providers/:provider/limits` -- the provider-wide concurrent
 * agent limits. `null` means Unlimited. Values are normalised rather than
 * trusted: a non-integer, negative or non-finite number becomes Unlimited, so
 * an unrecognised value can never become an active limit.
 */
async function patchProviderLimits(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  providerInput: string
): Promise<void> {
  const provider = providerInput.toLowerCase();
  const resource = `${CONTROL_API_PATHS.providers}/${providerInput}/limits`;
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string,
    reconciliation: EnablementReconciliation | null = null
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_limits",
      resource,
      outcome,
      changes,
      ...(reason ? { reason } : {}),
      ...auditReconciliationFields(reconciliation)
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to change provider agent limits."
    );
    return;
  }
  if (!providerIsKnown(provider)) {
    audit("error", null, "unknown_provider");
    sendControlError(
      response,
      404,
      "autodev_control_api_unknown_provider",
      "Unknown provider."
    );
    return;
  }

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit("error", null, "invalid_body");
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const body = parsed.body;
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "acrossSessions" ||
    keys[1] !== "perSession" ||
    !isAgentLimitBody(body.perSession) ||
    !isAgentLimitBody(body.acrossSessions)
  ) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      "Provider limits body must carry perSession and acrossSessions, each either null for Unlimited or an integer of at least 1."
    );
    return;
  }

  await serializeRouterStateMutation(ROUTER_STATE_MUTATION_KEY, async () => {
    const previous = ROUTING_POLICY.limitsFor(provider) ?? null;
    const next = {
      perSession: body.perSession as number | null,
      acrossSessions: body.acrossSessions as number | null
    };
    try {
      ROUTING_POLICY.setProviderLimits(provider, next);
      await persistRoutingPolicy();
    } catch {
      try {
        if (previous) ROUTING_POLICY.setProviderLimits(provider, previous);
        else ROUTING_POLICY.clearProviderLimits(provider);
      } catch {
        // Preserve the original failure; the audit record captures it.
      }
      audit("error", { ...next, previous }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        "Provider agent limits change could not be persisted."
      );
      return;
    }

    const applied = ROUTING_POLICY.limitsFor(provider) ?? null;
    const observed =
      applied?.perSession === next.perSession &&
      applied?.acrossSessions === next.acrossSessions;
    const reconciliation = providerMutationReconciliation(
      resource,
      `limits=${JSON.stringify(next)}`,
      observed
    );
    audit("ok", { ...next, previous }, undefined, reconciliation.audit);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-provider-limits-v1",
        provider,
        // `applied` alone is `null` once the policy holds no record, which is what
        // clearing every limit produces -- and `null` says "no idea" where the
        // truth is "no limit on either axis". Reporting `next` in that case keeps
        // a cleared provider distinguishable from one whose limits were never
        // read, and it is the state the write just put there.
        agentLimits: applied ?? next,
        previous,
        actor: actor.actor,
        reconciliation: reconciliation.view
      } satisfies ControlApiProviderLimitsPatchResponse,
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  });
}

/**
 * `PATCH /control/runtime/concurrency` -- mutate orchestrator child-concurrency limit.
 * Supports explicit Unlimited (`null`), integers 0-999, and resetToConfigFile: true.
 * Revision checked and persisted across restart.
 */
async function patchConcurrencyLimit(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor
): Promise<void> {
  const resource = CONTROL_API_PATHS.concurrency;
  const audit = (
    outcome: "ok" | "denied" | "error",
    changes: Record<string, unknown> | null,
    reason?: string
  ): void =>
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_runtime_concurrency",
      resource,
      outcome,
      changes,
      ...(reason ? { reason } : {})
    });

  if (actor.role !== "operator") {
    audit("denied", null, "viewer_cannot_mutate");
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to change orchestrator concurrency limits."
    );
    return;
  }

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit("error", null, "invalid_body");
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const body = parsed.body;
  const manager = getDefaultConcurrencyManager();

  let nextLimit: number | null | undefined;
  if (body.resetToConfigFile === true) {
    nextLimit = undefined;
  } else if ("maxConcurrentThreadsPerSession" in body) {
    const raw = body.maxConcurrentThreadsPerSession;
    if (
      raw === null ||
      (typeof raw === "number" &&
        Number.isInteger(raw) &&
        raw >= 0 &&
        raw <= 999)
    ) {
      nextLimit = raw as number | null;
    } else {
      audit("error", null, "invalid_limit");
      sendControlError(
        response,
        400,
        "autodev_control_api_bad_body",
        "maxConcurrentThreadsPerSession must be null (Unlimited) or an integer between 0 and 999."
      );
      return;
    }
  } else {
    audit("error", null, "missing_limit");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      "Body must specify maxConcurrentThreadsPerSession or resetToConfigFile."
    );
    return;
  }

  const expectedRevision =
    typeof body.revision === "number" && Number.isInteger(body.revision)
      ? body.revision
      : undefined;

  await serializeRouterStateMutation(ROUTER_STATE_MUTATION_KEY, async () => {
    const previousLimit = manager.effectivePerSessionLimit();
    const mutationResult =
      nextLimit === undefined
        ? manager.clearStoredLimit(expectedRevision)
        : manager.setMaxConcurrentThreadsPerSession(
            nextLimit,
            expectedRevision
          );

    if (!mutationResult.ok) {
      audit(
        "error",
        { expectedRevision, currentRevision: mutationResult.currentRevision },
        "conflict"
      );
      sendControlError(
        response,
        409,
        "autodev_control_api_conflict",
        "Concurrency limit configuration was changed by another operator. Reload to see current state."
      );
      return;
    }

    try {
      await persistRoutingPolicy();
    } catch {
      if (previousLimit === undefined) {
        manager.clearStoredLimit();
      } else {
        manager.setMaxConcurrentThreadsPerSession(previousLimit);
      }
      audit("error", { nextLimit, previousLimit }, "persistence_failed");
      sendControlError(
        response,
        500,
        "autodev_control_api_persistence_failed",
        "Concurrency limit change could not be persisted."
      );
      return;
    }

    const updatedStatus = manager.concurrencyStatus(Date.now());
    audit("ok", {
      limit: nextLimit,
      previous: previousLimit,
      revision: updatedStatus.revision
    });
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-concurrency-v1",
        concurrency: updatedStatus
      },
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  });
}

function patchAgentEnablement(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  inputRole: string
): Promise<void> {
  const role = inputRole.trim().toLowerCase();
  const roles = getDefaultExecutionContract().roles ?? {};
  const contractRoleKnown = Object.hasOwn(roles, role);
  const alias = ROUTING_POLICY.agentModelAlias(role);
  const enabled = ROUTING_POLICY.isAgentEnabled(role);
  const known = contractRoleKnown && alias !== null && enabled !== null;
  const unavailableAlias = contractRoleKnown && alias === null;
  const resource = `${CONTROL_API_PATHS.agents}/${role}`;

  return patchEnablement(request, response, actor, {
    action: "patch_agent_enablement",
    resource,
    subject: "Agent",
    known,
    unknownStatus: unavailableAlias ? 409 : 404,
    unknownReason: unavailableAlias
      ? "agent_alias_unavailable"
      : "unknown_agent",
    unknownCode: unavailableAlias
      ? "autodev_control_api_agent_alias_unavailable"
      : "autodev_control_api_unknown_agent",
    unknownMessage: unavailableAlias
      ? "This Agent has no configured AutoDev routing alias, so Runtime cannot enforce enablement."
      : "Unknown agent role.",
    current: () => ROUTING_POLICY.isAgentEnabled(role) === true,
    currentRevision: () => {
      const current = agentEnablementView(role);
      return current.kind === "observed" ? current.revision : null;
    },
    revisionConflictCode: "autodev_control_api_agent_enablement_conflict",
    serializeKey: ROUTER_STATE_MUTATION_KEY,
    apply: (next) => {
      if (!ROUTING_POLICY.setAgentEnabled(role, next))
        throw new Error("Agent has no configured router alias.");
    },
    result: (next, previous) => {
      const current = ROUTING_POLICY.isAgentEnabled(role);
      const currentAlias = ROUTING_POLICY.agentModelAlias(role);
      const generation = ROUTING_POLICY.agentEnablementGeneration(role);
      if (current === null || currentAlias === null || generation === null)
        throw new Error(
          "Agent enablement became unavailable after persistence."
        );
      const revision = agentEnablementRevision(
        role,
        currentAlias,
        current,
        generation
      );
      const desiredGeneration = `enabled=${next ? "true" : "false"}`;
      const observedGeneration = current === next ? desiredGeneration : null;
      const appliedAt = new Date().toISOString();
      return {
        schema: "autodev-control-agent-enablement-v1",
        role,
        enabled: next,
        previous,
        revision,
        reconciliation: buildReconciliationView({
          evidence: {
            desiredGeneration,
            observedGeneration,
            lastApplyAt: appliedAt,
            lastObservationAt: observedGeneration === null ? null : appliedAt,
            lastError: null
          },
          history: historyForResource(resource),
          hasObservation: observedGeneration !== null
        })
      } satisfies Omit<ControlApiAgentEnablementPatchResponse, "actor">;
    }
  });
}

function patchModel(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  model: string
): Promise<void> {
  const currentlyRouteable = modelHasCurrentDiscovery(model);
  const knownToRuntime =
    ROUTING_POLICY.isKnownModel(model) || modelHasDiscoveryRecord(model);
  return patchEnablement(request, response, actor, {
    action: "patch_model",
    resource: model,
    subject: "model",
    known: currentlyRouteable,
    unknownStatus: knownToRuntime ? 409 : 404,
    unknownReason: knownToRuntime
      ? "model_not_currently_routeable"
      : "unknown_model",
    unknownCode: knownToRuntime
      ? "autodev_control_api_model_not_currently_routeable"
      : "autodev_control_api_unknown_model",
    unknownMessage: knownToRuntime
      ? "Model enablement requires a currently observed provider model that Runtime can route."
      : "Unknown model.",
    current: () => ROUTING_POLICY.isModelEnabled(model),
    serializeKey: ROUTER_STATE_MUTATION_KEY,
    apply: (enabled) => ROUTING_POLICY.setModelEnabled(model, enabled),
    result: (enabled, previous) => {
      const observed = ROUTING_POLICY.isModelEnabled(model);
      const desiredGeneration = `enabled=${enabled ? "true" : "false"}`;
      const observedGeneration =
        observed === enabled ? desiredGeneration : null;
      return {
        schema: "autodev-control-model-v1",
        model,
        enabled,
        previous,
        reconciliation: buildReconciliationView({
          evidence: {
            desiredGeneration,
            observedGeneration,
            lastApplyAt: new Date().toISOString(),
            lastObservationAt:
              observedGeneration === null ? null : new Date().toISOString(),
            lastError: null
          },
          history: historyForResource(model),
          hasObservation: observed === enabled
        })
      };
    }
  });
}

function methodChangesState(method: string): boolean {
  return ["PATCH", "POST", "PUT", "DELETE"].includes(method);
}

function auditRejectedRequest(
  request: IncomingMessage,
  method: string,
  pathname: string,
  reason: string,
  actor?: ControlApiActor
): void {
  if (!methodChangesState(method)) return;
  auditMutation({
    actor: actor?.actor ?? actorClaim(request),
    actorVerified: actor !== undefined,
    role: actor?.role ?? null,
    action: method.toLowerCase(),
    resource: pathname,
    outcome: "denied",
    changes: null,
    reason
  });
}

function authorizeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  pathname: string
): ControlApiActor | null {
  const availability = getControlApiAvailability();
  const authorization = authorizeControlApiRequest(request, availability);
  if (authorization.authorized) return authorization;
  auditRejectedRequest(request, method, pathname, authorization.code);
  sendControlError(
    response,
    authorization.status,
    authorization.code,
    authorization.message
  );
  return null;
}

/**
 * One read-only collection.
 *
 * The renderer is handed the configured repository root, not just the actor,
 * because the detail routes already read `options.repositoryRoot` while these
 * fell back to the default. A caller that pointed the Control API at another
 * repository therefore got a collection from one root and a detail from
 * another -- and the test that reads a collection to check a write against that
 * same root was quietly reading the wrong repository.
 */
type ReadOnlyCollectionRenderer = (
  actor: ControlApiActor,
  repositoryRoot: string | undefined,
  codexHome: string | undefined
) => object | Promise<object>;

const READ_ONLY_COLLECTIONS: ReadonlyMap<string, ReadOnlyCollectionRenderer> =
  new Map<string, ReadOnlyCollectionRenderer>([
    [
      CONTROL_API_PATHS.contracts,
      () =>
        ({
          schema: CONTROL_API_CONTRACT.schema,
          version: CONTROL_API_CONTRACT.version
        }) satisfies ControlApiContractResponse
    ],
    [CONTROL_API_PATHS.agents, (_actor, root) => agentsView(root)],
    [CONTROL_API_PATHS.providers, () => providersView(Date.now())],
    [CONTROL_API_PATHS.providerModels, () => providerModelsView()],
    [CONTROL_API_PATHS.models, () => modelsView()],
    [CONTROL_API_PATHS.mcps, (_actor, root) => mcpsView(root)],
    [CONTROL_API_PATHS.mcpRuntime, () => mcpRuntimeView()],
    [
      CONTROL_API_PATHS.mcpApplied,
      (_actor, root, codexHome) => mcpAppliedView(root, codexHome)
    ],
    [CONTROL_API_PATHS.tools, () => toolsView()],
    [CONTROL_API_PATHS.skills, (_actor, root) => skillsView(root)],
    [CONTROL_API_PATHS.hooks, (_actor, root) => hooksView(root)],
    [
      CONTROL_API_PATHS.hooksApplied,
      (_actor, root, codexHome) => hooksAppliedView(root, codexHome)
    ],
    [CONTROL_API_PATHS.prompts, (_actor, root) => promptsView(root)],
    [CONTROL_API_PATHS.workspaces, (_actor, root) => workspacesView(root)],
    [CONTROL_API_PATHS.routing, () => routingView(Date.now())],
    [CONTROL_API_PATHS.runtime, () => runtimeView(Date.now())],
    [CONTROL_API_PATHS.evaluations, () => evaluationsView()],
    [
      CONTROL_API_PATHS.github,
      (_actor, root) => githubWorkflowsView(root ?? DEFAULT_REPO_ROOT)
    ]
  ]);

async function readOnlyCollection(
  pathname: string,
  method: string,
  response: ServerResponse,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  const renderCollection = READ_ONLY_COLLECTIONS.get(pathname);
  if (!renderCollection) return false;
  if (method !== "GET") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: method.toLowerCase(),
      resource: pathname,
      outcome: "denied",
      changes: null,
      reason: "read_only_resource"
    });
    response.setHeader("allow", "GET");
    sendControlError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "Control API collections are read-only via GET."
    );
    return true;
  }
  let body: object;
  try {
    body = await renderCollection(
      actor,
      options.repositoryRoot,
      options.codexHome
    );
  } catch (error) {
    if (!(error instanceof EvaluationSourceUnavailableError)) throw error;
    sendControlError(
      response,
      503,
      "autodev_control_evaluations_unavailable",
      "Evaluation history is unavailable from the telemetry store."
    );
    return true;
  }
  sendJson(response, 200, body, {
    "cache-control": "no-store",
    vary: CONTROL_VARY_HEADER
  });
  return true;
}

/**
 * The permission policy's own route.
 *
 * The policy is read through the Control API and changed through it as well:
 * the canonical source is the portable source, and the Runtime is what applies
 * it, so the Console never writes the file itself.
 */
async function permissionsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPO_ROOT;
  const home = process.env.HOME?.trim() || homedir();
  const codexHome =
    options.codexHome?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    path.join(home, ".codex");
  if (method === "PATCH") {
    await patchPermissions(request, response, actor, repositoryRoot, codexHome);
    return true;
  }
  if (method === "GET") {
    sendJson(response, 200, permissionsView(repositoryRoot, codexHome), {
      "cache-control": "no-store",
      vary: CONTROL_VARY_HEADER
    });
    return true;
  }
  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", ALLOWED_METHODS_READ_AND_PATCH);
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "The permission policy is read with GET and changed with PATCH."
  );
  return true;
}

async function providerRoleRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  match: RegExpMatchArray
): Promise<boolean> {
  if (method !== "PATCH") {
    auditRejectedRequest(
      request,
      method,
      pathname,
      AUDIT_REASON_METHOD_NOT_ALLOWED,
      actor
    );
    response.setHeader("allow", "PATCH");
    sendControlError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "Provider role state is mutated via PATCH only."
    );
    return true;
  }
  await patchProviderRole(
    request,
    response,
    actor,
    match[1]!,
    match[2] as ProviderRole
  );
  return true;
}

async function modelRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  model: string
): Promise<boolean> {
  if (method !== "PATCH") {
    auditRejectedRequest(
      request,
      method,
      pathname,
      AUDIT_REASON_METHOD_NOT_ALLOWED,
      actor
    );
    response.setHeader("allow", "PATCH");
    sendControlError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      "Model enablement is mutated via PATCH only."
    );
    return true;
  }
  await patchModel(request, response, actor, model);
  return true;
}

/**
 * The outcome of reading one detail.
 *
 * The read owns its own failure. A detail that cannot be produced because its
 * source was never read is not an unknown resource -- nobody looked -- and only
 * the read knows which of the two happened and why, so the reason travels with
 * the answer instead of in a second probe of the same source.
 */
type ReadOnlyDetailResult =
  | {
      readonly status: "found";
      readonly detail: Record<string, unknown>;
    }
  | {
      readonly status: "unknown";
    }
  | {
      readonly status: "unreadable";
      readonly code: string;
      readonly message: string;
    };

interface ReadOnlyDetailRoute {
  readonly action: string;
  readonly unknownReason: string;
  readonly unknownCode: string;
  readonly unknownMessage: string;
  readonly read: (identifier: string) => ReadOnlyDetailResult;
}

function readOnlyDetailRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  identifier: string,
  route: ReadOnlyDetailRoute
): boolean {
  if (method !== "GET") {
    auditRejectedRequest(
      request,
      method,
      pathname,
      AUDIT_REASON_METHOD_NOT_ALLOWED,
      actor
    );
    response.setHeader("allow", "GET");
    sendControlError(
      response,
      405,
      "autodev_control_api_method_not_allowed",
      `${route.action} detail is read-only via GET.`
    );
    return true;
  }

  const result = route.read(identifier);
  if (result.status === "found") {
    sendJson(response, 200, result.detail, {
      "cache-control": "no-store",
      vary: CONTROL_VARY_HEADER
    });
    return true;
  }
  if (result.status === "unreadable") {
    auditRejectedRequest(
      request,
      method,
      pathname,
      `${route.unknownReason}_source_not_observed`,
      actor
    );
    sendControlError(response, 503, result.code, result.message);
    return true;
  }
  auditRejectedRequest(request, method, pathname, route.unknownReason, actor);
  sendControlError(response, 404, route.unknownCode, route.unknownMessage);
  return true;
}

const AGENT_DETAIL_ROUTE: ReadOnlyDetailRoute = {
  action: "Agent",
  unknownReason: "unknown_agent",
  unknownCode: "autodev_control_api_unknown_agent",
  unknownMessage: "Unknown agent role.",
  read: agentDetailView
};

const PROMPT_DETAIL_ROUTE: ReadOnlyDetailRoute = {
  action: "Prompt",
  unknownReason: "unknown_prompt",
  unknownCode: "autodev_control_api_unknown_prompt",
  unknownMessage: "Unknown prompt.",
  read: promptDetailView
};

async function patchPromptCommand(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  name: string,
  repositoryRoot: string,
  codexHome: string
): Promise<void> {
  const resource = `${CONTROL_API_PATHS.prompts}/${name}`;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_command",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Updating canonical RuleSync commands requires an operator."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_command",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const { body } = parsed;
  if (
    Object.keys(body).length !== 2 ||
    typeof body.content !== "string" ||
    typeof body.expectedRevision !== "string"
  ) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_command",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendControlError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "Command updates require exactly the expected revision and Markdown content."
    );
    return;
  }

  let updated;
  try {
    updated = await new RuleSyncRepository(repositoryRoot).updateCommand({
      name,
      expectedRevision: body.expectedRevision,
      content: body.content
    });
  } catch (error) {
    const conflict = error instanceof RuleSyncCommandConflictError;
    const validation = error instanceof RuleSyncCommandValidationError;
    if (!conflict && !validation) throw error;
    const status = conflict ? 409 : 400;
    const code = conflict
      ? "autodev_control_prompt_revision_conflict"
      : "autodev_control_prompt_invalid_source";
    const message =
      error instanceof Error ? error.message : "Command source is invalid.";
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_command",
      resource,
      outcome: "error",
      changes: null,
      reason: conflict ? "revision_conflict" : "invalid_source"
    });
    sendControlError(response, status, code, message);
    return;
  }

  let updatedPrompts: readonly string[];
  try {
    updatedPrompts = materializeCommands(
      { repositoryRoot },
      path.join(codexHome, "prompts")
    );
  } catch {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_command",
      resource,
      outcome: "error",
      changes: { name, revision: updated.revision },
      reason: "projection_apply_failed"
    });
    sendControlError(
      response,
      503,
      "autodev_control_prompt_apply_failed",
      "Canonical source was updated, but RuleSync generation or projection apply failed. Reload the prompt before retrying."
    );
    return;
  }

  const projectionUpdated = updatedPrompts.includes(name);
  // Observed means "the projection on disk was generated from this canonical
  // revision and is still present", so it is expressed in the same revision
  // domain as the desired generation.
  const projectionPresent = observePromptProjection(name, codexHome) !== null;
  const desiredGeneration = promptGeneration(updated.revision);
  const observedGeneration =
    projectionUpdated && projectionPresent ? desiredGeneration : null;
  const restartRequired = projectionUpdated && !projectionPresent;
  const resourceKey = `${CONTROL_API_PATHS.prompts}/${name}`;
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_command",
    resource: resourceKey,
    outcome: "ok",
    changes: {
      name,
      revision: updated.revision,
      projectionUpdated
    },
    desiredGeneration,
    observedGeneration,
    restartRequired
  });
  const reconciliation = buildReconciliationView({
    evidence: {
      desiredGeneration,
      observedGeneration,
      lastApplyAt: new Date().toISOString(),
      lastObservationAt:
        observedGeneration === null ? null : new Date().toISOString(),
      lastError: null
    },
    history: historyForResource(resourceKey),
    hasObservation: observedGeneration !== null,
    restartRequired
  });
  const diff = promptDiffSummary({ name, codexHome, projectionUpdated });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-prompt-command-patch-v2",
      name,
      revision: updated.revision,
      changed: updated.revision !== body.expectedRevision,
      diff,
      reconciliation
    } satisfies ControlApiPromptCommandPatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

/**
 * The launch configuration one request sets.
 *
 * A key the request does not mention is left as the declaration has it; a key
 * it sets to `null` is removed. The request owns the launch keys and nothing
 * else: the target's enablement, approval mode and tool allowlist are not
 * part of it.
 */
/**
 * One launch key's value in a request.
 *
 * `absent` is a key the request does not mention, `remove` is a key the
 * request takes away, and `invalid` is a value the request does not carry in
 * a shape this route accepts.
 */
type McpLaunchBodyValue =
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "invalid" };

function mcpBodyTextValue(raw: unknown): McpLaunchBodyValue {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (typeof raw !== "string" || raw.length === 0) return { kind: "invalid" };
  return { kind: "set", value: raw };
}

function mcpBodyArgsValue(
  raw: unknown
):
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: readonly string[] }
  | { readonly kind: "invalid" } {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === "string"))
    return { kind: "invalid" };
  return { kind: "set", value: raw as string[] };
}

function mcpBodyHeadersValue(
  raw: unknown
):
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: Record<string, string> }
  | { readonly kind: "invalid" } {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (!isPlainRecord(raw)) return { kind: "invalid" };
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(raw)) {
    if (typeof headerValue !== "string") return { kind: "invalid" };
    headers[name] = headerValue;
  }
  return { kind: "set", value: headers };
}

function mcpLaunchUpdateFromBody(value: unknown): {
  command?: string | null;
  args?: readonly string[] | null;
  cwd?: string | null;
  url?: string | null;
  bearerTokenEnvVar?: string | null;
  httpHeaders?: Record<string, string> | null;
} | null {
  if (!isPlainRecord(value)) return null;
  const update: {
    command?: string | null;
    args?: readonly string[] | null;
    cwd?: string | null;
    url?: string | null;
    bearerTokenEnvVar?: string | null;
    httpHeaders?: Record<string, string> | null;
  } = {};
  const strings: readonly (readonly [
    "command" | "cwd" | "url" | "bearerTokenEnvVar",
    unknown
  ])[] = [
    ["command", value.command],
    ["cwd", value.cwd],
    ["url", value.url],
    ["bearerTokenEnvVar", value.bearerTokenEnvVar]
  ];
  for (const [key, raw] of strings) {
    const text = mcpBodyTextValue(raw);
    if (text.kind === "invalid") return null;
    if (text.kind === "absent") continue;
    update[key] = text.kind === "remove" ? null : text.value;
  }
  const args = mcpBodyArgsValue(value.args);
  if (args.kind === "invalid") return null;
  if (args.kind !== "absent") {
    update.args = args.kind === "remove" ? null : args.value;
  }
  const headers = mcpBodyHeadersValue(value.httpHeaders);
  if (headers.kind === "invalid") return null;
  if (headers.kind !== "absent") {
    update.httpHeaders = headers.kind === "remove" ? null : headers.value;
  }
  return update;
}

/**
 * The refusal of a canonical MCP declaration write.
 *
 * A conflict and a refused declaration are different facts: the first says
 * the declaration moved under the write, the second says the write could not
 * be expressed. They get different codes, and the reason is the Runtime's.
 */
function sendMcpWriteFailure(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  error: unknown
): void {
  const conflict = error instanceof RuleSyncMcpConflictError;
  const validation = error instanceof RuleSyncMcpValidationError;
  if (!conflict && !validation) throw error;
  const status = conflict ? 409 : 400;
  const code = conflict
    ? "autodev_control_mcp_revision_conflict"
    : "autodev_control_mcp_invalid_declaration";
  const message =
    error instanceof Error
      ? error.message
      : "The canonical MCP declaration is invalid.";
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_mcp_declaration",
    resource,
    outcome: "error",
    changes: null,
    reason: conflict ? "revision_conflict" : "invalid_declaration"
  });
  sendControlError(response, status, code, message);
}

/**
 * Write one MCP server's launch configuration to the canonical declaration.
 *
 * The write is a compare-and-swap on the declaration's revision, so a write
 * decided on an older declaration is refused rather than applied over a newer
 * one. The projection is applied afterwards and the applied state is read
 * again, so the response says what the Runtime published rather than what the
 * write asked for.
 */
async function patchMcpServer(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  name: string,
  repositoryRoot: string,
  codexHome: string
): Promise<void> {
  const resource = `${CONTROL_API_PATHS.mcps}/${name}`;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_mcp_declaration",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Updating the canonical MCP declaration requires an operator."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_mcp_declaration",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const { body } = parsed;
  const launch = mcpLaunchUpdateFromBody(body.launch);
  if (
    Object.keys(body).length !== 2 ||
    typeof body.expectedRevision !== "string" ||
    launch === null
  ) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_mcp_declaration",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendControlError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "MCP declaration updates require exactly the expected revision and a launch configuration."
    );
    return;
  }

  let updated;
  try {
    updated = await new RuleSyncRepository(repositoryRoot).updateMcpLaunch({
      name,
      target: MCP_APPLIED_TARGET,
      launch,
      expectedRevision: body.expectedRevision
    });
  } catch (error) {
    sendMcpWriteFailure(response, actor, resource, error);
    return;
  }

  try {
    materializeCurrentMcpConfiguration({ repositoryRoot, codexHome });
  } catch {
    // The declaration was written, so this is not a failed write: the
    // applied state is older than the declaration, and the response says so.
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_mcp_declaration",
      resource,
      outcome: "error",
      changes: { name, revision: updated.revision },
      reason: "projection_apply_failed"
    });
    sendControlError(
      response,
      503,
      "autodev_control_mcp_apply_failed",
      "Canonical declaration was updated, but the MCP projection could not be applied. Reload the MCP server before retrying."
    );
    return;
  }

  const applied = mcpAppliedState(repositoryRoot, codexHome);
  const reconciliation = applied.reconciliation;
  const desiredGeneration = applied.desiredGeneration;
  const observedGeneration = applied.observedGeneration;
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_mcp_declaration",
    resource,
    outcome: "ok",
    changes: {
      name,
      revision: updated.revision,
      target: MCP_APPLIED_TARGET
    },
    desiredGeneration,
    observedGeneration
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-mcp-server-patch-v1",
      name,
      target: MCP_APPLIED_TARGET,
      revision: updated.revision,
      changed: updated.revision !== body.expectedRevision,
      launch: {
        name,
        command: updated.launch.command ?? null,
        args: updated.launch.args ?? [],
        cwd: updated.launch.cwd ?? null,
        url: updated.launch.url ?? null,
        bearerTokenEnvVar: updated.launch.bearerTokenEnvVar ?? null,
        httpHeaders: updated.launch.httpHeaders ?? {}
      },
      reconciliation
    } satisfies ControlApiMcpServerPatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

function promptVersionsPath(
  pathname: string
): { readonly name: string; readonly versionHash?: string } | null {
  const segments = pathname.split("/");
  if (
    (segments.length !== 5 && segments.length !== 6) ||
    segments[1] !== "control" ||
    segments[2] !== "prompts" ||
    !PROMPT_COMMAND_NAME_PATTERN.test(segments[3] ?? "") ||
    segments[4] !== "versions"
  ) {
    return null;
  }
  if (segments.length === 5) return { name: segments[3]! };
  const versionHash = segments[5] ?? "";
  return GIT_REVISION_PATTERN.test(versionHash)
    ? { name: segments[3]!, versionHash }
    : null;
}

/** A whole number, with no sign and no fraction. */
const WHOLE_NUMBER_PATTERN = /^\d+$/u;

/**
 * The page of a command's committed history a request asks for.
 *
 * The page is a transport-level window onto one ordered history, so a request
 * that names a page the repository cannot answer is refused rather than
 * clamped: a clamped page would answer a different question than the one that
 * was asked, and the caller would not know it.
 */
function promptHistoryPageFromQuery(
  request: IncomingMessage,
  pathname: string
): RuleSyncCommandHistoryPage | null {
  const url = new URL(request.url ?? pathname, "http://127.0.0.1");
  for (const key of url.searchParams.keys()) {
    if (key !== "offset" && key !== "limit") return null;
  }
  const offset = promptHistoryPageNumber(url.searchParams.get("offset"), 0);
  const limit = promptHistoryPageNumber(
    url.searchParams.get("limit"),
    RULE_SYNC_COMMAND_HISTORY_PAGE_SIZE
  );
  if (
    offset === null ||
    limit === null ||
    limit < 1 ||
    limit > RULE_SYNC_COMMAND_HISTORY_MAX_PAGE_SIZE
  ) {
    return null;
  }
  return { offset, limit };
}

/** A whole number from a query parameter, or the default when it is absent. */
function promptHistoryPageNumber(
  raw: string | null,
  fallback: number
): number | null {
  if (raw === null) return fallback;
  if (!WHOLE_NUMBER_PATTERN.test(raw)) return null;
  return Number(raw);
}

function promptVersionsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  name: string,
  versionHash: string | undefined,
  options: ControlApiRequestOptions
): boolean {
  let page: RuleSyncCommandHistoryPage = {
    offset: 0,
    limit: RULE_SYNC_COMMAND_HISTORY_PAGE_SIZE
  };
  // The page belongs to the list route: a single revision is addressed by its
  // hash, so there is nothing for a page to say there.
  if (versionHash === undefined && method === "GET") {
    const requested = promptHistoryPageFromQuery(request, pathname);
    if (requested === null) {
      auditRejectedRequest(
        request,
        method,
        pathname,
        "invalid_history_page",
        actor
      );
      sendControlError(
        response,
        400,
        "autodev_control_api_prompt_history_page_invalid",
        `Prompt history page must be a whole offset of zero or more and a limit between 1 and ${RULE_SYNC_COMMAND_HISTORY_MAX_PAGE_SIZE}.`
      );
      return true;
    }
    page = requested;
  }
  const route: ReadOnlyDetailRoute = {
    action: versionHash ? "Prompt version" : "Prompt versions",
    unknownReason: versionHash ? "unknown_prompt_version" : "unknown_prompt",
    unknownCode: versionHash
      ? "autodev_control_api_unknown_prompt_version"
      : "autodev_control_api_unknown_prompt",
    unknownMessage: versionHash
      ? "Unknown committed prompt version."
      : "Unknown prompt.",
    read: () =>
      versionHash
        ? promptVersionView(
            name,
            versionHash,
            options.repositoryRoot ?? DEFAULT_REPO_ROOT
          )
        : promptVersionsView(
            name,
            page,
            options.repositoryRoot ?? DEFAULT_REPO_ROOT
          )
  };
  return readOnlyDetailRoute(
    request,
    response,
    actor,
    method,
    pathname,
    name,
    route
  );
}
/**
 * `PATCH /control/skills/:name` — assign a skill to exactly the roles named.
 *
 * This is the operation the memory system needed and did not have. A procedural
 * memory promoted to a skill lands in the catalog with no role assignment, and
 * because role assignment lives in the execution contract while this collection
 * was read-only, the Console had no way to finish the job: the promotion
 * succeeded, the skill appeared, and no agent could reach it.
 *
 * The body carries the *complete* desired set rather than an addition, so
 * unassigning is the same call with an empty list and there is no second verb to
 * get wrong. `expectedRevision` is the contract's own digest, because the failure
 * this protects against is two operators assigning at once — a last-writer-wins
 * merge would discard the first assignment and leave both of them believing
 * theirs took.
 *
 * `workspace` says where the assignment belongs. A skill installed inside a
 * repository belongs to that repository's workspace alone, so its assignment is
 * written into the workspace's section of the contract; every other skill is
 * assigned globally and names no workspace.
 */
interface SkillRolesRequestBody {
  readonly expectedRevision: string;
  readonly roles: readonly string[];
  /** The workspace the assignment belongs to; absent for a global one. */
  readonly workspace?: string | undefined;
}

/**
 * The body of a skill assignment, or the reason it is not one.
 *
 * Exactly the revision, the roles, and at most one workspace, checked exactly.
 * A body carrying a key this route does not understand is refused rather than
 * ignored, because an operator whose tooling sent something this route does not
 * understand should be told so instead of watching the assignment they asked for
 * happen to some subset of what they sent.
 */
function isSkillRolesBodyKey(key: string): boolean {
  return key === "expectedRevision" || key === "roles" || key === "workspace";
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  );
}

function readSkillRolesBody(
  body: Record<string, unknown>
): SkillRolesRequestBody | null {
  const keys = Object.keys(body);
  if (keys.length < 2 || keys.length > 3) return null;
  if (!keys.every(isSkillRolesBodyKey)) return null;
  if (typeof body.expectedRevision !== "string") return null;
  if (!isStringList(body.roles)) return null;
  if (body.workspace !== undefined && typeof body.workspace !== "string") {
    return null;
  }
  return {
    expectedRevision: body.expectedRevision,
    roles: body.roles,
    workspace: body.workspace
  };
}

/**
 * Why an assignment cannot be written where the caller asked for.
 *
 * The scope is read live from the machine, so the refusal follows where the
 * skill actually is: a skill inside a repository is that repository's
 * workspace's alone, and a skill anywhere else belongs to no workspace. The
 * scope is never the operator's to say.
 */
interface SkillScopeRefusal {
  readonly reason: string;
  readonly message: string;
}

function skillScopeRefusal(
  facts: SkillScopeFacts | null,
  requestedWorkspace: string | null
): SkillScopeRefusal | null {
  if (facts?.scope === "repo") {
    if (facts.workspace === null) {
      return {
        reason: "workspace_unattributed",
        message:
          "This skill is installed inside the repository, and the repository is not one of the configured workspaces, so there is nowhere to assign it."
      };
    }
    if (requestedWorkspace !== facts.workspace) {
      return {
        reason: "workspace_required",
        message: `This skill belongs to the workspace "${facts.workspace}" and can only be assigned inside it.`
      };
    }
    return null;
  }
  if (requestedWorkspace !== null) {
    return {
      reason: "workspace_not_allowed",
      message:
        "This skill is not installed inside the repository, so it is assigned to agent roles globally rather than to one workspace."
    };
  }
  return null;
}

/**
 * Where a skill is installed, and whether an assignment may be made there.
 *
 * The scope is read live from the machine, so the answer follows where the
 * skill actually is rather than what the request says about it.
 */
interface SkillAssignmentScope {
  /** Where the skill is installed, or null when it is installed nowhere. */
  readonly facts: SkillScopeFacts | null;
  /** The workspace the assignment was asked for, or null for a global one. */
  readonly workspace: string | null;
  /** Why the assignment cannot be made where it was asked for. */
  readonly refusal: SkillScopeRefusal | null;
}

function resolveSkillAssignmentScope(
  name: string,
  repositoryRoot: string,
  assignment: SkillRolesRequestBody
): SkillAssignmentScope {
  const facts = liveSkillScopes([name], repositoryRoot).get(name) ?? null;
  const workspace = assignment.workspace ?? null;
  return { facts, workspace, refusal: skillScopeRefusal(facts, workspace) };
}

/**
 * The roles the contract now carries for a skill, or null when they are not
 * observed.
 *
 * The roles are read from the place the skill belongs to: a repo-scoped
 * skill's roles are its workspace's roles, and every other skill's are the
 * global ones. Reading the global list for a workspace-scoped assignment would
 * report an empty assignment for a write that took.
 *
 * An empty assignment is observed only when the just-written source revision is
 * the one the Runtime reloaded; otherwise absence from that projection stays
 * unknown instead of becoming an observed empty set.
 */
function observedSkillAssignmentRoles(
  name: string,
  scope: SkillAssignmentScope,
  contractFile: string,
  writtenRevision: string
): string[] | null {
  const observedRoles = assignedSkillRoles(
    name,
    scope.facts?.scope === "repo" ? scope.facts.workspace : null
  );
  if (observedRoles.length > 0) return observedRoles;
  const content = readContract(contractFile);
  const revision =
    content.length > 0 ? executionContractRevision(content) : null;
  return revision === writtenRevision ? [] : null;
}

/**
 * Refuse an assignment whose workspace does not match where the skill is.
 *
 * The refusal is audited with the reason it was refused, so a later reader can
 * tell a workspace mismatch from a body the route did not understand.
 */
function refuseSkillScope(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  refusal: SkillScopeRefusal
): void {
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "assign_skill_roles",
    resource,
    outcome: "error",
    changes: null,
    reason: refusal.reason
  });
  sendControlError(
    response,
    400,
    "autodev_control_execution_contract_invalid",
    refusal.message
  );
}

/** The write itself, mapped onto the two refusals it can legitimately return. */
async function applySkillRoles(
  file: string,
  skill: string,
  assignment: SkillRolesRequestBody
): Promise<
  | {
      readonly ok: true;
      readonly assigned: Awaited<ReturnType<typeof assignSkillRoles>>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
> {
  try {
    return {
      ok: true,
      assigned: await assignSkillRoles({
        file,
        expectedRevision: assignment.expectedRevision,
        skill,
        roles: assignment.roles,
        workspace: assignment.workspace
      })
    };
  } catch (error) {
    const conflict = error instanceof ExecutionContractConflictError;
    const validation = error instanceof ExecutionContractValidationError;
    // Anything else is a defect rather than a refusal, and is left to throw:
    // reporting it as "the assignment was refused" would turn a bug into a
    // message that tells an operator their valid request was wrong.
    if (!conflict && !validation) throw error;
    return {
      ok: false,
      status: conflict ? 409 : 400,
      code: conflict
        ? "autodev_control_execution_contract_conflict"
        : "autodev_control_execution_contract_invalid",
      message:
        error instanceof Error
          ? error.message
          : "The role assignment was refused."
    };
  }
}

async function patchSkillRoles(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  name: string,
  options: ControlApiRequestOptions
): Promise<void> {
  const resource = `${CONTROL_API_PATHS.skills}/${name}`;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Assigning skills to agent roles requires an operator."
    );
    return;
  }

  // The skill has to exist before it can be exposed. Assigning one that is not
  // in the catalog would produce exactly the `unresolvedAssignments` this page
  // already reports as a configuration defect.
  const catalog = new RuleSyncRepository(
    options.repositoryRoot ?? DEFAULT_REPO_ROOT
  ).loadSkills();
  const skill = catalog.skills.find((entry) => entry.name === name);
  if (!skill) {
    // A catalogue that was read and found broken does not name this skill,
    // and that is not the same as the catalogue naming it absent: a 404 would
    // say the skill does not exist when nobody could read the file that would
    // have said whether it does. An absent catalogue holds no skill, so the
    // skill is genuinely not there.
    if (catalog.valid === false) {
      auditMutation({
        actor: actor.actor,
        actorVerified: true,
        role: actor.role,
        action: "assign_skill_roles",
        resource,
        outcome: "error",
        changes: null,
        reason: "skill_catalogue_invalid"
      });
      sendControlError(
        response,
        503,
        "autodev_control_skill_catalogue_invalid",
        catalog.issues[0]?.message ??
          "The RuleSync skill catalog is invalid, so no skill could be assigned."
      );
      return;
    }
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "error",
      changes: null,
      reason: "unknown_skill"
    });
    sendControlError(
      response,
      404,
      "autodev_control_skill_not_found",
      `No RuleSync skill named "${name}" exists.`
    );
    return;
  }

  const contractFile = executionContractFile();
  if (contractFile === null) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "error",
      changes: null,
      reason: "no_execution_contract"
    });
    sendControlError(
      response,
      409,
      "autodev_control_execution_contract_missing",
      "No execution contract file was found, so no role assignment was made."
    );
    return;
  }

  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "error",
      changes: null,
      reason: parsed.code
    });
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return;
  }
  const { body } = parsed;
  const assignment = readSkillRolesBody(body);
  if (assignment === null) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendControlError(
      response,
      400,
      "autodev_control_api_invalid_body",
      "Skill role assignment requires exactly the expected execution-contract revision, a roles array of strings, and at most one workspace."
    );
    return;
  }

  // Where the skill is installed decides where it may be assigned. The scope is
  // read from the machine rather than taken from the request, so a skill that
  // lives inside a repository cannot be claimed by a workspace it does not
  // belong to.
  const scope = resolveSkillAssignmentScope(
    skill.name,
    options.repositoryRoot ?? DEFAULT_REPO_ROOT,
    assignment
  );
  if (scope.refusal !== null) {
    refuseSkillScope(response, actor, resource, scope.refusal);
    return;
  }

  const written = await applySkillRoles(contractFile, skill.name, assignment);
  if (!written.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "assign_skill_roles",
      resource,
      outcome: "error",
      changes: null,
      reason:
        written.status === 409 ? "revision_conflict" : "invalid_assignment"
    });
    sendControlError(response, written.status, written.code, written.message);
    return;
  }
  const assigned = written.assigned;

  // The read path caches the contract in the router. Without dropping that cache
  // the write would succeed, this response would report the new roles, and the
  // next `/control/skills` read would show the old ones — an assignment that
  // reports working and does nothing.
  reloadExecutionContract();
  const actualRoles = observedSkillAssignmentRoles(
    name,
    scope,
    contractFile,
    assigned.revision
  );
  const roleGeneration = (roles: readonly string[]): string =>
    createHash("sha256")
      .update(
        JSON.stringify({
          skill: name,
          workspace: scope.workspace,
          roles: [...roles].sort()
        }),
        "utf8"
      )
      .digest("hex");
  const desiredGeneration = roleGeneration(assigned.roles);
  const observedGeneration =
    actualRoles === null ? null : roleGeneration(actualRoles);
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "assign_skill_roles",
    resource,
    outcome: "ok",
    changes: {
      name,
      desiredRoles: assigned.roles,
      actualRoles,
      // Where the assignment was made. The skill's scope decides it, and the
      // audit says so rather than leaving a workspace-scoped write looking
      // like a global one.
      workspace: scope.workspace,
      revision: assigned.revision
    },
    desiredGeneration,
    observedGeneration
  });
  const latest = findLatestAuditFor(resource);
  const reconciliation = buildReconciliationView({
    evidence: {
      desiredGeneration,
      observedGeneration,
      lastApplyAt: latest?.timestamp ?? null,
      lastObservationAt:
        actualRoles === null ? null : (latest?.timestamp ?? null),
      lastError: boundReconciliationError(latest?.reason ?? null)
    },
    history: historyForResource(resource),
    hasObservation: actualRoles !== null
  });
  const diff = reconcileDiffWithIdentifier({
    summary:
      actualRoles === null
        ? "Skill role assignment was written; runtime roles are not observed."
        : desiredGeneration === observedGeneration
          ? "Desired and observed skill role assignments match."
          : "Desired and observed skill role assignments differ.",
    identifier: desiredGeneration
  });
  sendJson(response, 200, {
    schema: "autodev-control-skill-assignment-v2",
    skill: assigned.skill,
    desiredRoles: assigned.roles,
    actualRoles,
    revision: assigned.revision,
    reconciliation,
    diff
  } satisfies ControlApiSkillRolesPatchResponse);
}

interface SkillContentPatchBody {
  readonly expectedRevision: string;
  readonly content: string;
}

type UpdatedRuleSyncSkillSource = Awaited<
  ReturnType<RuleSyncRepository["updateSkillSource"]>
>;

interface SkillContentError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly reason: string;
}

function skillContentReadError(error: unknown): SkillContentError | null {
  if (error instanceof RuleSyncSkillConflictError) {
    return {
      status: 404,
      code: "autodev_control_skill_not_found",
      message: error.message,
      reason: "unknown_skill"
    };
  }
  if (error instanceof RuleSyncSkillValidationError) {
    return {
      status: 409,
      code: "autodev_control_skill_source_invalid",
      message: error.message,
      reason: "invalid_source"
    };
  }
  if (error instanceof RuleSyncSkillSourceUnavailableError) {
    return {
      status: 503,
      code: "autodev_control_skill_source_unavailable",
      message: error.message,
      reason: "source_unavailable"
    };
  }
  return null;
}

function readSkillContent(
  response: ServerResponse,
  name: string,
  repository: RuleSyncRepository,
  repositoryRoot: string,
  home: string
): void {
  try {
    const source = repository.readSkillSource(name);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-skill-content-v2",
        name: source.name,
        path: source.path,
        content: source.content,
        revision: source.revision,
        reconciliation: skillReconciliationView({
          name,
          repositoryRoot,
          home,
          desiredRevision: source.revision
        })
      } satisfies ControlApiSkillContentResponse,
      { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
    );
  } catch (error) {
    const failure = skillContentReadError(error);
    if (failure === null) throw error;
    sendControlError(response, failure.status, failure.code, failure.message);
  }
}

function auditSkillContentError(
  actor: ControlApiActor,
  resource: string,
  reason: string
): void {
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_skill",
    resource,
    outcome: "error",
    changes: null,
    reason
  });
}

async function readSkillContentPatchBody(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string
): Promise<SkillContentPatchBody | null> {
  const parsed = await readControlApiJsonObject(
    request,
    SKILL_CONTENT_REQUEST_MAX_BYTES
  );
  if (!parsed.ok) {
    auditSkillContentError(actor, resource, parsed.code);
    sendControlError(response, parsed.status, parsed.code, parsed.message);
    return null;
  }
  const { body } = parsed;
  if (
    Object.keys(body).length === 2 &&
    typeof body.content === "string" &&
    typeof body.expectedRevision === "string" &&
    SKILL_CONTENT_REVISION_PATTERN.test(body.expectedRevision)
  ) {
    return {
      content: body.content,
      expectedRevision: body.expectedRevision
    };
  }
  auditSkillContentError(actor, resource, "invalid_body");
  sendControlError(
    response,
    400,
    "autodev_control_api_invalid_body",
    "Skill content updates require exactly the expected source revision and Markdown content."
  );
  return null;
}

function skillContentUpdateError(error: unknown): SkillContentError | null {
  if (error instanceof RuleSyncSkillConflictError) {
    return {
      status: 409,
      code: "autodev_control_skill_content_conflict",
      message: error.message,
      reason: "revision_conflict"
    };
  }
  if (error instanceof RuleSyncSkillValidationError) {
    return {
      status: 400,
      code: "autodev_control_skill_source_invalid",
      message: error.message,
      reason: "invalid_source"
    };
  }
  if (error instanceof RuleSyncSkillSourceUnavailableError) {
    return {
      status: 503,
      code: "autodev_control_skill_source_unavailable",
      message: error.message,
      reason: "source_unavailable"
    };
  }
  return null;
}

async function updateSkillContent(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  name: string,
  body: SkillContentPatchBody,
  repository: RuleSyncRepository
): Promise<UpdatedRuleSyncSkillSource | null> {
  try {
    return await repository.updateSkillSource({
      name,
      expectedRevision: body.expectedRevision,
      content: body.content
    });
  } catch (error) {
    const failure = skillContentUpdateError(error);
    if (failure === null) throw error;
    auditSkillContentError(actor, resource, failure.reason);
    sendControlError(response, failure.status, failure.code, failure.message);
    return null;
  }
}

function applySkillContent(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  repositoryRoot: string,
  updated: UpdatedRuleSyncSkillSource
): boolean {
  try {
    materializeRuleSyncSkillProjections(repositoryRoot);
    return true;
  } catch {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_skill",
      resource,
      outcome: "error",
      changes: { name: updated.name, revision: updated.revision },
      reason: "projection_apply_failed",
      desiredGeneration: updated.revision,
      observedGeneration: null
    });
    sendControlError(
      response,
      503,
      "autodev_control_skill_apply_failed",
      "Canonical skill source was updated, but RuleSync projection generation or verification failed. Reload the current source before retrying."
    );
    return false;
  }
}

function confirmSkillContentApplied(
  response: ServerResponse,
  actor: ControlApiActor,
  resource: string,
  name: string,
  body: SkillContentPatchBody,
  updated: UpdatedRuleSyncSkillSource
): void {
  const appliedAt = new Date().toISOString();
  const changed = updated.revision !== body.expectedRevision;
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "update_rule_sync_skill",
    resource,
    outcome: "ok",
    changes: {
      name,
      revision: updated.revision,
      contentBytes: Buffer.byteLength(body.content, "utf8"),
      changed
    },
    desiredGeneration: updated.revision,
    observedGeneration: updated.revision
  });
  const reconciliation = buildReconciliationView({
    evidence: {
      desiredGeneration: updated.revision,
      observedGeneration: updated.revision,
      lastApplyAt: appliedAt,
      lastObservationAt: appliedAt,
      lastError: null
    },
    history: historyForResource(resource),
    hasObservation: true,
    restartRequired: false
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-skill-content-patch-v1",
      name,
      revision: updated.revision,
      changed,
      projectionApplied: true,
      reconciliation
    } satisfies ControlApiSkillContentPatchResponse,
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

function rejectSkillContentMethod(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  pathname: string
): void {
  auditRejectedRequest(
    request,
    request.method ?? "GET",
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", ALLOWED_METHODS_READ_AND_PATCH);
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Canonical skill content accepts GET and PATCH."
  );
}

async function patchSkillContent(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  name: string,
  resource: string,
  repository: RuleSyncRepository,
  repositoryRoot: string
): Promise<void> {
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "update_rule_sync_skill",
      resource,
      outcome: "denied",
      changes: null,
      reason: "operator_required"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_forbidden",
      "Updating canonical RuleSync skills requires an operator."
    );
    return;
  }

  const body = await readSkillContentPatchBody(
    request,
    response,
    actor,
    resource
  );
  if (body === null) return;
  const updated = await updateSkillContent(
    response,
    actor,
    resource,
    name,
    body,
    repository
  );
  if (updated === null) return;
  if (!applySkillContent(response, actor, resource, repositoryRoot, updated))
    return;
  confirmSkillContentApplied(response, actor, resource, name, body, updated);
}

/** Read or update one canonical RuleSync `SKILL.md`, never its assignments. */
async function skillContentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  name: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPO_ROOT;
  const repository = new RuleSyncRepository(repositoryRoot);
  const home = options.home ?? defaultHomeForReconciliation();
  const resource = `${CONTROL_API_PATHS.skills}/${name}/content`;
  if (method === "GET") {
    readSkillContent(response, name, repository, repositoryRoot, home);
    return true;
  }
  if (method === "PATCH") {
    await patchSkillContent(
      request,
      response,
      actor,
      name,
      resource,
      repository,
      repositoryRoot
    );
    return true;
  }
  rejectSkillContentMethod(request, response, actor, pathname);
  return true;
}

async function skillRolesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  name: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  const catalog = new RuleSyncRepository(
    options.repositoryRoot ?? DEFAULT_REPO_ROOT
  ).loadSkills();
  const skill = catalog.skills.find((entry) => entry.name === name);
  // A request for a skill that is not there is a wrong answer, not an empty
  // one: the caller would render a panel for a skill that does not exist. A
  // catalogue that was read and found broken is a different claim, and it
  // answers 503 with the catalogue's own reason: a 404 would say the skill
  // does not exist when nobody could read the file that would have said
  // whether it does. An absent catalogue holds no skill, so the skill is
  // genuinely not there.
  if (!skill) {
    if (catalog.valid === false) {
      sendControlError(
        response,
        503,
        "autodev_control_skill_catalogue_invalid",
        catalog.issues[0]?.message ??
          "The RuleSync skill catalog is invalid, so no skill could be read."
      );
      return true;
    }
    sendControlError(
      response,
      404,
      "autodev_control_skill_not_found",
      `No RuleSync skill named "${name}" exists.`
    );
    return true;
  }
  if (method === "PATCH") {
    await patchSkillRoles(request, response, actor, name, options);
    return true;
  }
  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", "PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Skill role assignment accepts PATCH. Read canonical source from /control/skills/:name/content."
  );
  return true;
}

async function skillControlApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  const contentMatch = pathname.match(SKILL_CONTENT_PATH);
  if (contentMatch) {
    await skillContentRoute(
      request,
      response,
      actor,
      method,
      pathname,
      contentMatch[1]!,
      options
    );
    return true;
  }
  const rolesMatch = pathname.match(SKILL_ROLES_PATH);
  if (rolesMatch) {
    await skillRolesRoute(
      request,
      response,
      actor,
      method,
      pathname,
      rolesMatch[1]!,
      options
    );
    return true;
  }
  return false;
}

async function promptDetailRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  name: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (method === "GET") {
    const route: ReadOnlyDetailRoute = {
      ...PROMPT_DETAIL_ROUTE,
      read: (identifier) =>
        promptDetailView(
          identifier,
          options.repositoryRoot ?? DEFAULT_REPO_ROOT
        )
    };
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      name,
      route
    );
  }
  if (method === "PATCH") {
    const home = process.env.HOME?.trim() || homedir();
    const codexHome =
      options.codexHome?.trim() ||
      process.env.CODEX_HOME?.trim() ||
      path.join(home, ".codex");
    await patchPromptCommand(
      request,
      response,
      actor,
      name,
      options.repositoryRoot ?? DEFAULT_REPO_ROOT,
      codexHome
    );
    return true;
  }

  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", ALLOWED_METHODS_READ_AND_PATCH);
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Prompt details are read via GET and canonical commands are updated via PATCH."
  );
  return true;
}

/**
 * One MCP server's canonical declaration.
 *
 * The declaration is read through the MCP catalog, which carries every
 * server; the per-server path is the write, which is the only operation that
 * changes the canonical source.
 */
async function hookEventRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  event: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (method === "PATCH") {
    const home = process.env.HOME?.trim() || homedir();
    const codexHome =
      options.codexHome?.trim() ||
      process.env.CODEX_HOME?.trim() ||
      path.join(home, ".codex");
    await patchHookEvent(
      request,
      response,
      actor,
      event,
      options.repositoryRoot ?? DEFAULT_REPO_ROOT,
      codexHome
    );
    return true;
  }

  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", "PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Hooks are read through the hook declaration, and the canonical declaration is written via PATCH."
  );
  return true;
}

async function mcpServerRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  name: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (method === "PATCH") {
    const home = process.env.HOME?.trim() || homedir();
    const codexHome =
      options.codexHome?.trim() ||
      process.env.CODEX_HOME?.trim() ||
      path.join(home, ".codex");
    await patchMcpServer(
      request,
      response,
      actor,
      name,
      options.repositoryRoot ?? DEFAULT_REPO_ROOT,
      codexHome
    );
    return true;
  }

  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", "PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "MCP servers are read through the MCP catalog, and the canonical declaration is written via PATCH."
  );
  return true;
}

function workspacePlaytestingApprovalRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  return handleWorkspacePlaytestingApprovalRequest(
    request,
    response,
    pathname,
    actor,
    {
      ...(options.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: options.repositoryRoot }),
      ...(options.workspacePlaytestApprovalRepository === undefined
        ? {}
        : { repository: options.workspacePlaytestApprovalRepository }),
      audit: (event) =>
        auditMutation({
          actor: actor.actor,
          actorVerified: true,
          role: actor.role,
          action: event.action,
          resource: `/control/workspaces/${event.workspaceId}/playtesting-approval`,
          outcome: event.outcome,
          changes: event.changes,
          ...(event.reason ? { reason: event.reason } : {})
        })
    }
  );
}

function workspaceVisualPlaytestTargetsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  return handleWorkspaceVisualPlaytestTargetRequest(
    request,
    response,
    pathname,
    actor,
    {
      ...(options.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: options.repositoryRoot }),
      ...(options.workspaceVisualPlaytestTargetRepository === undefined
        ? {}
        : { repository: options.workspaceVisualPlaytestTargetRepository }),
      audit: (event) =>
        auditMutation({
          actor: actor.actor,
          actorVerified: true,
          role: actor.role,
          action: event.action,
          resource: `/control/workspaces/${event.workspaceId}/playtesting-visual-targets${event.targetId === null ? "" : `/${event.targetId}`}`,
          outcome: event.outcome,
          changes: event.changes,
          ...(event.reason ? { reason: event.reason } : {})
        })
    }
  );
}

function playtestingHumanStudyRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (!pathname.startsWith(CONTROL_API_PATHS.playtesting + "/human-studies/")) {
    return Promise.resolve(false);
  }
  const configRepository = new ConfigRepository(options.repositoryRoot);
  return handlePlaytestingHumanStudyControlApiRequest(
    request,
    response,
    pathname,
    actor,
    {
      repository:
        options.playtestingHumanStudyRepository ?? new PlaytestRepository(),
      responses:
        options.restrictedHumanResponseRepository ??
        getDefaultRestrictedHumanResponseRepository(),
      workspaceApprovals:
        options.workspacePlaytestApprovalRepository ??
        new WorkspacePlaytestApprovalRepository(),
      readWorkspaceCatalog: () => configRepository.readWorkspaceCatalog(),
      audit: (event) =>
        auditMutation({
          actor: actor.actor,
          actorVerified: true,
          role: actor.role,
          action: event.action,
          resource: `/control/playtesting/human-studies/${event.workspaceId}`,
          outcome: event.outcome,
          changes: event.changes,
          ...(event.reason ? { reason: event.reason } : {})
        })
    }
  );
}

function playtestingRunControlRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  return handlePlaytestingRunControlRequest(
    request,
    response,
    pathname,
    actor,
    {
      ...(options.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: options.repositoryRoot }),
      runControl:
        options.playtestingRunControl ?? getDefaultPlaytestRunControl(),
      ...(options.workspaceVisualPlaytestTargetRepository === undefined
        ? {}
        : {
            visualTargetRepository:
              options.workspaceVisualPlaytestTargetRepository
          }),
      requireSessionHeader: actor.playtestingService === true,
      ...(actor.playtestingService
        ? {
            trustedSessionRole: actor.playtestingServiceRole ?? ""
          }
        : {}),
      audit: (event) =>
        auditMutation({
          actor: actor.actor,
          actorVerified: true,
          role: actor.role,
          action: event.action,
          resource: `/control/playtesting/runs/${event.workspaceId}`,
          outcome: event.outcome,
          changes: event.changes,
          ...(event.reason ? { reason: event.reason } : {})
        })
    }
  );
}

async function playtestingRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: ControlApiActor,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (!pathname.startsWith(CONTROL_API_PATHS.playtesting + "/")) return false;
  await handlePlaytestingControlApiRequest(request, response, pathname, actor, {
    ...(options.repositoryRoot === undefined
      ? {}
      : { repositoryRoot: options.repositoryRoot }),
    ...(options.playtestingRepository === undefined
      ? {}
      : { repository: options.playtestingRepository })
  });
  return true;
}

function authorizePlaytestingRunService(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
):
  | { readonly kind: "not-matched" }
  | { readonly kind: "denied" }
  | { readonly kind: "authorized"; readonly actor: ControlApiActor } {
  const isRunControl =
    pathname === PLAYTESTING_CAPABILITIES_PATH ||
    pathname === PLAYTESTING_RUNS_PATH ||
    pathname.startsWith(PLAYTESTING_RUNS_PATH + "/");
  if (!isRunControl) return PLAYTEST_SERVICE_NOT_MATCHED;

  const authorization = header(request, "authorization");
  if (!authorization) return PLAYTEST_SERVICE_NOT_MATCHED;
  const configuredRole =
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE?.trim() || "playtester";
  const configuredToken =
    process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN?.trim() ||
    readRuntimeSecret("AUTODEV_PLAYTEST_CONTROL_API_TOKEN") ||
    "";
  if (
    !["playtester", "validator", "root", "operator"].includes(configuredRole) ||
    !configuredToken ||
    !secretMatches(authorization, "Bearer " + configuredToken)
  ) {
    return PLAYTEST_SERVICE_NOT_MATCHED;
  }
  const actor =
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR?.trim() ||
    "autodev-playtester-runtime";
  if (!ACTOR_ID_PATTERN.test(actor)) {
    sendControlError(
      response,
      503,
      "autodev_control_playtesting_actor_unconfigured",
      "The trusted Playtesting Control API actor is not configured."
    );
    return { kind: "denied" };
  }
  return {
    kind: "authorized",
    actor: {
      actor,
      role: "operator",
      playtestingService: true,
      playtestingServiceRole: configuredRole as NonNullable<
        ControlApiActor["playtestingServiceRole"]
      >
    }
  };
}

function actorForControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  pathname: string
): ControlApiActor | null {
  const scoped = authorizePlaytestingRunService(request, response, pathname);
  if (scoped.kind === "denied") return null;
  if (scoped.kind === "authorized") return scoped.actor;
  return authorizeRequest(request, response, method, pathname);
}

async function agentDetailRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  role: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (method === "PATCH") {
    await patchAgentEnablement(request, response, actor, role);
    return true;
  }
  if (method === "GET") {
    // The role's prompt is read from the same repository the collection is
    // read from, so a caller pointed at another repository gets one answer
    // about one repository rather than two answers about two.
    const route: ReadOnlyDetailRoute = {
      ...AGENT_DETAIL_ROUTE,
      read: (identifier) =>
        agentDetailView(identifier, options.repositoryRoot ?? DEFAULT_REPO_ROOT)
    };
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      role,
      route
    );
  }

  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", ALLOWED_METHODS_READ_AND_PATCH);
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Agent details support GET reads and PATCH enablement changes."
  );
  return true;
}

/**
 * The one answer to a request that used the wrong verb for a mutation route.
 *
 * Each mutation-only route repeated the same guard, and the copies had drifted:
 * two of them only audited the rejection without answering it, so a GET
 * against the provider limits or the provider enablement route left the caller
 * with no response at all and no way to learn why. One rejection, so every
 * mutation-only route audits the attempt, advertises the verb it accepts, and
 * answers 405.
 */
function rejectUnsupportedMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  pathname: string,
  actor: ControlApiActor,
  allowed: "PATCH" | "POST",
  message: string
): void {
  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", allowed);
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    message
  );
}

/**
 * The routes that only ever mutate.
 *
 * They live together so the verb guard is written once, and so a request that
 * used the wrong verb is answered the same way whichever route it called.
 */
async function handleMutationOnlyRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  pathname: string,
  actor: ControlApiActor
): Promise<boolean> {
  if (pathname === CONTROL_API_PATHS.concurrency) {
    if (method !== "PATCH") {
      rejectUnsupportedMethod(
        request,
        response,
        method,
        pathname,
        actor,
        "PATCH",
        "Orchestrator concurrency limits are mutated via PATCH only."
      );
      return true;
    }
    await patchConcurrencyLimit(request, response, actor);
    return true;
  }
  const providerLimitsMatch = pathname.match(PROVIDER_LIMITS_PATH);
  if (providerLimitsMatch) {
    if (method !== "PATCH") {
      rejectUnsupportedMethod(
        request,
        response,
        method,
        pathname,
        actor,
        "PATCH",
        "Provider limits are mutated via PATCH only."
      );
      return true;
    }
    await patchProviderLimits(
      request,
      response,
      actor,
      providerLimitsMatch[1]!
    );
    return true;
  }
  if (pathname === CONTROL_API_PATHS.providersReset) {
    if (method !== "POST") {
      rejectUnsupportedMethod(
        request,
        response,
        method,
        pathname,
        actor,
        "POST",
        "Provider reset is mutated via POST only."
      );
      return true;
    }
    await resetProviders(request, response, actor);
    return true;
  }
  const providerOnlyMatch = pathname.match(PROVIDER_PATH);
  if (providerOnlyMatch) {
    if (method !== "PATCH") {
      rejectUnsupportedMethod(
        request,
        response,
        method,
        pathname,
        actor,
        "PATCH",
        "Provider enablement is mutated via PATCH only."
      );
      return true;
    }
    await patchProviderEnabled(request, response, actor, providerOnlyMatch[1]!);
    return true;
  }
  return false;
}

/**
 * One workspace's own configuration route.
 *
 * The catalog is read through the collection route and written through this
 * one, so a write names the workspace it changes rather than a collection the
 * caller would have to search.
 */
async function workspaceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  method: string,
  pathname: string,
  owner: string,
  repository: string,
  options: ControlApiRequestOptions
): Promise<boolean> {
  if (method === "PATCH") {
    await patchWorkspace(
      request,
      response,
      actor,
      owner,
      repository,
      options.repositoryRoot ?? DEFAULT_REPO_ROOT
    );
    return true;
  }
  auditRejectedRequest(
    request,
    method,
    pathname,
    AUDIT_REASON_METHOD_NOT_ALLOWED,
    actor
  );
  response.setHeader("allow", "PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "A workspace's canonical configuration is written via PATCH."
  );
  return true;
}

export async function handleControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: ControlApiRequestOptions = {}
): Promise<boolean> {
  if (!pathname.startsWith(CONTROL_API_BASE + "/")) return false;
  const method = request.method ?? "GET";
  const actor = actorForControlRequest(request, response, method, pathname);
  if (!actor) return true;
  if (
    (await workspaceVisualPlaytestTargetsRoute(
      request,
      response,
      pathname,
      actor,
      options
    )) ||
    (await workspacePlaytestingApprovalRoute(
      request,
      response,
      pathname,
      actor,
      options
    ))
  ) {
    return true;
  }
  if (pathname.startsWith(CONTROL_API_PATHS.memory + "/")) {
    await handleMemoryControlApiRequest(
      request,
      response,
      pathname,
      actor,
      (event) =>
        auditMutation({
          actor: actor.actor,
          actorVerified: true,
          role: actor.role,
          action: event.action,
          resource: event.resource,
          outcome: event.outcome,
          changes: event.changes,
          ...(event.reason ? { reason: event.reason } : {})
        })
    );
    return true;
  }
  if (
    await playtestingHumanStudyRoute(
      request,
      response,
      pathname,
      actor,
      options
    )
  ) {
    return true;
  }
  if (
    await playtestingRunControlRoute(
      request,
      response,
      pathname,
      actor,
      options
    )
  ) {
    return true;
  }
  if (await playtestingRoute(request, response, pathname, actor, options))
    return true;
  const providerMatch = pathname.match(PROVIDER_ROLE_PATH);
  if (providerMatch) {
    await providerRoleRoute(
      request,
      response,
      actor,
      method,
      pathname,
      providerMatch
    );
    return true;
  }
  if (
    await handleMutationOnlyRoute(request, response, method, pathname, actor)
  ) {
    return true;
  }
  const modelMatch = pathname.match(MODEL_PATH);
  if (modelMatch)
    return modelRoute(
      request,
      response,
      actor,
      method,
      pathname,
      modelMatch[1]!
    );
  const agentMatch = pathname.match(AGENT_DETAIL_PATH);
  if (agentMatch)
    return agentDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      agentMatch[1]!.toLowerCase(),
      options
    );
  const promptVersionsMatch = promptVersionsPath(pathname);
  if (promptVersionsMatch)
    return promptVersionsRoute(
      request,
      response,
      actor,
      method,
      pathname,
      promptVersionsMatch.name,
      promptVersionsMatch.versionHash,
      options
    );
  if (
    await skillControlApiRoute(
      request,
      response,
      actor,
      method,
      pathname,
      options
    )
  ) {
    return true;
  }
  const promptMatch = pathname.match(PROMPT_DETAIL_PATH);
  if (promptMatch)
    return promptDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      promptMatch[1]!,
      options
    );
  const mcpServerMatch = pathname.match(MCP_SERVER_PATH);
  if (mcpServerMatch)
    return mcpServerRoute(
      request,
      response,
      actor,
      method,
      pathname,
      mcpServerMatch[1]!,
      options
    );
  const hookEventMatch = pathname.match(HOOK_EVENT_PATH);
  if (hookEventMatch)
    return hookEventRoute(
      request,
      response,
      actor,
      method,
      pathname,
      hookEventMatch[1]!,
      options
    );
  const workspaceMatch = pathname.match(WORKSPACE_DETAIL_PATH);
  if (workspaceMatch)
    return workspaceRoute(
      request,
      response,
      actor,
      method,
      pathname,
      workspaceMatch[1]!,
      workspaceMatch[2]!,
      options
    );
  if (pathname === CONTROL_API_PATHS.permissions)
    return permissionsRoute(
      request,
      response,
      actor,
      method,
      pathname,
      options
    );
  if (await readOnlyCollection(pathname, method, response, actor, options))
    return true;
  auditRejectedRequest(
    request,
    method,
    pathname,
    "unknown_control_resource",
    actor
  );
  sendControlError(
    response,
    404,
    "autodev_control_api_unknown_path",
    "Unknown Control API path."
  );
  return true;
}
export { warmupDefaultPlaytestingRepository } from "./playtesting.ts";
