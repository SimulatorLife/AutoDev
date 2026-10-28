import assert from "node:assert/strict";
import { test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activeRunOwnsEpisode,
  assignmentCounts,
  assignmentOutcomes,
  cancellationAvailability,
  createPollLoop,
  departedRuns,
  freshnessForFailure,
  freshnessForSuccess,
  INITIAL_POLL_INTERVAL_MS,
  isTerminal,
  isWatching,
  MAX_POLL_INTERVAL_MS,
  mergeRunsRead,
  nextPollDelayMs,
  type PlaytestingActiveRun,
  readActiveRuns,
  readRunStatus,
  trackStartedRun
} from "../src/features/playtesting/playtesting-active-runs.ts";
import { responseMessage } from "../src/features/playtesting/playtesting-run-messages.ts";
import { parsePlaytestingScope } from "../src/features/playtesting/playtesting-url.ts";
import { PlaytestingActiveRunsPanel } from "../src/features/playtesting/PlaytestingActiveRunsPanel.ts";
import { PlaytestingAssignmentResults } from "../src/features/playtesting/PlaytestingAssignmentResults.ts";

const WORKSPACE = "acme/game";
const WORKSPACE_SCOPE = parsePlaytestingScope({
  view: "sessions",
  workspaceId: WORKSPACE
});

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
      schema: "autodev-control-playtesting-runs-v2",
      workspaceId: WORKSPACE,
      runs: runs.map((entry) => ({
        batchId: entry.batchId,
        assignmentCount: entry.assignmentCount,
        createdAt: entry.createdAt,
        sessions: entry.sessions,
        status: entry.record
      }))
    }
  };
}

function run(batchId: string, status: string): PlaytestingActiveRun {
  return {
    batchId,
    assignmentCount: 1,
    createdAt: "2026-10-12T00:00:00.000Z",
    sessions: [{ assignmentId: "a-1", episodeId: batchId + ".a-1" }],
    record: record(status, batchId)
  };
}

