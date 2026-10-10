import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type FormLike,
  type FormSubmissionEvent,
  handleFormSubmission
} from "../src/components/navigation/FormNavigationOwner.ts";
import {
  SkillRoleAssignmentControl
} from "../src/features/skills/SkillRoleAssignmentControl.ts";
import {
  SkillsView,
  type SkillsViewProps
} from "../src/features/skills/SkillsView.ts";

/** Helper to extract all forms and inputs for any skill name without hardcoding fixture names. */
function parseSkillAssignmentForm(markup: string, skillName: string) {
  const actionAttr = `action="/api/skills/${encodeURIComponent(skillName)}"`;
  const actionIndex = markup.indexOf(actionAttr);
  if (actionIndex === -1) {
    return null;
  }
  const formStart = markup.lastIndexOf("<form", actionIndex);
  const formEnd = markup.indexOf("</form>", actionIndex);
  assert.notEqual(formStart, -1, `form for skill ${skillName} missing start`);
  assert.notEqual(formEnd, -1, `form for skill ${skillName} missing end`);
  const formHtml = markup.slice(formStart, formEnd + "</form>".length);

  const inputs: { name: string; value: string; type: string; checked: boolean; submitOnChange: boolean }[] = [];
  for (const match of formHtml.matchAll(/<input\b([^>]*?)\/?>/gu)) {
    const attrs = match[1] ?? "";
    const name = /\sname="([^"]*)"/u.exec(attrs)?.[1] ?? "";
    const value = /\svalue="([^"]*)"/u.exec(attrs)?.[1] ?? "";
    const type = /\stype="([^"]*)"/u.exec(attrs)?.[1] ?? "text";
    const checked = /\schecked(?=[\s/>=]|$)/u.test(attrs);
    const submitOnChange = /\sdata-submit-on-change="true"/u.test(attrs);
    inputs.push({ name, value, type, checked, submitOnChange });
  }

  const hasSubmitButton = /<(?:button|input)\b[^>]*(?:type="submit"|Save)[^>]*>/iu.test(formHtml);
  const hasSubmitOnChange = /\sdata-submit-on-change="true"/u.test(formHtml);

  return {
    formHtml,
    inputs,
    hasSubmitButton,
    hasSubmitOnChange
  };
}

function countOccurrences(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

test("SkillsView combines catalog metadata and role assignments into a single table with no second list", () => {
  const dynamicSkillA = {
    name: "dynamic-skill-alpha",
    description: "Alpha dynamic test skill",
    path: ".rulesync/skills/dynamic-skill-alpha/SKILL.md"
  };
  const dynamicSkillB = {
    name: "dynamic-skill-beta",
    description: "Beta dynamic test skill",
    path: ".rulesync/skills/dynamic-skill-beta/SKILL.md"
  };

  const dynamicRoles = ["custom-role-worker", "custom-role-lead", "custom-role-tester"];
  const revision = "a1b2c3d4".repeat(8);

  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [dynamicSkillA, dynamicSkillB],
      eligibility: [
        { skill: dynamicSkillA.name, roles: ["custom-role-worker"] },
        { skill: dynamicSkillB.name, roles: [] }
      ],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: dynamicRoles,
      executionContractRevision: revision
    })
  );

  // Proves exactly one table is rendered on the page.
  const tableCount = countOccurrences(markup, /<table\b/gu);
  assert.equal(tableCount, 1, "the page must render exactly one table");

  // Proves there is no second assignment list or section.
  assert.equal(markup.includes("Role assignment"), false, "there must not be a separate Role assignment heading or section");
  assert.equal(countOccurrences(markup, /<ul\b/gu), 0, "there must not be a second <ul> assignment list");

  // Proves both skills have assignment controls in their table rows.
  for (const skill of [dynamicSkillA, dynamicSkillB]) {
    const parsed = parseSkillAssignmentForm(markup, skill.name);
    assert.ok(parsed, `skill ${skill.name} must have an in-row assignment form`);
    assert.equal(parsed.hasSubmitButton, false, `skill ${skill.name} form must not have a submit button`);
    assert.equal(parsed.hasSubmitOnChange, true, `skill ${skill.name} form must declare data-submit-on-change`);

    // Proves expectedRevision hidden input is present.
    const revisionInput = parsed.inputs.find((i) => i.name === "expectedRevision");
    assert.ok(revisionInput, "expectedRevision input must be present");
    assert.equal(revisionInput.value, revision);

    // Proves all assignable roles are rendered as options.
    for (const role of dynamicRoles) {
      assert.match(
        markup,
        new RegExp(`data-skill-role-option="${role}"`, "u"),
        `role option ${role} must be rendered`
      );
    }
  }

  // Alpha had worker role checked; Beta had no roles checked.
  const parsedA = parseSkillAssignmentForm(markup, dynamicSkillA.name)!;
  const checkedRolesA = parsedA.inputs.filter((i) => i.name === "roles" && i.checked).map((i) => i.value);
  assert.deepEqual(checkedRolesA, ["custom-role-worker"]);

  const parsedB = parseSkillAssignmentForm(markup, dynamicSkillB.name)!;
  const checkedRolesB = parsedB.inputs.filter((i) => i.name === "roles" && i.checked).map((i) => i.value);
  assert.deepEqual(checkedRolesB, []);
  assert.match(markup, /Unassigned — no agent role can invoke this skill/);
});

