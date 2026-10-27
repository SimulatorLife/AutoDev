import type {
  ControlApiWorkspaceRecord,
  ReconciliationView,
  WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import {
  countValue,
  scopedCount
} from "../../components/status/observed-count.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { PathText } from "../../components/tables/PathText.ts";
import { namedAfterVisible } from "../../components/ui/accessible-name.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_ID_CLASS
} from "../../components/ui/text-classes.ts";
import {
  workspaceApprovalBadgeLabel,
  workspaceApprovalBadgeVariant,
  type WorkspaceApprovalStatus,
  workspaceApprovalStatus
} from "./approval-status.ts";
import {
  workspaceConfigurationSaveNotice,
  type WorkspaceConfigurationSaveOutcome
} from "./configuration.ts";
import { workspacePath, WORKSPACES_PATH } from "./paths.ts";
import {
  workspaceAvailabilityBadgeLabel,
  workspaceAvailabilityBadgeVariant
} from "./workspace-health.ts";
import {
  type WorkspaceRequestLookup,
  workspaceRequestValue
} from "./workspace-usage.ts";
import { WorkspaceConfigurationForm } from "./WorkspaceConfigurationForm.ts";

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
 * One workspace's approval state, read the way the table row reads it.
 *
 * The row's badge and the count card above the table are two readings of the
 * same fact, so they read it through one function: a workspace whose approval
 * the Control API could not answer is `unavailable` in the badge and in the
 * count, never "not approved" in one place and "unreadable" in the other.
 */
function workspaceApprovalOf(
  approvals: WorkspaceApprovalLookup,
  workspaceId: string
): WorkspaceApprovalStatus {
  const approval = approvals.get(workspaceId);
  if (approval === undefined || approval === "unavailable") {
    return "unavailable";
  }
  return workspaceApprovalStatus(approval);
}

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
 *
 * Aggregate usage is a fourth fact, from a fourth authority: the Usage
 * telemetry store groups logical routed requests by workspace. It is read once
 * for the whole page rather than per workspace, because one breakdown answers
 * every row. A workspace the breakdown does not report reads as unobserved
 * rather than zero when the breakdown was truncated, and a measured zero stays
 * a measured zero -- the two are different claims about the same cell.
 */

export interface WorkspacesViewProps {
  readonly workspaces: readonly ControlApiWorkspaceRecord[];
  readonly approvals: WorkspaceApprovalLookup;
  readonly requests: WorkspaceRequestLookup;
  /**
   * The revision the canonical catalog was read at.
   *
   * It is the handle a write is compared against, so the control on every row
   * carries it: a write decided on a catalog that has since moved is refused
   * rather than applied over the newer catalog.
   */
  readonly revision: string | null;
  /** The status of the canonical catalog the read came from. */
  readonly catalogStatus: "valid" | "invalid" | "unavailable";
  /**
   * The Runtime's desired-vs-actual view of the canonical catalog.
   *
   * The catalog is the configuration this list edits, so the list shows what
   * the Runtime observed about it: converged, pending or not observed, with
   * the operation history behind it.
   */
  readonly reconciliation?: ReconciliationView | undefined;
  /** How the last write to a workspace's configuration ended. */
  readonly saveOutcome?: WorkspaceConfigurationSaveOutcome | undefined;
  /**
   * The workspace the last write was about.
   *
   * The list presents every workspace's configuration at once, so a notice
   * that did not name its workspace would leave the operator to work out
   * which of the edits on the page it was talking about.
   */
  readonly savedWorkspace?: string | undefined;
}

