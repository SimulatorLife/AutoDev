import type { RuleSyncValidationIssue } from "@simulatorlife/autodev-core";
import React from "react";

import { CALLOUT_ERROR_CLASS } from "../layout/Callout.ts";
import { MONO_META_CLASS } from "../ui/text-classes.ts";

export interface SourceValidationIssuesProps {
  readonly issues: readonly RuleSyncValidationIssue[];
  /** Names the panel for its own page, so two on one screen stay distinguishable. */
  readonly testId: string;
  /** What failed, in the operator's words: "Hook source", "MCP source". */
  readonly subject: string;
}

/**
 * The specific faults a canonical source loader located.
 *
 * One component for every RuleSync source because the shape is the same and the
 * alternative was two views rendering faults differently, which is how a shared
 * rule becomes a shared *idea* only on paper. The subject is passed in rather
 * than inferred from the loader, since the two consumers read different files.
 *
 * `location` is monospace and separate from `message` because they answer
 * different questions: an operator needs to know *where* to look before they can
 * act on *what* is wrong, and running them together in one monospace string puts
 * the position last, behind the sentence.
 *
 * Rendered only when there is at least one issue. A valid or unobserved source
 * has none, and an empty panel beside a green stat card adds nothing.
 */
export function SourceValidationIssues({
  issues,
  testId,
  subject
}: SourceValidationIssuesProps): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return React.createElement(
    "div",
    {
      className: `${CALLOUT_ERROR_CLASS} flex flex-col gap-2`,
      role: "alert",
      "data-testid": testId,
      "data-validation-issue-count": issues.length
    },
    React.createElement(
      "h2",
      { className: "text-sm font-semibold" },
      `${subject} invalid — ${issues.length} problem${issues.length === 1 ? "" : "s"}`
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
            "data-validation-issue": issue.location
          },
          React.createElement(
            "span",
            { className: MONO_META_CLASS },
            issue.location
          ),
          React.createElement("span", null, issue.message)
        )
      )
    )
  );
}
