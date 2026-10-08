import React from "react";

import { Icon } from "../icons/Icon.ts";
import { FIELD_CONTROL_CLASS } from "../ui/field-classes.ts";
import { MUTED_META_CLASS } from "../ui/text-classes.ts";

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
 *
 * The control chrome itself lives in `ui/field-classes.ts`, because it is shared
 * with the controls that have no component -- a text input, a date input.
 */

const CONTROL_CLASS = FIELD_CONTROL_CLASS;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
}

export interface SelectFieldProps {
  readonly name: string;
  /**
   * DOM id for the control, when one control repeats on a page.
   *
   * The id is what a `<label for>` points at, so two controls sharing an id
   * leave every label ambiguous: the screen reader announces whichever one the
   * DOM happens to resolve, and clicking either label focuses the first. `name`
   * cannot be used for this, because the name is the wire contract with the
   * route and several role controls legitimately submit `priority` from
   * different forms on the same page.
   */
  readonly id?: string | undefined;
  /** Accessible label rendered before the control. */
  readonly label: string;
  /**
   * Render `label` for assistive technology only.
   *
   * A dense grid row already names its control in visible text beside it -- the
   * role name next to that role's priority and model selects, for instance --
   * so repeating the label in front of every control doubles the words without
   * adding any. The label still reaches a screen reader, which is the point: it
   * is removed from the *visual* layout, not from the accessible name.
   * `aria-label` would be wrong here because it would replace the name rather
   * than reuse the same string the reader can see on the row, which is what
   * lets the two be checked against each other.
   */
  readonly hideLabel?: boolean | undefined;
  readonly options: readonly SelectOption[];
  /** One value, or several when the control is a `multiple` select. */
  readonly defaultValue?: string | readonly string[] | undefined;
  readonly disabled?: boolean | undefined;
  /**
   * Why the control is disabled, in one sentence.
   *
   * The target state is explicit: an unobserved or immutable control stays in
   * place, disabled, "with the reason available". Staying disabled without the
   * reason is the failure -- a filter the reader cannot use, beside three they
   * can, with nothing to say whether it is broken, not yet populated, or
   * permanently fixed. It is a separate prop rather than a convention because a
   * convention is exactly what let four `/usage` selects ship with no reason at
   * all: the visible label already said "Not observed", so each site looked
   * complete.
   *
   * Rendered twice on purpose, to the two audiences that need it: `title` for a
   * pointer, and a visually hidden description referenced by `aria-describedby`
   * for a screen reader. `aria-label` is deliberately not used -- it would
   * replace the visible "Workspace:" label instead of adding to it.
   */
  readonly disabledReason?: string | undefined;
  /**
   * Allow selecting several values while the control stays one row tall.
   * Callers that submit a plain GET form pair this with their own hidden
   * inputs, because a `multiple` select serializes as repeated names.
   */
  readonly multiple?: boolean | undefined;
  /** Called when a single selection changes in a client-rendered form. */
  readonly onChange?:
    ((event: React.ChangeEvent<HTMLSelectElement>) => void) | undefined;
  readonly className?: string | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  /** Extra attributes, for state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function SelectField({
  name,
  id,
  label,
  hideLabel,
  options,
  defaultValue,
  disabled,
  disabledReason,
  multiple,
  onChange,
  className,
  testId,
  dataAttributes
}: SelectFieldProps): React.JSX.Element {
  const controlId = id ?? `select-${name}`;
  // The wrapper carries the control's box. `max-w-full` on the inner span is
  // what lets a caller's width actually bind: a native select sizes to its
  // widest option, so without it the control overflows the wrapper however
  // narrow the wrapper is set, and a control repeated down a table takes a
  // different width per row depending on that row's longest option. That is
  // what makes row heights uneven on the Providers table.
  const reasonId = `${controlId}-reason`;
  // Only a disabled control needs to explain itself, so the description is
  // rendered for that case alone rather than left empty on every live control.
  const describedBy =
    disabled === true && disabledReason !== undefined && disabledReason !== ""
      ? reasonId
      : undefined;
  return React.createElement(
    "div",
    {
      className: `flex flex-wrap items-center gap-2 min-w-0${
        className === undefined ? "" : ` ${className}`
      }`
    },
    React.createElement(
      "label",
      {
        htmlFor: controlId,
        className: hideLabel === true ? "sr-only" : MUTED_META_CLASS
      },
      label
    ),
    React.createElement(
      "span",
      { className: "relative inline-flex min-w-0 max-w-full items-center" },
      React.createElement(
        "select",
        {
          id: controlId,
          name,
          ...(defaultValue === undefined ? {} : { defaultValue }),
          ...(disabled === undefined ? {} : { disabled }),
          ...(describedBy === undefined
            ? {}
            : { "aria-describedby": describedBy }),
          ...(disabled === true && disabledReason !== undefined
            ? { title: disabledReason }
            : {}),
          // A multi-select collapses to a single row so it reads like a
          // dropdown while still accepting several values.
          ...(multiple === true ? { multiple: true, size: 1 } : {}),
          ...(onChange === undefined ? {} : { onChange }),
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
    ),
    describedBy === undefined
      ? null
      : React.createElement(
          "span",
          { id: reasonId, className: "sr-only" },
          disabledReason
        )
  );
}
