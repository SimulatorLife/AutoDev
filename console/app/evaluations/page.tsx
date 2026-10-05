import React from "react";

import { EvaluationsView } from "../../src/features/evaluations/EvaluationsView.ts";
import {
  controlApiFailureCode,
  fetchEvaluations,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Evaluations resource view.
 *
 * Direct resource evaluation definition and result-history view reading from
 * the AutoDev Control API `/control/evaluations` endpoint backed by ClickHouse.
 */
export default async function EvaluationsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read evaluation definitions."
    });
  }

  const result = await fetchEvaluations(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Evaluations could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }

  return React.createElement(EvaluationsView, {
    evaluations: result.data.evaluations
  });
}
