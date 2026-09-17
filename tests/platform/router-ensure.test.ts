import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  __testing,
  createDefaultRouterEnsureDeps,
  resolveRouterEnsureOptions,
  runRouterEnsure,
  type RouterEnsureDeps,
  type RouterEnsureOptions,
  type RouterEnsureResult,
} from '../../src/platform/router-ensure.ts';
import { LaunchdClient } from '../../src/platform/macos/launchd.ts';

function withTempHome<T>(callback: (home: string) => T): T {
  const previous = process.env.CODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), 'autodev-router-ensure-'));
  process.env.CODEX_HOME = home;
  try { return callback(home); }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function defaultPaths(home: string): RouterEnsureOptions['paths'] {
  const runDir = join(home, 'run');
  const ensureLock = join(runDir, 'codex-model-router.ensure.lock');
  return {
    codexHome: home,
    runDir,
    launchdRunDir: runDir,
    ensureLock,
    lockDir: `${ensureLock}.d`,
    fallbackLog: join(runDir, 'codex-model-router.fallback.log'),
    fallbackPidFile: join(runDir, 'codex-model-router.fallback.pid'),
    launcher: join(home, 'hooks', 'run-codex-model-router.sh'),
    plistLink: join(home, 'Library', 'LaunchAgents', 'com.codex.model-router.plist'),
    launchdLogOut: join(runDir, 'codex-model-router.launchd.out.log'),
    launchdLogErr: join(runDir, 'codex-model-router.launchd.err.log'),
  };
}

function defaultOptions(home: string, overrides: Partial<RouterEnsureOptions> = {}): RouterEnsureOptions {
  return {
    paths: defaultPaths(home),
    label: 'com.codex.model-router',
    domain: 'gui/501',
    routerHost: '127.0.0.1',
    routerPort: 4100,
    readyTimeoutMs: 200,
    fallbackLogMaxBytes: 10 * 1024 * 1024,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    myPid: process.pid,
    ...overrides,
  };
}

interface FakeLaunchd {
  calls: string[][];
  loaded: boolean;
  printOutput: string;
  throwOnPrint?: boolean;
  throwOnKickstart?: boolean;
  throwOnBootstrap?: boolean;
}

function fakeLaunchdClient(fake: FakeLaunchd): LaunchdClient {
  const runner = (command: string, args: string[]): { stdout: string; stderr: string; status: number | null } => {
    fake.calls.push(args);
    if (args[0] === 'print' && args[1]) {
      if (fake.throwOnPrint) return { stdout: '', stderr: 'denied', status: 1 };
      return { stdout: fake.printOutput, stderr: '', status: fake.loaded ? 0 : 1 };
    }
    if (args[0] === 'kickstart' && fake.throwOnKickstart) return { stdout: '', stderr: 'kickstart failed', status: 1 };
    if (args[0] === 'bootstrap' && fake.throwOnBootstrap) return { stdout: '', stderr: 'bootstrap failed', status: 1 };
    if (args[0] === 'bootstrap') fake.loaded = true;
    if (args[0] === 'kickstart') fake.loaded = true;
    return { stdout: '', stderr: '', status: 0 };
  };
  return new LaunchdClient({ runner, uid: 501 });
}

type FileState = { kind: 'dir' } | { kind: 'file'; data: string } | { kind: 'symlink' };

class FakeFs {
  private readonly files = new Map<string, FileState>();
  readonly calls: { name: string; args: unknown[] }[] = [];

  private entries(path: string): { name: string; state: FileState }[] {
    const out: { name: string; state: FileState }[] = [];
    for (const [key, value] of this.files) {
      if (key === path) out.push({ name: key, state: value });
    }
    return out;
  }

