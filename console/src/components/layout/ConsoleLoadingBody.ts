import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { MUTED_TEXT_CLASS } from "../ui/text-classes.ts";

/**
 * The page's own loading placeholder.
 *
 * A page whose server-owned read is pending shows this in its body while the
 * read is on its way. The placeholder sits inside the page's own shell, so a
 * route's answer is one piece -- the shell, this placeholder, and the content
 * that replaces it -- instead of a shell that is thrown away and rebuilt when
 * the content arrives.
 */
export function ConsoleLoadingBody({
  activeSection
}: {
  readonly activeSection: CanonicalNavSection;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      "data-console-loading": activeSection,
      "aria-busy": true,
      className: "flex flex-col gap-4"
    },
    React.createElement(
      "p",
      {
        role: "status",
        "aria-live": "polite",
        className: MUTED_TEXT_CLASS
      },
      `Loading ${activeSection.toLowerCase()}…`
    ),
    React.createElement(
      "div",
      {
        "aria-hidden": true,
        className: "grid grid-cols-1 gap-4 sm:grid-cols-3"
      },
      ...Array.from({ length: 3 }, (_, index) =>
        React.createElement("div", {
          key: index,
          className: "h-24 rounded-lg border border-border bg-surface/60"
        })
      )
    ),
    React.createElement("div", {
      "aria-hidden": true,
      className: "h-80 rounded-lg border border-border bg-surface/60"
    })
  );
}
