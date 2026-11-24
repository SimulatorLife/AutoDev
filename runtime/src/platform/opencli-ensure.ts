import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { findOpencliCommand } from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { httpHealthProbe } from "./health-probe.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

export const OPENCLI_PROXY_LABEL = "com.codex.opencli-proxy";
export const OPENCLI_PROXY_PORT = 4004;
const DEFAULT_TIMEOUT_MS = 5000;

export interface OpencliEnsureOptions {
  readonly host: string;
  readonly port: number;
  readonly label: string;
  readonly domain: string;
  readonly plist: string;
  readonly launcher: string;
  readonly available: boolean;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface OpencliEnsureDeps {
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

export function resolveOpencliEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): OpencliEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    host: env.CODEX_OPENCLI_PROXY_HOST?.trim() || "127.0.0.1",
    port: parseNonNegativeInteger(
      env.CODEX_OPENCLI_PROXY_PORT,
      OPENCLI_PROXY_PORT
    ),
    label: OPENCLI_PROXY_LABEL,
    domain: `gui/${uid}`,
    plist: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${OPENCLI_PROXY_LABEL}.plist`
    ),
    launcher: path.join(codexHome, "hooks", "run-autodev-opencli-proxy.sh"),
    available: findOpencliCommand(env) !== null,
    readyTimeoutMs: parseNonNegativeInteger(
      env.CODEX_OPENCLI_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath: path.join(codexHome, "run", "codex-opencli-proxy.fallback.log")
  };
}

export function defaultOpencliEnsureDeps(
  options: Pick<OpencliEnsureOptions, "host" | "port">
): OpencliEnsureDeps {
  const endpoint = `http://${options.host}:${options.port}/health/liveliness`;
  return {
    launchd: new LaunchdClient(),
    probe: httpHealthProbe(endpoint),
    sleep,
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

/** Best-effort: opencli serves `github-worker` web automation tasks. */
export async function ensureOpencliProxy(
  options: OpencliEnsureOptions = resolveOpencliEnsureOptions(),
  deps: OpencliEnsureDeps = defaultOpencliEnsureDeps(options)
): Promise<boolean> {
  if (await deps.probe()) return true;
  if (!options.available) return true;

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

if (isEntryPoint(import.meta.url)) {
  ensureOpencliProxy()
    .then((ready) => {
      if (!ready)
        writeErrorLine(
          "opencli runner did not become ready; router will route around it."
        );
      process.exitCode = ready ? 0 : 1;
      return ready ? 0 : 1;
    })
    .catch((error) => {
      writeErrorLine(
        `opencli-ensure: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
      return 1;
    });
}