  has(path: string): boolean { return this.files.has(path); }
  get(path: string): FileState | undefined { return this.files.get(path); }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push({ name: 'mkdir', args: [path] });
    const existing = this.files.get(path);
    if (existing && existing.kind === 'file') throw new Error(`EEXIST: ${path}`);
    if (existing && existing.kind === 'dir' && !options?.recursive) throw new Error(`EEXIST: ${path}`);
    this.files.set(path, { kind: 'dir' });
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.calls.push({ name: 'chmod', args: [path, mode] });
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    this.files.set(`${path}__mode`, { kind: 'file', data: mode.toString(8) });
  }

  async lstat(path: string): Promise<{ isSymbolicLink(): boolean } | null> {
    this.calls.push({ name: 'lstat', args: [path] });
    const v = this.files.get(path);
    if (!v) return null;
    if (v.kind === 'symlink') return { isSymbolicLink: () => true };
    return { isSymbolicLink: () => false };
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.calls.push({ name: 'writeFile', args: [path, data] });
    this.files.set(path, { kind: 'file', data });
  }

  async readFile(path: string): Promise<string> {
    this.calls.push({ name: 'readFile', args: [path] });
    const v = this.files.get(path);
    if (!v || v.kind === 'dir' || v.kind === 'symlink') return '';
    return v.data;
  }

  async unlink(path: string): Promise<void> {
    this.calls.push({ name: 'unlink', args: [path] });
    this.files.delete(path);
    this.files.delete(`${path}__mode`);
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push({ name: 'rename', args: [from, to] });
    if (!this.files.has(from)) throw new Error(`ENOENT: ${from}`);
    const v = this.files.get(from);
    if (v !== undefined) {
      this.files.delete(from);
      this.files.set(to, v);
    }
  }

  async stat(path: string): Promise<{ size: number } | null> {
    this.calls.push({ name: 'stat', args: [path] });
    const v = this.files.get(path);
    if (!v || v.kind === 'dir' || v.kind === 'symlink') return null;
    return { size: v.data.length };
  }
}

interface MakeDepsOptions {
  home: string;
  fake: FakeLaunchd;
  fs: FakeFs;
  probeResult?: boolean | (() => boolean);
  pidExists?: (pid: number) => boolean;
  pidCommandLine?: (pid: number) => string | null;
  listenerPid?: (port: number) => number | null;
  startLauncher?: RouterEnsureDeps['startLauncher'];
  nextLauncherPid?: () => number;
  nextLauncherPids?: number[];
  launcherAppends?: string[];
}

interface MakeDepsOptions {
  home: string;
  fake: FakeLaunchd;
  fs: FakeFs;
  probeResult?: boolean | (() => boolean);
  pidExists?: (pid: number) => boolean;
  pidCommandLine?: (pid: number) => string | null;
  listenerPid?: (port: number) => number | null;
  startLauncher?: RouterEnsureDeps['startLauncher'];
  nextLauncherPid?: () => number;
  nextLauncherPids?: number[];
  launcherAppends?: string[];
}

function makeDeps(opts: MakeDepsOptions): RouterEnsureDeps & { fake: FakeLaunchd; fs: FakeFs } {
  const probeFn: RouterEnsureDeps['probe'] = async () => {
    const value = opts.probeResult;
    if (typeof value === 'function') return Boolean(value());
    return value ?? false;
  };
  const startLauncher: RouterEnsureDeps['startLauncher'] = opts.startLauncher ?? ((_cmd, _args, logPath) => {
    const pid = opts.nextLauncherPid ? opts.nextLauncherPid() : (opts.nextLauncherPids?.shift() ?? 8888);
    if (opts.launcherAppends) {
      const current = opts.fs['files'].get(logPath);
      const base = current && current.kind === 'file' ? current.data : '';
      const next = base + (base.endsWith('\n') || base === '' ? '' : '\n') + opts.launcherAppends.join('\n') + '\n';
      opts.fs['files'].set(logPath, { kind: 'file', data: next });
    }
    return { pid };
  });
  return {
    launchd: fakeLaunchdClient(opts.fake),
    fake: opts.fake,
    fs: opts.fs,
    probe: probeFn,
    pidExists: opts.pidExists ?? ((pid) => pid > 0),
    pidCommandLine: opts.pidCommandLine ?? (() => ''),
    listenerPid: opts.listenerPid ?? (() => null),
    startLauncher,
    signalPid: (pid, signal) => { opts.fs.calls.push({ name: `signal-${signal}`, args: [pid] }); return true; },
    sleep: async () => { /* no-op */ },
    now: () => Date.now(),
    mkdir: (path, o) => opts.fs.mkdir(path, o),
    chmod: (path, mode) => opts.fs.chmod(path, mode),
    lstat: (path) => opts.fs.lstat(path),
    writeFile: (path, data) => opts.fs.writeFile(path, data),
    readFile: (path) => opts.fs.readFile(path),
    unlink: (path) => opts.fs.unlink(path),
    rename: (from, to) => opts.fs.rename(from, to),
    stat: (path) => opts.fs.stat(path),
    setExitHandler: () => () => { /* no-op for tests */ },
  };
}

