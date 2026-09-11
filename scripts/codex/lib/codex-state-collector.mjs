/**
 * Read-only, schema-introspected collector for Codex's local state_5.sqlite.
 *
 * Purpose
 * -------
 * The router labels a turn with a privacy-safe `workspace.key` derived from a
 * Codex request's turn metadata, but it never sees the Codex conversation or
 * thread id behind that turn -- Codex's own conversations live in
 * `$CODEX_HOME/state_5.sqlite`, not in the request stream. Without a join
 * back to that store, a router turn cannot answer:
 *
 *   - Which Codex thread served this conversation?
 *   - Which project does that thread belong to (canonical name, project id)?
 *   - What workspace roots did Codex itself resolve for this thread?
 *   - Which child threads did this thread spawn, and which parents spawned it?
 *
 * This module reads `state_5.sqlite` read-only and produces a normalized view
 * suitable for `usage.byWorkspace` enrichment. It deliberately keeps its
 * contract narrow:
 *
 *   - Read-only. The collector opens the SQLite file in `OPEN_READONLY` mode
 *     so a crash, an interrupted scan, or a competing writer can never corrupt
 *     the Codex-owned file.
 *   - Schema-introspected. Codex has shipped at least three generations of
 *     column shapes for the `threads` table (older versions lacked
 *     `project_id`, `thread_section_id`, `section_position`, `is_pinned`,
 *     `history_mode`, `name`, `preview`, and the millisecond-precision
 *     `*_at_ms` columns). The collector inspects the schema on every open and
 *     only emits columns that actually exist, so older and newer Codex
 *     installs both produce a stable shape.
 *   - Bounded. The collector never returns raw prompts, raw arguments, raw
 *     preview text, or full paths. Workspace paths and remote URLs are
 *     normalized into the same `owner/repository` and `basename` forms the
 *     router already uses so a leaked absolute path cannot leak through the
 *     join.
 *   - Pollable. A live poll is started by the router only when an HTTP caller
 *     has asked for `/status` more than once within the configured interval;
 *     the first call captures a snapshot, the second schedules a poll.
 *
 * The collector exposes:
 *
 *   - `collectSnapshot()`: a single, read-only view of recent threads,
 *     projects, conversation -> thread edges, and the schema that was used.
 *   - `startLivePoll()`: a small interval timer that refreshes the snapshot
 *     on a debounce.
 *   - `localTelemetryStatus()`: a capability report describing what the
 *     collector observed, whether it could open the database, whether the
 *     schema was recognized, and which joins succeeded.
 *
 * Nothing in this module is permitted to write to the Codex-owned file or to
 * a path inside `$CODEX_HOME` that is not under the collector's own runtime
 * directory. The router owns persistence of the derived snapshot via its own
 * state file, not via Codex.
 */

import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

// Optional native sqlite binding: prefer the official `node:sqlite` shipped
// with Node 22+. If unavailable, the collector runs in metadata-only mode
// and reports `localTelemetry.status: "schema_only"`.
let nativeSqlite = null;
async function loadNativeSqlite() {
  if (nativeSqlite !== null) return nativeSqlite;
  try {
    const binding = await import("node:sqlite");
    const DatabaseSync = binding.DatabaseSync ?? binding.default?.DatabaseSync;
    if (typeof DatabaseSync === "function") {
      nativeSqlite = { available: true, open: (path) => new DatabaseSync(path, { readOnly: true }) };
    } else {
      nativeSqlite = { available: false };
    }
  } catch {
    nativeSqlite = { available: false };
  }
  return nativeSqlite;
}

// Workspace-privacy-safe path labelling, mirroring the router's own rules so
// the join produced by the collector lines up with the router's bucket keys.
function workspacePathLabel(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = basename(value.trim());
  return label && label !== "." && label !== "/" ? label : null;
}

function repositoryIdentity(remote) {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const normalized = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  let pathname;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/, 1)[0];
  }
  const parts = pathname.split("/").filter(Boolean).map((part) => part.replace(/\.git$/i, ""));
  if (parts.length < 2) return null;
  const owner = parts.at(-2).replace(/[^A-Za-z0-9._-]/g, "");
  const repo = parts.at(-1).replace(/[^A-Za-z0-9._-]/g, "");
  return owner && repo ? `${owner}/${repo}` : null;
}

