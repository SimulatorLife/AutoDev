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

import {
  PLAYTEST_REVIEW_SECTION_NOT_RECORDED,
  type PlaytestEpisode,
  type PlaytestExecutionProvenance,
  type PlaytestGameOutcomeKind,
  type PlaytestMissingReason,
  type PlaytestReviewSectionStatus
} from "@simulatorlife/autodev-core";

import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";

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

/**
 * What a label says about a value it does not recognise.
 *
 * The stored codes are closed unions, so this branch is unreachable through
 * the type system. It exists so that a value that arrives from the wire
 * anyway produces an honest word rather than `undefined` rendering as an
 * empty cell.
 */
/**
 * The episode state that means a limit cut the episode short.
 *
 * The same code appears in the episode state machine and in the list of
 * reasons a piece of evidence can be missing, so it is named once here.
 */
const BUDGET_TRUNCATED = "budget-truncated";

/**
 * What a label says about a value it does not recognise.
 *
 * The stored codes are closed unions, so this branch is unreachable through
 * the type system. It exists so that a value which arrives from the wire
 * anyway produces the Console's one word for missing evidence rather than
 * `undefined` rendering as an empty cell.
 */
const UNRECOGNISED_LABEL = NOT_OBSERVED_LABEL;

/**
 * The termination reason that says the runtime refused the episode's action.
 *
 * A refusal is not a crash. The runtime declined to act and said why, and the
 * episode ended without a game outcome. The episode state has no bucket for
 * that fact, so the state stays what it is and the termination reason carries
 * the truth -- which is the same arrangement the limit reasons use, and the
 * reason a label that only reads the state would say something false.
 */
const ACTION_REFUSED_TERMINATION_REASON = "action-refused";

/**
 * The termination reason that says the game stopped advancing.
 *
 * The Runtime measured that the game showed the player exactly what it had
 * shown before, for as long as the operator allowed, and ended the episode
 * there. That is not a limit the run spent and not a crash: it is the run
 * finding a game that was not responding, and the operator needs to read it
 * as that.
 */
const NO_PROGRESS_TERMINATION_REASON = "no-progress";

/**
 * The termination reason that says the runtime itself ended the run.
 *
 * "runtime-failure" is the episode state machine's word for "something below
 * the product broke", and on its own it tells the operator nothing about
 * whether the game, the decision backend or the budget was at fault. The
 * cause is written down on the step the runtime ended on, and the label below
 * reads it from there.
 */
export const RUNTIME_FAILURE_TERMINATION_REASON = "runtime-failure";

/**
 * Why a decision backend stopped the run, in the words of the backend.
 *
 * The Runtime records the code it ended with against the failing step, and
 * the code is the backend's own: "the target could not be reached", "the
 * model answered with something that is not a decision", "the answer used
 * more tokens than the approved budget". Each one is a different fact for the
 * operator with a different consequence, and the run's own state says only
 * that it failed, so the code is what has to be read.
 *
 * A code this Console does not know is shown as it was recorded. A cause that
 * is not guessed at is worth more than a cause that is.
 */
const RUNTIME_FAILURE_CAUSES = {
  "target-unavailable":
    "The approved game target could not be reached, so no action could be chosen.",
  "request-budget-exhausted":
    "The approved request budget ran out before the episode could continue.",
  "token-budget-exhausted":
    "The approved token budget ran out before the episode could continue.",
  "decision-deadline-exceeded":
    "The decision backend took longer than the approved decision deadline allowed.",
  "frame-unavailable":
    "The game's screen could not be captured, so no decision could be asked for.",
  "frame-too-large":
    "The captured screen was too large to send to the decision backend.",
  "router-unavailable": "The model router could not be reached.",
  "router-rejected-request": "The model router refused the decision request.",
  "response-too-large": "The decision backend's answer was too large to read.",
  "response-invalid":
    "The decision backend's answer could not be read as a decision, so no action was taken.",
  "response-truncated":
    "The decision backend's answer was cut off at the Runtime's output bound before it answered, so no action was taken.",
  "response-usage-unavailable":
    "The decision backend's answer did not report token usage, so the approved budget could not be enforced.",
  "response-usage-exceeds-budget":
    "The decision backend's answer used more tokens than the approved budget allowed.",
  "workspace-unavailable":
    "The workspace could not be read when the decision was asked for.",
  "action-not-grounded":
    "The decision backend chose an action the screen did not offer, so the runtime refused it."
} as const;

