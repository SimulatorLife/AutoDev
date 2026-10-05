import { isOpenTelemetrySpanId } from "@simulatorlife/autodev-core";
import React from "react";

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
    default: {
      return { kind: "unavailable" };
    }
  }
}

/**
 * Evaluations resource view.
 *
 * Direct resource evaluation definition and result-history view reading from
 * the AutoDev Control API `/control/evaluations` endpoint backed by ClickHouse.
 */
export default async function EvaluationsPage({
  searchParams
}: EvaluationsPageProps): Promise<React.JSX.Element> {
  const params = searchParams ? await searchParams : {};
  const promptFilter = firstQueryValue(params.prompt)?.slice(0, 256);
  const spanIdValues = params.spanId;
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

  const evaluations = promptFilter
    ? result.data.evaluations.filter(
        (evaluation) => evaluation.promptName === promptFilter
      )
    : result.data.evaluations;
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
      ...(promptFilter ? { promptFilter } : {}),
      ...(traceLookup ? { traceLookup } : {})
    })
  );
}
