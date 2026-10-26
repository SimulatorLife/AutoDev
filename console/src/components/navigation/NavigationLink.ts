"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import React from "react";

import { ROUTER_STALE_SECONDS } from "../../lib/router-staleness.ts";
import {
  isLocalWholePageDestination,
  navigateToWholePage,
  warmUpWholePage
} from "./whole-page-navigation.ts";

type NavigationLinkProps = Omit<
  React.ComponentProps<typeof Link>,
  "onFocus" | "onMouseEnter" | "onTouchStart" | "prefetch"
> & {
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
};

/**
 * Whether the click is the Console's to navigate.
 *
 * A modified click belongs to the browser: a command click opens the
 * destination in a new tab, a middle click opens it in a background tab, and a
 * link that carries a download attribute downloads. The Console leaves those
 * alone and only takes over the plain click.
 */
function isPlainNavigationClick(
  event: React.MouseEvent<HTMLAnchorElement>
): boolean {
  const target = event.currentTarget.getAttribute("target");
  if (target !== null && target !== "_self") return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  return event.button === 0;
}

/** Intent events that authorize one dynamic-route prefetch. */
export interface NavigationIntentHandlers {
  readonly onMouseEnter: () => void;
  readonly onTouchStart: () => void;
  readonly onFocus: () => void;
}

export function navigationIntentHandlers(
  onIntent: () => void
): NavigationIntentHandlers {
  return { onMouseEnter: onIntent, onTouchStart: onIntent, onFocus: onIntent };
}

function toHrefString(href: React.ComponentProps<typeof Link>["href"]): string {
  if (typeof href === "string") return href;
  if (!href) return "";
  const pathname = href.pathname ?? "";
  const query =
    typeof href.query === "string"
      ? href.query
      : href.query && typeof href.query === "object"
        ? new URLSearchParams(href.query as Record<string, string>).toString()
        : "";
  return query ? `${pathname}?${query}` : pathname;
}

const RECENT_PREFETCHES = new Map<string, number>();
/**
 * The Console does not ask for the same destination twice inside the router's
 * own reuse window: the second ask would be thrown away, because the router
 * may only reuse a page it fetched for that window. The window is the
 * Console's live-count cadence, so a destination the operator comes back to
 * after a moment is warm again -- and one they come back to after a minute
 * is fetched afresh, which is what a page of live state wants.
 */
const PREFETCH_COOLDOWN_MS = ROUTER_STALE_SECONDS * 1000;

export function shouldPrefetch(
  destination: string,
  now: number = Date.now()
): boolean {
  if (!destination) return false;
  const last = RECENT_PREFETCHES.get(destination);
  if (last !== undefined && now - last < PREFETCH_COOLDOWN_MS) {
    return false;
  }
  RECENT_PREFETCHES.set(destination, now);
  if (RECENT_PREFETCHES.size > 200) {
    for (const [key, timestamp] of RECENT_PREFETCHES) {
      if (now - timestamp >= PREFETCH_COOLDOWN_MS) {
        RECENT_PREFETCHES.delete(key);
      }
    }
  }
  return true;
}

export function clearPrefetchCacheForTests(): void {
  RECENT_PREFETCHES.clear();
}

/**
 * A link that routes in place.
 *
 * The link warms its destination on a pointer, touch or keyboard intent, so
 * that the dashboard does not start a request for every visible resource when
 * it opens. The warm-up is a **full** prefetch, and the kind is the whole
 * point.
 *
 * A partial prefetch answers with the route's loading state rather than with
 * the page. The navigation then finds that answer waiting for it, applies the
 * loading state, and waits for a page that is never going to arrive: the URL
 * does not change, the page does not move, and the browser acceptance
 * measured exactly that -- the server answered the navigation request in
 * sixteen milliseconds with a complete response, and the Console stayed where
 * it was.
 *
 * A full prefetch answers with the page itself. The navigation finds the
 * answer it asked for, applies it, and commits.
 *
 * There is nothing to lose by the warm-up being full. Every Console route is
 * server-rendered for the visit (`force-dynamic`), so a partial answer would
 * have been thrown away when the route was rendered again, and the request
 * the prefetch saves is one the page has to make anyway.
 *
 * The click asks for the destination's whole page as well, and navigates
 * through the owner. The owner leaves in place in the same turn as the ask,
 * and leaves again when the answer arrives, so the navigation commits whether
 * the router already held the destination's page or had to fetch it. See
 * `whole-page-navigation.ts` for why the ask and the navigation belong
 * together.
 */
export function NavigationLink({
  href,
  dataAttributes,
  ...props
}: NavigationLinkProps): React.JSX.Element {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    router = useRouter();
  } catch {
    // In environments without AppRouterContext (such as SSR or unit tests)
  }

  /**
   * The Console asks for the destination's whole page on intent. See
   * `whole-page-navigation.ts` for why the whole page is the answer worth
   * having.
   */
  const prefetch = React.useCallback((): void => {
    if (!router) return;
    const destination = toHrefString(href);
    if (destination && shouldPrefetch(destination)) {
      warmUpWholePage(router, destination);
    }
  }, [href, router]);

  const { onClick } = props;
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (!router) return;
      const destination = toHrefString(href);
      if (!destination) return;
      if (!isLocalWholePageDestination(destination)) return;
      if (!isPlainNavigationClick(event)) return;
      // The Console owns this navigation: the owner asks for the destination's
      // whole page and leaves in place, and it leaves again when the answer
      // arrives. See `whole-page-navigation.ts` for why the two belong
      // together.
      event.preventDefault();
      navigateToWholePage(router, destination, "push", { scroll: true });
    },
    [href, onClick, router]
  );

  return React.createElement(Link, {
    ...props,
    href,
    ...dataAttributes,
    prefetch: false,
    onClick: handleClick,
    ...navigationIntentHandlers(prefetch)
  });
}
