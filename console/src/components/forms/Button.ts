import React from "react";

/**
 * The Console's button vocabulary.
 *
 * A filter bar used to render its primary action three different ways, which
 * reads as three different products. Buttons stay native `<button>` elements so
 * form submission and focus behaviour stay correct; only the chrome is shared.
 */

/** The one primary action in a group: applying, saving, confirming. */
export const PRIMARY_BUTTON_CLASS =
  "rounded border border-transparent bg-accent px-3 py-1.5 text-sm font-medium text-fg-inverse transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60";

/** A supporting action: secondary filters, cancel, and inline toggles. */
export const SECONDARY_BUTTON_CLASS =
  "rounded border border-border-strong bg-surface-raised px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";

/**
 * An irreversible action: erasing or purging. Separate from the error status
 * colour so "this control is destructive" reads consistently with every other
 * destructive control rather than being re-typed per feature.
 */
export const DESTRUCTIVE_BUTTON_CLASS =
  "rounded border border-error/40 bg-error/15 px-3 py-1.5 text-sm font-medium text-error transition-colors hover:bg-error/25 disabled:cursor-not-allowed disabled:opacity-60";

export interface ButtonProps {
  /** Optional here so callers can pass the label as `createElement`'s child. */
  readonly children?: React.ReactNode;
  readonly type?: "submit" | "button" | "reset" | undefined;
  readonly variant?: "primary" | "secondary" | "destructive" | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
}

const BUTTON_VARIANT_CLASS = {
  primary: PRIMARY_BUTTON_CLASS,
  secondary: SECONDARY_BUTTON_CLASS,
  destructive: DESTRUCTIVE_BUTTON_CLASS
} as const;

export function Button({
  children,
  type = "button",
  variant = "secondary",
  disabled,
  className,
  title,
  onClick,
  testId
}: ButtonProps): React.JSX.Element {
  return React.createElement(
    "button",
    {
      type,
      onClick,
      ...(disabled === undefined ? {} : { disabled }),
      ...(title === undefined ? {} : { title }),
      className: `${BUTTON_VARIANT_CLASS[variant]}${
        className === undefined ? "" : ` ${className}`
      }`,
      ...(testId === undefined ? {} : { "data-button": testId })
    },
    children
  );
}
