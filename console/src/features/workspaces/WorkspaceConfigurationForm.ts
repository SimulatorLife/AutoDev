"use client";

import type { ControlApiWorkspaceRecord } from "@simulatorlife/autodev-core";
import React, { useRef } from "react";

import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import { workspaceConfigurationDisabledReason } from "./configuration.ts";
import { workspaceConfigurationPath } from "./paths.ts";
import {
  workspaceConfigurationBadgeLabel,
  workspaceConfigurationBadgeVariant
} from "./workspace-health.ts";

/**
 * The control that writes one workspace's canonical configuration.
 *
 * This is one control in two places -- the workspace's row on the list and the
 * workspace's own page -- and it is the same control in both: the same fields,
 * the same route, the same revision check, and the same disabled reason. The
 * only thing that differs is how much of it fits where it sits, so the layout
 * is a prop and the control is not written twice.
 *
 * The configuration is a grouped setting: enablement, base branch and role
 * scope are one workspace's configuration, and a write replaces the whole of
 * it. So the form carries the complete desired value and a change writes it,
 * rather than staging an edit that has to be saved somewhere else.
 */
export interface WorkspaceConfigurationFormProps {
  readonly workspace: ControlApiWorkspaceRecord;
  /**
   * The revision the edit is based on.
   *
   * The write is a compare-and-swap on it, so the form carries the revision
   * the operator's edit was written against rather than the revision the
   * catalog may have moved to while the page was open. It is null when the
   * catalog could not be read, which is also when the control cannot be used.
   */
  readonly revision: string | null;
  /** The status of the canonical catalog this read came from. */
  readonly catalogStatus: "valid" | "invalid" | "unavailable";
  /**
   * Where the write answers to.
   *
   * The control is on the list and on the workspace's own page, and the write
   * has to answer to whichever of the two it was made from: a write that
   * answered somewhere else would leave the operator looking at a page that
   * says nothing about the configuration they just changed. It is a bounded
   * Workspaces path rather than a destination the browser chooses.
   */
  readonly returnTo: string;
  /** The dense layout the list's row uses. */
  readonly compact?: boolean | undefined;
}

/** The names the route reads the form's fields by. */
const BASE_BRANCH_FIELD = "baseBranch";
const ROLES_FIELD = "agentRoles";

/**
 * The role scope as the control shows it.
 *
 * A scope that is not configured and a scope that names no role are different
 * facts -- the first admits every role, the second admits none -- so the
 * control keeps them apart rather than showing an empty list for both.
 */
function roleScopeText(workspace: ControlApiWorkspaceRecord): string {
  return workspace.agentRoles === null ? "" : workspace.agentRoles.join(", ");
}

