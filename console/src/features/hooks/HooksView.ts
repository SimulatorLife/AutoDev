import type {
  ControlApiHookEvent,
  ControlApiHooksAppliedResponse,
  ControlApiValidationIssue,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  LIST_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  MONO_ID_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { HookEventEditor } from "./HookEventEditor.ts";

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
 * Why the applied projection could not be read.
 *
 * The declaration and the projection are two different reads, so one of them
 * failing says nothing about the other. The page therefore keeps the reason
 * rather than reducing the failure to "not observed".
 */
export interface HooksAppliedUnavailable {
  readonly code: string;
  readonly message: string;
}

export interface HooksViewProps {
  readonly hooks: readonly HookDefinition[];
  readonly sourceValidity?: boolean | null | undefined;
  /**
   * Why the source is invalid.
   *
   * Required rather than defaulted to `[]`: a caller that has the validity flag
   * but not the reasons can only render "invalid", which is the state this
   * section exists to replace. The Runtime has already located the fault.
   */
  readonly validationIssues: readonly ControlApiValidationIssue[];
  /**
   * The revision of the canonical declaration.
   *
   * A write is compared against it, so the editor has to be filled from the
   * revision it was read at. `null` means the declaration could not be read,
   * and the editor stays disabled with the reason rather than offering a write
   * that has nothing to compare.
   */
  readonly revision: string | null;
  /**
   * The revision the editor is based on.
   *
   * It is the page's own revision unless a refused write says otherwise: a
   * write that was refused against a declaration that has since moved leaves
   * the editor based on the revision it was filled from, so the edit the
   * operator made is not silently paired with a newer declaration.
   */
  readonly editorRevision?: string | undefined;
  /**
   * The hook projection the Runtime published.
   *
   * `null` means the applied read could not be read at all, which is a
   * different state from a projection that holds no hooks.
   */
  readonly applied: ControlApiHooksAppliedResponse | null;
  /**
   * Why the applied projection could not be read, when it could not be read.
   */
  readonly appliedUnavailable?: HooksAppliedUnavailable | null | undefined;
  readonly saveOutcome?: HookDeclarationSaveOutcome | undefined;
}

/**
 * The notice a write's outcome is reported as.
 *
 * A refused write says what happened and nothing else: the declaration was not
 * changed, and the operator's edit is still in the editor.
 */
function saveNotice(
  outcome: HookDeclarationSaveOutcome | undefined
): React.JSX.Element | null {
  if (outcome === undefined) return null;
  const warning = outcome === "conflict" || outcome === "validation";
  const message = {
    conflict:
      "The canonical hook declaration changed after the editor was filled, so your edit was not saved. The edit is still here; reload the page to start from the current declaration before saving again.",
    validation:
      "The Runtime refused the submitted action list, so the canonical declaration was not changed. A hook action is a command hook with a command; the edit is still here.",
    "apply-failed":
      "The canonical declaration was updated, but the Runtime could not apply the hook projection. The declaration is shown as it now stands; do not assume the applied hooks match it.",
    failed:
      "The write and its result could not be confirmed. Reload the canonical declaration before retrying."
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
function originLabel(origin: HookDefinition["origin"]): string {
  return origin === "target"
    ? "Declared for Codex only"
    : "Declared for every target";
}

/**
 * The hook configuration the Runtime applied.
 *
 * The declaration says what the operator asked for and the applied projection
 * says what the Runtime published; the two are different readings, and the
 * reconciliation between them is the Runtime's own verdict. The Console
 * renders it rather than deriving one.
 */
function appliedPanel(
  applied: ControlApiHooksAppliedResponse | null,
  unavailable: HooksAppliedUnavailable | null
): React.JSX.Element {
  if (applied === null) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Applied hooks: Not observed"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The Runtime's applied hook projection could not be read, so nothing is claimed about what it published."
      ),
      // The reason the read failed, so the operator is not left with a gap on
      // the page and no explanation for it. The declaration beside it says
      // exactly this when *it* cannot be read, and the two reads answer
      // different questions -- so the reason for one of them failing is not a
      // reason for the other, and neither is a reason to leave the second
      // silent.
      unavailable === null
        ? null
        : React.createElement(
            "p",
            {
              className: MUTED_META_CLASS,
              "data-applied-unavailable": unavailable.code
            },
            `${unavailable.code}: ${unavailable.message}`
          )
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    appliedSummary(applied),
    React.createElement(ReconciliationPanel, {
      status: applied.reconciliation.status,
      history: applied.reconciliation.history
    })
  );
}

/**
 * What the Runtime published, and the events it published.
 */
function appliedSummary(
  applied: ControlApiHooksAppliedResponse
): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-2" },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Applied hooks"
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      applied.available
        ? `The Runtime published this hook configuration for the "${applied.target}" target from ${applied.source}.`
        : "The Runtime has published no hook configuration on this machine yet."
    ),
    applied.available && applied.events.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          applied.events.map((event) => appliedEvent(event))
        )
      : null
  );
}

/**
 * One event the Runtime published.
 */
