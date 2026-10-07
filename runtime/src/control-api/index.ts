import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  buildReconciliationView,
  type ControlApiProviderHealth,
  type GithubActionsRuntimeStatus,
  type GithubWorkflowDefinition,
  type GithubWorkflowRun,
  type GithubWorkflowState,
  LOCAL_CONTROL_API_ACTOR,
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
  reconcileDiffSummary,
  reconcileDiffWithIdentifier,
  RuleSyncCommandConflictError,
  RuleSyncCommandHistoryUnavailableError,
  RuleSyncCommandValidationError,
  RuleSyncRepository,
  ToolCatalogAdapter
} from "@simulatorlife/autodev-data";
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

import { materializeCommands } from "../platform/install-materializer.ts";
import { errorBody, ROUTER_INSTANCE_ID, sendJson } from "../router/proxy.ts";
import {
  executionContractFile,
  getDefaultExecutionContract,
  reloadExecutionContract
} from "../router/subagents.ts";
import { routerTelemetryTracer } from "../router/telemetry.ts";
import { readControlApiJsonObject } from "./body.ts";
import { handleMemoryControlApiRequest } from "./memory.ts";

export const CONTROL_API_BASE = "/control";
export const CONTROL_API_PATHS = {
  agents: "/control/agents",
  providers: "/control/providers",
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
  github: "/control/github"
} as const;

const PROVIDER_ROLE_PATH = new RegExp(
  `^/control/providers/([a-zA-Z0-9._-]+)/roles/(${PROVIDER_ROLES.join("|")})$`,
  "u"
);
const PROVIDER_LIMITS_PATH =
  /^\/control\/providers\/([a-zA-Z0-9._-]+)\/limits$/u;
const PROVIDER_PATH = /^\/control\/providers\/([a-zA-Z0-9._-]+)$/u;

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
const SKILL_DETAIL_PATH = /^\/control\/skills\/([a-zA-Z0-9._-]+)$/u;

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
}

export interface ControlApiActor {
  actor: string;
  role: ControlApiRole;
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

let providerHealthSource: ControlApiProviderHealthSource | null = null;

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

function providersView(now: number): Record<string, unknown> {
  const names = Array.from(
    new Set([
      ...Object.keys(ROUTING_POLICY.config.providers ?? {}),
      ...ROUTES.map((route) => route.provider)
    ])
  ).sort(CONTROL_API_COLLATOR.compare);
  const reasoningEffort = ROUTING_POLICY.config.orchestrator.reasoningEffort;
  const health = providerHealthSource?.(now) ?? null;
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
    return {
      id: provider,
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
      roles: Object.fromEntries(
        PROVIDER_ROLES.map((role) => [
          role,
          {
            // An unobserved assignment is reported as enabled rather than as
            // a disabled role: a provider nobody has touched must keep routing,
            // and "disabled" is a decision the operator makes.
            priority: disabled
              ? "disabled"
              : (assignments[role]?.priority ?? 1),
            model: assignments[role]?.model ?? null,
            // A globally disabled provider's roles cannot be edited until it
            // is enabled again, but their values are preserved.
            mutable: !disabled,
            convergence: providerRoleConvergence(provider, role)
          }
        ])
      ),
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
  };
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
  const unbackedRoleExposures = exposures
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
  };
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
    };
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
  };
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
  };
}

function runtimeView(now: number): Record<string, unknown> {
  const runtime = getDefaultRouterLifecycle();
  return {
    schema: "autodev-control-runtime-v1",
    routerInstanceId: ROUTER_INSTANCE_ID,
    lifecycle: runtime.getLifecycleStatus(),
    concurrency: getDefaultConcurrencyManager().concurrencyStatus(now),
    inFlightRequestCount: runtime.activeRequestCount
  };
}

const DEFAULT_REPO_ROOT = resolveRuntimeSourceRoot(
  import.meta.dirname,
  process.env.AUTODEV_REPO_ROOT
);

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
  };
}

let githubActionsAdapterOverride: GithubActionsAdapter | null = null;

