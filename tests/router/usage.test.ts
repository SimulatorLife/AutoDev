import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentActivityTracker } from '../../src/agents/agent-activity.ts';
import {
  type AttributionDiagnosticsStatus,
  MAX_UNKNOWN_WORKSPACE_IDS,
  UNATTRIBUTED_DIMENSION,
  UsageTracker,
  clearWorkspaceCapabilities,
  emptyUsageBucket,
  extractWorkspaceIdWithAmbiguity,
  formatWorkspaceMcpExposed,
  formatWorkspaceMcpUses,
  formatWorkspaceSkills,
  formatWorkspaceTools,
  matchesProjectedAgent,
  projectLiveAgents,
  readNamedAttribute,
  recordUsageEvent,
  registerWorkspaceId,
  resetAttributionDiagnostics,
  resetUsageTelemetry,
  restoreUsageBucket,
  restoreUsagePersistenceSnapshot,
  safeAgentIdentity,
  safePrivacyWorkspace,
  safeWorkspaceId,
  toolKey,
  toolNameAttribute,
  toolServerAttribute,
  usageBucket,
  usageKey,
  usageOrigin,
  usagePersistenceSnapshot,
  usageSnapshot,
  usageStatus,
  workspaceBucket,
  workspaceMcpBucket,
  workspaceSkillBucket,
  workspaceToolBucket,
} from '../../src/router/usage.ts';

test('emptyUsageBucket produces standard zeroed telemetry counters', () => {
  const bucket = emptyUsageBucket();
  assert.deepEqual(bucket, {
    attempts: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    active: 0,
    durationMs: 0,
    maxDurationMs: 0,
    toolCalls: 0,
    lastUsedAt: null,
    lastFailure: null,
  });
});

test('usageOrigin determines origin from role and provider correctly', () => {
  assert.equal(usageOrigin('orchestrator', 'anthropic'), 'orchestrator');
  assert.equal(usageOrigin('orchestrator', 'codex'), 'orchestrator');
  assert.equal(usageOrigin('explorer', 'anthropic'), 'subagent');
  assert.equal(usageOrigin('worker', null), 'subagent');
  assert.equal(usageOrigin(null, 'codex'), 'orchestrator');
  assert.equal(usageOrigin(undefined, 'codex'), 'orchestrator');
  assert.equal(usageOrigin(null, 'anthropic'), 'direct');
  assert.equal(usageOrigin(null, 'openai'), 'direct');
});

test('usageKey formats null-delimited composite key', () => {
  assert.equal(usageKey('req-1', 'openai', 'gpt-4o'), 'req-1\0openai\0gpt-4o');
});

test('safeWorkspaceId and privacy helpers hash local paths and sanitize metric labels', () => {
  assert.equal(safeWorkspaceId(''), 'unknown');
  assert.equal(safeWorkspaceId(null), 'unknown');
  assert.equal(safeWorkspaceId('  '), 'unknown');

  // Absolute paths, home paths, and windows paths must be SHA-256 hashed
  const pathId = safeWorkspaceId('/Users/developer/project');
  assert.match(pathId, /^ws_[0-9a-f]{12}$/);
  assert.equal(pathId.includes('/Users/developer'), false);

  const homeId = safeWorkspaceId('~/workspace/app');
  assert.match(homeId, /^ws_[0-9a-f]{12}$/);

  const winId = safeWorkspaceId('C:\\Users\\dev\\project');
  assert.match(winId, /^ws_[0-9a-f]{12}$/);

  // Safe names pass through sanitized
  assert.equal(safeWorkspaceId('owner/repo'), 'owner/repo');
  assert.equal(safeWorkspaceId('my-clean-workspace_1'), 'my-clean-workspace_1');

  // safeAgentIdentity
  assert.equal(safeAgentIdentity(null), UNATTRIBUTED_DIMENSION);
  assert.equal(safeAgentIdentity('/home/user/custom-agent'), `agent_${safeWorkspaceId('/home/user/custom-agent').slice(3)}`);
  assert.equal(safeAgentIdentity('custom-agent'), 'custom-agent');

  // safePrivacyWorkspace
  assert.equal(safePrivacyWorkspace(null), UNATTRIBUTED_DIMENSION);
  assert.match(safePrivacyWorkspace('/Users/someone/repo'), /^ws_[0-9a-f]{12}$/);
  assert.equal(safePrivacyWorkspace('repo-name'), 'repo-name');
});

