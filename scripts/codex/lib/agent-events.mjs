/**
 * Reporting channel for subagents a provider bridge spawns inside its own CLI
 * runtime.
 *
 * A CLI-delegation bridge (Claude, Antigravity) does not emit a Codex
 * `function_call` when it delegates -- its CLI runs the child agent itself, and
 * the model router never sees a request for it. Without a report, an
 * orchestrator turn served by one of those providers shows zero subagents in
 * `/status` and the dashboard, which is indistinguishable from a provider that
 * refused to delegate at all.
 *
 * The router supplies everything needed per request: which tool names count as
 * a spawn for the provider serving this request, where to post, and the
 * request id that correlates the report. A bridge therefore needs no routing
 * config, no provider identity, and no router address of its own; and because
 * the request id is a router-generated UUID a bridge only learns by serving
 * the request, presenting it is also what authorizes the report.
 *
 * Two event types travel this channel. `subagent_spawn` opens a child; the
 * optional matching `subagent_result` closes it with the duration and outcome
 * the CLI actually observed. Reporting the close is what lets a CLI-delegated
 * child contribute a measured turn to the router's usage tables rather than
 * only a spawn count. It is optional because a bridge that never sends one --
 * or dies mid-turn -- must not strand an open child: the router closes any
 * child still open when the parent request finishes, using the parent's
 * outcome and the elapsed time since the spawn. Reporting the close only makes
 * the measurement per child instead of per parent turn.
 *
 * Children carry an `id` that is unique within the request, so the close can
 * name the same child the open did. A bridge that does not assign one gets a
 * generated id, and a report that names no children at all is expanded into
 * `count` anonymous children by the router.
 */

export const REQUEST_ID_HEADER = "x-autodev-request-id";
export const SUBAGENT_SPAWN_TOOLS_HEADER = "x-autodev-subagent-spawn-tools";
export const AGENT_EVENTS_URL_HEADER = "x-autodev-agent-events-url";
// A Codex hook that runs before a native tool call has no router-issued
// request id to authorize a post. The router proves the post is from this
// runtime -- not an out-of-tree caller -- by matching an in-flight session
// it already opened via the parent /v1/responses request. Sessions without
// a tracked server-side context are rejected, so this header is not a new
// authorization token; it is a soft correlation key.
export const SESSION_ID_HEADER = "x-autodev-session-id";
// Source tag the skill-read telemetry hook attaches to every report. The
// router uses it to distinguish explicit skill activations (still counted
// as `skillUses`) from observed file reads, so the dashboard can show both
// without inflating or undercounting either.
export const SKILL_READ_SOURCE = "skill_read";

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  // Node lowercases inbound header names, but LiteLLM and other intermediaries
  // can preserve the case the router sent, so match without regard to it.
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

export const VALID_ACTIVITY_STATES = Object.freeze(new Set([
  "tool_wait",
  "user_wait",
  "subagent_wait",
  "resumed",
  "finished",
  "failed",
]));

class AgentEventReporter {
  constructor(url, requestId, spawnTools) {
    this.url = url;
    this.requestId = requestId;
    this.spawnTools = spawnTools;
    this.childSequence = 0;
    this.lastActivityState = null;
  }

  /** An id unique within this request, for callers that have no id of their own. */
  nextChildId() {
    this.childSequence += 1;
    return `c${this.childSequence}`;
  }

  /** True when this tool name means the CLI just spawned a subagent. */
  isSpawnTool(name) {
    return typeof name === "string" && this.spawnTools.has(name);
  }

  /**
   * Post one spawn. Telemetry must never fail a model turn, so this resolves
   * on transport errors and non-2xx replies instead of rejecting; a lost
   * report costs a count, a thrown one would cost the turn.
   */
  async reportSpawn({ tool, role = null, status = "started", count = 1 }) {
    await this.reportSpawns({ tool, children: Array.from({ length: Math.max(1, count) }, () => ({ role })), status });
  }

  /**
   * Post every child one spawning tool call created. A CLI whose spawn tool
   * takes a batch -- agy dispatches up to sixteen subagents per
   * `invoke_subagent` call -- makes one tool call worth N subagents, so
   * reporting the call rather than its children turns a wide fan-out into a
   * count of one. Children are grouped by role so the router's `byRole` keeps
   * the shape of the delegation, and the whole batch travels as one request.
   */
  async reportSpawns({ tool, children, status = "started" }) {
    await this.post(this.childEvents("subagent_spawn", { tool, children, status }));
  }

  /**
   * Post the outcome of children a previous `reportSpawns` opened. The `id` on
   * each child is what pairs it with its open; `durationMs` is how long the
   * CLI ran the child, which is the only per-child turn measurement that
   * exists -- the router never served a request for it.
   */
  async reportResults({ tool, children, outcome = "success", durationMs = null, status = null }) {
    const extra = { outcome: outcome === "success" ? "success" : "failure", durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null };
    await this.post(this.childEvents("subagent_result", { tool, children, status: status ?? extra.outcome }, extra));
  }

