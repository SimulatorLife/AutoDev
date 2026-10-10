import {
  type ControlApiMemorySessionOutcomeReportResponse,
  EXPERIENCE_OUTCOMES,
  MEMORY_EVIDENCE_KINDS,
  MEMORY_OUTCOME_REPORT_KINDS
} from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { MUTED_TEXT_CLASS } from "../../components/ui/text-classes.ts";
import { codeOptions } from "./memory-code-options.ts";
import { memoryListQuery, type MemoryListScope } from "./memory-list-url.ts";
import {
  MEMORY_EVIDENCE_KIND_LABEL,
  MEMORY_OUTCOME_LABEL,
  MEMORY_REPORT_KIND_LABEL
} from "./memory-status.ts";

type SessionOutcome = ControlApiMemorySessionOutcomeReportResponse["report"];

/**
 * What a reporter stated about the session as a whole.
 *
 * This is a different claim from the per-injection outcome and use assessment
 * that sit on each packet below, and the target state asks for exactly that
 * separation: observed packet evidence on one side, reporter-supplied task and
 * session outcomes on the other, never merged into one score. So it lives on the
 * experience rather than on any single injection — it is about the session, not
 * about one packet attached to it.
 *
 * Three states, kept apart because two of them are easy to render as each other:
 *
 * - **absent** (`undefined`) — the read did not succeed. Nothing is claimed, and
 *   no form is offered: offering one here would invite a report into a panel
 *   that cannot show whether a session already has an outcome.
 * - **none** (`null`) — the read succeeded and the Runtime says no report exists.
 *   That is an observed fact about the session, and the form is offered.
 * - **a report** — the claim, with who filed it and what it rested on.
 *
 * A form is not offered once a report exists. The Runtime binds one report per
 * session and treats a second, different one as a conflict rather than a
 * replacement, so a second form would be a submission guaranteed to fail.
 */
export function MemorySessionOutcome({
  report,
  listScope,
  experienceId
}: {
  readonly report: SessionOutcome | null | undefined;
  readonly listScope: MemoryListScope;
  readonly experienceId: string;
}): React.JSX.Element {
  if (report === undefined) {
    return React.createElement(
      "div",
      {
        className: "flex flex-col gap-2",
        "data-session-outcome": experienceId
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Session outcome"
      ),
      React.createElement(
        "p",
        { className: MUTED_TEXT_CLASS, "data-status": "unavailable" },
        "The session outcome was not read; nothing is inferred about it."
      )
    );
  }

  if (report !== null) {
    return React.createElement(
      "div",
      {
        className: "flex flex-col gap-2",
        "data-session-outcome": experienceId
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Session outcome"
      ),
      React.createElement(
        "p",
        { className: "text-sm" },
        React.createElement(
          "span",
          { className: DETAIL_LABEL_CLASS },
          "Outcome: "
        ),
        outcomeLabel(report.outcomeKind)
      ),
      React.createElement(
        "p",
        { className: "text-xs" },
        React.createElement(
          "span",
          { className: DETAIL_LABEL_CLASS },
          "Reported as: "
        ),
        `${reportKindLabel(report.reportKind)} by ${report.reporterId} at ${report.reportedAt}`
      ),
      React.createElement(
        "p",
        { className: MUTED_TEXT_CLASS },
        report.reasonCode === "reporter_unknown"
          ? "No reporter stated an outcome, which is recorded as such rather than inferred."
          : "The Runtime binds one outcome per session; it cannot be replaced from here."
      ),
      report.evidence.length > 0
        ? React.createElement(
            "ul",
            { className: "flex flex-col gap-1 text-xs" },
            report.evidence.map((entry) =>
              React.createElement(
                "li",
                { key: `${entry.kind}:${entry.uri}` },
                React.createElement(
                  "span",
                  { className: MUTED_TEXT_CLASS },
                  `${MEMORY_EVIDENCE_KIND_LABEL[entry.kind as keyof typeof MEMORY_EVIDENCE_KIND_LABEL] ?? entry.kind}: `
                ),
                entry.uri
              )
            )
          )
        : null
    );
  }

  return React.createElement(
    "div",
    { className: "flex flex-col gap-2", "data-session-outcome": experienceId },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Session outcome"
    ),
    React.createElement(
      "p",
      { className: MUTED_TEXT_CLASS },
      "No outcome has been reported for this session. That is not a negative result."
    ),
    React.createElement(
      "form",
      {
        method: "POST",
        action: "/api/memory",
        className: "flex flex-wrap items-end gap-2"
      },
      React.createElement("input", {
        key: "action",
        type: "hidden",
        name: "action",
        value: "report-session-outcome"
      }),
      React.createElement("input", {
        key: "experienceId",
        type: "hidden",
        name: "experienceId",
        value: experienceId
      }),
      React.createElement("input", {
        key: "workspaceId",
        type: "hidden",
        name: "workspaceId",
        value: listScope.workspaceId
      }),
      // The list this report was filed from, so the redirect lands back inside
      // the filters the operator was working in.
      React.createElement("input", {
        key: "returned",
        type: "hidden",
        name: "returned",
        value: memoryListQuery(listScope)
      }),
      React.createElement(SelectField, {
        name: "outcomeKind",
        label: "Outcome:",
        hideLabel: true,
        testId: "memory-session-outcome-kind",
        options: codeOptions(EXPERIENCE_OUTCOMES, {
          ...MEMORY_OUTCOME_LABEL,
          unknown: NOT_OBSERVED_LABEL
        })
      }),
      React.createElement(SelectField, {
        name: "reportKind",
        label: "Reported as:",
        hideLabel: true,
        testId: "memory-session-outcome-report-kind",
        options: codeOptions(
          MEMORY_OUTCOME_REPORT_KINDS,
          MEMORY_REPORT_KIND_LABEL
        )
      }),
      React.createElement(SelectField, {
        name: "evidenceKind",
        label: "Evidence:",
        hideLabel: true,
        testId: "memory-session-outcome-evidence-kind",
        options: codeOptions(MEMORY_EVIDENCE_KINDS, MEMORY_EVIDENCE_KIND_LABEL)
      }),
      React.createElement(TextField, {
        name: "evidenceUri",
        id: "memory-session-outcome-evidence-uri",
        label: "Evidence URI",
        hideLabel: true,
        placeholder: "Where the evidence lives",
        testId: "memory-session-outcome-evidence-uri"
      }),
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "secondary",
          testId: "memory-report-session-outcome"
        },
        "Report session outcome"
      )
    )
  );
}

const DETAIL_LABEL_CLASS = "text-fg-muted mr-2";

/** The same labels the packet-level outcomes use, so one code reads the same everywhere. */
function outcomeLabel(code: string): string {
  return (
    MEMORY_OUTCOME_LABEL[code as keyof typeof MEMORY_OUTCOME_LABEL] ?? code
  );
}

/**
 * Likewise for the report kind. `pull_request` is the case that matters: it is
 * the one code whose readable form differs enough to matter, and rendering it
 * raw puts a wire token in front of an operator next to a sentence that is
 * otherwise entirely prose.
 */
function reportKindLabel(code: string): string {
  return (
    MEMORY_REPORT_KIND_LABEL[code as keyof typeof MEMORY_REPORT_KIND_LABEL] ??
    code
  );
}
