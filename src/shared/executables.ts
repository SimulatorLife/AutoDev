/**
 * Executable lookup shared by the MCP launcher and platform lifecycle code,
 * so every caller resolves a tool's binary the same way.
 */

import { accessSync, constants } from "node:fs";
import path from "node:path";

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
