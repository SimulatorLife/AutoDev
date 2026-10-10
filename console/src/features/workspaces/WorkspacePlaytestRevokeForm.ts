"use client";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { workspacePath, workspacePlaytestApprovalPath } from "./paths.ts";

export interface WorkspacePlaytestRevokeFormProps {
  readonly workspaceId: string;
  readonly approval: WorkspacePlaytestApproval;
  readonly pending: boolean;
  readonly onSubmit: React.FormEventHandler<HTMLFormElement>;
}

/**
 * The operator form that revokes an active playtesting approval.
 *
 * It carries the approval's own `approvalId` and `revision` as hidden
 * optimistic-concurrency fields rather than letting the Runtime infer which
 * approval is being revoked: if another operator revoked or re-approved this
 * workspace since the page was rendered, the revision the Runtime holds no
 * longer matches the one this form was built from, and the Runtime refuses
 * the revocation as a conflict rather than silently retiring a different
 * approval than the one the operator reviewed. Submission remains a native
 * keyboard-operable form but is intercepted for an in-place same-origin POST;
 * the Runtime remains the authority for whether revocation succeeded.
 */
export function WorkspacePlaytestRevokeForm({
  workspaceId,
  approval,
  pending,
  onSubmit
}: WorkspacePlaytestRevokeFormProps): React.JSX.Element {
  return React.createElement(
    "form",
    {
      action: workspacePlaytestApprovalPath(workspaceId, true),
      method: "POST",
      onSubmit,
      "aria-busy": pending,
      "aria-label": `Revoke playtesting approval for ${workspaceId}`,
      className: "flex flex-col gap-3",
      "data-workspace-revoke-form": workspaceId
    },
    React.createElement("input", {
      type: "hidden",
      name: "workspaceId",
      value: workspaceId
    }),
    React.createElement("input", {
      type: "hidden",
      name: "approvalId",
      value: approval.approvalId
    }),
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: String(approval.revision)
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: workspacePath(workspaceId)
    }),
    React.createElement(TextField, {
      name: "reason",
      label: "Revocation reason",
      rows: 2,
      placeholder: "Build superseded; revoking before re-approving v2.",
      testId: "workspace-revoke-reason"
    }),
    React.createElement(
      Button,
      {
        type: "submit",
        variant: "destructive",
        ariaLabel: pending
          ? `Revoking playtesting approval for ${workspaceId}`
          : `Revoke playtesting approval for ${workspaceId}`,
        disabled: pending,
        dataAttributes: { "data-workspace-revoke-submit": workspaceId }
      },
      pending ? "Revoking…" : "Revoke approval"
    )
  );
}
