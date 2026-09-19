/**
 * Read-only, schema-introspected collector for Codex's local state_5.sqlite.
 *
 * The router cannot see the Codex conversation or thread id behind a turn.
 * This module reads Codex's database read-only and produces a bounded,
 * privacy-safe view for status and workspace attribution.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

export type SqliteRow = Record<string, unknown>;

export interface SqliteStatement {
  all(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteBinding {
  available: boolean;
  open(path: string): SqliteDatabase;
}

type SqliteLoader = () => Promise<SqliteBinding>;
type SnapshotSubscriber = (snapshot: CodexStateSnapshot) => void;

type SchemaTableName =
  "threads" | "projects" | "thread_spawn_edges" | "thread_sections";

export interface SchemaTable {
  present: boolean;
  columns: Record<string, boolean>;
}

export interface StateSchema {
  tables: Record<SchemaTableName, SchemaTable>;
  columnCount: number;
}

export interface StateCapabilities {
  tables: Record<string, boolean>;
  columnCount: number;
}

export type LocalTelemetryStatus =
  "missing" | "error" | "schema_only" | "schema_unknown" | "ok";

export interface LocalTelemetry {
  status: LocalTelemetryStatus;
  path: string | null;
  schema: string | null;
  capabilities: StateCapabilities;
  recencyWindowMs: number | null;
  limit: number | null;
  threadCount: number;
  projectCount: number;
  edgeCount: number;
  fileSizeBytes: number | null;
  collectedAt: string | null;
  durationMs: number | null;
  reason: string | null;
}

export interface StateProject {
  id: string;
  name: string;
  position: number;
  updatedAtMs: number | null;
  createdAtMs: number | null;
  workspaceKey?: string;
}

export interface StateProjectIdentity {
  id: string;
  name: string;
  workspaceKey?: string;
}

export interface StateThread {
  id: string | null;
  projectKey: string;
  workspaceKey: string;
  workspaceIdentity: string | null;
  displayName: string | null;
  workspaceSource: "git_origin_url" | "cwd" | "unknown";
  attributionConfidence:
    "confirmed_git_origin" | "cwd_fallback" | "unattributed";
  cwdBasename: string | null;
  repository: string | null;
  projectId: string | null;
  sectionId: string | null;
  modelProvider: string | null;
  source: string | null;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  model: string | null;
  reasoningEffort: string | null;
  historyMode: string;
  archived: boolean;
  archivedAtMs: number | null;
  hasUserEvent: boolean;
  tokensUsed: number;
  updatedAtMs: number | null;
  createdAtMs: number | null;
  recencyAtMs: number | null;
  gitBranch: string | null;
  gitOriginUrl: string | null;
  isPinned: boolean;
  project?: StateProjectIdentity | null;
}

export interface ConversationThread {
  threadId: string;
  workspaceKey: string;
  projectId: string | null;
  agentRole: string | null;
  archived: boolean;
  updatedAtMs: number | null;
}

export interface SpawnEdge {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
}

export interface CodexStateSnapshot {
  schema: string | null;
  capabilities: StateCapabilities;
  recentThreads: StateThread[];
  projects: StateProject[];
  conversationThreads: Record<string, ConversationThread>;
  spawnEdges: SpawnEdge[];
  threadCount: number;
  projectCount: number;
  edgeCount: number;
  localTelemetry: LocalTelemetry;
}

export interface StateCollectorConfig {
  path: string;
  recencyWindowMs: number;
  limit: number;
  pollIntervalMs: number;
}

export interface StateCollectorOptions {
  path?: string;
  recencyWindowMs?: number;
  limit?: number;
  pollIntervalMs?: number;
  now?: () => number;
  openSqlite?: SqliteLoader;
}

// Optional native sqlite binding: prefer the official `node:sqlite` shipped
// with Node 24+. If unavailable, the collector runs in metadata-only mode and
// reports `localTelemetry.status: "schema_only"`.
let nativeSqlite: SqliteBinding | null = null;
async function loadNativeSqlite(): Promise<SqliteBinding> {
  if (nativeSqlite !== null) return nativeSqlite;
  try {
    const binding = await import("node:sqlite");
    if (typeof binding.DatabaseSync === "function") {
      nativeSqlite = {
        available: true,
        open: (path: string) =>
          new binding.DatabaseSync(path, {
            readOnly: true
          }) as unknown as SqliteDatabase
      };
    } else {
      nativeSqlite = {
        available: false,
        open: () => {
          throw new Error("node:sqlite is unavailable");
        }
      };
    }
  } catch {
    nativeSqlite = {
      available: false,
      open: () => {
        throw new Error("node:sqlite is unavailable");
      }
    };
  }
  return nativeSqlite;
}

function workspacePathLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const label = basename(value.trim());
  return label && label !== "." && label !== "/" ? label : null;
}

function repositoryIdentity(remote: unknown): string | null {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const normalized = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  let pathname = "";
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/, 1)[0] ?? "";
  }
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/\.git$/i, ""));
  if (parts.length < 2) return null;
  const owner = parts.at(-2)?.replaceAll(/[^A-Za-z0-9._-]/g, "") ?? "";
  const repo = parts.at(-1)?.replaceAll(/[^A-Za-z0-9._-]/g, "") ?? "";
  return owner && repo ? `${owner}/${repo}` : null;
}

// Mirrors the router's safeWorkspaceId: path-like inputs are hashed before
// any join or attribute storage, so raw absolute paths cannot leak through.
function safeWorkspaceId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.includes("\\") ||
    trimmed.includes("/Users/") ||
    trimmed.includes("/home/")
  ) {
    const digest = createHash("sha256")
      .update(trimmed)
      .digest("hex")
      .slice(0, 12);
    return `ws_${digest}`;
  }
  return trimmed.slice(0, 100);
}

function safeMetricLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return (
    value
      .trim()
      .replaceAll(/[\u0000-\u001F\u007F]/g, "")
      .slice(0, 100) || fallback
  );
}

function isRow(value: unknown): value is SqliteRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rows(value: unknown): SqliteRow[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function rowValue(row: SqliteRow, column: string): unknown {
  return row[column];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  try {
    return isRow(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(table)
    );
  } catch {
    return false;
  }
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const SCHEMA_VERSION = "autodev-codex-state-collector-v1";

/** The read-only collector shared by the router and status tooling. */
export class CodexStateCollector {
  path: string;
  recencyWindowMs: number;
  limit: number;
  pollIntervalMs: number;
  now: () => number;
  openSqlite: SqliteLoader;
  snapshot: CodexStateSnapshot;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastPollAt: number;
  subscribers: Set<SnapshotSubscriber>;

