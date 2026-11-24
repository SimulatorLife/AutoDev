/**
Canonical AutoDev runtime home paths (`$AUTODEV_HOME`, defaulting to `~/.autodev`).

Provider homes (`~/.claude`, `~/.gemini`, `~/.copilot`, `~/.codex`, `~/.mcode`)
remain separate from AutoDev's own materialized scripts, hooks, state, and logs.
*/

import { homedir } from "node:os";
import path from "node:path";

/**
Resolve AutoDev's own runtime home directory (`$AUTODEV_HOME`, else `~/.autodev`).
*/
export function autodevHome(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): string {
  return environment.AUTODEV_HOME?.trim() || path.join(home, ".autodev");
}

/**
Resolve AutoDev's active state home during the Phase 1 transition:
`$AUTODEV_HOME` wins, then `$CODEX_HOME` if explicitly set by a legacy caller
or test harness, otherwise `~/.autodev`.
*/
export function autodevStateHome(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): string {
  return (
    environment.AUTODEV_HOME?.trim() ||
    environment.CODEX_HOME?.trim() ||
    path.join(home, ".autodev")
  );
}

export function autodevHooksDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): string {
  return path.join(autodevStateHome(environment, home), "hooks");
}

export function autodevRunDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): string {
  return path.join(autodevStateHome(environment, home), "run");
}

export function autodevConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): string {
  return path.join(autodevStateHome(environment, home), "config");
}
