import type {
  ControlApiPromptDetailResponse,
  ControlApiPromptVersionReference,
  ControlApiPromptVersionResponse,
  PromptDocument
} from "@simulatorlife/autodev-core";
import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import {
  CODE_SNIPPET_CLASS,
  CodeBlock,
  CodeEditor
} from "../../components/code/CodeBlock.ts";
import { Button } from "../../components/forms/Button.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { TAG_SHAPE } from "../../components/status/Tag.ts";

const PROMPT_CARD_CLASS_NAME = "rounded-lg border border-border bg-surface p-4";

export type PromptSaveOutcome =
  "conflict" | "validation" | "apply-failed" | "failed";

export type PromptHistoryState =
  | {
      readonly status: "available";
      readonly versions: readonly ControlApiPromptVersionReference[];
      readonly hasMore: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

export interface PromptDetailViewProps {
  readonly prompt: PromptDocument;
  /**
   * Desired-vs-actual state the Runtime derived for this resource. The detail
   * payload always carries it (the v4 contract requires it); it is surfaced here
   * because an operator editing canonical source needs to see whether the
   * projection has actually caught up, not just whether the save returned.
   */
  readonly reconciliation: ControlApiPromptDetailResponse["reconciliation"];
  readonly history: PromptHistoryState;
  readonly selectedVersion?: ControlApiPromptVersionResponse | undefined;
  readonly versionSelectionError?: string | undefined;
  readonly saveOutcome?: PromptSaveOutcome | undefined;
}

function saveOutcomeMessage(outcome: PromptSaveOutcome): string {
  switch (outcome) {
    case "conflict": {
      return "This command changed after you loaded it. The current canonical source is shown; review it before saving again.";
    }
    case "validation": {
      return "The canonical command was not updated because its source is invalid. Review the frontmatter and try again.";
    }
    case "apply-failed": {
      return "The canonical source was saved, but RuleSync generation or projection apply failed. The editor shows the current source; verify it before retrying.";
    }
    case "failed": {
      return "The save and apply result could not be confirmed. Reload the canonical source before retrying.";
    }
  }
  return "The save and apply result could not be confirmed.";
}

function renderSaveOutcome(
  outcome: PromptSaveOutcome | undefined
): React.ReactNode {
  if (!outcome) return null;
  const className =
    outcome === "conflict" || outcome === "validation"
      ? CALLOUT_WARNING_CLASS
      : CALLOUT_ERROR_CLASS;
  return React.createElement(
    "p",
    { className, role: "alert", "data-prompt-save-outcome": outcome },
    saveOutcomeMessage(outcome)
  );
}

function renderPromptSource(prompt: PromptDocument): React.ReactNode {
  if (prompt.kind === "command") {
    return React.createElement(
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
      React.createElement(
        "label",
        { htmlFor: "prompt-content", className: "sr-only" },
        "Canonical Markdown source"
      ),
      React.createElement(CodeEditor, {
        id: "prompt-content",
        name: "content",
        defaultValue: prompt.content,
        ariaLabel: "Canonical Markdown source",
        dataAttributes: {
          "data-prompt-content":
            prompt.content.length === 0 ? "empty" : "observed"
        }
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
          Button,
          {
            type: "submit",
            variant: "primary",
            testId: "prompt-save"
          },
          "Save & Apply"
        )
      )
    );
  }

  if (prompt.content.length === 0) {
    return React.createElement(
      "p",
      {
        className: "text-sm text-fg-muted",
        "data-prompt-content": "empty"
      },
      "The canonical source file is empty."
    );
  }

  return React.createElement(CodeBlock, {
    content: prompt.content,
    height: "primary",
    dataAttributes: { "data-prompt-content": "observed" }
  });
}

/**
 * Renderer for the prompt author's own Markdown, shown as a preview inside the
 * page.
 *
 * The prompt body is content *within* this page, not a page of its own, so its
 * headings are demoted three levels past the Console's own body sections. A
 * prompt that opens with an `# H1` used to inject a second page-level heading
 * halfway down the outline — below Console sections and above the shell's
 * `h1` — which is what a document outline is supposed to rule out.
 */
const PROMPT_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) =>
    React.createElement(
      "h4",
      { className: "mb-3 text-xl font-semibold text-fg" },
      children
    ),
  h2: ({ children }) =>
    React.createElement(
      "h5",
      { className: "mb-2 mt-4 text-lg font-semibold text-fg" },
      children
    ),
  h3: ({ children }) =>
    React.createElement(
      "h6",
      { className: "mb-2 mt-3 text-base font-semibold text-fg" },
      children
    ),
  p: ({ children }) =>
    React.createElement(
      "p",
      { className: "mb-3 text-sm text-fg-secondary" },
      children
    ),
  ul: ({ children }) =>
    React.createElement(
      "ul",
      { className: "mb-3 list-disc space-y-1 pl-6 text-sm text-fg-secondary" },
      children
    ),
  ol: ({ children }) =>
    React.createElement(
      "ol",
      {
        className: "mb-3 list-decimal space-y-1 pl-6 text-sm text-fg-secondary"
      },
      children
    ),
  li: ({ children }) => React.createElement("li", null, children),
  blockquote: ({ children }) =>
    React.createElement(
      "blockquote",
      {
        className:
          "mb-3 border-l-2 border-border-strong pl-4 text-sm text-fg-muted"
      },
      children
    ),
  pre: ({ children }) =>
    React.createElement(
      "pre",
      { className: `${CODE_SNIPPET_CLASS} mb-3` },
      children
    ),
  code: ({ children }) =>
    React.createElement(
      "code",
      {
        className: `${TAG_SHAPE} border-transparent bg-input font-mono text-fg-secondary`
      },
      children
    ),
  a: ({ href, children }) =>
    React.createElement(
      "a",
      {
        href,
        target: "_blank",
        rel: "noreferrer",
        className: "text-accent underline underline-offset-2"
      },
      children
    ),
  hr: () => React.createElement("hr", { className: "my-4 border-border" })
};

