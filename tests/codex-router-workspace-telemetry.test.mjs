import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  proxyConcreteResponse,
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

test("tracks confirmed RacingGame skill reads separately from exposed skills", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  noteBridgeRequest("req-racing-skill", {
    provider: "antigravity",
    model: "gemini-3.8-flash-medium",
    role: "orchestrator",
    workspace: "RacingGame",
  });

  ingestAgentEvents({
    requestId: "req-racing-skill",
    events: [
      { type: "skill_exposed", skill: "orchestration", source: "role_contract" },
      { type: "skill_used", skill: "orchestration", source: "skill_read", eventId: "read-1" },
      { type: "skill_used", skill: "orchestration", source: "skill_read", eventId: "read-1" },
    ],
  });

  let racingGame = getRouterStatus().usage.byWorkspace.RacingGame;
  assert.equal(racingGame.skillUses, 1);
  assert.equal(racingGame.bySkill.find((row) => row.skill === "orchestration")?.uses, 1);
  assert.deepEqual(racingGame.bridgeSkills.map((row) => row.skill), [ "orchestration" ]);

  resetOtelTelemetry();
  resetRouterTelemetry();
  noteBridgeRequest("req-racing-exposure", {
    provider: "antigravity",
    model: "gemini-3.8-flash-medium",
    role: "orchestrator",
    workspace: "RacingGame",
  });
  ingestAgentEvents({
    requestId: "req-racing-exposure",
    events: [ { type: "skill_exposed", skill: "orchestration", source: "role_contract" } ],
  });
  racingGame = getRouterStatus().usage.byWorkspace.RacingGame;
  assert.equal(racingGame.skillUses, 0);
  assert.equal(racingGame.bySkill.length, 0);
  assert.deepEqual(racingGame.bridgeSkills, [ { skill: "orchestration", count: 1 } ]);

  resetOtelTelemetry();
  resetRouterTelemetry();
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
    assert.equal(raw.usage.schemaVersion, 8);
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

test("tool/skill attribution capability is workspace-scoped, not a single process-wide flag", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();

  // One workspace proves both dimensions with first-class bridge events.
  noteBridgeRequest("req-has-evidence", { provider: "claude", model: "sonnet", role: "default", workspace: "SimulatorLife/HasEvidence" });
  ingestAgentEvents({
    requestId: "req-has-evidence",
    events: [
      { type: "tool_executed", tool: "apply_patch", status: "ok" },
      { type: "skill_exposed", skill: "ccc" },
    ],
  });

  // A second workspace with zero tool/skill evidence of its own must not
  // inherit "capable" from the first workspace's proof.
  recordRouterEvent({ phase: "selected", requestId: "req-blank", provider: "claude", model: "sonnet", workspace: { key: "SimulatorLife/NoEvidence" } });
  recordRouterEvent({ phase: "result", requestId: "req-blank", provider: "claude", model: "sonnet", workspace: { key: "SimulatorLife/NoEvidence" }, outcome: "success", elapsedMs: 1 });

  const usage = getRouterStatus().usage.byWorkspace;
  const capable = usage[ "SimulatorLife/HasEvidence" ];
  const blank = usage[ "SimulatorLife/NoEvidence" ];
  assert.ok(Array.isArray(capable.byTool), "the workspace with its own evidence must report byTool rows");
  assert.ok(Array.isArray(capable.bySkill), "the workspace with its own evidence must report bySkill rows");
  assert.equal(blank.byTool, null, "a workspace with no evidence of its own must stay unavailable regardless of other workspaces");
  assert.equal(blank.bySkill, null, "a workspace with no evidence of its own must stay unavailable regardless of other workspaces");

  resetOtelTelemetry();
  resetRouterTelemetry();
  resetAttributionDiagnostics();
});

