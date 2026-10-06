import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { AppNav } from "../navigation/AppNav.ts";
import { MUTED_TEXT_CLASS } from "../ui/text-classes.ts";

export interface AppShellProps {
  readonly activeSection: CanonicalNavSection;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
  readonly children?: React.ReactNode | undefined;
  readonly actions?: React.ReactNode | undefined;
  /**
   * One-line summary of what this resource surface is for. It belongs in the
   * shell header rather than in the page body so every resource has exactly one
   * title block: a page that repeats its own `h1` under the shell's breadcrumb
   * title renders two headings for the same resource.
   */
  readonly description?: string | undefined;
}

export function AppShell({
  activeSection,
  counts,
  children,
  actions,
  description
}: AppShellProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        // `w-full`, not `w-screen`: 100vw includes the classic vertical
        // scrollbar gutter, so `w-screen` made the shell wider than the space
        // the document actually had and gave every page a 15px horizontal
        // scroll at widths where a scrollbar is shown.
        "flex h-screen w-full bg-background text-fg overflow-hidden font-sans"
    },
    React.createElement(AppNav, {
      activeSection,
      counts
    }),
    React.createElement(
      "main",
      { className: "flex-1 flex flex-col min-w-0 overflow-y-auto" },
      React.createElement(
        "header",
        {
          className:
            "min-h-16 border-b border-border bg-surface/50 backdrop-blur px-4 xl:px-8 py-3 flex items-center justify-between gap-6 shrink-0"
        },
        React.createElement(
          "div",
          { className: "flex min-w-0 flex-col gap-0.5" },
          React.createElement(
            "div",
            { className: "flex items-center gap-3" },
            React.createElement(
              "span",
              {
                className:
                  "text-xs uppercase font-semibold text-fg-muted tracking-wider"
              },
              "AutoDev Console"
            ),
            React.createElement("span", { className: MUTED_TEXT_CLASS }, "/"),
            React.createElement(
              "h1",
              // The page title truncates on a narrow window, and it is the one
              // heading on the page: an ellipsized `h1` tells the operator
              // which page they are on only partially. The full name stays on
              // its hover title.
              {
                className: "text-lg font-bold text-fg truncate",
                title: activeSection
              },
              activeSection
            )
          ),
          description === undefined
            ? null
            : React.createElement(
                "p",
                {
                  // The description is a sentence that explains what the
                  // resource owns, so it wraps to a second line instead of
                  // ellipsizing mid-clause; the full text stays on hover.
                  className:
                    "line-clamp-2 text-xs leading-snug text-fg-muted break-words",
                  title: description
                },
                description
              )
        ),
        actions === undefined
          ? null
          : React.createElement(
              "div",
              { className: "flex shrink-0 items-center gap-3" },
              actions
            )
      ),
      React.createElement(
        "div",
        { className: "flex-1 p-4 xl:p-8 min-w-0" },
        children
      )
    )
  );
}
