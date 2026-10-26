import type { Metadata } from "next";
import React from "react";

import {
  permissionPolicySaveNotice,
  permissionPolicySaveOutcomeFromQuery
} from "../../src/features/permissions/configuration.ts";
import { PERMISSIONS_PATH } from "../../src/features/permissions/paths.ts";
import { PermissionsView } from "../../src/features/permissions/PermissionsView.ts";
import { editorBaseRevisionFromQuery } from "../../src/lib/server/canonical-source.ts";
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

export default async function PermissionsPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const resolvedSearchParams = searchParams
    ? await searchParams
    : ({} as Record<string, string | string[] | undefined>);
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
    applied,
    appliedSource,
    roleMatrices
  } = permissionsFromControlApi(result.data);
  const outcome = permissionPolicySaveOutcomeFromQuery(
    resolvedSearchParams.save
  );
  // A refused write leaves the control based on the revision it was filled
  // from, so the operator's edit is not silently paired with a policy that
  // has since moved.
  const basedOn = editorBaseRevisionFromQuery(resolvedSearchParams.based);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      counts: { Permissions: roleMatrices.length }
    },
    React.createElement(PermissionsView, {
      policy,
      policyStatus,
      policyReason,
      revision: basedOn ?? revision,
      applied,
      appliedSource,
      roleMatrices,
      returnTo: PERMISSIONS_PATH
    }),
    permissionPolicySaveNotice(outcome)
  );
}
