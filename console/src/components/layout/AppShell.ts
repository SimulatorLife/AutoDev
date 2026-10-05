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
 */
export function AppShell({ children }: AppShellProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "flex h-screen w-screen bg-background text-fg overflow-hidden font-sans"
    },
    React.createElement(ActiveAppNav),
    React.createElement(
      "main",
      { className: "flex-1 flex flex-col min-w-0 overflow-y-auto" },
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
      React.createElement("div", { className: "flex-1 p-8 min-w-0" }, children)
    )
  );
}
