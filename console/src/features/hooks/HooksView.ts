import type {
  ControlApiHooksAppliedResponse,
  ControlApiValidationIssue,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { SourceValidationIssues } from "../../components/status/SourceValidationIssues.ts";
import {
  NOT_OBSERVED_LABEL,
  statusBadgeLabel
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_ID_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import {
  hookAppliedEventPanel,
  hookAppliedSummaryText,
  hookAppliedUnavailableNotice,
  type HooksAppliedUnavailable
} from "./applied.ts";
import {
  hookDeclarationSaveNotice,
  type HookDeclarationSaveOutcome,
  hookEditorDisabledReason,
  hookOriginLabel
} from "./declaration.ts";
import { HookEventEditor } from "./HookEventEditor.ts";
import { hookEventPath, HOOKS_PATH } from "./paths.ts";

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
  /**
   * The event the last write was about.
   *
   * The list presents every event's declaration at once, so a notice that did
   * not name its event would leave the operator to work out which of the edits
   * on the page it was talking about. It is absent when the write's event is
   * not one of the declared ones, and the notice then says what it can.
   */
  readonly savedEvent?: string | undefined;
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
    return hookAppliedUnavailableNotice(unavailable);
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
      hookAppliedSummaryText(applied)
    ),
    applied.available && applied.events.length > 0
      ? React.createElement(
          "div",
          { className: "flex flex-col gap-2" },
          applied.events.map((event) => hookAppliedEventPanel(event))
        )
      : null
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
      React.createElement(
        NavigationLink,
        {
          // The event is the item's own name and the item's own page: the
          // card's header is where the operator opens it.
          href: hookEventPath(hook.event),
          className: `${MONO_ID_CLASS} ${ENTITY_LINK_CLASS}`,
          "aria-label": `Open hook event ${hook.event}`,
          dataAttributes: { "data-hook-event-link": hook.event }
        },
        hook.event
      ),
      React.createElement(Tag, {
        children: hookOriginLabel(hook.origin),
        dataAttributes: { "data-hook-origin": hook.event }
      })
    ),
    React.createElement(HookEventEditor, {
      // The editor's identity is the event, and nothing else. The key used to
      // carry the revision the editor was based on, so a *successful* write --
      // which moves the declaration's revision -- remounted every editor on
      // the page and threw away the drafts in all of them. An operator editing
      // one event, who then saved a different one, came back to find their
      // unfinished work gone with no word about it.
      //
      // A draft is a draft: it is the operator's, and it is not discarded
      // because the declaration moved for some other reason. The write it
      // carries is a compare-and-swap on the revision it was written against,
      // so a declaration that has moved under it is *refused* -- the operator's
      // edit stays on screen and the refusal says why -- rather than the edit
      // being overwritten or thrown away.
      key: hook.event,
      event: hook.event,
      actions: hook.actions,
      revision: editorRevision ?? revision ?? "",
      // A write made from the list answers to the list, so the operator comes
      // back to the page they were working on rather than being moved to the
      // one event's own page.
      returnTo: HOOKS_PATH,
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
  saveOutcome,
  savedEvent
}: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((acc, h) => acc + h.actions.length, 0);
  const disabledReason = hookEditorDisabledReason(revision, sourceValidity);

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
            : // The Console's word for the state, not the wire's key for it.
              // The card beside this one says "Valid" rather than "valid", and
              // a reader who saw "pending" beside it would read the two as
              // two different kinds of answer rather than two spellings of
              // the same one.
              statusBadgeLabel(applied.reconciliation.status.convergence)
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
    hookDeclarationSaveNotice(saveOutcome, savedEvent),
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
