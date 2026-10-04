import {
  CANONICAL_NAV_GROUPS,
  type CanonicalNavGroup,
  type CanonicalNavGroupId,
  type CanonicalNavSection
} from "@simulatorlife/autodev-core";
import React from "react";

import { canonicalNavPath } from "../../lib/routes.ts";

export { canonicalNavPath } from "../../lib/routes.ts";

export interface AppNavProps {
  readonly activeSection: CanonicalNavSection;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
}

type NavigationLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly "data-nav-brand"?: string;
  readonly "data-nav-item"?: string;
};

type GroupSectionProps = React.HTMLAttributes<HTMLElement> & {
  readonly "data-nav-group"?: CanonicalNavGroupId;
};

/**
 * URL-addressable navigation grouped by Configure / Observe / Operate. Each
 * item still renders a real `<a href="/section">` link, so navigating
 * updates the address bar and is reflected in the route. Group headings
 * label the presentation buckets without changing first-class routes.
 */
export function AppNav({
  activeSection,
  counts
}: AppNavProps): React.JSX.Element {
  const brandLinkProps: NavigationLinkProps = {
    href: "/agents",
    "data-nav-brand": "autodev",
    className:
      "flex items-center gap-2 text-inherit no-underline focus:outline-none"
  };

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
      React.createElement(
        "a",
        brandLinkProps,
        React.createElement("div", {
          className: "w-3 h-3 rounded-full bg-emerald-500 animate-pulse"
        }),
        React.createElement(
          "span",
          { className: "font-semibold text-lg tracking-tight" },
          "AutoDev Console"
        )
      )
    ),
    React.createElement(
      "ul",
      {
        className: "flex flex-col gap-4 list-none p-0 m-0"
      },
      CANONICAL_NAV_GROUPS.map((group) =>
        renderGroup(group, activeSection, counts)
      )
    )
  );
}

function renderGroup(
  group: CanonicalNavGroup<CanonicalNavSection>,
  activeSection: CanonicalNavSection,
  counts: Partial<Record<CanonicalNavSection, number>> | undefined
): React.JSX.Element {
  const groupSectionProps: GroupSectionProps = {
    className: "flex flex-col gap-1",
    "data-nav-group": group.id
  };
  const headingId = `autodev-nav-group-${group.id.toLowerCase()}`;
  return React.createElement(
    "li",
    { key: group.id },
    React.createElement(
      "section",
      { ...groupSectionProps, "aria-labelledby": headingId },
      React.createElement(
        "h2",
        {
          id: headingId,
          className:
            "px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500"
        },
        group.id
      ),
      React.createElement(
        "ul",
        {
          className: "flex flex-col gap-1 list-none p-0 m-0",
          "aria-label": `${group.label} navigation`
        },
        group.sections.map((section) =>
          renderNavItem(section, activeSection, counts)
        )
      )
    )
  );
}

function renderNavItem(
  section: CanonicalNavSection,
  activeSection: CanonicalNavSection,
  counts: Partial<Record<CanonicalNavSection, number>> | undefined
): React.JSX.Element {
  const isActive = activeSection === section;
  const count = counts?.[section];
  const href = canonicalNavPath(section);
  const linkProps: NavigationLinkProps = {
    href,
    "aria-current": isActive ? "page" : undefined,
    "data-nav-item": section.toLowerCase(),
    className: `w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors no-underline ${
      isActive
        ? "bg-slate-800 text-emerald-400 font-semibold shadow-sm"
        : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
    }`
  };
  return React.createElement(
    "li",
    { key: section },
    React.createElement(
      "a",
      linkProps,
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
}
