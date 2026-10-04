import type { WorkspaceEntry } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

/**
 * Workspaces resource view.
 *
 * Each workspace has a configured `id` (GitHub owner/repo), `baseBranch`,
 * `enabled` status, and `agentRoles` scope. Its actual availability/health is
 * a runtime concern that must be reported by an authoritative runtime probe;
 * until that adapter exists, the availability column renders `Unknown` rather
 * than `Available`.
 */

export interface WorkspacesViewProps {
  readonly workspaces: readonly WorkspaceEntry[];
}

export function WorkspacesView({
  workspaces
}: WorkspacesViewProps): React.JSX.Element {
  const enabledCount = workspaces.filter((w) => w.enabled).length;

  const columns: ColumnDef<WorkspaceEntry>[] = [
    {
      id: "id",
      header: "Repository / Workspace",
      cell: (ws) =>
        React.createElement(
          "span",
          { className: "font-semibold text-fg font-mono" },
          ws.id
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
              "text-xs font-mono text-fg-muted bg-surface-raised px-2 py-0.5 rounded border border-border-strong"
          },
          ws.baseBranch
        )
    },
    {
      id: "status",
      header: "Status",
      cell: (ws) =>
        React.createElement(StatusBadge, {
          status: ws.enabled ? "valid" : "unavailable",
          label: ws.enabled ? "Enabled" : "Disabled"
        })
    },
    {
      id: "agentRoles",
      header: "Role Scope",
      cell: (ws) =>
        React.createElement(
          "span",
          { className: "text-xs font-mono text-fg-secondary" },
          ws.agentRoles === null ? "All roles" : ws.agentRoles.join(", ")
        )
    },
    {
      id: "availability",
      header: "Availability",
      cell: () =>
        React.createElement(StatusBadge, {
          status: "unavailable",
          label: "Unknown"
        })
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "workspaces",
      "data-workspace-availability-observed": "false"
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-3 gap-4" },
      React.createElement(StatCard, {
        title: "Configured Workspaces",
        value: workspaces.length
      }),
      React.createElement(StatCard, {
        title: "Enabled Workspaces",
        value: enabledCount,
        subtitle: "Active workspace scope"
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
            "text-sm font-semibold uppercase tracking-wider text-fg-muted mb-3"
        },
        "Configured Workspaces"
      ),
      DataTable({
        data: workspaces,
        columns,
        keyExtractor: (w: WorkspaceEntry) => w.id,
        emptyMessage: "No workspace entries are configured."
      })
    )
  );
}
