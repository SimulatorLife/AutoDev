import type {
  EvidenceReference,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatus
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface MemoryRecordTransition {
  readonly fromStatus?: MemoryStatus;
  readonly toStatus: MemoryStatus;
  readonly actor: { readonly id: string; readonly authority: string };
  readonly reason?: string;
  readonly timestamp: string;
}

export interface MemoryRecordHistory {
  readonly schema: string;
  readonly memory: MemoryRecord;
  readonly transitions: readonly MemoryRecordTransition[];
}

export interface MemoryRecordsViewProps {
  readonly records: readonly MemoryRecord[];
  readonly totalCount: number;
  readonly selectedRecord?: MemoryRecord | null | undefined;
  readonly history?: MemoryRecordHistory | null | undefined;
  readonly currentWorkspaceId: string;
  readonly currentQuery?: string | undefined;
  readonly currentKind?: string | undefined;
  readonly currentStatus?: string | undefined;
}

const STATUS_VARIANT_MAP: Record<MemoryStatus, StatusBadgeVariant> = {
  active: "ready",
  proposed: "pending",
  invalidated: "invalid",
  superseded: "unavailable",
  uncertain: "not-observed"
};

const KIND_COLORS: Record<MemoryKind, string> = {
  episodic: "bg-blue-950/60 text-blue-300 border-blue-800",
  semantic: "bg-teal-950/60 text-teal-300 border-teal-800",
  procedural: "bg-purple-950/60 text-purple-300 border-purple-800"
};

function formatScopeString(scope: MemoryScope): string {
  switch (scope.kind) {
    case "global": {
      return "global";
    }
    case "workspace": {
      return scope.workspaceId;
    }
    case "repository": {
      return scope.repositoryId;
    }
    case "role": {
      return `${scope.workspaceId} (@${scope.role})`;
    }
    case "task": {
      return `task:${scope.taskId}`;
    }
    case "agent": {
      return `agent:${scope.agentId}`;
    }
    default: {
      return "unknown";
    }
  }
}

export function MemoryRecordsView({
  records,
  totalCount,
  selectedRecord,
  history,
  currentWorkspaceId,
  currentQuery = "",
  currentKind = "all",
  currentStatus = "all"
}: MemoryRecordsViewProps): React.JSX.Element {
  const columns: ColumnDef<MemoryRecord>[] = [
    {
      id: "id",
      header: "Record ID",
      width: "180px",
      cell: (record) =>
        React.createElement(
          "a",
          {
            href: `?tab=records&workspaceId=${encodeURIComponent(currentWorkspaceId)}&recordId=${encodeURIComponent(record.id)}`,
            className:
              "font-mono text-xs font-semibold text-cyan-400 hover:text-cyan-300 hover:underline",
            "data-memory-record-id": record.id
          },
          record.id
        )
    },
    {
      id: "kind",
      header: "Kind",
      width: "120px",
      cell: (record) =>
        React.createElement(
          "span",
          {
            className: `inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border ${KIND_COLORS[record.kind] ?? "bg-slate-800 text-slate-300 border-slate-700"}`,
            "data-memory-kind": record.kind
          },
          record.kind
        )
    },
    {
      id: "status",
      header: "Lifecycle Status",
      width: "140px",
      cell: (record) =>
        React.createElement(StatusBadge, {
          status: STATUS_VARIANT_MAP[record.status] ?? "not-observed",
          label: record.status.charAt(0).toUpperCase() + record.status.slice(1)
        })
    },
    {
      id: "claim",
      header: "Claim Summary",
      cell: (record) =>
        React.createElement(
          "div",
          { className: "max-w-md truncate text-sm text-slate-200" },
          record.claim
        )
    },
    {
      id: "scope",
      header: "Scope",
      width: "160px",
      cell: (record) =>
        React.createElement(
          "span",
          {
            className:
              "font-mono text-xs text-slate-400 truncate max-w-[150px] inline-block"
          },
          formatScopeString(record.scope)
        )
    },
    {
      id: "updatedAt",
      header: "Updated",
      width: "140px",
      cell: (record) =>
        React.createElement(
          "span",
          { className: "text-xs text-slate-400" },
          record.updatedAt
            ? new Date(record.updatedAt).toLocaleDateString()
            : "unknown"
        )
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "memory-records" },
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
        value: "records"
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
        placeholder: "Search memory claims...",
        className:
          "flex-1 min-w-[200px] px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
      }),
      React.createElement(
        "select",
        {
          name: "kind",
          defaultValue: currentKind,
          className:
            "px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-cyan-500"
        },
        React.createElement("option", { value: "all" }, "All Kinds"),
        React.createElement("option", { value: "procedural" }, "Procedural"),
        React.createElement("option", { value: "semantic" }, "Semantic"),
        React.createElement("option", { value: "episodic" }, "Episodic")
      ),
      React.createElement(
        "select",
        {
          name: "status",
          defaultValue: currentStatus,
          className:
            "px-3 py-1.5 rounded bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-cyan-500"
        },
        React.createElement("option", { value: "all" }, "All Statuses"),
        React.createElement("option", { value: "active" }, "Active"),
        React.createElement("option", { value: "proposed" }, "Proposed"),
        React.createElement("option", { value: "invalidated" }, "Invalidated"),
        React.createElement("option", { value: "superseded" }, "Superseded"),
        React.createElement("option", { value: "uncertain" }, "Uncertain")
      ),
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
        `${records.length} of ${totalCount} records`
      )
    ),

    // Main records table
    React.createElement<DataTableProps<MemoryRecord>>(DataTable, {
      data: records,
      columns,
      keyExtractor: (r: MemoryRecord) => r.id,
      emptyMessage: "No memory records found matching the current criteria."
    }),

    // Selected record inspection drawer/panel
    selectedRecord
      ? React.createElement(RecordDetailPanel, {
          record: selectedRecord,
          history,
          workspaceId: currentWorkspaceId
        })
      : null
  );
}