test('extractWorkspaceIdWithAmbiguity extracts workspace IDs and detects ambiguity', () => {
  assert.deepEqual(extractWorkspaceIdWithAmbiguity(null), { id: null, ambiguous: false });
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({}), { id: null, ambiguous: false });
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({ workspace_id: 'ws-1' }), { id: 'ws-1', ambiguous: false });
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({ 'workspace.id': 'ws-2' }), { id: 'ws-2', ambiguous: false });
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({ workspaceId: 'ws-3' }), { id: 'ws-3', ambiguous: false });

  // Matching values across keys
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({ workspace_id: 'ws-same', workspaceId: 'ws-same' }), {
    id: 'ws-same',
    ambiguous: false,
  });

  // Conflicting values
  assert.deepEqual(extractWorkspaceIdWithAmbiguity({ workspace_id: 'ws-1', workspaceId: 'ws-2' }), {
    id: null,
    ambiguous: true,
  });
});

test('readNamedAttribute, toolServerAttribute, and toolKey extract tool attributes', () => {
  const attrs = { tool_name: 'read_file', source: 'builtin', mcp_server: 'filesystem' };
  assert.equal(readNamedAttribute(attrs, 'fallback', 'nonexistent', 'tool_name'), 'read_file');
  assert.equal(readNamedAttribute(attrs, 'fallback', 'nonexistent'), 'fallback');

  assert.equal(toolServerAttribute(attrs), 'filesystem');
  assert.equal(toolNameAttribute(attrs), 'read_file');
  assert.equal(toolKey(attrs), 'read_file::builtin::filesystem');
});

test('Workspace registry registers, handles duplicates, and fails on conflict', () => {
  const tracker = new UsageTracker();

  assert.equal(tracker.registerWorkspaceId('', 'RepoA'), false);
  assert.equal(tracker.registerWorkspaceId('ws-1', ''), false);

  assert.equal(tracker.registerWorkspaceId('ws-1', 'RepoA'), true);
  assert.equal(tracker.workspaceIdRegistry.get(safeWorkspaceId('ws-1')), 'RepoA');

  // Same key re-registration succeeds
  assert.equal(tracker.registerWorkspaceId('ws-1', 'RepoA'), true);

  // Conflicting key fails closed, purges mapping, and marks conflict
  assert.equal(tracker.registerWorkspaceId('ws-1', 'RepoB'), false);
  assert.equal(tracker.workspaceIdRegistry.has(safeWorkspaceId('ws-1')), false);
  assert.equal(tracker.workspaceIdConflicts.has(safeWorkspaceId('ws-1')), true);

  // Subsequent registration on conflicted ID still returns false
  assert.equal(tracker.registerWorkspaceId('ws-1', 'RepoA'), false);
});

