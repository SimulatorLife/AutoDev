/**
 * The one place where AutoDev's playtest vocabulary becomes words.
 *
 * Core and Runtime speak in stable machine codes — `budget-truncated`,
 * `usage-budget`, `smart-direct`, `URL-only`. Those codes are the
 * persisted contract and must not change. They are also not what an
 * operator wants to read at a glance, and several of them read as
 * something they are not.
 *
 * `budget-truncated` is the clearest case. The episode state says the
 * episode was cut short, but not *which* limit cut it: the approved token
 * budget and the approved step cap are different facts with different
 * causes and different consequences for the operator, and the termination
 * reason is what tells them apart. So a label that only reads the state
 * would have to be vague, and a label that guesses would be wrong.
 *
 * Every operator-facing string is derived here, from the code, once.
 */

import type {
  PlaytestEpisode,
  PlaytestExecutionProvenance,
  PlaytestGameOutcomeKind,
  PlaytestMissingReason
} from "@simulatorlife/autodev-core";

/** The badge tones the Console's status component understands. */
export type PlaytestingLabelTone =
  "valid" | "pending" | "invalid" | "unavailable";

/**
 * The termination reasons that mean "a limit cut this episode short".
 *
 * The episode state cannot name the limit; the termination reason can. A
 * reader who is told "budget truncated" and then discovers the step cap
 * was the binding limit has been told something false.
 */
const LIMIT_TERMINATION_REASONS = {
  "usage-budget": "Budget exhausted",
  "step-limit": "Step limit reached",
  "wall-time-limit": "Time limit reached"
} as const;

export type PlaytestingLimitTerminationReason =
  keyof typeof LIMIT_TERMINATION_REASONS;

/** The termination reason, when it names a limit that cut an episode short. */
export function limitTerminationReason(
  reason: string | null | undefined
): PlaytestingLimitTerminationReason | null {
  if (reason === null || reason === undefined) return null;
  return Object.hasOwn(LIMIT_TERMINATION_REASONS, reason)
    ? (reason as PlaytestingLimitTerminationReason)
    : null;
}

/**
 * The operator-facing label for an episode's execution state.
 *
 * When the episode was cut short by a limit, the label names the limit.
 */
export function executionStateLabel(
  status: PlaytestEpisode["status"],
  terminationReason?: string | null
): string {
  switch (status) {
    case "assigned":
      return "Queued";
    case "started":
      return "Running";
    case "completed":
      return "Completed";
    case "crashed":
      return "Crashed";
    case "infrastructure-failed":
      return "Failed (infrastructure)";
    case "cancelled":
      return "Cancelled";
    case "budget-truncated": {
      const limit = limitTerminationReason(terminationReason);
      return limit === null
        ? "Limit reached"
        : LIMIT_TERMINATION_REASONS[limit];
    }
  }
}

/** The tone an execution state should be shown with. */
export function executionStateTone(
  status: PlaytestEpisode["status"]
): PlaytestingLabelTone {
  switch (status) {
    case "assigned":
    case "started":
      return "pending";
    case "completed":
      return "valid";
    case "crashed":
      return "invalid";
    case "infrastructure-failed":
    case "cancelled":
    case "budget-truncated":
      return "unavailable";
  }
}

/**
 * A one-line explanation of why an episode ended where it ended.
 *
 * A truncated episode that ran out of tokens and one that hit the step cap
 * are both "budget truncated" to the state machine and are not the same
 * fact for the operator, so the reason is spelled out rather than implied.
 */
export function executionStateExplanation(
  status: PlaytestEpisode["status"],
  terminationReason?: string | null
): string | null {
  if (status !== "budget-truncated") return null;
  const limit = limitTerminationReason(terminationReason);
  if (limit === null) {
    return "The episode was cut short by an approved limit.";
  }
  switch (limit) {
    case "usage-budget":
      return "The approved per-episode usage budget ran out before the step cap was reached.";
    case "step-limit":
      return "The approved per-episode step cap was reached before the usage budget ran out.";
    case "wall-time-limit":
      return "The approved per-episode wall-time limit was reached before the episode finished.";
  }
}

/** The operator-facing label for a game's own outcome. */
export function gameOutcomeLabel(value: PlaytestGameOutcomeKind): string {
  switch (value) {
    case "win":
      return "Win";
    case "loss":
      return "Loss";
    case "dnf":
      return "Did not finish";
    case "other":
      return "Other outcome";
    case "unknown":
      return "Not observed";
  }
}

/** The operator-facing label for a reason a piece of evidence is missing. */
export function missingReasonLabel(reason: PlaytestMissingReason): string {
  switch (reason) {
    case "no-consent":
      return "No consent recorded";
    case "withdrawn":
      return "Withdrawn";
    case "missing-ENJ":
      return "No event journal recorded";
    case "missing-before-action-probe":
      return "No probe before the action";
    case "missing-feedback":
      return "No feedback recorded";
    case "missing-action-or-revision-events":
      return "No action or revision events";
    case "stochastic-outcome-without-probability-target":
      return "Stochastic outcome without a probability target";
    case "fork-unsupported":
      return "Fork not supported";
    case "partial-alternatives":
      return "Only some alternatives were run";
    case "reward-or-continuation-contract-mismatch":
      return "Reward or continuation contract mismatch";
    case "unsupported-evaluator":
      return "Evaluator not supported";
    case "unsupported-modality":
      return "Modality not supported";
    case "wrong-instrument":
      return "Wrong instrument";
    case "outside-window":
      return "Outside the measurement window";
    case "unobserved":
      return "Not observed";
    case "infrastructure-failed":
      return "Infrastructure failure";
    case "budget-truncated":
      return "A limit cut the episode short";
    case "cancelled":
      return "Cancelled";
    case "revoked":
      return "Permission revoked";
  }
}

