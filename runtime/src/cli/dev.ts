#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { httpHealthProbe } from "../platform/health-probe.ts";
import { sleep } from "../platform/sleep.ts";
import { waitForProbe } from "../platform/wait-for-probe.ts";

export const IS_MAIN =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

export const repoRoot = path.resolve(
  resolveRuntimeSourceRoot(import.meta.dirname)
);

export function isPortListening(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 400
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const NEWLINE_SPLIT_REGEX = /\r?\n/u;

function parseToken(filePath: string, key: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(NEWLINE_SPLIT_REGEX)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.slice(key.length + 1).trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function ensureConsoleSecrets(root = repoRoot): void {
  const consoleEnv = path.join(root, "console", ".env.local");
  const codexHome =
    process.env.CODEX_HOME?.trim() ||
    path.join(process.env.HOME || homedir(), ".codex");
  const canonicalSecrets =
    process.env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
    path.join(codexHome, "openlit-secrets.env");

  const script = path.join(root, "scripts", "openlit", "bootstrap-secrets.sh");
  if (!existsSync(script)) return;

  if (!existsSync(canonicalSecrets) || !existsSync(consoleEnv)) {
    writeLine("[dev] Initializing console secrets (console/.env.local)...");
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      cwd: root
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Console secret initialization failed with exit status ${String(result.status)}.`
      );
    return;
  }

  // Canonical secrets and console/.env.local both exist; verify they stay synchronized.

  const canonicalControlToken = parseToken(
    canonicalSecrets,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const canonicalUsageToken = parseToken(
    canonicalSecrets,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );
  const consoleControlToken = parseToken(
    consoleEnv,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const consoleUsageToken = parseToken(
    consoleEnv,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );

  if (
    !consoleControlToken ||
    !consoleUsageToken ||
    consoleControlToken !== canonicalControlToken ||
    consoleUsageToken !== canonicalUsageToken
  ) {
    writeLine(
      "[dev] Synchronizing console/.env.local with active OpenLIT secrets..."
    );
    const result = spawnSync("bash", [script], {
      stdio: "inherit",
      cwd: root
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Console secret synchronization failed with exit status ${String(result.status)}.`
      );
  }
}

const OPENLIT_PORT = 3000;
const CLICKHOUSE_HTTP_PORT = 8123;
const DOCKER_READY_TIMEOUT_MS = 120_000;
const STACK_READY_TIMEOUT_MS = 120_000;
const DOCKER_PROBE_TIMEOUT_MS = 5000;

export interface DevCommandOptions {
  readonly cwd: string;
  readonly stdio: "ignore" | "inherit";
  readonly timeoutMs?: number;
}

export interface DevCommandResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
}

/** Injectable process/readiness boundary for the root development lifecycle. */
export interface DevBackendDependencies {
  readonly platform: NodeJS.Platform;
  readonly repoRoot: string;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly isOpenlitHttpReady: () => Promise<boolean>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
}

function runDevCommand(
  command: string,
  args: readonly string[],
  options: DevCommandOptions
): DevCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    stdio: options.stdio,
    timeout: options.timeoutMs
  });
  return { status: result.status, error: result.error };
}

function defaultBackendDependencies(): DevBackendDependencies {
  return {
    platform: process.platform,
    repoRoot,
    runCommand: runDevCommand,
    isPortListening: (port) => isPortListening(port),
    isOpenlitHttpReady: httpHealthProbe(`http://127.0.0.1:${OPENLIT_PORT}`, {
      cache: "no-store"
    }),
    sleep,
    writeLine
  };
}

function commandSucceeded(result: DevCommandResult): boolean {
  return result.error === undefined && result.status === 0;
}

function dockerInfo(dependencies: DevBackendDependencies): boolean {
  return commandSucceeded(
    dependencies.runCommand("docker", ["info"], {
      cwd: dependencies.repoRoot,
      stdio: "ignore",
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS
    })
  );
}

function waitForDockerEngine(
  dependencies: DevBackendDependencies
): Promise<boolean> {
  return waitForProbe(
    {
      probe: () => Promise.resolve(dockerInfo(dependencies)),
      sleep: dependencies.sleep
    },
    DOCKER_READY_TIMEOUT_MS
  );
}

async function isOpenlitStackReady(
  dependencies: DevBackendDependencies
): Promise<boolean> {
  const [clickhouseReady, openlitReady] = await Promise.all([
    dependencies.isPortListening(CLICKHOUSE_HTTP_PORT),
    dependencies.isOpenlitHttpReady()
  ]);
  return clickhouseReady && openlitReady;
}

