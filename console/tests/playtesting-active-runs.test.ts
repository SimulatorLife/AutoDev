import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  assignmentCounts,
  createPollLoop,
  INITIAL_POLL_INTERVAL_MS,
  freshnessForFailure,
  freshnessForSuccess,
  isTerminal,
  isWatching,
  MAX_POLL_INTERVAL_MS,
  nextPollDelayMs,
  type PlaytestingActiveRun,
  readActiveRuns
} from "../src/features/playtesting/playtesting-active-runs.ts";
import { PlaytestingActiveRunsPanel } from "../src/features/playtesting/PlaytestingActiveRunsPanel.ts";
import { responseMessage } from "../src/features/playtesting/playtesting-run-messages.ts";

const WORKSPACE = "acme/game";

function record(
  status: string,
  batchId = "batch-1"
): PlaytestingActiveRun["record"] {
  return {
    batchId,
    status,
    cancellationReason: null,
    result: null,
    error: null
  } as unknown as PlaytestingActiveRun["record"];
}

function envelope(runs: readonly PlaytestingActiveRun[]): unknown {
  return {
    kind: "ok",
    data: {
      schema: "autodev-control-playtesting-runs-v1",
      workspaceId: WORKSPACE,
      runs: runs.map((run) => ({
        batchId: run.batchId,
        assignmentCount: run.assignmentCount,
        createdAt: run.createdAt,
        status: run.record
      }))
    }
  };
}

function run(batchId: string, status: string): PlaytestingActiveRun {
  return {
    batchId,
    assignmentCount: 1,
    createdAt: "2026-10-12T00:00:00.000Z",
    record: record(status, batchId)
  };
}

test("a well-formed workspace-scoped response parses into owner-read runs", () => {
  const parsed = readActiveRuns(
    envelope([run("batch-1", "running"), run("batch-2", "persisting")]),
    WORKSPACE
  );
  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0]?.record.status, "running");
  assert.equal(parsed?.[1]?.batchId, "batch-2");
});

test("a live read fails closed rather than showing a partial view", () => {
  // A well-formed response proves the reader accepts; these prove it rejects.
  assert.ok(readActiveRuns(envelope([run("b", "running")]), WORKSPACE));
  const cases: readonly [string, unknown][] = [
    [
      "wrong workspace",
      {
        kind: "ok",
        data: {
          schema: "autodev-control-playtesting-runs-v1",
          workspaceId: "other/game",
          runs: []
        }
      }
    ],
    [
      "wrong schema",
      {
        kind: "ok",
        data: { schema: "something-else", workspaceId: WORKSPACE, runs: [] }
      }
    ],
    ["error envelope", { kind: "error", code: "x", message: "nope" }],
    [
      "runs not an array",
      {
        kind: "ok",
        data: {
          schema: "autodev-control-playtesting-runs-v1",
          workspaceId: WORKSPACE,
          runs: {}
        }
      }
    ],
    [
      "status missing its own batch id",
      envelope([
        { ...run("batch-1", "running"), record: record("running", "other") }
      ])
    ],
    [
      "entry not an object",
      {
        kind: "ok",
        data: {
          schema: "autodev-control-playtesting-runs-v1",
          workspaceId: WORKSPACE,
          runs: ["nope"]
        }
      }
    ]
  ];
  for (const [label, value] of cases) {
    assert.equal(readActiveRuns(value, WORKSPACE), null, label);
  }
  // One good entry next to one malformed entry must reject the whole read,
  // rather than showing the good one as if it were the whole workspace.
  assert.equal(
    readActiveRuns(
      {
        kind: "ok",
        data: {
          schema: "autodev-control-playtesting-runs-v1",
          workspaceId: WORKSPACE,
          runs: [
            ...(
              envelope([run("batch-1", "running")]) as {
                data: { runs: unknown[] };
              }
            ).data.runs,
            "malformed"
          ]
        }
      },
      WORKSPACE
    ),
    null
  );
});

test("truncated is terminal and distinct from a real completed result", () => {
  // The Console once rejected `truncated` while Runtime emitted it, so a
  // truncated batch surfaced as an invalid response instead of its own state.
  const parsed = readActiveRuns(
    envelope([run("batch-t", "truncated")]),
    WORKSPACE
  );
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.record.status, "truncated");
  assert.ok(isTerminal(record("truncated")));
  assert.ok(isTerminal(record("completed")));
  assert.ok(isTerminal(record("failed")));
  assert.ok(isTerminal(record("cancelled")));
  assert.equal(isTerminal(record("running")), false);
  assert.equal(isTerminal(record("persisting")), false);
});

