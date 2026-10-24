import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterSkills,
  readSkillsFilters,
  skillsListHref
} from "../src/features/skills/skills-list-url.ts";
import { SkillsView } from "../src/features/skills/SkillsView.ts";

/**
 * The skill catalogue can be narrowed, and the narrowing survives the
 * round-trip a role assignment makes.
 *
 * Sixteen entries in the live instance, each row carrying a role-assignment
 * control, so the table runs to about three screenfuls. The question the page
 * is about -- which skills may role X invoke -- had no answer on it: the
 * operator had to read the Eligible Roles column of every row, sixty-four
 * role chips spread down three screenfuls, to find out.
 *
 * The narrowing is by role rather than by name, because the catalogue is
 * sorted by name and sixteen short names in one column are a cheap scan,
 * while the role question is the expensive one.
 *
 * And it is by role rather than a text search for a second reason: every
 * control on this page applies the moment it changes, so the page must not
 * carry a submit button, and a text search has nowhere to put its Apply.
 * A role is a bounded set, so the control that chooses one is a single-choice
 * select -- which is what the shared filter bar's on-change mode is for.
 */

const CATALOG = [
  {
    name: "code-review",
    description: "Review a diff and report what would break.",
    path: ".rulesync/skills/code-review/SKILL.md"
  },
  {
    name: "release-notes",
    description: "Write release notes from a commit range.",
    path: ".rulesync/skills/release-notes/SKILL.md"
  },
  {
    name: "browser-check",
    description: "Open a page and report what it shows.",
    path: ".rulesync/skills/browser-check/SKILL.md"
  }
];

const ROLES: Record<string, readonly string[]> = {
  "code-review": ["worker"],
  "release-notes": ["worker", "reviewer"],
  "browser-check": []
};

const ROLES_BY_SKILL = new Map(Object.entries(ROLES));

function renderSkills(
  role?: string,
  skills: readonly (typeof CATALOG)[number][] = CATALOG
): string {
  return renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills,
      eligibility: skills.map((skill) => ({
        skill: skill.name,
        roles: ROLES[skill.name] ?? []
      })),
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["worker", "reviewer"],
      executionContractRevision: "a".repeat(64),
      ...(role === undefined ? {} : { role })
    })
  );
}

test("a role keeps the skills assigned to it", () => {
  const worker = filterSkills(
    CATALOG,
    { role: "worker" },
    ROLES_BY_SKILL
  );
  assert.deepEqual(
    worker.map((skill) => skill.name),
    ["code-review", "release-notes"]
  );

  const reviewer = filterSkills(
    CATALOG,
    { role: "reviewer" },
    ROLES_BY_SKILL
  );
  assert.deepEqual(
    reviewer.map((skill) => skill.name),
    ["release-notes"]
  );

  // A skill assigned to nobody is not invocable by a role, so it is not in
  // the role's list. It stays in the unfiltered catalogue, where the operator
  // can see it and fix it.
  assert.equal(
    filterSkills(CATALOG, { role: "worker" }, ROLES_BY_SKILL).some(
      (skill) => skill.name === "browser-check"
    ),
    false
  );
});

test("an empty role is the whole catalogue", () => {
  assert.equal(filterSkills(CATALOG, { role: "" }, ROLES_BY_SKILL).length, 3);
  assert.equal(filterSkills(CATALOG, { role: "   " }, ROLES_BY_SKILL).length, 3);
});

test("the list's address carries the role, and reads it back", () => {
  assert.equal(skillsListHref({ role: "" }), "/skills");
  assert.equal(skillsListHref({ role: "worker" }), "/skills?role=worker");

  assert.deepEqual(readSkillsFilters({ role: "worker" }), { role: "worker" });
  assert.deepEqual(readSkillsFilters({}), { role: "" });
  // A repeated parameter takes its first value, which is what the browser's
  // own form submission produces.
  assert.deepEqual(readSkillsFilters({ role: ["first", "second"] }), {
    role: "first"
  });
});

test("the list offers the Console's own filter bar, and no submit button", () => {
  const markup = renderSkills();

  // A named landmark, not an anonymous form.
  assert.match(markup, /<form[^>]*aria-label="Skill filters"/u);
  assert.match(markup, /data-submit-mode="on-change"/u);
  // The single choice that drives it.
  assert.match(markup, /<select[^>]*name="role"/u);
  assert.match(markup, /data-submit-on-change="true"/u);

  // No submit button: every control on this page applies the moment it
  // changes, and a "Save" button beside them would be a second way to do
  // the same thing -- one an operator could walk past believing the change
  // had not been written.
  assert.doesNotMatch(markup, /type="submit"/u);

  // An unfiltered list has one number, so it has no summary to give: the
  // catalogue's size is already in the stat row above it.
  assert.doesNotMatch(markup, /Showing 3 of 3 skills/u);
});

test("a narrowed list says how much of the catalogue is in view", () => {
  const markup = renderSkills("worker");

  assert.match(markup, /Showing 2 of 3 skills/u);
  // And the narrowed catalogue is what the table holds.
  assert.match(markup, /code-review/u);
  assert.match(markup, /release-notes/u);
  assert.doesNotMatch(markup, /browser-check/u);

  // The stat row above is about the catalogue, not about the view of it: the
  // "Configured" card counts every skill the source defines, and that number
  // must not shrink because the operator narrowed the list.
  assert.match(markup, /Configured<\/dt>[\s\S]*?>3</u);
});

test("an empty narrowed list says the role excluded everything", () => {
  const markup = renderSkills("nobody-has-this-role");

  assert.match(markup, /No skills found matching the current criteria\./u);
  // Not "no skills configured": the catalogue holds them, and the role is
  // what removed them from view.
  assert.doesNotMatch(markup, /No skills configured in RuleSync/u);
});

test("an empty catalogue still says the catalogue is empty", () => {
  const markup = renderSkills(undefined, []);

  assert.match(markup, /No skills configured in RuleSync/u);
});

test("a role assignment carries the list's address on its action", () => {
  const markup = renderSkills("worker");

  // The narrowing travels on the form's action, so the redirect back from the
  // POST returns the operator to the rows they narrowed. It is not a body
  // field: the body carries the desired role set and nothing else, and a
  // third field there would be one the route has to be told to ignore.
  assert.match(markup, /action="\/api\/skills\/code-review\?role=worker"/u);
  assert.doesNotMatch(markup, /name="returnTo"/u);
});

test("an unfiltered list's assignment posts nothing extra", () => {
  const markup = renderSkills();

  // The address is only carried when there is a narrowing to carry.
  assert.match(markup, /action="\/api\/skills\/code-review"/u);
});

test("the narrowing is carried as a query, never as a path", () => {
  // A value that tries to be a path is still a query: the route rebuilds the
  // address from the value, so there is nothing in the flow that could point
  // anywhere but the skill list.
  const href = skillsListHref({ role: "/../tools" });
  assert.ok(href.startsWith("/skills?"), `unexpected address: ${href}`);
  assert.equal(href.includes("/../tools"), false);
  // And it reads back as the same value it went in as.
  const round = new URL(href, "http://skills.invalid").searchParams.get("role");
  assert.deepEqual(readSkillsFilters({ role: round ?? "" }), {
    role: "/../tools"
  });
});
