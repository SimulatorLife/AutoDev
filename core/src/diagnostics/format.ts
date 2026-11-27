/**
The text rendering of the session diagnostics.

The same report is rendered by the Control API's `?format=text` response, by
`pnpm autodev -- diagnostics`, and by the skill wrapper. When each of those
formatted its own copy, the CLI and the HTTP answer described the same
session differently -- which is exactly the drift this module removes.

Everything here is pure: no clock, no filesystem, no network. The engine that
produces the report lives in `@simulatorlife/autodev-data/diagnostics`.
*/

import {
  classifyToolFailure,
  type FleetSessionRow,
  type HookDenialSummary,
  type SessionDiagnosticsReport,
  type SessionEfficiencySummary,
  type SessionFleetScanResponse,
  type SessionLiveReport,
  type SessionRecentListResponse,
  type SessionRouterEventRow,
  type SessionRouterSkippedEvent,
  type SessionRouterSummary,
  type SessionThreadEfficiency,
  type SessionThreadItem,
  type SessionThreadPromptOverhead,
  type SessionThreadTrace,
  type SessionToolFailure,
  type ToolFailureCategory
} from "./types.ts";

/**
What the text rendering includes.
*/
export interface SessionDiagnosticsTextOptions {
  /**
  Include the failing tool calls' details.
  */
  readonly failures?: boolean;
  /**
  Include every failing tool call, not the first few per category.
  */
  readonly allFailures?: boolean;
  /**
  Include the token, compaction and prompt-overhead lines.
  */
  readonly efficiency?: boolean;
  /**
  Include the paginated rollout items.
  */
  readonly items?: boolean;
  /**
  Include the paginated router events.
  */
  readonly events?: boolean;
}

const EXCERPT = 160;
const FAILURE_PREVIEW_INPUT_EXCERPT = 180;
const FAILURE_CAP_PER_CATEGORY = 2;
const BYTES_PER_MIB = 1_048_576;
const INDENT = ' '.repeat(3);
const DASH = "-";
const SKILL_READ_PREVIEW_LIMIT = 8;
const TRAILING_SEPARATORS_REGEX = /[\\/]+$/u;
const QUESTION = "?";
const PERCENT = "%";
const THREAD_HEADING = "== thread ";
const LIVE_HEADING = "== live now";
const EFFICIENCY_HEADING = "== efficiency & persisted router state";
const LOG_HEADING =
  "== log freshness (bridge logs carry no timestamps; correlate by order and mtime)";
const BRIDGE_HEADING = "== bridge log alerts (tail 64 KB)";

/**
The last path segment of a path, without the filesystem.

The fleet scan renders a workspace as its directory name. The Console and the
CLI both need that name, and the Core layer cannot read the filesystem, so
the one segment is taken from the string.
*/
function lastSegment(value: string | null): string {
  if (value === null || value === "") return DASH;
  const normalized = value.replace(TRAILING_SEPARATORS_REGEX, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function excerpt(value: unknown, maxLength = EXCERPT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB) return `${(bytes / BYTES_PER_MIB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function countBy(
  entries: Iterable<readonly [string, number]>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, count] of entries)
    counts.set(key, (counts.get(key) ?? 0) + count);
  return counts;
}

function topCounts(counts: Map<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`)
    .join(" ");
}

function renderSkippedRouterSummary(
  skipped: readonly SessionRouterSkippedEvent[]
): string {
  const counts = countBy(
    skipped.map((entry) => [`${entry.provider ?? QUESTION}:${entry.reason}`, 1])
  );
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  const first = skipped[0]!;
  return `${INDENT}ROUTER SKIPPED ${skipped.length} (${summary}) first=${first.at.slice(11, 23)} ${first.requestId.slice(0, 8)}`;
}

function renderRouterRetries(router: SessionRouterSummary): string | null {
  const parts: string[] = [];
  if (router.retries) parts.push(`retries=${router.retries}`);
  if (router.transportErrors)
    parts.push(`transport_errors=${router.transportErrors}`);
  if (router.exhaustionWaits) {
    parts.push(
      `exhaustion_waits=${router.exhaustionWaits.count} (${Math.round(router.exhaustionWaits.totalMs / 1000)}s)`
    );
  }
  return parts.length > 0 ? `${INDENT}ROUTER RETRIES ${parts.join(" ")}` : null;
}

