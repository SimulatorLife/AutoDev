/**
 * The `pnpm autodev -- diagnostics` command.
 *
 * The command answers the same questions the Control API's diagnostics routes
 * answer, and it reads them from the same engine. In its default online mode
 * it asks the Control API, because the Runtime holds the live router state
 * that a separate process cannot see. With `--offline`, `--codex-home` or
 * `--router-log` -- or when the Control API is not running -- it runs the same
 * `@simulatorlife/autodev-data/diagnostics` engine directly, so there is one
 * implementation of the reading and not two.
 */

import {
  renderFleetScanReport,
  renderHookDenialsReport,
  renderRecentSessions,
  renderSessionDiagnosticsReport,
  safeAutoDevSessionId,
  SESSION_EVENTS_PAGE_DEFAULT,
  SESSION_EVENTS_PAGE_LIMIT,
  SESSION_ITEMS_PAGE_DEFAULT,
  SESSION_ITEMS_PAGE_LIMIT
} from "@simulatorlife/autodev-core";
import {
  buildSessionDiagnosticsReport,
  hookDenialsResponse,
  listRecentSessionsResponse,
  rolloutRoots,
  scanRecentSessions
} from "@simulatorlife/autodev-data/diagnostics";
import { fetchRouterStatus } from "@simulatorlife/autodev-runtime/cli/router-status-client";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { readRuntimeSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

const DEFAULT_CONTROL_API_BASE_URL = "http://127.0.0.1:4101";
const LOCAL_CONTROL_API_ACTOR = "autodev-local";
const TRAILING_SLASHES = /\/+$/u;
const DIGITS_ONLY_REGEX = /^\d+$/u;
const DEFAULT_ROUTER_LOG = "codex-model-router.launchd.err.log";
const DEFAULT_RECENT_LIMIT = 10;
const DEFAULT_HOOK_WINDOW_DAYS = 7;
const REQUEST_TIMEOUT_MS = 20_000;

/** What the command was asked to do. */
export interface DiagnosticsCliOptions {
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
  /** Whether the caller pointed the command at its own codex home or log. */
  readonly customPaths: boolean;
}

function parsePositiveNumber(raw: string, fallback: number): number {
  const parsed = Number(raw.trim());
  return raw.trim().length > 0 && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function defaultCodexHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  const home = env.HOME?.trim();
  return home ? `${home}/.codex` : ".codex";
}

/**
 * Read the command's arguments.
 *
 * Returns null when the arguments name nothing to read, which is the one
 * case the command cannot act on.
 */
export function parseDiagnosticsArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): DiagnosticsCliOptions | null {
  const codexHomeDefault = defaultCodexHome(env);
  let id = "";
  let codexHome = codexHomeDefault;
  let routerLog = "";
  let sinceDays = DEFAULT_HOOK_WINDOW_DAYS;
  let recent: number | null = null;
  let scanRecent: number | null = null;
  let offline = false;
  let json = false;
  let failures = false;
  let allFailures = false;
  let efficiency = false;
  let items = false;
  let events = false;
  let hooks = false;
  let controlApiUrl =
    env.AUTODEV_CONTROL_API_BASE_URL?.trim() || DEFAULT_CONTROL_API_BASE_URL;
  let customPaths = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--items": {
        items = true;
        break;
      }
      case "--events": {
        events = true;
        break;
      }
      case "--failures": {
        failures = true;
        break;
      }
      case "--all-failures": {
        allFailures = true;
        break;
      }
      case "--efficiency": {
        efficiency = true;
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      case "--offline": {
        offline = true;
        break;
      }
      case "--hooks": {
        hooks = true;
        break;
      }
      case "--since": {
        sinceDays = parsePositiveNumber(
          argv[++index] ?? "",
          DEFAULT_HOOK_WINDOW_DAYS
        );
        break;
      }
      case "--codex-home": {
        codexHome = argv[++index] ?? codexHome;
        customPaths = true;
        break;
      }
      case "--router-log": {
        routerLog = argv[++index] ?? "";
        customPaths = true;
        break;
      }
      case "--control-api-url": {
        controlApiUrl = argv[++index] ?? controlApiUrl;
        break;
      }
      case "--recent": {
        recent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
          ? Number(argv[++index])
          : DEFAULT_RECENT_LIMIT;
        break;
      }
      case "--scan-recent": {
        scanRecent = DIGITS_ONLY_REGEX.test(argv[index + 1] ?? "")
          ? Number(argv[++index])
          : DEFAULT_RECENT_LIMIT;
        break;
      }
      default: {
        if (!arg.startsWith("--")) id = arg;
        break;
      }
    }
  }
  if (!id && recent === null && scanRecent === null && !hooks) return null;
  return {
    id,
    codexHome,
    routerLog: routerLog || `${codexHome}/run/${DEFAULT_ROUTER_LOG}`,
    offline,
    json,
    failures: failures || allFailures,
    allFailures,
    efficiency,
    items,
    events,
    recent,
    scanRecent,
    hooks,
    sinceDays,
    controlApiUrl: controlApiUrl.replace(TRAILING_SLASHES, ""),
    customPaths
  };
}

