import type {
  ControlApiPromptDetailResponse,
  ControlApiPromptVersionResponse,
  PromptDocument
} from "@simulatorlife/autodev-core";
import React from "react";

import { CodeBlock } from "../../components/code/CodeBlock.ts";
import { SourceView } from "../../components/code/SourceView.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  DETAIL_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { gridRowClass } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";
import {
  ACTION_LINK_CLASS,
  MONO_META_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import type { PromptHistoryState } from "./history-state.ts";
import { PromptMarkdown } from "./prompt-markdown.ts";

export interface PromptDetailViewProps {
  readonly prompt: PromptDocument;
  /**
  Desired-vs-actual state the Runtime derived for this resource. The detail
  payload always carries it (the v4 contract requires it); it is surfaced here
  to distinguish the current source from its observed projection.
  */
  readonly reconciliation: ControlApiPromptDetailResponse["reconciliation"];
  readonly history: PromptHistoryState;
  readonly selectedVersion?: ControlApiPromptVersionResponse | undefined;
  readonly versionSelectionError?: string | undefined;
}

/**
The ends of the committed history, as links into the same page.

The history is one ordered list of committed revisions, and a page of it is
a window: the operator who needs an older revision walks back a page at a
time instead of being told to go and read Git. The page it names is in the
URL, so the walk is addressable and a reload keeps the operator where they
were.
*/
function renderPromptHistoryPages(
  promptUrl: string,
  history: Extract<PromptHistoryState, { readonly status: "available" }>
): React.ReactNode {
  const newerOffset = history.offset - history.limit;
  return React.createElement(
    "nav",
    {
      "aria-label": "Prompt version history pages",
      className: "mb-4 flex flex-wrap items-center justify-between gap-3",
      "data-feature": "prompt-history-pager",
      "data-prompt-history-offset": String(history.offset),
      "data-prompt-history-limit": String(history.limit)
    },
    React.createElement(
      "p",
      {
        className: MUTED_META_CLASS,
        "data-prompt-history-range": "true"
      },
      history.offset === 0
        ? `Showing the newest ${history.versions.length} committed versions.`
        : `Showing versions ${history.offset + 1}-${history.offset + history.versions.length} of the committed history.`
    ),
    React.createElement(
      "div",
      { className: "flex items-center gap-2" },
      history.offset > 0
        ? React.createElement(
            NavigationLink,
            {
              href:
                newerOffset > 0
                  ? `${promptUrl}?historyOffset=${newerOffset}`
                  : promptUrl,
              className: "text-xs font-medium",
              dataAttributes: { "data-prompt-history-newer": "true" }
            },
            "Show newer versions"
          )
        : null,
      history.hasMore
        ? React.createElement(
            NavigationLink,
            {
              href: `${promptUrl}?historyOffset=${history.offset + history.limit}`,
              className: "text-xs font-medium",
              dataAttributes: { "data-prompt-history-older": "true" }
            },
            "Show older versions"
          )
        : null
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
            NavigationLink,
            {
              href: promptUrl,
              className: `text-xs font-medium ${ACTION_LINK_CLASS}`
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
            { className: MUTED_BODY_CLASS, role: "status" },
            "No committed versions are available; the current working tree remains the source of truth."
          )
        : React.createElement(
            "ol",
            {
              className: "mb-4 flex flex-col gap-2",
              "aria-label": "Recent committed versions"
            },
            ...history.versions.map((version) => {
              const isSelected =
                selectedVersion?.versionHash === version.versionHash;
              // The revision is opened together with the page it was found on,
              // so a reload shows the operator the list they chose it from.
              const revisionQuery = new URLSearchParams({
                revision: version.versionHash
              });
              if (history.offset > 0) {
                revisionQuery.set("historyOffset", String(history.offset));
              }
              return React.createElement(
                "li",
                {
                  key: version.versionHash,
                  className: "flex flex-wrap items-center gap-2"
                },
                React.createElement(InstantDisplay, {
                  value: version.updatedAt,
                  label: "Prompt version updated"
                }),
                React.createElement(
                  NavigationLink,
                  {
                    href: `${promptUrl}?${revisionQuery.toString()}`,
                    ...(isSelected && { "aria-current": "page" as const }),
                    className:
                      "flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-xs hover:bg-hover ",
                    dataAttributes: {
                      "data-prompt-version": version.versionHash
                    }
                  },
                  React.createElement(
                    "span",
                    { className: `font-mono ${MUTED_TEXT_CLASS}` },
                    version.versionHash.slice(0, 12)
                  ),
                  isSelected
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
    history.status === "available" && (history.offset > 0 || history.hasMore)
      ? renderPromptHistoryPages(promptUrl, history)
      : null,
    versionSelectionError
      ? React.createElement(
          "p",
          {
            // Quoted as a string rather than interpolated, so this rendered
            // `class="${CALLOUT_WARNING_CLASS} mb-4"` -- the literal source
            // text -- while line 91 uses the same constant correctly. The error
            // element below it has always been toned; this one was not.
            className: `${CALLOUT_WARNING_CLASS} mb-4`,
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
            React.createElement(
              React.Fragment,
              null,
              `Changes since ${selectedVersion.versionHash.slice(0, 12)} (`,
              React.createElement(InstantDisplay, {
                value: selectedVersion.updatedAt,
                label: "Selected prompt version updated"
              }),
              ")"
            )
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
                  className: MUTED_BODY_CLASS,
                  "data-prompt-diff": "unchanged"
                },
                "The selected committed version matches the current working tree."
              ),
          React.createElement(
            "details",
            { className: NESTED_PANEL_CLASS },
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
  return React.createElement("p", { className: MUTED_META_CLASS }, message);
}

export function PromptDetailView({
  prompt,
  reconciliation,
  history,
  selectedVersion,
  versionSelectionError
}: PromptDetailViewProps): React.JSX.Element {
  const lineCount = prompt.content ? prompt.content.split("\n").length : 0;
  const characterCount = prompt.content ? prompt.content.length : 0;
  const isRole = prompt.kind === "role" || prompt.path.includes("roles");

  return React.createElement(
    PageBody,
    { feature: "prompt-detail", as: "article" },
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
          { className: `mt-2 ${MONO_META_CLASS}` },
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
          { className: MONO_META_CLASS },
          `${lineCount} lines | ${characterCount} chars | rev ${prompt.revision.slice(0, 12)}`
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: gridRowClass(3, "gap-4"),
        "aria-label": "Prompt metadata and linkage",
        "data-section": "prompt-linkage"
      },
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
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
          { className: `mt-2 ${MUTED_META_CLASS}` },
          "Canonical source lives in the working tree; Git commits provide version history."
        )
      ),
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Related Agent"
        ),
        isRole
          ? React.createElement(
              NavigationLink,
              {
                href: `/agents/${encodeURIComponent(prompt.name)}`,
                className: `text-xs font-semibold ${ACTION_LINK_CLASS} block mb-1`
              },
              `Agent: ${prompt.name} →`
            )
          : React.createElement(
              "span",
              { className: `block mb-1 ${MUTED_META_CLASS}` },
              "RuleSync command (all roles)"
            ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          isRole
            ? "Inspect execution contract, model routes, and tool permissions for this role."
            : "Commands are exposed across configured agent roles."
        )
      ),
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Observability Linkage"
        ),
        React.createElement(
          "div",
          // `gap-3`, not `gap-1`. WCAG 2.5.8 asks for a 24px target, with an
          // exception for undersized targets whose 24px circles do not intersect
          // another target's. These two links are the cell's whole content and
          // are both 16px tall, so the exception is the only thing standing
          // between them and the floor -- and at `gap-1` their centres were
          // 20px apart, which fails it. `gap-2` lands exactly on 24, where the
          // circles merely touch and any line-height rounding turns a pass into
          // a fail, so the row takes `gap-3` and clears it at 28px.
          { className: "flex flex-col gap-3 text-xs" },
          React.createElement(
            NavigationLink,
            {
              href: `/evaluations?prompt=${encodeURIComponent(prompt.name)}`,
              className: ACTION_LINK_CLASS
            },
            "Evaluations results →"
          ),
          React.createElement(
            NavigationLink,
            {
              href: `/usage?role=${encodeURIComponent(prompt.name)}`,
              className: ACTION_LINK_CLASS
            },
            "Token & request usage →"
          )
        )
      )
    ),
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
        "aria-label": "Canonical prompt source",
        "data-prompt-source": "read-only"
      },
      React.createElement(
        "div",
        { className: "mb-3 flex flex-wrap items-center justify-between gap-3" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Canonical Markdown Source"
        ),
        React.createElement(
          "span",
          {
            className: `truncate ${MONO_META_CLASS}`,
            // The path is what an operator copies to open the file, so an
            // ellipsized version of it is the one truncation that costs real
            // work rather than a glance.
            title: prompt.path
          },
          prompt.path
        )
      ),
      React.createElement(SourceView, {
        source: prompt.content,
        format: "Source",
        rendered:
          prompt.preview.length > 0
            ? React.createElement(PromptMarkdown, { body: prompt.preview })
            : React.createElement(
                "p",
                { className: MUTED_BODY_CLASS },
                "The canonical Markdown body is empty."
              )
      })
    ),
    renderPromptHistory(
      prompt,
      history,
      selectedVersion,
      versionSelectionError
    ),
    renderPromptFooter(prompt)
  );
}