test("polling continues only while a batch is genuinely nonterminal", () => {
  assert.equal(isWatching([]), false);
  assert.equal(isWatching([run("a", "running")]), true);
  assert.equal(isWatching([run("a", "persisting")]), true);
  assert.equal(isWatching([run("a", "completed"), run("b", "failed")]), false);
  // A mixed list keeps polling because one batch is still live.
  assert.equal(isWatching([run("a", "completed"), run("b", "running")]), true);
});

test("a failed read is unavailable, never the previous frame's live", () => {
  assert.equal(freshnessForSuccess([run("a", "running")]), "live");
  assert.equal(freshnessForSuccess([run("a", "completed")]), "idle");
  assert.equal(freshnessForFailure(), "unavailable");
  // The ordering matters: reading state first and failing second must not
  // leave a stale `live` on screen.
  assert.notEqual(
    freshnessForFailure(),
    freshnessForSuccess([run("a", "running")])
  );
});

test("polling backs off on repeated failure and stays capped", () => {
  assert.equal(nextPollDelayMs(0), 1_500);
  assert.equal(nextPollDelayMs(1), 3_000);
  assert.equal(nextPollDelayMs(2), 6_000);
  assert.ok(nextPollDelayMs(3) > nextPollDelayMs(2));
  for (const failures of [0, 1, 5, 20, 1_000, Number.MAX_SAFE_INTEGER]) {
    assert.ok(nextPollDelayMs(failures) <= MAX_POLL_INTERVAL_MS);
    assert.ok(nextPollDelayMs(failures) >= 1_500);
  }
  assert.equal(nextPollDelayMs(1_000), MAX_POLL_INTERVAL_MS);
});

test("counts come from the owner's result, never recomputed", () => {
  // The owner's own `PlaytestCompletionCounts` fields, not names invented here.
  // An earlier version of this fixture used `succeeded`/`failed`, which no
  // producer emits, so it passed while every panel tile rendered "not observed".
  const withCounts = {
    ...record("running"),
    result: { counts: { started: 3, completed: 2, crashed: 1 } }
  };
  assert.deepEqual(assignmentCounts(withCounts), {
    started: 3,
    completed: 2,
    crashed: 1
  });
  assert.equal(assignmentCounts(record("running")), null);
  assert.equal(
    assignmentCounts({ ...record("running"), result: { counts: null } }),
    null
  );
});

test("an unreadable response reports the server's message or an honest default", () => {
  assert.equal(
    responseMessage({
      kind: "error",
      code: "x",
      message: "Runtime is offline."
    }),
    "Runtime is offline."
  );
  assert.equal(responseMessage({ error: { message: "Nested." } }), "Nested.");
  assert.equal(
    responseMessage("<html>502</html>"),
    "The Console could not validate the server response."
  );
  assert.equal(
    responseMessage(undefined),
    "The Console could not validate the server response."
  );
});
test("the panel never presents an unread read as current", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlaytestingActiveRunsPanel } =
    await import("../src/features/playtesting/PlaytestingActiveRunsPanel.ts");
  const run = {
    batchId: "batch-live-1",
    assignmentCount: 4,
    createdAt: "2026-10-12T00:00:00.000Z",
    record: record("running", "batch-live-1")
  };
  const live = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      workspaceId: WORKSPACE,
      runs: [run],
      freshness: "live",
      lastFailure: null,
      watching: true,
      onRefresh: () => {},
      // Progress is behind the row disclosure, so the focused batch is the
      // one whose counts an operator is actually reading.
      focusedBatchId: "batch-1",
      onFocusBatch: () => {},
      onCancel: null,
      busyBatchId: null
    })
  );
  assert.match(live, /data-freshness="live"/);
  assert.doesNotMatch(live, /not confirmed current state/i);
  assert.match(live, /data-status="running"/);
  // Polite progress must not steal focus.
  assert.match(live, /aria-live="polite"/);
  assert.doesNotMatch(live, /autofocus/i);

  const unavailable = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      workspaceId: WORKSPACE,
      runs: [run],
      freshness: "unavailable",
      lastFailure: "Runtime is offline.",
      watching: false,
      onRefresh: () => {},
      // Progress is behind the row disclosure, so the focused batch is the
      // one whose counts an operator is actually reading.
      focusedBatchId: "batch-1",
      onFocusBatch: () => {},
      onCancel: null,
      busyBatchId: null
    })
  );
  assert.match(unavailable, /data-freshness="unavailable"/);
  // The last known frame stays visible, but is labelled as not current.
  assert.match(unavailable, /not confirmed current state/i);
  assert.match(unavailable, /Runtime is offline\./);
  // The row must not badge its last-known state as if it were current.
  assert.doesNotMatch(unavailable, />Running</);
  assert.match(unavailable, /Last known: Running/);
  assert.match(unavailable, /data-stale="true"/);
});

