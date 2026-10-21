import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
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
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Permissions"
};

export default function PermissionsPage(): React.JSX.Element {
  const { section, config } = readNodeContext("/permissions");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("permission policy")
    );
  }
  // The read starts here and is not awaited.
  const result = fetchPermissions(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(PermissionsContent, { section, result })
  );
}

/**
 * The permission policy the Runtime confirmed, or the reason it could not
 * answer.
 *
 * The read is awaited here, inside the page's own pending boundary. The shell
 * is rendered by the same component that read the data, so the navigation's
 * count arrives with the read instead of being resolved in the browser.
 */
async function PermissionsContent({
  section,
  result
}: {
  readonly section: CanonicalNavSection;
  readonly result: Promise<Awaited<ReturnType<typeof fetchPermissions>>>;
}): Promise<React.JSX.Element> {
  const settled = await result;
  if (settled.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Permissions could not be loaded",
        code: controlApiFailureCode(settled),
        message: settled.message
      })
    );
  }
  const { policy, roleMatrices } = permissionsFromControlApi(settled.data);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Canonical permission policy, effective role capability matrix, and MCP tool grants.",
      counts: { Permissions: roleMatrices.length }
    },
    React.createElement(PermissionsView, { policy, roleMatrices })
  );
}
