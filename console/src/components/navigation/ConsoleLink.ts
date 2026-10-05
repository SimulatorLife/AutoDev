"use client";

import NextLink, { useLinkStatus } from "next/link.js";
import React from "react";

import { moduleDefault } from "../../lib/module-default.ts";
import { PendingSpinner } from "./PendingSpinner.ts";

const Link = moduleDefault(NextLink);

/** How long a hover must rest on a link before it counts as intent. */
const HOVER_INTENT_MS = 65;

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
 * already holds). Intent enables a full prefetch of the destination page, so
 * its server data usually arrives between pointing at a link and clicking
 * it, and the click renders from the router cache. A hover counts as intent
 * once it rests for `HOVER_INTENT_MS`, so sweeping the pointer across the
 * sidebar does not fire a full page render (and its GitHub, OpenLIT, or
 * Memory reads) per item passed; focus, touch, and mouse-down count
 * immediately, so even a quick click starts its fetch before the click
 * completes. `next.config.ts` bounds how long a prefetched page may be
 * reused. Pointing at the link for the page already shown never prefetches
 * it again.
 *
 * Every link also carries a `LinkPendingIndicator`, so a click whose data
 * has not arrived yet (slow GitHub, OpenLIT, or Memory storage reads) is
 * acknowledged immediately. External destinations (GitHub run pages, the
 * OpenLIT portal) stay plain `<a>` elements.
 */
export function ConsoleLink({
  children,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onTouchStart,
  onFocus,
  ...props
}: ConsoleLinkProps): React.JSX.Element {
  const [prefetch, setPrefetch] = React.useState(false);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = (): void => {
    if (hoverTimer.current === null) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  React.useEffect(() => cancelHover, []);
  const signalIntent = (anchor: HTMLAnchorElement): void => {
    cancelHover();
    if (!isCurrentLocation(anchor)) setPrefetch(true);
  };
  return React.createElement(
    Link,
    {
      ...props,
      prefetch,
      onMouseEnter(event: React.MouseEvent<HTMLAnchorElement>) {
        onMouseEnter?.(event);
        if (prefetch) return;
        const anchor = event.currentTarget;
        cancelHover();
        hoverTimer.current = setTimeout(
          () => signalIntent(anchor),
          HOVER_INTENT_MS
        );
      },
      onMouseLeave(event: React.MouseEvent<HTMLAnchorElement>) {
        onMouseLeave?.(event);
        cancelHover();
      },
      onMouseDown(event: React.MouseEvent<HTMLAnchorElement>) {
        onMouseDown?.(event);
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
 * Shows the shared pending spinner while this link's navigation is waiting
 * on the server. Must be rendered inside a Next.js `Link`.
 */
export function LinkPendingIndicator(): React.JSX.Element | null {
  const { pending } = useLinkStatus();
  return pending ? React.createElement(PendingSpinner) : null;
}
