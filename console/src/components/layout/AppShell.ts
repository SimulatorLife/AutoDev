"use client";

import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import { usePathname } from "next/navigation.js";
import React from "react";

import { canonicalSectionFromPath } from "../../lib/routes.ts";
import {
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS
} from "../forms/Button.ts";
import { AppNav } from "../navigation/AppNav.ts";
import { CommandPalette } from "../navigation/CommandPalette.ts";
import { NavigationLink } from "../navigation/NavigationLink.ts";
import { MUTED_META_CLASS, MUTED_TEXT_CLASS } from "../ui/text-classes.ts";
import { PageBody } from "./PageBody.ts";
import { DETAIL_PANEL_CLASS, DETAIL_PANEL_SHAPE } from "./Panel.ts";
import { SkipLink } from "./SkipLink.ts";

export interface AppShellProps {
  /**
   * The section this page belongs to.
   *
   * It is absent for a page that is not one of the Console's sections -- the
   * page a bad address lands on, for instance. A page that claims a section it
   * does not belong to puts the wrong name in the heading the navigation owner
   * announces after a navigation, and marks the wrong item in the rail: the
   * operator is told they are on a page they are not on.
   */
  readonly activeSection?: CanonicalNavSection | undefined;
  /**
   * The page's own name, for a page that belongs to no section.
   *
   * Every other page takes its name from the section it belongs to, so this is
   * only for the ones that are not a section's page.
   */
  readonly title?: string | undefined;
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
  title,
  counts,
  children,
  actions,
  description
}: AppShellProps): React.JSX.Element {
  /**
   * What the page calls itself in the header.
   *
   * A page that belongs to a section is named by that section; a page that
   * belongs to no section is named by itself. It has to name itself either
   * way: the heading is the one thing the navigation owner announces after a
   * navigation, and a heading that says "Workspaces" on a page that is not
   * the Workspaces page announces the wrong resource.
   */
  const heading = title ?? activeSection ?? "AutoDev Console";
  /**
   * The heading is focusable so it can receive the focus after an in-place
   * navigation -- the navigation owner moves it there, because a focused
   * heading is also how the new page is announced -- and it is out of the tab
   * order so it is never a stop the operator has to walk past.
   */
  return React.createElement(
    "div",
    {
      className:
        // `w-full`, not `w-screen`: 100vw includes the classic vertical
        // scrollbar gutter, so `w-screen` made the shell wider than the space
        // the document actually had and gave every page a 15px horizontal
        // scroll at widths where a scrollbar is shown.
        "relative flex h-screen w-full bg-background text-fg overflow-hidden font-sans"
    },
    // Before the nav, so it is the first stop in the tab order rather than the
    // fifteenth.
    React.createElement(SkipLink),
    React.createElement(AppNav, {
      activeSection,
      counts
    }),
    React.createElement(
      "main",
      {
        id: "main-content",
        // Focusable so the skip link's target can actually receive focus. The
        // browser scrolls to a fragment target either way, but without this the
        // next Tab continues from the nav, which is the fourteen stops this link
        // exists to avoid. `tabIndex={-1}` keeps it out of the tab order itself.
        tabIndex: -1,
        // `scroll-pb-1` leaves room for the focus ring when the page
        // scrolls a control into view. The Console draws the ring four pixels
        // outside the control, and a control the browser parks at the very
        // bottom of the scrollport would lose the bottom of its ring to the
        // edge of the window.
        className: "flex-1 flex flex-col min-w-0 overflow-y-auto scroll-pb-1.5"
      },
      React.createElement(
        "header",
        {
          className:
            // `flex-wrap` so the title column and the actions slot can stack
            // rather than compete. Without it the row has a minimum intrinsic
            // width set by whichever child refuses to shrink, and on a narrow
            // window the *title* absorbs all of it -- the same failure the
            // section-heading rows on `/mcps` and `/prompts` had, one level up.
            // The action slot wraps too, so a page can use it without forcing a
            // phone-width header to scroll horizontally.
            "min-h-16 border-b border-border bg-surface/50 backdrop-blur px-4 xl:px-8 py-3 flex flex-wrap items-center justify-between gap-6 shrink-0"
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
                // The app's own name gives way to the page's name on a narrow
                // window. At 390px the header row is 291px wide, and the three
                // things in it -- the brand, the title and the palette's
                // trigger -- do not fit: the title was left 34px of a name
                // that needs 71, so every page read "M..." on a phone. The
                // brand is the one that can go, because the collapsed rail
                // already carries the mark and the operator needs to know
                // which *page* they are on.
                className:
                  "hidden text-xs uppercase font-semibold text-fg-muted tracking-wider sm:inline"
              },
              "AutoDev Console"
            ),
            React.createElement(
              "span",
              { className: `hidden sm:inline ${MUTED_TEXT_CLASS}` },
              "/"
            ),
            React.createElement(
              "h1",
              // The page title truncates on a narrow window, and it is the one
              // heading on the page: an ellipsized `h1` tells the operator
              // which page they are on only partially. The full name stays on
              // its hover title, which a phone does not have -- so the title
              // is given the room to be read at a narrow width instead, and
              // only shrinks when there is genuinely no room for it.
              {
                className: "text-base sm:text-lg font-bold text-fg truncate",
                title: heading,
                // Focusable so it can receive the focus after an in-place
                // navigation, and out of the tab order so it is never a stop
                // the operator has to walk past.
                tabIndex: -1
              },
              heading
            ),
            // The palette's trigger sits beside the title rather than inside
            // the navigation: it is a way to reach any resource, not one
            // resource's way round.
            React.createElement(CommandPalette, { activeSection })
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
                  title: description,
                  // A hook, because "does this page say what the resource is
                  // for" is a claim about every route and has to be checkable
                  // on every route rather than read off thirteen source files.
                  // It carries the section, so a check can compare the line
                  // against the canonical sentence for that resource rather
                  // than only notice that some text is there.
                  "data-page-purpose": activeSection
                },
                description
              )
        ),
        actions === undefined
          ? null
          : React.createElement(
              "div",
              {
                className:
                  "flex min-w-0 max-w-full flex-wrap items-center justify-end gap-3"
              },
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

/**
 * The route-level loading boundary keeps the same navigation and page frame
 * visible while a dynamic page waits for its server-owned data.
 */
export function ConsoleLoadingShell(): React.JSX.Element {
  const pathname = usePathname();
  // An address that names no section loads no section: the old fallback
  // claimed Agents, so the heading and the rail named a page the operator was
  // not on while it was still loading.
  const activeSection = canonicalSectionFromPath(pathname ?? "") ?? undefined;
  return React.createElement(ConsoleLoadingPage, { activeSection });
}

/** Accessible fallback used while the Console page's server data is pending. */
export function ConsoleLoadingPage({
  activeSection
}: {
  readonly activeSection: CanonicalNavSection | undefined;
}): React.JSX.Element {
  return React.createElement(
    AppShell,
    { activeSection },
    React.createElement(
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
        activeSection === undefined
          ? "Loading…"
          : `Loading ${activeSection.toLowerCase()}…`
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
    )
  );
}

/**
 * Route-level 404 boundary rendered when a route does not exist.
 */
export function ConsoleNotFoundShell(): React.JSX.Element {
  // The page a bad address lands on belongs to no section, and it says so:
  // the old fallback claimed Workspaces, so the heading named a page the
  // operator was not on and the rail marked it as the current one.
  return React.createElement(ConsoleNotFoundPage, { title: "Page not found" });
}

export function ConsoleNotFoundPage({
  title
}: {
  readonly title: string;
}): React.JSX.Element {
  return React.createElement(
    AppShell,
    {
      title,
      description: "The requested Console route or resource does not exist."
    },
    React.createElement(
      PageBody,
      { feature: "not-found" },
      React.createElement(
        "div",
        {
          className: `${DETAIL_PANEL_CLASS} flex flex-col items-center justify-center py-16 text-center`,
          "data-testid": "not-found-page"
        },
        React.createElement(
          "span",
          {
            className:
              "mb-2 font-mono text-4xl font-bold tracking-tight text-fg-muted"
          },
          "404"
        ),
        React.createElement(
          "p",
          { className: `mt-2 max-w-md text-sm ${MUTED_TEXT_CLASS}` },
          "The address you followed does not map to any active AutoDev Console view or resource."
        ),
        React.createElement(
          "div",
          {
            className: "mt-6 flex flex-wrap items-center justify-center gap-3"
          },
          React.createElement(
            NavigationLink,
            {
              href: "/agents",
              className: PRIMARY_BUTTON_CLASS
            },
            "Return to Agents"
          ),
          React.createElement(
            NavigationLink,
            {
              href: "/providers",
              className: SECONDARY_BUTTON_CLASS
            },
            "Providers"
          ),
          React.createElement(
            NavigationLink,
            {
              href: "/workspaces",
              className: SECONDARY_BUTTON_CLASS
            },
            "Workspaces"
          )
        )
      )
    )
  );
}

export interface ConsoleErrorPageProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
  readonly activeSection?: CanonicalNavSection | undefined;
}

