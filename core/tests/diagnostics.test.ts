import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyToolFailure,
  type FleetScanTotals,
  type HookDenialSummary,
  isSessionDiagnosticsReport,
  isSessionFleetScanResponse,
  isSessionHookDenialsResponse,
  isSessionRecentListResponse,
  isToolFailureCategory,
  renderFleetScanReport,
  renderHookDenialsReport,
  renderRecentSessions,
  renderSessionDiagnosticsReport,
  SESSION_DIAGNOSTICS_SCHEMA,
  SESSION_FLEET_SCAN_SCHEMA,
  SESSION_HOOK_DENIALS_SCHEMA,
  SESSION_RECENT_LIST_SCHEMA,
  type SessionDiagnosticsAggregates,
  type SessionDiagnosticsReport,
  type SessionFleetScanResponse,
  type SessionHookDenialsResponse,
  type SessionRecentListResponse,
  TOOL_FAILURE_CATEGORIES} from "../src/diagnostics/index.ts";

const SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
const THREAD_ID = "01a0ba16-d54c-78f2-9367-3f80e9a8f75f";

function aggregates(): SessionDiagnosticsAggregates {
  return {
    threadCount: 1,
    totalTokens: 1000,
    inputTokens: 800,
    cachedInputTokens: 400,
    outputTokens: 100,
    reasoningOutputTokens: 50,
    cacheHitPct: 50,
    reasoningPct: 50,
    peakInputTokens: 800,
    cacheDrops: 0,
    compactions: 0,
    contextCompactedEvents: 0,
    maxReplacementItems: 0,
    maxReplacementBytes: 0,
    maxReplacementImages: 0,
    responseImageItems: 0,
    maxInitialDeveloperBytes: 0,
    maxSkillsCatalogBytes: 0,
    maxSkillsLoaded: 0,
    skillsByRoot: {},
    uniqueSkillsRead: 0,
    skillTelemetryReads: null,
    turnsTotal: 1,
    turnsByOutcome: { completed: 1 },
    gapsCount: 0,
    toolCallsTotal: 1,
    toolCallsByName: { read_file: 1 },
    toolFailuresTotal: 1,
    toolFailuresByCategory: { "pretooluse-hook": 1 },
    preToolUseBlocks: 1,
    routerRequests: 1,
    routerFailures: 0,
    routerSkippedTotal: 0,
    routerSkippedByReason: {},
    routerRetries: 0,
    exhaustionWaits: 0,
    transportErrors: 0,
    providerHops: 0,
    byProvider: {
      claude: { requests: 1, failures: 0, elapsedMs: 120, toolCalls: 1 }
    }
  };
}

function report(): SessionDiagnosticsReport {
  return {
    schema: SESSION_DIAGNOSTICS_SCHEMA,
    found: true,
    requestedId: SESSION_ID,
    rootSessionId: SESSION_ID,
    matchedByThreadId: false,
    threads: [
      {
        id: THREAD_ID,
        sessionId: SESSION_ID,
        parentId: null,
        nickname: "worker",
        role: "worker",
        model: "autodev/worker",
        modelProvider: "claude",
        cliVersion: "1.2.3",
        cwd: "/repo",
        file: "/repo/.rollout.jsonl",
        start: "2026-11-10T12:00:00.000Z",
        end: "2026-11-10T12:00:10.000Z",
        counts: { turns: 1 },
        turns: [
          {
            turnId: "t1",
            started: "2026-11-10T12:00:02.000Z",
            ended: "2026-11-10T12:00:10.000Z",
            outcome: "completed",
            detail: "done"
          }
        ],
        gaps: [],
        tools: { read_file: 1 },
        toolFailures: [
          {
            at: "2026-11-10T12:00:05.000Z",
            tool: "read_file",
            callId: "c1",
            detail: "Command blocked by PreToolUse hook: no secrets",
            category: "pretooluse-hook",
            input: "read_file {path:\"README.md\"}"
          }
        ],
        investigation: {
          observed: true,
          firstEditAt: null,
          toolCalls: 1,
          tokens: 1000,
          filesRead: 1,
          repeatedReads: 0,
          searches: 0,
          repeatedSearches: 0,
          context: { ccc: 0, cgc: 0, lsp: 0 }
        }
      }
    ],
    router: [
      {
        thread: THREAD_ID,
        model: "autodev/worker",
        matchedBy: "thread",
        requests: 1,
        byProvider: {
          claude: { requests: 1, failures: 0, elapsedMs: 120, toolCalls: 1 }
        },
        failures: [],
        providerSequence: ["claude"]
      }
    ],
    logs: [
      {
        file: "/repo/run/codex-model-router.launchd.err.log",
        modified: "2026-11-10T12:00:10.000Z",
        bytes: 128
      }
    ],
    bridgeAlerts: [],
    live: null,
    efficiency: null,
    aggregates: aggregates(),
    eventsPage: { items: [], total: 0, limit: 50, offset: 0, hasMore: false },
    itemsPage: { items: [], total: 0, limit: 50, offset: 0, hasMore: false }
  };
}