  /**
   * One event per role in a batch, carrying that role's children. Grouping by
   * role keeps the router's spawn rows the shape of the delegation -- a
   * twelve-way fan-out is not twelve rows -- while the per-child ids inside
   * each group still address each child individually.
   */
  childEvents(type, { tool, children, status }, extra = {}) {
    const list = Array.isArray(children) && children.length > 0 ? children : [ { role: null } ];
    const byRole = new Map();
    for (const child of list) {
      const role = typeof child?.role === "string" && child.role.trim() ? child.role.trim() : null;
      const model = typeof child?.model === "string" && child.model.trim() ? child.model.trim() : null;
      const id = typeof child?.id === "string" && child.id.trim() ? child.id.trim() : this.nextChildId();
      // A CLI-delegated child leaves no rollout the router can read, so where
      // the bridge knows the CLI's own transcript path it is the only pointer
      // to what the child actually did. Carried only when present.
      const logUri = typeof child?.logUri === "string" && child.logUri.trim() ? child.logUri.trim() : null;
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push({ id, ...(model ? { model } : {}), ...(logUri ? { logUri } : {}) });
    }
    return [ ...byRole ].map(([ role, group ]) => ({ type, tool, role, status, count: group.length, children: group, ...extra }));
  }

  /**
   * Report that the CLI never offered a delegation tool at all.
   *
   * A workspace can remove the tool from under an orchestrator turn -- a
   * project `.claude/settings.json` that lists `Agent` under
   * `permissions.deny` strips it regardless of what this bridge allows -- and
   * the turn then does the work itself and says nothing. Zero spawns is the
   * same reading as a provider that simply chose not to delegate, so the
   * absence has to be reported as its own fact.
   */
  async reportSpawnToolsUnavailable({ available = [] } = {}) {
    await this.post([ {
      type: "subagent_tools_unavailable",
      expected: [ ...this.spawnTools ],
      // Bounded and name-only: a tool inventory is a fingerprint of the
      // workspace, and the router needs only enough to name the gap.
      available: available.filter((name) => typeof name === "string").slice(0, 100),
    } ]);
  }

  /**
   * Post a single tool_executed observation.
   *
   * The provider bridge just ran a tool call for the model. This is the
   * first-class evidence the router needs to mark a tool name as actually
   * available on this workspace -- without it, per-workspace tool use must
   * remain unavailable to honour the fail-closed contract. The tool name and
   * optional call id are the only identifying metadata the router retains;
   * arguments and outputs are deliberately not propagated.
   */
  async reportToolExecuted({ tool, callId = null, status = "ok", server = null, durationMs = null } = {}) {
    if (typeof tool !== "string" || !tool.trim()) return;
    await this.post([ {
      type: "tool_executed",
      tool: tool.trim(),
      callId: typeof callId === "string" && callId.trim() ? callId.trim() : null,
      status: status === "error" || status === "failure" ? "error" : status === "ok" || status === "success" ? "ok" : "unknown",
      server: typeof server === "string" && server.trim() ? server.trim() : null,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    } ]);
  }

  /**
   * Post a single tool_requested observation. The model asked the bridge to
   * invoke a tool, but the bridge did not necessarily run it -- some
   * requested tools fail closed at the bridge boundary. Reporting both
   * requested and executed is what lets the router distinguish "the
   * provider never offered the tool" from "the provider offered it but
   * something stopped it from running".
   */
  async reportToolRequested({ tool, callId = null, server = null } = {}) {
    if (typeof tool !== "string" || !tool.trim()) return;
    await this.post([ {
      type: "tool_requested",
      tool: tool.trim(),
      callId: typeof callId === "string" && callId.trim() ? callId.trim() : null,
      server: typeof server === "string" && server.trim() ? server.trim() : null,
    } ]);
  }

