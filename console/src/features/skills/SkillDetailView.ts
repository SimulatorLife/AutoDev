import type { ControlApiSkillContentResponse } from "@simulatorlife/autodev-core";
import React from "react";

import { CodeEditor } from "../../components/code/CodeBlock.ts";
import { Button } from "../../components/forms/Button.ts";
import {
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { MONO_META_CLASS } from "../../components/ui/text-classes.ts";

export type SkillContentSaveOutcome =
  "conflict" | "validation" | "apply-failed" | "failed";

export function skillContentSaveOutcome(
  value: string | readonly string[] | undefined
): SkillContentSaveOutcome | undefined {
  const outcome = typeof value === "string" ? value : value?.[0];
  return outcome === "conflict" ||
    outcome === "validation" ||
    outcome === "apply-failed" ||
    outcome === "failed"
    ? outcome
    : undefined;
}

export interface SkillDetailViewProps {
  readonly source: ControlApiSkillContentResponse;
  readonly saveOutcome?: SkillContentSaveOutcome | undefined;
}

function saveNotice(
  outcome: SkillContentSaveOutcome | undefined
): React.ReactNode {
  if (outcome === undefined) return null;
  const warning = outcome === "conflict" || outcome === "validation";
  const message = {
    conflict:
      "This skill changed after the editor loaded it. The current canonical source is shown; review it before saving again.",
    validation:
      "RuleSync refused the submitted source. The canonical file was not changed; review its frontmatter and try again.",
    "apply-failed":
      "Canonical source was updated, but RuleSync projection generation or verification failed. The current source is shown; do not assume its projections are applied.",
    failed:
      "The save and projection result could not be confirmed. Reload the current canonical source before retrying."
  }[outcome];

  return React.createElement(
    "p",
    {
      className: warning ? CALLOUT_WARNING_CLASS : CALLOUT_ERROR_CLASS,
      role: warning ? "status" : "alert",
      "data-skill-content-save": outcome
    },
    message
  );
}

export function SkillDetailView({
  source,
  saveOutcome
}: SkillDetailViewProps): React.JSX.Element {
  return React.createElement(
    PageBody,
    {
      feature: "skills",
      attributes: {
        "data-skill-content": source.name,
        "data-skill-revision": source.revision
      }
    },
    React.createElement(Breadcrumbs, {
      items: [{ label: "Skills", href: "/skills" }, { label: source.name }]
    }),
    React.createElement(EntityTitle, { mono: true }, source.name),
    React.createElement(
      "p",
      { className: `${MONO_META_CLASS} -mt-2` },
      source.path
    ),
    saveNotice(saveOutcome),
    React.createElement(
      "section",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Canonical RuleSync source"
      ),
      React.createElement(
        "form",
        {
          method: "POST",
          action: `/api/skills/${encodeURIComponent(source.name)}/content`,
          className: "flex flex-col gap-3",
          "aria-label": `Edit canonical skill ${source.name}`
        },
        React.createElement("input", {
          type: "hidden",
          name: "expectedRevision",
          value: source.revision
        }),
        React.createElement(
          "label",
          {
            htmlFor: "skill-content",
            className: "text-sm font-medium text-fg"
          },
          "Complete SKILL.md source"
        ),
        React.createElement(CodeEditor, {
          id: "skill-content",
          name: "content",
          defaultValue: source.content,
          ariaLabel: `Complete SKILL.md source for ${source.name}`,
          dataAttributes: { "data-skill-content-editor": "true" }
        }),
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center justify-between gap-3" },
          React.createElement(
            "p",
            { className: "max-w-2xl text-xs text-fg-muted" },
            "Save & Apply validates the existing skill source, writes it only if this revision is current, then regenerates and checks the configured RuleSync skill projections. Role assignments remain a separate setting."
          ),
          React.createElement(
            Button,
            {
              type: "submit",
              variant: "primary",
              testId: "skill-content-save"
            },
            "Save & Apply"
          )
        )
      )
    )
  );
}