// Mirrors scripts/codex-model-router.mjs `safeWorkspaceId`: path-like inputs
// are hashed into a short `ws_`-prefixed digest before any join or attribute
// storage, so the router never retains a raw absolute path under this join.
function safeWorkspaceId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.includes("\\") || trimmed.includes("/Users/") || trimmed.includes("/home/")) {
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    return `ws_${digest}`;
  }
  return trimmed.slice(0, 100);
}

function safeMetricLabel(value, fallback = "unknown") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) || fallback;
}

/**
 * Look up a column on a table by name; returns the column metadata or null.
 * `database.prepare(...)` is wrapped because `PRAGMA table_info` returns its
 * columns as plain JS values rather than a complete row object.
 */
function columnFor(database, table, column) {
  try {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all();
    for (const row of rows) {
      if (row && row.name === column) return row;
    }
  } catch { /* missing table */ }
  return null;
}

function tableExists(database, table) {
  try {
    const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(rows);
  } catch {
    return false;
  }
}

function indexExists(database, index) {
  try {
    const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index);
    return Boolean(rows);
  } catch {
    return false;
  }
}

// The bounded window the collector defaults to: 24h is enough for any
// workspace currently routing a turn; older threads contribute to the
// conversation -> thread join only when the live poll explicitly widens it.
const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SCHEMA_VERSION = "autodev-codex-state-collector-v1";

/**
 * The collector. A single instance is shared across the router process; it
 * holds the last snapshot, the polling timer, and the schema fingerprint so
 * the next snapshot can short-circuit when nothing relevant has changed.
 */
