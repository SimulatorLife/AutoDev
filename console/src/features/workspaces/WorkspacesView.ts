import type {
  WorkspaceEntry,
  WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
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
  ENTITY_LINK_CLASS,
  MONO_ID_CLASS,
  MONO_VALUE_CLASS
} from "../../components/ui/text-classes.ts";
import {
  workspaceApprovalBadgeLabel,
  workspaceApprovalBadgeVariant,
  workspaceApprovalStatus
} from "./approval-status.ts";
import { workspacePath } from "./paths.ts";

/**
 * One workspace's most recently read playtesting approval, keyed by
 * workspace id. `"unavailable"` is distinct from `null`: the Control API
 * failing to answer this workspace's approval read is not the same claim as
 * it answering "no approval exists".
 */
export type WorkspaceApprovalLookup = ReadonlyMap<
  string,
  WorkspacePlaytestApproval | null | "unavailable"
>;

/**
 * Workspaces resource view.
 *
 * Each workspace has a configured `id` (GitHub owner/repo), `baseBranch`,
 * `enabled` state, and `agentRoles` scope (`null` means not configured). Its
 * actual availability/health is a runtime concern that must be reported by an
 * authoritative probe; until that adapter exists, availability is `Not observed`.
 *
 * Playtesting approval is a *different* fact, and one this view can report:
 * Workspaces owns the exact-build approval boundary a game adapter runs
 * under, and the Control API answers it per workspace, so each row's badge
 * is a server-fetched, per-workspace read rather than an inferred summary.
 */

export interface WorkspacesViewProps {
  readonly workspaces: readonly WorkspaceEntry[];
  readonly approvals: WorkspaceApprovalLookup;
}

export function WorkspacesView({
  workspaces,
  approvals
}: WorkspacesViewProps): React.JSX.Element {
  const enabledCount = workspaces.filter((w) => w.enabled).length;
  const approvedCount = workspaces.filter((w) => {
    const approval = approvals.get(w.id);
    return (
      approval !== undefined &&
      approval !== "unavailable" &&
      approval !== null &&
      approval.revokedAt === null
    );
  }).length;

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
        React.createElement(
          "a",
          {
            href: workspacePath(ws.id),
            className: ENTITY_LINK_CLASS,
            "aria-label": `Open workspace ${ws.id}`
          },
          React.createElement(PathText, {
            path: ws.id,
            className: MONO_ID_CLASS
          })
        )
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
      id: "playtestingApproval",
      header: "Playtesting Approval",
      weight: 206,
      cell: (ws) => {
        const approval = approvals.get(ws.id);
        const status =
          approval === undefined || approval === "unavailable"
            ? "unavailable"
            : workspaceApprovalStatus(approval);
        return React.createElement(
          "a",
          {
            href: workspacePath(ws.id),
            "aria-label": `Open playtesting approval for ${ws.id}`
          },
          React.createElement(StatusBadge, {
            status: workspaceApprovalBadgeVariant(status),
            label: workspaceApprovalBadgeLabel(status)
          })
        );
      }
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
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Enabled Workspaces",
        value: enabledCount,
        subtitle: "Configuration, not runtime availability"
      }),
      React.createElement(StatCard, {
        title: "Approved for Playtesting",
        value: approvedCount,
        subtitle: "Active exact-build approvals"
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
