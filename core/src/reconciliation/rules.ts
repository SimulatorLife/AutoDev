/**
 * Pure rules for deriving the reusable reconciliation contract from raw
 * evidence.
 *
 * Every function here is deterministic and infrastructure-free so the rule
 * layer can be unit-tested without disk, network, or process boundaries.
 * Runtime uses `buildReconciliationView` to derive the shared contract from
 * evidence; Console consumes that status and history instead of re-deriving it.
 */

import type {
  ConvergenceStatus,
  OperationHistoryEntry,
  ReconciliationEvidence,
  ReconciliationStatus,
  ReconciliationView
} from "./types.ts";

/**
 * Stable, human-readable message that Console can render alongside the
 * convergence badge. The strings are intentional copy so the same wording
 * appears in tests, Console, and the migration tracker.
 */
const CONVERGENCE_EXPLANATION = {
  converged:
    "The runtime has observed the latest desired generation; convergence is recorded.",
  pending:
    "Apply wrote the latest desired generation, but the running runtime has not observed it yet. Restart the affected process or wait for the observation hook to refresh.",
  error:
    "The last apply or observation failed; the recorded error explains the gap.",
  "not-observed":
    "The runtime has not yet reported observed state for this resource; convergence is unknown."
} as const satisfies Record<ConvergenceStatus, string>;

function explanationFor(status: ConvergenceStatus): string {
  return CONVERGENCE_EXPLANATION[status];
}

interface Generations {
  readonly desired: string | null;
  readonly observed: string | null;
}

/**
 * Derive a convergence status from the simplest possible inputs.
 *
 * The order matters and is part of the contract:
 *
 * 1. A redacted error from the most recent observation wins: error.
 * 2. No evidence at all is unknown / not-observed.
 * 3. A non-empty desired generation with no observed generation is pending.
 * 4. Desired and observed generations that match are converged.
 * 5. Any other mismatch (observed older than desired) is pending.
 *
 * `restartRequired` flags the case where a successful apply wrote the new
 * desired generation but the runtime still needs to restart (e.g. Codex
 * already running with the old prompt projection). When restart is
 * required the runtime cannot have observed the new generation yet, so
 * the derivation falls through to `pending`.
 */
export function deriveConvergence(
  generations: Generations,
  options: {
    readonly hasObservation?: boolean;
    readonly lastError?: string | null;
    readonly restartRequired?: boolean;
  } = {}
): ConvergenceStatus {
  if (options.lastError && options.lastError.trim().length > 0) return "error";
  if (!options.hasObservation) return "not-observed";
  if (options.restartRequired === true) return "pending";
  if (generations.desired === null || generations.desired.length === 0) {
    return "not-observed";
  }
  if (generations.observed === null || generations.observed.length === 0) {
    return "pending";
  }
  if (generations.desired === generations.observed) return "converged";
  return "pending";
}

/**
 * Derive a full reconciliation status from raw evidence. The result is the
 * canonical shape Runtime and Data return to Console.
 */
export function deriveReconciliationStatus(
  evidence: ReconciliationEvidence,
  options: {
    readonly hasObservation?: boolean;
    readonly restartRequired?: boolean;
  } = {}
): ReconciliationStatus {
  const convergence = deriveConvergence(
    {
      desired: evidence.desiredGeneration,
      observed: evidence.observedGeneration
    },
    {
      ...(options.hasObservation === undefined
        ? {}
        : { hasObservation: options.hasObservation }),
      ...(options.restartRequired === undefined
        ? {}
        : { restartRequired: options.restartRequired }),
      lastError: evidence.lastError
    }
  );
  return {
    convergence,
    desiredGeneration: evidence.desiredGeneration,
    observedGeneration: evidence.observedGeneration,
    lastApplyAt: evidence.lastApplyAt,
    lastObservationAt: evidence.lastObservationAt,
    lastError: evidence.lastError,
    explanation: explanationFor(convergence)
  };
}

/**
 * Trim a history to the bounded limit the Console renders. Newest entries
 * come first so the surface is forward-looking; older history stays in the
 * audit sink rather than in the response.
 */
export function trimOperationHistory(
  entries: readonly OperationHistoryEntry[]
): readonly OperationHistoryEntry[] {
  return entries.slice(0, 10);
}

/**
 * Build the canonical reconciliation view from evidence + history. This is
 * the single function the Control API handlers use to assemble their
 * response envelopes so the Console, tests, and audit sink share the
 * exact same shape.
 */
export function buildReconciliationView(args: {
  readonly evidence: ReconciliationEvidence;
  readonly history: readonly OperationHistoryEntry[];
  readonly hasObservation?: boolean;
  readonly restartRequired?: boolean;
}): ReconciliationView {
  return {
    status: deriveReconciliationStatus(args.evidence, {
      ...(args.hasObservation === undefined
        ? {}
        : { hasObservation: args.hasObservation }),
      ...(args.restartRequired === undefined
        ? {}
        : { restartRequired: args.restartRequired })
    }),
    history: trimOperationHistory(args.history)
  };
}
