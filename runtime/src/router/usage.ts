import { createHash } from "node:crypto";

import {
  AGENT_ACTIVITY_KINDS,
  AGENT_ACTIVITY_STATES
} from "@simulatorlife/autodev-runtime/agents";
import { ROLE_NAMES } from "@simulatorlife/autodev-runtime/router/routing";

import type { AgentActivityTracker } from "./concurrency/index.ts";
import { safeMetricLabel } from "./metric-label.ts";

type LiveAgentActivity = ReturnType<AgentActivityTracker["listLive"]>[number];

export const UNATTRIBUTED_DIMENSION = "unattributed";
export const MAX_UNKNOWN_WORKSPACE_IDS = 100;
const MAX_ACTIVE_USAGE_SUBJECTS = 4096;
const STRING_COLLATOR = new Intl.Collator();

export interface UsageFailureInfo {
  timestamp: string;
  class?: string | null;
  status?: number | string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isUsageFailureInfo(value: unknown): value is UsageFailureInfo {
  if (!isPlainRecord(value) || typeof value.timestamp !== "string")
    return false;
  if (
    Object.hasOwn(value, "class") &&
    value.class !== null &&
    typeof value.class !== "string"
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "status") &&
    value.status !== null &&
    typeof value.status !== "string" &&
    typeof value.status !== "number"
  ) {
    return false;
  }
  return true;
}

export interface UsageBucket {
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  active?: number;
  durationMs: number;
  maxDurationMs: number;
  toolCalls: number;
  lastUsedAt: string | null;
  lastFailure: UsageFailureInfo | null;
  averageDurationMs?: number;
}

export interface WorkspaceTool {
  tool: string;
  source: string;
  server: string;
  count: number;
  byStatus: Record<string, number>;
  durationCount: number;
  durationMs: number;
  averageDurationMs?: number;
}

export interface WorkspaceSkill {
  skill: string;
  total: number;
  uses: number;
  byStatus: Record<string, number>;
  byInvokeType: Record<string, number>;
  byAgentKind: Record<string, number>;
  byModel: Record<string, number>;
  byPlugin: Record<string, number>;
}

export interface WorkspaceMcpEntry {
  server: string;
  count: number;
}

export interface WorkspaceBridgeTool {
  tool: string;
  server: string;
  count: number;
  byStatus: Record<string, number>;
}

export interface WorkspaceUsageBucket extends UsageBucket {
  cwd: string | null;
  skillUses: number;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
  byMcp: Record<string, number>;
  tools: Map<string, WorkspaceTool>;
  skills: Map<string, WorkspaceSkill>;
  toolsUnattributed: number;
  skillsUnattributed: number;
  toolsExecuted: number;
  toolsRequested: number;
  toolsUnavailable: number;
  skillsExposed: number;
  toolsCapable: boolean;
  skillsCapable: boolean;
  mcpCapable: boolean;
  mcpExposed: Map<string, WorkspaceMcpEntry>;
  bridgeObservations: {
    tools: Map<string, WorkspaceBridgeTool>;
    skills: Map<string, number>;
  };
}

export interface AttributionDiagnostics {
  total: number;
  attributed: number;
  unattributed: number;
  byReason: {
    missing_workspace: number;
    unknown_workspace_id: number;
    ambiguous_resource: number;
    missing_provider: number;
    missing_model: number;
  };
  bySource: {
    datapoint: number;
    resource: number;
  };
  unknownWorkspaceIds: Set<string>;
}

export interface AttributionDiagnosticsStatus {
  total: number;
  attributed: number;
  unattributed: number;
  byReason: Record<string, number>;
  bySource: Record<string, number>;
  unknownWorkspaceIds: string[];
}

export interface ProjectedAgent {
  provider?: string | null;
  model?: string | null;
  role?: string | null;
  origin?: string | null;
  workspace?: string | null;
  [key: string]: unknown;
}

export interface LiveAgentsProjection {
  at: number;
  directAgents: LiveAgentActivity[];
  allLiveAgents: ProjectedAgent[];
  canonicalTotal: number;
  missingProvider: number;
  missingModel: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byRole: Record<string, number>;
  byOrigin: Record<string, number>;
  byWorkspace: Record<string, number>;
}

export interface UsageStatus {
  activity: Record<string, unknown>;
  totals: UsageBucket & { active: number; averageDurationMs: number };
  byRole: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  >;
  byModel: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  >;
  byOrigin: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  >;
  byWorkspace: Record<string, unknown>;
}

export interface UsagePersistenceSnapshot {
  schemaVersion: number;
  totals: Record<string, unknown>;
  byRole: Record<string, unknown>;
  byModel: Record<string, unknown>;
  byOrigin: Record<string, unknown>;
  byWorkspace: Record<string, unknown>;
  workspaceRegistry: [string, string][];
}

export interface UsageActiveWorkspaceSnapshot extends UsageBucket {
  averageDurationMs: number;
  cwd: string | null;
  byRole: Record<string, UsageBucket & { averageDurationMs: number }>;
  byModel: Record<string, UsageBucket & { averageDurationMs: number }>;
  skillUses: number;
  bySkill: Array<{ skill: string; count: number }>;
}

export interface UsageActiveSnapshot {
  totals: UsageBucket & { averageDurationMs: number };
  byRole: Record<string, UsageBucket & { averageDurationMs: number }>;
  byModel: Record<string, UsageBucket & { averageDurationMs: number }>;
  byOrigin: Record<string, UsageBucket & { averageDurationMs: number }>;
  byWorkspace: Record<string, UsageActiveWorkspaceSnapshot>;
  skillUses: number;
  bySkill: Array<{ skill: string; count: number }>;
}

// Raw, unserialized accumulators for a single live subject (router thread).
// Kept separate from UsageActiveSnapshot so accumulation can reuse the same
// plain UsageBucket buckets everywhere else in this module.
interface SubjectWorkspaceAccumulator {
  bucket: UsageBucket;
  cwd: string | null;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  skillUses: number;
  bySkill: Map<string, number>;
}

interface SubjectUsageAccumulator {
  totals: UsageBucket;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byOrigin: Record<string, UsageBucket>;
  byWorkspace: Record<string, SubjectWorkspaceAccumulator>;
  skillUses: number;
  bySkill: Map<string, number>;
}

function withAverageDuration(
  bucket: UsageBucket
): UsageBucket & { averageDurationMs: number } {
  return {
    ...bucket,
    averageDurationMs:
      bucket.successes + bucket.failures > 0
        ? Math.round(bucket.durationMs / (bucket.successes + bucket.failures))
        : 0
  };
}

export interface RecordUsageEventParams {
  phase: string;
  requestId: string;
  role?: string | null;
  provider: string;
  model: string;
  workspace?:
    string | { key: string; cwd?: string | null; workspace_id?: string } | null;
  outcome?: "success" | "failure" | string;
  failureClass?: string | null;
  status?: number | string | null;
  elapsedMs?: number | null;
  toolCalls?: number;
  timestamp: string;
  origin?: "orchestrator" | "subagent" | "direct" | string | null;
  // Ephemeral live-agent identity (the router thread/subject). Used to keep
  // a per-agent cumulative usage projection alive while the agent is active,
  // independent of the global RouterEvent ring buffer. Never persisted.
  subject?: string | null;
}

export interface UsageTrackerOptions {
  activityTracker?: AgentActivityTracker;
  roleNames?: readonly string[];
}

export interface UsageTelemetryState {
  totals: UsageBucket;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byOrigin: Record<string, UsageBucket>;
  byWorkspace: Record<string, WorkspaceUsageBucket>;
}

export function emptyUsageBucket(): UsageBucket {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    active: 0,
    durationMs: 0,
    maxDurationMs: 0,
    toolCalls: 0,
    lastUsedAt: null,
    lastFailure: null
  };
}

export function usageOrigin(
  role?: string | null,
  provider?: string | null
): "orchestrator" | "subagent" | "direct" {
  if (role === "orchestrator") return "orchestrator";
  if (role) return "subagent";
  if (provider === "codex") return "orchestrator";
  return "direct";
}

export function usageKey(
  requestId: string,
  provider: string,
  model: string
): string {
  return `${requestId}\0${provider}\0${model}`;
}

export function safeWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/Users/") ||
    trimmed.includes("/home/") ||
    trimmed.includes("CODEX_HOME")
  ) {
    const digest = createHash("sha256")
      .update(trimmed)
      .digest("hex")
      .slice(0, 12);
    return `ws_${digest}`;
  }
  return safeMetricLabel(trimmed);
}

