import {
  EVALUATION_CRITERION_TYPES,
  isEvaluationDefinitionId
} from "@simulatorlife/autodev-core";
import { notFound } from "next/navigation";
import React from "react";

import { EvaluationDetailView } from "../../../src/features/evaluations/EvaluationDetailView.ts";
import {
  controlApiFailureCode,
  fetchEvaluationDetail
} from "../../../src/lib/server/control-api.ts";
import { createEvaluationForm } from "../../../src/lib/server/evaluation-actions.ts";
import {
  evaluationNoticeFromSearchParams,
  type EvaluationSearchParams,
  firstParam,
  loadEvaluationResultSelection
} from "../../../src/lib/server/evaluation-pages.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../../_console.tsx";

export const dynamic = "force-dynamic";

/**
 * Canonical edit surface for one evaluation definition: targets, criteria,
 * cases, runs, target comparisons, case matrix, results, and trace linkage.
 */
export default async function EvaluationDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<EvaluationSearchParams>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const query = await searchParams;
  if (!isEvaluationDefinitionId(id)) notFound();
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

  const result = await fetchEvaluationDetail(
    id,
    firstParam(query, "run"),
    config
  );
  if (
    result.kind === "http-error" &&
    result.code === "autodev_control_api_unknown_evaluation"
  ) {
    notFound();
  }
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Evaluation definition could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }

  const detail = result.data;
  const secret = config.serviceToken;
  const { notice, code } = evaluationNoticeFromSearchParams(query);
  const selection = await loadEvaluationResultSelection(query, config);
  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(EvaluationDetailView, {
      detail,
      criterionTypes: EVALUATION_CRITERION_TYPES,
      editing: firstParam(query, "edit") === "1",
      notice,
      noticeCode: code,
      forms: {
        run:
          detail.definition.enabled && detail.validation.runnable
            ? createEvaluationForm(
                { action: "run", definitionId: id, expectedRevision: "" },
                secret
              )
            : null,
        remove: createEvaluationForm(
          {
            action: "delete",
            definitionId: id,
            expectedRevision: detail.revision
          },
          secret
        ),
        save: createEvaluationForm(
          {
            action: "save",
            definitionId: id,
            expectedRevision: detail.revision
          },
          secret
        )
      },
      ...selection
    })
  );
}