function renderRouterEventLine(event: SessionRouterEventRow): string {
  const reasonPart =
    event.reason && event.reason !== event.failureClass
      ? ` reason=${event.reason}`
      : "";
  const errorPart = event.errorCode ? ` err=${event.errorCode}` : "";
  const elapsedPart = event.elapsedMs === null ? "" : ` ${event.elapsedMs}ms`;
  const toolsPart =
    event.phase === "result" ? ` tools=${event.toolCalls ?? 0}` : "";
  return (
    `${INDENT}${event.at.slice(11, 23)} ${event.requestId.slice(0, 8)} ${event.phase} ${event.provider ?? DASH}/${event.model ?? DASH}` +
    `${event.outcome ? ` ${event.outcome}` : ""}${event.status ? ` ${event.status}` : ""}${event.failureClass ? ` ${event.failureClass}` : ""}` +
    `${reasonPart}${errorPart}${elapsedPart}${toolsPart}`
  );
}

function renderRouterFailureLine(
  failure: SessionRouterSummary["failures"][number]
): string {
  const reasonSuffix =
    failure.spawnFailureReason &&
    failure.spawnFailureReason !== failure.failureClass
      ? ` (${failure.spawnFailureReason})`
      : "";
  return `${INDENT}ROUTER FAILURE ${failure.at.slice(11, 23)} ${failure.requestId.slice(0, 8)} ${failure.provider ?? DASH} ${failure.status ?? DASH} ${failure.failureClass ?? DASH}${reasonSuffix} ${failure.elapsedMs ?? DASH}ms`;
}

function renderRouterDetails(router: SessionRouterSummary): string[] {
  const lines: string[] = [];
  const providers = Object.entries(router.byProvider).map(
    ([provider, entry]) =>
      `${provider}: ${entry.requests} req, ${entry.failures} failed, ${Math.round(entry.elapsedMs / 1000)}s, tools=${entry.toolCalls}`
  );
  lines.push(
    `${INDENT}router (${router.matchedBy}) ${router.requests} requests; ${providers.join("; ") || "no results"}`
  );
  if (router.providerSequence.length > 1)
    lines.push(`${INDENT}PROVIDER HOPS ${router.providerSequence.join(" → ")}`);
  if (router.modelSequence.length > 0)
    lines.push(`${INDENT}upstream models ${router.modelSequence.join(" → ")}`);
  if (router.skipped && router.skipped.length > 0)
    lines.push(renderSkippedRouterSummary(router.skipped));
  const retryLine = renderRouterRetries(router);
  if (retryLine) lines.push(retryLine);
  for (const failure of router.failures)
    lines.push(renderRouterFailureLine(failure));
  for (const event of router.events ?? [])
    lines.push(renderRouterEventLine(event));
  return lines;
}

