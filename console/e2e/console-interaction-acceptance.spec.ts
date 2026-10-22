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

import { waitForPageContent } from "./acceptance-helpers.ts";

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
