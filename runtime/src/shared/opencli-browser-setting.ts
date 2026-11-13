/**
 * Which browser the opencli providers drive: the operator's own Chrome or a
 * dedicated AutoDev-owned Chrome for Testing.
 *
 * - `false` (the default): the operator's everyday Chrome, through opencli's
 *   Browser Bridge extension and its machine-wide daemon. Turns run in the
 *   extension's "OpenCLI" tab group, in the site-slot pool the bridge passes
 *   as `OPENCLI_SITE_SLOTS`.
 * - `true`: the bridge launches its own visible Chrome for Testing with a
 *   private profile and leases each command an exact loopback CDP target
 *   (`opencli-browser.ts`).
 *
 * The Control API writes the setting and the opencli bridge (a separate
 * process) watches it, so a change applies to the next opencli command
 * without restarting anything. The file lives with the bridge's other run
 * state in `$CODEX_HOME/run`.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SCHEMA = "autodev-opencli-browser-v1";

/**
 * `$CODEX_HOME/run/opencli-browser.json`, or `OPENCLI_BROWSER_SETTING_FILE`
 * when set (every test process sets its own).
 */
export function opencliBrowserSettingFile(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env.OPENCLI_BROWSER_SETTING_FILE?.trim();
  if (configured) return configured;
  return path.join(
    env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
    "run",
    "opencli-browser.json"
  );
}

/**
 * Whether the dedicated browser is on. A missing, unreadable or malformed
 * file is the default: the operator's own Chrome.
 */
export function readOpencliDedicatedBrowser(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === SCHEMA &&
      (parsed as { dedicated?: unknown }).dedicated === true
    );
  } catch {
    return false;
  }
}

/** Persist the setting atomically, so the watching bridge never reads half a file. */
export function writeOpencliDedicatedBrowser(
  file: string,
  dedicated: boolean
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ schema: SCHEMA, dedicated })}\n`,
    { mode: 0o600 }
  );
  renameSync(temporary, file);
}
