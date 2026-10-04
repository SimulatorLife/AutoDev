import type { ExperienceEnvelope } from "@simulatorlife/autodev-core";
import React from "react";

import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface MemoryExperiencesViewProps {
  readonly experiences: readonly ExperienceEnvelope[];
  readonly totalCount: number;
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

export function MemoryExperiencesView({
  experiences,
  totalCount,
  selectedExperience,
  currentWorkspaceId,
  currentQuery = ""
}: MemoryExperiencesViewProps): React.JSX.Element {
  const columns: ColumnDef<ExperienceEnvelope>[] = [
    {
      id: "id",
      header: "Experience ID",
      width: "180px",
      cell: (exp) =>
        React.createElement(
          "a",
          {
            href: `?tab=experiences&workspaceId=${encodeURIComponent(currentWorkspaceId)}&experienceId=${encodeURIComponent(exp.id)}`,
            className:
              "font-mono text-xs font-semibold text-cyan-400 hover:text-cyan-300 hover:underline",
            "data-memory-experience-id": exp.id
          },
          exp.id
        )
    },
    {
      id: "task",
      header: "Task / Run",
      width: "200px",
      cell: (exp) =>
        React.createElement(
          "div",
          { className: "flex flex-col font-mono text-xs text-slate-300" },
          React.createElement(
            "span",
            { className: "truncate max-w-[180px]" },
            exp.taskId
          ),
          React.createElement(
            "span",
            { className: "text-[11px] text-slate-500 truncate max-w-[180px]" },
            exp.runId
          )
        )
    },
    {
      id: "role",
      header: "Agent Role",
      width: "130px",
      cell: (exp) =>
        React.createElement(
          "span",
          {
            className:
              "font-mono text-xs text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded border border-indigo-900/60"
          },
          exp.agentRole ?? "unknown"
        )
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "120px",
      cell: (exp) =>
        React.createElement(
          "span",
          {
            className: `font-mono text-xs font-semibold ${
              exp.outcome === "success"
                ? "text-emerald-400"
                : exp.outcome === "failure"
                  ? "text-rose-400"
                  : "text-slate-400"
            }`
          },
          exp.outcome
        )
    },
    {
      id: "mode",
      header: "Memory Mode",
      width: "130px",
      cell: (exp) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-300" },
          exp.memoryMode ?? "unknown"
        )
    },
    {
      id: "validation",
      header: "Validation",
      width: "120px",
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
      width: "150px",
      cell: (exp) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-400" },
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
          "flex flex-wrap items-center gap-3 p-4 bg-slate-900/80 rounded-lg border border-slate-800"
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
          "flex-1 min-w-[200px] px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
      }),
      React.createElement(
        "button",
        {
          type: "submit",
          className:
            "px-4 py-1.5 rounded bg-cyan-600 text-sm font-medium text-white hover:bg-cyan-500 transition-colors"
        },
        "Filter"
      ),
      React.createElement(
        "span",
        { className: "text-xs text-slate-400 ml-auto" },
        `${experiences.length} of ${totalCount} experiences`
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
        "rounded-lg border border-indigo-800/60 bg-slate-900/90 p-6 flex flex-col gap-6 shadow-xl",
      "data-selected-experience-panel": experience.id
    },
    // Header
    React.createElement(
      "div",
      {
        className:
          "flex items-start justify-between border-b border-slate-800 pb-4"
      },
      React.createElement(
        "div",
        { className: "flex flex-col gap-1" },
        React.createElement(
          "div",
          { className: "flex items-center gap-3" },
          React.createElement(
            "h3",
            { className: "font-mono text-lg font-bold text-slate-100" },
            experience.id
          ),
          React.createElement(
            "span",
            {
              className:
                "px-2 py-0.5 rounded text-xs font-mono text-indigo-300 bg-indigo-950/60 border border-indigo-800"
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
          { className: "text-xs text-slate-400 font-mono" },
          `Task: ${experience.taskId} | Run: ${experience.runId}`
        )
      ),
      React.createElement(
        "a",
        {
          href: `?tab=experiences&workspaceId=${encodeURIComponent(workspaceId)}`,
          className: "text-sm text-slate-400 hover:text-slate-200"
        },
        "✕ Close"
      )
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
            "rounded border border-slate-800 bg-slate-950/50 p-4 flex flex-col gap-2 text-xs"
        },
        React.createElement(
          "h4",
          {
            className: "font-semibold uppercase tracking-wider text-slate-400"
          },
          "Trajectory Provenance"
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "text-slate-500 mr-2" },
            "Format:"
          ),
          React.createElement(
            "span",
            { className: "font-mono text-slate-300" },
            experience.trajectory.format
          )
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "text-slate-500 mr-2" },
            "Source Adapter:"
          ),
          React.createElement(
            "span",
            { className: "font-mono text-cyan-300" },
            experience.trajectory.sourceAdapter ?? "manual/historical"
          )
        ),
        experience.trajectory.normalizerId
          ? React.createElement(
              "div",
              null,
              React.createElement(
                "span",
                { className: "text-slate-500 mr-2" },
                "Normalizer:"
              ),
              React.createElement(
                "span",
                { className: "font-mono text-slate-300" },
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
                { className: "text-slate-500 mr-2" },
                "Digest:"
              ),
              React.createElement(
                "span",
                {
                  className: "font-mono text-slate-400"
                },
                experience.trajectory.digest.slice(0, 16) + "..."
              )
            )
          : null,
        React.createElement(
          "div",
          { className: "break-all text-[11px] font-mono text-slate-500" },
          experience.trajectory.uri
        )
      ),

      // Evidence & Diagnostics
      React.createElement(
        "div",
        {
          className:
            "rounded border border-slate-800 bg-slate-950/50 p-4 flex flex-col gap-2 text-xs"
        },
        React.createElement(
          "h4",
          {
            className: "font-semibold uppercase tracking-wider text-slate-400"
          },
          "Evidence & Diagnostics"
        ),
        React.createElement(
          "div",
          null,
          React.createElement(
            "span",
            { className: "text-slate-500 mr-2" },
            "Evidence References:"
          ),
          React.createElement(
            "span",
            { className: "text-slate-300" },
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
                    className:
                      "px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300"
                  },
                  code
                )
              )
            )
          : React.createElement(
              "span",
              { className: "text-slate-500" },
              "No diagnostic codes emitted."
            )
      )
    ),

    // Governed Purge Action
    React.createElement(
      "div",
      {
        className:
          "flex items-center justify-between pt-4 border-t border-slate-800 text-xs"
      },
      React.createElement(
        "span",
        { className: "text-slate-400" },
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
        React.createElement(
          "button",
          {
            type: "submit",
            className:
              "px-3 py-1.5 rounded bg-rose-950 border border-rose-800 text-rose-300 hover:bg-rose-900 text-xs font-medium transition-colors"
          },
          "Purge Experience"
        )
      )
    )
  );
}

interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
}
