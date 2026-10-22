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
 * destination; the wait is for the request that fills it.
 *
 * The warm-up itself is unchanged in kind: it starts on a pointer, touch or
 * keyboard intent, never for every visible view or tab, and it is a full
 * prefetch, so the answer that arrives is the page rather than the route's
 * loading state.
 */

/** The kind of prefetch that answers with the page rather than a shell. */
export const WHOLE_PAGE_PREFETCH_KIND = "full";

/** How often the owner looks for the answer while it waits for it. */
const ANSWER_POLL_MS = 10;

/**
 * How long the owner waits for an answer before it navigates anyway.
 *
 * The wait is the mechanism, not a delay: the navigation commits because the
 * answer is in hand when it is dispatched. The limit only covers the case
 * where the router already holds the answer and therefore asks for nothing --
 * there the navigation finds that answer on its own and commits without the
 * owner having to see a request arrive. A navigation must not hang, so the
 * wait ends and the navigation goes out.
 */
const ANSWER_WAIT_LIMIT_MS = 5000;

export type WholePageNavigationMode = "push" | "replace";

export interface WholePageRouter {
  /**
   * Ask for the destination's page.
   *
   * Next.js's prefetch kind defaults to the full page, which is the kind the
   * Console needs: a partial prefetch answers with the route's loading state
   * rather than with the page, and a navigation that finds that answer waiting
   * for it never commits.
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
 * When each destination's whole page was asked for.
 *
 * The time matters: the owner waits for an answer that arrived after it asked,
 * so an answer left over from an earlier visit cannot pass for the one the
 * navigation is waiting for.
 */
const WHOLE_PAGE_REQUESTS = new Map<string, number>();

/** The navigation the owner is currently waiting for; a newer one replaces it. */
let pendingNavigation = 0;

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

/**
 * Whether the destination's whole page has arrived since the owner asked.
 *
 * The browser's own record of the request is the signal: the answer is in
 * hand when the request that carries it has finished.
 */
export function wholePageAnswerArrived(
  href: string,
  since: number,
  entries: PerformanceEntryList = performance.getEntriesByType("resource")
): boolean {
  const wanted = answerKey(href);
  for (const entry of entries) {
    if (entry.startTime < since) continue;
    const resource = entry as PerformanceResourceTiming;
    if (resource.responseEnd <= 0) continue;
    const key = answerKeyOf(entry.name);
    if (key !== null && key === wanted) return true;
  }
  return false;
}

/**
 * How the owner decides that the answer has arrived.
 *
 * The default reads the browser's own record of the request. The tests
 * supply their own, because a unit test has no request to wait for.
 */
export type WholePageAnswerProbe = (href: string, since: number) => boolean;

let answerProbe: WholePageAnswerProbe = wholePageAnswerArrived;

/** Point the owner at a different answer probe; the tests need one. */
export function setWholePageAnswerProbeForTests(
  probe: WholePageAnswerProbe | null
): void {
  answerProbe = probe ?? wholePageAnswerArrived;
}

/**
 * Ask for the destination's whole page.
 *
 * The request is recorded before it is made, so the answer that arrives for it
 * is the answer the owner waits for.
 */
export function warmUpWholePage(
  router: WholePageRouter,
  href: string
): void {
  if (!router || !isLocalDestination(href)) return;
  const key = answerKey(href);
  if (!WHOLE_PAGE_REQUESTS.has(key)) {
    WHOLE_PAGE_REQUESTS.set(key, performance.now());
  }
  router.prefetch(href);
}

/**
 * Wait for the destination's answer.
 *
 * The wait is a poll rather than a subscription: the browser's own record of
 * the request is the signal, and the owner looks for it until the answer is in
 * hand, the wait is given up on, or a newer navigation replaces this one.
 */
async function waitForWholePageAnswer(
  href: string,
  since: number,
  token: number,
  deadline: number
): Promise<void> {
  if (pendingNavigation !== token) return;
  if (answerProbe(href, since)) return;
  if (performance.now() >= deadline) return;
  await new Promise((resolve) => {
    setTimeout(resolve, ANSWER_POLL_MS);
  });
  await waitForWholePageAnswer(href, since, token, deadline);
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
  const key = answerKey(href);
  warmUpWholePage(router, href);
  const since = WHOLE_PAGE_REQUESTS.get(key) ?? performance.now();
  const token = ++pendingNavigation;
  await waitForWholePageAnswer(
    href,
    since,
    token,
    performance.now() + ANSWER_WAIT_LIMIT_MS
  );
  if (pendingNavigation !== token) return;
  if (mode === "replace") {
    router.replace(href, { scroll: options.scroll ?? false });
    return;
  }
  router.push(href, { scroll: options.scroll ?? false });
}

/** Forget the recorded requests; the tests need a clean slate. */
export function clearWholePageRequestsForTests(): void {
  WHOLE_PAGE_REQUESTS.clear();
  pendingNavigation = 0;
}
