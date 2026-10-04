import React from "react";

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
  configured: "bg-accent/15 text-accent border-accent/40",
  valid: "bg-success/15 text-success border-success/40",
  invalid: "bg-error/15 text-error border-error/40",
  ready: "bg-success/15 text-success border-success/40",
  unavailable: "bg-warning/15 text-warning border-warning/40",
  converged: "bg-success/15 text-success border-success/40",
  pending: "bg-accent/15 text-accent border-accent/40",
  error: "bg-error/15 text-error border-error/40",
  "not-observed": "bg-neutral/15 text-neutral border-neutral/40"
};

const DEFAULT_STYLE = "bg-neutral/15 text-neutral border-neutral/40";

export function StatusBadge({
  status,
  label
}: StatusBadgeProps): React.JSX.Element {
  const style = BADGE_STYLES[status] ?? DEFAULT_STYLE;
  const displayLabel =
    label ?? status.charAt(0).toUpperCase() + status.slice(1);

  return React.createElement(
    "span",
    {
      className: `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`,
      "data-status": status
    },
    React.createElement("span", {
      className: "w-1.5 h-1.5 rounded-full bg-current mr-1.5 opacity-80"
    }),
    displayLabel
  );
}
