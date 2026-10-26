import React from "react";

import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";

/**
 * The vocabulary the workspace configuration's two surfaces share.
 *
 * The list presents every workspace's configuration at once and a workspace's
 * own page presents one of them, and the two have to say the same thing about
 * the same configuration: a write that failed is one fact, a catalog that
 * cannot be written is one fact, and a write that was refused because the
 * catalog moved is a third. Keeping the wording and the reasons here is what
 * makes the two surfaces one control in two places rather than two controls.
 */

/**
 * How a write to the canonical workspace catalog ended.
 *
 * A conflict and a refused update are different facts, and so is a write whose
 * result could not be confirmed: the page says which one happened rather than
 * reporting one generic failure for all of them.
 */
export type WorkspaceConfigurationSaveOutcome =
  "conflict" | "validation" | "failed";

/**
 * The outcome a query value names, when it names one.
 *
 * A query value that is not an outcome is not an outcome: it is ignored, and
 * the page reports no write at all rather than a write it did not measure.
 */
export function workspaceSaveOutcomeFromQuery(
  value: string | readonly string[] | undefined
): WorkspaceConfigurationSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

/**
 * The notice a write's outcome is reported as.
 *
 * A refused write says what happened and nothing else: the catalog was not
 * changed, and the operator's edit is still in the control.
 */
export function workspaceConfigurationSaveNotice(
  outcome: WorkspaceConfigurationSaveOutcome | undefined,
  workspaceId?: string | undefined
): React.JSX.Element | null {
  if (outcome === undefined) return null;
  const warning = outcome === "conflict" || outcome === "validation";
  const clause = workspaceId === undefined ? "" : ` for "${workspaceId}"`;
  const message = {
    conflict: `The canonical workspace catalog${clause} changed after the control was filled, so your edit was not saved. The edit is still here; reload the page to start from the current catalog before saving again.`,
    validation: `The Runtime refused the submitted configuration${clause}, so the canonical workspace catalog was not changed. A base branch is a branch name, and a role scope is a list of role names; the edit is still here.`,
    failed: `The write to the canonical workspace catalog${clause} and its result could not be confirmed. Reload the canonical catalog before retrying.`
  }[outcome];
  return React.createElement(
    "p",
    {
      className: warning ? CALLOUT_WARNING_CLASS : CALLOUT_ERROR_CLASS,
      role: warning ? "status" : "alert",
      "data-workspace-configuration-save": outcome
    },
    message
  );
}

/**
 * Why the configuration control cannot be used, when it cannot.
 *
 * A catalog that could not be read has no revision to compare a write
 * against, and a catalog that is invalid cannot be written. Either way the
 * control stays in place, disabled, with the reason.
 */
export function workspaceConfigurationDisabledReason(
  revision: string | null,
  catalogStatus: "valid" | "invalid" | "unavailable"
): string | null {
  if (revision === null) {
    return "The canonical workspace catalog could not be read, so there is nothing to write.";
  }
  if (catalogStatus !== "valid") {
    return "The canonical workspace catalog is invalid, so it cannot be written.";
  }
  return null;
}
