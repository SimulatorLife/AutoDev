#!/usr/bin/env node

/**
 * One-shot evidence report for an AutoDev/Codex session or thread.
 *
 * Joins what is otherwise correlated by hand: the Codex rollout of every
 * thread in the session (root and subagents), each thread's tool calls and
 * tool failures, the router's requests for each thread, and -- unless
 * --offline -- what is live now: router agent counts against the threads
 * actually writing, running provider CLIs, and whether the running services
 * match the checkout. It reads local files and the loopback router only,
 * never prints credentials, and truncates every prompt/output excerpt.
 *
 *   node session-trace.ts <session-or-thread-id> [--items] [--events] [--json]
 *        [--codex-home DIR] [--router-log FILE] [--offline]
 *   node session-trace.ts --recent [N]            # when no id was given
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, any>;

export interface TraceOptions {
  id: string;
  codexHome: string;
  routerLog: string;
  items: boolean;
  events?: boolean;
  /** Skip everything that reads live state: processes, the router, deployed files. */
  offline: boolean;
  routerUrl?: string;
  repoRoot?: string | null;
}

export interface ToolFailure {
  at: string;
  tool: string;
  callId: string;
  detail: string;
}

export interface ThreadTrace {
  id: string;
  sessionId: string | null;
  parentId: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  modelProvider: string | null;
  cliVersion: string | null;
  cwd: string | null;
  file: string;
  start: string | null;
  end: string | null;
  counts: Record<string, number>;
  turns: Array<{
    turnId: string;
    started: string | null;
    ended: string | null;
    outcome: string;
    detail: string | null;
  }>;
  gaps: Array<{ seconds: number; after: string; before: string; at: string }>;
  /** Calls by tool; MCP tools are keyed `mcp__<server>__<tool>`, wherever they were called from. */
  tools: Record<string, number>;
  toolFailures: ToolFailure[];
  items?: Array<{ at: string; kind: string; detail: string }>;
}

export interface RouterEventRow {
  at: string;
  requestId: string;
  thread: string | null;
  phase: string;
  role: string | null;
  requestedModel: string | null;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  status: number | null;
  failureClass: string | null;
  elapsedMs: number | null;
  toolCalls: number | null;
  selection: string | null;
}

export interface RouterSummary {
  thread: string;
  model: string | null;
  /** `thread`: every matched event names the thread. `model-window`: some are older events matched by model and time, so same-model threads may interleave. */
  matchedBy: "thread" | "model-window";
  requests: number;
  byProvider: Record<
    string,
    { requests: number; failures: number; elapsedMs: number; toolCalls: number }
  >;
  failures: Array<{
    at: string;
    requestId: string;
    provider: string | null;
    status: number | null;
    failureClass: string | null;
    elapsedMs: number | null;
  }>;
  /** Providers in request order, collapsed: a turn that hops providers shows more than one. */
  providerSequence: string[];
  events?: RouterEventRow[];
}

export interface LiveReport {
  router: {
    reachable: boolean;
    canonicalLiveCount: number | null;
    byState: JsonRecord | null;
    liveByRole: JsonRecord | null;
    startedAt: string | null;
  };
  /** Recently written threads whose latest turn has not ended: the agents actually live. */
  openThreads: Array<{ id: string; modified: string }>;
  processes: string[];
  services: Array<{ pid: string; started: string; script: string }>;
  drift: { checked: number; differing: string[]; missing: string[] } | null;
}

export interface TraceReport {
  threads: ThreadTrace[];
  router: RouterSummary[];
  logs: Array<{ file: string; modified: string; bytes: number }>;
  live: LiveReport | null;
}

const EXCERPT = 160;
const GAP_SECONDS = 60;
const WRITING_WINDOW_MS = 10 * 60 * 1000;
// Outputs that mean the call did not do its job. `Transport closed` is an MCP
// server process that died; `aborted` is Codex cutting the call short.
const TOOL_FAILURE =
  /tool call failed|Transport closed|Script failed|Script error|^aborted|No such tool|not found in ALL_TOOLS/im;

function excerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return output
      .map((part: JsonRecord) =>
        typeof part === "string" ? part : (part?.text ?? "")
      )
      .join("\n");
  return JSON.stringify(output ?? "");
}

function readJsonl(file: string): JsonRecord[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRecord];
      } catch {
        return [];
      }
    });
}

/** The session_meta line, read without loading the whole rollout (they reach tens of MB). */
function firstLine(file: string): JsonRecord | null {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65_536);
    for (let total = 0; total < 4 * 1024 * 1024;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(
        Buffer.from(buffer.subarray(0, newline === -1 ? read : newline))
      );
      if (newline !== -1) break;
      total += read;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function rolloutFiles(root: string): string[] {
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
  if (existsSync(root)) visit(root);
  return files.sort();
}

/**
 * Rollouts belonging to the id: the thread itself, plus -- whether the id names
 * a session or a thread -- every thread sharing its session. Newest files are
 * checked first because a debugged session is almost always recent.
 */
export function findSessionRollouts(
  sessionsRoot: string,
  id: string
): string[] {
  const files = rolloutFiles(sessionsRoot).reverse();
  const direct = files.filter((file) => file.includes(id));
  const sessionIds = new Set<string>([id]);
  for (const file of direct) {
    const meta = firstLine(file)?.payload;
    if (typeof meta?.session_id === "string") sessionIds.add(meta.session_id);
  }
  const matched = new Set(direct);
  for (const file of files) {
    if (matched.has(file)) continue;
    const meta = firstLine(file)?.payload;
    if (
      meta &&
      (sessionIds.has(meta.session_id) || sessionIds.has(meta.parent_thread_id))
    )
      matched.add(file);
  }
  return [...matched].sort();
}

export interface RecentSession {
  id: string;
  started: string;
  lastWrite: string;
  threads: number;
  cwd: string | null;
}

/** The newest root sessions, for when the user names none. */
export function recentSessions(
  sessionsRoot: string,
  limit: number
): RecentSession[] {
  const sessions = new Map<string, RecentSession>();
  for (const file of rolloutFiles(sessionsRoot).reverse().slice(0, 400)) {
    const meta = firstLine(file)?.payload;
    if (!meta) continue;
    const sessionId = String(meta.session_id ?? meta.id);
    const modified = statSync(file).mtime.toISOString();
    const entry = sessions.get(sessionId) ?? {
      id: sessionId,
      started: String(meta.timestamp ?? ""),
      lastWrite: modified,
      threads: 0,
      cwd: meta.cwd ?? null
    };
    entry.threads += 1;
    if (modified > entry.lastWrite) entry.lastWrite = modified;
    if (meta.id === sessionId) {
      entry.started = String(meta.timestamp ?? entry.started);
      entry.cwd = meta.cwd ?? entry.cwd;
    }
    sessions.set(sessionId, entry);
  }
  return [...sessions.values()]
    .sort((a, b) => b.lastWrite.localeCompare(a.lastWrite))
    .slice(0, limit);
}

function itemDetail(payload: JsonRecord): string {
  switch (payload.type) {
    case "message": {
      return `${payload.role}: ${excerpt((payload.content ?? []).map((part: JsonRecord) => part.text ?? "").join(" "))}`;
    }
    case "reasoning": {
      return `id=${payload.id ?? "-"} ${excerpt([...(payload.summary ?? []), ...(payload.content ?? [])].map((part: JsonRecord) => part.text ?? "").join(" "))}`;
    }
    case "custom_tool_call":
    case "function_call": {
      return `${payload.name} call=${payload.call_id} id=${payload.id ?? "-"} ${excerpt(payload.input ?? payload.arguments)}`;
    }
    case "custom_tool_call_output":
    case "function_call_output": {
      return `call=${payload.call_id} ${excerpt(payload.output)}`;
    }
    default: {
      return excerpt(payload);
    }
  }
}

/** Tools a call reached: its own name, plus every `tools.<name>(` an `exec` script calls. */
function toolsOfCall(payload: JsonRecord): string[] {
  const name = String(payload.name ?? "?");
  if (
    payload.type === "custom_tool_call" &&
    name === "exec" &&
    typeof payload.input === "string"
  ) {
    const nested = Array.from(
      payload.input.matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g),
      (match) => match[1]!
    );
    return nested.length > 0 ? nested : ["exec"];
  }
  return [name];
}

