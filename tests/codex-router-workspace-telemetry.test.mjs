import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ingestOtelSignal,
  ingestAgentEvents,
  recordRouterEvent,
  registerWorkspaceId,
  attributionDiagnosticsStatus,
  resetAttributionDiagnostics,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resetSubagentTelemetry,
  codexTelemetryStatus,
  getRouterStatus,
  persistRouterStateNow,
  loadRouterState,
  noteBridgeRequest,
  setCodexStateSnapshotForTests,
} from "../scripts/codex-model-router.mjs";

const attrs = (entries) => entries.map(([ key, value ]) => ({ key, value: { stringValue: String(value) } }));
const point = (entries, value, start = "1", time = "2") => ({
  attributes: attrs(entries),
  startTimeUnixNano: String(start),
  timeUnixNano: String(time),
  asInt: String(value),
});
const histogramPoint = (entries, count, sum, start = "1", time = "2") => ({
  attributes: attrs(entries),
  startTimeUnixNano: String(start),
  timeUnixNano: String(time),
  count: String(count),
  sum,
});

test("ingests codex.tool_result and separates executed from unattributed coverage", () => {
  resetOtelTelemetry();
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [
          {
            name: "codex.tool_result",
            sum: {
              aggregationTemporality: 1,
              dataPoints: [
                point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ], [ "call_id", "call-1" ] ], 4, 10, 20),
                point([ [ "tool", "read_file" ], [ "source", "builtin" ], [ "status", "ok" ], [ "call_id", "call-2" ] ], 2, 11, 21),
                point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "error" ] ], 3, 12, 22),
                // Duplicate call_id (same call-1, different start/time):
                // counted under unattributed.
                point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ], [ "call_id", "call-1" ] ], 1, 13, 23),
              ],
            },
          },
        ],
      } ],
    } ],
  });

  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.toolResults.total, 10);
  assert.equal(telemetry.toolResults.executed, 6); // 4 + 2 unique call ids
  assert.equal(telemetry.toolResults.unattributed, 4); // 3 not joinable + 1 duplicate
  assert.equal(telemetry.toolResults.causeResolved, 6);
  assert.equal(telemetry.toolResults.causeUnresolved, 3);
  const execRow = telemetry.toolResults.byTool.find((row) => row.tool === "exec_command");
  assert.equal(execRow.count, 8); // byTool counts coverage regardless of cause
  assert.equal(execRow.byStatus.ok, 5);
  assert.equal(execRow.byStatus.error, 3);

  resetOtelTelemetry();
});

test("aggregates codex.tool_result duration histograms", () => {
  resetOtelTelemetry();
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool_result",
          histogram: {
            aggregationTemporality: 1,
            dataPoints: [
              histogramPoint([ [ "tool", "exec_command" ], [ "source", "builtin" ] ], 3, 90, 10, 20),
              histogramPoint([ [ "tool", "read_file" ], [ "source", "builtin" ] ], 2, 30, 10, 20),
            ],
          },
        } ],
      } ],
    } ],
  });
  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.toolResults.executionDurationMs.count, 5);
  assert.equal(telemetry.toolResults.executionDurationMs.sum, 120);
  assert.equal(Math.round(telemetry.toolResults.executionDurationMs.average), 24);
  resetOtelTelemetry();
});

