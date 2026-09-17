import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getRouterStatus,
  handle,
  ingestAgentEvents,
  noteBridgeRequest,
  noteOrchestratorSession,
  orchestratorProviderForSession,
  recordSubagentSpawn,
  resetRouterTelemetry,
  setCodexStateSnapshotForTests,
} from "../scripts/codex-model-router.mjs";

const contract = await import("./fixtures/contracts/dashboard-status-snapshot.json", { with: { type: "json" } })
  .then((module) => module.default ?? module);

const ROOT = new URL("..", import.meta.url);
const FIXED_NOW = Date.parse(contract.fixedNow);
const dashboardPath = new URL("../scripts/codex-model-router-dashboard.html", import.meta.url);

function assertKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value ?? {}).sort(), [...expected].sort(), `${label} key set`);
}

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, part) => current?.[part], value);
}

const statusShapePaths = {
  telemetryPersistence: "telemetryPersistence",
  authentication: "authentication",
  routing: "routing",
  routingOrchestrator: "routing.orchestrator",
  routingRoutes: "routing.routes",
  limits: "limits",
  usage: "usage",
  usageTotals: "usage.totals",
  usageActivity: "usage.activity",
  attributionDiagnostics: "attributionDiagnostics",
  liveAgentAttribution: "liveAgentAttribution",
  codexTelemetry: "codexTelemetry",
  codexReceiver: "codexTelemetry.receiver",
  codexTurns: "codexTelemetry.turns",
  codexTokens: "codexTelemetry.tokens",
  codexMcpSummary: "codexTelemetry.mcpSummary",
  agents: "agents",
  agentsByState: "agents.byState",
  agentsSlotVsAgent: "agents.slotVsAgent",
  concurrency: "concurrency",
  subagents: "subagents",
  spawnFailures: "spawnFailures",
  codexStateLocalTelemetry: "codexState.localTelemetry",
};

function assertNoLeakedPaths(value, path = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(value, /\/Users\/|\/home\/|CODEX_HOME/, `filesystem path leaked at ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLeakedPaths(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) assertNoLeakedPaths(nested, `${path}.${key}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Extract a complete function rather than relying on a line range. This is
// the same source-level evaluation pattern used by the existing dashboard
// metrics tests, but it also handles nested blocks and template strings.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in dashboard source`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated dashboard function ${name}`);
}

function evaluateFunction(source, name, dependencies = "") {
  return new Function(`${dependencies};${extractFunction(source, name)};return ${name};`)();
}

function reset() {
  setCodexStateSnapshotForTests(null);
  resetRouterTelemetry();
}

test("the frozen /status snapshot has exact fields and privacy-safe metadata", () => {
  reset();
  try {
    const status = getRouterStatus(FIXED_NOW);
    assertKeys(status, contract.expectedStatusKeys, "status");
    for (const [shape, expected] of Object.entries(contract.expectedShapes)) {
      const path = statusShapePaths[shape];
      if (path) assertKeys(getPath(status, path), expected, path);
    }

    assert.equal(status.schema, "autodev-router-status-v2");
    assert.equal(status.router, "codex-model-router");
    assert.match(status.routerInstanceId, /^[0-9a-f-]{36}$/);
    assert.match(status.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof status.pid, "number");
    assertNoLeakedPaths(status);
    assert.equal(Object.hasOwn(status.telemetryPersistence, "file"), false);
    assert.equal(Object.hasOwn(status.concurrency, "configFile"), false);
    assert.equal(Object.hasOwn(status, "prompt"), false);
    assert.equal(Object.hasOwn(status, "codexTasks"), false);
    assert.deepEqual(Object.keys(status.providers).sort(), [...contract.expectedProviderNames].sort());
  } finally {
    reset();
  }
});

test("pending and populated Codex state snapshots preserve safe metadata and deterministic ids/timestamps", () => {
  reset();
  try {
    assert.deepEqual(getRouterStatus(FIXED_NOW).codexState, contract.pendingCodexState);

    setCodexStateSnapshotForTests(contract.populatedCodexStateInput);
    const populated = getRouterStatus(FIXED_NOW).codexState;
    assert.deepEqual(populated, contract.populatedCodexState);
    assert.equal(Object.hasOwn(populated.localTelemetry, "path"), false);
    assertNoLeakedPaths(populated);
    assert.equal(populated.recentThreads[0].id, "thread-001");
    assert.equal(populated.recentThreads[0].updatedAt, "2026-09-13T23:00:00.000Z");
  } finally {
    reset();
  }
});

test("provider rows and grouped spawn rows follow the frozen status dimensions", () => {
  reset();
  try {
    for (const operation of contract.spawnGrouping.operations) {
      if (operation.op === "bridgeRequest") {
        noteBridgeRequest(operation.requestId, operation);
      } else if (operation.op === "bridgeEvents") {
        ingestAgentEvents({ requestId: operation.requestId, events: operation.events });
      } else if (operation.op === "routerSession") {
        noteOrchestratorSession(operation.session, operation.provider);
      } else if (operation.op === "routerSpawn") {
        recordSubagentSpawn({
          mechanism: operation.mechanism,
          provider: orchestratorProviderForSession("session-router-001"),
          role: operation.role,
          tool: operation.tool,
        });
      }
    }

    const status = getRouterStatus(FIXED_NOW);
    assert.deepEqual(status.subagents.byMechanism, contract.spawnGrouping.byMechanism);
    assert.deepEqual(status.subagents.byProvider, contract.spawnGrouping.byProvider);
    assert.deepEqual(status.subagents.byRole, contract.spawnGrouping.byRole);
    assert.equal(status.subagents.total, contract.spawnGrouping.total);

    const grouped = new Map();
    for (const row of status.subagents.recent) {
      const key = [row.provider, row.mechanism, row.role, row.tool].join("\\0");
      const current = grouped.get(key) ?? {
        provider: row.provider,
        mechanism: row.mechanism,
        role: row.role,
        tool: row.tool,
        count: 0,
      };
      current.count += row.count ?? 1;
      grouped.set(key, current);
    }
    assert.deepEqual([...grouped.values()].sort((a, b) => b.count - a.count), contract.spawnGrouping.groupedRows);

    for (const provider of Object.values(status.providers)) {
      assertKeys(provider, contract.expectedShapes.provider, "provider row");
      assertKeys(provider.limits, contract.expectedShapes.providerLimits, "provider limits");
      assertKeys(provider.capabilities, contract.expectedShapes.providerCapabilities, "provider capabilities");
    }
  } finally {
    reset();
  }
});

test("status CLI keeps the byMechanism summary deterministic", async () => {
  reset();
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    noteBridgeRequest("req-cli-001", { provider: "claude", model: "sonnet", role: "orchestrator", workspace: "AutoDev" });
    ingestAgentEvents({
      requestId: "req-cli-001",
      events: [{ type: "subagent_spawn", tool: "Agent", role: "worker", count: 3 }],
    });
    noteOrchestratorSession("session-cli-001", "minimax");
    recordSubagentSpawn({
      mechanism: "router_alias",
      provider: orchestratorProviderForSession("session-cli-001"),
      role: "validator",
      tool: "multi_agent_v1.spawn",
    });

    const address = server.address();
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["src/cli/router-status.ts"], {
        cwd: new URL(".", ROOT),
        env: {
          ...process.env,
          CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
          CODEX_MODEL_ROUTER_PORT: String(address.port),
          CODEX_ROUTER_AUTH_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`status CLI exited ${code}: ${stderr}`)));
    });
    assert.match(output.stdout, new RegExp(escapeRegex(contract.spawnGrouping.cliSummary)));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    reset();
  }
});

