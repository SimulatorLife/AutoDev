import type { QuotaAxiResponse } from "quota-axi";
import { z } from "zod";

import type { ProviderRole } from "../routing/types.ts";
import { isRecord } from "../shared/object-guards.ts";
import {
  canonicalTimestampSchema,
  providerModelDiscoverySchema
} from "./provider-model-discovery.ts";
import { reconciliationStatusSchema, reconciliationViewSchema } from "./shared.ts";

export const CONTROL_API_PROVIDERS_SCHEMA_ID =
  "autodev-control-providers-v5" as const;
export const CONTROL_API_PROVIDER_CHECK_SCHEMA_ID =
  "autodev-control-provider-check-v1" as const;
export const CONTROL_API_PROVIDER_VERSIONS_SCHEMA_ID =
  "autodev-control-provider-versions-v1" as const;
export const CONTROL_API_PROVIDER_VERSIONS_SOURCE =
  "runtime-provider-cli-versions" as const;
export const CONTROL_API_PROVIDER_ROLE_PATCH_SCHEMA_ID =
  "autodev-control-provider-role-v3" as const;
export const CONTROL_API_PROVIDER_ENABLED_PATCH_SCHEMA_ID =
  "autodev-control-provider-enabled-v1" as const;
export const CONTROL_API_PROVIDER_AGENT_MODEL_PATCH_SCHEMA_ID =
  "autodev-control-provider-agent-model-v1" as const;
export const CONTROL_API_PROVIDER_LIMITS_PATCH_SCHEMA_ID =
  "autodev-control-provider-limits-v1" as const;
export const CONTROL_API_PROVIDERS_RESET_SCHEMA_ID =
  "autodev-control-providers-reset-v1" as const;

const nonNegativeSafeIntSchema = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger);

const failureClassSchema = z.string().max(128).nullable();

export const providerRoleSchema = z.custom<ProviderRole>(
  (value) => value === "orchestrator" || value === "subagent"
);

export const providerRolePrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("disabled")
]);

export const providerRoleAssignmentSchema = z
  .object({
    priority: providerRolePrioritySchema,
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderCooldownSchema = z
  .object({
    kind: z.string().min(1),
    failureClass: failureClassSchema,
    until: canonicalTimestampSchema,
    resetsAt: canonicalTimestampSchema.nullable(),
    lastResortEligible: z.boolean(),
    scope: z.enum(["provider", "model"]).exactOptional(),
    model: z.string().nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderCheckSchema = z
  .object({
    at: canonicalTimestampSchema,
    ok: z.boolean(),
    failureClass: failureClassSchema,
    detail: z.string().max(2000),
    models: providerModelDiscoverySchema.nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderLastFailureSchema = z
  .object({
    at: canonicalTimestampSchema,
    failureClass: failureClassSchema,
    status: nonNegativeSafeIntSchema.max(999).nullable(),
    model: z.string().nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderHealthSchema = z
  .object({
    cooldown: controlApiProviderCooldownSchema.nullable(),
    modelCooldowns: z
      .record(z.string(), controlApiProviderCooldownSchema)
      .readonly()
      .exactOptional(),
    failureStreak: nonNegativeSafeIntSchema,
    probeFailureStreak: nonNegativeSafeIntSchema,
    inFlightRequests: nonNegativeSafeIntSchema,
    activeAgents: nonNegativeSafeIntSchema,
    attempts: nonNegativeSafeIntSchema,
    successes: nonNegativeSafeIntSchema,
    failures: nonNegativeSafeIntSchema,
    lastSuccessAt: canonicalTimestampSchema.nullable(),
    lastFailure: controlApiProviderLastFailureSchema.nullable(),
    lastCheck: controlApiProviderCheckSchema.nullable()
  })
  .readonly();

export const controlApiProviderCheckResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_CHECK_SCHEMA_ID),
    provider: z.string(),
    check: controlApiProviderCheckSchema,
    health: controlApiProviderHealthSchema.nullable(),
    models: providerModelDiscoverySchema.nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderRoleAssignmentSchema = z
  .object({
    priority: providerRolePrioritySchema,
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable().exactOptional(),
    effectiveReasoningEffort: z.string().nullable().exactOptional(),
    reasoningEffortInForce: z.boolean().exactOptional(),
    supportedReasoningLevels: z.array(z.string()).readonly().exactOptional(),
    mutable: z.boolean(),
    convergence: reconciliationStatusSchema,
    canServe: z.boolean().exactOptional(),
    cannotServeReason: z.string().nullable().exactOptional()
  })
  .readonly();

export const controlApiProviderAgentLimitsSchema = z
  .object({
    perSession: z.number().nullable(),
    acrossSessions: z.number().nullable()
  })
  .readonly();

export const controlApiProviderLinksSchema = z
  .object({
    usage: z.string().nullable(),
    documentation: z.string().nullable()
  })
  .readonly();

export const controlApiProviderCliVersionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("observed"),
      command: z
        .string()
        .refine((value) => value.trim().length > 0),
      version: z
        .string()
        .refine((value) => value.trim().length > 0),
      observedAt: canonicalTimestampSchema
    })
    .readonly(),
  z
    .object({
      status: z.literal("unavailable"),
      kind: z.enum(["not-installed", "not-readable"]),
      command: z
        .string()
        .refine((value) => value.trim().length > 0)
        .nullable(),
      reason: z
        .string()
        .refine((value) => value.trim().length > 0),
      lastAttemptAt: canonicalTimestampSchema.nullable()
    })
    .readonly()
]);

export const controlApiProviderVersionEntrySchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim() === value),
    cli: controlApiProviderCliVersionSchema
  })
  .readonly();

