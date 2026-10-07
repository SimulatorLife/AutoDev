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

export const EVALUATIONS_ROUTE = "/evaluations";

/**
 * How an evaluation's own verdict reads. `Not observed` is the third state, not
 * a synonym for failure: the target state requires a result to be passed or
 * failed only when its source supplies an explicit verdict, so a filter that
 * cannot separate "failed" from "never answered" cannot answer the question an
 * operator is actually asking.
 */
export type EvaluationOutcomeFilter =
  "all" | "passed" | "failed" | "not-observed";

export const EVALUATION_OUTCOME_FILTERS: readonly EvaluationOutcomeFilter[] = [
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

export const EMPTY_EVALUATIONS_FILTERS: EvaluationsFilters = {
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
export function resolveUtcDayBound(value: RawQueryValue): number | undefined {
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
export function resolveUtcDayEnd(value: RawQueryValue): number | undefined {
  const start = resolveUtcDayBound(value);
  return start === undefined ? undefined : start + 86_400_000;
}

/** Query keys that carry a selection rather than a filter. */
export const EVALUATION_RESULT_PARAM = "result";
export const EVALUATION_SPAN_PARAM = "spanId";
export const EVALUATIONS_PAGE_PARAM = "page";

export type RawQueryValue = string | readonly string[] | undefined;

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

export function resolveOutcomeFilter(
  value: RawQueryValue
): EvaluationOutcomeFilter {
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
export interface EvaluationsSelection {
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

export const NO_SELECTION: EvaluationsSelection = {
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
export const FIRST_EVALUATIONS_PAGE = 1;

/**
 * A page number, as a shape rather than a range check.
 *
 * A page is an address, and this rejects everything that is not one: an empty
 * value, a sign, a decimal, and a run of digits long enough to be a request to
 * render a page nobody could page to. A repeated key is already resolved to
 * "not set" by `singleValue` before this sees it.
 */
const PAGE_NUMBER = /^[1-9][0-9]{0,4}$/u;

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

/** The list without any narrowing, which is where "Clear filters" goes. */
export function evaluationsUnfilteredHref(): string {
  return EVALUATIONS_ROUTE;
}

/**
 * One result, opened from the history table.
 *
 * The filter state travels with it so the drawer's close link returns the
 * operator to the list they narrowed, not to an unfiltered page that no longer
 * contains the row they were reading.
 */
export function evaluationResultHref(
  filters: EvaluationsFilters,
  resultId: string,
  tab: EvaluationsTabId = DEFAULT_EVALUATIONS_TAB
): string {
  return evaluationsHref(filters, { tab, resultId });
}

/**
 * The trace for one span, keeping the filters.
 *
 * A trace is a property of the run that produced it, so opening one from a
 * filtered list must not silently widen the list the operator is reading.
 */
export function evaluationTraceHref(
  filters: EvaluationsFilters,
  spanId: string,
  tab: EvaluationsTabId = DEFAULT_EVALUATIONS_TAB
): string {
  return evaluationsHref(filters, { tab, spanId });
}

/** One section of the resource, keeping the filters. */
export function evaluationsTabHref(
  filters: EvaluationsFilters,
  tab: EvaluationsTabId
): string {
  return evaluationsHref(filters, { tab });
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
export interface PlacedEvaluations {
  readonly results: readonly EvaluationResult[];
  readonly unplaceable: number;
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
  for (const evaluation of evaluations) {
    if (!matchesTarget(evaluation, filters)) continue;
    const verdict = runTimeVerdict(evaluation, from, until);
    if (verdict === RUN_UNPLACEABLE) {
      unplaceable += 1;
      continue;
    }
    if (verdict === RUN_OUTSIDE) continue;
    results.push(evaluation);
  }
  return { results, unplaceable };
}

/**
 * Every categorical axis at once: what the run evaluated, and how it came out.
 *
 * A prompt-less row still matches a prompt filter. `promptName` is optional on
 * the wire, and a row that reports no prompt is not evidence that it ran under
 * some other prompt, so dropping it from a filtered view would report a smaller
 * history than the source holds.
 */
function matchesTarget(
  evaluation: EvaluationResult,
  filters: EvaluationsFilters
): boolean {
  if (!matchesOutcome(evaluation, filters.outcome)) return false;
  if (filters.role !== "" && evaluation.agentRole !== filters.role)
    return false;
  if (filters.model !== "" && evaluation.model !== filters.model) return false;
  return (
    filters.prompt === "" ||
    evaluation.promptName === undefined ||
    evaluation.promptName === filters.prompt
  );
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
    prompts: offered(
      "prompt",
      filters.prompt,
      (evaluation) => evaluation.promptName
    )
  };
}
