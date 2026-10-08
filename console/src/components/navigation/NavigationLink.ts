"use client";

import Link from "next/link.js";
import React from "react";

type NavigationLinkProps = Omit<
  React.ComponentProps<typeof Link>,
  "onFocus" | "onMouseEnter" | "onTouchStart" | "prefetch"
>;

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

/**
 * Keep dynamic prefetch user-intent-driven instead of starting every visible
 * resource request together when the dashboard opens.
 */
export function NavigationLink({
  href,
  ...props
}: NavigationLinkProps): React.JSX.Element {
  const [prefetchOnIntent, setPrefetchOnIntent] = React.useState(false);
  const prefetch = (): void => setPrefetchOnIntent(true);

  return React.createElement(Link, {
    ...props,
    href,
    prefetch: prefetchOnIntent,
    ...navigationIntentHandlers(prefetch)
  });
}
