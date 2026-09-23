import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExecutionContract } from "../shared/execution-contract.ts";
import {
  type AgentActivityTracker,
  PROCESS_FALLBACK_SESSION_KEY
} from "./concurrency.ts";

// Normalise the persisted `settled` counter block. The router records it
// as `{ success, failure }`; persistence may hand back an object whose
// fields have lost their numeric type, so this helper recovers the shape
// without using `any`.
function normalizeSettledTelemetry(value: unknown): {
  success: number;
  failure: number;
} {
  if (!value || typeof value !== "object") return { success: 0, failure: 0 };
  const counters = value as { success?: unknown; failure?: unknown };
  return {
    success: Number(counters.success) || 0,
    failure: Number(counters.failure) || 0
  };
}

export const SUBAGENT_MECHANISMS = Object.freeze([
  "router_alias",
  "bridge_native"
] as const);
export type SubagentMechanism = (typeof SUBAGENT_MECHANISMS)[number];

export const MAX_RECENT_SUBAGENT_SPAWNS = 50;
export const MAX_TRACKED_ORCHESTRATOR_SESSIONS = 256;
export const MAX_TRACKED_WORKSPACE_SESSIONS = 256;
export const MAX_TRACKED_BRIDGE_REQUESTS = 256;
export const MAX_TRACKED_BRIDGE_SESSIONS = 256;
export const MAX_TRACKED_BRIDGE_SUBAGENTS = 512;
export const MAX_RECENT_SPAWN_FAILURES = 50;

export const UNATTRIBUTED_SUBAGENT_ROLE = "unattributed-subagent";
export const INHERITED_CHILD_MODELS = Object.freeze(
  new Set(["inherit", "self", "default", "parent"])
);

export const SESSION_ID_HEADER = "x-autodev-session-id";
export const SESSION_SCOPE_HEADER = "x-autodev-session-scope";
export const REQUEST_ID_HEADER = "x-autodev-request-id";
export const SUBAGENT_SPAWN_TOOLS_HEADER = "x-autodev-subagent-spawn-tools";
export const AGENT_EVENTS_URL_HEADER = "x-autodev-agent-events-url";
export const AGENT_EVENTS_PATH = "/v1/agent-events";
export const DEFAULT_AGENT_EVENTS_URL = `http://127.0.0.1:4100${AGENT_EVENTS_PATH}`;

export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const SANDBOX_MODE_HEADER = "x-autodev-sandbox-mode";
/**
 * Optional header a router-to-bridge forward may carry to give the bridge the
 * Skill.md body the orchestrator injected for its own turn. Bridges hand it
 * to spawned children whose `SpawnChild.selectedSkillContext` is otherwise
 * empty so the child re-reads the same skill instead of inferring it from
 * cwd + filename. The router only sets this on role-routed requests; it never
 * ships on the orchestrator path.
 */
export const SKILL_CONTEXT_HEADER = "x-autodev-skill-context";
/**
 * Codex Desktop session id used by /v1/agent-events ingest as the secondary
 * correlation key when a bridge did not issue a router request id. The hook
 * `skill-read-telemetry` posts this so the router can attribute SKILL.md
 * reads from child threads that never travelled through `/v1/responses`.
 */
export const CODEX_SESSION_HEADER = "x-autodev-codex-session";

export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";
export const FORWARDED_REQUEST_HEADERS = Object.freeze([
  "x-codex-turn-metadata"
]);

// Strip ASCII control characters from a metric label without using a
// regular expression. `eslint-plugin-regexp/no-control-regex` rejects raw
// control characters inside regex character classes, so we walk the string
// once with `charCodeAt`.
function stripAsciiControlCharacters(value: string): string {
  let stripped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) continue;
    stripped += value[index];
  }
  return stripped;
}

export function safeMetricLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return (
    stripAsciiControlCharacters(value.trim()).slice(0, 100) || fallback
  );
}

export function bumpCount(
  collection: Record<string, number>,
  key: string,
  amount: number
): void {
  collection[key] = (collection[key] ?? 0) + amount;
}

export function bridgeSubagentKey(requestId: string, childId: string): string {
  return `${requestId}\0${childId}`;
}

export interface ReportedChild {
  id: string;
  model: string | null;
}

let anonymousChildSequence = 0;

export function reportedChildren(event: {
  children?: unknown;
  count?: unknown;
}): ReportedChild[] {
  const listed = (Array.isArray(event.children) ? event.children : []).filter(
    (child): child is Record<string, unknown> =>
      Boolean(child) && typeof child === "object"
  );
  const children: ReportedChild[] = listed.map((child) => ({
    id:
      typeof child.id === "string" && child.id.trim()
        ? safeMetricLabel(child.id)
        : "",
    model:
      typeof child.model === "string" && child.model.trim()
        ? safeMetricLabel(child.model)
        : null
  }));
  const count =
    Number.isInteger(event.count) && (event.count as number) > 0
      ? (event.count as number)
      : 1;
  while (children.length < count) {
    children.push({ id: "", model: null });
  }
  return children.map((child) => {
    if (child.id) return child;
    anonymousChildSequence += 1;
    return { ...child, id: `anon${anonymousChildSequence}` };
  });
}

export interface SubagentSpawnRecord {
  timestamp: string;
  mechanism: SubagentMechanism;
  provider: string | null;
  role: string;
  status: string;
  tool: string | null;
  requestId: string | null;
  workspace: string | null;
  count: number;
  settled: { success: number; failure: number };
}