export function setGithubActionsAdapterForTests(
  adapter: GithubActionsAdapter | null
): void {
  githubActionsAdapterOverride = adapter;
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
      readonly token: string;
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
  const token = options.token ?? process.env.AUTODEV_GITHUB_TOKEN;
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

  if (!token || token.trim().length === 0) {
    return unavailable(
      "unavailable",
      "AUTODEV_GITHUB_TOKEN is not configured on the server."
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
 * Runtime Control API owns authentication and validates explicit server-side
 * AUTODEV_GITHUB_TOKEN and configured AUTODEV_GITHUB_REPOSITORY (or standard
 * runner GITHUB_REPOSITORY). Returns an explicit unavailable/invalid state when
 * credentials, configuration, or API are absent/invalid.
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

  try {
    const snapshot = await adapter.fetchRuntimeSnapshot(
      binding.owner,
      binding.repo,
      binding.token,
      { limit: 30 }
    );
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
    };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const isAuthFailure =
      error instanceof GithubActionsApiError &&
      (error.status === 401 || error.status === 403);

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
  const evaluations = await repository.listEvaluations();
  return {
    schema: "autodev-control-evaluations-v1",
    source: "openlit_evaluation",
    readOnly: true,
    totalEvaluations: evaluations.length,
    evaluations
  };
}

function agentsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const roles = getDefaultExecutionContract().roles ?? {};
  const names = Object.keys(roles).sort(CONTROL_API_COLLATOR.compare);
  const agents = names.map((role) => {
    const raw = roles[role] as Record<string, unknown> | undefined;
    const isOrchestrator = role === "orchestrator";
    const kind =
      typeof raw?.kind === "string"
        ? raw.kind
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
      primaryModel: isOrchestrator
        ? "autodev/orchestrator"
        : "autodev/subagent",
      allowedProviders,
      hasPrompt: existsSync(promptPath),
      mcps,
      skills
    };
  });
  return {
    schema: "autodev-control-agents-v1",
    source: EXECUTION_CONTRACT_SOURCE,
    readOnly: true,
    totalAgents: agents.length,
    agents
  };
}

function agentDetailView(
  role: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const roles = getDefaultExecutionContract().roles ?? {};
  const raw = roles[role] as Record<string, unknown> | undefined;
  if (!raw) return null;
  const isOrchestrator = role === "orchestrator";
  const kind =
    typeof raw?.kind === "string"
      ? raw.kind
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
    schema: "autodev-control-agent-detail-v2",
    id: role,
    role,
    kind,
    readOnly,
    configured: true,
    valid: null,
    status: "configured",
    convergence: "not-observed",
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
  };
}

/** Display names from the Codex model catalog; absent names stay null. */
function modelCatalogDisplayNames(repositoryRoot: string): Map<string, string> {
  const catalogPath = path.join(
    repositoryRoot,
    "config",
    "catalogs",
    "codex-model-catalog.json"
  );
  const names = new Map<string, string>();
  if (!existsSync(catalogPath)) return names;
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models?: unknown;
    };
    if (!Array.isArray(parsed.models)) return names;
    for (const entry of parsed.models as unknown[]) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { slug?: unknown }).slug === "string" &&
        typeof (entry as { display_name?: unknown }).display_name === "string"
      ) {
        const { slug, display_name } = entry as {
          slug: string;
          display_name: string;
        };
        names.set(slug, display_name);
      }
    }
  } catch {
    // An unreadable catalog leaves display names unobserved.
  }
  return names;
}

function modelsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const displayNames = modelCatalogDisplayNames(repositoryRoot);
  const models = ROUTING_POLICY.configuredModels()
    .map((entry) => ({
      id: entry.model,
      provider: entry.provider,
      tiers: entry.tiers,
      displayName: displayNames.get(entry.model) ?? null,
      enablement: {
        enabled: ROUTING_POLICY.isModelEnabled(entry.model),
        mutable: true,
        convergence: modelConvergence(entry.model)
      }
    }))
    .sort(
      (left, right) =>
        CONTROL_API_COLLATOR.compare(left.provider, right.provider) ||
        CONTROL_API_COLLATOR.compare(left.id, right.id)
    );
  return {
    schema: "autodev-control-models-v2",
    source: path.basename(ROUTING_POLICY.configFile),
    models
  };
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
  };
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
  const rolePermissions: Record<string, unknown> = {};
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
  };
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
  };
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
  const commandState = new RuleSyncRepository(repositoryRoot).loadCommands();
  const command =
    commandState.valid === true
      ? commandState.commands.find((entry) => entry.name === name)
      : undefined;
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
      };
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
  };
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
  };
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
function reconciliationOf(
  body: Record<string, unknown>
): EnablementReconciliation | null {
  const reconciliation = body.reconciliation;
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
interface EnablementMutation {
  readonly action: string;
  readonly resource: string;
  readonly subject: string;
  readonly known: boolean;
  readonly unknownReason: string;
  readonly unknownCode: string;
  readonly unknownMessage: string;
  readonly current: () => boolean;
  readonly apply: (enabled: boolean) => void;
  readonly result: (
    enabled: boolean,
    previous: boolean
  ) => Record<string, unknown>;
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
  if (Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      `${mutation.subject.charAt(0).toUpperCase()}${mutation.subject.slice(1)} body must contain only a boolean enabled field.`
    );
    return;
  }
  const enabled = body.enabled;

  if (!mutation.known) {
    audit("error", { enabled }, mutation.unknownReason);
    sendControlError(
      response,
      404,
      mutation.unknownCode,
      mutation.unknownMessage
    );
    return;
  }

  const previous = mutation.current();
  try {
    mutation.apply(enabled);
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

  // Build the response body first: it owns the reconciliation evidence, and
  // the audit record must carry the same generations the operator sees in the
  // response. Auditing separately would let the two drift.
  const result = mutation.result(enabled, previous);
  audit("ok", { enabled, previous }, undefined, reconciliationOf(result));
  sendJson(
    response,
    200,
    { ...result, actor: actor.actor },
    {
      "cache-control": "no-store",
      vary: CONTROL_VARY_HEADER
    }
  );
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
  const priorityIsValid =
    priority === 1 ||
    priority === 2 ||
    priority === 3 ||
    priority === "disabled";
  const modelIsValid =
    model === null ||
    (typeof model === "string" && ROUTING_POLICY.isConfiguredModel(model));
  if (
    Object.keys(body).some((key) => key !== "priority" && key !== "model") ||
    !priorityIsValid ||
    !modelIsValid
  ) {
    audit("error", null, "invalid_body");
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      'Provider role body must carry a priority of 1, 2, 3 or "disabled", and a model that is either null or a model this provider is configured for.'
    );
    return;
  }
  if (!known) {
    audit("error", { priority, model }, "unknown_provider");
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
    audit("denied", { priority, model }, "provider_disabled");
    sendControlError(
      response,
      409,
      "autodev_control_api_provider_disabled",
      "This provider is disabled. Enable it before changing its roles."
    );
    return;
  }

  const next: ProviderRoleAssignment = { priority, model };
  // An unobserved assignment is reported as null on the wire: JSON carries no
  // undefined, and "there was no assignment" must not be reported as an empty
  // object, which would read as a role whose model was cleared.
  const previous = ROUTING_POLICY.assignmentFor(provider, role) ?? null;
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
    audit("error", { priority, model, previous }, "persistence_failed");
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
    observed?.priority === priority && observed?.model === model
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
  audit("ok", { priority, model, previous }, undefined, auditReconciliation);
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-provider-role-v3",
      provider,
      role,
      priority,
      model,
      previous,
      actor: actor.actor,
      reconciliation
    },
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
    },
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
      agentLimits: applied,
      previous,
      actor: actor.actor,
      reconciliation: reconciliation.view
    },
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

function patchModel(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  model: string
): Promise<void> {
  return patchEnablement(request, response, actor, {
    action: "patch_model",
    resource: model,
    subject: "model",
    known: ROUTING_POLICY.isConfiguredModel(model),
    unknownReason: "unknown_model",
    unknownCode: "autodev_control_api_unknown_model",
    unknownMessage: "Unknown model.",
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
) => Record<string, unknown> | Promise<Record<string, unknown>>;

const READ_ONLY_COLLECTIONS: ReadonlyMap<string, ReadOnlyCollectionRenderer> =
  new Map<string, ReadOnlyCollectionRenderer>([
    [CONTROL_API_PATHS.agents, () => agentsView()],
    [CONTROL_API_PATHS.providers, () => providersView(Date.now())],
    [CONTROL_API_PATHS.models, () => modelsView()],
    [CONTROL_API_PATHS.mcps, () => mcpsView()],
    [
      CONTROL_API_PATHS.tools,
      () => toolsView() as unknown as Record<string, unknown>
    ],
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
  let body: Record<string, unknown>;
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
    },
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
  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "assign_skill_roles",
    resource,
    outcome: "ok",
    changes: { name, roles: assigned.roles, revision: assigned.revision },
    desiredGeneration: assigned.revision,
    observedGeneration:
      observed !== undefined &&
      assigned.roles.join("\n") === observed.roles.join("\n")
        ? assigned.revision
        : null
  });
  sendJson(response, 200, {
    schema: "autodev-control-skill-assignment-v1",
    skill: assigned.skill,
    roles: observed?.roles ?? [],
    revision: assigned.revision
  });
}

async function skillDetailRoute(
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
  // PATCH only. There was a GET here answering `autodev-control-skill-detail-v1`
  // for one skill, and nothing consumed it: no Console view reads a skill by id,
  // the documented read is the `/control/skills` collection, and the response
  // had no contract declared in Core at all. Every field it returned is already
  // on the collection row, so keeping it was a second way to read one thing.
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
    "Skill routes accept PATCH. Read a skill from /control/skills."
  );
  return true;
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

export async function handleControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: ControlApiRequestOptions = {}
): Promise<boolean> {
  if (!pathname.startsWith(CONTROL_API_BASE + "/")) return false;
  const method = request.method ?? "GET";
  const actor = authorizeRequest(request, response, method, pathname);
  if (!actor) return true;
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
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      agentMatch[1]!,
      AGENT_DETAIL_ROUTE
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
  const skillMatch = pathname.match(SKILL_DETAIL_PATH);
  if (skillMatch)
    return skillDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      skillMatch[1]!,
      options
    );
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
