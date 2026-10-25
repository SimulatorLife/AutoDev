/**
 * The Console's whole-page navigation owner.
 *
 * A Next.js client navigation commits -- the address bar moves and the page
 * moves with it -- when the destination's whole page is in the router's
 * prefetch cache *and the router has it in hand* at the moment the navigation
 * is dispatched. The browser acceptance measured both halves of that on this
 * Console: a navigation whose destination was already in the router's cache
 * committed every time, and a navigation that had to answer for itself did
 * not commit at all.
 *
 * So the Console asks for the destination's whole page first -- a full
 * prefetch, because a partial prefetch answers with the route's loading state
 * rather than with the page -- and navigates second.
 *
 * The owner leaves for the destination in the same turn as the ask, and it
 * leaves again for every answer the destination produces.
 *
 * The first leave is what commits a destination the router already holds:
 * there is no request to wait for, the router answers it from its cache, and
 * the navigation commits at once. The owner does not wait for that answer
 * before it leaves, because a wait on a request that is never going to be
 * made is a wait that never ends -- and the browser acceptance measured
 * exactly that: of thirteen navigations between the Console's own pages, five
 * never committed, and every one of them a destination the router already
 * held. The operator's click did nothing at all: the URL stayed where it was
 * and the page did not move.
 *
 * The leaves after that are for the destinations the router has to fetch. A
 * navigation that answers for itself does not always commit -- the reducer
 * applies the destination, React renders it, and the commit that moves the
 * address bar does not run. Leaving again, with the page in the router's cache
 * by then, is what commits it. The owner stops as soon as the address bar has
 * moved, so the ordinary navigation leaves once and the hard one leaves a few
 * times.
 *
 * Nothing here waits on the page's clock. The browser acceptance holds that
 * clock still on purpose -- a feedback that dismisses itself after five
 * seconds has to be told apart from one the operator closed, and the way to
 * tell them apart is to stop the clock -- so a wait on a timer would stop
 * with it.
 */

export type WholePageNavigationMode = "push" | "replace";

export interface WholePageRouter {
  /**
   * Ask for the destination's page.
   *
   * Asking with no kind is asking for the whole page: Next.js's prefetch
   * answers with the full page unless it is told otherwise. A partial prefetch
   * answers with the route's loading state rather than with the page, and a
   * navigation that finds that answer waiting for it never commits.
   */
  readonly prefetch: (href: string) => void;
  readonly push: (
    href: string,
    options?: { readonly scroll?: boolean }
  ) => void;
  readonly replace: (
    href: string,
    options?: { readonly scroll?: boolean }
  ) => void;
}

/**
 * Whether the destination is one the Console routes in place.
 *
 * A destination that leaves the Console belongs to the browser: the browser
 * opens it in the way the operator asked for.
 */
export function isLocalWholePageDestination(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * The identity of a destination: where it is, without the marker that says how
 * the answer for it was carried.
 */
function destinationKey(href: string): string {
  const url = new URL(href, "http://console.invalid");
  const params = new URLSearchParams(url.search);
  params.delete("_rsc");
  const query = params.toString();
  return query.length > 0 ? `${url.pathname}?${query}` : url.pathname;
}

function destinationKeyOf(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (!url.searchParams.has("_rsc")) return null;
    return destinationKey(`${url.pathname}${url.search}`);
  } catch {
    return null;
  }
}

/**
 * Whether the browser is already at the destination.
 *
 * The address bar is the only place a committed navigation shows itself, and
 * it is the one thing the owner can read without a clock.
 */
function isAtDestination(href: string): boolean {
  const view = globalThis.window;
  if (view === undefined) return false;
  const current = view.location;
  const url = new URL(href, current.href);
  return current.pathname === url.pathname && current.search === url.search;
}

/**
 * How many times the owner leaves for a destination before it stops.
 *
 * The bound is a bound, not a plan: a navigation that has committed does not
 * answer again, and the owner stops as soon as the address bar has moved.
 */
const MAX_ATTEMPTS = 3;

/** The navigation the owner is on; a newer one replaces it. */
let pendingNavigation = 0;

/** The waiter of the navigation the owner is on, and its destination. */
let activeWaiter: { readonly key: string; readonly run: () => void } | null =
  null;

/** The destination the owner is navigating to, while it is navigating. */
let activeDestination: string | null = null;

/** The observer that reports the requests that carry the answers. */
let answerObserver: PerformanceObserver | null = null;

