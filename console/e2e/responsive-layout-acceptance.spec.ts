import { expect, type Page, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  clippedContent,
  documentStructure,
  routeHeading
} from "./acceptance-helpers.ts";

/**
 * The widths the Console is read at.
 *
 * 390 is a phone, 768 is a tablet, and 1280 is the width at which the
 * navigation stops being a rail and becomes a column beside the page. The
 * middle one matters as much as the ends: it is the width at which the
 * navigation is still a rail but the page has room for two columns, and the
 * layouts that break are usually the ones that break there.
 */
const WIDTHS: readonly number[] = [390, 768, 1280];

/**
 * Wait until the page's own content has replaced its loading shell.
 *
 * The Console streams a page: the shell and its loading state arrive first and
 * the resource's own content is swapped in afterwards. Measuring the shell
 * would measure the placeholder rather than the page.
 */
async function waitForPageContent(page: Page): Promise<void> {
  await expect(page.locator("[data-feature]").first()).toBeVisible();
  await expect(page.locator("[data-console-loading]")).toHaveCount(0);
}

/**
 * What is wrong with one page at one width, said in a sentence.
 */
async function findProblems(
  page: Page,
  routePath: string,
  width: number
): Promise<readonly string[]> {
  const problems: string[] = [];

  const clipped = await clippedContent(page);
  for (const finding of clipped) {
    problems.push(
      `${routePath} at ${width}px clips ${finding.description} by ${finding.overflowPx}px`
    );
  }

  const structure = await documentStructure(page);
  const levelOne = structure.headings.filter((heading) => heading.level === 1);
  if (levelOne.length !== 1) {
    problems.push(
      `${routePath} at ${width}px has ${levelOne.length} level-one headings`
    );
  }
  structure.headings.forEach((heading, index) => {
    const previous = structure.headings[index - 1];
    if (previous !== undefined && heading.level > previous.level + 1) {
      problems.push(
        `${routePath} at ${width}px skips from h${previous.level} to h${heading.level} at "${heading.text}"`
      );
    }
  });
  for (const id of structure.duplicateIds) {
    problems.push(`${routePath} at ${width}px repeats the id "${id}"`);
  }

  return problems;
}

/**
 * How many routes are measured at once.
 *
 * Each route opens on its own page, so one route's slow read cannot hold
 * another route's answer back. Four at a time is as many as the browser can
 * hold: opening all fourteen at once took the whole browser down with its
 * last page, and the failure looked like a broken page rather than a broken
 * harness.
 */
const ROUTES_PER_BATCH = 4;

/**
 * Split a list into batches of a given size.
 */
function batches<T>(
  items: readonly T[],
  size: number
): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    // The width is in the test's own name, not only in the group's: the
    // browser here runs one test at a time, because the sandbox's
    // single-process headless shell goes down with its last page, and a
    // title shared by three tests cannot be told apart to run it on its own.
    test(`every canonical route fits ${width}px`, async ({ context }) => {
      const problems = await Promise.all(
        batches(CANONICAL_ROUTES, ROUTES_PER_BATCH).map(async (batch) => {
          const pages = await Promise.all(batch.map(() => context.newPage()));
          const batchProblems = await Promise.all(
            batch.map(async (route, index) => {
              const page = pages[index]!;
              await page.goto(route.path);
              await expect(routeHeading(page, route)).toBeVisible();
              await waitForPageContent(page);
              return findProblems(page, route.path, width);
            })
          );
          await Promise.all(pages.map((page) => page.close()));
          return batchProblems.flat();
        })
      );

      expect(problems.flat()).toEqual([]);
    });
  });
}
