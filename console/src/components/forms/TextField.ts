import React from "react";

import { FIELD_CONTROL_CLASS } from "../ui/field-classes.ts";

/**
 * The Console's free-text form control.
 *
 * `SelectField` and `FilterSearchField` both own the control chrome, and the
 * first thing a Memory governance form needed that neither could express -- a
 * box for the operator to write a revised claim or an audit reason -- was going
 * to be a third hand-typed `<input>`. It shares `FIELD_CONTROL_CLASS` instead,
 * so a typed field beside a select matches it in padding, border, text size, and
 * focus treatment rather than reading as a different product.
 *
 * Two properties are not optional, and both come from controls that got them
 * wrong elsewhere in this codebase:
 *
 * - a **label**, always. A placeholder is not a name: it disappears the moment
 *   the field has a value, leaving the control with no accessible name at all.
 * - an **id** that is unique per page. The id is what `<label for>` resolves, so
 *   two controls sharing one leave every label ambiguous -- the screen reader
 *   announces whichever the DOM finds first, and clicking either label focuses
 *   that one. `name` cannot substitute for it, because `name` is the wire
 *   contract with the route and two controls on one page can legitimately submit
 *   the same field from different forms.
 */
export interface TextFieldProps {
  readonly name: string;
  /** DOM id for the control, required when one control repeats on a page. */
  readonly id?: string | undefined;
  /** Accessible label rendered before the control. */
  readonly label: string;
  /** Render the label for assistive technology only. */
  readonly hideLabel?: boolean | undefined;
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string | undefined;
  /**
   * Rows, for a control that takes a sentence rather than a token.
   *
   * A claim is a sentence, and a single-line box for one either scrolls its own
   * text sideways or hides the part the operator is checking before submitting a
   * governed revision.
   */
  readonly rows?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  /** Extra attributes, for state flags the Console asserts on. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function TextField({
  name,
  id,
  label,
  hideLabel,
  defaultValue,
  placeholder,
  rows,
  disabled,
  className,
  testId,
  dataAttributes
}: TextFieldProps): React.JSX.Element {
  const controlId = id ?? `text-${name}`;
  // A textarea keeps its own vertical padding, and `FIELD_CONTROL_CLASS` carries
  // the select's `py-1.5`, which is sized for a single line beside a label.
  const controlClass =
    rows === undefined
      ? FIELD_CONTROL_CLASS
      : `${FIELD_CONTROL_CLASS} py-2 leading-relaxed`;
  const control = React.createElement(
    rows === undefined ? "input" : "textarea",
    {
      id: controlId,
      name,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(rows === undefined ? {} : { rows }),
      ...(disabled === undefined ? {} : { disabled }),
      className: `${controlClass} w-full`,
      ...(testId === undefined ? {} : { "data-text-field": testId }),
      ...dataAttributes
    }
  );
  return React.createElement(
    "div",
    {
      className: `flex flex-col gap-1 min-w-0${
        className === undefined ? "" : ` ${className}`
      }`
    },
    React.createElement(
      "label",
      {
        htmlFor: controlId,
        className: hideLabel === true ? "sr-only" : "text-xs text-fg-muted"
      },
      label
    ),
    control
  );
}
