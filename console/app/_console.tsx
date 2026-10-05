/**
 * Server-side helpers shared by every Console route.
 *
 * Server-only. Must never be imported from any client component. The
 * persistent navigation shell is owned by the root layout, so pages render
 * only their own content (or an explicit unavailable state).
 */

import React from "react";

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
        "rounded-lg border border-error/40 bg-error/10 p-6 shadow flex flex-col gap-3",
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
          className: "text-base font-semibold text-error tracking-tight"
        },
        title
      ),
      React.createElement(
        "span",
        {
          className:
            "text-xs font-mono text-error bg-error/15 border border-error/40 px-2 py-0.5 rounded"
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
