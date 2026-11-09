/**
 * Executable lookup shared by the MCP launcher and platform lifecycle code,
 * so every caller resolves a tool's binary the same way.
 */

import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NUMERIC_COLLATOR = new Intl.Collator(undefined, { numeric: true });

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  pathValue = process.env.PATH ?? ""
): string | null {
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Look for a CLI installed under nvm's Node versions directory, newest version first.
 *
 * The bridges that run version-managed CLIs are often supervised by launchd or run
 * in subshells whose PATH carries no nvm bin directory. A CLI installed by npm under
 * nvm is therefore invisible to a standard PATH lookup there.
 */
export function findNvmBinary(
  name: string,
  home = homedir()
): string | null {
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  if (!existsSync(nvmRoot)) return null;
  const versions = readdirSync(nvmRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => NUMERIC_COLLATOR.compare(right, left));
  for (const version of versions) {
    const candidate = path.join(nvmRoot, version, "bin", name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Resolve the Codex CLI from its explicit setting, PATH, or version-managed install. */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string {
  const configured = env.CODEX_BIN?.trim();
  if (configured) {
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
    throw new Error(`Codex CLI is not executable: ${configured}`);
  }
  const fromPath = findExecutable("codex", env.PATH ?? "");
  if (fromPath) return fromPath;

  const fromNvm = findNvmBinary("codex", home);
  if (fromNvm) return fromNvm;

  throw new Error(
    "Codex CLI not found; set CODEX_BIN to the current codex executable."
  );
}

/** The same lookup without the failure: where the Codex CLI is, or null when it is not installed. */
export function findCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  try {
    return resolveCodexBinary(env, home);
  } catch {
    return null;
  }
}

/**
 * The Copilot CLI: `COPILOT_BIN` as given, else the first executable on PATH,
 * else the newest version-managed install.
 *
 * The bridge that runs the Copilot CLI is supervised by launchd, whose PATH
 * is the launchd default and names no version manager's bin directory. A CLI
 * installed by npm under nvm is therefore invisible to a PATH lookup there:
 * the bridge resolves nothing to spawn, and every turn fails with `spawn
 * copilot ENOENT` while its own health endpoint still reports it ready. The
 * Codex CLI is looked for the same way, for the same reason.
 */
export function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string {
  const configured = env.COPILOT_BIN?.trim();
  if (configured) {
    // `COPILOT_BIN` named a command, not only a path, so a bare name is
    // still resolved against PATH before it is called missing.
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved)) return resolved;
    throw new Error(`Copilot CLI is not executable: ${configured}`);
  }
  const fromPath = findExecutable("copilot", env.PATH ?? "");
  if (fromPath) return fromPath;

  const fromNvm = findNvmBinary("copilot", home);
  if (fromNvm) return fromNvm;
  const local = path.join(home, ".local", "bin", "copilot");
  if (isExecutable(local)) return local;
  throw new Error(
    "Copilot CLI not found; set COPILOT_BIN to the current copilot executable."
  );
}

/**
 * The same lookup without the failure: where the Copilot CLI is, or null when
 * it is not installed. The callers that only need to know whether it exists
 * ask this, so "is the Copilot CLI installed" has one answer everywhere.
 */
export function findCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  try {
    return resolveCopilotBinary(env, home);
  } catch {
    return null;
  }
}

/**
 * How to run opencli: `OPENCLI_BIN` as given, else the `@jackwener/opencli`
 * entry point this Runtime depends on, run with the current Node.
 *
 * opencli is a package dependency of the Runtime rather than a global install,
 * so the bridge and the installer resolve the exact version the lockfile pins.
 * Its daemon is shared machine-wide on one port, and a second opencli version
 * started beside it reports the daemon as stale; pinning one version keeps the
 * bridge's CLI and the daemon it talks to in step. The launchd PATH names no
 * version manager's bin directory, so resolving through the module graph is
 * also what keeps the supervised bridge from depending on the login shell.
 */
export interface OpencliCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function resolveOpencliCommand(
  env: NodeJS.ProcessEnv = process.env
): OpencliCommand {
  const configured = env.OPENCLI_BIN?.trim();
  if (configured) {
    const resolved = configured.includes(path.sep)
      ? configured
      : findExecutable(configured, env.PATH ?? "");
    if (resolved && isExecutable(resolved))
      return { command: resolved, args: [] };
    throw new Error(`opencli is not executable: ${configured}`);
  }
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve("@jackwener/opencli"));
  } catch {
    throw new Error(
      "opencli is not installed; run pnpm install --frozen-lockfile in the AutoDev checkout."
    );
  }
  if (!existsSync(entry))
    throw new Error(`opencli entry point is missing: ${entry}`);
  return { command: process.execPath, args: [entry] };
}

