import { type APIRequestContext, expect, test } from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const NOT_OBSERVED = "Not observed";

/**
The command the declaration gives the shared event.

It is the value the editor has to be filled from. The Runtime published an
older command for the same event, so the two are not the same string and an
editor showing the published one would be showing the wrong side.
*/
const DECLARED_COMMAND = "echo guarded";

/**
The event every target inherits, and the event the target declares alone.

The page has to tell them apart, because it is the difference between an
edit that reaches every target and an edit that reaches one.
*/
const SHARED_EVENT = "preToolUse";
const TARGET_EVENT = "sessionEnd";

async function resetHookDeclaration(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/hooks/reset`
  );
  expect(response.ok()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  await resetHookDeclaration(request);
});

test.afterEach(async ({ request }) => {
  await resetHookDeclaration(request);
});

test("the hooks page shows the target's effective events and where each is declared", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The events the target receives are on the page, and each one says where
  // it is declared.
  await expect(
    page.locator(`[data-hook-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-hook-event="${TARGET_EVENT}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-hook-origin="${SHARED_EVENT}"]`)
  ).toContainText("Declared for every target");
  await expect(
    page.locator(`[data-hook-origin="${TARGET_EVENT}"]`)
  ).toContainText("Declared for Codex only");

  // The editor is filled from the declaration, not from what the Runtime
  // published. The two differ here -- the Runtime is behind the declaration --
  // so the field can only be showing one of them.
  const declaration = page.locator(`[data-hook-event="${SHARED_EVENT}"]`);
  await expect(declaration.getByLabel("Hook command")).toHaveText(
    DECLARED_COMMAND
  );
  await expect(declaration.locator("form, input, textarea")).toHaveCount(0);
});

test("the hooks page keeps the declaration and the applied configuration apart", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The applied side is the Runtime's own reading of what it published, and
  // the verdict on it is the Runtime's too.
  await expect(
    page.locator(`[data-hook-applied-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(page.locator('[data-feature="reconciliation"]')).toBeVisible();
  await expect(
    page.getByText("Desired generation", { exact: true })
  ).toBeVisible();
  // The Runtime has not caught up with the declaration yet, and the page says
  // so rather than reporting convergence.
  await expect(
    page.getByText("Pending", { exact: true }).first()
  ).toBeVisible();
});

test("the hooks page says when the applied configuration has not been observed", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The applied read is a separate question from the declaration, and a
  // failure to read it is not a failure to read the declaration.
  await expect(page.getByText("Hook Events", { exact: true })).toBeVisible();
  await expect(page.getByText(NOT_OBSERVED).first()).toBeVisible();
});

test("the list links each event to its own page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The event is the item's name and the item's own address, so the card's
  // header is where the operator opens it.
  const link = page.locator(`[data-hook-event-link="${SHARED_EVENT}"]`);
  await expect(link).toHaveAttribute("href", `/hooks/${SHARED_EVENT}`);
  await link.click();

  await expect(page).toHaveURL(new RegExp(`/hooks/${SHARED_EVENT}$`, "u"));
  await expect(
    page.locator(`[data-hook-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
});

test("the hook event's own page carries the same read-only actions the list carries", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  // The trail names the place the operator is on and where they came from.
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail).toBeVisible();
  await expect(
    trail.getByRole("link", { name: "Hooks", exact: true })
  ).toHaveAttribute("href", "/hooks");
  await expect(trail.locator('[aria-current="page"]')).toHaveText(SHARED_EVENT);

  const declaration = page.getByRole("list", { name: "Declared hook actions" });
  await expect(declaration.getByLabel("Hook command")).toHaveText(
    DECLARED_COMMAND
  );
  await expect(page.locator("form, input, textarea")).toHaveCount(0);
  // The origin is the same fact the card shows.
  await expect(
    page.locator(`[data-hook-origin="${SHARED_EVENT}"]`)
  ).toContainText("Declared for every target");
});

test("the hook event's own page says what the Runtime published for it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  // The projection is published for the whole declaration, and the page
  // answers the question about this event: what did the Runtime publish for
  // it, and has it caught up with the declaration.
  await expect(
    page.locator(`[data-hook-applied-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(page.locator('[data-feature="reconciliation"]')).toBeVisible();
  // The Runtime has not caught up with the declaration yet, and the page says
  // so rather than reporting convergence.
  await expect(
    page.getByText("Pending", { exact: true }).first()
  ).toBeVisible();
});

test("an event the target does not declare has no page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // The Runtime publishes the effective declaration for the target, so an
  // event that is not in it is not declared for this target and there is
  // nothing there to inspect.
  await page.goto("/hooks/subagentStart");
  await expect(
    page.getByRole("heading", { name: "Page not found" })
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Declared hook actions" })
  ).toHaveCount(0);
});