test('parses launchd pid output ignoring label and surrounding whitespace', () => {
  assert.equal(__testing.parseLaunchdPid('com.codex.model-router\n    state = running\n    pid = 4242\n    program = /bin/bash'), 4242);
  assert.equal(__testing.parseLaunchdPid('state = running'), null);
});

test('acquireLock succeeds when no lock is held and writes a private pid marker', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({ home, fake: { calls: [], loaded: false, printOutput: '' }, fs });
    const options = defaultOptions(home);
    const ok = await __testing.acquireLock(deps, options);
    assert.equal(ok, true);
    const pidFile = fs.get(`${options.paths.lockDir}/pid`);
    assert.ok(pidFile && pidFile.kind === 'file', 'pid file is written');
    const pidFileData = pidFile.kind === 'file' ? pidFile.data : '';
    assert.match(pidFileData, /^[0-9]+/);
    const lockMode = fs.get(`${options.paths.lockDir}__mode`);
    assert.equal(lockMode && lockMode.kind === 'file' ? lockMode.data : null, '700');
    const pidMode = fs.get(`${options.paths.lockDir}/pid__mode`);
    assert.equal(pidMode && pidMode.kind === 'file' ? pidMode.data : null, '600');
  });
});

test('acquireLock refuses when a live lock is held by another process', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.lockDir, { kind: 'dir' });
    fs['files'].set(`${paths.lockDir}/pid`, { kind: 'file', data: '9999' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      pidExists: (pid) => pid === 9999,
    });
    const ok = await __testing.acquireLock(deps, defaultOptions(home));
    assert.equal(ok, false);
    const pidFile = fs.get(`${paths.lockDir}/pid`);
    assert.ok(pidFile && pidFile.kind === 'file' && pidFile.data === '9999');
  });
});

test('acquireLock recovers from a stale lock whose owner is no longer alive', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.lockDir, { kind: 'dir' });
    fs['files'].set(`${paths.lockDir}/pid`, { kind: 'file', data: '9999' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      pidExists: (pid) => pid !== 9999,
    });
    const ok = await __testing.acquireLock(deps, defaultOptions(home));
    assert.equal(ok, true);
    const pidFile = fs.get(`${paths.lockDir}/pid`);
    assert.ok(pidFile && pidFile.kind === 'file');
    const pidFileData = pidFile.kind === 'file' ? pidFile.data : '';
    assert.match(pidFileData, /^[0-9]+/);
    const pidFileData2 = pidFile.kind === 'file' ? pidFile.data : '';
    assert.notEqual(pidFileData2, '9999');
  });
});

test('secureLogFile creates an empty log file with mode 0600 when missing', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({ home, fake: { calls: [], loaded: false, printOutput: '' }, fs });
    const logPath = join(home, 'plain.log');
    await __testing.secureLogFile(deps, logPath);
    const created = fs.get(logPath);
    assert.ok(created && created.kind === 'file' && created.data === '');
    const mode = fs.get(`${logPath}__mode`);
    assert.ok(mode && mode.kind === 'file' && mode.data === '600');
  });
});

test('secureLogFile refuses to use a symlinked log path', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const logPath = join(home, 'linked.log');
    fs['files'].set(logPath, { kind: 'symlink' });
    const deps = makeDeps({ home, fake: { calls: [], loaded: false, printOutput: '' }, fs });
    await assert.rejects(async () => __testing.secureLogFile(deps, logPath), /symlinked/);
    assert.equal(fs.has(`${logPath}__mode`), false);
  });
});

