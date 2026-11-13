import { type AgentActivityTracker } from "@simulatorlife/autodev-runtime/agents";
import {
  getDefaultMcpProcessRegistry,
  registerLogical
} from "@simulatorlife/autodev-runtime/mcp/process-registry";
import { getDefaultConcurrencyManager } from "@simulatorlife/autodev-runtime/router/concurrency";
import {
  type LiveFeedCategory,
  type LiveFeedRecorder
} from "@simulatorlife/autodev-runtime/router/live-feed";

import {
  recordBridgeMcpExposure,
  recordBridgeSkillExposure,
  recordBridgeSkillFailed,
  recordBridgeSkillUsed,
  recordBridgeToolObservation
} from "./correlation.ts";
import { safeMetricLabel } from "./metric-label.ts";
import {
  type BridgeRequestContext,
  bridgeSubagentKey,
  closeBridgeSubagentUsage,
  getDefaultSubagentRegistry,
  lookupBridgeSessionContext,
  openBridgeSubagentUsage,
  recallBridgeSessionRequestId,
  recordSpawnFailure,
  recordSubagentSpawn,
  reportedChildren
} from "./subagents.ts";

const INGESTED_AGENT_EVENTS = Object.freeze(
  new Set([
    "subagent_spawn",
    "subagent_result",
    "subagent_tools_unavailable",
    "tool_executed",
    "tool_requested",
    "tool_unavailable",
    "skill_exposed",
    "skill_used",
    "skill_failed",
    "mcp_exposed",
    "activity",
    "heartbeat"
  ])
);

/**
 * The lifecycle facts a bridge may report: only what the router cannot see.
 *
 * The router settles every request itself (`endRequest`), from the response it
 * relays: whether it ended in a tool call, needs input, failed, or left live
 * children. A bridge's own `tool_wait`/`user_wait`/`finished`/`failed` for the
 * same request only repeat that -- late, over a separate channel, and about
 * the request rather than the agent -- so a per-response `finished` arriving
 * after the router had put the agent in `tool_wait` ended the agent between
 * two of its tool calls. What a bridge alone knows is its own in-CLI
 * delegation: `subagent_wait` while bridge-native children run, and `resumed`
 * once they report back. Heartbeats keep a long request visibly alive.
 */
const REPORTABLE_AGENT_ACTIVITY_STATES = Object.freeze(
  new Set(["subagent_wait", "resumed", "heartbeat"])
);

// Per-event helpers used by ingestAgentEvents. Each handles exactly one
// event type and reports any counters it changes back to the caller so
// cognitive complexity stays bounded.
function isValidAgentEvent(event: unknown): event is Record<string, unknown> {
  if (!event || typeof event !== "object") return false;
  return INGESTED_AGENT_EVENTS.has(
    (event as Record<string, unknown>).type as string
  );
}

function touchAgentActivity(
  { agentActivity }: AgentEventIngestDeps,
  context: BridgeRequestContext
): void {
  agentActivity.touch(context.activitySubject);
  if (context.sessionKey)
    getDefaultConcurrencyManager().touchOpenSubagentSlots(context.sessionKey);
}

function noteBridgeAgentActivity(
  { agentActivity }: AgentEventIngestDeps,
  state: string,
  context: BridgeRequestContext
): void {
  if (state === "subagent_wait") {
    agentActivity.noteSubagentWait(context.activitySubject, {
      provider: context.provider ?? null,
      model: context.model ?? null,
      role: context.role ?? null,
      workspace: context.workspace ?? null
    });
  } else {
    // `resumed` resolves a bridge-native delegation; it is a no-op for an
    // agent that was not waiting on one.
    agentActivity.noteSubagentResolved(context.activitySubject);
  }
}

function isHeartbeatAgentEvent(event: Record<string, unknown>): boolean {
  return (
    event.type === "heartbeat" ||
    (event.type === "activity" &&
      (event.state === "heartbeat" ||
        (typeof event.state === "string" &&
          event.state.trim() === "heartbeat")))
  );
}

function resolveIngestContext(requestId: string): BridgeRequestContext | null {
  let context = requestId
    ? getDefaultSubagentRegistry().getBridgeRequestContext(requestId)
    : undefined;
  if (!context && requestId) {
    const sessionKey = requestId;
    const sessionContext = lookupBridgeSessionContext(sessionKey);
    const sessionRequestId = recallBridgeSessionRequestId(sessionKey);
    if (sessionContext && sessionRequestId) {
      // Reported against the session itself, so it describes the session's
      // own agent, not whichever request of the session was noted last.
      context = { ...sessionContext, activitySubject: sessionKey };
    }
  }
  if (!context && requestId) {
    // Last-resort fallback: Codex Desktop child threads fire BeforeToolCall
    // hooks before the router has registered the session for the parent
    // /v1/responses request (and may never, in the case of a turn that
    // never opened one). When the registry has nothing under the request id
    // AND nothing under the session id, treat the post as belonging to the
    // workspace the hook stamped on the session. We attribute it to the
    // session key as the activity subject so the post lands in the right
    // workspace bucket instead of being silently dropped.
    const fallback = sessionFallbackContext(requestId);
    if (fallback) context = fallback;
  }
  return context ?? null;
}

