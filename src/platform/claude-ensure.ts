import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LaunchdClient } from './macos/launchd.ts';

export interface ClaudeEnsureOptions {
  readonly host: string;
  readonly port: number;
  readonly label: string;
  readonly plist: string;
  readonly launcher: string;
  readonly oauthToken: string;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface ClaudeEnsureDeps {
  readonly launchd: Pick<LaunchdClient, 'isLoaded' | 'kickstart' | 'bootstrap'>;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly tokenAvailable: () => boolean;
  readonly plistExists: () => boolean;
  readonly launcherExists: () => boolean;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function keychainToken(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return env.CLAUDE_CODE_OAUTH_TOKEN.trim();
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-a', env.USER ?? '', '-s', 'com.codex.claude-bridge.oauth-token', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function isClaudeModel(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    const model = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).model : null;
    return typeof model === 'string' && /^(sonnet|opus|haiku|claude-[a-z0-9][a-z0-9.-]*)$/iu.test(model.trim());
  } catch {
    return false;
  }
}

export function resolveClaudeEnsureOptions(env: NodeJS.ProcessEnv = process.env): ClaudeEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const label = 'com.codex.claude-bridge';
  return {
    host: env.CODEX_CLAUDE_BRIDGE_HOST?.trim() || '127.0.0.1',
    port: positiveInteger(env.CODEX_CLAUDE_BRIDGE_PORT, 4000),
    label,
    plist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    launcher: join(codexHome, 'hooks', 'run-codex-claude-bridge.sh'),
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || '',
    readyTimeoutMs: positiveInteger(env.CODEX_CLAUDE_READY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    logPath: join(codexHome, 'run', 'codex-claude-bridge.fallback.log'),
  };
}

function defaultDeps(options: ClaudeEnsureOptions): ClaudeEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: async () => {
      try { return (await fetch(endpoint, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tokenAvailable: () => options.oauthToken.length > 0 || keychainToken(process.env).length > 0,
    plistExists: () => existsSync(options.plist),
    launcherExists: () => existsSync(options.launcher),
    startFallback: (launcher, logPath) => {
      const runDir = dirname(logPath);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const fd = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
      const child = spawn('/bin/bash', [launcher], { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
    },
  };
}

async function waitForProbe(deps: ClaudeEnsureDeps, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.probe()) return true;
    await deps.sleep(100);
  }
  return deps.probe();
}

/** Own the Claude bridge's model gate, credential check, and launchd fallback. */
export async function ensureClaudeBridge(
  input = readFileSync(0, 'utf8'),
  options: ClaudeEnsureOptions = resolveClaudeEnsureOptions(),
  deps: ClaudeEnsureDeps = defaultDeps(options),
): Promise<number> {
  if (!isClaudeModel(input)) return 0;
  if (await deps.probe()) return 0;
  if (!deps.tokenAvailable()) {
    console.error('Claude Code bridge requires a Keychain-backed Claude OAuth token.');
    return 1;
  }

  if (deps.launchd.isLoaded(options.label)) {
    try { deps.launchd.kickstart(options.label); } catch { /* report after readiness */ }
    if (await waitForProbe(deps, options.readyTimeoutMs)) return 0;
    console.error(`Claude launchd service ${options.label} did not become ready.`);
    return 1;
  }

  if (deps.plistExists()) {
    try {
      deps.launchd.bootstrap(options.plist);
      if (await waitForProbe(deps, options.readyTimeoutMs)) return 0;
    } catch { /* launchd may be unavailable inside a sandbox */ }
    console.error(`Claude launchd service ${options.label} did not become ready.`);
    return 1;
  }

  if (!deps.launcherExists()) {
    console.error(`Claude bridge launcher is missing: ${options.launcher}`);
    return 1;
  }
  deps.startFallback(options.launcher, options.logPath);
  return (await waitForProbe(deps, options.readyTimeoutMs)) ? 0 : 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureClaudeBridge().then((status) => { process.exitCode = status; });
}
