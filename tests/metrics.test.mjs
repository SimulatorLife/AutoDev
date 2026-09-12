import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
  // The workspace table's Tool calls column and totals use the same source of
  // truth as each workspace's expanded Tools section (sum of rendered named
  // tool rows from w.byTool via normalizeWorkspaceNamedUsage), without contrasting
  // response-output counts or leaving stale notes asserting the old distinction.
  assert.doesNotMatch(dashboard, /Tool calls \(response output\)/);
  assert.doesNotMatch(dashboard, /response-output tool-call count/);
  assert.doesNotMatch(dashboard, /OTLP-named runtime tool rows/);
  assert.doesNotMatch(dashboard, /OTLP-named runtime tool rows joined to this workspace/);
  assert.match(dashboard, /<th>Tool calls<\/th>/);
  assert.match(dashboard, /wsToolRows\.reduce\(/);
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


test('router dashboard inline JavaScript has no unresolved identifiers', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  const source = [...rawDashboard.matchAll(/<script(?:\s[^>]*)?>(.*?)<\/script>/gis)].map((match) => match[1]).join('\n\n');
  const tempDir = await mkdtemp(path.join(tmpdir(), 'autodev-dashboard-'));
  const sourceFile = path.join(tempDir, 'dashboard.js');
  try {
    await writeFile(sourceFile, source, 'utf8');
    const typescript = require('typescript');
    const program = typescript.createProgram([sourceFile], {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: typescript.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true,
    });
    const diagnostics = typescript.getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552)
      .map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    assert.deepEqual(diagnostics, [], `dashboard has unresolved identifiers: ${diagnostics.join('; ')}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('router dashboard provider health panel renders routing priorities, limits, disabled state, and toggle controls', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  // Panel header and table columns
  assert.match(rawDashboard, /<dashboard-panel id="panel-providers"[^>]*title="Provider health"/);
  assert.match(rawDashboard, /<th>Routing priority<\/th>/);
  assert.match(rawDashboard, /<th>Effective limits &amp; cooldowns<\/th>/);
  assert.match(rawDashboard, /<th>Active<\/th>/);
  assert.doesNotMatch(rawDashboard, /<th>In-flight<\/th>/);
  assert.doesNotMatch(rawDashboard, /<th>Last failure<\/th>/);
  assert.match(rawDashboard, /<th>Control<\/th>/);

  // Table column alignment: exactly 9 headers and matching colspan in loading and empty rows
  const providerPanel = rawDashboard.match(/<dashboard-panel id="panel-providers"[\s\S]*?<\/dashboard-panel>/)?.[0] ?? '';
  const providerHeaders = (providerPanel.match(/<th>.*?<\/th>/g) ?? []).map((h) => h.replace(/<[^>]+>/g, '').trim());
  assert.deepEqual(providerHeaders, [
    'Provider',
    'Routing priority',
    'Configured models',
    'Status',
    'Effective limits &amp; cooldowns',
    'Active',
    'Avg turn',
    'Outcomes',
    'Control',
  ]);
  assert.match(rawDashboard, /<td colspan="9" class="dim" style="text-align:center">Loading providers\.\.\.<\/td>/);
  assert.match(rawDashboard, /<td colspan="9" class="dim" style="text-align:center">No providers configured<\/td>/);
  const rowTemplateMatch = rawDashboard.match(/providersTbody\.innerHTML = providersEntries\.map\([\s\S]*?return `<tr[\s\S]*?<\/tr>`;/);
  assert.ok(rowTemplateMatch, 'provider row template must be present');
  const tdCount = (rowTemplateMatch[0].match(/<td\b/g) ?? []).length;
  assert.equal(tdCount, 9, 'provider row template should have exactly 9 td cells to align with headers');
  assert.doesNotMatch(rowTemplateMatch[0], /p\.inFlightRequests/, 'provider row template must not include inFlightRequests cell');
  assert.doesNotMatch(rowTemplateMatch[0], /failureHtml/, 'provider row template must not include failureHtml cell');
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
  // Wordless iOS-like toggle switch: green when enabled, grey when disabled, no text inside button
  assert.match(rawDashboard, /\.btn-provider-toggle\s*\{[^}]*border-radius:\s*var\(--radius-pill\);/s);
  assert.match(rawDashboard, /\.btn-provider-toggle::after\s*\{/);
  assert.match(rawDashboard, /\.btn-provider-toggle\[data-action="disable"\][^}]*background:\s*#34c759;/s);
  assert.match(rawDashboard, /\.btn-provider-toggle\[data-action="enable"\][^}]*background:\s*#48484a;/s);
  assert.match(rawDashboard, /<button type="button" class="btn-provider-toggle"[^>]*role="switch"[^>]*aria-checked="\$\{!(?:isDisabled)\}"[^>]*><\/button>/);
  assert.doesNotMatch(rawDashboard, /buttonEl\.textContent/);
  assert.doesNotMatch(rawDashboard, /Enabling…/);
  assert.doesNotMatch(rawDashboard, /Disabling…/);
});

test('router dashboard and status CLI contract separates live agent activity from in-flight requests and documents lifecycle TTL', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  // Helper functions for live agent activity and wait status
  assert.match(rawDashboard, /function getProviderLiveActivity\(/);
  assert.match(rawDashboard, /function isProviderLiveActive\(/);
  assert.match(rawDashboard, /window\.getProviderLiveActivity = getProviderLiveActivity/);
  assert.match(rawDashboard, /window\.isProviderLiveActive = isProviderLiveActive/);
  // Provider active badge and row remain active during tool/user/subagent waits
  assert.match(rawDashboard, /return Number\(p\?\.active \?\? 0\)/);
  assert.match(rawDashboard, /provider-active/);
  assert.match(rawDashboard, /<status-badge \$\{isActive \? 'active=""' : ''\}>\$\{displayActive\}<\/status-badge>/);
  // Operational summary labels in-flight requests separately
  assert.match(rawDashboard, /const avgInitDur = initSamples > 0 \? initSum \/ initSamples : 0/);
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
  assert.match(metricsDoc, /CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS/);

  const routingDoc = await readFile(path.join(root, 'docs', 'provider-routing.md'), 'utf8');
  assert.match(routingDoc, /Live agent activity vs\. in-flight requests transport diagnostics/);
  assert.match(routingDoc, /Lifecycle event contract and configurable TTL/);
  assert.match(routingDoc, /CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS/);
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

test('router dashboard workspace table derives Tool calls and totals from byTool normalization and handles unavailable states', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');

  // Verify that the table header and notes have no stale response-output references
  assert.doesNotMatch(rawDashboard, /OTLP-named runtime tool rows/);
  assert.doesNotMatch(rawDashboard, /response-output tool-call count/);
  assert.doesNotMatch(rawDashboard, /Tool calls \(response output\)/);
  assert.match(rawDashboard, /<th>Tool calls<\/th>/);

  // Extract normalizeWorkspaceNamedUsage to test normalization logic and summing
  const match = rawDashboard.match(/function normalizeWorkspaceNamedUsage\([\s\S]*?\n    \}/);
  assert.ok(match, 'normalizeWorkspaceNamedUsage should be present in dashboard script');
  const normalizeWorkspaceNamedUsage = new Function(`${match[0]}; return normalizeWorkspaceNamedUsage;`)();

  // Unavailable byTool returns null and is handled without inventing counts
  assert.equal(normalizeWorkspaceNamedUsage(null, ["tool", "name"]), null);
  assert.equal(normalizeWorkspaceNamedUsage(undefined, ["tool", "name"]), null);

  // Empty byTool returns empty array (sum = 0)
  const emptyRows = normalizeWorkspaceNamedUsage([], ["tool", "name"]);
  assert.deepEqual(emptyRows, []);
  assert.equal(emptyRows.reduce((sum, r) => sum + Number(r.count ?? 0), 0), 0);

  // Array of named tool entries sums counts correctly
  const arrayRows = normalizeWorkspaceNamedUsage([
    { tool: 'bash', count: 5 },
    { tool: 'read_file', count: 2 },
  ], ["tool", "name"]);
  assert.equal(arrayRows.reduce((sum, r) => sum + Number(r.count ?? 0), 0), 7);

  // Object-shaped named tool entries sums counts correctly
  const objectRows = normalizeWorkspaceNamedUsage({
    bash: { count: 4 },
    exec_command: { uses: 3 },
  }, ["tool", "name"]);
  assert.equal(objectRows.reduce((sum, r) => sum + Number(r.count ?? 0), 0), 7);
});

test('dashboard hides totals rows for sections with 0 or 1 populated row and shows them for 2+ via the shared shouldRenderTotals helper', async () => {
  const rawDashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');

  // 1. The helper exists in the dashboard script with a stable signature so
  // it can drive every totals-footer site through one rule.
  const match = rawDashboard.match(/function shouldRenderTotals\([\s\S]*?\n    \}/);
  assert.ok(match, 'shouldRenderTotals should be present in dashboard script');
  const shouldRenderTotals = new Function(`${match[0]}; return shouldRenderTotals;`)();

  // Boundary behavior: 0, 1, 2, 5 populated rows.
  assert.equal(shouldRenderTotals(0), false, 'zero populated rows must hide totals');
  assert.equal(shouldRenderTotals(1), false, 'single populated row must hide totals (it would just echo the row above)');
  assert.equal(shouldRenderTotals(2), true, 'two populated rows must reveal totals');
  assert.equal(shouldRenderTotals(5), true, 'more than two populated rows must keep totals visible');
  // Defensive coercion: null/undefined/strings still resolve correctly without
  // throwing, so totals never render on placeholder/loading tbody contents.
  assert.equal(shouldRenderTotals(null), false);
  assert.equal(shouldRenderTotals(undefined), false);
  assert.equal(shouldRenderTotals(''), false);
  assert.equal(shouldRenderTotals('1'), false, 'string "1" coerces to 1 and still hides totals');
  assert.equal(shouldRenderTotals('2'), true, 'string "2" coerces to 2 and reveals totals');

  // 2. Every homogeneous roll-up footer wraps its content in the helper,
  // measured against the populated-row variable each site already uses to
  // build the tbody.
  assert.match(rawDashboard, /spawnTfoot\.innerHTML = shouldRenderTotals\(spawnList\.length\)/);
  assert.match(rawDashboard, /failuresTfoot\.innerHTML = shouldRenderTotals\(byReason\.length\)/);
  assert.match(rawDashboard, /wsTfoot\.innerHTML = shouldRenderTotals\(sortedWorkspaces\.length\)/);
  assert.match(rawDashboard, /skillsTfoot\.innerHTML = shouldRenderTotals\(sortedSkills\.length\)/);
  assert.match(rawDashboard, /hooksTfoot\.innerHTML = shouldRenderTotals\(rows\.length\)/);
  assert.match(rawDashboard, /metricsTfoot\.innerHTML = shouldRenderTotals\(metricsList\.length\)/);

  // 3. The six Totals header cells remain so the totals template still renders
  // when the populated-row count crosses the threshold. Removing the headings
  // would silently drop the totals without any test catching it.
  const totalsHeaderCount = (rawDashboard.match(/<th>Totals<\/th>/g) ?? []).length;
  assert.equal(totalsHeaderCount, 6, 'all six homogeneous roll-up sections should still define a Totals header');

  // 4. Empty/unavailable branches still clear the footer before any helper is
  // consulted; "No X observed yet" placeholder colspan rows must never be
  // counted toward the populated total. Each homogeneous roll-up tfoot has
  // exactly two innerHTML assignments: `""` in the empty branch and the
  // helper-wrapped template in the populated branch.
  for (const footerId of [
    'spawnTfoot',
    'failuresTfoot',
    'wsTfoot',
    'skillsTfoot',
    'hooksTfoot',
    'metricsTfoot',
  ]) {
    const emptyBranch = rawDashboard.match(new RegExp(`\\b${footerId}\\.innerHTML = "";`));
    assert.ok(emptyBranch, `empty/unavailable branch for ${footerId} must still clear the footer before any totals render`);
    const populatedBranch = rawDashboard.match(new RegExp(`\\b${footerId}\\.innerHTML = shouldRenderTotals\\(`));
    assert.ok(populatedBranch, `populated branch for ${footerId} must gate the totals render on shouldRenderTotals`);
  }

  // 5. Documentation explains the new threshold-based rule so the totals-row
  // policy has a single source of truth between renderer and docs.
  const metricsDoc = await readFile(path.join(root, 'docs', 'metrics-dashboard.md'), 'utf8');
  assert.match(metricsDoc, /Totals footers are shown only when the section has at least 2 populated,\s*non-total data rows/);
  assert.match(metricsDoc, /loading\/placeholder\/empty colspan rows/);
});

test('dashboard counts active workspaces from live activity states and excludes unattributed slots', async () => {
  const dashboard = await readFile(path.join(root, 'scripts', 'codex-model-router-dashboard.html'), 'utf8');
  const match = dashboard.match(/function countActiveWorkspaces\([\s\S]*?\n    \}/);
  assert.ok(match, 'countActiveWorkspaces should be present in dashboard script');
  const countActiveWorkspaces = new Function(`${match[0]}; return countActiveWorkspaces;`)();

  assert.equal(countActiveWorkspaces({
    usage: { activity: { byWorkspace: {
      AutoDev: { active: 0, tool_wait: 1 },
      unattributed: { active: 1 },
      unknown: { active: 1 },
    } } },
  }), 1);
  assert.equal(countActiveWorkspaces({
    usage: { activity: { byWorkspace: { AutoDev: { finished: 1 } } } },
  }), 0);
  assert.equal(countActiveWorkspaces({
    usage: { byWorkspace: { AutoDev: { active: 1 } } },
  }), 1, 'legacy status payloads fall back to workspace active values');
});
