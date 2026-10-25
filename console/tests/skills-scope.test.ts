import assert from "node:assert/strict";
import test from "node:test";

import type { ScopedSkillDefinition } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SkillTelemetry } from "../src/features/skills/skill-telemetry.ts";
import { SkillRoleAssignmentControl } from "../src/features/skills/SkillRoleAssignmentControl.ts";
import { SkillsView } from "../src/features/skills/SkillsView.ts";
import {
  skillsFromControlApi,
  skillTelemetryFromControlApi
} from "../src/lib/server/views.ts";

/**
 * Where a skill lives is a fact about the machine, and the page has to say it.
 *
 * The catalogue holds every skill the project defines, but Codex only reaches
 * the copy that is installed somewhere it looks: the project, the operator's
 * own directory, the machine's shared directory, or the skills Codex ships
 * with. Three of the sixteen catalogue skills were installed nowhere at all,
 * and the page listed them beside live ones as though any role could invoke
 * them.
 *
 * A skill installed inside a repository belongs to that repository's workspace
 * alone, so its roles are assigned inside that workspace and the assignment
 * has to say which one.
 */

const REPO_SKILL: ScopedSkillDefinition = {
  name: "opentelemetry",
  description: "Instrument the runtime.",
  path: ".rulesync/skills/opentelemetry/SKILL.md",
  scope: "repo",
  scopeLocation: "/repo/.agents/skills/opentelemetry",
  workspace: "SimulatorLife/AutoDev"
};

const USER_SKILL: ScopedSkillDefinition = {
  name: "code-review",
  description: "Review a diff.",
  path: ".rulesync/skills/code-review/SKILL.md",
  scope: "user",
  scopeLocation: "/home/operator/.agents/skills/code-review",
  workspace: null
};

const ADMIN_SKILL: ScopedSkillDefinition = {
  name: "house-rules",
  description: "The machine's shared skills.",
  path: ".rulesync/skills/house-rules/SKILL.md",
  scope: "admin",
  scopeLocation: "/etc/codex/skills/house-rules",
  workspace: null
};

const SYSTEM_SKILL: ScopedSkillDefinition = {
  name: "skill-creator",
  description: "The skills Codex ships with.",
  path: ".rulesync/skills/skill-creator/SKILL.md",
  scope: "system",
  scopeLocation: "/home/operator/.codex/skills/.system/skill-creator",
  workspace: null
};

const UNINSTALLED_SKILL: ScopedSkillDefinition = {
  name: "playtest-analysis",
  description: "Installed nowhere.",
  path: ".rulesync/skills/playtest-analysis/SKILL.md",
  scope: null,
  scopeLocation: null,
  workspace: null
};

const NO_TELEMETRY: SkillTelemetry = { observed: false, bySkill: new Map() };

function renderSkills(
  skills: readonly ScopedSkillDefinition[],
  telemetry: SkillTelemetry = NO_TELEMETRY
): string {
  return renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills,
      eligibility: skills.map((skill) => ({
        skill: skill.name,
        roles: skill.scope === null ? [] : ["worker"]
      })),
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["worker"],
      executionContractRevision: "a".repeat(64),
      telemetry
    })
  );
}

test("the scope column names where each skill is installed", () => {
  const markup = renderSkills([
    REPO_SKILL,
    USER_SKILL,
    ADMIN_SKILL,
    SYSTEM_SKILL,
    UNINSTALLED_SKILL
  ]);
  assert.match(markup, />Repo</u);
  assert.match(markup, />User</u);
  assert.match(markup, />Admin</u);
  assert.match(markup, />System</u);
  // A skill that is in the catalogue and installed nowhere is not a live skill,
  // and the page has to say so rather than leaving the cell empty.
  assert.match(markup, /Not installed/);
  assert.match(markup, /data-skill-scope="not-installed"/);
});

test("a repo-scoped skill shows the workspace it belongs to", () => {
  const markup = renderSkills([REPO_SKILL]);
  assert.match(markup, /SimulatorLife\/AutoDev/);
  assert.match(markup, /data-skill-scope="repo"/);
  // The workspace is where the roles are assigned, so the row says so as well.
  assert.match(markup, /Roles apply inside SimulatorLife\/AutoDev\./);
});

test("a skill installed outside a repository shows the directory it was found in", () => {
  const markup = renderSkills([USER_SKILL]);
  assert.match(markup, /home\/operator\/\.agents\/skills\/code-review/);
  assert.doesNotMatch(markup, /Roles apply inside/);
});

test("the scope is a fact the Console does not offer a control for", () => {
  const markup = renderSkills([REPO_SKILL]);
  // The scope column carries no control: there is nothing an operator could
  // change about where a skill is installed.
  assert.doesNotMatch(
    markup,
    /data-skill-scope[^>]*>[^<]*<(?:button|input|select)/u
  );
  assert.match(markup, /where the skill is installed, read from this machine/i);
});

test("a skill installed nowhere cannot be invoked by anybody", () => {
  const markup = renderSkills([UNINSTALLED_SKILL]);
  assert.match(markup, /Unreachable/);
  assert.match(markup, /no agent role can invoke it/);
  // It is not a configured skill either: the count beside the row counts the
  // skills that are installed, not the entries in the catalogue.
  assert.match(markup, /Configured<\/dt>[\s\S]*?>0</u);
  assert.match(markup, /of 1 in the catalog/);
});

