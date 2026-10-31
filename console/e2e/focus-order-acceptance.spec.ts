import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The focus order is the page's own.
 *
 * The keyboard reaches a control in the order the page puts it in, and that is
 * the order a screen reader user expects as well. A control that is taken out
 * of that order -- a positive `tabindex` -- is a control the keyboard reaches
 * before the page has said anything, and it is the usual way a focus bug gets
 * "fixed" by making the page worse.
 *
 * The other half is the control that is hidden from assistive technology but
 * still takes focus: a screen reader user tabs into something nobody can
 * name, and the page has told them nothing about where they are.
 *
 * The sweep that found this class in the Console found nothing to fix, which
 * is the point of taking it: the two rules hold, and this is what holds them.
 */
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

const ROUTES = SWEEP_ROUTES;

for (const path of ROUTES) {
  test(`${path} keeps the focus order the page has`, async ({ page }) => {
    await page.goto(path);
    await waitForPageContent(page);

    const findings = await page.evaluate((focusable) => {
      const results: string[] = [];
      for (const element of document.querySelectorAll(focusable)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;

        // A control hidden from assistive technology that still takes focus.
        if (element.closest('[aria-hidden="true"]') !== null) {
          results.push(
            `focusable inside aria-hidden: <${element.tagName.toLowerCase()}> "${(element.textContent ?? "").trim().slice(0, 24)}"`
          );
        }

        // A control taken out of the page's own order.
        const tabIndex = element.getAttribute("tabindex");
        if (tabIndex !== null && Number(tabIndex) > 0) {
          results.push(`positive tabindex=${tabIndex}`);
        }
      }
      return results;
    }, FOCUSABLE);

    expect(
      findings,
      `${path} takes the focus out of the page's order: ${findings.join("; ")}`
    ).toEqual([]);
  });
}
