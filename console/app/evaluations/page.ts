import { isOpenTelemetrySpanId } from "@simulatorlife/autodev-core";
import React from "react";

import {
  EVALUATION_RESULT_PARAM,
  EVALUATION_SPAN_PARAM,
  EVALUATIONS_PAGE_PARAM,
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
export default async function EvaluationsPage({
  searchParams
}: EvaluationsPageProps): Promise<React.JSX.Element> {
  const params = searchParams ? await searchParams : {};
  const filters = parseEvaluationsFilters(params);
  const tab = resolveEvaluationsTab(params.tab);
  const page = resolveEvaluationsPage(params[EVALUATIONS_PAGE_PARAM]);
  // A repeated key is not a choice, so neither selection resolves to the first
  // of several. `?result=a&result=b` used to open `a` while the URL described
  // two runs, and the filter bar's own rule already refused to do that to a
  // filter -- the page and the module it depends on were answering the same
  // question two different ways.
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
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read evaluation definitions."
      })
    );
  }

  const result = await fetchEvaluations(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Evaluations could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const available = result.data.evaluations;
  const placed = filterEvaluations(available, filters);
  const evaluations = placed.results;
  // The read is capped, so a window older than everything it returned was never
  // read. Only this page knows both halves of that fact -- what it asked for and
  // what it got back -- so it answers the question here rather than leaving the
  // view to render an unread window as an empty history.
  const unread = unreadWindow(available, filters, result.data.truncated);

  let traceLookup: EvaluationTraceLookup | null = null;
  if (spanIdValues !== undefined) {
    traceLookup = hasInvalidSpanSelection
      ? { kind: "invalid-span-id" }
      : evaluationTraceState(await loadOpenLITTrace(requestedSpanId!));
  }

  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The store's own size, not the narrowed window. The sidebar describes the
      // resource, so it was reading as though a filter emptied it: on
      // `?role=nobody` the badge said "Evaluations (0)" while the card above it
      // said 5,000 retained, and two numbers for one resource on one screen with
      // nothing saying which was which. This is the same correction the
      // retained-results card needed, in the last place on this page that was
      // still reporting the window as the whole. The window and the narrowing
      // are already stated three times, all labelled, inside the page.
      counts: { Evaluations: result.data.totalEvaluations }
    },
    React.createElement(EvaluationsView, {
      evaluations,
      availableCount: available.length,
      // The store's own size, not the size of the window this read returned.
      // The filter summary states a narrowing against it, and a window that
      // reported itself as the whole history would make that summary wrong.
      totalCount: result.data.totalEvaluations,
      truncated: result.data.truncated,
      filters,
      filterOptions: filterOptionsFor(available, filters),
      tab,
      page,
      ...(placed.unplaceable === 0 ? {} : { unplaceable: placed.unplaceable }),
      ...(placed.promptless === 0 ? {} : { promptless: placed.promptless }),
      ...(unread === undefined ? {} : { oldestReadAt: unread.oldestReadAt }),
      ...(selectedResult === undefined ? {} : { selection: selectedResult }),
      ...(traceLookup ? { traceLookup } : {})
    })
  );
}