test("the assignment for a repo-scoped skill carries its workspace", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillRoleAssignmentControl, {
      skill: REPO_SKILL,
      roles: ["worker"],
      assignmentRoles: ["worker"],
      executionContractRevision: "a".repeat(64)
    })
  );
  assert.match(
    markup,
    /<input type="hidden" name="workspace" value="SimulatorLife\/AutoDev"/u
  );
  assert.match(
    markup,
    /data-skill-assignment-workspace="SimulatorLife\/AutoDev"/u
  );
});

test("the assignment for a skill outside a workspace carries no workspace", () => {
  const markup = renderToStaticMarkup(
    React.createElement(SkillRoleAssignmentControl, {
      skill: USER_SKILL,
      roles: ["worker"],
      assignmentRoles: ["worker"],
      executionContractRevision: "a".repeat(64)
    })
  );
  assert.doesNotMatch(markup, /name="workspace"/u);
  assert.doesNotMatch(markup, /data-skill-assignment-workspace/u);
});

test("the control API mapping carries the scope facts through", () => {
  const skills = skillsFromControlApi({
    schema: "autodev-control-skills-v2",
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
    executionContractRevision: "a".repeat(64),
    assignmentRoles: ["worker"],
    telemetryObserved: true,
    skills: [
      {
        name: "opentelemetry",
        description: "Instrument the runtime.",
        path: ".rulesync/skills/opentelemetry/SKILL.md",
        roles: ["worker"],
        scope: "repo",
        scopeLocation: "/repo/.agents/skills/opentelemetry",
        workspace: "SimulatorLife/AutoDev",
        observedExposure: 3,
        observedUse: 1
      },
      {
        name: "playtest-analysis",
        description: "Installed nowhere.",
        path: ".rulesync/skills/playtest-analysis/SKILL.md",
        roles: [],
        scope: null,
        scopeLocation: null,
        workspace: null,
        observedExposure: null,
        observedUse: null
      }
    ],
    unresolvedAssignments: [],
    issues: []
  });
  assert.deepEqual(skills[0], {
    name: "opentelemetry",
    description: "Instrument the runtime.",
    path: ".rulesync/skills/opentelemetry/SKILL.md",
    scope: "repo",
    scopeLocation: "/repo/.agents/skills/opentelemetry",
    workspace: "SimulatorLife/AutoDev"
  });
  assert.deepEqual(skills[1], {
    name: "playtest-analysis",
    description: "Installed nowhere.",
    path: ".rulesync/skills/playtest-analysis/SKILL.md",
    scope: null,
    scopeLocation: null,
    workspace: null
  });
});

test("the observed counts are reported, and an unobserved skill is not a zero", () => {
  const telemetry = {
    observed: true,
    bySkill: new Map([
      ["opentelemetry", { observedExposure: 3, observedUse: 1 }],
      ["code-review", { observedExposure: 0, observedUse: 0 }],
      ["playtest-analysis", { observedExposure: null, observedUse: null }]
    ])
  };
  const markup = renderSkills(
    [REPO_SKILL, USER_SKILL, UNINSTALLED_SKILL],
    telemetry
  );
  assert.match(markup, /data-skill-runtime-observed="true"/);
  // "0 exposed" is an observation; "Not observed" is the absence of one.
  assert.match(markup, /3 exposed · 1 used/);
  assert.match(markup, /0 exposed · 0 used/);
  assert.match(markup, /Not observed/);
  // The cards sum what was observed, and they do not count a skill that was
  // never seen as a skill that was seen and never used.
  assert.match(markup, /Observed Exposure<\/dt>[\s\S]*?>3</u);
  assert.match(markup, /Usage Evidence<\/dt>[\s\S]*?>1</u);
});

test("the runtime telemetry is reported as observed only when it was", () => {
  const markup = renderSkills([REPO_SKILL], {
    observed: false,
    bySkill: new Map([
      ["opentelemetry", { observedExposure: null, observedUse: null }]
    ])
  });
  assert.match(markup, /data-skill-runtime-observed="false"/);
  assert.match(markup, /Observed Exposure<\/dt>[\s\S]*?>Not observed</u);
  assert.match(markup, /Usage Evidence<\/dt>[\s\S]*?>Not observed</u);
});

test("the telemetry mapping keeps a null apart from a zero", () => {
  const telemetry = skillTelemetryFromControlApi({
    schema: "autodev-control-skills-v2",
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
    executionContractRevision: "a".repeat(64),
    assignmentRoles: ["worker"],
    telemetryObserved: true,
    skills: [
      {
        name: "seen-never-used",
        description: "Seen, never used.",
        path: ".rulesync/skills/seen-never-used/SKILL.md",
        roles: ["worker"],
        scope: "user",
        scopeLocation: "/home/operator/.agents/skills/seen-never-used",
        workspace: null,
        observedExposure: 4,
        observedUse: 0
      },
      {
        name: "never-seen",
        description: "Never seen.",
        path: ".rulesync/skills/never-seen/SKILL.md",
        roles: [],
        scope: "user",
        scopeLocation: "/home/operator/.agents/skills/never-seen",
        workspace: null,
        observedExposure: null,
        observedUse: null
      }
    ],
    unresolvedAssignments: [],
    issues: []
  });
  assert.equal(telemetry.observed, true);
  assert.deepEqual(telemetry.bySkill.get("seen-never-used"), {
    observedExposure: 4,
    observedUse: 0
  });
  assert.deepEqual(telemetry.bySkill.get("never-seen"), {
    observedExposure: null,
    observedUse: null
  });
});
