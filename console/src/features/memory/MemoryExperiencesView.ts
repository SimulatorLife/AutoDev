import type { ExperienceEnvelope } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import {
  SelectField,
  type SelectOption
} from "../../components/forms/SelectField.ts";
import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { ClosePanelLink } from "../../components/navigation/ClosePanelLink.ts";
import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import { TAG_SHAPE } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";

/**
 * The only reasons the Runtime's purge endpoint accepts. Offering anything else
 * would let an operator compose a request that is guaranteed to be rejected, so
 * the choice is the Runtime's vocabulary rather than free text.
 */
const PURGE_REASON_OPTIONS: readonly SelectOption[] = [
  { value: "privacy_request", label: "Privacy request" },
  { value: "retention_expired", label: "Retention expired" }
];

/** De-emphasised supporting copy, shared across this view's sub-panels. */
const MUTED_TEXT_CLASS = "text-fg-muted";

export interface MemoryExperiencesViewProps {
  readonly experiences: readonly ExperienceEnvelope[];
  readonly total: number;
  readonly selectedExperience?: ExperienceEnvelope | null | undefined;
  readonly currentWorkspaceId: string;
  readonly currentQuery?: string | undefined;
}

const VALIDATION_STATUS_MAP: Record<string, StatusBadgeVariant> = {
  passed: "valid",
  failed: "invalid",
  partial: "pending",
  not_run: "not-observed"
};
const DETAIL_LABEL_CLASS = "text-fg-muted mr-2";

export function MemoryExperiencesView({
  experiences,
  total,
  selectedExperience,
  currentWorkspaceId,
  currentQuery = ""
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
            href: `?tab=experiences&workspaceId=${encodeURIComponent(currentWorkspaceId)}&experienceId=${encodeURIComponent(exp.id)}`,
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
            { className: "truncate max-w-[180px]" },
            exp.taskId
          ),
          React.createElement(
            "span",
            { className: "text-meta text-fg-muted truncate max-w-[180px]" },
            exp.runId
          )
        )
    },
    {
      id: "role",
      header: "Agent Role",
      weight: 130,
      cell: (exp) =>
        React.createElement(
          "span",
          {
            className: `${TAG_SHAPE} border-chart-1/40 bg-chart-1/15 font-mono text-chart-1`
          },
          exp.agentRole ?? "unknown"
        )
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
          exp.outcome
        )
    },
    {
      id: "mode",
      header: "Memory Mode",
      weight: 130,
      cell: (exp) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-secondary" },
          exp.memoryMode ?? "unknown"
        )
    },
    {
      id: "validation",
      header: "Validation",
      weight: 120,
      cell: (exp) => {
        const state = exp.validation?.state ?? "not_run";
        return React.createElement(StatusBadge, {
          status: VALIDATION_STATUS_MAP[state] ?? "not-observed",
          label: state.replace("_", " ")
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
          { className: "text-xs text-fg-muted" },
          exp.startedAt ? new Date(exp.startedAt).toLocaleString() : "unknown"
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "memory-experiences" },
    // Filter controls
    React.createElement(
      "form",
      {
        method: "GET",
        className:
          "flex flex-wrap items-center gap-3 p-4 bg-surface/80 rounded-lg border border-border"
      },
      React.createElement("input", {
        type: "hidden",
        name: "tab",
        value: "experiences"
      }),
      React.createElement("input", {
        type: "hidden",
        name: "workspaceId",
        value: currentWorkspaceId
      }),
      React.createElement("input", {
        type: "text",
        name: "query",
        defaultValue: currentQuery,
        placeholder: "Search experiences by task, run, role, or trajectory...",
        className:
          "flex-1 min-w-[200px] px-3 py-1.5 rounded bg-input border border-border-strong text-sm text-fg placeholder-fg-muted focus:outline-none focus:border-accent"
      }),
      React.createElement(
        "button",
        {
          type: "submit",
          className:
            "px-4 py-1.5 rounded bg-accent text-sm font-medium text-fg-inverse hover:brightness-110 transition-colors"
        },
        "Filter"
      ),
      React.createElement(
        "span",
        { className: "text-xs text-fg-muted ml-auto" },
        `${experiences.length} of ${total} experiences`
      )
    ),

    // Main experiences table
    React.createElement<DataTableProps<ExperienceEnvelope>>(DataTable, {
      data: experiences,
      columns,
      keyExtractor: (exp: ExperienceEnvelope) => exp.id,
      emptyMessage:
        "No captured memory experiences found in this workspace scope."
    }),

    // Selected experience detail panel
    selectedExperience
      ? React.createElement(ExperienceDetailPanel, {
          experience: selectedExperience,
          workspaceId: currentWorkspaceId
        })
      : null
  );
}

interface ExperienceDetailPanelProps {
  readonly experience: ExperienceEnvelope;
  readonly workspaceId: string;
}

function ExperienceDetailPanel({
  experience,
  workspaceId
}: ExperienceDetailPanelProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "rounded-lg border border-accent/60 bg-selected p-6 flex flex-col gap-6 shadow-xl",
      "data-selected-experience-panel": experience.id
    },
    // Header
    React.createElement(
      "div",
      {
        className:
          "flex items-start justify-between border-b border-border pb-4"
      },
      React.createElement(
        "div",
        { className: "flex flex-col gap-1" },
        React.createElement(
          "div",
          { className: "flex items-center gap-3" },
          React.createElement(EntityTitle, { mono: true }, experience.id),
          React.createElement(
            "span",
            {
              className: `${TAG_SHAPE} border-chart-1/40 bg-chart-1/15 font-mono text-chart-1`
            },
            `Role: ${experience.agentRole ?? "unknown"}`
          ),
          React.createElement(StatusBadge, {
            status:
              VALIDATION_STATUS_MAP[
                experience.validation?.state ?? "not_run"
              ] ?? "not-observed",
            label: experience.validation?.state ?? "not_run"
          })
        ),
        React.createElement(
          "span",
          { className: "text-xs text-fg-muted font-mono" },
          `Task: ${experience.taskId} | Run: ${experience.runId}`
        )
      ),
      React.createElement(ClosePanelLink, {
        href: `?tab=experiences&workspaceId=${encodeURIComponent(workspaceId)}`
      })
    ),

    // Trajectory Provenance & Details
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-2 gap-4" },
      // Trajectory
      React.createElement(
        "div",
        {
          className:
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2 text-xs"
        },
        React.createElement(
          "h4",
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
          "h4",
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
                React.createElement(
                  "span",
                  {
                    key: code,
                    className: `${TAG_SHAPE} border-border-strong bg-surface-raised font-mono text-fg-secondary`
                  },
                  code
                )
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
          value: workspaceId
        }),
        // Purge erases the raw envelope irreversibly, so the operator states a
        // reason the Runtime accepts and confirms explicitly. Both are enforced
        // server-side: the Console ships no client JavaScript, so an unchecked
        // box is not a UI-only guard, it is a request the route refuses.
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
      )
    )
  );
}
