import type {
  ControlApiHooksAppliedResponse,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
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
import {
  hookDeclarationSaveNotice,
  type HookDeclarationSaveOutcome,
  hookEditorDisabledReason,
  hookOriginLabel
} from "./declaration.ts";
import { HookEventEditor } from "./HookEventEditor.ts";
import { hookEventPath,HOOKS_PATH } from "./paths.ts";

export interface HookEventDetailViewProps {
  /**
   * The event's declaration, as the target receives it.
   *
   * It is the same declaration the list shows on the event's card, read from
   * the same place, so the two surfaces cannot describe two different
   * declarations.
   */
  readonly hook: HookDefinition;
  /**
   * Where the canonical declaration lives.
   */
  readonly source: string;
  /**
   * Whether the canonical declaration was read and found sound.
   */
  readonly sourceValidity: boolean | null;
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
 * What the Runtime published for this event.
 *
 * The projection is published for the whole declaration, so the question this
 * page answers is which of it belongs to this event. An event the Runtime
 * published nothing for is a different fact from a projection that could not
 * be read, and the page says which one it is looking at.
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
 * One hook event's own page.
 *
 * It is the second placement of the one control the Hooks resource owns. The
 * list already carries the editor on the event's card; this page carries the
 * same editor for the same event, so the operator who opens one event gets
 * the same edit surface, the same states and the same write as the operator
 * working down the list.
 */
export function HookEventDetailView({
  hook,
  source,
  sourceValidity,
  revision,
  editorRevision,
  applied,
  appliedUnavailable = null,
  saveOutcome
}: HookEventDetailViewProps): React.JSX.Element {
  const disabledReason = hookEditorDisabledReason(revision, sourceValidity);
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
    React.createElement(
      "p",
      { className: `${MONO_META_CLASS} -mt-2` },
      source
    ),
    hookDeclarationSaveNotice(saveOutcome, hook.event),
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
      React.createElement(
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
        )
      ),
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
      React.createElement(HookEventEditor, {
        // The editor's identity is the event, and nothing else: a write moves
        // the declaration's revision, and an editor that was remounted by that
        // would throw away the operator's unfinished work.
        key: hook.event,
        event: hook.event,
        actions: hook.actions,
        revision: editorRevision ?? revision ?? "",
        // A write made here answers to this page, so the operator comes back to
        // the declaration they were working on rather than being moved to the
        // list of every event.
        returnTo: hookEventPath(hook.event),
        ...(disabledReason === null ? {} : { disabledReason })
      })
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
