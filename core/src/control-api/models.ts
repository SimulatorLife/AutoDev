import { z } from "zod";

import {
  enablementWithConvergenceSchema,
  reconciliationViewSchema
} from "./shared.ts";

export const CONTROL_API_MODELS_SCHEMA_ID =
  "autodev-control-models-v2" as const;
export const CONTROL_API_MODEL_PATCH_SCHEMA_ID =
  "autodev-control-model-v1" as const;

export const controlApiModelRecordSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    tiers: z.array(z.string()).readonly(),
    displayName: z.string().nullable(),
    enablement: enablementWithConvergenceSchema
  })
  .readonly();

export const controlApiModelsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MODELS_SCHEMA_ID),
    source: z.string(),
    models: z.array(controlApiModelRecordSchema).readonly()
  })
  .readonly();

export const controlApiModelPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MODEL_PATCH_SCHEMA_ID),
    model: z.string(),
    enabled: z.boolean(),
    previous: z.boolean(),
    actor: z.string(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export type ControlApiModelRecord = z.infer<typeof controlApiModelRecordSchema>;
export type ControlApiModelsResponse = z.infer<
  typeof controlApiModelsResponseSchema
>;
export type ControlApiModelPatchResponse = z.infer<
  typeof controlApiModelPatchResponseSchema
>;
