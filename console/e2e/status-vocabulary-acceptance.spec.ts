import { expect, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * A status badge names the state it shows.
 *
 * The Console's status badge is a word. It is the one place the Console says
 * what it observed, and the word is the whole of what it says: the dot beside
 * it is a mark, not a meaning, and a reader who cannot read the word is left
 * with a shape.
 *
 * The badge used to render *no* word for a status it did not have a variant
 * for. The Agents table's STATUS column showed a bare grey pill -- the label
 * span was empty, the title was `undefined`, and there was no accessible name
 * at all, so a screen reader was told nothing either. The cause was the shape
 * of the lookup rather than the data: the badge read the status out of a table
 * keyed by the states the Console knows, and a status outside that table had
 * no entry, so the word was `undefined` and React rendered nothing for it.
 *
 * Nothing in the type system said so. The status came off the wire as a
 * string, and the console's own model declared it as one of five states, so
 * the compiler was satisfied and the page was blank.
 *
 * This is a rendering claim, so it is measured where it happens: in the
 * browser, on every route, over every element that carries a status. A mark
 * (`role="img"`) is named by its accessible name and is allowed to have no
 * text; anything else that carries a status has to show a word.
 */
test("every status the Console shows is named", async ({ page }) => {
  const unnamed: string[] = [];
  let seen = 0;

  for (const route of [...CANONICAL_ROUTES, ...DETAIL_ROUTES]) {
    await page.goto(route.path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const findings: string[] = [];
      let counted = 0;
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>("[data-status]")
      )) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (element.closest("[hidden]")) continue;
        counted += 1;
        // A dot is a mark: it is named by its accessible name, and the word
        // lives in the control beside it.
        if (element.getAttribute("role") === "img") continue;
        const shown = (element.textContent ?? "").trim();
        if (shown.length > 0) continue;
        findings.push(
          `${element.dataset.status ?? "(no status)"} in a ${element.tagName.toLowerCase()}`
        );
      }
      return { findings, counted };
    });

    seen += found.counted;
    for (const finding of found.findings)
      unnamed.push(`${route.path}: ${finding}`);
  }

  expect(
    unnamed,
    "a status the Console shows has to name itself: a badge with no word tells the operator nothing"
  ).toEqual([]);
  // The sweep has to have read something. A Console that failed to render would
  // answer every route with an error page, and an error page carries no status
  // at all -- so a sweep that found nothing would pass the rule above without
  // having looked at a single badge.
  expect(
    seen,
    "the sweep has to read the statuses the Console renders, not an error page"
  ).toBeGreaterThan(60);
});
