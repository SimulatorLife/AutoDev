/**
The router log reader.

The router writes one structured event per request to its stderr log, and
launchd rotates that log: the live file becomes empty and the events move
to `.err.log.1`, then `.2`, and so on. Reading only the live file therefore
reads as "the router saw no request at all" for exactly the sessions that
are worth investigating.

This module reads the rotated series and summarizes it per thread.
*/

import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  AcpPinRecord,
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

/**
The router-event fields this module projects into the per-thread summary.
*/
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
Every router event in a time window, read from one log line.
*/
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
    requestId: stringOrNull(event.requestId) ?? "",
    thread: stringOrNull(event.thread),
    phase: stringOrNull(event.phase) ?? "",
    role: stringOrNull(event.role),
    requestedModel: stringOrNull(event.requestedModel),
    provider: stringOrNull(event.provider),
    model: stringOrNull(event.model),
    outcome: stringOrNull(event.outcome),
    status: numberOrNull(event.status),
    failureClass: stringOrNull(event.failureClass),
    ...(typeof event.reason === "string" && { reason: event.reason }),
    spawnFailureReason: stringOrNull(event.spawnFailureReason),
    denialReason: stringOrNull(event.denialReason),
    elapsedMs: numberOrNull(event.elapsedMs),
    toolCalls: numberOrNull(event.toolCalls),
    selection: stringOrNull(event.selection),
    ...(typeof event.errorName === "string" && { errorName: event.errorName }),
    ...(typeof event.errorCode === "string" && { errorCode: event.errorCode })
  };
}

/**
Every log that can hold the router's events, newest first.

launchd rotates the router's stderr log: the live file becomes empty and
the events move to `.err.log.1`, then `.2`, and so on.
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

/**
Every router event in a time window, read in one pass over the logs.
*/
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
  accumulator: RouterSummaryAccumulator
): void {
  const entry = (accumulator.byProvider[row.provider ?? "?"] ??= {
    requests: 0,
    failures: 0,
    elapsedMs: 0,
    toolCalls: 0
  });
  entry.requests += 1;
  entry.elapsedMs += row.elapsedMs ?? 0;
  entry.toolCalls += row.toolCalls ?? 0;
  if (row.outcome !== "failure") {
    return;
  }

  entry.failures += 1;
  accumulator.failures.push({
    at: row.at,
    requestId: row.requestId,
    provider: row.provider,
    status: row.status,
    failureClass: row.failureClass ?? row.denialReason ?? null,
    elapsedMs: row.elapsedMs
  });
}

function recordRouterEvent(
  row: SessionRouterEventRow,
  accumulator: RouterSummaryAccumulator
): void {
  switch (row.phase) {
    case "selected": {
      accumulator.requests.add(row.requestId);
      const provider = row.provider ?? "?";
      if (accumulator.providerSequence.at(-1) !== provider)
        accumulator.providerSequence.push(provider);
      if (row.model && accumulator.modelSequence.at(-1) !== row.model)
        accumulator.modelSequence.push(row.model);
      return;
    }
    case "spawn_failed": {
      accumulator.failures.push({
        at: row.at,
        requestId: row.requestId,
        provider: row.provider,
        status: row.status,
        failureClass:
          row.failureClass ?? row.spawnFailureReason ?? "spawn_failed",
        elapsedMs: row.elapsedMs,
        ...(row.spawnFailureReason && {
          spawnFailureReason: row.spawnFailureReason
        })
      });
      return;
    }
    case "skipped": {
      accumulator.skipped.push({
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
      accumulator.retries += 1;
      return;
    }
    case "exhaustion_wait": {
      accumulator.exhaustionWaitCount += 1;
      accumulator.exhaustionWaitMs += row.elapsedMs ?? 0;
      return;
    }
    case "transport_error": {
      accumulator.transportErrors += 1;
      return;
    }
    case "result": {
      recordRouterResult(row, accumulator);
      break;
    }
    default: {
      break;
    }
  }
}

/**
Shift an ISO timestamp by a number of seconds.
*/
export function shift(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
The router events that belong to one thread.

Events that name the thread match exactly; older ones that predate the
thread field fall back to the model and the time window.
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
One thread's requests, summarized.

Historical router events preserve pre-ACP provider-hop evidence (matching by
`thread` or legacy `model-window`). When a thread has no router events and an
authoritative ACP session pin owns it, attribution comes directly from that pin.
*/
export function summarizeRouter(
  thread: SessionThreadTrace,
  rows: readonly SessionRouterEventRow[],
  withEvents: boolean,
  acpPin?: AcpPinRecord | null
): SessionRouterSummary {
  const mine = routerEventsForThread(thread, rows);
  if (mine.length === 0 && acpPin) {
    return {
      thread: thread.id,
      model: thread.model,
      matchedBy: "acp-pin",
      pinSessionId: acpPin.sessionId,
      pinRole: acpPin.role,
      pinTransport: acpPin.transport,
      requests: 0,
      byProvider: {},
      failures: [],
      providerSequence: [acpPin.provider],
      modelSequence: [acpPin.model],
      ...(withEvents && { events: [] })
    };
  }
  const isGuessed = mine.some((row) => row.thread === null);
  const accumulator: RouterSummaryAccumulator = {
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
  for (const row of mine) recordRouterEvent(row, accumulator);
  return {
    thread: thread.id,
    model: thread.model,
    matchedBy: isGuessed ? "model-window" : "thread",
    requests: accumulator.requests.size,
    byProvider: accumulator.byProvider,
    failures: accumulator.failures,
    providerSequence: accumulator.providerSequence,
    modelSequence: accumulator.modelSequence,
    ...(accumulator.skipped.length > 0 && { skipped: accumulator.skipped }),
    ...(accumulator.retries > 0 && { retries: accumulator.retries }),
    ...(accumulator.exhaustionWaitCount > 0 && {
      exhaustionWaits: {
        count: accumulator.exhaustionWaitCount,
        totalMs: accumulator.exhaustionWaitMs
      }
    }),
    ...(accumulator.transportErrors > 0 && {
      transportErrors: accumulator.transportErrors
    }),
    ...(withEvents && { events: mine })
  };
}
