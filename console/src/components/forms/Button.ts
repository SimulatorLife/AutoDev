import React from "react";

/**
 * The Console's button vocabulary.
 *
 * A filter bar used to render its primary action three different ways, which
 * reads as three different products. Buttons stay native `<button>` elements so
 * form submission and focus behaviour stay correct; only the chrome is shared.
 */

const DEFAULT_BUTTON_SIZE_CLASS = "px-3 py-1.5 text-sm font-medium";
const COMPACT_BUTTON_SIZE_CLASS = "px-2 py-1 text-xs font-medium";

/** The one primary action in a group: applying, saving, confirming. */
const PRIMARY_BUTTON_BEFORE_SIZE_CLASS =
  "rounded border border-transparent bg-accent";
const PRIMARY_BUTTON_AFTER_SIZE_CLASS =
  "text-fg-inverse transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60";
export const PRIMARY_BUTTON_CLASS = `${PRIMARY_BUTTON_BEFORE_SIZE_CLASS} ${DEFAULT_BUTTON_SIZE_CLASS} ${PRIMARY_BUTTON_AFTER_SIZE_CLASS}`;

/** A supporting action: secondary filters, cancel, and inline toggles. */
const SECONDARY_BUTTON_BEFORE_SIZE_CLASS =
  "rounded border border-border-strong bg-surface-raised";
const SECONDARY_BUTTON_AFTER_SIZE_CLASS =
  "text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";
export const SECONDARY_BUTTON_CLASS = `${SECONDARY_BUTTON_BEFORE_SIZE_CLASS} ${DEFAULT_BUTTON_SIZE_CLASS} ${SECONDARY_BUTTON_AFTER_SIZE_CLASS}`;

/** A compact outlined control such as the sidebar collapse toggle. */
const OUTLINE_BUTTON_CHROME_CLASS =
  "rounded-full border border-border-strong bg-surface text-fg shadow-sm transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60";
export const OUTLINE_BUTTON_CLASS = OUTLINE_BUTTON_CHROME_CLASS;

const ICON_BUTTON_SIZE_CLASS = "h-6 w-6 p-0 text-sm font-medium";

/**
 * An irreversible action: erasing or purging. Separate from the error status
 * colour so "this control is destructive" reads consistently with every other
 * destructive control rather than being re-typed per feature.
 */
const DESTRUCTIVE_BUTTON_BEFORE_SIZE_CLASS =
  "rounded border border-error/60 bg-error/15";
const DESTRUCTIVE_BUTTON_AFTER_SIZE_CLASS =
  "text-error transition-colors hover:bg-error/25 disabled:cursor-not-allowed disabled:opacity-60";
export const DESTRUCTIVE_BUTTON_CLASS = `${DESTRUCTIVE_BUTTON_BEFORE_SIZE_CLASS} ${DEFAULT_BUTTON_SIZE_CLASS} ${DESTRUCTIVE_BUTTON_AFTER_SIZE_CLASS}`;

export interface ButtonProps {
  /** Optional here so callers can pass the label as `createElement`'s child. */
  readonly children?: React.ReactNode;
  readonly type?: "submit" | "button" | "reset" | undefined;
  readonly variant?:
    "primary" | "secondary" | "destructive" | "outline" | undefined;
  readonly size?: "default" | "compact" | "icon" | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  /**
   * The field name and value a submit button contributes to its form.
   *
   * A server-rendered control that expresses a choice cannot hold that choice in
   * component state, because there is no component state on the server. It
   * submits it: the button carries the value it would set under its own field
   * name, which is what lets a row offer several choices from one form without
   * a client-side handler to remember which was picked. The name is deliberately
   * the caller's to choose -- it is the wire contract between the control and
   * the route, not a detail of the button's appearance.
   */
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  /** Extra attributes, for state flags and ARIA the vocabulary does not model. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
  /** Accessible name, when the visible label alone does not describe the action. */
  readonly ariaLabel?: string | undefined;
  readonly ariaControls?: string | undefined;
  readonly ariaExpanded?: boolean | undefined;
}

const BUTTON_VARIANT_CLASS = {
  primary: PRIMARY_BUTTON_CLASS,
  secondary: SECONDARY_BUTTON_CLASS,
  destructive: DESTRUCTIVE_BUTTON_CLASS,
  outline: OUTLINE_BUTTON_CLASS
} as const;

const BUTTON_VARIANT_COMPACT_CLASS = {
  primary: `${PRIMARY_BUTTON_BEFORE_SIZE_CLASS} ${COMPACT_BUTTON_SIZE_CLASS} ${PRIMARY_BUTTON_AFTER_SIZE_CLASS}`,
  secondary: `${SECONDARY_BUTTON_BEFORE_SIZE_CLASS} ${COMPACT_BUTTON_SIZE_CLASS} ${SECONDARY_BUTTON_AFTER_SIZE_CLASS}`,
  destructive: `${DESTRUCTIVE_BUTTON_BEFORE_SIZE_CLASS} ${COMPACT_BUTTON_SIZE_CLASS} ${DESTRUCTIVE_BUTTON_AFTER_SIZE_CLASS}`,
  outline: `${OUTLINE_BUTTON_CLASS} ${COMPACT_BUTTON_SIZE_CLASS}`
} as const;

const BUTTON_VARIANT_ICON_CLASS = {
  primary: `${PRIMARY_BUTTON_BEFORE_SIZE_CLASS} ${ICON_BUTTON_SIZE_CLASS} ${PRIMARY_BUTTON_AFTER_SIZE_CLASS}`,
  secondary: `${SECONDARY_BUTTON_BEFORE_SIZE_CLASS} ${ICON_BUTTON_SIZE_CLASS} ${SECONDARY_BUTTON_AFTER_SIZE_CLASS}`,
  destructive: `${DESTRUCTIVE_BUTTON_BEFORE_SIZE_CLASS} ${ICON_BUTTON_SIZE_CLASS} ${DESTRUCTIVE_BUTTON_AFTER_SIZE_CLASS}`,
  outline: `${OUTLINE_BUTTON_CLASS} ${ICON_BUTTON_SIZE_CLASS}`
} as const;

export function Button({
  children,
  type = "button",
  variant = "secondary",
  size = "default",
  disabled,
  className,
  title,
  onClick,
  testId,
  name,
  value,
  dataAttributes,
  ariaLabel,
  ariaControls,
  ariaExpanded
}: ButtonProps): React.JSX.Element {
  return React.createElement(
    "button",
    {
      type,
      onClick,
      ...(disabled === undefined ? {} : { disabled }),
      ...(title === undefined ? {} : { title }),
      ...(name === undefined ? {} : { name }),
      ...(value === undefined ? {} : { value }),
      ...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel }),
      ...(ariaControls === undefined ? {} : { "aria-controls": ariaControls }),
      ...(ariaExpanded === undefined ? {} : { "aria-expanded": ariaExpanded }),
      className: `${
        size === "default"
          ? BUTTON_VARIANT_CLASS[variant]
          : size === "compact"
            ? BUTTON_VARIANT_COMPACT_CLASS[variant]
            : BUTTON_VARIANT_ICON_CLASS[variant]
      }${className === undefined ? "" : ` ${className}`}`,
      ...(testId === undefined ? {} : { "data-button": testId }),
      ...dataAttributes
    },
    children
  );
}
