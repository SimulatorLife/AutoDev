/**
The live runtime context.

A session's rollouts say what it did; they do not say what the runtime was
doing while it did it. This module reads the other side of that: the router's
live status, the threads whose latest turn has not ended, the provider
processes and router processes that are running, and whether the installed
runtime differs from the checkout.

The router status can arrive two ways. The Runtime's Control API answers
from inside the same process, so it hands this module the status directly
rather than making the router call itself over loopback; the CLI, which is
a separate process, reads `GET http://127.0.0.1:4100/status`.
*/

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from "node:fs";
import path from "node:path";

import type {
  SessionBridgeLogAlert,
  SessionEfficiencySummary,
  SessionEfficiencyWorkspaceMcpSummary,
  SessionLiveReport,
  SessionLogFileSummary
} from "@simulatorlife/autodev-core";

import { readHeadMeta, rolloutFiles } from "./rollout-discovery.ts";
import { fileDigest } from "./thread-tracer.ts";
import type { Mutable } from "./working-shapes.ts";

/**
The router's `/status` body, as this module reads it.
*/
export interface RouterStatusBody {
  readonly agents?: {
    readonly canonicalLiveCount?: number;
    readonly byState?: Record<string, number>;
    readonly liveByRole?: Record<string, number>;
  };
  readonly startedAt?: string;
  readonly providers?: Record<string, Record<string, unknown>>;
  readonly usage?: Record<string, unknown>;
}

const COLLATOR = new Intl.Collator();
const ACTIVE_PROCESS_REGEX =
  /\/claude -p|\bagy\b.* -p|\bcopilot\b.* -p|codex-tools-shim|lsp-mcp-server|typescript-language-server/u;
const WHITESPACE_SPLIT_REGEX = /\s+/u;
const SERVICE_PROCESS_REGEX =
  /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+\S*node\S*\s+(\S*(?:router\/server|providers\/\w+)\.ts)/u;
const BRIDGE_LOG_ALERT_REGEX =
  /spawn rejected|missing session header|invalid model selection|Delegation is unavailable|ERR_PACKAGE_PATH_NOT_EXPORTED|earlier message\(s\) left out/u;
const BRIDGE_LOG_TAIL_BYTES = 64 * 1024;
const WRITING_WINDOW_MS = 10 * 60 * 1000;
const OPEN_THREAD_SCAN_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countMap(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") counts[key] = value;
  }
  return counts;
}

/**
Narrow an untrusted router status body to the fields this module reads.
*/
export function parseRouterStatus(raw: unknown): RouterStatusBody | null {
  if (!isRecord(raw)) return null;
  const result: Mutable<RouterStatusBody> = {};
  if (typeof raw.startedAt === "string") result.startedAt = raw.startedAt;
  if (isRecord(raw.agents)) {
    const agents: Mutable<NonNullable<RouterStatusBody["agents"]>> = {};
    if (typeof raw.agents.canonicalLiveCount === "number")
      agents.canonicalLiveCount = raw.agents.canonicalLiveCount;
    const byState = countMap(raw.agents.byState);
    if (byState) agents.byState = byState;
    const liveByRole = countMap(raw.agents.liveByRole);
    if (liveByRole) agents.liveByRole = liveByRole;
    result.agents = agents;
  }
  if (isRecord(raw.providers)) {
    const providers: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(raw.providers)) {
      if (isRecord(value)) providers[key] = value;
    }
    result.providers = providers;
  }
  if (isRecord(raw.usage)) result.usage = raw.usage;
  return result;
}

function run(command: string, arguments_: string[]): string {
  try {
    return execFileSync(command, arguments_, { encoding: "utf8", timeout: 5000 });
  } catch {
    return "";
  }
}

function providerProcesses(): string[] {
  // Command lines can carry prompts; keep the executable and flags only.
  return run("ps", ["-Ao", "pid,ppid,etime,command"])
    .split("\n")
    .filter((line) => ACTIVE_PROCESS_REGEX.test(line))
    .map((line) =>
      line.trim().split(WHITESPACE_SPLIT_REGEX).slice(0, 5).join(" ")
    );
}