function renderPromptPreview(prompt: PromptDocument): React.ReactNode {
  return React.createElement(
    "details",
    {
      className: PROMPT_CARD_CLASS_NAME,
      "data-prompt-preview": "markdown"
    },
    React.createElement(
      "summary",
      {
        className:
          "cursor-pointer text-xs font-semibold uppercase tracking-wider text-fg-muted"
      },
      "Preview rendered Markdown"
    ),
    prompt.preview.length > 0
      ? React.createElement(
          "div",
          { className: "mt-4", "data-prompt-preview-body": "observed" },
          React.createElement(ReactMarkdown, {
            components: PROMPT_MARKDOWN_COMPONENTS,
            children: prompt.preview
          })
        )
      : React.createElement(
          "p",
          {
            className: "mt-4 text-sm text-fg-muted",
            "data-prompt-preview-body": "empty"
          },
          "The canonical Markdown body is empty."
        )
  );
}

function renderPromptHistory(
  prompt: PromptDocument,
  history: PromptHistoryState,
  selectedVersion: ControlApiPromptVersionResponse | undefined,
  versionSelectionError: string | undefined
): React.ReactNode {
  if (prompt.kind !== "command") return null;

  const promptUrl = `/prompts/${encodeURIComponent(prompt.name)}`;
  return React.createElement(
    "section",
    {
      className: DETAIL_PANEL_CLASS,
      "aria-label": "Prompt version history",
      "data-prompt-history": history.status
    },
    React.createElement(
      "div",
      { className: "mb-4 flex flex-wrap items-start justify-between gap-3" },
      React.createElement(
        "div",
        null,
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Git Version History"
        ),
        React.createElement(
          "p",
          { className: "mt-1 text-xs text-fg-secondary" },
          "Committed RuleSync revisions compared with the current working-tree source."
        )
      ),
      selectedVersion
        ? React.createElement(
            "a",
            {
              href: promptUrl,
              className: "text-xs font-medium text-accent hover:underline "
            },
            "Return to current source"
          )
        : null
    ),
    history.status === "unavailable"
      ? React.createElement(
          "p",
          {
            className: "text-sm text-warning",
            role: "status",
            "data-prompt-history-unavailable": "true"
          },
          history.message
        )
      : history.versions.length === 0
        ? React.createElement(
            "p",
            { className: "text-sm text-fg-muted", role: "status" },
            "No committed versions are available; the current working tree remains the source of truth."
          )
        : React.createElement(
            "ol",
            {
              className: "mb-4 flex flex-col gap-2",
              "aria-label": "Recent committed versions"
            },
            ...history.versions.map((version) => {
              const selected =
                selectedVersion?.versionHash === version.versionHash;
              return React.createElement(
                "li",
                { key: version.versionHash },
                React.createElement(
                  "a",
                  {
                    href: `${promptUrl}?revision=${encodeURIComponent(version.versionHash)}`,
                    ...(selected ? { "aria-current": "page" as const } : {}),
                    className:
                      "flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-xs hover:bg-hover ",
                    "data-prompt-version": version.versionHash
                  },
                  React.createElement(
                    "time",
                    {
                      dateTime: version.updatedAt,
                      className: "text-fg-secondary"
                    },
                    version.updatedAt
                  ),
                  React.createElement(
                    "span",
                    { className: "font-mono text-fg-muted" },
                    version.versionHash.slice(0, 12)
                  ),
                  selected
                    ? React.createElement(
                        "span",
                        { className: "text-accent" },
                        "Selected"
                      )
                    : null
                )
              );
            })
          ),
    history.status === "available" && history.hasMore
      ? React.createElement(
          "p",
          {
            className: "mb-4 text-xs text-fg-muted",
            "data-prompt-history-truncated": "true"
          },
          "Showing the newest 20 committed versions. Older history remains available in Git."
        )
      : null,
    versionSelectionError
      ? React.createElement(
          "p",
          {
            className: "`${CALLOUT_WARNING_CLASS} mb-4`",
            role: "status",
            "data-prompt-version-error": "true"
          },
          versionSelectionError
        )
      : null,
    selectedVersion
      ? React.createElement(
          "div",
          {
            className: "flex flex-col gap-3 border-t border-border pt-4",
            "data-prompt-version-comparison": selectedVersion.versionHash
          },
          React.createElement(
            "h4",
            { className: "text-sm font-semibold text-fg" },
            `Changes since ${selectedVersion.versionHash.slice(0, 12)} (${selectedVersion.updatedAt})`
          ),
          selectedVersion.diff.length > 0
            ? React.createElement(CodeBlock, {
                content: selectedVersion.diff,
                ariaLabel:
                  "Unified diff from committed version to working tree",
                dataAttributes: { "data-prompt-diff": "observed" }
              })
            : React.createElement(
                "p",
                {
                  className: "text-sm text-fg-muted",
                  "data-prompt-diff": "unchanged"
                },
                "The selected committed version matches the current working tree."
              ),
          React.createElement(
            "details",
            { className: "rounded border border-border bg-background p-3" },
            React.createElement(
              "summary",
              {
                className:
                  "cursor-pointer text-xs font-medium text-fg-secondary"
              },
              "View committed source"
            ),
            React.createElement(CodeBlock, {
              content: selectedVersion.content,
              className: "mt-3",
              dataAttributes: { "data-prompt-version-content": "observed" }
            })
          )
        )
      : null
  );
}

