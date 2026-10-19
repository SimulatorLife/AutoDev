/** Read one exact secret from Runtime environment or the owner-only CODEX_HOME file. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const LINE_BREAK = /\r?\n/u;

function valueFor(content: string, name: string): string | null {
  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator < 1 || assignment.slice(0, separator).trim() !== name)
      continue;
    const raw = assignment.slice(separator + 1).trim();
    const first = raw[0];
    const last = raw.at(-1);
    const quoted =
      raw.length >= 2 &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"));
    const value = quoted ? raw.slice(1, -1) : raw;
    return value || null;
  }
  return null;
}

/**
 * Read an exact secret without logging it. Runtime services use this for
 * role-scoped MCP children so a credential need not be copied into a model
 * process environment or MCP command-line argument.
 */
export function readRuntimeSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const home = env.HOME?.trim() || homedir();
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const secretFile =
    env.AUTODEV_OPENLIT_SECRET_FILE?.trim() ||
    path.join(codexHome, "openlit-secrets.env");
  try {
    return valueFor(readFileSync(secretFile, "utf8"), name);
  } catch {
    return null;
  }
}
