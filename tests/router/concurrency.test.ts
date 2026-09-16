import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentActivityTracker } from '../../src/agents/agent-activity.ts';
import {
  ConcurrencyManager,
  matchAgentsContext,
  parseConcurrencyConfig,
  PROCESS_FALLBACK_SESSION_KEY,
  SUBAGENT_SLOT_KIND,
} from '../../src/router/concurrency.ts';

test('parseConcurrencyConfig parses multiline and inline tables and rejects legacy max_threads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'concurrency-test-'));
  const file = join(dir, 'config.toml');
  try {
    await writeFile(file, '[agents]\nenabled = true\nmax_concurrent_threads_per_session = 3\n');
    assert.deepEqual(parseConcurrencyConfig(file), { file, maxConcurrentThreadsPerSession: 3 });

    await writeFile(file, 'agents = { max_concurrent_threads_per_session = 5 }\n');
    assert.deepEqual(parseConcurrencyConfig(file), { file, maxConcurrentThreadsPerSession: 5 });

    await writeFile(file, '[agents]\nmax_threads = 10\n');
    assert.deepEqual(parseConcurrencyConfig(file), { file, maxConcurrentThreadsPerSession: null });

    await writeFile(file, '[agents]\nmax_concurrent_threads_per_session = 0\n');
    assert.deepEqual(parseConcurrencyConfig(file), { file, maxConcurrentThreadsPerSession: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('matchAgentsContext extracts context cleanly', () => {
  assert.equal(matchAgentsContext('[agents]\nfoo=1\n[other]\nbar=2'), 'foo=1\n');
  assert.equal(matchAgentsContext('agents = { a = 1, b = { c = 2 } }\nother = 3'), ' a = 1, b = { c = 2 } ');
  assert.equal(matchAgentsContext('no_agents_here = true'), '');
});

test('ConcurrencyManager admits and releases subagent slots up to configured limit', () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: { file: '/fake/config.toml', maxConcurrentThreadsPerSession: 2 },
  });

  assert.equal(manager.effectivePerSessionLimit(), 2);
  assert.equal(manager.tryAcquireSubagentSlot('session-1'), null);
  assert.equal(manager.tryAcquireSubagentSlot('session-1'), null);
  assert.equal(manager.tryAcquireSubagentSlot('session-1'), 'max_concurrent_threads_per_session');

  // Another session has its own limit budget
  assert.equal(manager.tryAcquireSubagentSlot('session-2'), null);

  // Status check
  const status = manager.concurrencyStatus();
  assert.equal(status.maxConcurrentThreadsPerSession, 2);
  assert.equal(status.activeSubagentThreads, 3);
  assert.equal(status.activeSessions, 2);

  // Release a slot
  manager.releaseSubagentSlot('session-1');
  assert.equal(manager.tryAcquireSubagentSlot('session-1'), null);

  // Denial recording
  manager.recordConcurrencyDenial('max_concurrent_threads_per_session');
  assert.equal(manager.telemetry.denials, 1);
  assert.equal(manager.telemetry.denialsByReason['max_concurrent_threads_per_session'], 1);

  // Reset
  manager.resetConcurrencyTelemetry();
  assert.equal(manager.telemetry.denials, 0);
  assert.equal(manager.activeSubagentThreads(), 0);
});

test('ConcurrencyManager supports process-fallback session key', () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: { file: '/fake/config.toml', maxConcurrentThreadsPerSession: 1 },
  });

  assert.equal(manager.tryAcquireSubagentSlot(PROCESS_FALLBACK_SESSION_KEY), null);
  const status = manager.concurrencyStatus();
  assert.equal(status.processFallbackActiveThreads, 1);
  assert.equal(status.processFallbackEnforcement, true);

  manager.releaseSubagentSlot(PROCESS_FALLBACK_SESSION_KEY);
  assert.equal(manager.concurrencyStatus().processFallbackActiveThreads, 0);
});

test('ConcurrencyManager restores serialized telemetry', () => {
  const activity = createAgentActivityTracker();
  const manager = new ConcurrencyManager({
    agentActivity: activity,
    initialConfig: { file: '/fake/config.toml', maxConcurrentThreadsPerSession: 2 },
  });

  manager.restoreTelemetry({
    denials: 4,
    denialsByReason: { max_concurrent_threads_per_session: 4 },
    lastDenial: {
      timestamp: '2026-09-16T12:00:00.000Z',
      reason: 'max_concurrent_threads_per_session',
      requestId: 'req-restored',
    },
  });

  assert.equal(manager.telemetry.denials, 4);
  assert.equal(manager.telemetry.denialsByReason['max_concurrent_threads_per_session'], 4);
  assert.equal(manager.telemetry.lastDenial?.requestId, 'req-restored');

  const status = manager.concurrencyStatus();
  assert.equal(status.denials, 4);
  assert.equal(status.lastDenial?.requestId, 'req-restored');
});