export function WorkspaceConfigurationForm({
  workspace,
  revision,
  catalogStatus,
  returnTo,
  compact = false
}: WorkspaceConfigurationFormProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null);
  // What the last submission carried. A text field that has not changed since
  // then has nothing to write, so leaving the control does not write it again.
  const submitted = useRef<Record<string, string>>({
    [BASE_BRANCH_FIELD]: workspace.baseBranch,
    [ROLES_FIELD]: roleScopeText(workspace)
  });
  const disabledReason = workspaceConfigurationDisabledReason(
    revision,
    catalogStatus
  );
  const disabled = disabledReason !== null;
  // The field ids have to be unique per page: the list repeats this control on
  // every row, and two controls sharing an id leave every label ambiguous.
  const fieldPrefix = `workspace-${workspace.id.replaceAll(/[^A-Za-z0-9]+/gu, "-")}`;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    const data = new FormData(event.currentTarget);
    submitted.current = {
      [BASE_BRANCH_FIELD]: String(data.get(BASE_BRANCH_FIELD) ?? ""),
      [ROLES_FIELD]: String(data.get(ROLES_FIELD) ?? "")
    };
  };

  const handleBlur = (event: React.FocusEvent<HTMLFormElement>): void => {
    const target = event.target as unknown as HTMLInputElement | null;
    if (
      target === null ||
      (target.name !== BASE_BRANCH_FIELD && target.name !== ROLES_FIELD)
    ) {
      return;
    }
    const form = event.currentTarget;
    // A field that still has the focus inside the form is not finished with:
    // the next change writes the whole configuration anyway.
    const active = form.ownerDocument.activeElement;
    if (active !== null && form.contains(active)) return;
    if (target.value === submitted.current[target.name]) return;
    form.requestSubmit();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") return;
    // A form with more than one field does not submit on Enter by itself, and
    // a committed text field that cannot be committed with the keyboard is not
    // reachable without a pointer.
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  return React.createElement(
    "form",
    {
      method: "POST",
      action: workspaceConfigurationPath(workspace.id),
      className: compact
        ? "flex min-w-0 flex-wrap items-end gap-2"
        : "grid min-w-0 gap-3 sm:grid-cols-2",
      "aria-label": `Edit the canonical configuration for ${workspace.id}`,
      "data-workspace-configuration": workspace.id,
      "data-submit-on-change": "true",
      ref: formRef,
      onSubmit: handleSubmit,
      onBlur: handleBlur,
      onKeyDown: handleKeyDown
    },
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: revision ?? ""
    }),
    // Where the write answers to. The route validates it against the
    // Workspaces paths before it redirects, so a destination the browser chose
    // freely cannot become a redirect off this Console.
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: returnTo
    }),
    React.createElement(AutoSubmitSelectField, {
      name: "enabled",
      id: `${fieldPrefix}-enabled`,
      label: "Enablement",
      hideLabel: compact,
      options: [
        { value: "true", label: "Enabled" },
        { value: "false", label: "Disabled" }
      ],
      defaultValue: workspace.enabled ? "true" : "false",
      disabled,
      ...(disabledReason === null ? {} : { disabledReason }),
      dataAttributes: { "data-workspace-configuration-enabled": workspace.id }
    }),
    React.createElement(TextField, {
      name: BASE_BRANCH_FIELD,
      id: `${fieldPrefix}-base-branch`,
      label: "Base branch",
      hideLabel: compact,
      defaultValue: workspace.baseBranch,
      // The compact cell hides the label, because a table row cannot carry
      // four of them. A field with no visible name at all asks the operator
      // to recall what it is, and an empty one gives them nothing to go on,
      // so the placeholder says what the field holds.
      ...(compact ? { placeholder: "main" } : {}),
      disabled,
      dataAttributes: {
        "data-workspace-configuration-base-branch": workspace.id
      }
    }),
    React.createElement(
      "div",
      {
        className: "flex min-w-0 flex-wrap items-center gap-2",
        "data-workspace-configuration-scope": workspace.id,
        // A scope that is not configured and a scope that names no role are
        // different facts: the first admits every role, the second admits
        // none. The control keeps them apart, and says which one it is.
        "data-role-scope":
          workspace.agentRoles === null
            ? "not-configured"
            : workspace.agentRoles.length === 0
              ? "empty"
              : "configured"
      },
      React.createElement(AutoSubmitSelectField, {
        name: "agentRolesMode",
        id: `${fieldPrefix}-role-scope`,
        label: "Role scope",
        hideLabel: compact,
        options: [
          { value: "unscoped", label: "Any role may work here" },
          { value: "scoped", label: "Only the roles listed below" }
        ],
        defaultValue: workspace.agentRoles === null ? "unscoped" : "scoped",
        disabled,
        ...(disabledReason === null ? {} : { disabledReason }),
        dataAttributes: {
          "data-workspace-configuration-role-scope": workspace.id
        }
      }),
      // A scope that names a role AutoDev does not define is a configuration
      // fault, and it belongs beside the scope that carries it: listing the
      // roles anyway would show a scope that excludes every agent that could
      // work here and say nothing about why.
      workspace.configuration.status === "invalid-role-scope"
        ? React.createElement(StatusBadge, {
            status: workspaceConfigurationBadgeVariant(workspace.configuration),
            label: workspaceConfigurationBadgeLabel(workspace.configuration)
          })
        : null
    ),
    React.createElement(TextField, {
      name: ROLES_FIELD,
      id: `${fieldPrefix}-roles`,
      label: "Roles (comma-separated)",
      hideLabel: compact,
      defaultValue: roleScopeText(workspace),
      // The roles field is empty whenever the scope admits any role, which is
      // the common case -- so in the compact cell it is an unnamed empty box
      // most of the time. The placeholder names what it takes.
      ...(compact ? { placeholder: "worker, orchestrator" } : {}),
      disabled,
      dataAttributes: { "data-workspace-configuration-roles": workspace.id }
    }),
    disabledReason === null
      ? null
      : React.createElement(
          "p",
          {
            className: `${MUTED_META_CLASS} ${compact ? "w-full" : ""}`,
            "data-workspace-configuration-disabled": "true"
          },
          disabledReason
        ),
    compact
      ? null
      : React.createElement(
          "p",
          { className: `${MUTED_META_CLASS} sm:col-span-2` },
          "A workspace's role scope names the roles that may work here. Any role leaves the scope open, an empty role list admits no role at all, and every change writes the whole configuration to the canonical catalog."
        )
  );
}
