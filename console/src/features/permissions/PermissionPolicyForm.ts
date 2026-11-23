"use client";

import type { PermissionPolicy } from "@simulatorlife/autodev-core";
import React, { useRef } from "react";

import { AutoSubmitSelectField } from "../../components/forms/AutoSubmitSelectField.ts";
import { TextField } from "../../components/forms/TextField.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";
import { permissionPolicyDisabledReason } from "./configuration.ts";
import { PERMISSION_POLICY_MUTATION_PATH, PERMISSIONS_PATH } from "./paths.ts";

/**
 * The control that writes the canonical permission policy.
 *
 * The policy is one setting of the product -- the session's approval policy,
 * sandbox, network access and web search -- and each part of it is a control
 * that is independently valid and immediately actionable. So each control
 * writes its own setting: the write names the setting it changes and the
 * revision it decided on, and the rest of the policy is left as the canonical
 * source has it.
 *
 * The write is a compare-and-swap on the policy file's revision, so the form
 * carries the revision the page loaded rather than the revision the file may
 * have moved to while the page was open.
 */
export interface PermissionPolicyFormProps {
  /**
   * The policy the canonical source states.
   *
   * Null when the source could not be read: the control cannot be used then,
   * and the page says why beside it.
   */
  readonly policy: PermissionPolicy | null;
  /**
   * The revision the edit is based on.
   *
   * The write is a compare-and-swap on it, so the form carries the revision
   * the operator's edit was written against. It is null when the policy could
   * not be read, which is also when the control cannot be used.
   */
  readonly revision: string | null;
  /** The status of the canonical source this read came from. */
  readonly policyStatus: "valid" | "invalid" | "unavailable";
}

/** The names the route reads the form's fields by. */
const APPROVAL_POLICY_FIELD = "approvalPolicy";
const APPROVALS_REVIEWER_FIELD = "approvalsReviewer";
const WEB_SEARCH_FIELD = "webSearch";

const APPROVAL_POLICY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "on-request", label: "On request" }
] as const;

/**
 * The choice a control shows when the policy was not observed.
 *
 * A select with no selection shows its first option, so a control rendered
 * without a policy would show "Never" -- a value the operator never chose,
 * stated as confidently as a measured one. The empty choice is what says
 * "nothing was observed" instead.
 */
const NOT_OBSERVED_CHOICE = { value: "", label: "Not observed" } as const;

export function PermissionPolicyForm({
  policy,
  revision,
  policyStatus
}: PermissionPolicyFormProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement | null>(null);
  // What the last submission carried. A field that has not changed since then
  // has nothing to write, so leaving the control does not write it again.
  const submitted = useRef<Record<string, string>>({
    [APPROVALS_REVIEWER_FIELD]: policy?.approvalsReviewer ?? ""
  });
  const disabledReason = permissionPolicyDisabledReason(revision, policyStatus);
  const disabled = disabledReason !== null;
  const observed = policy !== null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    const data = new FormData(event.currentTarget);
    submitted.current = {
      [APPROVALS_REVIEWER_FIELD]: String(
        data.get(APPROVALS_REVIEWER_FIELD) ?? ""
      )
    };
  };

  const handleBlur = (event: React.FocusEvent<HTMLFormElement>): void => {
    const target = event.target as unknown as HTMLInputElement | null;
    if (target === null || target.name !== APPROVALS_REVIEWER_FIELD) return;
    const form = event.currentTarget;
    // A field that still has the focus inside the form is not finished with:
    // the next change writes the policy anyway.
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
      action: PERMISSION_POLICY_MUTATION_PATH,
      className: "grid min-w-0 gap-3 sm:grid-cols-2",
      "aria-label": "Edit the canonical permission policy",
      "data-permission-policy": "true",
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
    React.createElement("input", {
      type: "hidden",
      name: "returnTo",
      value: PERMISSIONS_PATH
    }),
    React.createElement(AutoSubmitSelectField, {
      name: APPROVAL_POLICY_FIELD,
      id: "permission-policy-approval-policy",
      label: "Approval Policy",
      options: observed ? [...APPROVAL_POLICY_OPTIONS] : [NOT_OBSERVED_CHOICE],
      defaultValue: policy?.approvalPolicy ?? "",
      disabled,
      ...(disabledReason === null ? {} : { disabledReason }),
      dataAttributes: { "data-permission-policy-approval-policy": "true" }
    }),
    React.createElement(TextField, {
      name: APPROVALS_REVIEWER_FIELD,
      id: "permission-policy-approvals-reviewer",
      label: "Approvals Reviewer",
      defaultValue: policy?.approvalsReviewer ?? "",
      disabled,
      dataAttributes: {
        "data-permission-policy-approvals-reviewer": "true"
      }
    }),
    React.createElement(AutoSubmitSelectField, {
      name: WEB_SEARCH_FIELD,
      id: "permission-policy-web-search",
      label: "Web Search",
      options: observed
        ? [
            { value: "true", label: "Enabled" },
            { value: "false", label: "Disabled" }
          ]
        : [NOT_OBSERVED_CHOICE],
      defaultValue: policy === null ? "" : policy.webSearch ? "true" : "false",
      disabled,
      ...(disabledReason === null ? {} : { disabledReason }),
      dataAttributes: { "data-permission-policy-web-search": "true" }
    }),
    disabledReason === null
      ? null
      : React.createElement(
          "p",
          {
            className: `${MUTED_META_CLASS} sm:col-span-2`,
            "data-permission-policy-disabled": "true"
          },
          disabledReason
        )
  );
}