interface RecordDetailPanelProps {
  readonly record: MemoryRecord;
  readonly history?: MemoryRecordHistory | null | undefined;
  readonly workspaceId: string;
}

function RecordDetailPanel({
  record,
  history,
  workspaceId
}: RecordDetailPanelProps): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className:
        "rounded-lg border border-cyan-800/60 bg-slate-900/90 p-6 flex flex-col gap-6 shadow-xl",
      "data-selected-record-panel": record.id
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
            record.id
          ),
          React.createElement(
            "span",
            {
              className: `px-2 py-0.5 rounded text-xs font-mono font-medium border ${KIND_COLORS[record.kind] ?? "bg-slate-800 text-slate-300 border-slate-700"}`
            },
            record.kind
          ),
          React.createElement(StatusBadge, {
            status: STATUS_VARIANT_MAP[record.status] ?? "not-observed",
            label: record.status.toUpperCase()
          })
        ),
        React.createElement(
          "span",
          { className: "text-xs text-slate-400 font-mono" },
          `Scope: ${formatScopeString(record.scope)}`
        )
      ),
      React.createElement(
        "a",
        {
          href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}`,
          className: "text-sm text-slate-400 hover:text-slate-200"
        },
        "✕ Close"
      )
    ),

    // Claim
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h4",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-slate-400"
        },
        "Durable Claim"
      ),
      React.createElement(
        "div",
        {
          className:
            "rounded-md border border-slate-800 bg-slate-950 p-4 font-mono text-sm text-slate-200 leading-relaxed whitespace-pre-wrap"
        },
        record.claim
      )
    ),

    // Validity & Provenance grid
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-2 gap-4" },
      // Validity
      React.createElement(
        "div",
        {
          className:
            "rounded border border-slate-800 bg-slate-950/50 p-4 flex flex-col gap-2"
        },
        React.createElement(
          "h4",
          {
            className:
              "text-xs font-semibold uppercase tracking-wider text-slate-400"
          },
          "Validity State"
        ),
        React.createElement(
          "div",
          { className: "flex items-center gap-2 text-xs" },
          React.createElement(
            "span",
            { className: "text-slate-400" },
            "State:"
          ),
          React.createElement(
            "span",
            {
              className: `font-semibold ${record.validity.state === "verified" ? "text-emerald-400" : record.validity.state === "contradicted" ? "text-rose-400" : "text-amber-400"}`
            },
            record.validity.state
          )
        ),
        record.validity.checkedAt
          ? React.createElement(
              "div",
              { className: "text-xs text-slate-400" },
              `Checked at: ${new Date(record.validity.checkedAt).toLocaleString()}`
            )
          : null,
        record.validity.verificationSource
          ? React.createElement(
              "div",
              { className: "text-xs text-slate-400 font-mono" },
              `Verification source: ${record.validity.verificationSource}`
            )
          : null
      ),

      // Provenance
      React.createElement(
        "div",
        {
          className:
            "rounded border border-slate-800 bg-slate-950/50 p-4 flex flex-col gap-2"
        },
        React.createElement(
          "h4",
          {
            className:
              "text-xs font-semibold uppercase tracking-wider text-slate-400"
          },
          "Provenance & Citations"
        ),
        React.createElement(
          "div",
          { className: "text-xs text-slate-300" },
          `Sources: ${record.provenance.experienceIds.length} experiences`
        ),
        record.provenance.lastVerifiedAt
          ? React.createElement(
              "div",
              { className: "text-xs font-mono text-slate-400" },
              `Last verified: ${new Date(record.provenance.lastVerifiedAt).toLocaleString()}`
            )
          : null,
        record.provenance.evidence && record.provenance.evidence.length > 0
          ? React.createElement(
              "div",
              { className: "flex flex-col gap-1 mt-1" },
              React.createElement(
                "span",
                { className: "text-xs text-slate-400 font-medium" },
                "Cited Evidence Files:"
              ),
              record.provenance.evidence.map(
                (ev: EvidenceReference, i: number) =>
                  React.createElement(
                    "span",
                    {
                      key: i,
                      className:
                        "font-mono text-[11px] text-cyan-300 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-900/60 truncate"
                    },
                    `${ev.kind}: ${ev.uri}`
                  )
              )
            )
          : null
      )
    ),

    // Lineage (supersedes / supersededBy)
    record.supersedes?.length || record.supersededBy?.length
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2 text-xs" },
          React.createElement(
            "h4",
            {
              className: "font-semibold uppercase tracking-wider text-slate-400"
            },
            "Lineage"
          ),
          record.supersedes?.length
            ? React.createElement(
                "div",
                { className: "flex items-center gap-2" },
                React.createElement(
                  "span",
                  { className: "text-slate-400" },
                  "Supersedes:"
                ),
                record.supersedes.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}&recordId=${encodeURIComponent(id)}`,
                      className: "font-mono text-cyan-400 hover:underline"
                    },
                    id
                  )
                )
              )
            : null,
          record.supersededBy?.length
            ? React.createElement(
                "div",
                { className: "flex items-center gap-2" },
                React.createElement(
                  "span",
                  { className: "text-slate-400" },
                  "Superseded By:"
                ),
                record.supersededBy.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}&recordId=${encodeURIComponent(id)}`,
                      className: "font-mono text-cyan-400 hover:underline"
                    },
                    id
                  )
                )
              )
            : null
        )
      : null,

    // Transition History
    history && history.transitions && history.transitions.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          React.createElement(
            "h4",
            {
              className:
                "text-xs font-semibold uppercase tracking-wider text-slate-400"
            },
            "Transition History"
          ),
          React.createElement(
            "div",
            {
              className:
                "flex flex-col divide-y divide-slate-800 rounded border border-slate-800 bg-slate-950/60"
            },
            history.transitions.map((t, i) =>
              React.createElement(
                "div",
                {
                  key: i,
                  className: "flex items-center justify-between p-3 text-xs"
                },
                React.createElement(
                  "div",
                  { className: "flex items-center gap-2" },
                  React.createElement(StatusBadge, {
                    status: STATUS_VARIANT_MAP[t.toStatus] ?? "not-observed",
                    label: `${t.fromStatus ?? "none"} → ${t.toStatus}`
                  }),
                  t.reason
                    ? React.createElement(
                        "span",
                        { className: "text-slate-300" },
                        `(${t.reason})`
                      )
                    : null
                ),
                React.createElement(
                  "div",
                  {
                    className:
                      "flex items-center gap-3 text-slate-500 font-mono text-[11px]"
                  },
                  React.createElement("span", null, t.actor.id),
                  React.createElement(
                    "span",
                    null,
                    new Date(t.timestamp).toLocaleString()
                  )
                )
              )
            )
          )
        )
      : null,

    // Governed Operator Actions
    React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-center gap-3 pt-4 border-t border-slate-800"
      },
      React.createElement(
        "span",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-slate-400 mr-2"
        },
        "Governed Actions:"
      ),
      // Verify & Promote
      record.status === "proposed" || record.status === "invalidated"
        ? React.createElement(
            "form",
            { method: "POST", action: "/api/memory" },
            React.createElement("input", {
              type: "hidden",
              name: "action",
              value: "verify"
            }),
            React.createElement("input", {
              type: "hidden",
              name: "recordId",
              value: record.id
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
                  "px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-medium text-white transition-colors"
              },
              "Verify & Promote"
            )
          )
        : null,

      // Invalidate
      record.status === "active" || record.status === "proposed"
        ? React.createElement(
            "form",
            { method: "POST", action: "/api/memory" },
            React.createElement("input", {
              type: "hidden",
              name: "action",
              value: "invalidate"
            }),
            React.createElement("input", {
              type: "hidden",
              name: "recordId",
              value: record.id
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
                  "px-3 py-1.5 rounded bg-rose-800 hover:bg-rose-700 text-xs font-medium text-white transition-colors"
              },
              "Invalidate"
            )
          )
        : null,

      // Promote Procedure to RuleSync Skill
      record.kind === "procedural" && record.status === "active"
        ? React.createElement(
            "form",
            { method: "POST", action: "/api/memory" },
            React.createElement("input", {
              type: "hidden",
              name: "action",
              value: "promote-skill"
            }),
            React.createElement("input", {
              type: "hidden",
              name: "recordId",
              value: record.id
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
                  "px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-xs font-medium text-white transition-colors"
              },
              "Promote to RuleSync Skill"
            )
          )
        : null
    )
  );
}

interface DataTableProps<T> {
  readonly data: readonly T[];
  readonly columns: readonly ColumnDef<T>[];
  readonly keyExtractor: (row: T) => string;
  readonly emptyMessage?: string | undefined;
}