export function safeAgentIdentity(
  value: unknown,
  fallback: string = UNATTRIBUTED_DIMENSION
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/Users/") ||
    trimmed.includes("/home/") ||
    trimmed.includes("CODEX_HOME")
  ) {
    return `agent_${createHash("sha256").update(trimmed).digest("hex").slice(0, 12)}`;
  }
  return safeMetricLabel(trimmed, fallback);
}

export function safePrivacyWorkspace(
  value: unknown,
  fallback: string = UNATTRIBUTED_DIMENSION
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/Users/") ||
    trimmed.includes("/home/") ||
    trimmed.includes("CODEX_HOME")
  ) {
    const digest = createHash("sha256")
      .update(trimmed)
      .digest("hex")
      .slice(0, 12);
    return `ws_${digest}`;
  }
  return safeMetricLabel(trimmed, fallback);
}

export function extractWorkspaceIdWithAmbiguity(attributes: unknown): {
  id: string | null;
  ambiguous: boolean;
} {
  if (!attributes || typeof attributes !== "object")
    return { id: null, ambiguous: false };
  const attrs = attributes as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["workspace_id", "workspace.id", "workspaceId"]) {
    const val = attrs[key];
    if (typeof val === "string" && val.trim()) {
      found.push(val.trim());
    }
  }
  const unique = [...new Set(found)];
  if (unique.length > 1) return { id: null, ambiguous: true };
  return { id: unique[0] ?? null, ambiguous: false };
}

export function readNamedAttribute(
  attributes: Record<string, unknown>,
  fallback: string,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = attributes?.[key];
    if (typeof value === "string" && value.trim())
      return safeMetricLabel(value, fallback);
  }
  return fallback;
}

export function toolServerAttribute(
  attributes: Record<string, unknown>,
  fallback: string = ""
): string {
  return readNamedAttribute(
    attributes,
    fallback,
    "server",
    "mcp_server",
    "serverName",
    "server_name"
  );
}

export function toolNameAttribute(
  attributes: Record<string, unknown>,
  fallback: string = "unknown-tool"
): string {
  return readNamedAttribute(
    attributes,
    fallback,
    "tool",
    "toolName",
    "tool_name"
  );
}

export function toolKey(attributes: Record<string, unknown>): string {
  return [
    toolNameAttribute(attributes),
    safeMetricLabel(attributes?.source),
    toolServerAttribute(attributes)
  ].join("::");
}

export function formatWorkspaceTools(
  toolsMap?: Map<string, WorkspaceTool> | null
): WorkspaceTool[] {
  if (!toolsMap) return [];
  return Array.from(toolsMap.values(), (tool) => ({
    ...tool,
    averageDurationMs: tool.durationCount
      ? Math.round(tool.durationMs / tool.durationCount)
      : 0,
    byStatus: { ...tool.byStatus }
  })).sort((a, b) =>
    STRING_COLLATOR.compare(
      `${a.tool}/${a.source}/${a.server}`,
      `${b.tool}/${b.source}/${b.server}`
    )
  );
}

export function formatWorkspaceSkills(
  skillsMap?: Map<string, WorkspaceSkill> | null
): WorkspaceSkill[] {
  if (!skillsMap) return [];
  return Array.from(skillsMap.values(), (skill) => ({
    ...skill,
    byStatus: { ...skill.byStatus },
    byInvokeType: { ...skill.byInvokeType },
    byAgentKind: { ...skill.byAgentKind },
    byModel: { ...skill.byModel },
    byPlugin: { ...skill.byPlugin }
  })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill));
}

export function formatWorkspaceMcpExposed(
  mcpExposedMap?: Map<string, WorkspaceMcpEntry> | null
): WorkspaceMcpEntry[] {
  if (!mcpExposedMap) return [];
  return Array.from(mcpExposedMap.values(), (row) => ({ ...row })).sort(
    (a, b) => STRING_COLLATOR.compare(a.server, b.server)
  );
}

export function formatWorkspaceMcpUses(
  byMcp?: Record<string, number> | null
): WorkspaceMcpEntry[] {
  return Object.entries(byMcp ?? {})
    .map(([server, count]) => ({ server, count }))
    .sort((a, b) => STRING_COLLATOR.compare(a.server, b.server));
}

export function restoreUsageBucket(
  target: UsageBucket,
  saved: Record<string, unknown>
): void {
  if (!isPlainRecord(saved)) return;
  for (const field of [
    "attempts",
    "successes",
    "failures",
    "skipped",
    "durationMs",
    "maxDurationMs",
    "toolCalls"
  ] as const) {
    const value = saved[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      target[field] = value;
    }
  }
  if (saved.lastUsedAt === null || typeof saved.lastUsedAt === "string")
    target.lastUsedAt = saved.lastUsedAt;
  if (saved.lastFailure === null || isUsageFailureInfo(saved.lastFailure))
    target.lastFailure = saved.lastFailure;
}

export function usageBucket(
  collection: Record<string, UsageBucket>,
  key: string
): UsageBucket {
  if (!collection[key]) collection[key] = emptyUsageBucket();
  return collection[key];
}

function mergeUsageBucketInto(target: UsageBucket, source: UsageBucket): void {
  target.attempts += source.attempts;
  target.successes += source.successes;
  target.failures += source.failures;
  target.skipped += source.skipped;
  target.durationMs += source.durationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
  target.toolCalls += source.toolCalls;
  if (
    source.lastUsedAt &&
    (!target.lastUsedAt || source.lastUsedAt > target.lastUsedAt)
  ) {
    target.lastUsedAt = source.lastUsedAt;
  }
  if (
    source.lastFailure &&
    (!target.lastFailure ||
      source.lastFailure.timestamp > target.lastFailure.timestamp)
  ) {
    target.lastFailure = source.lastFailure;
  }
}

function mergeUsageBucketMapInto(
  target: Record<string, UsageBucket>,
  source: Record<string, UsageBucket>
): void {
  for (const [key, bucket] of Object.entries(source)) {
    mergeUsageBucketInto(usageBucket(target, key), bucket);
  }
}

function mergeSubjectWorkspaceInto(
  target: Record<string, SubjectWorkspaceAccumulator>,
  source: Record<string, SubjectWorkspaceAccumulator>
): void {
  for (const [key, accumulator] of Object.entries(source)) {
    let entry = target[key];
    if (!entry) {
      entry = {
        bucket: emptyUsageBucket(),
        cwd: accumulator.cwd,
        byRole: {},
        byModel: {},
        skillUses: 0,
        bySkill: new Map()
      };
      target[key] = entry;
    } else if (!entry.cwd && accumulator.cwd) {
      entry.cwd = accumulator.cwd;
    }
    mergeUsageBucketInto(entry.bucket, accumulator.bucket);
    mergeUsageBucketMapInto(entry.byRole, accumulator.byRole);
    mergeUsageBucketMapInto(entry.byModel, accumulator.byModel);
    entry.skillUses += accumulator.skillUses;
    for (const [skill, count] of accumulator.bySkill) {
      entry.bySkill.set(skill, (entry.bySkill.get(skill) ?? 0) + count);
    }
  }
}

function createWorkspaceBucket(cwd: string | null): WorkspaceUsageBucket {
  return {
    ...emptyUsageBucket(),
    cwd,
    skillUses: 0,
    byRole: {},
    byModel: {},
    byProvider: {},
    byMcp: {},
    tools: new Map(),
    skills: new Map(),
    toolsUnattributed: 0,
    skillsUnattributed: 0,
    toolsExecuted: 0,
    toolsRequested: 0,
    toolsUnavailable: 0,
    skillsExposed: 0,
    toolsCapable: false,
    skillsCapable: false,
    mcpCapable: false,
    mcpExposed: new Map(),
    bridgeObservations: { tools: new Map(), skills: new Map() }
  };
}

