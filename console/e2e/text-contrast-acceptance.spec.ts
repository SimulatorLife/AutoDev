import { expect, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * Every text the Console renders is legible.
 *
 * The Console is dark-only, and a dark surface is where contrast goes wrong:
 * a muted grey that reads well on white disappears on a near-black panel, and
 * the operator is left with a page that looks like it said something.
 *
 * WCAG 1.4.3 asks for 4.5:1 for body text and 3:1 for large text, and it
 * exempts the text of an inactive control -- a disabled button's label is
 * allowed to be faint, because the operator cannot act on it either way.
 *
 * The measurement is the browser's own: the colour it painted the text with,
 * against the colour it painted behind it, with every transparent layer
 * composited and every ancestor's opacity applied. A surface with a gradient
 * behind its text is measured against the flat colour beneath the gradient,
 * which is an approximation -- the one the Console's own scrims make.
 */
const ROUTES = [...CANONICAL_ROUTES, ...DETAIL_ROUTES];

for (const route of ROUTES) {
  test(`${route.path} renders legible text`, async ({ page }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    const failures = await page.evaluate(() => {
      interface Colour {
        r: number;
        g: number;
        b: number;
        a: number;
      }

      const parse = (value: string): Colour | null => {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (match === null) return null;
        const parts = (match[1] ?? "")
          .split(",")
          .map((part) => Number(part.trim()));
        return {
          r: parts[0] ?? 0,
          g: parts[1] ?? 0,
          b: parts[2] ?? 0,
          a: parts[3] ?? 1
        };
      };

      const channel = (value: number): number => {
        const s = value / 255;
        return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };

      const luminance = (colour: Colour): number =>
        0.2126 * channel(colour.r) +
        0.7152 * channel(colour.g) +
        0.0722 * channel(colour.b);

      const over = (front: Colour, back: Colour): Colour => ({
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
        a: 1
      });

      const ratio = (front: Colour, back: Colour): number => {
        const light = Math.max(luminance(front), luminance(back));
        const dark = Math.min(luminance(front), luminance(back));
        return (light + 0.05) / (dark + 0.05);
      };

      const backgroundOf = (element: Element): Colour => {
        let node: Element | null = element;
        let acc: Colour | null = null;
        while (node !== null) {
          const colour = parse(getComputedStyle(node).backgroundColor);
          if (colour !== null && colour.a > 0) {
            acc = acc === null ? colour : over(acc, colour);
            if (acc.a >= 1) return acc;
          }
          node = node.parentElement;
        }
        return acc ?? { r: 0, g: 0, b: 0, a: 1 };
      };

      const opacityOf = (element: Element): number => {
        let node: Element | null = element;
        let opacity = 1;
        while (node !== null) {
          opacity *= Number(getComputedStyle(node).opacity);
          node = node.parentElement;
        }
        return opacity;
      };

      /** The text of an inactive control is exempt: it cannot be acted on. */
      const isInactive = (element: Element): boolean =>
        element.closest("[disabled], [aria-disabled='true']") !== null;

      /** The failure this element carries, or null when it carries none. */
      const failureOf = (element: Element): string | null => {
        if (element.children.length > 0) return null;
        const text = (element.textContent ?? "").trim();
        if (text.length === 0) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden") return null;
        if (style.webkitTextFillColor === "transparent") return null;
        if (isInactive(element)) return null;
        const foreground = parse(style.color);
        if (foreground === null) return null;
        const opacity = opacityOf(element);
        if (opacity <= 0) return null;
        const background = backgroundOf(element);
        const painted = over(
          {
            r: foreground.r,
            g: foreground.g,
            b: foreground.b,
            a: foreground.a * opacity
          },
          background
        );
        const size = Number.parseFloat(style.fontSize);
        const weight = Number(style.fontWeight) || 400;
        const needed = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        const value = ratio(painted, background);
        if (value >= needed) return null;
        return `"${text.slice(0, 32)}" is ${String(Math.round(value * 100) / 100)}:1, needs ${String(needed)}:1`;
      };

      const results: string[] = [];
      for (const element of document.querySelectorAll("main *, nav *")) {
        const failure = failureOf(element);
        if (failure !== null) results.push(failure);
      }
      return results;
    });

    expect(
      failures,
      `${route.path} renders text that is too faint to read: ${failures.join("; ")}`
    ).toEqual([]);
  });
}
