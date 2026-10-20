import { expect, type Locator, type Page, test } from "@playwright/test";

import { CANONICAL_ROUTES, routeHeading } from "./acceptance-helpers.ts";

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
