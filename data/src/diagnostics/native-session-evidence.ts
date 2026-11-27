/**
Native lifecycle evidence from the existing rotated router event log.
*/
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import {
  type ClientSurface,
  isNativeSessionClient,
  isNativeSessionEvent,
  isRecord,
  type NativeSessionEvidence,
  safeAutoDevSessionId
} from "@simulatorlife/autodev-core";

import { routerLogFiles } from "./router-events.ts";

const MAX_LOG_FILES = 4;
const MAX_LOG_TAIL_BYTES = 1024 * 1024;

export interface ObservedNativeSession extends NativeSessionEvidence {
  readonly id: string;
  readonly clientSurface: ClientSurface;
}

function readLogTail(file: string): string[] {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const start = Math.max(0, stat.size - MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // The tail can start inside an event.
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function nativeEvent(line: string) {
  if (!line.includes('"phase":"native_session"')) return null;
  try {
    const raw: unknown = JSON.parse(line);
    if (
      !isRecord(raw) ||
      raw.schema !== "autodev-router-event-v1" ||
      raw.phase !== "native_session" ||
      raw.origin !== "native_session"
    )
      return null;
    const client = raw.clientSurface;
    if (!isNativeSessionClient(client)) return null;
    const id = safeAutoDevSessionId(raw.thread);
    if (!id?.startsWith(`native:${client}:`)) return null;
    const event = raw.outcome;
    if (!isNativeSessionEvent(event) || typeof raw.timestamp !== "string" ||
      !Number.isFinite(Date.parse(raw.timestamp)))
      return null;
    const at = new Date(raw.timestamp).toISOString();
    const model =
      typeof raw.model === "string" &&
      /^[A-Za-z0-9_.:/-]{1,128}$/u.test(raw.model)
        ? raw.model
        : null;
    const workspace =
      typeof raw.workspace === "string" &&
      /^[A-Za-z0-9_. -]{1,128}$/u.test(raw.workspace)
        ? raw.workspace
        : null;
    return { id, client, event, at, model, workspace } as const;
  } catch {
    return null;
  }
}

/**
A bounded historical window, not the live-session authority. The first
observed event in the tail need not be the session's start.
*/
export function readNativeSessionEvidence(
  routerLog: string
): ObservedNativeSession[] {
  const sessions = new Map<string, ObservedNativeSession>();
  for (const file of routerLogFiles(routerLog)
    .slice(0, MAX_LOG_FILES)
    .reverse()) {
    for (const line of readLogTail(file)) {
      const observed = nativeEvent(line);
      if (!observed) continue;
      const previous = sessions.get(observed.id);
      if (previous && observed.at < previous.lastObservedAt) continue;
      const isOpening = observed.event === "start";
      const isResumed = observed.event === "prompt";
      sessions.set(observed.id, {
        id: observed.id,
        clientSurface: observed.client,
        startedAt: isOpening ? observed.at : (previous?.startedAt ?? null),
        lastObservedAt: observed.at,
        endedAt:
          observed.event === "end"
            ? observed.at
            : isOpening || isResumed
              ? null
              : (previous?.endedAt ?? null),
        model: observed.model ?? previous?.model ?? null,
        workspace: observed.workspace ?? previous?.workspace ?? null
      });
    }
  }
  return [...sessions.values()];
}
