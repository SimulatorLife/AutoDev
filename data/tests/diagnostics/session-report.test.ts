import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isSessionDiagnosticsReport } from "@simulatorlife/autodev-core";

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
            ...((id === CHILD) && { parent_thread_id: ROOT }),
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
