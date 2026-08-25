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
  assert.match(body, /created 2026-01-01 00:00 UTC/);
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