  constructor(options: StateCollectorOptions = {}) {
    this.path =
      options.path ??
      process.env.CODEX_STATE_DB_PATH ??
      `${process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`}/state_5.sqlite`;
    this.recencyWindowMs =
      options.recencyWindowMs ??
      Number.parseInt(
        process.env.CODEX_STATE_COLLECTOR_WINDOW_MS ??
          `${DEFAULT_RECENT_WINDOW_MS}`
      );
    this.limit =
      options.limit ??
      Number.parseInt(
        process.env.CODEX_STATE_COLLECTOR_LIMIT ?? `${DEFAULT_LIMIT}`
      );
    this.pollIntervalMs =
      options.pollIntervalMs ??
      Number.parseInt(
        process.env.CODEX_STATE_COLLECTOR_POLL_MS ??
          `${DEFAULT_POLL_INTERVAL_MS}`
      );
    this.now = options.now ?? (() => Date.now());
    this.openSqlite = options.openSqlite ?? loadNativeSqlite;
    this.snapshot = emptySnapshot();
    this.pollTimer = null;
    this.lastPollAt = 0;
    this.subscribers = new Set<SnapshotSubscriber>();
  }

  /** One read-only pass over the Codex state database. */
  async collectSnapshot(): Promise<CodexStateSnapshot> {
    const startedAt = this.now();
    if (!existsSync(this.path)) {
      this.snapshot = {
        ...emptySnapshot(),
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "missing",
          path: this.path,
          reason: "file_not_found",
          collectedAt: new Date(startedAt).toISOString()
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    let stat;
    try {
      stat = statSync(this.path);
    } catch (error) {
      this.snapshot = {
        ...emptySnapshot(),
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "error",
          path: this.path,
          reason: errorMessage(error),
          collectedAt: new Date(startedAt).toISOString()
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    if (!stat.isFile()) {
      this.snapshot = {
        ...emptySnapshot(),
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "missing",
          path: this.path,
          reason: "not_a_file",
          collectedAt: new Date(startedAt).toISOString()
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    const binding = await this.openSqlite();
    if (!binding.available) {
      this.snapshot = {
        ...emptySnapshot(),
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "schema_only",
          path: this.path,
          reason: "node_sqlite_unavailable",
          collectedAt: new Date(startedAt).toISOString()
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    }
    let database: SqliteDatabase | null = null;
    try {
      database = binding.open(this.path);
      const schema = introspectSchema(database);
      const capabilities: StateCapabilities = {
        ...emptyCapabilities(),
        tables: Object.fromEntries(
          Object.entries(schema.tables).map(([name, info]) => [
            name,
            info.present
          ])
        ),
        columnCount: schema.columnCount
      };
      if (!schema.tables.threads.present) {
        const fingerprint = schemaFingerprint(schema);
        this.snapshot = {
          schema: fingerprint,
          capabilities,
          recentThreads: [],
          projects: [],
          conversationThreads: {},
          spawnEdges: [],
          threadCount: 0,
          projectCount: 0,
          edgeCount: 0,
          localTelemetry: {
            ...emptyLocalTelemetry(),
            status: "schema_unknown",
            path: this.path,
            schema: fingerprint,
            reason: "threads_table_missing",
            collectedAt: new Date(startedAt).toISOString()
          }
        };
        this.lastPollAt = startedAt;
        return this.snapshot;
      }
      const cutoffMs = startedAt - this.recencyWindowMs;
      const recentThreads = collectRecentThreads(
        database,
        schema,
        cutoffMs,
        this.limit
      );
      const threadIds = recentThreads
        .map((thread) => thread.id)
        .filter((id): id is string => typeof id === "string");
      const projects = collectProjects(database, schema, threadIds);
      const projectsById = Object.fromEntries(
        projects.map((project) => [project.id, project])
      );
      const spawnEdges = collectSpawnEdges(database, schema, threadIds);
      const conversationThreads = buildConversationJoin(recentThreads);
      const enrichedThreads = recentThreads.map((thread): StateThread => {
        const project =
          thread.projectId === null
            ? undefined
            : projectsById[thread.projectId];
        return {
          ...thread,
          project: project
            ? {
                id: project.id,
                name: project.name,
                ...(project.workspaceKey === undefined
                  ? {}
                  : { workspaceKey: project.workspaceKey })
              }
            : null
        };
      });
      const edgeCount = spawnEdges.length;
      const fingerprint = schemaFingerprint(schema);
      this.snapshot = {
        schema: fingerprint,
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
          schema: fingerprint,
          capabilities,
          recencyWindowMs: this.recencyWindowMs,
          limit: this.limit,
          threadCount: enrichedThreads.length,
          projectCount: projects.length,
          edgeCount,
          fileSizeBytes: stat.size,
          collectedAt: new Date(startedAt).toISOString(),
          durationMs: this.now() - startedAt
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    } catch (error) {
      this.snapshot = {
        ...emptySnapshot(),
        localTelemetry: {
          ...emptyLocalTelemetry(),
          status: "error",
          path: this.path,
          reason: errorMessage(error),
          collectedAt: new Date(startedAt).toISOString()
        }
      };
      this.lastPollAt = startedAt;
      return this.snapshot;
    } finally {
      try {
        database?.close();
      } catch {
        /* read-only close */
      }
    }
  }

  /** Start an idempotent debounced live poll. */
  startLivePoll({
    onSnapshot
  }: { onSnapshot?: SnapshotSubscriber } = {}): ReturnType<typeof setInterval> {
    if (typeof onSnapshot === "function") this.subscribers.add(onSnapshot);
    if (this.pollTimer) return this.pollTimer;
    const interval = Math.max(500, this.pollIntervalMs);
    let busy = false;
    this.pollTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.collectSnapshot()
        .then((snapshot) => {
          for (const subscriber of this.subscribers) {
            try {
              subscriber(snapshot);
            } catch {
              /* subscriber errors are isolated */
            }
          }
        })
        .finally(() => {
          busy = false;
        });
    }, interval);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
    return this.pollTimer;
  }

  stopLivePoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscribers.clear();
  }

  unsubscribe(subscriber: SnapshotSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  localTelemetryStatus(): LocalTelemetry {
    return this.snapshot.localTelemetry;
  }

  resolveConversationThread(
    conversationId: unknown
  ): ConversationThread | null {
    if (typeof conversationId !== "string" || !conversationId.trim())
      return null;
    return this.snapshot.conversationThreads[conversationId.trim()] ?? null;
  }

  recentThreadsForWorkspace(workspaceKey: unknown): StateThread[] {
    if (typeof workspaceKey !== "string" || !workspaceKey.trim()) return [];
    return this.snapshot.recentThreads.filter(
      (thread) => thread.workspaceKey === workspaceKey.trim()
    );
  }
}

function emptySnapshot(): CodexStateSnapshot {
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
    localTelemetry: emptyLocalTelemetry()
  };
}

function emptyCapabilities(): StateCapabilities {
  return { tables: {}, columnCount: 0 };
}

function emptyLocalTelemetry(): LocalTelemetry {
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
    reason: null
  };
}

function introspectSchema(database: SqliteDatabase): StateSchema {
  const tables: Record<SchemaTableName, SchemaTable> = {
    threads: { present: false, columns: {} },
    projects: { present: false, columns: {} },
    thread_spawn_edges: { present: false, columns: {} },
    thread_sections: { present: false, columns: {} }
  };
  let columnCount = 0;
  for (const table of Object.keys(tables) as SchemaTableName[]) {
    tables[table].present = tableExists(database, table);
    if (!tables[table].present) continue;
    try {
      for (const row of rows(
        database.prepare(`PRAGMA table_info(${table})`).all()
      )) {
        const column = stringOrNull(row.name);
        if (column === null) continue;
        tables[table].columns[column] = true;
        columnCount += 1;
      }
    } catch {
      // Keep the table present with an empty column map when introspection fails.
    }
  }
  return { tables, columnCount };
}

function schemaFingerprint(schema: StateSchema): string {
  const parts: string[] = [];
  for (const table of Object.keys(schema.tables) as SchemaTableName[]) {
    const info = schema.tables[table];
    if (!info.present) continue;
    parts.push(`${table}:${Object.keys(info.columns).sort().join(",")}`);
  }
  const digest = createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${SCHEMA_VERSION}-${digest}`;
}