export const controlApiProviderVersionsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_VERSIONS_SCHEMA_ID),
    source: z.literal(CONTROL_API_PROVIDER_VERSIONS_SOURCE),
    providers: z.array(controlApiProviderVersionEntrySchema).readonly()
  })
  .readonly()
  .refine((value) => {
    const seen = new Set<string>();
    for (const entry of value.providers) {
      if (seen.has(entry.provider)) return false;
      seen.add(entry.provider);
    }
    return true;
  });

export const controlApiProviderAgentModelSchema = z
  .object({
    role: z.string(),
    tier: z.string(),
    model: z.string().nullable(),
    tierModel: z.string().nullable()
  })
  .readonly();

export const controlApiProviderRecordSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .refine((value) => value.trim() === value),
    links: controlApiProviderLinksSchema,
    route: z
      .object({
        pattern: z.string(),
        baseUrl: z.string(),
        healthUrl: z.string().nullable()
      })
      .readonly()
      .nullable()
      .exactOptional(),
    credential: z
      .object({
        envKey: z.string().nullable(),
        configured: z.boolean()
      })
      .readonly(),
    disabled: z.boolean(),
    roles: z
      .object({
        orchestrator: controlApiProviderRoleAssignmentSchema,
        subagent: controlApiProviderRoleAssignmentSchema
      })
      .readonly(),
    agentLimits: controlApiProviderAgentLimitsSchema.nullable(),
    agentModels: z.array(controlApiProviderAgentModelSchema).readonly(),
    models: z
      .array(
        z
          .object({
            tier: z.string(),
            model: z.string()
          })
          .readonly()
      )
      .readonly(),
    priorities: z
      .array(
        z
          .object({
            tier: z.string(),
            group: z.number()
          })
          .readonly()
      )
      .readonly(),
    orchestratorReasoningEffort: z.string().nullable(),
    health: controlApiProviderHealthSchema.nullable(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiProvidersResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDERS_SCHEMA_ID),
    orchestratorTier: z.string(),
    quotaAxi: z
      .custom<QuotaAxiResponse>((value) => isRecord(value))
      .nullable(),
    tiers: z
      .array(
        z
          .object({
            tier: z.string(),
            groups: z.array(z.array(z.string()).readonly()).readonly()
          })
          .readonly()
      )
      .readonly(),
    providers: z.array(controlApiProviderRecordSchema).readonly()
  })
  .readonly()
  .refine((value) => {
    const seen = new Set<string>();
    for (const provider of value.providers) {
      if (seen.has(provider.id)) return false;
      seen.add(provider.id);
    }
    return true;
  });

