import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PROMPT_DETAIL_SCHEMA_ID,
  CONTROL_API_PROMPT_VERSION_SCHEMA_ID,
  CONTROL_API_PROMPT_VERSIONS_SCHEMA_ID,
  CONTROL_API_PROMPTS_SCHEMA_ID,
  controlApiPromptDetailResponseSchema,
  controlApiPromptsResponseSchema,
  controlApiPromptVersionResponseSchema,
  controlApiPromptVersionsResponseSchema
} from "../src/control-api/prompts.ts";

const REVISION = "b".repeat(64);
const GIT_SHA = "c".repeat(40);
const RECONCILIATION = {
  status: {
    convergence: "converged",
    desiredGeneration: REVISION,
    observedGeneration: REVISION,
    lastApplyAt: "2026-11-27T08:00:00Z",
    lastObservationAt: "2026-11-27T08:00:01Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
};

test("prompts catalog schema requires readOnly: true and separates null vs observed counts", () => {
  const valid = {
    schema: CONTROL_API_PROMPTS_SCHEMA_ID,
    source: ".rulesync/commands",
    readOnly: true,
    valid: true,
    issues: [],
    totalCommands: 1,
    commands: [{ name: "dry", path: ".rulesync/commands/dry.md" }],
    rolePrompts: [{ role: "coder", path: "agents/prompts/roles/coder.md" }]
  };
  assert.equal(controlApiPromptsResponseSchema.safeParse(valid).success, true);
  assert.equal(
    controlApiPromptsResponseSchema.safeParse({
      ...valid,
      totalCommands: null,
      rolePrompts: null
    }).success,
    true
  );
  assert.equal(
    controlApiPromptsResponseSchema.safeParse({ ...valid, readOnly: false })
      .success,
    false
  );
  assert.equal(
    controlApiPromptsResponseSchema.safeParse({ ...valid, totalCommands: -1 })
      .success,
    false
  );
});

test("prompt detail, version list, and version content schemas enforce hashes and pagination", () => {
  assert.equal(
    controlApiPromptDetailResponseSchema.safeParse({
      schema: CONTROL_API_PROMPT_DETAIL_SCHEMA_ID,
      name: "dry",
      type: "command",
      source: ".rulesync/commands/dry.md",
      content: "# dry",
      preview: "# dry",
      revision: REVISION,
      diff: { summary: "Updated dry", identifier: "diff-1" },
      reconciliation: RECONCILIATION
    }).success,
    true
  );
  assert.equal(
    controlApiPromptVersionsResponseSchema.safeParse({
      schema: CONTROL_API_PROMPT_VERSIONS_SCHEMA_ID,
      name: "dry",
      status: "available",
      versions: [{ versionHash: GIT_SHA, updatedAt: "2026-11-27T08:00:00Z" }],
      hasMore: false,
      offset: 0,
      limit: 20
    }).success,
    true
  );
  assert.equal(
    controlApiPromptVersionsResponseSchema.safeParse({
      schema: CONTROL_API_PROMPT_VERSIONS_SCHEMA_ID,
      name: "dry",
      status: "unavailable",
      versions: [{ versionHash: GIT_SHA, updatedAt: "2026-11-27T08:00:00Z" }],
      hasMore: false,
      offset: 0,
      limit: 20
    }).success,
    false
  );
  assert.equal(
    controlApiPromptVersionResponseSchema.safeParse({
      schema: CONTROL_API_PROMPT_VERSION_SCHEMA_ID,
      name: "dry",
      versionHash: GIT_SHA,
      updatedAt: "2026-11-27T08:00:00Z",
      content: "# dry",
      diff: ""
    }).success,
    true
  );
});
