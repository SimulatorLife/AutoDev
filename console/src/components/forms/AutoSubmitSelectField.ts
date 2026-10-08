"use client";

import React from "react";

import { SelectField, type SelectFieldProps } from "./SelectField.ts";

/**
 * `onChange` is owned by this component (it wires the auto-submit), and
 * `multiple` is excluded outright: a multi-select commits one option at a
 * time while the rest of the set stays unconfirmed, so auto-submitting on
 * every change would submit a partial, unintended selection. Multi-selects
 * keep the shared {@link SelectField} and an explicit submit action instead.
 */
export type AutoSubmitSelectFieldProps = Omit<
  SelectFieldProps,
  "onChange" | "multiple"
>;

/**
 * A single-choice select that submits its containing native form on change.
 *
 * Use only when each choice is independently valid and immediately actionable.
 * Multi-selects and deliberately staged groups keep an explicit submit action.
 * The form still owns its method, fields, route, and server-confirmed result.
 */
export function AutoSubmitSelectField(
  props: AutoSubmitSelectFieldProps
): React.JSX.Element {
  const { dataAttributes, ...fieldProps } = props;
  return React.createElement(SelectField, {
    ...fieldProps,
    onChange: (event) => event.currentTarget.form?.requestSubmit(),
    dataAttributes: {
      ...dataAttributes,
      "data-submit-on-change": "true"
    }
  });
}
