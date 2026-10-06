import React from "react";

/**
 * The Console's single select control.
 *
 * Selects stay native elements so keyboard behaviour, form submission, and
 * platform picker behaviour remain correct, but every one of them is styled
 * here. Native `appearance` is dropped so the closed control cannot fall back
 * to the platform's light widget, which is how a light select ended up inside
 * a dark-only product; the chevron is drawn from the shared icon set instead.
 *
 * The dropdown list itself is themed by the document-level
 * `color-scheme: dark` in `app/globals.css`, so the opened list matches the
 * closed control.
 */

/**
 * Shared control chrome for form inputs and selects.
 *
 * Exported so a date or text input in the same filter bar matches a select
 * beside it; a filter row with two different control weights reads as two
 * different products.
 */
export const FIELD_CONTROL_CLASS =
  "appearance-none rounded border border-border-strong bg-input pl-3 pr-8 py-1.5 text-sm text-fg-secondary transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60";

const CONTROL_CLASS = FIELD_CONTROL_CLASS;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

export interface SelectFieldProps {
  readonly name: string;
  /** Accessible label rendered before the control. */
  readonly label: string;
  readonly options: readonly SelectOption[];
  /** One value, or several when the control is a `multiple` select. */
  readonly defaultValue?: string | readonly string[] | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * Allow selecting several values while the control stays one row tall.
   * Callers that submit a plain GET form pair this with their own hidden
   * inputs, because a `multiple` select serializes as repeated names.
   */
  readonly multiple?: boolean | undefined;
  readonly className?: string | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  /** Extra attributes, for state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  disabled,
  multiple,
  className,
  testId,
  dataAttributes
}: SelectFieldProps): React.JSX.Element {
  const id = `select-${name}`;
  return React.createElement(
    "div",
    {
      className: `flex items-center gap-2${
        className === undefined ? "" : ` ${className}`
      }`
    },
    React.createElement(
      "label",
      { htmlFor: id, className: "text-xs text-fg-muted" },
      label
    ),
    React.createElement(
      "span",
      { className: "relative inline-flex items-center" },
      React.createElement(
        "select",
        {
          id,
          name,
          ...(defaultValue === undefined ? {} : { defaultValue }),
          ...(disabled === undefined ? {} : { disabled }),
          // A multi-select collapses to a single row so it reads like a
          // dropdown while still accepting several values.
          ...(multiple === true ? { multiple: true, size: 1 } : {}),
          className: CONTROL_CLASS,
          ...(testId === undefined ? {} : { "data-select": testId }),
          ...dataAttributes
        },
        ...options.map((option) =>
          React.createElement(
            "option",
            {
              key: option.value,
              value: option.value,
              ...(option.disabled === undefined
                ? {}
                : { disabled: option.disabled })
            },
            option.label
          )
        )
      ),
      // Pointer-events-none so the decorative chevron never intercepts the
      // click that opens the native list.
      React.createElement(
        "span",
        {
          className:
            "pointer-events-none absolute right-2 flex items-center text-fg-muted",
          "aria-hidden": true
        },
        React.createElement(ChevronIcon)
      )
    )
  );
}

/** Inline 12px chevron; part of the control's chrome, not a product icon. */
function ChevronIcon(): React.JSX.Element {
  return React.createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      width: 12,
      height: 12,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2.5,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    },
    React.createElement("path", { d: "M6 9l6 6 6-6" })
  );
}
