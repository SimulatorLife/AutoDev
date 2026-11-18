import {
  type OpenChildThread,
  readOpenChildThreads
} from "@simulatorlife/autodev-runtime/router/codex-state-collector";
import {
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER,
  THREAD_ID_HEADER
} from "@simulatorlife/autodev-runtime/router/subagents";
import { contextHeaderValue } from "@simulatorlife/autodev-runtime/shared/agent-context-headers";

import type { SpawnChild } from "./spawn-tools.ts";

function parseChildCandidate(child: unknown): {
  message: string;
  target: string | null;
  agentType: string | null;
} | null {
  if (!child || typeof child !== "object") return null;
  const rec = child as Record<string, unknown>;
  if (typeof rec.message !== "string" || !rec.message.trim()) return null;
  const target =
    typeof rec.target === "string" && rec.target.trim()
      ? rec.target.trim()
      : typeof rec.agent_id === "string" && rec.agent_id.trim()
        ? rec.agent_id.trim()
        : null;
  const agentType =
    typeof rec.agent_type === "string" && rec.agent_type.trim()
      ? rec.agent_type.trim()
      : null;
  return { message: rec.message, target, agentType };
}

function formatSessionRoles(accepted: readonly SpawnChild[]): string {
  return [
    ...new Set(
      accepted.map((c) =>
        c.target
          ? `reuse:${c.target}${c.agentType ? ` (${c.agentType})` : ""}`
          : (c.agentType ?? "default")
      )
    )
  ]
    .sort()
    .join(", ");
}
function validateReuseTarget(
  target: string,
  agentType: string | null,
  sessionKey: string,
  sessionWorkspace: string | null,
  childRecord: ChildSessionRecord | undefined
): string | null {
  if (!childRecord) {
    return `Cannot reuse subagent "${target}": target is not a verified subagent owned by this session. Never provide arbitrary target identifiers.`;
  }
  if (childRecord.parentId !== sessionKey) {
    return `Cannot reuse subagent "${target}": subagent belongs to a different parent session ("${childRecord.parentId}").`;
  }
  if (
    sessionWorkspace &&
    childRecord.workspace &&
    childRecord.workspace !== sessionWorkspace
  ) {
    return `Cannot reuse subagent "${target}": subagent workspace ("${childRecord.workspace}") does not match requesting parent workspace ("${sessionWorkspace}").`;
  }
  if (
    agentType &&
    agentType !== childRecord.role &&
    childRecord.role !== "default"
  ) {
    return `Cannot reuse subagent "${target}": subagent role ("${childRecord.role}") is incompatible with requested role ("${agentType}").`;
  }
  if (childRecord.status === "running") {
    return `Cannot reuse subagent "${target}": subagent is currently running and cannot accept follow-up input until complete.`;
  }
  if (childRecord.status !== "parked" && childRecord.status !== "completed") {
    return `Cannot reuse subagent "${target}": subagent status is "${childRecord.status}" (must be parked or completed).`;
  }
  return null;
}
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

export interface ChildSessionRecord {
  childId: string;
  parentId: string;
  role: string;
  workspace: string;
  status: "parked" | "completed" | "running" | "failed" | "closed" | string;
}

export interface SpawnSession {
  token: string;
  orchestrator: boolean;
  role: string | null;
  workspace: string | null;
  children: SpawnChild[];
  updatedAt: number;
}
export interface SpawnRegistryOptions {
  maxSessions?: number;
  idleMs?: number;
  now?: () => number;
  /** The parent's open child handles; Codex's spawn edges by default. */
  openChildren?: (parentId: string) => OpenChildThread[];
}

// Defence in depth only: every turn closes its own session in a finally block,
// so reaching either of these means a turn died in a way that skipped it.
// Keep defaults well above bridge park timeouts (30m) and multi-hour turns
// while `touch()` refreshes active turns continuously.
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_IDLE_MS = 14_400_000;
const MAX_TRACKED_LEAF_AND_ABSENCE_KEYS = 512;

const NOTIFICATION_REGEX =
  /<subagent_notification>([\s\S]*?)<\/subagent_notification>/g;

function parseNotificationStatus(rawStatus: unknown): string {
  if (rawStatus === "running") return "running";
  if (rawStatus === "shutdown" || rawStatus === "closed") return "closed";
  return "completed";
}