function normalizeWorkspaceBucket(
  bucket: WorkspaceUsageBucket,
  cwd: string | null
): WorkspaceUsageBucket {
  if (cwd && !bucket.cwd) bucket.cwd = cwd;
  if (!bucket.byMcp) bucket.byMcp = {};
  if (!bucket.tools) bucket.tools = new Map();
  if (!bucket.skills) bucket.skills = new Map();
  if (!bucket.mcpExposed) bucket.mcpExposed = new Map();
  if (typeof bucket.skillUses !== "number") bucket.skillUses = 0;
  if (typeof bucket.toolsUnattributed !== "number")
    bucket.toolsUnattributed = 0;
  if (typeof bucket.skillsUnattributed !== "number")
    bucket.skillsUnattributed = 0;
  if (typeof bucket.toolsExecuted !== "number") bucket.toolsExecuted = 0;
  if (typeof bucket.toolsRequested !== "number") bucket.toolsRequested = 0;
  if (typeof bucket.toolsUnavailable !== "number") bucket.toolsUnavailable = 0;
  if (typeof bucket.skillsExposed !== "number") bucket.skillsExposed = 0;
  if (typeof bucket.toolsCapable !== "boolean") bucket.toolsCapable = false;
  if (typeof bucket.skillsCapable !== "boolean") bucket.skillsCapable = false;
  if (typeof bucket.mcpCapable !== "boolean") bucket.mcpCapable = false;
  if (!bucket.bridgeObservations)
    bucket.bridgeObservations = { tools: new Map(), skills: new Map() };
  if (!bucket.bridgeObservations.tools)
    bucket.bridgeObservations.tools = new Map();
  if (!bucket.bridgeObservations.skills)
    bucket.bridgeObservations.skills = new Map();
  return bucket;
}

export function workspaceBucket(
  collection: Record<string, WorkspaceUsageBucket>,
  key: string,
  cwd: string | null = null
): WorkspaceUsageBucket {
  if (!collection[key]) collection[key] = createWorkspaceBucket(cwd);
  return normalizeWorkspaceBucket(collection[key], cwd);
}

export function workspaceMcpBucket(
  wsBucket: WorkspaceUsageBucket,
  server: string
): WorkspaceMcpEntry {
  if (!wsBucket.mcpExposed) wsBucket.mcpExposed = new Map();
  if (!wsBucket.mcpExposed.has(server))
    wsBucket.mcpExposed.set(server, { server, count: 0 });
  return wsBucket.mcpExposed.get(server)!;
}

export function workspaceToolBucket(
  wsBucket: WorkspaceUsageBucket,
  attributes: Record<string, unknown>
): WorkspaceTool {
  if (!wsBucket.tools) wsBucket.tools = new Map();
  const tool = toolNameAttribute(attributes);
  const source = safeMetricLabel(attributes?.source);
  const server = toolServerAttribute(attributes);
  const key = toolKey(attributes);
  if (!wsBucket.tools.has(key)) {
    wsBucket.tools.set(key, {
      tool,
      source,
      server,
      count: 0,
      byStatus: {},
      durationCount: 0,
      durationMs: 0
    });
  }
  return wsBucket.tools.get(key)!;
}

export function workspaceSkillBucket(
  wsBucket: WorkspaceUsageBucket,
  skillName: string
): WorkspaceSkill {
  if (!wsBucket.skills) wsBucket.skills = new Map();
  if (!wsBucket.skills.has(skillName)) {
    wsBucket.skills.set(skillName, {
      skill: skillName,
      total: 0,
      uses: 0,
      byStatus: {},
      byInvokeType: {},
      byAgentKind: {},
      byModel: {},
      byPlugin: {}
    });
  }
  return wsBucket.skills.get(skillName)!;
}

export function workspaceDimensionBuckets(
  bucket: WorkspaceUsageBucket,
  {
    role,
    provider,
    model
  }: { role?: string | null; provider: string; model: string }
): UsageBucket[] {
  return [
    role
      ? usageBucket(bucket.byRole, role)
      : usageBucket(bucket.byRole, "unattributed"),
    usageBucket(bucket.byModel, `${provider}/${model}`),
    usageBucket(bucket.byProvider, provider)
  ];
}

export function matchesProjectedAgent(
  agent: ProjectedAgent,
  dimension: string,
  key: string,
  extraFilter: Record<string, unknown> = {}
): boolean {
  if (extraFilter.workspace !== undefined) {
    const wsTarget = extraFilter.workspace ?? UNATTRIBUTED_DIMENSION;
    const wsAgent = agent.workspace ?? UNATTRIBUTED_DIMENSION;
    if (wsAgent !== wsTarget) return false;
  }
  if (dimension === "role") {
    const rKey = agent.role ?? UNATTRIBUTED_DIMENSION;
    return rKey === key;
  }
  if (dimension === "origin") {
    const oKey = agent.origin ?? UNATTRIBUTED_DIMENSION;
    return oKey === key;
  }
  if (dimension === "provider") {
    return Boolean(agent.provider) && agent.provider === key;
  }
  if (dimension === "model") {
    if (!agent.provider || !agent.model) return false;
    const mKey = agent.model.startsWith(`${agent.provider}/`)
      ? agent.model
      : `${agent.provider}/${agent.model}`;
    return mKey === key;
  }
  if (dimension === "workspace") {
    const wKey = agent.workspace ?? UNATTRIBUTED_DIMENSION;
    return wKey === key;
  }
  return false;
}

function populateUsageSnapshot(
  result: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  >,
  collection: Record<string, UsageBucket> | undefined,
  dimension: string,
  projection: LiveAgentsProjection,
  extraFilter: Record<string, unknown>
): void {
  for (const [key, bucket] of Object.entries(collection ?? {})) {
    if (
      (dimension === "provider" || dimension === "model") &&
      key === UNATTRIBUTED_DIMENSION
    )
      continue;
    const active = projection.allLiveAgents.filter((agent) =>
      matchesProjectedAgent(agent, dimension, key, extraFilter)
    ).length;
    result[key] = {
      ...bucket,
      active,
      averageDurationMs:
        bucket.successes + bucket.failures > 0
          ? Math.round(bucket.durationMs / (bucket.successes + bucket.failures))
          : 0
    };
  }
}

function liveSnapshotKeys(
  dimension: string,
  projection: LiveAgentsProjection,
  extraFilter: Record<string, unknown>
): Set<string> {
  const keys = new Set<string>();
  if (dimension === "role") keys.add("orchestrator");
  for (const agent of projection.allLiveAgents) {
    if (
      extraFilter.workspace !== undefined &&
      (agent.workspace ?? UNATTRIBUTED_DIMENSION) !==
        (extraFilter.workspace ?? UNATTRIBUTED_DIMENSION)
    )
      continue;
    if (dimension === "role") keys.add(agent.role ?? UNATTRIBUTED_DIMENSION);
    else if (dimension === "origin")
      keys.add(agent.origin ?? UNATTRIBUTED_DIMENSION);
    else if (dimension === "provider" && agent.provider)
      keys.add(agent.provider);
    else if (dimension === "model" && agent.provider && agent.model) {
      keys.add(
        agent.model.startsWith(`${agent.provider}/`)
          ? agent.model
          : `${agent.provider}/${agent.model}`
      );
    } else if (dimension === "workspace")
      keys.add(agent.workspace ?? UNATTRIBUTED_DIMENSION);
  }
  return keys;
}

function addMissingLiveSnapshotKeys(
  result: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  >,
  keys: Set<string>,
  dimension: string,
  projection: LiveAgentsProjection,
  extraFilter: Record<string, unknown>
): void {
  for (const key of keys) {
    if (result[key]) continue;
    const active = projection.allLiveAgents.filter((agent) =>
      matchesProjectedAgent(agent, dimension, key, extraFilter)
    ).length;
    if (active > 0 || (dimension === "role" && key === "orchestrator")) {
      result[key] = { ...emptyUsageBucket(), active, averageDurationMs: 0 };
    }
  }
}

export function usageSnapshot(
  collection: Record<string, UsageBucket> | undefined,
  dimension: string,
  projection: LiveAgentsProjection,
  extraFilter: Record<string, unknown> = {}
): Record<string, UsageBucket & { active: number; averageDurationMs: number }> {
  const result: Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  > = {};
  populateUsageSnapshot(result, collection, dimension, projection, extraFilter);
  addMissingLiveSnapshotKeys(
    result,
    liveSnapshotKeys(dimension, projection, extraFilter),
    dimension,
    projection,
    extraFilter
  );
  return result;
}

function withoutActive(bucket: UsageBucket): Omit<UsageBucket, "active"> {
  const { active: _active, ...copy } = bucket;
  return copy;
}

function withoutWorkspaceTransientFields(
  bucket: WorkspaceUsageBucket
): Omit<
  WorkspaceUsageBucket,
  "active" | "tools" | "skills" | "bridgeObservations" | "mcpExposed"
> {
  const {
    active: _active,
    tools: _tools,
    skills: _skills,
    bridgeObservations: _bridgeObservations,
    mcpExposed: _mcpExposed,
    ...copy
  } = bucket;
  return copy;
}

