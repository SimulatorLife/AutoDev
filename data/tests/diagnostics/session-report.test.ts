import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ACP_PIN_LEDGER_SCHEMA,
  isSessionDiagnosticsReport
} from "@simulatorlife/autodev-core";

import { buildSessionDiagnosticsReport } from "../../src/diagnostics/session-report.ts";
import { CHILD, fixture, rolloutLine, ROOT } from "./fixture.ts";

async function report(
  home: string,
  routerLog: string,
  overrides: Partial<{
    id: string;
    offline: boolean;
    includeEfficiency: boolean;
    includeEvents: boolean;
    eventsLimit: number;
    eventsOffset: number;
    includeItems: boolean;
    itemsLimit: number;
    itemsOffset: number;
    threadId: string;
  }> = {}
) {
  return buildSessionDiagnosticsReport({
    id: ROOT,
    codexHome: home,
    routerLog,
    offline: true,
    includeEfficiency: false,
    includeEvents: false,
    eventsLimit: 50,
    eventsOffset: 0,
    includeItems: false,
    itemsLimit: 50,
    itemsOffset: 0,
    ...overrides
  });
}

test("a session's report names the session, its threads and its router state", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog);
    assert.equal(result.schema, "autodev-session-diagnostics-v1");
    assert.equal(result.found, true);
    assert.equal(result.rootSessionId, ROOT);
    assert.equal(result.matchedByThreadId, false);
    assert.equal(result.threads.length, 2);
    assert.equal(result.router.length, 2);
    assert.equal(isSessionDiagnosticsReport(result), true);
  } finally {
    cleanup();
  }
});

test("an id that names a child thread says it matched by thread id", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog, { id: CHILD });
    assert.equal(result.found, true);
    assert.equal(result.rootSessionId, ROOT);
    assert.equal(result.matchedByThreadId, true);
  } finally {
    cleanup();
  }
});

test("an id that matches no rollout is not found, and says so", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog, {
      id: "01a0b6ff-0000-7000-8000-000000000009"
    });
    assert.equal(result.found, false);
    assert.equal(result.threads.length, 0);
    assert.equal(result.aggregates.threadCount, 0);
  } finally {
    cleanup();
  }
});

test("the router events are a bounded page with an exact total", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const all = await report(home, routerLog, {
      includeEvents: true,
      eventsLimit: 1
    });
    assert.equal(all.eventsPage.limit, 1);
    assert.equal(all.eventsPage.items.length, 1);
    assert.ok(all.eventsPage.total >= 2);
    assert.equal(all.eventsPage.hasMore, all.eventsPage.total > 1);

    const second = await report(home, routerLog, {
      includeEvents: true,
      eventsLimit: 1,
      eventsOffset: 1
    });
    assert.equal(second.eventsPage.offset, 1);
    assert.notDeepEqual(
      second.eventsPage.items.map((item) => item.at),
      all.eventsPage.items.map((item) => item.at)
    );
  } finally {
    cleanup();
  }
});

test("the events are empty when they were not asked for", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog);
    assert.deepEqual(result.eventsPage.items, []);
    assert.equal(result.eventsPage.total, 0);
    assert.equal(result.eventsPage.hasMore, false);
  } finally {
    cleanup();
  }
});

test("the rollout items are a bounded page that names the thread they came from", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog, {
      includeItems: true,
      itemsLimit: 2
    });
    assert.ok(result.itemsPage.total > 0);
    assert.equal(result.itemsPage.items.length, 2);
    assert.ok(result.itemsPage.items.every((item) => item.threadId.length > 0));
  } finally {
    cleanup();
  }
});

test("the items of one thread are the items of that thread", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog, {
      includeItems: true,
      itemsLimit: 100,
      threadId: CHILD
    });
    assert.ok(result.itemsPage.total > 0);
    assert.ok(result.itemsPage.items.every((item) => item.threadId === CHILD));
  } finally {
    cleanup();
  }
});

