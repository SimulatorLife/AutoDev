#!/usr/bin/env node
/**
session-trace.ts -- the skill's entry point for session diagnostics.

The reading of a session's evidence lives in exactly one place: AutoDev's
diagnostics engine (`@simulatorlife/autodev-data/diagnostics`), which the
Runtime's Control API and the `autodev diagnostics` CLI both run. This
script parses no rollout, router log or hook log itself. It asks the
Control API for the answer, because only the running Runtime can see the
live router state; when it cannot reach the API -- or when the caller
pointed the command at its own codex home or router log -- it runs that
same engine through the CLI in this checkout, so the answer comes from
one implementation and not two.

Flags (all preserved from the original script):
  node session-trace.ts <session-or-thread-id> [--items] [--events]
       [--failures] [--all-failures] [--efficiency] [--json]
       [--codex-home DIR] [--router-log FILE] [--offline]
  node session-trace.ts --recent [N]
  node session-trace.ts --scan-recent [N]
  node session-trace.ts --hooks [--since DAYS]
*/

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const LOCAL_CONTROL_API_ACTOR = "autodev-local";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RECENT_LIMIT = 10;
const DEFAULT_HOOK_WINDOW_DAYS = 7;
const TRAILING_SLASHES = /\/+$/u;
const DIGITS_ONLY_REGEX = /^\d+$/u;
const LINE_BREAK = /\r?\n/u;
const SECRET_FILE_NAME = "openlit-secrets.env";
const CLI_RELATIVE_PATH = path.join("runtime", "src", "cli", "autodev.ts");

/**
What the caller asked for.
*/
interface TraceOptions {
  readonly id: string;
  readonly codexHome: string;
  readonly routerLog: string;
  readonly offline: boolean;
  readonly json: boolean;
  readonly failures: boolean;
  readonly allFailures: boolean;
  readonly efficiency: boolean;
  readonly items: boolean;
  readonly events: boolean;
  readonly recent: number | null;
  readonly scanRecent: number | null;
  readonly hooks: boolean;
  readonly sinceDays: number;
  readonly controlApiUrl: string;
  /**
  Whether the caller pointed the command at its own codex home or log.
  */
  readonly customPaths: boolean;
}

type BooleanCliFlag =
  | "items"
  | "events"
  | "failures"
  | "allFailures"
  | "efficiency"
  | "json"
  | "offline"
  | "hooks";

const CLI_BOOLEAN_FLAGS: Record<string, BooleanCliFlag> = {
  "--items": "items",
  "--events": "events",
  "--failures": "failures",
  "--all-failures": "allFailures",
  "--efficiency": "efficiency",
  "--json": "json",
  "--offline": "offline",
  "--hooks": "hooks"
};

function usage(): string {
  return [
    "usage: session-trace.ts <session-or-thread-id> [--items] [--events] [--failures] [--all-failures] [--efficiency] [--json] [--codex-home DIR] [--router-log FILE] [--offline]",
    "       session-trace.ts --recent [N] [--json] [--codex-home DIR]",
    "       session-trace.ts --scan-recent [N] [--json] [--codex-home DIR] [--router-log FILE]",
    "       session-trace.ts --hooks [--since DAYS] [--json] [--codex-home DIR]"
  ].join("\n");
}

function parsePositiveNumber(raw: string, fallback: number): number {
  const parsed = Number(raw.trim());
  return raw.trim().length > 0 && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function defaultCodexHome(environment: NodeJS.ProcessEnv): string {
  const fromEnvironment = environment.CODEX_HOME?.trim();
  if (fromEnvironment) return fromEnvironment;
  const home = environment.HOME?.trim() || homedir();
  return path.join(home, ".codex");
}

function parseArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): TraceOptions | null {
  const codexHomeDefault = defaultCodexHome(environment);
  let id = "";
  let codexHome = codexHomeDefault;
  let routerLog = "";
  let sinceDays = DEFAULT_HOOK_WINDOW_DAYS;
  let recent: number | null = null;
  let scanRecent: number | null = null;
  let controlApiUrl =
    environment.AUTODEV_CONTROL_API_BASE_URL?.trim() || DEFAULT_CONTROL_API_BASE_URL;
  let isCustomPaths = false;
  const flags: Record<BooleanCliFlag, boolean> = {
    items: false,
    events: false,
    failures: false,
    allFailures: false,
    efficiency: false,
    json: false,
    offline: false,
    hooks: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const flagKey = CLI_BOOLEAN_FLAGS[argument];
    if (flagKey) {
      flags[flagKey] = true;
      continue;
    }
    if (argument === "--since") {
      sinceDays = parsePositiveNumber(
        argv[++index] ?? "",
        DEFAULT_HOOK_WINDOW_DAYS
      );
    } else if (argument === "--codex-home") {
      codexHome = argv[++index] ?? codexHome;
      isCustomPaths = true;
    } else if (argument === "--router-log") {
      routerLog = argv[++index] ?? "";
      isCustomPaths = true;
    } else if (argument === "--control-api-url") {
      controlApiUrl = argv[++index] ?? controlApiUrl;
    } else if (argument === "--recent") {
      recent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
        ? Number(argv[++index])
        : DEFAULT_RECENT_LIMIT;
    } else if (argument === "--scan-recent") {
      scanRecent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
        ? Number(argv[++index])
        : DEFAULT_RECENT_LIMIT;
    } else if (!argument.startsWith("--")) {
      id = argument;
    }
  }

  if (!id && recent === null && scanRecent === null && !flags.hooks)
    return null;
  return {
    id,
    codexHome,
    routerLog,
    offline: flags.offline,
    json: flags.json,
    failures: flags.failures || flags.allFailures,
    allFailures: flags.allFailures,
    efficiency: flags.efficiency,
    items: flags.items,
    events: flags.events,
    recent,
    scanRecent,
    hooks: flags.hooks,
    sinceDays,
    controlApiUrl: controlApiUrl.replace(TRAILING_SLASHES, ""),
    customPaths: isCustomPaths
  };
}

