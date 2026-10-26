import React from "react";

import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import type { CanonicalSourceSaveOutcome } from "../../lib/server/canonical-source.ts";

/**
 * The vocabulary the permission policy's surface shares with its write.
 *
 * A write that was refused because the policy moved, a write the Runtime would
 * not express, a write whose policy landed but whose applied configuration
 * could not be refreshed, and a write whose result could not be confirmed are
 * four different facts. Keeping the wording and the reasons here is what makes
 * the surface one control rather than a control and a message that disagree.
 *
 * The vocabulary is the shared one every canonical source's write ends in, so
 * the policy is not a second way of saying the same four things.
 */
export type PermissionPolicySaveOutcome = CanonicalSourceSaveOutcome;

/**
 * The outcome a query value names, when it names one.
 *
 * A query value that is not an outcome is not an outcome: it is ignored, and
 * the page reports no write at all rather than a write it did not measure.
 */
export function permissionPolicySaveOutcomeFromQuery(
  value: string | readonly string[] | undefined
): PermissionPolicySaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "apply-failed" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

/**
 * The notice a write's outcome is reported as.
 *
 * A refused write says what happened and nothing else: the policy was not
 * changed, and the operator's edit is still in the control. A write whose
 * policy landed but whose applied configuration could not be refreshed says
 * that instead -- the canonical policy is changed, and the product is not
 * running it yet.
 */
export function permissionPolicySaveNotice(
  outcome: PermissionPolicySaveOutcome | undefined
): React.JSX.Element | null {
  if (outcome === undefined) return null;
  const warning = outcome === "conflict" || outcome === "validation";
  const message = {
    conflict:
      "The canonical permission policy changed after the control was filled, so your edit was not saved. The edit is still here; reload the page to start from the current policy before saving again.",
    validation:
      "The Runtime refused the submitted policy, so the canonical permission policy was not changed. The edit is still here.",
    "apply-failed":
      "The canonical permission policy was changed, but the user configuration could not be composed from it. Reload the permissions to see whether the change was applied.",
    failed:
      "The write to the canonical permission policy and its result could not be confirmed. Reload the permissions before retrying."
  }[outcome];
  return React.createElement(
    "p",
    {
      className: warning ? CALLOUT_WARNING_CLASS : CALLOUT_ERROR_CLASS,
      role: warning ? "status" : "alert",
      "data-permission-policy-save": outcome
    },
    message
  );
}

/**
 * Why the policy control cannot be used, when it cannot.
 *
 * A policy that could not be read has no revision to compare a write against,
 * and a policy that is invalid cannot be written. Either way the control stays
 * in place, disabled, with the reason.
 */
export function permissionPolicyDisabledReason(
  revision: string | null,
  policyStatus: "valid" | "invalid" | "unavailable"
): string | null {
  if (revision === null) {
    return "The canonical permission policy could not be read, so there is nothing to write.";
  }
  if (policyStatus !== "valid") {
    return "The canonical permission policy is invalid, so it cannot be written.";
  }
  return null;
}
