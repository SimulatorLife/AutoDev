import React from "react";

import {
  ActiveAppNav,
  ActiveSectionHeading
} from "../navigation/ActiveSection.ts";

export interface AppShellProps {
  readonly children?: React.ReactNode | undefined;
}

/**
 * Persistent Console chrome rendered once by the root layout. The sidebar
 * and header survive client-side navigation; only `children` (the active
 * route segment) is swapped, so moving between sections or tabs never
 * reloads the document or re-hydrates the shell.
 *
 * The document itself scrolls (the sidebar stays pinned with `sticky`), which
 * is the model the App Router's navigation scroll reset assumes: a new page
 * whose top is out of view scrolls the document back to the top, header
 * included, rather than aligning the page inside a nested scroller.
 */
export function AppShell({ children }: AppShellProps): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex min-h-screen bg-background text-fg font-sans" },
    React.createElement(
      "div",
      { className: "sticky top-0 h-screen shrink-0 overflow-y-auto" },
      React.createElement(ActiveAppNav)
    ),
    React.createElement(
      "main",
      { className: "flex-1 flex flex-col min-w-0" },
      React.createElement(
        "header",
        {
          className:
            "h-16 border-b border-border bg-surface/50 backdrop-blur px-8 flex items-center shrink-0"
        },
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
          React.createElement("span", { className: "text-fg-muted" }, "/"),
          React.createElement(ActiveSectionHeading)
        )
      ),
      // Wide content scrolls horizontally inside the page body instead of
      // widening the document under the pinned sidebar.
      React.createElement(
        "div",
        { className: "flex-1 p-8 min-w-0 overflow-x-auto" },
        children
      )
    )
  );
}
