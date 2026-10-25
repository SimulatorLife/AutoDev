import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * A filter that matches nothing says so in its own words.
 *
 * The target state is explicit: "found matching the current criteria" is not
 * "are configured". A list that is empty because the operator narrowed it and
 * a list that is empty because it holds nothing are two different facts, and
 * the message has to say which of them it is -- the second is a claim about
 * something the operator did, so it may only be made when they did it.
 *
 * The memory's records table made it the other way round: it said "no memory
 * records found matching the current criteria" whether or not a filter had
 * been applied, so an operator who opened the memory for a workspace that
 * holds no records yet was told that a filter they never touched had removed
 * them.
 *
 * Each list here is narrowed with a search that cannot match, and the empty
 * state has to name the criteria.
 */

/**
 * A list, and the query that narrows it to nothing.
 */
const SEARCHABLE_LISTS: readonly {
  readonly path: string;
  readonly query: string;
}[] = [
  { path: "/prompts", query: "q" },
  { path: "/tools", query: "q" },
  { path: "/memory", query: "query" }
];

for (const list of SEARCHABLE_LISTS) {
  test(`${list.path} says a filter that matched nothing matched nothing`, async ({
    page
  }) => {
    const params = new URLSearchParams();
    params.set(list.query, "no-such-thing-matches-this");
    await page.goto(`${list.path}?${params.toString()}`);
    await waitForPageContent(page);

    const body = ((await page.locator("main").textContent()) ?? "")
      .replaceAll(/\s+/g, " ")
      .trim();

    expect(
      body,
      `${list.path} narrowed by a search that cannot match says the criteria ` +
        "matched nothing"
    ).toContain("matching the current criteria");
    expect(
      body,
      `${list.path} does not blame a filter that was never applied`
    ).not.toContain("are configured.");
  });
}