export class UsageTracker {
  readonly roleNames: readonly string[];
  activityTracker: AgentActivityTracker | null;
  readonly usageTelemetry: UsageTelemetryState;
  readonly inFlightUsage: Map<
    string,
    { startedAt: number; buckets: UsageBucket[] }
  >;
  // Ephemeral per-agent (per-thread) cumulative usage, keyed by subject.
  // Not part of usageTelemetry, never persisted, and pruned to the live
  // subject set whenever activeUsageSnapshot() is called.
  private readonly activeUsageBySubject: Map<string, SubjectUsageAccumulator>;
  readonly workspaceIdRegistry: Map<string, string>;
  readonly workspaceIdConflicts: Set<string>;
  readonly attributionDiagnostics: AttributionDiagnostics;

  constructor(options: UsageTrackerOptions = {}) {
    this.roleNames = options.roleNames ?? ROLE_NAMES;
    this.activityTracker = options.activityTracker ?? null;
    this.usageTelemetry = {
      totals: emptyUsageBucket(),
      byRole: Object.fromEntries(
        this.roleNames.map((role) => [role, emptyUsageBucket()])
      ),
      byModel: {},
      byOrigin: {},
      byWorkspace: {}
    };
    this.inFlightUsage = new Map();
    this.activeUsageBySubject = new Map();
    this.workspaceIdRegistry = new Map();
    this.workspaceIdConflicts = new Set();
    this.attributionDiagnostics = {
      total: 0,
      attributed: 0,
      unattributed: 0,
      byReason: {
        missing_workspace: 0,
        unknown_workspace_id: 0,
        ambiguous_resource: 0,
        missing_provider: 0,
        missing_model: 0
      },
      bySource: {
        datapoint: 0,
        resource: 0
      },
      unknownWorkspaceIds: new Set()
    };
  }

  setActivityTracker(tracker: AgentActivityTracker): void {
    this.activityTracker = tracker;
  }

  usageBucket(
    collection: Record<string, UsageBucket>,
    key: string
  ): UsageBucket {
    return usageBucket(collection, key);
  }

  workspaceBucket(
    collectionOrKey: Record<string, WorkspaceUsageBucket> | string,
    keyOrCwd?: string | null,
    cwd: string | null = null
  ): WorkspaceUsageBucket {
    if (typeof collectionOrKey === "string") {
      return workspaceBucket(
        this.usageTelemetry.byWorkspace,
        collectionOrKey,
        keyOrCwd ?? null
      );
    }
    return workspaceBucket(collectionOrKey, keyOrCwd!, cwd);
  }

  workspaceMcpBucket(
    wsBucket: WorkspaceUsageBucket,
    server: string
  ): WorkspaceMcpEntry {
    return workspaceMcpBucket(wsBucket, server);
  }

  workspaceToolBucket(
    wsBucket: WorkspaceUsageBucket,
    attributes: Record<string, unknown>
  ): WorkspaceTool {
    return workspaceToolBucket(wsBucket, attributes);
  }

  workspaceSkillBucket(
    wsBucket: WorkspaceUsageBucket,
    skillName: string
  ): WorkspaceSkill {
    return workspaceSkillBucket(wsBucket, skillName);
  }

  registerWorkspaceId(workspaceId: unknown, workspaceKey: unknown): boolean {
    if (
      typeof workspaceId !== "string" ||
      !workspaceId.trim() ||
      typeof workspaceKey !== "string" ||
      !workspaceKey.trim()
    ) {
      return false;
    }
    const id = safeWorkspaceId(workspaceId);
    const key = workspaceKey.trim();
    const existing = this.workspaceIdRegistry.get(id);
    if (this.workspaceIdConflicts.has(id)) return false;
    if (existing && existing !== key) {
      this.workspaceIdRegistry.delete(id);
      this.workspaceIdConflicts.add(id);
      return false;
    }
    this.workspaceIdRegistry.set(id, key);
    return true;
  }

  attributionDiagnosticsStatus(): AttributionDiagnosticsStatus {
    return {
      total: this.attributionDiagnostics.total,
      attributed: this.attributionDiagnostics.attributed,
      unattributed: this.attributionDiagnostics.unattributed,
      byReason: { ...this.attributionDiagnostics.byReason },
      bySource: { ...this.attributionDiagnostics.bySource },
      unknownWorkspaceIds: [...this.attributionDiagnostics.unknownWorkspaceIds]
    };
  }

  resetAttributionDiagnostics(): void {
    this.attributionDiagnostics.total = 0;
    this.attributionDiagnostics.attributed = 0;
    this.attributionDiagnostics.unattributed = 0;
    this.attributionDiagnostics.byReason = {
      missing_workspace: 0,
      unknown_workspace_id: 0,
      ambiguous_resource: 0,
      missing_provider: 0,
      missing_model: 0
    };
    this.attributionDiagnostics.bySource = {
      datapoint: 0,
      resource: 0
    };
    this.attributionDiagnostics.unknownWorkspaceIds.clear();
  }

  recordAttributionDiagnostic({
    attributed,
    source,
    reason,
    unknownWorkspaceId
  }: {
    attributed: boolean;
    source?: "datapoint" | "resource";
    reason?:
      | "missing_workspace"
      | "unknown_workspace_id"
      | "ambiguous_resource"
      | "missing_provider"
      | "missing_model";
    unknownWorkspaceId?: string;
  }): void {
    this.attributionDiagnostics.total += 1;
    if (attributed) {
      this.attributionDiagnostics.attributed += 1;
      if (source) {
        this.attributionDiagnostics.bySource[source] += 1;
      }
    } else {
      this.attributionDiagnostics.unattributed += 1;
      if (reason) {
        this.attributionDiagnostics.byReason[reason] += 1;
      }
      if (unknownWorkspaceId) {
        this.attributionDiagnostics.unknownWorkspaceIds.delete(
          unknownWorkspaceId
        );
        this.attributionDiagnostics.unknownWorkspaceIds.add(unknownWorkspaceId);
        while (
          this.attributionDiagnostics.unknownWorkspaceIds.size >
          MAX_UNKNOWN_WORKSPACE_IDS
        ) {
          const oldest = this.attributionDiagnostics.unknownWorkspaceIds
            .values()
            .next().value;
          if (oldest !== undefined) {
            this.attributionDiagnostics.unknownWorkspaceIds.delete(oldest);
          }
        }
      }
    }
  }

  recordMissingProviderDiagnostic(count: number = 1): void {
    this.attributionDiagnostics.byReason.missing_provider += count;
  }

  recordMissingModelDiagnostic(count: number = 1): void {
    this.attributionDiagnostics.byReason.missing_model += count;
  }

  recordUsageEvent({
    phase,
    requestId,
    role,
    provider,
    model,
    workspace = null,
    outcome,
    failureClass = null,
    status = null,
    elapsedMs,
    toolCalls = 0,
    timestamp,
    origin: originOverride = null,
    subject = null
  }: RecordUsageEventParams): void {
    const buckets = this.collectUsageBuckets({
      role,
      provider,
      model,
      workspace,
      origin: originOverride,
      subject
    });
    const key = usageKey(requestId, provider, model);
    if (phase === "selected") {
      this.recordSelectedPhase(key, buckets, timestamp);
      return;
    }
    if (phase === "skipped") {
      this.recordSkippedPhase(buckets);
      return;
    }
    if (phase !== "result") return;
    this.recordResultPhase({
      key,
      buckets,
      outcome,
      elapsedMs,
      toolCalls,
      timestamp,
      failureClass,
      status
    });
  }

