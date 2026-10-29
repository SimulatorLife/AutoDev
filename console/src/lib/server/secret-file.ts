import { readFileSync } from "node:fs";

/**
 * The one reader for the secrets file the Console's server-side readers share.
 *
 * The Console holds two server-side credentials -- the Control API's and the
 * Usage API's -- and both fall back to the same `openlit-secrets.env` file
 * under the Codex home when their environment variable is unset. The file's
 * format is read here, once: `KEY=value` per line, `#` comments, an optional
 * `export ` prefix, and an optionally quoted value.
 *
 * Two copies of this reader were a second authority over the file's format:
 * a change to one (a different quoting rule, a different comment rule) would
 * have left the other reading the same file differently, and the credential
 * one of them found would have been the one the other could not.
 */

const LINE_SPLIT_PATTERN = /\r?\n/u;

export function readSecretFromFile(
  filePath: string,
  key: string
): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(LINE_SPLIT_PATTERN)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const stripped = trimmed.startsWith("export ")
        ? trimmed.slice(7).trim()
        : trimmed;
      if (!stripped.startsWith(`${key}=`)) continue;
      const rawValue = stripped.slice(key.length + 1).trim();
      const first = rawValue[0];
      const last = rawValue.at(-1);
      const quoted =
        rawValue.length >= 2 &&
        ((first === '"' && last === '"') || (first === "'" && last === "'"));
      const value = quoted ? rawValue.slice(1, -1) : rawValue;
      return value || null;
    }
  } catch {
    return null;
  }
  return null;
}