function waitForOpenlitStack(
  dependencies: DevBackendDependencies
): Promise<boolean> {
  return waitForProbe(
    {
      probe: () => isOpenlitStackReady(dependencies),
      sleep: dependencies.sleep
    },
    STACK_READY_TIMEOUT_MS
  );
}

async function ensureDockerEngine(
  dependencies: DevBackendDependencies
): Promise<void> {
  if (dockerInfo(dependencies)) return;
  if (dependencies.platform !== "darwin") {
    throw new Error(
      "Docker Engine is required for OpenLIT Usage. Start Docker, then rerun pnpm run dev."
    );
  }

  dependencies.writeLine(
    "[dev] Docker Engine is unavailable; starting Docker Desktop..."
  );
  const launched = dependencies.runCommand("open", ["-a", "Docker"], {
    cwd: dependencies.repoRoot,
    stdio: "ignore",
    timeoutMs: 10_000
  });
  if (!commandSucceeded(launched)) {
    throw new Error(
      "Docker Desktop could not be launched. Install or start Docker Desktop, then rerun pnpm run dev."
    );
  }
  if (!(await waitForDockerEngine(dependencies))) {
    throw new Error(
      "Docker Desktop did not make Docker Engine ready within 120 seconds. Check Docker Desktop, then rerun pnpm run dev."
    );
  }
}

/**
 * Ensure the dependencies the Console's server-side Usage adapter requires.
 * A known-unreachable Usage service is a startup failure, not an optional
 * backend warning followed by a broken Console.
 */
export async function ensureBackends(
  overrides: Partial<DevBackendDependencies> = {}
): Promise<{ telemetryActive: true; routerActive: boolean }> {
  const dependencies = { ...defaultBackendDependencies(), ...overrides };
  let telemetryActive = await isOpenlitStackReady(dependencies);

  if (!telemetryActive) {
    await ensureDockerEngine(dependencies);
    telemetryActive = await isOpenlitStackReady(dependencies);
    if (!telemetryActive) {
      dependencies.writeLine(
        "[dev] Starting the OpenLIT and ClickHouse Usage services..."
      );
      const started = dependencies.runCommand(
        "bash",
        [path.join(dependencies.repoRoot, "scripts", "openlit", "up.sh")],
        { cwd: dependencies.repoRoot, stdio: "inherit" }
      );
      if (!commandSucceeded(started)) {
        const detail = started.error?.message;
        throw new Error(
          detail
            ? `OpenLIT startup failed: ${detail}`
            : `OpenLIT startup failed with exit status ${String(started.status)}.`
        );
      }

      telemetryActive = await waitForOpenlitStack(dependencies);
      if (!telemetryActive) {
        throw new Error(
          "OpenLIT or ClickHouse did not become ready within 120 seconds; check the Docker Compose logs and rerun pnpm run dev."
        );
      }
    }
  }

  dependencies.writeLine(
    "[dev] ✔ OpenLIT Usage and ClickHouse are ready (ports 3000, 8123)."
  );
  const routerActive = await dependencies.isPortListening(4100);
  if (routerActive) {
    dependencies.writeLine(
      "[dev] ✔ AutoDev Model Router is active (port 4100)."
    );
  } else {
    dependencies.writeLine(
      "[dev] ℹ AutoDev Model Router is not listening on port 4100 (run launchctl or scripts/run-codex-model-router.sh)."
    );
  }

  return { telemetryActive: true, routerActive };
}

export async function startDev(): Promise<void> {
  try {
    ensureConsoleSecrets();
    await ensureBackends();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErrorLine(`[dev] Startup failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  const consolePort = process.env.AUTODEV_CONSOLE_PORT || "3300";
  writeLine(
    `[dev] 🚀 Starting AutoDev Console dev server on http://localhost:${consolePort}...\n`
  );

  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const extraArgs = process.argv.slice(2);
  const child = spawn(
    pnpmBin,
    ["--filter", "@simulatorlife/autodev-console", "dev", ...extraArgs],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTODEV_CONSOLE_PORT: consolePort
      }
    }
  );

  child.on("error", (error) => {
    writeErrorLine(`[dev] Failed to launch console: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  const forwardSignal = (sig: NodeJS.Signals) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}

if (IS_MAIN) {
  void startDev();
}