export interface RecordSubagentSpawnInput {
  mechanism: string;
  provider?: string | null | undefined;
  role?: string | null | undefined;
  status?: string | undefined;
  tool?: string | null | undefined;
  requestId?: string | null | undefined;
  workspace?: string | null | undefined;
  count?: number | undefined;
}

export interface SubagentTelemetry {
  total: number;
  byMechanism: Record<string, number>;
  byProvider: Record<string, number>;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
  recent: SubagentSpawnRecord[];
}

export interface SubagentStatus {
  total: number;
  byMechanism: Record<string, number>;
  byProvider: Record<string, number>;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
  codexNativeSpawns: number;
  spawnCapableProviders: string[];
  recent: SubagentSpawnRecord[];
}

export interface SpawnFailureRecord {
  timestamp: string;
  requestId: string | null;
  role: string | null;
  requestedModel: string | null;
  reason: string;
}

export interface SpawnFailureTelemetry {
  total: number;
  byReason: Record<string, number>;
  recent: SpawnFailureRecord[];
}

export interface SpawnFailureStatus {
  scope: "router-admitted-child-requests";
  total: number;
  byReason: Record<string, number>;
  recent: SpawnFailureRecord[];
}

export interface BridgeRequestContext {
  /**
   * The activity subject the router tracks this request under -- the agent
   * the request belongs to. A bridge's reports about the request apply here
   * and nowhere else: the session key is shared by an orchestrator and every
   * subagent it spawns, so keying reports by it let a child overwrite its
   * orchestrator's record.
   */
  activitySubject: string;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  workspace?: string | null | undefined;
  sessionKey?: string | null | undefined;
  finished?: { outcome: string; elapsedMs: number | null } | undefined;
  [key: string]: unknown;
}

export interface OrchestratorSessionEntry {
  provider: string;
  model: string | null;
  workspace: string | null;
  requestId: string | null;
  updatedAt: number;
}

export interface BridgeSubagentUsageEntry {
  requestId: string;
  provider: string;
  model: string;
  role: string;
  workspace: string | null;
  startedAt: number;
}

export interface BridgeParentActivityEntry {
  subject: string;
  children: Set<string>;
  context: BridgeRequestContext;
  finished: { outcome: string; elapsedMs: number | null } | null;
}

export interface ProviderCapabilities {
  subagentSpawn: boolean;
  subagentSpawnTools: string[];
  normalizeItemIds: boolean;
}

export interface RoleCapabilityRequirements {
  mcp: Set<string>;
  skills: Set<string>;
  webResearch: {
    search: boolean;
    fetch: boolean;
    optionalMcp: Set<string>;
  };
}

// In-memory cache of the execution contract document. The shared contract
// type uses `[key: string]: unknown` for both providers and roles, which
// keeps unknown fields addressable without resorting to `any`.
let cachedExecutionContract: ExecutionContract | null = null;

export function getDefaultExecutionContract(): ExecutionContract {
  if (cachedExecutionContract) return cachedExecutionContract;
  const codexHome =
    process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
  const defaultContract = fileURLToPath(
    new URL("../../config/execution-contract.json", import.meta.url)
  );
  const candidates = [
    process.env.CODEX_EXECUTION_CONTRACT_FILE,
    defaultContract,
    `${codexHome}/config/execution-contract.json`
  ].filter(
    (p): p is string => typeof p === "string" && p.length > 0 && existsSync(p)
  );

  if (candidates.length > 0) {
    try {
      cachedExecutionContract = JSON.parse(
        readFileSync(candidates[0]!, "utf8")
      ) as ExecutionContract;
      return cachedExecutionContract;
    } catch {
      /* fallthrough to empty */
    }
  }
  return { roles: {}, providers: {} };
}

export function setExecutionContractForTests(
  contract: ExecutionContract | null
): void {
  cachedExecutionContract = contract;
}

export function providerCapabilities(
  provider: string,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): ProviderCapabilities {
  const subagentSpawnTools = Array.isArray(
    executionContract.providers?.[provider]?.spawnTools
  )
    ? [...executionContract.providers[provider].spawnTools]
    : [];
  // The provider delegation mode is generated alongside the role contract.
  // A route is not evidence of orchestration capability: providers without a
  // native, Codex-shim, or bridge-native path must not enter the root fallback
  // tier merely because they can serve ordinary turns.
  const delegation = executionContract.providers?.[provider]?.delegation;
  // The execution contract is the provider capability source of truth. A
  // route alone is not evidence that its orchestrator can delegate, and a
  // stale spawnTools list must not resurrect a provider explicitly marked
  // `none`.
  const subagentSpawn =
    delegation === "native" ||
    delegation === "codex-shim" ||
    delegation === "bridge-native";
  return {
    subagentSpawn,
    subagentSpawnTools,
    normalizeItemIds: true
  };
}

export function roleCapabilityRequirements(
  role: string | null | undefined,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): RoleCapabilityRequirements {
  const key =
    role === ORCHESTRATOR_AGENT_ROLE
      ? "orchestrator"
      : typeof role === "string" && role.trim()
        ? role.trim().toLowerCase()
        : "default";
  const contract =
    executionContract.roles?.[key] ?? executionContract.roles?.default ?? {};
  const webResearch =
    contract.webResearch && typeof contract.webResearch === "object"
      ? {
          search: contract.webResearch.search === true,
          fetch: contract.webResearch.fetch === true,
          optionalMcp: new Set<string>(
            Array.isArray(contract.webResearch.optionalMcp)
              ? contract.webResearch.optionalMcp
              : []
          )
        }
      : { search: false, fetch: false, optionalMcp: new Set<string>() };
  return {
    mcp: new Set<string>(Array.isArray(contract.mcp) ? contract.mcp : []),
    skills: new Set<string>(
      Array.isArray(contract.skills) ? contract.skills : []
    ),
    webResearch
  };
}