function recentList(): SessionRecentListResponse {
  return {
    schema: SESSION_RECENT_LIST_SCHEMA,
    limit: 10,
    sessions: [
      {
        id: SESSION_ID,
        started: "2026-11-10T12:00:00.000Z",
        lastWrite: "2026-11-10T12:00:10.000Z",
        threads: 2,
        cwd: "/repo"
      }
    ]
  };
}

function fleetTotals(): FleetScanTotals {
  return {
    sessions: 1,
    threads: 2,
    totalTokens: 1000,
    inputTokens: 800,
    cachedInputTokens: 400,
    cacheHitPct: 50,
    cacheDrops: 0,
    compactions: 0,
    toolFailuresByCategory: { "pretooluse-hook": 1 },
    preToolUseReasons: [{ reason: "no secrets", count: 1 }],
    routerSkippedByReason: [{ key: "probe_unavailable", count: 2 }]
  };
}

function fleetScan(): SessionFleetScanResponse {
  return {
    schema: SESSION_FLEET_SCAN_SCHEMA,
    limit: 10,
    sessions: [
      {
        id: SESSION_ID,
        started: "2026-11-10T12:00:00.000Z",
        lastWrite: "2026-11-10T12:00:10.000Z",
        cwd: "/repo",
        threads: 2,
        totalTokens: 1000,
        inputTokens: 800,
        cachedInputTokens: 400,
        cacheHitPct: 50,
        cacheDrops: 0,
        compactions: 0,
        maxSkillsLoaded: 0,
        toolFailures: 1,
        preToolUseBlocks: 1,
        topFailureCategory: "pretooluse-hook",
        routerRequests: 1,
        routerFailures: 0,
        routerSkipped: { probe_unavailable: 2 },
        providers: { claude: 1 }
      }
    ],
    totals: fleetTotals()
  };
}

function hookSummary(): HookDenialSummary {
  return {
    logFile: "/repo/hooks/hooks.log",
    sinceDays: 7,
    cutoff: "2026-11-03T00:00:00.000Z",
    totalLines: 12,
    userPromptSubmits: 3,
    preToolUseDenials: 2,
    byPolicy: { "no-secrets": 2 },
    byRole: { worker: 2 },
    byReason: [{ reason: "no secrets", count: 2 }],
    topCommands: [
      { commandHead: "cat .env", policy: "no-secrets", count: 2 }
    ]
  };
}

function hookDenials(): SessionHookDenialsResponse {
  return { schema: SESSION_HOOK_DENIALS_SCHEMA, summary: hookSummary() };
}

test("tool failures are categorized by the first rule that matches", () => {
  assert.equal(
    classifyToolFailure("Command blocked by PreToolUse hook: denied"),
    "pretooluse-hook"
  );
  assert.equal(
    classifyToolFailure("Delegation is unavailable in this session"),
    "delegation-unavailable"
  );
  assert.equal(
    classifyToolFailure("collab spawn failed: agent thread limit reached"),
    "spawn-limit"
  );
  assert.equal(
    classifyToolFailure("apply_patch verification failed"),
    "apply-patch"
  );
  assert.equal(
    classifyToolFailure("Transport closed"),
    "transport-closed"
  );
  assert.equal(classifyToolFailure("aborted by user"), "aborted");
  assert.equal(classifyToolFailure("something else entirely"), "other");
});

test("a JSON-wrapped syntax error is its own category, not a plain syntax error", () => {
  const detail = "SyntaxError: Unexpected token ':'";
  assert.equal(classifyToolFailure(detail), "syntax-error");
  assert.equal(
    classifyToolFailure(detail, '{"path":"README.md"}'),
    "json-wrap-syntax"
  );
});

