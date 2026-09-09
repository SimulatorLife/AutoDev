/**
 * Delegation requests collected during one bridge turn.
 *
 * A CLI bridge's own child agents are invisible to Codex: nothing creates a
 * Codex thread, so the app has nothing to render and the router only hears
 * about them through the `/v1/agent-events` side channel. Asking Codex to spawn
 * instead produces a real, clickable session and routes the child back through
 * the router like any other `autodev/<role>` request.
 *
 * The CLI cannot reach Codex itself -- only the bridge can, by putting a tool
 * call in its Responses turn. So the CLI is given an MCP tool that calls back
 * into its own bridge over loopback, and this is where those calls land while
 * the turn is still running. When the turn ends the bridge drains what was
 * collected and emits it as one `exec` call.
 *
 * Delegation is dispatched, not awaited. A spawn returns as soon as Codex has
 * created the child -- 0.1-0.8s for a batch -- and Codex tracks it from there,
 * so nothing here has to hold a CLI open waiting for a child to finish.
 *
 * Two properties this must not lose:
 *   - A session key that is not specific to one Codex conversation is refused
 *     outright. The router falls back to a single process-wide key when a
 *     request carries no identity, and collecting under that key would attach
 *     one conversation's delegation to another's turn.
 *   - An entry must never outlive its turn. A stale one would accept a
 *     delegation from a CLI that outlived its request and attach it to nothing,
 *     or -- on a reused session key -- to the following turn.
 */

/** Sessions the router could not identify never collect delegation state. */
export const UNIDENTIFIED_SESSION_SCOPE = "process-fallback";

// Defence in depth only: every turn closes its own session in a finally block,
// so reaching either of these means a turn died in a way that skipped it.
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_MS = 900_000;

export class SpawnSessionRegistry {
  constructor({ maxSessions = DEFAULT_MAX_SESSIONS, idleMs = DEFAULT_IDLE_MS, now = () => Date.now() } = {}) {
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.now = now;
    this.sessions = new Map();
  }

  /** Whether this turn may collect delegation state at all. */
  static canHold(sessionKey, sessionScope) {
    return typeof sessionKey === "string" && sessionKey.trim().length > 0 && sessionScope !== UNIDENTIFIED_SESSION_SCOPE;
  }

  /**
   * Begin a turn. Re-opening a key replaces whatever was there: the previous
   * turn on that conversation is over, and carrying its children forward would
   * spawn them twice.
   */
  open(sessionKey, { orchestrator = false } = {}) {
    this.sweep();
    while (this.sessions.size >= this.maxSessions && !this.sessions.has(sessionKey)) {
      const oldest = [ ...this.sessions.entries() ].sort((a, b) => a[ 1 ].updatedAt - b[ 1 ].updatedAt)[ 0 ];
      if (!oldest) break;
      this.sessions.delete(oldest[ 0 ]);
    }
    this.sessions.set(sessionKey, { orchestrator, children: [], updatedAt: this.now() });
  }

  /**
   * Record one delegation request against an in-flight turn.
   *
   * Returns `{ accepted, message }`. A refusal is a readable sentence rather
   * than a transport error because the model is the one who reads it. Missing
   * session state is an admission failure with no child to close; a bounded
   * leaf may instead be told to do the work directly.
   */
  record(sessionKey, children) {
    const session = this.sessions.get(sessionKey);
    if (!session) return { accepted: false, message: "Delegation is unavailable in this session; no child was created. Do not retry blindly or take over delegated scopes. Report the unavailable delegation path." };
    if (!session.orchestrator) return { accepted: false, message: "This is a bounded leaf turn and may not delegate. Do the work directly." };

    const accepted = [];
    for (const child of Array.isArray(children) ? children : []) {
      const message = child?.message;
      if (typeof message !== "string" || !message.trim()) continue;
      const agentType = typeof child?.agent_type === "string" && child.agent_type.trim() ? child.agent_type.trim() : null;
      accepted.push({ agentType, message });
    }
    if (accepted.length === 0) return { accepted: false, message: "Every child needs a non-empty `message`. Nothing was dispatched." };

    session.children.push(...accepted);
    session.updatedAt = this.now();
    const roles = [ ...new Set(accepted.map((c) => c.agentType ?? "default")) ].sort().join(", ");
    return { accepted: true, children: accepted, roles, count: accepted.length };
  }

  /** Whether this turn is allowed to delegate, for the tool-offer handshake. */
  mayDelegate(sessionKey) {
    return this.sessions.get(sessionKey)?.orchestrator === true;
  }

  /** End the turn and hand back what it asked to spawn. */
  close(sessionKey) {
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    return session ? session.children : [];
  }

  /** Drop entries whose turn evidently died without closing them. */
  sweep() {
    const deadline = this.now() - this.idleMs;
    const expired = [ ...this.sessions.entries() ].filter(([ , s ]) => s.updatedAt < deadline).map(([ key ]) => key);
    for (const key of expired) this.sessions.delete(key);
    return expired;
  }

  /** Small enough to expose on `/health` without leaking prompts or paths. */
  status() {
    return { held: this.sessions.size, maxSessions: this.maxSessions };
  }
}
