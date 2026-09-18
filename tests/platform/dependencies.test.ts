import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCocoIndex, installCocoIndex, installPythonLanguageServer, resolveDependencyOptions, type DependencyDeps, type DependencyOptions } from '../../src/platform/dependencies.ts';

function options(overrides: Partial<DependencyOptions> = {}): DependencyOptions {
  return { cocoindexPackage: 'cocoindex-code[full]==0.2.41', pythonLanguageServerPackage: 'python-lsp-server==1.15.0', skipCocoIndex: false, skipLanguageServer: false, skipPipx: false, ...overrides };
}

function deps(overrides: Partial<DependencyDeps> = {}): DependencyDeps {
  return { commandPath: () => null, capture: () => null, run: () => 0, fileExists: () => false, platform: 'linux', ...overrides };
}

test('dependency options read the installer skip switches', () => {
  assert.deepEqual(resolveDependencyOptions({ AUTODEV_SKIP_COCOINDEX_INSTALL: '1', AUTODEV_SKIP_LSP_INSTALL: '1', AUTODEV_SKIP_PIPX_INSTALL: '1' }), {
    cocoindexPackage: 'cocoindex-code[full]==0.2.41', pythonLanguageServerPackage: 'python-lsp-server==1.15.0', skipCocoIndex: true, skipLanguageServer: true, skipPipx: true,
  });
});

test('CocoIndex installation uses typed pipx and Homebrew boundaries', () => {
  let pipx = false;
  const calls: string[][] = [];
  const result = installCocoIndex(options(), deps({
    commandPath: (command) => command === 'brew' ? '/opt/homebrew/bin/brew' : command === 'pipx' && pipx ? '/opt/homebrew/bin/pipx' : null,
    run: (command, args) => { calls.push([command, ...args]); if (command.endsWith('/brew') || command === 'brew') pipx = true; return 0; },
  }));
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    ['/opt/homebrew/bin/brew', 'install', 'pipx'],
    ['/opt/homebrew/bin/pipx', 'ensurepath'],
    ['/opt/homebrew/bin/pipx', 'install', 'cocoindex-code[full]==0.2.41'],
  ]);
});

test('Python language-server installation falls back to python user installs when Homebrew is absent', () => {
  let pipx = false;
  const calls: string[][] = [];
  const result = installPythonLanguageServer(options(), deps({
    commandPath: (command) => command === 'python3' ? '/usr/bin/python3' : command === 'pipx' && pipx ? '/home/test/.local/bin/pipx' : null,
    run: (command, args) => { calls.push([command, ...args]); if (args.join(' ') === '-m pip install --user pipx') pipx = true; return 0; },
  }));
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    ['/usr/bin/python3', '-m', 'pip', 'install', '--user', 'pipx'],
    ['/home/test/.local/bin/pipx', 'ensurepath'],
    ['/home/test/.local/bin/pipx', 'install', 'python-lsp-server==1.15.0'],
  ]);
});

test('dependency checks honor explicit skips and fail closed when tools are missing', () => {
  assert.equal(checkCocoIndex(options({ skipCocoIndex: true }), deps()), 0);
  assert.equal(checkCocoIndex(options(), deps()), 1);
});