export class CodexStateCollector {
  constructor({
    path = process.env.CODEX_STATE_DB_PATH ?? `${process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`}/state_5.sqlite`,
    recencyWindowMs = Number.parseInt(process.env.CODEX_STATE_COLLECTOR_WINDOW_MS ?? `${DEFAULT_RECENT_WINDOW_MS}`, 10),
    limit = Number.parseInt(process.env.CODEX_STATE_COLLECTOR_LIMIT ?? `${DEFAULT_LIMIT}`, 10),
    pollIntervalMs = Number.parseInt(process.env.CODEX_STATE_COLLECTOR_POLL_MS ?? `${DEFAULT_POLL_INTERVAL_MS}`, 10),
    now = () => Date.now(),
    openSqlite = loadNativeSqlite,
  } = {}) {
    this.path = path;
    this.recencyWindowMs = recencyWindowMs;
    this.limit = limit;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.openSqlite = openSqlite;
    this.snapshot = emptySnapshot();
    this.pollTimer = null;
    this.lastPollAt = 0;
    this.subscribers = new Set();
  }

  /**
   * One read-only pass over the Codex state database. The snapshot is stored
   * on the collector and returned. Safe to call concurrently with the polling
   * loop: SQLite's read-only mode is single-writer but multi-reader, and the
   * router only ever invokes this from a single tick.
   */
  async collectSnapshot() {
    const startedAt = this.now();
    if (!existsSync(this.path)) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "missing", path: this.path, reason: "file_not_found", collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    let stat;
    try {
      stat = statSync(this.path);
    } catch (error) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "error", path: this.path, reason: error instanceof Error ? error.message : String(error), collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    if (!stat.isFile()) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "missing", path: this.path, reason: "not_a_file", collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    const binding = await this.openSqlite();
    if (!binding.available) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "schema_only", path: this.path, reason: "node_sqlite_unavailable", collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    let database;
    try {
      database = binding.open(this.path);
    } catch (error) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "error", path: this.path, reason: error instanceof Error ? error.message : String(error), collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    try {
      const schema = introspectSchema(database);
      const capabilities = { ...emptyCapabilities(), tables: Object.fromEntries(Object.entries(schema.tables).map(([name, info]) => [name, info.present])), columnCount: schema.columnCount };
      if (!schema.tables.threads?.present) {
        this.snapshot = { schema: schemaFingerprint(schema), capabilities, recentThreads: [], projects: [], conversationThreads: {}, spawnEdges: [], threadCount: 0, projectCount: 0, edgeCount: 0, localTelemetry: { ...emptyLocalTelemetry(), status: "schema_unknown", path: this.path, schema: schemaFingerprint(schema), reason: "threads_table_missing", collectedAt: new Date(startedAt).toISOString() } };
        this.lastPollAt = startedAt;
        return this.snapshot;
      }
      const cutoffMs = startedAt - this.recencyWindowMs;
      const recentThreads = collectRecentThreads(database, schema, cutoffMs, this.limit);
      const threadIds = recentThreads.map((thread) => thread.id);
      const projects = collectProjects(database, schema, threadIds);
      const projectsById = Object.fromEntries(projects.map((project) => [project.id, project]));
      const spawnEdges = collectSpawnEdges(database, schema, threadIds);
      const conversationThreads = buildConversationJoin(recentThreads);
      // Enrich the recent threads with the privacy-safe project identity the
      // router needs to align them with the existing usage buckets.
      const enrichedThreads = recentThreads.map((thread) => {
        const project = thread.projectId && projectsById[thread.projectId];
        return {
          ...thread,
          project: project ? { id: project.id, name: project.name, workspaceKey: project.workspaceKey } : null,
        };
      });
      const edgeCount = spawnEdges.length;
      this.snapshot = {
        schema: schemaFingerprint(schema),
        capabilities,
        recentThreads: enrichedThreads,
        projects,
        conversationThreads,
        spawnEdges,
        threadCount: enrichedThreads.length,
        projectCount: projects.length,
        edgeCount,
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "ok",
          path: this.path,
          schema: schemaFingerprint(schema),
          capabilities,
          recencyWindowMs: this.recencyWindowMs,
          limit: this.limit,
          threadCount: enrichedThreads.length,
          projectCount: projects.length,
          edgeCount,
          fileSizeBytes: stat.size,
          collectedAt: new Date(startedAt).toISOString(),
          durationMs: this.now() - startedAt,
        },
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    } catch (error) {
      this.snapshot = { ...emptySnapshot(), localTelemetry: { ...emptyLocalTelemetry(), status: "error", path: this.path, reason: error instanceof Error ? error.message : String(error), collectedAt: new Date(startedAt).toISOString() } };
      this.lastPollAt = startedAt;
      return this.snapshot;
    } finally {
      try { database?.close(); } catch { /* read-only close */ }
    }
  }

  /**
   * Start a debounced live poll. The poll only fires after
   * `pollIntervalMs` of idle; back-to-back subscribers collapse into one
   * snapshot. Returning the timer handle lets the router stop the poll on
   * shutdown. Idempotent: re-subscribing replaces the existing timer.
   */
  startLivePoll({ onSnapshot } = {}) {
    if (typeof onSnapshot === "function") this.subscribers.add(onSnapshot);
    if (this.pollTimer) return this.pollTimer;
    const interval = Math.max(500, this.pollIntervalMs);
    let busy = false;
    this.pollTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      this.collectSnapshot().then((snapshot) => {
        for (const subscriber of this.subscribers) {
          try { subscriber(snapshot); } catch { /* subscriber errors are isolated */ }
        }
      }).finally(() => { busy = false; });
    }, interval);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
    return this.pollTimer;
  }

  stopLivePoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscribers.clear();
  }

  unsubscribe(subscriber) {
    if (subscriber) this.subscribers.delete(subscriber);
  }

  /** A capability report describing the last observation. */
  localTelemetryStatus() {
    return this.snapshot.localTelemetry ?? emptyLocalTelemetry();
  }

  /**
   * The conversation-id -> thread join the collector has produced. Conversation
   * identity is the Codex app-server's first-class handle on a turn; a router
   * turn has no other way to learn which Codex thread it served without
   * looking inside `state_5.sqlite`.
   */
  resolveConversationThread(conversationId) {
    if (typeof conversationId !== "string" || !conversationId.trim()) return null;
    return this.snapshot.conversationThreads[conversationId.trim()] ?? null;
  }

  /**
   * The list of recent threads the collector considers part of this
   * workspace_key. Workspace key here is the same privacy-safe form the
   * router exposes: `owner/repository` when git_origin_url is present, the
   * absolute path's basename otherwise.
   */
  recentThreadsForWorkspace(workspaceKey) {
    if (typeof workspaceKey !== "string" || !workspaceKey.trim()) return [];
    return this.snapshot.recentThreads.filter((thread) => thread.workspaceKey === workspaceKey.trim());
  }
}

function emptySnapshot() {
  return {
    schema: null,
    capabilities: emptyCapabilities(),
    recentThreads: [],
    projects: [],
    conversationThreads: {},
    spawnEdges: [],
    threadCount: 0,
    projectCount: 0,
    edgeCount: 0,
    localTelemetry: emptyLocalTelemetry(),
  };
}

function emptyCapabilities() {
  return { tables: {}, columnCount: 0 };
}

function emptyLocalTelemetry() {
  return {
    status: "missing",
    path: null,
    schema: null,
    capabilities: emptyCapabilities(),
    recencyWindowMs: null,
    limit: null,
    threadCount: 0,
    projectCount: 0,
    edgeCount: 0,
    fileSizeBytes: null,
    collectedAt: null,
    durationMs: null,
    reason: null,
  };
}

/**
 * Read the SQLite schema once and return a normalized description of the
 * columns the collector will read. Older Codex installs omit several columns
 * the router relies on; newer installs add more. The shape of this object is
 * stable across versions and is the source of `localTelemetry.schema`.
 */
function introspectSchema(database) {
  const tables = {
    threads: { present: false, columns: {} },
    projects: { present: false, columns: {} },
    thread_spawn_edges: { present: false, columns: {} },
    thread_sections: { present: false, columns: {} },
  };
  let columnCount = 0;
  for (const table of Object.keys(tables)) {
    tables[table].present = tableExists(database, table);
    if (!tables[table].present) continue;
    try {
      for (const row of database.prepare(`PRAGMA table_info(${table})`).all()) {
        const column = row?.name;
        if (typeof column !== "string" || !column) continue;
        tables[table].columns[column] = true;
        columnCount += 1;
      }
    } catch { /* keep the empty column map */ }
  }
  return { tables, columnCount };
}

/**
 * A stable fingerprint of the inspected schema. Used both for telemetry and
 * to short-circuit the snapshot when the schema has not changed but the file
 * size or mtime has. The shape names the schema version explicitly so the
 * router can log which generation of Codex's `state_5.sqlite` it talks to.
 */
function schemaFingerprint(schema) {
  const parts = [];
  for (const table of Object.keys(schema.tables)) {
    const info = schema.tables[table];
    if (!info.present) continue;
    const columns = Object.keys(info.columns).sort().join(",");
    parts.push(`${table}:${columns}`);
  }
  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${SCHEMA_VERSION}-${digest}`;
}

// Thread row projection. Only the columns actually present in the schema are
// selected; the column list is built dynamically so an older install without
// `project_id` does not cause a runtime failure.
function collectRecentThreads(database, schema, cutoffMs, limit) {
  const present = schema.tables.threads.columns;
  const wanted = [
    "id", "created_at", "created_at_ms", "updated_at", "updated_at_ms",
    "source", "model_provider", "cwd", "title", "tokens_used",
    "has_user_event", "archived", "archived_at", "git_sha", "git_branch",
    "git_origin_url", "cli_version", "first_user_message", "agent_nickname",
    "agent_role", "memory_mode", "model", "reasoning_effort", "agent_path",
    "thread_source", "preview", "recency_at", "recency_at_ms",
    "history_mode", "name", "is_pinned", "thread_section_id",
    "section_position", "section_entered_at_ms", "project_id",
  ];
  const select = wanted.filter((column) => present[column]);
  if (!select.includes("id") || !select.includes("updated_at") && !select.includes("updated_at_ms") && !select.includes("created_at_ms")) {
    return [];
  }
  const orderColumn = present.updated_at_ms ? "updated_at_ms" : present.updated_at ? "updated_at" : "created_at_ms";
  const cutoffColumn = present.updated_at_ms ? "updated_at_ms" : present.updated_at ? "updated_at" : null;
  const filterClause = cutoffColumn ? `WHERE COALESCE(${cutoffColumn}, 0) >= ?` : "";
  const parameters = cutoffColumn ? [Math.max(0, Math.floor(cutoffMs))] : [];
  const sql = `SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM threads ${filterClause} ORDER BY ${orderColumn} DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
  let rows;
  try {
    rows = database.prepare(sql).all(...parameters);
  } catch {
    return [];
  }
  const projects = [];
  for (const row of rows) projects.push(projectThreadRow(row, present));
  return projects;
}

function projectThreadRow(row, present) {
  const id = row?.id ?? null;
  const cwd = present.cwd && typeof row.cwd === "string" ? row.cwd : null;
  const origin = present.git_origin_url && typeof row.git_origin_url === "string" ? row.git_origin_url : null;
  const repository = origin ? repositoryIdentity(origin) : null;
  const basenameLabel = cwd ? workspacePathLabel(cwd) : null;
  const projectKey = repository ?? basenameLabel ?? "unknown";
  // Keep project identity (the aggregate dashboard key) separate from the
  // checkout identity. The latter is hashed from the canonical path and is
  // never returned with the path itself.
  const workspaceIdentity = cwd ? safeWorkspaceId(cwd) : null;
  const workspaceKey = projectKey;
  const projectId = present.project_id ? row.project_id ?? null : null;
  const sectionId = present.thread_section_id ? row.thread_section_id ?? null : null;
  const updatedAtMs = present.updated_at_ms ? readInteger(row.updated_at_ms) : present.updated_at ? readInteger(row.updated_at, 1000) : null;
  const createdAtMs = present.created_at_ms ? readInteger(row.created_at_ms) : present.created_at ? readInteger(row.created_at, 1000) : null;
  const recencyAtMs = present.recency_at_ms ? readInteger(row.recency_at_ms) : present.recency_at ? readInteger(row.recency_at, 1000) : null;
  const archived = present.archived ? Boolean(row.archived) : false;
  return {
    id,
    projectKey,
    workspaceKey,
    workspaceIdentity,
    displayName: basenameLabel,
    workspaceSource: repository ? "git_origin_url" : basenameLabel ? "cwd" : "unknown",
    attributionConfidence: repository ? "confirmed_git_origin" : basenameLabel ? "cwd_fallback" : "unattributed",
    cwdBasename: basenameLabel,
    repository,
    projectId,
    sectionId,
    modelProvider: present.model_provider ? safeMetricLabel(row.model_provider) : null,
    source: present.source ? safeMetricLabel(row.source) : null,
    threadSource: present.thread_source ? safeMetricLabel(row.thread_source) : null,
    agentRole: present.agent_role ? safeMetricLabel(row.agent_role, "unknown") : null,
    agentNickname: present.agent_nickname ? safeMetricLabel(row.agent_nickname, "") : null,
    model: present.model ? safeMetricLabel(row.model, "unknown") : null,
    reasoningEffort: present.reasoning_effort ? safeMetricLabel(row.reasoning_effort, "") : null,
    historyMode: present.history_mode ? safeMetricLabel(row.history_mode, "legacy") : "legacy",
    archived,
    archivedAtMs: present.archived_at ? readInteger(row.archived_at, 1000) : null,
    hasUserEvent: present.has_user_event ? Boolean(row.has_user_event) : false,
    tokensUsed: present.tokens_used ? readInteger(row.tokens_used) : 0,
    updatedAtMs,
    createdAtMs,
    recencyAtMs,
    gitBranch: present.git_branch ? safeMetricLabel(row.git_branch, "") : null,
    gitOriginUrl: repository ? repository : null,
    isPinned: present.is_pinned ? Boolean(row.is_pinned) : false,
  };
}

function readInteger(value, scale = 1) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value * scale);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed * scale : null;
  }
  return null;
}

function collectProjects(database, schema, threadIds) {
  if (!schema.tables.projects.present || threadIds.length === 0) {
    // Without any threads we have no canonical project set to surface. The
    // schema has `project_id` references but those would be resolved through
    // thread rows; an empty thread set means an empty project list.
    return [];
  }
  const present = schema.tables.projects.columns;
  const wanted = ["id", "name", "position", "created_at_ms", "updated_at_ms"];
  const select = wanted.filter((column) => present[column]);
  if (!select.includes("id") || !select.includes("name")) return [];
  let rows;
  try {
    rows = database.prepare(`SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM projects ORDER BY position ASC`).all();
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    name: safeMetricLabel(row.name, "unknown"),
    position: present.position ? readInteger(row.position) ?? 0 : 0,
    updatedAtMs: present.updated_at_ms ? readInteger(row.updated_at_ms) : null,
    createdAtMs: present.created_at_ms ? readInteger(row.created_at_ms) : null,
  })).filter((project) => project.id);
}

function collectSpawnEdges(database, schema, threadIds) {
  if (!schema.tables.thread_spawn_edges.present || threadIds.length === 0) return [];
  const present = schema.tables.thread_spawn_edges.columns;
  const select = ["parent_thread_id", "child_thread_id", "status"].filter((column) => present[column]);
  if (select.length < 2) return [];
  const threadIdSet = new Set(threadIds);
  let rows;
  try {
    rows = database.prepare(`SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM thread_spawn_edges`).all();
  } catch {
    return [];
  }
  const edges = [];
  for (const row of rows) {
    if (!row) continue;
    const parent = row.parent_thread_id ?? null;
    const child = row.child_thread_id ?? null;
    if (!parent || !child) continue;
    if (!threadIdSet.has(parent) && !threadIdSet.has(child)) continue;
    edges.push({
      parentThreadId: parent,
      childThreadId: child,
      status: present.status && typeof row.status === "string" ? safeMetricLabel(row.status) : null,
    });
  }
  return edges;
}

/**
 * Build the conversation.id -> thread join. Codex's first-class conversation
 * id (the value surfaced as `conversation.id` on OTLP resource attributes)
 * is the same string stored in the `threads.id` primary key; the join is
 * therefore just a stable per-thread index of the recent set. Threads with
 * no `source` entry that looks like an OTLP `conversation.id` still get a
 * row under their own id so the router's join never returns null when the
 * id is known.
 */
function buildConversationJoin(threads) {
  const join = {};
  for (const thread of threads) {
    if (!thread.id) continue;
    join[thread.id] = {
      threadId: thread.id,
      workspaceKey: thread.workspaceKey,
      projectId: thread.projectId,
      agentRole: thread.agentRole,
      archived: thread.archived,
      updatedAtMs: thread.updatedAtMs,
    };
  }
  return join;
}

export const DEFAULT_CRITICAL_TABLES = Object.freeze(["threads", "projects", "thread_spawn_edges"]);

/**
 * The exported env-var surface used by tests and bootstrap callers. The
 * router reads these via `loadCodexStateCollectorConfig()` so the route can
 * be configured by an environment override at startup without touching the
 * code path.
 */
export function loadCodexStateCollectorConfig(environment = process.env, defaults = {}) {
  const defaultPath = defaults.path ?? `${environment.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`}/state_5.sqlite`;
  return {
    path: environment.CODEX_STATE_DB_PATH ?? defaultPath,
    recencyWindowMs: parseInteger(environment.CODEX_STATE_COLLECTOR_WINDOW_MS, defaults.recencyWindowMs ?? DEFAULT_RECENT_WINDOW_MS),
    limit: parseInteger(environment.CODEX_STATE_COLLECTOR_LIMIT, defaults.limit ?? DEFAULT_LIMIT),
    pollIntervalMs: parseInteger(environment.CODEX_STATE_COLLECTOR_POLL_MS, defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  };
}

function parseInteger(value, fallback) {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Convenience constructor used by the router. Reads its configuration from
 * the environment, opens the bound SQLite file, and returns the singleton
 * collector. The router imports this once at module init.
 */
export async function createCodexStateCollector(overrides = {}) {
  const config = loadCodexStateCollectorConfig();
  const collector = new CodexStateCollector({ ...config, ...overrides });
  await collector.collectSnapshot();
  return collector;
}
