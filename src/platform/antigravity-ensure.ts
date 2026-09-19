import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

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

export function isAntigravityModel(input: string): boolean {
  try {
    const value: unknown = JSON.parse(input);
    const candidate =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).model
        : null;
    const model =
      typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    return model.startsWith("gemini-");
  } catch {
    return false;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveAntigravityEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): AntigravityEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const label = "com.codex.antigravity-proxy";
  return {
    host: env.AGY_PROXY_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.AGY_PROXY_PORT, DEFAULT_PORT),
    label,
    plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    launcher: path.join(codexHome, "hooks", "run-codex-antigravity-proxy.sh"),
    cliPath:
      env.AGY_CLI_PATH?.trim() || path.join(home, ".local", "bin", "agy"),
    settingsPath:
      env.AGY_SETTINGS_PATH?.trim() ||
      path.join(home, ".gemini", "config", "config.json"),
    readyTimeoutMs: positiveInteger(
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
    probe: async () => {
      try {
        return (await fetch(endpoint, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

async function waitForProbe(
  deps: AntigravityEnsureDeps,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.probe()) return true;
    await deps.sleep(100);
  }
  return deps.probe();
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
