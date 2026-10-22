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

interface PreviewOutcome {
  readonly valid: boolean;
  readonly preview: string;
  readonly error: string | null;
}

export function PromptSourcePreview({
  name,
  editorId
}: {
  readonly name: string;
  readonly editorId: string;
}): React.JSX.Element {
  const [outcome, setOutcome] = useState<PreviewOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const requestPreview = async () => {
    if (pending) return;
    const editor = document.querySelector<HTMLTextAreaElement>(`#${editorId}`);
    if (editor === null) {
      setFailure("The source editor is not on the page.");
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch("/api/prompts/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, content: editor.value })
      });
      const body: unknown = await response.json();
      if (response.ok && typeof body === "object" && body !== null) {
        const { valid, preview, error } = body as Record<string, unknown>;
        setOutcome({
          valid: valid === true,
          preview: typeof preview === "string" ? preview : "",
          error: typeof error === "string" ? error : null
        });
        return;
      }
      setFailure("The unsaved source could not be previewed.");
      setOutcome(null);
      const { valid, preview, error } = body as Record<string, unknown>;
      setOutcome({
        valid: valid === true,
        preview: typeof preview === "string" ? preview : "",
        error: typeof error === "string" ? error : null
      });
    } catch {
      setFailure("The unsaved source could not be previewed.");
      setOutcome(null);
    } finally {
      setPending(false);
    }
  };

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-3",
      "data-prompt-source-preview": "true"
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      React.createElement(
        Button,
        {
          type: "button",
          variant: "secondary",
          onClick: () => void requestPreview(),
          disabled: pending,
          testId: "prompt-preview"
        },
        pending ? "Previewing…" : "Preview unsaved changes"
      ),
      outcome === null
        ? null
        : React.createElement(
            Button,
            {
              type: "button",
              variant: "outline",
              onClick: () => {
                setOutcome(null);
                setFailure(null);
              },
              testId: "prompt-preview-hide"
            },
            "Hide the unsaved preview"
          )
    ),
    failure === null
      ? null
      : React.createElement(
          "p",
          {
            className: CALLOUT_ERROR_CLASS,
            role: "alert",
            "data-prompt-preview-failure": "true"
          },
          failure
        ),
    outcome === null
      ? React.createElement(
          "p",
          { className: MUTED_META_CLASS, "data-prompt-preview-hint": "true" },
          "The preview shows the unsaved source as it would render. Saving validates it, regenerates the projection and may require restarting Codex."
        )
      : React.createElement(
          "section",
          {
            className: NESTED_PANEL_CLASS,
            "data-prompt-unsaved-preview": outcome.valid
              ? "observed"
              : "invalid"
          },
          React.createElement(
            "p",
            { className: `mb-2 ${SECTION_LABEL_CLASS}` },
            "Unsaved source preview"
          ),
          outcome.valid === false
            ? React.createElement(
                "p",
                {
                  className: CALLOUT_WARNING_CLASS,
                  role: "status",
                  "data-prompt-unsaved-preview-body": "invalid"
                },
                outcome.error ??
                  "The canonical RuleSync parser refused this source."
              )
            : outcome.preview.length > 0
              ? React.createElement(
                  "div",
                  { "data-prompt-unsaved-preview-body": "observed" },
                  React.createElement(PromptMarkdown, { body: outcome.preview })
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
  );
}
