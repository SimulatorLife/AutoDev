import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

import { statCard } from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
/** The claims the store holds behind the window one read carries. */
const STORE_CLAIMS = 1204;
/** The claims one read carries. */
const PAGE_CLAIMS = 50;
/** The active claims in the whole filtered collection. */
const ACTIVE_CLAIMS = 604;
/** The sessions the cohort read counted. */
const MODE_ISOLATED_SESSIONS = 18;
/** The sessions among them that reported an outcome. */
const REPORTED_SESSIONS = 12;
/** The sessions among them that did not. */
const UNREPORTED_SESSIONS = 6;
/** The sessions whose injections disagreed about the mode. */
const MIXED_MODE_SESSIONS = 3;
/** The sessions whose per-injection tokens disagreed about the outcome. */
const CONFLICTING_REPORTS = 2;
/** The first claim the fixture holds, addressed by its identifier. */
const FIRST_RECORD = /mem-0001/u;
/** The setting the page names when durable storage is not configured. */
const DATABASE_URL_SETTING = /AUTODEV_MEMORY_DATABASE_URL/u;

/**
 * The page's own body, which owns the list it is showing.
 */
function memoryBody(page: Page): Locator {
  return page.locator('[data-feature="memory"]');
}

/**
 * The durable claims table.
 */
function recordsTable(page: Page): Locator {
  return page
    .getByRole("row", { name: FIRST_RECORD })
    .locator("xpath=ancestor::table[1]");
}

/**
 * Whether durable memory storage is connected.
 *
 * The storage status and the records read answer different questions, and
 * the page uses the status to explain a failed records read rather than
 * guessing why it failed. So the fixture has to be able to take the storage
 * away, or the page's explanation is only ever a guess that happens to be
 * right.
 */