export function traceThread(file: string, withItems: boolean): ThreadTrace {
  const records = readJsonl(file);
  const meta =
    records.find((record) => record.type === "session_meta")?.payload ?? {};
  const context =
    records.find((record) => record.type === "turn_context")?.payload ?? {};
  const counts: Record<string, number> = {};
  const turns: ThreadTrace["turns"] = [];
  const open = new Map<string, ThreadTrace["turns"][number]>();
  const items: NonNullable<ThreadTrace["items"]> = [];
  const gaps: ThreadTrace["gaps"] = [];
  const tools: Record<string, number> = {};
  const toolFailures: ToolFailure[] = [];
  const callTools = new Map<string, string>();
  let previous: { at: string; label: string } | null = null;
  for (const record of records) {
    const at = typeof record.timestamp === "string" ? record.timestamp : null;
    const payload = record.payload ?? {};
    const kind =
      record.type === "response_item" || record.type === "event_msg"
        ? `${record.type}:${payload.type}`
        : String(record.type);
    counts[kind] = (counts[kind] ?? 0) + 1;
    // Measured before this record opens or closes a turn, so the silence that
    // ends in an abort -- the usual stall -- is counted.
    if (
      record.type === "response_item" ||
      (record.type === "event_msg" && /task_|turn_/.test(String(payload.type)))
    ) {
      const label =
        record.type === "response_item"
          ? `${payload.type}${payload.name ? `(${payload.name})` : ""}`
          : String(payload.type);
      if (at && previous && open.size > 0) {
        const seconds = (Date.parse(at) - Date.parse(previous.at)) / 1000;
        if (seconds >= GAP_SECONDS)
          gaps.push({
            seconds: Math.round(seconds),
            after: previous.label,
            before: label,
            at: previous.at
          });
      }
      if (at) previous = { at, label };
      if (withItems && record.type === "response_item" && at)
        items.push({
          at,
          kind: String(payload.type),
          detail: itemDetail(payload)
        });
    }
    if (
      record.type === "response_item" &&
      (payload.type === "custom_tool_call" || payload.type === "function_call")
    ) {
      const reached = toolsOfCall(payload);
      for (const tool of reached) tools[tool] = (tools[tool] ?? 0) + 1;
      callTools.set(String(payload.call_id), reached.join("+"));
    } else if (
      record.type === "response_item" &&
      (payload.type === "custom_tool_call_output" ||
        payload.type === "function_call_output")
    ) {
      const text = outputText(payload.output);
      const failure = TOOL_FAILURE.exec(text);
      if (failure) {
        toolFailures.push({
          at: at ?? "",
          tool: callTools.get(String(payload.call_id)) ?? "?",
          callId: String(payload.call_id),
          detail: excerpt(text.slice(Math.max(0, failure.index - 40)))
        });
      }
    }
    if (record.type === "event_msg" && payload.type === "task_started") {
      const turn = {
        turnId: String(payload.turn_id),
        started: at,
        ended: null,
        outcome: "running",
        detail: null
      };
      open.set(turn.turnId, turn);
      turns.push(turn);
    } else if (
      record.type === "event_msg" &&
      (payload.type === "task_complete" || payload.type === "turn_aborted")
    ) {
      const turn = open.get(String(payload.turn_id));
      if (turn) {
        turn.ended = at;
        turn.outcome =
          payload.type === "turn_aborted"
            ? `aborted:${payload.reason ?? "?"}`
            : payload.error
              ? "failed"
              : "completed";
        turn.detail = payload.error
          ? excerpt(payload.error.message ?? payload.error)
          : payload.last_agent_message
            ? excerpt(payload.last_agent_message)
            : null;
        open.delete(turn.turnId);
      }
    }
  }
  const stamps = records
    .map((record) => record.timestamp)
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    id: String(meta.id ?? file),
    sessionId: meta.session_id ?? null,
    parentId: meta.parent_thread_id ?? null,
    nickname: meta.agent_nickname ?? null,
    role:
      meta.agent_role ?? (meta.thread_source === "subagent" ? null : "root"),
    model: context.model ?? null,
    modelProvider: meta.model_provider ?? null,
    cliVersion: meta.cli_version ?? null,
    cwd: meta.cwd ?? null,
    file,
    start: stamps[0] ?? null,
    end: stamps.at(-1) ?? null,
    counts,
    turns,
    gaps: gaps.sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    tools,
    toolFailures,
    ...(withItems ? { items } : {})
  };
}

