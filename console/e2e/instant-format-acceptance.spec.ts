import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

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
 *
 * A region marked `data-verbatim` is the exception, and it is marked rather
 * than assumed: the Console shows a service's own record in a few places --
 * the frame a playtest recorded, the tokens a session stored -- and that text
 * is quoted. Its moments carry the wire's spelling because it is the wire's
 * text, and reformatting them would falsify the record the operator came to
 * read.
 */
test("every instant the Console shows is in the Console's own form", async ({
  page
}) => {
  const offenders: string[] = [];

  for (const path of SWEEP_ROUTES) {
    await page.goto(path);
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
        // Text the Console quotes rather than renders is not a second voice
        // for a moment. A recorded frame is shown as the machine wrote it --
        // its own moments carry the wire's spelling, and reformatting them
        // would make the operator's copy of the record a different record.
        // The page marks those regions, and this sweep leaves them alone.
        if (element.closest("[data-verbatim='true']") !== null) continue;
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

    for (const finding of found) offenders.push(`${path}: ${finding}`);
  }

  expect(
    offenders,
    "a moment is one quantity: the Console renders it one way, whichever page it is on"
  ).toEqual([]);
});
