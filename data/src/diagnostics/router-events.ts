/**
 * The router log reader.
 *
 * The router writes one structured event per request to its stderr log, and
 * launchd rotates that log: the live file becomes empty and the events move
 * to `.err.log.1`, then `.2`, and so on. Reading only the live file therefore
 * reads as "the router saw no request at all" for exactly the sessions that
 * are worth investigating.
 *
 * This module reads the rotated series and summarizes it per thread.
 */

import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  SessionRouterEventRow,
  SessionRouterFailure,
  SessionRouterSkippedEvent,
  SessionRouterSummary,
  SessionThreadTrace
} from "@simulatorlife/autodev-core";

import type { MutableProviderStats } from "./working-shapes.ts";

const COLLATOR = new Intl.Collator();
const TIMESTAMP_REGEX = /"timestamp":"([^"]+)"/u;
const UNKNOWN_LABEL = "unknown";

/** The router-event fields this module projects into the per-thread summary. */
interface RouterEventFields {
  requestId?: string;
  thread?: string;
  phase?: string;
  role?: string;
  requestedModel?: string;
  provider?: string;
  model?: string;
  outcome?: string;
  status?: number;
  failureClass?: string;
  reason?: string;
  spawnFailureReason?: string;
  denialReason?: string;
  elapsedMs?: number;
  toolCalls?: number;
  selection?: string;
  errorName?: string;
  errorCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRouterEvent(raw: unknown): RouterEventFields | null {
  if (!isRecord(raw)) return null;
  const result: RouterEventFields = {};
  if (typeof raw.requestId === "string") result.requestId = raw.requestId;
  if (typeof raw.thread === "string") result.thread = raw.thread;
  if (typeof raw.phase === "string") result.phase = raw.phase;
  if (typeof raw.role === "string") result.role = raw.role;
  if (typeof raw.requestedModel === "string")
    result.requestedModel = raw.requestedModel;
  if (typeof raw.provider === "string") result.provider = raw.provider;
  if (typeof raw.model === "string") result.model = raw.model;
  if (typeof raw.outcome === "string") result.outcome = raw.outcome;
  if (typeof raw.status === "number") result.status = raw.status;
  if (typeof raw.failureClass === "string")
    result.failureClass = raw.failureClass;
  if (typeof raw.reason === "string") result.reason = raw.reason;
  if (typeof raw.spawnFailureReason === "string")
    result.spawnFailureReason = raw.spawnFailureReason;
  if (typeof raw.denialReason === "string")
    result.denialReason = raw.denialReason;
  if (typeof raw.elapsedMs === "number") result.elapsedMs = raw.elapsedMs;
  if (typeof raw.toolCalls === "number") result.toolCalls = raw.toolCalls;
  if (typeof raw.selection === "string") result.selection = raw.selection;
  if (typeof raw.errorName === "string") result.errorName = raw.errorName;
  if (typeof raw.errorCode === "string") result.errorCode = raw.errorCode;
  return result;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Every router event in a time window, read from one log line. */
function routerEventFromLine(
  line: string,
  start: string,
  end: string
): SessionRouterEventRow | null {
  const stamp = TIMESTAMP_REGEX.exec(line)?.[1];
  if (
    !stamp ||
    stamp < start ||
    stamp > end ||
    !line.includes("autodev-router-event-v1")
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = parseRouterEvent(parsed);
  if (!event) return null;
  return {
    at: stamp,
    requestId: strOrNull(event.requestId) ?? "",
    thread: strOrNull(event.thread),
    phase: strOrNull(event.phase) ?? "",
    role: strOrNull(event.role),
    requestedModel: strOrNull(event.requestedModel),
    provider: strOrNull(event.provider),
    model: strOrNull(event.model),
    outcome: strOrNull(event.outcome),
    status: numOrNull(event.status),
    failureClass: strOrNull(event.failureClass),
    ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
    spawnFailureReason: strOrNull(event.spawnFailureReason),
    denialReason: strOrNull(event.denialReason),
    elapsedMs: numOrNull(event.elapsedMs),
    toolCalls: numOrNull(event.toolCalls),
    selection: strOrNull(event.selection),
    ...(typeof event.errorName === "string"
      ? { errorName: event.errorName }
      : {}),
    ...(typeof event.errorCode === "string"
      ? { errorCode: event.errorCode }
      : {})
  };
}

/**
 * Every log that can hold the router's events, newest first.
 *
 * launchd rotates the router's stderr log: the live file becomes empty and
 * the events move to `.err.log.1`, then `.2`, and so on.
 */
export function routerLogFiles(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  const dir = path.dirname(logFile);
  const base = path.basename(logFile);
  const files = [logFile];
  let index = 1;
  for (;;) {
    const rotated = path.join(dir, `${base}.${index}`);
    if (!existsSync(rotated)) break;
    files.push(rotated);
    index += 1;
  }
  return files;
}

/** Every router event in a time window, read in one pass over the logs. */
export async function readRouterEvents(
  logFile: string,
  start: string,
  end: string
): Promise<SessionRouterEventRow[]> {
  const rows: SessionRouterEventRow[] = [];
  const files = routerLogFiles(logFile);
  /* eslint-disable no-await-in-loop -- The logs are read one after the other: a rotated log holds the earlier events, and the files are read in order so the rows come out in the order they happened. */
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      const event = routerEventFromLine(line, start, end);
      if (event) rows.push(event);
    }
  }
  /* eslint-enable no-await-in-loop */
  rows.sort((a, b) => COLLATOR.compare(a.at, b.at));
  return rows;
}

interface RouterSummaryAccumulator {
  requests: Set<string>;
  providerSequence: string[];
  modelSequence: string[];
  byProvider: Record<string, MutableProviderStats>;
  failures: SessionRouterFailure[];
  skipped: SessionRouterSkippedEvent[];
  retries: number;
  exhaustionWaitCount: number;
  exhaustionWaitMs: number;
  transportErrors: number;
}

function recordRouterResult(
  row: SessionRouterEventRow,
  acc: RouterSummaryAccumulator
): void {
  const entry = (acc.byProvider[row.provider ?? "?"] ??= {
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
    acc.failures.push({
      at: row.at,
      requestId: row.requestId,
      provider: row.provider,
      status: row.status,
      failureClass: row.failureClass ?? row.denialReason ?? null,
      elapsedMs: row.elapsedMs
    });
  }
}

function recordRouterEvent(
  row: SessionRouterEventRow,
  acc: RouterSummaryAccumulator
): void {
  switch (row.phase) {
    case "selected": {
      acc.requests.add(row.requestId);
      const provider = row.provider ?? "?";
      if (acc.providerSequence.at(-1) !== provider)
        acc.providerSequence.push(provider);
      if (row.model && acc.modelSequence.at(-1) !== row.model)
        acc.modelSequence.push(row.model);
      return;
    }
    case "spawn_failed": {
      acc.failures.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        status: row.status,
        failureClass:
          row.failureClass ?? row.spawnFailureReason ?? "spawn_failed",
        elapsedMs: row.elapsedMs,
        ...(row.spawnFailureReason
          ? { spawnFailureReason: row.spawnFailureReason }
          : {})
      });
      return;
    }
    case "skipped": {
      acc.skipped.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        reason:
          row.failureClass ?? row.reason ?? row.denialReason ?? UNKNOWN_LABEL,
        elapsedMs: row.elapsedMs
      });
      return;
    }
    case "retry": {
      acc.retries += 1;
      return;
    }
    case "exhaustion_wait": {
      acc.exhaustionWaitCount += 1;
      acc.exhaustionWaitMs += row.elapsedMs ?? 0;
      return;
    }
    case "transport_error": {
      acc.transportErrors += 1;
      return;
    }
    case "result": {
      recordRouterResult(row, acc);
      break;
    }
    default: {
      break;
    }
  }
}

