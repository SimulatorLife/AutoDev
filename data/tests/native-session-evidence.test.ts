import assert from "node:assert/strict";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readNativeSessionEvidence } from "../src/diagnostics/native-session-evidence.ts";
import {
  listRecentSessionsResponse,
  rolloutRoots
} from "../src/diagnostics/rollout-discovery.ts";
import { buildSessionDiagnosticsReport } from "../src/diagnostics/session-report.ts";
import { scanRecentSessions } from "../src/diagnostics/fleet-scan.ts";

test("native history joins existing diagnostics without pretending there are rollout metrics", async () => {
  using root = mkdtempDisposableSync(path.join(tmpdir(), "native-session-history-"));
  const log = path.join(root.path, "router.log");
  const id = "native:claude_code:session-123";
  const event = (timestamp: string, outcome: string, thread = id) => JSON.stringify({
    schema: "autodev-router-event-v1",
    phase: "native_session",
    origin: "native_session",
    timestamp,
    thread,
    outcome,
    clientSurface: "claude_code",
    model: "fixture-model",
    workspace: "project"
  });
  writeFileSync(log + ".1", event("2026-11-26T12:00:00.000Z", "start") + "\n");
  writeFileSync(log, [
    event("2026-11-26T12:01:00.000Z", "stop"),
    event("2026-11-26T12:02:00.000Z", "end"),
    event("2026-11-26T12:03:00.000Z", "start", "../secret")
  ].join("\n") + "\n");
  const native = readNativeSessionEvidence(log);
  assert.deepEqual(native, [{
    id,
    clientSurface: "claude_code",
    startedAt: "2026-11-26T12:00:00.000Z",
    lastObservedAt: "2026-11-26T12:02:00.000Z",
    endedAt: "2026-11-26T12:02:00.000Z",
    model: "fixture-model",
    workspace: "project"
  }]);
  const recent = listRecentSessionsResponse(rolloutRoots(root.path), 10, log);
  assert.equal(recent.sessions[0]?.id, id);
  const scan = await scanRecentSessions({ codexHome: root.path, routerLog: log, limit: 10 });
  assert.equal(scan.recentSessions?.[0]?.id, id);
  assert.equal(scan.sessions.length, 0);
  assert.equal(scan.totals.sessions, 0);
  const report = await buildSessionDiagnosticsReport({
    id, codexHome: root.path, routerLog: log, offline: true,
    includeEfficiency: false, includeEvents: false, includeItems: false,
    eventsLimit: 50, eventsOffset: 0, itemsLimit: 50, itemsOffset: 0
  });
  assert.equal(report.found, true);
  assert.equal(report.rootSessionId, id);
  assert.equal(report.nativeSession?.endedAt, "2026-11-26T12:02:00.000Z");
  assert.equal(report.threads.length, 0);
});