test("dashboard source evaluates deterministic labels and renders its contract boundaries", async () => {
  reset();
  const dashboard = await readFile(dashboardPath, "utf8");
  try {
    const formatRecentTotalLabel = evaluateFunction(dashboard, "formatRecentTotalLabel");
    for (const scenario of contract.dashboard.recentTotalLabels) {
      assert.equal(formatRecentTotalLabel(scenario.recent, scenario.total), scenario.expected);
    }

    const shouldRenderTotals = evaluateFunction(dashboard, "shouldRenderTotals");
    assert.equal(shouldRenderTotals(0), false);
    assert.equal(shouldRenderTotals(1), false);
    assert.equal(shouldRenderTotals(2), true);
    assert.equal(shouldRenderTotals(null), false);

    const panels = [...dashboard.matchAll(/<dashboard-panel id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(panels, contract.dashboard.panels);
    for (const emptyState of contract.dashboard.emptyStates) assert.match(dashboard, new RegExp(escapeRegex(emptyState)));

    const spawnSection = dashboard.slice(dashboard.indexOf("// Spawn breakdown sub-panel"), dashboard.indexOf("// Spawn failures sub-panel"));
    assert.match(spawnSection, /const recentSpawns = spawnList\.reduce/);
    assert.match(spawnSection, /const totalSpawns = Number\(status\.subagents\?\.total \?\? 0\)/);
    assert.match(spawnSection, /spawnCoverageLabel/);
    assert.doesNotMatch(spawnSection, /Math\.max/);
    assert.doesNotMatch(spawnSection, /status\.subagents\?\.total \?\? spawnList\.reduce/);
    assert.match(spawnSection, /spawnTfoot\.innerHTML = shouldRenderTotals\(spawnList\.length\)/);
    assert.match(spawnSection, /\$\{spawnCoverageLabel\}/);

    assert.match(dashboard, /fetch\("\/status", \{ cache: "no-store", headers: \{ Accept: "application\/json" \} \}\)/);
    assert.match(dashboard, /setInterval\(refresh, 3000\)/);
    assert.match(dashboard, /Named tool telemetry is unavailable per-workspace/);
    assert.match(dashboard, /Named skill attribution is unavailable per-workspace/);
    assert.doesNotMatch(dashboard.slice(dashboard.indexOf('<table id="workspace-usage-table"'), dashboard.indexOf("<!-- 5. Skill Telemetry")), /<tfoot/);
  } finally {
    reset();
  }
});
