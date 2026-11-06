import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { httpHealthProbe } from "./health-probe.ts";
import { LaunchdClient } from "./macos/launchd.ts";
import { sleep } from "./sleep.ts";
import { waitForProbe } from "./wait-for-probe.ts";

/**
 * The lifecycle every optional provider bridge shares.
 *
 * Copilot and opencli are optional fallbacks: a machine without the provider
 * still routes everything else, so a missing provider or a bridge that fails
 * to start never changes the router's successful result. When the provider is
 * present the bridge is a launchd agent; this adopts the loaded agent, loads
 * the installed plist, or -- in a sandboxed run where `launchctl` is
 * unreachable -- starts the launcher directly, in that order.
 */
export interface OptionalBridgeOptions {
  readonly host: string;
  readonly port: number;
  readonly label: string;
  readonly domain: string;
  readonly plist: string;
  readonly launcher: string;
  /**
   * Whether the provider the bridge drives is installed. Resolved by the same
   * lookup the bridge itself uses, so this and the bridge cannot disagree.
   */
  readonly available: boolean;
  readonly readyTimeoutMs: number;
  readonly logPath: string;
}

export interface OptionalBridgeDeps {
  readonly launchd: Pick<LaunchdClient, "isLoaded" | "kickstart" | "bootstrap">;
  readonly probe: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly startFallback: (launcher: string, logPath: string) => void;
}

export function defaultOptionalBridgeDeps(
  options: Pick<OptionalBridgeOptions, "host" | "port">
): OptionalBridgeDeps {
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

export async function ensureOptionalBridge(
  options: OptionalBridgeOptions,
  deps: OptionalBridgeDeps = defaultOptionalBridgeDeps(options)
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
