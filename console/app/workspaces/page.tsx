import type { Metadata } from "next";
import React from "react";

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
  const approvals = await readApprovals(
    workspaces.map((workspace) => workspace.id),
    config
  );
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Workspaces: workspaces.length } },
    React.createElement(WorkspacesView, { workspaces, approvals })
  );
}
