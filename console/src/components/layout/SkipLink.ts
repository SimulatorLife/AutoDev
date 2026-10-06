import React from "react";

/**
 * First stop in the tab order, for reaching the page body without walking the nav.
 *
 * The sidebar is a persistent fourteen-link `<nav>` that precedes `<main>` in the
 * document, so a keyboard user crosses the same fourteen links on every page
 * before reaching anything the page actually offers. Measured across eight
 * routes it is fourteen tab stops on all of them, and on the sparser pages that
 * is most of the page: `/mcps` has twenty-two focusable elements in total and
 * only eight inside `<main>`, `/tools/find_code` twenty-three and nine, `/memory`
 * twenty-nine and fifteen.
 *
 * The link is visually hidden until it takes focus, then reveals itself over the
 * top-left of the viewport. `sr-only` keeps it out of the reading order and out
 * of the layout -- the shell is a flex row, so an in-flow element here would
 * become a flex item and change the shell's geometry.
 *
 * It lives beside the `<main>` it targets rather than in the root layout, because
 * the sidebar is the thing that has to be skipped: a route that renders outside
 * `AppShell` has no nav ahead of its content, and so needs no skip link. `fixed`
 * rather than `absolute` so it does not need a positioned ancestor it would have
 * to be given by every future one.
 */
export function SkipLink(): React.JSX.Element {
  return React.createElement(
    "a",
    {
      href: "#main-content",
      "data-skip-link": "true",
      className:
        "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:border focus:border-border-strong focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg focus:shadow-lg"
    },
    "Skip to content"
  );
}
