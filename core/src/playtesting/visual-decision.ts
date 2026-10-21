/**
 * The provider-neutral decision contract for a visual playtest episode.
 *
 * A visual episode asks one question: given what is on screen, what should
 * happen next? Two backends answer it today. The Smart-directed route asks
 * the AutoDev Model Router for one action. The local OneJev route asks a
 * TypeSafe System One checkpoint to score a finite list of candidate
 * actions and pick one.
 *
 * The two are different services with different capabilities, so the
 * contract states what a backend *can* say and records a capability it
 * cannot say as `not-supported` rather than as a field that is quietly
 * absent. A backend that reports no confidence is a backend whose
 * confidence is `not-supported`; it is never a backend whose confidence is
 * zero.
 *
 * Infrastructure-free: no Runtime/Data/Console imports, no network, no
 * filesystem.
 */

import type { PlaytestPlayerFocusOutcome } from "./player-debrief.ts";
import type { WorkspaceVisualPlaytestTargetApproval } from "../workspaces/visual-playtesting.ts";
import type {
  PlaytestVisualAction,
  PlaytestVisualObservation
} from "./visual-control.ts";

/** The decision backends a visual episode may be launched with. */
export const PLAYTESTS_VISUAL_POLICY_IDS = [
  "smart-direct",
  "onejev-local"
] as const;

/**
 * A visual episode's decision backend.
 *
 * `smart-direct` is the AutoDev Model Router route. `onejev-local` is a
 * OneJev checkpoint served by the `qev` server on the operator's own
 * machine.
 */
export type PlaytestVisualPolicyId =
  (typeof PLAYTESTS_VISUAL_POLICY_IDS)[number];

/** True when the id names a decision backend this build knows how to run. */
export function isPlaytestVisualPolicyId(
  value: unknown
): value is PlaytestVisualPolicyId {
  return (
    typeof value === "string" &&
    (PLAYTESTS_VISUAL_POLICY_IDS as readonly string[]).includes(value)
  );
}

/**
 * One action a decision backend may choose.
 *
 * A candidate carries the action it would perform and a description of it
 * in words a model can read. The action is still admitted independently by
 * `admitPlaytestVisualAction` before any input reaches the browser, so a
 * candidate is a *proposal*, never a permission.
 */
export interface PlaytestVisualCandidate {
  /** Stable within one decision request; the backend answers with it. */
  readonly id: string;
  /** What choosing this candidate would do, in the player's terms. */
  readonly description: string;
  /** The action this candidate proposes. */
  readonly action: PlaytestVisualAction;
}

/**
 * What a decision backend saw, in the order it saw it.
 *
 * The history is a bounded textual summary, not the recorded objects. A
 * decision backend reads it to know what the episode has already tried;
 * the recorded action and observation objects stay in the Runtime, where
 * the evidence that cites them lives. Sending a whole observation to a
 * small local model would spend its context on facts no decision needs.
 */
export interface PlaytestVisualHistoryEntry {
  readonly step: number;
  /** A bounded summary of what the episode did. */
  readonly action: string;
  /** A bounded summary of what the episode saw. */
  readonly observation: string;
}

/** One decision request, as handed to a decision backend. */
export interface PlaytestVisualDecisionRequest {
  /** The approved target the episode runs against. */
  readonly target: WorkspaceVisualPlaytestTargetApproval;
  /** The most recent visible state, with its sanitized controls. */
  readonly observation: PlaytestVisualObservation;
  /** The exact bytes of the captured frame the observation cites. */
  readonly frameBytes: Uint8Array;
  /** The operator's focus for this episode, when one was given. */
  readonly areasOfFocus: string | null;
  /** What the episode has already done. */
  readonly history: readonly PlaytestVisualHistoryEntry[];
  /** The wall-clock instant after which the backend must not answer. */
  readonly deadlineMonotonicMs: number;
  /**
   * The actions the backend may choose from.
   *
   * A backend that picks an action on its own is answering outside the
   * approved set; the contract requires a candidate set so that every
   * choice can be grounded in something the Runtime proposed.
   */
  readonly candidates: readonly PlaytestVisualCandidate[];
}

/**
 * What a decision backend can and cannot report.
 *
 * A capability that is `false` means the backend does not emit that value.
 * It is recorded, so a reader can tell "the backend said nothing" from
 * "the value was not captured".
 */
