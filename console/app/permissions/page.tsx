import type { Metadata } from "next";
import React from "react";

import {
  PERMISSIONS_PATH,
  PermissionsView
} from "../../src/features/permissions/index.ts";
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
  const { section, config } = readNodeContext(PERMISSIONS_PATH);
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
  const {
    policy,
    policyStatus,
    policyReason,
    revision,
    sourceText,
    applied,
    appliedSource,
    roleMatrices,
    executionContractObserved
  } = permissionsFromControlApi(result.data);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      // The badge counts the role matrices, and the matrices are the execution
      // contract's roles. A contract nobody read leaves no matrices, and a
      // badge reading 0 would claim the contract declares no role.
      ...(executionContractObserved
        ? { counts: { Permissions: roleMatrices.length } }
        : {})
    },
    React.createElement(PermissionsView, {
      policy,
      policyStatus,
      policyReason,
      revision,
      sourceText,
      applied,
      appliedSource,
      roleMatrices,
      executionContractObserved
    })
  );
}