/** Shift an ISO timestamp by a number of seconds. */
export function shift(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
 * The router events that belong to one thread.
 *
 * Events that name the thread match exactly; older ones that predate the
 * thread field fall back to the model and the time window.
 */
export function routerEventsForThread(
  thread: SessionThreadTrace,
  rows: readonly SessionRouterEventRow[]
): SessionRouterEventRow[] {
  const start = thread.start ? shift(thread.start, -5) : "";
  const end = thread.end ? shift(thread.end, 60) : "￿";
  // Decided per event: a log spanning a router upgrade holds both kinds.
  return rows.filter((row) =>
    row.thread === null
      ? row.requestId.length > 0 &&
        row.at >= start &&
        row.at <= end &&
        (!thread.model ||
          !row.requestedModel ||
          row.requestedModel === thread.model)
      : row.thread === thread.id
  );
}

/**
 * One thread's requests, summarized.
 *
 * Events that name threads match exactly; older ones fall back to the model
 * and the time window, and the summary says which of the two it used.
 */
export function summarizeRouter(
  thread: SessionThreadTrace,
  rows: readonly SessionRouterEventRow[],
  withEvents: boolean
): SessionRouterSummary {
  const mine = routerEventsForThread(thread, rows);
  const guessed = mine.some((row) => row.thread === null);
  const acc: RouterSummaryAccumulator = {
    requests: new Set<string>(),
    providerSequence: [],
    modelSequence: [],
    byProvider: {},
    failures: [],
    skipped: [],
    retries: 0,
    exhaustionWaitCount: 0,
    exhaustionWaitMs: 0,
    transportErrors: 0
  };
  for (const row of mine) recordRouterEvent(row, acc);
  return {
    thread: thread.id,
    model: thread.model,
    matchedBy: guessed ? "model-window" : "thread",
    requests: acc.requests.size,
    byProvider: acc.byProvider,
    failures: acc.failures,
    providerSequence: acc.providerSequence,
    modelSequence: acc.modelSequence,
    ...(acc.skipped.length > 0 ? { skipped: acc.skipped } : {}),
    ...(acc.retries > 0 ? { retries: acc.retries } : {}),
    ...(acc.exhaustionWaitCount > 0
      ? {
          exhaustionWaits: {
            count: acc.exhaustionWaitCount,
            totalMs: acc.exhaustionWaitMs
          }
        }
      : {}),
    ...(acc.transportErrors > 0
      ? { transportErrors: acc.transportErrors }
      : {}),
    ...(withEvents ? { events: mine } : {})
  };
}
