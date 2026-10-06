import type {
  EvidenceReference,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatus
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  FilterBar,
  FilterSearchField
} from "../../components/filters/FilterBar.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
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
  readonly total: number;
  readonly selectedRecord?: MemoryRecord | null | undefined;
  readonly history?: MemoryRecordHistory | null | undefined;
  readonly currentWorkspaceId: string;
  readonly currentQuery?: string | undefined;
  readonly currentKind?: string | undefined;
  readonly currentStatus?: string | undefined;
}

const NOT_OBSERVED_STATUS = "not-observed" as const;

const STATUS_VARIANT_MAP: Record<MemoryStatus, StatusBadgeVariant> = {
  active: "ready",
  proposed: "pending",
  invalidated: "invalid",
  superseded: "unavailable",
  uncertain: NOT_OBSERVED_STATUS
};

const KIND_COLORS: Record<MemoryKind, string> = {
  episodic: "bg-chart-4/15 text-chart-4 border-chart-4/40",
  semantic: "bg-chart-2/15 text-chart-2 border-chart-2/40",
  procedural: "bg-chart-3/15 text-chart-3 border-chart-3/40"
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
  total,
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
      weight: 180,
      cell: (record) =>
        React.createElement(
          "a",
          {
            href: `?tab=records&workspaceId=${encodeURIComponent(currentWorkspaceId)}&recordId=${encodeURIComponent(record.id)}`,
            className:
              "font-mono text-xs font-semibold text-accent hover:brightness-110 hover:underline",
            "data-memory-record-id": record.id
          },
          record.id
        )
    },
    {
      id: "kind",
      header: "Kind",
      weight: 120,
      cell: (record) =>
        React.createElement(
          "span",
          {
            className: `${TAG_SHAPE} font-mono font-medium ${KIND_COLORS[record.kind] ?? "bg-surface-raised text-fg-secondary border-border-strong"}`,
            "data-memory-kind": record.kind
          },
          record.kind
        )
    },
    {
      id: "status",
      header: "Lifecycle Status",
      weight: 140,
      cell: (record) =>
        React.createElement(StatusBadge, {
          status: STATUS_VARIANT_MAP[record.status] ?? NOT_OBSERVED_STATUS,
          label: record.status.charAt(0).toUpperCase() + record.status.slice(1)
        })
    },
    {
      id: "claim",
      header: "Claim Summary",
      cell: (record) =>
        React.createElement(
          "div",
          { className: "max-w-md truncate text-sm text-fg" },
          record.claim
        )
    },
    {
      id: "scope",
      header: "Scope",
      weight: 160,
      cell: (record) =>
        React.createElement(
          "span",
          {
            className:
              "font-mono text-xs text-fg-muted truncate max-w-[150px] inline-block"
          },
          formatScopeString(record.scope)
        )
    },
    {
      id: "updatedAt",
      header: "Updated",
      weight: 140,
      cell: (record) =>
        React.createElement(
          "span",
          { className: "text-xs text-fg-muted" },
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
      FilterBar,
      {
        label: "Record filters",
        preserved: [
          { name: "tab", value: "records" },
          { name: "workspaceId", value: currentWorkspaceId }
        ],
        submitTestId: "memory-filter",
        summary: `${records.length} of ${total} records`,
        dataAttributes: { "data-feature-filter": "records" }
      },
      React.createElement(FilterSearchField, {
        name: "query",
        defaultValue: currentQuery,
        label: "Search memory claims",
        placeholder: "Search memory claims...",
        testId: "memory-record-query"
      }),
      React.createElement(SelectField, {
        name: "kind",
        label: "Kind:",
        defaultValue: currentKind,
        testId: "memory-kind",
        options: [
          { value: "all", label: "All Kinds" },
          { value: "procedural", label: "Procedural" },
          { value: "semantic", label: "Semantic" },
          { value: "episodic", label: "Episodic" }
        ]
      }),
      React.createElement(SelectField, {
        name: "status",
        label: "Status:",
        defaultValue: currentStatus,
        testId: "memory-status",
        options: [
          { value: "all", label: "All Statuses" },
          { value: "active", label: "Active" },
          { value: "proposed", label: "Proposed" },
          { value: "invalidated", label: "Invalidated" },
          { value: "superseded", label: "Superseded" },
          { value: "uncertain", label: "Uncertain" }
        ]
      })
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
        "rounded-lg border border-accent/60 bg-selected p-6 flex flex-col gap-6 shadow-xl",
      "data-selected-record-panel": record.id
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
          React.createElement(EntityTitle, { mono: true }, record.id),
          React.createElement(
            "span",
            {
              className: `${TAG_SHAPE} font-mono font-medium ${KIND_COLORS[record.kind] ?? "bg-surface-raised text-fg-secondary border-border-strong"}`
            },
            record.kind
          ),
          React.createElement(StatusBadge, {
            status: STATUS_VARIANT_MAP[record.status] ?? NOT_OBSERVED_STATUS,
            label: record.status.toUpperCase()
          })
        ),
        React.createElement(
          "span",
          { className: "text-xs text-fg-muted font-mono" },
          `Scope: ${formatScopeString(record.scope)}`
        )
      ),
      React.createElement(ClosePanelLink, {
        href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}`
      })
    ),

    // Claim
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h4",
        {
          className: SECTION_HEADING_CLASS
        },
        "Durable Claim"
      ),
      React.createElement(
        "div",
        {
          className:
            "rounded-md border border-border bg-background p-4 font-mono text-sm text-fg leading-relaxed whitespace-pre-wrap"
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
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2"
        },
        React.createElement(
          "h4",
          {
            className: SECTION_HEADING_CLASS
          },
          "Validity State"
        ),
        React.createElement(
          "div",
          { className: "flex items-center gap-2 text-xs" },
          React.createElement("span", { className: "text-fg-muted" }, "State:"),
          React.createElement(
            "span",
            {
              className: `font-semibold ${record.validity.state === "verified" ? "text-success" : record.validity.state === "contradicted" ? "text-error" : "text-warning"}`
            },
            record.validity.state
          )
        ),
        record.validity.checkedAt
          ? React.createElement(
              "div",
              { className: "text-xs text-fg-muted" },
              `Checked at: ${new Date(record.validity.checkedAt).toLocaleString()}`
            )
          : null,
        record.validity.verificationSource
          ? React.createElement(
              "div",
              { className: "text-xs text-fg-muted font-mono" },
              `Verification source: ${record.validity.verificationSource}`
            )
          : null
      ),

      // Provenance
      React.createElement(
        "div",
        {
          className:
            "rounded border border-border bg-background/50 p-4 flex flex-col gap-2"
        },
        React.createElement(
          "h4",
          {
            className: SECTION_HEADING_CLASS
          },
          "Provenance & Citations"
        ),
        React.createElement(
          "div",
          { className: "text-xs text-fg-secondary" },
          `Sources: ${record.provenance.experienceIds.length} experiences`
        ),
        record.provenance.lastVerifiedAt
          ? React.createElement(
              "div",
              { className: "text-xs font-mono text-fg-muted" },
              `Last verified: ${new Date(record.provenance.lastVerifiedAt).toLocaleString()}`
            )
          : null,
        record.provenance.evidence && record.provenance.evidence.length > 0
          ? React.createElement(
              "div",
              { className: "flex flex-col gap-1 mt-1" },
              React.createElement(
                "span",
                { className: "text-xs text-fg-muted font-medium" },
                "Cited Evidence Files:"
              ),
              record.provenance.evidence.map(
                (ev: EvidenceReference, i: number) =>
                  React.createElement(
                    "span",
                    {
                      key: i,
                      className: `${TAG_SHAPE} truncate border-accent/40 bg-accent/15 font-mono text-accent`
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
              className: SECTION_HEADING_CLASS
            },
            "Lineage"
          ),
          record.supersedes?.length
            ? React.createElement(
                "div",
                { className: "flex items-center gap-2" },
                React.createElement(
                  "span",
                  { className: "text-fg-muted" },
                  "Supersedes:"
                ),
                record.supersedes.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}&recordId=${encodeURIComponent(id)}`,
                      className: "font-mono text-accent hover:underline"
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
                  { className: "text-fg-muted" },
                  "Superseded By:"
                ),
                record.supersededBy.map((id) =>
                  React.createElement(
                    "a",
                    {
                      key: id,
                      href: `?tab=records&workspaceId=${encodeURIComponent(workspaceId)}&recordId=${encodeURIComponent(id)}`,
                      className: "font-mono text-accent hover:underline"
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
              className: SECTION_HEADING_CLASS
            },
            "Transition History"
          ),
          React.createElement(
            "div",
            {
              className:
                "flex flex-col divide-y divide-border rounded border border-border bg-background/60"
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
                    status:
                      STATUS_VARIANT_MAP[t.toStatus] ?? NOT_OBSERVED_STATUS,
                    label: `${t.fromStatus ?? "none"} → ${t.toStatus}`
                  }),
                  t.reason
                    ? React.createElement(
                        "span",
                        { className: "text-fg-secondary" },
                        `(${t.reason})`
                      )
                    : null
                ),
                React.createElement(
                  "div",
                  {
                    className:
                      "flex items-center gap-3 text-fg-muted font-mono text-meta"
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
          "flex flex-wrap items-center gap-3 pt-4 border-t border-border"
      },
      React.createElement(
        "span",
        {
          className:
            "text-xs font-semibold uppercase tracking-wider text-fg-muted mr-2"
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
                  "px-3 py-1.5 rounded bg-success hover:brightness-110 text-xs font-medium text-fg-inverse transition-colors"
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
                  "px-3 py-1.5 rounded bg-error hover:brightness-110 text-xs font-medium text-fg-inverse transition-colors"
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
                  "px-3 py-1.5 rounded bg-chart-3 hover:brightness-110 text-xs font-medium text-fg-inverse transition-colors"
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