test("the aggregates roll the threads up into the session's numbers", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog);
    const aggregates = result.aggregates;
    assert.equal(aggregates.threadCount, 2);
    assert.equal(aggregates.turnsTotal, 2);
    assert.equal(aggregates.toolFailuresTotal, 1);
    assert.equal(aggregates.toolFailuresByCategory["transport-closed"], 1);
    assert.equal(aggregates.routerRequests, 2);
    assert.equal(aggregates.routerFailures, 1);
  } finally {
    cleanup();
  }
});

test("the efficiency summary is present only when it was asked for", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const without = await report(home, routerLog);
    assert.equal(without.efficiency, null);
    const withEfficiency = await report(home, routerLog, {
      includeEfficiency: true
    });
    assert.ok(withEfficiency.efficiency);
    assert.ok(Array.isArray(withEfficiency.efficiency.disabledProviders));
  } finally {
    cleanup();
  }
});

test("an offline report does not read live state", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog, { offline: true });
    assert.equal(result.live, null);
  } finally {
    cleanup();
  }
});

test("the session aggregates sum each thread's skill reads and keep its prompt maxima", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const rollout = (id: string, lines: string[]): void => {
      writeFileSync(
        path.join(dir, `rollout-2026-09-18T17-00-00-${id}.jsonl`),
        [
          rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
            id,
            session_id: ROOT,
            ...(id === CHILD && { parent_thread_id: ROOT }),
            cwd: "/tmp/repo"
          }),
          ...lines
        ].join("\n")
      );
    };
    const developer = (text: string): string =>
      rolloutLine("2026-09-18T21:20:01.000Z", "response_item", {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }]
      });
    const read = (callId: string, input: string): string =>
      rolloutLine("2026-09-18T21:20:02.000Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        call_id: callId,
        input
      });
    rollout(ROOT, [
      developer("root prompt 😀"),
      read("r1", "cat /x/skills/kiss/SKILL.md")
    ]);
    rollout(CHILD, [
      developer("child"),
      read("c1", "cat /x/skills/kiss/SKILL.md"),
      read("c2", "cat /x/skills/kiss/SKILL.md /x/skills/dry/SKILL.md")
    ]);

    const result = await report(home, routerLog, { includeEfficiency: true });
    assert.equal(isSessionDiagnosticsReport(result), true);
    const byId = new Map(result.threads.map((thread) => [thread.id, thread]));
    assert.deepEqual(byId.get(ROOT)?.efficiency?.prompt.skillReadCounts, {
      kiss: 1
    });
    assert.deepEqual(byId.get(CHILD)?.efficiency?.prompt.skillReadCounts, {
      dry: 1,
      kiss: 2
    });
    assert.deepEqual(result.aggregates.skillReadCounts, { dry: 1, kiss: 3 });
    assert.equal(result.aggregates.uniqueSkillsRead, 2);
    assert.equal(result.aggregates.maxInitialDeveloperChars, 13);
    assert.equal(result.aggregates.maxInitialDeveloperBytes, 16);
    assert.equal(result.aggregates.maxInitialDeveloperTokens, null);
  } finally {
    cleanup();
  }
});

test("session report exposes the root thread clientSurface without fabricating child surfaces", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const result = await report(home, routerLog);
    assert.equal(isSessionDiagnosticsReport(result), true);
    assert.equal(result.clientSurface, "codex_desktop");
    const byId = new Map(result.threads.map((thread) => [thread.id, thread]));
    assert.equal(byId.get(ROOT)?.clientSurface, "codex_desktop");
    assert.equal(byId.get(CHILD)?.clientSurface, null);
    const missing = await buildSessionDiagnosticsReport({
      id: "01a0b699-0000-7000-8000-000000000999",
      codexHome: home,
      routerLog,
      includeEfficiency: false,
      includeEvents: false,
      includeItems: false,
      eventsLimit: 10,
      eventsOffset: 0,
      itemsLimit: 10,
      itemsOffset: 0,
      offline: true
    });
    assert.equal(missing.found, false);
    assert.equal(missing.clientSurface, null);
  } finally {
    cleanup();
  }
});

