import {
  CANONICAL_NAV_GROUPS,
  type CanonicalNavGroup,
  type CanonicalNavGroupId,
  type CanonicalNavSection
} from "@simulatorlife/autodev-core";
import React from "react";

import { canonicalNavPath } from "../../lib/routes.ts";
import { ConsoleLink, type ConsoleLinkProps } from "./ConsoleLink.ts";

export { canonicalNavPath } from "../../lib/routes.ts";

export interface AppNavProps {
  /** Section owning the current route, or `null` outside canonical routes. */
  readonly activeSection: CanonicalNavSection | null;
}

type GroupSectionProps = React.HTMLAttributes<HTMLElement> & {
  readonly "data-nav-group"?: CanonicalNavGroupId;
};

/**
 * URL-addressable navigation grouped by Configure / Observe / Operate. Each
 * item renders a `ConsoleLink` (a real `<a href="/section">`), so
 * navigating updates the address bar and is reflected in the route while the
 * App Router swaps only the page segment instead of reloading the document.
 * Group headings label the presentation buckets without changing first-class
 * routes.
 */
export function AppNav({ activeSection }: AppNavProps): React.JSX.Element {
  const brandLinkProps: ConsoleLinkProps = {
    href: "/agents",
    "data-nav-brand": "autodev",
    className:
      "flex items-center gap-2 text-inherit no-underline rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
  };

  return React.createElement(
    "nav",
    {
      "aria-label": "AutoDev Console Navigation",
      className:
        "autodev-nav flex flex-col w-64 min-h-full bg-surface text-fg p-4 border-r border-border"
    },
    React.createElement(
      "div",
      { className: "flex items-center gap-2 mb-6 px-2" },
      React.createElement(
        ConsoleLink,
        brandLinkProps,
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
      CANONICAL_NAV_GROUPS.map((group) => renderGroup(group, activeSection))
    )
  );
}

function renderGroup(
  group: CanonicalNavGroup<CanonicalNavSection>,
  activeSection: CanonicalNavSection | null
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
            "px-3 text-[11px] font-semibold uppercase tracking-wider text-fg-muted"
        },
        group.id
      ),
      React.createElement(
        "ul",
        {
          className: "flex flex-col gap-1 list-none p-0 m-0",
          "aria-label": `${group.label} navigation`
        },
        group.sections.map((section) => renderNavItem(section, activeSection))
      )
    )
  );
}

function renderNavItem(
  section: CanonicalNavSection,
  activeSection: CanonicalNavSection | null
): React.JSX.Element {
  const isActive = activeSection === section;
  const linkProps: ConsoleLinkProps = {
    href: canonicalNavPath(section),
    "aria-current": isActive ? "page" : undefined,
    "data-nav-item": section.toLowerCase(),
    className: `w-full flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors no-underline ${
      isActive
        ? "bg-surface-raised text-accent font-semibold shadow-sm"
        : "text-fg-secondary hover:bg-surface-raised/60 hover:text-fg"
    }`
  };
  return React.createElement(
    "li",
    { key: section },
    React.createElement(
      ConsoleLink,
      linkProps,
      React.createElement("span", null, section)
    )
  );
}
