import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

const NOT_OBSERVED = "Not observed";
const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const SCOPE_LABEL = "Usage scope";
const TIME_RANGE_LABEL = "Time range";
const SCOPE_OPTIONS = [
  "Active sessions",
  "Last 24 hours",
  "Last 7 days",
  "Last 30 days",
  "Last 90 days",
  "Custom range"
];
const OBSERVED_WORKSPACE = "fixture/game";
const LOGICAL_REQUESTS = "12";
const UNOBSERVED_DIMENSIONS = ["provider", "model", "agent", "skill"];
const INVALID_RESPONSE_CODE = "autodev_openlit_usage_invalid_response";
const HTTP_ERROR_CODE = "autodev_openlit_usage_http_503";
const UNREACHABLE_CODE = "autodev_openlit_usage_unreachable";
const UNAUTHORIZED_CODE = "autodev_openlit_usage_unauthorized";
const RUNTIME_UNAVAILABLE_CODE = "autodev_control_api_503";
const STAT_GRID = "[data-stat-grid]";
const FAILURE_PANEL = "[data-error-code]";
const ERROR_CODE_ATTRIBUTE = "data-error-code";
const ATTEMPTS_PANEL = '[data-feature="usage-recent-attempts"]';

/**
 * The value of one stat card, found by the card's own title.
 *
 * A stat card is a `<dl>` whose term is the title and whose description is
 * the value, so the title is the only thing that names which fact the value
 * is: the same word appears as a section heading and as a value elsewhere on
 * this page. The term is not a sibling of the value -- the card puts the
 * title in its own row, above the value -- so the value is reached through
 * the card rather than through the term.
 */
function statValue(page: Page, title: string): Locator {
  return page
    .locator(`dt:text-is("${title}")`)
    .locator("xpath=ancestor::dl[1]//dd/div/span[1]");
}

/**
 * One stat card whose signal the source did not report.
 *
 * The absence of a measurement is not a measurement, so the card has to say
 * which of the two it is rather than showing a number the source never
 * produced.
 */
async function assertStatIsUnobserved(
  page: Page,
  title: string
): Promise<void> {
  const value = statValue(page, title);
  await expect(value).toHaveText(NOT_OBSERVED);
  await expect(value).toHaveAttribute("data-stat-unobserved", "true");
}

/**
 * One filter dimension the source did not report.
 *
 * The control has to say that the dimension was not observed and cannot be
 * used, rather than offering an empty list that reads as a filter which found
 * nothing.
 */
async function assertDimensionIsUnobserved(
  page: Page,
  dimension: string
): Promise<void> {
  const select = page.locator(`select[name="${dimension}-unobserved"]`);
  await expect(select).toHaveAttribute("data-filter-options-observed", "false");
  await expect(select).toBeDisabled();
  await expect(select.locator("option")).toHaveText([NOT_OBSERVED]);
}

/**
 * Whether the Runtime's live projection answers.
 *
 * The live scope has to be able to show what a failed read looks like, and the
 * only way to reach that state is for the Runtime to stop answering. The
 * fixture is told directly, because the Console has no handle on it.
 */
