import { homedir } from "node:os";
import path from "node:path";

import { parseNonNegativeInteger } from "@simulatorlife/autodev-runtime/shared/env";
import { findCopilotBinary } from "@simulatorlife/autodev-runtime/shared/executables";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import {
  defaultOptionalBridgeDeps,
  ensureOptionalBridge,
  type OptionalBridgeDeps,
  type OptionalBridgeOptions
} from "./optional-bridge-ensure.ts";

export interface CopilotEnsureOptions extends Omit<
  OptionalBridgeOptions,
  "available"
> {
  /**
   * Where the Copilot CLI is, or null when it is not installed. Resolved by
   * the same lookup the bridge spawns through, so this hook and the bridge
   * cannot disagree about whether a Copilot provider is available.
   */
  readonly copilotBin: string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function resolveCopilotEnsureOptions(
  env: NodeJS.ProcessEnv = process.env
): CopilotEnsureOptions {
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const host = env.CODEX_COPILOT_PROXY_HOST?.trim() || "127.0.0.1";
  const port = parseNonNegativeInteger(env.CODEX_COPILOT_PROXY_PORT, 4003);
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
    copilotBin: findCopilotBinary(env, home),
    readyTimeoutMs: parseNonNegativeInteger(
      env.CODEX_COPILOT_READY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    logPath: path.join(codexHome, "run", "codex-copilot-proxy.fallback.log")
  };
}

/**
 * Preserve the router ensure hook's historical best-effort Copilot side effect
 * without reintroducing shell-owned decision logic. Copilot is optional: a
 * missing CLI or failed proxy never changes the router's successful result.
 */
export function ensureCopilotProxy(
  options: CopilotEnsureOptions = resolveCopilotEnsureOptions(),
  deps: OptionalBridgeDeps = defaultOptionalBridgeDeps(options)
): Promise<boolean> {
  return ensureOptionalBridge(
    { ...options, available: options.copilotBin !== null },
    deps
  );
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
