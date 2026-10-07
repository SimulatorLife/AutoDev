/**
 * URL state for the Evaluations resource.
 *
 * Every piece of operator state on `/evaluations` is a query parameter, so the
 * page stays addressable, bookmarkable, and shareable without JavaScript. This
 * module owns that contract in one place for the same reason
 * `memory-list-url.ts` does: the filter bar, the row links, the trace links, and
 * the detail drawer all have to agree about which parameters exist and what
 * survives a navigation between them. Hand-rolling `URLSearchParams` at each of
 * those four call sites is how the prompt filter ended up the only filter the
 * page understood -- the others existed as columns but nothing could narrow by
 * them.
 */

import type { EvaluationResult } from "@simulatorlife/autodev-core";

const EVALUATIONS_ROUTE = "/evaluations";

/**
 * How an evaluation's own verdict reads. `Not observed` is the third state, not
 * a synonym for failure: the target state requires a result to be passed or
 * failed only when its source supplies an explicit verdict, so a filter that
 * cannot separate "failed" from "never answered" cannot answer the question an
 * operator is actually asking.
 */
type EvaluationOutcomeFilter = "all" | "passed" | "failed" | "not-observed";

const EVALUATION_OUTCOME_FILTERS: readonly EvaluationOutcomeFilter[] = [
  "all",
  "passed",
  "failed",
  "not-observed"
];

export const OUTCOME_FILTER_LABELS: Readonly<
  Record<EvaluationOutcomeFilter, string>
> = {
  all: "All outcomes",
  passed: "Passed",
  failed: "Failed",
  "not-observed": "Not observed"
};

/** The filter axes `/evaluations` narrows on, all optional. */
export interface EvaluationsFilters {
  readonly outcome: EvaluationOutcomeFilter;
  readonly role: string;
  readonly model: string;
  /**
   * The prompt an evaluation ran against. This parameter predates the others --
   * the Prompts resource links here with it -- so its name and meaning are fixed
   * by existing links rather than chosen here.
   */
  readonly prompt: string;
  /**
   * First UTC day of runs to include, as `YYYY-MM-DD`.
   *
   * The read is capped, so a table of five thousand is only ever fetched as its
   * most recent thousand and the four thousand before that are unreachable from
   * the page. Every other axis on this resource is categorical -- outcome, role,
   * model, prompt -- so "which failures happened on Tuesday" had no answer at
   * all: the only way to reach it was to page through twenty pages of runs and
   * read their timestamps. This is the axis that makes a bounded history usable.
   */
  readonly from: string;
  /** Last UTC day of runs to include, inclusive, as `YYYY-MM-DD`. */
  readonly until: string;
}

const EMPTY_EVALUATIONS_FILTERS: EvaluationsFilters = {
  outcome: "all",
  role: "",
  model: "",
  prompt: "",
  from: "",
  until: ""
};

/**
 * A UTC calendar date, as a shape and then as a real one.
 *
 * `bounded()` accepts any short string, and a filter that silently narrows
 * nothing is better than one that narrows by a date the operator did not mean.
 * `2026-02-31` matches the shape and is not a date, so the parsed value has to
 * be compared back to the text it came from -- otherwise `new Date` rolls it to
 * March 3rd and the window quietly starts three days late.
 */
const UTC_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

/**
 * The UTC day a parameter names, or nothing.
 *
 * Returns the epoch milliseconds of midnight UTC, which is what a comparison
 * against an ISO timestamp wants; `undefined` means "not set", and an
 * unreadable value is treated the same way rather than being guessed at.
 */
/**
 * The UTC midnight a parameter names, or nothing.
 *
 * One exit, because a function that answers "no bound" on some paths and a
 * number on others is the shape `consistent-return` is configured here to
 * reject -- and the single exit is also the clearer statement of the rule: a
 * parameter is a bound only when it is a real UTC day that survives being
 * parsed back into the same text.
 */
