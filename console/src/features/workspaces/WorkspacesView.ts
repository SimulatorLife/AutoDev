import type { WorkspaceEntry } from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { PathText } from "../../components/tables/PathText.ts";
import {
  MONO_ID_CLASS,
  MONO_VALUE_CLASS
} from "../../components/ui/text-classes.ts";

/**
 * Workspaces resource view.
 *
 * Each workspace has a configured `id` (GitHub owner/repo), `baseBranch`,
 * `enabled` state, and `agentRoles` scope (`null` means not configured). Its
 * actual availability/health is a runtime concern that must be reported by an
 * authoritative probe; until that adapter exists, availability is `Not observed`.
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
      align: "path",
      weight: 220,
      // Wraps between `owner` and `name` instead of cutting. Measured against
      // real data, "SimulatorLife/Colourful-Life" was cut with nothing to
      // recover it; the two halves are exactly the break points it wants.
      cell: (ws) =>
        React.createElement(PathText, { path: ws.id, className: MONO_ID_CLASS })
    },
    {
      id: "baseBranch",
      header: "Base Branch",
      weight: 180,
      cell: (ws) =>
        React.createElement(Tag, {
          className:
            "border-border-strong bg-surface-raised font-mono text-fg-muted",
          children: ws.baseBranch
        })
    },
    {
      id: "enablement",
      header: "Enablement",
      weight: 140,
      cell: (ws) =>
        React.createElement(StatusBadge, {
          status: "configured",
          label: ws.enabled ? "Enabled" : "Disabled"
        })
    },
    {
      id: "agentRoles",
      header: "Role Scope",
      weight: 200,
      cell: (ws) =>
        React.createElement(
          "span",
          {
            className: MONO_VALUE_CLASS,
            "data-role-scope":
              ws.agentRoles === null
                ? "not-configured"
                : ws.agentRoles.length === 0
                  ? "empty"
                  : "configured"
          },
          ws.agentRoles === null
            ? "Not configured"
            : ws.agentRoles.length === 0
              ? "No roles assigned"
              : ws.agentRoles.join(", ")
        )
    },
    {
      id: "availability",
      header: "Availability",
      weight: 160,
      cell: () =>
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS
        })
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "workspaces",
      attributes: { "data-workspace-availability-observed": "false" }
    },
    React.createElement(
      StatGrid,
      { columns: 2 },
      React.createElement(StatCard, {
        title: "Enabled Workspaces",
        value: enabledCount,
        subtitle: "Configuration, not runtime availability"
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
          className: SECTION_HEADING_CLASS
        },
        "Configured Workspaces"
      ),
      React.createElement<DataTableProps<WorkspaceEntry>>(DataTable, {
        data: workspaces,
        columns,
        keyExtractor: (w: WorkspaceEntry) => w.id,
        emptyMessage: "No workspace entries are configured."
      })
    )
  );
}
