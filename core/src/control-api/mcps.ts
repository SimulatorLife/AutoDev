import { z } from "zod";

import type { AgentRole } from "../agents/types.ts";
import {
  controlApiRevisionSchema,
  reconciliationViewSchema,
  ruleSyncValidationIssueListSchema
} from "./shared.ts";

export const CONTROL_API_MCPS_SCHEMA_ID = "autodev-control-mcps-v3" as const;
export const CONTROL_API_MCPS_SOURCE = ".rulesync/mcp.jsonc" as const;
export const CONTROL_API_MCP_RUNTIME_SCHEMA_ID =
  "autodev-control-mcp-runtime-v1" as const;
export const CONTROL_API_MCP_APPLIED_SCHEMA_ID =
  "autodev-control-mcp-applied-v3" as const;
export const CONTROL_API_MCP_SERVER_PATCH_SCHEMA_ID =
  "autodev-control-mcp-server-patch-v2" as const;
export const CHATGPT_TUNNEL_SCHEMA_ID = "autodev-chatgpt-tunnel-v2" as const;

const finiteNumberSchema = z.number().refine(Number.isFinite);
const agentRoleSchema = z.custom<AgentRole>(
  (value) => typeof value === "string"
);

export const mcpTargetOverrideSchema = z
  .object({
    target: z.string(),
    enabled: z.boolean(),
    defaultToolsApprovalMode: z.string().exactOptional(),
    enabledTools: z.array(z.string()).readonly().exactOptional()
  })
  .readonly();

export const mcpApprovedCatalogueSchema = z
  .object({
    home: z.string(),
    state: z.enum(["approved", "pending", "unavailable", "unknown"]),
    approvedDigest: z.string().nullable(),
    proposedDigest: z.string().nullable(),
    approvedPath: z.string()
  })
  .readonly();

export const mcpServerTransportSchema = z.enum(["stdio", "http", "unknown"]);

export const controlApiMcpServerRowSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean().nullable(),
    transport: mcpServerTransportSchema,
    targetOverrides: z.array(mcpTargetOverrideSchema).readonly(),
    command: z.string().exactOptional(),
    args: z.array(z.string()).readonly().exactOptional(),
    url: z.string().exactOptional(),
    envKeys: z.array(z.string()).readonly().exactOptional(),
    cwd: z.string().exactOptional(),
    defaultToolsApprovalMode: z.string().exactOptional(),
    declared: z.boolean(),
    roles: z.array(agentRoleSchema).readonly(),
    approvedCatalogues: z
      .array(mcpApprovedCatalogueSchema)
      .readonly()
      .optional()
  })
  .readonly();

const mcpGatewayGrantsSchema = z.record(z.string(), z.array(z.string()));

export const controlApiMcpGatewaySurfaceSchema = z
  .object({
    role: z.string(),
    url: z.string()
  })
  .readonly();

export const controlApiMcpGatewaySchema = z
  .object({
    label: z.string(),
    installed: z.boolean(),
    ready: z.boolean(),
    port: z.number().nullable(),
    readinessUrl: z.string().nullable(),
    generation: z.string().nullable(),
    workspace: z.string().nullable(),
    role: z.string(),
    roles: z.array(z.string()).readonly(),
    surfaces: z.array(controlApiMcpGatewaySurfaceSchema).readonly(),
    reviewed: mcpGatewayGrantsSchema,
    grants: mcpGatewayGrantsSchema,
    error: z.string().nullable()
  })
  .readonly();

export const controlApiMcpsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MCPS_SCHEMA_ID),
    source: z.literal(CONTROL_API_MCPS_SOURCE),
    revision: z.string().nullable(),
    readOnly: z.boolean(),
    valid: z.boolean().nullable(),
    issues: ruleSyncValidationIssueListSchema,
    servers: z.array(controlApiMcpServerRowSchema).readonly(),
    gateway: controlApiMcpGatewaySchema
  })
  .readonly();

export const controlApiMcpRuntimeHealthSchema = z.enum([
  "configured",
  "ready",
  "error",
  "observed",
  "stale"
]);

const controlApiMcpRuntimeEvidenceShape = {
  health: controlApiMcpRuntimeHealthSchema,
  lastSeenAt: z.string().nullable(),
  lastStatus: z.string(),
  initAttempts: z.number().nullable(),
  toolDiscoveryAttempts: z.number().nullable(),
  failures: finiteNumberSchema,
  toolCalls: finiteNumberSchema,
  averageDurationMs: finiteNumberSchema,
  roles: z
    .array(
      z
        .object({
          role: z.string(),
          health: controlApiMcpRuntimeHealthSchema,
          lastSeenAt: z.string().nullable(),
          lastStatus: z.string()
        })
        .readonly()
    )
    .readonly(),
  tools: z
    .array(
      z
        .object({
          name: z.string(),
          count: finiteNumberSchema,
          errors: finiteNumberSchema
        })
        .readonly()
    )
    .readonly()
} as const;

export const controlApiMcpRuntimeEvidenceSchema = z
  .object(controlApiMcpRuntimeEvidenceShape)
  .readonly();