test("dedupes codex.tool_result events with the same call id from the same window", () => {
  resetOtelTelemetry();
  // First export resolves call-1, call-2
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool_result",
          sum: {
            aggregationTemporality: 2, // CUMULATIVE
            dataPoints: [
              point([ [ "tool", "exec_command" ], [ "call_id", "call-A" ], [ "status", "ok" ] ], 1, 0, 100),
              point([ [ "tool", "exec_command" ], [ "call_id", "call-B" ], [ "status", "ok" ] ], 1, 0, 100),
            ],
          },
        } ],
      } ],
    } ],
  });
  let telemetry = codexTelemetryStatus();
  assert.equal(telemetry.toolResults.executed, 2);
  assert.equal(telemetry.toolResults.unattributed, 0);

  // Same call ids, same timestamps -> delta is 0 -> counts are unchanged
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool_result",
          sum: {
            aggregationTemporality: 2,
            dataPoints: [
              point([ [ "tool", "exec_command" ], [ "call_id", "call-A" ], [ "status", "ok" ] ], 1, 0, 100),
              point([ [ "tool", "exec_command" ], [ "call_id", "call-B" ], [ "status", "ok" ] ], 1, 0, 100),
            ],
          },
        } ],
      } ],
    } ],
  });
  telemetry = codexTelemetryStatus();
  assert.equal(telemetry.toolResults.executed, 2);
  assert.equal(telemetry.toolResults.unattributed, 0);

  // New call id and a bumped cumulative value for an existing one -> only
  // the new delta applies
  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool_result",
          sum: {
            aggregationTemporality: 2,
            dataPoints: [
              point([ [ "tool", "exec_command" ], [ "call_id", "call-A" ], [ "status", "ok" ] ], 1, 0, 100),
              point([ [ "tool", "exec_command" ], [ "call_id", "call-C" ], [ "status", "ok" ] ], 1, 0, 200),
            ],
          },
        } ],
      } ],
    } ],
  });
  telemetry = codexTelemetryStatus();
  assert.equal(telemetry.toolResults.executed, 3);
  assert.equal(telemetry.toolResults.unattributed, 0);
  resetOtelTelemetry();
});

test("attaches unattributed coverage to the workspace bucket when workspace_id resolves", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();
  registerWorkspaceId("ws-unattr-1", "SimulatorLife/RacingGame");

  ingestOtelSignal("metrics", {
    resourceMetrics: [ {
      resource: { attributes: attrs([ [ "workspace_id", "ws-unattr-1" ] ]) },
      scopeMetrics: [ {
        metrics: [ {
          name: "codex.tool_result",
          sum: {
            aggregationTemporality: 1,
            dataPoints: [
              // No call id + resolvable workspace -> toolsUnattributed counts
              point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 2, 10, 20),
            ],
          },
        } ],
      } ],
    } ],
  });

  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/RacingGame" ];
  assert.equal(ws.toolsUnattributed, 2);
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();
});

test("records bridge tool_executed / tool_requested / tool_unavailable observations", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  registerWorkspaceId("ws-bridge-1", "SimulatorLife/AutoDev");

  // Anchor a bridge request so the agent-events endpoint has a context.
  noteBridgeRequest("req-bridge-1", { provider: "claude", model: "sonnet", role: "default", workspace: "SimulatorLife/AutoDev" });
  ingestAgentEvents({
    requestId: "req-bridge-1",
    events: [
      { type: "tool_executed", tool: "apply_patch", callId: "call-1", status: "ok", server: "codex-builtin" },
      { type: "tool_executed", tool: "apply_patch", callId: "call-2", status: "error", server: "codex-builtin" },
      { type: "tool_requested", tool: "web_search", callId: "call-3" },
      { type: "tool_unavailable", tool: "manage_subagents", reason: "denied" },
      { type: "skill_exposed", skill: "ccc", source: "user", pluginId: "user-ccc" },
      { type: "skill_exposed", skill: "lsp-mcp-server", source: "user" },
    ],
  });

  const telemetry = codexTelemetryStatus();
  assert.equal(telemetry.bridgeEvents.toolExecuted.total, 2);
  assert.equal(telemetry.bridgeEvents.toolRequested.total, 1);
  assert.equal(telemetry.bridgeEvents.toolUnavailable.total, 1);
  assert.equal(telemetry.bridgeEvents.toolUnavailable.byReason.denied, 1);
  assert.equal(telemetry.bridgeEvents.skillExposed.total, 2);
  const skillRows = telemetry.bridgeEvents.skillExposed.bySkill;
  const ccc = skillRows.find((row) => row.skill === "ccc");
  assert.equal(ccc?.pluginId, "user-ccc");

  // The per-workspace counters must have been moved so the dashboard can
  // surface "executed on this workspace" coverage directly.
  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/AutoDev" ];
  assert.equal(ws.toolsExecuted, 2);
  assert.equal(ws.toolsRequested, 1);
  assert.equal(ws.toolsUnavailable, 1);
  assert.equal(ws.skillsExposed, 2);
  assert.deepEqual(ws.bridgeTools.map((row) => row.tool).sort(), [ "apply_patch" ]);
  assert.deepEqual(ws.bridgeSkills.map((row) => row.skill).sort(), [ "ccc", "lsp-mcp-server" ]);

  resetOtelTelemetry();
  resetRouterTelemetry();
  resetSubagentTelemetry();
});

