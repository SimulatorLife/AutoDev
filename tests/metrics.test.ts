import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import * as metrics from "../src/telemetry/github-metrics.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const agentPr = {
  title: "Agent: Reduce duplication",
  head: { ref: "mini-max/task-123" },
  labels: []
};

test("metrics identify agent PRs and provider invocation comments", () => {
  assert.equal(metrics.isAgentPull(agentPr), true);
  assert.equal(metrics.agentFromPull(agentPr), "mini-max");
  assert.deepEqual(
    metrics.parseInvocationComment(
      "**[🤖 mini-max]** Hi, I've received your request. https://github.com/SimulatorLife/AutoDev/actions/runs/123"
    ),
    { agent: "mini-max", runId: 123 }
  );
});

test("router dashboard exposes the component hierarchy and explicit workspace attribution states", async () => {
  const dashboard = (
    await readFile(
      path.join(root, "scripts", "codex-model-router-dashboard.html"),
      "utf8"
    )
  )
    .replaceAll(/\s+/g, " ")
    .replaceAll(/>\s+</g, "><");
  const panels = Array.from(
    dashboard.matchAll(/<dashboard-panel id="([^"]+)"/g),
    (match) => match[1]
  );
  assert.deepEqual(panels, [
    "panel-providers",
    "panel-orchestrator",
    "workspace-usage-section",
    "panel-skills",
    "panel-hooks",
    "panel-ops",
    "panel-codex-state",
    "panel-events"
  ]);
  assert.match(dashboard, /id="panel-codex-state"/);
  assert.match(dashboard, /codexState\.localTelemetry/);
  assert.match(dashboard, /codexState\.conversationThreads/);
  assert.match(dashboard, /toolResults\.executed/);
  assert.match(dashboard, /toolResults\.unattributed/);
  assert.match(dashboard, /bridgeEvents\.toolExecuted/);
  assert.match(dashboard, /bridgeEvents\.toolRequested/);
  assert.match(dashboard, /bridgeEvents\.toolUnavailable/);
  assert.match(dashboard, /bridgeEvents\.skillExposed/);
  assert.match(dashboard, /skills\?\.used\?\.total/);
  assert.match(dashboard, /skillContextsInjected/);
  assert.match(dashboard, /codex-state-tool-results-card/);
  assert.match(dashboard, /codex-state-tool-unattributed-card/);
  assert.match(dashboard, /codex-state-tbody/);
  assert.match(dashboard, /Executed</);
  assert.match(dashboard, /Skills exposed</);
  assert.match(dashboard, /no first-class events/);
  assert.match(
    dashboard,
    /<dashboard-panel id="panel-orchestrator"[\s\S]*?<sub-panel id="panel-spawn-breakdown"/
  );
  assert.match(
    dashboard,
    /<dashboard-panel id="panel-skills"[\s\S]*?<sub-panel id="panel-skill-context"/
  );
  assert.match(
    dashboard,
    /<dashboard-panel id="panel-ops"[\s\S]*?<sub-panel id="panel-native-metrics"/
  );
  assert.match(
    dashboard,
    /function normalizeWorkspaceNamedUsage\(raw, identityKeys\)/
  );
  assert.match(
    dashboard,
    /function renderWorkspaceNamedUsage\(rows, \{ unavailableLabel, emptyLabel \}\)/
  );
  assert.match(
    dashboard,
    /normalizeWorkspaceNamedUsage\(w\.byTool, \[\s*"tool",\s*"name"\s*\]\)/
  );
  assert.match(
    dashboard,
    /normalizeWorkspaceNamedUsage\(w\.bySkill, \[\s*"skill",\s*"name"\s*\]\)/
  );
  assert.match(
    dashboard,
    /normalizeWorkspaceNamedUsage\((?:w\.mcpUses \?\? )?w\.byMcp \?\? w\.mcpServers, \[\s*"server",\s*"name",\s*"mcp"\s*\]\)/
  );
  assert.match(
    dashboard,
    /if \(rows === null\) return `<div class="empty-state">\$\{escapeHtml\(unavailableLabel\)\}<\/div>`;/
  );
  assert.match(dashboard, /Named tool telemetry is unavailable per-workspace/);
  assert.match(
    dashboard,
    /Named skill attribution is unavailable per-workspace/
  );
  assert.match(
    dashboard,
    /No named tool calls observed for this workspace yet/
  );
  assert.match(
    dashboard,
    /No named skill uses observed for this workspace yet/
  );
  assert.match(dashboard, /MCP server telemetry is unavailable per-workspace/);
  assert.match(dashboard, /No MCP servers observed for this workspace yet/);
  assert.match(dashboard, /orchMcpCount/);
  assert.match(dashboard, /subMcpCount/);
  assert.match(
    dashboard,
    /<mini-stat label="MCP servers" value="\$\{orchMcpCount\}"><\/mini-stat>/
  );
  assert.match(
    dashboard,
    /<mini-stat label="MCP servers" value="\$\{subMcpCount\}"><\/mini-stat>/
  );
  assert.match(dashboard, /getModelMcpDetails/);
  assert.match(dashboard, /model-mcp-details/);
  assert.doesNotMatch(dashboard, /Tool calls \(response output\)/);
  assert.doesNotMatch(dashboard, /response-output tool-call count/);
  assert.doesNotMatch(dashboard, /OTLP-named runtime tool rows/);
  assert.doesNotMatch(
    dashboard,
    /OTLP-named runtime tool rows joined to this workspace/
  );
  assert.match(dashboard, /<th>Tool calls<\/th>/);
  assert.match(dashboard, /wsToolRows\.reduce\(/);
  assert.match(dashboard, /MCP servers/);
  assert.doesNotMatch(
    dashboard,
    /<(?:dashboard-panel|sub-panel)[^>]*(?:id="[^"]*mcp|title="[^"]*MCP)/i
  );
  assert.match(dashboard, /Routing priority/);
  assert.match(dashboard, /Errors &amp; cooldowns/);
  assert.match(dashboard, /formatRoutingPriority/);
  assert.match(dashboard, /formatEffectiveLimitsAndCooldowns/);
  assert.match(dashboard, /isDisabled/);
  assert.match(dashboard, /btn-provider-toggle/);
  assert.match(dashboard, /\/v1\/providers\//);
  assert.match(dashboard, /toggleProvider/);
});

