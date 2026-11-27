import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * Every moment the Console shows is one Inline Display Toggle.
 *
 * "When did this happen" used to be answered in seven spellings: `2/11/2026`,
 * a `toLocaleString()` in the *server's* zone, the raw wire value with its
 * milliseconds, an ISO date and clock with `Z` on one page and `UTC` on the
 * next. Now a timestamp reads as relative time ("3 hours ago") and, when
 * activated, as the full date and time in the operator's own zone
 * ("Nov 19, 2026, 10:30 AM"). UTC belongs to logs, telemetry and storage.
 *
 * This is a rendering claim, so it is measured where it happens: in the
 * hydrated browser, on every route, over the text a reader actually sees.
 *
 * A region marked `data-verbatim` is the exception, and it is marked rather
 * than assumed: a recorded frame or a stored record is quoted as the machine
 * wrote it, and reformatting its moments would falsify the record.
 */
test("no route shows a moment in a storage or server-zone spelling", async ({
  page
}) => {
  const offenders: string[] = [];

  for (const path of SWEEP_ROUTES) {
    await page.goto(path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const findings: string[] = [];
      // Fixed-width shapes kept apart: one alternation over all of them trips
      // `detect-unsafe-regex`. A bare calendar date (`2026-02-11`) is a date,
      // not a moment, and is allowed.
      const STORAGE_SPELLINGS = [
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u,
        /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u,
        /\d{1,2}\/\d{1,2}\/\d{2,4}/u,
        /\d{2}:\d{2}:\d{2}/u
      ];
      for (const element of Array.from(document.querySelectorAll("main *"))) {
        if (element.children.length > 0) continue;
        if (element.closest("[data-verbatim='true']") !== null) continue;
        const text = (element.textContent ?? "").trim();
        if (!text) continue;
        for (const shape of STORAGE_SPELLINGS) {
          const hit = shape.exec(text);
          if (hit !== null)
            findings.push(`${hit[0]} in "${text.slice(0, 60)}"`);
        }
      }
      // Every machine-readable moment is shown through the shared toggle; a
      // calendar date names a day rather than a moment and stays a date.
      for (const time of Array.from(
        document.querySelectorAll("main time[datetime]")
      )) {
        if (time.closest("[data-verbatim='true']") !== null) continue;
        if (/^\d{4}-\d{2}-\d{2}$/u.test(time.getAttribute("datetime") ?? ""))
          continue;
        if (
          time.querySelector("[data-inline-display-toggle='instant']") === null
        ) {
          findings.push(
            `<time> without the toggle: "${(time.textContent ?? "").slice(0, 60)}"`
          );
        }
      }
      return findings;
    });

    for (const finding of found) offenders.push(`${path}: ${finding}`);
  }

  expect(
    offenders,
    "a moment is one quantity: the Console renders it through one toggle, whichever page it is on"
  ).toEqual([]);
});

test("a timestamp toggles between relative and local time by pointer and keyboard", async ({
  page
}) => {
  let found = false;
  for (const path of SWEEP_ROUTES) {
    await page.goto(path);
    await waitForPageContent(page);
    const toggle = page
      .locator("main [data-inline-display-toggle='instant']")
      .first();
    if ((await toggle.count()) === 0) continue;
    found = true;

    await expect(toggle).toHaveAttribute("data-representation", "relative");
    await expect(toggle).toHaveText(/ ago$|^in /u);
    await expect(toggle).toHaveCSS("cursor", "pointer");
    await expect(toggle).toHaveCSS("text-decoration-style", "dotted");
    await expect(toggle).toHaveAccessibleName(
      /: .+\. Activate to show local date and time\.$/u
    );

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-representation", "local");
    // "Nov 19, 2026, 10:30 AM": the full date with its year, in the
    // operator's zone, and never a zone the operator has to convert from.
    await expect(toggle).toHaveText(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/u
    );
    await expect(toggle).not.toHaveText(/UTC/u);

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("data-representation", "relative");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("data-representation", "local");
    break;
  }
  expect(found, "at least one route shows a timestamp").toBe(true);
});
