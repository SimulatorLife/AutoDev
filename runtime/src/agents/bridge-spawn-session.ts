import {
  SESSION_ID_HEADER,
  SESSION_SCOPE_HEADER
} from "@simulatorlife/autodev-runtime/router/subagents";

import type { SpawnChild } from "./spawn-tools.ts";
export type { SpawnChild };

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
}

// Defence in depth only: every turn closes its own session in a finally block,
// so reaching either of these means a turn died in a way that skipped it.
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_MS = 900_000;

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
  private readonly sessions = new Map<string, SpawnSession>();
  private readonly verifiedChildren = new Map<string, ChildSessionRecord>();

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

  scanAndRegisterChildren(
    sessionKey: string,
    workspace: string | null,
    payload: unknown
  ): void {
    const records = scanPayloadChildren(payload, sessionKey, workspace);
    for (const record of records) {
      const existing = this.verifiedChildren.get(record.childId);
      if (existing) {
        if (
          record.status !== "running" ||
          (existing.status !== "completed" && existing.status !== "parked")
        ) {
          existing.status = record.status;
        }
        if (record.role !== "default") {
          existing.role = record.role;
        }
        if (record.workspace && !existing.workspace) {
          existing.workspace = record.workspace;
        }
      } else {
        this.registerChildSession(record);
      }
    }
  }
  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleMs = DEFAULT_IDLE_MS,
    now = () => Date.now()
  }: SpawnRegistryOptions = {}) {
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.now = now;
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
   * Begin a turn. Re-opening a key replaces whatever was there: the previous
   * turn on that conversation is over, and carrying its children forward would
   * spawn them twice.
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
  ): void {
    this.sweep();
    while (
      this.sessions.size >= this.maxSessions &&
      !this.sessions.has(sessionKey)
    ) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
    this.sessions.set(sessionKey, {
      orchestrator,
      role: typeof role === "string" && role.trim() ? role.trim() : null,
      workspace:
        typeof workspace === "string" && workspace.trim()
          ? workspace.trim()
          : null,
      children: [],
      updatedAt: this.now()
    });
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
    message?: string;
    children?: SpawnChild[];
    roles?: string;
    count?: number;
  } {
    const session = this.sessions.get(sessionKey);
    if (!session)
      return {
        accepted: false,
        message:
          "Delegation is unavailable in this session; no child was created. Do not retry blindly or take over delegated scopes. Report the unavailable delegation path."
      };
    if (!session.orchestrator)
      return {
        accepted: false,
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

  /** End the turn and hand back what it asked to spawn. */
  close(sessionKey: string): SpawnChild[] {
    const session = this.sessions.get(sessionKey);
    this.sessions.delete(sessionKey);
    return session ? session.children : [];
  }

  /** Drop entries whose turn evidently died without closing them. */
  sweep(): string[] {
    const deadline = this.now() - this.idleMs;
    const expired = [...this.sessions.entries()]
      .filter(([, s]) => s.updatedAt < deadline)
      .map(([key]) => key);
    for (const key of expired) this.sessions.delete(key);
    return expired;
  }

  /** Small enough to expose on `/health` without leaking prompts or paths. */
  status(): { held: number; maxSessions: number } {
    return { held: this.sessions.size, maxSessions: this.maxSessions };
  }
}

/**
 * One header's value, or null when it was not sent.
 *
 * Node lowercases inbound header names; intermediaries may not.
 */
function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name
  );
  const value = key === undefined ? undefined : record[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

/**
 * The delegation session this request holds, or null when it holds none.
 *
 * The session key is the Codex conversation: the spawn script recovers
 * terminal children under it, so it has to be the thread id and not a
 * bridge-local token. A request the router could not identify holds none --
 * the router falls back to one process-wide key, and collecting under it
 * would attach one conversation's delegation to another's turn.
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
  const session = headerValue(headers, SESSION_ID_HEADER);
  const scope = headerValue(headers, SESSION_SCOPE_HEADER);
  if (session === null) return null;
  if (!SpawnSessionRegistry.canHold(session, scope)) return null;
  registry.open(session, options);
  if (options.payload) {
    registry.scanAndRegisterChildren(
      session,
      options.workspace ?? null,
      options.payload
    );
  }
  return session;
}
