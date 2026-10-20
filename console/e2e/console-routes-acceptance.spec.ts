import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * One canonical resource route and the resource it answers with.
 */
interface CanonicalRoute {
  /** The route's path. */
  readonly path: string;
  /** The section the route belongs to, which is what the sidebar marks. */
  readonly section: string;
  /** The heading the route answers with. */
  readonly heading: string;
}

/**
 * The canonical resources the target state names.
 *
 * The grouping is presentation only: all fourteen resources have first-class
 * routes, and each one answers with its own resource rather than with a
 * shared surface that says something about all of them.
 */
const CANONICAL_ROUTES: readonly CanonicalRoute[] = [
  { path: "/agents", section: "agents", heading: "Agents" },
  { path: "/providers", section: "providers", heading: "Providers" },
  { path: "/mcps", section: "mcps", heading: "MCPs" },
  { path: "/skills", section: "skills", heading: "Skills" },
  { path: "/hooks", section: "hooks", heading: "Hooks" },
  { path: "/prompts", section: "prompts", heading: "Prompts" },
  { path: "/permissions", section: "permissions", heading: "Permissions" },
  { path: "/tools", section: "tools", heading: "Tools" },
  { path: "/usage", section: "usage", heading: "Usage" },
  { path: "/evaluations", section: "evaluations", heading: "Evaluations" },
  { path: "/memory", section: "memory", heading: "Memory" },
  { path: "/playtesting", section: "playtesting", heading: "Playtesting" },
  { path: "/workspaces", section: "workspaces", heading: "Workspaces" },
  { path: "/github", section: "github", heading: "GitHub" }
];

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
 * The heading a route answers with.
 */
function routeHeading(page: Page, route: CanonicalRoute): Locator {
  return page.getByRole("heading", { name: route.heading, level: 1 });
}

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