export const controlApiProviderRolePatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_ROLE_PATCH_SCHEMA_ID),
    provider: z.string(),
    role: providerRoleSchema,
    priority: providerRolePrioritySchema,
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable().exactOptional(),
    effectiveReasoningEffort: z.string().nullable().exactOptional(),
    reasoningEffortInForce: z.boolean().exactOptional(),
    supportedReasoningLevels: z.array(z.string()).readonly().exactOptional(),
    previous: providerRoleAssignmentSchema.nullable(),
    actor: z.string(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiProviderEnabledPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_ENABLED_PATCH_SCHEMA_ID),
    provider: z.string(),
    disabled: z.boolean(),
    previous: z.boolean(),
    actor: z.string(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiProviderAgentModelPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_AGENT_MODEL_PATCH_SCHEMA_ID),
    provider: z.string(),
    role: z.string(),
    model: z.string().nullable(),
    previous: z.string().nullable(),
    actor: z.string(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiProviderLimitsPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDER_LIMITS_PATCH_SCHEMA_ID),
    provider: z.string(),
    agentLimits: controlApiProviderAgentLimitsSchema,
    previous: controlApiProviderAgentLimitsSchema.nullable(),
    actor: z.string(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiProvidersResetRequestSchema = z
  .object({
    confirm: z.literal(true)
  })
  .readonly();

export const controlApiProvidersResetResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PROVIDERS_RESET_SCHEMA_ID),
    actor: z.string(),
    cleared: z
      .object({
        roleAssignments: z.number(),
        disabledProviders: z.number(),
        disabledModels: z.number(),
        providerLimits: z.number(),
        agentModels: z.number()
      })
      .readonly(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export type ControlApiProviderCooldown = z.infer<
  typeof controlApiProviderCooldownSchema
>;
export type ControlApiProviderCheck = z.infer<
  typeof controlApiProviderCheckSchema
>;
export type ControlApiProviderHealth = z.infer<
  typeof controlApiProviderHealthSchema
>;
export type ControlApiProviderCheckResponse = z.infer<
  typeof controlApiProviderCheckResponseSchema
>;
export type ControlApiProviderRoleAssignment = z.infer<
  typeof controlApiProviderRoleAssignmentSchema
>;
export type ControlApiProviderAgentLimits = z.infer<
  typeof controlApiProviderAgentLimitsSchema
>;
export type ControlApiProviderLinks = z.infer<
  typeof controlApiProviderLinksSchema
>;
export type ControlApiProviderCliVersion = z.infer<
  typeof controlApiProviderCliVersionSchema
>;
export type ControlApiProviderVersionEntry = z.infer<
  typeof controlApiProviderVersionEntrySchema
>;
export type ControlApiProviderVersionsResponse = z.infer<
  typeof controlApiProviderVersionsResponseSchema
>;
export type ControlApiProviderAgentModel = z.infer<
  typeof controlApiProviderAgentModelSchema
>;
export type ControlApiProviderRecord = z.infer<
  typeof controlApiProviderRecordSchema
>;
export type ControlApiProvidersResponse = z.infer<
  typeof controlApiProvidersResponseSchema
>;
export type ControlApiProviderRolePatchResponse = z.infer<
  typeof controlApiProviderRolePatchResponseSchema
>;
export type ControlApiProviderEnabledPatchResponse = z.infer<
  typeof controlApiProviderEnabledPatchResponseSchema
>;
export type ControlApiProviderAgentModelPatchResponse = z.infer<
  typeof controlApiProviderAgentModelPatchResponseSchema
>;
export type ControlApiProviderLimitsPatchResponse = z.infer<
  typeof controlApiProviderLimitsPatchResponseSchema
>;
export type ControlApiProvidersResetRequest = z.infer<
  typeof controlApiProvidersResetRequestSchema
>;
export type ControlApiProvidersResetResponse = z.infer<
  typeof controlApiProvidersResetResponseSchema
>;
