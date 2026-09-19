import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { writeErrorLine } from "../shared/output.ts";
import { LaunchdClient } from "./macos/launchd.ts";

export interface MiniMaxEnsureOptions {
  readonly host: string;
  readonly port: number;
  readonly model: string;
  readonly label: string;
  readonly plist: string;
  readonly launcher: string;
  readonly proxyScript: string;
  readonly nodeBin: string;
  readonly upstreamBaseUrl: string;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface MiniMaxEnsureDeps {
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nodeAvailable: () => boolean;
  readonly plistExists: () => boolean;
  readonly startFallback: (options: MiniMaxEnsureOptions) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveNode(env: NodeJS.ProcessEnv): string {
  if (env.AUTODEV_NODE?.trim()) return env.AUTODEV_NODE.trim();
  try {
    return (
      execFileSync("which", ["node"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() || "node"
    );
  } catch {
    return "node";
  }
}

export function isMiniMaxModel(
  input: string,
  expectedModel = "MiniMax-M3"
): boolean {
  try {
    const value: unknown = JSON.parse(input);
    const model =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).model
        : null;
    return typeof model === "string" && model === expectedModel;
  } catch {
    return false;
  }
}

export function resolveMiniMaxEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): MiniMaxEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const port = positiveInteger(env.CODEX_MINIMAX_PROXY_PORT, 18_765);
  return {
    host: env.CODEX_MINIMAX_PROXY_HOST?.trim() || "127.0.0.1",
    port,
    model: env.CODEX_MINIMAX_MODEL?.trim() || "MiniMax-M3",
    label: "com.codex.minimax-proxy",
    plist: path.join(
      home,
      "Library",
      "LaunchAgents",
      "com.codex.minimax-proxy.plist"
    ),
    launcher: path.join(codexHome, "hooks", "ensure-codex-minimax-proxy.sh"),
    proxyScript: path.join(codexHome, "src", "providers", "minimax.ts"),
    nodeBin: resolveNode(env),
    upstreamBaseUrl:
      env.CODEX_MINIMAX_UPSTREAM_URL?.trim() || "https://api.minimax.io",
    readyTimeoutMs: positiveInteger(
      env.CODEX_MINIMAX_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath:
      env.CODEX_MINIMAX_PROXY_LOG?.trim() ||
      path.join(codexHome, "run", `codex-minimax-proxy-${port}.log`)
  };
}

function defaultDeps(options: MiniMaxEnsureOptions): MiniMaxEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health`;
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
    nodeAvailable: () => options.nodeBin.length > 0,
    plistExists: () => existsSync(options.plist),
    startFallback: (current) => {
      const runDir = path.dirname(current.logPath);
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      chmodSync(runDir, 0o700);
      const fd = openSync(current.logPath, "a", 0o600);
      chmodSync(current.logPath, 0o600);
      const child = spawn(current.nodeBin, [current.proxyScript], {
        detached: true,
        env: {
          ...process.env,
          MINIMAX_PROXY_HOST: current.host,
          MINIMAX_PROXY_PORT: String(current.port),
          MINIMAX_PROXY_UPSTREAM_BASE_URL: current.upstreamBaseUrl
        },
        stdio: ["ignore", fd, fd]
      });
      child.unref();
    }
  };
}

async function pollProbeUntilDeadline(
  deps: MiniMaxEnsureDeps,
  deadline: number
): Promise<boolean> {
  if (Date.now() >= deadline) return deps.probe();
  if (await deps.probe()) return true;
  await deps.sleep(100);
  return pollProbeUntilDeadline(deps, deadline);
}

function waitForProbe(
  deps: MiniMaxEnsureDeps,
  timeoutMs: number
): Promise<boolean> {
  return pollProbeUntilDeadline(deps, Date.now() + timeoutMs);
}

/** Own MiniMax's model gate and compatibility-proxy lifecycle without shell policy. */
export async function ensureMiniMaxProxy(
  input = readFileSync(0, "utf8"),
  options: MiniMaxEnsureOptions = resolveMiniMaxEnsureOptions(),
  deps: MiniMaxEnsureDeps = defaultDeps(options)
): Promise<number> {
  if (!isMiniMaxModel(input, options.model)) return 0;
  if (await deps.probe()) return 0;
  if (!deps.nodeAvailable()) {
    writeErrorLine("MiniMax compatibility proxy requires Node.js.");
    return 127;
  }

  if (deps.launchd.isLoaded(options.label)) {
    try {
      deps.launchd.kickstart(options.label);
    } catch {
      /* report after readiness */
    }
    return (await waitForProbe(deps, options.readyTimeoutMs)) ? 0 : 1;
  }

  if (deps.plistExists()) {
    try {
      deps.launchd.bootstrap(options.plist);
      if (await waitForProbe(deps, options.readyTimeoutMs)) return 0;
    } catch {
      /* launchd may be unavailable inside a sandbox */
    }
    return 1;
  }

  deps.startFallback(options);
  return (await waitForProbe(deps, options.readyTimeoutMs)) ? 0 : 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureMiniMaxProxy()
    .then((status) => {
      process.exitCode = status;
      return status;
    })
    .catch((error) => {
      writeErrorLine(
        `minimax-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