/**
 * Watch the requests that carry the answers.
 *
 * The browser's own record of a request is the signal: the answer is in hand
 * when the request that carries it has finished. Watching it costs the page
 * nothing -- the browser is keeping that record either way -- and it is an
 * event rather than a question, so it does not need a clock to ask it with.
 */
function installAnswerObserver(): void {
  if (answerObserver !== null) return;
  if (typeof PerformanceObserver === "undefined") return;
  answerObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const key = destinationKeyOf(entry.name);
      if (key === null) continue;
      if (activeWaiter === null) continue;
      if (activeWaiter.key !== key) continue;
      activeWaiter.run();
    }
  });
  answerObserver.observe({ type: "resource", buffered: true });
}

/**
 * Ask for the destination's whole page.
 *
 * The ask is the whole point: a navigation that leaves with the destination's
 * page already on its way finds the page in the router's cache instead of
 * asking for it while the navigation is on its way.
 */
export function warmUpWholePage(router: WholePageRouter, href: string): void {
  if (!router || !isLocalWholePageDestination(href)) return;
  installAnswerObserver();
  router.prefetch(href);
}

/** Leave for the destination, in place. */
function dispatch(
  router: WholePageRouter,
  href: string,
  mode: WholePageNavigationMode,
  options: { readonly scroll?: boolean }
): void {
  if (mode === "replace") {
    router.replace(href, { scroll: options.scroll ?? false });
    return;
  }
  router.push(href, { scroll: options.scroll ?? false });
}

/**
 * Navigate to the destination, with its whole page on the way.
 *
 * The owner leaves in the same turn as the ask, so a destination the router
 * already holds commits at once, and it leaves again for every answer the
 * destination produces, so a destination the router had to fetch commits too.
 */
export function navigateToWholePage(
  router: WholePageRouter,
  href: string,
  mode: WholePageNavigationMode = "push",
  options: { readonly scroll?: boolean } = {}
): void {
  if (!router || !isLocalWholePageDestination(href)) return;
  const token = ++pendingNavigation;
  const key = destinationKey(href);
  let attempts = 0;

  // Ask for the destination's whole page, so that the router holds it by the
  // time the navigation leaves.
  warmUpWholePage(router, href);

  /**
   * Leave for the destination.
   *
   * The first leave carries the destination's page on its way, which is what
   * commits a destination the router already holds. The leaves after that are
   * for a destination the router had to fetch: that navigation answers for
   * itself, and the router does not always commit it. Leaving again, with the
   * page in the router's cache by then, is what commits it.
   */
  const leave = (first: boolean): void => {
    if (pendingNavigation !== token) return;
    if (attempts >= MAX_ATTEMPTS) return;
    if (!first && isAtDestination(href)) return;
    attempts += 1;
    dispatch(router, href, mode, options);
  };

  activeDestination = href;
  leave(true);

  // A newer navigation replaces the one that was waiting.
  activeWaiter = {
    key,
    run: (): void => {
      if (pendingNavigation !== token) return;
      leave(false);
    }
  };
}

/**
 * Whether the Console is navigating.
 *
 * The answer matters to anything else that asks the router to do work while a
 * navigation is in flight, and the live-count refresh is that thing.
 *
 * Next.js's router keeps the navigation it is running as a promise in its
 * state, and a `router.refresh()` replaces that promise with its own -- so a
 * refresh that lands while a navigation is in flight takes the navigation's
 * place, and the navigation never applies its page: the address bar does not
 * move and the page the operator asked for does not arrive. It is not a rare
 * race either. The refresh runs every five seconds, and the navigation to the
 * densest page in the Console -- the providers table, with a write form for
 * every role and every limit -- takes longer than that to issue its request,
 * so the navigation and the refresh landed on top of each other every time.
 *
 * Measured in Chromium with the refresh left on: the navigation to
 * `/providers` issued its request three seconds after the click, the request
 * was cancelled, and the address bar stayed where it was. With the refresh
 * left off: the same navigation committed in 575 milliseconds.
 *
 * So the refresh waits for the navigation. The address bar is the only place
 * a committed navigation shows itself, and it is the one thing the owner can
 * read without a clock.
 */
export function isWholePageNavigationPending(): boolean {
  if (activeDestination === null) return false;
  return !isAtDestination(activeDestination);
}

/** Forget the recorded answers; the tests need a clean slate. */
export function clearWholePageRequestsForTests(): void {
  activeWaiter = null;
  activeDestination = null;
  pendingNavigation = 0;
  answerObserver?.disconnect();
  answerObserver = null;
}
