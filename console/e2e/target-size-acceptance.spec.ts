import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * Every interactive target meets the 24x24 floor, or qualifies under one of
 * WCAG 2.5.8's own exceptions.
 *
 * The Console's target state states the floor, and `console/tests/target-size.test.ts`
 * holds the two halves of the fix for the shared classes: the minimum is
 * `min-h-6`, and it has to be on a *block* box, because `min-height` is inert
 * on a non-replaced inline box -- so a target that merely carried `min-h-6`
 * while staying inline measures the same 22px as before and looks fixed in the
 * source.
 *
 * That is the argument for measuring rather than reading: the class can look
 * right and the rendered target can still be small. So this measures the
 * rendered box, on every route, over every control the operator can act with.
 *
 * The criterion's own exceptions are honoured, because they are the criterion:
 *
 * - **Inline.** A target whose size is the line's -- a link inside a sentence,
 *   a link that *is* the text of a heading -- is sized by the text around it.
 * - **Spacing.** An undersized target passes when a 24px circle centred on it
 *   meets no other target: the other's own 24px circle, or its box when the
 *   other is larger than 24px.
 * - **Not visible.** A control that is clipped out of the page until it takes
 *   focus -- the skip link -- is not a target anyone aims at.
 *
 * The two exceptions the criterion allows that cannot be measured -- an
 * equivalent control elsewhere, and a presentation that is essential -- are
 * not modelled here, so a target that needs one of them has to keep the floor.
 */
test("every interactive target meets the 24px floor", async ({ page }) => {
  const undersized: string[] = [];
  let measured = 0;

  for (const path of SWEEP_ROUTES) {
    await page.goto(path);
    await waitForPageContent(page);

    const found = await page.evaluate(() => {
      const selector = [
        "button",
        "a[href]",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='switch']"
      ].join(",");

      const targets = Array.from(document.querySelectorAll(selector))
        .map((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return { element, rect, style };
        })
        .filter((target) => {
          const { style, rect, element } = target;
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          if (element.closest("[hidden]")) return false;
          if (style.pointerEvents === "none") return false;
          return rect.width !== 0 || rect.height !== 0;
        });

      /** A target whose size is the line's, or that is not visible at all. */
      const isExempt = (target: (typeof targets)[number]): boolean => {
        const { style } = target;
        // Clipped out of the page until it takes focus: the skip link. It is
        // not a target anyone aims at while it is invisible.
        if (style.clip !== "auto" || style.clipPath !== "none") return true;
        // Inline: the target's size is the line's.
        return style.display.startsWith("inline");
      };

      /**
       * Whether a 24px circle centred on this target meets no other target:
       * the other's own 24px circle, or its box when the other is larger.
       */
      const isSpaced = (target: (typeof targets)[number]): boolean => {
        const centreX = target.rect.left + target.rect.width / 2;
        const centreY = target.rect.top + target.rect.height / 2;
        return targets.every((other) => {
          if (other.element === target.element) return true;
          const box = other.rect;
          if (box.width >= 24 && box.height >= 24) {
            const dx = Math.max(
              box.left - centreX,
              centreX - (box.left + box.width),
              0
            );
            const dy = Math.max(
              box.top - centreY,
              centreY - (box.top + box.height),
              0
            );
            return Math.hypot(dx, dy) >= 12;
          }
          const otherX = box.left + box.width / 2;
          const otherY = box.top + box.height / 2;
          return Math.hypot(centreX - otherX, centreY - otherY) >= 24;
        });
      };

      const findings: string[] = [];
      for (const target of targets) {
        const { rect } = target;
        if (rect.width >= 24 && rect.height >= 24) continue;
        if (isExempt(target)) continue;
        if (isSpaced(target)) continue;
        const label = (
          target.element.getAttribute("aria-label") ??
          target.element.textContent ??
          ""
        )
          .trim()
          .slice(0, 40);
        findings.push(
          `"${label}" is ${Math.round(rect.width)}x${Math.round(rect.height)}`
        );
      }
      return { findings, counted: targets.length };
    });

    measured += found.counted;
    for (const finding of found.findings)
      undersized.push(`${path}: ${finding}`);
  }

  expect(
    undersized,
    "an interactive target has to meet the 24x24 floor, or be inline in the text or spaced far enough from every other target"
  ).toEqual([]);
  // The sweep has to have read something. A Console that failed to render would
  // answer every route with an error page, and an error page carries almost no
  // control -- so a sweep that found nothing would pass the rule above
  // without having looked at a single target.
  expect(
    measured,
    "the sweep has to read the targets the Console renders, not an error page"
  ).toBeGreaterThan(60);
});
