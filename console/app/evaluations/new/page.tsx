import { EVALUATION_CRITERION_TYPES } from "@simulatorlife/autodev-core";
import React from "react";

import { EvaluationDefinitionEditor } from "../../../src/features/evaluations/EvaluationDefinitionEditor.ts";
import { createEvaluationForm } from "../../../src/lib/server/evaluation-actions.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.tsx";

export const dynamic = "force-dynamic";

/** Field skeleton for a new definition; every value must be filled in. */
const DEFINITION_SKELETON = JSON.stringify(
  {
    id: "",
    name: "",
    description: null,
    enabled: true,
    targets: [{ kind: "agent", id: "", prompt: null }],
    criteria: [{ type: "", threshold: 0.5 }],
    cases: [{ id: "", input: "", context: null }],
    judge: { model: "" }
  },
  null,
  2
);

export default function NewEvaluationPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/evaluations");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to create evaluation definitions."
      })
    );
  }
  const form = createEvaluationForm(
    { action: "save", definitionId: "", expectedRevision: "" },
    config.serviceToken
  );
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "a",
        {
          href: "/evaluations",
          className: "text-xs text-slate-400 hover:underline"
        },
        "← Evaluations"
      ),
      React.createElement(EvaluationDefinitionEditor, {
        initialText: DEFINITION_SKELETON,
        definitionId: form.definitionId,
        expectedRevision: form.expectedRevision,
        formToken: form.formToken,
        criterionTypes: EVALUATION_CRITERION_TYPES,
        cancelHref: "/evaluations"
      })
    )
  );
}