test("ACP pin ledger attributes threads without router events, discovers child ACP rollouts via coordinator link, and refuses symlinks", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    // Remove router log events by pointing to a non-existent router log so
    // attribution comes strictly from the ACP pin ledger.
    const emptyRouterLog = path.join(home, "run", "missing-router.err.log");
    const runDir = path.join(home, "run");
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);

    const acpChildThreadId = "01a0b677-0000-7000-8000-000000000099";
    const childDay = path.join(home, "sessions", "2026", "11", "27");
    mkdirSync(childDay, { recursive: true });
    writeFileSync(
      path.join(
        childDay,
        `rollout-2026-11-27T10-00-00-${acpChildThreadId}.jsonl`
      ),
      `${rolloutLine("2026-11-27T10:00:00.000Z", "session_meta", {
        id: acpChildThreadId,
        session_id: acpChildThreadId,
        parent_thread_id: null,
        role: "worker",
        model: "autodev/worker",
        cwd: "/repo"
      })}\n`
    );

    const pinsPath = path.join(runDir, "acp-pins.json");
    writeFileSync(
      pinsPath,
      JSON.stringify({
        schema: ACP_PIN_LEDGER_SCHEMA,
        pid: process.pid,
        updatedAt: "2026-11-27T10:00:05.000Z",
        pins: [
          {
            sessionId: "child-worker-abc",
            parentSessionId: `local:orchestrator:repo:${ROOT}`,
            acpSessionId: acpChildThreadId,
            role: "worker",
            provider: "claude",
            model: "claude-sonnet-4-5",
            reasoningEffort: "high",
            transport: "acp",
            cwd: "/repo",
            createdAt: "2026-11-27T10:00:00.000Z",
            updatedAt: "2026-11-27T10:00:05.000Z",
            closedAt: null
          }
        ]
      }),
      { mode: 0o600 }
    );
    chmodSync(pinsPath, 0o600);

    const rootReport = await report(home, emptyRouterLog, { id: ROOT });
    assert.equal(isSessionDiagnosticsReport(rootReport), true);
    assert.equal(rootReport.acpPins?.length, 1);
    const acpChildRouter = rootReport.router.find(
      (entry) => entry.thread === acpChildThreadId
    );
    assert.ok(acpChildRouter);
    assert.equal(acpChildRouter.matchedBy, "acp-pin");
    assert.deepEqual(acpChildRouter.providerSequence, ["claude"]);
    assert.deepEqual(acpChildRouter.modelSequence, ["claude-sonnet-4-5"]);

    // Unpinned root thread with no router events keeps providerSequence empty.
    const rootRouter = rootReport.router.find((entry) => entry.thread === ROOT);
    assert.ok(rootRouter);
    assert.deepEqual(rootRouter.providerSequence, []);

    // Lookup by child ACP pin id also resolves the session cleanly.
    const pinLookup = await report(home, emptyRouterLog, {
      id: "child-worker-abc"
    });
    assert.equal(pinLookup.found, true);
    assert.equal(pinLookup.rootSessionId, ROOT);
    assert.ok(
      pinLookup.threads.some((thread) => thread.id === acpChildThreadId)
    );

    // Pre-ACP router events stay intact even if an unlinked router log is used.
    const withRouterLogs = await report(home, routerLog, { id: ROOT });
    assert.equal(
      withRouterLogs.router.find((entry) => entry.thread === ROOT)?.matchedBy,
      "thread"
    );

    // Symlinked pin ledger must be ignored cleanly.
    const realPins = path.join(home, "outside.json");
    writeFileSync(realPins, "{}");
    const symlinkPins = path.join(runDir, "acp-pins.json");
    writeFileSync(symlinkPins, "{}");
    await import("node:fs/promises").then(({ unlink }) => unlink(symlinkPins));
    symlinkSync(realPins, symlinkPins);
    const symlinkedReport = await report(home, emptyRouterLog, { id: ROOT });
    assert.equal(symlinkedReport.acpPins, undefined);
  } finally {
    cleanup();
  }
});
