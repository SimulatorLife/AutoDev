import {
  CANONICAL_NAV_GROUPS,
  type CanonicalNavGroup,
  type CanonicalNavGroupId,
  type CanonicalNavSection
} from "@simulatorlife/autodev-core";
import React from "react";

import { canonicalNavPath } from "../../lib/routes.ts";
import { Icon, navIcon } from "../icons/Icon.ts";

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
 *
 * Below `xl` the sidebar collapses to an icon rail. Every resource has an icon,
 * so the rail carries the same navigation in a fraction of the width and gives
 * the dense tables back the horizontal room they need. Each collapsed link
 * keeps its section name as an accessible name and hover title, so the rail is
 * never icon-only to a user.
 */
export function AppNav({
  activeSection,
  counts
}: AppNavProps): React.JSX.Element {
  const brandLinkProps: NavigationLinkProps = {
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
        "autodev-nav flex shrink-0 flex-col h-full w-14 xl:w-64 bg-surface text-fg p-2 xl:p-4 border-r border-border"
    },
    React.createElement(
      "div",
      {
        className: "mb-6 flex items-center px-2 justify-center xl:justify-start"
      },
      React.createElement(
        "a",
        brandLinkProps,
        React.createElement(
          "span",
          {
            className:
              "font-semibold text-base tracking-tight xl:text-lg hidden xl:inline whitespace-nowrap"
          },
          "AutoDev Console"
        ),
        React.createElement("span", { className: "xl:hidden" }, "AC")
      )
    ),
    React.createElement(
      "ul",
      {
        className: "flex flex-col gap-4 list-none p-0 m-0"
      },
      CANONICAL_NAV_GROUPS.map((group, index) =>
        renderGroup(group, activeSection, counts, index === 0)
      )
    )
  );
}

function renderGroup(
  group: CanonicalNavGroup<CanonicalNavSection>,
  activeSection: CanonicalNavSection,
  counts: Partial<Record<CanonicalNavSection, number>> | undefined,
  isFirst: boolean
): React.JSX.Element {
  const groupSectionProps: GroupSectionProps = {
    // Group headings disappear in the collapsed rail, so the boundary between
    // Configure / Observe / Operate has to stay visible some other way.
    className: `flex flex-col gap-1 ${
      isFirst
        ? ""
        : "mt-1 border-t border-border pt-3 xl:mt-0 xl:border-t-0 xl:pt-0"
    }`,
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
            "hidden xl:block px-3 text-[11px] font-semibold uppercase tracking-wider text-fg-muted"
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
  const icon = navIcon(section);
  const labelProps: NavigationLinkProps = {
    href,
    // The section name stays the link's accessible name in both the expanded
    // sidebar and the collapsed rail; the rail only hides it visually.
    "aria-label": section,
    "aria-current": isActive ? "page" : undefined,
    "data-nav-item": section.toLowerCase(),
    title: count === undefined ? section : `${section} (${count})`,
    className: `w-full flex items-center gap-3 px-0 xl:px-3 py-2 rounded-md text-sm font-medium transition-colors no-underline justify-center xl:justify-start ${
      isActive
        ? "bg-surface-raised text-accent font-semibold shadow-sm"
        : "text-fg-secondary hover:bg-surface-raised/60 hover:text-fg"
    }`
  };
  return React.createElement(
    "li",
    { key: section },
    React.createElement(
      "a",
      labelProps,
      icon === null
        ? null
        : React.createElement(Icon, {
            name: icon,
            size: 16,
            className: isActive ? undefined : "opacity-70"
          }),
      React.createElement(
        "span",
        { className: "hidden xl:inline flex-1 truncate" },
        section
      ),
      count === undefined
        ? null
        : React.createElement(
            "span",
            {
              className:
                "hidden xl:inline text-xs bg-surface-raised px-2 py-0.5 rounded-full text-fg-muted border border-border-strong tabular-nums"
            },
            count
          )
    )
  );
}
