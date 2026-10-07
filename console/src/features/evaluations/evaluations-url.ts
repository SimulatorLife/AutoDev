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
}

export const EMPTY_EVALUATIONS_FILTERS: EvaluationsFilters = {
  outcome: "all",
  role: "",
  model: "",
  prompt: ""
};

/** Query keys that carry a selection rather than a filter. */
export const EVALUATION_RESULT_PARAM = "result";
export const EVALUATION_SPAN_PARAM = "spanId";

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
    prompt: bounded(singleValue(params.prompt))
  };
}

/** True when nothing is narrowed, which is what the "clear" affordance checks. */
export function hasActiveFilters(filters: EvaluationsFilters): boolean {
  return (
    filters.outcome !== "all" ||
    filters.role !== "" ||
    filters.model !== "" ||
    filters.prompt !== ""
  );
}

function filtersParams(filters: EvaluationsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.outcome !== "all") params.set("outcome", filters.outcome);
  if (filters.role !== "") params.set("role", filters.role);
  if (filters.model !== "") params.set("model", filters.model);
  if (filters.prompt !== "") params.set("prompt", filters.prompt);
  return params;
}

/** One selection at a time: an open run, or the trace it links to. */
export interface EvaluationsSelection {
  readonly tab: EvaluationsTabId;
  readonly resultId?: string | undefined;
  readonly spanId?: string | undefined;
}

export const NO_SELECTION: EvaluationsSelection = {
  tab: DEFAULT_EVALUATIONS_TAB
};

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
 * Narrow already-fetched results by the parsed filters.
 *
 * This runs on the page, after the single bounded Control API read, rather than
 * becoming a second query axis in the API: the read is already capped at the
 * most recent N results, so filtering server-side could only narrow the cap
 * without making the total any more honest. The trade is stated here because it
 * is a real one -- the pass rate and the totals describe the fetched window,
 * not the whole store.
 */
export function filterEvaluations(
  evaluations: readonly EvaluationResult[],
  filters: EvaluationsFilters
): readonly EvaluationResult[] {
  return evaluations.filter(
    (evaluation) =>
      matchesOutcome(evaluation, filters.outcome) &&
      (filters.role === "" || evaluation.agentRole === filters.role) &&
      (filters.model === "" || evaluation.model === filters.model) &&
      (filters.prompt === "" ||
        evaluation.promptName === undefined ||
        evaluation.promptName === filters.prompt)
  );
}

/**
 * The distinct values a filter axis can narrow on, for the filter options.
 *
 * Taken from the results actually on the page. An option the operator can pick
 * but that no row matches is a control that reports an empty history it
 * manufactured, so the axis offers exactly the values that occur.
 *
 * A prompt-less row matches any prompt filter. `promptName` is optional on the
 * wire, and a row that reports no prompt is not evidence that it ran under some
 * other prompt, so dropping it from a filtered view would report a smaller
 * history than the source holds.
 */
export /**
 * One collator for every ordering here.
 *
 * `localeCompare` constructs an `Intl.Collator` on each call, and these sorts run
 * on every render of the filter options. Hoisting keeps the ordering identical
 * and the construction off the render path.
 */
const OPTION_COLLATOR = new Intl.Collator("en");

export function filterOptionsFor(
  evaluations: readonly EvaluationResult[]
): Readonly<{
  roles: readonly string[];
  models: readonly string[];
  prompts: readonly string[];
}> {
  const roles = new Set<string>();
  const models = new Set<string>();
  const prompts = new Set<string>();
  for (const evaluation of evaluations) {
    roles.add(evaluation.agentRole);
    models.add(evaluation.model);
    if (evaluation.promptName !== undefined && evaluation.promptName !== "") {
      prompts.add(evaluation.promptName);
    }
  }
  const sorted = (values: Set<string>): readonly string[] =>
    [...values].sort((left, right) => OPTION_COLLATOR.compare(left, right));
  return {
    roles: sorted(roles),
    models: sorted(models),
    prompts: sorted(prompts)
  };
}
