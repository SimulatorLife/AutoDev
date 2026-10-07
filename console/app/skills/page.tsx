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
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

export const dynamic = "force-dynamic";

export default async function SkillsPage({
  searchParams
}: {
  readonly searchParams?: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}): Promise<React.JSX.Element> {
  const query = await (searchParams ??
    Promise.resolve(
      {} as Record<string, string | readonly string[] | undefined>
    ));
  const { section, config } = readNodeContext("/skills");
  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read skill configuration."
      })
    );
  }
  const result = await fetchSkills(config);
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
  const saveOutcome = skillSaveOutcome(query.save);
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Skills: skills.length } },
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
