import { expect, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * Every moment the Console shows is shown in one form.
 *
 * "When did this happen" was answered in seven spellings across the Console.
 * The memory records table read a record's update as `2/11/2026` -- a date
 * whose order is ambiguous to anyone outside the United States, with no time
 * in it. The memory detail lines beside it read `2/11/2026, 3:00:12 AM`,
 * which is worse: `toLocaleString()` renders in the *server's* zone, so the
 * time is the time of whichever machine answered the request rather than of
 * the operator reading it. The GitHub page printed the raw wire value,
 * `2026-02-11T03:00:12.000Z`, milliseconds and all. The evaluations table
 * spoke the zone as `Z` and the usage trace spoke the same zone as `UTC`.
 *
 * An instant is one quantity, so it has one rendering, the way a duration has
 * one. This is a rendering claim, so it is measured where it happens: in the
 * browser, on every route, over the text a reader actually sees.
 *
 * The two shapes the Console uses are the date alone, `2026-02-11`, and the
 * date with its clock and its zone, `2026-02-11 03:00:12 UTC`. A source that
 * stated a zone that is not UTC keeps it, because relabelling `+02:00` as UTC
 * would be a claim about the data rather than about its formatting.
 */
test("every instant the Console shows is in the Console's own form", async ({
  page
}) => {
  const offenders: string[] = [];

  for (const route of [...CANONICAL_ROUTES, ...DETAIL_ROUTES]) {
    await page.goto(route.path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const findings: string[] = [];
      // The Console's own forms of a moment, longest first: a date with its
      // clock and its zone, a clock with its zone, and a date alone. They are
      // taken out of the text rather than matched against it, because what
      // matters is what is *left* -- a moment in some other spelling is a
      // moment the Console did not write.
      //
      // Each pattern is fixed-width on purpose. One alternation covering every
      // shape trips `detect-unsafe-regex`, which is a report worth answering
      // rather than suppressing, and the answer is to keep the shapes apart.
      const CANONICAL = [
        /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:UTC|[+-]\d{2}:\d{2})/gu,
        /\d{2}:\d{2}:\d{2} (?:UTC|[+-]\d{2}:\d{2})/gu,
        /\d{4}-\d{2}-\d{2}/gu
      ];
      // What may not be left over.
      const LEFTOVER = [
        /\d{4}-\d{2}-\d{2}/u,
        /\d{1,2}\/\d{1,2}\/\d{2,4}/u,
        /\d{2}:\d{2}:\d{2}/u
      ];
      for (const element of Array.from(document.querySelectorAll("main *"))) {
        if (element.children.length > 0) continue;
        const text = (element.textContent ?? "").trim();
        if (!text) continue;
        let rest = text;
        for (const form of CANONICAL) rest = rest.replace(form, " ");
        for (const shape of LEFTOVER) {
          const hit = shape.exec(rest);
          if (hit === null) continue;
          findings.push(`${hit[0]} in "${text.slice(0, 60)}"`);
        }
      }
      return findings;
    });

    for (const finding of found) offenders.push(`${route.path}: ${finding}`);
  }

  expect(
    offenders,
    "a moment is one quantity: the Console renders it one way, whichever page it is on"
  ).toEqual([]);
});
