/**
 * Executable lookup shared by the MCP launcher and platform lifecycle code,
 * so every caller resolves a tool's binary the same way.
 */

import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

/** Resolve the Codex CLI from its explicit setting, PATH, or version-managed install. */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME?.trim() || homedir()
): string {
  const configured = env.CODEX_BIN?.trim();
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`Codex CLI is not executable: ${configured}`);
  }
  const fromPath = findExecutable("codex", env.PATH);
  if (fromPath) return fromPath;

  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  if (existsSync(nvmRoot)) {
    const versions = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => NUMERIC_COLLATOR.compare(right, left));
    for (const version of versions) {
      const candidate = path.join(nvmRoot, version, "bin", "codex");
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new Error(
    "Codex CLI not found; set CODEX_BIN to the current codex executable."
  );
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

  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  if (existsSync(nvmRoot)) {
    const versions = readdirSync(nvmRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => NUMERIC_COLLATOR.compare(right, left));
    for (const version of versions) {
      const candidate = path.join(nvmRoot, version, "bin", "copilot");
      if (isExecutable(candidate)) return candidate;
    }
  }
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

export interface CodexAppMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Find the currently installed Codex App tools plugin without depending on a
 * version that Codex Desktop may replace on its next startup.
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
