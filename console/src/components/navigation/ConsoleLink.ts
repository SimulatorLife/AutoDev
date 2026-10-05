"use client";

import NextLink, { useLinkStatus } from "next/link.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";

const Link = moduleDefault(NextLink);

type NextLinkProps = React.ComponentProps<typeof Link>;

export type ConsoleLinkProps = Omit<NextLinkProps, "href" | "prefetch"> & {
  /** Internal Console URL: an absolute path or a same-page `?query`. */
  readonly href: string;
  readonly [dataAttribute: `data-${string}`]: string | undefined;
};

/**
 * The single primitive for internal Console navigation.
 *
 * Renders a Next.js `Link` (a real `<a href>`), so the App Router swaps only
 * the page segment while the root-layout shell persists, instead of
 * reloading and re-hydrating the whole document.
 *
 * Prefetching is intent-driven: nothing is fetched while a link merely sits
 * in the viewport (tables render hundreds of links, and Console routes are
 * dynamic, so viewport prefetches could only return layout data the client
 * already holds). The first hover, focus, or touch enables a full prefetch
 * of the destination page, so its server data usually arrives during the
 * time between pointing at a link and clicking it, and the click renders
 * from the router cache. `next.config.ts` bounds how long a prefetched page
 * may be reused. Hovering the link for the page already shown never
 * prefetches it again.
 *
 * Every link also carries a `LinkPendingIndicator`, so a click whose data
 * has not arrived yet (slow GitHub, OpenLIT, or Memory storage reads) is
 * acknowledged immediately. External destinations (GitHub run pages, the
 * OpenLIT portal) stay plain `<a>` elements.
 */
export function ConsoleLink({
  children,
  onMouseEnter,
  onTouchStart,
  onFocus,
  ...props
}: ConsoleLinkProps): React.JSX.Element {
  const [prefetch, setPrefetch] = React.useState(false);
  const signalIntent = (anchor: HTMLAnchorElement): void => {
    if (!isCurrentLocation(anchor)) setPrefetch(true);
  };
  return React.createElement(
    Link,
    {
      ...props,
      prefetch,
      onMouseEnter(event: React.MouseEvent<HTMLAnchorElement>) {
        onMouseEnter?.(event);
        signalIntent(event.currentTarget);
      },
      onTouchStart(event: React.TouchEvent<HTMLAnchorElement>) {
        onTouchStart?.(event);
        signalIntent(event.currentTarget);
      },
      onFocus(event: React.FocusEvent<HTMLAnchorElement>) {
        onFocus?.(event);
        signalIntent(event.currentTarget);
      }
    },
    children,
    React.createElement(LinkPendingIndicator)
  );
}

function isCurrentLocation(anchor: HTMLAnchorElement): boolean {
  const { location } = globalThis;
  return (
    anchor.origin === location.origin &&
    anchor.pathname === location.pathname &&
    anchor.search === location.search
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
