import { z } from "zod";

import {
  controlApiGitRevisionSchema,
  controlApiRevisionSchema,
  reconciliationDiffSchema,
  reconciliationViewSchema,
  ruleSyncValidationIssueListSchema
} from "./shared.ts";

export const CONTROL_API_PROMPTS_SCHEMA_ID =
  "autodev-control-prompts-v2" as const;
export const CONTROL_API_PROMPT_DETAIL_SCHEMA_ID =
  "autodev-control-prompt-detail-v4" as const;
export const CONTROL_API_PROMPT_VERSIONS_SCHEMA_ID =
  "autodev-control-prompt-versions-v2" as const;
export const CONTROL_API_PROMPT_VERSION_SCHEMA_ID =
  "autodev-control-prompt-version-v1" as const;

const parseableTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));

export const controlApiPromptCommandRowSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    description: z.string().exactOptional()
  })
  .readonly();

export const controlApiRolePromptRowSchema = z
  .object({
    role: z.string(),
    path: z.string()
  })
  .readonly();

export const controlApiPromptsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROMPTS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(true),
    valid: z.boolean().nullable(),
    issues: ruleSyncValidationIssueListSchema,
    totalCommands: z
      .number()
      .int()
      .min(0)
      .refine(Number.isSafeInteger)
      .nullable(),
    commands: z.array(controlApiPromptCommandRowSchema).readonly(),
    rolePrompts: z.array(controlApiRolePromptRowSchema).readonly().nullable()
  })
  .readonly();

export const controlApiPromptDetailResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROMPT_DETAIL_SCHEMA_ID),
    name: z.string(),
    type: z.enum(["command", "role"]),
    source: z.string(),
    content: z.string(),
    preview: z.string(),
    revision: controlApiRevisionSchema,
    diff: reconciliationDiffSchema,
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiPromptVersionReferenceSchema = z
  .object({
    versionHash: controlApiGitRevisionSchema,
    updatedAt: parseableTimestampSchema
  })
  .readonly();

export const controlApiPromptVersionsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROMPT_VERSIONS_SCHEMA_ID),
    name: z.string(),
    status: z.enum(["available", "unavailable"]),
    versions: z.array(controlApiPromptVersionReferenceSchema).readonly(),
    hasMore: z.boolean(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1)
  })
  .readonly()
  .refine(
    (value) =>
      value.status !== "unavailable" ||
      (value.versions.length === 0 && value.hasMore === false)
  );

export const controlApiPromptVersionResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROMPT_VERSION_SCHEMA_ID),
    name: z.string(),
    versionHash: controlApiGitRevisionSchema,
    updatedAt: parseableTimestampSchema,
    content: z.string(),
    diff: z.string()
  })
  .readonly();

export type ControlApiPromptsResponse = z.infer<
  typeof controlApiPromptsResponseSchema
>;
export type ControlApiPromptDetailResponse = z.infer<
  typeof controlApiPromptDetailResponseSchema
>;
export type ControlApiPromptVersionReference = z.infer<
  typeof controlApiPromptVersionReferenceSchema
>;
export type ControlApiPromptVersionsResponse = z.infer<
  typeof controlApiPromptVersionsResponseSchema
>;
export type ControlApiPromptVersionResponse = z.infer<
  typeof controlApiPromptVersionResponseSchema
>;