function resolveUtcDayBound(value: RawQueryValue): number | undefined {
  const raw = singleValue(value);
  const text = raw === undefined ? "" : raw.trim();
  const parsed = UTC_DATE.test(text)
    ? Date.parse(`${text}T00:00:00Z`)
    : Number.NaN;
  return Number.isNaN(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== text
    ? undefined
    : parsed;
}

/**
 * The last millisecond of the UTC day a parameter names.
 *
 * `until` names a day, not an instant: "to 2026-10-05" has to include every run
 * on the fifth, and comparing against midnight of the fifth excluded all but the
 * first second of it. The bound is therefore exclusive at the start of the next
 * day, which also makes an adjacent window (`from` the sixth, `until` the fifth)
 * cover every instant exactly once rather than leaving or repeating a boundary.
 */
function resolveUtcDayEnd(value: RawQueryValue): number | undefined {
  const start = resolveUtcDayBound(value);
  return start === undefined ? undefined : start + 86_400_000;
}

/** Query keys that carry a selection rather than a filter. */
export const EVALUATION_RESULT_PARAM = "result";
export const EVALUATION_SPAN_PARAM = "spanId";
export const EVALUATIONS_PAGE_PARAM = "page";

type RawQueryValue = string | readonly string[] | undefined;

/**
 * The two sections of the resource.
 *
 * Comparisons are a secondary reading of the same rows rather than a second
 * dataset, which is why they are a tab and not their own route: the target state
 * puts advanced diagnostics behind a tab or drawer unless they are the page's
 * primary purpose, and the run history is what an operator came for.
 */
export type EvaluationsTabId = "results" | "comparisons";

export const EVALUATIONS_TABS: readonly {
  readonly id: EvaluationsTabId;
  readonly label: string;
}[] = [
  { id: "results", label: "Results" },
  { id: "comparisons", label: "Comparisons" }
];

/**
 * The tab a plain `/evaluations` URL means.
 *
 * Exported because two things outside this module have to agree with it: the
 * view's own prop default, and the filter bar's decision about whether a
 * submission needs to carry the tab at all. A submission that carried
 * `tab=results` would be harmless but would put a parameter on the URL that the
 * rest of the module exists to leave implicit.
 */
export const DEFAULT_EVALUATIONS_TAB: EvaluationsTabId = "results";

export function resolveEvaluationsTab(value: RawQueryValue): EvaluationsTabId {
  const raw = singleValue(value);
  return EVALUATIONS_TABS.some((tab) => tab.id === raw)
    ? (raw as EvaluationsTabId)
    : DEFAULT_EVALUATIONS_TAB;
}

/**
 * Read one parameter, ignoring a repeated one.
 *
 * A value that quietly takes the first of two reports one answer while the URL
 * says another, so a duplicated key resolves to "not set" and the page shows the
 * unfiltered list instead of an arbitrary narrowing.
 *
 * Exported because the rule is not a filter's property, it is this resource's:
 * a repeated `spanId` cannot be which span to open, and a repeated `result`
 * cannot be which run to open, and the page used to resolve one of them by
 * taking the first anyway.
 */
export function singleValue(value: RawQueryValue): string | undefined {
  if (typeof value === "string") return value;
  return value?.length === 1 ? value[0] : undefined;
}

function bounded(value: string | undefined, max = 256): string {
  return (value ?? "").trim().slice(0, max);
}

function resolveOutcomeFilter(value: RawQueryValue): EvaluationOutcomeFilter {
  const raw = singleValue(value);
  return EVALUATION_OUTCOME_FILTERS.find((option) => option === raw) ?? "all";
}

/**
 * Parse every filter parameter out of a route's search params.
 *
 * An unrecognised outcome resolves to `all` rather than to nothing: it is a
 * filter the operator cannot have meant, and silently returning zero rows would
 * report an empty history where the store has results.
 */
export function parseEvaluationsFilters(
  params: Readonly<Record<string, RawQueryValue>>
): EvaluationsFilters {
  return {
    outcome: resolveOutcomeFilter(params.outcome),
    role: bounded(singleValue(params.role)),
    model: bounded(singleValue(params.model)),
    prompt: bounded(singleValue(params.prompt)),
    from: utcDayText(params.from),
    until: utcDayText(params.until)
  };
}

/**
 * A day parameter as the text a date input needs back, or "".
 *
 * The bound is computed from the parsed value rather than echoed, so what the
 * control displays is always something the filter will actually accept -- a
 * hand-edited `?from=2026-02-31` renders as an empty control instead of a date
 * the window does not honour.
 */
function utcDayText(value: RawQueryValue): string {
  const bound = resolveUtcDayBound(value);
  return bound === undefined ? "" : new Date(bound).toISOString().slice(0, 10);
}

/** True when nothing is narrowed, which is what the "clear" affordance checks. */
export function hasActiveFilters(filters: EvaluationsFilters): boolean {
  return (
    filters.outcome !== "all" ||
    filters.role !== "" ||
    filters.model !== "" ||
    filters.prompt !== "" ||
    filters.from !== "" ||
    filters.until !== ""
  );
}

function filtersParams(filters: EvaluationsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.outcome !== "all") params.set("outcome", filters.outcome);
  if (filters.role !== "") params.set("role", filters.role);
  if (filters.model !== "") params.set("model", filters.model);
  if (filters.prompt !== "") params.set("prompt", filters.prompt);
  if (filters.from !== "") params.set("from", filters.from);
  if (filters.until !== "") params.set("until", filters.until);
  return params;
}