/** Every router event in a time window, read in one pass over the (large) log. */
export async function routerEvents(
  logFile: string,
  start: string,
  end: string
): Promise<RouterEventRow[]> {
  if (!existsSync(logFile)) return [];
  const rows: RouterEventRow[] = [];
  const lines = createInterface({
    input: createReadStream(logFile, "utf8"),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    const stamp = /"timestamp":"([^"]+)"/.exec(line)?.[1];
    if (
      !stamp ||
      stamp < start ||
      stamp > end ||
      !line.includes("autodev-router-event-v1")
    )
      continue;
    let event: JsonRecord;
    try {
      event = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    rows.push({
      at: stamp,
      requestId: String(event.requestId ?? ""),
      thread: event.thread ?? null,
      phase: String(event.phase ?? ""),
      role: event.role ?? null,
      requestedModel: event.requestedModel ?? null,
      provider: event.provider ?? null,
      model: event.model ?? null,
      outcome: event.outcome ?? null,
      status: event.status ?? null,
      failureClass: event.failureClass ?? null,
      elapsedMs: event.elapsedMs ?? null,
      toolCalls: event.toolCalls ?? null,
      selection: event.selection ?? null
    });
  }
  return rows;
}

/** One thread's requests, summarised. Events that name threads match exactly; older ones fall back to model and window. */
export function summarizeRouter(
  thread: ThreadTrace,
  rows: RouterEventRow[],
  withEvents: boolean
): RouterSummary {
  const start = thread.start ? shift(thread.start, -5) : "";
  const end = thread.end ? shift(thread.end, 60) : "￿";
  // Decided per event: a log spanning a router upgrade holds both kinds.
  const mine = rows.filter((row) =>
    row.thread === null
      ? row.at >= start &&
        row.at <= end &&
        (!thread.model ||
          !row.requestedModel ||
          row.requestedModel === thread.model)
      : row.thread === thread.id
  );
  const guessed = mine.some((row) => row.thread === null);
  const byProvider: RouterSummary["byProvider"] = {};
  const failures: RouterSummary["failures"] = [];
  const providerSequence: string[] = [];
  const requests = new Set<string>();
  for (const row of mine) {
    if (row.phase === "selected") {
      requests.add(row.requestId);
      const provider = row.provider ?? "?";
      if (providerSequence.at(-1) !== provider) providerSequence.push(provider);
    }
    if (row.phase !== "result") continue;
    const entry = (byProvider[row.provider ?? "?"] ??= {
      requests: 0,
      failures: 0,
      elapsedMs: 0,
      toolCalls: 0
    });
    entry.requests += 1;
    entry.elapsedMs += row.elapsedMs ?? 0;
    entry.toolCalls += row.toolCalls ?? 0;
    if (row.outcome === "failure") {
      entry.failures += 1;
      failures.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        status: row.status,
        failureClass: row.failureClass,
        elapsedMs: row.elapsedMs
      });
    }
  }
  return {
    thread: thread.id,
    model: thread.model,
    matchedBy: guessed ? "model-window" : "thread",
    requests: requests.size,
    byProvider,
    failures,
    providerSequence,
    ...(withEvents ? { events: mine } : {})
  };
}

function shift(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000 });
  } catch {
    return "";
  }
}

function providerProcesses(): string[] {
  // Command lines can carry prompts; keep the executable and flags only.
  return run("ps", ["-Ao", "pid,ppid,etime,command"])
    .split("\n")
    .filter((line) =>
      /\/claude -p|\bagy\b.* -p|\bcopilot\b.* -p|codex-tools-shim|spawn-shim|lsp-mcp-server|typescript-language-server/.test(
        line
      )
    )
    .map((line) => line.trim().split(/\s+/).slice(0, 5).join(" "));
}

