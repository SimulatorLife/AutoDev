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
 * Keep dynamic prefetch user-intent-driven instead of starting every visible
 * resource request together when the dashboard opens. Keeping prefetch: false on
 * the underlying Next Link ensures ref callbacks do not churn during rapid user
 * interactions.
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
      router.prefetch(destination);
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