function appliedEvent(event: ControlApiHookEvent): React.JSX.Element {
  return React.createElement(
    "div",
    {
      key: event.event,
      className: `${NESTED_PANEL_CLASS} flex flex-col gap-1 font-mono text-xs`,
      "data-hook-applied-event": event.event
    },
    React.createElement("span", { className: MONO_ID_CLASS }, event.event),
    event.actions.map((action, index) =>
      React.createElement(
        "div",
        { key: `${event.event}-${index}`, className: "text-fg" },
        React.createElement(
          "span",
          { className: MUTED_TEXT_CLASS },
          `${action.matcher ?? "*"} -> $`
        ),
        action.command
      )
    )
  );
}

/**
 * What the source's validity reads as.
 *
 * An unobserved source is not a valid one, so it says so in its own words
 * rather than borrowing the word for a source that was read and found sound.
 */
function sourceValidityLabel(sourceValidity: boolean | null): string {
  if (sourceValidity === null) return NOT_OBSERVED_LABEL;
  return sourceValidity ? "Valid" : "Invalid";
}

/**
 * Why the editor cannot be used, when it cannot.
 *
 * A declaration that could not be read has no revision to compare a write
 * against, and a declaration that is invalid cannot be written. Either way the
 * control stays in place, disabled, with the reason.
 */
function editorDisabledReason(
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

/**
 * The declared events, or the reason there are none to show.
 *
 * An invalid source shows none of its events: the first fault is why the rest
 * of the document was never examined, and a partial list would read as the
 * whole declaration.
 */
function declaredEvents(
  hooks: readonly HookDefinition[],
  sourceValidity: boolean | null,
  validationIssues: readonly ControlApiValidationIssue[],
  revision: string | null,
  editorRevision: string | undefined,
  disabledReason: string | null
): React.JSX.Element {
  if (hooks.length > 0) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      hooks.map((hook) =>
        hookEventPanel(hook, revision, editorRevision, disabledReason)
      )
    );
  }
  const state =
    sourceValidity === null
      ? "not-observed"
      : sourceValidity
        ? "empty"
        : "invalid";
  const message =
    sourceValidity === null
      ? "Hook source not observed."
      : sourceValidity
        ? "No hook actions configured."
        : `Hook source is invalid; actions are not shown. ${validationIssues.length} problem${validationIssues.length === 1 ? "" : "s"} found.`;
  return React.createElement(
    "p",
    {
      className: `${LIST_PANEL_CLASS} ${MUTED_TEXT_CLASS}`,
      "data-hook-state": state
    },
    message
  );
}

/**
 * One event, its declaration, and its editor.
 */
function hookEventPanel(
  hook: HookDefinition,
  revision: string | null,
  editorRevision: string | undefined,
  disabledReason: string | null
): React.JSX.Element {
  return React.createElement(
    "div",
    {
      key: hook.event,
      className: `${LIST_PANEL_CLASS} flex flex-col gap-3`,
      "data-hook-event": hook.event
    },
    React.createElement(
      "div",
      {
        className:
          "flex items-center justify-between border-b border-border pb-2"
      },
      React.createElement("span", { className: MONO_ID_CLASS }, hook.event),
      React.createElement(Tag, {
        children: originLabel(hook.origin),
        dataAttributes: { "data-hook-origin": hook.event }
      })
    ),
    React.createElement(HookEventEditor, {
      // The editor is remounted when the revision it is based on changes, and
      // not when it does not. That is what keeps an operator's edit across a
      // refused write: a refused write leaves the editor based on the revision
      // it was filled from.
      key: `${hook.event}-${editorRevision ?? revision ?? "none"}`,
      event: hook.event,
      actions: hook.actions,
      revision: editorRevision ?? revision ?? "",
      ...(disabledReason === null ? {} : { disabledReason })
    })
  );
}

export function HooksView({
  hooks,
  validationIssues,
  sourceValidity = null,
  revision,
  editorRevision,
  applied,
  appliedUnavailable = null,
  saveOutcome
}: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((acc, h) => acc + h.actions.length, 0);
  const disabledReason = editorDisabledReason(revision, sourceValidity);

  return React.createElement(
    PageBody,
    { feature: "hooks" },
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Hook Events",
        value: hooks.length
      }),
      React.createElement(StatCard, {
        title: "Total Handlers",
        value: totalActions
      }),
      React.createElement(StatCard, {
        title: "Source validation",
        value: sourceValidityLabel(sourceValidity),
        subtitle: ".rulesync/hooks.jsonc"
      }),
      React.createElement(StatCard, {
        title: "Applied hooks",
        value:
          applied === null
            ? NOT_OBSERVED_LABEL
            : applied.reconciliation.status.convergence
      })
    ),
    // Only when there is something to report. A valid or unobserved source has
    // no reasons, and rendering an empty panel next to a green stat card would
    // add a section that says nothing.
    React.createElement(SourceValidationIssues, {
      issues: validationIssues,
      testId: "hook-validation-issues",
      subject: "Hook source"
    }),
    saveNotice(saveOutcome),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Configured Lifecycle Hooks"
      ),
      declaredEvents(
        hooks,
        sourceValidity,
        validationIssues,
        revision,
        editorRevision,
        disabledReason
      )
    ),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Applied Hook Configuration"
      ),
      appliedPanel(applied, appliedUnavailable)
    )
  );
}
