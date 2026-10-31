import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * A control's accessible name contains what the control shows.
 *
 * The target state asks for both halves of a link's name: it says what the
 * link points at, and it still contains the text that is visible, so that a
 * voice-control user can say the word they can see and find the control that
 * says it.
 *
 * A stated name replaces the control's own content, so a name that leaves a
 * visible word out does not merely differ from the screen -- it removes it.
 * The Console had four families of that:
 *
 *   - the providers' "Docs ↗" link named itself "Open claude documentation in
 *     a new tab", which does not contain "Docs", while its sibling "Usage ↗"
 *     happened to work only because its name repeated the word;
 *   - the agents' role link showed "browser-tester (Leaf)" and named itself
 *     "Open agent browser-tester", so the kind was on the page and in nobody's
 *     announcement;
 *   - the workspaces' approval link showed the approval's state -- "Not
 *     approved" -- and named itself "Open playtesting approval for
 *     <workspace>", so the state was reachable by sight alone;
 *   - the evaluations' target link showed the role and named itself "Open
 *     detail for evaluation eval-0001", so a page of fifty rows over six
 *     roles said which run it was and not what it was about.
 *
 * This is a rendering claim about every route, so it is measured on every
 * route, in the browser, rather than read off the source of a few views.
 */

const ROUTES = SWEEP_ROUTES;

const CONTROLS = "a[href], button, [role='button'], [role='link']";

for (const path of ROUTES) {
  test(`${path} names every control after what it shows`, async ({ page }) => {
    await page.goto(path);
    await waitForPageContent(page);

    const controls = page.locator(CONTROLS);
    // The rendered text, which is what an operator reads: the DOM's own text
    // content would also carry the screen-reader-only text and would run two
    // inline elements together.
    const shown = await controls.allInnerTexts();
    const stated = await controls.evaluateAll((elements) =>
      elements.map((element) => {
        if (
          element.getAttribute("aria-hidden") === "true" ||
          element.closest("[aria-hidden='true']") !== null
        ) {
          return null;
        }
        const aria = element.getAttribute("aria-label");
        if (aria !== null) return aria;
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy === null) return "";
        return labelledBy
          .split(/\s+/)
          .map(
            (id) => document.querySelector(`[id="${id}"]`)?.textContent ?? ""
          )
          .join(" ")
          .replaceAll(/\s+/g, " ")
          .trim();
      })
    );

    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, " ")
        .trim();

    const problems: string[] = [];
    shown.forEach((visible, index) => {
      const name = stated[index];
      if (name === null || name === undefined) return;
      const words = visible.replaceAll(/\s+/g, " ").trim();
      if (words.length === 0) return;
      // No stated name: the control's name is its own content, so it contains
      // it by definition.
      if (name.trim().length === 0) return;
      const spoken = normalize(name);
      const missing = normalize(words)
        .split(" ")
        .filter((word) => word.length > 1 && !spoken.includes(word));
      if (missing.length > 0) {
        problems.push(
          `"${words}" names itself "${name}", which does not say ${missing.join(", ")}`
        );
      }
    });

    expect(problems, `${path} states a name that drops what it shows`).toEqual(
      []
    );
  });
}