function collectRecentThreads(
  database: SqliteDatabase,
  schema: StateSchema,
  cutoffMs: number,
  limit: number
): StateThread[] {
  const present = schema.tables.threads.columns;
  const wanted = [
    "id",
    "created_at",
    "created_at_ms",
    "updated_at",
    "updated_at_ms",
    "source",
    "model_provider",
    "cwd",
    "title",
    "tokens_used",
    "has_user_event",
    "archived",
    "archived_at",
    "git_sha",
    "git_branch",
    "git_origin_url",
    "cli_version",
    "first_user_message",
    "agent_nickname",
    "agent_role",
    "memory_mode",
    "model",
    "reasoning_effort",
    "agent_path",
    "thread_source",
    "preview",
    "recency_at",
    "recency_at_ms",
    "history_mode",
    "name",
    "is_pinned",
    "thread_section_id",
    "section_position",
    "section_entered_at_ms",
    "project_id"
  ];
  const select = wanted.filter((column) => present[column]);
  if (
    !select.includes("id") ||
    (!select.includes("updated_at") &&
      !select.includes("updated_at_ms") &&
      !select.includes("created_at_ms"))
  )
    return [];
  const orderColumn = present.updated_at_ms
    ? "updated_at_ms"
    : present.updated_at
      ? "updated_at"
      : "created_at_ms";
  const cutoffColumn = present.updated_at_ms
    ? "updated_at_ms"
    : present.updated_at
      ? "updated_at"
      : null;
  const filterClause = cutoffColumn
    ? `WHERE COALESCE(${cutoffColumn}, 0) >= ?`
    : "";
  const parameters = cutoffColumn ? [Math.max(0, Math.floor(cutoffMs))] : [];
  const sql = `SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM threads ${filterClause} ORDER BY ${orderColumn} DESC LIMIT ${Math.max(1, Math.floor(limit))}`;
  try {
    return rows(database.prepare(sql).all(...parameters)).map((row) =>
      projectThreadRow(row, present)
    );
  } catch {
    return [];
  }
}