function renderPromptFooter(prompt: PromptDocument): React.JSX.Element {
  const message =
    prompt.kind === "command"
      ? "Version history is tracked by Git; compare canonical commits in the repository."
      : "Role prompt edits remain read-only until their configuration owner has a lossless validated apply flow.";
  return React.createElement(
    "p",
    { className: "text-xs text-fg-muted" },
    message
  );
}

export function PromptDetailView({
  prompt,
  reconciliation,
  history,
  selectedVersion,
  versionSelectionError,
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
        className: `flex flex-wrap items-start justify-between gap-4 ${DETAIL_PANEL_CLASS}`
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
            className: ENTITY_EYEBROW_CLASS
          },
          isRole ? "Agent role prompt" : "RuleSync command"
        ),
        React.createElement(EntityTitle, { mono: true }, prompt.name),
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
        { className: PROMPT_CARD_CLASS_NAME },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
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
        { className: PROMPT_CARD_CLASS_NAME },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
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
        { className: PROMPT_CARD_CLASS_NAME },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
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
    renderSaveOutcome(saveOutcome),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Reconciliation state",
        "data-section": "prompt-reconciliation"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Reconciliation"
      ),
      React.createElement(ReconciliationPanel, {
        status: reconciliation.status,
        history: reconciliation.history
      })
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label":
          prompt.kind === "command"
            ? "Prompt source editor"
            : "Prompt source preview",
        "data-prompt-editor":
          prompt.kind === "command" ? "canonical" : "read-only"
      },
      React.createElement(
        "div",
        { className: "mb-3 flex items-center justify-between gap-3" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
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
      renderPromptSource(prompt)
    ),
    renderPromptPreview(prompt),
    renderPromptHistory(
      prompt,
      history,
      selectedVersion,
      versionSelectionError
    ),
    renderPromptFooter(prompt)
  );
}
