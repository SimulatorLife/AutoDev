import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureMiniMaxProxy, isMiniMaxModel, resolveMiniMaxEnsureOptions, type MiniMaxEnsureDeps, type MiniMaxEnsureOptions } from '../../src/platform/minimax-ensure.ts';

function options(overrides: Partial<MiniMaxEnsureOptions> = {}): MiniMaxEnsureOptions {
  return { host: '127.0.0.1', port: 18765, model: 'MiniMax-M3', label: 'com.codex.minimax-proxy', plist: '/tmp/minimax.plist', launcher: '/tmp/minimax.sh', proxyScript: '/tmp/minimax.ts', nodeBin: '/usr/bin/node', upstreamBaseUrl: 'https://api.minimax.io', readyTimeoutMs: 20, logPath: '/tmp/minimax.log', ...overrides };
}

function deps(overrides: Partial<MiniMaxEnsureDeps> = {}): MiniMaxEnsureDeps {
  return {
    launchd: { isLoaded: () => false, kickstart: () => {}, bootstrap: () => {} },
    probe: async () => false,
    sleep: async () => {},
    nodeAvailable: () => true,
    plistExists: () => false,
    startFallback: () => {},
    ...overrides,
  };
}

test('MiniMax model gate does not claim other providers', () => {
  assert.equal(isMiniMaxModel('{"model":"MiniMax-M3"}'), true);
  assert.equal(isMiniMaxModel('{"model":"minimax-m3"}'), false);
  assert.equal(isMiniMaxModel('{"model":"sonnet"}'), false);
});

test('MiniMax resolver points fallback execution at the typed provider module', () => {
  const result = resolveMiniMaxEnsureOptions({ HOME: '/home/test', CODEX_HOME: '/home/test/.codex', AUTODEV_NODE: '/opt/node' });
  assert.equal(result.proxyScript, '/home/test/.codex/src/providers/minimax.ts');
  assert.equal(result.nodeBin, '/opt/node');
  assert.equal(result.logPath, '/home/test/.codex/run/codex-minimax-proxy-18765.log');
});

test('non-MiniMax subagents do not start the compatibility proxy', async () => {
  let starts = 0;
  assert.equal(await ensureMiniMaxProxy('{"model":"sonnet"}', options(), deps({ startFallback: () => { starts += 1; } })), 0);
  assert.equal(starts, 0);
});

test('MiniMax proxy is started through the typed fallback boundary', async () => {
  let seen: MiniMaxEnsureOptions | undefined;
  const result = await ensureMiniMaxProxy('{"model":"MiniMax-M3"}', options(), deps({
    startFallback: (value) => { seen = value; },
    probe: (() => { let calls = 0; return async () => ++calls > 1; })(),
  }));
  assert.equal(result, 0);
  assert.equal(seen?.proxyScript, '/tmp/minimax.ts');
});

test('MiniMax does not use a fallback when launchd owns a configured plist', async () => {
  let started = false;
  const result = await ensureMiniMaxProxy('{"model":"MiniMax-M3"}', options(), deps({ plistExists: () => true, startFallback: () => { started = true; } }));
  assert.equal(result, 1);
  assert.equal(started, false);
});