function usage(): void {
  writeErrorLine(
    [
      "usage: autodev diagnostics <session-or-thread-id> [--items] [--events] [--failures] [--all-failures] [--efficiency] [--json] [--codex-home DIR] [--router-log FILE] [--offline]",
      "       autodev diagnostics --recent [N] [--json] [--codex-home DIR]",
      "       autodev diagnostics --scan-recent [N] [--json] [--codex-home DIR] [--router-log FILE]",
      "       autodev diagnostics --hooks [--since DAYS] [--json] [--codex-home DIR]"
    ].join("\n")
  );
}

/**
 * Whether the command must run the engine itself rather than ask the API.
 *
 * A caller that pointed the command at its own codex home or its own router
 * log is asking about that machine, not about the running Runtime, so the API
 * would answer a different question.
 */
function needsLocalEngine(options: DiagnosticsCliOptions): boolean {
  return options.offline || options.customPaths;
}

async function readControlApi(
  options: DiagnosticsCliOptions,
  path: string
): Promise<string | null> {
  const token = readRuntimeSecret("AUTODEV_CONTROL_API_TOKEN");
  if (!token) return null;
  try {
    const response = await fetch(`${options.controlApiUrl}${path}`, {
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

function controlApiQueryPath(options: DiagnosticsCliOptions): string | null {
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
  const params = new URLSearchParams({
    format,
    includeEfficiency: options.efficiency ? "1" : "0",
    includeFailures: options.failures ? "1" : "0",
    allFailures: options.allFailures ? "1" : "0",
    includeItems: options.items ? "1" : "0",
    includeEvents: options.events ? "1" : "0",
    eventsLimit: String(SESSION_EVENTS_PAGE_DEFAULT),
    eventsOffset: "0",
    itemsLimit: String(SESSION_ITEMS_PAGE_DEFAULT),
    itemsOffset: "0",
    offline: options.offline ? "1" : "0"
  });
  return `/control/diagnostics/sessions/${encodeURIComponent(options.id)}?${params.toString()}`;
}

async function runLocalEngine(options: DiagnosticsCliOptions): Promise<string> {
  if (options.hooks) {
    const body = hookDenialsResponse(options.codexHome, options.sinceDays);
    return options.json
      ? JSON.stringify(body, null, 2)
      : renderHookDenialsReport(body.summary);
  }
  if (options.scanRecent !== null) {
    const body = await scanRecentSessions({
      codexHome: options.codexHome,
      routerLog: options.routerLog,
      limit: options.scanRecent
    });
    return options.json
      ? JSON.stringify(body, null, 2)
      : renderFleetScanReport(body);
  }
  if (options.recent !== null) {
    const body = listRecentSessionsResponse(
      rolloutRoots(options.codexHome),
      options.recent
    );
    return options.json
      ? JSON.stringify(body, null, 2)
      : renderRecentSessions(body);
  }
  const report = await buildSessionDiagnosticsReport({
    id: options.id,
    codexHome: options.codexHome,
    routerLog: options.routerLog,
    offline: options.offline,
    includeEfficiency: options.efficiency,
    includeEvents: options.events,
    eventsLimit: SESSION_EVENTS_PAGE_LIMIT,
    eventsOffset: 0,
    includeItems: options.items,
    itemsLimit: SESSION_ITEMS_PAGE_LIMIT,
    itemsOffset: 0,
    // The Runtime owns the router, so the CLI reads its status and hands it
    // to the engine rather than the engine reaching for it.
    routerStatus: () => fetchRouterStatus().catch(() => null)
  });
  return options.json
    ? JSON.stringify(report, null, 2)
    : renderSessionDiagnosticsReport(report, {
        failures: options.failures,
        allFailures: options.allFailures,
        efficiency: options.efficiency,
        items: options.items,
        events: options.events
      });
}

/**
 * Run the diagnostics command.
 *
 * Returns the process exit code.
 */
export async function runDiagnosticsCommand(
  argv: readonly string[]
): Promise<number> {
  const options = parseDiagnosticsArgs(argv);
  if (!options) {
    usage();
    return 2;
  }
  if (options.id && !safeAutoDevSessionId(options.id)) {
    writeErrorLine("autodev diagnostics: not a valid session identity.");
    return 2;
  }
  if (!needsLocalEngine(options)) {
    const path = controlApiQueryPath(options);
    if (path) {
      const answer = await readControlApi(options, path);
      if (answer !== null) {
        writeLine(answer);
        return 0;
      }
    }
  }
  writeLine(await runLocalEngine(options));
  return 0;
}
