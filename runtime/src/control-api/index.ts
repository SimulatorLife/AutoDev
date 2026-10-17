import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
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
  type ControlApiHooksResponse,
  type ControlApiLiveAgentCounts,
  type ControlApiMcpsResponse,
  type ControlApiModelPatchResponse,
  type ControlApiModelsResponse,
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
  type ControlApiProvidersResponse,
  type ControlApiRoutingResponse,
  type ControlApiRuntimeResponse,
  type ControlApiSkillContentPatchResponse,
  type ControlApiSkillContentResponse,
  type ControlApiSkillRolesPatchResponse,
  type ControlApiSkillsResponse,
  type ControlApiToolsResponse,
  type ControlApiWorkspacesResponse,
  type GithubActionsRuntimeStatus,
  type GithubWorkflowDefinition,
  type GithubWorkflowRun,
  type GithubWorkflowState,
  LOCAL_CONTROL_API_ACTOR,
  type McpServerResource,
  type OperationHistoryEntry,
  PROVIDER_ROLES,
  type ProviderRole,
  type ProviderRoleAssignment,
  type ReconciliationDiff,
  type ReconciliationEvidence,
  type ReconciliationStatus,
  type ToolCatalogItem,
  type ToolCatalogView
} from "@simulatorlife/autodev-core";
import {
  assignSkillRoles,
  auditEnvelopesToHistory,
  boundReconciliationError,
  ConfigRepository,
  EvaluationRepository,
  EvaluationSourceUnavailableError,
  ExecutionContractConflictError,
  executionContractRevision,
  ExecutionContractValidationError,
  GithubActionsAdapter,
  GithubActionsApiError,
  type GithubActionsRuntimeSnapshot,
  type GithubApiWorkflow,
  GithubWorkflowRepository,
  PlaytestRepository,
  reconcileDiffSummary,
  reconcileDiffWithIdentifier,
  RuleSyncCommandConflictError,
  RuleSyncCommandHistoryUnavailableError,
  RuleSyncCommandValidationError,
  RuleSyncRepository,
  RuleSyncSkillConflictError,
  RuleSyncSkillSourceUnavailableError,
  RuleSyncSkillValidationError,
  ToolCatalogAdapter
} from "@simulatorlife/autodev-data";
import {
  getDefaultRestrictedHumanResponseRepository,
  type RestrictedHumanResponseRepository
} from "@simulatorlife/autodev-data/playtesting";
import {
  WorkspacePlaytestApprovalRepository,
  type WorkspaceVisualPlaytestTargetRepository
} from "@simulatorlife/autodev-data/workspaces";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { getDefaultRouterLifecycle } from "@simulatorlife/autodev-runtime/router/lifecycle";
import { getDefaultPersistenceManager } from "@simulatorlife/autodev-runtime/router/persistence";
import {
  ROUTES,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import {
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";

import {
  materializeCommands,
  materializeRuleSyncSkillProjections
} from "../platform/install-materializer.ts";
import type { PlaytestRunControl } from "../playtesting/mcp.ts";
import { getDefaultPlaytestRunControl } from "../playtesting/run-control-service.ts";
import { errorBody, ROUTER_INSTANCE_ID, sendJson } from "../router/proxy.ts";
import {
  executionContractFile,
  getDefaultExecutionContract,
  reloadExecutionContract
} from "../router/subagents.ts";
import { routerTelemetryTracer } from "../router/telemetry.ts";
import { readControlApiJsonObject } from "./body.ts";
import { handleMemoryControlApiRequest } from "./memory.ts";
import {
  handlePlaytestingControlApiRequest,
  type PlaytestingReadRepository
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
  providerModels: "/control/provider-models",
  models: "/control/models",
  mcps: "/control/mcps",
  tools: "/control/tools",
  skills: "/control/skills",
  hooks: "/control/hooks",
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
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { slug?: unknown }).slug === "string"
        ) {
          const slug = (entry as { slug: string }).slug;
          const defaultLevel =
            typeof (entry as { default_reasoning_level?: unknown })
              .default_reasoning_level === "string"
              ? (entry as { default_reasoning_level: string })
                  .default_reasoning_level
              : null;
          const supportedLevels: string[] = [];
          const rawSupported = (entry as { supported_reasoning_levels?: unknown })
            .supported_reasoning_levels;
          if (Array.isArray(rawSupported)) {
            for (const item of rawSupported) {
              if (
                item &&
                typeof item === "object" &&
                typeof (item as { effort?: unknown }).effort === "string"
              ) {
                supportedLevels.push((item as { effort: string }).effort);
              }
            }
          }
          levels.set(slug, { defaultLevel, supportedLevels });
          if (
            typeof (entry as { display_name?: unknown }).display_name === "string"
          ) {
            names.set(slug, (entry as { display_name: string }).display_name);
          }
        }
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
const SKILL_ROLES_PATH = /^\/control\/skills\/([a-zA-Z0-9._-]+)$/u;
const SKILL_CONTENT_PATH = /^\/control\/skills\/([a-z0-9-]{1,64})\/content$/u;
const SKILL_CONTENT_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const AGENT_ENABLEMENT_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SKILL_CONTENT_REQUEST_MAX_BYTES = 300_000;
const enablementMutationTails = new Map<string, Promise<void>>();

async function serializeEnablementMutation<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = enablementMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  enablementMutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (enablementMutationTails.get(key) === tail)
      enablementMutationTails.delete(key);
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
const GITHUB_CONTROL_API_SCHEMA = "autodev-control-github-v1";
const GITHUB_WORKFLOW_YAML_SOURCE = ".github/workflows";

export type ControlApiRole = "viewer" | "operator";

/** Trusted host options for isolated Control API integration tests. */
export interface ControlApiRequestOptions {
  readonly repositoryRoot?: string;
  readonly codexHome?: string;
  /** Test seams for Data-owned readers; never supplied by a request. */
  readonly playtestingRepository?: PlaytestingReadRepository;
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

let providerHealthSource: ControlApiProviderHealthSource | null = null;
let liveAgentCountsSource: ControlApiLiveAgentCountsSource | null = null;
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
      health: health?.[provider] ?? null
    };
  });
  return {
    schema: "autodev-control-providers-v2",
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

function mcpsView(): Record<string, unknown> {
  const state = new RuleSyncRepository(DEFAULT_REPO_ROOT).loadMcpState();
  if (state.valid !== true) {
    return {
      schema: "autodev-control-mcps-v1",
      source: state.source,
      readOnly: true,
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
    schema: "autodev-control-mcps-v1",
    source: state.source,
    readOnly: true,
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

  if (roles.length === 0 && rulesyncCatalog.tools.length === 0) {
    return {
      schema: "autodev-control-tools-v2",
      source: rulesyncCatalog.source,
      readOnly: true,
      coverage:
        rulesyncCatalog.validity === "valid" ? "unavailable" : "unknown",
      validity: rulesyncCatalog.validity,
      totalTools: 0,
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
    totalTools: tools.length,
    tools,
    usageLink: "/usage"
  } satisfies ControlApiToolsResponse;
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
  return {
    schema: "autodev-control-skills-v2",
    source: `${catalog.source}+${EXECUTION_CONTRACT_SOURCE}`,
    readOnly: true,
    valid: catalog.valid,
    issues: catalog.issues,
    executionContractRevision:
      contractFile === null
        ? null
        : executionContractRevision(readContract(contractFile)),
    assignmentRoles: assignableRoles(),
    skills: catalog.skills.map((skill) => ({
      ...skill,
      roles: rolesBySkill.get(skill.name) ?? []
    })),
    unresolvedAssignments:
      catalog.valid === true
        ? assignments.filter(({ name }) => !catalogNames.has(name))
        : []
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

function workspacesView(repositoryRoot?: string): Record<string, unknown> {
  const catalog = new ConfigRepository(repositoryRoot).readWorkspaceCatalog();
  return {
    schema: "autodev-control-workspaces-v1",
    source: "config/workspaces.json",
    readOnly: true,
    catalogStatus: catalog.status,
    totalWorkspaces:
      catalog.status === "valid" ? catalog.workspaces.length : null,
    workspaces: catalog.workspaces
  } satisfies ControlApiWorkspacesResponse;
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
    recentRuns: []
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
        GITHUB_SNAPSHOT_CACHE.set(cacheKey, { timestamp: now, snapshot });
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
      return {
        id: role,
        role,
        kind,
        readOnly,
        configured: true,
        valid: null,
        status: "configured",
        convergence: "not-observed",
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
  return {
    schema: "autodev-control-agents-v2",
    source: EXECUTION_CONTRACT_SOURCE,
    readOnly: false,
    totalAgents: agents.length,
    agents
  } satisfies ControlApiAgentsResponse;
}

function agentDetailView(
  role: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const roles = getDefaultExecutionContract().roles ?? {};
  const raw = roles[role] as Record<string, unknown> | undefined;
  if (!raw) return null;
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
  let systemPrompt = "";
  if (existsSync(promptPath)) {
    try {
      systemPrompt = readFileSync(promptPath, "utf8").trim();
    } catch {
      // Ignore unreadable prompt
    }
  }
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

  return {
    schema: "autodev-control-agent-detail-v3",
    id: role,
    role,
    kind,
    readOnly,
    configured: true,
    valid: null,
    status: "configured",
    convergence: "not-observed",
    enablement: agentEnablementView(role),
    primaryModel: isOrchestrator ? "autodev/orchestrator" : "autodev/subagent",
    allowedProviders,
    mcps,
    skills,
    promptPath: existsSync(promptPath)
      ? `agents/prompts/roles/${role}.md`
      : null,
    systemPrompt,
    reconciliation: promptReconciliationView({
      name: role,
      codexHome: defaultCodexHomeForReconciliation(),
      expectedRevision: createHash("sha256")
        .update(systemPrompt, "utf8")
        .digest("hex")
    })
  } satisfies ControlApiAgentDetailResponse;
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

function hooksView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const state = new RuleSyncRepository(repositoryRoot).loadHooksState();
  const hooks = Object.fromEntries(
    state.hooks.map((hook) => [hook.event, hook.actions])
  );
  return {
    schema: "autodev-control-hooks-v1",
    source: state.source,
    readOnly: true,
    valid: state.valid,
    issues: state.issues,
    hooks
  } satisfies ControlApiHooksResponse;
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

function permissionsView(
  _repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const roles = getDefaultExecutionContract().roles ?? {};
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
    const isReadOnly = Boolean(entry.readOnly);
    rolePermissions[role] = {
      readOnly: isReadOnly,
      sandbox: isReadOnly ? "read-only" : "workspace-write",
      networkAccess: true,
      approvals: "never",
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
    schema: "autodev-control-permissions-v1",
    source: "config.autodev.toml",
    readOnly: true,
    policy: {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
      networkAccess: true,
      webSearch: true,
      defaultToolsApprovalMode: "approve"
    },
    rolePermissions
  } satisfies ControlApiPermissionsResponse;
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
  const rolePrompts: Array<{ role: string; path: string }> = [];
  if (existsSync(rolePromptsDir)) {
    try {
      const files = readdirSync(rolePromptsDir);
      for (const file of files
        .filter((f) => f.endsWith(".md"))
        .sort(CONTROL_API_COLLATOR.compare)) {
        const role = file.replace(MD_EXTENSION_PATTERN, "");
        rolePrompts.push({
          role,
          path: `agents/prompts/roles/${file}`
        });
      }
    } catch {
      // Ignore unreadable role prompts directory
    }
  }
  return {
    schema: "autodev-control-prompts-v2",
    source: commandState.source,
    readOnly: true,
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
 *
 * A `denied` envelope is skipped. A refusal is not an apply: nothing was
 * attempted and nothing changed, so treating it as the latest evidence would
 * stamp the resource with a last-apply time and a `lastError` describing a
 * request that was correctly rejected — reporting a failed apply for a resource
 * that is still perfectly converged. Validation and persistence failures are
 * `error`, not `denied`, and remain evidence.
 */
function findLatestAuditFor(resourceFilter: string): {
  readonly timestamp: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
  readonly reason: string | null;
} | null {
  const envelopes = getOperationHistory(resourceFilter);
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
  readonly expectedRevision: string;
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

function defaultCodexHomeForReconciliation(): string {
  const home = process.env.HOME?.trim() || homedir();
  return process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
}

function promptDetailView(
  name: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const repo = new RuleSyncRepository(repositoryRoot);
  const command = repo.loadCommand(name);
  if (command) {
    const reconciliation = promptReconciliationView({
      name,
      codexHome: defaultCodexHomeForReconciliation(),
      expectedRevision: command.revision
    });
    return {
      schema: "autodev-control-prompt-detail-v4",
      name,
      type: "command",
      source: command.path,
      content: command.content,
      preview: command.prompt,
      revision: command.revision,
      diff: reconcileDiffWithIdentifier({
        summary:
          "Canonical RuleSync command; Rulesync projection observed via Codex home.",
        identifier: hashString(command.revision) ?? ""
      }),
      reconciliation
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
      } satisfies ControlApiPromptDetailResponse;
    } catch {
      return null;
    }
  }
  return null;
}

function promptVersionsView(
  name: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const history = new RuleSyncRepository(repositoryRoot).loadCommandHistory(
    name
  );
  if (!history) return null;
  return {
    schema: "autodev-control-prompt-versions-v1",
    name,
    status: history.status,
    versions: history.versions,
    hasMore: history.hasMore
  } satisfies ControlApiPromptVersionsResponse;
}

function promptVersionView(
  name: string,
  versionHash: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const version = new RuleSyncRepository(repositoryRoot).loadCommandVersion(
    name,
    versionHash
  );
  if (!version) return null;
  return {
    schema: "autodev-control-prompt-version-v1",
    name: version.name,
    versionHash: version.versionHash,
    updatedAt: version.updatedAt,
    content: version.content,
    diff: version.diff
  } satisfies ControlApiPromptVersionResponse;
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
    await serializeEnablementMutation(mutation.serializeKey, applyMutation);
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
  const modelIsValid =
    model === null ||
    (typeof model === "string" &&
      (model === ROUTING_POLICY.assignmentFor(provider, role)?.model ||
        (ROUTING_POLICY.isModelAvailableForProvider(provider, model) &&
          providerHasCurrentModelDiscovery(provider, model))));
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
    !modelIsValid ||
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
        ...(body.reasoningEffort !== undefined ? { reasoningEffort } : {})
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

  // A globally disabled provider is meant to be off entirely, with its roles,
  // models and limits preserved for re-enabling. Editing a role while it is
  // disabled is therefore not a valid change: the Console renders these rows
  // with `mutable: false` and tells the operator to enable the provider first,
  // so accepting the write here would leave that message a claim the API does
  // not honour. `isProviderEnabledForRole` is not the right test — it folds in
  // the per-role `disabled` priority, which this endpoint is what sets.
  if (ROUTING_POLICY.isProviderDisabled(provider)) {
    audit(
      "denied",
      {
        priority,
        model,
        ...(body.reasoningEffort !== undefined ? { reasoningEffort } : {})
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

  const isAgyFixed =
    provider === "antigravity" && Boolean(modelEffort(assignedModel ?? ""));
  const effectiveReasoningEffort = isAgyFixed
    ? modelEffort(assignedModel ?? "")
    : (reasoningEffort ?? modelInfo?.defaultLevel ?? null);
  const reasoningEffortInForce =
    !isAgyFixed ||
    reasoningEffort === null ||
    reasoningEffort === effectiveReasoningEffort;

  const next: ProviderRoleAssignment = {
    priority,
    model,
    reasoningEffort
  };
  // An unobserved assignment is reported as null on the wire: JSON carries no
  // undefined, and "there was no assignment" must not be reported as an empty
  // object, which would read as a role whose model was cleared.
  const previous = ROUTING_POLICY.assignmentFor(provider, role) ?? null;
  const auditChanges: Record<string, unknown> = {
    priority,
    model,
    ...(body.reasoningEffort !== undefined ? { reasoningEffort } : {})
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

  const previousLimit = manager.effectivePerSessionLimit();
  const mutationResult =
    nextLimit === undefined
      ? manager.clearStoredLimit(expectedRevision)
      : manager.setMaxConcurrentThreadsPerSession(nextLimit, expectedRevision);

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
    serializeKey: `agent:${role}`,
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
  repositoryRoot: string | undefined
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
    [CONTROL_API_PATHS.agents, () => agentsView()],
    [CONTROL_API_PATHS.providers, () => providersView(Date.now())],
    [CONTROL_API_PATHS.providerModels, () => providerModelsView()],
    [CONTROL_API_PATHS.models, () => modelsView()],
    [CONTROL_API_PATHS.mcps, () => mcpsView()],
    [CONTROL_API_PATHS.tools, () => toolsView()],
    [CONTROL_API_PATHS.skills, (_actor, root) => skillsView(root)],
    [CONTROL_API_PATHS.hooks, (_actor, root) => hooksView(root)],
    [CONTROL_API_PATHS.permissions, () => permissionsView()],
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
    body = await renderCollection(actor, options.repositoryRoot);
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
      "method_not_allowed",
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
      "method_not_allowed",
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

interface ReadOnlyDetailRoute {
  readonly action: string;
  readonly unknownReason: string;
  readonly unknownCode: string;
  readonly unknownMessage: string;
  readonly read: (identifier: string) => Record<string, unknown> | null;
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
      "method_not_allowed",
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

  const detail = route.read(identifier);
  if (!detail) {
    auditRejectedRequest(request, method, pathname, route.unknownReason, actor);
    sendControlError(response, 404, route.unknownCode, route.unknownMessage);
    return true;
  }

  sendJson(response, 200, detail, {
    "cache-control": "no-store",
    vary: CONTROL_VARY_HEADER
  });
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
        : promptVersionsView(name, options.repositoryRoot ?? DEFAULT_REPO_ROOT)
  };
  try {
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      name,
      route
    );
  } catch (error) {
    if (!(error instanceof RuleSyncCommandHistoryUnavailableError)) throw error;
    auditRejectedRequest(
      request,
      method,
      pathname,
      "prompt_history_unavailable",
      actor
    );
    sendControlError(
      response,
      503,
      "autodev_control_api_prompt_history_unavailable",
      "Committed prompt history is unavailable for this source."
    );
    return true;
  }
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
 */
interface SkillRolesRequestBody {
  readonly expectedRevision: string;
  readonly roles: readonly string[];
}

/**
 * The body of a skill assignment, or the reason it is not one.
 *
 * Exactly two fields, checked exactly. A body carrying a third key is refused
 * rather than ignored, because an operator whose tooling sent something this
 * route does not understand should be told so instead of watching the
 * assignment they asked for happen to some subset of what they sent.
 */
function readSkillRolesBody(
  body: Record<string, unknown>
): SkillRolesRequestBody | null {
  const roles = body.roles;
  if (
    Object.keys(body).length !== 2 ||
    typeof body.expectedRevision !== "string" ||
    !Array.isArray(roles) ||
    !roles.every((role): role is string => typeof role === "string")
  ) {
    return null;
  }
  return { expectedRevision: body.expectedRevision, roles };
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
        roles: assignment.roles
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
      catalog.valid === true
        ? `No RuleSync skill named "${name}" exists.`
        : "The RuleSync skill catalog is invalid, so no skill could be assigned."
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
      "Skill role assignment requires exactly the expected execution-contract revision and a roles array of strings."
    );
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
  const observed = configuredRoleExposure("skills").find(
    (entry) => entry.name === name
  );
  const currentContractContent = readContract(contractFile);
  const currentContractRevision =
    currentContractContent.length > 0
      ? executionContractRevision(currentContractContent)
      : null;
  // `configuredRoleExposure` omits skills with no assigned roles. An empty
  // assignment is observed only when the just-written source revision is the
  // one the Runtime reloaded; otherwise absence from that projection stays
  // unknown instead of becoming an observed empty set.
  const actualRoles =
    observed?.roles ??
    (currentContractRevision === assigned.revision ? [] : null);
  const roleGeneration = (roles: readonly string[]): string =>
    createHash("sha256")
      .update(JSON.stringify({ skill: name, roles: [...roles].sort() }), "utf8")
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
  repository: RuleSyncRepository
): void {
  try {
    const source = repository.readSkillSource(name);
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-skill-content-v1",
        name: source.name,
        path: source.path,
        content: source.content,
        revision: source.revision
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
    "method_not_allowed",
    actor
  );
  response.setHeader("allow", "GET, PATCH");
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
  const resource = `${CONTROL_API_PATHS.skills}/${name}/content`;
  if (method === "GET") {
    readSkillContent(response, name, repository);
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
  // one: the caller would render a panel for a skill that does not exist.
  if (!skill) {
    sendControlError(
      response,
      404,
      "autodev_control_skill_not_found",
      catalog.valid === true
        ? `No RuleSync skill named "${name}" exists.`
        : "The RuleSync skill catalog is invalid, so no skill could be read."
    );
    return true;
  }
  if (method === "PATCH") {
    await patchSkillRoles(request, response, actor, name, options);
    return true;
  }
  auditRejectedRequest(request, method, pathname, "method_not_allowed", actor);
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

  auditRejectedRequest(request, method, pathname, "method_not_allowed", actor);
  response.setHeader("allow", "GET, PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Prompt details are read via GET and canonical commands are updated via PATCH."
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
    process.env.AUTODEV_PLAYTEST_CONTROL_API_ROLE?.trim() ?? "";
  const configuredToken =
    process.env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN?.trim() ?? "";
  if (
    !["playtester", "validator", "root", "operator"].includes(configuredRole) ||
    !configuredToken ||
    !secretMatches(authorization, "Bearer " + configuredToken)
  ) {
    return PLAYTEST_SERVICE_NOT_MATCHED;
  }
  const actor = process.env.AUTODEV_PLAYTEST_CONTROL_API_ACTOR?.trim() ?? "";
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
  role: string
): Promise<boolean> {
  if (method === "PATCH") {
    await patchAgentEnablement(request, response, actor, role);
    return true;
  }
  if (method === "GET")
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      role,
      AGENT_DETAIL_ROUTE
    );

  auditRejectedRequest(request, method, pathname, "method_not_allowed", actor);
  response.setHeader("allow", "GET, PATCH");
  sendControlError(
    response,
    405,
    "autodev_control_api_method_not_allowed",
    "Agent details support GET reads and PATCH enablement changes."
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
  if (pathname === CONTROL_API_PATHS.concurrency) {
    if (method !== "PATCH") {
      auditRejectedRequest(
        request,
        method,
        pathname,
        "method_not_allowed",
        actor
      );
      response.setHeader("allow", "PATCH");
      sendControlError(
        response,
        405,
        "autodev_control_api_method_not_allowed",
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
      auditRejectedRequest(
        request,
        method,
        pathname,
        "method_not_allowed",
        actor
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
  const providerOnlyMatch = pathname.match(PROVIDER_PATH);
  if (providerOnlyMatch) {
    if (method !== "PATCH") {
      auditRejectedRequest(
        request,
        method,
        pathname,
        "method_not_allowed",
        actor
      );
      return true;
    }
    await patchProviderEnabled(request, response, actor, providerOnlyMatch[1]!);
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
      agentMatch[1]!.toLowerCase()
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
