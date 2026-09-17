import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LaunchdClient } from './macos/launchd.ts';

export interface CopilotEnsureOptions {
  readonly host: string;
  readonly port: number;
  readonly label: string;
  readonly domain: string;
  readonly plist: string;
  readonly launcher: string;
  readonly copilotBin: string;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface CopilotEnsureDeps {
  readonly launchd: Pick<LaunchdClient, 'isLoaded' | 'kickstart' | 'bootstrap'>;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly commandAvailable: (command: string) => boolean;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveCopilotEnsureOptions(env: NodeJS.ProcessEnv = process.env): CopilotEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const host = env.CODEX_COPILOT_PROXY_HOST?.trim() || '127.0.0.1';
  const port = positiveInteger(env.CODEX_COPILOT_PROXY_PORT, 4003);
  const label = 'com.codex.copilot-proxy';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    host,
    port,
    label,
    domain: `gui/${uid}`,
    plist: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    launcher: join(codexHome, 'hooks', 'run-codex-copilot-cli-responses-proxy.sh'),
    copilotBin: env.COPILOT_BIN?.trim() || 'copilot',
    readyTimeoutMs: positiveInteger(env.CODEX_COPILOT_READY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    logPath: join(env.TMPDIR?.trim() || '/tmp', 'codex-copilot-proxy.log'),
  };
}

function defaultDeps(options: CopilotEnsureOptions): CopilotEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: async () => {
      try { return (await fetch(endpoint, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    commandAvailable: (command) => {
      try { execFileSync('which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
    },
    startFallback: (launcher, logPath) => {
      const fd = openSync(logPath, 'a');
      const child = spawn('/bin/bash', [launcher], { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
    },
  };
}

async function waitForProbe(deps: CopilotEnsureDeps, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.probe()) return true;
    await deps.sleep(100);
  }
  return deps.probe();
}

/**
 * Preserve the router ensure hook's historical best-effort Copilot side effect
 * without reintroducing shell-owned decision logic. Copilot is optional: a
 * missing CLI or failed proxy never changes the router's successful result.
 */
export async function ensureCopilotProxy(
  options: CopilotEnsureOptions = resolveCopilotEnsureOptions(),
  deps: CopilotEnsureDeps = defaultDeps(options),
): Promise<boolean> {
  if (await deps.probe()) return true;
  if (!deps.commandAvailable(options.copilotBin)) return true;

  if (deps.launchd.isLoaded(options.label)) {
    try { deps.launchd.kickstart(options.label); } catch { /* best effort */ }
    return waitForProbe(deps, options.readyTimeoutMs);
  }

  if (existsSync(options.plist)) {
    try {
      deps.launchd.bootstrap(options.plist);
      deps.launchd.kickstart(options.label);
      if (await waitForProbe(deps, options.readyTimeoutMs)) return true;
    } catch { /* fall through to the sandbox fallback */ }
  }

  if (existsSync(options.launcher)) {
    deps.startFallback(options.launcher, options.logPath);
    return waitForProbe(deps, options.readyTimeoutMs);
  }
  return false;
}
