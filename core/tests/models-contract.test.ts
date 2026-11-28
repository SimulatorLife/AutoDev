import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_MODEL_PATCH_SCHEMA_ID,
  CONTROL_API_MODELS_SCHEMA_ID,
  controlApiModelPatchResponseSchema,
  controlApiModelsResponseSchema
} from "../src/control-api/models.ts";

const TS = "2026-11-27T08:00:00.000Z";
const CONVERGENCE = {
  convergence: "converged",
  desiredGeneration: "enabled",
  observedGeneration: "enabled",
  lastApplyAt: TS,
  lastObservationAt: TS,
  lastError: null,
  explanation: "Converged."
};

test("models response requires nested enablement convergence on each model", () => {
  const valid = {
    schema: CONTROL_API_MODELS_SCHEMA_ID,
    source: "config/model-routing.json",
    models: [
      {
        id: "gpt-5",
        provider: "codex",
        tiers: ["balanced"],
        displayName: "GPT-5",
        enablement: { enabled: true, mutable: true, convergence: CONVERGENCE }
      }
    ]
  };
  assert.equal(controlApiModelsResponseSchema.safeParse(valid).success, true);
  assert.equal(
    controlApiModelsResponseSchema.safeParse({
      ...valid,
      models: [
        {
          ...valid.models[0],
          enablement: { enabled: true, mutable: true }
        }
      ]
    }).success,
    false
  );
  assert.equal(
    controlApiModelPatchResponseSchema.safeParse({
      schema: CONTROL_API_MODEL_PATCH_SCHEMA_ID,
      model: "gpt-5",
      enabled: false,
      previous: true,
      actor: "local-operator",
      reconciliation: { status: CONVERGENCE, history: [] }
    }).success,
    true
  );
});
