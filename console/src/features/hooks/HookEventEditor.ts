"use client";

import type { HookAction, HookEvent } from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { NESTED_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { TEXT_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * One action as the operator is editing it.
 *
 * The draft holds what the operator typed, so the editor and the form cannot
 * disagree about what will be written. The id is the draft's identity and
 * never changes; the position in the list is the wire format's index, and the
 * two are different things.
 */
interface HookActionDraft {
  readonly id: number;
  readonly command: string;
  readonly matcher: string;
  readonly statusMessage: string;
}

export interface HookEventEditorProps {
  readonly event: HookEvent;
  readonly actions: readonly HookAction[];
  /**
   * The revision the declaration was read at.
   *
   * The write is a compare-and-swap on it, so the form carries the revision
   * the operator's edit was written against rather than the revision the
   * declaration may have moved to while the page was open.
   */
  readonly revision: string;
  /**
   * Why the editor cannot be used.
   *
   * Required rather than defaulted: a control that cannot change stays in
   * place, disabled, with the reason. An editor that is simply absent would
   * leave the operator looking for it.
   */
  readonly disabledReason?: string | undefined;
}

/**
 * One labelled control in an action group.
 *
 * The label wraps the control, so the association needs no id and survives
 * the row moving when an action above it is removed.
 */
function actionField(
  label: string,
  name: string,
  value: string,
  disabled: boolean,
  onChange: (value: string) => void,
  dataAttribute: string,
  index: number
): React.JSX.Element {
  return React.createElement(
    "label",
    { className: "flex flex-col gap-1 text-xs text-fg-muted" },
    label,
    React.createElement("input", {
      className: TEXT_CONTROL_CLASS,
      name,
      value,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChange(event.currentTarget.value),
      // The full value, because the field is narrower than the value at phone
      // widths and the text is cut at the field's edge. The Console's rule for
      // a truncated value is that the whole of it stays reachable, and this is
      // how it reaches one.
      title: value,
      // The value is the action's position, so a reader can name the action a
      // control belongs to rather than the field's own name.
      [dataAttribute]: String(index)
    })
  );
}

/**
 * One hook event's edit surface.
 *
 * It is a plain form, and that is the whole point. The Console's navigation
 * owner is the only thing that may drive its router, and a feature that
 * refreshes the page itself brings back the strand the owner exists to end.
 * The owner also keeps what an operator typed, because the editor is not
 * remounted while the declaration it is based on stays where it is: a refused
 * write leaves the revision the editor was filled from in place, so the edit
 * survives it.
 *
 * The action list is the editor's own state because the number of actions is
 * not fixed: an event may run one command or several, and the editor has to
 * be able to add and remove one without a page round trip.
 */
export function HookEventEditor({
  event,
  actions,
  revision,
  disabledReason
}: HookEventEditorProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<readonly HookActionDraft[]>(() =>
    actions.map((action, index) => ({
      id: index,
      command: action.command,
      matcher: action.matcher ?? "",
      statusMessage: action.statusMessage ?? ""
    }))
  );
  const [nextId, setNextId] = useState(actions.length);
  const disabled = disabledReason !== undefined;

  const update = (
    id: number,
    field: "command" | "matcher" | "statusMessage",
    value: string
  ): void => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, [field]: value } : draft
      )
    );
  };

  const remove = (id: number): void => {
    setDrafts((current) => {
      const remaining = current.filter((draft) => draft.id !== id);
      // The form always carries at least one action group, because a form
      // with none cannot say whether the event has no actions or the editor
      // failed to render it. The empty group is the operator's next action.
      return remaining.length > 0
        ? remaining
        : [{ id, command: "", matcher: "", statusMessage: "" }];
    });
  };

  const add = (): void => {
    setDrafts((current) => [
      ...current,
      { id: nextId, command: "", matcher: "", statusMessage: "" }
    ]);
    setNextId((current) => current + 1);
  };

  return React.createElement(
    "form",
    {
      method: "POST",
      action: `/api/hooks/${event}`,
      className: "flex flex-col gap-3",
      "aria-label": `Edit the canonical hook declaration for ${event}`,
      "data-hook-event-editor": event
    },
    React.createElement("input", {
      type: "hidden",
      name: "expectedRevision",
      value: revision
    }),
    drafts.map((draft, index) =>
      React.createElement(
        "fieldset",
        {
          key: draft.id,
          className: `${NESTED_PANEL_CLASS} flex flex-col gap-2`,
          "data-hook-action": String(index)
        },
        React.createElement(
          "legend",
          { className: "px-1 text-xs font-medium" },
          `Action ${index + 1}`
        ),
        actionField(
          "Command",
          `command-${index}`,
          draft.command,
          disabled,
          (value) => update(draft.id, "command", value),
          "data-hook-action-command",
          index
        ),
        actionField(
          "Matcher",
          `matcher-${index}`,
          draft.matcher,
          disabled,
          (value) => update(draft.id, "matcher", value),
          "data-hook-action-matcher",
          index
        ),
        actionField(
          "Status message",
          `statusMessage-${index}`,
          draft.statusMessage,
          disabled,
          (value) => update(draft.id, "statusMessage", value),
          "data-hook-action-status-message",
          index
        ),
        React.createElement(
          Button,
          {
            type: "button",
            size: "compact",
            onClick: () => remove(draft.id),
            disabled,
            dataAttributes: { "data-hook-remove-action": String(index) }
          },
          "Remove action"
        )
      )
    ),
    disabledReason === undefined
      ? null
      : React.createElement(
          "p",
          { className: MUTED_META_CLASS, "data-hook-editor-disabled": "true" },
          disabledReason
        ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "p",
        { className: `max-w-2xl ${MUTED_META_CLASS}` },
        "Saving writes this event's whole action list to the canonical declaration and asks the Runtime to apply it. An action whose command is empty is not written, so clearing the last command removes the event."
      ),
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement(
          Button,
          {
            type: "button",
            size: "compact",
            onClick: add,
            disabled,
            dataAttributes: { "data-hook-add-action": event }
          },
          "Add action"
        ),
        React.createElement(
          Button,
          {
            type: "submit",
            variant: "primary",
            disabled,
            testId: "hook-event-save"
          },
          "Save and apply"
        )
      )
    )
  );
}
