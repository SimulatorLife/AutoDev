import type {
  ControlApiWorkspaceRecord,
  WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
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
  MONO_VALUE_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import {
  workspaceApprovalBadgeLabel,
  workspaceApprovalBadgeVariant,
  workspaceApprovalStatus
} from "./approval-status.ts";
import { workspacePath } from "./paths.ts";
import {
  workspaceAvailabilityBadgeLabel,
  workspaceAvailabilityBadgeVariant,
  workspaceConfigurationBadgeLabel,
  workspaceConfigurationBadgeVariant
} from "./workspace-health.ts";

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
 * `enabled` state, and `agentRoles` scope (`null` means not configured).
 *
 * Beside the configuration sit the two facts an operator needs to act on it.
 * `configuration` is the Control API's judgement of the canonical entry --
 * whether the role scope names roles the execution contract defines -- and
 * `runtime` is the runtime's live answer about whether it is currently
 * serving the workspace. The two are different authorities, so the view shows
 * them apart: an unobserved workspace reads `Not observed` and an idle one
 * reads `Idle`, because missing evidence and a measured zero are different
 * claims.
 *
 * Playtesting approval is a *different* fact, and one this view can report:
 * Workspaces owns the checkout approval boundary a game adapter runs
 * under, and the Control API answers it per workspace, so each row's badge
 * is a server-fetched, per-workspace read rather than an inferred summary.
 */

export interface WorkspacesViewProps {
  readonly workspaces: readonly ControlApiWorkspaceRecord[];
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

  const columns: ColumnDef<ControlApiWorkspaceRecord>[] = [
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
          NavigationLink,
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
          className: `border-border-strong bg-surface-raised font-mono ${MUTED_TEXT_CLASS}`,
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
          NavigationLink,
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
        // A scope that names a role AutoDev does not define is a configuration
        // fault, and it belongs in the cell that owns the scope: listing the
        // roles anyway would show a scope that excludes every agent that
        // could work here and say nothing about why.
        ws.configuration.status === "invalid-role-scope"
          ? React.createElement(StatusBadge, {
              status: workspaceConfigurationBadgeVariant(ws.configuration),
              label: workspaceConfigurationBadgeLabel(ws.configuration)
            })
          : React.createElement(
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
      cell: (ws) =>
        React.createElement(StatusBadge, {
          status: workspaceAvailabilityBadgeVariant(ws.runtime),
          label: workspaceAvailabilityBadgeLabel(ws.runtime)
        })
    }
  ];

  return React.createElement(
    PageBody,
    {
      feature: "workspaces",
      // True only when the runtime answered for at least one workspace. The
      // column is per-workspace, so this is the page-level summary of whether
      // any live evidence exists at all.
      attributes: {
        "data-workspace-availability-observed": workspaces.some(
          (workspace) => workspace.runtime.status === "observed"
        )
          ? "true"
          : "false"
      }
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
        subtitle: "Active checkout approvals"
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
      React.createElement<DataTableProps<ControlApiWorkspaceRecord>>(DataTable, {
        data: workspaces,
        columns,
        keyExtractor: (w: ControlApiWorkspaceRecord) => w.id,
        emptyMessage: "No workspace entries are configured."
      })
    )
  );
}