/**
 * Best-effort session-id fallback for /v1/agent-events posts that arrive
 * before the router has had a chance to register the parent request.
 * Returns null when no workspace metadata can be recovered.
 */
function sessionFallbackContext(
  sessionKey: string
): BridgeRequestContext | null {
  // The registry only knows about request ids, but the post arrived keyed
  // on a Codex session id. Look up any workspace metadata cached against
  // that session and synthesize a minimal context.
  const remembered = lookupBridgeSessionContext(sessionKey);
  if (remembered) {
    return { ...remembered, activitySubject: sessionKey };
  }
  return null;
}

function applyAgentActivityEvent(
  deps: AgentEventIngestDeps,
  event: Record<string, unknown>,
  context: BridgeRequestContext,
  counters: AgentEventCounters
): void {
  const state = typeof event.state === "string" ? event.state.trim() : "";
  if (!REPORTABLE_AGENT_ACTIVITY_STATES.has(state)) {
    counters.rejected += 1;
    return;
  }
  noteBridgeAgentActivity(deps, state, context);
  counters.accepted += 1;
}

function closeSubagentResultUsage(
  event: Record<string, unknown>,
  requestId: string,
  counters: AgentEventCounters
): void {
  const outcome = event.outcome === "failure" ? "failure" : "success";
  const durationMs = Number.isFinite(event.durationMs)
    ? Math.max(0, event.durationMs as number)
    : null;
  for (const child of reportedChildren(event)) {
    if (
      closeBridgeSubagentUsage(bridgeSubagentKey(requestId, child.id), {
        outcome,
        elapsedMs: durationMs,
        failureClass: outcome === "failure" ? "subagent_failed" : null
      })
    ) {
      counters.closed += 1;
    }
  }
}

function recordSubagentSpawnUsage(
  event: Record<string, unknown>,
  context: BridgeRequestContext,
  requestId: string,
  counters: AgentEventCounters
): void {
  const role =
    typeof event.role === "string" && event.role.trim()
      ? safeMetricLabel(event.role)
      : null;
  const children = reportedChildren(event);
  const count = children.length;
  recordSubagentSpawn({
    mechanism: "bridge_native",
    provider: context.provider,
    role,
    status:
      typeof event.status === "string" && event.status.trim()
        ? safeMetricLabel(event.status)
        : "started",
    tool:
      typeof event.tool === "string" && event.tool.trim()
        ? safeMetricLabel(event.tool)
        : null,
    requestId,
    workspace: context.workspace ?? null,
    count
  });
  for (const child of children) {
    openBridgeSubagentUsage({
      requestId,
      context,
      role,
      childId: child.id,
      model: child.model
    });
  }
  counters.accepted += count;
}

function liveFeedCategoryForAgentEvent(type: string): LiveFeedCategory {
  if (type.startsWith("tool_")) return "tools";
  if (type.startsWith("skill_")) return "skills";
  if (type.startsWith("mcp_")) return "mcp";
  if (type.startsWith("hook_")) return "hooks";
  return "runtime";
}

function recordAgentLiveFeedEvent(
  { liveFeedEvents }: AgentEventIngestDeps,
  event: Record<string, unknown>,
  context: BridgeRequestContext,
  requestId: string
): void {
  const type = typeof event.type === "string" ? event.type : "agent_event";
  const tool = agentEventText(event, "tool");
  const skill = agentEventText(event, "skill");
  const server = agentEventText(event, "server");
  const hook = agentEventText(event, "hook_name");
  const name = tool ?? skill ?? server ?? hook;
  liveFeedEvents.record({
    category: liveFeedCategoryForAgentEvent(type),
    type,
    summary: name ? `${type}: ${name}` : type,
    timestamp: agentEventText(event, "timestamp"),
    requestId,
    provider: context.provider,
    model: context.model,
    role: context.role,
    workspace: context.workspace,
    phase: agentEventText(event, "phase"),
    outcome: agentEventText(event, "outcome"),
    status: agentEventStatus(event),
    failureClass: agentEventText(event, "failureClass"),
    durationMs: agentEventDuration(event),
    name,
    server,
    source: agentEventText(event, "source"),
    tool,
    skill,
    hook,
    handlerType: agentEventText(event, "handler_type")
  });
}

