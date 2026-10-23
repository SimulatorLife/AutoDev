import React from "react";

import {
  CHECKBOX_CONTROL_CLASS,
  CHECKBOX_DESTRUCTIVE_CLASS
} from "../ui/field-classes.ts";

/**
 * The Console's one checkbox.
 *
 * The product had five checkboxes and they disagreed about everything: three
 * sizes, two chromes, two accents, and not one of them showing the pointer.
 * The Skills page's role checkboxes were 14px native boxes, the Providers
 * reset confirmation was a 16px hand-written box, and the Memory purge
 * confirmation was painted `accent-error` -- a destructive colour on a control
 * that was confirming rather than destroying. Two adjacent checkboxes on
 * different pages looked like two different products, and the operator could
 * not tell from the pointer that either of them was a target at all.
 *
 * This component is the shared answer: one size, one chrome, one accent, one
 * cursor. The destructive accent is available for the box that confirms an
 * irreversible action, and it is opt-in, because a colour that appears on
 * every checkbox is not a signal about anything.
 *
 * The whole label is the target, and it carries a 24px minimum so the clickable
 * region meets the same floor the link chips meet in `target-size.test.ts`. The
 * checkbox itself stays at 16px, which is the Console's own established size:
 * the operator aims at the row of text beside it, not at the box.
 *
 * The accessible name is the visible label. A checkbox whose name is only in an
 * `aria-label` is a control the operator can see but not read, and the Console's
 * rule is recognition over recall in both directions.
 */
export interface CheckboxFieldProps {
  readonly name: string;
  /** The visible label, which is also the control's accessible name. */
  readonly label: string;
  /**
   * DOM id for the control.
   *
   * It is optional and the caller supplies it only when a control needs to be
   * addressed from outside -- a form's confirmation box, say. A derived id
   * would collide: the Skills page renders one checkbox per assignable role
   * under the same field name, so `checkbox-roles` would be on the page
   * several times over, and a duplicated id makes the label's `for` point at
   * the first control rather than the one it names.
   */
  readonly id?: string | undefined;
  /** The value the control submits. */
  readonly value?: string | undefined;
  readonly defaultChecked?: boolean | undefined;
  readonly checked?: boolean | undefined;
  readonly onChange?:
    ((event: React.ChangeEvent<HTMLInputElement>) => void) | undefined;
  readonly disabled?: boolean | undefined;
  /** The control must be checked before the form submits. */
  readonly required?: boolean | undefined;
  /**
   * The box confirms an irreversible action, so it wears the destructive
   * accent.
   */
  readonly tone?: "destructive" | undefined;
  /**
   * How the box sits against a label that may wrap.
   *
   * A one-line label reads best with the box centred on it. A label that can
   * wrap over two lines reads best with the box on the first line, aligned to
   * its text, rather than floating between the two.
   */
  readonly align?: "center" | "start" | undefined;
  /**
   * Extra classes for the label row.
   *
   * The label owns the size, the gap and the spacing of the target, so a
   * caller that needs a different weight or density sets it here rather than
   * restating the chrome of the control itself. The gap is not among the
   * things a caller restates: two gap utilities in one class list resolve by
   * stylesheet order rather than by intent, so the row's spacing belongs to
   * this component and only to it.
   */
  readonly labelClassName?: string | undefined;
  /**
   * Attributes for the label rather than the control.
   *
   * A marker that a test or a browser script selects *around* the checkbox --
   * "the role option for worker", "the provider reset confirmation" -- has to
   * stay on the wrapper. Moving it onto the input would change what the
   * selector matches without changing what the operator sees.
   */
  readonly labelAttributes?: Readonly<Record<string, string>> | undefined;
  /** Marks the control for tests and stable browser assertions. */
  readonly testId?: string | undefined;
  /** Extra data-* state flags on the control. */
  readonly dataAttributes?: Readonly<Record<string, string>> | undefined;
}

export function CheckboxField({
  name,
  label,
  id,
  value,
  defaultChecked,
  checked,
  onChange,
  disabled,
  required,
  tone,
  align = "center",
  labelClassName,
  labelAttributes,
  testId,
  dataAttributes
}: CheckboxFieldProps): React.JSX.Element {
  const started = align === "start";
  return React.createElement(
    "label",
    {
      // The input is nested, so the label already names it. `for` is only
      // added when the control has an id of its own, because a `for` that
      // points at a duplicated id names the wrong control.
      ...(id === undefined ? {} : { htmlFor: id }),
      className: `flex min-h-6 gap-2 text-fg-secondary ${
        started ? "items-start" : "items-center"
      } ${labelClassName ?? ""}`.trim(),
      ...labelAttributes
    },
    React.createElement("input", {
      ...(id === undefined ? {} : { id }),
      type: "checkbox",
      name,
      ...(value === undefined ? {} : { value }),
      ...(defaultChecked === undefined ? {} : { defaultChecked }),
      ...(checked === undefined ? {} : { checked }),
      ...(onChange === undefined ? {} : { onChange }),
      ...(disabled === undefined ? {} : { disabled }),
      ...(required === undefined ? {} : { required }),
      className: `${CHECKBOX_CONTROL_CLASS}${started ? " mt-0.5" : ""}${
        tone === "destructive" ? ` ${CHECKBOX_DESTRUCTIVE_CLASS}` : ""
      }`,
      ...(testId === undefined ? {} : { "data-checkbox": testId }),
      ...dataAttributes
    }),
    React.createElement("span", { className: "min-w-0" }, label)
  );
}