export function subagentSpawnToolsFor(
  provider: string,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): string[] {
  return providerCapabilities(provider, executionContract).subagentSpawnTools;
}

export function mcpContractForRole(
  agentRole: string | null | undefined,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): string[] {
  const requested =
    typeof agentRole === "string" && agentRole.trim()
      ? agentRole.trim().toLowerCase()
      : "default";
  const key =
    requested === ORCHESTRATOR_AGENT_ROLE ? "orchestrator" : requested;
  return Array.isArray(executionContract.roles?.[key]?.mcp)
    ? executionContract.roles[key].mcp
    : [];
}

export function bridgeTelemetryHeaders(
  route: { provider?: string | null | undefined } | null | undefined,
  requestId: string | null | undefined,
  options: {
    executionContract?: ExecutionContract;
    agentEventsUrl?: string;
  } = {}
): Record<string, string> {
  if (!requestId || !route?.provider || route.provider === "codex") return {};
  const spawnTools = subagentSpawnToolsFor(
    route.provider,
    options.executionContract
  );
  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: requestId,
    [AGENT_EVENTS_URL_HEADER]:
      options.agentEventsUrl ?? DEFAULT_AGENT_EVENTS_URL
  };
  if (spawnTools.length > 0) {
    headers[SUBAGENT_SPAWN_TOOLS_HEADER] = spawnTools.join(",");
  }
  return headers;
}

export interface SubagentRegistryOptions {
  agentActivity?: AgentActivityTracker | undefined;
  executionContract?: ExecutionContract | undefined;
  maxRecentSpawns?: number | undefined;
  maxTrackedSessions?: number | undefined;
  maxTrackedRequests?: number | undefined;
  maxTrackedSubagents?: number | undefined;
  onRecordRouterEvent?: ((event: Record<string, unknown>) => void) | undefined;
  onRecordUsageEvent?: ((event: Record<string, unknown>) => void) | undefined;
  onSchedulePersist?: (() => void) | undefined;
  onMissingProviderDiagnostic?: ((count: number) => void) | undefined;
  onMissingModelDiagnostic?: ((count: number) => void) | undefined;
  getCodexNativeSpawns?: (() => number) | undefined;
  getSpawnCapableProviders?: (() => string[]) | undefined;
}

export class SubagentRegistry {
  private readonly agentActivity?: AgentActivityTracker | undefined;
  private readonly executionContract?: ExecutionContract | undefined;
  private readonly maxRecentSpawns: number;
  private readonly maxTrackedSessions: number;
  private readonly maxTrackedRequests: number;
  private readonly maxTrackedSubagents: number;
  private readonly onRecordRouterEvent?:
    ((event: Record<string, unknown>) => void) | undefined;
  private readonly onRecordUsageEvent?:
    ((event: Record<string, unknown>) => void) | undefined;
  private readonly onSchedulePersist?: (() => void) | undefined;
  private readonly onMissingProviderDiagnostic?:
    ((count: number) => void) | undefined;
  private readonly onMissingModelDiagnostic?:
    ((count: number) => void) | undefined;
  private readonly getCodexNativeSpawns?: (() => number) | undefined;
  private readonly getSpawnCapableProviders?: (() => string[]) | undefined;

  readonly subagentTelemetry: SubagentTelemetry;
  readonly spawnFailureTelemetry: SpawnFailureTelemetry;
  private readonly orchestratorSessions = new Map<
    string,
    OrchestratorSessionEntry
  >();
  private readonly workspaceMetadataBySession = new Map<string, string>();
  private readonly bridgeRequestContext = new Map<
    string,
    BridgeRequestContext
  >();
  private readonly bridgeSessionContext = new Map<
    string,
    { requestId: string | null; context: BridgeRequestContext }
  >();
  private readonly bridgeSubagentUsage = new Map<
    string,
    BridgeSubagentUsageEntry
  >();
  private readonly bridgeParentActivity = new Map<
    string,
    BridgeParentActivityEntry
  >();

  constructor(options: SubagentRegistryOptions = {}) {
    this.agentActivity = options.agentActivity;
    this.executionContract = options.executionContract;
    this.maxRecentSpawns =
      options.maxRecentSpawns ?? MAX_RECENT_SUBAGENT_SPAWNS;
    this.maxTrackedSessions =
      options.maxTrackedSessions ?? MAX_TRACKED_ORCHESTRATOR_SESSIONS;
    this.maxTrackedRequests =
      options.maxTrackedRequests ?? MAX_TRACKED_BRIDGE_REQUESTS;
    this.maxTrackedSubagents =
      options.maxTrackedSubagents ?? MAX_TRACKED_BRIDGE_SUBAGENTS;
    this.onRecordRouterEvent = options.onRecordRouterEvent;
    this.onRecordUsageEvent = options.onRecordUsageEvent;
    this.onSchedulePersist = options.onSchedulePersist;
    this.onMissingProviderDiagnostic = options.onMissingProviderDiagnostic;
    this.onMissingModelDiagnostic = options.onMissingModelDiagnostic;
    this.getCodexNativeSpawns = options.getCodexNativeSpawns;
    this.getSpawnCapableProviders = options.getSpawnCapableProviders;

    this.subagentTelemetry = {
      total: 0,
      byMechanism: Object.fromEntries(
        SUBAGENT_MECHANISMS.map((mechanism) => [mechanism, 0])
      ),
      byProvider: {},
      byRole: {},
      byStatus: {},
      recent: []
    };

    this.spawnFailureTelemetry = {
      total: 0,
      byReason: {},
      recent: []
    };
  }

