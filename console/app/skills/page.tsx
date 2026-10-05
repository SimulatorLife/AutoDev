import React from "react";

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

export default async function SkillsPage(): Promise<React.JSX.Element> {
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
  return React.createElement(
    ConsolePageShell,
    { section, counts: { Skills: skills.length } },
    React.createElement(SkillsView, {
      skills,
      eligibility,
      unresolvedAssignments,
      sourceValidity: result.data.valid
    })
  );
}
