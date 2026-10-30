import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  routeHeading,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * The generic surfaces the target state rules out.
 *
 * The root route must lead to a canonical resource rather than to a generic
 * home page, so none of these may ever answer with a surface of its own.
 */
const GENERIC_SURFACES: readonly string[] = ["/home", "/dashboard"];

/**
 * The URL the root route must end on.
 */
const AGENTS_URL = /\/agents$/u;

/**
 * The sidebar's entry for one section.
 */
function sectionEntry(page: Page, section: string): Locator {
  return page.locator(`[data-nav-item="${section}"]`).first();
}

test("the root route leads to a canonical resource rather than to a dashboard", async ({
  page
}) => {
  // The target state is explicit: there is no generic home surface, and the
  // root route redirects to a useful canonical resource. What the operator
  // ends up on is the requirement -- how the framework delivers that
  // redirect is not.
  await page.goto("/");
  await expect(page).toHaveURL(AGENTS_URL);
  await expect(
    page.getByRole("heading", { name: "Agents", level: 1 })
  ).toBeVisible();

  // And the generic surfaces stay absent, so the root route is not a
  // shorthand for a home page under another name.
  const statuses = await Promise.all(
    GENERIC_SURFACES.map(async (surface) => {
      const response = await page.request.get(surface);
      return response.status();
    })
  );
  expect(statuses).toEqual(GENERIC_SURFACES.map(() => 404));
});

test("an address that names no resource says so, and claims no section", async ({
  page
}) => {
  // The page a bad address lands on used to fall back to the Workspaces
  // section: its heading named Workspaces, and the rail marked Workspaces as
  // the current page. The heading is what the navigation owner announces after
  // a navigation, so the operator was told they were on a page they were not
  // on -- by the navigation as well as by the page.
  await page.goto("/no-such-resource");
  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 })
  ).toBeVisible();
  await expect(page.locator('[aria-current="page"]')).toHaveCount(0);

  // And the page publishes the client's arrival, like every other page. Ten
  // detail routes answer with this page when their resource is absent, so a
  // caller that waits for the client the way it waits on every other page
  // would wait forever on the one page that says the address was wrong.
  await waitForPageContent(page);

  // The link names a destination rather than a return: the operator was never
  // on Agents, so "Return to Agents" would be a claim about where they had
  // been.
  await expect(
    page.getByRole("link", { name: "Go to Agents", exact: true })
  ).toHaveAttribute("href", "/agents");
  await expect(
    page.getByRole("link", { name: "Return to Agents" })
  ).toHaveCount(0);
});

test("an address that names a section takes the operator back to it", async ({
  page
}) => {
  // A stale deep link -- a hook event that was renamed, a link from a runbook
  // that outlived it -- used to answer with Agents, Providers and Workspaces
  // whatever the address said. The section the operator was actually reaching
  // for was in the address bar and nowhere else, so recognition had to give
  // way to recall.
  await page.goto("/hooks/no-such-hook-event");
  await waitForPageContent(page);

  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 })
  ).toBeVisible();
  await expect(page.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Return to Hooks", exact: true })
  ).toHaveAttribute("href", "/hooks");

  // And the way back is offered once: a second link to the same place under
  // another name is a choice the operator has to make for no reason.
  await expect(
    page.getByRole("link", { name: "Return to Hooks", exact: true })
  ).toHaveCount(1);
});

test("every canonical resource route answers with its own resource", async ({
  context
}) => {
  // Each route opens on its own page, so one route's slow read cannot hold
  // another route's answer back.
  const pages = await Promise.all(
    CANONICAL_ROUTES.map(() => context.newPage())
  );
  await Promise.all(
    CANONICAL_ROUTES.map(async (route, index) => {
      const page = pages[index]!;
      await page.goto(route.path);

      // The page's own heading: the resource the route is for, not a
      // dashboard that says something about all of them.
      await expect(routeHeading(page, route)).toBeVisible();

      // And the sidebar says the same thing -- it marks this section as the
      // current one, so the operator is told where they are by the navigation
      // as well as by the page.
      await expect(sectionEntry(page, route.section)).toHaveAttribute(
        "aria-current",
        "page"
      );
    })
  );
});
