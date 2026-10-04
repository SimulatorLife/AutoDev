import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { resolveServiceNode } from "./host-arch.ts";
import { LaunchdClient } from "./macos/launchd.ts";

export const LABEL_AUTODEV_CONSOLE = "com.codex.autodev-console";
export const DEFAULT_CONSOLE_PORT = 3300;
const DEFAULT_READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

export interface ConsoleEnsureOptions {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly label: string;
  readonly plist: string;
  readonly launcher: string;
  readonly nodeBin: string;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface ConsoleEnsureDeps {
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly launchdAvailable: () => boolean;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly plistExists: () => boolean;
  readonly launcherExists: () => boolean;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

const PORT_REGEX = /^\d{1,5}$/u;

export function resolveConsolePort(
  value = process.env.AUTODEV_CONSOLE_PORT
): number {
  const raw = value?.trim() ?? "";
  if (!raw) return DEFAULT_CONSOLE_PORT;
  if (!PORT_REGEX.test(raw))
    throw new Error("AUTODEV_CONSOLE_PORT must be an integer from 1 to 65535.");
  const port = Number(raw);
  if (port < 1 || port > 65_535)
    throw new Error("AUTODEV_CONSOLE_PORT must be an integer from 1 to 65535.");
  return port;
}

export function resolveConsoleEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): ConsoleEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const port = resolveConsolePort(env.AUTODEV_CONSOLE_PORT);
  return {
    host: "127.0.0.1",
    port,
    label: LABEL_AUTODEV_CONSOLE,
    plist: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${LABEL_AUTODEV_CONSOLE}.plist`
    ),
    launcher: path.join(codexHome, "hooks", "run-codex-console.sh"),
    nodeBin: resolveServiceNode(home),
    readyTimeoutMs:
      Number.parseInt(env.AUTODEV_CONSOLE_READY_TIMEOUT_MS ?? "5000") ||
      DEFAULT_READY_TIMEOUT_MS,
    logPath: path.join(codexHome, "run", "autodev-console.fallback.log")
  };
}

function defaultDeps(options: ConsoleEnsureOptions): ConsoleEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/api/health`;
  return {
    launchd: new LaunchdClient(),
    launchdAvailable: () =>
      existsSync("/bin/launchctl") || existsSync("/usr/bin/launchctl"),
    probe: async () => {
      try {
        const response = await fetch(endpoint, {
          signal: AbortSignal.timeout(1000),
          cache: "no-store"
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    plistExists: () => existsSync(options.plist),
    launcherExists: () => existsSync(options.launcher),
    startFallback: (launcher, logPath) => {
      const runDir = path.dirname(logPath);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const fd = openSync(logPath, "a", 0o600);
      chmodSync(logPath, 0o600);
      const child = spawn("/bin/bash", [launcher], {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: {
          ...process.env,
          AUTODEV_NODE_BIN: options.nodeBin,
          AUTODEV_CONSOLE_PORT: String(options.port)
        }
      });
      child.unref();
    }
  };
}

async function waitForProbe(
  deps: ConsoleEnsureDeps,
  deadline: number
): Promise<boolean> {
  if (await deps.probe()) return true;
  if (Date.now() >= deadline) return false;
  await deps.sleep(POLL_INTERVAL_MS);
  return waitForProbe(deps, deadline);
}

async function startFallback(
  options: ConsoleEnsureOptions,
  deps: ConsoleEnsureDeps
): Promise<number> {
  if (!deps.launcherExists()) {
    writeErrorLine(`Console launcher is missing: ${options.launcher}`);
    return 1;
  }
  deps.startFallback(options.launcher, options.logPath);
  if (await waitForProbe(deps, Date.now() + options.readyTimeoutMs)) return 0;
  writeErrorLine(
    `Console did not become ready at http://${options.host}:${options.port}/api/health.`
  );
  return 1;
}

/** Ensure the production Console is reachable, preferring its managed LaunchAgent. */
export async function ensureConsole(
  options: ConsoleEnsureOptions = resolveConsoleEnsureOptions(),
  deps: ConsoleEnsureDeps = defaultDeps(options)
): Promise<number> {
  if (await deps.probe()) return 0;
  if (!deps.launchdAvailable()) return startFallback(options, deps);

  if (deps.launchd.isLoaded(options.label)) {
    try {
      deps.launchd.kickstart(options.label);
    } catch {
      /* report after readiness */
    }
    if (await waitForProbe(deps, Date.now() + options.readyTimeoutMs)) return 0;
    writeErrorLine(
      `Console LaunchAgent ${options.label} did not become ready.`
    );
    return 1;
  }

  if (deps.plistExists()) {
    try {
      deps.launchd.bootstrap(options.plist);
      if (await waitForProbe(deps, Date.now() + options.readyTimeoutMs))
        return 0;
    } catch {
      /* launchd may be unavailable inside a sandbox */
    }
    writeErrorLine(
      `Console LaunchAgent ${options.label} did not become ready.`
    );
    return 1;
  }

  return startFallback(options, deps);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureConsole()
    .then((status) => {
      process.exitCode = status;
      return status;
    })
    .catch((error) => {
      writeErrorLine(
        `console-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