export const controlApiMcpRuntimeServerSchema = z
  .object({
    ...controlApiMcpRuntimeEvidenceShape,
    name: z.string()
  })
  .readonly();

export const controlApiMcpRuntimeHealthCountsSchema = z
  .object({
    ready: finiteNumberSchema,
    error: finiteNumberSchema,
    stale: finiteNumberSchema,
    configured: finiteNumberSchema,
    observed: finiteNumberSchema
  })
  .readonly();

export const controlApiMcpRuntimeResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MCP_RUNTIME_SCHEMA_ID),
    source: z.string(),
    observedServers: z.number().nullable(),
    health: controlApiMcpRuntimeHealthCountsSchema.nullable(),
    servers: z.array(controlApiMcpRuntimeServerSchema).readonly()
  })
  .readonly();

const controlApiMcpLaunchShape = {
  name: z.string(),
  command: z.string().nullable(),
  args: z.array(z.string()).readonly(),
  cwd: z.string().nullable(),
  url: z.string().nullable(),
  bearerTokenEnvVar: z.string().nullable(),
  httpHeaderNames: z.array(z.string()).readonly()
} as const;

export const controlApiMcpAppliedServerSchema = z
  .object(controlApiMcpLaunchShape)
  .readonly();

export const controlApiMcpDeclaredServerSchema = z
  .object(controlApiMcpLaunchShape)
  .readonly();

export const controlApiMcpAppliedResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MCP_APPLIED_SCHEMA_ID),
    source: z.string(),
    declarationSource: z.literal(CONTROL_API_MCPS_SOURCE),
    target: z.string(),
    available: z.boolean(),
    declaredServers: z.array(controlApiMcpDeclaredServerSchema).readonly(),
    servers: z.array(controlApiMcpAppliedServerSchema).readonly(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

const optionalNullableStringSchema = z.string().nullable().exactOptional();
const optionalNullableStringArraySchema = z
  .array(z.string())
  .readonly()
  .nullable()
  .exactOptional();
const optionalNullableHeaderMapSchema = z
  .record(z.string(), z.string())
  .readonly()
  .nullable()
  .exactOptional();

const controlApiMcpServerPatchLaunchSchema = z
  .object({
    command: optionalNullableStringSchema,
    args: optionalNullableStringArraySchema,
    cwd: optionalNullableStringSchema,
    url: optionalNullableStringSchema,
    bearerTokenEnvVar: optionalNullableStringSchema,
    httpHeaders: optionalNullableHeaderMapSchema
  })
  .readonly();

export const controlApiMcpServerPatchRequestSchema = z
  .object({
    expectedRevision: z.string(),
    launch: controlApiMcpServerPatchLaunchSchema
  })
  .readonly();

export const controlApiMcpServerPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_MCP_SERVER_PATCH_SCHEMA_ID),
    name: z.string(),
    target: z.string(),
    revision: z.string(),
    changed: z.boolean(),
    launch: controlApiMcpDeclaredServerSchema,
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const chatgptTunnelStatusSchema = z
  .object({
    schema: z.literal(CHATGPT_TUNNEL_SCHEMA_ID),
    revision: controlApiRevisionSchema,
    configured: z.boolean(),
    enabled: z.boolean(),
    ready: z.boolean(),
    roles: z.array(z.string()).readonly(),
    tunnelId: z.string().nullable()
  })
  .readonly();

export type ControlApiMcpGatewaySurface = z.infer<
  typeof controlApiMcpGatewaySurfaceSchema
>;
export type ControlApiMcpGateway = z.infer<typeof controlApiMcpGatewaySchema>;
export type ControlApiMcpsResponse = z.infer<
  typeof controlApiMcpsResponseSchema
>;
export type ControlApiMcpRuntimeHealth = z.infer<
  typeof controlApiMcpRuntimeHealthSchema
>;
export type ControlApiMcpRuntimeEvidence = z.infer<
  typeof controlApiMcpRuntimeEvidenceSchema
>;
export type ControlApiMcpRuntimeServer = z.infer<
  typeof controlApiMcpRuntimeServerSchema
>;
export type ControlApiMcpRuntimeHealthCounts = z.infer<
  typeof controlApiMcpRuntimeHealthCountsSchema
>;
export type ControlApiMcpRuntimeResponse = z.infer<
  typeof controlApiMcpRuntimeResponseSchema
>;
export type ControlApiMcpAppliedServer = z.infer<
  typeof controlApiMcpAppliedServerSchema
>;
export type ControlApiMcpDeclaredServer = z.infer<
  typeof controlApiMcpDeclaredServerSchema
>;
export type ControlApiMcpAppliedResponse = z.infer<
  typeof controlApiMcpAppliedResponseSchema
>;
export type ControlApiMcpServerPatchRequest = z.infer<
  typeof controlApiMcpServerPatchRequestSchema
>;
export type ControlApiMcpServerPatchResponse = z.infer<
  typeof controlApiMcpServerPatchResponseSchema
>;
