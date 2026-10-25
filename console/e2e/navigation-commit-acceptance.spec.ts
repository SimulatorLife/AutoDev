import { expect, type Page, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The navigation, driven the way the operator drives it.
 *
 * The unit tests cover what the navigation owner asks the router for and in
 * what order. They cannot cover the thing the operator actually sees: that a
 * click on a page link moves the address bar and moves the page with it.
 *
 * That claim has two ways of failing, and both of them were measured here.
 *
 * The first is a navigation that never commits. The owner used to wait for
 * the request that carries the destination's page, and a destination the
 * router already holds needs no request at all -- so the wait was a wait for
 * something that was never going to happen. Five of thirteen navigations
 * between the Console's own pages never committed, and every one of them was
 * a destination the router already held: the operator's click did nothing,
 * the address bar stayed where it was, and the page did not move.
 *
 * The second is a navigation that commits too late to be usable. A navigation
 * that has to fetch the destination's page does not always commit either: the
 * reducer applies the destination, React renders it, and the commit that moves
 * the address bar does not run. The owner leaves again when the answer
 * arrives, and the navigation commits then.
 *
 * So the spec visits the Console's pages in a circle, more than once, and
 * asks for the address bar to move every time. A circle is what makes both
 * failures visible: the second visit to a page is the visit the router
 * already holds an answer for, and the page the session started on is the
 * visit the router holds in the least helpful way.
 */

/** The navigation item of one resource. */
function navItem(page: Page, section: string) {
  return page.locator(`[data-nav-item="${section}"]`);
}

/**
 * Open a Console page and wait until it has settled.
 *
 * The Console streams a page, and the streamed copy of the shell sits in the
 * document until the page takes it over. Clicking a link while the shell is
 * still there would click the shell's copy of the navigation.
 */
async function openConsole(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForPageContent(page);
}

/**
 * Click a destination and wait for the navigation to commit.
 *
 * The commit is the address bar moving. The page's own content follows it,
 * and the spec checks that separately, because a navigation that moves the
 * address bar and leaves the old page on the screen is a different failure
 * from one that never moves.
 */
async function navigateTo(
  page: Page,
  section: string,
  heading: string
): Promise<void> {
  await navItem(page, section).click();
  await expect(page).toHaveURL(new RegExp(`${section}$`, "u"));
  await expect(
    page.getByRole("heading", { name: heading, level: 1 })
  ).toBeVisible();
}

test("a click on a page link moves the address bar and the page with it", async ({
  page
}) => {
  await openConsole(page, "/agents");

  await navigateTo(page, "providers", "Providers");
  await navigateTo(page, "mcps", "MCPs");
  await navigateTo(page, "usage", "Usage");
});

test("a destination the router already holds still moves the page", async ({
  page
}) => {
  await openConsole(page, "/agents");

  // The first visit is a destination the router has to fetch. The second is
  // one it already holds an answer for, and that answer is carried by no
  // request at all: a navigation that waits for a request there waits for
  // one that is never going to be made, and the operator's click does
  // nothing.
  await navigateTo(page, "providers", "Providers");
  await navigateTo(page, "agents", "Agents");
  await navigateTo(page, "providers", "Providers");
});

test("the page the session started on is still a destination", async ({
  page
}) => {
  await openConsole(page, "/agents");

  // The router holds the page the session started on in the least helpful
  // way it holds any page: it is not a prefetched page, and a navigation to
  // it has to fetch it for itself.
  await navigateTo(page, "providers", "Providers");
  await navigateTo(page, "agents", "Agents");
  await navigateTo(page, "hooks", "Hooks");
  await navigateTo(page, "agents", "Agents");
});

test("a circle through the Console's pages commits every time", async ({
  page
}) => {
  await openConsole(page, "/agents");

  const circle: ReadonlyArray<readonly [string, string]> = [
    ["providers", "Providers"],
    ["mcps", "MCPs"],
    ["usage", "Usage"],
    ["agents", "Agents"],
    ["hooks", "Hooks"],
    ["providers", "Providers"]
  ];

  for (const [section, heading] of circle) {
    await navigateTo(page, section, heading);
  }
});