function projectThreadRow(
  row: SqliteRow,
  present: Record<string, boolean>
): StateThread {
  const id = stringOrNull(rowValue(row, "id"));
  const cwd = present.cwd ? stringOrNull(rowValue(row, "cwd")) : null;
  const origin = present.git_origin_url
    ? stringOrNull(rowValue(row, "git_origin_url"))
    : null;
  const repository = repositoryIdentity(origin);
  const basenameLabel = workspacePathLabel(cwd);
  const projectKey = repository ?? basenameLabel ?? "unknown";
  const workspaceIdentity = safeWorkspaceId(cwd);
  const workspaceKey = projectKey;
  const projectId = present.project_id
    ? stringOrNull(rowValue(row, "project_id"))
    : null;
  const sectionId = present.thread_section_id
    ? stringOrNull(rowValue(row, "thread_section_id"))
    : null;
  const updatedAtMs = present.updated_at_ms
    ? readInteger(rowValue(row, "updated_at_ms"))
    : present.updated_at
      ? readInteger(rowValue(row, "updated_at"), 1000)
      : null;
  const createdAtMs = present.created_at_ms
    ? readInteger(rowValue(row, "created_at_ms"))
    : present.created_at
      ? readInteger(rowValue(row, "created_at"), 1000)
      : null;
  const recencyAtMs = present.recency_at_ms
    ? readInteger(rowValue(row, "recency_at_ms"))
    : present.recency_at
      ? readInteger(rowValue(row, "recency_at"), 1000)
      : null;
  return {
    id,
    projectKey,
    workspaceKey,
    workspaceIdentity,
    displayName: basenameLabel,
    workspaceSource: repository
      ? "git_origin_url"
      : basenameLabel
        ? "cwd"
        : "unknown",
    attributionConfidence: repository
      ? "confirmed_git_origin"
      : basenameLabel
        ? "cwd_fallback"
        : "unattributed",
    cwdBasename: basenameLabel,
    repository,
    projectId,
    sectionId,
    modelProvider: present.model_provider
      ? safeMetricLabel(rowValue(row, "model_provider"))
      : null,
    source: present.source ? safeMetricLabel(rowValue(row, "source")) : null,
    threadSource: present.thread_source
      ? safeMetricLabel(rowValue(row, "thread_source"))
      : null,
    agentRole: present.agent_role
      ? safeMetricLabel(rowValue(row, "agent_role"), "unknown")
      : null,
    agentNickname: present.agent_nickname
      ? safeMetricLabel(rowValue(row, "agent_nickname"), "")
      : null,
    model: present.model
      ? safeMetricLabel(rowValue(row, "model"), "unknown")
      : null,
    reasoningEffort: present.reasoning_effort
      ? safeMetricLabel(rowValue(row, "reasoning_effort"), "")
      : null,
    historyMode: present.history_mode
      ? safeMetricLabel(rowValue(row, "history_mode"), "legacy")
      : "legacy",
    archived: present.archived ? Boolean(rowValue(row, "archived")) : false,
    archivedAtMs: present.archived_at
      ? readInteger(rowValue(row, "archived_at"), 1000)
      : null,
    hasUserEvent: present.has_user_event
      ? Boolean(rowValue(row, "has_user_event"))
      : false,
    tokensUsed: present.tokens_used
      ? (readInteger(rowValue(row, "tokens_used")) ?? 0)
      : 0,
    updatedAtMs,
    createdAtMs,
    recencyAtMs,
    gitBranch: present.git_branch
      ? safeMetricLabel(rowValue(row, "git_branch"), "")
      : null,
    gitOriginUrl: repository,
    isPinned: present.is_pinned ? Boolean(rowValue(row, "is_pinned")) : false
  };
}

