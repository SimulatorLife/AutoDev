import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
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
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";
import { readWorkspaceRequests } from "./_requests.ts";

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
 * The workspace catalog, or the reason the Control API could not answer it.
 *
 * The catalog read is awaited here, below the page's own pending boundary, so
 * the pending shell is already on screen while it is on its way. The
 * approvals and the request usage are read from the catalog the read
 * answered, so they start once it has.
 */
async function WorkspacesContent({
  section,
  catalog,
  config
}: {
  readonly section: CanonicalNavSection;
  readonly catalog: Promise<Awaited<ReturnType<typeof fetchWorkspaces>>>;
  readonly config: ControlApiConfig;
}): Promise<React.JSX.Element> {
  const result = await catalog;
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

export default function WorkspacesPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/workspaces");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("workspace configuration")
    );
  }
  // The read starts here and is not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const catalog = fetchWorkspaces(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(WorkspacesContent, { section, catalog, config })
  );
}