  rememberWorkspaceMetadata(
    sessionKey: string | null | undefined,
    workspacePath: string | null | undefined
  ): void {
    if (
      !sessionKey ||
      sessionKey === PROCESS_FALLBACK_SESSION_KEY ||
      !workspacePath
    )
      return;
    this.workspaceMetadataBySession.delete(sessionKey);
    this.workspaceMetadataBySession.set(
      sessionKey,
      JSON.stringify({ workspaces: { [workspacePath]: {} } })
    );
    while (this.workspaceMetadataBySession.size > this.maxTrackedSessions) {
      const oldest = this.workspaceMetadataBySession.keys().next().value;
      if (oldest !== undefined) this.workspaceMetadataBySession.delete(oldest);
    }
  }

  getWorkspaceMetadata(sessionKey: string | null | undefined): string | null {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
    return this.workspaceMetadataBySession.get(sessionKey) ?? null;
  }

  noteOrchestratorSession(
    sessionKey: string | null | undefined,
    provider: string | null | undefined,
    details: {
      model?: string | null;
      workspace?: string | null;
      requestId?: string | null;
    } = {}
  ): void {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY || !provider)
      return;
    this.orchestratorSessions.delete(sessionKey);
    this.orchestratorSessions.set(sessionKey, {
      provider,
      model: details.model ?? null,
      workspace: details.workspace ?? null,
      requestId: details.requestId ?? null,
      updatedAt: Date.now()
    });
    while (this.orchestratorSessions.size > this.maxTrackedSessions) {
      const oldest = this.orchestratorSessions.keys().next().value;
      if (oldest !== undefined) this.orchestratorSessions.delete(oldest);
    }
  }

  orchestratorProviderForSession(
    sessionKey: string | null | undefined
  ): string | null {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
    return this.orchestratorSessions.get(sessionKey)?.provider ?? null;
  }

  orchestratorSessionInfo(
    sessionKey: string | null | undefined
  ): OrchestratorSessionEntry | null {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
    const entry = this.orchestratorSessions.get(sessionKey);
    return entry ? { ...entry } : null;
  }

  hasActiveBridgeSubagentsForSession(
    sessionKey: string | null | undefined
  ): boolean {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY)
      return false;
    for (const entry of this.bridgeSubagentUsage.values()) {
      const ctx = this.bridgeRequestContext.get(entry.requestId);
      if (ctx?.sessionKey === sessionKey) return true;
    }
    return false;
  }

  noteBridgeRequest(
    requestId: string | null | undefined,
    context: BridgeRequestContext
  ): void {
    if (!requestId) return;
    this.bridgeRequestContext.delete(requestId);
    this.bridgeRequestContext.set(requestId, context);
    while (this.bridgeRequestContext.size > this.maxTrackedRequests) {
      const oldest = this.bridgeRequestContext.keys().next().value;
      if (oldest !== undefined) this.bridgeRequestContext.delete(oldest);
    }
  }

  getBridgeRequestContext(
    requestId: string | null | undefined
  ): BridgeRequestContext | null {
    if (!requestId) return null;
    return this.bridgeRequestContext.get(requestId) ?? null;
  }

  noteBridgeSession(
    sessionKey: string | null | undefined,
    context: BridgeRequestContext | null | undefined
  ): void {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return;
    const requestId =
      typeof context?.requestId === "string" ? context.requestId : null;
    const persisted: BridgeRequestContext = context
      ? { ...context }
      : { activitySubject: sessionKey };
    delete persisted.requestId;
    this.bridgeSessionContext.delete(sessionKey);
    this.bridgeSessionContext.set(sessionKey, {
      requestId,
      context: persisted
    });
    while (this.bridgeSessionContext.size > this.maxTrackedSessions) {
      const oldest = this.bridgeSessionContext.keys().next().value;
      if (oldest !== undefined) this.bridgeSessionContext.delete(oldest);
    }
  }

  lookupBridgeSessionContext(
    sessionKey: string | null | undefined
  ): BridgeRequestContext | null {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
    return this.bridgeSessionContext.get(sessionKey)?.context ?? null;
  }

  recallBridgeSessionRequestId(
    sessionKey: string | null | undefined
  ): string | null {
    if (!sessionKey || sessionKey === PROCESS_FALLBACK_SESSION_KEY) return null;
    return this.bridgeSessionContext.get(sessionKey)?.requestId ?? null;
  }

  openBridgeParentActivity(
    requestId: string,
    context: BridgeRequestContext
  ): BridgeParentActivityEntry | null {
    if (
      !requestId ||
      !context?.provider ||
      !context?.model ||
      !this.agentActivity
    )
      return null;
    let parent = this.bridgeParentActivity.get(requestId);
    if (parent) return parent;
    const subject = `bridge-parent:${requestId}`;
    this.agentActivity.beginRequest(subject, {
      requestId: subject,
      provider: context.provider,
      model: context.model,
      role: "orchestrator",
      origin: "orchestrator",
      workspace: context.workspace ?? null,
      tag: context.sessionKey ?? null
    });
    this.agentActivity.applyLifecycleEvent(subject, {
      state: "subagent_wait",
      eventId: `${subject}:subagent_wait`,
      provider: context.provider,
      model: context.model,
      role: "orchestrator",
      origin: "orchestrator",
      workspace: context.workspace ?? null
    });
    parent = { subject, children: new Set(), context, finished: null };
    this.bridgeParentActivity.set(requestId, parent);
    return parent;
  }

  closeBridgeParentActivity(requestId: string): boolean {
    const parent = this.bridgeParentActivity.get(requestId);
    // A child result can arrive before the parent turn settles. Keep the
    // synthetic parent open until the router supplies the parent's outcome;
    // otherwise a later parent failure would be reported as a success.
    if (!parent || parent.children.size > 0 || !parent.finished) return false;
    if (this.agentActivity) {
      this.agentActivity.finish(parent.subject, {
        requestId: parent.subject,
        outcome: parent.finished.outcome
      });
      const sessionKey = parent.context?.sessionKey;
      if (
        sessionKey &&
        this.orchestratorSessions.has(sessionKey) &&
        !this.hasActiveBridgeSubagentsForSession(sessionKey)
      ) {
        this.agentActivity.noteSubagentResolved(sessionKey);
      }
    }
    this.bridgeParentActivity.delete(requestId);
    return true;
  }

  openBridgeSubagentUsage(input: {
    requestId: string;
    context: BridgeRequestContext;
    role?: string | null | undefined;
    childId: string;
    model?: string | null | undefined;
  }): void {
    const { requestId, context, role, childId, model } = input;
    const key = bridgeSubagentKey(requestId, childId);
    if (this.bridgeSubagentUsage.has(key)) return;
    if (!this.recordSubagentDiagnostics(context)) return;

    const settled = context.finished ?? null;
    const entry = this.recordSubagentUsageEntry(
      requestId,
      context,
      role ?? null,
      model ?? null
    );
    this.bridgeSubagentUsage.set(key, entry);

    const parent = this.openBridgeParentActivity(requestId, context);
    if (parent) parent.children.add(key);

    this.noteBridgeSubagentAgentActivity(key, entry, context);
    this.emitBridgeSubagentUsageEvent(key, entry);

    if (settled) {
      this.closeBridgeSubagentUsage(key, {
        outcome: settled.outcome,
        failureClass:
          settled.outcome === "success" ? null : "parent_turn_failed",
        elapsedMs: settled.elapsedMs ?? null
      });
      return;
    }

    this.evictStaleSubagentUsageEntries();
  }

  // Record the missing-provider / missing-model diagnostics for a context
  // that lacks the fields the registry needs to attribute the subagent.
  // Returns `false` (caller should bail out) when either field is missing.
  private recordSubagentDiagnostics(context: BridgeRequestContext): boolean {
    const missingProvider = !context.provider;
    const missingModel = !context.model;
    if (missingProvider && this.onMissingProviderDiagnostic)
      this.onMissingProviderDiagnostic(1);
    if (missingModel && this.onMissingModelDiagnostic)
      this.onMissingModelDiagnostic(1);
    return !missingProvider && !missingModel;
  }

  // Build the usage entry the registry stores for a new bridge subagent,
  // honouring the inherited-child-model contract for orchestrator routing.
  private recordSubagentUsageEntry(
    requestId: string,
    context: BridgeRequestContext,
    role: string | null,
    model: string | null
  ): BridgeSubagentUsageEntry {
    const childModel =
      model && !INHERITED_CHILD_MODELS.has(model.toLowerCase())
        ? model
        : context.model;
    return {
      requestId,
      provider: context.provider,
      model: childModel,
      role: role ?? UNATTRIBUTED_SUBAGENT_ROLE,
      workspace: context.workspace ?? null,
      startedAt: Date.now()
    };
  }

  // Forward the bridge subagent into the agent-activity tracker: a
  // session-scoped wait marker (when the orchestrator has a session key) and
  // a per-child `beginRequest` so the child shows up in live-agent views.
  private noteBridgeSubagentAgentActivity(
    key: string,
    entry: BridgeSubagentUsageEntry,
    context: BridgeRequestContext
  ): void {
    if (!this.agentActivity) return;
    if (context.sessionKey) {
      this.agentActivity.noteSubagentWait(context.sessionKey, {
        provider: context.provider,
        model: context.model,
        role: ORCHESTRATOR_AGENT_ROLE,
        workspace: context.workspace ?? null
      });
    }
    this.agentActivity.beginRequest(`bridge:${key}`, {
      requestId: key,
      provider: entry.provider,
      model: entry.model,
      role: entry.role,
      origin: "subagent",
      workspace: entry.workspace,
      kind: "bridge_subagent",
      tag: context.sessionKey || entry.requestId,
      parentRequestId: entry.requestId
    });
  }

  // Emit the router's usage-telemetry "selected" event for the subagent so
  // the entry is attributed consistently with non-bridge paths.
  private emitBridgeSubagentUsageEvent(
    key: string,
    entry: BridgeSubagentUsageEntry
  ): void {
    if (!this.onRecordUsageEvent) return;
    this.onRecordUsageEvent({
      phase: "selected",
      requestId: key,
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      workspace: entry.workspace,
      origin: "subagent",
      timestamp: new Date().toISOString()
    });
  }

  // Evict the oldest tracked subagent entries once we exceed the configured
  // ceiling, closing each evicted entry as a missing-result failure.
  private evictStaleSubagentUsageEntries(): void {
    while (this.bridgeSubagentUsage.size > this.maxTrackedSubagents) {
      const oldestKey = this.bridgeSubagentUsage.keys().next().value;
      if (oldestKey === undefined) return;
      this.closeBridgeSubagentUsage(oldestKey, {
        outcome: "failure",
        failureClass: "subagent_result_missing"
      });
    }
  }

  settleSubagentStatus(requestId: string, outcome: string): void {
    const status = outcome === "failure" ? "failure" : "success";
    if ((this.subagentTelemetry.byStatus.started ?? 0) > 0) {
      this.subagentTelemetry.byStatus.started =
        (this.subagentTelemetry.byStatus.started ?? 0) - 1;
    }
    bumpCount(this.subagentTelemetry.byStatus, status, 1);

    const batch = this.subagentTelemetry.recent.find(
      (candidate) =>
        candidate.requestId === requestId &&
        candidate.mechanism === "bridge_native" &&
        (candidate.settled?.success ?? 0) + (candidate.settled?.failure ?? 0) <
          candidate.count
    );
    if (batch) {
      batch.settled = batch.settled ?? { success: 0, failure: 0 };
      batch.settled[status] += 1;
    }
    if (this.onSchedulePersist) this.onSchedulePersist();
  }

  closeBridgeSubagentUsage(
    key: string,
    options: {
      outcome?: string;
      failureClass?: string | null;
      elapsedMs?: number | null;
      toolCalls?: number;
    } = {}
  ): boolean {
    const entry = this.bridgeSubagentUsage.get(key);
    if (!entry) return false;
    const {
      outcome = "success",
      failureClass = null,
      elapsedMs = null,
      toolCalls = 0
    } = options;
    this.bridgeSubagentUsage.delete(key);

    if (this.agentActivity) {
      this.agentActivity.finish(`bridge:${key}`, { requestId: key, outcome });
    }

    this.settleSubagentStatus(entry.requestId, outcome);

    if (this.onRecordUsageEvent) {
      this.onRecordUsageEvent({
        phase: "result",
        requestId: key,
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        workspace: entry.workspace,
        origin: "subagent",
        outcome,
        failureClass,
        elapsedMs: Number.isFinite(elapsedMs)
          ? elapsedMs
          : Date.now() - entry.startedAt,
        toolCalls,
        timestamp: new Date().toISOString()
      });
    }

    const parent = this.bridgeParentActivity.get(entry.requestId);
    if (parent) {
      parent.children.delete(key);
      this.closeBridgeParentActivity(entry.requestId);
    }

    const sessionKey = this.bridgeRequestContext.get(
      entry.requestId
    )?.sessionKey;
    if (
      sessionKey &&
      this.agentActivity &&
      !this.hasActiveBridgeSubagentsForSession(sessionKey)
    ) {
      this.agentActivity.noteSubagentResolved(sessionKey);
    }
    return true;
  }

  closeBridgeSubagentsForRequest(
    requestId: string | null | undefined,
    outcome: string,
    elapsedMs: number | null = null
  ): number {
    if (!requestId) return 0;
    const settled = {
      outcome: outcome === "success" ? "success" : "failure",
      elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs!) : null
    };
    const context = this.bridgeRequestContext.get(requestId);
    if (context) context.finished = settled;
    const parent = this.bridgeParentActivity.get(requestId);
    if (parent) parent.finished = settled;
    let closed = 0;
    for (const [key, entry] of this.bridgeSubagentUsage) {
      if (entry.requestId !== requestId) continue;
      this.closeBridgeSubagentUsage(key, {
        outcome: settled.outcome,
        failureClass:
          settled.outcome === "success" ? null : "parent_turn_failed"
      });
      closed += 1;
    }
    // The parent may have no still-open children by the time its result event
    // arrives (for example, every child reported its own result first). Close
    // that synthetic activity now that the parent's outcome is authoritative.
    this.closeBridgeParentActivity(requestId);
    return closed;
  }

  recordSubagentSpawn(
    input: RecordSubagentSpawnInput
  ): SubagentSpawnRecord | null {
    const {
      mechanism,
      provider = null,
      role = null,
      status = "started",
      tool = null,
      requestId = null,
      workspace = null,
      count = 1
    } = input;
    if (
      !SUBAGENT_MECHANISMS.includes(mechanism as SubagentMechanism) ||
      !Number.isInteger(count) ||
      count < 1
    )
      return null;
    const resolvedProvider =
      typeof provider === "string" && provider.trim()
        ? safeMetricLabel(provider)
        : null;
    if (!resolvedProvider && this.onMissingProviderDiagnostic) {
      this.onMissingProviderDiagnostic(count);
    }
    const entry: SubagentSpawnRecord = {
      timestamp: new Date().toISOString(),
      mechanism: mechanism as SubagentMechanism,
      provider: resolvedProvider,
      role: role ?? "unattributed",
      status,
      tool,
      requestId,
      workspace: workspace ?? null,
      count,
      settled: { success: 0, failure: 0 }
    };

    this.subagentTelemetry.total += count;
    bumpCount(this.subagentTelemetry.byMechanism, mechanism, count);
    if (entry.provider)
      bumpCount(this.subagentTelemetry.byProvider, entry.provider, count);
    bumpCount(this.subagentTelemetry.byRole, entry.role, count);
    bumpCount(this.subagentTelemetry.byStatus, entry.status, count);
    this.subagentTelemetry.recent.push(entry);
    while (this.subagentTelemetry.recent.length > this.maxRecentSpawns) {
      this.subagentTelemetry.recent.shift();
    }

    if (this.onRecordRouterEvent) {
      this.onRecordRouterEvent({
        phase: "subagent_spawn",
        requestId,
        role,
        requestedModel: null,
        provider: entry.provider,
        model: null,
        workspace,
        outcome: status
      });
    }

    if (this.onSchedulePersist) this.onSchedulePersist();
    return entry;
  }

  resetSubagentTelemetry(): void {
    this.subagentTelemetry.total = 0;
    this.subagentTelemetry.byMechanism = Object.fromEntries(
      SUBAGENT_MECHANISMS.map((mechanism) => [mechanism, 0])
    );
    this.subagentTelemetry.byProvider = {};
    this.subagentTelemetry.byRole = {};
    this.subagentTelemetry.byStatus = {};
    this.subagentTelemetry.recent = [];
    this.orchestratorSessions.clear();
    this.bridgeRequestContext.clear();
    this.bridgeSessionContext.clear();
    for (const key of this.bridgeSubagentUsage.keys()) {
      this.closeBridgeSubagentUsage(key, {
        outcome: "failure",
        failureClass: "telemetry_reset"
      });
    }
    for (const parent of this.bridgeParentActivity.values()) {
      if (this.agentActivity) {
        this.agentActivity.finish(parent.subject, {
          requestId: parent.subject,
          outcome: "failure"
        });
      }
    }
    this.bridgeParentActivity.clear();
  }

  subagentStatus(): SubagentStatus {
    const codexNativeSpawns = this.getCodexNativeSpawns
      ? this.getCodexNativeSpawns()
      : 0;
    const spawnCapableProviders = this.getSpawnCapableProviders
      ? this.getSpawnCapableProviders()
      : Object.keys(this.executionContract?.providers ?? {}).filter(
          (provider) =>
            providerCapabilities(provider, this.executionContract).subagentSpawn
        );
    return {
      total: this.subagentTelemetry.total,
      byMechanism: { ...this.subagentTelemetry.byMechanism },
      byProvider: { ...this.subagentTelemetry.byProvider },
      byRole: { ...this.subagentTelemetry.byRole },
      byStatus: { ...this.subagentTelemetry.byStatus },
      codexNativeSpawns,
      spawnCapableProviders,
      recent: [...this.subagentTelemetry.recent].reverse()
    };
  }

  recordSpawnFailure(input: {
    requestId: string | null;
    role: string | null;
    requestedModel: string | null;
    reason: string;
  }): void {
    const failure: SpawnFailureRecord = {
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      role: input.role,
      requestedModel: input.requestedModel,
      reason: input.reason
    };
    this.spawnFailureTelemetry.total += 1;
    bumpCount(this.spawnFailureTelemetry.byReason, input.reason, 1);
    this.spawnFailureTelemetry.recent.push(failure);
    while (
      this.spawnFailureTelemetry.recent.length > MAX_RECENT_SPAWN_FAILURES
    ) {
      this.spawnFailureTelemetry.recent.shift();
    }

    if (this.onRecordRouterEvent) {
      this.onRecordRouterEvent({
        phase: "spawn_failed",
        requestId: input.requestId,
        role: input.role,
        requestedModel: input.requestedModel,
        provider: null,
        model: null,
        failureClass: "spawn_failure",
        spawnFailureReason: input.reason
      });
    }
  }

  spawnFailureStatus(): SpawnFailureStatus {
    return {
      scope: "router-admitted-child-requests",
      total: this.spawnFailureTelemetry.total,
      byReason: { ...this.spawnFailureTelemetry.byReason },
      recent: [...this.spawnFailureTelemetry.recent].reverse()
    };
  }

  resetSpawnFailureTelemetry(): void {
    this.spawnFailureTelemetry.total = 0;
    this.spawnFailureTelemetry.byReason = {};
    this.spawnFailureTelemetry.recent = [];
  }

  restoreSubagentTelemetry(saved: unknown): void {
    if (!saved || typeof saved !== "object") return;
    const doc = saved as {
      total?: unknown;
      byMechanism?: unknown;
      byProvider?: unknown;
      byRole?: unknown;
      byStatus?: unknown;
      recent?: unknown;
    };
    if (Number.isInteger(doc.total) && doc.total >= 0)
      this.subagentTelemetry.total = doc.total;
    for (const section of [
      "byMechanism",
      "byProvider",
      "byRole",
      "byStatus"
    ] as const) {
      const entries = doc[section];
      if (entries && typeof entries === "object") {
        for (const [key, count] of Object.entries(
          entries as Record<string, unknown>
        )) {
          if (
            typeof count === "number" &&
            Number.isFinite(count) &&
            count >= 0
          ) {
            this.subagentTelemetry[section][safeMetricLabel(key)] = count;
          }
        }
      }
    }
    if (Array.isArray(doc.recent)) {
      this.subagentTelemetry.recent = doc.recent
        .filter(
          (entry: unknown): entry is SubagentSpawnRecord =>
            Boolean(entry) && typeof entry === "object"
        )
        .slice(-this.maxRecentSpawns)
        .map((entry) => {
          const candidate = entry as SubagentSpawnRecord & {
            settled?: unknown;
          };
          return {
            ...candidate,
            settled: normalizeSettledTelemetry(candidate.settled)
          };
        });
    }
  }

  restoreSpawnFailureTelemetry(saved: unknown): void {
    if (!saved || typeof saved !== "object") return;
    const doc = saved as {
      total?: unknown;
      byReason?: unknown;
      recent?: unknown;
    };
    if (Number.isInteger(doc.total) && doc.total >= 0)
      this.spawnFailureTelemetry.total = doc.total;
    if (doc.byReason && typeof doc.byReason === "object") {
      for (const [reason, count] of Object.entries(
        doc.byReason as Record<string, unknown>
      )) {
        if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
          this.spawnFailureTelemetry.byReason[safeMetricLabel(reason)] = count;
        }
      }
    }
    if (Array.isArray(doc.recent)) {
      this.spawnFailureTelemetry.recent = doc.recent
        .filter(
          (item: unknown): item is SpawnFailureRecord =>
            Boolean(item) && typeof item === "object"
        )
        .slice(-MAX_RECENT_SPAWN_FAILURES)
        .map((entry) => ({ ...(entry as SpawnFailureRecord) }));
    }
  }
}

