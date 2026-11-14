import type {
  GithubActionsRunStats,
  GithubWorkflowRun
} from "@simulatorlife/autodev-core";

/**
 * Compute run statistics precisely scoped to the returned/time-filtered set.
 * Success rate is successful conclusions divided by completed sampled runs;
 * non-success or missing conclusions remain in the denominator.
 * Returns non-null stats only over actual observed runs; callers must NOT
 * synthesize 0/healthy when runtime data is absent or unavailable.
 */
export function computeRunStats(
  runs: readonly GithubWorkflowRun[]
): GithubActionsRunStats {
  const totalRuns = runs.length;
  let completedRuns = 0;
  let successfulRuns = 0;
  let failedRuns = 0;
  let inProgressRuns = 0;
  let cancelledRuns = 0;

  for (const run of runs) {
    const isProgress =
      run.status === "in_progress" ||
      run.status === "queued" ||
      run.status === "waiting" ||
      run.status === "requested" ||
      run.status === "pending";

    if (isProgress) {
      inProgressRuns++;
    }

    if (run.status !== "completed") continue;
    completedRuns++;

    if (run.conclusion === "success") {
      successfulRuns++;
    } else if (
      run.conclusion === "failure" ||
      run.conclusion === "timed_out" ||
      run.conclusion === "action_required" ||
      run.conclusion === "startup_failure"
    ) {
      failedRuns++;
    } else if (run.conclusion === "cancelled") {
      cancelledRuns++;
    }
  }

  const successRate =
    completedRuns > 0
      ? Math.round((successfulRuns / completedRuns) * 1000) / 1000
      : null;

  return {
    totalRuns,
    successfulRuns,
    failedRuns,
    inProgressRuns,
    cancelledRuns,
    successRate
  };
}
