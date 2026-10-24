import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

import { statCard } from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const REPOSITORY = "SimulatorLife/AutoDev";
/** The state a workflow whose runtime facts were never read carries. */
const UNAVAILABLE = "Unavailable";
/** The heading and the card that count the runs the API returned. */
const RECENT_RUNS = "Recent Workflow Runs";
/**
 * The words a GitHub mutation control would carry.
 *
 * Dispatch, cancel, rerun and schedule are the four controls the target
 * state leaves unimplemented, so a control named after one of them is a
 * control the Console must not offer. The words are whole words: a workflow
 * named "Scheduler" is a schedule trigger, not a schedule control.
 */
const MUTATION_CONTROL = /\b(dispatch|cancel|rerun|schedule)\b/iu;
/** The page's sentence about the runtime state it could not read. */
const REQUIRES_THE_ACTIONS_API = /require the GitHub Actions API/iu;
/** The runtime message the fixture reports when it cannot reach the API. */
const RUNTIME_UNREACHABLE =
  /could not be reached for the configured repository\./u;
/** The page's sentence about the controls it does not offer. */
const NO_MUTATION_CONTROLS = /mutation controls remain unimplemented/iu;

/**
 * The page's own body, which owns the state marker.
 */
function githubBody(page: Page): Locator {
  return page.locator('[data-feature="github"]');
}

/**
 * The table under one of the page's section headings.
 *
 * The page carries two tables -- the workflow definitions and the recent
 * runs -- and they are told apart by the heading above them, which is what an
 * operator reads them by.
 */
function tableUnder(page: Page, heading: string): Locator {
  return page
    .getByRole("heading", { name: heading, exact: true })
    .locator("xpath=following::table[1]");
}

/**
 * Whether the fixture can read the GitHub Actions runtime state.
 *
 * The runtime state comes from the GitHub Actions API and the definitions
 * come from the repository's YAML, so the two can be read apart. The fixture's
 * toggle takes the runtime state away, because a page that has only ever
 * rendered observed facts cannot show that it refuses to invent them.
 */
