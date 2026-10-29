import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { ANTIGRAVITY_MODEL_PATTERN } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import { httpHealthProbe } from "./health-probe.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

export interface AntigravityEnsureOptions {
  readonly host: string;
  readonly port: number;
  readonly label: string;
  readonly plist: string;
  readonly launcher: string;
  readonly cliPath: string;
  readonly settingsPath: string;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface AntigravityEnsureDeps {
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly cliAvailable: () => boolean;
  readonly settingsValid: () => boolean;
  readonly plistExists: () => boolean;
  readonly launcherExists: () => boolean;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

const DEFAULT_PORT = 4002;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Whether this request is served by the agy CLI. The gate covers every id agy
 * lists -- Gemini plus its effort-suffixed Claude families -- so selecting
 * `claude-opus-5-5-high` here starts the proxy instead of silently leaving a
 * Gemini-only prefix test to decline it.
 */
export function isAntigravityModel(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    const candidate =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).model
        : null;
    const model =
      typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    return ANTIGRAVITY_MODEL_PATTERN.test(model);
  } catch {
    return false;
  }
}

export function resolveAntigravityEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): AntigravityEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const label = "com.codex.antigravity-proxy";
  return {
    host: env.AGY_PROXY_HOST?.trim() || "127.0.0.1",
    port: parseNonNegativeInteger(env.AGY_PROXY_PORT, DEFAULT_PORT),
    label,
    plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    launcher: path.join(codexHome, "hooks", "run-codex-antigravity-proxy.sh"),
    cliPath:
      env.AGY_CLI_PATH?.trim() || path.join(home, ".local", "bin", "agy"),
    settingsPath:
      env.AGY_SETTINGS_PATH?.trim() ||
      path.join(home, ".gemini", "config", "config.json"),
    readyTimeoutMs: parseNonNegativeInteger(
      env.AGY_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath: path.join(
      env.TMPDIR?.trim() || "/tmp",
      "codex-antigravity-proxy.log"
    )
  };
}

function defaultDeps(options: AntigravityEnsureOptions): AntigravityEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: httpHealthProbe(endpoint),
    sleep,
    cliAvailable: () => existsSync(options.cliPath),
    settingsValid: () => {
      try {
        const value: unknown = JSON.parse(
          readFileSync(options.settingsPath, "utf8")
        );
        const userSettings =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>).userSettings
            : null;
        return (
          userSettings !== null &&
          typeof userSettings === "object" &&
          !Array.isArray(userSettings) &&
          (userSettings as Record<string, unknown>).useAiCredits === false &&
          (userSettings as Record<string, unknown>).useG1Credits === false
        );
      } catch {
        return false;
      }
    },
    plistExists: () => existsSync(options.plist),
    launcherExists: () => existsSync(options.launcher),
    startFallback: (launcher, logPath) => {
      const fd = openSync(logPath, "a");
      const child = spawn("/bin/bash", [launcher], {
        detached: true,
        stdio: ["ignore", fd, fd]
      });
      child.unref();
    }
  };
}

/** Best-effort lifecycle owner for Antigravity's retained CLI bridge. */
export async function ensureAntigravityProxy(
  input: string = readFileSync(0, "utf8"),
  options: AntigravityEnsureOptions = resolveAntigravityEnsureOptions(),
  deps: AntigravityEnsureDeps = defaultDeps(options)
): Promise<number> {
  if (!isAntigravityModel(input)) return 0;
  if (!deps.settingsValid()) {
    writeErrorLine(
      `Antigravity settings missing or AI Credit Overages is not disabled: ${options.settingsPath}`
    );
    return 1;
  }
  if (!deps.cliAvailable()) {
    writeErrorLine(`Antigravity CLI not installed at ${options.cliPath}.`);
    return 1;
  }
  if (await deps.probe()) return 0;

  if (deps.launchd.isLoaded(options.label)) {
    try {
      deps.launchd.kickstart(options.label);
    } catch {
      /* fall through to readiness */
    }
    if (await waitForProbe(deps, options.readyTimeoutMs)) return 0;
    writeErrorLine(
      `Antigravity launchd service ${options.label} did not become ready.`
    );
    return 1;
  }

  if (deps.plistExists()) {
    try {
      deps.launchd.bootstrap(options.plist);
      if (await waitForProbe(deps, options.readyTimeoutMs)) return 0;
    } catch {
      /* fall through to direct fallback */
    }
  }

  if (await deps.probe()) return 0;
  if (!deps.launcherExists()) return 1;
  deps.startFallback(options.launcher, options.logPath);
  return (await waitForProbe(deps, options.readyTimeoutMs)) ? 0 : 1;
}

/**
 * The entry point the dispatch script reaches.
 *
 * `scripts/ensure-codex-antigravity-proxy.sh` runs this module as a process
 * and feeds it the model request on stdin, the way the Claude and MiniMax
 * bridges are run. Without this block the module loaded, exported its
 * functions and exited zero: the script reported success and nothing had been
 * ensured at all, so the Antigravity bridge was silently never started by the
 * one path that is supposed to start it.
 */
if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureAntigravityProxy()
    .then((status) => {
      process.exitCode = status;
      return status;
    })
    .catch((error) => {
      writeErrorLine(
        `antigravity-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
