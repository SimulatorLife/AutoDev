import type {
  ControlApiSkillContentResponse,
  ScopedSkillDefinition
} from "@simulatorlife/autodev-core";
import React from "react";

import { parseRuleSyncFrontmatter } from "@simulatorlife/autodev-data";
import { SourceView } from "../../components/code/SourceView.ts";
import { PromptMarkdown } from "../prompts/prompt-markdown.ts";
import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { ReconciliationPanel } from "../../components/status/ConvergenceBadge.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  MONO_META_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  NOT_INSTALLED_LABEL,
  SKILL_SCOPE_LABEL,
  skillScopePlace
} from "./skill-scope.ts";

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
  /**
   * Where the skill is installed, read from the catalogue.
   *
   * `null` when the catalogue could not be read: a scope that was not observed
   * is not the same as a skill that is installed nowhere, and this page says
   * which one it is looking at.
   */
  readonly scopedSkill?: ScopedSkillDefinition | null | undefined;
  /**
   * The revision the editor's content is based on.
   *
   * A browser restores the text an operator typed into a form control when the
   * write it submitted is redirected back to the page, so after a refused
   * write the editor still holds the edit while the source has moved on. The
   * write carries this revision, which keeps a second save from pairing that
   * stale edit with the revision the source has moved to.
   */
  readonly editorRevision?: string | undefined;
}

/**
 * Where the skill is installed, as the page says it.
 *
 * Three different facts end here: the catalogue could not be read, the skill
 * is installed nowhere, and the skill is installed in one of the places Codex
 * looks for one. Only the first is missing evidence; the second is an
 * observed absence, and the page says so rather than leaving the field empty.
 */
function skillInstallation(scopedSkill: ScopedSkillDefinition | null): {
  readonly scope: string;
  readonly place: { readonly label: string; readonly value: string } | null;
  readonly note: string | null;
} {
  if (scopedSkill === null) {
    return {
      scope: NOT_OBSERVED_LABEL,
      place: null,
      note: "The skill catalogue could not be read, so where this skill is installed was not observed."
    };
  }
  if (scopedSkill.scope === null) {
    return {
      scope: NOT_INSTALLED_LABEL,
      place: null,
      note: "This skill is in the catalog but installed nowhere on this machine, so no agent role can invoke it."
    };
  }
  return {
    scope: SKILL_SCOPE_LABEL[scopedSkill.scope],
    place: {
      label: scopedSkill.scope === "repo" ? "Workspace" : "Location",
      value: skillScopePlace(scopedSkill) ?? ""
    },
    note: null
  };
}

export function SkillDetailView({
  source,
  scopedSkill = null
}: SkillDetailViewProps): React.JSX.Element {
  const installation = skillInstallation(scopedSkill);
  const parsed = parseRuleSyncFrontmatter(source.content);
  return React.createElement(
    PageBody,
    {
      feature: "skills",
      attributes: {
        "data-skill-content": source.name,
        "data-skill-revision": source.revision,
        "data-skill-scope": scopedSkill?.scope ?? "not-observed"
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
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Reconciliation state",
        "data-section": "skill-reconciliation"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Reconciliation"
      ),
      React.createElement(ReconciliationPanel, {
        status: source.reconciliation.status,
        history: source.reconciliation.history
      })
    ),
    React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Installation",
        "data-section": "skill-installation"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Installation"
      ),
      React.createElement(
        DetailGrid,
        { columns: 2 },
        React.createElement(
          DetailValue,
          { label: "Scope" },
          installation.scope
        ),
        installation.place === null
          ? null
          : React.createElement(
              DetailValue,
              { label: installation.place.label },
              installation.place.value
            )
      ),
      installation.note === null
        ? null
        : React.createElement(
            "p",
            { className: `${MUTED_META_CLASS} mt-3` },
            installation.note
          )
    ),
    React.createElement(
      "section",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Canonical RuleSync source"
      ),
      React.createElement(SourceView, {
        source: source.content,
        format: "Source",
        rendered: parsed.kind === "valid"
          ? React.createElement(PromptMarkdown, { body: parsed.body })
          : React.createElement("p", { className: MUTED_META_CLASS, role: "status" }, "Skill frontmatter could not be read. Inspect the source.")
      })
    )
  );
}