  private collectUsageBuckets({
    role,
    provider,
    model,
    workspace,
    origin: originOverride,
    subject = null
  }: {
    role: RecordUsageEventParams["role"];
    provider: RecordUsageEventParams["provider"];
    model: RecordUsageEventParams["model"];
    workspace: RecordUsageEventParams["workspace"];
    origin: RecordUsageEventParams["origin"];
    subject?: RecordUsageEventParams["subject"];
  }): UsageBucket[] {
    const workspaceContext =
      typeof workspace === "string" ? { key: workspace, cwd: null } : workspace;
    const origin = originOverride ?? usageOrigin(role, provider);
    const roleKey =
      role ?? (origin === "orchestrator" ? "orchestrator" : "unattributed");
    const modelKey = `${provider}/${model}`;
    const buckets: UsageBucket[] = [
      this.usageTelemetry.totals,
      usageBucket(this.usageTelemetry.byRole, roleKey),
      usageBucket(this.usageTelemetry.byModel, modelKey),
      usageBucket(this.usageTelemetry.byOrigin, origin)
    ];
    if (subject) {
      const activeSnapshot = this.subjectUsageSnapshot(subject);
      buckets.push(
        activeSnapshot.totals,
        usageBucket(activeSnapshot.byRole, roleKey),
        usageBucket(activeSnapshot.byModel, modelKey),
        usageBucket(activeSnapshot.byOrigin, origin)
      );
      if (workspaceContext?.key) {
        const workspaceAccumulator = this.subjectWorkspaceAccumulator(
          activeSnapshot,
          workspaceContext.key,
          workspaceContext.cwd ?? null
        );
        buckets.push(
          workspaceAccumulator.bucket,
          usageBucket(workspaceAccumulator.byRole, roleKey),
          usageBucket(workspaceAccumulator.byModel, modelKey)
        );
      }
    }
    if (!workspaceContext?.key) return buckets;
    if (workspaceContext.workspace_id) {
      this.registerWorkspaceId(
        workspaceContext.workspace_id,
        workspaceContext.key
      );
    }
    const workspaceUsage = workspaceBucket(
      this.usageTelemetry.byWorkspace,
      workspaceContext.key,
      workspaceContext.cwd
    );
    buckets.push(
      workspaceUsage,
      ...workspaceDimensionBuckets(workspaceUsage, {
        role: role ?? (origin === "orchestrator" ? "orchestrator" : null),
        provider,
        model
      })
    );
    return buckets;
  }

  private subjectUsageSnapshot(subject: string): SubjectUsageAccumulator {
    let snapshot = this.activeUsageBySubject.get(subject);
    if (snapshot) {
      // Keep recently active subjects at the end of the bounded map so that
      // older inactive identities are the first to leave if no status polls
      // are available to prune them.
      this.activeUsageBySubject.delete(subject);
    } else {
      while (this.activeUsageBySubject.size >= MAX_ACTIVE_USAGE_SUBJECTS) {
        const oldest = this.activeUsageBySubject.keys().next().value;
        if (oldest === undefined) break;
        this.activeUsageBySubject.delete(oldest);
      }
      snapshot = {
        totals: emptyUsageBucket(),
        byRole: {},
        byModel: {},
        byOrigin: {},
        byWorkspace: {},
        skillUses: 0,
        bySkill: new Map()
      };
    }
    this.activeUsageBySubject.set(subject, snapshot);
    return snapshot;
  }

  private subjectWorkspaceAccumulator(
    snapshot: SubjectUsageAccumulator,
    key: string,
    cwd: string | null
  ): SubjectWorkspaceAccumulator {
    let workspaceAccumulator = snapshot.byWorkspace[key];
    if (!workspaceAccumulator) {
      workspaceAccumulator = {
        bucket: emptyUsageBucket(),
        cwd,
        byRole: {},
        byModel: {},
        skillUses: 0,
        bySkill: new Map()
      };
      snapshot.byWorkspace[key] = workspaceAccumulator;
    } else if (!workspaceAccumulator.cwd && cwd) {
      workspaceAccumulator.cwd = cwd;
    }
    return workspaceAccumulator;
  }

  /** Add a confirmed skill use to the exact live thread/workspace projection. */
  recordAgentSkillUse(
    subject: unknown,
    workspace: unknown,
    skill: unknown,
    count: number = 1
  ): void {
    if (
      typeof subject !== "string" ||
      !subject.trim() ||
      subject === UNATTRIBUTED_DIMENSION ||
      typeof skill !== "string" ||
      !skill.trim() ||
      !Number.isFinite(count) ||
      count <= 0
    ) {
      return;
    }
    const snapshot = this.subjectUsageSnapshot(subject.trim());
    const skillName = safeMetricLabel(skill, "unknown");
    snapshot.skillUses += count;
    snapshot.bySkill.set(
      skillName,
      (snapshot.bySkill.get(skillName) ?? 0) + count
    );
    if (
      typeof workspace !== "string" ||
      !workspace.trim() ||
      workspace === UNATTRIBUTED_DIMENSION
    ) {
      return;
    }
    const row = this.subjectWorkspaceAccumulator(
      snapshot,
      workspace.trim(),
      null
    );
    row.skillUses += count;
    row.bySkill.set(skillName, (row.bySkill.get(skillName) ?? 0) + count);
  }

  private recordSelectedPhase(
    key: string,
    buckets: UsageBucket[],
    timestamp: string
  ): void {
    this.inFlightUsage.set(key, { startedAt: Date.now(), buckets });
    for (const bucket of buckets) {
      bucket.attempts += 1;
      bucket.lastUsedAt = timestamp;
    }
  }

  private recordSkippedPhase(buckets: UsageBucket[]): void {
    for (const bucket of buckets) bucket.skipped += 1;
  }

  private recordResultPhase({
    key,
    buckets,
    outcome,
    elapsedMs,
    toolCalls,
    timestamp,
    failureClass,
    status
  }: {
    key: string;
    buckets: UsageBucket[];
    outcome: RecordUsageEventParams["outcome"];
    elapsedMs: RecordUsageEventParams["elapsedMs"];
    toolCalls: number;
    timestamp: string;
    failureClass: RecordUsageEventParams["failureClass"];
    status: RecordUsageEventParams["status"];
  }): void {
    const active = this.inFlightUsage.get(key);
    const duration = this.resolveUsageDuration(elapsedMs, active);
    const resultBuckets = active?.buckets ?? buckets;
    for (const bucket of resultBuckets) {
      this.applyUsageResultToBucket({
        bucket,
        outcome,
        duration,
        toolCalls,
        timestamp,
        failureClass,
        status
      });
    }
    this.inFlightUsage.delete(key);
  }

  private resolveUsageDuration(
    elapsedMs: RecordUsageEventParams["elapsedMs"],
    active: { startedAt: number; buckets: UsageBucket[] } | undefined
  ): number {
    if (Number.isFinite(elapsedMs)) {
      return Math.max(0, elapsedMs!);
    }
    if (!active) return 0;
    return Math.max(0, Date.now() - active.startedAt);
  }