test("activeRunOwnsEpisode checks exact frozen session references, never a derived ID", () => {
  const adapterRun = run("batch-abc", "running");
  const visualRun: PlaytestingActiveRun = {
    batchId: "batch-vis-1",
    assignmentCount: 1,
    createdAt: "2026-10-12T00:00:00.000Z",
    sessions: [
      { assignmentId: "vis-assign-1", episodeId: "ep-vis-1-vis-assign-1" }
    ],
    record: record("persisting", "batch-vis-1")
  };
  const terminalRun = run("batch-finished", "completed");

  assert.equal(activeRunOwnsEpisode(adapterRun, "batch-abc.a-1"), true);
  assert.equal(activeRunOwnsEpisode(visualRun, "ep-vis-1-vis-assign-1"), true);
  // An episode ID that merely shares the batch prefix but is not in the
  // frozen session list must not be treated as owned by heuristic matching.
  assert.equal(activeRunOwnsEpisode(visualRun, "ep-vis-1-other-assign"), false);
  assert.equal(activeRunOwnsEpisode(adapterRun, "another-batch.a-1"), false);
  assert.equal(activeRunOwnsEpisode(terminalRun, "batch-finished.a-1"), false);
  assert.equal(
    activeRunOwnsEpisode(
      {
        ...adapterRun,
        record: {
          ...adapterRun.record,
          result: {
            outcomes: [{ assignmentId: "a-1", episodeId: "recovered-episode" }]
          }
        }
      },
      "recovered-episode"
    ),
    true
  );
});

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
      "duplicate assignment session references",
      envelope([
        {
          ...run("batch-1", "running"),
          assignmentCount: 2,
          sessions: [
            { assignmentId: "a-1", episodeId: "batch-1.a-1" },
            { assignmentId: "a-1", episodeId: "batch-1.a-2" }
          ]
        }
      ])
    ],
    [
      "episode identity not derived from the frozen assignment",
      envelope([
        {
          ...run("batch-1", "running"),
          sessions: [{ assignmentId: "a-1", episodeId: "unrelated-session" }]
        }
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

test("cancellation stays available when capability state is unknown and explains known role restrictions", () => {
  assert.deepEqual(cancellationAvailability(null), {
    allowed: true,
    reason: null
  });
  assert.deepEqual(cancellationAvailability(true), {
    allowed: true,
    reason: null
  });
  assert.deepEqual(cancellationAvailability(false), {
    allowed: false,
    reason: "Only an authorized operator can cancel this run."
  });
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
  assert.equal(nextPollDelayMs(0), 1500);
  assert.equal(nextPollDelayMs(1), 3000);
  assert.equal(nextPollDelayMs(2), 6000);
  assert.ok(nextPollDelayMs(3) > nextPollDelayMs(2));
  for (const failures of [0, 1, 5, 20, 1000, Number.MAX_SAFE_INTEGER]) {
    assert.ok(nextPollDelayMs(failures) <= MAX_POLL_INTERVAL_MS);
    assert.ok(nextPollDelayMs(failures) >= 1500);
  }
  assert.equal(nextPollDelayMs(1000), MAX_POLL_INTERVAL_MS);
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

test("assignment execution and game outcomes are read separately and all-or-nothing", () => {
  const outcomes = [
    {
      assignmentId: "assignment-1",
      episodeId: "episode-win",
      state: "completed",
      started: true,
      eligible: true,
      gameOutcome: "win"
    },
    {
      assignmentId: "assignment-2",
      episodeId: null,
      state: "infrastructure-failed",
      started: false,
      eligible: false,
      gameOutcome: null
    }
  ] as const;
  assert.deepEqual(
    assignmentOutcomes({
      ...record("completed"),
      result: { outcomes }
    }),
    outcomes
  );
  assert.equal(
    assignmentOutcomes({
      ...record("completed"),
      result: {
        outcomes: [
          outcomes[0],
          { ...outcomes[1], assignmentId: outcomes[0].assignmentId }
        ]
      }
    }),
    null,
    "duplicate assignment results invalidate the complete list"
  );
  assert.equal(
    assignmentOutcomes({
      ...record("completed"),
      result: {
        outcomes: [
          {
            assignmentId: outcomes[0].assignmentId,
            episodeId: outcomes[0].episodeId,
            state: outcomes[0].state,
            started: outcomes[0].started,
            eligible: outcomes[0].eligible
          }
        ]
      }
    }),
    null,
    "a row without the owner-classified game outcome is not shown as complete"
  );
  assert.equal(
    assignmentOutcomes({
      ...record("completed"),
      result: {
        outcomes: [{ ...outcomes[1], state: "completed" }]
      }
    }),
    null,
    "a no-episode assignment cannot claim a completed execution"
  );
});

test("an explicit unknown game result is not confused with an unobserved outcome", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingAssignmentResults, {
      scope: WORKSPACE_SCOPE,
      pending: false,
      live: false,
      sessions: [],
      outcomes: [
        {
          assignmentId: "assignment-unknown",
          episodeId: "episode-unknown",
          state: "completed",
          started: true,
          eligible: true,
          gameOutcome: "unknown"
        },
        {
          assignmentId: "assignment-infrastructure-failed",
          episodeId: null,
          state: "infrastructure-failed",
          started: false,
          eligible: false,
          gameOutcome: null
        }
      ]
    })
  );
  assert.match(markup, /data-game-outcome="unknown"/u);
  assert.match(markup, /Game outcome: Not observed/u);
  assert.match(markup, /data-execution-state="infrastructure-failed"/u);
  assert.match(markup, /data-game-outcome="not-observed"/u);
  assert.match(markup, /Game outcome: Not observed/u);
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
test("a live assignment exposes its exact Watch link before an outcome is recorded", () => {
  const live = run("batch-live-link", "running");
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: WORKSPACE_SCOPE,
      runs: [live],
      freshness: "live",
      lastFailure: null,
      watching: true,
      onRefresh: () => {},
      focusedBatchId: live.batchId,
      onFocusBatch: () => {},
      onCancel: null,
      busyBatchId: null
    })
  );
  assert.match(markup, /data-testid="playtesting-live-session-links"/u);
  assert.match(markup, /data-assignment-id="a-1"/u);
  assert.match(markup, /Watch session/u);
  assert.match(
    markup,
    /href="\/playtesting\/sessions\/batch-live-link\.a-1\?[^"]*workspaceId=acme%2Fgame/u
  );
  assert.match(markup, /Watch sessions \(1\)/u);
  assert.doesNotMatch(markup, /data-game-outcome=/u);
});