function renderThreadEfficiency(efficiency: SessionThreadEfficiency): string[] {
  const { tokens, compaction, prompt } = efficiency;
  const tokenLine = tokens.observed
    ? `${INDENT}efficiency tokens=${formatCompactNumber(tokens.totalTokens)} ` +
      `(in=${formatCompactNumber(tokens.inputTokens)} cached=${formatCompactNumber(tokens.cachedInputTokens)} ` +
      `[${tokens.cacheHitPct ?? QUESTION}${PERCENT}] out=${formatCompactNumber(tokens.outputTokens)} ` +
      `reasoning=${formatCompactNumber(tokens.reasoningOutputTokens)} [${tokens.reasoningPct ?? QUESTION}${PERCENT}]) ` +
      `peak-in=${formatCompactNumber(tokens.peakInputTokens)} cache-drops=${tokens.cacheDrops}`
    : `${INDENT}efficiency tokens=unreported (0 non-zero samples)`;
  const compLine =
    `${INDENT}compactions=${compaction.count} (context_compacted=${compaction.contextCompactedEvents}) ` +
    `max-replacement=${compaction.maxReplacementItems} items/${formatBytes(compaction.maxReplacementBytes)}/imgs=${compaction.maxReplacementImages} ` +
    `response-images=${compaction.responseImageItems}`;
  const roots = Object.entries(prompt.skillsByRoot)
    .sort((a, b) => b[1] - a[1])
    .map(([root, count]) => `${root}=${count}`)
    .join(" ");
  const promptLine =
    `${INDENT}prompt dev=${formatBytes(prompt.initialDeveloperBytes)}/${prompt.initialDeveloperChars} chars/` +
    `${prompt.initialDeveloperTokens ?? QUESTION} tokens skills-block=${formatBytes(prompt.skillsCatalogBytes)} ` +
    `loaded=${prompt.skillsLoaded} (${roots || "none"}) read=${prompt.skillsRead.length}${skillReadPreview(prompt)} ` +
    `telemetry-reads=${prompt.skillTelemetryReads ?? QUESTION}`;
  return [tokenLine, compLine, promptLine];
}

/**
The first skills a thread read, each with its read count when repeated.
*/
function skillReadPreview(prompt: SessionThreadPromptOverhead): string {
  if (prompt.skillsRead.length === 0) return "";
  const shown = prompt.skillsRead
    .slice(0, SKILL_READ_PREVIEW_LIMIT)
    .map((skill) => {
      const count = prompt.skillReadCounts[skill] ?? 1;
      return count > 1 ? `${skill}×${count}` : skill;
    });
  const more = prompt.skillsRead.length > SKILL_READ_PREVIEW_LIMIT ? ", …" : "";
  return ` [${shown.join(", ")}${more}]`;
}

function renderThreadFailures(
  toolFailures: readonly SessionToolFailure[],
  includeInput: boolean,
  allFailures: boolean
): string[] {
  if (toolFailures.length === 0) return [];
  const lines: string[] = [];
  const counts = countBy(
    toolFailures.map((failure) => [
      failure.category ?? classifyToolFailure(failure.detail, failure.input),
      1
    ])
  );
  if (toolFailures.length > 1) {
    lines.push(
      `${INDENT}TOOL FAILURES total=${toolFailures.length} (${topCounts(counts)})`
    );
  }
  const shown = new Map<ToolFailureCategory, number>();
  const omitted = new Map<ToolFailureCategory, number>();
  for (const failure of toolFailures) {
    const category =
      failure.category ?? classifyToolFailure(failure.detail, failure.input);
    const seen = shown.get(category) ?? 0;
    if (allFailures || seen < FAILURE_CAP_PER_CATEGORY) {
      shown.set(category, seen + 1);
      lines.push(
        `${INDENT}TOOL FAILED ${failure.at.slice(11, 19)} ${failure.tool} call=${failure.callId} :: ${failure.detail}`
      );
      if (includeInput && failure.input) {
        const renderedInput = allFailures
          ? failure.input
          : excerpt(failure.input, FAILURE_PREVIEW_INPUT_EXCERPT);
        lines.push(`${INDENT}  input=${renderedInput}`);
      }
    } else {
      omitted.set(category, (omitted.get(category) ?? 0) + 1);
    }
  }
  for (const [category, hidden] of omitted) {
    lines.push(
      `${INDENT}... (+${hidden} more ${category} failures; pass --all-failures to list all)`
    );
  }
  return lines;
}

function renderInvestigation(thread: SessionThreadTrace): string {
  const { investigation } = thread;
  if (!investigation.observed)
    return `${INDENT}investigation unavailable (no item events)`;
  const { context } = investigation;
  return [
    `${INDENT}investigation`,
    `first-edit=${investigation.firstEditAt === null ? "none" : investigation.firstEditAt.slice(11, 19) || QUESTION}`,
    `calls=${investigation.toolCalls}`,
    `tokens=${investigation.tokens ?? QUESTION}`,
    `files-read=${investigation.filesRead}`,
    `repeated-reads=${investigation.repeatedReads}`,
    `searches=${investigation.searches}`,
    `repeated-searches=${investigation.repeatedSearches}`,
    `ccc=${context.ccc}`,
    `cgc=${context.cgc}`,
    `lsp=${context.lsp}`
  ].join(" ");
}