function extractNotificationChild(
  raw: string,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const rawPath = parsed.agent_path ?? parsed.agent_id;
    const childId =
      typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : null;
    if (!childId) return null;
    const rawRole = parsed.agent_role ?? parsed.role ?? parsed.agent_type;
    const role =
      typeof rawRole === "string" && rawRole.trim()
        ? rawRole.trim()
        : "default";
    return {
      childId,
      parentId: sessionKey,
      role,
      workspace: workspace ?? "",
      status: parseNotificationStatus(parsed.status)
    };
  } catch {
    return null;
  }
}

function parseNotificationRecords(
  text: string,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord[] {
  const records: ChildSessionRecord[] = [];
  let match: RegExpExecArray | null;
  while ((match = NOTIFICATION_REGEX.exec(text)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const record = extractNotificationChild(raw, sessionKey, workspace);
    if (record) records.push(record);
  }
  return records;
}

function extractCollabReceiver(
  raw: unknown,
  rec: Record<string, unknown>,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const agent = raw as Record<string, unknown>;
  const rawId = agent.thread_id ?? agent.threadId;
  const childId =
    typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
  if (!childId) return null;
  const rawRole = agent.agent_role ?? agent.agentRole;
  const role =
    typeof rawRole === "string" && rawRole.trim() ? rawRole.trim() : "default";
  const agentStates =
    typeof rec.agents_states === "object" && rec.agents_states !== null
      ? (rec.agents_states as Record<string, string>)
      : null;
  const state = agentStates?.[childId] ?? "running";
  const status =
    state === "completed"
      ? "completed"
      : state === "closed" || state === "shutdown"
        ? "closed"
        : "running";
  return {
    childId,
    parentId: sessionKey,
    role,
    workspace: workspace ?? "",
    status
  };
}

function parseCollabReceivers(
  rec: Record<string, unknown>,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord[] {
  const sender = rec.sender_thread_id ?? rec.senderThreadId;
  const isSpawn =
    rec.type === "CollabAgentToolCall" || rec.tool === "spawn_agent";
  if (!isSpawn || sender !== sessionKey) return [];

  const rawList = Array.isArray(rec.receiver_agents)
    ? rec.receiver_agents
    : Array.isArray(rec.receiverAgents)
      ? rec.receiverAgents
      : [];

  const records: ChildSessionRecord[] = [];
  for (const raw of rawList) {
    const record = extractCollabReceiver(raw, rec, sessionKey, workspace);
    if (record) records.push(record);
  }
  return records;
}

function extractRecordsFromValue(
  val: unknown,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord[] {
  if (typeof val === "string" && val.includes("subagent_notification")) {
    return parseNotificationRecords(val, sessionKey, workspace);
  }
  return [];
}

function processPayloadItem(
  item: unknown,
  stack: unknown[],
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord[] {
  if (item && typeof item === "object") {
    stack.push(item);
    return [];
  }
  return extractRecordsFromValue(item, sessionKey, workspace);
}

function scanPayloadChildren(
  payload: unknown,
  sessionKey: string,
  workspace: string | null
): ChildSessionRecord[] {
  if (!payload || typeof payload !== "object") return [];
  const records: ChildSessionRecord[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const obj = queue.shift();
    if (!obj || typeof obj !== "object" || seen.has(obj)) continue;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        records.push(...processPayloadItem(item, queue, sessionKey, workspace));
      }
      continue;
    }

    const rec = obj as Record<string, unknown>;
    records.push(...parseCollabReceivers(rec, sessionKey, workspace));

    for (const val of Object.values(rec)) {
      records.push(...processPayloadItem(val, queue, sessionKey, workspace));
    }
  }
  return records;
}

export class SpawnSessionRegistry {
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private nextToken = 0;
  private readonly sessions = new Map<string, SpawnSession>();
  // Track non-orchestrator leaf keys separately so worker/explorer traffic
  // never occupies or evicts active orchestrator delegation slots.
  private readonly leafSessions = new Map<string, number>();
  private readonly absenceReasons = new Map<
    string,
    "closed" | "expired" | "evicted"
  >();
  private readonly verifiedChildren = new Map<string, ChildSessionRecord>();
  private readonly openChildren: (parentId: string) => OpenChildThread[];

  private setBounded<V>(
    map: Map<string, V>,
    key: string,
    value: V,
    cap: number
  ): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  registerChildSession(record: ChildSessionRecord): void {
    if (!record?.childId || !record?.parentId) return;
    this.verifiedChildren.set(record.childId, { ...record });
  }

  getChildSession(childId: string): ChildSessionRecord | undefined {
    return this.verifiedChildren.get(childId);
  }

  updateChildStatus(
    childId: string,
    status: ChildSessionRecord["status"]
  ): boolean {
    const record = this.verifiedChildren.get(childId);
    if (!record) return false;
    record.status = status;
    return true;
  }

  /**
   * Make this parent's ownership match Codex's own record of it.
   *
   * Ownership is what Codex's spawn edges say, not what this process happens
   * to remember: a parent reaches a bridge after compaction, after a provider
   * hop from another bridge process, or after a restart, and each of those
   * used to leave its children "not a verified subagent owned by this
   * session". Every open edge becomes a record (parked until the payload says
   * otherwise); a record whose edge is no longer open was closed and is
   * dropped, so it can never be offered for reuse.
   */
  adoptOpenChildren(parentId: string, workspace: string | null): void {
    const open = this.openChildren(parentId);
    const openIds = new Set(open.map((child) => child.childId));
    for (const [childId, record] of this.verifiedChildren) {
      if (record.parentId === parentId && !openIds.has(childId)) {
        this.verifiedChildren.delete(childId);
      }
    }
    for (const child of open) {
      const existing = this.verifiedChildren.get(child.childId);
      if (existing) {
        if (existing.role === "default" && child.role) {
          existing.role = child.role;
        }
        if (!existing.workspace && child.workspace) {
          existing.workspace = child.workspace;
        }
        continue;
      }
      this.registerChildSession({
        childId: child.childId,
        parentId,
        role: child.role ?? "default",
        workspace: child.workspace ?? workspace ?? "",
        status: "parked"
      });
    }
  }

  /**
   * Refine the status (and role) of children this parent already owns from
   * what the turn's payload reports about them.
   *
   * The payload never establishes ownership: a notification or spawn item
   * naming a child Codex has no open edge for -- quoted text, a foreign
   * transcript, a closed handle -- changes nothing.
   */
  refineChildStatuses(
    sessionKey: string,
    workspace: string | null,
    payload: unknown
  ): void {
    // A spawn item says "running"; a later notification says how it ended.
    // Whatever order the scan meets them in, the ending wins.
    const reported = new Map<string, ChildSessionRecord["status"]>();
    for (const record of scanPayloadChildren(payload, sessionKey, workspace)) {
      const existing = this.verifiedChildren.get(record.childId);
      if (!existing || existing.parentId !== sessionKey) continue;
      if (record.status !== "running" || !reported.has(record.childId)) {
        reported.set(record.childId, record.status);
      }
      if (record.role !== "default") {
        existing.role = record.role;
      }
    }
    for (const [childId, status] of reported) {
      const existing = this.verifiedChildren.get(childId);
      if (existing) existing.status = status;
    }
  }
  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleMs = DEFAULT_IDLE_MS,
    now = () => Date.now(),
    openChildren = readOpenChildThreads
  }: SpawnRegistryOptions = {}) {
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.now = now;
    this.openChildren = openChildren;
  }

  /** Whether this turn may collect delegation state at all. */
  static canHold(sessionKey: unknown, sessionScope: unknown): boolean {
    return (
      typeof sessionKey === "string" &&
      sessionKey.trim().length > 0 &&
      sessionScope !== UNIDENTIFIED_SESSION_SCOPE
    );
  }

  /**
   * Begin a turn and return an opaque turn-ownership token. Re-opening a key
   * replaces whatever was there: the previous turn on that conversation is
   * over, and carrying its children forward would spawn them twice.
   *
   * Leaf turns (`orchestrator: false`) are tracked separately so concurrent
   * worker/explorer turns never consume or evict active orchestrator slots.
   */
  open(
    sessionKey: string,
    {
      orchestrator = false,
      role = null,
      workspace = null
    }: {
      orchestrator?: boolean;
      role?: string | null;
      workspace?: string | null;
    } = {}
  ): string {
    this.sweep();
    this.absenceReasons.delete(sessionKey);
    if (!orchestrator) {
      this.sessions.delete(sessionKey);
      this.setBounded(
        this.leafSessions,
        sessionKey,
        this.now(),
        MAX_TRACKED_LEAF_AND_ABSENCE_KEYS
      );
      return "";
    }
    this.leafSessions.delete(sessionKey);
    while (
      this.sessions.size >= this.maxSessions &&
      !this.sessions.has(sessionKey)
    ) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
      this.setBounded(
        this.absenceReasons,
        oldest[0],
        "evicted",
        MAX_TRACKED_LEAF_AND_ABSENCE_KEYS
      );
    }
    const token = String(++this.nextToken);
    this.sessions.set(sessionKey, {
      token,
      orchestrator: true,
      role: typeof role === "string" && role.trim() ? role.trim() : null,
      workspace:
        typeof workspace === "string" && workspace.trim()
          ? workspace.trim()
          : null,
      children: [],
      updatedAt: this.now()
    });
    return token;
  }

  /** Current turn-ownership token for an open orchestrator session. */
  tokenOf(sessionKey: string): string | null {
    return this.sessions.get(sessionKey)?.token ?? null;
  }

  /**
   * Refresh activity timestamp for an open turn so long-running or multi-hop
   * parked turns are not reclaimed by the idle sweep.
   */
  touch(sessionKey: string, token?: string | null): boolean {
    const session = this.sessions.get(sessionKey);
    if (session) {
      if (token !== undefined && token !== null && session.token !== token) {
        return false;
      }
      session.updatedAt = this.now();
      return true;
    }
    if (
      (token === undefined || token === null) &&
      this.leafSessions.has(sessionKey)
    ) {
      this.leafSessions.set(sessionKey, this.now());
      return true;
    }
    return false;
  }

  private refuseMissingSession(sessionKey: string): {
    accepted: false;
    reason: string;
    message: string;
  } {
    if (this.leafSessions.has(sessionKey)) {
      return {
        accepted: false,
        reason: "leaf",
        message:
          "This is a bounded leaf turn and may not delegate. Do the work directly."
      };
    }
    return {
      accepted: false,
      reason: this.absenceReasons.get(sessionKey) ?? "missing",
      message:
        "Delegation is unavailable in this session; no child was created. Do not retry blindly or take over delegated scopes. Report the unavailable delegation path."
    };
  }

  /**
   * Record one delegation request against an in-flight turn.
   *
   * Returns `{ accepted, message }`. A refusal is a readable sentence rather
   * than a transport error because the model is the one who reads it. Missing
   * session state is an admission failure with no child to close; a bounded
   * leaf may instead be told to do the work directly.
   */
  record(
    sessionKey: string,
    children: unknown
  ): {
    accepted: boolean;
    reason?: string;
    message?: string;
    children?: SpawnChild[];
    roles?: string;
    count?: number;
  } {
    const session = this.sessions.get(sessionKey);
    if (!session) return this.refuseMissingSession(sessionKey);
    if (!session.orchestrator)
      return {
        accepted: false,
        reason: "leaf",
        message:
          "This is a bounded leaf turn and may not delegate. Do the work directly."
      };

    const accepted: SpawnChild[] = [];
    for (const raw of Array.isArray(children) ? children : []) {
      const parsed = parseChildCandidate(raw);
      if (!parsed) continue;
      const { message, target, agentType } = parsed;
      if (target) {
        const childRecord = this.verifiedChildren.get(target);
        if (!childRecord) {
          return {
            accepted: false,
            message: `Cannot reuse subagent "${target}": target is not a verified subagent owned by this session. Never provide arbitrary target identifiers.`
          };
        }
        const error = validateReuseTarget(
          target,
          agentType,
          sessionKey,
          session.workspace,
          childRecord
        );
        if (error) return { accepted: false, message: error };
        childRecord.status = "running";
        if (agentType && childRecord.role === "default") {
          childRecord.role = agentType;
        }
        accepted.push({
          agentType: agentType ?? childRecord.role,
          message,
          target
        });
      } else {
        accepted.push({ agentType: agentType ?? null, message });
      }
    }
    if (accepted.length === 0)
      return {
        accepted: false,
        message:
          "Every child needs a non-empty `message`. Nothing was dispatched."
      };

    session.children.push(...accepted);
    session.updatedAt = this.now();
    const roles = formatSessionRoles(accepted);
    return {
      accepted: true,
      children: accepted,
      roles,
      count: accepted.length
    };
  }

  /** Whether this turn is allowed to delegate, for the tool-offer handshake. */
  mayDelegate(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.orchestrator === true;
  }

  /**
   * End the turn and hand back what it asked to spawn.
   *
   * When a turn-ownership `token` is provided, closing with a stale token is
   * a no-op so an aborted or overlapping older turn finishing later cannot
   * tear down a newer turn's active spawn session on the same conversation key.
   */
  close(sessionKey: string, token?: string | null): SpawnChild[] {
    const session = this.sessions.get(sessionKey);
    if (token === null) {
      this.leafSessions.delete(sessionKey);
      return [];
    }
    if (token !== undefined) {
      if (!session || session.token !== token) return [];
      this.sessions.delete(sessionKey);
      this.setBounded(
        this.absenceReasons,
        sessionKey,
        "closed",
        MAX_TRACKED_LEAF_AND_ABSENCE_KEYS
      );
      return session.children;
    }
    this.leafSessions.delete(sessionKey);
    this.sessions.delete(sessionKey);
    if (session) {
      this.setBounded(
        this.absenceReasons,
        sessionKey,
        "closed",
        MAX_TRACKED_LEAF_AND_ABSENCE_KEYS
      );
    }
    return session ? session.children : [];
  }

  /** Drop entries whose turn evidently died without closing them. */
  sweep(): string[] {
    const deadline = this.now() - this.idleMs;
    const expired = [...this.sessions.entries()]
      .filter(([, s]) => s.updatedAt < deadline)
      .map(([key]) => key);
    for (const key of expired) {
      this.sessions.delete(key);
      this.setBounded(
        this.absenceReasons,
        key,
        "expired",
        MAX_TRACKED_LEAF_AND_ABSENCE_KEYS
      );
    }
    for (const [key, updatedAt] of this.leafSessions.entries()) {
      if (updatedAt < deadline) this.leafSessions.delete(key);
    }
    return expired;
  }

  /** Small enough to expose on `/health` without leaking prompts or paths. */
  status(): { held: number; maxSessions: number } {
    return { held: this.sessions.size, maxSessions: this.maxSessions };
  }
}

