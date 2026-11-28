import { z } from "zod";

import { HOOK_EVENTS, type HookEvent } from "../hooks/types.ts";
import {
  reconciliationViewSchema,
  ruleSyncValidationIssueListSchema
} from "./shared.ts";

export const CONTROL_API_HOOKS_SCHEMA_ID = "autodev-control-hooks-v2" as const;
export const CONTROL_API_HOOKS_APPLIED_SCHEMA_ID =
  "autodev-control-hooks-applied-v1" as const;

export const hookEventSchema = z.enum(
  HOOK_EVENTS as [HookEvent, ...HookEvent[]]
);
export const hookDeclarationOriginSchema = z.enum(["shared", "target"]);

export const hookActionSchema = z
  .object({
    type: z.literal("command"),
    command: z.string(),
    matcher: z.string().exactOptional(),
    statusMessage: z.string().exactOptional()
  })
  .readonly();

export const controlApiHookEventSchema = z
  .object({
    event: hookEventSchema,
    actions: z.array(hookActionSchema).readonly()
  })
  .readonly();

export const controlApiHookDeclarationSchema = z
  .object({
    event: hookEventSchema,
    origin: hookDeclarationOriginSchema,
    actions: z.array(hookActionSchema).readonly()
  })
  .readonly();

export const controlApiHooksResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_HOOKS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(true),
    valid: z.boolean().nullable(),
    issues: ruleSyncValidationIssueListSchema,
    revision: z.string().nullable(),
    sourceText: z.string().nullable(),
    target: z.string(),
    events: z.array(controlApiHookDeclarationSchema).readonly()
  })
  .readonly();

export const controlApiHooksAppliedResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_HOOKS_APPLIED_SCHEMA_ID),
    source: z.string(),
    declarationSource: z.literal(".rulesync/hooks.jsonc"),
    target: z.string(),
    available: z.boolean(),
    declaredEvents: z.array(controlApiHookDeclarationSchema).readonly(),
    events: z.array(controlApiHookEventSchema).readonly(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export type ControlApiHookEvent = z.infer<typeof controlApiHookEventSchema>;
export type ControlApiHookDeclaration = z.infer<
  typeof controlApiHookDeclarationSchema
>;
export type ControlApiHooksResponse = z.infer<
  typeof controlApiHooksResponseSchema
>;
export type ControlApiHooksAppliedResponse = z.infer<
  typeof controlApiHooksAppliedResponseSchema
>;