let defaultSubagentRegistry: SubagentRegistry | null = null;

export function getDefaultSubagentRegistry(): SubagentRegistry {
  if (!defaultSubagentRegistry) {
    defaultSubagentRegistry = new SubagentRegistry();
  }
  return defaultSubagentRegistry;
}

export function setDefaultSubagentRegistry(
  registry: SubagentRegistry | null
): void {
  defaultSubagentRegistry = registry;
}

export function noteOrchestratorSession(
  sessionKey: string | null | undefined,
  provider: string | null | undefined,
  details: {
    model?: string | null;
    workspace?: string | null;
    requestId?: string | null;
  } = {}
): void {
  getDefaultSubagentRegistry().noteOrchestratorSession(
    sessionKey,
    provider,
    details
  );
}

export function orchestratorProviderForSession(
  sessionKey: string | null | undefined
): string | null {
  return getDefaultSubagentRegistry().orchestratorProviderForSession(
    sessionKey
  );
}

export function orchestratorSessionInfo(
  sessionKey: string | null | undefined
): OrchestratorSessionEntry | null {
  return getDefaultSubagentRegistry().orchestratorSessionInfo(sessionKey);
}

export function hasActiveBridgeSubagentsForSession(
  sessionKey: string | null | undefined
): boolean {
  return getDefaultSubagentRegistry().hasActiveBridgeSubagentsForSession(
    sessionKey
  );
}

