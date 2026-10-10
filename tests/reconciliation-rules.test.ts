import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildReconciliationView,
  deriveConvergence,
  deriveReconciliationStatus,
  OPERATION_HISTORY_LIMIT,
  type OperationHistoryEntry,
  type ReconciliationEvidence,
  trimOperationHistory
} from "@simulatorlife/autodev-core";

/**
 * Baseline evidence for a resource whose desired generation has been applied
 * and observed, so the default fixture is genuinely converged. Any test that
 * wants another state overrides the generations explicitly.
 */
function makeEvidence(
  overrides: Partial<ReconciliationEvidence> = {}
): ReconciliationEvidence {
  return {
    desiredGeneration: "generation-1",
    observedGeneration: "generation-1",
    lastApplyAt: "2026-01-01T00:00:00.000Z",
    lastObservationAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    ...overrides
  };
}

const CONVERGED_EXPLANATION =
  "The runtime has observed the latest desired generation; convergence is recorded.";

function makeEntry(
  overrides: Partial<OperationHistoryEntry> = {}
): OperationHistoryEntry {
  return {
    action: "patch_provider_role",
    resource: "/control/providers/claude/roles/orchestrator",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "operator-a",
    outcome: "ok",
    reason: null,
    changes: {
      desiredGeneration: "generation-1",
      observedGeneration: "generation-1",
      restartRequired: false
    },
    ...overrides
  };
}

describe("deriveConvergence", () => {
  test("returns error when a redacted last-error is present", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: "o" },
        { hasObservation: true, lastError: "persistence_failed" }
      ),
      "error"
    );
  });

  test("returns not-observed when the runtime has not yet reported state", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: null },
        { hasObservation: false }
      ),
      "not-observed"
    );
    assert.equal(
      deriveConvergence(
        { desired: null, observed: null },
        { hasObservation: false }
      ),
      "not-observed"
    );
  });

  test("returns pending when restart is required", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: null },
        { hasObservation: true, restartRequired: true }
      ),
      "pending"
    );
  });

  test("returns pending when the desired generation has no observed counterpart", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: null },
        { hasObservation: true }
      ),
      "pending"
    );
  });

  test("treats missing and empty generations as unobserved or pending, never equal", () => {
    const cases = [
      [null, null, "not-observed"],
      [null, "o", "not-observed"],
      ["d", null, "pending"],
      ["", "", "not-observed"],
      ["d", "", "pending"]
    ] as const;
    for (const [desired, observed, expected] of cases) {
      assert.equal(
        deriveConvergence({ desired, observed }, { hasObservation: true }),
        expected
      );
    }
  });

  test("returns converged only when desired and observed generations match", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: "d" },
        { hasObservation: true }
      ),
      "converged"
    );
  });

  test("returns pending when observed generation is stale or mismatched", () => {
    assert.equal(
      deriveConvergence(
        { desired: "d", observed: "older" },
        { hasObservation: true }
      ),
      "pending"
    );
  });
});

describe("deriveReconciliationStatus", () => {
  test("propagates evidence fields and the matching convergence state", () => {
    const status = deriveReconciliationStatus(makeEvidence(), {
      hasObservation: true
    });
    assert.equal(status.convergence, "converged");
    assert.equal(status.desiredGeneration, "generation-1");
    assert.equal(status.observedGeneration, "generation-1");
    assert.equal(status.lastApplyAt, "2026-01-01T00:00:00.000Z");
    assert.equal(status.lastObservationAt, "2026-01-01T00:00:00.000Z");
    assert.equal(status.lastError, null);
    assert.match(status.explanation, /observed the latest desired generation/u);
  });

  test("renders a pending explanation when generations disagree", () => {
    const status = deriveReconciliationStatus(
      makeEvidence({ observedGeneration: null }),
      { hasObservation: true }
    );
    assert.equal(status.convergence, "pending");
    assert.match(status.explanation, /has not observed it yet/u);
  });
});

describe("trimOperationHistory", () => {
  test("keeps only the bounded Console-visible entries", () => {
    const entries = Array.from({ length: 25 }, (_, index) =>
      makeEntry({
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
      })
    );
    const trimmed = trimOperationHistory(entries);
    assert.equal(trimmed.length, OPERATION_HISTORY_LIMIT);
    assert.equal(trimmed[0]?.timestamp, "2026-01-01T00:00:00.000Z");
  });
});

describe("buildReconciliationView", () => {
  test("returns the canonical status + bounded history shape", () => {
    const view = buildReconciliationView({
      evidence: makeEvidence(),
      history: [
        makeEntry(),
        makeEntry({ outcome: "denied", reason: "viewer_cannot_mutate" })
      ],
      hasObservation: true
    });
    assert.equal(view.status.convergence, "converged");
    assert.equal(view.status.explanation, CONVERGED_EXPLANATION);
    assert.equal(view.history.length, 2);
    assert.equal(view.history[1]?.outcome, "denied");
  });

  test("treats missing observation as not-observed, never converged", () => {
    const view = buildReconciliationView({
      evidence: makeEvidence({ observedGeneration: null }),
      history: []
    });
    assert.equal(view.status.convergence, "not-observed");
    assert.equal(view.history.length, 0);
  });
});
