import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterRuns,
  githubListHref,
  readGithubFilters,
  runOutcome
} from "../src/features/github/github-list-url.ts";
import { GithubView } from "../src/features/github/GithubView.ts";

/**
 * The recent-runs table can be narrowed by outcome.
 *
 * Thirty observed runs in the live instance, over two and a half screenfuls,
 * and the page raises the question it cannot answer: the success-rate card
 * reads "N succeeded, N failed, N running" but counts them without showing
 * which, so finding the twelve failures among the thirteen cancellations
 * meant reading the status cell of every row.
 *
 * The categories are the page's own -- the target state's counters over the
 * sampled runs -- and they are the same predicates the Status column renders
 * its badge from, so the count on the card and the rows on the page are the
 * same numbers.
 */

function run(
  id: number,
  conclusion: string | null,
  status = "completed"
): {
  id: number;
  name: string | null;
  workflowId: number;
  workflowPath: string;
  headBranch: string | null;
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runAttempt: number;
} {
  return {
    id,
    name: `run ${id}`,
    workflowId: 1,
    workflowPath: ".github/workflows/ci.yml",
    headBranch: "main",
    headSha: "abcdef1234567890",
    event: "push",
    status,
    conclusion,
    htmlUrl: `https://example.com/runs/${id}`,
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:01:00Z",
    runAttempt: 1
  };
}

const RUNS = [
  run(1, "success"),
  run(2, "failure"),
  run(3, "cancelled"),
  run(4, null, "in_progress"),
  run(5, "skipped")
];

function renderGithub(
  outcome?: string,
  runs: readonly (typeof RUNS)[number][] = RUNS
): string {
  return renderToStaticMarkup(
    React.createElement(GithubView, {
      workflows: [],
      runtimeFactsAvailable: true,
      runtimeStatus: "available",
      repository: "SimulatorLife/AutoDev",
      stats: {
        totalRuns: 5,
        successfulRuns: 1,
        failedRuns: 1,
        inProgressRuns: 1,
        cancelledRuns: 1,
        successRate: 0.5
      },
      recentRuns: runs,
      ...(outcome === undefined ? {} : { outcome: outcome as never })
    })
  );
}

test("a run's outcome is the same predicate the Status badge renders from", () => {
  assert.equal(runOutcome(RUNS[0]!), "succeeded");
  assert.equal(runOutcome(RUNS[1]!), "failed");
  assert.equal(runOutcome(RUNS[2]!), "cancelled");
  assert.equal(runOutcome(RUNS[3]!), "in-progress");
  // A run that timed out is a failure, which is what the badge says too.
  assert.equal(runOutcome(run(6, "timed_out")), "failed");
  // A queued or waiting run is still in progress.
  assert.equal(runOutcome(run(7, null, "queued")), "in-progress");
  assert.equal(runOutcome(run(8, null, "waiting")), "in-progress");
});

test("an outcome keeps the runs of that outcome", () => {
  const failed = filterRuns(RUNS, { outcome: "failed" });
  assert.deepEqual(
    failed.map((entry) => entry.id),
    [2]
  );
  assert.equal(filterRuns(RUNS, { outcome: "succeeded" }).length, 1);
  assert.equal(filterRuns(RUNS, { outcome: "cancelled" }).length, 1);
  assert.equal(filterRuns(RUNS, { outcome: "in-progress" }).length, 1);
  assert.equal(filterRuns(RUNS, { outcome: "all" }).length, 5);
});

test("a run the page does not count stays visible only under All outcomes", () => {
  // A skipped conclusion is in the sample's total and in nobody's counter, so
  // it is not in any of the four categories -- and it is not silently dropped
  // by a filter that says "Failed" either.
  assert.equal(
    filterRuns(RUNS, { outcome: "failed" }).some((entry) => entry.id === 5),
    false
  );
  assert.equal(
    filterRuns(RUNS, { outcome: "all" }).some((entry) => entry.id === 5),
    true
  );
});

test("the page's address carries the outcome, and reads it back", () => {
  assert.equal(githubListHref({ outcome: "all" }), "/github");
  assert.equal(
    githubListHref({ outcome: "failed" }),
    "/github?outcome=failed"
  );

  assert.deepEqual(readGithubFilters({ outcome: "failed" }), {
    outcome: "failed"
  });
  assert.deepEqual(readGithubFilters({}), { outcome: "all" });
  // An outcome the page does not have is answered with the whole list rather
  // than with an empty one.
  assert.deepEqual(readGithubFilters({ outcome: "nonsense" }), {
    outcome: "all"
  });
  assert.deepEqual(readGithubFilters({ outcome: ["failed", "all"] }), {
    outcome: "failed"
  });
});

test("the runs table narrows by links, and the page stays read-only", () => {
  const markup = renderGithub();

  // The facet is a row of links, because the GitHub page carries no form and
  // no button at all: dispatch, cancel, rerun and schedule controls are
  // unimplemented, and the Console must not expose them as browser-side
  // affordances. A link narrows without being one.
  assert.doesNotMatch(markup, /<form/u);
  assert.doesNotMatch(markup, /<button/u);
  assert.match(markup, /data-run-outcome="failed"/u);
  assert.match(markup, /data-run-outcome="cancelled"/u);

  // The vocabulary is the page's own: the counters the target state names.
  assert.match(markup, /All outcomes/u);
  assert.match(markup, /Succeeded/u);
  assert.match(markup, /Failed/u);
  assert.match(markup, /Cancelled/u);
  assert.match(markup, /In progress/u);
});

test("the selected chip says so, and not only by its colour", () => {
  const markup = renderGithub("failed");

  // The selection is otherwise distinguishable only by its background, which
  // is no way to read a selection aloud.
  assert.match(markup, /aria-current="true"/u);
  const selected = /<a\b(?=[^>]*data-run-outcome="failed")[^>]*>/u.exec(markup)?.[0];
  assert.ok(selected, "the failed chip is rendered");
  assert.match(selected, /aria-current="true"/u);
});

test("the success-rate card names every counter it covers", () => {
  const markup = renderGithub();

  // The card names the sample's size and then three of its four counters, so
  // the numbers did not add up to the total: thirteen of thirty runs were
  // cancelled and nothing on the page said so.
  assert.match(
    markup,
    /1 succeeded, 1 failed, 1 running, 1 cancelled/u
  );
});

test("a narrowed list says how much of the sample is in view", () => {
  const markup = renderGithub("failed");

  assert.match(markup, /Showing 1 of 5 runs/u);
  // And the narrowed sample is what the table holds.
  assert.match(markup, /#2 run 2/u);
  assert.doesNotMatch(markup, /#1 run 1/u);

  // The stat cards above are about the sample, not about the view of it: the
  // success rate and the run counts describe every run the Actions API
  // returned, and they must not shrink because the table was narrowed.
  assert.match(markup, /1 succeeded, 1 failed, 1 running/u);
});

test("an empty narrowed list says the outcome excluded everything", () => {
  // Two runs, neither of them cancelled.
  const markup = renderGithub("cancelled", [
    run(1, "success"),
    run(2, "failure")
  ]);

  assert.match(markup, /Showing 0 of 2 runs/u);
  // Not "no runs were observed": two were.
  assert.match(markup, /No cancelled runs were observed in this sample\./u);
  assert.doesNotMatch(markup, /No recent workflow runs observed\./u);
});
