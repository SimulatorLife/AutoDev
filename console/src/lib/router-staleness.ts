/**
 * How long the router may reuse a page it has already fetched.
 *
 * The Console's pages are all `force-dynamic`: they show the Runtime's live
 * projection, and a page that is a minute old is a page that is wrong. So
 * the router's reuse window has to be short, and the Console's own warm-up
 * has to fit inside it.
 *
 * The two values are the same number on purpose.
 *
 * Next.js decides what to do with a page it has already fetched by asking
 * for the entry's status (`getPrefetchEntryCacheStatus` in the router's
 * prefetch cache). The status is one of four:
 *
 *   - `fresh` / `reusable` -- the entry may be used as it is;
 *   - `stale` -- the entry may only be used for its loading state, and the
 *     page data has to be fetched again;
 *   - `expired` -- the entry may not be used at all.
 *
 * The status is decided by two windows: the dynamic window (how long a
 * fetched page may be reused) and the static window (how long a *partial*
 * answer may be reused as a loading state). An entry whose kind is a partial
 * prefetch is `reusable` for the dynamic window, `stale` until the static
 * window ends, and `expired` after that.
 *
 * The `stale` branch is the one the Console must never reach. In that branch
 * the router nulls the page's `rsc`, the layout router fetches the page
 * again, and the render that would move the address bar is suspended while
 * that fetch is in flight -- and the address bar is moved by an insertion
 * effect, which does not run while a render is suspended. The navigation
 * then never commits: the operator clicks a link and the Console stays where
 * it was.
 *
 * The Console reached that branch on every navigation to the page the
 * session started on. Next.js seeds its prefetch cache with the page the
 * document was loaded from, and that seeded entry is a *partial* prefetch --
 * so with the default dynamic window of zero it was `stale` from the moment
 * the session began, and every navigation back to the starting page took
 * the branch that does not commit. Measured in Chromium against a production
 * build: the navigation to the starting page issued its request, the
 * response arrived, and the address bar did not move, in eight navigations
 * out of twenty. With the two windows equal the `stale` branch is
 * unreachable -- an entry is `reusable` for the whole window and `expired`
 * after it -- and every navigation commits.
 *
 * The number is the Console's own live-count cadence: a page the operator
 * lands on is at most five seconds old, which is the same promise the
 * five-second live-count refresh makes on the pages that carry live counts.
 */
export const ROUTER_STALE_SECONDS = 5;