test("mcp_exposed bridge observations populate per-workspace exposed rows without inflating uses", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  noteBridgeRequest("req-mcp-exposed", { provider: "claude", model: "sonnet", role: "default", workspace: "SimulatorLife/AutoDev" });
  ingestAgentEvents({
    requestId: "req-mcp-exposed",
    events: [
      { type: "mcp_exposed", server: "playwright", source: "role_contract" },
      { type: "mcp_exposed", server: "playwright", source: "role_contract" },
      { type: "mcp_exposed", server: "lsp", source: "role_contract" },
    ],
  });

  const telemetry = codexTelemetryStatus();
  // Duplicate observations for the same request/workspace/server are idempotent.
  assert.equal(telemetry.bridgeEvents.mcpExposed.total, 2);
  const playwrightRow = telemetry.bridgeEvents.mcpExposed.byServer.find((row) => row.server === "playwright");
  assert.equal(playwrightRow?.count, 1);

  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/AutoDev" ];
  assert.deepEqual(ws.mcpExposed, [
    { server: "lsp", count: 1 },
    { server: "playwright", count: 1 },
  ]);
  // Exposure alone (the model was handed the server) is not a use.
  assert.deepEqual(ws.mcpUses, []);
  assert.deepEqual(ws.byMcp, {});

  // A workspace with no MCP evidence must remain explicitly unavailable.
  recordRouterEvent({ phase: "selected", requestId: "req-no-mcp", provider: "claude", model: "sonnet", workspace: { key: "SimulatorLife/NoMcpEvidence" } });
  const noMcp = getRouterStatus().usage.byWorkspace[ "SimulatorLife/NoMcpEvidence" ];
  assert.equal(noMcp.byMcp, null);
  assert.equal(noMcp.mcpUses, null);
  assert.equal(noMcp.mcpExposed, null);

  resetOtelTelemetry();
  resetRouterTelemetry();
});

test("mcp uses are counted only from discovery spans and executed tool calls, never init/health spans", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  const mcpSpan = (name) => ({
    name,
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    attributes: attrs([ [ "server_name", "playwright" ], [ "workspace", "SimulatorLife/RacingGame" ] ]),
  });
  ingestOtelSignal("traces", { resourceSpans: [ {
    scopeSpans: [ { spans: [
      // An init/health span proves the server is reachable, not that it was used.
      mcpSpan("make_rmcp_client"),
      // A discovery span is a genuine "use".
      mcpSpan("list_tools_for_client_uncached"),
    ] } ],
  } ] });

  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/RacingGame" ];
  assert.equal(ws.byMcp.playwright, 1, "only the discovery span should count as a use");
  assert.deepEqual(ws.mcpUses, [ { server: "playwright", count: 1 } ]);

  resetOtelTelemetry();
  resetRouterTelemetry();
});

test("bridge tool_requested/tool_unavailable observations do not count as MCP uses, only tool_executed does", () => {
  resetOtelTelemetry();
  resetRouterTelemetry();
  noteBridgeRequest("req-mcp-uses", { provider: "claude", model: "sonnet", role: "default", workspace: "SimulatorLife/AutoDev" });
  ingestAgentEvents({
    requestId: "req-mcp-uses",
    events: [
      { type: "tool_requested", tool: "browser_navigate", server: "playwright" },
      { type: "tool_unavailable", tool: "browser_navigate", server: "playwright", reason: "denied" },
      { type: "tool_executed", tool: "browser_navigate", server: "playwright", status: "ok" },
    ],
  });

  const ws = getRouterStatus().usage.byWorkspace[ "SimulatorLife/AutoDev" ];
  assert.equal(ws.byMcp.playwright, 1, "requested/unavailable must not count as uses, only the executed call does");
  assert.deepEqual(ws.mcpUses, [ { server: "playwright", count: 1 } ]);

  resetOtelTelemetry();
  resetRouterTelemetry();
});

