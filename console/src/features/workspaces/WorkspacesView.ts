import React from "react";

import type { WorkspaceEntry } from "../../../../core/src/index.ts";
import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { type ColumnDef, DataTable } from "../../components/tables/DataTable.ts";

export interface WorkspacesViewProps {
  readonly workspaces: readonly WorkspaceEntry[];
}

export function WorkspacesView({
  workspaces
}: WorkspacesViewProps): React.JSX.Element {
  const totalWeight = workspaces.reduce((acc, w) => acc + w.weight, 0);

  const columns: ColumnDef<WorkspaceEntry>[] = [
    {
      id: "name",
      header: "Repository / Workspace",
      cell: (ws) =>
        React.createElement(
          "span",
          { className: "font-semibold text-slate-100 font-mono" },
          ws.name
        )
    },
    {
      id: "baseBranch",
      header: "Base Branch",
      cell: (ws) =>
        React.createElement(
          "span",
          {
            className:
              "text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700"
          },
          ws.baseBranch
        )
    },
    {
      id: "weight",
      header: "Scheduling Weight",
      cell: (ws) =>
        React.createElement(
          "span",
          { className: "text-xs font-semibold text-emerald-400 font-mono" },
          `${ws.weight} (${totalWeight > 0 ? Math.round((ws.weight / totalWeight) * 100) : 0}%)`
        )
    },
    {
      id: "status",
      header: "Status",
      cell: () =>
        React.createElement(StatusBadge, {
          status: "ready",
          label: "Available"
        })
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "workspaces" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, { title: "Configured Workspaces", value: workspaces.length }),
      React.createElement(StatCard, {
        title: "Total Weight",
        value: totalWeight,
        subtitle: "Deterministic routing"
      }),
      React.createElement(StatCard, {
        title: "Tenancy Model",
        value: "Single-user",
        subtitle: "Workspaces, not Projects"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className:
            "text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3"
        },
        "Configured Workspaces"
      ),
      DataTable({
        data: workspaces,
        columns,
        keyExtractor: (w: WorkspaceEntry) => w.name
      })
    )
  );
}
