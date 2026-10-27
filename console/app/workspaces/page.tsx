import type { Metadata } from "next";
import React from "react";

import { workspaceSaveOutcomeFromQuery } from "../../src/features/workspaces/configuration.ts";
import {
  type WorkspaceApprovalLookup,
  WorkspacesView
} from "../../src/features/workspaces/WorkspacesView.ts";
import { editorBaseRevisionFromQuery } from "../../src/lib/server/canonical-source.ts";
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
import { readWorkspaceRequests } from "./_requests.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspaces"
};

function firstSearchParam(
  raw: string | string[] | undefined
): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

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

export default async function WorkspacesPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const resolvedSearchParams = searchParams
    ? await searchParams
    : ({} as Record<string, string | string[] | undefined>);
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
  const saveOutcome = workspaceSaveOutcomeFromQuery(resolvedSearchParams.save);
  // A refused write leaves the control based on the revision it was filled
  // from, so the operator's edit is not silently paired with a catalog that
  // has since moved.
  const basedOn = editorBaseRevisionFromQuery(resolvedSearchParams.based);
  // The workspace the last write was about. It is resolved against the
  // declared workspaces rather than taken on trust: a query value that names
  // a workspace this target does not declare is not a workspace, and the
  // notice then says what it can without it.
  const savedWorkspace = workspaces.find(
    (workspace) =>
      workspace.id === firstSearchParam(resolvedSearchParams.workspace)
  )?.id;
  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts: { Workspaces: workspaces.length }
    },
    React.createElement(WorkspacesView, {
      workspaces,
      approvals,
      requests,
      revision: basedOn ?? result.data.revision,
      catalogStatus: result.data.catalogStatus,
      reconciliation: result.data.reconciliation,
      ...(saveOutcome === undefined ? {} : { saveOutcome }),
      ...(savedWorkspace === undefined ? {} : { savedWorkspace })
    })
  );
}