test('fallbackPidOwned matches the launchd launcher or the node entrypoint', () => {
  const depsA = makeDeps({ home: '/tmp/x', fake: { calls: [], loaded: false, printOutput: '' }, fs: new FakeFs(), pidCommandLine: () => 'bash /Users/test/.codex/hooks/run-codex-model-router.sh' });
  const depsB = makeDeps({ home: '/tmp/x', fake: { calls: [], loaded: false, printOutput: '' }, fs: new FakeFs(), pidCommandLine: () => '/usr/local/bin/node /Users/test/.codex/scripts/codex-model-router.mjs' });
  const depsC = makeDeps({ home: '/tmp/x', fake: { calls: [], loaded: false, printOutput: '' }, fs: new FakeFs(), pidCommandLine: () => 'vim' });
  assert.equal(__testing.fallbackPidOwned(depsA, 1), true);
  assert.equal(__testing.fallbackPidOwned(depsB, 2), true);
  assert.equal(__testing.fallbackPidOwned(depsC, 3), false);
});

test('launchdOwnsListener requires both the launchd child pid and the listening pid to match', () => {
  const deps1 = makeDeps({ home: '/tmp/x', fake: { calls: [], loaded: false, printOutput: '' }, fs: new FakeFs(), listenerPid: () => 4242 });
  const deps2 = makeDeps({ home: '/tmp/x', fake: { calls: [], loaded: false, printOutput: '' }, fs: new FakeFs(), listenerPid: () => 9999 });
  const opts = defaultOptions('/tmp/x');
  assert.equal(__testing.launchdOwnsListener(deps1, opts, 4242), true);
  assert.equal(__testing.launchdOwnsListener(deps2, opts, 4242), false);
  assert.equal(__testing.launchdOwnsListener(deps1, opts, null), false);
});

test('ensureViaLaunchd returns 0 when the loaded job owns a healthy listener', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: true, printOutput: 'state = running\n    pid = 4242' },
      fs,
      probeResult: true,
      listenerPid: () => 4242,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 0);
  });
});

test('ensureViaLaunchd returns 1 when the loaded job is healthy but does not own the listener', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: true, printOutput: 'state = running\n    pid = 4242' },
      fs,
      probeResult: true,
      listenerPid: () => 9999,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 1);
  });
});

test('ensureViaLaunchd returns 1 when kickstart fails to produce a healthy owner', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: true, printOutput: 'state = running\n    pid = 4242', throwOnKickstart: true },
      fs,
      probeResult: false,
      listenerPid: () => 4242,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 1);
  });
});

test('ensureViaLaunchd returns 2 when not loaded and no plist exists', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: false,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 2);
  });
});

test('ensureViaLaunchd returns 2 when not loaded but a healthy untracked port is serving', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    fs['files'].set(defaultPaths(home).plistLink, { kind: 'file', data: '<plist/>' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: true,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 2);
  });
});

test('ensureViaLaunchd bootstraps and returns 0 when the plist exists and the listener is owned', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    fs['files'].set(defaultPaths(home).plistLink, { kind: 'file', data: '<plist/>' });
    let probeCalls = 0;
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: 'state = running\n    pid = 7777' },
      fs,
      probeResult: () => { probeCalls += 1; return probeCalls >= 2; },
      listenerPid: () => 7777,
    });
    const result = await __testing.ensureViaLaunchd(deps, defaultOptions(home));
    assert.equal(result, 0);
    assert.equal(deps.fake.calls.some((c) => c[0] === 'bootstrap'), true);
  });
});

test('ensureViaFallback returns 0 immediately when a tracked, owned pid is still healthy', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.fallbackPidFile, { kind: 'file', data: '7777' });
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: true,
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
    });
    const result = await __testing.ensureViaFallback(deps, defaultOptions(home));
    assert.equal(result, 0);
    assert.equal(fs.has(paths.fallbackPidFile), true);
  });
});

test('ensureViaFallback refuses to start a duplicate beside an untracked healthy port', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: true,
    });
    const result = await __testing.ensureViaFallback(deps, defaultOptions(home));
    assert.equal(result, 3);
  });
});

test('ensureViaFallback returns 2 when the launcher is missing', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: false,
    });
    const result = await __testing.ensureViaFallback(deps, defaultOptions(home));
    assert.equal(result, 2);
  });
});

