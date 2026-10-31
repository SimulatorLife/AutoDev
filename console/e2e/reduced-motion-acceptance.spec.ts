import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * No motion runs when the operator has asked for reduced motion.
 *
 * The target state names it in the acceptance contract: "Accessibility:
 * named controls, live-region announcement without incessant focus changes,
 * accessible data tables, reduced motion."
 *
 * The console had one animation -- the pulsing dot that says a session is
 * live -- and it pulsed whether or not the operator had asked the system not
 * to move things on the page. A pulse is the easiest animation to write and
 * the one nobody checks, because it is a two-pixel dot and it looks
 * deliberate.
 *
 * The check is the browser's own answer rather than a reading of the source:
 * the page is rendered with `prefers-reduced-motion: reduce` emulated, and
 * every element is asked whether it is still animating. A class that honours
 * the preference stops the animation; a class that does not keeps running it,
 * and the difference is measurable.
 */
test("no motion runs when the operator asked for reduced motion", async ({
  page
}) => {
  const moving: string[] = [];
  let measured = 0;

  for (const path of SWEEP_ROUTES) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const findings: string[] = [];
      let counted = 0;
      for (const element of Array.from(document.querySelectorAll("main *"))) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (element.closest("[hidden]")) continue;
        if (!element.checkVisibility()) continue;
        // Every rendered element is examined, whether or not it animates: the
        // count is what says the sweep read the page rather than an error
        // page.
        counted += 1;
        if (style.animationName === "none") continue;
        // An animation that is paused is not motion.
        if (style.animationPlayState === "paused") continue;
        findings.push(
          `<${element.tagName.toLowerCase()}> ${style.animationName} "${(element.textContent ?? "").trim().slice(0, 24)}"`
        );
      }
      return { findings, counted };
    });

    measured += found.counted;
    for (const finding of found.findings) moving.push(`${path}: ${finding}`);
  }

  expect(
    moving,
    "an operator who asked for reduced motion must not be given motion: the preference is a system setting, and a pulse is the animation nobody checks"
  ).toEqual([]);
  // The sweep has to have read something: a Console that failed to render would
  // answer every route with an error page, and an error page animates nothing
  // -- so a sweep that found nothing would pass the rule above without having
  // looked at a single element.
  expect(
    measured,
    "the sweep has to read the elements the Console renders, not an error page"
  ).toBeGreaterThan(20);
});
