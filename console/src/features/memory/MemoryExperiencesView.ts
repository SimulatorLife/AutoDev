import type {
  ControlApiMemoryInjectionOutcomeJoin,
  ControlApiMemoryInjectionUseAssessment,
  ExperienceEnvelope,
  ExperienceValidationState
} from "@simulatorlife/autodev-core";
import { MEMORY_EXPERIENCE_PURGE_REASONS } from "@simulatorlife/autodev-core";
import React from "react";

import {
  FilterBar,
  FilterSearchField
} from "../../components/filters/FilterBar.ts";
import { Button } from "../../components/forms/Button.ts";
import {
  SelectField,
  type SelectOption
} from "../../components/forms/SelectField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { Pagination } from "../../components/navigation/Pagination.ts";
import { DetailDrawer } from "../../components/panels/DetailDrawer.ts";
import { gridRowClass } from "../../components/panels/DetailGrid.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_VALUE_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { codeOptions } from "./memory-code-options.ts";
import {
  memoryDetailHref,
  memoryFilterHref,
  memoryListHref,
  memoryListQuery,
  type MemoryListScope,
  memoryPageHref
} from "./memory-list-url.ts";
import {
  MEMORY_OUTCOME_LABEL,
  MEMORY_PURGE_REASON_LABEL,
  MEMORY_VALIDATION_LABEL,
  MEMORY_VALIDATION_VARIANT
} from "./memory-status.ts";
import { InjectionReports } from "./MemoryInjectionReports.ts";
import { MemorySessionOutcome } from "./MemorySessionOutcome.ts";
import type { ControlApiMemorySessionOutcomeProjection } from "../../lib/server/control-api.ts";

/**
 * The only reasons the Runtime's purge endpoint accepts. Offering anything else
 * would let an operator compose a request that is guaranteed to be rejected, so
 * the choice is the Runtime's vocabulary rather than free text — taken from Core,
 * which is where the Runtime reads it from, rather than restated here.
 */
const PURGE_REASON_OPTIONS: readonly SelectOption[] = codeOptions(
  MEMORY_EXPERIENCE_PURGE_REASONS,
  MEMORY_PURGE_REASON_LABEL
);

/** De-emphasised supporting copy, shared across this view's sub-panels. */

export interface MemoryExperiencesViewProps {
  readonly experiences: readonly ExperienceEnvelope[];
  readonly total: number;
  readonly selectedExperience?: ExperienceEnvelope | null | undefined;
  /**
   * The selected experience's evidence classes. Null is "not observed here",
   * which the panel states -- it never renders as "no evidence exists".
   */
  readonly outcomes?:
    readonly ControlApiMemoryInjectionOutcomeJoin[] | null | undefined;
  readonly outcomeTotal?: number | null | undefined;
  readonly useAssessments?:
    readonly ControlApiMemoryInjectionUseAssessment[] | null | undefined;
  readonly useAssessmentTotal?: number | null | undefined;
  /**
   * The reporter's statement about the session as a whole. Undefined is "the
   * read did not succeed", null is "read, and none exists", and a report is the
   * claim itself. See MemorySessionOutcome for why the three stay apart.
   */
  readonly sessionOutcome?: ControlApiMemorySessionOutcomeProjection["report"] | null | undefined;
  /** The address of the list these rows came from. See MemoryRecordsView. */
  readonly listScope: MemoryListScope;
}

/** The state for an experience, or `not_run` when the Runtime reported none. */
function validationState(
  experience: ExperienceEnvelope
): ExperienceValidationState {
  return experience.validation?.state ?? "not_run";
}

const DETAIL_LABEL_CLASS = "text-fg-muted mr-2";

