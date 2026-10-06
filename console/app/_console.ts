/**
 * Server-side helpers shared by every Console route.
 *
 * Server-only. Imports `./src/lib/server/...` and `./src/components/...`.
 * Must never be imported from any client component.
 */

import { type CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { AppShell } from "../src/components/layout/AppShell.ts";
import { DETAIL_PANEL_SHAPE } from "../src/components/layout/Panel.ts";
import { canonicalSectionFromPath } from "../src/lib/routes.ts";
import {
  type ControlApiConfig,
  readControlApiConfig
} from "../src/lib/server/control-api.ts";

export interface NodeContext {
  readonly config: ControlApiConfig | null;
  readonly section: CanonicalNavSection;
}

/**
 * Resolve the shared, server-only Console context for a route. The control API
 * configuration is `null` when the service token is missing; the route is
 * responsible for rendering an explicit unavailable state instead of falling
 * back to fabricated data.
 */
export function readNodeContext(pathname: string): NodeContext {
  const section = canonicalSectionFromPath(pathname);
  if (!section) {
    throw new Error(
      `Console route path '${pathname}' does not map to a canonical section.`
    );
  }
  return { section, config: readControlApiConfig() };
}

export interface UnavailableProps {
  readonly title: string;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

export function ResourceUnavailable({
  title,
  code,
  message,
  hint
}: UnavailableProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      // The failure shell starts from the panel *shape*, not the finished panel, so
      // the severity tint is not competing with the default `bg-surface`.
      className: `${DETAIL_PANEL_SHAPE} flex flex-col gap-3 border-error/40 bg-error/10`,
      role: "alert",
      "data-status": "unavailable",
      "data-error-code": code
    },
    React.createElement(
      "div",
      // An error code is an unbroken machine token that is routinely longer than
      // a narrow card. The row wraps and the code may break anywhere, so a long
      // code never pushes the card (or the document) sideways.
      {
        className: "flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      },
      React.createElement(
        "h2",
        {
          className: "min-w-0 text-base font-semibold text-error tracking-tight"
        },
        title
      ),
      React.createElement(
        "span",
        {
          // An error code is an unbroken machine token that is routinely longer
          // than a narrow card, and it has nowhere to break but mid-word. This
          // is deliberately not the shared tag shape: that shape sets
          // `whitespace-nowrap`, and a later `whitespace-normal` in the class
          // attribute does not override it — Tailwind resolves two utilities on
          // the same property by stylesheet order. The surrounding row still
          // wraps, so a long code never pushes the card or the document
          // sideways.
          className:
            "max-w-full break-all rounded border border-error/40 bg-error/15 px-2 py-0.5 font-mono text-xs text-error"
        },
        code
      )
    ),
    React.createElement(
      "p",
      { className: "text-sm text-fg-secondary leading-relaxed" },
      message
    ),
    React.createElement(
      "p",
      { className: "text-xs text-fg-muted" },
      hint ??
        "Configure the required server-side integration and restart the Console."
    )
  );
}

/**
 * Render a Console page with the shared AppShell using the canonical section
 * for navigation highlighting. Counts are surfaced from the props when known
 * so the sidebar reflects the loaded resource state.
 */
export function ConsolePageShell({
  section,
  counts,
  description,
  children
}: {
  readonly section: CanonicalNavSection;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
  readonly description?: string | undefined;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    AppShell,
    { activeSection: section, counts, description },
    children
  );
}
