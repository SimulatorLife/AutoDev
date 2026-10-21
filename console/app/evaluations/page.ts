import {
  type CanonicalNavSection,
  isOpenTelemetrySpanId
} from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import {
  EVALUATION_RESULT_PARAM,
  EVALUATION_SPAN_PARAM,
  EVALUATIONS_PAGE_PARAM,
  type EvaluationsFilters,
  type EvaluationsTabId,
  filterEvaluations,
  filterOptionsFor,
  parseEvaluationsFilters,
  resolveEvaluationsPage,
  resolveEvaluationsTab,
  singleValue,
  unreadWindow
} from "../../src/features/evaluations/evaluations-url.ts";
import {
  EvaluationsView,
  type EvaluationTraceLookup
} from "../../src/features/evaluations/EvaluationsView.ts";
import {
  controlApiFailureCode,
  fetchEvaluations
} from "../../src/lib/server/control-api.ts";
import { loadOpenLITTrace } from "../../src/lib/server/openlit-usage.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

interface EvaluationsPageProps {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}

function evaluationTraceState(
  result: Awaited<ReturnType<typeof loadOpenLITTrace>>
): EvaluationTraceLookup {
  switch (result.kind) {
    case "ok": {
      return { kind: "observed", detail: result.data };
    }
    case "invalid-span-id": {
      return { kind: "invalid-span-id" };
    }
    case "not-found": {
      return { kind: "not-found" };
    }
    case "not-configured": {
      return { kind: "not-configured" };
    }
    case "unauthorized": {
      return { kind: "unauthorized" };
    }
    case "http-error": {
      return { kind: "http-error", status: result.status };
    }
    default: {
      return { kind: "unavailable" };
    }
  }
}

/**
 * Evaluations resource view.
 *
 * One bounded read of the AutoDev Control API `/control/evaluations` endpoint,
 * then narrowing on the page. Filters, the open section, the open run, and the
 * open trace are all query parameters, so the whole surface is addressable
 * without JavaScript and every link can state what it preserves.
 */
export const metadata: Metadata = {
  title: "Evaluations"
};

function renderEvaluationsFailure(
  section: CanonicalNavSection,
  result: Exclude<Awaited<ReturnType<typeof fetchEvaluations>>, { kind: "ok" }>
): React.JSX.Element {
  const isTimeout = result.kind === "unreachable" && result.timedOut === true;
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ResourceUnavailable, {
      title: isTimeout
        ? "Evaluations timed out"
        : "Evaluations could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message,
      ...(isTimeout
        ? {
            hint: "The Control API accepted the read and did not answer before the Console gave up. Check whether the evaluations query is slow against the telemetry store."
          }
        : {})
    })
  );
}

function resolveTraceLookup(
  spanIdValues: string | readonly string[] | undefined,
  hasInvalidSpanSelection: boolean,
  traceLookupResult: Awaited<ReturnType<typeof loadOpenLITTrace>> | null
): EvaluationTraceLookup | null {
  if (spanIdValues === undefined) return null;
  return hasInvalidSpanSelection
    ? { kind: "invalid-span-id" }
    : evaluationTraceState(traceLookupResult!);
}

export default async function EvaluationsPage({
  searchParams
}: EvaluationsPageProps): Promise<React.JSX.Element> {
  const params = searchParams ? await searchParams : {};
  const filters = parseEvaluationsFilters(params);
  const tab = resolveEvaluationsTab(params.tab);
  const page = resolveEvaluationsPage(params[EVALUATIONS_PAGE_PARAM]);
  const selectedResult = singleValue(params[EVALUATION_RESULT_PARAM]);

  const spanIdValues = params[EVALUATION_SPAN_PARAM];
  const requestedSpanId = singleValue(spanIdValues);
  const hasInvalidSpanSelection =
    spanIdValues !== undefined && !isOpenTelemetrySpanId(requestedSpanId);

  const { section, config } = readNodeContext("/evaluations");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("evaluation results")
    );
  }

  // The reads start here and are not awaited.
  const result = fetchEvaluations(config);
  const traceLookupResult =
    spanIdValues !== undefined && !hasInvalidSpanSelection
      ? loadOpenLITTrace(requestedSpanId!)
      : Promise.resolve(null);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(EvaluationsContent, {
      section,
      result,
      traceLookupResult,
      filters,
      tab,
      page,
      selectedResult,
      spanIdValues,
      requestedSpanId,
      hasInvalidSpanSelection
    })
  );
}

