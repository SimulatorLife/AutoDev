/**
Authoritative rollout discovery.

A Codex session is not one file: it is a root rollout plus a rollout per
subagent, and the root file names the session the children belong to. The
Codex app also *moves* a finished session's rollout out of `sessions/` and
into `archived_sessions/`, so a search of `sessions/` alone reports "no
rollout found" for exactly the sessions someone has finished with.

This module finds the files. It reads only the head of each rollout -- the
`session_meta` line -- because a rollout reaches tens of megabytes and the
head is all the join needs.
*/

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

import {
  clientSurfaceFromOriginator,
  type RecentSessionSummary,
  safeAutoDevSessionId,
  SESSION_RECENT_LIST_SCHEMA,
  type SessionRecentListResponse
} from "@simulatorlife/autodev-core";

import { readNativeSessionEvidence } from "./native-session-evidence.ts";
import type { MutableRecentSession } from "./working-shapes.ts";

/**
The `session_meta` record, as it appears at the head of every rollout JSONL.
*/
export interface SessionMetaPayload {
  id?: string;
  session_id?: string;
  parent_thread_id?: string;
  thread_source?: string;
  agent_role?: string;
  agent_nickname?: string;
  model_provider?: string;
  cli_version?: string;
  originator?: string;
  cwd?: string;
  timestamp?: string;
  [key: string]: unknown;
}

const COLLATOR = new Intl.Collator();
const HEAD_READ_LIMIT = 4 * 1024 * 1024;
const HEAD_CHUNK_BYTES = 65_536;
const RECENT_SCAN_FILE_LIMIT = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
Read the `session_meta` payload of a rollout, keeping only the known fields.

The rollout is untrusted JSON, so every field is read as `unknown` and
narrowed before it is kept.
*/
export function parseSessionMetaPayload(raw: unknown): SessionMetaPayload {
  if (!isRecord(raw)) return {};
  const meta: SessionMetaPayload = { ...raw };
  if (typeof raw.id === "string") meta.id = raw.id;
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.parent_thread_id === "string")
    meta.parent_thread_id = raw.parent_thread_id;
  if (typeof raw.thread_source === "string")
    meta.thread_source = raw.thread_source;
  if (typeof raw.agent_role === "string") meta.agent_role = raw.agent_role;
  if (typeof raw.agent_nickname === "string")
    meta.agent_nickname = raw.agent_nickname;
  if (typeof raw.model_provider === "string")
    meta.model_provider = raw.model_provider;
  if (typeof raw.cli_version === "string") meta.cli_version = raw.cli_version;
  if (typeof raw.originator === "string") meta.originator = raw.originator;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  if (typeof raw.timestamp === "string") meta.timestamp = raw.timestamp;
  return meta;
}

/**
Where rollouts live.

The Codex app archives a session by moving its rollout out of `sessions/` and
into `archived_sessions/`, so an archived session is still worth reading.
*/
export function rolloutRoots(codexHome: string): string[] {
  return [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions")
  ];
}

/**
Every rollout file under one root, sorted by path.
*/
export function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      )
        files.push(filePath);
    }
  };
  try {
    visit(root);
  } catch {
    // A root that does not exist yet is not an error: Codex creates it when
    // the first session runs.
  }
  return files.sort();
}

/**
The `session_meta` line, read without loading the whole rollout.

Only the head is read, because the head is where the join key lives and a
rollout reaches tens of megabytes.
*/
export function readHeadMeta(file: string): SessionMetaPayload | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(HEAD_CHUNK_BYTES);
    for (let total = 0; total < HEAD_READ_LIMIT;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(
        Buffer.from(buffer.subarray(0, newline === -1 ? read : newline))
      );
      if (newline !== -1) break;
      total += read;
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed)) return null;
    const payload = isRecord(parsed.payload)
      ? parseSessionMetaPayload(parsed.payload)
      : undefined;
    return payload === undefined ? null : payload;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
The rollouts belonging to one id.

