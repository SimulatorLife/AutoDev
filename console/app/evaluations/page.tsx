import React from "react";

import { EvaluationsView } from "../../src/features/evaluations/EvaluationsView.ts";
import {
  controlApiFailureCode,
  fetchEvaluations
} from "../../src/lib/server/control-api.ts";
import {
  evaluationFilterFromSearchParams,
  evaluationNoticeFromSearchParams,
  type EvaluationSearchParams,
  loadEvaluationResultSelection
} from "../../src/lib/server/evaluation-pages.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Evaluations resource: canonical definitions (`config/evaluations.json`),
 * runs, and URL-filterable result history from the Control API
 * `/control/evaluations` family, with per-result trace linkage.
 */
export default async function EvaluationsPage({
  searchParams
}: {
  readonly searchParams: Promise<EvaluationSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const { section, config } = readNodeContext("/evaluations");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read evaluation definitions and results."
      })
    );
  }

  const result = await fetchEvaluations(
    evaluationFilterFromSearchParams(params),
    config
  );
  if (result.kind !== "ok") {
    const staleRuntime =
      result.kind === "http-error" &&
      (result.code === "autodev_control_api_unknown_path" ||
        result.code === "autodev_control_api_schema_mismatch");
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Evaluations could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message,
        ...(staleRuntime
          ? {
              hint: "The running AutoDev Runtime predates the evaluation Control API. Reinstall (pnpm install:codex) and restart the router."
            }
          : {})
      })
    );
  }

  const selection = await loadEvaluationResultSelection(params, config);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts:
        result.data.catalogStatus === "valid"
          ? { Evaluations: result.data.definitions.length }
          : undefined
    },
    React.createElement(EvaluationsView, {
      data: result.data,
      notice: evaluationNoticeFromSearchParams(params).notice,
      ...selection
    })
  );
}
