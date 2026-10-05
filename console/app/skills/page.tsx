import React from "react";

import { SkillsView } from "../../src/features/skills/SkillsView.ts";
import {
  controlApiFailureCode,
  fetchSkills,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import { skillsFromControlApi } from "../../src/lib/server/views.ts";
import { ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

export default async function SkillsPage(): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  if (!config) {
    return React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read skill configuration."
    });
  }
  const result = await fetchSkills(config);
  if (result.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: "Skills could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    });
  }
  const skills = skillsFromControlApi(result.data);
  return React.createElement(SkillsView, { skills });
}
