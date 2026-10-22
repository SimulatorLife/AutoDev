"use client";

import React, { useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { NESTED_PANEL_CLASS } from "../../components/layout/Panel.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS,
  SECTION_LABEL_CLASS
} from "../../components/ui/text-classes.ts";
import { PromptMarkdown } from "./prompt-markdown.ts";

/**
 * The preview of the source the operator has not saved yet.
 *
 * The editor is a plain text control, so the source the operator is looking
 * at is in the document rather than in React's state. The island reads that
 * control when the operator asks for a preview, and asks the Console's own
 * server what the source would render as. The server answers with Data's
 * canonical RuleSync parser, so the preview is the same body the save would
 * produce -- and a source the parser refuses is reported with the reason the
 * save would refuse it with.
 *
 * The preview writes nothing. A save is the operator's separate act, and the
 * reason to preview is to look before taking it.
 */

/**
 * What the preview is showing.
 *
 * One state, so the island cannot report two things at once. A refused source
 * is a refusal with a reason, and a request that never got an answer is a
 * failure; they used to be three independent pieces of state, so a response
 * the route turned down set the failure *and* the outcome, and the operator
 * read a generic alert on top of the reason it was given.
 */
type PreviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly body: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The control that asks for the preview.
 *
 * It stays focusable while the request is in flight. A disabled control is
 * dropped out of the page's focus order the moment it is disabled, so the
 * operator who asked for a preview lost their place in the document and the
 * next Tab started from the top of the page. The Console's own form owner
 * publishes its pending state rather than disabling its controls for the same
 * reason, so this one publishes it too: the busy state is on the control, the
 * visible label carries it, and the control keeps the focus the operator left
 * it in.
 */
export function PromptPreviewControl({
  pending,
  onPreview
}: {
  readonly pending: boolean;
  readonly onPreview: () => void;
}): React.JSX.Element {
  return React.createElement(
    Button,
    {
      type: "button",
      variant: "secondary",
      onClick: onPreview,
      busy: pending,
      testId: "prompt-preview"
    },
    pending ? "Previewing…" : "Preview unsaved changes"
  );
}

/**
 * What the island says out loud about the request.
 *
 * One sentence per state, and it names the outcome rather than reading the
 * preview back: the preview is on the page, and a live region that announced
 * the whole body would read a whole prompt aloud. A failure says nothing here
 * because its alert says it, and an alert that interrupts is not worth
 * repeating politely.
 */
function previewAnnouncement(state: PreviewState): string {
  if (state.kind === "pending") return "Previewing the unsaved source.";
  if (state.kind === "ready") return "The unsaved source preview is ready.";
  if (state.kind === "refused") {
    return `The unsaved source was refused. ${state.reason}`;
  }
  // A failure says nothing here because its alert says it, and an alert that
  // interrupts is not worth repeating politely. An island that has not been
  // asked anything has nothing to announce either.
  return "";
}

export function PromptSourcePreview({
  name,
  editorId
}: {
  readonly name: string;
  readonly editorId: string;
}): React.JSX.Element {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });

  const requestPreview = async () => {
    if (state.kind === "pending") return;
    const editor = document.querySelector<HTMLTextAreaElement>(`#${editorId}`);
    if (editor === null) {
      setState({
        kind: "failed",
        reason: "The source editor is not on the page."
      });
      return;
    }
    setState({ kind: "pending" });
    try {
      const response = await fetch("/api/prompts/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, content: editor.value })
      });
      const body: unknown = await response.json();
      const answer =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const reason = typeof answer.error === "string" ? answer.error : null;
      if (!response.ok) {
        // The route turned the request down and said why. That reason is the
        // answer, so it is the answer the operator gets.
        setState({
          kind: "failed",
          reason:
            reason ??
            "The unsaved source could not be previewed. The Console did not say why."
        });
        return;
      }
      if (answer.valid === true) {
        setState({
          kind: "ready",
          body: typeof answer.preview === "string" ? answer.preview : ""
        });
        return;
      }
      setState({
        kind: "refused",
        reason: reason ?? "The canonical RuleSync parser refused this source."
      });
    } catch {
      setState({
        kind: "failed",
        reason: "The unsaved source could not be previewed."
      });
    }
  };

  const pending = state.kind === "pending";
  const outcome = state.kind === "ready" || state.kind === "refused";
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-3",
      "data-prompt-source-preview": "true"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(PromptPreviewControl, {
        pending,
        onPreview: () => void requestPreview()
      }),
      outcome
        ? React.createElement(
            Button,
            {
              type: "button",
              variant: "outline",
              onClick: () => setState({ kind: "idle" }),
              testId: "prompt-preview-hide"
            },
            "Hide the unsaved preview"
          )
        : null
    ),
    React.createElement(
      "p",
      {
        // Polite so the outcome is heard without moving the operator's place.
        "aria-live": "polite",
        "aria-atomic": "true",
        className: "sr-only",
        "data-prompt-preview-status": "true"
      },
      previewAnnouncement(state)
    ),
    state.kind === "failed"
      ? React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert",
            "data-prompt-preview-failure": "true"
          },
          state.reason
        )
      : null,
    outcome
      ? React.createElement(
          "section",
          {
            className: NESTED_PANEL_CLASS,
            "data-prompt-unsaved-preview":
              state.kind === "ready" ? "observed" : "invalid"
          },
          React.createElement(
            "p",
            { className: `mb-2 ${SECTION_LABEL_CLASS}` },
            "Unsaved source preview"
          ),
          state.kind === "refused"
            ? React.createElement(
                "p",
                {
                  className: CALLOUT_WARNING_CLASS,
                  "data-prompt-unsaved-preview-body": "invalid"
                },
                state.reason
              )
            : state.body.length > 0
              ? React.createElement(
                  "div",
                  { "data-prompt-unsaved-preview-body": "observed" },
                  React.createElement(PromptMarkdown, { body: state.body })
                )
              : React.createElement(
                  "p",
                  {
                    className: MUTED_BODY_CLASS,
                    "data-prompt-unsaved-preview-body": "empty"
                  },
                  "The canonical Markdown body is empty."
                )
        )
      : React.createElement(
          "p",
          { className: MUTED_META_CLASS, "data-prompt-preview-hint": "true" },
          "The preview shows the unsaved source as it would render. Saving validates it, regenerates the projection and may require restarting Codex."
        )
  );
}