/**
 * The build a session ran against, as far as it can be attested.
 *
 * A URL's own checkout is not an attestation for the bytes the browser
 * rendered, so a URL-driven session says so rather than implying a commit.
 * The wording is the product's: "Commit not applicable" for a URL-only
 * project, "Build unknown" when there is a source but no attestation.
 */
export function buildLabel(
  source: PlaytestExecutionProvenance["source"]
): string {
  if (source.revisionConfidence === "verified" && source.revision !== null) {
    return `Verified ${source.revision.slice(0, 12)}`;
  }
  return source.kind === "URL-only" ? "Commit not applicable" : "Build unknown";
}

/**
 * The decision backend a session used.
 *
 * The backend is the thing that chose the actions, so it is named the way
 * an operator would name it rather than by its internal id.
 */
export function policyLabel(policyId: string): string {
  switch (policyId) {
    case "smart-direct":
      return "Smart-directed";
    case "onejev-local":
      return "OneJev (local)";
    case "random":
      return "Random legal action";
    case "first-legal":
      return "First legal action";
    case "scored":
      return "Scored policy";
    default:
      return policyId;
  }
}

/** The operator-facing label for an execution mode. */
export function executionModeLabel(
  mode: PlaytestExecutionProvenance["mode"]
): string {
  switch (mode) {
    case "autonomous-visual":
      return "Autonomous visual";
    case "adapter-accelerated":
      return "Adapter-accelerated";
    case "scripted-regression":
      return "Scripted regression";
    case "legacy-unknown":
      return "Legacy mode unknown";
  }
}

/**
 * The operator-facing label for a batch's execution state.
 *
 * "truncated" on its own says that something ended the run early without
 * saying what. The batch's own episodes say which limit it was, and the
 * reader can open one; the label here says what the batch state can honestly
 * say.
 */
export function batchStateLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "truncated":
      return "Cut short by a limit";
    default:
      return status;
  }
}

/**
 * A cohort's label.
 *
 * A session with no cohort says so. Rendering "null" or leaving the field
 * out would let a reader infer a persona was assigned and validated,
 * which is exactly the claim an unassigned cohort cannot support.
 */
export function cohortLabel(cohort: string | null): string {
  if (cohort === null || cohort.trim().length === 0) {
    return "No cohort assigned";
  }
  return cohort;
}

/** The operator-facing label for a finding's severity. */
export function findingSeverityLabel(
  severity: "catastrophic" | "major" | "minor" | "informational"
): string {
  switch (severity) {
    case "catastrophic":
      return "Catastrophic";
    case "major":
      return "Major";
    case "minor":
      return "Minor";
    case "informational":
      return "Informational";
  }
}

/** The operator-facing label for a finding's lifecycle status. */
export function findingStatusLabel(
  status: "open" | "fixed" | "regressed" | "withdrawn" | "stale"
): string {
  switch (status) {
    case "open":
      return "Open";
    case "fixed":
      return "Fixed";
    case "regressed":
      return "Regressed";
    case "withdrawn":
      return "Withdrawn";
    case "stale":
      return "Stale";
  }
}

/**
 * The operator-facing label for a finding's verification stage.
 *
 * A finding that has not been validated says so. Reading "hypothesis" as
 * "a problem" is the error this label exists to prevent.
 */
export function verificationStageLabel(
  stage:
    | "not-yet-validated"
    | "fixed-on-reproduced-case"
    | "sustained-improvement"
    | "regressed-elsewhere"
    | "insufficient-evidence"
): string {
  switch (stage) {
    case "not-yet-validated":
      return "Not yet validated";
    case "fixed-on-reproduced-case":
      return "Fixed on the reproduced case";
    case "sustained-improvement":
      return "Sustained improvement";
    case "regressed-elsewhere":
      return "Regressed elsewhere";
    case "insufficient-evidence":
      return "Insufficient evidence";
  }
}

/**
 * The operator-facing label for how well a claim is supported.
 *
 * "Verified" and "corroborated" are different from "hypothesis" and
 * "not observed", and the difference is the whole point of the label.
 */
export function evidenceStatusLabel(
  status: "verified" | "corroborated" | "hypothesis" | "not observed"
): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "corroborated":
      return "Corroborated";
    case "hypothesis":
      return "Hypothesis";
    case "not observed":
      return "Not observed";
  }
}

/**
 * How a piece of evidence is labelled by kind.
 *
 * The kind is the citation's type, so the label says what the citation
 * points at rather than repeating the internal word.
 */
export function evidenceKindLabel(kind: string): string {
  switch (kind) {
    case "episode":
      return "Episode";
    case "event":
      return "Event";
    case "frame":
      return "Frame";
    case "replay-segment":
      return "Replay segment";
    case "review":
      return "Review";
    case "finding":
      return "Finding";
    case "comparison":
      return "Comparison";
    case "policy-validity":
      return "Policy validity";
    default:
      return kind;
  }
}