test("every category name is a known category", () => {
  assert.ok(TOOL_FAILURE_CATEGORIES.includes("pretooluse-hook"));
  assert.ok(TOOL_FAILURE_CATEGORIES.includes("json-wrap-syntax"));
  assert.equal(isToolFailureCategory("pretooluse-hook"), true);
  assert.equal(isToolFailureCategory("not-a-category"), false);
  assert.equal(isToolFailureCategory(""), false);
});

test("the diagnostics report validator accepts a report and rejects a broken one", () => {
  assert.equal(isSessionDiagnosticsReport(report()), true);
  assert.equal(isSessionDiagnosticsReport(null), false);
  assert.equal(isSessionDiagnosticsReport("not an object"), false);

  const wrongSchema = { ...report(), schema: "autodev-session-diagnostics-v2" };
  assert.equal(isSessionDiagnosticsReport(wrongSchema), false);

  const brokenAggregate = {
    ...report(),
    aggregates: { ...aggregates(), totalTokens: "many" }
  };
  assert.equal(isSessionDiagnosticsReport(brokenAggregate), false);

  const brokenThread = {
    ...report(),
    threads: [{ ...report().threads[0], investigation: { observed: "yes" } }]
  };
  assert.equal(isSessionDiagnosticsReport(brokenThread), false);

  const brokenInvestigation = {
    ...report(),
    threads: [
      {
        ...report().threads[0],
        investigation: { ...report().threads[0]!.investigation, tokens: null }
      }
    ]
  };
  assert.equal(
    isSessionDiagnosticsReport(brokenInvestigation),
    true,
    "an unobserved token count is null, not a missing measurement"
  );
});

test("the other diagnostics validators fail closed on a malformed payload", () => {
  assert.equal(isSessionRecentListResponse(recentList()), true);
  assert.equal(isSessionRecentListResponse({ ...recentList(), limit: "10" }), false);
  assert.equal(isSessionRecentListResponse({ ...recentList(), sessions: {} }), false);

  assert.equal(isSessionFleetScanResponse(fleetScan()), true);
  assert.equal(
    isSessionFleetScanResponse({ ...fleetScan(), totals: { ...fleetTotals(), cacheHitPct: "50" } }),
    false
  );

  assert.equal(isSessionHookDenialsResponse(hookDenials()), true);
  assert.equal(
    isSessionHookDenialsResponse({
      ...hookDenials(),
      summary: { ...hookSummary(), preToolUseDenials: "two" }
    }),
    false
  );
});

test("the text report names the session, its threads and its failures", () => {
  const text = renderSessionDiagnosticsReport(report(), {
    failures: true,
    efficiency: false,
    items: false,
    events: false
  });
  assert.match(text, /thread 01a0ba16-d54c-78f2-9367-3f80e9a8f75f/u);
  assert.match(text, /role=worker/u);
  assert.match(text, /TOOL FAILED/u);
  assert.match(text, /PreToolUse hook/u);
  assert.match(text, /autodev\/worker/u);
});

test("a report that matched no rollout says so instead of rendering nothing", () => {
  const text = renderSessionDiagnosticsReport({
    ...report(),
    found: false,
    threads: [],
    router: []
  });
  assert.match(text, /No rollout found/u);
});

test("the recent-sessions text lists the session and its thread count", () => {
  const text = renderRecentSessions(recentList());
  assert.match(text, /01a0ba14-d54c-78f2-9367-3f80e9a8f75f/u);
  assert.match(text, /threads=2/u);
});

test("the fleet scan text carries the totals and the per-session row", () => {
  const text = renderFleetScanReport(fleetScan());
  assert.match(text, /fleet scan \(1 sessions, 2 threads\)/u);
  assert.match(text, /tokens=/u);
  assert.match(text, /pretooluse-hook/u);
});

test("the hook denial text separates an empty window from a populated one", () => {
  const empty = renderHookDenialsReport({
    ...hookSummary(),
    preToolUseDenials: 0
  });
  assert.match(empty, /no structured PreToolUse denial entries/u);

  const populated = renderHookDenialsReport(hookSummary());
  assert.match(populated, /preToolUseDenials=2/u);
  assert.match(populated, /cat \.env/u);
});