/**
Router and bridge processes, with when they started.
*/
function services(): SessionLiveReport["services"] {
  return run("ps", ["-Ao", "pid,lstart,command"])
    .split("\n")
    .flatMap((line) => {
      const match = SERVICE_PROCESS_REGEX.exec(line);
      return match
        ? [
            {
              pid: match[1]!,
              started: new Date(match[2]!).toISOString(),
              script: match[3]!
            }
          ]
        : [];
    });
}

function readTailText(
  file: string,
  maxBytes: number
): { text: string; full: boolean } {
  const size = statSync(file).size;
  const length = Math.min(size, maxBytes);
  if (length === 0) return { text: "", full: true };
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), full: length === size };
  } finally {
    closeSync(fd);
  }
}

function turnMarkers(source: string): { started: number; ended: number } {
  return {
    started: source.lastIndexOf('"type":"task_started"'),
    ended: Math.max(
      source.lastIndexOf('"type":"task_complete"'),
      source.lastIndexOf('"type":"turn_aborted"')
    )
  };
}

/**
Whether the rollout's latest turn has started and not yet ended.
*/
export function hasOpenTurn(file: string): boolean {
  const { text, full } = readTailText(file, 256 * 1024);
  // A long turn's start can lie far before the tail; read the whole file then.
  let { started, ended } = turnMarkers(text);
  if (started < 0 && ended < 0 && !full)
    ({ started, ended } = turnMarkers(readFileSync(file, "utf8")));
  return started > ended;
}

function checkoutRuntimeSourceRoot(repositoryRoot: string): string | null {
  const monorepoRuntimeSource = path.join(repositoryRoot, "runtime", "src");
  if (
    existsSync(path.join(repositoryRoot, "runtime", "package.json")) &&
    existsSync(monorepoRuntimeSource)
  )
    return monorepoRuntimeSource;
  const legacySource = path.join(repositoryRoot, "src");
  return existsSync(legacySource) ? legacySource : null;
}

/**
Installed runtime modules that differ from the checkout.

The running services execute the installed copies, so a fix that is only in
the checkout is not live.
*/
export function deploymentDrift(
  codexHome: string,
  repositoryRoot: string | null | undefined
): SessionLiveReport["drift"] {
  const installedRoot = path.join(codexHome, "src");
  const checkoutSourceRoot = repositoryRoot ? checkoutRuntimeSourceRoot(repositoryRoot) : null;
  if (!checkoutSourceRoot || !existsSync(installedRoot)) return null;
  const differing: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(installedRoot, filePath);
      const source = path.join(checkoutSourceRoot, rel);
      checked += 1;
      if (!existsSync(source)) missing.push(rel);
      else if (fileDigest(source) !== fileDigest(filePath)) differing.push(rel);
    }
  };
  visit(installedRoot);
  return { checked, differing, missing };
}

/**
The log files the diagnostics read, newest first.
*/
export function readLogSummaries(codexHome: string): SessionLogFileSummary[] {
  const candidates = [
    path.join(codexHome, "run"),
    path.join(codexHome, "hooks")
  ].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".log"))
          .map((name) => path.join(dir, name))
      : []
  );
  return candidates
    .map((file) => {
      const stat = statSync(file);
      return { file, modified: stat.mtime.toISOString(), bytes: stat.size };
    })
    .sort((a, b) => COLLATOR.compare(b.modified, a.modified));
}

/**
The bridge-log lines that report a problem worth surfacing.
*/
export function readBridgeLogAlerts(
  codexHome: string
): SessionBridgeLogAlert[] {
  const hooksDir = path.join(codexHome, "hooks");
  if (!existsSync(hooksDir)) return [];
  const alerts: SessionBridgeLogAlert[] = [];
  for (const name of readdirSync(hooksDir).sort()) {
    if (!name.endsWith(".launchd.log")) continue;
    const { text } = readTailText(
      path.join(hooksDir, name),
      BRIDGE_LOG_TAIL_BYTES
    );
    const matched = text
      .split("\n")
      .filter((line) => BRIDGE_LOG_ALERT_REGEX.test(line));
    if (matched.length > 0) {
      alerts.push({
        file: name,
        count: matched.length,
        samples: matched
          .slice(-3)
          .map((line) => line.replaceAll(/\s+/gu, " ").trim().slice(0, 160))
      });
    }
  }
  return alerts;
}

