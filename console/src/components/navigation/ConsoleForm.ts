"use client";

import NextForm from "next/form.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";
import { PendingSpinner } from "./PendingSpinner.ts";

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
 *
 * While the filtered page is loading, the form is marked busy and shows the
 * shared pending spinner. `Form` calls `onSubmit` and then starts the router
 * navigation in the same submit event; React assigns every transition
 * started in one event the same lane, so the transition started here stays
 * pending until the navigation commits.
 */
export function ConsoleForm({
  children,
  onSubmit,
  ...props
}: ConsoleFormProps): React.JSX.Element {
  const [pending, startTransition] = React.useTransition();
  return React.createElement(
    Form,
    {
      ...props,
      "aria-busy": pending ? "true" : undefined,
      onSubmit(event: React.SubmitEvent<HTMLFormElement>) {
        onSubmit?.(event);
        if (!event.defaultPrevented) startTransition(() => {});
      }
    },
    children,
    pending ? React.createElement(PendingSpinner) : null
  );
}
