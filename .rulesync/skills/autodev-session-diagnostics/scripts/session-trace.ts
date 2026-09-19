#!/usr/bin/env node

/**
 * One-shot evidence report for an AutoDev/Codex session or thread.
 *
 * Joins what is otherwise correlated by hand: the Codex rollout of every
 * thread in the session (root and subagents), the router's events for each
 * thread's model and time window, the provider bridge logs' freshness, and any
 * provider CLI still running. It reads local files only, never prints
 * credentials, and truncates every prompt/output excerpt.
 *
 *   node session-trace.ts <session-or-thread-id> [--items] [--json]
 *        [--codex-home DIR] [--router-log FILE] [--no-processes]
 */

import { execFileSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, any>;

export interface TraceOptions {
  id: string;
  codexHome: string;
  routerLog: string;
  items: boolean;
  processes: boolean;
}

export interface ThreadTrace {
  id: string;
  sessionId: string | null;
  parentId: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  file: string;
  start: string | null;
  end: string | null;
  counts: Record<string, number>;
  turns: Array<{ turnId: string; started: string | null; ended: string | null; outcome: string; detail: string | null }>;
  gaps: Array<{ seconds: number; after: string; before: string; at: string }>;
  items?: Array<{ at: string; kind: string; detail: string }>;
}

export interface RouterEventRow {
  at: string; requestId: string; phase: string; role: string | null; requestedModel: string | null;
  provider: string | null; model: string | null; outcome: string | null; status: number | null;
  failureClass: string | null; elapsedMs: number | null; toolCalls: number | null; selection: string | null;
}

export interface TraceReport {
  threads: ThreadTrace[];
  router: Array<{ thread: string; model: string | null; events: RouterEventRow[] }>;
  logs: Array<{ file: string; modified: string; bytes: number }>;
  processes: string[];
}

const EXCERPT = 160;
const GAP_SECONDS = 60;

function excerpt(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT)}…` : flat;
}

function readJsonl(file: string): JsonRecord[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [ JSON.parse(line) as JsonRecord ]; } catch { return []; }
  });
}

/** The session_meta line, read without loading the whole rollout (they reach tens of MB). */
function firstLine(file: string): JsonRecord | null {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65536);
    for (let total = 0; total < 4 * 1024 * 1024;) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline < 0 ? read : newline)));
      if (newline >= 0) break;
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
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
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
export function findSessionRollouts(sessionsRoot: string, id: string): string[] {
  const files = rolloutFiles(sessionsRoot).reverse();
  const direct = files.filter((file) => file.includes(id));
  const sessionIds = new Set<string>([ id ]);
  for (const file of direct) {
    const meta = firstLine(file)?.payload;
    if (typeof meta?.session_id === "string") sessionIds.add(meta.session_id);
  }
  const matched = new Set(direct);
  for (const file of files) {
    if (matched.has(file)) continue;
    const meta = firstLine(file)?.payload;
    if (meta && (sessionIds.has(meta.session_id) || sessionIds.has(meta.parent_thread_id))) matched.add(file);
  }
  return [ ...matched ].sort();
}

function itemDetail(payload: JsonRecord): string {
  switch (payload.type) {
    case "message": return `${payload.role}: ${excerpt((payload.content ?? []).map((part: JsonRecord) => part.text ?? "").join(" "))}`;
    case "reasoning": return `id=${payload.id ?? "-"} ${excerpt([ ...(payload.summary ?? []), ...(payload.content ?? []) ].map((part: JsonRecord) => part.text ?? "").join(" "))}`;
    case "custom_tool_call": case "function_call": return `${payload.name} call=${payload.call_id} id=${payload.id ?? "-"} ${excerpt(payload.input ?? payload.arguments)}`;
    case "custom_tool_call_output": case "function_call_output": return `call=${payload.call_id} ${excerpt(payload.output)}`;
    default: return excerpt(payload);
  }
}

export function traceThread(file: string, withItems: boolean): ThreadTrace {
  const records = readJsonl(file);
  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const context = records.find((record) => record.type === "turn_context")?.payload ?? {};
  const counts: Record<string, number> = {};
  const turns: ThreadTrace["turns"] = [];
  const open = new Map<string, ThreadTrace["turns"][number]>();
  const items: NonNullable<ThreadTrace["items"]> = [];
  const gaps: ThreadTrace["gaps"] = [];
  let previous: { at: string; label: string } | null = null;
  for (const record of records) {
    const at = typeof record.timestamp === "string" ? record.timestamp : null;
    const payload = record.payload ?? {};
    const kind = record.type === "response_item" || record.type === "event_msg" ? `${record.type}:${payload.type}` : String(record.type);
    counts[kind] = (counts[kind] ?? 0) + 1;
    // Measured before this record opens or closes a turn, so the silence that
    // ends in an abort -- the usual stall -- is counted.
    if (record.type === "response_item" || (record.type === "event_msg" && /task_|turn_/.test(String(payload.type)))) {
      const label = record.type === "response_item" ? `${payload.type}${payload.name ? `(${payload.name})` : ""}` : String(payload.type);
      if (at && previous && open.size > 0) {
        const seconds = (Date.parse(at) - Date.parse(previous.at)) / 1000;
        if (seconds >= GAP_SECONDS) gaps.push({ seconds: Math.round(seconds), after: previous.label, before: label, at: previous.at });
      }
      if (at) previous = { at, label };
      if (withItems && record.type === "response_item" && at) items.push({ at, kind: String(payload.type), detail: itemDetail(payload) });
    }
    if (record.type === "event_msg" && payload.type === "task_started") {
      const turn = { turnId: String(payload.turn_id), started: at, ended: null, outcome: "running", detail: null };
      open.set(turn.turnId, turn);
      turns.push(turn);
    } else if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      const turn = open.get(String(payload.turn_id));
      if (turn) {
        turn.ended = at;
        turn.outcome = payload.type === "turn_aborted" ? `aborted:${payload.reason ?? "?"}` : payload.error ? "failed" : "completed";
        turn.detail = payload.error ? excerpt(payload.error.message ?? payload.error) : payload.last_agent_message ? excerpt(payload.last_agent_message) : null;
        open.delete(turn.turnId);
      }
    }
  }
  const stamps = records.map((record) => record.timestamp).filter((value): value is string => typeof value === "string").sort();
  return {
    id: String(meta.id ?? file),
    sessionId: meta.session_id ?? null,
    parentId: meta.parent_thread_id ?? null,
    nickname: meta.agent_nickname ?? null,
    role: meta.agent_role ?? (meta.thread_source === "subagent" ? null : "root"),
    model: context.model ?? null,
    modelProvider: meta.model_provider ?? null,
    cwd: meta.cwd ?? null,
    file,
    start: stamps[0] ?? null,
    end: stamps.at(-1) ?? null,
    counts,
    turns,
    gaps: gaps.sort((a, b) => b.seconds - a.seconds).slice(0, 5),
    ...(withItems ? { items } : {}),
  };
}

/** Router events for one model in a time window. The log has no thread id, so concurrent threads on the same model interleave. */
export async function routerEvents(logFile: string, model: string | null, start: string, end: string): Promise<RouterEventRow[]> {
  if (!existsSync(logFile)) return [];
  const rows: RouterEventRow[] = [];
  const lines = createInterface({ input: createReadStream(logFile, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const stamp = /"timestamp":"([^"]+)"/.exec(line)?.[1];
    if (!stamp || stamp < start || stamp > end || !line.includes("autodev-router-event-v1")) continue;
    let event: JsonRecord;
    try { event = JSON.parse(line) as JsonRecord; } catch { continue; }
    if (model && event.requestedModel && event.requestedModel !== model) continue;
    rows.push({
      at: stamp, requestId: String(event.requestId ?? ""), phase: String(event.phase ?? ""), role: event.role ?? null,
      requestedModel: event.requestedModel ?? null, provider: event.provider ?? null, model: event.model ?? null,
      outcome: event.outcome ?? null, status: event.status ?? null, failureClass: event.failureClass ?? null,
      elapsedMs: event.elapsedMs ?? null, toolCalls: event.toolCalls ?? null, selection: event.selection ?? null,
    });
  }
  return rows;
}

function shift(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function providerProcesses(): string[] {
  try {
    const listing = execFileSync("ps", [ "-Ao", "pid,ppid,etime,command" ], { encoding: "utf8" });
    // Command lines can carry prompts; keep the executable and flags only.
    return listing.split("\n").filter((line) => /\/claude -p|\bagy\b.* -p|\bcopilot\b.* -p|codex-tools-shim|spawn-shim/.test(line))
      .map((line) => line.trim().split(/\s+/).slice(0, 5).join(" "));
  } catch {
    return [];
  }
}

function logFreshness(codexHome: string): TraceReport["logs"] {
  const candidates = [ join(codexHome, "run"), join(codexHome, "hooks") ].flatMap((dir) => existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".log")).map((name) => join(dir, name))
    : []);
  return candidates.map((file) => { const stat = statSync(file); return { file, modified: stat.mtime.toISOString(), bytes: stat.size }; })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function buildReport(options: TraceOptions): Promise<TraceReport> {
  const threads = findSessionRollouts(join(options.codexHome, "sessions"), options.id).map((file) => traceThread(file, options.items));
  const router = [];
  for (const thread of threads) {
    if (!thread.start || !thread.end) continue;
    router.push({ thread: thread.id, model: thread.model, events: await routerEvents(options.routerLog, thread.model, shift(thread.start, -5), shift(thread.end, 60)) });
  }
  return { threads, router, logs: logFreshness(options.codexHome), processes: options.processes ? providerProcesses() : [] };
}

export function renderReport(report: TraceReport): string {
  const out: string[] = [];
  if (report.threads.length === 0) out.push("No rollout found for that id under <codex-home>/sessions.");
  for (const thread of report.threads) {
    out.push(`== thread ${thread.id} ${thread.nickname ? `(${thread.nickname}) ` : ""}role=${thread.role ?? "-"} model=${thread.model ?? "-"} provider=${thread.modelProvider ?? "-"}`);
    out.push(`   session=${thread.sessionId ?? "-"} parent=${thread.parentId ?? "-"} ${thread.start ?? "?"} → ${thread.end ?? "?"}`);
    out.push(`   file=${thread.file}`);
    out.push(`   counts ${Object.entries(thread.counts).sort((a, b) => b[1] - a[1]).map(([ kind, count ]) => `${kind}=${count}`).join(" ")}`);
    for (const turn of thread.turns) out.push(`   turn ${turn.turnId} ${turn.started ?? "?"} → ${turn.ended ?? "open"} ${turn.outcome}${turn.detail ? ` :: ${turn.detail}` : ""}`);
    for (const gap of thread.gaps) out.push(`   GAP ${gap.seconds}s after ${gap.after} (${gap.at}) before ${gap.before}`);
    for (const item of thread.items ?? []) out.push(`   ${item.at.slice(11, 19)} ${item.kind} ${item.detail}`);
  }
  for (const { thread, model, events } of report.router) {
    out.push(`== router events for ${thread} (model ${model ?? "any"}; other threads on the same model interleave)`);
    for (const event of events) {
      out.push(`   ${event.at.slice(11, 23)} ${event.requestId.slice(0, 8)} ${event.phase} role=${event.role ?? "-"} ${event.provider ?? "-"}/${event.model ?? "-"}`
        + `${event.outcome ? ` ${event.outcome}` : ""}${event.status ? ` ${event.status}` : ""}${event.failureClass ? ` ${event.failureClass}` : ""}`
        + `${event.elapsedMs !== null ? ` ${event.elapsedMs}ms` : ""}${event.phase === "result" ? ` tools=${event.toolCalls ?? 0}` : ""}`);
    }
  }
  out.push("== log freshness (bridge logs carry no timestamps; correlate by order and mtime)");
  for (const log of report.logs) out.push(`   ${log.modified} ${String(log.bytes).padStart(10)} ${log.file}`);
  out.push("== provider CLI / shim processes now running");
  for (const line of report.processes) out.push(`   ${line}`);
  if (report.processes.length === 0) out.push("   none");
  return out.join("\n");
}

function parseArgs(argv: string[]): (TraceOptions & { json: boolean }) | null {
  const codexHomeDefault = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  let id = ""; let codexHome = codexHomeDefault; let routerLog = ""; let items = false; let json = false; let processes = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--items") items = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-processes") processes = false;
    else if (arg === "--codex-home") codexHome = argv[++index] ?? codexHome;
    else if (arg === "--router-log") routerLog = argv[++index] ?? "";
    else if (!arg.startsWith("--")) id = arg;
  }
  if (!id) return null;
  return { id, codexHome, routerLog: routerLog || join(codexHome, "run", "codex-model-router.launchd.err.log"), items, json, processes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stderr.write("usage: session-trace.ts <session-or-thread-id> [--items] [--json] [--codex-home DIR] [--router-log FILE] [--no-processes]\n");
    process.exit(2);
  }
  const report = await buildReport(options);
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderReport(report)}\n`);
}
