import type { PromptDocument } from "@simulatorlife/autodev-core";
import React from "react";

import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { ConsoleLink } from "../../components/navigation/ConsoleLink.ts";
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
          "flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface p-6 shadow"
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
              "mb-1 mt-3 text-xs uppercase tracking-wider text-fg-muted"
          },
          prompt.kind === "command" ? "RuleSync command" : "Agent role prompt"
        ),
        React.createElement(
          "h2",
          { className: "text-2xl font-bold text-fg font-mono" },
          prompt.name
        ),
        React.createElement(
          "p",
          { className: "mt-2 font-mono text-xs text-fg-muted" },
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
          { className: "font-mono text-xs text-fg-muted" },
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
        { className: "rounded-lg border border-border bg-surface p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-fg-muted" },
          "Authority & Versioning"
        ),
        React.createElement(StatusBadge, {
          status: "configured",
          label: "RuleSync Git provenance"
        }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-fg-muted" },
          "Canonical source lives in working tree; version history is tracked via Git commits."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-fg-muted" },
          "Related Agent"
        ),
        isRole
          ? React.createElement(
              ConsoleLink,
              {
                href: `/agents/${encodeURIComponent(prompt.name)}`,
                className:
                  "text-xs font-semibold text-accent hover:underline block mb-1"
              },
              `Agent: ${prompt.name} →`
            )
          : React.createElement(
              "span",
              { className: "text-xs text-fg-muted block mb-1" },
              "RuleSync command (all roles)"
            ),
        React.createElement(
          "p",
          { className: "text-xs text-fg-muted" },
          isRole
            ? "Inspect execution contract, model routes, and tool permissions for this role."
            : "Commands are exposed across configured agent roles."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-4" },
        React.createElement(
          "h3",
          { className: "mb-1 text-xs uppercase tracking-wider text-fg-muted" },
          "Observability Linkage"
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-1 text-xs" },
          React.createElement(
            ConsoleLink,
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: "text-accent hover:underline"
            },
            "Evaluations results →"
          ),
          React.createElement(
            ConsoleLink,
            {
              href: `/usage?role=${encodeURIComponent(prompt.name)}`,
              className: "text-fg-secondary hover:underline"
            },
            "Token & request usage →"
          )
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-border bg-surface p-6 shadow",
        "aria-label": "Prompt source preview"
      },
      React.createElement(
        "div",
        { className: "mb-3 flex items-center justify-between" },
        React.createElement(
          "h3",
          { className: "text-xs uppercase tracking-wider text-fg-muted" },
          "Canonical Markdown Source"
        ),
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-muted" },
          prompt.path
        )
      ),
      prompt.content.length === 0
        ? React.createElement(
            "p",
            {
              className: "text-sm text-fg-muted",
              "data-prompt-content": "empty"
            },
            "The canonical source file is empty."
          )
        : React.createElement(
            "pre",
            {
              className:
                "max-h-[40rem] overflow-auto whitespace-pre-wrap rounded border border-border bg-background p-4 font-mono text-xs text-fg-secondary",
              "data-prompt-content": "observed"
            },
            prompt.content
          )
    ),
    React.createElement(
      "p",
      { className: "text-xs text-fg-muted" },
      "Read-only preview. Canonical RuleSync prompts remain authoritative in-tree. Prompt editing, version history, validation, and apply operations are governed by repository Git provenance rather than an independent database."
    )
  );
}