export function MemoryExperiencesView({
  experiences,
  total,
  selectedExperience,
  outcomes,
  outcomeTotal,
  useAssessments,
  useAssessmentTotal,
  sessionOutcome,
  listScope
}: MemoryExperiencesViewProps): React.JSX.Element {
  const columns: ColumnDef<ExperienceEnvelope>[] = [
    {
      id: "id",
      header: "Experience ID",
      weight: 180,
      cell: (exp) =>
        React.createElement(
          "a",
          {
            href: memoryDetailHref(listScope, "experienceId", exp.id),
            className:
              "font-mono text-xs font-semibold text-accent hover:brightness-110 hover:underline",
            "data-memory-experience-id": exp.id
          },
          exp.id
        )
    },
    {
      id: "task",
      header: "Task / Run",
      weight: 200,
      cell: (exp) =>
        React.createElement(
          "div",
          { className: "flex flex-col font-mono text-xs text-fg-secondary" },
          React.createElement(
            "span",
            { className: "truncate max-w-[180px]", title: exp.taskId },
            exp.taskId
          ),
          React.createElement(
            "span",
            {
              className: "text-meta text-fg-muted truncate max-w-[180px]",
              title: exp.runId
            },
            exp.runId
          )
        )
    },
    {
      id: "role",
      header: "Agent Role",
      weight: 130,
      cell: (exp) =>
        React.createElement(Tag, {
          className: "border-chart-1/40 bg-chart-1/15 font-mono text-chart-1",
          children: exp.agentRole ?? "unknown"
        })
    },
    {
      id: "outcome",
      header: "Outcome",
      weight: 120,
      cell: (exp) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs font-semibold ${
              exp.outcome === "success"
                ? "text-success"
                : exp.outcome === "failure"
                  ? "text-error"
                  : MUTED_TEXT_CLASS
            }`
          },
          MEMORY_OUTCOME_LABEL[exp.outcome]
        )
    },
    {
      id: "mode",
      header: "Memory Mode",
      weight: 130,
      cell: (exp) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
          exp.memoryMode ?? "unknown"
        )
    },
    {
      id: "validation",
      header: "Validation",
      weight: 120,
      cell: (exp) => {
        const state = validationState(exp);
        return React.createElement(StatusBadge, {
          status: MEMORY_VALIDATION_VARIANT[state] ?? "not-observed",
          label: MEMORY_VALIDATION_LABEL[state]
        });
      }
    },
    {
      id: "startedAt",
      header: "Started At",
      weight: 150,
      cell: (exp) =>
        React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          exp.startedAt ? new Date(exp.startedAt).toLocaleString() : "unknown"
        )
    }
  ];

  return React.createElement(
    PageBody,
    { feature: "memory-experiences" },
    // Filter controls
    React.createElement(
      FilterBar,
      {
        label: "Experience filters",
        action: memoryFilterHref(listScope),
        preserved: [
          { name: "tab", value: "experiences" },
          { name: "workspaceId", value: listScope.workspaceId },
          { name: "from", value: listScope.from },
          { name: "until", value: listScope.until },
          { name: "limit", value: String(listScope.limit) }
        ],
        submitTestId: "memory-experience-filter",
        summary: `${experiences.length} of ${total} experiences`,
        dataAttributes: { "data-feature-filter": "experiences" }
      },
      React.createElement(FilterSearchField, {
        name: "query",
        defaultValue: listScope.query ?? "",
        label: "Search experiences by task, run, role, or trajectory",
        placeholder: "Search experiences by task, run, role, or trajectory...",
        testId: "memory-experience-query"
      })
    ),

    // Main experiences table
    React.createElement<DataTableProps<ExperienceEnvelope>>(DataTable, {
      data: experiences,
      columns,
      keyExtractor: (exp: ExperienceEnvelope) => exp.id,
      emptyMessage:
        "No captured memory experiences found in this workspace scope."
    }),

    // The Runtime returns a bounded page and the total behind it.
    React.createElement(Pagination, {
      label: "Experiences",
      offset: listScope.offset,
      limit: listScope.limit,
      total,
      hrefForOffset: (offset: number) => memoryPageHref(listScope, offset),
      testId: "memory-experiences-pagination"
    }),

    // Selected experience detail panel
    selectedExperience
      ? React.createElement(ExperienceDetailPanel, {
          experience: selectedExperience,
          outcomes,
          outcomeTotal,
          useAssessments,
          useAssessmentTotal,
          sessionOutcome,
          listScope
        })
      : null
  );
}

interface ExperienceDetailPanelProps {
  readonly experience: ExperienceEnvelope;
  readonly outcomes?:
    readonly ControlApiMemoryInjectionOutcomeJoin[] | null | undefined;
  readonly outcomeTotal?: number | null | undefined;
  readonly useAssessments?:
    readonly ControlApiMemoryInjectionUseAssessment[] | null | undefined;
  readonly useAssessmentTotal?: number | null | undefined;
  readonly sessionOutcome?: ControlApiMemorySessionOutcomeProjection["report"] | null | undefined;
  readonly listScope: MemoryListScope;
}

function ExperienceDetailPanel({
  experience,
  outcomes,
  outcomeTotal,
  useAssessments,
  useAssessmentTotal,
  sessionOutcome,
  listScope
}: ExperienceDetailPanelProps): React.JSX.Element {
  return React.createElement(
    DetailDrawer,
    {
      title: experience.id,
      // Back to the list the experience was opened from, filters and position
      // intact.
      closeHref: memoryListHref(listScope),
      subtitle: `Task: ${experience.taskId} | Run: ${experience.runId}`,
      dataAttributes: { "data-selected-experience-panel": experience.id },
      badges: [
        React.createElement(Tag, {
          key: "role",
          className: "border-chart-1/40 bg-chart-1/15 font-mono text-chart-1",
          children: `Role: ${experience.agentRole ?? "unknown"}`
        }),
        React.createElement(StatusBadge, {
          key: "status",
          status:
            MEMORY_VALIDATION_VARIANT[validationState(experience)] ??
            "not-observed",
          label: MEMORY_VALIDATION_LABEL[validationState(experience)]
        })
      ]
    },

    // Trajectory Provenance & Details
    React.createElement(
      "div",
      { className: gridRowClass(2) },
      // Trajectory
      React.createElement(
        "div",
        {
          className:
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2 text-xs"
        },
        React.createElement(
          "h3",
          {
            className: SECTION_HEADING_CLASS
          },
          "Trajectory Provenance"
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: DETAIL_LABEL_CLASS },
            "Format:"
          ),
          React.createElement(
            "span",
            { className: "font-mono text-fg-secondary" },
            experience.trajectory.format
          )
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: DETAIL_LABEL_CLASS },
            "Source Adapter:"
          ),
          React.createElement(
            "span",
            { className: "font-mono text-accent" },
            experience.trajectory.sourceAdapter ?? "manual/historical"
          )
        ),
        experience.trajectory.normalizerId
          ? React.createElement(
              "div",
              null,
              React.createElement(
                "span",
                { className: DETAIL_LABEL_CLASS },
                "Normalizer:"
              ),
              React.createElement(
                "span",
                { className: "font-mono text-fg-secondary" },
                `${experience.trajectory.normalizerId}@${experience.trajectory.normalizerVersion ?? "unknown"}`
              )
            )
          : null,
        experience.trajectory.digest
          ? React.createElement(
              "div",
              null,
              React.createElement(
                "span",
                { className: DETAIL_LABEL_CLASS },
                "Digest:"
              ),
              React.createElement(
                "span",
                {
                  className: "font-mono text-fg-muted"
                },
                experience.trajectory.digest.slice(0, 16) + "..."
              )
            )
          : null,
        React.createElement(
          "div",
          { className: "break-all text-meta font-mono text-fg-muted" },
          experience.trajectory.uri
        )
      ),

      // Evidence & Diagnostics
      React.createElement(
        "div",
        {
          className:
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2 text-xs"
        },
        React.createElement(
          "h3",
          {
            className: SECTION_HEADING_CLASS
          },
          "Evidence & Diagnostics"
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: DETAIL_LABEL_CLASS },
            "Evidence References:"
          ),
          React.createElement(
            "span",
            { className: "text-fg-secondary" },
            `${experience.evidence.length} files`
          )
        ),
        experience.trajectory.diagnosticCodes?.length
          ? React.createElement(
              "div",
              { className: "flex flex-wrap gap-1 mt-1" },
              experience.trajectory.diagnosticCodes.map((code) =>
                React.createElement(Tag, {
                  key: code,
                  className:
                    "border-border-strong bg-surface-raised font-mono text-fg-secondary",
                  children: code
                })
              )
            )
          : React.createElement(
              "span",
              { className: MUTED_TEXT_CLASS },
              "No diagnostic codes emitted."
            )
      )
    ),

    // Governed Purge Action
    React.createElement(
      "div",
      {
        className: "flex flex-col gap-2 pt-4 border-t border-border text-xs"
      },
      React.createElement(
        "span",
        { className: MUTED_TEXT_CLASS },
        "Raw experiences cited by durable memory cannot be purged."
      ),
      React.createElement(
        "form",
        { method: "POST", action: "/api/memory" },
        React.createElement("input", {
          type: "hidden",
          name: "action",
          value: "purge"
        }),
        React.createElement("input", {
          type: "hidden",
          name: "experienceId",
          value: experience.id
        }),
        React.createElement("input", {
          type: "hidden",
          name: "workspaceId",
          value: listScope.workspaceId
        }),
        // The list this purge was made on, so the redirect lands back inside
        // the filters the operator was working in.
        React.createElement("input", {
          type: "hidden",
          name: "returned",
          value: memoryListQuery(listScope)
        }),
        // Purge erases the raw envelope irreversibly, so the operator states a
        // reason the Runtime accepts and confirms explicitly. Both are enforced
        // server-side: an unchecked box is not a UI-only guard, it is a request
        // the route refuses. The sidebar's client toggle does not touch this form.
        React.createElement(SelectField, {
          name: "reason",
          label: "Purge reason",
          options: PURGE_REASON_OPTIONS,
          defaultValue: "privacy_request"
        }),
        React.createElement(
          "label",
          { className: "flex items-center gap-2 text-fg-secondary" },
          React.createElement("input", {
            type: "checkbox",
            name: "confirm",
            value: "purge",
            className: "accent-error"
          }),
          React.createElement(
            "span",
            null,
            "I understand this permanently erases this raw experience envelope."
          )
        ),
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement(
            Button,
            {
              type: "submit",
              variant: "destructive",
              testId: "purge-experience"
            },
            "Purge Experience"
          ),
          React.createElement(
            "span",
            { className: MUTED_TEXT_CLASS },
            "Irreversible. Refused while durable memory cites this experience."
          )
        )
      ),

      // The session-level claim first, because it is the wider one: it is about
      // the session the packets below were attached to, not about any of them.
      React.createElement(MemorySessionOutcome, {
        report: sessionOutcome,
        listScope,
        experienceId: experience.id
      }),

      // Observed evidence, and the claims made about it, as separate classes.
      React.createElement(ExperienceEvidence, {
        experience,
        listScope,
        outcomes,
        outcomeTotal,
        useAssessments,
        useAssessmentTotal
      })
    )
  );
}

/**
 * The three evidence classes behind one experience.
 *
 * The Console previously showed none of them: the Runtime stored injections,
 * reporter outcomes, and curator use assessments, and read them all back, and
 * the operator surface could only show the envelope. So the one thing an
 * operator most needs from a memory system -- whether attaching memory
 * actually did anything -- had no view at all.
 *
 * What it renders here are three different claims, kept apart because merging
 * them is how memory evaluation goes wrong:
 *
 * - **Observed**: what the runtime attached, and when. Measured.
 * - **Reported**: what a reporter separately stated about the task. Absent
 *   means *nobody reported*, which is not *it failed* -- an unreported outcome
 *   renders as unreported, never as a negative result.
 * - **Assessed**: a curator's judgement about whether the packet was used.
 *   `unobservable` is deliberately not folded into `not_used`; one says nobody
 *   could tell, the other says nobody saw it used.
 *
 * A read that did not succeed renders as unavailable, never as an empty list,
 * because "we could not look" and "there is nothing there" are the two answers
 * an operator must never confuse.
 */
function ExperienceEvidence({
  experience,
  listScope,
  outcomes,
  outcomeTotal,
  useAssessments,
  useAssessmentTotal
}: {
  readonly experience: ExperienceEnvelope;
  readonly listScope: MemoryListScope;
  readonly outcomes?:
    readonly ControlApiMemoryInjectionOutcomeJoin[] | null | undefined;
  readonly outcomeTotal?: number | null | undefined;
  readonly useAssessments?:
    readonly ControlApiMemoryInjectionUseAssessment[] | null | undefined;
  readonly useAssessmentTotal?: number | null | undefined;
}): React.JSX.Element {
  const unavailable = (what: string, testId: string): React.JSX.Element =>
    React.createElement(
      "p",
      {
        className: MUTED_TEXT_CLASS,
        "data-status": "unavailable",
        "data-evidence": testId
      },
      `${what} were not observed; nothing is inferred about them.`
    );

  return React.createElement(
    "section",
    {
      className: "flex flex-col gap-3 pt-4 border-t border-border",
      "data-experience-evidence": "true"
    },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Packet evidence"
    ),
    outcomes === null || outcomes === undefined
      ? unavailable("Injection events and reported outcomes", "outcomes")
      : outcomes.length === 0
        ? React.createElement(
            "p",
            { className: MUTED_TEXT_CLASS, "data-evidence": "outcomes" },
            "No packet was attached to this experience, so there is nothing observed and nothing reported."
          )
        : React.createElement(
            "ol",
            {
              className: "flex flex-col gap-2",
              "data-evidence": "outcomes"
            },
            outcomes.map((row) =>
              React.createElement(EvidenceRow, {
                key: row.injection.id,
                injection: row.injection,
                sessionInjectionCount: row.sessionInjectionCount,
                // An injection nobody has reported on is exactly where a report
                // belongs: the claim is per-injection, and the row already holds
                // the correlation token the Runtime binds it to.
                listScope,
                experienceId: experience.id,
                // The Runtime rejects a second report for the same binding, so
                // the form is not offered once one exists.
                alreadyReported: row.outcome !== null,
                useAssessment:
                  useAssessments?.find(
                    (candidate) => candidate.injection.id === row.injection.id
                  )?.use ?? null,
                // The reported half renders separately, and says "unreported"
                // rather than borrowing the injection's own verdict.
                report:
                  row.outcome === null
                    ? null
                    : {
                        label: "Reported outcome",
                        value: row.outcome.outcomeKind,
                        detail: `${row.outcome.reportKind} by ${row.outcome.reporterId} (${row.outcome.reporterAuthority}) at ${row.outcome.reportedAt} — ${row.outcome.reasonCode}`
                      }
              })
            )
          ),

    useAssessments === null || useAssessments === undefined
      ? unavailable("Curator use assessments", "use-assessments")
      : useAssessments.length === 0
        ? React.createElement(
            "p",
            { className: MUTED_TEXT_CLASS, "data-evidence": "use-assessments" },
            "No curator has assessed whether any injected packet was used."
          )
        : React.createElement(
            "ul",
            {
              className: "flex flex-col gap-1",
              "data-evidence": "use-assessments"
            },
            useAssessments.map((row) =>
              React.createElement(
                "li",
                { key: row.injection.id, className: "text-xs" },
                React.createElement(
                  "span",
                  { className: MUTED_TEXT_CLASS },
                  `${row.injection.memoryMode} · ${row.injection.injectionResult} · `
                ),
                React.createElement(
                  "span",
                  null,
                  row.use === null
                    ? "not assessed"
                    : `${row.use.useKind} (${row.use.usedMemoryIds.length}/${row.injection.memoryIds.length} memories cited)`
                )
              )
            )
          ),

    (outcomeTotal !== null && outcomeTotal !== undefined) ||
      (useAssessmentTotal !== null && useAssessmentTotal !== undefined)
      ? React.createElement(
          "p",
          { className: MUTED_TEXT_CLASS, "data-evidence": "totals" },
          [
            `${outcomeTotal ?? 0} observed injection${
              outcomeTotal === 1 ? "" : "s"
            }`,
            `${useAssessmentTotal ?? 0} assessed`
          ].join(" · ")
        )
      : null
  );
}

/**
 * One observed injection and, beside it, the claim made about it.
 *
 * The count is session-wide and is labelled as such where it is shown, because
 * `sessionInjectionCount` is derived from every injection the session
 * produced; presenting it as this row's own count would overstate it for
 * exactly the sessions that injected repeatedly.
 */
function EvidenceRow({
  injection,
  sessionInjectionCount,
  report,
  listScope,
  experienceId,
  alreadyReported,
  useAssessment
}: {
  readonly injection: ControlApiMemoryInjectionOutcomeJoin["injection"];
  readonly sessionInjectionCount: number;
  readonly report: {
    readonly label: string;
    readonly value: string;
    readonly detail: string;
  } | null;
  readonly listScope: MemoryListScope;
  readonly experienceId: string;
  readonly alreadyReported: boolean;
  readonly useAssessment: { readonly useKind: string } | null;
}): React.JSX.Element {
  return React.createElement(
    "li",
    {
      className: "flex flex-col gap-0.5 text-xs",
      "data-evidence-row": injection.id
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(
        "span",
        { className: "font-mono text-fg" },
        injection.injectionResult
      ),
      React.createElement(
        "span",
        { className: MUTED_TEXT_CLASS },
        injection.memoryMode
      ),
      React.createElement(
        "span",
        { className: MUTED_TEXT_CLASS },
        `${injection.memoryIds.length} memories · ${injection.packetCharacterCount} chars · ${injection.occurredAt}`
      )
    ),
    React.createElement(
      "div",
      { className: MUTED_TEXT_CLASS },
      `Observed by the runtime · ${sessionInjectionCount} injection${
        sessionInjectionCount === 1 ? "" : "s"
      } in this session`
    ),
    report === null
      ? React.createElement(
          "div",
          { className: MUTED_TEXT_CLASS, "data-evidence-report": "unreported" },
          "No outcome reported. This is not a failed outcome."
        )
      : React.createElement(
          "div",
          { "data-evidence-report": "reported" },
          React.createElement(
            "span",
            { className: "font-semibold" },
            `${report.label}: ${report.value} `
          ),
          React.createElement(
            "span",
            { className: MUTED_TEXT_CLASS },
            report.detail
          )
        ),

    // The report forms live on the injection they describe, because both claims
    // are per-injection.
    React.createElement(InjectionReports, {
      injection,
      listScope,
      experienceId,
      alreadyReported,
      useAssessment
    })
  );
}
