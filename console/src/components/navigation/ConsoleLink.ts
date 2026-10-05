"use client";

import NextLink, { useLinkStatus } from "next/link.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";

const Link = moduleDefault(NextLink);

export type ConsoleLinkProps = React.ComponentProps<typeof Link> & {
  readonly [dataAttribute: `data-${string}`]: string | undefined;
};

/**
 * The single primitive for internal Console navigation.
 *
 * Renders a Next.js `Link` (a real `<a href>`), so the App Router swaps only
 * the page segment while the root-layout shell persists, instead of
 * reloading and re-hydrating the whole document. Every internal link also
 * carries a `LinkPendingIndicator`, so a click into a page whose server data
 * is slow (GitHub, OpenLIT, Memory storage) gives immediate feedback.
 *
 * External destinations (GitHub run pages, the OpenLIT portal) stay plain
 * `<a>` elements.
 */
export function ConsoleLink({
  children,
  ...props
}: ConsoleLinkProps): React.JSX.Element {
  return React.createElement(
    Link,
    props,
    children,
    React.createElement(LinkPendingIndicator)
  );
}

/**
 * Inline feedback for a client-side navigation that is still waiting on the
 * server. Client navigation keeps the current page visible until the
 * destination's server data arrives and suppresses the browser's own loading
 * indicator, so the clicked link signals the in-flight navigation itself.
 * The spinner fades in after a short delay so fast navigations never flash
 * it. Must be rendered inside a Next.js `Link`.
 */
export function LinkPendingIndicator(): React.JSX.Element | null {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return React.createElement(
    "span",
    {
      role: "status",
      "aria-label": "Loading",
      "data-link-pending": "true",
      className:
        "ml-2 inline-flex shrink-0 align-middle animate-link-pending-in"
    },
    React.createElement("span", {
      className:
        "block size-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
    })
  );
}