test("a terminal batch offers no cancel action and is marked terminal", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PlaytestingActiveRunsPanel } =
    await import("../src/features/playtesting/PlaytestingActiveRunsPanel.ts");
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      workspaceId: WORKSPACE,
      runs: [
        {
          batchId: "batch-done",
          assignmentCount: 1,
          createdAt: "2026-10-12T00:00:00.000Z",
          record: record("completed", "batch-done")
        }
      ],
      freshness: "idle",
      lastFailure: null,
      watching: false,
      onRefresh: () => {},
      focusedBatchId: "batch-done",
      onFocusBatch: () => {},
      onCancel: () => {},
      busyBatchId: null
    })
  );
  assert.match(markup, /data-terminal="true"/);
  assert.doesNotMatch(markup, /Cancel batch/);
  // An unreported count is named as absent evidence, not a fabricated zero,
  // and uses the Console's single spelling for that.
  assert.match(markup, /Not observed/);
  assert.doesNotMatch(markup, />Not reported</);
});

test("the panel renders the owner's own counts rather than an absent reading", () => {
  // The tiles are the only place an operator sees assignment outcomes, so a
  // tile pointed at a key the Runtime never writes renders "not observed"
  // forever while the batch runs. Rendering the owner's real keys is the
  // assertion that catches it.
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      workspaceId: "fixture/game",
      runs: [
        {
          batchId: "batch-1",
          assignmentCount: 4,
          createdAt: "2026-10-13T12:00:00.000Z",
          record: {
            ...record("running"),
            result: {
              counts: {
                assigned: 4,
                started: 4,
                completed: 2,
                crashed: 1,
                infrastructureFailed: 1,
                cancelled: 0,
                budgetTruncated: 1,
                reviewed: 0,
                eligible: 2
              }
            }
          }
        }
      ],
      freshness: "live",
      lastFailure: null,
      watching: true,
      onRefresh: () => {},
      // Progress is behind the row disclosure, so the focused batch is the
      // one whose counts an operator is actually reading.
      focusedBatchId: "batch-1",
      onFocusBatch: () => {},
      onCancel: () => {},
      busyBatchId: null
    })
  );
  assert.match(markup, /Assignments completed/);
  assert.match(markup, />2</u);
  assert.match(markup, /Assignments crashed/);
  // An unobserved count stays named as unobserved rather than becoming a zero.
  assert.ok(
    !/Assignments succeeded|Assignments quota-blocked|Episodes persisted/u.test(
      markup
    ),
    "no tile may name a field the Runtime does not produce"
  );
});

test("every count tile names a field the synthetic fixture actually emits", () => {
  // The browser suite is the acceptance evidence for this panel, and it runs
  // against the synthetic Control API fixture. A tile pointed at a field the
  // fixture never emits would render "not observed" in the very run meant to
  // prove the tiles work — so the two key sets are compared here, where it
  // fails fast without a browser.
  const fixture = readFileSync(
    new URL("../e2e/playtesting-control-api-fixture.ts", import.meta.url),
    "utf8"
  );
  const panel = readFileSync(
    new URL(
      "../src/features/playtesting/PlaytestingActiveRunsPanel.ts",
      import.meta.url
    ),
    "utf8"
  );
  const emitted = new Set(
    [
      ...(
        fixture.match(/const runCounts = \{([\s\S]*?)\n  \};/u)?.[1] ?? ""
      ).matchAll(/^\s*(\w+):/gmu)
    ].map((match) => match[1]!)
  );
  const read = [...panel.matchAll(/countLabel\(counts, "(\w+)"\)/gu)].map(
    (match) => match[1]!
  );
  assert.ok(read.length > 0, "the panel must read at least one count");
  assert.deepEqual(
    read.filter((key) => !emitted.has(key)),
    [],
    "every tile must read a field the fixture emits"
  );
});

