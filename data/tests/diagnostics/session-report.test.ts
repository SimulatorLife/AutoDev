import assert from "node:assert/strict";
import test from "node:test";

import { isSessionDiagnosticsReport } from "@simulatorlife/autodev-core";

import { buildSessionDiagnosticsReport } from "../../src/diagnostics/session-report.ts";

import { CHILD, fixture, ROOT } from "./fixture.ts";

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
    assert.ok(
      result.itemsPage.items.every((item) => item.threadId === CHILD)
    );
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
