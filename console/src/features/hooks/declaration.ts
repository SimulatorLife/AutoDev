import type { HookDefinition } from "@simulatorlife/autodev-core";
import React from "react";

import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";

/**
 * The vocabulary the hook declaration's two surfaces share.
 *
 * The list presents every event's declaration at once and the event's own
 * page presents one of them, and the two have to say the same thing about the
 * same declaration: a write that failed is one fact, an event that is declared
 * for every target is one fact, and a control that cannot be used is one
 * fact. Keeping the wording and the reasons here is what makes the two
 * surfaces one control in two places rather than two controls.
 */

/**
 * How a write to the canonical hook declaration ended.
 *
 * A conflict and a refused declaration are different facts, and so is a write
 * whose result could not be confirmed: the page says which one happened rather
 * than reporting one generic failure for all of them.
 */
export type HookDeclarationSaveOutcome =
  "conflict" | "validation" | "apply-failed" | "failed";

/**
 * The outcome a query value names, when it names one.
 *
 * A query value that is not an outcome is not an outcome: it is ignored, and
 * the page reports no write at all rather than a write it did not measure.
 */
export function hookSaveOutcomeFromQuery(
  value: string | readonly string[] | undefined
): HookDeclarationSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "apply-failed" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

/**
 * The event a save outcome is about, named in the sentence.
 *
 * The list presents every event's declaration at once, so a notice that did
 * not name its event would leave the operator to work out which of the edits
 * on the page it was talking about.
 */
function eventClause(event: string | undefined): string {
  return event === undefined ? "" : ` for "${event}"`;
}

/**
 * The notice a write's outcome is reported as.
 *
 * A refused write says what happened and nothing else: the declaration was not
 * changed, and the operator's edit is still in the editor.
 */
export function hookDeclarationSaveNotice(
  outcome: HookDeclarationSaveOutcome | undefined,
  event?: string | undefined
): React.JSX.Element | null {
  if (outcome === undefined) return null;
  const warning = outcome === "conflict" || outcome === "validation";
  const clause = eventClause(event);
  const message = {
    conflict: `The canonical hook declaration${clause} changed after the editor was filled, so your edit was not saved. The edit is still here; reload the page to start from the current declaration before saving again.`,
    validation: `The Runtime refused the submitted action list, so the canonical hook declaration${clause} was not changed. A hook action is a command hook with a command; the edit is still here.`,
    "apply-failed": `The canonical hook declaration${clause} was updated, but the Runtime could not apply the hook projection. The declaration is shown as it now stands; do not assume the applied hooks match it.`,
    failed: `The write to the canonical hook declaration${clause} and its result could not be confirmed. Reload the canonical declaration before retrying.`
  }[outcome];
  return React.createElement(
    "p",
    {
      className: warning ? CALLOUT_WARNING_CLASS : CALLOUT_ERROR_CLASS,
      role: warning ? "status" : "alert",
      "data-hook-declaration-save": outcome
    },
    message
  );
}

/**
 * The origin of one event's declaration.
 *
 * It is the difference between an edit that reaches every target and an edit
 * that reaches one, so the page says which an event is rather than leaving
 * the operator to find out.
 */
export function hookOriginLabel(origin: HookDefinition["origin"]): string {
  return origin === "target"
    ? "Declared for Codex only"
    : "Declared for every target";
}

/**
 * Why the editor cannot be used, when it cannot.
 *
 * A declaration that could not be read has no revision to compare a write
 * against, and a declaration that is invalid cannot be written. Either way the
 * control stays in place, disabled, with the reason.
 */
export function hookEditorDisabledReason(
  revision: string | null,
  sourceValidity: boolean | null
): string | null {
  if (revision === null) {
    return "The canonical hook declaration could not be read, so there is nothing to write.";
  }
  if (sourceValidity === false) {
    return "The canonical hook declaration is invalid, so it cannot be written. The problems are listed above.";
  }
  return null;
}
