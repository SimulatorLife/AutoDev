import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";

import { isWorkspaceId } from "../../../../src/features/workspaces/paths.ts";
import { workspaceRequestReading } from "../../../../src/features/workspaces/workspace-usage.ts";
import { WorkspaceDetailView } from "../../../../src/features/workspaces/WorkspaceDetailView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../../../src/lib/control-failure.ts";
import {
  controlApiFailureCode,
  fetchWorkspacePlaytestApproval,
  fetchWorkspaces,
  fetchWorkspaceVisualPlaytestTargets
} from "../../../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../../../_console.ts";
import { readWorkspaceRequestSource } from "../../_requests.ts";

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

/**
 * The workspace the catalog confirmed, or the reason it could not be read.
 *
 * The reads are awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while they are on their way.
 */
async function WorkspaceDetailContent({
  section,
  catalog,
  approval,
  visualTargets,
  requestSource,
  id,
  query
}: {
  readonly section: CanonicalNavSection;
  readonly catalog: Promise<Awaited<ReturnType<typeof fetchWorkspaces>>>;
  readonly approval: Promise<
    Awaited<ReturnType<typeof fetchWorkspacePlaytestApproval>>
  >;
  readonly visualTargets: Promise<
    Awaited<ReturnType<typeof fetchWorkspaceVisualPlaytestTargets>>
  >;
  readonly requestSource: Promise<
    Awaited<ReturnType<typeof readWorkspaceRequestSource>>
  >;
  readonly id: string;
  readonly query: Record<string, string | string[] | undefined>;
}): Promise<React.JSX.Element> {
  const [workspacesResult, approvalResult, visualTargetsResult, source] =
    await Promise.all([catalog, approval, visualTargets, requestSource]);

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
      requests: workspaceRequestReading(source, id),
      controlFailed: isControlFailure(query.control),
      refusal: readControlRefusal(query.refusal)
    })
  );
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
  // The reads start here and are not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const catalog = fetchWorkspaces(config);
  const approval = fetchWorkspacePlaytestApproval(id, config);
  const visualTargets = fetchWorkspaceVisualPlaytestTargets(id, config);
  const requestSource = readWorkspaceRequestSource();
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(WorkspaceDetailContent, {
      section,
      catalog,
      approval,
      visualTargets,
      requestSource,
      id,
      query
    })
  );
}