test("concrete-model request session correlation resolves session-scoped agent events to the workspace", async () => {
  resetOtelTelemetry();
  resetRouterTelemetry();

  const originalFetch = globalThis.fetch;
  const fakeResponse = {
    writeHead() { },
    write() { },
    end() { },
    on() { },
    once() { },
    removeListener() { },
    headersSent: false,
  };
  const route = {
    provider: "claude",
    baseUrl: "http://127.0.0.1:4011",
    model: "claude-3-5-sonnet",
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: "resp_123", object: "response", status: "completed", output: [] }),
  });

  try {
    const session = { key: "session-concrete-turn", scope: "identified" };
    const workspace = { key: "SimulatorLife/ConcreteWorkspace", cwd: null };
    await proxyConcreteResponse(
      fakeResponse,
      route,
      { model: "claude-3-5-sonnet", stream: false },
      false,
      "req-concrete-1",
      null,
      workspace,
      null,
      session,
    );

    const result = ingestAgentEvents({
      requestId: "session-concrete-turn",
      events: [
        { type: "mcp_exposed", server: "playwright", source: "role_contract" },
        { type: "tool_executed", tool: "browser_click", server: "playwright", status: "ok" },
      ],
    });

    assert.equal(result.reason, null, "session-keyed event must be accepted via concrete session correlation");
    const ws = getRouterStatus().usage.byWorkspace["SimulatorLife/ConcreteWorkspace"];
    assert.ok(ws, "workspace must receive the attributed activity");
    assert.equal(ws.byMcp.playwright, 1);
    assert.deepEqual(ws.mcpUses, [{ server: "playwright", count: 1 }]);
    assert.deepEqual(ws.mcpExposed, [{ server: "playwright", count: 1 }]);
  } finally {
    globalThis.fetch = originalFetch;
    resetOtelTelemetry();
    resetRouterTelemetry();
  }
});

test("persisted state with schemaVersion 7 restores usage backward-safely without shims", async () => {
  resetOtelTelemetry();
  resetRouterTelemetry();

  const tempDir = await mkdtemp(join(tmpdir(), "router-v7-test-"));
  const stateFile = join(tempDir, "state-v7.json");

  const v7State = {
    schema: "autodev-router-persisted-state-v3",
    savedAt: "2026-09-12T12:00:00.000Z",
    usage: {
      schemaVersion: 7,
      workspaceAttributionCapabilities: { tools: true, skills: true },
      byWorkspace: {
        "SimulatorLife/LegacyProject": {
          attempts: 5,
          successes: 4,
          failures: 1,
          skipped: 0,
          durationMs: 500,
          maxDurationMs: 200,
          toolCalls: 3,
          toolsExecuted: 2,
          skillsExposed: 1,
          skillUses: 1,
          byMcp: { lsp: 2 },
          byTool: [
            { tool: "exec_command", source: "builtin", server: null, count: 2, byStatus: { ok: 2 }, durationCount: 2, durationMs: 100 }
          ],
          bySkill: [
            { skill: "ccc", total: 1, byStatus: { ok: 1 }, byInvokeType: {}, byAgentKind: {}, byModel: {}, byPlugin: {} }
          ],
        },
      },
      workspaceRegistry: [["ws_legacy12345", "SimulatorLife/LegacyProject"]],
    },
  };

  try {
    await writeFile(stateFile, JSON.stringify(v7State), "utf8");
    const loaded = loadRouterState(stateFile);
    assert.equal(loaded, true, "schemaVersion 7 state must load successfully");

    const ws = getRouterStatus().usage.byWorkspace["SimulatorLife/LegacyProject"];
    assert.ok(ws, "legacy workspace must be restored");
    assert.equal(ws.successes, 4);
    assert.equal(ws.failures, 1);
    assert.equal(ws.toolsExecuted, 2);
    assert.equal(ws.skillsExposed, 1);
    assert.equal(ws.skillUses, 1);
    assert.equal(ws.byMcp.lsp, 2);
    assert.deepEqual(ws.mcpUses, [{ server: "lsp", count: 2 }]);
    assert.ok(Array.isArray(ws.byTool), "byTool should be restored");
    assert.ok(Array.isArray(ws.bySkill), "bySkill should be restored");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    resetOtelTelemetry();
    resetRouterTelemetry();
  }
});
