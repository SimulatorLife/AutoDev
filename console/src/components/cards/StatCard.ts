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

/**
 * Whether a card's value reports nothing at all.
 *
 * The obvious test is `value === NOT_OBSERVED_LABEL`, and it missed a real card.
 * `/usage` builds one value from two measurements -- input and output tokens --
 * so the card said "Not observed / Not observed": unobserved twice over, and
 * rendered at `text-2xl` bold because neither half equals the label on its own.
 * The card therefore read as the row's one confident measurement while its three
 * neighbours were correctly quiet, which is the exact failure the meta treatment
 * exists to prevent -- reintroduced through a string the card cannot compare.
 *
 * So the test asks the question the card is actually asking: is there a
 * measurement anywhere in this value? A composite counts as observed when any
 * part is observed, including a measured `0`, so a genuinely half-observed card
 * keeps the value scale rather than being understated.
 */
function isUnobserved(value: string | number): boolean {
  if (typeof value === "number") return false;
  const parts = value
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => part === NOT_OBSERVED_LABEL);
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
  const unobserved = isUnobserved(value);
  const redundantSubtitle = unobserved && subtitle === NOT_OBSERVED_LABEL;

  // A card is a labelled fact, and this module already says what a labelled fact
  // is: `DetailGrid` is "the <dl> behind a row of label/value pairs" and
  // `FieldBox` groups each term with its description as a `<dt>`/`<dd>` pair.
  // This card was `div > span > span` -- the same shape `FieldBox`'s comment
  // names as "neither a definition list nor announced as one" -- so five cards
  // on the Evaluations page read as one flat run of fifteen fragments with
  // nothing pairing "PASSED" with 34 or "PASS RATE" with 40%. Every resource
  // that shows a row of cards had that.
  //
  // The term and its description sit in one grouping `<div>` because HTML allows
  // a `<dl>` only `<dt>`, `<dd>`, and `<div>`s wrapping them, and a `<div>` is
  // what pairs them. Splitting the title row from the value row -- which is how
  // the card was laid out, with a badge beside the title -- would put the term
  // in one group and its description in another, so each would announce alone.
  // The badge stays beside the term and the trend beside the value, because that
  // is what each qualifies.
  return React.createElement(
    "dl",
    {
      className:
        "bg-surface border border-border rounded-lg p-5 shadow-sm flex flex-col justify-between"
    },
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { className: "flex items-center justify-between mb-2" },
        React.createElement(
          "dt",
          {
            className:
              "text-xs font-medium text-fg-muted uppercase tracking-wider"
          },
          title
        ),
        badge
      ),
      React.createElement(
        "dd",
        null,
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
      )
    )
  );
}