/**
 * The retained evaluation results the Runtime confirmed, or the reason it
 * could not answer.
 *
 * The reads are awaited here, inside the page's own pending boundary. The
 * shell is rendered by the same component that read the data, so the
 * navigation's count arrives with the read instead of being resolved in the
 * browser.
 */
async function EvaluationsContent({
  section,
  result,
  traceLookupResult,
  filters,
  tab,
  page,
  selectedResult,
  spanIdValues,
  requestedSpanId,
  hasInvalidSpanSelection
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchEvaluations>>>;
  readonly traceLookupResult: Promise<Awaited<
    ReturnType<typeof loadOpenLITTrace>
  > | null>;
  readonly filters: EvaluationsFilters;
  readonly tab: EvaluationsTabId;
  readonly page: number;
  readonly selectedResult: string | undefined;
  readonly spanIdValues: string | readonly string[] | undefined;
  readonly requestedSpanId: string | undefined;
  readonly hasInvalidSpanSelection: boolean;
}): Promise<React.JSX.Element> {
  const [settled, traceLookupSettled] = await Promise.all([
    result,
    traceLookupResult
  ]);
  if (settled.kind !== "ok") {
    return renderEvaluationsFailure(section, settled);
  }

  const available = settled.data.evaluations;
  const placed = filterEvaluations(available, filters);
  const evaluations = placed.results;
  const unread = unreadWindow(available, filters, settled.data.truncated);
  const traceLookup = resolveTraceLookup(
    spanIdValues,
    hasInvalidSpanSelection,
    traceLookupSettled
  );

  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Retained evaluation results, metric breakdowns, and linked OpenTelemetry traces.",
      // The store's own size, not the narrowed window. The sidebar describes the
      // resource, so it was reading as though a filter emptied it: on
      // `?role=nobody` the badge said "Evaluations (0)" while the card above it
      // said 5,000 retained, and two numbers for one resource on one screen with
      // nothing saying which was which. This is the same correction the
      // retained-results card needed, in the last place on this page that was
      // still reporting the window as the whole. The window and the narrowing
      // are already stated three times, all labelled, inside the page.
      counts: { Evaluations: settled.data.totalEvaluations }
    },
    React.createElement(EvaluationsView, {
      evaluations,
      availableCount: available.length,
      // The store's own size, not the size of the window this read returned.
      // The filter summary states a narrowing against it, and a window that
      // reported itself as the whole history would make that summary wrong.
      totalCount: settled.data.totalEvaluations,
      truncated: settled.data.truncated,
      filters,
      filterOptions: filterOptionsFor(available, filters),
      tab,
      page,
      ...(placed.unplaceable === 0 ? {} : { unplaceable: placed.unplaceable }),
      ...(placed.promptless === 0 ? {} : { promptless: placed.promptless }),
      ...(unread === undefined ? {} : { oldestReadAt: unread.oldestReadAt }),
      ...(selectedResult === undefined ? {} : { selection: selectedResult }),
      // Only a span id the page accepts. A URL can name one that is not a span
      // id, and the trace panel already says so; carrying it into every link
      // would spread a selection the page has declared unreadable across the
      // page, and the one link that must keep it -- the drawer's close -- would
      // then be keeping something meaningless.
      ...(hasInvalidSpanSelection || requestedSpanId === undefined
        ? {}
        : { spanId: requestedSpanId }),
      ...(traceLookup ? { traceLookup } : {})
    })
  );
}
