import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { httpHealthProbe } from "./health-probe.ts";
import { resolveServiceNode } from "./host-arch.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

export const LABEL_AUTODEV_CONSOLE = "com.codex.autodev-console";
export const DEFAULT_CONSOLE_PORT = 3300;
const DEFAULT_READY_TIMEOUT_MS = 5000;

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
  environment: NodeJS.ProcessEnv = process.env
): ConsoleEnsureOptions {
  const home = environment.HOME?.trim() || homedir();
  const codexHome = environment.CODEX_HOME?.trim() || path.join(home, ".codex");
  const port = resolveConsolePort(environment.AUTODEV_CONSOLE_PORT);
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
    launcher: path.join(codexHome, "hooks", "run-autodev-console.sh"),
    nodeBin: resolveServiceNode(home),
    readyTimeoutMs:
      Number.parseInt(environment.AUTODEV_CONSOLE_READY_TIMEOUT_MS ?? "5000") ||
      DEFAULT_READY_TIMEOUT_MS,
    logPath: path.join(codexHome, "run", "autodev-console.fallback.log")
  };
}

function defaultDependencies(options: ConsoleEnsureOptions): ConsoleEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/api/health`;
  return {
    launchd: new LaunchdClient(),
    launchdAvailable: () =>
      existsSync("/bin/launchctl") || existsSync("/usr/bin/launchctl"),
    probe: httpHealthProbe(endpoint, { cache: "no-store" }),
    sleep,
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

async function startFallback(
  options: ConsoleEnsureOptions,
  dependencies: ConsoleEnsureDeps
): Promise<number> {
  if (!dependencies.launcherExists()) {
    writeErrorLine(`Console launcher is missing: ${options.launcher}`);
    return 1;
  }
  dependencies.startFallback(options.launcher, options.logPath);
  if (await waitForProbe(dependencies, options.readyTimeoutMs)) return 0;
  writeErrorLine(
    `Console did not become ready at http://${options.host}:${options.port}/api/health.`
  );
  return 1;
}

/**
Ensure the production Console is reachable, preferring its managed LaunchAgent.
*/
export async function ensureConsole(
  options: ConsoleEnsureOptions = resolveConsoleEnsureOptions(),
  dependencies: ConsoleEnsureDeps = defaultDependencies(options)
): Promise<number> {
  if (await dependencies.probe()) return 0;
  if (!dependencies.launchdAvailable()) return startFallback(options, dependencies);

  if (dependencies.launchd.isLoaded(options.label)) {
    try {
      dependencies.launchd.kickstart(options.label);
    } catch {
      /*
      report after readiness
      */
    }
    if (await waitForProbe(dependencies, options.readyTimeoutMs)) return 0;
    writeErrorLine(
      `Console LaunchAgent ${options.label} did not become ready.`
    );
    return 1;
  }

  if (dependencies.plistExists()) {
    try {
      dependencies.launchd.bootstrap(options.plist);
      if (await waitForProbe(dependencies, options.readyTimeoutMs)) return 0;
    } catch {
      /*
      launchd may be unavailable inside a sandbox
      */
    }
    writeErrorLine(
      `Console LaunchAgent ${options.label} did not become ready.`
    );
    return 1;
  }

  return startFallback(options, dependencies);
}

if (isEntryPoint(import.meta.url)) {
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