async function setGithubRuntimeState(
  request: APIRequestContext,
  state: "observed" | "unavailable"
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/github/state?state=${state}`
  );
  expect(response.ok()).toBe(true);
}

test("the page shows the workflow definitions and the triggers they declare", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/github");
  await expect(githubBody(page)).toBeVisible();

  const definitions = tableUnder(page, "Workflow Definitions");
  await expect(definitions.locator("tbody tr")).toHaveCount(4);

  // The definition facts: the declared name, the path, the trigger events
  // and the cron schedule.
  await expect(definitions).toContainText("Scheduler");
  await expect(definitions).toContainText(".github/workflows/_scheduler.yml");
  await expect(
    definitions.getByText("workflow_dispatch", { exact: true })
  ).toBeVisible();
  await expect(
    definitions.getByText("0 3 * * *", { exact: true })
  ).toBeVisible();

  // A workflow that declares no name, no trigger and no schedule says so
  // rather than showing blanks the operator has to read as facts.
  await expect(definitions).toContainText("nightly.yml");
  await expect(
    definitions.getByText("None observed", { exact: true })
  ).toBeVisible();
  await expect(
    definitions.getByText("No schedule trigger", { exact: true })
  ).toHaveCount(2);

  // The cards count what the definitions declare: the workflows that carry a
  // schedule, and the distinct triggers across all of them.
  await expect(statCard(page, "Scheduled Workflows")).toContainText("2");
  await expect(statCard(page, "Distinct Trigger Events")).toContainText("5");
});

test("the observed Actions state is kept apart from the definitions", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/github");
  await expect(githubBody(page)).toBeVisible();

  // The runtime state was read, and the page says from where.
  await expect(
    page.getByText("Actions API Connected", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(REPOSITORY, { exact: true })).toBeVisible();

  // The counts are over a bounded sample, and the card says so: they are not
  // the repository's whole history.
  await expect(statCard(page, RECENT_RUNS)).toContainText("30");
  await expect(statCard(page, RECENT_RUNS)).toContainText(
    "they are not total-history counts (SimulatorLife/AutoDev)"
  );
  await expect(statCard(page, "Recent Success Rate")).toContainText("70%");
  await expect(statCard(page, "Recent Success Rate")).toContainText(
    "21 succeeded, 5 failed, 2 running"
  );
  await expect(statCard(page, "Active Workflows")).toContainText("2");

  // Each workflow's own state is told apart: two are active, one was
  // disabled by hand, and one had no runtime state read at all.
  const definitions = tableUnder(page, "Workflow Definitions");
  await expect(definitions.getByText("Active", { exact: true })).toHaveCount(2);
  await expect(
    definitions.getByText("Disabled (Manual)", { exact: true })
  ).toHaveCount(1);
  await expect(definitions.getByText(UNAVAILABLE, { exact: true })).toHaveCount(
    1
  );

  // The last run of each workflow is the run's own outcome, not a claim
  // about the workflow.
  await expect(definitions.getByText("success", { exact: true })).toHaveCount(
    1
  );
  await expect(definitions.getByText("failure", { exact: true })).toHaveCount(
    1
  );

  // The recent runs are the runs the API returned, with their own outcomes.
  const runs = tableUnder(page, RECENT_RUNS);
  await expect(runs.locator("tbody tr")).toHaveCount(4);
  await expect(
    runs.getByText("#9001 Scheduler", { exact: true })
  ).toBeVisible();
  await expect(runs.getByText("pull_request", { exact: true })).toBeVisible();
  await expect(runs.getByText("cancelled", { exact: true })).toBeVisible();
  await expect(runs.getByText("in_progress", { exact: true })).toBeVisible();
});

test("the recent runs can be narrowed by outcome", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/github");
  await expect(githubBody(page)).toBeVisible();

  // The facet is a row of links, because the page is read-only and carries no
  // form and no button of its own: a link narrows without being one. The
  // shell around it has its own controls, so the assertion is about the
  // resource's own region.
  await expect(githubBody(page).locator("form")).toHaveCount(0);
  await expect(githubBody(page).locator("button")).toHaveCount(0);
  await expect(page.locator('[data-run-outcome="failed"]')).toBeVisible();

  await page.locator('[data-run-outcome="failed"]').click();
  await expect(page).toHaveURL(/outcome=failed/u);
  // One of the four runs failed, and it is the one the page keeps.
  const failed = tableUnder(page, RECENT_RUNS);
  await expect(failed.locator("tbody tr")).toHaveCount(1);
  await expect(failed.getByText("#9003 CI", { exact: true })).toBeVisible();
  // And the count of what is in view says so.
  await expect(
    page.getByText("Showing 1 of 4 runs", { exact: true })
  ).toBeVisible();
  // The chosen facet says so too, and not only by its colour.
  await expect(page.locator('[data-run-outcome="failed"]')).toHaveAttribute(
    "aria-current",
    "true"
  );
});

test("the page offers no GitHub mutation control", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/github");
  await expect(githubBody(page)).toBeVisible();

  // Dispatch, cancel, rerun and schedule are unimplemented in the product,
  // so the page must not offer a control that names one of them. A control
  // named after a mutation is a control the operator can reach for.
  await expect(
    page.getByRole("button", { name: MUTATION_CONTROL })
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: MUTATION_CONTROL })).toHaveCount(
    0
  );

  // The page says why the controls are absent rather than leaving the
  // operator to work out that a missing button was deliberate.
  await expect(page.getByText(NO_MUTATION_CONTROLS)).toBeVisible();
});

test("the page refuses to invent runtime facts it could not read", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setGithubRuntimeState(request, "unavailable");
  try {
    await page.goto("/github");
    await expect(githubBody(page)).toBeVisible();

    // The runtime cards are gone rather than showing zeros: the run counts
    // and the success rate are the facts the API did not give.
    await expect(statCard(page, RECENT_RUNS)).toHaveCount(0);
    await expect(statCard(page, "Recent Success Rate")).toHaveCount(0);
    await expect(statCard(page, "Active Workflows")).toHaveCount(0);

    // The definitions are still there -- they come from the repository, not
    // from the API -- and the page says why the runtime facts are missing.
    await expect(page.getByText(REQUIRES_THE_ACTIONS_API)).toBeVisible();
    await expect(page.getByText(RUNTIME_UNREACHABLE)).toBeVisible();

    // Every workflow's own state says the same thing, because none of them
    // was read.
    const definitions = tableUnder(page, "Workflow Definitions");
    await expect(
      definitions.getByText(UNAVAILABLE, { exact: true })
    ).toHaveCount(4);
  } finally {
    await setGithubRuntimeState(request, "observed");
  }
});
