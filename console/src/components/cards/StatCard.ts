import React from "react";

import { NOT_OBSERVED_LABEL } from "../status/StatusBadge.ts";

export interface StatCardProps {
  readonly title: string;
  readonly value: string | number;
  readonly subtitle?: string;
  readonly trend?: {
    readonly value: number;
    readonly isPositive: boolean;
  };
  readonly badge?: React.ReactNode;
}

export function StatCard({
  title,
  value,
  subtitle,
  trend,
  badge
}: StatCardProps): React.JSX.Element {
  // "Not observed" is the absence of a measurement, not a measurement, and
  // rendering it in the value slot at value scale broke two things at once.
  //
  // It is a two-word label where a number is three or four glyphs, so at
  // `text-2xl` bold it wrapped inside a 200px card and pushed the subtitle down:
  // in a four-card row the sibling cards read `0` on one baseline and the
  // unobserved card read `Not observed` on another, with the card itself
  // growing taller than the three beside it. And the callers that supply both a
  // value and a subtitle said the same thing twice, so the row rendered
  // "Not observed" over "Not observed".
  //
  // So an absent measurement gets the card's meta treatment, the row's baseline
  // stays the row's baseline, and a subtitle that only repeats it is dropped
  // rather than printed twice. A real value -- including a measured zero -- is
  // untouched.
  const unobserved = value === NOT_OBSERVED_LABEL;
  const redundantSubtitle = unobserved && subtitle === NOT_OBSERVED_LABEL;

  return React.createElement(
    "div",
    {
      className:
        "bg-surface border border-border rounded-lg p-5 shadow-sm flex flex-col justify-between"
    },
    React.createElement(
      "div",
      { className: "flex items-center justify-between mb-2" },
      React.createElement(
        "span",
        {
          className:
            "text-xs font-medium text-fg-muted uppercase tracking-wider"
        },
        title
      ),
      badge
    ),
    React.createElement(
      "div",
      { className: "flex items-baseline gap-2" },
      React.createElement(
        "span",
        {
          className: unobserved
            ? "text-sm text-fg-muted"
            : "text-2xl font-bold text-fg tracking-tight",
          ...(unobserved ? { "data-stat-unobserved": "true" } : {})
        },
        value
      ),
      trend
        ? React.createElement(
            "span",
            {
              className: `text-xs font-semibold ${
                trend.isPositive ? "text-success" : "text-error"
              }`
            },
            `${trend.isPositive ? "+" : ""}${trend.value}%`
          )
        : null
    ),
    subtitle && !redundantSubtitle
      ? React.createElement(
          "p",
          { className: "mt-1 text-xs text-fg-muted" },
          subtitle
        )
      : null
  );
}
