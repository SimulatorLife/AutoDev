import { isOpenTelemetrySpanId } from "@simulatorlife/autodev-core";
import React from "react";

import {
  EVALUATION_RESULT_PARAM,
  EVALUATION_SPAN_PARAM,
  filterEvaluations,
  filterOptionsFor,
  parseEvaluationsFilters,
  resolveEvaluationsTab
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

function firstQueryValue(
  value: string | readonly string[] | undefined
): string | undefined {
  if (typeof value === "string") return value;
  return value?.[0];
}

function singleQueryValue(
  value: string | readonly string[] | undefined
): string | undefined {
  if (typeof value === "string") return value;
  return value?.length === 1 ? value[0] : undefined;
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
  const selectedResult = firstQueryValue(params[EVALUATION_RESULT_PARAM]);

  const spanIdValues = params[EVALUATION_SPAN_PARAM];
  const requestedSpanId = singleQueryValue(spanIdValues);
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
  const evaluations = filterEvaluations(available, filters);

  let traceLookup: EvaluationTraceLookup | null = null;
  if (spanIdValues !== undefined) {
    traceLookup = hasInvalidSpanSelection
      ? { kind: "invalid-span-id" }
      : evaluationTraceState(await loadOpenLITTrace(requestedSpanId!));
  }

  return React.createElement(
    ConsolePageShell,
    { section, counts: { Evaluations: evaluations.length } },
    React.createElement(EvaluationsView, {
      evaluations,
      availableCount: available.length,
      // The store's own size, not the size of the window this read returned.
      // The filter summary states a narrowing against it, and a window that
      // reported itself as the whole history would make that summary wrong.
      totalCount: result.data.totalEvaluations,
      truncated: result.data.truncated,
      filters,
      filterOptions: filterOptionsFor(available),
      tab,
      ...(selectedResult === undefined ? {} : { selection: selectedResult }),
      ...(traceLookup ? { traceLookup } : {})
    })
  );
}
