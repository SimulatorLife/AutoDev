/**
 * Server-side helpers shared by every Console route.
 *
 * Server-only. Imports `./src/lib/server/...` and `./src/components/...`.
 * Must never be imported from any client component.
 */

import { type CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import { AppShell } from "../src/components/layout/AppShell.ts";
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
      className:
        "rounded-lg border border-rose-800 bg-rose-950/40 p-6 shadow flex flex-col gap-3",
      role: "alert",
      "data-status": "unavailable",
      "data-error-code": code
    },
    React.createElement(
      "div",
      { className: "flex items-center justify-between gap-3" },
      React.createElement(
        "h2",
        {
          className: "text-base font-semibold text-rose-200 tracking-tight"
        },
        title
      ),
      React.createElement(
        "span",
        {
          className:
            "text-xs font-mono text-rose-300 bg-rose-900/60 border border-rose-800 px-2 py-0.5 rounded"
        },
        code
      )
    ),
    React.createElement(
      "p",
      { className: "text-sm text-rose-100/90 leading-relaxed" },
      message
    ),
    React.createElement(
      "p",
      { className: "text-xs text-rose-200/70" },
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
  children
}: {
  readonly section: CanonicalNavSection;
  readonly counts?: Partial<Record<CanonicalNavSection, number>> | undefined;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    AppShell,
    { activeSection: section, counts },
    children
  );
}
