import React from "react";

export interface MemoryPortalCardProps {
  /** The resolved, validated Memory destination URL (always `/memory`). */
  readonly href: string;
}

/**
 * Console-shell entry card for Memory.
 *
 * The retained AutoDev Memory operator page is the sole Memory operator UI
 * (lifecycle actions, provenance/history, per-experience outcomes, and the
 * bounded cohort view). This card never reimplements that
 * CRUD/list/detail/cohort UI, never calls the Memory Control API, and never
 * embeds the page in an iframe; it only links out to the authoritative
 * destination in a new browsing context.
 */
export function MemoryPortalCard({
  href
}: MemoryPortalCardProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow",
      "data-feature": "memory-portal"
    },
    React.createElement(
      "h2",
      { className: "text-base font-semibold text-fg tracking-tight" },
      "Memory"
    ),
    React.createElement(
      "p",
      { className: "text-sm text-fg-secondary leading-relaxed" },
      "Memory lifecycle, provenance/history, per-experience outcomes, and the " +
        "bounded outcome-cohort view are governed in the Memory operator " +
        "destination. This Console entry links to that page; it does not " +
        "duplicate its record browsing, search, write, or cohort views."
    ),
    React.createElement(
      "a",
      {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        "data-memory-portal-link": "true",
        className:
          "inline-flex w-fit items-center gap-2 rounded border border-border-strong " +
          "bg-background px-4 py-2 text-sm font-medium text-fg " +
          "hover:border-border-strong"
      },
      "Open AutoDev Memory"
    )
  );
}
