/**
The session-diagnostics fixtures the Control API stand-in serves.

The Console's session-scoped Usage view reads `/control/diagnostics/*`, so
the browser acceptance needs a stand-in that answers those routes with the
contract the Console validates. The shapes here are the Core contract's own
schemas: a session report, a recent-sessions listing, a fleet scan and a
hook-denial summary.
*/

/**
The session the acceptance inspects.
*/
export const DIAGNOSTICS_SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
/**
The root thread of that session.
*/
const DIAGNOSTICS_ROOT_THREAD_ID = "01a0ba15-d54c-78f2-9367-3f80e9a8f75f";
/**
A subagent thread of that session.
*/
const DIAGNOSTICS_WORKER_THREAD_ID = "01a0ba16-d54c-78f2-9367-3f80e9a8f75f";

/**
The worker's model, as the router recorded it.
*/
const WORKER_MODEL = "gemini-2.5-pro";
/**
When the session started.
*/
const SESSION_START = "2026-11-10T12:00:00.000Z";
/**
When the worker thread started.
*/
const WORKER_START = "2026-11-10T12:00:01.000Z";
/**
When the session's last write landed.
*/
const SESSION_END = "2026-11-10T12:00:18.000Z";

const ROUTER_EVENTS = [
  {
    at: WORKER_START,
    requestId: "req-1",
    thread: DIAGNOSTICS_WORKER_THREAD_ID,
    phase: "selected",
    role: "worker",
    requestedModel: WORKER_MODEL,
    provider: "antigravity",
    model: "gemini",
    outcome: null,
    status: null,
    failureClass: null,
    spawnFailureReason: null,
    denialReason: null,
    elapsedMs: null,
    toolCalls: null,
    selection: "priority"
  },
  {
    at: "2026-11-10T12:00:09.000Z",
    requestId: "req-1",
    thread: DIAGNOSTICS_WORKER_THREAD_ID,
    phase: "result",
    role: "worker",
    requestedModel: WORKER_MODEL,
    provider: "claude",
    model: "sonnet",
    outcome: "success",
    status: 200,
    failureClass: null,
    spawnFailureReason: null,
    denialReason: null,
    elapsedMs: 8400,
    toolCalls: 12,
    selection: "fallback"
  }
];

const THREAD_ITEMS = [
  {
    at: "2026-11-10T12:00:02.000Z",
    kind: "custom_tool_call",
    detail: "read_file README.md",
    threadId: DIAGNOSTICS_WORKER_THREAD_ID
  },
  {
    at: "2026-11-10T12:00:04.000Z",
    kind: "custom_tool_call_output",
    detail: "tool call failed: Command blocked by PreToolUse hook: no secrets",
    threadId: DIAGNOSTICS_WORKER_THREAD_ID
  }
];