function renderThreadSection(
  thread: SessionThreadTrace,
  router: SessionRouterSummary | undefined,
  options: {
    failures?: boolean;
    allFailures?: boolean;
    efficiency?: boolean;
  } = {}
): string[] {
  const lines: string[] = [
    `${THREAD_HEADING}${thread.id} ${thread.nickname ? `(${thread.nickname}) ` : ""}role=${thread.role ?? DASH} model=${thread.model ?? DASH} codex=${thread.cliVersion ?? DASH} client=${thread.clientSurface ?? DASH}`,
    `${INDENT}session=${thread.sessionId ?? DASH} parent=${thread.parentId ?? DASH} ${thread.start ?? QUESTION} → ${thread.end ?? QUESTION}`,
    `${INDENT}file=${thread.file}`
  ];
  for (const turn of thread.turns)
    lines.push(
      `${INDENT}turn ${turn.turnId} ${turn.started ?? QUESTION} → ${turn.ended ?? "open"} ${turn.outcome}${turn.detail ? ` :: ${turn.detail}` : ""}`
    );
  for (const gap of thread.gaps)
    lines.push(
      `${INDENT}GAP ${gap.seconds}s after ${gap.after} (${gap.at}) before ${gap.before}`
    );
  const tools = Object.entries(thread.tools).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0)
    lines.push(
      `${INDENT}tools ${tools.map(([tool, count]) => `${tool}=${count}`).join(" ")}`
    );
  lines.push(renderInvestigation(thread));
  if (options.efficiency && thread.efficiency) {
    lines.push(...renderThreadEfficiency(thread.efficiency));
  }
  if (thread.anomalies && thread.anomalies.tagOnlyMessages > 0) {
    lines.push(
      `${INDENT}ANOMALY tag-only assistant messages: ${thread.anomalies.tagOnlyMessages} (${thread.anomalies.samples.join(", ")})`
    );
  }
  lines.push(
    ...renderThreadFailures(
      thread.toolFailures,
      options.failures ?? false,
      options.allFailures ?? false
    )
  );
  if (router) lines.push(...renderRouterDetails(router));
  return lines;
}

function renderLiveSection(live: SessionLiveReport): string[] {
  const { router, openThreads, processes, services, drift } = live;
  const lines: string[] = [
    LIVE_HEADING,
    router.reachable
      ? `${INDENT}router (started ${router.startedAt}) live agents=${router.canonicalLiveCount} byState=${JSON.stringify(router.byState)} byRole=${JSON.stringify(router.liveByRole)}`
      : `${INDENT}router /status unreachable`,
    `${INDENT}threads with an open turn (written in the last 10 min): ${openThreads.length}${openThreads.length > 0 ? ` (${openThreads.map((thread) => thread.id).join(", ")})` : ""}`
  ];
  if (
    router.canonicalLiveCount !== null &&
    router.canonicalLiveCount !== openThreads.length
  ) {
    lines.push(
      `${INDENT}LIVE COUNT MISMATCH: router ${router.canonicalLiveCount} vs ${openThreads.length} open threads -- above: something keys activity per request; below: reports land on the wrong agent, or an agent went stale`
    );
  }
  for (const service of services)
    lines.push(
      `${INDENT}service pid=${service.pid} started=${service.started} ${service.script}`
    );
  if (drift) {
    lines.push(
      `${INDENT}deployed $CODEX_HOME/src vs checkout: ${drift.checked} files, ${drift.differing.length} differ, ${drift.missing.length} not in checkout`
    );
    for (const file of drift.differing.slice(0, 15))
      lines.push(`${INDENT}DRIFT ${file}`);
  }
  lines.push(
    `${INDENT}provider CLIs / MCP servers running: ${processes.length === 0 ? "none" : ""}`
  );
  for (const line of processes) lines.push(`${INDENT}  ${line}`);
  return lines;
}