  private applyUsageResultToBucket({
    bucket,
    outcome,
    duration,
    toolCalls,
    timestamp,
    failureClass,
    status
  }: {
    bucket: UsageBucket;
    outcome: RecordUsageEventParams["outcome"];
    duration: number;
    toolCalls: number;
    timestamp: string;
    failureClass: RecordUsageEventParams["failureClass"];
    status: RecordUsageEventParams["status"];
  }): void {
    if (outcome === "success") bucket.successes += 1;
    else bucket.failures += 1;
    bucket.durationMs += duration;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, duration);
    bucket.toolCalls +=
      Number.isInteger(toolCalls) && toolCalls > 0 ? toolCalls : 0;
    if (outcome !== "success") {
      bucket.lastFailure = {
        timestamp,
        ...(failureClass === undefined ? {} : { class: failureClass }),
        ...(status === undefined ? {} : { status })
      };
    }
  }

  resetUsageTelemetry(): void {
    this.usageTelemetry.totals = emptyUsageBucket();
    this.usageTelemetry.byRole = Object.fromEntries(
      this.roleNames.map((role) => [role, emptyUsageBucket()])
    );
    this.usageTelemetry.byModel = {};
    this.usageTelemetry.byOrigin = {};
    this.usageTelemetry.byWorkspace = {};
    this.inFlightUsage.clear();
    this.activeUsageBySubject.clear();
    this.workspaceIdRegistry.clear();
    this.workspaceIdConflicts.clear();
    this.resetAttributionDiagnostics();
  }

  clearWorkspaceCapabilities(): void {
    for (const bucket of Object.values(this.usageTelemetry.byWorkspace)) {
      bucket.tools?.clear();
      bucket.skills?.clear();
      bucket.mcpExposed?.clear();
      bucket.skillUses = 0;
      bucket.toolsCapable = false;
      bucket.skillsCapable = false;
      bucket.mcpCapable = false;
    }
  }

  /**
   * Returns a merged route/skill usage projection for the currently live
   * `subjects` (router thread identities). This ephemeral view survives
   * eviction from global event rings while an agent remains live; it is never
   * persisted and does not affect All/lifetime usage or wall-clock lookbacks.
   * Any tracked subject not present in `subjects` is pruned as part of this
   * call.
   */
  activeUsageSnapshot(subjects: readonly string[]): UsageActiveSnapshot {
    const live = new Set(
      subjects.flatMap((subject) => [subject, safeAgentIdentity(subject)])
    );
    for (const key of this.activeUsageBySubject.keys()) {
      if (!live.has(key)) this.activeUsageBySubject.delete(key);
    }
    const combined: SubjectUsageAccumulator = {
      totals: emptyUsageBucket(),
      byRole: {},
      byModel: {},
      byOrigin: {},
      byWorkspace: {},
      skillUses: 0,
      bySkill: new Map()
    };
    for (const subject of live) {
      const snapshot = this.activeUsageBySubject.get(subject);
      if (!snapshot) continue;
      mergeUsageBucketInto(combined.totals, snapshot.totals);
      mergeUsageBucketMapInto(combined.byRole, snapshot.byRole);
      mergeUsageBucketMapInto(combined.byModel, snapshot.byModel);
      mergeUsageBucketMapInto(combined.byOrigin, snapshot.byOrigin);
      mergeSubjectWorkspaceInto(combined.byWorkspace, snapshot.byWorkspace);
      combined.skillUses += snapshot.skillUses;
      for (const [skill, count] of snapshot.bySkill) {
        combined.bySkill.set(skill, (combined.bySkill.get(skill) ?? 0) + count);
      }
    }
    return {
      totals: withAverageDuration(combined.totals),
      byRole: Object.fromEntries(
        Object.entries(combined.byRole).map(([key, bucket]) => [
          key,
          withAverageDuration(bucket)
        ])
      ),
      byModel: Object.fromEntries(
        Object.entries(combined.byModel).map(([key, bucket]) => [
          key,
          withAverageDuration(bucket)
        ])
      ),
      byOrigin: Object.fromEntries(
        Object.entries(combined.byOrigin).map(([key, bucket]) => [
          key,
          withAverageDuration(bucket)
        ])
      ),
      byWorkspace: Object.fromEntries(
        Object.entries(combined.byWorkspace).map(([key, accumulator]) => [
          key,
          {
            ...withAverageDuration(accumulator.bucket),
            cwd: accumulator.cwd,
            byRole: Object.fromEntries(
              Object.entries(accumulator.byRole).map(([roleKey, bucket]) => [
                roleKey,
                withAverageDuration(bucket)
              ])
            ),
            byModel: Object.fromEntries(
              Object.entries(accumulator.byModel).map(([modelKey, bucket]) => [
                modelKey,
                withAverageDuration(bucket)
              ])
            ),
            skillUses: accumulator.skillUses,
            bySkill: Array.from(accumulator.bySkill, ([skill, count]) => ({
              skill,
              count
            })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
          }
        ])
      ),
      skillUses: combined.skillUses,
      bySkill: Array.from(combined.bySkill, ([skill, count]) => ({
        skill,
        count
      })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
    };
  }

  projectLiveAgents(
    at: number = Date.now(),
    tracker?: AgentActivityTracker
  ): LiveAgentsProjection {
    const activityTracker = tracker ?? this.activityTracker;
    const directAgents: LiveAgentActivity[] = activityTracker
      ? activityTracker.listLive({}, at)
      : [];

    const allLiveAgents: ProjectedAgent[] = directAgents.map((a) => ({
      ...a,
      origin: a.origin ?? usageOrigin(a.role, a.provider)
    }));

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const byWorkspace: Record<string, number> = {};

    for (const agent of allLiveAgents) {
      if (agent.provider) {
        const pKey = agent.provider;
        byProvider[pKey] = (byProvider[pKey] ?? 0) + 1;
      }

      if (agent.provider && agent.model) {
        const mKey = agent.model.startsWith(`${agent.provider}/`)
          ? agent.model
          : `${agent.provider}/${agent.model}`;
        byModel[mKey] = (byModel[mKey] ?? 0) + 1;
      }

      const rKey = agent.role ?? UNATTRIBUTED_DIMENSION;
      byRole[rKey] = (byRole[rKey] ?? 0) + 1;

      const oKey = agent.origin ?? UNATTRIBUTED_DIMENSION;
      byOrigin[oKey] = (byOrigin[oKey] ?? 0) + 1;

      const wKey = agent.workspace ?? UNATTRIBUTED_DIMENSION;
      byWorkspace[wKey] = (byWorkspace[wKey] ?? 0) + 1;
    }

    return {
      at,
      directAgents,
      allLiveAgents,
      canonicalTotal: allLiveAgents.length,
      missingProvider: allLiveAgents.filter((agent) => !agent.provider).length,
      missingModel: allLiveAgents.filter((agent) => !agent.model).length,
      byProvider,
      byModel,
      byRole,
      byOrigin,
      byWorkspace
    };
  }

  canonicalLiveAgentCount(
    at: number = Date.now(),
    tracker?: AgentActivityTracker
  ): number {
    return this.projectLiveAgents(at, tracker).canonicalTotal;
  }

  countLiveAgentActivity(
    filter: Parameters<AgentActivityTracker["countLive"]>[0] = {},
    at: number = Date.now(),
    tracker?: AgentActivityTracker,
    exceptSubject: string | null = null
  ): number {
    const activityTracker = tracker ?? this.activityTracker;
    if (!activityTracker) return 0;
    return (AGENT_ACTIVITY_KINDS as readonly string[]).reduce(
      (total, kind) =>
        total +
        (exceptSubject === null
          ? activityTracker.countLive({ ...filter, kind }, at)
          : activityTracker
              .listLive({ ...filter, kind }, at)
              .filter(({ subject }) => subject !== exceptSubject).length),
      0
    );
  }

  usageSnapshot(
    collection: Record<string, UsageBucket> | undefined,
    dimension: string,
    projection?: LiveAgentsProjection,
    extraFilter: Record<string, unknown> = {},
    tracker?: AgentActivityTracker
  ): Record<
    string,
    UsageBucket & { active: number; averageDurationMs: number }
  > {
    const proj = projection ?? this.projectLiveAgents(Date.now(), tracker);
    return usageSnapshot(collection, dimension, proj, extraFilter);
  }

  usageStatus(
    now: number = Date.now(),
    projection?: LiveAgentsProjection,
    tracker?: AgentActivityTracker
  ): UsageStatus {
    const activityTracker = tracker ?? this.activityTracker;
    const proj =
      projection ?? this.projectLiveAgents(now, activityTracker ?? undefined);
    const at = proj.at;
    const rawActivity = activityTracker
      ? activityTracker.snapshot(at)
      : {
          total: 0,
          live: 0,
          byKind: {},
          byState: Object.fromEntries(
            (AGENT_ACTIVITY_STATES as readonly string[]).map((s) => [s, 0])
          ),
          list: []
        };
    const byRole = usageSnapshot(this.usageTelemetry.byRole, "role", proj);
    const byModel = usageSnapshot(this.usageTelemetry.byModel, "model", proj);
    const byOrigin = usageSnapshot(
      this.usageTelemetry.byOrigin,
      "origin",
      proj
    );

    const activity = rawActivity;

    const workspaceKeys = new Set([
      ...Object.keys(this.usageTelemetry.byWorkspace),
      ...Object.keys(proj.byWorkspace).filter(
        (k) => (proj.byWorkspace[k] ?? 0) > 0
      )
    ]);

    const byWorkspace = Object.fromEntries(
      Array.from(workspaceKeys, (key) => {
        const bucket: WorkspaceUsageBucket = this.usageTelemetry.byWorkspace[
          key
        ] ?? {
          ...emptyUsageBucket(),
          cwd: null,
          skillUses: 0,
          byRole: {},
          byModel: {},
          byProvider: {},
          byMcp: {},
          tools: new Map(),
          skills: new Map(),
          toolsUnattributed: 0,
          skillsUnattributed: 0,
          toolsExecuted: 0,
          toolsRequested: 0,
          toolsUnavailable: 0,
          skillsExposed: 0,
          toolsCapable: false,
          skillsCapable: false,
          mcpCapable: false,
          mcpExposed: new Map(),
          bridgeObservations: {
            tools: new Map(),
            skills: new Map()
          }
        };
        const {
          tools,
          skills,
          bridgeObservations,
          mcpExposed,
          toolsCapable: _toolsCapable,
          skillsCapable: _skillsCapable,
          mcpCapable: _mcpCapable,
          ...publicBucket
        } = bucket;
        const toolsCapable =
          bucket.toolsCapable === true ||
          (bucket.toolsExecuted ?? 0) > 0 ||
          (bucket.toolsRequested ?? 0) > 0 ||
          (bucket.toolsUnavailable ?? 0) > 0;
        const skillsCapable =
          bucket.skillsCapable === true || (bucket.skillsExposed ?? 0) > 0;
        const formatBridgeTools = (
          map: Map<string, WorkspaceBridgeTool> | undefined
        ) =>
          map
            ? Array.from(map.values(), (entry) => ({
                ...entry,
                byStatus: { ...entry.byStatus }
              })).sort((a, b) => STRING_COLLATOR.compare(a.tool, b.tool))
            : [];
        const formatBridgeSkills = (map: Map<string, number> | undefined) =>
          map
            ? Array.from(map.entries(), ([skill, value]) => ({
                skill,
                count: value
              })).sort((a, b) => STRING_COLLATOR.compare(a.skill, b.skill))
            : [];
        return [
          key,
          {
            ...publicBucket,
            active: proj.byWorkspace[key] ?? 0,
            averageDurationMs:
              bucket.successes + bucket.failures > 0
                ? Math.round(
                    bucket.durationMs / (bucket.successes + bucket.failures)
                  )
                : 0,
            skillUses: bucket.skillUses ?? 0,
            byRole: usageSnapshot(bucket.byRole, "role", proj, {
              workspace: key
            }),
            byModel: usageSnapshot(bucket.byModel, "model", proj, {
              workspace: key
            }),
            byProvider: usageSnapshot(bucket.byProvider, "provider", proj, {
              workspace: key
            }),
            byMcp: bucket.mcpCapable ? { ...bucket.byMcp } : null,
            mcpExposed: bucket.mcpCapable
              ? formatWorkspaceMcpExposed(mcpExposed)
              : null,
            mcpUses: bucket.mcpCapable
              ? formatWorkspaceMcpUses(bucket.byMcp)
              : null,
            toolsUnattributed: bucket.toolsUnattributed ?? 0,
            skillsUnattributed: bucket.skillsUnattributed ?? 0,
            toolsExecuted: bucket.toolsExecuted ?? 0,
            toolsRequested: bucket.toolsRequested ?? 0,
            toolsUnavailable: bucket.toolsUnavailable ?? 0,
            skillsExposed: bucket.skillsExposed ?? 0,
            ...(toolsCapable
              ? { byTool: formatWorkspaceTools(tools) }
              : { byTool: null }),
            ...(skillsCapable
              ? { bySkill: formatWorkspaceSkills(skills) }
              : { bySkill: null }),
            ...(bridgeObservations &&
            (bridgeObservations.tools?.size > 0 ||
              bridgeObservations.skills?.size > 0)
              ? {
                  bridgeTools: formatBridgeTools(bridgeObservations.tools),
                  bridgeSkills: formatBridgeSkills(bridgeObservations.skills)
                }
              : {})
          }
        ];
      })
    );

    return {
      activity,
      totals: {
        ...this.usageTelemetry.totals,
        active: proj.canonicalTotal,
        averageDurationMs:
          this.usageTelemetry.totals.successes +
            this.usageTelemetry.totals.failures >
          0
            ? Math.round(
                this.usageTelemetry.totals.durationMs /
                  (this.usageTelemetry.totals.successes +
                    this.usageTelemetry.totals.failures)
              )
            : 0
      },
      byRole,
      byModel,
      byOrigin,
      byWorkspace
    };
  }

  usagePersistenceSnapshot(): UsagePersistenceSnapshot {
    return {
      schemaVersion: 8,
      totals: withoutActive(this.usageTelemetry.totals),
      byRole: Object.fromEntries(
        Object.entries(this.usageTelemetry.byRole).map(([key, bucket]) => [
          key,
          withoutActive(bucket)
        ])
      ),
      byModel: Object.fromEntries(
        Object.entries(this.usageTelemetry.byModel).map(([key, bucket]) => [
          key,
          withoutActive(bucket)
        ])
      ),
      byOrigin: Object.fromEntries(
        Object.entries(this.usageTelemetry.byOrigin).map(([key, bucket]) => [
          key,
          withoutActive(bucket)
        ])
      ),
      byWorkspace: Object.fromEntries(
        Object.entries(this.usageTelemetry.byWorkspace).map(([key, bucket]) => [
          key,
          {
            ...withoutWorkspaceTransientFields(bucket),
            skillUses: bucket.skillUses ?? 0,
            toolsUnattributed: bucket.toolsUnattributed ?? 0,
            skillsUnattributed: bucket.skillsUnattributed ?? 0,
            toolsExecuted: bucket.toolsExecuted ?? 0,
            toolsRequested: bucket.toolsRequested ?? 0,
            toolsUnavailable: bucket.toolsUnavailable ?? 0,
            skillsExposed: bucket.skillsExposed ?? 0,
            byMcp: { ...bucket.byMcp },
            mcpExposed: formatWorkspaceMcpExposed(bucket.mcpExposed),
            byRole: Object.fromEntries(
              Object.entries(bucket.byRole).map(([name, value]) => [
                name,
                withoutActive(value)
              ])
            ),
            byModel: Object.fromEntries(
              Object.entries(bucket.byModel).map(([name, value]) => [
                name,
                withoutActive(value)
              ])
            ),
            byProvider: Object.fromEntries(
              Object.entries(bucket.byProvider).map(([name, value]) => [
                name,
                withoutActive(value)
              ])
            ),
            byTool: Array.from(bucket.tools?.values() ?? [], (t) => ({
              ...t,
              byStatus: { ...t.byStatus }
            })),
            bySkill: Array.from(bucket.skills?.values() ?? [], (s) => ({
              ...s,
              byStatus: { ...s.byStatus },
              byInvokeType: { ...s.byInvokeType },
              byAgentKind: { ...s.byAgentKind },
              byModel: { ...s.byModel },
              byPlugin: { ...s.byPlugin }
            })),
            bridgeTools: Array.from(
              bucket.bridgeObservations?.tools?.values() ?? [],
              (entry) => ({ ...entry, byStatus: { ...entry.byStatus } })
            ),
            bridgeSkills: Array.from(
              bucket.bridgeObservations?.skills?.entries() ?? [],
              ([skill, count]) => ({ skill, count })
            )
          }
        ])
      ),
      workspaceRegistry: [...this.workspaceIdRegistry.entries()]
    };
  }

  restoreUsagePersistenceSnapshot(savedUsage: unknown): void {
    if (!isPlainRecord(savedUsage) || !isValidUsageSnapshot(savedUsage)) return;
    restoreWorkspaceRegistry(this, savedUsage);
    restoreUsageSections(this, savedUsage);
    restoreWorkspaceSnapshots(this, savedUsage);
    restoreUsageTotals(this, savedUsage);
  }
}

function isValidUsageSnapshot(saved: Record<string, unknown>): boolean {
  return saved.schemaVersion === 7 || saved.schemaVersion === 8;
}

function restoreWorkspaceRegistry(
  tracker: UsageTracker,
  saved: Record<string, unknown>
): void {
  const registry = saved.workspaceRegistry;
  if (!isUnknownArray(registry)) return;
  for (const entry of registry) {
    if (!isUnknownArray(entry)) continue;
    const [id, key] = entry;
    if (typeof id === "string" && typeof key === "string") {
      tracker.registerWorkspaceId(id, key);
    }
  }
}

function restoreUsageSections(
  tracker: UsageTracker,
  saved: Record<string, unknown>
): void {
  for (const section of ["byRole", "byModel", "byOrigin"] as const) {
    const values = saved[section];
    if (!isPlainRecord(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (!isPlainRecord(value)) continue;
      restoreUsageBucket(
        usageBucket(tracker.usageTelemetry[section], key),
        value
      );
    }
  }
}

function restoreWorkspaceSnapshots(
  tracker: UsageTracker,
  saved: Record<string, unknown>
): void {
  const workspaces = saved.byWorkspace;
  if (!isPlainRecord(workspaces)) return;
  for (const [key, value] of Object.entries(workspaces)) {
    if (!isPlainRecord(value)) continue;
    const workspace = workspaceBucket(
      tracker.usageTelemetry.byWorkspace,
      key,
      typeof value.cwd === "string" ? value.cwd : null
    );
    restoreUsageBucket(workspace, value);
    restoreWorkspaceCounters(workspace, value);
    restoreWorkspaceMcp(workspace, value);
    restoreWorkspaceBridgeData(workspace, value);
    restoreWorkspaceUsageDimensions(workspace, value);
  }
}

function restoreWorkspaceCounters(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  const skillUses = saved.skillUses;
  if (
    typeof skillUses === "number" &&
    Number.isInteger(skillUses) &&
    skillUses >= 0
  ) {
    current.skillUses = skillUses;
  }
  for (const counter of [
    "toolsUnattributed",
    "skillsUnattributed",
    "toolsExecuted",
    "toolsRequested",
    "toolsUnavailable",
    "skillsExposed"
  ] as const) {
    const value = saved[counter];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      current[counter] = value;
    }
  }
  for (const flag of ["toolsCapable", "skillsCapable", "mcpCapable"] as const) {
    if (saved[flag] === true) current[flag] = true;
  }
}

function restoreWorkspaceMcp(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  if (isPlainRecord(saved.byMcp)) {
    for (const [mcp, count] of Object.entries(saved.byMcp)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        current.byMcp[safeMetricLabel(mcp)] = count;
        current.mcpCapable = true;
      }
    }
  }
  const mcpExposed = saved.mcpExposed;
  if (!isUnknownArray(mcpExposed)) return;
  for (const row of mcpExposed) {
    if (!isPlainRecord(row)) continue;
    if (
      typeof row.server === "string" &&
      row.server.trim() &&
      typeof row.count === "number" &&
      row.count >= 0
    ) {
      const restored = workspaceMcpBucket(current, safeMetricLabel(row.server));
      restored.count = row.count;
      current.mcpCapable = true;
    }
  }
}

