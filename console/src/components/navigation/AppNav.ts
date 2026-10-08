"use client";

import {
  CANONICAL_NAV_GROUPS,
  type CanonicalNavGroup,
  type CanonicalNavGroupId,
  type CanonicalNavSection
} from "@simulatorlife/autodev-core";
import React from "react";

import { canonicalNavPath } from "../../lib/routes.ts";
import { Button } from "../forms/Button.ts";
import { Icon, navIcon } from "../icons/Icon.ts";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "autodev.console.sidebar.collapsed";

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
 * item remains a real link. At every width the circular OpenLIT-style button
 * toggles between the full sidebar and its clickable icon rail; the preference
 * survives route changes. Narrow viewports default to the rail; expanding there
 * overlays the page instead of squeezing its content. Icon-only links retain
 * their accessible names and titles.
 */
export function AppNav({
  activeSection,
  counts
}: AppNavProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      const storedPreference = globalThis.localStorage.getItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY
      );
      setIsCollapsed(
        storedPreference === null
          ? globalThis.matchMedia("(max-width: 1279px)").matches
          : storedPreference === "true"
      );
    } catch {
      // Keep the narrow-screen rail as the default when storage is unavailable.
      setIsCollapsed(globalThis.matchMedia("(max-width: 1279px)").matches);
    }
  }, []);

  const toggleSidebar = (): void => {
    const nextIsCollapsed = !isCollapsed;
    setIsCollapsed(nextIsCollapsed);
    try {
      globalThis.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(nextIsCollapsed)
      );
    } catch {
      // Persistence is optional; the current page still reflects the toggle.
    }
  };
  const expandedLabelClass = isCollapsed ? "hidden" : "inline";
  const brandLinkProps: NavigationLinkProps = {
    href: "/agents",
    "aria-label": "AutoDev Console",
    "data-nav-brand": "autodev",
    className: "flex items-center gap-2 text-inherit no-underline rounded-sm "
  };

  return React.createElement(
    "nav",
    {
      id: "autodev-console-navigation",
      "aria-label": "AutoDev Console Navigation",
      className:
        "autodev-nav flex shrink-0 flex-col h-full " +
        (isCollapsed
          ? "relative w-14 p-2"
          : "absolute inset-y-0 left-0 z-30 w-64 p-4 shadow-xl xl:relative xl:z-auto xl:shadow-none") +
        " bg-surface text-fg border-r border-border"
    },
    React.createElement(
      "div",
      {
        className:
          "mb-6 flex items-center px-2 " +
          (isCollapsed ? "justify-center" : "justify-start")
      },
      React.createElement(
        "a",
        brandLinkProps,
        React.createElement(
          "span",
          {
            className:
              "font-semibold text-base tracking-tight xl:text-lg " +
              expandedLabelClass +
              " whitespace-nowrap"
          },
          "AutoDev Console"
        ),
        React.createElement(
          "span",
          { className: isCollapsed ? "" : "hidden" },
          "AC"
        )
      )
    ),
    React.createElement(
      Button,
      {
        type: "button",
        variant: "outline",
        size: "icon",
        className:
          "absolute right-0 top-4 z-20 inline-grid translate-x-1/2 place-items-center",
        ariaLabel: isCollapsed ? "Expand sidebar" : "Collapse sidebar",
        ariaControls: "autodev-console-navigation",
        ariaExpanded: !isCollapsed,
        title: isCollapsed ? "Expand sidebar" : "Collapse sidebar",
        onClick: toggleSidebar,
        testId: "sidebar-toggle"
      },
      isCollapsed
        ? React.createElement(Icon, { name: "chevronsRight", size: 16 })
        : React.createElement(Icon, { name: "chevronsLeft", size: 16 })
    ),
    React.createElement(
      "ul",
      {
        className: "flex flex-col gap-4 list-none p-0 m-0"
      },
      CANONICAL_NAV_GROUPS.map((group, index) =>
        renderGroup(group, activeSection, counts, index === 0, isCollapsed)
      )
    )
  );
}

function renderGroup(
  group: CanonicalNavGroup<CanonicalNavSection>,
  activeSection: CanonicalNavSection,
  counts: Partial<Record<CanonicalNavSection, number>> | undefined,
  isFirst: boolean,
  isCollapsed: boolean
): React.JSX.Element {
  let groupSpacingClass = "";
  if (!isFirst) {
    groupSpacingClass = isCollapsed
      ? "mt-1 border-t border-border pt-3"
      : "mt-1";
  }
  const groupSectionProps: GroupSectionProps = {
    // The separators distinguish groups when their headings are hidden.
    className: "flex flex-col gap-1 " + groupSpacingClass,
    "data-nav-group": group.id
  };
  const headingId = "autodev-nav-group-" + group.id.toLowerCase();
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
            (isCollapsed ? "hidden" : "block") +
            " px-3 text-meta font-semibold uppercase tracking-wider text-fg-muted"
        },
        group.id
      ),
      React.createElement(
        "ul",
        {
          className: "flex flex-col gap-1 list-none p-0 m-0",
          "aria-label": group.label + " navigation"
        },
        group.sections.map((section) =>
          renderNavItem(section, activeSection, counts, isCollapsed)
        )
      )
    )
  );
}

function renderNavItem(
  section: CanonicalNavSection,
  activeSection: CanonicalNavSection,
  counts: Partial<Record<CanonicalNavSection, number>> | undefined,
  isCollapsed: boolean
): React.JSX.Element {
  const isActive = activeSection === section;
  const count = counts?.[section];
  const href = canonicalNavPath(section);
  const icon = navIcon(section);
  const labelProps: NavigationLinkProps = {
    href,
    // The section name stays the link's accessible name in both modes.
    "aria-label": section,
    "aria-current": isActive ? "page" : undefined,
    "data-nav-item": section.toLowerCase(),
    title: count === undefined ? section : section + " (" + count + ")",
    className:
      "w-full flex items-center gap-3 " +
      (isCollapsed ? "px-0 justify-center" : "px-3 justify-start") +
      " py-2 rounded-md text-sm font-medium transition-colors no-underline " +
      (isActive
        ? "bg-surface-raised text-accent font-semibold shadow-sm"
        : "text-fg-secondary hover:bg-surface-raised/60 hover:text-fg")
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
        {
          className: expandedOnlyClass(isCollapsed) + " flex-1 truncate",
          title: section
        },
        section
      ),
      count === undefined
        ? null
        : React.createElement(
            "span",
            {
              className:
                expandedOnlyClass(isCollapsed) +
                " text-xs bg-surface-raised px-2 py-0.5 rounded-full text-fg-muted border border-border-strong tabular-nums"
            },
            count
          )
    )
  );
}

function expandedOnlyClass(isCollapsed: boolean): string {
  return isCollapsed ? "hidden" : "inline";
}
