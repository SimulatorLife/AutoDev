import type { GithubWorkflowRun } from "@simulatorlife/autodev-core";

/**
 * The one owner of the GitHub page's list state.
 *
 * The recent-runs table is the largest list on the page: thirty observed runs
 * in the live instance, over two and a half screenfuls, and the page raises
 * the question it cannot answer. The stat card reads "N succeeded, N failed,
 * N running" -- but it counts them without showing which, so finding the
 * twelve failures among the thirteen cancellations meant reading the status
 * cell of every row.
 *
 * So the runs are narrowed by outcome, on the vocabulary the page's own
 * statistics already use: the target state names four counters over the
 * sampled runs -- successful, failed, in progress and cancelled -- and the
 * filter uses the same four, so the count on the card and the rows on the
 * page are the same numbers.
 *
 * The control is a single choice, and it applies on selection rather than on
 * an Apply, because the target state says a safe single-choice setting
 * applies without a second Apply control. That also keeps the page free of a
 * submit button, and the narrowing is a normal GET navigation, so the
 * narrowed list is a URL state like every other filtered view.
 */

/** The route the GitHub page lives at. */
export const GITHUB_LIST_PATH = "/github";

/**
 * The outcome a run can be narrowed to.
 *
 * `all` is every observed run. The other four are the counters the target
 * state computes over the sampled runs.
 */
export type RunOutcomeFilter =
  "all" | "succeeded" | "failed" | "cancelled" | "in-progress";

export const RUN_OUTCOME_FILTERS: readonly RunOutcomeFilter[] = [
  "all",
  "succeeded",
  "failed",
  "cancelled",
  "in-progress"
];

/**
 * How each outcome reads in the filter.
 *
 * The words are the page's own: the success-rate card says "succeeded",
 * "failed" and "running", and the counts it reports are named
 * `successfulRuns`, `failedRuns`, `inProgressRuns` and `cancelledRuns`.
 */
export const RUN_OUTCOME_LABELS: Readonly<Record<RunOutcomeFilter, string>> = {
  all: "All outcomes",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  "in-progress": "In progress"
};

/** Everything the page's list state can carry. */
export interface GithubListFilters {
  readonly outcome: RunOutcomeFilter;
}

const EMPTY_FILTERS: GithubListFilters = { outcome: "all" };

/**
 * The value of a query parameter.
 *
 * A repeated parameter takes its first value, which is what the browser's own
 * form submission produces and what the other list surfaces read.
 */
function firstValue(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return value[0] ?? "";
}

/**
 * The filters an address asks for.
 *
 * An outcome the page does not have is reported rather than quietly answered
 * with everything: the same rule the tool catalogue applies to a source it
 * cannot honour.
 */
export function readGithubFilters(
  params: Readonly<Record<string, string | readonly string[] | undefined>>
): GithubListFilters {
  const requested = firstValue(params.outcome).trim();
  const outcome = RUN_OUTCOME_FILTERS.find((value) => value === requested);
  return outcome === undefined ? EMPTY_FILTERS : { outcome };
}

/** The list's query string, without the route. */
export function githubListQuery(filters: GithubListFilters): string {
  if (filters.outcome === "all") return "";
  const params = new URLSearchParams();
  params.set("outcome", filters.outcome);
  return params.toString();
}

/**
 * The address of the list.
 *
 * An unfiltered list is written without a query at all rather than with an
 * empty one: a bare `?outcome=` is a different address from no address, and
 * the list should have one address.
 */
export function githubListHref(filters: GithubListFilters): string {
  const query = githubListQuery(filters);
  return query ? `${GITHUB_LIST_PATH}?${query}` : GITHUB_LIST_PATH;
}

/**
 * Whether a run's outcome is one this page counts.
 *
 * The same predicates the Status column renders its badge from, so the
 * filter's categories and the badges on the rows are the same thing. A
 * conclusion the page does not count -- a skipped or neutral run -- is
 * outside all four, and so it stays visible only under "All outcomes": it
 * is in the sample's total, and it is in nobody's counter.
 */
export function runOutcome(run: GithubWorkflowRun): RunOutcomeFilter {
  if (run.conclusion === "success") return "succeeded";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return "failed";
  }
  if (run.conclusion === "cancelled") return "cancelled";
  if (
    run.status === "in_progress" ||
    run.status === "queued" ||
    run.status === "waiting"
  ) {
    return "in-progress";
  }
  return "all";
}

/**
 * The runs a set of filters keeps.
 */
export function filterRuns(
  runs: readonly GithubWorkflowRun[],
  filters: GithubListFilters
): readonly GithubWorkflowRun[] {
  if (filters.outcome === "all") return runs;
  return runs.filter((run) => runOutcome(run) === filters.outcome);
}

/**
 * How many runs each outcome holds.
 *
 * The counts are over the whole sample, not over the narrowed list, so the
 * count for the outcome the operator is looking at stays true when another
 * outcome is selected.
 */
export function countRunOutcomes(
  runs: readonly GithubWorkflowRun[]
): Record<RunOutcomeFilter, number> {
  const counts: Record<RunOutcomeFilter, number> = {
    all: runs.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    "in-progress": 0
  };
  for (const run of runs) {
    const outcome = runOutcome(run);
    if (outcome !== "all") counts[outcome] += 1;
  }
  return counts;
}
