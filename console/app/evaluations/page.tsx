import React from "react";

import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Evaluations resource view.
 *
 * The retained OpenLIT evaluation adapter is not yet integrated with the
 * AutoDev Control API. The route therefore renders an explicit unavailable
 * state instead of fabricating evaluation results.
 */
export default function EvaluationsPage(): React.JSX.Element {
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
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(ResourceUnavailable, {
      title: "Evaluation adapters are not wired into the Console",
      code: "autodev_evaluation_adapter_pending",
      message:
        "Retained OpenLIT evaluation execution and result-history adapters are not yet integrated with the Control API.",
      hint: "Once the adapter exists, Evaluations will show definition/suite/run/history scoped to AutoDev agents and prompts."
    })
  );
}
