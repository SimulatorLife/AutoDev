import { z } from "zod";

import type { RuleSyncValidationIssue } from "../validation/types.ts";

/**
A Control API revision: the sha256 digest of a canonical file.

The Runtime and the Console both compare-and-swap on this value, so the
shape of a revision is one contract rather than a spelling each side
keeps: a lowercase hex digest of exactly 64 characters. Uppercase is not
accepted, because a digest the Runtime computed is always lowercase and a
revision that differs only in case is not the revision that was read.

This is the revision of a canonical *file*. A git commit or build sha is a
different thing and has its own pattern, which accepts the shorter git
form as well.
*/
export const CONTROL_API_REVISION_PATTERN = /^[a-f0-9]{64}$/u;

export const controlApiRevisionSchema = z
  .string()
  .regex(CONTROL_API_REVISION_PATTERN);

/**
Git commit or sha256 revision hashes accepted by prompt history reads.
*/
export const CONTROL_API_GIT_REVISION_PATTERN =
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const controlApiGitRevisionSchema = z
  .string()
  .regex(CONTROL_API_GIT_REVISION_PATTERN);

/**
One reason a canonical source cannot be applied, shared across RuleSync catalogs.
*/
export const ruleSyncValidationIssueSchema = z
  .object({
    location: z.string(),
    message: z.string()
  })
  .readonly();

export const ruleSyncValidationIssueListSchema = z
  .array(ruleSyncValidationIssueSchema)
  .readonly();

export const controlApiEnablementSchema = z
  .object({
    enabled: z.boolean(),
    mutable: z.boolean()
  })
  .readonly();

export const convergenceStatusSchema = z.enum([
  "converged",
  "pending",
  "error",
  "not-observed"
]);

export const reconciliationDiffSchema = z
  .object({
    summary: z.string(),
    identifier: z.string()
  })
  .readonly();

export const reconciliationStatusSchema = z
  .object({
    convergence: convergenceStatusSchema,
    desiredGeneration: z.string().nullable(),
    observedGeneration: z.string().nullable(),
    lastApplyAt: z.string().nullable(),
    lastObservationAt: z.string().nullable(),
    lastError: z.string().nullable(),
    explanation: z.string()
  })
  .readonly();

export const operationHistoryChangesSchema = z
  .object({
    desiredGeneration: z.string().nullable(),
    observedGeneration: z.string().nullable(),
    restartRequired: z.boolean()
  })
  .readonly();

export const operationHistoryEntrySchema = z
  .object({
    action: z.string(),
    resource: z.string(),
    timestamp: z.string(),
    actor: z.string().nullable(),
    outcome: z.enum(["ok", "denied", "error"]),
    reason: z.string().nullable(),
    changes: operationHistoryChangesSchema
  })
  .readonly();

export const reconciliationViewSchema = z
  .object({
    status: reconciliationStatusSchema,
    history: z.array(operationHistoryEntrySchema).readonly()
  })
  .readonly();

export const enablementWithConvergenceSchema = z
  .object({
    enabled: z.boolean(),
    mutable: z.boolean(),
    convergence: reconciliationStatusSchema
  })
  .readonly();

export const controlApiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    status: z.number()
  })
  .readonly();

export const controlApiErrorEnvelopeSchema = z
  .object({
    error: controlApiErrorSchema
  })
  .readonly();

export type ControlApiError = z.infer<typeof controlApiErrorSchema>;
export type ControlApiErrorEnvelope = z.infer<
  typeof controlApiErrorEnvelopeSchema
>;
export type ControlApiEnablement = z.infer<typeof controlApiEnablementSchema>;
export type ControlApiValidationIssue = RuleSyncValidationIssue;
