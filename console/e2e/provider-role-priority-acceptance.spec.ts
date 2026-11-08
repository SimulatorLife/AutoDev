import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * A provider role's priority, changed on the Providers page, reaches the
 * Runtime, and the page shows what the Runtime holds.
 *
 * An operator set Claude's orchestrator role to Disabled, the page showed
 * Disabled, and the Runtime never received the change. These pin the three
 * ways that could happen: a write that lands, a write the Runtime refuses (the
 * select must not keep showing the refused choice), and a change made before
 * the page's scripts run (the change must still be submitted).
 */

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const PROVIDERS_URL = "/providers";
const PRIORITY_SELECT = "#select-priority-claude-orchestrator";
const INITIAL_PRIORITY = "2";

async function roleWrites(
  request: APIRequestContext
): Promise<Record<string, { priority: unknown; model: unknown }>> {
  const response = await request.get(
    `${FIXTURE_BASE_URL}/fixture/providers/roles`
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { writes: Record<string, never> }).writes;
}

test.afterEach(async ({ request }) => {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/providers/roles?state=reset`
  );
  expect(response.ok()).toBe(true);
});

test("Disabling a provider's orchestrator role reaches the Runtime and stays shown", async ({
  page,
  request
}) => {
  await page.goto(PROVIDERS_URL);
  const priority = page.locator(PRIORITY_SELECT);
  await expect(priority).toHaveValue(INITIAL_PRIORITY);

  await priority.selectOption("disabled");
  await expect
    .poll(async () => (await roleWrites(request))["claude:orchestrator"])
    .toMatchObject({ priority: "disabled" });
  await expect(priority).toHaveValue("disabled");

  // A fresh read of the page is the Runtime's answer, not the browser's memory.
  await page.reload();
  await expect(page.locator(PRIORITY_SELECT)).toHaveValue("disabled");
});

test("A refused role change does not keep showing the refused choice", async ({
  page,
  request
}) => {
  const refuse = await request.post(
    `${FIXTURE_BASE_URL}/fixture/providers/roles?state=refuse-next&code=autodev_control_api_provider_cannot_delegate`
  );
  expect(refuse.ok()).toBe(true);
  await page.goto(PROVIDERS_URL);
  const priority = page.locator(PRIORITY_SELECT);
  await expect(priority).toHaveValue(INITIAL_PRIORITY);

  await priority.selectOption("disabled");
  // The refusal is said, and the select shows the priority the Runtime kept.
  await expect(page).toHaveURL(/control=failed/u);
  await expect(page.locator(PRIORITY_SELECT)).toHaveValue(INITIAL_PRIORITY);
  expect((await roleWrites(request))["claude:orchestrator"]).toBeUndefined();
});

test("A role change made before the page's scripts run is still submitted", async ({
  page,
  request
}) => {
  // No bundle loads, so nothing hydrates: the only listener is the inline one.
  await page.route("**/_next/static/**", (route) => route.abort());
  await page.goto(PROVIDERS_URL);
  const priority = page.locator(PRIORITY_SELECT);
  await expect(priority).toHaveValue(INITIAL_PRIORITY);

  await Promise.all([
    page.waitForURL((url) => url.pathname === PROVIDERS_URL, {
      waitUntil: "domcontentloaded"
    }),
    priority.selectOption("disabled")
  ]);
  await expect
    .poll(async () => (await roleWrites(request))["claude:orchestrator"])
    .toMatchObject({ priority: "disabled" });
  await expect(page.locator(PRIORITY_SELECT)).toHaveValue("disabled");
});
