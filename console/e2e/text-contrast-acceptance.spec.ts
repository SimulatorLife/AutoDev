import { expect, test } from "@playwright/test";

import {
  illegibleText,
  SWEEP_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * Every text the Console renders is legible.
 *
 * The Console is dark-only, and a dark surface is where contrast goes wrong:
 * a muted grey that reads well on white disappears on a near-black panel, and
 * the operator is left with a page that looks like it said something.
 *
 * The measurement lives in `illegibleText`: the colour the browser painted the
 * text with, against the colour it painted behind it, with every transparent
 * layer composited and every ancestor's opacity applied.
 */
const ROUTES = SWEEP_ROUTES;

for (const path of ROUTES) {
  test(`${path} renders legible text`, async ({ page }) => {
    await page.goto(path);
    await waitForPageContent(page);

    const failures = await illegibleText(page, "main *, nav *");

    expect(
      failures,
      `${path} renders text that is too faint to read: ${failures.join("; ")}`
    ).toEqual([]);
  });
}