/**
 * The delegation session this request holds, or null when it holds none.
 *
 * The session key is the agent's Codex thread (`THREAD_ID_HEADER`), falling
 * back to `SESSION_ID_HEADER` when no thread header was sent: the spawn script
 * recovers terminal children under the orchestrator's thread, and every child
 * subagent shares the root's `SESSION_ID_HEADER` while carrying its own
 * `THREAD_ID_HEADER`. Keying by thread keeps concurrent leaf subagents from
 * revoking the active orchestrator session. A request the router could not
 * identify holds none -- the router falls back to one process-wide key, and
 * collecting under it would attach one conversation's delegation to another's
 * turn.
 *
 * Opening replaces whatever was there: the previous turn on that conversation
 * is over, and carrying its children forward would spawn them twice.
 */
export function openSpawnSession(
  headers: unknown,
  registry: SpawnSessionRegistry,
  options: {
    orchestrator: boolean;
    role?: string | null;
    workspace?: string | null;
    payload?: unknown;
  }
): string | null {
  const thread = contextHeaderValue(headers, THREAD_ID_HEADER);
  const session = thread ?? contextHeaderValue(headers, SESSION_ID_HEADER);
  const scope = contextHeaderValue(headers, SESSION_SCOPE_HEADER);
  if (session === null) return null;
  if (!SpawnSessionRegistry.canHold(session, scope)) return null;
  registry.open(session, options);
  if (options.orchestrator) {
    registry.adoptOpenChildren(session, options.workspace ?? null);
    if (options.payload) {
      registry.refineChildStatuses(
        session,
        options.workspace ?? null,
        options.payload
      );
    }
  }
  return session;
}

export { type SpawnChild } from "./spawn-tools.ts";
