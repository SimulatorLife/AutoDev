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
/** The attribute that carries the navigation's own state. */
const EXPANDED_ATTRIBUTE = "aria-expanded";
/** The state the control carries when the navigation is the compact rail. */
const COLLAPSED_STATE = "false";
/** The state the control carries when the navigation is a column. */
const EXPANDED_STATE = "true";
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
 *
 * The navigation is the rail at the narrow width these tests use, so the
 * control opens the rail into the panel that overlays the page.
 */
async function expandNavigation(page: Page): Promise<void> {
  // The click is taken against the state the operator is looking at, so the
  // navigation's own default has to have settled first: a click taken before
  // the sidebar applied its default would collapse the navigation rather than
  // expand it.
  await waitForNavigationDefault(page);
  await page.locator(TOGGLE).click();
  await expectNavigationState(page, "expanded");
}

/**
 * Waits for the navigation to reach a state.
 *
 * The server renders the navigation expanded, because it does not know the
 * viewport, and the sidebar applies its own default once it has measured the
 * window. A one-shot read of the control's state measures whichever of the
 * two the page happened to be in -- at a narrow width the rail is applied a
 * moment after the page arrives, not in its first paint -- so the read waits
 * for the state, and fails when the navigation never reaches it.
 */
async function expectNavigationState(
  page: Page,
  expected: "collapsed" | "expanded"
): Promise<void> {
  await expect(page.locator(TOGGLE)).toHaveAttribute(
    EXPANDED_ATTRIBUTE,
    expected === "collapsed" ? COLLAPSED_STATE : EXPANDED_STATE
  );
}

/**
 * Waits until the navigation has settled into the default its width implies.
 *
 * The rail is the default below the wide width, so the state the navigation
 * settles into is the one the viewport calls for.
 */
async function waitForNavigationDefault(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const narrow = viewport !== null && viewport.width < WIDE_WIDTH;
  await expectNavigationState(page, narrow ? "collapsed" : "expanded");
}

test("a narrow screen opens with the navigation as the compact rail", async ({
  page
}) => {
  await page.setViewportSize({ width: COMPACT_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // The rail is the default at a narrow width, and the control says so.
  await expectNavigationState(page, "collapsed");
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
  await expectNavigationState(page, "collapsed");
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
  await expectNavigationState(page, "collapsed");
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

  await expectNavigationState(page, "collapsed");
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
  await expectNavigationState(page, "expanded");
});

test("a wide screen keeps the navigation as a column beside the page", async ({
  page
}) => {
  await page.setViewportSize({ width: WIDE_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // At a wide width the navigation is expanded and beside the page, so the
  // page's content is narrower than the window.
  await expectNavigationState(page, "expanded");
  const contentWidth = await mainWidth(page);
  expect(contentWidth).toBeLessThan(WIDE_WIDTH);
  expect(await navigationWidth(page)).toBeGreaterThan(200);
});

test("an in-place navigation moves the focus to the new page's heading", async ({
  page
}) => {
  await page.setViewportSize({ width: WIDE_WIDTH, height: 844 });
  await openConsole(page, "/agents");

  // Every navigation in the Console is an in-place one, and the focus the
  // operator had on the link they activated was dropped to the document body
  // when the page changed. The next Tab then started at the skip link and
  // walked the whole navigation again before reaching the page they asked
  // for, and a screen reader was told nothing at all.
  const usage = page.locator(NAV_ITEM);
  await usage.focus();
  await usage.press("Enter");
  await page.waitForURL(USAGE_URL);
  await waitForPageContent(page);

  // The focus is on the new page's heading: a focused heading is read out, so
  // the page change is announced without a second live region saying it twice.
  await expect(page.locator("main h1")).toBeFocused();
  await expect(page.locator("main h1")).toHaveText("Usage");

  // And the next Tab lands in the page's content rather than at the top of
  // the document.
  await page.keyboard.press("Tab");
  const insideMain = await page.evaluate(() => {
    const active = document.activeElement;
    const main = document.querySelector("#main-content");
    return active !== null && main !== null && main.contains(active);
  });
  expect(insideMain).toBe(true);
});

test("a navigation that names a fragment lands on that fragment", async ({
  page
}) => {
  await page.setViewportSize({ width: WIDE_WIDTH, height: 844 });
  await openConsole(page, "/evaluations");

  // The detail drawer is opened by a link carrying the drawer's own anchor.
  // The operator asked for *that panel*, not for the page it sits under, so
  // the focus lands on the drawer and the next Tab is its close control.
  const open = page.locator('a[href*="#evaluation-detail-drawer"]').first();
  await open.click();
  await page.waitForURL(/#evaluation-detail-drawer$/u);
  await waitForPageContent(page);

  await expect(page.locator("#evaluation-detail-drawer")).toBeFocused();
  await page.keyboard.press("Tab");
  const insideDrawer = await page.evaluate(() => {
    const active = document.activeElement;
    const drawer = document.querySelector("#evaluation-detail-drawer");
    return active !== null && drawer !== null && drawer.contains(active);
  });
  expect(insideDrawer).toBe(true);
});