function restoreWorkspaceBridgeData(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  restoreWorkspaceBridgeTools(current, saved);
  restoreWorkspaceBridgeSkills(current, saved);
}

function restoreWorkspaceBridgeTools(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  const bridgeTools = saved.bridgeTools;
  if (!isUnknownArray(bridgeTools)) return;
  for (const tool of bridgeTools) {
    if (!isPlainRecord(tool) || typeof tool.tool !== "string") continue;
    const restored = {
      tool: safeMetricLabel(tool.tool),
      server:
        typeof tool.server === "string" ? safeMetricLabel(tool.server) : "",
      count: typeof tool.count === "number" && tool.count >= 0 ? tool.count : 0,
      byStatus: {} as Record<string, number>
    };
    restoreBridgeToolStatuses(restored, tool);
    current.bridgeObservations.tools.set(restored.tool, restored);
  }
}

function restoreBridgeToolStatuses(
  restored: { byStatus: Record<string, number> },
  tool: Record<string, unknown>
): void {
  if (!isPlainRecord(tool.byStatus)) return;
  for (const [status, count] of Object.entries(tool.byStatus)) {
    if (typeof count === "number" && count >= 0)
      restored.byStatus[safeMetricLabel(status)] = count;
  }
}

function restoreWorkspaceBridgeSkills(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  const bridgeSkills = saved.bridgeSkills;
  if (!isUnknownArray(bridgeSkills)) return;
  for (const skill of bridgeSkills) {
    if (!isPlainRecord(skill)) continue;
    if (
      typeof skill.skill === "string" &&
      typeof skill.count === "number" &&
      skill.count >= 0
    )
      current.bridgeObservations.skills.set(
        safeMetricLabel(skill.skill),
        skill.count
      );
  }
}

