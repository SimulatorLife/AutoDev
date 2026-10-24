import { expect, type Page, test } from "@playwright/test";

import { CANONICAL_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The list tables have to fit the column they are given.
 *
 * A table's width is the sum of its declared column weights, and the Console
 * gives a list table one content column. When the sum is larger than that
 * column, the table scrolls sideways and a column ends up past the right edge
 * of the page: the agents table's MCPs column, the MCPs table's Connection
 * column and the providers table's Agent Limits column were all off-screen at
 * 1440, and the providers table's reasoning-effort selector -- one of the three
 * controls every role carries -- was only reachable by scrolling a table whose
 * own border gave no sign that there was anything to the right.
 *
 * The budgets were larger than the room they were declared against, so the
 * scroll bought nothing: the same columns and the same values fit inside the
 * content column once the weights were measured against it.
 *
 * This spec is where that claim belongs, because it is a layout claim: the
 * width a table gets is a measurement, not a constant, and it changes with the
 * viewport, the navigation and the page's own chrome.
 */

/**
 * The width the Console is read at on a desktop.
 *
 * 1440 is the width at which the navigation is a column beside the page and
 * the content column is at its widest for a laptop, which is where the tables
 * either fit or do not.
 */
const DESKTOP_WIDTH = 1440;

/**
 * The routes that render a list table.
 *
 * The hooks, evaluations, memory and playtesting pages render their own
 * surfaces rather than a catalogue table, so they are measured by the pages
 * that own the tables they do have.
 */
const LIST_ROUTES = CANONICAL_ROUTES.filter(
  (route) =>
    route.path !== "/hooks" &&
    route.path !== "/evaluations" &&
    route.path !== "/memory" &&
    route.path !== "/playtesting"
);

test.use({ viewport: { width: DESKTOP_WIDTH, height: 900 } });

/**
 * What is wrong with one table on one page, said in a sentence.
 */
async function findProblems(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];

    for (const table of document.querySelectorAll("table")) {
      const region = table.parentElement;
      if (region === null) continue;

      const overflow = region.scrollWidth - region.clientWidth;
      if (overflow > 1) {
        problems.push(
          `the table is ${String(overflow)}px wider than the column it is given, ` +
            "so a column sits past the right edge of the page"
        );
      }

      // A table brings its own box. A panel around it is a box inside a box:
      // two competing edges, and 42px of the content column spent on padding
      // and a border the table does not need. A padded, bordered ancestor is
      // what that wrapper looks like from the outside.
      for (
        let ancestor = region.parentElement;
        ancestor !== null;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const bordered = Number.parseFloat(style.borderTopWidth) > 0;
        const padded = Number.parseFloat(style.paddingLeft) >= 16;
        if (bordered && padded) {
          problems.push(
            "the table sits inside a bordered, padded panel, so it gets less of " +
              "the content column than every other table and reads as a box in a box"
          );
          break;
        }
      }
    }

    return problems;
  });
}

for (const route of LIST_ROUTES) {
  test(`${route.path} gives its table the whole content column`, async ({
    page
  }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    expect(await findProblems(page)).toEqual([]);
  });
}

test("every list table is given the same content column", async ({ page }) => {
  // One width for every table is the unification this is really about: a table
  // that gets 42px less than its neighbour because its page wrapped it in a
  // panel is a table whose columns have to be budgeted against two different
  // rooms.
  const widths: number[] = [];

  for (const route of LIST_ROUTES) {
    await page.goto(route.path);
    await waitForPageContent(page);
    const width = await page.evaluate(() => {
      const table = document.querySelector("table");
      return table?.parentElement?.clientWidth ?? null;
    });
    if (width !== null) widths.push(width);
  }

  expect(widths.length).toBeGreaterThan(0);
  expect([...new Set(widths)]).toEqual([widths[0]]);
});