export function noteBridgeRequest(
  requestId: string | null | undefined,
  context: BridgeRequestContext
): void {
  getDefaultSubagentRegistry().noteBridgeRequest(requestId, context);
}

export function noteBridgeSession(
  sessionKey: string | null | undefined,
  context: BridgeRequestContext | null | undefined
): void {
  getDefaultSubagentRegistry().noteBridgeSession(sessionKey, context);
}

export function lookupBridgeSessionContext(
  sessionKey: string | null | undefined
): BridgeRequestContext | null {
  return getDefaultSubagentRegistry().lookupBridgeSessionContext(sessionKey);
}

export function recallBridgeSessionRequestId(
  sessionKey: string | null | undefined
): string | null {
  return getDefaultSubagentRegistry().recallBridgeSessionRequestId(sessionKey);
}

export function recordSubagentSpawn(
  input: RecordSubagentSpawnInput
): SubagentSpawnRecord | null {
  return getDefaultSubagentRegistry().recordSubagentSpawn(input);
}

export function resetSubagentTelemetry(): void {
  getDefaultSubagentRegistry().resetSubagentTelemetry();
}

export function subagentStatus(): SubagentStatus {
  return getDefaultSubagentRegistry().subagentStatus();
}

export function recordSpawnFailure(input: {
  requestId: string | null;
  role: string | null;
  requestedModel: string | null;
  reason: string;
}): void {
  getDefaultSubagentRegistry().recordSpawnFailure(input);
}

