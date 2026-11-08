"use client";

import React from "react";

import { SelectField, type SelectFieldProps } from "./SelectField.ts";
import { SUBMIT_ON_CHANGE_ATTRIBUTE } from "./submit-on-change.ts";

/**
 * `onChange` is owned by this component, and `multiple` is excluded outright:
 * a multi-select commits one option at a time while the rest of the set
 * stays unconfirmed, so auto-submitting on every change would submit a
 * partial, unintended selection. Multi-selects keep the shared
 * {@link SelectField} and an explicit submit action instead.
 */
export type AutoSubmitSelectFieldProps = Omit<
  SelectFieldProps,
  "onChange" | "multiple" | "value"
>;

/**
 * A single-choice select that submits its containing native form on change.
 *
 * Use only when each choice is independently valid and immediately actionable.
 * Multi-selects and deliberately staged groups keep an explicit submit action.
 * The form still owns its method, fields, route, and server-confirmed result.
 *
 * The change is submitted by the page-level listener (`submit-on-change.ts`),
 * which works before hydration; this component decides only what the control
 * shows. It shows the value the server rendered (`defaultValue`), except
 * while the operator's own choice is on its way, and it shows the server's
 * value again as soon as the page is re-read. A select that kept showing the
 * operator's choice after the write was refused -- an uncontrolled control
 * ignores a changed `defaultValue` -- read as a setting the Runtime did not
 * hold.
 *
 * A re-read is a new server render, and a server render hands this client
 * component new props objects even when the values in them are unchanged,
 * which is how a refused write is told apart from no write at all.
 */
export function AutoSubmitSelectField(
  props: AutoSubmitSelectFieldProps
): React.JSX.Element {
  const { dataAttributes, defaultValue, options, ...fieldProps } = props;
  const confirmed = typeof defaultValue === "string" ? defaultValue : undefined;
  const [pending, setPending] = React.useState<string | null>(null);
  React.useEffect(() => {
    setPending(null);
  }, [options, confirmed]);
  return React.createElement(SelectField, {
    ...fieldProps,
    options,
    ...(confirmed === undefined ? {} : { value: pending ?? confirmed }),
    onChange: (event) => setPending(event.currentTarget.value),
    dataAttributes: {
      ...dataAttributes,
      [SUBMIT_ON_CHANGE_ATTRIBUTE]: "true"
    }
  });
}