test('Attribution diagnostics tracks counts, reason breakdowns, and caps unknown workspace IDs', () => {
  const tracker = new UsageTracker();

  assert.deepEqual(tracker.attributionDiagnosticsStatus(), {
    total: 0,
    attributed: 0,
    unattributed: 0,
    byReason: {
      missing_workspace: 0,
      unknown_workspace_id: 0,
      ambiguous_resource: 0,
      missing_provider: 0,
      missing_model: 0,
    },
    bySource: {
      datapoint: 0,
      resource: 0,
    },
    unknownWorkspaceIds: [],
  });

  tracker.recordAttributionDiagnostic({ attributed: true, source: 'datapoint' });
  tracker.recordAttributionDiagnostic({ attributed: true, source: 'resource' });
  tracker.recordAttributionDiagnostic({ attributed: false, reason: 'missing_workspace' });
  tracker.recordAttributionDiagnostic({ attributed: false, reason: 'unknown_workspace_id', unknownWorkspaceId: 'ws-bad' });
  tracker.recordMissingProviderDiagnostic(3);
  tracker.recordMissingModelDiagnostic(2);

  const status = tracker.attributionDiagnosticsStatus();
  assert.equal(status.total, 4);
  assert.equal(status.attributed, 2);
  assert.equal(status.unattributed, 2);
  assert.equal(status.bySource.datapoint, 1);
  assert.equal(status.bySource.resource, 1);
  assert.equal(status.byReason.missing_workspace, 1);
  assert.equal(status.byReason.unknown_workspace_id, 1);
  assert.equal(status.byReason.missing_provider, 3);
  assert.equal(status.byReason.missing_model, 2);
  assert.deepEqual(status.unknownWorkspaceIds, ['ws-bad']);

  // Add 120 unique unknown workspace IDs to test eviction cap
  for (let i = 0; i < 120; i++) {
    tracker.recordAttributionDiagnostic({
      attributed: false,
      reason: 'unknown_workspace_id',
      unknownWorkspaceId: `ws-unknown-${i}`,
    });
  }
  const cappedStatus = tracker.attributionDiagnosticsStatus();
  assert.equal(cappedStatus.unknownWorkspaceIds.length, MAX_UNKNOWN_WORKSPACE_IDS);
  assert.equal(cappedStatus.unknownWorkspaceIds.includes('ws-bad'), false);
  assert.equal(cappedStatus.unknownWorkspaceIds.includes('ws-unknown-119'), true);

  tracker.resetAttributionDiagnostics();
  assert.equal(tracker.attributionDiagnosticsStatus().total, 0);
  assert.equal(tracker.attributionDiagnosticsStatus().unknownWorkspaceIds.length, 0);
});

test('Workspace bucket management and formatting', () => {
  const tracker = new UsageTracker();
  const wsBucket = tracker.workspaceBucket('test-repo', 'test-cwd');
  assert.equal(wsBucket.cwd, 'test-cwd');
  assert.equal(wsBucket.toolsCapable, false);

  const tool = tracker.workspaceToolBucket(wsBucket, { tool: 'grep', source: 'builtin', server: 'search' });
  tool.count = 5;
  tool.durationCount = 2;
  tool.durationMs = 200;
  tool.byStatus = { success: 4, error: 1 };

  const formattedTools = formatWorkspaceTools(wsBucket.tools);
  assert.equal(formattedTools.length, 1);
  assert.equal(formattedTools[0]!.tool, 'grep');
  assert.equal(formattedTools[0]!.averageDurationMs, 100);

  const skill = tracker.workspaceSkillBucket(wsBucket, 'git-commit');
  skill.total = 3;
  skill.uses = 2;
  skill.byStatus = { success: 2 };
  const formattedSkills = formatWorkspaceSkills(wsBucket.skills);
  assert.equal(formattedSkills.length, 1);
  assert.equal(formattedSkills[0]!.skill, 'git-commit');

  const mcp = tracker.workspaceMcpBucket(wsBucket, 'github');
  mcp.count = 7;
  const formattedMcp = formatWorkspaceMcpExposed(wsBucket.mcpExposed);
  assert.equal(formattedMcp.length, 1);
  assert.equal(formattedMcp[0]!.server, 'github');
  assert.equal(formattedMcp[0]!.count, 7);

  wsBucket.byMcp = { filesystem: 4, github: 2 };
  const formattedUses = formatWorkspaceMcpUses(wsBucket.byMcp);
  assert.deepEqual(formattedUses, [
    { server: 'filesystem', count: 4 },
    { server: 'github', count: 2 },
  ]);
});

