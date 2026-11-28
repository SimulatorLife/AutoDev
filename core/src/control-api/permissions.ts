import { z } from "zod";

import { APPROVAL_POLICIES } from "../permissions/types.ts";

export const CONTROL_API_PERMISSIONS_SCHEMA_ID =
  "autodev-control-permissions-v2" as const;

export const approvalPolicySchema = z.enum(APPROVAL_POLICIES);

export const controlApiPermissionPolicySchema = z
  .object({
    approvalPolicy: approvalPolicySchema,
    approvalsReviewer: z.string(),
    webSearch: z.boolean()
  })
  .readonly();

export const controlApiRolePermissionsEntrySchema = z
  .object({
    readOnly: z.boolean(),
    mcp: z.array(z.string()).readonly(),
    mcpTools: z.record(z.string(), z.array(z.string()).readonly()).readonly(),
    skills: z.array(z.string()).readonly()
  })
  .readonly();

export const controlApiPermissionsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_PERMISSIONS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(true),
    executionContractObserved: z.boolean(),
    revision: z.string().nullable(),
    sourceText: z.string().nullable(),
    policy: controlApiPermissionPolicySchema.nullable(),
    policyStatus: z.enum(["valid", "invalid", "unavailable"]),
    policyReason: z.string().nullable(),
    applied: controlApiPermissionPolicySchema.nullable(),
    appliedSource: z.string(),
    rolePermissions: z
      .record(z.string(), controlApiRolePermissionsEntrySchema)
      .readonly()
  })
  .readonly();

export type ControlApiPermissionPolicy = z.infer<
  typeof controlApiPermissionPolicySchema
>;
export type ControlApiPermissionsResponse = z.infer<
  typeof controlApiPermissionsResponseSchema
>;
