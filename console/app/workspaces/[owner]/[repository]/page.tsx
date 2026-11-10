import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { workspaceSaveOutcomeFromQuery } from "../../../../src/features/workspaces/configuration.ts";
import { isWorkspaceId } from "../../../../src/features/workspaces/paths.ts";
import { WorkspaceDetailView } from "../../../../src/features/workspaces/WorkspaceDetailView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../../../src/lib/control-failure.ts";
import { editorBaseRevisionFromQuery } from "../../../../src/lib/server/canonical-source.ts";
import {
  controlApiFailureCode,
  fetchWorkspacePlaytestApproval,
  fetchWorkspaces,
  fetchWorkspaceVisualPlaytestTargets
} from "../../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../../_console.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params
}: {
  readonly params: Promise<{
    readonly owner: string;
    readonly repository: string;
  }>;
}): Promise<Metadata> {
  const { owner, repository } = await params;
  return { title: `${owner}/${repository} · Workspaces` };
}

export default async function WorkspaceDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{
    readonly owner: string;
    readonly repository: string;
  }>;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { owner, repository } = await params;
  const id = `${owner}/${repository}`;
  const { section, config } = readNodeContext("/workspaces");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("workspace configuration")
    );
  }
  if (!isWorkspaceId(id)) notFound();

  const query = (await searchParams) ?? {};
  // The Usage read is not among these. It is a twenty-four hour telemetry
  // aggregation that answers a question about one cell rather than about the
  // page, and it is the most expensive read the Console makes; the browser
  // reads it and the cell fills in when it answers.
  const [workspacesResult, approvalResult, visualTargetsResult] =
    await Promise.all([
      fetchWorkspaces(config),
      fetchWorkspacePlaytestApproval(id, config),
      fetchWorkspaceVisualPlaytestTargets(id, config)
    ]);

  if (workspacesResult.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace could not be loaded",
        code: controlApiFailureCode(workspacesResult),
        message: workspacesResult.message
      })
    );
  }
  if (workspacesResult.data.catalogStatus !== "valid") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Workspace configuration is unavailable",
        code: "autodev_workspace_catalog_unavailable",
        message:
          "The workspace source is missing or unreadable; this workspace cannot be confirmed."
      })
    );
  }
  const workspace = workspacesResult.data.workspaces.find(
    (entry) => entry.id === id
  );
  if (!workspace) notFound();

  // A refused write leaves the control based on the revision the edit was
  // written for rather than the revision the catalog has moved to, so the
  // operator's edit is not silently paired with a catalog it never saw.
  const basedOn = editorBaseRevisionFromQuery(query.based);
  const saveOutcome = workspaceSaveOutcomeFromQuery(query.save);

  return React.createElement(
    ConsolePageShell,
    { section },
    React.createElement(WorkspaceDetailView, {
      workspace,
      approval:
        approvalResult.kind === "ok" ? approvalResult.data.approval : null,
      approvalUnavailable:
        approvalResult.kind === "ok"
          ? undefined
          : {
              code: controlApiFailureCode(approvalResult),
              message: approvalResult.message
            },
      visualTargets:
        visualTargetsResult.kind === "ok"
          ? visualTargetsResult.data.targets
          : null,
      visualTargetsUnavailable:
        visualTargetsResult.kind === "ok"
          ? undefined
          : {
              code: controlApiFailureCode(visualTargetsResult),
              message: visualTargetsResult.message
            },
      controlFailed: isControlFailure(query.control),
      refusal: readControlRefusal(query.refusal),
      revision: basedOn ?? workspacesResult.data.revision,
      catalogStatus: workspacesResult.data.catalogStatus,
      reconciliation: workspacesResult.data.reconciliation,
      ...(saveOutcome === undefined ? {} : { saveOutcome })
    })
  );
}