/** One selection at a time: an open run, or the trace it links to. */
interface EvaluationsSelection {
  readonly tab: EvaluationsTabId;
  readonly resultId?: string | undefined;
  readonly spanId?: string | undefined;
  /**
   * Which page of the narrowed window the history table is showing.
   *
   * Page state lives with the selection rather than with the filters because it
   * answers the same question: where in the list the operator is. A drawer link
   * carries it so closing the drawer returns to the page they were reading, and
   * a filter link deliberately does not, because a narrower result set can have
   * fewer pages than the one being left.
   */
  readonly page?: number | undefined;
}

const NO_SELECTION: EvaluationsSelection = {
  tab: DEFAULT_EVALUATIONS_TAB
};

/**
 * How many rows the history table renders at once.
 *
 * The read is capped, so the table was being handed up to a thousand rows and
 * rendering every one of them into the response. Measured on that cap: 2.9MiB of
 * markup and 25,913 DOM nodes for one page, against 8ms of layout -- the cost was
 * entirely in emitting and parsing rows, not in drawing them. Fifty rows keeps a
 * page at roughly a thousand nodes while leaving every row reachable through the
 * paginator, which a smaller cap on the read would not.
 */
export const EVALUATIONS_PAGE_SIZE = 50;

/** The first page, which the URL leaves implicit. */
const FIRST_EVALUATIONS_PAGE = 1;

/**
 * A page number, as a shape rather than a range check.
 *
 * A page is an address, and this rejects everything that is not one: an empty
 * value, a sign, a decimal, or anything that is not a run of digits. A repeated
 * key is already resolved to "not set" by `singleValue` before this sees it.
 *
 * Magnitude is deliberately not part of the shape. This used to cap the run at
 * five digits, which split one rule in two: `?page=99` was a page the read could
 * not fill and was clamped to the last page that exists, while `?page=100000` was
 * rejected as not-a-page and silently became the first. Both are the same
 * operator mistake -- a page past the end -- and the read is capped at a
 * thousand rows, so neither is a page anyone could reach anyway. Rewinding to
 * the first page is also the one answer that contradicts the rule stated below,
 * and it contradicts it silently, because nothing on the page says the request
 * was discarded rather than clamped. Clamping an absurd page is bounded work:
 * the renderer clamps before it slices, so a long run of digits costs one
 * `Math.min`.
 */
const PAGE_NUMBER = /^[1-9][0-9]*$/u;

/**
 * The page a request asked for, or the first.
 *
 * A page number is an address, not a claim: an out-of-range value is clamped by
 * whoever renders it against the rows it actually has, so a bookmark to a page
 * that a narrower filter has since emptied lands on the last page that exists
 * rather than on an empty table.
 */
export function resolveEvaluationsPage(value: RawQueryValue): number {
  const raw = singleValue(value);
  if (raw === undefined || !PAGE_NUMBER.test(raw)) {
    return FIRST_EVALUATIONS_PAGE;
  }
  return Number.parseInt(raw);
}

/** How many pages a set of rows occupies, always at least one. */
export function evaluationsPageCount(
  rows: number,
  pageSize: number = EVALUATIONS_PAGE_SIZE
): number {
  return Math.max(1, Math.ceil(rows / Math.max(1, pageSize)));
}

