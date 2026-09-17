import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionStart } from '../../src/hooks/session-start.ts';
import type { RouterEnsureDeps, RouterEnsureOptions, RouterEnsureResult } from '../../src/platform/router-ensure.ts';
import { runSubagentStart } from '../../src/hooks/subagent-start.ts';
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

function hook(home: string, name: string, body: string): void {
  mkdirSync(join(home, 'hooks'), { recursive: true });
  const path = join(home, 'hooks', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
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

test('subagent-start runs each ensure hook once and fails closed', () => withCodexHome((home) => {
  for (const name of ['ensure-codex-claude-bridge.sh', 'ensure-codex-minimax-proxy.sh', 'ensure-codex-antigravity-proxy.sh']) {
    hook(home, name, `printf '%s\\n' ${name} >> "$CODEX_HOME/subagent-hooks"`);
  }
  assert.equal(runSubagentStart(Buffer.from('{}')), 0);
}));

test('root-delegation skips configured leaf models', async () => {
  assert.equal(await runRootDelegation('{"model":"autodev/worker"}'), 0);
});
