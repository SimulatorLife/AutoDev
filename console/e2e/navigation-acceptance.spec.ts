import { expect, type Locator, type Page, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The compact navigation, driven in a browser.
 *
 * The target state is specific about the navigation at a narrow width: it
 * defaults to the compact rail, expanding it *overlays* the page rather than
 * compressing the page's content, selecting a destination collapses it,
 * Escape collapses it, and a modified link-open gesture leaves the current
 * view state alone.
 *
 * Those last four are decisions the Console makes in an event handler, and
 * the unit test covers the predicates they call. A predicate that is right
 * is not the same claim as a navigation that behaves: the predicates are
 * pure functions over a click event, and nothing checks that the click
 * reaches them, that the rail is the default at a narrow width, or that the
 * expanded rail is an overlay rather than a column that squeezes the page.
 * This spec drives the navigation as the operator does.
 */

/** The navigation landmark. */
const NAVIGATION = "#autodev-console-navigation";
/** The button that opens and closes the navigation. */
const TOGGLE = '[data-button="sidebar-toggle"]';
/** The navigation item of one resource. */
const NAV_ITEM = '[data-nav-item="usage"]';
/** The page's own content, which the navigation must not squeeze. */
const MAIN = "#main-content";
/** The width at which the navigation is the rail by default. */
const COMPACT_WIDTH = 390;
/** The width of the compact rail. */
const RAIL_WIDTH = 56;
/** The width at which the navigation is a column beside the page. */
const WIDE_WIDTH = 1280;
/** The URL of the Agents route. */
const AGENTS_URL = /\/agents$/u;
/** The URL of the Usage route. */
const USAGE_URL = /\/usage$/u;

/**
 * Open a Console page and wait until it has settled.
 *
 * The Console streams a page, and the streamed copy of the shell sits in the
 * document until the page takes it over. Measuring while that is still there
 * would measure two navigations where the operator has one.
 */
async function openConsole(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForPageContent(page);
  await expect(page.locator(NAVIGATION)).toHaveCount(1);
}

/**
 * The width of the page's own content.
 *
 * The navigation is beside the content, so its width is what tells an
 * overlay from a column: an overlay leaves the content the width it was, and
 * a column takes some of it.
 */
function mainWidth(page: Page): Promise<number> {
  return page.locator(MAIN).evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

/**
 * The navigation's own width.
 */
function navigationWidth(page: Page): Promise<number> {
  return page.locator(NAVIGATION).evaluate((element) => {
    return element.getBoundingClientRect().width;
  });
}

/**
 * Open the navigation and wait until it is open.
 */
async function expandNavigation(page: Page): Promise<void> {
  await page.locator(TOGGLE).click();
  await expect(page.locator(TOGGLE)).toHaveAttribute("aria-expanded", "true");
}

/**
 * Whether the navigation is the compact rail.
 */
async function isCollapsed(page: Page): Promise<boolean> {
  return (await page.locator(TOGGLE).getAttribute("aria-expanded")) === "false";
}

test("a narrow screen opens with the navigation as the compact rail", async ({
  page
}) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // The rail is the default at a narrow width, and the control says so.
  expect(await isCollapsed(page)).toBe(true);
  await expect(
    page.getByRole("button", { name: "Expand sidebar" })
  ).toBeVisible();

  // The rail is narrow, and the page's content takes the rest of the width.
  const railWidth = await navigationWidth(page);
  expect(railWidth).toBeLessThan(100);
  const contentWidth = await mainWidth(page);
  expect(contentWidth).toBeGreaterThan(COMPACT_WIDTH - railWidth - 8);
});

test("expanding the navigation overlays the page instead of squeezing it", async ({
  page
}) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // The rail is in the flow beside the page, so the page's content is the
  // window less the rail.
  const contentBefore = await mainWidth(page);
  expect(contentBefore).toBe(COMPACT_WIDTH - RAIL_WIDTH);

  await expandNavigation(page);

  // The navigation is now a wide panel, and it is over the page: the page's
  // content has the whole window, because the panel is not taking any of it.
  const expandedWidth = await navigationWidth(page);
  expect(expandedWidth).toBeGreaterThan(200);
  const contentAfter = await mainWidth(page);
  expect(contentAfter).toBe(COMPACT_WIDTH);
  expect(contentAfter).toBeGreaterThan(contentBefore);
});

test("selecting a destination collapses the expanded navigation", async ({
  page
}) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");
  await expandNavigation(page);

  await page.locator(NAV_ITEM).click();

  await expect(page).toHaveURL(USAGE_URL);
  // The operator is on the resource they chose, and the navigation is back
  // to the rail rather than covering the page they are reading.
  expect(await isCollapsed(page)).toBe(true);
});

test("Escape collapses the expanded navigation", async ({ page }) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");
  await expandNavigation(page);

  // Escape is a key press, so it has to be pressed where the navigation can
  // hear it.
  const item: Locator = page.locator(NAV_ITEM);
  await item.focus();
  await expect(item).toBeFocused();
  await page.keyboard.press("Escape");

  expect(await isCollapsed(page)).toBe(true);
  // The page the operator was on is still the page they are on.
  await expect(page).toHaveURL(AGENTS_URL);
});

test("a modified link-open gesture leaves the current view state alone", async ({
  page
}) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");
  await expandNavigation(page);

  // A real control-click is consumed by the browser: it opens the
  // destination in another tab and the page never sees the event at all, so
  // a real gesture cannot tell the Console's own decision from the
  // browser's. The decision is therefore exercised with a dispatched event,
  // which is what reaches the handler, and the default action is cancelled
  // so that the dispatched click does not navigate.
  await page.locator(NAV_ITEM).evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true
    });
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        button: 0
      })
    );
  });

  // The operator asked for a new tab, not for this page to change, so the
  // page is where they left it and the navigation is where they left it.
  await expect(page).toHaveURL(AGENTS_URL);
  expect(await isCollapsed(page)).toBe(false);
});

test("a wide screen keeps the navigation as a column beside the page", async ({
  page
}) => {
  await page.setViewportSize({ width: WIDE_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // At a wide width the navigation is expanded and beside the page, so the
  // page's content is narrower than the window.
  expect(await isCollapsed(page)).toBe(false);
  const contentWidth = await mainWidth(page);
  expect(contentWidth).toBeLessThan(WIDE_WIDTH);
  expect(await navigationWidth(page)).toBeGreaterThan(200);
});
