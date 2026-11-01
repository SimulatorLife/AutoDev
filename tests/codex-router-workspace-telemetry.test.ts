import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  correlationStatus,
  resetCorrelation
} from "@simulatorlife/autodev-runtime/router/correlation";
import { recordRouterEvent } from "@simulatorlife/autodev-runtime/router/events";
import {
  getRouterStatus,
  ingestAgentEvents,
  resetRouterTelemetry
} from "@simulatorlife/autodev-runtime/router/http";
import {
  loadRouterState,
  persistRouterStateNow
} from "@simulatorlife/autodev-runtime/router/persistence";
import { proxyConcreteResponse } from "@simulatorlife/autodev-runtime/router/proxy";
import {
  noteBridgeRequest,
  resetSubagentTelemetry
} from "@simulatorlife/autodev-runtime/router/subagents";
import { getDefaultUsageTracker } from "@simulatorlife/autodev-runtime/router/usage";

test("records bridge tool_executed / tool_requested / tool_unavailable observations", () => {
  resetCorrelation();
  resetRouterTelemetry();
  getDefaultUsageTracker().registerWorkspaceId(
    "ws-bridge-1",
    "SimulatorLife/AutoDev"
  );

  noteBridgeRequest("req-bridge-1", {
    activitySubject: `req:${"req-bridge-1"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/AutoDev"
  });
  ingestAgentEvents({
    requestId: "req-bridge-1",
    events: [
      {
        type: "tool_executed",
        tool: "apply_patch",
        callId: "call-1",
        status: "ok",
        server: "codex-builtin"
      },
      {
        type: "tool_executed",
        tool: "apply_patch",
        callId: "call-2",
        status: "error",
        server: "codex-builtin"
      },
      { type: "tool_requested", tool: "web_search", callId: "call-3" },
      { type: "tool_unavailable", tool: "manage_subagents", reason: "denied" },
      {
        type: "skill_exposed",
        skill: "ccc",
        source: "user",
        pluginId: "user-ccc"
      },
      { type: "skill_exposed", skill: "lsp-mcp-server", source: "user" }
    ]
  });

  const telemetry = correlationStatus() as Record<string, any>;
  assert.equal(telemetry.bridgeEvents.toolExecuted.total, 2);
  assert.equal(telemetry.bridgeEvents.toolRequested.total, 1);
  assert.equal(telemetry.bridgeEvents.toolUnavailable.total, 1);
  assert.equal(telemetry.bridgeEvents.toolUnavailable.byReason.denied, 1);
  assert.equal(telemetry.bridgeEvents.skillExposed.total, 2);
  const skillRows = telemetry.bridgeEvents.skillExposed.bySkill;
  const ccc = skillRows.find(
    (row: { skill: string; pluginId?: string }) => row.skill === "ccc"
  );
  assert.equal(ccc?.pluginId, "user-ccc");

  const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
    "SimulatorLife/AutoDev"
  ];
  assert.equal(ws.toolsExecuted, 2);
  assert.equal(ws.toolsRequested, 1);
  assert.equal(ws.toolsUnavailable, 1);
  assert.equal(ws.skillsExposed, 2);
  assert.deepEqual(
    ws.bridgeTools.map((row: { tool: string }) => row.tool).sort(),
    ["apply_patch"]
  );
  assert.deepEqual(
    ws.bridgeSkills.map((row: { skill: string }) => row.skill).sort(),
    ["ccc", "lsp-mcp-server"]
  );

  resetCorrelation();
  resetRouterTelemetry();
  resetSubagentTelemetry();
});

test("tracks confirmed RacingGame skill reads separately from exposed skills", () => {
  resetCorrelation();
  resetRouterTelemetry();
  noteBridgeRequest("req-racing-skill", {
    activitySubject: `req:${"req-racing-skill"}`,
    provider: "antigravity",
    model: "gemini-3.8-flash-medium",
    role: "orchestrator",
    workspace: "RacingGame"
  });

  ingestAgentEvents({
    requestId: "req-racing-skill",
    events: [
      {
        type: "skill_exposed",
        skill: "orchestration",
        source: "role_contract"
      },
      {
        type: "skill_used",
        skill: "orchestration",
        source: "skill_read",
        eventId: "read-1"
      },
      {
        type: "skill_used",
        skill: "orchestration",
        source: "skill_read",
        eventId: "read-1"
      }
    ]
  });

  let racingGame = (getRouterStatus() as Record<string, any>).usage.byWorkspace
    .RacingGame;
  assert.equal(racingGame.skillUses, 1);
  assert.equal(
    racingGame.bySkill.find(
      (row: { skill: string; uses: number }) => row.skill === "orchestration"
    )?.uses,
    1
  );
  assert.deepEqual(
    racingGame.bridgeSkills.map((row: { skill: string }) => row.skill),
    ["orchestration"]
  );

  resetCorrelation();
  resetRouterTelemetry();
  noteBridgeRequest("req-racing-exposure", {
    activitySubject: `req:${"req-racing-exposure"}`,
    provider: "antigravity",
    model: "gemini-3.8-flash-medium",
    role: "orchestrator",
    workspace: "RacingGame"
  });
  ingestAgentEvents({
    requestId: "req-racing-exposure",
    events: [
      { type: "skill_exposed", skill: "orchestration", source: "role_contract" }
    ]
  });
  racingGame = (getRouterStatus() as Record<string, any>).usage.byWorkspace
    .RacingGame;
  assert.equal(racingGame.skillUses, 0);
  assert.equal(racingGame.bySkill.length, 0);
  assert.deepEqual(racingGame.bridgeSkills, [
    { skill: "orchestration", count: 1 }
  ]);

  resetCorrelation();
  resetRouterTelemetry();
});

test("a skill_used/skill_read event from a shell cat-style read updates global skill telemetry, workspace skillUses/bySkill, and dashboard-backed status data end-to-end", async () => {
  resetCorrelation();
  resetRouterTelemetry();
  resetSubagentTelemetry();

  noteBridgeRequest("req-shell-skill-read", {
    activitySubject: `req:${"req-shell-skill-read"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/AutoDev"
  });

  ingestAgentEvents({
    requestId: "req-shell-skill-read",
    events: [
      { type: "skill_exposed", skill: "ccc", source: "role_contract" },
      {
        type: "skill_used",
        skill: "ccc",
        source: "skill_read",
        eventId: "skill_read:call-shell-1:ccc"
      },
      {
        type: "skill_used",
        skill: "ccc",
        source: "skill_read",
        eventId: "skill_read:call-shell-1:ccc"
      }
    ]
  });

  const telemetry = correlationStatus() as Record<string, any>;
  assert.equal(telemetry.skills.used.total, 1);
  assert.equal(telemetry.skills.used.byWorkspace["SimulatorLife/AutoDev"], 1);
  const globalSkillRow = telemetry.skills.used.bySkill.find(
    (row: { skill: string }) => row.skill === "ccc"
  );
  assert.ok(
    globalSkillRow,
    "the global skills.used.bySkill breakdown must include the shell-read skill"
  );
  assert.equal(globalSkillRow.total, 1);
  assert.equal(globalSkillRow.byWorkspace["SimulatorLife/AutoDev"], 1);

  const workspace = (getRouterStatus() as Record<string, any>).usage
    .byWorkspace["SimulatorLife/AutoDev"];
  assert.equal(workspace.skillUses, 1);
  const wsSkillRow = workspace.bySkill.find(
    (row: { skill: string; uses: number }) => row.skill === "ccc"
  );
  assert.ok(wsSkillRow, "workspace bySkill must include the shell-read skill");
  assert.equal(wsSkillRow.uses, 1);
  assert.deepEqual(
    workspace.bridgeSkills.map((row: { skill: string }) => row.skill),
    ["ccc"]
  );

  resetCorrelation();
  resetRouterTelemetry();
  resetSubagentTelemetry();
});

test("rejects unknown bridge event types while keeping accepted observations intact", () => {
  resetCorrelation();
  resetRouterTelemetry();
  noteBridgeRequest("req-bridge-2", {
    activitySubject: `req:${"req-bridge-2"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/AutoDev"
  });
  const result = ingestAgentEvents({
    requestId: "req-bridge-2",
    events: [
      { type: "tool_executed", tool: "exec_command", status: "ok" },
      { type: "made_up_event", tool: "exec_command" } as any
    ]
  });
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, 1);
  assert.equal(
    (correlationStatus() as Record<string, any>).bridgeEvents.toolExecuted
      .total,
    1
  );
  resetCorrelation();
  resetRouterTelemetry();
  resetSubagentTelemetry();
});

test("the tool and skill dimensions stay unavailable until a first-class event confirms them", () => {
  resetCorrelation();
  resetRouterTelemetry();
  getDefaultUsageTracker().resetAttributionDiagnostics();

  recordRouterEvent({
    phase: "selected",
    requestId: "req-dim",
    provider: "claude",
    model: "sonnet",
    workspace: "SimulatorLife/RacingGame"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-dim",
    provider: "claude",
    model: "sonnet",
    workspace: "SimulatorLife/RacingGame",
    outcome: "success",
    status: 200,
    elapsedMs: 5,
    toolCalls: 1
  });

  const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
    "SimulatorLife/RacingGame"
  ];
  assert.equal(
    ws.bridgeTools,
    undefined,
    "a workspace with no bridge observation must not publish a tool dimension"
  );
  assert.equal(ws.bySkill, null);
  assert.equal(ws.toolsExecuted, 0);
  assert.equal(ws.skillsExposed, 0);

  resetCorrelation();
  resetRouterTelemetry();
  getDefaultUsageTracker().resetAttributionDiagnostics();
});

test("persists and restores per-workspace tool/skill counters and bridge observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-ws-telemetry-"));
  const stateFile = join(directory, "router-state.json");
  try {
    resetCorrelation();
    resetRouterTelemetry();
    getDefaultUsageTracker().registerWorkspaceId(
      "ws-persist-1",
      "SimulatorLife/AutoDev"
    );
    noteBridgeRequest("req-persist-1", {
      activitySubject: `req:${"req-persist-1"}`,
      provider: "minimax",
      model: "MiniMax-M3",
      role: "default",
      workspace: "SimulatorLife/AutoDev"
    });
    ingestAgentEvents({
      requestId: "req-persist-1",
      events: [
        {
          type: "tool_executed",
          tool: "apply_patch",
          callId: "call-1",
          status: "ok"
        },
        { type: "skill_exposed", skill: "ccc" }
      ]
    });

    await persistRouterStateNow(stateFile);
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as Record<
      string,
      any
    >;
    assert.equal(raw.usage.schemaVersion, 8);
    const persistedWs = raw.usage.byWorkspace["SimulatorLife/AutoDev"];
    assert.equal(persistedWs.toolsExecuted, 1);
    assert.equal(persistedWs.skillsExposed, 1);
    assert.deepEqual(
      persistedWs.bridgeSkills.map((entry: { skill: string }) => entry.skill),
      ["ccc"]
    );
    assert.ok(Array.isArray(persistedWs.bridgeTools));
    assert.equal(raw.correlation.bridgeEvents.toolExecuted.total, 1);
    assert.equal(raw.correlation.bridgeEvents.skillExposed.total, 1);

    resetCorrelation();
    resetRouterTelemetry();
    assert.equal(loadRouterState(stateFile), true);

    const restored = (getRouterStatus() as Record<string, any>).usage
      .byWorkspace["SimulatorLife/AutoDev"];
    assert.equal(restored.toolsExecuted, 1);
    assert.equal(restored.skillsExposed, 1);
    assert.deepEqual(
      restored.bridgeSkills
        .map((entry: { skill: string }) => entry.skill)
        .sort(),
      ["ccc"]
    );
    const restoredTelemetry = correlationStatus() as Record<string, any>;
    assert.equal(restoredTelemetry.bridgeEvents.toolExecuted.total, 1);
    assert.equal(restoredTelemetry.bridgeEvents.skillExposed.total, 1);
  } finally {
    resetCorrelation();
    resetRouterTelemetry();
    resetSubagentTelemetry();
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool/skill attribution capability is workspace-scoped, not a single process-wide flag", () => {
  resetCorrelation();
  resetRouterTelemetry();
  getDefaultUsageTracker().resetAttributionDiagnostics();

  noteBridgeRequest("req-has-evidence", {
    activitySubject: `req:${"req-has-evidence"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/HasEvidence"
  });
  ingestAgentEvents({
    requestId: "req-has-evidence",
    events: [
      { type: "tool_executed", tool: "apply_patch", status: "ok" },
      { type: "skill_exposed", skill: "ccc" }
    ]
  });

  recordRouterEvent({
    phase: "selected",
    requestId: "req-blank",
    provider: "claude",
    model: "sonnet",
    workspace: "SimulatorLife/NoEvidence"
  });
  recordRouterEvent({
    phase: "result",
    requestId: "req-blank",
    provider: "claude",
    model: "sonnet",
    workspace: "SimulatorLife/NoEvidence",
    outcome: "success",
    elapsedMs: 1
  });

  const usage = (getRouterStatus() as Record<string, any>).usage.byWorkspace;
  const capable = usage["SimulatorLife/HasEvidence"];
  const blank = usage["SimulatorLife/NoEvidence"];
  assert.ok(
    Array.isArray(capable.bridgeTools),
    "the workspace with its own evidence must report bridge tool rows"
  );
  assert.ok(
    Array.isArray(capable.bySkill),
    "the workspace with its own evidence must report bySkill rows"
  );
  assert.equal(
    blank.bridgeTools,
    undefined,
    "a workspace with no evidence of its own must stay unavailable regardless of other workspaces"
  );
  assert.equal(
    blank.bySkill,
    null,
    "a workspace with no evidence of its own must stay unavailable regardless of other workspaces"
  );

  resetCorrelation();
  resetRouterTelemetry();
  getDefaultUsageTracker().resetAttributionDiagnostics();
});

test("mcp_exposed bridge observations populate per-workspace exposed rows without inflating uses", () => {
  resetCorrelation();
  resetRouterTelemetry();
  noteBridgeRequest("req-mcp-exposed", {
    activitySubject: `req:${"req-mcp-exposed"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/AutoDev"
  });
  ingestAgentEvents({
    requestId: "req-mcp-exposed",
    events: [
      { type: "mcp_exposed", server: "playwright", source: "role_contract" },
      { type: "mcp_exposed", server: "playwright", source: "role_contract" },
      { type: "mcp_exposed", server: "lsp", source: "role_contract" }
    ]
  });

  const telemetry = correlationStatus() as Record<string, any>;
  assert.equal(telemetry.bridgeEvents.mcpExposed.total, 2);
  const playwrightRow = telemetry.bridgeEvents.mcpExposed.byServer.find(
    (row: { server: string }) => row.server === "playwright"
  );
  assert.equal(playwrightRow?.count, 1);

  const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
    "SimulatorLife/AutoDev"
  ];
  assert.deepEqual(ws.mcpExposed, [
    { server: "lsp", count: 1 },
    { server: "playwright", count: 1 }
  ]);
  assert.deepEqual(ws.mcpUses, []);
  assert.deepEqual(ws.byMcp, {});

  recordRouterEvent({
    phase: "selected",
    requestId: "req-no-mcp",
    provider: "claude",
    model: "sonnet",
    workspace: "SimulatorLife/NoMcpEvidence"
  });
  const noMcp = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
    "SimulatorLife/NoMcpEvidence"
  ];
  assert.equal(noMcp.byMcp, null);
  assert.equal(noMcp.mcpUses, null);
  assert.equal(noMcp.mcpExposed, null);

  resetCorrelation();
  resetRouterTelemetry();
});

test("bridge tool_requested/tool_unavailable observations do not count as MCP uses, only tool_executed does", () => {
  resetCorrelation();
  resetRouterTelemetry();
  noteBridgeRequest("req-mcp-uses", {
    activitySubject: `req:${"req-mcp-uses"}`,
    provider: "claude",
    model: "sonnet",
    role: "default",
    workspace: "SimulatorLife/AutoDev"
  });
  ingestAgentEvents({
    requestId: "req-mcp-uses",
    events: [
      {
        type: "tool_requested",
        tool: "browser_navigate",
        server: "playwright"
      },
      {
        type: "tool_unavailable",
        tool: "browser_navigate",
        server: "playwright",
        reason: "denied"
      },
      {
        type: "tool_executed",
        tool: "browser_navigate",
        server: "playwright",
        status: "ok"
      }
    ]
  });

  const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
    "SimulatorLife/AutoDev"
  ];
  assert.equal(
    ws.byMcp.playwright,
    1,
    "requested/unavailable must not count as uses, only the executed call does"
  );
  assert.deepEqual(ws.mcpUses, [{ server: "playwright", count: 1 }]);

  resetCorrelation();
  resetRouterTelemetry();
});

test("concrete-model request session correlation resolves session-scoped agent events to the workspace", async () => {
  resetCorrelation();
  resetRouterTelemetry();

  const originalFetch = globalThis.fetch;
  const fakeResponse = {
    writeHead() {},
    write() {},
    end() {},
    on() {},
    once() {},
    removeListener() {},
    headersSent: false
  } as unknown as ServerResponse;
  const route = {
    provider: "claude",
    baseUrl: "http://127.0.0.1:4011",
    model: "claude-3-5-sonnet"
  };
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        id: "resp_123",
        object: "response",
        status: "completed",
        output: []
      })
  })) as any;

  try {
    const session = { key: "session-concrete-turn", scope: "identified" };
    const workspace = { key: "SimulatorLife/ConcreteWorkspace", cwd: null };
    await proxyConcreteResponse(
      fakeResponse,
      route as any,
      { model: "claude-3-5-sonnet", stream: false },
      false,
      "req-concrete-1",
      null,
      workspace as any,
      null,
      session as any
    );

    const result = ingestAgentEvents({
      requestId: "session-concrete-turn",
      events: [
        { type: "mcp_exposed", server: "playwright", source: "role_contract" },
        {
          type: "tool_executed",
          tool: "browser_click",
          server: "playwright",
          status: "ok"
        }
      ]
    });

    assert.equal(
      result.reason,
      null,
      "session-keyed event must be accepted via concrete session correlation"
    );
    const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
      "SimulatorLife/ConcreteWorkspace"
    ];
    assert.ok(ws, "workspace must receive the attributed activity");
    assert.equal(ws.byMcp.playwright, 1);
    assert.deepEqual(ws.mcpUses, [{ server: "playwright", count: 1 }]);
    assert.deepEqual(ws.mcpExposed, [{ server: "playwright", count: 1 }]);
  } finally {
    globalThis.fetch = originalFetch;
    resetCorrelation();
    resetRouterTelemetry();
  }
});

test("persisted state with schemaVersion 7 restores usage backward-safely without shims", async () => {
  resetCorrelation();
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
            {
              tool: "exec_command",
              source: "builtin",
              server: null,
              count: 2,
              byStatus: { ok: 2 },
              durationCount: 2,
              durationMs: 100
            }
          ],
          bySkill: [
            {
              skill: "ccc",
              total: 1,
              byStatus: { ok: 1 },
              byInvokeType: {},
              byAgentKind: {},
              byModel: {},
              byPlugin: {}
            }
          ]
        }
      },
      workspaceRegistry: [["ws_legacy12345", "SimulatorLife/LegacyProject"]]
    }
  };

  try {
    await writeFile(stateFile, JSON.stringify(v7State), "utf8");
    const loaded = loadRouterState(stateFile);
    assert.equal(loaded, true, "schemaVersion 7 state must load successfully");

    const ws = (getRouterStatus() as Record<string, any>).usage.byWorkspace[
      "SimulatorLife/LegacyProject"
    ];
    assert.ok(ws, "legacy workspace must be restored");
    assert.equal(ws.successes, 4);
    assert.equal(ws.failures, 1);
    assert.equal(ws.toolsExecuted, 2);
    assert.equal(ws.skillsExposed, 1);
    assert.equal(ws.skillUses, 1);
    assert.equal(ws.byMcp.lsp, 2);
    assert.deepEqual(ws.mcpUses, [{ server: "lsp", count: 2 }]);
    assert.ok(Array.isArray(ws.bySkill), "bySkill should be restored");
    assert.equal(
      ws.byTool,
      undefined,
      "the removed receiver-era tool rows must not be resurrected as a live dimension"
    );
    assert.equal(
      ws.bridgeTools,
      undefined,
      "a legacy state without bridge observations must not publish a tool dimension"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    resetCorrelation();
    resetRouterTelemetry();
  }
});
