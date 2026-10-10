"use client";

import {
  assertWorkspacePlaytestApproval,
  type ControlApiWorkspacePlaytestApprovalResponse,
  type WorkspaceEntry,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";
import React from "react";

import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import {
  ControlFailureNotice,
  isControlRefusalReason
} from "../../components/status/ControlFailureNotice.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import {
  workspaceApprovalBadgeLabel,
  workspaceApprovalBadgeVariant,
  workspaceApprovalStatus
} from "./approval-status.ts";
import { WORKSPACE_PLAYTEST_LIMIT_FIELDS } from "./limits-fields.ts";
import { WORKSPACES_PATH } from "./paths.ts";
import { WorkspacePlaytestApprovalForm } from "./WorkspacePlaytestApprovalForm.ts";
import { WorkspacePlaytestRevokeForm } from "./WorkspacePlaytestRevokeForm.ts";

export interface WorkspaceApprovalUnavailable {
  readonly code: string;
  readonly message: string;
}

export interface WorkspaceDetailViewProps {
  readonly workspace: WorkspaceEntry;
  /** `null` when read, but no approval has ever been granted. */
  readonly approval: WorkspacePlaytestApproval | null;
  /** Set instead of `approval` when the Control API read itself failed. */
  readonly approvalUnavailable?: WorkspaceApprovalUnavailable | undefined;
  readonly controlFailed?: boolean | undefined;
  readonly refusal?:
    React.ComponentProps<typeof ControlFailureNotice>["refusal"] | undefined;
}

function IdentityPanel({
  approval
}: {
  readonly approval: WorkspacePlaytestApproval;
}): React.JSX.Element {
  return React.createElement(
    DetailGrid,
    { columns: 2, label: "Approved identity and command" },
    React.createElement(
      DetailValue,
      { label: "Checkout root" },
      approval.checkoutRoot
    ),
    React.createElement(
      DetailValue,
      { label: "Working directory" },
      approval.workingDirectory
    ),
    React.createElement(DetailValue, { label: "Build SHA" }, approval.buildSha),
    React.createElement(
      DetailValue,
      { label: "Game build" },
      approval.gameBuild
    ),
    React.createElement(
      DetailValue,
      { label: "Playtest config hash" },
      approval.playtestConfigHash
    ),
    React.createElement(
      DetailValue,
      { label: "Adapter image digest" },
      approval.adapterImageDigest
    ),
    React.createElement(
      DetailValue,
      { label: "Adapter command", rowClassName: "sm:col-span-2" },
      approval.adapterCommand.join(" ")
    ),
    React.createElement(
      DetailValue,
      { label: "Allowed scenarios" },
      approval.allowedScenarios.join(", ")
    ),
    React.createElement(
      DetailValue,
      { label: "Allowed policies" },
      approval.allowedPolicies.join(", ")
    ),
    React.createElement(
      DetailValue,
      { label: "Retention" },
      `${approval.retentionDays} days`
    ),
    React.createElement(
      DetailValue,
      { label: "Issue reporting" },
      approval.issueReporting
    ),
    React.createElement(
      DetailValue,
      { label: "Human study" },
      approval.humanStudyAllowed ? "Allowed" : "Not allowed"
    ),
    React.createElement(
      DetailValue,
      { label: "Approved" },
      `${approval.approvedAt} by ${approval.approvedBy}`
    )
  );
}

function LimitsPanel({
  approval
}: {
  readonly approval: WorkspacePlaytestApproval;
}): React.JSX.Element {
  return React.createElement(
    DetailGrid,
    { columns: 3, label: "Approved resource limits" },
    ...WORKSPACE_PLAYTEST_LIMIT_FIELDS.map((field) =>
      React.createElement(
        DetailValue,
        { key: field.name, label: field.label },
        String(approval.limits[field.name])
      )
    )
  );
}

function RevocationNotice({
  approval
}: {
  readonly approval: WorkspacePlaytestApproval;
}): React.JSX.Element {
  return React.createElement(
    DetailGrid,
    { columns: 3, label: "Revocation" },
    React.createElement(
      DetailValue,
      { label: "Revoked" },
      `${approval.revokedAt ?? ""} by ${approval.revokedBy ?? ""}`
    ),
    React.createElement(
      DetailValue,
      { label: "Reason" },
      approval.revocationReason ?? ""
    )
  );
}

function DisabledApprovalNotice(): React.JSX.Element {
  return React.createElement(
    "p",
    {
      className: CALLOUT_WARNING_CLASS,
      "data-workspace-approval-blocked": "disabled",
      role: "status"
    },
    "This workspace is disabled. A disabled workspace cannot receive a new playtesting approval; re-enable it in configuration first."
  );
}