test("router dashboard inline JavaScript has no unresolved identifiers", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const source = Array.from(
    rawDashboard.matchAll(/<script(?=[\s>])[^>]*>(.*?)<\/script>/gis),
    (match) => match[1]
  ).join("\n\n");
  const tempDir = await mkdtemp(path.join(tmpdir(), "autodev-dashboard-"));
  const sourceFile = path.join(tempDir, "dashboard.js");
  try {
    await writeFile(sourceFile, source, "utf8");
    const program = ts.createProgram([sourceFile], {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      skipLibCheck: true
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552
      )
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      );
    assert.deepEqual(
      diagnostics,
      [],
      `dashboard has unresolved identifiers: ${diagnostics.join("; ")}`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("router dashboard provider health panel renders routing priorities, limits, disabled state, and toggle controls", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(
    rawDashboard,
    /<dashboard-panel id="panel-providers"[^>]*title="Provider health"/
  );
  assert.match(rawDashboard, /<th>Routing priority<\/th>/);
  assert.match(rawDashboard, /<th>Errors &amp; cooldowns<\/th>/);
  assert.match(rawDashboard, /<th>Active<\/th>/);
  assert.doesNotMatch(rawDashboard, /<th>In-flight<\/th>/);
  assert.doesNotMatch(rawDashboard, /<th>Last failure<\/th>/);
  assert.match(rawDashboard, /<th>Control<\/th>/);

  const providerPanel =
    rawDashboard.match(
      /<dashboard-panel id="panel-providers"[\s\S]*?<\/dashboard-panel>/
    )?.[0] ?? "";
  const providerHeaders = (providerPanel.match(/<th>.*?<\/th>/g) ?? []).map(
    (h) => h.replaceAll(/<[^>]+>/g, "").trim()
  );
  assert.deepEqual(providerHeaders, [
    "Provider",
    "Routing priority",
    "Models",
    "Status",
    "Errors &amp; cooldowns",
    "Active",
    "Avg turn",
    "Outcomes",
    "Control"
  ]);
  assert.match(
    rawDashboard,
    /<td colspan="9" class="dim" style="text-align:center">Loading providers\.\.\.<\/td>/
  );
  assert.match(
    rawDashboard,
    /<td colspan="9" class="dim" style="text-align:center">No providers configured<\/td>/
  );
  const rowTemplateMatch = rawDashboard.match(
    /providersTbody\.innerHTML = providersEntries\.map\([\s\S]*?return `<tr[\s\S]*?<\/tr>`;/
  );
  assert.ok(rowTemplateMatch, "provider row template must be present");
  const tdCount = (rowTemplateMatch[0].match(/<td\b/g) ?? []).length;
  assert.equal(
    tdCount,
    9,
    "provider row template should have exactly 9 td cells to align with headers"
  );
  assert.doesNotMatch(
    rowTemplateMatch[0],
    /p\.inFlightRequests/,
    "provider row template must not include inFlightRequests cell"
  );
  assert.doesNotMatch(
    rowTemplateMatch[0],
    /failureHtml/,
    "provider row template must not include failureHtml cell"
  );
  assert.match(rawDashboard, /function formatRoutingPriority\(/);
  assert.match(
    rawDashboard,
    /formatRoutingPriority\(providerName, p, status\)/
  );
  assert.match(rawDashboard, /function formatEffectiveLimitsAndCooldowns\(/);
  assert.match(rawDashboard, /formatEffectiveLimitsAndCooldowns\(p\)/);
  assert.match(rawDashboard, /cooldownRemainingMs/);
  assert.match(rawDashboard, /cooldownKind/);
  assert.match(rawDashboard, /const isDisabled = Boolean\(/);
  assert.match(
    rawDashboard,
    /statusLabel = isDisabled \? "disabled" : p\.status/
  );
  assert.match(rawDashboard, /provider-disabled/);
  assert.match(rawDashboard, /class="btn-provider-toggle"/);
  assert.match(
    rawDashboard,
    /fetch\(`\/v1\/providers\/\$\{encodeURIComponent\(providerName\)\}`,\s*\{[^}]*method:\s*"POST"/s
  );
  assert.match(rawDashboard, /pendingProviderToggles\.has\(providerName\)/);
  assert.match(rawDashboard, /buttonEl\.disabled = true/);
  assert.match(rawDashboard, /await refresh\(\)/);
  assert.match(rawDashboard, /errorEl\.textContent = err\.message/);
  assert.match(
    rawDashboard,
    /\.btn-provider-toggle\s*\{[^}]*border-radius:\s*var\(--radius-pill\);/s
  );
  assert.match(rawDashboard, /\.btn-provider-toggle::after\s*\{/);
  assert.match(
    rawDashboard,
    /\.btn-provider-toggle\[data-action="disable"\][^}]*background:\s*#34c759;/s
  );
  assert.match(
    rawDashboard,
    /\.btn-provider-toggle\[data-action="enable"\][^}]*background:\s*#48484a;/s
  );
  assert.match(
    rawDashboard,
    /<button type="button" class="btn-provider-toggle"[^>]*role="switch"[^>]*aria-checked="\$\{!(?:isDisabled)\}"[^>]*><\/button>/
  );
  assert.doesNotMatch(rawDashboard, /buttonEl\.textContent/);
  assert.doesNotMatch(rawDashboard, /Enabling…/);
  assert.doesNotMatch(rawDashboard, /Disabling…/);
});

test("dashboard provider health excludes synthetic and unattributed provider rows", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(
    rawDashboard,
    /const providersEntries = Object\.entries\(status\.providers \?\? \{\}\)/
  );
  assert.match(rawDashboard, /providerName !== "unattributed"/);
  assert.match(rawDashboard, /p\.synthetic !== true/);
  assert.match(
    rawDashboard,
    /const configuredProvidersEntries = providersEntries;/
  );
});

test("router dashboard and status CLI contract separates live agent activity from in-flight requests and documents lifecycle TTL", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(rawDashboard, /function getProviderLiveActivity\(/);
  assert.match(rawDashboard, /function isProviderLiveActive\(/);
  assert.match(
    rawDashboard,
    /window\.getProviderLiveActivity = getProviderLiveActivity/
  );
  assert.match(
    rawDashboard,
    /window\.isProviderLiveActive = isProviderLiveActive/
  );
  assert.match(rawDashboard, /return Number\(p\?\.active \?\? 0\)/);
  assert.match(rawDashboard, /provider-active/);
  assert.match(
    rawDashboard,
    /<status-badge \$\{isActive \? 'active=""' : ''\}>\$\{displayActive\}<\/status-badge>/
  );
  assert.match(
    rawDashboard,
    /const avgInitDur = initSamples > 0 \? initSum \/ initSamples : 0/
  );
  assert.match(rawDashboard, /status\.inFlightRequests/);
  assert.match(
    rawDashboard,
    /<span>In-flight requests<\/span><span>\$\{inFlightRequests\}<\/span>/
  );

  const statusCli = await readFile(
    path.join(root, "src", "cli", "router-status.ts"),
    "utf8"
  );
  assert.match(statusCli, /Active\s+In-Flight/);
  assert.match(statusCli, /getProviderLiveActivity/);
  assert.match(statusCli, /getProviderInFlight/);
  assert.match(statusCli, /in-flight requests \$\{totalInFlight\}/);

  const metricsDoc = await readFile(
    path.join(root, "docs", "metrics-dashboard.md"),
    "utf8"
  );
  assert.match(
    metricsDoc,
    /Live agent activity vs\. in-flight requests transport diagnostics/
  );
  assert.match(
    metricsDoc,
    /Lifecycle event contract and configurable freshness TTL/
  );
  assert.match(metricsDoc, /CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS/);

  const routingDoc = await readFile(
    path.join(root, "docs", "provider-routing.md"),
    "utf8"
  );
  assert.match(
    routingDoc,
    /Live agent activity vs\. in-flight requests transport diagnostics/
  );
  assert.match(routingDoc, /Lifecycle event contract and configurable TTL/);
  assert.match(routingDoc, /CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS/);
});

test("metrics dashboard renders requested counters and recent links", () => {
  const body = metrics.renderDashboard({
    schema: "autodev-metrics-v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    lookbackDays: 90,
    since: "2025-10-03",
    repositories: ["SimulatorLife/AutoDev"],
    totals: {
      agentPrsRaised: 2,
      agentPrsMerged: 1,
      agentInvokes: 3,
      agentInvokesSucceeded: 2,
      agentInvokesFailed: 1,
      staleEmptyPrsClosed: 4
    },
    perRepository: {
      "SimulatorLife/AutoDev": {
        agentPrsRaised: 2,
        agentPrsMerged: 1,
        agentInvokes: { total: 3, succeeded: 2, failed: 1, other: 0 },
        staleEmptyPrsClosed: 4
      }
    },
    perAgent: { "mini-max": { total: 3, succeeded: 2, failed: 1, other: 0 } },
    recentPrs: [
      {
        repository: "SimulatorLife/AutoDev",
        number: 7,
        title: "Agent: Example",
        url: "https://github.com/SimulatorLife/AutoDev/pull/7",
        agent: "mini-max",
        state: "open",
        mergedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  });
  assert.match(body, /Lookback window: 90 days/);
  assert.match(body, /Provider-run per-repository attribution/);
  assert.match(body, /Agent PR-and-ping PRs raised/);
  assert.match(body, /Stale-empty PRs closed/);
  assert.match(body, /mini-max/);
  assert.match(body, /AutoDev\/pull\/7/);
  assert.match(body, /\| PR \| Title \| Repository \| Created \(EST5EDT\)/);
  assert.match(body, /2025-12-31 19:00 EST/);
});

test("metrics workflow publishes an issue dashboard and artifact", async () => {
  const source = await readFile(
    path.join(root, ".github", "workflows", "metrics-dashboard.yml"),
    "utf8"
  );
  assert.match(source, /schedule:/);
  assert.match(source, /lookback_days:[\s\S]*default: 90[\s\S]*type: number/);
  assert.match(source, /actions\/github-script@v8/);
  assert.match(
    await readFile(
      path.join(root, "src", "telemetry", "github-metrics.ts"),
      "utf8"
    ),
    /listWorkflowRuns/
  );
  assert.match(source, /issues\.update/);
  assert.match(source, /autodev-metrics-dashboard-v1/);
  assert.match(source, /upload-artifact@v4/);
  assert.match(source, /metrics-snapshot\.json/);
});

test("router dashboard workspace table derives Tool calls from byTool normalization and handles unavailable states", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.doesNotMatch(rawDashboard, /OTLP-named runtime tool rows/);
  assert.doesNotMatch(rawDashboard, /response-output tool-call count/);
  assert.doesNotMatch(rawDashboard, /Tool calls \(response output\)/);
  assert.match(rawDashboard, /<th>Tool calls<\/th>/);

  const match = rawDashboard.match(
    /function normalizeWorkspaceNamedUsage\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    match,
    "normalizeWorkspaceNamedUsage should be present in dashboard script"
  );
  const normalizeWorkspaceNamedUsage = new Function(
    `${match[0]}; return normalizeWorkspaceNamedUsage;`
  )() as (
    raw: unknown,
    identityKeys: string[]
  ) => Array<{ name: string; count: number }> | null;

  assert.equal(normalizeWorkspaceNamedUsage(null, ["tool", "name"]), null);
  assert.equal(normalizeWorkspaceNamedUsage(undefined, ["tool", "name"]), null);

  const emptyRows = normalizeWorkspaceNamedUsage([], ["tool", "name"]);
  assert.deepEqual(emptyRows, []);
  assert.equal(
    (emptyRows ?? []).reduce(
      (sum: number, r: { count?: number }) => sum + Number(r.count ?? 0),
      0
    ),
    0
  );

  const arrayRows = normalizeWorkspaceNamedUsage(
    [
      { tool: "bash", count: 5 },
      { tool: "read_file", count: 2 }
    ],
    ["tool", "name"]
  );
  assert.equal(
    arrayRows?.reduce((sum, r) => sum + Number(r.count ?? 0), 0),
    7
  );

  const objectRows = normalizeWorkspaceNamedUsage(
    {
      bash: { count: 4 },
      exec_command: { uses: 3 }
    },
    ["tool", "name"]
  );
  assert.equal(
    objectRows?.reduce((sum, r) => sum + Number(r.count ?? 0), 0),
    7
  );
});

test("router dashboard combines skill usage and exposure into one Skills section showing uses / exposed while keeping semantics distinct", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(rawDashboard, /<th>Skill uses \/ exposed<\/th>/);
  assert.match(
    rawDashboard,
    /normalizeWorkspaceNamedUsage\(w\.bySkill, \[\s*"skill",\s*"name"\s*\]\)/
  );
  assert.match(
    rawDashboard,
    /normalizeWorkspaceNamedUsage\(w\.bridgeSkills, \[\s*"skill",\s*"name"\s*\]\)/
  );
  assert.match(rawDashboard, /<h2>Skills<\/h2>/);
  assert.doesNotMatch(rawDashboard, /<h2>Skill usage<\/h2>/);
  assert.doesNotMatch(rawDashboard, /<h2>Skills exposed<\/h2>/);
  assert.match(
    rawDashboard,
    /Named skill attribution is unavailable per-workspace/
  );
  assert.match(
    rawDashboard,
    /No named skill uses observed for this workspace yet/
  );

  const escapeMatch = rawDashboard.match(
    /function escapeHtml\([\s\S]*?\n {4}\}/
  );
  assert.ok(escapeMatch, "escapeHtml should be present in dashboard script");
  const renderSkillsMatch = rawDashboard.match(
    /function renderWorkspaceSkills\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    renderSkillsMatch,
    "renderWorkspaceSkills should be present in dashboard script"
  );
  const summarizeSkillsMatch = rawDashboard.match(
    /function summarizeWorkspaceSkills\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    summarizeSkillsMatch,
    "summarizeWorkspaceSkills should be present in dashboard script"
  );
  const normalizeMatch = rawDashboard.match(
    /function normalizeWorkspaceNamedUsage\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    normalizeMatch,
    "normalizeWorkspaceNamedUsage should be present in dashboard script"
  );

  const fnScope = `${escapeMatch[0]}; ${normalizeMatch[0]}; ${summarizeSkillsMatch[0]}; ${renderSkillsMatch[0]}; return { normalizeWorkspaceNamedUsage, summarizeWorkspaceSkills, renderWorkspaceSkills };`;
  const {
    normalizeWorkspaceNamedUsage,
    summarizeWorkspaceSkills,
    renderWorkspaceSkills
  } = new Function(fnScope)() as {
    normalizeWorkspaceNamedUsage: (
      raw: unknown,
      identityKeys: string[]
    ) => Array<{ name: string; count: number }> | null;
    summarizeWorkspaceSkills: (
      uses: unknown,
      exposed: unknown
    ) => { uses: number | null; exposed: number | null };
    renderWorkspaceSkills: (uses: unknown, exposed: unknown) => string;
  };

  const racingGame = {
    skillUses: 0,
    bySkill: [],
    bridgeSkills: [
      { skill: "ccc", count: 16 },
      { skill: "lsp-mcp-server", count: 16 },
      { skill: "orchestration", count: 5 }
    ]
  };
  const wsSkillRows = normalizeWorkspaceNamedUsage(racingGame.bySkill, [
    "skill",
    "name"
  ]);
  const wsExposedSkillRows = normalizeWorkspaceNamedUsage(
    racingGame.bridgeSkills,
    ["skill", "name"]
  );
  assert.deepEqual(wsSkillRows, []);
  assert.deepEqual(
    wsExposedSkillRows?.map((r) => r.name),
    ["ccc", "lsp-mcp-server", "orchestration"]
  );

  const racingGameSummary = summarizeWorkspaceSkills(
    wsSkillRows,
    wsExposedSkillRows
  );
  assert.deepEqual(racingGameSummary, { uses: 0, exposed: 37 });
  const racingGameHtml = renderWorkspaceSkills(wsSkillRows, wsExposedSkillRows);
  assert.match(racingGameHtml, /label="ccc"/);
  assert.match(racingGameHtml, /label="lsp-mcp-server"/);
  assert.match(racingGameHtml, /label="orchestration"/);
  assert.match(racingGameHtml, /value="0 \/ 16"/);
  assert.match(racingGameHtml, /value="0 \/ 5"/);

  assert.match(
    rawDashboard,
    /const wsSkillSummary = summarizeWorkspaceSkills\(wsSkillRows, wsExposedSkillRows\)/
  );
  assert.match(
    rawDashboard,
    /<td>\$\{wsSkillUsesText\} \/ \$\{wsSkillExposedText\}<\/td>/
  );

  const lspMcpServer = {
    bySkill: [{ skill: "lsp-mcp-server", count: 5 }],
    bridgeSkills: [{ skill: "lsp-mcp-server", count: 10 }]
  };
  const lspSkillRows = normalizeWorkspaceNamedUsage(lspMcpServer.bySkill, [
    "skill",
    "name"
  ]);
  const lspExposedRows = normalizeWorkspaceNamedUsage(
    lspMcpServer.bridgeSkills,
    ["skill", "name"]
  );
  const lspSummary = summarizeWorkspaceSkills(lspSkillRows, lspExposedRows);
  assert.deepEqual(lspSummary, { uses: 5, exposed: 10 });
  const lspHtml = renderWorkspaceSkills(lspSkillRows, lspExposedRows);
  assert.match(lspHtml, /label="lsp-mcp-server"/);
  assert.match(lspHtml, /value="5 \/ 10"/);

  assert.equal(
    renderWorkspaceSkills(null, null),
    '<div class="empty-state">Named skill attribution is unavailable per-workspace</div>'
  );

  const unavailUsesSummary = summarizeWorkspaceSkills(null, wsExposedSkillRows);
  assert.deepEqual(unavailUsesSummary, { uses: null, exposed: 37 });
  const unavailUsesHtml = renderWorkspaceSkills(null, wsExposedSkillRows);
  assert.match(unavailUsesHtml, /label="orchestration"/);
  assert.match(unavailUsesHtml, /value="— \/ 5"/);

  const unavailExposedSummary = summarizeWorkspaceSkills(lspSkillRows, null);
  assert.deepEqual(unavailExposedSummary, { uses: 5, exposed: null });
  const unavailExposedHtml = renderWorkspaceSkills(lspSkillRows, null);
  assert.match(unavailExposedHtml, /label="lsp-mcp-server"/);
  assert.match(unavailExposedHtml, /value="5 \/ —"/);

  assert.equal(
    renderWorkspaceSkills([], []),
    '<div class="empty-state">No named skill uses observed for this workspace yet</div>'
  );

  const metricsDoc = await readFile(
    path.join(root, "docs", "metrics-dashboard.md"),
    "utf8"
  );
  assert.match(metricsDoc, /combined \*\*"Skills"\*\* section/);
  assert.match(metricsDoc, /uses \/ exposed/);
  assert.match(metricsDoc, /\*\*Skill uses \/ exposed\*\*/);

  const routingDoc = await readFile(
    path.join(root, "docs", "provider-routing.md"),
    "utf8"
  );
  assert.match(routingDoc, /"Skills" section as `uses \/ exposed`/);
  assert.match(routingDoc, /Skill uses \/ exposed/);
});

test("router dashboard documents shell cat-style SKILL.md reads as ordinary skill uses", async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(
    dashboard,
    /shell command[\s\S]*?<code>cat<\/code>[\s\S]*?skill_used<\/code>\/\s*<code>skill_read<\/code>/
  );
  assert.doesNotMatch(
    dashboard,
    /shellReadUses|shell_read_total|panel-shell-read/
  );

  const metricsDoc = await readFile(
    path.join(root, "docs", "metrics-dashboard.md"),
    "utf8"
  );
  assert.match(metricsDoc, /Shell commands such as `cat \/\.\.\.\/SKILL\.md`/);
  assert.match(metricsDoc, /there is no separate shell-read metric/);

  const routingDoc = await readFile(
    path.join(root, "docs", "provider-routing.md"),
    "utf8"
  );
  assert.match(routingDoc, /Shell commands such as `cat \/\.\.\.\/SKILL\.md`/);
  assert.match(routingDoc, /identical `source: skill_read` event/);
});

test("router dashboard falls back to bridgeTools when OTLP named-tool rows are unavailable or empty, without double-counting", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  assert.match(
    rawDashboard,
    /normalizeWorkspaceNamedUsage\(w\.byTool, \[\s*"tool",\s*"name"\s*\]\)/
  );
  assert.match(
    rawDashboard,
    /normalizeWorkspaceNamedUsage\(w\.bridgeTools, \[\s*"tool",\s*"name"\s*\]\)/
  );
  assert.match(
    rawDashboard,
    /resolveWorkspaceToolRows\(otlpToolRows, bridgeToolRows\)/
  );

  const resolverMatch = rawDashboard.match(
    /function resolveWorkspaceToolRows\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    resolverMatch,
    "resolveWorkspaceToolRows should be present in dashboard script"
  );
  const resolveWorkspaceToolRows = new Function(
    `${resolverMatch[0]}; return resolveWorkspaceToolRows;`
  )() as (
    otlp: unknown,
    bridge: unknown
  ) => {
    rows: Array<{ name: string; count: number }> | null;
    usingBridgeToolFallback: boolean;
  };

  const normalizeMatch = rawDashboard.match(
    /function normalizeWorkspaceNamedUsage\([\s\S]*?\n {4}\}/
  );
  assert.ok(normalizeMatch);
  const normalizeWorkspaceNamedUsage = new Function(
    `${normalizeMatch[0]}; return normalizeWorkspaceNamedUsage;`
  )() as (
    raw: unknown,
    identityKeys: string[]
  ) => Array<{ name: string; count: number }> | null;

  const otlpAbsent = normalizeWorkspaceNamedUsage(undefined, ["tool", "name"]);
  const bridgeRows = normalizeWorkspaceNamedUsage(
    [
      {
        tool: "apply_patch",
        server: "codex-builtin",
        count: 2,
        byStatus: { ok: 1, error: 1 }
      }
    ],
    ["tool", "name"]
  );
  const fallback = resolveWorkspaceToolRows(otlpAbsent, bridgeRows);
  assert.equal(fallback.usingBridgeToolFallback, true);
  assert.deepEqual(
    fallback.rows?.map((r) => ({ name: r.name, count: r.count })),
    [{ name: "apply_patch", count: 2 }]
  );

  const otlpEmpty = normalizeWorkspaceNamedUsage([], ["tool", "name"]);
  const fallbackFromEmpty = resolveWorkspaceToolRows(otlpEmpty, bridgeRows);
  assert.equal(fallbackFromEmpty.usingBridgeToolFallback, true);
  assert.deepEqual(
    fallbackFromEmpty.rows?.map((r) => r.name),
    ["apply_patch"]
  );

  const otlpPresent = normalizeWorkspaceNamedUsage(
    [{ tool: "apply_patch", count: 5 }],
    ["tool", "name"]
  );
  const noFallback = resolveWorkspaceToolRows(otlpPresent, bridgeRows);
  assert.equal(noFallback.usingBridgeToolFallback, false);
  assert.deepEqual(
    noFallback.rows?.map((r) => ({ name: r.name, count: r.count })),
    [{ name: "apply_patch", count: 5 }]
  );

  const bothAbsent = resolveWorkspaceToolRows(null, null);
  assert.equal(bothAbsent.rows, null);
  assert.equal(bothAbsent.usingBridgeToolFallback, false);
});

test("dashboard hides totals rows for sections with 0 or 1 populated row and shows the five supported footers for 2+ via the shared shouldRenderTotals helper", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const match = rawDashboard.match(
    /function shouldRenderTotals\([\s\S]*?\n {4}\}/
  );
  assert.ok(match, "shouldRenderTotals should be present in dashboard script");
  const shouldRenderTotals = new Function(
    `${match[0]}; return shouldRenderTotals;`
  )() as (count: unknown) => boolean;

  assert.equal(shouldRenderTotals(0), false);
  assert.equal(shouldRenderTotals(1), false);
  assert.equal(shouldRenderTotals(2), true);
  assert.equal(shouldRenderTotals(5), true);
  assert.equal(shouldRenderTotals(null), false);
  assert.equal(shouldRenderTotals(undefined), false);
  assert.equal(shouldRenderTotals(""), false);
  assert.equal(shouldRenderTotals("1"), false);
  assert.equal(shouldRenderTotals("2"), true);

  assert.match(
    rawDashboard,
    /spawnTfoot\.innerHTML = shouldRenderTotals\(spawnList\.length\)/
  );
  assert.match(
    rawDashboard,
    /failuresTfoot\.innerHTML = shouldRenderTotals\(byReason\.length\)/
  );
  assert.match(
    rawDashboard,
    /skillsTfoot\.innerHTML = shouldRenderTotals\(sortedSkills\.length\)/
  );
  assert.match(
    rawDashboard,
    /hooksTfoot\.innerHTML = shouldRenderTotals\(rows\.length\)/
  );
  assert.match(
    rawDashboard,
    /metricsTfoot\.innerHTML = shouldRenderTotals\(metricsList\.length\)/
  );

  const totalsHeaderCount = (rawDashboard.match(/<th>Totals<\/th>/g) ?? [])
    .length;
  assert.equal(totalsHeaderCount, 5);
  const workspaceTable = rawDashboard.match(
    /<table id="workspace-usage-table">[\s\S]*?<\/table>/
  )?.[0];
  assert.ok(workspaceTable, "workspace usage table should remain present");
  assert.doesNotMatch(workspaceTable, /<tfoot/);

  for (const footerId of [
    "spawnTfoot",
    "failuresTfoot",
    "skillsTfoot",
    "hooksTfoot",
    "metricsTfoot"
  ]) {
    const emptyBranch = rawDashboard.match(
      new RegExp(String.raw`\b${footerId}\.innerHTML = "";`)
    );
    assert.ok(
      emptyBranch,
      `empty/unavailable branch for ${footerId} must still clear the footer before any totals render`
    );
    const populatedBranch = rawDashboard.match(
      new RegExp(String.raw`\b${footerId}\.innerHTML = shouldRenderTotals\(`)
    );
    assert.ok(
      populatedBranch,
      `populated branch for ${footerId} must gate the totals render on shouldRenderTotals`
    );
  }

  const metricsDoc = await readFile(
    path.join(root, "docs", "metrics-dashboard.md"),
    "utf8"
  );
  assert.match(
    metricsDoc,
    /Totals footers are shown only when the section has at least 2 populated,\s*non-total data rows/
  );
  assert.match(metricsDoc, /loading\/placeholder\/empty colspan rows/);
});

test("dashboard counts active workspaces from live activity states and excludes unattributed slots", async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const match = dashboard.match(
    /function countActiveWorkspaces\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    match,
    "countActiveWorkspaces should be present in dashboard script"
  );
  const countActiveWorkspaces = new Function(
    `${match[0]}; return countActiveWorkspaces;`
  )() as (status: unknown) => number;

  assert.equal(
    countActiveWorkspaces({
      agents: {
        schema: "autodev-agent-status-v1",
        canonicalLiveCount: 3,
        liveByWorkspace: {
          AutoDev: 1,
          "codex-runtime": 1,
          unattributed: 1,
          unknown: 1
        }
      }
    }),
    2
  );
  assert.equal(
    countActiveWorkspaces({
      agents: {
        schema: "autodev-agent-status-v1",
        canonicalLiveCount: 0,
        liveByWorkspace: {}
      }
    }),
    0
  );
  assert.throws(
    () => countActiveWorkspaces({}),
    /status.agents.liveByWorkspace/
  );
});

test("dashboard KPI agent total uses the canonical live-agent count and never maxes it against unrelated counters", async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const kpiSection = dashboard.match(
    /function computeKpiAgentTotals\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    kpiSection,
    "computeKpiAgentTotals should be present in dashboard script"
  );
  assert.doesNotMatch(kpiSection[0], /Math\.max/);
  assert.doesNotMatch(kpiSection[0], /activeSubagentThreads/);
  assert.doesNotMatch(kpiSection[0], /activeSessions/);
  assert.doesNotMatch(kpiSection[0], /providerActiveTotal/);
  assert.match(kpiSection[0], /agents\.schema/);
  assert.match(kpiSection[0], /canonicalLiveCount/);

  const countMatch = dashboard.match(
    /function countActiveWorkspaces\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    countMatch,
    "countActiveWorkspaces should be present in dashboard script"
  );
  const computeKpiAgentTotals = new Function(
    `${countMatch[0]}; ${kpiSection[0]}; return computeKpiAgentTotals;`
  )() as (status: unknown) => {
    totalActive: number;
    orchActive: number;
    subActive: number;
    unattributedActive: number;
    activeWorkspaces: number;
  };

  const oneSubagentOneWorkspaceStatus = {
    agents: {
      schema: "autodev-agent-status-v1",
      canonicalLiveCount: 2,
      liveByRole: {
        orchestrator: 1,
        worker: 1
      },
      liveByWorkspace: {
        AutoDev: 2
      }
    },
    providers: {
      codex: { active: 4 }
    },
    concurrency: {
      activeSubagentThreads: 9,
      activeSessions: 9
    }
  };
  assert.deepEqual(computeKpiAgentTotals(oneSubagentOneWorkspaceStatus), {
    totalActive: 2,
    orchActive: 1,
    subActive: 1,
    unattributedActive: 0,
    activeWorkspaces: 1
  });

  assert.throws(
    () =>
      computeKpiAgentTotals({
        usage: { totals: { active: 1 }, byRole: {}, byWorkspace: {} },
        providers: { codex: { active: 4 } }
      }),
    /status\.agents/
  );

  assert.match(dashboard, /workspaces with active agents/);
});

test('dashboard keeps role-less ("unattributed") activity explicit instead of guessing a role', async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const kpiSection = dashboard.match(
    /function computeKpiAgentTotals\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    kpiSection,
    "computeKpiAgentTotals should be present in dashboard script"
  );
  const countMatch = dashboard.match(
    /function countActiveWorkspaces\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    countMatch,
    "countActiveWorkspaces should be present in dashboard script"
  );
  const computeKpiAgentTotals = new Function(
    `${countMatch[0]}; ${kpiSection[0]}; return computeKpiAgentTotals;`
  )() as (status: unknown) => {
    totalActive: number;
    orchActive: number;
    subActive: number;
    unattributedActive: number;
    activeWorkspaces: number;
  };

  const status = {
    agents: {
      schema: "autodev-agent-status-v1",
      canonicalLiveCount: 3,
      liveByRole: {
        orchestrator: 1,
        unattributed: 2
      },
      liveByWorkspace: {}
    }
  };
  const totals = computeKpiAgentTotals(status);
  assert.deepEqual(totals, {
    totalActive: 3,
    orchActive: 1,
    subActive: 0,
    unattributedActive: 2,
    activeWorkspaces: 0
  });
  assert.equal(
    totals.orchActive + totals.subActive + totals.unattributedActive,
    totals.totalActive
  );

  assert.doesNotMatch(
    kpiSection[0],
    /orchRole\s*=\s*status\?\.agents\?\.liveByRole\?\.unattributed/
  );
  assert.doesNotMatch(
    dashboard,
    /byRole\?\.orchestrator \?\? status\.usage\?\.byRole\?\.unattributed/
  );
  assert.match(dashboard, /if \(role === "orchestrator"\) continue;/);
  assert.match(dashboard, /unattributedActive/);
  assert.match(dashboard, /Unattributed/);
});

