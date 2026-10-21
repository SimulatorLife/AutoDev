import Link from "next/link.js";
import React from "react";

type NavigationLinkProps = Omit<
  React.ComponentProps<typeof Link>,
  "prefetch"
> & {
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
};

/**
 * A link that routes in place.
 *
 * The link does not prefetch. It used to: a pointer, touch or keyboard intent
 * on the link warmed the destination with `router.prefetch`, so that the
 * dashboard did not start a request for every visible resource when it
 * opened. That warm-up cost the navigation it was meant to help. Every Console
 * route renders behind a loading boundary, so a prefetch answers with that
 * boundary's placeholder rather than with the page, and the router can join
 * that partial answer when the navigation starts -- the navigation then waits
 * for a payload that was never going to arrive, and the page does not move and
 * the URL does not change. The browser acceptance measured exactly that: the
 * server answered the navigation request in sixteen milliseconds with a
 * complete response, and the Console stayed where it was.
 *
 * There is nothing to lose by dropping it. Every Console route is
 * server-rendered for the visit (`force-dynamic`), so a cached answer would
 * have been thrown away when the route was rendered again, and the request
 * the prefetch saved is one the page has to make anyway.
 *
 * The module holds no hook and no event handler, so it is not a client
 * boundary: it renders `next/link`, which is a client component on its own.
 */
export function NavigationLink({
  href,
  dataAttributes,
  ...props
}: NavigationLinkProps): React.JSX.Element {
  return React.createElement(Link, {
    ...props,
    href,
    ...dataAttributes,
    prefetch: false
  });
}
