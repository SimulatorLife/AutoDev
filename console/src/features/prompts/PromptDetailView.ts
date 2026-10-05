import type { PromptDocument } from "@simulatorlife/autodev-core";
import React from "react";

import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";

export type PromptSaveOutcome =
  | "conflict"
  | "validation"
  | "apply-failed"
  | "failed";

export interface PromptDetailViewProps {
  readonly prompt: PromptDocument;
  readonly saveOutcome?: PromptSaveOutcome | undefined;
}

export function PromptDetailView({
  prompt,
  saveOutcome
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
          `${lineCount} lines | ${characterCount} chars | rev ${prompt.revision.slice(0, 12)}`
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
          label: isRole ? "Role prompt source" : "RuleSync command source"
        }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-fg-muted" },
          "Canonical source lives in the working tree; Git commits provide version history."
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
              "a",
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
            "a",
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: "text-accent hover:underline"
            },
            "Evaluations results →"
          ),
          React.createElement(
            "a",
            {
              href: `/usage?role=${encodeURIComponent(prompt.name)}`,
              className: "text-fg-secondary hover:underline"
            },
            "Token & request usage →"
          )
        )
      )
    ),
    saveOutcome
      ? React.createElement(
          "p",
          {
            className:
              saveOutcome === "apply-failed"
                ? "rounded border border-error/40 bg-error/10 p-3 text-sm text-error"
                : saveOutcome === "failed"
                  ? "rounded border border-error/40 bg-error/10 p-3 text-sm text-error"
                  : "rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning",
            role: "alert",
            "data-prompt-save-outcome": saveOutcome
          },
          saveOutcome === "conflict"
            ? "This command changed after you loaded it. The current canonical source is shown; review it before saving again."
            : saveOutcome === "validation"
              ? "The canonical command was not updated because its source is invalid. Review the frontmatter and try again."
              : saveOutcome === "apply-failed"
                ? "The canonical source was saved, but RuleSync generation or projection apply failed. The editor shows the current source; verify it before retrying."
                : "The save and apply result could not be confirmed. Reload the canonical source before retrying."
        )
      : null,
    React.createElement(
      "section",
      {
        className: "rounded-lg border border-border bg-surface p-6 shadow",
        "aria-label": prompt.kind === "command" ? "Prompt source editor" : "Prompt source preview",
        "data-prompt-editor": prompt.kind === "command" ? "canonical" : "read-only"
      },
      React.createElement(
        "div",
        { className: "mb-3 flex items-center justify-between gap-3" },
        React.createElement(
          "h3",
          { className: "text-xs uppercase tracking-wider text-fg-muted" },
          prompt.kind === "command"
            ? "Edit Canonical Markdown Source"
            : "Canonical Markdown Source"
        ),
        React.createElement(
          "span",
          { className: "truncate font-mono text-xs text-fg-muted" },
          prompt.path
        )
      ),
      prompt.kind === "command"
        ? React.createElement(
            "form",
            {
              method: "POST",
              action: `/api/prompts/${encodeURIComponent(prompt.name)}`,
              className: "flex flex-col gap-3",
              "aria-label": `Edit command ${prompt.name}`
            },
            React.createElement("input", {
              type: "hidden",
              name: "expectedRevision",
              value: prompt.revision
            }),
            React.createElement("label", {
              htmlFor: "prompt-content",
              className: "sr-only"
            }, "Canonical Markdown source"),
            React.createElement("textarea", {
              id: "prompt-content",
              name: "content",
              required: true,
              rows: 24,
              spellCheck: false,
              defaultValue: prompt.content,
              "data-prompt-content": prompt.content.length === 0 ? "empty" : "observed",
              className:
                "min-h-[32rem] w-full resize-y overflow-auto rounded border border-border bg-background p-4 font-mono text-xs text-fg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            }),
            React.createElement(
              "div",
              { className: "flex flex-wrap items-center justify-between gap-3" },
              React.createElement(
                "p",
                { className: "max-w-2xl text-xs text-fg-muted" },
                "Saving validates the canonical RuleSync command, regenerates and applies the Codex prompt projection, and may require restarting Codex to load changed prompt files."
              ),
              React.createElement(
                "button",
                {
                  type: "submit",
                  className:
                    "rounded border border-accent/60 bg-accent/15 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                },
                "Save & Apply"
              )
            )
          )
        : prompt.content.length === 0
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
    prompt.kind === "command"
      ? React.createElement(
          "p",
          { className: "text-xs text-fg-muted" },
          "Version history is tracked by Git; compare canonical commits in the repository."
        )
      : React.createElement(
          "p",
          { className: "text-xs text-fg-muted" },
          "Role prompt edits remain read-only until their configuration owner has a lossless validated apply flow."
        )
  );
}
