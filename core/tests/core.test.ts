import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_NAVIGATION,
  isCanonicalNavSection,
  isSkillEligibleForRole,
  navOrderOf,
  validateAgentDefinition
} from "../src/index.ts";

test("CANONICAL_NAVIGATION contains exact 11 sections in order", () => {
  const expected = [
    "Agents",
    "MCPs",
    "Skills",
    "Hooks",
    "Memory",
    "Evaluations",
    "Permissions",
    "Tools",
    "Usage",
    "Prompts",
    "Workspaces"
  ] as const;
  assert.deepEqual(CANONICAL_NAVIGATION, expected);
  assert.equal(CANONICAL_NAVIGATION.length, 11);

  for (const [index, element] of expected.entries()) {
    const section = element!;
    assert.equal(isCanonicalNavSection(section), true);
    assert.equal(navOrderOf(section), index);
  }
  assert.equal(isCanonicalNavSection("Projects"), false);
  assert.equal(isCanonicalNavSection("Organizations"), false);
});

test("validateAgentDefinition validates required fields", () => {
  const invalid = validateAgentDefinition({});
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 2);

  const valid = validateAgentDefinition({
    id: "orchestrator",
    role: "orchestrator",
    kind: "orchestrator"
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});

test("isSkillEligibleForRole checks role list accurately", () => {
  const list = [
    { skill: "orchestration", roles: ["orchestrator", "worker"] },
    { skill: "debug", roles: ["smart"] }
  ];
  assert.equal(
    isSkillEligibleForRole("orchestration", "orchestrator", list),
    true
  );
  assert.equal(
    isSkillEligibleForRole("orchestration", "explorer", list),
    false
  );
  assert.equal(isSkillEligibleForRole("unknown", "orchestrator", list), false);
});
