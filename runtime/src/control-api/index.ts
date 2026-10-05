import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  type GithubActionsRuntimeStatus,
  type GithubWorkflowDefinition,
  type GithubWorkflowRun,
  type GithubWorkflowState,
  LOCAL_CONTROL_API_ACTOR,
  type ProviderRole,
  type ToolCatalogItem
} from "@simulatorlife/autodev-core";
import {
  ConfigRepository,
  EvaluationRepository,
  GithubActionsAdapter,
  GithubActionsApiError,
  type GithubActionsRuntimeSnapshot,
  type GithubApiWorkflow,
  GithubWorkflowRepository,
  RuleSyncRepository
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

import { errorBody, ROUTER_INSTANCE_ID, sendJson } from "../router/proxy.ts";
import { getDefaultExecutionContract } from "../router/subagents.ts";
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

const PROVIDER_ROLE_PATH =
  /^\/control\/providers\/([a-zA-Z0-9._-]+)\/roles\/(orchestrator|subagent)$/u;
const AGENT_DETAIL_PATH = /^\/control\/agents\/([a-zA-Z0-9._-]+)$/u;
const PROMPT_DETAIL_PATH = /^\/control\/prompts\/([a-zA-Z0-9._-]+)$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const CONTROL_API_COLLATOR = new Intl.Collator();
const EXECUTION_CONTRACT_SOURCE = "execution-contract" as const;
const MD_EXTENSION_PATTERN = /\.md$/u;
const CONTROL_VARY_HEADER = "Authorization, X-AutoDev-Actor";
const GITHUB_CONTROL_API_SCHEMA = "autodev-control-github-v1";
const GITHUB_WORKFLOW_YAML_SOURCE = ".github/workflows";

export type ControlApiRole = "viewer" | "operator";
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
}): void {
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
    changes: record.changes
  };
  if (record.reason) event.reason = record.reason;
  writeErrorLine(JSON.stringify(event));
  recordMutationTelemetry(record);
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

