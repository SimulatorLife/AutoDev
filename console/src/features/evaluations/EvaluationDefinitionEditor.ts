"use client";

import React, { useState } from "react";

/**
 * JSON editor for one evaluation definition. Saving posts the draft to the
 * same-origin Console action route with its server-issued form token; on a
 * validation or conflict error the draft stays in place with the reason.
 */
export interface EvaluationDefinitionEditorProps {
  readonly initialText: string;
  /** Empty when creating a definition. */
  readonly definitionId: string;
  /** Revision being edited; empty when creating. */
  readonly expectedRevision: string;
  readonly formToken: string;
  readonly criterionTypes: readonly string[];
  readonly cancelHref: string;
}

type EditorStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export function EvaluationDefinitionEditor({
  initialText,
  definitionId,
  expectedRevision,
  formToken,
  criterionTypes,
  cancelHref
}: EvaluationDefinitionEditorProps): React.JSX.Element {
  const [text, setText] = useState(initialText);
  const [status, setStatus] = useState<EditorStatus>({ kind: "idle" });

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const response = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "save",
          definitionId,
          expectedRevision,
          formToken,
          definition: text
        })
      });
      const body = (await response.json()) as {
        readonly ok?: boolean;
        readonly definitionId?: string;
        readonly code?: string;
        readonly message?: string;
      };
      if (response.ok && body.ok && body.definitionId) {
        globalThis.location.assign(
          `/evaluations/${encodeURIComponent(body.definitionId)}?notice=saved`
        );
        return;
      }
      setStatus({
        kind: "error",
        code: body.code ?? `http_${response.status}`,
        message: body.message ?? "The definition could not be saved."
      });
    } catch {
      setStatus({
        kind: "error",
        code: "evaluation_action_unreachable",
        message: "The Console server could not be reached."
      });
    }
  }

  return React.createElement(
    "form",
    {
      onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
        void save(event);
      },
      className:
        "rounded-lg border border-slate-700 bg-slate-900/80 p-5 flex flex-col gap-3",
      "data-evaluation-editor": definitionId || "new"
    },
    React.createElement(
      "label",
      {
        htmlFor: "evaluation-definition-json",
        className: "text-sm font-semibold text-slate-200"
      },
      definitionId ? `Edit ${definitionId}` : "New evaluation definition"
    ),
    React.createElement(
      "p",
      { className: "text-xs text-slate-400 leading-relaxed" },
      "Targets are explicit AutoDev resources: ",
      React.createElement("code", null, '{"kind":"agent","id":"<role>"}'),
      " routes through autodev/<role> with its role prompt; ",
      React.createElement(
        "code",
        null,
        '{"kind":"model","id":"<catalog model>"}'
      ),
      " runs a concrete model. Either may set ",
      React.createElement("code", null, '"prompt"'),
      " to a RuleSync command. Criteria fail when the judged severity score exceeds their threshold. Supported criteria: ",
      React.createElement(
        "span",
        { className: "font-mono" },
        criterionTypes.join(", ")
      ),
      "."
    ),
    React.createElement("textarea", {
      id: "evaluation-definition-json",
      value: text,
      spellCheck: false,
      rows: 28,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        setText(event.target.value),
      className:
        "w-full rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
    }),
    status.kind === "error"
      ? React.createElement(
          "div",
          {
            role: "alert",
            className:
              "rounded border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-100"
          },
          React.createElement(
            "span",
            { className: "font-mono mr-2" },
            status.code
          ),
          status.message
        )
      : null,
    React.createElement(
      "div",
      { className: "flex items-center gap-3" },
      React.createElement(
        "button",
        {
          type: "submit",
          disabled: status.kind === "saving",
          className:
            "rounded border border-emerald-700 bg-emerald-900/50 px-3 py-1.5 text-sm font-medium text-emerald-100 hover:bg-emerald-900/80 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        },
        status.kind === "saving" ? "Saving…" : "Save definition"
      ),
      React.createElement(
        "a",
        {
          href: cancelHref,
          className: "text-sm text-slate-400 hover:underline"
        },
        "Cancel"
      )
    )
  );
}
