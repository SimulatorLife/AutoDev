import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SubagentRegistry,
  bridgeTelemetryHeaders,
  mcpContractForRole,
  providerCapabilities,
  reportedChildren,
  roleCapabilityRequirements,
  safeMetricLabel,
  subagentSpawnToolsFor,
  PROCESS_FALLBACK_SESSION_KEY,
} from '../../src/router/subagents.ts';

test('SubagentRegistry records spawns and maintains ring buffer and aggregations', () => {
  const recordedRouterEvents: any[] = [];
  const registry = new SubagentRegistry({
    maxRecentSpawns: 3,
    onRecordRouterEvent: (e) => recordedRouterEvents.push(e),
  });

  const entry1 = registry.recordSubagentSpawn({
    mechanism: 'bridge_native',
    provider: 'claude',
    role: 'explorer',
    tool: 'Agent',
    requestId: 'req-1',
    count: 2,
  });

  assert.ok(entry1);
  assert.equal(entry1.mechanism, 'bridge_native');
  assert.equal(entry1.provider, 'claude');
  assert.equal(entry1.role, 'explorer');
  assert.equal(entry1.count, 2);
  assert.equal(recordedRouterEvents.length, 1);

  // Invalid mechanism returns null
  assert.equal(registry.recordSubagentSpawn({ mechanism: 'invalid', count: 1 }), null);
  // Zero count returns null
  assert.equal(registry.recordSubagentSpawn({ mechanism: 'router_alias', count: 0 }), null);

  registry.recordSubagentSpawn({ mechanism: 'router_alias', provider: 'minimax', role: 'worker', count: 1 });
  registry.recordSubagentSpawn({ mechanism: 'bridge_native', provider: 'claude', role: 'worker', count: 1 });
  // 4th spawn should push out the first in recent (maxRecentSpawns = 3)
  registry.recordSubagentSpawn({ mechanism: 'bridge_native', provider: 'antigravity', role: 'validator', count: 1 });

  const status = registry.subagentStatus();
  assert.equal(status.total, 5); // 2 + 1 + 1 + 1
  assert.equal(status.byMechanism.bridge_native, 4);
  assert.equal(status.byMechanism.router_alias, 1);
  assert.equal(status.byProvider.claude, 3);
  assert.equal(status.byProvider.minimax, 1);
  assert.equal(status.byProvider.antigravity, 1);
  assert.equal(status.byRole.explorer, 2);
  assert.equal(status.byRole.worker, 2);
  assert.equal(status.byRole.validator, 1);

  assert.equal(status.recent.length, 3);
  // reversed order (newest first)
  assert.equal(status.recent[0]?.role, 'validator');
});

test('SubagentRegistry tracks orchestrator sessions and workspace metadata ignoring process fallback', () => {
  const registry = new SubagentRegistry();

  registry.noteOrchestratorSession('session-1', 'minimax');
  assert.equal(registry.orchestratorProviderForSession('session-1'), 'minimax');

  // Process fallback session key must be ignored
  registry.noteOrchestratorSession(PROCESS_FALLBACK_SESSION_KEY, 'claude');
  assert.equal(registry.orchestratorProviderForSession(PROCESS_FALLBACK_SESSION_KEY), null);
  assert.equal(registry.orchestratorProviderForSession('unknown-session'), null);

  registry.rememberWorkspaceMetadata('session-1', '/path/to/repo');
  assert.ok(registry.getWorkspaceMetadata('session-1')?.includes('/path/to/repo'));

  registry.rememberWorkspaceMetadata(PROCESS_FALLBACK_SESSION_KEY, '/path/to/repo');
  assert.equal(registry.getWorkspaceMetadata(PROCESS_FALLBACK_SESSION_KEY), null);
});