function providersView(): Record<string, unknown> {
  const names = Array.from(
    new Set([
      ...Object.keys(ROUTING_POLICY.config.providers ?? {}),
      ...ROUTES.map((route) => route.provider)
    ])
  ).sort(CONTROL_API_COLLATOR.compare);
  const providers = names.map((provider) => ({
    id: provider,
    roles: {
      orchestrator: {
        enabled: ROUTING_POLICY.isProviderEnabledForRole(
          provider,
          "orchestrator"
        ),
        mutable: true
      },
      subagent: {
        enabled: ROUTING_POLICY.isProviderEnabledForRole(provider, "subagent"),
        mutable: true
      }
    }
  }));
  const runtime = ROUTING_POLICY.runtimeState();
  return {
    schema: "autodev-control-providers-v1",
    providers,
    disabledOrchestratorProviders: runtime.disabledOrchestratorProviders,
    disabledSubagentProviders: runtime.disabledSubagentProviders
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

function mcpsView(): Record<string, unknown> {
  const state = new RuleSyncRepository(DEFAULT_REPO_ROOT).loadMcpState();
  if (state.valid !== true) {
    return {
      schema: "autodev-control-mcps-v1",
      source: state.source,
      readOnly: true,
      valid: state.valid,
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
    servers: [...declared, ...unbackedRoleExposures].sort((left, right) =>
      CONTROL_API_COLLATOR.compare(left.name, right.name)
    )
  };
}

interface ToolCatalogDraft {
  readonly name: string;
  readonly source: ToolCatalogItem["source"];
  readonly server?: string;
  readonly exposedRoles: Set<string>;
}

function addToolToCatalog(
  catalog: Map<string, ToolCatalogDraft>,
  input: {
    name: string;
    source: ToolCatalogItem["source"];
    role: string;
    server?: string;
  }
): void {
  if (!input.name.trim()) return;
  const key = `${input.source}\u0000${input.server ?? ""}\u0000${input.name}`;
  let item = catalog.get(key);
  if (!item) {
    item = {
      name: input.name,
      source: input.source,
      ...(input.server ? { server: input.server } : {}),
      exposedRoles: new Set<string>()
    };
    catalog.set(key, item);
  }
  item.exposedRoles.add(input.role);
}

function addNativeResearchTools(
  catalog: Map<string, ToolCatalogDraft>,
  role: string,
  contract: { webResearch?: { search?: boolean; fetch?: boolean } }
): void {
  if (contract.webResearch?.search === true) {
    addToolToCatalog(catalog, {
      name: WEB_SEARCH_TOOL,
      source: "native",
      role
    });
  }
  if (contract.webResearch?.fetch === true) {
    addToolToCatalog(catalog, {
      name: WEB_FETCH_TOOL,
      source: "native",
      role
    });
  }
}

function addMcpTools(
  catalog: Map<string, ToolCatalogDraft>,
  role: string,
  mcpTools: unknown
): void {
  if (!mcpTools || typeof mcpTools !== "object" || Array.isArray(mcpTools))
    return;
  for (const [server, names] of Object.entries(mcpTools)) {
    if (!Array.isArray(names)) continue;
    const source: ToolCatalogItem["source"] =
      server === "codex_app" ? "plugin" : "mcp";
    for (const name of names) {
      if (typeof name !== "string") continue;
      addToolToCatalog(catalog, { name, source, role, server });
    }
  }
}

function toolCatalogItems(
  catalog: Map<string, ToolCatalogDraft>
): ToolCatalogItem[] {
  return Array.from(catalog.values())
    .map((item) => ({
      name: item.name,
      source: item.source,
      ...(item.server ? { server: item.server } : {}),
      exposedRoles: Array.from(item.exposedRoles).sort(
        CONTROL_API_COLLATOR.compare
      )
    }))
    .sort((left, right) =>
      CONTROL_API_COLLATOR.compare(
        `${left.source}:${left.server ?? ""}:${left.name}`,
        `${right.source}:${right.server ?? ""}:${right.name}`
      )
    );
}

function toolsView(): Record<string, unknown> {
  const catalog = new Map<string, ToolCatalogDraft>();
  const roles = Object.entries(getDefaultExecutionContract().roles ?? {});
  if (roles.length === 0) {
    return {
      schema: "autodev-control-tools-v1",
      source: EXECUTION_CONTRACT_SOURCE,
      readOnly: true,
      coverage: "unknown",
      totalTools: null,
      tools: []
    };
  }

  for (const [role, contract] of roles) {
    addNativeResearchTools(catalog, role, contract);
    addMcpTools(catalog, role, contract.mcpTools);
  }

  const tools = toolCatalogItems(catalog);
  return {
    schema: "autodev-control-tools-v1",
    source: EXECUTION_CONTRACT_SOURCE,
    readOnly: true,
    coverage: "partial",
    totalTools: tools.length,
    tools
  };
}

function skillsView(): Record<string, unknown> {
  return {
    schema: "autodev-control-skills-v1",
    source: EXECUTION_CONTRACT_SOURCE,
    readOnly: true,
    skills: configuredRoleExposure("skills")
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
// One process-wide adapter, so its ETag cache carries across Console views.
let defaultGithubActionsAdapter: GithubActionsAdapter | null = null;

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
    (defaultGithubActionsAdapter ??= new GithubActionsAdapter());

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
  const read = await new EvaluationRepository().listEvaluations();
  const base = {
    schema: "autodev-control-evaluations-v1",
    source: "openlit_evaluation",
    readOnly: true
  };
  return read.status === "available"
    ? {
        ...base,
        status: "available",
        message: null,
        totalEvaluations: read.evaluations.length,
        evaluations: read.evaluations
      }
    : {
        ...base,
        status: "unavailable",
        message: read.message,
        totalEvaluations: null,
        evaluations: []
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
    schema: "autodev-control-agent-detail-v1",
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
    systemPrompt
  };
}

function modelsView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const catalogPath = path.join(
    repositoryRoot,
    "config",
    "catalogs",
    "codex-model-catalog.json"
  );
  let models: unknown[] = [];
  if (existsSync(catalogPath)) {
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as {
        models?: unknown[];
      };
      if (Array.isArray(parsed.models)) {
        models = parsed.models;
      }
    } catch {
      // Ignore catalog parse failure
    }
  }
  return {
    schema: "autodev-control-models-v1",
    source: "codex-model-catalog.json",
    readOnly: true,
    totalModels: models.length,
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
    hooks
  };
}

function permissionsView(
  _repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const roles = getDefaultExecutionContract().roles ?? {};
  const rolePermissions: Record<string, unknown> = {};
  for (const [role, raw] of Object.entries(roles)) {
    const isReadOnly = Boolean((raw as Record<string, unknown>)?.readOnly);
    rolePermissions[role] = {
      readOnly: isReadOnly,
      sandbox: isReadOnly ? "read-only" : "workspace-write",
      networkAccess: true,
      approvals: "never"
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
  const commandAssets = new RuleSyncRepository(repositoryRoot).loadCommands();
  const commands = commandAssets.map((command) => ({
    name: command.name,
    path: command.path,
    description: command.description ?? `RuleSync command ${command.name}`
  }));
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
    schema: "autodev-control-prompts-v1",
    source: "rulesync",
    readOnly: true,
    totalCommands: commands.length,
    commands,
    rolePrompts
  };
}

function promptDetailView(
  name: string,
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> | null {
  const commandAssets = new RuleSyncRepository(repositoryRoot).loadCommands();
  const command = commandAssets.find((entry) => entry.name === name);
  if (command) {
    return {
      schema: "autodev-control-prompt-detail-v1",
      name,
      type: "command",
      source: command.path,
      content: command.content ?? ""
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
      return {
        schema: "autodev-control-prompt-detail-v1",
        name,
        type: "role",
        source: `agents/prompts/roles/${name}.md`,
        content
      };
    } catch {
      return null;
    }
  }
  return null;
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

async function persistProviderRole(): Promise<void> {
  const persisted = await getDefaultPersistenceManager().persistNow();
  if (!persisted) throw new Error("Provider policy persistence failed.");
}

async function patchProviderRole(
  request: IncomingMessage,
  response: ServerResponse,
  actor: ControlApiActor,
  providerInput: string,
  role: ProviderRole
): Promise<void> {
  const resource = providerInput + "/roles/" + role;
  if (actor.role !== "operator") {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome: "denied",
      changes: null,
      reason: "viewer_cannot_mutate"
    });
    sendControlError(
      response,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to change provider role state."
    );
    return;
  }

  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
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
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendControlError(
      response,
      400,
      "autodev_control_api_bad_body",
      "Provider role body must contain only a boolean enabled field."
    );
    return;
  }

  const provider = providerInput.toLowerCase();
  if (
    !Object.hasOwn(ROUTING_POLICY.config.providers ?? {}, provider) &&
    !ROUTES.some((route) => route.provider === provider)
  ) {
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome: "error",
      changes: { enabled: body.enabled },
      reason: "unknown_provider"
    });
    sendControlError(
      response,
      404,
      "autodev_control_api_unknown_provider",
      "Unknown provider."
    );
    return;
  }

  const previous = ROUTING_POLICY.isProviderEnabledForRole(provider, role);
  try {
    ROUTING_POLICY.setProviderEnabledForRole(provider, role, body.enabled);
    await persistProviderRole();
  } catch {
    try {
      ROUTING_POLICY.setProviderEnabledForRole(provider, role, previous);
    } catch {
      // Preserve the original failure; the audit record below captures it.
    }
    auditMutation({
      actor: actor.actor,
      actorVerified: true,
      role: actor.role,
      action: "patch_provider_role",
      resource,
      outcome: "error",
      changes: { enabled: body.enabled, previous },
      reason: "persistence_failed"
    });
    sendControlError(
      response,
      500,
      "autodev_control_api_persistence_failed",
      "Provider role change could not be persisted."
    );
    return;
  }

  auditMutation({
    actor: actor.actor,
    actorVerified: true,
    role: actor.role,
    action: "patch_provider_role",
    resource,
    outcome: "ok",
    changes: { enabled: body.enabled, previous }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-control-provider-role-v1",
      provider,
      role,
      enabled: body.enabled,
      previous,
      actor: actor.actor
    },
    {
      "cache-control": "no-store",
      vary: CONTROL_VARY_HEADER
    }
  );
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

const READ_ONLY_COLLECTIONS: ReadonlyMap<
  string,
  (
    actor: ControlApiActor
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
> = new Map<
  string,
  (
    actor: ControlApiActor
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
>([
  [CONTROL_API_PATHS.agents, () => agentsView()],
  [CONTROL_API_PATHS.providers, () => providersView()],
  [CONTROL_API_PATHS.models, () => modelsView()],
  [CONTROL_API_PATHS.mcps, () => mcpsView()],
  [CONTROL_API_PATHS.tools, () => toolsView()],
  [CONTROL_API_PATHS.skills, () => skillsView()],
  [CONTROL_API_PATHS.hooks, () => hooksView()],
  [CONTROL_API_PATHS.permissions, () => permissionsView()],
  [CONTROL_API_PATHS.prompts, () => promptsView()],
  [CONTROL_API_PATHS.workspaces, () => workspacesView()],
  [CONTROL_API_PATHS.routing, () => routingView(Date.now())],
  [CONTROL_API_PATHS.runtime, () => runtimeView(Date.now())],
  [CONTROL_API_PATHS.evaluations, () => evaluationsView()],
  [CONTROL_API_PATHS.github, () => githubWorkflowsView(DEFAULT_REPO_ROOT)]
]);

async function readOnlyCollection(
  pathname: string,
  method: string,
  response: ServerResponse,
  actor: ControlApiActor
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
  const body = await renderCollection(actor);
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

export async function handleControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
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
  const promptMatch = pathname.match(PROMPT_DETAIL_PATH);
  if (promptMatch)
    return readOnlyDetailRoute(
      request,
      response,
      actor,
      method,
      pathname,
      promptMatch[1]!,
      PROMPT_DETAIL_ROUTE
    );
  if (await readOnlyCollection(pathname, method, response, actor)) return true;
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
