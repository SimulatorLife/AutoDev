import assert from 'node:assert/strict';
import test from 'node:test';
import { createMacosServiceLifecycle } from '../../src/hooks/lifecycle.ts';
import { LaunchdClient, LaunchdError, type CommandResult } from '../../src/platform/macos/launchd.ts';

test('macOS lifecycle uses typed launchd operations without shell interpolation', () => {
  const calls: string[][] = [];
  const runner = (_command: string, args: string[]): CommandResult => {
    calls.push(args);
    return { stdout: args[0] === 'print' ? 'gui/501/com.autodev.router' : '', stderr: '', status: 0 };
  };
  const client = new LaunchdClient({ runner, uid: 501 });
  const lifecycle = createMacosServiceLifecycle(client);
  const service = { label: 'com.autodev.router', plist: '/tmp/router.plist' };
  lifecycle.bootstrap(service);
  lifecycle.restart(service);
  assert.equal(lifecycle.isHealthy(service), true);
  assert.deepEqual(calls, [
    ['print', 'gui/501/com.autodev.router'],
    ['bootout', 'gui/501/com.autodev.router'],
    ['bootstrap', 'gui/501', '/tmp/router.plist'],
    ['print', 'gui/501/com.autodev.router'],
    ['kickstart', '-k', 'gui/501/com.autodev.router'],
    ['print', 'gui/501/com.autodev.router'],
    ['print', 'gui/501/com.autodev.router'],
  ]);
});

test('launchd failures preserve structured command evidence', () => {
  const client = new LaunchdClient({ runner: () => ({ stdout: '', stderr: 'denied', status: 1 }), uid: 501 });
  assert.throws(() => client.bootstrap('/tmp/router.plist'), (error: unknown) => {
    assert.equal(error instanceof LaunchdError, true);
    assert.equal((error as LaunchdError).result?.stderr, 'denied');
    return true;
  });
});
