import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * Every control the operator can see whole shows its focus ring whole.
 *
 * The Console draws one focus ring for the whole product: two pixels of
 * accent, two pixels outside the control, so the ring sits on the surface
 * around the control rather than on the control's own fill. That is the
 * right shape -- a ring on an accent-filled button has to be on the surface
 * to be seen at all -- and it has one consequence: the ring needs four
 * pixels of room around the control that owns it.
 *
 * A control that is flush against the edge of a scrolling region does not
 * have those four pixels, and the region clips the ring. Measured in
 * Chromium against the production build, the provider detail page's role
 * strip -- a horizontal scroller whose rows sat flush against its top and
 * bottom -- cut the top and the bottom of the ring off the priority and
 * model selects in its first and last rows, and a control the browser
 * parked at the bottom of the page's own scrollport lost the bottom of its
 * ring to the edge of the window.
 *
 * Both are the same defect and both have the same repair: the region leaves
 * the ring its room. The role strip carries six pixels of vertical padding
 * and the page's scrollport reserves six pixels of scroll padding, so a
 * control the browser scrolls into view lands clear of the edge.
 *
 * The sweep measures what the browser would draw. It walks every control the
 * route renders, focuses it, and asks the browser where the control sits
 * against the nearest region that clips -- a control that is *bigger* than
 * its region is not a cut ring, it is a control that scrolls, and the rule
 * does not apply to it.
 */
const ROUTES = SWEEP_ROUTES;

/** The controls the keyboard can reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A short window, because that is where a ring gets cut.
 *
 * The Console's focus ring is drawn four pixels outside the control it
 * belongs to, so it needs a region that scrolls to leave that room. A window
 * tall enough for every region to fit its content never exercises the rule:
 * the navigation rail alone is taller than a short window, so the sweep runs
 * at a height where the rail scrolls and the last item in it is the one whose
 * ring would be clipped.
 */
test.use({ viewport: { width: 1280, height: 600 } });

for (const path of ROUTES) {
  test(`${path} draws the focus ring whole`, async ({ page }) => {
    await page.goto(path);
    await waitForPageContent(page);

    const cut = await page.evaluate((focusable) => {
      const findings: string[] = [];
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(focusable)
      ).filter(
        (element) =>
          element.getClientRects().length > 0 && element.checkVisibility()
      );
      for (const element of controls) {
        // Focusing moves the control into view, which is where the operator
        // would meet it, and it scrolls the page the way the keyboard would.
        element.focus();
        const style = getComputedStyle(element);
        const reach =
          (Number.parseFloat(style.outlineOffset) || 0) +
          (Number.parseFloat(style.outlineWidth) || 0);
        if (reach <= 0) continue;
        const rect = element.getBoundingClientRect();

        // The nearest region that clips decides how much of the ring is
        // painted.
        let clip: DOMRect | null = null;
        for (
          let node = element.parentElement;
          node !== null;
          node = node.parentElement
        ) {
          const nodeStyle = getComputedStyle(node);
          if (
            nodeStyle.overflowX === "visible" &&
            nodeStyle.overflowY === "visible" &&
            nodeStyle.overflow === "visible"
          ) {
            continue;
          }
          const box = node.getBoundingClientRect();
          clip =
            clip === null
              ? box
              : new DOMRect(
                  Math.max(clip.left, box.left),
                  Math.max(clip.top, box.top),
                  Math.min(clip.right, box.right),
                  Math.min(clip.bottom, box.bottom)
                );
        }
        if (clip === null) continue;

        // A control that is taller than the region that holds it is a
        // control that scrolls: its ring is cut by the region because the
        // control is not all there, and that is not a cut ring.
        const fullyInside =
          rect.left >= clip.left - 0.5 &&
          rect.right <= clip.right + 0.5 &&
          rect.top >= clip.top - 0.5 &&
          rect.bottom <= clip.bottom + 0.5;
        if (!fullyInside) continue;

        const cutTop = clip.top - (rect.top - reach);
        const cutBottom = rect.bottom + reach - clip.bottom;
        if (cutTop <= 0.5 && cutBottom <= 0.5) continue;
        const name =
          element.getAttribute("aria-label") ??
          element.textContent?.trim().slice(0, 30) ??
          "";
        findings.push(
          `<${element.tagName.toLowerCase()}> "${name}" loses ${Math.round(
            Math.max(cutTop, cutBottom)
          )}px of its ring to the edge of a scrolling region`
        );
      }
      return findings;
    }, FOCUSABLE);

    expect(
      cut,
      "a control that is flush against the edge of a scrolling region loses the edge of its focus ring to the clip"
    ).toEqual([]);
  });
}
