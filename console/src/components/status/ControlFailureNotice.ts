import React from "react";

import {
  CONTROL_REFUSAL_REASONS,
  type ControlRefusalReason
} from "../../lib/control-failure.ts";
import { CALLOUT_WARNING_CLASS } from "../layout/Callout.ts";

/**
 * One sentence per refusal the route can actually observe.
 *
 * The notice's primary sentence is deliberately outcome-free -- the refreshed
 * value the redirect lands on is the authoritative answer -- but these are not
 * invented outcomes. They are reasons the route refused on its own, before or
 * instead of asking the Runtime, and they change what the operator should do
 * next. `confirmation_missing` in particular is the one case where the obvious
 * next action is simply to do what the form asked.
 */
export function isControlRefusalReason(
  value: unknown
): value is ControlRefusalReason {
  return (
    typeof value === "string" &&
    (CONTROL_REFUSAL_REASONS as readonly string[]).includes(value)
  );
}

const REFUSAL_DETAIL: Record<ControlRefusalReason, string> = {
  confirmation_missing:
    "This action needs the confirmation box ticked before it can run; nothing was sent to the Runtime.",
  reason_not_accepted:
    "The Runtime does not accept that reason for this action, so nothing was changed.",
  reason_required:
    "This action needs to say what it is acting on before it can run; nothing was sent to the Runtime.",
  claim_required:
    "A revision needs the replacement claim text; nothing was sent to the Runtime.",
  content_required:
    "A skill promotion needs the procedure body to write. Nothing was sent to the Runtime.",
  prior_required:
    "A supersession has to name the record it retires. Nothing was sent to the Runtime, so the older claim is still active.",
  evidence_required:
    "This action needs the evidence it rests on — a kind and where it lives. Nothing was sent to the Runtime.",
  provenance_required:
    "A revision has to name the experiences it derives from, and this record cites none. Nothing was sent to the Runtime.",
  runtime_refused:
    "The Runtime did not accept this change, and did not say why. Nothing was changed.",
  request_invalid:
    "The Runtime rejected this request as invalid before doing any work, so nothing was changed. Sending the same thing again will be refused the same way.",
  still_cited:
    "A durable memory still cites this raw experience, so erasing it would leave a claim with no source. It cannot be purged while it is cited.",
  conflicted:
    "This changed since the list you acted on was read. Reload it and decide again.",
  not_found: "This is no longer there. The list you acted on was stale.",
  forbidden: "Your reader is not permitted to do this. Nothing was changed.",
  unavailable: "The Runtime could not be reached, so nothing was changed.",
  operation_failed:
    "The Runtime accepted this change and then could not complete it, so nothing was changed. Unlike a refusal, this can succeed on a second attempt."
};

/**
 * Shown after a mutation could not be confirmed.
 *
 * One notice for every mutation surface, so a failed provider toggle, model
 * edit, or memory transition reads identically. It deliberately claims only
 * that the change is unconfirmed: the refreshed value the redirect lands on is
 * the authoritative answer, so the notice must not invent a more specific
 * outcome it cannot know.
 *
 * `refusal` adds one line *only* where the route observed a reason, passed as a
 * bounded code in an in-place result or fallback redirect rather than as a
 * message the Console chose. Every other mutation surface can continue to use
 * the generic notice without inventing a more specific outcome.
 *
 * It carries the shared warning callout rather than its own geometry, so a
 * mutation that could not be confirmed looks like every other warning the
 * Console shows.
 */
export function ControlFailureNotice({
  refusal
}: {
  readonly refusal?: ControlRefusalReason | undefined;
}): React.JSX.Element {
  const detail =
    refusal === undefined ? undefined : (REFUSAL_DETAIL[refusal] ?? undefined);
  return React.createElement(
    "div",
    {
      role: "status",
      "data-control-outcome": "failed",
      ...(refusal === undefined ? {} : { "data-control-refusal": refusal }),
      className: CALLOUT_WARNING_CLASS
    },
    "The change could not be confirmed. Check the current state before retrying.",
    detail === undefined
      ? null
      : React.createElement("span", { className: "mt-1 block" }, detail)
  );
}