test('recordUsageEvent updates counters across phase transitions', () => {
  const tracker = new UsageTracker();

  // Phase selected
  tracker.recordUsageEvent({
    phase: 'selected',
    requestId: 'req-1',
    role: 'explorer',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    workspace: { key: 'AutoDev', cwd: 'AutoDev' },
    timestamp: '2026-09-16T12:00:00Z',
  });

  assert.equal(tracker.usageTelemetry.totals.attempts, 1);
  assert.equal(tracker.usageTelemetry.totals.lastUsedAt, '2026-09-16T12:00:00Z');
  assert.equal(tracker.usageTelemetry.byRole.explorer!.attempts, 1);
  assert.equal(tracker.usageTelemetry.byModel['anthropic/claude-3-5-sonnet']!.attempts, 1);
  assert.equal(tracker.usageTelemetry.byOrigin.subagent!.attempts, 1);
  assert.equal(tracker.usageTelemetry.byWorkspace.AutoDev!.attempts, 1);

  // Phase result - success
  tracker.recordUsageEvent({
    phase: 'result',
    requestId: 'req-1',
    role: 'explorer',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    workspace: { key: 'AutoDev', cwd: 'AutoDev' },
    outcome: 'success',
    elapsedMs: 250,
    toolCalls: 3,
    timestamp: '2026-09-16T12:00:01Z',
  });

  assert.equal(tracker.usageTelemetry.totals.successes, 1);
  assert.equal(tracker.usageTelemetry.totals.durationMs, 250);
  assert.equal(tracker.usageTelemetry.totals.maxDurationMs, 250);
  assert.equal(tracker.usageTelemetry.totals.toolCalls, 3);
  assert.equal(tracker.inFlightUsage.size, 0);

  // Phase skipped
  tracker.recordUsageEvent({
    phase: 'skipped',
    requestId: 'req-2',
    role: 'orchestrator',
    provider: 'codex',
    model: 'codex-model',
    timestamp: '2026-09-16T12:00:02Z',
  });
  assert.equal(tracker.usageTelemetry.totals.skipped, 1);

  // Phase result - failure
  tracker.recordUsageEvent({
    phase: 'selected',
    requestId: 'req-3',
    role: 'validator',
    provider: 'openai',
    model: 'gpt-4o',
    timestamp: '2026-09-16T12:00:03Z',
  });
  tracker.recordUsageEvent({
    phase: 'result',
    requestId: 'req-3',
    role: 'validator',
    provider: 'openai',
    model: 'gpt-4o',
    outcome: 'failure',
    failureClass: 'rate_limit',
    status: 429,
    elapsedMs: 50,
    timestamp: '2026-09-16T12:00:04Z',
  });

  assert.equal(tracker.usageTelemetry.totals.failures, 1);
  assert.deepEqual(tracker.usageTelemetry.totals.lastFailure, {
    timestamp: '2026-09-16T12:00:04Z',
    class: 'rate_limit',
    status: 429,
  });
});

test('projectLiveAgents and usageStatus reflect live agent activity', () => {
  const activityTracker = createAgentActivityTracker({ ttlMs: 60000, now: () => 1000 });
  const tracker = new UsageTracker({ activityTracker });

  activityTracker.beginRequest('req-agent-1', {
    requestId: 'req-agent-1',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    role: 'explorer',
    origin: 'subagent',
    workspace: 'RepoX',
  });

  const projection = tracker.projectLiveAgents(1000);
  assert.equal(projection.canonicalTotal, 1);
  assert.equal(projection.byProvider.anthropic, 1);
  assert.equal(projection.byModel['anthropic/claude-3-5-sonnet'], 1);
  assert.equal(projection.byRole.explorer, 1);
  assert.equal(projection.byWorkspace.RepoX, 1);

  const status = tracker.usageStatus(1000, projection);
  assert.equal(status.totals.active, 1);
  assert.equal(status.byWorkspace.RepoX.active, 1);
  assert.equal(status.byRole.explorer!.active, 1);
});

