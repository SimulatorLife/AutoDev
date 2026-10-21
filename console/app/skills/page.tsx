import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import type { Metadata } from "next";
import React from "react";

import { skillSaveOutcome } from "../../src/features/skills/SkillRoleAssignment.ts";
import { SkillsView } from "../../src/features/skills/SkillsView.ts";
import {
  controlApiFailureCode,
  fetchSkills
} from "../../src/lib/server/control-api.ts";
import {
  skillEligibilityFromControlApi,
  skillsFromControlApi,
  unresolvedSkillAssignmentsFromControlApi
} from "../../src/lib/server/views.ts";
import {
  ConsolePageShell,
  ConsolePendingPage,
  controlApiCredentialUnavailable,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Skills"
};

export default async function SkillsPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const { section, config } = readNodeContext("/skills");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      controlApiCredentialUnavailable("skill configuration")
    );
  }
  const query = (await searchParams) ?? {};
  // The read starts here and is not awaited: the page's own boundary keeps
  // the pending shell on screen while the Runtime is asked for its answer.
  const skills = fetchSkills(config);
  return React.createElement(
    ConsolePendingPage,
    null,
    React.createElement(SkillsContent, { section, skills, save: query.save })
  );
}

/**
 * The skills the Runtime confirmed, or the reason it could not answer.
 *
 * The read is awaited here, below the page's own pending boundary, so the
 * pending shell is already on screen while it is on its way.
 */
async function SkillsContent({
  section,
  skills: skillsPromise,
  save
}: {
  readonly section: CanonicalNavSection;
  readonly skills: Promise<Awaited<ReturnType<typeof fetchSkills>>>;
  readonly save: string | readonly string[] | undefined;
}): Promise<React.JSX.Element> {
  const result = await skillsPromise;
  if (result.kind !== "ok") {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Skills could not be loaded",
        code: controlApiFailureCode(result),
        message: result.message
      })
    );
  }
  const skills = skillsFromControlApi(result.data);
  const eligibility = skillEligibilityFromControlApi(result.data);
  const unresolvedAssignments = unresolvedSkillAssignmentsFromControlApi(
    result.data
  );
  const saveOutcome = skillSaveOutcome(save);
  return React.createElement(
    ConsolePageShell,
    {
      section,
      description:
        "Canonical RuleSync skill definitions, role assignments, and target projections.",
      counts: { Skills: skills.length }
    },
    React.createElement(SkillsView, {
      skills,
      eligibility,
      unresolvedAssignments,
      sourceValidity: result.data.valid,
      validationIssues: result.data.issues,
      // Drawn from the same catalog read rather than from a route of its own:
      // the revision and the assignable roles are properties of the execution
      // contract this response already carries, and re-reading the catalog to
      // show the same page twice would be two reads of one fact.
      assignmentRoles: result.data.assignmentRoles,
      executionContractRevision: result.data.executionContractRevision,
      ...(saveOutcome ? { saveOutcome } : {})
    })
  );
}
