/**
 * The Console's whole-page navigation owner.
 *
 * A Next.js client navigation commits -- the address bar moves and the page
 * moves with it -- only when the destination's whole page is already in the
 * router's prefetch cache at the moment the navigation is dispatched. The
 * browser acceptance measured that on this Console: with the destination's
 * answer already in hand the navigation committed every time, and with the
 * answer still on its way the reducer applied the destination, React rendered
 * it, and the commit never ran -- the URL stayed where it was and the page did
 * not move.
 *
 * So the Console does not ask the router to navigate and hope. It asks for the
 * destination's whole page, waits until that answer has arrived, and then
 * navigates. The answer is the router's prefetch cache entry for the
 * destination, and the wait is for the request that fills it.
 *
 * The wait is not a timer. A timer would make the navigation depend on the
 * page's clock, and the browser acceptance holds that clock still on purpose --
 * a feedback that dismisses itself after five seconds has to be told apart from
 * one the operator closed, and the way to tell them apart is to stop the clock.
 * A navigation that waited on a timer would stop with it, and the page would
 * never be rebuilt around the write. So the owner waits for the answer itself:
 * it watches the request that carries it, and it knows the answer has arrived
 * when the browser has recorded that request as finished.
 *
 * The warm-up is unchanged in kind: it starts on a pointer, touch or keyboard
 * intent, never for every visible view or tab, and it asks for the whole page,
 * so the answer that arrives is the page rather than the route's loading state.
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
  return isLocalDestination(href);
}

function isLocalDestination(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/**
 * The identity of an answer: the destination it answers, without the marker
 * that says how it was carried.
 */
function answerKey(href: string): string {
  const url = new URL(href, "http://console.invalid");
  const params = new URLSearchParams(url.search);
  params.delete("_rsc");
  const query = params.toString();
  return query.length > 0 ? `${url.pathname}?${query}` : url.pathname;
}

function answerKeyOf(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (!url.searchParams.has("_rsc")) return null;
    const params = new URLSearchParams(url.search);
    params.delete("_rsc");
    const query = params.toString();
    return query.length > 0 ? `${url.pathname}?${query}` : url.pathname;
  } catch {
    return null;
  }
}

/** The navigations waiting for each destination's answer. */
const WAITERS = new Map<string, Set<() => void>>();

/**
 * A counter that orders the owner's asks and the answers it sees.
 *
 * The order is what says whether an answer is the one the owner is waiting
 * for. An answer seen before the owner asked is an answer left over from an
 * earlier visit, and the router may not be holding it; an answer seen after
 * the ask is the answer to the request the owner made.
 */
let order = 0;

/** When each destination was first asked for. */
const ASKED = new Map<string, number>();

/** When each destination's answer was last seen. */
const ANSWERED = new Map<string, number>();

/** The navigation the owner is currently waiting for; a newer one replaces it. */
let pendingNavigation = 0;

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
      const key = answerKeyOf(entry.name);
      if (key === null) continue;
      ANSWERED.set(key, ++order);
      resolveWaiters(key);
    }
  });
  answerObserver.observe({ type: "resource", buffered: true });
}

/**
 * Let the navigations waiting for a destination's answer go.
 *
 * They go when the answer they are waiting for has arrived: the answer has to
 * have been seen at or after the owner's first ask, because an answer from
 * before that ask is an answer the router may no longer be holding.
 */
function resolveWaiters(key: string): void {
  const waiters = WAITERS.get(key);
  if (!waiters) return;
  const asked = ASKED.get(key);
  const answered = ANSWERED.get(key);
  if (asked === undefined || answered === undefined || answered < asked) return;
  WAITERS.delete(key);
  for (const waiter of waiters) waiter();
}

/**
 * Ask for the destination's whole page.
 *
 * The ask is recorded before it is made, so the answer that arrives for it is
 * the answer the owner waits for.
 */
export function warmUpWholePage(router: WholePageRouter, href: string): void {
  if (!router || !isLocalDestination(href)) return;
  const key = answerKey(href);
  if (!ASKED.has(key)) ASKED.set(key, ++order);
  installAnswerObserver();
  router.prefetch(href);
}

/**
 * Wait for the destination's answer.
 *
 * The wait ends when the answer arrives, or when a newer navigation replaces
 * this one.
 */
function waitForWholePageAnswer(href: string): Promise<void> {
  const key = answerKey(href);
  const waiters = WAITERS.get(key) ?? new Set<() => void>();
  WAITERS.set(key, waiters);
  return new Promise<void>((resolve) => {
    const waiter = (): void => {
      waiters.delete(waiter);
      resolve();
    };
    waiters.add(waiter);
    // The answer may already be in hand: the warm-up that asked for it may
    // have been answered while the operator was still on the link.
    resolveWaiters(key);
  });
}

/**
 * Navigate to the destination, once its whole page has arrived.
 *
 * The navigation is dispatched from here rather than from the click so that
 * the answer is in the router's cache when the navigation leaves.
 */
export async function navigateToWholePage(
  router: WholePageRouter,
  href: string,
  mode: WholePageNavigationMode = "push",
  options: { readonly scroll?: boolean } = {}
): Promise<void> {
  if (!router || !isLocalDestination(href)) return;
  const token = ++pendingNavigation;
  const answer = waitForWholePageAnswer(href);
  warmUpWholePage(router, href);
  await answer;
  if (pendingNavigation !== token) return;
  if (mode === "replace") {
    router.replace(href, { scroll: options.scroll ?? false });
    return;
  }
  router.push(href, { scroll: options.scroll ?? false });
}

/** Forget the recorded asks and answers; the tests need a clean slate. */
export function clearWholePageRequestsForTests(): void {
  WAITERS.clear();
  ASKED.clear();
  ANSWERED.clear();
  order = 0;
  pendingNavigation = 0;
  answerObserver?.disconnect();
  answerObserver = null;
}