/**
One session's diagnostics, in the shape the Console validates.
*/
export function sessionDiagnosticsReport(): Record<string, unknown> {
  return {
    schema: "autodev-session-diagnostics-v1",
    found: true,
    requestedId: DIAGNOSTICS_SESSION_ID,
    rootSessionId: DIAGNOSTICS_SESSION_ID,
    matchedByThreadId: false,
    clientSurface: "codex_desktop",
    threads: [
      {
        id: DIAGNOSTICS_ROOT_THREAD_ID,
        sessionId: DIAGNOSTICS_SESSION_ID,
        parentId: null,
        nickname: null,
        role: "orchestrator",
        model: "autodev/orchestrator",
        modelProvider: "claude",
        cliVersion: "0.169.0",
        clientSurface: "codex_desktop",
        cwd: "/repo",
        file: "/repo/rollout-root.jsonl",
        start: SESSION_START,
        end: SESSION_END,
        counts: { turns: 1 },
        turns: [
          {
            turnId: "t-root",
            started: SESSION_START,
            ended: SESSION_END,
            outcome: "completed",
            detail: null
          }
        ],
        gaps: [],
        tools: { spawn_agent: 1 },
        toolFailures: [],
        investigation: {
          observed: true,
          firstEditAt: null,
          toolCalls: 1,
          tokens: 4200,
          filesRead: 0,
          repeatedReads: 0,
          searches: 0,
          repeatedSearches: 0,
          context: { ccc: 0, cgc: 0, lsp: 0 }
        }
      },
      {
        id: DIAGNOSTICS_WORKER_THREAD_ID,
        sessionId: DIAGNOSTICS_SESSION_ID,
        parentId: DIAGNOSTICS_ROOT_THREAD_ID,
        nickname: "ImplementationCoder",
        role: "worker",
        model: WORKER_MODEL,
        modelProvider: "claude",
        cliVersion: "0.169.0",
        clientSurface: null,
        cwd: "/repo",
        file: "/repo/rollout-worker.jsonl",
        start: WORKER_START,
        end: "2026-11-10T12:00:18.000Z",
        counts: { turns: 1 },
        turns: [
          {
            turnId: "t-worker",
            started: WORKER_START,
            ended: "2026-11-10T12:00:18.000Z",
            outcome: "completed",
            detail: null
          }
        ],
        gaps: [],
        tools: { read_file: 1 },
        toolFailures: [
          {
            at: "2026-11-10T12:00:04.000Z",
            tool: "read_file",
            callId: "call-1",
            detail: "Command blocked by PreToolUse hook: no secrets",
            category: "pretooluse-hook",
            input: 'read_file {path:".env"}'
          }
        ],
        investigation: {
          observed: true,
          firstEditAt: null,
          toolCalls: 3,
          tokens: 9100,
          filesRead: 2,
          repeatedReads: 1,
          searches: 1,
          repeatedSearches: 0,
          context: { ccc: 0, cgc: 1, lsp: 0 }
        },
        efficiency: {
          tokens: {
            observed: true,
            samples: 2,
            inputTokens: 6000,
            cachedInputTokens: 2400,
            outputTokens: 1200,
            reasoningOutputTokens: 780,
            totalTokens: 7200,
            cacheHitPct: 40,
            reasoningPct: 65,
            peakInputTokens: 6000,
            cacheDrops: 0
          },
          compaction: {
            count: 0,
            contextCompactedEvents: 0,
            maxReplacementItems: 0,
            maxReplacementBytes: 0,
            maxReplacementImages: 0,
            responseImageItems: 0
          },
          prompt: {
            initialDeveloperBytes: 1200,
            initialDeveloperChars: 1188,
            initialDeveloperTokens: null,
            skillsCatalogBytes: 800,
            skillsLoaded: 2,
            skillsByRoot: { "/repo/.agents/skills": 2 },
            skillsRead: ["autodev-session-diagnostics"],
            skillReadCounts: { "autodev-session-diagnostics": 1 },
            skillTelemetryReads: 1
          }
        }
      }
    ],
    router: [
      {
        thread: DIAGNOSTICS_WORKER_THREAD_ID,
        model: WORKER_MODEL,
        matchedBy: "thread",
        requests: 1,
        byProvider: {
          antigravity: {
            requests: 1,
            failures: 0,
            elapsedMs: 8400,
            toolCalls: 0
          },
          claude: { requests: 1, failures: 0, elapsedMs: 8400, toolCalls: 12 }
        },
        failures: [],
        providerSequence: ["antigravity", "claude"],
        modelSequence: ["gemini", "sonnet"],
        skipped: [
          {
            at: WORKER_START,
            requestId: "req-1",
            provider: "antigravity",
            reason: "probe_unavailable",
            elapsedMs: 40
          }
        ],
        retries: 1
      }
    ],
    logs: [
      {
        file: "/repo/run/codex-model-router.launchd.err.log",
        modified: SESSION_END,
        bytes: 4096
      }
    ],
    bridgeAlerts: [
      {
        file: "/repo/hooks/claude-bridge.launchd.log",
        count: 1,
        samples: ["earlier message(s) left out to fit the site's limit"]
      }
    ],
    live: null,
    efficiency: {
      disabledProviders: ["antigravity"],
      nullRoleModels: []
    },
    aggregates: {
      threadCount: 2,
      totalTokens: 13_300,
      inputTokens: 10_000,
      cachedInputTokens: 4000,
      outputTokens: 2000,
      reasoningOutputTokens: 1300,
      cacheHitPct: 40,
      reasoningPct: 65,
      peakInputTokens: 6000,
      cacheDrops: 0,
      compactions: 0,
      contextCompactedEvents: 0,
      maxReplacementItems: 0,
      maxReplacementBytes: 0,
      maxReplacementImages: 0,
      responseImageItems: 0,
      maxInitialDeveloperBytes: 1200,
      maxInitialDeveloperChars: 1188,
      maxInitialDeveloperTokens: null,
      maxSkillsCatalogBytes: 800,
      maxSkillsLoaded: 2,
      skillsByRoot: { "/repo/.agents/skills": 2 },
      uniqueSkillsRead: 1,
      skillReadCounts: { "autodev-session-diagnostics": 1 },
      skillTelemetryReads: 1,
      turnsTotal: 2,
      turnsByOutcome: { completed: 2 },
      gapsCount: 0,
      toolCallsTotal: 4,
      toolCallsByName: { read_file: 1, spawn_agent: 1 },
      toolFailuresTotal: 1,
      toolFailuresByCategory: { "pretooluse-hook": 1 },
      preToolUseBlocks: 1,
      routerRequests: 1,
      routerFailures: 0,
      routerSkippedTotal: 1,
      routerSkippedByReason: { probe_unavailable: 1 },
      routerRetries: 1,
      exhaustionWaits: 0,
      transportErrors: 0,
      providerHops: 1,
      byProvider: {
        antigravity: {
          requests: 1,
          failures: 0,
          elapsedMs: 8400,
          toolCalls: 0
        },
        claude: { requests: 1, failures: 0, elapsedMs: 8400, toolCalls: 12 }
      }
    },
    eventsPage: {
      items: ROUTER_EVENTS,
      total: ROUTER_EVENTS.length,
      limit: 50,
      offset: 0,
      hasMore: false
    },
    itemsPage: {
      items: THREAD_ITEMS,
      total: THREAD_ITEMS.length,
      limit: 50,
      offset: 0,
      hasMore: false
    }
  };
}

