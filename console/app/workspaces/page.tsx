import React from "react";

import { WorkspacesView } from "../../src/features/workspaces/WorkspacesView.ts";
import {
  controlApiFailureCode,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/workspaces");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read workspace configuration."
      })
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
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Workspaces: workspaces.length } },
    React.createElement(WorkspacesView, { workspaces })
  );
}
