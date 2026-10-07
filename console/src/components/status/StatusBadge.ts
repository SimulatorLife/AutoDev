import React from "react";

import {
  ACCENT_TONE_CLASS,
  ERROR_TONE_CLASS,
  NEUTRAL_TONE_CLASS,
  SUCCESS_TONE_CLASS,
  WARNING_TONE_CLASS
} from "../ui/tones.ts";

export type StatusBadgeVariant =
  | "configured"
  | "valid"
  | "invalid"
  | "ready"
  | "unavailable"
  | "converged"
  | "pending"
  | "error"
  | "not-observed";

export interface StatusBadgeProps {
  readonly status: StatusBadgeVariant;
  readonly label?: string;
  /** Extra explanation revealed on hover, for a verbose state behind a short label. */
  readonly title?: string | undefined;
}

/**
 * Semantic style for every status variant, expressed purely in terms of the
 * Console's dark-only semantic tokens (accent/success/warning/error/neutral)
 * defined in app/globals.css. No raw Tailwind palette utility is used here:
 *
 * - configured, pending: accent (an assigned/active value awaiting or
 *   reflecting an operator decision; not itself a correctness claim).
 * - valid, ready, converged: success (explicitly observed correct/healthy
 *   state).
 * - unavailable: warning (a known, non-fatal gap in observed state).
 * - invalid, error: error (an explicitly observed failure/incorrect state).
 * - not-observed: neutral (missing evidence; never implied as success).
 */
const BADGE_STYLES: Record<StatusBadgeVariant, string> = {
  configured: ACCENT_TONE_CLASS,
  valid: SUCCESS_TONE_CLASS,
  invalid: ERROR_TONE_CLASS,
  ready: SUCCESS_TONE_CLASS,
  unavailable: WARNING_TONE_CLASS,
  converged: SUCCESS_TONE_CLASS,
  pending: ACCENT_TONE_CLASS,
  error: ERROR_TONE_CLASS,
  "not-observed": NEUTRAL_TONE_CLASS
};

const DEFAULT_STYLE = NEUTRAL_TONE_CLASS;

/**
 * The Console's word for missing evidence.
 *
 * "Not observed" is the product's load-bearing string: it is the answer the
 * Console gives when configuration exists but nothing has reported back, and
 * the target state requires exactly this vocabulary rather than any friendly
 * synonym. It was declared as a local `const NOT_OBSERVED_LABEL` in eight
 * feature files, which means the one word that must never drift is the word
 * most likely to: a view can say "Unknown" or "Unavailable" beside a badge
 * that says "Not observed", and the page then appears to contradict itself
 * about whether evidence is missing or actively wrong.
 *
 * It lives beside `StatusBadge` rather than in a text-treatment module because
 * it is a state, not a style: it is what `StatusBadge` renders for
 * `not-observed`, and the label and the variant are two spellings of one fact.
 */
export const NOT_OBSERVED_LABEL = "Not observed";

/**
 * The word each variant renders when the caller supplies no `label` of its own.
 *
 * This used to be derived from the variant key at render time
 * (`status.charAt(0).toUpperCase() + status.slice(1)`), which silently made the
 * spelling of a status a property of the *call site*. `not-observed` is the only
 * hyphenated variant, so that one expression rendered "Not observed" wherever a
 * view remembered to pass `NOT_OBSERVED_LABEL` and "Not-observed" everywhere
 * else — the same drift the constant above exists to prevent, reintroduced one
 * layer down by the default it was supposed to be safe behind. Two spellings of
 * the product's load-bearing word were both live on `/agents` at once.
 *
 * A `Record` over the variant union also makes the table exhaustive: adding a
 * variant without deciding its word is a typecheck failure rather than a
 * surprise on a page.
 */
const VARIANT_LABEL: Record<StatusBadgeVariant, string> = {
  configured: "Configured",
  valid: "Valid",
  invalid: "Invalid",
  ready: "Ready",
  unavailable: "Unavailable",
  converged: "Converged",
  pending: "Pending",
  error: "Error",
  "not-observed": NOT_OBSERVED_LABEL
};

/**
 * Foreground token per status variant, for places that carry the status as a
 * mark rather than a word (a dot beside a compact chip). Keeps one vocabulary:
 * a status never renders green in one component and success-green in another.
 */
const STATUS_DOT_CLASS: Record<StatusBadgeVariant, string> = {
  configured: "bg-accent",
  valid: "bg-success",
  invalid: "bg-error",
  ready: "bg-success",
  unavailable: "bg-warning",
  converged: "bg-success",
  pending: "bg-accent",
  error: "bg-error",
  "not-observed": "bg-neutral"
};

export interface StatusDotProps {
  readonly status: StatusBadgeVariant;
  /** Accessible description of what the dot means, e.g. "Enabled". */
  readonly label: string;
}

/**
 * A status rendered as a colored mark instead of a word, for dense rows where
 * repeating "Enabled" beside every item triples the row height. The label stays
 * available to assistive technology and as a hover title, so compactness never
 * costs the state.
 */
export function StatusDot({
  status,
  label
}: StatusDotProps): React.JSX.Element {
  const dot = STATUS_DOT_CLASS[status] ?? STATUS_DOT_CLASS["not-observed"];
  return React.createElement("span", {
    className: `${dot} inline-block h-1.5 w-1.5 shrink-0 rounded-full`,
    title: label,
    role: "img",
    "aria-label": label,
    "data-status": status
  });
}

export function StatusBadge({
  status,
  label,
  title
}: StatusBadgeProps): React.JSX.Element {
  const style = BADGE_STYLES[status] ?? DEFAULT_STYLE;
  const displayLabel = label ?? VARIANT_LABEL[status];

  return React.createElement(
    "span",
    {
      // A badge is an atomic status word: it never wraps. A column that cannot
      // fit a badge is a column-width problem, and the word should stay legible
      // rather than becoming "Not-observed…".
      //
      // It cannot always, though, and this is why the truncation lives here
      // rather than at each call site's `weight`. A weight is a share of the
      // table, and the table's width is whatever the container gives it, so one
      // number cannot be right for a box whose pixel width is fixed: three
      // columns here had been widened by hand, each with a comment recording
      // that the badge had been cut, and each still cut it at 390px because
      // the next narrower viewport moved the ground.
      className: `inline-flex w-fit max-w-full items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`,
      "data-status": status,
      // A caller may pass a longer explanation than the word; otherwise the
      // word itself is what the reader needs back when it is cut.
      title: title ?? displayLabel
    },
    React.createElement("span", {
      className:
        "w-1.5 h-1.5 shrink-0 rounded-full bg-current mr-1.5 opacity-80"
    }),
    // The ellipsis has to live on the label rather than on the badge. The badge
    // is a flex container, and `text-overflow` does not apply to one — which is
    // why the cut was invisible: the box simply ran out. `min-w-0` is what lets
    // this item shrink below its `white-space: nowrap` min-content at all.
    React.createElement("span", { className: "min-w-0 truncate" }, displayLabel)
  );
}
