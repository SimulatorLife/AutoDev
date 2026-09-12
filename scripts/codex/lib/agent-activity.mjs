/**
 * Shared state machine for session/agent activity that spans request gaps.
 *
 * A single HTTP request to the router only covers one model turn. What an
 * orchestrator or role subagent is actually doing lives in the *gaps*
 * between requests too: it can be waiting on a tool result the client has
 * not sent back yet, waiting on a human, or waiting on a subagent it just
 * spawned. None of that is visible to a naive "in-flight while the HTTP
 * request is open" counter, which is why the router previously had no way
 * to describe it. This module tracks that activity explicitly, keyed by a
 * caller-chosen `subject` (typically a session key, or a synthetic id for a
 * single ungrouped attempt), independent of any one HTTP request's lifetime.
 *
 * States:
 *   active         a request is currently being served for this subject.
 *   tool_wait      the last response ended with a tool call; the router is
 *                  waiting for the continuation that carries the tool result.
 *   user_wait      the subject is explicitly waiting on user input or the
 *                  next turn (via lifecycle events or explicit input_required).
 *   subagent_wait  the subject is waiting on a spawned subagent to report back.
 *   resumed        a new request just arrived after a wait state; observable
 *                  until the next explicit transition (begin/end/lifecycle).
 *   finished       the activity ended successfully (normal final responses
 *                  with no tool calls transition here). Terminal.
 *   failed         the activity ended in failure. Terminal.
 *   stale          derived, not stored: a non-terminal record whose state has
 *                  not moved in longer than the TTL is reported as stale
 *                  rather than left to describe a wait that will never end
 *                  (a bridge crashed, a client disconnected without saying
 *                  so, and so on).
 *
 * Every mutating method is idempotent against redelivery: applying the same
 * event twice (matched by requestId, or by an explicit eventId for events
 * that arrive over the network and may be retried) leaves the record exactly
 * where the first application left it. A terminal record (finished/failed)
 * never reopens.
 *
 * Records are grouped by an optional `kind` (what this activity represents --
 * e.g. "session" for an orchestrator/role turn, "bridge_subagent" for a
 * bridge-reported child turn, "subagent_slot" for a held concurrency slot)
 * and an optional `tag` (a grouping key within that kind, e.g. a session
 * key), so a caller can count "how many subagent slots are live for this
 * session" without maintaining a parallel counter of its own.
 *
 * `subagent_slot` records describe *admission accounting* (a held
 * concurrency slot), not an agent doing work that should show up in
 * agent-facing counts -- a session already accounts for the work its slots
 * gate. Every counting/aggregation method in this module (`countLive`,
 * `countByState`, `snapshot`) therefore defaults to only the agent kinds
 * (`AGENT_ACTIVITY_KINDS`: "session" and "bridge_subagent") unless a caller passes an
 * explicit `kind` filter, which is how concurrency accounting opts back in to
 * see its own `subagent_slot` records.
 */

export const AGENT_ACTIVITY_TTL_ENV = "CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS";
export const DEFAULT_AGENT_ACTIVITY_TTL_MS = 300000;

export const AGENT_ACTIVITY_STATES = Object.freeze([
  "active",
  "tool_wait",
  "user_wait",
  "subagent_wait",
  "resumed",
  "finished",
  "failed",
  "stale",
]);

const TERMINAL_STATES = new Set(["finished", "failed"]);
const WAIT_STATES = new Set(["tool_wait", "user_wait", "subagent_wait"]);
// "Live" is every state that represents activity still in progress -- the
// complement of terminal (finished/failed) and stale (abandoned).
const LIVE_STATES = new Set(["active", "tool_wait", "user_wait", "subagent_wait", "resumed"]);

// The kinds that represent an agent actually doing work, as opposed to
// bookkeeping records (e.g. `subagent_slot`, a held concurrency admission)
// that ride the same tracker for TTL/staleness reuse but must not inflate
// agent-facing live/usage/provider/top-level counts. See the module doc for
// how this interacts with `matches()` and `snapshot()`.
export const AGENT_ACTIVITY_KINDS = Object.freeze(["session", "bridge_subagent"]);

const LIFECYCLE_EVENT_STATES = new Set(["user_wait", "subagent_wait", "tool_wait", "resumed", "finished", "failed"]);