export type PlaytestingRuntimeFailureCause =
  keyof typeof RUNTIME_FAILURE_CAUSES;

/**
 * The tone for a state that is known but not a success.
 *
 * A crash, a cancellation, a truncated episode and a state the Console does
 * not recognise all mean the same thing to a reader: this run did not
 * produce a result to trust.
 */
const GAP_TONE: PlaytestingLabelTone = "unavailable";

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
 * When the episode was cut short by a limit, the label names the limit. When
 * the runtime refused the episode's action, the label names the refusal: the
 * episode state alone cannot say that the run stopped because the runtime
 * declined to act rather than because the run broke.
 */
export function executionStateLabel(
  status: PlaytestEpisode["status"],
  terminationReason?: string | null
): string {
  switch (status) {
    case "assigned": {
      return "Queued";
    }
    case "started": {
      return "Running";
    }
    case "completed": {
      return "Completed";
    }
    case "crashed": {
      return terminationReason === ACTION_REFUSED_TERMINATION_REASON
        ? "Action refused"
        : "Crashed";
    }
    case "infrastructure-failed": {
      return "Failed (infrastructure)";
    }
    case "cancelled": {
      return "Cancelled";
    }
    case BUDGET_TRUNCATED: {
      if (terminationReason === NO_PROGRESS_TERMINATION_REASON) {
        return "Game not advancing";
      }
      const limit = limitTerminationReason(terminationReason);
      return limit === null
        ? "Limit reached"
        : LIMIT_TERMINATION_REASONS[limit];
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
  }
}

/**
 * The tone an execution state should be shown with.
 *
 * A refused action is not a broken run: the runtime declined to act and said
 * why, so it is the known-gap tone rather than the error tone a crash earns.
 */
export function executionStateTone(
  status: PlaytestEpisode["status"],
  terminationReason?: string | null
): PlaytestingLabelTone {
  switch (status) {
    case "assigned":
    case "started": {
      return "pending";
    }
    case "completed": {
      return "valid";
    }
    case "crashed": {
      return terminationReason === ACTION_REFUSED_TERMINATION_REASON
        ? GAP_TONE
        : "invalid";
    }
    case "infrastructure-failed":
    case "cancelled":
    case BUDGET_TRUNCATED: {
      return GAP_TONE;
    }
    default: {
      return GAP_TONE;
    }
  }
}

/**
 * A one-line explanation of why an episode ended where it ended.
 *
 * A truncated episode that ran out of tokens and one that hit the step cap
 * are both "budget truncated" to the state machine and are not the same
 * fact for the operator, so the reason is spelled out rather than implied.
 *
 * An episode the runtime ended because it refused the action is spelled out
 * for the same reason: the reader is told the run stopped on a refusal, and
 * that no game outcome was observed, rather than being left to infer a
 * crash from the state.
 */
export function executionStateExplanation(
  status: PlaytestEpisode["status"],
  terminationReason?: string | null
): string | null {
  if (terminationReason === ACTION_REFUSED_TERMINATION_REASON) {
    return "The runtime refused the episode's action and ended the episode. No terminal game outcome was observed; no win or loss is inferred.";
  }
  if (terminationReason === NO_PROGRESS_TERMINATION_REASON) {
    return "The game showed the player nothing new for as long as the approved no-progress limit allowed, and the episode ended there. No terminal game outcome was observed; no win or loss is inferred.";
  }
  if (status !== BUDGET_TRUNCATED) return null;
  const limit = limitTerminationReason(terminationReason);
  if (limit === null) {
    return "The episode was cut short by an approved limit.";
  }
  switch (limit) {
    case "usage-budget": {
      return "The approved per-episode usage budget ran out before the step cap was reached.";
    }
    case "step-limit": {
      return "The approved per-episode step cap was reached before the usage budget ran out.";
    }
    case "wall-time-limit": {
      return "The approved per-episode wall-time limit was reached before the episode finished.";
    }
    default: {
      return null;
    }
  }
}

/** The operator-facing label for a game's own outcome. */
/**
 * The sentence that says why the runtime ended the run.
 *
 * The episode's own state says only that the run failed; the cause the
 * Runtime recorded against the failing step says what failed. A cause the
 * Console does not recognise is shown as it was recorded rather than
 * described in a guess.
 */
export function runtimeFailureExplanation(
  recordedCode: string | null | undefined
): string | null {
  if (recordedCode === null || recordedCode === undefined) return null;
  const separator = recordedCode.lastIndexOf(":");
  const cause =
    separator === -1 ? recordedCode : recordedCode.slice(separator + 1);
  const sentence = Object.hasOwn(RUNTIME_FAILURE_CAUSES, cause)
    ? RUNTIME_FAILURE_CAUSES[cause as PlaytestingRuntimeFailureCause]
    : `The runtime ended the run with the recorded cause "${recordedCode}".`;
  return `${sentence} No terminal game outcome was observed; no win or loss is inferred.`;
}

/** The operator-facing label for a game's own outcome. */
export function gameOutcomeLabel(value: PlaytestGameOutcomeKind): string {
  switch (value) {
    case "win": {
      return "Win";
    }
    case "loss": {
      return "Loss";
    }
    case "dnf": {
      return "Did not finish";
    }
    case "other": {
      return "Other outcome";
    }
    case "unknown": {
      return "Not observed";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
  }
}

/**
 * The badge label for a game's outcome.
 *
 * A badge stands on its own: "Not observed" beside an execution-status badge
 * says which of the two was not observed only to a reader who already knows,
 * so the badge names what is missing. The sentence form elsewhere says "Not
 * observed", because the sentence names what it is about.
 */
export function gameOutcomeBadgeLabel(value: PlaytestGameOutcomeKind): string {
  return value === "unknown" ? "No game outcome" : gameOutcomeLabel(value);
}

/**
 * The operator-facing word for every status a review section can carry.
 *
 * A `Record` over the contract's own union, so the table is exhaustive: a
 * status added to the contract without a word of its own is a typecheck
 * failure here rather than a code on a page. A switch with a `default` branch
 * would not have caught it -- the new status would have fallen through to the
 * fallback and the page would have said "Not observed" about a section that
 * was there.
 */
const REVIEW_SECTION_STATUS_LABEL: Record<PlaytestReviewSectionStatus, string> =
  {
    available: "Available",
    unavailable: "Unavailable",
    provided: "Provided",
    "none-identified": "None identified",
    proposed: "Proposed",
    "none-recommended": "None recommended",
    none: "None",
    [PLAYTEST_REVIEW_SECTION_NOT_RECORDED]: "Not recorded"
  };

export function reviewSectionStatusLabel(
  status: PlaytestReviewSectionStatus
): string {
  return REVIEW_SECTION_STATUS_LABEL[status] ?? UNRECOGNISED_LABEL;
}

/**
 * The tone every status a review section can carry is shown with.
 *
 * A section that could not be assembled is a known gap in what was observed,
 * so it is the warning tone; a section the review did not record at all is
 * missing evidence, so it is never painted as anything else. The sections that
 * carry content -- and the sections that legitimately found none -- take the
 * accent tone, which claims neither a success nor a failure.
 */
const REVIEW_SECTION_STATUS_TONE: Record<
  PlaytestReviewSectionStatus,
  StatusBadgeVariant
> = {
  available: "configured",
  unavailable: "unavailable",
  provided: "configured",
  "none-identified": "configured",
  proposed: "configured",
  "none-recommended": "configured",
  none: "configured",
  [PLAYTEST_REVIEW_SECTION_NOT_RECORDED]: NOT_OBSERVED_STATUS
};

export function reviewSectionStatusTone(
  status: PlaytestReviewSectionStatus
): StatusBadgeVariant {
  return REVIEW_SECTION_STATUS_TONE[status] ?? NOT_OBSERVED_STATUS;
}

/** The operator-facing label for a reason a piece of evidence is missing. */
export function missingReasonLabel(reason: PlaytestMissingReason): string {
  switch (reason) {
    case "no-consent": {
      return "No consent recorded";
    }
    case "withdrawn": {
      return "Withdrawn";
    }
    case "missing-ENJ": {
      return "No event journal recorded";
    }
    case "missing-before-action-probe": {
      return "No probe before the action";
    }
    case "missing-feedback": {
      return "No feedback recorded";
    }
    case "missing-action-or-revision-events": {
      return "No action or revision events";
    }
    case "stochastic-outcome-without-probability-target": {
      return "Stochastic outcome without a probability target";
    }
    case "fork-unsupported": {
      return "Fork not supported";
    }
    case "partial-alternatives": {
      return "Only some alternatives were run";
    }
    case "reward-or-continuation-contract-mismatch": {
      return "Reward or continuation contract mismatch";
    }
    case "unsupported-evaluator": {
      return "Evaluator not supported";
    }
    case "unsupported-modality": {
      return "Modality not supported";
    }
    case "wrong-instrument": {
      return "Wrong instrument";
    }
    case "outside-window": {
      return "Outside the measurement window";
    }
    case "unobserved": {
      return "Not observed";
    }
    case "infrastructure-failed": {
      return "Infrastructure failure";
    }
    case BUDGET_TRUNCATED: {
      return "A limit cut the episode short";
    }
    case "cancelled": {
      return "Cancelled";
    }
    case "revoked": {
      return "Permission revoked";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
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
    case "smart-direct": {
      return "Smart-directed";
    }
    case "onejev-local": {
      return "OneJev (local)";
    }
    case "random": {
      return "Random legal action";
    }
    case "first-legal": {
      return "First legal action";
    }
    case "scored": {
      return "Scored policy";
    }
    default: {
      return policyId;
    }
  }
}

/** The operator-facing label for an execution mode. */
export function executionModeLabel(
  mode: PlaytestExecutionProvenance["mode"]
): string {
  switch (mode) {
    case "autonomous-visual": {
      return "Autonomous visual";
    }
    case "adapter-accelerated": {
      return "Adapter-accelerated";
    }
    case "scripted-regression": {
      return "Scripted regression";
    }
    case "legacy-unknown": {
      return "Legacy mode unknown";
    }
    default: {
      return "Mode not observed";
    }
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
    case "queued": {
      return "Queued";
    }
    case "running": {
      return "Running";
    }
    case "completed": {
      return "Completed";
    }
    case "failed": {
      return "Failed";
    }
    case "cancelled": {
      return "Cancelled";
    }
    case "truncated": {
      return "Cut short by a limit";
    }
    default: {
      return status;
    }
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

/**
 * What kind of analyst review the operator asked for.
 *
 * A findings review files the defects the frozen evidence supports; a
 * hypothesis review states what the packet shows and files none. The two are
 * different jobs, and a run that filed no findings reads differently when the
 * operator knows which one was requested.
 *
 * A run recorded before the request was recorded at all says so. Naming a
 * kind it cannot support would make an old run look like a deliberate
 * hypothesis review.
 */
export function analystRequestKindLabel(
  requireFindings: boolean | undefined
): string {
  if (requireFindings === true) {
    return "Asked to file findings";
  }
  if (requireFindings === false) {
    return "Hypothesis review; no findings requested";
  }
  return "Not recorded";
}

/** The operator-facing label for a finding's severity. */
export function findingSeverityLabel(
  severity: "catastrophic" | "major" | "minor" | "informational"
): string {
  switch (severity) {
    case "catastrophic": {
      return "Catastrophic";
    }
    case "major": {
      return "Major";
    }
    case "minor": {
      return "Minor";
    }
    case "informational": {
      return "Informational";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
  }
}

/** The operator-facing label for a finding's lifecycle status. */
export function findingStatusLabel(
  status: "open" | "fixed" | "regressed" | "withdrawn" | "stale"
): string {
  switch (status) {
    case "open": {
      return "Open";
    }
    case "fixed": {
      return "Fixed";
    }
    case "regressed": {
      return "Regressed";
    }
    case "withdrawn": {
      return "Withdrawn";
    }
    case "stale": {
      return "Stale";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
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
    case "not-yet-validated": {
      return "Not yet validated";
    }
    case "fixed-on-reproduced-case": {
      return "Fixed on the reproduced case";
    }
    case "sustained-improvement": {
      return "Sustained improvement";
    }
    case "regressed-elsewhere": {
      return "Regressed elsewhere";
    }
    case "insufficient-evidence": {
      return "Insufficient evidence";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
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
    case "verified": {
      return "Verified";
    }
    case "corroborated": {
      return "Corroborated";
    }
    case "hypothesis": {
      return "Hypothesis";
    }
    case "not observed": {
      return "Not observed";
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
  }
}

/**
 * The operator-facing label for a claim the analyst recorded.
 *
 * A review records two kinds of claim: what the analyst asserts, and what it
 * explicitly could not confirm. Reading the second as the first would turn an
 * explicit null into a conclusion, so the status gets its own word.
 *
 * The review's own status uses the same words for the same reason.
 */
export function reviewClaimStatusLabel(status: string): string {
  switch (status) {
    case "hypothesis": {
      return "Hypothesis";
    }
    case "not observed": {
      return NOT_OBSERVED_LABEL;
    }
    default: {
      return UNRECOGNISED_LABEL;
    }
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
    case "episode": {
      return "Episode";
    }
    case "event": {
      return "Event";
    }
    case "frame": {
      return "Frame";
    }
    case "replay-segment": {
      return "Replay segment";
    }
    case "review": {
      return "Review";
    }
    case "finding": {
      return "Finding";
    }
    case "comparison": {
      return "Comparison";
    }
    case "policy-validity": {
      return "Policy validity";
    }
    default: {
      return kind;
    }
  }
}

/**
 * What went wrong when a session could not be opened.
 *
 * `notFound` means the workspace holds no playtest session under that id.
 * That is a fact about the URL, not a fault in the server, so it must not be
 * described with the shared failure shell's default hint — which tells the
 * operator to configure a server-side integration and restart the Console, and
 * sends them to repair something that is not broken.
 */
export interface PlaytestingSessionFailure {
  readonly code: string;
  readonly message: string;
  readonly notFound: boolean;
}

/** The heading for a session that could not be opened. */
export function playtestingSessionFailureTitle(
  failure: PlaytestingSessionFailure
): string {
  return failure.notFound
    ? "Session not found"
    : "Playtesting episode could not be loaded";
}

/**
 * The operator's next step, or null when the shared shell's own hint applies.
 *
 * A missing session has an obvious next step — open one the workspace actually
 * recorded — so the hint says that instead of blaming the deployment.
 */
export function playtestingSessionFailureHint(
  failure: PlaytestingSessionFailure
): string | null {
  return failure.notFound
    ? "This workspace has no playtest session with this id. Open a session from the Playtesting list for this workspace."
    : null;
}
