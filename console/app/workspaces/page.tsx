import type { Metadata } from "next";
import React from "react";

import {
  type WorkspaceRequestLookup,
  workspaceRequestLookup,
  type WorkspaceRequestSource
} from "../../src/features/workspaces/workspace-usage.ts";
import {
  type WorkspaceApprovalLookup,
  WorkspacesView
} from "../../src/features/workspaces/WorkspacesView.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  fetchWorkspacePlaytestApproval,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import { loadOpenLITUsage } from "../../src/lib/server/openlit-usage.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspaces"
};

/**
 * Each configured workspace's most recent playtesting approval, read
 * independently per workspace because the Control API answers this fact
 * per workspace rather than embedding it in the catalog read above. A
 * workspace whose read failed is kept distinct (`"unavailable"`) from one
 * the Control API confirmed has no approval (`null`): one is missing
 * evidence, the other is an observed absence.
 */
async function readApprovals(
  workspaceIds: readonly string[],
  config: ControlApiConfig
): Promise<WorkspaceApprovalLookup> {
  const entries = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const result = await fetchWorkspacePlaytestApproval(workspaceId, config);
      return [
        workspaceId,
        result.kind === "ok" ? result.data.approval : ("unavailable" as const)
      ] as const;
    })
  );
  return new Map(entries);
}

/**
 * What the Usage read produced, as the three distinct claims the Requests
 * cell can make.
 *
 * A source the Console could not read is `unavailable`; a source that read
 * but produced no breakdown is `not-observed`. Keeping them apart is the point:
 * neither is a workspace that made no requests.
 */
function workspaceRequestSource(
  result: Awaited<ReturnType<typeof loadOpenLITUsage>>
): WorkspaceRequestSource {
  if (result.kind !== "ok") return { kind: "unavailable" };
  const breakdown = result.data.metrics.requestsByWorkspace;
  if (breakdown === null) return { kind: "not-observed" };
  return { kind: "observed", breakdown };
}

/**
 * Each workspace's logical-request count over the last 24 hours.
 *
 * The Usage telemetry groups logical routed requests by workspace, so one
 * read answers every row; asking per workspace would run one query per row
 * to read the same breakdown. A Usage source the Console could not read at
 * all leaves every workspace unavailable rather than empty -- an unread source
 * is not a source that observed nothing.
 */
async function readWorkspaceRequests(
  workspaceIds: readonly string[]
): Promise<WorkspaceRequestLookup> {
  const result = await loadOpenLITUsage({ range: "24H", values: {} });
  return workspaceRequestLookup(workspaceRequestSource(result), workspaceIds);
}

export default async function WorkspacesPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/workspaces");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("workspace configuration")
    );
  }
  const result = await fetchWorkspaces(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspaces could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  if (result.data.catalogStatus !== "valid") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title:
          result.data.catalogStatus === "invalid"
            ? "Workspace configuration is invalid"
            : "Workspace configuration is unavailable",
        code:
          result.data.catalogStatus === "invalid"
            ? "autodev_workspace_catalog_invalid"
            : "autodev_workspace_catalog_unavailable",
        message:
          result.data.catalogStatus === "invalid"
            ? "The workspace source could not be validated; no workspace count is inferred."
            : "The workspace source is missing or unreadable; no workspace count is inferred."
      })
    );
  }
  const workspaces = result.data.workspaces;
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const [approvals, requests] = await Promise.all([
    readApprovals(workspaceIds, config),
    readWorkspaceRequests(workspaceIds)
  ]);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Configured repository workspaces, execution scope, playtesting target approvals, and aggregate request usage.",
      counts: { Workspaces: workspaces.length }
    },
    React.createElement(WorkspacesView, { workspaces, approvals, requests })
  );
}