function readRouterStateFields(codexHome: string): {
  disabledProviders: string[];
  nullRoleModels: string[];
} {
  const stateFile = path.join(codexHome, "codex-router-state.json");
  if (!existsSync(stateFile)) {
    return { disabledProviders: [], nullRoleModels: [] };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (!isRecord(raw)) return { disabledProviders: [], nullRoleModels: [] };
    const disabledProviders = Array.isArray(raw.disabledProviders)
      ? raw.disabledProviders.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const nullRoleModels: string[] = [];
    if (isRecord(raw.roleAssignments)) {
      for (const [provider, roles] of Object.entries(raw.roleAssignments)) {
        if (!isRecord(roles)) continue;
        for (const [role, entry] of Object.entries(roles)) {
          if (isRecord(entry) && entry.model === null) {
            nullRoleModels.push(`${provider}.${role}`);
          }
        }
      }
    }
    return { disabledProviders, nullRoleModels };
  } catch {
    return { disabledProviders: [], nullRoleModels: [] };
  }
}

function parseExposedServers(raw: unknown): Record<string, number> {
  const exposed: Record<string, number> = {};
  if (!Array.isArray(raw)) return exposed;
  for (const row of raw) {
    if (
      isRecord(row) &&
      typeof row.server === "string" &&
      typeof row.count === "number"
    ) {
      exposed[row.server] = row.count;
    }
  }
  return exposed;
}

function parseUsedServers(raw: unknown): Record<string, number> {
  const used: Record<string, number> = {};
  if (!isRecord(raw)) return used;
  for (const [server, count] of Object.entries(raw)) {
    if (typeof count === "number") used[server] = count;
  }
  return used;
}

function parseTopBridgeTools(
  raw: unknown
): { tool: string; ok: number; error: number }[] {
  if (!Array.isArray(raw)) return [];
  const tools: { tool: string; ok: number; error: number }[] = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.tool !== "string") continue;
    const byStatus = isRecord(row.byStatus) ? row.byStatus : {};
    const ok = typeof byStatus.ok === "number" ? byStatus.ok : 0;
    const error = typeof byStatus.error === "number" ? byStatus.error : 0;
    tools.push({ tool: row.tool, ok, error });
  }
  tools.sort((a, b) => b.ok + b.error - (a.ok + a.error));
  return tools.slice(0, 8);
}

function readWorkspaceMcpSummaries(
  status: RouterStatusBody
): SessionEfficiencyWorkspaceMcpSummary[] {
  const byWorkspace =
    isRecord(status.usage) && isRecord(status.usage.byWorkspace)
      ? status.usage.byWorkspace
      : null;
  if (!byWorkspace) return [];
  const out: SessionEfficiencyWorkspaceMcpSummary[] = [];
  for (const [workspace, entry] of Object.entries(byWorkspace)) {
    if (!isRecord(entry)) continue;
    out.push({
      workspace,
      exposed: parseExposedServers(entry.mcpExposed),
      used: parseUsedServers(entry.byMcp),
      topTools: parseTopBridgeTools(entry.bridgeTools)
    });
  }
  return out;
}

