import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_SKILL_CONTENT_SCHEMA_ID,
  CONTROL_API_SKILLS_SCHEMA_ID,
  controlApiSkillContentResponseSchema,
  controlApiSkillsResponseSchema
} from "../src/control-api/skills.ts";

const VALID_REVISION = "a".repeat(64);
const VALID_RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: VALID_REVISION,
    observedGeneration: VALID_REVISION,
    lastApplyAt: "2026-11-27T08:00:00Z",
    lastObservationAt: "2026-11-27T08:00:01Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

function skillsResponse(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: CONTROL_API_SKILLS_SCHEMA_ID,
    source: ".rulesync/skills+execution-contract",
    readOnly: true,
    valid: true,
    issues: [],
    executionContractObserved: true,
    executionContractRevision: VALID_REVISION,
    assignmentRoles: ["coder", "reviewer"],
    telemetryObserved: true,
    skills: [
      {
        name: "dry",
        description: "Reduce duplication.",
        path: ".rulesync/skills/dry/SKILL.md",
        roles: ["reviewer"],
        scope: "repo",
        scopeLocation: "/repo/.agents/skills/dry",
        workspace: "autodev",
        observedExposure: 3,
        observedUse: 1,
        observedError: 0
      }
    ],
    unresolvedAssignments: [],
    ...overrides
  };
}

test("skills contract accepts canonical read-only responses and refuses writable or malformed ones", () => {
  assert.equal(controlApiSkillsResponseSchema.safeParse(skillsResponse()).success, true);
  assert.equal(
    controlApiSkillsResponseSchema.safeParse(
      skillsResponse({ executionContractRevision: null, unresolvedAssignments: null })
    ).success,
    true
  );
  assert.equal(
    controlApiSkillsResponseSchema.safeParse(skillsResponse({ readOnly: false }))
      .success,
    false
  );
  assert.equal(
    controlApiSkillsResponseSchema.safeParse(
      skillsResponse({ executionContractRevision: "not-a-sha" })
    ).success,
    false
  );
  assert.equal(
    controlApiSkillsResponseSchema.safeParse({
      ...skillsResponse(),
      issues: [{ location: "dry" }]
    }).success,
    false
  );
});

test("skill content contract validates sha256 revision and shared reconciliation view", () => {
  const valid = {
    schema: CONTROL_API_SKILL_CONTENT_SCHEMA_ID,
    name: "dry",
    path: ".rulesync/skills/dry/SKILL.md",
    content: "# DRY",
    revision: VALID_REVISION,
    reconciliation: VALID_RECONCILIATION
  };
  assert.equal(controlApiSkillContentResponseSchema.safeParse(valid).success, true);
  assert.equal(
    controlApiSkillContentResponseSchema.safeParse({
      ...valid,
      revision: "A".repeat(64)
    }).success,
    false
  );
});
