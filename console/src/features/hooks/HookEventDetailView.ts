import type {
  ControlApiHooksAppliedResponse,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { SourceView } from "../../components/code/SourceView.ts";
import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import {
  MONO_META_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  hookAppliedEventPanel,
  hookAppliedSummaryText,
  hookAppliedUnavailableNotice,
  type HooksAppliedUnavailable
} from "./applied.ts";
import { hookOriginLabel } from "./declaration.ts";
import { HookActionsView } from "./HookActionsView.ts";
import { HOOKS_PATH } from "./paths.ts";

export interface HookEventDetailViewProps {
  /**
  The event's declaration, as the target receives it.
  
  It is the same declaration the list shows on the event's card, read from
  the same place, so the two surfaces cannot describe two different
  declarations.
  */
  readonly hook: HookDefinition;
  /**
  Where the canonical declaration lives.
  */
  readonly source: string;
  /**
  Whether the canonical declaration was read and found sound.
  
  A declaration that could not be read is a different fact from one that was
  read and found invalid, and the page says which one it is looking at
  instead of showing the actions of a source it could not confirm.
  */
  readonly sourceValidity: boolean | null;
  /**
  The revision of the canonical declaration.
  
  `null` means the declaration could not be read, so there is no revision to
  name. The revision identifies the exact source this page describes, which
  is the same revision a source view would show.
  */
  readonly revision: string | null;
  /**
  The canonical declaration's exact text, or null when it was not read.
  
  The declaration is one source and the event is one of the events it holds,
  so the raw view shows the whole declaration rather than a document
  assembled around the event.
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
What the Runtime published for this event.

The projection is published for the whole declaration, so the question this
page answers is which of it belongs to this event. An event the Runtime
published nothing for is a different fact from a projection that could not
be read, and the page says which one it is looking at.
*/
function appliedEventPanel(
  event: string,
  applied: ControlApiHooksAppliedResponse | null,
  unavailable: HooksAppliedUnavailable | null
): React.JSX.Element {
  if (applied === null) {
    return hookAppliedUnavailableNotice(unavailable);
  }
  const published = applied.events.find((entry) => entry.event === event);
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      hookAppliedSummaryText(applied)
    ),
    published === undefined
      ? React.createElement(
          "p",
          {
            className: MUTED_META_CLASS,
            "data-hook-applied-missing": event
          },
          "The Runtime published no action for this event."
        )
      : hookAppliedEventPanel(published),
    React.createElement(ReconciliationPanel, {
      status: applied.reconciliation.status,
      history: applied.reconciliation.history
    })
  );
}

/**
One hook event's own page.

It is the second placement of the one control the Hooks resource owns. The
list already carries the event's actions on its card; this page carries the
same read-only actions for the same event, so the operator who opens one
event gets the same facts as the operator working down the list.
*/
export function HookEventDetailView({
  hook,
  source,
  sourceValidity,
  revision,
  sourceText,
  applied,
  appliedUnavailable = null
}: HookEventDetailViewProps): React.JSX.Element {
  return React.createElement(
    PageBody,
    {
      feature: "hooks",
      attributes: { "data-hook-event": hook.event }
    },
    React.createElement(Breadcrumbs, {
      items: [{ label: "Hooks", href: HOOKS_PATH }, { label: hook.event }]
    }),
    React.createElement(EntityTitle, { mono: true }, hook.event),
    React.createElement("p", { className: `${MONO_META_CLASS} -mt-2` }, source),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Canonical declaration",
        "data-section": "hook-declaration"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Canonical declaration"
      ),
      React.createElement(SourceView, {
        source: sourceText,
        format: "JSONC",
        rendered: React.createElement(
          DetailGrid,
          { columns: 2 },
          React.createElement(
            DetailValue,
            { label: "Declared for" },
            hookOriginLabel(hook.origin)
          ),
          React.createElement(
            DetailValue,
            { label: "Actions" },
            String(hook.actions.length)
          ),
          React.createElement(
            DetailValue,
            { label: "Canonical source" },
            // The source's own state is a fact about the read: a declaration
            // that was not read has no state, and one that was read and found
            // invalid is not the same as one that was read and found sound.
            sourceValidity === null
              ? NOT_OBSERVED_LABEL
              : sourceValidity
                ? "Valid"
                : "Invalid"
          ),
          React.createElement(
            DetailValue,
            { label: "Revision" },
            revision ?? NOT_OBSERVED_LABEL
          )
        )
      }),
      React.createElement(Tag, {
        children: hookOriginLabel(hook.origin),
        dataAttributes: { "data-hook-origin": hook.event }
      })
    ),
    React.createElement(
      "section",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Hook actions"
      ),
      React.createElement(HookActionsView, { actions: hook.actions })
    ),
    React.createElement(
      "section",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Applied hooks"
      ),
      appliedEventPanel(hook.event, applied, appliedUnavailable)
    )
  );
}