test("no Save button exists anywhere in the SkillsView markup", () => {
  const dynamicSkill = {
    name: "autonomous-formatter",
    description: "Format files automatically",
    path: ".rulesync/skills/autonomous-formatter/SKILL.md"
  };
  const roles = ["dev", "reviewer"];
  const revision = "f".repeat(64);

  const markup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [dynamicSkill],
      eligibility: [{ skill: dynamicSkill.name, roles: ["dev"] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: roles,
      executionContractRevision: revision
    })
  );

  assert.doesNotMatch(markup, /<button\b[^>]*>\s*Save\s*<\/button>/iu, "must not contain a Save button");
  assert.doesNotMatch(markup, /type="submit"/u, "must not contain any submit button in the view");
  assert.doesNotMatch(markup, /data-testid="skill-assign-/u, "must not contain obsolete Save button test IDs");
});

test("autosave submit-on-change contract is wired on every role checkbox", () => {
  let submitted = false;
  const fakeForm = {
    requestSubmit: () => {
      submitted = true;
    }
  };

  const element = SkillRoleAssignmentControl({
    skill: {
      name: "linter",
      description: "Code linter",
      path: ".rulesync/skills/linter/SKILL.md"
    },
    roles: ["operator"],
    assignmentRoles: ["operator", "auditor"],
    executionContractRevision: "0".repeat(64)
  });

  const formElement = element.props.children[0];
  assert.equal(formElement.props["data-submit-on-change"], "true");

  interface CheckboxElement {
    props: {
      "data-submit-on-change"?: string;
      onChange?: (event: { currentTarget: { form: typeof fakeForm } }) => void;
    };
  }
  interface LabelElement {
    props: {
      children: [CheckboxElement, unknown];
    };
  }

  const labels = (formElement.props as { children: [unknown, LabelElement[]] })
    .children[1];
  assert.equal(labels.length, 2);

  for (const label of labels) {
    const checkbox = label.props.children[0];
    assert.equal(checkbox.props["data-submit-on-change"], "true");
    assert.equal(typeof checkbox.props.onChange, "function");

    // Invoke onChange to test auto-submit trigger
    submitted = false;
    checkbox.props.onChange?.({ currentTarget: { form: fakeForm } });
    assert.equal(submitted, true, "onChange must call form.requestSubmit()");
  }
});

test("FormNavigationOwner canonical path intercepts skill autosave form POSTs and follows redirects", async () => {
  const skillName = "dynamic-codegen";
  const revision = "12345678".repeat(8);
  const action = `/api/skills/${encodeURIComponent(skillName)}`;

  let fetchUrl = "";
  let fetchBody = "";
  let fetchMethod = "";

  const mockFetch: typeof fetch = async (input, init) => {
    fetchUrl = typeof input === "string" ? input : input.toString();
    fetchMethod = init?.method ?? "GET";
    fetchBody = init?.body?.toString() ?? "";
    return new Response(null, {
      status: 303,
      headers: { location: "/skills" }
    });
  };

  const form: FormLike = {
    method: "POST",
    action,
    elements: [
      { name: "expectedRevision", value: revision, type: "hidden" },
      { name: "roles", value: "executor", type: "checkbox", checked: true },
      { name: "roles", value: "planner", type: "checkbox", checked: true },
      { name: "roles", value: "observer", type: "checkbox", checked: false }
    ]
  };

  let refreshed = false;
  const submitEvent: FormSubmissionEvent = {
    defaultPrevented: false,
    preventDefault: () => {},
    target: form
  };

  const result = await handleFormSubmission(submitEvent, {
    router: {
      push: () => {},
      replace: () => {},
      refresh: () => {
        refreshed = true;
      }
    },
    fetch: mockFetch,
    currentUrl: "http://localhost:3300/skills"
  });

  assert.equal(result.intercepted, true);
  assert.equal(result.method, "POST");
  assert.equal(result.status, "completed");
  assert.equal(refreshed, true, "FormNavigationOwner must refresh in place on successful redirect");
  assert.equal(fetchMethod, "POST");
  assert.equal(fetchUrl, `http://localhost:3300${action}`);

  const submittedParams = new URLSearchParams(fetchBody);
  assert.equal(submittedParams.get("expectedRevision"), revision);
  assert.deepEqual(submittedParams.getAll("roles"), ["executor", "planner"]);
  assert.equal(submittedParams.getAll("roles").includes("observer"), false);
});

