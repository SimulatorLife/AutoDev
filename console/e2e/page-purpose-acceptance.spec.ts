import { expect, type Page, test } from "@playwright/test";
import {
  type CanonicalNavSection,
  canonicalSectionPurpose
} from "@simulatorlife/autodev-core";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * Every page says what its resource is for.
 *
 * The header names the surface -- "Providers", "Playtesting" -- and a name on
 * its own does not tell an operator what the surface owns. The target state
 * asks for both: "The page header names the surface and states its purpose".
 *
 * The purpose line used to be a prop each page passed to the shell, and that
 * is how Playtesting came to be the one resource whose header named a surface
 * without saying what it owns: the sentence was written seven times over on
 * that page's seven render paths, and none of the seven was the happy one.
 * The sentence now belongs to the resource, in the canonical navigation
 * registry, and the shell resolves it -- so the line is on every route for a
 * resource, including its detail pages and the states where the read failed.
 *
 * This is the guard for the other half of that: the sentence has to be
 * *rendered*, on every canonical route, and it has to be the canonical one.
 */

/**
 * The purpose line in the header, and the section it belongs to.
 */
async function statedPurpose(page: Page): Promise<{
  readonly section: string;
  readonly text: string;
}> {
  const purpose = page.locator("[data-page-purpose]");
  if ((await purpose.count()) === 0) return { section: "", text: "" };
  return {
    section: (await purpose.first().getAttribute("data-page-purpose")) ?? "",
    text: ((await purpose.first().textContent()) ?? "").trim()
  };
}

const ROUTES = [...CANONICAL_ROUTES, ...DETAIL_ROUTES];

/**
 * A page that says the resource does not exist, or that the read failed.
 *
 * Those pages explain their own state rather than the resource's purpose, and
 * they say so in the header. They are the one case where the line in the
 * header is not the resource's sentence.
 */
const STATE_PAGES =
  '[data-testid="not-found-page"], [data-testid="console-error-boundary"]';

for (const route of ROUTES) {
  test(`${route.path} says what its resource is for`, async ({ page }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    const purpose = await statedPurpose(page);
    expect(
      purpose.text.length,
      `${route.path} names the resource without saying what it is for`
    ).toBeGreaterThan(0);

    // A page that reports a missing resource or a failed read explains that
    // state instead, and says it in the header.
    if ((await page.locator(STATE_PAGES).count()) > 0) {
      return;
    }

    // Otherwise the line has to be the canonical sentence for the resource the
    // route belongs to -- not a sentence of its own, and not the sentence of
    // some other resource.
    const canonical = canonicalSectionPurpose(
      purpose.section as CanonicalNavSection
    );
    expect(
      purpose.text,
      `${route.path} states a purpose that is not the canonical sentence for ` +
        `"${purpose.section}"`
    ).toBe(canonical);
  });
}
