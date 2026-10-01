import React from "react";

import { WorkspacesView } from "../../src/features/workspaces/WorkspacesView.ts";
import {
  controlApiFailureCode,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import { workspacesFromControlApi } from "../../src/lib/server/views.ts";
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
  const workspaces = workspacesFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Workspaces: workspaces.length } },
    React.createElement(WorkspacesView, { workspaces })
  );
}
