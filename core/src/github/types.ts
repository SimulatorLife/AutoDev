/**
 * Canonical AutoDev GitHub Actions workflow domain contracts.
 *
 * These types describe workflow *definitions* as declared in `.github/workflows/*.yml`
 * source files (name, path, trigger events, cron schedules) along with authoritative
 * GitHub Actions runtime state and recent run statistics read via the GitHub
 * Actions API. Dispatch, cancel, rerun, and schedule mutation controls remain
 * explicitly unimplemented; this module defines read-only contracts only.
 */

export type GithubWorkflowCatalogStatus = "valid" | "invalid" | "unavailable";

export type GithubActionsRuntimeStatus =
  "available" | "unavailable" | "invalid";

export type GithubWorkflowState =
  | "active"
  | "disabled_manually"
  | "disabled_inactivity"
  | "deleted"
  | "unknown";

export type GithubRunStatus =
  "completed" | "in_progress" | "queued" | "requested" | "waiting" | "pending";

export type GithubRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "skipped"
  | null;

/** A single parsed AutoDev GitHub Actions workflow definition with optional observed runtime state. */
export interface GithubWorkflowDefinition {
  /** Stable identifier: the workflow file name, e.g. "_scheduler.yml". */
  readonly id: string;
  /** Declared `name:` field; null when the workflow has no explicit name. */
  readonly name: string | null;
  /** Repository-relative path, e.g. ".github/workflows/_scheduler.yml". */
  readonly path: string;
  /** Sorted, de-duplicated trigger event keys observed under `on:` (for example "push", "workflow_dispatch", "schedule"). */
  readonly events: readonly string[];
  /** Sorted, de-duplicated cron expressions observed under `on.schedule`. Empty when the workflow has no schedule trigger. */
  readonly schedules: readonly string[];
  /** Observed GitHub Actions workflow state; "unavailable" when runtime facts could not be loaded. */
  readonly actionsState?: GithubWorkflowState | "unavailable" | "unknown";
  /** Observed numeric GitHub Actions workflow id, or null if unobserved. */
  readonly actionsWorkflowId?: number | null;
  /** GitHub web URL for this workflow, or null if unobserved. */
  readonly actionsHtmlUrl?: string | null;
  /** Number of recent runs observed for this workflow in the bounded sample. */
  readonly recentRunsCount?: number | null;
  /** Most recent run status observed for this workflow. */
  readonly lastRunStatus?: string | null;
  /** Most recent run conclusion observed for this workflow. */
  readonly lastRunConclusion?: string | null;
  /** ISO timestamp of the most recent run for this workflow. */
  readonly lastRunCreatedAt?: string | null;
  /** GitHub web URL for the most recent run for this workflow. */
  readonly lastRunHtmlUrl?: string | null;
}

/** A single observed GitHub Actions workflow run from the bounded recent sample. */
export interface GithubWorkflowRun {
  readonly id: number;
  readonly name: string | null;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly headBranch: string | null;
  readonly headSha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runAttempt: number;
}

/**
 * Aggregated statistics computed strictly over the returned bounded/time-filtered
 * recent run sample. Null when runtime facts are absent or unavailable.
 */
export interface GithubActionsRunStats {
  readonly totalRuns: number;
  readonly successfulRuns: number;
  readonly failedRuns: number;
  readonly inProgressRuns: number;
  readonly cancelledRuns: number;
  readonly successRate: number | null;
}
