import { expect, test } from "@playwright/test";

import { CANONICAL_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * A table cell never cuts its text.
 *
 * A list table's budget is its content's measured need: the widest cell in
 * each column, or the column's own header, plus the inset the cell shares.
 * A budget below that need does not make the table smaller -- it cuts the
 * content, and a cut cell says less than the page knows.
 *
 * That is not a hypothetical. The workspaces table gave its Availability column
 * 132px, which is 12px short of what the badge in it needs, and the badge read
 * "Not obse…" on the page. A state the operator cannot read is a state the
 * page has not told them, and it is the one thing a status badge must not be.
 *
 * So this walks every table on every canonical route and asks the browser what
 * it actually laid out. A cell whose text does not fit is a cell whose column
 * is under budget.
 *
 * Two things are not that:
 *
 *   - Screen-reader-only text, which is laid out at a pixel's width on purpose.
 *   - A cell that carries its own whole text in a title, which is a deliberate
 *     truncation with the full text one hover away.
 *
 * A badge that carries its *own* label in its title is not a deliberate
 * truncation: the console's badge says so itself -- "A badge is an atomic
 * status word: it never wraps. A column that cannot fit a badge is a
 * column-width problem" -- so the title on a badge cannot excuse a cut badge.
 */
for (const route of CANONICAL_ROUTES) {
  test(`${route.path} does not cut the text in a table cell`, async ({
    page
  }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    const cut = await page.evaluate(() => {
      /** The screen-reader-only convention: laid out at a pixel's width. */
      const isHidden = (element: Element): boolean =>
        element.getBoundingClientRect().width <= 1;

      /** A region that scrolls does not cut its text; it scrolls to it. */
      const scrolls = (element: Element): boolean => {
        const overflow = getComputedStyle(element).overflowX;
        return overflow === "auto" || overflow === "scroll";
      };

      /** A cell that carries its own whole text in a title, on purpose. */
      const carriesItsOwnText = (element: Element): boolean => {
        const title = element.getAttribute("title");
        const text = (element.textContent ?? "").trim();
        return title !== null && title.includes(text);
      };

      /** What the element cuts, or null when it cuts nothing. */
      const cutBy = (element: Element): string | null => {
        if (element.children.length > 0) return null;
        const text = (element.textContent ?? "").trim();
        if (text.length === 0) return null;
        if (isHidden(element)) return null;
        if (scrolls(element)) return null;
        if (carriesItsOwnText(element)) return null;
        if (element.scrollWidth <= element.clientWidth + 1) return null;
        return `"${text.slice(0, 40)}" needs ${String(element.scrollWidth)}px and has ${String(element.clientWidth)}px`;
      };

      const findings: string[] = [];
      for (const cell of document.querySelectorAll(
        "main table td, main table th"
      )) {
        for (const element of cell.querySelectorAll("*")) {
          const finding = cutBy(element);
          if (finding !== null) findings.push(finding);
        }
      }
      return findings;
    });

    expect(
      cut,
      `${route.path} cuts the text of a table cell: ${cut.join("; ")}`
    ).toEqual([]);
  });
}
