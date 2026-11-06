import { homedir } from "node:os";
import path from "node:path";

import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { findOpencliCommand } from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import {
  defaultOptionalBridgeDeps,
  ensureOptionalBridge,
  type OptionalBridgeDeps,
  type OptionalBridgeOptions
} from "./optional-bridge-ensure.ts";

export const OPENCLI_PROXY_LABEL = "com.codex.opencli-proxy";
export const OPENCLI_PROXY_PORT = 4004;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Where the opencli bridge lives and whether opencli is installed.
 *
 * opencli is a dependency of the Runtime package, so it is present wherever
 * the checkout's dependencies are; the lookup is the bridge's own, so the two
 * cannot disagree. Whether a browser is signed in to a site is a per-turn
 * fact the bridge reports, not something that decides whether it starts.
 */
export function resolveOpencliEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): OptionalBridgeOptions {
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
    launcher: path.join(codexHome, "hooks", "run-codex-opencli-proxy.sh"),
    available: findOpencliCommand(env) !== null,
    readyTimeoutMs: parseNonNegativeInteger(
      env.CODEX_OPENCLI_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath: path.join(codexHome, "run", "codex-opencli-proxy.fallback.log")
  };
}

/** Best-effort: opencli is an optional fallback provider. */
export function ensureOpencliProxy(
  options: OptionalBridgeOptions = resolveOpencliEnsureOptions(),
  deps: OptionalBridgeDeps = defaultOptionalBridgeDeps(options)
): Promise<boolean> {
  return ensureOptionalBridge(options, deps);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  ensureOpencliProxy()
    .then((ready) => {
      if (!ready)
        writeErrorLine(
          "opencli Responses proxy did not become ready; router will route around it."
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
