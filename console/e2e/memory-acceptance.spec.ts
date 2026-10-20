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
const PAGE_CLAIMS = 5;
/** The active claims in the whole filtered collection. */
const ACTIVE_CLAIMS = 604;
/** The sessions the cohort read counted. */
const MODE_ISOLATED_SESSIONS = 18;
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
  await expect(table.getByText("Proposed", { exact: true })).toHaveCount(1);
  await expect(table.getByText("Active", { exact: true })).toHaveCount(2);
  await expect(table.getByText("Superseded", { exact: true })).toHaveCount(1);
  await expect(table.getByText("Invalidated", { exact: true })).toHaveCount(1);
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
