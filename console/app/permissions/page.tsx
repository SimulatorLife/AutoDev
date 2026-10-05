import React from "react";

import { PermissionsView } from "../../src/features/permissions/PermissionsView.ts";
import {
  controlApiFailureCode,
  fetchPermissions
} from "../../src/lib/server/control-api.ts";
import { permissionsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function PermissionsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/permissions");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read permission policy."
      })
    );
  }
  const result = await fetchPermissions(config);
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Permissions could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const { policy, roleMatrices } = permissionsFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Permissions: roleMatrices.length } },
    React.createElement(PermissionsView, { policy, roleMatrices })
  );
}
