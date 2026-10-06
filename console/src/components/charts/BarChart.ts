import React from "react";

import { EMPTY_INLINE_CLASS, EmptyState } from "../status/EmptyState.ts";

/**
 * Console horizontal bar chart.
 *
 * The target state requires a charts primitive and says charts belong on
 * usage, history and observability surfaces. It also forbids client JavaScript,
 * so a chart has to be something the server can finish.
 *
 * The bars are elements rather than SVG paths, which is what makes that
 * possible: the value encoding is a percentage width, and the label and the
 * value stay real text — selectable, translatable, and readable by assistive
 * technology in order, instead of being geometry a screen reader has to be told
 * about. The list is the chart's own semantics; the bar is the shape on top of
 * it, so no `role="img"` summary is needed and nothing is hidden behind an
 * accessible name.
 *
 * The bar width is the one length here that cannot be a Tailwind class, because
 * it comes from the data. It is written as an inline percentage style, the same
 * way `DataTable` writes a column's resolved weight.
 */

export interface BarChartDatum {
  /** Dimension value, already rendered for display (e.g. "Not attributed"). */
  readonly label: string;
  /** Drives the bar length. Never used as a label — the label is `label`. */
  readonly value: number;
  /** Pre-formatted so the caller's own formatting rules stay authoritative. */
  readonly valueText: string;
}

export interface BarChartProps {
  /**
   * `null` means the source was not observed, which is different from "observed
   * and empty". The two never collapse into an empty chart, because an empty
   * chart reads as a measurement of zero.
   */
  readonly data: readonly BarChartDatum[] | null;
  readonly label: string;
  readonly notObservedMessage: string;
  readonly emptyMessage: string;
  /** Bar fill, e.g. `bg-chart-1`. One series, so one colour for every bar. */
  readonly barClass: string;
  /** Applied to the value text; defaults to the foreground token. */
  readonly valueClass?: string | undefined;
}

/**
 * A bar narrower than this is invisible and reads as a missing bar rather than a
 * small one, so it is floored — the exact value is printed beside it either way.
 */
const MIN_BAR_WIDTH_PERCENT = 1.5;

export function BarChart({
  data,
  label,
  notObservedMessage,
  emptyMessage,
  barClass,
  valueClass = "text-fg"
}: BarChartProps): React.JSX.Element {
  // Unobserved and empty are different facts, so they keep different
  // components -- but they occupy the same slot in the same panel, so they
  // share one treatment. A reader comparing two charts should not be able to
  // tell from the typography alone that one source is missing and the other
  // reported nothing; the words say which, and only the words do.
  if (data === null) {
    return React.createElement(
      "p",
      { className: EMPTY_INLINE_CLASS },
      notObservedMessage
    );
  }
  if (data.length === 0) {
    return React.createElement(EmptyState, {
      message: emptyMessage,
      variant: "inline"
    });
  }

  // The longest bar is the axis maximum, so the shape stays readable whatever
  // the absolute totals are. Every observed value is non-negative, so the
  // guard only fires on a source that reported nothing usable.
  const max = data.reduce((highest, item) => Math.max(highest, item.value), 0);
  const scale = (value: number): number =>
    max <= 0 ? 0 : Math.max(MIN_BAR_WIDTH_PERCENT, (value / max) * 100);

  return React.createElement(
    "ul",
    { className: "flex flex-col gap-1.5", "aria-label": label },
    ...data.map((item) =>
      React.createElement(
        "li",
        {
          key: item.label,
          // The bar column is capped rather than allowed to fill its panel. A bar
          // length only means something against a fixed scale, and these widgets
          // sit in panels of different widths; without a cap the same value
          // draws a longer bar in the wider panel, and a single-entry chart
          // stretches one bar across the whole page. The value column is
          // `max-content` rather than `auto` because an `auto` track absorbs the
          // panel's free space, which strands the number far from its own bar.
          className:
            "grid grid-cols-[minmax(0,7rem)_minmax(0,22rem)_max-content] items-center gap-3 text-xs"
        },
        React.createElement(
          "span",
          {
            className: "truncate font-mono text-fg",
            // The label column is deliberately narrow so the bars keep their
            // length; the untruncated value stays reachable on hover.
            title: item.label
          },
          item.label
        ),
        React.createElement(
          "span",
          {
            className: "h-2 overflow-hidden rounded-sm bg-surface-raised",
            "aria-hidden": true
          },
          React.createElement("span", {
            className: `block h-full rounded-sm ${barClass}`,
            style: { width: `${scale(item.value)}%` }
          })
        ),
        React.createElement(
          "span",
          {
            className: `text-right tabular-nums font-semibold ${valueClass}`
          },
          item.valueText
        )
      )
    )
  );
}
