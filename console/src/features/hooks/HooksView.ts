import type {
  ControlApiHooksAppliedResponse,
  ControlApiValidationIssue,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SourceView } from "../../components/code/SourceView.ts";
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
import { hookOriginLabel } from "./declaration.ts";
import { HookActionsView } from "./HookActionsView.ts";
import { hookEventPath } from "./paths.ts";

export interface HooksViewProps {
  readonly hooks: readonly HookDefinition[];
  readonly sourceValidity?: boolean | null | undefined;
  /**
  Why the source is invalid.
  
  Required rather than defaulted to `[]`: a caller that has the validity flag
  but not the reasons can only render "invalid", which is the state this
  section exists to replace. The Runtime has already located the fault.
  */
  readonly validationIssues: readonly ControlApiValidationIssue[];
  /**
  The revision of the canonical declaration.
  
  `null` means the declaration could not be read, so there is no revision to
  name. The revision identifies the exact source this page describes, and it
  is the same revision the event's own page names.
  */
  readonly revision: string | null;
  /**
  The canonical declaration's exact text, or null when it was not read.
  
  It is the source the events above were read with, so the two views of the
  declaration are one read rather than two that can straddle a change.
  */
  readonly sourceText: string | null;
  /**
  The hook projection the Runtime published.
  
  `null` means the applied read could not be read at all, which is a
  different state from a projection that holds no hooks.
  */
  readonly applied: ControlApiHooksAppliedResponse | null;
  /**
  Why the applied projection could not be read, when it could not be read.
  */
  readonly appliedUnavailable?: HooksAppliedUnavailable | null | undefined;
}

/**
The hook configuration the Runtime applied.

The declaration says what the operator asked for and the applied projection
says what the Runtime published; the two are different readings, and the
reconciliation between them is the Runtime's own verdict. The Console
renders it rather than deriving one.
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
What the Runtime published, and the events it published.
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
What the source's validity reads as.

An unobserved source is not a valid one, so it says so in its own words
rather than borrowing the word for a source that was read and found sound.
*/
function sourceValidityLabel(sourceValidity: boolean | null): string {
  if (sourceValidity === null) return NOT_OBSERVED_LABEL;
  return sourceValidity ? "Valid" : "Invalid";
}

/**
A count over the declared source, or the reason it is not a number.

A count is a number only when everything it counts was observed. An invalid
source was read and found broken, and an unreadable one was never read;
neither publishes a count, because "the source declares nothing" and
"nobody read the source" are different claims.
*/
function sourceValidityCount(
  sourceValidity: boolean | null,
  count: number
): number | string {
  if (sourceValidity === true) return count;
  return sourceValidity === false ? "Invalid" : NOT_OBSERVED_LABEL;
}

/**
The declared events, or the reason there are none to show.

An invalid source shows none of its events: the first fault is why the rest
of the document was never examined, and a partial list would read as the
whole declaration.
*/
function declaredEvents(
  hooks: readonly HookDefinition[],
  sourceValidity: boolean | null,
  validationIssues: readonly ControlApiValidationIssue[]
): React.JSX.Element {
  if (hooks.length > 0) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      hooks.map(hookEventPanel)
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
One event and its declaration.
*/
function hookEventPanel(hook: HookDefinition): React.JSX.Element {
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
    React.createElement(HookActionsView, { actions: hook.actions })
  );
}

export function HooksView({
  hooks,
  validationIssues,
  sourceValidity = null,
  revision,
  sourceText,
  applied,
  appliedUnavailable = null
}: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((accumulator, h) => accumulator + h.actions.length, 0);
  // The declaration's own counts. An invalid or unreadable source publishes
  // an empty list of events, and the two cards above the table counted it as
  // a target that declares nothing -- a claim about the read rather than
  // about the target. The cards say what is known about the source instead.
  const hookEventCount = sourceValidityCount(sourceValidity, hooks.length);
  const handlerCount = sourceValidityCount(sourceValidity, totalActions);

  return React.createElement(
    PageBody,
    { feature: "hooks" },
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Hook Events",
        value: hookEventCount
      }),
      React.createElement(StatCard, {
        title: "Total Handlers",
        value: handlerCount
      }),
      React.createElement(StatCard, {
        title: "Source validation",
        value: sourceValidityLabel(sourceValidity),
        // The source and its revision, the way the Permissions view names
        // them: the path says where the declaration lives, and the revision
        // says which one this page describes.
        subtitle:
          revision === null
            ? ".rulesync/hooks.jsonc"
            : `.rulesync/hooks.jsonc revision ${revision.slice(0, 12)}`
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
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Configured Lifecycle Hooks"
      ),
      // One selector over one declaration: the rendered side is the
      // declaration the target receives, and the JSONC side is that source
      // with its comments.
      React.createElement(SourceView, {
        source: sourceText,
        format: "JSONC",
        rendered: declaredEvents(hooks, sourceValidity, validationIssues)
      })
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
