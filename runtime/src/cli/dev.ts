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
import { verifyControlApiCompatibility } from "./control-api-compatibility.ts";

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
        const value = trimmed.slice(key.length + 1).trim();
        const quote = value[0];
        return value.length >= 2 &&
          (quote === '"' || quote === "'") &&
          value.at(-1) === quote
          ? value.slice(1, -1)
          : value;
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
  const canonicalPlaytestRunnerToken = parseToken(
    canonicalSecrets,
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN"
  );
  const consoleControlToken = parseToken(
    consoleEnv,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const consoleUsageToken = parseToken(
    consoleEnv,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );
  const consolePlaytestRunnerToken = parseToken(
    consoleEnv,
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN"
  );

  if (
    !consoleControlToken ||
    !consoleUsageToken ||
    !canonicalPlaytestRunnerToken ||
    !/^[0-9a-f]{64}$/u.test(canonicalPlaytestRunnerToken) ||
    consolePlaytestRunnerToken !== null ||
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
const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const CONTROL_API_BASE_URL_DEFAULT_PATTERN =
  /^\$\{AUTODEV_CONTROL_API_BASE_URL:-([^{}]+)\}$/u;
const OPENLIT_USAGE_BASE_URL_DEFAULT_PATTERN =
  /^\$\{AUTODEV_OPENLIT_USAGE_URL:-([^{}]+)\}$/u;
const TRAILING_SLASHES = /\/+$/u;
const DEFAULT_OPENLIT_USAGE_BASE_URL = "http://127.0.0.1:3000";

export interface DevControlApiConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export interface DevOpenLITUsageConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

function controlApiBaseUrlFromEnvFile(value: string | null): string | null {
  if (!value) return null;
  const defaultExpression = CONTROL_API_BASE_URL_DEFAULT_PATTERN.exec(value);
  return (defaultExpression?.[1] ?? value).trim();
}

export function readDevControlApiConfig(
  root = repoRoot,
  env: NodeJS.ProcessEnv = process.env
): DevControlApiConfig {
  const consoleEnv = path.join(root, "console", ".env.local");
  const serviceToken =
    env.AUTODEV_CONTROL_API_TOKEN?.trim() ||
    parseToken(consoleEnv, "AUTODEV_CONTROL_API_TOKEN");
  if (!serviceToken) {
    throw new Error(
      "Console Control API credentials are missing. Run the Console secret bootstrap before starting the dev server."
    );
  }

  const baseUrl =
    env.AUTODEV_CONTROL_API_BASE_URL?.trim() ||
    controlApiBaseUrlFromEnvFile(
      parseToken(consoleEnv, "AUTODEV_CONTROL_API_BASE_URL")
    ) ||
    DEFAULT_CONTROL_API_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

/** Read the same server-only Usage credential and URL used by the Console. */
export function readDevOpenLITUsageConfig(
  root = repoRoot,
  env: NodeJS.ProcessEnv = process.env
): DevOpenLITUsageConfig {
  const consoleEnv = path.join(root, "console", ".env.local");
  const serviceToken =
    env.AUTODEV_OPENLIT_USAGE_TOKEN?.trim() ||
    parseToken(consoleEnv, "AUTODEV_OPENLIT_USAGE_TOKEN");
  if (!serviceToken) {
    throw new Error(
      "OpenLIT Usage credentials are missing. Run the Console secret bootstrap before starting the dev server."
    );
  }

  const configuredBaseUrl =
    env.AUTODEV_OPENLIT_USAGE_URL?.trim() ||
    parseToken(consoleEnv, "AUTODEV_OPENLIT_USAGE_URL");
  const defaultExpression = configuredBaseUrl
    ? OPENLIT_USAGE_BASE_URL_DEFAULT_PATTERN.exec(configuredBaseUrl)
    : null;
  const baseUrl =
    defaultExpression?.[1] ??
    configuredBaseUrl ??
    DEFAULT_OPENLIT_USAGE_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

export interface DevCommandOptions {
  readonly cwd: string;
  readonly stdio: "ignore" | "inherit";
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
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
  readonly openlitUsageConfig: () => DevOpenLITUsageConfig;
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
    timeout: options.timeoutMs,
    env: options.env
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
    openlitUsageConfig: () => readDevOpenLITUsageConfig(),
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
  await ensureDockerEngine(dependencies);

  // Readiness alone is not freshness: a healthy container may still be
  // running an older image or stale bind-mounted configuration. The canonical
  // runner reuses an unchanged image and lets Compose recreate only services
  // whose image/config fingerprint changed, while preserving data volumes.
  dependencies.writeLine(
    "[dev] Reconciling the OpenLIT and ClickHouse Usage services..."
  );
  const usageConfig = dependencies.openlitUsageConfig();
  const started = dependencies.runCommand(
    "bash",
    [path.join(dependencies.repoRoot, "scripts", "openlit", "up.sh")],
    {
      cwd: dependencies.repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTODEV_OPENLIT_USAGE_URL: usageConfig.baseUrl,
        AUTODEV_OPENLIT_USAGE_TOKEN: usageConfig.serviceToken
      }
    }
  );
  if (!commandSucceeded(started)) {
    const detail = started.error?.message;
    throw new Error(
      detail
        ? `OpenLIT startup failed: ${detail}`
        : `OpenLIT startup failed with exit status ${String(started.status)}.`
    );
  }

  const telemetryActive = await waitForOpenlitStack(dependencies);
  if (!telemetryActive) {
    throw new Error(
      "OpenLIT or ClickHouse did not become ready within 120 seconds; check the Docker Compose logs and rerun pnpm run dev."
    );
  }

  dependencies.writeLine(
    "[dev] ✔ OpenLIT Usage v5 and ClickHouse are ready (ports 3000, 8123)."
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

export interface DevRouterDependencies {
  readonly repoRoot: string;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeLine: (msg: string) => void;
  readonly platform: NodeJS.Platform;
  readonly forceRestart?: boolean;
}

export async function ensureModelRouter(
  overrides: Partial<DevRouterDependencies> = {}
): Promise<boolean> {
  const deps: DevRouterDependencies = {
    repoRoot,
    isPortListening: (port) => isPortListening(port),
    runCommand: runDevCommand,
    sleep,
    writeLine,
    platform: process.platform,
    ...overrides
  };

  if (deps.forceRestart) {
    deps.writeLine(
      "[dev] Reconciling AutoDev Model Router integration and restarting..."
    );
  } else {
    const isListening =
      (await deps.isPortListening(4100)) && (await deps.isPortListening(4101));
    if (isListening) {
      deps.writeLine(
        "[dev] ✔ AutoDev Model Router is active (ports 4100, 4101)."
      );
      return true;
    }

    deps.writeLine(
      "[dev] AutoDev Model Router is not listening; preparing runtime integration..."
    );
  }

  const materializeScript = path.join(
    deps.repoRoot,
    "runtime",
    "src",
    "cli",
    "install.ts"
  );
  deps.runCommand("node", [materializeScript, "--materialize-only"], {
    cwd: deps.repoRoot,
    stdio: "inherit"
  });

  if (deps.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const printResult = deps.runCommand(
      "launchctl",
      ["print", `gui/${uid}/com.codex.model-router`],
      { cwd: deps.repoRoot, stdio: "ignore" }
    );
    if (printResult.status === 0) {
      deps.writeLine(
        "[dev] Restarting com.codex.model-router via launchctl kickstart..."
      );
      deps.runCommand(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/com.codex.model-router`],
        { cwd: deps.repoRoot, stdio: "ignore" }
      );
    } else {
      deps.writeLine(
        "[dev] Starting AutoDev Model Router via router-ensure..."
      );
      const ensureScript = path.join(
        deps.repoRoot,
        "runtime",
        "src",
        "platform",
        "router-ensure.ts"
      );
      deps.runCommand("node", [ensureScript], {
        cwd: deps.repoRoot,
        stdio: "inherit"
      });
    }
  } else {
    deps.writeLine("[dev] Starting AutoDev Model Router via router-ensure...");
    const ensureScript = path.join(
      deps.repoRoot,
      "runtime",
      "src",
      "platform",
      "router-ensure.ts"
    );
    deps.runCommand("node", [ensureScript], {
      cwd: deps.repoRoot,
      stdio: "inherit"
    });
  }

  const ready = await waitForProbe(
    {
      probe: async () => {
        const [p4100, p4101] = await Promise.all([
          deps.isPortListening(4100),
          deps.isPortListening(4101)
        ]);
        return p4100 && p4101;
      },
      sleep: deps.sleep
    },
    15_000
  );
  if (ready) {
    deps.writeLine("[dev] ✔ AutoDev Model Router is ready (ports 4100, 4101).");
    return true;
  }

  deps.writeLine(
    "[dev] ⚠️ AutoDev Model Router did not answer on ports 4100/4101 within 15 seconds."
  );
  return false;
}

export interface DevConsolePortDependencies {
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeLine: (msg: string) => void;
  readonly platform: NodeJS.Platform;
  readonly repoRoot: string;
}

export async function ensureConsolePortAvailable(
  port = 3300,
  overrides: Partial<DevConsolePortDependencies> = {}
): Promise<void> {
  const deps: DevConsolePortDependencies = {
    isPortListening: (p) => isPortListening(p),
    runCommand: runDevCommand,
    sleep,
    writeLine,
    platform: process.platform,
    repoRoot,
    ...overrides
  };

  const listening = await deps.isPortListening(port);
  if (!listening) return;

  if (deps.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const printResult = deps.runCommand(
      "launchctl",
      ["print", `gui/${uid}/com.codex.autodev-console`],
      { cwd: deps.repoRoot, stdio: "ignore" }
    );
    if (printResult.status === 0) {
      deps.writeLine(
        `[dev] Stopping conflicting LaunchAgent com.codex.autodev-console on port ${port}...`
      );
      deps.runCommand(
        "launchctl",
        ["bootout", `gui/${uid}/com.codex.autodev-console`],
        { cwd: deps.repoRoot, stdio: "ignore" }
      );
      const cleared = await waitForProbe(
        {
          probe: async () => {
            const isListening = await deps.isPortListening(port);
            return !isListening;
          },
          sleep: deps.sleep
        },
        3000
      );
      if (cleared) {
        deps.writeLine(`[dev] ✔ Port ${port} is now available.`);
        return;
      }
    }
  }

  if (await deps.isPortListening(port)) {
    deps.writeLine(
      `[dev] ⚠️ Port ${port} is currently in use. If starting the dev server fails, stop the conflicting process or set AUTODEV_CONSOLE_PORT.`
    );
  }
}

function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

export async function startDev(): Promise<void> {
  const consolePort = Number(process.env.AUTODEV_CONSOLE_PORT || "3300");
  try {
    ensureConsoleSecrets();
    await ensureBackends();
    await ensureModelRouter();
    try {
      await verifyControlApiCompatibility(
        readDevControlApiConfig(),
        undefined,
        {
          timeoutMs: 15_000,
          retryDelayMs: 250
        }
      );
    } catch (probeError) {
      const probeMsg =
        probeError instanceof Error ? probeError.message : String(probeError);
      if (
        probeMsg.includes("is not compatible with this Console checkout") ||
        probeMsg.includes("Control API contract revision is missing or stale")
      ) {
        writeLine(
          "[dev] Incompatible Control API contract detected; refreshing runtime integration and restarting router..."
        );
        await ensureModelRouter({ forceRestart: true });
        await verifyControlApiCompatibility(
          readDevControlApiConfig(),
          undefined,
          {
            timeoutMs: 15_000,
            retryDelayMs: 250
          }
        );
      } else {
        throw probeError;
      }
    }
    writeLine("[dev] ✔ AutoDev Control API matches the Console contracts.");
    await ensureConsolePortAvailable(consolePort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeErrorLine(`[dev] Startup failed: ${message}`);
    setProcessExitCode(1);
    return;
  }

  writeLine(
    `[dev] 🚀 Starting AutoDev Console dev server on http://localhost:${consolePort}...\n`
  );

  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const extraArgs = process.argv.slice(2);
  const child = spawn(
    pnpmBin,
    [
      "--filter",
      "@simulatorlife/autodev-console",
      "dev:next",
      "-H",
      "127.0.0.1",
      ...extraArgs
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        AUTODEV_CONSOLE_PORT: String(consolePort)
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
