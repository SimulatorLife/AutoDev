import { z } from "zod";

import { CLIENT_SURFACES } from "../diagnostics/client-surface.ts";
import type { RoutingPolicyState } from "../routing/types.ts";
import { safeAutoDevSessionId as safeSessionId } from "../usage/session-id.ts";
import {
  controlApiProviderAgentLimitsSchema,
  providerRoleAssignmentSchema
} from "./providers.ts";
import { reconciliationViewSchema } from "./shared.ts";

/**
Maximum number of source-confirmed live session identities returned by Runtime.
*/
export const CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT = 100;

export const CONTROL_API_CONCURRENCY_SCHEMA_ID =
  "autodev-control-concurrency-v2" as const;
export const CONTROL_API_ROUTING_SCHEMA_ID =
  "autodev-control-routing-v1" as const;
export const CONTROL_API_RUNTIME_SCHEMA_ID =
  "autodev-control-runtime-v3" as const;

export const routerLifecycleStateSchema = z.enum(["ready", "draining"]);

export const concurrencyLimitSourceSchema = z.enum([
  "stored_override",
  "config_file",
  "default"
]);

export const concurrencyConfigFileSourceSchema = z.enum([
  "default_codex_home",
  "env_override"
]);

const finiteNumberSchema = z.number().refine(Number.isFinite);
const nonNegativeIntSchema = z.number().int().min(0);
const safeNonNegativeIntSchema = z
  .number()
  .int()
  .min(0)
  .refine(Number.isSafeInteger);

export const controlApiConcurrencyLastDenialSchema = z
  .looseObject({
    requestId: z.string().exactOptional(),
    role: z.string().exactOptional(),
    requestedModel: z.string().exactOptional(),
    reason: z.string().exactOptional(),
    timestamp: z.string().exactOptional()
  })
  .readonly();

export const controlApiConcurrencyStatusSchema = z
  .object({
    scope: z.string().exactOptional(),
    configSource: concurrencyLimitSourceSchema.exactOptional(),
    configFileSource: concurrencyConfigFileSourceSchema.exactOptional(),
    configFileExists: z.boolean().exactOptional(),
    maxConcurrentThreadsPerSession: z.number().nullable().exactOptional(),
    effectivePerSessionLimit: z.number().nullable().exactOptional(),
    activeSubagentThreads: z.number().exactOptional(),
    activeSessions: z.number().exactOptional(),
    denials: z.number().exactOptional(),
    denialsByReason: z
      .record(z.string(), z.number())
      .readonly()
      .exactOptional(),
    lastDenial: controlApiConcurrencyLastDenialSchema
      .nullable()
      .exactOptional(),
    revision: z.number().int().min(1).exactOptional()
  })
  .readonly();

export const controlApiConcurrencyPatchRequestSchema = z
  .object({
    maxConcurrentThreadsPerSession: z.number().nullable().exactOptional(),
    resetToConfigFile: z.boolean().exactOptional(),
    revision: z.number().exactOptional()
  })
  .readonly();

export const controlApiConcurrencyPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_CONCURRENCY_SCHEMA_ID),
    concurrency: controlApiConcurrencyStatusSchema,
    reconciliation: reconciliationViewSchema
  })
  .readonly();

const countMapSchema = z.record(z.string(), nonNegativeIntSchema).readonly();
const roleCountMapSchema = z.record(z.string(), countMapSchema).readonly();

export const controlApiLiveAgentCountsSchema = z
  .object({
    count: nonNegativeIntSchema,
    byRole: countMapSchema,
    byProvider: countMapSchema,
    byModel: countMapSchema,
    byWorkspace: countMapSchema,
    byProviderRole: roleCountMapSchema,
    byModelRole: roleCountMapSchema,
    missingProvider: nonNegativeIntSchema,
    missingModel: nonNegativeIntSchema
  })
  .readonly();

export const controlApiLiveSessionStateSchema = z.enum([
  "active",
  "tool_wait",
  "user_wait",
  "subagent_wait",
  "resumed"
]);

export const clientSurfaceSchema = z.enum(CLIENT_SURFACES);

export const controlApiLiveSessionIdentitySchema = z
  .strictObject({
    sessionId: z
      .string()
      .refine((sessionId) => safeSessionId(sessionId) === sessionId),
    state: controlApiLiveSessionStateSchema,
    lastActivityAt: safeNonNegativeIntSchema.refine((timestamp) =>
      Number.isFinite(new Date(timestamp).getTime())
    ),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    role: z.string().min(1).nullable(),
    clientSurface: clientSurfaceSchema.nullable()
  })
  .readonly();

