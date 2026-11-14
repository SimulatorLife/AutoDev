import assert from "node:assert/strict";
import test from "node:test";

import type { GithubWorkflowRun } from "@simulatorlife/autodev-core";

import { computeRunStats } from "../../src/github/github-run-stats.ts";

function runForStats(
  id: number,
  status: string,
  conclusion: string | null
): GithubWorkflowRun {
  return {
    id,
    name: null,
    workflowId: 10,
    workflowPath: ".github/workflows/ci.yml",
    headBranch: null,
    headSha: "",
    event: "push",
    status,
    conclusion,
    htmlUrl: "",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:01:00Z",
    runAttempt: 1
  };
}

test("computeRunStats calculates precise statistics and never invents synthetic health", () => {
  // Empty runs list: total 0, success rate null (no concluded runs).
  const emptyStats = computeRunStats([]);
  assert.deepEqual(emptyStats, {
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    inProgressRuns: 0,
    cancelledRuns: 0,
    successRate: null
  });

  const sampleRuns = [
    {
      id: 1,
      name: "run 1",
      workflowId: 10,
      workflowPath: ".github/workflows/a.yml",
      headBranch: "main",
      headSha: "abc",
      event: "push",
      status: "completed",
      conclusion: "success",
      htmlUrl: "https://github.com/test/1",
      createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:01:00Z",
      runAttempt: 1
    },
    {
      id: 2,
      name: "run 2",
      workflowId: 10,
      workflowPath: ".github/workflows/a.yml",
      headBranch: "main",
      headSha: "def",
      event: "push",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.com/test/2",
      createdAt: "2026-10-04T00:02:00Z",
      updatedAt: "2026-10-04T00:03:00Z",
      runAttempt: 1
    },
    {
      id: 3,
      name: "run 3",
      workflowId: 11,
      workflowPath: ".github/workflows/b.yml",
      headBranch: "main",
      headSha: "ghi",
      event: "schedule",
      status: "in_progress",
      conclusion: null,
      htmlUrl: "https://github.com/test/3",
      createdAt: "2026-10-04T00:04:00Z",
      updatedAt: "2026-10-04T00:05:00Z",
      runAttempt: 1
    },
    {
      id: 4,
      name: "run 4",
      workflowId: 11,
      workflowPath: ".github/workflows/b.yml",
      headBranch: "main",
      headSha: "jkl",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "cancelled",
      htmlUrl: "https://github.com/test/4",
      createdAt: "2026-10-04T00:06:00Z",
      updatedAt: "2026-10-04T00:07:00Z",
      runAttempt: 1
    },
    {
      id: 5,
      name: "run 5",
      workflowId: 12,
      workflowPath: ".github/workflows/c.yml",
      headBranch: "main",
      headSha: "mno",
      event: "schedule",
      status: "completed",
      conclusion: "timed_out",
      htmlUrl: "https://github.com/test/5",
      createdAt: "2026-10-04T00:08:00Z",
      updatedAt: "2026-10-04T00:09:00Z",
      runAttempt: 1
    }
  ];

  const stats = computeRunStats(sampleRuns);
  assert.equal(stats.totalRuns, 5);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 2); // 1 failure + 1 timed_out
  assert.equal(stats.inProgressRuns, 1);
  assert.equal(stats.cancelledRuns, 1);
  // Concluded runs: 1 success + 2 failed + 1 cancelled = 4 concluded runs.
  // Success rate: 1 / 4 = 0.25 (25%)
  assert.equal(stats.successRate, 0.25);
});

test("computeRunStats divides successes by every sampled completed run", () => {
  const stats = computeRunStats([
    runForStats(1, "completed", "success"),
    runForStats(2, "completed", "startup_failure"),
    runForStats(3, "completed", "neutral"),
    runForStats(4, "completed", "cancelled"),
    runForStats(5, "completed", null),
    runForStats(6, "in_progress", "success")
  ]);

  assert.equal(stats.totalRuns, 6);
  assert.equal(stats.successfulRuns, 1);
  assert.equal(stats.failedRuns, 1);
  assert.equal(stats.cancelledRuns, 1);
  assert.equal(stats.inProgressRuns, 1);
  assert.equal(stats.successRate, 0.2);
  assert.equal(
    computeRunStats([runForStats(7, "in_progress", null)]).successRate,
    null
  );
});