function readProviderFailuresSummary(
  status: RouterStatusBody
): NonNullable<SessionEfficiencySummary["providerLastFailures"]> {
  if (!status.providers) return [];
  const rows: {
    provider: string;
    status: string | null;
    cooldownKind: string | null;
    lastFailureClass: string | null;
    lastFailureStatus: number | null;
  }[] = [];
  for (const [provider, info] of Object.entries(status.providers)) {
    const lastFailure = isRecord(info.lastFailure) ? info.lastFailure : null;
    const cooldownKind =
      typeof info.cooldownKind === "string" ? info.cooldownKind : null;
    const providerStatus = typeof info.status === "string" ? info.status : null;
    if (!cooldownKind && !lastFailure && providerStatus === "ready") continue;
    rows.push({
      provider,
      status: providerStatus,
      cooldownKind,
      lastFailureClass:
        lastFailure && typeof lastFailure.class === "string"
          ? lastFailure.class
          : null,
      lastFailureStatus:
        lastFailure && typeof lastFailure.status === "number"
          ? lastFailure.status
          : null
    });
  }
  return rows;
}

/**
The persisted router state, read beside the live one.
*/
export function buildEfficiencySummary(
  codexHome: string,
  status: RouterStatusBody | null
): SessionEfficiencySummary {
  const { disabledProviders, nullRoleModels } =
    readRouterStateFields(codexHome);
  if (!status) return { disabledProviders, nullRoleModels };
  const providerLastFailures = readProviderFailuresSummary(status);
  const workspaces = readWorkspaceMcpSummaries(status);
  return {
    disabledProviders,
    nullRoleModels,
    ...((providerLastFailures.length > 0) && { providerLastFailures }),
    ...((workspaces.length > 0) && { workspaces })
  };
}

/**
How the live context should be read.
*/
export interface LiveDiagnosticsOptions {
  readonly codexHome: string;
  /**
  Skip everything that reads live state.
  */
  readonly offline: boolean;
  readonly repoRoot?: string | null | undefined;
  /**
  The router's live status, read by the owner of the router.
  
  The Control API passes the router's own status in-process, so it does not
  have to call itself over loopback; the CLI passes a reader for the
  router's endpoint. Either may be absent, and then the router's live state
  was not observed.
  */
  readonly routerStatus?: (() => unknown | Promise<unknown>) | undefined;
}

/**
The live context, and the router status it was read from.
*/
export interface LiveDiagnosticsResult {
  readonly live: SessionLiveReport | null;
  readonly status: RouterStatusBody | null;
}

/**
The router's live status, read through the owner of the router.

Data does not reach out to the router: the Runtime owns that service, and it
hands the status in -- in-process for the Control API, over the router's own
endpoint for the CLI. A reader that cannot reach the router reports it as
unreachable rather than guessing.
*/
async function readRouterStatus(
  options: LiveDiagnosticsOptions
): Promise<RouterStatusBody | null> {
  if (!options.routerStatus) return null;
  try {
    return parseRouterStatus(await options.routerStatus());
  } catch {
    // The router is down or not reachable: reported as such.
    return null;
  }
}

/**
Read the live runtime context beside a session's rollouts.
*/
export async function collectLiveDiagnostics(
  options: LiveDiagnosticsOptions
): Promise<LiveDiagnosticsResult> {
  if (options.offline) return { live: null, status: null };
  const parsedStatus = await readRouterStatus(options);
  const router: SessionLiveReport["router"] = {
    reachable: parsedStatus !== null,
    canonicalLiveCount: parsedStatus?.agents?.canonicalLiveCount ?? null,
    byState: parsedStatus?.agents?.byState ?? null,
    liveByRole: parsedStatus?.agents?.liveByRole ?? null,
    startedAt: parsedStatus?.startedAt ?? null
  };
  const cutoff = Date.now() - WRITING_WINDOW_MS;
  const openThreads = rolloutFiles(path.join(options.codexHome, "sessions"))
    .reverse()
    .slice(0, OPEN_THREAD_SCAN_LIMIT)
    .flatMap((file) => {
      const modified = statSync(file).mtimeMs;
      if (modified < cutoff || !hasOpenTurn(file)) return [];
      const meta = readHeadMeta(file);
      return [
        {
          id: typeof meta?.id === "string" ? meta.id : file,
          modified: new Date(modified).toISOString()
        }
      ];
    });
  return {
    live: {
      router,
      openThreads,
      processes: providerProcesses(),
      services: services(),
      drift: deploymentDrift(options.codexHome, options.repoRoot)
    },
    status: parsedStatus
  };
}
