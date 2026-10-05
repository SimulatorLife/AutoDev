"use client";

import NextForm from "next/form.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";
import { PendingSpinner } from "./PendingSpinner.ts";

const Form = moduleDefault(NextForm);

export type ConsoleFormProps = Omit<
  React.ComponentProps<typeof Form>,
  "prefetch"
> & {
  /**
   * Identity of the server-rendered data the fields' defaults come from,
   * such as the URL selection the page was rendered for. The fields are
   * uncontrolled, so the form remounts whenever this changes (Back/forward,
   * a link, a submit) and picks up the defaults the page now shows instead of
   * keeping stale input.
   *
   * It must come from the same render as the defaults, never from the
   * router's URL state: the router updates the URL before the deferred page
   * content arrives, so a URL-derived key would remount the form with the
   * previous page's defaults and the new defaults would not apply.
   */
  readonly defaultsKey: string;
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
 * The form is keyed by `defaultsKey`, so a navigation that renders different
 * field defaults remounts the uncontrolled fields with them.
 *
 * While the filtered page is loading, the form is marked busy and shows the
 * shared pending spinner. `Form` calls `onSubmit` and then starts the router
 * navigation in the same submit event; React assigns every transition
 * started in one event the same lane, so the transition started here stays
 * pending until the navigation commits.
 */
export function ConsoleForm({
  children,
  defaultsKey,
  onSubmit,
  ...props
}: ConsoleFormProps): React.JSX.Element {
  const [pending, startTransition] = React.useTransition();
  return React.createElement(
    Form,
    {
      ...props,
      key: defaultsKey,
      // Console routes are dynamic, so a viewport prefetch of the action URL
      // could only return layout data the client already holds.
      prefetch: false,
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
