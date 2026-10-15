import { expect, type Page, test } from "@playwright/test";

const UNSUPPORTED_MODEL_ID = "claude-preview-unroutable";
const STALE_AVAILABILITY_TITLE = /availability is stale/u;

function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
}

test("Providers distinguishes live, stale, unavailable, and unsupported models", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.removeItem("autodev.console.sidebar.collapsed");
  });
  await page.goto("/providers?tab=models");

  await expect(
    page.getByRole("navigation", { name: "Providers views" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" })
  ).toBeVisible();
  await expect(
    page.locator('[data-provider-discovery="claude"]')
  ).toContainText("Observed · 2 models");
  await expect(page.locator('[data-provider-discovery="codex"]')).toContainText(
    "Stale · 1 last-known models"
  );
  await expect(
    page.locator('[data-provider-discovery="copilot"]')
  ).toContainText("Unavailable");
  await expect(
    page.locator(`[data-unsupported-model="${UNSUPPORTED_MODEL_ID}"]`)
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Open model ${UNSUPPORTED_MODEL_ID}` })
  ).toHaveCount(0);
  expect(await documentFitsViewport(page)).toBe(true);

  await page.goto("/providers?tab=providers");
  await expect(page.locator('[data-tab-panel="providers"]')).toBeVisible();
  const currentModel = page.locator(
    '[data-select="role-model-claude-default"]'
  );
  await expect(currentModel).toBeVisible();
  const currentOptions = await currentModel
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value)
    );
  expect(currentOptions).toEqual(["", "sonnet"]);
  expect(currentOptions).not.toContain(UNSUPPORTED_MODEL_ID);

  const staleModel = page.locator('[data-select="role-model-codex-default"]');
  await expect(staleModel).toBeDisabled();
  await expect(staleModel).toHaveAttribute("title", STALE_AVAILABILITY_TITLE);
  const staleForm = page.locator('[data-role-form="codex-default"]');
  await expect(staleForm.locator('input[name="model"]')).toHaveValue(
    "gpt-6-luna"
  );
});
