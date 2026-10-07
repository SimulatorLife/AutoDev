import type { ControlApiMemoryInjectionOutcomeJoin } from "@simulatorlife/autodev-core";
import {
  EXPERIENCE_OUTCOMES,
  MEMORY_EVIDENCE_KINDS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_USE_KINDS
} from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MUTED_TEXT_CLASS } from "../../components/ui/text-classes.ts";
import { codeOptions } from "./memory-code-options.ts";
import {
  MEMORY_EVIDENCE_KIND_LABEL,
  MEMORY_OUTCOME_LABEL,
  MEMORY_REPORT_KIND_LABEL,
  MEMORY_USE_KIND_LABEL
} from "./memory-status.ts";
import { memoryListQuery, type MemoryListScope } from "./memory-list-url.ts";

/**
 * What a person may assert about one observed injection.
 *
 * Two forms, because these are two claims with different authors and different
 * rules. An outcome is a *reporter's* statement about the task; a use
 * assessment is a *curator's* judgement about whether the packet was used.
 * Filing both on one form would let an operator answer "did this help?" by
 * filling in what the task did.
 *
 * Both live on the injection row rather than on the experience header, because
 * both claims are per-injection: the Runtime binds an outcome to a correlation
 * token minted for one injection, and a use assessment to an injection event
 * id. A form that reported against the experience would have to pick one, and
 * picking silently is how a report ends up bound to the wrong evidence.
 *
 * The correlation token rides in a hidden field. It is content-free by design,
 * and `MemoryService.recordOutcomeReport` re-resolves it against the reporter's
 * trusted session scope, so a form cannot bind a report to an injection it does
 * not belong to — a wrong token fails closed rather than mis-binding.
 *
 * A form is not offered once its report exists. The Runtime binds one report
 * per injection, so offering a second would be offering a submission it will
 * refuse.
 */
export function InjectionReports({
  injection,
  listScope,
  experienceId,
  alreadyReported,
  useAssessment
}: {
  readonly injection: ControlApiMemoryInjectionOutcomeJoin["injection"];
  readonly listScope: MemoryListScope;
  readonly experienceId: string;
  readonly alreadyReported: boolean;
  readonly useAssessment: { readonly useKind: string } | null;
}): React.JSX.Element {
  const carried = [
    hidden("experienceId", experienceId),
    hidden("workspaceId", listScope.workspaceId),
    // The list this report was made on, so the redirect lands back inside the
    // filters the operator was working in.
    hidden("returned", memoryListQuery(listScope))
  ];

  const form = (
    action: "report-outcome" | "report-use",
    label: string,
    testId: string,
    controls: readonly React.JSX.Element[]
  ): React.JSX.Element =>
    React.createElement(
      "form",
      {
        method: "POST",
        action: "/api/memory",
        className: "flex flex-wrap items-end gap-2"
      },
      ...carried,
      hidden("action", action),
      ...controls,
      React.createElement(
        Button,
        { type: "submit", variant: "secondary", testId },
        label
      )
    );

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-2 mt-2 pt-2 border-t border-border",
      "data-injection-reports": injection.id
    },
    alreadyReported
      ? React.createElement(
          "span",
          { className: MUTED_TEXT_CLASS },
          "An outcome is already reported for this injection; the Runtime binds one report per injection."
        )
      : form(
          "report-outcome",
          "Report outcome",
          `memory-report-outcome-${injection.id}`,
          [
            hidden("correlationToken", injection.correlationToken),
            React.createElement(SelectField, {
              name: "outcomeKind",
              label: "Outcome:",
              hideLabel: true,
              testId: `memory-report-outcome-kind-${injection.id}`,
              options: codeOptions(EXPERIENCE_OUTCOMES, {
                ...MEMORY_OUTCOME_LABEL,
                unknown: NOT_OBSERVED_LABEL
              })
            }),
            React.createElement(SelectField, {
              name: "reportKind",
              label: "Reported as:",
              hideLabel: true,
              testId: `memory-report-kind-${injection.id}`,
              options: codeOptions(
                MEMORY_OUTCOME_REPORT_KINDS,
                MEMORY_REPORT_KIND_LABEL
              )
            }),
            ...evidenceControls(`outcome-${injection.id}`)
          ]
        ),
    useAssessment === null
      ? form("report-use", "Assess use", `memory-report-use-${injection.id}`, [
          hidden("injectionEventId", injection.id),
          React.createElement(SelectField, {
            name: "useKind",
            label: "Used:",
            hideLabel: true,
            testId: `memory-report-use-kind-${injection.id}`,
            options: codeOptions(MEMORY_USE_KINDS, MEMORY_USE_KIND_LABEL)
          }),
          React.createElement(TextField, {
            name: "usedMemoryIds",
            id: `memory-used-ids-${injection.id}`,
            label: "Memories cited as used, comma separated",
            hideLabel: true,
            // The injected set is the bound on this answer: a `used` verdict
            // must cite all of them and `not_used` none, which the Runtime
            // enforces. Showing them turns that rule into something an
            // operator can satisfy rather than trip over.
            placeholder: injection.memoryIds.join(", "),
            testId: `memory-used-ids-${injection.id}`
          }),
          ...evidenceControls(`use-${injection.id}`)
        ])
      : React.createElement(
          "span",
          { className: MUTED_TEXT_CLASS },
          `A curator has already assessed this injection as ${useAssessment.useKind}.`
        )
  );
}

function hidden(name: string, value: string): React.JSX.Element {
  return React.createElement("input", {
    key: name,
    type: "hidden",
    name,
    value
  });
}

/**
 * The evidence reference every report must carry.
 *
 * The Runtime refuses a non-`unknown` outcome that has none, so this control
 * is part of the form rather than an optional field beside it. A URI alone is
 * not enough: the kind is what says whether this is a trajectory, a test run,
 * or a pull request, and an untyped reference is not evidence of anything in
 * particular.
 *
 * The kinds are Core's, because that is the list the Runtime checks an evidence
 * reference against — a copy written out here could offer a kind it refuses, and
 * would silently stop offering one it had gained.
 */
function evidenceControls(suffix: string): readonly React.JSX.Element[] {
  return [
    React.createElement(SelectField, {
      name: "evidenceKind",
      label: "Evidence:",
      hideLabel: true,
      testId: `memory-evidence-kind-${suffix}`,
      options: codeOptions(MEMORY_EVIDENCE_KINDS, MEMORY_EVIDENCE_KIND_LABEL)
    }),
    React.createElement(TextField, {
      name: "evidenceUri",
      id: `memory-evidence-uri-${suffix}`,
      label: "Evidence URI",
      hideLabel: true,
      placeholder: "Where the evidence lives",
      testId: `memory-evidence-uri-${suffix}`
    })
  ];
}