/** Bound on retained per-record idempotency markers, so a long-lived subject cannot grow without bound. */
const MAX_TRACKED_EVENT_IDS = 64;

function trackEventId(set, eventId) {
  if (!eventId) return false;
  if (set.has(eventId)) return true;
  set.add(eventId);
  if (set.size > MAX_TRACKED_EVENT_IDS) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
  return false;
}

/** Reads the TTL from the environment, falling back to the documented default for anything unset or invalid. */
export function resolveAgentActivityTtlMs(env = process.env) {
  const parsed = Number.parseInt(env?.[AGENT_ACTIVITY_TTL_ENV] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_ACTIVITY_TTL_MS;
}

function snapshotRecord(rec, at) {
  return {
    subject: rec.subject,
    kind: rec.kind,
    tag: rec.tag,
    state: isStale(rec, at) ? "stale" : rec.state,
    provider: rec.provider,
    model: rec.model,
    role: rec.role,
    origin: rec.origin,
    workspace: rec.workspace,
    requestId: rec.requestId,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
  };
}

function isStale(rec, at) {
  if (TERMINAL_STATES.has(rec.state)) return false;
  // An agent-kind record with an open request has a stronger liveness signal
  // than its last timestamp: the request/stream itself is still in flight.
  // It will settle through endRequest/finish, while admission-slot records
  // intentionally remain TTL-bound so an abandoned slot cannot leak forever.
  if (AGENT_ACTIVITY_KINDS.includes(rec.kind) && rec.openRequestId) return false;
  return at - rec.updatedAt > rec.ttlMs;
}

function emptyStateCounts() {
  return Object.fromEntries(AGENT_ACTIVITY_STATES.map((state) => [state, 0]));
}

/**
 * Creates an independent tracker. Each caller (the router process, a test)
 * gets its own instance rather than reaching into shared module state, which
 * is what makes the TTL/stale behaviour testable with a fake clock.
 */
export function createAgentActivityTracker({ ttlMs = resolveAgentActivityTtlMs(), now = () => Date.now() } = {}) {
  const effectiveTtlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_AGENT_ACTIVITY_TTL_MS;
  const subjects = new Map();

  function ensure(subject, { kind = "session", tag = null } = {}) {
    let rec = subjects.get(subject);
    if (!rec) {
      rec = {
        subject,
        kind,
        tag,
        state: "active",
        provider: null,
        model: null,
        role: null,
        origin: null,
        workspace: null,
        requestId: null,
        startedAt: now(),
        updatedAt: now(),
        ttlMs: effectiveTtlMs,
        // requestId this record's "active" leg was last opened for, so a
        // redelivered begin for the same attempt is a no-op rather than a
        // spurious active -> resumed -> active bounce.
        openRequestId: null,
        settledRequestIds: new Set(),
        lifecycleEventIds: new Set(),
      };
      subjects.set(subject, rec);
    }
    return rec;
  }

  function transition(rec, state, at) {
    rec.state = state;
    rec.updatedAt = Number.isFinite(at) ? at : now();
  }

  /**
   * A request just started being served for `subject`. Idempotent against a
   * redelivered begin for the same (subject, requestId) attempt while it is
   * still open. If the subject was waiting on something, the transition is
   * recorded as "resumed" rather than silently folded back into "active" --
   * that distinction is what "derive tool waits from ... continuations" asks
   * for: a continuation is observable as a resume, not indistinguishable
   * from any other turn.
   */
  function beginRequest(subject, { requestId = null, provider = null, model = null, role = null, origin = null, workspace = null, kind = "session", tag = null, timestamp } = {}) {
    if (!subject) return null;
    const rec = ensure(subject, { kind, tag });
    if (requestId && rec.openRequestId === requestId && !TERMINAL_STATES.has(rec.state)) {
      // Exact duplicate of the currently open attempt: not a new transition,
      // but proof the same request is still genuinely open, so it refreshes
      // the staleness clock exactly as an explicit touch() would -- the open
      // leg stays live until it actually settles rather than going stale out
      // from under a request the router knows perfectly well is still going.
      const at = Number.isFinite(timestamp) ? timestamp : now();
      if (isStale(rec, at)) {
        rec.state = "stale";
        return snapshotRecord(rec, at);
      }
      rec.updatedAt = at;
      return snapshotRecord(rec, at);
    }
    if (TERMINAL_STATES.has(rec.state)) {
      // A terminal record is closed for the request that settled it, but an
      // identified session can receive a later turn under the same subject.
      // A different requestId starts that new activity span; the same id
      // remains an idempotent duplicate and never reopens.
      if (requestId && requestId !== rec.requestId) {
        const at = Number.isFinite(timestamp) ? timestamp : now();
        rec.state = "active";
        rec.startedAt = at;
        rec.updatedAt = at;
        rec.provider = provider ?? rec.provider;
        rec.model = model ?? rec.model;
        rec.role = role ?? rec.role;
        rec.origin = origin ?? rec.origin;
        rec.workspace = workspace ?? rec.workspace;
        rec.requestId = requestId;
        rec.openRequestId = requestId;
        rec.settledRequestIds.clear();
        rec.lifecycleEventIds.clear();
        return snapshotRecord(rec, at);
      }
      return snapshotRecord(rec, timestamp ?? now());
    }
    const wasWaiting = WAIT_STATES.has(rec.state);
    if (provider !== null) rec.provider = provider;
    if (model !== null) rec.model = model;
    if (role !== null) rec.role = role;
    if (origin !== null) rec.origin = origin;
    if (workspace !== null) rec.workspace = workspace;
    rec.requestId = requestId ?? rec.requestId;
    rec.openRequestId = requestId ?? rec.openRequestId;
    transition(rec, wasWaiting ? "resumed" : "active", timestamp);
    return snapshotRecord(rec, timestamp ?? now());
  }

  /**
   * The request just settled. `hasToolCalls` -- derived by the caller from
   * the router-visible response body -- decides the gap state: a response
   * that ended with a tool call is followed by tool_wait. A response that
   * failed ends in failed (terminal). A successful response with an explicit
   * inputRequired protocol marker enters user_wait. Normal final responses
   * (no tool calls, no explicit input_required) transition to finished
   * (terminal), so user_wait is reserved for explicit waits.
   * Idempotent per (subject, requestId): a redelivered or duplicate result
   * for a request already settled is a no-op, and a terminal record is
   * never reopened by a later result.
   */
  function endRequest(subject, { requestId = null, outcome = "success", hasToolCalls = false, inputRequired = false, timestamp } = {}) {
    const rec = subjects.get(subject);
    if (!rec) return null;
    if (TERMINAL_STATES.has(rec.state)) return snapshotRecord(rec, timestamp ?? now());
    if (requestId && trackEventId(rec.settledRequestIds, requestId)) {
      return snapshotRecord(rec, timestamp ?? now());
    }
    rec.openRequestId = null;
    if (outcome !== "success") {
      transition(rec, "failed", timestamp);
    } else if (hasToolCalls) {
      transition(rec, "tool_wait", timestamp);
    } else if (inputRequired) {
      transition(rec, "user_wait", timestamp);
    } else {
      transition(rec, "finished", timestamp);
    }
    return snapshotRecord(rec, timestamp ?? now());
  }

  /**
   * Ends the activity outright -- finished on success, failed otherwise --
   * regardless of whether the last response carried a tool call. This is
   * distinct from endRequest: endRequest describes "the request settled, and
   * here is what the subject is waiting on next" (a gap state), while finish
   * describes "there is no next wait, this activity is over" (e.g. a held
   * concurrency slot being released, or an explicit close). Idempotent per
   * (subject, requestId) and never reopens a terminal record.
   */
  function finish(subject, { requestId = null, outcome = "success", timestamp } = {}) {
    const rec = subjects.get(subject);
    if (!rec) return null;
    if (TERMINAL_STATES.has(rec.state)) return snapshotRecord(rec, timestamp ?? now());
    if (requestId && trackEventId(rec.settledRequestIds, requestId)) {
      return snapshotRecord(rec, timestamp ?? now());
    }
    rec.openRequestId = null;
    transition(rec, outcome === "success" ? "finished" : "failed", timestamp);
    return snapshotRecord(rec, timestamp ?? now());
  }

  /**
   * A heartbeat: `subject` is confirmed still genuinely in progress, so its
   * staleness clock is postponed without otherwise changing anything. This is
   * distinct from every other mutator here, which all describe *something
   * happened* (a request began, ended, a lifecycle event arrived); `touch`
   * describes *nothing happened, and that is expected* -- a long single
   * upstream turn whose only signal is still-open bytes on the wire, or a
   * held concurrency slot whose owning session was just observed to still be
   * making requests. Without it, the TTL has no way to distinguish "legitimately
   * still running" from "abandoned" for activity that can outlast the TTL, and
   * either the TTL has to be weakened for everyone or genuine long-running
   * work gets misreported as stale. A no-op for an unknown subject and never
   * reopens or otherwise touches a terminal record -- a terminal record's
   * staleness is moot, and touching it would misreport when it actually ended.
   */
  function touch(subject, { timestamp } = {}) {
    const rec = subjects.get(subject);
    if (!rec) return null;
    const at = timestamp ?? now();
    if (TERMINAL_STATES.has(rec.state)) return snapshotRecord(rec, at);
    if (isStale(rec, at)) {
      rec.state = "stale";
      return snapshotRecord(rec, at);
    }
    rec.updatedAt = Number.isFinite(timestamp) ? timestamp : at;
    return snapshotRecord(rec, at);
  }

  /** The subject just spawned a subagent it is now waiting on. Idempotent (re-applying while already waiting is a no-op). */
  function noteSubagentWait(subject, { timestamp, kind = "session", tag = null } = {}) {
    if (!subject) return null;
    const rec = ensure(subject, { kind, tag });
    if (TERMINAL_STATES.has(rec.state) || rec.state === "subagent_wait") return snapshotRecord(rec, timestamp ?? now());
    transition(rec, "subagent_wait", timestamp);
    return snapshotRecord(rec, timestamp ?? now());
  }

  /** The subagent the subject was waiting on reported back. A no-op unless the subject was actually in subagent_wait. */
  function noteSubagentResolved(subject, { timestamp } = {}) {
    const rec = subjects.get(subject);
    if (!rec) return null;
    if (TERMINAL_STATES.has(rec.state) || rec.state !== "subagent_wait") return rec ? snapshotRecord(rec, timestamp ?? now()) : null;
    transition(rec, "resumed", timestamp);
    return snapshotRecord(rec, timestamp ?? now());
  }

  /**
   * Applies a normalized lifecycle event, as accepted over the existing
   * agent-events endpoint: `{ state, eventId?, timestamp? }` where `state`
   * is one of user_wait/subagent_wait/tool_wait/resumed/finished/failed.
   * Unknown states are rejected (returns null) rather than silently ignored,
   * so a caller can tell a malformed event from a legitimate no-op.
   * Idempotent by eventId when the caller supplies one; a terminal record
   * never reopens, including via a duplicated terminal event.
   */
  function applyLifecycleEvent(subject, event) {
    if (!subject || !event || typeof event !== "object") return null;
    const state = event.state;
    if (!LIFECYCLE_EVENT_STATES.has(state)) return null;
    const rec = ensure(subject, { kind: event.kind ?? "session", tag: event.tag ?? null });
    if (event.provider !== undefined) rec.provider = event.provider;
    if (event.model !== undefined) rec.model = event.model;
    if (event.role !== undefined) rec.role = event.role;
    if (event.origin !== undefined) rec.origin = event.origin;
    if (event.workspace !== undefined) rec.workspace = event.workspace;
    if (TERMINAL_STATES.has(rec.state)) return snapshotRecord(rec, event.timestamp ?? now());
    const eventId = typeof event.eventId === "string" && event.eventId.trim() ? event.eventId.trim() : null;
    if (eventId && trackEventId(rec.lifecycleEventIds, eventId)) return snapshotRecord(rec, event.timestamp ?? now());
    transition(rec, state, event.timestamp);
    return snapshotRecord(rec, event.timestamp ?? now());
  }

  function getState(subject, at = now()) {
    const rec = subjects.get(subject);
    if (!rec) return null;
    return isStale(rec, at) ? "stale" : rec.state;
  }

  function getRecord(subject, at = now()) {
    const rec = subjects.get(subject);
    return rec ? snapshotRecord(rec, at) : null;
  }

  /** Marks every matured non-terminal record stale as of `at`. Idempotent; returns the count actually swept. */
  function sweep(at = now()) {
    let swept = 0;
    for (const rec of subjects.values()) {
      if (isStale(rec, at)) {
        rec.state = "stale";
        swept += 1;
      }
    }
    return swept;
  }

  function matches(rec, filter = {}) {
    if (Object.hasOwn(filter, "kind")) {
      if (rec.kind !== filter.kind) return false;
    } else if (!AGENT_ACTIVITY_KINDS.includes(rec.kind)) {
      // No explicit kind requested: default every count to agent kinds only,
      // so a held `subagent_slot` never inflates a provider/usage/top-level
      // count. A caller that actually wants slot accounting passes `kind`
      // explicitly (see activeSubagentThreads() and friends in the router).
      return false;
    }
    for (const field of ["tag", "provider", "model", "role", "origin", "workspace"]) {
      if (!Object.hasOwn(filter, field)) continue;
      if (rec[field] !== filter[field]) return false;
    }
    return true;
  }


  /** Count of subjects currently in a live (non-terminal, non-stale) state, optionally filtered. Never negative by construction: it is a fresh count over records, not a running counter. */
  function countLive(filter = {}, at = now()) {
    sweep(at);
    let count = 0;
    for (const rec of subjects.values()) {
      if (!LIVE_STATES.has(rec.state)) continue;
      if (!matches(rec, filter)) continue;
      count += 1;
    }
    return Math.max(0, count);
  }

  /** Count of subjects grouped by state, optionally filtered. */
  function countByState(filter = {}, at = now()) {
    sweep(at);
    const counts = emptyStateCounts();
    for (const rec of subjects.values()) {
      if (!matches(rec, filter)) continue;
      counts[rec.state] = (counts[rec.state] ?? 0) + 1;
    }
    return counts;
  }

  /** Distinct `tag` values with at least one live record of `kind`. */
  function distinctTags({ kind } = {}, at = now()) {
    sweep(at);
    const tags = new Set();
    for (const rec of subjects.values()) {
      if (kind !== undefined && rec.kind !== kind) continue;
      if (!LIVE_STATES.has(rec.state)) continue;
      if (rec.tag !== null) tags.add(rec.tag);
    }
    return [...tags];
  }

  /** A status-shaped snapshot: totals, live count, and per-provider/per-model state breakdowns, for surfacing on /status. */
  function snapshot(at = now()) {
    sweep(at);
    const byProvider = {};
    const byModel = {};
    const byRole = {};
    const byOrigin = {};
    const byWorkspace = {};
    const add = (collection, key, rec) => {
      const normalized = key ?? "unattributed";
      collection[normalized] ??= emptyStateCounts();
      collection[normalized][rec.state] = (collection[normalized][rec.state] ?? 0) + 1;
    };
    for (const rec of subjects.values()) {
      // A held `subagent_slot` has no provider/model/role of its own -- it
      // would otherwise fall into the "unattributed" bucket of byRole/
      // byOrigin/byWorkspace and inflate them with bookkeeping, not agents.
      if (!AGENT_ACTIVITY_KINDS.includes(rec.kind)) continue;
      if (rec.provider) add(byProvider, rec.provider, rec);
      if (rec.provider && rec.model) add(byModel, `${rec.provider}/${rec.model}`, rec);
      add(byRole, rec.role, rec);
      add(byOrigin, rec.origin, rec);
      add(byWorkspace, rec.workspace, rec);
    }
    const byState = countByState({}, at);
    return {
      ttlMs: effectiveTtlMs,
      // Agent-kind subjects only (see AGENT_ACTIVITY_KINDS); a held
      // subagent_slot is admission bookkeeping, not an agent, and must not
      // inflate this top-level total.
      total: Object.values(byState).reduce((sum, count) => sum + count, 0),
      live: countLive({}, at),
      byState,
      byProvider,
      byModel,
      byRole,
      byOrigin,
      byWorkspace,
    };
  }

  function reset() {
    subjects.clear();
  }

  return {
    beginRequest,
    endRequest,
    finish,
    touch,
    noteSubagentWait,
    noteSubagentResolved,
    applyLifecycleEvent,
    getState,
    getRecord,
    sweep,
    countLive,
    countByState,
    distinctTags,
    snapshot,
    reset,
    get size() { return subjects.size; },
  };
}
