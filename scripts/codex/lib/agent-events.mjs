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
 */

export const REQUEST_ID_HEADER = "x-autodev-request-id";
export const SUBAGENT_SPAWN_TOOLS_HEADER = "x-autodev-subagent-spawn-tools";
export const AGENT_EVENTS_URL_HEADER = "x-autodev-agent-events-url";

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  // Node lowercases inbound header names, but LiteLLM and other intermediaries
  // can preserve the case the router sent, so match without regard to it.
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

class AgentEventReporter {
  constructor(url, requestId, spawnTools) {
    this.url = url;
    this.requestId = requestId;
    this.spawnTools = spawnTools;
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
    await this.post([ { type: "subagent_spawn", tool, role, status, count } ]);
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
    const list = Array.isArray(children) && children.length > 0 ? children : [ { role: null } ];
    const byRole = new Map();
    for (const child of list) {
      const role = typeof child?.role === "string" && child.role.trim() ? child.role.trim() : null;
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }
    await this.post([ ...byRole ].map(([ role, count ]) => ({ type: "subagent_spawn", tool, role, status, count })));
  }

  async post(events) {
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: this.requestId, events }),
      });
    } catch {
      // Best effort by design; see reportSpawn.
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