The id may name a session or a thread: either way every thread of that
session is returned. Newest files are checked first because a debugged
session is almost always recent.
*/
export function findSessionRollouts(
  sessionsRoot: string | readonly string[],
  id: string,
  extraIds: readonly string[] = []
): string[] {
  const sessionId = safeAutoDevSessionId(id);
  if (!sessionId) return [];
  const roots = Array.isArray(sessionsRoot)
    ? [...sessionsRoot]
    : [sessionsRoot as string];
  const files = roots.flatMap((root) => rolloutFiles(root)).reverse();
  const seedIds = new Set<string>([sessionId]);
  for (const extra of extraIds) {
    const valid = safeAutoDevSessionId(extra);
    if (valid) seedIds.add(valid);
  }
  const direct = files.filter((file) => {
    for (const candidate of seedIds) {
      if (file.includes(candidate)) return true;
    }
    return false;
  });
  const sessionIds = new Set<string>(seedIds);
  for (const file of direct) {
    const meta = readHeadMeta(file);
    if (typeof meta?.session_id === "string") sessionIds.add(meta.session_id);
  }
  const matched = new Set(direct);
  for (const file of files) {
    if (matched.has(file)) continue;
    const meta = readHeadMeta(file);
    if (
      meta &&
      ((typeof meta.session_id === "string" &&
        sessionIds.has(meta.session_id)) ||
        (typeof meta.parent_thread_id === "string" &&
          sessionIds.has(meta.parent_thread_id)))
    )
      matched.add(file);
  }
  return [...matched].sort();
}

function addRecentSession(
  sessions: Map<string, MutableRecentSession>,
  file: string,
  meta: SessionMetaPayload
): void {
  const sessionId =
    typeof meta.session_id === "string"
      ? meta.session_id
      : typeof meta.id === "string"
        ? meta.id
        : "";
  if (!sessionId) return;
  const modified = statSync(file).mtime.toISOString();
  const isRoot = meta.id === sessionId;
  const observedSurface = isRoot
    ? clientSurfaceFromOriginator(
        typeof meta.originator === "string" ? meta.originator : null
      )
    : null;
  const entry = sessions.get(sessionId) ?? {
    id: sessionId,
    started: typeof meta.timestamp === "string" ? meta.timestamp : "",
    lastWrite: modified,
    threads: 0,
    cwd: typeof meta.cwd === "string" ? meta.cwd : null,
    clientSurface: observedSurface
  };
  entry.threads += 1;
  if (modified > entry.lastWrite) entry.lastWrite = modified;
  if (isRoot) {
    if (typeof meta.timestamp === "string") entry.started = meta.timestamp;
    if (typeof meta.cwd === "string") entry.cwd = meta.cwd;
    entry.clientSurface = observedSurface;
  }
  sessions.set(sessionId, entry);
}

/**
The newest root sessions across one or more rollout roots.
*/
export function listRecentSessions(
  sessionsRoot: string | readonly string[],
  limit: number
): RecentSessionSummary[] {
  const roots = Array.isArray(sessionsRoot)
    ? [...sessionsRoot]
    : [sessionsRoot as string];
  const files = roots
    .flatMap((root) => rolloutFiles(root))
    .sort((a, b) => COLLATOR.compare(path.basename(b), path.basename(a)))
    .slice(0, RECENT_SCAN_FILE_LIMIT);
  const sessions = new Map<string, MutableRecentSession>();
  for (const file of files) {
    const meta = readHeadMeta(file);
    if (meta) addRecentSession(sessions, file, meta);
  }
  return [...sessions.values()]
    .sort((a, b) => COLLATOR.compare(b.lastWrite, a.lastWrite))
    .slice(0, limit);
}

/**
Merge bounded native lifecycle evidence without inventing rollout metrics.
*/
export function mergeNativeRecentSessions(
  rolloutSessions: readonly RecentSessionSummary[],
  limit: number,
  routerLog?: string
): RecentSessionSummary[] {
  const sessions = [...rolloutSessions];
  if (routerLog) {
    for (const native of readNativeSessionEvidence(routerLog)) {
      if (sessions.some((session) => session.id === native.id)) continue;
      sessions.push({
        id: native.id,
        clientSurface: native.clientSurface,
        started: native.startedAt ?? "",
        lastWrite: native.lastObservedAt,
        threads: 0,
        cwd: null
      });
    }
  }
  return sessions
    .sort((a, b) => COLLATOR.compare(b.lastWrite, a.lastWrite))
    .slice(0, limit);
}

/**
The recent-sessions listing, in the shape the Control API publishes.
*/
export function listRecentSessionsResponse(
  sessionsRoot: string | readonly string[],
  limit: number,
  routerLog?: string
): SessionRecentListResponse {
  return {
    schema: SESSION_RECENT_LIST_SCHEMA,
    limit,
    sessions: mergeNativeRecentSessions(
      listRecentSessions(sessionsRoot, limit),
      limit,
      routerLog
    )
  };
}
