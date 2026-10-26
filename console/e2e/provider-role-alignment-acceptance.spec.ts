import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The role strip is an aligned configuration, so its columns line up.
 *
 * Each provider carries four fixed roles, and each role's row is a strip of
 * controls: the role's label, its priority, its model, and its reasoning
 * effort. The strip is a *grid* precisely so that the four rows' controls
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
                row.querySelector<HTMLSelectElement>(`select[name="${name}"]`)
              )
              .filter((select): select is HTMLSelectElement => select !== null)
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
      expect(strip.roles, "each strip carries the four fixed roles").toBe(4);
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