export const controlApiLiveSessionsSchema = z
  .strictObject({
    identitiesObserved: z
      .array(controlApiLiveSessionIdentitySchema)
      .max(CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT)
      .readonly(),
    identifiedSessionCount: safeNonNegativeIntSchema,
    partial: z.boolean(),
    unattributedLiveActivityCount: safeNonNegativeIntSchema
  })
  .readonly()
  .refine((value) => {
    const count = value.identitiesObserved.length;
    if (value.identifiedSessionCount < count) return false;
    if (
      value.partial &&
      (count !== CONTROL_API_LIVE_SESSION_IDENTITY_LIMIT ||
        value.identifiedSessionCount <= count)
    ) {
      return false;
    }
    if (!value.partial && value.identifiedSessionCount !== count) {
      return false;
    }
    let previousSessionId: string | null = null;
    for (const candidate of value.identitiesObserved) {
      if (
        previousSessionId !== null &&
        candidate.sessionId <= previousSessionId
      ) {
        return false;
      }
      previousSessionId = candidate.sessionId;
    }
    return true;
  });

export const controlApiRuntimeResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_RUNTIME_SCHEMA_ID),
    routerInstanceId: z.string(),
    lifecycle: z
      .object({
        state: routerLifecycleStateSchema,
        draining: z.boolean(),
        changedAt: z.string(),
        activeResponseRequests: finiteNumberSchema
      })
      .readonly(),
    concurrency: controlApiConcurrencyStatusSchema,
    inFlightRequestCount: finiteNumberSchema,
    liveAgents: controlApiLiveAgentCountsSchema.nullable(),
    liveSessions: controlApiLiveSessionsSchema.nullable()
  })
  .readonly();

const roleAssignmentByRoleSchema = z
  .object({
    orchestrator: providerRoleAssignmentSchema.exactOptional(),
    subagent: providerRoleAssignmentSchema.exactOptional()
  })
  .readonly();

const agentModelMapSchema = z.record(z.string(), z.string()).readonly();
const stringListSchema = z.array(z.string()).readonly();

const routingPolicyStateSchema: z.ZodType<RoutingPolicyState> = z
  .object({
    roleAssignments: z
      .record(z.string(), roleAssignmentByRoleSchema)
      .readonly(),
    disabledProviders: stringListSchema,
    disabledModels: stringListSchema,
    disabledAgentRoles: stringListSchema,
    agentEnablementRevisions: z.record(z.string(), z.number()).readonly(),
    providerLimits: z
      .record(z.string(), controlApiProviderAgentLimitsSchema)
      .readonly(),
    agentModels: z.record(z.string(), agentModelMapSchema).readonly()
  })
  .readonly();

const routeDefinitionSchema = z
  .object({
    provider: z.string(),
    pattern: z.string(),
    baseUrl: z.string()
  })
  .readonly();

const cooldownMapSchema = z.record(z.string(), z.unknown()).readonly();

export const controlApiRoutingResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_ROUTING_SCHEMA_ID),
    runtime: routingPolicyStateSchema,
    routes: z.array(routeDefinitionSchema).readonly(),
    cooldowns: cooldownMapSchema,
    concurrency: controlApiConcurrencyStatusSchema.exactOptional()
  })
  .readonly();

export type ControlApiRoutingResponse = z.infer<
  typeof controlApiRoutingResponseSchema
>;

export type ControlApiConcurrencyLimitSource = z.infer<
  typeof concurrencyLimitSourceSchema
>;
export type ControlApiConcurrencyConfigFileSource = z.infer<
  typeof concurrencyConfigFileSourceSchema
>;
export type ControlApiConcurrencyStatus = z.infer<
  typeof controlApiConcurrencyStatusSchema
>;
export type ControlApiConcurrencyPatchRequest = z.infer<
  typeof controlApiConcurrencyPatchRequestSchema
>;
export type ControlApiConcurrencyPatchResponse = z.infer<
  typeof controlApiConcurrencyPatchResponseSchema
>;
export type ControlApiLiveAgentCounts = z.infer<
  typeof controlApiLiveAgentCountsSchema
>;
export type ControlApiLiveSessionState = z.infer<
  typeof controlApiLiveSessionStateSchema
>;
export type ControlApiLiveSessionIdentity = z.infer<
  typeof controlApiLiveSessionIdentitySchema
>;
export type ControlApiLiveSessions = z.infer<
  typeof controlApiLiveSessionsSchema
>;
export type ControlApiRuntimeResponse = z.infer<
  typeof controlApiRuntimeResponseSchema
>;
