/**
 * The canonical skill's convergence, driven in a browser.
 *
 * A skill reaches the runtime as a link to the canonical source itself, so
 * the runtime's observed state is the very source the operator is editing.
 * The page has to say so rather than leaving the operator to assume it: the
 * generations behind the verdict, and the operation history the Runtime
 * recorded for the resource.
 */
import { expect, test } from "@playwright/test";

const SKILL_ROUTE = "/skills/code-review";
const RECONCILIATION = '[data-section="skill-reconciliation"]';
const DESIRED_GENERATION = '[data-field="desired-generation"]';
const OBSERVED_GENERATION = '[data-field="observed-generation"]';
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

test("the skill page reports the runtime's observation of the canonical source", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SKILL_ROUTE);

  const panel = page.locator(RECONCILIATION);
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Converged", { exact: true })).toBeVisible();

  const desired = panel.locator(DESIRED_GENERATION);
  const observed = panel.locator(OBSERVED_GENERATION);
  await expect(desired).toHaveText(REVISION_PATTERN);
  await expect(observed).toHaveText(REVISION_PATTERN);
  // The runtime reads the canonical source itself, so the observed generation
  // is that source's revision rather than a second revision that happens to
  // agree with it.
  await expect(observed).toHaveText((await desired.textContent()) ?? "");
});

test("the skill page states that no operation has been recorded for the resource", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SKILL_ROUTE);

  const panel = page.locator(RECONCILIATION);
  await expect(panel).toBeVisible();
  // An empty history is an explicit state, not a blank list.
  await expect(
    panel.getByText("No recorded operations for this resource.", {
      exact: true
    })
  ).toBeVisible();
});