test("dashboard provider active totals derive directly from the canonical per-provider active field, with no Math.max floor", async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const activeReqSumMatch = dashboard.match(
    /const activeReqSum = providersEntries\.reduce\([^;]*\);/
  );
  assert.ok(
    activeReqSumMatch,
    "activeReqSum computation should be present in dashboard script"
  );
  assert.doesNotMatch(activeReqSumMatch[0], /Math\.max/);

  const displayActiveMatch = dashboard.match(/const displayActive = [^;]*;/);
  assert.ok(
    displayActiveMatch,
    "displayActive computation should be present in dashboard script"
  );
  assert.doesNotMatch(displayActiveMatch[0], /Math\.max/);
  assert.match(displayActiveMatch[0], /const displayActive = liveActive;/);

  const providersEntries: Array<[string, { active?: number }]> = [
    ["codex", { active: 2 }],
    ["anthropic", { active: 0 }],
    ["openai", { active: 1 }]
  ];
  const getProviderLiveActivity = (p?: { active?: number }): number =>
    Number(p?.active ?? 0);
  const activeReqSum = providersEntries.reduce(
    (sum, [, p]) => sum + getProviderLiveActivity(p),
    0
  );
  assert.equal(activeReqSum, 3);
});

test("dashboard workspace usage rows read the canonical per-workspace active field without a Math.max floor", async () => {
  const dashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const activeDeclMatch = dashboard.match(
    /const active = Number\(w\.active \?\? 0\);/
  );
  assert.ok(
    activeDeclMatch,
    "workspace row active value should be read directly off w.active"
  );

  const rowBadgeMatch = dashboard.match(
    /<td><status-badge \$\{active > 0 [^<]*<\/status-badge><\/td>/
  );
  assert.ok(
    rowBadgeMatch,
    "workspace row badge should render the unfloored per-row active value"
  );
  assert.doesNotMatch(rowBadgeMatch[0], /Math\.max/);

  const byWorkspace: Record<string, { active: number }> = {
    AutoDev: { active: 2 },
    "codex-runtime": { active: 0 },
    unattributed: { active: 1 }
  };
  const renderedActive = Object.values(byWorkspace).map((w) =>
    Number(w.active ?? 0)
  );
  assert.deepEqual(renderedActive, [2, 0, 1]);
});

test("router dashboard renders workspace MCP servers with confirmed uses and exposure rows", async () => {
  const rawDashboard = await readFile(
    path.join(root, "scripts", "codex-model-router-dashboard.html"),
    "utf8"
  );
  const escapeMatch = rawDashboard.match(
    /function escapeHtml\([\s\S]*?\n {4}\}/
  );
  assert.ok(escapeMatch, "escapeHtml should be present in dashboard script");
  const renderMcpMatch = rawDashboard.match(
    /function renderWorkspaceMcp\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    renderMcpMatch,
    "renderWorkspaceMcp should be present in dashboard script"
  );
  const normalizeMatch = rawDashboard.match(
    /function normalizeWorkspaceNamedUsage\([\s\S]*?\n {4}\}/
  );
  assert.ok(
    normalizeMatch,
    "normalizeWorkspaceNamedUsage should be present in dashboard script"
  );

  const fnScope = `${escapeMatch[0]}; ${normalizeMatch[0]}; ${renderMcpMatch[0]}; return { normalizeWorkspaceNamedUsage, renderWorkspaceMcp };`;
  const { normalizeWorkspaceNamedUsage, renderWorkspaceMcp } = new Function(
    fnScope
  )() as {
    normalizeWorkspaceNamedUsage: (
      raw: unknown,
      identityKeys: string[]
    ) => Array<{ name: string; count: number }> | null;
    renderWorkspaceMcp: (uses: unknown, exposed: unknown) => string;
  };

  const ws = {
    mcpUses: [{ server: "playwright", count: 1 }],
    mcpExposed: [
      { server: "playwright", count: 2 },
      { server: "lsp", count: 1 }
    ]
  };
  const wsMcpRows = normalizeWorkspaceNamedUsage(ws.mcpUses, [
    "server",
    "name",
    "mcp"
  ]);
  const wsExposedMcpRows = normalizeWorkspaceNamedUsage(ws.mcpExposed, [
    "server",
    "name",
    "mcp"
  ]);
  assert.deepEqual(
    wsMcpRows?.map((r) => ({ name: r.name, count: r.count })),
    [{ name: "playwright", count: 1 }]
  );
  assert.deepEqual(
    wsExposedMcpRows?.map((r) => ({ name: r.name, count: r.count })),
    [
      { name: "playwright", count: 2 },
      { name: "lsp", count: 1 }
    ]
  );

  const html = renderWorkspaceMcp(wsMcpRows, wsExposedMcpRows);
  assert.match(html, /label="playwright"/);
  assert.match(html, /value="1 \/ 2"/);
  assert.match(html, /label="lsp"/);
  assert.match(html, /value="0 \/ 1"/);

  assert.equal(
    renderWorkspaceMcp(null, null),
    '<div class="empty-state">MCP server telemetry is unavailable per-workspace</div>'
  );

  assert.equal(
    renderWorkspaceMcp([], []),
    '<div class="empty-state">No MCP servers observed for this workspace yet</div>'
  );

  const legacyHtml = renderWorkspaceMcp(wsMcpRows, null);
  assert.match(legacyHtml, /label="playwright"/);
  assert.match(legacyHtml, /value="1"/);
});
