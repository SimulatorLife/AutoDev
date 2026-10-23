"use client";

import type { PlaytestComparison } from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import {
  SELECT_CONTROL_BLOCK_WRAPPER_CLASS,
  SelectChevron
} from "../../components/forms/SelectChevron.ts";
import {
  SELECT_CONTROL_CLASS,
  TEXT_CONTROL_CLASS
} from "../../components/ui/field-classes.ts";

export interface PlaytestComparisonDecisionFormProps {
  readonly workspaceId: string;
  readonly comparison: PlaytestComparison;
  readonly enabled: boolean;
}

function decisionSummary(comparison: PlaytestComparison): string {
  if (comparison.ownerDisposition === "not-recorded") {
    return `Historical reason (disposition/author not recorded): ${comparison.ownerDecisionReason}`;
  }
  if (comparison.ownerDisposition !== null) {
    return `${comparison.ownerDisposition} by ${comparison.ownerDecisionBy}: ${comparison.ownerDecisionReason}`;
  }
  return "No owner decision recorded";
}

export function PlaytestComparisonDecisionForm({
  workspaceId,
  comparison,
  enabled
}: PlaytestComparisonDecisionFormProps): React.JSX.Element {
  const [current, setCurrent] = useState(comparison);
  const [disposition, setDisposition] = useState<"promote" | "hold">("hold");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canPromote = current.decision === "eligible-for-owner-promotion";

  async function submit(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault();
    if (pending || reason.trim().length === 0) return;
    if (disposition === "promote" && !canPromote) {
      setMessage("This comparison is not eligible for owner promotion.");
      return;
    }
    if (!confirming) {
      setConfirming(true);
      setMessage(
        `Confirm the immutable ${disposition} decision. No release or deployment will be performed.`
      );
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const body = new URLSearchParams({
        workspaceId,
        expectedVersion: String(current.version),
        disposition,
        reason
      });
      const response = await fetch(
        `/api/playtesting/comparisons/${encodeURIComponent(current.comparisonId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          cache: "no-store"
        }
      );
      const payload = (await response.json()) as {
        kind?: unknown;
        data?: { comparison?: PlaytestComparison };
        message?: unknown;
      };
      const updated = payload.data?.comparison;
      if (
        !response.ok ||
        payload.kind !== "ok" ||
        !updated ||
        updated.comparisonId !== current.comparisonId ||
        updated.version !== current.version + 1 ||
        updated.ownerDisposition !== disposition
      ) {
        setMessage(
          typeof payload.message === "string"
            ? payload.message
            : "The owner decision was not recorded. Refresh and review the latest revision."
        );
        return;
      }
      setCurrent(updated);
      setMessage(
        "Recorded " + disposition + ". No release or deployment was performed."
      );
      setReason("");
      setConfirming(false);
    } catch {
      setMessage(
        "The Control API is unavailable; no release action was performed."
      );
    } finally {
      setPending(false);
    }
  }

  const form =
    enabled && current.ownerDisposition === null
      ? React.createElement(
          "form",
          {
            className: "mt-2 grid min-w-52 gap-2",
            onSubmit: submit,
            "aria-label": `Record owner decision for ${current.comparisonId}`,
            "data-comparison-owner-decision": current.comparisonId
          },
          React.createElement(
            "label",
            { className: "grid gap-1 text-xs" },
            React.createElement("span", {}, "Disposition"),
            React.createElement(
              "span",
              { className: SELECT_CONTROL_BLOCK_WRAPPER_CLASS },
              React.createElement(
                "select",
                {
                  value: disposition,
                  disabled: pending,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                    setDisposition(
                      event.currentTarget.value as "promote" | "hold"
                    );
                    setConfirming(false);
                    setMessage(null);
                  },
                  className: `${SELECT_CONTROL_CLASS} w-full`
                },
                canPromote
                  ? React.createElement(
                      "option",
                      { value: "promote" },
                      "Promote eligible candidate"
                    )
                  : null,
                React.createElement("option", { value: "hold" }, "Hold")
              ),
              React.createElement(SelectChevron)
            )
          ),
          React.createElement(
            "label",
            { className: "grid gap-1 text-xs" },
            React.createElement("span", {}, "Decision reason"),
            React.createElement("textarea", {
              value: reason,
              required: true,
              maxLength: 4000,
              rows: 2,
              disabled: pending,
              onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
                setReason(event.currentTarget.value);
                setConfirming(false);
                setMessage(null);
              },
              className: `${TEXT_CONTROL_CLASS} w-full py-2 leading-relaxed`,
              "aria-label": "Owner decision reason"
            })
          ),
          React.createElement(
            Button,
            {
              type: "submit",
              variant: "secondary",
              size: "compact",
              // The reason has to be there for the decision to be reviewable;
              // the request being in flight is a different state, and it is
              // the one that keeps the operator's focus.
              disabled: reason.trim().length === 0,
              busy: pending
            },
            pending
              ? "Recording…"
              : confirming
                ? `Confirm ${disposition}`
                : "Review decision"
          ),
          confirming
            ? React.createElement(
                Button,
                {
                  type: "button",
                  variant: "outline",
                  size: "compact",
                  busy: pending,
                  onClick: () => {
                    setConfirming(false);
                    setMessage(null);
                  }
                },
                "Edit decision"
              )
            : null
        )
      : null;
  const feedback =
    message === null
      ? null
      : React.createElement(
          "p",
          {
            className: "text-xs text-muted-foreground",
            role: "status",
            "aria-live": "polite"
          },
          message
        );
  return React.createElement(
    "div",
    { className: "grid gap-1" },
    React.createElement("p", {}, decisionSummary(current)),
    form,
    feedback
  );
}