test('ensureViaFallback recycles a tracked but unhealthy pid, starts a launcher, and writes the new pid', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.fallbackPidFile, { kind: 'file', data: '7777' });
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const probeStates: boolean[] = [false, false, false, true];
    let probeIdx = 0;
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: () => probeStates[probeIdx++] ?? false,
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
      nextLauncherPids: [8888],
    });
    const result = await __testing.ensureViaFallback(deps, defaultOptions(home));
    assert.equal(result, 0);
    const pidFile = fs.get(paths.fallbackPidFile);
    assert.ok(pidFile && pidFile.kind === 'file' && pidFile.data.trim() === '8888');
    const sigTerm = fs.calls.find((c) => c.name === 'signal-SIGTERM');
    assert.ok(sigTerm, 'expected SIGTERM to be sent to the stale fallback pid');
  });
});

test('ensureViaFallback kills the spawned launcher and clears its pid when the probe never comes up', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: false,
      nextLauncherPids: [8888],
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
    });
    const result = await __testing.ensureViaFallback(deps, defaultOptions(home));
    assert.equal(result, 2);
    const sigKill = fs.calls.find((c) => c.name === 'signal-SIGKILL');
    assert.ok(sigKill, 'expected SIGKILL to be sent to the orphan launcher');
    assert.equal(fs.has(paths.fallbackPidFile), false);
  });
});

test('ensureViaFallback rotates the fallback log when it exceeds the size budget', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    const oversized = 'x'.repeat(64);
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    fs['files'].set(paths.fallbackLog, { kind: 'file', data: oversized });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: false,
      nextLauncherPids: [8888],
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
    });
    const options = defaultOptions(home, { fallbackLogMaxBytes: 32 });
    const result = await __testing.ensureViaFallback(deps, options);
    assert.equal(result, 2);
    assert.equal(fs.has(`${paths.fallbackLog}.1`), true);
    const rotated = fs.get(paths.fallbackLog);
    const rotatedData = rotated && rotated.kind === 'file' ? rotated.data : null;
    assert.notEqual(rotatedData, oversized);
  });
});

test('runRouterEnsure returns lock-contended without touching launchd or the fallback', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.lockDir, { kind: 'dir' });
    fs['files'].set(`${paths.lockDir}/pid`, { kind: 'file', data: '9999' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      pidExists: (pid) => pid === 9999,
    });
    const result = await runRouterEnsure(deps, defaultOptions(home));
    assert.equal(result.status, 'lock-contended');
    assert.equal(result.exitCode, 1);
    assert.match(result.message ?? '', /another ensure invocation is in progress/);
    assert.equal(deps.fake.calls.length, 0);
  });
});

test('runRouterEnsure returns healthy-launchd when the loaded job owns the listener', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: true, printOutput: 'state = running\n    pid = 4242' },
      fs,
      probeResult: true,
      listenerPid: () => 4242,
    });
    let copilotEnsures = 0;
    const ensureDeps: RouterEnsureDeps = { ...deps, ensureCopilot: async () => { copilotEnsures += 1; return true; } };
    const result: RouterEnsureResult = await runRouterEnsure(ensureDeps, defaultOptions(home));
    assert.equal(result.status, 'healthy-launchd');
    assert.equal(result.exitCode, 0);
    assert.equal(copilotEnsures, 1);
  });
});

test('runRouterEnsure returns launchd-failed when the loaded job is healthy but does not own the listener', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: true, printOutput: 'state = running\n    pid = 4242' },
      fs,
      probeResult: true,
      listenerPid: () => 9999,
    });
    const result = await runRouterEnsure(deps, defaultOptions(home));
    assert.equal(result.status, 'launchd-failed');
    assert.equal(result.exitCode, 1);
    assert.match(result.message ?? '', /failed to start under launchd/);
  });
});

test('runRouterEnsure returns duplicate-detected when fallback sees an untracked healthy port', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: true,
    });
    const result = await runRouterEnsure(deps, defaultOptions(home));
    assert.equal(result.status, 'duplicate-detected');
    assert.equal(result.exitCode, 1);
    assert.match(result.message ?? '', /untracked process/);
  });
});

test('runRouterEnsure returns healthy-fallback when launchd is unavailable and the launcher comes up', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    const probeStates: boolean[] = [false, false, true];
    let probeIdx = 0;
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: () => probeStates[probeIdx++] ?? false,
      nextLauncherPids: [8888],
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
    });
    const result = await runRouterEnsure(deps, defaultOptions(home));
    assert.equal(result.status, 'healthy-fallback');
    assert.equal(result.exitCode, 0);
    const pidFile = fs.get(paths.fallbackPidFile);
    assert.ok(pidFile && pidFile.kind === 'file' && pidFile.data.trim() === '8888');
  });
});