function renderEfficiencySection(
  efficiency: SessionEfficiencySummary
): string[] {
  const lines: string[] = [
    EFFICIENCY_HEADING,
    `${INDENT}disabledProviders=${JSON.stringify(efficiency.disabledProviders)} nullRoleModels=${JSON.stringify(efficiency.nullRoleModels)}`
  ];
  for (const provider of efficiency.providerLastFailures ?? []) {
    lines.push(
      `${INDENT}provider ${provider.provider}: status=${provider.status ?? DASH} cooldown=${provider.cooldownKind ?? "none"} lastFailure=${provider.lastFailureClass ?? DASH} (${provider.lastFailureStatus ?? DASH})`
    );
  }
  return lines;
}

function renderItemLine(item: SessionThreadItem): string {
  return `${INDENT}${item.at.slice(11, 19)} ${item.kind} ${item.detail}`;
}

/**
Render one session's diagnostics as text.

The rendering is deterministic: the same report always produces the same
text, so the CLI's output and the Control API's `?format=text` response are
byte-identical for the same evidence.
*/
export function renderSessionDiagnosticsReport(
  report: SessionDiagnosticsReport,
  options: SessionDiagnosticsTextOptions = {}
): string {
  const showEfficiency = options.efficiency ?? report.efficiency !== null;
  const out: string[] = [];
  if (!report.found) {
    out.push(
      "No rollout or retained native lifecycle observation found for that id. Try --recent."
    );
  }
  if (report.nativeSession) {
    const native = report.nativeSession;
    out.push(
      `Native session ${report.rootSessionId ?? report.requestedId} client=${report.clientSurface ?? DASH} model=${native.model ?? DASH} workspace=${native.workspace ?? DASH}`,
      `started=${native.startedAt ?? DASH} last-observed=${native.lastObservedAt} ended=${native.endedAt ?? DASH}`,
      "Native transcript and per-turn diagnostics not observed."
    );
    return out.join("\n");
  }
  for (const thread of report.threads) {
    const router = report.router.find((entry) => entry.thread === thread.id);
    out.push(
      ...renderThreadSection(thread, router, {
        ...options,
        efficiency: showEfficiency
      })
    );
  }
  if (options.events) {
    for (const event of report.eventsPage.items)
      out.push(renderRouterEventLine(event));
  }
  if (options.items) {
    for (const item of report.itemsPage.items) out.push(renderItemLine(item));
  }
  if (report.live) out.push(...renderLiveSection(report.live));
  if (report.efficiency)
    out.push(...renderEfficiencySection(report.efficiency));
  out.push(LOG_HEADING);
  for (const log of report.logs.slice(0, 8))
    out.push(
      `${INDENT}${log.modified} ${String(log.bytes).padStart(10)} ${log.file}`
    );
  if (report.bridgeAlerts.length > 0) {
    out.push(BRIDGE_HEADING);
    for (const alert of report.bridgeAlerts) {
      out.push(`${INDENT}${alert.file}: ${alert.count} matching line(s)`);
      for (const sample of alert.samples) out.push(`${INDENT}  ${sample}`);
    }
  }
  return out.join("\n");
}

/**
Render the recent-sessions listing as text.
*/
export function renderRecentSessions(
  response: SessionRecentListResponse
): string {
  return response.sessions
    .map(
      (session) =>
        `${session.lastWrite} ${session.id} threads=${session.id.startsWith("native:") ? DASH : session.threads} client=${session.clientSurface ?? DASH} started=${session.started} cwd=${session.cwd ?? DASH}`
    )
    .join("\n");
}

