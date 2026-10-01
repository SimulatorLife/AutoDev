import React from "react";

import {
  CANONICAL_NAVIGATION,
  type CanonicalNavSection
} from "../../../../core/src/index.ts";

export interface AppNavProps {
  readonly activeSection: CanonicalNavSection;
  readonly onSelectSection: (section: CanonicalNavSection) => void;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
}

export function AppNav({
  activeSection,
  onSelectSection,
  counts
}: AppNavProps): React.JSX.Element {
  return React.createElement(
    "nav",
    {
      "aria-label": "AutoDev Console Navigation",
      className:
        "autodev-nav flex flex-col w-64 h-full bg-slate-900 text-slate-100 p-4 border-r border-slate-800"
    },
    React.createElement(
      "div",
      { className: "flex items-center gap-2 mb-6 px-2" },
      React.createElement("div", {
        className: "w-3 h-3 rounded-full bg-emerald-500 animate-pulse"
      }),
      React.createElement(
        "span",
        { className: "font-semibold text-lg tracking-tight" },
        "AutoDev Console"
      )
    ),
    React.createElement(
      "ul",
      { className: "flex flex-col gap-1 list-none p-0 m-0" },
      CANONICAL_NAVIGATION.map((section) => {
        const isActive = activeSection === section;
        const count = counts?.[section];
        return React.createElement(
          "li",
          { key: section },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => onSelectSection(section),
              className: `w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? "bg-slate-800 text-emerald-400 font-semibold shadow-sm"
                  : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
              }`,
              "aria-current": isActive ? "page" : undefined,
              "data-nav-item": section.toLowerCase()
            },
            React.createElement("span", null, section),
            count === undefined
              ? null
              : React.createElement(
                  "span",
                  {
                    className:
                      "text-xs bg-slate-800 px-2 py-0.5 rounded-full text-slate-400 border border-slate-700"
                  },
                  count
                )
          )
        );
      })
    )
  );
}
