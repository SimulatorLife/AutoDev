import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_HOOKS_APPLIED_SCHEMA_ID,
  CONTROL_API_HOOKS_SCHEMA_ID,
  controlApiHooksAppliedResponseSchema,
  controlApiHooksResponseSchema
} from "../src/control-api/hooks.ts";

const VALID_DECLARED_EVENT = {
  event: "preToolUse",
  origin: "shared",
  actions: [{ type: "command", command: "node check.mjs", matcher: "Bash" }]
};

const VALID_APPLIED_EVENT = {
  event: "preToolUse",
  actions: [{ type: "command", command: "node check.mjs" }]
};

const VALID_RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: "gen-1",
    observedGeneration: "gen-1",
    lastApplyAt: null,
    lastObservationAt: "2026-11-27T08:00:00Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

test("hooks contract validates readOnly, events, origins, and validation issues", () => {
  const valid = {
    schema: CONTROL_API_HOOKS_SCHEMA_ID,
    source: ".rulesync/hooks.jsonc",
    readOnly: true,
    valid: true,
    issues: [],
    revision: "a".repeat(64),
    sourceText: "{}",
    target: "codexcli",
    events: [VALID_DECLARED_EVENT]
  };
  assert.equal(controlApiHooksResponseSchema.safeParse(valid).success, true);
  assert.equal(
    controlApiHooksResponseSchema.safeParse({ ...valid, readOnly: false }).success,
    false
  );
  assert.equal(
    controlApiHooksResponseSchema.safeParse({
      ...valid,
      events: [{ ...VALID_DECLARED_EVENT, origin: "local" }]
    }).success,
    false
  );
});

test("hooks-applied contract separates applied events from origin-bearing declarations", () => {
  const valid = {
    schema: CONTROL_API_HOOKS_APPLIED_SCHEMA_ID,
    source: "/home/.codex/hooks.json",
    declarationSource: ".rulesync/hooks.jsonc",
    target: "codexcli",
    available: true,
    declaredEvents: [VALID_DECLARED_EVENT],
    events: [VALID_APPLIED_EVENT],
    reconciliation: VALID_RECONCILIATION
  };
  assert.equal(
    controlApiHooksAppliedResponseSchema.safeParse(valid).success,
    true
  );
  assert.equal(
    controlApiHooksAppliedResponseSchema.safeParse({
      ...valid,
      declarationSource: ".rulesync/other.jsonc"
    }).success,
    false
  );
});
