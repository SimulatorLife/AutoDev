import { expect, type Locator, type Page, test } from "@playwright/test";

import { statCard } from "./acceptance-helpers.ts";

/**
 * The evaluation results the Control fixture holds.
 *
 * The read is a bounded window over a larger store, and the rows carry the
 * three verdicts the page has to keep apart, so the page is exercised
 * against a window that is smaller than the store and against a history that
 * holds a failure and an unobserved verdict next to a success.
 */
const READ_ROWS = 60;
const STORE_ROWS = 120;
const PAGE_ROWS = 50;
/** A span the Usage fixture answers with a trace. */
const SERVED_SPAN_ID = "a1a1a1a100000000";
/** A span the Usage fixture never retained. */
const UNOBSERVED_SPAN_ID = "ffffffffffffffff";
/** The role whose rows all report the same prompt. */
const NARROWED_ROLE = "orchestrator";
/** The prompt the other role's rows report and the narrowed rows do not. */
const OTHER_ROLE_PROMPT = "review";

/**
 * The page's own body, which owns the state markers.
 */
function evaluationsBody(page: Page): Locator {
  return page.locator('[data-feature="evaluations"]');
}

/**
 * The filter bar's own sentence about the rows it narrowed.
 */
function filterSummary(page: Page): Locator {
  return page.getByRole("form", { name: "Evaluation filters" });
}

/**
 * The rows the read carried, waited for.
 *
 * The Console streams a page: the route's shell arrives first with the
 * section's loading state, and the page's own content is swapped in once the
 * server has the data. Reading the page before that swap reads the shell.
 */
async function openEvaluations(page: Page, query = ""): Promise<void> {
  await page.goto(`/evaluations${query}`);
  await expect(evaluationsBody(page)).toBeVisible();
  await expect(
    page.locator('[data-feature="evaluations-pager"]')
  ).toBeVisible();
}

test("the page tells the store's size from the size of the window it read", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEvaluations(page);

  await expect(evaluationsBody(page)).toHaveAttribute(
    "data-evaluations-truncated",
    "true"
  );

  // The store holds more than the read carried, and the card says both: the
  // number is the store's, and the subtitle names the window inside it.
  const retained = statCard(page, "Retained results");
  await expect(retained).toContainText(String(STORE_ROWS));
  await expect(retained).toContainText(
    `the most recent ${READ_ROWS} in this view`
  );

  // The filter bar's sentence uses the same two numbers and the same words.
  await expect(filterSummary(page)).toContainText(
    `Most recent ${READ_ROWS} of ${STORE_ROWS} retained results`
  );

  // The pager's range is the window's, not the store's, and it says which
  // population it is describing.
  await expect(page.locator('[data-evaluations-page-range="true"]')).toHaveText(
    `Rows 1–${PAGE_ROWS} of ${READ_ROWS} in this view`
  );
});

test("the page keeps the three verdicts apart", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEvaluations(page);

  // A third of the read passed, a third failed and a third never carried a
  // verdict. A page that counted the unobserved runs as failures would say
  // 40 here; a page that counted them as passes would say the same.
  await expect(statCard(page, "Passed")).toContainText("20");
  await expect(statCard(page, "Failed")).toContainText("20");
  await expect(statCard(page, "Not observed")).toContainText("20");

  // The pass rate is over the runs that carried a verdict, and it says how
  // many that was, so the percentage cannot be read over the whole window.
  await expect(statCard(page, "Pass Rate")).toContainText("50%");
  await expect(statCard(page, "Pass Rate")).toContainText(
    "40 of 60 with explicit verdicts"
  );
});

test("a filter narrows the view and the filter bar's options follow it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEvaluations(page);

  // Unnarrowed, the prompt filter offers the prompts the whole window holds.
  const promptOptions = page.locator(
    '[data-select="evaluations-prompt"] option'
  );
  await expect(promptOptions).toHaveCount(3);
  await expect(
    promptOptions.filter({ hasText: OTHER_ROLE_PROMPT })
  ).toHaveCount(1);

  // Narrowed to one role, the rows that survive are that role's, and the
  // prompt filter offers the prompts those rows report -- not the prompts
  // the rows it excluded reported.
  await openEvaluations(page, `?role=${NARROWED_ROLE}`);
  await expect(evaluationsBody(page)).toHaveAttribute(
    "data-evaluations-filtered",
    "true"
  );

  const narrowedOptions = page.locator(
    '[data-select="evaluations-prompt"] option'
  );
  await expect(narrowedOptions).toHaveCount(2);
  await expect(
    narrowedOptions.filter({ hasText: OTHER_ROLE_PROMPT })
  ).toHaveCount(0);

  // The view is now the narrowed rows, and every number on the page names
  // the same population: the rows in view, the window they came from and the
  // store behind it.
  await expect(page.locator('[data-evaluations-page-range="true"]')).toHaveText(
    "Rows 1–30 of 30 in this view"
  );
  await expect(filterSummary(page)).toContainText(
    `30 of the most recent ${READ_ROWS} · ${STORE_ROWS} retained`
  );
  await expect(statCard(page, "Retained results")).toContainText(
    `30 of the most recent ${READ_ROWS} in this view`
  );
});

test("the trace panel opens a run's trace and names the span it was asked for", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEvaluations(page, `?spanId=${SERVED_SPAN_ID}`);

  const panel = page.locator('[data-feature="evaluation-trace-detail"]');
  await expect(panel).toHaveAttribute("data-trace-state", "observed");
  await expect(panel).toContainText("3 spans shown");
  await expect(panel.locator("[data-trace-selected-span]")).toHaveText(
    `Selected span: ${SERVED_SPAN_ID}`
  );
});

test("a span the telemetry never retained is reported as not observed", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openEvaluations(page, `?spanId=${UNOBSERVED_SPAN_ID}`);

  // The span is absent from the retained telemetry. That is a fact about the
  // span, and the page says so rather than reporting a failed read.
  const panel = page.locator('[data-feature="evaluation-trace-detail"]');
  await expect(panel).toHaveAttribute("data-trace-state", "not-found");
  await expect(panel).toContainText(
    "The referenced span was not observed in retained telemetry."
  );
});
