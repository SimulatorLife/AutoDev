import React from "react";

import type { CanonicalNavSection } from "../../../../core/src/index.ts";
import { AppNav } from "../navigation/AppNav.ts";

export interface AppShellProps {
  readonly activeSection: CanonicalNavSection;
  readonly onSelectSection: (section: CanonicalNavSection) => void;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
  readonly children?: React.ReactNode | undefined;
  readonly actions?: React.ReactNode | undefined;
}

export function AppShell({
  activeSection,
  onSelectSection,
  counts,
  children,
  actions
}: AppShellProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "flex h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden font-sans"
    },
    React.createElement(AppNav, {
      activeSection,
      onSelectSection,
      counts
    }),
    React.createElement(
      "main",
      { className: "flex-1 flex flex-col min-w-0 overflow-y-auto" },
      React.createElement(
        "header",
        {
          className:
            "h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur px-8 flex items-center justify-between shrink-0"
        },
        React.createElement(
          "div",
          { className: "flex items-center gap-3" },
          React.createElement(
            "span",
            {
              className:
                "text-xs uppercase font-semibold text-slate-500 tracking-wider"
            },
            "AutoDev Console"
          ),
          React.createElement("span", { className: "text-slate-600" }, "/"),
          React.createElement(
            "h1",
            { className: "text-lg font-bold text-slate-100" },
            activeSection
          )
        ),
        actions
          ? React.createElement(
              "div",
              { className: "flex items-center gap-3" },
              actions
            )
          : null
      ),
      React.createElement("div", { className: "flex-1 p-8 min-w-0" }, children)
    )
  );
}
