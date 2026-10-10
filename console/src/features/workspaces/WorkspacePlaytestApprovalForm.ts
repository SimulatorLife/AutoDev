"use client";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { gridRowClass } from "../../components/panels/DetailGrid.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import { WORKSPACE_PLAYTEST_LIMIT_FIELDS } from "./limits-fields.ts";
import { workspacePath, workspacePlaytestApprovalPath } from "./paths.ts";

const ISSUE_REPORTING_OPTIONS = [
  { value: "disabled", label: "Disabled -- no issues filed" },
  { value: "review", label: "Review -- findings proposed for operator review" }
] as const;

const HUMAN_STUDY_OPTIONS = [
  { value: "false", label: "Not allowed" },
  { value: "true", label: "Allowed" }
] as const;

function joined(values: readonly string[] | undefined): string | undefined {
  return values === undefined ? undefined : values.join(", ");
}

export interface WorkspacePlaytestApprovalFormProps {
  readonly workspaceId: string;
  readonly pending: boolean;
  readonly onSubmit: React.FormEventHandler<HTMLFormElement>;
  /**
   * The workspace's most recent approval, active or revoked, or `null` when
   * none has ever been granted. A revoked record seeds every field so
   * re-approving an unchanged build is a review rather than a blank form, and
   * its `revision` becomes the form's `expectedRevision` -- the exact
   * optimistic-concurrency token the Runtime checks before writing a new one.
   */
  readonly priorApproval: WorkspacePlaytestApproval | null;
}

/**
 * The operator form that grants an exact-build playtesting approval.
 *
 * Every field here is the whole grant: the Runtime refuses a game-run request
 * for anything this approval does not name, so a field left blank is not a
 * convenience default, it is a boundary the operator did not set. The native
 * labelled form uses an in-place client submission to the same-origin server
 * route, which forwards the mutation using the server-only Control API token.
 */
export function WorkspacePlaytestApprovalForm({
  workspaceId,
  priorApproval,
  pending,
  onSubmit
}: WorkspacePlaytestApprovalFormProps): React.JSX.Element {
  const returnTo = workspacePath(workspaceId);
  const expectedRevision =
    priorApproval === null ? "" : String(priorApproval.revision);

  return React.createElement(
    "form",
    {
      action: workspacePlaytestApprovalPath(workspaceId),
      method: "POST",
      onSubmit,
      "aria-busy": pending,
      "aria-label": `Approve playtesting for ${workspaceId}`,
      className: "flex flex-col gap-4",
      "data-workspace-approval-form": workspaceId
    },
    React.createElement("input", {
      type: "hidden",
      name: "workspaceId",
      value: workspaceId
    }),
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: expectedRevision
    }),
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    React.createElement(
      "div",
      { className: gridRowClass(2) },
      React.createElement(TextField, {
        name: "checkoutRoot",
        label: "Checkout root (absolute local path)",
        defaultValue: priorApproval?.checkoutRoot,
        placeholder: "e.g. /home/operator/games/fixture",
        testId: "workspace-approval-checkout-root"
      }),
      React.createElement(TextField, {
        name: "workingDirectory",
        label: "Working directory (relative to checkout)",
        defaultValue: priorApproval?.workingDirectory,
        placeholder: "server",
        testId: "workspace-approval-working-directory"
      }),
      React.createElement(TextField, {
        name: "buildSha",
        label: "Build SHA (Git revision)",
        defaultValue: priorApproval?.buildSha,
        placeholder: "a".repeat(40),
        testId: "workspace-approval-build-sha"
      }),
      React.createElement(TextField, {
        name: "gameBuild",
        label: "Game build identifier",
        defaultValue: priorApproval?.gameBuild,
        placeholder: "fixture-game-1.0.0",
        testId: "workspace-approval-game-build"
      }),
      React.createElement(TextField, {
        name: "playtestConfigHash",
        label: "Playtest config hash (SHA-256)",
        defaultValue: priorApproval?.playtestConfigHash,
        placeholder: "e".repeat(64),
        testId: "workspace-approval-config-hash"
      }),
      React.createElement(TextField, {
        name: "adapterImageDigest",
        label: "Adapter image digest (sha256:...)",
        defaultValue: priorApproval?.adapterImageDigest,
        placeholder: "fixture/adapter@sha256:" + "f".repeat(64),
        testId: "workspace-approval-image-digest"
      })
    ),
    React.createElement(TextField, {
      name: "adapterCommand",
      label: "Adapter command (comma-separated argv)",
      defaultValue: joined(priorApproval?.adapterCommand),
      placeholder: "node, server.js",
      testId: "workspace-approval-adapter-command"
    }),
    React.createElement(
      "div",
      { className: gridRowClass(2) },
      React.createElement(TextField, {
        name: "allowedScenarios",
        label: "Allowed scenarios (comma-separated)",
        defaultValue: joined(priorApproval?.allowedScenarios),
        placeholder: "tutorial, level-1",
        testId: "workspace-approval-allowed-scenarios"
      }),
      React.createElement(TextField, {
        name: "allowedPolicies",
        label: "Allowed policies (comma-separated)",
        defaultValue: joined(priorApproval?.allowedPolicies),
        placeholder: "random, heuristic",
        testId: "workspace-approval-allowed-policies"
      })
    ),
    React.createElement(
      "fieldset",
      {
        className: "flex flex-col gap-3 rounded border border-border p-3"
      },
      React.createElement(
        "legend",
        { className: SECTION_HEADING_CLASS },
        "Resource limits"
      ),
      React.createElement(
        "div",
        { className: gridRowClass(3) },
        ...WORKSPACE_PLAYTEST_LIMIT_FIELDS.map((field) =>
          React.createElement(TextField, {
            key: field.name,
            name: field.name,
            label: field.label,
            defaultValue:
              priorApproval === null
                ? undefined
                : String(priorApproval.limits[field.name]),
            testId: `workspace-approval-limit-${field.name}`
          })
        )
      )
    ),
    React.createElement(
      "div",
      { className: gridRowClass(3) },
      React.createElement(TextField, {
        name: "retentionDays",
        label: "Retention (days)",
        defaultValue:
          priorApproval === null
            ? undefined
            : String(priorApproval.retentionDays),
        testId: "workspace-approval-retention-days"
      }),
      React.createElement(SelectField, {
        name: "issueReporting",
        label: "Issue reporting",
        options: ISSUE_REPORTING_OPTIONS,
        defaultValue: priorApproval?.issueReporting ?? "disabled",
        testId: "workspace-approval-issue-reporting"
      }),
      React.createElement(SelectField, {
        name: "humanStudyAllowed",
        label: "Human study",
        options: HUMAN_STUDY_OPTIONS,
        defaultValue:
          priorApproval?.humanStudyAllowed === true ? "true" : "false",
        testId: "workspace-approval-human-study"
      })
    ),
    React.createElement(
      "div",
      { className: "flex items-center gap-3" },
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "primary",
          ariaLabel: pending
            ? `Approving playtesting for ${workspaceId}`
            : `Approve playtesting for ${workspaceId}`,
          disabled: pending,
          dataAttributes: { "data-workspace-approve-submit": workspaceId }
        },
        pending
          ? priorApproval === null
            ? "Approving…"
            : "Re-approving…"
          : priorApproval === null
            ? "Approve"
            : "Re-approve"
      ),
      React.createElement(
        "span",
        { className: MUTED_META_CLASS },
        "Every field is exact: the Runtime refuses a run for anything not named here."
      )
    )
  );
}
