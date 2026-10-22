/**
 * The provider's own convergence, driven in a browser.
 *
 * A provider's routing configuration is Runtime-owned: the router serves the
 * live routing policy, so the runtime's observed state is the configuration it
 * holds. The page has to say so rather than leaving the operator to assume it:
 * the verdict behind the generations, the generations themselves, and the
 * operation history the Runtime recorded for the provider.
 */
import { expect, test } from "@playwright/test";

const PROVIDER_ROUTE = "/providers/claude";
const RECONCILIATION = '[data-section="provider-reconciliation"]';
const DESIRED_GENERATION = '[data-field="desired-generation"]';
const OBSERVED_GENERATION = '[data-field="observed-generation"]';
const GENERATION_PATTERN = /^[a-f0-9]{64}$/u;

test("the provider page reports the runtime's view of the provider", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROVIDER_ROUTE);

  const panel = page.locator(RECONCILIATION);
  await expect(panel).toBeVisible();
  // Nothing has been applied to this provider, so the runtime has observed
  // nothing. The page says so instead of claiming a convergence it was never
  // told about.
  await expect(panel.locator('[data-status="not-observed"]')).toBeVisible();

  const desired = panel.locator(DESIRED_GENERATION);
  const observed = panel.locator(OBSERVED_GENERATION);
  // The desired generation identifies the provider's configured routing state,
  // and the runtime reports it even before anything has been applied.
  await expect(desired).toHaveText(GENERATION_PATTERN);
  // The observation is missing, and a missing observation reads as missing
  // rather than as an empty value.
  await expect(observed).toHaveText("Not observed");
});

test("the provider page states that no operation has been recorded for the provider", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROVIDER_ROUTE);

  const panel = page.locator(RECONCILIATION);
  await expect(panel).toBeVisible();
  // An empty history is an explicit state, not a blank list.
  await expect(
    panel.getByText("No recorded operations for this resource.", {
      exact: true
    })
  ).toBeVisible();
});