function agentEventText(
  event: Record<string, unknown>,
  key: string
): string | null {
  const value = event[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function agentEventStatus(
  event: Record<string, unknown>
): string | number | null {
  const status = event.status;
  if (typeof status === "string" && status.trim()) return status.trim();
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function agentEventDuration(event: Record<string, unknown>): number | null {
  const duration = Number(event.durationMs);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function applyMcpExposedEvent(
  event: Record<string, unknown>,
  context: BridgeRequestContext,
  requestId: string
): void {
  recordBridgeMcpExposure({ event, context, requestId });
  const server =
    typeof event.server === "string" && event.server.trim()
      ? event.server.trim()
      : null;
  const sessionKey = context.sessionKey ?? context.activitySubject;
  if (server && typeof sessionKey === "string" && sessionKey.trim()) {
    try {
      registerLogical(sessionKey, server, getDefaultMcpProcessRegistry());
    } catch {
      // Defensive: registration must never fail an ingest.
    }
  }
}

function applyAgentEvent(
  deps: AgentEventIngestDeps,
  event: Record<string, unknown>,
  context: BridgeRequestContext,
  requestId: string,
  counters: AgentEventCounters
): void {
  const type = event.type as string;
  recordAgentLiveFeedEvent(deps, event, context, requestId);
  if (type === "subagent_tools_unavailable") {
    recordSpawnFailure({
      requestId,
      role: null,
      requestedModel: context.model ?? null,
      reason: "spawn_tool_unavailable"
    });
    counters.unavailable += 1;
    return;
  }
  if (
    type === "tool_executed" ||
    type === "tool_requested" ||
    type === "tool_unavailable"
  ) {
    recordBridgeToolObservation({ event, context });
    touchAgentActivity(deps, context);
    return;
  }
  if (type === "skill_exposed") {
    recordBridgeSkillExposure({ event, context });
    return;
  }
  if (type === "skill_used") {
    if (recordBridgeSkillUsed({ event, context })) counters.accepted += 1;
    return;
  }
  if (type === "skill_failed") {
    if (recordBridgeSkillFailed({ event, context })) counters.accepted += 1;
    return;
  }
  if (type === "mcp_exposed") {
    applyMcpExposedEvent(event, context, requestId);
    return;
  }
  if (isHeartbeatAgentEvent(event)) {
    touchAgentActivity(deps, context);
    counters.accepted += 1;
    return;
  }
  if (type === "activity") {
    applyAgentActivityEvent(deps, event, context, counters);
    return;
  }
  if (type === "subagent_result") {
    closeSubagentResultUsage(event, requestId, counters);
    return;
  }
  // Default: bridge-native subagent_spawn reporting.
  recordSubagentSpawnUsage(event, context, requestId, counters);
}

type AgentEventCounters = {
  accepted: number;
  closed: number;
  unavailable: number;
  rejected: number;
};

function ingestAgentEvents(
  deps: AgentEventIngestDeps,
  payload: Record<string, unknown>
): AgentEventCounters & { reason: string | null } {
  const requestId =
    typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  const sessionId =
    typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  // The request id is the primary key, and the session id is the fallback:
  // the router's registry of live requests is in memory, so a restart loses
  // it while a long CLI turn keeps reporting against the request it started
  // with. The session outlives the restart.
  const context =
    resolveIngestContext(requestId) ??
    (sessionId ? resolveIngestContext(sessionId) : null);
  if (!context) {
    return {
      accepted: 0,
      closed: 0,
      unavailable: 0,
      rejected: Array.isArray(payload?.events) ? payload.events.length : 0,
      reason: "unknown_request_id"
    };
  }
  const events = Array.isArray(payload.events)
    ? (payload.events as Array<Record<string, unknown>>)
    : [];
  const counters: AgentEventCounters = {
    accepted: 0,
    closed: 0,
    unavailable: 0,
    rejected: 0
  };
  for (const event of events) {
    if (!isValidAgentEvent(event)) {
      counters.rejected += 1;
      continue;
    }
    applyAgentEvent(deps, event, context, requestId, counters);
  }
  return { ...counters, reason: null };
}

/** What the ingest needs from the router that owns the live agent state. */
export interface AgentEventIngestDeps {
  readonly agentActivity: AgentActivityTracker;
  readonly liveFeedEvents: LiveFeedRecorder;
}

/** The ingest of bridge-reported agent events, bound to the router's state. */
export function createAgentEventIngest(deps: AgentEventIngestDeps): (
  payload: Record<string, unknown>
) => AgentEventCounters & {
  reason: string | null;
} {
  return (payload) => ingestAgentEvents(deps, payload);
}