/**
The recent-sessions listing.
*/
export function recentSessionsResponse(): Record<string, unknown> {
  return {
    schema: "autodev-session-recent-v1",
    limit: 10,
    sessions: [
      {
        id: DIAGNOSTICS_SESSION_ID,
        started: SESSION_START,
        lastWrite: SESSION_END,
        threads: 2,
        cwd: "/repo",
        clientSurface: "codex_desktop"
      },
      {
        id: "01a0ba20-d54c-78f2-9367-3f80e9a8f75f",
        started: "2026-11-09T09:00:00.000Z",
        lastWrite: "2026-11-09T09:30:00.000Z",
        threads: 1,
        cwd: "/repo",
        clientSurface: null
      }
    ]
  };
}

/**
The fleet scan.
*/
export function fleetScanResponse(): Record<string, unknown> {
  return {
    schema: "autodev-session-fleet-scan-v1",
    limit: 20,
    sessions: [
      {
        id: DIAGNOSTICS_SESSION_ID,
        started: SESSION_START,
        lastWrite: SESSION_END,
        cwd: "/repo",
        clientSurface: "codex_desktop",
        threads: 2,
        totalTokens: 13_300,
        inputTokens: 10_000,
        cachedInputTokens: 4000,
        cacheHitPct: 40,
        cacheDrops: 0,
        compactions: 0,
        maxSkillsLoaded: 2,
        toolFailures: 1,
        preToolUseBlocks: 1,
        topFailureCategory: "pretooluse-hook",
        routerRequests: 1,
        routerFailures: 0,
        routerSkipped: { probe_unavailable: 1 },
        providers: { antigravity: 1, claude: 1 }
      }
    ],
    totals: {
      sessions: 1,
      threads: 2,
      totalTokens: 13_300,
      inputTokens: 10_000,
      cachedInputTokens: 4000,
      cacheHitPct: 40,
      cacheDrops: 0,
      compactions: 0,
      toolFailuresByCategory: { "pretooluse-hook": 1 },
      preToolUseReasons: [{ reason: "no secrets", count: 1 }],
      routerSkippedByReason: [{ key: "probe_unavailable", count: 1 }]
    }
  };
}

/**
The hook-denial summary.
*/
export function hookDenialsResponse(): Record<string, unknown> {
  return {
    schema: "autodev-session-hook-denials-v1",
    summary: {
      logFile: "/repo/hooks/hooks.log",
      sinceDays: 7,
      cutoff: "2026-11-03T00:00:00.000Z",
      totalLines: 42,
      preToolUseDenials: 4,
      byPolicy: { "no-secrets": 3, "no-rm": 1 },
      byRole: { worker: 4 },
      byReason: [
        { reason: "reads a .env file", count: 3 },
        { reason: "refuses a recursive delete", count: 1 }
      ],
      topCommands: [
        { commandHead: "cat .env", policy: "no-secrets", count: 3 },
        { commandHead: "rm -rf build", policy: "no-rm", count: 1 }
      ]
    }
  };
}
