import React from "react";

import { Icon } from "../icons/Icon.ts";

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
 *
 * `max-w-full min-w-0` makes every control shrinkable. A native select's
 * intrinsic width comes from its widest option, so a select labelled with a
 * long workspace id or model name used to push its row past the viewport and
 * take the Apply button with it. The constraints apply only when the control
 * would otherwise be wider than the space it is given.
 */
export const FIELD_CONTROL_CLASS =
  "appearance-none rounded border border-border-strong bg-input pl-3 pr-8 py-1.5 text-sm text-fg-secondary transition-colors hover:border-fg-muted disabled:cursor-not-allowed disabled:opacity-60 max-w-full min-w-0";

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
      className: `flex flex-wrap items-center gap-2 min-w-0${
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
      { className: "relative inline-flex min-w-0 items-center" },
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
        // 12px rather than the set's 16px default: the chevron is part of the
        // control's chrome, sized to the 34px control rather than to a
        // product icon. Stroke weight stays at the set's 2 -- it used to be
        // hand-set to 2.5 here, which made this the one visibly heavier mark
        // in the product.
        React.createElement(Icon, { name: "chevronDown", size: 12 })
      )
    )
  );
}