/**
Render one fleet-scan row as text.
*/
export function renderFleetSessionRow(row: FleetSessionRow): string {
  const repository = lastSegment(row.cwd);
  const topFail = row.topFailureCategory ? ` (${row.topFailureCategory})` : "";
  const providerSummary = Object.entries(row.providers)
    .sort((a, b) => b[1] - a[1])
    .map(([provider, count]) => `${provider}:${count}`)
    .join(",");
  const skipCount = Object.values(row.routerSkipped).reduce(
    (total, count) => total + count,
    0
  );
  return (
    `${INDENT}${row.lastWrite.slice(0, 16)} ${row.id} [${repository}] client=${row.clientSurface ?? DASH} th=${row.threads} tok=${formatCompactNumber(row.totalTokens)} ` +
    `cache=${row.cacheHitPct ?? QUESTION}${PERCENT} drops=${row.cacheDrops} comp=${row.compactions} skills<=${row.maxSkillsLoaded} ` +
    `fail=${row.toolFailures}${topFail} hooks=${row.preToolUseBlocks} skip=${skipCount} req=${providerSummary || DASH}`
  );
}

/**
Render the fleet scan as text.
*/
export function renderFleetScanReport(
  report: SessionFleetScanResponse
): string {
  const totals = report.totals;
  const lines = [
    `== fleet scan (${totals.sessions} sessions, ${totals.threads} threads)`,
    `${INDENT}totals: tokens=${formatCompactNumber(totals.totalTokens)} cache=${totals.cacheHitPct ?? QUESTION}${PERCENT} cache-drops=${totals.cacheDrops} compactions=${totals.compactions}`
  ];
  for (const session of report.sessions)
    lines.push(renderFleetSessionRow(session));
  if (report.recentSessions) {
    const rolloutIds = new Set(report.sessions.map((session) => session.id));
    for (const session of report.recentSessions) {
      if (!rolloutIds.has(session.id)) {
        lines.push(
          `${INDENT}${session.lastWrite} ${session.id} client=${session.clientSurface ?? DASH} (native lifecycle; rollout metrics not observed)`
        );
      }
    }
  }
  const categorySummary = Object.entries(totals.toolFailuresByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${category}=${count}`)
    .join(" ");
  if (categorySummary)
    lines.push(`${INDENT}failures-by-category: ${categorySummary}`);
  if (totals.routerSkippedByReason.length > 0) {
    lines.push(
      `${INDENT}router-skipped: ${totals.routerSkippedByReason.map((entry) => `${entry.key}=${entry.count}`).join(" ")}`
    );
  }
  if (totals.preToolUseReasons.length > 0) {
    lines.push(`${INDENT}top pretooluse blocks in rollouts:`);
    for (const item of totals.preToolUseReasons)
      lines.push(
        `${INDENT}  ${String(item.count).padStart(4)}  ${item.reason}`
      );
  }
  return lines.join("\n");
}

/**
Render the hook-denial summary as text.
*/
export function renderHookDenialsReport(summary: HookDenialSummary): string {
  const lines = [
    `== hook denials (${summary.logFile}) since=${summary.cutoff} (${summary.sinceDays}d)`,
    `${INDENT}lines=${summary.totalLines} preToolUseDenials=${summary.preToolUseDenials}`
  ];
  if (summary.preToolUseDenials === 0) {
    lines.push(
      `${INDENT}no structured PreToolUse denial entries in window (reinstall hooks to enable hooks.log capture, or use --scan-recent to aggregate historical rollout blocks)`
    );
    return lines.join("\n");
  }
  const policyText = Object.entries(summary.byPolicy)
    .sort((a, b) => b[1] - a[1])
    .map(([policy, count]) => `${policy}=${count}`)
    .join(" ");
  const roleText = Object.entries(summary.byRole)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}=${count}`)
    .join(" ");
  lines.push(
    `${INDENT}byPolicy: ${policyText}`,
    `${INDENT}byRole: ${roleText}`
  );
  if (summary.byReason.length > 0) {
    lines.push(`${INDENT}top reasons:`);
    for (const item of summary.byReason)
      lines.push(
        `${INDENT}  ${String(item.count).padStart(4)}  ${item.reason}`
      );
  }
  if (summary.topCommands.length > 0) {
    lines.push(`${INDENT}top blocked commands:`);
    for (const item of summary.topCommands)
      lines.push(
        `${INDENT}  ${String(item.count).padStart(4)}  [${item.policy}] ${item.commandHead}`
      );
  }
  return lines.join("\n");
}