test('SubagentRegistry tracks bridge request and session contexts', () => {
  const registry = new SubagentRegistry();

  registry.noteBridgeRequest('req-100', { provider: 'claude', model: 'sonnet', role: 'worker' });
  assert.deepEqual(registry.getBridgeRequestContext('req-100'), { provider: 'claude', model: 'sonnet', role: 'worker' });
  assert.equal(registry.getBridgeRequestContext('req-unknown'), null);

  registry.noteBridgeSession('sess-100', { requestId: 'req-100', provider: 'claude', model: 'sonnet' });
  assert.equal(registry.recallBridgeSessionRequestId('sess-100'), 'req-100');
  const sessionCtx = registry.lookupBridgeSessionContext('sess-100');
  assert.equal(sessionCtx?.provider, 'claude');
  assert.equal((sessionCtx as any)?.requestId, undefined); // requestId stripped
});

test('SubagentRegistry records and restores spawn failures', () => {
  const recordedRouterEvents: any[] = [];
  const registry = new SubagentRegistry({
    onRecordRouterEvent: (e) => recordedRouterEvents.push(e),
  });

  registry.recordSpawnFailure({
    requestId: 'fail-req',
    role: 'worker',
    requestedModel: 'autodev/worker',
    reason: 'provider_exhausted',
  });

  const status = registry.spawnFailureStatus();
  assert.equal(status.total, 1);
  assert.equal(status.byReason.provider_exhausted, 1);
  assert.equal(status.recent.length, 1);
  assert.equal(status.recent[0]?.reason, 'provider_exhausted');
  assert.equal(recordedRouterEvents[0]?.phase, 'spawn_failed');

  registry.resetSpawnFailureTelemetry();
  assert.equal(registry.spawnFailureStatus().total, 0);

  registry.restoreSpawnFailureTelemetry({
    total: 10,
    byReason: { provider_exhausted: 8, spawn_tool_unavailable: 2 },
    recent: [{ requestId: 'old-fail', role: 'worker', requestedModel: 'm', reason: 'provider_exhausted', timestamp: '' }],
  });
  const restored = registry.spawnFailureStatus();
  assert.equal(restored.total, 10);
  assert.equal(restored.byReason.provider_exhausted, 8);
  assert.equal(restored.byReason.spawn_tool_unavailable, 2);
  assert.equal(restored.recent.length, 1);
});

test('reportedChildren parses structured children and pads to count', () => {
  const parsed = reportedChildren({
    children: [{ id: 'child-1', model: 'sonnet' }],
    count: 3,
  });

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.id, 'child-1');
  assert.equal(parsed[0]?.model, 'sonnet');
  assert.ok(parsed[1]?.id.startsWith('anon'));
  assert.ok(parsed[2]?.id.startsWith('anon'));
});

test('capabilities and telemetry headers resolve properly', () => {
  const mockExecutionContract = {
    providers: {
      claude: { spawnTools: ['Agent'], delegation: 'codex-shim' },
      antigravity: { spawnTools: ['invoke_subagent'], delegation: 'codex-shim' },
      copilot: { spawnTools: [], delegation: 'codex-shim' },
      codex: { spawnTools: [], delegation: 'native' },
      minimax: { spawnTools: [], delegation: 'none' },
    },
    roles: {
      orchestrator: { mcp: ['server-1'], skills: ['skill-1'] },
      explorer: { mcp: ['server-2'], skills: ['skill-2'], webResearch: { search: true, fetch: false } },
    },
  };

  const caps = providerCapabilities('claude', mockExecutionContract);
  assert.equal(caps.subagentSpawn, true);
  assert.deepEqual(caps.subagentSpawnTools, ['Agent']);

  assert.deepEqual(subagentSpawnToolsFor('antigravity', mockExecutionContract), ['invoke_subagent']);
  assert.equal(providerCapabilities('minimax', mockExecutionContract).subagentSpawn, false);
  assert.equal(providerCapabilities('copilot', mockExecutionContract).subagentSpawn, true);
  assert.equal(providerCapabilities('missing', mockExecutionContract).subagentSpawn, false);
  assert.equal(providerCapabilities('minimax', { providers: { minimax: { spawnTools: ['invoke_subagent'], delegation: 'none' } } }).subagentSpawn, false);
  assert.deepEqual(mcpContractForRole('orchestrator', mockExecutionContract), ['server-1']);
  assert.deepEqual(mcpContractForRole('explorer', mockExecutionContract), ['server-2']);

  const roleReqs = roleCapabilityRequirements('explorer', mockExecutionContract);
  assert.ok(roleReqs.mcp.has('server-2'));
  assert.ok(roleReqs.skills.has('skill-2'));
  assert.equal(roleReqs.webResearch.search, true);
  assert.equal(roleReqs.webResearch.fetch, false);

  // bridgeTelemetryHeaders for codex returns empty
  assert.deepEqual(bridgeTelemetryHeaders({ provider: 'codex' }, 'req-123', { executionContract: mockExecutionContract }), {});

  // bridgeTelemetryHeaders for claude includes request id and spawn tools
  const headers = bridgeTelemetryHeaders({ provider: 'claude' }, 'req-123', {
    executionContract: mockExecutionContract,
    agentEventsUrl: 'http://127.0.0.1:4100/v1/agent-events',
  });
  assert.equal(headers['x-autodev-request-id'], 'req-123');
  assert.equal(headers['x-autodev-agent-events-url'], 'http://127.0.0.1:4100/v1/agent-events');
  assert.equal(headers['x-autodev-subagent-spawn-tools'], 'Agent');
});

