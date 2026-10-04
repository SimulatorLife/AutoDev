import React from "react";

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
          className: "text-2xl font-bold text-fg tracking-tight"
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
    subtitle
      ? React.createElement(
          "p",
          { className: "mt-1 text-xs text-fg-muted" },
          subtitle
        )
      : null
  );
}