test('usagePersistenceSnapshot and restoreUsagePersistenceSnapshot preserve full telemetry state', () => {
  const tracker = new UsageTracker();

  tracker.registerWorkspaceId('ws-pers', 'RepoPersistence');
  tracker.recordUsageEvent({
    phase: 'selected',
    requestId: 'req-p1',
    role: 'default',
    provider: 'anthropic',
    model: 'sonnet',
    workspace: { key: 'RepoPersistence', cwd: 'RepoPersistence', workspace_id: 'ws-pers' },
    timestamp: '2026-09-16T10:00:00Z',
  });
  tracker.recordUsageEvent({
    phase: 'result',
    requestId: 'req-p1',
    role: 'default',
    provider: 'anthropic',
    model: 'sonnet',
    workspace: { key: 'RepoPersistence', cwd: 'RepoPersistence' },
    outcome: 'success',
    elapsedMs: 120,
    toolCalls: 2,
    timestamp: '2026-09-16T10:00:01Z',
  });

  const wsBucket = tracker.workspaceBucket('RepoPersistence');
  wsBucket.skillUses = 5;
  wsBucket.toolsCapable = true;
  wsBucket.skillsCapable = true;
  wsBucket.mcpCapable = true;
  wsBucket.byMcp = { filesystem: 3 };

  const snapshot = tracker.usagePersistenceSnapshot();
  assert.equal(snapshot.schemaVersion, 8);
  assert.equal((snapshot.totals as any).attempts, 1);
  assert.equal((snapshot.totals as any).successes, 1);
  assert.equal((snapshot.totals as any).toolCalls, 2);
  assert.equal(snapshot.workspaceRegistry.length, 1);

  // Restore into a clean tracker
  const cleanTracker = new UsageTracker();
  cleanTracker.restoreUsagePersistenceSnapshot(snapshot);

  assert.equal(cleanTracker.usageTelemetry.totals.attempts, 1);
  assert.equal(cleanTracker.usageTelemetry.totals.successes, 1);
  assert.equal(cleanTracker.usageTelemetry.totals.durationMs, 120);
  assert.equal(cleanTracker.usageTelemetry.totals.toolCalls, 2);

  const restoredWs = cleanTracker.workspaceBucket('RepoPersistence');
  assert.equal(restoredWs.attempts, 1);
  assert.equal(restoredWs.skillUses, 5);
  assert.equal(restoredWs.toolsCapable, true);
  assert.equal(restoredWs.skillsCapable, true);
  assert.equal(restoredWs.mcpCapable, true);
  assert.equal(restoredWs.byMcp.filesystem, 3);
  assert.equal(cleanTracker.workspaceIdRegistry.get(safeWorkspaceId('ws-pers')), 'RepoPersistence');

  // Verify unsupported schema versions fail closed (do not alter state)
  const emptyStateTracker = new UsageTracker();
  emptyStateTracker.restoreUsagePersistenceSnapshot({ schemaVersion: 6, totals: { attempts: 999 } });
  assert.equal(emptyStateTracker.usageTelemetry.totals.attempts, 0);

  // Verify clearWorkspaceCapabilities
  cleanTracker.clearWorkspaceCapabilities();
  assert.equal(restoredWs.toolsCapable, false);
  assert.equal(restoredWs.skillsCapable, false);
  assert.equal(restoredWs.mcpCapable, false);
  assert.equal(restoredWs.skillUses, 0);
});

test('default instance convenience exports delegate correctly', () => {
  resetUsageTelemetry();
  resetAttributionDiagnostics();

  assert.equal(registerWorkspaceId('ws-default', 'DefaultRepo'), true);
  recordUsageEvent({
    phase: 'selected',
    requestId: 'req-def',
    role: 'worker',
    provider: 'anthropic',
    model: 'sonnet',
    workspace: { key: 'DefaultRepo', cwd: 'DefaultRepo' },
    timestamp: '2026-09-16T15:00:00Z',
  });

  const snapshot = usagePersistenceSnapshot();
  assert.equal((snapshot.totals as any).attempts, 1);

  const status = usageStatus();
  assert.equal(status.totals.attempts, 1);

  clearWorkspaceCapabilities();
  resetUsageTelemetry();
  assert.equal(usageStatus().totals.attempts, 0);
});