/** Router and bridge processes, with when they started -- a fix is live only in a process started after it was installed. */
function services(): LiveReport["services"] {
  return run("ps", ["-Ao", "pid,lstart,command"])
    .split("\n")
    .flatMap((line) => {
      const match =
        /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+\S*node\S*\s+(\S*(?:router\/server|providers\/\w+)\.ts)/.exec(
          line
        );
      return match
        ? [
            {
              pid: match[1]!,
              started: new Date(match[2]!).toISOString(),
              script: match[3]!
            }
          ]
        : [];
    });
}

/** Whether the rollout's latest turn has started and not yet completed or aborted, read from its tail. */
export function hasOpenTurn(file: string): boolean {
  const size = statSync(file).size;
  const length = Math.min(size, 256 * 1024);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    // A long turn's start can lie far before the tail; read the whole file then.
    const text = buffer.toString("utf8");
    const markers = (source: string) => ({
      started: source.lastIndexOf('"type":"task_started"'),
      ended: Math.max(
        source.lastIndexOf('"type":"task_complete"'),
        source.lastIndexOf('"type":"turn_aborted"')
      )
    });
    let { started, ended } = markers(text);
    if (started < 0 && ended < 0 && length < size)
      ({ started, ended } = markers(readFileSync(file, "utf8")));
    return started > ended;
  } finally {
    closeSync(fd);
  }
}

function sha(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Installed runtime modules that differ from the checkout: the running services execute the installed copies. */
function deploymentDrift(
  codexHome: string,
  repoRoot: string | null | undefined
): LiveReport["drift"] {
  const installedRoot = path.join(codexHome, "src");
  if (
    !repoRoot ||
    !existsSync(path.join(repoRoot, "src")) ||
    !existsSync(installedRoot)
  )
    return null;
  const differing: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(installedRoot, filePath);
      const source = path.join(repoRoot, "src", rel);
      checked += 1;
      if (!existsSync(source)) missing.push(rel);
      else if (sha(source) !== sha(filePath)) differing.push(rel);
    }
  };
  visit(installedRoot);
  return { checked, differing, missing };
}

async function liveReport(options: TraceOptions): Promise<LiveReport> {
  let router: LiveReport["router"] = {
    reachable: false,
    canonicalLiveCount: null,
    byState: null,
    liveByRole: null,
    startedAt: null
  };
  try {
    const response = await fetch(
      `${options.routerUrl ?? "http://127.0.0.1:4100"}/status`,
      { signal: AbortSignal.timeout(3000) }
    );
    const status = (await response.json()) as JsonRecord;
    router = {
      reachable: true,
      canonicalLiveCount: status.agents?.canonicalLiveCount ?? null,
      byState: status.agents?.byState ?? null,
      liveByRole: status.agents?.liveByRole ?? null,
      startedAt: status.startedAt ?? null
    };
  } catch {
    /* router down or not reachable: reported as such */
  }
  const cutoff = Date.now() - WRITING_WINDOW_MS;
  const openThreads = rolloutFiles(path.join(options.codexHome, "sessions"))
    .reverse()
    .slice(0, 200)
    .flatMap((file) => {
      const modified = statSync(file).mtimeMs;
      if (modified < cutoff || !hasOpenTurn(file)) return [];
      return [
        {
          id: String(firstLine(file)?.payload?.id ?? file),
          modified: new Date(modified).toISOString()
        }
      ];
    });
  return {
    router,
    openThreads,
    processes: providerProcesses(),
    services: services(),
    drift: deploymentDrift(options.codexHome, options.repoRoot)
  };
}