test("rejects unknown bridge event types while keeping accepted observations intact", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  noteBridgeRequest("req-bridge-2", { provider: "claude", model: "sonnet", role: "default", workspace: "SimulatorLife/AutoDev" });
  const result = ingestAgentEvents({
    requestId: "req-bridge-2",
    events: [
      { type: "tool_executed", tool: "exec_command", status: "ok" },
      { type: "made_up_event", tool: "exec_command" },
    ],
  });
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, 1);
  assert.equal(codexTelemetryStatus().bridgeEvents.toolExecuted.total, 1);
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetSubagentTelemetry();
});

test("byTool/bySkill default to null until a first-class event confirms the dimension", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();

  recordRouterEvent({
    phase: "selected",
    requestId: "req-dim",
    provider: "claude",
    model: "sonnet",
    workspace: { key: "SimulatorLife/RacingGame" },
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-dim",
    provider: "claude",
    model: "sonnet",
    workspace: { key: "SimulatorLife/RacingGame" },
    outcome: "success",
    status: 200,
    elapsedMs: 5,
    toolCalls: 1,
  });

  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/RacingGame" ];
  assert.equal(ws.byTool, null);
  assert.equal(ws.bySkill, null);
  assert.equal(ws.toolsExecuted, 0);
  assert.equal(ws.skillsExposed, 0);

  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();
});

test("persists and restores per-workspace tool/skill counters and bridge observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-ws-telemetry-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetOtelTelemetry();
    resetRouterTelemetry();
    registerWorkspaceId("ws-persist-1", "SimulatorLife/AutoDev");
    noteBridgeRequest("req-persist-1", { provider: "minimax", model: "MiniMax-M3", role: "default", workspace: "SimulatorLife/AutoDev" });
    ingestAgentEvents({
      requestId: "req-persist-1",
      events: [
        { type: "tool_executed", tool: "apply_patch", callId: "call-1", status: "ok" },
        { type: "skill_exposed", skill: "ccc" },
      ],
    });

    // Generate an unattributed coverage row to verify it persists.
    ingestOtelSignal("metrics", {
      resourceMetrics: [ {
        scopeMetrics: [ {
          metrics: [ {
            name: "codex.tool_result",
            sum: {
              aggregationTemporality: 1,
              dataPoints: [
                point([ [ "tool", "exec_command" ], [ "source", "builtin" ], [ "status", "ok" ] ], 4, 10, 20),
              ],
            },
          } ],
        } ],
      } ],
    });

    await persistRouterStateNow(stateFile);
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(raw.usage.schemaVersion, 7);
    const persistedWs = raw.usage.byWorkspace[ "SimulatorLife/AutoDev" ];
    assert.equal(persistedWs.toolsExecuted, 1);
    assert.equal(persistedWs.skillsExposed, 1);
    assert.deepEqual(persistedWs.bridgeSkills.map((entry) => entry.skill), [ "ccc" ]);
    assert.ok(Array.isArray(persistedWs.bridgeTools));
    assert.equal(raw.otelTelemetry.toolResults.total, 4);
    assert.equal(raw.otelTelemetry.bridgeEvents.toolExecuted.total, 1);
    assert.equal(raw.otelTelemetry.bridgeEvents.skillExposed.total, 1);

    resetOtelTelemetry();
    resetRouterTelemetry();
    assert.equal(loadRouterState(stateFile), true);

    const restored = getRouterStatus().usage.byWorkspace[ "SimulatorLife/AutoDev" ];
    assert.equal(restored.toolsExecuted, 1);
    assert.equal(restored.skillsExposed, 1);
    assert.deepEqual(restored.bridgeSkills.map((entry) => entry.skill).sort(), [ "ccc" ]);
    const restoredTelemetry = codexTelemetryStatus();
    assert.equal(restoredTelemetry.toolResults.total, 4);
    assert.equal(restoredTelemetry.bridgeEvents.toolExecuted.total, 1);
    assert.equal(restoredTelemetry.bridgeEvents.skillExposed.total, 1);
  } finally {
    resetOtelTelemetry();
    resetRouterTelemetry();
    resetSubagentTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});


