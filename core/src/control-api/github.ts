/**
The Control API GitHub contract, as one schema.

The Runtime produces this response and the Console reads it. The Console used
to spell the contract with hand-written guards beside a hand-written
interface, and the guards checked less than the interface promised: a
workflow row's observed Actions fields and every recent run reached the view
unchecked. One schema, owned here, is now the only statement of it -- the
producer names its schema id, the reader validates against it, and the types
are read out of it.
*/
import { z } from "zod";

/**
The contract revision the Runtime and the Console must agree on.
*/
export const CONTROL_API_GITHUB_SCHEMA_ID =
  "autodev-control-github-v1" as const;

/**
Aggregated statistics computed strictly over the returned bounded/time-filtered
recent run sample.

Every count is required, and the rate is null rather than absent when no run
completed: the view does `Math.round(stats.successRate * 100)`, so a missing
rate would render `NaN%`, and a missing count draws an empty stat card. A
drifted projection fails closed instead of publishing arithmetic on
`undefined`.
*/
export const controlApiGithubRunStatsSchema = z
  .object({
    totalRuns: z.number(),
    successfulRuns: z.number(),
    failedRuns: z.number(),
    inProgressRuns: z.number(),
    cancelledRuns: z.number(),
    successRate: z.number().nullable()
  })
  .readonly();

/**
One workflow definition row, with its optional observed Actions state.

The catalog column and the scheduled count are both derived from `events`
and `schedules`, so a row without them is not a row the view can render --
`workflows.filter((w) => w.schedules.length > 0)` would throw rather than
fail closed.
*/
export const controlApiGithubWorkflowRowSchema = z
  .object({
    /**
    Stable identifier: the workflow file name, e.g. "_scheduler.yml".
    */
    id: z.string(),
    /**
    Declared `name:` field; null when the workflow has no explicit name.
    */
    name: z.string().nullable(),
    /**
    Repository-relative path, e.g. ".github/workflows/_scheduler.yml".
    */
    path: z.string(),
    /**
    Sorted, de-duplicated trigger event keys observed under `on:`.
    */
    events: z.array(z.string()).readonly(),
    /**
    Sorted, de-duplicated cron expressions observed under `on.schedule`.
    */
    schedules: z.array(z.string()).readonly(),
    /**
    Observed GitHub Actions workflow state; "unavailable" when runtime facts
    could not be loaded.
    */
    actionsState: z
      .enum([
        "active",
        "disabled_manually",
        "disabled_inactivity",
        "deleted",
        "unknown",
        "unavailable"
      ])
      .exactOptional(),
    actionsWorkflowId: z.number().nullable().exactOptional(),
    actionsHtmlUrl: z.string().nullable().exactOptional(),
    recentRunsCount: z.number().nullable().exactOptional(),
    lastRunStatus: z.string().nullable().exactOptional(),
    lastRunConclusion: z.string().nullable().exactOptional(),
    lastRunCreatedAt: z.string().nullable().exactOptional(),
    lastRunHtmlUrl: z.string().nullable().exactOptional()
  })
  .readonly();

/**
One observed GitHub Actions workflow run from the bounded recent sample.
*/
export const controlApiGithubWorkflowRunSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable(),
    workflowId: z.number(),
    workflowPath: z.string(),
    headBranch: z.string().nullable(),
    headSha: z.string(),
    event: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    htmlUrl: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runAttempt: z.number()
  })
  .readonly();

/**
The whole response.

GitHub's page is explicitly about unobserved state: a catalog that cannot be
read reports that through `catalogStatus` rather than presenting an empty
workflow list as "this repository has no workflows".
*/
export const controlApiGithubResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_GITHUB_SCHEMA_ID),
    source: z.string(),
    readOnly: z.boolean(),
    catalogStatus: z.enum(["valid", "invalid", "unavailable"]),
    totalWorkflows: z.number().nullable(),
    workflows: z.array(controlApiGithubWorkflowRowSchema).readonly(),
    runtimeFactsAvailable: z.boolean(),
    runtimeStatus: z.enum(["available", "unavailable", "invalid"]),
    runtimeMessage: z.string().nullable(),
    repository: z.string().nullable(),
    stats: controlApiGithubRunStatsSchema.nullable(),
    /**
    The runs the Actions API returned for the workflows on this page.

    Null when the Actions read did not happen -- the token was missing, the
    repository was not trusted, the request ran out of its deadline. An empty
    list there would say the workflows have never run, which is a claim about
    the repository rather than about this read, and `runtimeFactsAvailable`
    already says the read did not happen.

    An empty list beside an available read is a measured zero and stays a
    list: the workflows were asked and none had run.
    */
    recentRuns: z.array(controlApiGithubWorkflowRunSchema).readonly().nullable()
  })
  .readonly();

export type ControlApiGithubRunStats = z.infer<
  typeof controlApiGithubRunStatsSchema
>;
export type ControlApiGithubWorkflowRow = z.infer<
  typeof controlApiGithubWorkflowRowSchema
>;
export type ControlApiGithubWorkflowRun = z.infer<
  typeof controlApiGithubWorkflowRunSchema
>;
export type ControlApiGithubResponse = z.infer<
  typeof controlApiGithubResponseSchema
>;
