import assert from "node:assert/strict";
import test from "node:test";

import type { ScopedSkillDefinition } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsView } from "../src/features/agents/AgentsView.ts";
import { SkillsView } from "../src/features/skills/SkillsView.ts";

/**
 * The execution contract's read decides what the agents and skills pages may
 * claim.
 *
 * Both catalogues draw role assignments from the contract, and the accessor
 * that reads the contract falls back to an empty contract when the read fails.
 * An empty contract and a contract nobody read look the same to a caller that
 * only sees the roles -- and they are not the same claim. The first says the
 * contract declares no role; the second says nobody read it.
 *
 * So the Runtime publishes whether the contract was read, the Console refuses a
 * payload that does not, and the pages say which read did not happen instead of
 * counting an empty catalogue.
 */

const SKILL: ScopedSkillDefinition = {
  name: "code-review",
  description: "Review a diff and report what would break.",
  path: ".rulesync/skills/code-review/SKILL.md",
  scope: "repo",
  scopeLocation: "/repo/.agents/skills/code-review",
  workspace: "SimulatorLife/AutoDev"
};

function renderAgents(executionContractObserved: boolean): string {
  return renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [],
      executionContractObserved
    })
  );
}

function renderSkills(executionContractObserved: boolean): string {
  return renderToStaticMarkup(
    React.createElement(SkillsView, {
      executionContractObserved,
      skills: [SKILL],
      eligibility: [{ skill: SKILL.name, roles: ["worker"] }],
      unresolvedAssignments: [],
      sourceValidity: true,
      validationIssues: [],
      assignmentRoles: ["worker"],
      executionContractRevision: "a".repeat(64),
      telemetry: { observed: false, bySkill: new Map() }
    })
  );
}

test("an agent list over a read contract says the catalogue is empty", () => {
  const markup = renderAgents(true);

  assert.match(markup, /No agents are configured\./u);
});

test("an agent list over an unread contract says the catalogue is not known", () => {
  const markup = renderAgents(false);

  // Not "No agents are configured.": nobody read the contract, so the list is
  // not known to be empty.
  assert.match(
    markup,
    /The execution contract was not read, so the agent catalogue is not known\./u
  );
  assert.doesNotMatch(markup, /No agents are configured\./u);
});

test("the role-assigned card counts the assignments only over a read contract", () => {
  const observed = renderSkills(true);
  assert.match(observed, /Role-assigned<\/dt>[\s\S]*?>1</u);

  // The catalogue was read, and the contract was not, so the eligibility the
  // card counts is not known: the roles an assignment would reach came from
  // the read that failed.
  const unread = renderSkills(false);
  assert.match(unread, /Role-assigned<\/dt>[\s\S]*?>Not observed</u);
  assert.doesNotMatch(unread, /Role-assigned<\/dt>[\s\S]*?>1</u);
});
