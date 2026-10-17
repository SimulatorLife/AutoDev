/** Runtime parser for the Core-owned versioned Playtesting launch request. */
import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestLaunchRequest,
  PLAYTESTS_MAX_BATCH_ASSIGNMENTS
} from "@simulatorlife/autodev-core";
import { z } from "zod/v4";

const workspaceIdSchema = z.string().regex(/^[^/\\\s]+\/[^/\\\s]+$/u);
const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const idSchema = z.string().min(1).max(256);
const batchAssignmentSchema = z.strictObject({
  scenario: z.string().min(1).max(256),
  policy: z.string().min(1).max(256),
  seed: z.string().min(1).max(256),
  goal: z.string().max(1000).optional(),
  maxSteps: z.number().int().min(1).max(100_000).optional()
});
const visualLimitsSchema = z.strictObject({
  episodeCount: z.number().int().min(1).max(1000),
  maxStepsPerEpisode: z.number().int().min(1).max(10_000),
  wallTimeMs: z.number().int().min(1000).max(3_600_000),
  smartRequestsPerEpisode: z.number().int().min(0).max(1000),
  smartTokensPerEpisode: z.number().int().min(0).max(1_000_000),
  screenshotCountPerEpisode: z.number().int().min(1).max(2000),
  artifactBytesPerEpisode: z.number().int().min(1024).max(1_073_741_824)
});

export const playtestBranchLaunchRequestSchema = z.strictObject({
  schema: z.literal(PLAYTEST_LAUNCH_REQUEST_SCHEMA),
  mode: z.literal("adapter-accelerated"),
  workspaceId: workspaceIdSchema,
  requestId: requestIdSchema,
  capabilityRevision: z.string().regex(/^[a-f\d]{64}$/u),
  operation: z.strictObject({
    kind: z.literal("branch"),
    parentEpisodeId: idSchema,
    branchStep: z.number().int().min(0).max(99_999),
    alternativeActionId: idSchema,
    policy: z.string().min(1).max(256).optional(),
    maxSteps: z.number().int().min(1).max(100_000).optional()
  })
});

const adapterLaunchRequestSchema = z.strictObject({
  schema: z.literal(PLAYTEST_LAUNCH_REQUEST_SCHEMA),
  mode: z.literal("adapter-accelerated"),
  workspaceId: workspaceIdSchema,
  requestId: requestIdSchema,
  capabilityRevision: z.string().regex(/^[a-f\d]{64}$/u),
  operation: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("batch"),
      assignments: z
        .array(batchAssignmentSchema)
        .min(1)
        .max(PLAYTESTS_MAX_BATCH_ASSIGNMENTS)
    }),
    playtestBranchLaunchRequestSchema.shape.operation
  ])
});

export const playtestLaunchRequestSchema = z.discriminatedUnion("mode", [
  adapterLaunchRequestSchema,
  z.strictObject({
    schema: z.literal(PLAYTEST_LAUNCH_REQUEST_SCHEMA),
    mode: z.literal("autonomous-visual"),
    workspaceId: workspaceIdSchema,
    requestId: requestIdSchema,
    capabilityRevision: z.string().regex(/^[a-f\d]{64}$/u),
    targetId: z.string().min(1).max(128),
    policyId: z.literal("smart-direct"),
    areasOfFocus: z.string().max(2000).nullable(),
    limits: visualLimitsSchema
  }),
  z.strictObject({
    schema: z.literal(PLAYTEST_LAUNCH_REQUEST_SCHEMA),
    mode: z.literal("scripted-regression"),
    workspaceId: workspaceIdSchema,
    requestId: requestIdSchema,
    capabilityRevision: z.string().regex(/^[a-f\d]{64}$/u),
    recipeId: z.string().min(1).max(256),
    maxSteps: z.number().int().min(1).max(100_000),
    wallTimeMs: z.number().int().min(1000).max(3_600_000)
  })
]) satisfies z.ZodType<PlaytestLaunchRequest>;