test('convenience functions delegate to default SubagentRegistry', async () => {
  const {
    getDefaultSubagentRegistry,
    setDefaultSubagentRegistry,
    noteOrchestratorSession,
    orchestratorProviderForSession,
    rememberWorkspaceMetadata,
    getWorkspaceMetadata,
    noteBridgeRequest,
    getBridgeRequestContext,
    recordSubagentSpawn,
    subagentStatus,
    resetSubagentTelemetry,
  } = await import('../../src/router/subagents.ts');

  const custom = new SubagentRegistry();
  setDefaultSubagentRegistry(custom);
  assert.equal(getDefaultSubagentRegistry(), custom);

  noteOrchestratorSession('sess-default', 'claude');
  assert.equal(orchestratorProviderForSession('sess-default'), 'claude');

  rememberWorkspaceMetadata('sess-default', '/test/workspace');
  assert.ok(getWorkspaceMetadata('sess-default')?.includes('/test/workspace'));

  noteBridgeRequest('req-def', { provider: 'antigravity', model: 'flash' });
  assert.deepEqual(getBridgeRequestContext('req-def'), { provider: 'antigravity', model: 'flash' });

  recordSubagentSpawn({ mechanism: 'router_alias', count: 1, provider: 'codex', role: 'worker' });
  assert.equal(subagentStatus().total, 1);

  resetSubagentTelemetry();
  assert.equal(subagentStatus().total, 0);

  setDefaultSubagentRegistry(null);
});


test('synthetic bridge parent activity settles with the parent outcome', () => {
  const finishes: Array<{ subject: string; outcome: string }> = [];
  const agentActivity = {
    beginRequest: () => undefined,
    applyLifecycleEvent: () => true,
    finish: (subject: string, options: { outcome?: string }) => {
      finishes.push({ subject, outcome: options.outcome ?? 'unknown' });
      return null;
    },
  };
  const registry = new SubagentRegistry({ agentActivity: agentActivity as any });
  const context = { provider: 'claude', model: 'sonnet', role: 'orchestrator', workspace: 'AutoDev' };
  registry.noteBridgeRequest('parent-failure', context);
  registry.openBridgeSubagentUsage({ requestId: 'parent-failure', context, role: 'worker', childId: 'child-1' });

  // A child can finish before the parent request. That must not close the
  // synthetic parent early, because the parent's eventual failure is the
  // authoritative outcome for the parent activity.
  assert.equal(registry.closeBridgeSubagentUsage('parent-failure\0child-1', { outcome: 'success' }), true);
  assert.deepEqual(finishes, [{ subject: 'bridge:parent-failure\0child-1', outcome: 'success' }]);

  registry.closeBridgeSubagentsForRequest('parent-failure', 'failure', 25);
  assert.deepEqual(finishes, [
    { subject: 'bridge:parent-failure\0child-1', outcome: 'success' },
    { subject: 'bridge-parent:parent-failure', outcome: 'failure' },
  ]);
});
