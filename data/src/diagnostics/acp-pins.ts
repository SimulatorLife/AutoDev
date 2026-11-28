import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync
} from "node:fs";
import path from "node:path";

import {
  type AcpPinRecord,
  extractCoordinatorThreadId,
  parseAcpPinLedger,
  type SessionThreadTrace
} from "@simulatorlife/autodev-core";

const MAX_PIN_LEDGER_BYTES = 1024 * 1024;

function acpPinsFile(codexHome: string): string {
  return path.join(codexHome, "run", "acp-pins.json");
}

/**
Read the private Runtime/ACP pin ledger under `$CODEX_HOME/run/acp-pins.json`.
Refuses symlinks or unreadable/malformed files cleanly (returning an empty list).
*/
export function readAcpPinLedger(codexHome: string): readonly AcpPinRecord[] {
  const file = acpPinsFile(codexHome);
  try {
    const directoryStat = lstatSync(path.dirname(file));
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0)
      return [];
  } catch {
    return [];
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_PIN_LEDGER_BYTES
    ) {
      return [];
    }
    const parsed = parseAcpPinLedger(
      JSON.parse(readFileSync(descriptor, "utf8"))
    );
    return parsed?.pins ?? [];
  } catch {
    return [];
  } finally {
    closeSync(descriptor);
  }
}

/**
Find all source-confirmed ACP pins belonging to a requested session/thread tree
using explicit ID links (`sessionId`, `acpSessionId`, `parentSessionId`, or
coordinator thread ID parsed from local gateway handles).
*/
export function linkedAcpPinsForSession(
  seedIds: ReadonlySet<string>,
  pins: readonly AcpPinRecord[]
): AcpPinRecord[] {
  const knownIds = new Set(seedIds);
  const linked = new Map<string, AcpPinRecord>();
  let hasChanged = true;
  while (hasChanged) {
    hasChanged = false;
    for (const pin of pins) {
      const coordinatorId = extractCoordinatorThreadId(pin.parentSessionId);
      const isLinked =
        knownIds.has(pin.sessionId) ||
        (pin.acpSessionId !== null && knownIds.has(pin.acpSessionId)) ||
        (pin.parentSessionId !== null && knownIds.has(pin.parentSessionId)) ||
        (coordinatorId !== null && knownIds.has(coordinatorId));
      if (!isLinked) continue;
      if (!linked.has(pin.sessionId)) {
        linked.set(pin.sessionId, pin);
        hasChanged = true;
      }
      if (!knownIds.has(pin.sessionId)) {
        knownIds.add(pin.sessionId);
        hasChanged = true;
      }
      if (!pin.acpSessionId || knownIds.has(pin.acpSessionId)) continue;
      knownIds.add(pin.acpSessionId);
      hasChanged = true;
    }
  }
  return linked.values().toArray();
}

/**
Attribute a traced thread to its owning ACP pin using only source-confirmed
thread/session identities. Exact thread ID matches take priority over
session-level matches; returns null when no pin owns the thread.
*/
export function matchThreadAcpPin(
  thread: Pick<SessionThreadTrace, "id" | "sessionId">,
  pins: readonly AcpPinRecord[]
): AcpPinRecord | null {
  const exactThread = pins.find(
    (pin) => pin.acpSessionId === thread.id || pin.sessionId === thread.id
  );
  if (exactThread) return exactThread;
  if (thread.sessionId === null) return null;
  return (
    pins.find(
      (pin) =>
        pin.acpSessionId === thread.sessionId ||
        pin.sessionId === thread.sessionId
    ) ?? null
  );
}