function readInteger(value: unknown, scale = 1): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value * scale);
  if (typeof value === "bigint") return Number(value) * scale;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value);
    return Number.isFinite(parsed) ? parsed * scale : null;
  }
  return null;
}

function collectProjects(
  database: SqliteDatabase,
  schema: StateSchema,
  threadIds: string[]
): StateProject[] {
  if (!schema.tables.projects.present || threadIds.length === 0) return [];
  const present = schema.tables.projects.columns;
  const select = [
    "id",
    "name",
    "position",
    "created_at_ms",
    "updated_at_ms"
  ].filter((column) => present[column]);
  if (!select.includes("id") || !select.includes("name")) return [];
  try {
    return rows(
      database
        .prepare(
          `SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM projects ORDER BY position ASC`
        )
        .all()
    )
      .map((row): StateProject => ({
        id: stringOrNull(rowValue(row, "id")) ?? "",
        name: safeMetricLabel(rowValue(row, "name"), "unknown"),
        position: present.position
          ? (readInteger(rowValue(row, "position")) ?? 0)
          : 0,
        updatedAtMs: present.updated_at_ms
          ? readInteger(rowValue(row, "updated_at_ms"))
          : null,
        createdAtMs: present.created_at_ms
          ? readInteger(rowValue(row, "created_at_ms"))
          : null
      }))
      .filter((project) => project.id);
  } catch {
    return [];
  }
}

