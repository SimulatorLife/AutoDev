import type {
  ControlApiValidationIssue,
  HookDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { CALLOUT_ERROR_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  MONO_META_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

export interface HooksViewProps {
  readonly hooks: readonly HookDefinition[];
  readonly sourceValidity?: boolean | null | undefined;
  /**
   * Why the source is invalid.
   *
   * Required rather than defaulted to `[]`: a caller that has the validity flag
   * but not the reasons can only render "invalid", which is the state this
   * section exists to replace. The Runtime has already located the fault.
   */
  readonly validationIssues: readonly ControlApiValidationIssue[];
}

/**
 * The specific faults the Runtime located in the canonical hook source.
 *
 * The location is rendered in monospace and separately from the sentence
 * because they answer different questions: an operator needs to know *where* to
 * look before they can act on *what* is wrong, and running them together in one
 * monospace string makes the position hard to find in a long sentence.
 */
function HookValidationIssues({
  issues
}: {
  readonly issues: readonly ControlApiValidationIssue[];
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: `${CALLOUT_ERROR_CLASS} flex flex-col gap-2`,
      role: "alert",
      "data-testid": "hook-validation-issues",
      "data-hook-issue-count": issues.length
    },
    React.createElement(
      "h2",
      { className: "text-sm font-semibold" },
      `Hook source invalid — ${issues.length} problem${issues.length === 1 ? "" : "s"}`
    ),
    React.createElement(
      "ul",
      { className: "flex flex-col gap-1" },
      issues.map((issue, index) =>
        React.createElement(
          "li",
          {
            key: `${issue.location}:${index}`,
            className: "text-sm flex flex-wrap items-baseline gap-x-2",
            "data-hook-issue": issue.location
          },
          React.createElement("span", { className: MONO_META_CLASS }, issue.location),
          React.createElement("span", null, issue.message)
        )
      )
    )
  );
}

export function HooksView({
  hooks,
  validationIssues,
  sourceValidity = null
}: HooksViewProps): React.JSX.Element {
  const totalActions = hooks.reduce((acc, h) => acc + h.actions.length, 0);
  const validityLabel =
    sourceValidity === null
      ? NOT_OBSERVED_LABEL
      : sourceValidity
        ? "Valid"
        : "Invalid";

  return React.createElement(
    PageBody,
    { feature: "hooks" },
    React.createElement(
      StatGrid,
      { columns: 3 },
      React.createElement(StatCard, {
        title: "Hook Events",
        value: hooks.length
      }),
      React.createElement(StatCard, {
        title: "Total Handlers",
        value: totalActions
      }),
      React.createElement(StatCard, {
        title: "Source validation",
        value: validityLabel,
        subtitle: ".rulesync/hooks.jsonc"
      })
    ),
    // Only when there is something to report. A valid or unobserved source has
    // no reasons, and rendering an empty panel next to a green stat card would
    // add a section that says nothing.
    validationIssues.length === 0
      ? null
      : React.createElement(HookValidationIssues, {
          issues: validationIssues
        }),
    React.createElement(
      "div",
      { className: "flex flex-col gap-4" },
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Configured Lifecycle Hooks"
      ),
      hooks.length === 0
        ? React.createElement(
            "p",
            {
              className: `${LIST_PANEL_CLASS} text-sm text-fg-muted`,
              "data-hook-state":
                sourceValidity === null
                  ? "not-observed"
                  : sourceValidity
                    ? "empty"
                    : "invalid"
            },
            sourceValidity === null
              ? "Hook source not observed."
              : sourceValidity
                ? "No hook actions configured."
                : `Hook source is invalid; actions are not shown. ${validationIssues.length} problem${validationIssues.length === 1 ? "" : "s"} found.`
          )
        : hooks.map((h) =>
            React.createElement(
              "div",
              {
                key: h.event,
                className:
                  "bg-surface border border-border rounded-lg p-5 flex flex-col gap-3 shadow"
              },
              React.createElement(
                "div",
                {
                  className:
                    "flex items-center justify-between border-b border-border pb-2"
                },
                React.createElement(
                  "span",
                  {
                    className: "font-mono font-semibold text-fg text-sm"
                  },
                  h.event
                )
              ),
              React.createElement(
                "div",
                { className: "flex flex-col gap-2" },
                h.actions.map((act, index) =>
                  React.createElement(
                    "div",
                    {
                      key: index,
                      className:
                        "bg-background p-3 rounded border border-border/80 flex flex-col gap-1 text-xs font-mono"
                    },
                    React.createElement(
                      "div",
                      {
                        className:
                          "flex items-center justify-between text-fg-muted"
                      },
                      React.createElement(
                        "span",
                        null,
                        "Matcher: ",
                        React.createElement(
                          "span",
                          { className: "text-warning" },
                          act.matcher ?? ".*"
                        )
                      ),
                      act.statusMessage
                        ? React.createElement(
                            "span",
                            // Not an empty state: this is an observed status
                            // message. Italic is the shared signal for
                            // "nothing here", so it is dropped, and the line
                            // had silently lost the `text-xs` that every other
                            // muted note on the page carries.
                            { className: MUTED_META_CLASS },
                            act.statusMessage
                          )
                        : null
                    ),
                    React.createElement(
                      "div",
                      { className: "text-fg" },
                      React.createElement(
                        "span",
                        { className: MUTED_TEXT_CLASS },
                        "$ "
                      ),
                      act.command
                    )
                  )
                )
              )
            )
          )
    )
  );
}
