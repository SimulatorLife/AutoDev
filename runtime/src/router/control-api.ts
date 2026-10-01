import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SpanStatusCode } from "@opentelemetry/api";
import {
  LOCAL_CONTROL_API_ACTOR,
  type ProviderRole
} from "@simulatorlife/autodev-core";
import { RuleSyncRepository } from "@simulatorlife/autodev-data";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { getDefaultRouterLifecycle } from "@simulatorlife/autodev-runtime/router/lifecycle";
import { getDefaultPersistenceManager } from "@simulatorlife/autodev-runtime/router/persistence";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { readControlApiJsonObject } from "./control-api-body.ts";
import { handleMemoryControlApiRequest } from "./memory-control-api.ts";
import { errorBody, ROUTER_INSTANCE_ID, sendJson } from "./proxy.ts";
import { ROUTES, ROUTING_POLICY } from "@simulatorlife/autodev-runtime/router/routing";
import { getDefaultExecutionContract } from "./subagents.ts";
import { routerTelemetryTracer } from "./telemetry.ts";

export const CONTROL_API_BASE = "/control";
export const CONTROL_API_PATHS = {
  agents: "/control/agents",
  providers: "/control/providers",
  models: "/control/models",
  mcps: "/control/mcps",
  skills: "/control/skills",
  hooks: "/control/hooks",
  permissions: "/control/permissions",
  prompts: "/control/prompts",
  workspaces: "/control/workspaces",
  routing: "/control/routing",
  runtime: "/control/runtime",
  memory: "/control/memory"
} as const;

const PROVIDER_ROLE_PATH =
  /^\/control\/providers\/([a-zA-Z0-9._-]+)\/roles\/(orchestrator|subagent)$/u;
const AGENT_DETAIL_PATH = /^\/control\/agents\/([a-zA-Z0-9._-]+)$/u;
const PROMPT_DETAIL_PATH = /^\/control\/prompts\/([a-zA-Z0-9._-]+)$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const CONTROL_API_COLLATOR = new Intl.Collator();
const MD_EXTENSION_PATTERN = /\.md$/u;
const CONTROL_VARY_HEADER = "Authorization, X-AutoDev-Actor";

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
  return {
    schema: "autodev-control-mcps-v1",
    source: "execution-contract",
    readOnly: true,
    servers: configuredRoleExposure("mcp")
  };
}

function skillsView(): Record<string, unknown> {
  return {
    schema: "autodev-control-skills-v1",
    source: "execution-contract",
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

export interface ControlWorkspaceEntry {
  readonly name: string;
  readonly baseBranch: string;
  readonly weight: number;
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function loadConfiguredWorkspaces(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): ControlWorkspaceEntry[] {
  const weightsPath = path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "weights.json"
  );
  if (!existsSync(weightsPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(weightsPath, "utf8")) as {
      repositories?: ControlWorkspaceEntry[];
    };
    return (raw.repositories ?? []).map((repo) => ({
      name: repo.name,
      baseBranch: repo.baseBranch ?? "main",
      weight: repo.weight ?? 0
    }));
  } catch {
    return [];
  }
}

function workspacesView(
  repositoryRoot: string = DEFAULT_REPO_ROOT
): Record<string, unknown> {
  const workspaces = loadConfiguredWorkspaces(repositoryRoot);
  return {
    schema: "autodev-control-workspaces-v1",
    source: "weights.json",
    readOnly: true,
    totalWorkspaces: workspaces.length,
    workspaces
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
    source: "execution-contract",
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
  const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
  const commands: Array<{ name: string; path: string; description: string }> =
    [];
  if (existsSync(commandsDir)) {
    try {
      const files = readdirSync(commandsDir);
      for (const file of files
        .filter((f) => f.endsWith(".md"))
        .sort(CONTROL_API_COLLATOR.compare)) {
        const name = file.replace(MD_EXTENSION_PATTERN, "");
        commands.push({
          name,
          path: `.rulesync/commands/${file}`,
          description: `RuleSync command ${name}`
        });
      }
    } catch {
      // Ignore unreadable commands directory
    }
  }
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
  const commandPath = path.join(
    repositoryRoot,
    ".rulesync",
    "commands",
    `${name}.md`
  );
  if (existsSync(commandPath)) {
    try {
      const content = readFileSync(commandPath, "utf8");
      return {
        schema: "autodev-control-prompt-detail-v1",
        name,
        type: "command",
        source: `.rulesync/commands/${name}.md`,
        content
      };
    } catch {
      return null;
    }
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
  () => Record<string, unknown>
> = new Map([
  [CONTROL_API_PATHS.agents, agentsView],
  [CONTROL_API_PATHS.providers, providersView],
  [CONTROL_API_PATHS.models, modelsView],
  [CONTROL_API_PATHS.mcps, mcpsView],
  [CONTROL_API_PATHS.skills, skillsView],
  [CONTROL_API_PATHS.hooks, hooksView],
  [CONTROL_API_PATHS.permissions, permissionsView],
  [CONTROL_API_PATHS.prompts, promptsView],
  [CONTROL_API_PATHS.workspaces, workspacesView],
  [CONTROL_API_PATHS.routing, () => routingView(Date.now())],
  [CONTROL_API_PATHS.runtime, () => runtimeView(Date.now())]
]);

function readOnlyCollection(
  pathname: string,
  method: string,
  response: ServerResponse,
  actor: ControlApiActor
): boolean {
  const renderCollection = READ_ONLY_COLLECTIONS.get(pathname);
  if (!renderCollection) return false;
  const body = renderCollection();
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
  if (readOnlyCollection(pathname, method, response, actor)) return true;
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