/**
 * Route-level error boundary rendered when an uncaught render error occurs.
 */
export function ConsoleErrorShell(props: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  const pathname = usePathname();
  const activeSection = canonicalSectionFromPath(pathname ?? "") ?? "Agents";
  return React.createElement(ConsoleErrorPage, { ...props, activeSection });
}

export function ConsoleErrorPage({
  error,
  reset,
  activeSection = "Agents"
}: ConsoleErrorPageProps): React.JSX.Element {
  return React.createElement(
    AppShell,
    {
      activeSection,
      description:
        "An unexpected error occurred while rendering this Console view."
    },
    React.createElement(
      PageBody,
      { feature: "error-boundary" },
      React.createElement(
        "div",
        {
          role: "alert",
          className: `${DETAIL_PANEL_SHAPE} flex flex-col gap-4 border-error/60 bg-error/10`,
          "data-testid": "console-error-boundary"
        },
        React.createElement(
          "div",
          {
            className:
              "flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
          },
          React.createElement(
            "h2",
            {
              className: "text-base font-semibold text-error tracking-tight"
            },
            "Console render failure"
          ),
          error.digest === undefined
            ? null
            : React.createElement(
                "span",
                {
                  className:
                    "rounded border border-error/60 bg-error/15 px-2 py-0.5 font-mono text-xs text-error"
                },
                `digest: ${error.digest}`
              )
        ),
        React.createElement(
          "p",
          { className: "text-sm text-fg-secondary leading-relaxed" },
          error.message ||
            "An unexpected error occurred while rendering this page."
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "Verify that the AutoDev services are running and check browser/server logs."
        ),
        React.createElement(
          "div",
          { className: "mt-2 flex flex-wrap items-center gap-3" },
          React.createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                reset();
              },
              className: PRIMARY_BUTTON_CLASS
            },
            "Try again"
          ),
          React.createElement(
            NavigationLink,
            {
              href: "/agents",
              className: SECONDARY_BUTTON_CLASS
            },
            "Return to Agents"
          )
        )
      )
    )
  );
}