function collectSpawnEdges(
  database: SqliteDatabase,
  schema: StateSchema,
  threadIds: string[]
): SpawnEdge[] {
  if (!schema.tables.thread_spawn_edges.present || threadIds.length === 0)
    return [];
  const present = schema.tables.thread_spawn_edges.columns;
  const select = ["parent_thread_id", "child_thread_id", "status"].filter(
    (column) => present[column]
  );
  if (select.length < 2) return [];
  const threadIdSet = new Set(threadIds);
  try {
    return rows(
      database
        .prepare(
          `SELECT ${select.map((column) => `"${column}"`).join(", ")} FROM thread_spawn_edges`
        )
        .all()
    ).flatMap((row): SpawnEdge[] => {
      const parent = stringOrNull(rowValue(row, "parent_thread_id"));
      const child = stringOrNull(rowValue(row, "child_thread_id"));
      if (
        !parent ||
        !child ||
        (!threadIdSet.has(parent) && !threadIdSet.has(child))
      )
        return [];
      return [
        {
          parentThreadId: parent,
          childThreadId: child,
          status: present.status
            ? safeMetricLabel(rowValue(row, "status"))
            : null
        }
      ];
    });
  } catch {
    return [];
  }
}

function buildConversationJoin(
  threads: StateThread[]
): Record<string, ConversationThread> {
  const join: Record<string, ConversationThread> = {};
  for (const thread of threads) {
    if (!thread.id) continue;
    join[thread.id] = {
      threadId: thread.id,
      workspaceKey: thread.workspaceKey,
      projectId: thread.projectId,
      agentRole: thread.agentRole,
      archived: thread.archived,
      updatedAtMs: thread.updatedAtMs
    };
  }
  return join;
}

export const DEFAULT_CRITICAL_TABLES = Object.freeze([
  "threads",
  "projects",
  "thread_spawn_edges"
] as const);

export function loadCodexStateCollectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  defaults: Partial<StateCollectorConfig> = {}
): StateCollectorConfig {
  const defaultPath =
    defaults.path ??
    `${environment.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`}/state_5.sqlite`;
  return {
    path: environment.CODEX_STATE_DB_PATH ?? defaultPath,
    recencyWindowMs: parseInteger(
      environment.CODEX_STATE_COLLECTOR_WINDOW_MS,
      defaults.recencyWindowMs ?? DEFAULT_RECENT_WINDOW_MS
    ),
    limit: parseInteger(
      environment.CODEX_STATE_COLLECTOR_LIMIT,
      defaults.limit ?? DEFAULT_LIMIT
    ),
    pollIntervalMs: parseInteger(
      environment.CODEX_STATE_COLLECTOR_POLL_MS,
      defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    )
  };
}

function parseInteger(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export async function createCodexStateCollector(
  overrides: StateCollectorOptions = {}
): Promise<CodexStateCollector> {
  const config = loadCodexStateCollectorConfig();
  const collector = new CodexStateCollector({ ...config, ...overrides });
  await collector.collectSnapshot();
  return collector;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