export interface PlaytestVisualDecisionCapabilities {
  /** The backend names what it is trying to do. */
  readonly emitsIntent: boolean;
  /** The backend names the visible effect it expects. */
  readonly emitsPrediction: boolean;
  /** The backend reasons about its own choice rather than only choosing. */
  readonly reflective: boolean;
  /** The backend reports a calibrated confidence for its choice. */
  readonly reportsConfidence: boolean;
}

/**
 * The counters a decision backend accumulates over an episode.
 *
 * `logicalRequests` counts decisions the episode asked for.
 * `providerAttempts` counts calls that actually left the process. They
 * differ when a request is retried: a retry is another attempt at the same
 * logical decision, never another decision.
 */
export interface PlaytestVisualDecisionCounters {
  readonly logicalRequests: number;
  readonly providerAttempts: number;
  readonly decisionsReturned: number;
  /** Total tokens attributed to this backend, when the backend reports them. */
  readonly tokensUsed: number;
  /** False when the backend did not report usage, so the count is a floor. */
  readonly tokenUsageComplete: boolean;
  /** Candidates the backend proposed that the Runtime refused to ground. */
  readonly groundingRejections: number;
}

/**
 * A decision backend's reflective self-report.
 *
 * Only a backend that reasons about its own attempt reports one: it is the
 * player's own account of what it was trying to do and what it concluded
 * it could and could not do. A backend that answers with a calibrated
 * choice and nothing else has no self-report to give, and leaves the
 * decision's `selfReport` null rather than inventing one.
 */
export interface PlaytestVisualDecisionSelfReport {
  readonly objective: string | null;
  readonly inScope: readonly string[];
  readonly forbiddenScope: readonly string[];
  readonly stopCriteria: readonly string[];
  readonly outcome: PlaytestPlayerFocusOutcome;
  readonly summary: string;
  /** Recent player-visible steps; the Runtime resolves them to stored frames. */
  readonly evidenceSteps: readonly number[];
}

/** One decision, as returned by a decision backend. */
export interface PlaytestVisualDecision {
  /** `act` names an action to perform; `stop` ends the episode. */
  readonly status: "act" | "stop";
  /** The action to perform. Present when `status` is `act`. */
  readonly action: PlaytestVisualAction | null;
  /** Why the backend stopped, when `status` is `stop`. */
  readonly stopReason: string | null;
  /** What the backend is trying to do, when it says. */
  readonly intention: string | null;
  /** The visible effect the backend expects, when it says. */
  readonly predictedVisibleEffect: string | null;
  /** The backend's reflective self-report, when it produces one. */
  readonly selfReport: PlaytestVisualDecisionSelfReport | null;
  /** A stable machine-readable reason for the choice. */
  readonly reasonCode: string;
  /** Which backend answered. */
  readonly backendId: PlaytestVisualPolicyId;
  /** The concrete model that answered, when the backend names one. */
  readonly modelId: string | null;
  /** The model revision, when the backend can name one. */
  readonly modelRevision: string | null;
  /** True when the answer came from a fallback rather than the backend asked for. */
  readonly fallback: boolean;
  /** Why the fallback was used, when one was. */
  readonly fallbackReason: string | null;
  /** The backend's confidence in the choice, when it reports one. */
  readonly confidence: number | null;
  /** What this backend can report. */
  readonly capabilities: PlaytestVisualDecisionCapabilities;
  /** The counters as they stood when this decision was made. */
  readonly counters: PlaytestVisualDecisionCounters;
}

/**
 * The counters a decision backend reports for the episode it served.
 *
 * The episode owns the numbers; the backend owns the decisions.
 */
export interface PlaytestVisualPolicyUsage {
  readonly logicalRequests: number;
  readonly providerAttempts: number;
  readonly decisionsReturned: number;
  readonly tokensUsed: number;
  readonly tokenUsageComplete: boolean;
  readonly groundingRejections: number;
  /** Null until the backend has answered a decision. */
  readonly lastLatencyMs: number | null;
}

/**
 * A decision backend for visual episodes.
 *
 * The Runtime depends on this interface and not on any one backend, so a
 * second backend is a new implementation rather than a new branch in the
 * episode loop.
 */
export interface PlaytestVisualPolicy {
  /** The backend this policy implements. */
  readonly backendId: PlaytestVisualPolicyId;
  /** Choose the next action, or stop. */
  decide(
    request: PlaytestVisualDecisionRequest
  ): Promise<PlaytestVisualDecision>;
  /** The counters as they stand now. */
  usage(): PlaytestVisualPolicyUsage;
}
