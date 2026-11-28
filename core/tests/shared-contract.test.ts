import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_CONTRACT,
  controlApiContractResponseSchema
} from "../src/control-api/contract.ts";
import {
  controlApiEnablementSchema,
  controlApiErrorEnvelopeSchema,
  controlApiRevisionSchema,
  reconciliationDiffSchema,
  reconciliationStatusSchema,
  reconciliationViewSchema,
  ruleSyncValidationIssueListSchema
} from "../src/control-api/shared.ts";

const VALID_STATUS = {
  convergence: "converged",
  desiredGeneration: "gen-1",
  observedGeneration: "gen-1",
  lastApplyAt: "2026-11-27T08:00:00Z",
  lastObservationAt: "2026-11-27T08:00:01Z",
  lastError: null,
  explanation: "Converged on desired generation."
};

const VALID_HISTORY_ENTRY = {
  action: "patch_prompt_command",
  resource: "dry",
  timestamp: "2026-11-27T08:00:00Z",
  actor: "local-operator",
  outcome: "ok",
  reason: null,
  changes: {
    desiredGeneration: "gen-1",
    observedGeneration: "gen-1",
    restartRequired: false
  }
};

test("controlApiContractResponseSchema accepts exact schema and version only", () => {
  assert.equal(
    controlApiContractResponseSchema.safeParse({
      schema: CONTROL_API_CONTRACT.schema,
      version: CONTROL_API_CONTRACT.version
    }).success,
    true
  );
  assert.equal(
    controlApiContractResponseSchema.safeParse({
      schema: CONTROL_API_CONTRACT.schema,
      version: CONTROL_API_CONTRACT.version - 1
    }).success,
    false
  );
  assert.equal(
    controlApiContractResponseSchema.safeParse({
      schema: "autodev-control-api-contract-v0",
      version: CONTROL_API_CONTRACT.version
    }).success,
    false
  );
});

test("shared revision, enablement, issue, and reconciliation schemas validate invariants", () => {
  assert.equal(
    controlApiRevisionSchema.safeParse("0123456789abcdef".repeat(4)).success,
    true
  );
  assert.equal(
    controlApiRevisionSchema.safeParse("0123456789ABCDEF".repeat(4)).success,
    false
  );
  assert.equal(
    controlApiEnablementSchema.safeParse({ enabled: true, mutable: false })
      .success,
    true
  );
  assert.equal(
    controlApiEnablementSchema.safeParse({ enabled: true, mutable: "yes" })
      .success,
    false
  );
  assert.equal(
    ruleSyncValidationIssueListSchema.safeParse([
      { location: "hooks[0]", message: "invalid action" }
    ]).success,
    true
  );
  assert.equal(
    ruleSyncValidationIssueListSchema.safeParse([{ location: "hooks[0]" }])
      .success,
    false
  );
  assert.equal(
    reconciliationDiffSchema.safeParse({
      summary: "Updated description",
      identifier: "diff-1"
    }).success,
    true
  );
  assert.equal(
    reconciliationStatusSchema.safeParse(VALID_STATUS).success,
    true
  );
  assert.equal(
    reconciliationStatusSchema.safeParse({
      ...VALID_STATUS,
      convergence: "unknown"
    }).success,
    false
  );
  assert.equal(
    reconciliationViewSchema.safeParse({
      status: VALID_STATUS,
      history: [VALID_HISTORY_ENTRY]
    }).success,
    true
  );
  assert.equal(
    reconciliationViewSchema.safeParse({
      status: VALID_STATUS,
      history: [{ ...VALID_HISTORY_ENTRY, outcome: "skipped" }]
    }).success,
    false
  );
  assert.equal(
    controlApiErrorEnvelopeSchema.safeParse({
      error: { code: "conflict", message: "Stale revision", status: 409 }
    }).success,
    true
  );
});