test('runRouterEnsure returns fallback-failed with a log tail when the launcher cannot bind', async () => {
  await withTempHome(async (home) => {
    const fs = new FakeFs();
    const paths = defaultPaths(home);
    const logLines = ['starting launcher', 'bind failed: EADDRINUSE'];
    fs['files'].set(paths.launcher, { kind: 'file', data: 'launcher' });
    fs['files'].set(paths.fallbackLog, { kind: 'file', data: `${logLines.join('\n')}\n` });
    const deps = makeDeps({
      home,
      fake: { calls: [], loaded: false, printOutput: '' },
      fs,
      probeResult: false,
      nextLauncherPids: [8888],
      pidCommandLine: () => '/bin/bash /Users/test/.codex/hooks/run-codex-model-router.sh',
      launcherAppends: logLines,
    });
    const result = await runRouterEnsure(deps, defaultOptions(home));
    assert.equal(result.status, 'fallback-failed');
    assert.equal(result.exitCode, 1);
    assert.match(result.message ?? '', /fallback failed to start/);
    assert.deepEqual(result.logTail, logLines);
  });
});

test('resolveRouterEnsureOptions reads override env vars and falls back to defaults', () => {
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: '/srv/codex',
    CODEX_MODEL_ROUTER_HOST: '10.0.0.1',
    CODEX_MODEL_ROUTER_PORT: '4200',
    CODEX_MODEL_ROUTER_RUN_DIR: '/srv/codex/run-x',
    CODEX_MODEL_ROUTER_FALLBACK_LOG: '/srv/codex/run-x/fb.log',
    CODEX_MODEL_ROUTER_FALLBACK_PID_FILE: '/srv/codex/run-x/fb.pid',
    CODEX_MODEL_ROUTER_ENSURE_LOCK: '/srv/codex/run-x/ensure.lock',
    CODEX_MODEL_ROUTER_READY_TIMEOUT_MS: '1234',
  };
  const options = resolveRouterEnsureOptions(env, 9000);
  assert.equal(options.paths.codexHome, '/srv/codex');
  assert.equal(options.paths.runDir, '/srv/codex/run-x');
  assert.equal(options.paths.launchdRunDir, '/srv/codex/run');
  assert.equal(options.paths.fallbackLog, '/srv/codex/run-x/fb.log');
  assert.equal(options.paths.fallbackPidFile, '/srv/codex/run-x/fb.pid');
  assert.equal(options.paths.ensureLock, '/srv/codex/run-x/ensure.lock');
  assert.equal(options.routerHost, '10.0.0.1');
  assert.equal(options.routerPort, 4200);
  assert.equal(options.readyTimeoutMs, 1234);
  assert.equal(options.myPid, 9000);
});

test('createDefaultRouterEnsureDeps builds a default probe URL against the configured host and port', () => {
  const options: RouterEnsureOptions = defaultOptions('/tmp/x', { routerHost: '10.0.0.5', routerPort: 4321 });
  const deps = createDefaultRouterEnsureDeps(options);
  assert.ok(deps.launchd instanceof LaunchdClient);
  assert.equal(typeof deps.probe, 'function');
  assert.equal(typeof deps.startLauncher, 'function');
  assert.equal(typeof deps.signalPid, 'function');
  assert.equal(typeof deps.setExitHandler, 'function');
});

test('createDefaultRouterEnsureDeps probe returns false when the configured port is unreachable', async () => {
  const options = defaultOptions('/tmp/x', { routerHost: '127.0.0.1', routerPort: 1 });
  const deps = createDefaultRouterEnsureDeps(options);
  assert.equal(await deps.probe(), false);
});

test('lockDirCleanup removes the pid marker and the lock directory when owned', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'autodev-cleanup-'));
  writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`);
  chmodSync(lockDir, 0o700);
  __testing.lockDirCleanup(lockDir, true);
  assert.equal(existsSync(join(lockDir, 'pid')), false);
  assert.equal(existsSync(lockDir), false);
  __testing.lockDirCleanup(lockDir, false);
  rmSync(lockDir, { recursive: true, force: true });
});
