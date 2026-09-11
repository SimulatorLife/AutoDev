import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const metrics = require(path.join(root, 'scripts', 'autodev-metrics.cjs'));

const agentPr = { title: 'Agent: Reduce duplication', head: { ref: 'mini-max/task-123' }, labels: [] };

test('metrics identify agent PRs and provider invocation comments', () => {
  assert.equal(metrics.isAgentPull(agentPr), true);
  assert.equal(metrics.agentFromPull(agentPr), 'mini-max');
  assert.deepEqual(metrics.parseInvocationComment('**[🤖 mini-max]** Hi, I\'ve received your request. https://github.com/SimulatorLife/AutoDev/actions/runs/123'), { agent: 'mini-max', runId: 123 });
});

test('router dashboard exposes the component hierarchy and explicit workspace attribution states', async () => {
  const dashboard = (await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8'))
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><');
  const panels = [...dashboard.matchAll(/<dashboard-panel id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, [
    'panel-providers',
    'panel-orchestrator',
    'workspace-usage-section',
    'panel-skills',
    'panel-hooks',
    'panel-ops',
    'panel-codex-state',
    'panel-events',
  ]);
  // New panel surfaces local state DB status, executed/unattributed tool result
  // coverage, and the per-workspace first-class event coverage. The renderer
  // treats absent buckets as `pending` so the panel never reads `null`.
  assert.match(dashboard, /id="panel-codex-state"/);
  // The dashboard reads the new fields off the status payload. Both the raw
  // field references and the rendered labels are required so the panel never
  // silently degrades when the JSON contract evolves.
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
  assert.match(dashboard, /<dashboard-panel id="panel-orchestrator"[\s\S]*?<sub-panel id="panel-spawn-breakdown"/);
  assert.match(dashboard, /<dashboard-panel id="panel-skills"[\s\S]*?<sub-panel id="panel-skill-context"/);
  assert.match(dashboard, /<dashboard-panel id="panel-ops"[\s\S]*?<sub-panel id="panel-native-metrics"/);
  // Per-workspace named tool/skill/mcp attribution is rendered conditionally from
  // status.usage.byWorkspace[*].byTool/bySkill/byMcp: a fail-closed "unavailable"
  // state when the backend omits the field entirely, distinct from a
  // "no data yet" state when the backend reports the dimension but nothing
  // was observed for that workspace.
  assert.match(dashboard, /function normalizeWorkspaceNamedUsage\(raw, identityKeys\)/);
  assert.match(dashboard, /function renderWorkspaceNamedUsage\(rows, \{ unavailableLabel, emptyLabel \}\)/);
  assert.match(dashboard, /normalizeWorkspaceNamedUsage\(w\.byTool, \["tool", "name"\]\)/);
  assert.match(dashboard, /normalizeWorkspaceNamedUsage\(w\.bySkill, \["skill", "name"\]\)/);
  assert.match(dashboard, /normalizeWorkspaceNamedUsage\(w\.byMcp \?\? w\.mcpServers, \["server", "name", "mcp"\]\)/);
  assert.match(dashboard, /if \(rows === null\) return `<div class="empty-state">\$\{escapeHtml\(unavailableLabel\)\}<\/div>`;/);
  assert.match(dashboard, /Named tool telemetry is unavailable per-workspace/);
  assert.match(dashboard, /Named skill attribution is unavailable per-workspace/);
  assert.match(dashboard, /No named tool calls observed for this workspace yet/);
  assert.match(dashboard, /No named skill uses observed for this workspace yet/);
  assert.match(dashboard, /MCP server telemetry is unavailable per-workspace/);
  assert.match(dashboard, /No MCP servers observed for this workspace yet/);
  // Both route cards show observed MCP server counts with role-specific union
  // semantics using /status partitions (orchestrator role union vs explicit subagent roles union).
  assert.match(dashboard, /orchMcpCount/);
  assert.match(dashboard, /subMcpCount/);
  assert.match(dashboard, /<mini-stat label="MCP servers" value="\$\{orchMcpCount\}"><\/mini-stat>/);
  assert.match(dashboard, /<mini-stat label="MCP servers" value="\$\{subMcpCount\}"><\/mini-stat>/);
  // Model view embeds MCP counts and server details
  assert.match(dashboard, /getModelMcpDetails/);
  assert.match(dashboard, /model-mcp-details/);
  // The workspace table's scalar toolCalls is a response-output count
  // (Responses API tool-call items), which the dashboard labels explicitly
  // as distinct from the OTLP-named runtime tool rows shown per workspace.
  assert.match(dashboard, /Tool calls \(response output\)/);
  assert.match(dashboard, /response-output tool-call count/);
  assert.match(dashboard, /OTLP-named runtime tool rows/);
  assert.match(dashboard, /OTLP-named runtime tool rows joined to this workspace/);
  assert.match(dashboard, /MCP servers/);
  assert.doesNotMatch(dashboard, /<(?:dashboard-panel|sub-panel)[^>]*(?:id="[^"]*mcp|title="[^"]*MCP)/i);
  // Provider health panel renders routing priorities, effective/live limits and cooldowns,
  // disabled state, and one enable/disable control per provider.
  assert.match(dashboard, /Routing priority/);
  assert.match(dashboard, /Effective limits &amp; cooldowns/);
  assert.match(dashboard, /formatRoutingPriority/);
  assert.match(dashboard, /formatEffectiveLimitsAndCooldowns/);
  assert.match(dashboard, /isDisabled/);
  assert.match(dashboard, /btn-provider-toggle/);
  assert.match(dashboard, /\/v1\/providers\//);
  assert.match(dashboard, /toggleProvider/);
});

test('router dashboard provider health panel renders routing priorities, limits, disabled state, and toggle controls', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  // Panel header and table columns
  assert.match(rawDashboard, /<dashboard-panel id="panel-providers"[^>]*title="Provider health"/);
  assert.match(rawDashboard, /<th>Routing priority<\/th>/);
  assert.match(rawDashboard, /<th>Effective limits &amp; cooldowns<\/th>/);
  assert.match(rawDashboard, /<th>Control<\/th>/);
  // Routing priority helper and status handling
  assert.match(rawDashboard, /function formatRoutingPriority\(/);
  assert.match(rawDashboard, /formatRoutingPriority\(providerName, p, status\)/);
  // Effective limits and cooldown helper
  assert.match(rawDashboard, /function formatEffectiveLimitsAndCooldowns\(/);
  assert.match(rawDashboard, /formatEffectiveLimitsAndCooldowns\(p\)/);
  assert.match(rawDashboard, /cooldownRemainingMs/);
  assert.match(rawDashboard, /cooldownKind/);
  // Disabled state handling
  assert.match(rawDashboard, /const isDisabled = Boolean\(/);
  assert.match(rawDashboard, /statusLabel = isDisabled \? "disabled" : p\.status/);
  assert.match(rawDashboard, /provider-disabled/);
  // Controls: POST to /v1/providers/:provider, disable while pending, refresh on success, error UI on failure
  assert.match(rawDashboard, /class="btn-provider-toggle"/);
  assert.match(rawDashboard, /fetch\(`\/v1\/providers\/\$\{encodeURIComponent\(providerName\)\}`,\s*\{[^}]*method:\s*"POST"/s);
  assert.match(rawDashboard, /pendingProviderToggles\.has\(providerName\)/);
  assert.match(rawDashboard, /buttonEl\.disabled = true/);
  assert.match(rawDashboard, /await refresh\(\)/);
  assert.match(rawDashboard, /errorEl\.textContent = err\.message/);
});

test('router dashboard and status CLI contract separates live agent activity from in-flight requests and documents lifecycle TTL', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  // Helper functions for live agent activity and wait status
  assert.match(rawDashboard, /function getProviderLiveActivity\(/);
  assert.match(rawDashboard, /function isProviderLiveActive\(/);
  assert.match(rawDashboard, /window\.getProviderLiveActivity = getProviderLiveActivity/);
  assert.match(rawDashboard, /window\.isProviderLiveActive = isProviderLiveActive/);
  // Provider active badge and row remain active during tool/user/subagent waits
  assert.match(rawDashboard, /statusStr\.includes\("wait"\) \|\| statusStr\.includes\("tool"\) \|\| statusStr\.includes\("user"\) \|\| statusStr\.includes\("subagent"\)/);
  assert.match(rawDashboard, /provider-active/);
  assert.match(rawDashboard, /<status-badge \$\{isActive \? 'active=""' : ''\}>\$\{displayActive\}<\/status-badge>/);
  // Operational summary labels in-flight requests separately
  assert.match(rawDashboard, /status\.inFlightRequests/);
  assert.match(rawDashboard, /<span>In-flight requests<\/span><span>\$\{inFlightRequests\}<\/span>/);

  // Status CLI script displays both live agent activity (Active) and transport diagnostics (In-Flight)
  const statusCli = await readFile(path.join(root, 'scripts', 'codex-model-router-status.mjs'), 'utf8');
  assert.match(statusCli, /Active\s+In-Flight/);
  assert.match(statusCli, /getProviderLiveActivity/);
  assert.match(statusCli, /getProviderInFlight/);
  assert.match(statusCli, /in-flight requests \$\{totalInFlight\}/);

  // Documentation specifies live activity vs in-flight separation and lifecycle event contract with configurable TTL
  const metricsDoc = await readFile(path.join(root, 'docs', 'metrics-dashboard.md'), 'utf8');
  assert.match(metricsDoc, /Live agent activity vs\. in-flight requests transport diagnostics/);
  assert.match(metricsDoc, /Lifecycle event contract and configurable freshness TTL/);
  assert.match(metricsDoc, /CODEX_ROUTER_OTEL_HEALTH_TTL_MS/);

  const routingDoc = await readFile(path.join(root, 'docs', 'provider-routing.md'), 'utf8');
  assert.match(routingDoc, /Live agent activity vs\. in-flight requests transport diagnostics/);
  assert.match(routingDoc, /Lifecycle event contract and configurable TTL/);
  assert.match(routingDoc, /CODEX_ROUTER_OTEL_HEALTH_TTL_MS/);
});

test('metrics dashboard renders requested counters and recent links', () => {
  const body = metrics.renderDashboard({
    generatedAt: '2026-01-01T00:00:00.000Z',
    lookbackDays: 90,
    since: '2025-10-03',
    totals: { agentPrsRaised: 2, agentPrsMerged: 1, agentInvokes: 3, agentInvokesSucceeded: 2, agentInvokesFailed: 1, staleEmptyPrsClosed: 4 },
    perRepository: { 'SimulatorLife/AutoDev': { agentPrsRaised: 2, agentPrsMerged: 1, agentInvokes: { total: 3, succeeded: 2, failed: 1, other: 0 }, staleEmptyPrsClosed: 4 } },
    perAgent: { 'mini-max': { total: 3, succeeded: 2, failed: 1, other: 0 } },
    recentPrs: [{ repository: 'SimulatorLife/AutoDev', number: 7, title: 'Agent: Example', url: 'https://github.com/SimulatorLife/AutoDev/pull/7', agent: 'mini-max', state: 'open', mergedAt: null, createdAt: '2026-01-01T00:00:00.000Z' }],
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

test('metrics workflow publishes an issue dashboard and artifact', async () => {
  const source = await readFile(path.join(root, '.github', 'workflows', 'metrics-dashboard.yml'), 'utf8');
  assert.match(source, /schedule:/);
  assert.match(source, /lookback_days:[\s\S]*default: 90[\s\S]*type: number/);
  assert.match(source, /actions\/github-script@v8/);
  assert.match(await readFile(path.join(root, 'scripts', 'autodev-metrics.cjs'), 'utf8'), /listWorkflowRuns/);
  assert.match(source, /issues\.update/);
  assert.match(source, /autodev-metrics-dashboard-v1/);
  assert.match(source, /upload-artifact@v4/);
  assert.match(source, /metrics-snapshot\.json/);
});