export function spawnFailureStatus(): SpawnFailureStatus {
  return getDefaultSubagentRegistry().spawnFailureStatus();
}

export function closeBridgeSubagentsForRequest(
  requestId: string | null | undefined,
  outcome: string,
  elapsedMs: number | null = null
): number {
  return getDefaultSubagentRegistry().closeBridgeSubagentsForRequest(
    requestId,
    outcome,
    elapsedMs
  );
}

export function rememberWorkspaceMetadata(
  sessionKey: string | null | undefined,
  workspacePath: string | null | undefined
): void {
  getDefaultSubagentRegistry().rememberWorkspaceMetadata(
    sessionKey,
    workspacePath
  );
}

export function getWorkspaceMetadata(
  sessionKey: string | null | undefined
): string | null {
  return getDefaultSubagentRegistry().getWorkspaceMetadata(sessionKey);
}

export function openBridgeSubagentUsage(input: {
  requestId: string;
  context: BridgeRequestContext;
  role?: string | null | undefined;
  childId: string;
  model?: string | null | undefined;
}): void {
  getDefaultSubagentRegistry().openBridgeSubagentUsage(input);
}

export function closeBridgeSubagentUsage(
  key: string,
  options: {
    outcome?: string;
    failureClass?: string | null;
    elapsedMs?: number | null;
    toolCalls?: number;
  } = {}
): boolean {
  return getDefaultSubagentRegistry().closeBridgeSubagentUsage(key, options);
}

export function getBridgeRequestContext(
  requestId: string | null | undefined
): BridgeRequestContext | null {
  return getDefaultSubagentRegistry().getBridgeRequestContext(requestId);
}

export function resetSpawnFailureTelemetry(): void {
  getDefaultSubagentRegistry().resetSpawnFailureTelemetry();
}

export { PROCESS_FALLBACK_SESSION_KEY } from "./concurrency.ts";
