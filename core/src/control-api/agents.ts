import { z } from "zod";

import type { AgentStatus } from "../agents/types.ts";
import {
  controlApiRevisionSchema,
  convergenceStatusSchema,
  reconciliationViewSchema
} from "./shared.ts";

export const CONTROL_API_AGENTS_SCHEMA_ID =
  "autodev-control-agents-v2" as const;
export const CONTROL_API_AGENT_DETAIL_SCHEMA_ID =
  "autodev-control-agent-detail-v3" as const;
export const CONTROL_API_AGENT_ENABLEMENT_SCHEMA_ID =
  "autodev-control-agent-enablement-v1" as const;

export const agentKindSchema = z.enum(["orchestrator", "leaf"]);

/**
Agent runtime states remain open as a string at the boundary so newly introduced
states render transparently instead of dropping the whole Agents surface.
*/
export const agentStatusSchema = z.custom<AgentStatus>(
  (value) => typeof value === "string"
);

export const agentEnablementStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observed"),
      enabled: z.boolean(),
      mutable: z.literal(true),
      revision: controlApiRevisionSchema
    })
    .readonly(),
  z
    .object({
      kind: z.literal("unavailable"),
      enabled: z.null(),
      mutable: z.literal(false),
      reason: z.string().refine((reason) => reason.trim().length > 0)
    })
    .readonly()
]);

const controlApiAgentRecordShape = {
  id: z.string(),
  role: z.string(),
  kind: agentKindSchema,
  readOnly: z.boolean(),
  configured: z.boolean(),
  valid: z.boolean().nullable(),
  status: agentStatusSchema,
  convergence: convergenceStatusSchema,
  enablement: agentEnablementStateSchema,
  primaryModel: z.string(),
  allowedProviders: z.array(z.string()).readonly(),
  mcps: z.array(z.string()).readonly(),
  skills: z.array(z.string()).readonly()
} as const;

export const controlApiAgentRecordSchema = z
  .object(controlApiAgentRecordShape)
  .readonly();

export const controlApiAgentsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_AGENTS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.literal(false),
    executionContractObserved: z.boolean(),
    totalAgents: z.number().nullable(),
    agents: z
      .array(
        z
          .object({
            ...controlApiAgentRecordShape,
            hasPrompt: z.boolean()
          })
          .readonly()
      )
      .readonly()
  })
  .readonly();

export const controlApiAgentDetailResponseSchema = z
  .object({
    ...controlApiAgentRecordShape,
    schema: z.literal(CONTROL_API_AGENT_DETAIL_SCHEMA_ID),
    promptPath: z.string().nullable(),
    systemPrompt: z.string().nullable(),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export const controlApiAgentEnablementPatchRequestSchema = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.string()
  })
  .readonly();

export const controlApiAgentEnablementPatchResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_AGENT_ENABLEMENT_SCHEMA_ID),
    role: z.string(),
    enabled: z.boolean(),
    previous: z.boolean(),
    revision: controlApiRevisionSchema,
    actor: z.string().min(1),
    reconciliation: reconciliationViewSchema
  })
  .readonly();

export type ControlApiAgentRecord = z.infer<typeof controlApiAgentRecordSchema>;
export type ControlApiAgentsResponse = z.infer<
  typeof controlApiAgentsResponseSchema
>;
export type ControlApiAgentDetailResponse = z.infer<
  typeof controlApiAgentDetailResponseSchema
>;
export type ControlApiAgentEnablementPatchRequest = z.infer<
  typeof controlApiAgentEnablementPatchRequestSchema
>;
export type ControlApiAgentEnablementPatchResponse = z.infer<
  typeof controlApiAgentEnablementPatchResponseSchema
>;