test("joins semantic codex.tool_result OTLP logs to the local thread snapshot", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  setCodexStateSnapshotForTests({ conversationThreads: {
    "thread-1": { threadId: "thread-1", workspaceKey: "SimulatorLife/RacingGame", cwdBasename: "RacingGame" },
  } });
  ingestOtelSignal("logs", { resourceLogs: [ {
    scopeLogs: [ { logRecords: [ { attributes: attrs([
      [ "event.name", "codex.tool_result" ],
      [ "conversation.id", "thread-1" ],
      [ "tool_name", "exec_command" ],
      [ "tool_origin", "builtin" ],
      [ "call_id", "call-log-1" ],
      [ "success", "true" ],
      [ "duration_ms", "12" ],
    ]) } ] } ],
  } ] });
  const ws = getRouterStatus().usage.byWorkspace["SimulatorLife/RacingGame"];
  assert.equal(ws.byTool.find((row) => row.tool === "exec_command")?.count, 1);
  assert.equal(ws.toolsExecuted, 0);
  assert.equal(codexTelemetryStatus().toolResults.executed, 1);
  setCodexStateSnapshotForTests(null);
  resetOtelTelemetry();
  resetRouterTelemetry();
});

test("deduplicates one tool result reported through both semantic logs and metrics", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  setCodexStateSnapshotForTests({ conversationThreads: {
    "thread-dupe": { threadId: "thread-dupe", projectKey: "SimulatorLife/RacingGame", workspaceKey: "SimulatorLife/RacingGame", cwdBasename: "RacingGame" },
  } });
  const logAttributes = attrs([
    [ "event.name", "codex.tool_result" ],
    [ "conversation.id", "thread-dupe" ],
    [ "tool_name", "exec_command" ],
    [ "tool_origin", "builtin" ],
    [ "call_id", "same-call" ],
    [ "success", "true" ],
    [ "duration_ms", "9" ],
  ]);
  ingestOtelSignal("logs", { resourceLogs: [ { scopeLogs: [ { logRecords: [ { attributes: logAttributes } ] } ] } ] });
  ingestOtelSignal("metrics", { resourceMetrics: [ { scopeMetrics: [ { metrics: [ {
    name: "codex.tool_result",
    sum: { aggregationTemporality: 1, dataPoints: [ point([
      [ "conversation.id", "thread-dupe" ], [ "tool_name", "exec_command" ], [ "source", "builtin" ], [ "call_id", "same-call" ], [ "status", "ok" ],
    ], 1, "10", "20") ] },
  } ] } ] } ] });
  const toolResults = codexTelemetryStatus().toolResults;
  assert.equal(toolResults.total, 1);
  assert.equal(toolResults.executed, 1);
  assert.equal(toolResults.unattributed, 0);
  setCodexStateSnapshotForTests(null);
  resetOtelTelemetry();
  resetRouterTelemetry();
});
