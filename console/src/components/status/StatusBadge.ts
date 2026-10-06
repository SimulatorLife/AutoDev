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
  const displayLabel =
    label ?? status.charAt(0).toUpperCase() + status.slice(1);

  return React.createElement(
    "span",
    {
      // A badge is an atomic status word: it never wraps and never triggers a
      // cell's `text-overflow: ellipsis`. A column that cannot fit a badge is a
      // column-width problem, and the word stays legible rather than becoming
      // "Not-observed…".
      className: `inline-flex w-fit max-w-full items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`,
      "data-status": status,
      ...(title === undefined ? {} : { title })
    },
    React.createElement("span", {
      className:
        "w-1.5 h-1.5 shrink-0 rounded-full bg-current mr-1.5 opacity-80"
    }),
    displayLabel
  );
}
