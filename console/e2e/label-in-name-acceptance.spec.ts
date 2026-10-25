import { expect, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

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

const ROUTES = [...CANONICAL_ROUTES, ...DETAIL_ROUTES];

for (const route of ROUTES) {
  test(`${route.path} names every control after what it shows`, async ({
    page
  }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    const problems = await page.evaluate(() => {
      const normalize = (value: string): string =>
        value
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, " ")
          .trim();

      const found: string[] = [];
      for (const element of document.querySelectorAll(
        "a[href], button, [role='button'], [role='link']"
      )) {
        if (
          element.getAttribute("aria-hidden") === "true" ||
          element.closest("[aria-hidden='true']") !== null
        ) {
          continue;
        }
        const visible = (element.textContent ?? "")
          .replaceAll(/\s+/g, " ")
          .trim();
        if (visible.length === 0) continue;

        // The stated name: an aria-label, or the elements an
        // aria-labelledby points at.
        let name = element.getAttribute("aria-label");
        if (name === null) {
          const labelledBy = element.getAttribute("aria-labelledby");
          if (labelledBy !== null) {
            name = labelledBy
              .split(/\s+/)
              .map(
                (id) =>
                  document.querySelector(`[id="${id}"]`)?.textContent ?? ""
              )
              .join(" ")
              .replaceAll(/\s+/g, " ")
              .trim();
          }
        }
        // No stated name: the control's name is its own content, so it
        // contains it by definition.
        if (name === null || name.trim().length === 0) continue;

        const stated = normalize(name);
        const missing = normalize(visible)
          .split(" ")
          .filter((word) => word.length > 1 && !stated.includes(word));
        if (missing.length > 0) {
          found.push(
            `"${visible}" names itself "${name}", which does not say ${missing.join(", ")}`
          );
        }
      }
      return found;
    });

    expect(
      problems,
      `${route.path} states a name that drops what it shows`
    ).toEqual([]);
  });
}
