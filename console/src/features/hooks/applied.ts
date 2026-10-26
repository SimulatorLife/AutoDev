import type {
  ControlApiHookEvent,
  ControlApiHooksAppliedResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { NESTED_PANEL_CLASS } from "../../components/layout/Panel.ts";
import {
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import {
  MONO_ID_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

/**
 * The vocabulary the applied hook projection's two surfaces share.
 *
 * The list presents every published event and the event's own page presents
 * one of them, and the two have to say the same thing about the same
 * projection: a projection that could not be read is one fact, a projection
 * that holds no action for an event is another, and the reason for the first
 * belongs with it rather than in a log the operator never opens.
 */

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

/**
 * The state of the applied projection when it could not be read at all.
 *
 * The gap is stated as a gap -- nothing is claimed about what the Runtime
 * published -- and the reason for it travels with it, because a gap on the
 * page with no explanation for it is a question the operator cannot answer.
 */
export function hookAppliedUnavailableNotice(
  unavailable: HooksAppliedUnavailable | null
): React.JSX.Element {
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

/**
 * What the Runtime published, in one sentence.
 *
 * The list says it about the whole projection and the event's own page says it
 * about the projection that carries that event, and they say it in the same
 * words: the sentence is the same fact read from two surfaces.
 */
export function hookAppliedSummaryText(
  applied: ControlApiHooksAppliedResponse
): string {
  return applied.available
    ? `The Runtime published this hook configuration for the "${applied.target}" target from ${applied.source}.`
    : "The Runtime has published no hook configuration on this machine yet.";
}

/**
 * One event the Runtime published.
 *
 * The projection groups the actions by matcher, so what is published for an
 * event is the event's actions and the matcher they run under.
 */
export function hookAppliedEventPanel(
  event: ControlApiHookEvent
): React.JSX.Element {
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
