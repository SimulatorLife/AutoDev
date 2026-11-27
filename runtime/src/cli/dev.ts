#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  ensureUsageStack,
  isPortListening,
  openlitHttpReady,
  sleep,
  waitForProbe
} from "@simulatorlife/autodev-runtime/platform";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { verifyControlApiCompatibility } from "./control-api-preflight.ts";

export const IS_MAIN = isEntryPoint(import.meta.url);

export const repoRoot = path.resolve(
  resolveRuntimeSourceRoot(import.meta.dirname)
);

const NEWLINE_SPLIT_REGEX = /\r?\n/u;

/**
A Playtesting runner token is a 64-character lowercase hex digest.
*/
const PLAYTEST_RUNNER_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

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
  const consoleEnvironment = path.join(root, "console", ".env.local");
  const codexHome =
    process.env.CODEX_HOME?.trim() ||
    path.join(process.env.HOME || homedir(), ".codex");
  const canonicalSecrets =
    process.env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
    path.join(codexHome, "openlit-secrets.env");

  const script = path.join(root, "scripts", "openlit", "bootstrap-secrets.sh");
  if (!existsSync(script)) return;

  if (!existsSync(canonicalSecrets) || !existsSync(consoleEnvironment)) {
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
    consoleEnvironment,
    "AUTODEV_CONTROL_API_TOKEN"
  );
  const consoleUsageToken = parseToken(
    consoleEnvironment,
    "AUTODEV_OPENLIT_USAGE_TOKEN"
  );
  const consolePlaytestRunnerToken = parseToken(
    consoleEnvironment,
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN"
  );

  if (
    !consoleControlToken ||
    !consoleUsageToken ||
    !canonicalPlaytestRunnerToken ||
    !PLAYTEST_RUNNER_TOKEN_PATTERN.test(canonicalPlaytestRunnerToken) ||
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

function controlApiBaseUrlFromEnvironmentFile(value: string | null): string | null {
  if (!value) return null;
  const defaultExpression = CONTROL_API_BASE_URL_DEFAULT_PATTERN.exec(value);
  return (defaultExpression?.[1] ?? value).trim();
}

export function readDevControlApiConfig(
  root = repoRoot,
  environment: NodeJS.ProcessEnv = process.env
): DevControlApiConfig {
  const consoleEnvironment = path.join(root, "console", ".env.local");
  const serviceToken =
    environment.AUTODEV_CONTROL_API_TOKEN?.trim() ||
    parseToken(consoleEnvironment, "AUTODEV_CONTROL_API_TOKEN");
  if (!serviceToken) {
    throw new Error(
      "Console Control API credentials are missing. Run the Console secret bootstrap before starting the dev server."
    );
  }

  const baseUrl =
    environment.AUTODEV_CONTROL_API_BASE_URL?.trim() ||
    controlApiBaseUrlFromEnvironmentFile(
      parseToken(consoleEnvironment, "AUTODEV_CONTROL_API_BASE_URL")
    ) ||
    DEFAULT_CONTROL_API_BASE_URL;
  return { baseUrl: baseUrl.replace(TRAILING_SLASHES, ""), serviceToken };
}

/**
Read the same server-only Usage credential and URL used by the Console.
*/
export function readDevOpenLITUsageConfig(
  root = repoRoot,
  environment: NodeJS.ProcessEnv = process.env
): DevOpenLITUsageConfig {
  const consoleEnvironment = path.join(root, "console", ".env.local");
  const serviceToken =
    environment.AUTODEV_OPENLIT_USAGE_TOKEN?.trim() ||
    parseToken(consoleEnvironment, "AUTODEV_OPENLIT_USAGE_TOKEN");
  if (!serviceToken) {
    throw new Error(
      "OpenLIT Usage credentials are missing. Run the Console secret bootstrap before starting the dev server."
    );
  }

  const configuredBaseUrl =
    environment.AUTODEV_OPENLIT_USAGE_URL?.trim() ||
    parseToken(consoleEnvironment, "AUTODEV_OPENLIT_USAGE_URL");
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

/**
Injectable process/readiness boundary for the root development lifecycle.
*/
export interface DevBackendDependencies {
  readonly platform: NodeJS.Platform;
  readonly repoRoot: string;
  readonly runCommand: (
    command: string,
    arguments_: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly isOpenlitHttpReady: () => Promise<boolean>;
  readonly openlitUsageConfig: () => DevOpenLITUsageConfig;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
}

function runDevelopmentCommand(
  command: string,
  arguments_: readonly string[],
  options: DevCommandOptions
): DevCommandResult {
  const result = spawnSync(command, [...arguments_], {
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
    runCommand: runDevelopmentCommand,
    isPortListening: (port) => isPortListening(port),
    isOpenlitHttpReady: openlitHttpReady,
    openlitUsageConfig: () => readDevOpenLITUsageConfig(),
    sleep,
    writeLine
  };
}

/**
Ensure the dependencies the Console's server-side Usage adapter requires.
A known-unreachable Usage service is a startup failure, not an optional
backend warning followed by a broken Console.
*/
export async function ensureBackends(
  overrides: Partial<DevBackendDependencies> = {}
): Promise<{ telemetryActive: true; routerActive: boolean }> {
  const dependencies = { ...defaultBackendDependencies(), ...overrides };
  const usageConfig = dependencies.openlitUsageConfig();
  await ensureUsageStack(
    {
      repositoryRoot: dependencies.repoRoot,
      platform: dependencies.platform,
      label: "dev"
    },
    {
      runCommand: dependencies.runCommand,
      isPortListening: dependencies.isPortListening,
      isOpenlitHttpReady: dependencies.isOpenlitHttpReady,
      sleep: dependencies.sleep,
      writeLine: dependencies.writeLine,
      runnerEnv: {
        ...process.env,
        AUTODEV_OPENLIT_USAGE_URL: usageConfig.baseUrl,
        AUTODEV_OPENLIT_USAGE_TOKEN: usageConfig.serviceToken
      }
    }
  );

  const routerActive = await dependencies.isPortListening(4100);
  if (routerActive) {
    dependencies.writeLine(
      "[dev] ✔ AutoDev Model Router is active (port 4100)."
    );
  } else {
    dependencies.writeLine(
      "[dev] ℹ AutoDev Model Router is not listening on port 4100 (run launchctl or scripts/run-autodev-model-router.sh)."
    );
  }

  return { telemetryActive: true, routerActive };
}

export interface DevRouterDependencies {
  readonly repoRoot: string;
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly runCommand: (
    command: string,
    arguments_: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
  readonly platform: NodeJS.Platform;
  readonly forceRestart?: boolean;
}

export async function ensureModelRouter(
  overrides: Partial<DevRouterDependencies> = {}
): Promise<boolean> {
  const dependencies: DevRouterDependencies = {
    repoRoot,
    isPortListening: (port) => isPortListening(port),
    runCommand: runDevelopmentCommand,
    sleep,
    writeLine,
    platform: process.platform,
    ...overrides
  };

  if (dependencies.forceRestart) {
    dependencies.writeLine(
      "[dev] Reconciling AutoDev Model Router integration and restarting..."
    );
  } else {
    const isListening =
      (await dependencies.isPortListening(4100)) && (await dependencies.isPortListening(4101));
    if (isListening) {
      dependencies.writeLine(
        "[dev] ✔ AutoDev Model Router is active (ports 4100, 4101)."
      );
      return true;
    }

    dependencies.writeLine(
      "[dev] AutoDev Model Router is not listening; preparing runtime integration..."
    );
  }

  const materializeScript = path.join(
    dependencies.repoRoot,
    "runtime",
    "src",
    "cli",
    "install.ts"
  );
  dependencies.runCommand("node", [materializeScript, "--materialize-only"], {
    cwd: dependencies.repoRoot,
    stdio: "inherit"
  });

  if (dependencies.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const printResult = dependencies.runCommand(
      "launchctl",
      ["print", `gui/${uid}/com.codex.model-router`],
      { cwd: dependencies.repoRoot, stdio: "ignore" }
    );
    if (printResult.status === 0) {
      dependencies.writeLine(
        "[dev] Restarting com.codex.model-router via launchctl kickstart..."
      );
      dependencies.runCommand(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/com.codex.model-router`],
        { cwd: dependencies.repoRoot, stdio: "ignore" }
      );
    } else {
      dependencies.writeLine(
        "[dev] Starting AutoDev Model Router via router-ensure..."
      );
      const ensureScript = path.join(
        dependencies.repoRoot,
        "runtime",
        "src",
        "platform",
        "router-ensure.ts"
      );
      dependencies.runCommand("node", [ensureScript], {
        cwd: dependencies.repoRoot,
        stdio: "inherit"
      });
    }
  } else {
    dependencies.writeLine("[dev] Starting AutoDev Model Router via router-ensure...");
    const ensureScript = path.join(
      dependencies.repoRoot,
      "runtime",
      "src",
      "platform",
      "router-ensure.ts"
    );
    dependencies.runCommand("node", [ensureScript], {
      cwd: dependencies.repoRoot,
      stdio: "inherit"
    });
  }

  const ready = await waitForProbe(
    {
      probe: async () => {
        const [p4100, p4101] = await Promise.all([
          dependencies.isPortListening(4100),
          dependencies.isPortListening(4101)
        ]);
        return p4100 && p4101;
      },
      sleep: dependencies.sleep
    },
    15_000
  );
  if (ready) {
    dependencies.writeLine("[dev] ✔ AutoDev Model Router is ready (ports 4100, 4101).");
    return true;
  }

  dependencies.writeLine(
    "[dev] ⚠️ AutoDev Model Router did not answer on ports 4100/4101 within 15 seconds."
  );
  return false;
}

export interface DevConsolePortDependencies {
  readonly isPortListening: (port: number) => Promise<boolean>;
  readonly runCommand: (
    command: string,
    arguments_: readonly string[],
    options: DevCommandOptions
  ) => DevCommandResult;
  readonly sleep: (ms: number) => Promise<void>;
  readonly writeLine: (message: string) => void;
  readonly platform: NodeJS.Platform;
  readonly repoRoot: string;
}

export async function ensureConsolePortAvailable(
  port = 3300,
  overrides: Partial<DevConsolePortDependencies> = {}
): Promise<void> {
  const dependencies: DevConsolePortDependencies = {
    isPortListening: (p) => isPortListening(p),
    runCommand: runDevelopmentCommand,
    sleep,
    writeLine,
    platform: process.platform,
    repoRoot,
    ...overrides
  };

  const listening = await dependencies.isPortListening(port);
  if (!listening) return;

  if (dependencies.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const printResult = dependencies.runCommand(
      "launchctl",
      ["print", `gui/${uid}/com.codex.autodev-console`],
      { cwd: dependencies.repoRoot, stdio: "ignore" }
    );
    if (printResult.status === 0) {
      dependencies.writeLine(
        `[dev] Stopping conflicting LaunchAgent com.codex.autodev-console on port ${port}...`
      );
      dependencies.runCommand(
        "launchctl",
        ["bootout", `gui/${uid}/com.codex.autodev-console`],
        { cwd: dependencies.repoRoot, stdio: "ignore" }
      );
      const cleared = await waitForProbe(
        {
          probe: async () => {
            const isListening = await dependencies.isPortListening(port);
            return !isListening;
          },
          sleep: dependencies.sleep
        },
        3000
      );
      if (cleared) {
        dependencies.writeLine(`[dev] ✔ Port ${port} is now available.`);
        return;
      }
    }
  }

  if (await dependencies.isPortListening(port)) {
    dependencies.writeLine(
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
      const probeMessage =
        probeError instanceof Error ? probeError.message : String(probeError);
      if (
        probeMessage.includes("is not compatible with this Console checkout") ||
        probeMessage.includes("Control API contract revision is missing or stale")
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
  const extraArguments = process.argv.slice(2);
  const child = spawn(
    pnpmBin,
    [
      "--filter",
      "@simulatorlife/autodev-console",
      "dev:next",
      "-H",
      "127.0.0.1",
      ...extraArguments
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
