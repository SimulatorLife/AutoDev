import assert from 'node:assert/strict';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PERSISTED_STATE_SCHEMA,
  RouterPersistence,
  effectiveStateFile,
  getDefaultPersistenceManager,
  loadRouterState,
  persistRouterStateNow,
  restoreProviderTelemetrySection,
  scheduleRouterStatePersist,
  serializeRouterState,
  setDefaultPersistenceManager,
} from '../../src/router/persistence.ts';

test('effectiveStateFile resolves custom, environment, or default path', () => {
  assert.equal(effectiveStateFile('/custom/file.json'), '/custom/file.json');

  const origEnv = process.env.CODEX_ROUTER_STATE_FILE;
  try {
    process.env.CODEX_ROUTER_STATE_FILE = '/env/path.json';
    assert.equal(effectiveStateFile(), '/env/path.json');
  } finally {
    if (origEnv === undefined) {
      delete process.env.CODEX_ROUTER_STATE_FILE;
    } else {
      process.env.CODEX_ROUTER_STATE_FILE = origEnv;
    }
  }
});

test('RouterPersistence serialize produces valid envelope with schema and timestamp', () => {
  const persistence = new RouterPersistence({
    getSnapshot: () => ({
      disabledProviders: ['codex'],
      concurrency: { total: 5 },
    }),
  });

  const serialized = persistence.serialize();
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.schema, `${PERSISTED_STATE_SCHEMA}-v3`);
  assert.ok(typeof parsed.updatedAt === 'string');
  assert.deepEqual(parsed.disabledProviders, ['codex']);
  assert.deepEqual(parsed.concurrency, { total: 5 });

  // Custom snapshot overrides
  const custom = persistence.serialize({ customField: 42 });
  assert.equal(JSON.parse(custom).customField, 42);
});

test('RouterPersistence persistNow writes atomically with mode 0o600', async () => {
  const testFile = join(tmpdir(), `autodev-persistence-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    const persistence = new RouterPersistence({
      stateFile: testFile,
      getSnapshot: () => ({ subagents: { total: 3 } }),
    });

    assert.equal(persistence.getUpdatedAt(), null);
    await persistence.persistNow();

    assert.ok(persistence.getUpdatedAt() !== null);

    const fileStat = await stat(testFile);
    assert.ok(fileStat.isFile());
    // Mode should be 0o600 (modulo umask on some OSes, permissions check lower 9 bits)
    const mode = fileStat.mode & 0o777;
    assert.equal(mode, 0o600);

    // Verify content
    const loaded = new RouterPersistence({ stateFile: testFile });
    let restoredSubagents: any = null;
    const ok = loaded.load();
    assert.equal(ok, true);
    assert.ok(loaded.getUpdatedAt() !== null);
  } finally {
    try {
      await unlink(testFile);
    } catch {
      /* ignore */
    }
  }
});

test('RouterPersistence load validates schema and dispatches sections', async () => {
  const testFile = join(tmpdir(), `autodev-persistence-load-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    // Non-existent file returns false
    const persistence = new RouterPersistence({ stateFile: testFile });
    assert.equal(persistence.load(), false);

    // Invalid JSON returns false
    await writeFile(testFile, 'not-valid-json', 'utf8');
    assert.equal(persistence.load(), false);

    // Non-matching schema returns false
    await writeFile(testFile, JSON.stringify({ schema: 'other-schema', subagents: { total: 1 } }), 'utf8');
    assert.equal(persistence.load(), false);

    // Valid state file loads and restores sections
    const state = {
      schema: `${PERSISTED_STATE_SCHEMA}-v3`,
      updatedAt: '2026-09-16T12:00:00.000Z',
      disabledProviders: ['copilot'],
      subagents: { total: 10 },
      customSection: { foo: 'bar' },
    };
    await writeFile(testFile, JSON.stringify(state), 'utf8');

    const restored: Record<string, unknown> = {};
    let postRestoreCalled = false;

    const loader = new RouterPersistence({
      stateFile: testFile,
      restoreSection: (section, value) => {
        restored[section] = value;
      },
      onPostRestore: (fullParsed) => {
        assert.equal(fullParsed.schema, `${PERSISTED_STATE_SCHEMA}-v3`);
        postRestoreCalled = true;
      },
    });

    assert.equal(loader.load(), true);
    assert.equal(loader.getUpdatedAt(), '2026-09-16T12:00:00.000Z');
    assert.deepEqual(restored.disabledProviders, ['copilot']);
    assert.deepEqual(restored.subagents, { total: 10 });
    assert.deepEqual(restored.customSection, { foo: 'bar' });
    assert.equal(postRestoreCalled, true);
  } finally {
    try {
      await unlink(testFile);
    } catch {
      /* ignore */
    }
  }
});

test('RouterPersistence schedulePersist debounces writes', async () => {
  const testFile = join(tmpdir(), `autodev-persistence-sched-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    let snapshotCounter = 0;
    const persistence = new RouterPersistence({
      stateFile: testFile,
      debounceMs: 50,
      isMain: true,
      getSnapshot: () => ({ counter: ++snapshotCounter }),
    });

    persistence.schedulePersist();
    persistence.schedulePersist(); // coalesced

    // Immediately after scheduling, file should not exist yet
    let existsImmediately = false;
    try {
      await stat(testFile);
      existsImmediately = true;
    } catch {
      existsImmediately = false;
    }
    assert.equal(existsImmediately, false);

    // Wait for debounce to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fileStat = await stat(testFile);
    assert.ok(fileStat.isFile());
    assert.equal(snapshotCounter, 1);
  } finally {
    try {
      await unlink(testFile);
    } catch {
      /* ignore */
    }
  }
});

test('restoreProviderTelemetrySection restores telemetry maps and records', () => {
  const currentMap = new Map([
    [
      'claude',
      {
        attempts: 0,
        successes: 0,
        failures: 0,
        skipped: 0,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureClass: null,
        lastFailure: null,
      },
    ],
  ]);

  restoreProviderTelemetrySection(currentMap, {
    claude: {
      attempts: 5,
      successes: 4,
      failures: 1,
      skipped: 0,
      lastAttemptAt: '2026-09-16T10:00:00.000Z',
      lastSuccessAt: '2026-09-16T10:00:05.000Z',
      lastFailureAt: '2026-09-16T09:59:00.000Z',
      lastFailureClass: 'timeout',
      lastFailure: { code: 'ETIMEDOUT' },
    },
    unknownProvider: {
      attempts: 99,
    },
  });

  const claudeState = currentMap.get('claude')!;
  assert.equal(claudeState.attempts, 5);
  assert.equal(claudeState.successes, 4);
  assert.equal(claudeState.failures, 1);
  assert.equal(claudeState.lastFailureClass, 'timeout');
  assert.deepEqual(claudeState.lastFailure, { code: 'ETIMEDOUT' });
  assert.equal(currentMap.has('unknownProvider'), false);
});

test('convenience functions delegate to default persistence manager', async () => {
  const custom = new RouterPersistence({
    getSnapshot: () => ({ defaultTest: true }),
  });
  setDefaultPersistenceManager(custom);
  assert.equal(getDefaultPersistenceManager(), custom);

  const serialized = serializeRouterState();
  assert.equal(JSON.parse(serialized).defaultTest, true);

  setDefaultPersistenceManager(null);
});