test("the panel never presents an unread read as current", () => {
  const liveRun = {
    batchId: "batch-live-1",
    assignmentCount: 4,
    createdAt: "2026-10-12T00:00:00.000Z",
    sessions: Array.from({ length: 4 }, (_, index) => ({
      assignmentId: `a-${String(index + 1).padStart(4, "0")}`,
      episodeId: `batch-live-1.a-${String(index + 1).padStart(4, "0")}`
    })),
    record: record("running", "batch-live-1")
  };
  const live = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: WORKSPACE_SCOPE,
      runs: [liveRun],
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
      scope: WORKSPACE_SCOPE,
      runs: [liveRun],
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

test("a terminal batch offers no cancel action and is marked terminal", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: WORKSPACE_SCOPE,
      runs: [
        {
          batchId: "batch-done",
          assignmentCount: 1,
          createdAt: "2026-10-12T00:00:00.000Z",
          sessions: [{ assignmentId: "a-1", episodeId: "batch-done.a-1" }],
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

test("a known viewer restriction explains why cancellation is unavailable", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: WORKSPACE_SCOPE,
      runs: [run("batch-viewer", "running")],
      freshness: "live",
      lastFailure: null,
      watching: true,
      onRefresh: () => {},
      focusedBatchId: "batch-viewer",
      onFocusBatch: () => {},
      onCancel: null,
      cancelUnavailableReason:
        "Only an authorized operator can cancel this run.",
      busyBatchId: null
    })
  );
  assert.match(
    markup,
    /Cancellation unavailable: Only an authorized operator can cancel this run/u
  );
  assert.doesNotMatch(markup, /Cancel batch/u);
});

test("the panel renders the owner's own counts rather than an absent reading", () => {
  // The tiles are the only place an operator sees assignment outcomes, so a
  // tile pointed at a key the Runtime never writes renders "not observed"
  // forever while the batch runs. Rendering the owner's real keys is the
  // assertion that catches it.
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: parsePlaytestingScope({
        view: "sessions",
        workspaceId: "fixture/game"
      }),
      runs: [
        {
          batchId: "batch-1",
          assignmentCount: 4,
          createdAt: "2026-10-13T12:00:00.000Z",
          sessions: Array.from({ length: 4 }, (_, index) => ({
            assignmentId: `assignment-${String(index + 1).padStart(3, "0")}`,
            episodeId: `batch-1.assignment-${String(index + 1).padStart(3, "0")}`
          })),
          record: {
            ...record("running"),
            result: {
              outcomes: [
                {
                  assignmentId: "assignment-001",
                  episodeId: "episode-001",
                  state: "completed",
                  started: true,
                  eligible: true,
                  gameOutcome: "win"
                },
                {
                  assignmentId: "assignment-002",
                  episodeId: null,
                  state: "infrastructure-failed",
                  started: false,
                  eligible: false,
                  gameOutcome: null
                }
              ],
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
  assert.match(markup, /Assignment counts/);
  assert.match(markup, /<dt[^>]*>Completed<\/dt><dd[^>]*>2<\/dd>/u);
  assert.match(markup, />2</u);
  assert.match(markup, /<dt[^>]*>Crashed<\/dt><dd[^>]*>1<\/dd>/u);
  // An unobserved count stays named as unobserved rather than becoming a zero.
  assert.ok(
    !/Assignments succeeded|Assignments quota-blocked|Episodes persisted/u.test(
      markup
    ),
    "no tile may name a field the Runtime does not produce"
  );
  // The state reads in the Console's word, beside a game outcome that reads
  // in the Console's word too. The wire's own key -- "completed" -- beside
  // "Win" read as two different kinds of answer rather than two spellings of
  // the same one.
  assert.match(markup, /Execution state: Completed/);
  assert.doesNotMatch(markup, /Execution state: completed/);
  assert.match(markup, /Game outcome: Win/);
  assert.match(
    markup,
    /href="\/playtesting\/sessions\/episode-001\?view=sessions&amp;workspaceId=fixture%2Fgame&amp;liveBatch=batch-1"/u
  );
  assert.match(markup, /No persisted session\./);
  assert.match(markup, /data-execution-state="infrastructure-failed"/);
  assert.match(markup, /data-game-outcome="not-observed"/);
});

test("assignment count details use the Runtime result only when it is present", () => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaytestingActiveRunsPanel, {
      scope: WORKSPACE_SCOPE,
      runs: [run("batch-no-result", "running")],
      freshness: "live",
      lastFailure: null,
      watching: true,
      onRefresh: () => {},
      focusedBatchId: "batch-no-result",
      onFocusBatch: () => {},
      onCancel: null,
      busyBatchId: null
    })
  );
  assert.doesNotMatch(markup, /Assignment counts/u);
  assert.match(markup, /Runtime accepted 1 assignment/u);
  assert.match(
    markup,
    /Individual results are recorded when execution finishes/u
  );
  assert.doesNotMatch(markup, /0 of 1 assignments have a terminal result/u);
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

function tracked(batchId: string, status: string): PlaytestingActiveRun {
  return {
    batchId,
    assignmentCount: 1,
    createdAt: "2026-10-15T00:00:00.000Z",
    sessions: [{ assignmentId: "a-1", episodeId: `${batchId}.a-1` }],
    record: record(status, batchId)
  };
}

test("a start acknowledgement seeds a batch before a fast completion can disappear from the active list", () => {
  const prior = tracked("batch-existing", "running");
  const started = tracked("batch-fast", "running");
  const seeded = trackStartedRun([prior], started);
  assert.deepEqual(
    seeded.map((entry) => entry.batchId),
    ["batch-existing", "batch-fast"]
  );

  // The first active-list read observes that the new batch already completed.
  // It is still in the tracked set, so the hook resolves its terminal status.
  const departed = departedRuns(seeded, [prior]);
  assert.deepEqual(
    departed.map((entry) => entry.batchId),
    ["batch-fast"]
  );
  const completed = tracked("batch-fast", "completed");
  const merged = mergeRunsRead(seeded, [prior], [completed]);
  assert.deepEqual(
    merged.map((entry) => [entry.batchId, entry.record.status]),
    [
      ["batch-existing", "running"],
      ["batch-fast", "completed"]
    ]
  );
});

test("a watched batch that leaves the active list is resolved to its terminal status, not dropped", () => {
  const running = tracked("batch-1", "running");
  const otherRunning = tracked("batch-2", "running");
  // The Runtime lists only nonterminal batches, so batch-1 finishing removes it.
  const next = [otherRunning];
  assert.deepEqual(
    departedRuns([running, otherRunning], next).map((entry) => entry.batchId),
    ["batch-1"]
  );
  const completed = tracked("batch-1", "completed");
  const merged = mergeRunsRead([running, otherRunning], next, [completed]);
  assert.deepEqual(
    merged.map((entry) => [entry.batchId, entry.record.status]),
    [
      ["batch-2", "running"],
      ["batch-1", "completed"]
    ]
  );
  // Once terminal it is retained on later reads and never re-resolved;
  // only the still-running batch would be read again if it departed.
  assert.deepEqual(
    departedRuns(merged, []).map((entry) => entry.batchId),
    ["batch-2"]
  );
  assert.deepEqual(
    mergeRunsRead(merged, [otherRunning], []).map((entry) => entry.batchId),
    ["batch-2", "batch-1"]
  );
});

test("run-status reads are bound to the exact workspace and batch", () => {
  const statusEnvelope = {
    kind: "ok",
    data: {
      schema: "autodev-control-playtesting-run-status-v1",
      workspaceId: WORKSPACE,
      run: record("completed")
    }
  };
  assert.equal(
    readRunStatus(statusEnvelope, WORKSPACE, "batch-1")?.status,
    "completed"
  );
  assert.equal(readRunStatus(statusEnvelope, "other/game", "batch-1"), null);
  assert.equal(readRunStatus(statusEnvelope, WORKSPACE, "batch-2"), null);
  assert.equal(readRunStatus({ kind: "error" }, WORKSPACE, "batch-1"), null);
});
