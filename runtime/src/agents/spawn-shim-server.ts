/**
 * The MCP server entry a provider bridge hands its CLI.
 *
 * A CLI bridge's child agents are invisible to Codex: the CLI spawns them
 * inside its own runtime, no Codex thread is created, and the app has nothing
 * to render. The bridge's answer is this server -- the bridge injects it, the
 * CLI's model asks the bridge through it, and the bridge turns the request
 * into Codex's own spawn, so the child becomes a real session the app shows
 * and the router counts.
 *
 * The shim itself (`runtime/src/mcp/spawn-shim.ts`) is dependency-free because
 * it is materialized into `CODEX_HOME/src/mcp/` and run from there. The launch
 * definition therefore lives here, beside the bridges that write it, so the
 * three of them cannot drift apart on what the shim is called, where it lives,
 * or which bridge it calls back.
 *
 * Each CLI renders the entry in its own MCP config schema -- Claude takes
 * `{command, args, env}`, the Copilot CLI adds `type: "stdio"` -- but the
 * launch itself is this one.
 *
 * The `env` is the identity the shim needs to call back, and where it is
 * *delivered* is the caller's business: a CLI that takes its MCP config on the
 * command line carries it in the entry, and a CLI that reads it from a file
 * carries it in the process environment the shim inherits, because a token
 * written into a file outlives the turn.
 */

import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

/**
 * The launch definition of the spawn shim.
 *
 * Narrower than a plain JSON object on purpose: every value here is a string,
 * and saying so lets the strict-typed callers assign it without a cast or a
 * widened alias on their side.
 */
export interface SpawnShimMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The entry that launches the spawn shim against one bridge turn.
 *
 * The session key names the turn the shim's calls belong to: the shim sends it
 * back with every call, and the bridge uses it to find the delegation state the
 * turn holds. It is also the parent conversation id the spawn script recovers
 * terminal children under, so it has to be the Codex thread id and not a
 * bridge-local token.
 */
export function spawnShimMcpServer(
  bridge: { url: string; token: string },
  session: string,
  environment: NodeJS.ProcessEnv = process.env
): SpawnShimMcpServer {
  const sourceRoot = resolveRuntimeSourceRoot(
    import.meta.dirname,
    environment.AUTODEV_REPO_ROOT
  );
  return {
    command: environment.AUTODEV_NODE_BIN ?? process.execPath,
    args: [resolveRuntimeSourcePath(sourceRoot, "mcp/spawn-shim.ts")],
    env: {
      AUTODEV_BRIDGE_URL: bridge.url,
      AUTODEV_BRIDGE_TOKEN: bridge.token,
      AUTODEV_SPAWN_SESSION: session
    }
  };
}
