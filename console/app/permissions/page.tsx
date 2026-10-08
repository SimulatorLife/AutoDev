import type { Metadata } from "next";
import React from "react";

import { PermissionsView } from "../../src/features/permissions/PermissionsView.ts";
import {
  controlApiFailureCode,
  fetchPermissions
} from "../../src/lib/server/control-api.ts";
import { permissionsFromControlApi } from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Permissions"
};

export default async function PermissionsPage(): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/permissions");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("permission policy")
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
