"use client";

import NextForm from "next/form.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";

const Form = moduleDefault(NextForm);

export type ConsoleFormProps = React.ComponentProps<typeof Form> & {
  readonly [dataAttribute: `data-${string}`]: string | undefined;
};

/**
 * The single primitive for URL-addressable GET filter and scope forms.
 *
 * Renders a Next.js `Form`: submitting encodes the fields into the `action`
 * URL's query string and performs a soft App Router navigation, so filters
 * never reload the document. The rendered `<form>` keeps the native GET
 * method, so it still works without JavaScript. Mutations stay same-origin
 * POST forms to Console route handlers.
 */
export function ConsoleForm(props: ConsoleFormProps): React.JSX.Element {
  return React.createElement(Form, props);
}
