import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

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
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly commandAvailable: (command: string) => boolean;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveCopilotEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): CopilotEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const host = env.CODEX_COPILOT_PROXY_HOST?.trim() || "127.0.0.1";
  const port = positiveInteger(env.CODEX_COPILOT_PROXY_PORT, 4003);
  const label = "com.codex.copilot-proxy";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    host,
    port,
    label,
    domain: `gui/${uid}`,
    plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    launcher: path.join(
      codexHome,
      "hooks",
      "run-codex-copilot-cli-responses-proxy.sh"
    ),
    copilotBin: env.COPILOT_BIN?.trim() || "copilot",
    readyTimeoutMs: positiveInteger(
      env.CODEX_COPILOT_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath: path.join(codexHome, "run", "codex-copilot-proxy.fallback.log")
  };
}

function defaultDeps(options: CopilotEnsureOptions): CopilotEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: async () => {
      try {
        const response = await fetch(endpoint, {
          signal: AbortSignal.timeout(1000)
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
    commandAvailable: (command) => {
      try {
        execFileSync("which", [command], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    startFallback: (launcher, logPath) => {
      const runDir = path.dirname(logPath);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const fd = openSync(logPath, "a", 0o600);
      chmodSync(logPath, 0o600);
      const child = spawn("/bin/bash", [launcher], {
        detached: true,
        stdio: ["ignore", fd, fd]
      });
      child.unref();
    }
  };
}

async function pollProbeUntilDeadline(
  deps: CopilotEnsureDeps,
  deadline: number
): Promise<boolean> {
  if (Date.now() >= deadline) return deps.probe();
  if (await deps.probe()) return true;
  await deps.sleep(100);
  return pollProbeUntilDeadline(deps, deadline);
}

function waitForProbe(
  deps: CopilotEnsureDeps,
  timeoutMs: number
): Promise<boolean> {
  return pollProbeUntilDeadline(deps, Date.now() + timeoutMs);
}

/**
 * Preserve the router ensure hook's historical best-effort Copilot side effect
 * without reintroducing shell-owned decision logic. Copilot is optional: a
 * missing CLI or failed proxy never changes the router's successful result.
 */
export async function ensureCopilotProxy(
  options: CopilotEnsureOptions = resolveCopilotEnsureOptions(),
  deps: CopilotEnsureDeps = defaultDeps(options)
): Promise<boolean> {
  if (await deps.probe()) return true;
  if (!deps.commandAvailable(options.copilotBin)) return true;

  if (deps.launchd.isLoaded(options.label)) {
    try {
      deps.launchd.kickstart(options.label);
    } catch {
      /* best effort */
    }
    return waitForProbe(deps, options.readyTimeoutMs);
  }

  if (existsSync(options.plist)) {
    try {
      deps.launchd.bootstrap(options.plist);
      deps.launchd.kickstart(options.label);
      if (await waitForProbe(deps, options.readyTimeoutMs)) return true;
    } catch {
      /* fall through to the sandbox fallback */
    }
  }

  if (existsSync(options.launcher)) {
    deps.startFallback(options.launcher, options.logPath);
    return waitForProbe(deps, options.readyTimeoutMs);
  }
  return false;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureCopilotProxy()
    .then((ready) => {
      if (!ready)
        writeErrorLine(
          "Copilot Responses proxy did not become ready; router will route around it."
        );
      process.exitCode = ready ? 0 : 1;
      return ready ? 0 : 1;
    })
    .catch((error) => {
      writeErrorLine(
        `copilot-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