async function setRuntimeAvailable(
  request: APIRequestContext,
  available: boolean
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/runtime/state?state=${available ? "observed" : "unavailable"}`
  );
  expect(response.ok()).toBe(true);
}

test("the scope control names both kinds of selection", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage");

  // The control holds a live-session scope as well as a time range, so a
  // label that promised only a window would misdescribe one of its options.
  const scope = page.getByLabel(SCOPE_LABEL);
  await expect(scope).toBeVisible();
  await expect(scope.locator("option")).toHaveText(SCOPE_OPTIONS);
  await expect(page.getByLabel(TIME_RANGE_LABEL)).toHaveCount(0);
});

test("a partial snapshot shows the measured metric beside the unobserved ones", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage");

  // The source reported one signal, so the page is observed -- but only for
  // that signal.
  await expect(page.locator("[data-usage-observed]")).toHaveAttribute(
    "data-usage-observed",
    "true"
  );
  await expect(statValue(page, "Logical Routed Requests")).toHaveText(
    LOGICAL_REQUESTS
  );

  // The signals the source did not report are absent, not zero. A cost of
  // nothing is not a measured cost of zero, so it reads as not observed.
  await Promise.all(
    ["Estimated Cost", "P95 Latency", "Cache-read Rate"].map((title) =>
      assertStatIsUnobserved(page, title)
    )
  );
  await expect(statValue(page, "Input / Output Tokens")).toHaveText(
    `${NOT_OBSERVED} / ${NOT_OBSERVED}`
  );
  await expect(page.locator(STAT_GRID).getByText("$0.00")).toHaveCount(0);
});

test("the breakdown chart draws the measured breakdown, and agrees with the count", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage");

  // The charts were never drawn in the acceptance: every chart widget answered
  // as unobserved, so a chart that drew the wrong bar, the wrong label or the
  // wrong number would have gone unnoticed. The role breakdown is observed
  // now, and it is read the way a reader reads it.
  const chart = page.getByRole("list", {
    name: "Logical routed requests by agent role"
  });
  await expect(chart).toBeVisible();
  await expect(chart.getByText("orchestrator")).toBeVisible();
  await expect(chart.getByText("worker")).toBeVisible();
  await expect(chart.getByText("7")).toBeVisible();
  await expect(chart.getByText("5")).toBeVisible();

  // And the breakdown adds up to the count beside it. A chart that disagrees
  // with the total it breaks down is two claims, and the reader cannot tell
  // which one is wrong.
  const total = await chart.locator("li").evaluateAll((items) =>
    items.reduce((sum, item) => {
      // The row's own value is its last span; the label and the bar carry no
      // number, and the spans are adjacent, so the row's text runs together.
      const spans = Array.from(item.querySelectorAll("span"));
      const value = spans.at(-1)?.textContent ?? "";
      return sum + Number(value.replaceAll(/[^0-9.]/gu, ""));
    }, 0)
  );
  expect(total).toBe(Number(LOGICAL_REQUESTS));
});

test("the filters tell an observed dimension from an unobserved one", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage");

  // The workspace dimension was reported, so the control offers the value it
  // observed and is usable.
  const workspace = page.locator('select[name="workspace"]');
  await expect(workspace).toHaveAttribute(
    "data-filter-options-observed",
    "true"
  );
  await expect(workspace.locator("option")).toHaveText([
    "All",
    OBSERVED_WORKSPACE
  ]);

  // The other dimensions were not reported. Their controls say which of the
  // two they are and cannot be used, instead of offering an empty list that
  // reads as a filter that found nothing.
  await Promise.all(
    UNOBSERVED_DIMENSIONS.map((dimension) =>
      assertDimensionIsUnobserved(page, dimension)
    )
  );
});

test("the recent-attempt list says it was not observed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage");

  const attempts = page.locator(ATTEMPTS_PANEL);
  await expect(attempts).toHaveAttribute(
    "data-trace-list-state",
    "unavailable"
  );
  await expect(attempts).toContainText(
    "Recent provider attempts were not observed."
  );
  // No empty table: an empty table reads as a scope with no attempts in it.
  await expect(attempts.locator("table")).toHaveCount(0);
});

test("a response that does not validate leaves no metric cards behind", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage?range=7D");

  const failure = page.locator(FAILURE_PANEL);
  await expect(failure).toHaveAttribute(
    ERROR_CODE_ATTRIBUTE,
    INVALID_RESPONSE_CODE
  );
  await expect(failure).toHaveAttribute("data-status", "unavailable");
  // The scope control stays, because an operator still has to be able to
  // change the scope and read again.
  await expect(page.getByLabel(SCOPE_LABEL)).toBeVisible();
  // Nothing is drawn as if a snapshot had been read.
  await expect(page.locator(STAT_GRID)).toHaveCount(0);
  await expect(page.locator("[data-usage-observed]")).toHaveAttribute(
    "data-usage-observed",
    "false"
  );
});

test("the four failure kinds are four different failures", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // The source answered and the answer is unusable.
  await page.goto("/usage?range=7D");
  await expect(page.locator(FAILURE_PANEL)).toHaveAttribute(
    ERROR_CODE_ATTRIBUTE,
    INVALID_RESPONSE_CODE
  );

  // The source answered with a status of its own.
  await page.goto("/usage?range=3M");
  await expect(page.locator(FAILURE_PANEL)).toHaveAttribute(
    ERROR_CODE_ATTRIBUTE,
    HTTP_ERROR_CODE
  );

  // The connection died before the source answered, so there is no status to
  // report and the read failed in transport rather than in the payload.
  await page.goto("/usage?range=1M");
  await expect(page.locator(FAILURE_PANEL)).toHaveAttribute(
    ERROR_CODE_ATTRIBUTE,
    UNREACHABLE_CODE
  );

  // The source refused the server-side credential.
  await page.goto("/usage?range=CUSTOM");
  await expect(page.locator(FAILURE_PANEL)).toHaveAttribute(
    ERROR_CODE_ATTRIBUTE,
    UNAUTHORIZED_CODE
  );
});

test("the Active Sessions scope is its own scope, not a time range", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/usage?range=ACTIVE_SESSIONS");

  // The live scope has its own heading and its own counters, taken from the
  // Runtime rather than from a telemetry window.
  await expect(
    page.getByRole("heading", { name: "Active Sessions" })
  ).toBeVisible();
  await expect(statValue(page, "Active Sessions")).toHaveText("3");
  await expect(statValue(page, "Active Subagent Threads")).toHaveText("2");
  await expect(statValue(page, "In-flight Requests")).toHaveText("4");
  await expect(statValue(page, "Router Lifecycle")).toHaveText("Ready");

  // The historical widgets are not on this scope. A live scope that also
  // carried the last window's numbers would be a time range with a different
  // label.
  await expect(page.getByText("Logical Routed Requests")).toHaveCount(0);
  await expect(page.getByText("Recent provider attempts")).toHaveCount(0);

  // The Runtime publishes a count but no per-session identity, so the page
  // says why there is no list instead of drawing an empty one.
  await expect(
    page.getByText(
      "The Runtime reports a live session count but no per-session identity yet, so no session list is shown.",
      { exact: false }
    )
  ).toBeVisible();
});

test("a Runtime that does not answer is not an idle Runtime", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setRuntimeAvailable(request, false);
  try {
    await page.goto("/usage?range=ACTIVE_SESSIONS");

    // The read failed, and the page says so with the reason.
    await expect(page.locator(FAILURE_PANEL)).toHaveAttribute(
      ERROR_CODE_ATTRIBUTE,
      RUNTIME_UNAVAILABLE_CODE
    );
    await expect(
      page.getByText(
        "Live session state is unavailable. The Runtime did not report session evidence, so no count is shown; an unavailable read is not an idle Runtime.",
        { exact: false }
      )
    ).toBeVisible();

    // No counter at all: a count of zero would report an idle Runtime that
    // was never observed.
    await expect(page.locator(STAT_GRID)).toHaveCount(0);
    await expect(page.locator('dt:text-is("Active Sessions")')).toHaveCount(0);

    // The scope control stays, so the operator can read a scope that works.
    await expect(page.getByLabel(SCOPE_LABEL)).toBeVisible();
  } finally {
    await setRuntimeAvailable(request, true);
  }
});