/**
Read the Control API token without ever printing it.

The token lives in the environment or in the owner-only secrets file next
to the codex home, which is the same place the Runtime reads it from.
*/
function readControlApiToken(
  options: TraceOptions,
  environment: NodeJS.ProcessEnv
): string | null {
  const direct = environment.AUTODEV_CONTROL_API_TOKEN?.trim();
  if (direct) return direct;
  const secretFile = path.join(options.codexHome, SECRET_FILE_NAME);
  let content: string;
  try {
    content = readFileSync(secretFile, "utf8");
  } catch {
    return null;
  }
  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if ((separator < 1) || (assignment.slice(0, separator).trim() !== "AUTODEV_CONTROL_API_TOKEN"))
      continue;
    const raw = assignment.slice(separator + 1).trim();
    const quoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")));
    const value = quoted ? raw.slice(1, -1) : raw;
    return value || null;
  }
  return null;
}

/**
The Control API path that answers this request.
*/
function controlApiPath(options: TraceOptions): string | null {
  const format = options.json ? "json" : "text";
  if (options.hooks) {
    return `/control/diagnostics/hooks?sinceDays=${options.sinceDays}&format=${format}`;
  }
  if (options.scanRecent !== null) {
    return `/control/diagnostics/sessions/scan?limit=${options.scanRecent}&format=${format}`;
  }
  if (options.recent !== null) {
    return `/control/diagnostics/sessions/recent?limit=${options.recent}&format=${format}`;
  }
  if (!options.id) return null;
  const parameters = new URLSearchParams({
    format,
    includeEfficiency: options.efficiency ? "1" : "0",
    includeFailures: options.failures ? "1" : "0",
    allFailures: options.allFailures ? "1" : "0",
    includeItems: options.items ? "1" : "0",
    includeEvents: options.events ? "1" : "0"
  });
  return `/control/diagnostics/sessions/${encodeURIComponent(options.id)}?${parameters.toString()}`;
}

/**
Ask the Control API, or return null when it cannot answer.
*/
async function readControlApi(
  options: TraceOptions,
  environment: NodeJS.ProcessEnv
): Promise<string | null> {
  const token = readControlApiToken(options, environment);
  const route = controlApiPath(options);
  if (!token || !route) return null;
  try {
    const response = await fetch(`${options.controlApiUrl}${route}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-AutoDev-Actor": LOCAL_CONTROL_API_ACTOR,
        Accept: "text/plain, application/json"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
Find the AutoDev checkout that owns this script.

The skill ships inside the checkout (as `.agents/` or `.claude/`
projections) and is also installed into a codex home, so the checkout is
found by walking up for the CLI entry point.
*/
function findRepositoryRoot(environment: NodeJS.ProcessEnv): string | null {
  const fromEnvironment = environment.AUTODEV_REPO_ROOT?.trim();
  if (fromEnvironment && existsSync(path.join(fromEnvironment, CLI_RELATIVE_PATH)))
    return fromEnvironment;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, CLI_RELATIVE_PATH))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
Run the same engine through the Runtime CLI in this checkout.
*/
function runCliFallback(
  options: TraceOptions,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): number {
  const repositoryRoot = findRepositoryRoot(environment);
  if (!repositoryRoot) {
    process.stderr.write(
      "session-trace: could not find the AutoDev checkout to run the diagnostics engine. Set AUTODEV_REPO_ROOT to the repository path.\n"
    );
    return 2;
  }
  const cli = path.join(repositoryRoot, CLI_RELATIVE_PATH);
  const result = spawnSync(process.execPath, [cli, "diagnostics", ...argv], {
    stdio: "inherit",
    env: environment
  });
  if (result.error) {
    process.stderr.write(
      `session-trace: could not run the diagnostics engine: ${result.error.message}\n`
    );
    return 2;
  }
  return result.status ?? 2;
}

async function main(argv: readonly string[]): Promise<number> {
  const environment = process.env;
  const options = parseArguments(argv, environment);
  if (!options) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const offline = options.offline || options.customPaths;
  if (!offline) {
    const answer = await readControlApi(options, environment);
    if (answer !== null) {
      process.stdout.write(answer.endsWith("\n") ? answer : `${answer}\n`);
      return 0;
    }
  }
  return runCliFallback(options, argv, environment);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