/**
 * The scheduling rule behind the live view.
 *
 * These drive `createPollLoop` directly because the hook's effect cannot run
 * under `renderToStaticMarkup`, and because the defect they guard is precisely
 * one that only shows up across repeated polls: arming the timer once per
 * effect run instead of once per completed poll.
 */

/** Let the loop's pending promise chain settle without advancing fake time. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

test("the poll loop keeps re-arming while its subject stays nonterminal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let polls = 0;
    const loop = createPollLoop({
      poll: async () => {
        polls += 1;
      },
      shouldContinue: () => true,
      delayFor: () => INITIAL_POLL_INTERVAL_MS
    });
    loop.start();
    await settle();
    assert.equal(polls, 1, "the first read is immediate, not after a delay");

    // The defect: a loop that arms once per effect run stops here, leaving the
    // view showing a live badge over numbers that can no longer move.
    t.mock.timers.tick(INITIAL_POLL_INTERVAL_MS);
    await settle();
    assert.equal(polls, 2, "a completed poll re-arms the next one");

    t.mock.timers.tick(INITIAL_POLL_INTERVAL_MS);
    await settle();
    assert.equal(polls, 3, "and keeps re-arming for as long as it is watching");

    t.mock.timers.tick(INITIAL_POLL_INTERVAL_MS * 10);
    await settle();
    assert.equal(polls, 4, "one poll per arm, not a burst per tick");
  } finally {
    t.mock.timers.reset();
  }
});

test("the poll loop stops as soon as the subject reaches a terminal state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let polls = 0;
    let nonterminal = true;
    const loop = createPollLoop({
      poll: async () => {
        polls += 1;
        // The batch completes during this poll; `watching` flips afterwards.
        nonterminal = false;
      },
      shouldContinue: () => nonterminal,
      delayFor: () => INITIAL_POLL_INTERVAL_MS
    });
    loop.start();
    await settle();
    assert.equal(polls, 1);

    // `shouldContinue` is read after the poll, not captured before it, so a
    // batch that finished during this read is not polled again.
    t.mock.timers.tick(INITIAL_POLL_INTERVAL_MS * 5);
    await settle();
    assert.equal(polls, 1, "a terminal subject is not polled again");
  } finally {
    t.mock.timers.reset();
  }
});

test("stopping the poll loop cancels the pending read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let polls = 0;
    const loop = createPollLoop({
      poll: async () => {
        polls += 1;
      },
      shouldContinue: () => true,
      delayFor: () => INITIAL_POLL_INTERVAL_MS
    });
    loop.start();
    await settle();
    assert.equal(polls, 1);

    loop.stop();
    t.mock.timers.tick(INITIAL_POLL_INTERVAL_MS * 20);
    await settle();
    assert.equal(polls, 1, "an unmounted view stops issuing reads");
  } finally {
    t.mock.timers.reset();
  }
});

test("the loop applies the caller's backoff for each arm", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const requestedDelays: number[] = [];
    const loop = createPollLoop({
      poll: async () => {},
      shouldContinue: () => true,
      delayFor: () => {
        const delay = nextPollDelayMs(requestedDelays.length);
        requestedDelays.push(delay);
        return delay;
      }
    });
    loop.start();
    await settle();
    t.mock.timers.tick(MAX_POLL_INTERVAL_MS);
    await settle();
    t.mock.timers.tick(MAX_POLL_INTERVAL_MS);
    await settle();
    assert.deepEqual(
      requestedDelays,
      [
        INITIAL_POLL_INTERVAL_MS,
        INITIAL_POLL_INTERVAL_MS * 2,
        INITIAL_POLL_INTERVAL_MS * 4
      ],
      "each arm asks for its own delay, so backoff advances per read rather " +
        "than being computed once and reused"
    );
  } finally {
    t.mock.timers.reset();
  }
});