test("clearing all checkboxes unassigns the skill and submits empty roles set", async () => {
  const skillName = "clearable-skill";
  const revision = "99999999".repeat(8);
  const action = `/api/skills/${encodeURIComponent(skillName)}`;

  let fetchBody = "";
  const mockFetch: typeof fetch = async (_input, init) => {
    fetchBody = init?.body?.toString() ?? "";
    return new Response(null, {
      status: 303,
      headers: { location: "/skills" }
    });
  };

  const unassignForm: FormLike = {
    method: "POST",
    action,
    elements: [
      { name: "expectedRevision", value: revision, type: "hidden" },
      { name: "roles", value: "role-a", type: "checkbox", checked: false },
      { name: "roles", value: "role-b", type: "checkbox", checked: false }
    ]
  };

  const submitEvent: FormSubmissionEvent = {
    defaultPrevented: false,
    preventDefault: () => {},
    target: unassignForm
  };

  const result = await handleFormSubmission(submitEvent, {
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
    fetch: mockFetch,
    currentUrl: "http://localhost:3300/skills"
  });

  assert.equal(result.intercepted, true);
  assert.equal(result.status, "completed");
  const params = new URLSearchParams(fetchBody);
  assert.equal(params.get("expectedRevision"), revision);
  assert.deepEqual(params.getAll("roles"), [], "unassigning must post zero roles");
});

test("expectedRevision conflict protection and visible failure feedback", () => {
  const props: SkillsViewProps = {
    skills: [
      {
        name: "conflict-prone-skill",
        description: "Skill with revision conflict",
        path: ".rulesync/skills/conflict-prone-skill/SKILL.md"
      }
    ],
    eligibility: [{ skill: "conflict-prone-skill", roles: ["worker"] }],
    unresolvedAssignments: [],
    sourceValidity: true,
    validationIssues: [],
    assignmentRoles: ["worker"],
    executionContractRevision: "c".repeat(64),
    saveOutcome: "conflict"
  };

  const markup = renderToStaticMarkup(React.createElement(SkillsView, props));
  assert.match(markup, /data-testid="skill-assignment-failure"/);
  assert.match(markup, /data-save-outcome="conflict"/);
  assert.match(markup, /The execution contract changed after this page was loaded/);

  // Also verify validation, not-found, and failed outcomes render visible notices
  const validationMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, { ...props, saveOutcome: "validation" })
  );
  assert.match(validationMarkup, /data-save-outcome="validation"/);
  assert.match(validationMarkup, /The execution contract refused that assignment/);

  const notFoundMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, { ...props, saveOutcome: "not-found" })
  );
  assert.match(notFoundMarkup, /data-save-outcome="not-found"/);
  assert.match(notFoundMarkup, /That skill is not in the RuleSync catalog any more/);

  const failedMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, { ...props, saveOutcome: "failed" })
  );
  assert.match(failedMarkup, /data-save-outcome="failed"/);
  assert.match(failedMarkup, /The role assignment was not applied/);
});

test("distinguishes unavailable sources and renders appropriate reasons without broken mutation forms", () => {
  const baseSkill = {
    name: "inspectable-skill",
    description: "Inspectable description",
    path: ".rulesync/skills/inspectable-skill/SKILL.md"
  };

  // 1. Missing execution contract revision
  const noContractMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [baseSkill],
      eligibility: [{ skill: baseSkill.name, roles: ["tester"] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["tester"],
      executionContractRevision: null
    })
  );
  assert.doesNotMatch(noContractMarkup, /action="\/api\/skills\//, "no form when contract is missing");
  assert.match(noContractMarkup, /No execution contract was found/);
  assert.match(noContractMarkup, /data-skill-assignment-revision="none"/);

  // 2. Empty declared assignment roles
  const noRolesMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [baseSkill],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: [],
      executionContractRevision: "e".repeat(64)
    })
  );
  assert.doesNotMatch(noRolesMarkup, /action="\/api\/skills\//, "no form when contract has no roles");
  assert.match(noRolesMarkup, /The execution contract declares no roles/);

  // 3. Invalid RuleSync catalog
  const invalidCatalogMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: false,
      validationIssues: [
        {
          location: ".rulesync/skills/broken/SKILL.md",
          message: "Frontmatter corrupted"
        }
      ],
      assignmentRoles: ["tester"],
      executionContractRevision: "e".repeat(64)
    })
  );
  assert.doesNotMatch(invalidCatalogMarkup, /action="\/api\/skills\//);
  assert.match(invalidCatalogMarkup, /The RuleSync skill catalog is invalid/);
  assert.match(invalidCatalogMarkup, /RuleSync `\.rulesync\/skills\/` is invalid/);

  // 4. Unobserved RuleSync catalog
  const unobservedMarkup = renderToStaticMarkup(
    React.createElement(SkillsView, {
      skills: [],
      eligibility: [],
      unresolvedAssignments: [],
      sourceValidity: null,
      validationIssues: [],
      assignmentRoles: ["tester"],
      executionContractRevision: "e".repeat(64)
    })
  );
  assert.doesNotMatch(unobservedMarkup, /action="\/api\/skills\//);
  assert.match(unobservedMarkup, /RuleSync `\.rulesync\/skills\/` has not been observed/);
});
