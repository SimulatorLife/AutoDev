import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type AgentActivityTracker,
  PROCESS_FALLBACK_SESSION_KEY
} from "@simulatorlife/autodev-runtime/router/concurrency";
import type {
  ExecutionContract,
  RoleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import type { RecordRouterEventInput } from "./events.ts";
import { safeMetricLabel } from "./metric-label.ts";
import type { RecordUsageEventParams } from "./usage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Normalise the persisted `settled` counter block. The router records it
// as `{ success, failure }`; persistence may hand back an object whose
// fields have lost their numeric type, so this helper recovers the shape
// without using `any`.
function normalizeSettledCounter(value: unknown): number {
  const count =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function normalizeSettledTelemetry(value: unknown): {
  success: number;
  failure: number;
} {
  if (!isRecord(value)) return { success: 0, failure: 0 };
  return {
    success: normalizeSettledCounter(value.success),
    failure: normalizeSettledCounter(value.failure)
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

/**
 * Codex Desktop session id used by /v1/agent-events ingest as the secondary
 * correlation key when a bridge did not issue a router request id. The hook
 * `skill-read-telemetry` posts this so the router can attribute SKILL.md
 * reads from child threads that never travelled through `/v1/responses`.
 */

export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";
export const FORWARDED_REQUEST_HEADERS = Object.freeze([
  "x-codex-turn-metadata"
]);

function restoredMetricLabel<Fallback extends string | null>(
  value: unknown,
  fallback: Fallback
): string | Fallback {
  return typeof value === "string" && value.trim()
    ? safeMetricLabel(value)
    : fallback;
}

function restoredString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function restoredNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function restoreMetricCounts(
  value: unknown,
  destination: Record<string, number>
): void {
  if (!isRecord(value)) return;
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      continue;
    }
    destination[safeMetricLabel(key)] = count;
  }
}

function restoredSubagentMechanism(value: unknown): SubagentMechanism | null {
  return SUBAGENT_MECHANISMS.find((mechanism) => mechanism === value) ?? null;
}

function restoreSubagentSpawnRecord(
  value: unknown
): SubagentSpawnRecord | null {
  if (!isRecord(value)) return null;
  const mechanism = restoredSubagentMechanism(value.mechanism);
  const timestamp = restoredString(value.timestamp);
  if (!mechanism || !timestamp?.trim()) return null;
  return {
    timestamp,
    mechanism,
    provider: restoredMetricLabel(value.provider, null),
    role: restoredMetricLabel(value.role, "unattributed"),
    status: restoredMetricLabel(value.status, "unknown"),
    tool: restoredMetricLabel(value.tool, null),
    requestId: restoredString(value.requestId),
    workspace: restoredString(value.workspace),
    count:
      typeof value.count === "number" &&
      Number.isInteger(value.count) &&
      value.count > 0
        ? value.count
        : 1,
    settled: normalizeSettledTelemetry(value.settled)
  };
}

function restoreRecentSubagentSpawns(
  value: unknown,
  limit: number
): SubagentSpawnRecord[] | null {
  if (!Array.isArray(value)) return null;
  const restored: SubagentSpawnRecord[] = [];
  for (const entry of value) {
    const record = restoreSubagentSpawnRecord(entry);
    if (record) restored.push(record);
  }
  return restored.slice(-limit);
}

function restoreSpawnFailureRecord(value: unknown): SpawnFailureRecord | null {
  if (!isRecord(value)) return null;
  const timestamp = restoredString(value.timestamp);
  if (!timestamp?.trim()) return null;
  return {
    timestamp,
    requestId: restoredString(value.requestId),
    role: restoredMetricLabel(value.role, null),
    requestedModel: restoredMetricLabel(value.requestedModel, null),
    reason: restoredMetricLabel(value.reason, "unknown")
  };
}

function restoreRecentSpawnFailures(
  value: unknown
): SpawnFailureRecord[] | null {
  if (!Array.isArray(value)) return null;
  const restored: SpawnFailureRecord[] = [];
  for (const entry of value) {
    const record = restoreSpawnFailureRecord(entry);
    if (record) restored.push(record);
  }
  return restored.slice(-MAX_RECENT_SPAWN_FAILURES);
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
    (child): child is Record<string, unknown> => isRecord(child)
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
    typeof event.count === "number" &&
    Number.isInteger(event.count) &&
    event.count > 0
      ? event.count
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

function roleContractForAgent(
  role: string | null | undefined,
  executionContract: ExecutionContract
): RoleContract | undefined {
  const key =
    typeof role === "string" && role.trim()
      ? role.trim().toLowerCase()
      : "default";
  return executionContract.roles?.[key];
}

function capabilityNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

function capabilitySet(value: unknown): Set<string> {
  return new Set(capabilityNames(value));
}

function roleWebResearchRequirements(
  value: unknown
): RoleCapabilityRequirements["webResearch"] {
  if (!isRecord(value)) {
    return { search: false, fetch: false, optionalMcp: new Set() };
  }
  return {
    search: value.search === true,
    fetch: value.fetch === true,
    optionalMcp: capabilitySet(value.optionalMcp)
  };
}

function emptyRoleCapabilityRequirements(): RoleCapabilityRequirements {
  return {
    mcp: new Set(),
    skills: new Set(),
    webResearch: roleWebResearchRequirements(null)
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
  const defaultContract = path.join(
    resolveRuntimeSourceRoot(import.meta.dirname),
    "config",
    "execution-contract.json"
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

/**
 * The execution-contract file the last read resolved to, or `null` when none
 * existed.
 *
 * Exposed because a mutation has to write the file it read. Reading the contract
 * through a cached accessor and writing through a separately-computed path is how
 * a change lands in one file while the process keeps serving another, and the
 * mutation would report success for an edit nothing reads.
 *
 * Resolution is repeated rather than remembered, so the path is the one this
 * call would use now -- including after a reload invalidated the document.
 */
export function executionContractFile(): string | null {
  const codexHome =
    process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
  const defaultContract = path.join(
    resolveRuntimeSourceRoot(import.meta.dirname),
    "config",
    "execution-contract.json"
  );
  return (
    [
      process.env.CODEX_EXECUTION_CONTRACT_FILE,
      defaultContract,
      `${codexHome}/config/execution-contract.json`
    ].find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        existsSync(candidate)
    ) ?? null
  );
}

/**
 * Drop the cached contract so the next read comes from disk.
 *
 * Called after a successful write and nowhere else. A cache that outlives its
 * own mutation is the difference between an assignment that takes effect and one
 * that appears to have succeeded and then quietly does nothing.
 */
export function reloadExecutionContract(): void {
  cachedExecutionContract = null;
}

export function providerCapabilities(
  provider: string,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): ProviderCapabilities {
  const rawSpawnTools = executionContract.providers?.[provider]?.spawnTools;
  const subagentSpawnTools = Array.isArray(rawSpawnTools)
    ? rawSpawnTools.filter(
        (tool): tool is string =>
          typeof tool === "string" && tool.trim().length > 0
      )
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
  const contract = roleContractForAgent(role, executionContract);
  if (!contract) return emptyRoleCapabilityRequirements();
  return {
    mcp: capabilitySet(contract.mcp),
    skills: capabilitySet(contract.skills),
    webResearch: roleWebResearchRequirements(contract.webResearch)
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
  const contract = roleContractForAgent(agentRole, executionContract);
  return capabilityNames(contract?.mcp);
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
  onRecordRouterEvent?: ((event: RecordRouterEventInput) => void) | undefined;
  onRecordUsageEvent?: ((event: RecordUsageEventParams) => void) | undefined;
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
    ((event: RecordRouterEventInput) => void) | undefined;
  private readonly onRecordUsageEvent?:
    ((event: RecordUsageEventParams) => void) | undefined;
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
  private recordSubagentDiagnostics(
    context: BridgeRequestContext
  ): context is BridgeRequestContext & { provider: string; model: string } {
    const missingProvider =
      typeof context.provider !== "string" || !context.provider.trim();
    const missingModel =
      typeof context.model !== "string" || !context.model.trim();
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
    context: BridgeRequestContext & { provider: string; model: string },
    role: string | null,
    model: string | null
  ): BridgeSubagentUsageEntry {
    const childModel =
      typeof model === "string" &&
      model.trim() &&
      !INHERITED_CHILD_MODELS.has(model.trim().toLowerCase())
        ? model.trim()
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
    if (!isRecord(saved)) return;
    const total = restoredNonnegativeInteger(saved.total);
    if (total !== null) this.subagentTelemetry.total = total;

    for (const section of [
      "byMechanism",
      "byProvider",
      "byRole",
      "byStatus"
    ] as const) {
      restoreMetricCounts(saved[section], this.subagentTelemetry[section]);
    }
    const recent = restoreRecentSubagentSpawns(
      saved.recent,
      this.maxRecentSpawns
    );
    if (recent) this.subagentTelemetry.recent = recent;
  }

  restoreSpawnFailureTelemetry(saved: unknown): void {
    if (!isRecord(saved)) return;
    const total = restoredNonnegativeInteger(saved.total);
    if (total !== null) this.spawnFailureTelemetry.total = total;
    restoreMetricCounts(saved.byReason, this.spawnFailureTelemetry.byReason);

    const recent = restoreRecentSpawnFailures(saved.recent);
    if (recent) this.spawnFailureTelemetry.recent = recent;
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
