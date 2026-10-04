import type { PromptDocument } from "@simulatorlife/autodev-core";
import React from "react";

import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";

export interface PromptDetailViewProps {
  readonly prompt: PromptDocument;
}

export function PromptDetailView({
  prompt
}: PromptDetailViewProps): React.JSX.Element {
  const lineCount = prompt.content ? prompt.content.split("\n").length : 0;
  const characterCount = prompt.content ? prompt.content.length : 0;
  const isRole = prompt.kind === "role" || prompt.path.includes("roles");

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
        React.createElement(Breadcrumbs, {
          items: [
            { label: "Prompts", href: "/prompts" },
            { label: prompt.name }
          ]
        }),
        React.createElement(
          "p",
          {
            className:
              "mb-1 mt-3 text-xs uppercase tracking-wider text-slate-400"
          },
          prompt.kind === "command" ? "RuleSync command" : "Agent role prompt"
        ),
        React.createElement(
          "h2",
          { className: "text-2xl font-bold text-slate-100 font-mono" },
          prompt.name
        ),
        React.createElement(
          "p",
          { className: "mt-2 font-mono text-xs text-slate-400" },
          prompt.path
        )
      ),
      React.createElement(
        "div",
        { className: "flex flex-col items-end gap-2" },
        React.createElement(StatusBadge, {
          status: "configured",
          label: "Canonical source"
        }),
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-400" },
          `${lineCount} lines | ${characterCount} chars`
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: "grid gap-4 md:grid-cols-3",
        "aria-label": "Prompt metadata and linkage",
        "data-section": "prompt-linkage"
      },
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-slate-400" },
          "Authority & Versioning"
        ),
        React.createElement(StatusBadge, {
          status: "configured",
          label: "RuleSync Git provenance"
        }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-slate-500" },
          "Canonical source lives in working tree; version history is tracked via Git commits."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-slate-400" },
          "Related Agent"
        ),
        isRole
          ? React.createElement(
              "a",
              {
                href: `/agents/${encodeURIComponent(prompt.name)}`,
                className:
                  "text-xs font-semibold text-emerald-400 hover:underline block mb-1"
              },
              `Agent: ${prompt.name} →`
            )
          : React.createElement(
              "span",
              { className: "text-xs text-slate-400 block mb-1" },
              "RuleSync command (all roles)"
            ),
        React.createElement(
          "p",
          { className: "text-xs text-slate-500" },
          isRole
            ? "Inspect execution contract, model routes, and tool permissions for this role."
            : "Commands are exposed across configured agent roles."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-slate-400" },
          "Observability Linkage"
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-1 text-xs" },
          React.createElement(
            "a",
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: "text-emerald-400 hover:underline"
            },
            "Evaluations results →"
          ),
          React.createElement(
            "a",
            {
              href: `/usage?role=${encodeURIComponent(prompt.name)}`,
              className: "text-slate-300 hover:underline"
            },
            "Token & request usage →"
          )
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow",
        "aria-label": "Prompt source preview"
      },
      React.createElement(
        "div",
        { className: "mb-3 flex items-center justify-between" },
        React.createElement(
          "h3",
          { className: "text-xs uppercase tracking-wider text-slate-400" },
          "Canonical Markdown Source"
        ),
        React.createElement(
          "span",
          { className: "font-mono text-xs text-slate-500" },
          prompt.path
        )
      ),
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
      "Read-only preview. Canonical RuleSync prompts remain authoritative in-tree. Prompt editing, version history, validation, and apply operations are governed by repository Git provenance rather than an independent database."
    )
  );
}
