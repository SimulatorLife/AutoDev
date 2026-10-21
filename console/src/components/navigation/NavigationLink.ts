"use client";

import Link from "next/link.js";
import { useRouter } from "next/navigation.js";
import React from "react";

type NavigationLinkProps = Omit<
  React.ComponentProps<typeof Link>,
  "onFocus" | "onMouseEnter" | "onTouchStart" | "prefetch"
> & {
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
};

type PrefetchOptions = NonNullable<
  Parameters<ReturnType<typeof useRouter>["prefetch"]>[1]
>;

/**
 * The full prefetch kind.
 *
 * `next/navigation` does not export Next's `PrefetchKind` enum, so the kind is
 * named here and asserted once. It is the only kind the Console uses: a
 * partial prefetch answers with the route's loading state rather than with the
 * page, and a navigation that finds that answer waiting for it never commits.
 */
const FULL_PREFETCH_KIND = "full" as PrefetchOptions["kind"];

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
const PREFETCH_COOLDOWN_MS = 15_000;

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

  const prefetch = React.useCallback((): void => {
    if (!router) return;
    const destination = toHrefString(href);
    if (destination && shouldPrefetch(destination)) {
      router.prefetch(destination, { kind: FULL_PREFETCH_KIND });
    }
  }, [href, router]);

  return React.createElement(Link, {
    ...props,
    href,
    ...dataAttributes,
    prefetch: false,
    ...navigationIntentHandlers(prefetch)
  });
}
