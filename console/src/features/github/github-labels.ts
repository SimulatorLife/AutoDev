/**
 * GitHub's vocabulary of run outcomes, in the Console's words.
 *
 * A workflow run arrives with a `status` and a `conclusion`, and both are
 * GitHub's own codes: `success`, `failure`, `timed_out`, `in_progress`,
 * `cancelled`, `skipped`, `neutral`, `stale`, `action_required`. The Console
 * used to print the code itself on the badge -- `success`, `failure`,
 * `in_progress`, `cancelled` -- so the one place an operator reads whether a
 * pipeline was green was the one place the storage shape leaked through.
 *
 * The words are the page's own. The outcome facet narrows a list to
 * "Succeeded", "Failed", "Cancelled" and "In progress", so the badges in the
 * rows have to say the same four things: an operator who selects a filter and
 * then reads the rows it kept must not have to translate between two
 * vocabularies.
 *
 * The tone says what the outcome is. A run that succeeded is ready, a run
 * that failed is an error, and a run that is still going is pending. Every
 * other conclusion -- cancelled, skipped, neutral, stale, action required --
 * is a run that did not produce a pass or a fail, which is the same fact as a
 * cancelled playtest episode and wears the same warning tone. None of them
 * is "not observed": GitHub reported the conclusion, and a badge that said
 * otherwise would be claiming the Console did not hear back when it did.
 */

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  statusBadgeLabel,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

/** What the Console shows for a run's outcome. */
export interface GithubRunOutcome {
  /** The word on the badge. */
  readonly label: string;
  /** The tone the badge is painted with. */
  readonly variant: StatusBadgeVariant;
}

/**
 * Every conclusion and status GitHub reports, and the Console's reading of it.
 *
 * Keyed by the code, so a code GitHub adds is simply absent from the table
 * rather than half-present in it: an absent code is spoken from its own key
 * and painted as a gap, which is honest, where a half-present one would be a
 * claim.
 */
const GITHUB_RUN_OUTCOME: Readonly<Record<string, GithubRunOutcome>> = {
  success: { label: "Succeeded", variant: "ready" },
  failure: { label: "Failed", variant: "error" },
  timed_out: { label: "Timed out", variant: "error" },
  cancelled: { label: "Cancelled", variant: "unavailable" },
  skipped: { label: "Skipped", variant: "unavailable" },
  neutral: { label: "Neutral", variant: "unavailable" },
  stale: { label: "Stale", variant: "unavailable" },
  action_required: { label: "Action required", variant: "unavailable" },
  in_progress: { label: "In progress", variant: "pending" },
  queued: { label: "Queued", variant: "pending" },
  waiting: { label: "Waiting", variant: "pending" },
  requested: { label: "Requested", variant: "pending" },
  pending: { label: "Pending", variant: "pending" },
  completed: { label: "Completed", variant: "configured" }
};

/**
 * What the Console says about a run's outcome.
 *
 * A run that has reported a conclusion is described by that conclusion; a run
 * that has only a status is described by the status, because a run that is
 * still going has no conclusion yet. A run with neither has reported
 * nothing, which is the Console's one word for it.
 */
export function githubRunOutcome(
  conclusion: string | null | undefined,
  status: string | null | undefined
): GithubRunOutcome {
  const code = conclusion ?? status ?? null;
  if (code === null) {
    return { label: NOT_OBSERVED_LABEL, variant: NOT_OBSERVED_STATUS };
  }
  const known = GITHUB_RUN_OUTCOME[code];
  if (known !== undefined) return known;
  // A conclusion the Console has no word for is spoken from its own key --
  // "action_required" reads "Action required" -- and is painted as a gap
  // rather than as a result. The Console cannot claim a pass or a fail for a
  // state it has not been taught, and it cannot claim it did not hear either.
  return { label: statusBadgeLabel(code), variant: "unavailable" };
}
