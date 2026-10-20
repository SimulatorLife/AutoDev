import type { Locator, Page } from "@playwright/test";

/**
 * One stat card of a page, addressed by its title.
 *
 * The cards are definition lists, so the title is the term and the value and
 * the subtitle belong to the same list. Addressing the card by its term
 * keeps an assertion about the card rather than about a number, which
 * appears in several places on a page -- a sidebar badge, a filter summary
 * and a pager can all carry the same figure.
 */
export function statCard(page: Page, title: string): Locator {
  return page.locator("dl").filter({
    has: page.locator("dt").filter({ hasText: title })
  });
}

/**
 * The stat grid of a page, the row of cards above its content.
 */
export function statGrid(page: Page): Locator {
  return page.locator("[data-stat-grid]");
}
