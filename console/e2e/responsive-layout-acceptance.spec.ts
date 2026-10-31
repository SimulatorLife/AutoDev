import { expect, type Page, test } from "@playwright/test";

import {
  clippedContent,
  documentStructure,
  expectRouteHeading,
  headingClipping,
  SWEEP_SURFACES,
  waitForPageContent
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
 * Every surface the sweep measures.
 *
 * The list routes and the detail routes are measured together because the
 * claim is about the Console and not about one kind of page: a detail view
 * that is a list view's narrow neighbour has the same obligation to fit the
 * width it is read at.
 *
 * The sections' own views are measured too, for the same reason: the Memory
 * page's tabs, the Playtesting page's four views, the Evaluations page's
 * comparisons and the Usage dashboard's live scope each carry their own
 * tables, and the canonical route never reaches any of them.
 */
const SURFACES = SWEEP_SURFACES;

/**
 * What is wrong with one page at one width, said in a sentence.
 */
async function findProblems(
  page: Page,
  routePath: string,
  width: number
): Promise<readonly string[]> {
  const problems: string[] = [];

  // The page's own name has to be readable. It is drawn in the header rather
  // than in the body, so the clipped-content sweep below never sees it -- and
  // it used to be clipped to a third of its width on a phone, where every page
  // read "M...". The heading carries its full name on its hover title, which
  // is no way to read it on a phone.
  const headingOverflow = await headingClipping(page);
  if (headingOverflow > 1) {
    problems.push(
      `${routePath} at ${width}px clips the page's own heading by ${headingOverflow}px`
    );
  }

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
 *
 * The batch size is settable because the single-process browser a constrained
 * machine has to use cannot hold four pages at once: the second `newPage()`
 * takes the browser down, and the acceptance fails inside the harness rather
 * than on a page. `playwright.sandbox.config.ts` sets it to one for that
 * browser, and the default of four is right for the multi-process one.
 */
const ROUTES_PER_BATCH = Math.max(
  1,
  Number(process.env.AUTODEV_ACCEPTANCE_ROUTES_PER_BATCH ?? "4") || 4
);

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

    /**
     * The timeout this spec needs, and the reason it needs it.
     *
     * One test here opens every canonical and detail route and measures it, so
     * a test that took thirty seconds was never going to finish: the default
     * timeout is meant for a test that does one thing. Measured against a
     * Console serving nineteen routes, the widths took minutes, and the run
     * failed inside `page.goto` -- a timeout reported as a page failure,
     * which reads like a broken page rather than a short clock.
     */
    test.setTimeout(600_000);

    // The width is in the test's own name, not only in the group's: the
    // browser here runs one test at a time, because the sandbox's
    // single-process headless shell goes down with its last page, and a
    // title shared by three tests cannot be told apart to run it on its own.
    test(`every canonical route fits ${width}px`, async ({ context }) => {
      const problems = await Promise.all(
        batches(SURFACES, ROUTES_PER_BATCH).map(async (batch) => {
          const pages = await Promise.all(batch.map(() => context.newPage()));
          const batchProblems = await Promise.all(
            batch.map(async (route, index) => {
              const page = pages[index]!;
              await page.goto(route.path);
              await expectRouteHeading(page, route);
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