/** The page to render: the requested one, or the last one that exists. */
export function clampEvaluationsPage(
  page: number,
  rows: number,
  pageSize: number = EVALUATIONS_PAGE_SIZE
): number {
  return Math.min(
    Math.max(page, FIRST_EVALUATIONS_PAGE),
    evaluationsPageCount(rows, pageSize)
  );
}

/** The rows one page of the narrowed window shows. */
export function evaluationsPageRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = EVALUATIONS_PAGE_SIZE
): readonly T[] {
  const current = clampEvaluationsPage(page, rows.length, pageSize);
  if (current === FIRST_EVALUATIONS_PAGE) return rows.slice(0, pageSize);
  const start = (current - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/**
 * The one place an `/evaluations` URL is assembled.
 *
 * Five call sites need to build one -- the filter bar, the tab links, a row's
 * result link, a row's trace link, and every close link -- and they disagreed
 * about what survives a navigation. A trace opened from a narrowed list used to
 * drop the narrowing, so "go back to evaluations" returned an unfiltered page
 * that no longer contained the row being read. Every builder now goes through
 * this one, so a link states what it keeps.
 */
export function evaluationsHref(
  filters: EvaluationsFilters,
  selection: EvaluationsSelection = NO_SELECTION
): string {
  const params = filtersParams(filters);
  if (selection.tab !== DEFAULT_EVALUATIONS_TAB) {
    params.set("tab", selection.tab);
  }
  if (selection.resultId !== undefined && selection.resultId !== "") {
    params.set(EVALUATION_RESULT_PARAM, selection.resultId);
  }
  if (selection.spanId !== undefined && selection.spanId !== "") {
    params.set(EVALUATION_SPAN_PARAM, selection.spanId);
  }
  // The first page is what an unparameterised link already means, so it is left
  // implicit and every page link after the first is one parameter longer.
  if (selection.page !== undefined && selection.page > FIRST_EVALUATIONS_PAGE) {
    params.set(EVALUATIONS_PAGE_PARAM, String(selection.page));
  }
  return params.size === 0
    ? EVALUATIONS_ROUTE
    : `${EVALUATIONS_ROUTE}?${params.toString()}`;
}

/** The list for a filter state, with whatever is currently open still open. */
export function evaluationsListHref(
  filters: EvaluationsFilters,
  selection: Partial<EvaluationsSelection> = {}
): string {
  return evaluationsHref(filters, { ...NO_SELECTION, ...selection });
}

/**
 * The whole retained history, keeping whatever the operator was reading.
 *
 * Two links clear the filters and neither of them means "forget everything":
 * the one beside the section links says "Clear filters" and is on a page whose
 * whole shape is the section you are reading, and the one in the callout for an
 * excluded run says "Clear the filters and look for it in the whole retained
 * history" -- a promise to go to that run, which the unfiltered list cannot keep
 * because the run may be on any page of fifty. Both used to hand back a bare
 * `/evaluations`, dropping the section and the run as well as the narrowing.
 *
 * The page is deliberately not kept, and that is the one thing it drops: a
 * narrower result set can have fewer pages than the one being left, so the page
 * is not a position in the list that follows. `clampEvaluationsPage` would hide
 * an out-of-range page, but landing on page 1 of a different list is the honest
 * answer to "show me everything".
 */
export function evaluationsClearedHref(
  selection: Partial<EvaluationsSelection> = {}
): string {
  return evaluationsHref(parseEvaluationsFilters({}), {
    ...NO_SELECTION,
    ...selection
  });
}

/**
 * One result, opened from the history table.
 *
 * The filter state travels with it so the drawer's close link returns the
 * operator to the list they narrowed, not to an unfiltered page that no longer
 * contains the row they were reading.
 *
 * The page travels for the same reason, and it was the one piece of state the
 * list was already carrying that this link dropped. The history table pages at
 * 50 rows, so any history longer than a screen has a page the operator is
 * genuinely reading rather than the only page. Measured on a 120-row history:
 * opening a run from page 3 navigated to a URL with no page in it, which is page
 * 1, so the list beneath the open drawer showed page 1 -- the row just clicked
 * was not in the list at all -- and because the page had already left the URL,
 * closing the drawer could not put the operator back on page 3 either. The
 * drawer is inline, so that list is the context the detail is read against.
 *
 * `evaluationsClearedHref` is the same rule on the other link: it drops the
 * page too, because clearing a filter changes which rows exist.
 */
export function evaluationResultHref(
  filters: EvaluationsFilters,
  resultId: string,
  tab: EvaluationsTabId = DEFAULT_EVALUATIONS_TAB,
  page?: number | undefined
): string {
  return evaluationsHref(filters, { tab, resultId, page });
}

/**
 * The element a trace URL scrolls to.
 *
 * The trace panel is 200 rows tall at the cap, and every link in it -- a row's
 * "View trace", the drawer's trace value, every span cell -- is a full
 * server-rendered page load. A link that names the span without naming where it
 * is therefore drops the operator at the top of a table they then have to
 * search: measured, a trace opened for a span at row 100 lands at scrollY=0
 * with the selected row 4,600px below the fold, which is the same hunt the
 * in-row marker exists to end one step earlier.
 *
 * A fragment is the whole of the fix and it needs no script. The browser scrolls
 * to the element whose id the fragment names, before anything this page does
 * runs, and a link that arrives without a matching element scrolls nowhere --
 * the current behaviour -- so it degrades to what is there rather than breaking.
 *
 * Derived next to the href builder because a fragment that does not match the id
 * is a link that silently goes nowhere, and the two drifting apart is invisible
 * until someone clicks.
 */
export function traceSpanAnchorId(spanId: string): string {
  return `evaluation-trace-span-${spanId}`;
}

/**
 * The trace for one span, keeping the filters and the page.
 *
 * A trace is a property of the run that produced it, so opening one from a
 * filtered list must not silently widen the list the operator is reading.
 *
 * The page travels for the same reason `evaluationResultHref` carries it: the
 * trace panel is rendered beside the list it was opened from, so that list is
 * the context the trace is read against. Measured on a 120-row history, opening
 * a trace from page 2 left the URL with no page in it -- which is page 1 -- so
 * the list re-rendered as rows 1-50 beside the trace, fifty rows away from the
 * row the link came from. The run link beside it already carried the page, so
 * the two ways into a detail from the same row disagreed about where they left
 * the operator.
 *
 * The fragment is the span's anchor, so the link lands on the row it names
 * rather than at the top of the panel.
 */
export function evaluationTraceHref(
  filters: EvaluationsFilters,
  spanId: string,
  tab: EvaluationsTabId = DEFAULT_EVALUATIONS_TAB,
  page?: number | undefined
): string {
  return `${evaluationsHref(filters, { tab, spanId, page })}#${traceSpanAnchorId(spanId)}`;
}

/**
 * One section of the resource, keeping the filters and the page.
 *
 * A section is another view of the same runs, not a different question, so the
 * position in the list is part of the reading and travels with it. Measured on a
 * 120-row history: from page 2 of a narrowed Results, both section links dropped
 * the page, so a round trip through Comparisons -- the one place an operator goes
 * to look at the same runs grouped differently -- came back to rows 1-50.
 *
 * This is the opposite of `evaluationsClearedHref`, which drops the page on
 * purpose: clearing a filter changes which rows exist, so an old position names
 * rows that are no longer there. Changing section does not. The page is carried
 * into the comparisons URL too, where it is inert -- the view clamps a page its
 * own section has no pager for -- and that is the price of the way back.
 */
export function evaluationsTabHref(
  filters: EvaluationsFilters,
  tab: EvaluationsTabId,
  page?: number | undefined
): string {
  return evaluationsHref(filters, { tab, page });
}

/**
 * One page of the narrowed window, keeping the filters and the section.
 *
 * Page links deliberately carry no open run or open trace. A page link is a move
 * along the list, and carrying the drawer across it would reopen a detail for a
 * run that is no longer on screen.
 */
export function evaluationsPageHref(
  filters: EvaluationsFilters,
  page: number,
  tab: EvaluationsTabId = DEFAULT_EVALUATIONS_TAB
): string {
  return evaluationsHref(filters, { tab, page });
}

/** Whether one evaluation carries an explicit verdict, in either direction. */
export function hasExplicitVerdict(evaluation: EvaluationResult): boolean {
  return evaluation.passed !== null && evaluation.passed !== undefined;
}

/**
 * The prompt a run reports, or nothing.
 *
 * One predicate for "this run named no prompt", because the field is optional on
 * the wire and the Console validated it as optional without ever checking what
 * the optional value was. Four places used to answer the question separately and
 * disagree: the filter options skipped a blank name as well as an absent field,
 * the table rendered "No prompt" for an absent field but an empty cell for a
 * blank one, and the prompt filter matched only on an absent field -- so a blank
 * prompt made a run vanish from the filtered view while the unfiltered table
 * above it showed nothing at all in that cell. An unreadable field now reads the
 * same way everywhere: as no prompt.
 */
export function reportedPrompt(
  evaluation: EvaluationResult
): string | undefined {
  const name = evaluation.promptName;
  return typeof name === "string" && name.trim() !== ""
    ? name.trim()
    : undefined;
}

function matchesOutcome(
  evaluation: EvaluationResult,
  outcome: EvaluationOutcomeFilter
): boolean {
  if (outcome === "all") return true;
  if (outcome === "not-observed") return !hasExplicitVerdict(evaluation);
  return evaluation.passed === (outcome === "passed");
}

/**
 * A filtered result, and the runs a bounded window could not place.
 *
 * `unplaceable` is reported rather than absorbed. A row whose run time is not a
 * readable instant cannot be inside or outside a window, and the target state is
 * explicit that a row must not be "silently dropped ... and bias[ing] displayed
 * totals or pass-rate denominators" -- so it is excluded from the match and
 * counted for the page to state. It is zero unless a time bound is set, because
 * without one no row has to be placed at all.
 */
interface PlacedEvaluations {
  readonly results: readonly EvaluationResult[];
  readonly unplaceable: number;
  /**
   * Runs that report no prompt and matched anyway because a prompt filter was
   * set. Zero unless one was: with no prompt filter there is nothing to explain.
   */
  readonly promptless: number;
}

/**
 * Narrow already-fetched results by the parsed filters.
 *
 * This runs on the page, after the single bounded Control API read, rather than
 * becoming a second query axis in the API: the read is already capped at the
 * most recent N results, so filtering server-side could only narrow the cap
 * without making the total any more honest. The trade is stated here because it
 * is a real one -- the pass rate and the totals describe the fetched window,
 * not the whole store.
 *
 * Returns the matches *and* the count of rows a time bound could not place,
 * rather than only the matches: the caller has to be able to say so.
 */
export function filterEvaluations(
  evaluations: readonly EvaluationResult[],
  filters: EvaluationsFilters
): PlacedEvaluations {
  const from = resolveUtcDayBound(filters.from);
  const until = resolveUtcDayEnd(filters.until);

  const results: EvaluationResult[] = [];
  let unplaceable = 0;
  let promptless = 0;
  for (const evaluation of evaluations) {
    if (!matchesTarget(evaluation, filters)) continue;
    const verdict = runTimeVerdict(evaluation, from, until);
    if (verdict === RUN_UNPLACEABLE) {
      unplaceable += 1;
      continue;
    }
    if (verdict === RUN_OUTSIDE) continue;
    results.push(evaluation);
    // Counted here rather than derived from `results` afterwards because a row
    // that a time bound excluded was not in the view to be explained, and a
    // caveat must never describe a row the operator cannot see.
    if (filters.prompt !== "" && reportedPrompt(evaluation) === undefined) {
      promptless += 1;
    }
  }
  return { results, unplaceable, promptless };
}

/**
 * A window the bounded read never reached.
 */
interface UnreadWindow {
  /**
   * The oldest run the read did fetch, as epoch milliseconds.
   *
   * Stated rather than summarised because it is the one figure that settles the
   * question: a window ending before this instant is outside the read, and a
   * window ending after it is inside what the page actually holds.
   */
  readonly oldestReadAt: number;
}

/**
 * Whether the operator's window excludes every instant.
 *
 * Both bounds naming real UTC days, with `from` on a later day than `until`.
 * This is not a narrow window and not a window with no runs in it: it is a
 * window with no instants in it, which the URL establishes on its own, with no
 * data and no read involved.
 *
 * The two date controls cross-link with `min`/`max` so a browser refuses an
 * inverted range, and the view's own comment on that control says the
 * server-side parse re-checks regardless -- a constraint on an input is a
 * convenience, not a rule. It did not re-check: an inverted range simply
 * matched nothing, which is exactly what a narrow window holding no runs also
 * does, so the page answered with the same "clear or widen" it gives for an
 * ordinary empty result. The URL is hand-edited, bookmarked and shared, so the
 * inverted range arrives by all three.
 *
 * Both bounds must be readable days. One bound alone cannot exclude every
 * instant -- a window with no end may still reach runs -- and an unreadable day
 * is not a bound at all, which the caller already reports on its own terms.
 */
export function contradictoryWindow(filters: EvaluationsFilters): boolean {
  const from = resolveUtcDayBound(filters.from);
  const until = resolveUtcDayBound(filters.until);
  return from !== undefined && until !== undefined && from > until;
}

/**
 * Whether the operator's window ends before anything the bounded read holds.
 *
 * The read is capped, so the history the page can speak about stops at some run.
 * Asking for a window older than that is a question the page has not read the
 * answer to, and it used to answer it anyway: `?from=2020-01-01&until=2020-12-31`
 * rendered "No evaluation results match these filters" against a store holding
 * five thousand rows, which is the target state's "must not be represented as a
 * successful empty result set" in exactly the form it forbids -- an incomplete
 * read presented as a complete answer. The time window is what made it
 * reachable, so the time window is where it has to be answered.
 *
 * Three conditions, and dropping any of them would make the page cry wolf:
 *
 * - The read must have been truncated. An untruncated read *is* the whole store,
 *   so an empty window really is empty.
 * - The window must have an end. Without one it may span the boundary, reaching
 *   both into the read and past it.
 * - The window's exclusive end must be at or before the oldest run the read
 *   holds. A window in the future passes over the read entirely and is honestly
 *   empty, so it is not this case.
 *
 * Rows whose run time is not a readable instant are skipped rather than
 * compared: they cannot date the read, and a row that cannot be placed cannot be
 * evidence that the window was reached either.
 */
export function unreadWindow(
  evaluations: readonly EvaluationResult[],
  filters: EvaluationsFilters,
  truncated: boolean
): UnreadWindow | undefined {
  // One exit, for the reason `resolveUtcDayBound` has one: a function that
  // answers "the read reached it" on some paths and a figure on others is the
  // shape `consistent-return` is configured here to reject, and the single
  // comparison at the end states the rule in full -- truncated, ended, and older
  // than everything the read holds, or nothing to say.
  const until = truncated ? resolveUtcDayEnd(filters.until) : undefined;
  let oldestReadAt: number | undefined;
  if (until !== undefined) {
    for (const evaluation of evaluations) {
      const at = Date.parse(evaluation.timestamp);
      if (Number.isNaN(at)) continue;
      if (oldestReadAt === undefined || at < oldestReadAt) oldestReadAt = at;
    }
  }
  return until !== undefined &&
    oldestReadAt !== undefined &&
    oldestReadAt >= until
    ? { oldestReadAt }
    : undefined;
}

/**
 * Every categorical axis at once: what the run evaluated, and how it came out.
 *
 * A prompt-less row still matches a prompt filter. `promptName` is optional on
 * the wire, and a row that reports no prompt is not evidence that it ran under
 * some other prompt, so dropping it from a filtered view would report a smaller
 * history than the source holds. The page states how many rows that was rather
 * than leaving the inclusion silent.
 */
function matchesTarget(
  evaluation: EvaluationResult,
  filters: EvaluationsFilters
): boolean {
  if (!matchesOutcome(evaluation, filters.outcome)) return false;
  if (filters.role !== "" && evaluation.agentRole !== filters.role)
    return false;
  if (filters.model !== "" && evaluation.model !== filters.model) return false;
  if (filters.prompt !== "") {
    const prompt = reportedPrompt(evaluation);
    if (prompt !== undefined && prompt !== filters.prompt) return false;
  }
  return true;
}

/** Where a run sits relative to the window, or that it cannot be placed. */
type RunVerdict = "inside" | "outside" | "unplaceable";
const RUN_OUTSIDE = "outside";
const RUN_UNPLACEABLE = "unplaceable";

/**
 * Whether a run falls inside the window.
 *
 * Three answers rather than two, because "no readable run time" and "outside
 * the window" are different facts and collapsing them would drop a row from
 * every count on the page without saying so.
 */
function runTimeVerdict(
  evaluation: EvaluationResult,
  from: number | undefined,
  until: number | undefined
): RunVerdict {
  if (from === undefined && until === undefined) return "inside";
  const at = Date.parse(evaluation.timestamp);
  if (Number.isNaN(at)) return RUN_UNPLACEABLE;
  if (from !== undefined && at < from) return RUN_OUTSIDE;
  if (until !== undefined && at >= until) return RUN_OUTSIDE;
  return "inside";
}

/**
 * One collator for every ordering here.
 *
 * `localeCompare` constructs an `Intl.Collator` on each call, and these sorts run
 * on every render of the filter options. Hoisting keeps the ordering identical
 * and the construction off the render path.
 */
const OPTION_COLLATOR = new Intl.Collator("en");

/** The axes whose options are computed, each from the others' narrowing. */
type OptionAxis = "role" | "model" | "prompt";

/** The distinct values each filter axis can narrow on. */
export interface EvaluationsFilterOptions {
  readonly roles: readonly string[];
  readonly models: readonly string[];
  readonly prompts: readonly string[];
}

/** The filter state with one axis released, so its own options can be read. */
function withoutAxis(
  filters: EvaluationsFilters,
  skip: OptionAxis
): EvaluationsFilters {
  return {
    ...filters,
    ...(skip === "role" ? { role: "" } : {}),
    ...(skip === "model" ? { model: "" } : {}),
    ...(skip === "prompt" ? { prompt: "" } : {})
  };
}

/**
 * The distinct values each filter axis can narrow on, given the rest of the
 * narrowing.
 *
 * Computed per axis over the rows that match *every other* axis, which is what
 * makes every offered option lead somewhere. This used to be computed once over
 * the whole fetched window with the filters ignored entirely, and the measured
 * consequence was that the lists never moved: narrowing to one role still
 * offered every model, so a quarter of the offered combinations produced no rows
 * at all. A control that can manufacture an empty history is a control lying
 * about what exists -- the page then reports "No results in this view" for a
 * combination it had just invited the operator to pick. On a view with no rows
 * at all it offered every value it had ever seen.
 *
 * The time window is applied here like any other axis, and it is the axis that
 * made this visible: a window that excluded everything left the bar offering
 * fifteen values that each led to the same empty page.
 *
 * The axis's own current selection is always kept in its list. Dropping it would
 * leave the `<select>` showing a value the page did not offer, and changing
 * another axis would then silently change the one already chosen.
 *
 * A prompt-less row matches any prompt filter -- `promptName` is optional on the
 * wire, and a row that reports no prompt is not evidence that it ran under some
 * other prompt. It contributes no prompt *option*, though, because there is no
 * value to offer for a row that reported none.
 */
export function filterOptionsFor(
  evaluations: readonly EvaluationResult[],
  filters: EvaluationsFilters = EMPTY_EVALUATIONS_FILTERS
): EvaluationsFilterOptions {
  const from = resolveUtcDayBound(filters.from);
  const until = resolveUtcDayEnd(filters.until);

  const offered = (
    axis: OptionAxis,
    selected: string,
    value: (evaluation: EvaluationResult) => string | undefined
  ): readonly string[] => {
    const scope = withoutAxis(filters, axis);
    const values = new Set<string>();
    for (const evaluation of evaluations) {
      if (!matchesTarget(evaluation, scope)) continue;
      if (runTimeVerdict(evaluation, from, until) !== "inside") continue;
      const candidate = value(evaluation);
      if (candidate !== undefined && candidate !== "") values.add(candidate);
    }
    if (selected !== "") values.add(selected);
    return [...values].sort((left, right) =>
      OPTION_COLLATOR.compare(left, right)
    );
  };

  return {
    roles: offered("role", filters.role, (evaluation) => evaluation.agentRole),
    models: offered("model", filters.model, (evaluation) => evaluation.model),
    prompts: offered("prompt", filters.prompt, reportedPrompt)
  };
}
