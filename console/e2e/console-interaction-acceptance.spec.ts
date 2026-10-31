/**
 * The Console's interaction contract, measured in a browser.
 *
 * Two properties that only a browser can answer, and that a unit test on the
 * markup cannot: a control that is working keeps the operator's place, and a
 * region that scrolls is reachable by a keyboard.
 *
 * Both were found by measuring the Console rather than by reading it. The
 * prompt preview disabled its control while the request was in flight, and a
 * disabled control is dropped out of the page's focus order the moment it is
 * disabled, so the operator who pressed it lost their place in the document.
 * The permission matrix scrolled sideways with nothing focusable inside it, so
 * its right-hand columns were reachable with a pointer and by nothing else.
 */

import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

const AGENTS_ROUTE = "/agents";
const PROMPT_ROUTE = "/prompts/review";
const PROMPT_PREVIEW = '[data-button="prompt-preview"]';
const TABLE_REGION = '[role="region"]';

/**
 * The width at which the Console's tables are wider than the viewport.
 */
const PHONE_WIDTH = 390;
const PHONE_HEIGHT = 844;

/**
 * The delay the preview's request is held for.
 *
 * Without it the pending state is a frame nobody sees, and the measurement
 * would be of a control that had already finished working.
 */
const PREVIEW_DELAY_MS = 1500;

test("a table that scrolls is reachable by a keyboard", async ({ page }) => {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await page.goto(AGENTS_ROUTE);
  await waitForPageContent(page);

  const region = page.locator(TABLE_REGION).first();
  await expect(region).toBeVisible();

  // The region is where the table scrolls, so it has to scroll here: the table
  // is wider than the viewport at this width.
  const scrolls = await region.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1
  );
  expect(scrolls).toBe(true);

  // The region takes focus, and the arrow keys scroll it.
  await region.focus();
  const before = await region.evaluate((element) => element.scrollLeft);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => region.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before);
});

test("a control that is working keeps the operator's place", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/prompts/preview", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, PREVIEW_DELAY_MS);
    });
    await route.continue();
  });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const preview = page.locator(PROMPT_PREVIEW);
  await preview.focus();
  await preview.click();

  // The control is working: it says so, and it is not a disabled control. A
  // disabled control is dropped out of the page's focus order the moment it is
  // disabled, which is the failure this measures.
  await expect(preview).toHaveAttribute("aria-disabled", "true");
  await expect(preview).toHaveText("Previewing…");
  const disabledWhileWorking = await preview.evaluate(
    (element) => (element as HTMLButtonElement).disabled
  );
  expect(disabledWhileWorking).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.dataset.button ?? null
    )
  ).toBe("prompt-preview");

  // The answer leaves the focus where the operator left it.
  await expect(page.locator("[data-prompt-unsaved-preview]")).toHaveAttribute(
    "data-prompt-unsaved-preview",
    "observed"
  );
  expect(
    await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.dataset.button ?? null
    )
  ).toBe("prompt-preview");
});

/**
 * A control that can act is a pointer target.
 *
 * The user agent's default for `<button>` is `cursor: default`, which
 * contradicts the Console: a button that looks like a button and behaves like
 * one is a target, and the pointer is the cheapest signal an operator has
 * that it is.
 *
 * The shared button vocabulary says so for the buttons it renders. A button
 * rendered outside that vocabulary did not: the command palette's trigger -- on
 * every page of the Console -- the Playtesting page's own controls, the error
 * page's "Try again". Each one hand-written, each one asking for the default
 * arrow while looking like a button and behaving like one.
 *
 * This is a rendering claim about a computed style, so it is measured where it
 * happens: in the browser, on every route, over every button that can act. A
 * control that cannot act -- a disabled one, a busy one -- is not a target and
 * is not asked to be one.
 */
test("a control that can act is a pointer target", async ({ page }) => {
  const offenders: string[] = [];
  let seen = 0;

  for (const path of SWEEP_ROUTES) {
    await page.goto(path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const findings: string[] = [];
      let counted = 0;
      for (const element of Array.from(
        document.querySelectorAll<HTMLButtonElement>("button")
      )) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (element.closest("[hidden]")) continue;
        // A control that cannot act is not a target, so it is not asked to
        // look like one.
        if (element.disabled) continue;
        if (element.getAttribute("aria-disabled") === "true") continue;
        counted += 1;
        if (style.cursor === "pointer") continue;
        findings.push(
          `"${(element.textContent ?? "").trim().slice(0, 40)}" shows ${style.cursor}`
        );
      }
      return { findings, counted };
    });

    seen += found.counted;
    for (const finding of found.findings) offenders.push(`${path}: ${finding}`);
  }

  expect(
    offenders,
    "a button that can act must not show the default arrow: the pointer is the cheapest signal that it is a target"
  ).toEqual([]);
  // The sweep has to have read something. A Console that failed to render would
  // answer every route with an error page, and an error page carries no button
  // at all -- so a sweep that found nothing would pass the rule above without
  // having looked at a single control.
  expect(
    seen,
    "the sweep has to read the buttons the Console renders, not an error page"
  ).toBeGreaterThan(20);
});