function logFreshness(codexHome: string): TraceReport["logs"] {
  const candidates = [
    path.join(codexHome, "run"),
    path.join(codexHome, "hooks")
  ].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".log"))
          .map((name) => path.join(dir, name))
      : []
  );
  return candidates
    .map((file) => {
      const stat = statSync(file);
      return { file, modified: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function buildReport(options: TraceOptions): Promise<TraceReport> {
  const threads = findSessionRollouts(
    path.join(options.codexHome, "sessions"),
    options.id
  ).map((file) => traceThread(file, options.items));
  const stamps = threads
    .flatMap((thread) => [thread.start, thread.end])
    .filter(Boolean)
    .sort();
  const rows =
    stamps.length > 0
      ? await routerEvents(
          options.routerLog,
          shift(stamps[0]!, -5),
          shift(stamps.at(-1)!, 60)
        )
      : [];
  return {
    threads,
    router: threads.map((thread) =>
      summarizeRouter(thread, rows, options.events ?? false)
    ),
    logs: logFreshness(options.codexHome),
    live: options.offline ? null : await liveReport(options)
  };
}

export function renderReport(report: TraceReport): string {
  const out: string[] = [];
  if (report.threads.length === 0)
    out.push(
      "No rollout found for that id under <codex-home>/sessions. Try --recent."
    );
  for (const thread of report.threads) {
    const router = report.router.find((entry) => entry.thread === thread.id);
    out.push(
      `== thread ${thread.id} ${thread.nickname ? `(${thread.nickname}) ` : ""}role=${thread.role ?? "-"} model=${thread.model ?? "-"} codex=${thread.cliVersion ?? "-"}`,
      `   session=${thread.sessionId ?? "-"} parent=${thread.parentId ?? "-"} ${thread.start ?? "?"} → ${thread.end ?? "?"}`,
      `   file=${thread.file}`
    );
    for (const turn of thread.turns)
      out.push(
        `   turn ${turn.turnId} ${turn.started ?? "?"} → ${turn.ended ?? "open"} ${turn.outcome}${turn.detail ? ` :: ${turn.detail}` : ""}`
      );
    for (const gap of thread.gaps)
      out.push(
        `   GAP ${gap.seconds}s after ${gap.after} (${gap.at}) before ${gap.before}`
      );
    const tools = Object.entries(thread.tools).sort((a, b) => b[1] - a[1]);
    if (tools.length > 0)
      out.push(
        `   tools ${tools.map(([tool, count]) => `${tool}=${count}`).join(" ")}`
      );
    for (const failure of thread.toolFailures)
      out.push(
        `   TOOL FAILED ${failure.at.slice(11, 19)} ${failure.tool} call=${failure.callId} :: ${failure.detail}`
      );
    if (router) {
      const providers = Object.entries(router.byProvider).map(
        ([provider, entry]) =>
          `${provider}: ${entry.requests} req, ${entry.failures} failed, ${Math.round(entry.elapsedMs / 1000)}s, tools=${entry.toolCalls}`
      );
      out.push(
        `   router (${router.matchedBy}) ${router.requests} requests; ${providers.join("; ") || "no results"}`
      );
      if (router.providerSequence.length > 1)
        out.push(`   PROVIDER HOPS ${router.providerSequence.join(" → ")}`);
      for (const failure of router.failures)
        out.push(
          `   ROUTER FAILURE ${failure.at.slice(11, 23)} ${failure.requestId.slice(0, 8)} ${failure.provider ?? "-"} ${failure.status ?? "-"} ${failure.failureClass ?? "-"} ${failure.elapsedMs ?? "-"}ms`
        );
      for (const event of router.events ?? []) {
        out.push(
          `   ${event.at.slice(11, 23)} ${event.requestId.slice(0, 8)} ${event.phase} ${event.provider ?? "-"}/${event.model ?? "-"}` +
            `${event.outcome ? ` ${event.outcome}` : ""}${event.status ? ` ${event.status}` : ""}${event.failureClass ? ` ${event.failureClass}` : ""}` +
            `${event.elapsedMs === null ? "" : ` ${event.elapsedMs}ms`}${event.phase === "result" ? ` tools=${event.toolCalls ?? 0}` : ""}`
        );
      }
    }
    for (const item of thread.items ?? [])
      out.push(`   ${item.at.slice(11, 19)} ${item.kind} ${item.detail}`);
  }
  if (report.live) {
    const {
      router,
      openThreads,
      processes,
      services: running,
      drift
    } = report.live;
    out.push("== live now");
    out.push(
      router.reachable
        ? `   router (started ${router.startedAt}) live agents=${router.canonicalLiveCount} byState=${JSON.stringify(router.byState)} byRole=${JSON.stringify(router.liveByRole)}`
        : "   router /status unreachable"
    );
    out.push(
      `   threads with an open turn (written in the last 10 min): ${openThreads.length}${openThreads.length > 0 ? ` (${openThreads.map((thread) => thread.id).join(", ")})` : ""}`
    );
    if (
      router.canonicalLiveCount !== null &&
      router.canonicalLiveCount !== openThreads.length
    ) {
      out.push(
        `   LIVE COUNT MISMATCH: router ${router.canonicalLiveCount} vs ${openThreads.length} open threads -- above: something keys activity per request; below: reports land on the wrong agent, or an agent went stale`
      );
    }
    for (const service of running)
      out.push(
        `   service pid=${service.pid} started=${service.started} ${service.script}`
      );
    if (drift) {
      out.push(
        `   deployed $CODEX_HOME/src vs checkout: ${drift.checked} files, ${drift.differing.length} differ, ${drift.missing.length} not in checkout`
      );
      for (const file of drift.differing.slice(0, 15))
        out.push(`   DRIFT ${file}`);
    }
    out.push(
      `   provider CLIs / MCP servers running: ${processes.length === 0 ? "none" : ""}`
    );
    for (const line of processes) out.push(`     ${line}`);
  }
  out.push(
    "== log freshness (bridge logs carry no timestamps; correlate by order and mtime)"
  );
  for (const log of report.logs.slice(0, 8))
    out.push(
      `   ${log.modified} ${String(log.bytes).padStart(10)} ${log.file}`
    );
  return out.join("\n");
}

export function renderRecent(sessions: RecentSession[]): string {
  return sessions
    .map(
      (session) =>
        `${session.lastWrite} ${session.id} threads=${session.threads} started=${session.started} cwd=${session.cwd ?? "-"}`
    )
    .join("\n");
}

function repoRootFromScript(): string | null {
  const fromEnv = process.env.AUTODEV_REPO_ROOT;
  if (fromEnv) return fromEnv;
  const top = run("git", [
    "-C",
    path.resolve(import.meta.dirname),
    "rev-parse",
    "--show-toplevel"
  ]).trim();
  return top || null;
}

function parseArgs(
  argv: string[]
): (TraceOptions & { json: boolean; recent: number | null }) | null {
  const codexHomeDefault =
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  let id = "";
  let codexHome = codexHomeDefault;
  let routerLog = "";
  let items = false;
  let events = false;
  let json = false;
  let offline = false;
  let recent: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--items") items = true;
    else if (arg === "--events") events = true;
    else if (arg === "--json") json = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--codex-home") codexHome = argv[++index] ?? codexHome;
    else if (arg === "--router-log") routerLog = argv[++index] ?? "";
    else if (arg === "--recent")
      recent = /^\d+$/.test(argv[index + 1] ?? "") ? Number(argv[++index]) : 10;
    else if (!arg.startsWith("--")) id = arg;
  }
  if (!id && recent === null) return null;
  return {
    id,
    codexHome,
    routerLog:
      routerLog ||
      path.join(codexHome, "run", "codex-model-router.launchd.err.log"),
    items,
    events,
    json,
    offline,
    recent,
    repoRoot: repoRootFromScript()
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "usage: session-trace.ts <session-or-thread-id> [--items] [--events] [--json] [--codex-home DIR] [--router-log FILE] [--offline]\n       session-trace.ts --recent [N]\n"
    );
    process.exit(2);
  }
  if (options.recent === null) {
    const report = await buildReport(options);
    process.stdout.write(
      `${options.json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`
    );
  } else {
    const sessions = recentSessions(
      path.join(options.codexHome, "sessions"),
      options.recent
    );
    process.stdout.write(
      `${options.json ? JSON.stringify(sessions, null, 2) : renderRecent(sessions)}\n`
    );
  }
}