function restoreWorkspaceUsageDimensions(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  for (const section of ["byRole", "byModel", "byProvider"] as const) {
    const values = saved[section];
    if (!isPlainRecord(values)) continue;
    for (const [name, value] of Object.entries(values)) {
      if (!isPlainRecord(value)) continue;
      restoreUsageBucket(usageBucket(current[section], name), value);
    }
  }
  restoreWorkspaceTools(current, saved);
  restoreWorkspaceSkills(current, saved);
}

function restoreWorkspaceTools(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  const byTool = saved.byTool;
  if (!isUnknownArray(byTool)) return;
  for (const tool of byTool) {
    if (!isPlainRecord(tool) || typeof tool.tool !== "string") continue;
    const restored = {
      tool: safeMetricLabel(tool.tool, "unknown-tool"),
      source: safeMetricLabel(tool.source),
      server: toolServerAttribute({
        server: tool.server,
        mcp_server: tool.mcp_server
      }),
      count: 0,
      byStatus: {} as Record<string, number>,
      durationCount: 0,
      durationMs: 0
    };
    restoreToolCounters(restored, tool);
    current.tools.set(toolKey(restored), restored);
  }
}

function restoreToolCounters(
  restored: {
    count: number;
    durationCount: number;
    durationMs: number;
    byStatus: Record<string, number>;
  },
  tool: Record<string, unknown>
): void {
  for (const field of ["count", "durationCount", "durationMs"] as const)
    if (typeof tool[field] === "number" && tool[field] >= 0)
      restored[field] = tool[field];
  restoreBridgeToolStatuses(restored, tool);
}

function restoreWorkspaceSkills(
  current: WorkspaceUsageBucket,
  saved: Record<string, unknown>
): void {
  const bySkill = saved.bySkill;
  if (!isUnknownArray(bySkill)) return;
  for (const skill of bySkill) {
    if (!isPlainRecord(skill) || typeof skill.skill !== "string") continue;
    const restored = {
      skill: safeMetricLabel(skill.skill),
      total:
        typeof skill.total === "number" && skill.total >= 0 ? skill.total : 0,
      uses: typeof skill.uses === "number" && skill.uses >= 0 ? skill.uses : 0,
      byStatus: {},
      byInvokeType: {},
      byAgentKind: {},
      byModel: {},
      byPlugin: {}
    } as WorkspaceSkill;
    restoreSkillDimensions(restored, skill);
    current.skills.set(restored.skill, restored);
  }
}

function restoreSkillDimensions(
  restored: WorkspaceSkill,
  skill: Record<string, unknown>
): void {
  for (const dict of [
    "byStatus",
    "byInvokeType",
    "byAgentKind",
    "byModel",
    "byPlugin"
  ] as const) {
    const values = skill[dict];
    if (!isPlainRecord(values)) continue;
    for (const [key, count] of Object.entries(values))
      if (typeof count === "number" && count >= 0)
        restored[dict][safeMetricLabel(key)] = count;
  }
}

function restoreUsageTotals(
  tracker: UsageTracker,
  saved: Record<string, unknown>
): void {
  if (isPlainRecord(saved.totals))
    restoreUsageBucket(tracker.usageTelemetry.totals, saved.totals);
}

let defaultUsageTracker = new UsageTracker();

export function getDefaultUsageTracker(): UsageTracker {
  return defaultUsageTracker;
}

export function setDefaultUsageTracker(tracker: UsageTracker): void {
  defaultUsageTracker = tracker;
}

export const usageTelemetry = defaultUsageTracker.usageTelemetry;
export const inFlightUsage = defaultUsageTracker.inFlightUsage;
export const workspaceIdRegistry = defaultUsageTracker.workspaceIdRegistry;
export const workspaceIdConflicts = defaultUsageTracker.workspaceIdConflicts;
export const attributionDiagnostics =
  defaultUsageTracker.attributionDiagnostics;

export function registerWorkspaceId(
  workspaceId: unknown,
  workspaceKey: unknown
): boolean {
  return defaultUsageTracker.registerWorkspaceId(workspaceId, workspaceKey);
}

export function attributionDiagnosticsStatus(): AttributionDiagnosticsStatus {
  return defaultUsageTracker.attributionDiagnosticsStatus();
}

export function resetAttributionDiagnostics(): void {
  defaultUsageTracker.resetAttributionDiagnostics();
}

export function recordUsageEvent(params: RecordUsageEventParams): void {
  defaultUsageTracker.recordUsageEvent(params);
}

export function projectLiveAgents(
  at?: number,
  tracker?: AgentActivityTracker
): LiveAgentsProjection {
  return defaultUsageTracker.projectLiveAgents(at, tracker);
}

export function canonicalLiveAgentCount(
  at?: number,
  tracker?: AgentActivityTracker
): number {
  return defaultUsageTracker.canonicalLiveAgentCount(at, tracker);
}

export function countLiveAgentActivity(
  filter?: Parameters<AgentActivityTracker["countLive"]>[0],
  at?: number,
  tracker?: AgentActivityTracker,
  exceptSubject: string | null = null
): number {
  return defaultUsageTracker.countLiveAgentActivity(
    filter,
    at,
    tracker,
    exceptSubject
  );
}

export function usageStatus(
  now?: number,
  projection?: LiveAgentsProjection,
  tracker?: AgentActivityTracker
): UsageStatus {
  return defaultUsageTracker.usageStatus(now, projection, tracker);
}

export function usagePersistenceSnapshot(): UsagePersistenceSnapshot {
  return defaultUsageTracker.usagePersistenceSnapshot();
}

export function restoreUsagePersistenceSnapshot(savedUsage: unknown): void {
  defaultUsageTracker.restoreUsagePersistenceSnapshot(savedUsage);
}

export function resetUsageTelemetry(): void {
  defaultUsageTracker.resetUsageTelemetry();
}

export function clearWorkspaceCapabilities(): void {
  defaultUsageTracker.clearWorkspaceCapabilities();
}