async function setMemoryStorage(
  request: APIRequestContext,
  state: "configured" | "not_configured"
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/memory/state?state=${state}`
  );
  expect(response.ok()).toBe(true);
}

test("the page shows the durable claims and the lifecycle they are in", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/memory");
  await expect(memoryBody(page)).toBeVisible();

  const table = recordsTable(page);
  await expect(table.locator("tbody tr")).toHaveCount(PAGE_CLAIMS);

  // Each row names the claim, the kind it is and the lifecycle state it is
  // in, so the five states are told apart rather than collapsed into a
  // health word borrowed from another resource.
  await expect(
    page.locator('[data-memory-record-id="mem-0001"]')
  ).toBeVisible();
  await expect(
    page.locator('[data-memory-kind="semantic"]').first()
  ).toBeVisible();
  // The written claims name the lifecycle state each is in, so the states are
  // told apart rather than collapsed into a health word borrowed from another
  // resource. The states are asserted on the rows that carry them, not on the
  // page's totals: the page holds fifty claims and the totals belong to the
  // collection.
  for (const [id, state] of [
    ["mem-0002", "Proposed"],
    ["mem-0001", "Active"],
    ["mem-0003", "Superseded"],
    ["mem-0005", "Invalidated"]
  ] as const) {
    await expect(
      table
        .getByRole("row", { name: new RegExp(id, "u") })
        .getByText(state, { exact: true })
    ).toBeVisible();
  }
  await expect(
    table.getByText("The Console's breadcrumb landmark is named Breadcrumb.")
  ).toBeVisible();
});

test("the page counts the collection rather than the rows on the page", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/memory");
  await expect(memoryBody(page)).toBeVisible();

  // The durable-claims card is about the collection, and it names the page
  // beside it: five rows are on the page, and 1,204 match.
  const durable = statCard(page, "Durable Records");
  await expect(durable).toContainText(String(STORE_CLAIMS));
  await expect(durable).toContainText(`${PAGE_CLAIMS} on this page`);

  // The sidebar counts the same thing. It is the resource's own size, so the
  // badge and the card cannot be two numbers for one resource on one screen
  // -- and a narrowing that emptied the list must not make the sidebar read as
  // though the memory itself had gone.
  await expect(page.locator('[data-nav-item="memory"]')).toHaveAttribute(
    "aria-label",
    `Memory (${STORE_CLAIMS})`
  );

  // The active-claims card is the Runtime's own rollup over the whole
  // filtered collection, not a count of the active rows on the page -- which
  // would have been two.
  const active = statCard(page, "Active Claims");
  await expect(active).toContainText(String(ACTIVE_CLAIMS));
  await expect(active).toContainText("Verified & in service, all pages");

  // The sessions the cohort read counted are the page's own number, and the
  // card says which window it is about.
  await expect(statCard(page, "Mode-Isolated Sessions")).toContainText(
    String(MODE_ISOLATED_SESSIONS)
  );
});

/**
 * One stat card of the cohorts tab, addressed by its exact title.
 *
 * The titles overlap as substrings -- "Reported Sessions" is inside
 * "Unreported Sessions" -- so the card is addressed by an exact match on its
 * term. A substring match resolves to two cards and the assertion cannot say
 * which one it read.
 */
function cohortsCard(page: Page, title: string): Locator {
  return page
    .locator("dl")
    .filter({ has: page.getByText(title, { exact: true }) });
}

test("the Outcome Cohorts tab renders every count the cohorts contract declares", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/memory?tab=cohorts");
  await expect(memoryBody(page)).toBeVisible();

  // The tab used to fail to render at all. The Console's guard for the
  // cohorts response checked three of the five counts the contract declares,
  // and the fixture published three, so the two absent counts passed
  // validation and reached the view as `undefined` -- which the view's stat
  // card read as a number. A tab that throws is not a tab that reports
  // anything, and nothing in the acceptance visited this tab to find out.
  //
  // The four counts below are the ones only this grid carries. The
  // mode-isolated total is on the page's headline grid as well, because the
  // headline states it and this grid breaks it down, and that total is
  // asserted on the Durable Records tab.
  await expect(cohortsCard(page, "Reported Sessions")).toContainText(
    String(REPORTED_SESSIONS)
  );
  await expect(cohortsCard(page, "Unreported Sessions")).toContainText(
    String(UNREPORTED_SESSIONS)
  );
  // The two diagnostics are counted beside the population rather than inside
  // it, so they are separate cards with their own numbers.
  await expect(cohortsCard(page, "Mixed-Mode Sessions")).toContainText(
    String(MIXED_MODE_SESSIONS)
  );
  await expect(cohortsCard(page, "Conflicting Reports")).toContainText(
    String(CONFLICTING_REPORTS)
  );
});

test("the pager says which pages there are and its links reach them", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/memory");
  await expect(memoryBody(page)).toBeVisible();

  // The card says the collection holds 1,204 claims, so the pager has to be a
  // way into it rather than a count with nothing behind it.
  const pager = page.locator('[data-pagination="memory-records-pagination"]');
  await expect(pager).toBeVisible();
  await expect(pager).toContainText(`1–${PAGE_CLAIMS} of ${STORE_CLAIMS}`);
  await expect(
    pager.getByRole("link", { name: "Page 2", exact: true })
  ).toBeVisible();

  // And the page the strip links to is a page of the collection, not an empty
  // one: the claims it holds are there, and the pager says which rows they
  // are.
  await pager.getByRole("link", { name: "Page 2", exact: true }).click();
  await expect(page).toHaveURL(/offset=50/u);
  await expect(memoryBody(page)).toBeVisible();
  await expect(memoryBody(page).locator("table tbody tr")).toHaveCount(
    PAGE_CLAIMS
  );
  await expect(pager).toContainText(
    `51–${50 + PAGE_CLAIMS} of ${STORE_CLAIMS}`
  );
  // The page the operator is on is the one the strip marks, not a link that
  // goes where they already are.
  await expect(pager.locator('[aria-current="page"]')).toHaveText("2");
});

test("the page says why memory could not be read rather than showing nothing", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setMemoryStorage(request, "not_configured");
  try {
    await page.goto("/memory");

    // The storage is not configured, and the page says so instead of
    // showing an empty list, which would read as "nothing was remembered".
    await expect(
      page.getByText("Memory storage is not configured", { exact: true })
    ).toBeVisible();
    await expect(page.getByText(DATABASE_URL_SETTING)).toBeVisible();
    await expect(
      page.locator('[data-memory-record-id="mem-0001"]')
    ).toHaveCount(0);
  } finally {
    await setMemoryStorage(request, "configured");
  }
});