function ApprovalUnavailableNotice({
  unavailable
}: {
  readonly unavailable: WorkspaceApprovalUnavailable;
}): React.JSX.Element {
  return React.createElement(
    "p",
    {
      className: CALLOUT_WARNING_CLASS,
      role: "alert",
      "data-workspace-approval-unavailable": unavailable.code
    },
    `Playtesting approval status could not be loaded (${unavailable.code}): ${unavailable.message}`
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalStateFromResponse(
  value: unknown,
  workspaceId: string
): ControlApiWorkspacePlaytestApprovalResponse | null {
  if (
    !isRecord(value) ||
    value.schema !== "autodev-control-workspace-playtest-approval-v1" ||
    value.workspaceId !== workspaceId ||
    typeof value.workspaceEnabled !== "boolean" ||
    (value.approval !== null && !isRecord(value.approval))
  ) {
    return null;
  }
  try {
    if (value.approval !== null) {
      assertWorkspacePlaytestApproval(value.approval);
      if (value.approval.workspaceId !== workspaceId) return null;
    }
  } catch {
    return null;
  }
  return value as unknown as ControlApiWorkspacePlaytestApprovalResponse;
}

function approvalMutationResult(
  value: unknown,
  workspaceId: string
): {
  readonly kind: "ok" | "refused";
  readonly state: ControlApiWorkspacePlaytestApprovalResponse | null;
  readonly refusal?: React.ComponentProps<
    typeof ControlFailureNotice
  >["refusal"];
} | null {
  if (!isRecord(value)) return null;
  if (value.kind === "ok") {
    const state = approvalStateFromResponse(value.data, workspaceId);
    return state === null ? null : { kind: "ok", state };
  }
  if (value.kind !== "refused") return null;
  const state =
    value.currentApproval === undefined
      ? null
      : approvalStateFromResponse(value.currentApproval, workspaceId);
  if (value.currentApproval !== undefined && state === null) return null;
  const refusal = isControlRefusalReason(value.refusal)
    ? value.refusal
    : undefined;
  return {
    kind: "refused",
    state,
    ...(refusal === undefined ? {} : { refusal })
  };
}

export function WorkspaceDetailView({
  workspace,
  approval,
  approvalUnavailable,
  controlFailed,
  refusal
}: WorkspaceDetailViewProps): React.JSX.Element {
  const [currentApproval, setCurrentApproval] = React.useState(approval);
  const [currentWorkspaceEnabled, setCurrentWorkspaceEnabled] = React.useState(
    workspace.enabled
  );
  const [currentUnavailable, setCurrentUnavailable] =
    React.useState(approvalUnavailable);
  const [currentControlFailed, setCurrentControlFailed] = React.useState(
    controlFailed === true
  );
  const [currentRefusal, setCurrentRefusal] = React.useState(refusal);
  const [pending, setPending] = React.useState(false);
  const pendingMutationRef = React.useRef(false);
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    setCurrentApproval(approval);
    setCurrentWorkspaceEnabled(workspace.enabled);
    setCurrentUnavailable(approvalUnavailable);
    setCurrentControlFailed(controlFailed === true);
    setCurrentRefusal(refusal);
  }, [
    workspace.id,
    workspace.enabled,
    approval,
    approvalUnavailable,
    controlFailed,
    refusal
  ]);

  const submitMutation: React.FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();
    if (pendingMutationRef.current) return;
    pendingMutationRef.current = true;
    const form = event.currentTarget;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form).entries()) {
      if (typeof value === "string") body.append(name, value);
    }
    setPending(true);
    setAnnouncement("");
    setCurrentControlFailed(false);
    setCurrentRefusal(undefined);

    void (async () => {
      try {
        const response = await fetch(form.action, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded"
          },
          body: body.toString()
        });
        const isRevocation = form.dataset.workspaceRevokeForm !== undefined;
        const raw: unknown = await response.json();
        const result = approvalMutationResult(raw, workspace.id);
        if (result === null) {
          throw new TypeError(
            "Workspace approval route returned an invalid state."
          );
        }
        if (response.ok && result.kind === "ok") {
          if (result.state === null || result.state.approval === null) {
            throw new TypeError(
              "Workspace mutation response omitted its approval."
            );
          }
          const approvalIsRevoked = result.state.approval.revokedAt !== null;
          if (approvalIsRevoked !== isRevocation) {
            throw new TypeError(
              "Workspace mutation response has the wrong approval state."
            );
          }
          setCurrentApproval(result.state.approval);
          setCurrentWorkspaceEnabled(result.state.workspaceEnabled);
          setCurrentUnavailable(undefined);
          setAnnouncement(
            isRevocation
              ? "Playtesting approval was revoked."
              : "Playtesting approval is active."
          );
          return;
        }
        if (result.state !== null) {
          setCurrentApproval(result.state.approval);
          setCurrentWorkspaceEnabled(result.state.workspaceEnabled);
          setCurrentUnavailable(undefined);
        }
        setCurrentControlFailed(true);
        setCurrentRefusal(result.refusal);
        setAnnouncement("Playtesting approval could not be confirmed.");
      } catch {
        setCurrentControlFailed(true);
        setCurrentRefusal(undefined);
        setAnnouncement(
          "Playtesting approval could not be confirmed. Check the current state before retrying."
        );
      } finally {
        pendingMutationRef.current = false;
        setPending(false);
      }
    })();
  };

  const status =
    currentUnavailable === undefined
      ? workspaceApprovalStatus(currentApproval)
      : "unavailable";

  let approvalBody: React.ReactNode;
  if (currentUnavailable !== undefined) {
    approvalBody = React.createElement(ApprovalUnavailableNotice, {
      unavailable: currentUnavailable
    });
  } else if (currentApproval === null) {
    approvalBody = React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "p",
        {
          className: MUTED_META_CLASS,
          "data-workspace-approval-state": "none"
        },
        "No playtesting approval has been granted for this workspace."
      ),
      currentWorkspaceEnabled
        ? React.createElement(WorkspacePlaytestApprovalForm, {
            key: `${workspace.id}:none`,
            workspaceId: workspace.id,
            priorApproval: null,
            pending,
            onSubmit: submitMutation
          })
        : React.createElement(DisabledApprovalNotice)
    );
  } else if (currentApproval.revokedAt === null) {
    approvalBody = React.createElement(
      React.Fragment,
      null,
      currentWorkspaceEnabled
        ? null
        : React.createElement(
            "p",
            {
              className: CALLOUT_WARNING_CLASS,
              role: "status",
              "data-workspace-approval-blocked": "disabled-active"
            },
            "This workspace is disabled. Its approval record remains active, but the disabled workspace cannot run Playtests; re-enable the workspace or revoke the approval."
          ),
      React.createElement(IdentityPanel, { approval: currentApproval }),
      React.createElement(LimitsPanel, { approval: currentApproval }),
      React.createElement(
        "div",
        {
          className: "mt-2",
          "data-workspace-approval-state": "active"
        },
        React.createElement(WorkspacePlaytestRevokeForm, {
          key: `${workspace.id}:${currentApproval.revision}`,
          workspaceId: workspace.id,
          approval: currentApproval,
          pending,
          onSubmit: submitMutation
        })
      )
    );
  } else {
    approvalBody = React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "p",
        {
          className: MUTED_META_CLASS,
          "data-workspace-approval-state": "revoked"
        },
        "The most recent playtesting approval for this workspace was revoked."
      ),
      React.createElement(IdentityPanel, { approval: currentApproval }),
      React.createElement(LimitsPanel, { approval: currentApproval }),
      React.createElement(RevocationNotice, { approval: currentApproval }),
      React.createElement(
        "div",
        { className: "mt-2" },
        currentWorkspaceEnabled
          ? React.createElement(WorkspacePlaytestApprovalForm, {
              key: `${workspace.id}:${currentApproval.revision}`,
              workspaceId: workspace.id,
              priorApproval: currentApproval,
              pending,
              onSubmit: submitMutation
            })
          : React.createElement(DisabledApprovalNotice)
      )
    );
  }

  return React.createElement(
    PageBody,
    { feature: "workspace-detail" },
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS },
      React.createElement(Breadcrumbs, {
        items: [
          { label: "Workspaces", href: WORKSPACES_PATH },
          { label: workspace.id }
        ]
      }),
      React.createElement(
        "div",
        { className: "flex flex-wrap items-start justify-between gap-4" },
        React.createElement(
          "div",
          null,
          React.createElement(
            "p",
            { className: ENTITY_EYEBROW_CLASS },
            "Workspace"
          ),
          React.createElement(EntityTitle, undefined, workspace.id)
        ),
        React.createElement(StatusBadge, {
          status: "configured",
          label: currentWorkspaceEnabled ? "Enabled" : "Disabled"
        })
      )
    ),
    currentControlFailed
      ? React.createElement(ControlFailureNotice, { refusal: currentRefusal })
      : null,
    React.createElement(
      "p",
      {
        role: "status",
        "aria-live": "polite",
        "data-workspace-approval-announcement": true
      },
      announcement
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "data-section": "workspace-playtesting-approval"
      },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center justify-between gap-3" },
        React.createElement(
          "h2",
          { className: SECTION_HEADING_CLASS },
          "Playtesting approval"
        ),
        React.createElement(StatusBadge, {
          status: workspaceApprovalBadgeVariant(status),
          label: workspaceApprovalBadgeLabel(status)
        })
      ),
      React.createElement(
        "div",
        { className: "mt-3 flex flex-col gap-4" },
        approvalBody
      )
    )
  );
}
