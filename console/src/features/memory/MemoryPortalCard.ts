import React from "react";

export interface MemoryPortalCardProps {
  /** The resolved, validated Memory destination URL (always `/memory`). */
  readonly href: string;
}

/**
 * Transitional Console-shell link to the external Memory UI.
 *
 * The AutoDev Console remains the primary Memory operator surface. This link
 * is temporary while remaining connector/reporting workflows are migrated;
 * it does not embed the external page or duplicate its unported capabilities.
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
      "External Memory UI"
    ),
    React.createElement(
      "p",
      { className: "text-sm text-fg-secondary leading-relaxed" },
      "Use this temporary external page only for Memory workflows not yet " +
        "available in the AutoDev Console. The native Memory view remains the " +
        "primary surface for records, experiences, and outcome cohorts."
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
      "Open external Memory UI"
    )
  );
}