/** The same lookup without the failure, for callers that only ask whether it exists. */
export function findOpencliCommand(
  env: NodeJS.ProcessEnv = process.env
): OpencliCommand | null {
  try {
    return resolveOpencliCommand(env);
  } catch {
    return null;
  }
}

export interface CodexAppMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * The Claude Code CLI: `CLAUDE_BIN` as given, else the install under
 * `~/.local/bin`.
 *
 * The bridge that spawns it and the Runtime's reading of its version must
 * name the same file, so both resolve it here. A version read from a
 * different installation than the one serving turns would be a number the
 * operator cannot act on.
 */
export function resolveClaudeBinary(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return path.join(env.HOME ?? homedir(), ".local", "bin", "claude");
}

/** The same lookup without the failure: where the CLI is, or null when it is not there. */
export function findClaudeBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const resolved = resolveClaudeBinary(env);
  return isExecutable(resolved) ? resolved : null;
}

/**
 * The Antigravity CLI (`agy`): `AGY_CLI_PATH` as given, else the install under
 * `~/.local/bin`.
 *
 * Resolved here for the same reason as the Claude CLI: the bridge that
 * spawns it and the reading of its version have to name the same file.
 */
export function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGY_CLI_PATH?.trim();
  if (configured) return configured;
  return `${env.HOME ?? process.cwd()}/.local/bin/agy`;
}

/** The same lookup without the failure: where the CLI is, or null when it is not there. */
export function findAgyBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const resolved = resolveAgyBinary(env);
  return isExecutable(resolved) ? resolved : null;
}

/**
 * The MiniMax CLI (`mmx`): the first executable on PATH, else the install
 * under `~/.local/bin`.
 *
 * The quota reader runs `mmx` by name and lets the shell resolve it, so the
 * PATH lookup is the same answer it gets; the `~/.local/bin` fallback only
 * adds a copy the login shell would have found but a bare process would not.
 */
export function findMiniMaxBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string | null {
  const fromPath = findExecutable("mmx", env.PATH ?? "");
  if (fromPath) return fromPath;
  const local = path.join(home, ".local", "bin", "mmx");
  return isExecutable(local) ? local : null;
}

/**
 * The Codex App tools plugin, without depending on a version that Codex
 * Desktop may replace on its next startup.
 */
export function findCodexAppMcpServer(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): CodexAppMcpServer | null {
  const codeHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const cacheRoot = path.join(
    codeHome,
    "plugins",
    "cache",
    "openai-bundled",
    "codex-app-tools"
  );
  if (!existsSync(cacheRoot)) return null;
  const versions = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => NUMERIC_COLLATOR.compare(right, left));
  for (const version of versions) {
    const cwd = path.join(cacheRoot, version);
    const command = path.join(cwd, "scripts", "launch_codex_app_tools_mcp");
    if (isExecutable(command) && existsSync(path.join(cwd, "server.mjs"))) {
      return { command, args: ["./server.mjs"], cwd };
    }
  }
  return null;
}

/**
 * The CodeGraphContext CLI: `AUTODEV_CODEGRAPHCONTEXT_BIN` as given, else the
 * first executable on PATH, else pipx's `~/.local/bin` install.
 */
export function resolveCodeGraphContextBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = env.AUTODEV_CODEGRAPHCONTEXT_BIN;
  if (configured) return configured;
  const candidate =
    findExecutable("codegraphcontext", env.PATH) ??
    (env.HOME ? path.join(env.HOME, ".local/bin/codegraphcontext") : null);
  return candidate && isExecutable(candidate) ? candidate : null;
}

/**
 * The CocoIndex Code CLI (`ccc`): `AUTODEV_COCOINDEX_BIN` as given, else
 * pipx's `~/.local/bin` install, else the first executable on PATH.
 *
 * The install is looked for before PATH because pipx's is the copy AutoDev
 * installed, and it is looked for at all because the home it lives in is not
 * necessarily the process's own. Under a home that holds no install that path
 * names a file that is not there, and answering with it would report an
 * installed tool as missing while a working copy sits on PATH.
 */
export function resolveCocoIndexBinary(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = env.AUTODEV_COCOINDEX_BIN;
  if (configured) return configured;
  const installed = env.HOME ? path.join(env.HOME, ".local/bin/ccc") : null;
  if (installed && isExecutable(installed)) return installed;
  return findExecutable("ccc", env.PATH);
}