export function WorkspacesView({
  workspaces,
  approvals,
  requests,
  revision,
  catalogStatus,
  reconciliation,
  saveOutcome,
  savedWorkspace
}: WorkspacesViewProps): React.JSX.Element {
  const enabledCount = workspaces.filter((w) => w.enabled).length;
  // An approval the Control API could not read is not an approval that was
  // refused: the row's badge says "Unavailable", and the card below the table
  // used to disagree with it by counting the same workspace as "not approved".
  // So the count is a number only when every workspace's approval was read.
  const approvalStatuses = workspaces.map((workspace) =>
    workspaceApprovalOf(approvals, workspace.id)
  );
  const approvedCount = scopedCount(
    approvalStatuses,
    (status) => status !== "unavailable",
    (status) => status === "active"
  );

  const columns: ColumnDef<ControlApiWorkspaceRecord>[] = [
    {
      id: "id",
      header: "Repository / Workspace",
      align: "path",
      // The header needs 117px and the path wraps between `owner` and `name`,
      // so this column had 123px more than it needs. That paid for the
      // Availability column's badge, which was cut to "Not obse…": a badge is
      // an atomic status word, and a column that cannot fit one is a
      // column-width problem.
      weight: 226,
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
      // The canonical configuration is edited on the row, not summarised on
      // it: this is the surface that writes it, and the row's control is the
      // same control the workspace's own page carries.
      id: "configuration",
      header: "Configuration",
      weight: 392,
      cell: (ws) =>
        React.createElement(WorkspaceConfigurationForm, {
          workspace: ws,
          revision,
          catalogStatus,
          returnTo: WORKSPACES_PATH,
          compact: true
        })
    },
    {
      id: "playtestingApproval",
      header: "Playtesting Approval",
      weight: 206,
      cell: (ws) => {
        const status = workspaceApprovalOf(approvals, ws.id);
        return React.createElement(
          NavigationLink,
          {
            href: workspacePath(ws.id),
            // The name begins with the state the badge shows.
            //
            // The link's content is the approval's state, and a stated name
            // replaces the content: "Open playtesting approval for <workspace>"
            // said what the link did and never said whether the workspace was
            // approved, so the state was reachable by sight alone.
            "aria-label": namedAfterVisible(
              workspaceApprovalBadgeLabel(status),
              `Open playtesting approval for ${ws.id}`
            )
          },
          React.createElement(StatusBadge, {
            status: workspaceApprovalBadgeVariant(status),
            label: workspaceApprovalBadgeLabel(status)
          })
        );
      }
    },
    {
      id: "availability",
      header: "Availability",
      // The badge needs 78px for "Not observed" and 34px more for the badge's
      // own chrome -- the padding, the border and the state dot -- and the cell
      // adds 32px of shared inset, so 144px is the floor. At 132 the badge
      // was cut to "Not obse…", which is the one thing a status badge must not
      // be: a state the operator cannot read is a state the page has not told
      // them. The 14px came from the Repository / Workspace column, which had
      // 123px more than its header and its wrapped path need.
      weight: 146,
      cell: (ws) =>
        React.createElement(StatusBadge, {
          status: workspaceAvailabilityBadgeVariant(ws.runtime),
          label: workspaceAvailabilityBadgeLabel(ws.runtime)
        })
    },
    {
      id: "requests",
      header: "Requests",
      headerHelp:
        "Logical routed requests attributed to this workspace in the last 24 hours. A request that carried no workspace attribution is not counted in any workspace, so these counts do not have to add up to the total.",
      // The label needs 71px and its help marker 16px more, and the cell adds
      // 32px of shared inset, so 125px is the floor. At 118 the marker fell to
      // a line of its own under the label it explains, and the header row grew
      // 15px -- the same header measuring 35.5px on every other page and
      // 50.5px here.
      weight: 136,
      cell: (ws) => workspaceRequestValue(requests.get(ws.id))
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
        value: countValue(approvedCount),
        subtitle: approvedCount.observed
          ? "Active checkout approvals"
          : "Approval state was not observed"
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
      workspaceConfigurationSaveNotice(saveOutcome, savedWorkspace),
      reconciliation === undefined
        ? null
        : React.createElement(ReconciliationPanel, {
            status: reconciliation.status,
            history: reconciliation.history
          }),
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Configured Workspaces"
      ),
      React.createElement<DataTableProps<ControlApiWorkspaceRecord>>(
        DataTable,
        {
          data: workspaces,
          columns,
          keyExtractor: (w: ControlApiWorkspaceRecord) => w.id,
          emptyMessage: "No workspace entries are configured."
        }
      )
    )
  );
}
