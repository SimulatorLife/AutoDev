import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The role strip is an aligned configuration, so its columns line up.
 *
 * Each provider carries two fixed roles, and each role's row is a strip of
 * controls: the role's label, its priority, its model, and its reasoning
 * effort. The strip is a *grid* precisely so that the rows' controls
 * start at the same x position and the eye can scan down a column -- the
 * operator compares priorities across roles, and a column that drifts makes
 * that comparison a hunt.
 *
 * The label column is the one track that can break that. Sized to its own
 * content (`max-content`), every row sized its own label track to its own
 * label, so the four rows' controls started at four different x positions:
 * measured in Chromium against the production build, the priority column
 * drifted 38px between `Smart` and `Orchestrator`, and the model column
 * drifted with it.
 *
 * The other half of the repair is that a fixed label column must still fit
 * the longest label. `Orchestrator`, with its icon, needs 92px, and the
 * column is 92px -- so this sweep also checks that no role label is cut by
 * the column it sits in.
 */
const ROUTES = ["/providers", "/providers/claude"];
const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;

for (const route of ROUTES) {
  test(`${route} lines the role strip's columns up`, async ({ page }) => {
    await page.goto(route);
    await waitForPageContent(page);

    const strips = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-provider-roles]")).map(
        (strip) => {
          const rows = Array.from(strip.querySelectorAll(":scope > li"));
          const leftsOf = (name: string): number[] =>
            rows
              .map((row) =>
                // The Subagent model is the hierarchical select's closed
                // control rather than a native select.
                row.querySelector<HTMLElement>(
                  `select[name="${name}"], [data-hierarchical-select] > span[id^="select-${name}-"]`
                )
              )
              .filter((select): select is HTMLElement => select !== null)
              .map((select) => Math.round(select.getBoundingClientRect().left));
          const clippedLabels = rows
            .map((row) => row.querySelector<HTMLElement>(":scope > span"))
            .filter((label): label is HTMLElement => label !== null)
            .filter((label) => label.scrollWidth > label.clientWidth + 0.5)
            .map((label) => (label.textContent ?? "").trim());
          return {
            roles: rows.length,
            priorityLefts: leftsOf("priority"),
            modelLefts: leftsOf("model"),
            clippedLabels
          };
        }
      )
    );

    expect(
      strips.length,
      "the page renders provider role strips"
    ).toBeGreaterThan(0);
    for (const strip of strips) {
      expect(strip.roles, "each strip carries the two fixed roles").toBe(2);
      expect(
        new Set(strip.priorityLefts).size,
        `the priority column starts at one x position, not ${strip.priorityLefts.join(", ")}`
      ).toBe(1);
      expect(
        new Set(strip.modelLefts).size,
        `the model column starts at one x position, not ${strip.modelLefts.join(", ")}`
      ).toBe(1);
      expect(
        strip.clippedLabels,
        "a role label is cut by the column it sits in"
      ).toEqual([]);
    }
  });
}

test("the Subagent model opens to each agent role and applies a role's own model", async ({
  page
}) => {
  const reset = await page.request.post(
    `${FIXTURE_BASE_URL}/fixture/providers/roles?state=reset`
  );
  expect(reset.ok()).toBe(true);
  await page.goto("/providers/claude");
  await waitForPageContent(page);

  const control = page.locator(
    '[data-hierarchical-select="select-model-claude-subagent"]'
  );
  const menu = page.locator("#select-model-claude-subagent-menu");
  await expect(menu).toBeHidden();
  await control.click();
  await expect(menu).toBeVisible();
  // The opened menu sits below the role's controls, inside the strip, and is
  // not clipped by it.
  const [controlBox, menuBox] = await Promise.all([
    control.boundingBox(),
    menu.boundingBox()
  ]);
  expect(menuBox!.y).toBeGreaterThan(controlBox!.y + controlBox!.height - 1);
  for (const level of ["All subagents", "explorer", "worker", "smart"]) {
    await expect(menu.getByText(level, { exact: true })).toBeVisible();
  }

  await menu.locator('[data-hierarchical-level="explorer"] > summary').click();
  await menu
    .locator('[data-hierarchical-level="explorer"] button[value="sonnet"]')
    .click();
  await waitForPageContent(page);
  await expect(page).toHaveURL(/\/providers\/claude(?:\?|$)/u);
  await expect(
    page.locator('[data-hierarchical-select="select-model-claude-subagent"]')
  ).toContainText("+1");
});
