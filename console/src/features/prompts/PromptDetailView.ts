import type { PromptDocument } from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";

export interface PromptDetailViewProps {
  readonly prompt: PromptDocument;
}

export function PromptDetailView({
  prompt
}: PromptDetailViewProps): React.JSX.Element {
  return React.createElement(
    "article",
    { className: "flex flex-col gap-5", "data-feature": "prompt-detail" },
    React.createElement(
      "header",
      {
        className:
          "flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900 p-6 shadow"
      },
      React.createElement(
        "div",
        null,
        React.createElement(
          "p",
          { className: "mb-1 text-xs uppercase tracking-wider text-slate-400" },
          prompt.kind === "command" ? "RuleSync command" : "Agent role prompt"
        ),
        React.createElement(
          "h2",
          { className: "text-2xl font-bold text-slate-100" },
          prompt.name
        ),
        React.createElement(
          "p",
          { className: "mt-2 font-mono text-xs text-slate-400" },
          prompt.path
        )
      ),
      React.createElement(StatusBadge, {
        status: "configured",
        label: "Canonical source"
      })
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
        "aria-label": "Prompt source preview"
      },
      prompt.content.length === 0
        ? React.createElement(
            "p",
            {
              className: "text-sm text-slate-400",
              "data-prompt-content": "empty"
            },
            "The canonical source file is empty."
          )
        : React.createElement(
            "pre",
            {
              className:
                "max-h-[40rem] overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-slate-300",
              "data-prompt-content": "observed"
            },
            prompt.content
          )
    ),
    React.createElement(
      "p",
      { className: "text-xs text-slate-500" },
      "Read-only preview. Prompt editing, version history, validation, and apply operations are not yet available."
    )
  );
}
