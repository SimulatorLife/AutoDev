import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentCounts,
  freshnessForFailure,
  freshnessForSuccess,
  isTerminal,
  isWatching,
  MAX_POLL_INTERVAL_MS,
  nextPollDelayMs,
  type PlaytestingActiveRun,
  readActiveRuns
} from "../src/features/playtesting/playtesting-active-runs.ts";
import { responseMessage } from "../src/features/playtesting/usePlaytestingActiveRuns.ts";

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

function run(
  batchId: string,
  status: string
): PlaytestingActiveRun {
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
    ["wrong workspace", { kind: "ok", data: { schema: "autodev-control-playtesting-runs-v1", workspaceId: "other/game", runs: [] } }],
    ["wrong schema", { kind: "ok", data: { schema: "something-else", workspaceId: WORKSPACE, runs: [] } }],
    ["error envelope", { kind: "error", code: "x", message: "nope" }],
    ["runs not an array", { kind: "ok", data: { schema: "autodev-control-playtesting-runs-v1", workspaceId: WORKSPACE, runs: {} } }],
    ["status missing its own batch id", envelope([{ ...run("batch-1", "running"), record: record("running", "other") }])],
    ["entry not an object", { kind: "ok", data: { schema: "autodev-control-playtesting-runs-v1", workspaceId: WORKSPACE, runs: ["nope"] } }]
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
            ...(envelope([run("batch-1", "running")]) as { data: { runs: unknown[] } }).data.runs,
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
  const parsed = readActiveRuns(envelope([run("batch-t", "truncated")]), WORKSPACE);
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
  assert.notEqual(freshnessForFailure(), freshnessForSuccess([run("a", "running")]));
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
  const withCounts = {
    ...record("running"),
    result: { counts: { succeeded: 3, failed: 1 } }
  };
  assert.deepEqual(assignmentCounts(withCounts), { succeeded: 3, failed: 1 });
  assert.equal(assignmentCounts(record("running")), null);
  assert.equal(
    assignmentCounts({ ...record("running"), result: { counts: null } }),
    null
  );
});

test("an unreadable response reports the server's message or an honest default", () => {
  assert.equal(
    responseMessage({ kind: "error", code: "x", message: "Runtime is offline." }),
    "Runtime is offline."
  );
  assert.equal(
    responseMessage({ error: { message: "Nested." } }),
    "Nested."
  );
  assert.equal(
    responseMessage("<html>502</html>"),
    "The Console could not validate the server response."
  );
  assert.equal(
    responseMessage(undefined),
    "The Console could not validate the server response."
  );
});