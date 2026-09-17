import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionStart } from '../../src/hooks/session-start.ts';
import type { RouterEnsureDeps, RouterEnsureOptions, RouterEnsureResult } from '../../src/platform/router-ensure.ts';
import { createSubagentStart } from '../../src/hooks/subagent-start.ts';
import { runRootDelegation } from '../../src/hooks/root-delegation.ts';

function withCodexHome<T>(callback: (home: string) => T): T {
  const previous = process.env.CODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), 'autodev-hooks-'));
  process.env.CODEX_HOME = home;
  try { return callback(home); }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test('session-start delegates the typed ensure runner and preserves a healthy status', async () => withCodexHome(async (home) => {
  const seen: { deps: RouterEnsureDeps; options: RouterEnsureOptions }[] = [];
  const runner = {
    async runRouterEnsure(deps: RouterEnsureDeps, options: RouterEnsureOptions): Promise<RouterEnsureResult> {
      seen.push({ deps, options });
      return { status: 'healthy-launchd', exitCode: 0 };
    },
  };
  const run = createSessionStart(runner);
  assert.equal(await run(Buffer.from('{"event":"start"}')), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.options.paths.codexHome, home);
}));

test('session-start surfaces the typed exit code from the ensure runner', async () => {
  const runner = {
    async runRouterEnsure(): Promise<RouterEnsureResult> {
      return { status: 'launchd-failed', exitCode: 1, message: 'launchd down' };
    },
  };
  const run = createSessionStart(runner);
  assert.equal(await run(Buffer.from('{}')), 1);
});

test('subagent-start calls typed provider owners in order and fails closed', async () => {
  const calls: string[] = [];
  const run = createSubagentStart({
    claude: async (input) => { calls.push(`claude:${input}`); return 0; },
    minimax: async (input) => { calls.push(`minimax:${input}`); return 0; },
    antigravity: async (input) => { calls.push(`antigravity:${input}`); return 0; },
  });
  assert.equal(await run(Buffer.from('{\"model\":\"MiniMax-M3\"}')), 0);
  assert.deepEqual(calls, [
    'claude:{\"model\":\"MiniMax-M3\"}',
    'minimax:{\"model\":\"MiniMax-M3\"}',
    'antigravity:{\"model\":\"MiniMax-M3\"}',
  ]);
});

test('root-delegation skips configured leaf models', async () => {
  assert.equal(await runRootDelegation('{"model":"autodev/worker"}'), 0);
});