  /**
   * Post a single tool_unavailable observation. The model asked for a tool
   * the bridge does not have, or the workspace has explicitly denied the
   * tool through its own settings. Reporting the gap is what stops the
   * dashboard from rendering "the workspace never used this tool" when the
   * truth is "the workspace was forbidden from using it".
   */
  async reportToolUnavailable({ tool, callId = null, reason = "denied", server = null } = {}) {
    if (typeof tool !== "string" || !tool.trim()) return;
    await this.post([ {
      type: "tool_unavailable",
      tool: tool.trim(),
      callId: typeof callId === "string" && callId.trim() ? callId.trim() : null,
      reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 64) : "denied",
      server: typeof server === "string" && server.trim() ? server.trim() : null,
    } ]);
  }

  /**
   * Post a single skill_exposed observation. The bridge just made a skill
   * available to the model -- either by resolving a `$skill` invocation or
   * by surfacing the skill in the system prompt. This is the first-class
   * event the router needs to mark the skill as available per workspace;
   * without it, per-workspace skill attribution stays unavailable.
   */
  async reportSkillExposed({ skill, source = null, pluginId = null } = {}) {
    if (typeof skill !== "string" || !skill.trim()) return;
    await this.post([ {
      type: "skill_exposed",
      skill: skill.trim(),
      source: typeof source === "string" && source.trim() ? source.trim() : null,
      pluginId: typeof pluginId === "string" && pluginId.trim() ? pluginId.trim() : null,
    } ]);
  }

  /**
   * Post a single skill_used observation. The bridge (or a Codex hook
   * observing a SKILL.md read) just saw the agent actually use a skill.
   * The router keys dedupe on (requestId, skill, source, pluginId,
   * workspace, eventId) so a tool retry, a citation in a chat reply, and
   * repeated reads of the same skill in one turn collapse into one
   * attributed use rather than overcounting.
   */
  async reportSkillUsed({ skill, source = null, pluginId = null, eventId = null } = {}) {
    if (typeof skill !== "string" || !skill.trim()) return;
    const payload = {
      type: "skill_used",
      skill: skill.trim(),
      source: typeof source === "string" && source.trim() ? source.trim() : null,
      pluginId: typeof pluginId === "string" && pluginId.trim() ? pluginId.trim() : null,
    };
    if (typeof eventId === "string" && eventId.trim()) payload.eventId = eventId.trim().slice(0, 128);
    await this.post([ payload ]);
  }

  /**
   * Post a single normalized activity observation.
   *
   * { type: "activity", state: "tool_wait" | "user_wait" | "subagent_wait" | "resumed" | "finished" | "failed", childIds? }
   */
  async reportActivity(stateOrOptions, maybeChildIds = null) {
    let state = null;
    let childIds = null;
    if (typeof stateOrOptions === "string") {
      state = stateOrOptions;
      childIds = maybeChildIds;
    } else if (stateOrOptions && typeof stateOrOptions === "object") {
      state = stateOrOptions.state;
      childIds = stateOrOptions.childIds ?? stateOrOptions.child_ids ?? maybeChildIds;
    }
    const cleanState = typeof state === "string" ? state.trim() : "";
    if (!VALID_ACTIVITY_STATES.has(cleanState)) return;
    if (this.lastActivityState === "finished" || this.lastActivityState === "failed") return;
    if (this.lastActivityState === cleanState && cleanState !== "resumed") return;
    this.lastActivityState = cleanState;
    const event = { type: "activity", state: cleanState };
    if (Array.isArray(childIds)) {
      const cleanIds = childIds.map((id) => typeof id === "string" ? id.trim() : String(id).trim()).filter(Boolean);
      if (cleanIds.length > 0) event.childIds = cleanIds;
    }
    await this.post([ event ]);
  }

  async post(events) {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: this.requestId, events }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      // Best effort by design; see reportSpawn. Emit a bounded, credential-free
      // loss record so an operator can distinguish "no children" from telemetry
      // transport failure without turning observability into a turn failure.
      console.error(JSON.stringify({
        schema: "autodev-agent-telemetry-v1",
        event: "report_lost",
        requestId: this.requestId,
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

/**
 * A reporter for this request, or null when the router asked for no reporting
 * (a provider with no spawn tools, or a caller that is not the router).
 */
export function resolveAgentEventReporter(headers) {
  const url = headerValue(headers, AGENT_EVENTS_URL_HEADER);
  const requestId = headerValue(headers, REQUEST_ID_HEADER);
  const tools = headerValue(headers, SUBAGENT_SPAWN_TOOLS_HEADER);
  if (!url || !requestId || !tools) return null;
  const spawnTools = new Set(tools.split(",").map((tool) => tool.trim()).filter(Boolean));
  return spawnTools.size > 0 ? new AgentEventReporter(url, requestId, spawnTools) : null;
}

/**
 * A reporter used by Codex PreToolUse hooks that observe SKILL.md reads.
 *
 * Hooks run on the Codex side and so do not have a router-issued request id
 * to authorize an agent-events post the way a bridge does. The router still
 * receives them: a PreToolUse hook fires inside a session whose
 * /v1/responses parent request the router already issued, and the
 * orchestrator forwards the parent session id into the hook context
 * (`x-codex-session-id`). The router keeps a short-lived session -> bridge
 * context map for exactly this purpose; sessions that never opened a parent
 * request resolve to no context and the router fails closed by dropping the
 * post instead of inventing a workspace key.
 *
 * Returns null when the caller did not provide both an events URL and a
 * session id, so a misconfigured hook is a no-op rather than a shadow
 * authorization path.
 */
export function resolveSkillReadReporter(headers) {
  const url = headerValue(headers, AGENT_EVENTS_URL_HEADER);
  const sessionId = headerValue(headers, SESSION_ID_HEADER);
  if (!url || !sessionId) return null;
  // The session id is used in place of the request id. The router records
  // the post with the same request/bridge correlation machinery a bridge
  // would use, attributed to whichever active request owns the session.
  return new AgentEventReporter(url, sessionId, new Set());
}
