import { z } from "zod";

import {
  controlApiRevisionSchema,
  reconciliationViewSchema,
  ruleSyncValidationIssueListSchema
} from "./shared.ts";

export const CONTROL_API_SKILLS_SCHEMA_ID = "autodev-control-skills-v2" as const;
export const CONTROL_API_SKILL_CONTENT_SCHEMA_ID =
  "autodev-control-skill-content-v2" as const;

export const skillScopeSchema = z.enum(["repo", "user", "admin", "system"]);

export const controlApiSkillRowSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
    roles: z.array(z.string()).readonly(),
    scope: skillScopeSchema.nullable(),
    scopeLocation: z.string().nullable(),
    workspace: z.string().nullable(),
    observedExposure: z.number().nullable(),
    observedUse: z.number().nullable(),
    observedError: z.number().nullable()
  })
  .readonly();

export const controlApiSkillUnresolvedAssignmentSchema = z
  .object({
    name: z.string(),
    roles: z.array(z.string()).readonly()
  })
  .readonly();

/**
Control API Skills catalog contract (`autodev-control-skills-v2`).

Read-only (`readOnly: true`): canonical RuleSync skills are repository-owned.
*/
export const controlApiSkillsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_SKILLS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(true),
    valid: z.boolean().nullable(),
    issues: ruleSyncValidationIssueListSchema,
    executionContractObserved: z.boolean(),
    executionContractRevision: controlApiRevisionSchema.nullable(),
    assignmentRoles: z.array(z.string()).readonly(),
    telemetryObserved: z.boolean(),
    skills: z.array(controlApiSkillRowSchema).readonly(),
    unresolvedAssignments: z
      .array(controlApiSkillUnresolvedAssignmentSchema)
      .readonly()
      .nullable()
  })
  .readonly();

export const controlApiSkillContentResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_SKILL_CONTENT_SCHEMA_ID),
    name: z.string(),
    path: z.string(),
    content: z.string(),
    revision: controlApiRevisionSchema,
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export type ControlApiSkillsResponse = z.infer<
  typeof controlApiSkillsResponseSchema
>;
export type ControlApiSkillContentResponse = z.infer<
  typeof controlApiSkillContentResponseSchema
>;
