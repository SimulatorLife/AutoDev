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
