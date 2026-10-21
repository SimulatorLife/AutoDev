import { expect, type Page, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  routeHeading
} from "./acceptance-helpers.ts";

/**
 * The state proxy's port.
 *
 * The Console reads the Control API through the proxy, and the proxy answers
 * in the state the spec asks for. The port is fixed because the Console is
 * started before the spec runs and its Control API address is part of that
 * start.
 */
const PROXY_PORT = Number(process.env.AUTODEV_STATE_PROXY_PORT ?? 4370);
const PROXY = `http://127.0.0.1:${String(PROXY_PORT)}`;

/**
 * The routes that read the Control API, and so have a state to answer with.
 *
 * The usage surface reads the OpenLIT usage API rather than the Control API,
 * so its unavailable state belongs to a different service. The Playtesting and
 * Workspaces surfaces read Playtesting-owned state, so a sweep that judged
 * them would be answering for work that is not this one's to judge.
 */
const PROVIDERS_ROUTE = "/providers";

const CONTROL_API_ROUTES: readonly string[] = [
  "/agents",
  PROVIDERS_ROUTE,
  "/mcps",
  "/skills",
  "/hooks",
  "/prompts",
  "/permissions",
  "/tools",
  "/evaluations",
  "/memory",
  "/github"
];

/**
 * The detail surfaces of the resources that have one.
 *
 * A detail page reads the same Control API as its list, so it has the same
 * obligation: a read that cannot be answered is an explicit state, not an
 * empty detail view.
 */
const CONTROL_API_DETAIL_ROUTES: readonly string[] = DETAIL_ROUTES.map(
  (route) => route.path
);

/**
 * Put the Control API into one state.
 *
 * The proxy answers the control route honestly, so a spec that puts the
 * service back is leaving no trace for the next one.
 */
async function setControlApiState(state: string): Promise<void> {
  const response = await fetch(`${PROXY}/__state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  expect(response.status).toBe(200);
}

test.afterEach(async () => {
  await setControlApiState("normal");
});

/**
 * The explicit state a page shows when its read could not be answered.
 */
function unavailableState(page: Page) {
  return page.locator('[data-status="unavailable"]').first();
}

/**
 * The resource rows a page would render if it had data.
 *
 * A page that cannot read its resource has no rows to show, and a row it
 * invented would be the worst outcome of all: it would read as a measured
 * result.
 */
function resourceRows(page: Page) {
  return page.locator("main table tbody tr");
}

test("a Control API that is not there leaves every route in an explicit unavailable state", async ({
  context
}) => {
  await setControlApiState("unavailable");
  const pages = await Promise.all(
    [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES].map(() =>
      context.newPage()
    )
  );
  const routes = [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES];
  await Promise.all(
    routes.map(async (route, index) => {
      const page = pages[index]!;
      await page.goto(route);

      // The state is explicit, and it names the failure: the operator is told
      // the Control API could not be reached rather than being shown a page
      // that looks empty.
      const state = unavailableState(page);
      await expect(state).toBeVisible();
      await expect(state).toHaveAttribute(
        "data-error-code",
        "autodev_unreachable"
      );

      // And nothing is invented in its place.
      await expect(resourceRows(page)).toHaveCount(0);
    })
  );
});

test("a Control API that refuses the reader leaves every route in an explicit unauthorized state", async ({
  context
}) => {
  await setControlApiState("unauthorized");
  const pages = await Promise.all(
    [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES].map(() =>
      context.newPage()
    )
  );
  const routes = [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES];
  await Promise.all(
    routes.map(async (route, index) => {
      const page = pages[index]!;
      await page.goto(route);

      const state = unavailableState(page);
      await expect(state).toBeVisible();
      await expect(state).toHaveAttribute(
        "data-error-code",
        "autodev_control_api_unauthorized"
      );
      await expect(resourceRows(page)).toHaveCount(0);
    })
  );
});

test("a Control API that fails leaves every route in an explicit error state", async ({
  context
}) => {
  await setControlApiState("error");
  const pages = await Promise.all(
    [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES].map(() =>
      context.newPage()
    )
  );
  const routes = [...CONTROL_API_ROUTES, ...CONTROL_API_DETAIL_ROUTES];
  await Promise.all(
    routes.map(async (route, index) => {
      const page = pages[index]!;
      await page.goto(route);

      const state = unavailableState(page);
      await expect(state).toBeVisible();
      await expect(state).toHaveAttribute(
        "data-error-code",
        "autodev_control_api_unavailable"
      );
      await expect(resourceRows(page)).toHaveCount(0);
    })
  );
});

test("a route that cannot read its resource still says which resource it is", async ({
  page
}) => {
  await setControlApiState("unavailable");
  await page.goto(PROVIDERS_ROUTE);

  // The failure is about the Providers surface, so the page still names the
  // surface: an operator who followed a link into a failed page has to know
  // where they are before they can act.
  const providers = CANONICAL_ROUTES.find(
    (route) => route.path === PROVIDERS_ROUTE
  );
  expect(providers).toBeDefined();
  await expect(routeHeading(page, providers!)).toBeVisible();
  await expect(unavailableState(page)).toBeVisible();
});

test("a route that is still waiting for its resource shows the shell and a loading placeholder", async ({
  page
}) => {
  await setControlApiState("slow");

  // The Console streams a page: the shell and its loading state arrive first
  // and the resource's own content is swapped in when the Runtime answers.
  // While the read is pending the operator has to see the surface they asked
  // for and something that says the answer is still on its way -- not a blank
  // page and not a table with no rows in it.
  const navigation = page.goto("/providers");
  await expect(page.locator("[data-console-loading]")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Providers", level: 1 })
  ).toBeVisible();

  await navigation;
  await expect(page.locator("[data-console-loading]")).toHaveCount(0);
  await expect(unavailableState(page)).toHaveCount(0);
});
