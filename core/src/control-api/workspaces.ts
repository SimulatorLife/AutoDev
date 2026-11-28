import { z } from "zod";

import type { AgentRole } from "../agents/types.ts";
import {
  assertWorkspacePlaytestApproval,
  type WorkspacePlaytestApproval
} from "../workspaces/playtesting.ts";
import {
  assertWorkspaceVisualPlaytestTargetApproval,
  type WorkspaceVisualPlaytestTargetApproval
} from "../workspaces/visual-playtesting.ts";
import { reconciliationDiffSchema, reconciliationViewSchema } from "./shared.ts";

export const CONTROL_API_WORKSPACES_SCHEMA_ID =
  "autodev-control-workspaces-v3" as const;
export const CONTROL_API_WORKSPACE_PATCH_SCHEMA_ID =
  "autodev-control-workspace-patch-v2" as const;
export const CONTROL_API_WORKSPACE_PLAYTEST_APPROVAL_SCHEMA_ID =
  "autodev-control-workspace-playtest-approval-v1" as const;
export const CONTROL_API_WORKSPACE_VISUAL_PLAYTEST_TARGETS_SCHEMA_ID =
  "autodev-control-workspace-visual-playtest-targets-v1" as const;

const agentRoleSchema = z.custom<AgentRole>((value) => typeof value === "string");

export const workspaceCatalogStatusSchema = z.enum([
  "valid",
  "invalid",
  "unavailable"
]);

export const workspaceConfigurationHealthSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("configured")
    })
    .readonly(),
  z
    .object({
      status: z.literal("invalid-role-scope"),
      unknownRoles: z.array(z.string()).readonly()
    })
    .readonly()
]);

export const workspaceRuntimeAvailabilitySchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("not-observed")
    })
    .readonly(),
  z
    .object({
      status: z.literal("observed"),
      liveAgents: z.number().int().min(0)
    })
    .readonly()
]);

export const controlApiWorkspaceRecordSchema = z
  .object({
    id: z.string(),
    baseBranch: z.string(),
    enabled: z.boolean(),
    agentRoles: z.array(agentRoleSchema).readonly().nullable(),
    configuration: workspaceConfigurationHealthSchema,
    runtime: workspaceRuntimeAvailabilitySchema
  })
  .readonly();

export const controlApiWorkspacesResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_WORKSPACES_SCHEMA_ID),
    source: z.string(),
    readOnly: z.boolean(),
    catalogStatus: workspaceCatalogStatusSchema,
    revision: z.string().nullable(),
    totalWorkspaces: z.number().nullable(),
    workspaces: z.array(controlApiWorkspaceRecordSchema).readonly(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiWorkspacePatchRequestSchema = z
  .object({
    expectedRevision: z.string(),
    enabled: z.boolean().optional(),
    baseBranch: z.string().optional(),
    agentRoles: z.array(z.string()).readonly().nullable().optional()
  })
  .readonly();

export const controlApiWorkspacePatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_WORKSPACE_PATCH_SCHEMA_ID),
    id: z.string(),
    revision: z.string(),
    changed: z.boolean(),
    workspace: controlApiWorkspaceRecordSchema,
    reconciliation: reconciliationViewSchema,
    diff: reconciliationDiffSchema
  })
  .readonly();

const workspacePlaytestApprovalSchema = z.custom<WorkspacePlaytestApproval>(
  (value) => {
    try {
      assertWorkspacePlaytestApproval(value);
      return true;
    } catch {
      return false;
    }
  }
);

const workspaceVisualPlaytestTargetApprovalSchema =
  z.custom<WorkspaceVisualPlaytestTargetApproval>((value) => {
    try {
      assertWorkspaceVisualPlaytestTargetApproval(value);
      return true;
    } catch {
      return false;
    }
  });

export const controlApiWorkspacePlaytestApprovalResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_WORKSPACE_PLAYTEST_APPROVAL_SCHEMA_ID),
    workspaceId: z.string(),
    workspaceEnabled: z.boolean(),
    approval: workspacePlaytestApprovalSchema.nullable()
  })
  .readonly()
  .refine(
    (value) =>
      value.approval === null || value.approval.workspaceId === value.workspaceId
  );

export const controlApiWorkspaceVisualPlaytestTargetsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_WORKSPACE_VISUAL_PLAYTEST_TARGETS_SCHEMA_ID),
    workspaceId: z.string(),
    workspaceEnabled: z.boolean(),
    targets: z.array(workspaceVisualPlaytestTargetApprovalSchema).readonly()
  })
  .readonly()
  .refine((value) =>
    value.targets.every((target) => target.workspaceId === value.workspaceId)
  );

export type ControlApiWorkspaceRecord = z.infer<
  typeof controlApiWorkspaceRecordSchema
>;
export type ControlApiWorkspacesResponse = z.infer<
  typeof controlApiWorkspacesResponseSchema
>;
export type ControlApiWorkspacePatchRequest = z.infer<
  typeof controlApiWorkspacePatchRequestSchema
>;
export type ControlApiWorkspacePatchResponse = z.infer<
  typeof controlApiWorkspacePatchResponseSchema
>;
export type ControlApiWorkspacePlaytestApprovalResponse = z.infer<
  typeof controlApiWorkspacePlaytestApprovalResponseSchema
>;
export type ControlApiWorkspaceVisualPlaytestTargetsResponse = z.infer<
  typeof controlApiWorkspaceVisualPlaytestTargetsResponseSchema
>;
