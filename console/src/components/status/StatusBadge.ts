import React from "react";

export type StatusBadgeVariant =
  | "configured"
  | "valid"
  | "invalid"
  | "ready"
  | "unavailable"
  | "converged"
  | "pending"
  | "error";

export interface StatusBadgeProps {
  readonly status: StatusBadgeVariant;
  readonly label?: string;
}

const BADGE_STYLES: Record<StatusBadgeVariant, string> = {
  configured: "bg-blue-900/40 text-blue-300 border-blue-700/60",
  valid: "bg-emerald-900/40 text-emerald-300 border-emerald-700/60",
  invalid: "bg-rose-900/40 text-rose-300 border-rose-700/60",
  ready: "bg-emerald-900/40 text-emerald-300 border-emerald-700/60",
  unavailable: "bg-amber-900/40 text-amber-300 border-amber-700/60",
  converged: "bg-teal-900/40 text-teal-300 border-teal-700/60",
  pending: "bg-indigo-900/40 text-indigo-300 border-indigo-700/60",
  error: "bg-rose-900/40 text-rose-300 border-rose-700/60"
};

export function StatusBadge({ status, label }: StatusBadgeProps): React.JSX.Element {
  const style =
    BADGE_STYLES[status] ?? "bg-slate-800 text-slate-300 border-slate-700";
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
